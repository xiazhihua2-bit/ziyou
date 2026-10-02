/* ==================== 跨设备搬运（不引入任何后端） ====================
 * 目标：手机 ↔ 平板 ↔ 电脑之间搬数据。做法是把精简后的 state 编码成一段字符串，
 * 通过「链接」或「复制文本（走微信/QQ）」传给另一台设备，对方粘贴/打开即导入。
 *
 * 编码格式：`XJ1<mode>.<base64url>`
 *   mode = 'g'  gzip 压缩（浏览器有 CompressionStream 时优先）
 *          'p'  明文 JSON 的 base64url（降级；也是 verify 里可同步复算的路径）
 *   前缀 XJ1 是格式版本号，便于日后演进。
 *
 * 设计约束：
 *   · **纯 JS 实现 UTF-8 ↔ 字节 ↔ base64url**，不依赖 TextEncoder / btoa ——
 *     这样同一份代码在浏览器与 verify 的 Node 沙箱里都能跑，编解码可被独立复算。
 *   · `encodeSync` / `decodeSync` 全同步，供 verify 做完整往返断言；
 *     gzip 路径是异步的，放在 livetest 里用真实 CompressionStream 验。
 *   · **绝不携带 settings.ocr.apiKey** —— 链接会被转发，Key 必须留在本机。
 */
