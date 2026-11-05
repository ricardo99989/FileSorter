'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/**
 * 文件快速预览。
 *
 * 目标：图片、文本、Markdown、PDF、音视频都能在面板里直接看，不用开外部程序。
 * 主进程只负责「判断类型 + 读出内容」，怎么渲染交给渲染层
 * —— 这样 PDF 走 Chromium 自带的阅读器、图片走 <img>，都不用打包额外解码器。
 */

/** 文本类：按扩展名给出语法着色用的语言标记 */
const TEXT_LANGS = new Map([
  ['txt', 'text'], ['log', 'text'], ['csv', 'text'], ['tsv', 'text'],
  ['md', 'md'], ['markdown', 'md'],
  ['json', 'json'], ['jsonc', 'json'],
  ['js', 'js'], ['mjs', 'js'], ['cjs', 'js'], ['jsx', 'js'],
  ['ts', 'ts'], ['tsx', 'ts'],
  ['css', 'css'], ['scss', 'css'], ['less', 'css'],
  ['html', 'html'], ['htm', 'html'], ['xml', 'html'], ['svg', 'html'],
  ['yml', 'yaml'], ['yaml', 'yaml'], ['toml', 'ini'], ['ini', 'ini'], ['cfg', 'ini'], ['conf', 'ini'],
  ['py', 'py'], ['java', 'java'], ['c', 'c'], ['h', 'c'], ['cpp', 'c'], ['hpp', 'c'], ['cc', 'c'],
  ['cs', 'c'], ['go', 'go'], ['rs', 'rs'], ['rb', 'rb'], ['php', 'php'],
  ['sh', 'sh'], ['bat', 'sh'], ['ps1', 'sh'], ['sql', 'sql'],
  ['vue', 'html'], ['svelte', 'html'], ['env', 'ini'], ['gitignore', 'ini'],
]);

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'heic', 'heif']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus', 'aiff', 'amr']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mkv', 'mov', 'm4v', 'avi', 'wmv', 'ogv']);

/** 文本预览上限：64KB，再多也没人会在侧栏里读完 */
const TEXT_LIMIT = 64 * 1024;
/** 大图不直接塞进 <img>，避免一次性解码几百 MB */
const IMAGE_LIMIT = 32 * 1024 * 1024;
const MEDIA_LIMIT = 2 * 1024 * 1024 * 1024;

/**
 * 猜编码：只处理最常见的三种。
 * Windows 上的中文文本有一半是 GBK，硬按 UTF-8 解会全是问号，
 * 所以这里用一个廉价启发式：UTF-8 解出来出现替换字符就按 GBK 重解。
 */
function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: buffer.subarray(2).toString('utf16le'), encoding: 'utf16le' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'utf16be' };
  }
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) return { text: utf8, encoding: 'utf8' };
  try {
    const gbk = new TextDecoder('gbk').decode(buffer);
    // 只有明显更干净时才采用，避免把本来就是乱码的二进制解成字
    if (!gbk.includes('\uFFFD') && gbk.length) return { text: gbk, encoding: 'gbk' };
  } catch {
    /* 运行时不支持 gbk 就退回 utf8 */
  }
  return { text: utf8, encoding: 'utf8' };
}

/**
 * 判断并产出一份预览数据。
 *
 * @param {string} target
 * @param {{stat?:object}} [options]
 */
async function preview(target, options = {}) {
  let stat = options.stat;
  if (!stat) {
    try {
      stat = await fs.stat(target);
    } catch (err) {
      return { kind: 'none', reason: err.code === 'ENOENT' ? '文件已不存在' : '读不到这个文件' };
    }
  }
  if (stat.isDirectory()) return { kind: 'none', reason: '文件夹没有预览' };
  if (stat.size === 0) return { kind: 'none', reason: '空文件' };

  const ext = (path.extname(target).slice(1) || '').toLowerCase();
  const url = pathToFileURL(target).href;

  if (IMAGE_EXTS.has(ext)) {
    if (stat.size > IMAGE_LIMIT) return { kind: 'none', reason: '图片太大，没有在面板里解码' };
    return { kind: 'image', url, width: 0, height: 0, ext };
  }

  if (ext === 'pdf') {
    return { kind: 'pdf', url, size: stat.size };
  }

  if (AUDIO_EXTS.has(ext)) {
    if (stat.size > MEDIA_LIMIT) return { kind: 'none', reason: '音频太大' };
    return { kind: 'audio', url, size: stat.size };
  }

  if (VIDEO_EXTS.has(ext)) {
    if (stat.size > MEDIA_LIMIT) return { kind: 'none', reason: '视频太大' };
    return { kind: 'video', url, size: stat.size };
  }

  if (TEXT_LANGS.has(ext)) {
    return readText(target, ext, stat);
  }

  // 没有扩展名但有内容的，也可能是纯文本（README、Makefile 这类）
  if (!ext) {
    const guess = await readText(target, '', stat, { silent: true });
    if (guess.kind === 'text') return guess;
  }

  return { kind: 'none', reason: '这类文件需要外部程序打开', action: 'open' };
}

/** 读文本，附带一个"是不是二进制"的判断 */
async function readText(target, ext, stat, options = {}) {
  const handle = await fs.open(target, 'r');
  try {
    const length = Math.min(TEXT_LIMIT, stat.size);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    const slice = buffer.subarray(0, bytesRead);

    // 控制字符占比超过 5% 就当二进制，避免把 exe 的内容糊到面板上
    let control = 0;
    for (let i = 0; i < slice.length; i += 1) {
      const byte = slice[i];
      if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
    }
    if (bytesRead && control / bytesRead > 0.05) {
      if (options.silent) return { kind: 'none', reason: '二进制文件' };
      return { kind: 'none', reason: '这看起来是二进制文件' };
    }

    const { text, encoding } = decodeText(slice);
    return {
      kind: 'text',
      text: text.replace(/\r\n/g, '\n'),
      truncated: stat.size > TEXT_LIMIT,
      totalSize: stat.size,
      encoding,
      lang: TEXT_LANGS.get(ext) || 'text',
    };
  } finally {
    await handle.close();
  }
}

module.exports = { preview, decodeText, TEXT_LANGS, IMAGE_EXTS, AUDIO_EXTS, VIDEO_EXTS };
