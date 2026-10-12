'use strict';

/*
 * 静态版启动流程测试。
 *
 * store-cloudbase.js 是给浏览器用的（读 localStorage 配置 → 加载云开发 SDK → 匿名登录 → 建 backend），
 * 真机验证需要老师的云开发环境；这里用一个「假浏览器」（假的 window / document / localStorage / SDK）
 * 在 Node 里把这个启动流程跑一遍，确认：
 *   - 没有配置时不会瞎连，页面回落到本机服务器模式
 *   - 配置了环境 ID 时，SDK 加载、匿名登录、数据库挂载、实时监听都会按顺序发生
 *   - 匿名登录没开、集合不存在等错误会被翻译成中文可操作提示
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

const CLOUD_MODULE = path.join(__dirname, '..', 'public', 'store-cloudbase.js');

// 假云开发数据库（和 cloudbase-driver.test.js 里同款，够用就行）
function fakeDatabase(options) {
  const opts = options || {};
  const tables = new Map();
  let auto = 0;
  const calls = [];
  function table(name) {
    if (!tables.has(name)) {
      if ((opts.missingCollections || []).indexOf(name) !== -1) throw new Error('collection not exists: ' + name);
      tables.set(name, new Map());
    }
    return tables.get(name);
  }
  function rows(name) {
    return Array.from(table(name).values());
  }
  function matches(doc, query) {
    return Object.keys(query || {}).every((k) => doc[k] === query[k]);
  }
  function makeQuery(name, cond) {
    const state = { cond: cond || {}, skip: 0, limit: 100 };
    const query = {
      where(next) { return makeQuery(name, Object.assign({}, state.cond, next)); },
      orderBy() { return query; },
      skip(v) { state.skip = v; return query; },
      limit(v) { state.limit = v; return query; },
      async get() { return { data: rows(name).filter((d) => matches(d, state.cond)).slice(state.skip, state.skip + state.limit).map((d) => JSON.parse(JSON.stringify(d))) }; },
      async remove() {
        rows(name).filter((d) => matches(d, state.cond)).forEach((d) => table(name).delete(d._id));
        return { deleted: 1 };
      },
      doc(id) {
        return {
          async get() { const d = table(name).get(id); return { data: d ? [JSON.parse(JSON.stringify(d))] : [] }; },
          async set(data) { table(name).set(id, Object.assign({}, data, { _id: id })); return { updated: 1 }; },
          async update(data) { Object.assign(table(name).get(id), data); return { updated: 1 }; },
          async remove() { table(name).delete(id); return { deleted: 1 }; },
        };
      },
      async add(data) { auto += 1; const id = 'auto-' + auto; table(name).set(id, Object.assign({}, data, { _id: id })); return { _id: id }; },
      watch(handlers) { calls.push({ op: 'watch', collection: name }); return { close() { calls.push({ op: 'watch-close', collection: name }); } }; },
    };
    return query;
  }
  return {
    calls: calls,
    tables: tables,
    command: {},
    collection(name) { return makeQuery(name, {}); },
  };
}

function installFakeBrowser(options) {
  const opts = options || {};
  const storage = new Map();
  if (opts.config) storage.set('homework.cloudbase.config', JSON.stringify(opts.config));
  const listeners = {};
  const documentStub = {
    hidden: false,
    head: {
      appendChild(node) {
        // 静态目录里没有 cloudbase-config.js 就是立刻 404（onerror）；有的话就加载成功（onload）
        if (opts.configFileEnv) {
          global.window.HOMEWORK_CLOUD_CONFIG = { env: opts.configFileEnv };
          if (node && typeof node.onload === 'function') setTimeout(() => node.onload(), 0);
          return;
        }
        if (node && typeof node.onerror === 'function') setTimeout(() => node.onerror(), 0);
      },
    },
    body: { appendChild() {}, removeChild() {} },
    createElement() { return { src: '', async: false, onload: null, onerror: null }; },
    addEventListener(type, fn) { listeners[type] = fn; },
    querySelectorAll() { return []; },
    getElementById() { return null; },
  };
  global.window = global;
  global.document = documentStub;
  global.localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); },
  };
  global.location = { search: opts.search || '', hostname: opts.hostname || 'localhost', protocol: 'http:', reload() {} };
  global.confirm = () => true;
  delete global.window.cloudbase;
  delete global.window.HOMEWORK_CLOUD_CONFIG;
  delete global.window.HomeworkBackend;
  delete global.window.HomeworkCloud;
  delete global.window.HomeworkBackendReady;
  if (opts.cloudbase) global.window.cloudbase = opts.cloudbase;
  return { storage: storage, listeners: listeners };
}

function loadCloudModule() {
  Object.keys(require.cache)
    .filter((key) => key.indexOf('store-cloudbase') !== -1 || key.indexOf('store-core') !== -1)
    .forEach((key) => delete require.cache[key]);
  return require(CLOUD_MODULE);
}

function makeFakeSdk(db, loginHandler) {
  return {
    init(config) {
      this.lastConfig = config;
      return {
        auth: {
          signInAnonymously: loginHandler || (async () => ({ data: { uid: 'anon-1' } })),
        },
        database() { return db; },
      };
    },
  };
}

(async function run() {
  try {
    scenario('启动1 没有配置环境 ID：不连云开发，回落到本机服务器模式');
    installFakeBrowser({});
    loadCloudModule();
    const backend = await window.HomeworkBackendReady;
    check('backend 为空（继续用 /api/*）', backend === null, String(backend));
    check('状态标记为 off', window.HomeworkCloud.status === 'off', window.HomeworkCloud.status);
    check('提示里说明了当前用本机服务器', /本机/.test(window.HomeworkCloud.message), window.HomeworkCloud.message);

    scenario('启动2 配置了环境 ID：会加载 SDK、匿名登录、挂载数据库、开启实时监听');
    const db = fakeDatabase({});
    installFakeBrowser({ config: { env: 'test-env-abc123', region: 'ap-shanghai' }, cloudbase: makeFakeSdk(db) });
    loadCloudModule();
    const cloudBackend = await window.HomeworkBackendReady;
    check('拿到云开发 backend', !!cloudBackend && cloudBackend.mode === 'cloudbase', cloudBackend ? cloudBackend.mode : 'null');
    check('状态标记为 ready', window.HomeworkCloud.status === 'ready', window.HomeworkCloud.status);
    check('读到了配置的环境 ID', window.HomeworkCloud.env === 'test-env-abc123', window.HomeworkCloud.env);
    const boot = await window.HomeworkBackend.request('/api/bootstrap');
    check('通过云开发数据库自动生成 38 个学号', boot.students.length === 38, 'students=' + boot.students.length);
    const readyText = [];
    cloudBackend.subscribe({
      onReady: (text) => readyText.push(text),
      onChange: () => {},
      onWarn: (text) => readyText.push('warn:' + text),
    });
    check('开启了实时监听（watch）', db.calls.some((c) => c.op === 'watch'), JSON.stringify(db.calls));
    check('有实时同步状态提示', readyText.length > 0, JSON.stringify(readyText));
    cloudBackend.stop();
    check('停止同步会关闭监听', db.calls.some((c) => c.op === 'watch-close'));

    scenario('启动3 匿名登录没开启：给出可操作的中文提示');
    const db2 = fakeDatabase({});
    installFakeBrowser({
      config: { env: 'test-env-abc123', region: 'ap-shanghai' },
      cloudbase: makeFakeSdk(db2, async () => ({ error: { message: 'anonymous login is not enabled' } })),
    });
    loadCloudModule();
    let loginError = null;
    try {
      await window.HomeworkBackendReady;
    } catch (err) {
      loginError = err;
    }
    check('启动会失败并抛错', !!loginError, loginError ? loginError.message : 'no error');
    check('提示指向「匿名登录」怎么开', !!loginError && /匿名登录/.test(loginError.message), loginError ? loginError.message : '');
    check('状态标记为 error', window.HomeworkCloud.status === 'error', window.HomeworkCloud.status);

    scenario('启动4 集合不存在：提示要新建哪几个集合');
    const db3 = fakeDatabase({ missingCollections: ['ht_tasks'] });
    installFakeBrowser({ config: { env: 'test-env-abc123' }, cloudbase: makeFakeSdk(db3) });
    loadCloudModule();
    let collectionError = null;
    try {
      const backend3 = await window.HomeworkBackendReady;
      await backend3.request('/api/bootstrap');
    } catch (err) {
      collectionError = err;
    }
    check('读不到集合会失败', !!collectionError, collectionError ? collectionError.message : 'no error');
    check('运行时的云开发错误也会翻译成中文', !!collectionError && /缺少集合/.test(collectionError.message) && /ht_tasks/.test(collectionError.message), collectionError ? collectionError.message : '');

    scenario('启动5 环境 ID 写错（init 直接报错）：提示检查环境 ID');
    installFakeBrowser({
      config: { env: 'wrong-env' },
      cloudbase: {
        init() {
          throw new Error('env not found: wrong-env');
        },
      },
    });
    loadCloudModule();
    let envError = null;
    try {
      await window.HomeworkBackendReady;
    } catch (err) {
      envError = err;
    }
    check('会给出环境 ID 相关的提示', !!envError && /环境 ID/.test(envError.message), envError ? envError.message : 'no error');

    scenario('启动6 也可以直接用网址参数指定环境 ID（?env=xxx）');
    const db6 = fakeDatabase({});
    installFakeBrowser({ search: '?env=query-env-1', cloudbase: makeFakeSdk(db6) });
    loadCloudModule();
    const backend6 = await window.HomeworkBackendReady;
    check('从网址参数读到环境 ID', !!backend6 && window.HomeworkCloud.env === 'query-env-1', window.HomeworkCloud.env);
    backend6.stop();
    scenario('启动7 网站里放了 cloudbase-config.js：自动连接，手机不用手输环境 ID');
    const db7 = fakeDatabase({});
    installFakeBrowser({ configFileEnv: 'file-env-9999', cloudbase: makeFakeSdk(db7) });
    loadCloudModule();
    const backend7 = await window.HomeworkBackendReady;
    check('从 cloudbase-config.js 读到环境 ID 并连上', !!backend7 && window.HomeworkCloud.env === 'file-env-9999', window.HomeworkCloud.env);
    check('配置来源标记为 file', window.HomeworkCloud.configSource === 'file', window.HomeworkCloud.configSource);
    check('页面能生成 cloudbase-config.js 内容', /HOMEWORK_CLOUD_CONFIG/.test(window.HomeworkCloud.configFileText('file-env-9999', 'ap-shanghai')), window.HomeworkCloud.configFileText('file-env-9999'));
    backend7.stop();
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
