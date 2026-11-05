'use strict';

/**
 * 规则引擎测试。
 *
 * 这套规则是「误整理」的最后一道防线之一，所以重点覆盖三件事：
 * 1. 顺序语义 —— 第一条命中即生效，绝不允许后面的规则改写前面的结果；
 * 2. 组合语义 —— 规则内多条件是 AND，不是 OR；
 * 3. 目标展开 —— 占位符与非法字符清洗，不能生成 Windows 建不出来的文件夹名。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  compileRules,
  matchRules,
  testCondition,
  expandTarget,
  resolveTargetFolder,
  validateRule,
  describeRule,
  blankRule,
} = require('../src/main/rules');

const MB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

/** 三天前的文件元数据，时间类规则统一拿它做基准 */
function fileOf(overrides = {}) {
  return {
    name: '会议纪要.docx',
    ext: 'docx',
    size: 2 * MB,
    mtime: Date.now() - 3 * DAY,
    ctime: Date.now() - 5 * DAY,
    categoryName: '文档',
    ...overrides,
  };
}

test('第一条命中的规则生效，后面的规则不再参与', () => {
  const compiled = compileRules([
    { name: '笔记优先', target: '笔记', conditions: [{ field: 'name', op: 'contains', value: '笔记' }] },
    { name: '宽泛兜底', target: '其它', conditions: [{ field: 'name', op: 'contains', value: '' }] },
  ]);
  const hit = matchRules(compiled, fileOf({ name: '读书笔记.md' }));
  assert.equal(hit.target, '笔记');
  assert.equal(hit.rule.name, '笔记优先');
});

test('规则内多个条件是 AND：任一不满足就不命中', () => {
  const compiled = compileRules([
    {
      name: '大体积图片',
      target: '大图',
      conditions: [
        { field: 'ext', op: 'equals', value: 'jpg,png' },
        { field: 'size', op: 'gt', value: 1 },
      ],
    },
  ]);

  assert.equal(matchRules(compiled, fileOf({ name: 'a.jpg', ext: 'jpg', size: 2 * MB })).target, '大图');
  // 体积不满足
  assert.equal(matchRules(compiled, fileOf({ name: 'b.jpg', ext: 'jpg', size: 0.5 * MB })), null);
  // 扩展名不满足
  assert.equal(matchRules(compiled, fileOf({ name: 'c.pdf', ext: 'pdf', size: 2 * MB })), null);
});

test('扩展名条件天然是列表语义，逗号与空格都能分隔', () => {
  const cond = compileRules([
    { target: 'x', conditions: [{ field: 'ext', op: 'equals', value: 'png, jpg，gif' }] },
  ])[0].compiled[0];

  for (const ext of ['png', 'jpg', 'gif']) {
    assert.equal(testCondition(cond, fileOf({ ext })), true, ext);
  }
  assert.equal(testCondition(cond, fileOf({ ext: 'bmp' })), false);
});

test('文件名关键词比较不区分大小写', () => {
  const cond = compileRules([
    { target: 'x', conditions: [{ field: 'name', op: 'contains', value: 'REPORT' }] },
  ])[0].compiled[0];
  assert.equal(testCondition(cond, fileOf({ name: 'Q3_report_final.pdf' })), true);
});

test('时间条件按「距今天数」解释，within 与 older 互为补集', () => {
  const within = compileRules([
    { target: 'x', conditions: [{ field: 'mtime', op: 'within', value: 7 }] },
  ])[0].compiled[0];
  const older = compileRules([
    { target: 'x', conditions: [{ field: 'mtime', op: 'older', value: 7 }] },
  ])[0].compiled[0];

  const recent = fileOf({ mtime: Date.now() - 2 * DAY });
  const ancient = fileOf({ mtime: Date.now() - 30 * DAY });

  assert.equal(testCondition(within, recent), true);
  assert.equal(testCondition(within, ancient), false);
  assert.equal(testCondition(older, recent), false);
  assert.equal(testCondition(older, ancient), true);
});

