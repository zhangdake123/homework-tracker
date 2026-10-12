'use strict';
/* 注入到页面的假云开发 SDK（只在 E2E 里用）。
 * 数据放在 localStorage 里，所以「刷新/重开页面」数据仍在；
 * 另一个标签页写入时用 BroadcastChannel 推送，模拟云开发的 watch 实时同步。 */

(function () {
  var KEY = '__hw_e2e_db__';
  var CH = '__hw_e2e_channel__';
  var watchHandlers = [];

  function readAll() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; }
  }
  function writeAll(data) { localStorage.setItem(KEY, JSON.stringify(data)); }
  function tableRows(name) {
    var all = readAll();
    var t = all[name] || {};
    return Object.keys(t).map(function (id) { return t[id]; });
  }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function matches(doc, cond) {
    return Object.keys(cond || {}).every(function (k) { return doc[k] === cond[k]; });
  }
  function fire() {
    watchHandlers.forEach(function (h) { try { if (h && h.onChange) h.onChange({}); } catch (e) {} });
  }
  function notify() {
    try { if (channel) channel.postMessage({ t: 'change' }); } catch (e) {}
  }

  var channel = null;
  try { channel = new BroadcastChannel(CH); } catch (e) { channel = null; }
  if (channel) channel.onmessage = function () { fire(); };
  window.addEventListener('storage', function (ev) { if (ev.key === KEY) fire(); });

  function makeDoc(name, id) {
    return {
      get: async function () {
        var all = readAll();
        var d = (all[name] || {})[id];
        return { data: d ? [clone(d)] : [] };
      },
      set: async function (data) {
        var all = readAll();
        all[name] = all[name] || {};
        all[name][id] = Object.assign({}, clone(data), { _id: id });
        writeAll(all); notify(); return { updated: 1 };
      },
      update: async function (data) {
        var all = readAll();
        all[name] = all[name] || {};
        if (!all[name][id]) throw new Error('document not exists: ' + id);
        Object.assign(all[name][id], clone(data));
        writeAll(all); notify(); return { updated: 1 };
      },
      remove: async function () {
        var all = readAll();
        if (all[name]) delete all[name][id];
        writeAll(all); notify(); return { deleted: 1 };
      },
      watch: function (handlers) {
        watchHandlers.push(handlers);
        return { close: function () {} };
      }
    };
  }

  function makeQuery(name, cond) {
    var st = { cond: cond || {}, skip: 0, limit: 100 };
    var q = {
      where: function (next) { return makeQuery(name, Object.assign({}, st.cond, next)); },
      orderBy: function () { return q; },
      field: function () { return q; },
      limit: function (v) { st.limit = v; return q; },
      skip: function (v) { st.skip = v; return q; },
      get: async function () {
        var rows = tableRows(name).filter(function (d) { return matches(d, st.cond); });
        return { data: rows.slice(st.skip, st.skip + st.limit).map(clone) };
      },
      count: async function () {
        return { total: tableRows(name).filter(function (d) { return matches(d, st.cond); }).length };
      },
      remove: async function () {
        var all = readAll();
        var t = all[name] || {};
        var n = 0;
        Object.keys(t).forEach(function (id) { if (matches(t[id], st.cond)) { delete t[id]; n += 1; } });
        writeAll(all); notify(); return { deleted: n };
      },
      doc: function (id) { return makeDoc(name, id); },
      add: async function (data) {
        var all = readAll();
        all.__seq = (all.__seq || 0) + 1;
        var id = 'auto-' + all.__seq;
        all[name] = all[name] || {};
        all[name][id] = Object.assign({}, clone(data), { _id: id });
        writeAll(all); notify(); return { _id: id };
      },
      watch: function (handlers) {
        watchHandlers.push(handlers);
        return { close: function () {} };
      }
    };
    return q;
  }

  var db = {
    command: {},
    collection: function (name) { return makeQuery(name, {}); }
  };

  window.cloudbase = {
    init: function (config) {
      window.__e2eInitConfig = config;
      return {
        auth: { signInAnonymously: async function () { return { data: { uid: 'anon-e2e' } }; } },
        database: function () { return db; }
      };
    }
  };
  window.__e2eDump = function () { return readAll(); };
  window.__e2eReset = function () { localStorage.removeItem(KEY); };
})();
