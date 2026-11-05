'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { summarize, detailOf, TYPES, CATEGORIES } = require('../src/main/describe');

const file = (name, size = 1024, extra = {}) => ({
  name,
  ext: name.includes('.') ? name.split('.').pop().toLowerCase() : '',
  size,
  isDir: false,
  mtime: Date.now() - 5 * 86400000,
  ...extra,
});

test('常见扩展名给出面向普通人的类型名', () => {
  assert.strictEqual(summarize(file('a.psd')).label, 'Photoshop 源文件');
  assert.strictEqual(summarize(file('b.exe')).label, 'Windows 程序');
  assert.strictEqual(summarize(file('c.xlsx')).label, 'Excel 工作簿');
  assert.strictEqual(summarize(file('d.mp4')).label, 'MP4 视频');
});

test('一句话说明不堆术语，且提到用途', () => {
  const psd = summarize(file('海报.psd'));
  assert.strictEqual(psd.category, 'design');
  assert.ok(psd.brief.includes('图层'), `实际文案：${psd.brief}`);

  const exe = summarize(file('setup.exe'));
  assert.ok(/安装|启动/.test(exe.brief), `实际文案：${exe.brief}`);
});

test('文件名语境优先于通用说明', () => {
  const lock = summarize(file('~$会议纪要.docx', 162));
  assert.ok(lock.brief.includes('临时'), `实际文案：${lock.brief}`);

  const shot = summarize(file('截图_2026-11-05.png', 900000));
  assert.ok(shot.brief.includes('截图'), `实际文案：${shot.brief}`);

  const wx = summarize(file('微信图片_20261105.jpg', 300000));
  assert.ok(wx.brief.includes('微信'), `实际文案：${wx.brief}`);
});

test('零字节文件会被点出来', () => {
  const empty = summarize(file('broken.pdf', 0));
  assert.ok(empty.brief.includes('空文件'), `实际文案：${empty.brief}`);
});

test('未知扩展名有兜底文案，不会返回空字符串', () => {
  for (const name of ['data.xyz', 'file.qqqqq', 'noextension']) {
    const result = summarize(file(name));
    assert.ok(result.label.length > 0);
    assert.ok(result.brief.length > 8, `${name} 的说明过短：${result.brief}`);
    assert.strictEqual(result.category, 'other');
  }
});

test('文件夹有独立分类', () => {
  const dir = summarize({ name: '素材', isDir: true, size: 0, ext: '' });
  assert.strictEqual(dir.category, 'folder');
  assert.ok(dir.brief.includes('文件夹'));
});

test('详情包含完整解释与提示，且不重复首句', () => {
  const temp = detailOf(file('~$报价单.xlsx', 200));
  assert.ok(temp.hints.length >= 1);
  // detail 一定不会比首句更短；有补充说明的类型会明显更长
  assert.ok(temp.detail.length >= temp.brief.length);
  assert.ok(temp.size.endsWith('B'));

  const pdf = detailOf(file('合同.pdf', 400000));
  assert.ok(pdf.detail.length > pdf.brief.length, 'PDF 应带补充说明');
  assert.ok(pdf.detail.startsWith(pdf.brief), 'detail 应以首句开头，详情页据此剥掉重复');
});

test('知识库自身完整：每个扩展名都有标签、说明与合法分类', () => {
  const validCategories = new Set(Object.keys(CATEGORIES));
  for (const [ext, info] of Object.entries(TYPES)) {
    assert.ok(info.label && info.label.length > 1, `${ext} 缺 label`);
    assert.ok(info.brief && info.brief.length > 8, `${ext} 缺 brief`);
    assert.ok(validCategories.has(info.cat), `${ext} 分类非法：${info.cat}`);
    assert.strictEqual(ext, ext.toLowerCase(), `${ext} 不是小写`);
  }
});

test('知识库覆盖主流办公与创作格式', () => {
  const must = ['pdf', 'docx', 'xlsx', 'pptx', 'jpg', 'png', 'mp4', 'mp3', 'zip', 'exe', 'psd', 'py', 'json', 'ttf', 'fbx'];
  for (const ext of must) assert.ok(TYPES[ext], `缺少 ${ext} 的说明`);
});
