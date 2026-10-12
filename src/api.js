'use strict';

const D = require('./db');

const ALLOWED_SCOPES = ['selected', 'all', 'pending', 'done'].concat(D.STATUS_LIST);

function ok(body, status) {
  return { status: status || 200, body: body === undefined ? null : body };
}

function fail(status, message) {
  return { status: status, body: { error: message } };
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return !!fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].indexOf(text) !== -1) return true;
  if (['0', 'false', 'no', 'off'].indexOf(text) !== -1) return false;
  return !!fallback;
}

function createApi(deps) {
  const db = deps.db;
  const notify = typeof deps.notify === 'function' ? deps.notify : function () {};

  function meta() {
    return {
      statuses: D.STATUS_LIST.map((key) => ({ key: key, label: D.STATUS_LABEL[key], done: key === D.STATUS.DONE })),
      books: D.listBooks(db),
      lessons: D.listLessons(db),
      today: D.localDateString(),
      classSize: D.getSettings(db).classSize,
    };
  }

  function bootstrap() {
    return {
      settings: D.getSettings(db),
      students: D.listStudents(db),
      allStudents: D.listStudents(db, { includeInactive: true }),
      tasks: D.listTasks(db, { includeArchived: true, includeDone: true }),
      meta: meta(),
      serverTime: D.nowIso(),
    };
  }

  function taskOr404(id) {
    const task = D.getTask(db, id);
    return task;
  }

  function handleBulk(taskId, body) {
    const scope = body && body.scope ? String(body.scope) : 'selected';
    if (ALLOWED_SCOPES.indexOf(scope) === -1) return fail(400, '无效的 scope：' + scope);
    const action = body && body.action ? String(body.action) : null;
    const status = body && body.status ? String(body.status) : null;
    if (!action && !D.isStatus(status)) return fail(400, '需要提供有效的 status 或 action');
    const updated = D.applyBulkUpdate(db, taskId, {
      scope: scope,
      studentIds: body && body.studentIds,
      status: status,
      action: action,
      note: body && body.note,
      source: (body && body.source) || 'bulk',
    });
    if (updated.length) notify({ type: 'assignments', action: 'bulk', taskId: Number(taskId), count: updated.length });
    return ok({ updated: updated, task: D.getTask(db, taskId) });
  }

  return function handleApi(request) {
    const method = String(request.method || 'GET').toUpperCase();
    const pathname = request.pathname;
    const query = request.query || {};
    const body = request.body || {};
    let match = null;

    if (pathname === '/api/bootstrap' && method === 'GET') return ok(bootstrap());

    if (pathname === '/api/meta' && method === 'GET') return ok(meta());

    if (pathname === '/api/tasks' && method === 'GET') {
      const tasks = D.listTasks(db, {
        book: query.book || null,
        lesson: query.lesson || null,
        status: query.status || null,
        includeArchived: toBool(query.includeArchived, false),
        includeDone: toBool(query.includeDone, false),
      });
      return ok({ tasks: tasks, meta: meta(), serverTime: D.nowIso() });
    }

    if (pathname === '/api/tasks' && method === 'POST') {
      const book = String(body.book || '').trim();
      const lesson = String(body.lesson || '').trim();
      const missing = [];
      if (!book) missing.push('作业册');
      if (!lesson) missing.push('课次');
      if (missing.length) return fail(400, '缺少必填项：' + missing.join('、'));
      if (body.initialStatus && !D.isStatus(body.initialStatus)) return fail(400, '无效的 initialStatus');
      const students = D.listStudents(db);
      if (!students.length) return fail(400, '班级名单为空，请先在“名单 / 设置”里生成学号');
      const task = D.createTask(db, {
        book: book,
        lesson: lesson,
        content: body.content,
        title: body.title,
        taskDate: body.taskDate,
        initialStatus: body.initialStatus,
      });
      notify({ type: 'tasks', action: 'created', taskId: task.id });
      return ok({ task: task }, 201);
    }

    match = pathname.match(/^\/api\/tasks\/(\d+)\/bulk$/);
    if (match && method === 'POST') {
      if (!taskOr404(match[1])) return fail(404, '任务不存在');
      return handleBulk(Number(match[1]), body);
    }

    match = pathname.match(/^\/api\/tasks\/(\d+)\/history$/);
    if (match && method === 'GET') {
      const history = D.listHistory(db, { taskId: Number(match[1]), limit: query.limit });
      return ok({ history: history });
    }

    match = pathname.match(/^\/api\/tasks\/(\d+)$/);
    if (match && method === 'GET') {
      const task = taskOr404(Number(match[1]));
      if (!task) return fail(404, '任务不存在');
      return ok({ task: task });
    }

    if (match && method === 'PATCH') {
      const id = Number(match[1]);
      if (!taskOr404(id)) return fail(404, '任务不存在');
      if (body.status !== undefined && ['open', 'closed'].indexOf(String(body.status)) === -1) {
        return fail(400, '无效的任务状态（仅支持 open / closed）');
      }
      const task = D.updateTask(db, id, body);
      notify({ type: 'tasks', action: 'updated', taskId: id });
      return ok({ task: task });
    }

    if (match && method === 'DELETE') {
      const id = Number(match[1]);
      if (!taskOr404(id)) return fail(404, '任务不存在');
      D.deleteTask(db, id);
      notify({ type: 'tasks', action: 'deleted', taskId: id });
      return ok({ deleted: true });
    }

    match = pathname.match(/^\/api\/assignments\/(\d+)$/);
    if (match && method === 'PATCH') {
      const status = body.status ? String(body.status) : '';
      if (!D.isStatus(status)) return fail(400, '无效的状态：' + status);
      const result = D.updateAssignmentStatus(db, Number(match[1]), status, { note: body.note, source: body.source || 'manual' });
      if (!result) return fail(404, '记录不存在');
      const student = db.prepare('SELECT student_no AS studentNo FROM students WHERE id = ?').get(result.studentId);
      notify({ type: 'assignments', action: 'update', assignmentId: result.assignmentId });
      return ok({
        assignment: {
          assignmentId: result.assignmentId,
          studentId: result.studentId,
          studentNo: student ? student.studentNo : null,
          from: result.from,
          to: result.to,
          updatedAt: result.updatedAt,
        },
        task: result.taskId ? D.getTask(db, result.taskId) : null,
      });
    }

    if (pathname === '/api/assignments/restore' && method === 'POST') {
      const updated = D.restoreAssignments(db, body.items);
      if (updated.length) notify({ type: 'assignments', action: 'restore', count: updated.length });
      return ok({ updated: updated });
    }

    if (pathname === '/api/students' && method === 'GET') {
      return ok({ students: D.listStudents(db), allStudents: D.listStudents(db, { includeInactive: true }) });
    }

    if (pathname === '/api/students' && method === 'POST') {
      try {
        const student = D.addStudent(db, { studentNo: body.studentNo, name: body.name });
        notify({ type: 'students', action: 'created' });
        return ok({ student: student }, 201);
      } catch (err) {
        return fail(409, err.message);
      }
    }

    match = pathname.match(/^\/api\/students\/(\d+)\/history$/);
    if (match && method === 'GET') {
      const history = D.listHistory(db, { studentId: Number(match[1]), taskId: query.taskId, limit: query.limit });
      return ok({ history: history });
    }

    match = pathname.match(/^\/api\/students\/(\d+)$/);
    if (match && method === 'PATCH') {
      const student = D.updateStudent(db, Number(match[1]), body);
      if (!student) return fail(404, '学生不存在');
      notify({ type: 'students', action: 'updated' });
      return ok({ student: student });
    }

    if (pathname === '/api/history' && method === 'GET') {
      const history = D.listHistory(db, {
        taskId: query.taskId,
        studentId: query.studentId,
        assignmentId: query.assignmentId,
        limit: query.limit,
      });
      return ok({ history: history });
    }

    if (pathname === '/api/settings/class-size' && method === 'POST') {
      const size = Number(body.classSize);
      if (!Number.isFinite(size) || size < 1 || size > 120) return fail(400, '班级人数需在 1 - 120 之间');
      D.setSetting(db, 'classSize', Math.round(size));
      const created = D.addStudentsUpTo(db, Math.round(size));
      notify({ type: 'students', action: 'generated' });
      return ok({ settings: D.getSettings(db), students: D.listStudents(db), created: created });
    }

    if (pathname === '/api/admin/reset' && method === 'POST') {
      if (String(body.confirm || '') !== 'RESET') return fail(400, '危险操作需要确认参数 confirm="RESET"');
      const result = D.resetData(db, { keepStudents: toBool(body.keepStudents, true) });
      notify({ type: 'tasks', action: 'reset' });
      return ok({ result: result, bootstrap: bootstrap() });
    }

    return null;
  };
}

module.exports = { createApi: createApi };