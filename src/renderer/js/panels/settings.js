/**
 * panels/settings.js — 设置（多页签）
 *
 * 页签按「用户想改什么」来分，而不是按代码模块分：
 * 外观 / 规则 / 排除 / 定时 / 标签 / 插件 / 关于。
 *
 * 输入类控件统一用 change 事件（失焦才提交），这样重绘整页时
 * 不会把用户正在打的字打断。开关和分段控件用 click，立刻生效。
 */

import { icon, categoryIcon, categoryTone } from '../icons.js';
import { esc, formatClock } from '../format.js';
import { t } from '../../../shared/i18n.mjs';

/** 仓库地址：设置 → 关于 里的「反馈问题 / 更新日志」都跳这里。 */
export const REPO_URL = 'https://github.com/ricardo99989/FileSorter';

const TABS = [
  { id: 'appearance', label: 'settings.tab.appearance', icon: 'sun' },
  { id: 'rules', label: 'settings.tab.rules', icon: 'filter' },
  { id: 'exclude', label: 'settings.tab.exclude', icon: 'lock' },
  { id: 'schedule', label: 'settings.tab.schedule', icon: 'ring' },
  { id: 'tags', label: 'settings.tab.tags', icon: 'tag' },
  { id: 'plugins', label: 'settings.tab.plugins', icon: 'plugin' },
  { id: 'about', label: 'settings.tab.about', icon: 'info' },
];

/** 字段 → 可用的比较方式 */
const OPS_BY_FIELD = {
  name: ['contains', 'notContains', 'equals', 'regex'],
  ext: ['equals', 'notContains'],
  size: ['gt', 'lt', 'between'],
  mtime: ['within', 'older'],
  ctime: ['within', 'older'],
};

