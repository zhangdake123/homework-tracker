'use strict';

const STATUS_LABEL = { not_received: '未收到', to_correct: '待订正', to_return: '待交回', to_grade: '待批改', done: '已完成' };
const STATUS_MARKER = { not_received: '未', to_correct: '订', to_return: '回', to_grade: '批', done: '✓' };
const STATUS_ORDER = ['not_received', 'to_correct', 'to_return', 'to_grade', 'done'];
const STATUS_HINT = {
  not_received: '一开始就没有收到这份作业',
  to_correct: '已批改，需要学生订正',
  to_return: '退回后还没交回来',
  to_grade: '已经交回，等待老师检查',
  done: '老师已确认通过',
};

const INIT_PRESETS = [{ key: 'to_grade', label: '待批改（推荐）' }, { key: 'to_correct', label: '待订正' }];

const state = {
  view: 'register',
  students: [],
  allStudents: [],
  tasks: [],
  meta: { statuses: [], books: [], lessons: [], today: '', classSize: 38 },
  settings: { classSize: 38 },
  form: { initStatus: 'to_grade' },
  filters: { book: '', lesson: '', status: '', includeDone: false, includeArchived: false },
  mark: { taskId: null, selected: new Set(), stamp: 'done', stampMode: false },
  detail: { taskId: null, statusFilter: '', selected: new Set(), showHistory: false },
  undo: null,
  lastUpdated: null,
  loading: false,
};

