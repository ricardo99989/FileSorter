'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { listDir, statPath, assertPath, isHiddenName } = require('../src/main/fsops');

async function makeFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'filelens-'));
  await fs.writeFile(path.join(dir, 'photo.jpg'), Buffer.alloc(2048));
  await fs.writeFile(path.join(dir, 'notes.md'), Buffer.from('# 标题\n', 'utf8'));
  await fs.writeFile(path.join(dir, '.hidden'), 'x');
  await fs.writeFile(path.join(dir, 'desktop.ini'), 'x');
  await fs.mkdir(path.join(dir, '子目录'));
  return dir;
}

test('列举目录：返回文件与文件夹，附带说明', async () => {
  const dir = await makeFixture();
  const listing = await listDir(dir, { refresh: true });

  assert.strictEqual(listing.dir, path.normalize(dir));
  const names = listing.entries.map((entry) => entry.name);
  assert.ok(names.includes('photo.jpg'));
  assert.ok(names.includes('子目录'));

  const photo = listing.entries.find((entry) => entry.name === 'photo.jpg');
  assert.strictEqual(photo.isDir, false);
  assert.strictEqual(photo.size, 2048);
  assert.strictEqual(photo.ext, 'jpg');
  assert.strictEqual(photo.desc.label, 'JPEG 图片');
  assert.ok(photo.desc.brief.length > 8);

  const folder = listing.entries.find((entry) => entry.name === '子目录');
  assert.strictEqual(folder.isDir, true);
  assert.strictEqual(folder.desc.category, 'folder');
});

test('默认隐藏点开头文件与系统文件，开关可显示', async () => {
  const dir = await makeFixture();
  const hidden = await listDir(dir, { refresh: true });
  const names = hidden.entries.map((entry) => entry.name);
  assert.ok(!names.includes('.hidden'));
  assert.ok(!names.includes('desktop.ini'));

  const shown = await listDir(dir, { showHidden: true, refresh: true });
  const all = shown.entries.map((entry) => entry.name);
  assert.ok(all.includes('.hidden'));
  assert.ok(all.includes('desktop.ini'));
});

test('统计口径与条目数一致', async () => {
  const dir = await makeFixture();
  const listing = await listDir(dir, { refresh: true });
  const files = listing.entries.filter((entry) => !entry.isDir);
  assert.strictEqual(listing.counts.files, files.length);
  assert.strictEqual(listing.counts.dirs, listing.entries.length - files.length);
  assert.strictEqual(
    listing.counts.size,
    files.reduce((sum, entry) => sum + entry.size, 0),
  );
  assert.strictEqual(listing.parent, path.dirname(path.normalize(dir)));
});

test('缓存命中：同一目录连续读取内容一致', async () => {
  const dir = await makeFixture();
  const first = await listDir(dir, { refresh: true });
  const second = await listDir(dir);
  assert.strictEqual(second.entries.length, first.entries.length);
  assert.strictEqual(second.counts.size, first.counts.size);
});

test('非法路径被拒绝，不会把相对路径带到文件系统', () => {
  assert.throws(() => assertPath('relative/path'), /绝对路径/);
  assert.throws(() => assertPath(''), /缺少/);
  assert.throws(() => assertPath(null), /缺少/);
  assert.throws(() => assertPath('C:\\a\0b'), /非法字符/);
  assert.strictEqual(assertPath('C:\\temp\\'), path.normalize('C:\\temp\\'));
});

test('不存在的目录会抛错，而不是返回空列表', async () => {
  await assert.rejects(() => listDir('C:\\__not_exist_dir__\\nope', { refresh: true }), /ENOENT/);
});

test('statPath 能识别文件类型并给出扩展名', async () => {
  const dir = await makeFixture();
  const info = await statPath(path.join(dir, 'notes.md'));
  assert.strictEqual(info.isDir, false);
  assert.strictEqual(info.ext, 'md');
  assert.ok(info.mtime > 0);
});

test('隐藏文件判定规则', () => {
  assert.strictEqual(isHiddenName('.gitignore'), true);
  assert.strictEqual(isHiddenName('Thumbs.db'), true);
  assert.strictEqual(isHiddenName('normal.txt'), false);
});
