/* 持仓页 CDP 验收：分红覆盖卡两大类（生存/品质，手风琴）+ 顶部大卡片配色自选 + 总分红红字
 * 用法： node tools/shoot-overview.mjs
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
const PORT = 9347;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 种子：两条生存 + 一条品质，年分红 8000（月均 666.67）→
   生存年支出 (600+900)×12 = 18000 无法全亮 → 品质项必须全灰（分红不流向品质）。 */
const seed = {
  version: 6, createdAt: '2026-01-01T00:00:00Z',
  accounts: [{ accountId: 'acc_1', name: '主账户', type: 'BROKER', sortOrder: 1, createdAt: '2026-01-01T00:00:00Z' }],
  symbols: {}, transactions: [], plans: {}, received: [],
  expenses: [
    { expenseId: 'e1', key: 'MEALS', label: '三餐', icon: '🍱', monthlyAmount: 600, enabled: true, sortOrder: 1, category: 'essential' },
    { expenseId: 'e2', key: 'MORTGAGE', label: '房贷', icon: '🏠', monthlyAmount: 900, enabled: true, sortOrder: 2, category: 'essential' },
    { expenseId: 'e3', key: 'TRAVEL', label: '旅行', icon: '✈️', monthlyAmount: 400, enabled: true, sortOrder: 3, category: 'quality' },
  ],
  projection: { configId: 'proj_default', monthlyInvest: 5000, years: 10, reinvestRatio: 1, divGrowthRate: 0, startAssets: null },
  settings: { id: 'app_settings', quoteRefreshMs: 60000, defaultAccountId: 'acc_1', onboarded: true },
  quoteCache: {},
  priceHistory: {},
};
[['sh600036', 40]].forEach(([sym, price]) => {
  const qty = 2000;
  seed.symbols[sym] = { symbol: sym, code: sym.slice(2), market: 'sh', name: '招商银行', type: 'STOCK', dividendBasis: { type: 'years', value: 1 } };
  seed.quoteCache[sym] = { symbol: sym, name: '招商银行', code: sym.slice(2), price, prevClose: price - 0.2, changePct: 0.5, quoteTime: '20260910150000' };
  seed.transactions.push({ txId: 'tx_' + sym, accountId: 'acc_1', symbol: sym, action: 'BUY', date: '2024-01-10', quantity: qty, price: price * 0.9, fee: 5, note: '', createdAt: '2024-01-10T00:00:00Z' });
  seed.plans[sym + '_2025-12-31'] = {
    planId: sym + '_2025-12-31', symbol: sym, securityCode: sym.slice(2), securityName: '',
    reportDate: '2025-12-31', reportType: '年报', pretaxBonusPer10: 20, afterTaxPer10: null,
    implPlanProfile: '10派20元', planNoticeDate: null, noticeDate: null,
    equityRecordDate: '2026-06-01', exDividendDate: '2026-06-02', assignProgress: '实施分配',
    progressRank: 100, isImplemented: true, dividendRatio: null, fetchedAt: '2026-09-01T00:00:00Z',
  };
});

