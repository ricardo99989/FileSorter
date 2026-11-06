/**
 * app.js — 渲染层控制器
 *
 * 一份 state，一堆渲染函数，所有视图都是它的投影。
 * 刻意不引框架：这个界面的更新粒度是"整屏换目录"和"单行改选中态"，
 * 手写的虚拟滚动比任何 diff 都直接，也省掉几百 KB 运行时。
 */

import { VirtualList } from './vlist.js';
import { icon, categoryIcon, categoryTone } from './icons.js';
import { clamp, debounce, esc, formatRelative, formatSize, greeting } from './format.js';
import {
  filterEntries,
  gridCardHtml,
  rowHtml,
  skeletonHtml,
  sortEntries,
  stateHtml,
  statusHtml,
  tableHeadHtml,
} from './views/list.js';
import { detailsHtml } from './views/details.js';
import {
  WHEEL_BUCKETS,
  bucketOf,
  centerHoverHtml,
  centerIdleHtml,
  computeWheel,
  legendHtml,
  wheelSvg,
} from './wheel.js';
import { organizeHtml } from './panels/organize.js';
import { settingsHtml, REPO_URL } from './panels/settings.js';
import { startLiveBackground, stopLiveBackground, liveStats } from './livebg.js';
import { dupesHtml } from './panels/dupes.js';
import { spaceHtml } from './panels/space.js';
import { batchHtml } from './panels/batch.js';
import { historyHtml } from './panels/history.js';
import { tagsHtml } from './panels/tags.js';
import { t, setLang, getLang } from '../../shared/i18n.mjs';

const api = window.filesorter;
const $ = (id) => document.getElementById(id);

const GRID_GAP = 12;
const MIN_CARD_W = 156;

/** 卡片高度由 CSS 变量 --card-h 决定（窄窗口会自动变小），虚拟滚动必须跟着它算，否则会错位 */
const cardHeight = () => cssPx('--card-h', 188);

const dom = {
  titleMeta: $('titleMeta'),
  placeList: $('placeList'),
  driveList: $('driveList'),
  crumbs: $('crumbs'),
  content: $('content'),
  tableHead: $('tableHead'),
  viewport: $('viewport'),
  vcontent: $('vcontent'),
  stateLayer: $('state'),
  skeleton: $('skeleton'),
  statusbar: $('statusbar'),
  details: $('details'),
  search: $('searchInput'),
  searchField: $('searchField'),
  btnTheme: $('btnTheme'),
  btnList: $('btnList'),
  btnGrid: $('btnGrid'),
  btnBack: $('btnBack'),
  btnForward: $('btnForward'),
  btnUp: $('btnUp'),
  btnRefresh: $('btnRefresh'),
  btnDetail: $('btnDetail'),
  drawer: $('drawer'),
  modal: $('modal'),
  scrim: $('scrim'),
  menu: $('menu'),
  toasts: $('toasts'),
  glow: $('cursorGlow'),
  selectionBar: $('selectionBar'),
  selectionCount: $('selectionCount'),
  wheelBar: $('wheelBar'),
  wheel: $('wheel'),
  wheelLegend: $('wheelLegend'),
  btnWheelFold: $('btnWheelFold'),
  scopeBar: $('scopeBar'),
  preview: $('preview'),
  previewTitle: $('previewTitle'),
  previewSub: $('previewSub'),
  previewBody: $('previewBody'),
  previewOpen: $('previewOpen'),
  previewClose: $('previewClose'),
  btnPlaces: $('btnPlaces'),
  placePop: $('placePop'),
};

const state = {
  /* 基础数据 */
  settings: {},
  categories: [],
  info: {},
  places: [],
  drives: [],
  clouds: [],
  ruleMeta: { fields: {}, ops: {} },
  defaultExcludes: [],
  tagList: [],
  pluginData: { items: [], enabled: [], dir: '' },
  scheduleStatus: {},
  historyList: [],

  /* 浏览 */
  cwd: '',
  listing: null,
  entries: [],
  sort: { key: 'name', dir: 'asc' },
  view: 'list',
  cols: 1,
  parentPath: null,
  selected: null,
  selectedEntry: null,
  checked: new Set(),
  detail: null,
  preview: null,
  tagMap: {},
  query: '',
  deep: null,
  loading: true,
  error: null,
  watching: null,
  cloud: null,

  /* 外观 */
  theme: 'system',
  detailOpen: true,

  /* 轮盘 */
  wheelModel: { buckets: [], total: 0, totalSize: 0 },
  wheelFilter: '',
  /** 视图范围：all 全部 / fav 收藏 / recent 最近 7 天 */
  scope: 'all',
  /** 收藏：Set 存归一化路径用于查询，数组存原始路径用于持久化 */
  favorites: new Set(),
  favoriteList: [],
  /* null = 跟随窗口高度自动决定；true/false = 用户手动指定过 */
  wheelFold: null,
  /* 列表入场动画的计时起点：只有在这个时间窗内渲染的行才做错开淡入，
     否则滚动时复用的节点会一遍遍重播动画 */
  enterAt: 0,

  /* 导航 */
  history: [],
  hIndex: -1,

  /* 面板 */
  panel: '',
  settingsTab: 'appearance',
  organize: { loading: false, error: null, plan: null, selected: new Set(), busy: false, progress: null, expanded: new Set() },
  dupes: { loading: false, progress: null, result: null, selected: new Set(), minSize: 1024 },
  space: { loading: false, result: null, progress: null },
  batch: { names: [], template: '{name}_{n:3}', start: 1, find: '', replace: '', preview: null, totalSize: 0 },
  tagsPanel: { active: new Set(), matchAll: true, results: [] },
};

/* ------------------------------ 虚拟列表 ------------------------------ */

