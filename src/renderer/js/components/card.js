import { esc, formatSize, formatDate, icon } from '../api.js';

/**
 * 文件卡片。data-key 供 FLIP 重排匹配，data-path 供点击定位。
 * @param {{name:string,path:string,size:number,mtime:number}} file
 * @param {{icon:string,tone:string}|undefined} category
 */
export function fileCard(file, category) {
  const tone = category?.tone || 'gray';
  const glyph = category?.icon || 'file';
  return `
    <article class="card" data-key="${esc(file.path)}" data-path="${esc(file.path)}" title="${esc(file.path)}">
      <div class="card__icon tone-${tone}">${icon(glyph)}</div>
      <div class="card__name">${esc(file.name)}</div>
      <div class="card__meta">
        <span>${formatSize(file.size)}</span>
        <span>·</span>
        <span>${formatDate(file.mtime)}</span>
      </div>
    </article>`;
}

/**
 * 侧栏分类项。
 * @param {{id:string,name:string,icon:string,tone:string}} category
 */
export function navItem(category, count, active) {
  return `
    <button class="nav__item${active ? ' is-active' : ''}" data-category="${esc(category.id)}" type="button" role="tab"
            aria-selected="${active ? 'true' : 'false'}">
      <span class="nav__dot tone-${category.tone}"></span>
      <span>${esc(category.name)}</span>
      <span class="nav__count">${count}</span>
    </button>`;
}

/** 空状态：一句原因 + 一句下一步，不用插图分散注意力 */
export function emptyState(title, sub, glyph = 'folder') {
  return `
    <div class="empty">
      <div class="empty__orb">${icon(glyph)}</div>
      <div class="empty__title">${esc(title)}</div>
      <div class="empty__sub">${esc(sub)}</div>
    </div>`;
}

/** 载入中的占位骨架 */
export function skeletonGrid(count = 8) {
  return Array.from({ length: count }, () => '<div class="skeleton"></div>').join('');
}
