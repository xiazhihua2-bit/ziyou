/* ============================================================
 * 跨设备同步 · 网络层验收（src/sync.js 的 transport）
 *
 * 做法：在【本进程内】起一个假的 GitHub Gist 服务（node:http），把 sync.js 的
 * API 根地址指过去，然后用真实 fetch 打它。于是 401 / 403 / 404 / 412 / 429 /
 * 500 / 断网 / ETag(304) / If-Match 乐观锁 这些分支都能被真网络栈覆盖 ——
 * 既不碰真 GitHub，也不需要联网，uitest「断网跑」的原则在这里同样成立。
 *
 * 用法： node tools/test-syncnet.mjs
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name); console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function eq(name, a, b) { ok(name + '  → ' + JSON.stringify(a), JSON.stringify(a) === JSON.stringify(b)); }
function section(t) { console.log('\n' + t); }

/* ============================================================
 * 1. 假 GitHub Gist 服务
 * ============================================================ */
const FILE = 'ziyou-sync.json';
const DESC = '自由 · 跨设备同步数据（请勿公开分享）';

/* 有效令牌表。★ 假服务端必须像真 GitHub 一样对无效令牌回 401，
   否则「错令牌」这条断言会假绿（踩过：最初对任何 Bearer 都回 200）。 */
const VALID_TOKENS = {
  classic_token: { scopes: 'gist' },                       // 经典令牌，只勾 gist
  token_no_gist: { scopes: 'repo, read:user' },            // 有 scope 但没有 gist
  fine_grained_token: { scopes: null },                    // 细粒度：不返回 scopes 头
  t: { scopes: null },                                     // 内存 transport 用
};

const srv = {
  gists: {},            // id -> { id, description, public, files, version, rev, createdAt, updatedAt }
  forced: {},           // 路径前缀 -> 强制状态码（模拟 401/403/500…）
  rateResetAt: null,    // 403 + X-RateLimit-Reset
  requests: [],         // { method, url, headers }
  offline: false,
  conflictOnce: false,  // 下一次 PATCH 故意回 412
  nextId: 1,
};

/* ★ ETag 必须【每次内容变化都变】。
   踩过：最初把 ETag 只挂在 version 上，而测试里另起一台设备推送时 version 恰好又回到同值，
   于是条件请求得到 304、应用误以为「云端没变」——本机改动推不上去。
   真 GitHub 的 ETag 是内容摘要，不会这样；这里用自增的 rev 模拟它的真实行为。 */
