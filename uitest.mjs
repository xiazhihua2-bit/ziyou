/* ============================================================
 * UI 验收（CDP 版）：多端视口水平溢出 + 控制台报错 + 多 Tab / 弹层 / 交互冒烟
 *
 * 不依赖 Playwright：用 Node 22 内置 WebSocket 直连 Chrome DevTools Protocol，
 * 通过 Emulation.setDeviceMetricsOverride 精确控制视口（可低至 320px）。
 *
 * 用法： node uitest.mjs
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SRC = path.join(ROOT, 'dist', '自由.html');
const PORT = 9333;

/* 安装链接必须在【http(s) 来源】下才生效（file:// 下应用会如实拒绝同步），
   所以这一节自带一个只服务单文件产物的本地 HTTP 服务器。全程仍由 CDP
   模拟断网，页面拿不到任何真实网络。 */
const SITE_PORT = 0;   // 0 = 让内核挑一个空闲端口

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 种子数据 ---------------- */
function plan(sym, reportDate, pretax, progress, eq, ex) {
  return {
    planId: sym + '_' + reportDate, symbol: sym, securityCode: sym.slice(2), securityName: '',
    reportDate, reportType: reportDate.slice(5, 7) === '12' ? '年报' : '中报',
    pretaxBonusPer10: pretax, afterTaxPer10: null,
    implPlanProfile: '10派' + pretax + '元(含税)',
    planNoticeDate: null, noticeDate: null, equityRecordDate: eq, exDividendDate: ex,
    assignProgress: progress, progressRank: progress.indexOf('实施分配') >= 0 ? 100 : 60,
    isImplemented: progress.indexOf('实施分配') >= 0, dividendRatio: null,
    fetchedAt: '2026-09-01T00:00:00Z',
  };
}

const SYMS = ['sh600023', 'sz000858', 'sh601088', 'sz000895', 'sh600036', 'sz002415', 'sh601318', 'sz300750'];
const NAMES = ['浙能电力', '五粮液', '中国神华', '双汇发展', '招商银行', '海康威视', '中国平安', '宁德时代'];
const PRICES = [4.98, 70.48, 39.12, 24.36, 45.80, 28.44, 52.10, 186.30];
const YIELDS = [0.062, 0.058, 0.071, 0.064, 0.055, 0.038, 0.049, 0.021];

const seed = {
  version: 1, createdAt: '2026-01-01T00:00:00Z',
  accounts: [
    { accountId: 'acc_1', name: '我的主账户', type: 'BROKER', sortOrder: 1, createdAt: '2026-01-01T00:00:00Z' },
    { accountId: 'acc_2', name: '家人账户', type: 'FAMILY', sortOrder: 2, createdAt: '2026-01-01T00:00:00Z' },
  ],
  symbols: {}, transactions: [], plans: {}, received: [],
  expenses: [
    { expenseId: 'exp_phone', key: 'PHONE', label: '话费', monthlyAmount: 100, enabled: true, sortOrder: 1 },
    { expenseId: 'exp_utility', key: 'UTILITY', label: '水电燃气', monthlyAmount: 300, enabled: true, sortOrder: 2 },
    { expenseId: 'exp_property', key: 'PROPERTY', label: '物业费', monthlyAmount: 200, enabled: true, sortOrder: 3 },
    { expenseId: 'exp_fuel', key: 'FUEL', label: '加油', monthlyAmount: 400, enabled: true, sortOrder: 4 },
    { expenseId: 'exp_mortgage', key: 'MORTGAGE', label: '房贷/房租', monthlyAmount: 3000, enabled: true, sortOrder: 5 },
    { expenseId: 'exp_other', key: 'OTHER', label: '其他消费', monthlyAmount: 500, enabled: true, sortOrder: 6 },
    { expenseId: 'exp_lunch', key: 'LUNCH', label: '午餐', monthlyAmount: 600, enabled: true, sortOrder: 7 },
  ],
  projection: { configId: 'proj_default', monthlyInvest: 15000, years: 10, reinvestRatio: 1, divGrowthRate: 0, startAssets: null },
  settings: {
    id: 'app_settings', quoteRefreshMs: 60000, planCacheTTLMs: 604800000,
    defaultAccountId: 'acc_1', reminderLeadDays: 3,
    lastQuoteAt: '2026-09-10T15:00:00Z', lastPlanAt: '2026-09-10T15:00:00Z', onboarded: true,
  },
  quoteCache: {},
};

/* 每家按目标股息率反推分红，保证收益率贴近真实（约 2%~7%） */
SYMS.forEach((sym, i) => {
  const qty = (i + 1) * 500;
  const A = +(PRICES[i] * YIELDS[i] * 10).toFixed(4);   // 一个完整年度的每 10 股税前分红
  const perShare = A / 10;

  seed.symbols[sym] = { symbol: sym, code: sym.slice(2), market: sym.slice(0, 2), name: NAMES[i], type: 'STOCK', updatedAt: '2026-09-01T00:00:00Z' };
  seed.quoteCache[sym] = {
    symbol: sym, name: NAMES[i], code: sym.slice(2), price: PRICES[i], prevClose: +(PRICES[i] * 1.01).toFixed(2),
    changePct: i % 3 === 0 ? -0.82 : 1.34, quoteTime: '20260910150031',
  };
  seed.transactions.push({
    txId: 'tx_' + i, accountId: i < 6 ? 'acc_1' : 'acc_2', symbol: sym, action: 'BUY',
    date: '2024-0' + ((i % 9) + 1) + '-15', quantity: qty, price: +(PRICES[i] * 0.88).toFixed(2), fee: 5,
    note: '', createdAt: '2024-0' + ((i % 9) + 1) + '-15T01:00:00Z',
  });

  /* FY2024 中报 + 年报（已派） */
  seed.plans[sym + '_2024-06-30'] = plan(sym, '2024-06-30', +(A * 0.3).toFixed(4), '实施分配', '2024-10-15', '2024-10-16');
  seed.plans[sym + '_2024-12-31'] = plan(sym, '2024-12-31', +(A * 0.7).toFixed(4), '实施分配', '2025-06-12', '2025-06-13');
  /* FY2025 中报 + 年报（已派） */
  seed.plans[sym + '_2025-06-30'] = plan(sym, '2025-06-30', +(A * 0.3).toFixed(4), '实施分配', '2025-10-16', '2025-10-17');
  seed.plans[sym + '_2025-12-31'] = plan(sym, '2025-12-31', +(A * 0.7).toFixed(4), '实施分配', '2026-06-18', '2026-06-19');
  if (i < 5) {
    /* FY2026 中报：已定档在当月（2026-09），用于验证日历与「本月待收」横幅 */
    seed.plans[sym + '_2026-06-30'] = plan(sym, '2026-06-30', +(A * 0.35).toFixed(4), '实施分配', '2026-09-1' + i, '2026-09-2' + i);
  } else {
    /* 其余为尚未落地的预案 */
    seed.plans[sym + '_2026-06-30'] = plan(sym, '2026-06-30', +(A * 0.35).toFixed(4), '董事会决议通过', null, null);
  }

  [[2024, '2024-06-30', A * 0.3, 0.3], [2024, '2024-12-31', A * 0.7, 0.7],
  [2025, '2025-06-30', A * 0.3, 0.3], [2025, '2025-12-31', A * 0.7, 0.7]].forEach(([y, rd, amt, frac]) => {
    const exDate = y === 2024 ? (rd === '2024-06-30' ? '2024-10-16' : '2025-06-13') : (rd === '2025-06-30' ? '2025-10-17' : '2026-06-19');
    seed.received.push({
      recId: 'rec_' + y + '_' + amt + '_' + i, accountId: i < 6 ? 'acc_1' : 'acc_2', symbol: sym,
      planId: sym + '_' + rd, exDividendDate: exDate,
      perShareAmount: perShare * frac, qtyAtRecord: qty,
      amount: Math.round(qty * perShare * frac * 100) / 100,
      source: 'AUTO', year: +exDate.slice(0, 4), createdAt: exDate + 'T00:00:00Z',
    });
  });
});

