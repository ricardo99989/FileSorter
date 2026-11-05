import { ICON_NAMES } from './components/ui.js';

/**
 * api.js — 渲染层对 preload 桥的薄封装
 * 主进程统一返回 {ok, data|error}，这里只做解包与错误抛出，
 * 让业务代码拿到的是纯数据或异常，不用到处判断 ok。
 */

const bridge = window.filesorter;

function unwrap(response) {
  if (!response) throw new Error('主进程无响应');
  if (!response.ok) throw new Error(response.error || '操作失败');
  return response.data;
}

export const api = {
  getSettings: async () => unwrap(await bridge.settings.get()),
  saveSettings: async (patch) => unwrap(await bridge.settings.save(patch)),
  pickFolder: async () => unwrap(await bridge.pickFolder()),
  stats: async (dir) => unwrap(await bridge.stats(dir)),
  list: async (dir, categoryId) => unwrap(await bridge.list(dir, categoryId)),
  preview: async (dir) => unwrap(await bridge.preview(dir)),
  execute: async (dir, names) => unwrap(await bridge.execute(dir, names)),
  undo: async () => unwrap(await bridge.undo()),
  history: async () => unwrap(await bridge.history()),
  search: async (dir, keyword) => unwrap(await bridge.search(dir, keyword)),
  reveal: (target) => bridge.reveal(target),
  open: (target) => bridge.open(target),
  info: async () => unwrap(await bridge.info()),
  onProgress: (callback) => bridge.onProgress(callback),
};

/** 体积：1.2 MB / 860 KB */
export function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[index]}`;
}

/** 修改时间：今天 / 昨天 / 11-04 */
export function formatDate(ms) {
  if (!ms) return '—';
  const date = new Date(ms);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now.getTime() - 86400000).toDateString() === date.toDateString();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  if (sameDay) return `今天 ${hh}:${mm}`;
  if (yesterday) return `昨天 ${hh}:${mm}`;
  const M = String(date.getMonth() + 1).padStart(2, '0');
  const D = String(date.getDate()).padStart(2, '0');
  return `${M}-${D}`;
}

/** 文件名可能含 < > & 等字符，插入 DOM 前必须转义 */
export function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 内联 SVG 图标 */
export function icon(name) {
  const safe = ICON_NAMES.includes(name) ? name : 'file';
  return `<svg aria-hidden="true"><use href="#i-${safe}" /></svg>`;
}

/** 路径省略显示：C:\Users\x\Downloads → …\Downloads（保留尾部信息） */
export function shortPath(fullPath, keep = 2) {
  const parts = String(fullPath).split(/[\\/]/).filter(Boolean);
  if (parts.length <= keep) return fullPath;
  return `…\\${parts.slice(-keep).join('\\')}`;
}
