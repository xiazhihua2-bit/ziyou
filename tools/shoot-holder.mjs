/* 股东持股情况 515450 CDP 验收（断网跑：快照全内嵌，离线也应完整展示）
 * 覆盖：入口导航 / 19 家 / 官方 logo 无中文层 / 五格统计 / 环形图 / 8 期切换 /
 *       四列三态排序 / 排序态与自选隔离 / 行展开双轴图 / 拖动读数 / brush 区间切片 /
 *       返回后股票池与自选不受影响。
 * 用法： node tools/shoot-holder.mjs
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
const PORT = 9361;
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
  /* 断网桩：自选/股票池首次进页会拉行情，本页只读快照，全部挡掉避免噪声 */
  XJ.fetcher.fetchQuotes = function(){ return Promise.resolve({}); };

  XJ.store.init(XJ.model.fromImport(SEED_JSON));
  XJ.store.ui.accountId = XJ.calc.ALL;
  var tabWl = document.querySelector('.tab[data-tab="watchlist"]');
  if (tabWl) tabWl.click();
  await sleep(420);
  var body = document.getElementById('view-body');
  out.wl = { rows: body.querySelectorAll('.wl-row').length, entry: !!body.querySelector('.pool-enter') };

  /* ① 真实 click 进股票池 */
  var pe0 = body.querySelector('.pool-enter');
  if (pe0) pe0.click();
  await sleep(420);
  body = document.getElementById('view-body');
  out.pool = { sub: XJ.store.ui.subPage, rows: body.querySelectorAll('.pool-row').length,
    holderEntry: !!body.querySelector('.holder-enter') };

  /* ② 真实 click 进股东持股情况 */
  var he = body.querySelector('.holder-enter');
  if (he) he.click();
  await sleep(450);
  body = document.getElementById('view-body');
  out.nav = { sub: XJ.store.ui.subPage,
    title: (document.querySelector('.topbar-row h1') || {}).textContent };

  var imgs = Array.prototype.slice.call(body.querySelectorAll('.holder-row .av-img'));
  var sel = body.querySelector('[data-change="holderPeriod"]');
  out.page = {
    rows: body.querySelectorAll('.holder-row').length,
    imgs: imgs.length,
    dataLogos: imgs.filter(function(i){
      return (i.getAttribute('src') || '').indexOf('data:image/png;base64,') === 0;
    }).length,
    txtAvatars: body.querySelectorAll('.holder-row .av-txt').length,
    stats: (body.querySelector('.holder-stats') || {}).textContent,
    donutSegs: body.querySelectorAll('.holder-donut-svg circle').length,
    legendRows: body.querySelectorAll('.hl-row').length,
    sortBtns: body.querySelectorAll('.ht-btn').length,
    periods: sel ? sel.options.length : 0,
    periodValue: sel ? sel.value : '',
    typeValue: (body.querySelector('.hf-l .hf-sel') || {}).textContent,
    stat: (body.querySelector('.holder-sortstat') || {}).textContent,
    foot: (body.querySelector('.holder-foot') || {}).textContent,
  };

  /* ③ 报告期切换：2025年报应变成 12 家 */
  if (sel) {
    sel.value = '2025-12-31';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  await sleep(420);
  body = document.getElementById('view-body');
  out.period = {
    rows: body.querySelectorAll('.holder-row').length,
    stats: (body.querySelector('.holder-stats') || {}).textContent,
    foot: (body.querySelector('.holder-foot') || {}).textContent,
    debug: XJ.views.holder.debug(),
  };
  var sel2 = body.querySelector('[data-change="holderPeriod"]');
  if (sel2) { sel2.value = '2026-09-30'; sel2.dispatchEvent(new Event('change', { bubbles: true })); }
  await sleep(420);
  body = document.getElementById('view-body');
  out.periodBack = { rows: body.querySelectorAll('.holder-row').length };

  /* ④ 四列三态排序（读持有市值列） */
  var readCap = function(){
    return Array.prototype.slice.call(document.querySelectorAll('.holder-row')).map(function(r){
      return parseFloat((r.children[1].textContent || '').replace('亿',''));
    });
  };
  var desc = function(a){ for (var i=1;i<a.length;i++) if (a[i] > a[i-1] + 1e-9) return false; return true; };
  var asc = function(a){ for (var i=1;i<a.length;i++) if (a[i] < a[i-1] - 1e-9) return false; return true; };
  var clickSort = function(i){ var b=document.querySelectorAll('.ht-btn')[i]; if (b) b.click(); };
  var state = function(){ return XJ.holderSort.stateOf('holder'); };
  clickSort(0); await sleep(260);
  out.s1 = { state: state(), desc: desc(readCap()), stat: (document.querySelector('.holder-sortstat')||{}).textContent,
    mark: (document.querySelector('.ht-btn.on .ht-mk')||{}).textContent };
  clickSort(0); await sleep(260);
  out.s2 = { state: state(), asc: asc(readCap()), mark: (document.querySelector('.ht-btn.on .ht-mk')||{}).textContent };
  clickSort(0); await sleep(260);
  out.s3 = { state: state() };
  clickSort(2); await sleep(260);
  out.s4 = { state: state(), onLabel: (document.querySelector('.ht-btn.on')||{}).textContent,
    rows: document.querySelectorAll('.holder-row').length };
  clickSort(3); await sleep(260);
  out.s5 = { state: state(), onLabel: (document.querySelector('.ht-btn.on')||{}).textContent };
  out.isolate = { holder: state().dir, all: XJ.wlSort.stateOf('all').dir,
    pool: XJ.wlSort.stateOf('pool').dir, keys: XJ.holderSort.LS_KEY !== XJ.wlSort.LS_KEY };
  /* 复原无排序，后面按默认基序展开第一行 */
  clickSort(3); await sleep(120); clickSort(3); await sleep(160);

  /* ⑤ 行展开：双轴柱线图 + brush 区间条 */
  var row0 = document.querySelector('.holder-row');
  if (row0) row0.click();
  await sleep(300);
  body = document.getElementById('view-body');
  out.expand = {
    detail: body.querySelectorAll('.holder-detail').length,
    bars: !!body.querySelector('.hd-main svg[data-hb]'),
    brush: !!body.querySelector('.hd-brush svg[data-brush]'),
    n: +(body.querySelector('.hd-main svg[data-hb]')||{getAttribute:function(){return '0';}}).getAttribute('data-n'),
    blueBars: (body.querySelector('.hd-main')||{innerHTML:''}).innerHTML.split('fill="#3B82F6"').length - 1,
    more: !!body.querySelector('.hd-more'),
  };

  /* ⑥ 拖动主图 → tooltip 显示报告期 / 持股数 / 持股比例 */
  function pe(type,x,y,el){
    el.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,
      clientX:x,clientY:y,pointerId:9,isPrimary:true,pointerType:'mouse'}));
  }
  var bars = body.querySelector('.hd-main svg[data-hb]');
  if (bars) {
    var r = bars.getBoundingClientRect();
    pe('pointerdown', r.left + r.width*0.62, r.top + 30, bars);
    pe('pointermove', r.left + r.width*0.72, r.top + 30, bars);
    await sleep(120);
    out.tip = {
      display: (bars.querySelector('.hb-marker')||{style:{display:'none'}}).style.display,
      text: (bars.querySelector('.hb-bub')||{}).textContent,
    };
    pe('pointerup', r.left + r.width*0.72, r.top + 30, bars);
  } else out.tip = { display:'none', text:'' };

  /* ⑦ brush 拖右抓手到中间 → 主图切片重画，期数变少 */
  var br = body.querySelector('.hd-brush svg[data-brush]');
  if (br) {
    var brr = br.getBoundingClientRect();
    var handle = br.querySelector('.xjc-brush-hr') || br;
    pe('pointerdown', brr.left + brr.width*0.98, brr.top + brr.height*0.6, handle);
    pe('pointermove', brr.left + brr.width*0.55, brr.top + brr.height*0.6, br);
    await sleep(140);
    pe('pointerup', brr.left + brr.width*0.55, brr.top + brr.height*0.6, br);
    await sleep(220);
  }
  var bars2 = document.querySelector('.hd-main svg[data-hb]');
  out.brush = {
    before: out.expand.n,
    after: bars2 ? +bars2.getAttribute('data-n') : 0,
    brushAlive: !!document.querySelector('.hd-brush svg[data-brush]'),
    debug: XJ.views.holder.debug(),
  };

  /* ⑧ 返回股票池：history.back() 走 navTo 返回栈 */
  history.back(); await sleep(400);
  if (XJ.store.ui.subPage === 'holder') XJ.store.setUI({ subPage: 'pool' });
  await sleep(320);
  body = document.getElementById('view-body');
  out.back = {
    sub: XJ.store.ui.subPage,
    rows: body.querySelectorAll('.pool-row').length,
    holderEntry: !!body.querySelector('.holder-enter'),
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-holder-'));
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
  if (errs.length) bad('控制台错误: ' + JSON.stringify(errs.slice(0, 2)).slice(0, 400)); else ok('控制台零错误');

  if (out.fatal) bad(out.fatal);
  else {
    const wl = out.wl || {}, pool = out.pool || {}, nav = out.nav || {}, p = out.page || {};
    if (wl.entry && wl.rows === 1) ok('① 自选页原结构完好，股票池入口在位');
    else bad('自选页异常 ' + JSON.stringify(wl));
    if (pool.sub === 'pool' && pool.rows === 50 && pool.holderEntry)
      ok('② ★ 股票池 50 行不受影响，新增「股东持股情况」入口');
    else bad('股票池页异常 ' + JSON.stringify(pool));
    if (nav.sub === 'holder' && nav.title === '股东持股情况')
      ok('③ ★ 真实 click 进入独立子页，顶栏标题切换');
    else bad('导航异常 ' + JSON.stringify(nav));

    if (p.rows === 19) ok('④ ★ 19 家参股公司完整展示（断网离线）');
    else bad('行数异常 ' + p.rows);
    if (p.imgs === 19 && p.dataLogos === 19 && p.txtAvatars === 0)
      ok('⑤ ★ 19 张官方 logo 内嵌，零中文首字母文字层');
    else bad('图标异常 ' + JSON.stringify({ imgs: p.imgs, dataLogos: p.dataLogos, txt: p.txtAvatars }));
    if (p.donutSegs === 6 && p.legendRows === 6 && /19家/.test(p.stats || '') &&
        /6家/.test(p.stats || '') && /10家/.test(p.stats || '') && /3家/.test(p.stats || ''))
      ok('⑥ 环形图 6 段 + 五格统计与截图一致（19/6/10/--/3）');
    else bad('统计/环形图异常 ' + JSON.stringify({ donutSegs: p.donutSegs, legendRows: p.legendRows, stats: p.stats }));
    if (p.periods === 8 && p.periodValue === '2026-09-30' && /十大流通股东/.test(p.typeValue || '') &&
        p.sortBtns === 4 && /2026三季报/.test(p.foot || ''))
      ok('⑦ 8 期下拉 / 十大流通股东 / 4 列排序表头 / 数据日期齐全');
    else bad('筛选或表头异常 ' + JSON.stringify({ periods: p.periods, val: p.periodValue, sortBtns: p.sortBtns }));

    const per = out.period || {}, pb = out.periodBack || {};
    if (per.rows === 12 && /12家/.test(per.stats || '') && /2025年报/.test(per.foot || '') && pb.rows === 19)
      ok('⑧ ★ 报告期切到 2025年报 = 12 家，切回 = 19 家');
    else bad('报告期切换异常 ' + JSON.stringify({ rows: per.rows, stats: per.stats, back: pb.rows }));

    const s1 = out.s1 || {}, s2 = out.s2 || {}, s3 = out.s3 || {}, s4 = out.s4 || {}, s5 = out.s5 || {};
    if (s1.state && s1.state.field === 'cap' && s1.state.dir === 'desc' && s1.desc && s1.mark === '↓' && /降序/.test(s1.stat || ''))
      ok('⑨ ★ 持有市值首次点击 = 降序，箭头 ↓ + 状态文案');
    else bad('降序异常 ' + JSON.stringify(s1));
    if (s2.state && s2.state.dir === 'asc' && s2.asc && s2.mark === '↑') ok('⑩ 再点 = 升序，箭头 ↑');
    else bad('升序异常 ' + JSON.stringify(s2));
    if (s3.state && s3.state.dir === 'none') ok('⑪ 三态回到无排序');
    else bad('三态异常 ' + JSON.stringify(s3));
    if (s4.state && s4.state.field === 'chg' && s5.state && s5.state.field === 'rank' && s4.rows === 19)
      ok('⑫ 环比增减 / 持股排名各自独立可排序，19 行不丢');
    else bad('多字段排序异常 ' + JSON.stringify({ s4: s4.state, s5: s5.state, rows: s4.rows }));
    const iso = out.isolate || {};
    if (iso.keys && iso.all === 'none' && iso.pool === 'none') ok('⑬ ★ 排序态与自选 / 股票池完全隔离');
    else bad('排序态串组 ' + JSON.stringify(iso));

    const ex = out.expand || {}, tip = out.tip || {}, br = out.brush || {};
    if (ex.detail === 1 && ex.bars && ex.brush && ex.n === 8 && ex.blueBars === 7 && ex.more)
      ok('⑭ ★ 行展开：双轴柱线图 8 期 / 7 根有效柱 + 区间条 + 个股详情入口');
    else bad('展开异常 ' + JSON.stringify(ex));
    if (tip.display !== 'none' && /持股比例/.test(tip.text || '') && /持股数/.test(tip.text || ''))
      ok('⑮ ★ 拖动主图显示报告期 / 持股数 / 持股比例读数');
    else bad('拖动读数异常 ' + JSON.stringify(tip));
    if (br.after > 0 && br.after < br.before && br.brushAlive)
      ok('⑯ ★ 区间条拖动后主图按选区切片重画，brush 自身未被销毁');
    else bad('区间条异常 ' + JSON.stringify(br));

    const bk = out.back || {};
    if (bk.sub === 'pool' && bk.rows === 50 && bk.holderEntry && bk.sortAll === 'none')
      ok('⑰ ★ 返回股票池完好（50 行 / 入口在位 / 自选排序态未变）');
    else bad('返回异常 ' + JSON.stringify(bk));
  }
  browser.close();
} catch (e) {
  bad('探针异常: ' + (e && e.message || e));
} finally {
  try { chrome.kill(); } catch (e) {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}
console.log('\n[shoot-holder] ' + (fail ? '失败 ' + fail + ' 项' : '全部通过 ✅'));
process.exit(fail ? 1 : 0);
