/**
 * motion.js — 动效引擎
 *
 * 12 条动画原则在这里逐条落地，每个方法都标注了对应原则编号，
 * 方便后续维护时知道「改这个会影响哪条原则」。
 *
 *   1  Squash & Stretch   形变表达重量             squash()
 *   2  Anticipation       动作前的预备             anticipate()
 *   3  Staging            聚焦主体、弱化其余       stage()
 *   4  Pose to Pose       先定关键帧再补中间       poseToPose()
 *   5  Follow Through     主体停下、附属继续       followThrough()
 *   6  Slow in & Out      起止减速                 EASE.out
 *   7  Arcs               沿弧线而非直线           arcTo()
 *   8  Secondary Action   主动作之外的细节         pulse() / countUp()
 *   9  Timing             时长分级表达轻重         DUR
 *   10 Exaggeration       适度放大以增强可读       bump()
 *   11 Solid Drawing      2D 中体现体积与光源      lightFollow()
 *   12 Appeal             整体克制、统一           TOKENS / reveal()
 *
 * 所有方法在「系统要求减少动效」或用户把强度设为 off 时自动降级为瞬时完成。
 */

/** 原则 9：六档时长，重物慢、轻物快 */
export const DUR = Object.freeze({ 1: 80, 2: 120, 3: 180, 4: 240, 5: 320, 6: 420 });

/** 原则 6：起止各减速 */
export const EASE = Object.freeze({
  out: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
  inOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
  spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
});

const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

class MotionEngine {
  constructor() {
    this.level = 'full';
  }

  setLevel(level) {
    this.level = ['full', 'soft', 'off'].includes(level) ? level : 'full';
    document.body.dataset.motion = this.level;
  }

  /** 是否运行动效 */
  get enabled() {
    return this.level !== 'off' && !reduceQuery.matches;
  }

  /** soft 档位统一缩短 30%，并压低幅度 */
  get damping() {
    return this.level === 'soft' ? 0.7 : 1;
  }

  /**
   * 统一播放入口，关闭动效时返回一个已完成的空动画。
   * @param {Element} el
   * @param {Keyframe[]} frames
   * @param {KeyframeAnimationOptions} options
   */
  play(el, frames, options = {}) {
    if (!el) return { finished: Promise.resolve(), cancel() {} };
    if (!this.enabled) return { finished: Promise.resolve(), cancel() {} };
    const scaled = { ...options };
    if (typeof scaled.delay === 'number') scaled.delay *= this.damping;
    scaled.duration = Math.round((options.duration ?? DUR[4]) * this.damping);
    scaled.fill = options.fill ?? 'both';
    scaled.easing = options.easing ?? EASE.out;
    return el.animate(frames, scaled);
  }

  /* ---------------- 1. Squash & Stretch ---------------- */

  /** 落位时的挤压回弹：纵向压扁再恢复，制造重量感 */
  squash(el, strength = 1) {
    const s = 0.06 * strength * this.damping;
    return this.play(el, [
      { transform: 'scale(1, 1)' },
      { transform: `scale(${1 + s}, ${1 - s})` },
      { transform: 'scale(1, 1)' },
    ], { duration: DUR[3], easing: EASE.spring });
  }

  /* ---------------- 2. Anticipation ---------------- */

  /**
   * 预备动作：先轻微反向蓄力，再执行真正动作。
   * 例：点「预览整理」时按钮先下沉 1px，120ms 后才弹出抽屉。
   */
  async anticipate(el, execute, { dip = 1.5 } = {}) {
    if (!this.enabled) return execute();
    await this.play(el, [
      { transform: 'translateY(0)' },
      { transform: `translateY(${dip}px) scale(0.985)` },
    ], { duration: DUR[2], easing: EASE.out }).finished.catch(() => {});
    const result = execute();
    this.play(el, [{ transform: `translateY(${dip}px) scale(0.985)` }, { transform: 'none' }], {
      duration: DUR[3],
      easing: EASE.spring,
    });
    return result;
  }

  /* ---------------- 3. Staging ---------------- */

  /**
   * 舞台呈现：把无关元素压暗虚化，让注意力落在当前主体上。
   * @returns {() => void} 撤销函数
   */
  stage(container, keepEl) {
    if (!container) return () => {};
    const dimmed = [];
    for (const child of container.children) {
      if (child === keepEl) continue;
      child.classList.add('is-dim');
      dimmed.push(child);
    }
    return () => dimmed.forEach((el) => el.classList.remove('is-dim'));
  }

  /* ---------------- 4. Pose to Pose ---------------- */

  /** 关键帧过渡：显式给出起、中、落三帧，而不是让浏览器自由插值 */
  poseToPose(el, frames, options = {}) {
    return this.play(el, frames, { duration: DUR[5], ...options });
  }

  /* ---------------- 5. Follow Through ---------------- */

  /** 跟随运动：主体先到位，随后的元素延迟跟进，形成尾随感 */
  followThrough(nodes, { stagger = 40, offsetY = 8 } = {}) {
    return [...nodes].map((node, index) =>
      this.play(node, [
        { opacity: 0, transform: `translateY(${offsetY}px)` },
        { opacity: 1, transform: 'none' },
      ], { duration: DUR[4], delay: index * stagger * this.damping, easing: EASE.out }),
    );
  }

  /* ---------------- 7. Arcs ---------------- */

