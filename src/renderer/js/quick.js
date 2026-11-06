/**
 * quick.js — 快速启动窗的渲染逻辑
 *
 * 三条硬要求：
 *   1. 每次唤起光标已经在输入框里（否则用户还要点一下，整条链路就废了）；
 *   2. 输入到出结果不能被旧结果覆盖 —— 用递增的请求号丢弃过期响应；
 *   3. 结果里的文件路径来自磁盘，一律用 textContent 写入，不拼 HTML。
 */

const q = document.getElementById('q');
const list = document.getElementById('list');
const stat = document.getElementById('stat');
const hint = document.getElementById('hint');
const perf = document.getElementById('perf');

const state = {
  results: [],
  active: 0,
  requestId: 0,
  timer: 0,
  indexed: null,
};

/** 跟随系统明暗：快速启动窗不读应用设置，用户按下快捷键时不该等一次 IPC */
const dark = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  document.documentElement.dataset.theme = dark.matches ? 'dark' : 'light';
}
applyTheme();
dark.addEventListener('change', applyTheme);

/* ------------------------------ 渲染 ------------------------------ */

const ICONS = {
  folder:
    'M3.6 7.4A1.8 1.8 0 0 1 5.4 5.6h4.1l1.7 2h7.4a1.8 1.8 0 0 1 1.8 1.8v7.2a1.8 1.8 0 0 1-1.8 1.8H5.4a1.8 1.8 0 0 1-1.8-1.8z',
  file: 'M6 3.4h7l5 5v12.2H6z',
  image: 'M4 5.6h16v12.8H4zM4 15l4.6-4 4 3.6 3-2.6L20 15.4',
  video: 'M3.6 6.4h11v11.2h-11zM14.6 10.4l5.8-3.2v9.6l-5.8-3.2z',
  audio: 'M9 18V7l10-2v11M9 18a2.4 2.4 0 1 1-4.8 0 2.4 2.4 0 0 1 4.8 0zM19 16a2.4 2.4 0 1 1-4.8 0 2.4 2.4 0 0 1 4.8 0z',
  code: 'M9 8l-4 4 4 4M15 8l4 4-4 4',
  archive: 'M5 4.6h14v4H5zM6.4 8.6h11.2v10.8H6.4zM10 12.4h4',
};

