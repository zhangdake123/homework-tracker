(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HomeworkStoreCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /*
   * 「班主任作业追踪」业务逻辑核心（纯静态版）
   *
   * 这份文件与有服务器版本的 src/db.js + src/api.js 表达同一套业务规则，
   * 差别只在于数据怎么落地：
   *   - 有服务器版本：SQLite（src/db.js），由 Node 提供 /api/* 接口
   *   - 纯静态托管版本：云开发数据库（store-cloudbase.mjs 负责提供 driver），浏览器直接读写
   *
   * 必须遵守的业务规则（与需求文档一致）：
   *   规则1 每个学生 × 每项作业独立追踪
   *   规则2 反复订正不丢失（待订正 / 待交回 / 待批改 可以来回循环）
   *   规则3 未收到 与 待交回 必须区分
   *   规则4 只有老师明确确认通过才变成已完成，新课次/新日期/新作业都不会自动完成
   *   规则5 每次状态变化都写入历史（原状态、新状态、时间）
   *   规则6 旧课次遗留任务一直保留并显示持续未完成天数
   *
   * driver 抽象（两套实现见 store-cloudbase.mjs / tests/static-store.test.js）：
   *   list(collection)                        -> Promise<doc[]>
   *   listWhere(collection, query)            -> Promise<doc[]>   // 等值查询
   *   get(collection, id)                     -> Promise<doc|null>
   *   put(collection, id, doc)                -> Promise<void>    // 按 _id 覆盖写入
   *   insert(collection, doc)                 -> Promise<string>  // 自动生成 _id
   *   patch(collection, id, partial)          -> Promise<void>
   *   removeWhere(collection, query)          -> Promise<void>
   */

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

  const STATUS_LABEL = Object.freeze({
    not_received: '未收到',
    to_correct: '待订正',
    to_return: '待交回',
    to_grade: '待批改',
    done: '已完成',
  });

  const DEFAULT_CLASS_SIZE = 38;

  const COLLECTIONS = Object.freeze({
    students: 'ht_students',
    tasks: 'ht_tasks',
    history: 'ht_history',
    settings: 'ht_settings',
  });

  const SETTINGS_ID = 'app';
  const KEY_EPOCH = 1577836800000; // 2020-01-01，用来把数字 ID 控制在安全整数范围内
  const ALLOWED_SCOPES = ['selected', 'all', 'pending', 'done'].concat(STATUS_LIST);

  let idCounter = 0;

  // 数字 ID：大致按时间递增，同一秒内靠计数器保证不重复，跨设备靠随机段降低碰撞概率。
  // 只用于界面上的定位（任务/学生/记录），真正的唯一键始终是 _id。
  function newId() {
    idCounter = (idCounter + 1) % 1000;
    const seconds = Math.floor((Date.now() - KEY_EPOCH) / 1000);
    return seconds * 1000000 + Math.floor(Math.random() * 1000) * 1000 + idCounter;
  }

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

  function emptyCounts() {
    return { not_received: 0, to_correct: 0, to_return: 0, to_grade: 0, done: 0, total: 0 };
  }

  function studentSortValue(studentNo) {
    const n = Number(String(studentNo === null || studentNo === undefined ? '' : studentNo).trim());
    return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
  }

  function compareStudentNo(a, b) {
    const diff = studentSortValue(a) - studentSortValue(b);
    if (diff !== 0) return diff;
    return String(a).localeCompare(String(b));
  }

  function toBool(value, fallback) {
    if (value === undefined || value === null || value === '') return !!fallback;
    if (typeof value === 'boolean') return value;
    const text = String(value).toLowerCase();
    if (['1', 'true', 'yes', 'on'].indexOf(text) !== -1) return true;
    if (['0', 'false', 'no', 'off'].indexOf(text) !== -1) return false;
    return !!fallback;
  }

  async function runBatched(operations, size) {
    const width = Math.max(1, size || 6);
    for (let i = 0; i < operations.length; i += width) {
      await Promise.all(operations.slice(i, i + width));
    }
  }

  function createStore(driver, options) {
    const opts = options || {};
    const C = COLLECTIONS;

    // ---------- 学生名单 ----------
    async function loadStudents() {
      const rows = await driver.list(C.students);
      return rows
        .map((s) => ({
          _id: s._id,
          id: Number(s.id),
          studentNo: String(s.studentNo === null || s.studentNo === undefined ? '' : s.studentNo),
          name: s.name === undefined || s.name === null || s.name === '' ? null : String(s.name),
          active: s.active === undefined ? true : !!s.active,
          createdAt: s.createdAt || null,
        }))
        .sort((a, b) => compareStudentNo(a.studentNo, b.studentNo));
    }

    async function studentMap() {
      const map = new Map();
      (await loadStudents()).forEach((s) => map.set(s.id, s));
      return map;
    }

    function publicStudent(student) {
      return {
        id: student.id,
        studentNo: student.studentNo,
        name: student.name,
        active: !!student.active,
        createdAt: student.createdAt || null,
      };
    }

    async function addStudentsUpTo(count) {
      const target = Math.max(1, Math.min(120, Number(count) || DEFAULT_CLASS_SIZE));
      const existing = await loadStudents();
      const byNo = new Map();
      existing.forEach((s) => byNo.set(s.studentNo, s));
      const created = [];
      const operations = [];
      for (let i = 1; i <= target; i += 1) {
        const no = pad2(i);
        const found = byNo.get(no);
        if (found) {
          if (!found.active) operations.push(driver.patch(C.students, found._id, { active: true }));
          continue;
        }
        const id = newId();
        created.push(no);
        operations.push(driver.put(C.students, 's' + id, {
          id: id,
          studentNo: no,
          name: null,
          active: true,
          createdAt: nowIso(),
        }));
      }
      await runBatched(operations, 6);
      return created;
    }

    async function ensureStudents() {
      const students = await loadStudents();
      if (students.length) return students;
      const settings = await loadSettings();
      await addStudentsUpTo(settings.classSize);
      return loadStudents();
    }

    // ---------- 设置 ----------
    async function loadSettings() {
      const doc = await driver.get(C.settings, SETTINGS_ID);
      const size = doc ? Number(doc.classSize) : NaN;
      return { classSize: Number.isFinite(size) && size > 0 ? Math.round(size) : DEFAULT_CLASS_SIZE };
    }

    async function saveSettings(patch) {
      const current = (await driver.get(C.settings, SETTINGS_ID)) || {};
      const next = Object.assign({}, current, patch, { updatedAt: nowIso() });
      delete next._id;
      await driver.put(C.settings, SETTINGS_ID, next);
    }

    // ---------- 任务 ----------
    function normalizeTask(doc) {
      return {
        _id: doc._id,
        id: Number(doc.id),
        book: String(doc.book || ''),
        lesson: String(doc.lesson || ''),
        content: String(doc.content || ''),
        title: String(doc.title || ''),
        taskDate: String(doc.taskDate || ''),
        status: doc.status === 'closed' ? 'closed' : 'open',
        createdAt: doc.createdAt || null,
        closedAt: doc.closedAt || null,
        assignments: (doc.assignments || []).map((a) => ({
          aid: Number(a.aid),
          studentId: Number(a.studentId),
          status: isStatus(a.status) ? a.status : STATUS.TO_GRADE,
          updatedAt: a.updatedAt || doc.createdAt || nowIso(),
          returned: !!a.returned,
        })),
      };
    }

    function taskDoc(task) {
      return {
        id: task.id,
        book: task.book,
        lesson: task.lesson,
        content: task.content,
        title: task.title,
        taskDate: task.taskDate,
        status: task.status,
        createdAt: task.createdAt,
        closedAt: task.closedAt || null,
        assignments: task.assignments.map((a) => ({
          aid: a.aid,
          studentId: a.studentId,
          status: a.status,
          updatedAt: a.updatedAt,
          returned: !!a.returned,
        })),
      };
    }

    async function loadTask(id) {
      const doc = await driver.get(C.tasks, 't' + Number(id));
      return doc ? normalizeTask(doc) : null;
    }

    async function loadTasks() {
      return (await driver.list(C.tasks)).map(normalizeTask);
    }

    async function saveTask(task) {
      await driver.put(C.tasks, 't' + task.id, taskDoc(task));
    }

    async function findTaskByAssignment(assignmentId) {
      const target = Number(assignmentId);
      const tasks = await loadTasks();
      for (const task of tasks) {
        if (task.assignments.some((a) => a.aid === target)) return task;
      }
      return null;
    }

    function buildTaskView(task, students) {
      const counts = emptyCounts();
      const assignments = task.assignments
        .map((a) => {
          const student = students instanceof Map ? students.get(a.studentId) : null;
          counts[a.status] = (counts[a.status] || 0) + 1;
          const statusDate = dateOnlyString(a.updatedAt) || task.taskDate;
          return {
            assignmentId: a.aid,
            studentId: a.studentId,
            studentNo: student ? student.studentNo : String(a.studentId),
            name: student ? student.name : null,
            active: student ? !!student.active : false,
            status: a.status,
            updatedAt: a.updatedAt,
            pendingDays: a.status === STATUS.DONE ? 0 : daysSinceDate(statusDate),
          };
        })
        .sort((a, b) => compareStudentNo(a.studentNo, b.studentNo));
      counts.total = assignments.length;
      const pending = assignments.filter((a) => a.status !== STATUS.DONE);
      let lastActivityAt = task.createdAt;
      pending.forEach((item) => {
        if (item.updatedAt > lastActivityAt) lastActivityAt = item.updatedAt;
      });
      return {
        id: task.id,
        book: task.book,
        lesson: task.lesson,
        content: task.content,
        title: task.title,
        taskDate: task.taskDate,
        status: task.status,
        createdAt: task.createdAt,
        closedAt: task.closedAt || null,
        daysPending: daysSinceDate(task.taskDate),
        counts: counts,
        pendingCount: pending.length,
        pending: pending,
        assignments: assignments,
        lastActivityAt: lastActivityAt,
      };
    }

    function sortViews(views) {
      return views.slice().sort((a, b) => (b.daysPending - a.daysPending) || (a.id - b.id));
    }

    async function listTaskViews(filters) {
      const f = filters || {};
      const [rawTasks, students] = await Promise.all([loadTasks(), studentMap()]);
      const views = rawTasks.map((task) => buildTaskView(task, students)).filter((view) => {
        if (!f.includeArchived && view.status !== 'open') return false;
        if (f.book && view.book !== f.book) return false;
        if (f.lesson && view.lesson !== f.lesson) return false;
        if (!f.includeDone && view.pendingCount === 0) return false;
        if (f.status && !view.counts[f.status]) return false;
        return true;
      });
      return sortViews(views);
    }

    async function meta(preloadedTasks) {
      const rawTasks = preloadedTasks || (await loadTasks());
      const books = [];
      const lessons = [];
      rawTasks.forEach((t) => {
        if (books.indexOf(t.book) === -1) books.push(t.book);
        if (lessons.indexOf(t.lesson) === -1) lessons.push(t.lesson);
      });
      books.sort();
      lessons.sort();
      const settings = await loadSettings();
      return {
        statuses: STATUS_LIST.map((key) => ({ key: key, label: STATUS_LABEL[key], done: key === STATUS.DONE })),
        books: books.map((b) => ({ book: b, tasks: rawTasks.filter((t) => t.book === b).length })),
        lessons: lessons.map((l) => ({ lesson: l, tasks: rawTasks.filter((t) => t.lesson === l).length })),
        today: localDateString(),
        classSize: settings.classSize,
      };
    }

    async function bootstrap() {
      const students = await ensureStudents();
      const rawTasks = await loadTasks();
      const settings = await loadSettings();
      const map = new Map();
      students.forEach((s) => map.set(s.id, s));
      const tasks = sortViews(rawTasks.map((task) => buildTaskView(task, map)));
      return {
        settings: settings,
        students: students.filter((s) => s.active).map(publicStudent),
        allStudents: students.map(publicStudent),
        tasks: tasks,
        meta: await meta(rawTasks),
        serverTime: nowIso(),
      };
    }

    async function createTask(body) {
      const book = String(body.book || '').trim();
      const lesson = String(body.lesson || '').trim();
      if (!book) throw new Error('缺少必填项：作业册');
      if (!lesson) throw new Error('缺少必填项：课次');
      if (body.initialStatus && !isStatus(body.initialStatus)) throw new Error('无效的 initialStatus');
      const students = await ensureStudents();
      const active = students.filter((s) => s.active);
      if (!active.length) throw new Error('班级名单为空，请先在“名单 / 设置”里生成学号');
      const content = String(body.content || '').trim() || '作业';
      const taskDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.taskDate || ''))
        ? String(body.taskDate)
        : localDateString();
      const title = String(body.title || '').trim() || makeTaskTitle(book, lesson, content);
      const initialStatus = isStatus(body.initialStatus) ? body.initialStatus : STATUS.TO_GRADE;
      const ts = nowIso();
      const id = newId();
      const task = {
        id: id,
        book: book,
        lesson: lesson,
        content: content,
        title: title,
        taskDate: taskDate,
        status: 'open',
        createdAt: ts,
        closedAt: null,
        assignments: active.map((s) => ({
          aid: newId(),
          studentId: s.id,
          status: initialStatus,
          updatedAt: ts,
          returned: initialStatus === STATUS.TO_CORRECT || initialStatus === STATUS.TO_RETURN,
        })),
      };
      await saveTask(task);
      // 创建事件只写一条历史（内含全班名单），避免建任务时写 38 条记录
      await driver.insert(C.history, {
        seq: newId(),
        kind: 'create',
        taskId: task.id,
        fromStatus: null,
        toStatus: initialStatus,
        note: '创建任务',
        changedAt: ts,
        source: 'create',
        items: task.assignments.map((a) => ({ assignmentId: a.aid, studentId: a.studentId })),
      });
      return { task: buildTaskView(task, await studentMap()) };
    }

    function changeEntry(task, assignmentId, status, note, source, ts) {
      const entry = task.assignments.filter((a) => a.aid === Number(assignmentId))[0];
      if (!entry) return null;
      if (entry.status === status) {
        return {
          assignmentId: entry.aid,
          studentId: entry.studentId,
          from: entry.status,
          to: status,
          updatedAt: entry.updatedAt,
          unchanged: true,
        };
      }
      const from = entry.status;
      entry.status = status;
      entry.updatedAt = ts;
      if (status === STATUS.TO_CORRECT || status === STATUS.TO_RETURN) entry.returned = true;
      return {
        assignmentId: entry.aid,
        taskId: task.id,
        studentId: entry.studentId,
        from: from,
        to: status,
        updatedAt: ts,
        note: note || null,
        source: source || 'manual',
      };
    }

    async function writeHistoryRows(changes) {
      const rows = changes.filter((c) => c && !c.unchanged);
      await runBatched(rows.map((c) => driver.insert(C.history, {
        seq: newId(),
        kind: 'change',
        taskId: c.taskId,
        assignmentId: c.assignmentId,
        studentId: c.studentId,
        fromStatus: c.from,
        toStatus: c.to,
        note: c.note || null,
        changedAt: c.updatedAt,
        source: c.source || 'manual',
      })), 6);
    }

    function resolveTargets(task, scope, studentIds, students) {
      const rows = task.assignments.map((a) => {
        const student = students.get(a.studentId) || null;
        return {
          assignmentId: a.aid,
          studentId: a.studentId,
          status: a.status,
          returned: !!a.returned,
          studentNo: student ? student.studentNo : String(a.studentId),
          name: student ? student.name : null,
        };
      });
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

    async function applyBulk(taskId, body) {
      const scope = body && body.scope ? String(body.scope) : 'selected';
      if (ALLOWED_SCOPES.indexOf(scope) === -1) throw new Error('无效的 scope：' + scope);
      const action = body && body.action ? String(body.action) : null;
      const status = body && body.status ? String(body.status) : null;
      if (!action && !isStatus(status)) throw new Error('需要提供有效的 status 或 action');
      const task = await loadTask(taskId);
      if (!task) throw new Error('任务不存在');
      const students = await studentMap();
      const targets = resolveTargets(task, scope, body && body.studentIds, students);
      const ts = nowIso();
      const changes = [];
      const updated = [];
      targets.forEach((target) => {
        let next = status;
        if (action === 'return') next = target.returned ? STATUS.TO_RETURN : STATUS.TO_CORRECT;
        if (!isStatus(next)) return;
        const change = changeEntry(task, target.assignmentId, next, body && body.note, (body && body.source) || 'bulk', ts);
        if (!change || change.unchanged) return;
        changes.push(change);
        updated.push({
          assignmentId: change.assignmentId,
          studentId: change.studentId,
          studentNo: target.studentNo,
          name: target.name,
          from: change.from,
          to: change.to,
          updatedAt: change.updatedAt,
        });
      });
      if (changes.length) {
        await saveTask(task);
        await writeHistoryRows(changes);
      }
      return { updated: updated, task: buildTaskView(task, students) };
    }

    async function applyOne(assignmentId, status, body) {
      if (!isStatus(status)) throw new Error('无效的状态：' + status);
      const task = await findTaskByAssignment(assignmentId);
      if (!task) throw new Error('记录不存在');
      const ts = nowIso();
      const change = changeEntry(task, assignmentId, status, body && body.note, (body && body.source) || 'manual', ts);
      if (!change) throw new Error('记录不存在');
      if (!change.unchanged) {
        await saveTask(task);
        await writeHistoryRows([change]);
      }
      const students = await studentMap();
      const student = students.get(change.studentId);
      return {
        assignment: {
          assignmentId: change.assignmentId,
          studentId: change.studentId,
          studentNo: student ? student.studentNo : null,
          from: change.from,
          to: change.to,
          updatedAt: change.updatedAt,
        },
        task: buildTaskView(task, students),
      };
    }

    async function restoreAssignments(items) {
      const tasks = await loadTasks();
      const students = await studentMap();
      const ts = nowIso();
      const changes = [];
      const updated = [];
      const touched = new Map();
      (items || []).forEach((item) => {
        const assignmentId = Number(item && item.assignmentId);
        const status = item && item.status;
        if (!assignmentId || !isStatus(status)) return;
        const task = tasks.filter((t) => t.assignments.some((a) => a.aid === assignmentId))[0];
        if (!task) return;
        const change = changeEntry(task, assignmentId, status, '撤销上一步操作', 'undo', ts);
        if (!change || change.unchanged) return;
        changes.push(change);
        touched.set(task.id, task);
        const student = students.get(change.studentId);
        updated.push({
          assignmentId: change.assignmentId,
          studentId: change.studentId,
          studentNo: student ? student.studentNo : null,
          from: change.from,
          to: change.to,
        });
      });
      for (const task of touched.values()) await saveTask(task);
      await writeHistoryRows(changes);
      return { updated: updated };
    }

    async function updateTask(id, patch) {
      const task = await loadTask(id);
      if (!task) throw new Error('任务不存在');
      if (patch && patch.status !== undefined && ['open', 'closed'].indexOf(String(patch.status)) === -1) {
        throw new Error('无效的任务状态（仅支持 open / closed）');
      }
      if (patch && patch.book !== undefined) task.book = String(patch.book).trim();
      if (patch && patch.lesson !== undefined) task.lesson = String(patch.lesson).trim();
      if (patch && patch.content !== undefined) task.content = String(patch.content).trim();
      if (patch && patch.taskDate !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(String(patch.taskDate))) {
        task.taskDate = String(patch.taskDate);
      }
      if (patch && patch.status !== undefined) {
        task.status = String(patch.status);
        task.closedAt = task.status === 'closed' ? nowIso() : null;
      }
      if (patch && (patch.book !== undefined || patch.lesson !== undefined || patch.content !== undefined || patch.title !== undefined)) {
        const explicit = patch.title !== undefined ? String(patch.title).trim() : '';
        task.title = explicit || makeTaskTitle(task.book, task.lesson, task.content);
      }
      await saveTask(task);
      return { task: buildTaskView(task, await studentMap()) };
    }

    async function deleteTask(id) {
      const key = 't' + Number(id);
      const doc = await driver.get(C.tasks, key);
      if (!doc) throw new Error('任务不存在');
      await driver.remove(C.tasks, key);
      await driver.removeWhere(C.history, { taskId: Number(id) });
    }

    // ---------- 历史 ----------
    function historyRowFromDoc(doc, task, students) {
      const student = students.get(Number(doc.studentId)) || null;
      return {
        id: Number(doc.seq || 0),
        assignmentId: Number(doc.assignmentId),
        taskId: Number(doc.taskId),
        studentId: Number(doc.studentId),
        fromStatus: doc.fromStatus === undefined ? null : doc.fromStatus,
        toStatus: doc.toStatus,
        note: doc.note === undefined ? null : doc.note,
        changedAt: doc.changedAt,
        source: doc.source || 'manual',
        seq: Number(doc.seq || 0),
        taskTitle: task ? task.title : null,
        book: task ? task.book : null,
        lesson: task ? task.lesson : null,
        content: task ? task.content : null,
        studentNo: student ? student.studentNo : null,
        name: student ? student.name : null,
      };
    }

    async function listHistory(filters) {
      const f = filters || {};
      const docs = f.taskId
        ? await driver.listWhere(C.history, { taskId: Number(f.taskId) })
        : await driver.list(C.history);
      const students = await studentMap();
      const taskCache = new Map();
      async function taskOf(taskId) {
        const key = Number(taskId);
        if (!taskCache.has(key)) taskCache.set(key, await loadTask(key));
        return taskCache.get(key);
      }
      const rows = [];
      for (const doc of docs) {
        const task = await taskOf(doc.taskId);
        if (doc.kind === 'create') {
          const items = doc.items || [];
          for (const item of items) {
            if (f.studentId && Number(item.studentId) !== Number(f.studentId)) continue;
            if (f.assignmentId && Number(item.assignmentId) !== Number(f.assignmentId)) continue;
            rows.push(historyRowFromDoc({
              seq: doc.seq,
              assignmentId: item.assignmentId,
              taskId: doc.taskId,
              studentId: item.studentId,
              fromStatus: null,
              toStatus: doc.toStatus,
              note: doc.note,
              changedAt: doc.changedAt,
              source: doc.source,
            }, task, students));
          }
          continue;
        }
        if (f.studentId && Number(doc.studentId) !== Number(f.studentId)) continue;
        if (f.assignmentId && Number(doc.assignmentId) !== Number(f.assignmentId)) continue;
        rows.push(historyRowFromDoc(doc, task, students));
      }
      rows.sort((a, b) => {
        if (a.changedAt === b.changedAt) return (b.seq || 0) - (a.seq || 0);
        return a.changedAt < b.changedAt ? 1 : -1;
      });
      const limit = Math.max(1, Math.min(1000, Number(f.limit) || 200));
      return rows.slice(0, limit);
    }

    // ---------- 学生写操作 ----------
    async function addStudent(body) {
      const studentNo = String((body && body.studentNo) || '').trim();
      if (!studentNo) throw new Error('学号不能为空');
      const students = await loadStudents();
      if (students.some((s) => s.studentNo === studentNo)) throw new Error('学号已存在：' + studentNo);
      const name = body && body.name ? String(body.name).trim() : null;
      const id = newId();
      await driver.put(C.students, 's' + id, { id: id, studentNo: studentNo, name: name, active: true, createdAt: nowIso() });
      return { student: { id: id, studentNo: studentNo, name: name, active: true } };
    }

    async function updateStudent(id, patch) {
      const students = await loadStudents();
      const student = students.filter((s) => s.id === Number(id))[0];
      if (!student) throw new Error('学生不存在');
      const next = {};
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'name')) {
        next.name = patch.name === null || patch.name === '' ? null : String(patch.name).trim();
      }
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'active')) {
        next.active = !!patch.active;
      }
      if (Object.keys(next).length) await driver.patch(C.students, student._id, next);
      return {
        student: {
          id: student.id,
          studentNo: student.studentNo,
          name: Object.prototype.hasOwnProperty.call(next, 'name') ? next.name : student.name,
          active: Object.prototype.hasOwnProperty.call(next, 'active') ? next.active : student.active,
        },
      };
    }

    async function setClassSize(size) {
      const rounded = Math.round(Number(size));
      if (!Number.isFinite(rounded) || rounded < 1 || rounded > 120) throw new Error('班级人数需在 1 - 120 之间');
      await saveSettings({ classSize: rounded });
      const created = await addStudentsUpTo(rounded);
      return { settings: await loadSettings(), students: (await loadStudents()).map(publicStudent), created: created };
    }

    async function clearCollection(collection) {
      if (typeof driver.clear === 'function') {
        await driver.clear(collection);
        return;
      }
      await driver.removeWhere(collection, {});
    }

    async function resetData(keepStudents) {
      const tasks = await loadTasks();
      await runBatched(tasks.map((t) => driver.remove(C.tasks, 't' + t.id)), 6);
      await clearCollection(C.history);
      if (!keepStudents) {
        const students = await loadStudents();
        await runBatched(students.map((s) => driver.remove(C.students, s._id)), 6);
        await addStudentsUpTo((await loadSettings()).classSize);
      }
      return { students: (await loadStudents()).length, tasks: (await loadTasks()).length };
    }

    async function exportAll() {
      const [students, tasks, history, settings] = await Promise.all([
        driver.list(C.students),
        driver.list(C.tasks),
        driver.list(C.history),
        driver.get(C.settings, SETTINGS_ID),
      ]);
      return {
        app: 'homework-tracker',
        formatVersion: 1,
        exportedAt: nowIso(),
        settings: settings || null,
        students: students,
        tasks: tasks,
        history: history,
      };
    }

    async function route(pathname, method, query, body) {
      if (pathname === '/api/bootstrap' && method === 'GET') return bootstrap();
      if (pathname === '/api/meta' && method === 'GET') return meta();

      if (pathname === '/api/tasks' && method === 'GET') {
        const tasks = await listTaskViews({
          book: query.book || null,
          lesson: query.lesson || null,
          status: query.status || null,
          includeArchived: toBool(query.includeArchived, false),
          includeDone: toBool(query.includeDone, false),
        });
        return { tasks: tasks, meta: await meta(), serverTime: nowIso() };
      }

      if (pathname === '/api/tasks' && method === 'POST') return createTask(body);

      let match = pathname.match(/^\/api\/tasks\/(\d+)\/bulk$/);
      if (match && method === 'POST') return applyBulk(match[1], body);

      match = pathname.match(/^\/api\/tasks\/(\d+)\/history$/);
      if (match && method === 'GET') {
        return { history: await listHistory({ taskId: Number(match[1]), limit: query.limit }) };
      }

      match = pathname.match(/^\/api\/tasks\/(\d+)$/);
      if (match && method === 'GET') {
        const task = await loadTask(match[1]);
        if (!task) throw new Error('任务不存在');
        return { task: buildTaskView(task, await studentMap()) };
      }
      if (match && method === 'PATCH') return updateTask(match[1], body);
      if (match && method === 'DELETE') {
        await deleteTask(match[1]);
        return { deleted: true };
      }

      match = pathname.match(/^\/api\/assignments\/(\d+)$/);
      if (match && method === 'PATCH') {
        const status = body.status ? String(body.status) : '';
        return applyOne(match[1], status, body);
      }

      if (pathname === '/api/assignments/restore' && method === 'POST') {
        return restoreAssignments(body.items);
      }

      if (pathname === '/api/students' && method === 'GET') {
        const students = await loadStudents();
        return { students: students.filter((s) => s.active).map(publicStudent), allStudents: students.map(publicStudent) };
      }

      if (pathname === '/api/students' && method === 'POST') return addStudent(body);

      match = pathname.match(/^\/api\/students\/(\d+)\/history$/);
      if (match && method === 'GET') {
        return {
          history: await listHistory({
            studentId: Number(match[1]),
            taskId: query.taskId ? Number(query.taskId) : null,
            limit: query.limit,
          }),
        };
      }

      match = pathname.match(/^\/api\/students\/(\d+)$/);
      if (match && method === 'PATCH') return updateStudent(match[1], body);

      if (pathname === '/api/history' && method === 'GET') {
        return {
          history: await listHistory({
            taskId: query.taskId ? Number(query.taskId) : null,
            studentId: query.studentId ? Number(query.studentId) : null,
            assignmentId: query.assignmentId ? Number(query.assignmentId) : null,
            limit: query.limit,
          }),
        };
      }

      if (pathname === '/api/settings/class-size' && method === 'POST') return setClassSize(body.classSize);

      if (pathname === '/api/admin/reset' && method === 'POST') {
        if (String(body.confirm || '') !== 'RESET') throw new Error('危险操作需要确认参数 confirm="RESET"');
        const result = await resetData(toBool(body.keepStudents, true));
        return { result: result, bootstrap: await bootstrap() };
      }

      const error = new Error('接口不存在：' + pathname);
      error.status = 404;
      throw error;
    }

    return {
      mode: opts.mode || 'static',
      collections: C,
      request: async function request(path, method, body) {
        const url = new URL(String(path || '/'), 'http://store.local');
        const query = {};
        url.searchParams.forEach((value, key) => {
          query[key] = value;
        });
        return route(url.pathname, String(method || 'GET').toUpperCase(), query, body || {});
      },
      loadStudents: loadStudents,
      loadSettings: loadSettings,
      exportAll: exportAll,
      addStudentsUpTo: addStudentsUpTo,
      ensureStudents: ensureStudents,
    };
  }

  return {
    STATUS: STATUS,
    STATUS_LIST: STATUS_LIST,
    STATUS_LABEL: STATUS_LABEL,
    DEFAULT_CLASS_SIZE: DEFAULT_CLASS_SIZE,
    COLLECTIONS: COLLECTIONS,
    createStore: createStore,
  };
});
