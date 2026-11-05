import { motion, DUR, EASE } from '../motion.js';

/** 合法图标白名单，避免拼接出无效的 <use> */
export const ICON_NAMES = [
  'image', 'video', 'doc', 'audio', 'archive', 'app', 'code', 'file',
  'folder', 'search', 'undo', 'settings', 'history', 'check', 'close', 'sort', 'spark',
];

/**
 * 轻提示。进入走「跟随运动」：先到位，阴影与位移稍后收住。
 * @param {string} message
 * @param {{type?:'info'|'ok'|'warn'|'error', duration?:number}} options
 */
export function toast(message, options = {}) {
  const { type = 'info', duration = 2800 } = options;
  const host = document.getElementById('toasts');
  if (!host) return;

  const node = document.createElement('div');
  node.className = `toast toast--${type}`;
  node.innerHTML = `<span class="toast__dot"></span><span>${message}</span>`;
  host.appendChild(node);

  motion.play(node, [
    { opacity: 0, transform: 'translateY(14px) scale(0.96)' },
    { opacity: 1, transform: 'translateY(-2px) scale(1)', offset: 0.75 },
    { opacity: 1, transform: 'none' },
  ], { duration: DUR[5], easing: EASE.out });

  window.setTimeout(() => {
    const exit = motion.play(node, [
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: 'translateX(12px) scale(0.98)' },
    ], { duration: DUR[3], easing: EASE.inOut });
    Promise.resolve(exit.finished).finally(() => node.remove());
  }, duration);
}

/** 按钮忙碌态：禁用并临时替换文案，避免重复提交 */
export function setBusy(button, busy, busyText = '处理中…') {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.querySelector('span')?.textContent || '';
    button.disabled = true;
    const label = button.querySelector('span');
    if (label) label.textContent = busyText;
  } else {
    button.disabled = false;
    const label = button.querySelector('span');
    if (label && button.dataset.label) label.textContent = button.dataset.label;
  }
}
