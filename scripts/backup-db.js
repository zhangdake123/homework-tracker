'use strict';
// 备份 SQLite 数据库：用 SQLite 自带的 VACUUM INTO，热备份也安全
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const appDir = process.env.APP_DIR ? path.resolve(process.env.APP_DIR) : path.resolve(__dirname, '..');
const dbFile = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(appDir, 'data', 'tracker.db');
const outDir = path.join(appDir, 'data', 'backups');
const keep = Number(process.env.KEEP || 14);

if (!fs.existsSync(dbFile)) {
  console.error('找不到数据库文件：' + dbFile);
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + '_' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
const target = path.join(outDir, 'tracker-' + stamp + '.db');

// VACUUM INTO 要求目标文件不存在；同一秒内重复运行就覆盖上一次
if (fs.existsSync(target)) fs.unlinkSync(target);

const db = new DatabaseSync(dbFile);
db.exec('VACUUM INTO ' + "'" + target.replace(/'/g, "''") + "'");
db.close();

const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.db')).sort().reverse();
for (const f of files.slice(keep)) fs.unlinkSync(path.join(outDir, f));
console.log('备份完成：' + target + '（保留最近 ' + keep + ' 份）');
