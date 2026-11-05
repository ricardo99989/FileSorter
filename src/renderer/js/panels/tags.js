/**
 * panels/tags.js — 标签检索
 *
 * 左边是标签，右边是结果。多选标签默认 AND（"重要" + "待报销"），
 * 因为筛选场景里"同时具备"远比"任一满足"常用；想要 OR 有一个开关。
 */

import { icon, categoryTone } from '../icons.js';
import { esc, formatSize, relativeTime } from '../format.js';
import { t } from '../../../shared/i18n.mjs';

export function tagsHtml(state) {
  const panel = state.tagsPanel;
  const tags = state.tagList || [];
  const active = panel.active || new Set();
  const results = panel.results || [];

  const list = tags
    .map(
      (tag) => `<button class="tag-item${active.has(tag.id) ? ' is-active' : ''}" data-tag-pick="${esc(tag.id)}">
        <span class="tag-dot" data-color="${esc(tag.color)}"></span>
        <span>${esc(tag.name)}</span>
        <span class="tag-item__count">${tag.count}</span>
      </button>`,
    )
    .join('');

  const rows = results
    .map(
      (item) => `<div class="tag-result-item" data-path="${esc(item.path)}">
        <span class="tag-dot" data-color="${esc(item.tags?.[0]?.color || 'blue')}"></span>
        <span class="tag-result-item__name" title="${esc(item.path)}">${esc(item.name)}</span>
        <span class="tag-result-item__dir">${esc(item.dir)}</span>
        <span style="flex:none;font-size:11px;color:var(--ink-4)">${esc(formatSize(item.size))}</span>
        <span style="flex:none;font-size:11px;color:var(--ink-4)">${esc(relativeTime(item.mtime))}</span>
      </div>`,
    )
    .join('');

  return `<div class="panel__head">
      <div style="flex:1;min-width:0">
        <div class="panel__title">${t('tags.title')}</div>
        <div class="panel__sub">${t('tags.desc')}</div>
      </div>
      <button class="icon-btn" data-tags-act="close">${icon('close', 15)}</button>
    </div>

    <div class="panel__body" style="display:flex;flex-direction:column;min-height:0">
      <div class="section__head" style="margin-bottom:8px">
        <span class="section__title">${t('tags.all')}</span>
        <span class="section__spacer"></span>
        <div class="segment">
          <button data-tags-mode="all" class="${panel.matchAll ? 'is-active' : ''}">${t('tags.matchAll')}</button>
          <button data-tags-mode="any" class="${panel.matchAll ? '' : 'is-active'}">${t('tags.matchAny')}</button>
        </div>
      </div>

      ${
        tags.length
          ? `<div class="tags-split">
              <div class="tags-side">${list}</div>
              <div class="tags-result">
                ${
                  active.size
                    ? rows || `<div class="empty-note">${t('tags.noResult')}</div>`
                    : `<div class="empty-note">${t('tags.empty')}</div>`
                }
              </div>
            </div>`
          : `<div class="empty-note">${t('settings.tags.empty')}</div>`
      }
    </div>`;
}
