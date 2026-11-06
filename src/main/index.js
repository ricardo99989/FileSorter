'use strict';

const path = require('node:path');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const {
  app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, Tray,
  nativeTheme, nativeImage, Notification, screen, desktopCapturer, session,
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
/** 性能测试目录（3000 个文件），没给就退回 smokeDir */
const smokePerf = process.env.SMOKE_PERF || smokeDir;

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

/* --------------------------- 桌面亮度采样 --------------------------- */

/**
 * 玻璃的**厚度**要跟着背后的桌面走，但**明暗**不能跟着走。
 *
 * 上一版把明暗也交给采样：亮度 < 0.5 就把浅色主题翻成深色玻璃。实际用起来是灾难——
 * 用户选了浅色模式，得到一块深色玻璃；而且窗口一盖满屏幕，采样只剩边缘几十个像素，
 * 兜底逻辑会把「我们自己的窗口」也算进平均值，判断直接反了（截图里浅色字压在浅绿玻璃上）。
 *
 * 现在的规则：
 *   明暗 = 主题（浅色模式永远是浅色玻璃，可预期）
 *   厚度 = 采样（背景越暗，白色填料越多，把表面推到 0.68；背景够亮就只用 5%）
 *
 * 采样在**窗口创建之前**做，拿到的是一张干净的桌面，不会拍到自己。
 * 只存一张 64×36 的亮度表，之后按屏幕坐标查表，不再截图。
 */
let desktopMap = null;

const MAP_COLS = 64;
const MAP_ROWS = 36;

async function captureDesktopMap() {
  try {
    const display = screen.getPrimaryDisplay();
    const aspect = display.size.height / Math.max(1, display.size.width);
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: MAP_COLS * 4, height: Math.round(MAP_COLS * 4 * aspect) },
    });
    const source =
      sources.find((item) => String(item.display_id) === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) return;

    const size = source.thumbnail.getSize();
    const bitmap = source.thumbnail.toBitmap(); // BGRA
    const values = new Float32Array(MAP_COLS * MAP_ROWS);
    for (let cy = 0; cy < MAP_ROWS; cy += 1) {
      const y0 = Math.floor((cy * size.height) / MAP_ROWS);
      const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * size.height) / MAP_ROWS));
      for (let cx = 0; cx < MAP_COLS; cx += 1) {
        const x0 = Math.floor((cx * size.width) / MAP_COLS);
        const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * size.width) / MAP_COLS));
        let sum = 0;
        let n = 0;
        for (let y = y0; y < y1; y += 1) {
          for (let x = x0; x < x1; x += 1) {
            const i = (y * size.width + x) * 4;
            // Rec.709：人眼对绿最敏感，直接 RGB 平均会把蓝天算得偏亮
            sum += (0.2126 * bitmap[i + 2] + 0.7152 * bitmap[i + 1] + 0.0722 * bitmap[i]) / 255;
            n += 1;
          }
        }
        values[cy * MAP_COLS + cx] = n ? sum / n : 0.5;
      }
    }
    desktopMap = {
      values,
      cols: MAP_COLS,
      rows: MAP_ROWS,
      width: display.size.width,
      height: display.size.height,
    };
  } catch (err) {
    /* 采不到就退回 CSS 兜底值，不影响启动 */
  }
}

/** 取一块屏幕矩形（DIP）下的桌面平均亮度；越界部分自动裁掉 */
function areaLuminance(rect) {
  if (!desktopMap) return null;
  const { values, cols, rows, width, height } = desktopMap;
  const x0 = Math.max(0, Math.floor((rect.x / width) * cols));
  const x1 = Math.min(cols, Math.ceil(((rect.x + rect.width) / width) * cols));
  const y0 = Math.max(0, Math.floor((rect.y / height) * rows));
  const y1 = Math.min(rows, Math.ceil(((rect.y + rect.height) / height) * rows));
  if (x1 <= x0 || y1 <= y0) return null;
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      sum += values[y * cols + x];
      n += 1;
    }
  }
  return n ? sum / n : null;
}

