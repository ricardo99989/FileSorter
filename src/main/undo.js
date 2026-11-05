'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { pathExists, moveFile } = require('./fsutil');

/**
 * 整理日志与回滚。
 *
 * 格式选用 NDJSON 逐行追加：每成功移动一条就立刻落盘，
 * 进程中途被杀也只丢失最后一条，不会出现「日志说有、实际没移」。
 */
function createUndo(baseDir) {
  const dir = path.join(baseDir, 'undo');

  async function ensureDir() {
    await fs.mkdir(dir, { recursive: true });
  }

  /**
   * 开始一次整理，返回日志文件路径。
   * @param {string} rootDir 本次整理的根目录
   */
  async function startLog(rootDir) {
    await ensureDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `undo-${stamp}.jsonl`);
    await fs.writeFile(file, `${JSON.stringify({ t: 'head', ts: Date.now(), dir: rootDir })}\n`, 'utf8');
    return file;
  }

  /** 追加一条已成功的移动 */
  async function record(file, from, to) {
    await fs.appendFile(file, `${JSON.stringify({ t: 'move', from, to })}\n`, 'utf8');
  }

  async function readLog(file) {
    const text = await fs.readFile(file, 'utf8');
    const rows = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // 半行（进程被杀）直接忽略
      }
    }
    const head = rows.find((r) => r.t === 'head') || {};
    return { head, moves: rows.filter((r) => r.t === 'move') };
  }

  /** 最近 10 次整理记录，供界面展示 */
  async function history(limit = 10) {
    try {
      const names = (await fs.readdir(dir)).filter((n) => n.startsWith('undo-') && n.endsWith('.jsonl'));
      names.sort().reverse();
      const out = [];
      for (const name of names.slice(0, limit)) {
        const file = path.join(dir, name);
        try {
          const { head, moves } = await readLog(file);
          out.push({ file, ts: head.ts || 0, dir: head.dir || '', count: moves.length, undone: false });
        } catch {
          // 跳过损坏日志
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * 回滚指定日志。逆序还原，目标已存在或被占用则跳过。
   * @param {string} file
   */
  async function undo(file) {
    const { moves } = await readLog(file);
    let restored = 0;
    const failed = [];
    for (const move of [...moves].reverse()) {
      try {
        const backExists = await pathExists(move.from);
        const stillThere = await pathExists(move.to);
        if (!stillThere) {
          failed.push({ from: move.from, reason: '原文件已不在分类目录' });
          continue;
        }
        if (backExists) {
          failed.push({ from: move.from, reason: '原位置已有同名文件' });
          continue;
        }
        await fs.mkdir(path.dirname(move.from), { recursive: true });
        await moveFile(move.to, move.from);
        restored += 1;
      } catch (err) {
        failed.push({ from: move.from, reason: err.message });
      }
    }
    // 标记为已回滚，防止重复执行
    await fs.rename(file, file.replace(/\.jsonl$/, '.undone')).catch(() => {});
    return { restored, failed };
  }

  /** 回滚最近一次尚未回滚的整理 */
  async function undoLast() {
    const list = await history(20);
    const target = list.find((item) => item.count > 0);
    if (!target) return { restored: 0, failed: [], message: '没有可撤销的整理记录' };
    const result = await undo(target.file);
    return { ...result, message: `已还原 ${result.restored} 个文件` };
  }

  return { dir, startLog, record, history, undo, undoLast };
}

module.exports = { createUndo };
