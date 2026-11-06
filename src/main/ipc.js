'use strict';

const path = require('node:path');
const { screen } = require('electron');
const fsp = require('node:fs/promises');
const scanner = require('./scanner');
const organizer = require('./organizer');
const searcher = require('./search');
const fsops = require('./fsops');
const dupes = require('./dupes');
const space = require('./space');
const batch = require('./batch');
const cloud = require('./cloud');
const plugins = require('./plugins');
const previewer = require('./preview');
const ruleEngine = require('./rules');
const { DEFAULT_EXCLUDES } = require('./exclude');
const { detailOf, summarize } = require('./describe');
const { resolveCategories, classify, extOf } = require('./classifier');

/**
 * IPC 注册。
 *
 * 约定：
 * - 通道名就是白名单，没注册的调不通；
 * - 所有路径参数都过 `assertPath`，渲染层造不出相对路径；
 * - 返回值统一 `{ ok, data }` / `{ ok:false, error, code }` 信封，
 *   渲染层只需要看 ok，不用 try/catch 每个调用。
 */

/** 传入路径必须是绝对路径字符串 */
function assertDir(input) {
  return fsops.assertPath(input, '目录');
}

function assertTarget(input, label = '文件路径') {
  return fsops.assertPath(input, label);
}

/** 统一的返回值信封 */
const wrap = (handler) => async (event, payload) => {
  try {
    return { ok: true, data: await handler(payload || {}, event) };
  } catch (err) {
    console.error('[ipc]', err);
    return { ok: false, error: err.message || String(err), code: err.code || null };
  }
};

/**
 * @param {object} ctx
 */
