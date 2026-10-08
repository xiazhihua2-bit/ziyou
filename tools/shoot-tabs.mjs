/* 一期 Tab 栏 CDP 验收：浮动胶囊 + 六 Tab + 填充图标 + 品牌绿选中态 + 长按拖拽排序 + 防误触
 * 用法： node tools/shoot-tabs.mjs
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
const PORT = 9349;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 最小种子（一期只验 Tab 骨架，行情内容无关紧要） */
const seed = {
  version: 6, createdAt: '2026-01-01T00:00:00Z',
  accounts: [{ accountId: 'acc_1', name: '主账户', type: 'BROKER', sortOrder: 1, createdAt: '2026-01-01T00:00:00Z' }],
  symbols: {}, transactions: [], plans: {}, received: [],
  expenses: [
    { expenseId: 'e1', key: 'MEALS', label: '三餐', icon: '🍱', monthlyAmount: 600, enabled: true, sortOrder: 1, category: 'essential' },
  ],
  projection: { configId: 'proj_default', monthlyInvest: 5000, years: 10, reinvestRatio: 1, divGrowthRate: 0, startAssets: null },
  settings: { id: 'app_settings', quoteRefreshMs: 60000, defaultAccountId: 'acc_1', onboarded: true },
  quoteCache: {}, priceHistory: {},
};

const PROBE = `(async () => {
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  var out = {};
  var XJ = window.XJ;
  if (!(XJ && XJ.store && XJ.store.state)) { out.fatal = '未启动'; return out; }

  XJ.store.init(XJ.model.fromImport(SEED_JSON));
  XJ.store.ui.accountId = XJ.calc.ALL;
  XJ.store.setUI({ tab: 'overview', subPage: null });
  await sleep(400);

  var bar = document.querySelector('.tabbar-inner');
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tabbar-inner .tab'));
  out.tabs = {
    count: tabs.length,
    ids: tabs.map(function (t) { return t.getAttribute('data-tab'); }),
    labels: tabs.map(function (t) { return (t.querySelector('span') || {}).textContent; }),
    filledIcons: tabs.every(function (t) { return t.querySelector('svg path[fill="currentColor"]'); }),
    barWidth: bar ? bar.offsetWidth : null,
    viewport: window.innerWidth,
  };

  /* 选中态：品牌绿 + 药丸底；未选中：灰 */
  var act = document.querySelector('.tab.active');
  var idle = document.querySelector('.tab:not(.active)');
  var csA = act ? getComputedStyle(act) : null;
  var csI = idle ? getComputedStyle(idle) : null;
  out.style = {
    activeId: act ? act.getAttribute('data-tab') : null,
    activeColor: csA ? csA.color : null,
    activeBg: csA ? csA.backgroundColor : null,
    idleColor: csI ? csI.color : null,
  };

  /* 占位页：自选（二期）→ 新闻（三期）→ 回持仓 */
  var clickTab = function (id) {
    var el = document.querySelector('.tab[data-tab="' + id + '"]');
    if (el) el.click();
  };
  clickTab('watchlist'); await sleep(420);
  var w = document.getElementById('view-body');
  out.watchlistPage = {
    hasIndexBar: !!w.querySelector('.wl-topbar'),
    hasChips: w.querySelectorAll('.wl-chip').length >= 5,   // 全部/持仓/美股/港股/A股
    chipLabels: Array.prototype.slice.call(w.querySelectorAll('.wl-chip')).map(function (c) { return c.textContent; }),
  };
  clickTab('news'); await sleep(300);
  var n = document.getElementById('view-body').textContent || '';
  out.newsPage = { hasHint: n.indexOf('三期') >= 0 };
  clickTab('overview'); await sleep(300);
  out.backHome = { ok: !XJ.store.ui.subPage && XJ.store.ui.tab === 'overview' };

  /* ---- 长按拖拽：把第 2 个 Tab（自选）拖到第 5 位 ---- */
  function center(el) {
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  function pe(type, x, y, target) {
    var ev = new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 7, isPrimary: true });
    (target || document.querySelector('.tabbar-inner')).dispatchEvent(ev);
  }
  var orderBefore = tabs.map(function (t) { return t.getAttribute('data-tab'); });
  var dragEl = document.querySelector('.tab[data-tab="watchlist"]');
  var c = center(dragEl);
  pe('pointerdown', c.x, c.y, dragEl);
  await sleep(430);                       /* 越过长按阈值 */
  var slot5 = document.querySelectorAll('.tabbar-inner .tab')[4];
  var c5 = center(slot5);
  var steps = 8;
  for (var i = 1; i <= steps; i++) {
    pe('pointermove', c.x + (c5.x - c.x) * i / steps, c.y + (c5.y - c.y) * i / steps, dragEl);
    await sleep(24);
  }
  pe('pointerup', c5.x + 6, c5.y, dragEl);
  var justAfter = XJ.dnd.isJustDragged();   /* pointerup 后立刻读防误触标记 */
  await sleep(460);                       /* 越过 350ms 防误触窗口 */
  var tabs2 = Array.prototype.slice.call(document.querySelectorAll('.tabbar-inner .tab'));
  out.drag = {
    justDragged: justAfter,
    persisted: JSON.stringify(XJ.store.state.settings.tabOrder),
    idsAfter: tabs2.map(function (t) { return t.getAttribute('data-tab'); }),
    activeStill: (document.querySelector('.tab.active') || {}).getAttribute
      ? document.querySelector('.tab.active').getAttribute('data-tab') : null,
    orderBefore: orderBefore.join(','),
  };

  /* 拖完点一下别的 Tab：正常切换（防误触窗口已过） */
  clickTab('find'); await sleep(280);
  out.tapAfter = { active: XJ.store.ui.tab };
  clickTab('overview'); await sleep(280);
  return out;
})()`;

