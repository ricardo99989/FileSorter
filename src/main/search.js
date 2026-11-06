'use strict';

const path = require('node:path');
const scanner = require('./scanner');
const { classify, extOf } = require('./classifier');

/** 取文件名主干里的「前缀词」：banner_final_v2 → banner */
function prefixOf(fileName) {
  const ext = extOf(fileName);
  const base = ext ? fileName.slice(0, -(ext.length + 1)) : fileName;
  const token = base.split(/[-_\s.]+/).filter(Boolean)[0] || '';
  return token.replace(/\d+$/, '').toLowerCase();
}

/** 把文件名切成词，用于「关键词重合」打分（banner_home_v2 → [banner, home, v2]） */
function tokensOf(fileName) {
  const ext = extOf(fileName);
  const base = ext ? fileName.slice(0, -(ext.length + 1)) : fileName;
  return base
    .toLowerCase()
    .split(/[-_\s.()[\]]+/)
    .filter((token) => token.length >= 2);
}

/**
 * 相似度打分（纯函数，已单测）。
 * 权重按「同前缀 > 关键词重合 > 同类型 > 同时间 > 同体积 > 同目录」排布。
 * @param {{name:string,size:number,mtime:number,path:string}} a
 * @param {{name:string,size:number,mtime:number,path:string}} b
 */
function scoreSimilar(a, b) {
  if (!a || !b || a.path === b.path) return -1;

  let score = 0;
  const extA = extOf(a.name);
  const extB = extOf(b.name);
  if (extA && extA === extB) score += 3;

  const prefixA = prefixOf(a.name);
  const prefixB = prefixOf(b.name);
  if (prefixA.length >= 2 && prefixA === prefixB) score += 5;

  // 关键词重合：banner_home_v2 与 banner_home_final 共享两个词
  const tokensA = tokensOf(a.name);
  if (tokensA.length) {
    const setB = new Set(tokensOf(b.name));
    const shared = tokensA.filter((token) => setB.has(token)).length;
    if (shared) score += Math.min(4, shared * 2);
  }

  const dayMs = 86400000;
  const gap = Math.abs(a.mtime - b.mtime);
  if (gap <= dayMs) score += 2;
  else if (gap <= dayMs * 7) score += 1;

  if (a.size > 0 && b.size > 0) {
    const diff = Math.abs(a.size - b.size) / Math.max(a.size, b.size);
    if (diff <= 0.15) score += 1;
  }

  if (path.dirname(a.path).toLowerCase() === path.dirname(b.path).toLowerCase()) score += 1;
  return score;
}

/**
 * 搜索 + 相似推荐。
 * @param {string} dir
 * @param {string} keyword 支持空格分隔的多关键词（AND 语义）
 * @param {{limit?:number, similarCount?:number}} [options]
 */
async function search(dir, keyword, options = {}) {
  const { limit = 120, similarCount = 5 } = options;
  const started = Date.now();
  const { paths, truncated } = await scanner.collectPaths(dir, { maxFiles: 30000 });

  const tokens = String(keyword || '').toLowerCase().split(/\s+/).filter(Boolean);
  const needle = tokens.join(' ');

  /**
   * 先按文件名筛，再 stat —— 这是这一版最重要的性能改动。
   *
   * 旧写法是"先把整棵树 stat 一遍，再在内存里过滤"，一个几万文件的目录要发
   * 几万次 stat，光这一步就要几秒。文件名匹配是纯字符串操作，几乎不要钱；
   * 先筛出命中的几十个，再 stat 它们，I/O 次数直接掉两个数量级。
   */
  const matchedPaths = [];
  const restPaths = [];
  for (const full of paths) {
    const base = path.basename(full).toLowerCase();
    if (tokens.length && tokens.every((token) => base.includes(token))) matchedPaths.push(full);
    else if (restPaths.length < 400) restPaths.push(full);
  }

  const toFile = (row) => {
    const name = path.basename(row.path);
    const cat = classify(name);
    return {
      name,
      path: row.path,
      dir: path.dirname(row.path),
      size: row.size,
      mtime: row.mtime,
      ctime: row.ctime || row.mtime,
      ext: extOf(name),
      categoryId: cat.id,
    };
  };

  // 命中项最多 stat 4×limit 个：再多用户也翻不到
  const hitRows = await scanner.statBatch(matchedPaths.slice(0, limit * 4));
  const hits = hitRows
    .map(toFile)
    .sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(needle) ? 1 : 0;
      const bStarts = b.name.toLowerCase().startsWith(needle) ? 1 : 0;
      if (aStarts !== bStarts) return bStarts - aStarts;
      return b.mtime - a.mtime;
    });

  let similar = [];
  if (hits.length) {
    const anchor = hits[0];
    const hitPaths = new Set(hits.map((hit) => hit.path));
    // 相似推荐只看一小撮"没命中"的候选，不为了 5 条推荐把整棵树都 stat 了
    const sampleRows = await scanner.statBatch(restPaths.slice(0, 240));
    similar = sampleRows
      .map(toFile)
      .filter((file) => !hitPaths.has(file.path))
      .map((file) => ({ file, score: scoreSimilar(anchor, file) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.file.mtime - a.file.mtime)
      .slice(0, similarCount)
      .map((entry) => entry.file);
  }

  return {
    keyword,
    anchor: hits[0] || null,
    hits: hits.slice(0, limit),
    hitTotal: matchedPaths.length,
    similar,
    truncated,
    elapsed: Date.now() - started,
  };
}

module.exports = { search, scoreSimilar, prefixOf, tokensOf };
