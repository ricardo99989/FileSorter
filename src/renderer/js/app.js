import { api, formatSize } from './api.js';
import { motion } from './motion.js';
import { toast } from './components/ui.js';
import { navHtml, statsHtml, gridHtml, similarHtml, headingOf } from './views/files.js';
import { settingsHtml, historyHtml } from './views/settings.js';
import { openPreview } from './views/preview.js';

/** 全局状态。视图只读它，写操作统一走下面的函数。 */
const state = {
  dir: '',
  settings: { customNames: {}, skipHidden: true, motionLevel: 'full', sortBy: 'mtime' },
  categories: [],
  categoryById: new Map(),
  info: null,
  stats: null,
  files: [],
  categoryId: null,
  keyword: '',
  sortBy: 'mtime',
  view: 'files',
  loading: false,
};

const dom = {};

function cacheDom() {
  dom.folderPath = document.getElementById('folderPath');
  dom.pickFolder = document.getElementById('pickFolder');
  dom.nav = document.getElementById('categoryNav');
  dom.utility = document.getElementById('utilityNav');
  dom.search = document.getElementById('searchInput');
  dom.statRow = document.getElementById('statRow');
  dom.grid = document.getElementById('fileGrid');
  dom.sectionTitle = document.getElementById('sectionTitle');
  dom.sectionSub = document.getElementById('sectionSub');
  dom.sortSeg = document.getElementById('sortSeg');
  dom.similar = document.getElementById('similarPanel');
  dom.similarList = document.getElementById('similarList');
  dom.filesPanel = document.getElementById('filesPanel');
  dom.settingsPanel = document.getElementById('settingsPanel');
  dom.historyPanel = document.getElementById('historyPanel');
  dom.btnPreview = document.getElementById('btnPreview');
  dom.btnUndo = document.getElementById('btnUndo');
}

function setCategories(categories) {
  state.categories = categories;
  state.categoryById = new Map(categories.map((cat) => [cat.id, cat]));
}

/* ---------------------------------- 渲染 --------------------------------- */

function renderNav() {
  dom.nav.innerHTML = navHtml(state);
}

function renderStats() {
  dom.statRow.innerHTML = statsHtml(state);
  for (const el of dom.statRow.querySelectorAll('.stat__value')) {
    const target = Number(el.dataset.count || 0);
    if (el.dataset.format === 'size') {
      motion.countUp(el, target, { formatter: (value) => formatSize(value) });
    } else {
      motion.countUp(el, target, {
        formatter: (value) => Math.round(value).toLocaleString('zh-CN'),
      });
    }
  }
}

function renderGrid({ animate = true } = {}) {
  dom.grid.innerHTML = gridHtml(state, state.files);
  if (animate) motion.reveal(dom.grid.children);
}

function renderHeading() {
  const heading = headingOf({ ...state, files: state.files, stats: { ...(state.stats || {}), dir: state.dir } });
  dom.sectionTitle.textContent = heading.title;
  dom.sectionSub.textContent = heading.sub;
}

function renderSimilar(result) {
  const view = similarHtml(result);
  dom.similar.hidden = view.hidden;
  if (view.hidden) {
    dom.similarList.innerHTML = '';
    return;
  }
  dom.similarList.innerHTML = view.chips;
  const note = document.getElementById('similarNote');
  if (note) note.textContent = view.note;
}

function renderAll() {
  renderNav();
  renderStats();
  renderHeading();
  renderGrid();
}

/* --------------------------------- 数据流 -------------------------------- */

async function loadFolder(dir) {
  state.dir = dir;
  state.categoryId = null;
  state.keyword = '';
  dom.search.value = '';
  dom.folderPath.textContent = dir.split(/[\\/]/).filter(Boolean).pop() || dir;
  dom.folderPath.title = dir;
  await refresh();
}

async function refresh() {
  if (!state.dir) {
    renderAll();
    return;
  }
  state.loading = true;
  renderGrid({ animate: false });

  try {
    const [stats, list] = await Promise.all([
      api.stats(state.dir),
      api.list(state.dir, state.categoryId),
    ]);
    state.stats = stats;
    state.files = list.files;
    setCategories(stats.categories);
  } catch (err) {
    toast(`读取失败：${err.message}`, { type: 'error' });
    state.stats = null;
    state.files = [];
  } finally {
    state.loading = false;
  }

  renderAll();
  renderSimilar(null);
}

