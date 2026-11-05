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

/**
 * 相似度打分（纯函数，已单测）。
 * 权重按「同前缀 > 同类型 > 同时间 > 同体积 > 同目录」排布。
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
  const { rows, truncated } = await scanner.listAll(dir);

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

  const tokens = String(keyword || '').toLowerCase().split(/\s+/).filter(Boolean);
  let hits = [];
  if (tokens.length) {
    const needle = tokens.join(' ');
    hits = files.filter((file) => {
      const lower = file.name.toLowerCase();
      return lower.includes(needle) && tokens.every((t) => lower.includes(t));
    });
    hits.sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(needle) ? 1 : 0;
      const bStarts = b.name.toLowerCase().startsWith(needle) ? 1 : 0;
      if (aStarts !== bStarts) return bStarts - aStarts;
      return b.mtime - a.mtime;
    });
  }

  let similar = [];
  if (hits.length) {
    const anchor = hits[0];
    const hitPaths = new Set(hits.map((h) => h.path));
    similar = files
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
    hitTotal: hits.length,
    similar,
    truncated,
    elapsed: Date.now() - started,
  };
}

module.exports = { search, scoreSimilar, prefixOf };
