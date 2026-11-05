'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

/** 默认设置。新增字段时同步升 version，并在这里给出安全默认值。 */
const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  /** 分类 id → 用户自定义文件夹名 */
  customNames: {},
  /** 上次打开的目录，下次启动直接进入 */
  lastFolder: '',
  /** 是否跳过 . 开头的隐藏文件 */
  skipHidden: true,
  /** 动效强度：full 全量 / soft 收敛 / off 关闭（无障碍） */
  motionLevel: 'full',
  /** 文件列表排序：mtime | name | size */
  sortBy: 'mtime',
});

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
          names[key] = value.trim();
        }
      }
      next.customNames = names;
    }
    if (typeof raw.lastFolder === 'string' && raw.lastFolder) next.lastFolder = raw.lastFolder;
    if (typeof raw.skipHidden === 'boolean') next.skipHidden = raw.skipHidden;
    if (['full', 'soft', 'off'].includes(raw.motionLevel)) next.motionLevel = raw.motionLevel;
    if (['mtime', 'name', 'size'].includes(raw.sortBy)) next.sortBy = raw.sortBy;
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

  function get() {
    return { ...cache, customNames: { ...cache.customNames } };
  }

  async function save(patch = {}) {
    cache = normalize({ ...cache, ...patch, customNames: { ...cache.customNames, ...(patch.customNames || {}) } });
    await fs.mkdir(baseDir, { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
    await fs.rename(tmp, file);
    return get();
  }

  return { file, load, get, save, DEFAULT_SETTINGS };
}

module.exports = { createStore, DEFAULT_SETTINGS };
