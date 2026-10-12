'use strict';

/*
 * 静态托管版（云开发数据库）业务规则测试。
 *
 * 真的云开发环境需要老师在控制台配置，自动化测试没法连；
 * 所以这里用同一个 store-core.mjs + 一个「内存版 driver」来跑：
 *   - 业务规则（规则1~规则6）与云端完全共用同一份代码
 *   - driver 只是把数据放到内存里，接口签名和云开发驱动一致
 * 另外用「两个 store 实例共用同一个 driver」来模拟手机和电脑两台设备。
 */

const path = require('node:path');

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

function createMemoryDriver() {
  const tables = new Map();
  let autoId = 0;
  function table(name) {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  }
  function clone(value) {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
  }
  return {
    tables: tables,
    async list(collection) {
      return Array.from(table(collection).values()).map(clone);
    },
    async listWhere(collection, query) {
      const keys = Object.keys(query || {});
      return Array.from(table(collection).values())
        .filter((doc) => keys.every((k) => doc[k] === query[k]))
        .map(clone);
    },
    async get(collection, id) {
      const doc = table(collection).get(id);
      return doc ? clone(doc) : null;
    },
    async put(collection, id, doc) {
      const next = clone(doc);
      next._id = id;
      table(collection).set(id, next);
    },
    async insert(collection, doc) {
      autoId += 1;
      const id = 'auto-' + autoId;
      const next = clone(doc);
      next._id = id;
      table(collection).set(id, next);
      return id;
    },
    async patch(collection, id, partial) {
      const doc = table(collection).get(id);
      if (!doc) throw new Error('document not found: ' + id);
      Object.assign(doc, clone(partial));
    },
    async remove(collection, id) {
      table(collection).delete(id);
    },
    async removeWhere(collection, query) {
      const keys = Object.keys(query || {});
      const drop = Array.from(table(collection).values())
        .filter((doc) => keys.every((k) => doc[k] === query[k]))
        .map((doc) => doc._id);
      drop.forEach((id) => table(collection).delete(id));
    },
    async clear(collection) {
      table(collection).clear();
    },
  };
}

function dateStringOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function studentIdOf(bootstrap, studentNo) {
  const found = (bootstrap.allStudents || bootstrap.students || []).filter((s) => s.studentNo === studentNo)[0];
  if (!found) throw new Error('找不到学号 ' + studentNo);
  return found.id;
}

function assignmentOf(task, studentNo) {
  return (task.assignments || []).filter((a) => a.studentNo === studentNo)[0] || null;
}

function statusOf(task, studentNo) {
  const found = assignmentOf(task, studentNo);
  return found ? found.status : null;
}

