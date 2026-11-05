/**
 * panels/dupes.js — 重复文件
 *
 * 默认「每组保留最老的那份」，其余勾选待删。
 * 删除走系统回收站，所以这里可以放心地把默认值设成"全选其余"。
 */

import { icon } from '../icons.js';
import { esc, formatSize } from '../format.js';
import { t } from '../../../shared/i18n.mjs';

export function dupesHtml(state) {
  const d = state.dupes;

  if (d.loading) {
    const pct = d.progress?.total ? Math.round((d.progress.done / d.progress.total) * 100) : 0;
    return `<div class="panel__head">
        <div style="flex:1"><div class="panel__title">${t('dupes.title')}</div></div>
        <button class="icon-btn" data-dupe-act="close">${icon('close', 15)}</button>
      </div>
      <div class="panel__body">
        <div class="empty-note">${esc(d.progress?.message || t('dupes.scanning'))}</div>
        <div class="progress"><div class="progress__bar" style="width:${pct}%"></div></div>
      </div>`;
  }

  const result = d.result;
  const selectedCount = d.selected.size;
  const selectedSize = result
    ? result.groups
        .flatMap((group) => group.items.filter((item) => d.selected.has(item.path)))
        .reduce((sum, item) => sum + item.size, 0)
    : 0;

  const groupsHtml = (result?.groups || [])
    .map(
      (group, index) => `<div class="dupe-group">
        <div class="dupe-group__head">
          ${icon('dupe', 14)}
          <strong>${esc(formatSize(group.size))}</strong>
          <span style="color:var(--ink-4)">× ${group.count}</span>
          <span class="section__spacer"></span>
          <span class="chip">可释放 ${esc(formatSize(group.wasted))}</span>
        </div>
        ${group.items
          .map(
            (item, itemIndex) => `<div class="dupe-item${itemIndex === 0 ? ' is-keep' : ''}">
              <span class="checkbox${d.selected.has(item.path) ? ' is-on' : ''}" data-dupe-check="${esc(item.path)}"></span>
              <span class="dupe-item__path" title="${esc(item.path)}">${esc(item.dir)}\\<b>${esc(item.name)}</b></span>
              <span class="dupe-item__size">${
                itemIndex === 0 ? `<span class="chip chip--sage">${t('dupes.keep')}</span>` : esc(formatSize(item.size))
              }</span>
            </div>`,
          )
          .join('')}
      </div>`,
    )
    .join('');

  return `<div class="panel__head">
      <div style="flex:1;min-width:0">
        <div class="panel__title">${t('dupes.title')}</div>
        <div class="panel__sub">${t('dupes.desc')}</div>
      </div>
      <button class="icon-btn" data-dupe-act="close">${icon('close', 15)}</button>
    </div>

    <div class="panel__body">
      <div class="metrics">
        <div class="metric">
          <div class="metric__label">${t('dupes.groups', { n: result?.groups.length ?? 0 })}</div>
          <div class="metric__value">${result?.groups.length ?? 0}</div>
        </div>
        <div class="metric">
          <div class="metric__label">${t('dupes.wasted', { size: formatSize(result?.totalWasted || 0) })}</div>
          <div class="metric__value">${esc(formatSize(result?.totalWasted || 0))}</div>
        </div>
        <div class="metric">
          <div class="metric__label">${t('common.selectAll')}</div>
          <div class="metric__value">${selectedCount}</div>
          <div class="metric__hint">${esc(formatSize(selectedSize))}</div>
        </div>
      </div>

      ${
        result && !result.groups.length
          ? `<div class="empty-note"><b>${t('dupes.empty')}</b><br />${t('dupes.emptyDesc')}</div>`
          : groupsHtml
      }

      ${result?.truncated ? `<div class="section__hint">${t('space.truncated', { n: result.scanned })}</div>` : ''}
    </div>

    <div class="panel__foot">
      <button class="btn btn--ghost" data-dupe-act="close">${t('common.close')}</button>
      <span class="panel__spacer"></span>
      ${
        result?.groups.length
          ? `<button class="btn btn--danger" data-dupe-act="clean" ${selectedCount ? '' : 'disabled'}>
              ${icon('trash', 13)}<span>${t('dupes.cleanAll')} (${selectedCount})</span>
            </button>`
          : `<button class="btn btn--primary" data-dupe-act="scan">${icon('search', 13)}<span>${t('dupes.scan')}</span></button>`
      }
    </div>`;
}
