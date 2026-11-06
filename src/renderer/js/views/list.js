/**
 * views/list.js — 列表 / 网格的纯渲染函数
 *
 * 这里只做「数据 → HTML 字符串」，不碰 DOM 事件，也不读写 state。
 * 好处是同一个 entry 在列表和网格里走的是同一套排序、筛选、着色逻辑，
 * 不会出现"列表里显示黄色、网格里显示蓝色"这种不一致。
 */

import { icon, categoryIcon, categoryTone } from '../icons.js';
import { esc, formatDate, formatRelative, formatSize } from '../format.js';
import { t } from '../../../shared/i18n.mjs';

/** 缩略图白名单：只有这些格式 Chromium 能直接解码，其它的硬塞进 <img> 只会得到碎图 */
const THUMB_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'ico']);
const THUMB_MAX = 8 * 1024 * 1024;

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

/** 是否值得为这个条目生成缩略图 */
export function canThumb(entry) {
  return !entry.isDir && THUMB_EXTS.has(entry.ext) && entry.size > 0 && entry.size <= THUMB_MAX;
}

/**
 * 排序：文件夹永远在前，其余按用户选的字段。
 * 用 Intl.Collator 而不是 localeCompare，长列表下快一个数量级。
 */
export function sortEntries(entries, sort = { key: 'name', dir: 'asc' }) {
  const factor = sort.dir === 'desc' ? -1 : 1;
  const list = [...entries];

  list.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    switch (sort.key) {
      case 'size':
        return (a.size - b.size) * factor;
      case 'mtime':
        return (a.mtime - b.mtime) * factor;
      case 'ctime':
        return ((a.ctime || a.mtime) - (b.ctime || b.mtime)) * factor;
      case 'type': {
        const left = a.desc?.label || '';
        const right = b.desc?.label || '';
        return (collator.compare(left, right) || collator.compare(a.name, b.name)) * factor;
      }
      default:
        return collator.compare(a.name, b.name) * factor;
    }
  });
  return list;
}

/**
 * 本地筛选：文件名、类型名、那句说明里任意一处命中就算。
 * 用户记得住"那张图片"，不一定记得住文件名，所以说明也要参与匹配。
 */