/** 整屏的平均亮度 + 复杂度（给渲染进程算填料用） */
function backdropSummary(rects = []) {
  if (!desktopMap) return { luminance: null, busy: null, panels: [] };
  const { values } = desktopMap;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    sumSq += values[i] * values[i];
  }
  const mean = sum / values.length;
  const std = Math.sqrt(Math.max(0, sumSq / values.length - mean * mean));
  return {
    luminance: Number(mean.toFixed(3)),
    // 0.18 是「纯色壁纸 → 满屏图标」的实测跨度，归一到 0~1
    busy: Number(Math.min(1, std / 0.18).toFixed(3)),
    panels: rects.map((rect) => {
      const value = areaLuminance(rect);
      return value == null ? null : Number(value.toFixed(3));
    }),
  };
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

  // 冒烟专用：强制走另一条材质路径，用来同时截 acrylic 与 solid 两套图
  const materialArg = process.argv.find((a) => a.startsWith('--smoke-material='));
  if (isSmoke && materialArg) useAcrylic = materialArg.split('=')[1] !== 'solid';

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
      query: {
        // --smoke-backdrop=dark 可以强制一张暮色桌面，用来单独验证「浅色主题 + 深色桌面」
        // 这一组最容易翻车的组合（3.3 的 bug 就出在这里）
        theme:
          process.argv.includes('--smoke-backdrop=dark') || store.get().theme === 'dark'
            ? 'dark'
            : 'light',
      },
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
    /* 冒烟可切到 mica 做 A/B：mica 取壁纸色、几乎没有霜层，比 acrylic 更透；
       acrylic 的霜更重但色温更稳。默认仍是 acrylic，实测哪张更通透再决定。 */
    ...(useAcrylic
      ? {
          backgroundMaterial:
            process.env.SMOKE_MATERIAL ||
            (store.get().glassBase === 'clear' || store.get().glassBase === 'live'
              ? 'none'
              : 'acrylic'),
        }
      : {}),
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

  /**
   * 实时玻璃档必须开内容保护：DWM 会把这扇窗从所有截图路径里排除，
   * 于是桌面流拿到的是"窗口背后"的画面。不在这档时绝不开 —— 开了用户自己就截不到图。
   */
  if (store.get().glassBase === 'live') {
    mainWindow.setContentProtection(true);
  }

  mainWindow.once('ready-to-show', () => {
    /**
     * --hidden 是开机自启时带的参数：直接进托盘，不抢焦点。
     * 用户点托盘图标（或再次双击快捷方式）再展开。
     */
    const hiddenStart = process.argv.includes('--hidden') && !isSmoke;
    if (isSmoke) mainWindow.showInactive();
    else if (!hiddenStart) mainWindow.show();
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

    /**
     * 合成桌面是 createWindow 里才铺上去的，而亮度表是在开窗之前采的。
     * 冒烟时必须在桌面铺好之后重采一次，否则测的还是真实壁纸的亮度。
     */
    if (isSmoke && process.env.SMOKE_BACKDROP) {
      // 先把主窗藏起来再采：否则采到的是我们自己那块明亮的玻璃，亮度表全错
      const wasVisible = win.isVisible();
      win.hide();
      await new Promise((resolve) => setTimeout(resolve, 160));
      await captureDesktopMap();
      if (wasVisible) win.showInactive();
      await win.webContents
        .executeJavaScript('window.__lens && window.__lens.refreshTint && window.__lens.refreshTint()')
        .catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 320));
    }

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
        const main = document.querySelector('.main');
        console.log('METRICS ' + JSON.stringify({
          clientWidth: vp.clientWidth,
          innerW: window.innerWidth,
          dpr: window.devicePixelRatio,
          rows: document.querySelectorAll('.file-row').length,
          cards: document.querySelectorAll('.grid-card').length,
          mode: document.documentElement.dataset.mode,
          theme: document.documentElement.dataset.theme,
          mat: document.documentElement.dataset.material,
          tint: {
            root: getComputedStyle(document.documentElement).getPropertyValue('--tint-a').trim(),
            main: getComputedStyle(document.querySelector('.main')).getPropertyValue('--tint-a').trim(),
            sidebar: getComputedStyle(document.querySelector('.sidebar')).getPropertyValue('--tint-a').trim(),
          },
          backdrop: ['.titlebar', '.sidebar', '.main', '.details'].map(
            (sel) => document.querySelector(sel)?.dataset.backdrop,
          ),
          mainW: Math.round(main.getBoundingClientRect().width),
          mainOverflow: main.getBoundingClientRect().right > window.innerWidth + 1,
          headColor: getComputedStyle(document.querySelector('.tablehead')).color,
          desc: (() => {
            const el = document.querySelector('.file-row__desc');
            if (!el) return null;
            const cs = getComputedStyle(el);
            const chain = [];
            let cur = el;
            while (cur && cur !== document.body) {
              const o = getComputedStyle(cur).opacity;
              if (o !== '1') chain.push(cur.className + ':' + o);
              cur = cur.parentElement;
            }
            return { color: cs.color, size: cs.fontSize, weight: cs.fontWeight, opacities: chain };
          })(),
          headOpacity: getComputedStyle(document.querySelector('.tablehead')).opacity,
          ink3: getComputedStyle(document.documentElement).getPropertyValue('--ink-3').trim(),
        }));
      })()`,
      sidemode: `window.filesorter.setMode('sidebar')`,
      dockmode: `window.filesorter.setMode('dock')`,
      windowmode: `window.filesorter.setMode('window')`,
      /* 回归：紧凑模式里设置入口还在不在，弹窗能不能在 460×340 里铺开 */
      compact_settings: `(async () => {
        await window.filesorter.setMode('dock');
        await new Promise((r) => setTimeout(r, 800));
        const gear = document.getElementById('btnCompactSettings');
        const back = document.getElementById('btnCompactExpand');
        gear.click();
        await new Promise((r) => setTimeout(r, 600));
        const modal = document.querySelector('.modal');
        const rect = modal ? modal.getBoundingClientRect() : null;
        console.log('COMPACT ' + JSON.stringify({
          mode: document.documentElement.dataset.mode,
          gearVisible: !!gear.offsetParent,
          backVisible: !!back.offsetParent,
          modalOpen: !!modal && modal.classList.contains('is-open'),
          modal: rect ? [Math.round(rect.width), Math.round(rect.height)] : null,
          bodyScroll: (() => {
            const b = document.getElementById('settingsBody');
            return b ? [b.clientHeight, b.scrollHeight] : null;
          })(),
        }));
      })()`,
      /* 3.7：实时透桌面 —— 只验证"流起来了 + 有帧 + 采样矩形对得上"，画面用 capturePage 验 */
      live: `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const out = {};
        const applied = await window.__lens.setGlassBase('live');
        out.applied = applied.ok;
        if (applied.error) out.error = applied.error;
        await wait(2200);
        out.dataset = document.documentElement.dataset.glassBase;
        out.stats = window.__lens.liveStats();
        out.geom = await window.filesorter.geometry().then((r) => r.data?.display || null);
        console.log('LIVE ' + JSON.stringify(out));
      })()`,
      /* 3.6：玻璃底切换 + 设置页是否出现新行 */
      glassbase: `(async () => {
        const out = {};
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        document.getElementById('btnSettings').click();
        await wait(700);
        out.hasRow = Boolean(document.querySelector('[data-segment=\"glassBase\"]'));
        const btns = [...document.querySelectorAll('[data-segment=\"glassBase\"] button')];
        out.segBtns = btns.map((b) => b.textContent);
        // 走真实路径：点「全透明」
        btns.find((b) => b.dataset.value === 'clear')?.click();
        await wait(700);
        out.dataset = document.documentElement.dataset.glassBase;
        out.stored = await window.filesorter.settings.get().then((r) => r.data?.glassBase).catch(() => null);
        out.scrim = getComputedStyle(document.querySelector('.vcontent')).backgroundColor;
        // 再切回系统磨砂
        btns.find((b) => b.dataset.value === 'acrylic')?.click();
        await wait(600);
        out.dataset2 = document.documentElement.dataset.glassBase;
        console.log('GLASSBASE ' + JSON.stringify(out));
      })()`,
      /* 3.6：悬浮/侧栏模式下换盘符 */
      places: `(async () => {
        const out = {};
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        await window.filesorter.setMode('dock');
        await wait(900);
        out.mode = document.documentElement.dataset.mode;
        out.btnVisible = Boolean(document.getElementById('btnPlaces')?.offsetParent);
        document.getElementById('btnPlaces').click();
        await wait(600);
        const pop = document.getElementById('placePop');
        out.open = pop && !pop.hidden;
        const items = [...pop.querySelectorAll('.placepop__item')];
        out.items = items.map((el) => el.dataset.path);
        const other = items.find((el) => /^[D-Z]:/i.test(el.dataset.path || ''));
        out.pick = other ? other.dataset.path : null;
        if (other) other.click();
        await wait(1200);
        out.cwd = window.__lens.state.cwd;
        out.rows = document.querySelectorAll('.file-row').length;
        out.popClosed = document.getElementById('placePop').hidden;
        console.log('PLACES ' + JSON.stringify(out));
      })()`,
      /* 3.5 回归：新手引导、拖拽归类、搜索耗时 */
      v35: `(async () => {
        const out = {};
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        await wait(300);
        out.onboard = Boolean(document.querySelector('.onboard'));
        document.getElementById('onboardSkip')?.click();
        await wait(300);
        out.onboardClosed = !document.querySelector('.onboard');

        // 搜索耗时（3000 个文件的目录）
        await window.__lens.navigate(${JSON.stringify(smokePerf)});
        await wait(700);
        const t0 = performance.now();
        const res = await window.filesorter.search(${JSON.stringify(smokePerf)}, 'report');
        out.searchMs = Math.round(performance.now() - t0);
        out.searchHits = res.ok ? res.data.hits.length : -1;

        // 拖拽：只验证拖起时是否带上路径（don't 真的 drop —— 会移动演示文件）
        await window.__lens.navigate(${JSON.stringify(smokeDir)});
        await wait(700);
        const rows = [...document.querySelectorAll('.file-row')];
        out.rows = rows.length;
        const dt = new DataTransfer();
        rows[0]?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        out.dragPaths = JSON.parse(dt.getData('text/plain') || '[]').length;
        out.dropping = document.getElementById('wheel').classList.contains('is-dropping');
        rows[0]?.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
        out.droppingEnd = document.getElementById('wheel').classList.contains('is-dropping');
        console.log('V35 ' + JSON.stringify(out));
      })()`,
      /* 诊断：紧凑模式是否丢失当前目录、弹窗底色是否跟随主题 */
      diag: `(async () => {
        const out = {};
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        await window.__lens.navigate(${JSON.stringify(smokeDir)});
        await wait(800);
        out.cwdWindow = window.__lens.state.cwd;
        await window.filesorter.setMode('dock');
        await wait(900);
        out.cwdDock = window.__lens.state.cwd;
        out.mode = document.documentElement.dataset.mode;
        out.rowsDock = document.querySelectorAll('.file-row').length;
        await window.filesorter.setMode('window');
        await wait(900);
        document.getElementById('btnSettings').click();
        await wait(600);
        const modal = document.querySelector('.modal');
        const ms = getComputedStyle(modal);
        out.theme = document.documentElement.dataset.theme;
        out.lum = document.documentElement.dataset.lum || null;
        out.mat = document.documentElement.dataset.material;
        out.modalBg = ms.backgroundColor;
        out.modalFilter = ms.backdropFilter;
        out.readSheet = getComputedStyle(document.documentElement).getPropertyValue('--read-sheet-strong').trim();
        out.mainBg = getComputedStyle(document.querySelector('.main')).backgroundColor;
        out.mainImage = getComputedStyle(document.querySelector('.main')).backgroundImage.slice(0, 60);
        out.mainFilter = getComputedStyle(document.querySelector('.main')).backdropFilter;
        out.glassAfter = getComputedStyle(document.querySelector('.main'), '::after').backdropFilter;
        console.log('DIAG ' + JSON.stringify(out));
      })()`,
      /* 预览浮层的静态取证：打开后不关，留给截图 */
      previewshot: `(async () => {
        await window.__lens.navigate(${JSON.stringify(smokeDir)});
        await new Promise((r) => setTimeout(r, 800));
        const target = window.__lens.state.entries.find((item) => /\.md$/i.test(item.path));
        if (target) window.__lens.preview(target);
        await new Promise((r) => setTimeout(r, 700));
      })()`,
      /* 端到端：收藏 → 范围筛选 → 双击预览 → 全选 → Esc 关闭 */
      featuretest: `(async () => {
        const out = {};
        window.__lens.state.favorites.clear();
        window.__lens.state.favoriteList = [];
        await window.filesorter.settings.save({ favorites: [] });
        await window.__lens.navigate(${JSON.stringify(smokeDir)});
        await new Promise((r) => setTimeout(r, 800));
        document.getElementById('btnList').click();
        await new Promise((r) => setTimeout(r, 500));

        const rows = () => [...document.querySelectorAll('.file-row')];
        out.rows = rows().length;

        // 1) 收藏第一个条目
        rows()[0]?.querySelector('[data-act="fav"]')?.click();
        await new Promise((r) => setTimeout(r, 500));
        out.favCount = window.__lens.state.favorites.size;
        out.favStored = window.__lens.state.favoriteList.length;

        // 2) 范围切到收藏，应该只剩 1 条
        window.__lens.setScope('fav');
        await new Promise((r) => setTimeout(r, 500));
        out.favRows = rows().length;
        out.favEmpty = !document.getElementById('state').hidden;

        window.__lens.setScope('all');
        await new Promise((r) => setTimeout(r, 400));

        // 3) 直接对 entries 里的文本文件开预览（虚拟列表里它可能在屏幕外）
        const target =
          window.__lens.state.entries.find((item) => /\.md$/i.test(item.path)) ||
          window.__lens.state.entries.find((item) => /\.(txt|json)$/i.test(item.path));
        out.found = Boolean(target);
        out.target = target ? target.path.split(/[\\/]/).pop() : null;
        if (target) window.__lens.preview(target);
        await new Promise((r) => setTimeout(r, 900));
        out.previewOpen = !document.getElementById('preview').hidden;
        out.previewKind = document.querySelector('.preview__text')
          ? 'text'
          : document.querySelector('.preview__img')
            ? 'image'
            : document.querySelector('.preview__pdf')
              ? 'pdf'
              : 'none';
        out.previewChars = document.querySelector('.preview__text')?.textContent.length || 0;
        out.previewText = (document.getElementById('previewBody').textContent || '').slice(0, 80);
        document.getElementById('previewClose').click();
        await new Promise((r) => setTimeout(r, 250));
        out.previewClosed = document.getElementById('preview').hidden;

        // 4) Ctrl+A 全选
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
        await new Promise((r) => setTimeout(r, 300));
        out.checked = window.__lens.state.checked.size;
        out.selBar = !document.getElementById('selectionBar').hidden;
        document.querySelector('[data-sel-act="clear"]')?.click();

        console.log('FEATURE ' + JSON.stringify(out));
      })()`,
      /* 端到端：悬浮模式 → 设置弹窗 → 点「窗口」分段 → 回到窗口模式 */
      compact_switch: `(async () => {
        await window.filesorter.setMode('dock');
        await new Promise((r) => setTimeout(r, 800));
        document.getElementById('btnCompactSettings').click();
        await new Promise((r) => setTimeout(r, 600));
        const seg = document.querySelector('[data-segment=\"mode\"] [data-value=\"window\"]');
        if (!seg) {
          console.log('COMPACTSWITCH ' + JSON.stringify({ error: '找不到显示模式分段' }));
          return;
        }
        seg.click();
        await new Promise((r) => setTimeout(r, 1600));
        const app = document.querySelector('.app').getBoundingClientRect();
        console.log('COMPACTSWITCH ' + JSON.stringify({
          mode: document.documentElement.dataset.mode,
          app: [Math.round(app.width), Math.round(app.height)],
          modalOpen: document.querySelector('.modal')?.classList.contains('is-open'),
          overflow: document.querySelector('.main').getBoundingClientRect().right > window.innerWidth + 1,
        }));
      })()`,
      /* 动画中途取证：把时长拉长到 2.4s，截图时正卡在展开的中段 */
      mode_anim: `(async () => {
        document.documentElement.style.setProperty('--mode-dur', '4200ms');
        // 先把 store 和窗口都摆到 dock：--smoke-mode 只改窗口形状，不改 store，
        // 不先同步一次，界面会以为自己在 window 模式，点"回到窗口"直接空转。
        await window.filesorter.setMode('dock');
        await new Promise((r) => setTimeout(r, 800));
        document.getElementById('btnCompactExpand').click();
        console.log('MODEANIM ' + JSON.stringify({
          from: document.documentElement.dataset.modeFrom,
          to: document.documentElement.dataset.modeTo,
        }));
      })()`,
      /* 回归：从悬浮模式一键回窗口模式（走预备动作 + 入场动画那条路） */
      compact_back: `(async () => {
        await window.filesorter.setMode('dock');
        await new Promise((r) => setTimeout(r, 700));
        document.getElementById('btnCompactExpand').click();
        await new Promise((r) => setTimeout(r, 1200));
        const r = document.querySelector('.app').getBoundingClientRect();
        const read = () => ({
          mode: document.documentElement.dataset.mode,
          cls: document.documentElement.className,
          anim: getComputedStyle(document.querySelector('.app')).animationName,
        });
        console.log('COMPACTBACK ' + JSON.stringify({
          mode: document.documentElement.dataset.mode,
          app: [Math.round(r.width), Math.round(r.height)],
          enterCls: document.documentElement.classList.contains('mode-enter'),
          at1200: read(),
        }));
        await new Promise((res) => setTimeout(res, 600));
        console.log('COMPACTBACK2 ' + JSON.stringify(read()));
      })()`,
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
    /**
     * 截图前把所有 CSS 动画/过渡直接推到终点。
     *
     * 冒烟窗口是 showInactive 的，被别的窗口遮住时合成器会降频，动画可能停在
     * 前几帧；拍出来的文字是半透明的（踩过：整屏字发灰，还以为是配色问题）。
     * finish() 是同步的，不依赖下一帧。
     */
    await win.webContents
      .executeJavaScript('document.getAnimations().forEach((a) => { try { a.finish(); } catch (e) {} })')
      .catch(() => {});
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

  /**
   * 实时透桌面：渲染进程要一条桌面流。
   *
   * 只在「实时」档放行，其他档直接拒绝 —— 不要给应用留一个"随时能录屏"的默认能力。
   * 选源按主窗口所在的那块屏认领，多显示器下不会抓错屏。
   */
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      if (store.get().glassBase !== 'live') return callback({});
      const bounds = mainWindow && !mainWindow.isDestroyed()
        ? mainWindow.getBounds()
        : screen.getPrimaryDisplay().bounds;
      const display = screen.getDisplayMatching(bounds);
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
      });
      const source =
        sources.find((item) => String(item.display_id) === String(display.id)) || sources[0];
      if (!source) return callback({});
      callback({ video: source });
    } catch {
      callback({});
    }
  });

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
    backdrop: (rects) => backdropSummary(rects),
    recaptureBackdrop: () => captureDesktopMap(),
    pluginsDir: pluginsDir(),
    runScheduledTidy,
    notify,
    cloudDirs,
  });

  /**
   * 先采桌面、再开窗：此刻窗口还不存在，截到的是一张干净的壁纸，
   * 不会把我们自己的玻璃算进平均值（上一版就栽在这上面）。
   */
  /**
   * 开机自启：设置里打开过就同步一次系统登录项。
   * 放在开窗前，避免用户看到窗口闪一下才被收进托盘。
   */
  if (store.get().autostart) {
    app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
  }

  await captureDesktopMap();
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
