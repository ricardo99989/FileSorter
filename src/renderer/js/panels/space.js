/**
 * panels/space.js — 空间分析
 *
 * 饼图用 conic-gradient 拼，不引图表库：只有一个环，用不上坐标系和动画系统。
 * 图例里给出绝对值，避免"只有百分比看不出到底多大"。
 */

import { icon } from '../icons.js';
import { esc, formatSize } from '../format.js';
import { t } from '../../../shared/i18n.mjs';

/** 分类 → 展示色（和列表里的图标色保持一致，方便对照） */
const TONE_VAR = {
  image: 'var(--tone-blue)',
  video: 'var(--tone-violet)',
  document: 'var(--tone-teal)',
  audio: 'var(--tone-slate)',
  archive: 'var(--tone-slate)',
  code: 'var(--tone-slate)',
  program: 'var(--tone-slate)',
  other: 'var(--tone-mist)',
};

/** 拼 conic-gradient：每段的角度按体积占比累加 */
function pieStyle(list, total) {
  if (!total) return 'background: var(--glass-edge)';
  let cursor = 0;
  const stops = [];
  for (const item of list) {
    const sweep = (item.size / total) * 360;
    const color = TONE_VAR[item.id] || 'var(--ink-4)';
    stops.push(`${color} ${cursor.toFixed(2)}deg ${(cursor + sweep).toFixed(2)}deg`);
    cursor += sweep;
  }
  // 兜底：极端情况下留一点空隙，避免出现 NaN
  if (cursor < 360) stops.push(`var(--glass-edge) ${cursor.toFixed(2)}deg 360deg`);
  return `background: conic-gradient(${stops.join(', ')})`;
}

export function spaceHtml(state) {
  const s = state.space;

  if (s.loading) {
    return `<div class="panel__head">
        <div style="flex:1"><div class="panel__title">${t('space.title')}</div></div>
        <button class="icon-btn" data-space-act="close">${icon('close', 15)}</button>
      </div>
      <div class="panel__body">
        <div class="empty-note">${esc(s.progress?.message || t('common.loading'))}</div>
      </div>`;
  }

  const result = s.result;
  if (!result) {
    return `<div class="panel__head">
        <div style="flex:1"><div class="panel__title">${t('space.title')}</div></div>
        <button class="icon-btn" data-space-act="close">${icon('close', 15)}</button>
      </div>
      <div class="panel__body"><div class="empty-note">${t('space.desc')}</div></div>`;
  }

  const total = result.total || 1;
  const legend = result.byCategory
    .filter((item) => item.size > 0)
    .map(
      (item) => `<div class="legend__row">
        <span class="legend__swatch" style="background:${TONE_VAR[item.id] || 'var(--ink-4)'}"></span>
        <span class="legend__name">${esc(item.name)}</span>
        <span class="legend__value">${esc(formatSize(item.size))}</span>
      </div>`,
    )
    .join('');

  const biggest = result.largest
    .map(
      (item) => `<div class="bar-row">
        <div class="bar-row__main">
          <div class="bar-row__label">
            <span title="${esc(item.path)}">${esc(item.name)}</span>
            <span>${esc(item.path.replace(/\\[^\\]+$/, ''))}</span>
          </div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.max(
            4,
            Math.round((item.size / result.largest[0].size) * 100),
          )}%"></div></div>
        </div>
        <div class="bar-row__size">${esc(formatSize(item.size))}</div>
      </div>`,
    )
    .join('');

  const folders = result.byFolder
    .map(
      (item) => `<div class="bar-row">
        <div class="bar-row__main">
          <div class="bar-row__label">
            <span>${esc(item.name)}</span>
            <span>${item.count} 个</span>
          </div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.max(
            3,
            Math.round((item.size / (result.byFolder[0]?.size || 1)) * 100),
          )}%"></div></div>
        </div>
        <div class="bar-row__size">${esc(formatSize(item.size))}</div>
      </div>`,
    )
    .join('');

  return `<div class="panel__head">
      <div style="flex:1;min-width:0">
        <div class="panel__title">${t('space.title')}</div>
        <div class="panel__sub" title="${esc(result.dir)}">${esc(result.dir)}</div>
      </div>
      <button class="icon-btn" data-space-act="close">${icon('close', 15)}</button>
    </div>

    <div class="panel__body">
      <div class="pie-wrap">
        <div class="pie" style="${pieStyle(result.byCategory.filter((i) => i.size > 0), total)}">
          <div class="pie__center">${esc(formatSize(result.total))}<small>${t('space.files', {
            n: result.count,
          })}</small></div>
        </div>
        <div class="legend">${legend}</div>
      </div>

      <div class="section">
        <div class="section__head">${icon('layer', 13)}<span class="section__title">${t('space.biggest')}</span></div>
        ${biggest || `<div class="empty-note">${t('common.none')}</div>`}
      </div>

      <div class="section">
        <div class="section__head">${icon('folder', 13)}<span class="section__title">${t('space.folders')}</span></div>
        ${folders || `<div class="empty-note">${t('common.none')}</div>`}
      </div>

      ${
        result.truncated
          ? `<div class="section__hint">${t('space.truncated', { n: result.count })}</div>`
          : ''
      }
    </div>

    <div class="panel__foot">
      <button class="btn btn--ghost" data-space-act="close">${t('common.close')}</button>
      <span class="panel__spacer"></span>
      <button class="btn btn--sm" data-space-act="refresh">${icon('refresh', 12)}<span>${t('toolbar.refresh')}</span></button>
    </div>`;
}
