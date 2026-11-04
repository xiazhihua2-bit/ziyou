/* 股息率分位 / 自选实时息率 CDP 验收：\n * ① 自选 A股行 = 「息 x.xx% + 分位 N」，ETF/港股/美股不显示；\n * ② 详情页分位区块（大数字 / 3·5·10 年切换 / 区间 / 样本）；\n * ③ 持仓卡「股价息」格的分位徽标。\n * 断网跑：数据全部来自种子，不依赖行情源。\n * 用法： node tools/shoot-yieldpct.mjs\n */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.join(ROOT, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SRC = path.join(PROJ, 'dist', '自由.html');
const PORT = 9361;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const today = new Date();
const todayStr = iso(today);

const symRec = (sym, name) => ({ symbol: sym, code: sym.slice(2), market: sym.slice(0, 2), name, type: 'STOCK', updatedAt: '2026-01-01T00:00:00Z' });
const plan = (sym, reportDate, per10, notice, implemented) => ({
  planId: sym + '_' + reportDate, symbol: sym, reportDate,
  reportType: String(reportDate).slice(5, 7) === '12' ? '年报' : '中报',
  pretaxBonusPer10: per10, afterTaxPer10: null, implPlanProfile: '10派' + per10 + '元(含税)',
  planNoticeDate: notice, noticeDate: null, equityRecordDate: null, exDividendDate: null,
  assignProgress: implemented === false ? '董事会预案' : '实施分配',
  progressRank: implemented === false ? 60 : 100, isImplemented: implemented !== false,
});

/* 700 天收盘：正弦波动 → 当前价落在中位附近，分位应≈50 */
const closes = [];
for (let i = 699; i >= 0; i--) {
  const d = new Date(today.getTime() - i * 86400000);
  const price = 6 + 0.8 * Math.sin(i / 40);
  closes.push([iso(d), Math.round(price * 100) / 100]);
}

const closes2 = [];
for (let i = 699; i >= 0; i--) {
  const d = new Date(today.getTime() - i * 86400000);
  const price = 41 + 3 * Math.sin(i / 40);
  closes2.push([iso(d), Math.round(price * 100) / 100]);
}

const seed = {
  version: 6, createdAt: '2026-01-01T00:00:00Z',
  accounts: [{ accountId: 'acc_1', name: '主账户', type: 'BROKER', sortOrder: 1, createdAt: '2026-01-01T00:00:00Z' }],
  symbols: {
    sh601398: symRec('sh601398', '工商银行'), sh600036: symRec('sh600036', '招商银行'),
    sh510880: symRec('sh510880', '红利ETF'), hk00700: symRec('hk00700', '腾讯控股'), usAAPL: symRec('usAAPL', '苹果'),
    /* 601288：有方案、没有日线 → 验「取数失败不锁死 + 冷却后可重试」；301999：只有 30 天日线 → 验「样本不足」 */
    sh601288: symRec('sh601288', '农业银行'), sz301999: symRec('sz301999', '次新股'),
  },
  transactions: [
    { txId: 'tx_1', accountId: 'acc_1', symbol: 'sh600036', action: 'BUY', date: '2024-01-10', quantity: 2000, price: 33, fee: 5, note: '', createdAt: '2024-01-10T00:00:00Z' },
  ],
  /* state.plans 是按 planId 索引的对象（不是按 symbol），plansOf 靠 p.symbol 过滤 */
  plans: {
    sh601398_a: plan('sh601398', '2024-12-31', 30, '2025-06-20'),
    sh601398_b: plan('sh601398', '2025-12-31', 30, '2026-06-20', false),
    sh600036_a: plan('sh600036', '2024-12-31', 20, '2025-07-10'),
    sh600036_b: plan('sh600036', '2025-12-31', 22, '2026-07-10', false),
    sh601288_a: plan('sh601288', '2024-12-31', 25, '2025-06-15'),
    sh601288_b: plan('sh601288', '2025-12-31', 26, '2026-06-15', false),
    sz301999_a: plan('sz301999', '2024-12-31', 10, '2025-06-01'),
    sz301999_b: plan('sz301999', '2025-12-31', 12, '2026-06-01', false),
  },
  received: [],
  expenses: [{ expenseId: 'e1', key: 'MEALS', label: '三餐', icon: '🍱', monthlyAmount: 600, enabled: true, sortOrder: 1, category: 'essential' }],
  projection: { configId: 'proj_default', monthlyInvest: 5000, years: 10, reinvestRatio: 1, divGrowthRate: 0, startAssets: null },
  settings: { id: 'app_settings', quoteRefreshMs: 60000, defaultAccountId: 'acc_1', onboarded: true },
  watchlist: {
    groups: [{ groupId: 'wlg_cn', name: 'A股', sortOrder: 1, createdAt: '2026-01-01T00:00:00Z' }],
    items: [
      { itemId: 'wli_1', groupId: 'wlg_cn', symbol: 'sh601398', addedAt: '2026-01-02T00:00:00Z' },
      { itemId: 'wli_2', groupId: 'wlg_cn', symbol: 'sh510880', addedAt: '2026-01-03T00:00:00Z' },
      { itemId: 'wli_3', groupId: 'wlg_cn', symbol: 'hk00700', addedAt: '2026-01-04T00:00:00Z' },
      { itemId: 'wli_4', groupId: 'wlg_cn', symbol: 'usAAPL', addedAt: '2026-01-05T00:00:00Z' },
      { itemId: 'wli_5', groupId: 'wlg_cn', symbol: 'sh601288', addedAt: '2026-01-06T00:00:00Z' },
      { itemId: 'wli_6', groupId: 'wlg_cn', symbol: 'sz301999', addedAt: '2026-01-07T00:00:00Z' },
    ],
  },
  quoteCache: {
    sh601398: { symbol: 'sh601398', price: 6.12, prevClose: 6.05, change: 0.07, changePct: 1.16, at: '2026-11-04T07:00:00Z' },
    sh600036: { symbol: 'sh600036', price: 41.2, prevClose: 40.8, change: 0.4, changePct: 0.98, at: '2026-11-04T07:00:00Z' },
    sh510880: { symbol: 'sh510880', price: 1.234, prevClose: 1.23, change: 0.004, changePct: 0.33, at: '2026-11-04T07:00:00Z' },
    hk00700: { symbol: 'hk00700', price: 380, prevClose: 378, change: 2, changePct: 0.53, at: '2026-11-04T07:00:00Z' },
    usAAPL: { symbol: 'usAAPL', price: 220, prevClose: 219, change: 1, changePct: 0.46, at: '2026-11-04T07:00:00Z' },
    sh601288: { symbol: 'sh601288', price: 5.05, prevClose: 5.0, change: 0.05, changePct: 1.0, at: '2026-11-04T07:00:00Z' },
    sz301999: { symbol: 'sz301999', price: 18.8, prevClose: 18.6, change: 0.2, changePct: 1.08, at: '2026-11-04T07:00:00Z' },
  },
  priceHistory: {},
  yieldHistory: {
    sh601398: { v: 2, at: todayStr, day: closes },
    sh600036: { v: 2, at: todayStr, day: closes2 },
    /* 只有 30 个交易日 → 分位样本不足 */
    sz301999: { v: 2, at: todayStr, day: closes.slice(-30) },
  },
};

const PROBE = `(async () => {
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  var out = {};
  var XJ = window.XJ;
  if (!(XJ && XJ.store && XJ.store.state)) { out.fatal = '未启动'; return out; }

  XJ.store.init(XJ.model.fromImport(SEED_JSON));
  XJ.store.ui.accountId = XJ.calc.ALL;
  /* 拦下图标解析：只记录被要求解析哪些 symbol（真实解析要走网络，探针里断网） */
  out.logoAsk = [];
  XJ.app.ensureLogosFor = function (syms) { out.logoAsk = out.logoAsk.concat(syms || []); return Promise.resolve(0); };
  XJ.store.setUI({ tab: 'watchlist', subPage: null });
  await sleep(500);

  XJ.store.init(XJ.model.fromImport(SEED_JSON));
  XJ.store.ui.accountId = XJ.calc.ALL;
  XJ.store.setUI({ tab: 'watchlist', subPage: null });
  await sleep(500);

  var body = document.getElementById('view-body');
  out.rows = Array.prototype.slice.call(body.querySelectorAll('.wl-row')).map(function (r) {
    var y = r.querySelector('.wl-yld');
    return {
      sym: r.getAttribute('data-sym'),
      text: y ? y.textContent.replace(/\\s+/g, ' ').trim() : null,
      hasYld: !!y,
      pct: !!(y && y.querySelector('.wl-pct')),
      pctTxt: (y && y.querySelector('.wl-pct')) ? y.querySelector('.wl-pct').textContent : null,
      pctClass: (y && y.querySelector('.wl-pct')) ? y.querySelector('.wl-pct').className : null,
    };
  });
  out.win = XJ.store.state.settings.yieldPctWin;

  /* 点进 A股行 → 详情页分位区块 */
  var row = body.querySelector('.wl-row[data-sym="sh601398"]');
  if (row) row.click();
  await sleep(700);
  var pctBox = document.querySelector('.yj-pct');
  out.pctBox = !!pctBox;
  if (pctBox) {
    out.pctNum = (pctBox.querySelector('.yj-pct-num') || {}).textContent;
    out.pctLine = (pctBox.querySelector('.yj-pct-line') || {}).textContent;
    out.pctRange = (pctBox.querySelector('.yj-pct-range') || {}).textContent;
    out.segLabels = Array.prototype.slice.call(pctBox.querySelectorAll('.yj-pct-btn')).map(function (b) { return b.textContent; });
    out.segOn = (pctBox.querySelector('.yj-pct-btn.on') || {}).textContent;
  }

  /* 切 5 年 */
  var b5 = document.querySelector('[data-act="setYieldPctWin"][data-y="5"]');
  if (b5) b5.click();
  await sleep(600);
  out.win5 = XJ.store.state.settings.yieldPctWin;
  var box5 = document.querySelector('.yj-pct');
  out.pctNum5 = box5 ? (box5.querySelector('.yj-pct-num') || {}).textContent : null;
  out.segOn5 = box5 ? (box5.querySelector('.yj-pct-btn.on') || {}).textContent : null;
  out.range5 = box5 ? (box5.querySelector('.yj-pct-range') || {}).textContent : null;

  /* 切 1 年（2026-11-04 新增窗口） */
  var b1 = document.querySelector('[data-act="setYieldPctWin"][data-y="1"]');
  if (b1) b1.click();
  await sleep(600);
  out.win1 = XJ.store.state.settings.yieldPctWin;
  var box1 = document.querySelector('.yj-pct');
  out.pctNum1 = box1 ? (box1.querySelector('.yj-pct-num') || {}).textContent : null;
  out.segOn1 = box1 ? (box1.querySelector('.yj-pct-btn.on') || {}).textContent : null;
  out.line1 = box1 ? (box1.querySelector('.yj-pct-line') || {}).textContent : null;
  /* 回持仓页看卡片徽标 */
  XJ.store.setUI({ tab: 'overview', subPage: null });
  await sleep(500);
  var badge = document.querySelector('.hc-pct');
  out.badge = badge ? { txt: badge.textContent, cls: badge.className, title: badge.getAttribute('title') } : null;

  /* —— 新增 1：样本不足要写出来，不能留空 —— */
  XJ.store.setUI({ tab: 'watchlist', subPage: null });
  await sleep(400);
  var thin = document.querySelector('.wl-row[data-sym="sz301999"] .wl-pct');
  out.thin = thin ? { txt: thin.textContent, cls: thin.className } : null;

  /* —— 新增 2：取数失败不再锁死当天；冷却过后自动重试成功 —— */
  var calls = 0;
  XJ.fetcher.fetchYieldHistory = function (syms) {
    calls++;
    if (calls === 1) return Promise.reject(new Error('boom'));
    /* 借用种子里的 700 天序列（PROBE 是模板串，取不到 Node 侧的 closes 变量） */
    var base = ((XJ.store.state.yieldHistory || {})['sh601398'] || {}).day || [];
    var o = {};
    (syms || []).forEach(function (s) { o[s] = { day: base }; });
    return Promise.resolve(o);
  };
  XJ.store.ui.pctTriedAt['sh601288'] = Date.now() - 21 * 60000;   // 假装上次失败已过冷却
  XJ.app.ensurePctData('sh601288');
  await sleep(900);
  out.failCalls = calls;
  out.failLocked = !!(XJ.store.state.yieldHistory || {})['sh601288'];
  /* 冷却内再触发：不该再发请求 */
  XJ.app.ensurePctData('sh601288');
  await sleep(400);
  out.callsInCooldown = calls;
  /* 冷却过期后重试 → 成功填上分位 */
  XJ.store.ui.pctTriedAt['sh601288'] = Date.now() - 21 * 60000;
  XJ.app.ensurePctData('sh601288');
  await sleep(900);
  out.retryCalls = calls;
  out.retryHist = !!((XJ.store.state.yieldHistory || {})['sh601288'] || {}).day;
  var rr = document.querySelector('.wl-row[data-sym="sh601288"] .wl-yld');
  out.retryText = rr ? rr.textContent.replace(/\\s+/g, ' ').trim() : null;
  return out;
})();`;

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
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); }
      }, 40000);
    });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-yld-'));
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
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 2, mobile: true }, sessionId);
  await browser.send('Runtime.evaluate', { expression: 'window.SEED_JSON = ' + JSON.stringify(seed) + ';', returnByValue: true }, sessionId);
  await browser.send('Page.navigate', { url: pathToFileURL(SRC).href }, sessionId);
  for (let i = 0; i < 120; i++) {
    await sleep(120);
    try {
      const r = await browser.send('Runtime.evaluate', { expression: '!!(window.XJ && XJ.store && XJ.store.state && document.getElementById("view-body"))', returnByValue: true }, sessionId);
      if (r.result && r.result.value) break;
    } catch (e) { /* retry */ }
  }
  await sleep(700);
  await browser.send('Runtime.evaluate', { expression: 'window.SEED_JSON = ' + JSON.stringify(seed) + ';', returnByValue: true }, sessionId);

  const r = await browser.send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true }, sessionId);
  const out = r.result ? (r.result.value || {}) : (r || {});
  if (!r.result || r.result.value === undefined) console.log('RAW=' + JSON.stringify(r).slice(0, 900));
  console.log(JSON.stringify(out, null, 2));

  const errs = browser.events.filter((m) => (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') || m.method === 'Runtime.exceptionThrown');
  if (errs.length) bad('控制台错误: ' + JSON.stringify(errs.slice(0, 2)).slice(0, 400)); else ok('控制台零错误');

  if (out.fatal) bad(out.fatal);
  else {
    const rows = out.rows || [];
    const cn = rows.find((x) => x.sym === 'sh601398') || {};
    const etf = rows.find((x) => x.sym === 'sh510880') || {};
    const hk = rows.find((x) => x.sym === 'hk00700') || {};
    const us = rows.find((x) => x.sym === 'usAAPL') || {};
    if (cn.pct && /息\s*\d+\.\d+%/.test(cn.text || '')) ok('★ A股自选行：' + cn.text);
    else bad('A股自选行异常 ' + JSON.stringify(cn));
    if (!etf.pct && !hk.pct && !us.pct && !(etf.text || '') && !(hk.text || '') && !(us.text || ''))
      ok('★ 非 A股（ETF/港股/美股）不显示息与分位');
    else bad('非 A股串味 ' + JSON.stringify([etf, hk, us]));

    if (out.pctBox && /^\d+%$/.test(out.pctNum || '')) ok('★ 详情页分位大数字 = ' + out.pctNum);
    else bad('详情页分位区块异常 ' + JSON.stringify({ box: out.pctBox, num: out.pctNum }));
    if (out.segLabels && out.segLabels.join('/') === '近1年/近2年/近3年/近5年/近10年' && out.segOn === '近3年') ok('★ 窗口切换按钮 = ' + out.segLabels.join('/') + '，当前 3年');
    else bad('窗口按钮异常 ' + JSON.stringify({ seg: out.segLabels, on: out.segOn }));
    if (out.win5 === 5 && out.segOn5 === '近5年') ok('★ 切 5 年生效（分位 ' + out.pctNum + ' → ' + out.pctNum5 + '）');
    else bad('切 5 年异常 ' + JSON.stringify({ win: out.win5, on: out.segOn5 }));
    if (out.win1 === 1 && out.segOn1 === '近1年' && /^\d+%$/.test(out.pctNum1 || '')) ok('★ 切 1 年生效（分位 ' + out.pctNum5 + ' → ' + out.pctNum1 + '）');
    else bad('切 1 年异常 ' + JSON.stringify({ win: out.win1, on: out.segOn1, num: out.pctNum1 }));
    if (out.badge && /^\d+%?$/.test(out.badge.txt || '')) ok('★ 持仓卡徽标 = ' + out.badge.txt + '（' + out.badge.cls + '）');
    else bad('持仓卡徽标异常 ' + JSON.stringify(out.badge));

    /* 新增三项 */
    const logoAsk = out.logoAsk || [];
    const wantLogo = ['sh601398', 'sh601288', 'sz301999'];
    if (wantLogo.every((s) => logoAsk.indexOf(s) >= 0)) ok('★ 自选渲染时对 A股 发起官方图标解析（' + wantLogo.join('/') + '）');
    else bad('未触发图标解析 ' + JSON.stringify(logoAsk.slice(0, 12)));

    if (out.thin && out.thin.txt === '样本不足' && /lo/.test(out.thin.cls || '')) ok('★ 样本不足的 A股 显示「样本不足」占位');
    else bad('样本不足占位异常 ' + JSON.stringify(out.thin));

    if (out.failCalls === 1 && out.failLocked === false && out.callsInCooldown === 1 &&
      out.retryCalls === 2 && out.retryHist === true && /分位\s*\d+/.test(out.retryText || ''))
      ok('★ 取数失败不锁死：冷却内不重发，冷却过后重试成功 → ' + out.retryText);
    else bad('重试链路异常 ' + JSON.stringify({ f: out.failCalls, locked: out.failLocked, cd: out.callsInCooldown, r: out.retryCalls, hist: out.retryHist, txt: out.retryText }));
  }

  const dir = path.join(PROJ, 'shots', 'yieldpct');
  fs.mkdirSync(dir, { recursive: true });
  const shoot = async (step, name) => {
    await browser.send('Runtime.evaluate', { expression: step, returnByValue: true }, sessionId);
    await sleep(650);
    const shot = await browser.send('Page.captureScreenshot', {}, sessionId);
    const data = shot && shot.data;
    if (data) { fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from(data, 'base64')); console.log('  📸 shots/yieldpct/' + name + '.png'); }
  };
  await shoot("XJ.store.setUI({ tab: 'watchlist', subPage: null });", 'watchlist');
  await shoot("document.querySelector('.wl-row[data-sym=\"sh601398\"]').click();", 'symbol');
  await shoot("XJ.store.setUI({ tab: 'overview', subPage: null });", 'overview1');
  await shoot("document.querySelector('.hc-grid') && document.querySelector('.hc-grid').scrollIntoView({block:'center'});", 'overview');

  browser.close();
} catch (e) {
  bad('异常: ' + (e && e.message ? e.message : String(e)));
} finally {
  try { chrome.kill(); } catch (e) {}
}

console.log(fail ? '\n[yieldpct] 失败 ' + fail + ' 项 ✗' : '\n[yieldpct] 全部通过 ✓');
process.exit(fail ? 1 : 0);











