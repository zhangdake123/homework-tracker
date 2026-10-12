'use strict';

/*
 * 打包静态托管版：把 public/ 里需要上线的文件放到 outputs/static-site/，
 * 并生成一个「zip 根目录就是 index.html」的压缩包。
 *
 * 注意：zip 里不能有外层文件夹（比如 public/ 或 homework-tracker/），
 * 否则上传到静态托管后根路径会 404（这正是上次腾讯云 Web 应用托管 404 的原因）。
 *
 * 零依赖：zip 由本脚本自己写（deflate + CRC32），不依赖任何第三方库。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUT_DIR = path.join(ROOT, 'outputs');
const SITE_DIR = path.join(OUT_DIR, 'static-site');
const ZIP_PATH = path.join(OUT_DIR, 'homework-tracker-static.zip');

const SITE_FILES = ['index.html', 'styles.css', 'app.js', 'store-core.js', 'store-cloudbase.js'];

const DEPLOY_NOTE = [
  '班主任作业追踪 · 静态托管版',
  '=====================================',
  '',
  '这个压缩包里的文件要直接放在网站根目录（zip 内没有外层文件夹）。',
  '部署到腾讯云 CloudBase 静态网站托管：',
  '',
  '  1. 云开发平台 → 静态网站托管 → 「文件管理」',
  '  2. 点「上传文件」，把本压缩包解压后的 5 个文件全选上传（不要上传外层的文件夹）',
  '  3. 打开分配到的网址（形如 https://你的环境ID.tcloudbaseapp.com）',
  '  4. 首次打开会提示未连接数据源：进入「名单 / 设置」→ 数据存放方式 → 填云开发环境 ID → 连接',
  '',
  '使用前必须在云开发控制台做 3 件事（详见 README）：',
  '  1. 身份认证 → 登录方式 → 开启「匿名登录」',
  '  2. 文档型数据库 → 集合管理 → 新建 4 个集合：ht_students / ht_tasks / ht_history / ht_settings，',
  '     并把每个集合的权限设为「所有用户可读写」（安全规则 {"read": true, "write": true}）',
  '  3. 环境配置 → 安全来源 → 加入你的网站域名（静态托管默认域名通常已在白名单里）',
  '',
  '数据保存在云开发数据库里，手机和电脑打开同一个网址就是同一份数据。',
  '备份：在「名单 / 设置」里点「导出数据备份（JSON）」，或在云开发控制台导出集合。',
  '',
  '文件清单：',
  ...SITE_FILES.map((name) => '  - ' + name),
  '',
].join('\n');

function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
    crc32.table = table;
  }
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ buffer[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2))) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time: time, date: day };
}

function buildZip(entries) {
  const now = new Date();
  const stamp = dosDateTime(now);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  entries.forEach((entry) => {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);       // version needed
    local.writeUInt16LE(0x0800, 6);   // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, nameBuffer, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);

    offset += local.length + nameBuffer.length + payload.length;
  });

  const centralBuffer = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([Buffer.concat(localParts), centralBuffer, end]);
}

fs.mkdirSync(SITE_DIR, { recursive: true });
const entries = [];
const details = [];

SITE_FILES.forEach((name) => {
  const from = path.join(PUBLIC_DIR, name);
  if (!fs.existsSync(from)) throw new Error('缺少文件：' + from);
  const data = fs.readFileSync(from);
  fs.writeFileSync(path.join(SITE_DIR, name), data);
  entries.push({ name: name, data: data });
  details.push({ name: name, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex').toUpperCase() });
});

entries.push({ name: '使用说明-部署.txt', data: DEPLOY_NOTE });

const zip = buildZip(entries);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(ZIP_PATH, zip);

console.log('静态托管版文件已生成');
console.log('  网站目录：' + SITE_DIR);
console.log('  压缩包：  ' + ZIP_PATH + '（' + (zip.length / 1024).toFixed(1) + ' KB，' + entries.length + ' 个文件）');
console.log('  zip 内文件（根目录直接是 index.html）：');
entries.forEach((entry) => {
  const info = details.filter((d) => d.name === entry.name)[0];
  const size = info ? info.size : Buffer.byteLength(entry.data);
  console.log('    - ' + entry.name + '  ' + size + ' 字节' + (info ? '  sha256=' + info.sha256.slice(0, 16) + '…' : ''));
});
console.log('  压缩包 sha256：' + crypto.createHash('sha256').update(zip).digest('hex').toUpperCase());
