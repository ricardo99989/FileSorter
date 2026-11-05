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
/** 冒烟截图用的合成桌面，见 createWindow 里 SMOKE_BACKDROP 那段 */
let backdropWindow = null;
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

/**
 * DWM 亚克力只有 Windows 11（build >= 22000）才有。
 * 它会由系统在窗口背后做真实高斯模糊 —— 这是唯一能"透出模糊桌面"的途径，
 * 因为 Chromium 的 backdrop-filter 取不到窗口外的像素。
 */
let useAcrylic = false;

function detectAcrylic() {
  if (process.platform !== 'win32') return false;
  // getSystemVersion() 形如 "10.0.26200"
  const build = Number(String(process.getSystemVersion() || '').split('.')[2] || 0);
  return build >= 22000;
}

/**
 * 让系统明暗跟随应用主题。
 *
 * DWM 亚克力的 tint 是按「系统明暗」取的，不认应用里的 data-theme。
 * 应用切深色而系统还是浅色时，就会得到「浅色 tint + 白色文字」—— 白字压白玻璃，
 * 一个字都看不见（真踩过）。把 themeSource 钉过去，材质和文字才在同一侧。
 *
 * 实测：改 themeSource 后 DWM 会在约 300~500ms 内重采样 tint，不需要重贴材质。
 * （早先以为要 setBackgroundMaterial('none') 再贴回来，实测那条路只会让窗口
 * 先 transparent 闪一下，tint 该什么时候变还是什么时候变。）
 */
