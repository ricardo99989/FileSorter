'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 渲染进程唯一的能力入口。
 *
 * 只暴露具体动作，不暴露 ipcRenderer 本身，也不能拼接通道名 ——
 * 相当于一层白名单 API。要加新能力必须同时改这里和 ipc.js，
 * 漏改任何一边都会立刻暴露出来（而不是悄悄多出一个隐蔽通道）。
 */
const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

/** 统一订阅辅助：返回取消函数，避免监听器越积越多 */
function subscribe(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('filesorter', {
  /* 设置 */
  settings: {
    get: () => invoke('settings:get'),
    save: (patch) => invoke('settings:save', patch),
  },
  pickFolder: (title) => invoke('dialog:pick', { title }),

  /* 浏览 */
  places: () => invoke('browser:places'),
  list: (dir, options = {}) =>
    invoke('browser:list', {
      dir,
      showHidden: Boolean(options.showHidden),
      refresh: Boolean(options.refresh),
    }),
  describe: (target) => invoke('browser:describe', { path: target }),
  preview: (target) => invoke('browser:preview', { path: target }),
  peek: (target) => invoke('browser:peek', { path: target }),
  open: (target) => invoke('browser:open', { path: target }),
  reveal: (target) => invoke('browser:reveal', { path: target }),
  copyPath: (target) => invoke('browser:copyPath', { path: target }),
  openExternal: (url) => invoke('shell:openExternal', { url }),

  /* 监听 */
  watch: (dir, enabled = true) => invoke('watch:set', { dir, enabled }),

  /* 整理 */
  stats: (dir) => invoke('fs:stats', { dir }),
  previewPlan: (dir) => invoke('organizer:preview', { dir }),
  execute: (dir, selectedNames) => invoke('organizer:execute', { dir, selectedNames }),
  undo: (options = {}) => invoke('organizer:undo', options),
  redo: (options = {}) => invoke('organizer:redo', options),
  history: (limit) => invoke('organizer:history', { limit }),
  clearHistory: () => invoke('organizer:clearHistory'),

  /* 搜索 */
  search: (dir, keyword) => invoke('search:query', { dir, keyword }),
  searchByTags: (dir, tagIds, matchAll = true) => invoke('search:byTags', { dir, tagIds, matchAll }),

  /* 重复文件 */
  dupes: {
    scan: (dir, minSize) => invoke('dupes:scan', { dir, minSize }),
    trash: (paths) => invoke('dupes:trash', { paths }),
  },

  /* 空间分析 */
  analyzeSpace: (dir) => invoke('space:analyze', { dir }),

  /* 批量 */
  batch: {
    preview: (dir, names, options) => invoke('batch:preview', { dir, names, ...options }),
    rename: (dir, names, options) => invoke('batch:rename', { dir, names, ...options }),
    archive: (dir, names, options) => invoke('batch:archive', { dir, names, ...options }),
    decrypt: (target, password) => invoke('batch:decrypt', { path: target, password }),
  },

  /* 标签 */
  tags: {
    list: () => invoke('tags:list'),
    create: (name, color) => invoke('tags:create', { name, color }),
    update: (id, patch) => invoke('tags:update', { id, ...patch }),
    remove: (id) => invoke('tags:delete', { id }),
    add: (paths, tagIds) => invoke('tags:add', { paths, tagIds }),
    set: (target, tagIds) => invoke('tags:set', { path: target, tagIds }),
    removeFrom: (paths, tagIds) => invoke('tags:remove', { paths, tagIds }),
    prune: () => invoke('tags:prune'),
  },

  /* 插件 */
  plugins: {
    list: () => invoke('plugins:list'),
    save: (file, code) => invoke('plugins:save', { file, code }),
    openDir: () => invoke('plugins:openDir'),
  },

  /* 定时 */
  schedule: {
    status: () => invoke('schedule:status'),
    runNow: () => invoke('schedule:runNow'),
  },

  /* 云盘 */
  clouds: () => invoke('cloud:list'),

  /* 窗口 */
  win: (action) => invoke('win:action', { action }),
  setMode: (mode) => invoke('win:setMode', { mode }),
  setSide: (side) => invoke('win:setSide', { side }),
  background: (rects) => invoke('win:backdrop', { rects }),
  notify: (title, body) => invoke('win:notify', { title, body }),
  info: () => invoke('app:info'),
  revealPath: (target) => invoke('app:revealPath', { path: target }),

  /* 事件订阅 */
  onProgress: (handler) => subscribe('organizer:progress', handler),
  onDupesProgress: (handler) => subscribe('dupes:progress', handler),
  onBatchProgress: (handler) => subscribe('batch:progress', handler),
  onSpaceProgress: (handler) => subscribe('space:progress', handler),
  onFsChanged: (handler) => subscribe('fs:changed', handler),
  onModeChanged: (handler) => subscribe('win:modeChanged', handler),
  onTrayAction: (handler) => subscribe('tray:action', handler),
});