function segment(name, options, value) {
  return `<div class="segment" data-segment="${name}">
    ${options
      .map(
        (option) =>
          `<button type="button" data-value="${esc(option.value)}" class="${
            String(option.value) === String(value) ? 'is-active' : ''
          }">${esc(option.label)}</button>`,
      )
      .join('')}
  </div>`;
}

function switchRow(key, label, hint, checked) {
  return `<div class="setting">
    <div class="setting__main">
      <div class="setting__label">${esc(label)}</div>
      ${hint ? `<div class="setting__hint">${esc(hint)}</div>` : ''}
    </div>
    <div class="setting__control">
      <button class="switch${checked ? ' is-on' : ''}" data-toggle="${key}" role="switch" aria-checked="${Boolean(
        checked,
      )}"></button>
    </div>
  </div>`;
}

function sliderRow(key, label, hint, value, min, max) {
  return `<div class="setting">
    <div class="setting__main">
      <div class="setting__label">${esc(label)}</div>
      ${hint ? `<div class="setting__hint">${esc(hint)}</div>` : ''}
    </div>
    <div class="setting__control">
      <input class="slider" type="range" min="${min}" max="${max}" step="1"
             value="${value}" data-slider="${key}"
             aria-label="${esc(label)}" />
      <span class="slider__val" data-slider-val="${key}">${value}%</span>
    </div>
  </div>`;
}

function selectHtml(name, options, value, attr = '') {
  return `<select class="input" ${attr}>
    ${options
      .map((option) => `<option value="${esc(option.value)}" ${String(option.value) === String(value) ? 'selected' : ''}>${esc(option.label)}</option>`)
      .join('')}
  </select>`;
}

/* ------------------------------ 各页签 ------------------------------ */

function appearanceTab(state) {
  const s = state.settings;
  const cats = state.categories || [];
  return `
    <div class="section">
      <div class="setting">
        <div class="setting__main"><div class="setting__label">${t('settings.theme')}</div></div>
        <div class="setting__control">
          ${segment(
            'theme',
            [
              { value: 'system', label: t('settings.theme.system') },
              { value: 'light', label: t('settings.theme.light') },
              { value: 'dark', label: t('settings.theme.dark') },
            ],
            s.theme,
          )}
        </div>
      </div>

      <div class="setting">
        <div class="setting__main"><div class="setting__label">${t('settings.motion')}</div></div>
        <div class="setting__control">
          ${segment(
            'motion',
            [
              { value: 'full', label: t('settings.motion.full') },
              { value: 'soft', label: t('settings.motion.soft') },
              { value: 'off', label: t('settings.motion.off') },
            ],
            s.motionLevel,
          )}
        </div>
      </div>

      <div class="setting">
        <div class="setting__main"><div class="setting__label">${t('settings.lang')}</div></div>
        <div class="setting__control">
          ${segment(
            'lang',
            [
              { value: 'zh', label: '中文' },
              { value: 'en', label: 'English' },
            ],
            s.lang,
          )}
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section__title" style="margin-bottom:8px">${t('settings.mode')}</div>
      <div class="segment" data-segment="mode" style="width:100%;margin-bottom:8px">
        ${[
          { value: 'window', label: t('settings.mode.window'), icon: 'window' },
          { value: 'sidebar', label: t('settings.mode.sidebar'), icon: 'sidebar' },
          { value: 'dock', label: t('settings.mode.dock'), icon: 'dock' },
        ]
          .map(
            (option) => `<button type="button" data-value="${option.value}" style="flex:1" class="${
              s.mode === option.value ? 'is-active' : ''
            }">${icon(option.icon, 13)}<span>${esc(option.label)}</span></button>`,
          )
          .join('')}
      </div>
      <div class="section__hint">${t('settings.mode.hint')}</div>

      <div class="setting">
        <div class="setting__main"><div class="setting__label">${t('settings.sidebarSide')}</div></div>
        <div class="setting__control">
          ${segment(
            'sidebarSide',
            [
              { value: 'left', label: t('settings.sidebarSide.left') },
              { value: 'right', label: t('settings.sidebarSide.right') },
            ],
            s.sidebarSide,
          )}
        </div>
      </div>
    </div>

    <div class="section">
      ${sliderRow('mist', t('settings.mist'), t('settings.mist.hint'), s.mist, 0, 30)}

      <div class="setting">
        <div class="setting__main">
          <div class="setting__label">${t('settings.accent')}</div>
          <div class="setting__hint">${t('settings.accent.hint')}</div>
        </div>
        <div class="setting__control" style="display:flex;align-items:center;gap:8px">
          <input
            type="color"
            data-accent
            value="${esc(s.accent || '#8a9bae')}"
            class="accent-pick"
            aria-label="${esc(t('settings.accent'))}"
          />
          <button class="btn btn--sm btn--ghost" type="button" data-set-act="accent-reset">
            ${esc(t('settings.accent.reset'))}
          </button>
        </div>
      </div>

      <div class="setting">
        <div class="setting__main">
          <div class="setting__label">${t('settings.glassBase')}</div>
          <div class="setting__hint">${t('settings.glassBase.hint')}</div>
        </div>
        <div class="setting__control">
          ${segment(
            'glassBase',
            [
              { value: 'acrylic', label: t('settings.glassBase.acrylic') },
              { value: 'clear', label: t('settings.glassBase.clear') },
              { value: 'live', label: t('settings.glassBase.live') },
            ],
            s.glassBase || 'acrylic',
          )}
        </div>
      </div>
      ${switchRow('cursorGlow', t('settings.cursorGlow'), t('settings.cursorGlow.hint'), s.cursorGlow)}
      ${switchRow('skipHidden', t('settings.skipHidden'), '', s.skipHidden)}
      ${switchRow('closeToTray', t('settings.closeToTray'), '', s.closeToTray)}
      ${switchRow('watchEnabled', t('settings.watch'), t('settings.watch.hint'), s.watchEnabled)}
      ${switchRow('clipboardHistory', t('settings.clipboard'), t('settings.clipboard.hint'), s.clipboardHistory !== false)}
      ${switchRow('learnMode', t('settings.learn'), t('settings.learn.hint'), s.learnMode)}
      ${switchRow('autostart', t('settings.autostart'), t('settings.autostart.hint'), s.autostart)}
    </div>

    <div class="section">
      <div class="section__title" style="margin-bottom:4px">${t('settings.folderNames')}</div>
      <div class="section__hint">${t('settings.folderNames.hint')}</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:7px">
        ${cats
          .map(
            (cat) => `<label style="display:flex;align-items:center;gap:7px">
              <span class="file-ico" data-tone="${esc(cat.tone)}" style="width:24px;height:24px;border-radius:7px">${icon(
                categoryIcon(cat.icon === 'app' ? 'app' : cat.id),
                14,
              )}</span>
              <input class="input" data-cat="${esc(cat.id)}" value="${esc(
                cat.name === cat.defaultName ? '' : cat.name,
              )}" placeholder="${esc(cat.defaultName)}" />
            </label>`,
          )
          .join('')}
      </div>
    </div>`;
}

function ruleCondRow(cond, index, meta) {
  const fields = Object.entries(meta.fields || {});
  const ops = OPS_BY_FIELD[cond.field] || ['contains'];
  const needsNumber = cond.field === 'size' || cond.field === 'mtime' || cond.field === 'ctime';
  const unit = cond.field === 'size' ? ' MB' : needsNumber ? ' 天' : '';

  const valueInput =
    cond.op === 'between'
      ? `<div class="rule-cond__range">
          <input class="input" data-cond-value type="number" value="${esc(cond.value)}" />
          <span style="color:var(--ink-4)">–</span>
          <input class="input" data-cond-value2 type="number" value="${esc(cond.value2 ?? '')}" />
        </div>`
      : `<input class="input" data-cond-value ${needsNumber ? 'type="number"' : ''} value="${esc(
          cond.value,
        )}" placeholder="${needsNumber ? '数值' : '关键词'}" />`;

  return `<div class="rule-cond" data-cond-index="${index}">
    ${selectHtml(
      'field',
      fields.map(([value, label]) => ({ value, label })),
      cond.field,
      'data-cond-field',
    )}
    ${selectHtml(
      'op',
      ops.map((value) => ({ value, label: (meta.ops || {})[value] || value })),
      cond.op,
      'data-cond-op',
    )}
    <div style="display:flex;align-items:center;gap:5px;min-width:0">
      ${valueInput}
      <span style="color:var(--ink-4);font-size:11px;flex:none">${unit}</span>
    </div>
    <button class="row-mini" data-rule-act="del-cond" data-cond-index="${index}" title="${t('settings.rules.delete')}">${icon(
      'minus',
      13,
    )}</button>
  </div>`;
}

