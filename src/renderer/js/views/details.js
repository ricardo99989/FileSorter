/**
 * views/details.js — 右侧详情栏
 *
 * 一屏之内回答三个问题：这是什么、长什么样、在哪。
 * 顺序是有意为之：先给结论（说明），再给证据（预览），最后给数据（时间/路径）。
 */

import { icon, categoryIcon, categoryTone } from '../icons.js';
import { esc, formatDate, formatSize } from '../format.js';
import { previewHtml } from './preview.js';
import { t } from '../../../shared/i18n.mjs';

/**
 * 说明里的 `detail` 通常以 `brief` 开头，直接拼会读两遍，
 * 这里把重复的首句剥掉，只留补充信息。
 */
function extraOf(detail) {
  if (!detail) return '';
  const brief = detail.brief || '';
  const text = detail.detail || '';
  if (brief && text.startsWith(brief)) return text.slice(brief.length).trim();
  return text && text !== brief ? text : '';
}

/** 标签区 */
function tagsHtml(entry, tagMap) {
  const owned = tagMap?.[entry.path] || entry.tags || [];
  const chips = owned
    .map(
      (tag) => `<span class="tag-chip">
        <span class="tag-dot" data-color="${esc(tag.color)}"></span>${esc(tag.name)}
        <button data-tag-remove="${esc(tag.id)}" title="${t('common.delete')}">${icon('close', 10)}</button>
      </span>`,
    )
    .join('');
  return `<div class="detail-section">
    <div class="detail-section__title">${icon('tag', 12)}<span>${t('detail.tags')}</span></div>
    <div class="detail-tags">
      ${chips || `<span class="detail-text" style="color:var(--ink-4);font-size:11.5px">${t('detail.noTag')}</span>`}
      <button class="tag-add" data-tag-add="1">+ ${t('detail.addTag')}</button>
    </div>
  </div>`;
}

export function detailsHtml(state) {
  const entry = state.selectedEntry;
  if (!entry) {
    return `<div class="detail-empty">
      <div class="detail-empty__icon">${icon('sparkle', 22)}</div>
      <div>${esc(t('detail.empty'))}</div>
    </div>`;
  }

  const desc = entry.desc || {};
  const detail = state.detail;
  const tone = categoryTone(desc.category);
  const extra = extraOf(detail);

  /**
   * 主进程给的是 { tag, text, weight } 结构，不是纯字符串。
   * 早先这里直接 esc(hint) 会渲染出「[object Object]」，所以统一走取值函数。
   *
   * 另外要剔除与正文重复的那一条：列表里的「一句话」本身就是权重最高的一条提示
   * （见 describe.js 的 summarize），详情栏若再列一遍，同一句话会出现两次。
   */
  const briefText = String(desc.brief || '');
  const hints = (detail?.hints || [])
    .map((hint) => {
      if (!hint) return null;
      const text = typeof hint === 'string' ? hint : String(hint.text || '');
      const tag = typeof hint === 'string' ? '' : String(hint.tag || '');
      return text ? { text, tag } : null;
    })
    .filter((hint) => hint && hint.text !== briefText);

  return `<div class="details__scroll">
    <div class="detail-hero">
      <div class="detail-hero__ico file-ico" data-tone="${tone}">${icon(categoryIcon(desc.category), 26)}</div>
      <div class="detail-hero__name">${esc(entry.name)}</div>
      <div class="detail-hero__label">${esc(detail?.label || desc.label || '')}</div>
    </div>

    <div class="detail-actions">
      <button class="btn btn--sm" data-detail-act="open">${icon('open', 13)}<span>${t('detail.open')}</span></button>
      <button class="btn btn--sm" data-detail-act="reveal">${icon('locate', 13)}<span>${t('detail.reveal')}</span></button>
      <button class="btn btn--sm btn--ghost" data-detail-act="copy" title="${t('detail.copy')}">${icon('copy', 13)}</button>
    </div>

    <div class="detail-section">
      <div class="detail-section__title">${icon('sparkle', 12)}<span>${t('detail.what')}</span></div>
      <div class="detail-text">${esc(briefText)}${extra ? ` ${esc(extra)}` : ''}</div>
      ${hints
        .map(
          (hint) =>
            `<div class="detail-hint">${icon('info', 13)}<span>${
              hint.tag ? `<b class="detail-hint__tag">${esc(hint.tag)}</b>` : ''
            }${esc(hint.text)}</span></div>`,
        )
        .join('')}
    </div>

    <div class="detail-section">
      <div class="detail-section__title">${icon('eye', 12)}<span>${t('preview.title')}</span></div>
      ${previewHtml(state.preview, entry)}
    </div>

    ${tagsHtml(entry, state.tagMap)}

    <div class="detail-section">
      <div class="detail-section__title">${icon('info', 12)}<span>${t('detail.info')}</span></div>
      <dl class="detail-kv">
        <dt>${t('col.type')}</dt><dd>${esc(desc.label || '—')}</dd>
        <dt>${t('col.size')}</dt><dd>${entry.isDir ? '—' : esc(formatSize(entry.size))}</dd>
        <dt>${t('col.mtime')}</dt><dd>${esc(formatDate(entry.mtime))}</dd>
        <dt>${t('col.ctime')}</dt><dd>${esc(formatDate(entry.ctime || entry.mtime))}</dd>
        <dt>${t('detail.path')}</dt><dd>${esc(entry.path)}</dd>
      </dl>
    </div>
  </div>`;
}
