import { esc, icon, shortPath } from '../api.js';

const MOTION_OPTIONS = [
  { value: 'full', label: '完整' },
  { value: 'soft', label: '轻柔' },
  { value: 'off', label: '关闭' },
];

/**
 * 设置面板：分类改名 / 行为开关 / 关于。
 * 所有改动即时保存（input 失焦或回车时触发），不用点「保存」按钮。
 */
export function settingsHtml(state, info) {
  const names = state.categories
    .map(
      (cat) => `
      <label class="field">
        <span class="field__label"><span class="nav__dot tone-${cat.tone}"></span>${esc(
          cat.defaultName,
        )} 分类</span>
        <input type="text" data-name-id="${esc(cat.id)}" value="${esc(cat.name)}"
               placeholder="${esc(cat.defaultName)}" maxlength="40" />
        <span class="field__hint">留空则使用默认名「${esc(cat.defaultName)}」</span>
      </label>`,
    )
    .join('');

  const motionButtons = MOTION_OPTIONS.map(
    (option) => `<button type="button" data-motion="${option.value}"
      class="${state.settings.motionLevel === option.value ? 'is-active' : ''}">${option.label}</button>`,
  ).join('');

  return `
    <div class="section-head">
      <div>
        <h2 class="section-title">设置</h2>
        <p class="section-sub">改完即时生效，只影响文件夹名称，不影响归类规则</p>
      </div>
    </div>

    <div class="settings-block">
      <div class="settings-block__title">分类文件夹名称</div>
      <div class="settings-block__desc">扩展名与分类的对应关系固定不变，这里改的只是文件夹叫什么。</div>
      <div class="name-grid">${names}</div>
    </div>

    <div class="settings-block">
      <div class="settings-block__title">整理行为</div>
      <div class="settings-block__desc">下载中的临时文件（.part / .crdownload / ~$ 开头）始终会被跳过。</div>
      <div class="switch-row">
        <div>
          <div class="switch-row__text">跳过隐藏文件</div>
          <div class="switch-row__sub">文件名以「.」开头的文件不参与整理</div>
        </div>
        <button class="toggle" type="button" role="switch" data-flag="skipHidden"
                aria-checked="${state.settings.skipHidden ? 'true' : 'false'}"
                aria-label="跳过隐藏文件"></button>
      </div>
      <div class="switch-row">
        <div>
          <div class="switch-row__text">界面动效</div>
          <div class="switch-row__sub">关闭后所有过渡变为瞬时，低配机器更流畅</div>
        </div>
        <div class="seg-choice" data-role="motion">${motionButtons}</div>
      </div>
    </div>

    <div class="settings-block">
      <div class="settings-block__title">关于</div>
      <div class="settings-block__desc">${icon('spark')} FileSorter 是本地工具，文件不会离开你的电脑。</div>
      <div class="switch-row">
        <div class="switch-row__text">版本</div>
        <div class="switch-row__sub">v${esc(info?.version || '1.0.0')} · Electron ${esc(info?.electron || '-')} · Node ${esc(
          info?.node || '-',
        )}</div>
      </div>
      <div class="switch-row">
        <div class="switch-row__text">配置目录</div>
        <div class="switch-row__sub" title="${esc(info?.userData || '')}">${esc(shortPath(info?.userData || '', 2))}</div>
      </div>
      <div class="switch-row">
        <div class="switch-row__text">开源协议</div>
        <div class="switch-row__sub">MIT License · 欢迎提交 Issue 与 PR</div>
      </div>
    </div>`;
}

/** 整理记录列表 */
export function historyHtml(items) {
  if (!items || !items.length) {
    return `
      <div class="section-head">
        <div>
          <h2 class="section-title">整理记录</h2>
          <p class="section-sub">每次整理都会留一份可回滚的日志</p>
        </div>
      </div>
      <div class="empty">
        <div class="empty__orb">${icon('history')}</div>
        <div class="empty__title">还没有整理记录</div>
        <div class="empty__sub">完成第一次整理后，这里会显示时间、目录和文件数量。</div>
      </div>`;
  }

  const rows = items
    .map((item) => {
      const date = new Date(item.ts || Date.now());
      const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
        date.getDate(),
      ).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      return `
        <div class="history-row">
          <div>
            <div class="history-row__time">${stamp}</div>
            <div class="history-row__dir" title="${esc(item.dir)}">${esc(item.dir)}</div>
          </div>
          <div class="history-row__count">${item.count} 个文件${item.undone ? ' · 已撤销' : ''}</div>
        </div>`;
    })
    .join('');

  return `
    <div class="section-head">
      <div>
        <h2 class="section-title">整理记录</h2>
        <p class="section-sub">最近 ${items.length} 次 · 点击顶部「撤销」可回滚最近一次</p>
      </div>
    </div>
    ${rows}`;
}
