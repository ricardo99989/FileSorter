'use strict';

/**
 * quick.js — 全局快速启动（Alt+Space）
 *
 * 为什么单独开一个窗口，而不是把主窗口叫到前台：
 *   主窗口的 boot 要走 places / settings / tags / 目录列举 / 玻璃采样，冷启动几百毫秒起步。
 *   快速启动要的是"按下去就有光标"，所以这里只加载一张极简页面（输入框 + 结果列表），
 *   窗口常驻但隐藏，第一次唤起的延迟就是 show() 的几十毫秒。
 */

const path = require('node:path');
const { BrowserWindow, ipcMain, screen, globalShortcut, shell, app } = require('electron');

const WIDTH = 720;
const HEIGHT = 460;

let win = null;
let shortcuts = [];

function create() {
  if (win && !win.isDestroyed()) return win;

  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    fullscreenable: false,
    // 快速启动窗不做内容保护：用户可能想截图分享搜索结果
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'quick.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, '..', 'renderer', 'quick.html'));

  // 失焦即收起：Spotlight 的手感，用户点别处就当取消
  win.on('blur', () => {
    if (!win.isDestroyed() && win.isVisible()) win.hide();
  });

  return win;
}

function centerOnCursor() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x, y, width, height } = display.workArea;
  // 略偏上：视觉重心比正中更稳，也给下方留出结果展开的空间
  const left = Math.round(x + (width - WIDTH) / 2);
  const top = Math.round(y + Math.max(24, height * 0.22));
  win.setBounds({ x: left, y: top, width: WIDTH, height: HEIGHT });
}

function show() {
  const target = create();
  if (target.isVisible()) {
    target.focus();
    return;
  }
  centerOnCursor();
  target.show();
  target.focus();
  target.webContents.send('quick:focus');
}

function hide() {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}

function toggle() {
  if (win && !win.isDestroyed() && win.isVisible()) hide();
  else show();
}

/**
 * 注册全局快捷键。
 * Alt+Space 在部分 Windows 版本上被系统菜单占用，注册会失败 —— 此时退回 Ctrl+Alt+Space，
 * 并把实际生效的组合告诉调用方，界面上要显示真的那个，不能撒谎。
 */
function registerShortcuts() {
  /*
   * Alt+Space 在 Windows 上是系统窗口菜单，Electron 的 globalShortcut 抢不到 ——
   * 实测注册直接返回 false。所以两个都试、都能注册就都留：
   * 用户在设置里看到的是真实生效的那个，不会出现"按了没反应"。
   */
  const wanted = ['Alt+Space', 'Control+Alt+Space', 'Control+Shift+Space'];
  shortcuts = [];
  for (const accel of wanted) {
    try {
      if (globalShortcut.register(accel, toggle)) shortcuts.push(accel);
    } catch {
      /* 组合非法或已被占用 */
    }
    if (shortcuts.length >= 2) break;
  }
  return shortcuts;
}

function unregisterShortcuts() {
  for (const accel of shortcuts) {
    try {
      globalShortcut.unregister(accel);
    } catch {
      /* ignore */
    }
  }
  shortcuts = [];
}

function registerIpc({ indexer }) {
  ipcMain.handle('quick:search', async (event, payload) => {
    try {
      return { ok: true, data: indexer.search(payload?.query, { limit: payload?.limit }) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('quick:stats', async () => ({
    ok: true,
    data: { ...indexer.stats(), shortcut: shortcuts[0] || null, shortcuts },
  }));

  /** 结果条数变化时窗口跟着收放：3 条结果配 460 高的空窗看着很怪 */
  ipcMain.handle('quick:resize', async (event, payload) => {
    if (!win || win.isDestroyed()) return { ok: false };
    const height = Math.max(180, Math.min(HEIGHT, Math.round(Number(payload?.height) || HEIGHT)));
    const bounds = win.getBounds();
    if (bounds.height !== height) win.setBounds({ ...bounds, height });
    return { ok: true };
  });

  ipcMain.handle('quick:open', async (event, payload) => {
    const target = String(payload?.path || '');
    if (!target) return { ok: false, error: '空路径' };
    hide();
    const error = await shell.openPath(target);
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle('quick:reveal', async (event, payload) => {
    const target = String(payload?.path || '');
    if (!target) return { ok: false, error: '空路径' };
    hide();
    shell.showItemInFolder(target);
    return { ok: true };
  });

  ipcMain.handle('quick:hide', async () => {
    hide();
    return { ok: true };
  });

  // 主窗口/托盘也要能唤起它（菜单里点"快速搜索"）
  ipcMain.handle('quick:toggle', async () => {
    toggle();
    return { ok: true, shortcuts };
  });
}

module.exports = {
  create,
  show,
  hide,
  toggle,
  registerShortcuts,
  unregisterShortcuts,
  registerIpc,
  getWindow: () => win,
  getShortcuts: () => shortcuts.slice(),
};
