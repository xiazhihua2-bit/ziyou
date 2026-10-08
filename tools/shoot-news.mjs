/* 三期新闻页 CDP 验收（离线）：时间轴结构 / 日期分组 / 实体与自选 pill /
 * 详情 sheet / 「仅查看自选」过滤 / 空态与手动刷新 / 320px 不溢出
 * 用法： node tools/shoot-news.mjs
 * 说明：newsCache 不进 fromImport 白名单（红线），所以探针在 init 之后直接写 state；
 *       离线模式下清空缓存会触发全量回看，两源即刻失败 → 快速收尾成空态，可断言。
 *       分步 evaluate：列表 / 详情 / 空态 / 320px 各自在「还在屏上」时截图。
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
const PORT = 9351;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 最小种子：一只持仓（中国平安），自选相关 pill 与「仅查看自选」过滤都靠它 */
const seed = {
  version: 6, createdAt: '2026-01-01T00:00:00Z',
  accounts: [{ accountId: 'acc_1', name: '主账户', type: 'BROKER', sortOrder: 1, createdAt: '2026-01-01T00:00:00Z' }],
  symbols: { sh601318: { name: '中国平安' } },
  transactions: [
    { txId: 'tx_1', accountId: 'acc_1', symbol: 'sh601318', action: 'BUY', date: '2026-01-05', quantity: 1000, price: 50, fee: 0 },
  ],
  plans: {}, received: [],
  expenses: [
    { expenseId: 'e1', key: 'MEALS', label: '三餐', icon: '🍱', monthlyAmount: 600, enabled: true, sortOrder: 1, category: 'essential' },
  ],
  projection: { configId: 'proj_default', monthlyInvest: 5000, years: 10, reinvestRatio: 1, divGrowthRate: 0, startAssets: null },
  settings: { id: 'app_settings', quoteRefreshMs: 60000, defaultAccountId: 'acc_1', onboarded: true },
  quoteCache: {}, priceHistory: {},
};

/* P1：init + 注入捏造缓存（covered + 新鲜 sweepMs → 不触发网络）+ 渲染列表 */
const P1 = `(async () => {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var out = {};
  var XJ = window.XJ;
  if (!(XJ && XJ.store && XJ.store.state)) { out.fatal = '未启动'; return out; }

  XJ.store.init(XJ.model.fromImport(SEED_JSON));
  XJ.store.ui.accountId = XJ.calc.ALL;

  var nowSec = Math.floor(Date.now() / 1000);
  var seedCache = {
    v: 1, sweepMs: Date.now(), newestAt: nowSec - 3600, covered: true, via: 'tapp',
    hits: [
      { id: 'ths_probe1', title: '伯克希尔宣布完成增持西方石油，斥资10亿美元',
        digest: '伯克希尔·哈撒韦提交的文件显示，加仓已在披露日前完成交割。',
        url: 'https://example.com/a', source: '同花顺', tags: ['异动'],
        ents: ['伯克希尔'], ctime: nowSec - 3600 },
      { id: 'ths_probe2', title: '中国平安完成派息，每股派发2.00元',
        digest: '', url: '', source: '同花顺', tags: [], ents: [], ctime: nowSec - 7200 },
      { id: 'sina_probe3', title: '李嘉诚家族增持长实集团股份',
        digest: '', url: '', source: '新浪7x24', tags: [],
        ents: ['李嘉诚', '长实集团'], ctime: nowSec - 86400 - 3600 },
    ],
  };
  XJ.store.state.newsCache = seedCache;
  window.SEED_CACHE = seedCache;      /* 留给 320px 环节重新铺底 */
  XJ.store.setUI({ tab: 'news', subPage: null });
  await sleep(420);

  var body = document.getElementById('view-body');
  var rows = Array.prototype.slice.call(body.querySelectorAll('.news-row'));
  out.list = {
    rows: rows.length,
    days: Array.prototype.slice.call(body.querySelectorAll('.news-day')).map(function (d) { return d.textContent; }),
    firstTime: ((rows[0] && rows[0].querySelector('.nr-time')) || {}).textContent || '',
    firstTitle: ((rows[0] && rows[0].querySelector('.nr-tt')) || {}).textContent || '',
    bluePills: Array.prototype.slice.call(rows[0].querySelectorAll('.pill.blue')).map(function (p) { return p.textContent; }),
    goldPills: Array.prototype.slice.call(rows[1].querySelectorAll('.pill.gold')).map(function (p) { return p.textContent; }),
    hasFooter: (body.textContent || '').indexOf('不构成投资建议') >= 0,
    hasSwitch: !!body.querySelector('.news-ctl .switch'),
  };
  return out;
})()`;

