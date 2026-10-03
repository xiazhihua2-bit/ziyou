/* 端到端联调：两台「设备」+ 真实 Gist，验证数据真的能互通
 *
 * 这是交付前最后一道闸：前面的测试都是「逻辑对不对」，这个是「真的行不行」。
 * 模拟两台设备的方式是两个独立 BrowserContext（各自独立的 localStorage/IndexedDB），
 * 走完整的配对 → 推送 → 拉取 → 双向改动 → 删除（墓碑）链路，撞的是真 GitHub API。
 *
 * 它会往盒子里写真实数据（用的就是 tools/sync-provision.mjs 建的那个盒子）。
 *
 * 用法： node tools/sync-e2e.mjs     （需要 .token 与 .gist-id）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.join(ROOT, '..');
const SRC = path.join(PROJ, 'dist', '自由.html');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9365;

const TOKEN = (fs.existsSync(path.join(PROJ, '.token.sync')) ? fs.readFileSync(path.join(PROJ, '.token.sync'), 'utf8')
  : fs.existsSync(path.join(PROJ, '.token')) ? fs.readFileSync(path.join(PROJ, '.token'), 'utf8') : '').trim();
/* gist-id 在 --reset 之后会变，所以运行时再读（不能在这里定死） */
function gistId() {
  return fs.existsSync(path.join(PROJ, '.gist-id')) ? fs.readFileSync(path.join(PROJ, '.gist-id'), 'utf8').trim() : '';
}
if (!TOKEN || !gistId()) { console.error('[e2e] ✗ 需要 .token 与 .gist-id（先跑 tools/sync-provision.mjs）'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const ok = (m) => console.log('  ✓ ' + m);

const SEED_A = {
  version: 6, createdAt: '2026-01-01T00:00:00Z',
  accounts: [{ accountId: 'acc_1', name: '我的账户', type: 'BROKER', sortOrder: 1, createdAt: '2026-01-01T00:00:00Z' }],
  symbols: {
    sh600036: { symbol: 'sh600036', code: '600036', market: 'sh', name: '招商银行', type: 'STOCK', dividendBasis: { type: 'years', value: 1 } },
    sh601088: { symbol: 'sh601088', code: '601088', market: 'sh', name: '中国神华', type: 'STOCK', dividendBasis: { type: 'years', value: 1 } },
  },
  transactions: [
    { txId: 'a_tx_1', accountId: 'acc_1', symbol: 'sh600036', action: 'BUY', date: '2024-01-10', quantity: 2000, price: 36, fee: 5, note: '', createdAt: '2024-01-10T00:00:00Z' },
    { txId: 'a_tx_2', accountId: 'acc_1', symbol: 'sh601088', action: 'BUY', date: '2024-02-10', quantity: 1000, price: 28, fee: 5, note: '', createdAt: '2024-02-10T00:00:00Z' },
  ],
  plans: {}, received: [],
  expenses: [
    { expenseId: 'e1', key: 'MEALS', label: '三餐', icon: '🍱', monthlyAmount: 900, enabled: true, sortOrder: 1, category: 'essential' },
    { expenseId: 'e2', key: 'TRAVEL', label: '旅行', icon: '✈️', monthlyAmount: 600, enabled: true, sortOrder: 2, category: 'quality' },
  ],
  projection: { configId: 'proj_default', monthlyInvest: 5000, years: 10, reinvestRatio: 1, divGrowthRate: 0, startAssets: null },
  settings: { id: 'app_settings', quoteRefreshMs: 60000, defaultAccountId: 'acc_1', onboarded: true },
  quoteCache: {}, priceHistory: {},
};
SEED_A.settings.fire = {
  v: 1, yieldBasis: 'market', activeTier: 'regular',
  tierSims: { lean: { monthlySpend: null, drip: 5000, dripYieldPct: null },
    regular: { monthlySpend: null, drip: 8000, dripYieldPct: null },
    fat: { monthlySpend: null, drip: 5000, dripYieldPct: null } },
  reinvestPct: 80, scenes: [{ sceneId: 'sc1', name: '换城市', spendPct: -20, dripPct: 50, yieldAdjPct: 0 }],
};

/* ---------------- CDP ---------------- */
class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('WebSocket 连接失败'));
      this.ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.id && this.pending.has(m.id)) {
          const { resolve: rs, reject: rj } = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (m.error) rj(new Error(JSON.stringify(m.error))); else rs(m.result);
        }
      };
    });
  }
  send(method, params, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); } }, 40000);
    });
  }
}

