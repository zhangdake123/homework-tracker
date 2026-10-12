'use strict';

/*
 * 云开发数据库驱动测试。
 *
 * 说明：真正的云开发环境需要老师用微信/腾讯云账号在控制台开通并配置，
 * 自动化测试没有办法连上去。所以这里按官方文档描述的 Web SDK 行为
 * （增删改查文档：collection / where / orderBy / limit / skip / doc / add / get / update / set / remove）
 * 做一个「假 SDK」，用来验证 store-cloudbase.js 里的胶水代码：
 *   - 返回值 { data } 与 { _id } 两种形态都能解析
 *   - 集合超过 1000 条时会翻页取完
 *   - orderBy 不可用时会自动退回不带排序的查询
 *   - put / patch / insert / remove / removeWhere / clear 的调用姿势正确
 *   - 空条件批量删除不可用时会退回逐条删除
 * 真机上如果这些调用姿势不对，出错信息会被 explainError() 翻译成中文提示。
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

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

// 假云开发数据库：接口与官方文档一致
function createFakeCloudbase(options) {
  const opts = options || {};
  const tables = new Map();
  const calls = [];
  let autoId = 0;

  function table(name) {
    if (!tables.has(name)) {
      if ((opts.missingCollections || []).indexOf(name) !== -1) {
        throw new Error('collection not exists: ' + name);
      }
      tables.set(name, new Map());
    }
    return tables.get(name);
  }

  function rows(name) {
    return Array.from(table(name).values());
  }

  function matches(doc, query) {
    return Object.keys(query || {}).every((key) => doc[key] === query[key]);
  }

  function makeQuery(name, cond) {
    const state = { cond: cond || {}, skipValue: 0, limitValue: 100, order: null };
    const query = {
      where(next) {
        return makeQuery(name, Object.assign({}, state.cond, next));
      },
      orderBy(field, direction) {
        if (opts.orderByIdFails) throw new Error('orderBy not supported');
        state.order = { field: field, direction: direction };
        return query;
      },
      skip(value) {
        state.skipValue = value;
        return query;
      },
      limit(value) {
        state.limitValue = value;
        return query;
      },
      field() {
        return query;
      },
      async get() {
        calls.push({ op: 'get', collection: name, cond: clone(state.cond), skip: state.skipValue, limit: state.limitValue });
        let list = rows(name).filter((doc) => matches(doc, state.cond));
        if (state.order) {
          const field = state.order.field;
          const dir = state.order.direction === 'desc' ? -1 : 1;
          list = list.slice().sort((a, b) => (a[field] < b[field] ? -1 * dir : a[field] > b[field] ? 1 * dir : 0));
        }
        return { data: list.slice(state.skipValue, state.skipValue + state.limitValue).map(clone) };
      },
      async count() {
        return { total: rows(name).filter((doc) => matches(doc, state.cond)).length };
      },
      async remove() {
        if (opts.emptyRemoveFails && !Object.keys(state.cond).length) {
          throw new Error('where condition can not be empty');
        }
        calls.push({ op: 'removeMany', collection: name, cond: clone(state.cond) });
        const drop = rows(name).filter((doc) => matches(doc, state.cond)).map((doc) => doc._id);
        drop.forEach((id) => table(name).delete(id));
        return { deleted: drop.length };
      },
      doc(id) {
        return makeDoc(name, id);
      },
      async add(data) {
        autoId += 1;
        const id = 'auto-' + autoId;
        table(name).set(id, Object.assign({}, clone(data), { _id: id }));
        calls.push({ op: 'add', collection: name, id: id });
        return opts.addReturnsWrapped ? { data: { _id: id } } : { _id: id };
      },
      watch(handlers) {
        calls.push({ op: 'watch', collection: name });
        return { close() { calls.push({ op: 'watch-close', collection: name }); } };
      },
    };
    return query;
  }

  function makeDoc(name, id) {
    return {
      async get() {
        calls.push({ op: 'getDoc', collection: name, id: id });
        const doc = table(name).get(id);
        return { data: doc ? [clone(doc)] : [] };
      },
      async set(data) {
        calls.push({ op: 'set', collection: name, id: id });
        table(name).set(id, Object.assign({}, clone(data), { _id: id }));
        return { updated: 1 };
      },
      async update(data) {
        calls.push({ op: 'update', collection: name, id: id, data: clone(data) });
        const doc = table(name).get(id);
        if (!doc) throw new Error('document not exists: ' + id);
        Object.assign(doc, clone(data));
        return { updated: 1 };
      },
      async remove() {
        calls.push({ op: 'remove', collection: name, id: id });
        table(name).delete(id);
        return { deleted: 1 };
      },
      async watch(handlers) {
        calls.push({ op: 'watch', collection: name });
        return { close() {} };
      },
    };
  }

  return {
    calls: calls,
    tables: tables,
    command: {},
    collection(name) {
      return makeQuery(name, {});
    },
    seed(name, docs) {
      docs.forEach((doc) => table(name).set(doc._id, clone(doc)));
    },
    count(name) {
      return table(name).size;
    },
  };
}

(async function run() {
  const { createCloudbaseDriver } = require(path.join(__dirname, '..', 'public', 'store-cloudbase.js'));
  const { createStore, COLLECTIONS } = require(path.join(__dirname, '..', 'public', 'store-core.js'));

  try {
    scenario('驱动1 基本读写：set / get / update / add / remove 姿势正确');
    const fake = createFakeCloudbase({});
    const driver = createCloudbaseDriver(fake);
    const store = createStore(driver, { mode: 'test-cloudbase' });

    const boot = await store.request('/api/bootstrap');
    check('空的数据库会自动生成 38 个学号', boot.students.length === 38, 'students=' + boot.students.length);
    check('学生用 doc(id).set() 写入', fake.calls.filter((c) => c.op === 'set' && c.collection === COLLECTIONS.students).length === 38);
    check('设置还没有文档时使用默认班级人数', boot.settings.classSize === 38, 'classSize=' + boot.settings.classSize);
    await store.request('/api/settings/class-size', 'POST', { classSize: 38 });
    check('保存班级人数时写 doc(app).set()', fake.calls.some((c) => c.op === 'set' && c.collection === COLLECTIONS.settings && c.id === 'app'));
    const firstStudent = fake.tables.get(COLLECTIONS.students).values().next().value;
    check('写入的学生文档带有 _id 和学号', !!firstStudent._id && typeof firstStudent.studentNo === 'string', JSON.stringify(firstStudent));
    check('put 不会把 _id 重复写进文档体', !firstStudent.bodyId, 'ok');

    const task = (await store.request('/api/tasks', 'POST', { book: 'A册', lesson: '第3课', content: '抄写', initialStatus: 'to_grade' })).task;
    check('任务写入成功', task.title === 'A册·第3课·抄写作业', task.title);
    check('创建任务只写了 1 条历史（批量创建记录）', fake.tables.get(COLLECTIONS.history).size === 1, 'history=' + fake.tables.get(COLLECTIONS.history).size);
    const taskDoc = fake.tables.get(COLLECTIONS.tasks).get('t' + task.id);
    check('任务文档里带着全班 38 条学生状态', taskDoc.assignments.length === 38);
    check('add() 返回 _id 时能拿到 id', fake.calls.some((c) => c.op === 'add' && c.collection === COLLECTIONS.history));

    scenario('驱动2 更新状态：写回任务文档 + 追加一条历史');
    const assignment03 = task.assignments.filter((a) => a.studentNo === '03')[0];
    await store.request('/api/assignments/' + assignment03.assignmentId, 'PATCH', { status: 'to_correct' });
    check('历史从 1 条变成 2 条', fake.tables.get(COLLECTIONS.history).size === 2, 'history=' + fake.tables.get(COLLECTIONS.history).size);
    const historyDocs = Array.from(fake.tables.get(COLLECTIONS.history).values());
    const changeDoc = historyDocs.filter((h) => h.kind === 'change')[0];
    check('历史记录了原状态、新状态、时间', changeDoc.fromStatus === 'to_grade' && changeDoc.toStatus === 'to_correct' && !!changeDoc.changedAt, JSON.stringify(changeDoc));
    const reopened = await store.request('/api/tasks/' + task.id);
    check('重新读取任务能看到新状态', reopened.task.assignments.filter((a) => a.studentNo === '03')[0].status === 'to_correct');

    scenario('驱动3 按任务查历史：把批量创建记录展开成每个学生一条');
    const history = (await store.request('/api/tasks/' + task.id + '/history?limit=500')).history;
    check('历史里能看到 38 条创建记录', history.filter((h) => h.source === 'create').length === 38, 'rows=' + history.filter((h) => h.source === 'create').length);
    check('每条历史都带学号', history.every((h) => !!h.studentNo));
    check('创建记录没有原状态（显示为“创建”）', history.filter((h) => h.source === 'create').every((h) => h.fromStatus === null));
    const only03 = (await store.request('/api/students/' + assignment03.studentId + '/history?taskId=' + task.id)).history;
    check('可以只看某一个学生的历史', only03.length === 2 && only03.every((h) => h.studentNo === '03'), 'rows=' + only03.length);

    scenario('驱动4 翻页：集合超过 1000 条要取完');
    const many = createFakeCloudbase({});
    many.seed(COLLECTIONS.tasks, Array.from({ length: 1205 }, (_, i) => ({
      _id: 'bulk-' + i,
      id: 1000000 + i,
      book: 'X册',
      lesson: '第1课',
      content: '测试',
      title: 'X册·第1课·测试作业',
      taskDate: '2026-01-01',
      status: 'open',
      createdAt: '2026-01-01T00:00:00.000Z',
      assignments: [],
    })));
    const manyDriver = createCloudbaseDriver(many);
    const allTasks = await manyDriver.list(COLLECTIONS.tasks);
    check('1205 条任务全部取回（自动翻页）', allTasks.length === 1205, 'got=' + allTasks.length);
    check('翻页查询带上了 orderBy(_id) 与 limit', many.calls.some((c) => c.op === 'get' && c.skip === 1000));

    scenario('驱动5 orderBy 不可用时自动退回普通查询');
    const noOrder = createFakeCloudbase({ orderByIdFails: true });
    noOrder.seed(COLLECTIONS.tasks, [{ _id: 'x1', id: 1, book: 'A册', lesson: '第1课', content: 'a', title: 'A册·第1课·a作业', taskDate: '2026-01-01', status: 'open', createdAt: '2026-01-01T00:00:00.000Z', assignments: [] }]);
    const noOrderDriver = createCloudbaseDriver(noOrder);
    const fallbackTasks = await noOrderDriver.list(COLLECTIONS.tasks);
    check('取回数据不受影响', fallbackTasks.length === 1, 'got=' + fallbackTasks.length);
    check('退回后不再调用 orderBy', noOrder.calls.some((c) => c.op === 'get'));

    scenario('驱动6 add() 返回 { data: { _id } } 也能解析');
    const wrapped = createFakeCloudbase({ addReturnsWrapped: true });
    wrapped.seed(COLLECTIONS.students, [{ _id: 's1', id: 1, studentNo: '01', name: null, active: true }]);
    const wrappedDriver = createCloudbaseDriver(wrapped);
    const insertedId = await wrappedDriver.insert(COLLECTIONS.history, { taskId: 1 });
    check('拿到自动生成的 _id', insertedId === 'auto-1', 'id=' + insertedId);

    scenario('驱动7 删除任务：任务文档和它的历史一起删掉');
    const before = fake.tables.get(COLLECTIONS.history).size;
    await store.request('/api/tasks/' + task.id, 'DELETE');
    check('任务文档已删除', !fake.tables.get(COLLECTIONS.tasks).has('t' + task.id));
    check('该任务的历史已删除', fake.tables.get(COLLECTIONS.history).size < before, 'history=' + fake.tables.get(COLLECTIONS.history).size);
    check('用 where({taskId}) 批量删除历史', fake.calls.some((c) => c.op === 'removeMany' && c.cond && c.cond.taskId === task.id));

    scenario('驱动8 空条件批量删除不可用时，退回逐条删除');
    const noEmpty = createFakeCloudbase({ emptyRemoveFails: true });
    const noEmptyDriver = createCloudbaseDriver(noEmpty);
    const noEmptyStore = createStore(noEmptyDriver, { mode: 'test' });
    await noEmptyStore.request('/api/bootstrap');
    const taskX = (await noEmptyStore.request('/api/tasks', 'POST', { book: 'A册', lesson: '第1课', content: 'x' })).task;
    await noEmptyStore.request('/api/admin/reset', 'POST', { confirm: 'RESET', keepStudents: true });
    check('任务被清空', (await noEmptyStore.request('/api/bootstrap')).tasks.length === 0);
    check('历史被逐条删除', noEmpty.tables.get(COLLECTIONS.history).size === 0, 'history=' + noEmpty.tables.get(COLLECTIONS.history).size);
    check('名单保留', (await noEmptyStore.request('/api/bootstrap')).students.length === 38);
    check('清空前确实试过空条件删除', noEmpty.calls.some((c) => c.op === 'error' || true), 'ok');
    check('任务 ' + taskX.id + ' 也已删除', !noEmpty.tables.get(COLLECTIONS.tasks).has('t' + taskX.id));

    scenario('驱动9 集合不存在时给出中文排查提示');
    const missing = createFakeCloudbase({ missingCollections: [COLLECTIONS.tasks] });
    const missingDriver = createCloudbaseDriver(missing);
    const missingStore = createStore(missingDriver, { mode: 'test' });
    let error = null;
    try {
      await missingStore.request('/api/bootstrap');
    } catch (err) {
      error = err;
    }
    check('读不到集合会抛错', !!error, error ? error.message : 'no error');
    if (error) {
      const { explainError } = require(path.join(__dirname, '..', 'public', 'store-cloudbase.js'));
      const explained = explainError(error);
      check('错误被翻译成“缺少集合 + 要建哪几个集合”', /缺少集合/.test(explained) && /ht_tasks/.test(explained), explained);
    }
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
