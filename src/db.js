'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_CLASS_SIZE = 38;

const STATUS = Object.freeze({
  NOT_RECEIVED: 'not_received',
  TO_CORRECT: 'to_correct',
  TO_RETURN: 'to_return',
  TO_GRADE: 'to_grade',
  DONE: 'done',
});

const STATUS_LIST = Object.freeze([
  STATUS.NOT_RECEIVED,
  STATUS.TO_CORRECT,
  STATUS.TO_RETURN,
  STATUS.TO_GRADE,
  STATUS.DONE,
]);

const PENDING_STATUS_LIST = Object.freeze([
  STATUS.NOT_RECEIVED,
  STATUS.TO_CORRECT,
  STATUS.TO_RETURN,
  STATUS.TO_GRADE,
]);

const STATUS_LABEL = Object.freeze({
  not_received: '未收到',
  to_correct: '待订正',
  to_return: '待交回',
  to_grade: '待批改',
  done: '已完成',
});

function nowIso() {
  return new Date().toISOString();
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function localDateString(input) {
  const d = input instanceof Date ? input : new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function dateOnlyString(isoString) {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return null;
  return localDateString(d);
}

function daysSinceDate(dateStr) {
  const parts = String(dateStr || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return 0;
  const start = Date.UTC(parts[0], parts[1] - 1, parts[2]);
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((today - start) / 86400000));
}

function makeTaskTitle(book, lesson, content) {
  const base = [book, lesson, content].map((p) => String(p || '').trim()).filter(Boolean).join('·');
  if (!base) return '未命名作业';
  return /作业$/.test(base) ? base : base + '作业';
}

function isStatus(value) {
  return typeof value === 'string' && STATUS_LIST.indexOf(value) !== -1;
}

function isDone(status) {
  return status === STATUS.DONE;
}

function emptyCounts() {
  return { not_received: 0, to_correct: 0, to_return: 0, to_grade: 0, done: 0, total: 0 };
}

function openDatabase(dbPath) {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec([
    'CREATE TABLE IF NOT EXISTS settings (',
    '  key TEXT PRIMARY KEY,',
    '  value TEXT NOT NULL',
    ')',
  ].join('\n'));
  db.exec([
    'CREATE TABLE IF NOT EXISTS students (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  student_no TEXT NOT NULL UNIQUE,',
    '  name TEXT,',
    '  active INTEGER NOT NULL DEFAULT 1,',
    '  created_at TEXT NOT NULL',
    ')',
  ].join('\n'));
  db.exec([
    'CREATE TABLE IF NOT EXISTS tasks (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  book TEXT NOT NULL,',
    '  lesson TEXT NOT NULL,',
    '  content TEXT NOT NULL,',
    '  title TEXT NOT NULL,',
    '  task_date TEXT NOT NULL,',
    '  status TEXT NOT NULL DEFAULT \'open\',',
    '  created_at TEXT NOT NULL,',
    '  closed_at TEXT',
    ')',
  ].join('\n'));
  db.exec([
    'CREATE TABLE IF NOT EXISTS assignments (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,',
    '  student_id INTEGER NOT NULL REFERENCES students(id),',
    '  status TEXT NOT NULL,',
    '  updated_at TEXT NOT NULL,',
    '  UNIQUE (task_id, student_id)',
    ')',
  ].join('\n'));
  db.exec([
    'CREATE TABLE IF NOT EXISTS history (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  assignment_id INTEGER NOT NULL,',
    '  task_id INTEGER NOT NULL,',
    '  student_id INTEGER NOT NULL,',
    '  from_status TEXT,',
    '  to_status TEXT NOT NULL,',
    '  note TEXT,',
    '  changed_at TEXT NOT NULL,',
    '  source TEXT NOT NULL DEFAULT \'manual\'',
    ')',
  ].join('\n'));
  db.exec('CREATE INDEX IF NOT EXISTS idx_assignments_task ON assignments(task_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_assignments_student ON assignments(student_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_history_assignment ON history(assignment_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_history_task ON history(task_id)');
  ensureDefaults(db);
  return db;
}
function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function getSettings(db) {
  const size = Number(getSetting(db, 'classSize'));
  return { classSize: Number.isFinite(size) && size > 0 ? size : DEFAULT_CLASS_SIZE };
}

function addStudentsUpTo(db, count) {
  const target = Math.max(1, Math.min(120, Number(count) || DEFAULT_CLASS_SIZE));
  const existing = new Set(db.prepare('SELECT student_no FROM students').all().map((r) => r.student_no));
  const insert = db.prepare('INSERT INTO students (student_no, name, active, created_at) VALUES (?, ?, 1, ?)');
  const created = [];
  db.exec('BEGIN');
  try {
    for (let i = 1; i <= target; i += 1) {
      const no = pad2(i);
      if (existing.has(no)) {
        db.prepare('UPDATE students SET active = 1 WHERE student_no = ?').run(no);
        continue;
      }
      insert.run(no, null, nowIso());
      created.push(no);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return created;
}

function ensureDefaults(db) {
  if (getSetting(db, 'classSize') === null) setSetting(db, 'classSize', DEFAULT_CLASS_SIZE);
  if (getSetting(db, 'schemaVersion') === null) setSetting(db, 'schemaVersion', 1);
  const row = db.prepare('SELECT COUNT(*) AS c FROM students').get();
  if (Number(row.c) === 0) {
    const size = getSettings(db).classSize;
    addStudentsUpTo(db, size);
    setSetting(db, 'seededAt', nowIso());
  }
}

function listStudents(db, options) {
  const opts = options || {};
  const where = opts.includeInactive ? '' : 'WHERE active = 1';
  return db.prepare(
    'SELECT id, student_no AS studentNo, name, active, created_at AS createdAt FROM students ' + where +
    ' ORDER BY CAST(student_no AS INTEGER), student_no'
  ).all().map((s) => ({ ...s, active: !!s.active }));
}

function findStudentByNo(db, studentNo) {
  return db.prepare('SELECT * FROM students WHERE student_no = ?').get(String(studentNo));
}

function addStudent(db, input) {
  const studentNo = String((input && input.studentNo) || '').trim();
  if (!studentNo) throw new Error('学号不能为空');
  if (findStudentByNo(db, studentNo)) throw new Error('学号已存在：' + studentNo);
  const name = input && input.name ? String(input.name).trim() : null;
  const info = db.prepare('INSERT INTO students (student_no, name, active, created_at) VALUES (?, ?, 1, ?)')
    .run(studentNo, name, nowIso());
  return db.prepare('SELECT id, student_no AS studentNo, name, active FROM students WHERE id = ?')
    .get(Number(info.lastInsertRowid));
}

function updateStudent(db, id, patch) {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(Number(id));
  if (!student) return null;
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'name')) {
    const name = patch.name === null || patch.name === '' ? null : String(patch.name).trim();
    db.prepare('UPDATE students SET name = ? WHERE id = ?').run(name, student.id);
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'active')) {
    db.prepare('UPDATE students SET active = ? WHERE id = ?').run(patch.active ? 1 : 0, student.id);
  }
  return db.prepare('SELECT id, student_no AS studentNo, name, active FROM students WHERE id = ?').get(student.id);
}

function listBooks(db) {
  return db.prepare('SELECT book, COUNT(*) AS tasks FROM tasks GROUP BY book ORDER BY book').all();
}

function listLessons(db) {
  return db.prepare('SELECT lesson, COUNT(*) AS tasks FROM tasks GROUP BY lesson ORDER BY lesson').all();
}

function createTask(db, input) {
  const book = String((input && input.book) || '').trim();
  const lesson = String((input && input.lesson) || '').trim();
  const content = String((input && input.content) || '').trim() || '作业';
  if (!book) throw new Error('缺少必填项：作业册');
  if (!lesson) throw new Error('缺少必填项：课次');
  const taskDate = /^\d{4}-\d{2}-\d{2}$/.test(String((input && input.taskDate) || ''))
    ? String(input.taskDate)
    : localDateString();
  const title = String((input && input.title) || '').trim() || makeTaskTitle(book, lesson, content);
  const initialStatus = isStatus(input && input.initialStatus) ? input.initialStatus : STATUS.TO_GRADE;
  const ts = nowIso();
  let taskId = null;
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      'INSERT INTO tasks (book, lesson, content, title, task_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(book, lesson, content, title, taskDate, 'open', ts);
    taskId = Number(info.lastInsertRowid);
    const students = db.prepare('SELECT id FROM students WHERE active = 1').all();
    const insertAssignment = db.prepare('INSERT INTO assignments (task_id, student_id, status, updated_at) VALUES (?, ?, ?, ?)');
    const insertHistory = db.prepare(
      'INSERT INTO history (assignment_id, task_id, student_id, from_status, to_status, note, changed_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const student of students) {
      const created = insertAssignment.run(taskId, student.id, initialStatus, ts);
      insertHistory.run(Number(created.lastInsertRowid), taskId, student.id, null, initialStatus, '创建任务', ts, 'create');
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return getTask(db, taskId);
}

function buildTaskView(db, taskRow) {
  const rows = db.prepare(
    'SELECT a.id AS assignment_id, a.status, a.updated_at, s.id AS student_id, s.student_no, s.name, s.active ' +
    'FROM assignments a JOIN students s ON s.id = a.student_id WHERE a.task_id = ? ' +
    'ORDER BY CAST(s.student_no AS INTEGER), s.student_no'
  ).all(taskRow.id);
  const counts = emptyCounts();
  const assignments = rows.map((r) => {
    counts[r.status] = (counts[r.status] || 0) + 1;
    const statusDate = dateOnlyString(r.updated_at) || taskRow.task_date;
    return {
      assignmentId: r.assignment_id,
      studentId: r.student_id,
      studentNo: r.student_no,
      name: r.name,
      active: !!r.active,
      status: r.status,
      updatedAt: r.updated_at,
      pendingDays: r.status === STATUS.DONE ? 0 : daysSinceDate(statusDate),
    };
  });
  counts.total = assignments.length;
  const pending = assignments.filter((a) => a.status !== STATUS.DONE);
  let lastActivityAt = taskRow.created_at;
  for (const item of pending) {
    if (item.updatedAt > lastActivityAt) lastActivityAt = item.updatedAt;
  }
  return {
    id: taskRow.id,
    book: taskRow.book,
    lesson: taskRow.lesson,
    content: taskRow.content,
    title: taskRow.title,
    taskDate: taskRow.task_date,
    status: taskRow.status,
    createdAt: taskRow.created_at,
    closedAt: taskRow.closed_at,
    daysPending: daysSinceDate(taskRow.task_date),
    counts,
    pendingCount: pending.length,
    pending,
    assignments,
    lastActivityAt,
  };
}

function getTask(db, id) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(id));
  if (!task) return null;
  return buildTaskView(db, task);
}

