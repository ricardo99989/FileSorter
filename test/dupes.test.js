'use strict';

/**
 * 重复文件检测测试。
 *
 * 这个功能的成本在磁盘 I/O 上：三阶段设计的全部意义就是「尽量少读」。
 * 所以测试除了验证「该找到的找到、不该找到的别误报」，还要验证
 * 「明显不同体积的文件根本不会进入哈希阶段」——这是性能承诺的一部分。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { findDuplicates, quickHash } = require('../src/main/dupes');

const KB = 1024;

async function makeDir(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'filesorter-dupes-'));
  for (const [name, { content, mtime }] of Object.entries(files)) {
    const full = path.join(dir, name);
    await fs.writeFile(full, content);
    if (mtime) await fs.utimes(full, mtime, mtime);
  }
  return dir;
}

/** 造一段可控的重复内容：pad 到指定体积 */
function blob(seed, size) {
  const unit = String(seed);
  return unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
}

test('内容完全相同的两个文件会被检出，并统计可释放空间', async () => {
  const dir = await makeDir({
    'a.txt': { content: blob('hello', 4 * KB) },
    'b.txt': { content: blob('hello', 4 * KB) },
  });

  const result = await findDuplicates(dir, { minSize: 1 });
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].count, 2);
  assert.equal(result.groups[0].size, 4 * KB);
  assert.equal(result.groups[0].wasted, 4 * KB);
  assert.equal(result.totalWasted, 4 * KB);
});

test('体积相同但内容不同不会被误判为重复', async () => {
  const dir = await makeDir({
    'a.txt': { content: blob('aaaa', 4 * KB) },
    'b.txt': { content: blob('bbbb', 4 * KB) },
  });

  const result = await findDuplicates(dir, { minSize: 1 });
  assert.equal(result.groups.length, 0);
});

test('首尾相同但中段不同也必须被全量哈希拦下来', async () => {
  // 构造两个首尾各 4KB 一致、中间不一致的文件：
  // 快哈希会认为它们相同，只有全量 SHA-256 才能发现差异。
  const head = blob('H', 4096);
  const tail = blob('T', 4096);
  const dir = await makeDir({
    'a.bin': { content: head + blob('A', 2000) + tail },
    'b.bin': { content: head + blob('B', 2000) + tail },
  });

  const result = await findDuplicates(dir, { minSize: 1 });
  assert.equal(result.groups.length, 0, '首尾快哈希必须由全量哈希兜底');
});

test('体积不同的文件完全不进入哈希阶段', async () => {
  const dir = await makeDir({
    'small.txt': { content: blob('x', 2 * KB) },
    'large.txt': { content: blob('x', 9 * KB) },
  });

  const result = await findDuplicates(dir, { minSize: 1 });
  assert.equal(result.groups.length, 0);
  assert.equal(result.hashed, 0, '体积不同不该产生任何哈希计算');
});

test('低于 minSize 的文件被跳过，避免把小文件也读一遍', async () => {
  const dir = await makeDir({
    'tiny1.txt': { content: 'abc' },
    'tiny2.txt': { content: 'abc' },
  });

  const result = await findDuplicates(dir, { minSize: KB });
  assert.equal(result.groups.length, 0);
});

test('三个重复文件合成一组，可释放空间按 n-1 计算', async () => {
  const dir = await makeDir({
    'a.txt': { content: blob('same', 3 * KB) },
    'b.txt': { content: blob('same', 3 * KB) },
    'c.txt': { content: blob('same', 3 * KB) },
  });

  const result = await findDuplicates(dir, { minSize: 1 });
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].count, 3);
  assert.equal(result.groups[0].wasted, 6 * KB);
});

test('组内按修改时间升序，最老的排第一（界面默认建议保留它）', async () => {
  const old = new Date('2024-01-01T00:00:00Z');
  const recent = new Date('2026-01-01T00:00:00Z');
  const dir = await makeDir({
    'new.txt': { content: blob('dup', 2 * KB), mtime: recent },
    'old.txt': { content: blob('dup', 2 * KB), mtime: old },
  });

  const result = await findDuplicates(dir, { minSize: 1 });
  assert.equal(result.groups[0].items[0].name, 'old.txt');
});

test('快哈希对体积敏感：同内容不同体积必然不同值', async () => {
  const dir = await makeDir({
    'a.bin': { content: blob('q', 5 * KB) },
    'b.bin': { content: blob('q', 6 * KB) },
  });
  const a = await quickHash(path.join(dir, 'a.bin'), 5 * KB);
  const b = await quickHash(path.join(dir, 'b.bin'), 6 * KB);
  assert.notEqual(a, b);
});

test('空目录返回空结果而不是抛错', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'filesorter-empty-'));
  const result = await findDuplicates(dir, { minSize: 1 });
  assert.deepEqual(result.groups, []);
  assert.equal(result.totalWasted, 0);
});