function $(id) { return document.getElementById(id); }

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function noText(studentNo) {
  return String(studentNo === null || studentNo === undefined ? '?' : studentNo);
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function fmtClock(iso) {
  const d = new Date(iso || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

let backend = null;
let backendError = null;

async function api(path, method, body) {
  if (backend) return backend.request(path, method, body);
  const options = { method: method || 'GET', headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined && body !== null) options.body = JSON.stringify(body);
  const res = await fetch(path, options);
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (err) { data = null; }
  }
  if (!res.ok) throw new Error((data && data.error) || ('请求失败 HTTP ' + res.status));
  return data;
}

async function refresh(options) {
  const opts = options || {};
  try {
    const data = await api('/api/bootstrap');
    state.students = data.students || [];
    state.allStudents = data.allStudents || state.students;
    state.tasks = data.tasks || [];
    state.meta = data.meta || state.meta;
    state.settings = data.settings || state.settings;
    state.lastUpdated = new Date().toISOString();
    if (!$('taskDate').value) $('taskDate').value = state.meta.today;
    if (!$('classSize').value) $('classSize').value = state.settings.classSize;
    setSync('已同步 ' + fmtClock(), 'ok');
    renderAll(opts);
  } catch (err) {
    setSync(backend ? '云开发读取失败' : '连接失败', 'warn');
    if (!opts.silent) showToast(connectionFailText() + (err && err.message ? err.message : String(err)));
  }
}

function setSync(text, kind) {
  const el = $('syncState');
  el.textContent = text;
  el.className = 'sync' + (kind ? ' ' + kind : '');
}

function findTask(taskId) {
  const id = Number(taskId);
  return state.tasks.filter((t) => t.id === id)[0] || null;
}

function switchView(view) {
  state.view = view;
  renderAll();
}

function renderAll(options) {
  const opts = options || {};
  document.querySelectorAll('.view').forEach((el) => { el.classList.remove('active'); });
  const current = $('view-' + state.view);
  if (current) current.classList.add('active');
  document.querySelectorAll('.tab').forEach((el) => {
    el.classList.toggle('active', el.getAttribute('data-view') === state.view || (state.view === 'detail' && el.getAttribute('data-view') === 'board'));
  });
  renderForm();
  renderMarkPanel();
  renderRecent();
  renderBoardFilters();
  renderBoard();
  renderDetail();
  if (!opts.skipRoster) renderRoster();
  renderCloudCard();
  $('rosterInfo').textContent = '当前名单 ' + state.students.length + ' 人，任务 ' + state.tasks.length + ' 个。' + dataLocationText();
}

function statusCountChips(counts) {
  return STATUS_ORDER.map((s) => {
    const n = counts[s] || 0;
    return '<span class="mini s-' + s + (n ? '' : ' dim') + '">' + STATUS_LABEL[s] + ' ' + n + '</span>';
  }).join('');
}

function legendHtml() {
  return STATUS_ORDER.map((s) => '<span class="mini s-' + s + '">' + STATUS_LABEL[s] + '：' + STATUS_HINT[s] + '</span>').join('');
}

const FORM_INPUTS = { book: 'bookInput', lesson: 'lessonInput', content: 'contentInput' };

function formValue(kind) {
  const input = $(FORM_INPUTS[kind]);
  return input ? String(input.value || '').trim() : '';
}

function distinctValues() {
  const seen = [];
  for (let i = 0; i < arguments.length; i += 1) {
    const list = arguments[i] || [];
    for (let j = 0; j < list.length; j += 1) {
      const text = String(list[j] === null || list[j] === undefined ? '' : list[j]).trim();
      if (text && seen.indexOf(text) === -1) seen.push(text);
    }
  }
  return seen;
}

function fillDatalist(id, values) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = values.map((value) => '<option value="' + esc(value) + '"></option>').join('');
}

function composeTitle() {
  const parts = [formValue('book'), formValue('lesson'), formValue('content')].filter(Boolean);
  if (!parts.length) return '—';
  const base = parts.join('·');
  return /作业$/.test(base) ? base : base + '作业';
}

function renderForm() {
  fillDatalist('bookList', distinctValues(['A册', 'B册', 'C册'], state.meta.books.map((b) => b.book)));
  fillDatalist('lessonList', distinctValues(state.meta.lessons.map((l) => l.lesson)));
  fillDatalist('contentList', distinctValues(['练习', '抄写', '订正'], state.tasks.map((t) => t.content)));
  $('initStatusChips').innerHTML = INIT_PRESETS.map((item) =>
    '<button type="button" class="pick' + (state.form.initStatus === item.key ? ' active' : '') + '" data-action="init-status" data-value="' + item.key + '">' + esc(item.label) + '</button>'
  ).join('');
  $('titlePreview').textContent = composeTitle();
  if (!$('taskDate').value) $('taskDate').value = state.meta.today;
}

function renderRecent() {
  const items = state.tasks.slice(0, 6);
  if (!items.length) {
    $('recentTasks').innerHTML = '<p class="hint">还没有任务。上面填好作业册、课次、内容后点“创建任务”。</p>';
    return;
  }
  $('recentTasks').innerHTML = items.map((t) =>
    '<div class="recent-item">' +
      '<div><div class="t">' + esc(t.title) + '</div>' +
      '<div class="m">' + esc(t.taskDate) + ' · 未完成 ' + t.pendingCount + ' 人 · 已完成 ' + (t.counts.done || 0) + ' 人 · 已持续 ' + t.daysPending + ' 天</div></div>' +
      '<button class="btn small" type="button" data-action="open-mark" data-task="' + t.id + '">继续标记</button>' +
    '</div>'
  ).join('');
}

function renderMarkPanel() {
  const panel = $('markPanel');
  const task = findTask(state.mark.taskId);
  if (!task) { panel.hidden = true; return; }
  panel.hidden = false;
  $('markTitle').textContent = task.title;
  $('markMeta').textContent = '创建日期 ' + task.taskDate + ' · 全班 ' + task.counts.total + ' 人 · 未完成 ' + task.pendingCount + ' 人 · 已完成 ' + (task.counts.done || 0) + ' 人 · 已持续 ' + task.daysPending + ' 天';
  $('markLegend').innerHTML = statusCountChips(task.counts);
  $('markGrid').innerHTML = task.assignments.map((a) =>
    '<button type="button" class="chip s-' + a.status + (state.mark.selected.has(a.studentId) ? ' selected' : '') +
    '" data-action="mark-chip" data-task="' + task.id + '" data-student="' + a.studentId + '" title="' + esc(noText(a.studentNo) + ' · ' + STATUS_LABEL[a.status]) + '">' +
    '<span class="no">' + esc(noText(a.studentNo)) + '</span><span class="marker">' + STATUS_MARKER[a.status] + '</span></button>'
  ).join('');
  $('selCount').textContent = '已选 ' + state.mark.selected.size + ' 人';
  const buttons = STATUS_ORDER.map((s) =>
    '<button class="btn status-btn s-' + s + '" type="button" data-action="mark-apply" data-task="' + task.id + '" data-status="' + s + '">标记为' + STATUS_LABEL[s] + '</button>'
  ).join('');
  $('markActions').innerHTML =
    '<span class="label">先点选学号（可多选），再点下面的状态按钮</span>' + buttons +
    '<button class="btn wide plain" type="button" data-action="mark-rest" data-task="' + task.id + '">其余未批改的学生 → 待订正（一键）</button>' +
    '<button class="btn wide plain" type="button" data-action="mark-all" data-task="' + task.id + '">全班未完成 → 待批改</button>';
}

async function createTask() {
  const book = formValue('book');
  const lesson = formValue('lesson');
  const content = formValue('content') || '作业';
  if (!book) { showToast('请先选择或填写作业册'); return; }
  if (!lesson) { showToast('请先选择或填写课次'); return; }
  if (!state.students.length) { showToast('班级名单为空，请到“名单 / 设置”生成学号'); return; }
  const button = $('btnCreateTask');
  button.disabled = true;
  try {
    const res = await api('/api/tasks', 'POST', {
      book: book,
      lesson: lesson,
      content: content,
      taskDate: $('taskDate').value || state.meta.today,
      initialStatus: state.form.initStatus,
    });
    $('bookInput').value = '';
    $('lessonInput').value = '';
    $('contentInput').value = '';
    state.mark.taskId = res.task.id;
    state.mark.selected = new Set();
    await refresh();
    switchView('register');
    showToast('已创建：' + res.task.title + '（自动生成 ' + res.task.counts.total + ' 个学号）');
  } catch (err) {
    showToast('创建失败：' + err.message);
  } finally {
    button.disabled = false;
  }
}

async function applyBulk(taskId, payload, label) {
  try {
    const res = await api('/api/tasks/' + taskId + '/bulk', 'POST', payload);
    const updated = res.updated || [];
    state.undo = updated.length
      ? { label: label, items: updated.map((u) => ({ assignmentId: u.assignmentId, status: u.from })), at: new Date().toISOString() }
      : null;
    state.mark.selected = new Set();
    state.detail.selected = new Set();
    await refresh();
    if (updated.length) {
      showToast(label + '：更新 ' + updated.length + ' 人', '撤销');
    } else {
      showToast(label + '：没有需要更新的学生');
    }
    return res;
  } catch (err) {
    showToast('操作失败：' + err.message);
    return null;
  }
}

async function applyOne(assignmentId, status, label) {
  try {
    const res = await api('/api/assignments/' + assignmentId, 'PATCH', { status: status });
    const assignment = res.assignment;
    if (assignment.from === assignment.to) {
      await refresh();
      showToast('该学生当前已经是「' + STATUS_LABEL[status] + '」，没有变化');
      return res;
    }
    state.undo = { label: label, items: [{ assignmentId: assignmentId, status: assignment.from }], at: new Date().toISOString() };
    await refresh();
    showToast(label + '：' + STATUS_LABEL[assignment.from] + ' → ' + STATUS_LABEL[assignment.to], '撤销');
    return res;
  } catch (err) {
    showToast('操作失败：' + err.message);
    return null;
  }
}

async function undoLast() {
  if (!state.undo || !state.undo.items.length) { showToast('没有可撤销的操作'); return; }
  try {
    const res = await api('/api/assignments/restore', 'POST', { items: state.undo.items });
    const label = state.undo.label;
    state.undo = null;
    await refresh();
    showToast('已撤销：' + label + '（恢复 ' + ((res.updated || []).length) + ' 人）');
  } catch (err) {
    showToast('撤销失败：' + err.message);
  }
}

let toastTimer = null;
function showToast(message, undoLabel) {
  const el = $('toast');
  el.innerHTML = '<span>' + esc(message) + '</span>' + (undoLabel ? '<button class="btn" type="button" id="toastUndo">' + esc(undoLabel) + '</button>' : '');
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, undoLabel ? 12000 : 4200);
  const undoButton = $('toastUndo');
  if (undoButton) undoButton.addEventListener('click', () => { el.hidden = true; undoLast(); });
}

