/* ============================================================
 * 深浅双模式截图 + 深色 token 断言（阶段③验收）
 * 用法： node tools/shoot-theme.mjs
 * 产出： shots/theme/{light,dark}-<view>.png + 控制台断言结果
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
const PORT = 9343;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function plan(sym, reportDate, pretax, eq, ex) {
  return {
    planId: sym + '_' + reportDate, symbol: sym, securityCode: sym.slice(2), securityName: '',
    reportDate, reportType: reportDate.slice(5, 7) === '12' ? '年报' : '中报',
    pretaxBonusPer10: pretax, afterTaxPer10: null, implPlanProfile: '10派' + pretax + '元(含税)',
    planNoticeDate: null, noticeDate: null, equityRecordDate: eq, exDividendDate: ex,
    assignProgress: '实施分配', progressRank: 100, isImplemented: true, dividendRatio: null,
    fetchedAt: '2026-09-01T00:00:00Z',
  };
}
const SYMS = ['sh600023', 'sz000858', 'sh600036', 'sh601088'];
const NAMES = ['浙能电力', '五粮液', '招商银行', '中国神华'];
const PRICES = [4.98, 70.48, 45.80, 39.12];
const seed = {
  version: 1, createdAt: '2026-01-01T00:00:00Z',
  accounts: [{ accountId: 'acc_1', name: '主账户', type: 'BROKER', sortOrder: 1, createdAt: '2026-01-01T00:00:00Z' }],
  symbols: {}, transactions: [], plans: {}, received: [],
  expenses: [
    { expenseId: 'exp_phone', key: 'PHONE', label: '话费', monthlyAmount: 100, enabled: true, sortOrder: 1 },
    { expenseId: 'exp_utility', key: 'UTILITY', label: '水电燃气', monthlyAmount: 300, enabled: true, sortOrder: 2 },
    { expenseId: 'exp_lunch', key: 'LUNCH', label: '午餐', monthlyAmount: 600, enabled: true, sortOrder: 3 },
  ],
  projection: { configId: 'proj_default', monthlyInvest: 15000, years: 10, reinvestRatio: 1, divGrowthRate: 0, startAssets: null },
  settings: { id: 'app_settings', quoteRefreshMs: 60000, defaultAccountId: 'acc_1', reminderLeadDays: 3, onboarded: true },
  quoteCache: {},
};
SYMS.forEach((sym, i) => {
  const qty = (i + 1) * 500;
  const A = +(PRICES[i] * 0.06 * 10).toFixed(4);
  seed.symbols[sym] = { symbol: sym, code: sym.slice(2), market: sym.slice(0, 2), name: NAMES[i], type: 'STOCK', updatedAt: '2026-09-01T00:00:00Z' };
  seed.quoteCache[sym] = { symbol: sym, name: NAMES[i], code: sym.slice(2), price: PRICES[i], prevClose: +(PRICES[i] * 1.01).toFixed(2), changePct: i % 2 ? -0.82 : 1.34, quoteTime: '20260910150031' };
  seed.transactions.push({ txId: 'tx_' + i, accountId: 'acc_1', symbol: sym, action: 'BUY', date: '2024-06-15', quantity: qty, price: +(PRICES[i] * 0.88).toFixed(2), fee: 5, note: '', createdAt: '2024-06-15T01:00:00Z' });
  seed.plans[sym + '_2025-12-31'] = plan(sym, '2025-12-31', A, '2026-06-12', '2026-06-13');
  seed.plans[sym + '_2026-06-30'] = plan(sym, '2026-06-30', +(A * 0.4).toFixed(4), '2026-10-1' + i, '2026-10-1' + i);
  seed.received.push({ recId: 'rec_1_' + i, accountId: 'acc_1', symbol: sym, planId: sym + '_2025-12-31', exDividendDate: '2026-06-13', perShareAmount: A / 10, qtyAtRecord: qty, amount: Math.round(qty * A / 10 * 100) / 100, source: 'AUTO', year: 2026, createdAt: '2026-06-13T00:00:00Z' });
});

const VIEWS = {
  overview: "XJ.store.setUI({tab:'overview',subPage:null,floatOpen:false});",
  calendar: "XJ.store.setUI({tab:'calendar',calView:'calendar',subPage:null,floatOpen:false});",
  plan: "XJ.store.setUI({tab:'plan',subPage:null,floatOpen:false});",
  mine: "XJ.store.setUI({tab:'mine',subPage:null,floatOpen:false});",
  analysis: "XJ.store.setUI({tab:'overview',subPage:'analysis',floatOpen:false});",
  sheet: "XJ.store.setUI({tab:'overview',subPage:null,floatOpen:false});document.querySelector('[data-act=\"openAddHolding\"]').click();",
};

const SETUP = `
(function(){
  var XJ = window.XJ;
  XJ.store.init(XJ.model.fromImport(SEED_JSON));
  XJ.store.ui.accountId = XJ.calc.ALL;
  XJ.storage.save(XJ.store.state);
  XJ.store.notify();
  return 'seeded';
})()
`.replace('SEED_JSON', JSON.stringify(seed));

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
        } else if (msg.method) this.events.push(msg);
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-theme-'));
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
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const ok = (m) => console.log('  ✓ ' + m);

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
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
  await browser.send('Page.navigate', { url: pathToFileURL(SRC).href }, sessionId);
  for (let i = 0; i < 120; i++) {
    await sleep(120);
    try {
      const r = await browser.send('Runtime.evaluate', { expression: '!!(window.XJ && XJ.store && XJ.store.state && document.getElementById("view-body"))', returnByValue: true }, sessionId);
      if (r.result && r.result.value) break;
    } catch (e) { /* retry */ }
  }
  await sleep(600);
  await browser.send('Runtime.evaluate', { expression: SETUP, returnByValue: true }, sessionId);
  await sleep(300);

  const SHOT = path.join(PROJ, 'shots', 'theme');
  fs.mkdirSync(SHOT, { recursive: true });

  for (const [mode, scheme] of [['light', 'light'], ['dark', 'dark']]) {
    await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, sessionId);
    await sleep(240);
    /* 深色 token 断言：body 背景色必须随模式切换 */
    const probe = await browser.send('Runtime.evaluate', {
      expression: `(function(){
        var cs = getComputedStyle(document.body);
        var root = getComputedStyle(document.documentElement);
        return { bodyBg: cs.backgroundColor, bg: root.getPropertyValue('--bg').trim(), text: root.getPropertyValue('--text').trim() };
      })()`,
      returnByValue: true,
    }, sessionId);
    const v = probe.result.value;
    console.log('  [' + mode + '] --bg=' + v.bg + ' bodyBg=' + v.bodyBg);
    if (mode === 'dark' && v.bg !== '#0E0E11') bad('深色 --bg token 未生效: ' + v.bg);
    if (mode === 'light' && v.bg !== '#F2F2F7') bad('浅色 --bg token 异常: ' + v.bg);
    for (const [name, action] of Object.entries(VIEWS)) {
      await browser.send('Runtime.evaluate', { expression: action }, sessionId);
      await sleep(name === 'sheet' ? 500 : 380);
      const s = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      fs.writeFileSync(path.join(SHOT, mode + '-' + name + '.png'), Buffer.from(s.data, 'base64'));
    }
    await browser.send('Runtime.evaluate', { expression: 'XJ.ui.closeSheet()' }, sessionId);
    ok(mode + ' 截图 x' + Object.keys(VIEWS).length + ' -> shots/theme/');
  }
  /* 控制台错误 */
  const errs = browser.events.filter((m) => (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') || m.method === 'Runtime.exceptionThrown');
  if (errs.length) bad('控制台错误 ' + errs.length + ' 条');
  else ok('全程控制台零错误');
  console.log(fail === 0 ? '\n[theme] 全部通过 ✓' : '\n[theme] 失败 ' + fail + ' 项 ✗');
  process.exitCode = fail === 0 ? 0 : 1;
} catch (e) {
  console.error('[theme] 异常:', e);
  process.exitCode = 1;
} finally {
  try { chrome.kill(); } catch (e) { /* 忽略 */ }
}