/* P2：详情 sheet → 关闭 → 仅查看自选开/关 */
const P2 = `(async () => {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var out = {};
  var XJ = window.XJ;
  var rows = Array.prototype.slice.call(document.querySelectorAll('#view-body .news-row'));

  if (rows[0]) rows[0].click();
  await sleep(340);
  var sheet = document.querySelector('.sheet');
  out.sheet = sheet ? {
    title: ((sheet.querySelector('.nd-tt')) || {}).textContent || '',
    metaOk: /^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} · /.test((((sheet.querySelector('.nd-meta')) || {}).textContent || '').trim()),
    hasLink: !!sheet.querySelector('a.btn-block[href]'),
    hasRedLine: (sheet.textContent || '').indexOf('不构成投资建议') >= 0,
  } : null;
  if (XJ.ui) XJ.ui.closeSheet(true);
  await sleep(150);

  var sw = document.querySelector('.news-ctl .switch input');
  if (sw) sw.click();
  await sleep(340);
  var rows2 = Array.prototype.slice.call(document.querySelectorAll('#view-body .news-row'));
  out.wlOnly = {
    count: rows2.length,
    first: ((rows2[0] && rows2[0].querySelector('.nr-tt')) || {}).textContent || '',
  };
  var sw2 = document.querySelector('.news-ctl .switch input');
  if (sw2) sw2.click();               /* 关回去 */
  await sleep(320);
  out.wlOnly.restored = document.querySelectorAll('#view-body .news-row').length;
  return out;
})()`;

/* P3：离线全量回看 —— 清缓存 → sweep 两源即刻失败 → 快速收尾为空态 */
const P3 = `(async () => {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var out = {};
  var XJ = window.XJ;
  XJ.store.state.newsCache = null;
  XJ.store.setUI({ newsTick: Date.now() });
  await sleep(1400);
  var b2 = document.getElementById('view-body');
  out.empty = {
    covered: !!(XJ.store.state.newsCache && XJ.store.state.newsCache.covered),
    text: (b2.textContent || '').indexOf('近 7 天无相关动态') >= 0,
    hasRefresh: !!b2.querySelector('[data-act="newsRefresh"]'),
    noRows: !b2.querySelector('.news-row'),
  };
  return out;
})()`;

/* P4 准备：重新铺底命中列表（320px 量测前），由 Node 单独 evaluate */