async function runSearch(keyword) {
  state.keyword = keyword.trim();
  if (!state.dir) return;

  if (!state.keyword) {
    await refresh();
    return;
  }

  try {
    const result = await api.search(state.dir, state.keyword);
    state.files = result.hits;
    renderHeading();
    renderGrid();
    renderSimilar(result);
  } catch (err) {
    toast(`搜索失败：${err.message}`, { type: 'error' });
  }
}

/* -------------------------------- 交互逻辑 ------------------------------- */

let searchTimer = 0;

function switchView(view) {
  state.view = view;
  dom.filesPanel.hidden = view !== 'files';
  dom.settingsPanel.hidden = view !== 'settings';
  dom.historyPanel.hidden = view !== 'history';

  for (const button of dom.utility.querySelectorAll('[data-view]')) {
    button.classList.toggle('is-active', button.dataset.view === view);
  }
  for (const button of dom.nav.querySelectorAll('[data-category]')) {
    button.classList.remove('is-active');
  }

  if (view === 'settings') {
    dom.settingsPanel.innerHTML = settingsHtml(state, state.info);
  }
  if (view === 'history') {
    renderHistory();
  }
  if (view === 'files') {
    renderNav();
  }
}

async function renderHistory() {
  try {
    const { items } = await api.history();
    dom.historyPanel.innerHTML = historyHtml(items);
  } catch (err) {
    dom.historyPanel.innerHTML = historyHtml([]);
    toast(`读取记录失败：${err.message}`, { type: 'error' });
  }
}

async function pickFolder() {
  try {
    const { path } = await api.pickFolder();
    if (path) {
      switchView('files');
      await loadFolder(path);
    }
  } catch (err) {
    toast(`选择文件夹失败：${err.message}`, { type: 'error' });
  }
}

async function undoLast() {
  try {
    const result = await api.undo();
    if (!result.restored) {
      toast(result.message || '没有可撤销的记录', { type: 'warn' });
      return;
    }
    toast(result.message || `已还原 ${result.restored} 个文件`, { type: 'ok' });
    motion.bump(dom.btnUndo);
    await refresh();
    if (state.view === 'history') renderHistory();
  } catch (err) {
    toast(`撤销失败：${err.message}`, { type: 'error' });
  }
}

async function saveCustomName(id, rawValue) {
  const value = String(rawValue || '').trim();
  const merged = { ...state.settings.customNames };
  if (value) merged[id] = value;
  else delete merged[id];

  try {
    const { settings, categories } = await api.saveSettings({ customNames: merged });
    state.settings = settings;
    setCategories(categories);
    renderNav();
    // 名称变了，网格里分类标签同步刷新
    if (state.view === 'files') renderGrid({ animate: false });
    toast(`已改名为「${categories.find((cat) => cat.id === id)?.name || value}」`, { type: 'ok', duration: 1800 });
  } catch (err) {
    toast(`保存失败：${err.message}`, { type: 'error' });
  }
}

async function toggleFlag(flag, button) {
  const next = !state.settings[flag];
  try {
    await api.saveSettings({ [flag]: next });
    state.settings[flag] = next;
    button.setAttribute('aria-checked', next ? 'true' : 'false');
    motion.pulse(button);
    if (flag === 'skipHidden') await refresh();
  } catch (err) {
    toast(`保存失败：${err.message}`, { type: 'error' });
  }
}

async function setMotionLevel(level, container) {
  try {
    await api.saveSettings({ motionLevel: level });
    state.settings.motionLevel = level;
    motion.setLevel(level);
    for (const button of container.querySelectorAll('[data-motion]')) {
      button.classList.toggle('is-active', button.dataset.motion === level);
    }
    toast(level === 'off' ? '动效已关闭' : `动效强度：${level === 'soft' ? '轻柔' : '完整'}`, {
      type: 'ok',
      duration: 1600,
    });
  } catch (err) {
    toast(`保存失败：${err.message}`, { type: 'error' });
  }
}

