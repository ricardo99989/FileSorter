'use strict';

const fs = require('node:fs/promises');
const fsp = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const scanner = require('./scanner');

/**
 * 重复文件检测。
 *
 * 三阶段，逐级加严，避免一上来就把整个目录的几十 GB 全量哈希：
 *   1. **按体积分组** —— 体积不同的文件不可能是同一份内容，直接排除；
 *   2. **首尾快哈希** —— 只读前 64KB + 后 64KB，秒级筛掉"同名不同内容"；
 *   3. **全量 SHA-256** —— 只对第 2 步仍然撞车的文件流式计算，保证结论准确。
 *
 * 这样在典型目录（大量截图、图片）里，真正需要全量读的通常只有个位数文件。
 */

const CHUNK = 64 * 1024;
/** 同时打开的文件句柄上限，机械硬盘上再高反而更慢 */
const CONCURRENCY = 4;

/** 简单并发池，任务完成一个补一个 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** 读文件首尾各 64KB，拼上体积做一次快哈希 */
async function quickHash(file, size) {
  const handle = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(CHUNK, size));
    await handle.read(head, 0, head.length, 0);
    const tailLength = Math.min(CHUNK, size);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    return crypto.createHash('sha1').update(head).update(tail).update(String(size)).digest('hex');
  } finally {
    await handle.close();
  }
}

/** 流式全量哈希，常驻内存只有一个 64KB 缓冲 */
function fullHash(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsp.createReadStream(file, { highWaterMark: CHUNK });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * 在目录里找出内容完全相同的文件。
 *
 * @param {string} dir
 * @param {{minSize?:number, maxFiles?:number, onProgress?:Function}} [options]
 * @returns {Promise<{groups:Array, scanned:number, hashed:number, totalWasted:number, truncated:boolean}>}
 */
async function findDuplicates(dir, options = {}) {
  const minSize = Math.max(0, Number(options.minSize) || 1024);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const report = (stage, extra = {}) => {
    if (onProgress) onProgress({ stage, ...extra });
  };

  report('scan', { message: '正在列出文件…' });
  const { paths, truncated } = await scanner.collectPaths(dir, {
    maxFiles: Number(options.maxFiles) || scanner.MAX_FILES,
  });

  const rows = [];
  await mapLimit(paths, 32, async (full) => {
    try {
      const stat = await fs.stat(full);
      if (stat.isFile() && stat.size >= minSize) {
        rows.push({ path: full, name: path.basename(full), size: stat.size, mtime: stat.mtimeMs });
      }
    } catch {
      /* 读不到就跳过，不打断整体扫描 */
    }
  });

  // 阶段 1：体积分组
  const bySize = new Map();
  for (const row of rows) {
    const bucket = bySize.get(row.size) || [];
    bucket.push(row);
    bySize.set(row.size, bucket);
  }
  const candidates = [...bySize.values()].filter((bucket) => bucket.length > 1).flat();

  report('quick', { message: '正在比对首尾内容…', total: candidates.length, done: 0 });

  // 阶段 2：首尾快哈希
  const byQuick = new Map();
  let quickDone = 0;
  await mapLimit(candidates, CONCURRENCY, async (row) => {
    try {
      const key = `${row.size}:${await quickHash(row.path, row.size)}`;
      const bucket = byQuick.get(key) || [];
      bucket.push(row);
      byQuick.set(key, bucket);
    } catch {
      /* 被占用/已删除的直接跳过 */
    }
    quickDone += 1;
    if (quickDone % 20 === 0) {
      report('quick', { message: '正在比对首尾内容…', total: candidates.length, done: quickDone });
    }
  });

  const needsFull = [...byQuick.values()].filter((bucket) => bucket.length > 1).flat();

  // 阶段 3：全量哈希
  let hashed = 0;
  const byFull = new Map();
  await mapLimit(needsFull, CONCURRENCY, async (row) => {
    try {
      const digest = await fullHash(row.path);
      const bucket = byFull.get(digest) || [];
      bucket.push(row);
      byFull.set(digest, bucket);
    } catch {
      /* 同上 */
    }
    hashed += 1;
    if (hashed % 5 === 0) {
      report('hash', { message: '正在计算完整哈希…', total: needsFull.length, done: hashed });
    }
  });

  const groups = [];
  for (const [digest, bucket] of byFull) {
    if (bucket.length < 2) continue;
    // 按修改时间升序，最老的排第一，界面上默认建议保留它
    bucket.sort((a, b) => a.mtime - b.mtime);
    const size = bucket[0].size;
    groups.push({
      hash: digest,
      size,
      count: bucket.length,
      wasted: size * (bucket.length - 1),
      items: bucket.map((row) => ({
        path: row.path,
        name: row.name,
        dir: path.dirname(row.path),
        size: row.size,
        mtime: row.mtime,
      })),
    });
  }
  groups.sort((a, b) => b.wasted - a.wasted);

  report('done', { groups: groups.length });
  return {
    groups,
    scanned: paths.length,
    hashed: needsFull.length,
    totalWasted: groups.reduce((sum, group) => sum + group.wasted, 0),
    truncated: Boolean(truncated),
  };
}

/**
 * 删除重复项。默认走系统回收站，用户后悔了还能找回来。
 *
 * @param {string[]} paths
 * @param {(target:string)=>Promise<void>} trashItem shell.trashItem
 */
async function trashPaths(paths, trashItem) {
  const removed = [];
  const failed = [];
  for (const target of paths) {
    try {
      await trashItem(target);
      removed.push(target);
    } catch (err) {
      failed.push({ path: target, reason: err.message });
    }
  }
  return { removed, failed, freed: removed.length };
}

module.exports = { findDuplicates, trashPaths, quickHash, fullHash, mapLimit };