/* ---------------- CDP 直连（与 shoot-tabs 同款极简客户端） ---------------- */
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
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-news-'));
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
const shotDir = path.join(PROJ, 'shots', 'news');
fs.mkdirSync(shotDir, { recursive: true });
async function shot(browser, sessionId, name) {
  try {
    const s = await browser.send('Page.captureScreenshot', {}, sessionId);
    const data = s && (s.data || (s.result && s.result.data));
    if (!data) { console.log('  ⚠️ 截图数据为空: ' + name); return; }
    fs.writeFileSync(path.join(shotDir, name), Buffer.from(data, 'base64'));
    console.log('  📸 shots/news/' + name);
  } catch (e) { console.log('  ⚠️ 截图失败 ' + name + ': ' + e.message); }
}
async function evaluate(browser, sessionId, expression) {
  const r = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  return r.result ? (r.result.value || {}) : {};
}

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

  /* ---- P1 列表 ---- */
  const out1 = await evaluate(browser, sessionId, P1);
  const errs = browser.events.filter((m) => (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') || m.method === 'Runtime.exceptionThrown');
  if (errs.length) bad('控制台错误: ' + JSON.stringify(errs.slice(0, 2)).slice(0, 300)); else ok('控制台零错误');

  if (out1.fatal) bad(out1.fatal);
  else {
    const ls = out1.list || {};
    if (ls.rows === 3) ok('① 时间轴 3 条命中全部渲染'); else bad('行数异常 ' + ls.rows);
    if ((ls.days || []).length === 2 && (ls.days[0] || '').indexOf('今天') >= 0 && (ls.days[1] || '').indexOf('昨天') >= 0)
      ok('★ 日期分组：' + (ls.days || []).join(' / '));
    else bad('日期分组异常 ' + JSON.stringify(ls.days));
    if (/^\d{2}:\d{2}$/.test(ls.firstTime || '')) ok('★ 行内时间 = HH:MM（' + ls.firstTime + '）'); else bad('时间格式异常 ' + ls.firstTime);
    if ((ls.firstTitle || '').indexOf('伯克希尔') >= 0) ok('★ 最新一条在最前（ctime 降序）'); else bad('排序异常 ' + ls.firstTitle);
    if ((ls.bluePills || []).join(',') === '伯克希尔') ok('★ 实体 pill（蓝）在位'); else bad('实体 pill 异常 ' + JSON.stringify(ls.bluePills));
    if ((ls.goldPills || []).join(',') === '中国平安') ok('★ 自选相关 pill（分红金）在位'); else bad('自选 pill 异常 ' + JSON.stringify(ls.goldPills));
    if (ls.hasFooter) ok('③ 红线页脚在位（不构成投资建议）'); else bad('缺红线页脚');
    if (ls.hasSwitch) ok('③ 「仅查看自选」开关在位'); else bad('缺自选开关');
  }
  await shot(browser, sessionId, 'news-list.png');

  /* ---- P2 详情 + 自选过滤 ---- */
  const out2 = await evaluate(browser, sessionId, P2);
  const sh = (out2.sheet || {});
  if (sh.title && sh.title.indexOf('伯克希尔') >= 0) ok('④ 详情 sheet：全文标题在位'); else bad('sheet 标题异常 ' + JSON.stringify(sh.title || null));
  if (sh.metaOk) ok('★ 详情时间 = YYYY-MM-DD HH:MM · 来源'); else bad('sheet 时间格式异常');
  if (sh.hasLink) ok('★ 阅读原文链接在位'); else bad('缺原文链接');
  if (sh.hasRedLine) ok('★ 详情页脚也带红线'); else bad('详情缺红线');

  const wo = (out2.wlOnly || {});
  if (wo.count === 1 && (wo.first || '').indexOf('中国平安') >= 0)
    ok('★ 「仅查看自选」开：3 → 1 条，只留自选标的');
  else bad('自选过滤异常 count=' + wo.count + ' first=' + wo.first);
  if (wo.restored === 3) ok('★ 「仅查看自选」关：恢复 3 条'); else bad('关回后行数异常 ' + wo.restored);

  /* ---- P3 离线回看 → 空态 ---- */
  const out3 = await evaluate(browser, sessionId, P3);
  const em = (out3.empty || {});
  if (em.covered) ok('⑤ 离线回看快速收尾（covered=true，不留悬挂进度）'); else bad('回看未收尾');
  if (em.text) ok('★ 空态文案「近 7 天无相关动态」'); else bad('空态文案缺失');
  if (em.hasRefresh) ok('★ 空态带手动刷新按钮'); else bad('空态缺刷新按钮');
  if (em.noRows) ok('★ 空态无残留行'); else bad('空态仍有残留行');
  await shot(browser, sessionId, 'news-empty.png');

  /* ---- P4 320px 窄屏（重新铺底命中列表再量） ---- */
  await evaluate(browser, sessionId,
    '(function(){ XJ.store.state.newsCache = window.SEED_CACHE; XJ.store.setUI({ newsTick: Date.now(), wlNewsOnly: false }); return 1; })()');
  await sleep(500);
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 2, mobile: true }, sessionId);
  await sleep(500);
  const dim = await evaluate(browser, sessionId,
    '({ w: document.documentElement.scrollWidth, iw: window.innerWidth, rows: document.querySelectorAll("#view-body .news-row").length })');
  if (dim.w && dim.iw && dim.w <= dim.iw && dim.rows === 3)
    ok('★ 320px 窄屏零横向溢出（scrollWidth ' + dim.w + ' ≤ ' + dim.iw + '，列表 3 行）');
  else bad('320px 溢出或行数异常 ' + JSON.stringify(dim));
  await shot(browser, sessionId, 'news-320.png');

  browser.close();
} catch (e) {
  bad('异常: ' + (e && e.message ? e.message : String(e)));
} finally {
  try { chrome.kill(); } catch (e) { /* ignore */ }
}

console.log(fail ? '\\n[news] 失败 ' + fail + ' 项 ✗' : '\\n[news] 全部通过 ✓');
process.exit(fail ? 1 : 0);
