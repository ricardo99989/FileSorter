'use strict';

/**
 * 多步撤销 / 重做测试。
 *
 * 用户原话是「没有这个用户不敢用」，所以这里不只测「撤销一次」，
 * 重点测三件容易出错的事：
 * 1. 多批操作的撤销顺序必须是「后进先出」，否则目录会乱；
 * 2. 撤销 → 重做 → 再撤销必须稳定循环，不能一次就失效；
 * 3. 撤销到一半失败时，已成功的部分不能回滚成更糟的状态。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createUndo } = require('../src/main/undo');

/** 建一个临时工作区，返回 { root, sub, undo } */
async function sandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'filesorter-undo-'));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'filesorter-data-'));
  return { root, sub: async (name) => {
    const dir = path.join(root, name);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }, undo: createUndo(data) };
}

async function exists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

test('撤销一批移动：文件回到原位置，目标目录被清空', async () => {
  const { root, sub, undo } = await sandbox();
  const src = await sub('src');
  const dst = await sub('dst');

  const from = path.join(src, 'a.jpg');
  const to = path.join(dst, 'a.jpg');
  await fs.writeFile(from, 'x');

  const log = await undo.startLog(src, { action: 'organize' });
  await fs.rename(from, to);
  await undo.record(log, from, to);

  const result = await undo.undoLast();
  assert.equal(result.restored, 1);
  assert.equal(await exists(from), true);
  assert.equal(await exists(to), false);
  assert.ok(root);
});

test('多步撤销：连撤两批，两批都回到原位', async () => {
  const { sub, undo } = await sandbox();
  const src = await sub('src');
  const dst = await sub('dst');

  // 第一批
  const a1 = path.join(src, 'a1.txt');
  const b1 = path.join(dst, 'a1.txt');
  await fs.writeFile(a1, '1');
  const log1 = await undo.startLog(src);
  await fs.rename(a1, b1);
  await undo.record(log1, a1, b1);

  // 第二批
  const a2 = path.join(src, 'a2.txt');
  const b2 = path.join(dst, 'a2.txt');
  await fs.writeFile(a2, '2');
  const log2 = await undo.startLog(src);
  await fs.rename(a2, b2);
  await undo.record(log2, a2, b2);

  const result = await undo.undoLast(2);
  assert.equal(result.restored, 2);
  assert.equal(await exists(a1), true);
  assert.equal(await exists(a2), true);
  assert.equal(await exists(b1), false);
  assert.equal(await exists(b2), false);
});

test('撤销一次不影响更早的批次', async () => {
  const { sub, undo } = await sandbox();
  const src = await sub('src');
  const dst = await sub('dst');

  const first = path.join(src, 'first.txt');
  const firstTo = path.join(dst, 'first.txt');
  await fs.writeFile(first, '1');
  const log1 = await undo.startLog(src);
  await fs.rename(first, firstTo);
  await undo.record(log1, first, firstTo);

  const second = path.join(src, 'second.txt');
  const secondTo = path.join(dst, 'second.txt');
  await fs.writeFile(second, '2');
  const log2 = await undo.startLog(src);
  await fs.rename(second, secondTo);
  await undo.record(log2, second, secondTo);

  await undo.undoLast(1);

  // 只撤了第二批：第二批回来了，第一批还在目标目录里
  assert.equal(await exists(second), true);
  assert.equal(await exists(first), false);
  assert.equal(await exists(firstTo), true);
});

test('撤销后可以重做，重做后还能再撤销', async () => {
  const { sub, undo } = await sandbox();
  const src = await sub('src');
  const dst = await sub('dst');

  const from = path.join(src, 'x.mp4');
  const to = path.join(dst, 'x.mp4');
  await fs.writeFile(from, 'x');

  const log = await undo.startLog(src);
  await fs.rename(from, to);
  await undo.record(log, from, to);

  await undo.undoLast();
  assert.equal(await exists(from), true);

  const redone = await undo.redoLast();
  assert.equal(redone.restored, 1);
  assert.equal(await exists(to), true);
  assert.equal(await exists(from), false);

  // 再撤一次仍然有效，说明后缀状态机没有卡死
  const again = await undo.undoLast();
  assert.equal(again.restored, 1);
  assert.equal(await exists(from), true);
});