function openOverlay() { $('overlay').hidden = false; }
function closeOverlay() { $('overlay').hidden = true; }
function renderBoardFilters() {
  const book = state.filters.book;
  const lesson = state.filters.lesson;
  const status = state.filters.status;
  const books = [];
  const lessons = [];
  state.tasks.forEach((t) => {
    if (books.indexOf(t.book) === -1) books.push(t.book);
    if (lessons.indexOf(t.lesson) === -1) lessons.push(t.lesson);
  });
  $('filterBook').innerHTML = '<option value="">全部作业册</option>' + books.map((b) => '<option value="' + esc(b) + '">' + esc(b) + '</option>').join('');
  $('filterLesson').innerHTML = '<option value="">全部课次</option>' + lessons.map((l) => '<option value="' + esc(l) + '">' + esc(l) + '</option>').join('');
  $('filterStatus').innerHTML = '<option value="">全部状态</option>' + STATUS_ORDER.map((s) => '<option value="' + s + '">' + STATUS_LABEL[s] + '</option>').join('');
  $('filterBook').value = books.indexOf(book) === -1 ? '' : book;
  $('filterLesson').value = lessons.indexOf(lesson) === -1 ? '' : lesson;
  $('filterStatus').value = status;
  $('showDone').checked = state.filters.includeDone;
  $('showArchived').checked = state.filters.includeArchived;
  $('boardLegend').innerHTML = legendHtml();
}

function visibleTasks() {
  const f = state.filters;
  return state.tasks.filter((t) => {
    if (!f.includeArchived && t.status !== 'open') return false;
    if (!f.includeDone && t.pendingCount === 0) return false;
    if (f.book && t.book !== f.book) return false;
    if (f.lesson && t.lesson !== f.lesson) return false;
    if (f.status && !(t.counts[f.status] > 0)) return false;
    return true;
  });
}

function boardCardHtml(task) {
  const f = state.filters;
  const statuses = f.status ? [f.status] : STATUS_ORDER.filter((s) => (s === 'done' ? f.includeDone : true));
  const groups = statuses.map((s) => {
    const list = task.assignments.filter((a) => a.status === s);
    if (!list.length) return '';
    const chips = list.map((a) =>
      '<button type="button" class="st-chip s-' + s + '" data-action="quick" data-task="' + task.id + '" data-assignment="' + a.assignmentId + '" data-student="' + a.studentId + '">' +
      esc(noText(a.studentNo)) + (a.pendingDays > 0 ? '<span class="age">' + a.pendingDays + '天</span>' : '') + '</button>'
    ).join('');
    return '<div class="group s-' + s + '"><div class="group-head"><span class="tag">' + STATUS_LABEL[s] + ' ' + list.length + ' 人</span>' +
      '<span class="muted">' + STATUS_HINT[s] + '</span></div><div class="chips-inline">' + chips + '</div></div>';
  }).join('');
  const age = task.daysPending > 0
    ? '<span class="pill age">已持续 ' + task.daysPending + ' 天未完成</span>'
    : '<span class="pill">今天创建</span>';
  return '<div class="task-card' + (task.daysPending >= 3 && task.pendingCount > 0 ? ' stale' : '') + '">' +
    '<div class="task-head"><div><div class="task-title">' + esc(task.title) + '</div><div class="task-meta">' +
    '<span class="pill">创建 ' + esc(task.taskDate) + '</span>' + age +
    '<span class="pill">未完成 ' + task.pendingCount + ' 人</span>' +
    '<span class="pill">已完成 ' + (task.counts.done || 0) + ' 人</span>' +
    (task.status === 'closed' ? '<span class="pill">已归档</span>' : '') +
    '</div></div><div class="task-actions">' +
    '<button type="button" class="btn small" data-action="detail" data-task="' + task.id + '">打开详情</button>' +
    '<button type="button" class="btn small ghost" data-action="open-mark" data-task="' + task.id + '">去标记</button>' +
    '<button type="button" class="btn small ghost" data-action="archive" data-task="' + task.id + '" data-next="' + (task.status === 'closed' ? 'open' : 'closed') + '">' + (task.status === 'closed' ? '恢复' : '归档') + '</button>' +
    '</div></div>' +
    '<div class="counts">' + statusCountChips(task.counts) + '</div>' + groups + '</div>';
}

