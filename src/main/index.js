'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const { createStore } = require('./store');
const { createUndo } = require('./undo');
const { registerIpc } = require('./ipc');

const isSmoke = process.argv.includes('--smoke');
const isDev = process.argv.includes('--dev');
const captureArg = process.argv.find((arg) => arg.startsWith('--capture='));

/** @type {BrowserWindow | null} */
let mainWindow = null;
let store = null;
let undo = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 1000,
    minHeight: 660,
    show: false,
    backgroundColor: '#E9ECF1',
    title: 'FileSorter',
    // 隐藏原生标题栏但保留系统窗口按钮，兼顾现代感与 Windows 习惯
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#E9ECF1', symbolColor: '#5C6675', height: 42 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    // 冒烟模式下窗口必须真实渲染，否则 capturePage 拿到空白图；用 showInactive 避免抢焦点
    if (isSmoke) mainWindow.showInactive();
    else mainWindow.show();
  });

  // 外链一律交给系统浏览器，窗口本身不导航
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  if (isDev) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        mainWindow.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
  }

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (isSmoke) attachSmokeProbe(mainWindow);
}

/** 冒烟探针：加载完成后截图、打印渲染层报错，然后退出。仅用于自动化校验。 */
function attachSmokeProbe(win) {
  const stepArg = process.argv.find((arg) => arg.startsWith('--smoke-step='));
  const step = stepArg ? stepArg.split('=')[1] : '';

  win.webContents.on('console-message', (event, ...rest) => {
    const message = (event && event.message) || rest[1] || '';
    console.log('[renderer]', message);
  });
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error('[smoke] 加载失败', code, description, url);
  });
  win.webContents.on('preload-error', (_event, file, error) => {
    console.error('[smoke] preload 出错', file, error && error.message);
  });
  win.webContents.once('did-finish-load', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1600));

    // 可选步骤：触发某个交互后再截图，用于验证抽屉/设置页等非首屏状态
    if (step) {
      const scripts = {
        preview: "document.getElementById('btnPreview').click()",
        settings: "document.querySelector('[data-view=\"settings\"]').click()",
        history: "document.querySelector('[data-view=\"history\"]').click()",
        organize: `new Promise((resolve) => {
          document.getElementById('btnPreview').click();
          setTimeout(() => {
            document.getElementById('confirmOrganize').click();
            setTimeout(resolve, 3200);
          }, 1200);
        })`,
        undo: "document.getElementById('btnUndo').click()",
      };
      if (scripts[step]) {
        await win.webContents.executeJavaScript(scripts[step]).catch((err) => {
          console.error('[smoke] 步骤执行失败', step, err.message);
        });
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    }

    try {
      const image = await win.webContents.capturePage();
      const target = captureArg
        ? path.resolve(captureArg.slice('--capture='.length))
        : path.join(app.getPath('temp'), 'filesorter-smoke.png');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, image.toPNG());
      console.log('[smoke] 截图已保存:', target);
    } catch (err) {
      console.error('[smoke] 截图失败:', err.message);
    }
    app.exit(0);
  });
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.filesorter.app');
  Menu.setApplicationMenu(null);

  store = createStore(app.getPath('userData'));
  await store.load();
  undo = createUndo(app.getPath('userData'));

  registerIpc({ ipcMain, dialog, shell, app, store, undo });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
