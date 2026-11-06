'use strict';

/**
 * indexer.js — 全盘文件名索引（3.8）
 *
 * 目标写死三条：
 *   1. 搜索必须是纯内存扫描，单次 < 30ms（渲染进程每敲一个字符都会调）；
 *   2. 建索引不能卡界面 —— 主进程也要让路，所以扫描是分批 + 让出事件循环；
 *   3. 内存要有上限。存的是"目录表 + 条目"而不是完整路径字符串：
 *      20 万条大约 30MB，完整路径在查询结果时才拼出来。
 *
 * 结构：
 *   dirs:    ['D:\\workbuddy\\2026-10-23', ...]        唯一目录，条目只存下标
 *   entries: [{ n: 原名, l: 小写名, d: 目录下标, s: 大小, t: mtime(秒) }]
 *
 * 为什么不存完整路径：同目录下 20 个文件就有 20 份重复的目录前缀，
 * 压掉这一层，内存直接少一半以上，内存目标才有戏。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { pinyin } = require('pinyin-pro');

const MAX_ENTRIES = 240000;
const MAX_DEPTH = 10;
const CACHE_VERSION = 3;
const CACHE_TTL = 12 * 60 * 60 * 1000;

/** 这些目录要么是系统目录，要么是构建产物，扫进来只会拖慢搜索、污染结果 */
const SKIP_NAMES = new Set([
  'windows',
  'winsxs',
  'program files',
  'program files (x86)',
  'programdata',
  '$recycle.bin',
  'system volume information',
  'recovery',
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.next',
  '.nuxt',
  '.cache',
  '.gradle',
  '.nuget',
  '__pycache__',
  'site-packages',
  'anaconda3',
  'miniconda3',
  'dist-info',
  'driverstore',
  'installer',
]);

const state = {
  ready: false,
  scanning: false,
  dirs: [],
  dirIndex: new Map(),
  entries: [],
  startedAt: 0,
  scanned: 0,
  roots: [],
  error: null,
  /** 拼音补齐到第几条；搜索只用已补齐的部分，不阻塞首次可用 */
  pyCursor: 0,
  pyTimer: null,
  pyDone: false,
  /** 缓存目录：拼音补完之后要把结果回写，否则下次启动又会丢 */
  userData: '',
  cacheTimer: null,
};

function lc(value) {
  return String(value).toLowerCase();
}

function dirId(dir) {
  const key = dir.toLowerCase();
  let id = state.dirIndex.get(key);
  if (id === undefined) {
    id = state.dirs.length;
    state.dirs.push(dir);
    state.dirIndex.set(key, id);
  }
  return id;
}

function shouldSkip(dirName) {
  return SKIP_NAMES.has(lc(dirName));
}

/** 列出所有固定/可移动盘符（跳过光驱与网络盘，它们会让首次扫描变得不可预测） */
async function listRoots() {
  const drives = [];
  for (let code = 67; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      // 只要能 stat 到根就算存在；光驱在无盘时会抛错，正好被跳过
      const stat = await fsp.stat(root, { bigint: false });
      if (stat.isDirectory()) drives.push(root);
    } catch {
      /* 不存在 */
    }
  }
  return drives;
}

/**
 * 广度优先扫描。
 * 每处理 1500 个条目就让一次事件循环 —— 主进程还要响应 IPC，
 * 一口气跑完会让"打开设置""切窗口"这些操作停顿好几秒。
 */