function rulesTab(state) {
  const rules = state.settings.customRules || [];
  const meta = state.ruleMeta || { fields: {}, ops: {} };

  const cards = rules
    .map(
      (rule, index) => `<div class="rule-card${rule.enabled === false ? ' is-off' : ''}" data-rule-id="${esc(
        rule.id,
      )}">
        <div class="rule-card__head">
          <button class="switch${rule.enabled !== false ? ' is-on' : ''}" data-rule-act="toggle" data-rule-id="${esc(
            rule.id,
          )}"></button>
          <input class="rule-card__name" data-rule-name="${esc(rule.id)}" value="${esc(rule.name)}" />
          <span class="chip">#${index + 1}</span>
          <button class="row-mini" data-rule-act="delete" data-rule-id="${esc(rule.id)}" title="${t(
            'settings.rules.delete',
          )}">${icon('trash', 13)}</button>
        </div>
        <div class="rule-conds">
          ${(rule.conditions || []).map((cond, ci) => ruleCondRow(cond, ci, meta)).join('')}
        </div>
        <div class="rule-target">
          <span class="rule-target__label">${t('settings.rules.target')}</span>
          <input class="input" data-rule-target="${esc(rule.id)}" value="${esc(rule.target)}" placeholder="${t(
            'settings.rules.placeholderTarget',
          )}" />
        </div>
        <div class="rule-desc">${esc(rule.description || '')}</div>
        <div class="rule-foot">
          <button class="btn btn--sm btn--ghost" data-rule-act="add-cond" data-rule-id="${esc(rule.id)}">
            ${icon('plus', 12)}<span>${t('settings.rules.addCondition')}</span>
          </button>
        </div>
      </div>`,
    )
    .join('');

  return `<div class="section__hint">${t('settings.rules.hint')}</div>
    <div class="section__hint" style="color:var(--ink-4)">${t('settings.rules.tokenHint')}</div>
    ${rules.length ? cards : `<div class="empty-note">${t('settings.rules.empty')}</div>`}
    <button class="btn btn--sm" data-set-act="add-rule" style="margin-top:6px">
      ${icon('plus', 13)}<span>${t('settings.rules.add')}</span>
    </button>`;
}