function cssPx(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const value = parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const list = new VirtualList({
  viewport: dom.viewport,
  content: dom.vcontent,
  rowHeight: () => (state.view === 'grid' ? cardHeight() + GRID_GAP : cssPx('--row-h', 54)),
  rowCount: () => (state.view === 'grid' ? Math.ceil(state.entries.length / state.cols) : state.entries.length),
  createRow: () => {
    const node = document.createElement('div');
    node.className = state.view === 'grid' ? 'vrow grid-row' : 'vrow';
    return node;
  },
  renderRow: (index, node) => {
    const grid = state.view === 'grid';
    const start = index * state.cols;
    if (grid) {
      const slice = state.entries.slice(start, start + state.cols);
      node.className = 'vrow grid-row';
      node.style.gridTemplateColumns = `repeat(${state.cols}, minmax(0, 1fr))`;
      node.innerHTML = slice
        .map((entry) =>
          gridCardHtml(entry, {
            selected: state.selected === entry.path,
            checked: state.checked.has(entry.path),
            favorite: state.favorites.has(normalizePath(entry.path)),
          }),
        )
        .join('');
    } else {
      const entry = state.entries[index];
      node.className = 'vrow';
      node.innerHTML = entry
        ? rowHtml(entry, {
            selected: state.selected === entry.path,
            checked: state.checked.has(entry.path),
            favorite: state.favorites.has(normalizePath(entry.path)),
          })
        : '';
    }

    /**
     * 入场动画只在"刚换完目录/刚筛完"的 420ms 窗口里挂，
     * 超出窗口就不再挂——否则滚动时复用的节点会把动画一遍遍重播。
     * 错开上限 11：再多的话滚到底部时最后一项要等半秒才出现。
     */
    if (Date.now() - state.enterAt < 420) {
      const items = grid ? [...node.children] : node.firstElementChild ? [node.firstElementChild] : [];
      items.forEach((el, offset) => {
        const seat = grid ? start + offset : index;
        el.style.setProperty('--i', String(Math.min(seat, 11)));
        el.classList.add('is-enter');
      });
    }
  },
  overscan: 6,
});

/* ------------------------------ 小工具 ------------------------------ */

function normalizePath(value) {
  return String(value || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function isSamePath(a, b) {
  return Boolean(a) && Boolean(b) && normalizePath(a) === normalizePath(b);
}

function parentOf(dir) {
  const normalized = String(dir || '').replace(/\//g, '\\').replace(/\\+$/, '');
  const cut = normalized.lastIndexOf('\\');
  if (cut < 0) return null;
  const parent = normalized.slice(0, cut);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

function segmentsOf(dir) {
  const normalized = String(dir || '').replace(/\//g, '\\');
  const match = normalized.match(/^([A-Za-z]:)\\?(.*)$/);
  if (!match) return [{ name: normalized, path: normalized }];
  const root = `${match[1]}\\`;
  const rest = match[2].split('\\').filter(Boolean);
  const parts = [{ name: match[1], path: root, root: true }];
  let cursor = root;
  for (const segment of rest) {
    cursor = `${cursor}${segment}\\`;
    parts.push({ name: segment, path: cursor.replace(/\\$/, '') });
  }
  return parts;
}

function toast(message, options = {}) {
  const el = document.createElement('div');
  el.className = `toast${options.error ? ' toast--error' : ''}`;
  el.innerHTML = `<span class="toast__dot"></span><span>${esc(message)}</span>`;
  if (options.action) {
    const action = document.createElement('button');
    action.className = 'toast__action';
    action.textContent = options.action.label;
    action.addEventListener('click', () => {
      el.remove();
      options.action.onClick();
    });
    el.appendChild(action);
  }
  dom.toasts.appendChild(el);
  setTimeout(() => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 220);
  }, options.duration ?? 3200);
}

function updateGutter() {
  const gutter = dom.viewport.offsetWidth - dom.viewport.clientWidth;
  dom.content.style.setProperty('--gutter', `${Math.max(0, gutter)}px`);
}

/* ------------------------------ 语言与文案 ------------------------------ */

/** 把 HTML 里带 data-i18n 的静态文案刷一遍 */
function applyStaticI18n() {
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  dom.search.placeholder = t('toolbar.search');
}

/* ------------------------------ 主题 ------------------------------ */

const media = window.matchMedia('(prefers-color-scheme: dark)');

function resolvedTheme() {
  if (state.theme === 'system') return media.matches ? 'dark' : 'light';
  return state.theme === 'dark' ? 'dark' : 'light';
}

function applyTheme(animate = true) {
  const theme = resolvedTheme();
  if (animate) {
    // 窗口开到这里就够了：DWM 重采样 acrylic tint 要 300~500ms，
    // 应用主题跟着一起淡过去，两边才不至于一个快一个慢露出马脚。
    document.documentElement.classList.add('theme-anim');
    setTimeout(() => document.documentElement.classList.remove('theme-anim'), 480);
  }
  document.documentElement.dataset.theme = theme;
  const label =
    state.theme === 'system' ? t('settings.theme.system') : state.theme === 'dark' ? t('settings.theme.dark') : t('settings.theme.light');
  dom.btnTheme.innerHTML = icon(state.theme === 'system' ? 'monitor' : theme === 'dark' ? 'moon' : 'sun', 15);
  dom.btnTheme.title = `${t('toolbar.theme')}：${label}`;
  // 主题切换会换掉 --tint-rgb，厚度按新主题重算一次
  if (booted) applyGlassTint();
}

media.addEventListener('change', () => {
  if (state.theme === 'system') applyTheme();
});

async function cycleTheme() {
  const order = ['light', 'dark', 'system'];
  const next = order[(order.indexOf(state.theme) + 1) % order.length];
  state.theme = next;
  applyTheme();
  await api.settings.save({ theme: next });
  const label =
    next === 'system' ? t('settings.theme.system') : next === 'dark' ? t('settings.theme.dark') : t('settings.theme.light');
  toast(t('toast.theme', { name: label }));
}

/**
 * 紧凑模式只有 420px 宽，长占位文案会被截在半个字上。
 * 换成短文案，比让用户看"筛选，回车可搜…"体面。
 */
function applyModeCopy() {
  const compact = document.documentElement.dataset.mode !== 'window';
  dom.search.placeholder = compact ? t('toolbar.searchShort') : t('toolbar.search');
}

function applyMotion(level) {
  document.documentElement.classList.toggle('motion-soft', level === 'soft');
  document.documentElement.classList.toggle('motion-off', level === 'off');
}

/* ------------------------------ 侧栏 ------------------------------ */

function renderSidebar() {
  dom.placeList.innerHTML = state.places
    .map((place) => {
      const active = isSamePath(place.dir, state.cwd) ? ' is-active' : '';
      return `<button class="place${active}" data-path="${esc(place.dir)}" title="${esc(place.dir)}">
        ${icon(place.icon, 16)}<span>${esc(place.name)}</span>
      </button>`;
    })
    .join('');

  const clouds = state.clouds.map((cloud) => {
    const active = isSamePath(cloud.dir, state.cwd) ? ' is-active' : '';
    return `<button class="place${active}" data-path="${esc(cloud.dir)}" title="${esc(cloud.dir)}">
      ${icon('globe', 16)}<span>${esc(cloud.name)}</span>
    </button>`;
  });

  dom.driveList.innerHTML = [...clouds, ...state.drives
    .map((drive) => {
      const active = isSamePath(drive.path, state.cwd) ? ' is-active' : '';
      return `<button class="place${active}" data-path="${esc(drive.path)}" title="${esc(drive.path)}">
        ${icon('drive', 16)}<span>${esc(drive.name)}</span>
      </button>`;
    })].join('');
}

/* -------------------- 紧凑模式：位置 / 磁盘浮层 -------------------- */

/**
 * 侧栏一旦隐藏，常用位置和「此电脑」的盘符入口就一起消失了。
 * 上一次 3.3 只修了「记住上次目录」，用户仍然只能待在那一个盘里 ——
 * 想换到 D: 盘得先回窗口模式。这个浮层把入口搬到标题栏，三种模式都能用。
 *
 * 每次打开都重新问一次主进程：插拔 U 盘、挂载网盘之后列表应该立刻是对的，
 * 而不是沿用开机时那一份。
 */
async function refreshPlaces() {
  try {
    const result = await api.places();
    if (result.ok) {
      state.places = result.data.places;
      state.drives = result.data.drives;
      state.clouds = result.data.clouds || [];
      renderSidebar();
    }
  } catch {
    /* 拉不到就用内存里那份，浮层照样能开 */
  }
}

function placeRow(item, kind) {
  const active = isSamePath(item.dir || item.path, state.cwd) ? ' is-active' : '';
  const path = item.dir || item.path;
  const iconName = kind === 'cloud' ? 'globe' : kind === 'drive' ? 'drive' : item.icon || 'folder';
  const sub = kind === 'drive' ? '本地磁盘' : kind === 'cloud' ? '云端' : '常用位置';
  return `<button class="placepop__item${active}" type="button" role="menuitem"
      data-path="${esc(path)}" title="${esc(path)}">
      <span class="placepop__ico">${icon(iconName, 15)}</span>
      <span class="placepop__text">
        <span class="placepop__name">${esc(item.name)}</span>
        <span class="placepop__sub">${esc(sub)}</span>
      </span>
    </button>`;
}

function placeGroup(label, rows) {
  if (!rows.length) return '';
  return `<div class="placepop__label">${esc(label)}</div>${rows.join('')}`;
}

function closePlacePop() {
  if (!dom.placePop || dom.placePop.hidden) return;
  dom.placePop.hidden = true;
  dom.placePop.innerHTML = '';
  window.removeEventListener('click', onPlaceOutside, true);
  window.removeEventListener('blur', closePlacePop);
  dom.btnPlaces?.setAttribute('aria-expanded', 'false');
}

function onPlaceOutside(event) {
  if (!dom.placePop.contains(event.target) && !dom.btnPlaces.contains(event.target)) closePlacePop();
}

async function openPlacePop() {
  if (!dom.placePop) return;
  if (!dom.placePop.hidden) return closePlacePop();

  await refreshPlaces();

  const html = [
    placeGroup(t('nav.places'), state.places.map((place) => placeRow(place, 'place'))),
    placeGroup('云端', state.clouds.map((cloud) => placeRow(cloud, 'cloud'))),
    placeGroup(t('nav.drives'), state.drives.map((drive) => placeRow(drive, 'drive'))),
  ]
    .filter(Boolean)
    .join('');

  dom.placePop.innerHTML = html || `<div class="placepop__empty">${esc(t('state.empty.title'))}</div>`;
  dom.placePop.hidden = false;
  dom.btnPlaces.setAttribute('aria-expanded', 'true');

  // 贴着按钮右上角展开，超出窗口就翻到左边
  const rect = dom.btnPlaces.getBoundingClientRect();
  dom.placePop.style.left = '0px';
  dom.placePop.style.top = '0px';
  const pop = dom.placePop.getBoundingClientRect();
  const left = clamp(rect.right - pop.width, 8, window.innerWidth - pop.width - 8);
  const top = clamp(rect.bottom + 6, 8, window.innerHeight - pop.height - 8);
  dom.placePop.style.left = `${left}px`;
  dom.placePop.style.top = `${top}px`;

  window.addEventListener('click', onPlaceOutside, true);
  window.addEventListener('blur', closePlacePop);

  dom.placePop.querySelector('.placepop__item.is-active')?.focus({ preventScroll: true });
}

if (dom.btnPlaces) {
  dom.btnPlaces.addEventListener('click', openPlacePop);
  dom.placePop.addEventListener('click', async (event) => {
    const item = event.target.closest('[data-path]');
    if (!item) return;
    closePlacePop();
    await navigate(item.dataset.path, { push: true });
  });
}

/* ------------------------------ 面包屑 ------------------------------ */

function renderCrumbs() {
  const parts = segmentsOf(state.cwd);
  const available = dom.crumbs.clientWidth || 320;

  let visible;
  if (parts.length <= 3) {
    visible = parts;
  } else if (available >= 430) {
    const hidden = parts.length > 4;
    visible = [
      parts[0],
      ...(hidden ? [{ ellipsis: true, path: parts[parts.length - 3].path }] : []),
      ...parts.slice(-3),
    ];
  } else if (available >= 190) {
    visible = [parts[0], { ellipsis: true, path: parts[parts.length - 2].path }, parts[parts.length - 1]];
  } else {
    // 侧边栏/悬浮模式下面包屑只剩百来像素，塞不下三级，只留当前目录
    visible = [parts[parts.length - 1]];
  }

  dom.crumbs.classList.toggle('is-solo', visible.length === 1);
  dom.crumbs.innerHTML = visible
    .map((part, index) => {
      const isLast = index === visible.length - 1;
      const sep = index === 0 ? '' : `<span class="crumb__sep">${icon('chevron', 11)}</span>`;
      if (part.ellipsis) {
        return `${sep}<button class="crumb crumb--ellipsis" data-path="${esc(part.path)}" title="跳到上级目录">…</button>`;
      }
      return `${sep}<button class="crumb${isLast ? ' is-current' : ''}" data-path="${esc(part.path)}" title="${esc(
        part.path,
      )}">${index === 0 ? icon('drive', 13) : ''}<span>${esc(part.name)}</span></button>`;
    })
    .join('');
  dom.crumbs.scrollLeft = 0;
}

/* ------------------------------ 列表 ------------------------------ */

function rebuildEntries() {
  const base = state.deep ? state.deep.entries : state.listing?.entries || [];
  let rows = filterEntries(base, state.query);
  // 轮盘筛选叠在关键词筛选之后：两者是"且"的关系，不是互斥
  if (state.wheelFilter) rows = rows.filter((entry) => bucketOf(entry).key === state.wheelFilter);
  /**
   * 范围筛选是最后一层：收藏看路径集合，最近看 mtime。
   * 它和关键词、轮盘分类是"且"的关系 —— 用户可以先筛分类再只看收藏。
   */
  if (state.scope === 'fav') {
    rows = rows.filter((entry) => state.favorites.has(normalizePath(entry.path)));
  } else if (state.scope === 'recent') {
    const cut = Date.now() - 7 * 24 * 60 * 60 * 1000;
    rows = rows.filter((entry) => Number(entry.mtime) >= cut);
  }
  state.entries = sortEntries(rows, state.sort);
}

/* ------------------------------ 分类轮盘 ------------------------------ */

/** 点扇区时的目标文件夹名。命中就直接进去，不命中就退化成筛选。 */
const BUCKET_FOLDERS = {
  image: ['图片', '照片', 'images', 'pictures', 'photos'],
  video: ['视频', 'video', 'videos', '影片'],
  doc: ['文档', 'documents', 'docs', '文件'],
  audio: ['音频', '音乐', 'music', 'audio', 'sound'],
  other: ['其他', 'others', 'misc'],
};

/** 当前目录里是否已有与这个桶同名的分类文件夹 */
function folderForBucket(key) {
  const aliases = BUCKET_FOLDERS[key];
  if (!aliases) return null;
  const dirs = (state.listing?.entries || []).filter((entry) => entry.isDir);
  const hit = dirs.find((entry) => aliases.includes(String(entry.name).toLowerCase()))
    || dirs.find((entry) => aliases.some((alias) => String(entry.name).toLowerCase().includes(alias)));
  return hit ? hit.path : null;
}

const wheelBase = () => (state.deep ? state.deep.entries : state.listing?.entries || []);

/**
 * 轮盘只在这些情况下重画：换目录、搜索、筛选、切视图。
 * 滚动不重画——它在列表外面，跟着滚动重画等于白烧 CPU。
 */
function renderWheel() {
  const base = wheelBase();
  const model = computeWheel(base);
  state.wheelModel = model;

  const compact = document.documentElement.dataset.mode !== 'window';
  // 空目录没有占比可言；紧凑模式窗口太窄，环会挤成一团，两种都收起
  const visible = model.total > 0 && !compact;
  dom.wheelBar.hidden = !visible;
  if (!visible) return;

  /* 窗口矮的时候默认收起：148px 的轮盘加内边距要占掉 172px，
     在 640px 高的最小窗口里会把列表挤到只剩一行半。用户手动开合过就以他的为准。 */
  const autoFold = window.innerHeight < 720;
  const folded = state.wheelFold === null ? autoFold : state.wheelFold;
  dom.wheelBar.classList.toggle('is-folded', folded);
  /* 收起时这条带子会缩成一行，得留一句摘要说明它是什么 */
  dom.wheelBar.dataset.total = `${model.total} 项 · ${model.buckets.length} 类`;
  dom.btnWheelFold.innerHTML = icon('chevron', 12);
  dom.btnWheelFold.title = folded ? '展开分类轮盘' : '收起分类轮盘';
  if (folded) return;

  dom.wheel.innerHTML = `${wheelSvg(model, state.wheelFilter)}<div class="wheel__center">${centerIdleHtml(
    model,
  )}</div>`;
  dom.wheelLegend.innerHTML = legendHtml(model, state.wheelFilter);
}

/** 悬停联动：扇区变粗 + 其余变淡 + 中心换成该分类的详情 + 图例同步 */
function wheelHover(index) {
  const model = state.wheelModel;
  const bucket = index >= 0 ? model.buckets[index] : null;
  if (index >= 0 && !bucket) return;

  dom.wheel.classList.toggle('is-hovering', Boolean(bucket));
  dom.wheel.querySelectorAll('.wheel__seg').forEach((seg) => {
    seg.classList.toggle('is-hot', Number(seg.dataset.index) === index);
  });
  dom.wheelLegend.querySelectorAll('.wheel-legend__row').forEach((row) => {
    row.classList.toggle('is-hover', Number(row.dataset.index) === index);
  });

  const center = dom.wheel.querySelector('.wheel__center');
  if (center) center.innerHTML = bucket ? centerHoverHtml(bucket) : centerIdleHtml(model);
}

/**
 * 点扇区/图例：
 * 1. 目录里已有同名分类文件夹 → 直接进去（"跳转到该分类的文件列表"）；
 * 2. 没有再退化成原地筛选，再点一次取消。
 */
async function applyWheelFilter(key) {
  if (!key) return;
  if (state.wheelFilter === key) {
    state.wheelFilter = '';
    state.enterAt = Date.now();
    renderList();
    renderWheel();
    return;
  }

  const target = folderForBucket(key);
  if (target) {
    state.wheelFilter = '';
    await navigate(target);
    return;
  }

  state.wheelFilter = key;
  state.enterAt = Date.now();
  renderList();
  renderWheel();
}

function clearWheelFilter() {
  if (!state.wheelFilter) return;
  state.wheelFilter = '';
  state.enterAt = Date.now();
  renderList();
  renderWheel();
}

function computeCols() {
  const width = dom.viewport.clientWidth - 24;
  state.cols = Math.max(1, Math.floor((width + GRID_GAP) / (MIN_CARD_W + GRID_GAP)));
}

function renderHead() {
  dom.tableHead.innerHTML = tableHeadHtml(state.sort);
  dom.tableHead.style.display = state.view === 'grid' ? 'none' : '';
}

/** 状态栏里的"正在按分类筛选"标记，点一下就取消 */
function wheelFilterChip() {
  if (!state.wheelFilter) return '';
  const bucket = WHEEL_BUCKETS.find((item) => item.key === state.wheelFilter);
  if (!bucket) return '';
  return `<button class="statusbar__chip statusbar__chip--filter" type="button" data-wheel-act="clear"
    title="取消分类筛选">${icon('filter', 11)}<span>只看${esc(bucket.label)}</span>
    <span class="statusbar__chip-x">×</span></button>`;
}

function renderStatus() {
  if (state.deep) {
    dom.statusbar.innerHTML = `<span class="statusbar__chip">${icon('search', 11)} ${esc(
      state.deep.keyword,
    )}</span>
      <span class="statusbar__dot"></span><span>${state.entries.length} 个结果</span>
      <span class="statusbar__spacer"></span>
      <span class="statusbar__chip">${icon('info', 12)} 结果来自当前文件夹及其子文件夹</span>`;
    return;
  }
  dom.statusbar.innerHTML =
    wheelFilterChip() +
    statusHtml({
      ...state,
      entries: state.entries,
      watching: state.watching,
      cloud: state.cloud,
    });
}

function renderList({ resetScroll = false } = {}) {
  rebuildEntries();
  if (state.view === 'grid') computeCols();
  renderHead();
  if (resetScroll) dom.viewport.scrollTop = 0;
  list.refresh();
  updateGutter();
  renderWheel();
  renderState();
  renderStatus();
  renderSelectionBar();
}

function renderState() {
  dom.skeleton.hidden = true;

  if (state.loading) {
    dom.skeleton.innerHTML = skeletonHtml(10);
    dom.skeleton.hidden = false;
    dom.stateLayer.hidden = true;
    dom.content.classList.remove('has-state');
    return;
  }

  let html = '';
  if (state.error) html = stateHtml(state.error.kind, { message: state.error.message });
  else if (!state.entries.length) {
    if (state.deep) html = stateHtml('search', { query: state.deep.keyword, deep: true });
    else if (state.query) html = stateHtml('search', { query: state.query });
    // 空状态要分清"这个文件夹是空的"和"这个范围里没有东西"
    else if (state.scope === 'fav') html = stateHtml('fav');
    else if (state.scope === 'recent') html = stateHtml('recent');
    else if (state.cwd) html = stateHtml('empty');
  }

  dom.content.classList.toggle('has-state', Boolean(html));
  if (html) {
    dom.stateLayer.innerHTML = html;
    dom.stateLayer.hidden = false;
  } else {
    dom.stateLayer.hidden = true;
  }
}

/* ------------------------------ 多选 ------------------------------ */

function renderSelectionBar() {
  const count = state.checked.size;
  dom.selectionBar.hidden = count === 0;
  if (!count) return;
  dom.selectionCount.textContent = t('batch.selected', { n: count });
}

function clearChecked() {
  state.checked.clear();
  renderSelectionBar();
  list.refresh();
}

/* ------------------------------ 详情 ------------------------------ */

function renderDetails() {
  dom.details.innerHTML = detailsHtml(state);
}

let detailToken = 0;

async function loadDetail(entry) {
  const token = (detailToken += 1);
  const [detail, preview] = await Promise.all([api.describe(entry.path), api.preview(entry.path)]);
  if (token !== detailToken) return;
  state.detail = detail.ok
    ? detail.data
    : { label: entry.desc?.label, brief: entry.desc?.brief, detail: '', hints: [] };
  state.preview = preview.ok ? preview.data : { kind: 'none', reason: preview.error };
  renderDetails();
}

function select(entry, { scroll = false, index = -1 } = {}) {
  if (!entry) {
    state.selected = null;
    state.selectedEntry = null;
    state.detail = null;
    state.preview = null;
    paintSelection();
    renderDetails();
    return;
  }
  state.selected = entry.path;
  state.selectedEntry = entry;
  state.detail = null;
  state.preview = null;
  paintSelection();
  renderDetails();
  loadDetail(entry);
  if (scroll && index >= 0) {
    const row = state.view === 'grid' ? Math.floor(index / state.cols) : index;
    list.scrollToIndex(row, 'nearest');
  }
}

function paintSelection() {
  for (const node of dom.vcontent.querySelectorAll('.is-selected')) node.classList.remove('is-selected');
  if (!state.selected) return;
  for (const node of dom.vcontent.querySelectorAll(`[data-path="${CSS.escape(state.selected)}"]`)) {
    node.classList.add('is-selected');
  }
}

/* ------------------------------ 导航 ------------------------------ */

function errorKind(code) {
  if (code === 'EACCES' || code === 'EPERM') return 'permission';
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
  return 'error';
}

let navToken = 0;

async function navigate(dir, options = {}) {
  if (!dir) return;
  const token = (navToken += 1);
  const { push = true, refresh = false, keepQuery = false } = options;
  // 换了目录，上一轮的分类筛选就不该继续生效，否则用户会看到"空文件夹"
  if (!isSamePath(dir, state.cwd)) state.wheelFilter = '';
  if (!keepQuery) {
    state.query = '';
    state.deep = null;
    dom.search.value = '';
  }

  state.loading = true;
  state.error = null;
  state.selected = null;
  state.selectedEntry = null;
  state.detail = null;
  state.preview = null;
  state.checked.clear();
  renderState();
  renderDetails();
  renderSelectionBar();

  const result = await api.list(dir, { showHidden: !state.settings.skipHidden, refresh });
  if (token !== navToken) return;

  if (!result.ok) {
    state.loading = false;
    state.error = { kind: errorKind(result.code), message: result.error };
    state.entries = [];
    state.listing = null;
    // 面包屑指向"用户想去但打不开"的位置，否则界面会显示成上一个目录出错
    state.cwd = dir;
    state.parentPath = parentOf(dir);
    renderCrumbs();
    renderSidebar();
    renderList();
    dom.titleMeta.textContent = t('app.openFailed');
    return;
  }

  const listing = result.data;
  state.loading = false;
  state.listing = listing;
  state.cwd = listing.dir;

  /**
   * 记住"上次在哪"。以前只在启动时读 lastFolder、从来不写，
   * 于是任何一次重启（含托盘常驻后重新打开、切模式后关掉再开）都会退回主目录 ——
   * 用户看到的就是"一切到侧边栏/悬浮，只剩 C 盘的文件"。
   * 800ms 防抖：连续点几下目录只写一次盘。
   */
  clearTimeout(navigate.persistTimer);
  navigate.persistTimer = setTimeout(() => {
    api.settings.save({ lastFolder: state.cwd });
  }, 800);
  state.tagMap = listing.tags || {};
  state.cloud = listing.cloud || null;
  state.watching = listing.watching || null;

  if (push) {
    state.history = state.history.slice(0, state.hIndex + 1);
    state.history.push(listing.dir);
    state.hIndex = state.history.length - 1;
  }

  dom.titleMeta.textContent = `${listing.name} · ${t('app.items', {
    n: listing.counts.files + listing.counts.dirs,
  })}`;
  // 换目录 = 一批新卡片，从这里开始 420ms 内渲染的行做淡入上滑
  state.enterAt = Date.now();
  renderCrumbs();
  renderSidebar();
  renderList({ resetScroll: true });
  renderDetails();
  updateNavButtons();
  syncSearchNote();

  // 实时监听跟着当前目录走
  if (state.settings.watchEnabled) {
    const watchResult = await api.watch(listing.dir, true);
    if (watchResult.ok) state.watching = watchResult.data;
    renderStatus();
  } else {
    api.watch(null, false);
    state.watching = null;
  }
}

function updateNavButtons() {
  dom.btnBack.disabled = state.hIndex <= 0;
  dom.btnForward.disabled = state.hIndex >= state.history.length - 1;
  dom.btnUp.disabled = !state.listing?.parent;
}

function goBack() {
  if (state.hIndex <= 0) return;
  state.hIndex -= 1;
  navigate(state.history[state.hIndex], { push: false });
}

function goForward() {
  if (state.hIndex >= state.history.length - 1) return;
  state.hIndex += 1;
  navigate(state.history[state.hIndex], { push: false });
}

function goUp() {
  const target = state.listing?.parent || state.parentPath;
  if (!target) return;
  navigate(target);
}

/* ------------------------------ 菜单 ------------------------------ */

function showMenu(x, y, items) {
  dom.menu.innerHTML = items
    .map((item) =>
      item.separator
        ? '<div class="menu__sep"></div>'
        : item.label && !item.action
          ? `<div class="menu__label">${esc(item.label)}</div>`
          : `<button class="menu__item${item.danger ? ' menu__item--danger' : ''}" data-menu-id="${item.id}">
              ${item.icon ? icon(item.icon, 15) : '<span style="width:15px"></span>'}
              <span>${esc(item.label)}</span>
            </button>`,
    )
    .join('');

  dom.menu.hidden = false;
  const rect = dom.menu.getBoundingClientRect();
  dom.menu.style.left = `${clamp(x, 8, window.innerWidth - rect.width - 8)}px`;
  dom.menu.style.top = `${clamp(y, 8, window.innerHeight - rect.height - 8)}px`;

  const close = () => {
    dom.menu.hidden = true;
    dom.menu.innerHTML = '';
    window.removeEventListener('click', onOutside, true);
    window.removeEventListener('blur', close);
  };
  const onOutside = (event) => {
    if (!dom.menu.contains(event.target)) close();
  };
  window.addEventListener('click', onOutside, true);
  window.addEventListener('blur', close);
  dom.menu.onclick = (event) => {
    const button = event.target.closest('[data-menu-id]');
    if (!button) return;
    const item = items.find((entry) => entry.id === button.dataset.menuId);
    close();
    item?.action?.();
  };
}

function entryMenu(entry, x, y) {
  const inSelection = state.checked.has(entry.path);
  showMenu(x, y, [
    { id: 'open', label: entry.isDir ? t('menu.openDir') : t('menu.open'), icon: 'open', action: () => openEntry(entry) },
    ...(entry.isDir
      ? []
      : [{ id: 'preview', label: t('menu.preview'), icon: 'eye', action: () => openPreview(entry) }]),
    { id: 'fav', label: t('menu.favorite'), icon: 'star', action: () => toggleFavorite(entry) },
    { id: 'reveal', label: t('menu.reveal'), icon: 'locate', action: () => revealEntry(entry) },
    { id: 'copy', label: t('menu.copy'), icon: 'copy', action: () => copyEntry(entry) },
    { separator: true },
    { id: 'tag', label: t('menu.tag'), icon: 'tag', action: () => openTagPicker(entry) },
    { id: 'exclude', label: t('menu.exclude'), icon: 'lock', action: () => addExclude(entry.name) },
    { separator: true },
    {
      id: 'batch',
      label: t('menu.batch'),
      icon: 'rename',
      action: () => {
        if (!inSelection) {
          state.checked.add(entry.path);
          renderSelectionBar();
          list.refresh();
        }
        openBatch();
      },
    },
    {
      id: 'move',
      label: t('menu.moveTo'),
      icon: 'folder',
      action: () => {
        if (!inSelection) {
          state.checked.add(entry.path);
          renderSelectionBar();
          list.refresh();
        }
        moveChecked();
      },
    },
    {
      id: 'delete',
      label: t('menu.delete'),
      icon: 'trash',
      action: () => {
        if (!inSelection) {
          state.checked.add(entry.path);
          renderSelectionBar();
          list.refresh();
        }
        trashChecked();
      },
    },
    { separator: true },
    { id: 'organize', label: t('menu.organize'), icon: 'folder', action: () => openOrganize() },
  ]);
}

async function openEntry(entry) {
  if (!entry) return;
  if (entry.isDir) return navigate(entry.path);
  const result = await api.open(entry.path);
  if (!result.ok) toast(result.error || t('toast.openFail'), { error: true });
}

async function revealEntry(entry) {
  if (!entry) return;
  const result = await api.reveal(entry.path);
  if (!result.ok) toast(result.error || t('toast.failed'), { error: true });
}

async function copyEntry(entry) {
  if (!entry) return;
  const result = await api.copyPath(entry.path);
  if (result.ok) toast(t('toast.copied'));
  else toast(result.error || t('toast.failed'), { error: true });
}

/* ------------------------------ 搜索 ------------------------------ */

function syncSearchNote() {
  let note = dom.content.querySelector('.search-note');
  if (!state.deep || !state.entries.length) {
    if (note) note.remove();
    return;
  }
  if (!note) {
    note = document.createElement('div');
    note.className = 'search-note';
    dom.content.insertBefore(note, dom.tableHead);
  }
  note.innerHTML = `${icon('search', 12)}<span>在子文件夹中找到 ${state.entries.length} 个结果</span>
    <button data-search-act="clear">退出搜索</button>`;
}

const applyFilter = debounce(() => {
  if (state.deep) return;
  /* 搜索结果是"逐项淡入"的，所以每次筛选都重置入场计时，让新一批行重新错开出现 */
  state.enterAt = Date.now();
  renderList({ resetScroll: true });
}, 90);

async function runDeepSearch() {
  const keyword = dom.search.value.trim();
  if (keyword.length < 2 || !state.cwd) return;
  toast(t('toolbar.searching'), { duration: 1200 });
  const result = await api.search(state.cwd, keyword);
  if (!result.ok) {
    toast(result.error || t('toast.failed'), { error: true });
    return;
  }
  const rows = (result.data.hits || []).map((item) => ({
    ...item,
    isDir: Boolean(item.isDir),
    ctime: item.ctime || item.mtime,
    desc: item.desc || { label: '文件', category: 'other', brief: '搜索结果' },
    tags: result.data.tags?.[item.path] || [],
  }));
  state.deep = { keyword, entries: rows };
  state.query = '';
  renderList({ resetScroll: true });
  syncSearchNote();
}

function clearSearch() {
  state.deep = null;
  state.query = '';
  dom.search.value = '';
  syncSearchNote();
  renderList({ resetScroll: true });
}

/* ------------------------------ 面板管理 ------------------------------ */

function openDrawer(kind) {
  state.panel = kind;
  dom.drawer.classList.add('is-open');
  dom.drawer.setAttribute('aria-hidden', 'false');
  dom.scrim.classList.add('is-open');
}

function openModal(kind) {
  state.panel = kind;
  dom.modal.classList.add('is-open');
  dom.modal.setAttribute('aria-hidden', 'false');
  dom.scrim.classList.add('is-open');
}

function closePanel() {
  state.panel = '';
  dom.drawer.classList.remove('is-open');
  dom.drawer.setAttribute('aria-hidden', 'true');
  dom.modal.classList.remove('is-open');
  dom.modal.setAttribute('aria-hidden', 'true');
  dom.scrim.classList.remove('is-open');
}

function renderPanel() {
  switch (state.panel) {
    case 'organize':
      dom.drawer.innerHTML = organizeHtml({
        organize: state.organize,
        cloudHint: state.organize.plan?.cloudHint || state.cloud?.name || '',
        dir: state.cwd,
      });
      break;
    case 'settings':
      dom.modal.innerHTML = settingsHtml(state);
      break;
    case 'dupes':
      dom.drawer.innerHTML = dupesHtml(state);
      break;
    case 'space':
      dom.drawer.innerHTML = spaceHtml(state);
      break;
    case 'batch':
      dom.drawer.innerHTML = batchHtml(state);
      break;
    case 'history':
      dom.drawer.innerHTML = historyHtml(state);
      break;
    case 'tags':
      dom.drawer.innerHTML = tagsHtml(state);
      break;
    default:
      break;
  }
}

/* ------------------------------ 整理 ------------------------------ */

async function openOrganize() {
  if (!state.cwd) return;
  state.organize = { loading: true, error: null, plan: null, selected: new Set(), busy: false, progress: null, expanded: new Set() };
  openDrawer('organize');
  renderPanel();

  const result = await api.previewPlan(state.cwd);
  state.organize.loading = false;
  if (!result.ok) {
    state.organize.error = result.error;
    renderPanel();
    return;
  }
  state.organize.plan = result.data;
  state.organize.selected = new Set(result.data.items.map((item) => item.name));
  renderPanel();
}

async function runOrganize() {
  const selected = [...state.organize.selected];
  if (!selected.length) return;
  state.organize.busy = true;
  state.organize.progress = { index: 0, total: selected.length, name: '' };
  renderPanel();

  const result = await api.execute(state.cwd, selected);
  state.organize.busy = false;

  if (!result.ok) {
    state.organize.error = result.error;
    renderPanel();
    toast(result.error || t('toast.failed'), { error: true });
    return;
  }

  const { moved, failed } = result.data;
  closePanel();
  await navigate(state.cwd, { push: false, refresh: true, keepQuery: true });
  const failedNote = failed?.length ? `，${failed.length} 个被占用未移动` : '';
  toast(t('organize.done', { n: moved }) + failedNote, {
    duration: 6000,
    action: { label: t('organize.undo'), onClick: undoLast },
  });
}

async function undoLast() {
  const result = await api.undo({});
  if (!result.ok) {
    toast(result.error || t('toast.failed'), { error: true });
    return;
  }
  const count = result.data?.restored ?? 0;
  await navigate(state.cwd, { push: false, refresh: true, keepQuery: true });
  toast(count ? t('toast.undone', { n: count }) : t('toast.nothingUndo'));
}

/* ------------------------------ 重复文件 ------------------------------ */

async function openDupes() {
  state.dupes = { loading: true, progress: null, result: null, selected: new Set(), minSize: state.settings.dupesMinSize || 1024 };
  openDrawer('dupes');
  renderPanel();
  await scanDupes();
}

async function scanDupes() {
  state.dupes.loading = true;
  state.dupes.progress = null;
  state.dupes.result = null;
  state.dupes.selected = new Set();
  renderPanel();

  const result = await api.dupes.scan(state.cwd, state.dupes.minSize);
  state.dupes.loading = false;
  if (!result.ok) {
    toast(result.error || t('toast.failed'), { error: true });
    state.dupes.result = { groups: [], totalWasted: 0, scanned: 0 };
    renderPanel();
    return;
  }
  state.dupes.result = result.data;
  // 默认勾选每组除第一份（最老）之外的所有副本
  const selected = new Set();
  for (const group of result.data.groups) {
    group.items.slice(1).forEach((item) => selected.add(item.path));
  }
  state.dupes.selected = selected;
  renderPanel();
}

async function cleanDupes() {
  const paths = [...state.dupes.selected];
  if (!paths.length) return;
  const result = await api.dupes.trash(paths);
  if (!result.ok) {
    toast(result.error || t('toast.failed'), { error: true });
    return;
  }
  toast(t('dupes.done', { n: result.data.removed.length }));
  await navigate(state.cwd, { push: false, refresh: true, keepQuery: true });
  await scanDupes();
}

/* ------------------------------ 空间分析 ------------------------------ */

async function openSpace() {
  state.space = { loading: true, result: null, progress: null };
  openDrawer('space');
  renderPanel();
  const result = await api.analyzeSpace(state.cwd);
  state.space.loading = false;
  if (!result.ok) {
    toast(result.error || t('toast.failed'), { error: true });
    state.space.result = null;
    renderPanel();
    return;
  }
  state.space.result = result.data;
  renderPanel();
}

/* ------------------------------ 批量 ------------------------------ */

function selectedEntries() {
  return state.entries.filter((entry) => state.checked.has(entry.path) && !entry.isDir);
}

async function openBatch() {
  const entries = selectedEntries();
  if (!entries.length) {
    toast(t('batch.noSelection'), { error: true });
    return;
  }
  state.batch.names = entries.map((entry) => entry.name);
  state.batch.totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
  state.batch.preview = null;
  openDrawer('batch');
  renderPanel();
  await refreshBatchPreview();
}

async function refreshBatchPreview() {
  if (!state.batch.names.length) return;
  const result = await api.batch.preview(state.cwd, state.batch.names, {
    template: state.batch.template,
    start: state.batch.start,
    find: state.batch.find,
    replace: state.batch.replace,
  });
  if (!result.ok) return;
  state.batch.preview = result.data;
  renderPanel();
}

async function runBatchRename() {
  const result = await api.batch.rename(state.cwd, state.batch.names, {
    template: state.batch.template,
    start: state.batch.start,
    find: state.batch.find,
    replace: state.batch.replace,
  });
  if (!result.ok) {
    toast(result.error || t('toast.failed'), { error: true });
    return;
  }
  closePanel();
  clearChecked();
  await navigate(state.cwd, { push: false, refresh: true, keepQuery: true });
  toast(t('batch.done', { n: result.data.renamed }), {
    duration: 6000,
    action: { label: t('organize.undo'), onClick: undoLast },
  });
}

async function runArchive() {
  const password = dom.drawer.querySelector('[data-batch="password"]')?.value || '';
  const result = await api.batch.archive(state.cwd, state.batch.names, { password });
  if (!result.ok) {
    toast(result.error || t('toast.failed'), { error: true });
    return;
  }
  const name = result.data.outPath.split('\\').pop();
  toast(t('batch.archived', { name }));
  await navigate(state.cwd, { push: false, refresh: true, keepQuery: true });
}

/* ------------------------------ 历史 ------------------------------ */

async function openHistory() {
  openDrawer('history');
  renderPanel();
  const result = await api.history(60);
  state.historyList = result.ok ? result.data.items : [];
  renderPanel();
}

/* ------------------------------ 标签 ------------------------------ */

async function openTags() {
  state.tagsPanel = { active: new Set(), matchAll: true, results: [] };
  openDrawer('tags');
  renderPanel();
  await refreshTags();
}

async function refreshTags() {
  const result = await api.tags.list();
  if (result.ok) state.tagList = result.data.tags;
  if (state.panel === 'tags') await refreshTagResults();
  else renderPanel();
}

async function refreshTagResults() {
  const ids = [...state.tagsPanel.active];
  if (!ids.length) {
    state.tagsPanel.results = [];
    renderPanel();
    return;
  }
  const result = await api.searchByTags(state.cwd, ids, state.tagsPanel.matchAll);
  state.tagsPanel.results = result.ok ? result.data.hits : [];
  renderPanel();
}

/** 标签选择弹层：定位在锚点元素下方 */
function openTagPicker(entry, anchor) {
  const rect = anchor?.getBoundingClientRect();
  const owned = new Set((state.tagMap[entry.path] || entry.tags || []).map((tag) => tag.id));
  showMenu(rect ? rect.left : 200, rect ? rect.bottom + 6 : 200, [
    { label: t('detail.tags') },
    ...(state.tagList || []).map((tag) => ({
      id: `tag-${tag.id}`,
      label: `${owned.has(tag.id) ? '✓ ' : ''}${tag.name}`,
      icon: 'tag',
      action: async () => {
        const next = new Set(owned);
        if (next.has(tag.id)) next.delete(tag.id);
        else next.add(tag.id);
        const result = await api.tags.set(entry.path, [...next]);
        if (result.ok) {
          state.tagMap = { ...state.tagMap, [entry.path]: result.data.tags };
          entry.tags = result.data.tags;
          renderDetails();
          list.refresh();
          refreshTags();
          toast(t('toast.tagged'));
        }
      },
    })),
    { separator: true },
    { id: 'manage', label: t('tags.manage'), icon: 'gear', action: () => openSettings('tags') },
  ]);
}

async function addExclude(name) {
  const excludes = [...(state.settings.excludes || [])];
  if (excludes.some((item) => item.value === name)) {
    toast('已经在排除名单里了');
    return;
  }
  excludes.push({ id: `ex-${Date.now().toString(36)}`, value: name, kind: 'name', enabled: true });
  const result = await api.settings.save({ excludes });
  if (result.ok) {
    state.settings.excludes = excludes;
    toast(t('toast.excluded'));
  }
}

/* ------------------------------ 设置 ------------------------------ */

async function openSettings(tab) {
  state.settingsTab = tab || state.settingsTab || 'appearance';
  openModal('settings');
  renderPanel();
  await Promise.all([refreshTagList(), refreshPlugins(), refreshSchedule()]);
  renderPanel();
}

async function refreshTagList() {
  const result = await api.tags.list();
  if (result.ok) state.tagList = result.data.tags;
}

async function refreshPlugins() {
  const result = await api.plugins.list();
  if (result.ok) state.pluginData = result.data;
}

async function refreshSchedule() {
  const result = await api.schedule.status();
  if (result.ok) state.scheduleStatus = result.data;
}

/** 保存设置后统一刷新本地状态 */
async function saveSettings(patch, { rerender = true } = {}) {
  const result = await api.settings.save(patch);
  if (!result.ok) {
    toast(result.error || t('toast.failed'), { error: true });
    return null;
  }
  state.settings = result.data.settings;
  state.categories = result.data.categories;
  if (rerender) renderPanel();
  return result.data;
}


/* ------------------------------ 收藏与范围 ------------------------------ */

const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

function isFavorite(path) {
  return state.favorites.has(normalizePath(path));
}

function syncScope() {
  if (!dom.scopeBar) return;
  for (const button of dom.scopeBar.querySelectorAll('[data-scope]')) {
    const active = button.dataset.scope === state.scope;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function setScope(scope) {
  if (!['all', 'fav', 'recent'].includes(scope) || state.scope === scope) return;
  state.scope = scope;
  syncScope();
  renderList({ resetScroll: true });
}

dom.scopeBar.addEventListener('click', (event) => {
  const button = event.target.closest('[data-scope]');
  if (button) setScope(button.dataset.scope);
});

/**
 * 收藏只存路径，不存文件内容。
 * 好处是文件被重命名/删除后收藏自然失效，不用维护同步；坏处是重命名后会掉收藏，
 * 这是可接受的 —— 总比存一份索引然后和磁盘对不上强。
 */
async function toggleFavorite(entry) {
  if (!entry) return;
  const key = normalizePath(entry.path);
  if (state.favorites.has(key)) {
    state.favorites.delete(key);
    state.favoriteList = state.favoriteList.filter((item) => normalizePath(item) !== key);
    toast(t('toast.unfav'));
  } else {
    state.favorites.add(key);
    state.favoriteList.unshift(entry.path);
    toast(t('toast.fav'));
  }
  list.refresh();
  const result = await api.settings.save({ favorites: state.favoriteList });
  if (!result.ok) toast(result.error || t('toast.failed'), { error: true });
}

/* ------------------------------ 快速预览 ------------------------------ */

const PREVIEW_IMAGE = /\.(png|jpe?g|gif|webp|bmp|avif|svg|ico)$/i;
const PREVIEW_TEXT = /\.(txt|md|markdown|log|json|js|mjs|cjs|ts|tsx|jsx|css|scss|html|xml|yml|yaml|ini|toml|cfg|conf|csv)$/i;
const PREVIEW_PDF = /\.pdf$/i;

let previewEntry = null;

function fileUrl(target) {
  return `file://${String(target).replace(/\\/g, '/')}`;
}

function closePreview() {
  if (dom.preview.hidden) return;
  dom.preview.hidden = true;
  dom.preview.setAttribute('aria-hidden', 'true');
  // 清空 body：PDF/视频的 iframe 不销毁会一直在后台跑
  dom.previewBody.innerHTML = '';
  previewEntry = null;
}

async function openPreview(entry) {
  if (!entry || entry.isDir) return openEntry(entry);
  previewEntry = entry;
  dom.preview.hidden = false;
  dom.preview.setAttribute('aria-hidden', 'false');
  dom.previewTitle.textContent = entry.name;
  dom.previewSub.textContent = `${entry.desc?.label || ''} · ${
    entry.isDir ? '' : formatSize(entry.size)
  } · ${formatRelative(entry.mtime)}`;
  dom.previewOpen.textContent = t('preview.open');
  dom.previewClose.textContent = t('preview.close');
  dom.previewBody.innerHTML = `<div class="preview__hint">${esc(t('preview.loading'))}</div>`;

  const src = fileUrl(entry.path);
  try {
    if (PREVIEW_IMAGE.test(entry.name)) {
      dom.previewBody.innerHTML = `<img class="preview__img" src="${esc(src)}" alt="${esc(entry.name)}" />`;
      return;
    }
    if (PREVIEW_PDF.test(entry.name)) {
      // Chromium 自带阅读器；关掉自带的工具栏，只留第一页的样子
      dom.previewBody.innerHTML = `<iframe class="preview__pdf" src="${esc(src)}#view=FitH&toolbar=0&navpanes=0&scrollbar=0" title="${esc(entry.name)}"></iframe>`;
      return;
    }
    if (PREVIEW_TEXT.test(entry.name)) {
      const result = await api.peek(entry.path);
      if (previewEntry !== entry) return; // 期间换了文件，丢弃这次结果
      if (result.ok && result.data?.kind === 'text') {
        const note = result.data.truncated
          ? `<div class="preview__note">${esc(t('preview.truncated', { n: Math.round((result.data.text.length || 0) / 1024) }))}</div>`
          : '';
        dom.previewBody.innerHTML = `${note}<pre class="preview__text">${esc(result.data.text)}</pre>`;
        return;
      }
    }
    dom.previewBody.innerHTML = `<div class="preview__hint">${esc(t('preview.unsupported'))}</div>`;
  } catch (err) {
    dom.previewBody.innerHTML = `<div class="preview__hint">${esc(String(err?.message || err))}</div>`;
  }
}

dom.previewClose.addEventListener('click', closePreview);
dom.preview.querySelector('[data-preview-close]').addEventListener('click', closePreview);
dom.previewOpen.addEventListener('click', () => {
  if (previewEntry) {
    api.open(previewEntry.path);
    closePreview();
  }
});

/* ------------------------------ 确认框 ------------------------------ */

/**
 * 只有危险操作才弹。整理、移动这类可撤销的动作不打断用户。
 * 返回 Promise<boolean>，调用处直接 await。
 */
function confirmAction({ title, body, ok = t('confirm.ok') }) {
  return new Promise((resolve) => {
    const layer = document.createElement('div');
    layer.className = 'confirm';
    layer.innerHTML = `
      <div class="confirm__scrim" data-confirm-cancel></div>
      <div class="confirm__panel" role="dialog" aria-modal="true">
        <div class="confirm__title">${esc(title)}</div>
        <div class="confirm__body">${esc(body)}</div>
        <div class="confirm__acts">
          <button class="btn btn--sm" type="button" data-confirm-cancel>${esc(t('confirm.cancel'))}</button>
          <button class="btn btn--sm btn--danger" type="button" data-confirm-ok>${esc(ok)}</button>
        </div>
      </div>`;
    document.body.appendChild(layer);
    const done = (value) => {
      layer.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        done(false);
      }
    };
    document.addEventListener('keydown', onKey, true);
    layer.querySelector('[data-confirm-ok]').addEventListener('click', () => done(true));
    for (const close of layer.querySelectorAll('[data-confirm-cancel]')) {
      close.addEventListener('click', () => done(false));
    }
    layer.querySelector('[data-confirm-ok]').focus();
  });
}

/* ------------------------------ 批量删除 / 移动 ------------------------------ */

function checkedEntries() {
  return state.entries.filter((entry) => state.checked.has(entry.path));
}

async function trashChecked() {
  const entries = checkedEntries();
  if (!entries.length) return;
  const ok = await confirmAction({
    title: t('confirm.delete.title'),
    body: t('confirm.delete.body', { n: entries.length }),
    ok: t('sel.delete'),
  });
  if (!ok) return;
  // 逐个删：IPC 层也做了逐个兜底，这里拿到的是"成功/失败"两份清单
  const result = await api.trash(entries.map((entry) => entry.path));
  if (!result.ok) {
    toast(result.error || t('toast.failed'), { error: true });
    return;
  }
  const done = result.data?.done?.length || 0;
  const failed = result.data?.failed?.length || 0;
  toast(
    failed
      ? `${t('toast.trashed', { n: done })} · ${failed} 项失败`
      : t('toast.trashed', { n: done }),
  );
  clearChecked();
  await navigate(state.cwd, { push: false, refresh: true, keepQuery: true });
}

async function moveChecked() {
  const entries = checkedEntries();
  if (!entries.length) return;
  const picked = await api.pickFolder(t('confirm.move.title'));
  if (!picked.ok || !picked.data?.path) return;
  const dest = picked.data.path;
  const result = await api.moveTo(entries.map((entry) => entry.path), dest);
  if (!result.ok) {
    toast(result.error || t('toast.failed'), { error: true });
    return;
  }
  const done = result.data?.done?.length || 0;
  toast(t('toast.moved', { n: done }));
  clearChecked();
  await navigate(state.cwd, { push: false, refresh: true, keepQuery: true });
}

/* ------------------------------ 拖拽归类 ------------------------------ */

/**
 * 把卡片拖到轮盘的某个分类上，就把文件移进这个分类文件夹。
 *
 * 自动分类总有判错的，比起右键菜单里翻“移动到…”再选目录，拖一下最直接。
 * 拖的是“当前勾选的所有文件”还是“这一个”，由 dragstart 时的选中状态决定。
 */
dom.vcontent.addEventListener('dragstart', (event) => {
  const holder = event.target.closest?.('[data-path]');
  if (!holder) return;
  const path = holder.dataset.path;
  const paths = state.checked.has(path) ? [...state.checked] : [path];
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', JSON.stringify(paths));
  dom.wheel.classList.add('is-dropping');
});

dom.vcontent.addEventListener('dragend', () => {
  dom.wheel.classList.remove('is-dropping');
  dom.wheel.querySelectorAll('.is-drop').forEach((node) => node.classList.remove('is-drop'));
});

function dropTargetIndex(event) {
  const node = event.target.closest?.('[data-index]');
  if (!node || !dom.wheel.contains(node)) return -1;
  return Number(node.dataset.index);
}

dom.wheel.addEventListener('dragover', (event) => {
  const index = dropTargetIndex(event);
  if (index < 0) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  dom.wheel.querySelectorAll('.is-drop').forEach((node) => node.classList.remove('is-drop'));
  event.target.closest('[data-index]').classList.add('is-drop');
});

dom.wheel.addEventListener('drop', async (event) => {
  const index = dropTargetIndex(event);
  if (index < 0) return;
  event.preventDefault();
  dom.wheel.querySelectorAll('.is-drop').forEach((node) => node.classList.remove('is-drop'));
  dom.wheel.classList.remove('is-dropping');

  let paths = [];
  try {
    paths = JSON.parse(event.dataTransfer.getData('text/plain') || '[]');
  } catch {
    paths = [];
  }
  if (!paths.length) return;

  const bucket = state.wheelModel?.buckets?.[index];
  if (!bucket) return;

  const existing = folderForBucket(bucket.key);
  const folder = existing || state.cwd + '\\' + (BUCKET_FOLDERS[bucket.key] || ['其他'])[0];
  const result = await api.moveTo(paths, folder, { create: true });
  if (!result.ok) {
    toast(result.error || t('toast.failed'), { error: true });
    return;
  }
  toast(t('toast.classified', { n: result.data?.done?.length || 0 }));
  clearChecked();
  await navigate(state.cwd, { push: false, refresh: true, keepQuery: true });
});

/* ------------------------------ 新手引导 ------------------------------ */

/**
 * 第一次打开时的三步引导：选文件夹 → 看分类 → 开始。
 * 三件事同屏，不做“点一步翻一页”的向导 —— 用户一眼就能看到要发生什么。
 */
function maybeOnboard() {
  if (state.settings.onboarded) return;
  const defaultDir =
    state.places.find((place) => place.key === 'downloads')?.dir || state.cwd || '';
  let chosen = defaultDir;

  const layer = document.createElement('div');
  layer.className = 'onboard';
  layer.innerHTML = `
    <div class="onboard__scrim"></div>
    <div class="onboard__panel" role="dialog" aria-modal="true">
      <div class="onboard__title">${esc(t('onboard.title'))}</div>
      <div class="onboard__sub">${esc(t('onboard.sub'))}</div>

      <div class="onboard__steps">
        <div class="onboard__step">
          <span class="onboard__num">1</span>
          <div class="onboard__body">
            <div class="onboard__label">${esc(t('onboard.pick'))}</div>
            <div class="onboard__path" id="onboardPath">${esc(chosen || '—')}</div>
          </div>
          <button class="btn btn--sm" type="button" id="onboardPick">${esc(t('onboard.choose'))}</button>
        </div>

        <div class="onboard__step">
          <span class="onboard__num">2</span>
          <div class="onboard__body">
            <div class="onboard__label">${esc(t('onboard.rules'))}</div>
            <div class="onboard__path">${esc(t('onboard.rulesHint'))}</div>
          </div>
          <button class="btn btn--sm btn--ghost" type="button" id="onboardRules">${esc(t('onboard.editRules'))}</button>
        </div>

        <div class="onboard__step">
          <span class="onboard__num">3</span>
          <div class="onboard__body">
            <div class="onboard__label">${esc(t('onboard.go'))}</div>
            <div class="onboard__path">${esc(t('onboard.goHint'))}</div>
          </div>
        </div>
      </div>

      <div class="onboard__acts">
        <button class="btn btn--sm btn--ghost" type="button" id="onboardSkip">${esc(t('onboard.skip'))}</button>
        <button class="btn btn--sm btn--primary" type="button" id="onboardStart">${esc(t('onboard.start'))}</button>
      </div>
    </div>`;
  document.body.appendChild(layer);

  const finish = async (open) => {
    layer.remove();
    state.settings.onboarded = true;
    await api.settings.save({ onboarded: true });
    if (open === 'rules') openSettings('rules');
  };

  layer.querySelector('#onboardPick').addEventListener('click', async () => {
    const picked = await api.pickFolder(t('onboard.pick'));
    if (picked.ok && picked.data?.path) {
      chosen = picked.data.path;
      layer.querySelector('#onboardPath').textContent = chosen;
    }
  });

  layer.querySelector('#onboardRules').addEventListener('click', () => finish('rules'));
  layer.querySelector('#onboardSkip').addEventListener('click', () => finish());
  layer.querySelector('#onboardStart').addEventListener('click', async () => {
    await finish();
    if (!chosen) return;
    await navigate(chosen);
    openOrganize();
  });
}

/* ------------------------------ 事件：列表 ------------------------------ */

dom.vcontent.addEventListener('click', (event) => {
  const check = event.target.closest('[data-check]');
  if (check) {
    event.stopPropagation();
    const target = check.dataset.check;
    if (state.checked.has(target)) state.checked.delete(target);
    else state.checked.add(target);
    renderSelectionBar();
    list.refresh();
    return;
  }

  const action = event.target.closest('[data-act]');
  const holder = event.target.closest('[data-path]');
  if (!holder) {
    select(null);
    return;
  }
  const entry = state.entries.find((item) => item.path === holder.dataset.path);
  if (!entry) return;

  if (action) {
    event.stopPropagation();
    const act = action.dataset.act;
    if (act === 'open') openEntry(entry);
    else if (act === 'fav') toggleFavorite(entry);
    else if (act === 'preview') openPreview(entry);
    else if (act === 'menu') {
      const rect = action.getBoundingClientRect();
      entryMenu(entry, rect.left, rect.bottom + 4);
    }
    return;
  }

  // Ctrl / Cmd 点选 = 多选；Shift 点选 = 连选
  if (event.ctrlKey || event.metaKey) {
    if (state.checked.has(entry.path)) state.checked.delete(entry.path);
    else state.checked.add(entry.path);
    renderSelectionBar();
    list.refresh();
    return;
  }
  if (event.shiftKey && state.selected) {
    const from = state.entries.findIndex((item) => item.path === state.selected);
    const to = state.entries.findIndex((item) => item.path === entry.path);
    if (from >= 0 && to >= 0) {
      for (let i = Math.min(from, to); i <= Math.max(from, to); i += 1) {
        state.checked.add(state.entries[i].path);
      }
      renderSelectionBar();
      list.refresh();
      return;
    }
  }

  select(entry);
});

dom.vcontent.addEventListener('dblclick', (event) => {
  const holder = event.target.closest('[data-path]');
  if (!holder) return;
  const entry = state.entries.find((item) => item.path === holder.dataset.path);
  if (!entry) return;
  // 文件夹仍然是"进去"；文件改成内嵌预览，不再拉起外部程序
  if (entry.isDir) openEntry(entry);
  else openPreview(entry);
});

dom.vcontent.addEventListener('contextmenu', (event) => {
  const holder = event.target.closest('[data-path]');
  if (!holder) return;
  event.preventDefault();
  const entry = state.entries.find((item) => item.path === holder.dataset.path);
  if (!entry) return;
  if (!state.checked.has(entry.path)) select(entry);
  entryMenu(entry, event.clientX, event.clientY);
});

/** 缩略图失败兜底：换成分类图标，避免显示浏览器的碎图占位 */
dom.vcontent.addEventListener(
  'error',
  (event) => {
    if (!(event.target instanceof HTMLImageElement)) return;
    const holder = event.target.closest('.file-ico');
    if (!holder) return;
    const holderPath = holder.closest('[data-path]')?.dataset.path;
    const entry = state.entries.find((item) => item.path === holderPath);
    if (!entry) return;
    const size = holder.classList.contains('grid-card__thumb') ? 30 : 17;
    holder.innerHTML = icon(categoryIcon(entry.desc?.category), size);
    holder.dataset.tone = categoryTone(entry.desc?.category);
  },
  true,
);

/* ------------------------------ 事件：工具栏 ------------------------------ */

dom.tableHead.addEventListener('click', (event) => {
  const cell = event.target.closest('[data-sort]');
  if (!cell) return;
  const key = cell.dataset.sort;
  if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
  else state.sort = { key, dir: key === 'name' ? 'asc' : 'desc' };
  renderList();
  api.settings.save({ sortBy: state.sort.key, sortDir: state.sort.dir });
});

dom.crumbs.addEventListener('click', (event) => {
  const crumb = event.target.closest('[data-path]');
  if (crumb) navigate(crumb.dataset.path);
});

for (const container of [dom.placeList, dom.driveList]) {
  container.addEventListener('click', (event) => {
    const place = event.target.closest('[data-path]');
    if (place) navigate(place.dataset.path);
  });
}

dom.btnBack.addEventListener('click', goBack);
dom.btnForward.addEventListener('click', goForward);
dom.btnUp.addEventListener('click', goUp);
dom.btnRefresh.addEventListener('click', () => navigate(state.cwd, { push: false, refresh: true, keepQuery: true }));
dom.btnTheme.addEventListener('click', cycleTheme);
dom.btnList.addEventListener('click', () => setView('list'));
dom.btnGrid.addEventListener('click', () => setView('grid'));

/* 轮盘：扇区与图例双向联动，点一下跳转或筛选 */
const segIndexOf = (node) => {
  const seg = node.closest?.('.wheel__seg');
  return seg ? Number(seg.dataset.index) : -1;
};

dom.wheel.addEventListener('pointerover', (event) => {
  const index = segIndexOf(event.target);
  if (index >= 0) wheelHover(index);
});
dom.wheel.addEventListener('pointerleave', () => wheelHover(-1));
dom.wheel.addEventListener('click', (event) => {
  const seg = event.target.closest('.wheel__seg');
  if (seg) applyWheelFilter(seg.dataset.bucket);
});

dom.wheelLegend.addEventListener('pointerover', (event) => {
  const row = event.target.closest('.wheel-legend__row');
  if (row) wheelHover(Number(row.dataset.index));
});
dom.wheelLegend.addEventListener('pointerleave', () => wheelHover(-1));
dom.wheelLegend.addEventListener('click', (event) => {
  const row = event.target.closest('.wheel-legend__row');
  if (row) applyWheelFilter(row.dataset.bucket);
});

dom.btnWheelFold.addEventListener('click', () => {
  const current = state.wheelFold === null ? window.innerHeight < 720 : state.wheelFold;
  state.wheelFold = !current;
  renderWheel();
  // 收起/展开改变了列表可用高度，虚拟列表得重算行数
  list.schedule();
});

/* 状态栏的分类筛选标记：点掉 */
dom.statusbar.addEventListener('click', (event) => {
  if (event.target.closest('[data-wheel-act="clear"]')) clearWheelFilter();
});

async function setView(view) {
  if (state.view === view) return;
  state.view = view;
  dom.btnList.classList.toggle('is-active', view === 'list');
  dom.btnGrid.classList.toggle('is-active', view === 'grid');
  // 换视图等于换一批卡片，同样走一次淡入上滑
  state.enterAt = Date.now();
  renderList({ resetScroll: true });
  await api.settings.save({ viewMode: view });
}

dom.btnDetail.addEventListener('click', async () => {
  state.detailOpen = !state.detailOpen;
  dom.details.classList.toggle('is-collapsed', !state.detailOpen);
  dom.btnDetail.classList.toggle('is-active', state.detailOpen);
  await api.settings.save({ detailOpen: state.detailOpen });
  list.schedule();
});

dom.search.addEventListener('input', () => {
  state.query = dom.search.value;
  if (state.deep) {
    state.deep = null;
    syncSearchNote();
  }
  applyFilter();
});

dom.search.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') runDeepSearch();
  if (event.key === 'Escape') clearSearch();
});

dom.content.addEventListener('click', (event) => {
  const act = event.target.closest('[data-state-act]');
  if (act) {
    const kind = act.dataset.stateAct;
    if (kind === 'retry') navigate(state.cwd, { push: false, refresh: true, keepQuery: true });
    else if (kind === 'up') goUp();
    else if (kind === 'clear') clearSearch();
    return;
  }
  if (event.target.closest('[data-search-act="clear"]')) clearSearch();
});

/* 选择条 */
dom.selectionBar.addEventListener('click', async (event) => {
  const act = event.target.closest('[data-sel-act]');
  if (!act) return;
  const kind = act.dataset.selAct;
  if (kind === 'clear') return clearChecked();
  if (kind === 'move') return moveChecked();
  if (kind === 'delete') return trashChecked();
  if (kind === 'batch') return openBatch();
  if (kind === 'archive') return openBatch();
  if (kind === 'tag') {
    const entries = selectedEntries();
    if (!entries.length) return;
    openTagPicker(entries[0], act);
    return;
  }
  if (kind === 'exclude') {
    for (const entry of selectedEntries()) await addExclude(entry.name);
    clearChecked();
  }
});

/* ------------------------------ 事件：详情 ------------------------------ */

dom.details.addEventListener('click', async (event) => {
  const tagRemove = event.target.closest('[data-tag-remove]');
  if (tagRemove) {
    const entry = state.selectedEntry;
    if (!entry) return;
    const result = await api.tags.removeFrom([entry.path], [tagRemove.dataset.tagRemove]);
    if (result.ok) {
      state.tagMap = { ...state.tagMap, [entry.path]: result.data.map?.[entry.path] || [] };
      renderDetails();
      list.refresh();
      refreshTags();
    }
    return;
  }
  if (event.target.closest('[data-tag-add]')) {
    if (state.selectedEntry) openTagPicker(state.selectedEntry, event.target.closest('[data-tag-add]'));
    return;
  }

  const act = event.target.closest('[data-detail-act]');
  if (!act) return;
  const entry = state.selectedEntry;
  if (!entry) return;
  if (act.dataset.detailAct === 'open') openEntry(entry);
  else if (act.dataset.detailAct === 'reveal') revealEntry(entry);
  else if (act.dataset.detailAct === 'copy') copyEntry(entry);
});

dom.details.addEventListener(
  'error',
  (event) => {
    if (!(event.target instanceof HTMLImageElement)) return;
    event.target.replaceWith(
      Object.assign(document.createElement('span'), {
        className: 'preview-empty',
        textContent: t('preview.unsupported'),
      }),
    );
  },
  true,
);

/* ------------------------------ 事件：抽屉 ------------------------------ */

dom.drawer.addEventListener('click', async (event) => {
  /* 整理 */
  const orgCheck = event.target.closest('[data-org-check]');
  if (orgCheck) {
    const name = orgCheck.dataset.orgCheck;
    if (state.organize.selected.has(name)) state.organize.selected.delete(name);
    else state.organize.selected.add(name);
    renderPanel();
    return;
  }
  const orgGroup = event.target.closest('[data-org-group]');
  if (orgGroup) {
    const folder = orgGroup.dataset.orgGroup;
    const items = (state.organize.plan?.items || []).filter((item) => item.folder === folder);
    const allIn = items.every((item) => state.organize.selected.has(item.name));
    for (const item of items) {
      if (allIn) state.organize.selected.delete(item.name);
      else state.organize.selected.add(item.name);
    }
    renderPanel();
    return;
  }
  const orgAct = event.target.closest('[data-org-act]');
  if (orgAct) {
    const kind = orgAct.dataset.orgAct;
    if (kind === 'close') closePanel();
    else if (kind === 'run') runOrganize();
    else if (kind === 'expand') {
      const folder = orgAct.dataset.folder;
      if (state.organize.expanded.has(folder)) state.organize.expanded.delete(folder);
      else state.organize.expanded.add(folder);
      renderPanel();
    } else if (kind === 'toggle-all') {
      const items = state.organize.plan?.items || [];
      if (state.organize.selected.size === items.length) state.organize.selected.clear();
      else state.organize.selected = new Set(items.map((item) => item.name));
      renderPanel();
    }
    return;
  }

  /* 重复文件 */
  const dupeCheck = event.target.closest('[data-dupe-check]');
  if (dupeCheck) {
    const target = dupeCheck.dataset.dupeCheck;
    if (state.dupes.selected.has(target)) state.dupes.selected.delete(target);
    else state.dupes.selected.add(target);
    renderPanel();
    return;
  }
  const dupeAct = event.target.closest('[data-dupe-act]');
  if (dupeAct) {
    const kind = dupeAct.dataset.dupeAct;
    if (kind === 'close') closePanel();
    else if (kind === 'scan') scanDupes();
    else if (kind === 'clean') cleanDupes();
    return;
  }

  /* 空间 */
  const spaceAct = event.target.closest('[data-space-act]');
  if (spaceAct) {
    if (spaceAct.dataset.spaceAct === 'close') closePanel();
    else if (spaceAct.dataset.spaceAct === 'refresh') openSpace();
    return;
  }

  /* 批量 */
  const batchAct = event.target.closest('[data-batch-act]');
  if (batchAct) {
    const kind = batchAct.dataset.batchAct;
    if (kind === 'close') closePanel();
    else if (kind === 'rename') runBatchRename();
    else if (kind === 'archive') runArchive();
    return;
  }

  /* 历史 */
  const histAct = event.target.closest('[data-hist-act]');
  if (histAct) {
    const kind = histAct.dataset.histAct;
    if (kind === 'close') closePanel();
    else if (kind === 'clear') {
      await api.clearHistory();
      await openHistory();
    } else if (kind === 'undo5') {
      const result = await api.undo({ count: 5 });
      if (result.ok) {
        toast(t('toast.undone', { n: result.data.restored }));
        await navigate(state.cwd, { push: false, refresh: true, keepQuery: true });
        await openHistory();
      }
    } else if (kind === 'undo' || kind === 'redo') {
      const result = kind === 'undo'
        ? await api.undo({ file: histAct.dataset.file })
        : await api.redo({ file: histAct.dataset.file });
      if (result.ok) {
        toast(t('toast.undone', { n: result.data.restored }));
        await navigate(state.cwd, { push: false, refresh: true, keepQuery: true });
        await openHistory();
      }
    }
    return;
  }

  /* 标签面板 */
  const tagPick = event.target.closest('[data-tag-pick]');
  if (tagPick) {
    const id = tagPick.dataset.tagPick;
    if (state.tagsPanel.active.has(id)) state.tagsPanel.active.delete(id);
    else state.tagsPanel.active.add(id);
    await refreshTagResults();
    return;
  }
  const tagMode = event.target.closest('[data-tags-mode]');
  if (tagMode) {
    state.tagsPanel.matchAll = tagMode.dataset.tagsMode === 'all';
    await refreshTagResults();
    return;
  }
  if (event.target.closest('[data-tags-act="close"]')) {
    closePanel();
    return;
  }
  const resultItem = event.target.closest('.tag-result-item');
  if (resultItem) {
    const target = resultItem.dataset.path;
    await navigate(target.replace(/\\[^\\]+$/, ''));
    return;
  }
});

/* 批量面板的输入框 */
dom.drawer.addEventListener('change', async (event) => {
  const field = event.target.closest('[data-batch]');
  if (!field) return;
  const key = field.dataset.batch;
  if (key === 'password') return;
  state.batch[key] = key === 'start' ? Number(field.value) || 1 : field.value;
  await refreshBatchPreview();
});

/* ------------------------------ 事件：设置弹窗 ------------------------------ */

dom.modal.addEventListener('input', (event) => {
  const slider = event.target.closest('[data-slider]');
  if (!slider) return;
  const key = slider.dataset.slider;
  const value = Number(slider.value);
  const label = dom.modal.querySelector(`[data-slider-val="${key}"]`);
  if (label) label.textContent = `${value}%`;
  if (key === 'mist') {
    // 立即生效但不重渲染：拖动时重渲染会让滑块本身被换掉，拖动直接断
    document.documentElement.style.setProperty('--mist', String(value));
    // 滑块就是玻璃厚度：直接改 --tint-a，不用等设置保存回来
    state.settings.mist = value;
    applyGlassTint();
  }
});

dom.modal.addEventListener('change', async (event) => {
  const slider = event.target.closest('[data-slider]');
  if (!slider) return;
  const key = slider.dataset.slider;
  if (key === 'mist') {
    state.settings.mist = Number(slider.value);
    await api.settings.save({ mist: state.settings.mist });
  }
});

dom.modal.addEventListener('click', async (event) => {
  const tab = event.target.closest('[data-set-tab]');
  if (tab) {
    state.settingsTab = tab.dataset.setTab;
    renderPanel();
    return;
  }

  const segment = event.target.closest('[data-segment] button');
  if (segment) {
    const holder = segment.closest('[data-segment]');
    const name = holder.dataset.segment;
    const value = segment.dataset.value;
    for (const sibling of holder.children) sibling.classList.remove('is-active');
    segment.classList.add('is-active');

    if (name === 'theme') {
      state.theme = value;
      applyTheme();
      await api.settings.save({ theme: value });
    } else if (name === 'glassBase') {
      const applied = await applyGlassBase(value);
      // 失败时把分段控件退回真实值，别让按钮亮着但没生效
      if (!applied.ok) {
        for (const sibling of holder.children) {
          sibling.classList.toggle('is-active', sibling.dataset.value === state.settings.glassBase);
        }
      }
    } else if (name === 'motion') {
      state.settings.motionLevel = value;
      applyMotion(value);
      await api.settings.save({ motionLevel: value });
    } else if (name === 'lang') {
      setLang(value);
      state.settings.lang = value;
      document.documentElement.lang = value === 'en' ? 'en' : 'zh-CN';
      await api.settings.save({ lang: value });
      applyStaticI18n();
      renderSidebar();
      renderCrumbs();
      renderList();
      renderDetails();
      renderPanel();
    } else if (name === 'mode') {
      state.settings.mode = value;
      // 走统一的切换器：它会先播 90ms 预备动作，再由 win:modeChanged 接上入场动画
      await switchMode(value);
    } else if (name === 'sidebarSide') {
      state.settings.sidebarSide = value;
      await api.setSide(value);
    } else if (name === 'freq') {
      await saveSettings({ schedule: { ...state.settings.schedule, freq: value } });
      await refreshSchedule();
      renderPanel();
    }
    return;
  }

  const toggle = event.target.closest('[data-toggle]');
  if (toggle) {
    const key = toggle.dataset.toggle;
    const on = !toggle.classList.contains('is-on');
    if (key.startsWith('schedule.')) {
      const field = key.split('.')[1];
      await saveSettings({ schedule: { ...state.settings.schedule, [field]: on } }, { rerender: false });
    } else {
      state.settings[key] = on;
      await api.settings.save({ [key]: on });
      if (key === 'cursorGlow') {
        document.documentElement.classList.toggle('glow-off', !on);
        dom.glow.classList.toggle('is-on', on && lastPointer.inside);
      }
      if (key === 'skipHidden') await navigate(state.cwd, { push: false, refresh: true, keepQuery: true });
      if (key === 'watchEnabled' && !on) api.watch(null, false);
      // 开机自启不是纯设置：要同步到系统的登录项，失败要回滚开关
      if (key === 'autostart') {
        const result = await api.autostart(on);
        if (!result.ok) {
          toast(result.error || t('toast.failed'), { error: true });
          toggle.classList.toggle('is-on', !on);
          state.settings.autostart = !on;
        } else {
          state.settings.autostart = Boolean(result.data?.enabled);
          toggle.classList.toggle('is-on', state.settings.autostart);
        }
      }
    }
    renderPanel();
    return;
  }

  const ruleAct = event.target.closest('[data-rule-act]');
  if (ruleAct) {
    const kind = ruleAct.dataset.ruleAct;
    const id = ruleAct.dataset.ruleId;
    const rules = [...(state.settings.customRules || [])];
    const index = rules.findIndex((rule) => rule.id === id);
    if (index < 0) return;

    if (kind === 'delete') rules.splice(index, 1);
    else if (kind === 'toggle') rules[index] = { ...rules[index], enabled: rules[index].enabled === false };
    else if (kind === 'add-cond') {
      rules[index] = {
        ...rules[index],
        conditions: [...rules[index].conditions, { field: 'name', op: 'contains', value: '' }],
      };
    } else if (kind === 'del-cond') {
      const ci = Number(ruleAct.dataset.condIndex);
      const conditions = rules[index].conditions.filter((_item, i) => i !== ci);
      if (!conditions.length) return;
      rules[index] = { ...rules[index], conditions };
    }

    await saveSettings({ customRules: rules });
    return;
  }

  const setAct = event.target.closest('[data-set-act]');
  if (setAct) {
    const kind = setAct.dataset.setAct;
    if (kind === 'close') return closePanel();

    if (kind === 'add-rule') {
      const rules = [
        ...(state.settings.customRules || []),
        {
          id: `rule-${Date.now().toString(36)}`,
          name: '新规则',
          enabled: true,
          target: '',
          conditions: [{ field: 'name', op: 'contains', value: '' }],
        },
      ];
      await saveSettings({ customRules: rules });
      return;
    }

    if (kind === 'add-exclude') {
      const excludes = [
        ...(state.settings.excludes || []),
        { id: `ex-${Date.now().toString(36)}`, value: '新排除项', kind: 'contains', enabled: true },
      ];
      await saveSettings({ excludes });
      return;
    }

    if (kind === 'preset-exclude') {
      const excludes = [...(state.settings.excludes || [])];
      const value = setAct.dataset.value;
      if (!excludes.some((item) => item.value === value)) {
        excludes.push({ id: `ex-${Date.now().toString(36)}`, value, kind: setAct.dataset.kind, enabled: true });
        await saveSettings({ excludes });
      }
      return;
    }

    if (kind === 'del-exclude') {
      const id = setAct.dataset.excludeId;
      await saveSettings({ excludes: (state.settings.excludes || []).filter((item) => item.id !== id) });
      return;
    }

    if (kind === 'add-dir') {
      const picked = await api.pickFolder('选择要定时整理的文件夹');
      if (!picked.ok || !picked.data.path) return;
      const dirs = [...new Set([...(state.settings.schedule.dirs || []), picked.data.path])];
      await saveSettings({ schedule: { ...state.settings.schedule, dirs } });
      await refreshSchedule();
      renderPanel();
      return;
    }

    if (kind === 'remove-dir') {
      const dir = setAct.dataset.dir;
      const dirs = (state.settings.schedule.dirs || []).filter((item) => item !== dir);
      await saveSettings({ schedule: { ...state.settings.schedule, dirs } });
      await refreshSchedule();
      renderPanel();
      return;
    }

    if (kind === 'run-schedule') {
      const result = await api.schedule.runNow();
      if (result.ok) toast(t('organize.done', { n: result.data.moved || 0 }));
      else toast(result.error || t('toast.failed'), { error: true });
      await refreshSchedule();
      renderPanel();
      return;
    }

    if (kind === 'add-tag') {
      const input = dom.modal.querySelector('[data-tag-name]');
      const name = input?.value.trim();
      if (!name) return;
      const result = await api.tags.create(name);
      if (!result.ok) {
        toast(result.error || t('toast.failed'), { error: true });
        return;
      }
      state.tagList = result.data.tags;
      renderPanel();
      return;
    }

    if (kind === 'del-tag') {
      const result = await api.tags.remove(setAct.dataset.tagId);
      if (result.ok) state.tagList = result.data.tags;
      renderPanel();
      return;
    }

    if (kind === 'open-plugins') {
      await api.plugins.openDir();
      return;
    }

    if (kind === 'reload-plugins') {
      await refreshPlugins();
      renderPanel();
      toast(t('toast.saved'));
      return;
    }

    if (kind === 'toggle-plugin') {
      const file = setAct.dataset.file;
      const enabled = new Set(state.pluginData.enabled || []);
      if (enabled.has(file)) enabled.delete(file);
      else enabled.add(file);
      await saveSettings({ plugins: [...enabled] }, { rerender: false });
      await refreshPlugins();
      renderPanel();
      return;
    }

    if (kind === 'open-data') {
      const info = state.info;
      if (info.userData) await api.open(info.userData);
      return;
    }

    if (kind === 'open-repo') {
      await api.openExternal(REPO_URL);
      return;
    }
    if (kind === 'open-issues') {
      await api.openExternal(`${REPO_URL}/issues/new`);
      return;
    }
    if (kind === 'open-releases') {
      await api.openExternal(`${REPO_URL}/releases`);
      return;
    }
  }
});

/** 设置里的输入项：失焦才提交，避免重绘打断输入 */
dom.modal.addEventListener('change', async (event) => {
  const catInput = event.target.closest('[data-cat]');
  if (catInput) {
    const id = catInput.dataset.cat;
    const value = catInput.value.trim();
    await saveSettings({ customNames: { [id]: value } }, { rerender: false });
    return;
  }

  const ruleName = event.target.closest('[data-rule-name]');
  if (ruleName) {
    const id = ruleName.dataset.ruleName;
    const rules = (state.settings.customRules || []).map((rule) =>
      rule.id === id ? { ...rule, name: ruleName.value.trim() || rule.target } : rule,
    );
    await saveSettings({ customRules: rules });
    return;
  }

  const ruleTarget = event.target.closest('[data-rule-target]');
  if (ruleTarget) {
    const id = ruleTarget.dataset.ruleTarget;
    const rules = (state.settings.customRules || []).map((rule) =>
      rule.id === id ? { ...rule, target: ruleTarget.value.trim() } : rule,
    );
    await saveSettings({ customRules: rules });
    return;
  }

  const condRow = event.target.closest('.rule-cond');
  if (condRow) {
    const card = condRow.closest('[data-rule-id]');
    const id = card?.dataset.ruleId;
    const index = Number(condRow.dataset.condIndex);
    const rules = JSON.parse(JSON.stringify(state.settings.customRules || []));
    const rule = rules.find((item) => item.id === id);
    if (!rule) return;
    const cond = rule.conditions[index];
    if (!cond) return;

    if (event.target.matches('[data-cond-field]')) {
      cond.field = event.target.value;
      // 字段换了，原来的比较方式可能不适用，换成第一个合法的
      const allowed = { name: 'contains', ext: 'equals', size: 'gt', mtime: 'within', ctime: 'within' };
      cond.op = allowed[cond.field] || 'contains';
    } else if (event.target.matches('[data-cond-op]')) {
      cond.op = event.target.value;
    } else if (event.target.matches('[data-cond-value]')) {
      cond.value = cond.field === 'size' || cond.field === 'mtime' || cond.field === 'ctime'
        ? Number(event.target.value)
        : event.target.value;
    } else if (event.target.matches('[data-cond-value2]')) {
      cond.value2 = Number(event.target.value);
    }
    await saveSettings({ customRules: rules });
    return;
  }

  const excludeValue = event.target.closest('[data-exclude-value]');
  if (excludeValue) {
    const id = excludeValue.closest('[data-exclude-id]')?.dataset.excludeId;
    const excludes = (state.settings.excludes || []).map((item) =>
      item.id === id ? { ...item, value: excludeValue.value.trim() } : item,
    );
    await saveSettings({ excludes });
    return;
  }

  const excludeKind = event.target.closest('[data-exclude-kind]');
  if (excludeKind) {
    const id = excludeKind.closest('[data-exclude-id]')?.dataset.excludeId;
    const excludes = (state.settings.excludes || []).map((item) =>
      item.id === id ? { ...item, kind: excludeKind.value } : item,
    );
    await saveSettings({ excludes });
    return;
  }

  const scheduleField = event.target.closest('[data-schedule]');
  if (scheduleField) {
    const field = scheduleField.dataset.schedule;
    const raw = Number(scheduleField.value);
    const value = field === 'hour' ? clamp(raw, 0, 23) : field === 'minute' ? clamp(raw, 0, 59) : clamp(raw, 1, 7);
    await saveSettings({ schedule: { ...state.settings.schedule, [field]: value } }, { rerender: false });
    await refreshSchedule();
    renderPanel();
  }
});

dom.modal.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.matches('[data-tag-name]')) {
    event.preventDefault();
    dom.modal.querySelector('[data-set-act="add-tag"]')?.click();
  }
});

