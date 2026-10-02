/* ==================== 存储适配器 ====================
 * 单文档存储：整份 state 作为一个记录存取，天然原子。
 * 优先 IndexedDB；在 file:// 等场景被浏览器禁用时自动降级 localStorage。
 */
XJ.storage = (function () {
  var DB_NAME = 'xiji_app';
  var STORE = 'kv';
  var KEY = 'state';
  var LS_KEY = 'xiji_state_v1';

  var mode = null;      // 'idb' | 'ls'
  var db = null;
  var saveTimer = null;
  var lastError = null;

  /* 落盘前的钩子槽。同步层（src/sync.js）会把它挂上，用来在「与 state 同一次写入」里
     把本轮变更算成增量 op —— 单文档整份写入天然原子，所以 op 与数据不可能写一半。
     ★ storage 本身【不认识】sync，方向始终是 sync → storage，不会成环。
     钩子必须同步且不能抛：任何异常都不该阻断本地保存。 */
  var onBeforeSave = null;
  function runHook(state) {
    if (typeof onBeforeSave !== 'function') return;
    try { onBeforeSave(state); } catch (e) { console.error('[sync] beforeSave', e); }
  }

  function openIdb() {
    return new Promise(function (resolve) {
      if (typeof indexedDB === 'undefined' || !indexedDB) return resolve(null);
      var settled = false;
      var req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { return resolve(null); }
      if (!req) return resolve(null);
      function done(v) { if (!settled) { settled = true; resolve(v); } }
      req.onupgradeneeded = function () {
        try {
          var d = req.result;
          if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
        } catch (e) {}
      };
      req.onsuccess = function () { done(req.result); };
      req.onerror = function () { done(null); };
      req.onblocked = function () { done(null); };
      setTimeout(function () { done(null); }, 3000);
    });
  }

  /** 真实读写探测：部分浏览器 file:// 下 open 成功但 put 抛 SecurityError */
  function probe(d) {
    return new Promise(function (resolve) {
      try {
        var tx = d.transaction(STORE, 'readwrite');
        var st = tx.objectStore(STORE);
        var r = st.put('1', '__probe__');
        r.onsuccess = function () {
          try { st.delete('__probe__'); } catch (e) {}
          resolve(true);
        };
        r.onerror = function () { resolve(false); };
        tx.onabort = function () { resolve(false); };
      } catch (e) { resolve(false); }
      setTimeout(function () { resolve(false); }, 2500);
    });
  }

  function lsAvailable() {
    try {
      var k = '__xj_probe__';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  }

  function idbGet() {
    return new Promise(function (resolve, reject) {
      try {
        var tx = db.transaction(STORE, 'readonly');
        var r = tx.objectStore(STORE).get(KEY);
        r.onsuccess = function () { resolve(r.result || null); };
        r.onerror = function () { reject(r.error); };
      } catch (e) { reject(e); }
    });
  }

  function idbPut(val) {
    return new Promise(function (resolve, reject) {
      try {
        var tx = db.transaction(STORE, 'readwrite');
        var r = tx.objectStore(STORE).put(val, KEY);
        r.onsuccess = function () { resolve(true); };
        r.onerror = function () { reject(r.error); };
        tx.onabort = function () { reject(new Error('tx abort')); };
      } catch (e) { reject(e); }
    });
  }

  function idbDel() {
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(KEY);
        tx.oncomplete = function () { resolve(true); };
        tx.onabort = function () { resolve(false); };
      } catch (e) { resolve(false); }
    });
  }

  function init() {
    return openIdb().then(function (d) {
      if (!d) { mode = lsAvailable() ? 'ls' : 'none'; return mode; }
      db = d;
      return probe(d).then(function (ok) {
        if (ok) { mode = 'idb'; return 'idb'; }
        db = null;
        mode = lsAvailable() ? 'ls' : 'none';
        return mode;
      });
    }).catch(function (e) {
      // 任何异常都不应阻断启动：一律降级到 localStorage
      lastError = e;
      db = null;
      mode = lsAvailable() ? 'ls' : 'none';
      return mode;
    });
  }

  function load() {
    if (mode === 'idb') {
      return idbGet().then(function (v) { return v || null; })
        .catch(function (e) { lastError = e; return lsRead(); });
    }
    return Promise.resolve(lsRead());
  }

  function lsRead() {
    try {
      var raw = window.localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { lastError = e; return null; }
  }

  function save(state) {
    runHook(state);
    if (mode === 'idb') {
      return idbPut(state).catch(function (e) {
        lastError = e;
        // 写入失败即时降级，保证数据不丢
        mode = lsAvailable() ? 'ls' : 'none';
        return lsWrite(state);
      });
    }
    return Promise.resolve(lsWrite(state));
  }

  function lsWrite(state) {
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      lastError = e;
      if (XJ.ui && XJ.ui.toast) XJ.ui.toast('保存失败：浏览器存储已满或被禁用');
      return false;
    }
  }

  /** 节流保存：避免高频编辑时反复写盘 */
  function saveSoon(state, delay) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveTimer = null; save(state); }, delay === undefined ? 250 : delay);
  }

  function clear() {
    if (mode === 'idb') return idbDel().then(function () { try { window.localStorage.removeItem(LS_KEY); } catch (e) {} return true; });
    try { window.localStorage.removeItem(LS_KEY); } catch (e) {}
    return Promise.resolve(true);
  }

  return {
    init: init,
    load: load,
    save: save,
    saveSoon: saveSoon,
    clear: clear,
    /** 注册「落盘前」钩子（同步层用）。传 null 可摘除。 */
    setOnBeforeSave: function (fn) { onBeforeSave = typeof fn === 'function' ? fn : null; },
    getMode: function () { return mode; },
    getLastError: function () { return lastError; },
    modeLabel: function () { return mode === 'idb' ? 'IndexedDB' : mode === 'ls' ? '浏览器本地存储' : '不可用'; },
  };
})();
