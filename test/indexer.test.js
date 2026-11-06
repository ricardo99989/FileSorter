'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const indexer = require('../src/main/indexer');

/** 拼音是分批后台补的，最多等 5 秒 */
async function waitPinyin(timeout = 5000) {
  const started = Date.now();
  while (!indexer._state.pyDone && Date.now() - started < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(indexer._state.pyDone, true, '拼音索引没有补完');
}

test('中文文件名支持全拼、首字母与原文搜索', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-index-'));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-data-'));
  try {
    await fs.writeFile(path.join(root, '报表2026.md'), 'x');
    await fs.writeFile(path.join(root, '季度总结.txt'), 'x');
    await fs.writeFile(path.join(root, 'sample_0001.pdf'), 'x');

    await indexer.build(data, { roots: [root], useCache: false });
    await waitPinyin();

    const byInitials = indexer.search('bb', { limit: 20 }); // 报表 → baobiao → bb
    assert.ok(byInitials.results.some((r) => r.name === '报表2026.md'));

    const byFull = indexer.search('baobiao', { limit: 20 });
    assert.ok(byFull.results.some((r) => r.name === '报表2026.md'));

    const byName = indexer.search('报表', { limit: 20 });
    assert.ok(byName.results.some((r) => r.name === '报表2026.md'));

    assert.ok(byName.took < 100, `搜索耗时 ${byName.took}ms 超过 100ms`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(data, { recursive: true, force: true });
  }
});

test('拼音补完后回写缓存，缓存里带 py 标记与拼音字段', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-index-'));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-data-'));
  try {
    await fs.writeFile(path.join(root, '会议记录.md'), 'x');
    await indexer.build(data, { roots: [root], useCache: false });
    await waitPinyin();
    // 拼音补完后有 600ms 的合并写盘窗口
    await new Promise((resolve) => setTimeout(resolve, 900));

    const buf = await fs.readFile(path.join(data, 'search-index.json.gz'));
    const cache = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
    assert.equal(cache.py, true, '缓存没有标记拼音已完成');
    const withPinyin = cache.entries.find((row) => row[0] === '会议记录.md');
    assert.ok(withPinyin, '缓存里找不到中文条目');
    assert.ok(withPinyin[4].startsWith('huiyi'), `全拼异常: ${withPinyin[4]}`);
    assert.equal(withPinyin[5], 'hyjl');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(data, { recursive: true, force: true });
  }
});

test('多关键词允许拼音词与目录词混用', () => {
  const state = indexer._state;
  const backup = {
    dirs: state.dirs,
    entries: state.entries,
    dirIndex: state.dirIndex,
  };
  try {
    state.dirs = ['D:\\工作\\2026'];
    state.dirIndex = new Map([['d:\\工作\\2026', 0]]);
    state.entries = [
      { n: '季度报告.pdf', l: '季度报告.pdf', d: 0, s: 2048, t: Math.round(Date.now() / 1000), p: 'jidubaogao', i: 'jdbg' },
      { n: 'notes.txt', l: 'notes.txt', d: 0, s: 100, t: 0 },
    ];
    const hit = indexer.search('jdbg 2026', { limit: 10 });
    assert.equal(hit.total, 1);
    assert.equal(hit.results[0].name, '季度报告.pdf');

    const miss = indexer.search('jdbg 不存在', { limit: 10 });
    assert.equal(miss.total, 0);
  } finally {
    Object.assign(state, backup);
  }
});

test('宽查询不会只保留前半张表的高分结果', () => {
  const state = indexer._state;
  const backup = { dirs: state.dirs, entries: state.entries, dirIndex: state.dirIndex };
  try {
    state.dirs = ['C:\\a', 'D:\\z'];
    state.dirIndex = new Map([['c:\\a', 0], ['d:\\z', 1]]);
    const entries = [];
    for (let i = 0; i < 9000; i += 1) {
      // 前 8000 条是低分的"包含"命中，最后一条是名字完全相等（1000 分）
      const name = i === 8999 ? 'e' : `e_file_${i}.txt`;
      entries.push({ n: name, l: name, d: i === 8999 ? 1 : 0, s: 1, t: 0 });
    }
    state.entries = entries;
    const hit = indexer.search('e', { limit: 5 });
    assert.equal(hit.results[0].name, 'e', '末尾的精确匹配被裁剪掉了');
  } finally {
    Object.assign(state, backup);
  }
});
