'use strict';

/**
 * 批量处理测试：重命名模板、ZIP 打包、AES 加密。
 *
 * 这三块都是「一步做错就丢数据」的操作，所以测试的重点不是正常路径能不能跑通，
 * 而是边界：环形互换会不会互相覆盖、中文文件名会不会乱码、密码错了会不会产出乱码。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const {
  expandTemplate,
  renamePlan,
  executeRename,
  createZip,
  crc32,
  encryptFile,
  decryptFile,
  archive,
  MAGIC,
} = require('../src/main/batch');

async function makeDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'filesorter-batch-'));
}

/* ------------------------------ 模板展开 ------------------------------ */

test('{name} {n} {ext} 基本展开', () => {
  const out = expandTemplate('{name}_{n:3}', {
    base: '会议纪要',
    ext: 'docx',
    index: 7,
    mtime: Date.now(),
  });
  assert.equal(out, '会议纪要_007');
});

test('{n} 不写宽度时不补零', () => {
  const out = expandTemplate('{name}-{n}', { base: 'a', ext: 'txt', index: 12, mtime: Date.now() });
  assert.equal(out, 'a-12');
});

test('{date} 按修改时间生成日期戳', () => {
  const stamp = new Date(2026, 4, 9, 15, 0).getTime();
  const out = expandTemplate('{date}', { base: 'a', ext: 'txt', index: 1, mtime: stamp });
  assert.equal(out, '20260509');
});

test('模板里的未知占位符原样保留，不会被吞掉', () => {
  const out = expandTemplate('{name}{unknown}', { base: 'a', ext: 'txt', index: 1, mtime: Date.now() });
  assert.equal(out, 'a{unknown}');
});

/* ------------------------------ 重命名计划 ------------------------------ */

test('模板不写 {ext} 时自动补回原扩展名，且保留原有大小写', async () => {
  const dir = await makeDir();
  await fs.writeFile(path.join(dir, 'IMG_0001.JPG'), 'x');

  const plan = await renamePlan(dir, ['IMG_0001.JPG'], { template: '{name}_{n:2}', start: 1 });
  const item = plan.items[0];
  assert.equal(item.to, 'IMG_0001_01.JPG', '大写扩展名不能被改成小写');
});

test('模板写了 {ext} 时按模板位置拼接', async () => {
  const dir = await makeDir();
  await fs.writeFile(path.join(dir, 'note.md'), 'x');

  const plan = await renamePlan(dir, ['note.md'], { template: '{name}_备份.{ext}' });
  assert.equal(plan.items[0].to, 'note_备份.md');
});

test('名称没有变化时标记为跳过，不产生无意义的改名', async () => {
  const dir = await makeDir();
  await fs.writeFile(path.join(dir, 'keep.txt'), 'x');

  const plan = await renamePlan(dir, ['keep.txt'], { template: '{name}' });
  assert.equal(plan.items[0].skipped, true);
});

test('与本批其它文件重名会被标为冲突', async () => {
  const dir = await makeDir();
  await fs.writeFile(path.join(dir, 'a.txt'), '1');
  await fs.writeFile(path.join(dir, 'b.txt'), '2');

  // 模板不含 {n}，两个文件都想叫「同名.txt」
  const plan = await renamePlan(dir, ['a.txt', 'b.txt'], { template: '同名' });
  const blocked = plan.items.filter((item) => item.skipped);
  assert.equal(blocked.length, 1, '第二个才构成批内冲突');
  assert.match(blocked[0].reason, /本批/);
  assert.equal(plan.conflicted, 1);
});

test('与目录里已存在的未选中文件重名会被标为冲突', async () => {
  const dir = await makeDir();
  await fs.writeFile(path.join(dir, 'a.txt'), '1');
  await fs.writeFile(path.join(dir, 'taken.txt'), '2');

  const plan = await renamePlan(dir, ['a.txt'], { template: 'taken' });
  assert.equal(plan.items[0].skipped, true);
  assert.match(plan.items[0].reason, /已有同名/);
});