/* ------------------------------ 遮罩 / 键盘 ------------------------------ */

dom.scrim.addEventListener('click', closePanel);

document.querySelector('.wincontrols').addEventListener('click', (event) => {
  const button = event.target.closest('[data-win]');
  if (button) api.win(button.dataset.win);
});

window.addEventListener('resize', debounce(() => {
  if (state.view === 'grid') renderList();
  else {
    updateGutter();
    list.schedule();
  }
  renderCrumbs();
}, 140));

window.addEventListener('keydown', (event) => {
  const inInput = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;
  if (event.key === 'Escape') {
    if (dom.placePop && !dom.placePop.hidden) {
      closePlacePop();
      return;
    }
    if (!dom.preview.hidden) {
      closePreview();
      return;
    }
    if (!dom.menu.hidden) {
      dom.menu.hidden = true;
      return;
    }
    if (state.panel) return closePanel();
    if (inInput) {
      dom.search.blur();
      clearSearch();
    } else if (state.checked.size) {
      clearChecked();
    }
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    dom.search.focus();
    dom.search.select();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    undoLast();
    return;
  }
  /* Ctrl+, 打开设置：紧凑模式下侧栏没了，这是唯一不依赖鼠标的入口 */
  /* Ctrl+K 唤起搜索：不管焦点在哪都抢过来 */
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    dom.search.focus();
    dom.search.select();
    return;
  }
  /* Ctrl+1~6 直接切分类（等价于点轮盘扇区），Ctrl+0 取消筛选 */
  if ((event.ctrlKey || event.metaKey) && /^[0-6]$/.test(event.key)) {
    event.preventDefault();
    if (event.key === '0') applyWheelFilter('');
    else {
      const bucket = WHEEL_BUCKETS[Number(event.key) - 1];
      if (bucket) applyWheelFilter(bucket.key);
    }
    return;
  }
  /* Ctrl+A 全选当前筛选结果 */
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !inInput) {
    event.preventDefault();
    for (const entry of state.entries) state.checked.add(entry.path);
    renderSelectionBar();
    list.refresh();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === ',') {
    event.preventDefault();
    openSettings();
    return;
  }
  /* Ctrl+Shift+W 回到窗口模式（Ctrl+W 是关闭窗口，别抢） */
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'w') {
    event.preventDefault();
    switchMode('window');
    return;
  }
  if (inInput) return;

  if (event.key === 'Delete') {
    event.preventDefault();
    if (state.checked.size) trashChecked();
    else if (state.selectedEntry) {
      state.checked.add(state.selectedEntry.path);
      renderSelectionBar();
      list.refresh();
      trashChecked();
    }
    return;
  }

  const index = state.selected ? state.entries.findIndex((item) => item.path === state.selected) : -1;

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    const next = state.entries[Math.min(state.entries.length - 1, index + 1)];
    if (next) select(next, { scroll: true, index: Math.min(state.entries.length - 1, index + 1) });
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    const nextIndex = Math.max(0, index <= 0 ? 0 : index - 1);
    const next = state.entries[nextIndex];
    if (next) select(next, { scroll: true, index: nextIndex });
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (state.selectedEntry) {
      if (state.selectedEntry.isDir) openEntry(state.selectedEntry);
      else openPreview(state.selectedEntry);
    }
  } else if (event.key === 'F5') {
    event.preventDefault();
    navigate(state.cwd, { push: false, refresh: true, keepQuery: true });
  } else if (event.key === 'Backspace') {
    if (state.query) return;
    event.preventDefault();
    goUp();
  } else if (event.altKey && event.key === 'ArrowLeft') {
    event.preventDefault();
    goBack();
  } else if (event.key === ' ') {
    event.preventDefault();
    if (state.selected) {
      if (state.checked.has(state.selected)) state.checked.delete(state.selected);
      else state.checked.add(state.selected);
      renderSelectionBar();
      list.refresh();
    }
  }
});

