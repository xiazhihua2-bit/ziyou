/* FIRE 视图 CDP 验收：渲染 / 滑杆局部联动 / 切档记忆 / 口径切换 / 深浅双模式截图
 * 用法： node tools/shoot-fire.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.join(ROOT, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SRC = path.join(PROJ, 'dist', '自由.html');
const PORT = 9345;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const seed = {
  version: 6, createdAt: '2026-01-01T00:00:00Z',
  accounts: [{ accountId: 'acc_1', name: '主账户', type: 'BROKER', sortOrder: 1, createdAt: '2026-01-01T00:00:00Z' }],
  symbols: {}, transactions: [], plans: {}, received: [],
  expenses: [
    { expenseId: 'e1', key: 'MEALS', label: '三餐', icon: '🍱', monthlyAmount: 900, enabled: true, sortOrder: 1, category: 'essential' },
    { expenseId: 'e2', key: 'MORTGAGE', label: '房贷', icon: '🏠', monthlyAmount: 2500, enabled: true, sortOrder: 2, category: 'essential' },
    { expenseId: 'e3', key: 'TRAVEL', label: '旅行', icon: '✈️', monthlyAmount: 800, enabled: true, sortOrder: 3, category: 'quality' },
  ],
  projection: { configId: 'proj_default', monthlyInvest: 5000, years: 10, reinvestRatio: 1, divGrowthRate: 0, startAssets: null },
  settings: { id: 'app_settings', quoteRefreshMs: 60000, defaultAccountId: 'acc_1', onboarded: true },
  quoteCache: {},
  priceHistory: {},
};
['sh600036', 'sh601088'].forEach((sym, i) => {
  const qty = 2000, price = 40 + i * 2;
  seed.symbols[sym] = { symbol: sym, code: sym.slice(2), market: 'sh', name: i ? '中国神华' : '招商银行', type: 'STOCK', dividendBasis: { type: 'years', value: 1 } };
  seed.quoteCache[sym] = { symbol: sym, name: sym === 'sh600036' ? '招商银行' : '中国神华', code: sym.slice(2), price, prevClose: price - 0.2, changePct: 0.5, quoteTime: '20260910150000' };
  seed.transactions.push({ txId: 'tx_' + sym, accountId: 'acc_1', symbol: sym, action: 'BUY', date: '2024-01-10', quantity: qty, price: price * 0.9, fee: 5, note: '', createdAt: '2024-01-10T00:00:00Z' });
  seed.plans[sym + '_2025-12-31'] = {
    planId: sym + '_2025-12-31', symbol: sym, securityCode: sym.slice(2), securityName: '',
    reportDate: '2025-12-31', reportType: '年报', pretaxBonusPer10: 20, afterTaxPer10: null,
    implPlanProfile: '10派20元', planNoticeDate: null, noticeDate: null,
    equityRecordDate: '2026-06-01', exDividendDate: '2026-06-02', assignProgress: '实施分配',
    progressRank: 100, isImplemented: true, dividendRatio: null, fetchedAt: '2026-09-01T00:00:00Z',
  };
  seed.received.push({ recId: 'r_' + sym, accountId: 'acc_1', symbol: sym, planId: sym + '_2025-12-31', exDividendDate: '2026-06-02', perShareAmount: 2, qtyAtRecord: qty, amount: qty * 2, source: 'AUTO', year: 2026, createdAt: '2026-06-02T00:00:00Z' });
  const pts = [];
  for (let k = 180; k >= 0; k--) {
    const d = new Date(2026, 8, 10); d.setDate(d.getDate() - k);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    pts.push([key, price * (0.95 + (180 - k) * 0.0003)]);
  }
  seed.priceHistory[sym] = { at: '2026-09-10', points: pts };
});

const PROBE = `
(async function(){
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  var out = {};
  var XJ = window.XJ;
  out.boot = !!(XJ && XJ.store && XJ.store.state);
  if (!out.boot) { out.fatal = '未启动'; return out; }

  XJ.store.init(XJ.model.fromImport(SEED_JSON));
  XJ.store.ui.accountId = XJ.calc.ALL;
  XJ.store.notify();

  /* 切到 FIRE Tab */
  XJ.store.setUI({ tab: 'find', subPage: null });
  var body = document.getElementById('view-body');
  var txt = body.textContent || '';
  out.render = {
    nodes: body.children.length,
    bigNum: (document.getElementById('fire-big-num')||{}).textContent,
    sliders: document.querySelectorAll('.fs-range').length,
    tierChips: document.querySelectorAll('[data-act="setFireTier"]').length,
    expGroups: document.querySelectorAll('.exp-group').length,
    tabLabel: (document.querySelector('.tab.active')||{}).textContent,
    hasCoverage: txt.indexOf('被动收入覆盖率') >= 0,
    hasProgress: txt.indexOf('FI 进度') >= 0,
    noScene: txt.indexOf('场景模拟') < 0,
    hasGrouped: txt.indexOf('生存支出') >= 0 && txt.indexOf('品质支出') >= 0,
    hasEntry: txt.indexOf('分红汇总') >= 0,
    svgCount: body.querySelectorAll('svg[data-chart]').length,
    hline: body.querySelectorAll('svg[data-chart] line[stroke-dasharray="5 4"]').length,
    prRangeChips: document.querySelectorAll('[data-act="setFirePrRange"]').length,
    covRangeChips: document.querySelectorAll('[data-act="setFireCovRange"]').length,
    bigIsYm: /^\\d{4}\\s*年\\s*\\d{1,2}\\s*月$/.test((document.getElementById('fire-big-num')||{}).textContent || ''),
    bigCodes: Array.from((document.getElementById('fire-big-num')||{}).textContent || '').map(function(c){return c.charCodeAt(0).toString(16);}).join(','),
    glassActive: document.querySelectorAll('.fi-glass .chip.active').length,
  };

  /* 滑杆局部联动：input 事件 → 大数字变化 + 不触发整页渲染 */
  var slider = document.querySelector('.fs-range[data-k="drip"]');
  var beforeBig = (document.getElementById('fire-big-num')||{}).textContent;
  slider.value = 20000;
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(220);
  var afterBig = (document.getElementById('fire-big-num')||{}).textContent;
  out.sliderLink = { beforeBig: beforeBig, afterBig: afterBig, changed: beforeBig !== afterBig,
    fillVar: slider.style.getPropertyValue('--p') };
  slider.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(120);
  out.sliderCommit = { persisted: XJ.store.state.settings.fire.tierSims.regular.drip === 20000 };

  /* 切档：花费强制同步该档真实台账（monthlySpend 置 null），drip 保留记忆 */
  document.querySelector('[data-act="setFireTier"][data-v="lean"]').click();
  await sleep(140);
  out.tierSwitch = {
    activeTier: XJ.store.state.settings.fire.activeTier,
    regularDripKept: XJ.store.state.settings.fire.tierSims.regular.drip === 20000,
    leanDripDefault: XJ.store.state.settings.fire.tierSims.lean.drip === 5000,
    leanSpendNull: XJ.store.state.settings.fire.tierSims.lean.monthlySpend === null,
    bigNow: (document.getElementById('fire-big-num')||{}).textContent,
  };

  /* 再投滑杆 + 提取抵扣行联动（r=100 回归 → r=50 抵扣生效 → 还原） */
  var rs = document.querySelector('.fs-range[data-k="reinvest"]');
  var effEl = document.getElementById('fire-spend-eff');
  var effParse = function (txt) {
    var t = (txt || '').match(/抵扣后目标\\s*¥([\\d,\\.]+)/);
    var o = (txt || '').match(/抵扣\\s*−¥([\\d,\\.]+)/);
    var n = function (m) { return m ? Number(m[1].replace(/,/g, '')) : null; };
    return { target: n(t), offset: n(o) };
  };
  var e100 = effParse(effEl ? effEl.textContent : null);
  var persisted50 = false;
  if (rs) {
    rs.value = 50; rs.dispatchEvent(new Event('input', { bubbles: true })); await sleep(220);
    var e50 = effParse(effEl ? effEl.textContent : null);
    rs.dispatchEvent(new Event('change', { bubbles: true })); await sleep(120);
    persisted50 = XJ.store.state.settings.fire.reinvestPct === 50;
    out.reinvest = { exists: true, val: 50, persisted: persisted50,
      effLineExists: !!effEl, effAt100: e100, effAt50: e50,
      offsetUp: e100.offset === 0 && e50.offset !== null && e50.offset >= 300 && e50.offset <= 350,
      targetDown: e50.target !== null && e100.target !== null && e50.target < e100.target,
      bigAfter: (document.getElementById('fire-big-num')||{}).textContent };
    /* 还原 100%（默认口径，后续截图不受影响） */
    rs.value = 100; rs.dispatchEvent(new Event('input', { bubbles: true })); await sleep(220);
    rs.dispatchEvent(new Event('change', { bubbles: true })); await sleep(120);
  } else {
    out.reinvest = { exists: false, effLineExists: !!effEl, effAt100: e100 };
  }

  /* FI 曲线时间尺度切换（近三月 → 近半年） */
  var pr3 = document.querySelector('[data-act="setFirePrRange"][data-v="3m"]');
  if (pr3) { pr3.click(); await sleep(140); }
  out.prRange = { ui: XJ.store.ui.firePrRange,
    svg: document.querySelectorAll('svg[data-chart]').length };

  /* 覆盖率尺度切换（近三月） */
  var cv3 = document.querySelector('[data-act="setFireCovRange"][data-v="3m"]');
  if (cv3) { cv3.click(); await sleep(140); }
  out.covRange = { ui: XJ.store.ui.fireCovRange };

  /* 支出编辑器分类 segmented */
  XJ.store.setUI({ tab: 'find' });
  document.querySelector('[data-act="openExpenseEditor"]').click();
  await sleep(320);
  var esheet = document.querySelector('.sheet');
  out.expenseEditor = { catButtons: esheet ? esheet.querySelectorAll('.xp-cat').length : 0,
    hiddenCat: esheet && esheet.querySelector('[data-k="category"]') ? esheet.querySelector('[data-k="category"]').value : null };
  XJ.ui.closeSheet();

  return out;
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-fire-'));
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
  await browser.send('Page.navigate', { url: pathToFileURL(SRC).href }, sessionId);
  for (let i = 0; i < 120; i++) {
    await sleep(120);
    try {
      const r = await browser.send('Runtime.evaluate', { expression: '!!(window.XJ && XJ.store && XJ.store.state && document.getElementById("view-body"))', returnByValue: true }, sessionId);
      if (r.result && r.result.value) break;
    } catch (e) { /* retry */ }
  }
  await sleep(700);

  const r = await browser.send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true }, sessionId);
  const out = r.result.value || {};
  const errs = browser.events.filter((m) => (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') || m.method === 'Runtime.exceptionThrown');
  if (errs.length) bad('控制台错误: ' + JSON.stringify(errs.slice(0, 2)).slice(0, 300)); else ok('控制台零错误');

  if (out.fatal) bad(out.fatal);
  else {
    const rd = out.render || {};
    if (rd.bigIsYm) ok('① 大数字 = 具体年月（' + rd.bigNum + '）'); else bad('大数字非年月格式: ' + rd.bigNum);
    if (rd.sliders === 4) ok('③ 四根滑杆在位（含再投）'); else bad('滑杆数量 ' + rd.sliders);
    if (rd.tierChips === 6) ok('② 档位 chips 两处共 6 枚（大数字卡+覆盖率卡）'); else bad('档位 chips ' + rd.tierChips);
    if (rd.hasCoverage && rd.hasProgress) ok('两张分析卡都在'); else bad('卡片缺失');
    if (rd.noScene) ok('⑪ 场景模拟卡已删除'); else bad('场景卡仍存在');
    if (rd.hasGrouped) ok('支出已分组（生存/品质）'); else bad('支出未分组');
    if (rd.hasEntry) ok('分红汇总入口保留'); else bad('汇总入口缺失');
    if (rd.svgCount >= 1) ok('图表 SVG ' + rd.svgCount + ' 张'); else bad('无图表');
    if (rd.hline >= 1) ok('100% 基准虚线在位'); else bad('无 100% 虚线');
    if (rd.tabLabel && rd.tabLabel.indexOf('FIRE') >= 0) ok('Tab 已改名 FIRE'); else bad('Tab 未改名: ' + rd.tabLabel);
    if (rd.prRangeChips === 7) ok('⑦ FI 曲线七档尺度 chips'); else bad('FI 尺度 chips ' + rd.prRangeChips);
    if (rd.covRangeChips === 5) ok('⑨ 覆盖率五档尺度 chips'); else bad('覆盖率尺度 chips ' + rd.covRangeChips);
    if (rd.glassActive >= 1) ok('⑫ 液态玻璃选中态生效（' + rd.glassActive + ' 枚 active）'); else bad('液态玻璃选中态缺失');

    const sl = out.sliderLink || {};
    if (sl.changed) ok('滑杆 input 联动大数字（' + sl.beforeBig + ' → ' + sl.afterBig + '）'); else bad('滑杆联动失效');
    if (out.sliderCommit && out.sliderCommit.persisted) ok('松手 commit 持久化'); else bad('commit 未落');
    const ts = out.tierSwitch || {};
    if (ts.activeTier === 'lean' && ts.regularDripKept && ts.leanDripDefault && ts.leanSpendNull) ok('④ 切档：花费强制同步（置 null）+ 攒股/息率各自记忆'); else bad('切档同步异常 ' + JSON.stringify(ts));
    const rv = out.reinvest || {};
    if (rv.exists && rv.effLineExists) ok('③ 再投滑杆 + 抵扣行在位'); else bad('再投滑杆/抵扣行缺失 ' + JSON.stringify(rv));
    if (rv.effAt100 && rv.effAt100.offset === 0 && rv.effAt100.target === 3400)
      ok('r=100% 回归：抵扣行显示零抵扣（目标 ¥' + rv.effAt100.target + '）');
    else bad('r=100% 抵扣行异常 ' + JSON.stringify(rv.effAt100));
    if (rv.offsetUp && rv.targetDown)
      ok('联动：再投 100→50 → 抵扣 −¥' + (rv.effAt50 || {}).offset + '，目标 ¥' + (rv.effAt50 || {}).target + '（变小）');
    else bad('抵扣联动失效 ' + JSON.stringify(rv));
    if (rv.persisted) ok('再投 commit 持久化'); else bad('再投 commit 未落');
    const pr = out.prRange || {};
    if (pr.ui === '3m' && pr.svg >= 1) ok('⑦ FI 曲线切到近三月仍渲染'); else bad('FI 尺度切换异常 ' + JSON.stringify(pr));
    const cv = out.covRange || {};
    if (cv.ui === '3m') ok('⑨ 覆盖率切到近三月'); else bad('覆盖率尺度切换异常 ' + JSON.stringify(cv));
    const ex = out.expenseEditor || {};
    if (ex.catButtons === 2 && ex.hiddenCat) ok('支出编辑器含分类选择'); else bad('支出分类缺失 ' + JSON.stringify(ex));
  }

  /* 深浅双模式截图 */
  const SHOT = path.join(PROJ, 'shots', 'fire');
  fs.mkdirSync(SHOT, { recursive: true });
  await browser.send('Runtime.evaluate', { expression: 'XJ.store.setUI({tab:"find",subPage:null});XJ.ui.closeSheet();' }, sessionId);
  for (const [mode, scheme] of [['light', 'light'], ['dark', 'dark']]) {
    await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, sessionId);
    await sleep(300);
    const s = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(path.join(SHOT, mode + '-fire.png'), Buffer.from(s.data, 'base64'));
    console.log('  📸 shots/fire/' + mode + '-fire.png');
  }

  console.log(fail === 0 ? '\n[fire] 全部通过 ✓' : '\n[fire] 失败 ' + fail + ' 项 ✗');
  process.exitCode = fail === 0 ? 0 : 1;
} catch (e) {
  console.error('[fire] 异常:', e);
  process.exitCode = 1;
} finally {
  try { chrome.kill(); } catch (e) { /* 忽略 */ }
}
