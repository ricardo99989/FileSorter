'use strict';

/**
 * 标签系统测试。
 *
 * 标签的价值在「跨文件夹检索」，所以两个行为最要紧：
 * 1. 文件被整理或撤销后，标签必须跟着走，而不是挂在一个已经不存在的路径上；
 * 2. Windows 路径大小写不敏感，同一文件不能因为大小写差异存成两条记录。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createTags, TAG_COLORS } = require('../src/main/tags');

async function sandbox() {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'filesorter-tags-'));
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'filesorter-work-'));
  const tags = createTags(data);
  await tags.load();
  return { tags, work, data };
}

test('创建标签并给文件打上，order 内可查', async () => {
  const { tags, work } = await sandbox();
  const tag = await tags.createTag('重要', 'rose');
  const file = path.join(work, 'report.pdf');

  await tags.addTags([file], [tag.id]);
  const hit = tags.tagsOf(file);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].name, '重要');
});

test('标签颜色限定在预设色板内，乱传会落回默认值', async () => {
  const { tags } = await sandbox();
  const ok = await tags.createTag('正常', 'violet');
  assert.ok(TAG_COLORS.includes(ok.color));

  const fallback = await tags.createTag('乱传', 'rainbow');
  assert.ok(TAG_COLORS.includes(fallback.color));
});

test('空名字的标签被拒绝，不会产生一个看不见的标签', async () => {
  const { tags } = await sandbox();
  await assert.rejects(() => tags.createTag('   ', 'blue'));
});

test('同一个文件重复打同一个标签不会产生重复记录', async () => {
  const { tags, work } = await sandbox();
  const tag = await tags.createTag('待看', 'amber');
  const file = path.join(work, 'a.txt');

  await tags.addTags([file], [tag.id]);
  await tags.addTags([file], [tag.id]);

  assert.equal(tags.tagsOf(file).length, 1);
});

test('Windows 路径大小写不敏感：同一文件只存一条', async () => {
  const { tags, work } = await sandbox();
  const tag = await tags.createTag('项目', 'teal');
  const upper = path.join(work, 'File.TXT');
  const lower = path.join(work, 'file.txt');

  await tags.addTags([upper], [tag.id]);
  assert.equal(tags.tagsOf(lower).length, 1, '大小写不同不该被当成两个文件');
});

test('删除标签会把它从所有文件上摘掉', async () => {
  const { tags, work } = await sandbox();
  const tag = await tags.createTag('临时', 'slate');
  const file = path.join(work, 'x.txt');
  await tags.addTags([file], [tag.id]);

  await tags.deleteTag(tag.id);
  assert.equal(tags.tagsOf(file).length, 0);
});

test('按标签检索只返回带该标签的文件', async () => {
  const { tags, work } = await sandbox();
  const red = await tags.createTag('红标', 'rose');
  const blue = await tags.createTag('蓝标', 'blue');

  const a = path.join(work, 'a.txt');
  const b = path.join(work, 'b.txt');
  await fs.writeFile(a, 'a');
  await fs.writeFile(b, 'b');
  await tags.addTags([a], [red.id]);
  await tags.addTags([b], [blue.id]);

  const result = await tags.search(work, [red.id]);
  assert.equal(result.length, 1);
  assert.equal(path.basename(result[0].path), 'a.txt');
});

test('多标签检索默认是 AND：必须同时具备全部标签', async () => {
  const { tags, work } = await sandbox();
  const t1 = await tags.createTag('甲', 'rose');
  const t2 = await tags.createTag('乙', 'blue');

  const both = path.join(work, 'both.txt');
  const onlyOne = path.join(work, 'one.txt');
  await fs.writeFile(both, 'x');
  await fs.writeFile(onlyOne, 'y');
  await tags.addTags([both], [t1.id, t2.id]);
  await tags.addTags([onlyOne], [t1.id]);

  const andResult = await tags.search(work, [t1.id, t2.id]);
  assert.equal(andResult.length, 1);
  assert.equal(path.basename(andResult[0].path), 'both.txt');

  const orResult = await tags.search(work, [t1.id, t2.id], { matchAll: false });
  assert.equal(orResult.length, 2);
});

test('检索时顺手清掉指向已删除文件的标签记录', async () => {
  const { tags, work } = await sandbox();
  const tag = await tags.createTag('失效', 'slate');
  const gone = path.join(work, 'gone.txt');
  const alive = path.join(work, 'alive.txt');
  await fs.writeFile(gone, 'x');
  await fs.writeFile(alive, 'y');
  await tags.addTags([gone, alive], [tag.id]);

  await fs.unlink(gone);

  const result = await tags.search(work, [tag.id]);
  assert.equal(result.length, 1);
  assert.equal(path.basename(result[0].path), 'alive.txt');
});

test('文件移动后标签跟着走，旧路径不再持有标签', async () => {
  const { tags, work } = await sandbox();
  const tag = await tags.createTag('归档', 'sage');

  const before = path.join(work, 'raw', 'photo.jpg');
  const after = path.join(work, '图片', 'photo.jpg');
  await tags.addTags([before], [tag.id]);

  await tags.remapPath(before, after);

  assert.equal(tags.tagsOf(before).length, 0, '旧路径应被清空');
  assert.equal(tags.tagsOf(after).length, 1, '新路径应继承标签');
});

test('数据落盘后重新加载仍在（重启不丢标签）', async () => {
  const { tags, work, data } = await sandbox();
  const tag = await tags.createTag('持久', 'violet');
  const file = path.join(work, 'p.txt');
  await tags.addTags([file], [tag.id]);

  const again = createTags(data);
  await again.load();

  assert.equal(again.list().length, 1);
  assert.equal(again.tagsOf(file).length, 1);
});

test('tagsOfMany 一次返回多个文件的标签，避免逐条查询', async () => {
  const { tags, work } = await sandbox();
  const tag = await tags.createTag('批量', 'amber');
  const a = path.join(work, 'a.txt');
  const b = path.join(work, 'b.txt');
  await tags.addTags([a, b], [tag.id]);

  const map = tags.tagsOfMany([a, b]);
  assert.equal(Object.keys(map).length, 2);
  for (const key of Object.keys(map)) {
    assert.equal(map[key].length, 1);
  }
});
