'use strict';

const path = require('node:path');
const scanner = require('./scanner');
const organizer = require('./organizer');
const searcher = require('./search');
const { classify, resolveCategories, extOf } = require('./classifier');

/** 传入路径必须是绝对路径字符串，挡住渲染层构造的相对路径 */
function assertDir(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('缺少目录参数');
  if (!path.isAbsolute(input)) throw new Error('目录必须是绝对路径');
  return path.normalize(input);
}

/** 统一的返回值信封，渲染层只需判断 ok */
const wrap = (handler) => async (event, payload) => {
  try {
    return { ok: true, data: await handler(payload || {}, event) };
  } catch (err) {
    console.error('[ipc]', err);
    return { ok: false, error: err.message || String(err) };
  }
};

/**
 * 注册全部 IPC 通道。通道名即白名单，未注册的调用一律不可用。
 * @param {{ipcMain:any, dialog:any, shell:any, app:any, store:any, undo:any}} ctx
 */
function registerIpc(ctx) {
  const { ipcMain, dialog, shell, app, store, undo } = ctx;

  ipcMain.handle(
    'settings:get',
    wrap(async () => ({
      settings: store.get(),
      categories: resolveCategories(store.get().customNames),
    })),
  );

  ipcMain.handle(
    'settings:save',
    wrap(async (payload) => {
      const saved = await store.save(payload || {});
      return { settings: saved, categories: resolveCategories(saved.customNames) };
    }),
  );

  ipcMain.handle(
    'dialog:pick',
    wrap(async () => {
      const result = await dialog.showOpenDialog({
        title: '选择要整理的文件夹',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: store.get().lastFolder || app.getPath('downloads'),
      });
      if (result.canceled || !result.filePaths.length) return { path: null };
      await store.save({ lastFolder: result.filePaths[0] });
      return { path: result.filePaths[0] };
    }),
  );

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

  ipcMain.handle(
    'fs:list',
    wrap(async (payload) => {
      const dir = assertDir(payload.dir);
      const { rows } = await scanner.listAll(dir);
      const categoryId = payload.categoryId || null;
      const files = rows.map((row) => {
        const name = path.basename(row.path);
        const cat = classify(name);
        return {
          name,
          path: row.path,
          dir: path.dirname(row.path),
          size: row.size,
          mtime: row.mtime,
          ext: extOf(name),
          categoryId: cat.id,
        };
      });
      const filtered = categoryId ? files.filter((f) => f.categoryId === categoryId) : files;
      const sortBy = store.get().sortBy;
      filtered.sort((a, b) => {
        if (sortBy === 'name') return a.name.localeCompare(b.name, 'zh-CN');
        if (sortBy === 'size') return b.size - a.size;
        return b.mtime - a.mtime;
      });
      return { dir, total: filtered.length, files: filtered.slice(0, 500) };
    }),
  );

  ipcMain.handle(
    'organizer:preview',
    wrap(async (payload) => {
      const dir = assertDir(payload.dir);
      const plan = await organizer.buildPlan(dir, store.get());
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
        })),
        skipped: plan.skipped,
        summary: plan.summary,
      };
    }),
  );

  ipcMain.handle(
    'organizer:execute',
    wrap(async (payload, event) => {
      const dir = assertDir(payload.dir);
      const result = await organizer.executePlan(dir, store.get(), {
        undo,
        selectedNames: Array.isArray(payload.selectedNames) ? payload.selectedNames : null,
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send('organizer:progress', progress);
        },
      });
      return {
        moved: result.moved.length,
        total: result.total,
        failed: result.failed,
        logFile: result.logFile,
      };
    }),
  );

  ipcMain.handle('organizer:undo', wrap(async () => undo.undoLast()));

  ipcMain.handle('organizer:history', wrap(async () => ({ items: await undo.history() })));

  ipcMain.handle(
    'search:query',
    wrap(async (payload) => {
      const dir = assertDir(payload.dir);
      return searcher.search(dir, payload.keyword || '', { limit: 120, similarCount: 5 });
    }),
  );

  ipcMain.handle(
    'shell:reveal',
    wrap(async (payload) => {
      const target = payload.path;
      if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('路径无效');
      shell.showItemInFolder(target);
      return true;
    }),
  );

  ipcMain.handle(
    'shell:open',
    wrap(async (payload) => {
      const target = payload.path;
      if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('路径无效');
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
      return true;
    }),
  );

  ipcMain.handle(
    'app:info',
    wrap(async () => ({
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      userData: app.getPath('userData'),
      downloads: app.getPath('downloads'),
      desktop: app.getPath('desktop'),
    })),
  );
}

module.exports = { registerIpc };
