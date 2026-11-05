'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * 云盘同步目录识别。
 *
 * 目的不是"接管"云盘，而是在用户整理前提醒一句：
 * 这个目录正被 OneDrive/百度网盘 同步，动里面的文件会触发一轮上传/删除。
 * 有了这份名单，界面上可以给目录打标，也能让定时任务绕开。
 */

/** 常见客户端与它们的特征目录名 */
const CLIENT_DEFS = [
  { id: 'onedrive', name: 'OneDrive', envs: ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'], dirs: ['OneDrive', 'OneDrive - Personal'] },
  { id: 'dropbox', name: 'Dropbox', dirs: ['Dropbox', 'Dropbox (Personal)'] },
  { id: 'nutstore', name: '坚果云', dirs: ['Nutstore', 'Nutstore Files', '我的坚果云'] },
  { id: 'baidu', name: '百度网盘', dirs: ['BaiduNetdiskDownload', '百度网盘', 'BaiduYunGuanjia'] },
  { id: 'aliyun', name: '阿里云盘', dirs: ['AliyunDrive', '阿里云盘', 'AliyunPan'] },
  { id: 'weiyun', name: '腾讯微云', dirs: ['Weiyun', '微云'] },
  { id: 'icloud', name: 'iCloud Drive', dirs: ['iCloudDrive', 'iCloud Drive'] },
  { id: 'google', name: 'Google 云端硬盘', dirs: ['GoogleDrive', 'Google Drive'] },
  { id: 'ctyun', name: '天翼云盘', dirs: ['189Cloud', '天翼云盘'] },
];

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 探测本机上实际存在的云盘同步目录。
 * @param {{home?:string, env?:NodeJS.ProcessEnv, extraDirs?:string[], maxDepth?:number}} [options]
 */
async function detect(options = {}) {
  const env = options.env || process.env;
  const home = options.home || env.USERPROFILE || env.HOME || '';
  const extra = Array.isArray(options.extraDirs) ? options.extraDirs.filter(Boolean) : [];

  const candidateRoots = new Set();
  if (home) {
    candidateRoots.add(home);
    candidateRoots.add(path.join(home, 'Documents'));
    candidateRoots.add(path.join(home, 'Desktop'));
  }
  for (const dir of extra) candidateRoots.add(dir);

  const found = [];
  const seen = new Set();

  const push = (id, name, dir) => {
    const key = dir.replace(/\//g, '\\').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ id, name, dir, kind: 'cloud' });
  };

  for (const client of CLIENT_DEFS) {
    // 1. 环境变量指向的目录最准（OneDrive 会明确写出来）
    for (const envKey of client.envs || []) {
      const value = env[envKey];
      if (value && (await exists(value))) push(client.id, client.name, value);
    }
    // 2. 再看常见位置
    for (const root of candidateRoots) {
      for (const dirName of client.dirs) {
        const full = path.join(root, dirName);
        if (await exists(full)) push(client.id, client.name, full);
      }
    }
  }

  return found;
}

/** 判断某个路径是否落在某个云盘目录内 */
function isInsideCloud(target, clouds) {
  const normalized = String(target || '').replace(/\//g, '\\').toLowerCase();
  for (const cloud of clouds || []) {
    const root = String(cloud.dir || '').replace(/\//g, '\\').toLowerCase();
    if (!root) continue;
    if (normalized === root || normalized.startsWith(`${root}\\`)) return cloud;
  }
  return null;
}

module.exports = { detect, isInsideCloud, CLIENT_DEFS };
