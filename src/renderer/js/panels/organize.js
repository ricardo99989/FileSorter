/**
 * panels/organize.js — 整理预览
 *
 * 这是整个应用里**最需要让人放心**的一块：
 * 所以它先给结论（将移动 N 个、跳过 M 个），再给逐条明细，
 * 而且每一条都能单独取消勾选 —— 用户不必为了排除一个文件而放弃整次整理。
 */

import { icon, categoryIcon, categoryTone } from '../icons.js';
import { esc, formatSize } from '../format.js';
import { t } from '../../../shared/i18n.mjs';

const PER_GROUP = 8;

function groupItems(items) {
  const map = new Map();
  for (const item of items) {
    const bucket = map.get(item.folder) || { folder: item.folder, items: [], size: 0 };
    bucket.items.push(item);
    bucket.size += item.size;
    map.set(item.folder, bucket);
  }
  return [...map.values()].sort((a, b) => b.items.length - a.items.length);
}

function itemRow(item, checked) {
  return `<div class="dupe-item" style="border-top:1px solid var(--glass-edge)">
    <span class="checkbox${checked ? ' is-on' : ''}" data-org-check="${esc(item.name)}"></span>
    <span class="dupe-item__path" title="${esc(item.path)}"><b>${esc(item.name)}</b></span>
    <span class="dupe-item__size">${esc(formatSize(item.size))}</span>
  </div>`;
}

export function organizeHtml(context) {
  const { organize, cloudHint } = context;

  if (organize.loading) {
    return `<div class="panel__head">
        <div><div class="panel__title">${t('organize.title')}</div>
        <div class="panel__sub">${esc(context.dir || '')}</div></div>
      </div>
      <div class="panel__body"><div class="empty-note">${t('organize.scanning')}</div></div>`;
  }

  if (organize.error) {
    return `<div class="panel__head">
        <div><div class="panel__title">${t('organize.title')}</div></div>
      </div>
      <div class="panel__body"><div class="empty-note">${esc(organize.error)}</div></div>`;
  }

  const plan = organize.plan;
  if (!plan) return '';

  const selectedCount = organize.selected.size;
  const totalSize = plan.items
    .filter((item) => organize.selected.has(item.name))
    .reduce((sum, item) => sum + item.size, 0);

  const groups = groupItems(plan.items);
  const body = groups
    .map((group) => {
      const expanded = organize.expanded.has(group.folder);
      const visible = expanded ? group.items : group.items.slice(0, PER_GROUP);
      const selectedInGroup = group.items.filter((item) => organize.selected.has(item.name)).length;
      const allSelected = selectedInGroup === group.items.length;
      const tone = categoryTone(group.items[0]?.categoryId || 'other');

      return `<div class="section" style="margin-bottom:14px">
        <div class="section__head">
          <span class="checkbox${allSelected ? ' is-on' : ''}" data-org-group="${esc(group.folder)}"></span>
          <span class="file-ico" data-tone="${tone}" style="width:24px;height:24px;border-radius:7px">${icon(
            categoryIcon(group.items[0]?.categoryId || 'other'),
            14,
          )}</span>
          <span class="section__title">${esc(group.folder)}</span>
          <span class="section__hint" style="margin:0">${group.items.length} 个 · ${esc(formatSize(group.size))}</span>
          <span class="section__spacer"></span>
          ${selectedInGroup !== group.items.length ? `<span class="chip">已选 ${selectedInGroup}</span>` : ''}
        </div>
        <div style="border-radius:11px;border:1px solid var(--glass-stroke);overflow:hidden">
          ${visible.map((item) => itemRow(item, organize.selected.has(item.name))).join('')}
        </div>
        ${
          group.items.length > PER_GROUP
            ? `<button class="btn btn--sm btn--ghost" data-org-act="expand" data-folder="${esc(group.folder)}" style="margin-top:6px">
                ${expanded ? '收起' : `展开其余 ${group.items.length - PER_GROUP} 项`}
              </button>`
            : ''
        }
      </div>`;
    })
    .join('');

  const skippedHtml = plan.skipped.length
    ? `<div class="section">
        <div class="section__head">
          ${icon('lock', 13)}
          <span class="section__title">${t('organize.skipTitle')}</span>
          <span class="section__hint" style="margin:0">${plan.skipped.length} 个</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:5px">
          ${plan.skipped
            .slice(0, 12)
            .map((item) => `<span class="chip" title="${esc(item.reason)}">${esc(item.name)}</span>`)
            .join('')}
          ${plan.skipped.length > 12 ? `<span class="chip">…还有 ${plan.skipped.length - 12} 个</span>` : ''}
        </div>
      </div>`
    : '';

  const emptyState = !plan.items.length
    ? `<div class="empty-note">${t('organize.empty')}</div>`
    : '';

  return `<div class="panel__head">
      <div style="flex:1;min-width:0">
        <div class="panel__title">${t('organize.title')}</div>
        <div class="panel__sub" title="${esc(plan.dir)}">${esc(plan.dir)}</div>
      </div>
      <button class="icon-btn" data-org-act="close" aria-label="${t('common.close')}">${icon('close', 15)}</button>
    </div>

    <div class="panel__body">
      ${cloudHint ? `<div class="detail-hint" style="margin-bottom:14px">${icon('globe', 13)}<span>${esc(
        t('organize.cloudWarn', { name: cloudHint }),
      )}</span></div>` : ''}

      <div class="metrics">
        <div class="metric">
          <div class="metric__label">${t('organize.move')}</div>
          <div class="metric__value">${selectedCount}</div>
          <div class="metric__hint">共 ${plan.items.length} 个</div>
        </div>
        <div class="metric">
          <div class="metric__label">${t('organize.size')}</div>
          <div class="metric__value">${esc(formatSize(totalSize))}</div>
        </div>
        <div class="metric">
          <div class="metric__label">${t('organize.skipped')}</div>
          <div class="metric__value">${plan.skipped.length}</div>
          <div class="metric__hint">系统文件 / 隐藏 / 排除名单</div>
        </div>
      </div>

      <div class="section__head">
        <button class="btn btn--sm btn--ghost" data-org-act="toggle-all">
          ${selectedCount === plan.items.length ? t('organize.selectNone') : t('organize.selectAll')}
        </button>
        <span class="section__spacer"></span>
        <span class="section__hint" style="margin:0">${t('organize.selected', { n: selectedCount })}</span>
      </div>

      ${emptyState}
      ${body}
      ${skippedHtml}

      ${
        organize.busy
          ? `<div class="progress"><div class="progress__bar" style="width:${Math.round(
              ((organize.progress?.index || 0) / Math.max(1, organize.progress?.total || 1)) * 100,
            )}%"></div></div>
            <div class="setting__hint">${t('organize.running')} ${esc(organize.progress?.name || '')}</div>`
          : ''
      }
    </div>

    <div class="panel__foot">
      <button class="btn btn--ghost" data-org-act="close">${t('common.cancel')}</button>
      <span class="panel__spacer"></span>
      <button class="btn btn--primary" data-org-act="run" ${!selectedCount || organize.busy ? 'disabled' : ''}>
        ${icon('check', 14)}<span>${t('organize.run')}</span>
      </button>
    </div>`;
}