function iconFor(name, isDir) {
  if (isDir) return ICONS.folder;
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'heic'].includes(ext)) return ICONS.image;
  if (['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv'].includes(ext)) return ICONS.video;
  if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'].includes(ext)) return ICONS.audio;
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'css', 'html', 'json', 'mjs'].includes(ext))
    return ICONS.code;
  if (['zip', 'rar', '7z', 'tar', 'gz', 'xz', 'iso'].includes(ext)) return ICONS.archive;
  return ICONS.file;
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatAge(ms) {
  if (!ms) return '';
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

/** 命中片段加粗：只在名字上做，路径太长不做 */
function nameNode(name, query) {
  const fragment = document.createDocumentFragment();
  const lower = name.toLowerCase();
  const needle = query.toLowerCase();
  const at = needle ? lower.indexOf(needle) : -1;
  if (!needle || at < 0) {
    fragment.append(name);
    return fragment;
  }
  fragment.append(name.slice(0, at));
  const mark = document.createElement('mark');
  mark.textContent = name.slice(at, at + needle.length);
  fragment.append(mark, name.slice(at + needle.length));
  return fragment;
}

const BAR_H = 54;
const FOOT_H = 34;
const ROW_H = 48;
const CHROME = 20; // body 上下各 10px 的投影留白

/** 结果条数变了就收放窗口：Spotlight 的手感一半来自"窗口跟着内容长" */
function fitWindow(rows) {
  const height = CHROME + BAR_H + FOOT_H + Math.max(rows, 1) * ROW_H + 12;
  window.quick.resize(height);
}

function render() {
  list.replaceChildren();
  if (!state.results.length) {
    const empty = document.createElement('div');
    empty.className = 'quick__empty';
    empty.textContent = q.value.trim() ? '没有匹配的文件' : '输入文件名、拼音首字母或路径片段';
    list.append(empty);
    fitWindow(0);
    return;
  }
  fitWindow(state.results.length);

  state.results.forEach((item, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `quick__row${index === state.active ? ' is-active' : ''}`;
    row.dataset.index = String(index);

    const ico = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ico.setAttribute('viewBox', '0 0 24 24');
    ico.setAttribute('fill', 'none');
    ico.setAttribute('stroke', 'currentColor');
    ico.setAttribute('stroke-width', '1.6');
    ico.setAttribute('stroke-linecap', 'round');
    ico.setAttribute('stroke-linejoin', 'round');
    ico.setAttribute('class', 'quick__row-ico');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', iconFor(item.name, item.isDir));
    ico.append(p);

    const text = document.createElement('span');
    text.className = 'quick__row-text';
    const nameEl = document.createElement('span');
    nameEl.className = 'quick__row-name';
    nameEl.append(nameNode(item.name, q.value.trim()));
    const sub = document.createElement('span');
    sub.className = 'quick__row-sub';
    sub.textContent = `${item.dir}${item.size ? ` · ${formatSize(item.size)}` : ''}${
      item.mtime ? ` · ${formatAge(item.mtime)}` : ''
    }`;
    text.append(nameEl, sub);

    row.append(ico, text);
    list.append(row);
  });
}

/* ------------------------------ 查询 ------------------------------ */

async function runSearch() {
  const query = q.value.trim();
  const id = ++state.requestId;
  if (!query) {
    state.results = [];
    state.active = 0;
    render();
    perf.textContent = '';
    return;
  }

  const result = await window.quick.search(query, 40);
  if (id !== state.requestId) return; // 有更新的输入了，这次结果作废
  if (!result.ok) {
    perf.textContent = result.error || '搜索失败';
    return;
  }
  state.results = result.data.results;
  state.active = 0;
  render();
  perf.textContent = `${result.data.total} 条 · ${result.data.took}ms`;
}

function schedule() {
  clearTimeout(state.timer);
  state.timer = setTimeout(runSearch, 45);
}

/* ------------------------------ 交互 ------------------------------ */

function move(delta) {
  if (!state.results.length) return;
  state.active = (state.active + delta + state.results.length) % state.results.length;
  const rows = list.querySelectorAll('.quick__row');
  rows.forEach((row, index) => row.classList.toggle('is-active', index === state.active));
  rows[state.active]?.scrollIntoView({ block: 'nearest' });
}

function current() {
  return state.results[state.active] || null;
}

q.addEventListener('input', schedule);

document.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    move(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    move(-1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const item = current();
    if (!item) return;
    if (event.ctrlKey || event.metaKey) window.quick.reveal(item.path);
    else window.quick.open(item.path);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    window.quick.hide();
  }
});

list.addEventListener('click', (event) => {
  const row = event.target.closest('.quick__row');
  if (!row) return;
  const item = state.results[Number(row.dataset.index)];
  if (item) window.quick.open(item.path);
});

// 每次唤起来都清空上一次的输入：Spotlight 的默认行为，避免看到过期结果
window.quick.onFocus(() => {
  q.value = '';
  state.results = [];
  state.active = 0;
  render();
  q.focus();
  refreshStats();
});

async function refreshStats() {
  const result = await window.quick.stats();
  if (!result.ok) return;
  const { ready, scanning, count, scanned } = result.data;
  state.indexed = count;
  if (!ready && scanning) stat.textContent = `建索引 ${Math.round(scanned / 1000)}k…`;
  else if (!ready) stat.textContent = '索引未就绪';
  else stat.textContent = `${(count / 10000).toFixed(1)} 万项`;

  // 页脚显示真实注册成功的组合：Alt+Space 在 Windows 上通常抢不到，别骗用户
  const accel = result.data.shortcut;
  if (accel && hint.dataset.accel !== accel) {
    hint.dataset.accel = accel;
    const label = accel.replace('Control', 'Ctrl').replace(/\+/g, ' + ');
    hint.textContent = label;
    hint.title = `全局唤起：${label}`;
  }
}

q.focus();
render();
refreshStats();
// 窗口隐藏时就没必要每 4 秒发一次 IPC 了，Spotlight 收起即零开销
setInterval(() => {
  if (document.visibilityState === 'visible') refreshStats();
}, 4000);
