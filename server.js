'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { openDatabase } = require('./src/db');
const { createApi } = require('./src/api');

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(ROOT_DIR, 'data', 'tracker.db');
const MAX_BODY_BYTES = 1024 * 1024;

const db = openDatabase(DB_PATH);
const sseClients = new Set();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function notify(payload) {
  const data = JSON.stringify(payload || {});
  for (const client of sseClients) {
    try {
      client.write('event: change\ndata: ' + data + '\n\n');
    } catch (err) {
      sseClients.delete(client);
    }
  }
}

const api = createApi({ db: db, notify: notify });

function sendJson(res, status, body) {
  const text = JSON.stringify(body === undefined ? null : body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendText(res, status, text, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function handleSse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write('event: ready\ndata: {"ok":true}\n\n');
  sseClients.add(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (err) {
      clearInterval(heartbeat);
      sseClients.delete(res);
    }
  }, 25000);
  const cleanup = () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
}

function serveStatic(req, res, pathname) {
  let relative = pathname;
  if (relative === '/' || relative === '') relative = '/index.html';
  const target = path.normalize(path.join(PUBLIC_DIR, relative));
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    sendText(res, 403, '403 Forbidden');
    return;
  }
  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      sendText(res, 404, '404 Not Found：' + pathname);
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': stat.size,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(target).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  let url = null;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch (err) {
    sendText(res, 400, '400 Bad Request');
    return;
  }
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/api/events') {
    handleSse(req, res);
    return;
  }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    readBody(req)
      .then((raw) => {
        let body = {};
        if (raw && raw.trim()) {
          try {
            body = JSON.parse(raw);
          } catch (err) {
            sendJson(res, 400, { error: '请求体不是合法 JSON' });
            return;
          }
        }
        const query = {};
        url.searchParams.forEach((value, key) => {
          query[key] = value;
        });
        let result = null;
        try {
          result = api({ method: req.method, pathname: pathname, query: query, body: body, rawBody: raw });
        } catch (err) {
          sendJson(res, 500, { error: err && err.message ? err.message : '服务器内部错误' });
          return;
        }
        if (!result) {
          sendJson(res, 404, { error: '接口不存在：' + pathname });
          return;
        }
        sendJson(res, result.status, result.body);
      })
      .catch(() => {
        if (!res.headersSent) sendJson(res, 413, { error: '请求体过大' });
      });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: '仅支持 GET / HEAD：' + pathname });
    return;
  }
  serveStatic(req, res, pathname);
});

function lanAddresses() {
  const list = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) list.push(info.address);
    }
  }
  return list;
}

server.listen(PORT, HOST, () => {
  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : PORT;
  const students = db.prepare('SELECT COUNT(*) AS c FROM students').get().c;
  const tasks = db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c;
  console.log('==============================================');
  console.log(' 班主任作业追踪 已启动');
  console.log(' 本机（电脑）访问: http://localhost:' + actualPort);
  const lan = lanAddresses();
  if (lan.length) {
    for (const ip of lan) {
      console.log(' 手机访问（与电脑同一 Wi-Fi）: http://' + ip + ':' + actualPort);
    }
  } else {
    console.log(' 手机访问: 未检测到局域网 IPv4 地址');
  }
  console.log(' 数据库文件: ' + DB_PATH);
  console.log(' 当前名单人数: ' + students + '，任务数: ' + tasks);
  console.log('==============================================');
  console.log('LISTENING port=' + actualPort);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('启动失败：端口 ' + PORT + ' 已被占用，请用 PORT=3001 node server.js 换一个端口。');
  } else {
    console.error('启动失败：', err);
  }
  process.exit(1);
});

function shutdown() {
  console.log('\n正在关闭服务…');
  for (const client of sseClients) {
    try { client.end(); } catch (err) { /* ignore */ }
  }
  server.close(() => {
    try { db.close(); } catch (err) { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);