'use strict';

/**
 * clipboard.js — 剪贴板历史（3.8）
 *
 * Windows 没有"剪贴板变了"的回调，Electron 也没有，唯一办法是低频读一次文本。
 * 所以这里把开销压到最低：
 *   - 1500ms 一次 clipboard.readText()，一次调用只是读一块共享内存，不碰磁盘；
 *   - 只在文本真的变了才起一次处理，写盘按 900ms 合并，连续复制不会反复落盘；
 *   - 只存纯文本、最多 40 条、单条 4000 字，历史文件始终在几十 KB 量级。
 *
 * 隐私：数据只写在用户自己的 userData 下，不联网、不上传；设置里可一键关停与清空。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_ITEMS = 40;
const MAX_LEN = 4000;
const POLL_MS = 1500;
const SAVE_DELAY = 900;

function createClipboardHistory({ clipboard, userData, onUpdate } = {}) {
  let items = [];
  let enabled = true;
  let lastSeen = '';
  let timer = null;
  let saveTimer = null;
  let loaded = false;
  let seq = Date.now();

  const file = () => path.join(userData, 'clipboard-history.json');

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(await fs.readFile(file(), 'utf8'));
      if (Array.isArray(raw.items)) {
        items = raw.items
          .filter((item) => item && typeof item.text === 'string' && item.text.length <= MAX_LEN)
          .map((item) => ({
            id: String(item.id || ''),
            text: item.text,
            at: Number(item.at) || Date.now(),
          }))
          .filter((item) => item.id)
          .slice(0, MAX_ITEMS);
      }
    } catch {
      /* 首次运行 / 文件损坏：从空历史开始即可 */
    }
    try {
      lastSeen = clipboard.readText();
    } catch {
      lastSeen = '';
    }
  }

  function emit() {
    if (typeof onUpdate === 'function') onUpdate(items.slice());
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      fs.mkdir(userData, { recursive: true })
        .then(() => fs.writeFile(file(), JSON.stringify({ v: 1, items }), 'utf8'))
        .catch(() => {});
    }, SAVE_DELAY);
  }

  function add(text) {
    const value = String(text || '').trim();
    if (!value || value.length > MAX_LEN) return;
    // 同一段文本连续复制（或点历史条目写回）不该把历史刷屏
    if (items[0] && items[0].text === value) {
      items[0].at = Date.now();
      scheduleSave();
      emit();
      return;
    }
    // 更早出现过的同一段文本：提到最前，不留重复
    const oldIndex = items.findIndex((item) => item.text === value);
    if (oldIndex >= 0) items.splice(oldIndex, 1);
    seq += 1;
    items.unshift({ id: `${Date.now().toString(36)}-${seq.toString(36)}`, text: value, at: Date.now() });
    if (items.length > MAX_ITEMS) items.length = MAX_ITEMS;
    scheduleSave();
    emit();
  }

  function tick() {
    if (!enabled) return;
    let text = '';
    try {
      text = clipboard.readText();
    } catch {
      return;
    }
    if (text === lastSeen) return;
    lastSeen = text;
    add(text);
  }

  async function start() {
    await load();
    if (timer || !enabled) return;
    timer = setInterval(tick, POLL_MS);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    clearTimeout(saveTimer);
    saveTimer = null;
    if (userData) {
      fs.mkdir(userData, { recursive: true })
        .then(() => fs.writeFile(file(), JSON.stringify({ v: 1, items }), 'utf8'))
        .catch(() => {});
    }
  }

  function setEnabled(value) {
    enabled = Boolean(value);
    if (!enabled && timer) {
      clearInterval(timer);
      timer = null;
    } else if (enabled && !timer) {
      timer = setInterval(tick, POLL_MS);
      // 关停期间剪贴板可能已经变了，重启时对齐一次，避免把旧内容当成新复制
      try {
        lastSeen = clipboard.readText();
      } catch {
        lastSeen = '';
      }
    }
    return enabled;
  }

  function list() {
    return { items: items.slice(), enabled, count: items.length };
  }

  function clear() {
    items = [];
    scheduleSave();
    emit();
    return list();
  }

  function remove(id) {
    const at = items.findIndex((item) => item.id === String(id));
    if (at >= 0) items.splice(at, 1);
    scheduleSave();
    emit();
    return list();
  }

  /** 点历史条目写回剪贴板；同步 lastSeen，下一次 tick 不会把它当成"新复制" */
  function copy(id) {
    const item = items.find((entry) => entry.id === String(id));
    if (!item) return false;
    clipboard.writeText(item.text);
    lastSeen = item.text;
    return true;
  }

  return {
    start,
    stop,
    setEnabled,
    list,
    clear,
    remove,
    copy,
    // 冒烟/单测用
    _add: add,
    _tick: tick,
    _state: () => ({ items, enabled, timer: Boolean(timer) }),
  };
}

module.exports = { createClipboardHistory };