function renderBoard() {
  const tasks = visibleTasks();
  $('boardUpdated').textContent = state.lastUpdated ? '最后更新 ' + fmtClock(state.lastUpdated) : '';
  if (!tasks.length) {
    $('boardList').innerHTML = '<div class="empty">当前筛选下没有未完成的作业任务。<br />（已确认通过的任务默认隐藏，可勾选“显示已完成任务”查看）</div>';
    return;
  }
  const byBook = new Map();
  tasks.forEach((t) => {
    if (!byBook.has(t.book)) byBook.set(t.book, []);
    byBook.get(t.book).push(t);
  });
  let html = '';
  byBook.forEach((list, book) => {
    const pending = list.reduce((sum, t) => sum + t.pendingCount, 0);
    html += '<div class="group-head s-none"><span class="tag">' + esc(book) + '（' + list.length + ' 个任务，未完成合计 ' + pending + ' 人次）</span></div>';
    html += list.map(boardCardHtml).join('');
  });
  $('boardList').innerHTML = html;
}

function openDetail(taskId) {
  state.detail.taskId = Number(taskId);
  state.detail.selected = new Set();
  state.detail.statusFilter = '';
  state.detail.showHistory = false;
  switchView('detail');
}

function renderDetail() {
  const task = findTask(state.detail.taskId);
  if (!task) {
    $('detailTitle').textContent = '未选择任务';
    $('detailMeta').textContent = '请从待办看板打开一个任务。';
    $('detailCounts').innerHTML = '';
    $('detailActions').innerHTML = '';
    $('detailList').innerHTML = '';
    $('detailHistory').hidden = true;
    return;
  }
  $('detailTitle').textContent = task.title;
  $('detailMeta').textContent = '创建日期 ' + task.taskDate + ' · 全班 ' + task.counts.total + ' 人 · 未完成 ' + task.pendingCount +
    ' 人 · 已完成 ' + (task.counts.done || 0) + ' 人 · 已持续 ' + task.daysPending + ' 天' + (task.status === 'closed' ? ' · 已归档' : '');
  $('detailCounts').innerHTML = statusCountChips(task.counts);
  $('btnDetailArchive').textContent = task.status === 'closed' ? '恢复任务' : '归档任务';
  const filterSelect = $('detailStatusFilter');
  filterSelect.innerHTML = '<option value="">全部状态</option>' + STATUS_ORDER.map((s) => '<option value="' + s + '">' + STATUS_LABEL[s] + '</option>').join('');
  filterSelect.value = state.detail.statusFilter;
  $('detailSelCount').textContent = '已选 ' + state.detail.selected.size + ' 人';
  $('detailActions').innerHTML =
    '<span class="label">勾选学生后可批量修改状态</span>' +
    STATUS_ORDER.map((s) => '<button type="button" class="btn status-btn s-' + s + '" data-action="d-apply" data-status="' + s + '">标记为' + STATUS_LABEL[s] + '</button>').join('') +
    '<button type="button" class="btn wide plain" data-action="d-return">退回订正（自动判断：首次=待订正，再次退回=待交回）</button>' +
    '<button type="button" class="btn wide plain" data-action="d-pass-all">全部未完成 → 已完成（需确认）</button>' +
    '<button type="button" class="btn wide danger" data-action="delete-task">删除这个任务及其历史</button>';

  const list = task.assignments.filter((a) => !state.detail.statusFilter || a.status === state.detail.statusFilter);
  if (!list.length) {
    $('detailList').innerHTML = '<div class="empty">没有符合条件的学生记录。</div>';
  } else {
    $('detailList').innerHTML = list.map((a) => {
      const checked = state.detail.selected.has(a.studentId) ? ' checked' : '';
      return '<div class="detail-row s-' + a.status + '">' +
        '<label class="who"><input type="checkbox" data-action="d-check" data-student="' + a.studentId + '"' + checked + ' />' +
        esc(noText(a.studentNo)) + (a.name ? '<small>' + esc(a.name) + '</small>' : '<small>&nbsp;</small>') + '</label>' +
        '<div class="ops"><span class="badge">' + STATUS_LABEL[a.status] + '</span>' +
        '<span class="muted">更新 ' + fmtDateTime(a.updatedAt) + (a.status === 'done' ? '' : ' · 已 ' + a.pendingDays + ' 天') + '</span>' +
        '<button type="button" class="btn small status-btn s-done" data-action="d-one" data-assignment="' + a.assignmentId + '" data-status="done" data-label="检查通过">检查通过</button>' +
        '<button type="button" class="btn small" data-action="d-one" data-assignment="' + a.assignmentId + '" data-status="to_grade" data-label="已交回，待批改">已交回</button>' +
        '<button type="button" class="btn small" data-action="d-one-return" data-task="' + task.id + '" data-student="' + a.studentId + '" data-label="退回订正">退回订正</button>' +
        '<button type="button" class="btn small" data-action="d-one" data-assignment="' + a.assignmentId + '" data-status="not_received" data-label="未收到">未收到</button>' +
        '<button type="button" class="btn small ghost" data-action="d-student-history" data-task="' + task.id + '" data-student="' + a.studentId + '">该生历史</button>' +
        '</div></div>';
    }).join('');
  }

  if (state.detail.showHistory) {
    $('detailHistory').hidden = false;
    $('detailHistory').innerHTML = '<h2>状态变化历史</h2><div id="detailHistoryList"><p class="hint">加载中…</p></div>';
    loadTaskHistory(task.id);
  } else {
    $('detailHistory').hidden = true;
    $('detailHistory').innerHTML = '';
  }
}

