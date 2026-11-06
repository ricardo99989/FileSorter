'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createClipboardHistory } = require('../src/main/clipboard');

function fakeClipboard(initial = '') {
  return {
    value: initial,
    readText() {
      return this.value;
    },
    writeText(text) {
      this.value = text;
    },
  };
}

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'fs-clip-'));
}

test('去重、置顶、限长：连续复制不刷屏，重提旧文本不重复', async () => {
  const dir = await tmpDir();
  const board = fakeClipboard();
  const clip = createClipboardHistory({ clipboard: board, userData: dir });
  await clip.start();
  try {
    clip._add('第一条');
    clip._add('第一条');
    assert.equal(clip.list().count, 1, '连续相同内容被记了两次');

    clip._add('第二条');
    clip._add('第一条');
    assert.equal(clip.list().count, 2);
    assert.equal(clip.list().items[0].text, '第一条', '旧文本没有提到最前');

    for (let i = 0; i < 60; i += 1) clip._add(`批量 ${i}`);
    assert.equal(clip.list().count, 40, '没有按上限裁剪');
    assert.equal(clip.list().items[0].text, '批量 59');
  } finally {
    clip.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('忽略空白与超长文本', async () => {
  const dir = await tmpDir();
  const clip = createClipboardHistory({ clipboard: fakeClipboard(), userData: dir });
  await clip.start();
  try {
    clip._add('   ');
    clip._add('x'.repeat(4001));
    assert.equal(clip.list().count, 0);
    clip._add('  可用内容  ');
    assert.equal(clip.list().items[0].text, '可用内容');
  } finally {
    clip.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('点历史写回剪贴板不会被当成新复制', async () => {
  const dir = await tmpDir();
  const board = fakeClipboard();
  const clip = createClipboardHistory({ clipboard: board, userData: dir });
  await clip.start();
  try {
    clip._add('A');
    clip._add('B');
    const id = clip.list().items[1].id;
    assert.equal(clip.copy(id), true);
    assert.equal(board.value, 'A');
    clip._tick(); // 轮询读到自己刚写回的内容
    assert.equal(clip.list().count, 2, '写回操作污染了历史');
  } finally {
    clip.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('关停后不再记录，重新开启会跳过停机期间的剪贴板', async () => {
  const dir = await tmpDir();
  const board = fakeClipboard();
  const clip = createClipboardHistory({ clipboard: board, userData: dir });
  await clip.start();
  try {
    clip.setEnabled(false);
    board.writeText('停机期间复制的内容');
    clip._tick();
    assert.equal(clip.list().count, 0);

    clip.setEnabled(true);
    board.writeText('新的内容');
    clip._tick();
    assert.equal(clip.list().count, 1);
    assert.equal(clip.list().items[0].text, '新的内容');
  } finally {
    clip.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('清空 / 删除 / 重启后从本地文件恢复', async () => {
  const dir = await tmpDir();
  const board = fakeClipboard();
  const first = createClipboardHistory({ clipboard: board, userData: dir });
  await first.start();
  first._add('保留一');
  first._add('保留二');
  first.remove(first.list().items[0].id);
  assert.equal(first.list().count, 1);
  first.stop();
  // stop 的写盘是异步的，等文件落稳再重新加载
  const target = path.join(dir, 'clipboard-history.json');
  for (let i = 0; i < 40; i += 1) {
    try {
      await fs.access(target);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const second = createClipboardHistory({ clipboard: board, userData: dir });
  await second.start();
  try {
    assert.equal(second.list().count, 1);
    assert.equal(second.list().items[0].text, '保留一');
    second.clear();
    assert.equal(second.list().count, 0);
  } finally {
    second.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