/* ------------------------------ 鼠标光影 ------------------------------ */

const lastPointer = { inside: false, x: 0, y: 0 };
let glowFrame = 0;

window.addEventListener('mousemove', (event) => {
  if (!state.settings.cursorGlow) return;
  lastPointer.inside = true;
  lastPointer.x = event.clientX;
  lastPointer.y = event.clientY;
  dom.glow.classList.add('is-on');
  if (glowFrame) return;
  glowFrame = requestAnimationFrame(() => {
    glowFrame = 0;
    dom.glow.style.transform = `translate3d(${lastPointer.x}px, ${lastPointer.y}px, 0)`;
  });
});

window.addEventListener('mouseleave', () => {
  lastPointer.inside = false;
  dom.glow.classList.remove('is-on');
});

/**
 * 卡片表面的光影跟随：像光在玻璃上滑过去。
 * 只改当前悬停那一张的 --mx/--my 两个 CSS 变量，由 ::before 的径向渐变消费，
 * 不新建节点、不触发重排；同一帧内多次移动只算一次。
 */
const cardGlow = { el: null, x: 0, y: 0, frame: 0 };

dom.vcontent.addEventListener('pointermove', (event) => {
  if (!state.settings.cursorGlow) return;
  const card = event.target.closest('.grid-card');
  if (!card) return;
  cardGlow.el = card;
  cardGlow.x = event.clientX;
  cardGlow.y = event.clientY;
  if (cardGlow.frame) return;
  cardGlow.frame = requestAnimationFrame(() => {
    cardGlow.frame = 0;
    const el = cardGlow.el;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${(cardGlow.x - rect.left).toFixed(1)}px`);
    el.style.setProperty('--my', `${(cardGlow.y - rect.top).toFixed(1)}px`);
  });
});

/* ------------------------------ 工具入口 ------------------------------ */

$('btnOrganize').addEventListener('click', openOrganize);
$('btnSettings').addEventListener('click', () => openSettings());
$('btnDupes').addEventListener('click', openDupes);
$('btnSpace').addEventListener('click', openSpace);
$('btnBatch').addEventListener('click', openBatch);
$('btnHistory').addEventListener('click', openHistory);
$('btnTags').addEventListener('click', openTags);

/**
 * 紧凑模式（侧栏 / 任务栏悬浮）里侧栏是隐藏的，设置入口只能在标题栏。
 * 「回到窗口模式」给一个一步到位的出口 —— 不让用户先进设置再找模式开关。
 */
$('btnCompactSettings').addEventListener('click', () => openSettings());
$('btnCompactExpand').addEventListener('click', () => switchMode('window'));

/* 主进程事件 */
api.onProgress((progress) => {
  state.organize.progress = progress;
  const bar = dom.drawer.querySelector('.progress__bar');
  if (bar) bar.style.width = `${Math.round((progress.index / Math.max(1, progress.total)) * 100)}%`;
});

api.onDupesProgress((progress) => {
  state.dupes.progress = progress;
  if (state.panel === 'dupes') {
    const note = dom.drawer.querySelector('.empty-note');
    if (note && progress.message) note.textContent = progress.message;
    const bar = dom.drawer.querySelector('.progress__bar');
    if (bar && progress.total) bar.style.width = `${Math.round((progress.done / progress.total) * 100)}%`;
  }
});

api.onSpaceProgress((progress) => {
  state.space.progress = progress;
  if (state.panel === 'space') renderPanel();
});

/** 文件系统有变化：只刷新可见目录，别的地方不用管 */
api.onFsChanged((payload) => {
  if (!payload?.dir || !isSamePath(payload.dir, state.cwd)) return;
  if (state.loading) return;
  navigate(state.cwd, { push: false, refresh: true, keepQuery: true });
});

/* ------------------------------ 模式切换 ------------------------------ */

/** 预备动作时长：够眼睛"感觉到要变了"，又不至于让人等 */
const MODE_ANTICIPATE_MS = 90;

function motionEnabled() {
  return (
    !document.documentElement.classList.contains('motion-off') &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function currentMode() {
  return document.documentElement.dataset.mode || 'window';
}

/**
 * 唯一的模式切换入口。
 *
 * 窗口尺寸是瞬间改的（setBounds 逐帧补间在 Windows 上会掉帧、还会让亚克力闪），
 * 所以"动效"拆成两段：切之前先轻轻收一下（预备动作），
 * 切之后从锚点方向展开（入场）。中间那下跳变由高光扫过盖住。
 */
let modeSwitching = false;
/** boot 完成前不要重算厚度：那时 state.settings 还没读，主题也还没钉 */
let booted = false;

async function switchMode(mode) {
  if (!mode || mode === currentMode() || modeSwitching) return;
  const root = document.documentElement;
  modeSwitching = true;
  root.dataset.modeFrom = currentMode();

  if (motionEnabled()) {
    root.classList.add('mode-anticipate');
    await new Promise((resolve) => setTimeout(resolve, MODE_ANTICIPATE_MS));
  }

  try {
    await api.setMode(mode);
  } finally {
    root.classList.remove('mode-anticipate');
    // 动画总时长 420ms + 200ms 余量，期间不接受第二次切换，避免窗口尺寸打架
    setTimeout(() => {
      modeSwitching = false;
    }, 620);
  }
}

/** 入场：由 win:modeChanged 触发，方向和锚点写在 data-mode-from / data-mode-to 上 */
function playModeTransition(from, to, side) {
  const root = document.documentElement;
  root.classList.remove('mode-anticipate');
  root.dataset.modeFrom = from || 'window';
  root.dataset.modeTo = to;
  if (side) root.dataset.side = side;

  root.classList.remove('mode-enter');
  void root.offsetWidth; // 强制回流，让同一个类重新触发动画
  root.classList.add('mode-enter');

  /**
   * 收尾以 animationend 为准，定时器只作兜底。
   * 后台/被遮挡的窗口里 setTimeout 会被 Chromium 节流到 1s 以上，
   * 只靠定时器会让动画类多挂很久（冒烟里实测挂在 1.2s 还没摘）。
   */
  const shell = document.querySelector('.app');
  const finish = () => {
    root.classList.remove('mode-enter');
    shell.removeEventListener('animationend', onEnd);
  };
  const onEnd = (event) => {
    if (event.target === shell) finish();
  };
  shell.addEventListener('animationend', onEnd);
  clearTimeout(playModeTransition.timer);
  // 兜底时长按实际动画时长算：调试时把 --mode-dur 拉长，兜底也得跟着拉长
  const dur = parseFloat(getComputedStyle(root).getPropertyValue('--mode-dur')) || 420;
  playModeTransition.timer = setTimeout(finish, dur + 400);
}

api.onModeChanged(({ mode, side }) => {
  const previous = document.documentElement.dataset.mode;
  document.documentElement.dataset.mode = mode;
  state.settings.mode = mode;

  /**
   * 悬浮挂件只有 460×340，网格一屏露不出两行，列表才看得清。
   * 这里只在进入/离开悬浮模式时临时换视图，不动用户存下的 viewMode 偏好。
   */
  if (mode === 'dock' && state.view !== 'list') {
    state.dockView = state.view;
    state.view = 'list';
    dom.btnList.classList.add('is-active');
    dom.btnGrid.classList.remove('is-active');
    renderList();
  } else if (previous === 'dock' && mode !== 'dock' && state.dockView) {
    state.view = state.dockView;
    state.dockView = '';
    dom.btnList.classList.toggle('is-active', state.view === 'list');
    dom.btnGrid.classList.toggle('is-active', state.view === 'grid');
    renderList();
  }

  if (state.panel === 'settings') renderPanel();

  playModeTransition(previous, mode, side);

  applyModeCopy();
  // 紧凑模式不显示轮盘，窗口模式才显示，切回来要重算
  renderWheel();
  list.schedule();
});

/* ---------------------------- 玻璃底 ---------------------------- */

/**
 * 三档：acrylic（系统磨砂）/ clear（全透明）/ live（实时透桌面）。
 *
 * live 档要额外起一条桌面流；起不来的情况必须**回退**到 acrylic 而不是停在 clear ——
 * 没有模糊又没有系统材质的窗口，文字会直接糊在壁纸上，比不生效更糟。
 */
async function applyGlassBase(value) {
  const root = document.documentElement;
  const win = document.querySelector('.app-bg');

  const result = await api.glassBase(value);
  if (!result.ok) {
    toast(result.error || t('toast.failed'), { error: true });
    return { ok: false };
  }

  if (value === 'live') {
    try {
      await startLiveBackground(api, win);
    } catch (err) {
      stopLiveBackground();
      await api.glassBase('acrylic');
      state.settings.glassBase = 'acrylic';
      root.dataset.glassBase = 'acrylic';
      toast(t('toast.liveFailed'), { error: true });
      return { ok: false, error: String(err?.message || err) };
    }
  } else {
    stopLiveBackground();
  }

  state.settings.glassBase = value;
  root.dataset.glassBase = value;
  return { ok: true };
}

/* ---------------------------- 玻璃厚度 ---------------------------- */

/**
 * 3.5 起，玻璃只保留一层极淡染色 —— 用户要的是"完全通透、没有底色干扰"。
 *
 * 染色透明度 = 4%（几乎看不见）+ 「玻璃厚度」滑块 × 0.26。
 * 滑块拉到 0 就是纯玻璃（只剩模糊和边光），拉到 30 相当于 30% 白，
 * 用来应付"背后是满屏图标、字看不清"的极端情况。默认 0。
 *
 * 上一版按每个面板背后的桌面亮度算不同透明度，结果是同一个窗口里三块玻璃
 * 厚薄不一，切主题还会有一块没跟上 —— 那正是"模块明暗不统一"的来源。现在只有这一个值。
 */
function applyGlassTint() {
  const mist = Math.max(0, Math.min(30, Number(state.settings.mist) || 0));
  // 3.6：基数是 0 —— 面上不铺白，玻璃只靠模糊、饱和度和边缘。滑块 0~30 → 0~0.32。
  const alpha = (mist / 30) * 0.32;
  document.documentElement.style.setProperty('--tint-a', alpha.toFixed(3));
}

api.onTrayAction((payload) => {
  if (payload?.action === 'scheduled') {
    navigate(state.cwd, { push: false, refresh: true, keepQuery: true });
    toast(t('organize.done', { n: payload.result?.moved || 0 }));
  }
});

/* ------------------------------ 启动 ------------------------------ */

document.documentElement.dataset.mode = 'window';

async function boot() {
  const [settingsResult, placesResult, infoResult, tagsResult] = await Promise.all([
    api.settings.get(),
    api.places(),
    api.info(),
    api.tags.list(),
  ]);

  if (settingsResult.ok) {
    state.settings = settingsResult.data.settings;
    state.categories = settingsResult.data.categories;
    state.ruleMeta = settingsResult.data.ruleMeta || { fields: {}, ops: {} };
    state.defaultExcludes = settingsResult.data.defaultExcludes || [];
    state.sort = { key: state.settings.sortBy || 'name', dir: state.settings.sortDir || 'asc' };
    state.view = state.settings.viewMode || 'list';
    state.theme = state.settings.theme || 'system';
    state.detailOpen = state.settings.detailOpen !== false;
    setLang(state.settings.lang || 'zh');
  }
  if (placesResult.ok) {
    state.places = placesResult.data.places;
    state.drives = placesResult.data.drives;
    state.clouds = placesResult.data.clouds || [];
  }
  if (infoResult.ok) state.info = infoResult.data;
  if (tagsResult.ok) state.tagList = tagsResult.data.tags;

  // 收藏：数组存原始路径、Set 存归一化键，查表 O(1)
  state.favoriteList = Array.isArray(state.settings.favorites) ? state.settings.favorites.slice() : [];
  state.favorites = new Set(state.favoriteList.map((item) => normalizePath(item)));
  syncScope();

  document.documentElement.lang = getLang() === 'en' ? 'en' : 'zh-CN';
  document.documentElement.dataset.mode = state.settings.mode || 'window';
  // 玻璃底：acrylic = 系统磨砂，clear = 全透明。CSS 用它调读区强度。
  document.documentElement.dataset.glassBase = state.settings.glassBase || 'acrylic';
  document.documentElement.dataset.side = state.settings.sidebarSide || 'left';
  applyStaticI18n();
  applyModeCopy();
  applyTheme(false);
  applyMotion(state.settings.motionLevel || 'full');
  // 雾度从 store 恢复：tokens.css 里的 14 只是"还没读到设置"时的兜底值，
  // 用户上次拖到 0 或 30，重新打开必须还是那个值。
  document.documentElement.style.setProperty(
    '--mist',
    String(Number(state.settings.mist) || 0),
  );
  dom.btnList.classList.toggle('is-active', state.view === 'list');
  dom.btnGrid.classList.toggle('is-active', state.view === 'grid');
  dom.details.classList.toggle('is-collapsed', !state.detailOpen);
  dom.btnDetail.classList.toggle('is-active', state.detailOpen);
  renderSidebar();
  renderDetails();
  dom.titleMeta.textContent = `${greeting()}，正在读取文件…`;

  const start =
    state.settings.lastFolder ||
    state.places.find((place) => place.key === 'downloads')?.dir ||
    state.places[0]?.dir ||
    state.info.home;

  await navigate(start || 'C:\\', { push: true });

  // 上次的目录可能已被删除，退回一个能打开的位置，别让用户一进来就看到错误页
  if (state.error && state.error.kind === 'missing') {
    const fallback = state.places[0]?.dir || state.drives[0]?.path;
    if (fallback && !isSamePath(fallback, start)) await navigate(fallback, { push: true });
  }

  applyGlassTint();
  booted = true;
  // 上次停在实时档：启动时把流接回来（失败会自动退回系统磨砂）
  if (state.settings.glassBase === 'live') await applyGlassBase('live');
  // 首启引导放在最后：此时目录、分类、窗口都已就绪，点"开始整理"能直接进预览
  maybeOnboard();
}

boot().catch((err) => {
  console.error(err);
  state.loading = false;
  state.error = { kind: 'error', message: String(err?.message || err) };
  renderState();
});

// 便于冒烟脚本读取内部状态，不影响正常使用
window.__lens = {
  state,
  navigate,
  openPanel: (kind) => (kind === 'settings' ? openSettings() : openDrawer(kind)),
  refreshTint: () => applyGlassTint(),
  preview: (entry) => openPreview(entry),
  favorite: (entry) => toggleFavorite(entry),
  setScope: (scope) => setScope(scope),
  liveStats: () => liveStats(),
  setGlassBase: (value) => applyGlassBase(value),
};