async function loadTaskHistory(taskId) {
  try {
    const res = await api('/api/tasks/' + taskId + '/history?limit=300');
    const items = res.history || [];
    const target = $('detailHistoryList');
    if (!target) return;
    target.innerHTML = items.length ? items.map((h) =>
      '<div class="hist-item"><b>' + esc(noText(h.studentNo)) + '号</b>' +
      '<span>' + (h.fromStatus ? STATUS_LABEL[h.fromStatus] : '创建') + ' → <b>' + STATUS_LABEL[h.toStatus] + '</b></span>' +
      (h.note ? '<span class="muted">' + esc(h.note) + '</span>' : '') +
      '<span class="time">' + fmtDateTime(h.changedAt) + '</span></div>'
    ).join('') : '<p class="hint">暂无历史记录。</p>';
  } catch (err) {
    showToast('历史记录加载失败：' + err.message);
  }
}

function renderRoster() {
  const listEl = $('rosterList');
  if (document.activeElement && listEl.contains(document.activeElement)) return;
  const rows = (state.allStudents.length ? state.allStudents : state.students).map((s) =>
    '<div class="roster-item' + (s.active ? '' : ' inactive') + '">' +
    '<span class="no">' + esc(s.studentNo) + '</span>' +
    '<input type="text" data-action="student-name" data-student="' + s.id + '" value="' + esc(s.name || '') + '" placeholder="姓名" />' +
    '<button type="button" class="btn small ghost" data-action="toggle-student" data-student="' + s.id + '" data-next="' + (s.active ? '0' : '1') + '">' + (s.active ? '停用' : '启用') + '</button>' +
    '</div>'
  ).join('');
  listEl.innerHTML = rows || '<p class="hint">名单为空，请设置班级人数后生成学号。</p>';
  $('classSize').value = state.settings.classSize;
}

function openStudentSheet(taskId, assignmentId) {
  const task = findTask(taskId);
  if (!task) return;
  const a = task.assignments.filter((x) => x.assignmentId === Number(assignmentId))[0];
  if (!a) return;
  $('sheetTitle').textContent = task.title + ' · ' + noText(a.studentNo) + ' 号';
  $('sheetBody').innerHTML =
    '<p class="sheet-meta">当前状态：<b>' + STATUS_LABEL[a.status] + '</b>（' + STATUS_HINT[a.status] + '）<br />最后更新：' + fmtDateTime(a.updatedAt) + (a.status === 'done' ? '' : ' · 已 ' + a.pendingDays + ' 天') + '</p>' +
    STATUS_ORDER.map((s) =>
      '<button type="button" class="btn status-btn s-' + s + '" data-action="sheet-status" data-task="' + task.id + '" data-assignment="' + a.assignmentId + '" data-status="' + s + '">标记为' + STATUS_LABEL[s] + '</button>'
    ).join('') +
    '<button type="button" class="btn plain" data-action="sheet-return" data-task="' + task.id + '" data-student="' + a.studentId + '">退回订正（首次=待订正，再次退回=待交回）</button>' +
    '<button type="button" class="btn plain" data-action="sheet-history" data-student="' + a.studentId + '" data-task="' + task.id + '">查看该生全部历史</button>' +
    '<p class="tiny">只有点“标记为已完成”才会关闭这条记录；改错了可以点提示条上的“撤销”。</p>';
  openOverlay();
}

async function sheetHistory(studentId, taskId) {
  try {
    const res = await api('/api/students/' + studentId + '/history?taskId=' + taskId + '&limit=100');
    const items = res.history || [];
    const html = items.map((h) => '<div class="hist-item"><span>' + (h.fromStatus ? STATUS_LABEL[h.fromStatus] : '创建') + ' → <b>' + STATUS_LABEL[h.toStatus] + '</b></span><span class="time">' + fmtDateTime(h.changedAt) + '</span></div>').join('');
    $('sheetBody').innerHTML = '<p class="sheet-meta">该生在这个任务上的变化记录：</p>' + (html || '<p class="hint">暂无记录。</p>') +
      '<button type="button" class="btn" data-action="sheet-back" data-task="' + taskId + '" data-assignment="0">返回状态操作</button>';
  } catch (err) {
    showToast('历史加载失败：' + err.message);
  }
}

