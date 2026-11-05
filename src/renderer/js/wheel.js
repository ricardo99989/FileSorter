/**
 * wheel.js — 分类轮盘
 *
 * 为什么用「粗描边圆弧」而不是「扇形 path」：
 * 圆角扇形要在四个角上做贝塞尔内缩，窄扇区上极易算错；换成
 * `stroke` + `stroke-linecap: round` 之后，圆角是浏览器画的、永远是正圆角，
 * 弧宽就是扇区宽度，一个 `stroke-width` 就够。
 * 代价是只能做环带（做不出实心扇形），但环带正是参考图里"分段进度环"的样子。
 *
 * 扇区之间留 3° 空隙，空隙露出背景色，天然形成分割线，不用额外描边。
 */

import { icon } from './icons.js';
import { formatSize } from './format.js';

/**
 * 六个分桶。用户给的是「图片/视频/文档/音频/其他」，
 * 这里多拆一个「文件夹」——因为项目目录里文件夹常常占一半以上，
 * 把它们塞进「其他」会让那一段吃掉大半个环，失去意义。
 */
export const WHEEL_BUCKETS = [
  { key: 'dir', label: '文件夹', icon: 'folder', tone: 'violet', match: (e) => e.isDir },
  {
    key: 'image',
    label: '图片',
    icon: 'image',
    tone: 'amber',
    match: (e) => e.desc?.category === 'image' || e.desc?.category === 'design',
  },
  {
    key: 'video',
    label: '视频',
    icon: 'video',
    tone: 'blue',
    match: (e) => e.desc?.category === 'video' || e.desc?.category === 'model',
  },
  {
    key: 'doc',
    label: '文档',
    icon: 'doc',
    tone: 'rose',
    match: (e) => ['doc', 'sheet', 'slide'].includes(e.desc?.category),
  },
  { key: 'audio', label: '音频', icon: 'audio', tone: 'sage', match: (e) => e.desc?.category === 'audio' },
  { key: 'other', label: '其他', icon: 'file', tone: 'slate', match: () => true },
];

/** 某个条目落在哪个桶（顺序即优先级，other 的 match 永远为真兜底） */
export function bucketOf(entry) {
  return WHEEL_BUCKETS.find((bucket) => bucket.match(entry)) || WHEEL_BUCKETS[WHEEL_BUCKETS.length - 1];
}

/**
 * 环的几何参数，JS 与 CSS 必须一致，所以集中在这里由 JS 输出到 SVG 上。
 *
 * gap 为什么是 14° 而不是 3°：圆头端点会往外各延伸半个描边宽，
 * 折成角度就是 width/r ≈ 12°。gap 小于它，两个扇区的圆头就会咬在一起、
 * 分隔线彻底消失（第一次就是这么翻车的）。14° 才留得下约 2° 的真空隙。
 */
const GEO = { box: 176, cx: 88, cy: 88, r: 62, width: 14, gap: 15 };

/** 极角转笛卡尔；-90 是为了让第一个扇区从 12 点方向开始 */
function pointOn(angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: GEO.cx + GEO.r * Math.cos(rad),
    y: GEO.cy + GEO.r * Math.sin(rad),
  };
}

/**
 * 把条目折算成轮盘模型。
 * 只统计非空桶；空桶不占角度，否则点进去是空的。
 */
export function computeWheel(entries = []) {
  const acc = new Map(
    WHEEL_BUCKETS.map((bucket) => [bucket.key, { ...bucket, count: 0, size: 0 }]),
  );

  for (const entry of entries) {
    const bucket = bucketOf(entry);
    const slot = acc.get(bucket.key);
    slot.count += 1;
    if (!entry.isDir) slot.size += entry.size || 0;
  }

  const buckets = [...acc.values()].filter((bucket) => bucket.count > 0);
  const total = entries.length;
  const totalSize = entries.reduce((sum, entry) => sum + (entry.isDir ? 0 : entry.size || 0), 0);

  // 角度按占比累加，最后一个扇区直接顶到 360，避免浮点误差留下一条缝
  let cursor = 0;
  buckets.forEach((bucket, index) => {
    bucket.share = total > 0 ? bucket.count / total : 0;
    bucket.start = cursor;
    bucket.end = index === buckets.length - 1 ? 360 : cursor + bucket.share * 360;
    cursor = bucket.end;
  });

  return { buckets, total, totalSize };
}

