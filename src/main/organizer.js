'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const scanner = require('./scanner');
const { classify, resolveCategories, sanitizeFolderName, isHidden, isTempName } = require('./classifier');
const { moveFile, isLocked, uniqueName } = require('./fsutil');

/** 分类 id → 实际使用的文件夹名（已清洗） */
function folderNames(settings) {
  const categories = resolveCategories(settings.customNames);
  const map = new Map();
  for (const cat of categories) {
    map.set(cat.id, sanitizeFolderName(cat.name, cat.defaultName));
  }
  return map;
}

/** 读取目录下已占用的文件名（小写），用于冲突预判 */
async function takenNames(dir) {
  try {
    const names = await fs.readdir(dir);
    return new Set(names.map((n) => n.toLowerCase()));
  } catch {
    return new Set();
  }
}

/**
 * 构建整理计划。**不产生任何写入**，纯只读，供预览与执行共用。
 *
 * @param {string} dir
 * @param {{customNames:Record<string,string>,skipHidden:boolean}} settings
 */
async function buildPlan(dir, settings) {
  const names = folderNames(settings);
  const top = await scanner.listTopFiles(dir);
  const takenCache = new Map();

  const items = [];
  const skipped = [];

  for (const file of top) {
    if (settings.skipHidden !== false && isHidden(file.name)) {
      skipped.push({ name: file.name, reason: '隐藏文件' });
      continue;
    }
    if (isTempName(file.name)) {
      skipped.push({ name: file.name, reason: '下载中或临时文件' });
      continue;
    }

    const cat = classify(file.name);
    const folder = names.get(cat.id) || names.get('other');
    if (!takenCache.has(folder)) takenCache.set(folder, await takenNames(path.join(dir, folder)));
    const taken = takenCache.get(folder);

    const destName = uniqueName(file.name, taken);
    items.push({
      name: file.name,
      src: file.path,
      dest: path.join(dir, folder, destName),
      destName,
      folder,
      categoryId: cat.id,
      categoryName: folder,
      size: file.size,
      mtime: file.mtime,
      conflict: destName !== file.name,
    });
  }

  const byCategory = new Map();
  for (const item of items) {
    const bucket = byCategory.get(item.categoryId) || { id: item.categoryId, name: item.categoryName, count: 0, size: 0 };
    bucket.count += 1;
    bucket.size += item.size;
    byCategory.set(item.categoryId, bucket);
  }

  return {
    dir,
    items,
    skipped,
    summary: {
      moveCount: items.length,
      totalSize: items.reduce((sum, i) => sum + i.size, 0),
      byCategory: [...byCategory.values()].sort((a, b) => b.count - a.count),
    },
  };
}

/**
 * 执行整理。
 *
 * @param {string} dir
 * @param {object} settings
 * @param {{undo?:{startLog:Function,record:Function}, selectedNames?:string[], onProgress?:Function}} options
 *        selectedNames 只接受**直属子项的文件名**，主进程会重新校验，渲染层无法借此传入任意路径。
 */
async function executePlan(dir, settings, options = {}) {
  const { undo = null, selectedNames = null, onProgress = null } = options;
  const plan = await buildPlan(dir, settings);

  let queue = plan.items;
  if (Array.isArray(selectedNames)) {
    const allow = new Set(
      selectedNames.filter((n) => typeof n === 'string' && !n.includes('/') && !n.includes('\\')),
    );
    queue = plan.items.filter((item) => allow.has(item.name));
  }

  const logFile = undo ? await undo.startLog(dir) : null;
  const moved = [];
  const failed = [];

  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index];
    try {
      // 文件可能刚被别的程序打开，移动前再探一次
      if (await isLocked(item.src)) {
        throw new Error('文件被其他程序占用');
      }

      // 预览到现在可能有新增文件，落地前重新判一次重名
      const folderPath = path.join(dir, item.folder);
      const taken = await takenNames(folderPath);
      const finalName = taken.has(item.destName.toLowerCase()) ? uniqueName(item.name, taken) : item.destName;
      const dest = path.join(folderPath, finalName);

      await moveFile(item.src, dest);
      if (undo && logFile) await undo.record(logFile, item.src, dest);
      moved.push({ ...item, dest, destName: finalName });
    } catch (err) {
      failed.push({ name: item.name, reason: err.message });
    }

    if (typeof onProgress === 'function') {
      onProgress({ index: index + 1, total: queue.length, name: item.name });
    }
  }

  return { dir, moved, failed, logFile, total: queue.length };
}

module.exports = { buildPlan, executePlan, folderNames };
