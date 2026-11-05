/**
 * views/preview.js — 快速预览的渲染
 *
 * 图片走 <img>、PDF 走 <iframe>（Chromium 自带阅读器）、音视频走 <audio>/<video>，
 * 文本自己做一层极轻的着色 —— 不引第三方高亮库，因为那会为了一个面板加几百 KB。
 */

import { icon } from '../icons.js';
import { esc, formatSize } from '../format.js';
import { t } from '../../../shared/i18n.mjs';

/** 简单 Markdown 渲染。先转义再做替换，绝不会让文件内容变成可执行 HTML */
export function renderMarkdown(source) {
  let html = esc(source);
  const blocks = [];

  // 先把代码块摘出来，避免里面的 # 和 * 被当成标题/强调
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_whole, lang, code) => {
    blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000BLOCK${blocks.length - 1}\u0000`;
  });

  html = html
    .replace(/^###### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^##### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^#### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^---+$/gm, '<hr />')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^[-*] (.*)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');

  html = html.replace(/\u0000BLOCK(\d+)\u0000/g, (_whole, index) => blocks[Number(index)] || '');
  // 连续换行压成段落
  return html
    .split(/\n{2,}/)
    .map((chunk) => (/^<(h1|h2|h3|ul|pre|blockquote|hr)/.test(chunk.trim()) ? chunk : `<p>${chunk.replace(/\n/g, '<br />')}</p>`))
    .join('');
}

/** 语言 → 关键字表，只覆盖最常见的几种 */
const KEYWORDS = {
  js: 'const let var function return if else for while class new import export from default async await try catch throw typeof instanceof of in this null undefined true false',
  ts: 'const let var function return if else for while class new import export from default async await try catch throw typeof interface type enum public private readonly null undefined true false',
  py: 'def class return if elif else for while import from as with try except finally raise lambda yield None True False self in not and or pass',
  c: 'int void char float double return if else for while do switch case break struct typedef const static sizeof include unsigned long short NULL',
  go: 'func package import return if else for range var const type struct interface map chan defer go select nil true false',
  rs: 'fn let mut pub use mod struct enum impl return if else for while match loop in as const static self true false',
  rb: 'def class module end return if elsif else unless while do begin rescue require attr_reader nil true false',
  java: 'public private protected class interface extends implements void int String return if else for while new static final import package null true false',
  php: 'function class return if else foreach while echo new public private protected static namespace use null true false',
  sh: 'if then else fi for in do done function echo export local return set unset while case esac',
  sql: 'select from where insert into values update set delete create table drop alter join left right on group by order having limit as and or not null',
  yaml: 'true false null',
  ini: '',
  json: 'true false null',
  html: '',
  css: '',
  md: '',
  text: '',
};

/**
 * 极轻的语法着色：先转义，再按「字符串 / 注释 / 数字 / 关键字」的顺序着色。
 * 只看前 60KB，再多也看不出差别，反而拖慢面板。
 */
export function highlight(code, lang) {
  const keywords = KEYWORDS[lang] || '';
  let html = esc(code);

  // 字符串与注释先挡住，避免里面的关键字被误着色
  const slots = [];
  const stash = (markup) => {
    slots.push(markup);
    return `\u0001${slots.length - 1}\u0001`;
  };

  html = html.replace(/(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|`[^`]*?`)/g, (whole) =>
    stash(`<span class="tok-str">${whole}</span>`),
  );
  html = html.replace(/(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/g, (whole) =>
    stash(`<span class="tok-com">${whole}</span>`),
  );
  html = html.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-num">$1</span>');

  if (keywords) {
    const words = keywords.split(/\s+/).filter(Boolean).join('|');
    html = html.replace(new RegExp(`\\b(${words})\\b`, 'g'), '<span class="tok-key">$1</span>');
  }

  return html.replace(/\u0001(\d+)\u0001/g, (_whole, index) => slots[Number(index)] || '');
}

/**
 * 一份预览数据 → HTML。
 * @param {object|null} preview 主进程 browser:preview 的返回
 * @param {object} entry 当前选中的条目
 */
export function previewHtml(preview, entry) {
  if (!preview) {
    return `<div class="preview-box"><div class="preview-empty">${esc(t('common.loading'))}</div></div>`;
  }

  const head = (label) => `<div class="preview-box__head">${icon('eye', 12)}<span>${esc(label)}</span><span class="section__spacer"></span></div>`;

  if (preview.kind === 'image') {
    return `<div class="preview-box">
      ${head(`${entry?.ext?.toUpperCase() || '图片'} · ${formatSize(entry?.size)}`)}
      <img class="preview-media" src="${esc(preview.url)}" alt="" />
    </div>`;
  }

  if (preview.kind === 'pdf') {
    return `<div class="preview-box">
      ${head('PDF')}
      <iframe class="preview-frame" src="${esc(preview.url)}" title="PDF 预览"></iframe>
      <div class="preview-empty">${esc(t('preview.pdfHint'))}</div>
    </div>`;
  }

  if (preview.kind === 'audio') {
    return `<div class="preview-box">
      ${head('音频')}
      <div style="padding:10px 12px"><audio controls src="${esc(preview.url)}" style="width:100%"></audio></div>
    </div>`;
  }

  if (preview.kind === 'video') {
    return `<div class="preview-box">
      ${head('视频')}
      <video class="preview-media" controls preload="metadata" src="${esc(preview.url)}"></video>
    </div>`;
  }

  if (preview.kind === 'text') {
    const lang = preview.lang || 'text';
    const body =
      lang === 'md'
        ? `<div class="preview-md">${renderMarkdown(preview.text)}</div>`
        : `<pre class="preview-text">${lang === 'text' ? esc(preview.text) : highlight(preview.text, lang)}</pre>`;
    const note = preview.truncated
      ? `<div class="preview-empty">${esc(t('preview.truncated'))} · ${esc(formatSize(preview.totalSize))}</div>`
      : '';
    return `<div class="preview-box">${head(`${lang.toUpperCase()} · ${preview.encoding}`)}${body}${note}</div>`;
  }

  // 兜底分支：外层区块标题已经写了「快速预览」，这里再重复一遍就冗余了，
  // 改显示文件类型，顺带回答「这是什么文件所以打不开」
  const tag = `${(entry?.ext || '').toUpperCase() || t('preview.title')}`;
  return `<div class="preview-box">
    ${head(tag)}
    <div class="preview-empty">${esc(preview.reason || t('preview.unsupported'))}</div>
  </div>`;
}
