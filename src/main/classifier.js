'use strict';

/**
 * 分类规则的唯一数据源（single source of truth）。
 *
 * 渲染进程不复制这张表：分类名称、图标、扩展名全部经 IPC 下发，
 * 保证「设置里改名」和「整理时归类」用的是同一份定义，不会漂移。
 */

/** @type {ReadonlyArray<{id:string,name:string,icon:string,tone:string,extensions:string[]}>} */
const CATEGORY_DEFS = Object.freeze([
  {
    id: 'image',
    name: '图片',
    icon: 'image',
    tone: 'blue',
    extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tif', 'tiff', 'heic', 'heif', 'avif', 'raw', 'psd'],
  },
  {
    id: 'video',
    name: '视频',
    icon: 'video',
    tone: 'clay',
    extensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts', 'rmvb', '3gp'],
  },
  {
    id: 'document',
    name: '文档',
    icon: 'doc',
    tone: 'sage',
    extensions: ['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'odt', 'ods', 'odp', 'epub', 'mobi', 'pages', 'numbers', 'key'],
  },
  {
    id: 'audio',
    name: '音频',
    icon: 'audio',
    tone: 'lilac',
    extensions: ['mp3', 'flac', 'wav', 'aac', 'ogg', 'm4a', 'wma', 'ape', 'opus', 'aiff', 'amr'],
  },
  {
    id: 'archive',
    name: '压缩包',
    icon: 'archive',
    tone: 'sand',
    extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'cab', 'tgz', 'zst'],
  },
  {
    id: 'program',
    name: '程序',
    icon: 'app',
    tone: 'steel',
    extensions: ['exe', 'msi', 'bat', 'cmd', 'com', 'apk', 'appx', 'msix', 'dmg', 'pkg', 'deb', 'rpm', 'jar'],
  },
  {
    id: 'code',
    name: '代码',
    icon: 'code',
    tone: 'mint',
    extensions: [
      'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'cpp', 'cc', 'c', 'h', 'hpp', 'cs', 'java', 'kt', 'go', 'rs',
      'rb', 'php', 'swift', 'html', 'htm', 'css', 'scss', 'less', 'json', 'xml', 'yml', 'yaml', 'toml', 'ini',
      'sh', 'ps1', 'sql', 'vue', 'svelte', 'lua', 'dart',
    ],
  },
]);

/** 兜底分类：没有扩展名或扩展名不在上表内 */
const OTHER_DEF = Object.freeze({
  id: 'other',
  name: '其他',
  icon: 'file',
  tone: 'gray',
  extensions: Object.freeze([]),
});

/** @type {Map<string, string>} 扩展名 → 分类 id，O(1) 查表 */
const EXT_TO_CATEGORY = new Map();
for (const def of CATEGORY_DEFS) {
  for (const ext of def.extensions) {
    EXT_TO_CATEGORY.set(ext, def.id);
  }
}

/** Windows 文件名非法字符 */
const INVALID_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
/** Windows 保留设备名，建同名文件夹会失败 */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);
/** 仍在写入的临时文件，移动它们会得到半截文件 */
const TEMP_SUFFIXES = ['.part', '.crdownload', '.download', '.tmp', '.temp', '.opdownload', '.aria2', '.!ut'];

/**
 * 取小写扩展名（不含点）。多段后缀（a.tar.gz）只取最后一段。
 * @param {string} fileName
 * @returns {string}
 */
function extOf(fileName) {
  const base = String(fileName || '');
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * 把文件名归入分类。
 * @param {string} fileName
 * @returns {{id:string,name:string,icon:string,tone:string}}
 */
function classify(fileName) {
  const id = EXT_TO_CATEGORY.get(extOf(fileName));
  if (!id) return { ...OTHER_DEF };
  const def = CATEGORY_DEFS.find((d) => d.id === id);
  return { id: def.id, name: def.name, icon: def.icon, tone: def.tone };
}

/**
 * 生成带用户自定义名称的完整分类列表（设置页与侧边栏都用它）。
 * @param {Record<string,string>} [customNames] 分类 id → 自定义文件夹名
 */
function resolveCategories(customNames = {}) {
  return [...CATEGORY_DEFS, OTHER_DEF].map((def) => {
    const custom = customNames[def.id];
    return {
      id: def.id,
      name: custom && String(custom).trim() ? String(custom).trim() : def.name,
      defaultName: def.name,
      icon: def.icon,
      tone: def.tone,
      extensions: [...def.extensions],
    };
  });
}

/**
 * 清洗用户输入的文件夹名，处理非法字符、保留字、尾部点与空格。
 * 清洗后为空则回退到默认名。
 * @param {string} raw
 * @param {string} fallback
 * @returns {string}
 */
function sanitizeFolderName(raw, fallback) {
  let name = String(raw == null ? '' : raw).replace(INVALID_NAME_CHARS, '').trim();
  name = name.replace(/[.\s]+$/, '');
  if (!name) return fallback;
  if (RESERVED_NAMES.has(name.toLowerCase())) return `${name}_`;
  return name.slice(0, 60);
}

/**
 * 点开头的文件视为隐藏；Windows 的隐藏属性 Node 读不到，只按命名约定判断。
 * @param {string} name
 */
function isHidden(name) {
  return String(name).startsWith('.');
}

/**
 * 是否为下载中/临时文件。
 * @param {string} name
 */
function isTempName(name) {
  const lower = String(name).toLowerCase();
  if (lower.startsWith('~$')) return true;
  return TEMP_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

module.exports = {
  CATEGORY_DEFS,
  OTHER_DEF,
  EXT_TO_CATEGORY,
  extOf,
  classify,
  resolveCategories,
  sanitizeFolderName,
  isHidden,
  isTempName,
};
