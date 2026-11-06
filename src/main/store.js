'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * 默认设置。新增字段时同步升 version，并在这里给出安全默认值。
 *
 * 所有字段都是「可序列化的纯数据」：函数、类实例一律不进 settings，
 * 保证 settings.json 可以人工编辑、可以跨版本迁移。
 */
const DEFAULT_SETTINGS = Object.freeze({
  version: 5,

  /* ---------------- 整理 ---------------- */
  /** 分类 id → 用户自定义文件夹名 */
  customNames: {},
  /** 是否跳过隐藏文件（点前缀） */
  skipHidden: true,
  /** 自定义规则，顺序即优先级，先命中先用 */
  customRules: [],
  /** 排除名单：命中的文件/文件夹永不参与整理 */
  excludes: [],
  /** 整理时是否连规则命中的目录一起跳过（默认只处理直属文件） */
  skipCloudDirs: true,

  /* ---------------- 浏览 ---------------- */
  lastFolder: '',
  sortBy: 'name',
  sortDir: 'asc',
  viewMode: 'list',
  detailOpen: true,

  /* ---------------- 外观 ---------------- */
  /** 动效强度：full 全量 / soft 收敛 / off 关闭（无障碍） */
  motionLevel: 'full',
  /** 主题：system | light | dark */
  theme: 'system',
  /** 界面语言：zh | en */
  lang: 'zh',
  /** 鼠标光影跟随 */
  cursorGlow: true,
  /**
   * 玻璃厚度（0~30）。
   * 0 = 完全通透：只剩 backdrop 模糊和边光，桌面颜色原样透上来。
   * 调高会在玻璃上加一层极淡的白，用于"背后太花、字看不清"的救急。
   * 3.5 起默认 0 —— 用户要的就是通透优先。
   */
  mist: 0,

  /* ---------------- 窗口 ---------------- */
  /** 显示模式：window 窗口 / sidebar 侧边栏 / dock 任务栏悬浮 */
  mode: 'window',
  /** 侧边栏停靠方向 */
  sidebarSide: 'left',
  sidebarWidth: 420,
  window: { width: 1360, height: 860, maximized: false },
  /** 点关闭按钮时最小化到托盘，而不是退出 */
  closeToTray: true,

  /* ---------------- 收藏与自动化 ---------------- */
  /** 星标收藏的文件绝对路径（只存路径，文件被删就自然不会出现在收藏里） */
  favorites: [],
  /** 开机自启 */
  autostart: false,
  /** 学习模式：把「笔记/作业/考试/课件」类文件名归到「学习」 */
  learnMode: false,
  /** 新手引导是否已看过 */
  onboarded: false,

  /* ---------------- 监听与定时 ---------------- */
  /** 实时监听当前目录（chokidar 原生事件，不轮询） */
  watchEnabled: true,
  /** 定时整理 */
  schedule: {
    enabled: false,
    freq: 'daily',
    hour: 9,
    minute: 0,
    weekday: 1,
    dirs: [],
    silent: true,
    lastRun: 0,
  },

  /* ---------------- 其它 ---------------- */
  /** 启用的插件文件名（userData/plugins/*.js） */
  plugins: [],
  /** 重复文件检测的最小体积，默认 1KB */
  dupesMinSize: 1024,
  trayHintShown: false,
});

/** sortBy 允许值 */
const SORT_KEYS = ['name', 'size', 'mtime', 'ctime', 'type'];
const MOTION_LEVELS = ['full', 'soft', 'off'];
const THEMES = ['system', 'light', 'dark'];
const VIEW_MODES = ['list', 'grid'];
const LANGS = ['zh', 'en'];
const MODES = ['window', 'sidebar', 'dock'];

/**
 * 单条自定义规则的形状校验。
 * 结构：{ id, name, enabled, target, conditions: [{ field, op, value }] }
 * conditions 之间是 AND；规则之间按数组顺序 OR（先命中先返回）。
 */
const RULE_FIELDS = ['name', 'ext', 'size', 'mtime', 'ctime'];
const RULE_OPS = [
  'contains', 'notContains', 'equals', 'regex',
  'gt', 'lt', 'between', 'within', 'older',
];

function num(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (min != null && parsed < min) return fallback;
  if (max != null && parsed > max) return fallback;
  return parsed;
}

