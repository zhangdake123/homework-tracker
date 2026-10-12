(function (root, factory) {
  'use strict';
  const core = (typeof module === 'object' && module.exports) ? require('./store-core.js') : root.HomeworkStoreCore;
  const api = factory(core, root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HomeworkCloudDriver = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core, root) {
  const createStore = core.createStore;
  const COLLECTIONS = core.COLLECTIONS;
  'use strict';

  /*
   * 纯静态托管版的数据落地部分：
   * 浏览器直接用云开发 Web SDK 读写「云开发数据库」，不需要任何服务器。
   *
   * 需要老师在云开发控制台做三件事（详见 README「静态托管部署」）：
   *   1. 身份认证 → 登录方式 → 开启「匿名登录」
   *   2. 文档型数据库 → 集合管理 → 新建 4 个集合：ht_students / ht_tasks / ht_history / ht_settings
   *      并把权限改成「所有用户可读写」（安全规则 {"read": true, "write": true}）
   *   3. 环境配置 → 安全来源 → 把网页域名加进去（静态托管默认域名 env-id.tcloudbaseapp.com 已在白名单里）
   *
   * 本文件只负责「怎么存」，业务规则在 store-core.mjs 里，两边共用同一套规则。
   */


  const SDK_URL = 'https://static.cloudbase.net/cloudbase-js-sdk/2.28.6/cloudbase.full.js';
  const CONFIG_KEY = 'homework.cloudbase.config';
  const DEFAULT_REGION = 'ap-shanghai';
  const PAGE_SIZE = 1000;
  const WRITE_BATCH = 6;

  let orderByIdSupported = true;

  function readStoredConfig() {
    try {
      const raw = window.localStorage.getItem(CONFIG_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.env) return { env: String(parsed.env).trim(), region: parsed.region ? String(parsed.region) : DEFAULT_REGION };
      return null;
    } catch (err) {
      return null;
    }
  }

  function readQueryConfig() {
    try {
      const params = new URLSearchParams(window.location.search);
      const env = params.get('env');
      if (env) return { env: String(env).trim(), region: params.get('region') || DEFAULT_REGION };
    } catch (err) {
      /* ignore */
    }
    return null;
  }

  // 可选：如果网站里放了 cloudbase-config.js 就自动读它，手机端不用手输环境 ID
  function loadOptionalConfigFile() {
    if (window.HOMEWORK_CLOUD_CONFIG) return Promise.resolve();
    if (typeof document === 'undefined') return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      const script = document.createElement('script');
      script.src = 'cloudbase-config.js';
      script.async = false;
      script.onload = finish;
      script.onerror = finish;
      try {
        document.head.appendChild(script);
      } catch (err) {
        finish();
        return;
      }
      setTimeout(finish, 4000);
    });
  }

  function runBatched(operations, size) {
    const width = Math.max(1, size || WRITE_BATCH);
    const list = operations.slice();
    const step = function () {
      if (!list.length) return Promise.resolve();
      return Promise.all(list.splice(0, width).map((fn) => fn())).then(step);
    };
    return step();
  }

  function errorMessageOf(err) {
    if (!err) return '';
    if (typeof err === 'string') return err;
    if (err.errMsg) return String(err.errMsg);
    if (err.error && err.error.message) return String(err.error.message);
    if (err.message) return String(err.message);
    try {
      return JSON.stringify(err);
    } catch (e) {
      return String(err);
    }
  }

  // 云开发 SDK v2 有的接口返回 { data }，有的直接返回结果，这里统一拆一层
  function unwrap(result) {
    if (result && typeof result === 'object' && result.error) {
      throw new Error(errorMessageOf(result.error));
    }
    if (Array.isArray(result)) return result;
    if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'data')) {
      const keys = Object.keys(result).filter((k) => k !== 'data' && k !== 'error' && k !== 'requestId');
      if (!keys.length) return result.data;
    }
    return result;
  }

  function explainError(err) {
    const message = errorMessageOf(err) || '未知错误';
    if (/匿名|anonymous/i.test(message)) {
      return '云开发环境还没开启「匿名登录」（云开发平台 → 身份认证 → 登录方式 → 匿名登录 → 开启）。原始错误：' + message;
    }
    if (/CORS|origin|安全|来源|domain/i.test(message)) {
      return '当前网址不在云开发「安全来源」名单里（云开发平台 → 环境配置 → 安全来源 → 添加域名，静态托管默认域名通常已自动加入）。原始错误：' + message;
    }
    if (/collection|集合|DATABASE_COLLECTION/i.test(message)) {
      return '云开发数据库缺少集合，请新建 ' + Object.keys(COLLECTIONS).map((k) => COLLECTIONS[k]).join(' / ') + '。原始错误：' + message;
    }
    if (/permission|PERMISSION_DENIED|权限|denied/i.test(message)) {
      return '云开发数据库权限不足，请把 4 个集合的权限设为「所有用户可读写」（安全规则 {"read": true, "write": true}）。原始错误：' + message;
    }
    if (/env|环境|INVALID_ENV|not found/i.test(message)) {
      return '云开发环境 ID 可能填错了（形如 my-env-1a2b3c4d）。原始错误：' + message;
    }
    if (/network|Failed to fetch|timeout|超时/i.test(message)) {
      return '连接云开发失败，请检查网络后重试。原始错误：' + message;
    }
    return message;
  }

  function loadSdk() {
    if (window.cloudbase) return Promise.resolve(window.cloudbase);
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SDK_URL;
      script.async = true;
      script.onload = () => {
        if (window.cloudbase) resolve(window.cloudbase);
        else reject(new Error('云开发 SDK 已加载，但没有找到全局 cloudbase 对象'));
      };
      script.onerror = () => reject(new Error('云开发 SDK 下载失败（' + SDK_URL + '），请检查网络'));
      document.head.appendChild(script);
    });
  }

  function createCloudbaseDriver(db) {
    async function queryAll(builder) {
      const docs = [];
      for (let skip = 0; skip < 20000; skip += PAGE_SIZE) {
        let page = null;
        if (orderByIdSupported) {
          try {
            page = unwrap(await builder.orderBy('_id', 'asc').skip(skip).limit(PAGE_SIZE).get());
          } catch (err) {
            orderByIdSupported = false;
          }
        }
        if (!page) page = unwrap(await builder.skip(skip).limit(PAGE_SIZE).get());
        const rows = Array.isArray(page) ? page : [];
        docs.push.apply(docs, rows);
        if (rows.length < PAGE_SIZE) break;
      }
      return docs;
    }

    function docIdOf(result) {
      if (!result) return null;
      if (result._id) return String(result._id);
      if (result.id) return String(result.id);
      if (result.data) {
        if (Array.isArray(result.data)) return result.data.length ? docIdOf(result.data[0]) : null;
        return docIdOf(result.data);
      }
      return null;
    }

    return {
      async list(collection) {
        return queryAll(db.collection(collection));
      },
      async listWhere(collection, query) {
        return queryAll(db.collection(collection).where(query));
      },
      async get(collection, id) {
        const docs = unwrap(await db.collection(collection).doc(id).get());
        const rows = Array.isArray(docs) ? docs : (docs ? [docs] : []);
        return rows.length ? rows[0] : null;
      },
      async put(collection, id, doc) {
        const payload = Object.assign({}, doc);
        delete payload._id;
        unwrap(await db.collection(collection).doc(id).set(payload));
      },
      async insert(collection, doc) {
        return docIdOf(await db.collection(collection).add(doc));
      },
      async patch(collection, id, partial) {
        unwrap(await db.collection(collection).doc(id).update(partial));
      },
      async remove(collection, id) {
        unwrap(await db.collection(collection).doc(id).remove());
      },
      async removeWhere(collection, query) {
        unwrap(await db.collection(collection).where(query).remove());
      },
      async clear(collection) {
        try {
          unwrap(await db.collection(collection).where({}).remove());
        } catch (err) {
          /* 有的环境下不支持空条件批量删除，下面退回逐条删除 */
        }
        const left = await queryAll(db.collection(collection));
        if (!left.length) return;
        await runBatched(left.map((doc) => () => db.collection(collection).doc(doc._id).remove()), 8);
      },
    };
  }

  function debounce(fn, wait) {
    let timer = null;
    return function debounced() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, wait);
    };
  }

  function createCloudBackend(store, db) {
    let watchers = [];
    let pollTimer = null;
    let hooks = null;

    function notifyChange() {
      if (hooks && typeof hooks.onChange === 'function') hooks.onChange();
    }

    function startPolling(fallbackReason) {
      if (pollTimer) return;
      pollTimer = setInterval(() => {
        if (!document.hidden) notifyChange();
      }, fallbackReason ? 8000 : 20000);
      if (fallbackReason && hooks && typeof hooks.onWarn === 'function') hooks.onWarn(fallbackReason);
    }

    function startWatch() {
      try {
        const watcher = db.collection(COLLECTIONS.tasks).where({}).watch({
          onChange: debounce(notifyChange, 250),
          onError: (err) => {
            closeWatchers();
            startPolling('实时推送不可用，已改用定时刷新（' + errorMessageOf(err) + '）');
          },
        });
        watchers.push(watcher);
        if (hooks && typeof hooks.onReady === 'function') hooks.onReady('云开发实时同步已连接');
      } catch (err) {
        startPolling('实时推送不可用，已改用定时刷新');
      }
    }

    function closeWatchers() {
      watchers.forEach((watcher) => {
        try {
          watcher.close();
        } catch (err) {
          /* ignore */
        }
      });
      watchers = [];
    }

    return {
      mode: 'cloudbase',
      label: '云开发数据库',
      store: store,
      request: async function request(path, method, body) {
        try {
          return await store.request(path, method, body);
        } catch (err) {
          // 运行时遇到的云开发错误（缺少集合、权限不足等）也翻译成可操作的中文提示
          const explained = explainError(err);
          const original = errorMessageOf(err);
          if (explained && explained !== original) {
            const wrapped = new Error(explained);
            wrapped.cause = err;
            throw wrapped;
          }
          throw err;
        }
      },
      exportAll: function exportAll() {
        return store.exportAll();
      },
      subscribe: function subscribe(callbacks) {
        hooks = callbacks || {};
        startWatch();
        startPolling(null);
      },
      stop: function stop() {
        closeWatchers();
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
      },
    };
  }

  async function boot() {
    const info = {
      configured: false,
      env: '',
      region: DEFAULT_REGION,
      status: 'off',
      message: '',
    };
    window.HomeworkCloud = Object.assign(info, {
      sdkUrl: SDK_URL,
      save: function save(env, region) {
        window.localStorage.setItem(CONFIG_KEY, JSON.stringify({ env: String(env).trim(), region: region || DEFAULT_REGION }));
      },
      clear: function clear() {
        window.localStorage.removeItem(CONFIG_KEY);
      },
      configKey: CONFIG_KEY,
      configFileText: function configFileText(env, region) {
        return '// 把本文件放到网站根目录，其它设备（手机）打开网页时就不用再手输环境 ID 了。\n' +
          'window.HOMEWORK_CLOUD_CONFIG = { env: ' + JSON.stringify(String(env || '')) +
          ', region: ' + JSON.stringify(String(region || DEFAULT_REGION)) + ' };\n';
      },
    });

    let config = readQueryConfig() || readStoredConfig();
    let configSource = readQueryConfig() ? 'url' : (config ? 'local' : 'none');
    if (!config) {
      // 本机没填过、网址上也没带，才去找网站根目录下的 cloudbase-config.js
      await loadOptionalConfigFile();
      const injected = window.HOMEWORK_CLOUD_CONFIG;
      if (injected && injected.env) {
        config = { env: String(injected.env).trim(), region: injected.region || DEFAULT_REGION };
        configSource = 'file';
      }
    }
    window.HomeworkCloud.configSource = configSource;
    if (window.HOMEWORK_CLOUD_CONFIG && window.HOMEWORK_CLOUD_CONFIG.env) window.HomeworkCloud.fileEnv = String(window.HOMEWORK_CLOUD_CONFIG.env);
    window.HomeworkBackend = null;
    if (!config || !config.env) {
      window.HomeworkCloud.status = 'off';
      window.HomeworkCloud.message = '当前使用本机 / 局域网服务器（/api/*）。若要部署到静态托管，请填写云开发环境 ID。';
      return null;
    }

    window.HomeworkCloud.configured = true;
    window.HomeworkCloud.env = config.env;
    window.HomeworkCloud.region = config.region || DEFAULT_REGION;
    window.HomeworkCloud.status = 'loading';
    window.HomeworkCloud.message = '正在连接云开发环境 ' + config.env + ' …';

    const cloudbase = await loadSdk();
    const app = cloudbase.init({ env: config.env, region: config.region || DEFAULT_REGION });
    const auth = typeof app.auth === 'function' ? app.auth() : app.auth;
    if (auth && typeof auth.signInAnonymously === 'function') {
      const loginResult = await auth.signInAnonymously();
      if (loginResult && loginResult.error) throw new Error(errorMessageOf(loginResult.error));
    }
    const db = app.database();
    if (db && typeof db.command === 'undefined') {
      // 极少数情况下 database 模块需要显式注册（按需引入 SDK 时），这里给出明确提示
      window.HomeworkCloud.message = '云开发 SDK 的数据库模块不可用，请确认加载的是 cloudbase.full.js';
    }
    const driver = createCloudbaseDriver(db);
    const store = createStore(driver, { mode: 'cloudbase' });
    const backend = createCloudBackend(store, db);
    window.HomeworkBackend = backend;
    window.HomeworkCloud.status = 'ready';
    window.HomeworkCloud.message = '已连接云开发环境 ' + config.env + '（数据保存在云开发数据库，手机和电脑共享同一份数据）';
    return backend;
  }

  // 只在浏览器里启动：读配置 → 连接云开发 → 把 backend 挂到 window 上
  function startBrowserBoot() {
    const readyPromise = (async function () {
      try {
        return await boot();
      } catch (err) {
        const message = explainError(err);
        if (window.HomeworkCloud) {
          window.HomeworkCloud.status = 'error';
          window.HomeworkCloud.message = message;
        }
        try {
          window.localStorage.setItem('homework.cloudbase.lastError', message);
        } catch (e) {
          /* ignore */
        }
        console.error('[homework-tracker] 云开发连接失败：', err);
        throw new Error(message);
      }
    })();
    // 连接失败时由页面负责提示，这里先消掉浏览器控制台的 unhandled rejection
    readyPromise.catch(function () {});
    window.HomeworkBackendReady = readyPromise;
    return readyPromise;
  }

  if (typeof document !== 'undefined' && typeof root.window !== 'undefined' && root.window === root) {
    startBrowserBoot();
  }

  return { createCloudbaseDriver: createCloudbaseDriver, explainError: explainError };
});
