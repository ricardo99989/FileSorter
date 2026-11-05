'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classify,
  extOf,
  resolveCategories,
  sanitizeFolderName,
  isHidden,
  isTempName,
} = require('../src/main/classifier');

test('extOf 处理常规、多段后缀与无后缀', () => {
  assert.equal(extOf('a.JPG'), 'jpg');
  assert.equal(extOf('archive.tar.gz'), 'gz');
  assert.equal(extOf('README'), '');
  assert.equal(extOf('.gitignore'), '');
  assert.equal(extOf('end.'), '');
});

test('classify 覆盖需求里点名的扩展名', () => {
  const cases = {
    'p.jpg': 'image',
    'p.png': 'image',
    'p.gif': 'image',
    'p.webp': 'image',
    'v.mp4': 'video',
    'v.mkv': 'video',
    'v.avi': 'video',
    'd.pdf': 'document',
    'd.docx': 'document',
    'd.txt': 'document',
    'd.md': 'document',
    'a.mp3': 'audio',
    'a.flac': 'audio',
    'a.wav': 'audio',
    'z.zip': 'archive',
    'z.rar': 'archive',
    'z.7z': 'archive',
    'e.exe': 'program',
    'e.msi': 'program',
    'c.py': 'code',
    'c.js': 'code',
    'c.cpp': 'code',
    'unknown.xyz': 'other',
    noext: 'other',
  };
  for (const [name, id] of Object.entries(cases)) {
    assert.equal(classify(name).id, id, `${name} 应归入 ${id}`);
  }
});

test('classify 大小写不敏感', () => {
  assert.equal(classify('PHOTO.JPEG').id, 'image');
  assert.equal(classify('Song.FLAC').id, 'audio');
});

test('resolveCategories 应用自定义名称但保留默认名', () => {
  const list = resolveCategories({ image: '  照片  ', video: '' });
  const image = list.find((c) => c.id === 'image');
  const video = list.find((c) => c.id === 'video');
  assert.equal(image.name, '照片');
  assert.equal(image.defaultName, '图片');
  assert.equal(video.name, '视频', '空字符串应回退默认名');
  assert.equal(list.length, 8);
});

test('sanitizeFolderName 过滤非法字符与保留字', () => {
  assert.equal(sanitizeFolderName('图:片?*', '图片'), '图片');
  assert.equal(sanitizeFolderName('照片.', '图片'), '照片');
  assert.equal(sanitizeFolderName('   ', '图片'), '图片');
  assert.equal(sanitizeFolderName('CON', '其他'), 'CON_');
  assert.equal(sanitizeFolderName('a/b\\c', '其他'), 'abc');
  assert.ok(sanitizeFolderName('长'.repeat(200), '其他').length <= 60);
});

test('隐藏文件与临时文件判定', () => {
  assert.equal(isHidden('.gitignore'), true);
  assert.equal(isHidden('a.txt'), false);
  assert.equal(isTempName('a.part'), true);
  assert.equal(isTempName('a.crdownload'), true);
  assert.equal(isTempName('~$报表.docx'), true);
  assert.equal(isTempName('normal.docx'), false);
});
