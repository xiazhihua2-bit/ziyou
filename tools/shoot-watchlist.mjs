/* 二期自选页 CDP 验收：指数栏 / 分组 chips / 虚拟组 / 列表行 / 分组管理（增删改名排序）/
 * 星标落组 / 同步增量（wgrp/witem op）。
 * 断网跑：行情与分时不可达，价格徽章应为「—」扁平态（结构断言不受影响）。
 * 用法： node tools/shoot-watchlist.mjs
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

const symRec = (sym, name) => ({ symbol: sym, code: sym.slice(2), market: sym.slice(0, 2), name, type: 'STOCK', updatedAt: '2026-01-01T00:00:00Z' });

const seed = {
  version: 6, createdAt: '2026-01-01T00:00:00Z',
  accounts: [{ accountId: 'acc_1', name: '主账户', type: 'BROKER', sortOrder: 1, createdAt: '2026-01-01T00:00:00Z' }],
  symbols: { usAAPL: symRec('usAAPL', '苹果'), hk00700: symRec('hk00700', '腾讯控股'), sh510880: symRec('sh510880', '红利ETF') },
  transactions: [
    { txId: 'tx_1', accountId: 'acc_1', symbol: 'sh600036', action: 'BUY', date: '2024-01-10', quantity: 2000, price: 33, fee: 5, note: '', createdAt: '2024-01-10T00:00:00Z' },
  ],
  plans: {}, received: [],
  expenses: [{ expenseId: 'e1', key: 'MEALS', label: '三餐', icon: '🍱', monthlyAmount: 600, enabled: true, sortOrder: 1, category: 'essential' }],
  projection: { configId: 'proj_default', monthlyInvest: 5000, years: 10, reinvestRatio: 1, divGrowthRate: 0, startAssets: null },
  settings: { id: 'app_settings', quoteRefreshMs: 60000, defaultAccountId: 'acc_1', onboarded: true },
  watchlist: {
    groups: [
      { groupId: 'wlg_us', name: '美股', sortOrder: 1, createdAt: '2026-01-01T00:00:00Z' },
      { groupId: 'wlg_hk', name: '港股', sortOrder: 2, createdAt: '2026-01-01T00:00:00Z' },
      { groupId: 'wlg_cn', name: 'A股', sortOrder: 3, createdAt: '2026-01-01T00:00:00Z' },
      { groupId: 'wlg_etf', name: '红利ETF', sortOrder: 4, createdAt: '2026-01-01T00:00:00Z' },
    ],
    items: [
      { itemId: 'wli_a1', groupId: 'wlg_us', symbol: 'usAAPL', addedAt: '2026-01-02T00:00:00Z' },
      { itemId: 'wli_h1', groupId: 'wlg_hk', symbol: 'hk00700', addedAt: '2026-01-03T00:00:00Z' },
      { itemId: 'wli_c1', groupId: 'wlg_etf', symbol: 'sh510880', addedAt: '2026-01-04T00:00:00Z' },
    ],
  },
  quoteCache: {}, priceHistory: {},
};

const PROBE = `(async () => {
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  var out = {};
  var XJ = window.XJ;
  if (!(XJ && XJ.store && XJ.store.state)) { out.fatal = '未启动'; return out; }

  XJ.store.init(XJ.model.fromImport(SEED_JSON));
  XJ.store.ui.accountId = XJ.calc.ALL;
  XJ.store.setUI({ tab: 'watchlist', subPage: null });
  await sleep(420);

  var body = document.getElementById('view-body');
  var chips = Array.prototype.slice.call(body.querySelectorAll('.wl-chip:not(.wl-more)'));
  out.chips = {
    labels: chips.map(function (c) { return c.textContent; }),
    more: !!body.querySelector('.wl-chip.wl-more'),
    active: (body.querySelector('.wl-chip.active') || {}).textContent,
    rows: body.querySelectorAll('.wl-row').length,
    hasIndexBar: !!body.querySelector('.wl-topbar'),
    hasSearchBtn: !!body.querySelector('.wl-search'),
  };

  /* 切「美股」组 → 1 行 */
  var pick = function (id) {
    var el = body.querySelector('.wl-chip[data-g="' + id + '"]');
    if (el) el.click();
  };
  pick('wlg_us'); await sleep(300);
  body = document.getElementById('view-body');
  out.grpUs = { rows: body.querySelectorAll('.wl-row').length, name: ((body.querySelector('.wl-row .wl-nm span') || {}).textContent) };

  /* 「持仓」虚拟组 → 种子持仓 1 行 + 持仓标记 + 无删除按钮 */
  pick('holding'); await sleep(300);
  body = document.getElementById('view-body');
  out.holding = {
    rows: body.querySelectorAll('.wl-row').length,
    tag: !!body.querySelector('.wl-tag'),
    noDel: !body.querySelector('.wl-del'),
  };

  /* 空组空态 */
  pick('wlg_cn'); await sleep(300);
  body = document.getElementById('view-body');
  out.empty = { hasEmpty: (body.textContent || '').indexOf('自选还是空的') >= 0, rows: body.querySelectorAll('.wl-row').length };

  /* ---- store API 语义 ---- */
  var S = XJ.store;
  out.api = {};
  S.wlAdd('wlg_cn', 'sz000858', '五粮液');
  out.api.added = S.wlHas('sz000858');
  S.wlAdd('wlg_cn', 'sz000858', '五粮液');
  out.api.dupOk = S.wlItems('wlg_cn').length === 1;
  var gNew = S.wlGroupAdd('科技');
  out.api.groupAdded = !!gNew;
  S.wlGroupRename(gNew, '科创新');
  out.api.renamed = (S.wlGroups().filter(function (g) { return g.groupId === gNew; })[0] || {}).name === '科创新';
  S.wlGroupRemove('wlg_etf');
  out.api.grpRemoved = !S.wlGroups().some(function (g) { return g.groupId === 'wlg_etf'; });
  out.api.cascade = !S.state.watchlist.items.some(function (it) { return it.itemId === 'wli_c1'; });
  S.wlGroupRemove('wlg_us');                     // 默认组：删除应被拒
  out.api.defaultKept = S.wlGroups().some(function (g) { return g.groupId === 'wlg_us'; });
  S.wlGroupReorder(['wlg_cn', 'wlg_hk', 'wlg_us', gNew]);
  out.api.reorder = S.wlGroups().map(function (g) { return g.name; }).join('/');

  /* 换组 / 移除 */
  var aapl = S.state.watchlist.items.filter(function (x) { return x.symbol === 'usAAPL'; })[0];
  S.wlMove(aapl.itemId, 'wlg_hk');
  out.api.moved = S.wlGroupOf('usAAPL') === 'wlg_hk';
  S.wlRemove(aapl.itemId);
  out.api.removed = !S.wlHas('usAAPL');

  /* ---- 同步增量：改动应产出 wgrp / witem op ---- */
  var diff = XJ.syncCore.diffToOps(S.state, { noQueue: true });
  out.sync = {
    wgrp: diff.ops.filter(function (o) { return o.t === 'wgrp'; }).length,
    witem: diff.ops.filter(function (o) { return o.t === 'witem'; }).length,
    snapshotWl: !!(XJ.syncCore.buildSnapshot(S.state).watchlist || {}).groups,
  };

  /* 回首页重渲染（wlGroup 状态保留 + 空组守卫） */
  await sleep(200);
  XJ.store.setUI({ tab: 'watchlist' });
  await sleep(320);
  body = document.getElementById('view-body');
  out.rerender = { ok: !!body.querySelector('.wl-chips'), curGroup: XJ.store.ui.wlGroup };

  /* ---- 指数切换 sheet ---- */
  var idxBtn = body.querySelector('[data-act="wlIndexPick"]');
  if (idxBtn) idxBtn.click(); await sleep(320);
  var cells = Array.prototype.slice.call(document.querySelectorAll('.sheet .wl-gcell'));
  out.idxSheet = { count: cells.length };
  var hsi = document.querySelector('.sheet .wl-gcell[data-k="hkHSI"]');
  if (hsi) hsi.click(); await sleep(260);
  out.idxSheet.picked = XJ.store.ui.wlIndex;
  out.idxSheet.closed = !document.querySelector('.sheet');

  /* ---- 分组弹层（图四） ---- */
  var more = body.querySelector('.wl-chip.wl-more');
  if (more) more.click(); await sleep(320);
  out.grpSheet = {
    cells: document.querySelectorAll('.sheet .wl-gcell').length,
    ops: document.querySelectorAll('.sheet .wl-gop').length,
  };
  var hkCell = document.querySelector('.sheet .wl-gcell[data-g="wlg_hk"]');
  if (hkCell) hkCell.click(); await sleep(260);
  out.grpSheet.picked = XJ.store.ui.wlGroup;
  out.grpSheet.closed = !document.querySelector('.sheet');

  /* ---- 管理弹层 + 纵向拖拽排序 ---- */
  var more2 = document.querySelector('#view-body .wl-chip.wl-more');
  if (more2) more2.click(); await sleep(300);
  var mg = document.querySelector('.sheet [data-act="openWlManage"]');
  if (mg) mg.click(); await sleep(340);
  var rows = Array.prototype.slice.call(document.querySelectorAll('#wl-gm-list .wl-gm-row'));
  out.manage = {
    rows: rows.length,
    ids: rows.map(function (r) { return r.getAttribute('data-g'); }),
    defaultDelDisabled: (function () {
      var b = document.querySelector('#wl-gm-list .wl-gm-row[data-g="wlg_us"] .gm-btn.danger');
      return b ? b.disabled : null;
    })(),
  };
  /* 纵向拖：把第一行拖过第二行中心（换位） */
  function center(el) { var r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
  function pe(type, x, y, target) {
    (target || document.getElementById('wl-gm-list')).dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 9, isPrimary: true }));
  }
  if (rows.length >= 2) {
    var dEl = rows[0];
    var c0 = center(dEl), c1 = center(rows[1]);
    pe('pointerdown', c0.x, c0.y, dEl);
    await sleep(430);
    var steps = 6;
    for (var i = 1; i <= steps; i++) {
      pe('pointermove', c0.x + (c1.x - c0.x) * i / steps, c0.y + (c1.y - c0.y) * i / steps, dEl);
      await sleep(26);
    }
    pe('pointerup', c1.x, c1.y + 4, dEl);
    await sleep(420);
    var after = Array.prototype.slice.call(document.querySelectorAll('#wl-gm-list .wl-gm-row'));
    out.manage.idsAfterDrag = after.map(function (r) { return r.getAttribute('data-g'); });
    out.manage.persisted = S.wlGroups().map(function (g) { return g.groupId; }).join(',');
  }
  return out;
})()`;

/* ---------------- CDP 直连（同款极简客户端） ---------------- */
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-wl-'));
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
    const ch = out.chips || {};
    if (ch.hasIndexBar && ch.hasSearchBtn) ok('① 指数栏 + 搜索框在位（图三布局）'); else bad('顶栏异常 ' + JSON.stringify(ch));
    if (ch.labels && ch.labels.join('/') === '全部/持仓/美股/港股/A股/红利ETF')
      ok('★ 分组 chips = ' + ch.labels.join(' / '));
    else bad('chips 异常 ' + JSON.stringify(ch.labels));
    if (ch.more && ch.rows === 3 && ch.active === '全部')
      ok('★ 「全部」= 3 条自选（并集），三条杠在位');
    else bad('列表异常 rows=' + ch.rows + ' active=' + ch.active);

    if (out.grpUs && out.grpUs.rows === 1 && out.grpUs.name === '苹果')
      ok('★ 切「美股」→ 只显示苹果（分组过滤生效）');
    else bad('美股分组异常 ' + JSON.stringify(out.grpUs));

    const hd = out.holding || {};
    if (hd.rows === 1 && hd.tag && hd.noDel)
      ok('★ 「持仓」虚拟组：跟随真实持仓、带持仓标记、不可删');
    else bad('持仓虚拟组异常 ' + JSON.stringify(hd));

    if (out.empty && out.empty.hasEmpty && out.empty.rows === 0) ok('★ 空组显示空态'); else bad('空态异常 ' + JSON.stringify(out.empty));

    const api = out.api || {};
    if (api.added && api.dupOk) ok('★ wlAdd：加入成功 + 同组同代码去重'); else bad('wlAdd 异常 ' + JSON.stringify(api));
    if (api.groupAdded && api.renamed) ok('★ 新增分组 + 重命名生效'); else bad('分组增改异常');
    if (api.grpRemoved && api.cascade) ok('★ 删组级联删除组内自选'); else bad('删组异常');
    if (api.defaultKept) ok('★ 默认组不可删除'); else bad('默认组被误删');
    if (api.reorder) ok('★ 组排序生效（' + api.reorder + '）'); else bad('排序异常');
    if (api.moved && api.removed) ok('★ 换组 / 移除生效'); else bad('移除异常 ' + JSON.stringify(api));

    const sy = out.sync || {};
    if (sy.wgrp > 0 && sy.witem > 0 && sy.snapshotWl)
      ok('★ 同步增量：wgrp×' + sy.wgrp + ' + witem×' + sy.witem + '，快照带 watchlist');
    else bad('同步增量异常 ' + JSON.stringify(sy));

    const rr = out.rerender || {};
    if (rr.ok) ok('★ 重渲染正常（当前组记忆保留：' + (rr.curGroup || '—') + '）'); else bad('重渲染异常');

    const ix = out.idxSheet || {};
    if (ix.count === 8) ok('★ 指数切换弹层 = 8 个指数'); else bad('指数弹层异常 ' + ix.count);
    if (ix.picked === 'hkHSI' && ix.closed) ok('★ 点恒生指数即时切换并关弹层'); else bad('指数切换异常 ' + JSON.stringify(ix));

    const gs = out.grpSheet || {};
    /* 探针流程：删了红利ETF、新增了「科创新」→ 2 虚拟 + 4 自定义 = 6 格 */
    if (gs.cells === 6 && gs.ops === 2) ok('★ 分组弹层：宫格 6（全部/持仓/4 组）+ 管理与新增入口'); else bad('分组弹层异常 ' + JSON.stringify(gs));
    if (gs.picked === 'wlg_hk' && gs.closed) ok('★ 点宫格切组并关弹层'); else bad('宫格切组异常 ' + JSON.stringify(gs));

    const mg = out.manage || {};
    if (mg.rows >= 4 && mg.defaultDelDisabled === true)
      ok('★ 管理弹层：' + mg.rows + ' 行，默认组删除键禁用');
    else bad('管理弹层异常 ' + JSON.stringify(mg));
    if (mg.idsAfterDrag && mg.persisted && mg.idsAfterDrag.join(',') === mg.persisted &&
        mg.idsAfterDrag.join(',') !== mg.ids.join(','))
      ok('★ 纵向长按拖拽换位生效（sheet 即时刷新，持久化：' + mg.persisted + '）');
    else bad('纵向拖拽异常 before=' + JSON.stringify(mg.ids) + ' after=' + JSON.stringify(mg.idsAfterDrag) + ' persisted=' + mg.persisted);
  }

  await browser.send('Page.captureScreenshot', {}, sessionId).then(async (shot) => {
    const data = shot && (shot.data || (shot.result && shot.result.data));
    if (!data) { console.log('  ⚠️ 截图数据为空'); return; }
    const dir = path.join(PROJ, 'shots', 'watchlist');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'watchlist.png'), Buffer.from(data, 'base64'));
    console.log('  📸 shots/watchlist/watchlist.png');
  }).catch((e) => console.log('  ⚠️ 截图失败: ' + e.message));

  browser.close();
} catch (e) {
  bad('异常: ' + (e && e.message ? e.message : String(e)));
} finally {
  try { chrome.kill(); } catch (e) {}
}

console.log(fail ? '\\n[watchlist] 失败 ' + fail + ' 项 ✗' : '\\n[watchlist] 全部通过 ✓');
process.exit(fail ? 1 : 0);