test('环形互换（a→b、b→a）可以安全执行，两个文件都不会丢', async () => {
  const dir = await makeDir();
  await fs.writeFile(path.join(dir, 'a.txt'), 'AAA');
  await fs.writeFile(path.join(dir, 'b.txt'), 'BBB');

  const items = [
    { from: 'a.txt', to: 'b.txt' },
    { from: 'b.txt', to: 'a.txt' },
  ];

  const result = await executeRename(dir, items);
  assert.equal(result.renamed, 2);
  assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'BBB');
  assert.equal(await fs.readFile(path.join(dir, 'b.txt'), 'utf8'), 'AAA');
});

test('执行重命名后目录里不残留临时文件', async () => {
  const dir = await makeDir();
  await fs.writeFile(path.join(dir, 'a.txt'), 'AAA');
  await fs.writeFile(path.join(dir, 'b.txt'), 'BBB');

  await executeRename(dir, [
    { from: 'a.txt', to: 'b.txt' },
    { from: 'b.txt', to: 'a.txt' },
  ]);

  const left = await fs.readdir(dir);
  assert.deepEqual(left.sort(), ['a.txt', 'b.txt']);
});

/* ------------------------------ ZIP ------------------------------ */

test('crc32 对标准测试向量取值正确', () => {
  // "123456789" 的 CRC-32 是业界通用校验向量 0xCBF43926
  const buffer = Buffer.from('123456789', 'ascii');
  assert.equal(crc32(buffer), 0xcbf43926);
});

test('crc32 支持分段续算，与一次算完结果一致', () => {
  const whole = Buffer.from('文件排序工具 FileSorter', 'utf8');
  const oneShot = crc32(whole);
  const part1 = crc32(whole.subarray(0, 10));
  const part2 = crc32(whole.subarray(10), part1);
  assert.equal(part2, oneShot);
});

test('打包产出合法的 ZIP 结构（本地头 + 中央目录 + EOCD）', async () => {
  const dir = await makeDir();
  const file = path.join(dir, 'readme.txt');
  await fs.writeFile(file, 'hello zip');

  const out = path.join(dir, 'out.zip');
  await createZip([file], out);

  const raw = await fs.readFile(out);
  // 本地文件头签名 PK\x03\x04
  assert.equal(raw.readUInt32LE(0), 0x04034b50);
  // 中央目录签名 PK\x01\x02 应出现在文件末尾之前
  assert.ok(raw.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) > 0);
  // EOCD 签名 PK\x05\x06
  const eocd = raw.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0);
  assert.equal(raw.readUInt16LE(eocd + 10), 1, 'EOCD 里应记录 1 个条目');
});

test('中文文件名写入 UTF-8 标志位，解压后不乱码', async () => {
  const dir = await makeDir();
  const file = path.join(dir, '会议纪要.txt');
  await fs.writeFile(file, '内容');

  const out = path.join(dir, 'zh.zip');
  await createZip([file], out);

  const raw = await fs.readFile(out);
  // 通用标志位第 11 位 = 1 表示文件名按 UTF-8 编码
  assert.equal(raw.readUInt16LE(6) & 0x0800, 0x0800);
  // 文件名应在本地头之后以 UTF-8 字节出现
  assert.ok(raw.includes(Buffer.from('会议纪要.txt', 'utf8')));
});

test('打包后的 CRC 与条目实际内容一致（说明压缩与校验没写错）', async () => {
  const dir = await makeDir();
  const content = Buffer.from('compress me please '.repeat(20), 'utf8');
  const file = path.join(dir, 'data.txt');
  await fs.writeFile(file, content);

  const out = path.join(dir, 'crc.zip');
  await createZip([file], out);

  const raw = await fs.readFile(out);
  const crcInZip = raw.readUInt32LE(14);
  assert.equal(crcInZip, crc32(content));

  // 顺带验证压缩数据能解回原文：本地头 30 字节 + 文件名长度 + 扩展区长度
  const nameLen = raw.readUInt16LE(26);
  const extraLen = raw.readUInt16LE(28);
  const method = raw.readUInt16LE(8);
  const compressedSize = raw.readUInt32LE(18);
  const start = 30 + nameLen + extraLen;
  const payload = raw.subarray(start, start + compressedSize);
  const restored = method === 8 ? zlib.inflateRawSync(payload) : payload;
  assert.deepEqual(restored, content);
});

