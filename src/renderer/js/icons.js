/**
 * icons.js — 内联 SVG 图标
 *
 * 统一 24×24 视框、1.7 描边、圆头圆角。
 * 图标本身是单色的，颜色由父元素的 currentColor 决定 ——
 * 分类色通过 .file-ico[data-tone] 的背景/前景一组变量控制，
 * 这样同一个图标在深色/浅色下都不用改。
 */

const PATHS = {
  folder:
    '<path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h3.6c.6 0 1.2.24 1.6.68l1.1 1.1c.2.2.47.32.75.32H18a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18 19.1H6a2.5 2.5 0 0 1-2.5-2.5z" />',
  image:
    '<rect x="3.5" y="5" width="17" height="14" rx="2.6" /><circle cx="9" cy="10" r="1.5" /><path d="M4.6 17.2l4.2-4a2 2 0 0 1 2.8 0l2.1 2 1.3-1.2a2 2 0 0 1 2.7 0l1.7 1.6" />',
  video:
    '<rect x="3" y="6" width="12.5" height="12" rx="2.4" /><path d="M15.5 10.4l4-2.2a.8.8 0 0 1 1.2.7v6.2a.8.8 0 0 1-1.2.7l-4-2.2z" />',
  audio:
    '<path d="M9 17.5V8.2l9-1.7v9" /><circle cx="6.6" cy="18" r="2.4" /><circle cx="15.6" cy="16.4" r="2.4" />',
  doc:
    '<path d="M6 4.5h7.2L18 9.3V19a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V6A1.5 1.5 0 0 1 6 4.5z" /><path d="M13 4.8V9a.8.8 0 0 0 .8.8h4" /><path d="M8 13h6M8 16.4h4.5" />',
  sheet:
    '<rect x="4" y="4.5" width="16" height="15" rx="2.2" /><path d="M4 9.5h16M4 14.5h16M9.5 9.5v10M15 9.5v10" />',
  slide:
    '<rect x="3.5" y="4.5" width="17" height="11" rx="2" /><path d="M12 15.5V20M8.4 20h7.2" /><path d="M8 9.2h5.5" />',
  code:
    '<path d="M8.6 8.2L4.5 12l4.1 3.8M15.4 8.2L19.5 12l-4.1 3.8" /><path d="M13.4 6.4l-2.8 11.2" />',
  archive:
    '<rect x="4" y="4.5" width="16" height="15" rx="2" /><path d="M4 9h16" /><path d="M11 4.5v4.5M13 9v4.5" />',
  app:
    '<rect x="3.5" y="3.5" width="17" height="17" rx="3.6" /><path d="M8.4 8.4h7.2v7.2H8.4z" /><path d="M12 3.8v4.4M12 15.8v4.4M3.8 12h4.4M15.8 12h4.4" />',
  font:
    '<path d="M6 19l5.2-13.5h1.6L18 19" /><path d="M8.7 14.2h6.6" />',
  data:
    '<ellipse cx="12" cy="6.6" rx="6.8" ry="2.8" /><path d="M5.2 6.6v10.8c0 1.55 3.04 2.8 6.8 2.8s6.8-1.25 6.8-2.8V6.6" /><path d="M5.2 12c0 1.55 3.04 2.8 6.8 2.8s6.8-1.25 6.8-2.8" />',
  design:
    '<path d="M12 3.6l8.4 8.4-8.4 8.4L3.6 12z" /><circle cx="12" cy="12" r="2.6" />',
  model:
    '<path d="M12 3.6l7.4 4.2v8.4L12 20.4 4.6 16.2V7.8z" /><path d="M4.9 7.9L12 12l7.1-4.1M12 12v8" />',
  file:
    '<path d="M6 4.5h7.2L18 9.3V19a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V6A1.5 1.5 0 0 1 6 4.5z" /><path d="M13 4.8V9a.8.8 0 0 0 .8.8h4" />',
  home:
    '<path d="M4 10.6L12 4l8 6.6V19a1.4 1.4 0 0 1-1.4 1.4h-4.2v-5.6H9.6v5.6H5.4A1.4 1.4 0 0 1 4 19z" />',
  desktop:
    '<rect x="3.4" y="4.6" width="17.2" height="11.6" rx="2" /><path d="M9 20h6M12 16.2V20" />',
  download:
    '<path d="M12 4v10.4M8 11l4 3.6 4-3.6" /><path d="M4.6 17.6V19a1.4 1.4 0 0 0 1.4 1.4h12a1.4 1.4 0 0 0 1.4-1.4v-1.4" />',
  drive:
    '<rect x="3.4" y="5" width="17.2" height="6.4" rx="2" /><rect x="3.4" y="12.6" width="17.2" height="6.4" rx="2" /><path d="M7 8.2h.01M7 15.8h.01" />',
  lock:
    '<rect x="4.8" y="10.2" width="14.4" height="10" rx="2.4" /><path d="M8.2 10.2V8a3.8 3.8 0 0 1 7.6 0v2.2" />',
  alert:
    '<path d="M12 4.6l8.2 14.2H3.8z" /><path d="M12 9.8v4.2M12 16.6h.01" />',
  search:
    '<circle cx="11" cy="11" r="6.4" /><path d="M16 16l4.2 4.2" />',
  sparkle:
    '<path d="M12 4l1.9 5.1L19 11l-5.1 1.9L12 18l-1.9-5.1L5 11l5.1-1.9z" /><path d="M18.4 4.2l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z" />',
  open:
    '<path d="M14 4.5h5.5V10" /><path d="M19.5 4.5L11 13" /><path d="M18 14.4V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.6" />',
  locate:
    '<path d="M4 9.2V6.4A2.4 2.4 0 0 1 6.4 4h2.8M15 4h2.6A2.4 2.4 0 0 1 20 6.4v2.8M20 15v2.6a2.4 2.4 0 0 1-2.4 2.4H15M9 20H6.4A2.4 2.4 0 0 1 4 17.6V15" /><circle cx="12" cy="12" r="2.6" />',
  copy:
    '<rect x="8.5" y="8.5" width="11" height="11" rx="2.2" /><path d="M15.5 8.5V6.4A1.9 1.9 0 0 0 13.6 4.5H6.4A1.9 1.9 0 0 0 4.5 6.4v7.2a1.9 1.9 0 0 0 1.9 1.9h2.1" />',
  check:
    '<path d="M5 12.6l4.4 4.2L19 7" />',
  close:
    '<path d="M6 6l12 12M18 6L6 18" />',
  undo:
    '<path d="M9 8H5V4" /><path d="M5.4 8A8 8 0 1 1 5 15.4" />',
  redo:
    '<path d="M15 8h4V4" /><path d="M18.6 8A8 8 0 1 0 19 15.4" />',
  sun:
    '<circle cx="12" cy="12" r="4" /><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />',
  moon:
    '<path d="M20 13.4A8.2 8.2 0 0 1 10.6 4a8.4 8.4 0 1 0 9.4 9.4z" />',
  monitor:
    '<rect x="3.4" y="4.6" width="17.2" height="11.6" rx="2" /><path d="M9 20h6M12 16.2V20" />',
  info:
    '<circle cx="12" cy="12" r="8.4" /><path d="M12 11v5.2M12 8h.01" />',
  gear:
    '<circle cx="12" cy="12" r="3" /><path d="M12 3.4v2.2M12 18.4v2.2M3.4 12h2.2M18.4 12h2.2M5.9 5.9l1.6 1.6M16.5 16.5l1.6 1.6M18.1 5.9l-1.6 1.6M7.5 16.5l-1.6 1.6" />',
  sort:
    '<path d="M12 5v14M8 15l4 4 4-4" />',
  'sort-down':
    '<path d="M12 19V5M8 9l4-4 4 4" />',
  chevron: '<path d="M9.5 6l6 6-6 6" />',
  more:
    '<circle cx="5.6" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="18.4" cy="12" r="1.3" fill="currentColor" stroke="none" />',
  filter:
    '<path d="M4 5.5h16l-6.4 7.6v5.4l-3.2 1.6v-7z" />',
  refresh:
    '<path d="M20 11a8 8 0 1 0-2.6 6" /><path d="M20 5v6h-6" />',
  dupe:
    '<rect x="4" y="4" width="11" height="11" rx="2.4" /><path d="M9 20h9a2 2 0 0 0 2-2V9" />',
  pie:
    '<path d="M12 3.6a8.4 8.4 0 1 0 8.4 8.4H12z" /><path d="M12 3.6V12h8.4A8.4 8.4 0 0 0 12 3.6z" />',
  rename:
    '<path d="M4 8h16M4 16h16" /><path d="M9.5 4v4M14.5 12v4" />',
  history:
    '<path d="M3.6 12a8.4 8.4 0 1 0 2.4-5.9" /><path d="M3.6 5.2V9h3.8" /><path d="M12 8v4.4l3 1.8" />',
  tag:
    '<path d="M4 10.4V5.6A1.6 1.6 0 0 1 5.6 4h4.8c.42 0 .82.17 1.12.47l7.9 7.9a1.6 1.6 0 0 1 0 2.26l-5.74 5.74a1.6 1.6 0 0 1-2.26 0l-7.9-7.9A1.6 1.6 0 0 1 4 10.4z" /><circle cx="8.6" cy="8.6" r="1.5" />',
  plus: '<path d="M12 5.5v13M5.5 12h13" />',
  minus: '<path d="M5.5 12h13" />',
  trash:
    '<path d="M4.5 7h15" /><path d="M9.5 7V5.4A1.4 1.4 0 0 1 10.9 4h2.2a1.4 1.4 0 0 1 1.4 1.4V7" /><path d="M6.5 7l.8 11.2A1.9 1.9 0 0 0 9.2 20h5.6a1.9 1.9 0 0 0 1.9-1.8L17.5 7" /><path d="M10.5 11v5M13.5 11v5" />',
  eye:
    '<path d="M2.8 12S6 6.4 12 6.4 21.2 12 21.2 12 18 17.6 12 17.6 2.8 12 2.8 12z" /><circle cx="12" cy="12" r="2.6" />',
  plugin:
    '<path d="M9 4.5v3M15 4.5v3" /><path d="M6.5 7.5h11a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18V9a1.5 1.5 0 0 1 1.5-1.5z" /><path d="M9.5 12.5h5" />',
  globe:
    '<circle cx="12" cy="12" r="8.4" /><path d="M3.8 12h16.4" /><path d="M12 3.6c2.2 2.3 3.3 5.2 3.3 8.4S14.2 18.1 12 20.4c-2.2-2.3-3.3-5.2-3.3-8.4S9.8 5.9 12 3.6z" />',
  window:
    '<rect x="3.6" y="4.6" width="16.8" height="14.8" rx="2.4" /><path d="M3.6 8.6h16.8" />',
  sidebar:
    '<rect x="3.6" y="4.6" width="16.8" height="14.8" rx="2.4" /><path d="M9.6 4.6v14.8" />',
  dock:
    '<rect x="3.6" y="9" width="16.8" height="10.4" rx="2.4" /><path d="M7 6h10" />',
  ring:
    '<circle cx="12" cy="12" r="8.4" /><path d="M12 7.6V12l3 1.8" />',
  layer:
    '<path d="M12 3.8l8 4.2-8 4.2-8-4.2z" /><path d="M4 12.4l8 4.2 8-4.2" /><path d="M4 16.4l8 4.2 8-4.2" />',
};

