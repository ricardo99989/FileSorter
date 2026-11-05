'use strict';

const path = require('node:path');

/**
 * 排除名单与系统文件保护。
 *
 * 这一层的目的只有一个：**别把不该动的东西动了**。
 * 所以它有两道闸：
 *   1. `SYSTEM_NAMES` / `SYSTEM_DIR_NAMES` 是写死的硬保护，用户删不掉；
 *   2. `excludes` 是用户自己加的黑名单，支持精确名、包含、通配、绝对路径。
 */

/** 绝对不参与整理的系统文件（Windows 关键项 + 资源管理器元数据） */
const SYSTEM_NAMES = new Set([
  'desktop.ini',
  'thumbs.db',
  'ehthumbs.db',
  'ehthumbs_vista.db',
  'pagefile.sys',
  'hiberfil.sys',
  'swapfile.sys',
  'bootmgr',
  'bootnxt',
  'ntldr',
  'ntdetect.com',
  'bootsect.bak',
  'autorun.inf',
  'io.sys',
  'msdos.sys',
  'config.msi',
  '$mft',
  '$logfile',
]);

/** 绝对不进扫描/整理的目录（回收站、卷影副本、版本库等） */
const SYSTEM_DIR_NAMES = new Set([
  '$recycle.bin',
  'system volume information',
  'recovery',
  '$windows.~bt',
  '$windows.~ws',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'appdata',
]);

/**
 * 前缀形式的系统文件（ntuser.dat / ntuser.dat.log1 / Office 的 ~$ 锁文件 …）。
 * `~$` 开头是 Office 打开文档时生成的锁文件，正主一关就自动消失。
 * 这类文件正被占用、根本搬不动，搬了还会让 Word 报错，所以必须硬拦。
 * DEFAULT_EXCLUDES 里虽然也有 `~$*`，但那条用户能删，这条删不掉——两道闸都得在。
 */
const SYSTEM_PREFIXES = ['ntuser.', 'bootstat.dat', '$windows.~', '~$'];

/** 云盘同步目录的常见名字，用于「避免打乱云盘同步」的提示与可选跳过 */
const CLOUD_DIR_HINTS = [
  'onedrive',
  'dropbox',
  'nutstore',
  '坚果云',
  'baidunetdisk',
  '百度网盘',
  'aliyunpan',
  '阿里云盘',
  'aliyundrive',
  'icloud drive',
  'iclouddrive',
  'googledrive',
  'google drive',
  'weiyun',
  '微云',
  '天翼云盘',
  '189cloud',
];

/** 设置页「一键加入」推荐的默认条目 */
const DEFAULT_EXCLUDES = Object.freeze([
  { value: '*.tmp', kind: 'glob' },
  { value: '*.log', kind: 'glob' },
  { value: '~$*', kind: 'glob' },
  { value: 'node_modules', kind: 'name' },
  { value: '.git', kind: 'name' },
]);

/**
 * 是否是系统文件/目录（硬保护，用户改不掉）。
 * @param {string} name 单段文件名
 */
function isSystemEntry(name) {
  const lower = String(name || '').toLowerCase();
  if (!lower) return false;
  if (SYSTEM_NAMES.has(lower)) return true;
  if (SYSTEM_DIR_NAMES.has(lower)) return true;
  return SYSTEM_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** 是否是云盘同步目录名 */
function isCloudDirName(name) {
  const lower = String(name || '').toLowerCase();
  return CLOUD_DIR_HINTS.some((hint) => lower === hint || lower.includes(hint));
}

/**
 * 通配符转正则：只支持 `*`（任意多字符）与 `?`（单字符），足够覆盖日常需求，
 * 也比完整 glob 更好解释——用户不需要记语法。
 * @param {string} pattern
 */
function globToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '\u0000')
    .replace(/\?/g, '\u0001')
    .replace(/\u0000/g, '.*')
    .replace(/\u0001/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/** 编译排除名单，正则/通配只编译一次 */
function compileExcludes(excludes) {
  if (!Array.isArray(excludes)) return [];
  const out = [];
  for (const item of excludes) {
    if (!item || item.enabled === false) continue;
    const value = String(item.value || '').trim();
    if (!value) continue;
    if (item.kind === 'glob') {
      out.push({ kind: 'glob', value, regex: globToRegExp(value) });
    } else if (item.kind === 'path') {
      out.push({ kind: 'path', value: value.replace(/\//g, '\\').toLowerCase() });
    } else {
      out.push({ kind: item.kind || 'contains', value: value.toLowerCase() });
    }
  }
  return out;
}

/**
 * 判断一个条目是否被排除。
 *
 * @param {{name:string, fullPath?:string}} entry
 * @param {Array} compiled compileExcludes 的产物
 * @returns {{excluded:boolean, reason?:string}}
 */
function checkExclude(entry, compiled) {
  const name = String(entry.name || '');
  const lower = name.toLowerCase();
  const full = String(entry.fullPath || '').replace(/\//g, '\\').toLowerCase();

  if (isSystemEntry(lower)) return { excluded: true, reason: '系统文件' };

  for (const rule of compiled || []) {
    if (rule.kind === 'glob') {
      if (rule.regex.test(name)) return { excluded: true, reason: `排除名单（${rule.value}）` };
    } else if (rule.kind === 'path') {
      // 路径排除对「文件本身」和「它的任一上级目录」都生效
      if (full && (full === rule.value || full.startsWith(`${rule.value}\\`))) {
        return { excluded: true, reason: `排除目录（${rule.value}）` };
      }
      // 也允许只写目录名，命中当前文件所在目录
      const parent = full ? path.dirname(full) : '';
      if (parent && parent.split('\\').includes(rule.value)) {
        return { excluded: true, reason: `排除目录（${rule.value}）` };
      }
    } else if (rule.kind === 'name') {
      if (lower === rule.value) return { excluded: true, reason: `排除名单（${rule.value}）` };
    } else if (lower.includes(rule.value)) {
      return { excluded: true, reason: `排除名单（${rule.value}）` };
    }
  }
  return { excluded: false };
}

/** 目录本身的排除判断（监听、定时任务扫描时用） */
function isExcludedDir(dirPath, compiled) {
  const name = path.basename(String(dirPath || ''));
  const lower = name.toLowerCase();
  if (SYSTEM_DIR_NAMES.has(lower)) return true;
  const check = checkExclude({ name, fullPath: dirPath }, compiled);
  return check.excluded;
}

module.exports = {
  SYSTEM_NAMES,
  SYSTEM_DIR_NAMES,
  CLOUD_DIR_HINTS,
  DEFAULT_EXCLUDES,
  isSystemEntry,
  isCloudDirName,
  globToRegExp,
  compileExcludes,
  checkExclude,
  isExcludedDir,
};
