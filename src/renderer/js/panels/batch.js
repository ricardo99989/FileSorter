/**
 * panels/batch.js — 批量重命名 + 打包
 *
 * 改名是不可逆操作里最容易后悔的一种，所以这里强制"先预览再执行"：
 * 预览表把 原名 → 新名 一行行列出来，冲突的用红字标出并说明原因。
 */

import { icon } from '../icons.js';
import { esc, formatSize } from '../format.js';
import { t } from '../../../shared/i18n.mjs';

export function batchHtml(state) {
  const b = state.batch;
  const names = b.names || [];

  if (!names.length) {
    return `<div class="panel__head">
        <div style="flex:1"><div class="panel__title">${t('batch.title')}</div></div>
        <button class="icon-btn" data-batch-act="close">${icon('close', 15)}</button>
      </div>
      <div class="panel__body">
        <div class="empty-note">${t('batch.noSelection')}</div>
      </div>`;
  }

  const preview = b.preview;
  const rows = (preview?.items || [])
    .map(
      (item) => `<div class="preview-row${item.skipped ? ' is-conflict' : ''}">
        <span class="preview-row__from" title="${esc(item.from)}">${esc(item.from)}</span>
        <span class="preview-row__arrow">${icon('chevron', 11)}</span>
        <span class="preview-row__to" title="${esc(item.to)}">${esc(item.to || '—')}</span>
        ${item.reason ? `<span class="preview-row__note">${esc(item.reason)}</span>` : ''}
      </div>`,
    )
    .join('');

  return `<div class="panel__head">
      <div style="flex:1;min-width:0">
        <div class="panel__title">${t('batch.title')}</div>
        <div class="panel__sub">${t('batch.selected', { n: names.length })} · ${esc(
          formatSize(b.totalSize || 0),
        )}</div>
      </div>
      <button class="icon-btn" data-batch-act="close">${icon('close', 15)}</button>
    </div>

    <div class="panel__body">
      <div class="section">
        <div class="section__title" style="margin-bottom:6px">${t('batch.template')}</div>
        <div class="section__hint">${t('batch.templateHint')}</div>
        <div class="tpl-row">
          <input class="input" data-batch="template" value="${esc(b.template)}" placeholder="{name}_{n:3}" />
          <input class="input" data-batch="start" type="number" min="0" value="${esc(b.start)}" title="${t(
            'batch.start',
          )}" />
        </div>
        <div class="tpl-row">
          <input class="input" data-batch="find" value="${esc(b.find)}" placeholder="${t('batch.find')}" />
          <input class="input" data-batch="replace" value="${esc(b.replace)}" placeholder="${t('batch.replace')}" />
        </div>
      </div>

      ${
        preview
          ? `<div class="section">
              <div class="section__head">
                <span class="section__title">${t('batch.preview')}</span>
                <span class="section__spacer"></span>
                <span class="chip">${preview.changed} 个会变</span>
                ${preview.conflicted ? `<span class="chip chip--rose">${preview.conflicted} 个冲突</span>` : ''}
              </div>
              <div class="preview-table">${rows || `<div class="empty-note">${t('common.none')}</div>`}</div>
            </div>`
          : ''
      }

      <div class="section">
        <div class="section__head">${icon('archive', 13)}<span class="section__title">${t('batch.zip')}</span></div>
        <div class="section__hint">${t('batch.zipHint')}</div>
        <div style="display:flex;gap:7px">
          <input class="input" data-batch="password" type="password" placeholder="${t('batch.password')}" />
          <button class="btn btn--sm" data-batch-act="archive">${icon('archive', 12)}<span>${t(
            'batch.archive',
          )}</span></button>
        </div>
      </div>
    </div>

    <div class="panel__foot">
      <button class="btn btn--ghost" data-batch-act="close">${t('common.cancel')}</button>
      <span class="panel__spacer"></span>
      <button class="btn btn--primary" data-batch-act="rename" ${preview?.changed ? '' : 'disabled'}>
        ${icon('check', 14)}<span>${t('batch.run')}</span>
      </button>
    </div>`;
}