/* ---------------- 页面内探针（返回对象，走 Runtime.evaluate returnByValue） ---------------- */
const PROBE = `
(async function(){
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  /* 页内当天的 YYYY-MM-DD（与 XJ.util.today 同口径，本地时区） */
  function todayYmd(){
    var d = new Date();
    var p = function(n){ return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  var errors = [];
  window.addEventListener('error', function(e){ errors.push(String(e.message || e.type)); });
  window.addEventListener('unhandledrejection', function(e){ errors.push('rejection: ' + String(e.reason)); });

  function clippedBy(el){
    var p = el.parentElement;
    while (p && p !== document.body) {
      var ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true;
      p = p.parentElement;
    }
    return false;
  }
  function measure(){
    var vw = document.documentElement.clientWidth;
    var bad = [];
    var all = document.querySelectorAll('#app *, #modal-root *');
    for (var i = 0; i < all.length; i++){
      var el = all[i];
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.right > vw + 1.5 && !clippedBy(el)) {
        bad.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 46), l: Math.round(r.left), r: Math.round(r.right) });
      }
    }
    /* 不该发生的文本截断：宽屏（>=768）下副标题被 ellipsis 截掉 */
    var trunc = [];
    if (vw >= 768) {
      var cand = document.querySelectorAll('.row-s, .row-t .nm, .kv .k');
      for (var j = 0; j < cand.length; j++){
        var c = cand[j];
        if (c.scrollWidth > c.clientWidth + 1 && c.clientWidth > 0) {
          trunc.push({ txt: (c.textContent || '').slice(0, 24), sw: c.scrollWidth, cw: c.clientWidth });
        }
      }
    }
    /* 持仓卡片：名字 / 代码行在任何视口都不该被截断
       （方案 B 让名字独占第一行；第二行是「代码 + 涨跌幅徽章」，两者都不该溢出） */
    var hcTrunc = [];
    var hCards = document.querySelectorAll('.hc-name .nm, .hc-code');
    for (var k = 0; k < hCards.length; k++){
      var hc = hCards[k];
      if (hc.scrollWidth > hc.clientWidth + 1 && hc.clientWidth > 0) {
        hcTrunc.push({ cls: String(hc.className || ''), txt: (hc.textContent || '').slice(0, 20),
          sw: hc.scrollWidth, cw: hc.clientWidth });
      }
    }
    return {
      vw: vw, docW: document.documentElement.scrollWidth, bodyW: document.body.scrollWidth,
      overflowCount: bad.length, overflow: bad.slice(0, 6),
      truncCount: trunc.length, trunc: trunc.slice(0, 4),
      hcTruncCount: hcTrunc.length, hcTrunc: hcTrunc.slice(0, 4),
      nodes: document.querySelectorAll('#view-body > *').length,
      textLen: (document.getElementById('view-body').textContent || '').trim().length
    };
  }

  var XJ = window.XJ;
  var out = { viewport: window.innerWidth, errors: errors, boot: !!(XJ && XJ.store && XJ.store.state) };
  if (!out.boot) { out.fatal = 'app 未启动'; return out; }

  /* 注入种子数据（与存储方式无关，直接替换内存状态并落盘） */
  XJ.store.init(XJ.model.fromImport(SEED_JSON));
  XJ.store.ui.accountId = XJ.calc.ALL;
  XJ.storage.save(XJ.store.state);
  XJ.store.notify();

  out.tabs = {};
  ['overview','calendar','find','mine'].forEach(function(t){
    XJ.store.setUI({ tab: t });
    out.tabs[t] = measure();
  });

  out.sheets = {};
  try {
    XJ.store.setUI({ tab: 'overview', subPage: null, floatOpen: false });
    XJ.views.common.openSymbolDetail('sh600023');
    out.sheets.symbolDetail = measure();
    document.querySelector('[data-act="addTxFor"]').click();
    await sleep(360);                                   // 等 openSheet 的 200ms 延迟
    var t = document.querySelector('.sheet h3');
    out.afterAddTx = { sheetTitle: t ? t.textContent : null,
      hasForm: !!document.querySelector('.sheet [data-act="saveTx"]') };
  } catch(e){ out.sheets.symbolDetailError = String(e && e.message); }
  XJ.ui.closeSheet();
  try {
    XJ.store.setUI({ tab: 'overview', subPage: null, floatOpen: false });   // 个股已改为独立页，先退回主界面
    document.querySelector('[data-act="openAddHolding"]').click();
    out.sheets.addHolding = measure();
    /* 三步表单：切到「自定义」输入代码（离线可用的路径），步骤 2/3 应自动展开 */
    document.querySelector('[data-act="pickMarket"][data-key="custom"]').click();
    var qi = document.querySelector('.sheet [data-k="query"]');
    qi.value = 'sh600023';
    qi.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(80);
    out.sheets.addHoldingExpanded = measure();
    out.sheets.stepsEnabled = !document.querySelector('.sheet fieldset[disabled]');
    out.sheets.basisPreview = (document.querySelector('#xj-basis-preview') || {}).textContent;
    out.sheets.submitEnabled = !document.querySelector('.sheet [data-act="saveAddHolding"]').disabled;
  } catch(e){ out.sheets.addHoldingError = String(e && e.message); }
  XJ.ui.closeSheet();
  try {
    XJ.views.mine.render;
    XJ.store.setUI({ tab: 'mine' });
    document.querySelector('[data-act="openExpenses"]');
    XJ.store.setUI({ tab: 'plan' });
    document.querySelector('[data-act="gotoTab"]');
    XJ.store.setUI({ tab: 'mine' });
    document.querySelector('[data-act="exportJson"]');
    out.sheets.ok = true;
  } catch(e){ out.sheets.okError = String(e && e.message); }

  /* v3 新增视图：年度总览 / 账户分析 / 悬浮菜单 */
  out.subviews = {};
  try {
    XJ.store.setUI({ tab: 'calendar', calView: 'annual', annualYear: null, annualMonth: null, subPage: null });
    out.subviews.annual = measure();
    document.querySelectorAll('[data-act="selAnnualMonth"]')[5].click();
    out.subviews.annualAfterMonth = measure().overflowCount;
    document.querySelector('[data-act="setCalView"][data-v="calendar"]').click();
  } catch (e) { out.subviews.annual = { error: String(e && e.message) }; }

  /* 历史行情种子：首页资产走势卡与账户分析里的资产走势卡都要用（分析页断言在前面，必须先备好） */
  function seedHistoryData() {
    var s = XJ.store.state;
    s.priceHistory = s.priceHistory || {};
    Object.keys(s.symbols || {}).forEach(function (sym, k) {
      var q = s.quoteCache[sym];
      var base = (q && Number(q.price)) || (8 + k * 1.7);
      var pts = [];
      for (var i = 179; i >= 0; i--) {
        var d = new Date();
        d.setDate(d.getDate() - i);
        var key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        pts.push([key, Math.round(base * (1 + (179 - i) * 0.0009 + Math.sin(i / 6) * 0.012) * 1000) / 1000]);
      }
      s.priceHistory[sym] = { at: new Date().toISOString().slice(0, 10), points: pts };
    });
    /* 指数日线（含 OHLC，K线模式要用）：造 180 根，走势与组合不同以便肉眼分辨 */
    s.indexHistory = {};
    XJ.market.INDICES.forEach(function (def, k) {
      var bars = [], base = 3000 + k * 800;
      for (var i = 179; i >= 0; i--) {
        var d = new Date();
        d.setDate(d.getDate() - i);
        var key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        var drift = (179 - i) * (def.key === 'ixic' ? 0.0016 : 0.0006);
        var wave = Math.sin((i + k * 5) / 11) * 0.03;
        var c = base * (1 + drift + wave);
        bars.push({
          d: key,
          o: Math.round(c * 0.995 * 100) / 100,
          h: Math.round(c * 1.008 * 100) / 100,
          l: Math.round(c * 0.992 * 100) / 100,
          c: Math.round(c * 100) / 100,
        });
      }
      s.indexHistory[def.key] = { at: new Date().toISOString().slice(0, 10), bars: bars };
    });
    s.settings.indexCompare = ['sh', 'hs300', 'ixic'];
  }

  try {
    XJ.store.setUI({ tab: 'overview', subPage: 'analysis', floatOpen: false });
    seedHistoryData();
    /* 灌 90 天快照：给深色卡的「较上次记录」用（资产走势卡本身不依赖快照，历史行情就能画） */
    (function seedSnapshots() {
      var s = XJ.store.state;
      s.snapshots = s.snapshots || {};
      var base = 1180000;
      for (var i = 89; i >= 0; i--) {
        var d = new Date();
        d.setDate(d.getDate() - i);
        var key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        var wave = Math.sin(i / 7) * 42000 + (89 - i) * 1450;
        s.snapshots[key] = { mv: Math.round(base + wave), cost: 1150800, pred: 45650, recv: 31955 };
      }
    })();
    XJ.store.commitNow(null);
    out.subviews.analysis = measure();
    /* 分析页新增的「资产走势」卡（ns='an'）：与首页同款多序列对比图 */
    var anCard = document.querySelector('.nw-card[data-ns="an"]');
    out.subviews.anCard = !!anCard;
    out.subviews.anChart = !!(anCard && anCard.querySelector('svg[data-chart="cmp"]'));
    out.subviews.anChartCount = anCard ? anCard.querySelectorAll('svg[data-chart]').length : -1;
    out.subviews.anCardText = anCard ? (anCard.textContent || '').trim().slice(0, 40) : '';
    out.subviews.anGridLines = anCard ? anCard.querySelectorAll('svg[data-chart="cmp"] line[stroke-dasharray]').length : 0;
    out.subviews.anRangeChips = anCard ? anCard.querySelectorAll('[data-act="setNwRange"]').length : 0;
    out.subviews.anMetricBtns = anCard ? anCard.querySelectorAll('[data-act="setNwMetric"]').length : 0;
    /* 状态独立性：在分析页切到「净资产」，首页那份应仍是「持仓市值」 */
    var anNwBtn = anCard && anCard.querySelector('[data-act="setNwMetric"][data-v="nw"]');
    if (anNwBtn) { anNwBtn.click(); await sleep(140); }
    out.subviews.anMetricAfter = XJ.store.ui.anNwMetric;
    out.subviews.homeMetricAfter = XJ.store.ui.nwMetric;
    /* 模拟按住拖动 → 应显示多值读数气泡 */
    (function dragChart() {
      var svg = document.querySelector('.nw-card[data-ns="an"] svg[data-chart="cmp"]');
      if (!svg) return;
      var r = svg.getBoundingClientRect();
      var opts = { bubbles: true, cancelable: true, pointerId: 1, clientX: r.left + r.width * 0.6, clientY: r.top + r.height / 2 };
      svg.dispatchEvent(new PointerEvent('pointerdown', opts));
      svg.dispatchEvent(new PointerEvent('pointermove', opts));
    })();
    var anMk = document.querySelector('.nw-card[data-ns="an"] svg[data-chart="cmp"] .xjc-cmpmarker');
    out.subviews.anMarkerShown = !!(anMk && anMk.style.display !== 'none');
    out.subviews.anMarkerRows = document.querySelectorAll('.nw-card[data-ns="an"] svg[data-chart="cmp"] .xjc-cmpmarker .xjc-cmprow').length;
    out.subviews.anBandWidth = (function () {
      var r = document.querySelector('.nw-card[data-ns="an"] svg[data-chart="cmp"] .xjc-band');
      return r ? Number(r.getAttribute('width')) : 0;
    })();
    out.subviews.anMarkerText = Array.prototype.slice.call(
      document.querySelectorAll('.nw-card[data-ns="an"] svg[data-chart="cmp"] .xjc-cmpv')).map(function (t) { return t.textContent; }).join(' ');
    XJ.chart.hideAll();
    /* 复位分析页实例，避免影响后续首页断言 */
    XJ.store.setUI({ anNwMetric: 'mv', anNwRange: null, anNwCollapsed: false });
  } catch (e) { out.subviews.analysis = { error: String(e && e.message) }; }

  /* 首页：持仓总市值曲线（历史行情已在前面备好，离线也要能画出真曲线） */
  try {
    seedHistoryData();
    XJ.store.setUI({ tab: 'overview', subPage: null, floatOpen: false, nwRange: 'all', nwGran: 'day', nwMetric: 'mv', nwMode: 'line', nwCollapsed: false });
    XJ.store.commitNow(null);
    await sleep(120);
    out.subviews.nw = measure();
    var nwSvg = document.querySelector('svg[data-chart="cmp"]');
    out.subviews.nwRendered = !!nwSvg;
    out.subviews.nwDayPoints = nwSvg ? Number(nwSvg.getAttribute('data-n')) : 0;
    out.subviews.nwAmountText = ((document.querySelector('.nw-amount') || {}).textContent) || '';
    out.subviews.nwDeltaText = ((document.querySelector('.nw-delta') || {}).textContent) || '';
    out.subviews.nwGranChips = document.querySelectorAll('[data-act="setNwGran"]').length;
    out.subviews.nwRangeChips = document.querySelectorAll('[data-act="setNwRange"]').length;
    out.subviews.nwRangeLabels = Array.prototype.slice.call(
      document.querySelectorAll('[data-act="setNwRange"]')).map(function (b) { return b.textContent; }).join('/');
    out.subviews.nwGridLines = document.querySelectorAll('svg[data-chart="cmp"] line[stroke-dasharray]').length;
    out.subviews.nwAxisLabels = Array.prototype.slice.call(
      document.querySelectorAll('svg[data-chart="cmp"] text')).map(function (t) { return t.textContent; });

    /* 日/月粒度切换：月粒度点数应明显减少 */
    var monthBtn = document.querySelector('[data-act="setNwGran"][data-v="month"]');
    if (monthBtn) {
      monthBtn.click(); await sleep(110);
      var nw2 = document.querySelector('svg[data-chart="cmp"]');
      out.subviews.nwMonthPoints = nw2 ? Number(nw2.getAttribute('data-n')) : 0;
    }
    /* 区间切换（先回到日粒度，否则月粒度下当月只剩 1 个点）：本月点数应少于全部 */
    XJ.store.setUI({ nwGran: 'day' });
    await sleep(110);
    var m1 = document.querySelector('[data-act="setNwRange"][data-v="1m"]');
    if (m1) {
      m1.click(); await sleep(110);
      var nw3 = document.querySelector('svg[data-chart="cmp"]');
      out.subviews.nwMonthRange1mPoints = nw3 ? Number(nw3.getAttribute('data-n')) : 0;
    }
    /* 自定义区间：应出现两个日期输入 */
    var cus = document.querySelector('[data-act="setNwRange"][data-v="custom"]');
    if (cus) {
      cus.click(); await sleep(110);
      out.subviews.nwCustomInputs = document.querySelectorAll('[data-k="nwBeg"],[data-k="nwEnd"]').length;
    }
    /* 拖动读数 */
    XJ.store.setUI({ nwGran: 'day', nwRange: 'all' });
    await sleep(110);
    (function dragNw() {
      var svg = document.querySelector('svg[data-chart="cmp"]');
      if (!svg) return;
      var r = svg.getBoundingClientRect();
      var opts = { bubbles: true, cancelable: true, pointerId: 2, clientX: r.left + r.width * 0.55, clientY: r.top + r.height / 2 };
      svg.dispatchEvent(new PointerEvent('pointerdown', opts));
      svg.dispatchEvent(new PointerEvent('pointermove', opts));
    })();
    var nmk = document.querySelector('svg[data-chart="cmp"] .xjc-cmpmarker');
    out.subviews.nwMarkerShown = !!(nmk && nmk.style.display !== 'none');
    out.subviews.nwMarkerText = ((document.querySelector('svg[data-chart="cmp"] .xjc-cmpv') || {}).textContent) || '';
    out.subviews.nwBandShown = !!document.querySelector('svg[data-chart="cmp"] .xjc-band');
    XJ.chart.hideAll();

    /* 曲线容器限宽（否则桌面端 SVG 被拉伸得过大） */
    var nwBox = document.querySelector('.nw-chart');
    out.subviews.nwChartWidth = nwBox ? Math.round(nwBox.getBoundingClientRect().width) : 0;
    out.subviews.nwChartMaxW = nwBox ? getComputedStyle(nwBox).maxWidth : '';
    out.subviews.nwAmountFont = (function () {
      var el = document.querySelector('.nw-amount');
      return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
    })();

    /* 一键切换 持仓市值 / 净资产 */
    out.subviews.nwMetricChips = document.querySelectorAll('[data-act="setNwMetric"]').length;
    out.subviews.nwActiveMetric = (XJ.store.ui.nwMetric || 'mv');
    out.subviews.nwMvText = ((document.querySelector('.nw-amount') || {}).textContent) || '';
    out.subviews.nwMvLegend = ((document.querySelector('.nw-legend') || {}).textContent) || '';
    var nwBtn = document.querySelector('[data-act="setNwMetric"][data-v="nw"]');
    if (nwBtn) {
      nwBtn.click(); await sleep(130);
      out.subviews.nwActiveMetricAfter = XJ.store.ui.nwMetric;
      out.subviews.nwNwText = ((document.querySelector('.nw-amount') || {}).textContent) || '';
      out.subviews.nwNwLegend = ((document.querySelector('.nw-legend') || {}).textContent) || '';
      out.subviews.nwDeltaNw = ((document.querySelector('.nw-delta') || {}).textContent) || '';
      out.subviews.nwNoteNw = ((document.querySelector('.nw-card .note-line') || {}).textContent) || '';
      out.subviews.nwLegendColor = (function () {
        var el = document.querySelector('.nw-legend i');
        return el ? getComputedStyle(el).backgroundColor : '';
      })();
      out.subviews.nwLineColor = (function () {
        var p = document.querySelector('svg[data-chart="cmp"] path[stroke]');
        return p ? getComputedStyle(p).stroke : '';
      })();
      /* 拖动读数在净资产模式下也应工作 */
      (function dragNw2() {
        var svg = document.querySelector('svg[data-chart="cmp"]');
        if (!svg) return;
        var r = svg.getBoundingClientRect();
        var o = { bubbles: true, cancelable: true, pointerId: 3, clientX: r.left + r.width * 0.5, clientY: r.top + r.height / 2 };
        svg.dispatchEvent(new PointerEvent('pointerdown', o));
        svg.dispatchEvent(new PointerEvent('pointermove', o));
      })();
      out.subviews.nwNwMarker = ((document.querySelector('svg[data-chart="cmp"] .xjc-cmpv') || {}).textContent) || '';
      XJ.chart.hideAll();
      /* 切回市值 */
      var mvBtn = document.querySelector('[data-act="setNwMetric"][data-v="mv"]');
      if (mvBtn) { mvBtn.click(); await sleep(110); }
    }

    /* 收益率曲线 + 指数对比（探针采集） */
    var retBtn = document.querySelector('[data-act="setNwMetric"][data-v="ret"]');
    if (retBtn) {
      retBtn.click(); await sleep(170);
      out.subviews.retActive = XJ.store.ui.nwMetric;
      out.subviews.retAmountText = ((document.querySelector('.nw-amount') || {}).textContent) || '';
      out.subviews.retSubText = ((document.querySelector('.nw-sub') || {}).textContent) || '';
      out.subviews.retIdxItems = document.querySelectorAll('[data-act="toggleIndex"]').length;
      out.subviews.retIdxOn = document.querySelectorAll('[data-act="toggleIndex"].on').length;
      out.subviews.retIdxNames = Array.prototype.slice.call(
        document.querySelectorAll('[data-act="toggleIndex"]')).map(function (b) { return b.textContent.trim(); }).join(',');
      out.subviews.retLines = document.querySelectorAll('svg[data-chart="cmp"] path[stroke]').length;
      out.subviews.retAxis = Array.prototype.slice.call(
        document.querySelectorAll('svg[data-chart="cmp"] text')).map(function (t) { return t.textContent; })
        .filter(function (t) { return /%$/.test(t); }).length;
      out.subviews.retVsItems = document.querySelectorAll('.nw-vsitem').length;
      out.subviews.retNoteText = ((document.querySelector('.nw-card .note-line') || {}).textContent) || '';
      out.subviews.retModeChips = document.querySelectorAll('[data-act="setNwMode"]').length;
      (function dragRet() {
        var svg = document.querySelector('svg[data-chart="cmp"]');
        if (!svg) return;
        var r = svg.getBoundingClientRect();
        var o = { bubbles: true, cancelable: true, pointerId: 4, clientX: r.left + r.width * 0.6, clientY: r.top + r.height / 2 };
        svg.dispatchEvent(new PointerEvent('pointerdown', o));
        svg.dispatchEvent(new PointerEvent('pointermove', o));
      })();
      out.subviews.retBubbleRows = document.querySelectorAll('svg[data-chart="cmp"] .xjc-cmpmarker .xjc-cmprow').length;
      out.subviews.retBandWidth = (function () {
        var r = document.querySelector('svg[data-chart="cmp"] .xjc-band');
        return r ? Number(r.getAttribute('width')) : 0;
      })();
      out.subviews.retBubbleText = Array.prototype.slice.call(
        document.querySelectorAll('svg[data-chart="cmp"] .xjc-cmpv')).map(function (t) { return t.textContent; }).join(' ');
      /* 气泡宽度必须容得下内容（曾写死 132，长名字/长金额被截断） */
      out.subviews.retBubbleWidth = (function () {
        var r = document.querySelector('svg[data-chart="cmp"] .xjc-cmpbub rect');
        return r ? Number(r.getAttribute('width')) : 0;
      })();
      out.subviews.retBubbleRowsAll = document.querySelectorAll('svg[data-chart="cmp"] .xjc-cmpmarker .xjc-cmprow').length;
      XJ.chart.hideAll();

      /* 可用的指数可随意勾选/取消 */
      var ksBtn = document.querySelector('[data-act="toggleIndex"][data-v="spx"]');
      if (ksBtn) {
        ksBtn.click(); await sleep(180);
        out.subviews.retKsAdded = (XJ.store.state.settings.indexCompare || []).indexOf('spx') >= 0;
        var ksBtn2 = document.querySelector('[data-act="toggleIndex"][data-v="spx"]');
        if (ksBtn2) { ksBtn2.click(); await sleep(180); }
        out.subviews.retKsRemoved = (XJ.store.state.settings.indexCompare || []).indexOf('spx') < 0;
      }
      /* 无历史源的指数（日经225 / 台湾加权 / 韩国KOSPI）已整项从图例移除，点都点不到 */
      out.subviews.retNoDataGone =
        !document.querySelector('[data-act="toggleIndex"][data-v="n225"]') &&
        !document.querySelector('[data-act="toggleIndex"][data-v="twii"]') &&
        !document.querySelector('[data-act="toggleIndex"][data-v="ks11"]');
      var cBtn = document.querySelector('[data-act="setNwMode"][data-v="candle"]');
      if (cBtn) {
        cBtn.click(); await sleep(170);
        out.subviews.retMode = XJ.store.ui.nwMode;
        out.subviews.retCandles = document.querySelectorAll('svg[data-chart="cmp"] rect[stroke]').length;
        out.subviews.retCandleNote = ((document.querySelector('.nw-card .note-line') || {}).textContent) || '';
        var lBtn = document.querySelector('[data-act="setNwMode"][data-v="line"]');
        if (lBtn) { lBtn.click(); await sleep(140); }
      }
      var tBtn = document.querySelector('[data-act="setNwRange"][data-v="today"]');
      if (tBtn) {
        tBtn.click(); await sleep(170);
        out.subviews.retTodayRange = XJ.store.ui.nwRange;
        out.subviews.retIdxDisabled = document.querySelectorAll('[data-act="toggleIndex"][disabled]').length;

        /* ★ 当日区间：三种指标（收益率 / 市值 / 净资产）都必须画得出线。
           收稿前这里是空态 —— 因为 refreshMinutes 收盘后主动清空了缓存。
           用「最近一个交易日」的缓存喂进去，三个指标都要有曲线。 */
        var nwPts = [];
        for (var pi = 0; pi < 60; pi++) {
          var phh = Math.floor((570 + pi) / 60), pmm = (570 + pi) % 60;
          nwPts.push({ t: String(phh).padStart(2, '0') + ':' + String(pmm).padStart(2, '0'),
            p: Math.round((10.5 + Math.sin(pi / 5) * 0.09 + pi * 0.002) * 1000) / 1000 });
        }
        var nwBy = {};
        XJ.calc.holdings(XJ.store.state, XJ.store.acc()).forEach(function (h) {
          nwBy[h.symbol] = { date: todayYmd(), points: nwPts };
        });
        XJ.store.state.minuteCache = { at: todayYmd(), bySymbol: nwBy };

        var metricKeys = ['ret', 'mv', 'nw'];
        out.subviews.todayMetrics = {};
        for (var mi = 0; mi < metricKeys.length; mi++) {
          var mk = metricKeys[mi];
          var mBtn = document.querySelector('[data-act="setNwMetric"][data-v="' + mk + '"]');
          if (!mBtn) { out.subviews.todayMetrics[mk] = { error: 'no button' }; continue; }
          mBtn.click(); await sleep(170);
          var paths = document.querySelectorAll('svg[data-chart="cmp"] path[stroke]');
          out.subviews.todayMetrics[mk] = {
            metric: XJ.store.ui.nwMetric,
            chart: document.querySelectorAll('svg[data-chart="cmp"]').length,
            paths: paths.length,
            /* 空态文案在的话就没有曲线 */
            empty: /还没有当日|没有可用的分时|正在获取当日分时/.test(
              ((document.querySelector('.nw-card') || {}).textContent) || ''),
          };
        }
        /* 恢复到收益率，后续截图用 */
        var backRet = document.querySelector('[data-act="setNwMetric"][data-v="ret"]');
        if (backRet) { backRet.click(); await sleep(140); }

        var aBtn = document.querySelector('[data-act="setNwRange"][data-v="all"]');
        if (aBtn) { aBtn.click(); await sleep(140); }
      }
      var mvBtn2 = document.querySelector('[data-act="setNwMetric"][data-v="mv"]');
      if (mvBtn2) { mvBtn2.click(); await sleep(130); }
    }

    /* 卡片点击展开 / 收起 */
    out.subviews.nwFoldBtn = !!document.querySelector('[data-act="toggleNw"]');
    var fb = document.querySelector('[data-act="toggleNw"]');
    if (fb) {
      fb.click(); await sleep(130);
      out.subviews.nwCollapsed = !!XJ.store.ui.nwCollapsed;
      out.subviews.nwCollapsedClass = !!document.querySelector('.nw-card.collapsed');
      out.subviews.nwChartWhenCollapsed = document.querySelectorAll('svg[data-chart="cmp"]').length;
      out.subviews.nwMiniShown = !!document.querySelector('.nw-mini');
      out.subviews.nwMiniText = ((document.querySelector('.nw-mini') || {}).textContent) || '';
      var fb2 = document.querySelector('[data-act="toggleNw"]');
      if (fb2) {
        fb2.click(); await sleep(130);
        out.subviews.nwReexpanded = XJ.store.ui.nwCollapsed === false;
        out.subviews.nwChartBack = !!document.querySelector('svg[data-chart="cmp"]');
      }
    }
  } catch (e) { out.subviews.nw = { error: String(e && e.message) }; }

  /* 公司图标：解析到就在头像里叠加 img；没解析到就用两字中文简称 */
  try {
    var acc0 = XJ.store.state.accounts[0].accountId;
    var sym0 = null;
    Object.keys(XJ.store.state.symbols).forEach(function (s) { if (!sym0 && s.indexOf('sh') === 0) sym0 = s; });
    if (sym0) {
      XJ.store.state.transactions.push({
        txId: 'logo_probe', accountId: acc0, symbol: sym0, action: 'BUY',
        date: '2026-01-05', quantity: 100, price: 10, fee: 0, createdAt: '2026-01-05T01:00:00Z',
      });
      XJ.store.state.symbols[sym0].logoUrl = 'https://example.invalid/logo.png';
      XJ.store.state.symbols[sym0].logoState = 'ok';
      XJ.store.setUI({ tab: 'overview', subPage: null, floatOpen: false });
      XJ.store.commitNow(null);
      await sleep(140);
      var card = Array.prototype.slice.call(document.querySelectorAll('.hold-card')).filter(function (c) {
        return c.querySelector('[data-symbol="' + sym0 + '"]');
      })[0];
      out.subviews.logoImgRendered = !!(card && card.querySelector('.avatar .av-img'));
      out.subviews.logoImgSrc = card && card.querySelector('.avatar .av-img')
        ? card.querySelector('.avatar .av-img').getAttribute('src') : '';
      /* 另一个没有 logoUrl 的标的应显示两字简称 */
      var other = Array.prototype.slice.call(document.querySelectorAll('.hold-card')).filter(function (c) {
        var b = c.querySelector('[data-act="openSymbol"]');
        var s = b ? b.getAttribute('data-symbol') : null;
        return s && s !== sym0 && !(XJ.store.state.symbols[s] && XJ.store.state.symbols[s].logoUrl);
      })[0];
      out.subviews.logoFallbackText = other ? (other.querySelector('.avatar .av-txt') || {}).textContent : '';
      out.subviews.logoFallbackImg = !!(other && other.querySelector('.avatar .av-img'));
    }
  } catch (e) { out.subviews.logoImgRendered = { error: String(e && e.message) }; }

  /* 首页：持仓卡片内的当日分时（收盘后也要画 —— 缓存落盘、隔天靠 date 闸门挡掉） */
  try {
    var sparkPts = (function () {
      var a = [];
      for (var i = 0; i < 60; i++) {
        var hh = Math.floor((570 + i) / 60), mm = (570 + i) % 60;
        a.push({ t: String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0'),
          p: Math.round((10.5 + Math.sin(i / 5) * 0.09 + i * 0.002) * 1000) / 1000 });
      }
      return a;
    })();

    /* ① 当天批次 → 收盘后（sessionOpen=false）照样画 */
    XJ.store.state.minuteCache = {
      at: todayYmd(),
      bySymbol: { sh600023: { date: todayYmd(), points: sparkPts } },
    };
    XJ.market.sessionOpen = function () { return false; };
    XJ.store.setUI({ tab: 'overview', subPage: null, floatOpen: false });
    await sleep(90);
    out.subviews.sparkOffSession = document.querySelectorAll('.hc-spark svg.spark').length;
    /* 当天数据不该有日期角标 */
    out.subviews.sparkAtToday = document.querySelectorAll('.hc-px .hc-at').length;

    /* ② 上一交易日的批次（at 与 date 一致，只是不是今天）→ 照画 + 挂日期角标。
       产品口径是「显示最近一个交易日」，所以周末打开能看到上周五的走势，
       这里锁住这个契约；真正要挡的是 ③ 那种批次内外日期对不上的脏数据。 */
    var staleYmd = (function () {
      var d = new Date(); d.setDate(d.getDate() - 1);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
    })();
    XJ.store.state.minuteCache = {
      at: staleYmd,
      bySymbol: { sh600023: { date: staleYmd, points: sparkPts } },
    };
    XJ.store.setUI({ tab: 'overview', subPage: null, floatOpen: false });
    await sleep(90);
    out.subviews.sparkPrevDay = document.querySelectorAll('.hc-spark svg.spark').length;
    out.subviews.sparkAtStale = document.querySelectorAll('.hc-px .hc-at').length;

    /* ③ 脏数据：批次 at 与标的 date 对不上 → 一条都不画 */
    XJ.store.state.minuteCache = {
      at: staleYmd,
      bySymbol: { sh600023: { date: todayYmd(), points: sparkPts } },
    };
    XJ.store.setUI({ tab: 'overview', subPage: null, floatOpen: false });
    await sleep(90);
    out.subviews.sparkDirty = document.querySelectorAll('.hc-spark svg.spark').length;

    /* 恢复成当天批次，让后续截图能看到这个组件 */
    XJ.store.state.minuteCache = {
      at: todayYmd(),
      bySymbol: { sh600023: { date: todayYmd(), points: sparkPts } },
    };
    XJ.store.setUI({ tab: 'overview', subPage: null, floatOpen: false });
    await sleep(90);
    out.subviews.sparkBaseline = document.querySelectorAll('.hc-spark svg.spark line[stroke-dasharray]').length;
    out.subviews.sparkPriceText = ((document.querySelector('.hc-px b') || {}).textContent) || '';
  } catch (e) { out.subviews.sparkOnSession = { error: String(e && e.message) }; }

  /* 首页深色卡：收起后必须仍能展开（曾经的 bug 是「收起」把按钮一起 display:none 了） */
  try {
    XJ.store.setUI({ tab: 'overview', subPage: null, floatOpen: false });
    XJ.store.commit(function (s) { s.settings.heroCollapsed = false; });
    await sleep(90);
    out.subviews.heroToggleExists = !!document.querySelector('[data-act="toggleHero"]');
    document.querySelector('[data-act="toggleHero"]').click();
    await sleep(90);
    out.subviews.heroCollapsed = XJ.store.state.settings.heroCollapsed === true;
    out.subviews.heroMetricsHidden = !document.querySelector('.hero-dark .hd-metrics');
    /* 测算带也要跟着收起（它在卡内、指标网格下方） */
    out.subviews.hfHiddenWhenCollapsed = !document.querySelector('.hero-dark .hd-forecast');
    var expandBtn = document.querySelector('.hero-dark.collapsed [data-act="toggleHero"]');
    out.subviews.heroExpandBtnVisible = !!(expandBtn && (expandBtn.getClientRects().length > 0));
    if (expandBtn) {
      expandBtn.click(); await sleep(90);
      out.subviews.heroReexpanded = XJ.store.state.settings.heroCollapsed === false;
      out.subviews.heroMetricsBack = !!document.querySelector('.hero-dark .hd-metrics');
      out.subviews.hfBackAfterExpand = !!document.querySelector('.hero-dark .hd-forecast');
    }
  } catch (e) { out.subviews.heroCollapsed = { error: String(e && e.message) }; }

  /* 深色卡「测算带」：编辑参数 / 联动方向 / 反解 / 拆分 / 逐年明细 */
  try {
    XJ.store.setUI({ tab: 'overview', subPage: null, floatOpen: false });
    XJ.store.commit(function (s) {
      s.settings.heroCollapsed = false;
      s.settings.heroForecast = {
        annualInvest: 60000, yieldPct: 3.4, years: 10, reinvestPct: 100, solveFor: 'years',
      };
    });
    await sleep(90);

    var hfNums = document.querySelectorAll('.hd-forecast .hf-num');
    out.subviews.hfExists = !!document.querySelector('.hd-forecast');
    out.subviews.hfNumCount = hfNums.length;
    out.subviews.hfTexts = Array.prototype.slice.call(hfNums)
      .map(function (b) { return b.textContent.trim(); }).join('|');

    var readFc = function () {
      var c = XJ.store.state.settings.heroForecast;
      var sm = XJ.calc.summary(XJ.store.state, XJ.calc.ALL);
      var fc = XJ.calc.forecastRows({
        annualInvest: c.annualInvest, yieldPct: c.yieldPct, years: c.years, reinvestPct: c.reinvestPct,
      }, sm.totalPredicted);
      return { cfg: c, fc: fc, split: XJ.calc.forecastSplit(fc.monthly, sm.totalPredicted / 12) };
    };
    var mk = function (patch) {
      XJ.store.commit(function (s) { Object.assign(s.settings.heroForecast, patch); });
    };

    var base = readFc();
    out.subviews.hfMonthly0 = base.split.total;

    /* ① 点数字 → 弹层 → 改「每年投入」6 万 → 12 万 */
    document.querySelector('.hd-forecast .hf-num[data-k="annualInvest"]').click();
    await sleep(220);
    var invIn = document.querySelector('.sheet [data-k="hfVal"]');
    out.subviews.hfSheetOpen = !!invIn;
    if (invIn) {
      invIn.value = '12';
      document.querySelector('.sheet [data-act="saveForecast"]').click();
      await sleep(170);
    }
    out.subviews.hfInvestAfter = XJ.store.state.settings.heroForecast.annualInvest;
    var afterInvest = readFc();
    out.subviews.hfMonthlyAfterInvest = afterInvest.split.total;
    out.subviews.hfUpWithInvest = afterInvest.split.total > base.split.total;

    /* ② 联动方向：股息率↑ / 年数↑ / 再投↑ 都必须让月均变大（同年数同年投入下比较） */
    mk({ yieldPct: 6 });
    await sleep(70);
    out.subviews.hfUpWithYield = readFc().split.total > afterInvest.split.total;
    mk({ yieldPct: 3.4, years: 20, reinvestPct: 100 });
    await sleep(70);
    var y20r100 = readFc();
    out.subviews.hfUpWithYears = y20r100.split.total > afterInvest.split.total;
    mk({ years: 20, reinvestPct: 0 });
    await sleep(70);
    out.subviews.hfUpWithReinvest = readFc().split.total < y20r100.split.total;

    /* ③ 编辑「月均」→ 默认反解「年数」：写回的年数必须真能达到目标 */
    mk({ annualInvest: 60000, yieldPct: 3.4, years: 10, reinvestPct: 100, solveFor: 'years' });
    await sleep(70);
    var target = 8000;
    document.querySelector('.hd-forecast .hf-num[data-k="monthly"]').click();
    await sleep(220);
    var tIn = document.querySelector('.sheet [data-k="hfTarget"]');
    out.subviews.hfTargetSheet = !!tIn;
    if (tIn) {
      tIn.value = String(target);
      document.querySelector('.sheet [data-act="solveForecast"]').click();
      await sleep(170);
    }
    var solvedY = readFc();
    out.subviews.hfSolvedYears = solvedY.cfg.years;
    out.subviews.hfSolvedMonthly = solvedY.split.total;
    out.subviews.hfSolvedReaches = solvedY.split.total >= target;
    out.subviews.hfSolveForDefault = solvedY.cfg.solveFor;

    /* ④ 切换反解目标为「每年投入」→ 编辑月均 → 每年投入被写回、月均命中目标 */
    document.querySelector('.hd-forecast [data-act="setForecastSolve"][data-v="invest"]').click();
    await sleep(120);
    out.subviews.hfSolveForSwitched = XJ.store.state.settings.heroForecast.solveFor;
    document.querySelector('.hd-forecast .hf-num[data-k="monthly"]').click();
    await sleep(220);
    var t2 = document.querySelector('.sheet [data-k="hfTarget"]');
    if (t2) {
      t2.value = String(target);
      document.querySelector('.sheet [data-act="solveForecast"]').click();
      await sleep(170);
    }
    var solvedI = readFc();
    out.subviews.hfSolvedInvest = solvedI.cfg.annualInvest;
    out.subviews.hfSolvedInvestMonthly = solvedI.split.total;
    out.subviews.hfSolvedInvestHits = Math.abs(solvedI.split.total - target) <= 1;
    out.subviews.hfSplitOk = solvedI.split.existing + solvedI.split.fromNew === solvedI.split.total;

    /* ⑤ 逐年明细：行数 == 年数；末行「当年分红」== 卡片月均 × 12（允许取整差 1 元） */
    XJ.ui.closeSheet();
    await sleep(70);
    document.querySelector('[data-act="forecastDetail"]').click();
    await sleep(230);
    var trows = document.querySelectorAll('.sheet table.tbl tbody tr');
    out.subviews.hfDetailRows = trows.length;
    out.subviews.hfDetailRowsMatch = trows.length === solvedI.cfg.years;
    if (trows.length) {
      var cells = trows[trows.length - 1].querySelectorAll('td');
      out.subviews.hfDetailLastDividend = cells.length > 1 ? cells[1].textContent : '';
    }
    XJ.ui.closeSheet();
    await sleep(70);
    out.subviews.hfDetailCardMonthly = XJ.calc.forecastRows({
      annualInvest: XJ.store.state.settings.heroForecast.annualInvest,
      yieldPct: XJ.store.state.settings.heroForecast.yieldPct,
      years: XJ.store.state.settings.heroForecast.years,
      reinvestPct: XJ.store.state.settings.heroForecast.reinvestPct,
    }, XJ.calc.summary(XJ.store.state, XJ.calc.ALL).totalPredicted).monthly;
    /* 复位成默认，避免影响后续断言 */
    mk({ annualInvest: 60000, yieldPct: 3.4, years: 10, reinvestPct: 100, solveFor: 'years' });
  } catch (e) { out.subviews.hfExists = { error: String(e && e.message) }; }

  try {
    XJ.store.setUI({ tab: 'overview', subPage: 'symbol', subArg: 'sh600023', floatOpen: false });
    out.subviews.symbol = measure();
    document.querySelector('[data-act="openPositionEditor"]').click();
    await sleep(60);
    out.subviews.positionEditor = measure();
    XJ.ui.closeSheet();
    XJ.store.setUI({ subPage: null });
  } catch (e) { out.subviews.symbol = { error: String(e && e.message) }; }

  try {
    XJ.store.setUI({ tab: 'overview', floatOpen: true });
    out.subviews.floatMenu = measure();
    document.querySelector('[data-act="floatManual"]').click();   // 应关闭菜单并打开表单
    await sleep(320);
    out.subviews.floatManualOpened = !!document.querySelector('.sheet [data-act="saveAddHolding"]');
    XJ.ui.closeSheet();
    XJ.store.setUI({ floatOpen: false });
  } catch (e) { out.subviews.floatMenu = { error: String(e && e.message) }; }

  /* 截图识别：首次弹隐私确认 → 同意 → 进入识别面板 */
  try {
    XJ.store.state.settings.ocr.agreed = false;
    XJ.store.setUI({ tab: 'overview', subPage: null, floatOpen: true });
    document.querySelector('[data-act="floatOcr"]').click();
    await sleep(340);
    out.sheets.ocrPrivacy = measure();
    out.sheets.ocrPrivacyHasAgree = !!document.querySelector('.sheet [data-act="ocrAgree"]');
    document.querySelector('[data-act="ocrAgree"]').click();
    await sleep(280);
    out.sheets.ocrPanel = measure();
    out.sheets.ocrHasPicker = !!document.querySelector('.sheet [data-act="pickOcrImages"]');
    document.querySelector('[data-act="openOcrSettings"]').click();
    await sleep(120);
    out.sheets.ocrSettings = measure();
    out.sheets.ocrSettingsHasKey =
      (document.querySelector('.sheet [data-k="apiKey"]') || {}).value ? true : false;
    XJ.ui.closeSheet();
    XJ.store.setUI({ floatOpen: false });
  } catch (e) { out.sheets.ocrPrivacy = { error: String(e && e.message) }; }

  /* 待除权卡片（息记样式）+ 持仓删除按钮 + 无嵌套 button */
  try {
    var st = XJ.store.state;
    st.plans = st.plans || {};
    Object.keys(st.symbols).slice(0, 3).forEach(function (sym, i) {
      var d = new Date(); d.setDate(d.getDate() + 20 + i * 10);
      var k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      st.plans[sym + '_2026-06-30'] = {
        planId: sym + '_2026-06-30', symbol: sym, reportDate: '2026-06-30', reportType: '中期分配',
        pretaxBonusPer10: 2 + i, afterTaxPer10: null, implPlanProfile: '10派' + (2 + i) + '元',
        planNoticeDate: '2026-08-01', noticeDate: '2026-08-01',
        equityRecordDate: null, exDividendDate: k, payoutDate: null,
        assignProgress: '实施分配', progressRank: 100, isImplemented: true, source: 'cn',
      };
    });
    XJ.store.commitNow(null);
    XJ.store.setUI({ tab: 'calendar', calView: 'calendar', subPage: null, pendCollapsed: false });
    out.subviews.pendCard = measure();
    /* 日历图例三色必须可区分：派息日曾与「除权除息」几乎同色（橙红 vs 红），图上分不出来。
       现在派息日改用绿色 —— 这里直接读计算样式，防止以后回归。 */
    out.subviews.calLegendColors = Array.prototype.slice.call(
      document.querySelectorAll('.cal-legend span i')
    ).map(function (n) { return String(getComputedStyle(n).backgroundColor || ''); });
    out.subviews.calPayoutOk = (function () {
      var c = out.subviews.calLegendColors;
      if (c.length < 3) return 'legend-missing:' + c.length;
      if (c[1] === c[2]) return 'same-as-exdiv';
      /* 不用正则：这段代码在模板字符串里，\s 这类转义会被吞掉，改用 split 解析 */
      var nums = c[2].replace('rgb(', '').replace(')', '').split(',')
        .map(function (x) { return Number(String(x).trim()); });
      return (nums[1] > nums[0] && nums[1] > nums[2]) ? true : ('not-green:' + c[2]);
    })();
    out.subviews.pendItems = document.querySelectorAll('.pend-item').length;
    out.subviews.pendTags = document.querySelectorAll('.pi-tag').length;
    out.subviews.pendTotal = ((document.querySelector('.pend-sub b') || {}).textContent) || '';
    out.subviews.pendSub = ((document.querySelector('.pend-sub') || {}).textContent) || '';
    out.subviews.pendTbdTags = document.querySelectorAll('.pi-tbd').length;
    out.subviews.pendWhenTexts = Array.prototype.slice.call(
      document.querySelectorAll('.pi-when')).map(function (n) { return n.textContent.trim(); });
    /* 排序：除权日已确定的必须在待定之前 */
    out.subviews.pendDatedFirst = (function () {
      var flags = Array.prototype.slice.call(document.querySelectorAll('.pi-when'))
        .map(function (n) { return !!n.querySelector('.pi-tbd'); });   // true = 待定
      var firstTbd = flags.indexOf(true);
      var lastDated = flags.lastIndexOf(false);
      return firstTbd < 0 || lastDated < 0 || lastDated < firstTbd;
    })();
    /* 再补一条「董事会决议通过、除权日未定」的方案：必须也进待除权 */
    (function () {
      var st2 = XJ.store.state;
      /* 必须挑一只当前**不在**待除权卡里的标的，否则同一标的会被聚合进已有条目，
         条目数不变 —— 曾经就因为这个把断言写错了 */
      /* 种子里所有标的都已在卡片里（且部分已有未来除权日的方案），
         所以挑一个**种子里肯定没有的代码**，新建一只只有「董事会决议通过」方案的标的 */
      var target = ['sh603993', 'sh600585', 'sz002415', 'sh600900', 'sz000651', 'sh601899', 'sh600111']
        .filter(function (c) { return !st2.symbols[c]; })[0];
      if (!target) { out.subviews.pendNoFreeSymbol = true; return; }
      var accId = st2.accounts[0].accountId;
      st2.transactions.push({
        txId: 'pend_probe_tx', accountId: accId, symbol: target, action: 'BUY',
        date: '2025-03-03', quantity: 1000, price: 30, fee: 0, createdAt: '2025-03-03T01:00:00Z',
      });
      st2.symbols[target] = XJ.model.symbolRecord(target, { name: '中国神华' });
      st2.quoteCache[target] = { symbol: target, name: '中国神华', price: 32, prevClose: 32, changePct: 0 };
      st2.plans[target + '_undated'] = {
        planId: target + '_undated', symbol: target, reportDate: '2026-06-30', reportType: '中报',
        pretaxBonusPer10: 12.5, afterTaxPer10: null, implPlanProfile: '10派12.50元(含税)',
        planNoticeDate: '2026-08-20', noticeDate: '2026-08-20',
        equityRecordDate: null, exDividendDate: null, payoutDate: null,
        assignProgress: '董事会决议通过', progressRank: 60, isImplemented: false, source: 'cn',
      };
      XJ.store.commitNow(null);
      XJ.store.setUI({ tab: 'calendar', calView: 'calendar', pendCollapsed: false });
    })();
    out.subviews.pendItemsAfterUndated = document.querySelectorAll('.pend-item').length;
    out.subviews.pendDebug = (function () {
      var pd = XJ.calc.pendingExDiv(XJ.store.state, XJ.calc.ALL);
      return { count: pd.count, dated: pd.datedCount, undated: pd.undatedCount,
               items: pd.items.map(function (x) { return x.name + '|' + Math.round(x.amount) + '|' + (x.dateKnown ? 'D' : 'U'); }) };
    })();
    out.subviews.pendTbdAfterUndated = document.querySelectorAll('.pi-tbd').length;
    out.subviews.pendSubAfterUndated = ((document.querySelector('.pend-sub') || {}).textContent) || '';
    var tp = document.querySelector('[data-act="togglePend"]');
    if (tp) {
      tp.click(); await sleep(60);
      out.subviews.pendCollapsed = !!document.querySelector('.pend-card.collapsed');
      document.querySelector('[data-act="togglePend"]').click(); await sleep(60);
      out.subviews.pendExpandedAgain = !document.querySelector('.pend-card.collapsed');
    }
  } catch (e) { out.subviews.pendCard = { error: String(e && e.message) }; }

  try {
    XJ.store.setUI({ tab: 'overview', subPage: null, pendCollapsed: false });
    await sleep(80);
    out.subviews.holdCards = document.querySelectorAll('.hold-card').length;
    out.subviews.delButtons = document.querySelectorAll('.hold-card [data-act="deleteHolding"]').length;
    out.subviews.nestedButtons = document.querySelectorAll('button button').length;  // 必须 0：不能嵌套
  } catch (e) { out.subviews.delButtons = { error: String(e && e.message) }; }

  /* 删除持仓：点图标 → 弹二次确认 → 取消后数据不变 */
  try {
    XJ.store.setUI({ tab: 'overview', subPage: null, pendCollapsed: false });
    await sleep(80);
    var txBefore = XJ.store.state.transactions.length;
    var firstDel = document.querySelector('.hold-card [data-act="deleteHolding"]');
    firstDel.click();
    await sleep(90);
    out.subviews.delConfirmShown = !!document.querySelector('.sheet [data-act="__confirm_ok"]');
    out.subviews.delConfirmText = ((document.querySelector('.sheet p') || {}).textContent || '').slice(0, 70);
    var cancel = document.querySelector('[data-act="__confirm_cancel"]');
    if (cancel) cancel.click();
    await sleep(70);
    out.subviews.delCancelled = XJ.store.state.transactions.length === txBefore;
  } catch (e) { out.subviews.delConfirmShown = { error: String(e && e.message) }; }

  /* 截图识别 · 端到端：桩替换 API → 识别 → 手改代码 → 导入（复现「中远海控→保利发展」bug） */
  try {
    var keepState = JSON.stringify({
      transactions: XJ.store.state.transactions,
      received: XJ.store.state.received,
      symbols: XJ.store.state.symbols,
      quoteCache: XJ.store.state.quoteCache,
    });
    var realFetch = window.fetch;
    window.__ocrN = 0;
    window.fetch = function (url, opt) {
      if (String(url).indexOf('bigmodel.cn') < 0) return realFetch.apply(this, arguments);
      window.__ocrN++;
      var body = window.__ocrN === 1
        ? { choices: [{ message: { content: 'TRADE' } }] }
        : {
          choices: [{
            message: {
              content: JSON.stringify({
                name: '中远海控', code: null, trades: [
                  { date: '2026-08-28', action: '买入', price: 16.95, quantity: 200, amount: 3390, fee: 0.38 },
                  { date: '2026-06-25', action: '分红', price: null, quantity: null, amount: 748, fee: null },
                ],
              }),
            },
          }],
        };
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    };

    XJ.store.state.settings.ocr.agreed = true;
    XJ.store.state.ocrKind_ = null;
    XJ.store.setUI({ tab: 'overview', subPage: null, floatOpen: true, pendCollapsed: false });
    await sleep(80);
    document.querySelector('[data-act="floatOcr"]').click();
    await sleep(340);
    document.querySelector('.sheet [data-act="pickOcrImages"]').click();
    await sleep(120);

    /* 注入假图片文件（headless 下无法弹原生文件框，直接塞 FileList） */
    var finp = document.querySelector('input[type="file"]');
    if (!finp) throw new Error('未创建 file input');
    var dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([255, 216, 255, 0])], 'probe.jpg', { type: 'image/jpeg' }));
    finp.files = dt.files;
    finp.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(900);

    out.subviews.ocrTradeSheet = !!document.querySelector('.sheet [data-act="importOcrTrades"]');
    var nameInp = document.querySelector('.sheet [data-k="stockName"]');
    var codeInp = document.querySelector('.sheet [data-k="stockCode"]');
    out.subviews.ocrName = nameInp ? nameInp.value : null;
    out.subviews.ocrCodeBefore = codeInp ? codeInp.value : null;

    /* 关键：用户手改代码 → 预览必须跟着变，导入必须用这个值 */
    if (codeInp) {
      codeInp.value = '601919';
      codeInp.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(60);
      out.subviews.ocrSymPreview = ((document.querySelector('#xj-ocr-sym') || {}).textContent) || '';
    }
    document.querySelector('.sheet [data-act="importOcrTrades"]').click();
    await sleep(120);

    var txsNow = XJ.store.state.transactions;
    out.subviews.ocrImportedTo601919 = txsNow.filter(function (t) {
      return t.symbol === 'sh601919' && t.note === '截图识别导入';
    }).length;
    out.subviews.ocrImportedTo600048 = txsNow.filter(function (t) {
      return t.symbol === 'sh600048' && t.note === '截图识别导入';
    }).length;
    out.subviews.ocrDivDedup = XJ.store.state.received.filter(function (r) {
      return r.symbol === 'sh601919';
    }).length;

    XJ.ui.closeSheet();
    window.fetch = realFetch;
    /* 还原状态，避免污染后续截图与断言 */
    var keep = JSON.parse(keepState);
    XJ.store.state.transactions = keep.transactions;
    XJ.store.state.received = keep.received;
    XJ.store.state.symbols = keep.symbols;
    XJ.store.state.quoteCache = keep.quoteCache;
    XJ.store.commitNow(null);
    XJ.store.setUI({ floatOpen: false });
  } catch (e) { out.subviews.ocrTradeSheet = { error: String(e && e.message) }; }

  /* 个股页：交易明细可编辑 + 位置 + 两处折叠 + 持仓明细可编辑 */
  try {
    XJ.store.setUI({ tab: 'overview', subPage: 'symbol', subArg: 'sh600023', floatOpen: false, foldPlans: true, foldTx: true });
    await sleep(110);
    var body = document.querySelector('.view-body');
    var txt = body ? body.textContent : '';

    /* 折叠态：交易明细默认收起，页面里不该有交易行 */
    var txHead = document.querySelector('[data-act="toggleFoldTx"]');
    out.subviews.txFoldHeadShown = !!txHead;
    out.subviews.txFoldFoldedByDefault = !!document.querySelector('[data-act="toggleFoldTx"] .fold-caret.folded');
    out.subviews.txRowsWhenFolded = document.querySelectorAll('.tx-row').length;

    /* 展开交易明细 → 行出现且可编辑 */
    if (txHead) { txHead.click(); await sleep(90); }
    var rows = Array.prototype.slice.call(document.querySelectorAll('.tx-row'));
    out.subviews.txRows = rows.length;
    out.subviews.txEditableRows = rows.filter(function (r) { return r.getAttribute('data-act') === 'editTx'; }).length;
    out.subviews.txDivRows = rows.filter(function (r) { return r.classList.contains('tx-div'); }).length;
    /* 每一行要么可编辑（交易），要么是只读的分红行 —— 不允许出现第 3 种 */
    out.subviews.txRowsClassified = rows.every(function (r) {
      return r.getAttribute('data-act') === 'editTx' || r.classList.contains('tx-div');
    });

    /* 交易明细必须排在「持仓数量」之后 */
    var txt2 = document.querySelector('.view-body').textContent;
    out.subviews.txAfterQty = txt2.indexOf('持仓数量') >= 0 && txt2.indexOf('持仓数量') < txt2.indexOf('交易明细');
    out.subviews.txBeforeRefund = txt2.indexOf('交易明细') < txt2.indexOf('分红回本进度');
    out.subviews.txBeforePlans = txt2.indexOf('交易明细') < txt2.indexOf('分红档案');
    out.subviews.plansTitleOk = txt2.indexOf('分红档案') >= 0;

    /* 分红档案折叠（选择器必须限定到该卡片，否则会命中交易明细的 caret） */
    var fh = document.querySelector('[data-act="toggleFoldPlans"]');
    out.subviews.foldHeadShown = !!fh;
    out.subviews.foldFoldedByDefault = !!(fh && fh.querySelector('.fold-caret.folded'));
    out.subviews.foldCollapsedHint = txt2.indexOf('已收起') >= 0;
    if (fh) {
      fh.click(); await sleep(90);
      var fh2 = document.querySelector('[data-act="toggleFoldPlans"]');
      out.subviews.foldExpandedAfterClick = !!(fh2 && !fh2.querySelector('.fold-caret.folded'));
      fh2.click(); await sleep(90);
      var fh3 = document.querySelector('[data-act="toggleFoldPlans"]');
      out.subviews.foldBackToFolded = !!(fh3 && fh3.querySelector('.fold-caret.folded'));
    }

    /* 点一行交易 → 打开编辑弹层（折叠操作会整页重渲染，必须重新查询节点） */
    var freshRows = document.querySelectorAll('.tx-row[data-act="editTx"]');
    if (freshRows.length) {
      freshRows[0].click();
      await sleep(160);
      out.subviews.txEditorOpened = !!document.querySelector('.sheet [data-act="saveTx"]');
      out.subviews.txEditorHasDelete = !!document.querySelector('.sheet [data-act="deleteTx"]');
      out.subviews.txEditorTitle = ((document.querySelector('.sheet h3') || {}).textContent) || '';
      out.subviews.txEditorId = (document.querySelector('.sheet [data-act="saveTx"]') || {}).getAttribute
        ? document.querySelector('.sheet [data-act="saveTx"]').getAttribute('data-id') : null;
      XJ.ui.closeSheet();
      await sleep(60);
    }

    /* 分红摊薄是否可见 + 是否真的在摊薄成本 */
    out.subviews.diluteHint = (function () {
      var b = document.querySelector('.view-body');
      return !!b && /已用累计分红/.test(b.textContent);
    })();
    out.subviews.diluteMethod = (XJ.calc.holdings(XJ.store.state, XJ.calc.ALL)
      .filter(function (h) { return h.symbol === 'sh600023'; })[0] || {}).costMethod;

    /* 持仓明细：标题 + 两个可编辑入口 */
    XJ.store.setUI({ subPage: 'symbol', subArg: 'sh600023', floatOpen: false });
    await sleep(90);
    var body2 = document.querySelector('.view-body');
    out.subviews.detailTitleOk = !!body2 && body2.textContent.indexOf('持仓明细') >= 0;
    out.subviews.qtyEditBtn = !!document.querySelector('[data-act="editQty"]');
    out.subviews.costEditBtn = !!document.querySelector('[data-act="editCost"]');

    /* 改数量：预览应算出「调整后」的股数与成本 */
    var qb = document.querySelector('[data-act="editQty"]');
    if (qb) {
      qb.click(); await sleep(120);
      var qIn = document.querySelector('.sheet [data-k="qty"]');
      var before = XJ.store.state.transactions.length;
      if (qIn) {
        qIn.value = String(Number(qIn.value) + 100);
        qIn.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(60);
        out.subviews.qtyPreviewText = ((document.querySelector('#xj-qty-preview') || {}).textContent) || '';
        document.querySelector('.sheet [data-act="saveQty"]').click();
        await sleep(160);
        out.subviews.qtyTxAdded = XJ.store.state.transactions.length - before;
        out.subviews.qtyAfterAdjust = (XJ.calc.holdings(XJ.store.state, XJ.calc.ALL)
          .filter(function (h) { return h.symbol === 'sh600023'; })[0] || {}).qty;
      }
      XJ.ui.closeSheet();
      await sleep(60);
    }

    /* 改成本：应补一笔 ADJUST 记录，且股数不变 */
    var cb = document.querySelector('[data-act="editCost"]');
    if (cb) {
      cb.click(); await sleep(120);
      var cIn = document.querySelector('.sheet [data-k="avg"]');
      var qtyBefore = (XJ.calc.holdings(XJ.store.state, XJ.calc.ALL)
        .filter(function (h) { return h.symbol === 'sh600023'; })[0] || {}).qty;
      var nBefore = XJ.store.state.transactions.length;
      if (cIn) {
        var cur = Number(String(cIn.value).replace(/,/g, ''));
        cIn.value = (cur * 1.1).toFixed(4);
        cIn.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(60);
        out.subviews.costPreviewText = ((document.querySelector('#xj-cost-preview') || {}).textContent) || '';
        document.querySelector('.sheet [data-act="saveCost"]').click();
        await sleep(160);
        var news = XJ.store.state.transactions.slice(-1)[0];
        out.subviews.costAdjAction = news && news.action;
        out.subviews.costAdjAmount = news && news.amount;
        out.subviews.costAdjCount = XJ.store.state.transactions.length - nBefore;
        var hAfter = XJ.calc.holdings(XJ.store.state, XJ.calc.ALL)
          .filter(function (h) { return h.symbol === 'sh600023'; })[0] || {};
        out.subviews.costAdjQtySame = Math.abs(hAfter.qty - qtyBefore) < 1e-6;
        out.subviews.costAdjAvg = hAfter.avgCost;
      }
      XJ.ui.closeSheet();
      await sleep(60);
    }

    /* 点 ADJUST 行 → 应打开「编辑成本调整」弹层 */
    var adjRow = Array.prototype.slice.call(document.querySelectorAll('.tx-row')).filter(function (tr) {
      var id = tr.getAttribute('data-id');
      return XJ.store.state.transactions.some(function (t) { return t.txId === id && t.action === 'ADJUST'; });
    })[0];
    if (adjRow) {
      adjRow.click(); await sleep(150);
      out.subviews.adjEditorTitle = ((document.querySelector('.sheet h3') || {}).textContent) || '';
      out.subviews.adjEditorHasAmount = !!document.querySelector('.sheet [data-k="amount"]');
      XJ.ui.closeSheet();
      await sleep(60);
    }
    XJ.store.setUI({ subPage: null });
    /* 清掉探针里产生的 toast，避免它们糊到后面的截图里 */
    var tr = document.getElementById('toast-root');
    if (tr) tr.innerHTML = '';
    XJ.ui.closeSheet();
  } catch (e) { out.subviews.txRows = { error: String(e && e.message) }; }

  /* 个股页：股息率曲线（财年口径）—— 曲线/散点/时间轴/余额宝开关/拖动 */
  try {
    var ySym = 'sh600023';
    var yYmd = function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    var todayY2 = todayYmd();

    /* 造 10 年【交易日】日线（只存收盘价）—— 曲线必须按交易日等距，
       所以这里逐日生成、跳过周末，用来验证相邻点相隔 1 个交易日。 */
    var dayPts = [];
    (function () {
      var d = new Date(), i = 0, px;
      while (dayPts.length < 2450) {                     // ≈10 年交易日
        d.setDate(d.getDate() - 1);
        if (d.getDay() === 0 || d.getDay() === 6) continue;
        px = 10 + Math.sin(dayPts.length / 90) * 1.4 + dayPts.length * 0.0008;
        dayPts.push([yYmd(d), Math.round(px * 1000) / 1000]);
        i++;
      }
      dayPts.reverse();
    })();
    XJ.store.state.yieldHistory = XJ.store.state.yieldHistory || {};
    XJ.store.state.yieldHistory[ySym] = { v: 2, at: todayY2, day: dayPts };
    /* 分红方案沿用种子里的 FY2024 / FY2025（它们的 equityRecordDate 已足够定生效日，
       不额外改 state.plans —— 那会挪动其它断言依赖的数字）。 */
    XJ.store.state.settings.showYieldBench = false;
    XJ.store.state.benchHistory = {
      at: todayY2,
      points: (function () {
        var a = [], i, d;
        for (i = 0; i < 520; i++) {
          d = new Date(); d.setDate(d.getDate() - (520 - i) * 7);
          a.push([yYmd(d), Math.round((1.6 - i * 0.0016) * 1000) / 1000]);
        }
        return a;
      })(),
    };
    XJ.store.commitNow(null);
    XJ.store.setUI({ subPage: 'symbol', subArg: ySym, floatOpen: false, yjBeg: null, yjEnd: null });
    await sleep(140);

    out.subviews.yjCard = !!document.querySelector('.yj-card');
    out.subviews.yjTitleOk = /股息率/.test(((document.querySelector('.yj-card .card-head') || {}).textContent) || '');
    out.subviews.yjChartSvg = document.querySelectorAll('.yj-chart svg[data-chart="yield"]').length;
    out.subviews.yjCurve = document.querySelectorAll('.yj-chart svg[data-chart="yield"] path[stroke]').length;
    /* ★ 除权除息日散点：三年三条（其中一条与另一条同日则少一个，这里互不相同应为 3） */
    out.subviews.yjMarks = document.querySelectorAll('.yj-chart .xjc-marks circle').length;
    out.subviews.yjBrush = document.querySelectorAll('.yj-brush svg[data-brush="yield"]').length;
    out.subviews.yjHandles = document.querySelectorAll('.yj-brush .xjc-brush-h').length;
    out.subviews.yjNoteOk = /该财年派现总额/.test(((document.querySelector('.yj-note') || {}).textContent) || '');
    /* ★ 横轴必须按【交易日】等距：相邻点相隔 1 个交易日，跨周末才是 3 天。
       这是用户反馈过的 bug —— 早先用周线兜十年，相邻点差好几天。 */
    out.subviews.yjGaps = (function () {
      try {
        var svg0 = document.querySelector('.yj-chart svg[data-chart="yield"]');
        var cd = JSON.parse(svg0.getAttribute('data-cmp') || 'null');
        var ds = cd.dates || [], gaps = [], one = 0;
        for (var q = 1; q < ds.length; q++) {
          var g = Math.round((new Date(ds[q] + 'T00:00:00') - new Date(ds[q - 1] + 'T00:00:00')) / 86400000);
          gaps.push(g);
          if (g === 1) one++;
        }
        return { n: gaps.length, oneDay: one, max: gaps.length ? Math.max.apply(null, gaps) : 0,
          sample: ds.slice(0, 3).concat(['…'], ds.slice(-2)) };
      } catch (e) { return { err: String(e && e.message) }; }
    })();
    out.subviews.yjAxisTitle = /最近十年 · 日线/.test(((document.querySelector('.yj-card .hint') || {}).textContent) || '');
    /* 默认不画余额宝那条 */
    out.subviews.yjBenchRowsOff = document.querySelectorAll('.yj-legend .yj-leg-btn.off').length;
    out.subviews.yjLegendItems = document.querySelectorAll('.yj-legend > span, .yj-legend > button').length;

    /* 拖动时间轴：把左抓手往右拖 → 主图应重画（曲线 d 变化） */
    var yjSnap = function () {
      var hl = document.querySelector('.yj-brush .xjc-brush-hl');
      var hr = document.querySelector('.yj-brush .xjc-brush-hr');
      var sel = document.querySelector('.yj-brush .xjc-brush-sel');
      var pp = document.querySelector('.yj-chart svg[data-chart="yield"] path[stroke]');
      return {
        hl: hl ? hl.getAttribute('transform') : null,
        hr: hr ? hr.getAttribute('transform') : null,
        selW: sel ? sel.getAttribute('width') : null,
        beg: ((document.querySelector('.xjc-brush-beg') || {}).textContent) || '',
        dLen: pp ? String(pp.getAttribute('d')).length : -1,
        uiBeg: XJ.store.ui.yjBeg, uiEnd: XJ.store.ui.yjEnd,
      };
    };
    var snapBefore = yjSnap();
    var dBefore = (function () {
      var p = document.querySelector('.yj-chart svg[data-chart="yield"] path[stroke]');
      return p ? String(p.getAttribute('d')) : '';
    })();
    var svgBrush = document.querySelector('.yj-brush svg[data-brush="yield"]');
    if (svgBrush) {
      var r = svgBrush.getBoundingClientRect();
      var yMid = r.top + r.height * 0.72;   // 落在概览条本体上（避开顶部的日期标签）
      /* ★ 起手必须打在**当前文档里真实存在**的元素上：若这期间发生过整页重渲染，
         先前抓到的节点会脱离文档，而脱离文档的节点派发事件不会冒泡到 document，
         处理器根本不会触发 —— 这正是本用例曾经时通时不过的原因。
         用 elementFromPoint 取该坐标下活的元素，等价于真实用户点在那里。 */
      var liveHandle = document.elementFromPoint(r.left + r.width * 0.02, yMid) ||
        document.querySelector('.yj-brush .xjc-brush-hl');
      var fire = function (type, x, node) {
        (node || liveHandle).dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, clientX: x, clientY: yMid, pointerId: 1, isPrimary: true,
        }));
      };
      fire('pointerdown', r.left + r.width * 0.02);
      await sleep(40);
      fire('pointermove', r.left + r.width * 0.5, document);
      await sleep(90);
      var snapAfter = yjSnap();
      var hxVal = -1;
      var hx = snapAfter.hl || '';
      var pOpen = hx.indexOf('('), pComma = hx.indexOf(',');
      if (pOpen >= 0 && pComma > pOpen) { hxVal = Number(hx.slice(pOpen + 1, pComma)); }
      out.subviews.yjDragMovedHandle = hxVal > 100;
      var pathAfter = document.querySelector('svg[data-chart="yield"] path[stroke]');
      var dAfter = pathAfter ? String(pathAfter.getAttribute('d')) : '';
      out.subviews.yjDragRedrewMain = !!pathAfter && dAfter !== dBefore;
      out.subviews.yjDragDbg = { rect: { l: Math.round(r.left), w: Math.round(r.width) },
        before: snapBefore, after: snapAfter, sameHead: dBefore.slice(0, 24) === dAfter.slice(0, 24) };
      fire('pointerup', r.left + r.width * 0.5, document);
      await sleep(90);
      /* 松手后应把范围静默写进 ui（不触发整页重建，所以节点还在） */
      out.subviews.yjDragSavedRange = !!(XJ.store.ui.yjBeg && XJ.store.ui.yjEnd);
      out.subviews.yjDragNoRerender = !!document.querySelector('.yj-card');
    }

    /* 图例开关：打开余额宝 → 多一条曲线 */
    var benchBtn = document.querySelector('[data-act="toggleYieldBench"]');
    if (benchBtn) {
      benchBtn.click();
      await sleep(200);
      out.subviews.yjBenchOn = XJ.store.state.settings.showYieldBench === true;
      var rows = document.querySelectorAll('svg[data-chart="yield"] .xjc-cmprow').length;
      out.subviews.yjBenchRowsOn = rows;
      out.subviews.yjBenchSwatch = document.querySelectorAll('.yj-legend .yj-leg-btn.on').length;
      /* 拖一次读数气泡：应显示不带 + 号的百分比（unit:'yield'）。
         照抄资产走势那张图的可用姿势：pointerdown + pointermove 都要发，
         只发 down 不足以复现（其余参数保持一致）。 */
      var mainSvg = document.querySelector('svg[data-chart="yield"]');
      if (mainSvg) {
        /* 先把图滚到可视区中央再取坐标：股息率卡上方多了图例/读数行之后，
           小视口下图表中点会落到折叠线以下，elementFromPoint 就取不到它，
           事件被派发到别的元素上、document 级委托收不到（曾被误判成「气泡坏了」）。 */
        mainSvg.scrollIntoView({ block: 'center' });
        await sleep(80);
        mainSvg = document.querySelector('svg[data-chart="yield"]') || mainSvg;
        var marked = function () {
          var m = document.querySelector('svg[data-chart="yield"] .xjc-cmpmarker');
          return !!(m && m.style.display !== 'none');
        };
        /* 起手要在**当前文档里活的**元素上（否则若中途整页重渲染过，事件不会冒泡到 document）。
           ★ 但更麻烦的是：离线时行情请求失败会走 .catch 里的 notify()，**派发与读取之间**
           可能刚好发生一次整页重渲染 —— 那时标记组会被重建回 display:none，
           现象就是「事件明明落在图上、坐标也在视口内，却一个标记都没有」。
           所以这里循环重试：每次都重新取一次 SVG 与坐标，直到标记出来或试满 3 次。 */
        var attempt = 0;
        for (; attempt < 3 && !marked(); attempt++) {
          mainSvg = document.querySelector('svg[data-chart="yield"]') || mainSvg;
          var mr = mainSvg.getBoundingClientRect();
          var cx = mr.left + mr.width * 0.6, cy = mr.top + mr.height / 2;
          var mOpts = { bubbles: true, cancelable: true, pointerId: 1, clientX: cx, clientY: cy };
          if (attempt === 0) {
            out.subviews.yjVp = [window.innerWidth, window.innerHeight];
            out.subviews.yjRect = [Math.round(mr.left), Math.round(mr.top), Math.round(mr.width), Math.round(mr.height)];
            var hit = document.elementFromPoint(cx, cy);
            out.subviews.yjHitEl = hit ? String(hit.tagName || '') + '.' +
              String((hit.getAttribute && hit.getAttribute('class')) || '') : 'null';
          }
          mainSvg.dispatchEvent(new PointerEvent('pointerdown', mOpts));
          mainSvg.dispatchEvent(new PointerEvent('pointermove', mOpts));
          await sleep(90);
        }
        out.subviews.yjBubbleAttempts = attempt;
        var mk = document.querySelector('svg[data-chart="yield"] .xjc-cmpmarker');
        out.subviews.yjMarkerShown = !!(mk && mk.style.display !== 'none');
        var dv = document.querySelector('svg[data-chart="yield"] .xjc-cmpv');
        out.subviews.yjBubbleText = (mk ? (mk.textContent || '') : '') || (dv ? dv.textContent : '');
        out.subviews.yjBubbleVals = Array.prototype.slice
          .call(document.querySelectorAll('svg[data-chart="yield"] .xjc-cmpv'))
          .map(function (t) { return t.textContent; });
        out.subviews.yjCmpUnit = (function () {
          try { return JSON.parse(mainSvg.getAttribute('data-cmp') || 'null').unit; } catch (e) { return 'ERR'; }
        })();
        document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
      }
      /* 再关掉，恢复默认态 */
      var benchBtn2 = document.querySelector('[data-act="toggleYieldBench"]');
      if (benchBtn2) { benchBtn2.click(); await sleep(160); }
    }

    /* 场外基金 / 美股：不应出现曲线，只给一行说明 */
    XJ.store.setUI({ subPage: 'symbol', subArg: 'of110022', floatOpen: false, yjBeg: null, yjEnd: null });
    await sleep(110);
    out.subviews.yjFundNoChart = document.querySelectorAll('.yj-chart svg').length;
    out.subviews.yjFundNote = /无法按财年口径/.test(((document.querySelector('.yj-card') || {}).textContent) || '');

    /* ★ 历史平均股息率线（分财年）。种子里这条线本来就能画出来，
       这里只验证「画了虚线 + 图例常亮不可关 + 点它是换口径而不是关掉」。 */
    try {
      XJ.store.setUI({ subPage: 'symbol', subArg: 'sh600023', floatOpen: false, yjBeg: null, yjEnd: null, yieldAvgMode: 'year' });
      await sleep(150);

      var avgSvg = document.querySelector('.yj-chart svg[data-chart="yield"]');
      var avgCmp = null;
      try { avgCmp = JSON.parse(avgSvg.getAttribute('data-cmp') || 'null'); } catch (e2) { avgCmp = null; }
      out.subviews.yjAvgRows = avgCmp ? avgCmp.rows.length : 0;
      out.subviews.yjAvgRowName = avgCmp && avgCmp.rows[1] ? avgCmp.rows[1].name : '';
      /* 均线必须是虚线：chart.js 只在 series.dash 时输出带 stroke-dasharray 的 path */
      out.subviews.yjAvgDashed = document.querySelectorAll('.yj-chart svg[data-chart="yield"] path[stroke-dasharray]').length;
      out.subviews.yjAvgLegend = document.querySelectorAll('[data-act="switchYieldAvg"]').length;
      /* ★ 均线常亮不可关闭 —— 图例那一项不许出现 off 态（否则会被读成「已关闭」） */
      out.subviews.yjAvgLegendOff = document.querySelectorAll('[data-act="switchYieldAvg"].off').length;
      out.subviews.yjAvgText0 = ((document.querySelector('[data-act="switchYieldAvg"]') || {}).textContent) || '';
      var statTxt = ((document.querySelector('.yj-avg-stat') || {}).textContent) || '';
      out.subviews.yjAvgStat = statTxt;
      out.subviews.yjAvgStatOk = /(高于均值|低于均值|不足 [0-9]+ 天)/.test(statTxt);
      /* ★ 产品红线：这张卡里不许出现建议性字眼 */
      out.subviews.yjNoAdvice = !/(买入|卖出|建议|推荐)/.test(((document.querySelector('.yj-card') || {}).textContent) || '');

      var yjPaths = function () { return document.querySelectorAll('.yj-chart svg[data-chart="yield"] path[stroke]'); };
      var yjAvgPath = function (i) { var p = yjPaths()[i]; return p ? p.getAttribute('d') : ''; };
      var dYear = yjAvgPath(1);
      var avgBtn = document.querySelector('[data-act="switchYieldAvg"]');
      if (avgBtn) { avgBtn.click(); await sleep(220); }
      out.subviews.yjAvgModeAfter = XJ.store.ui.yieldAvgMode;
      out.subviews.yjAvgTextAfter = ((document.querySelector('[data-act="switchYieldAvg"]') || {}).textContent) || '';
      out.subviews.yjAvgPathChanged = !!dYear && dYear !== yjAvgPath(1);
      /* ★ 点它是【换口径】不是关闭：曲线条数不许变少 */
      out.subviews.yjAvgPathsAfter = yjPaths().length;
      /* 口径复位，后面的断言与截图不受影响 */
      XJ.store.setUI({ yieldAvgMode: 'year' });
      await sleep(120);
    } catch (e) { out.subviews.yjAvgErr = String(e && e.message); }

    XJ.store.setUI({ subPage: null });
    XJ.ui.closeSheet();
  } catch (e) { out.subviews.yjCard = { error: String(e && e.message) }; }

  /* 分红覆盖排序：已覆盖在左、未覆盖在右 */
  try {
    XJ.store.setUI({ tab: 'overview', subPage: null, floatOpen: false });
    await sleep(90);
    var icons = Array.prototype.slice.call(document.querySelectorAll('.cover-icon'));
    var litFlags = icons.map(function (b) { return b.classList.contains('on'); });
    var firstOff = litFlags.indexOf(false);
    var lastOn = litFlags.lastIndexOf(true);
    out.subviews.coverTotal = icons.length;
    out.subviews.coverLit = litFlags.filter(Boolean).length;
    out.subviews.coverSorted = firstOff < 0 || lastOn < firstOff;
  } catch (e) { out.subviews.coverSorted = { error: String(e && e.message) }; }

  /* 发现页：分红汇总入口卡的位置 / 旧区块已移除 / 点进去能到汇总页 */
  try {
    XJ.store.setUI({ tab: 'find', subPage: null, floatOpen: false });
    await sleep(120);
    var dsCards = Array.prototype.slice.call(document.querySelectorAll('#view-body .card'));
    var coverIdx = -1, nextIdx = -1, entryIdx = -1;
    dsCards.forEach(function (c, i) {
      var t = ((c.querySelector('h2') || {}).textContent) || '';
      if (/分红覆盖/.test(t)) coverIdx = i;
      if (/下一个目标/.test(t)) nextIdx = i;
      if (c.classList && c.classList.contains('ds-entry')) entryIdx = i;
    });
    out.subviews.dsEntryIdx = entryIdx;
    out.subviews.dsEntryAfterCover = coverIdx >= 0 && entryIdx > coverIdx;
    out.subviews.dsEntryBeforeNext = nextIdx < 0 || entryIdx < nextIdx;
    out.subviews.dsEntryText = ((document.querySelector('.ds-entry') || {}).textContent) || '';
    out.subviews.dsEntryAmt = ((document.querySelector('.ds-entry-v') || {}).textContent) || '';
    var bodyEl = document.getElementById('view-body');
    out.subviews.dsOldStatsGone = !!bodyEl && !/股息统计/.test(bodyEl.textContent || '');

    var eb = document.querySelector('.ds-entry');
    if (eb) { eb.click(); await sleep(170); }
    out.subviews.dsSubPage = XJ.store.ui.subPage;
    out.subviews.dsSubTitle = ((document.querySelector('.topbar-row h1') || {}).textContent) || '';
    out.subviews.dsHero = !!document.querySelector('.ds-hero');
    out.subviews.dsTotal = ((document.querySelector('.ds-total') || {}).textContent) || '';
    out.subviews.dsCap = ((document.querySelector('.ds-cap') || {}).textContent) || '';
    out.subviews.dsChips = document.querySelectorAll('.ds-ranges .chip').length;
    out.subviews.dsChipActive = ((document.querySelector('.ds-ranges .chip.active') || {}).textContent) || '';
    out.subviews.dsSymRows = document.querySelectorAll('.ds-row').length;
    out.subviews.dsDetailBefore = document.querySelectorAll('.ds-detail .ds-rec').length;

    var chipsAll = document.querySelectorAll('.ds-ranges .chip');
    var chip5y = chipsAll[2];
    if (chip5y) { chip5y.click(); await sleep(170); }
    out.subviews.dsChipActive5y = ((document.querySelector('.ds-ranges .chip.active') || {}).textContent) || '';
    out.subviews.dsYearBars5y = document.querySelectorAll('.ds-year').length;

    var srow = document.querySelector('.ds-row');
    if (srow) { srow.click(); await sleep(150); }
    out.subviews.dsDetailAfter = document.querySelectorAll('.ds-detail .ds-rec').length;
    var srow2 = document.querySelector('.ds-row');
    if (srow2) { srow2.click(); await sleep(120); }
    out.subviews.dsDetailClosed = document.querySelectorAll('.ds-detail .ds-rec').length;

    /* 复原，别影响后面的用例 */
    XJ.store.setUI({ tab: 'overview', subPage: null, divsumOpen: '', divsumRange: 'year' });
    await sleep(90);
  } catch (e) { out.subviews.dsErr = String(e && e.message) }; 

  /* 平板布局：≥768 持仓两列；≥1024 日历/分析分栏 */
  try {
    out.subviews.vw = window.innerWidth;
    var hl = document.querySelector('.hold-list');
    out.subviews.holdCols = hl ? getComputedStyle(hl).gridTemplateColumns.split(' ').length : 0;
    out.subviews.calSplitCols = (function () {
      XJ.store.setUI({ tab: 'calendar', calView: 'calendar', subPage: null });
      var cs = document.querySelector('.cal-split');
      return cs ? getComputedStyle(cs).gridTemplateColumns.split(' ').length : 0;
    })();
    out.subviews.anSplitCols = (function () {
      XJ.store.setUI({ tab: 'overview', subPage: 'analysis' });
      var an = document.querySelector('.an-split');
      return an ? getComputedStyle(an).gridTemplateColumns.split(' ').length : 0;
    })();
    XJ.store.setUI({ tab: 'overview', subPage: null });
    var tb = document.querySelector('.tabbar-inner');
    out.subviews.tabbarW = tb ? Math.round(tb.getBoundingClientRect().width) : 0;
  } catch (e) { out.subviews.holdCols = { error: String(e && e.message) }; }

  /* 交互冒烟 */
  var ix = {};
  try {
    XJ.store.setUI({ tab: 'calendar', calYear: 2026, calMonth: 9, selDate: null });
    document.querySelector('[data-act="calNext"]').click();
    ix.calAfterNext = XJ.store.ui.calMonth + '/' + XJ.store.ui.calYear;
    var dayBtn = document.querySelectorAll('[data-act="selDate"]')[0];
    if (dayBtn) { dayBtn.click(); ix.selDate = XJ.store.ui.selDate; }
    XJ.store.setUI({ tab: 'overview' });
    document.querySelectorAll('[data-act="setSort"]')[2].click();
    ix.sortMode = XJ.store.ui.sortMode;
    document.querySelectorAll('[data-act="switchAccount"]')[1].click();
    ix.accountId = XJ.store.ui.accountId;
    ix.holdingRows = document.querySelectorAll('#view-body [data-act="openSymbol"]').length;
    document.querySelectorAll('[data-act="switchAccount"]')[0].click();
    ix.holdingRowsAll = document.querySelectorAll('#view-body [data-act="openSymbol"]').length;
  } catch(e){ ix.error = String(e && e.message); }
  out.interactions = ix;

  /* 内存态探针：确认关键数字已渲染 */
  try {
    var s = XJ.calc.summary(XJ.store.state, XJ.calc.ALL);
    out.numbers = {
      holdings: s.count, marketValue: Math.round(s.totalMarketValue),
      predicted: Math.round(s.totalPredicted), compositeYield: +s.compositeYield.toFixed(2),
      receivedThisYear: Math.round(s.receivedThisYear),
      nextPayout: s.nextPayout ? s.nextPayout.date : null
    };
    out.storageMode = XJ.storage.getMode();
  } catch(e){ out.numbersError = String(e && e.message); }

  return out;
})()
`.replace('SEED_JSON', JSON.stringify(seed));

