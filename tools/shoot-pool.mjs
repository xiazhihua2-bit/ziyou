/* 股票池 515450 CDP 验收（断网跑：快照全内嵌，离线也应完整展示 50 行）
 * 覆盖：入口导航 / 50 行 / 官方 logo 无中文层 / 字段顺序 / 两字段三态排序 /
 *       实时价驱动息率与分位 / 返回后自选列表不受影响。
 * 用法： node tools/shoot-pool.mjs
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
const PORT = 9357;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const symRec = (sym, name) => ({ symbol: sym, code: sym.slice(2), market: sym.slice(0, 2), name, type: 'STOCK', updatedAt: '2026-01-01T00:00:00Z' });
const seed = {
  version: 6, createdAt: '2026-01-01T00:00:00Z',
  accounts: [{ accountId: 'acc_1', name: '主账户', type: 'BROKER', sortOrder: 1, createdAt: '2026-01-01T00:00:00Z' }],
  symbols: { sh600036: symRec('sh600036', '招商银行') },
  transactions: [], plans: {}, received: [],
  expenses: [{ expenseId: 'e1', key: 'MEALS', label: '三餐', icon: '🍱', monthlyAmount: 600, enabled: true, sortOrder: 1, category: 'essential' }],
  projection: { configId: 'proj_default', monthlyInvest: 5000, years: 10, reinvestRatio: 1, divGrowthRate: 0, startAssets: null },
  settings: { id: 'app_settings', quoteRefreshMs: 60000, defaultAccountId: 'acc_1', onboarded: true, yieldPctWin: 3 },
  watchlist: {
    groups: [
      { groupId: 'wlg_us', name: '美股', sortOrder: 1, createdAt: '2026-01-01T00:00:00Z' },
      { groupId: 'wlg_hk', name: '港股', sortOrder: 2, createdAt: '2026-01-01T00:00:00Z' },
      { groupId: 'wlg_cn', name: 'A股', sortOrder: 3, createdAt: '2026-01-01T00:00:00Z' },
    ],
    items: [
      { itemId: 'wli_a1', groupId: 'wlg_cn', symbol: 'sh600036', addedAt: '2026-01-02T00:00:00Z' },
    ],
  },
  quoteCache: {}, priceHistory: {},
};

const PROBE = `(async () => {
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  var out = {};
  var XJ = window.XJ;
  if (!(XJ && XJ.store && XJ.store.state)) { out.fatal = '未启动'; return out; }
  /* 断网桩：避免 bind() 的首次行情请求产生网络噪声；后面再单独打桩模拟实时价 */
  var realFetch = XJ.fetcher.fetchQuotes;
  XJ.fetcher.fetchQuotes = function(){ return Promise.resolve({}); };

  XJ.store.init(XJ.model.fromImport(SEED_JSON));
  XJ.store.ui.accountId = XJ.calc.ALL;
  /* ★ 切 tab 必须真实 click 走 navTo（写 history 栈），setUI 直改会让返回栈分叉 */
  var tabWl = document.querySelector('.tab[data-tab="watchlist"]');
  if (tabWl) tabWl.click();
  await sleep(420);
  var body = document.getElementById('view-body');
  out.wl = {
    entry: !!body.querySelector('.pool-enter'),
    chips: body.querySelectorAll('.wl-chip').length,
    hasIndexBar: !!body.querySelector('.wl-topbar'),
    hasSearch: !!body.querySelector('.wl-search'),
    rows: body.querySelectorAll('.wl-row').length,
    sortBtns: body.querySelectorAll('.wl-sortbtn').length,
  };

  /* 入口必须走真实 click（navTo 写 history 栈） */
  var enter = body.querySelector('.pool-enter');
  if (enter) enter.click();
  await sleep(420);
  body = document.getElementById('view-body');
  out.nav = { sub: XJ.store.ui.subPage, title: (document.querySelector('.topbar-row h1') || {}).textContent };

  var imgs = Array.prototype.slice.call(body.querySelectorAll('.pool-row .av-img'));
  out.page = {
    rows: body.querySelectorAll('.pool-row').length,
    hasSpark: !!body.querySelector('.pool-row .wl-spark'),
    hasDel: !!body.querySelector('.pool-row .wl-del'),
    hasPx: !!body.querySelector('.pool-row .wl-px'),
    hasCode: !!body.querySelector('.pool-row .wl-code'),
    imgs: imgs.length,
    dataLogos: imgs.filter(function(i){
      return (i.getAttribute('src') || '').indexOf('data:image/png;base64,') === 0;
    }).length,
    txtAvatars: body.querySelectorAll('.pool-row .av-txt').length,
    yld: body.querySelectorAll('.pool-row .wl-yld-t').length,
    pct: body.querySelectorAll('.pool-row .wl-pct').length,
    sortBtns: body.querySelectorAll('.wl-sortbtn').length,
    stat: (body.querySelector('.pool-sortstat') || {}).textContent,
    head: (body.querySelector('.pool-head') || {}).textContent,
  };

  var readYld = function(){
    return Array.prototype.slice.call(document.querySelectorAll('.pool-row .wl-yld-t'))
      .map(function(e){ var m = (e.textContent || '').match(/([0-9.]+)/); return m ? parseFloat(m[1]) : null; });
  };
  var readPct = function(){
    return Array.prototype.slice.call(document.querySelectorAll('.pool-row .wl-pct'))
      .map(function(e){ var m = (e.textContent || '').match(/([0-9.]+)/); return m ? parseFloat(m[1]) : null; });
  };
  var desc = function(a){ for (var i = 1; i < a.length; i++) { if (a[i-1] !== null && a[i] !== null && a[i] > a[i-1] + 1e-9) return false; } return true; };
  var asc = function(a){ for (var i = 1; i < a.length; i++) { if (a[i-1] !== null && a[i] !== null && a[i] < a[i-1] - 1e-9) return false; } return true; };
  var clickSort = function(i){
    var b = document.querySelectorAll('.wl-sortbtn')[i];
    if (b) b.click();
  };
  var state = function(){ return XJ.wlSort.stateOf('pool'); };

  /* ① 股息率：无 → 降 → 升 → 无 */
  clickSort(0); await sleep(260);
  out.s1 = { state: state(), desc: desc(readYld()), stat: (document.querySelector('.pool-sortstat') || {}).textContent,
             mark: (document.querySelector('.wl-sortbtn.on .wl-sortmk') || {}).textContent };
  clickSort(0); await sleep(260);
  out.s2 = { state: state(), asc: asc(readYld()), stat: (document.querySelector('.pool-sortstat') || {}).textContent,
             mark: (document.querySelector('.wl-sortbtn.on .wl-sortmk') || {}).textContent };
  clickSort(0); await sleep(260);
  out.s3 = { state: state() };
  /* ② 百分位：独立字段，点一下直接降序 */
  clickSort(1); await sleep(260);
  out.s4 = { state: state(), desc: desc(readPct()), stat: (document.querySelector('.pool-sortstat') || {}).textContent,
             onLabel: (document.querySelector('.wl-sortbtn.on') || {}).textContent };
  /* 排序态与自选分组隔离 */
  out.isolate = { pool: state().dir, all: XJ.wlSort.stateOf('all').dir, holding: XJ.wlSort.stateOf('holding').dir };

  /* ③ 实时价联动：打桩给第一只票一个新价，息率与价格应跟着变 */
  var sym0 = XJ.pool515450.items()[0].s;
  var before = (document.querySelector('.pool-row[data-sym="' + sym0 + '"] .wl-price') || {}).textContent;
  var beforeYld = (document.querySelector('.pool-row[data-sym="' + sym0 + '"] .wl-yld-t') || {}).textContent;
  XJ.fetcher.fetchQuotes = function(){ var q = {}; q[sym0] = { price: 100, prevClose: 90 }; return Promise.resolve(q); };
  XJ.views.pool.tickQuotes(true);
  await sleep(360);
  body = document.getElementById('view-body');
  out.live = {
    before: before, after: (body.querySelector('.pool-row[data-sym="' + sym0 + '"] .wl-price') || {}).textContent,
    beforeYld: beforeYld, afterYld: (body.querySelector('.pool-row[data-sym="' + sym0 + '"] .wl-yld-t') || {}).textContent,
    rows: body.querySelectorAll('.pool-row').length,
    sortKept: state().dir,
  };
  XJ.fetcher.fetchQuotes = realFetch;

  /* ④ 返回自选：history.back() 走 navTo 的返回栈；分叉时兜底 */
  history.back(); await sleep(380);
  if (XJ.store.ui.subPage === 'pool') XJ.store.setUI({ subPage: null, tab: 'watchlist' });
  await sleep(320);
  body = document.getElementById('view-body');
  out.back = {
    sub: XJ.store.ui.subPage, tab: XJ.store.ui.tab,
    rows: body.querySelectorAll('.wl-row').length,
    entry: !!body.querySelector('.pool-enter'),
    chips: body.querySelectorAll('.wl-chip').length,
    hasIndexBar: !!body.querySelector('.wl-topbar'),
    sortAll: XJ.wlSort.stateOf('all').dir,
  };
  return out;
})()`;

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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-pool-'));
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
    const wl = out.wl || {}, p = out.page || {}, n = out.nav || {};
    if (wl.entry && wl.hasIndexBar && wl.hasSearch && wl.chips >= 5 && wl.rows === 1)
      ok('① 自选页原结构完好（指数栏/搜索/chips/1 行）+ 股票池入口在位');
    else bad('自选页或入口异常 ' + JSON.stringify(wl));
    if (n.sub === 'pool' && n.title === '股票池') ok('② 真实 click 进入独立子页，顶栏标题切换');
    else bad('导航异常 ' + JSON.stringify(n));

    if (p.rows === 50) ok('③ ★ 50 只成分股完整展示（断网离线）');
    else bad('行数异常 ' + p.rows);
    if (p.hasPx && p.hasCode && !p.hasSpark && !p.hasDel)
      ok('④ 行字段顺序沿用自选、已去掉分时列与删除按钮');
    else bad('行布局异常 ' + JSON.stringify({ hasPx: p.hasPx, hasCode: p.hasCode, hasSpark: p.hasSpark, hasDel: p.hasDel }));
    if (p.imgs === 50 && p.dataLogos === 50 && p.txtAvatars === 0)
      ok('⑤ ★ 50 张官方 logo 内嵌，零中文首字母文字层');
    else bad('图标异常 ' + JSON.stringify({ imgs: p.imgs, dataLogos: p.dataLogos, txt: p.txtAvatars }));
    if (p.yld === 50 && p.pct === 50 && p.sortBtns === 2)
      ok('⑥ 每行都有息率 / 百分位字段，两个排序按钮在位');
    else bad('字段异常 ' + JSON.stringify({ yld: p.yld, pct: p.pct, sortBtns: p.sortBtns }));
    if (/2026-06-30/.test(p.head || '') && /近 3 年/.test(p.head || ''))
      ok('⑦ 页头标注数据日期与分位窗口');
    else bad('页头异常 ' + (p.head || '').slice(0, 80));

    const s1 = out.s1 || {}, s2 = out.s2 || {}, s3 = out.s3 || {}, s4 = out.s4 || {};
    if (s1.state && s1.state.field === 'yld' && s1.state.dir === 'desc' && s1.desc && s1.mark === '↓')
      ok('⑧ ★ 股息率首次点击 = 降序，箭头 ↓ + 高亮 + 状态文案');
    else bad('股息率降序异常 ' + JSON.stringify(s1));
    if (s2.state && s2.state.dir === 'asc' && s2.asc && s2.mark === '↑')
      ok('⑨ ★ 再点 = 升序，箭头 ↑，顺序正确');
    else bad('股息率升序异常 ' + JSON.stringify(s2));
    if (s3.state && s3.state.dir === 'none') ok('⑩ 三态回到无排序');
    else bad('三态异常 ' + JSON.stringify(s3));
    if (s4.state && s4.state.field === 'pct' && s4.state.dir === 'desc' && s4.desc && /百分位/.test(s4.onLabel || ''))
      ok('⑪ ★ 百分位独立可降序排序，排序态清晰');
    else bad('百分位排序异常 ' + JSON.stringify(s4));
    const iso = out.isolate || {};
    if (iso.all === 'none' && iso.holding === 'none') ok('⑫ 股票池排序态与自选分组完全隔离');
    else bad('排序态串组 ' + JSON.stringify(iso));

    const lv = out.live || {};
    if (lv.after === '100.00' && lv.before !== lv.after && lv.afterYld !== lv.beforeYld && lv.rows === 50 && lv.sortKept === 'desc')
      ok('⑬ ★ 实时价驱动价格 / 息率重算，50 行不丢、排序态保持');
    else bad('实时联动异常 ' + JSON.stringify(lv));

    const bk = out.back || {};
    if (bk.sub === null && bk.tab === 'watchlist' && bk.rows === 1 && bk.entry && bk.hasIndexBar && bk.sortAll === 'none')
      ok('⑭ ★ 返回后自选列表完好，未被股票池改动');
    else bad('返回异常 ' + JSON.stringify(bk));
  }
  browser.close();
} catch (e) {
  bad('探针异常: ' + (e && e.message || e));
} finally {
  try { chrome.kill(); } catch (e) {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}
console.log('\n[shoot-pool] ' + (fail ? '失败 ' + fail + ' 项' : '全部通过 ✅'));
process.exit(fail ? 1 : 0);