function syncNativeTheme() {
  const theme = store ? store.get().theme : 'system';
  nativeTheme.themeSource = theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'system';
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
  // --smoke-mode= 显式指定显示模式。不加这个参数时用 store 里的值，
  // 而上一次冒烟可能已经把 mode 存成 dock/sidebar，接着拍窗口模式的图就会拍到一小条。
  const modeArg = process.argv.find((a) => a.startsWith('--smoke-mode='));
  const forcedMode = modeArg ? modeArg.split('=')[1] : '';
  const mode = MODE_SPEC[forcedMode] ? forcedMode : MODE_SPEC[prefs.mode] ? prefs.mode : 'window';
  const spec = MODE_SPEC[mode];
  useAcrylic = detectAcrylic();

  /**
   * 冒烟截图专用：垫一张合成桌面。
   *
   * 亚克力档位下窗口底板是全透明的，背后究竟是用户的浏览器、蓝天草地还是一屏代码，
   * 截图完全是两个东西。文档截图必须可复现，所以给了 SMOKE_BACKDROP 就先铺一层
   * 内容已知的全屏背景，再把主窗口移到它上面。
   */
  if (isSmoke && process.env.SMOKE_BACKDROP) {
    const d = screen.getPrimaryDisplay();
    backdropWindow = new BrowserWindow({
      x: 0,
      y: 0,
      width: d.size.width,
      height: d.size.height,
      frame: false,
      skipTaskbar: true,
      focusable: false,
      backgroundColor: '#1b2430',
      // 先不 show：合成桌面一旦先显示，DWM 会按那一刻的系统明暗给后面的窗口取 tint，
      // 主题是 dark 也会拿到浅色 tint（白字压白玻璃，一个字都看不见）。
      show: false,
    });
    backdropWindow.loadFile(path.join(__dirname, 'backdrop.html'), {
      // 把当前主题带给合成桌面：深色主题下要一张暮色桌面，
      // 配大亮天的话亚克力一透，深色模式的截图就成灰蓝一团。
      query: { theme: store.get().theme === 'dark' ? 'dark' : 'light' },
    });
    // 建合成桌面这一步会把 themeSource 弹回 system，必须在建主窗之前再钉一次。
    // 少了这一行，深色主题下主窗口会拿到浅色 tint —— 白字压白玻璃，全看不清楚。
    syncNativeTheme();
  }

  mainWindow = new BrowserWindow({
    width: prefs.window.width,
    height: prefs.window.height,
    minWidth: spec.minWidth,
    minHeight: spec.minHeight,
    show: false,
    frame: false,
    roundedCorners: true,
    // 亚克力由系统在窗口背后绘制，页面底板必须透明才透得上来
    backgroundColor: useAcrylic ? '#00000000' : shellColor(),
    ...(useAcrylic ? { backgroundMaterial: 'acrylic' } : {}),
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

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), {
    query: { material: useAcrylic ? 'acrylic' : 'solid' },
  });

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

  // 合成桌面只是背景，主窗口必须压在它上面，否则截出来是空的。
  // 放在主窗口就绪之后再 show，DWM 才会按主窗口创建时的系统明暗取 tint。
  if (backdropWindow && !backdropWindow.isDestroyed()) {
    // 冒烟用 showInactive 开窗，宿主 IDE / 浏览器随时可能抢回前台把两层一起盖住，
    // desktopCapturer 就会拍到别人的界面。给两层不同的 alwaysOnTop 层级：
    // 桌面 floating、应用 screen-saver，既都在普通窗口之上，又保证应用压着桌面。
    backdropWindow.setAlwaysOnTop(true, 'screen-saver');
    backdropWindow.showInactive();
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.moveTop();
  }

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
      /* 主题是循环切换的：system → light → dark → system，
         点一次不保证到目标档，所以循环点到为止 */
      dark: `(async () => {
        for (let i = 0; i < 4; i += 1) {
          if (document.documentElement.dataset.theme === 'dark') break;
          document.getElementById('btnTheme').click();
          await new Promise((r) => setTimeout(r, 140));
        }
      })()`,
      light: `(async () => {
        for (let i = 0; i < 4; i += 1) {
          if (document.documentElement.dataset.theme === 'light') break;
          document.getElementById('btnTheme').click();
          await new Promise((r) => setTimeout(r, 140));
        }
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
      /* 轮盘悬停：高亮靠 class 切换，合成事件能触发同一套委托逻辑 */
      wheelhover: `(() => {
        const segs = [...document.querySelectorAll('.wheel__seg')];
        const seg = segs[2] || segs[0];
        if (seg) seg.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      })()`,
      /* 轮盘点击：走"跳转或筛选"的完整链路 */
      wheelfilter: `(() => {
        const seg = document.querySelectorAll('.wheel__seg')[0];
        if (seg) seg.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      })()`,
      /* 收起轮盘，验证折叠态那行摘要 */
      wheelfold: `(() => { document.getElementById('btnWheelFold').click(); })()`,
      /* 三模式切换，窗口尺寸由主进程按模式重排，截图前要等它稳住 */
      mode_window: `window.filesorter.setMode('window')`,
      mode_sidebar: `window.filesorter.setMode('sidebar')`,
      mode_dock: `window.filesorter.setMode('dock')`,
      organize: `(async () => {
        await window.__lens.navigate(${JSON.stringify(smokeDir)});
        await new Promise((r) => setTimeout(r, 600));
        document.getElementById('btnOrganize').click();
      })()`,
      settings: `(async () => {
        document.getElementById('btnSettings').click();
        await new Promise((r) => setTimeout(r, 400));
        // 外观页设置项较多，滚到底才能看到"玻璃雾度"那一行
        const body = document.getElementById('settingsBody');
        if (body) body.scrollTop = body.scrollHeight;
      })()`,
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
      themec: `(() => {
        console.log('THEMEC ' + JSON.stringify({
          dataTheme: document.documentElement.dataset.theme,
          dataMaterial: document.documentElement.dataset.material,
          cls: document.documentElement.className,
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

    /**
     * 截图前把轮盘的悬停态复位：窗口位置是上次记住的，鼠标可能正好压在轮盘上，
     * 那样拍到的中心区是"某个分类的详情"而不是总数，截图就没法当基准。
     */
    await win.webContents
      .executeJavaScript(
        `(() => {
          const w = document.getElementById('wheel');
          if (w) w.dispatchEvent(new PointerEvent('pointerleave'));
        })()`,
      )
      .catch(() => {});
    /* 合成指针一律挪回窗口左上角：留在系统任务栏上会弹出宿主的窗口缩略图，
       那张置顶预览窗连 alwaysOnTop 都压不住，截图就废了。 */
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 });
    /* 但这次复位会把 wheelhover 刚点亮的高亮清掉，所以复位之后再补一次合成 hover。
       顺序不能反：先 hover 再移指针，Chromium 会按真实指针位置重新派发 pointerout。 */
    if (step === 'wheelhover') {
      await win.webContents
        .executeJavaScript(
          `(() => {
            const seg = [...document.querySelectorAll('.wheel__seg')][2];
            if (seg) seg.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
          })()`,
        )
        .catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, 260));

    try {
      /*
       * --capture-screen 走系统全屏截图。
       * capturePage 只截窗口自己的绘制树，亚克力是 DWM 画在窗口背后的，
       * 用 capturePage 拍出来永远是一片透明，验证不了"透出桌面"这件事。
       */
      let image;
      if (process.argv.includes('--capture-screen')) {
        const { desktopCapturer } = require('electron');
        const display = screen.getPrimaryDisplay();
        // 冒烟的各个步骤可能跑上好几秒，期间前台窗口又换了人。截图前把两层再钉一次，
        // 并留一帧给 DWM 重新排层，否则会拍到空桌面或半个窗口。
        if (backdropWindow && !backdropWindow.isDestroyed()) {
          backdropWindow.setAlwaysOnTop(true, 'floating');
          backdropWindow.showInactive();
          win.setAlwaysOnTop(true, 'screen-saver');
          win.moveTop();
          // 宿主窗口若正开着中文输入法，候选条是系统级置顶窗，会飘到应用上面。
          // 把焦点收回来、并让页面里任何输入框失焦，候选条就会随组合结束自行收起。
          win.focus();
          await win.webContents
            .executeJavaScript(
              '(() => { const a = document.activeElement; if (a && a.blur) a.blur(); })()',
            )
            .catch(() => {});
          await new Promise((resolve) => setTimeout(resolve, 220));
        }
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: display.size.width, height: display.size.height },
        });
        // 多显示器时 sources[0] 不一定是主屏，按 display_id 认领
        const source =
          sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
        image = source ? source.thumbnail : await win.webContents.capturePage();
      } else {
        image = await win.webContents.capturePage();
      }
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
  // 必须在建窗之前：窗口一创建，DWM 就会按当时的系统明暗取材质 tint
  syncNativeTheme();
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

  /**
   * 冒烟专用：允许脚本指定窗口尺寸。
   * 截图要反映"默认 1360×860 下长什么样"，而本机 store 里存的是上次拖过的尺寸，
   * 不覆盖就会拿一个被改小的窗口当基准，评审判断全跑偏。
   */
  const sizeArg = process.argv.find((arg) => arg.startsWith('--smoke-size='));
  if (isSmoke && sizeArg && mainWindow && !mainWindow.isDestroyed()) {
    const [w, h] = sizeArg.split('=')[1].split('x').map(Number);
    if (w > 0 && h > 0) {
      mainWindow.setSize(Math.round(w), Math.round(h));
      // 只设尺寸不定位，窗口会留在上次拖到的位置 —— 底部一出屏就被裁掉，
      // 设置面板那种高浮层直接少一半，截图根本没法评审。
      const area = screen.getPrimaryDisplay().workArea;
      mainWindow.setPosition(
        Math.max(area.x, Math.round(area.x + (area.width - w) / 2)),
        Math.max(area.y, Math.round(area.y + (area.height - h) / 2)),
      );
    }
  }

  buildTray();
  scheduler.arm();

  // 设置里的定时开关变了就重排；主题变了要同步系统明暗，DWM 才会跟着换 tint
  let lastTheme = store.get().theme;
  store.subscribe(() => {
    const theme = store.get().theme;
    if (theme !== lastTheme) {
      lastTheme = theme;
      syncNativeTheme();
    }
    scheduler.arm();
  });

  nativeTheme.on('updated', () => {
    if (store.get().theme !== 'system') return;
    // 亚克力下窗口底板是透明的，由系统决定明暗，不能刷实色回去
    if (mainWindow && !mainWindow.isDestroyed() && !useAcrylic) {
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