function excludeTab(state) {
  const excludes = state.settings.excludes || [];
  const presets = state.defaultExcludes || [];
  const kinds = [
    { value: 'contains', label: t('settings.excludes.kind.contains') },
    { value: 'name', label: t('settings.excludes.kind.name') },
    { value: 'glob', label: t('settings.excludes.kind.glob') },
    { value: 'path', label: t('settings.excludes.kind.path') },
  ];

  return `<div class="section__hint">${t('settings.excludes.hint')}</div>
    ${
      excludes.length
        ? excludes
            .map(
              (item) => `<div class="exclude-row" data-exclude-id="${esc(item.id)}">
                <input class="input" data-exclude-value value="${esc(item.value)}" placeholder="${t(
                  'settings.excludes.placeholder',
                )}" />
                ${selectHtml('kind', kinds, item.kind, 'data-exclude-kind')}
                <button class="row-mini" data-set-act="del-exclude" data-exclude-id="${esc(item.id)}" title="${t(
                  'common.delete',
                )}">${icon('trash', 13)}</button>
              </div>`,
            )
            .join('')
        : `<div class="empty-note">${t('settings.excludes.empty')}</div>`
    }
    <button class="btn btn--sm" data-set-act="add-exclude">${icon('plus', 13)}<span>${t(
      'settings.excludes.add',
    )}</span></button>
    <div class="exclude-preset">
      ${presets
        .map(
          (preset) => `<button data-set-act="preset-exclude" data-value="${esc(preset.value)}" data-kind="${esc(
            preset.kind,
          )}">+ ${esc(preset.value)}</button>`,
        )
        .join('')}
    </div>`;
}

function scheduleTab(state) {
  const schedule = state.settings.schedule || {};
  const status = state.scheduleStatus || {};
  const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  const dirs = (schedule.dirs || [])
    .map(
      (dir) => `<div class="dir-item">
        ${icon('folder', 13)}
        <span title="${esc(dir)}">${esc(dir)}</span>
        <button class="row-mini" data-set-act="remove-dir" data-dir="${esc(dir)}">${icon('close', 12)}</button>
      </div>`,
    )
    .join('');

  return `<div class="setting">
      <div class="setting__main">
        <div class="setting__label">${t('settings.schedule.enable')}</div>
        <div class="setting__hint">${
          status.nextRun
            ? esc(t('settings.schedule.next', { time: formatClock(status.nextRun) }))
            : esc(t('settings.schedule.never'))
        }${status.lastRun ? ` · ${esc(t('settings.schedule.last', { time: formatClock(status.lastRun) }))}` : ''}</div>
      </div>
      <div class="setting__control">
        <button class="switch${schedule.enabled ? ' is-on' : ''}" data-toggle="schedule.enabled"></button>
      </div>
    </div>

    <div class="setting">
      <div class="setting__main"><div class="setting__label">${t('settings.schedule.freq')}</div></div>
      <div class="setting__control">
        ${segment(
          'freq',
          [
            { value: 'daily', label: t('settings.schedule.daily') },
            { value: 'weekly', label: t('settings.schedule.weekly') },
          ],
          schedule.freq,
        )}
      </div>
    </div>

    <div class="setting">
      <div class="setting__main"><div class="setting__label">${t('settings.schedule.time')}</div></div>
      <div class="setting__control time-row">
        <input class="input" type="number" min="0" max="23" data-schedule="hour" value="${schedule.hour ?? 9}" />
        <span style="color:var(--ink-4)">:</span>
        <input class="input" type="number" min="0" max="59" data-schedule="minute" value="${String(
          schedule.minute ?? 0,
        ).padStart(2, '0')}" />
        ${
          schedule.freq === 'weekly'
            ? selectHtml(
                'weekday',
                weekdays.map((label, index) => ({ value: index + 1, label })),
                schedule.weekday ?? 1,
                'data-schedule="weekday" style="width:92px;height:30px"',
              )
            : ''
        }
      </div>
    </div>

    <div class="setting">
      <div class="setting__main">
        <div class="setting__label">${t('settings.schedule.silent')}</div>
      </div>
      <div class="setting__control">
        <button class="switch${schedule.silent !== false ? ' is-on' : ''}" data-toggle="schedule.silent"></button>
      </div>
    </div>

    <div class="section" style="margin-top:14px">
      <div class="section__head">
        <span class="section__title">${t('settings.schedule.dirs')}</span>
        <span class="section__spacer"></span>
        <button class="btn btn--sm btn--ghost" data-set-act="add-dir">${icon('plus', 12)}<span>${t(
          'settings.schedule.addDir',
        )}</span></button>
      </div>
      <div class="dir-list">${dirs || `<div class="empty-note">${t('settings.schedule.empty')}</div>`}</div>
    </div>

    <button class="btn btn--sm" data-set-act="run-schedule" style="margin-top:4px">
      ${icon('check', 12)}<span>${t('settings.schedule.runNow')}</span>
    </button>`;
}

function tagsTab(state) {
  const tags = state.tagList || [];
  return `<div class="section__head">
      <span class="section__title">${t('settings.tags')}</span>
      <span class="section__spacer"></span>
    </div>
    <div style="display:flex;gap:7px;margin-bottom:12px">
      <input class="input" data-tag-name placeholder="${t('settings.tags.placeholder')}" />
      <button class="btn btn--sm" data-set-act="add-tag">${icon('plus', 12)}<span>${t('settings.tags.add')}</span></button>
    </div>
    ${
      tags.length
        ? tags
            .map(
              (tag) => `<div class="dir-item" style="margin-bottom:6px">
                <span class="tag-dot" data-color="${esc(tag.color)}"></span>
                <span style="direction:ltr">${esc(tag.name)}</span>
                <span class="chip">${tag.count} 个文件</span>
                <button class="row-mini" data-set-act="del-tag" data-tag-id="${esc(tag.id)}">${icon('trash', 12)}</button>
              </div>`,
            )
            .join('')
        : `<div class="empty-note">${t('settings.tags.empty')}</div>`
    }`;
}

function pluginsTab(state) {
  const data = state.pluginData || { items: [], enabled: [], dir: '' };
  const enabled = new Set(data.enabled || []);

  return `<div class="section__hint">${t('settings.plugins.hint')}</div>
    <div style="display:flex;gap:7px;margin-bottom:12px">
      <button class="btn btn--sm" data-set-act="open-plugins">${icon('folder', 12)}<span>${t(
        'settings.plugins.open',
      )}</span></button>
      <button class="btn btn--sm btn--ghost" data-set-act="reload-plugins">${icon('refresh', 12)}<span>${t(
        'settings.plugins.reload',
      )}</span></button>
    </div>
    <div class="section__hint" style="color:var(--ink-4);font-size:11px">${esc(data.dir || '')}</div>
    ${
      data.items.length
        ? data.items
            .map(
              (item) => `<div class="plugin-card${item.ok ? '' : ' is-bad'}">
                <div class="plugin-card__main">
                  <div class="plugin-card__name">${esc(item.name)} <span style="color:var(--ink-4);font-weight:400">v${esc(
                    item.version,
                  )}</span></div>
                  <div class="plugin-card__desc">${esc(item.description || item.file)}</div>
                  ${item.ok ? '' : `<div class="plugin-card__err">${t('settings.plugins.error')}：${esc(item.error)}</div>`}
                </div>
                ${
                  item.ok
                    ? `<button class="switch${enabled.has(item.file) ? ' is-on' : ''}" data-set-act="toggle-plugin" data-file="${esc(
                        item.file,
                      )}"></button>`
                    : ''
                }
              </div>`,
            )
            .join('')
        : `<div class="empty-note">${t('settings.plugins.empty')}</div>`
    }`;
}