function listTasks(db, filters) {
  const f = filters || {};
  const where = [];
  const params = [];
  if (f.book) { where.push('t.book = ?'); params.push(f.book); }
  if (f.lesson) { where.push('t.lesson = ?'); params.push(f.lesson); }
  if (!f.includeArchived) where.push("t.status = 'open'");
  const sql = 'SELECT t.* FROM tasks t ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY t.task_date ASC, t.id ASC';
  const rows = db.prepare(sql).all(...params);
  const views = rows.map((row) => buildTaskView(db, row)).filter((view) => {
    if (!f.includeDone && view.pendingCount === 0) return false;
    if (f.status && !view.counts[f.status]) return false;
    return true;
  });
  views.sort((a, b) => (b.daysPending - a.daysPending) || (a.id - b.id));
  return views;
}

function updateTask(db, id, patch) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(id));
  if (!task) return null;
  const fields = [];
  const params = [];
  const push = (column, value) => { fields.push(column + ' = ?'); params.push(value); };
  if (patch && patch.book !== undefined) push('book', String(patch.book).trim());
  if (patch && patch.lesson !== undefined) push('lesson', String(patch.lesson).trim());
  if (patch && patch.content !== undefined) push('content', String(patch.content).trim());
  if (patch && patch.taskDate !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(String(patch.taskDate))) push('task_date', String(patch.taskDate));
  if (patch && patch.status !== undefined && ['open', 'closed'].indexOf(patch.status) !== -1) {
    push('status', patch.status);
    push('closed_at', patch.status === 'closed' ? nowIso() : null);
  }
  const nextBook = patch && patch.book !== undefined ? String(patch.book).trim() : task.book;
  const nextLesson = patch && patch.lesson !== undefined ? String(patch.lesson).trim() : task.lesson;
  const nextContent = patch && patch.content !== undefined ? String(patch.content).trim() : task.content;
  if (patch && (patch.book !== undefined || patch.lesson !== undefined || patch.content !== undefined || patch.title !== undefined)) {
    const explicitTitle = patch.title !== undefined ? String(patch.title).trim() : '';
    push('title', explicitTitle || makeTaskTitle(nextBook, nextLesson, nextContent));
  }
  if (!fields.length) return getTask(db, id);
  params.push(task.id);
  db.prepare('UPDATE tasks SET ' + fields.join(', ') + ' WHERE id = ?').run(...params);
  return getTask(db, id);
}

