'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

/** 目标是否已存在 */
async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 移动文件：同盘用 rename（瞬时、不复制数据），跨盘 rename 会抛 EXDEV，
 * 此时降级为「复制 + 删除源」。COPYFILE_EXCL 保证绝不覆盖已存在的目标。
 * @param {string} src
 * @param {string} dest
 */
async function moveFile(src, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    const { COPYFILE_EXCL } = require('node:fs').constants;
    await fs.copyFile(src, dest, COPYFILE_EXCL);
    await fs.unlink(src);
  }
}

/**
 * 判断文件是否被其他程序独占。用只读方式打开试探：
 * 只读属性不影响读取，所以不会把只读文件误判为占用。
 * @param {string} target
 */
async function isLocked(target) {
  try {
    const handle = await fs.open(target, 'r');
    await handle.close();
    return false;
  } catch (err) {
    return ['EBUSY', 'EPERM', 'EACCES', 'ENOENT'].includes(err.code);
  }
}

/**
 * 在 taken 集合内生成不冲突的文件名：a.jpg → a(1).jpg → a(2).jpg
 * @param {string} fileName
 * @param {Set<string>} taken 同目录已占用的文件名（小写比较）
 */
function uniqueName(fileName, taken) {
  const ext = path.extname(fileName);
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  let candidate = fileName;
  let index = 1;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${base}(${index})${ext}`;
    index += 1;
    if (index > 9999) throw new Error(`无法为 ${fileName} 找到可用文件名`);
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

module.exports = { pathExists, moveFile, isLocked, uniqueName };