function registerIpc(ctx) {
  const {
    ipcMain, dialog, shell, clipboard, app, store, undo, tags, watcher,
    getWindow, setMode, backdrop, recaptureBackdrop, pluginsDir, runScheduledTidy, scheduler, notify,
  } = ctx;

  /** 拿到当前窗口的发送器，窗口没了就静默丢弃 */
  const senderOf = (event) => (event && event.sender && !event.sender.isDestroyed() ? event.sender : null);
  const push = (event, channel, payload) => {
    const sender = senderOf(event);
    if (sender) sender.send(channel, payload);
  };

  /* --------------------------- 设置 --------------------------- */

  ipcMain.handle(
    'settings:get',
    wrap(async () => {
      const settings = store.get();
      return {
        settings,
        categories: resolveCategories(settings.customNames),
        defaultExcludes: DEFAULT_EXCLUDES,
        rules: settings.customRules.map((rule) => ({ ...rule, description: ruleEngine.describeRule(rule) })),
        ruleMeta: {
          fields: ruleEngine.FIELD_LABELS,
          ops: ruleEngine.OP_LABELS,
        },
      };
    }),
  );

  ipcMain.handle(
    'settings:save',
    wrap(async (payload) => {
      const saved = await store.save(payload || {});
      // 设置变了，定时器要跟着重排
      if (scheduler) scheduler.arm();
      return {
        settings: saved,
        categories: resolveCategories(saved.customNames),
        rules: saved.customRules.map((rule) => ({ ...rule, description: ruleEngine.describeRule(rule) })),
      };
    }),
  );

  ipcMain.handle(
    'dialog:pick',
    wrap(async (payload) => {
      const result = await dialog.showOpenDialog({
        title: payload.title || '选择文件夹',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: payload.defaultPath || store.get().lastFolder || app.getPath('downloads'),
      });
      if (result.canceled || !result.filePaths.length) return { path: null };
      return { path: result.filePaths[0] };
    }),
  );

  /* --------------------------- 浏览 --------------------------- */

  ipcMain.handle(
    'browser:list',
    wrap(async (payload) => {
      const dir = assertDir(payload.dir);
      const listing = await fsops.listDir(dir, {
        showHidden: Boolean(payload.showHidden),
        refresh: Boolean(payload.refresh),
      });
      await store.save({ lastFolder: dir });

      // 标签挂在最外层（不能挂到缓存对象上，否则会被复用成旧数据）
      const tagMap = tags ? tags.tagsOfMany(listing.entries.map((entry) => entry.path)) : {};
      const cloudHit = (ctx.cloudDirs || []).find((item) => {
        const root = item.dir.replace(/\//g, '\\').toLowerCase();
        const current = dir.replace(/\//g, '\\').toLowerCase();
        return current === root || current.startsWith(`${root}\\`);
      });

      // 顺便把「哪些条目会被排除名单拦住」标出来，预览和执行都用得上
      return {
        ...listing,
        tags: tagMap,
        cloud: cloudHit || null,
        watching: watcher ? watcher.status() : null,
      };
    }),
  );

  ipcMain.handle(
    'browser:places',
    wrap(async () => {
      const [places, drives, clouds] = await Promise.all([
        fsops.quickPlaces(),
        fsops.listDrives(),
        cloud.detect({ home: app.getPath('home') }),
      ]);
      return { places, drives, clouds, home: app.getPath('home') };
    }),
  );

  ipcMain.handle(
    'browser:describe',
    wrap(async (payload) => {
      const target = assertTarget(payload.path);
      const stat = await fsops.statPath(target);
      const detail = detailOf({ ...stat, name: path.basename(target) });
      const tagged = tags ? tags.tagsOf(target) : [];
      return { ...stat, ...detail, tags: tagged };
    }),
  );

  ipcMain.handle(
    'browser:preview',
    wrap(async (payload) => {
      const target = assertTarget(payload.path);
      return previewer.preview(target);
    }),
  );

  /** 兼容 2.0 的通道名 */
  ipcMain.handle(
    'browser:peek',
    wrap(async (payload) => {
      const target = assertTarget(payload.path);
      const result = await previewer.preview(target);
      if (result.kind === 'text') return { text: result.text, truncated: result.truncated, kind: 'text' };
      if (result.kind === 'none') return { skip: true, kind: 'none', reason: result.reason };
      return { skip: true, kind: result.kind };
    }),
  );

  ipcMain.handle(
    'browser:open',
    wrap(async (payload) => {
      const target = assertTarget(payload.path);
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
      return true;
    }),
  );

  ipcMain.handle(
    'browser:reveal',
    wrap(async (payload) => {
      shell.showItemInFolder(assertTarget(payload.path));
      return true;
    }),
  );

  ipcMain.handle(
    'browser:copyPath',
    wrap(async (payload) => {
      const target = assertTarget(payload.path);
      clipboard.writeText(target);
      return target;
    }),
  );

  /** 打开外部链接（关于页里的仓库地址） */
  ipcMain.handle(
    'shell:openExternal',
    wrap(async (payload) => {
      const url = String(payload.url || '');
      if (!/^https?:\/\//i.test(url)) throw new Error('只允许打开 http/https 链接');
      await shell.openExternal(url);
      return true;
    }),
  );

  /* --------------------------- 监听 --------------------------- */

  ipcMain.handle(
    'watch:set',
    wrap(async (payload) => {
      if (!watcher) return { active: false };
      if (!payload.dir) {
        await watcher.unwatch();
        return watcher.status();
      }
      const dir = assertDir(payload.dir);
      if (payload.enabled === false) {
        await watcher.unwatch();
      } else {
        await watcher.watch(dir);
      }
      return watcher.status();
    }),
  );

  /* --------------------------- 历史 · 撤销 · 重做 --------------------------- */

  ipcMain.handle(
    'organizer:history',
    wrap(async (payload) => {
      const items = await undo.listBatches(Number(payload.limit) || 40);
      return { items };
    }),
  );

  ipcMain.handle(
    'organizer:undo',
    wrap(async (payload) => {
      const result = payload.file
        ? await undo.undoBatch(assertTarget(payload.file, '日志路径'))
        : await undo.undoLast(Number(payload.count) || 1);
      await afterMove(result);
      return result;
    }),
  );

  ipcMain.handle(
    'organizer:redo',
    wrap(async (payload) => {
      const result = payload.file
        ? await undo.redoBatch(assertTarget(payload.file, '日志路径'))
        : await undo.redoLast();
      await afterMove(result);
      return result;
    }),
  );

  ipcMain.handle(
    'organizer:clearHistory',
    wrap(async () => undo.clearHistory()),
  );

  /** 移动之后统一做的收尾：清缓存、同步标签路径 */
  async function afterMove(result) {
    const pairs = result?.pairs || [];
    if (tags) {
      for (const pair of pairs) {
        await tags.remapPath(pair.from, pair.to);
      }
    }
    fsops.invalidate();
  }

  /* --------------------------- 整理 --------------------------- */

  /** 收集插件给的归类建议（只为启用中的插件计算） */
  async function pluginFolders(dir, settings) {
    if (!pluginsDir || !settings.plugins?.length) return null;
    const enabled = await plugins.loadEnabled(pluginsDir, settings.plugins);
    if (!enabled.length) return null;
    const top = await scanner.listTopFiles(dir);
    const files = top.map((file) => ({
      name: file.name,
      ext: file.ext,
      size: file.size,
      mtime: file.mtime,
      ctime: file.ctime,
      ageDays: Math.floor((Date.now() - file.mtime) / 86400000),
    }));
    return plugins.applyPlugins(enabled, files);
  }

  ipcMain.handle(
    'organizer:preview',
    wrap(async (payload) => {
      const dir = assertDir(payload.dir);
      const settings = store.get();
      const folders = await pluginFolders(dir, settings);
      const plan = await organizer.buildPlan(dir, settings, { pluginFolders: folders || undefined });
      return {
        dir,
        items: plan.items.map((item) => ({
          name: item.name,
          path: item.src,
          destName: item.destName,
          folder: item.folder,
          categoryId: item.categoryId,
          size: item.size,
          mtime: item.mtime,
          conflict: item.conflict,
          reason: item.reason,
          ruleName: item.ruleName,
        })),
        skipped: plan.skipped,
        cloudHint: plan.cloudHint,
        summary: plan.summary,
      };
    }),
  );

  ipcMain.handle(
    'organizer:execute',
    wrap(async (payload, event) => {
      const dir = assertDir(payload.dir);
      const settings = store.get();
      const folders = await pluginFolders(dir, settings);
      const result = await organizer.executePlan(dir, settings, {
        undo,
        selectedNames: Array.isArray(payload.selectedNames) ? payload.selectedNames : null,
        pluginFolders: folders || undefined,
        onProgress: (progress) => push(event, 'organizer:progress', progress),
      });
      fsops.invalidate(dir);
      // 文件挪了位置，标签要跟着走，否则用户会发现标签"丢了"
      for (const item of result.moved) {
        await tags?.remapPath(item.src, item.dest);
      }
      return {
        moved: result.moved.length,
        total: result.total,
        failed: result.failed,
        logFile: result.logFile,
      };
    }),
  );

  /* --------------------------- 搜索 --------------------------- */

  ipcMain.handle(
    'search:query',
    wrap(async (payload) => {
      const dir = assertDir(payload.dir);
      const result = await searcher.search(dir, payload.keyword || '', { limit: 200, similarCount: 5 });
      for (const item of result.hits) {
        if (!item.desc) item.desc = summarize(item);
      }
      for (const item of result.similar) {
        if (!item.desc) item.desc = summarize(item);
      }
      if (tags) {
        const map = tags.tagsOfMany([...result.hits, ...result.similar].map((item) => item.path));
        result.tags = map;
      }
      return result;
    }),
  );

  ipcMain.handle(
    'search:byTags',
    wrap(async (payload) => {
      const dir = assertDir(payload.dir);
      const tagIds = Array.isArray(payload.tagIds) ? payload.tagIds : [];
      if (!tagIds.length) return { hits: [], keyword: '' };
      const hits = await tags.search(dir, tagIds, { matchAll: payload.matchAll !== false });
      for (const item of hits) {
        if (!item.desc) item.desc = summarize(item);
      }
      return { hits, keyword: payload.tagIds.join(',') };
    }),
  );

  /* --------------------------- 重复文件 --------------------------- */

  ipcMain.handle(
    'dupes:scan',
    wrap(async (payload, event) => {
      const dir = assertDir(payload.dir);
      const result = await dupes.findDuplicates(dir, {
        minSize: Number(payload.minSize) || store.get().dupesMinSize,
        onProgress: (progress) => push(event, 'dupes:progress', progress),
      });
      return result;
    }),
  );

  ipcMain.handle(
    'dupes:trash',
    wrap(async (payload) => {
      const targets = (Array.isArray(payload.paths) ? payload.paths : []).map((item) => assertTarget(item));
      // 只允许删文件，不允许删目录；走系统回收站，用户还能捞回来
      const files = [];
      for (const target of targets) {
        const stat = await fsp.stat(target).catch(() => null);
        if (stat?.isFile()) files.push(target);
      }
      const result = await dupes.trashPaths(files, (target) => shell.trashItem(target));
      fsops.invalidate();
      return result;
    }),
  );

  /* --------------------------- 删除 / 移动 --------------------------- */

  /**
   * 批量删除：走系统回收站，不真删。
   * 目录也允许（整理下载文件夹时经常要整个删掉旧文件夹），但会先确认它不在系统盘关键位置。
   */
  ipcMain.handle(
    'fs:trash',
    wrap(async (payload) => {
      const targets = (Array.isArray(payload.paths) ? payload.paths : [])
        .map((item) => assertTarget(item))
        .slice(0, 500);
      const done = [];
      const failed = [];
      for (const target of targets) {
        try {
          await shell.trashItem(target);
          done.push(target);
        } catch (err) {
          failed.push({ path: target, error: err.message || String(err) });
        }
      }
      fsops.invalidate();
      return { done, failed };
    }),
  );

  /**
   * 批量移动到目标文件夹。
   * 重名不覆盖：自动加 " (2)" 后缀，宁可留两个也不悄悄盖掉用户的东西。
   */
  ipcMain.handle(
    'fs:moveTo',
    wrap(async (payload) => {
      const dest = assertDir(payload.dest);
      const targets = (Array.isArray(payload.paths) ? payload.paths : [])
        .map((item) => assertTarget(item))
        .slice(0, 500);

      let destStat = await fsp.stat(dest).catch(() => null);
      // create=true：拖拽归类到"还不存在的分类文件夹"时自动建一个
      if (!destStat && payload.create) {
        await fsp.mkdir(dest, { recursive: true });
        destStat = await fsp.stat(dest).catch(() => null);
      }
      if (!destStat?.isDirectory()) throw new Error('目标不是文件夹');

      const freeName = async (dir, name) => {
        const ext = path.extname(name);
        const stem = path.basename(name, ext);
        let candidate = name;
        let index = 2;
        // 最多试 999 次，避免异常情况下死循环
        while (index < 1000) {
          const taken = await fsp
            .lstat(path.join(dir, candidate))
            .then(() => true)
            .catch(() => false);
          if (!taken) return candidate;
          candidate = `${stem} (${index})${ext}`;
          index += 1;
        }
        throw new Error(`目标文件夹里同名文件太多：${name}`);
      };

      const done = [];
      const failed = [];
      for (const source of targets) {
        try {
          // 移到自己所在的目录等于没动，直接跳过
          if (path.dirname(source).toLowerCase() === dest.toLowerCase()) continue;
          const name = await freeName(dest, path.basename(source));
          await fsp.rename(source, path.join(dest, name));
          done.push({ from: source, to: path.join(dest, name) });
        } catch (err) {
          failed.push({ path: source, error: err.message || String(err) });
        }
      }
      fsops.invalidate();
      return { done, failed, dest };
    }),
  );

  /* --------------------------- 开机自启 --------------------------- */

  ipcMain.handle(
    'app:autostart',
    wrap(async (payload) => {
      if (typeof payload.enabled === 'boolean') {
        app.setLoginItemSettings({
          openAtLogin: payload.enabled,
          // 启动时不弹窗，直接进托盘；用户点托盘再展开
          args: ['--hidden'],
        });
        await store.save({ autostart: payload.enabled });
      }
      return { enabled: app.getLoginItemSettings().openAtLogin };
    }),
  );

  /* --------------------------- 空间分析 --------------------------- */

  ipcMain.handle(
    'space:analyze',
    wrap(async (payload, event) => {
      const dir = assertDir(payload.dir);
      return space.analyze(dir, {
        onProgress: (progress) => push(event, 'space:progress', progress),
      });
    }),
  );

  /* --------------------------- 批量重命名 / 打包 --------------------------- */

  ipcMain.handle(
    'batch:preview',
    wrap(async (payload) => {
      const dir = assertDir(payload.dir);
      const names = (Array.isArray(payload.names) ? payload.names : []).filter(
        (name) => typeof name === 'string' && name && !name.includes('/') && !name.includes('\\'),
      );
      return batch.renamePlan(dir, names, {
        template: payload.template,
        start: payload.start,
        find: payload.find,
        replace: payload.replace,
      });
    }),
  );

  ipcMain.handle(
    'batch:rename',
    wrap(async (payload) => {
      const dir = assertDir(payload.dir);
      const names = (Array.isArray(payload.names) ? payload.names : []).filter(
        (name) => typeof name === 'string' && name && !name.includes('/') && !name.includes('\\'),
      );
      const plan = await batch.renamePlan(dir, names, {
        template: payload.template,
        start: payload.start,
        find: payload.find,
        replace: payload.replace,
      });
      const result = await batch.executeRename(dir, plan.items, { undo });
      for (const item of plan.items) {
        if (item.to && item.to !== item.from && !item.skipped) {
          await tags?.remapPath(path.join(dir, item.from), path.join(dir, item.to));
        }
      }
      fsops.invalidate(dir);
      return { ...result, plan };
    }),
  );

  ipcMain.handle(
    'batch:archive',
    wrap(async (payload, event) => {
      const dir = assertDir(payload.dir);
      const names = (Array.isArray(payload.names) ? payload.names : []).filter(
        (name) => typeof name === 'string' && name && !name.includes('/') && !name.includes('\\'),
      );
      if (!names.length) throw new Error('没有选中文件');
      const targets = names.map((name) => path.join(dir, name));
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const outBase = path.join(dir, String(payload.outName || `归档_${stamp}`).replace(/[<>:"/\\|?*]/g, ''));
      const result = await batch.archive(targets, outBase, {
        password: payload.password || '',
        onProgress: (progress) => push(event, 'batch:progress', progress),
      });
      fsops.invalidate(dir);
      return result;
    }),
  );

  ipcMain.handle(
    'batch:decrypt',
    wrap(async (payload) => {
      const source = assertTarget(payload.path);
      if (!source.toLowerCase().endsWith('.fsenc')) throw new Error('只支持 .fsenc 文件');
      const outPath = source.replace(/\.fsenc$/i, payload.stripZip === false ? '.out' : '');
      return batch.decryptFile(source, outPath || `${source}.out`, payload.password || '');
    }),
  );

  /* --------------------------- 标签 --------------------------- */

  ipcMain.handle('tags:list', wrap(async () => ({ tags: tags.list() })));

  ipcMain.handle(
    'tags:create',
    wrap(async (payload) => {
      const tag = await tags.createTag(payload.name, payload.color);
      return { tag, tags: tags.list() };
    }),
  );

  ipcMain.handle(
    'tags:update',
    wrap(async (payload) => {
      const tag = await tags.updateTag(payload.id, { name: payload.name, color: payload.color });
      return { tag, tags: tags.list() };
    }),
  );

  ipcMain.handle(
    'tags:delete',
    wrap(async (payload) => {
      await tags.deleteTag(payload.id);
      return { tags: tags.list() };
    }),
  );

  ipcMain.handle(
    'tags:add',
    wrap(async (payload) => {
      const targets = (Array.isArray(payload.paths) ? payload.paths : []).map((item) => assertTarget(item));
      const count = await tags.addTags(targets, payload.tagIds);
      return { count, tags: tags.list(), map: tags.tagsOfMany(targets) };
    }),
  );

  ipcMain.handle(
    'tags:set',
    wrap(async (payload) => {
      const target = assertTarget(payload.path);
      const ids = await tags.setTags(target, payload.tagIds);
      return { tagIds: ids, tags: tags.tagsOf(target) };
    }),
  );

  ipcMain.handle(
    'tags:remove',
    wrap(async (payload) => {
      const targets = (Array.isArray(payload.paths) ? payload.paths : []).map((item) => assertTarget(item));
      await tags.removeTags(targets, payload.tagIds || []);
      return { tags: tags.list(), map: tags.tagsOfMany(targets) };
    }),
  );

  ipcMain.handle('tags:prune', wrap(async () => ({ removed: await tags.prune() })));

  /* --------------------------- 插件 --------------------------- */

  ipcMain.handle(
    'plugins:list',
    wrap(async () => {
      const all = await plugins.scanAll(pluginsDir);
      const settings = store.get();
      return {
        dir: pluginsDir,
        enabled: settings.plugins || [],
        items: all.map((item) => ({
          file: path.basename(item.file),
          name: item.name,
          version: item.version,
          description: item.description,
          ok: item.ok,
          error: item.error,
        })),
      };
    }),
  );

  ipcMain.handle(
    'plugins:save',
    wrap(async (payload) => {
      const saved = await plugins.savePlugin(pluginsDir, payload.file, payload.code);
      return { file: saved };
    }),
  );

  ipcMain.handle(
    'plugins:openDir',
    wrap(async () => {
      await fsp.mkdir(pluginsDir, { recursive: true });
      await shell.openPath(pluginsDir);
      return pluginsDir;
    }),
  );

  /* --------------------------- 定时任务 --------------------------- */

  ipcMain.handle('schedule:status', wrap(async () => scheduler.status()));

  ipcMain.handle(
    'schedule:runNow',
    wrap(async () => {
      if (typeof runScheduledTidy !== 'function') throw new Error('定时模块未就绪');
      return runScheduledTidy(true);
    }),
  );

  /* --------------------------- 云盘 --------------------------- */

  ipcMain.handle(
    'cloud:list',
    wrap(async () => ({ items: await cloud.detect({ home: app.getPath('home') }) })),
  );

  /* --------------------------- 统计与旧接口 --------------------------- */

  ipcMain.handle(
    'fs:stats',
    wrap(async (payload) => {
      const dir = assertDir(payload.dir);
      const settings = store.get();
      const categories = resolveCategories(settings.customNames);
      const stats = await scanner.buildStats(dir, settings, categories);
      return { ...stats, categories };
    }),
  );

  /* --------------------------- 窗口 --------------------------- */

  ipcMain.handle(
    'win:action',
    wrap(async (payload) => {
      const win = getWindow();
      if (!win) return { maximized: false };
      switch (payload.action) {
        case 'minimize':
          win.minimize();
          break;
        case 'maximize':
          if (win.isMaximized()) win.unmaximize();
          else win.maximize();
          break;
        case 'close':
          win.close();
          break;
        default:
          throw new Error('未知的窗口操作');
      }
      return { maximized: win.isMaximized() };
    }),
  );

  ipcMain.handle(
    'win:setMode',
    wrap(async (payload) => {
      if (['window', 'sidebar', 'dock'].includes(payload.mode)) {
        await store.save({ mode: payload.mode });
        setMode?.(payload.mode);
      }
      return { mode: store.get().mode };
    }),
  );

  /**
   * 渲染进程要「我这些面板背后有多亮」：把面板的屏幕矩形传上来，
   * 主进程查 64×36 的亮度表，逐块返回。开窗时已经采过一次，这里不再截图。
   */
  ipcMain.handle(
    'win:backdrop',
    wrap(async (payload) => {
      if (payload?.recapture) await recaptureBackdrop?.();
      const rects = Array.isArray(payload?.rects) ? payload.rects.slice(0, 12) : [];
      return backdrop?.(rects) || { luminance: null, busy: null, panels: [] };
    }),
  );

  /**
   * 切换玻璃底。setBackgroundMaterial 运行时可改，不需要重建窗口；
   * 改完写回 store，下次启动直接按这个值创建。
   */
  ipcMain.handle(
    'win:glassBase',
    wrap(async (payload) => {
      const value = ['clear', 'live'].includes(payload?.value) ? payload.value : 'acrylic';
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        // live 档不要系统材质，模糊由渲染进程自己算；而且必须开内容保护，
        // 否则桌面流会把我们自己的窗口拍进去，形成"画中画无限套娃"
        win.setBackgroundMaterial(value === 'acrylic' ? 'acrylic' : 'none');
        win.setContentProtection(value === 'live');
      }
      await store.save({ glassBase: value });
      return { glassBase: value };
    }),
  );

  /**
   * 窗口所在屏幕的几何信息。
   * 渲染进程拿它把"窗口在屏内的位置"换算成桌面视频里的采样矩形 ——
   * 这是实时背景能做到跟桌面严丝合缝的关键，多屏/缩放都靠这个比值。
   */
  ipcMain.handle(
    'win:geometry',
    wrap(async () => {
      const win = getWindow();
      if (!win || win.isDestroyed()) return { display: null };
      const bounds = win.getBounds();
      const display = screen.getDisplayMatching(bounds);
      return {
        window: bounds,
        display: {
          id: display.id,
          bounds: display.bounds,
          workArea: display.workArea,
          scaleFactor: display.scaleFactor,
        },
      };
    }),
  );

  ipcMain.handle(
    'win:setSide',
    wrap(async (payload) => {      const side = payload.side === 'right' ? 'right' : 'left';
      await store.save({ sidebarSide: side });
      if (store.get().mode === 'sidebar') setMode?.('sidebar');
      return { side };
    }),
  );

  ipcMain.handle(
    'win:notify',
    wrap(async (payload) => {
      notify?.(payload.title || 'FileSorter', String(payload.body || ''));
      return true;
    }),
  );

  ipcMain.handle(
    'app:info',
    wrap(async () => ({
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      platform: process.platform,
      userData: app.getPath('userData'),
      downloads: app.getPath('downloads'),
      desktop: app.getPath('desktop'),
      home: app.getPath('home'),
      pluginsDir,
    })),
  );

  /** 在资源管理器里选中某个目录（设置页"打开数据目录"用） */
  ipcMain.handle(
    'app:revealPath',
    wrap(async (payload) => {
      const target = assertTarget(payload.path);
      shell.showItemInFolder(target);
      return true;
    }),
  );

  /** 供渲染层判断某个扩展名属于哪个分类（批量面板用） */
  ipcMain.handle(
    'app:classify',
    wrap(async (payload) => {
      const names = Array.isArray(payload.names) ? payload.names : [];
      return names.map((name) => ({ name, ext: extOf(name), categoryId: classify(name).id }));
    }),
  );
}

module.exports = { registerIpc };
