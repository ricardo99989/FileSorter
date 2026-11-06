'use strict';

/**
 * 快速启动窗的专用 preload。
 *
 * 不复用主 preload：那个接口面太大（文件操作、设置、云盘…），
 * 一个常驻在屏幕上的搜索框只需要四个动作 —— 搜索、打开、定位、收起。
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) =>
  ipcRenderer.invoke(channel, payload).catch((error) => ({ ok: false, error: error.message }));

contextBridge.exposeInMainWorld('quick', {
  search: (query, limit = 30) => invoke('quick:search', { query, limit }),
  stats: () => invoke('quick:stats'),
  open: (path) => invoke('quick:open', { path }),
  reveal: (path) => invoke('quick:reveal', { path }),
  hide: () => invoke('quick:hide'),
  resize: (height) => invoke('quick:resize', { height }),
  onFocus: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('quick:focus', listener);
    return () => ipcRenderer.removeListener('quick:focus', listener);
  },
});
