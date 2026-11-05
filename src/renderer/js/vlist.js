/**
 * vlist.js — 虚拟滚动
 *
 * 只渲染可视区 + overscan 的行，行节点按索引复用：
 * - 复用而不是重建，滑动时图片缩略图不会反复重新解码；
 * - 位置用 transform 而不是 top，避免每帧触发重排；
 * - 滚动事件合并到一帧里执行，滚动过程中最多一次布局读取。
 */
export class VirtualList {
  /**
   * @param {object} options
   * @param {HTMLElement} options.viewport 滚动容器
   * @param {HTMLElement} options.content 撑高度的内层
   * @param {() => number} options.rowHeight 当前行高
   * @param {() => number} options.rowCount 当前行数
   * @param {(index: number, node: HTMLElement) => void} options.renderRow
   * @param {() => HTMLElement} [options.createRow]
   * @param {number} [options.overscan]
   */
  constructor(options) {
    this.viewport = options.viewport;
    this.content = options.content;
    this.rowHeight = options.rowHeight;
    this.rowCount = options.rowCount;
    this.renderRow = options.renderRow;
    this.overscan = options.overscan ?? 5;
    this.createRow =
      options.createRow ||
      (() => {
        const node = document.createElement('div');
        node.className = 'vrow';
        return node;
      });

    /** @type {Map<number, HTMLElement>} */
    this.nodes = new Map();
    this.frame = 0;
    this.lastRange = [0, 0];

    this.onScroll = () => this.schedule();
    this.viewport.addEventListener('scroll', this.onScroll, { passive: true });

    this.resizeObserver = new ResizeObserver(() => this.schedule());
    this.resizeObserver.observe(this.viewport);
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.update();
    });
  }

  /** 数据或行高变化后调用：清理全部节点并重绘 */
  refresh() {
    for (const node of this.nodes.values()) node.remove();
    this.nodes.clear();
    this.lastRange = [0, 0];
    this.update();
  }

  /** 回到顶部并重绘（切换目录时用） */
  reset() {
    this.viewport.scrollTop = 0;
    this.refresh();
  }

  /** 仅重绘某一行（选中态变化时用，避免整屏重建） */
  refreshIndex(index) {
    const node = this.nodes.get(index);
    if (node) this.renderRow(index, node);
  }

  /** 把某一行滚动到可视范围 */
  scrollToIndex(index, align = 'auto') {
    const height = this.rowHeight();
    const top = index * height;
    const viewTop = this.viewport.scrollTop;
    const viewBottom = viewTop + this.viewport.clientHeight;
    if (top >= viewTop && top + height <= viewBottom) return;

    let next = top;
    if (align === 'center') next = top - (this.viewport.clientHeight - height) / 2;
    else if (align === 'nearest' && top < viewTop) next = top;
    else if (align === 'nearest') next = top + height - this.viewport.clientHeight;
    this.viewport.scrollTop = Math.max(0, next);
    this.update();
  }

  update() {
    const height = Math.max(1, this.rowHeight());
    const count = Math.max(0, this.rowCount());
    const totalHeight = count * height;

    this.content.style.height = `${totalHeight}px`;

    if (!count) {
      for (const node of this.nodes.values()) node.remove();
      this.nodes.clear();
      return;
    }

    const scrollTop = this.viewport.scrollTop;
    const viewHeight = this.viewport.clientHeight;
    const start = Math.max(0, Math.floor(scrollTop / height) - this.overscan);
    const end = Math.min(count, Math.ceil((scrollTop + viewHeight) / height) + this.overscan);

    // 先删掉离屏节点，再补新节点，顺序影响 GC 压力
    for (const [index, node] of this.nodes) {
      if (index < start || index >= end) {
        node.remove();
        this.nodes.delete(index);
      }
    }

    const fragment = document.createDocumentFragment();
    for (let index = start; index < end; index += 1) {
      let node = this.nodes.get(index);
      if (!node) {
        node = this.createRow();
        node.style.position = 'absolute';
        node.style.left = '0';
        node.style.right = '0';
        node.style.height = `${height}px`;
        node.dataset.index = String(index);
        this.nodes.set(index, node);
        fragment.appendChild(node);
      }
      const offset = index * height;
      node.style.transform = `translateY(${offset}px)`;
      this.renderRow(index, node);
    }

    if (fragment.childNodes.length) this.content.appendChild(fragment);
    this.lastRange = [start, end];
  }

  destroy() {
    this.viewport.removeEventListener('scroll', this.onScroll);
    this.resizeObserver.disconnect();
    if (this.frame) cancelAnimationFrame(this.frame);
    for (const node of this.nodes.values()) node.remove();
    this.nodes.clear();
  }
}