function etagOf(g) { return 'W/"fake-' + g.id + '-' + g.rev + '"'; }
function touch(g) { g.rev = (g.rev || 0) + 1; g.updatedAt = new Date().toISOString(); }
function send(res, code, body, headers) {
  if (srv.dropEtag && headers && headers.ETag) { headers = Object.assign({}, headers); delete headers.ETag; }
  const h = Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Expose-Headers': 'ETag, X-RateLimit-Remaining, X-RateLimit-Reset, X-OAuth-Scopes',
  }, headers || {});
  res.writeHead(code, h);
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function gistPayload(g, withContent) {
  const files = {};
  Object.keys(g.files).forEach((k) => {
    files[k] = withContent
      ? { filename: k, content: g.files[k], size: g.files[k].length }
      : { filename: k, size: g.files[k].length };
  });
  return {
    id: g.id, description: g.description, public: g.public, files: files,
    created_at: g.createdAt, updated_at: g.updatedAt,
  };
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    srv.requests.push({ method: req.method, url: req.url, headers: req.headers });

    if (srv.offline) { req.socket.destroy(); return; }

    /* 强制错误码（按路径前缀匹配） */
    for (const key of Object.keys(srv.forced)) {
      if (p.indexOf(key) === 0) {
        const st = srv.forced[key];
        return send(res, st, { message: 'forced ' + st },
          st === 403 && srv.rateResetAt ? { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(srv.rateResetAt) } : {});
      }
    }

    /* 认证：没有 token 或 token 不在有效表里一律 401（与 GitHub 行为一致） */
    const auth = req.headers.authorization || '';
    if (!/^Bearer\s+\S+/.test(auth)) return send(res, 401, { message: 'Requires authentication' });
    const token = auth.replace(/^Bearer\s+/, '');
    if (!VALID_TOKENS[token]) return send(res, 401, { message: 'Bad credentials' });

    if (p === '/user' && req.method === 'GET') {
      const sc = VALID_TOKENS[token].scopes;
      return send(res, 200, { login: 'tester' }, sc ? { 'X-OAuth-Scopes': sc } : {});
    }

    if (p === '/gists' && req.method === 'GET') {
      const items = Object.keys(srv.gists).map((id) => gistPayload(srv.gists[id], false));
      return send(res, 200, items);
    }

    if (p === '/gists' && req.method === 'POST') {
      let payload;
      try { payload = JSON.parse(body); } catch (e) { return send(res, 400, { message: 'bad json' }); }
      const id = 'fake' + (srv.nextId++);
      const g = {
        id, description: payload.description || '', public: payload.public === true,
        files: { [FILE]: (payload.files && payload.files[FILE] && payload.files[FILE].content) || '' },
        version: 1, rev: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      srv.gists[id] = g;
      return send(res, 201, Object.assign(gistPayload(g, true), { version: g.version }), { ETag: etagOf(g) });
    }

    const m = p.match(/^\/gists\/([^/]+)$/);
    if (m) {
      const g = srv.gists[m[1]];
      if (!g) return send(res, 404, { message: 'Not Found' });

      if (req.method === 'GET') {
        const inm = req.headers['if-none-match'];
        if (inm && inm === etagOf(g)) return send(res, 304, undefined, { ETag: etagOf(g) });
        return send(res, 200, Object.assign(gistPayload(g, true), { version: g.version }), { ETag: etagOf(g) });
      }

      if (req.method === 'PATCH') {
        if (srv.conflictOnce) { srv.conflictOnce = false; return send(res, 412, { message: 'Precondition Failed' }); }
        const im = req.headers['if-match'];
        if (im && im !== etagOf(g)) return send(res, 412, { message: 'Precondition Failed' });
        let payload;
        try { payload = JSON.parse(body); } catch (e) { return send(res, 400, { message: 'bad json' }); }
        g.files = {};
        Object.keys(payload.files || {}).forEach((k) => { g.files[k] = payload.files[k].content || ''; });
        if (payload.description) g.description = payload.description;
        /* version 是【文件内容里的字段】，不是 PATCH 的顶层字段 —— 真 GitHub 也只存文件文本。
           从写进去的 JSON 里把它读出来，才和真实存储方式一致。 */
        try {
          const parsed = JSON.parse(g.files[FILE] || '{}');
          if (typeof parsed.version === 'number') g.version = parsed.version;
        } catch (e) { /* 内容不合法就保持原版本号 */ }
        touch(g);
        g.updatedAt = new Date().toISOString();
        return send(res, 200, Object.assign(gistPayload(g, true), { version: g.version }), { ETag: etagOf(g) });
      }

      if (req.method === 'DELETE') { delete srv.gists[m[1]]; return send(res, 204); }
    }

    send(res, 404, { message: 'Not Found' });
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = 'http://127.0.0.1:' + PORT;
console.log('假 Gist 服务已启动：' + BASE);

/* ============================================================
 * 2. 把 sync.js 装进沙箱（需要 fetch / document / XJ.store）
 * ============================================================ */
function makeSandbox() {
  const sb = {
    window: {}, console,
    Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Date,
    parseInt, parseFloat, isNaN, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch, encodeURIComponent, URL, Response, Headers,
    document: { hidden: false, addEventListener() {} },
    location: { protocol: 'https:', href: 'https://example.test/' },
    navigator: {},
  };
  sb.globalThis = sb;
  sb.setTimeout = setTimeout; sb.clearTimeout = clearTimeout;
  vm.createContext(sb);
  for (const f of ['src/util.js', 'src/market.js', 'src/model.js', 'src/transfer.js', 'src/sync-core.js', 'src/sync-transport.js', 'src/sync.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sb, { filename: f });
  }
  return sb;
}

const sb = makeSandbox();
const XJ = sb.window.XJ;
const M = XJ.model, SC = XJ.syncCore, SY = XJ.sync;
SY.setApiBase(BASE);

/** 造一台「设备」：独立 state + 自己的 store 指针 */
function device(deviceId) {
  const s = M.ensureBootstrapped(M.defaultState());
  s.accounts = [{ accountId: 'acc_1', name: '我的账户', type: 'BROKER', sortOrder: 1 }];
  s.settings.defaultAccountId = 'acc_1';
  s.transactions = []; s.received = []; s.symbols = {}; s.snapshots = {};
  SC.meta(s).deviceId = deviceId;
  SC.seedVersions(s);
  return s;
}
function useDevice(s) { XJ.store = { state: s, ui: {} }; return s; }
/** 预建一个云端盒子（等价于 tools/sync-provision.mjs 的活）。
 *  ★ 设备端【没有】建盒入口 —— 这是防「两台设备各连各的盒子、永不互通」的根本办法，
 *    所以这里直接写假服务端，而不是调设备端 API。 */
function seedGist(token, state) {
  const id = 'gist' + (Object.keys(srv.gists).length + 1).toString(16).padStart(4, '0') + 'seed00000000';
  const remote = SC.buildRemote(state, { version: 1 });
  srv.gists[id] = {
    id: id, description: DESC, public: false, version: 1, rev: 1,
    files: { [FILE]: JSON.stringify(remote) },     // ★ 假服务端里 files[k] 存的是内容字符串
  };
  return id;
}
function tx(id, extra) {
  return Object.assign({
    txId: id, accountId: 'acc_1', symbol: 'sh600023', action: 'BUY', date: '2025-03-10',
    quantity: 1000, price: 4, fee: 5, note: '', createdAt: '2025-03-10T01:00:00Z',
  }, extra || {});
}
function resetSrv() {
  srv.gists = {}; srv.forced = {}; srv.requests = []; srv.offline = false;
  srv.conflictOnce = false; srv.rateResetAt = null; srv.dropEtag = false;
  SY.setTransport(null);          // 每段都用真实 HTTP，避免上一段的内存 transport 残留
}

/* ============================================================
 * 3. 令牌 / 权限探测
 * ============================================================ */
section('【1】令牌探测 + 配对落地前校验（preflightPair）');
{
  resetSrv();
  /* 直接在假服务端里放一个盒子（等价于 tools/sync-provision.mjs 干的活：
     设备端【不建盒子】，盒子由外部预建 —— 这是防「两台设备各连各的」的根本办法） */
  const seed = device('dev_SEED');
  seed.transactions.push(tx('t0'));
  const gistId = seedGist('classic_token', seed);

  const bad = await SY.preflightPair({ token: 'wrong', gistId: gistId });
  eq('错令牌 → 拒绝，原因 auth', [bad.ok, bad.reason], [false, 'auth']);

  const fine = await SY.preflightPair({ token: 'fine_grained_token', gistId: gistId });
  eq('细粒度令牌（无 scopes 头）→ 视为通过', fine.ok, true);

  const classic = await SY.preflightPair({ token: 'classic_token', gistId: gistId });
  eq('经典令牌带 gist scope → 通过', classic.ok, true);

  /* ★ 缺 gist 权限必须被挡下来：否则用户会一路配对到推送时才失败 */
  const noGist = await SY.preflightPair({ token: 'token_no_gist', gistId: gistId });
  eq('有 scope 但没有 gist → 如实告知', [noGist.ok, noGist.reason], [false, 'nogist']);
  ok('提示里说清了缺 gist 权限', /gist/.test(noGist.msg || ''), noGist.msg);

  const noBox = await SY.preflightPair({ token: 'classic_token', gistId: 'ffffffffffffffff' });
  eq('盒子不存在 → 明确告知 missing', [noBox.ok, noBox.reason], [false, 'missing']);
}

/* ============================================================
 * 5. push / pull 的基本往返 + ETag 语义
 * ============================================================ */
section('【3】推送与 304（没变就不下载）');
let savedGistId = null;      // 供下一段复用，避免指到别的 Gist 上
{
  resetSrv();
  const A = useDevice(device('dev_A'));
  const made = { gistId: seedGist('classic_token', A) };
  savedGistId = made.gistId;
  SC.meta(A).token = 'classic_token';
  SC.meta(A).gistId = made.gistId;
  SC.meta(A).enabled = true;

  A.transactions.push(tx('t1', { quantity: 500 }));
  SC.diffToOps(A);
  const r1 = await SY.tick({ silent: true });
  if (!r1.ok) console.log('    DEBUG tick 失败：' + JSON.stringify({ reason: r1.reason, lastErr: SC.meta(A).lastErr }));
  eq('第一轮同步成功', r1.ok, true);
  eq('推送了 1 条增量', r1.pushed, 1);
  eq('★ 成功后 outbox 被清空', SC.meta(A).outbox.length, 0);
  ok('云端已存下这份数据', !!srv.gists[made.gistId]);
  ok('云端版本号已递增（单调 +1，写后回读校验可能再推一次）', srv.gists[made.gistId].version > 1, srv.gists[made.gistId].version);

  const before = srv.requests.length;
  const r2 = await SY.tick({ silent: true });
  const after = srv.requests.length;
  eq('第二轮仍成功', r2.ok, true);
  eq('★ 没有新改动 → 一次请求就够（304 早退）', after - before, 1);
  const verAfterFirst = srv.gists[made.gistId].version;
  eq('★ 本地没有待推送时不会写云端', srv.gists[made.gistId].version, verAfterFirst);
  ok('发出去的是 If-None-Match（条件请求）',
    srv.requests[srv.requests.length - 1].headers['if-none-match'] !== undefined);
}

section('【4】第二台设备拉到第一台的改动');
{
  /* ★ 用上一段刚建的那个 gist 的 id，不要用 Object.keys(srv.gists)[0]：
     那个可能指到更早一段留下的 Gist 上，B 就会同步到别处去（踩过）。 */
  const gid = savedGistId;
  const B = useDevice(device('dev_B'));
  SC.meta(B).token = 'classic_token';
  SC.meta(B).gistId = gid;
  SC.meta(B).enabled = true;
  const r = await SY.tick({ silent: true });
  eq('同步成功', r.ok, true);
  eq('★ 拿到了 A 的那笔交易', B.transactions.length, 1);
  eq('★ 数量与 A 一致', B.transactions[0].quantity, 500);
  eq('★ 拉完之后 diff 无回声', SC.diffToOps(B).ops.length, 0);
  eq('★ 也没有多出待推送的改动', SC.meta(B).outbox.length, 0);
}

/* ============================================================
 * 6. 错误分支
 * ============================================================ */
section('【5】401 / 403 限流 / 404 / 500 / 断网');
{
  resetSrv();
  const A = useDevice(device('dev_A'));
  const made = { gistId: seedGist('classic_token', A) };
  SC.meta(A).token = 'classic_token';
  SC.meta(A).gistId = made.gistId;
  SC.meta(A).enabled = true;
  A.transactions.push(tx('t1'));
  SC.diffToOps(A);

  srv.forced['/gists/'] = 401;
  let r = await SY.tick({ silent: true });
  eq('401 → 停止本轮并归类为 auth', [r.ok, r.reason], [false, 'auth']);
  eq('★ 失败原因已记在本机（不静默失败）', SC.meta(A).lastErr.kind, 'auth');
  ok('★ outbox 没被清空（增量不会丢）', SC.meta(A).outbox.length > 0);

  srv.forced['/gists/'] = 403; srv.rateResetAt = Math.floor(Date.now() / 1000) + 3600;
  r = await SY.tick({ silent: true });
  eq('403 限流 → 归类为 rate', [r.ok, r.reason], [false, 'rate']);
  ok('★ 提示里带上了恢复时间（按 X-RateLimit-Reset）',
    /恢复/.test(SC.meta(A).lastErr.msg) || /限流/.test(SC.meta(A).lastErr.msg), SC.meta(A).lastErr);

  /* 下面几例走 force（= 用户手动点「立即同步」）：限流退避只该挡自动轮询，
     不该把手动重试也拦住 —— 否则用户只会以为功能坏了。 */
  srv.forced['/gists/'] = 404;
  r = await SY.tick({ silent: true, force: true });
  eq('404 → 归类为 missing', [r.ok, r.reason], [false, 'missing']);

  srv.forced['/gists/'] = 500;
  r = await SY.tick({ silent: true, force: true });
  eq('500 → 归类为 http', [r.ok, r.reason], [false, 'http']);

  srv.forced = {}; srv.offline = true;
  r = await SY.tick({ silent: true, force: true });
  eq('断网 → 归类为 net', [r.ok, r.reason], [false, 'net']);
  ok('★ 断网也不丢增量', SC.meta(A).outbox.length > 0);
  srv.offline = false;

  eq('★ 退避期间自动轮询不发请求（省配额）',
    (await SY.tick({ silent: true })).reason, 'rate');
  r = await SY.tick({ silent: true, force: true });
  eq('网络恢复后自动补齐', r.ok, true);
  eq('★ 恢复后 outbox 清空', SC.meta(A).outbox.length, 0);
}

/* ============================================================
 * 7. 乐观锁：412 撞车 → 拉回合并 → 重试
 * ============================================================ */
section('【6】412 撞车：拉回合并重试，两端都不丢数据');
{
  resetSrv();
  const A = useDevice(device('dev_A'));
  const made = { gistId: seedGist('classic_token', A) };
  const gid = made.gistId;
  SC.meta(A).token = 'classic_token'; SC.meta(A).gistId = gid; SC.meta(A).enabled = true;

  A.transactions.push(tx('tx_a'));
  SC.diffToOps(A);
  await SY.tick({ silent: true });

  /* B 在 A 之后也写一笔，模拟「两边同时改」 */
  const B = useDevice(device('dev_B'));
  SC.meta(B).token = 'classic_token';
  SC.meta(B).gistId = gid;
  SC.meta(B).enabled = true;
  await SY.tick({ silent: true });
  B.transactions.push(tx('tx_b'));
  SC.diffToOps(B);

  /* 再切回 A 并故意让它的第一次 PATCH 撞车 */
  useDevice(A);
  A.transactions.push(tx('tx_a2'));
  SC.diffToOps(A);
  srv.conflictOnce = true;
  const r = await SY.tick({ silent: true });
  eq('撞车后仍然同步成功', r.ok, true);
  const cloud = JSON.parse(srv.gists[gid].files[FILE]);
  const ids = cloud.snapshot.transactions.map((t) => t.txId).sort();
  ok('★ 云端同时保住了 A 的两笔', ids.indexOf('tx_a') >= 0 && ids.indexOf('tx_a2') >= 0, ids);
  eq('★ outbox 在最终成功后清空', SC.meta(A).outbox.length, 0);
  /* 撞车必然触发一次「拉回 + 重试」，所以请求数一定多于普通的「拉+推」两次 */
  ok('★ 确实走了「拉回合并再重试」这条路', srv.requests.length >= 4, srv.requests.length);
}

/* ============================================================
 * 8. 公开 Gist 必须被拒绝（GitHub 会自动吊销令牌）
 * ============================================================ */
section('【7】公开 Gist 一律拒绝');
{
  resetSrv();
  const A = useDevice(device('dev_A'));
  const made = { gistId: seedGist('classic_token', A) };
  const gid = made.gistId;
  srv.gists[gid].public = true;                 // 人为把它变成公开的
  SC.meta(A).token = 'classic_token';
  SC.meta(A).gistId = gid;
  SC.meta(A).enabled = true;
  const r = await SY.tick({ silent: true });
  eq('★ 检出公开 → 停止同步', [r.ok, r.reason], [false, 'public']);
  eq('★ 原因如实写进状态', SC.meta(A).lastErr.kind, 'public');
}

/* ============================================================
 * 9. 关闭同步 = 零外发（计划里比功能更重要的那条红线）
 * ============================================================ */
section('【8】关闭同步后不得发出任何请求');
{
  resetSrv();
  const A = useDevice(device('dev_A'));
  const made = { gistId: seedGist('classic_token', A) };
  SC.meta(A).token = 'classic_token';
  SC.meta(A).gistId = made.gistId;
  SC.meta(A).enabled = true;
  SC.meta(A).enabled = true;
  await SY.tick({ silent: true });

  SY.stop();
  SC.meta(A).enabled = false;
  const before = srv.requests.length;

  const r1 = await SY.tick({ silent: true });
  eq('tick 直接拒绝执行', [r1.ok, r1.reason], [false, 'off']);
  SY.schedulePush();
  await new Promise((r) => setTimeout(r, 40));
  SY.onVisible();
  await new Promise((r) => setTimeout(r, 60));
  const r2 = await SY.flushNow();
  eq('flushNow 也拒绝', [r2.ok, r2.reason], [false, 'off']);

  eq('★ 关闭后一次请求都没发出', srv.requests.length - before, 0);
  eq('★ isOn() 为假', SY.isOn(), false);
}

/* ============================================================
 * 11. 首屏对齐不会拖死启动（超时兜底）
 * ============================================================ */
section('【10】同步失败不影响本机功能');
{
  resetSrv();
  SY.setTransport(null);
  const A = useDevice(device('dev_A'));
  SC.meta(A).token = 'classic_token';
  SC.meta(A).gistId = 'nonexistent_gist';
  SC.meta(A).enabled = true;
  SY.start();
  A.transactions.push(tx('tx_keep'));
  SC.diffToOps(A);
  const r = await SY.tick({ silent: true });
  eq('同步失败', r.ok, false);
  eq('★ 本机数据完好', A.transactions.length, 1);
  eq('★ 增量仍在 outbox 等下次', SC.meta(A).outbox.length, 1);
  eq('★ 状态里没有成功时间（如实反映没成功过）',
    !SC.meta(A).lastOkAt, true);
}

/* ================================================================
 * 【11】429 / 403-非限流 / ETag 缺失（原实现缺的三条分支）
 * ================================================================ */
section('【11】429 限流 · 403 非限流 · ETag 缺失降级');
{
  /* ---- 11.1 429（现代 GitHub 的限流码；原实现只有 403 分支） ---- */
  resetSrv();
  const A = useDevice(device('dev_A'));
  const gistId = seedGist('classic_token', A);
  SC.meta(A).token = 'classic_token';
  SC.meta(A).gistId = gistId;
  SC.meta(A).enabled = true;
  A.transactions.push(tx('t429'));
  SC.diffToOps(A);
  srv.forced['/gists/'] = 429;
  let r = await SY.tick({ silent: true, force: true });
  eq('429 → 归类为 rate', [r.ok, r.reason], [false, 'rate']);
  ok('★ 提示里带上了恢复时间', /恢复/.test(SC.meta(A).lastErr.msg), SC.meta(A).lastErr.msg);
  eq('★ outbox 未被清空', SC.meta(A).outbox.length > 0, true);

  /* ---- 11.2 403 但不是限流（X-RateLimit-Remaining 还有剩）----
     原实现把一切 403 当限流，于是「权限不足」会被误报成「稍后自动恢复」，
     用户会一直等一个不会发生的自愈。 */
  resetSrv();
  const B = useDevice(device('dev_B'));
  const gidB = seedGist('classic_token', B);
  SC.meta(B).token = 'token_no_gist';        // 有效令牌但没有 gist 权限
  SC.meta(B).gistId = gidB;
  SC.meta(B).enabled = true;
  B.transactions.push(tx('t403'));
  SC.diffToOps(B);
  srv.forced['/gists/'] = 403;              // 不带 X-RateLimit-Remaining: 0
  r = await SY.tick({ silent: true, force: true });
  eq('★ 403（非限流）→ forbidden 而非 rate', [r.ok, r.reason], [false, 'forbidden']);
  ok('提示里说清了是权限问题', /权限/.test(SC.meta(B).lastErr.msg), SC.meta(B).lastErr.msg);

  /* ---- 11.3 ETag 缺失（代理/CDN 剥掉）→ 降级为读-改-写，而不是拒绝同步 ---- */
  resetSrv();
  srv.dropEtag = true;                       // 假开关：让服务端不回 ETag
  const C = useDevice(device('dev_C'));
  const gidC = seedGist('classic_token', C);
  SC.meta(C).token = 'classic_token';
  SC.meta(C).gistId = gidC;
  SC.meta(C).enabled = true;
  C.transactions.push(tx('tNoEtag'));
  SC.diffToOps(C);
  r = await SY.tick({ silent: true });
  eq('★ 没有 ETag 也能同步成功（不拒绝）', r.ok, true);
  eq('★ 本地改动确实上云了', srv.gists[gidC].files[FILE].indexOf('tNoEtag') >= 0, true);
  srv.dropEtag = false;
}

/* ================================================================
 * 【12】verifyPair：配对成功的判定必须是「数据真的对齐了」
 * ================================================================ */
section('【12】verifyPair 六项校验（不以 HTTP 200 当成功）');
{
  resetSrv();
  const A = useDevice(device('dev_P1'));
  const gistId = seedGist('classic_token', A);
  SC.meta(A).token = 'classic_token';
  SC.meta(A).gistId = gistId;
  SC.meta(A).enabled = true;
  SC.meta(A).everPaired = true;             // 假装已完成首次合并
  A.transactions.push(tx('tVP'));
  SC.diffToOps(A);
  const v = await SY.verifyPair();
  eq('全部到位时 verifyPair 通过', v.ok, true);
  ok('返回里带云端版本与账本规模', v.version > 0 && v.ledger > 0, v);

  /* 云端位置不存在时必须明确失败（而不是「看起来成功了」） */
  resetSrv();
  const B = useDevice(device('dev_P2'));
  SC.meta(B).token = 'classic_token';
  SC.meta(B).gistId = 'ffffffffffffffff';
  SC.meta(B).enabled = true;
  const v2 = await SY.verifyPair();
  eq('★ 云端不存在 → verifyPair 失败并给出原因', v2.ok, false);
  ok('失败原因可读', (v2.reasons || []).length > 0, v2.reasons);
}

/* 收尾：必须显式 stop()，否则 start() 建的 60 秒轮询定时器会让 Node 一直不退出 */
SY.stop();
SY.setTransport(null);
server.close();
console.log('\n' + '='.repeat(56));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('失败清单：\n  - ' + failures.join('\n  - '));
  process.exitCode = 1;
} else {
  console.log('全部通过 ✅');
}
console.log('='.repeat(56));