function str(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

/** 正规化单条条件；非法条件返回 null（整条规则随之丢弃） */
function normalizeCondition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const field = RULE_FIELDS.includes(raw.field) ? raw.field : null;
  const op = RULE_OPS.includes(raw.op) ? raw.op : null;
  if (!field || !op) return null;

  if (op === 'between') {
    const from = Number(raw.value);
    const to = Number(raw.value2);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    return { field, op, value: from, value2: to };
  }
  if (op === 'gt' || op === 'lt') {
    const value = Number(raw.value);
    if (!Number.isFinite(value)) return null;
    return { field, op, value };
  }
  if (op === 'within' || op === 'older') {
    const value = Number(raw.value);
    if (!Number.isFinite(value) || value < 0) return null;
    return { field: field === 'ctime' ? 'ctime' : 'mtime', op, value };
  }
  const value = str(raw.value);
  if (!value.trim()) return null;
  return { field, op, value };
}

/** 正规化规则列表，剔除坏数据而不是整体失败 */
function normalizeRules(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const target = str(item.target).trim();
    if (!target) continue;
    const conditions = Array.isArray(item.conditions)
      ? item.conditions.map(normalizeCondition).filter(Boolean)
      : [];
    if (!conditions.length) continue;
    out.push({
      id: str(item.id) || `rule-${out.length + 1}`,
      name: str(item.name).trim() || target,
      enabled: item.enabled !== false,
      target: target.slice(0, 60),
      conditions: conditions.slice(0, 6),
    });
  }
  return out.slice(0, 100);
}

/** 正规化排除名单 */
function normalizeExcludes(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const value = str(item.value).trim();
    if (!value) continue;
    const kind = ['name', 'contains', 'glob', 'path'].includes(item.kind) ? item.kind : 'contains';
    out.push({
      id: str(item.id) || `ex-${out.length + 1}`,
      value: value.slice(0, 260),
      kind,
      enabled: item.enabled !== false,
    });
  }
  return out.slice(0, 200);
}

function normalizeSchedule(raw) {
  const base = DEFAULT_SETTINGS.schedule;
  if (!raw || typeof raw !== 'object') return { ...base };
  return {
    enabled: Boolean(raw.enabled),
    freq: raw.freq === 'weekly' ? 'weekly' : 'daily',
    hour: Math.round(num(raw.hour, base.hour, 0, 23)),
    minute: Math.round(num(raw.minute, base.minute, 0, 59)),
    weekday: Math.round(num(raw.weekday, base.weekday, 1, 7)),
    dirs: Array.isArray(raw.dirs)
      ? raw.dirs.filter((d) => typeof d === 'string' && d.trim()).slice(0, 20)
      : [],
    silent: raw.silent !== false,
    lastRun: Math.max(0, num(raw.lastRun, 0, 0)),
  };
}

/**
 * settings.json 读写。写入走「临时文件 + rename」的原子替换，
 * 避免进程在写一半时被杀导致配置文件损坏。
 * @param {string} baseDir userData 目录
 */
