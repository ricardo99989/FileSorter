'use strict';

/**
 * 自定义归类规则引擎。
 *
 * 设计要点：
 * - **纯函数**，不碰文件系统，因此可以脱离 Electron 单独测试；
 * - 规则按数组顺序求值，**第一条命中的规则生效**，后面的不再尝试；
 * - 每条规则内部的多个条件之间是 AND，想让某个条件可选就拆成两条规则；
 * - 目标文件夹支持动态占位符（{yyyy} 这类），这样「按年月归档」不用写脚本。
 *
 * 求值顺序（在 organizer 里）：
 *   排除名单 → 自定义规则 → 扩展名分类 → 兜底「其他」
 */

const { sanitizeFolderName } = require('./classifier');

/** 条件字段的取值范围与展示名 */
const FIELD_LABELS = Object.freeze({
  name: '文件名',
  ext: '扩展名',
  size: '文件大小',
  mtime: '修改时间',
  ctime: '创建时间',
});

const OP_LABELS = Object.freeze({
  contains: '包含',
  notContains: '不包含',
  equals: '等于',
  regex: '匹配正则',
  gt: '大于',
  lt: '小于',
  between: '介于',
  within: '在最近',
  older: '早于',
});

/** 数值型字段（其余按字符串处理） */
const NUMERIC_FIELDS = new Set(['size', 'mtime', 'ctime']);

const MB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

/**
 * 编译一次规则列表，供批量匹配复用（正则只编译一次）。
 * @param {Array} rules store 里正规化过的规则数组
 */
function compileRules(rules) {
  if (!Array.isArray(rules)) return [];
  const compiled = [];
  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;
    const conditions = [];
    let broken = null;
    for (const cond of rule.conditions || []) {
      const item = { field: cond.field, op: cond.op };
      if (cond.op === 'regex') {
        try {
          item.regex = new RegExp(cond.value, 'i');
        } catch (err) {
          broken = `正则写错了：${err.message}`;
          break;
        }
      } else if (NUMERIC_FIELDS.has(cond.field)) {
        item.value = Number(cond.value);
        item.value2 = Number(cond.value2);
      } else {
        // 关键词统一按小写比较，避免用户被大小写绊住
        item.value = String(cond.value).toLowerCase();
        item.list = item.value
          .split(/[,，\s]+/)
          .map((part) => part.trim())
          .filter(Boolean);
      }
      conditions.push(item);
    }
    // 正则写错的规则整体失效，但不要连累其它规则
    if (broken || !conditions.length) continue;
    compiled.push({ ...rule, compiled: conditions });
  }
  return compiled;
}

/**
 * 判断单个条件是否命中。
 * @param {{field:string,op:string,value?:any,value2?:any,regex?:RegExp,list?:string[]}} cond
 * @param {{name:string,ext:string,size:number,mtime:number,ctime:number}} file
 */
function testCondition(cond, file) {
  const { field, op } = cond;

  if (field === 'name') {
    const name = String(file.name || '').toLowerCase();
    if (op === 'regex') return cond.regex.test(name);
    if (op === 'equals') return name === cond.value;
    if (op === 'contains') return cond.list.some((part) => name.includes(part));
    if (op === 'notContains') return !cond.list.some((part) => name.includes(part));
    return false;
  }

  if (field === 'ext') {
    const ext = String(file.ext || '').toLowerCase();
    if (op === 'regex') return cond.regex.test(ext);
    // 扩展名天然是列表语义：png,jpg,gif 命中任意一个即可
    if (op === 'equals' || op === 'contains') {
      return cond.list.some((part) => part.replace(/^\./, '') === ext);
    }
    if (op === 'notContains') {
      return !cond.list.some((part) => part.replace(/^\./, '') === ext);
    }
    return false;
  }

  if (field === 'size') {
    const size = Number(file.size) || 0;
    const value = cond.value * MB;
    if (op === 'gt') return size > value;
    if (op === 'lt') return size < value;
    if (op === 'between') return size >= value && size <= cond.value2 * MB;
    return false;
  }

  // mtime / ctime：统一换算成「距今天数」再比较，用户填天数最直观
  const stamp = field === 'ctime' ? file.ctime || file.mtime : file.mtime;
  if (!stamp) return false;
  const days = Math.floor((Date.now() - Number(stamp)) / DAY);
  if (op === 'within') return days <= cond.value;
  if (op === 'older') return days > cond.value;
  if (op === 'gt') return days > cond.value;
  if (op === 'lt') return days < cond.value;
  return false;
}

/**
 * 在编译后的规则表里找第一条命中的规则。
 * @returns {{rule:object, target:string}|null}
 */
function matchRules(compiled, file) {
  if (!compiled || !compiled.length) return null;
  for (const rule of compiled) {
    let hit = true;
    for (const cond of rule.compiled) {
      if (!testCondition(cond, file)) {
        hit = false;
        break;
      }
    }
    if (hit) return { rule, target: rule.target };
  }
  return null;
}