function handleAction(action, el) {
  const taskId = Number(el.getAttribute('data-task') || 0);
  const studentId = Number(el.getAttribute('data-student') || 0);
  const assignmentId = Number(el.getAttribute('data-assignment') || 0);

  if (action === 'init-status') { state.form.initStatus = el.getAttribute('data-value'); renderForm(); return; }
  if (action === 'open-mark') { state.mark.taskId = Number(el.getAttribute('data-task')); state.mark.selected = new Set(); switchView('register'); window.scrollTo(0, 0); return; }
  if (action === 'mark-chip') {
    const task = findTask(taskId);
    if (!task) return;
    if (state.mark.stampMode) {
      applyBulk(taskId, { scope: 'selected', studentIds: [studentId], status: state.mark.stamp }, '印章标记为' + STATUS_LABEL[state.mark.stamp]);
      return;
    }
    if (state.mark.selected.has(studentId)) state.mark.selected.delete(studentId); else state.mark.selected.add(studentId);
    renderMarkPanel();
    return;
  }
  if (action === 'mark-apply') {
    const status = el.getAttribute('data-status');
    const studentIds = Array.from(state.mark.selected);
    if (!studentIds.length) { showToast('请先点选学生学号（可多选）'); return; }
    state.mark.stamp = status;
    applyBulk(taskId, { scope: 'selected', studentIds: studentIds, status: status }, '标记为' + STATUS_LABEL[status] + '（' + studentIds.length + ' 人）');
    return;
  }
  if (action === 'mark-rest') {
    applyBulk(taskId, { scope: 'to_grade', status: 'to_correct' }, '其余未批改 → 待订正');
    return;
  }
  if (action === 'mark-all') {
    applyBulk(taskId, { scope: 'pending', status: 'to_grade' }, '全班未完成 → 待批改');
    return;
  }
  if (action === 'detail') { openDetail(taskId); window.scrollTo(0, 0); return; }
  if (action === 'archive') {
    const next = el.getAttribute('data-next');
    api('/api/tasks/' + taskId, 'PATCH', { status: next })
      .then(() => refresh().then(() => showToast(next === 'closed' ? '任务已归档（学生状态不变，仍可在“显示已归档”里查看）' : '任务已恢复')))
      .catch((err) => showToast('操作失败：' + err.message));
    return;
  }
  if (action === 'delete-task') {
    const targetTask = findTask(taskId);
    if (!confirm('确认删除任务「' + (targetTask ? targetTask.title : '') + '」及其全部学生状态与历史？')) return;
    if (!confirm('再次确认：删除后这个任务的状态和历史都无法找回。')) return;
    api('/api/tasks/' + taskId, 'DELETE').then(() => refresh().then(() => { switchView('board'); showToast('任务已删除'); })).catch((err) => showToast('删除失败：' + err.message));
    return;
  }
  if (action === 'quick') {
    const task = findTask(taskId);
    openStudentSheet(taskId, assignmentId);
    return;
  }
  if (action === 'sheet-status') {
    applyOne(assignmentId, el.getAttribute('data-status'), '标记为' + STATUS_LABEL[el.getAttribute('data-status')]).then(() => closeOverlay());
    return;
  }
  if (action === 'sheet-return') {
    applyBulk(taskId, { scope: 'selected', studentIds: [studentId], action: 'return' }, '退回订正').then(() => closeOverlay());
    return;
  }
  if (action === 'sheet-history') { sheetHistory(studentId, taskId); return; }
  if (action === 'sheet-back') {
    const task = findTask(taskId);
    const current = task ? task.assignments.filter((x) => x.studentId === studentId)[0] : null;
    if (current) openStudentSheet(taskId, current.assignmentId);
    return;
  }
  if (action === 'd-check') {
    if (el.checked) state.detail.selected.add(studentId); else state.detail.selected.delete(studentId);
    $('detailSelCount').textContent = '已选 ' + state.detail.selected.size + ' 人';
    return;
  }
  if (action === 'd-apply') {
    const status = el.getAttribute('data-status');
    const studentIds = Array.from(state.detail.selected);
    if (!studentIds.length) { showToast('请先勾选学生'); return; }
    applyBulk(state.detail.taskId, { scope: 'selected', studentIds: studentIds, status: status }, '标记为' + STATUS_LABEL[status] + '（' + studentIds.length + ' 人）');
    return;
  }
  if (action === 'd-return') {
    const studentIds = Array.from(state.detail.selected);
    if (!studentIds.length) { showToast('请先勾选学生'); return; }
    applyBulk(state.detail.taskId, { scope: 'selected', studentIds: studentIds, action: 'return' }, '退回订正（' + studentIds.length + ' 人）');
    return;
  }
  if (action === 'd-pass-all') {
    if (!confirm('确认把该任务里全部未完成的学生标记为“已完成”？请确认作业都已通过。')) return;
    applyBulk(state.detail.taskId, { scope: 'pending', status: 'done' }, '全部未完成 → 已完成');
    return;
  }
  if (action === 'd-one') {
    applyOne(assignmentId, el.getAttribute('data-status'), el.getAttribute('data-label') || '更新状态');
    return;
  }
  if (action === 'd-one-return') {
    applyBulk(taskId, { scope: 'selected', studentIds: [studentId], action: 'return' }, '退回订正');
    return;
  }
  if (action === 'd-student-history') { sheetHistory(studentId, taskId); return; }
  if (action === 'toggle-student') {
    const next = el.getAttribute('data-next') === '1';
    api('/api/students/' + studentId, 'PATCH', { active: next })
      .then(() => refresh().then(() => showToast(next ? '已启用该学生' : '已停用该学生（历史记录保留）')))
      .catch((err) => showToast('操作失败：' + err.message));
    return;
  }
}

