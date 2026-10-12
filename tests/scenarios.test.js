'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-tracker-test-'));
const DB_FILE = path.join(TMP_DIR, 'tracker.db');

let passCount = 0;
let failCount = 0;
const failures = [];
let currentScenario = '';

function scenario(title) {
  currentScenario = title;
  console.log('\n=== ' + title + ' ===');
}

function check(name, condition, detail) {
  if (condition) {
    passCount += 1;
    console.log('  PASS  ' + name);
  } else {
    failCount += 1;
    failures.push(currentScenario + ' / ' + name + (detail ? ' -> ' + detail : ''));
    console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : ''));
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { PORT: '0', HOST: '127.0.0.1', DB_PATH: DB_FILE }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('服务启动超时: ' + out)); }, 20000);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      const match = out.match(/LISTENING port=(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ child: child, port: Number(match[1]) });
      }
    });
    child.stderr.on('data', (chunk) => { out += chunk.toString(); });
    child.on('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error('服务异常退出 code=' + code + '\n' + out));
      }
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.child) { resolve(); return; }
    server.child.once('exit', () => resolve());
    server.child.kill();
    setTimeout(resolve, 3000);
  });
}

let base = '';

async function req(pathname, method, body) {
  const options = { method: method || 'GET', headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined && body !== null) options.body = JSON.stringify(body);
  const res = await fetch(base + pathname, options);
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (err) { data = null; } }
  return { status: res.status, body: data };
}

async function getTask(id) {
  const res = await req('/api/tasks/' + id);
  return res.body.task;
}

async function fetchTasks(query) {
  const res = await req('/api/tasks' + (query || ''));
  return res.body.tasks;
}

function assignmentOf(task, studentNo) {
  return task.assignments.filter((a) => a.studentNo === studentNo)[0];
}

function studentIdOf(bootstrap, studentNo) {
  const found = bootstrap.students.filter((s) => s.studentNo === studentNo)[0];
  return found ? found.id : null;
}

function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

async function waitForSseEvent(url, trigger, timeoutMs) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let triggered = false;
  const deadline = Date.now() + (timeoutMs || 5000);
  try {
    while (Date.now() < deadline) {
      if (!triggered) {
        triggered = true;
        await new Promise((r) => setTimeout(r, 120));
        await trigger();
      }
      const result = await Promise.race([
        reader.read().then((value) => ({ value: value })),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 400)),
      ]);
      if (result.timeout) continue;
      if (result.value.done) break;
      buffer += decoder.decode(result.value.value, { stream: true });
      if (buffer.indexOf('event: change') !== -1) return true;
    }
    return false;
  } finally {
    try { controller.abort(); } catch (err) { /* ignore */ }
  }
}