XJ.transfer = (function () {
  var U = XJ.util;
  var PREFIX = 'XJ1';
  var HASH_KEY = '#xjimport=';

  /* ---------------- 纯 JS 编码基建 ---------------- */

  /** 字符串 → UTF-8 字节数组 */
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff) {
        /* 代理对（emoji 等）：合成一个码点再编 4 字节 */
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return out;
  }

  /** UTF-8 字节数组 → 字符串 */
  function bytesUtf8(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length;) {
      var b = bytes[i++];
      if (b < 0x80) {
        s += String.fromCharCode(b);
      } else if (b >= 0xc0 && b < 0xe0) {
        s += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
      } else if (b >= 0xe0 && b < 0xf0) {
        s += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
      } else {
        var cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) |
          ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
        cp -= 0x10000;
        s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      }
    }
    return s;
  }

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  /** 字节数组 → base64url（无填充） */
  function b64url(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      out += B64.charAt(b0 >> 2);
      out += B64.charAt(((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4));
      if (b1 === undefined) break;
      out += B64.charAt(((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6));
      if (b2 === undefined) break;
      out += B64.charAt(b2 & 63);
    }
    return out;
  }

  /** base64url → 字节数组（容忍标准 base64 的 +/ 与 = 填充） */
  function unb64url(s) {
    var str = String(s || '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    var out = [];
    var buf = 0, bits = 0;
    for (var i = 0; i < str.length; i++) {
      var v = B64.indexOf(str.charAt(i));
      if (v < 0) throw new Error('内容含有非法字符，可能复制不完整');
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((buf >> bits) & 0xff);
        /* 必须把已输出的高位清掉，否则下一轮 buf 会带着残留高位继续左移（曾导致解码全错） */
        buf &= (1 << bits) - 1;
      }
    }
    return out;
  }

  /* ---------------- 负载裁剪 ---------------- */

  /**
   * 挑出要搬运的字段。
   * 不传 plans / quoteCache（都能从数据源重新拉），
   * 不传 settings.ocr.apiKey（链接会被转发，Key 必须留在本机）。
   * snapshots 体积最大（不可重建），默认不带，由 opts.withSnapshots 打开。
   */
  function slimState(state, opts) {
    opts = opts || {};
    var s = state || {};
    var settings = {};
    Object.keys(s.settings || {}).forEach(function (k) {
      if (k === 'ocr') return;                       // OCR 设置整体不带（含 Key）
      settings[k] = s.settings[k];
    });
    var out = {
      app: '自由',
      version: s.version,
      transferredAt: U.nowStamp(),
      accounts: s.accounts || [],
      symbols: s.symbols || {},
      transactions: s.transactions || [],
      received: s.received || [],
      expenses: s.expenses || [],
      projection: s.projection || null,
      settings: settings,
    };
    if (opts.withSnapshots) out.snapshots = s.snapshots || {};
    return out;
  }

  /* ---------------- 编码 / 解码 ---------------- */

  /** 同步编码（明文 base64url）—— verify 复算走这条 */
  function encodeSync(obj) {
    return PREFIX + 'p.' + b64url(utf8Bytes(JSON.stringify(obj)));
  }

  /** 同步解码：两种 mode 都支持（gzip 用同步方式解不了，会明确报错） */
  function decodeSync(str) {
    var t = String(str || '').trim();
    if (t.indexOf(PREFIX) !== 0) throw new Error('不是本应用生成的搬运内容');
    var mode = t.charAt(PREFIX.length);
    var body = t.slice(PREFIX.length + 2);
    if (mode === 'g') throw new Error('这是压缩过的内容，请在应用内导入');
    if (mode !== 'p') throw new Error('不认识的搬运格式：' + mode);
    var json = bytesUtf8(unb64url(body));
    var obj = JSON.parse(json);
    if (!obj || typeof obj !== 'object') throw new Error('内容不是有效的对象');
    return obj;
  }

  /** 优先 gzip 编码；环境不支持时静默降级为明文 */
  function encode(obj) {
    var json = JSON.stringify(obj);
    if (typeof CompressionStream !== 'function') {
      return Promise.resolve(encodeSync(obj));
    }
    try {
      var cs = new CompressionStream('gzip');
      var writer = cs.writable.getWriter();
      writer.write(utf8Bytes(json));
      writer.close();
      return new Response(cs.readable).arrayBuffer().then(function (buf) {
        return PREFIX + 'g.' + b64url(new Uint8Array(buf));
      }).catch(function () { return encodeSync(obj); });
    } catch (e) {
      return Promise.resolve(encodeSync(obj));
    }
  }

  /** 解码：自动识别 gzip / 明文 */
  function decode(str) {
    var t = String(str || '').trim();
    if (t.charAt(PREFIX.length) !== 'g') {
      return Promise.resolve(decodeSync(t));
    }
    if (typeof DecompressionStream !== 'function') {
      return Promise.reject(new Error('当前浏览器不支持解压，请在支持的环境导入'));
    }
    var bytes = unb64url(t.slice(PREFIX.length + 2));
    var ds = new DecompressionStream('gzip');
    var writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    return new Response(ds.readable).arrayBuffer().then(function (buf) {
      return JSON.parse(bytesUtf8(new Uint8Array(buf)));
    });
  }

  /* ---------------- 链接互转 ---------------- */

  function buildImportUrl(base, encoded) {
    var b = String(base || '').split('#')[0];
    return b + HASH_KEY + encoded;
  }

  /** 从 location.hash 里取出搬运内容（没有则返回 null） */
  function readImportHash(hash) {
    var h = String(hash || '');
    var i = h.indexOf(HASH_KEY);
    if (i < 0) return null;
    var v = decodeURIComponent(h.slice(i + HASH_KEY.length));
    return v || null;
  }

  /** 清掉地址栏里的搬运内容，避免刷新时反复提示 */
  function clearImportHash(hash) {
    var h = String(hash || '');
    var i = h.indexOf(HASH_KEY);
    return i < 0 ? h : h.slice(0, i);
  }

  /* ---------------- 合并 ---------------- */

  function countOf(obj) { return obj && typeof obj === 'object' ? Object.keys(obj).length : 0; }

  /** 导入前的摘要，用于二次确认 */
  function summarize(incoming) {
    var o = incoming || {};
    return {
      accounts: (o.accounts || []).length,
      symbols: countOf(o.symbols),
      transactions: (o.transactions || []).length,
      received: (o.received || []).length,
      expenses: (o.expenses || []).length,
      snapshots: countOf(o.snapshots),
    };
  }

  /**
   * 把 incoming 合并进 state（就地修改），按业务主键去重：
   *   accounts → accountId · transactions → txId · received → recId
   *   symbols → 按 symbol 键合并（保留本地已有的字段值）· expenses → 按 key
   *   snapshots → 按日期
   * 返回各表新增条数。
   */
  function mergeInto(state, incoming) {
    var o = incoming || {};
    var added = { accounts: 0, symbols: 0, transactions: 0, received: 0, expenses: 0, snapshots: 0 };

    (o.accounts || []).forEach(function (a) {
      if (!a || !a.accountId) return;
      if (state.accounts.some(function (x) { return x.accountId === a.accountId; })) return;
      state.accounts.push(a); added.accounts++;
    });
    Object.keys(o.symbols || {}).forEach(function (sym) {
      var inc = o.symbols[sym];
      if (!inc) return;
      if (!state.symbols[sym]) { state.symbols[sym] = inc; added.symbols++; return; }
      /* 已存在：只补本地缺的字段，不覆盖本地值（本地可能有更完整的名称/口径） */
      Object.keys(inc).forEach(function (k) {
        if (state.symbols[sym][k] === undefined || state.symbols[sym][k] === null) {
          state.symbols[sym][k] = inc[k];
        }
      });
    });
    (o.transactions || []).forEach(function (t) {
      if (!t || !t.txId) return;
      if (state.transactions.some(function (x) { return x.txId === t.txId; })) return;
      state.transactions.push(t); added.transactions++;
    });
    (o.received || []).forEach(function (r) {
      if (!r || !r.recId) return;
      if (state.received.some(function (x) { return x.recId === r.recId; })) return;
      /* 二级去重：同标的 + 同账户 + 同到账日 + 金额相符 也视为同一笔 */
      if (state.received.some(function (x) { return U.sameDividend(x, r); })) return;
      state.received.push(r); added.received++;
    });
    (o.expenses || []).forEach(function (e) {
      if (!e || !e.key) return;
      if (state.expenses.some(function (x) { return x.key === e.key; })) return;
      state.expenses.push(e); added.expenses++;
    });
    Object.keys(o.snapshots || {}).forEach(function (d) {
      if (state.snapshots[d]) return;
      state.snapshots[d] = o.snapshots[d]; added.snapshots++;
    });
    return added;
  }

  /** 覆盖式导入：直接用 incoming 的核心表替换本地（settings 也合并） */
  function overwriteWith(state, incoming) {
    var o = incoming || {};
    if (o.accounts && o.accounts.length) state.accounts = o.accounts;
    if (o.symbols) state.symbols = o.symbols;
    if (o.transactions) state.transactions = o.transactions;
    if (o.received) state.received = o.received;
    if (o.expenses && o.expenses.length) state.expenses = o.expenses;
    if (o.projection) state.projection = Object.assign(state.projection || {}, o.projection);
    if (o.settings) {
      Object.keys(o.settings).forEach(function (k) {
        if (k === 'ocr') return;                     // Key 永不覆盖
        state.settings[k] = o.settings[k];
      });
    }
    if (o.snapshots) state.snapshots = o.snapshots;
    return state;
  }

  return {
    PREFIX: PREFIX,
    HASH_KEY: HASH_KEY,
    utf8Bytes: utf8Bytes, bytesUtf8: bytesUtf8,
    b64url: b64url, unb64url: unb64url,
    slimState: slimState,
    encodeSync: encodeSync, decodeSync: decodeSync,
    encode: encode, decode: decode,
    buildImportUrl: buildImportUrl, readImportHash: readImportHash, clearImportHash: clearImportHash,
    summarize: summarize, mergeInto: mergeInto, overwriteWith: overwriteWith,
  };
})();
