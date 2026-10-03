/* ============================================================
 * 阶段①裁剪冒烟测试：删同步后页面必须照常工作
 * 用法： node tools/smoke-prune.mjs
 * 检查：boot 正常 / 四 Tab 渲染 / mine 页无同步入口 / 搬运与导入导出可用 / 产物无同步字符串
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.join(ROOT, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SRC = path.join(PROJ, 'dist', '自由.html');
const PORT = 9341;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 精简种子 ---------------- */
function plan(sym, reportDate, pretax, eq, ex) {
  return {
    planId: sym + '_' + reportDate, symbol: sym, securityCode: sym.slice(2), securityName: '',
    reportDate, reportType: reportDate.slice(5, 7) === '12' ? '年报' : '中报',
    pretaxBonusPer10: pretax, afterTaxPer10: null,
    implPlanProfile: '10派' + pretax + '元(含税)',
    planNoticeDate: null, noticeDate: null, equityRecordDate: eq, exDividendDate: ex,
    assignProgress: '实施分配', progressRank: 100, isImplemented: true, dividendRatio: null,
    fetchedAt: '2026-09-01T00:00:00Z',
  };
}
const SYMS = ['sh600023', 'sz000858', 'sh600036'];
const NAMES = ['浙能电力', '五粮液', '招商银行'];
const PRICES = [4.98, 70.48, 45.80];
const seed = {
  version: 1, createdAt: '2026-01-01T00:00:00Z',
  accounts: [
    { accountId: 'acc_1', name: '主账户', type: 'BROKER', sortOrder: 1, createdAt: '2026-01-01T00:00:00Z' },
  ],
  symbols: {}, transactions: [], plans: {}, received: [],
  expenses: [
    { expenseId: 'exp_phone', key: 'PHONE', label: '话费', monthlyAmount: 100, enabled: true, sortOrder: 1 },
  ],
  projection: { configId: 'proj_default', monthlyInvest: 15000, years: 10, reinvestRatio: 1, divGrowthRate: 0, startAssets: null },
  settings: {
    id: 'app_settings', quoteRefreshMs: 60000,
    defaultAccountId: 'acc_1', reminderLeadDays: 3, onboarded: true,
  },
  quoteCache: {},
};
SYMS.forEach((sym, i) => {
  const qty = (i + 1) * 500;
  const A = +(PRICES[i] * 0.06 * 10).toFixed(4);
  seed.symbols[sym] = { symbol: sym, code: sym.slice(2), market: sym.slice(0, 2), name: NAMES[i], type: 'STOCK', updatedAt: '2026-09-01T00:00:00Z' };
  seed.quoteCache[sym] = { symbol: sym, name: NAMES[i], code: sym.slice(2), price: PRICES[i], prevClose: +(PRICES[i] * 1.01).toFixed(2), changePct: 1.34, quoteTime: '20260910150031' };
  seed.transactions.push({
    txId: 'tx_' + i, accountId: 'acc_1', symbol: sym, action: 'BUY',
    date: '2024-06-15', quantity: qty, price: +(PRICES[i] * 0.88).toFixed(2), fee: 5, note: '',
    createdAt: '2024-06-15T01:00:00Z',
  });
  seed.plans[sym + '_2025-12-31'] = plan(sym, '2025-12-31', A, '2026-06-12', '2026-06-13');
  seed.received.push({
    recId: 'rec_1_' + i, accountId: 'acc_1', symbol: sym, planId: sym + '_2025-12-31',
    exDividendDate: '2026-06-13', perShareAmount: A / 10, qtyAtRecord: qty,
    amount: Math.round(qty * A / 10 * 100) / 100, source: 'AUTO', year: 2026,
    createdAt: '2026-06-13T00:00:00Z',
  });
});