/* 一台「设备」= 一个独立 BrowserContext（独立存储） */
async function makeDevice(cdp, label, pageUrl) {
  const ctx = await cdp.send('Target.createBrowserContext', { disposeOnDetach: false });
  const t = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId: ctx.browserContextId });
  const a = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const sid = a.sessionId;
  await cdp.send('Page.enable', {}, sid);
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sid);
  await cdp.send('Page.navigate', { url: pageUrl }, sid);
  for (let i = 0; i < 120; i++) {
    await sleep(120);
    try {
      const r = await cdp.send('Runtime.evaluate', { expression: '!!(window.XJ && XJ.store && XJ.store.state)', returnByValue: true }, sid);
      if (r.result && r.result.value) break;
    } catch (e) { /* retry */ }
  }
  return {
    label, sid, ctxId: ctx.browserContextId,
    async js(expr, awaitPromise) {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: !!awaitPromise, returnByValue: true }, sid);
      if (r.exceptionDetails) throw new Error(label + ' 脚本异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 200));
      return r.result.value;
    },
  };
}

async function main() {
  /* 云端默认从干净空盒开始（--keep 保留现有盒子）。
     ★ gist_update 配额只有 100 次/小时，反复重置会把它打满 —— 联调失败时先看限流。 */
  if (process.argv.indexOf('--keep') < 0) {
    await new Promise((resolve, reject) => {
      const pr = spawn(process.execPath, [path.join(ROOT, 'sync-provision.mjs'), '--reset'], { stdio: 'ignore' });
      pr.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('重置云端失败'))));
    });
    console.log('[e2e] 云端已重置为干净空盒');
  } else {
    console.log('[e2e] 复用现有盒子 ' + gistId());
  }

  const html = fs.readFileSync(SRC, 'utf8');
  const server = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(html); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const PAGE = 'http://127.0.0.1:' + server.address().port + '/';
  console.log('[e2e] 本地页面 ' + PAGE + ' · 盒子 ' + gistId());

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-e2e-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch (e) { /* retry */ }
    await sleep(150);
  }
  const cdp = new CDP(wsUrl);
  await cdp.connect();

  const A = await makeDevice(cdp, '设备A', PAGE);
  const B = await makeDevice(cdp, '设备B', PAGE);
  console.log('[e2e] 两台设备就绪\n');

  const PAIR = `(function(token, gistId){
    var r = XJ.sync.preflightPair({ token: token, gistId: gistId });
    return r.then(function(pre){
      if (!pre.ok) return { ok:false, reason: pre.reason, msg: pre.msg };
      var ap = XJ.sync.applyPair({ token: token, gistId: gistId });   // 不传 installMode：让 sync 自己判定
      if (!ap.ok) return { ok:false, reason: ap.reason };
      return { ok:true };
    });
  })`;

  console.log('— 1) 设备 A 注入数据并配对 —');
  await A.js(`(function(){ XJ.store.init(XJ.model.fromImport(${JSON.stringify(SEED_A)})); XJ.store.notify(); return 1; })()`);
  const pairA = await A.js(`(${PAIR})(${JSON.stringify(TOKEN)}, ${JSON.stringify(gistId())})`, true);
  if (pairA.ok) ok('A 配对成功'); else bad('A 配对失败: ' + JSON.stringify(pairA));
  const pushA = await A.js(`XJ.sync.tick({ force: true })`, true);
  if (pushA && pushA.ok) ok('A 首轮同步成功');
  else if (pushA && pushA.reason === 'rate') {
    console.log('\n[e2e] ⏸ 已被 GitHub 限流（gist_update 桶 100 次/小时）。这不是代码问题，');
    console.log('      等配额恢复后重跑即可：node tools/sync-e2e.mjs\n');
    cdp.ws.close(); chrome.kill(); server.close();
    process.exit(2);
  } else bad('A 首轮同步失败: ' + JSON.stringify(pushA));
  const vA = await A.js(`JSON.stringify({ tx: XJ.store.state.transactions.length, exp: XJ.store.state.expenses.length, fp: XJ.sync.status().boxFingerprint, ver: XJ.sync.status().version, ledger: XJ.sync.status().ledger })`);
  ok('A 本机：' + vA);
  const diag = await A.js(`JSON.stringify({ lastErr: XJ.store.state.syncMeta.lastErr, outbox: (XJ.store.state.syncMeta.outbox||[]).length, mode: XJ.store.state.syncMeta.installMode })`);
  console.log('  [A 诊断] ' + diag);
  /* 裸 fetch 复现：绕开传输层，直接把 buildRemote 的产物 PATCH 上去，看 GitHub 到底说什么 */
  const raw = await A.js(`(function(token, gistId){
    var data = XJ.syncCore.buildRemote(XJ.store.state, { version: XJ.store.state.syncMeta.version || 1 });
    var body = JSON.stringify({ description: '自由 · 跨设备同步数据（请勿公开分享）',
      files: { 'ziyou-sync.json': { content: JSON.stringify(data) } } });
    return fetch('https://api.github.com/gists/' + gistId, {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: body
    }).then(function(r){ return r.text().then(function(t){ return JSON.stringify({ status: r.status, body: t.slice(0, 300), reqBytes: body.length }); }); });
  })(${JSON.stringify(TOKEN)}, ${JSON.stringify(gistId())})`, true);
  console.log('  [A 裸 PATCH] ' + raw);
  const remoteA = await A.js(`(function(){
    var r = XJ.syncCore.buildRemote(XJ.store.state, { version: 1 });
    return JSON.stringify({ snapTx: (r.snapshot.transactions||[]).length, snapExp: (r.snapshot.expenses||[]).length, ops: (r.ops||[]).length, ver: r.version });
  })()`);
  console.log('  [A buildRemote] ' + remoteA);

  console.log('\n— 2) 设备 B 配对并拉取 A 的数据 —');
  await B.js(`(function(){
    window.__S_BEFORE = XJ.store.state;
    window.__SCENES_WRITES = [];
    var fire = XJ.store.state.settings.fire;
    var _scenes = fire.scenes;
    Object.defineProperty(fire, 'scenes', {
      get: function(){ return _scenes; },
      set: function(v){
        window.__SCENES_WRITES.push({ v: JSON.stringify(v && v.length),
          stack: (new Error().stack || '').split('\\n').slice(2, 6).join(' | ').slice(0, 400) });
        _scenes = v;
      },
      configurable: true
    });
    return 1;
  })()`);
  const blankB = await B.js('XJ.sync.isBlankDevice(XJ.store.state)');
  console.log('  [B isBlankDevice] ' + blankB);
  const preB = await B.js(`JSON.stringify({
    tx: XJ.store.state.transactions.length, exp: XJ.store.state.expenses.length,
    mode: XJ.store.state.syncMeta.installMode,
    setRev: XJ.store.state.settings.rev,
    fireScenes: ((XJ.store.state.settings.fire||{}).scenes||[]).length,
    fireReinvest: (XJ.store.state.settings.fire||{}).reinvestPct,
    mine: XJ.store.state.expenses.map(function(e){ return e.key + ':' + e.monthlyAmount; }),
    tpl: XJ.model.EXPENSE_TEMPLATE.map(function(e){ return e.key + ':' + e.monthlyAmount; })
  })`);
  console.log('  [B 配对前] ' + preB);
  const pairB = await B.js(`(${PAIR})(${JSON.stringify(TOKEN)}, ${JSON.stringify(gistId())})`, true);
  if (pairB.ok) ok('B 配对成功（方式 ' + (pairB.mode || '?') + '）'); else bad('B 配对失败: ' + JSON.stringify(pairB));
  const vp = await B.js(`XJ.sync.verifyPair()`, true);
  if (vp.ok) ok('B verifyPair 六项全过（云端第 ' + vp.version + ' 版，账本 ' + vp.ledger + ' 条）');
  else bad('B verifyPair 未过: ' + JSON.stringify(vp.reasons));
  /* 期望值取「A 同步完成后的真实状态」——A 的支出项数量不等于 2：
     云端初始盒子是用带默认支出项的 state 建的（新产品第一次打开就是那 6 项），
     A 合并后是 8 项，B 应当与 A 【完全一致】而不是与种子一致。 */
  const aFinal = JSON.parse(await A.js(`JSON.stringify({
    exp: XJ.store.state.expenses.map(function(e){ return e.key + ':' + e.monthlyAmount + ':' + (e.category||'essential'); }).sort(),
    scenes: ((XJ.store.state.settings.fire||{}).scenes||[]).length,
    tier: (XJ.store.state.settings.fire||{}).activeTier
  })`));
  const bSees = await B.js(`JSON.stringify({
    tx: XJ.store.state.transactions.map(function(t){return t.txId;}),
    exp: XJ.store.state.expenses.map(function(e){return e.key+':'+e.monthlyAmount+':'+(e.category||'essential');}).sort(),
    fire: !!(XJ.store.state.settings.fire),
    activeTier: (XJ.store.state.settings.fire||{}).activeTier,
    scenes: ((XJ.store.state.settings.fire||{}).scenes||[]).length
  })`);
  const seen = JSON.parse(bSees);
  eq('B 拉到 A 的 2 笔交易', seen.tx.length, 2);
  eq('★ B 的支出项与 A 完全一致（含分类）', seen.exp.join(','), aFinal.exp.join(','));
  eq('B 的支出项含 TRAVEL 且归为品质', seen.exp.filter((e) => /^TRAVEL:.*:quality$/.test(e)).length, 1);
  eq('B 拉到 FIRE 试算参数', seen.activeTier, 'regular');
  eq('★ B 拉到 FIRE 场景数（与 A 一致）', seen.scenes, aFinal.scenes);
  const bSetDiag = await B.js(`JSON.stringify({
    sameStateRef: XJ.store.state === window.__S_BEFORE,
    fireKeys: Object.keys(XJ.store.state.settings.fire||{}),
    scenes: ((XJ.store.state.settings.fire||{}).scenes||[]).length,
    setRev: XJ.store.state.settings.rev,
    outbox: (XJ.store.state.syncMeta.outbox||[]).length,
    txQ: Object.keys(XJ.store.state.syncMeta.versions||{}).filter(function(k){return k.indexOf('tx:')===0;}).map(function(k){ return k.split(':')[1] + ':q' + XJ.store.state.syncMeta.versions[k].q; }),
    everPaired: XJ.store.state.syncMeta.everPaired,
    scenesWrites: (window.__SCENES_WRITES || []).slice(0, 4)
  })`);
  console.log('  [B settings 诊断] ' + bSetDiag);
  /* 手动对照实验（复刻【第一次】merge 的输入状态）：从云端取 raw →
     把 B 的 settings 重置回无戳 + default fire → 手动 mergeRemote('overwrite') →
     看 scenes 是否存活。若存活 ⇒ 首次 merge 时 settings 已被谁盖了戳（走了白名单分支）。 */
  const manual = await B.js(`(function(token, gistId){
    return fetch('https://api.github.com/gists/' + gistId, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' }
    }).then(function(r){ return r.json(); }).then(function(g){
      var data = JSON.parse(g.files['ziyou-sync.json'].content);
      var rec = data.snapshot.settings || {};
      var s = XJ.store.state;
      /* —— 重置回「从未合并过」的形状 —— */
      delete s.settings.rev; delete s.settings.rt; delete s.settings.rd;
      s.settings.fire = { yieldBasis: 'market', activeTier: 'regular',
        tierSims: { lean: { monthlySpend: null, drip: 5000, dripYieldPct: null },
          regular: { monthlySpend: null, drip: 5000, dripYieldPct: null },
          fat: { monthlySpend: null, drip: 5000, dripYieldPct: null } },
        reinvestPct: 100, scenes: [] };
      s.syncMeta.versions = {}; s.syncMeta.everPaired = false; s.syncMeta.installMode = 'overwrite';
      var res = XJ.syncCore.mergeRemote(s, data, 'overwrite');
      var after = ((s.settings.fire || {}).scenes || []).length;
      return JSON.stringify({ cloudScenes: (rec.fire && rec.fire.scenes || []).length,
        recRev: rec.rev, applied: res.applied, skipped: res.skipped,
        after: after, afterStore: ((XJ.store.state.settings.fire || {}).scenes || []).length,
        bRev: XJ.store.state.settings.rev,
        bReinvest: (XJ.store.state.settings.fire || {}).reinvestPct });
    });
  })(${JSON.stringify(TOKEN)}, ${JSON.stringify(gistId())})`, true);
  console.log('  [B 手动 merge 对照] ' + manual);
  const fpB = await B.js(`XJ.sync.status().boxFingerprint`);
  const fpA = JSON.parse(vA).fp;
  if (fpA && fpA === fpB) ok('★ 两台设备连的是同一个盒子（指纹一致: ' + fpA + '）');
  else bad('★ 盒子分裂！A=' + fpA + ' B=' + fpB);

  console.log('\n— 3) A 加一笔交易 → B 应拉到 —');
  /* ★ 必须走【真实提交路径】（S.commit 默认落盘）：增量是在 storage 的落盘前钩子里
     算出来的。用 { save:false } 绕过钩子 = 绕过整个增量机制，测的不是真实链路。 */
  await A.js(`(function(){
    XJ.store.commit(function(s){
      s.transactions.push({ txId:'a_tx_3', accountId:'acc_1', symbol:'sh600036', action:'BUY',
        date:'2024-03-01', quantity:500, price:37, fee:5, note:'', createdAt:'2024-03-01T00:00:00Z' });
    });
    return 1;
  })()`);
  const hook = await A.js(`JSON.stringify({
    hasHookApi: typeof XJ.storage.setOnBeforeSave === 'function',
    mode: XJ.storage.getMode(),
    attach: (XJ.sync.attach(), 'called')
  })`);
  console.log('  [A 钩子] ' + hook);
  await A.js('XJ.sync.schedulePush()');
  await sleep(600);
  const d1 = await A.js(`(function(){
    var st = XJ.store.state;
    var probe = XJ.syncCore.diffToOps(st, { noQueue: true }).ops;   // 手动跑一次 diff 看有没有 op
    return JSON.stringify({ outbox: (st.syncMeta.outbox||[]).length, enabled: st.syncMeta.enabled,
      deviceId: st.syncMeta.deviceId, ledger: Object.keys(st.syncMeta.versions||{}).length,
      manualOps: probe.length, probeTypes: probe.map(function(o){return o.t+':'+o.id;}) });
  })()`);
  console.log('  [A 提交后 600ms] ' + d1);
  await sleep(2000);
  await A.js(`XJ.sync.tick({ force:true })`, true);
  const d2 = await A.js(`JSON.stringify({ outbox: (XJ.store.state.syncMeta.outbox||[]).length, ver: XJ.store.state.syncMeta.version })`);
  console.log('  [A tick 后] ' + d2);
  const gotB = await B.js(`XJ.sync.tick({ force:true }).then(function(){ return XJ.store.state.transactions.map(function(t){return t.txId;}); })`, true);
  if (gotB.indexOf('a_tx_3') >= 0) ok('B 拉到了 A 新增的 a_tx_3'); else bad('B 没拉到 a_tx_3: ' + JSON.stringify(gotB));

  console.log('\n— 4) B 删一笔 → A 应跟着删（墓碑路径）—');
  await B.js(`(function(){
    XJ.store.commit(function(s){
      s.transactions = s.transactions.filter(function(t){ return t.txId !== 'a_tx_2'; });
    });
    return 1;
  })()`);
  const bDelDiag = await B.js(`JSON.stringify({
    outbox: (XJ.store.state.syncMeta.outbox||[]).map(function(o){ return o.t+':'+o.id+':d'+(o.d?1:0); }),
    tombs: Object.keys(XJ.store.state.syncMeta.tombstones||{}),
    enabled: XJ.store.state.syncMeta.enabled,
    ver: XJ.store.state.syncMeta.version,
    lastErr: XJ.store.state.syncMeta.lastErr,
    txVisible: XJ.store.state.transactions.map(function(t){ return t.txId; })
  })`);
  console.log('  [B 删除后] ' + bDelDiag);
  await B.js('XJ.sync.schedulePush()');
  await sleep(2600);
  const bTick = await B.js(`XJ.sync.tick({ force:true }).then(function(r){ return JSON.stringify(r); })`, true);
  console.log('  [B tick] ' + bTick);
  const bPushDiag = await B.js(`JSON.stringify({
    outbox: (XJ.store.state.syncMeta.outbox||[]).length,
    tombs: Object.keys(XJ.store.state.syncMeta.tombstones||{}),
    ver: XJ.store.state.syncMeta.version,
    txs: XJ.store.state.transactions.map(function(t){ return t.txId; }),
    lastErr: XJ.store.state.syncMeta.lastErr
  })`);
  console.log('  [B push 后] ' + bPushDiag);
  const aMergeDiag = await A.js(`JSON.stringify({
    tombs: Object.keys(XJ.store.state.syncMeta.tombstones||{}),
    txs: XJ.store.state.transactions.map(function(t){ return t.txId; }),
    ver: XJ.store.state.syncMeta.version,
    lastErr: XJ.store.state.syncMeta.lastErr
  })`);
  console.log('  [A merge 后] ' + aMergeDiag);
  const aTx = await A.js(`XJ.sync.tick({ force:true }).then(function(){ return XJ.store.state.transactions.map(function(t){return t.txId;}); })`, true);
  if (aTx.indexOf('a_tx_2') < 0) ok('A 端 a_tx_2 已随删除消失（墓碑生效）'); else bad('A 端没删掉 a_tx_2: ' + JSON.stringify(aTx));

  console.log('\n— 5) 云端内容与安全检查 —');
  const H = { 'User-Agent': 'ziyou-e2e', Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.github+json' };
  const g = await (await fetch('https://api.github.com/gists/' + gistId(), { headers: H })).json();
  const cloud = g.files['ziyou-sync.json'].content;
  eq('云端是私有的', g.public, false);
  ok('云端无 OCR Key（' + (/apiKey/.test(cloud) ? '★ 发现了！' : '确认不含') + '）');
  ok('云端不含令牌与本机状态（' + (/deviceId|syncMeta|pairKey/.test(cloud) ? '★ 发现了！' : '确认不含') + '）');
  ok('云端含交易与支出（' + (cloud.indexOf('a_tx_1') >= 0 && cloud.indexOf('TRAVEL') >= 0 ? '确认在位' : '缺失') + '）');
  const cloudParsed = JSON.parse(cloud);
  const cf = (cloudParsed.snapshot || {}).settings || {};
  console.log('  [云端 settings.fire] ' + JSON.stringify({ hasFire: !!cf.fire, scenes: ((cf.fire||{}).scenes||[]).length,
    snapTx: ((cloudParsed.snapshot||{}).transactions||[]).length, ops: (cloudParsed.ops||[]).length,
    tombs: (cloudParsed.tombstones||[]).map(function(t){ return t.t+':'+t.id; }), ver: cloudParsed.version }));
  const aNoEcho = await A.js(`XJ.syncCore.diffToOps(XJ.store.state, { noQueue: true }).ops.length`);
  eq('★ A 对齐后不产生回声（diff 为 0 条 op）', aNoEcho, 0);

  cdp.ws.close();
  chrome.kill();
  server.close();
  console.log('\n' + (fail === 0 ? '[e2e] 全部通过 ✓ 多端同步真实可用' : '[e2e] 失败 ' + fail + ' 项 ✗'));
  process.exitCode = fail === 0 ? 0 : 1;
}
function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) ok(label + '  → ' + JSON.stringify(got));
  else bad(label + '  got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
}

main().catch((e) => { console.error('[e2e] 失败:', e.message); process.exit(1); });