/* ---------------- CDP 极简客户端 ---------------- */
class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
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

/* ---------------- 启动 Chrome ---------------- */
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-uitest-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
  '--allow-file-access-from-files', '--hide-scrollbars', '--mute-audio',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,
  'about:blank',
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

/* ---------------- 主流程 ---------------- */
const VIEWPORTS = [
  [320, 640, 'iPhone SE 竖屏（最窄）'],
  [375, 812, 'iPhone 常规'],
  [414, 896, 'iPhone Plus'],
  [430, 932, 'iPhone Pro Max'],
  [812, 375, 'iPhone 横屏'],
  [932, 430, 'iPhone Pro Max 横屏'],
  [768, 1024, 'iPad 竖屏'],
  [1024, 768, 'iPad 横屏'],
  [1280, 900, '桌面'],
];

let totalFail = 0;
let browser, sessionId, targetId;
/* 安装链接那一节用的隔离浏览器上下文与本地站点服务器（见文件末尾） */

const SHOT_DIR = path.join(ROOT, 'shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

async function shot(name, tab, w, h) {
  try {
    // 把固定底栏临时改为静态，再整页截图，避免 fixed 元素在拼接时错位
    await browser.send('Runtime.evaluate', { expression: 'XJ.ui.closeSheet()' }, sessionId);
    var SETUP = {
      overview: { tab: 'overview', subPage: null, floatOpen: false },
      calendar: { tab: 'calendar', calView: 'calendar', subPage: null, floatOpen: false },
      annual: { tab: 'calendar', calView: 'annual', annualYear: null, annualMonth: null, subPage: null, floatOpen: false },
      find: { tab: 'find', subPage: null, floatOpen: false },
      mine: { tab: 'mine', subPage: null, floatOpen: false },
      analysis: { tab: 'overview', subPage: 'analysis', floatOpen: false },
      symbol: { tab: 'overview', subPage: 'symbol', subArg: 'sh600023', floatOpen: false },
      addForm: { tab: 'overview', subPage: null, floatOpen: false },
      ocr: { tab: 'overview', subPage: null, floatOpen: false },
    }[tab] || { tab: 'overview', subPage: null, floatOpen: false };
    await browser.send('Runtime.evaluate', {
      expression: 'var n=new Date(); XJ.store.setUI(Object.assign({calYear:n.getFullYear(), calMonth:n.getMonth()+1,' +
        'accountId:XJ.calc.ALL, sortMode:"dividend", marketFilter:"all", selDate:null}, ' + JSON.stringify(SETUP) + '));',
    }, sessionId);
    await sleep(400);
    var isSheet = (tab === 'addForm' || tab === 'ocr');

    /* 分析页截图前先灌 90 天快照，否则只能拍到空态 */
    if (tab === 'analysis') {
      await browser.send('Runtime.evaluate', {
        expression: "(function(){var s=XJ.store.state; s.snapshots=s.snapshots||{}; var base=1180000;" +
          "for(var i=89;i>=0;i--){var d=new Date(); d.setDate(d.getDate()-i);" +
          "var k=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');" +
          "s.snapshots[k]={mv:Math.round(base+Math.sin(i/7)*42000+(89-i)*1450),cost:1150800,pred:45650,recv:31955};}})();" +
          "XJ.store.commitNow(null);",
      }, sessionId);
      await sleep(240);
    }

    await browser.send('Runtime.evaluate', {
      expression: (isSheet ? '' : 'XJ.ui.closeSheet(); ') +
        "XJ.store.ui.busy=false; XJ.store.ui.status=''; XJ.store.ui.offline=false; " +
        "var tb=document.querySelector('.tabbar'); if(tb){tb.style.position='static';tb.style.marginTop='8px';}",
    }, sessionId);

    /* 弹层类截图：添加持仓三步表单 / 截图识别面板 */
    if (isSheet) {
      await browser.send('Emulation.setDeviceMetricsOverride', {
        width: w, height: 1560, deviceScaleFactor: 1, mobile: w < 700,
      }, sessionId);
      if (tab === 'addForm') {
        await browser.send('Runtime.evaluate', {
          expression: "document.querySelector('[data-act=\"openAddHolding\"]').click();" +
            "document.querySelector('[data-act=\"pickMarket\"][data-key=\"custom\"]').click();" +
            "var q=document.querySelector('.sheet [data-k=\"query\"]');" +
            "q.value='sh600023'; q.dispatchEvent(new Event('input',{bubbles:true}));",
        }, sessionId);
      } else {
        await browser.send('Runtime.evaluate', {
          expression: "XJ.store.state.settings.ocr.agreed = true;" +
            "XJ.store.setUI({ floatOpen: true });" +
            "document.querySelector('[data-act=\"floatOcr\"]').click();",
        }, sessionId);
        await sleep(320);
      }
      await sleep(460);
    } else {
      await sleep(180);
    }
    const s = await browser.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false,
    }, sessionId);
    /* shots/ 是本机产物（.gitignore 已忽略），首次运行时并不存在 —— 自己建，
       否则每次截图都会 ENOENT，白白刷一堆「截图失败」。 */
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(SHOT_DIR, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('      📸 shots/' + name + '.png');
    await browser.send('Runtime.evaluate', {
      expression: "var tb=document.querySelector('.tabbar'); if(tb){tb.style.position='';tb.style.marginTop='';} " +
        (isSheet ? 'XJ.ui.closeSheet();' : ''),
    }, sessionId);
    await browser.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 1, mobile: w < 700,
    }, sessionId);
  } catch (e) {
    console.log('      ⚠ 截图失败 ' + name + ': ' + e.message);
  }
}