const PROBE = `(async () => {
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  var out = {};
  var XJ = window.XJ;
  if (!(XJ && XJ.store && XJ.store.state)) { out.fatal = '未启动'; return out; }

  XJ.store.init(XJ.model.fromImport(SEED_JSON));
  XJ.store.ui.accountId = XJ.calc.ALL;
  XJ.store.setUI({ tab: 'home', subPage: null });
  await sleep(400);

  var body = document.getElementById('view-body');
  var cats = Array.prototype.slice.call(document.querySelectorAll('.cover-cat'));
  out.cover = {
    catCount: cats.length,
    labels: cats.map(function (c) { return (c.querySelector('.cc-name') || {}).textContent; }),
    subs: cats.map(function (c) { return (c.querySelector('.cc-sub') || {}).textContent; }),
    openDefault: JSON.stringify(XJ.store.ui.coverOpenCats),
    iconsOnOpen: document.querySelectorAll('.cover-icons .cover-icon').length,
    litIcons: document.querySelectorAll('.cover-icons .cover-icon.on').length,
    hasNote: (body.textContent || '').indexOf('分红先覆盖生存支出') >= 0,
  };

  /* 独立展开：点生存 → 只开生存（2 项）；再点品质 → 两类同时展开（3 项） */
  var eBtn = document.querySelector('.cover-cat[data-v="essential"]');
  if (eBtn) { eBtn.click(); await sleep(260); }
  out.accordion = {
    uiAfterEssential: JSON.stringify(XJ.store.ui.coverOpenCats),
    iconsAfterEssential: document.querySelectorAll('.cover-icons .cover-icon').length,
  };
  var qBtn = document.querySelector('.cover-cat[data-v="quality"]');
  if (qBtn) { qBtn.click(); await sleep(280); }
  /* 两类同时展开：明细块应有两个，且样式逐项一致 */
  var blocks = Array.prototype.slice.call(document.querySelectorAll('.cover-icons'));
  var styleOf = function (blk) {
    var b = blk.querySelector('.cover-icon .box');
    var n = blk.querySelector('.cover-icon .nm');
    var cb = b ? getComputedStyle(b) : null;
    var cn = n ? getComputedStyle(n) : null;
    return cb ? { w: cb.width, h: cb.height, r: cb.borderRadius, fs: cb.fontSize, bg: cb.backgroundColor }
      : null;
  };
  out.accordion.uiBoth = JSON.stringify(XJ.store.ui.coverOpenCats);
  out.accordion.blocksBoth = blocks.length;
  out.accordion.iconsBoth = document.querySelectorAll('.cover-icons .cover-icon').length;
  out.accordion.styleA = blocks[0] ? styleOf(blocks[0]) : null;
  out.accordion.styleB = blocks[1] ? styleOf(blocks[1]) : null;
  out.accordion.labelsBoth = Array.prototype.slice.call(document.querySelectorAll('.cover-icons .cover-icon .nm')).map(function (n) { return n.textContent; });
  out.accordion.qualityLit = document.querySelectorAll('.cover-icons .cover-icon.on').length;

  /* 再点品质单独收起 → 只剩生存 2 项 */
  var qBtn2 = document.querySelector('.cover-cat[data-v="quality"]');
  if (qBtn2) { qBtn2.click(); await sleep(260); }
  out.accordion.collapsedIcons = document.querySelectorAll('.cover-icons .cover-icon').length;
  out.accordion.uiAfterCollapse = JSON.stringify(XJ.store.ui.coverOpenCats);

  /* ---- 持仓卡价格行：主位涨跌% / 次位现价 / 价差已删除 ---- */
  var pxRow = document.querySelector('.hc-intra');
  var pxChg = document.querySelector('.hc-px .chg-lg');
  var pxb = document.querySelector('.hc-px b');
  var cs = pxChg ? getComputedStyle(pxChg) : null;
  var csb = pxb ? getComputedStyle(pxb) : null;
  out.price = {
    rowExists: !!pxRow,
    chgText: pxChg ? pxChg.textContent : null,
    chgFontSize: cs ? parseFloat(cs.fontSize) : null,
    chgBg: cs ? cs.backgroundColor : null,
    pxText: pxb ? pxb.textContent : null,
    pxFontSize: csb ? parseFloat(csb.fontSize) : null,
    pxColor: csb ? csb.color : null,
    pxAmtGone: !document.querySelector('[data-anim-key$=":pxamt"]'),
    codeBadgeKept: !!document.querySelector('.hc-code .chg'),
  };

  /* 顶部大卡片：默认配色 + 红字 + 切到藏青 */
  var hero = document.querySelector('.hero-dark');
  var amt = document.querySelector('.hd-amount');
  out.hero = {
    exists: !!hero,
    dataHero: hero ? hero.getAttribute('data-hero') : null,
    amountColor: amt ? getComputedStyle(amt).color : null,
    bgImage: hero ? getComputedStyle(hero).backgroundImage.slice(0, 60) : null,
  };
  /* 打开「设置指标」弹层 → 色板 → 切藏青 */
  var ms = document.querySelector('[data-act="openMetricSettings"]');
  if (ms) { ms.click(); await sleep(320); }
  var sw = Array.prototype.slice.call(document.querySelectorAll('.hero-swatch'));
  out.swatches = { count: sw.length, labels: sw.map(function (s) { return s.textContent.trim(); }),
    active: (document.querySelector('.hero-swatch.active') || {}).getAttribute
      ? document.querySelector('.hero-swatch.active').getAttribute('data-v') : null };
  var navy = document.querySelector('.hero-swatch[data-v="navy"]');
  if (navy) { navy.click(); await sleep(360); }
  var hero2 = document.querySelector('.hero-dark');
  out.heroAfter = {
    dataHero: hero2 ? hero2.getAttribute('data-hero') : null,
    bgImage: hero2 ? getComputedStyle(hero2).backgroundImage.slice(0, 60) : null,
    persisted: XJ.store.state.settings.heroColor,
    sheetClosed: !document.querySelector('.sheet'),
  };
  return out;
})()`;