function aboutTab(state) {
  const info = state.info || {};
  return `<div class="about-hero">
      <img src="./assets/logo.png" alt="" />
      <div>
        <div class="about-hero__name">FileSorter <span style="color:var(--ink-4);font-size:12px;font-weight:400">v${esc(
          info.version || '',
        )}</span></div>
        <div class="about-hero__desc">${t('settings.about.desc')}</div>
      </div>
    </div>

    <dl class="detail-kv" style="font-size:12px">
      <dt>${t('settings.version')}</dt><dd>${esc(info.version || '—')}</dd>
      <dt>${t('settings.electron')}</dt><dd>${esc(info.electron || '—')}</dd>
      <dt>Node</dt><dd>${esc(info.node || '—')}</dd>
      <dt>Chromium</dt><dd>${esc(info.chrome || '—')}</dd>
      <dt>${t('settings.dataDir')}</dt><dd>${esc(info.userData || '—')}</dd>
    </dl>

    <div style="display:flex;gap:7px;margin-top:14px;flex-wrap:wrap">
      <button class="btn btn--sm" data-set-act="open-data">${icon('folder', 12)}<span>${t('settings.dataDir')}</span></button>
      <button class="btn btn--sm btn--ghost" data-set-act="open-repo">${icon('globe', 12)}<span>GitHub</span></button>
      <button class="btn btn--sm btn--ghost" data-set-act="open-issues">${icon('alert', 12)}<span>${t('settings.feedback')}</span></button>
      <button class="btn btn--sm btn--ghost" data-set-act="open-releases">${icon('ring', 12)}<span>${t('settings.releases')}</span></button>
    </div>

    <div class="section" style="margin-top:18px">
      <div class="section__title" style="margin-bottom:6px">${t('settings.shortcuts')}</div>
      <div class="shortcut-grid">
        ${[
          ['Ctrl K', t('settings.shortcuts.search')],
          ['Ctrl Shift K', t('settings.shortcuts.scope')],
          ['Ctrl Alt Space', t('settings.shortcuts.quick')],
          ['Ctrl Alt V', t('settings.shortcuts.clip')],
          ['Ctrl 1~6', t('settings.shortcuts.bucket')],
          ['Ctrl A', t('settings.shortcuts.selectAll')],
          ['Enter', t('settings.shortcuts.open')],
          ['Delete', t('settings.shortcuts.delete')],
          ['Space', t('settings.shortcuts.check')],
          ['Ctrl ,', t('settings.shortcuts.settings')],
          ['Ctrl Shift W', t('settings.shortcuts.window')],
        ]
          .map(
            ([keys, label]) => `<div class="shortcut-row"><kbd>${esc(keys)}</kbd><span>${esc(label)}</span></div>`,
          )
          .join('')}
      </div>
    </div>

    <div class="section__hint" style="margin-top:14px">${t('settings.license')}</div>`;
}

/** 主入口 */
export function settingsHtml(state) {
  const tab = state.settingsTab || 'appearance';
  const panes = {
    appearance: appearanceTab,
    rules: rulesTab,
    exclude: excludeTab,
    schedule: scheduleTab,
    tags: tagsTab,
    plugins: pluginsTab,
    about: aboutTab,
  };

  return `<div class="panel__head">
      <div style="flex:1"><div class="panel__title">${t('settings.title')}</div></div>
      <button class="icon-btn" data-set-act="close" aria-label="${t('common.close')}">${icon('close', 15)}</button>
    </div>
    <div class="set-tabs">
      ${TABS.map(
        (item) => `<button class="set-tab${tab === item.id ? ' is-active' : ''}" data-set-tab="${item.id}">
          ${icon(item.icon, 12)}<span style="margin-left:5px">${t(item.label)}</span>
        </button>`,
      ).join('')}
    </div>
    <div class="panel__body" id="settingsBody">${(panes[tab] || appearanceTab)(state)}</div>`;
}

export { TABS, OPS_BY_FIELD };