function bad(msg) { totalFail++; console.log('      ✗ ' + msg); }

try {
  const wsUrl = await waitForDevtools();
  browser = new CDP(wsUrl);
  await browser.connect();

  const t = await browser.send('Target.createTarget', { url: 'about:blank' });
  targetId = t.targetId;
  const a = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  sessionId = a.sessionId;
  await browser.send('Page.enable', {}, sessionId);
  await browser.send('Runtime.enable', {}, sessionId);
  // 断网：让渲染只依赖注入的种子数据，截图与断言才是确定的
  await browser.send('Network.enable', {}, sessionId);
  await browser.send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  }, sessionId);

  const url = pathToFileURL(SRC).href;

  for (const [w, h, label] of VIEWPORTS) {
    console.log('\n[' + w + '×' + h + '] ' + label);

    await browser.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 1, mobile: w < 700,
    }, sessionId);

    await browser.send('Page.navigate', { url }, sessionId);

    // 等待应用就绪
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
    if (!ready) { bad('应用未能在 14 秒内启动'); continue; }
    await sleep(400);

    const res = await browser.send('Runtime.evaluate', {
      expression: PROBE, returnByValue: true, awaitPromise: true,
    }, sessionId);

    if (res.exceptionDetails) {
      bad('探针执行异常: ' + (res.exceptionDetails.exception
        ? res.exceptionDetails.exception.description || res.exceptionDetails.exception.value
        : JSON.stringify(res.exceptionDetails)));
      continue;
    }
    const r = res.result.value;
    if (!r) { bad('探针未返回结果'); continue; }
    if (r.fatal) { bad(r.fatal); continue; }

    console.log('      视口实测 innerWidth=' + r.viewport + ' · 存储=' + r.storageMode +
      (r.numbers ? ' · 持仓 ' + r.numbers.holdings + ' 只 / 分红 ¥' + r.numbers.predicted : ''));

    for (const tab of ['overview', 'calendar', 'find', 'mine']) {
      const tm = r.tabs[tab];
      const safe = tm.docW <= tm.vw + 1 && tm.overflowCount === 0;
      if (!safe) totalFail++;
      console.log('      ' + (safe ? '✓' : '✗') + ' Tab ' + tab +
        '  docW=' + tm.docW + '/vw=' + tm.vw + '  溢出=' + tm.overflowCount +
        '  截断=' + (tm.truncCount || 0) +
        '  顶层节点=' + tm.nodes + '  文案=' + tm.textLen + '字');
      if (tm.overflowCount) console.log('          ' + JSON.stringify(tm.overflow.slice(0, 2)));
      if (tm.truncCount) {
        totalFail++;
        console.log('          ⚠ 宽屏下不应截断: ' + JSON.stringify(tm.trunc));
      }
      if (tm.hcTruncCount) {
        totalFail++;
        console.log('          ⚠ 持仓卡片名字/代码行被截断: ' + JSON.stringify(tm.hcTrunc));
      }
    }

    for (const key of ['symbolDetail', 'addHolding', 'addHoldingExpanded', 'ocrPrivacy', 'ocrPanel', 'ocrSettings']) {
      const sm = r.sheets[key];
      if (!sm) { bad('弹层 ' + key + ' 未测到'); continue; }
      const safe = sm.docW <= sm.vw + 1 && sm.overflowCount === 0;
      if (!safe) totalFail++;
      console.log('      ' + (safe ? '✓' : '✗') + ' 弹层 ' + key + '  docW=' + sm.docW + '/vw=' + sm.vw + '  溢出=' + sm.overflowCount);
      if (sm.overflowCount) console.log('          ' + JSON.stringify(sm.overflow.slice(0, 2)));
    }
    if (r.sheets && r.sheets.ocrPrivacyHasAgree && r.sheets.ocrHasPicker && r.sheets.ocrSettingsHasKey) {
      console.log('      ✓ 截图识别：隐私确认 → 识别面板 → 设置（模型/API Key 已预置）全链路可点');
    } else {
      bad('截图识别流程不完整: ' + JSON.stringify({
        agree: r.sheets && r.sheets.ocrPrivacyHasAgree,
        picker: r.sheets && r.sheets.ocrHasPicker,
        key: r.sheets && r.sheets.ocrSettingsHasKey,
      }));
    }
    if (r.sheets && r.sheets.stepsEnabled && r.sheets.submitEnabled) {
      console.log('      ✓ 三步表单：选股后步骤 2/3 展开、提交按钮启用，年均每股分红 ' + r.sheets.basisPreview);
    } else {
      bad('三步表单未正确展开: ' + JSON.stringify({ steps: r.sheets.stepsEnabled, submit: r.sheets.submitEnabled }));
    }

    /* 待除权卡片（息记样式） */
    const pc = (r.subviews || {}).pendCard;
    if (pc && !pc.error) {
      const safe = pc.docW <= pc.vw + 1 && pc.overflowCount === 0;
      if (!safe) totalFail++;
      console.log('      ' + (safe ? '✓' : '✗') + ' 待除权卡片  docW=' + pc.docW + '/vw=' + pc.vw +
        '  溢出=' + pc.overflowCount + '  标的 ' + r.subviews.pendItems + ' 个 · 市场标签 ' + r.subviews.pendTags +
        ' 个 · 合计 ' + r.subviews.pendTotal);
      if (r.subviews.pendItems >= 3) console.log('      ✓ 待除权卡片列出 ' + r.subviews.pendItems + ' 只标的（含种子方案）');
      else bad('待除权卡片标的数不足：' + r.subviews.pendItems);
      /* ★ 回归：方案已公布但除权日未定的，也必须在「等待除权日」里，并标注「除权日待定」 */
      if (r.subviews.pendItemsAfterUndated === r.subviews.pendItems + 1 &&
        r.subviews.pendTbdAfterUndated === r.subviews.pendTbdTags + 1 &&
        /除权日待定/.test(r.subviews.pendSubAfterUndated || '')) {
        console.log('      ✓ ★「已公布、除权日未定」的方案也计入待除权并标注「除权日待定」' +
          '（' + r.subviews.pendTbdAfterUndated + ' 只待定）');
        console.log('        头部：' + (r.subviews.pendSubAfterUndated || '').trim());
      } else {
        bad('除权日待定方案未正确计入: ' + JSON.stringify({
          before: r.subviews.pendItems, after: r.subviews.pendItemsAfterUndated,
          tbdBefore: r.subviews.pendTbdTags, tbdAfter: r.subviews.pendTbdAfterUndated,
          sub: r.subviews.pendSubAfterUndated, dbg: r.subviews.pendDebug }));
      }
      if (r.subviews.pendDatedFirst === true && r.subviews.pendTbdTags > 0) {
        console.log('      ✓ 待除权排序：已定除权日在前、待定在后（' + r.subviews.pendTbdTags + ' 条待定）');
      } else {
        bad('待除权排序异常: ' + JSON.stringify({
          datedFirst: r.subviews.pendDatedFirst, tbd: r.subviews.pendTbdTags }));
      }
      /* 派息日图例颜色必须与除权除息不同、且是绿色 */
      if (r.subviews.calPayoutOk === true) {
        console.log('      ✓ 日历图例三色可区分（派息日 ' + r.subviews.calLegendColors[2] + ' 为绿色，区别于除权除息 ' +
          r.subviews.calLegendColors[1] + '）');
      } else {
        bad('派息日图例颜色异常: ' + JSON.stringify({
          colors: r.subviews.calLegendColors, verdict: r.subviews.calPayoutOk }));
      }
    } else {
      bad('待除权卡片未渲染: ' + JSON.stringify(pc));
    }
    if (r.subviews && r.subviews.pendCollapsed && r.subviews.pendExpandedAgain) {
      console.log('      ✓ 待除权卡片折叠 / 展开交互正常');
    } else {
      bad('待除权卡片折叠交互异常');
    }

    /* 持仓删除按钮 */
    if (r.subviews && r.subviews.delButtons === r.subviews.holdCards && r.subviews.holdCards > 0) {
      console.log('      ✓ 每张持仓卡片都有独立删除按钮（' + r.subviews.delButtons + '/' + r.subviews.holdCards + '）');
    } else {
      bad('删除按钮数量与卡片数不一致: ' + JSON.stringify({
        cards: r.subviews && r.subviews.holdCards, del: r.subviews && r.subviews.delButtons }));
    }
    if (r.subviews && r.subviews.nestedButtons === 0) console.log('      ✓ 无嵌套 button（HTML 合法）');
    else bad('存在嵌套 button：' + (r.subviews && r.subviews.nestedButtons));

    if (r.subviews && r.subviews.delConfirmShown && r.subviews.delCancelled) {
      console.log('      ✓ 删除持仓：二次确认弹窗正常，取消后数据未变');
      console.log('         确认文案：' + String(r.subviews.delConfirmText).replace(/\s+/g, ' ').slice(0, 60));
    } else {
      bad('删除持仓确认流程异常: ' + JSON.stringify({
        shown: r.subviews && r.subviews.delConfirmShown, cancelled: r.subviews && r.subviews.delCancelled }));
    }

    /* 截图识别端到端（桩替换 API） */
    const ot = r.subviews && r.subviews.ocrTradeSheet;
    if (ot === true) {
      console.log('      ✓ OCR 端到端：识别为交易记录面板 · 名称「' + r.subviews.ocrName +
        '」· 图上无代码时输入框为空（' + JSON.stringify(r.subviews.ocrCodeBefore) + '）');
      if (String(r.subviews.ocrSymPreview).indexOf('sh601919') >= 0) {
        console.log('      ✓ 手改代码后预览同步：' + String(r.subviews.ocrSymPreview).trim());
      } else {
        bad('手改代码后标的预览未更新：' + r.subviews.ocrSymPreview);
      }
      if (r.subviews.ocrImportedTo601919 === 1 && r.subviews.ocrImportedTo600048 === 0) {
        console.log('      ✓ ★导入落到 sh601919（用户填的代码生效），未误写到 sh600048');
      } else {
        bad('★代码被覆盖！sh601919=' + r.subviews.ocrImportedTo601919 +
          ' sh600048=' + r.subviews.ocrImportedTo600048);
      }
      if (r.subviews.ocrDivDedup === 1) console.log('      ✓ 分红行写入 1 条（未重复）');
      else bad('分红行条数异常：' + r.subviews.ocrDivDedup);
    } else if (ot && ot.error) {
      bad('OCR 端到端异常: ' + ot.error);
    } else {
      bad('OCR 端到端未进入交易记录面板');
    }

    /* 个股页：交易明细 + 折叠 */
    if (r.subviews && typeof r.subviews.txRows === 'number') {
      if (r.subviews.txEditableRows > 0 && r.subviews.txRowsClassified === true) {
        console.log('      ✓ 交易明细每行可编辑（交易 ' + r.subviews.txEditableRows + ' 行' +
          (r.subviews.txDivRows ? ' + 分红摊薄只读 ' + r.subviews.txDivRows + ' 行' : '') + '）');
      } else {
        bad('交易明细行分类异常: ' + JSON.stringify({
          total: r.subviews.txRows, editable: r.subviews.txEditableRows,
          div: r.subviews.txDivRows, classified: r.subviews.txRowsClassified }));
      }
      if (r.subviews.txDivRows > 0) {
        console.log('      ✓ 分红到账以只读行并入交易明细（「分红摊薄」标记，不可编辑）');
      } else {
        bad('交易明细里没有分红摊薄行：' + r.subviews.txDivRows);
      }
      if (r.subviews.txFoldHeadShown && r.subviews.txFoldFoldedByDefault && r.subviews.txRowsWhenFolded === 0) {
        console.log('      ✓ 交易明细默认收起（收起态 0 行，展开后 ' + r.subviews.txRows + ' 行）');
      } else {
        bad('交易明细默认状态不对: ' + JSON.stringify({
          head: r.subviews.txFoldHeadShown, folded: r.subviews.txFoldFoldedByDefault,
          rowsWhenFolded: r.subviews.txRowsWhenFolded, rows: r.subviews.txRows }));
      }
      if (r.subviews.txAfterQty && r.subviews.txBeforeRefund && r.subviews.txBeforePlans) {
        console.log('      ✓ 交易明细已上移到「持仓数量」下方（在分红回本进度/分红档案之前）');
      } else {
        bad('交易明细位置不对: ' + JSON.stringify({
          afterQty: r.subviews.txAfterQty, beforeRefund: r.subviews.txBeforeRefund,
          beforePlans: r.subviews.txBeforePlans }));
      }
      if (r.subviews.foldHeadShown && r.subviews.foldFoldedByDefault && r.subviews.foldCollapsedHint &&
        r.subviews.foldExpandedAfterClick && r.subviews.foldBackToFolded) {
        console.log('      ✓ 分红档案默认折叠、点击展开/收起正常');
      } else {
        bad('分红档案折叠异常: ' + JSON.stringify({
          head: r.subviews.foldHeadShown, folded: r.subviews.foldFoldedByDefault,
          hint: r.subviews.foldCollapsedHint, expand: r.subviews.foldExpandedAfterClick,
          back: r.subviews.foldBackToFolded }));
      }
      if (r.subviews.txEditorOpened && r.subviews.txEditorHasDelete) {
        console.log('      ✓ 点交易行打开编辑弹层（含「删除这笔交易」）');
      } else {
        bad('交易行编辑弹层未打开');
      }

      /* 持仓明细：标题 + 可编辑 */
      if (r.subviews.diluteMethod === 'dividendDiluted' && r.subviews.diluteHint === true) {
        console.log('      ✓ 持仓明细显示「已用累计分红摊薄成本」提示（口径 = 分红摊薄）');
      } else {
        bad('分红摊薄提示缺失: ' + JSON.stringify({
          method: r.subviews.diluteMethod, hint: r.subviews.diluteHint }));
      }
      if (r.subviews.detailTitleOk && r.subviews.qtyEditBtn && r.subviews.costEditBtn) {
        console.log('      ✓ 「持仓明细」卡标题正确，数量与成本均可点开编辑');
      } else {
        bad('持仓明细卡异常: ' + JSON.stringify({
          title: r.subviews.detailTitleOk, qty: r.subviews.qtyEditBtn, cost: r.subviews.costEditBtn }));
      }
      if (r.subviews.qtyTxAdded === 1 && /调整后/.test(r.subviews.qtyPreviewText || '')) {
        console.log('      ✓ 改数量：预览给出调整后持仓 · 补记 1 笔交易 · 调整后 ' +
          r.subviews.qtyAfterAdjust + ' 股');
      } else {
        bad('改数量失败: ' + JSON.stringify({
          added: r.subviews.qtyTxAdded, preview: r.subviews.qtyPreviewText }));
      }
      if (r.subviews.costAdjAction === 'ADJUST' && r.subviews.costAdjCount === 1 &&
        r.subviews.costAdjQtySame === true && /调整/.test(r.subviews.costPreviewText || '')) {
        console.log('      ✓ 改成本：补记 1 笔「成本调整」' + r.subviews.costAdjAmount +
          '，股数不变，调整后均价 ' + Number(r.subviews.costAdjAvg).toFixed(4));
      } else {
        bad('改成本失败: ' + JSON.stringify({
          action: r.subviews.costAdjAction, count: r.subviews.costAdjCount,
          qtySame: r.subviews.costAdjQtySame, avg: r.subviews.costAdjAvg }));
      }
      if (/成本调整/.test(r.subviews.adjEditorTitle || '') && r.subviews.adjEditorHasAmount) {
        console.log('      ✓ 点「成本调整」行打开专属编辑弹层（可改金额/删除）');
      } else {
        bad('成本调整行编辑弹层异常: ' + JSON.stringify({
          title: r.subviews.adjEditorTitle, amount: r.subviews.adjEditorHasAmount }));
      }
    } else {
      bad('个股页交易明细未渲染: ' + JSON.stringify(r.subviews && r.subviews.txRows));
    }

    /* 个股页：股息率曲线（财年口径） */
    if (r.subviews && r.subviews.yjCard === true) {
      if (r.subviews.yjTitleOk && (r.subviews.yjCurve > 0) && r.subviews.yjChartSvg > 0) {
        console.log('      ✓ 股息率曲线卡已渲染：' + r.subviews.yjCurve + ' 条曲线 · ' +
          r.subviews.yjMarks + ' 个除权除息散点 · 图例 ' + r.subviews.yjLegendItems + ' 项');
      } else {
        bad('股息率曲线未渲染: ' + JSON.stringify({
          title: r.subviews.yjTitleOk, svg: r.subviews.yjChartSvg, curve: r.subviews.yjCurve }));
      }
      if (r.subviews.yjMarks >= 3) {
        console.log('      ✓ 除权除息日散点画出 ' + r.subviews.yjMarks +
          ' 个（日线粒度下正好命中当日，无需跨周吸附）');
      } else {
        bad('除权除息散点缺失: ' + r.subviews.yjMarks);
      }
      if (r.subviews.yjBrush === 1 && r.subviews.yjHandles === 2) {
        console.log('      ✓ 时间轴（brush）独立成 SVG，左右两个抓手各就位');
      } else {
        bad('时间轴异常: ' + JSON.stringify({ svg: r.subviews.yjBrush, handles: r.subviews.yjHandles }));
      }
      if (r.subviews.yjNoteOk) {
        console.log('      ✓ 底部标注口径「= 该财年派现总额 ÷ 当时总市值」');
      } else {
        bad('缺少口径注释');
      }
      /* ★ 交易日粒度：1 日间隔应占多数，最长间隔不超过 4 天（跨周末 3 天 + 余量） */
      var gp = r.subviews.yjGaps || {};
      if (r.subviews.yjAxisTitle && gp.n > 200 && gp.oneDay / gp.n > 0.6 && gp.max <= 4) {
        console.log('      ✓ 横轴为交易日粒度：' + gp.n + ' 个间隔中 ' + gp.oneDay +
          ' 个相隔 1 个交易日，最长 ' + gp.max + ' 天（跨周末）');
      } else {
        bad('横轴不是交易日粒度: ' + JSON.stringify(gp) + ' title=' + r.subviews.yjAxisTitle);
      }
      if (r.subviews.yjBenchRowsOff === 1) {
        console.log('      ✓ 余额宝七日年化默认关闭（图例呈灰态）');
      } else {
        bad('余额宝基准线默认态不对: ' + r.subviews.yjBenchRowsOff);
      }
      if (r.subviews.yjDragMovedHandle === true && r.subviews.yjDragRedrewMain === true) {
        console.log('      ✓ 拖动时间轴抓手：抓手跟手移动，主图实时重画');
      } else {
        bad('时间轴拖动异常: ' + JSON.stringify({
          moved: r.subviews.yjDragMovedHandle, redrew: r.subviews.yjDragRedrewMain,
          dbg: r.subviews.yjDragDbg }));
      }
      if (r.subviews.yjDragSavedRange === true && r.subviews.yjDragNoRerender === true) {
        console.log('      ✓ 松手后范围静默存入 ui 且未触发整页重建（滚动不跳）');
      } else {
        bad('拖动收尾异常: ' + JSON.stringify({
          saved: r.subviews.yjDragSavedRange, noRerender: r.subviews.yjDragNoRerender }));
      }
      /* 打开余额宝后共 3 条：股息率 + 历史平均股息率（常亮）+ 余额宝 */
      if (r.subviews.yjBenchOn === true && r.subviews.yjBenchRowsOn === 3 && r.subviews.yjBenchSwatch === 1) {
        console.log('      ✓ 点图例打开余额宝基准：曲线由 2 条变 3 条，图例同步高亮');
      } else {
        bad('余额宝基准线开关异常: ' + JSON.stringify({
          on: r.subviews.yjBenchOn, rows: r.subviews.yjBenchRowsOn, swatch: r.subviews.yjBenchSwatch }));
      }
      if (r.subviews.yjCmpUnit === 'yield' && r.subviews.yjMarkerShown === true &&
        /[\d.]+%/.test(r.subviews.yjBubbleText || '') && !/\+[\d.]+%/.test(r.subviews.yjBubbleText || '')) {
        console.log('      ✓ 读数气泡用「5.46%」样式（unit=yield，不带 + 号）');
      } else {
        bad('读数气泡格式不对: ' + JSON.stringify({
          unit: r.subviews.yjCmpUnit, shown: r.subviews.yjMarkerShown, text: r.subviews.yjBubbleText,
          hit: r.subviews.yjHitEl, tries: r.subviews.yjBubbleAttempts,
          rect: r.subviews.yjRect, vp: r.subviews.yjVp }));
      }
      /* ★ 两条曲线都要有读数，不能出现「—」。
         用户反馈过：某一天股息率显示成横杠 —— 那是「横轴取并集、某条曲线当天没有点」时的空洞，
         现已改成前值填充（顶部的验证断言里也单独锁了这条）。 */
      var yjVals = (r.subviews.yjBubbleVals || []).join(' ');
      if ((r.subviews.yjBubbleVals || []).length >= 1 && !/—/.test(yjVals) && /%/.test(yjVals)) {
        console.log('      ✓ 气泡内每一条曲线都读到数值、无空洞：' + yjVals);
      } else {
        bad('气泡里出现了空洞（应为前值填充）: ' + yjVals);
      }
      if (r.subviews.yjFundNoChart === 0 && r.subviews.yjFundNote === true) {
        console.log('      ✓ 场外基金不画曲线，只给一行说明');
      } else {
        bad('场外基金处理异常: ' + JSON.stringify({
          charts: r.subviews.yjFundNoChart, note: r.subviews.yjFundNote }));
      }

      /* ★ 历史平均股息率线（分财年，方案B） */
      var av = r.subviews;
      if (av.yjAvgRows === 2 && av.yjAvgRowName === '历史平均股息率' && av.yjAvgDashed === 1 &&
        av.yjAvgLegend === 1 && av.yjAvgLegendOff === 0) {
        console.log('      ✓ 历史平均股息率线：虚线画出、图例常亮（无 off 态，点它是换口径不是关闭）');
      } else {
        bad('平均股息率线未正确渲染: ' + JSON.stringify({
          rows: av.yjAvgRows, name: av.yjAvgRowName, dashed: av.yjAvgDashed,
          legend: av.yjAvgLegend, off: av.yjAvgLegendOff, err: av.yjAvgErr }));
      }
      if (av.yjAvgStatOk === true) {
        console.log('      ✓ 均线读数只用中性表述：' + av.yjAvgStat);
      } else {
        bad('均线读数文案异常（应只出现「高于/低于均值」或样本不足提示）: ' + JSON.stringify(av.yjAvgStat));
      }
      if (av.yjNoAdvice === true) {
        console.log('      ✓ 股息率卡内不出现「买入/卖出/建议/推荐」字样（产品红线）');
      } else {
        bad('股息率卡里出现了建议性字眼，违反产品红线');
      }
      if (av.yjAvgModeAfter === 'cum' && av.yjAvgPathChanged === true && av.yjAvgPathsAfter === 2 &&
        av.yjAvgText0 !== av.yjAvgTextAfter) {
        console.log('      ✓ 点图例切换均线口径：' + av.yjAvgText0 + ' → ' + av.yjAvgTextAfter + '，线换了但没消失');
      } else {
        bad('均线口径切换异常: ' + JSON.stringify({
          mode: av.yjAvgModeAfter, changed: av.yjAvgPathChanged, paths: av.yjAvgPathsAfter,
          t0: av.yjAvgText0, t1: av.yjAvgTextAfter }));
      }
    } else {
      bad('个股页股息率曲线卡未渲染: ' + JSON.stringify(r.subviews && r.subviews.yjCard));
    }

    /* 分红覆盖排序 */
    if (r.subviews && r.subviews.coverSorted === true) {
      console.log('      ✓ 分红覆盖排序：已覆盖 ' + r.subviews.coverLit + '/' + r.subviews.coverTotal +
        ' 项，全部排在左侧');
    } else {
      bad('分红覆盖排序不对: ' + JSON.stringify({
        sorted: r.subviews && r.subviews.coverSorted,
        lit: r.subviews && r.subviews.coverLit, total: r.subviews && r.subviews.coverTotal }));
    }

    /* 分红汇总：入口卡的位置 + 页面本身 */
    if (r.subviews && r.subviews.dsEntryAfterCover === true && r.subviews.dsEntryBeforeNext === true &&
      r.subviews.dsOldStatsGone === true && /分红汇总/.test(r.subviews.dsEntryText || '') &&
      /^¥/.test(r.subviews.dsEntryAmt || '')) {
      console.log('      ✓ 分红汇总入口卡在「分红覆盖」之后、「下一个目标」之前，旧「股息统计」区块已移除' +
        '（右侧 ¥' + String(r.subviews.dsEntryAmt || '').slice(1) + '）');
    } else {
      bad('分红汇总入口卡位置/内容不对: ' + JSON.stringify({
        idx: r.subviews && r.subviews.dsEntryIdx,
        afterCover: r.subviews && r.subviews.dsEntryAfterCover,
        beforeNext: r.subviews && r.subviews.dsEntryBeforeNext,
        oldGone: r.subviews && r.subviews.dsOldStatsGone,
        text: r.subviews && r.subviews.dsEntryText, err: r.subviews && r.subviews.dsErr }));
    }
    if (r.subviews && r.subviews.dsSubPage === 'divsummary' && r.subviews.dsSubTitle === '分红汇总' &&
      r.subviews.dsHero === true && r.subviews.dsCap === '分红总额' &&
      r.subviews.dsChips === 5 && r.subviews.dsChipActive === '今年') {
      console.log('      ✓ 点入口进「分红汇总」子页：五档时间胶囊，默认「今年」，主卡总额 ' +
        r.subviews.dsTotal);
    } else {
      bad('分红汇总页渲染不对: ' + JSON.stringify({
        page: r.subviews && r.subviews.dsSubPage, title: r.subviews && r.subviews.dsSubTitle,
        hero: r.subviews && r.subviews.dsHero, cap: r.subviews && r.subviews.dsCap,
        chips: r.subviews && r.subviews.dsChips, active: r.subviews && r.subviews.dsChipActive,
        err: r.subviews && r.subviews.dsErr }));
    }
    if (r.subviews && r.subviews.dsChipActive5y === '近5年' && r.subviews.dsYearBars5y >= 2 &&
      /^¥/.test(r.subviews.dsTotal || '')) {
      console.log('      ✓ 切到「近5年」：按年区块出现 ' + r.subviews.dsYearBars5y + ' 条（跨多年才显示）');
    } else {
      bad('分红汇总切档位异常: ' + JSON.stringify({
        active: r.subviews && r.subviews.dsChipActive5y,
        bars: r.subviews && r.subviews.dsYearBars5y, total: r.subviews && r.subviews.dsTotal }));
    }
    if (r.subviews && r.subviews.dsSymRows > 0 && r.subviews.dsDetailBefore === 0 &&
      r.subviews.dsDetailAfter > 0 && r.subviews.dsDetailClosed === 0) {
      console.log('      ✓ 按标的行可展开到账明细（展开 ' + r.subviews.dsDetailAfter + ' 行，再点收起）');
    } else {
      bad('分红汇总标的展开异常: ' + JSON.stringify({
        rows: r.subviews && r.subviews.dsSymRows, before: r.subviews && r.subviews.dsDetailBefore,
        after: r.subviews && r.subviews.dsDetailAfter, closed: r.subviews && r.subviews.dsDetailClosed }));
    }

    /* 账户分析里的「资产走势」卡（已替换掉原来的快照「资产变动」曲线） */
    if (r.subviews && r.subviews.anCard && r.subviews.anChart) {
      console.log('      ✓ 账户分析的资产走势卡已渲染：网格线 ' + r.subviews.anGridLines +
        ' 条 · 区间 ' + r.subviews.anRangeChips + ' 档 · 指标 ' + r.subviews.anMetricBtns + ' 个');
      if (r.subviews.anMarkerShown && r.subviews.anBandWidth > 0 && r.subviews.anMarkerRows >= 1) {
        console.log('      ✓ 分析页拖动读数生效：高亮带宽 ' + r.subviews.anBandWidth +
          ' · ' + r.subviews.anMarkerRows + ' 行读数（' + (r.subviews.anMarkerText || '').trim() + '）');
      } else {
        bad('分析页资产走势卡拖动读数异常: ' + JSON.stringify({
          marker: r.subviews.anMarkerShown, band: r.subviews.anBandWidth, rows: r.subviews.anMarkerRows }));
      }
      if (r.subviews.anMetricAfter === 'nw' && r.subviews.homeMetricAfter === 'mv') {
        console.log('      ✓ 两处资产走势卡状态独立（分析页切到净资产，首页仍是持仓市值）');
      } else {
        bad('两处资产走势卡状态未独立: ' + JSON.stringify({
          an: r.subviews.anMetricAfter, home: r.subviews.homeMetricAfter }));
      }
    } else {
      bad('账户分析里没有找到资产走势卡: ' + JSON.stringify({
        card: r.subviews && r.subviews.anCard,
        chart: r.subviews && r.subviews.anChart,
        charts: r.subviews && r.subviews.anChartCount,
        cardText: r.subviews && r.subviews.anCardText,
        err: r.subviews && r.subviews.analysis && r.subviews.analysis.error,
        textLen: r.subviews && r.subviews.analysis && r.subviews.analysis.textLen,
      }));
    }

    /* 持仓总市值曲线（首页新增卡片） */
    if (r.subviews && r.subviews.nwRendered) {
      console.log('      ✓ 持仓总市值曲线已渲染：日粒度 ' + r.subviews.nwDayPoints + ' 点 · 月粒度 ' +
        r.subviews.nwMonthPoints + ' 点 · 近一月 ' + r.subviews.nwMonthRange1mPoints + ' 点');
      console.log('        大数字 ' + r.subviews.nwAmountText.trim() + ' · ' + r.subviews.nwDeltaText.trim());
      if (r.subviews.nwGranChips === 2 && r.subviews.nwRangeChips === 7 &&
        r.subviews.nwRangeLabels === '当日/本月/近三月/近6月/今年/全部/自定义') {
        console.log('      ✓ 区间/粒度切换齐全：粒度 2 档 · 区间 7 档（' + r.subviews.nwRangeLabels + '）');
      } else {
        bad('区间/粒度档位不对: gran=' + r.subviews.nwGranChips +
          ' range=' + r.subviews.nwRangeChips + ' labels=' + r.subviews.nwRangeLabels);
      }
      if (r.subviews.nwMonthPoints > 0 && r.subviews.nwMonthPoints < r.subviews.nwDayPoints) {
        console.log('      ✓ 月粒度确实降采样（点数变少）');
      } else {
        bad('月粒度未降采样: day=' + r.subviews.nwDayPoints + ' month=' + r.subviews.nwMonthPoints);
      }
      if (r.subviews.nwMonthRange1mPoints > 0 && r.subviews.nwMonthRange1mPoints < r.subviews.nwDayPoints) {
        console.log('      ✓ 区间切换生效（本月点数少于全部）');
      } else {
        bad('区间切换无效: 1m=' + r.subviews.nwMonthRange1mPoints + ' all=' + r.subviews.nwDayPoints);
      }
      if (r.subviews.nwCustomInputs === 2) console.log('      ✓ 自定义区间出现 2 个日期输入');
      else bad('自定义区间日期输入数异常：' + r.subviews.nwCustomInputs);
      if (r.subviews.nwGridLines > 0 && (r.subviews.nwAxisLabels || []).some(function (t) { return /万|亿/.test(t); })) {
        console.log('      ✓ 纵轴刻度为整万/整亿（' +
          (r.subviews.nwAxisLabels || []).filter(function (t) { return /万|亿/.test(t); }).slice(0, 3).join(' / ') + '）');
      } else {
        bad('纵轴刻度未按万/亿显示：' + JSON.stringify(r.subviews.nwAxisLabels));
      }
      if (r.subviews.nwMarkerShown) console.log('      ✓ 市值曲线拖动读数生效：' + r.subviews.nwMarkerText);
      else bad('市值曲线拖动未显示读数');
      if (!/^¥/.test(r.subviews.nwAmountText.trim()) || !/较区间起点/.test(r.subviews.nwDeltaText)) {
        bad('市值卡大数字/较区间起点文案异常');
      }
    } else {
      bad('持仓总市值曲线未渲染: ' + JSON.stringify(r.subviews && r.subviews.nw));
    }

    /* 一键切换 持仓市值 / 累计收益（这条曲线原名「净资产」，实为累计收益，2026-09 改名） */
    if (r.subviews && r.subviews.nwMetricChips === 3) {
      if (r.subviews.nwActiveMetricAfter === 'nw' &&
        r.subviews.nwNwText !== r.subviews.nwMvText &&
        /累计收益/.test(r.subviews.nwNwLegend || '') &&
        /^¥/.test((r.subviews.nwNwText || '').trim()) &&
        /累计收益 = 持仓总市值/.test(r.subviews.nwNoteNw || '')) {
        console.log('      ✓ 一键切换：市值 ' + r.subviews.nwMvText.trim() +
          ' → 累计收益 ' + r.subviews.nwNwText.trim() + '（图例与口径说明同步切换）');
        console.log('        累计收益较区间起点：' + (r.subviews.nwDeltaNw || '').trim());
      } else {
        bad('市值/累计收益切换异常: ' + JSON.stringify({
          chips: r.subviews.nwMetricChips, after: r.subviews.nwActiveMetricAfter,
          mv: r.subviews.nwMvText, nw: r.subviews.nwNwText,
          legend: r.subviews.nwNwLegend, note: (r.subviews.nwNoteNw || '').slice(0, 40),
        }));
      }
      if (r.subviews.nwNwMarker && /^¥/.test(r.subviews.nwNwMarker.trim())) {
        console.log('      ✓ 净资产曲线拖动读数生效：' + r.subviews.nwNwMarker.trim());
      } else {
        bad('净资产曲线拖动无读数：' + r.subviews.nwNwMarker);
      }
      /* 图例色块必须与曲线同色，否则会被误读成两条线 */
      if (r.subviews.nwLegendColor && r.subviews.nwLineColor &&
        r.subviews.nwLegendColor === r.subviews.nwLineColor) {
        console.log('      ✓ 净资产曲线与图例同色（' + r.subviews.nwLineColor + '）');
      } else {
        bad('图例颜色与曲线不一致: 图例=' + r.subviews.nwLegendColor + ' 曲线=' + r.subviews.nwLineColor);
      }
    } else {
      bad('资产走势指标切换按钮数异常（应为 3）：' + (r.subviews && r.subviews.nwMetricChips));
    }

    /* 尺寸：曲线容器限宽 + 大数字不再过大（平板两档放宽到 620/660，见 style.css） */
    if (r.subviews && r.subviews.nwChartWidth && r.subviews.nwChartWidth <= 660) {
      console.log('      ✓ 曲线容器限宽生效：' + r.subviews.nwChartWidth + 'px（max-width ' +
        r.subviews.nwChartMaxW + '）· 大数字 ' + r.subviews.nwAmountFont + 'px');
      if (r.subviews.nwAmountFont <= 27) console.log('      ✓ 大数字字号已收敛（≤27px）');
      else bad('大数字字号仍偏大：' + r.subviews.nwAmountFont + 'px');
    } else {
      bad('曲线容器未限宽（应 ≤660）：' + (r.subviews && r.subviews.nwChartWidth) + 'px');
    }

    /* 平板布局：≥768 持仓两列；≥1024 日历/分析分栏；Tab 不被拉散 */
    if (r.subviews.vw >= 1024) {
      if (r.subviews.holdCols === 2 && r.subviews.calSplitCols === 2 && r.subviews.anSplitCols === 2) {
        console.log('      ✓ 平板横屏分栏生效：持仓 2 列 · 日历 2 列 · 分析 2 列 · Tab 宽 ' +
          r.subviews.tabbarW + 'px');
      } else {
        bad('平板分栏未生效: ' + JSON.stringify({
          hold: r.subviews.holdCols, cal: r.subviews.calSplitCols,
          an: r.subviews.anSplitCols, tabbar: r.subviews.tabbarW }));
      }
    } else if (r.subviews.vw >= 768) {
      if (r.subviews.holdCols === 2 && r.subviews.tabbarW <= 560) {
        console.log('      ✓ iPad 竖屏持仓两列 · Tab 宽受控 ' + r.subviews.tabbarW + 'px');
      } else {
        bad('iPad 竖屏布局未生效: ' + JSON.stringify({
          hold: r.subviews.holdCols, tabbar: r.subviews.tabbarW }));
      }
    } else if (r.subviews.holdCols !== 0 && r.subviews.holdCols !== 1) {
      bad('手机端持仓不应分列：' + r.subviews.holdCols);
    }

    /* 卡片点击展开 / 收起 */
    /* ★ 收益率曲线 + 指数对比 */
    if (r.subviews && r.subviews.retActive === 'ret') {
      var sb = r.subviews;
      if (/^[+−-]?\d/.test((sb.retAmountText || '').trim()) && /%/.test(sb.retAmountText || '') &&
        /时间加权收益率/.test(sb.retSubText || '')) {
        console.log('      ✓ 第三条曲线「收益率」：' + sb.retAmountText.trim() + '（' + sb.retSubText.trim() + '）');
      } else {
        bad('收益率大数字异常: ' + JSON.stringify({ v: sb.retAmountText, sub: sb.retSubText }));
      }
      if (sb.retIdxItems === 5 && sb.retIdxOn === 3 && /标普500/.test(sb.retIdxNames || '') &&
        !/日经225|台湾加权|韩国KOSPI/.test(sb.retIdxNames || '')) {
        console.log('      ✓ 对比指数图例 5 个（无数据源的 3 个已移除）、默认选中 3 个');
      } else {
        bad('指数图例异常: ' + JSON.stringify({ n: sb.retIdxItems, on: sb.retIdxOn, names: sb.retIdxNames }));
      }
      if (sb.retLines === 4) console.log('      ✓ 组合 + 3 个指数同步叠加（' + sb.retLines + ' 条曲线）');
      else bad('叠加曲线条数异常：' + sb.retLines);
      if (sb.retAxis >= 2) console.log('      ✓ 纵轴切换为百分比刻度（' + sb.retAxis + ' 个 % 刻度）');
      else bad('收益率纵轴不是百分比：' + sb.retAxis);
      if (sb.retVsItems === 3) console.log('      ✓ 卡片上逐条列出与指数的高低差（' + sb.retVsItems + ' 项）');
      else bad('指数对比摘要项数异常：' + sb.retVsItems);
      if (/时间加权收益率（TWR）/.test(sb.retNoteText || '')) console.log('      ✓ 口径说明写明 TWR 剔除加仓影响');
      else bad('缺少 TWR 口径说明：' + (sb.retNoteText || '').slice(0, 60));
      if (sb.retBubbleWidth >= 120 && sb.retBubbleRowsAll === 4) {
        console.log('      ✓ 拖动气泡宽度自适应（' + sb.retBubbleWidth + 'px，4 行完整显示，不再截断）');
      } else {
        bad('气泡宽度不足: ' + JSON.stringify({ w: sb.retBubbleWidth, rows: sb.retBubbleRowsAll }));
      }
      if (sb.retBandWidth > 0 && sb.retBubbleRows === 4 && /%/.test(sb.retBubbleText || '')) {
        console.log('      ✓ 拖动读数：竖向高亮带（宽 ' + sb.retBandWidth + '）+ 4 行多值气泡（' + sb.retBubbleText.trim() + '）');
      } else {
        bad('拖动高亮带/多值气泡异常: ' + JSON.stringify({ band: sb.retBandWidth, rows: sb.retBubbleRows, text: sb.retBubbleText }));
      }
      if (sb.retKsAdded === true && sb.retKsRemoved === true) {
        console.log('      ✓ 指数可随意勾选/取消（标普500 增删均生效）');
      } else {
        bad('指数勾选异常: ' + JSON.stringify({ add: sb.retKsAdded, del: sb.retKsRemoved }));
      }
      if (sb.retNoDataGone === true) {
        console.log('      ✓ 无历史源的指数（日经225 / 台湾加权 / 韩国KOSPI）已整项从图例移除');
      } else {
        bad('无数据源指数仍出现在图例里: ' + JSON.stringify({ gone: sb.retNoDataGone }));
      }
      if (sb.retModeChips === 2 && sb.retMode === 'candle' && sb.retCandles > 10 && /蜡烛/.test(sb.retCandleNote || '')) {
        console.log('      ✓ 曲线收益率 / K线收益率 可切换（蜡烛 ' + sb.retCandles + ' 根）');
      } else {
        bad('曲线/K线切换异常: ' + JSON.stringify({ chips: sb.retModeChips, mode: sb.retMode, candles: sb.retCandles }));
      }
      if (sb.retTodayRange === 'today' && sb.retIdxDisabled === 2) {
        console.log('      ✓ 区间含「当日」（7 档）；当日下 2 个无分时的美股指数自动置灰');
      } else {
        bad('当日区间处理异常: ' + JSON.stringify({ range: sb.retTodayRange, disabled: sb.retIdxDisabled }));
      }
      /* ★ 当日三指标都不空 */
      var tm = sb.todayMetrics || {};
      var tmBad = [];
      ['ret', 'mv', 'nw'].forEach(function (k) {
        var v = tm[k] || {};
        if (!(v.chart > 0 && v.paths > 0 && v.empty === false)) tmBad.push(k + '=' + JSON.stringify(v));
      });
      if (!tmBad.length) {
        console.log('      ✓ 当日区间三种指标（收益率/市值/净资产）都画出曲线，无空态');
      } else {
        bad('当日曲线为空: ' + tmBad.join(' | '));
      }
    } else {
      bad('收益率曲线未生效：' + (r.subviews && r.subviews.retActive));
    }

    if (r.subviews && r.subviews.nwFoldBtn) {
      if (r.subviews.nwCollapsed && r.subviews.nwCollapsedClass &&
        r.subviews.nwChartWhenCollapsed === 0 && r.subviews.nwMiniShown &&
        r.subviews.nwReexpanded && r.subviews.nwChartBack) {
        console.log('      ✓ 资产走势卡可点击收起（收起后 ' + (r.subviews.nwMiniText || '').trim().slice(0, 24) + '）并再次展开');
      } else {
        bad('资产走势卡收起/展开异常: ' + JSON.stringify({
          collapsed: r.subviews.nwCollapsed, cls: r.subviews.nwCollapsedClass,
          chart: r.subviews.nwChartWhenCollapsed, mini: r.subviews.nwMiniShown,
          re: r.subviews.nwReexpanded, back: r.subviews.nwChartBack }));
      }
    } else {
      bad('资产走势卡缺少收起按钮');
    }

    /* 公司图标：有 logoUrl 的叠加 img，没有的用两字中文简称
       （用 example.invalid 做 src，必然加载失败 → 由 onerror 隐藏，不影响「有 img」的判定） */
    if (r.subviews && r.subviews.logoImgRendered === true &&
      /example\.invalid/.test(r.subviews.logoImgSrc || '')) {
      console.log('      ✓ 解析到公司图标的标的会渲染官方图标 <img>');
      if (r.subviews.logoFallbackImg === false && /[\u4e00-\u9fa5]{2}/.test(r.subviews.logoFallbackText || '')) {
        console.log('      ✓ 没有图标的标的回退两字中文简称：' + r.subviews.logoFallbackText);
      } else {
        bad('文字头像回退异常: ' + JSON.stringify({
          text: r.subviews.logoFallbackText, img: r.subviews.logoFallbackImg }));
      }
    } else {
      bad('公司图标未渲染: ' + JSON.stringify({
        rendered: r.subviews && r.subviews.logoImgRendered, src: r.subviews && r.subviews.logoImgSrc }));
    }

    /* 持仓卡片内的当日分时（口径已改：收盘后照样画，脏数据不画） */
    if (r.subviews && r.subviews.sparkOffSession > 0) {
      console.log('      ✓ 分时图：收盘后（非交易时段）仍显示 ' + r.subviews.sparkOffSession + ' 条');
      if (r.subviews.sparkAtToday === 0) {
        console.log('      ✓ 当天数据不挂日期角标');
      } else {
        bad('当天分时不该有日期角标：' + r.subviews.sparkAtToday);
      }
      if (r.subviews.sparkPrevDay > 0 && r.subviews.sparkAtStale > 0) {
        console.log('      ✓ 上一交易日照画（' + r.subviews.sparkPrevDay + ' 条）并挂日期角标 ' +
          r.subviews.sparkAtStale + ' 个，周末也能看到上周五走势');
      } else {
        bad('上一交易日分时未按要求展示: ' + JSON.stringify({
          drawn: r.subviews.sparkPrevDay, at: r.subviews.sparkAtStale }));
      }
      if (r.subviews.sparkDirty === 0) {
        console.log('      ✓ 脏数据（批次日期 ≠ 标的日期）不画，避免混批画错日子');
      } else {
        bad('批次内外日期不一致的分时仍被画出：' + r.subviews.sparkDirty + ' 条');
      }
      if (r.subviews.sparkBaseline > 0) console.log('      ✓ 分时图含昨收基准虚线 · 现价 ' + r.subviews.sparkPriceText);
      else bad('分时图缺少昨收基准线');
    } else {
      bad('收盘后持仓卡片内未渲染分时图：' + JSON.stringify(r.subviews && r.subviews.sparkOffSession));
    }

    /* 首页深色卡收起/展开 */
    if (r.subviews && r.subviews.heroToggleExists) {
      if (r.subviews.heroCollapsed && r.subviews.heroMetricsHidden &&
        r.subviews.heroExpandBtnVisible && r.subviews.heroReexpanded && r.subviews.heroMetricsBack) {
        console.log('      ✓ 首页深色卡：收起后仍可见「展开」按钮，可正常展开回去');
      } else {
        bad('首页深色卡收起/展开异常: ' + JSON.stringify({
          collapsed: r.subviews.heroCollapsed, metricsHidden: r.subviews.heroMetricsHidden,
          btnVisible: r.subviews.heroExpandBtnVisible, reexpanded: r.subviews.heroReexpanded,
          metricsBack: r.subviews.heroMetricsBack }));
      }
      if (r.subviews.hfHiddenWhenCollapsed === true && r.subviews.hfBackAfterExpand === true) {
        console.log('      ✓ 测算带随深色卡一起收起 / 展开');
      } else {
        bad('测算带未随深色卡收起: ' + JSON.stringify({
          hidden: r.subviews.hfHiddenWhenCollapsed, back: r.subviews.hfBackAfterExpand }));
      }
    } else {
      bad('首页深色卡找不到展开按钮');
    }

    /* 深色卡「测算带」：编辑 / 联动 / 反解 / 拆分 / 逐年明细 */
    {
      const hf = r.subviews || {};
      if (hf.hfExists && hf.hfNumCount === 5 && hf.hfSheetOpen) {
        console.log('      ✓ 测算带 5 个可点数字：' + hf.hfTexts);
      } else {
        bad('测算带结构异常: ' + JSON.stringify({
          exists: hf.hfExists, nums: hf.hfNumCount, texts: hf.hfTexts, sheet: hf.hfSheetOpen }));
      }
      if (hf.hfInvestAfter === 120000 && hf.hfUpWithInvest === true) {
        console.log('      ✓ 编辑「每年投入」6 万 → 12 万，月均 ' + hf.hfMonthly0 + ' → ' + hf.hfMonthlyAfterInvest);
      } else {
        bad('测算带编辑每年投入异常: ' + JSON.stringify({
          invest: hf.hfInvestAfter, up: hf.hfUpWithInvest, m0: hf.hfMonthly0, m1: hf.hfMonthlyAfterInvest }));
      }
      if (hf.hfUpWithYield === true && hf.hfUpWithYears === true && hf.hfUpWithReinvest === true) {
        console.log('      ✓ 联动方向正确：股息率↑ / 年数↑ / 再投↑ 都让月均变大');
      } else {
        bad('测算带联动方向异常: ' + JSON.stringify({
          yield: hf.hfUpWithYield, years: hf.hfUpWithYears, reinvest: hf.hfUpWithReinvest }));
      }
      if (hf.hfTargetSheet && hf.hfSolveForDefault === 'years' && hf.hfSolvedYears > 1 && hf.hfSolvedReaches === true) {
        console.log('      ✓ 编辑月均 → 反解「年数」= ' + hf.hfSolvedYears + ' 年，届时月均 ' +
          hf.hfSolvedMonthly + ' ≥ 目标 8000');
      } else {
        bad('测算带反解年数异常: ' + JSON.stringify({
          sheet: hf.hfTargetSheet, solveFor: hf.hfSolveForDefault, years: hf.hfSolvedYears,
          monthly: hf.hfSolvedMonthly, reaches: hf.hfSolvedReaches }));
      }
      if (hf.hfSolveForSwitched === 'invest' && hf.hfSolvedInvest > 0 && hf.hfSolvedInvestHits === true) {
        console.log('      ✓ 切换反解目标为「每年投入」：解得 ' +
          (hf.hfSolvedInvest / 10000).toFixed(2) + ' 万，月均命中 ' + hf.hfSolvedInvestMonthly);
      } else {
        bad('测算带反解投入异常: ' + JSON.stringify({
          switched: hf.hfSolveForSwitched, invest: hf.hfSolvedInvest,
          monthly: hf.hfSolvedInvestMonthly, hits: hf.hfSolvedInvestHits }));
      }
      if (hf.hfSplitOk === true) console.log('      ✓ 月均拆分「现有持仓 + 新投入」精确等于总数');
      else bad('月均拆分相加不等于总数');
      if (hf.hfDetailRowsMatch === true && /^¥/.test(String(hf.hfDetailLastDividend || ''))) {
        console.log('      ✓ 逐年明细弹层 ' + hf.hfDetailRows + ' 行（= 年数），末行分红 ' + hf.hfDetailLastDividend);
      } else {
        bad('逐年明细异常: ' + JSON.stringify({
          rows: hf.hfDetailRows, years: hf.hfSolvedYears, last: hf.hfDetailLastDividend }));
      }
    }

    for (const key of ['annual', 'analysis', 'symbol', 'floatMenu']) {
      const sm = (r.subviews || {})[key];
      if (!sm) { bad('新视图 ' + key + ' 未测到'); continue; }
      if (sm.error) { bad('新视图 ' + key + ' 渲染异常: ' + sm.error); continue; }
      const safe = sm.docW <= sm.vw + 1 && sm.overflowCount === 0;
      if (!safe) totalFail++;
      console.log('      ' + (safe ? '✓' : '✗') + ' 新视图 ' + key + '  docW=' + sm.docW + '/vw=' + sm.vw + '  溢出=' + sm.overflowCount);
      if (sm.overflowCount) console.log('          ' + JSON.stringify(sm.overflow.slice(0, 2)));
    }
    if (r.subviews && r.subviews.floatManualOpened) console.log('      ✓ 悬浮「手动添加」可打开表单');
    else bad('悬浮「手动添加」未打开表单');

    if (r.interactions) {
      if (r.interactions.error) bad('交互冒烟失败: ' + r.interactions.error);
      else console.log('      ✓ 交互冒烟  翻月→' + r.interactions.calAfterNext +
        '  选中日→' + (r.interactions.selDate || '—') +
        '  排序→' + r.interactions.sortMode +
        '  账户→' + r.interactions.accountId +
        '  持仓行 ' + r.interactions.holdingRows + ' / 全部 ' + r.interactions.holdingRowsAll);
    }

    if (r.afterAddTx && r.afterAddTx.hasForm) {
      console.log('      ✓ 个股档案 →「记一笔交易」跳转正常（' + r.afterAddTx.sheetTitle + '）');
    } else {
      bad('个股档案「记一笔交易」未能打开表单: afterAddTx=' + JSON.stringify(r.afterAddTx) +
        ' sheets=' + JSON.stringify(r.sheets) + ' errors=' + JSON.stringify(r.errors || []));
    }

    if (r.errors && r.errors.length) bad('页面运行时错误: ' + JSON.stringify(r.errors.slice(0, 3)));
    if (r.sheets && r.sheets.addTxForError) bad('个股档案「记一笔交易」失败');

    if (w === 375) {
      for (const tab of ['overview', 'calendar', 'annual', 'symbol', 'addForm', 'ocr', 'find', 'analysis', 'mine']) await shot('m375_' + tab, tab, w, h);
    } else if (w === 1280) {
      for (const tab of ['overview', 'annual', 'symbol', 'analysis', 'addForm']) await shot('desktop_' + tab, tab, w, h);
    }
  }

  /* ---------------- 附加：派息日弹窗（今日分红到账） ----------------
     种子里没有任何「今天就是派息日」的方案，所以这里临时造一条，
     并把「今天已弹过」的标记清空，再重新加载 —— 弹窗本来就是在 boot 时判断的。 */
  console.log('\n[附加] 派息日弹窗：当天有派息 → 弹一次；关掉后当天不再弹');
  try {
    const injectTodayPayout = () => browser.send('Runtime.evaluate', {
      expression: '(function(){' +
        'var t = XJ.util.today();' +
        'XJ.store.state.plans["probe_today"] = {planId:"probe_today",symbol:"sh600023",' +
        'reportDate:"2025-12-31",reportType:"年报",pretaxBonusPer10:5,' +
        'planNoticeDate:null,noticeDate:null,equityRecordDate:t,exDividendDate:t,isImplemented:true};' +
        'XJ.store.state.settings.payoutPopupAt = null;' +
        'XJ.storage.save(XJ.store.state);' +
        'return t;})()',
      returnByValue: true,
    }, sessionId);

    const readyAndWait = async (extraMs) => {
      await browser.send('Page.navigate', { url }, sessionId);
      for (let i = 0; i < 90; i++) {
        await sleep(120);
        try {
          const r = await browser.send('Runtime.evaluate', {
            expression: '!!(window.XJ && XJ.store && XJ.store.state)', returnByValue: true,
          }, sessionId);
          if (r.result && r.result.value) break;
        } catch (e) { /* 还在加载 */ }
      }
      await sleep(extraMs || 900);      // 弹窗挂在 boot 后 600ms 那次判断上
    };
    const evalIn = async (expr) => {
      const r = await browser.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
      return r.result && r.result.value;
    };
    const waitFor = async (expr, tries) => {
      for (let i = 0; i < (tries || 50); i++) {
        const v = await evalIn(expr).catch(() => null);
        if (v) return v;
        await sleep(140);
      }
      return null;
    };

    await browser.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true }, sessionId);
    await injectTodayPayout();
    await sleep(900);        // ★ 存储是异步的，不等它写完就 navigate 会读到旧标记

    /* ① 出现 + 内容 */
    await readyAndWait(1200);
    const card = await waitFor("(function(){var c=document.querySelector('.pp-card');if(!c)return null;" +
      "return {title:(c.querySelector('.pp-title')||{}).textContent||''," +
      "total:(c.querySelector('.pp-total')||{}).textContent||''," +
      "rows:document.querySelectorAll('.pp-row').length," +
      "rowName:((document.querySelector('.pp-row .pp-nm')||{}).textContent)||''," +
      "btn:((c.querySelector('.pp-main')||{}).textContent)||''," +
      "ghost:((c.querySelector('.pp-ghost')||{}).textContent)||''," +
      "note:!!c.querySelector('.pp-note')};})()");
    if (!card) bad('派息日弹窗没有出现');
    else {
      /* ★ 不写死笔数与金额：种子数据里有几笔派息是随日期变的（某些方案的日子会正好落在今天），
         所以拿 calc.payoutsOn 的输出来对齐 —— 这条用例要验的是「界面把 calc 的结果如实渲染出来」。 */
      const expPop = await evalIn('(function(){var p=XJ.calc.payoutsOn(XJ.store.state,XJ.calc.ALL,XJ.util.today());' +
        'return {rows:p.items.length, total:XJ.util.signMoney(p.total)};})()');
      const okCard = card.title === '今日分红到账' && /^\+¥/.test(card.total) &&
        card.rows === expPop.rows && card.btn === '查看分红记录' && card.ghost === '我知道了';      if (okCard) {
        console.log('      ✓ 弹窗内容：' + card.title + ' · ' + card.total + ' · ' +
          card.rows + ' 行明细（' + card.rowName + '）· 主按钮「' + card.btn + '」');
      } else {
        bad('弹窗内容不对: ' + JSON.stringify({ card: card, exp: expPop }));
      }
      if (card.total === expPop.total && expPop.rows >= 1) {
        console.log('      ✓ 金额与 calc.payoutsOn 一致：' + card.total + '（' + expPop.rows + ' 笔）');
      } else {
        bad('弹窗金额不对: 显示 ' + card.total + ' / calc 算出 ' + expPop.total);
      }
      /* ★ A 股派息日是推算值 → 必须带口径小字（不加会让人以为钱已到账） */
      if (card.note === true) console.log('      ✓ 带「派息日为推算值」的口径小字（estimated=true 时才出现）');
      else bad('弹窗缺少口径小字');
    }

    /* ② 点「我知道了」→ 关闭，且「今天已弹过」的标记已落盘 */
    await evalIn("(function(){var b=document.querySelector('.pp-ghost');if(b)b.click();return 1;})()");
    await sleep(260);
    const afterClose = await evalIn("(function(){return {gone:!document.querySelector('.pp-card')," +
      "flag:(XJ.store.state.settings.payoutPopupAt||'')};})()");
    if (afterClose && afterClose.gone && afterClose.flag) {
      console.log('      ✓ 点「我知道了」后弹窗关闭，「今天已弹过」标记 = ' + afterClose.flag);
    } else {
      bad('关闭弹窗或写标记失败: ' + JSON.stringify(afterClose));
    }

    /* ③ 当天再打开 → 不该再弹 */
    await readyAndWait(1600);
    const second = await evalIn("(function(){return {shown:!!document.querySelector('.pp-card')," +
      "flag:(XJ.store.state.settings.payoutPopupAt||'')};})()");
    if (second && second.shown === false) {
      console.log('      ✓ ★ 同一天再次打开不再弹（settings.payoutPopupAt = ' + second.flag + '）');
    } else {
      bad('同一天重复弹了: ' + JSON.stringify(second));
    }

    /* ④ 主按钮 → 跳分红汇总页（存储是异步的，注入后多等一会儿再跳；不行就再试一次） */
    let shownAgain = null;
    for (let attempt = 0; attempt < 2 && !shownAgain; attempt++) {
      await injectTodayPayout();
      await sleep(1100);
      await readyAndWait(1300);
      shownAgain = await waitFor("!!document.querySelector('.pp-main')");
    }
    if (!shownAgain) bad('第二次注入后弹窗未出现（后续按钮用例无法进行）');
    else {
      await evalIn("(function(){var b=document.querySelector('.pp-main');if(b)b.click();return 1;})()");
      await sleep(320);
      const nav = await evalIn("(function(){return {page:XJ.store.ui.subPage," +
        "popupGone:!document.querySelector('.pp-card')," +
        "title:((document.querySelector('.topbar-row h1')||{}).textContent)||''," +
        "hero:!!document.querySelector('.ds-hero')};})()");
      if (nav && nav.page === 'divsummary' && nav.popupGone && nav.hero) {
        console.log('      ✓ 点「查看分红记录」→ 关闭弹窗并进入「' + nav.title + '」页');
      } else {
        bad('弹窗主按钮未跳到分红汇总页: ' + JSON.stringify(nav));
      }
    }

    /* 收尾：撤掉临时方案，并把标记写成今天，免得影响后面的降级用例 */
    await evalIn('(function(){delete XJ.store.state.plans["probe_today"];' +
      'XJ.store.state.settings.payoutPopupAt = XJ.util.today();' +
      'XJ.storage.save(XJ.store.state);return 1;})()');
    await sleep(200);
  } catch (e) {
    bad('派息日弹窗用例异常: ' + e.message);
  }

  /* ---------------- 附加：IndexedDB 被禁用时的降级路径 ---------------- */
  console.log('\n[附加] IndexedDB 被禁用 → 应自动降级到 localStorage');
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{Object.defineProperty(window,'indexedDB',{configurable:true,value:{open:function(){throw new Error('SecurityError: blocked');}}});}catch(e){}`,
  }, sessionId);
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true }, sessionId);
  await browser.send('Page.navigate', { url }, sessionId);
  let ready2 = false;
  for (let i = 0; i < 120; i++) {
    await sleep(120);
    try {
      const rr = await browser.send('Runtime.evaluate', {
        expression: '!!(window.XJ && XJ.store && XJ.store.state)', returnByValue: true,
      }, sessionId);
      if (rr.result && rr.result.value) { ready2 = true; break; }
    } catch (e) { /* retry */ }
  }
  if (!ready2) bad('降级模式下应用未能启动');
  else {
    await sleep(400);
    const rr = await browser.send('Runtime.evaluate', { expression: PROBE, returnByValue: true, awaitPromise: true }, sessionId);
    const v = rr.result && rr.result.value;
    if (!v) bad('降级模式探针无返回');
    else {
      const okMode = v.storageMode === 'ls' || v.storageMode === 'none';
      if (!okMode) bad('未降级，storageMode=' + v.storageMode);
      else console.log('      ✓ 存储方式 = ' + v.storageMode + '（已绕开被禁用的 IndexedDB）');
      for (const tab of ['overview', 'calendar', 'find', 'mine']) {
        const tm = v.tabs[tab];
        const safe = tm && tm.docW <= tm.vw + 1 && tm.overflowCount === 0;
        if (!safe) bad('降级模式 Tab ' + tab + ' 溢出或缺失');
      }
      if (v.numbers) console.log('      ✓ 降级模式下数据可读：持仓 ' + v.numbers.holdings + ' 只 / 分红 ¥' + v.numbers.predicted);
      /* 往返一次：保存 → 重新加载 → 数据仍在 */
      await browser.send('Runtime.evaluate', { expression: 'XJ.storage.save(XJ.store.state)' }, sessionId);
      await sleep(300);
      await browser.send('Runtime.evaluate', {
        expression: 'XJ.store.init(window.__probeRoundTrip = XJ.model.fromImport(JSON.parse(localStorage.getItem("xiji_state_v1"))))',
      }, sessionId).catch(() => {});
      const rt = await browser.send('Runtime.evaluate', {
        expression: '(function(){try{var raw=localStorage.getItem("xiji_state_v1");if(!raw)return null;var o=JSON.parse(raw);return {tx:o.transactions.length,acc:o.accounts.length};}catch(e){return {err:String(e.message)};}})()',
        returnByValue: true,
      }, sessionId);
      const v2 = rt.result && rt.result.value;
      if (v2 && v2.tx > 0) console.log('      ✓ 降级模式往返：localStorage 中已有 ' + v2.tx + ' 笔交易 / ' + v2.acc + ' 个账户');
      else bad('降级模式往返失败: ' + JSON.stringify(v2));
    }
  }
} catch (e) {
  console.error('\n测试执行失败: ' + e.message);
  totalFail++;
} finally {
  try { if (sessionId) await browser.send('Target.closeTarget', { targetId }); } catch (e) {}
  try { browser && browser.close(); } catch (e) {}
  chrome.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}

console.log('\n' + '='.repeat(60));
if (totalFail === 0) {
  console.log('UI 验收全部通过 ✅  （' + VIEWPORTS.length + ' 个视口 × 4 个 Tab + 2 个弹层 + 交互冒烟）');
} else {
  console.log('UI 验收存在问题：' + totalFail + ' 处');
}
console.log('='.repeat(60));
process.exitCode = totalFail ? 1 : 0;
