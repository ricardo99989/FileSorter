'use strict';

const path = require('node:path');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const {
  app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, Tray,
  nativeTheme, nativeImage, Notification, screen,
} = require('electron');

const { createStore } = require('./store');
const { createUndo } = require('./undo');
const { createTags } = require('./tags');
const { createWatcher } = require('./watcher');
const { createScheduler } = require('./scheduler');
const { registerIpc } = require('./ipc');
const organizer = require('./organizer');
const fsops = require('./fsops');
const cloud = require('./cloud');
const plugins = require('./plugins');

const isSmoke = process.argv.includes('--smoke');
const isDev = process.argv.includes('--dev');
const captureArg = process.argv.find((arg) => arg.startsWith('--capture='));
/** 冒烟脚本要访问的测试目录，由环境变量传入，避免把本机路径写进仓库 */
const smokeDir = process.env.SMOKE_DIR || '';

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;
let store = null;
let undo = null;
let tags = null;
let watcher = null;
let scheduler = null;
let cloudDirs = [];
let quitting = false;
let smokeWatcherTimer = null;

const pluginsDir = () => path.join(app.getPath('userData'), 'plugins');

/** 当前生效的浅/深色，用于窗口底色，避免启动瞬间白闪 */
function shellColor() {
  const theme = store ? store.get().theme : 'system';
  const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
  return dark ? '#0a0a0d' : '#e9ecf2';
}

/* ------------------------------ 窗口模式 ------------------------------ */

/** 三种模式各自的窗口形态 */
const MODE_SPEC = {
  window: { minWidth: 1000, minHeight: 640, alwaysOnTop: false, skipTaskbar: false, resizable: true },
  sidebar: { minWidth: 360, minHeight: 520, alwaysOnTop: true, skipTaskbar: false, resizable: true },
  dock: { minWidth: 420, minHeight: 260, alwaysOnTop: true, skipTaskbar: true, resizable: true },
};

/**
 * 按模式摆放窗口。
 * - 窗口：沿用上次记住的尺寸；
 * - 侧边栏：贴屏幕左侧或右侧，占满工作区高度；
 * - 任务栏悬浮：右下角、贴着任务栏上方的小挂件。
 */
function applyMode(mode, { silent = false } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const spec = MODE_SPEC[mode] || MODE_SPEC.window;
  const prefs = store.get();
  const display = screen.getPrimaryDisplay();
  const work = display.workArea;

  mainWindow.setAlwaysOnTop(spec.alwaysOnTop, spec.alwaysOnTop ? 'floating' : 'normal');
  mainWindow.setSkipTaskbar(spec.skipTaskbar);
  mainWindow.setResizable(spec.resizable);
  mainWindow.setMinimumSize(spec.minWidth, spec.minHeight);

  if (mode === 'sidebar') {
    const width = Math.max(360, Math.min(prefs.sidebarWidth || 420, work.width));
    const x = prefs.sidebarSide === 'right' ? work.x + work.width - width : work.x;
    mainWindow.setBounds({ x, y: work.y, width, height: work.height });
    mainWindow.setMaximumSize(Math.round(work.width), work.height);
  } else if (mode === 'dock') {
    const width = 460;
    const height = 340;
    const margin = 16;
    mainWindow.setMaximumSize(900, 700);
    mainWindow.setBounds({
      x: work.x + work.width - width - margin,
      y: work.y + work.height - height - margin,
      width,
      height,
    });
  } else {
    mainWindow.setMaximumSize(0, 0); // 0 表示不限制
    mainWindow.setBounds({
      x: Math.round(work.x + (work.width - prefs.window.width) / 2),
      y: Math.round(work.y + (work.height - prefs.window.height) / 2),
      width: prefs.window.width,
      height: prefs.window.height,
    });
    if (prefs.window.maximized && !isSmoke) mainWindow.maximize();
  }

  if (!silent) {
    mainWindow.webContents.send('win:modeChanged', { mode, side: prefs.sidebarSide });
  }
}