/* ---------------- 页内探针 ---------------- */
const PROBE = `
(async function(){
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  var out = {};
  var XJ = window.XJ;
  out.boot = !!(XJ && XJ.store && XJ.store.state);
  if (!out.boot) { out.fatal = 'app 未启动'; return out; }

  XJ.store.init(XJ.model.fromImport(SEED_JSON));
  XJ.store.ui.accountId = XJ.calc.ALL;
  XJ.store.notify();

  out.tabs = {};
  ['overview','calendar','find','mine'].forEach(function(t){
    XJ.store.setUI({ tab: t, subPage: null });
    var body = document.getElementById('view-body');
    out.tabs[t] = { nodes: body.children.length, textLen: (body.textContent||'').trim().length };
  });

  /* mine 页：同步入口必须已删，搬运/导入导出必须还在 */
  XJ.store.setUI({ tab: 'mine', subPage: null });
  out.mine = {
    syncCard: !!document.querySelector('.sync-card'),
    syncToggle: !!document.querySelector('[data-act="toggleSync"]'),
    syncDisabled: ((document.getElementById('view-body')||{}).textContent || '').indexOf('当前打开方式不支持同步') >= 0,
    exportJson: !!document.querySelector('[data-act="exportJson"]'),
    importJson: !!document.querySelector('[data-act="importJson"]'),
    openTransfer: !!document.querySelector('[data-act="openTransfer"]'),
    exportCsvTx: !!document.querySelector('[data-act="exportCsvTx"]'),
    exportCsvRec: !!document.querySelector('[data-act="exportCsvRec"]'),
    syncWord: (document.getElementById('view-body').textContent||'').indexOf('跨设备同步') >= 0,
  };

  /* 个股详情 + 添加持仓 + 搬运弹层可打开 */
  try {
    XJ.store.setUI({ tab: 'overview', subPage: 'symbol', subArg: 'sh600023', floatOpen: false });
    out.symbolPage = { textLen: (document.getElementById('view-body').textContent||'').trim().length,
      costYield: (document.getElementById('view-body').textContent||'').indexOf('成本息率') >= 0 };
    XJ.store.setUI({ tab: 'overview', subPage: null });
    document.querySelector('[data-act="openAddHolding"]').click();
    out.addHolding = { opened: !!document.querySelector('.sheet') };
    XJ.ui.closeSheet();
    XJ.store.setUI({ tab: 'mine', subPage: null });
    document.querySelector('[data-act="openTransfer"]').click();
    await sleep(360);
    out.transfer = { opened: !!document.querySelector('.sheet'),
      hasXferOut: !!document.querySelector('[data-act="xferLink"]') };
    XJ.ui.closeSheet();
  } catch (e) { out.sheetError = String(e && e.message); }

  /* 数字复算：summary 可用 */
  try {
    var s = XJ.calc.summary(XJ.store.state, XJ.calc.ALL);
    out.numbers = { holdings: s.count, mv: Math.round(s.totalMarketValue), costYield: s.costYield };
  } catch (e) { out.numbersError = String(e && e.message); }

  return out;
})()
`.replace('SEED_JSON', JSON.stringify(seed));

/* ---------------- CDP 极简客户端（同 uitest） ---------------- */
class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.events = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('WebSocket 连接失败'));
      this.ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: rs, reject: rj } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rj(new Error(JSON.stringify(msg.error))); else rs(msg.result);
        } else if (msg.method) {
          this.events.push(msg);
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
  close() { try { this.ws.close(); } catch (e) {} }
}

/* ---------------- 启动 ---------------- */
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-smoke-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
  '--allow-file-access-from-files', '--hide-scrollbars', '--mute-audio',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank',
], { stdio: 'ignore' });

async function waitForDevtools() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch (e) { /* retry */ }
    await sleep(150);
  }
  throw new Error('Chrome DevTools 未能启动');
}

let fail = 0;
function bad(msg) { fail++; console.log('  ✗ ' + msg); }
function ok(msg) { console.log('  ✓ ' + msg); }

