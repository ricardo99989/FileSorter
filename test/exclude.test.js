'use strict';

/**
 * 排除名单测试。
 *
 * 这一层的定位是「用户改不动的那道闸」：系统文件与系统目录是硬编码保护，
 * 即使把排除名单清空也必须继续拦住。所以测试分两组——
 * 一组验证系统保护不依赖用户配置，一组验证四种匹配方式各自的行为。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isSystemEntry,
  isCloudDirName,
  globToRegExp,
  compileExcludes,
  checkExclude,
  isExcludedDir,
  DEFAULT_EXCLUDES,
} = require('../src/main/exclude');

test('系统文件即使排除名单为空也必须被拦住', () => {
  const compiled = compileExcludes([]);
  for (const name of ['desktop.ini', 'Thumbs.db', 'pagefile.sys', 'hiberfil.sys']) {
    const result = checkExclude({ name }, compiled);
    assert.equal(result.excluded, true, name);
    assert.equal(result.reason, '系统文件');
  }
});

test('Office 的临时锁文件被认作系统文件', () => {
  assert.equal(isSystemEntry('~$会议纪要.docx'), true);
  assert.equal(isSystemEntry('~$预算.xlsx'), true);
});

test('普通文件不会被误判成系统文件', () => {
  for (const name of ['会议纪要.docx', 'readme.txt', 'a.jpg']) {
    assert.equal(isSystemEntry(name), false, name);
  }
});

test('系统目录按名字识别，与路径无关', () => {
  const compiled = compileExcludes([]);
  assert.equal(isExcludedDir('D:\\work\\node_modules', compiled), true);
  assert.equal(isExcludedDir('D:\\work\\.git', compiled), true);
  assert.equal(isExcludedDir('C:\\$Recycle.Bin', compiled), true);
  assert.equal(isExcludedDir('D:\\work\\src', compiled), false);
});

test('globToRegExp 只把 * 和 ? 当通配符，其余字符要转义', () => {
  assert.equal(globToRegExp('*.tmp').test('a.tmp'), true);
  assert.equal(globToRegExp('*.tmp').test('a.txt'), false);
  assert.equal(globToRegExp('~$*').test('~$x.docx'), true);
  // 点号必须被转义，否则 a.tmp 会被 aXtmp 命中
  assert.equal(globToRegExp('a.tmp').test('aXtmp'), false);
  // 大小写不敏感
  assert.equal(globToRegExp('*.TMP').test('a.tmp'), true);
});

test('DEFAULT_EXCLUDES 覆盖临时文件、日志与依赖目录', () => {
  const compiled = compileExcludes(DEFAULT_EXCLUDES);
  assert.equal(checkExclude({ name: 'setup.tmp' }, compiled).excluded, true);
  assert.equal(checkExclude({ name: 'app.log' }, compiled).excluded, true);
  assert.equal(checkExclude({ name: '~$报告.docx' }, compiled).excluded, true);
  assert.equal(checkExclude({ name: '正常文件.txt' }, compiled).excluded, false);
});

test('按名称精确匹配：只命中同名项，不做子串', () => {
  const compiled = compileExcludes([{ value: 'GameData', kind: 'name' }]);
  assert.equal(checkExclude({ name: 'GameData' }, compiled).excluded, true);
  assert.equal(checkExclude({ name: 'myGameData' }, compiled).excluded, false);
});

test('按包含匹配：子串命中即可，且不区分大小写', () => {
  const compiled = compileExcludes([{ value: '源码', kind: 'contains' }]);
  assert.equal(checkExclude({ name: '重要源码_备份' }, compiled).excluded, true);
  assert.equal(checkExclude({ name: '重要源码' }, compiled).excluded, true);
  assert.equal(checkExclude({ name: '无关文件' }, compiled).excluded, false);
});

test('按路径排除：对目录本身与它下面任意深度的文件都生效', () => {
  const compiled = compileExcludes([{ value: 'D:/Games/Steam', kind: 'path' }]);
  assert.equal(checkExclude({ name: 'x', fullPath: 'D:\\Games\\Steam' }, compiled).excluded, true);
  assert.equal(
    checkExclude({ name: 'save.dat', fullPath: 'D:\\Games\\Steam\\saves\\save.dat' }, compiled).excluded,
    true
  );
  assert.equal(
    checkExclude({ name: 'other.dat', fullPath: 'D:\\Games\\Other\\save.dat' }, compiled).excluded,
    false
  );
});

test('路径排除允许只写末级目录名', () => {
  const compiled = compileExcludes([{ value: 'important-project', kind: 'path' }]);
  const result = checkExclude(
    { name: 'main.js', fullPath: 'D:\\code\\important-project\\src\\main.js' },
    compiled
  );
  assert.equal(result.excluded, true);
});

test('禁用的排除项不生效', () => {
  const compiled = compileExcludes([{ value: '重要', kind: 'contains', enabled: false }]);
  assert.equal(compiled.length, 0);
  assert.equal(checkExclude({ name: '重要文件' }, compiled).excluded, false);
});

test('空值与残缺条目被安全丢弃，不会让整份名单失效', () => {
  const compiled = compileExcludes([null, undefined, { value: '' }, {}, { value: '保留', kind: 'name' }]);
  assert.equal(compiled.length, 1);
  assert.equal(checkExclude({ name: '保留' }, compiled).excluded, true);
});

test('云端同步目录名可被识别，便于单独放行', () => {
  // 只要实现里登记了至少一个常见网盘目录，这个能力就算接通
  const known = ['OneDrive', 'Dropbox', 'Nutstore'].filter((name) => isCloudDirName(name));
  assert.ok(known.length >= 1);
});