async function scan(roots, onProgress) {
  const dirs = []; // 待扫目录 { dir, depth }
  for (const root of roots) dirs.push({ dir: root, depth: 0 });

  let cursor = 0;
  let count = 0;

  while (cursor < dirs.length && count < MAX_ENTRIES) {
    const { dir, depth } = dirs[cursor];
    cursor += 1;

    let handle;
    try {
      handle = await fsp.opendir(dir, { bufferSize: 128 });
    } catch {
      continue;
    }

    const id = dirId(dir);
    let batch = 0;
    try {
      for await (const entry of handle) {
        if (count >= MAX_ENTRIES) break;
        const name = entry.name;
        // 隐藏项与系统项：以 . 开头、以 $ 开头（$RECYCLE.BIN 之类）
        if (!name || name[0] === '.' || name[0] === '$') continue;

        if (entry.isDirectory()) {
          if (depth < MAX_DEPTH && !shouldSkip(name)) {
            dirs.push({ dir: path.join(dir, name), depth: depth + 1 });
          }
          continue;
        }
        if (!entry.isFile()) continue;

        let stat;
        try {
          stat = await fsp.stat(path.join(dir, name));
        } catch {
          continue;
        }
        state.entries.push({
          n: name,
          l: lc(name),
          d: id,
          s: stat.size,
          t: Math.round(stat.mtimeMs / 1000),
        });
        count += 1;

        batch += 1;
        if (batch >= 1500) {
          batch = 0;
          onProgress?.(count);
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    } catch {
      /* 目录读到一半没权限，跳过 */
    }
  }

  return count;
}

/* ------------------------------ 缓存 ------------------------------ */

function cachePath(userData) {
  return path.join(userData, 'search-index.json.gz');
}

async function saveCache(userData) {
  const payload = {
    v: CACHE_VERSION,
    at: Date.now(),
    dirs: state.dirs,
    // 拼音补完没？没补完的缓存下次启动还要再补一次，不能当成"已完成"
    py: state.pyDone,
    // 元组而不是对象：同样的内容体积小 30%，gzip 之后更明显
    entries: state.entries.map((e) => [e.n, e.d, e.s, e.t, e.p || '', e.i || '']),
  };
  const buf = zlib.gzipSync(Buffer.from(JSON.stringify(payload)), { level: 6 });
  await fsp.writeFile(cachePath(userData), buf);
}

async function loadCache(userData) {
  try {
    const buf = await fsp.readFile(cachePath(userData));
    const data = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
    if (data.v !== CACHE_VERSION || !Array.isArray(data.entries)) return false;
    if (Date.now() - data.at > CACHE_TTL) return false;

    state.dirs = data.dirs;
    state.dirIndex = new Map(state.dirs.map((dir, index) => [lc(dir), index]));
    state.entries = data.entries.map(([n, d, s, t, py, ini]) => ({
      n,
      l: lc(n),
      d,
      s,
      t,
      p: py || undefined,
      i: ini || undefined,
    }));
    state.ready = true;
    state.scanned = state.entries.length;
    state.pyDone = data.py === true;
    return { pyDone: state.pyDone };
  } catch {
    return false;
  }
}

/* ------------------------------ 拼音 ------------------------------ */

/**
 * 中文文件的拼音索引。
 *
 * 为什么要两份：用户可能按全拼（"baogao"）也可能按首字母（"bg"）敲。
 * pinyin-pro 一次调用能拿到音节数组，顺手拼出全拼与首字母，比调两次便宜一半。
 *
 * 为什么分期：20 万个名字全算一遍要几秒，期间搜索不能等它。
 * 所以放到索引就绪之后，每帧补 2000 条，搜索只用已经补好的部分。
 */
function buildPinyinChunk() {
  const startedAt = Date.now();
  while (state.pyCursor < state.entries.length) {
    const entry = state.entries[state.pyCursor];
    state.pyCursor += 1;
    // 纯 ASCII 名字不需要拼音索引；增量重扫回填过的也不用再算
    if (entry.p || !/[\u4e00-\u9fa5]/.test(entry.n)) continue;
    if (entry.n.length > 40) continue;
    try {
      // 只取中文字符：把 "报表2026.md" 交给 pinyin-pro，它会把 "." 当成一个音节，
      // 首字母就变成 "bb2."，用户敲 "bb" 反而不精确。扩展名、数字本来就由 l 覆盖。
      const zhOnly = entry.n.replace(/[^\u4e00-\u9fa5]/g, '');
      if (!zhOnly) continue;
      const syllables = pinyin(zhOnly, { type: 'array', toneType: 'none' });
      entry.p = syllables.join('').toLowerCase();
      entry.i = syllables.map((item) => item[0]).join('').toLowerCase();
    } catch {
      /* 生僻字组合算不出来就跳过，不影响其他条目 */
    }
    // 每 8ms 让一次事件循环：搜索请求要能插进来
    if (Date.now() - startedAt > 8) {
      state.pyTimer = setTimeout(buildPinyinChunk, 0);
      return;
    }
  }
  state.pyTimer = null;
  state.pyDone = true;
  // 拼音是后台算的，缓存是扫描完就写的 —— 此刻必须再写一次，
  // 否则下次启动加载到的仍是"没有拼音"的旧缓存。
  clearTimeout(state.cacheTimer);
  state.cacheTimer = setTimeout(() => {
    if (state.userData) saveCache(state.userData).catch(() => {});
  }, 600);
}

function startPinyin() {
  clearTimeout(state.pyTimer);
  state.pyCursor = 0;
  state.pyDone = false;
  state.pyTimer = setTimeout(buildPinyinChunk, 120);
}

/* ------------------------------ 查询 ------------------------------ */

/** 相对时间权重：最近改过的文件更可能是用户要找的 */
function recencyBonus(seconds) {
  if (!seconds) return 0;
  const age = Date.now() / 1000 - seconds;
  if (age < 86400) return 90;
  if (age < 7 * 86400) return 60;
  if (age < 30 * 86400) return 30;
  if (age < 365 * 86400) return 10;
  return 0;
}

/**
 * 打分规则（对齐用户提的排序要求）：
 *   名字完全相等 > 名字前缀 > 名字包含 > 路径包含，同档再按修改时间与大小比。
 * 名字越长、匹配位置越靠前，分数越高 —— 这样"报告"不会先命中"报告备份备份备份"。
 */
function scoreEntry(entry, query, lowerQuery) {
  const name = entry.l;
  let score = 0;

  if (name === lowerQuery) score = 1000;
  else if (name.startsWith(lowerQuery)) score = 820;
  else {
    const at = name.indexOf(lowerQuery);
    if (at >= 0) score = 620 - Math.min(120, at * 6);
    else {
      // 拼音：首字母前缀最接近"我记得怎么念"，全拼前缀次之，包含再次
      if (entry.i && entry.i.startsWith(lowerQuery)) score = 560;
      else if (entry.p && entry.p.startsWith(lowerQuery)) score = 520;
      else if (entry.i && entry.i.includes(lowerQuery)) score = 470;
      else if (entry.p && entry.p.includes(lowerQuery)) score = 430;
      else {
        const dir = state.dirs[entry.d] || '';
        if (lc(dir).includes(lowerQuery)) score = 300;
        else return 0;
      }
    }
  }

  // 短名字更像"目标文件"，长名字往往是备份/日志
  score -= Math.min(60, Math.max(0, name.length - lowerQuery.length) * 2);
  score += recencyBonus(entry.t);
  // 大文件优先（用户找视频、安装包时更符合直觉），但对结果只做微调
  score += Math.min(20, Math.log10(Math.max(1, entry.s)) * 3);
  return score;
}

function rowOf(entry) {
  const dir = state.dirs[entry.d] || '';
  return {
    name: entry.n,
    path: path.join(dir, entry.n),
    dir,
    size: entry.s,
    mtime: entry.t * 1000,
  };
}

/** 多关键词里单个词的命中判定：名字 / 全拼 / 首字母 / 所在目录，任一即可 */
function tokenHit(entry, token, lowerDir) {
  if (entry.l.includes(token)) return true;
  if (entry.p && entry.p.includes(token)) return true;
  if (entry.i && entry.i.includes(token)) return true;
  return lowerDir.includes(token);
}

/**
 * 搜索。纯内存线性扫描：24 万条 + 两级字符串比较，常规查询个位数毫秒。
 * 只在需要时才拼 path（结果最多 60 条），避免给每个候选都建字符串。
 */
function search(rawQuery, options = {}) {
  const limit = Math.min(60, Math.max(1, options.limit || 30));
  const query = String(rawQuery || '').trim();
  if (!query) return { results: [], total: 0, took: 0, ready: state.ready };

  const started = process.hrtime.bigint();
  const lowerQuery = lc(query);
  const tokens = lowerQuery.split(/\s+/).filter(Boolean);

  const hits = [];
  for (let i = 0; i < state.entries.length; i += 1) {
    const entry = state.entries[i];
    // 多关键词：每个词都要命中，顺序无关（"报告 2026"、"bg 报表"）
    let ok = true;
    if (tokens.length > 1) {
      const lowerDir = lc(state.dirs[entry.d] || '');
      for (let k = 0; k < tokens.length; k += 1) {
        if (!tokenHit(entry, tokens[k], lowerDir)) {
          ok = false;
          break;
        }
      }
    }
    if (!ok) continue;

    const score = tokens.length > 1
      ? 700 + recencyBonus(entry.t)
      : scoreEntry(entry, query, lowerQuery);
    if (score > 0) hits.push({ entry, score });
    if (hits.length >= 4000) {
      // 宽查询（只敲一个 "e"）会在前半张表就攒满，直接 break 会让后面盘的高分结果
      // 永远排不进来。定期裁到 top 800 再继续扫，最终排序仍是全局的。
      hits.sort((a, b) => b.score - a.score);
      hits.length = 800;
    }
  }

  hits.sort((a, b) => b.score - a.score);
  const results = hits.slice(0, limit).map((hit) => rowOf(hit.entry));
  const took = Number(process.hrtime.bigint() - started) / 1e6;

  return { results, total: hits.length, took: Math.round(took * 10) / 10, ready: state.ready };
}

/* ------------------------------ 生命周期 ------------------------------ */

let progressTimer = null;

async function build(userData, { onProgress, roots, useCache = true } = {}) {
  if (state.scanning) return state;
  state.scanning = true;
  state.error = null;
  state.startedAt = Date.now();
  state.userData = userData;

  const loaded = useCache ? await loadCache(userData) : false;
  if (loaded) {
    state.scanning = false;
    // 缓存命中也要后台补扫一遍：用户在两次启动之间新增的文件不能丢
    rescan(userData, { onProgress }).catch(() => {});
    return state;
  }
  state.pyDone = false;

  state.dirs = [];
  state.dirIndex = new Map();
  state.entries = [];
  state.roots = roots && roots.length ? roots : await listRoots();
  await scan(state.roots, (count) => {
    state.scanned = count;
    onProgress?.(count);
  });
  state.ready = true;
  state.scanning = false;
  state.scanned = state.entries.length;

  // 写缓存放到下一轮事件循环：建索引的最后一刻不要去抢主线程
  setImmediate(() => {
    saveCache(userData).catch(() => {});
  });
  startPinyin();
  return state;
}

/** 增量重扫：整表重建但不清空旧的，扫完再替换，搜索过程中不会出现"空索引" */
async function rescan(userData, { onProgress } = {}) {
  if (state.scanning) return state;
  state.scanning = true;
  state.userData = userData || state.userData;
  const roots = state.roots.length ? state.roots : await listRoots();

  const before = state.entries;
  const backupDirs = state.dirs;
  /**
   * 整表重建会让目录下标全部失效，但拼音是按"名字"算的，跟下标无关。
   * 先把旧结果里的拼音按 (原目录 + 文件名) 存下来，扫完回填 ——
   * 缓存命中后的补扫就不必把几十万条中文重算一遍。
   */
  const pinyinMap = new Map();
  if (state.pyDone) {
    for (const entry of before) {
      if (entry.p || entry.i) {
        pinyinMap.set(`${backupDirs[entry.d] || ''}\0${entry.l}`, [entry.p, entry.i]);
      }
    }
  }

  clearTimeout(state.pyTimer);
  state.pyTimer = null;
  state.dirs = [];
  state.dirIndex = new Map();
  state.entries = [];
  await scan(roots, (count) => {
    state.scanned = count;
    onProgress?.(count);
  });
  // 扫出来是空的（盘没挂载、权限变了）就保留旧结果，不要把索引弄丢
  if (state.entries.length === 0) {
    state.entries = before;
    state.dirs = backupDirs;
    state.dirIndex = new Map(backupDirs.map((dir, index) => [lc(dir), index]));
  } else if (pinyinMap.size) {
    for (const entry of state.entries) {
      const hit = pinyinMap.get(`${state.dirs[entry.d] || ''}\0${entry.l}`);
      if (hit) {
        entry.p = hit[0];
        entry.i = hit[1];
      }
    }
  }
  state.ready = true;
  state.scanning = false;
  state.scanned = state.entries.length;
  // 回填过的条目会被 buildPinyinChunk 跳过，只补新增的中文名
  startPinyin();
  setImmediate(() => {
    if (state.userData) saveCache(state.userData).catch(() => {});
  });
  return state;
}

function stats() {
  return {
    ready: state.ready,
    scanning: state.scanning,
    count: state.entries.length,
    scanned: state.scanned,
    roots: state.roots,
    pinyin: state.pyCursor,
    pinyinDone: state.pyDone,
    took: state.startedAt ? Date.now() - state.startedAt : 0,
  };
}

module.exports = {
  build,
  rescan,
  search,
  stats,
  // 冒烟用
  _state: state,
};