const idHandlers = {
  btnCloudConnect: () => connectCloud(),
  btnCloudLocal: () => useLocalServer(),
  btnExportData: () => exportBackup(),
  btnDownloadCloudConfig: () => downloadCloudConfig(),
  btnCreateTask: () => createTask(),
  btnMarkClose: () => { state.mark.taskId = null; renderAll(); },
  btnSelectAll: () => {
    const task = findTask(state.mark.taskId);
    if (!task) return;
    state.mark.selected = new Set(task.assignments.map((a) => a.studentId));
    renderMarkPanel();
  },
  btnClearSel: () => { state.mark.selected = new Set(); renderMarkPanel(); },
  btnRefresh: () => refresh().then(() => showToast('已刷新')),
  btnDetailBack: () => switchView('board'),
  btnDetailArchive: () => {
    const task = findTask(state.detail.taskId);
    if (!task) return;
    const next = task.status === 'closed' ? 'open' : 'closed';
    api('/api/tasks/' + task.id, 'PATCH', { status: next })
      .then(() => refresh().then(() => showToast(next === 'closed' ? '任务已归档' : '任务已恢复')))
      .catch((err) => showToast('操作失败：' + err.message));
  },
  btnDetailHistory: () => { state.detail.showHistory = !state.detail.showHistory; renderDetail(); },
  btnDetailSelectAll: () => {
    const task = findTask(state.detail.taskId);
    if (!task) return;
    state.detail.selected = new Set(task.assignments.filter((a) => a.status !== 'done').map((a) => a.studentId));
    renderDetail();
  },
  btnDetailClear: () => { state.detail.selected = new Set(); renderDetail(); },
  btnSaveClassSize: () => {
    const size = Number($('classSize').value);
    if (!Number.isFinite(size) || size < 1 || size > 120) { showToast('班级人数需在 1 - 120 之间'); return; }
    api('/api/settings/class-size', 'POST', { classSize: Math.round(size) })
      .then((res) => refresh().then(() => showToast('已保存班级人数 ' + res.settings.classSize + ' 人，新增学号：' + ((res.created || []).join('、') || '无'))))
      .catch((err) => showToast('保存失败：' + err.message));
  },
  btnAddStudent: () => {
    const studentNo = $('newStudentNo').value.trim();
    const name = $('newStudentName').value.trim();
    if (!studentNo) { showToast('请填写学号'); return; }
    api('/api/students', 'POST', { studentNo: studentNo, name: name })
      .then(() => { $('newStudentNo').value = ''; $('newStudentName').value = ''; return refresh().then(() => showToast('已新增学生 ' + studentNo)); })
      .catch((err) => showToast('新增失败：' + err.message));
  },
  btnResetData: () => {
    if (!confirm('确认清空所有任务、学生状态和历史记录？（班级名单会保留）')) return;
    if (!confirm('再次确认：此操作不可恢复。')) return;
    api('/api/admin/reset', 'POST', { confirm: 'RESET', keepStudents: true })
      .then(() => refresh().then(() => { state.mark.taskId = null; state.detail.taskId = null; switchView('board'); showToast('已清空所有任务与历史'); }))
      .catch((err) => showToast('清空失败：' + err.message));
  },
  sheetClose: () => closeOverlay(),
};

document.addEventListener('click', (event) => {
  const actionEl = event.target.closest('[data-action]');
  if (actionEl && actionEl.getAttribute('data-action') !== 'student-name') {
    event.preventDefault();
    handleAction(actionEl.getAttribute('data-action'), actionEl);
    return;
  }
  const tabEl = event.target.closest('.tab');
  if (tabEl) { switchView(tabEl.getAttribute('data-view')); return; }
  const buttonEl = event.target.closest('button');
  if (buttonEl && idHandlers[buttonEl.id]) { idHandlers[buttonEl.id](); return; }
  if (event.target.id === 'overlay') closeOverlay();
});

document.addEventListener('change', (event) => {
  const el = event.target;
  if (el.id === 'stampMode') { state.mark.stampMode = el.checked; renderMarkPanel(); return; }
  if (el.id === 'filterBook' || el.id === 'filterLesson' || el.id === 'filterStatus') {
    const key = el.id.replace('filter', '').toLowerCase();
    state.filters[key] = el.value;
    renderBoard();
    return;
  }
  if (el.id === 'showDone') { state.filters.includeDone = el.checked; renderBoard(); return; }
  if (el.id === 'showArchived') { state.filters.includeArchived = el.checked; renderBoard(); return; }
  if (el.id === 'detailStatusFilter') { state.detail.statusFilter = el.value; renderDetail(); return; }
  if (el.getAttribute('data-action') === 'student-name') {
    const studentId = Number(el.getAttribute('data-student'));
    api('/api/students/' + studentId, 'PATCH', { name: el.value.trim() })
      .then(() => refresh({ skipRoster: true }).then(() => showToast('姓名已保存')))
      .catch((err) => showToast('保存失败：' + err.message));
  }
});

document.addEventListener('input', (event) => {
  const el = event.target;
  if (el.id === 'bookInput' || el.id === 'lessonInput' || el.id === 'contentInput') {
    $('titlePreview').textContent = composeTitle();
  }
});

let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh({ silent: true }), 150);
}

function startSync() {
  if (backend) {
    setSync('连接云开发…');
    if (typeof backend.subscribe === 'function') {
      backend.subscribe({
        onReady: (text) => setSync((text || '云开发实时同步已连接') + ' ' + fmtClock(), 'ok'),
        onChange: () => { setSync('已同步 ' + fmtClock(), 'ok'); scheduleRefresh(); },
        onWarn: (text) => setSync(text, 'warn'),
      });
    }
    window.addEventListener('focus', () => refresh({ silent: true }));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh({ silent: true }); });
    return;
  }
  setSync('连接中…');
  try {
    const source = new EventSource('/api/events');
    source.addEventListener('ready', () => setSync('实时同步已连接 ' + fmtClock(), 'ok'));
    source.addEventListener('change', () => { setSync('已同步 ' + fmtClock(), 'ok'); scheduleRefresh(); });
    source.onopen = () => setSync('实时同步已连接 ' + fmtClock(), 'ok');
    source.onerror = () => setSync('连接中断，自动重试中…', 'warn');
  } catch (err) {
    setSync('实时同步不可用，改用定时刷新', 'warn');
  }
  setInterval(() => { if (!document.hidden) refresh({ silent: true }); }, 15000);
  window.addEventListener('focus', () => refresh({ silent: true }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh({ silent: true }); });
}

