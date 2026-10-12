'use strict';

const path = require('node:path');
const D = require('../src/db');

const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, '..', 'data', 'tracker.db');
const shouldReset = process.argv.indexOf('--reset') !== -1;

const db = D.openDatabase(DB_PATH);

if (shouldReset) {
  D.resetData(db, { keepStudents: true });
  console.log('已清空原有任务与历史（保留名单）');
}

function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function createTask(book, lesson, content, dayOffset, initialStatus) {
  const task = D.createTask(db, {
    book: book,
    lesson: lesson,
    content: content,
    taskDate: dateOffset(dayOffset),
    initialStatus: initialStatus || 'to_grade',
  });
  console.log('创建任务：' + task.title + '（' + task.taskDate + '，' + task.counts.total + ' 人）');
  return task;
}

function assignmentOf(taskId, studentNo) {
  const task = D.getTask(db, taskId);
  const found = task.assignments.filter((a) => a.studentNo === studentNo)[0];
  return found || null;
}

function markMany(taskId, numbers, status) {
  const ids = [];
  numbers.forEach((no) => {
    const a = assignmentOf(taskId, no);
    if (a) ids.push(a.studentId);
  });
  if (!ids.length) return 0;
  const updated = D.applyBulkUpdate(db, taskId, { scope: 'selected', studentIds: ids, status: status, source: 'demo' });
  return updated.length;
}

function markOne(taskId, studentNo, status, note) {
  const a = assignmentOf(taskId, studentNo);
  if (!a) return false;
  D.updateAssignmentStatus(db, a.assignmentId, status, { note: note || '演示数据', source: 'demo' });
  return true;
}

const students = D.listStudents(db);
const total = students.length;
const all = students.map((s) => s.studentNo);
const take = (from, to) => all.slice(from, to);

console.log('当前名单人数：' + total);

// 1) A册·第3课·抄写：3 天前布置的遗留任务（含反复订正的例子）
const taskA3 = createTask('A册', '第3课', '抄写', -3, 'to_grade');
markMany(taskA3.id, take(0, 20), 'done');
markMany(taskA3.id, ['21', '22', '23'], 'not_received');
markMany(taskA3.id, ['24', '25', '26'], 'to_correct');
markOne(taskA3.id, '03', 'to_correct', '第一次批改未通过，退回归还订正');
markOne(taskA3.id, '12', 'to_correct', '第一次退回订正');
markOne(taskA3.id, '12', 'to_grade', '学生订正后交回，等待老师检查');
markOne(taskA3.id, '12', 'to_return', '订正后仍有错，再次退回，学生还没交回');
markOne(taskA3.id, '07', 'not_received', '从一开始就没有收到这份作业');

// 2) A册·第4课·练习：今天的新课次
const taskA4 = createTask('A册', '第4课', '练习', 0, 'to_grade');
markMany(taskA4.id, take(0, 30), 'done');
markMany(taskA4.id, ['31', '32', '33'], 'not_received');
markMany(taskA4.id, ['34', '35'], 'to_correct');

// 3) B册·第3课·订正：昨天布置
const taskB3 = createTask('B册', '第3课', '订正', -1, 'to_grade');
markMany(taskB3.id, take(0, 22), 'done');
markMany(taskB3.id, take(22, 30), 'to_correct');

// 4) B册·第4课·抄写：2 天前布置
const taskB4 = createTask('B册', '第4课', '抄写', -2, 'to_grade');
markMany(taskB4.id, take(0, 15), 'done');
markMany(taskB4.id, take(15, 27), 'not_received');

// 5) C册·第5课·练习：4 天前的遗留任务，多人反复退回
const taskC5 = createTask('C册', '第5课', '练习', -4, 'to_grade');
markMany(taskC5.id, take(0, 25), 'done');
markMany(taskC5.id, take(25, 31), 'to_correct');
take(31, 36).forEach((no) => {
  markOne(taskC5.id, no, 'to_correct', '第一次退回订正');
  markOne(taskC5.id, no, 'to_grade', '订正后交回');
  markOne(taskC5.id, no, 'to_return', '再次退回，等待交回');
});

console.log('\n演示数据完成。当前待办：');
D.listTasks(db, { includeArchived: true, includeDone: true }).forEach((t) => {
  console.log('  ' + t.title + ' | 创建 ' + t.taskDate + ' | 已持续 ' + t.daysPending + ' 天 | 未完成 ' + t.pendingCount + ' 人' +
    ' | 未收到 ' + (t.counts.not_received || 0) + ' 待订正 ' + (t.counts.to_correct || 0) +
    ' 待交回 ' + (t.counts.to_return || 0) + ' 待批改 ' + (t.counts.to_grade || 0) + ' 已完成 ' + (t.counts.done || 0));
});
console.log('\n数据库文件：' + DB_PATH);
db.close();