/** 生成一个内联 SVG 字符串 */
export function icon(name, size = 16, extraClass = '') {
  const body = PATHS[name] || PATHS.file;
  return `<svg class="${extraClass}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/**
 * 分类 → 图标 + 色调。
 *
 * 这里有两层分类：整理用的八大类（图片/视频/文档/音频/压缩包/程序/代码/其他，见主进程
 * classifier.js），和「智能说明」里的细分类型（doc/sheet/slide/design/data…）。
 * 图标形状可以细分，但**颜色必须跟整理分类走** —— 否则同一个 pptx，图标是浅灰青、
 * 整理时却进了「文档」文件夹，用户看到两套颜色会犯嘀咕。
 *
 * 因此色调统一到四档灰：图片/设计稿=浅灰蓝，视频/3D=浅灰紫，文档三件套=浅灰青，
 * 其余全部中性灰。原先七种褪色印刷色（琥珀/玫/鼠尾草/青…）全部撤掉 ——
 * 界面只允许两个主色，图标再占七个色相，整体就花了。
 */
export const CATEGORY_META = {
  folder: { icon: 'folder', tone: 'slate' },
  image: { icon: 'image', tone: 'blue' },
  design: { icon: 'design', tone: 'blue' },
  video: { icon: 'video', tone: 'violet' },
  model: { icon: 'model', tone: 'violet' },
  audio: { icon: 'audio', tone: 'slate' },
  doc: { icon: 'doc', tone: 'teal' },
  sheet: { icon: 'sheet', tone: 'teal' },
  slide: { icon: 'slide', tone: 'teal' },
  code: { icon: 'code', tone: 'slate' },
  data: { icon: 'data', tone: 'slate' },
  archive: { icon: 'archive', tone: 'slate' },
  font: { icon: 'font', tone: 'slate' },
  app: { icon: 'app', tone: 'slate' },
  other: { icon: 'file', tone: 'slate' },
};

export function categoryIcon(category) {
  return (CATEGORY_META[category] || CATEGORY_META.other).icon;
}

export function categoryTone(category) {
  return (CATEGORY_META[category] || CATEGORY_META.other).tone;
}

export { PATHS };
