/**
 * format.js — 纯格式化工具
 * 这里全部是无副作用的纯函数，方便单测覆盖。
 */

import { t } from '../../shared/i18n.mjs';

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/** 人类可读体积，1024 进制，保留一位小数但不展示无意义的 .0 */
export function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
  return `${text} ${units[unit]}`;
}

function pad(n) {
  return n < 10 ? `0${n}` : String(n);
}

/** 2026-11-05 17:03 */
export function formatDate(ms) {
  const value = Number(ms);
  if (!value || value <= 0) return '—';
  const d = new Date(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

/** 今天 09:12 / 昨天 18:40 / 10-28 */
export function formatRelative(ms) {
  const value = Number(ms);
  if (!value || value <= 0) return '—';
  const now = new Date();
  const d = new Date(value);
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  ) {
    return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (d.getFullYear() === now.getFullYear()) {
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Windows 路径 → 可在 <img src> 里用的 file:// URL。
 * 只对路径段做编码，盘符的冒号必须保留，否则 Chromium 解析失败。
 */
export function fileUrl(target) {
  if (!target) return '';
  const normalized = String(target).replace(/\\/g, '/');
  const segments = normalized.split('/');
  return `file:///${segments
    .map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment)))
    .join('/')}`;
}

export function debounce(fn, wait = 120) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 相对时间：刚刚 / 12 分钟前 / 3 小时前 / 5 天前 / 2026-09-12
 * 面板里的操作记录用它，比绝对时间更好读。
 */
export function relativeTime(ms) {
  const value = Number(ms);
  if (!value || value <= 0) return '—';
  const diff = Date.now() - value;
  if (diff < 60_000) return t('time.justNow');
  if (diff < 3_600_000) return t('time.minutesAgo', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('time.hoursAgo', { n: Math.floor(diff / 3_600_000) });
  if (diff < 7 * 86_400_000) return t('time.daysAgo', { n: Math.floor(diff / 86_400_000) });
  return formatDate(value).slice(0, 10);
}

/** 时刻：2026-11-05 09:00，定时任务展示用 */
export function formatClock(ms) {
  const value = Number(ms);
  if (!value || value <= 0) return '—';
  const d = new Date(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

/** 路径缩短显示：把用户主目录换成 ~，长路径只留末尾两段 */
export function shortPath(target, home) {
  let text = String(target || '');
  if (home && text.toLowerCase().startsWith(String(home).toLowerCase())) {
    text = `~${text.slice(String(home).length)}`;
  }
  return text;
}

/** 当前时间段的问候语，用在空状态里，避免文案过于机械 */
export function greeting() {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '午安';
  if (hour < 18) return '下午好';
  return '晚上好';
}
