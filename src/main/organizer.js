'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

/** 学习模式的关键词：作业/笔记类文件几乎都会带其中一个 */
const LEARN_PATTERN = /(笔记|作业|考试|课件|复习|习题|论文|实验报告|提纲|重点|真题)/;
const scanner = require('./scanner');
const { classify, resolveCategories, sanitizeFolderName, isHidden, isTempName } = require('./classifier');
const { compileRules, matchRules, resolveTargetFolder } = require('./rules');
const { compileExcludes, checkExclude, isCloudDirName } = require('./exclude');
const { moveFile, isLocked, uniqueName } = require('./fsutil');

/**
 * 整理引擎。
 *
 * 求值顺序（每个文件走一遍）：
 *   系统文件 → 用户排除名单 → 隐藏文件 → 下载中临时文件
 *   → 自定义规则（第一条命中即用） → 扩展名分类 → 兜底「其他」
 *
 * `buildPlan` 是**纯只读**的，预览和执行共用同一份实现，
 * 这样预览看到的就是真正会发生的，不会出现「预览一套、执行一套」。
 */

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
    return new Set(names.map((name) => name.toLowerCase()));
  } catch {
    return new Set();
  }
}

/** 判断当前目录是否位于云盘同步目录内，用于给用户一个提醒 */
function cloudHintFor(dir) {
  const segments = String(dir || '').split(/[\\/]+/).filter(Boolean);
  for (const segment of segments) {
    if (isCloudDirName(segment)) return segment;
  }
  return null;
}

/**
 * 构建整理计划。**不产生任何写入**。
 *
 * @param {string} dir
 * @param {object} settings
 * @param {{pluginFolders?:Map<string,string>}} [options]
 *        pluginFolders：文件名 → 插件给出的目标文件夹（已由 plugins.js 算好）
 */
async function buildPlan(dir, settings, options = {}) {
  const names = folderNames(settings);
  const categories = resolveCategories(settings.customNames);
  const categoryNameById = new Map(categories.map((cat) => [cat.id, cat.name]));
  const compiledRules = compileRules(settings.customRules);
  const compiledExcludes = compileExcludes(settings.excludes);
  const pluginFolders = options.pluginFolders || null;

  const top = await scanner.listTopFiles(dir);
  const takenCache = new Map();

  const items = [];
  const skipped = [];

  for (const file of top) {
    const fileMeta = {
      name: file.name,
      ext: file.ext,
      size: file.size,
      mtime: file.mtime,
      ctime: file.ctime || file.mtime,
    };

    // 1. 系统文件与排除名单 —— 这是用户「不敢用」的根源，必须最先拦
    const excluded = checkExclude({ name: file.name, fullPath: file.path }, compiledExcludes);
    if (excluded.excluded) {
      skipped.push({ name: file.name, reason: excluded.reason, guard: true });
      continue;
    }

    // 2. 隐藏文件与未完成的下载
    if (settings.skipHidden !== false && isHidden(file.name)) {
      skipped.push({ name: file.name, reason: '隐藏文件' });
      continue;
    }
    if (isTempName(file.name)) {
      skipped.push({ name: file.name, reason: '下载中或临时文件' });
      continue;
    }

    // 3. 自定义规则优先于扩展名分类
    const category = classify(file.name);
    fileMeta.categoryName = category.name;

    let folder = null;
    let reason = '';
    let ruleName = '';

    const hit = matchRules(compiledRules, fileMeta);
    /**
     * 学习模式：文件名里带这些词的，先归到「学习」，再按扩展名走。
     * 放在自定义规则之后、扩展名分类之前 —— 用户自己写的规则永远优先。
     */
    const learnHit = settings.learnMode && LEARN_PATTERN.test(file.name);
    if (hit) {
      folder = resolveTargetFolder(hit.target, fileMeta);
      ruleName = hit.rule.name || hit.target;
      reason = `规则「${ruleName}」`;
    } else if (learnHit) {
      folder = '学习';
      ruleName = '学习模式';
      reason = '学习模式：文件名命中课程关键词';
    } else if (pluginFolders && pluginFolders.has(file.name)) {
      folder = sanitizeFolderName(pluginFolders.get(file.name), '');
      reason = '插件规则';
      ruleName = '插件';
    } else {
      folder = names.get(category.id) || names.get('other');
      reason = `类型：${categoryNameById.get(category.id) || category.name}`;
    }

    if (!folder) {
      skipped.push({ name: file.name, reason: '无法确定目标文件夹' });
      continue;
    }

    const folderPath = path.join(dir, folder);
    if (!takenCache.has(folder)) takenCache.set(folder, await takenNames(folderPath));
    const taken = takenCache.get(folder);
    const destName = uniqueName(file.name, taken);

    items.push({
      name: file.name,
      src: file.path,
      dest: path.join(folderPath, destName),
      destName,
      folder,
      categoryId: category.id,
      categoryName: folder,
      size: file.size,
      mtime: file.mtime,
      ctime: file.ctime || file.mtime,
      ext: file.ext,
      conflict: destName !== file.name,
      reason,
      ruleName,
    });
  }

  // 按目标文件夹聚合，预览面板直接按这个分组展示
  const byFolder = new Map();
  for (const item of items) {
    const bucket = byFolder.get(item.folder) || { folder: item.folder, count: 0, size: 0, reason: item.reason };
    bucket.count += 1;
    bucket.size += item.size;
    byFolder.set(item.folder, bucket);
  }

  return {
    dir,
    items,
    skipped,
    cloudHint: cloudHintFor(dir),
    summary: {
      moveCount: items.length,
      totalSize: items.reduce((sum, item) => sum + item.size, 0),
      skippedCount: skipped.length,
      byFolder: [...byFolder.values()].sort((a, b) => b.count - a.count),
      byCategory: [...byFolder.values()].sort((a, b) => b.count - a.count),
    },
  };
}