/* ------------------------------ 加密 ------------------------------ */

test('加密后再解密可以完整还原内容', async () => {
  const dir = await makeDir();
  const src = path.join(dir, 'secret.txt');
  const text = '这是一段需要保护的内容 with some latin words';
  await fs.writeFile(src, text, 'utf8');

  const enc = path.join(dir, 'secret.enc');
  await encryptFile(src, enc, 'p@ssw0rd');

  const out = path.join(dir, 'secret.out.txt');
  await decryptFile(enc, out, 'p@ssw0rd');

  assert.equal(await fs.readFile(out, 'utf8'), text);
});

test('密文带固定文件头，便于识别与拒绝错误格式', async () => {
  const dir = await makeDir();
  const src = path.join(dir, 'a.txt');
  await fs.writeFile(src, 'x');

  const enc = path.join(dir, 'a.enc');
  await encryptFile(src, enc, 'abcd');

  const raw = await fs.readFile(enc);
  assert.deepEqual(raw.subarray(0, MAGIC.length), MAGIC);
});

test('密码错误时抛错，而不是产出乱码文件', async () => {
  const dir = await makeDir();
  const src = path.join(dir, 'b.txt');
  await fs.writeFile(src, 'important');

  const enc = path.join(dir, 'b.enc');
  await encryptFile(src, enc, 'right-pass');

  await assert.rejects(
    () => decryptFile(enc, path.join(dir, 'b.out.txt'), 'wrong-pass'),
    /密码|校验|损坏|GCM|auth/i
  );
});

test('密码太短直接拒绝，不留一个「以为加密了」的文件', async () => {
  const dir = await makeDir();
  const src = path.join(dir, 'c.txt');
  await fs.writeFile(src, 'x');
  await assert.rejects(() => encryptFile(src, path.join(dir, 'c.enc'), '12'));
});

test('不是本程序的加密文件会被明确拒绝', async () => {
  const dir = await makeDir();
  const bogus = path.join(dir, 'bogus.enc');
  // 长度要够，否则会先命中「文件不完整」这条更早的检查
  await fs.writeFile(bogus, Buffer.concat([Buffer.alloc(8, 0x41), Buffer.alloc(64, 0x42)]));
  await assert.rejects(() => decryptFile(bogus, path.join(dir, 'x.txt'), 'abcd'), /不是 FileSorter/);
});

test('打包 + 加密组合：加密成功后不留明文压缩包', async () => {
  const dir = await makeDir();
  const file = path.join(dir, 'doc.txt');
  await fs.writeFile(file, 'hello');

  const outBase = path.join(dir, 'packed');
  const result = await archive([file], outBase, { password: 'secret123' });

  assert.equal(result.mode, 'zip+enc');
  const files = await fs.readdir(dir);
  assert.equal(files.includes('packed.zip'), false, '明文 zip 必须删掉，否则加密没有意义');
  assert.ok(files.includes('packed.zip.fsenc'), '密文文件名应可预期');

  // 用同一个密码应该能解回压缩包
  const restored = path.join(dir, 'restored.zip');
  await decryptFile(path.join(dir, 'packed.zip.fsenc'), restored, 'secret123');
  const raw = await fs.readFile(restored);
  assert.equal(raw.readUInt32LE(0), 0x04034b50);
});

test('不设密码时只打包不加密', async () => {
  const dir = await makeDir();
  const file = path.join(dir, 'plain.txt');
  await fs.writeFile(file, 'hi');

  const result = await archive([file], path.join(dir, 'plain'));
  assert.equal(result.mode, 'zip');
  const files = await fs.readdir(dir);
  assert.ok(files.includes('plain.zip'));
});