try {
  const wsUrl = await waitForDevtools();
  const browser = new CDP(wsUrl);
  await browser.connect();
  const t = await browser.send('Target.createTarget', { url: 'about:blank' });
  const a = await browser.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const sessionId = a.sessionId;
  await browser.send('Page.enable', {}, sessionId);
  await browser.send('Runtime.enable', {}, sessionId);
  await browser.send('Network.enable', {}, sessionId);
  await browser.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, sessionId);

  await browser.send('Page.navigate', { url: pathToFileURL(SRC).href }, sessionId);
  let ready = false;
  for (let i = 0; i < 120; i++) {
    await sleep(120);
    try {
      const r = await browser.send('Runtime.evaluate', {
        expression: '!!(window.XJ && XJ.store && XJ.store.state && document.getElementById("view-body"))',
        returnByValue: true,
      }, sessionId);
      if (r.result && r.result.value) { ready = true; break; }
    } catch (e) { /* retry */ }
  }
  if (!ready) bad('应用未在 15s 内就绪');
  await sleep(800);

  const r = await browser.send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true }, sessionId);
  const out = r.result.value || {};

  /* 控制台与未捕获异常 */
  const consoleErrors = browser.events.filter((m) =>
    (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') ||
    m.method === 'Runtime.exceptionThrown');
  if (consoleErrors.length) bad('控制台错误 ' + consoleErrors.length + ' 条: ' +
    consoleErrors.slice(0, 3).map((m) => JSON.stringify(m.params).slice(0, 200)).join(' | '));
  else ok('控制台零错误（断网全流程）');

  if (out.fatal) bad(out.fatal);
  else {
    ok('boot 正常');
    ['overview', 'calendar', 'find', 'mine'].forEach((t) => {
      const tb = out.tabs && out.tabs[t];
      if (tb && tb.nodes > 0 && tb.textLen > 40) ok('Tab ' + t + ' 渲染 (' + tb.nodes + ' 块, ' + tb.textLen + ' 字)');
      else bad('Tab ' + t + ' 渲染异常: ' + JSON.stringify(tb));
    });
    const m = out.mine || {};
    /* 同步已接回：mine 页必须有同步入口（开关 + 状态行） */
    if (m.syncCard) ok('mine 页同步卡片在位');
    else bad('mine 页缺同步卡片: ' + JSON.stringify(m));
    /* 冒烟跑在 file:// 下：同步卡片应显示为「不支持」并说明原因，而不是静默不可见 */
    if (m.syncToggle || m.syncDisabled) ok('mine 页同步卡片按环境正确呈现（file:// 下为禁用态）');
    else bad('mine 页同步卡片异常: ' + JSON.stringify(m));
    ['exportJson', 'importJson', 'openTransfer', 'exportCsvTx', 'exportCsvRec'].forEach((k) => {
      if (m[k]) ok('mine 页 ' + k + ' 在'); else bad('mine 页缺 ' + k);
    });
    if (out.symbolPage && out.symbolPage.textLen > 100) ok('个股详情页渲染 (' + out.symbolPage.textLen + ' 字)');
    else bad('个股详情页渲染异常: ' + JSON.stringify(out.symbolPage));
    if (out.symbolPage && out.symbolPage.costYield) ok('个股页成本息率保留（用户决策）');
    else bad('个股页成本息率缺失');
    if (out.addHolding && out.addHolding.opened) ok('添加持仓弹层可打开'); else bad('添加持仓弹层打不开: ' + JSON.stringify(out.addHolding));
    if (out.transfer && out.transfer.opened && out.transfer.hasXferOut) ok('搬运弹层可打开且含导出动作'); else bad('搬运弹层异常: ' + JSON.stringify(out.transfer));
    if (out.sheetError) bad('弹层流程报错: ' + out.sheetError);
    if (out.numbers && out.numbers.holdings === 3 && out.numbers.mv > 0) ok('summary 复算正常: ' + JSON.stringify(out.numbers));
    else bad('summary 异常: ' + JSON.stringify(out.numbers || out.numbersError));
  }

  /* 产物检查（语义已反转）：同步层【必须在场】，密钥材料【必须不在场】 */
  const html = fs.readFileSync(SRC, 'utf8');
  [
    ['XJ.syncCore', '同步内核已打包'],
    ['XJ.sync.', '同步编排层已打包'],
    ['XJ.syncTransport', '传输层已打包（换后端的唯一改动点）'],
    ['data-act="toggleSync"', '同步开关已渲染'],
    ['#xjsync=', '配对链接键已打包'],
    ['当前打开方式不支持同步', 'file:// 禁用提示'],
  ].forEach(([w, why]) => {
    if (html.indexOf(w) >= 0) ok(why); else bad('产物缺: ' + w + '（' + why + '）');
  });
  [
    ['XJ.qr', '二维码模块不该回来（本方案点链接，不用扫码）'],
    ['ghp_', '★ 产物绝不能含 GitHub 令牌字面量'],
    ['github_pat_', '★ 同上（细粒度令牌前缀）'],
  ].forEach(([w, why]) => {
    if (html.indexOf(w) >= 0) bad(why + '：' + w); else ok('产物无 "' + w + '"');
  });

  console.log(fail === 0 ? '\n[smoke] 全部通过 ✓' : '\n[smoke] 失败 ' + fail + ' 项 ✗');
  process.exitCode = fail === 0 ? 0 : 1;
} catch (e) {
  console.error('[smoke] 异常:', e);
  process.exitCode = 1;
} finally {
  try { chrome.kill(); } catch (e) { /* 忽略 */ }
}