(async function run() {
  const { createStore } = require(path.join(__dirname, '..', 'public', 'store-core.js'));
  const driver = createMemoryDriver();
  // 两个 store 实例共用一份数据 = 手机和电脑两台设备
  let phone = createStore(driver, { mode: 'test-phone' });
  let desktop = createStore(driver, { mode: 'test-desktop' });

  const req = (store, path, method, body) => store.request(path, method, body);

  try {
    scenario('场景1 首次打开自动生成 38 个学号（虚拟数据）');
    const boot1 = await req(phone, '/api/bootstrap');
    check('自动生成 38 名学生', boot1.students.length === 38, 'students=' + boot1.students.length);
    check('默认班级人数 38', boot1.settings.classSize === 38, 'classSize=' + boot1.settings.classSize);
    check('学号从 01 开始补齐两位', boot1.students[0].studentNo === '01' && boot1.students[37].studentNo === '38', boot1.students[0].studentNo + '..' + boot1.students[37].studentNo);
    check('第一次打开没有任何任务', boot1.tasks.length === 0, 'tasks=' + boot1.tasks.length);

    scenario('场景2 创建任务：标题自动组合 + 全班生成学号记录');
    const created = await req(phone, '/api/tasks', 'POST', { book: 'A册', lesson: '第3课', content: '抄写', initialStatus: 'to_grade' });
    const taskA3 = created.task;
    check('标题自动组合为 A册·第3课·抄写作业', taskA3.title === 'A册·第3课·抄写作业', taskA3.title);
    check('创建日期默认今天', taskA3.taskDate === dateStringOffset(0), taskA3.taskDate);
    check('全班 38 人都有记录', taskA3.counts.total === 38, 'total=' + taskA3.counts.total);
    check('初始状态是待批改', taskA3.counts.to_grade === 38, JSON.stringify(taskA3.counts));
    check('待办人数 38', taskA3.pendingCount === 38, 'pending=' + taskA3.pendingCount);

    scenario('场景3 第一次批改：全对的学生被排除在待办之外');
    const allPairs = ['01', '02', '05', '09'];
    await req(phone, '/api/tasks/' + taskA3.id + '/bulk', 'POST', {
      scope: 'selected',
      studentIds: allPairs.map((no) => studentIdOf(boot1, no)),
      status: 'done',
    });
    let view = (await req(phone, '/api/tasks/' + taskA3.id)).task;
    check('全对的学生状态为已完成', allPairs.every((no) => statusOf(view, no) === 'done'), JSON.stringify(view.counts));
    check('全对学生不在待办名单里', allPairs.every((no) => !view.pending.some((a) => a.studentNo === no)));
    check('待办人数从 38 减到 34', view.pendingCount === 34, 'pending=' + view.pendingCount);
    check('已完成计数为 4', view.counts.done === 4, 'done=' + view.counts.done);

    scenario('场景4 未收到作业的学生单独追踪（规则3：未收到 ≠ 待交回）');
    await req(phone, '/api/tasks/' + taskA3.id + '/bulk', 'POST', {
      scope: 'selected',
      studentIds: [studentIdOf(boot1, '07')],
      status: 'not_received',
    });
    view = (await req(phone, '/api/tasks/' + taskA3.id)).task;
    check('07 号状态为未收到', statusOf(view, '07') === 'not_received', statusOf(view, '07'));
    check('未收到仍然算未完成', view.pending.some((a) => a.studentNo === '07' && a.status === 'not_received'));

    scenario('场景5 反复订正、反复退回，记录始终不会丢（规则2）');
    const sid03 = studentIdOf(boot1, '03');
    const aid03 = assignmentOf(view, '03').assignmentId;
    await req(phone, '/api/tasks/' + taskA3.id + '/bulk', 'POST', { scope: 'selected', studentIds: [sid03], status: 'to_correct' });
    let status03 = statusOf((await req(phone, '/api/tasks/' + taskA3.id)).task, '03');
    check('第一次批改不通过 → 待订正', status03 === 'to_correct', status03);
    await req(phone, '/api/assignments/' + aid03, 'PATCH', { status: 'to_grade' });
    status03 = statusOf((await req(phone, '/api/tasks/' + taskA3.id)).task, '03');
    check('学生交回 → 待批改', status03 === 'to_grade', status03);
    await req(phone, '/api/tasks/' + taskA3.id + '/bulk', 'POST', { scope: 'selected', studentIds: [sid03], action: 'return' });
    status03 = statusOf((await req(phone, '/api/tasks/' + taskA3.id)).task, '03');
    check('再次退回 → 待交回（而不是回到待订正）', status03 === 'to_return', status03);
    view = (await req(phone, '/api/tasks/' + taskA3.id)).task;
    check('待交回仍然算未完成', view.pending.some((a) => a.studentNo === '03' && a.status === 'to_return'));

    scenario('场景6 学生跨天没交，第二天仍显示原课次任务（规则6）');
    const oldTask = (await req(phone, '/api/tasks', 'POST', {
      book: 'B册',
      lesson: '第1课',
      content: '练习',
      taskDate: dateStringOffset(-3),
      initialStatus: 'not_received',
    })).task;
    check('旧任务创建日期为 3 天前', oldTask.taskDate === dateStringOffset(-3), oldTask.taskDate);
    check('显示已持续未完成 3 天', oldTask.daysPending === 3, 'daysPending=' + oldTask.daysPending);
    check('学生个人的持续天数按“各自状态最后变化时间”算，刚建任务是 0 天', oldTask.pending[0].pendingDays === 0, 'pendingDays=' + oldTask.pending[0].pendingDays);
    check('任务整体仍然显示 3 天，会一直挂在待办上', (await req(phone, '/api/tasks')).tasks.filter((t) => t.id === oldTask.id)[0].daysPending === 3);
    await req(phone, '/api/tasks/' + oldTask.id + '/bulk', 'POST', { scope: 'all', status: 'to_grade' });
    check('学生交回来以后可以改成待批改（规则3）', statusOf((await req(phone, '/api/tasks/' + oldTask.id)).task, '01') === 'to_grade');

    scenario('场景7 新课次开始后，旧课次遗留任务依然存在（规则4）');
    const newTask = (await req(phone, '/api/tasks', 'POST', { book: 'A册', lesson: '第4课', content: '抄写', initialStatus: 'to_grade' })).task;
    const boardAfterNew = await req(desktop, '/api/bootstrap');
    check('新课次任务已出现在待办里', boardAfterNew.tasks.some((t) => t.id === newTask.id));
    check('第3课任务没有被覆盖或删除', boardAfterNew.tasks.some((t) => t.id === taskA3.id));
    check('第3课的待交回学生仍在待办里', boardAfterNew.tasks.filter((t) => t.id === taskA3.id)[0].pending.some((a) => a.studentNo === '03' && a.status === 'to_return'));
    check('旧课次的 B册第1课任务也在', boardAfterNew.tasks.some((t) => t.id === oldTask.id));
    check('新课次开始不会自动完成旧任务', boardAfterNew.tasks.filter((t) => t.id === taskA3.id)[0].counts.done === 4, 'done=' + boardAfterNew.tasks.filter((t) => t.id === taskA3.id)[0].counts.done);

    scenario('场景8 交回后状态可以从「未收到 / 待交回」改成「待批改」');
    const sid07 = studentIdOf(boot1, '07');
    await req(phone, '/api/tasks/' + taskA3.id + '/bulk', 'POST', { scope: 'selected', studentIds: [sid07], status: 'to_grade' });
    check('未收到 → 待批改', statusOf((await req(phone, '/api/tasks/' + taskA3.id)).task, '07') === 'to_grade');
    const sid12 = studentIdOf(boot1, '12');
    await req(phone, '/api/tasks/' + taskA3.id + '/bulk', 'POST', { scope: 'selected', studentIds: [sid12], status: 'to_return' });
    await req(phone, '/api/tasks/' + taskA3.id + '/bulk', 'POST', { scope: 'selected', studentIds: [sid12], status: 'to_grade' });
    check('待交回 → 待批改', statusOf((await req(phone, '/api/tasks/' + taskA3.id)).task, '12') === 'to_grade');

    scenario('场景9 只有老师确认通过才算完成（规则4）');
    const sid18 = studentIdOf(boot1, '18');
    await req(phone, '/api/tasks/' + taskA3.id + '/bulk', 'POST', { scope: 'selected', studentIds: [sid18], status: 'to_grade' });
    view = (await req(phone, '/api/tasks/' + taskA3.id)).task;
    check('待批改不等于已完成', statusOf(view, '18') !== 'done', statusOf(view, '18'));
    await req(phone, '/api/tasks/' + taskA3.id + '/bulk', 'POST', { scope: 'selected', studentIds: [sid18], status: 'done' });
    check('老师确认后才是已完成', statusOf((await req(phone, '/api/tasks/' + taskA3.id)).task, '18') === 'done');

    scenario('场景10 手机修改后，电脑端看到最新状态（同步）');
    const sid21 = studentIdOf(boot1, '21');
    await req(phone, '/api/tasks/' + taskA3.id + '/bulk', 'POST', { scope: 'selected', studentIds: [sid21], status: 'to_correct' });
    const desktopView = (await req(desktop, '/api/bootstrap')).tasks.filter((t) => t.id === taskA3.id)[0];
    check('电脑端读到手机刚改的状态', statusOf(desktopView, '21') === 'to_correct', statusOf(desktopView, '21'));
    const sid99 = studentIdOf(boot1, '22');
    await req(desktop, '/api/assignments/' + assignmentOf(desktopView, '22').assignmentId, 'PATCH', { status: 'done' });
    check('电脑端改完，手机端也能看到', statusOf((await req(phone, '/api/tasks/' + taskA3.id)).task, '22') === 'done');

    scenario('场景11 关闭网页再打开（重新创建 store）后数据仍然保留');
    const snapshot = (await req(phone, '/api/tasks/' + taskA3.id)).task;
    phone = createStore(driver, { mode: 'test-phone-reopened' });
    const bootAfterReopen = await req(phone, '/api/bootstrap');
    const taskAfterReopen = bootAfterReopen.tasks.filter((t) => t.id === taskA3.id)[0];
    check('重新打开后学生名单仍是 38 人', bootAfterReopen.students.length === 38);
    check('重新打开后任务依然存在', !!taskAfterReopen);
    check('重新打开后状态完全一致', JSON.stringify(taskAfterReopen.counts) === JSON.stringify(snapshot.counts), JSON.stringify(taskAfterReopen.counts));
    check('重新打开后历史记录仍在', (await req(phone, '/api/tasks/' + taskA3.id + '/history?limit=500')).history.length >= 38);

    scenario('场景12 批量操作不会误改其他课次的任务');
    const beforeNew = (await req(phone, '/api/tasks/' + newTask.id)).task;
    const beforeOld = (await req(phone, '/api/tasks/' + oldTask.id)).task;
    const beforeBulk = (await req(phone, '/api/tasks/' + taskA3.id)).task;
    const bulkResult = await req(phone, '/api/tasks/' + taskA3.id + '/bulk', 'POST', { scope: 'pending', status: 'done' });
    check('批量更新条数 = 该任务当时的未完成人数', bulkResult.updated.length === beforeBulk.pendingCount, bulkResult.updated.length + ' vs ' + beforeBulk.pendingCount);
    const afterNew = (await req(phone, '/api/tasks/' + newTask.id)).task;
    const afterOld = (await req(phone, '/api/tasks/' + oldTask.id)).task;
    check('A册第4课的统计没有变化', JSON.stringify(afterNew.counts) === JSON.stringify(beforeNew.counts), JSON.stringify(afterNew.counts));
    check('B册第1课的统计没有变化', JSON.stringify(afterOld.counts) === JSON.stringify(beforeOld.counts), JSON.stringify(afterOld.counts));
    const afterBulk = (await req(phone, '/api/tasks/' + taskA3.id)).task;
    check('A册第3课全部变成已完成', afterBulk.pendingCount === 0 && afterBulk.counts.done === 38, JSON.stringify(afterBulk.counts));
    check('完成的任务默认不出现在待办看板', !(await req(phone, '/api/tasks')).tasks.some((t) => t.id === taskA3.id));
    check('勾选“显示已完成”后可以查到', (await req(phone, '/api/tasks?includeDone=1')).tasks.some((t) => t.id === taskA3.id));

    scenario('场景13 历史记录完整、可撤销（规则5）');
    const history = (await req(phone, '/api/tasks/' + taskA3.id + '/history?limit=1000')).history;
    check('历史包含创建记录（38 名学生各一条）', history.filter((h) => h.source === 'create').length === 38, 'create rows=' + history.filter((h) => h.source === 'create').length);
    const chain03 = history.filter((h) => h.studentNo === '03').sort((a, b) => (a.changedAt < b.changedAt ? -1 : 1));
    check('03 号的往来记录被完整保留', chain03.some((h) => h.toStatus === 'to_correct') && chain03.some((h) => h.toStatus === 'to_return') && chain03.some((h) => h.toStatus === 'to_grade'), JSON.stringify(chain03.map((h) => h.toStatus)));
    check('每条历史都有原状态/新状态/时间', history.every((h) => h.changedAt && h.toStatus && h.fromStatus !== undefined));
    const undoItems = (await req(phone, '/api/tasks/' + oldTask.id + '/bulk', 'POST', { scope: 'selected', studentIds: [studentIdOf(boot1, '11')], status: 'to_correct' })).updated;
    const undo = (await req(phone, '/api/assignments/restore', 'POST', { items: undoItems.map((u) => ({ assignmentId: u.assignmentId, status: u.from })) })).updated;
    check('可以撤销上一步操作', undo.length === 1 && undo[0].to === 'to_grade', JSON.stringify(undo));
    const undoHistory = (await req(phone, '/api/tasks/' + oldTask.id + '/history')).history;
    check('撤销也写入历史（可追溯）', undoHistory.some((h) => h.source === 'undo'));

    scenario('场景14 存档（归档）不会自动完成学生作业');
    const beforeArchive = (await req(phone, '/api/tasks/' + oldTask.id)).task;
    await req(phone, '/api/tasks/' + oldTask.id, 'PATCH', { status: 'closed' });
    const archived = (await req(phone, '/api/tasks/' + oldTask.id)).task;
    check('归档后学生状态不变', JSON.stringify(archived.counts) === JSON.stringify(beforeArchive.counts), JSON.stringify(archived.counts));
    check('默认看板隐藏已归档任务', !(await req(phone, '/api/tasks')).tasks.some((t) => t.id === oldTask.id));
    check('显示已归档后可以看到', (await req(phone, '/api/tasks?includeArchived=1')).tasks.some((t) => t.id === oldTask.id));
    await req(phone, '/api/tasks/' + oldTask.id, 'PATCH', { status: 'open' });

    scenario('场景15 班级人数可改、可加学生、可按学号查历史');
    const sizeResult = await req(phone, '/api/settings/class-size', 'POST', { classSize: 40 });
    check('保存班级人数 40 人', sizeResult.settings.classSize === 40);
    check('新增 39、40 号学号', sizeResult.created.indexOf('39') !== -1 && sizeResult.created.indexOf('40') !== -1, JSON.stringify(sizeResult.created));
    const studentHistory = await req(phone, '/api/students/' + studentIdOf(boot1, '12') + '/history?taskId=' + taskA3.id);
    check('可以按学生查历史', studentHistory.history.length > 0, 'rows=' + studentHistory.history.length);
    check('按学生查历史会限定在该任务', studentHistory.history.every((h) => h.taskId === taskA3.id));
    await req(phone, '/api/students', 'POST', { studentNo: '41', name: '新同学' });
    check('可以手动新增学生', (await req(phone, '/api/students')).allStudents.some((s) => s.studentNo === '41' && s.name === '新同学'));
    let dupError = null;
    try {
      await req(phone, '/api/students', 'POST', { studentNo: '41' });
    } catch (err) {
      dupError = err;
    }
    check('重复学号会被拒绝', !!dupError && /已存在/.test(dupError.message), dupError ? dupError.message : 'no error');

    scenario('场景16 筛选接口（作业册 / 课次 / 状态）');
    const byBook = (await req(phone, '/api/tasks?book=' + encodeURIComponent('B册') + '&includeArchived=1&includeDone=1')).tasks;
    check('按作业册筛选只返回 B册', byBook.length > 0 && byBook.every((t) => t.book === 'B册'), 'n=' + byBook.length);
    const byLesson = (await req(phone, '/api/tasks?lesson=' + encodeURIComponent('第4课') + '&includeDone=1')).tasks;
    check('按课次筛选只返回第4课', byLesson.length > 0 && byLesson.every((t) => t.lesson === '第4课'), 'n=' + byLesson.length);

    scenario('场景17 清空数据只清任务，保留名单');
    await req(phone, '/api/admin/reset', 'POST', { confirm: 'RESET', keepStudents: true });
    const afterReset = await req(phone, '/api/bootstrap');
    check('任务和历史被清空', afterReset.tasks.length === 0, 'tasks=' + afterReset.tasks.length);
    check('名单保留（40 个学号 + 手动新增的 41 号，共 41 人）', afterReset.students.length === 41, 'students=' + afterReset.students.length);
    check('历史也被清空', (await req(phone, '/api/history')).history.length === 0);

    scenario('场景18 接口与业务边界（错误处理）');
    let error = null;
    try {
      await req(phone, '/api/tasks', 'POST', { lesson: '第9课' });
    } catch (err) {
      error = err;
    }
    check('缺少作业册会被拒绝', !!error && /作业册/.test(error.message), error ? error.message : 'no error');
    error = null;
    try {
      await req(phone, '/api/assignments/999999999', 'PATCH', { status: 'done' });
    } catch (err) {
      error = err;
    }
    check('不存在的记录会报错', !!error && /记录不存在/.test(error.message), error ? error.message : 'no error');
    error = null;
    try {
      await req(phone, '/api/tasks/123/bulk', 'POST', { scope: 'selected', status: '待订正' });
    } catch (err) {
      error = err;
    }
    check('非法状态会被拒绝', !!error && /需要提供有效的 status/.test(error.message), error ? error.message : 'no error');
  } catch (err) {
    failCount += 1;
    failures.push('测试脚本异常: ' + (err && err.stack ? err.stack : err));
    console.log('\n测试脚本异常: ' + (err && err.stack ? err.stack : err));
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