  /**
   * 弧线飞行：元素从自身位置沿二次贝塞尔弧线飞向目标，
   * 控制点抬高，轨迹自然下垂后收束，符合重力直觉。
   * @param {HTMLElement} el
   * @param {DOMRect} from 起始矩形（屏幕坐标）
   * @param {DOMRect} to 目标矩形
   */
  arcTo(el, from, to) {
    if (!this.enabled || !el) return { finished: Promise.resolve() };
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const distance = Math.hypot(dx, dy);
    const lift = Math.min(150, distance * 0.32) * this.damping;
    return this.play(el, [
      { transform: 'translate(0, 0) scale(1)', opacity: 1, offset: 0 },
      {
        transform: `translate(${dx * 0.55}px, ${dy * 0.55 - lift}px) scale(0.74) rotate(-4deg)`,
        opacity: 0.92,
        offset: 0.58,
      },
      { transform: `translate(${dx}px, ${dy}px) scale(0.28)`, opacity: 0, offset: 1 },
    ], { duration: DUR[6], easing: EASE.inOut });
  }

  /* ---------------- 8. Secondary Action ---------------- */

  /** 次要动作：目标处的图标在文件「落入」瞬间轻跳一下 */
  pulse(el) {
    return this.play(el, [
      { transform: 'scale(1)' },
      { transform: `scale(${1 + 0.14 * this.damping})` },
      { transform: 'scale(1)' },
    ], { duration: DUR[4], easing: EASE.spring });
  }

  /** 数字滚动，避免数值突变 */
  countUp(el, to, { duration = DUR[6], formatter = (v) => String(Math.round(v)) } = {}) {
    const target = Number(to) || 0;
    if (!this.enabled) {
      el.textContent = formatter(target);
      return;
    }
    const from = Number(String(el.dataset.value || 0)) || 0;
    const start = performance.now();
    const step = (now) => {
      const progress = Math.min(1, (now - start) / (duration * this.damping));
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = formatter(from + (target - from) * eased);
      if (progress < 1) requestAnimationFrame(step);
      else el.dataset.value = String(target);
    };
    el.dataset.value = String(from);
    requestAnimationFrame(step);
  }

  /* ---------------- 10. Exaggeration ---------------- */

  /** 夸张放大：完成后的一次「过冲」提示，幅度小而明确 */
  bump(el, strength = 1) {
    if (!el) return { finished: Promise.resolve() };
    return this.play(el, [
      { transform: 'scale(1)' },
      { transform: `scale(${1 + 0.08 * strength * this.damping})` },
      { transform: 'scale(1)' },
    ], { duration: DUR[5], easing: EASE.spring });
  }

  /* ---------------- 11. Solid Drawing ---------------- */

  /**
   * 光源跟随：计算指针在卡片上的相对位置，写入 --gx/--gy，
   * 由 CSS 把高光挪过去，形成「物体不动、光在动」的体积感。
   */
  lightFollow(card, event) {
    if (!this.enabled || this.level === 'soft') return;
    const rect = card.getBoundingClientRect();
    const gx = ((event.clientX - rect.left) / rect.width) * 100;
    const gy = ((event.clientY - rect.top) / rect.height) * 100;
    card.style.setProperty('--gx', `${gx.toFixed(1)}%`);
    card.style.setProperty('--gy', `${gy.toFixed(1)}%`);
  }

  /* ---------------- 12. Appeal ---------------- */

  /** 入场：整组元素依次浮现，节奏统一、幅度克制 */
  reveal(nodes, { stagger = 26, limit = 28 } = {}) {
    [...nodes].slice(0, limit).forEach((node, index) => {
      this.play(node, [
        { opacity: 0, transform: 'translateY(10px) scale(0.985)' },
        { opacity: 1, transform: 'none' },
      ], { duration: DUR[4], delay: index * stagger * this.damping, easing: EASE.out });
    });
  }

  /**
   * FLIP 重排：先记录旧位置（First），改完 DOM 后按差值反向位移（Invert），再播放（Play）。
   * 用于切换排序时避免列表「硬跳」。
   * @param {HTMLElement} container
   * @param {() => void} mutate
   */
  flip(container, mutate) {
    if (!this.enabled) {
      mutate();
      return;
    }
    const before = new Map();
    for (const node of container.querySelectorAll('[data-key]')) {
      before.set(node.dataset.key, node.getBoundingClientRect());
    }
    mutate();
    for (const node of container.querySelectorAll('[data-key]')) {
      const prev = before.get(node.dataset.key);
      if (!prev) continue;
      const next = node.getBoundingClientRect();
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      this.play(node, [
        { transform: `translate(${dx}px, ${dy}px)` },
        { transform: 'none' },
      ], { duration: DUR[5], easing: EASE.out });
    }
  }

  /** 抽屉/遮罩开关，成对使用 */
  async open(el, scrim) {
    el.hidden = false;
    if (scrim) scrim.hidden = false;
    // 强制一次布局，保证 transition 能拿到起始值
    void el.offsetWidth;
    el.classList.add('is-open');
    if (scrim) scrim.classList.add('is-open');
    if (!this.enabled) return;
    await new Promise((resolve) => setTimeout(resolve, DUR[5] * this.damping));
  }

  async close(el, scrim) {
    el.classList.remove('is-open');
    if (scrim) scrim.classList.remove('is-open');
    const wait = this.enabled ? DUR[4] * this.damping : 0;
    await new Promise((resolve) => setTimeout(resolve, wait));
    el.hidden = true;
    if (scrim) scrim.hidden = true;
  }
}

export const motion = new MotionEngine();