(async function main() {
  console.log('测试数据库: ' + DB_FILE);
  let server = await startServer();
  base = 'http://127.0.0.1:' + server.port;
  console.log('测试服务器: ' + base);
  let bootstrap = null;
  let taskA3 = null;
  let taskC5 = null;

  try {
    scenario('场景0 环境与初始名单（虚拟学生）');
    const boot = await req('/api/bootstrap');
    bootstrap = boot.body;
    check('GET /api/bootstrap 返回 200', boot.status === 200, 'status=' + boot.status);
    check('默认班级人数为 38', bootstrap.settings.classSize === 38, 'classSize=' + bootstrap.settings.classSize);
    check('自动生成 >= 10 名虚拟学生', bootstrap.students.length >= 10, 'count=' + bootstrap.students.length);
    check('初始没有任务', bootstrap.tasks.length === 0, 'tasks=' + bootstrap.tasks.length);
    check('状态集合包含 5 种状态', bootstrap.meta.statuses.length === 5, JSON.stringify(bootstrap.meta.statuses.map((s) => s.label)));

    scenario('场景1 创建任务：自动组合标题并生成全班学号');
    const created = await req('/api/tasks', 'POST', {
      book: 'A册', lesson: '第3课', content: '抄写', taskDate: dateOffset(0), initialStatus: 'to_grade',
    });
    taskA3 = created.body.task;
    check('创建成功返回 201', created.status === 201, 'status=' + created.status);
    check('标题自动组合为 A册·第3课·抄写作业', taskA3.title === 'A册·第3课·抄写作业', taskA3.title);
    check('自动生成全班 38 条学生记录', taskA3.counts.total === 38, 'total=' + taskA3.counts.total);
    check('每个学生一条独立记录（assignment 唯一）', new Set(taskA3.assignments.map((a) => a.assignmentId)).size === 38);
    check('创建后全部为待批改', taskA3.counts.to_grade === 38, JSON.stringify(taskA3.counts));

    scenario('场景2 第一次批改：全对学生被排除在待办之外');
    const idsDone = ['01', '02', '03'].map((no) => studentIdOf(bootstrap, no));
    await req('/api/tasks/' + taskA3.id + '/bulk', 'POST', { scope: 'selected', studentIds: idsDone, status: 'done' });
    taskA3 = await getTask(taskA3.id);
    check('3 人变成已完成', taskA3.counts.done === 3, 'done=' + taskA3.counts.done);
    check('未完成人数 38-3=35', taskA3.pendingCount === 35, 'pending=' + taskA3.pendingCount);
    check('已完成学生不在未完成列表中', taskA3.pending.every((a) => ['01', '02', '03'].indexOf(a.studentNo) === -1));
    const boardWithPending = await fetchTasks('?includeDone=0');
    check('仍有未完成，任务继续留在看板', boardWithPending.some((t) => t.id === taskA3.id));

    scenario('场景3 完成的整条任务从默认看板隐藏（但历史仍可查）');
    const tempTask = (await req('/api/tasks', 'POST', { book: '临时册', lesson: '第1课', content: '练习' })).body.task;
    await req('/api/tasks/' + tempTask.id + '/bulk', 'POST', { scope: 'all', status: 'done' });
    const afterAllDone = await getTask(tempTask.id);
    const defaultBoard = await fetchTasks();
    const boardWithDone = await fetchTasks('?includeDone=1');
    const tempHistory = await req('/api/tasks/' + tempTask.id + '/history');
    check('全部完成后未完成人数为 0', afterAllDone.pendingCount === 0);
    check('默认看板不再显示该任务', !defaultBoard.some((t) => t.id === tempTask.id));
    check('勾选“显示已完成”后可以看到', boardWithDone.some((t) => t.id === tempTask.id));
    check('历史记录仍然保留（含创建记录）', tempHistory.body.history.length >= 39, 'rows=' + (tempHistory.body.history || []).length);
    await req('/api/tasks/' + tempTask.id, 'DELETE');

    scenario('场景4 未收到作业的学生可以单独追踪');
    await req('/api/tasks/' + taskA3.id + '/bulk', 'POST', { scope: 'selected', studentIds: [studentIdOf(bootstrap, '07')], status: 'not_received' });
    taskA3 = await getTask(taskA3.id);
    const s07 = assignmentOf(taskA3, '07');
    check('07 号状态为未收到', s07.status === 'not_received', s07.status);
    check('未收到计数为 1', taskA3.counts.not_received === 1);
    check('07 号仍在未完成列表中', taskA3.pending.some((a) => a.studentNo === '07'));
    const byStatus = await fetchTasks('?status=not_received');
    check('按状态筛选可以找到该任务', byStatus.some((t) => t.id === taskA3.id));

    scenario('场景5 反复订正、反复退回，任务始终不会丢失（规则2）');
    const id12 = studentIdOf(bootstrap, '12');
    const firstReturn = await req('/api/tasks/' + taskA3.id + '/bulk', 'POST', { scope: 'selected', studentIds: [id12], action: 'return' });
    let t = await getTask(taskA3.id);
    const step1 = assignmentOf(t, '12').status;
    check('第一次退回 → 待订正', step1 === 'to_correct', step1);
    await req('/api/tasks/' + taskA3.id + '/bulk', 'POST', { scope: 'selected', studentIds: [id12], status: 'to_grade' });
    t = await getTask(taskA3.id);
    check('学生交回后 → 待批改', assignmentOf(t, '12').status === 'to_grade');
    await req('/api/tasks/' + taskA3.id + '/bulk', 'POST', { scope: 'selected', studentIds: [id12], action: 'return' });
    t = await getTask(taskA3.id);
    const step3 = assignmentOf(t, '12').status;
    check('再次退回（订正后仍有错）→ 待交回', step3 === 'to_return', step3);
    check('该生仍算未完成', t.pending.some((a) => a.studentNo === '12'));
    const h12 = await req('/api/tasks/' + taskA3.id + '/history');
    const rows12 = h12.body.history.filter((h) => h.studentNo === '12').map((h) => (h.fromStatus || 'null') + '->' + h.toStatus);
    check('状态变化历史完整（含待订正与待交回）', rows12.indexOf('to_grade->to_return') !== -1 && rows12.indexOf('to_grade->to_correct') !== -1, rows12.join(' , '));

    scenario('场景6 跨天未交：第二天仍显示原课次任务与持续天数');
    taskC5 = (await req('/api/tasks', 'POST', {
      book: 'C册', lesson: '第5课', content: '练习', taskDate: dateOffset(-3), initialStatus: 'to_grade',
    })).body.task;
    await req('/api/tasks/' + taskC5.id + '/bulk', 'POST', { scope: 'selected', studentIds: [studentIdOf(bootstrap, '18')], status: 'not_received' });
    const reopened = await getTask(taskC5.id);
    check('持续未完成天数为 3 天', reopened.daysPending === 3, 'days=' + reopened.daysPending);
    check('原课次任务仍在（重新打开网页后）', (await fetchTasks()).some((x) => x.id === reopened.id));
    check('18 号仍是未收到', assignmentOf(reopened, '18').status === 'not_received');

    scenario('场景7 新课次开始后，旧课次遗留任务依然存在（规则4）');
    const taskA4 = (await req('/api/tasks', 'POST', { book: 'A册', lesson: '第4课', content: '练习', taskDate: dateOffset(0) })).body.task;
    const board2 = await fetchTasks();
    check('看板同时包含第3课和第4课', board2.some((x) => x.id === taskA3.id) && board2.some((x) => x.id === taskA4.id));
    const a3AfterNew = await getTask(taskA3.id);
    check('第3课任务没有被新课次覆盖', a3AfterNew.pending.some((a) => a.studentNo === '12' && a.status === 'to_return'));
    check('新课次没有自动完成旧任务', a3AfterNew.counts.done === 3, 'done=' + a3AfterNew.counts.done);

    scenario('场景8 交回后状态可以从“未收到/待交回”变为“待批改”');
    const s07Assignment = assignmentOf(await getTask(taskA3.id), '07');
    const patch1 = await req('/api/assignments/' + s07Assignment.assignmentId, 'PATCH', { status: 'to_grade' });
    check('未收到 → 待批改（单条更新）', patch1.status === 200 && patch1.body.assignment.to === 'to_grade', JSON.stringify(patch1.body.assignment));
    await req('/api/tasks/' + taskA3.id + '/bulk', 'POST', { scope: 'selected', studentIds: [id12], status: 'to_grade' });
    const t2 = await getTask(taskA3.id);
    check('待交回 → 待批改（批量更新）', assignmentOf(t2, '12').status === 'to_grade');
    check('状态变化时间被记录', !!assignmentOf(t2, '12').updatedAt);

    scenario('场景9 只有老师确认通过才进入已完成（规则4）');
    const s12Assignment = assignmentOf(t2, '12');
    const pass = await req('/api/assignments/' + s12Assignment.assignmentId, 'PATCH', { status: 'done' });
    const t3 = await getTask(taskA3.id);
    check('12 号变为已完成', assignmentOf(t3, '12').status === 'done', pass.status + '');
    check('已完成人数增加', t3.counts.done === 4, 'done=' + t3.counts.done);
    check('其他学生没有被连带完成', assignmentOf(t3, '07').status === 'to_grade' && t3.counts.total - t3.counts.done === 34);

    scenario('场景10 批量操作不会错误修改其他课次的任务');
    const taskB3 = (await req('/api/tasks', 'POST', { book: 'B册', lesson: '第3课', content: '订正' })).body.task;
    const beforeA = await getTask(taskA3.id);
    const beforeC = await getTask(taskC5.id);
    await req('/api/tasks/' + taskB3.id + '/bulk', 'POST', { scope: 'all', status: 'not_received' });
    const afterA = await getTask(taskA3.id);
    const afterC = await getTask(taskC5.id);
    const changedOnlyB = JSON.stringify(beforeA.counts) === JSON.stringify(afterA.counts) && JSON.stringify(beforeC.counts) === JSON.stringify(afterC.counts);
    check('A册第3课计数未变', JSON.stringify(beforeA.counts) === JSON.stringify(afterA.counts), JSON.stringify(afterA.counts));
    check('C册第5课计数未变', JSON.stringify(beforeC.counts) === JSON.stringify(afterC.counts), JSON.stringify(afterC.counts));
    check('只有目标课次被修改', changedOnlyB && (await getTask(taskB3.id)).counts.not_received === 38);

    scenario('场景11 手机修改后电脑端自动看到最新状态（SSE 同步）');
    const s05Assignment = assignmentOf(await getTask(taskA3.id), '05');
    const gotEvent = await waitForSseEvent(base + '/api/events', async () => {
      await req('/api/assignments/' + s05Assignment.assignmentId, 'PATCH', { status: 'not_received' });
    }, 6000);
    const afterSse = await getTask(taskA3.id);
    check('电脑端收到 change 推送事件', gotEvent);
    check('电脑端读到手机端修改后的最新状态', assignmentOf(afterSse, '05').status === 'not_received', assignmentOf(afterSse, '05').status);

    scenario('场景12 撤销误操作');
    const undoItem = { assignmentId: s05Assignment.assignmentId, status: 'to_grade' };
    const undone = await req('/api/assignments/restore', 'POST', { items: [undoItem] });
    const afterUndo = await getTask(taskA3.id);
    check('撤销恢复到原状态', afterUndo.assignments.filter((a) => a.assignmentId === undoItem.assignmentId)[0].status === 'to_grade', JSON.stringify(undone.body.updated));
    check('撤销也写入历史（可追溯）', (await req('/api/tasks/' + taskA3.id + '/history')).body.history.some((h) => h.source === 'undo'));

    scenario('场景13 归档不会自动完成学生作业（规则4）');
    const beforeArchive = await getTask(taskC5.id);
    await req('/api/tasks/' + taskC5.id, 'PATCH', { status: 'closed' });
    const archived = await getTask(taskC5.id);
    check('归档后学生状态不变', JSON.stringify(archived.counts) === JSON.stringify(beforeArchive.counts), JSON.stringify(archived.counts));
    check('默认看板隐藏已归档任务', !(await fetchTasks()).some((t) => t.id === taskC5.id));
    check('显示已归档后可以看到', (await fetchTasks('?includeArchived=1')).some((t) => t.id === taskC5.id));
    await req('/api/tasks/' + taskC5.id, 'PATCH', { status: 'open' });

    scenario('场景14 关闭网页再打开（重启服务）后数据仍然保留');
    const snapshotBefore = await getTask(taskA3.id);
    await stopServer(server);
    server = await startServer();
    base = 'http://127.0.0.1:' + server.port;
    const bootAfter = (await req('/api/bootstrap')).body;
    const taskAfter = await getTask(taskA3.id);
    check('重启后学生名单仍在', bootAfter.students.length === 38, 'students=' + bootAfter.students.length);
    check('重启后任务依然存在（4 个任务）', bootAfter.tasks.length === 4, 'tasks=' + bootAfter.tasks.length);
    check('重启后每个学生状态完全一致', JSON.stringify(taskAfter.counts) === JSON.stringify(snapshotBefore.counts), JSON.stringify(taskAfter.counts));
    check('重启后历史记录仍在', (await req('/api/tasks/' + taskA3.id + '/history')).body.history.length >= 38);

    scenario('场景15 班级人数可修改、按学号查询历史');
    const sizeRes = await req('/api/settings/class-size', 'POST', { classSize: 40 });
    check('保存班级人数 40 人', sizeRes.body.settings.classSize === 40, JSON.stringify(sizeRes.body.created));
    check('新增 39、40 号学号', sizeRes.body.created.indexOf('39') !== -1 && sizeRes.body.created.indexOf('40') !== -1);
    const sid = studentIdOf({ students: (await req('/api/students')).body.students }, '12');
    const studentHistory = await req('/api/students/' + sid + '/history');
    check('可以按学生查询历史记录', (studentHistory.body.history || []).length > 0, 'rows=' + (studentHistory.body.history || []).length);
    const oneHistory = studentHistory.body.history[0];
    check('历史包含原状态、新状态、时间', !!oneHistory.toStatus && !!oneHistory.changedAt && oneHistory.fromStatus !== undefined);

    scenario('场景16 服务器端筛选接口（作业册 / 课次 / 状态）');
    const byBook = await fetchTasks('?book=' + encodeURIComponent('A册'));
    check('按作业册筛选只返回 A册', byBook.length > 0 && byBook.every((t) => t.book === 'A册'), 'n=' + byBook.length);
    const byLesson = await fetchTasks('?lesson=' + encodeURIComponent('第3课'));
    check('按课次筛选只返回第3课', byLesson.length > 0 && byLesson.every((t) => t.lesson === '第3课'), 'n=' + byLesson.length);
    const byDone = await fetchTasks('?status=done&includeDone=1');
    check('按状态筛选能命中已完成记录', byDone.every((t) => t.counts.done > 0), 'n=' + byDone.length);
  } catch (err) {
    failCount += 1;
    failures.push('测试脚本异常: ' + (err && err.stack ? err.stack : err));
    console.log('\n测试脚本异常: ' + err);
  } finally {
    await stopServer(server);
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (err) { /* ignore */ }
  }

  console.log('\n==============================');
  console.log('通过 ' + passCount + ' 项，失败 ' + failCount + ' 项');
  if (failures.length) {
    console.log('失败明细:');
    failures.forEach((f) => console.log('  - ' + f));
  }
  console.log('==============================');
  process.exit(failCount ? 1 : 0);
})();

function C5Safe(task) { return task.id; }