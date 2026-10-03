/* ==================== 跨设备同步 · 传输层 ====================
 * ★ 本文件是「换后端」的唯一改动点：核心同步逻辑（sync.js）与纯逻辑内核
 *   （sync-core.js）都不认识 Gist，只认 transport.{whoami,pull,push} 三个方法。
 *   将来要换成自建中转 / Supabase / 别的云存储，只需在这里换一份实现。
 *
 * 现状实现：GitHub Gist（一个私有 Gist 里的单个 JSON 文件）。
 *   · 实测可行（2026-10-03，tools/sync-cors-probe.mjs）：api.github.com 的 CORS
 *     预检对 PATCH + Authorization + If-Match 完全放行，且 Expose-Headers 含
 *     ETag 与 X-RateLimit-Reset —— 所以浏览器能直连，乐观锁也能用。
 *
 * 设计约束（沿用原实现，都是踩过坑换来的）：
 *   ① token 只放 Authorization header，绝不放 query（query 会被日志与 Referer 记录）
 *   ② pull 用 If-None-Match（省流量，命中 304 就是「无变化」），
 *      push 用 If-Match（乐观锁，撞车返回 412 交给上层合并重试）
 *   ③ 失败时必须把 GitHub 的原话带回去（status + body），界面上要显示它说了什么
 *   ④ 限流要精确退避：读 X-RateLimit-Reset（秒级 epoch），退到那一刻再试
 *   ⑤ etag 缺失（代理/CDN 剥掉）时不报错也不拒绝 —— 退化成「读-改-写」，
 *      宁可可能覆盖一次，也不能彻底不同步
 */
XJ.syncTransport = (function () {
  var U = XJ.util;

  var API = 'https://api.github.com';
  var FILE_NAME = 'ziyou-sync.json';
  var GIST_DESC = '自由 · 跨设备同步数据（请勿公开分享）';
  var TIMEOUT_MS = 15000;

  /** 允许测试把 API 指向进程内的假服务端（tools/test-syncnet.mjs 依赖） */
  function setApiBase(base) {
    API = String(base || 'https://api.github.com').replace(/\/+$/, '');
  }
  function apiBase() { return API; }

  function ghHeaders(token, extra) {
    var h = { 'Accept': 'application/vnd.github+json' };
    if (token) h['Authorization'] = 'Bearer ' + token;
    Object.keys(extra || {}).forEach(function (k) { h[k] = extra[k]; });
    return h;
  }

  function buildFiles(data) {
    var o = {};
    o[FILE_NAME] = { content: JSON.stringify(data) };
    return o;
  }

  function readFile(gist, name) {
    var f = (gist && gist.files && gist.files[name]) || null;
    if (!f) return null;
    return f.truncated === true ? null : (f.content || null);
  }

  /** 超时包装：没有它，慢网络会让界面一直转圈。返回 Promise（不是 {promise}） */
  function fetchJson(url, opts) {
    if (typeof AbortController !== 'function') return fetch(url, opts);
    var ctrl = new AbortController();
    var t = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, TIMEOUT_MS);
    opts.signal = ctrl.signal;
    return fetch(url, opts).then(function (v) { clearTimeout(t); return v; },
      function (e) { clearTimeout(t); throw e; });
  }

  /**
   * 限流判定：GitHub 有两种表达 —— 403 + X-RateLimit-Remaining: 0（老式）
   * 与真正的 429 + Retry-After。两种都要认，否则用户只会看到「写入失败」。
   */
  function rateInfo(status, headers) {
    if (!headers) return { limited: false, waitMs: 0, resetAt: null };
    var remaining = headers.get('x-ratelimit-remaining');
    var reset = U.n0(headers.get('x-ratelimit-reset'));      // 秒级 epoch
    var retry = U.n0(headers.get('retry-after'));            // 相对秒数
    var limited = status === 429 || remaining === '0' || (status === 403 && reset > 0);
    if (!limited) return { limited: false, waitMs: 0, resetAt: null };
    var waitMs = reset > 0
      ? Math.max(0, reset * 1000 - Date.now())
      : (retry > 0 ? retry * 1000 : 0);
    return { limited: true, waitMs: waitMs, resetAt: reset > 0 ? reset * 1000 : null };
  }

  function createGistTransport() {
    return {
      name: 'gist',

      /** 令牌自述：谁 + 有没有 gist 权限 */
      whoami: function (cfg) {
        return fetchJson(API + '/user', { headers: ghHeaders(cfg.token), cache: 'no-store' })
          .then(function (r) {
            return r.json().catch(function () { return null; }).then(function (body) {
              return { status: r.status, scopes: r.headers.get('x-oauth-scopes'), data: body };
            });
          });
      },

      /**
       * 拉取云端文件。
       * cfg.force = true 时无条件重取（412 撞车重试必须走这条：条件请求很可能拿到
       * 304，那样本地就拿不到新的 version 号，重试会继续撞车直到耗尽次数）。
       */
      pull: function (cfg) {
        var headers = ghHeaders(cfg.token, (!cfg.force && cfg.etag) ? { 'If-None-Match': cfg.etag } : {});
        return fetchJson(API + '/gists/' + encodeURIComponent(cfg.gistId), { headers: headers, cache: 'no-store' })
          .then(function (r) {
            var out = {
              status: r.status,
              etag: r.headers.get('etag'),            // ★ 实测 JS 可读（Expose-Headers）
              rateRemaining: r.headers.get('x-ratelimit-remaining'),
              rateReset: r.headers.get('x-ratelimit-reset'),
              scopes: r.headers.get('x-oauth-scopes'),
              rate: rateInfo(r.status, r.headers),
            };
            if (r.status !== 200) {
              return r.json().catch(function () { return null; }).then(function (body) {
                out.data = body;
                return out;
              });
            }
            return r.json().then(function (gist) {
              out.gist = gist;
              out.public = gist.public === true;
              var text = readFile(gist, FILE_NAME);
              if (!text) { out.missing = true; return out; }
              try { out.data = JSON.parse(text); }
              catch (e) { out.corrupt = true; }
              return out;
            });
          });
      },

      /** 写入：etag 为空时不发 If-Match（无条件覆盖），由上层强制先 pull 再写 */
      push: function (cfg) {
        var headers = ghHeaders(cfg.token, { 'Content-Type': 'application/json' });
        if (cfg.etag) headers['If-Match'] = cfg.etag;
        return fetchJson(API + '/gists/' + encodeURIComponent(cfg.gistId), {
          method: 'PATCH', headers: headers,
          body: JSON.stringify({ description: GIST_DESC, files: buildFiles(cfg.data) }),
        }).then(function (r) {
          return r.json().catch(function () { return null; }).then(function (body) {
            return {
              status: r.status, etag: r.headers.get('etag'),
              scopes: r.headers.get('x-oauth-scopes'),
              rateRemaining: r.headers.get('x-ratelimit-remaining'),
              rate: rateInfo(r.status, r.headers),
              data: body,
            };
          });
        });
      },
    };
  }

  return {
    FILE_NAME: FILE_NAME,
    GIST_DESC: GIST_DESC,
    setApiBase: setApiBase,
    apiBase: apiBase,
    create: createGistTransport,
    /* 供测试注入假实现（uitest 断网跑时用） */
    setTransport: function (t) { current = t || createGistTransport(); return current; },
    get: function () { if (!current) current = createGistTransport(); return current; },
  };
  var current = null;
})();