function deleteTask(db, id) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(id));
  if (!task) return false;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM history WHERE task_id = ?').run(task.id);
    db.prepare('DELETE FROM assignments WHERE task_id = ?').run(task.id);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return true;
}

function updateAssignmentStatus(db, assignmentId, status, options) {
  const opts = options || {};
  if (!isStatus(status)) throw new Error('无效的状态：' + status);
  const current = db.prepare('SELECT * FROM assignments WHERE id = ?').get(Number(assignmentId));
  if (!current) return null;
  if (current.status === status) {
    return { assignmentId: current.id, studentId: current.student_id, from: current.status, to: status, updatedAt: current.updated_at, unchanged: true };
  }
  const ts = nowIso();
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE assignments SET status = ?, updated_at = ? WHERE id = ?').run(status, ts, current.id);
    db.prepare(
      'INSERT INTO history (assignment_id, task_id, student_id, from_status, to_status, note, changed_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(current.id, current.task_id, current.student_id, current.status, status, opts.note ? String(opts.note) : null, ts, opts.source || 'manual');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { assignmentId: current.id, taskId: current.task_id, studentId: current.student_id, from: current.status, to: status, updatedAt: ts };
}

function hasReturnedBefore(db, assignmentId) {
  const row = db.prepare(
    "SELECT COUNT(*) AS c FROM history WHERE assignment_id = ? AND to_status IN ('to_correct', 'to_return')"
  ).get(Number(assignmentId));
  return Number(row.c) > 0;
}

function resolveReturnStatus(db, assignmentId) {
  return hasReturnedBefore(db, assignmentId) ? STATUS.TO_RETURN : STATUS.TO_CORRECT;
}

function resolveTargetAssignments(db, taskId, scope, studentIds) {
  const rows = db.prepare(
    'SELECT a.id AS assignmentId, a.student_id AS studentId, a.status, s.student_no AS studentNo, s.name ' +
    'FROM assignments a JOIN students s ON s.id = a.student_id WHERE a.task_id = ? ' +
    'ORDER BY CAST(s.student_no AS INTEGER), s.student_no'
  ).all(Number(taskId));
  const scopeName = String(scope || 'selected');
  if (scopeName === 'all') return rows;
  if (scopeName === 'pending') return rows.filter((r) => r.status !== STATUS.DONE);
  if (scopeName === 'done') return rows.filter((r) => r.status === STATUS.DONE);
  if (scopeName === 'selected') {
    const wanted = new Set((studentIds || []).map((v) => Number(v)));
    return rows.filter((r) => wanted.has(Number(r.studentId)));
  }
  if (isStatus(scopeName)) return rows.filter((r) => r.status === scopeName);
  return [];
}

function applyBulkUpdate(db, taskId, options) {
  const opts = options || {};
  const targets = resolveTargetAssignments(db, taskId, opts.scope, opts.studentIds);
  const updated = [];
  for (const target of targets) {
    let next = opts.status;
    if (opts.action === 'return') next = resolveReturnStatus(db, target.assignmentId);
    if (!isStatus(next)) continue;
    const result = updateAssignmentStatus(db, target.assignmentId, next, { note: opts.note, source: opts.source || 'bulk' });
    if (!result || result.unchanged) continue;
    updated.push({ assignmentId: result.assignmentId, studentId: result.studentId, studentNo: target.studentNo, name: target.name, from: result.from, to: result.to, updatedAt: result.updatedAt });
  }
  return updated;
}

function restoreAssignments(db, items) {
  const updated = [];
  for (const item of items || []) {
    const assignmentId = Number(item && item.assignmentId);
    const status = item && item.status;
    if (!assignmentId || !isStatus(status)) continue;
    const result = updateAssignmentStatus(db, assignmentId, status, { note: '撤销上一步操作', source: 'undo' });
    if (!result || result.unchanged) continue;
    const student = db.prepare('SELECT student_no AS studentNo FROM students WHERE id = ?').get(result.studentId);
    updated.push({ assignmentId: result.assignmentId, studentId: result.studentId, studentNo: student ? student.studentNo : null, from: result.from, to: result.to });
  }
  return updated;
}

function listHistory(db, filters) {
  const f = filters || {};
  const where = [];
  const params = [];
  if (f.taskId) { where.push('h.task_id = ?'); params.push(Number(f.taskId)); }
  if (f.studentId) { where.push('h.student_id = ?'); params.push(Number(f.studentId)); }
  if (f.assignmentId) { where.push('h.assignment_id = ?'); params.push(Number(f.assignmentId)); }
  const limit = Math.max(1, Math.min(1000, Number(f.limit) || 200));
  const sql = 'SELECT h.id, h.assignment_id AS assignmentId, h.task_id AS taskId, h.student_id AS studentId, ' +
    'h.from_status AS fromStatus, h.to_status AS toStatus, h.note, h.changed_at AS changedAt, h.source, ' +
    't.title AS taskTitle, t.book, t.lesson, t.content, s.student_no AS studentNo, s.name ' +
    'FROM history h LEFT JOIN tasks t ON t.id = h.task_id LEFT JOIN students s ON s.id = h.student_id ' +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    'ORDER BY h.changed_at DESC, h.id DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

function resetData(db, options) {
  const opts = options || {};
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM history').run();
    db.prepare('DELETE FROM assignments').run();
    db.prepare('DELETE FROM tasks').run();
    if (!opts.keepStudents) db.prepare('DELETE FROM students').run();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  if (!opts.keepStudents) ensureDefaults(db);
  return { students: db.prepare('SELECT COUNT(*) AS c FROM students').get().c, tasks: db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c };
}

module.exports = {
  DEFAULT_CLASS_SIZE,
  STATUS,
  STATUS_LIST,
  PENDING_STATUS_LIST,
  STATUS_LABEL,
  emptyCounts,
  isStatus,
  isDone,
  nowIso,
  localDateString,
  daysSinceDate,
  makeTaskTitle,
  openDatabase,
  getSetting,
  setSetting,
  getSettings,
  addStudentsUpTo,
  listStudents,
  addStudent,
  updateStudent,
  listBooks,
  listLessons,
  createTask,
  getTask,
  listTasks,
  updateTask,
  deleteTask,
  updateAssignmentStatus,
  resolveReturnStatus,
  hasReturnedBefore,
  resolveTargetAssignments,
  applyBulkUpdate,
  restoreAssignments,
  listHistory,
  resetData,
};