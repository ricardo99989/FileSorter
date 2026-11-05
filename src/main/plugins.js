'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

/**
 * 插件机制：让用户用一小段 JS 扩展归类规则。
 *
 * 插件放在 `userData/plugins/*.js`，形如：
 *
 *   module.exports = {
 *     name: '按项目归档',
 *     version: '1.0.0',
 *     match(file) {
 *       if (/^\d{4}年/.test(file.name)) return '旧项目';
 *       return null;   // 返回 null 表示这条不管，交给下一条规则
 *     }
 *   }
 *
 * 沙箱说明：脚本在 `vm` 上下文里跑，拿不到 require / process / fs，
 * 单次求值有超时保护。但 **vm 不是安全边界**——它是防手滑，不是防恶意。
 * 只装你自己看得懂的脚本，这一点在 README 里也写清楚了。
 */

/** 单批求值的超时（毫秒），超时后这一批文件跳过插件，不影响其它规则 */
const BATCH_TIMEOUT = 500;
/** 一批喂多少文件，太大容易顶到超时 */
const BATCH_SIZE = 400;

/** 沙箱里能用的全局对象，只有判断需要的那几个 */
function baseSandbox() {
  return {
    // 纯计算用的内建对象，够写规则了
    Math,
    Date,
    JSON,
    String,
    Number,
    Boolean,
    Array,
    Object,
    RegExp,
    Map,
    Set,
    isNaN,
    parseInt,
    parseFloat,
    console: { log: () => {}, warn: () => {}, error: () => {} },
  };
}

/**
 * 加载并编译一个插件文件。
 * @param {string} file
 */
async function loadOne(file) {
  const code = await fs.readFile(file, 'utf8');
  const sandbox = baseSandbox();
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  const context = vm.createContext(sandbox);

  const record = {
    file,
    title: path.basename(file, '.js'),
    name: path.basename(file, '.js'),
    version: '0.0.0',
    description: '',
    ok: false,
    error: '',
    context,
    plugin: null,
  };

  try {
    // 加载阶段也给超时：防止有人在顶层写了个死循环
    new vm.Script(code, { filename: file }).runInContext(context, { timeout: BATCH_TIMEOUT });
    const exported = sandbox.module.exports;
    if (!exported || typeof exported.match !== 'function') {
      record.error = '插件没有导出 match(file) 函数';
      return record;
    }
    record.plugin = exported;
    record.name = String(exported.name || record.title).slice(0, 40);
    record.version = String(exported.version || '0.0.0').slice(0, 20);
    record.description = String(exported.description || '').slice(0, 200);
    record.ok = true;
  } catch (err) {
    record.error = err.message || String(err);
  }
  return record;
}

/**
 * 扫描插件目录，返回全部插件的状态（含未启用的）。
 * @param {string} dir
 */
async function scanAll(dir) {
  let names = [];
  try {
    names = (await fs.readdir(dir)).filter((name) => name.endsWith('.js'));
  } catch {
    return [];
  }
  names.sort();
  const out = [];
  for (const name of names) {
    out.push(await loadOne(path.join(dir, name)));
  }
  return out;
}

/**
 * 只加载启用名单里的插件，用于整理时求值。
 * @param {string} dir
 * @param {string[]} enabledNames 形如 ['my-rule.js']
 */
async function loadEnabled(dir, enabledNames) {
  const allow = new Set(Array.isArray(enabledNames) ? enabledNames : []);
  if (!allow.size) return [];
  const all = await scanAll(dir);
  return all.filter((item) => item.ok && allow.has(path.basename(item.file)));
}

/**
 * 对一批文件求值，返回 `文件名 → 目标文件夹` 的映射。
 *
 * @param {Array} plugins loadEnabled 的产物
 * @param {Array<{name:string,ext:string,size:number,mtime:number,ctime:number}>} files
 * @returns {Promise<Map<string,string>>}
 */
async function applyPlugins(plugins, files) {
  const result = new Map();
  if (!plugins || !plugins.length || !files.length) return result;

  for (const entry of plugins) {
    const { plugin, context } = entry;
    // 一次喂一批，整批共用一个超时；插件写死循环也只会拖累这一批
    for (let start = 0; start < files.length; start += BATCH_SIZE) {
      const slice = files.slice(start, start + BATCH_SIZE);
      context.__batchFiles = slice;
      context.__plugin = plugin;
      let answers = null;
      try {
        answers = new vm.Script(
          `(function () {
             const out = [];
             for (let i = 0; i < __batchFiles.length; i += 1) {
               try { out.push(__plugin.match(__batchFiles[i]) || null); }
               catch (err) { out.push(null); }
             }
             return out;
           })()`,
          { filename: `${entry.file}#match` },
        ).runInContext(context, { timeout: BATCH_TIMEOUT });
      } catch {
        // 超时或抛错：这一批放弃，继续下一批，不让一个坏插件毁掉整次整理
        continue;
      }
      for (let i = 0; i < slice.length; i += 1) {
        const folder = answers[i];
        // 先命中的插件优先，后面的不再覆盖
        if (typeof folder === 'string' && folder.trim() && !result.has(slice[i].name)) {
          result.set(slice[i].name, folder.trim());
        }
      }
    }
  }
  return result;
}

/**
 * 把一段脚本存成插件文件。
 * @param {string} dir
 * @param {string} fileName
 * @param {string} code
 */
async function savePlugin(dir, fileName, code) {
  const safe = String(fileName || '').replace(/[^\w.-]/g, '');
  if (!safe.endsWith('.js')) throw new Error('插件文件名要以 .js 结尾');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, safe), String(code || ''), 'utf8');
  return safe;
}

/** 生成一份可直接跑的示例插件，放在插件目录里当文档 */
const EXAMPLE = `// 示例插件：文件名以 4 位年份开头的，按年份归档
// 可用的 file 字段：name / ext / size(字节) / mtime / ctime(毫秒时间戳) / ageDays
module.exports = {
  name: '按年份归档',
  version: '1.0.0',
  description: '文件名以 2020、2021 这类年份开头时，放进对应年份文件夹',
  match(file) {
    const hit = /^(20\\d{2})[年\\-_ ]/.exec(file.name);
    if (hit) return hit[1] + '年';
    return null;
  },
};
`;

/** 首次启动时放一份示例，让用户知道脚本长什么样 */
async function ensureExample(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
    const names = await fs.readdir(dir);
    if (names.some((name) => name.endsWith('.js'))) return false;
    await fs.writeFile(path.join(dir, 'example-year.js'), EXAMPLE, 'utf8');
    return true;
  } catch {
    return false;
  }
}

module.exports = { scanAll, loadEnabled, applyPlugins, savePlugin, ensureExample, EXAMPLE, BATCH_TIMEOUT };