/* ---------------- CDP 直连（与 shoot-overview 同款极简客户端） ---------------- */
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-tabs-'));
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
    const tb = out.tabs || {};
    const DEF = 'overview,watchlist,calendar,news,find,mine';
    if (tb.count === 6 && tb.ids.join(',') === DEF)
      ok('① 六 Tab 默认顺序 = 持仓/自选/日历/新闻/FIRE/我的');
    else bad('Tab 结构异常 ' + tb.count + ' [' + (tb.ids || []).join(',') + ']');
    if ((tb.labels || []).join('/') === '持仓/自选/日历/新闻/FIRE/我的')
      ok('① 标签 = ' + (tb.labels || []).join(' / '));
    else bad('标签异常 ' + JSON.stringify(tb.labels));
    if (tb.filledIcons) ok('★ 六枚填充式图标（tab-* 字形）全部在位'); else bad('存在未填充的 Tab 图标');
    if (tb.barWidth && tb.viewport && tb.barWidth <= tb.viewport - 20)
      ok('★ 胶囊宽度 ' + tb.barWidth + 'px ≤ 视口 ' + tb.viewport + 'px（320px 窄屏不溢出）');
    else bad('胶囊宽度异常 ' + tb.barWidth + ' @ ' + tb.viewport);

    const st = out.style || {};
    if (st.activeId === 'overview' && st.activeColor && st.activeColor.replace(/\s/g, '') === 'rgb(0,181,120)')
      ok('★ 选中态 = 品牌绿 #00B578（' + st.activeColor + '）');
    else bad('选中态颜色异常 ' + st.activeColor);
    if (st.activeBg && st.activeBg !== 'rgba(0, 0, 0, 0)')
      ok('★ 选中项有药丸底（' + st.activeBg + '）');
    else bad('选中项缺药丸底');
    if (st.idleColor && st.idleColor !== st.activeColor) ok('★ 未选中态 = 灰（' + st.idleColor + '）'); else bad('未选中态异常');

    if (out.watchlistPage && out.watchlistPage.hasIndexBar && out.watchlistPage.hasChips)
      ok('② 自选页真身就位（指数栏 + 分组 chips：' + (out.watchlistPage.chipLabels || []).join('/') + '）');
    else bad('自选页异常 ' + JSON.stringify(out.watchlistPage));
    if (out.newsPage && out.newsPage.hasHint) ok('③ 新闻页占位（三期提示）在位'); else bad('新闻占位异常');
    if (out.backHome && out.backHome.ok) ok('③ 切回持仓正常'); else bad('切回持仓异常');

    const dg = out.drag || {};
    if (dg.justDragged === true) ok('★ 拖拽后 350ms 防误触窗口生效'); else bad('防误触标记缺失');
    var persistedArr = [];
    try { persistedArr = JSON.parse(dg.persisted || '[]'); } catch (e) { /* 脏值 */ }
    if (persistedArr.length === 6 && persistedArr[4] === 'watchlist')
      ok('★ 长按拖拽生效：自选移至第 5 位，settings.tabOrder 已持久化（' + persistedArr.join(',') + '）');
    else bad('拖拽排序异常 before=[' + dg.orderBefore + '] after=[' + (dg.idsAfter || []).join(',') + '] persisted=' + dg.persisted);
    if (dg.idsAfter && dg.persisted && dg.idsAfter.join(',') === String(dg.persisted).replace(/[\[\]"]/g, '').split(',').join(','))
      ok('★ 视觉顺序与持久化顺序一致（重渲染零跳变）');
    else bad('视觉顺序 ≠ 持久化顺序 ' + dg.idsAfter + ' vs ' + dg.persisted);
    if (dg.activeStill === 'overview') ok('★ 拖拽不改变当前激活 Tab'); else bad('拖拽改变激活 Tab: ' + dg.activeStill);
    if (out.tapAfter && out.tapAfter.active === 'find') ok('★ 防误触窗口过后点击正常切 Tab'); else bad('拖后点击异常 ' + JSON.stringify(out.tapAfter));
  }

  await browser.send('Page.captureScreenshot', {}, sessionId).then(async (shot) => {
    const data = shot && (shot.data || (shot.result && shot.result.data));
    if (!data) { console.log('  ⚠️ 截图数据为空'); return; }
    const dir = path.join(PROJ, 'shots', 'tabs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tabs.png'), Buffer.from(data, 'base64'));
    console.log('  📸 shots/tabs/tabs.png');
  }).catch((e) => console.log('  ⚠️ 截图失败: ' + e.message));

  browser.close();
} catch (e) {
  bad('异常: ' + (e && e.message ? e.message : String(e)));
} finally {
  try { chrome.kill(); } catch (e) {}
}

console.log(fail ? '\\n[tabs] 失败 ' + fail + ' 项 ✗' : '\\n[tabs] 全部通过 ✓');
process.exit(fail ? 1 : 0);
