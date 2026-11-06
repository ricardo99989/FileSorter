'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { buildPlan, executePlan } = require('../src/main/organizer');
const { createUndo } = require('../src/main/undo');

/** 建一个干净的临时目录，塞入测试文件 */
async function makeSandbox(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'filesorter-'));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content);
  }
  return dir;
}

const settings = { customNames: {}, skipHidden: true };

test('预览只读：不产生任何移动，也不创建文件夹', async () => {
  const dir = await makeSandbox({ 'a.jpg': 'x', 'b.pdf': 'y', 'c.mp3': 'z' });
  const plan = await buildPlan(dir, settings);

  assert.equal(plan.items.length, 3);
  assert.deepEqual(
    plan.items.map((i) => i.folder).sort(),
    ['图片', '文档', '音频'],
  );
  const after = await fs.readdir(dir);
  assert.equal(after.length, 3, '预览后目录不应多出文件夹');
  await fs.rm(dir, { recursive: true, force: true });
});

test('执行后文件进入分类目录，非目标目录文件保持原样', async () => {
  const dir = await makeSandbox({ 'a.jpg': 'x', 'b.pdf': 'y', 'README': 'z', '.hidden.jpg': 'h', 'dl.part': 'p' });
  const plan = await buildPlan(dir, settings);

  assert.equal(plan.items.length, 3);
  assert.deepEqual(
    plan.skipped.map((s) => s.name).sort(),
    ['.hidden.jpg', 'dl.part'],
  );

  const result = await executePlan(dir, settings, {});
  assert.equal(result.moved.length, 3);
  assert.equal(result.failed.length, 0);

  assert.ok(await fs.stat(path.join(dir, '图片', 'a.jpg')));
  assert.ok(await fs.stat(path.join(dir, '文档', 'b.pdf')));
  assert.ok(await fs.stat(path.join(dir, '其他', 'README')));
  assert.ok(await fs.stat(path.join(dir, '.hidden.jpg')), '隐藏文件应留在原地');
  await fs.rm(dir, { recursive: true, force: true });
});

test('重名自动加序号，两次整理都不会覆盖已有文件', async () => {
  const dir = await makeSandbox({ 'a.jpg': 'first' });
  await executePlan(dir, settings, {});
  assert.equal(await fs.readFile(path.join(dir, '图片', 'a.jpg'), 'utf8'), 'first');

  await fs.writeFile(path.join(dir, 'a.jpg'), 'second');
  await executePlan(dir, settings, {});
  assert.equal(await fs.readFile(path.join(dir, '图片', 'a.jpg'), 'utf8'), 'first');
  assert.equal(await fs.readFile(path.join(dir, '图片', 'a(1).jpg'), 'utf8'), 'second');
  await fs.rm(dir, { recursive: true, force: true });
});

test('自定义文件夹名生效，分类规则不变', async () => {
  const dir = await makeSandbox({ 'a.jpg': 'x' });
  const custom = { customNames: { image: '照片' }, skipHidden: true };
  await executePlan(dir, custom, {});
  assert.ok(await fs.stat(path.join(dir, '照片', 'a.jpg')));
  await fs.rm(dir, { recursive: true, force: true });
});

test('selectedNames 只移动勾选项', async () => {
  const dir = await makeSandbox({ 'a.jpg': 'x', 'b.png': 'y' });
  const result = await executePlan(dir, settings, { selectedNames: ['a.jpg'] });
  assert.equal(result.moved.length, 1);
  assert.ok(await fs.stat(path.join(dir, '图片', 'a.jpg')));
  assert.ok(await fs.stat(path.join(dir, 'b.png')), '未勾选的留在原地');
  await fs.rm(dir, { recursive: true, force: true });
});

test('selectedNames 不能穿透目录', async () => {
  const dir = await makeSandbox({ 'a.jpg': 'x' });
  const result = await executePlan(dir, settings, { selectedNames: ['../evil.jpg', '../../windows/win.ini'] });
  assert.equal(result.moved.length, 0, '带路径分隔符的名字必须被忽略');
  await fs.rm(dir, { recursive: true, force: true });
});

test('撤销把文件还原回原位', async () => {
  const dir = await makeSandbox({ 'a.jpg': 'x', 'b.pdf': 'y' });
  const undo = createUndo(path.join(dir, '.undo-store'));

  const result = await executePlan(dir, settings, { undo });
  assert.equal(result.moved.length, 2);

  const back = await undo.undoLast();
  assert.equal(back.restored, 2);
  assert.ok(await fs.stat(path.join(dir, 'a.jpg')));
  assert.ok(await fs.stat(path.join(dir, 'b.pdf')));

  const again = await undo.undoLast();
  assert.equal(again.restored, 0, '同一份日志不应被回滚两次');
  await fs.rm(dir, { recursive: true, force: true });
});

test('空目录不产生计划也不报错', async () => {
  const dir = await makeSandbox({});
  const plan = await buildPlan(dir, settings);
  assert.equal(plan.items.length, 0);
  assert.equal(plan.summary.moveCount, 0);
  const result = await executePlan(dir, settings, {});
  assert.equal(result.total, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test('学习模式：文件名命中课程关键词时归到「学习」', async () => {
  const dir = await makeSandbox({
    '高数笔记.md': 'x',
    '期末复习提纲.txt': 'y',
    'a.jpg': 'z',
  });
  const plan = await buildPlan(dir, { ...settings, learnMode: true });
  const folderOf = Object.fromEntries(plan.items.map((item) => [item.name, item.folder]));

  assert.equal(folderOf['高数笔记.md'], '学习');
  assert.equal(folderOf['期末复习提纲.txt'], '学习');
  // 没命中的仍然按扩展名走
  assert.equal(folderOf['a.jpg'], '图片');
});

test('学习模式关闭时不受影响', async () => {
  const dir = await makeSandbox({ '高数笔记.md': 'x' });
  const plan = await buildPlan(dir, { ...settings, learnMode: false });
  assert.equal(plan.items[0].folder, '文档');
});

test('学习模式不越过自定义规则', async () => {
  const dir = await makeSandbox({ '高数笔记.md': 'x' });
  const plan = await buildPlan(dir, {
    ...settings,
    learnMode: true,
    customRules: [
      {
        id: 'keep',
        name: '笔记单独放',
        enabled: true,
        target: '我的笔记',
        conditions: [{ field: 'name', op: 'contains', value: '笔记' }],
      },
    ],
  });
  assert.equal(plan.items[0].folder, '我的笔记');
});