test('体积条件以 MB 为单位，between 是闭区间', () => {
  const between = compileRules([
    { target: 'x', conditions: [{ field: 'size', op: 'between', value: 1, value2: 5 }] },
  ])[0].compiled[0];

  assert.equal(testCondition(between, fileOf({ size: 1 * MB })), true);
  assert.equal(testCondition(between, fileOf({ size: 5 * MB })), true);
  assert.equal(testCondition(between, fileOf({ size: 0.9 * MB })), false);
  assert.equal(testCondition(between, fileOf({ size: 5.1 * MB })), false);
});

test('正则写错的规则会被整体丢弃，但不连累其它规则', () => {
  const compiled = compileRules([
    { name: '坏正则', target: '坏', conditions: [{ field: 'name', op: 'regex', value: '([' }] },
    { name: '好规则', target: '好', conditions: [{ field: 'name', op: 'contains', value: 'a' }] },
  ]);
  assert.equal(compiled.length, 1);
  assert.equal(compiled[0].name, '好规则');
});

test('禁用的规则不参与匹配', () => {
  const compiled = compileRules([
    { name: '关掉的', target: 'a', enabled: false, conditions: [{ field: 'name', op: 'contains', value: 'x' }] },
  ]);
  assert.equal(compiled.length, 0);
});

test('目标文件夹的日期占位符用修改时间展开', () => {
  const stamp = new Date(2026, 2, 7, 10, 30).getTime(); // 2026-03-07
  const out = expandTarget('{yyyy}-{mm}/{dd}', fileOf({ mtime: stamp }));
  assert.equal(out, '2026-03/07');
});

test('{ext} {type} {first} 占位符', () => {
  const file = fileOf({ name: '项目笔记.md', ext: 'md', categoryName: '文档' });
  assert.equal(expandTarget('{ext}', file), 'md');
  assert.equal(expandTarget('{type}', file), '文档');
  assert.equal(expandTarget('{first}', file), '项');
});

test('无扩展名文件展开 {ext} 时给出可读名字而不是空串', () => {
  const folder = resolveTargetFolder('{ext}', fileOf({ name: 'README', ext: '' }));
  assert.ok(folder.length > 0);
  assert.equal(folder.includes('\0'), false);
});

test('多级目标按斜杠拆开，每一级单独清洗非法字符', () => {
  const folder = resolveTargetFolder('图片/2026:03/夏天?', fileOf());
  const parts = folder.split(/[\\/]/);
  assert.equal(parts.length, 3);
  for (const part of parts) {
    assert.equal(/[<>:"|?*]/.test(part), false, `「${part}」仍含非法字符`);
  }
});

test('目标层级最多三层，防止用户写出一棵深树', () => {
  const folder = resolveTargetFolder('a/b/c/d/e', fileOf());
  assert.equal(folder.split(/[\\/]/).length, 3);
});

test('validateRule 拦住空目标与空条件', () => {
  assert.equal(validateRule({ target: '', conditions: [] }).ok, false);
  assert.equal(validateRule({ target: '笔记', conditions: [] }).ok, false);
  assert.equal(
    validateRule({ target: '笔记', conditions: [{ field: 'name', op: 'contains', value: '笔记' }] }).ok,
    true
  );
});

test('describeRule 生成可读的一句话，不是 JSON', () => {
  const text = describeRule({
    target: '笔记',
    conditions: [{ field: 'name', op: 'contains', value: '笔记' }],
  });
  assert.ok(text.includes('文件名'));
  assert.ok(text.includes('笔记'));
  assert.ok(!text.includes('{'));
});

test('blankRule 给出一份字段齐全的空规则，界面可直接渲染', () => {
  const rule = blankRule();
  assert.equal(typeof rule.id, 'string');
  assert.equal(typeof rule.target, 'string');
  assert.ok(Array.isArray(rule.conditions));
  assert.ok(rule.conditions.length >= 1);
});
