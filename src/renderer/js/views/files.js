import { esc, icon } from '../api.js';
import { fileCard, navItem, emptyState } from '../components/card.js';

/** 侧栏：全部文件 + 八个分类，计数来自统计结果 */
export function navHtml(state) {
  const byId = new Map((state.stats?.byCategory || []).map((item) => [item.id, item.count]));
  const total = state.stats?.total || 0;
  const allActive = !state.categoryId;

  const allRow = `
    <button class="nav__item${allActive ? ' is-active' : ''}" data-category="" type="button" role="tab"
            aria-selected="${allActive ? 'true' : 'false'}">
      <span class="nav__dot tone-steel"></span>
      <span>全部文件</span>
      <span class="nav__count">${total}</span>
    </button>`;

  return [allRow, ...state.categories.map((cat) => navItem(cat, byId.get(cat.id) || 0, state.categoryId === cat.id))].join('');
}

/** 四张统计卡：初值写 0，目标值放 data-count，交给 countUp 滚动到真实数字 */
export function statsHtml(state) {
  const stats = state.stats;
  const pick = (label, value, className = '', format = '') => `
    <div class="stat ${className}">
      <div class="stat__label">${label}</div>
      <div class="stat__value" data-count="${Number(value) || 0}" data-format="${format}">0</div>
    </div>`;

  return [
    pick('文件总数', stats?.total || 0),
    pick('占用空间', stats?.size || 0, '', 'size'),
    pick('待归类', stats?.pending || 0, 'stat--accent'),
    pick('已归档', stats?.organized || 0, 'stat--ok'),
  ].join('');
}

/** 主网格 */
export function gridHtml(state, files) {
  if (!state.dir) {
    return emptyState('还没有选择文件夹', '先在上方选择一个目录，比如「下载」或「桌面」，我们来帮你归位。', 'folder');
  }
  if (state.loading) {
    return Array.from({ length: 8 }, () => '<div class="skeleton"></div>').join('');
  }
  if (!files.length) {
    if (state.keyword) {
      return emptyState('没有匹配的文件', `没有找到包含「${state.keyword}」的文件，换个关键词或清空搜索试试。`, 'search');
    }
    return emptyState('这个文件夹很干净', '当前分类下没有文件。切换到「全部文件」看看，或换一个文件夹。', 'spark');
  }
  return files.map((file) => fileCard(file, state.categoryById.get(file.categoryId))).join('');
}

/** 相似推荐条：只返回 chips 与说明文本，容器结构在 HTML 里固定 */
export function similarHtml(result) {
  if (!result || !result.similar?.length) return { hidden: true, chips: '', note: '' };
  const chips = result.similar
    .map(
      (file) => `<button class="chip" data-path="${esc(file.path)}" type="button" title="${esc(file.path)}">
        ${icon('file')}<span>${esc(file.name)}</span>
      </button>`,
    )
    .join('');
  return {
    hidden: false,
    chips,
    note: result.anchor ? `与「${result.anchor.name}」相似` : '',
  };
}

/** 区块标题：随视图变化 */
export function headingOf(state) {
  if (state.keyword) {
    return { title: `搜索：${state.keyword}`, sub: `共 ${state.files.length} 个结果 · ${state.stats?.dir || ''}` };
  }
  if (state.categoryId) {
    const cat = state.categories.find((c) => c.id === state.categoryId);
    return { title: cat ? cat.name : '文件', sub: `${state.files.length} 个文件 · ${state.stats?.dir || ''}` };
  }
  return { title: '全部文件', sub: state.dir ? `${state.files.length} 个文件 · ${state.stats?.dir || ''}` : '先选择一个文件夹' };
}
