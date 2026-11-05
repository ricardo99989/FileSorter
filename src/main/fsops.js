'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { summarize } = require('./describe');

/** 单目录最多返回多少条，防止误入巨大目录把渲染层拖死 */
const MAX_ENTRIES = 20000;
/** stat 并发度：Windows 上再高收益不大，反而抢 IO */
const STAT_CONCURRENCY = 40;
/** 目录清单缓存时长，返回上级/前进时能瞬开 */
const CACHE_TTL = 3000;

const SYSTEM_NAMES = new Set(['desktop.ini', 'thumbs.db', '$recycle.bin', 'system volume information']);

/** 简易并发池：限制同时进行的 stat 数量 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 校验并规范化绝对路径 */
function assertPath(input, label = '路径') {
  if (typeof input !== 'string' || !input.trim()) throw new Error(`缺少${label}`);
  if (input.includes('\0')) throw new Error(`${label}包含非法字符`);
  if (!path.isAbsolute(input)) throw new Error(`${label}必须是绝对路径`);
  return path.normalize(input);
}

/** 目录的可读名称：C:\ → C:，D:\work → work */
function displayName(dir) {
  const base = path.basename(dir);
  if (base) return base;
  const parsed = path.parse(dir);
  return parsed.root ? parsed.root.replace(/[\\/]+$/, '') : dir;
}

/**
 * 是否隐藏。Node 读不到 Windows 的隐藏属性，这里退化为
 * 点前缀 + 常见系统文件名，README 里已注明这个限制。
 */
function isHiddenName(name) {
  return name.startsWith('.') || SYSTEM_NAMES.has(name.toLowerCase());
}

const cache = new Map();

/**
 * 列出目录第一层内容。
 * @param {string} input 绝对路径
 * @param {{showHidden?: boolean, refresh?: boolean}} options
 */
async function listDir(input, options = {}) {
  const dir = assertPath(input, '目录');
  const cacheKey = `${dir}|${options.showHidden ? 1 : 0}`;
  const hit = cache.get(cacheKey);
  if (!options.refresh && hit && Date.now() - hit.at < CACHE_TTL) {
    return hit.data;
  }

  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  const selected = options.showHidden ? dirents : dirents.filter((item) => !isHiddenName(item.name));
  const truncated = selected.length > MAX_ENTRIES;
  const slice = truncated ? selected.slice(0, MAX_ENTRIES) : selected;

  let unreadable = 0;
  const rows = await mapLimit(slice, STAT_CONCURRENCY, async (item) => {
    const full = path.join(dir, item.name);
    try {
      const st = await fsp.stat(full);
      const isDir = st.isDirectory();
      const ext = isDir ? '' : path.extname(item.name).slice(1).toLowerCase();
      const entry = {
        name: item.name,
        path: full,
        isDir,
        ext,
        size: isDir ? 0 : st.size,
        mtime: st.mtimeMs,
        ctime: st.birthtimeMs || st.ctimeMs,
        hidden: isHiddenName(item.name),
        link: st.isSymbolicLink(),
      };
      entry.desc = summarize(entry);
      return entry;
    } catch {
      // 无权限、恰好被删除、损坏的符号链接：跳过但不打断整次列举
      unreadable += 1;
      return null;
    }
  });

  const entries = rows.filter(Boolean);
  const files = entries.filter((e) => !e.isDir);
  const payload = {
    dir,
    name: displayName(dir),
    parent: path.dirname(dir) === dir ? null : path.dirname(dir),
    root: path.parse(dir).root,
    entries,
    counts: {
      files: files.length,
      dirs: entries.length - files.length,
      size: files.reduce((sum, f) => sum + f.size, 0),
      unreadable,
    },
    truncated,
  };

  cache.set(cacheKey, { at: Date.now(), data: payload });
  if (cache.size > 60) cache.delete(cache.keys().next().value);
  return payload;
}

/** 目录本身的信息，用于路径栏与详情栏 */
async function statPath(input) {
  const target = assertPath(input);
  const st = await fsp.stat(target);
  const isDir = st.isDirectory();
  return {
    path: target,
    name: displayName(target),
    isDir,
    size: isDir ? 0 : st.size,
    mtime: st.mtimeMs,
    ctime: st.birthtimeMs || st.ctimeMs,
    ext: isDir ? '' : path.extname(target).slice(1).toLowerCase(),
  };
}

/** 常用位置：只保留真实存在的目录 */
async function quickPlaces() {
  const candidates = [
    { key: 'home', name: '主目录', icon: 'home', dir: os.homedir() },
    { key: 'desktop', name: '桌面', icon: 'desktop', dir: path.join(os.homedir(), 'Desktop') },
    { key: 'downloads', name: '下载', icon: 'download', dir: path.join(os.homedir(), 'Downloads') },
    { key: 'documents', name: '文档', icon: 'doc', dir: path.join(os.homedir(), 'Documents') },
    { key: 'pictures', name: '图片', icon: 'image', dir: path.join(os.homedir(), 'Pictures') },
    { key: 'videos', name: '视频', icon: 'video', dir: path.join(os.homedir(), 'Videos') },
    { key: 'music', name: '音乐', icon: 'audio', dir: path.join(os.homedir(), 'Music') },
  ];
  const checked = await Promise.all(
    candidates.map(async (place) => {
      try {
        const st = await fsp.stat(place.dir);
        return st.isDirectory() ? place : null;
      } catch {
        return null;
      }
    }),
  );
  return checked.filter(Boolean);
}

/** 枚举本机盘符（Windows）或根目录（其他平台） */
async function listDrives() {
  if (process.platform !== 'win32') {
    return [{ name: '根目录', path: '/', icon: 'drive' }];
  }
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const found = await Promise.all(
    letters.map(async (letter) => {
      const root = `${letter}:\\`;
      try {
        const st = await fsp.stat(root);
        if (!st.isDirectory()) return null;
        return { name: letter === 'C' ? '系统盘 C:' : `${letter}:`, path: root, icon: 'drive', letter };
      } catch {
        return null;
      }
    }),
  );
  return found.filter(Boolean);
}

/** 清空目录缓存（整理/重命名后调用） */
function invalidate(dir) {
  if (!dir) {
    cache.clear();
    return;
  }
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${path.normalize(dir)}|`)) cache.delete(key);
  }
}

module.exports = {
  listDir,
  statPath,
  quickPlaces,
  listDrives,
  assertPath,
  invalidate,
  isHiddenName,
  MAX_ENTRIES,
};