/* ---------------- CDP 直连（与 shoot-fire 同款极简客户端） ---------------- */
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-ov-'));
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
  const errs = browser.events.filter((m) => (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') || m.method === 'Runtime.exceptionThrown');
  if (errs.length) bad('控制台错误: ' + JSON.stringify(errs.slice(0, 2)).slice(0, 300)); else ok('控制台零错误');

  if (out.fatal) bad(out.fatal);
  else {
    const cv = out.cover || {};
    if (cv.catCount === 2 && cv.labels.join('/') === '生存支出/品质支出')
      ok('② 分红覆盖 = 两大类（' + cv.labels.join(' / ') + '）');
    else bad('分类条异常 ' + JSON.stringify(cv.labels));
    if (cv.openDefault === '{"essential":false,"quality":false}' && cv.iconsOnOpen === 0)
      ok('① 两类默认都收起');
    else bad('默认态异常 ' + cv.openDefault + ' icons=' + cv.iconsOnOpen);
    if (cv.hasNote) ok('② 口径说明小字在位'); else bad('缺少「分红先覆盖生存支出」说明');

    const ac = out.accordion || {};
    if (ac.iconsAfterEssential === 2) ok('① 点生存 → 只展开生存（2 项）');
    else bad('生存展开异常 ' + JSON.stringify(ac));
    if (ac.uiBoth === '{"essential":true,"quality":true}' && ac.blocksBoth === 2 && ac.iconsBoth === 3)
      ok('★ 两类可同时展开（明细块 2 个 / 共 3 项）');
    else bad('同时展开异常 ' + JSON.stringify(ac));
    if (ac.styleA && ac.styleB && JSON.stringify(ac.styleA) === JSON.stringify(ac.styleB))
      ok('★ 生存/品质明细样式逐项一致（' + JSON.stringify(ac.styleA) + '）');
    else bad('两类明细样式不一致 A=' + JSON.stringify(ac.styleA) + ' B=' + JSON.stringify(ac.styleB));
    if (ac.qualityLit === 0) ok('★ 生存未满 → 品质项全灰（分红不流向品质）'); else bad('品质项被错误点亮');
    if (ac.collapsedIcons === 2 && ac.uiAfterCollapse === '{"essential":true,"quality":false}')
      ok('① 再点品质可单独收起（生存保持展开）');
    else bad('单独收起异常 ' + JSON.stringify(ac));

    const px = out.price || {};
    if (px.rowExists && px.chgText && /[+-]?\d/.test(px.chgText)) ok('② 价格行始终显示（涨跌% 主位：' + px.chgText + '）');
    else bad('价格行异常 ' + JSON.stringify(px));
    if (px.chgFontSize && px.pxFontSize && px.chgFontSize > px.pxFontSize)
      ok('★ 涨跌% 主信息更大：' + px.chgFontSize + 'px > 现价 ' + px.pxFontSize + 'px');
    else bad('主次字号异常 chg=' + px.chgFontSize + ' px=' + px.pxFontSize);
    if (px.chgBg && px.chgBg !== 'rgba(0, 0, 0, 0)') ok('★ 涨跌% 实底徽章生效（' + px.chgBg + '）'); else bad('徽章底色缺失');
    if (px.pxText && /^\d/.test(px.pxText) && px.pxColor && px.pxColor.replace(/\\s/g, '') !== 'rgb(224,49,47)')
      ok('② 实时价格降为次要（' + px.pxText + '，' + px.pxColor + '）');
    else bad('现价样式异常 ' + JSON.stringify(px));
    if (px.pxAmtGone) ok('② 价差（±金额）已删除'); else bad('价差仍在');
    if (px.codeBadgeKept) ok('② 代码旁涨跌徽章保留'); else bad('代码旁徽章丢失');

    const hd = out.hero || {};
    if (hd.exists && hd.dataHero === 'graphite') ok('③ 大卡片默认配色 = 经典石墨'); else bad('默认配色异常 ' + hd.dataHero);
    if (hd.amountColor && hd.amountColor.replace(/\s/g, '') === 'rgb(255,90,60)')
      ok('★ 总分红红字 = #FF5A3C（' + hd.amountColor + '）');
    else bad('总分红颜色异常 ' + hd.amountColor);

    const sw = out.swatches || {};
    if (sw.count === 6) ok('④ 色板六款可选（' + sw.labels.join('/') + '）'); else bad('色板数量 ' + sw.count);
    if (sw.active === 'graphite') ok('④ 当前配色高亮 = graphite'); else bad('高亮异常 ' + sw.active);
    const ha = out.heroAfter || {};
    if (ha.dataHero === 'navy' && ha.persisted === 'navy' && ha.bgImage !== hd.bgImage)
      ok('★ 点藏青即时生效并持久化（底色已变）');
    else bad('配色切换异常 ' + JSON.stringify(ha));
    if (ha.sheetClosed) ok('④ 选完自动关闭弹层'); else bad('弹层未关闭');
  }

  await browser.send('Page.captureScreenshot', {}, sessionId).then(async (shot) => {
    const dir = path.join(PROJ, 'shots', 'overview');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'overview.png'), Buffer.from(shot.result.data, 'base64'));
    console.log('  📸 shots/overview/overview.png');
  }).catch(() => {});

  browser.close();
} catch (e) {
  bad('异常: ' + (e && e.message ? e.message : String(e)));
} finally {
  try { chrome.kill(); } catch (e) {}
}

console.log(fail ? '\\n[overview] 失败 ' + fail + ' 项 ✗' : '\\n[overview] 全部通过 ✓');
process.exit(fail ? 1 : 0);
