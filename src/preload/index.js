'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 渲染进程唯一的能力入口。
 * 只暴露具体动作，不暴露 ipcRenderer 本身，也不能拼接通道名 —— 相当于一层白名单 API。
 */
const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('filesorter', {
  settings: {
    get: () => invoke('settings:get'),
    save: (patch) => invoke('settings:save', patch),
  },
  pickFolder: () => invoke('dialog:pick'),
  stats: (dir) => invoke('fs:stats', { dir }),
  list: (dir, categoryId) => invoke('fs:list', { dir, categoryId }),
  preview: (dir) => invoke('organizer:preview', { dir }),
  execute: (dir, selectedNames) => invoke('organizer:execute', { dir, selectedNames }),
  undo: () => invoke('organizer:undo'),
  history: () => invoke('organizer:history'),
  search: (dir, keyword) => invoke('search:query', { dir, keyword }),
  reveal: (target) => invoke('shell:reveal', { path: target }),
  open: (target) => invoke('shell:open', { path: target }),
  info: () => invoke('app:info'),
  onProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('organizer:progress', handler);
    return () => ipcRenderer.removeListener('organizer:progress', handler);
  },
});
