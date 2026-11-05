'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { pathExists, moveFile } = require('./fsutil');

/**
 * 操作日志与多步撤销 / 重做。
 *
 * 格式选 NDJSON 逐行追加：每成功移动一条就立刻落盘，
 * 进程中途被杀也只丢失最后一条，不会出现「日志说有、实际没移」。
 *
 * 批次状态用**文件后缀**表示，比在文件里写状态可靠：
 *   undo-<时间戳>.jsonl  → 已执行，可撤销
 *   undo-<时间戳>.undone → 已撤销，可重做
 * 撤销/重做就是一次原子 rename，不存在「状态字段和实际不符」的中间态。
 */

const LOG_PATTERN = /^undo-.+\.(jsonl|undone)$/;
/** 最多保留的批次数量，超过就删最老的，避免日志目录无限膨胀 */
const MAX_BATCHES = 300;

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * @param {string} baseDir userData 目录
 */
function createUndo(baseDir) {
  const dir = path.join(baseDir, 'undo');

  async function ensureDir() {
    await fs.mkdir(dir, { recursive: true });
  }

  /**
   * 开始一次操作批次，返回日志文件路径。
   * @param {string} rootDir 本次操作的根目录
   * @param {{action?:string, note?:string}} [meta] action: organize | rename | batch
   */
  async function startLog(rootDir, meta = {}) {
    await ensureDir();
    const file = path.join(dir, `undo-${stamp()}.jsonl`);
    const head = {
      t: 'head',
      ts: Date.now(),
      dir: rootDir,
      action: meta.action || 'organize',
      note: meta.note || '',
    };
    await fs.writeFile(file, `${JSON.stringify(head)}\n`, 'utf8');
    return file;
  }

  /** 追加一条已成功的移动 */
  async function record(file, from, to) {
    await fs.appendFile(file, `${JSON.stringify({ t: 'move', from, to })}\n`, 'utf8');
  }

  /** 读日志，半行（进程被杀）直接忽略 */
  async function readLog(file) {
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      return { head: {}, moves: [] };
    }
    const rows = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* 忽略半截行 */
      }
    }
    const head = rows.find((row) => row.t === 'head') || {};
    return { head, moves: rows.filter((row) => row.t === 'move') };
  }

  /** 列出全部批次，按时间倒序 */
  async function listBatches(limit = 60) {
    let names;
    try {
      names = (await fs.readdir(dir)).filter((name) => LOG_PATTERN.test(name));
    } catch {
      return [];
    }
    names.sort().reverse();
    const out = [];
    for (const name of names.slice(0, limit)) {
      const file = path.join(dir, name);
      try {
        const { head, moves } = await readLog(file);
        if (!moves.length && !head.ts) continue;
        out.push({
          file,
          name,
          ts: head.ts || 0,
          dir: head.dir || '',
          action: head.action || 'organize',
          note: head.note || '',
          count: moves.length,
          undone: name.endsWith('.undone'),
        });
      } catch {
        /* 损坏的日志跳过 */
      }
    }
    return out;
  }

  /**
   * 撤销后清掉「因这次整理而被腾空」的分类文件夹。
   *
   * 只处理被移动文件原来所在的目录（撤销时的 to），而且是自底向上逐级尝试。
   * 用的是非递归的 rmdir：目录里只要还剩任何东西就会抛 ENOTEMPTY，天然不会误删。
   * 不做递归删除，是因为这里的目标只是「顺手清理空壳」，不值得承担删错的风险。
   */
  async function pruneEmptyDirs(dirs, stopAt) {
    /** @type {Set<string>} */
    const seen = new Set();
    const root = String(stopAt || '').replace(/[\\/]+$/, '').toLowerCase();

    // 深路径优先：先删子目录，父目录才可能跟着变空
    const ordered = [...new Set(dirs)]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);

    for (const dir of ordered) {
      let current = dir;
      while (current) {
        const key = current.toLowerCase();
        if (seen.has(key)) break;
        // 到了批次根目录就停手：那是用户自己的文件夹，不是我们建的
        if (root && key === root) break;
        if (root && !key.startsWith(`${root}\\`) && !key.startsWith(`${root}/`)) break;
        seen.add(key);
        try {
          await fs.rmdir(current);
        } catch {
          // ENOTEMPTY / ENOENT / EPERM 都直接停：这一层还有东西，再往上没意义
          break;
        }
        current = path.dirname(current);
        if (current === dir) break;
      }
    }
  }

  /**
   * 把一批 move 记录反向执行（撤销）或正向执行（重做）。
   * 目标已存在、源已不在、被占用都会单独记一条失败原因，不中断整批。
   *
   * @param {Array<{from:string,to:string}>} moves
   * @param {'undo'|'redo'} direction
   */
  async function relocate(moves, direction, rootDir = '') {
    const ordered = direction === 'undo' ? [...moves].reverse() : moves;
    let done = 0;
    const failed = [];
    /** 成功搬迁的配对，调用方用它同步更新标签索引 */
    const pairs = [];
    for (const move of ordered) {
      const from = direction === 'undo' ? move.to : move.from;
      const to = direction === 'undo' ? move.from : move.to;
      try {
        const sourceExists = await pathExists(from);
        const targetExists = await pathExists(to);
        if (!sourceExists) {
          failed.push({ path: from, reason: '源文件已不在原处' });
          continue;
        }
        if (targetExists) {
          failed.push({ path: to, reason: '目标位置已有同名文件' });
          continue;
        }
        await fs.mkdir(path.dirname(to), { recursive: true });
        await moveFile(from, to);
        done += 1;
        pairs.push({ from, to });
      } catch (err) {
        failed.push({ path: from, reason: err.message });
      }
    }

    // 撤销成功后把腾空的分类目录收掉，否则用户撤销完还看到一堆空文件夹
    if (direction === 'undo' && done > 0) {
      await pruneEmptyDirs(pairs.map((pair) => path.dirname(pair.from)), rootDir);
    }

    return { done, failed, pairs };
  }

  /** 撤销指定批次 */
  async function undoBatch(file) {
    const { head, moves } = await readLog(file);
    if (!moves.length) return { restored: 0, failed: [], message: '这一批没有移动记录' };
    const { done, failed, pairs } = await relocate(moves, 'undo', head.dir || '');
    // 全部还原成功才改名；部分失败保留可撤销状态，用户可以重试
    if (done > 0 && failed.length === 0) {
      await fs.rename(file, file.replace(/\.jsonl$/, '.undone')).catch(() => {});
    }
    return {
      restored: done,
      failed,
      pairs,
      dir: head.dir || '',
      action: head.action || 'organize',
      message: done ? `已还原 ${done} 个文件` : '没有文件被还原',
    };
  }

  /** 重做指定批次（撤销的反向操作） */
  async function redoBatch(file) {
    if (!file.endsWith('.undone')) return { restored: 0, failed: [], message: '这一批还没被撤销' };
    const { head, moves } = await readLog(file);
    if (!moves.length) return { restored: 0, failed: [], message: '这一批没有移动记录' };
    const { done, failed, pairs } = await relocate(moves, 'redo');
    if (done > 0 && failed.length === 0) {
      await fs.rename(file, file.replace(/\.undone$/, '.jsonl')).catch(() => {});
    }
    return {
      restored: done,
      failed,
      pairs,
      dir: head.dir || '',
      action: head.action || 'organize',
      message: done ? `已重新移动 ${done} 个文件` : '没有文件被移动',
    };
  }

  /**
   * 撤销最近 N 次操作。
   * @param {number} count 撤销几批，默认 1
   */
  async function undoLast(count = 1) {
    const batches = (await listBatches(200)).filter((item) => !item.undone && item.count > 0);
    if (!batches.length) return { restored: 0, failed: [], batches: [], message: '没有可撤销的操作' };

    const limit = Math.max(1, Math.min(50, Number(count) || 1));
    const targets = batches.slice(0, limit);
    let restored = 0;
    const failed = [];
    const done = [];
    for (const batch of targets) {
      const result = await undoBatch(batch.file);
      restored += result.restored;
      failed.push(...result.failed);
      if (result.restored > 0) done.push({ file: batch.file, dir: batch.dir, count: result.restored });
    }
    return {
      restored,
      failed,
      batches: done,
      dir: done[0]?.dir || '',
      message: restored ? `已撤销 ${done.length} 次操作，共还原 ${restored} 个文件` : '没有文件被还原',
    };
  }

  /** 重做最近一次被撤销的操作 */
  async function redoLast() {
    const batches = (await listBatches(200)).filter((item) => item.undone && item.count > 0);
    if (!batches.length) return { restored: 0, failed: [], batches: [], message: '没有可重做的操作' };
    const target = batches[0];
    const result = await redoBatch(target.file);
    return { ...result, batches: result.restored ? [target] : [] };
  }

  /** 清空全部历史（只删本应用自己的日志文件） */
  async function clearHistory() {
    let names = [];
    try {
      names = (await fs.readdir(dir)).filter((name) => LOG_PATTERN.test(name));
    } catch {
      return { removed: 0 };
    }
    for (const name of names) {
      await fs.unlink(path.join(dir, name)).catch(() => {});
    }
    return { removed: names.length };
  }

  /** 只保留最近 MAX_BATCHES 个批次 */
  async function prune() {
    let names = [];
    try {
      names = (await fs.readdir(dir)).filter((name) => LOG_PATTERN.test(name));
    } catch {
      return 0;
    }
    if (names.length <= MAX_BATCHES) return 0;
    names.sort().reverse();
    const stale = names.slice(MAX_BATCHES);
    for (const name of stale) await fs.unlink(path.join(dir, name)).catch(() => {});
    return stale.length;
  }

  return {
    dir,
    startLog,
    record,
    readLog,
    listBatches,
    undoBatch,
    redoBatch,
    undoLast,
    redoLast,
    clearHistory,
    prune,
    /** 向后兼容 2.0 的调用点 */
    history: listBatches,
    undo: undoBatch,
  };
}

module.exports = { createUndo, MAX_BATCHES };