/** 单个扇区的 path。整圆（只有一个桶）没有起止点，得用 circle */
function segmentPath(bucket, index, count, activeKey) {
  const solo = count === 1;
  let start = solo ? 0 : bucket.start + GEO.gap / 2;
  let end = solo ? 360 : bucket.end - GEO.gap / 2;

  /**
   * 占比很小的分类（本例里 2% 只有 7.2°）被 15° 的空隙一减就变成负数，
   * 负跨度会让 A 命令反向画弧，直接把整个圆涂满——必须兜住。
   * 退化成 1.5° 的短弧，靠圆头端点画成一个圆点：位置还在，大小不再代表占比。
   */
  if (!solo && end - start < 1.5) {
    const mid = (bucket.start + bucket.end) / 2;
    start = mid - 0.75;
    end = mid + 0.75;
  }

  const span = end - start;
  const large = span > 180 ? 1 : 0;
  const a = pointOn(start);
  const b = pointOn(end);

  // 弧长决定要不要在弧上写数字：太短写了会溢出，比不写更难看
  const arcLen = (span / 360) * 2 * Math.PI * GEO.r;
  const showCount = arcLen >= 16;

  const mid = (start + end) / 2;
  const at = pointOn(mid);

  const baseStyle = `stroke:var(--tone-${bucket.tone})`;
  const active = bucket.key === activeKey ? ' is-active' : '';

  const arc = solo
    ? `<circle class="wheel__seg${active}" data-bucket="${bucket.key}" data-index="${index}"
         cx="${GEO.cx}" cy="${GEO.cy}" r="${GEO.r}" fill="none" style="${baseStyle}"
         stroke-width="${GEO.width}"></circle>`
    : `<path class="wheel__seg${active}" data-bucket="${bucket.key}" data-index="${index}"
         d="M${a.x.toFixed(2)} ${a.y.toFixed(2)}A${GEO.r} ${GEO.r} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}"
         fill="none" style="${baseStyle}" stroke-width="${GEO.width}"
         stroke-linecap="round"></path>`;

  const label = showCount
    ? `<text class="wheel__num" x="${at.x.toFixed(2)}" y="${(at.y + 3.4).toFixed(2)}">${bucket.count}</text>`
    : '';

  return arc + label;
}

/**
 * 轮盘主体 SVG。
 * activeKey 命中的扇区保持高亮，用来表达"当前正在按这个分类过滤"。
 */
export function wheelSvg(model, activeKey = '') {
  const parts = model.buckets.map((bucket, index) =>
    segmentPath(bucket, index, model.buckets.length, activeKey),
  );

  return `<svg class="wheel__svg" viewBox="0 0 ${GEO.box} ${GEO.box}" role="img" aria-label="分类占比">
    <circle class="wheel__track" cx="${GEO.cx}" cy="${GEO.cy}" r="${GEO.r}" fill="none" stroke-width="${GEO.width}"></circle>
    <circle class="wheel__ticks" cx="${GEO.cx}" cy="${GEO.cy}" r="${GEO.r + 13}" fill="none"></circle>
    ${parts.join('')}
  </svg>`;
}

/** 图例：每个分类一行，hover 与扇区联动，点击等价于点扇区 */
export function legendHtml(model, activeKey = '') {
  return model.buckets
    .map(
      (bucket, index) => `<button class="wheel-legend__row${bucket.key === activeKey ? ' is-active' : ''}"
        type="button" data-bucket="${bucket.key}" data-index="${index}">
        <span class="wheel-legend__dot" style="background:var(--tone-${bucket.tone})"></span>
        <span class="wheel-legend__label">${bucket.label}</span>
        <span class="wheel-legend__count">${bucket.count}</span>
        <span class="wheel-legend__pct">${Math.round(bucket.share * 100)}%</span>
      </button>`,
    )
    .join('');
}

/** 中心区默认显示：总项数 + 总大小 */
export function centerIdleHtml(model) {
  return `<span class="wheel__center-num">${model.total}</span>
    <span class="wheel__center-cap">项 · ${formatSize(model.totalSize)}</span>`;
}

/** 中心区悬停显示：分类名 + 数量 + 体积 */
export function centerHoverHtml(bucket) {
  if (!bucket) return '';
  return `<span class="wheel__center-ico">${icon(bucket.icon, 15)}</span>
    <span class="wheel__center-name">${bucket.label}</span>
    <span class="wheel__center-num wheel__center-num--sm">${bucket.count}</span>
    <span class="wheel__center-cap">${formatSize(bucket.size)}</span>`;
}

export { GEO };
