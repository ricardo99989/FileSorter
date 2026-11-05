'use strict';

const path = require('node:path');
const chokidar = require('chokidar');

/**
 * 实时文件监听。
 *
 * 用 chokidar，底层走系统原生事件（Windows 上是 ReadDirectoryChangesW），
 * **不做定时轮询**，所以空闲时 CPU 基本是 0。
 *
 * 事件做了两层合并，避免一次复制文件触发几十次界面刷新：
 *   1. chokidar 的 awaitWriteFinish 等文件写完再报；
 *   2. 这里再按 250ms 窗口聚合成一次回调。
 */
function createWatcher({ onEvent } = {}) {
  /** @type {import('chokidar').FSWatcher | null} */
  let watcher = null;
  let currentDir = '';
  let pending = new Set();
  let lastType = '';
  let timer = null;
  let events = 0;

  function flush() {
    timer = null;
    if (!pending.size) return;
    const paths = [...pending];
    pending = new Set();
    const type = lastType;
    lastType = '';
    events += paths.length;
    if (typeof onEvent === 'function') {
      onEvent({ dir: currentDir, type, paths, at: Date.now() });
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 250);
  }

  function handle(kind) {
    return (target) => {
      // 只关心当前目录这一层的变化，子目录的变化单独通知
      if (path.dirname(target) === currentDir) {
        lastType = kind === 'addDir' || kind === 'unlinkDir' ? 'dir' : kind;
        pending.add(target);
        schedule();
      } else {
        lastType = 'deep';
        pending.add(target);
        schedule();
      }
    };
  }

  /** 停止对当前目录的监听 */
  async function unwatch() {
    if (!watcher) return;
    const dying = watcher;
    watcher = null;
    currentDir = '';
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await dying.close().catch(() => {});
  }

  /**
   * 监听一个目录（替换之前的监听目标）。
   * @param {string} dir
   */
  async function watch(dir) {
    if (!dir) return;
    if (currentDir === dir && watcher) return;
    await unwatch();
    currentDir = dir;

    watcher = chokidar.watch(dir, {
      // 只盯自己 + 一层子目录：整理会把文件挪进子文件夹，需要感知到
      depth: 1,
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      // 原生事件，绝不轮询（轮询会持续吃 CPU，和"空闲接近 0"直接冲突）
      usePolling: false,
      // 刚复制进来的文件要等写完再通知，否则列表会闪一下又变
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      ignored: (target, stats) => {
        const base = path.basename(target).toLowerCase();
        if (base === 'desktop.ini' || base === 'thumbs.db') return true;
        if (stats && stats.isDirectory()) {
          return base === 'node_modules' || base === '.git' || base === '$recycle.bin';
        }
        return false;
      },
    });

    watcher
      .on('add', handle('add'))
      .on('change', handle('change'))
      .on('unlink', handle('unlink'))
      .on('addDir', handle('add'))
      .on('unlinkDir', handle('unlink'))
      .on('error', (err) => {
        // 目录被删、权限不足都会走到这里，提示一下即可，不要把进程带崩
        if (typeof onEvent === 'function') {
          onEvent({ dir: currentDir, type: 'error', message: err.message, at: Date.now() });
        }
      });
  }

  function status() {
    return {
      dir: currentDir,
      active: Boolean(watcher),
      events,
      // 便于界面上告诉用户「监听靠的是系统事件」
      engine: 'chokidar · 原生事件',
    };
  }

  return { watch, unwatch, status };
}

module.exports = { createWatcher };
