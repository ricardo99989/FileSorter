'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { search, scoreSimilar, prefixOf } = require('../src/main/search');
const { buildStats } = require('../src/main/scanner');
const { resolveCategories } = require('../src/main/classifier');

test('prefixOf 提取主干前缀词', () => {
  assert.equal(prefixOf('banner_final_v2.jpg'), 'banner');
  assert.equal(prefixOf('banner2.png'), 'banner');
  assert.equal(prefixOf('score.docx'), 'score');
  assert.equal(prefixOf('a.jpg'), 'a');
});

test('scoreSimilar 同前缀权重高于同类型', () => {
  const base = { name: 'banner_final.jpg', size: 100, mtime: 1e12, path: 'C:/a/banner_final.jpg' };
  const samePrefix = { name: 'banner_old.png', size: 100, mtime: 1e12, path: 'C:/a/banner_old.png' };
  const sameExtOnly = { name: 'photo.jpg', size: 100, mtime: 1e12, path: 'C:/a/photo.jpg' };
  assert.ok(scoreSimilar(base, samePrefix) > scoreSimilar(base, sameExtOnly));
  assert.equal(scoreSimilar(base, base), -1, '自身不参与推荐');
});

test('搜索命中文件名并给出相似推荐', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'filesorter-search-'));
  const files = ['banner_final.jpg', 'banner_old.jpg', 'banner_draft.png', 'cat.jpg', 'report.pdf', 'BANNER_大写.gif'];
  for (const name of files) {
    await fs.writeFile(path.join(dir, name), 'x'.repeat(10));
  }

  const result = await search(dir, 'banner');
  assert.ok(result.hits.length >= 3);
  assert.ok(result.similar.length > 0, '应给出相似文件');
  assert.ok(result.similar.every((f) => !result.hits.some((h) => h.path === f.path)));
  assert.ok(result.similar.length <= 5);
  await fs.rm(dir, { recursive: true, force: true });
});

test('多关键词是 AND 语义，大小写不敏感', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'filesorter-search-'));
  for (const name of ['Final Report.pdf', 'final draft.txt', 'other.pdf']) {
    await fs.writeFile(path.join(dir, name), 'x');
  }
  const both = await search(dir, 'final report');
  assert.equal(both.hits.length, 1);
  assert.equal(both.hits[0].name, 'Final Report.pdf');
  await fs.rm(dir, { recursive: true, force: true });
});

test('搜索包含子目录中的文件', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'filesorter-search-'));
  await fs.mkdir(path.join(dir, '图片'), { recursive: true });
  await fs.writeFile(path.join(dir, '图片', 'deep_target.png'), 'x');
  const result = await search(dir, 'deep_target');
  assert.equal(result.hits.length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test('统计区分待归类与已归档', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'filesorter-stats-'));
  await fs.writeFile(path.join(dir, 'a.jpg'), 'x');
  await fs.writeFile(path.join(dir, 'b.pdf'), 'yy');
  await fs.mkdir(path.join(dir, '图片'), { recursive: true });
  await fs.writeFile(path.join(dir, '图片', 'c.png'), 'zzz');

  const stats = await buildStats(dir, { skipHidden: true }, resolveCategories({}));
  assert.equal(stats.total, 3);
  assert.equal(stats.pending, 2);
  assert.equal(stats.organized, 1);
  assert.equal(stats.byCategory.find((c) => c.id === 'image').count, 2);
  assert.equal(stats.size, 6);
  await fs.rm(dir, { recursive: true, force: true });
});

test('空关键词不返回结果但也不抛错', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'filesorter-search-'));
  await fs.writeFile(path.join(dir, 'a.jpg'), 'x');
  const result = await search(dir, '   ');
  assert.equal(result.hits.length, 0);
  assert.equal(result.similar.length, 0);
  await fs.rm(dir, { recursive: true, force: true });
});