function isLocalPage() {
  const host = String(location.hostname || '');
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (/^192\.168\./.test(host) || /^10\./.test(host) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return true;
  return false;
}

function dataSourceName() {
  if (backend) return '腾讯云开发数据库（静态托管）';
  if (isLocalPage()) return '本机 / 局域网服务器（SQLite）';
  return '未配置数据源（静态网页需要填写云开发环境 ID）';
}

function dataLocationText() {
  if (backend) return '数据保存在腾讯云开发数据库里，手机和电脑读取同一份数据。';
  return '数据保存在服务器的 SQLite 文件里（data/tracker.db），手机和电脑读取同一份数据。';
}

function connectionFailText() {
  if (backend) return '读取云开发数据失败：';
  if (!isLocalPage()) return '这个静态网页还没有配置数据源，请到「名单 / 设置」填写云开发环境 ID。错误信息：';
  return '无法连接服务器：';
}

function renderCloudCard() {
  const envInput = $('cloudEnv');
  const stateEl = $('cloudState');
  if (!envInput || !stateEl) return;
  const info = window.HomeworkCloud || {};
  if (backend) {
    const sourceText = info.configSource === 'local' ? '（本机填写的设置）' : (info.configSource === 'file' ? '（来自网站上的 cloudbase-config.js）' : (info.configSource === 'url' ? '（来自网址参数）' : ''));
    stateEl.innerHTML = '当前数据源：<b>' + esc(backend.label || '云开发数据库') + '</b>（环境 ' + esc(info.env || '') + '）' + esc(sourceText) +
      (info.message ? '。' + esc(info.message) : '');
    envInput.value = info.env || '';
    return;
  }
  if (backendError) {
    stateEl.innerHTML = '当前数据源：<b>未连接</b>。' + esc(backendError.message || String(backendError));
    envInput.value = info.env || '';
    return;
  }
  stateEl.innerHTML = '当前数据源：<b>' + esc(dataSourceName()) + '</b>' + (info.message ? '。' + esc(info.message) : '');
  envInput.value = '';
}

async function resolveBackend() {
  if (!window.HomeworkBackendReady) {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      if (document.readyState === 'complete') { finish(); return; }
      window.addEventListener('load', finish, { once: true });
      setTimeout(finish, 3000);
    });
  }
  if (!window.HomeworkBackendReady) return;
  try {
    backend = (await window.HomeworkBackendReady) || null;
  } catch (err) {
    backend = null;
    backendError = err;
  }
}

function connectCloud() {
  const env = String($('cloudEnv').value || '').trim();
  if (!env) { showToast('请先填写云开发环境 ID（在云开发平台 → 环境总览里复制）'); return; }
  if (!window.HomeworkCloud || typeof window.HomeworkCloud.save !== 'function') { showToast('页面还在加载，请等一秒再点'); return; }
  window.HomeworkCloud.save(env, 'ap-shanghai');
  showToast('已保存环境 ID，正在重新加载…');
  setTimeout(() => location.reload(), 600);
}

function useLocalServer() {
  if (!window.HomeworkCloud || typeof window.HomeworkCloud.clear !== 'function') return;
  const info = window.HomeworkCloud || {};
  const fileHint = info.fileEnv ? '注意：这个网站里放了 cloudbase-config.js（环境 ' + info.fileEnv + '），清掉本机设置后它仍然会连接云开发。' : '';
  if (backend && !confirm('改回本机服务器后，这个网页会去连接本机地址；云端数据不会被删除。' + fileHint + '继续？')) return;
  window.HomeworkCloud.clear();
  showToast('已改回本机服务器模式，正在重新加载…');
  setTimeout(() => location.reload(), 600);
}

function downloadTextFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function exportBackup() {
  try {
    if (!backend || typeof backend.exportAll !== 'function') {
      showToast('当前是本机服务器模式，备份直接复制服务器的 data/tracker.db 即可');
      return;
    }
    const data = await backend.exportAll();
    downloadTextFile('作业追踪备份-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(data, null, 2), 'application/json');
    showToast('备份已下载（' + (data.tasks || []).length + ' 个任务，' + (data.students || []).length + ' 名学生）');
  } catch (err) {
    showToast('备份失败：' + (err && err.message ? err.message : String(err)));
  }
}

function downloadCloudConfig() {
  const info = window.HomeworkCloud || {};
  if (!info.env) { showToast('还没有填写云开发环境 ID'); return; }
  if (typeof info.configFileText !== 'function') { showToast('页面还在加载，请等一秒再点'); return; }
  downloadTextFile('cloudbase-config.js', info.configFileText(info.env, info.region), 'text/javascript');
  showToast('已下载 cloudbase-config.js：上传到网站根目录后，手机打开网页就不用再填环境 ID 了');
}

async function init() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  $('taskDate').value = now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate());
  state.view = 'register';
  renderAll();
  renderForm();
  await resolveBackend();
  renderCloudCard();
  startSync();
  if (backendError) {
    setSync('云开发未连接', 'warn');
    showToast('云开发连接失败：' + (backendError.message || String(backendError)));
    return;
  }
  refresh({ silent: true });
}

init();