/** 两位补零 */
const pad = (value) => String(value).padStart(2, '0');

/**
 * 展开目标文件夹里的占位符。
 *
 * 支持：
 * - `{yyyy}` `{yy}` `{mm}` `{dd}` → 用修改时间（拿不到就用当前时间）
 * - `{ext}`  扩展名，无扩展名时给「无扩展名」
 * - `{type}` 扩展名分类的中文名
 * - `{first}` 文件名首字（按中文也能取到第一个字）
 *
 * @param {string} target
 * @param {{name:string,ext:string,size:number,mtime:number,ctime:number,categoryName?:string}} file
 */
function expandTarget(target, file) {
  const date = new Date(file.mtime || file.ctime || Date.now());
  const yyyy = String(date.getFullYear());
  const values = {
    yyyy,
    yy: yyyy.slice(2),
    mm: pad(date.getMonth() + 1),
    dd: pad(date.getDate()),
    ext: String(file.ext || '').toLowerCase() || '无扩展名',
    type: file.categoryName || '其他',
    first: Array.from(String(file.name || '?'))[0] || '#',
  };
  return String(target || '').replace(/\{(yyyy|yy|mm|dd|ext|type|first)\}/gi, (whole, key) => {
    const replacement = values[key.toLowerCase()];
    return replacement == null ? whole : replacement;
  });
}

/**
 * 把展开后的目标拆成安全的文件夹层级（最多 3 级）。
 * 用户写 `2026/11月` 就是两级目录；非法字符在每一级上单独清洗。
 *
 * @param {string} target
 * @param {object} file
 * @returns {string} 形如 `2026\\11月`
 */
function resolveTargetFolder(target, file) {
  const expanded = expandTarget(target, file);
  const segments = expanded
    .split(/[\\/]+/)
    .map((segment) => sanitizeFolderName(segment, ''))
    .filter(Boolean)
    .slice(0, 3);
  return segments.length ? segments.join('\\') : '其他';
}

/**
 * 给规则写一句中文说明，设置页直接展示，用户不用猜自己配了什么。
 * @param {object} rule
 */
function describeRule(rule) {
  const parts = (rule.conditions || []).map((cond) => {
    const field = FIELD_LABELS[cond.field] || cond.field;
    const op = OP_LABELS[cond.op] || cond.op;
    if (cond.field === 'size') {
      if (cond.op === 'between') return `${field} ${op} ${cond.value}–${cond.value2} MB`;
      return `${field} ${op} ${cond.value} MB`;
    }
    if (cond.field === 'mtime' || cond.field === 'ctime') {
      return `${field} ${op} ${cond.value} 天`;
    }
    return `${field} ${op}「${cond.value}」`;
  });
  return `${parts.join(' 且 ')} → ${rule.target}`;
}

/**
 * 校验用户正在编辑的规则，返回可以直接展示的中文错误。
 * @returns {{ok:boolean, error?:string}}
 */
function validateRule(rule) {
  if (!rule || typeof rule !== 'object') return { ok: false, error: '规则格式不对' };
  const target = String(rule.target || '').trim();
  if (!target) return { ok: false, error: '请填写要移动到的文件夹名' };
  if (!Array.isArray(rule.conditions) || !rule.conditions.length) {
    return { ok: false, error: '至少要有一个条件' };
  }
  const clean = sanitizeFolderName(target.split(/[\\/]/)[0], '');
  if (!clean) return { ok: false, error: '文件夹名里没有可用字符' };
  for (const cond of rule.conditions) {
    if (!FIELD_LABELS[cond.field]) return { ok: false, error: '条件字段不认识' };
    if (!OP_LABELS[cond.op]) return { ok: false, error: '比较方式不认识' };
    if (cond.op === 'regex') {
      try {
        new RegExp(cond.value, 'i');
      } catch (err) {
        return { ok: false, error: `正则不合法：${err.message}` };
      }
    }
    if (NUMERIC_FIELDS.has(cond.field) && cond.op !== 'between') {
      if (!Number.isFinite(Number(cond.value))) return { ok: false, error: '数值条件要填数字' };
    }
    if (cond.op === 'between' && !Number.isFinite(Number(cond.value2))) {
      return { ok: false, error: '区间条件要有上限' };
    }
  }
  return { ok: true };
}

/** 新建一条空白规则，供设置页「添加规则」直接插入 */
function blankRule(index = 0) {
  return {
    id: `rule-${Date.now().toString(36)}-${index}`,
    name: '新规则',
    enabled: true,
    target: '新文件夹',
    conditions: [{ field: 'name', op: 'contains', value: '' }],
  };
}

module.exports = {
  compileRules,
  matchRules,
  testCondition,
  expandTarget,
  resolveTargetFolder,
  describeRule,
  validateRule,
  blankRule,
  FIELD_LABELS,
  OP_LABELS,
  NUMERIC_FIELDS,
};
