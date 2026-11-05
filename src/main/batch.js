'use strict';

const fs = require('node:fs/promises');
const fsp = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { sanitizeFolderName, extOf } = require('./classifier');
const { moveFile } = require('./fsutil');

/**
 * 批量重命名、打包压缩、加密。
 *
 * 三件事放一个模块，是因为它们共享同一套「一批文件 → 一批结果」的流程，
 * 也都要写撤销日志。注意这里的写操作全部经过 fsutil.moveFile，
 * 跨盘时会自动降级成复制+删除，不会静默丢文件。
 */

/* ------------------------------ 批量重命名 ------------------------------ */

/** 文件名非法字符 */
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;

function pad(num, width) {
  return String(num).padStart(width, '0');
}

function dateStamp(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}`;
}

/**
 * 展开命名模板。
 *
 * 支持的占位符：
 * - `{name}` 原文件名（不含扩展名）
 * - `{n}` 序号；`{n:3}` 补零到 3 位
 * - `{ext}` 原扩展名（不含点）
 * - `{date}` 修改日期，形如 20261105
 *
 * 模板里没写 `{ext}` 时自动补回原扩展名，避免用户把 .jpg 改成无后缀。
 *
 * @param {string} template
 * @param {{name:string, base:string, ext:string, index:number, mtime:number}} ctx
 */
function expandTemplate(template, ctx) {
  return String(template).replace(/\{(name|n|ext|date)(?::(\d+))?\}/gi, (whole, key, width) => {
    const name = key.toLowerCase();
    if (name === 'name') return ctx.base;
    if (name === 'ext') return ctx.ext;
    if (name === 'date') return dateStamp(new Date(ctx.mtime || Date.now()));
    return pad(ctx.index, width ? Math.max(1, Math.min(6, Number(width))) : 0);
  });
}

/**
 * 生成重命名计划（只读，不落盘）。
 *
 * @param {string} dir
 * @param {string[]} names 选中的文件名
 * @param {{template:string, start?:number, find?:string, replace?:string, keepExt?:boolean}} options
 */
async function renamePlan(dir, names, options = {}) {
  const template = String(options.template || '{name}_{n:3}');
  const start = Number.isFinite(Number(options.start)) ? Number(options.start) : 1;
  const find = String(options.find || '');
  const replace = String(options.replace || '');
  const keepExt = options.keepExt !== false;

  const existing = new Set();
  try {
    for (const name of await fs.readdir(dir)) existing.add(name.toLowerCase());
  } catch {
    /* 目录读不到就当作空目录，后面执行时会报错 */
  }

  const chosen = new Set(names.map((name) => name.toLowerCase()));
  const items = [];
  const seen = new Map();
  let index = start;

  for (const rawName of names) {
    const full = path.join(dir, rawName);
    let stat = null;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const ext = extOf(rawName);
    // 保留用户原来的大小写（.JPG 不要被改成 .jpg）
    const rawExt = ext ? rawName.slice(rawName.length - ext.length) : '';
    let base = ext ? rawName.slice(0, -(ext.length + 1)) : rawName;
    if (find) base = base.split(find).join(replace);

    let target = expandTemplate(template, { name: rawName, base, ext: rawExt, index, mtime: stat.mtimeMs });
    target = target.replace(ILLEGAL, '').replace(/[.\s]+$/, '').trim();
    if (keepExt && rawExt && !/\{ext\}/i.test(template)) target = `${target}.${rawExt}`;

    if (!target) {
      items.push({ from: rawName, to: '', skipped: true, reason: '新名称为空' });
      index += 1;
      continue;
    }

    const lower = target.toLowerCase();
    let reason = '';
    if (lower === rawName.toLowerCase()) reason = '名称没变化';
    // 同一批里出现两个一样的新名字，后一个必须拦下来
    if (seen.has(lower)) reason = '与本批其它文件重名';
    seen.set(lower, rawName);
    // 与目录里没被选中的文件重名才是真冲突；被选中的文件会先挪到临时名，可以互换
    if (!reason && existing.has(lower) && !chosen.has(lower)) reason = '目录里已有同名文件';

    items.push({
      from: rawName,
      to: target,
      size: stat.size,
      mtime: stat.mtimeMs,
      skipped: Boolean(reason),
      reason,
    });
    index += 1;
  }

  return {
    dir,
    items,
    changed: items.filter((item) => !item.skipped && item.to !== item.from).length,
    conflicted: items.filter((item) => item.skipped).length,
  };
}

/**
 * 执行重命名。
 *
 * 两阶段：先全部改成临时名，再改成目标名。
 * 这样 a→b、b→a 这类环形互换不会互相覆盖。
 *
 * @param {string} dir
 * @param {Array<{from:string,to:string}>} items
 * @param {{undo?:{startLog:Function,record:Function}}} [options]
 */
async function executeRename(dir, items, options = {}) {
  const { undo = null } = options;
  const queue = items.filter((item) => item && item.to && item.to !== item.from && !item.skipped);
  if (!queue.length) return { renamed: 0, failed: [], total: 0 };

  const logFile = undo
    ? await undo.startLog(dir, { action: 'rename', note: `${path.basename(dir) || dir} · 重命名 ${queue.length} 个` })
    : null;

  const stamp = Date.now().toString(36);
  const staged = [];
  const failed = [];

  // 阶段一：挪到临时名
  for (let i = 0; i < queue.length; i += 1) {
    const item = queue[i];
    const tempName = `.fs-rename-${stamp}-${i}.tmp`;
    try {
      await moveFile(path.join(dir, item.from), path.join(dir, tempName));
      staged.push({ ...item, tempName });
    } catch (err) {
      failed.push({ name: item.from, reason: err.message });
    }
  }

  // 阶段二：落成目标名
  let renamed = 0;
  for (const item of staged) {
    try {
      const dest = path.join(dir, item.to);
      await moveFile(path.join(dir, item.tempName), dest);
      if (undo && logFile) await undo.record(logFile, path.join(dir, item.from), dest);
      renamed += 1;
    } catch (err) {
      // 落地失败就把临时名还原回原名，别让用户看到一个 .tmp
      await moveFile(path.join(dir, item.tempName), path.join(dir, item.from)).catch(() => {});
      failed.push({ name: item.from, reason: err.message });
    }
  }

  if (undo) undo.prune().catch(() => {});
  return { renamed, failed, total: queue.length, logFile };
}

/* ------------------------------ 打包压缩 ------------------------------ */

/** CRC32 查表，zipping 时每条记录都要用 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value;
  }
  return table;
})();

/** 累进计算 CRC32：可以分块喂，适合大文件 */
function crc32(buffer, previous = 0) {
  let crc = ~previous;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return ~crc >>> 0;
}

/** 已经是压缩格式的扩展名，再 deflate 只是白费 CPU */
const PRECOMPRESSED = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'avif', 'mp4', 'mkv', 'mov', 'avi', 'webm',
  'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'zip', 'rar', '7z', 'gz', 'xz', 'zst',
  'docx', 'xlsx', 'pptx', 'apk', 'jar', 'epub',
]);

/** 超过这个体积就不进内存，改用「先算 CRC 再流式拷贝」 */
const BUFFER_LIMIT = 64 * 1024 * 1024;

/** MS-DOS 时间格式：zip 规定的老古董，但所有解压软件都认 */
function dosDateTime(date) {
  const time =
    ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const day =
    (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

/** 写缓冲到已打开的句柄，返回写入后的偏移量 */
async function writeChunk(handle, buffer, offset) {
  await handle.write(buffer, 0, buffer.length, offset);
  return offset + buffer.length;
}

/** 流式算 CRC（大文件用的第一遍） */
function crcFileStreaming(target) {
  return new Promise((resolve, reject) => {
    let crc = 0;
    let size = 0;
    const stream = fsp.createReadStream(target, { highWaterMark: 512 * 1024 });
    stream.on('data', (chunk) => {
      crc = crc32(chunk, crc);
      size += chunk.length;
    });
    stream.on('error', reject);
    stream.on('end', () => resolve({ crc, size }));
  });
}

/**
 * 打一个标准 zip 包。
 *
 * 为什么自己写而不是拉一个库：只需要「把一批文件塞进 zip」这一件事，
 * 引入 archiver 会带十几个传递依赖，和"轻量、低占用"的定位不符。
 *
 * @param {string[]} targets 要打包的文件绝对路径
 * @param {string} outPath 输出 zip 路径
 * @param {{onProgress?:Function}} [options]
 */
async function createZip(targets, outPath, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const handle = await fs.open(outPath, 'w');

  /** 中央目录条目 */
  const central = [];
  let offset = 0;
  const usedNames = new Set();

  try {
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      let stat;
      try {
        stat = await fs.stat(target);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;

      // 同名文件自动加序号，绝不互相覆盖
      let entryName = path.basename(target);
      if (usedNames.has(entryName.toLowerCase())) {
        const ext = path.extname(entryName);
        const base = entryName.slice(0, entryName.length - ext.length);
        let n = 1;
        while (usedNames.has(`${base}(${n})${ext}`.toLowerCase())) n += 1;
        entryName = `${base}(${n})${ext}`;
      }
      usedNames.add(entryName.toLowerCase());

      const nameBuffer = Buffer.from(entryName, 'utf8');
      const { time, day } = dosDateTime(stat.mtime);
      const ext = extOf(entryName);
      const canDeflate = stat.size > 0 && stat.size <= BUFFER_LIMIT && !PRECOMPRESSED.has(ext);

      let method = 0;
      let crc = 0;
      let compressedSize = 0;
      let uncompressedSize = stat.size;
      let payload = null;

      if (canDeflate) {
        const raw = await fs.readFile(target);
        crc = crc32(raw);
        const deflated = zlib.deflateRawSync(raw, { level: 6 });
        // 压不动就用原样存，别让 zip 比原文件还大
        if (deflated.length < raw.length) {
          method = 8;
          payload = deflated;
          compressedSize = deflated.length;
          uncompressedSize = raw.length;
        } else {
          payload = raw;
          compressedSize = raw.length;
          uncompressedSize = raw.length;
        }
      } else {
        // 大文件或已压缩格式：先流式算 CRC，再原样拷贝
        const scanned = await crcFileStreaming(target);
        crc = scanned.crc;
        uncompressedSize = scanned.size;
        compressedSize = scanned.size;
      }

      // 本地文件头
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x0800, 6); // 文件名按 UTF-8 编码，中文名不会乱码
      header.writeUInt16LE(method, 8);
      header.writeUInt16LE(time, 10);
      header.writeUInt16LE(day, 12);
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(compressedSize, 18);
      header.writeUInt32LE(uncompressedSize, 22);
      header.writeUInt16LE(nameBuffer.length, 26);
      header.writeUInt16LE(0, 28);

      const localOffset = offset;
      offset = await writeChunk(handle, header, offset);
      offset = await writeChunk(handle, nameBuffer, offset);

      if (payload) {
        offset = await writeChunk(handle, payload, offset);
      } else {
        const stream = fsp.createReadStream(target, { highWaterMark: 512 * 1024 });
        for await (const chunk of stream) {
          offset = await writeChunk(handle, chunk, offset);
        }
      }

      central.push({
        nameBuffer,
        method,
        time,
        day,
        crc,
        compressedSize,
        uncompressedSize,
        localOffset,
      });

      if (onProgress) {
        onProgress({ index: index + 1, total: targets.length, name: entryName });
      }
    }

    // 中央目录
    const centralStart = offset;
    for (const entry of central) {
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(20, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x0800, 8);
      record.writeUInt16LE(entry.method, 10);
      record.writeUInt16LE(entry.time, 12);
      record.writeUInt16LE(entry.day, 14);
      record.writeUInt32LE(entry.crc, 16);
      record.writeUInt32LE(entry.compressedSize, 20);
      record.writeUInt32LE(entry.uncompressedSize, 24);
      record.writeUInt16LE(entry.nameBuffer.length, 28);
      record.writeUInt16LE(0, 30);
      record.writeUInt16LE(0, 32);
      record.writeUInt16LE(0, 34);
      record.writeUInt16LE(0, 36);
      record.writeUInt32LE(0, 38);
      record.writeUInt32LE(entry.localOffset, 42);
      offset = await writeChunk(handle, record, offset);
      offset = await writeChunk(handle, entry.nameBuffer, offset);
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(offset - centralStart, 12);
    eocd.writeUInt32LE(centralStart, 16);
    eocd.writeUInt16LE(0, 20);
    await writeChunk(handle, eocd, offset);
  } finally {
    await handle.close();
  }

  const stat = await fs.stat(outPath);
  return { outPath, entries: central.length, size: stat.size };
}

/* ------------------------------ 加密 ------------------------------ */

const MAGIC = Buffer.from('FSENC1\0\0', 'utf8');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const PBKDF2_ROUNDS = 210000;

function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, PBKDF2_ROUNDS, 32, 'sha256');
}

/**
 * 用 AES-256-GCM 加密单个文件。
 * 文件头是 `FSENC1` + salt + iv，密文之后跟 16 字节认证标签，
 * 密码错了会在解密时被 GCM 校验出来，不会得到一堆乱码。
 *
 * @param {string} source
 * @param {string} outPath
 * @param {string} password
 */
async function encryptFile(source, outPath, password) {
  if (!password || String(password).length < 4) throw new Error('密码至少 4 位');
  const stat = await fs.stat(source);
  if (stat.size > 512 * 1024 * 1024) throw new Error('超过 512MB 的文件暂不支持加密');

  const raw = await fs.readFile(source);
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(raw), cipher.final()]);
  const tag = cipher.getAuthTag();

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, Buffer.concat([MAGIC, salt, iv, encrypted, tag]));
  const out = await fs.stat(outPath);
  return { outPath, size: out.size, originSize: stat.size };
}

/**
 * 解密 .fsenc 文件。
 * @param {string} source
 * @param {string} outPath
 * @param {string} password
 */
async function decryptFile(source, outPath, password) {
  const raw = await fs.readFile(source);
  if (raw.length < MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN) throw new Error('文件不完整');
  if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('不是 FileSorter 加密文件');

  let cursor = MAGIC.length;
  const salt = raw.subarray(cursor, cursor + SALT_LEN);
  cursor += SALT_LEN;
  const iv = raw.subarray(cursor, cursor + IV_LEN);
  cursor += IV_LEN;
  const tag = raw.subarray(raw.length - TAG_LEN);
  const body = raw.subarray(cursor, raw.length - TAG_LEN);

  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let plain;
  try {
    plain = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new Error('密码不对，或文件已损坏');
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, plain);
  return { outPath, size: plain.length };
}

/**
 * 一键打包：选中一批文件 → zip →（可选）再整体加密。
 *
 * @param {string[]} targets
 * @param {string} outBase 输出路径（不含扩展名）
 * @param {{password?:string, onProgress?:Function}} [options]
 */
async function archive(targets, outBase, options = {}) {
  const zipPath = `${outBase}.zip`;
  const zipResult = await createZip(targets, zipPath, { onProgress: options.onProgress });

  if (!options.password) {
    return { ...zipResult, mode: 'zip' };
  }

  const encPath = `${zipPath}.fsenc`;
  const encResult = await encryptFile(zipPath, encPath, options.password);
  // 加密成功后不留明文压缩包，否则加密等于白做
  await fs.unlink(zipPath).catch(() => {});
  return {
    outPath: encPath,
    entries: zipResult.entries,
    size: encResult.size,
    mode: 'zip+enc',
  };
}

module.exports = {
  renamePlan,
  executeRename,
  expandTemplate,
  createZip,
  crc32,
  encryptFile,
  decryptFile,
  archive,
  PRECOMPRESSED,
  MAGIC,
};
