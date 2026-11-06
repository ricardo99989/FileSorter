'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { classify, extOf, isHidden, isTempName } = require('./classifier');

const MAX_DEPTH = 8;
const MAX_FILES = 50000;
const STAT_BATCH = 200;

/** 分批 stat，避免一次性创建几万个 Promise */
async function statBatch(paths) {
  const out = [];
  for (let i = 0; i < paths.length; i += STAT_BATCH) {
    const slice = paths.slice(i, i + STAT_BATCH);
    const rows = await Promise.all(
      slice.map(async (full) => {
        try {
          const s = await fs.stat(full);
          // birthtimeMs 在部分文件系统上等于 mtime，这里如实返回，不做假数据
          return { path: full, size: s.size, mtime: s.mtimeMs, ctime: s.birthtimeMs || s.mtimeMs };
        } catch {
          return null;
        }
      }),
    );
    for (const row of rows) if (row) out.push(row);
  }
  return out;
}

/**
 * 递归收集文件路径。跳过符号链接（防止目录环），限制深度与总量。
 * @param {string} root
 */
/**
 * 递归时直接跳过的目录。
 * 这些目录要么是成千上万个构建产物，要么是系统回收站，
 * 搜"我的文件"时它们只会拖慢速度、增加噪声。
 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.next', '.nuxt', '.cache',
  'dist', 'build', 'release', 'target', 'vendor',
  '$RECYCLE.BIN', 'System Volume Information', '.vscode', '.idea',
]);

async function collectPaths(root, { maxDepth = MAX_DEPTH, maxFiles = MAX_FILES } = {}) {
  const paths = [];
  const stack = [{ dir: root, depth: 0 }];
  let truncated = false;

  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 无权限的目录直接跳过，不打断整体扫描
    }
    for (const entry of entries) {
      if (paths.length >= maxFiles) {
        truncated = true;
        break;
      }
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(entry.name)) {
          stack.push({ dir: full, depth: depth + 1 });
        }
      } else if (entry.isFile()) {
        paths.push(full);
      }
    }
    if (truncated) break;
  }
  return { paths, truncated };
}

/**
 * 只取根目录下的直属文件（整理动作的作用域）。
 * @param {string} dir
 */
async function listTopFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && !e.isSymbolicLink()).map((e) => path.join(dir, e.name));
  const stats = await statBatch(files);
  return stats.map((row) => ({
    name: path.basename(row.path),
    path: row.path,
    size: row.size,
    mtime: row.mtime,
    ctime: row.ctime,
    ext: extOf(row.path),
  }));
}

/**
 * 目录概览：总数、占用、待归类、各分类分布。
 * @param {string} dir
 * @param {{skipHidden:boolean}} settings
 * @param {Array<{id:string,name:string}>} categories
 */
async function buildStats(dir, settings, categories) {
  const { paths, truncated } = await collectPaths(dir);
  const rows = await statBatch(paths);

  const categoryFolders = new Set(categories.map((c) => c.name.toLowerCase()));
  const byCategory = new Map(categories.map((c) => [c.id, { id: c.id, name: c.name, count: 0, size: 0 }]));

  let total = 0;
  let size = 0;
  let pending = 0;
  let organized = 0;
  let pendingSize = 0;

  for (const row of rows) {
    const name = path.basename(row.path);
    if (isHidden(name)) continue;
    total += 1;
    size += row.size;

    const rel = path.relative(dir, row.path).replace(/\\/g, '/');
    const topSegment = rel.includes('/') ? rel.split('/')[0].toLowerCase() : null;

    const cat = classify(name);
    const bucket = byCategory.get(cat.id);
    if (bucket) {
      bucket.count += 1;
      bucket.size += row.size;
    }

    if (topSegment === null) {
      if (!isTempName(name)) {
        pending += 1;
        pendingSize += row.size;
      }
    } else if (categoryFolders.has(topSegment)) {
      organized += 1;
    }
  }

  return {
    dir,
    total,
    size,
    pending,
    pendingSize,
    organized,
    truncated,
    byCategory: [...byCategory.values()],
  };
}

/**
 * 递归列出全部文件（含 stat），搜索索引用。
 * @param {string} dir
 */
async function listAll(dir, options) {
  const { paths, truncated } = await collectPaths(dir, options);
  const rows = await statBatch(paths);
  return { rows, truncated };
}

module.exports = { collectPaths, listTopFiles, listAll, buildStats, statBatch, MAX_FILES };