function createStore(baseDir) {
  const file = path.join(baseDir, 'settings.json');
  let cache = { ...DEFAULT_SETTINGS };

  /** 过滤非法字段，避免坏配置把 UI 搞崩 */
  function normalize(raw) {
    const next = { ...DEFAULT_SETTINGS };
    if (!raw || typeof raw !== 'object') return next;

    if (raw.customNames && typeof raw.customNames === 'object') {
      const names = {};
      for (const [key, value] of Object.entries(raw.customNames)) {
        if (typeof key === 'string' && typeof value === 'string' && value.trim()) {
          names[key] = value.trim().slice(0, 60);
        }
      }
      next.customNames = names;
    }

    next.lastFolder = str(raw.lastFolder);
    if (typeof raw.skipHidden === 'boolean') next.skipHidden = raw.skipHidden;
    if (typeof raw.skipCloudDirs === 'boolean') next.skipCloudDirs = raw.skipCloudDirs;
    if (MOTION_LEVELS.includes(raw.motionLevel)) next.motionLevel = raw.motionLevel;
    if (SORT_KEYS.includes(raw.sortBy)) next.sortBy = raw.sortBy;
    if (['asc', 'desc'].includes(raw.sortDir)) next.sortDir = raw.sortDir;
    if (VIEW_MODES.includes(raw.viewMode)) next.viewMode = raw.viewMode;
    if (THEMES.includes(raw.theme)) next.theme = raw.theme;
    if (LANGS.includes(raw.lang)) next.lang = raw.lang;
    if (MODES.includes(raw.mode)) next.mode = raw.mode;
    if (['left', 'right'].includes(raw.sidebarSide)) next.sidebarSide = raw.sidebarSide;
    if (typeof raw.detailOpen === 'boolean') next.detailOpen = raw.detailOpen;
    if (typeof raw.cursorGlow === 'boolean') next.cursorGlow = raw.cursorGlow;
    if (typeof raw.closeToTray === 'boolean') next.closeToTray = raw.closeToTray;
    if (typeof raw.watchEnabled === 'boolean') next.watchEnabled = raw.watchEnabled;
    if (typeof raw.trayHintShown === 'boolean') next.trayHintShown = raw.trayHintShown;

    next.mist = Math.round(num(raw.mist, DEFAULT_SETTINGS.mist, 0, 30));
    next.sidebarWidth = Math.round(num(raw.sidebarWidth, DEFAULT_SETTINGS.sidebarWidth, 320, 720));
    next.dupesMinSize = Math.round(num(raw.dupesMinSize, DEFAULT_SETTINGS.dupesMinSize, 0, 1024 * 1024));

    if (typeof raw.autostart === 'boolean') next.autostart = raw.autostart;
    if (typeof raw.learnMode === 'boolean') next.learnMode = raw.learnMode;
    if (typeof raw.onboarded === 'boolean') next.onboarded = raw.onboarded;
    // 收藏只留绝对路径，去重、限长：这是个只增不减的列表，跑几年也不该把设置撑爆
    if (Array.isArray(raw.favorites)) {
      const seen = new Set();
      next.favorites = raw.favorites
        .filter((item) => typeof item === 'string' && item.length > 2)
        .filter((item) => {
          const key = item.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 500);
    }

    next.customRules = normalizeRules(raw.customRules);
    next.excludes = normalizeExcludes(raw.excludes);
    next.schedule = normalizeSchedule(raw.schedule);

    if (Array.isArray(raw.plugins)) {
      next.plugins = raw.plugins.filter((name) => typeof name === 'string' && name.endsWith('.js')).slice(0, 50);
    }

    if (raw.window && typeof raw.window === 'object') {
      next.window = {
        width: Math.round(num(raw.window.width, DEFAULT_SETTINGS.window.width, 900, 8000)),
        height: Math.round(num(raw.window.height, DEFAULT_SETTINGS.window.height, 600, 8000)),
        maximized: Boolean(raw.window.maximized),
      };
    }
    return next;
  }

  async function load() {
    try {
      const text = await fs.readFile(file, 'utf8');
      cache = normalize(JSON.parse(text));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn('[store] 读取设置失败，使用默认值：', err.message);
      }
      cache = { ...DEFAULT_SETTINGS };
    }
    return cache;
  }

  /** 返回深拷贝，调用方改坏了也污染不到缓存 */
  function get() {
    return JSON.parse(JSON.stringify(cache));
  }

  /** 只写入真正变化的字段，避免每次保存都重排整个文件 */
  function shallowEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
    return JSON.stringify(a) === JSON.stringify(b);
  }

  async function save(patch = {}) {
    cache = normalize({ ...cache, ...patch, customNames: { ...cache.customNames, ...(patch.customNames || {}) } });
    await fs.mkdir(baseDir, { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
    await fs.rename(tmp, file);
    return get();
  }

  /** 订阅变更：主进程内部（定时任务、托盘）需要感知设置变化 */
  const listeners = new Set();
  function subscribe(handler) {
    listeners.add(handler);
    return () => listeners.delete(handler);
  }
  const rawSave = save;
  async function saveAndNotify(patch) {
    const before = JSON.stringify(cache);
    const result = await rawSave(patch);
    if (JSON.stringify(cache) !== before) {
      for (const handler of listeners) {
        try {
          handler(result);
        } catch (err) {
          console.warn('[store] 订阅回调出错：', err.message);
        }
      }
    }
    return result;
  }

  return {
    file,
    load,
    get,
    save: saveAndNotify,
    subscribe,
    normalize,
    shallowEqual,
    DEFAULT_SETTINGS,
  };
}

module.exports = {
  createStore,
  DEFAULT_SETTINGS,
  normalizeRules,
  normalizeExcludes,
  normalizeSchedule,
  RULE_FIELDS,
  RULE_OPS,
};