/**
 * 按目标文件夹分组执行：同一目录下的多次 rename 连续做，机械硬盘上寻道更少。
 * @param {Array} items
 */
function groupByFolder(items) {
  const groups = new Map();
  for (const item of items) {
    const list = groups.get(item.folder) || [];
    list.push(item);
    groups.set(item.folder, list);
  }
  return [...groups.values()];
}

/**
 * 执行整理。
 *
 * @param {string} dir
 * @param {object} settings
 * @param {{
 *   undo?:{startLog:Function,record:Function},
 *   selectedNames?:string[],
 *   onProgress?:Function,
 *   action?:string,
 *   pluginFolders?:Map<string,string>
 * }} options
 *        selectedNames 只接受**直属子项的文件名**（不含分隔符），
 *        主进程会重新校验，渲染层无法借此传入任意路径。
 */
async function executePlan(dir, settings, options = {}) {
  const { undo = null, selectedNames = null, onProgress = null, action = 'organize' } = options;
  const plan = await buildPlan(dir, settings, { pluginFolders: options.pluginFolders });

  let queue = plan.items;
  if (Array.isArray(selectedNames)) {
    const allow = new Set(
      selectedNames.filter((name) => typeof name === 'string' && !name.includes('/') && !name.includes('\\')),
    );
    queue = plan.items.filter((item) => allow.has(item.name));
  }

  const logFile = undo
    ? await undo.startLog(dir, { action, note: `${path.basename(dir) || dir} · ${queue.length} 个文件` })
    : null;

  const moved = [];
  const failed = [];
  let done = 0;

  for (const group of groupByFolder(queue)) {
    for (const item of group) {
      done += 1;
      try {
        // 文件可能在预览之后被别的程序打开
        if (await isLocked(item.src)) throw new Error('文件被其他程序占用');

        // 从预览到落地之间可能有新增文件，落地前重新判一次重名
        const folderPath = path.join(dir, item.folder);
        const taken = await takenNames(folderPath);
        const finalName = taken.has(item.destName.toLowerCase())
          ? uniqueName(item.name, taken)
          : item.destName;
        const dest = path.join(folderPath, finalName);

        await moveFile(item.src, dest);
        if (undo && logFile) await undo.record(logFile, item.src, dest);
        moved.push({ ...item, dest, destName: finalName });
      } catch (err) {
        failed.push({ name: item.name, reason: err.message });
      }

      if (typeof onProgress === 'function') {
        onProgress({ index: done, total: queue.length, name: item.name });
      }
    }
  }

  if (undo) undo.prune().catch(() => {});
  return { dir, moved, failed, logFile, total: queue.length };
}

module.exports = { buildPlan, executePlan, folderNames, groupByFolder, cloudHintFor };