function createWindow() {
  const prefs = store.get();
  const mode = MODE_SPEC[prefs.mode] ? prefs.mode : 'window';
  const spec = MODE_SPEC[mode];

  mainWindow = new BrowserWindow({
    width: prefs.window.width,
    height: prefs.window.height,
    minWidth: spec.minWidth,
    minHeight: spec.minHeight,
    show: false,
    frame: false,
    roundedCorners: true,
    backgroundColor: shellColor(),
    title: 'FileSorter',
    skipTaskbar: spec.skipTaskbar,
    alwaysOnTop: spec.alwaysOnTop,
    icon: fsSync.existsSync(path.join(__dirname, '..', '..', 'build', 'icon.png'))
      ? path.join(__dirname, '..', '..', 'build', 'icon.png')
      : undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // PDF 预览靠 Chromium 自带的阅读器，必须打开 plugins
      plugins: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (isSmoke) mainWindow.showInactive();
    else mainWindow.show();
    // 恢复上次的窗口形态（尺寸记忆已经存过，这里只摆位置）
    if (mode !== 'window') applyMode(mode, { silent: true });
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

  // 记住窗口尺寸，下次原样打开
  mainWindow.on('close', (event) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const prefs = store.get();
    if (!quitting && prefs.closeToTray && prefs.mode === 'window') {
      // 用户按了关闭但开着"最小化到托盘"，就真的只收进托盘
      event.preventDefault();
      mainWindow.hide();
      if (!prefs.trayHintShown) {
        notify('FileSorter', '已缩到托盘，随时点图标回来');
        store.save({ trayHintShown: true });
      }
      return;
    }
    if (prefs.mode === 'window') {
      const bounds = mainWindow.getNormalBounds();
      store.save({
        window: { width: bounds.width, height: bounds.height, maximized: mainWindow.isMaximized() },
      });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (isSmoke) attachSmokeProbe(mainWindow);
}

/* ------------------------------ 托盘 ------------------------------ */

function trayIcon() {
  const candidates = [
    path.join(__dirname, '..', '..', 'build', 'icon.png'),
    path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    path.join(__dirname, '..', 'renderer', 'assets', 'logo.png'),
  ];
  for (const file of candidates) {
    if (!fsSync.existsSync(file)) continue;
    const image = nativeImage.createFromPath(file);
    if (!image.isEmpty()) return image.resize({ width: 16, height: 16 });
  }
  return nativeImage.createEmpty();
}

function buildTray() {
  if (tray) return;
  tray = new Tray(trayIcon());
  tray.setToolTip('FileSorter');
  const menu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        if (!mainWindow) return;
        mainWindow.show();
        mainWindow.focus();
      },
    },
    {
      label: '整理下载文件夹',
      click: () => runScheduledTidy(true, [app.getPath('downloads')]),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

/* ------------------------------ 通知 ------------------------------ */

function notify(title, body) {
  try {
    if (!Notification.isSupported()) return;
    new Notification({ title, body, silent: false }).show();
  } catch (err) {
    console.warn('[notify]', err.message);
  }
}

/* ------------------------------ 定时整理 ------------------------------ */

/**
 * 执行一次定时整理。
 * @param {boolean} manual 用户手动触发时要弹结果，静默模式只写日志
 * @param {string[]} [overrideDirs]
 */
async function runScheduledTidy(manual = false, overrideDirs) {
  const settings = store.get();
  const dirs = (overrideDirs || settings.schedule.dirs || []).filter(Boolean);
  if (!dirs.length) {
    if (manual) notify('定时整理', '还没有设置要整理的文件夹');
    return { ok: false, reason: 'no-dirs', dirs: [] };
  }

  const excludeCompiled = settings.excludes;
  const result = { ok: true, dirs: [], moved: 0, skipped: [], failed: [] };

  for (const dir of dirs) {
    try {
      const plan = await organizer.buildPlan(dir, { ...settings, excludes: excludeCompiled });
      if (!plan.items.length) {
        result.dirs.push({ dir, moved: 0, note: '没有需要整理的文件' });
        continue;
      }
      const run = await organizer.executePlan(dir, settings, { undo });
      for (const item of run.moved) {
        await tags?.remapPath(item.src, item.dest);
      }
      result.moved += run.moved.length;
      result.failed.push(...run.failed);
      result.dirs.push({ dir, moved: run.moved.length });
    } catch (err) {
      result.failed.push({ name: dir, reason: err.message });
    }
  }

  await store.save({ schedule: { ...settings.schedule, lastRun: Date.now() } });
  fsops.invalidate();

  const shouldNotify = manual || !settings.schedule.silent;
  if (shouldNotify) {
    const text = result.moved
      ? `已自动整理 ${result.moved} 个文件`
      : '这次没有需要整理的文件';
    notify('定时整理完成', text);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tray:action', { action: 'scheduled', result });
  }
  return result;
}

/* ------------------------------ 监听 ------------------------------ */

function startWatcher() {
  watcher = createWatcher({
    onEvent: (event) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (event.type === 'error') return;
      // 整理动作自己引起的变更不需要再提示刷新
      if (smokeWatcherTimer) clearTimeout(smokeWatcherTimer);
      smokeWatcherTimer = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('fs:changed', { dir: event.dir, type: event.type, at: event.at });
          fsops.invalidate(event.dir);
        }
      }, 120);
    },
  });
}