export function filterEntries(entries, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return entries;
  const tokens = needle.split(/\s+/).filter(Boolean);
  return entries.filter((entry) => {
    const haystack = `${entry.name} ${entry.desc?.label || ''} ${entry.desc?.brief || ''}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

/** 表头 */
export function tableHeadHtml(sort) {
  const cell = (key, label, extra = '') => {
    const active = sort.key === key;
    const arrow = active ? icon(sort.dir === 'asc' ? 'sort' : 'sort-down', 11) : '';
    const cls = `tablehead__cell${extra}${active ? ' is-sorted' : ''}`;
    return `<div class="${cls}" data-sort="${key}">${esc(label)}${arrow}</div>`;
  };
  return [
    '<div class="tablehead__cell tablehead__cell--check"></div>',
    cell('name', t('col.name')),
    cell('type', t('col.type'), ' tablehead__cell--type'),
    cell('size', t('col.size'), ' tablehead__cell--right'),
    cell('mtime', t('col.mtime')),
    '<div class="tablehead__cell tablehead__cell--act"></div>',
  ].join('');
}

/** 一行 */
export function rowHtml(entry, options = {}) {
  const desc = entry.desc || { label: '文件', brief: '', category: 'other' };
  const tone = categoryTone(desc.category);
  const selected = options.selected ? ' is-selected' : '';
  const checked = options.checked ? ' is-checked' : '';
  const favorite = options.favorite ? ' is-fav' : '';

  const thumb = canThumb(entry)
    ? `<img src="file://${esc(entry.path.replace(/\\/g, '/'))}" alt="" loading="lazy" decoding="async" />`
    : icon(categoryIcon(desc.category), 17);

  const tags = (entry.tags || [])
    .slice(0, 4)
    .map((tag) => `<span class="tag-dot" data-color="${esc(tag.color)}" title="${esc(tag.name)}"></span>`)
    .join('');

  return `<div class="file-row${selected}${checked}${favorite}" data-path="${esc(entry.path)}" data-kind="row" draggable="true">
    <div class="file-row__check"><span class="checkbox${options.checked ? ' is-on' : ''}" data-check="${esc(entry.path)}"></span></div>
    <div class="file-row__name">
      <span class="file-ico" data-tone="${tone}">${thumb}</span>
      <div class="file-row__text">
        <div class="file-row__title">
          <span class="file-row__name-text" title="${esc(entry.name)}">${esc(entry.name)}</span>
          ${tags}
        </div>
        <div class="file-row__desc">${esc(desc.brief || desc.label || '')}</div>
      </div>
    </div>
    <div class="file-row__type">${esc(desc.label || '')}</div>
    <div class="file-row__size">${entry.isDir ? '—' : esc(formatSize(entry.size))}</div>
    <div class="file-row__mtime">${esc(formatRelative(entry.mtime))}</div>
    <div class="file-row__act">
      <button class="row-mini${options.favorite ? ' is-on' : ''}" data-act="fav" title="${t('menu.favorite')}">${icon(options.favorite ? 'star-fill' : 'star', 14)}</button>
      <button class="row-mini" data-act="preview" title="${t('menu.preview')}">${icon('eye', 14)}</button>
      <button class="row-mini" data-act="menu" title="更多">${icon('more', 14)}</button>
    </div>
  </div>`;
}

/** 网格卡片 */
export function gridCardHtml(entry, options = {}) {
  const desc = entry.desc || { label: '文件', brief: '', category: 'other' };
  const tone = categoryTone(desc.category);
  const selected = options.selected ? ' is-selected' : '';
  const checked = options.checked ? ' is-checked' : '';
  const favorite = options.favorite ? ' is-fav' : '';

  const thumb = canThumb(entry)
    ? `<img src="file://${esc(entry.path.replace(/\\/g, '/'))}" alt="" loading="lazy" decoding="async" />`
    : icon(categoryIcon(desc.category), 30);

  const tags = (entry.tags || [])
    .slice(0, 3)
    .map((tag) => `<span class="tag-dot" data-color="${esc(tag.color)}"></span>`)
    .join('');

  return `<div class="grid-card${selected}${checked}${favorite}" data-path="${esc(entry.path)}" data-kind="card" draggable="true">
    <span class="grid-card__check"><span class="checkbox${options.checked ? ' is-on' : ''}" data-check="${esc(entry.path)}"></span></span>
    <button class="grid-card__fav${options.favorite ? ' is-on' : ''}" data-act="fav" title="${t('menu.favorite')}">${icon(options.favorite ? 'star-fill' : 'star', 13)}</button>
    <div class="grid-card__thumb file-ico" data-tone="${tone}">${thumb}</div>
    <div class="grid-card__name" title="${esc(entry.name)}">${esc(entry.name)}</div>
    <div class="grid-card__desc">${esc(desc.brief || desc.label || '')}</div>
    <div class="grid-card__meta">
      <span>${esc(desc.label || '')}</span>
      <span>·</span>
      <span>${entry.isDir ? '—' : esc(formatSize(entry.size))}</span>
      <span class="grid-card__tags">${tags}</span>
    </div>
  </div>`;
}

/** 空状态 / 错误态 */
export function stateHtml(kind, options = {}) {
  const map = {
    empty: { icon: 'folder', title: t('state.empty.title'), desc: t('state.empty.desc'), acts: [] },
    fav: { icon: 'star', title: t('scope.fav'), desc: t('scope.fav.empty'), acts: [] },
    recent: { icon: 'ring', title: t('scope.recent'), desc: t('scope.recent.hint'), acts: [] },
    search: {
      icon: 'search',
      title: options.deep ? t('state.searchDeep.title') : t('state.search.title'),
      desc: t(options.deep ? 'state.searchDeep.desc' : 'state.search.desc', { query: options.query || '' }),
      acts: [{ act: 'clear', label: t('state.clear') }],
    },
    permission: {
      icon: 'lock',
      title: t('state.permission.title'),
      desc: t('state.permission.desc'),
      acts: [{ act: 'up', label: t('state.up') }],
    },
    missing: {
      icon: 'alert',
      title: t('state.missing.title'),
      desc: t('state.missing.desc'),
      acts: [{ act: 'retry', label: t('state.retry') }],
    },
    error: {
      icon: 'alert',
      title: t('state.error.title'),
      desc: t('state.error.desc', { message: options.message || '' }),
      acts: [{ act: 'retry', label: t('state.retry') }],
    },
  };
  const spec = map[kind] || map.error;
  const actions = spec.acts.length
    ? `<div class="state__actions">${spec.acts
        .map((item) => `<button class="btn btn--sm" data-state-act="${item.act}">${esc(item.label)}</button>`)
        .join('')}</div>`
    : '';
  return `<div class="state__icon">${icon(spec.icon, 24)}</div>
    <div class="state__title">${esc(spec.title)}</div>
    <div class="state__desc">${esc(spec.desc)}</div>
    ${actions}`;
}

/** 骨架屏 */
export function skeletonHtml(count = 10) {
  return Array.from({ length: count })
    .map(
      () => `<div class="skeleton-row">
        <span class="sk-ico"></span>
        <span class="sk-name"></span>
        <span class="sk-meta"></span>
        <span class="sk-date"></span>
      </div>`,
    )
    .join('');
}

/** 状态栏 */
export function statusHtml(state) {
  const { counts, entries, watching } = state;
  const files = counts?.files ?? entries.filter((entry) => !entry.isDir).length;
  const dirs = counts?.dirs ?? entries.filter((entry) => entry.isDir).length;
  const size = counts?.size ?? entries.reduce((sum, entry) => sum + (entry.isDir ? 0 : entry.size), 0);

  const chips = [];
  if (state.cloud) {
    chips.push(`<span class="statusbar__chip">${icon('globe', 11)} ${esc(state.cloud.name)} 同步目录</span>`);
  }
  if (watching?.active) {
    chips.push(`<span class="statusbar__chip statusbar__chip--live">${icon('ring', 11)} 实时监听</span>`);
  }
  if (counts?.unreadable) {
    chips.push(`<span class="statusbar__chip">${counts.unreadable} 项读不到</span>`);
  }
  if (state.listing?.truncated) {
    chips.push('<span class="statusbar__chip">仅显示前 20000 项</span>');
  }

  return `<span>${esc(t('app.items', { n: files + dirs }))}</span>
    <span class="statusbar__dot"></span>
    <span>${dirs} 个文件夹 · ${files} 个文件</span>
    <span class="statusbar__dot"></span>
    <span>${esc(formatSize(size))}</span>
    <span class="statusbar__spacer"></span>
    ${chips.join('')}`;
}

export { THUMB_EXTS, formatDate };
