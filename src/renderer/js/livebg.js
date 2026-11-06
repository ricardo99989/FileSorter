/**
 * livebg.js — 实时透桌面背景（3.7）
 *
 * Windows 上 `backdrop-filter` 采不到窗口外的桌面：它只能糊页面自己画的像素。
 * 系统材质（亚克力）的霜又改不了参数。想真正做到"完全透明 + 模糊自己定"，
 * 只有一条路：**把桌面搬进页面**。
 *
 * 做法：
 *   1. 主进程给窗口打开内容保护（WDA_EXCLUDEFROMCAPTURE），DWM 就会在截图时
 *      跳过这个窗口 —— 于是截图接口看到的是窗口**背后**的实时桌面；
 *   2. 渲染进程用 getDisplayMedia 拿到这条桌面流（不需要原生插件）；
 *   3. 每帧抽一张，缩到 1/3 分辨率、加 blur/saturate/brightness，画进 `.app-bg` 的 canvas；
 *   4. 面板底色仍然为 0，所以看到的一切都是"窗口背后的桌面 + 我们自己的光学处理"。
 *
 * 为什么不是截图快照：快照在桌面有动画（视频、滚动）时会露馅；实时流没有这个问题。
 * 代价是开这一档时，用户自己的截图/录屏里这块窗口是空的 —— 这是内容保护的定义行为。
 *
 * 源矩形按窗口在屏幕上的位置实时换算，所以窗口移动、跨屏、改尺寸都不需要重新取流。
 */

const DOWNSAMPLE = 4;
/** 桌面流的采样矩形以 DIP 计算，视频是物理像素，靠这个比值换算 */
const GEOMETRY_TTL = 1200;

const state = {
  stream: null,
  video: null,
  canvas: null,
  ctx: null,
  raf: 0,
  geometry: null,
  geometryAt: 0,
  running: false,
  frames: 0,
  lastTime: -1,
  /** 上一次真正画到画布的时间；rAF 被暂停时由 watchdog 接管 */
  lastDraw: 0,
  watchdog: 0,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function readGeometry(api) {
  try {
    const result = await api.geometry();
    if (result.ok && result.data?.display) {
      state.geometry = result.data.display;
      state.geometryAt = performance.now();
    }
  } catch {
    /* 拿不到就沿用上一次，最坏情况是画面偏一点 */
  }
}

/**
 * 把窗口矩形换算成视频里的采样矩形。
 * screenX/screenY 是 DIP，display.bounds 也是 DIP，两者相减得到窗口在屏内的偏移。
 */
function sourceRect(video, display) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const left = window.screenX - display.bounds.x;
  const top = window.screenY - display.bounds.y;
  const w = window.innerWidth;
  const h = window.innerHeight;

  // 窗口被拖到另一块屏时，这里的比例会超出 0~1；交给 clamp 兜底，宁可有偏移也不要黑屏
  const sx = clamp((left / display.bounds.width) * vw, 0, vw - 2);
  const sy = clamp((top / display.bounds.height) * vh, 0, vh - 2);
  const sw = clamp((w / display.bounds.width) * vw, 2, vw - sx);
  const sh = clamp((h / display.bounds.height) * vh, 2, vh - sy);
  return { sx, sy, sw, sh };
}

function ensureCanvas(host) {
  if (state.canvas && state.canvas.isConnected) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'livebg';
  canvas.setAttribute('aria-hidden', 'true');
  host.appendChild(canvas);
  state.canvas = canvas;
  state.ctx = canvas.getContext('2d', { alpha: false });
}

