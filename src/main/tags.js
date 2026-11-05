'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * 文件标签系统。
 *
 * 标签突破了「一个文件只能躺在一个文件夹里」的限制：
 * 同一个文件可以同时是「重要」「项目A」「待报销」，检索时按标签交叉筛选。
 *
 * 存储：userData/tags.json（原子写入），键是**小写绝对路径**，
 * 因为 Windows 路径大小写不敏感，不统一大小写会出现"同一文件两条记录"。
 */

const FILE_VERSION = 1;

/** 预设配色，和界面里的标签点一一对应 */
const TAG_COLORS = ['blue', 'violet', 'sage', 'amber', 'rose', 'teal', 'slate'];

function keyOf(target) {
  return String(target || '').replace(/\//g, '\\').toLowerCase();
}

function createTags(baseDir) {
  const file = path.join(baseDir, 'tags.json');
  let cache = { version: FILE_VERSION, tags: [], files: {} };

  async function load() {
    try {
      const text = await fs.readFile(file, 'utf8');
      const raw = JSON.parse(text);
      const tags = Array.isArray(raw.tags)
        ? raw.tags
            .filter((tag) => tag && typeof tag.id === 'string' && typeof tag.name === 'string')
            .map((tag) => ({
              id: tag.id,
              name: tag.name.slice(0, 24),
              color: TAG_COLORS.includes(tag.color) ? tag.color : 'blue',
            }))
        : [];
      const files = {};
      if (raw.files && typeof raw.files === 'object') {
        for (const [key, value] of Object.entries(raw.files)) {
          if (!Array.isArray(value)) continue;
          const clean = value.filter((id) => typeof id === 'string');
          if (clean.length) files[key] = [...new Set(clean)];
        }
      }
      cache = { version: FILE_VERSION, tags, files };
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[tags] 读取失败，使用空库：', err.message);
      cache = { version: FILE_VERSION, tags: [], files: {} };
    }
    return cache;
  }

  async function persist() {
    await fs.mkdir(baseDir, { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
    await fs.rename(tmp, file);
  }

  /** 全部标签及各自引用的文件数 */
  function list() {
    const counts = new Map();
    for (const ids of Object.values(cache.files)) {
      for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
    }
    return cache.tags.map((tag) => ({ ...tag, count: counts.get(tag.id) || 0 }));
  }

  async function createTag(name, color) {
    const clean = String(name || '').trim().slice(0, 24);
    if (!clean) throw new Error('标签名不能为空');
    if (cache.tags.some((tag) => tag.name === clean)) throw new Error('已经有同名标签了');
    const tag = {
      id: `t${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`,
      name: clean,
      color: TAG_COLORS.includes(color) ? color : TAG_COLORS[cache.tags.length % TAG_COLORS.length],
    };
    cache.tags.push(tag);
    await persist();
    return tag;
  }

  async function updateTag(id, patch) {
    const tag = cache.tags.find((item) => item.id === id);
    if (!tag) throw new Error('标签不存在');
    if (typeof patch.name === 'string' && patch.name.trim()) tag.name = patch.name.trim().slice(0, 24);
    if (TAG_COLORS.includes(patch.color)) tag.color = patch.color;
    await persist();
    return tag;
  }

  async function deleteTag(id) {
    cache.tags = cache.tags.filter((tag) => tag.id !== id);
    for (const [key, ids] of Object.entries(cache.files)) {
      const next = ids.filter((item) => item !== id);
      if (next.length) cache.files[key] = next;
      else delete cache.files[key];
    }
    await persist();
    return true;
  }

  /** 打标签（追加，不覆盖已有的） */
  async function addTags(targets, tagIds) {
    const ids = Array.isArray(tagIds) ? tagIds.filter((id) => cache.tags.some((tag) => tag.id === id)) : [];
    if (!ids.length) throw new Error('没有选择标签');
    for (const target of targets) {
      const key = keyOf(target);
      const current = cache.files[key] || [];
      cache.files[key] = [...new Set([...current, ...ids])];
    }
    await persist();
    return targets.length;
  }

  /** 整体替换某个文件的标签集合 */
  async function setTags(target, tagIds) {
    const key = keyOf(target);
    const ids = (Array.isArray(tagIds) ? tagIds : []).filter((id) => cache.tags.some((tag) => tag.id === id));
    if (ids.length) cache.files[key] = [...new Set(ids)];
    else delete cache.files[key];
    await persist();
    return ids;
  }

  async function removeTags(targets, tagIds) {
    const drop = new Set(tagIds);
    for (const target of targets) {
      const key = keyOf(target);
      const next = (cache.files[key] || []).filter((id) => !drop.has(id));
      if (next.length) cache.files[key] = next;
      else delete cache.files[key];
    }
    await persist();
  }

  /** 某个文件身上的标签 */
  function tagsOf(target) {
    const ids = cache.files[keyOf(target)] || [];
    return ids.map((id) => cache.tags.find((tag) => tag.id === id)).filter(Boolean);
  }

  /** 批量取，列表渲染时一次性把整页的标签拿回来，避免 N 次 IPC */
  function tagsOfMany(targets) {
    const out = {};
    for (const target of targets) {
      const tags = tagsOf(target);
      if (tags.length) out[target] = tags;
    }
    return out;
  }

  /** 文件被移动/重命名后，把标签跟过去 */
  async function remapPath(from, to) {
    const source = keyOf(from);
    const ids = cache.files[source];
    if (!ids) return false;
    delete cache.files[source];
    const destKey = keyOf(to);
    cache.files[destKey] = [...new Set([...(cache.files[destKey] || []), ...ids])];
    await persist();
    return true;
  }

  /**
   * 在目录内按标签检索。多个标签默认是「同时具备」（AND），
   * 因为用户筛「重要 + 待报销」的意图远多于「重要 或 待报销」。
   *
   * @param {string} dir
   * @param {string[]} tagIds
   * @param {{matchAll?:boolean}} [options]
   */
  async function search(dir, tagIds, options = {}) {
    const matchAll = options.matchAll !== false;
    const root = keyOf(dir);
    const wanted = new Set(tagIds);

    const hits = [];
    for (const [key, ids] of Object.entries(cache.files)) {
      if (!key.startsWith(root)) continue;
      const owned = ids.filter((id) => wanted.has(id));
      if (matchAll ? owned.length !== wanted.size : owned.length === 0) continue;
      let stat = null;
      try {
        stat = await fs.stat(key);
      } catch {
        // 文件已被删掉，标签记录留着也没意义，顺手清掉
        delete cache.files[key];
        continue;
      }
      hits.push({
        path: key,
        name: path.basename(key),
        dir: path.dirname(key),
        size: stat.size,
        mtime: stat.mtimeMs,
        ctime: stat.birthtimeMs || stat.mtimeMs,
        isDir: stat.isDirectory(),
        tags: ids.map((id) => cache.tags.find((tag) => tag.id === id)).filter(Boolean),
      });
    }
    return hits;
  }

  /** 清理指向已不存在文件的标签记录 */
  async function prune() {
    let removed = 0;
    for (const key of Object.keys(cache.files)) {
      try {
        await fs.access(key);
      } catch {
        delete cache.files[key];
        removed += 1;
      }
    }
    if (removed) await persist();
    return removed;
  }

  return {
    file,
    load,
    list,
    createTag,
    updateTag,
    deleteTag,
    addTags,
    setTags,
    removeTags,
    tagsOf,
    tagsOfMany,
    remapPath,
    search,
    prune,
    TAG_COLORS,
    /** 测试用：直接读内部状态 */
    snapshot: () => JSON.parse(JSON.stringify(cache)),
  };
}

module.exports = { createTags, TAG_COLORS };
