/**
 * panels/history.js — 操作历史
 *
 * 每一批操作都能单独撤销或重做，不只"撤销上一次"。
 * 这是整个功能里最关键的一条：用户敢用，是因为随时能退回来。
 */

import { icon } from '../icons.js';
import { esc, relativeTime } from '../format.js';
import { t } from '../../../shared/i18n.mjs';

const ACTION_LABEL = {
  organize: '整理',
  rename: '重命名',
  batch: '打包',
};

export function historyHtml(state) {
  const items = state.historyList || [];
  const undoneCount = items.filter((item) => item.undone).length;

  const rows = items
    .map(
      (item) => `<div class="history-item${item.undone ? ' is-undone' : ''}">
        <span class="file-ico" data-tone="${item.undone ? 'slate' : 'blue'}" style="width:26px;height:26px;border-radius:8px">
          ${icon(item.undone ? 'undo' : 'check', 14)}
        </span>
        <div class="history-item__main">
          <div class="history-item__title">${esc(ACTION_LABEL[item.action] || item.action)} · ${t('history.count', {
            n: item.count,
          })}</div>
          <div class="history-item__meta" title="${esc(item.dir)}">${esc(item.dir)} · ${esc(relativeTime(item.ts))}</div>
        </div>
        <span class="history-item__badge">${item.undone ? t('history.undone') : t('history.done')}</span>
        ${
          item.undone
            ? `<button class="btn btn--sm btn--ghost" data-hist-act="redo" data-file="${esc(item.file)}">${icon(
                'redo',
                12,
              )}<span>${t('history.redo')}</span></button>`
            : `<button class="btn btn--sm btn--ghost" data-hist-act="undo" data-file="${esc(item.file)}">${icon(
                'undo',
                12,
              )}<span>${t('history.undo')}</span></button>`
        }
      </div>`,
    )
    .join('');

  return `<div class="panel__head">
      <div style="flex:1;min-width:0">
        <div class="panel__title">${t('history.title')}</div>
        <div class="panel__sub">${t('history.desc')}</div>
      </div>
      <button class="icon-btn" data-hist-act="close">${icon('close', 15)}</button>
    </div>

    <div class="panel__body">
      ${rows || `<div class="empty-note">${t('history.empty')}</div>`}
    </div>

    <div class="panel__foot">
      <button class="btn btn--ghost" data-hist-act="close">${t('common.close')}</button>
      <span class="panel__spacer"></span>
      ${
        items.length
          ? `<button class="btn btn--sm" data-hist-act="undo5">${icon('undo', 12)}<span>${t('history.undoAll')}</span></button>
             <button class="btn btn--sm btn--ghost" data-hist-act="clear">${icon('trash', 12)}<span>${t(
               'history.clear',
             )}</span></button>`
          : ''
      }
      ${undoneCount ? `<span class="chip">${undoneCount} 批可重做</span>` : ''}
    </div>`;
}