function applySort(sortBy) {
  if (state.sortBy === sortBy) return;
  state.sortBy = sortBy;
  api.saveSettings({ sortBy }).catch(() => {});

  for (const button of dom.sortSeg.querySelectorAll('button')) {
    button.classList.toggle('is-active', button.dataset.sort === sortBy);
  }

  // FLIP：排序前后位置差做补间，避免列表硬跳
  motion.flip(dom.grid, () => {
    const sorted = [...state.files];
    if (sortBy === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    else if (sortBy === 'size') sorted.sort((a, b) => b.size - a.size);
    else sorted.sort((a, b) => b.mtime - a.mtime);
    state.files = sorted;
    renderGrid({ animate: false });
  });
}

function bindEvents() {
  dom.pickFolder.addEventListener('click', pickFolder);
  dom.btnPreview.addEventListener('click', () => openPreview(state, { refresh }));

  dom.btnUndo.addEventListener('click', () => {
    // 原则 2：按下先有个极短的预备，再执行
    motion.anticipate(dom.btnUndo, undoLast);
  });

  dom.nav.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-category]');
    if (!button) return;
    state.categoryId = button.dataset.category || null;
    state.keyword = '';
    dom.search.value = '';
    renderNav();
    await refresh();
  });

  dom.utility.addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]');
    if (button) switchView(button.dataset.view);
  });

  // 单击定位到所在文件夹，双击直接打开
  dom.grid.addEventListener('click', (event) => {
    const card = event.target.closest('.card');
    if (!card) return;
    api.reveal(card.dataset.path).catch((err) => toast(err.message, { type: 'error' }));
  });
  dom.grid.addEventListener('dblclick', (event) => {
    const card = event.target.closest('.card');
    if (card) api.open(card.dataset.path).catch((err) => toast(err.message, { type: 'error' }));
  });

  dom.grid.addEventListener('pointermove', (event) => {
    const card = event.target.closest('.card');
    if (card) motion.lightFollow(card, event);
  });

  dom.similarList.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (chip) api.reveal(chip.dataset.path).catch(() => {});
  });

  dom.search.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => runSearch(dom.search.value), 260);
  });
  dom.search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      window.clearTimeout(searchTimer);
      runSearch(dom.search.value);
    }
    if (event.key === 'Escape') {
      dom.search.value = '';
      runSearch('');
    }
  });

  dom.sortSeg.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-sort]');
    if (button) applySort(button.dataset.sort);
  });

  // 设置面板：改名 / 开关 / 动效强度
  dom.settingsPanel.addEventListener('change', (event) => {
    const input = event.target.closest('input[data-name-id]');
    if (input) saveCustomName(input.dataset.nameId, input.value);
  });
  dom.settingsPanel.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.matches('input[data-name-id]')) event.target.blur();
  });
  dom.settingsPanel.addEventListener('click', (event) => {
    const toggle = event.target.closest('.toggle[data-flag]');
    if (toggle) {
      toggleFlag(toggle.dataset.flag, toggle);
      return;
    }
    const motionButton = event.target.closest('[data-motion]');
    if (motionButton) setMotionLevel(motionButton.dataset.motion, motionButton.parentElement);
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      dom.search.focus();
      dom.search.select();
    }
    if (event.key === 'Escape' && !document.getElementById('previewSheet').hidden) {
      document.getElementById('cancelPreview').click();
    }
  });
}

/* --------------------------------- 启动 --------------------------------- */

async function bootstrap() {
  cacheDom();
  try {
    const { settings, categories } = await api.getSettings();
    state.settings = settings;
    state.sortBy = settings.sortBy;
    setCategories(categories);
    motion.setLevel(settings.motionLevel);

    for (const button of dom.sortSeg.querySelectorAll('button')) {
      button.classList.toggle('is-active', button.dataset.sort === state.sortBy);
    }

    state.info = await api.info();
    bindEvents();
    renderNav();

    if (settings.lastFolder) {
      await loadFolder(settings.lastFolder);
    } else {
      renderAll();
    }
  } catch (err) {
    toast(`启动失败：${err.message}`, { type: 'error', duration: 6000 });
  }
}

window.addEventListener('error', (event) => {
  console.error(event.error || event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('未处理的异步错误', event.reason);
});

bootstrap();
