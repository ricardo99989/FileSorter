'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const scanner = require('./scanner');
const { classify, resolveCategories } = require('./classifier');

/**
 * 空间分析。
 *
 * 目标只有一个：让用户一眼看出「硬盘是被什么吃掉的」。
 * 所以除了按类型汇总，还单独给出两类最实用的榜单：
 *   - 最大的 N 个文件（往往就是该删的那几个）
 *   - 最占地方的 N 个子文件夹（定位"重灾区"）
 */

/**
 * @param {string} dir
 * @param {{maxFiles?:number, topN?:number, onProgress?:Function}} [options]
 */
async function analyze(dir, options = {}) {
  const topN = Math.max(5, Math.min(50, Number(options.topN) || 12));
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  if (onProgress) onProgress({ stage: 'scan', message: '正在扫描目录…' });
  const { paths, truncated } = await scanner.collectPaths(dir, {
    maxFiles: Number(options.maxFiles) || scanner.MAX_FILES,
  });

  const categories = resolveCategories({});
  const categoryName = new Map(categories.map((cat) => [cat.id, cat.name]));

  const byCategory = new Map();
  const byFolder = new Map();
  const largest = [];
  let total = 0;
  let count = 0;
  let done = 0;

  for (const full of paths) {
    let stat = null;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    done += 1;
    if (onProgress && done % 200 === 0) {
      onProgress({ stage: 'stat', message: '正在统计体积…', done, total: paths.length });
    }

    total += stat.size;
    count += 1;

    const cat = classify(path.basename(full));
    const bucket = byCategory.get(cat.id) || { id: cat.id, name: categoryName.get(cat.id) || cat.name, size: 0, count: 0 };
    bucket.size += stat.size;
    bucket.count += 1;
    byCategory.set(cat.id, bucket);

    const rel = path.relative(dir, full);
    const top = rel.includes(path.sep) ? rel.split(path.sep)[0] : '（根目录文件）';
    const folder = byFolder.get(top) || { name: top, size: 0, count: 0 };
    folder.size += stat.size;
    folder.count += 1;
    byFolder.set(top, folder);

    largest.push({ path: full, name: path.basename(full), size: stat.size, mtime: stat.mtimeMs });
  }

  largest.sort((a, b) => b.size - a.size);

  const categoryList = [...byCategory.values()].sort((a, b) => b.size - a.size);
  const folderList = [...byFolder.values()].sort((a, b) => b.size - a.size);

  if (onProgress) onProgress({ stage: 'done', message: '统计完成' });

  return {
    dir,
    total,
    count,
    truncated: Boolean(truncated),
    // 饼图直接用这份数据，percent 在渲染层算，主进程只给绝对值
    byCategory: categoryList,
    byFolder: folderList.slice(0, topN),
    largest: largest.slice(0, topN),
    // 「超过 1GB 的文件」这种判断留给渲染层，这里只提供数量最少的必要指标
    bigFileCount: largest.filter((item) => item.size >= 1024 * 1024 * 1024).length,
  };
}

module.exports = { analyze };
