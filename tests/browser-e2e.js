'use strict';

/*
 * 真实浏览器 E2E：用系统 Edge 的 CDP 接口打开 outputs/static-site 里的真实页面，
 * 注入一个「假云开发 SDK」（数据存在 localStorage，跨标签页用 BroadcastChannel 推送，
 * 用来替代需要账号才能用的云开发环境），然后像老师一样真的点按钮，
 * 验证业务规则、手机/电脑同步、刷新后数据保留、页面没有 JS 报错。
 *
 * 前置：先跑 npm run build:static 生成 outputs/static-site；
 *       需要本机装有 Microsoft Edge（没找到就跳过，不算失败）；
 *       不需要联网。
 * 产物：outputs/screenshots/*.png
 *
 * 说明：真实云开发环境需要老师自己的账号，自动化连不上，
 *       所以这里只把「云开发数据库」换成假实现，页面代码（app.js / store-core.js /
 *       store-cloudbase.js）全部是真实文件，浏览器也是真实浏览器。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SITE_DIR = path.join(ROOT, 'outputs', 'static-site');
const SHOT_DIR = path.join(ROOT, 'outputs', 'screenshots');
const STUB = fs.readFileSync(path.join(__dirname, 'browser-e2e-stub.js'), 'utf8');
function findEdge() {
  if (process.env.EDGE_PATH && fs.existsSync(process.env.EDGE_PATH)) return process.env.EDGE_PATH;
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['ProgramFiles'] || 'C:/Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['ProgramFiles'] || 'C:/Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  for (const item of candidates) { if (fs.existsSync(item)) return item; }
  return null;
}
const EDGE = findEdge();
// 浏览器临时配置目录放系统临时目录，别污染仓库
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-e2e-profile-'));
const DEBUG_PORT = 9333;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; failures.push(name + (detail ? ' -> ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : '')); }
}
function section(title) { console.log('\n=== ' + title + ' ==='); }

// 注入到页面的辅助函数（在页面上下文里跑）
const HELPERS = [
  'window.__e2e = {',
  '  click: function (sel) { var el = document.querySelector(sel); if (!el) throw new Error("找不到元素 " + sel); el.click(); return true; },',
  '  byAction: function (action, attrs) {',
  '    var list = document.querySelectorAll("[data-action=" + JSON.stringify(action) + "]");',
  '    for (var i = 0; i < list.length; i += 1) {',
  '      var el = list[i]; var ok = true;',
  '      Object.keys(attrs || {}).forEach(function (key) { if (el.getAttribute(key) !== String(attrs[key])) ok = false; });',
  '      if (ok) return el;',
  '    }',
  '    return null;',
  '  },',
  '  act: function (action, attrs) { var el = window.__e2e.byAction(action, attrs); if (!el) throw new Error("找不到按钮 " + action + " " + JSON.stringify(attrs)); el.click(); return true; },',
  '  setInput: function (id, value) { var el = document.getElementById(id); el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true; },',
  '  view: function (name) { var el = document.querySelector(".tab[data-view=" + JSON.stringify(name) + "]"); if (!el) throw new Error("找不到标签 " + name); el.click(); return true; },',
  '  boot: function () { return window.HomeworkBackend.request("/api/bootstrap"); },',
  '  taskList: function () { return window.HomeworkBackend.request("/api/tasks"); },',
  '  taskHistory: function (id) { return window.HomeworkBackend.request("/api/tasks/" + id + "/history"); },',
  '  allHistory: function () { return window.HomeworkBackend.request("/api/history"); },',
  '  find: function (b, part) { return b.tasks.filter(function (t) { return t.title.indexOf(part) !== -1; })[0]; },',
  '  student: function (b, no) { return b.students.filter(function (s) { return s.studentNo === no; })[0]; },',
  '  taskId: function (part) { return window.__e2e.boot().then(function (b) { var t = window.__e2e.find(b, part); if (!t) throw new Error("没有任务 " + part); return t.id; }); },',
  '  sid: function (no) { return window.__e2e.boot().then(function (b) { var s = window.__e2e.student(b, no); if (!s) throw new Error("没有学号 " + no); return s.id; }); },',
  '  statusOf: function (part, no) {',
  '    return window.__e2e.boot().then(function (b) {',
  '      var t = window.__e2e.find(b, part); var s = window.__e2e.student(b, no);',
  '      if (!t || !s) return "missing";',
  '      var a = t.assignments.filter(function (x) { return x.studentId === s.id; })[0];',
  '      return a ? a.status : "none";',
  '    });',
  '  },',
  '  taskInfo: function (part) {',
  '    return window.__e2e.boot().then(function (b) {',
  '      var t = window.__e2e.find(b, part);',
  '      return t ? { id: t.id, title: t.title, taskDate: t.taskDate, pendingCount: t.pendingCount, daysPending: t.daysPending, counts: t.counts, status: t.status } : null;',
  '    });',
  '  },',
  '  totalTasks: function () { return window.__e2e.boot().then(function (b) { return b.tasks.length; }); },',
  '  historyTotal: function () { return window.__e2e.allHistory().then(function (h) { return Array.isArray(h) ? h.length : (h && h.items ? h.items.length : -1); }); },',
  '  chip: function (taskId, studentId) {',
  '    var list = document.querySelectorAll("#boardList .st-chip");',
  '    for (var i = 0; i < list.length; i += 1) {',
  '      var el = list[i];',
  '      if (Number(el.getAttribute("data-student")) === studentId && Number(el.getAttribute("data-task")) === taskId) return el;',
  '    }',
  '    return null;',
  '  },',
  '  chipClass: function (taskId, studentId) { var el = window.__e2e.chip(taskId, studentId); return el ? el.className : "missing"; },',
  '  clickChip: function (taskId, studentId) { var el = window.__e2e.chip(taskId, studentId); if (!el) throw new Error("看板上找不到学号 " + studentId); el.click(); return true; },',
  '  boardText: function () { var el = document.getElementById("boardList"); return el ? el.textContent : ""; },',
  '  boardCards: function () { return document.querySelectorAll("#boardList .task-card").length; },',
  '  clearSelection: function () { var btn = document.getElementById("btnClearSel"); if (btn) btn.click(); return true; },',
  '  selectStudents: function (ids) {',
  '    window.__e2e.clearSelection();',
  '    ids.forEach(function (id) { var el = window.__e2e.byAction("mark-chip", { "data-student": id }); if (!el) throw new Error("找不到学号 " + id); el.click(); });',
  '    return true;',
  '  },',
  '  dateOffset: function (days) { var d = new Date(); d.setDate(d.getDate() - days); var s = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); document.getElementById("taskDate").value = s; return s; },',
  '  confirmOn: function () { window.confirm = function () { return true; }; window.alert = function () {}; return true; },',
  '  createTask: function (book, lesson, content) {',
  '    window.__e2e.view("register");',
  '    window.__e2e.setInput("bookInput", book);',
  '    window.__e2e.setInput("lessonInput", lesson);',
  '    window.__e2e.setInput("contentInput", content);',
  '    document.getElementById("btnCreateTask").click();',
  '    return true;',
  '  },',
  '  markPanelOpen: function () { var p = document.getElementById("markPanel"); return !!p && !p.hidden; },',
  '  toast: function () { var el = document.getElementById("toast"); return el ? el.textContent : ""; },',
  '};',
  'true;'
].join('\n');

function serveStatic() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const target = path.normalize(path.join(SITE_DIR, rel));
    if (!target.startsWith(SITE_DIR)) { res.writeHead(403); res.end('403'); return; }
    fs.readFile(target, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, base: 'http://127.0.0.1:' + server.address().port, close: () => server.close() }));
  });
}

async function waitEndpoint(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return await resp.json();
      last = 'HTTP ' + resp.status;
    } catch (err) { last = err.message; }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('等待 ' + url + ' 超时：' + last);
}

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.waiters = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (ev) => reject(new Error('CDP WebSocket 出错')));
      this.ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const entry = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(msg.method + ' ' + JSON.stringify(msg.error)));
          else entry.resolve(msg.result);
          return;
        }
        if (msg.method) {
          this.waiters.slice().forEach((w) => w(msg));
        }
      });
    });
  }
  send(method, params, sessionId) {
    const id = (this.id += 1);
    const payload = { id: id, method: method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve, reject: reject });
      this.ws.send(JSON.stringify(payload));
    });
  }
  on(fn) { this.waiters.push(fn); }
  off(fn) { this.waiters = this.waiters.filter((w) => w !== fn); }
}

async function openPage(cdp, url) {
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
  const sid = attached.sessionId;
  const page = { sid: sid, targetId: created.targetId, jsErrors: [], cdp: cdp };
  const collector = (msg) => {
    if (msg.sessionId !== sid) return;
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      page.jsErrors.push((d.exception && d.exception.description) || d.text || 'unknown');
    }
  };
  cdp.on(collector);
  await cdp.send('Page.enable', {}, sid);
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB }, sid);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS }, sid);
  await cdp.send('Page.navigate', { url: url }, sid);
  return page;
}

function makeApi(page) {
  const cdp = page.cdp;
  const evalIn = async (expression) => {
    const res = await cdp.send('Runtime.evaluate', { expression: expression, returnByValue: true, awaitPromise: true }, page.sid);
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error('页面执行出错：' + ((d.exception && d.exception.description) || d.text));
    }
    return res.result.value;
  };
  return {
    eval: evalIn,
    async waitUntil(expression, timeoutMs, label) {
      const deadline = Date.now() + (timeoutMs || 8000);
      let last = null;
      while (Date.now() < deadline) {
        last = await evalIn('(async function () { return !!(await (' + expression + ')); })()');
        if (last === true) return true;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error('等待超时：' + (label || expression));
    },
    async waitReady(timeoutMs) {
      await evalIn('(function () { return document.readyState; })()');
      await this.waitUntil('window.HomeworkCloud && window.HomeworkCloud.status === "ready"', timeoutMs || 15000, '云开发连接就绪');
      return evalIn('(function () { return { status: window.HomeworkCloud.status, env: window.HomeworkCloud.env, mode: window.HomeworkBackend && window.HomeworkBackend.mode, label: window.HomeworkBackend && window.HomeworkBackend.label }; })()');
    },
    async screenshot(file) {
      const res = await cdp.send('Page.captureScreenshot', { format: 'png' }, page.sid);
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(SHOT_DIR, file), Buffer.from(res.data, 'base64'));
      return path.join(SHOT_DIR, file);
    },
    async setViewport(width, height, mobile) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: width, height: height, deviceScaleFactor: 1, mobile: !!mobile }, page.sid);
    },
    async reload() {
      await cdp.send('Page.reload', {}, page.sid);
      await new Promise((r) => setTimeout(r, 400));
    },
    async close() {
      await cdp.send('Target.closeTarget', { targetId: page.targetId });
    }
  };
}

(async function run() {
  if (!EDGE) {
    console.log('跳过：本机没有找到 Edge / Chrome（可以用 EDGE_PATH 环境变量指定浏览器路径）');
    console.log('\n==============================');
    console.log('跳过（未找到浏览器），不算失败');
    console.log('==============================');
    process.exit(0);
  }
  if (!fs.existsSync(path.join(SITE_DIR, 'index.html'))) {
    console.log('跳过：还没有生成 outputs/static-site，请先执行 npm run build:static');
    console.log('\n==============================');
    console.log('跳过（缺少静态站点产物），不算失败');
    console.log('==============================');
    process.exit(0);
  }
  const site = await serveStatic();
  const base = site.base + '/index.html?env=e2e-env-1';
  let edge = null;
  let cdp = null;
  let phone = null;
  let desktop = null;
  const screenshots = [];
  try {
    edge = spawn(EDGE, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars',
      '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + PROFILE,
      '--remote-debugging-port=' + DEBUG_PORT,
      'about:blank'
    ], { stdio: 'ignore' });

    const version = await waitEndpoint('http://127.0.0.1:' + DEBUG_PORT + '/json/version', 30000);
    console.log('已有浏览器：' + version.Browser);
    cdp = new CDP(version.webSocketDebuggerUrl);
    await cdp.connect();

    const scratch = await openPage(cdp, base);
    const scratchApi = makeApi(scratch);
    await scratchApi.waitUntil('!!window.__e2e', 10000, '注入脚本');
    await scratchApi.eval('localStorage.clear(); true');
    await scratchApi.close();

    section('A 手机端打开静态页面（假云开发 SDK，真实浏览器）');
    const phonePage = await openPage(cdp, base);
    const phoneApi = makeApi(phonePage);
    const info = await phoneApi.waitReady(20000);
    check('页面连上云开发（status=ready）', info.status === 'ready', JSON.stringify(info));
    check('数据源是云开发数据库（不是本机 /api）', info.mode === 'cloudbase' && info.label === '云开发数据库', JSON.stringify(info));
    check('读到环境 ID', info.env === 'e2e-env-1', String(info.env));
    const basics = await phoneApi.eval('(function () { return { title: document.title, tabs: document.querySelectorAll(".tab").length, env: window.HomeworkCloud.env }; })()');
    check('页面标题正确', basics.title === '班主任作业追踪', basics.title);
    check('三个标签页都在（登记 / 看板 / 名单设置）', basics.tabs === 3, 'tabs=' + basics.tabs);
    const empty = await phoneApi.eval('window.__e2e.boot().then(function (b) { return { students: b.students.length, tasks: b.tasks.length, classSize: b.settings.classSize }; })');
    check('空数据库自动生成 38 个虚拟学号', empty.students === 38 && empty.tasks === 0, JSON.stringify(empty));

    section('B 手机端用界面创建任务（A册·第3课·抄写）');
    await phoneApi.eval('window.__e2e.confirmOn()');
    await phoneApi.eval('window.__e2e.createTask("A册", "第3课", "抄写")');
    await phoneApi.waitUntil('window.__e2e.markPanelOpen()', 8000, '创建任务后打开标记面板');
    const justCreated = await phoneApi.eval('window.__e2e.taskInfo("A册·第3课")');
    check('任务标题自动组合为「A册·第3课·抄写作业」', justCreated && justCreated.title === 'A册·第3课·抄写作业', justCreated && justCreated.title);
    check('自动生成全班 38 条学生记录', justCreated && justCreated.counts.total === 38, JSON.stringify(justCreated && justCreated.counts));
    check('创建后 38 人全部未完成', justCreated && justCreated.pendingCount === 38, String(justCreated && justCreated.pendingCount));

    section('C 电脑端打开同一个网址（第二个标签页，看板）');
    const desktopPage = await openPage(cdp, base + '#board');
    const desktopApi = makeApi(desktopPage);
    await desktopApi.waitReady(20000);
    await desktopApi.eval('window.__e2e.view("board")');
    await desktopApi.waitUntil('window.__e2e.boardCards() === 1', 8000, '电脑端看板显示 1 个任务');
    check('电脑端能看到手机刚创建的任务', (await desktopApi.eval('window.__e2e.boardText()')).indexOf('A册·第3课·抄写作业') !== -1);
    const taskId1 = await phoneApi.eval('window.__e2e.taskId("A册·第3课")');

    section('D 手机端点选学号：01/02/03 全对已完成，07 未收到');
    const sid1 = await phoneApi.eval('window.__e2e.sid("01")');
    const sid2 = await phoneApi.eval('window.__e2e.sid("02")');
    const sid3 = await phoneApi.eval('window.__e2e.sid("03")');
    const sid7 = await phoneApi.eval('window.__e2e.sid("07")');
    const sid5 = await phoneApi.eval('window.__e2e.sid("05")');
    await phoneApi.eval('window.__e2e.selectStudents([' + sid1 + ',' + sid2 + ',' + sid3 + '])');
    await phoneApi.eval('window.__e2e.act("mark-apply", { "data-status": "done" })');
    await phoneApi.waitUntil('(await window.__e2e.statusOf("A册·第3课", "03")) === "done"', 8000, '批量标记为已完成');
    check('批量把 01/02/03 标记为已完成', (await phoneApi.eval('Promise.all([window.__e2e.statusOf("A册·第3课", "01"), window.__e2e.statusOf("A册·第3课", "02"), window.__e2e.statusOf("A册·第3课", "03")])')).join(',') === 'done,done,done');
    await phoneApi.eval('window.__e2e.selectStudents([' + sid7 + '])');
    await phoneApi.eval('window.__e2e.act("mark-apply", { "data-status": "not_received" })');
    await phoneApi.waitUntil('(await window.__e2e.statusOf("A册·第3课", "07")) === "not_received"', 8000, '标记 07 未收到');
    const afterMark = await phoneApi.eval('window.__e2e.taskInfo("A册·第3课")');
    check('已完成 3 人后未完成剩 35 人', afterMark.pendingCount === 35, 'pending=' + afterMark.pendingCount);
    check('已完成的学生不在未完成统计里', afterMark.counts.done === 3 && !afterMark.counts.pendingDisabled, JSON.stringify(afterMark.counts));

    section('E 电脑端自动同步（手机改完，电脑端看板跟着变）');
    await desktopApi.waitUntil('window.__e2e.chipClass(' + taskId1 + ', ' + sid7 + ').indexOf("s-not_received") !== -1', 10000, '电脑端出现 07 未收到');
    check('电脑端看板自动显示 07 为「未收到」', true);
    await desktopApi.waitUntil('window.__e2e.chipClass(' + taskId1 + ', ' + sid1 + ') === "missing"', 8000, '已完成学生从看板消失');
    check('电脑端看板不再显示已完成的 01（全对的学生被排除在待办之外）', true);
    check('电脑端看板显示未完成 35 人', (await desktopApi.eval('document.querySelectorAll("#boardList .st-chip").length')) === 35, 'chips=' + (await desktopApi.eval('document.querySelectorAll("#boardList .st-chip").length')));

    section('F 反复订正：05 待批改 → 退回（待订正）→ 交回（待批改）→ 再退回（待交回）');
    await phoneApi.eval('window.__e2e.view("board")');
    await phoneApi.waitUntil('window.__e2e.chip(' + taskId1 + ', ' + sid5 + ') !== null', 8000, '看板上找到 05');
    await phoneApi.eval('window.__e2e.act("detail", { "data-task": ' + taskId1 + ' })');
    await phoneApi.waitUntil('!!document.getElementById("detailList") && document.getElementById("detailList").querySelectorAll("[data-action=d-one-return]").length > 0', 8000, '详情页加载');
    await phoneApi.eval('window.__e2e.act("d-one-return", { "data-student": ' + sid5 + ' })');
    await phoneApi.waitUntil('(await window.__e2e.statusOf("A册·第3课", "05")) === "to_correct"', 8000, '第一次退回 → 待订正');
    check('第一次退回 → 待订正', true);
    await phoneApi.eval('window.__e2e.view("board")');
    await phoneApi.eval('window.__e2e.clickChip(' + taskId1 + ', ' + sid5 + ')');
    await phoneApi.waitUntil('!!window.__e2e.byAction("sheet-status", { "data-status": "to_grade" })', 8000, '打开学生状态面板');
    await phoneApi.eval('window.__e2e.act("sheet-status", { "data-status": "to_grade" })');
    await phoneApi.waitUntil('(await window.__e2e.statusOf("A册·第3课", "05")) === "to_grade"', 8000, '交回 → 待批改');
    check('交回后 → 待批改', true);
    await phoneApi.eval('window.__e2e.act("detail", { "data-task": ' + taskId1 + ' })');
    await phoneApi.waitUntil('!!window.__e2e.byAction("d-one-return", { "data-student": ' + sid5 + ' })', 8000, '详情页再次打开');
    await phoneApi.eval('window.__e2e.act("d-one-return", { "data-student": ' + sid5 + ' })');
    await phoneApi.waitUntil('(await window.__e2e.statusOf("A册·第3课", "05")) === "to_return"', 8000, '再次退回 → 待交回');
    check('已经订正过再退回 → 待交回', true);

    section('G 跨天 + 新课次：旧任务不消失、不自动完成');
    await phoneApi.eval('window.__e2e.view("register")');
    await phoneApi.eval('window.__e2e.dateOffset(3)');
    await phoneApi.eval('window.__e2e.createTask("B册", "第4课", "练习")');
    await phoneApi.waitUntil('(await window.__e2e.taskInfo("B册·第4课")) !== null', 8000, '创建 B册 任务');
    const day3 = await phoneApi.eval('window.__e2e.taskInfo("B册·第4课")');
    check('3 天前创建的任务显示「已持续 3 天」', day3.daysPending === 3, 'daysPending=' + day3.daysPending);
    await phoneApi.eval('window.__e2e.dateOffset(0)');
    await phoneApi.eval('window.__e2e.createTask("A册", "第4课", "抄写")');
    await phoneApi.waitUntil('(await window.__e2e.totalTasks()) === 3', 8000, '三个任务并存');
    const stillThere = await phoneApi.eval('window.__e2e.taskInfo("A册·第3课")');
    check('新课次开始后旧课次任务仍然存在', stillThere !== null, '第3课任务=' + JSON.stringify(stillThere && stillThere.title));
    check('旧任务的未完成人数没有被新课次改变', stillThere.pendingCount === 35, 'pending=' + stillThere.pendingCount);
    check('旧任务没有被自动标记为完成', stillThere.status === 'open', 'status=' + stillThere.status);
    await desktopApi.waitUntil('window.__e2e.boardCards() === 3', 12000, '电脑端出现 3 个任务卡片');
    check('电脑端同步出现 3 个任务（含旧课次遗留任务）', true);
    const stale = await desktopApi.eval('document.querySelectorAll("#boardList .task-card.stale").length');
    check('电脑端把持续 3 天以上的任务标为「遗留」', stale >= 1, 'stale=' + stale);

    section('H 未收到 → 交回 → 待批改（手机改，电脑端同步）');
    await phoneApi.eval('window.__e2e.view("board")');
    await phoneApi.eval('window.__e2e.clickChip(' + taskId1 + ', ' + sid7 + ')');
    await phoneApi.waitUntil('!!window.__e2e.byAction("sheet-status", { "data-status": "to_grade" })', 8000, '打开 07 的面板');
    await phoneApi.eval('window.__e2e.act("sheet-status", { "data-status": "to_grade" })');
    await phoneApi.waitUntil('(await window.__e2e.statusOf("A册·第3课", "07")) === "to_grade"', 8000, '未收到 → 待批改');
    check('「未收到」可以改成「待批改」（学生第二天交来）', true);
    await desktopApi.waitUntil('window.__e2e.chipClass(' + taskId1 + ', ' + sid7 + ').indexOf("s-to_grade") !== -1', 10000, '电脑端同步为待批改');
    check('电脑端自动同步为「待批改」', true);

    section('I 未收到 与 待交回 必须区分（同时留在待办里）');
    const sid9 = await phoneApi.eval('window.__e2e.sid("09")');
    const sid12 = await phoneApi.eval('window.__e2e.sid("12")');
    const taskId2 = await phoneApi.eval('window.__e2e.taskId("B册·第4课")');
    await phoneApi.eval('window.__e2e.view("register")');
    await phoneApi.eval('window.__e2e.act("open-mark", { "data-task": ' + taskId2 + ' })');
    await phoneApi.waitUntil('window.__e2e.markPanelOpen()', 8000, '打开 B册 的标记面板');
    await phoneApi.eval('window.__e2e.selectStudents([' + sid9 + '])');
    await phoneApi.eval('window.__e2e.act("mark-apply", { "data-status": "not_received" })');
    await phoneApi.waitUntil('(await window.__e2e.statusOf("B册·第4课", "09")) === "not_received"', 8000, '09 未收到');
    await phoneApi.eval('window.__e2e.selectStudents([' + sid12 + '])');
    await phoneApi.eval('window.__e2e.act("mark-apply", { "data-status": "to_grade" })');
    await phoneApi.waitUntil('(await window.__e2e.statusOf("B册·第4课", "12")) === "to_grade"', 8000, '12 待批改');
    await phoneApi.eval('window.__e2e.view("board")');
    await phoneApi.eval('window.__e2e.act("detail", { "data-task": ' + taskId2 + ' })');
    await phoneApi.waitUntil('!!window.__e2e.byAction("d-one-return", { "data-student": ' + sid12 + ' })', 8000, '详情页打开');
    await phoneApi.eval('window.__e2e.act("d-one-return", { "data-student": ' + sid12 + ' })');
    await phoneApi.waitUntil('(await window.__e2e.statusOf("B册·第4课", "12")) === "to_correct"', 8000, '12 退回待订正');
    await phoneApi.eval('window.__e2e.act("d-one-return", { "data-student": ' + sid12 + ' })');
    await phoneApi.waitUntil('(await window.__e2e.statusOf("B册·第4课", "12")) === "to_return"', 8000, '12 待交回');
    const pair = await phoneApi.eval('Promise.all([window.__e2e.statusOf("B册·第4课", "09"), window.__e2e.statusOf("B册·第4课", "12")])');
    check('09 是「未收到」、12 是「待交回」，两者互不影响', pair[0] === 'not_received' && pair[1] === 'to_return', pair.join(' / '));
    check('两者都还没完成（都留在待办看板上）', pair[0] !== 'done' && pair[1] !== 'done');
    const boardBoth = await phoneApi.eval('window.__e2e.boardText()');
    check('看板上同时出现这两个学生', boardBoth.indexOf('09') !== -1 && boardBoth.indexOf('12') !== -1);

    section('J 批量操作不会改到别的课次 + 已完成任务默认隐藏');
    await phoneApi.eval('window.__e2e.view("register")');
    const taskId3 = await phoneApi.eval('window.__e2e.taskId("A册·第4课")');
    await phoneApi.eval('window.__e2e.act("open-mark", { "data-task": ' + taskId3 + ' })');
    await phoneApi.waitUntil('window.__e2e.markPanelOpen()', 8000, '打开 A册·第4课 面板');
    await phoneApi.eval('window.__e2e.selectStudents([' + sid1 + ',' + sid2 + '])');
    await phoneApi.eval('window.__e2e.act("mark-apply", { "data-status": "not_received" })');
    await phoneApi.waitUntil('(await window.__e2e.statusOf("A册·第4课", "01")) === "not_received"', 8000, '第4课 01 改未收到');
    const untouched = await phoneApi.eval('Promise.all([window.__e2e.statusOf("A册·第3课", "01"), window.__e2e.statusOf("B册·第4课", "01")])');
    check('批量标记只改目标课次，第3课/第B册的 01 不受影响', untouched[0] === 'done' && untouched[1] === 'to_grade', untouched.join(' / '));
    await phoneApi.eval('window.__e2e.view("register")');
    await phoneApi.eval('window.__e2e.createTask("C册", "第5课", "订正")');
    await phoneApi.waitUntil('(await window.__e2e.taskInfo("C册·第5课")) !== null', 8000, '创建 C册 任务');
    const taskId4 = await phoneApi.eval('window.__e2e.taskId("C册·第5课")');
    await phoneApi.eval('window.__e2e.view("board")');
    await phoneApi.eval('window.__e2e.act("detail", { "data-task": ' + taskId4 + ' })');
    await phoneApi.waitUntil('!!window.__e2e.byAction("d-pass-all", {})', 8000, '详情页全部通过按钮');
    await phoneApi.eval('window.__e2e.act("d-pass-all", {})');
    await phoneApi.waitUntil('(await window.__e2e.taskInfo("C册·第5课")).pendingCount === 0', 10000, '全班已完成');
    check('老师确认通过后整班进入「已完成」', true);
    await phoneApi.eval('window.__e2e.view("board")');
    await phoneApi.waitUntil('window.__e2e.boardText().indexOf("C册·第5课") === -1', 8000, '已完成任务从默认看板隐藏');
    check('已完成的任务从默认待办看板隐藏', true);
    await phoneApi.eval('document.getElementById("showDone").click()');
    await phoneApi.waitUntil('window.__e2e.boardText().indexOf("C册·第5课") !== -1', 8000, '勾选后重新显示');
    check('勾选「显示已完成任务」后仍能查到', true);
    await phoneApi.eval('document.getElementById("showDone").click()');

    section('K 关闭网页再打开：数据仍然保留');
    const before = await phoneApi.eval('Promise.all([window.__e2e.totalTasks(), window.__e2e.historyTotal()])');
    await phoneApi.reload();
    await phoneApi.waitReady(20000);
    const after = await phoneApi.eval('Promise.all([window.__e2e.totalTasks(), window.__e2e.historyTotal()])');
    check('重新打开网页后任务数一致', before[0] === after[0] && after[0] === 4, before[0] + ' -> ' + after[0]);
    check('重新打开网页后历史记录数一致', before[1] === after[1], before[1] + ' -> ' + after[1]);
    const persisted = await phoneApi.eval('Promise.all([window.__e2e.statusOf("A册·第3课", "05"), window.__e2e.statusOf("B册·第4课", "12")])');
    check('重新打开后「待交回」仍然是待交回（不会被重置）', persisted[0] === 'to_return' && persisted[1] === 'to_return', persisted.join(' / '));

    section('L 历史记录：原状态、新状态、时间都留下了');
    const hist = await phoneApi.eval('window.__e2e.taskHistory(' + taskId1 + ')');
    const rows = Array.isArray(hist) ? hist : (hist.history || hist.items || []);
    const notReceivedToGrade = rows.filter((h) => h.fromStatus === 'not_received' && h.toStatus === 'to_grade');
    check('07 的「未收到 → 待批改」写进了历史', notReceivedToGrade.length >= 1, 'rows=' + rows.length);
    check('历史里带原状态、新状态和更新时间', notReceivedToGrade.length > 0 && !!notReceivedToGrade[0].changedAt && !!notReceivedToGrade[0].toStatus, JSON.stringify(notReceivedToGrade[0] || {}));
    const backAndForth = rows.filter((h) => h.studentId === sid5).map((h) => h.fromStatus + '→' + h.toStatus);
    check('05 的反复订正链路在历史里完整保留（待批改→待订正→待批改→待交回）',
      backAndForth.join(' | ').indexOf('to_grade→to_correct') !== -1 &&
      backAndForth.join(' | ').indexOf('to_correct→to_grade') !== -1 &&
      backAndForth.join(' | ').indexOf('to_grade→to_return') !== -1, backAndForth.join(' | '));

    section('M 页面没有 JS 报错 + 截图');
    check('手机端页面没有未捕获的 JS 异常', phonePage.jsErrors.length === 0, phonePage.jsErrors.join(' /// '));
    check('电脑端页面没有未捕获的 JS 异常', desktopPage.jsErrors.length === 0, desktopPage.jsErrors.join(' /// '));
    await desktopApi.setViewport(1280, 900, false);
    await new Promise((r) => setTimeout(r, 500));
    screenshots.push(await desktopApi.screenshot('board-desktop.png'));
    await phoneApi.setViewport(390, 844, true);
    await phoneApi.eval('window.__e2e.view("register")');
    await new Promise((r) => setTimeout(r, 500));
    screenshots.push(await phoneApi.screenshot('register-mobile.png'));
    await desktopApi.eval('window.__e2e.act("detail", { "data-task": ' + taskId1 + ' })');
    await new Promise((r) => setTimeout(r, 800));
    screenshots.push(await desktopApi.screenshot('detail-desktop.png'));
    check('生成了 3 张界面截图', screenshots.length === 3, screenshots.join(', '));
  } catch (err) {
    fail += 1;
    failures.push('运行中断：' + err.message);
    console.log('\n!! 运行中断：' + err.stack);
  } finally {
    if (cdp && cdp.ws) { try { cdp.ws.close(); } catch (e) {} }
    if (edge) { try { edge.kill(); } catch (e) {} }
    site.close();
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n==============================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('==============================');
  if (failures.length) { console.log('\n失败项：'); failures.forEach((f) => console.log('  - ' + f)); }
  if (screenshots.length) { console.log('\n截图：'); screenshots.forEach((s) => console.log('  - ' + s)); }
  process.exit(fail ? 1 : 0);
})();
