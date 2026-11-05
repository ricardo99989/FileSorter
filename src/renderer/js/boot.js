/**
 * boot.js — 在样式生效前把"材质档位"钉到 <html> 上
 *
 * 必须用独立文件而不是内联脚本：页面 CSP 是 script-src 'self'，
 * 内联会被直接拦掉。放在 <head> 末尾同步执行，避免先按 solid 渲染再闪一下。
 *
 * acrylic = 主进程启用了 DWM 亚克力（窗口底板透明，桌面由系统模糊）
 * solid   = 老系统 / 非 Windows，退回应用内自绘背景 + backdrop-filter
 */
(function () {
  var material = 'solid';
  try {
    if (new URLSearchParams(location.search).get('material') === 'acrylic') material = 'acrylic';
  } catch (err) {
    /* location.search 解析失败就按 solid 处理，不影响启动 */
  }
  document.documentElement.dataset.material = material;
})();