test('没有可撤销的操作时返回 0 而不是抛错', async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'filesorter-empty-'));
  const undo = createUndo(data);
  const result = await undo.undoLast();
  assert.equal(result.restored, 0);
  assert.ok(Array.isArray(result.failed));
});

test('日志里的半行记录被忽略，不会让整批撤销失败', async () => {
  const { sub, undo } = await sandbox();
  const src = await sub('src');
  const dst = await sub('dst');

  const from = path.join(src, 'ok.txt');
  const to = path.join(dst, 'ok.txt');
  await fs.writeFile(from, 'x');

  const log = await undo.startLog(src);
  await fs.rename(from, to);
  await undo.record(log, from, to);

  // 模拟进程在写日志的瞬间被杀：追加一段没有换行的残缺 JSON
  await fs.appendFile(log, '{"t":"move","from":"C:\\\\tmp\\\\a","to":', 'utf8');

  const result = await undo.undoLast();
  assert.equal(result.restored, 1);
  assert.equal(await exists(from), true);
});

test('源文件已被别人占用（目标位置已有同名文件）时，如实报告失败而不是静默丢弃', async () => {
  const { sub, undo } = await sandbox();
  const src = await sub('src');
  const dst = await sub('dst');

  const from = path.join(src, 'clash.txt');
  const to = path.join(dst, 'clash.txt');
  await fs.writeFile(from, 'x');

  const log = await undo.startLog(src);
  await fs.rename(from, to);
  await undo.record(log, from, to);

  // 撤销之前，用户又在原位置建了一个同名文件
  await fs.writeFile(from, 'occupied');

  const result = await undo.undoLast();
  assert.equal(result.restored, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(await exists(to), true, '冲突时不能把目标文件弄丢');
});

test('历史列表能列出批次、条数与动作类型', async () => {
  const { sub, undo } = await sandbox();
  const src = await sub('src');
  const dst = await sub('dst');

  const from = path.join(src, 'one.txt');
  const to = path.join(dst, 'one.txt');
  await fs.writeFile(from, 'x');
  const log = await undo.startLog(src, { action: 'organize' });
  await fs.rename(from, to);
  await undo.record(log, from, to);

  const list = await undo.listBatches(10);
  assert.ok(list.length >= 1);
  assert.equal(list[0].count, 1);
  assert.equal(list[0].action, 'organize');
  assert.equal(list[0].undone, false);
});

test('清空历史之后不能再撤销', async () => {
  const { sub, undo } = await sandbox();
  const src = await sub('src');
  const dst = await sub('dst');

  const from = path.join(src, 'z.txt');
  const to = path.join(dst, 'z.txt');
  await fs.writeFile(from, 'x');
  const log = await undo.startLog(src);
  await fs.rename(from, to);
  await undo.record(log, from, to);

  await undo.clearHistory();
  const result = await undo.undoLast();
  assert.equal(result.restored, 0);
});

test('撤销后把本次腾空的分类文件夹一并收掉，不留空壳', async () => {
  const { root, undo } = await sandbox();
  const categoryDir = path.join(root, '图片'); // 整理时新建的分类目录

  const from = path.join(root, 'a.jpg');
  const to = path.join(categoryDir, 'a.jpg');
  await fs.mkdir(categoryDir, { recursive: true });
  await fs.writeFile(from, 'x');

  const log = await undo.startLog(root);
  await fs.rename(from, to);
  await undo.record(log, from, to);

  await undo.undoLast();

  assert.equal(await exists(from), true);
  assert.equal(await exists(categoryDir), false, '空的分类目录应当被清掉');
});

test('分类目录里还有别的文件时不能被删掉', async () => {
  const { root, undo } = await sandbox();
  const categoryDir = path.join(root, '图片');
  const keep = path.join(categoryDir, '用户自己放的文件.jpg');
  await fs.mkdir(categoryDir, { recursive: true });
  await fs.writeFile(keep, 'keep');

  const from = path.join(root, 'a.jpg');
  const to = path.join(categoryDir, 'a.jpg');
  await fs.writeFile(from, 'x');

  const log = await undo.startLog(root);
  await fs.rename(from, to);
  await undo.record(log, from, to);

  await undo.undoLast();

  assert.equal(await exists(from), true);
  assert.equal(await exists(categoryDir), true, '非空目录必须保留');
  assert.equal(await exists(keep), true, '别人的文件一个都不能动');
});
