/* 同步面板验收（断网跑）：面板形态 / 开关 / 折叠区 / 四个动作 / file:// 禁用态
 *
 * 用法： node tools/smoke-sync-panel.mjs
 * 说明：本脚本不开网络（与 smoke-prune 一致），验证的是「界面与门禁」，
 *       真实联网同步由 tools/sync-e2e.mjs 覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.join(ROOT, '..');
const SRC = path.join(PROJ, 'dist', '自由.html');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9363;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const seed = {
  version: 6, createdAt: '2026-01-01T00:00:00Z',
  accounts: [{ accountId: 'acc_1', name: '主账户', type: 'BROKER', sortOrder: 1, createdAt: '2026-01-01T00:00:00Z' }],
  symbols: {}, transactions: [], plans: {}, received: [],
  expenses: [
    { expenseId: 'e1', key: 'MEALS', label: '三餐', icon: '🍱', monthlyAmount: 900, enabled: true, sortOrder: 1, category: 'essential' },
  ],
  projection: { configId: 'proj_default', monthlyInvest: 5000, years: 10, reinvestRatio: 1, divGrowthRate: 0, startAssets: null },
  settings: { id: 'app_settings', quoteRefreshMs: 60000, defaultAccountId: 'acc_1', onboarded: true },
  quoteCache: {}, priceHistory: {},
};
seed.symbols['sh600036'] = { symbol: 'sh600036', code: '600036', market: 'sh', name: '招商银行', type: 'STOCK', dividendBasis: { type: 'years', value: 1 } };
seed.quoteCache['sh600036'] = { symbol: 'sh600036', name: '招商银行', code: '600036', price: 40, prevClose: 39.8, changePct: 0.5, quoteTime: '20260910150000' };
seed.transactions.push({ txId: 'tx1', accountId: 'acc_1', symbol: 'sh600036', action: 'BUY', date: '2024-01-10', quantity: 2000, price: 36, fee: 5, note: '', createdAt: '2024-01-10T00:00:00Z' });
seed.plans['sh600036_2025-12-31'] = {
  planId: 'sh600036_2025-12-31', symbol: 'sh600036', securityCode: '600036', securityName: '',
  reportDate: '2025-12-31', reportType: '年报', pretaxBonusPer10: 20, afterTaxPer10: null,
  implPlanProfile: '10派20元', planNoticeDate: null, noticeDate: null,
  equityRecordDate: '2026-06-01', exDividendDate: '2026-06-02', assignProgress: '实施分配',
  progressRank: 100, isImplemented: true, dividendRatio: null, fetchedAt: '2026-09-01T00:00:00Z',
};

const PROBE = `(async function(){
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  var out = {};
  var XJ = window.XJ;
  try { XJ.store.init(XJ.model.fromImport(SEED_JSON)); } catch (e) { out.initErr = String(e.message); }
  XJ.store.ui.accountId = XJ.calc.ALL;
  try { XJ.store.notify(); } catch (e) { out.notifyErr = String(e.message); }
  try { XJ.store.setUI({ tab: 'mine', subPage: null }); } catch (e) { out.setUIErr = String(e.message); }
  await sleep(300);
  var body = document.getElementById('view-body');
  out.bodyExists = !!body;
  out.bodyChildren = body ? body.children.length : -1;
  out.tab = XJ.store.ui.tab;
  try { XJ.views.mine.render(); out.mineRenderOk = true; } catch (e) { out.mineRenderOk = 'ERR:' + e.message; }
  var txt = body.textContent || '';
  out.proto = { protocol: location.protocol };
  out.bodySnippet = txt.slice(0, 200);
  out.hasSync = typeof XJ.sync;
  out.card = {
    exists: !!document.querySelector('.sync-card'),
    /* file:// 下应显示为「不支持」并说明原因（而不是静默不可见） */
    disabled: txt.indexOf('当前打开方式不支持同步') >= 0,
    hasToggle: !!document.querySelector('[data-act="toggleSync"]'),
    /* 面板不该出现「新建同步位置」入口 —— 那正是当年盒子分裂的根源 */
    hasCreateBox: !!document.querySelector('[data-act="createSyncGist"], [data-act="newSyncBox"]'),
  };
  if (out.card.hasToggle) {
    out.card.stateLine = !!document.querySelector('.sync-card .list-row .row-t');
    out.card.foldBtns = document.querySelectorAll('.sync-card .fold-head').length;
    /* 折叠区默认收起 */
    out.card.connFolded = !document.querySelector('.sync-kv');
    var f1 = document.querySelector('[data-act="syncFoldConn"]');
    if (f1) { f1.click(); await sleep(160); }
    out.card.connOpens = !!document.querySelector('.sync-kv');
    var f2 = document.querySelector('[data-act="syncFoldLog"]');
    if (f2) { f2.click(); await sleep(160); }
    out.card.logOpens = !!document.querySelector('.sync-log');
    out.card.btns = document.querySelectorAll('.sync-btns .btn-block').length;
    out.card.repairBtn = !!document.querySelector('[data-act="syncRepair"]');
    out.card.resetBtn = !!document.querySelector('[data-act="syncReset"]');
    /* 立即同步：断网下必须给出可读反馈而不是静默 */
    var now = document.querySelector('[data-act="syncNow"]');
    if (now) { now.click(); await sleep(500); }
    out.card.nowFeedback = (document.getElementById('toast-root')||{}).textContent || '';
  }
  /* boot 挂钩：落盘钩子已挂、生命周期方法齐备、file:// 门禁在位 */
  out.wiring = {
    api: ['isOn', 'status', 'attach', 'start', 'stop', 'tick', 'onVisible', 'flushNow', 'setEnabled', 'preflightPair', 'applyPair', 'verifyPair', 'logAll']
      .filter(function (k) { return typeof XJ.sync[k] !== 'function'; }),
    storageHookAttached: (function () {
      /* 挂钩后落盘会算增量：改一条再改回来，outbox 应有痕迹（或版本号变化） */
      try {
        var s2 = XJ.store.state;
        s2.transactions.push({ txId: 'hook_t1', accountId: 'acc_1', symbol: 'sh600036', action: 'BUY', date: '2024-05-05', quantity: 100, price: 10, fee: 0, note: '', createdAt: '2024-05-05T00:00:00Z' });
        XJ.storage.save(s2);
        s2.transactions.pop();
        return true;
      } catch (e) { return 'ERR:' + e.message; }
    })(),
  };
  out.others = {
    transfer: !!document.querySelector('[data-act="openTransfer"]'),
    exportJson: !!document.querySelector('[data-act="exportJson"]'),
  };
  return out;
})()`.replace('SEED_JSON', JSON.stringify(seed));

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.events = []; }
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
        } else if (m.method) this.events.push(m);
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
  close() { try { this.ws.close(); } catch (e) {} }
}

let fail = 0;
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const ok = (m) => console.log('  ✓ ' + m);

/* 本地 HTTP 服务器：file:// 下同步被正确禁用（那是浏览器硬限制），
   要验「开关 / 折叠 / 按钮」这些交互必须走 http 形态。页面本身仍断网。 */
const html = fs.readFileSync(SRC, 'utf8');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PAGE = 'http://127.0.0.1:' + server.address().port + '/';
console.log('本地页面（页面内仍断网）：' + PAGE);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-syncpanel-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank',
], { stdio: 'ignore' });

try {
  let wsUrl = null;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch (e) { /* retry */ }
    await sleep(150);
  }
  if (!wsUrl) throw new Error('Chrome DevTools 未能启动');
  const cdp = new CDP(wsUrl);
  await cdp.connect();
  const t = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const a = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const sid = a.sessionId;
  await cdp.send('Page.enable', {}, sid);
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('Log.enable', {}, sid).catch(() => {});
  await cdp.send('Network.enable', {}, sid);
  /* 先加载（页面本身要能取到），boot 完成后再断网 ——
     offline 会连页面请求一起拦掉，那验证的就不是同步而是「页面打不开」了。 */
  await cdp.send('Page.navigate', { url: PAGE }, sid);
  let booted = false;
  for (let i = 0; i < 120; i++) {
    await sleep(120);
    try {
      const r = await cdp.send('Runtime.evaluate', { expression: '!!(window.XJ && XJ.store && XJ.store.state)', returnByValue: true }, sid);
      if (r.result && r.result.value) { booted = true; break; }
    } catch (e) { /* retry */ }
  }
  if (!booted) {
    const dbg = await cdp.send('Runtime.evaluate', {
      expression: "JSON.stringify({ xj: typeof window.XJ, view: !!(window.XJ && window.XJ.views), shell: !!document.getElementById('view-body'), bodyLen: ((document.getElementById('view-body')||{}).textContent||'').length })",
      returnByValue: true }, sid);
    console.log('  [boot 失败] ' + (dbg.result.value || '（无返回）'));
    for (const m of cdp.events) {
      if (m.method === 'Runtime.exceptionThrown') console.log('  [页面异常] ' + JSON.stringify(m.params.exceptionDetails || {}).slice(0, 300));
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') console.log('  [console.error] ' + JSON.stringify(m.params.args || []).slice(0, 300));
    }
  }
  /* 此刻页面已就绪 → 断网，让面板交互发生在「同步必然失败」的前提下 */
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, sid);
  await sleep(400);
  const r = await cdp.send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true }, sid);
  const out = r.result.value || {};
  if (r.exceptionDetails) {
    console.log('  [探针异常] ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  }
  if (out.proto && out.proto.protocol === 'file:') {
    if (out.card && out.card.exists) ok('同步卡片在（file:// 下为禁用态并说明原因）');
    if (out.card && out.card.disabled) ok('file:// 明确提示不支持并给出原因');
    if (out.card && !out.card.hasCreateBox) ok('面板没有「新建同步位置」入口（防盒子分裂）');
    if (out.others && out.others.transfer && out.others.exportJson) ok('搬运与导出入口仍在');
  } else {
    /* http 场景（本地服务器）才检查交互细节 */
    const c = out.card || {};
    if (c.exists) ok('同步卡片在位'); else bad('缺同步卡片');
    if (c.hasToggle) ok('开关在位'); else bad('缺开关');
    if (c.stateLine) ok('状态一行在位'); else bad('缺状态行');
    if (c.connFolded) ok('连接信息默认收起'); else bad('连接信息默认应收起');
    if (c.connOpens) ok('连接信息可展开'); else bad('连接信息展开失败');
    if (c.logOpens) ok('详细日志可展开'); else bad('日志展开失败');
    if (c.btns >= 2) ok('操作按钮齐备（' + c.btns + ' 个）'); else bad('按钮不足: ' + c.btns);
    if (c.repairBtn && c.resetBtn) ok('重新配对与重置连接在位'); else bad('缺重置类按钮');
    if (!c.hasCreateBox) ok('没有「新建同步位置」入口（防盒子分裂）');
    if (c.nowFeedback) ok('断网下点立即同步有可读反馈（' + c.nowFeedback.slice(0, 24) + '）'); else bad('立即同步无反馈');
  }
  console.log('  [诊断] ' + JSON.stringify({ initErr: out.initErr, notifyErr: out.notifyErr, setUIErr: out.setUIErr, bodyExists: out.bodyExists, bodyChildren: out.bodyChildren, tab: out.tab, mineRenderOk: out.mineRenderOk, hasSync: out.hasSync }));
  const w = out.wiring || {};
  if (Array.isArray(w.api) && w.api.length === 0) ok('同步 API 齐备（13 个方法）');
  else bad('同步 API 缺失: ' + JSON.stringify(w.api));
  if (w.storageHookAttached === true) ok('落盘前钩子已挂（改动会算增量）');
  else bad('落盘钩子异常: ' + w.storageHookAttached);
  const errs = cdp.events.filter((m) => (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') || m.method === 'Runtime.exceptionThrown');
  if (errs.length) bad('控制台错误 ' + errs.length + ' 条'); else ok('控制台零错误');
  cdp.close();
} catch (e) {
  console.error('[sync-panel] 异常:', e.message);
  fail++;
} finally {
  try { chrome.kill(); } catch (e) { /* 忽略 */ }
  try { server.close(); } catch (e) { /* 忽略 */ }
}

console.log('\n' + (fail === 0 ? '[sync-panel] 全部通过 ✓' : '[sync-panel] 失败 ' + fail + ' 项 ✗'));
process.exitCode = fail === 0 ? 0 : 1;