function draw(api) {
  if (!state.running) return;
  const { video, canvas, ctx, geometry } = state;

  /*
   * 只在视频真的出了新帧时才重绘：桌面流 30fps，屏幕 60/120Hz，
   * 不判 currentTime 就会把同一帧重复合成两到四次。
   *
   * 这里**不判** document.visibilityState —— 被别的窗口遮住时 Chromium 会把它标成 hidden，
   * 而用户把窗口从遮挡里拖出来那一刻正需要画面。rAF 本身在被遮挡时会暂停、恢复时自动继续，
   * 所以用 rAF 驱动比 requestVideoFrameCallback 更抗"被遮挡后又露出来"。
   */
  if (
    video.readyState >= 2 &&
    video.currentTime !== state.lastTime &&
    geometry
  ) {
    const rect = sourceRect(video, geometry);
    if (rect) {
      // 1/4 分辨率：模糊是低频信息，缩到这个尺寸足够，GPU/CPU 都省
      const cw = Math.max(160, Math.round(window.innerWidth / DOWNSAMPLE));
      const ch = Math.max(120, Math.round(window.innerHeight / DOWNSAMPLE));
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      // 略放大绘制：canvas 的 filter 模糊会让边缘变透明，放大 10% 把边缘推到画布外
      // 4 倍降采样后模糊半径要跟着放大，否则放大回来会显得太锐
      ctx.filter = 'blur(7px) saturate(1.9) brightness(1.05)';
      ctx.drawImage(
        video,
        rect.sx,
        rect.sy,
        rect.sw,
        rect.sh,
        -cw * 0.05,
        -ch * 0.05,
        cw * 1.1,
        ch * 1.1,
      );
      state.lastTime = video.currentTime;
      state.frames += 1;
      state.lastDraw = performance.now();
    }
  }

  // 窗口可能被拖到另一块屏：几何值定期刷新，比每帧问一次 IPC 便宜
  if (performance.now() - state.geometryAt > GEOMETRY_TTL) {
    readGeometry(api);
  }
}

function frame(api) {
  if (!state.running) return;
  draw(api);
  state.raf = requestAnimationFrame(() => frame(api));
}

/**
 * 兜底心跳。
 * 窗口被别的程序盖住时 Chromium 会把文档标成 hidden，并把 rAF 整个停掉 ——
 * 此时用户把窗口拖回来的第一眼看到的是几秒前的旧桌面。定时器在后台会被节流到
 * 约 1s，正好用来补一帧：既不常驻吃 GPU，也不会露出陈旧的画面。
 */
function startWatchdog(api) {
  clearInterval(state.watchdog);
  state.watchdog = setInterval(() => {
    if (!state.running) return;
    if (performance.now() - state.lastDraw < 220) return; // rAF 正常跑着，不插手
    draw(api);
    state.lastDraw = performance.now();
  }, 250);
}

export function isLiveRunning() {
  return state.running;
}

/**
 * 启动实时背景。失败时抛错，调用方负责回退到系统磨砂并提示。
 */
export async function startLiveBackground(api, host) {
  if (state.running) return { frames: state.frames };
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('这个环境不支持桌面采集');
  }

  await readGeometry(api);

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 30 },
    audio: false,
  });

  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  // 不能 display:none —— 那样不给解码帧；放到画外并保持极低不透明度即可
  video.className = 'livebg__src';
  host.appendChild(video);
  await video.play();

  state.stream = stream;
  state.video = video;
  ensureCanvas(host);
  state.running = true;
  state.frames = 0;
  state.lastTime = -1;
  state.lastDraw = performance.now();
  startWatchdog(api);
  state.raf = requestAnimationFrame(() => frame(api));

  return { frames: 0 };
}

export function stopLiveBackground() {
  state.running = false;
  cancelAnimationFrame(state.raf);
  clearInterval(state.watchdog);
  state.watchdog = 0;
  state.raf = 0;
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
    state.stream = null;
  }
  state.video?.remove();
  state.video = null;
  state.canvas?.remove();
  state.canvas = null;
  state.ctx = null;
  state.geometry = null;
}

export function liveStats() {
  return {
    running: state.running,
    frames: state.frames,
    size: state.canvas ? [state.canvas.width, state.canvas.height] : null,
    video: state.video ? [state.video.videoWidth, state.video.videoHeight] : null,
    ready: state.video ? state.video.readyState : null,
    paused: state.video ? state.video.paused : null,
    visibility: document.visibilityState,
    display: state.geometry ? state.geometry.bounds : null,
  };
}