/* ------------------------------ 冒烟探针 ------------------------------ */

/**
 * 加载完成后可按步骤触发交互、截图、打印渲染层报错，然后退出。
 * 只用于自动化校验，正常启动完全不受影响。
 */
function attachSmokeProbe(win) {
  const stepArg = process.argv.find((arg) => arg.startsWith('--smoke-step='));
  const step = stepArg ? stepArg.split('=')[1] : '';

  win.webContents.on('console-message', (event, ...rest) => {
    const message = (event && event.message) || rest[1] || '';
    if (message) console.log('[renderer]', message);
  });
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error('[smoke] 加载失败', code, description, url);
  });
  win.webContents.on('preload-error', (_event, file, error) => {
    console.error('[smoke] preload 出错', file, error && error.message);
  });

  win.webContents.once('did-finish-load', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1600));

    const steps = {
      dark: `document.getElementById('btnTheme').click()`,
      light: `(async () => {
        const s = await window.filesorter.settings.get();
        if ((s.settings.theme || 'system') !== 'dark') document.getElementById('btnTheme').click();
      })()`,
      grid: `document.getElementById('btnGrid').click()`,
      list: `document.getElementById('btnList').click()`,
      details: `(() => {
        const rows = document.querySelectorAll('.file-row');
        if (rows[1]) rows[1].click();
      })()`,
      /* 详情栏要在列表视图下才有行可点，这里先切列表再选一个真文件 */
      detailfile: `(async () => {
        document.getElementById('btnList').click();
        await new Promise((r) => setTimeout(r, 400));
        const rows = [...document.querySelectorAll('.file-row')];
        const nameOf = (el) => (el.dataset.path || '').split(/[\\\\/]/).pop();
        // 挑一个带「副本」或「发票」的：详情栏能同时展示正文与提示行，截图信息量更足
        const target =
          rows.find((el) => /副本|发票/.test(nameOf(el))) ||
          rows.find((el) => /\\.(md|txt|pdf|mp4)$/i.test(el.dataset.path || '')) ||
          rows[3];
        if (target) target.click();
      })()`,
      /* 网格视图下的选中态，用于拍「卡片 + 详情」的组合 */
      gridselect: `(() => {
        const card = [...document.querySelectorAll('.grid-card')][5];
        if (card) card.click();
      })()`,
      organize: `(async () => {
        await window.__lens.navigate(${JSON.stringify(smokeDir)});
        await new Promise((r) => setTimeout(r, 600));
        document.getElementById('btnOrganize').click();
      })()`,
      settings: `document.getElementById('btnSettings').click()`,
      rules: `(async () => {
        document.getElementById('btnSettings').click();
        await new Promise((r) => setTimeout(r, 300));
        const tab = document.querySelector('[data-set-tab="rules"]');
        if (tab) tab.click();
      })()`,
      /* 写两条示例规则再打开规则页，用于文档截图；跑完记得把 customRules 清空 */
      rules_demo: `(async () => {
        await window.filesorter.setMode('window');
        await window.filesorter.settings.save({
          customRules: [
            {
              id: 'demo-notes',
              name: '笔记单独放',
              enabled: true,
              target: '笔记',
              conditions: [{ field: 'name', op: 'contains', value: '笔记' }],
            },
            {
              id: 'demo-big',
              name: '大文件按年月归档',
              enabled: true,
              target: '大文件/{yyyy}-{mm}',
              conditions: [{ field: 'size', op: 'gt', value: 100 }],
            },
          ],
        });
        // 直接调 IPC 改设置不会更新界面内存里的 state，重载一次让应用带着新规则启动
        location.reload();
      })()`,
      schedule: `(async () => {
        document.getElementById('btnSettings').click();
        await new Promise((r) => setTimeout(r, 300));
        const tab = document.querySelector('[data-set-tab="schedule"]');
        if (tab) tab.click();
      })()`,
      tags: `document.getElementById('btnTags')?.click()`,
      dupes: `document.getElementById('btnDupes')?.click()`,
      space: `document.getElementById('btnSpace')?.click()`,
      batch: `document.getElementById('btnBatch')?.click()`,
      history: `document.getElementById('btnHistory')?.click()`,
      search: `(() => {
        const input = document.getElementById('searchInput');
        input.value = 'mp4';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`,
      file: `(() => {
        const row = [...document.querySelectorAll('.file-row')].find((el) => el.dataset.path.endsWith('.mp4'));
        if (row) row.click();
      })()`,
      textpreview: `(async () => {
        const viewport = document.getElementById('viewport');
        viewport.scrollTop = viewport.scrollHeight;
        await new Promise((r) => setTimeout(r, 400));
        const row = [...document.querySelectorAll('.file-row')].find((el) => el.dataset.path.endsWith('.md'));
        if (row) row.click();
      })()`,
      denied: `window.__lens.navigate('C:/System Volume Information')`,
      big: `window.__lens.navigate(${JSON.stringify(smokeDir)})`,
      scroll: `(async () => {
        await window.__lens.navigate(${JSON.stringify(smokeDir)});
        const viewport = document.getElementById('viewport');
        const started = performance.now();
        for (let i = 1; i <= 30; i += 1) {
          viewport.scrollTop = i * 900;
          await new Promise((r) => requestAnimationFrame(r));
        }
        const elapsed = performance.now() - started;
        console.log('SCROLL ' + JSON.stringify({
          total: document.getElementById('vcontent').style.height,
          nodes: document.querySelectorAll('.file-row').length,
          avgFrameMs: +(elapsed / 30).toFixed(2),
        }));
      })()`,
      metrics: `(() => {
        const vp = document.getElementById('viewport');
        console.log('METRICS ' + JSON.stringify({
          clientWidth: vp.clientWidth,
          rows: document.querySelectorAll('.file-row').length,
          mode: document.documentElement.dataset.mode,
        }));
      })()`,
      sidemode: `window.filesorter.setMode('sidebar')`,
      dockmode: `window.filesorter.setMode('dock')`,
      windowmode: `window.filesorter.setMode('window')`,
      /* 端到端：进入临时目录 → 打开整理预览 → 取消勾选第一个分组 → 真正执行 */
      organize_run: `(async () => {
        await window.__lens.navigate(${JSON.stringify(smokeDir)});
        await new Promise((r) => setTimeout(r, 600));
        document.getElementById('btnOrganize').click();
        await new Promise((r) => setTimeout(r, 900));
        const group = document.querySelector('[data-org-group]');
        if (group) group.click();
        await new Promise((r) => setTimeout(r, 250));
        const go = document.querySelector('[data-org-act="run"]');
        if (go) go.click();
        await new Promise((r) => setTimeout(r, 1500));
      })()`,
      /* 整理之后看历史面板：能直观看到刚写进去的那一批 */
      organize_history: `(async () => {
        await window.__lens.navigate(${JSON.stringify(smokeDir)});
        await new Promise((r) => setTimeout(r, 500));
        document.getElementById('btnHistory')?.click();
        await new Promise((r) => setTimeout(r, 500));
      })()`,
      /* 撤销最近 5 批，用来验证「撤销」这条 IPC 与日志状态机在真实环境里是通的 */
      undo_run: `(async () => {
        await window.filesorter.undo({ count: 5 });
        await window.__lens.navigate(${JSON.stringify(smokeDir)});
        await new Promise((r) => setTimeout(r, 700));
      })()`,
      sidebar: `(() => {
        const item = document.querySelector('.place[data-path]');
        if (item) item.click();
      })()`,
    };

    if (step) {
      const script = steps[step];
      if (script) {
        await win.webContents.executeJavaScript(script).catch((err) => {
          console.error('[smoke] 步骤执行失败', step, err.message);
        });
        await new Promise((resolve) => setTimeout(resolve, 1600));
      } else {
        console.error('[smoke] 未知步骤', step);
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

/* ------------------------------ 启动 ------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.filesorter.app');
  Menu.setApplicationMenu(null);

  store = createStore(app.getPath('userData'));
  await store.load();
  undo = createUndo(app.getPath('userData'));
  tags = createTags(app.getPath('userData'));
  await tags.load();
  await plugins.ensureExample(pluginsDir());
  cloudDirs = await cloud.detect({ home: app.getPath('home') }).catch(() => []);

  startWatcher();

  scheduler = createScheduler({
    getSettings: () => store.get(),
    onFire: () => runScheduledTidy(false),
  });

  registerIpc({
    ipcMain,
    dialog,
    shell,
    clipboard,
    app,
    store,
    undo,
    tags,
    watcher,
    scheduler,
    getWindow: () => mainWindow,
    setMode: (mode) => applyMode(mode),
    pluginsDir: pluginsDir(),
    runScheduledTidy,
    notify,
    cloudDirs,
  });

  createWindow();
  buildTray();
  scheduler.arm();

  // 设置里的定时开关变了就重排
  store.subscribe(() => scheduler.arm());

  nativeTheme.on('updated', () => {
    if (store.get().theme !== 'system') return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(shellColor());
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on('before-quit', () => {
  quitting = true;
  scheduler?.clear();
  watcher?.unwatch();
});

// 有托盘的程序不能因为关窗就退出
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !store?.get().closeToTray) app.quit();
});
