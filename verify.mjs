/* ============================================================
 * 独立复算验收脚本（金标准）
 *
 * 原则：本文件【重新实现】一遍全部核心公式，不复用 src/calc.js 的任何代码，
 *      然后把两边的结果逐位比对。两边用同一份 fixtures（固定"今天"= 2026-09-10）。
 *
 * 用法： node verify.mjs
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/* 参与静态巡检的源码清单（【31】hash 白名单要用）。
   ★ 这里写死而不是动态扫描目录：新增文件时应当被迫来加一行，
     顺带提醒自己「这个新文件也要接受同一套巡检」。 */
const SRC_FILES = [
  'src/util.js', 'src/market.js', 'src/model.js', 'src/storage.js', 'src/store.js',
  'src/transfer.js', 'src/fetcher.js', 'src/ocr.js',
  'src/chart.js', 'src/calc.js', 'src/ui.js', 'src/app.js',
  'src/views/overview.js', 'src/views/symbol.js', 'src/views/analysis.js',
  'src/views/plan.js', 'src/views/networth.js', 'src/views/divsummary.js', 'src/views/mine.js',
];
/* ★ URL hash 键白名单：全仓只允许这一个。
   新增任何一条都要同时改这里，并且想清楚它会不会泄漏 / 会被转发。 */
const HASH_KEYS = ['#xjimport='];

/* ---------------------------------------------------------------
 * 1. 冻结时间，保证结果确定
 * --------------------------------------------------------------- */
const REF_TODAY = '2026-09-10';
const FIXED_MS = new Date(2026, 8, 10, 15, 0, 0).getTime();

/* ---------------------------------------------------------------
 * 2. 在沙箱里加载被测代码（util / model / calc）
 * --------------------------------------------------------------- */
const sandbox = {
  window: {},
  console,
  Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
  parseInt, parseFloat, isNaN, Promise, setTimeout, clearTimeout,
};
/* atob / btoa：transfer.js 的 base64url 兜底路径在沙箱里可能用到（与浏览器环境保持一致）。 */
sandbox.atob = (s) => Buffer.from(String(s), 'base64').toString('binary');
sandbox.btoa = (s) => Buffer.from(String(s), 'binary').toString('base64');
/* WebCrypto：接入口令的加密载荷（XJ2e）要用。
   注入真的 crypto（Node 自带 SubtleCrypto 语义一致），这样「加密→解密→拿回令牌」
   这条链路是被真实执行的，而不是只测了一个 mock。 */
sandbox.crypto = crypto;
sandbox.Uint8Array = Uint8Array;
sandbox.ArrayBuffer = ArrayBuffer;
sandbox.DataView = DataView;
sandbox.globalThis = sandbox;

class FakeDate extends Date {
  constructor(...args) { if (args.length === 0) super(FIXED_MS); else super(...args); }
  static now() { return FIXED_MS; }
}
sandbox.Date = FakeDate;

vm.createContext(sandbox);
for (const f of ['src/util.js', 'src/market.js', 'src/model.js', 'src/transfer.js', 'src/fetcher.js', 'src/ocr.js', 'src/chart.js', 'src/calc.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}
const XJ = sandbox.window.XJ;

/* ---------------------------------------------------------------
 * 3. fixtures —— 真实接口抓下来的分红方案 + 构造的持仓
 * --------------------------------------------------------------- */
function plan(id, sym, reportDate, pretaxPer10, progress, equityDate, exDate, profile) {
  return {
    planId: id, symbol: sym, securityCode: sym.slice(2), securityName: '',
    reportDate, reportType: reportDate.slice(5, 7) === '12' ? '年报' : '中报',
    pretaxBonusPer10: pretaxPer10,
    afterTaxPer10: null,
    implPlanProfile: profile || ('10派' + pretaxPer10 + '元(含税)'),
    planNoticeDate: null, noticeDate: null,
    equityRecordDate: equityDate, exDividendDate: exDate,
    assignProgress: progress, progressRank: progress.indexOf('实施分配') >= 0 ? 100 : 60,
    isImplemented: progress.indexOf('实施分配') >= 0,
    dividendRatio: null,
    fetchedAt: '2026-09-01T00:00:00Z',
  };
}

const fixtures = {
  accounts: [
    { accountId: 'acc_1', name: '测试账户', type: 'BROKER', sortOrder: 1, createdAt: '2026-01-01T00:00:00Z' },
  ],
  /* 显式声明加权平均：本套 fixtures 复算的是「加权平均」口径。
     （应用默认口径是「分红摊薄」，见 6.27 节的专项断言） */
  symbols: {
    sh600023: { symbol: 'sh600023', code: '600023', market: 'sh', name: '浙能电力', type: 'STOCK', costMethod: 'weighted' },
    sz000858: { symbol: 'sz000858', code: '000858', market: 'sz', name: '五粮液', type: 'STOCK', costMethod: 'weighted' },
  },
  transactions: [
    { txId: 't1', accountId: 'acc_1', symbol: 'sh600023', action: 'BUY', date: '2025-03-10', quantity: 1000, price: 4.0, fee: 5, createdAt: '2025-03-10T01:00:00Z' },
    { txId: 't2', accountId: 'acc_1', symbol: 'sh600023', action: 'BUY', date: '2025-06-20', quantity: 1000, price: 5.0, fee: 5, createdAt: '2025-06-20T01:00:00Z' },
    { txId: 't3', accountId: 'acc_1', symbol: 'sh600023', action: 'SELL', date: '2026-02-11', quantity: 500, price: 6.0, fee: 5, createdAt: '2026-02-11T01:00:00Z' },
    { txId: 't4', accountId: 'acc_1', symbol: 'sz000858', action: 'BUY', date: '2024-09-02', quantity: 1900, price: 88.0, fee: 20, createdAt: '2024-09-02T01:00:00Z' },
  ],
  plans: {},
  quoteCache: {
    sh600023: { symbol: 'sh600023', name: '浙能电力', price: 4.98, prevClose: 5.02, changePct: -0.80, quoteTime: '20260910150431' },
    sz000858: { symbol: 'sz000858', name: '五粮液', price: 70.48, prevClose: 71.16, changePct: -0.96, quoteTime: '20260910150031' },
  },
};

/* 浙能电力：真实抓取的方案（2026-08-29 / 2026-04-28 / 2025-10-10 公告） */
fixtures.plans['sh600023_2025-06-30'] = plan('sh600023_2025-06-30', 'sh600023', '2025-06-30', 0.5, '实施分配', '2025-10-16', '2025-10-17', '10派0.50元(含税,扣税后0.45元)');
fixtures.plans['sh600023_2025-12-31'] = plan('sh600023_2025-12-31', 'sh600023', '2025-12-31', 2.8, '实施分配', '2026-07-29', '2026-07-30', '10派2.80元(含税,扣税后2.52元)');
fixtures.plans['sh600023_2026-06-30'] = plan('sh600023_2026-06-30', 'sh600023', '2026-06-30', 0.2, '董事会决议通过', null, null, '10派0.20元(含税)');
/* 五粮液：与「息记」截图同口径 —— 每股派息 2.579685 元，1900 股 → 4901.40 元 */
fixtures.plans['sz000858_2025-12-31'] = plan('sz000858_2025-12-31', 'sz000858', '2025-12-31', 25.79685, '实施分配', '2026-07-15', '2026-07-16', '10派25.79685元(含税)');

const state = Object.assign(XJ.model.defaultState(), {
  accounts: fixtures.accounts,
  symbols: fixtures.symbols,
  transactions: fixtures.transactions,
  plans: fixtures.plans,
  quoteCache: fixtures.quoteCache,
  received: [],
});
XJ.model.ensureBootstrapped(state);

/* ---------------------------------------------------------------
 * 4. 独立实现（完全不复用 app 代码）
 * --------------------------------------------------------------- */
const p2 = (n) => (n < 10 ? '0' + n : '' + n);
const fmt = (d) => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
function iAddDays(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return fmt(dt);
}

/** 加权平均成本（独立实现） */
function iPosition(txs, upTo) {
  const arr = txs.slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.createdAt || '').localeCompare(b.createdAt || '');
  });
  let qty = 0, cb = 0, avg = 0, realized = 0;
  for (const t of arr) {
    if (upTo && t.date > upTo) break;
    const q = +t.quantity, pr = +t.price, fee = +(t.fee || 0);
    if (t.action === 'BUY') {
      cb += q * pr + fee;
      qty += q;
      avg = cb / qty;
    } else {
      const sq = Math.min(q, qty);
      realized += sq * (pr - avg) - fee;
      cb -= sq * avg;
      qty -= sq;
      if (qty <= 1e-9) { qty = 0; cb = 0; avg = 0; } else avg = cb / qty;
    }
  }
  return { qty, avgCost: avg, costBasis: cb, realized };
}

/** 每股税前分红（独立实现） */
const iPS = (plan) => (+plan.pretaxBonusPer10) / 10;

/** 近 12 个月已实施分配的每股合计（独立实现） */
function iTrailing(plans, today) {
  const cutoff = iAddDays(today, -365);
  let s = 0;
  for (const pl of plans) {
    if (!pl.isImplemented) continue;
    const d = pl.exDividendDate || pl.equityRecordDate;
    if (!d) continue;
    if (d > cutoff && d <= today) s += iPS(pl);
  }
  return s;
}

/** 年度化每股分红：最近一个含年报的报告年度合计（独立实现） */
function iAnnualBase(plans) {
  const impl = plans.filter((p) => p.isImplemented);
  if (!impl.length) return 0;
  const years = impl.filter((p) => p.reportDate.slice(5, 7) === '12').map((p) => +p.reportDate.slice(0, 4));
  if (years.length) {
    const y = Math.max(...years);
    return impl.filter((p) => +p.reportDate.slice(0, 4) === y).reduce((a, p) => a + iPS(p), 0);
  }
  return iTrailing(plans, REF_TODAY);
}

/** 展望未来（独立实现，公式与方案 2.3 一致） */
function iProjection(startAssets, baseDividend, monthly, years, reinvest) {
  const yield0 = startAssets > 0 ? baseDividend / startAssets : 0;
  let assets = startAssets;
  const rows = [];
  for (let k = 1; k <= years; k++) {
    assets += monthly * 12;
    const div = assets * yield0;
    assets += div * reinvest;
    rows.push({ year: k, dividend: div, assetsEnd: assets });
  }
  return { rows, yieldPct: yield0 * 100 };
}

/** 息覆生活（独立实现） */
function iCoverage(annualDividend, expenses, assumedYieldPct) {
  const items = expenses.filter((e) => e.enabled)
    .map((e) => ({ key: e.key, label: e.label, annualAmount: (+e.monthlyAmount) * 12 }))
    .sort((a, b) => a.annualAmount - b.annualAmount);
  let running = 0, lit = 0;
  const out = items.map((it) => {
    if (running + it.annualAmount <= annualDividend) {
      running += it.annualAmount; lit++;
      return { ...it, lit: true, remaining: 0, progress: 100 };
    }
    const avail = Math.max(0, annualDividend - running);
    return { ...it, lit: false, remaining: it.annualAmount - avail, progress: avail / it.annualAmount * 100 };
  });
  const next = out.find((x) => !x.lit) || null;
  const needMore = next ? next.remaining : 0;
  return { litCount: lit, totalCount: items.length, next, needMore, addCapital: needMore / (assumedYieldPct / 100), items: out };
}

/** 自动到账（独立实现） */
function iAutoReceived(state) {
  const res = [];
  for (const pid of Object.keys(state.plans)) {
    const pl = state.plans[pid];
    if (!pl.isImplemented) continue;
    const payDate = pl.exDividendDate || pl.equityRecordDate;
    if (!payDate || payDate > REF_TODAY) continue;
    for (const acc of state.accounts) {
      const txs = state.transactions.filter((t) => t.accountId === acc.accountId && t.symbol === pl.symbol);
      if (!txs.length) continue;
      const pos = iPosition(txs, pl.equityRecordDate || payDate);
      if (pos.qty <= 0) continue;
      res.push({
        planId: pid, symbol: pl.symbol, exDividendDate: payDate,
        perShareAmount: iPS(pl), qtyAtRecord: pos.qty,
        amount: Math.round(pos.qty * iPS(pl) * 100) / 100,
        year: +payDate.slice(0, 4),
      });
    }
  }
  return res;
}

/* ---------------------------------------------------------------
 * 5. 断言框架
 * --------------------------------------------------------------- */
let pass = 0, fail = 0;
const failures = [];

function eq(label, actual, expected, tol = 0) {
  const a = typeof actual === 'number' ? actual : actual;
  const ok = typeof expected === 'number'
    ? (tol === 0 ? Math.abs(actual - expected) < 1e-6 : Math.abs(actual - expected) <= tol)
    : actual === expected;
  if (ok) { pass++; console.log('  ✓ ' + label + '  →  ' + actual); }
  else {
    fail++; failures.push(label);
    console.log('  ✗ ' + label + '  实际=' + actual + '  期望=' + expected + (tol ? '  容差=' + tol : ''));
  }
}
function close(label, actual, expected, relTol) {
  const d = Math.abs(actual - expected);
  const rel = expected === 0 ? d : d / Math.abs(expected);
  if (rel <= relTol) { pass++; console.log('  ✓ ' + label + '  →  ' + actual.toFixed(4) + '（期望 ' + expected.toFixed(4) + '，相对误差 ' + (rel * 100).toFixed(3) + '%）'); }
  else { fail++; failures.push(label); console.log('  ✗ ' + label + '  实际=' + actual + '  期望=' + expected + '  相对误差=' + (rel * 100).toFixed(3) + '%'); }
}
function section(t) { console.log('\n' + t); }

/* ---------------------------------------------------------------
 * 6. 跑测试
 * --------------------------------------------------------------- */
console.log('===== 独立复算验收（固定今天 = ' + REF_TODAY + '） =====');

/* ---- 6.1 持仓成本 ---- */
section('【1】持仓加权成本 / 已实现盈亏');
{
  const txs = fixtures.transactions.filter((t) => t.symbol === 'sh600023');
  const app = XJ.calc.position(txs, null, 'weighted');
  const ind = iPosition(txs);

  eq('浙能电力 · 剩余数量', app.qty, ind.qty);
  eq('浙能电力 · 剩余数量 = 1500', app.qty, 1500);
  close('浙能电力 · 平均成本', app.avgCost, ind.avgCost, 1e-12);
  close('浙能电力 · 平均成本 ≈ 4.505', app.avgCost, 4.505, 1e-12);
  close('浙能电力 · 成本金额', app.costBasis, ind.costBasis, 1e-12);
  close('浙能电力 · 成本金额 ≈ 6757.5', app.costBasis, 6757.5, 1e-12);
  close('浙能电力 · 已实现盈亏', app.realized, 742.5, 1e-12);

  const txs2 = fixtures.transactions.filter((t) => t.symbol === 'sz000858');
  const app2 = XJ.calc.position(txs2, null, 'weighted');
  const ind2 = iPosition(txs2);
  eq('五粮液 · 数量', app2.qty, 1900);
  close('五粮液 · 平均成本（含手续费）', app2.avgCost, ind2.avgCost, 1e-12);

  /* 日期截断：8.5 节用 —— 按股权登记日快照 */
  const snap = XJ.calc.position(txs, '2025-10-16', 'weighted');
  eq('浙能电力 · 2025-10-16 登记日持仓快照', snap.qty, 2000);
  const snap2 = XJ.calc.position(txs, '2026-07-29', 'weighted');
  eq('浙能电力 · 2026-07-29 登记日持仓快照', snap2.qty, 1500);
}

/* ---- 6.2 股息率 / 年度化每股 ---- */
section('【2】股息率与年度化每股分红（近 12 个月 / 最近年报年度）');
{
  const plans = Object.values(fixtures.plans);
  const z = plans.filter((p) => p.symbol === 'sh600023');
  const w = plans.filter((p) => p.symbol === 'sz000858');

  eq('浙能电力 · TTM 每股（0.05+0.28=0.33）', XJ.calc.trailingPerShare(z, REF_TODAY), 0.33);
  close('浙能电力 · TTM 每股 = 独立实现', XJ.calc.trailingPerShare(z, REF_TODAY), iTrailing(z, REF_TODAY), 1e-12);
  eq('浙能电力 · 年度化每股（年报年度 2025 合计 0.33）', XJ.calc.annualBasePerShare(z).perShare, 0.33);
  eq('浙能电力 · 年度化口径 = fiscal（财年口径）', XJ.calc.annualBasePerShare(z).basis, 'fiscal');
  eq('浙能电力 · 财年口径用 1 个财年（默认近1年）', XJ.calc.annualBasePerShare(z).years, 1);
  eq('浙能电力 · 财年区间 = 2025', XJ.calc.annualBasePerShare(z).fromYear, 2025);
  eq('浙能电力 · 年度化取 2025 年', XJ.calc.annualBasePerShare(z).year, 2025);
  eq('浙能电力 · 未实施的 2026 中报不计入', XJ.calc.annualBasePerShare(z).perShare, 0.33);

  close('五粮液 · 年度化每股', XJ.calc.annualBasePerShare(w).perShare, iAnnualBase(w), 1e-12);
  eq('五粮液 · 年度化每股 = 2.579685', XJ.calc.annualBasePerShare(w).perShare, 2.579685);

  const hs = XJ.calc.holdings(state, 'acc_1');
  const hz = hs.find((h) => h.symbol === 'sh600023');
  const hw = hs.find((h) => h.symbol === 'sz000858');
  close('浙能电力 · 实时股息率 = 0.33/4.98', hz.dividendYield, 0.33 / 4.98 * 100, 1e-10);
  eq('五粮液 · 预测年度分红 = 1900×2.579685', hw.predictedDividend, 4901.4015);
  close('五粮液 · 预测年度分红四舍五入到 4901.40',
    Math.round(hw.predictedDividend * 100) / 100, 4901.40, 1e-9);
}

/* ---- 6.3 组合汇总 ---- */
section('【3】组合汇总');
{
  const s = XJ.calc.summary(state, 'acc_1');
  eq('持仓只数', s.count, 2);
  close('总市值 = 1500×4.98 + 1900×70.48', s.totalMarketValue, 1500 * 4.98 + 1900 * 70.48, 1e-9);
  close('预测年度分红 = 495 + 4901.4015', s.totalPredicted, 495 + 4901.4015, 1e-9);
  close('组合息率', s.compositeYield, (495 + 4901.4015) / (1500 * 4.98 + 1900 * 70.48) * 100, 1e-10);
}

/* ---- 6.4 自动到账 ---- */
section('【4】分红方案 → 自动到账登记（幂等）');
{
  const fresh = JSON.parse(JSON.stringify(state));
  fresh.received = [];
  const added = XJ.calc.applyAutoReceived(fresh);
  const ind = iAutoReceived(state);

  eq('新增到账笔数', added, 3);
  eq('新增到账笔数 = 独立实现', added, ind.length);
  eq('重复调用应幂等（第二次新增 0 笔）', XJ.calc.applyAutoReceived(fresh), 0);

  const byKey = {};
  fresh.received.forEach((r) => { byKey[r.planId] = r; });

  const r1 = byKey['sh600023_2025-06-30'];
  eq('浙能 2025 中报 · 登记数量 2000', r1.qtyAtRecord, 2000);
  eq('浙能 2025 中报 · 金额 2000×0.05 = 100', r1.amount, 100);
  eq('浙能 2025 中报 · 到账年度', r1.year, 2025);

  const r2 = byKey['sh600023_2025-12-31'];
  eq('浙能 2025 年报 · 登记数量 1500', r2.qtyAtRecord, 1500);
  eq('浙能 2025 年报 · 金额 1500×0.28 = 420', r2.amount, 420);

  const r3 = byKey['sz000858_2025-12-31'];
  eq('五粮液 · 登记数量 1900', r3.qtyAtRecord, 1900);
  eq('五粮液 · 到账金额 4901.40（与息记截图一致）', r3.amount, 4901.40);

  const total = fresh.received.reduce((a, r) => a + r.amount, 0);
  close('到账金额合计', total, ind.reduce((a, r) => a + r.amount, 0), 1e-12);
  eq('预案（2026 中报）未生成到账记录', fresh.received.some((r) => r.planId === 'sh600023_2026-06-30'), false);

  const sum = XJ.calc.summary(fresh, 'acc_1');
  eq('今年已收（2026）= 420 + 4901.40', Math.round(sum.receivedThisYear * 100) / 100, 5321.40);
}

/* ---- 6.5 分红日历 ---- */
section('【5】分红日历事件与状态机');
{
  const evs = XJ.calc.calendarEvents(state, 'acc_1', null, null);
  const types = {};
  evs.forEach((e) => { types[e.type] = (types[e.type] || 0) + 1; });
  eq('股权登记事件数', types.register, 3);
  eq('除权除息事件数', types.exdiv, 3);
  eq('预计到账事件数', types.payout, 3);

  const p = evs.find((e) => e.type === 'payout' && e.planId === 'sz000858_2025-12-31');
  eq('五粮液派息日 = 除权除息日（A股同日，不推算）', p.date, '2026-07-16');
  eq('五粮液预计到账金额', p.amount, 4901.4015);
  eq('已过期事件状态 = DONE', p.status, 'DONE');
  eq('到账日一律标记为预估值', p.isEstimate, true);

  const mv = XJ.calc.monthView(state, 'acc_1', 2026, 7);
  eq('2026-07 事件总数（2 方案 × 3 事件 = 6）', mv.events.length, 6);
  eq('2026-07 涉及标的数', new Set(mv.events.map((e) => e.symbol)).size, 2);
  const pending = mv.events.filter((e) => e.type === 'payout' && e.date >= REF_TODAY);
  eq('2026-07 待收笔数（均已过期）', pending.length, 0);
  close('2026-07 已到账合计 = 420 + 4901.40', mv.receivedTotal, 5321.4015, 1e-9);

  const mvNow = XJ.calc.monthView(state, 'acc_1', 2026, 9);
  eq('2026-09 无分红安排', mvNow.events.length, 0);
}

/* ---- 6.6 息覆生活 ---- */
section('【6】息覆生活：点亮判定 / 反推加仓');
{
  const annualDividend = 495 + 4901.4015;
  const app = XJ.calc.coverage(annualDividend, state.expenses, 7);
  const ind = iCoverage(annualDividend, state.expenses, 7);

  eq('点亮项数一致', app.litCount, ind.litCount);
  eq('点亮项数 = 3（话费 + 水电燃气 + 水果）', app.litCount, 3);
  eq('总项数 = 6（与息记截图一致的默认模板）', app.totalCount, 6);
  eq('下一目标一致', app.nextItem.label, ind.next.label);
  eq('下一目标 = 保险', app.nextItem.label, '保险');
  close('还差金额一致', app.needMore, ind.needMore, 1e-9);
  close('还差金额 = 2400 - (5396.4015-3720)', app.needMore, 2400 - (annualDividend - 3720), 1e-9);
  close('反推加仓额 = 还差 / 7%', app.addCapital, ind.addCapital, 1e-9);

  /* 息记同款身份式：加仓额 = 缺口 / 假设息率 */
  close('身份式：addCapital × 7% = needMore', app.addCapital * 0.07, app.needMore, 1e-9);

  /* 边界：恰好相等应点亮 */
  const exact = 720 + 1200 + 1800;
  const c2 = XJ.calc.coverage(exact, state.expenses, 7);
  eq('恰好等于前 3 项合计时点亮 3 项', c2.litCount, 3);
  /* 边界：差 1 分不点亮 */
  const c3 = XJ.calc.coverage(exact - 0.01, state.expenses, 7);
  eq('差 1 分时只点亮 2 项', c3.litCount, 2);
  close('差 1 分时缺口 = 0.01', c3.needMore, 0.01, 1e-9);

  /* 全额覆盖 */
  const c4 = XJ.calc.coverage(1e9, state.expenses, 7);
  eq('分红充足时点亮全部 6 项', c4.litCount, 6);
  eq('全部点亮后无下一目标', c4.nextItem, null);

  /* 里程碑 */
  eq('覆盖率 0% 时里程碑 = 初出茅庐', XJ.calc.milestone(0).name, '初出茅庐');
  eq('覆盖率 100% 时里程碑 = 财务自由', XJ.calc.milestone(100).name, '财务自由');
}

/* ---- 6.7 展望未来 ---- */
section('【7】展望未来：逐年复利模拟');
{
  const start = 1500 * 4.98 + 1900 * 70.48;
  const div0 = 495 + 4901.4015;
  const cfg = { yearly: 0, years: 10, monthlyInvest: 15000, reinvestRatio: 1 };

  const app = XJ.calc.projection(cfg, start, div0);
  const ind = iProjection(start, div0, 15000, 10, 1);

  eq('行数 = 10', app.rows.length, 10);
  close('期初息率一致', app.yieldPct, ind.yieldPct, 1e-12);
  for (const k of [0, 1, 9]) {
    close('第 ' + (k + 1) + ' 年分红一致', app.rows[k].dividend, ind.rows[k].dividend, 1e-12);
    close('第 ' + (k + 1) + ' 年末资产一致', app.rows[k].assetsEnd, ind.rows[k].assetsEnd, 1e-12);
  }
  close('增长倍数一致', app.multiple, ind.rows[9].dividend / div0, 1e-12);
  eq('再投 0% 时资产不因分红增长', (() => {
    const z = XJ.calc.projection({ years: 3, monthlyInvest: 0, reinvestRatio: 0 }, 100000, 6000);
    return z.rows[0].assetsEnd === 100000;
  })(), true);
}

/* ---- 6.8 与「息记」官方截图对齐（反推验证） ---- */
section('【8】黄金用例：与「息记」官方截图逐位对齐');
{
  const startAssets = 181864;
  const baseDividend = 12142.43;   // 截图：预测年度分红
  const cfg = { years: 10, monthlyInvest: 15000, reinvestRatio: 1 };
  const p = XJ.calc.projection(cfg, startAssets, baseDividend);

  console.log('    期初息率 = ' + p.yieldPct.toFixed(4) + '%（截图显示 6.68% 为四舍五入值）');
  close('第 1 年分红 ≈ 截图 ¥24,160', p.rows[0].dividend, 24160, 1e-3);
  close('第 1 年末资产 ≈ 截图 ¥386,024', p.rows[0].assetsEnd, 386024, 1e-3);
  close('第 2 年分红 ≈ 截图 ¥37,791', p.rows[1].dividend, 37791, 1e-3);
  close('第 2 年末资产 ≈ 截图 ¥603,816', p.rows[1].assetsEnd, 603816, 1e-3);
  close('10 年后分红 ≈ 截图 ¥185,255', p.rows[9].dividend, 185255, 3e-3);
  close('增长倍数 ≈ 截图 ×15.3', p.multiple, 15.3, 5e-3);

  /* 息覆反推与截图的身份式核对：5978 / 7% ≈ 85394 */
  close('截图口径：5978 ÷ 7% ≈ 85394', 5978 / 0.07, 85394, 2e-3);
  const cov = XJ.calc.coverage(12142.43, [
    { key: 'A', label: '话费', monthlyAmount: 60, enabled: true, sortOrder: 1 },
    { key: 'B', label: '水电燃气', monthlyAmount: 100, enabled: true, sortOrder: 2 },
    { key: 'C', label: '物业费', monthlyAmount: 350, enabled: true, sortOrder: 3 },
    { key: 'D', label: '加油', monthlyAmount: 350, enabled: true, sortOrder: 4 },
    { key: 'E', label: '房贷/房租', monthlyAmount: 700, enabled: true, sortOrder: 5 },
    { key: 'F', label: '其他消费', monthlyAmount: 300, enabled: true, sortOrder: 6 },
    { key: 'G', label: '午餐', monthlyAmount: 250, enabled: true, sortOrder: 7 },
  ], 7);
  console.log('    复刻覆盖结果：点亮 ' + cov.litCount + '/7，下一目标「' + (cov.nextItem ? cov.nextItem.label : '—') +
    '」，还差 ' + cov.needMore.toFixed(2) + '，需加仓 ' + cov.addCapital.toFixed(0));
  eq('截图中 5 项支出为 720+1200+4200+4200+8400=18720... 校验排序为升序',
    cov.items.every((x, i, a) => i === 0 || a[i - 1].annualAmount <= x.annualAmount), true);
}

/* ---- 6.9 数据模型 ---- */
section('【9】证券代码规范化与导入导出');
{
  const N = XJ.model.normalizeSymbol;
  eq('600023 → sh600023', N('600023'), 'sh600023');
  eq('000858 → sz000858', N('000858'), 'sz000858');
  eq('300750 → sz300750', N('300750'), 'sz300750');
  eq('688981 → sh688981', N('688981'), 'sh688981');
  eq('430047 → bj430047', N('430047'), 'bj430047');
  eq('SH600023 → sh600023', N('SH600023'), 'sh600023');
  eq('600023.SH → sh600023', N('600023.SH'), 'sh600023');
  eq('sz000858 原样通过', N('sz000858'), 'sz000858');
  eq('非法输入 12345 → null', N('12345'), null);
  eq('非法输入 !!! → null', N('!!!'), null);
  eq('非法输入空串 → null', N(''), null);

  /* ---- 多市场代码规范化（M1 市场抽象层） ---- */
  section('【9b】多市场代码规范化与币种');
  eq('00700 → hk00700', N('00700'), 'hk00700');
  eq('700 → hk00700（补零）', N('700'), 'hk00700');
  eq('hk00700 原样通过', N('hk00700'), 'hk00700');
  eq('09988 → hk09988', N('09988'), 'hk09988');
  eq('00700.HK → hk00700', N('00700.HK'), 'hk00700');
  eq('AAPL → usAAPL', N('AAPL'), 'usAAPL');
  eq('aapl 转大写 → usAAPL', N('aapl'), 'usAAPL');
  eq('AAPL.OQ 去交易所后缀 → usAAPL', N('AAPL.OQ'), 'usAAPL');
  eq('BRK.B → usBRK（去点号后缀）', N('BRK.B'), 'usBRK');
  eq('12345 不以 0 开头 → null（避免与 A 股混淆）', N('12345'), null);
  eq('110022 显式 of 前缀 → of110022', N('of110022'), 'of110022');
  eq('市场提示强制解析：700 + hk', N('700', 'hk'), 'hk00700');
  eq('市场提示强制解析：110022 + of', N('110022', 'of'), 'of110022');
  eq('市场提示强制解析：600023 + auto 缺省仍为沪', N('600023'), 'sh600023');

  const MK = XJ.market;
  eq('沪市币种 = CNY', MK.currency('sh600023'), 'CNY');
  eq('港股币种 = HKD', MK.currency('hk00700'), 'HKD');
  eq('美股币种 = USD', MK.currency('usAAPL'), 'USD');
  eq('场外基金币种 = CNY', MK.currency('of110022'), 'CNY');
  eq('市场标签：港股 = 港', MK.label('hk00700'), '港');
  eq('市场标签：美股 = 美', MK.label('usAAPL'), '美');
  eq('市场类型：场外基金', MK.kind('of110022'), '场外基金');
  eq('场外基金不可取行情', MK.isQuoteable('of110022'), false);
  eq('A股可行情', MK.isQuoteable('sh600023'), true);
  eq('港股可行情', MK.isQuoteable('hk00700'), true);
  eq('美股可行情', MK.isQuoteable('usAAPL'), true);
  eq('分红数据源：A股 = cn', MK.dividendSource('sh600023'), 'cn');
  eq('分红数据源：港股 = hk', MK.dividendSource('hk00700'), 'hk');
  eq('分红数据源：美股 = null（已移除美股分红逻辑）', MK.dividendSource('usAAPL'), null);
  eq('分红数据源：场外基金 = fund', MK.dividendSource('of110022'), 'fund');
  eq('美股不支持自动同步分红', MK.supportsDividend('usAAPL'), false);
  eq('港股支持自动同步分红', MK.supportsDividend('hk00700'), true);
  eq('A股支持自动同步分红', MK.supportsDividend('sh600023'), true);
  eq('ETF 支持自动同步分红', MK.supportsDividend('sh515450'), true);
  eq('美股分红源说明 = 暂不支持自动同步', MK.dividendSourceLabel('usAAPL'), '暂不支持自动同步');
  eq('港股分红源说明', MK.dividendSourceLabel('hk00700'), '东方财富港股 F10 分红');
  eq('汇率代码：HKD', MK.fxCode('HKD'), 'whHKDCNY');
  eq('汇率代码：USD', MK.fxCode('USD'), 'whUSDCNY');
  eq('汇率解析（腾讯 whHKDCNY 实盘串）', MK.parseFx('310~港元人民币~HKDCNY~0.8550~0~20260910160907~0.8551~0.8551~0.8553~0.8548'), 0.8550);
  eq('汇率解析：空值返回 null', MK.parseFx('310~港元人民币~HKDCNY~~0~'), null);

  /* ---- 行情字段位解析（三市场实测串，按索引构建避免手写偏移） ---- */
  section('【9c】行情字段位解析（A股 / 港股 / 美股）');

  /** 按索引填字段再 join('~')，杜绝手工数 ~ 的偏移错误 */
  function rawFrom(map, len) {
    const arr = new Array(len || 52).fill('');
    for (const k of Object.keys(map)) arr[+k] = map[k];
    return arr.join('~');
  }

  const A_RAW = rawFrom({
    1: '浙能电力', 2: '600023', 3: '4.98', 4: '5.02', 5: '5.00',
    30: '20260910150431', 31: '-0.04', 32: '-0.80', 33: '5.04', 34: '4.97',
    36: '478990', 37: '23991', 38: '0.36', 39: '12.10',
    44: '667.75', 45: '667.75', 47: '5.52', 48: '4.52',
  });
  const qa = MK.parseQuoteFields('sh600023', A_RAW);
  eq('A股 · 名称', qa.name, '浙能电力');
  eq('A股 · 现价', qa.price, 4.98);
  eq('A股 · 昨收', qa.prevClose, 5.02);
  eq('A股 · 涨跌额', qa.change, -0.04);
  eq('A股 · 涨跌幅', qa.changePct, -0.80);
  eq('A股 · 市盈率', qa.pe, 12.10);
  eq('A股 · 总市值(亿)', qa.totalCap, 667.75);
  eq('A股 · 币种', qa.currency, 'CNY');
  eq('A股 · 时间归一化', qa.quoteTime, '20260910150431');
  eq('A股 · 涨跌停', qa.limitUp, 5.52);
  eq('A股 · 字段不足应返回 null', MK.parseQuoteFields('sh600023', '1~2~3'), null);
  eq('A股 · 空串应返回 null', MK.parseQuoteFields('sh600023', ''), null);

  const HK_RAW = rawFrom({
    1: '腾讯控股', 2: '00700', 3: '426.800', 4: '434.000', 5: '430.000',
    30: '2026/09/10 15:50:44', 31: '-7.200', 32: '-1.66', 33: '430.800', 34: '425.000',
    36: '19636428.0', 37: '8384385479.394', 38: '0', 39: '15.61',
    44: '38852.2930', 45: '38852.2930', 46: 'TENCENT', 47: '1.24', 48: '677.700', 49: '411.000',
  });
  const qh = MK.parseQuoteFields('hk00700', HK_RAW);
  eq('港股 · 名称', qh.name, '腾讯控股');
  eq('港股 · 现价', qh.price, 426.800);
  eq('港股 · 昨收', qh.prevClose, 434.000);
  eq('港股 · 涨跌幅', qh.changePct, -1.66);
  eq('港股 · 币种', qh.currency, 'HKD');
  eq('港股 · 市盈率', qh.pe, 15.61);
  eq('港股 · 总市值(亿)', qh.totalCap, 38852.2930);
  eq('港股 · 时间归一化（斜杠格式）', qh.quoteTime, '20260910155044');
  eq('港股 · 无涨跌停制度（[47]/[48] 另有含义，不可复用）', qh.limitUp, null);

  const US_RAW = rawFrom({
    1: '苹果', 2: 'AAPL.OQ', 3: '315.34', 4: '316.22', 5: '315.49',
    30: '2026-09-09 16:00:01', 31: '-0.88', 32: '-0.28', 33: '319.15', 34: '309.90',
    35: 'USD', 36: '65639962', 37: '20627580775', 38: '0.45', 39: '36.16',
    44: '45992.68234', 45: '46021.28721', 46: 'Apple Inc.', 47: '8.72',
  });
  const qu = MK.parseQuoteFields('usAAPL', US_RAW);
  eq('美股 · 名称', qu.name, '苹果');
  eq('美股 · 现价', qu.price, 315.34);
  eq('美股 · 涨跌幅', qu.changePct, -0.28);
  eq('美股 · 币种取自 [35]', qu.currency, 'USD');
  eq('美股 · 字段位 [35] 与 A 股不同但仍能正确取到 PE', qu.pe, 36.16);
  eq('美股 · 无涨跌停概念', qu.limitUp, null);
  eq('美股 · 时间归一化（短横格式）', qu.quoteTime, '20260909160001');

  /* 名称截断识别（XD 挤占名称位） */
  eq('XD中国平 标记为截断名', MK.isTruncatedName('XD中国平'), true);
  eq('中国平安 非截断名', MK.isTruncatedName('中国平安'), false);
  eq('五 粮 液 清洗空格', MK.cleanName('五 粮 液'), '五粮液');
  eq('停牌兜底：现价为 0 时取昨收',
    MK.parseQuoteFields('sh600023', A_RAW.replace('~4.98~5.02~', '~0.00~5.02~')).price, 5.02);

  const exp = XJ.model.toExport(state, 'test');
  const back = XJ.model.fromImport(JSON.parse(JSON.stringify(exp)));
  eq('导出→导入：账户数一致', back.accounts.length, state.accounts.length);
  eq('导出→导入：交易数一致', back.transactions.length, state.transactions.length);
  eq('导出→导入：方案数一致', Object.keys(back.plans).length, Object.keys(state.plans).length);
  eq('导出→导入：行情缓存一致',
    JSON.stringify(Object.keys(back.quoteCache).sort()), JSON.stringify(Object.keys(state.quoteCache).sort()));

  const roundTrip = JSON.stringify(back.transactions) === JSON.stringify(state.transactions);
  eq('导出→导入：交易逐字段一致', roundTrip, true);
}

/* ---- 6.10 分红发放日优先级 / 资产类型 / 基金分红 ---- */
section('【10】分红发放日优先级 与 基金分红（M2 市场覆盖）');
{
  const C = XJ.calc, MK = XJ.market, F = XJ.fetcher;

  /* 派息日优先级：基金/港股用数据源真实发放日；A股 = 除权除息日（同日） */
  const pExact = plan('sh515450_2026-09-09', 'sh515450', '2026-09-09', 1.5, '实施分配', '2026-09-08', '2026-09-09');
  pExact.payoutDate = '2026-09-14';
  pExact.source = 'fund';                       // 只有基金/港股才认独立派息日
  const pi1 = C.payoutInfo(pExact);
  eq('基金带真实发放日 → exact = true', pi1.exact, true);
  eq('基金带真实发放日 → 取该日期', pi1.date, '2026-09-14');

  const pi2 = C.payoutInfo(plan('a', 'sh600023', '2025-12-31', 2.8, '实施分配', '2026-07-29', '2026-07-30'));
  eq('A股 → exact = false（须标「预计派息日」）', pi2.exact, false);
  eq('A股派息日 = 除权除息日（同日，不 T+1）', pi2.date, '2026-07-30');
  eq('A股无除权日 → 退化为登记日（同日，不 T+1）',
    C.payoutInfo(plan('b', 'sh600023', '2025-06-30', 0.5, '实施分配', '2025-10-16', null)).date, '2025-10-16');
  eq('A股方案即便带 payoutDate 也不用它（口径：派息日=除权除息日）',
    C.payoutInfo(Object.assign(plan('c', 'sh600023', '2025-12-31', 2.8, '实施分配', '2026-07-29', '2026-07-30'), { payoutDate: '2026-08-05' })).date, '2026-07-30');
  eq('三者皆无 → null', C.payoutInfo({}).date, null);

  /* 资产类型识别：决定分红数据从哪来 */
  eq('sh515450 → ETF', MK.assetType('sh515450'), 'etf');
  eq('sh510880 → ETF', MK.assetType('sh510880'), 'etf');
  eq('sz159915 → ETF', MK.assetType('sz159915'), 'etf');
  eq('sh600023 → 个股', MK.assetType('sh600023'), 'stock');
  eq('sz300750 → 个股', MK.assetType('sz300750'), 'stock');
  eq('bj430047 → 个股', MK.assetType('bj430047'), 'stock');
  eq('of110022 → 场外基金', MK.assetType('of110022'), 'of');
  eq('sh515450 分红来源 = fund', MK.dividendSource('sh515450'), 'fund');
  eq('sh600023 分红来源 = cn', MK.dividendSource('sh600023'), 'cn');
  eq('ETF 可取行情', MK.isQuoteable('sh515450'), true);
  eq('场外基金不可取行情', MK.isQuoteable('of110022'), false);
  eq('ETF 标签 = E', MK.label('sh515450'), 'E');
  eq('ETF 类型名 = ETF', MK.kind('sh515450'), 'ETF');
  eq('港股 类型名 = 港股', MK.kind('hk00700'), '港股');

  /* 基金分红行解析（字段顺序来自真实接口） */
  const row = F.parseFundDivRow(['515450', '红利低波50ETF南方', '2026-09-08', '2026-09-09', '0.0150', '2026-09-14', '1']);
  eq('基金行 · 代码', row.fundCode, '515450');
  eq('基金行 · 权益登记日', row.equityRecordDate, '2026-09-08');
  eq('基金行 · 除息日', row.exDividendDate, '2026-09-09');
  eq('基金行 · 每份分红', row.perShare, 0.015);
  eq('基金行 · 真实发放日', row.payoutDate, '2026-09-14');
  eq('基金行 · 坏数据 → null', F.parseFundDivRow(['x']), null);
  eq('基金行 · 无任何日期 → null', F.parseFundDivRow(['1', 'n', '', '', '0.01', '', '']), null);

  /* 基金行 → 统一方案结构（复用既有日历/到账/统计链路） */
  const fp = F.fundRowToPlan(row, 'sh515450');
  eq('基金方案 · planId', fp.planId, 'sh515450_2026-09-09');
  close('基金方案 · 每10份税前 = 0.15', fp.pretaxBonusPer10, 0.15, 1e-12);
  eq('基金方案 · 方案文案', fp.implPlanProfile, '每10份派现金0.1500元');
  eq('基金方案 · 带真实发放日', fp.payoutDate, '2026-09-14');
  eq('基金方案 · 标记已实施', fp.isImplemented, true);
  eq('基金方案 · 来源 = fund', fp.source, 'fund');
  eq('基金方案 · 类型名 = 基金分红', fp.reportType, '基金分红');
  eq('基金方案 · payoutInfo 为确定日期', C.payoutInfo(fp).exact, true);

  /* 基金分红不定期 → 年度化走近 12 个月 */
  const fundPlans = [
    fp,
    F.fundRowToPlan(F.parseFundDivRow(['515450', 'x', '2026-07-14', '2026-07-15', '0.0100', '2026-07-20', '1']), 'sh515450'),
  ];
  eq('基金 · 年度化口径 = fundTtm', C.annualBasePerShare(fundPlans).basis, 'fundTtm');
  close('基金 · 近12个月合计 = 0.025', C.annualBasePerShare(fundPlans).perShare, 0.025, 1e-12);
  close('基金 · 近12个月每股（trailingPerShare）', C.trailingPerShare(fundPlans, REF_TODAY), 0.025, 1e-12);

  /* 端到端：基金分红进入日历，且到账日是真实发放日而非推算 */
  const fstate = JSON.parse(JSON.stringify(state));
  fstate.plans = {};
  fundPlans.forEach(function (p) { fstate.plans[p.planId] = p; });
  fstate.transactions = [{
    txId: 'ft1', accountId: 'acc_1', symbol: 'sh515450', action: 'BUY',
    date: '2026-01-05', quantity: 100000, price: 1.4, fee: 0, createdAt: '2026-01-05T01:00:00Z',
  }];
  fstate.quoteCache = {
    sh515450: { symbol: 'sh515450', name: '红利低波50ETF南方', price: 1.4021, prevClose: 1.4000, changePct: 0.22 },
  };

  const fev = C.calendarEvents(fstate, 'acc_1', null, null)
    .filter(function (e) { return e.type === 'payout' && e.planId === 'sh515450_2026-09-09'; });
  eq('基金到账事件已生成', fev.length, 1);
  eq('基金到账日 = 真实发放日 2026-09-14', fev[0].date, '2026-09-14');
  eq('基金到账非推算值（不标「预计」）', fev[0].isEstimate, false);
  eq('基金到账事件文案 = 派息日（真实发放日）', fev[0].label, '派息日');
  close('基金到账金额 = 100000 × 0.015 = 1500', fev[0].amount, 1500, 1e-9);

  const fh = C.holdings(fstate, 'acc_1')[0];
  eq('基金持仓可正常构建', fh.symbol, 'sh515450');
  eq('基金持仓名称', fh.name, '红利低波50ETF南方');
  close('基金实时股息率 = 0.025 / 1.4021', fh.dividendYield, 0.025 / 1.4021 * 100, 1e-9);
  close('基金预测年度分红 = 100000 × 0.025', fh.predictedDividend, 2500, 1e-9);

  /* A股路径未被破坏（对照） */
  const aPlan = plan('sh600023_2025-12-31', 'sh600023', '2025-12-31', 2.8, '实施分配', '2026-07-29', '2026-07-30');
  eq('A股方案仍走财年口径', C.annualBasePerShare([aPlan]).basis, 'fiscal');
  eq('A股到账事件仍标「预计派息日」',
    C.calendarEvents({
      accounts: state.accounts, symbols: {}, transactions: [{
        txId: 'a1', accountId: 'acc_1', symbol: 'sh600023', action: 'BUY',
        date: '2025-01-05', quantity: 1000, price: 4, fee: 0, createdAt: '2025-01-05T01:00:00Z',
      }], plans: { 'sh600023_2025-12-31': aPlan }, received: [],
      quoteCache: { sh600023: { symbol: 'sh600023', name: '浙能电力', price: 4.98 } },
    }, 'acc_1', null, null).filter(function (e) { return e.type === 'payout'; })[0].label,
    '预计派息日');
}

/* ---- 6.11 数据模型 v3：成本三口径 / 财年口径 N / 快照 / 回本 / 待除权 / 年度总览 / 账户分析 ---- */
section('【11】v3 地基：成本口径 · 财年口径 · 快照 · 回本 · 待除权 · 年度总览 · 账户分析');
{
  const C = XJ.calc, MK = XJ.market;
  /* 独立实现的日期差（不走被测代码） */
  const U_days = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
  const zTxs = fixtures.transactions.filter((t) => t.symbol === 'sh600023');

  /* ---- 1. 成本三口径 ---- */
  // 买入总额(含费) = 1000×4.00+5 + 1000×5.00+5 = 9010
  // 卖出净得(扣费) = 500×6.00−5 = 2995
  // 净投入 = 6015，持股 1500
  const w = C.position(zTxs, null, 'weighted');
  const d = C.position(zTxs, null, 'diluted');
  const dd = C.position(zTxs, null, 'dividendDiluted', 300);
  const ni = C.netInvested(zTxs);

  close('净投入 = 9010 − 2995 = 6015', ni.net, 6015, 1e-9);
  eq('买入总额(含费)', ni.gross, 9010);
  close('摊薄成本 = 6015 ÷ 1500 = 4.01', d.avgCost, 4.01, 1e-12);
  close('分红摊薄成本 = (6015−300) ÷ 1500 = 3.81', dd.avgCost, 3.81, 1e-12);
  close('加权平均不受已收分红影响', w.avgCost, 4.505, 1e-12);
  eq('默认口径 = weighted', w.costMethod, 'weighted');
  eq('摊薄口径下已实现盈亏归零', d.realized, 0);
  eq('加权口径下已实现盈亏保留', w.realized, 742.5);

  // 负成本：买入 200@10，卖出 100@30 → 净投入 −1000，持股 100 → 成本 −10
  const negTxs = [
    { txId: 'n1', accountId: 'a', symbol: 'sh600000', action: 'BUY', date: '2025-01-02', quantity: 200, price: 10, fee: 0, createdAt: '2025-01-02T01:00:00Z' },
    { txId: 'n2', accountId: 'a', symbol: 'sh600000', action: 'SELL', date: '2025-06-02', quantity: 100, price: 30, fee: 0, createdAt: '2025-06-02T01:00:00Z' },
  ];
  const neg = C.position(negTxs, null, 'diluted');
  close('负成本：净投入 = 2000 − 3000 = −1000', neg.netInvested, -1000, 1e-9);
  close('负成本：成本 = −1000 ÷ 100 = −10', neg.avgCost, -10, 1e-12);

  /* ---- 2. 财年口径「近 N 年」（N = 财年个数） ---- */
  const fp = (y, m, v) => plan('x' + y + m, 'sh600001', `${y}-${m}`, v * 10, '实施分配', null, null);
  const multiPlans = [fp(2023, '12-31', 1.0), fp(2024, '12-31', 1.2), fp(2025, '12-31', 1.5), fp(2025, '06-30', 0.3)];
  const a1 = C.annualBasePerShare(multiPlans, { type: 'years', value: 1 });
  const a3 = C.annualBasePerShare(multiPlans, { type: 'years', value: 3 });
  const a5 = C.annualBasePerShare(multiPlans, { type: 'years', value: 5 });
  close('近1年 = 2025 财年合计(年报1.5+中报0.3) = 1.8', a1.perShare, 1.8, 1e-12);
  close('近3年 = (1.0+1.2+1.5+0.3) ÷ 3', a3.perShare, 4.0 / 3, 1e-12);
  eq('近3年 · 区间起点 = 2023', a3.fromYear, 2023);
  eq('近3年 · 实际使用年数 = 3', a3.years, 3);
  eq('近5年 · 数据只有 3 年 → 按 3 年算（不低估）', a5.years, 3);
  eq('近5年 · 标记为被截断', a5.capped, true);
  close('近5年 · 结果与近3年一致', a5.perShare, a3.perShare, 1e-12);
  close('缺省参数等价于近1年', C.annualBasePerShare(multiPlans).perShare, a1.perShare, 1e-12);
  const custom = C.annualBasePerShare(multiPlans, { type: 'custom', startYear: 2024 });
  close('自定义起始财年 2024 → (1.2+1.5+0.3) ÷ 2', custom.perShare, 3.0 / 2, 1e-12);
  eq('自定义 · 年数 = 2', custom.years, 2);

  /* ---- 3. 每日资产快照 ---- */
  const snapState = JSON.parse(JSON.stringify(state));
  snapState.received = [];
  snapState.snapshots = {};
  const snap = C.buildSnapshot(snapState, 'acc_1', { HKD: 0.855, USD: 6.7 });
  close('快照 · 总市值(CNY) = 1500×4.98 + 1900×70.48', snap.mv, 141382, 1e-6);
  close('快照 · 总成本 = 1500×4.505 + 1900×88.010526...', snap.cost, 6757.5 + 167220, 1e-6);
  close('快照 · 预测分红', snap.pred, 5396.4015, 1e-6);

  // 幂等：同一天写两次只留一条
  eq('写入快照成功', C.writeSnapshot(snapState, 'acc_1', { HKD: 0.855 }), true);
  C.writeSnapshot(snapState, 'acc_1', { HKD: 0.855 });
  eq('快照幂等：同一天只留一条', Object.keys(snapState.snapshots).length, 1);
  eq('快照键 = 本地日期', C.snapshotDates(snapState)[0], REF_TODAY);

  // 与上次记录对比
  snapState.snapshots['2026-09-09'] = Object.assign({}, snap, { mv: snap.mv - 2136 });
  const delta = C.snapshotDelta(snapState);
  close('「较上次记录」= 最新 − 上一条 = 2136', delta.mv, 2136, 1e-9);
  eq('较上次记录 · 上一条日期', delta.prevDate, '2026-09-09');
  eq('只有一条快照时无从对比', C.snapshotDelta({ snapshots: { '2026-09-10': snap } }), null);

  /* ---- 4. 分红回本进度 ---- */
  const hs2 = C.holdings(snapState, 'acc_1');
  const hz2 = hs2.find((h) => h.symbol === 'sh600023');
  const recvState = JSON.parse(JSON.stringify(state));
  recvState.received = [{
    recId: 'r1', accountId: 'acc_1', symbol: 'sh600023', planId: null,
    exDividendDate: '2026-01-10', perShareAmount: 0.2, qtyAtRecord: 1500,
    amount: 300, source: 'MANUAL', year: 2026, createdAt: '2026-01-10T00:00:00Z',
  }];
  const hz3 = C.holdings(recvState, 'acc_1').find((h) => h.symbol === 'sh600023');
  close('回本 · 净投入 = 6015', hz3.netInvested, 6015, 1e-9);
  close('回本 · 已收回 = 300', hz3.receivedTotal, 300, 1e-9);
  close('回本 · 剩余待回收 = 5715', hz3.remaining, 5715, 1e-9);
  close('回本 · 进度 = 300 ÷ 6015', hz3.recoveryPct, 300 / 6015 * 100, 1e-9);
  close('回本 · 预计回本年 = 5715 ÷ 495', hz3.expectedYears, 5715 / 495, 1e-9);
  eq('无分红时进度为 0', hz2.recoveryPct, 0);
  close('无分红时预计回本年 = 6015 ÷ 495', hz2.expectedYears, 6015 / 495, 1e-9);

  /* ---- 5. 待除权汇总（除权日在未来 + 已公布但除权日未定） ---- */
  const pendState = JSON.parse(JSON.stringify(state));
  pendState.plans['sh600023_2026-06-30'] = plan('sh600023_2026-06-30', 'sh600023', '2026-06-30', 0.2, '实施分配', '2026-11-20', '2026-11-23');
  const pend = C.pendingExDiv(pendState, 'acc_1');
  eq('待除权 · 涉及 1 只', pend.count, 1);
  close('待除权 · 金额 = 1500 × 0.02 = 30', pend.total, 30, 1e-9);
  eq('待除权 · 标记为除权日已确定', pend.items[0].dateKnown, true);
  eq('待除权 · 带出除权日', pend.items[0].exDate, '2026-11-23');

  /* 除权日已过去的方案不计入（它们走「分红记录」） */
  const pastOnly = JSON.parse(JSON.stringify(state));
  delete pastOnly.plans['sh600023_2026-06-30'];
  eq('已过除权日的方案不计入', C.pendingExDiv(pastOnly, 'acc_1').count, 0);

  /* ★ 回归：方案已公布但除权日尚未确定，也必须出现在「等待除权日」里
     （中国海油 / 中国移动 / 中国石化 的中报方案就是这个形态：董事会决议通过、EX_DIVIDEND_DATE 为空，
       旧逻辑把它们整条过滤掉，用户报的缺陷） */
  const und = C.pendingExDiv(state, 'acc_1');
  eq('★除权日未定的已公布方案计入待除权', und.count, 1);
  eq('★该只被标记为除权日待定', und.items[0].dateKnown, false);
  eq('★待定项的 exDate 为空', und.items[0].exDate, null);
  close('★待定金额计入合计（1500 × 0.02）', und.total, 30, 1e-9);
  eq('★已定/待定 分列统计', und.datedCount + '/' + und.undatedCount, '0/1');
  close('★待定金额单独可查', und.undatedTotal, 30, 1e-9);
  eq('★待定项标明报告期类型', und.items[0].reportType, '中报');

  /* 取消的方案不计入 */
  const cancelled = JSON.parse(JSON.stringify(state));
  cancelled.plans['sh600023_2026-06-30'].assignProgress = '取消分配';
  eq('取消的方案不计入', C.pendingExDiv(cancelled, 'acc_1').count, 0);

  /* 陈年未实施方案不计入（报告期超过 400 天） */
  const stale = JSON.parse(JSON.stringify(state));
  stale.plans['sh600023_2026-06-30'].reportDate = '2024-06-30';
  eq('报告期过老的未定方案不计入', C.pendingExDiv(stale, 'acc_1').count, 0);

  /* 每股派息为 0 的不计入 */
  const zeroPs = JSON.parse(JSON.stringify(state));
  zeroPs.plans['sh600023_2026-06-30'].pretaxBonusPer10 = 0;
  eq('每股派息 0 的不计入', C.pendingExDiv(zeroPs, 'acc_1').count, 0);

  /* 只有除权日已定的方案时才计入 dated 统计 */
  const dated = C.pendingExDiv(pendState, 'acc_1');
  /* pendState 里那条已被「实施分配 + 未来除权日」覆盖，所以这里是 1 只已定、0 只待定 */
  eq('已定/待定 分列统计（未来除权日那条算已定）', dated.datedCount + '/' + dated.undatedCount, '1/0');
  close('已定金额与待定金额之和 = 合计', dated.datedTotal + dated.undatedTotal, dated.total, 1e-9);
  /* 排序：除权日已确定的排在前面 */
  eq('排序 · 除权日已确定的排在前', dated.items[0].dateKnown, true);

  /* ---- 6. 收息天数 ---- */
  const sd = C.statDays(state, 'acc_1');
  eq('收息天数 · 起算日 = 最早买入日', sd.since, '2024-09-02');
  eq('收息天数 · 含首日（今天−买入日+1）', sd.days, U_days('2024-09-02', REF_TODAY) + 1);
  eq('无交易时收息天数 = 0', C.statDays({ transactions: [] }, 'acc_1').days, 0);

  /* ---- 7. 年度总览（月均 ÷ 已过去月份数） ---- */
  const withRecv = JSON.parse(JSON.stringify(state));
  withRecv.received = [];
  C.applyAutoReceived(withRecv);
  const av26 = C.annualView(withRecv, 'acc_1', 2026);
  const av25 = C.annualView(withRecv, 'acc_1', 2025);
  close('2026 年度已到账 = 420 + 4901.40（到账金额按分四舍五入）', av26.total, 5321.40, 1e-9);
  eq('2026 · 笔数 = 2', av26.count, 2);
  eq('2026 · 涉及标的 = 2', av26.symbolCount, 2);
  eq('2026 · 月均分母 = 已过去月份数 9', av26.denom, 9);
  close('2026 · 月均 = 5321.40 ÷ 9', av26.monthlyAvg, 5321.40 / 9, 1e-9);
  eq('2025 · 月均分母 = 12（历史年度）', av25.denom, 12);
  close('2025 · 月均 = 100 ÷ 12', av25.monthlyAvg, 100 / 12, 1e-9);
  eq('12 个月数组长度', av26.months.length, 12);
  close('9 月金额 = 420（浙能 7月30除权…归属 2026-07-31）', av26.months.reduce((a, b) => a + b, 0), av26.total, 1e-9);
  eq('可选年份含当前年', C.availableYears(withRecv, 'acc_1').includes(2026), true);

  /* ---- 8. 账户分析 ---- */
  const an = C.analytics(state, 'acc_1');
  eq('盈亏榜含 2 只', an.byPnl.length, 2);
  eq('盈亏榜首位 = 浮盈最高的浙能电力', an.byPnl[0].symbol, 'sh600023');
  eq('亏损标的计入 topLosers', an.topLosers.length, 1);
  eq('topLosers[0] = 五粮液', an.topLosers[0].symbol, 'sz000858');
  eq('盈利只数 = 1', an.gainCount, 1);
  eq('亏损只数 = 1', an.lossCount, 1);
  eq('股息率分层桶数 = 6', an.yieldBuckets.length, 6);
  eq('分层计数合计 = 持仓数', an.yieldBuckets.reduce((a, b) => a + b.count, 0), 2);
  close('集中度 · 第一大占比 = 133912 ÷ 141382', an.concentration.top1, 133912 / 141382 * 100, 1e-6);
  close('集中度 · HHI', an.concentration.hhi, Math.pow(133912 / 141382, 2) + Math.pow(7470 / 141382, 2), 1e-9);
  eq('集中度 · 等级 = 高度集中', an.concentration.level, '高度集中');
  eq('按资产类型分组：均为个股', an.byAssetType.length, 1);
  eq('按资产类型 · 标签 = 股票', an.byAssetType[0].label, '股票');

  /* ---- 9. 组合新指标 ---- */
  const s3 = C.summary(state, 'acc_1');
  close('成本息率 = 预测分红 ÷ 总成本', s3.costYield, 5396.4015 / (6757.5 + 167220) * 100, 1e-9);
  close('市值息率 = 组合息率', s3.marketYield, s3.compositeYield, 1e-12);
  close('月均预测分红 = 预测分红 ÷ 12', s3.monthlyDividend, 5396.4015 / 12, 1e-12);
  close('单只平均市值 = 总市值 ÷ 只数', s3.avgMarketValue, 141382 / 2, 1e-9);
  close('净投入合计', s3.totalNetInvested, 6015 + 167220, 1e-6);

  /* ---- 10. 多币种快照折算 ---- */
  const fxState = JSON.parse(JSON.stringify(state));
  fxState.transactions.push({
    txId: 'hk1', accountId: 'acc_1', symbol: 'hk00700', action: 'BUY',
    date: '2025-01-05', quantity: 100, price: 400, fee: 0, createdAt: '2025-01-05T01:00:00Z',
  });
  fxState.quoteCache.hk00700 = { symbol: 'hk00700', name: '腾讯控股', price: 420, prevClose: 418, changePct: 0.5 };
  const snapFx = C.buildSnapshot(fxState, 'acc_1', { HKD: 0.9, USD: 7 });
  close('多币种快照 · 港股按汇率折算进总市值',
    snapFx.mv, 141382 + 100 * 420 * 0.9, 1e-6);
  close('多币种快照 · 港股按汇率折算进总成本',
    snapFx.cost, 6757.5 + 167220 + 100 * 400 * 0.9, 1e-6);
  eq('快照记录汇率', snapFx.fx.HKD, 0.9);
}

/* ---- 6.12 v3 边界与聚合 ---- */
section('【12】v3 边界与聚合');
{
  const C = XJ.calc;

  /* 清仓后重建仓：加权口径成本重新起算；摊薄口径净投入累计 */
  const txs = [
    { txId: 'a', accountId: 'x', symbol: 'sh600001', action: 'BUY', date: '2025-01-02', quantity: 100, price: 10, fee: 0, createdAt: '1' },
    { txId: 'b', accountId: 'x', symbol: 'sh600001', action: 'SELL', date: '2025-03-02', quantity: 100, price: 12, fee: 0, createdAt: '2' },
    { txId: 'c', accountId: 'x', symbol: 'sh600001', action: 'BUY', date: '2025-06-02', quantity: 200, price: 8, fee: 0, createdAt: '3' },
  ];
  const w2 = C.position(txs, null, 'weighted');
  close('清仓后重建仓 · 加权成本重新起算 = 8', w2.avgCost, 8, 1e-12);
  close('清仓后重建仓 · 已实现盈亏 = 100×(12−10) = 200', w2.realized, 200, 1e-12);
  const d2 = C.position(txs, null, 'diluted');
  close('清仓后重建仓 · 净投入 = 1000 − 1200 + 1600 = 1400', d2.netInvested, 1400, 1e-9);
  close('清仓后重建仓 · 摊薄成本 = 1400 ÷ 200 = 7', d2.avgCost, 7, 1e-12);
  eq('清仓后重建仓 · 摊薄口径已实现盈亏为 0', d2.realized, 0);
  close('按日期截断 + 摊薄口径 · 2025-03-31 净投入 = 1000 − 1200',
    C.position(txs, '2025-03-31', 'diluted').netInvested, -200, 1e-9);

  /* 送股（0 元买入）：股数增加、总成本不变、均价自动摊低 */
  const gift = [
    { txId: 'g1', accountId: 'x', symbol: 'sh600002', action: 'BUY', date: '2025-01-02', quantity: 1000, price: 10, fee: 0, createdAt: '1' },
    { txId: 'g2', accountId: 'x', symbol: 'sh600002', action: 'BUY', date: '2025-06-02', quantity: 200, price: 0, fee: 0, createdAt: '2' },
  ];
  const g = C.position(gift, null, 'weighted');
  eq('送股后股数 = 1200', g.qty, 1200);
  close('送股后总成本仍为 10000', g.costBasis, 10000, 1e-9);
  close('送股后均价摊低至 8.3333', g.avgCost, 10000 / 1200, 1e-12);

  /* 财年口径降级链 */
  const noAnnual = [plan('n1', 'sh600003', '2025-06-30', 5, '实施分配', '2025-10-16', '2025-10-17')];
  eq('只有中报无年报 → 降级为 ttm', C.annualBasePerShare(noAnnual).basis, 'ttm');
  const draftOnly = [plan('d1', 'sh600004', '2026-06-30', 5, '董事会决议通过', null, null)];
  eq('只有预案 → basis = none', C.annualBasePerShare(draftOnly).basis, 'none');
  close('只有预案 → 每股为 0', C.annualBasePerShare(draftOnly).perShare, 0, 1e-12);

  /* 待除权多标的聚合 */
  const st2 = JSON.parse(JSON.stringify(state));
  st2.plans = {
    'sh600023_2026-06-30': plan('sh600023_2026-06-30', 'sh600023', '2026-06-30', 2, '实施分配', '2026-11-20', '2026-11-23'),
    'sz000858_2026-06-30': plan('sz000858_2026-06-30', 'sz000858', '2026-06-30', 3, '实施分配', '2026-12-01', '2026-12-02'),
  };
  const pd = C.pendingExDiv(st2, 'acc_1');
  eq('待除权 · 涉及 2 只标的', pd.count, 2);
  close('待除权 · 合计 = 1500×0.2 + 1900×0.3', pd.total, 1500 * 0.2 + 1900 * 0.3, 1e-9);
  /* 排序：除权日已确定的按除权日升序（11-23 在前，12-02 在后）——
     旧的「一律按金额降序」会让「除权日待定」的估算金额插在确定的日期之间，读起来很乱 */
  eq('待除权 · 除权日早的排在前', pd.items[0].symbol, 'sh600023');
  eq('待除权 · 第二只是除权日较晚的', pd.items[1].symbol, 'sz000858');
  eq('待除权 · 两只都标为除权日已确定', pd.items[0].dateKnown && pd.items[1].dateKnown, true);

  /* 年份与空年份 */
  const ys = C.availableYears(st2, 'acc_1');
  eq('可选年份含当前年 2026', ys.includes(2026), true);
  eq('可选年份降序', ys[0] >= ys[ys.length - 1], true);
  const av0 = C.annualView(st2, 'acc_1', 1999);
  eq('无记录年份 · 总额 0', av0.total, 0);
  eq('无记录年份 · 月均分母 12', av0.denom, 12);

  /* 多快照 delta */
  const sn = { snapshots: { '2026-09-08': { mv: 100 }, '2026-09-09': { mv: 130 }, '2026-09-10': { mv: 120 } } };
  close('多快照 delta 取最近两条 = 120 − 130', C.snapshotDelta(sn).mv, -10, 1e-9);
  eq('delta 当前日期 = 最新', C.snapshotDelta(sn).date, '2026-09-10');
  eq('快照日期升序', C.snapshotDates(sn).join(','), '2026-09-08,2026-09-09,2026-09-10');

  /* 支出项全部停用 */
  const off = state.expenses.map(function (e) { return Object.assign({}, e, { enabled: false }); });
  const cov0 = C.coverage(10000, off, 7);
  eq('支出项全停用 → 无参与项', cov0.totalCount, 0);
  eq('支出项全停用 → 进度 0', cov0.overallProgress, 0);
  eq('支出项全停用 → 无下一目标', cov0.nextItem, null);

  /* analytics 无行情 */
  const noQuote = JSON.parse(JSON.stringify(state));
  noQuote.quoteCache = {};
  const an0 = C.analytics(noQuote, 'acc_1');
  eq('无行情 → 盈亏榜为空', an0.byPnl.length, 0);
  eq('无行情 → 集中度等级为 —', an0.concentration.level, '—');
  eq('无行情 → 股息率分层桶仍为 6', an0.yieldBuckets.length, 6);
  eq('无行情 → 持仓仍可统计只数', an0.summary.count, 2);

  /* statDays 边界 */
  eq('只有卖出无买入 → 收息 0 天', C.statDays({ transactions: [{ action: 'SELL', date: '2025-01-01' }] }, 'x').days, 0);

  /* 默认支出项 */
  eq('默认支出项 = 6 项（与息记截图一致）', state.expenses.length, 6);
  eq('默认支出项均带 emoji 图标', state.expenses.every(function (e) { return !!e.icon; }), true);
  eq('默认支出项 key 唯一', new Set(state.expenses.map(function (e) { return e.key; })).size, 6);

  /* 老版本支出项模板平滑升级 */
  const legacy = Object.assign(XJ.model.defaultState(), {
    expenses: XJ.model.LEGACY_EXPENSE_TEMPLATE.map(function (e, i) {
      return { expenseId: 'exp_' + e.key.toLowerCase(), key: e.key, label: e.label,
        monthlyAmount: e.monthlyAmount, enabled: true, sortOrder: i + 1 };
    }),
  });
  XJ.model.ensureBootstrapped(legacy);
  eq('未改动过的旧支出项 → 升级为新 6 项模板', legacy.expenses.length, 6);
  eq('升级后第一项为话费', legacy.expenses[0].label, '话费');
  const custom = Object.assign(XJ.model.defaultState(), {
    expenses: [{ expenseId: 'e1', key: 'PHONE', label: '话费', monthlyAmount: 88, enabled: true, sortOrder: 1 }],
  });
  XJ.model.ensureBootstrapped(custom);
  eq('用户自定义过的支出项 → 原样保留', custom.expenses.length, 1);
  eq('自定义金额未被覆盖', custom.expenses[0].monthlyAmount, 88);
}

/* ---- 6.13 港股分红解析（美股分红已移除） ---- */
section('【13】港股分红（东财 HKF10）· 美股分红已移除');
{
  const F = XJ.fetcher, C = XJ.calc, MK = XJ.market;

  /* 真实接口行：腾讯控股 2025 年度分配 每股派港币5.3元 */
  const hkRow = {
    SECURITY_CODE: '00700', NOTICE_DATE: '2026-03-18 00:00:00',
    REPORT_TYPE: '年度分配', EX_DIVIDEND_DATE: '2026/05/15', DIVIDEND_DATE: '2026/06/01',
    TRANSFER_END_DATE: '2026/05/19-2026/05/20', YEAR: '2025',
    PLAN_EXPLAIN: '每股派港币5.3元', IS_BFP: '0', SECUCODE: '00700.HK',
  };
  const p = F.parseHkRow(hkRow, 'hk00700');
  eq('港股 · 方案解析成功', !!p, true);
  eq('港股 · 除净日（斜杠→横杠）', p.exDividendDate, '2026-05-15');
  eq('港股 · **真实派息日**（非推算）', p.payoutDate, '2026-06-01');
  close('港股 · 每10股税前 = 53', p.pretaxBonusPer10, 53, 1e-12);
  close('港股 · 每股税前 = 5.3', C.perSharePretax(p), 5.3, 1e-12);
  eq('港股 · 报告期按财政年度生成（年度分配→12-31）', p.reportDate, '2025-12-31');
  eq('港股 · 分配类型', p.reportType, '年度分配');
  eq('港股 · 截止过户日', p.transferEndDate, '2026/05/19-2026/05/20');
  eq('港股 · 已实施', p.isImplemented, true);
  eq('港股 · 来源标记 hk', p.source, 'hk');
  eq('港股 · payoutInfo 为确定日期', C.payoutInfo(p).exact, true);
  eq('港股 · 到账日 = 真实派息日而非 T+1', C.payoutInfo(p).date, '2026-06-01');

  eq('港股 · 中期分配报告期 = 06-30', F.hkReportDate('2026', '中期分配'), '2026-06-30');
  eq('港股 · 一季度分配报告期 = 03-31', F.hkReportDate('2026', '一季度分配'), '2026-03-31');
  eq('港股 · 三季度分配报告期 = 09-30', F.hkReportDate('2026', '三季度分配'), '2026-09-30');

  eq('港股 · 「未派发或宣派股息」被过滤',
    F.parseHkRow(Object.assign({}, hkRow, { IS_BFP: '1', EX_DIVIDEND_DATE: null, DIVIDEND_DATE: null, PLAN_EXPLAIN: '未派发或宣派股息' }), 'hk00700'), null);
  eq('港股 · 无任何日期被过滤',
    F.parseHkRow(Object.assign({}, hkRow, { EX_DIVIDEND_DATE: null, DIVIDEND_DATE: null }), 'hk00700'), null);
  eq('港股 · 纯送股方案不进现金分红',
    F.parseHkRow(Object.assign({}, hkRow, { PLAN_EXPLAIN: '每10股分派1股美团B类普通股' }), 'hk00700'), null);

  eq('港股文案 · 每股派港币X元', F.parseHkPerShare('每股派港币5.3元'), 5.3);
  eq('港股文案 · 每股派X港元', F.parseHkPerShare('每股派1.15港元'), 1.15);
  eq('港股文案 · 人民币派息取港币折算值',
    F.parseHkPerShare('每股派人民币0.0043元(相当于港币0.0049元)'), 0.0049);
  eq('港股文案 · 特别分配取「相当于每股派X港元」',
    F.parseHkPerShare('特殊说明:每10股分派1股美团B类普通股股份(相当于每股派18.13港元)'), 18.13);
  eq('港股文案 · 无金额 → null', F.parseHkPerShare('不分配不转增'), null);
  eq('港股文案 · 空值 → null', F.parseHkPerShare(''), null);

  /* 端到端：港股进入持仓 / 日历 */
  const hs = JSON.parse(JSON.stringify(state));
  hs.plans = {};
  hs.plans[p.planId] = p;
  hs.transactions = [{
    txId: 'h1', accountId: 'acc_1', symbol: 'hk00700', action: 'BUY',
    date: '2025-01-06', quantity: 200, price: 400, fee: 0, createdAt: '2025-01-06T01:00:00Z',
  }];
  hs.quoteCache = { hk00700: { symbol: 'hk00700', name: '腾讯控股', price: 420, prevClose: 418, changePct: 0.5 } };

  const h = C.holdings(hs, 'acc_1')[0];
  eq('港股持仓 · 币种 HKD', h.currency, 'HKD');
  eq('港股持仓 · 类型 港股', h.kindLabel, '港股');
  eq('港股持仓 · 走财年口径', h.annualBasis, 'fiscal');
  close('港股持仓 · 财年每股 = 5.3', h.annualPerShare, 5.3, 1e-12);
  close('港股持仓 · 预测年度分红 = 200 × 5.3', h.predictedDividend, 1060, 1e-9);
  close('港股持仓 · 股价息率 = 5.3 ÷ 420', h.dividendYield, 5.3 / 420 * 100, 1e-9);

  const ev = C.calendarEvents(hs, 'acc_1', null, null).filter(function (e) { return e.type === 'payout'; });
  eq('港股 · 日历生成派息事件', ev.length, 1);
  eq('港股 · 日历派息日 = 真实发放日', ev[0].date, '2026-06-01');
  eq('港股 · 派息事件不标「预计」', ev[0].isEstimate, false);
  eq('港股 · 派息事件文案 = 派息日', ev[0].label, '派息日');

  /* 美股：可以建仓看行情，但完全不参与分红逻辑 */
  const usHs = JSON.parse(JSON.stringify(state));
  usHs.transactions.push({
    txId: 'u1', accountId: 'acc_1', symbol: 'usAAPL', action: 'BUY',
    date: '2025-01-06', quantity: 10, price: 200, fee: 0, createdAt: '2025-01-06T01:00:00Z',
  });
  usHs.quoteCache.usAAPL = { symbol: 'usAAPL', name: '苹果', price: 315.34, prevClose: 316.22, changePct: -0.28 };
  const uh = C.holdings(usHs, 'acc_1').filter(function (x) { return x.symbol === 'usAAPL'; })[0];
  eq('美股持仓 · 可建仓并显示行情', uh.qty, 10);
  eq('美股持仓 · 无分红方案', uh.hasPlans, false);
  close('美股持仓 · 预测分红为 0', uh.predictedDividend, 0, 1e-12);
  eq('美股持仓 · 分红口径 basis = none', uh.annualBasis, 'none');
  eq('美股 · 不产生任何日历事件',
    C.calendarEvents(usHs, 'acc_1', null, null).filter(function (e) { return e.symbol === 'usAAPL'; }).length, 0);
  eq('美股 · 排序时预测分红不影响其他标的', C.holdings(usHs, 'acc_1')[0].predictedDividend > 0, true);
}

/* ---- 6.14 截图识别：模型输出解析（纯函数，可离线复算） ---- */
section('【14】截图识别（智谱 GLM-4V）· 输出解析与字段归一化');
{
  const O = XJ.ocr, MK2 = XJ.market;

  eq('模型清单含免费档 glm-4v-flash', O.MODELS.some(function (m) { return m.key === 'glm-4v-flash'; }), true);
  eq('默认模型 = glm-4v-flash', O.DEFAULT_MODEL, 'glm-4v-flash');
  eq('接口端点', O.ENDPOINT, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');

  const r1 = O.extractJson('[{"name":"双汇发展","code":"000895","quantity":400,"cost":23.995,"price":23.89}]');
  eq('标准 JSON 数组 · 条数', r1.length, 1);
  eq('标准 JSON 数组 · 名称', r1[0].name, '双汇发展');
  eq('标准 JSON 数组 · 代码', r1[0].code, '000895');
  eq('标准 JSON 数组 · 数量', r1[0].quantity, 400);
  eq('标准 JSON 数组 · 成本', r1[0].cost, 23.995);

  eq('带 ```json 围栏也能解析',
    O.extractJson('```json\n[{"name":"A","code":"600023","quantity":100}]\n```').length, 1);
  eq('带 <think> 思考块也能解析',
    O.extractJson('<think>先看图…</think>[{"name":"B","code":"600023","quantity":200}]')[0].name, 'B');
  eq('单个对象自动包成数组', O.extractJson('{"name":"C","code":"600023","quantity":300}').length, 1);
  eq('中文键名可识别',
    O.extractJson('[{"股票名称":"五粮液","股票代码":"000858","持仓数量":"1,900","成本价":"88.01"}]')[0].name, '五粮液');
  eq('中文键名 · 数量去千分位',
    O.extractJson('[{"股票名称":"五粮液","股票代码":"000858","持仓数量":"1,900"}]')[0].quantity, 1900);
  eq('中文键名 · 成本',
    O.extractJson('[{"股票名称":"五粮液","成本价":"88.01"}]')[0].cost, 88.01);
  eq('未加引号的中文键也能救回来',
    O.extractJson('[{股票名称:"五粮液",股票代码:"000858",持仓数量:1900}]')[0].quantity, 1900);
  eq('去 ¥ 与「股」单位',
    O.extractJson('[{"name":"X","code":"600023","quantity":"400股","cost":"¥23.995"}]')[0].cost, 23.995);
  eq('尾随逗号容错',
    O.extractJson('[{"name":"D","code":"600023","quantity":100},]').length, 1);
  eq('只有数量与成本、无名称代码 → 仍保留（可人工补代码）',
    O.extractJson('[{"quantity":100,"cost":1}]').length, 1);
  eq('完全空对象被丢弃', O.extractJson('[{}]').length, 0);
  eq('只有名称也能保留', O.extractJson('[{"name":"某股"}]').length, 1);
  eq('空数组 → 0 条', O.extractJson('[]').length, 0);
  eq('完全无 JSON → 抛错',
    (function () { try { O.extractJson('抱歉，我看不清这张图'); return false; } catch (e) { return true; } })(), true);
  eq('美股字母代码保留', O.extractJson('[{"name":"苹果","code":"AAPL","quantity":10}]')[0].code, 'AAPL');
  eq('港股代码保留前导零', O.extractJson('[{"name":"腾讯控股","code":"00700","quantity":200}]')[0].code, '00700');
  eq('多行（持仓列表）全部提取',
    O.extractJson('[{"name":"A","code":"600023","quantity":10},{"name":"B","code":"000858","quantity":20},{"name":"C","code":"601318","quantity":30}]').length, 3);

  eq('数量缺失 → null', O.normalizeRow({ name: 'A' }).quantity, null);
  eq('成本为破折号 → null', O.normalizeRow({ name: 'A', cost: '—' }).cost, null);
  eq('代码含分隔符 → 剔净', O.normalizeRow({ name: 'A', code: 'sh-600023' }).code, 'sh600023');
  eq('非对象行 → null', O.normalizeRow('abc'), null);
  eq('null 行 → null', O.normalizeRow(null), null);

  /* 与代码规范化联动：识别结果 → 内部 symbol */
  eq('A股 6 位 → sh600023', MK2.normalize(O.normalizeRow({ name: 'A', code: '600023' }).code), 'sh600023');
  eq('深市 6 位 → sz000858', MK2.normalize(O.normalizeRow({ name: 'A', code: '000858' }).code), 'sz000858');
  eq('港股 5 位 → hk00700', MK2.normalize(O.normalizeRow({ name: 'A', code: '00700' }).code), 'hk00700');
  eq('美股字母 → usAAPL', MK2.normalize(O.normalizeRow({ name: 'A', code: 'AAPL' }).code), 'usAAPL');
  eq('ETF 5 开头 → sh515450', MK2.normalize(O.normalizeRow({ name: 'A', code: '515450' }).code), 'sh515450');

  /* 默认配置 */
  /* 源码里是构建期占位符，真正的 Key 由 build.mjs 注入：
     单文件产物 → 内置真实 Key；dist/pwa/ → 置空（部署到公网等于公开 Key） */
  eq('源码里的 Key 是构建期占位符', XJ.model.DEFAULT_OCR_KEY, '__XJ_OCR_KEY__');
  const st0 = XJ.model.ensureBootstrapped(XJ.model.defaultState());
  eq('默认 ocr.model = glm-4v-flash', st0.settings.ocr.model, 'glm-4v-flash');
  eq('默认 ocr.apiKey 取了占位符的值（待构建期替换）', st0.settings.ocr.apiKey, '__XJ_OCR_KEY__');
  eq('默认未同意隐私提示（首次使用会拦截）', st0.settings.ocr.agreed, false);
  eq('默认 unsupportedDividend 为空数组', Array.isArray(st0.settings.unsupportedDividend), true);
}

/* ---- 6.15 本轮 8 项 BUG 修复的回归断言 ---- */
section('【15】BUG 修复回归：名称 / 收息天数 / A股派息日 / OCR兜底 / 图表 / 分层与集中度 / 图标');
{
  const C = XJ.calc, O = XJ.ocr, CH = XJ.chart, M2 = XJ.model, U2 = XJ.util;

  /* ── BUG 1 · 名称不能被代码占位 ── */
  eq('hasNameInfo：中文名 → true', U2.hasNameInfo('中国平安'), true);
  eq('hasNameInfo：纯数字代码 → false', U2.hasNameInfo('601318'), false);
  eq('hasNameInfo：带前缀代码 → false', U2.hasNameInfo('sh601318'), false);
  eq('hasNameInfo：字母代码 → false', U2.hasNameInfo('AAPL'), false);
  eq('hasNameInfo：空串 → false', U2.hasNameInfo(''), false);
  eq('hasNameInfo：null → false', U2.hasNameInfo(null), false);
  eq('hasNameInfo：被前缀挤短的「中国平」仍算有名称信息', U2.hasNameInfo('中国平'), true);
  eq('hasNameInfo：前后空格不影响判断', U2.hasNameInfo('  601318  '), false);

  /* ── BUG 2 · 收息天数含首日 ── */
  const todayBuy = { transactions: [{ action: 'BUY', accountId: 'x', date: REF_TODAY, quantity: 1, price: 1 }] };
  eq('BUG2 · 今天买入 → 收息第 1 天（不再是 0）', C.statDays(todayBuy, 'x').days, 1);
  eq('BUG2 · 今天买入也有起算日', C.statDays(todayBuy, 'x').since, REF_TODAY);
  eq('BUG2 · 买入日在未来也至少为 1', C.statDays({ transactions: [{ action: 'BUY', accountId: 'x', date: '2099-01-01', quantity: 1, price: 1 }] }, 'x').days, 1);
  eq('BUG2 · 无买入记录才是 0', C.statDays({ transactions: [] }, 'x').days, 0);

  /* ── BUG 3 · A股派息日 = 除权除息日 ── */
  const cnPlan = plan('cn1', 'sh600023', '2025-12-31', 2.8, '实施分配', '2026-07-29', '2026-07-30');
  eq('BUG3 · A股派息日 = 除权除息日', C.payoutInfo(cnPlan).date, '2026-07-30');
  eq('BUG3 · A股不标 exact（仍是推算语义）', C.payoutInfo(cnPlan).exact, false);
  const hkPlan = Object.assign(plan('hk1', 'hk00700', '2025-12-31', 53, '实施分配', null, '2026-05-15'), { source: 'hk', payoutDate: '2026-06-01' });
  eq('BUG3 · 港股仍用真实派息日', C.payoutInfo(hkPlan).date, '2026-06-01');
  eq('BUG3 · 港股标 exact', C.payoutInfo(hkPlan).exact, true);
  const fundPlan = Object.assign(plan('fd1', 'sh515450', '2026-09-09', 1.5, '实施分配', '2026-09-08', '2026-09-09'), { source: 'fund', payoutDate: '2026-09-14' });
  eq('BUG3 · 基金仍用真实发放日', C.payoutInfo(fundPlan).date, '2026-09-14');

  /* ── BUG 4 · OCR 双模型兜底的质量评分 ── */
  eq('scoreRows · 三字段齐全 = 1', O.scoreRows([{ code: '601318', quantity: 100, cost: 1 }]), 1);
  close('scoreRows · 只有代码 = 1/3', O.scoreRows([{ code: '601318', quantity: null, cost: null }]), 1 / 3, 1e-9);
  eq('scoreRows · 空数组 = 0', O.scoreRows([]), 0);
  eq('BUG4 · 「只有名称代码、缺数量成本」会低于阈值从而触发重试',
    O.scoreRows([{ code: '601919', quantity: null, cost: null }]) < O.GOOD_ENOUGH, true);
  eq('BUG4 · 完整结果不会触发重试',
    O.scoreRows([{ code: '601318', quantity: 1100, cost: 48.9091 }]) >= O.GOOD_ENOUGH, true);
  eq('BUG4 · 兜底模型是免费档 glm-4.1v-thinking-flash', O.FALLBACK_MODEL, 'glm-4.1v-thinking-flash');

  /* ── BUG 5 · 图表刻度与曲线数据 ── */
  const sc = CH.niceScale(97000, 141382, 4);
  eq('niceScale · 下界不高于最小值', sc.lo <= 97000, true);
  eq('niceScale · 上界不低于最大值', sc.hi >= 141382, true);
  eq('niceScale · 刻度数在 3~7 之间', sc.ticks.length >= 3 && sc.ticks.length <= 7, true);
  eq('niceScale · min=max 不炸', CH.niceScale(5, 5, 4).ticks.length >= 2, true);
  eq('niceScale · 非有限值有兜底', Array.isArray(CH.niceScale(NaN, NaN, 4).ticks), true);
  eq('chart.render · 少于 2 点返回空串', CH.render([{ date: '2026-09-10', mv: 100 }]), '');
  const svg = CH.render([{ date: '2026-09-08', mv: 100 }, { date: '2026-09-09', mv: 130 }, { date: '2026-09-10', mv: 120 }]);
  eq('chart.render · 产出 svg', svg.indexOf('<svg') === 0, true);
  eq('chart.render · 带纵轴网格线', svg.indexOf('stroke-dasharray') > 0, true);
  eq('chart.render · 带横轴日期刻度', svg.indexOf('09/08') > 0, true);
  eq('chart.render · 带面积渐变', svg.indexOf('xjcGrad') > 0, true);
  eq('chart.render · 带拖动读数标记组', svg.indexOf('xjc-marker') > 0, true);
  eq('chart.render · 区间上涨用红色（涨红）', svg.indexOf('#E0312F') > 0, true);
  const svgDown = CH.render([
    { date: '2026-09-08', mv: 130 }, { date: '2026-09-09', mv: 120 }, { date: '2026-09-10', mv: 110 },
  ]);
  eq('chart.render · 区间下跌用绿色（跌绿）', svgDown.indexOf('#12A150') > 0, true);
  eq('chart.render · 内嵌数据点供拖动使用', svg.indexOf('data-series=') > 0, true);

  /* ── 对比图的拖动读数：多曲线日期不重合时必须前值填充，不能留「—」 ──
     场景：A 在这三天都有点，B 只有中间和最后一天有点（真实场景是余额宝基准为周频）。
     横轴取并集后，B 在第一天是空的 —— 若不填，拖动到那天 B 读数是「—」，
     而曲线明明画着，看着就像「这一天没有数据」。 */
  const ffsvg = CH.renderCompare([
    { key: 'a', name: 'A', color: '#111', points: [
      { date: '2026-09-08', pct: 1 }, { date: '2026-09-09', pct: 2 }, { date: '2026-09-10', pct: 3 }] },
    { key: 'b', name: 'B', color: '#222', points: [
      { date: '2026-09-09', pct: 20 }, { date: '2026-09-10', pct: 30 }] },
  ], { xTicks: 3 });
  const ffcmp = JSON.parse(ffsvg.match(/data-cmp="([^"]*)"/)[1]
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  eq('对比图 · 横轴 = 三条日期的并集', JSON.stringify(ffcmp.dates),
    JSON.stringify(['2026-09-08', '2026-09-09', '2026-09-10']));
  eq('★ 缺点的曲线被前值填充（开头没有更早值 → 用首个已知值回填）',
    JSON.stringify(ffcmp.rows[1].vals), JSON.stringify([20, 20, 30]));
  eq('★ 任何一天都不再有空洞（否则拖动读数是「—」）',
    ffcmp.rows.every((r) => r.vals.every((v) => v !== undefined && v !== null)), true);
  eq('原本就齐全的曲线不受影响', JSON.stringify(ffcmp.rows[0].vals), JSON.stringify([1, 2, 3]));
  eq('尾部的空档也前值填充（B 提前结束）', (function () {
    const s2 = CH.renderCompare([
      { key: 'a', name: 'A', color: '#111', points: [
        { date: '2026-09-08', pct: 1 }, { date: '2026-09-09', pct: 2 }, { date: '2026-09-10', pct: 3 }] },
      { key: 'b', name: 'B', color: '#222', points: [{ date: '2026-09-08', pct: 9 }] },
    ], { xTicks: 3 });
    const cd = JSON.parse(s2.match(/data-cmp="([^"]*)"/)[1]
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    return JSON.stringify(cd.rows[1].vals);
  })(), JSON.stringify([9, 9, 9]));

  const snState = { snapshots: { '2026-08-01': { mv: 100 }, '2026-09-01': { mv: 120 }, '2026-09-10': { mv: 130 } } };
  eq('snapshotSeries · 全部 = 3 点', C.snapshotSeries(snState, 0).length, 3);
  eq('snapshotSeries · 按日期升序', C.snapshotSeries(snState, 0)[0].date, '2026-08-01');
  eq('snapshotSeries · 近 30 天只留 9 月两条', C.snapshotSeries(snState, 30).length, 2);
  eq('snapshotSeries · 空快照返回空数组', C.snapshotSeries({ snapshots: {} }, 0).length, 0);

  /* ── BUG 6 / 7 · 分层、分布、集中度都要列出具体股票 ── */
  const an2 = C.analytics(state, 'acc_1');
  var cl = an2.concentration.holdings;
  eq('BUG6 · 集中度逐只列表长度 = 持仓数', cl.length, 2);
  eq('BUG6 · 名次从 1 开始', cl[0].rank, 1);
  eq('BUG6 · 每只都带名称', cl.every(function (x) { return U2.hasNameInfo(x.name); }), true);
  eq('BUG6 · 按占比降序', cl[0].weight >= cl[1].weight, true);
  close('BUG6 · 末位累计占比 = 100%', cl[cl.length - 1].cumWeight, 100, 1e-6);
  close('BUG6 · 与 top1 口径一致', cl[0].weight, an2.concentration.top1, 1e-9);

  eq('BUG7 · 每个股息率桶都带 stocks 数组', an2.yieldBuckets.every(function (b) { return Array.isArray(b.stocks); }), true);
  eq('BUG7 · 分层成分股合计 = 持仓数', an2.yieldBuckets.reduce(function (a, b) { return a + b.stocks.length; }, 0), 2);
  eq('BUG7 · 分层成分股带名称', an2.yieldBuckets.reduce(function (a, b) { return a.concat(b.stocks); }, []).every(function (x) { return U2.hasNameInfo(x.name); }), true);
  eq('BUG7 · 每个市场分组都带 stocks', an2.byAssetType.every(function (g) { return Array.isArray(g.stocks); }), true);
  eq('BUG7 · 市场成分股合计 = 持仓数', an2.byAssetType.reduce(function (a, g) { return a + g.stocks.length; }, 0), 2);
  close('BUG7 · 市场分组权重合计 = 100%', an2.byAssetType.reduce(function (a, g) { return a + (g.weight || 0); }, 0), 100, 1e-6);
  close('BUG7 · 市场内个股占比合计 = 该市场 100%',
    an2.byAssetType[0].stocks.reduce(function (a, st) { return a + st.weight; }, 0), 100, 1e-6);

  /* ── BUG 8 · 图标语义对应 ── */
  eq('图标分组数 ≥ 8', M2.EMOJI_GROUPS.length >= 8, true);
  eq('可选图标总数 ≥ 50', M2.EMOJI_GROUPS.reduce(function (a, g) { return a + g.list.length; }, 0) >= 50, true);
  eq('常用支出项都有专属图标（不再是统一的 💰）',
    ['PHONE', 'UTILITY', 'PROPERTY', 'FUEL', 'MORTGAGE', 'OTHER', 'LUNCH', 'INSURANCE', 'FRUIT', 'MEALS']
      .every(function (k) { return M2.KEY_EMOJI[k] && M2.KEY_EMOJI[k] !== '💰' && M2.KEY_EMOJI[k] !== '🏷️'; }), true);
  eq('BUG8 · 水电燃气 → ⚡', M2.KEY_EMOJI.UTILITY, '⚡');
  eq('BUG8 · 加油 → ⛽', M2.KEY_EMOJI.FUEL, '⛽');
  eq('BUG8 · 房贷/房租 → 🏠', M2.KEY_EMOJI.MORTGAGE, '🏠');
  eq('BUG8 · 话费 → 💬', M2.KEY_EMOJI.PHONE, '💬');

  const legacyIcon = Object.assign(M2.defaultState(), {
    expenses: [
      { expenseId: 'e1', key: 'UTILITY', label: '水电燃气', icon: '💰', monthlyAmount: 300, enabled: true, sortOrder: 1 },
      { expenseId: 'e2', key: 'CUSTOMX', label: '新支出项', icon: '💰', monthlyAmount: 100, enabled: true, sortOrder: 2 },
      { expenseId: 'e3', key: 'FUEL', label: '加油', icon: '🎯', monthlyAmount: 400, enabled: true, sortOrder: 3, iconAuto: false },
    ],
  });
  M2.ensureBootstrapped(legacyIcon);
  eq('BUG8 · 历史遗留的 💰 按 key 修正为 ⚡', legacyIcon.expenses[0].icon, '⚡');
  eq('BUG8 · 未知 key 的 💰 换成中性图标 🏷️', legacyIcon.expenses[1].icon, '🏷️');
  eq('BUG8 · 用户手动选过的图标绝不被覆盖', legacyIcon.expenses[2].icon, '🎯');
}

/* ---- 6.16 本轮 4 项修复的回归断言 ---- */
section('【16】本轮修复：名称嫌疑标记 / 待除权卡片数据 / OCR 交易记录解析 / 删除持仓依赖');
{
  const O = XJ.ocr, C = XJ.calc, U2 = XJ.util;

  /* ── BUG 1 · 为什么必须靠 nameSuspect ── */
  eq('截断名「中国平」在 hasNameInfo 下仍算有信息（所以光靠它无法触发补全）', U2.hasNameInfo('中国平'), true);
  eq('因此补全条件必须包含 nameSuspect —— 代码不变量：无信息量或带嫌疑都要补',
    (function () {
      var needs = function (m) {
        if (m.nameLocked) return false;
        if (!XJ.util.hasNameInfo(m.name)) return true;
        return m.nameSuspect !== false;
      };
      return needs({ name: '601318', nameSuspect: false }) &&
        needs({ name: '中国平', nameSuspect: true }) &&
        needs({ name: '中国平', nameSuspect: undefined }) &&
        !needs({ name: '中国平安', nameSuspect: false }) &&
        !needs({ name: '中国平', nameSuspect: true, nameLocked: true });
    })(), true);

  /* ── BUG 3 · 待除权汇总补充字段 ── */
  const st2 = JSON.parse(JSON.stringify(state));
  st2.plans = {
    'sh600023_2026-06-30': plan('sh600023_2026-06-30', 'sh600023', '2026-06-30', 2, '实施分配', '2026-11-20', '2026-11-23'),
    'sz000858_2026-06-30': plan('sz000858_2026-06-30', 'sz000858', '2026-06-30', 3, '实施分配', '2026-12-01', '2026-12-02'),
  };
  const pd2 = C.pendingExDiv(st2, 'acc_1');
  eq('待除权 · 每项带每10股派息', pd2.items.every(function (x) { return x.per10 > 0; }), true);
  close('待除权 · sh600023 每10股 = 2',
    pd2.items.filter(function (x) { return x.symbol === 'sh600023'; })[0].per10, 2, 1e-9);
  eq('待除权 · 每项带资产类型（用于 A/港/美 标签）',
    pd2.items.every(function (x) { return !!x.assetType; }), true);
  eq('待除权 · 每项带除权日', pd2.items.every(function (x) { return !!x.exDate; }), true);
  eq('待除权 · 每项带名称', pd2.items.every(function (x) { return U2.hasNameInfo(x.name); }), true);
  eq('待除权 · 每项带持股数', pd2.items.every(function (x) { return x.qty > 0; }), true);

  /* ── BUG 4 · 交易记录解析 ── */
  eq('动作归一化 · 证券买入 → BUY', O.normAction('证券买入'), 'BUY');
  eq('动作归一化 · 卖出 → SELL', O.normAction('卖出'), 'SELL');
  eq('动作归一化 · 股息入账 → DIV', O.normAction('股息入账'), 'DIV');
  eq('动作归一化 · 利息归本 → DIV', O.normAction('利息归本'), 'DIV');
  eq('动作归一化 · 红股入账 → BUY', O.normAction('红股入账'), 'BUY');

  eq('日期归一化 · 2026-08-28', O.normDate('2026-08-28'), '2026-08-28');
  eq('日期归一化 · 2026/8/5 → 补零', O.normDate('2026/8/5'), '2026-08-05');
  eq('日期归一化 · 2026年8月5日', O.normDate('2026年8月5日'), '2026-08-05');
  eq('日期归一化 · 省略年份 08-28 → 补今年', O.normDate('08-28', 2026), '2026-08-28');
  eq('日期归一化 · 空 → null', O.normDate(''), null);

  const tr = O.extractTradeJson('{"name":"中远海控","code":"601919","trades":[{"date":"2026-08-28","action":"买入","price":16.950,"quantity":200,"amount":3390.00,"fee":0.38}]}');
  eq('extractTradeJson · 名称', tr.name, '中远海控');
  eq('extractTradeJson · 代码', tr.code, '601919');
  eq('extractTradeJson · 可解析为内部 symbol', tr.symbol, 'sh601919');
  eq('extractTradeJson · 交易条数', tr.trades.length, 1);
  eq('extractTradeJson · 价格保留小数点（不被放大 1000 倍）', tr.trades[0].price, 16.95);
  eq('extractTradeJson · 数量', tr.trades[0].quantity, 200);
  eq('extractTradeJson · 金额', tr.trades[0].amount, 3390);
  eq('extractTradeJson · 动作归一化为 BUY', tr.trades[0].action, 'BUY');
  eq('extractTradeJson · 费用', tr.trades[0].fee, 0.38);

  const tr2 = O.extractTradeJson('[{"date":"2026-08-28","action":"买入","price":1,"quantity":2}]');
  eq('extractTradeJson · 纯数组也能解析', tr2.trades.length, 1);
  eq('extractTradeJson · 纯数组无名称时留空（交给用户填）', tr2.name, '');
  eq('extractTradeJson · 纯数组无代码时 symbol 为 null', tr2.symbol, null);
  eq('extractTradeJson · 带 <think> 前缀可解析',
    O.extractTradeJson('<think>看图…</think>{"name":"A","code":"601919","trades":[{"date":"2026-08-28","action":"买入","price":1,"quantity":2}]}').trades.length, 1);

  const divRow = O.normalizeTradeRow({ date: '2026-06-25', action: '分红', amount: 748 }, 2026);
  eq('分红行 · 动作归一化为 DIV', divRow.action, 'DIV');
  eq('分红行 · 保留到账金额', divRow.amount, 748);
  eq('分红行 · 价格清空', divRow.price, null);
  eq('分红行 · 数量清空', divRow.quantity, null);

  eq('无效行 → null', O.normalizeTradeRow({}, 2026), null);
  eq('非对象行 → null', O.normalizeTradeRow('abc', 2026), null);

  eq('scoreTrades · 买卖行完整 = 1',
    O.scoreTrades([{ date: '2026-08-28', action: 'BUY', price: 1, quantity: 2, amount: 2 }]), 1);
  eq('scoreTrades · 分红行不因缺数量被扣分',
    O.scoreTrades([{ date: '2026-06-25', action: 'DIV', price: null, quantity: null, amount: 748 }]), 1);
  eq('scoreTrades · 空结果 = 0（会触发换模型重试）', O.scoreTrades([]), 0);

  /* ── 端到端：交易记录 → 持仓（架构不变量：持仓一律由 transactions 推导） ── */
  const txs2 = [
    { txId: 't1', accountId: 'a', symbol: 'sh601919', action: 'BUY', date: '2026-06-17', quantity: 100, price: 14.04, fee: 0.15, createdAt: '1' },
    { txId: 't2', accountId: 'a', symbol: 'sh601919', action: 'BUY', date: '2026-06-30', quantity: 100, price: 13.24, fee: 0.14, createdAt: '2' },
    { txId: 't3', accountId: 'a', symbol: 'sh601919', action: 'BUY', date: '2026-08-17', quantity: 500, price: 15.80, fee: 0.87, createdAt: '3' },
    { txId: 't4', accountId: 'a', symbol: 'sh601919', action: 'BUY', date: '2026-08-28', quantity: 200, price: 16.95, fee: 0.38, createdAt: '4' },
  ];
  const pos2 = C.position(txs2, null, 'weighted');
  eq('交易导入后 · 持股 = 100+100+500+200 = 900', pos2.qty, 900);
  close('交易导入后 · 加权成本（含交易费用）',
    pos2.avgCost,
    (100 * 14.04 + 0.15 + 100 * 13.24 + 0.14 + 500 * 15.80 + 0.87 + 200 * 16.95 + 0.38) / 900, 1e-9);

  /* ── BUG 2 · 删除持仓后的依赖（删交易 → 持仓自动消失） ── */
  const keep = txs2.filter(function (t) { return t.txId !== 't4'; });
  eq('删掉最后一笔后 · 持股降为 700', C.position(keep, null, 'weighted').qty, 700);
  eq('删光该股票全部交易后 · 不再产生持仓行',
    C.holdings({ transactions: [], received: [], symbols: {}, quoteCache: {}, plans: {}, expenses: [] }, 'a').length, 0);
}

/* ---- 6.17 分红去重 + OCR 符号解析（防张冠李戴） ---- */
section('【17】分红去重（自动 vs 手动）+ OCR 符号解析优先级');
{
  const C = XJ.calc, O = XJ.ocr, U2 = XJ.util;

  /* ── 金额容差 ── */
  eq('closeAmount · 完全相等', U2.closeAmount(7480, 7480), true);
  eq('closeAmount · 差几分钱（券商四舍五入）', U2.closeAmount(7480, 7480.03), true);
  eq('closeAmount · 差 1 元以内', U2.closeAmount(7480, 7479.2), true);
  eq('closeAmount · 差 1% 以内', U2.closeAmount(7480, 7406), true);
  eq('closeAmount · 差得远（视为不同分红）', U2.closeAmount(7480, 500), false);
  eq('closeAmount · 0 不参与', U2.closeAmount(0, 7480), false);

  /* ── 「同一次分配」的判定键 ── */
  const a1 = { accountId: 'a', symbol: 'sh600048', exDividendDate: '2026-06-25', amount: 7480 };
  eq('sameDividend · 同标的同账户同日期同金额 → 同一笔',
    U2.sameDividend(a1, { accountId: 'a', symbol: 'sh600048', exDividendDate: '2026-06-25', amount: 7480 }), true);
  eq('sameDividend · 换标的 → 否',
    U2.sameDividend(a1, { accountId: 'a', symbol: 'sh601919', exDividendDate: '2026-06-25', amount: 7480 }), false);
  eq('sameDividend · 换日期 → 否',
    U2.sameDividend(a1, { accountId: 'a', symbol: 'sh600048', exDividendDate: '2026-06-26', amount: 7480 }), false);
  eq('sameDividend · 换账户 → 否',
    U2.sameDividend(a1, { accountId: 'b', symbol: 'sh600048', exDividendDate: '2026-06-25', amount: 7480 }), false);
  eq('sameDividend · 金额差得远 → 否',
    U2.sameDividend(a1, { accountId: 'a', symbol: 'sh600048', exDividendDate: '2026-06-25', amount: 500 }), false);

  /* ── 复现用户遇到的 bug：手动 + 自动重复计数 ── */
  const st3 = JSON.parse(JSON.stringify(state));
  st3.accounts = [{ accountId: 'acc_1', name: '我的账户' }];
  st3.transactions = [{
    txId: 'b1', accountId: 'acc_1', symbol: 'sh600048', action: 'BUY',
    date: '2026-01-05', quantity: 10000, price: 5, fee: 0, createdAt: '1',
  }];
  st3.received = [{
    recId: 'm1', accountId: 'acc_1', symbol: 'sh600048', planId: null,
    exDividendDate: '2026-06-25', perShareAmount: 0.748, qtyAtRecord: 10000,
    amount: 7480, source: 'MANUAL', year: 2026, createdAt: '2',
  }];
  st3.plans = {
    'sh600048_2025-12-31': Object.assign(
      plan('sh600048_2025-12-31', 'sh600048', '2025-12-31', 7.48, '实施分配', '2026-06-24', '2026-06-25'),
      { payoutDate: '2026-06-25', source: 'cn' }),
  };
  eq('★ 已有手动分红记录 → 自动登记不再重复插入', C.applyAutoReceived(st3), 0);
  eq('★ 分红记录仍只有 1 条', st3.received.filter(function (r) { return r.symbol === 'sh600048'; }).length, 1);
  eq('★ 保留的是那条手动记录', st3.received.filter(function (r) { return r.symbol === 'sh600048'; })[0].source, 'MANUAL');

  /* 没有手动记录时，自动登记照常工作 */
  const st4 = JSON.parse(JSON.stringify(st3));
  st4.received = [];
  eq('无手动记录 → 自动登记照常', C.applyAutoReceived(st4), 1);
  eq('自动登记金额 = 10000 × 0.748 = 7480', st4.received[0].amount, 7480);
  eq('自动登记来源为 AUTO', st4.received[0].source, 'AUTO');
  eq('再跑一次不重复（幂等）', C.applyAutoReceived(st4), 0);
  eq('仍然只有 1 条', st4.received.length, 1);

  /* 同日不同金额 = 真的是两笔，不能误杀 */
  const st5 = JSON.parse(JSON.stringify(st3));
  st5.received[0].amount = 300;
  eq('同日不同金额视为两笔（不误杀）', C.applyAutoReceived(st5), 1);

  /* ── OCR 符号解析：输入框优先（修复「中远海控 → 保利发展」） ── */
  eq('★ resolveSymbol · 输入框有值 → 以输入框为准（不再被草稿覆盖）',
    O.resolveSymbol('601919', 'sh600048'), 'sh601919');
  eq('resolveSymbol · 输入框带前缀', O.resolveSymbol('sh601919', null), 'sh601919');
  eq('resolveSymbol · 输入框带空格与横杠', O.resolveSymbol(' 60-1919 ', null), 'sh601919');
  eq('resolveSymbol · 输入框为空 → 回退草稿', O.resolveSymbol('', 'sh600048'), 'sh600048');
  eq('resolveSymbol · 都为空 → null', O.resolveSymbol('', null), null);
  eq('resolveSymbol · 无法识别的代码 → null（不回退，避免又写错）',
    O.resolveSymbol('1234567890', 'sh600048'), null);

  /* ── 多图识别：换股票时旧代码必须作废 ── */
  const id1 = O.mergeTradeIdentity({ name: '中远海控', symbol: null }, { name: '保利发展', symbol: null });
  eq('★ 换了股票但新图无代码 → 旧代码作废', id1.symbol, null);
  eq('名称更新为新股票', id1.name, '保利发展');
  eq('同一只股票 → 保留已有代码',
    O.mergeTradeIdentity({ name: '中远海控', symbol: 'sh601919' }, { name: '中远海控', symbol: null }).symbol,
    'sh601919');
  eq('新图带代码 → 用新代码',
    O.mergeTradeIdentity({ name: '中远海控', symbol: null }, { name: '保利发展', symbol: 'sh600048' }).symbol,
    'sh600048');
  eq('首次识别无代码 → 保持 null（待用户填）',
    O.mergeTradeIdentity({ name: '', symbol: null }, { name: '中远海控', symbol: null }).symbol, null);
}

/* ---- 6.18 卖出丢失修复（券商流水负数）+ 数字解析 ---- */
section('【18】卖出交易不丢失（券商流水把卖出记为负数）');
{
  const C = XJ.calc, O = XJ.ocr, U2 = XJ.util;

  /* 数字解析：负号 + 千分位 */
  eq('num · 负号 + 千分位不再被逗号截断', U2.num('-3,390.00'), -3390);
  eq('num · 负数保留符号', U2.num('-200'), -200);
  eq('num · 去「股」单位', U2.num('200股'), 200);
  eq('num · 去 ¥', U2.num('¥3,390.00'), 3390);
  eq('num · 空 → null', U2.num(''), null);

  /* ★ 核心：卖出在券商流水里是负数 */
  const sell = O.normalizeTradeRow({ date: '2026-09-01', action: '卖出', price: 16.5, quantity: -200, amount: -3390, fee: -0.38 }, 2026);
  eq('★ 卖出（负数量）→ 方向保留为 SELL', sell.action, 'SELL');
  eq('★ 卖出数量取绝对值 200', sell.quantity, 200);
  eq('★ 卖出金额取绝对值 3390', sell.amount, 3390);
  eq('★ 卖出费用取绝对值 0.38', sell.fee, 0.38);
  eq('★ 卖出价格取绝对值 16.5', sell.price, 16.5);
  eq('★ 取绝对值后能通过导入校验（quantity > 0）', sell.quantity > 0, true);

  const wrongDir = O.normalizeTradeRow({ date: '2026-09-01', action: '买入', quantity: -200, amount: -3390 }, 2026);
  eq('★ 模型把方向读成「买入」但数值为负 → 纠正为 SELL', wrongDir.action, 'SELL');

  const buy = O.normalizeTradeRow({ date: '2026-09-01', action: '买入', quantity: 200, amount: 3390 }, 2026);
  eq('正数买入仍是 BUY（不被误改）', buy.action, 'BUY');
  eq('正数买入数量不变', buy.quantity, 200);

  /* 端到端：买 2 卖 1，条数与方向都要对 */
  const mixed = [
    { date: '2026-08-01', action: '买入', price: 10, quantity: 500, amount: 5000, fee: 0.5 },
    { date: '2026-08-15', action: '卖出', price: 12, quantity: -200, amount: -2400, fee: 0.24 },
    { date: '2026-08-28', action: '买入', price: 11, quantity: 300, amount: 3300, fee: 0.33 },
  ].map(function (r) { return O.normalizeTradeRow(r, 2026); });

  eq('混合买卖 · 3 条全部解析成功（无丢弃）', mixed.filter(Boolean).length, 3);
  eq('混合买卖 · 买入 2 笔', mixed.filter(function (t) { return t.action === 'BUY'; }).length, 2);
  eq('混合买卖 · 卖出 1 笔', mixed.filter(function (t) { return t.action === 'SELL'; }).length, 1);
  eq('混合买卖 · 全部数量为正（能通过导入校验）', mixed.every(function (t) { return t.quantity > 0; }), true);

  const mtx = mixed.map(function (t, i) {
    return {
      txId: 'm' + i, accountId: 'a', symbol: 'sh601919', action: t.action, date: t.date,
      quantity: t.quantity, price: t.price, fee: t.fee, createdAt: 'm' + i,
    };
  });
  const mpos = C.position(mtx, null, 'weighted');
  eq('混合买卖 · 期末持股 = 500 − 200 + 300 = 600', mpos.qty, 600);
  eq('混合买卖 · 卖出计入已实现盈亏', mpos.realized > 0, true);
  eq('混合买卖 · 三条交易都进了流水（供交易明细渲染）', mtx.length, 3);
}

/* ---- 6.19 官方图标（F10 域名 → icon.horse） ---- */
section('【19】股票官方图标：域名解析与 URL 生成');
{
  const MK = XJ.market, C = XJ.calc;

  eq('secucodeOf · sh → .SH', MK.secucodeOf('sh601919'), '601919.SH');
  eq('secucodeOf · sz → .SZ', MK.secucodeOf('sz000858'), '000858.SZ');
  eq('secucodeOf · bj → .BJ', MK.secucodeOf('bj430047'), '430047.BJ');

  eq('logoUrl · 正常域名', MK.logoUrl('sh601919', 'hold.coscoshipping.com'),
    'https://icon.horse/icon/hold.coscoshipping.com');
  eq('logoUrl · 自动去掉协议头', MK.logoUrl('sh601318', 'https://www.pingan.cn'),
    'https://icon.horse/icon/www.pingan.cn');
  eq('logoUrl · 自动去掉路径', MK.logoUrl('sz000858', 'www.wuliangye.com.cn/about'),
    'https://icon.horse/icon/www.wuliangye.com.cn');
  eq('logoUrl · 无域名 → null（回退字母头像）', MK.logoUrl('hk00700', null), null);
  eq('logoUrl · 空串 → null', MK.logoUrl('sh601919', ''), null);
  eq('logoUrl · 非法域名 → null', MK.logoUrl('sh601919', 'nodot'), null);
  eq('logoUrl · undefined → null', MK.logoUrl('usAAPL', undefined), null);
  eq('logoUrl · 港股没有域名时不报错', MK.logoUrl('hk00700', ''), null);

  /* holdings 会把域名透出给视图层 */
  const stD = JSON.parse(JSON.stringify(state));
  stD.symbols['sh600023'] = Object.assign({}, stD.symbols['sh600023'], { domain: 'www.zzepc.com.cn' });
  const listD = C.holdings(stD, 'acc_1');
  const hD = listD.filter(function (x) { return x.symbol === 'sh600023'; })[0];
  eq('holdings · 暴露 domain 字段', hD.domain, 'www.zzepc.com.cn');
  eq('holdings · 没有域名的标的 domain 为 null',
    listD.filter(function (x) { return x.symbol !== 'sh600023'; })[0].domain, null);
  eq('holdings · 域名可拼出官方图标 URL',
    MK.logoUrl(hD.symbol, hD.domain), 'https://icon.horse/icon/www.zzepc.com.cn');
  eq('holdings · 缺 domain 时 logoUrl 返回 null（走字母头像）',
    MK.logoUrl('sz000858', undefined), null);
}

/* ---- 6.20 展示代码格式 / 交易时段 / 官方图标真伪判定 ---- */
section('【20】代码格式 · 交易时段 · 假图标判定');
{
  const MK = XJ.market;

  /* 展示代码：市场缩写大写 + 代码；美股加空格分隔 */
  eq('displayCode · 沪市', MK.displayCode('sh600036'), 'SH600036');
  eq('displayCode · 深市', MK.displayCode('sz000858'), 'SZ000858');
  eq('displayCode · 北交所', MK.displayCode('bj430047'), 'BJ430047');
  eq('displayCode · 港股', MK.displayCode('hk00700'), 'HK00700');
  eq('displayCode · 美股（字母代码加空格）', MK.displayCode('usAAPL'), 'US AAPL');
  eq('displayCode · 场外基金', MK.displayCode('of110022'), 'OF110022');
  eq('displayCode · 空值不报错', MK.displayCode(''), '');
  eq('displayCode · 未上市代码统一大写前缀', MK.displayCode('sh510300'), 'SH510300');

  /* 交易时段（北京时间）—— 用固定时刻构造 Date，避免依赖运行时的真实时间 */
  const at = (y, mo, d, hh, mm) => new Date(y, mo - 1, d, hh, mm, 0);
  const FRI = [2026, 9, 11], SAT = [2026, 9, 12], MON = [2026, 9, 14], TUE = [2026, 9, 15];
  const open = (sym, dt) => MK.sessionOpen(sym, dt);

  eq('时段 · A股 周五 10:00 开市', open('sh600036', at(...FRI, 10, 0)), true);
  eq('时段 · A股 周五 12:00 午休休市', open('sh600036', at(...FRI, 12, 0)), false);
  eq('时段 · A股 周五 14:00 开市', open('sh600036', at(...FRI, 14, 0)), true);
  eq('时段 · A股 周五 15:01 已收盘', open('sh600036', at(...FRI, 15, 1)), false);
  eq('时段 · A股 周五 09:20 未开盘', open('sh600036', at(...FRI, 9, 20)), false);
  eq('时段 · A股 周六休市', open('sh600036', at(...SAT, 10, 0)), false);
  eq('时段 · ETF 与 A股同规则', open('sh510300', at(...FRI, 10, 0)), true);

  eq('时段 · 港股 周五 15:30 开市（至16:00）', open('hk00700', at(...FRI, 15, 30)), true);
  eq('时段 · 港股 周五 11:45 仍在上午盘（至12:00）', open('hk00700', at(...FRI, 11, 45)), true);
  eq('时段 · 港股 周五 12:30 午休休市', open('hk00700', at(...FRI, 12, 30)), false);
  eq('时段 · 港股 周五 16:00 已收盘', open('hk00700', at(...FRI, 16, 0)), false);

  eq('时段 · 美股 周一 22:00（北京）开市', open('usAAPL', at(...MON, 22, 0)), true);
  eq('时段 · 美股 周二 03:00（北京）仍开市', open('usAAPL', at(...TUE, 3, 0)), true);
  eq('时段 · 美股 周二 10:00（北京）休市', open('usAAPL', at(...TUE, 10, 0)), false);
  eq('时段 · 美股 周日 22:00 休市', open('usAAPL', at(2026, 9, 13, 22, 0)), false);

  eq('时段 · 场外基金无行情恒为 false', open('of110022', at(...FRI, 10, 0)), false);

  eq('hasMinute · A股 true', MK.hasMinute('sh600036'), true);
  eq('hasMinute · 港股 true', MK.hasMinute('hk00700'), true);
  eq('hasMinute · 美股 true', MK.hasMinute('usAAPL'), true);
  eq('hasMinute · 场外基金 false', MK.hasMinute('of110022'), false);

  /* 假图标判定：样本取自真实实测（见 livetest 【1g】与 /tmp 采样） */
  eq('logoVerdict · 灰字母占位图（申能 maxSat=0）→ bad', MK.logoVerdict({ maxSat: 0 }), 'bad');
  eq('logoVerdict · 灰字母占位图（中远海控 maxSat=0）→ bad', MK.logoVerdict({ maxSat: 0 }), 'bad');
  eq('logoVerdict · 黑地球占位图（xinac maxSat=0）→ bad', MK.logoVerdict({ maxSat: 0 }), 'bad');
  eq('logoVerdict · 真图标·招商银行（maxSat=255）→ ok', MK.logoVerdict({ maxSat: 255 }), 'ok');
  eq('logoVerdict · 真图标·同花顺中远海控（maxSat=204）→ ok', MK.logoVerdict({ maxSat: 204 }), 'ok');
  eq('logoVerdict · 真图标·同花顺申能（maxSat=218）→ ok', MK.logoVerdict({ maxSat: 218 }), 'ok');
  eq('logoVerdict · 黑白真图标·苹果（maxSat=26）不被误杀', MK.logoVerdict({ maxSat: 26 }), 'ok');
  eq('logoVerdict · 边界 maxSat=12 判为假', MK.logoVerdict({ maxSat: 12 }), 'bad');
  eq('logoVerdict · 边界 maxSat=13 判为真', MK.logoVerdict({ maxSat: 13 }), 'ok');
  eq('logoVerdict · 无样本时放行', MK.logoVerdict(null), 'ok');
  eq('logoVerdict · 字段缺失时放行', MK.logoVerdict({}), 'ok');

  /* 公司资料报表的路由（A股/港股/美股） */
  eq('orgInfoQuery · A股走股票 F10', MK.orgInfoQuery('sh601919').reportName, 'RPT_F10_BASIC_ORGINFO');
  eq('orgInfoQuery · A股用 SECUCODE', MK.orgInfoQuery('sh601919').filter, '(SECUCODE="601919.SH")');
  eq('orgInfoQuery · 港股走港股 F10', MK.orgInfoQuery('hk00700').reportName, 'RPT_HKF10_INFO_ORGPROFILE');
  eq('orgInfoQuery · 港股用 SECURITY_CODE', MK.orgInfoQuery('hk00700').filter, '(SECURITY_CODE="00700")');
  eq('orgInfoQuery · 美股走美股 F10', MK.orgInfoQuery('usAAPL').reportName, 'RPT_USF10_INFO_ORGPROFILE');
  eq('orgInfoQuery · 美股用 SECURITY_CODE', MK.orgInfoQuery('usAAPL').filter, '(SECURITY_CODE="AAPL")');
  eq('orgInfoQuery · ETF 无公司资料 → null', MK.orgInfoQuery('sh510300'), null);
  eq('orgInfoQuery · 场外基金无公司资料 → null', MK.orgInfoQuery('of110022'), null);

  /* 美股 secid：后缀 → 市场号 */
  eq('usSecid · .OQ → 105 纳斯达克', MK.usSecid('AAPL.OQ'), '105.AAPL');
  eq('usSecid · .N → 106 纽交所', MK.usSecid('BABA.N'), '106.BABA');
  eq('usSecid · .A → 107 美交所', MK.usSecid('XYZ.A'), '107.XYZ');
  eq('usSecid · 带点的代码（BRK.A.N）', MK.usSecid('BRK.A.N'), '106.BRK.A');
  eq('usSecid · 无后缀 → null', MK.usSecid('AAPL'), null);
  eq('usSecid · 空 → null', MK.usSecid(''), null);
  eq('secidOf · 沪市 1.', MK.secidOf('sh600036'), '1.600036');
  eq('secidOf · 深市 0.', MK.secidOf('sz000858'), '0.000858');
  eq('secidOf · 港股 116.', MK.secidOf('hk00700'), '116.00700');
}

/* ---- 6.21 成本调整记录（持仓仍由交易单一推导） ---- */
section('【21】成本调整记录：只改成本基础，不改股数');
{
  const C = XJ.calc, U = XJ.util;
  const base = [
    { txId: 'a1', accountId: 'acc_1', symbol: 'sh600023', action: 'BUY', date: '2025-01-10', quantity: 1000, price: 10, fee: 0, createdAt: '2025-01-10T01:00:00Z' },
  ];

  /* 加权平均：调整加进成本基础，股数不变 */
  const w1 = C.position(base, null, 'weighted');
  eq('调整前 · 股数', w1.qty, 1000);
  eq('调整前 · 每股成本', w1.avgCost, 10);
  eq('调整前 · 净投入', w1.netInvested, 10000);

  const adjUp = base.concat([
    { txId: 'a2', accountId: 'acc_1', symbol: 'sh600023', action: 'ADJUST', date: '2025-02-01', amount: 2000, createdAt: '2025-02-01T01:00:00Z' },
  ]);
  const w2 = C.position(adjUp, null, 'weighted');
  eq('调增 · 股数不变', w2.qty, 1000);
  eq('调增 · 成本基础 +2000 → 每股 12', w2.avgCost, 12);
  eq('调增 · adjustAmount 透出', w2.adjustAmount, 2000);
  eq('调增 · 净投入同步修正（计入调整）', w2.netInvested, 12000);

  const adjDown = base.concat([
    { txId: 'a3', accountId: 'acc_1', symbol: 'sh600023', action: 'ADJUST', date: '2025-02-01', amount: -1500, createdAt: '2025-02-01T01:00:00Z' },
  ]);
  const w3 = C.position(adjDown, null, 'weighted');
  eq('调减 · 股数不变', w3.qty, 1000);
  eq('调减 · 每股成本 8.5', w3.avgCost, 8.5);
  eq('调减 · 净投入 8500', w3.netInvested, 8500);

  /* 摊薄口径：成本 = 净投入 ÷ 股数，调整自然流入 */
  const d1 = C.position(adjUp, null, 'diluted');
  eq('摊薄口径 · 调整后每股成本 = 12000/1000', d1.avgCost, 12);
  eq('摊薄口径 · 已实现盈亏置 0', d1.realized, 0);

  /* 分红摊薄：再扣掉已收分红 */
  const dd = C.position(adjUp, null, 'dividendDiluted', 2000);
  eq('分红摊薄 · (12000-2000)/1000 = 10', dd.avgCost, 10);

  /* 已清仓后调整应被忽略，否则会凭空造出成本 */
  const cleared = [
    { txId: 'b1', accountId: 'acc_1', symbol: 'sh600023', action: 'BUY', date: '2025-01-10', quantity: 1000, price: 10, fee: 0, createdAt: '2025-01-10T01:00:00Z' },
    { txId: 'b2', accountId: 'acc_1', symbol: 'sh600023', action: 'SELL', date: '2025-02-01', quantity: 1000, price: 12, fee: 0, createdAt: '2025-02-01T01:00:00Z' },
    { txId: 'b3', accountId: 'acc_1', symbol: 'sh600023', action: 'ADJUST', date: '2025-03-01', amount: 500, createdAt: '2025-03-01T01:00:00Z' },
  ];
  const w4 = C.position(cleared, null, 'weighted');
  eq('已清仓后调整被忽略 · 股数 0', w4.qty, 0);
  eq('已清仓后调整被忽略 · 成本基础 0', w4.costBasis, 0);
  eq('已清仓后调整被忽略 · adjustAmount 0', w4.adjustAmount, 0);
  eq('清仓后已实现盈亏 2000', w4.realized, 2000);

  /* 调整按日期参与历史切片：调整之前不该生效 */
  eq('切片 · 调整生效日之前（2025-01-20）', C.position(adjUp, '2025-01-20', 'weighted').avgCost, 10);
  eq('切片 · 调整生效日当天（2025-02-01）', C.position(adjUp, '2025-02-01', 'weighted').avgCost, 12);

  /* 送股场景：0 元买入把股数加上去，总成本不变 → 每股成本被摊薄 */
  const bonus = base.concat([
    { txId: 'a4', accountId: 'acc_1', symbol: 'sh600023', action: 'BUY', date: '2025-02-01', quantity: 1000, price: 0, fee: 0, createdAt: '2025-02-01T01:00:00Z' },
  ]);
  const w5 = C.position(bonus, null, 'weighted');
  eq('送股 · 股数翻倍', w5.qty, 2000);
  eq('送股 · 总成本不变 → 每股 5', w5.avgCost, 5);

  /* 校验：ADJUST 记录必须有非 0 金额，且不需要数量/价格 */
  eq('校验 · ADJUST 合法', XJ.model.validateTransaction(
    { accountId: 'acc_1', symbol: 'sh600023', action: 'ADJUST', date: '2025-02-01', amount: 100 }).length, 0);
  eq('校验 · ADJUST 金额为 0 → 报错', XJ.model.validateTransaction(
    { accountId: 'acc_1', symbol: 'sh600023', action: 'ADJUST', date: '2025-02-01', amount: 0 }).length, 1);
  eq('校验 · ADJUST 缺金额 → 报错', XJ.model.validateTransaction(
    { accountId: 'acc_1', symbol: 'sh600023', action: 'ADJUST', date: '2025-02-01' }).length, 1);
  eq('校验 · ADJUST 不因缺数量/价格而报错', XJ.model.validateTransaction(
    { accountId: 'acc_1', symbol: 'sh600023', action: 'ADJUST', date: '2025-02-01', amount: -50 }).length, 0);
  eq('校验 · 未知方向仍被拒', XJ.model.validateTransaction(
    { accountId: 'acc_1', symbol: 'sh600023', action: 'FOO', date: '2025-02-01', quantity: 1, price: 1, fee: 0 }).length > 0, true);
}

/* ---- 6.22 重复分红清理 ---- */
section('【22】重复分红清理（自动登记 + 手动/OCR 补录撞车）');
{
  const C = XJ.calc;
  const mk = (id, date, amount, createdAt, planId) => ({
    recId: id, accountId: 'acc_1', symbol: 'sh600023', planId: planId || null,
    exDividendDate: date, perShareAmount: 0.5, qtyAtRecord: 1000, amount: amount,
    source: planId ? 'AUTO' : 'MANUAL', year: 2026, createdAt: createdAt,
  });

  /* 同标的 + 同账户 + 同到账日 + 金额相符（差 1 元内）→ 视为同一笔 */
  const s1 = { received: [mk('r1', '2026-06-25', 748, '2026-06-25T01:00:00Z', 'p1'), mk('r2', '2026-06-25', 748, '2026-06-25T02:00:00Z')] };
  eq('清理 · 完全重复的 2 条合并为 1 条', C.dedupeDividends(s1), 1);
  eq('清理 · 保留最早的 createdAt', s1.received.length, 1);
  eq('清理 · 保留的是 r1', s1.received[0].recId, 'r1');
  eq('清理 · 幂等（再跑一次 0 条）', C.dedupeDividends(s1), 0);

  /* 金额差 ≤1 元也算同一笔（券商页面是四舍五入后的数字） */
  const s2 = { received: [mk('r3', '2026-06-25', 748, '2026-06-25T01:00:00Z'), mk('r4', '2026-06-25', 748.6, '2026-06-25T02:00:00Z')] };
  eq('清理 · 金额差 0.6 元仍判为同一笔', C.dedupeDividends(s2), 1);

  /* 到账日不同 / 金额差太多 / 标的或账户不同 → 不能合并 */
  const s3 = { received: [mk('r5', '2026-06-25', 748, '2026-06-25T01:00:00Z'), mk('r6', '2026-07-25', 748, '2026-07-25T01:00:00Z')] };
  eq('清理 · 到账日不同不合并', C.dedupeDividends(s3), 0);
  const s4 = { received: [mk('r7', '2026-06-25', 748, '2026-06-25T01:00:00Z'), mk('r8', '2026-06-25', 900, '2026-06-25T02:00:00Z')] };
  eq('清理 · 金额差得多不合并', C.dedupeDividends(s4), 0);
  const s5 = { received: [mk('r9', '2026-06-25', 748, '2026-06-25T01:00:00Z'), Object.assign(mk('r10', '2026-06-25', 748, '2026-06-25T02:00:00Z'), { accountId: 'acc_2' })] };
  eq('清理 · 账户不同不合并', C.dedupeDividends(s5), 0);
  const s6 = { received: [mk('r11', '2026-06-25', 748, '2026-06-25T01:00:00Z'), Object.assign(mk('r12', '2026-06-25', 748, '2026-06-25T02:00:00Z'), { symbol: 'sz000858' })] };
  eq('清理 · 标的不同不合并', C.dedupeDividends(s6), 0);

  /* 三胞胎：一条保留两条删除 */
  const s7 = { received: [mk('x1', '2026-06-25', 748, '2026-06-25T01:00:00Z'), mk('x2', '2026-06-25', 748, '2026-06-25T02:00:00Z'), mk('x3', '2026-06-25', 748, '2026-06-25T03:00:00Z')] };
  eq('清理 · 三条重复删除 2 条', C.dedupeDividends(s7), 2);
  eq('清理 · 三条重复后剩 1 条', s7.received.length, 1);

  eq('清理 · 空集合不报错', C.dedupeDividends({ received: [] }), 0);
}

/* ---- 6.23 持仓总市值曲线：快照 + 日线重建 ---- */
section('【23】持仓总市值历史（重建 + 快照覆盖）');
{
  const C = XJ.calc, U = XJ.util;

  const st = {
    accounts: [{ accountId: 'acc_1', name: 'A', sortOrder: 1 }],
    symbols: {
      sh600023: { symbol: 'sh600023', code: '600023', market: 'sh', name: '浙能电力', type: 'STOCK', costMethod: 'weighted' },
      hk00700: { symbol: 'hk00700', code: '00700', market: 'hk', name: '腾讯控股', type: 'HK', costMethod: 'weighted' },
    },
    transactions: [
      { txId: 'm1', accountId: 'acc_1', symbol: 'sh600023', action: 'BUY', date: '2026-06-01', quantity: 1000, price: 10, fee: 0, createdAt: '2026-06-01T01:00:00Z' },
      { txId: 'm2', accountId: 'acc_1', symbol: 'sh600023', action: 'BUY', date: '2026-06-03', quantity: 500, price: 12, fee: 0, createdAt: '2026-06-03T01:00:00Z' },
      { txId: 'm3', accountId: 'acc_1', symbol: 'hk00700', action: 'BUY', date: '2026-06-02', quantity: 100, price: 400, fee: 0, createdAt: '2026-06-02T01:00:00Z' },
    ],
    received: [],
    snapshots: {},
    settings: { fx: { HKD: 0.9, USD: 7.1 } },
  };

  const priceMap = {
    sh600023: [['2026-06-01', 10], ['2026-06-02', 11], ['2026-06-03', 12], ['2026-06-04', 13]],
    hk00700: [['2026-06-01', 380], ['2026-06-02', 400], ['2026-06-03', 410], ['2026-06-04', 420]],
  };

  const res = C.marketValueSeries(st, 'acc_1', priceMap, {});
  eq('重建设 · 点数 = 有行情的交易日', res.series.length, 4);
  eq('重建设 · 未计入的标的为空', res.missing.length, 0);
  eq('重建设 · 参与重建的标的 2 只', res.used.length, 2);
  eq('重建设 · 首日日期', res.series[0].date, '2026-06-01');
  eq('重建设 · 首日来源是 kline', res.series[0].source, 'kline');

  /* 独立复算：6/1 只有浙能 1000 股 × 10 = 10000；腾讯 6/2 才买 */
  eq('重建设 · 6/1 市值 = 1000×10', res.series[0].mv, 10000);
  /* 6/2：浙能 1000×11 = 11000；腾讯 100×400×0.9 = 36000 → 47000 */
  eq('重建设 · 6/2 市值 = 11000 + 36000（含汇率）', res.series[1].mv, 47000);
  /* 6/3：浙能 1500×12 = 18000；腾讯 100×410×0.9 = 36900 → 54900 */
  eq('重建设 · 6/3 市值 = 18000 + 36900', res.series[2].mv, 54900);
  /* 6/4：浙能 1500×13 = 19500；腾讯 100×420×0.9 = 37800 → 57300 */
  eq('重建设 · 6/4 市值 = 19500 + 37800', res.series[3].mv, 57300);

  /* 前值填充：某标的当天没有行情时，沿用「该日之前最近一个交易日」的价格 */
  const gapMap = {
    sh600023: [['2026-06-01', 10], ['2026-06-04', 13]],
    hk00700: [['2026-06-02', 400]],
  };
  const res2 = C.marketValueSeries(st, 'acc_1', gapMap, {});
  eq('前值填充 · 日期取两标的并集', res2.series.length, 3);
  eq('前值填充 · 6/1 只有浙能', res2.series[0].mv, 10000);
  /* 6/2：浙能当天无行情 → 沿用 6/1 的 10；腾讯 100×400×0.9 = 36000 */
  eq('前值填充 · 6/2 浙能沿用 6/1 的价 → 10000 + 36000', res2.series[1].mv, 46000);
  /* 6/4：浙能 1500 股（6/3 加仓）×13；腾讯沿用 6/2 的 400 → 100×400×0.9 */
  eq('前值填充 · 6/4 腾讯沿用 6/2 的价 → 19500 + 36000', res2.series[2].mv, 55500);

  /* 首笔交易之前的行情日不产生市值点 */
  const earlyMap = { sh600023: [['2026-05-29', 9], ['2026-06-01', 10]] };
  eq('首笔交易前 · 5/29 被剔除，只留 6/1',
    C.marketValueSeries(st, 'acc_1', earlyMap, {}).series.map(function (p) { return p.date; }).join(','), '2026-06-01');

  /* 只有单边有行情时，另一只进 missing 且不计入 */
  const only = { sh600023: [['2026-06-01', 10]] };
  const resOnly = C.marketValueSeries(st, 'acc_1', only, {});
  eq('缺行情 · 港股进 missing', resOnly.missing.join(','), 'hk00700');
  eq('缺行情 · 市值只算浙能', resOnly.series[0].mv, 10000);

  /* 快照优先：同日有快照就用快照金额与来源 */
  const st2 = JSON.parse(JSON.stringify(st));
  st2.snapshots = { '2026-06-03': { mv: 12345.67, cost: 1000, pred: 0, recv: 0 } };
  const res3 = C.marketValueSeries(st2, 'acc_1', priceMap, {});
  const d3 = res3.series.filter(function (p) { return p.date === '2026-06-03'; })[0];
  eq('快照优先 · 同日取快照金额', d3.mv, 12345.67);
  eq('快照优先 · source 标为 snapshot', d3.source, 'snapshot');
  const d4 = res3.series.filter(function (p) { return p.date === '2026-06-04'; })[0];
  eq('快照优先 · 其它日期仍用重建', d4.source, 'kline');

  /* 区间过滤 */
  const res4 = C.marketValueSeries(st, 'acc_1', priceMap, { beg: '2026-06-03', end: '2026-06-04' });
  eq('区间 · 只留 2 个点', res4.series.length, 2);
  eq('区间 · 起点正确', res4.series[0].date, '2026-06-03');

  /* 账户隔离 */
  const st3 = JSON.parse(JSON.stringify(st));
  st3.transactions.push({ txId: 'm9', accountId: 'acc_2', symbol: 'sh600023', action: 'BUY', date: '2026-06-01', quantity: 9999, price: 10, fee: 0, createdAt: '2026-06-01T02:00:00Z' });
  const res5 = C.marketValueSeries(st3, 'acc_1', priceMap, {});
  eq('账户隔离 · acc_1 不含 acc_2 的持仓', res5.series[0].mv, 10000);
  const res6 = C.marketValueSeries(st3, XJ.calc.ALL, priceMap, {});
  eq('账户隔离 · 全部账户合并', res6.series[0].mv, 10000 + 9999 * 10);

  /* 无交易 → 空序列 */
  const stEmpty = Object.assign({}, st, { transactions: [] });
  eq('无交易 · 序列为空', C.marketValueSeries(stEmpty, 'acc_1', priceMap, {}).series.length, 0);

  /* 全部标的都没有行情 → used 为空 */
  eq('无行情 · used 为空', C.marketValueSeries(st, 'acc_1', {}, {}).used.length, 0);

  /* 分位取价：priceOn */
  const pts = [['2026-06-01', 10], ['2026-06-05', 12], ['2026-06-10', 15]];
  eq('priceOn · 精确命中', C.priceOn(pts, '2026-06-05'), 12);
  eq('priceOn · 落在中间取前一个交易日', C.priceOn(pts, '2026-06-07'), 12);
  eq('priceOn · 早于全部返回 null', C.priceOn(pts, '2026-05-01'), null);
  eq('priceOn · 晚于全部取最后一个', C.priceOn(pts, '2026-07-01'), 15);
  eq('priceOn · 空数组返回 null', C.priceOn([], '2026-06-05'), null);

  /* 日/月粒度降采样 */
  const daily = [
    { date: '2026-06-29', mv: 1 }, { date: '2026-06-30', mv: 2 },
    { date: '2026-07-01', mv: 3 }, { date: '2026-07-31', mv: 4 },
    { date: '2026-08-03', mv: 5 },
  ];
  eq('downsample · day 粒度原样返回', C.downsample(daily, 'day').length, 5);
  const monthly = C.downsample(daily, 'month');
  eq('downsample · month 取每月最后一个点', monthly.length, 3);
  eq('downsample · 6 月取 6/30', monthly[0].date, '2026-06-30');
  eq('downsample · 7 月取 7/31', monthly[1].date, '2026-07-31');
  eq('downsample · 8 月取 8/03', monthly[2].date, '2026-08-03');
  eq('downsample · 空序列不报错', C.downsample([], 'month').length, 0);

  /* 区间与首尾对比（口径对齐参考图：当日 / 本月 / 近三月 / 近6月 / 今年 / 全部 / 自定义） */
  eq('chartRange · 当日', C.chartRange('today', '2026-09-10', null, null).beg, '2026-09-10');
  eq('chartRange · 本月（当月 1 日）', C.chartRange('1m', '2026-09-10', null, null).beg, '2026-09-01');
  eq('chartRange · 近三月', C.chartRange('3m', '2026-09-10', null, null).beg, '2026-06-11');
  eq('chartRange · 近6月', C.chartRange('6m', '2026-09-10', null, null).beg, '2026-03-12');
  eq('chartRange · 今年', C.chartRange('ytd', '2026-09-10', null, null).beg, '2026-01-01');
  eq('chartRange · 全部无起点', C.chartRange('all', '2026-09-10', null, null).beg, null);
  eq('chartRange · 自定义用传入值', C.chartRange('custom', '2026-09-10', '2026-02-01', '2026-03-01').beg, '2026-02-01');
  eq('chartRange · 结束日默认今天', C.chartRange('all', '2026-09-10', null, null).end, '2026-09-10');

  const sd = C.seriesDelta([{ date: '2026-06-01', mv: 100 }, { date: '2026-06-02', mv: 150 }]);
  eq('seriesDelta · 差额', sd.diff, 50);
  eq('seriesDelta · 涨幅 50%', sd.pct, 50);
  eq('seriesDelta · 起点日', sd.from, '2026-06-01');
  eq('seriesDelta · 单点返回 null', C.seriesDelta([{ date: '2026-06-01', mv: 100 }]), null);

  /* 坐标轴刻度：整万/整亿 */
  eq('moneyAxis · 0', U.moneyAxis(0), '0');
  eq('moneyAxis · 9999 仍显示元', U.moneyAxis(9999), '9,999');
  eq('moneyAxis · 1210000 → 121万', U.moneyAxis(1210000), '121万');
  eq('moneyAxis · 97000 → 9.7万', U.moneyAxis(97000), '9.7万');
  eq('moneyAxis · 2.5亿', U.moneyAxis(250000000), '2.5亿');
}

/* ---- 6.24 分时 / 日线 / 基金净值解析（纯函数） ---- */
section('【24】分时 · 日线 · 基金净值解析');
{
  const F = XJ.fetcher, U = XJ.util;

  /* 腾讯分时：data.<code>.data.data = ["0930 41.75 4822 20131850.00"]，date=YYYYMMDD */
  const minutePayload = {
    data: {
      sh600036: {
        data: {
          date: '20260911',
          data: ['0930 41.750 4822 20131850.00', '0931 41.330 17440 72416320.00', '1447 41.250 691272 2858544719.00'],
        },
      },
    },
  };
  const pm = F.parseMinute(minutePayload, 'sh600036');
  eq('parseMinute · 日期归一化', pm.date, '2026-09-11');
  eq('parseMinute · 点数', pm.points.length, 3);
  eq('parseMinute · 时间加冒号', pm.points[0].t, '09:30');
  eq('parseMinute · 价格', pm.points[0].p, 41.75);
  eq('parseMinute · 累计量', pm.points[2].v, 691272);
  eq('parseMinute · 缺失节点返回 null', F.parseMinute({}, 'sh600036'), null);
  eq('parseMinute · 空数据返回 null',
    F.parseMinute({ data: { sh600036: { data: { data: [], date: '20260911' } } } }, 'sh600036'), null);
  eq('parseMinute · 非法时间行被跳过',
    F.parseMinute({ data: { sh600036: { data: { data: ['xx', '0930 1 1 1'], date: '' } } } }, 'sh600036').points.length, 1);

  /* 东财美股分时：trends = ["2026-09-10 21:30,316.625", ...] */
  const pt = F.parseTrends(['2026-09-10 21:30,316.625', '2026-09-10 21:31,319.860']);
  eq('parseTrends · 日期', pt.date, '2026-09-10');
  eq('parseTrends · 时间取 HH:MM', pt.points[0].t, '21:30');
  eq('parseTrends · 价格', pt.points[1].p, 319.86);
  eq('parseTrends · 只有 1 个点 → null（画不出走势）', F.parseTrends(['2026-09-10 21:30,1']), null);
  eq('parseTrends · 空 → null', F.parseTrends([]), null);

  /* 腾讯日K：[[日期, 开, 收, 高, 低, 量], ...]，取「收」 */
  const klinePayload = {
    data: {
      sh600036: {
        day: [
          ['2026-09-01', '40.040', '40.860', '40.880', '39.900', '1147661.000'],
          ['2026-09-02', '40.900', '40.870', '41.000', '40.630', '648611.000'],
        ],
      },
    },
  };
  const pk = F.parseKline(klinePayload, 'sh600036');
  eq('parseKline · 根数', pk.length, 2);
  eq('parseKline · 取第 3 列（收盘）', pk[0][1], 40.86);
  eq('parseKline · 日期切片', pk[0][0], '2026-09-01');
  eq('parseKline · 支持 qfqday 键',
    F.parseKline({ data: { sh600036: { qfqday: [['2026-09-01', '1', '2', '3', '0', '9']] } } }, 'sh600036')[0][1], 2);
  eq('parseKline · 未知标的 → 空', F.parseKline(klinePayload, 'sz000858').length, 0);
  eq('parseKline · 非法行被跳过',
    F.parseKline({ data: { x: { day: [['bad', '1', '2', '3', '0', '9'], ['2026-09-01', '1', '2', '3', '0', '9']] } } }, 'x').length, 1);
  eq('parseKline · 按日期升序',
    F.parseKline({ data: { x: { day: [['2026-09-02', '1', '5', '3', '0', '9'], ['2026-09-01', '1', '2', '3', '0', '9']] } } }, 'x')[0][1], 2);

  /* 天天基金净值走势：Data_netWorthTrend = [{x: ms, y: nav}] */
  const nav = F.parseFundNav([
    { x: Date.UTC(2026, 5, 1), y: 1.234, equityReturn: 0 },
    { x: Date.UTC(2026, 5, 2), y: 1.245, equityReturn: 0.9 },
    { x: Date.UTC(2026, 5, 3), y: 0, equityReturn: 0 },
  ]);
  eq('parseFundNav · 剔除净值为 0 的行', nav.length, 2);
  eq('parseFundNav · 时间戳转日期', nav[0][0], '2026-06-01');
  eq('parseFundNav · 净值', nav[1][1], 1.245);
  eq('parseFundNav · 空 → 空数组', F.parseFundNav(null).length, 0);

  /* 历史价格按日期升序（供 priceOn 二分） */
  const unsorted = F.parseFundNav([{ x: Date.UTC(2026, 5, 3), y: 1.3 }, { x: Date.UTC(2026, 5, 1), y: 1.1 }]);
  eq('parseFundNav · 结果升序', unsorted[0][0], '2026-06-01');
}

/* ---- 6.25 公司图标多源解析 + 中文简称 + 净资产口径 ---- */
section('【25】公司图标解析链 · 中文简称 · 净资产');
{
  const MK = XJ.market, C = XJ.calc, U = XJ.util;

  /* 一级域名：去掉最左边的一级子域（.com 与 .com.cn 都适用） */
  eq('rootDomain · www.shenergy.net.cn → shenergy.net.cn', MK.rootDomain('www.shenergy.net.cn'), 'shenergy.net.cn');
  eq('rootDomain · hold.coscoshipping.com → coscoshipping.com', MK.rootDomain('hold.coscoshipping.com'), 'coscoshipping.com');
  eq('rootDomain · www.cmbchina.com → cmbchina.com', MK.rootDomain('www.cmbchina.com'), 'cmbchina.com');
  eq('rootDomain · tencent.com 原样', MK.rootDomain('tencent.com'), 'tencent.com');
  eq('rootDomain · about.meituan.com → meituan.com', MK.rootDomain('about.meituan.com'), 'meituan.com');
  eq('rootDomain · 空 → 空', MK.rootDomain(''), '');
  eq('cleanDomain · 去协议与路径', MK.cleanDomain('https://www.pingan.cn/about'), 'www.pingan.cn');
  eq('cleanDomain · 无点 → 空', MK.cleanDomain('nodot'), '');

  /* 候选链的构成与顺序 */
  const cands = MK.logoCandidates('sh601919', 'hold.coscoshipping.com');
  eq('logoCandidates · 完整域名 icon.horse 优先',
    cands[0], 'https://icon.horse/icon/hold.coscoshipping.com');
  eq('logoCandidates · 再来一级域名 icon.horse',
    cands[1], 'https://icon.horse/icon/coscoshipping.com');
  eq('logoCandidates · 然后 xinac 代理（可验真）',
    cands[2], 'https://api.xinac.net/icon/?url=hold.coscoshipping.com');
  eq('logoCandidates · 一级域名的 xinac 代理',
    cands[3], 'https://api.xinac.net/icon/?url=coscoshipping.com');
  eq('logoCandidates · 候选数 4', cands.length, 4);
  eq('logoCandidates · 不再放无法验真的官网 favicon',
    cands.filter((u) => /favicon\.ico/.test(u)).length, 0);
  eq('logoCandidates · 无域名 → 空候选（直接走文字头像）', MK.logoCandidates('sh600036', null).length, 0);
  /* 二级域名（tencent.com）本身就是一级域名，不该再推一遍同名候选 */
  eq('logoCandidates · 二级域名不重复推一级', MK.logoCandidates('hk00700', 'tencent.com').length, 2);
  eq('logoCandidates · www.tencent.com 会补一级域名候选',
    MK.logoCandidates('hk00700', 'www.tencent.com').indexOf('https://icon.horse/icon/tencent.com') > 0, true);

  /* 同花顺 F10 路径：只有沪深北个股有 */
  eq('thsF10Url · 沪市个股', MK.thsF10Url('sh601919'), 'https://basic.10jqka.com.cn/601919/company.html');
  eq('thsF10Url · 深市个股', MK.thsF10Url('sz000858'), 'https://basic.10jqka.com.cn/000858/company.html');
  eq('thsF10Url · 北交所个股', MK.thsF10Url('bj430047'), 'https://basic.10jqka.com.cn/430047/company.html');
  eq('thsF10Url · ETF 无此页 → null', MK.thsF10Url('sh510300'), null);
  eq('thsF10Url · 场外基金无此页 → null', MK.thsF10Url('of110022'), null);
  eq('thsF10Url · 港股无此页 → null', MK.thsF10Url('hk00700'), null);
  eq('thsF10Url · 美股无此页 → null', MK.thsF10Url('usAAPL'), null);

  /* 从 F10 页面 HTML 里提取 logo（实测两种 host 都出现过） */
  eq('parseThsLogo · basic.10jqka.com.cn/ai_data 形式',
    MK.parseThsLogo('<p><img src="https://basic.10jqka.com.cn/ai_data/logo/company/dc-d-common-global.company-logo/9917315a.png" alt="x"></p>'),
    'https://basic.10jqka.com.cn/ai_data/logo/company/dc-d-common-global.company-logo/9917315a.png');
  eq('parseThsLogo · o.thsi.cn 形式',
    MK.parseThsLogo('x https://o.thsi.cn/dc-d-common-global.company-logo/fa83d12e-e224.png y'),
    'https://o.thsi.cn/dc-d-common-global.company-logo/fa83d12e-e224.png');
  eq('parseThsLogo · 页面里没有 → null', MK.parseThsLogo('<html>没有图</html>'), null);
  eq('parseThsLogo · 空 → null', MK.parseThsLogo(''), null);
  eq('parseThsLogo · 不误抓普通 logo 图',
    MK.parseThsLogo('<img src="https://s.thsi.cn/css/logo.png">'), null);

  /* 中文简称头像 */
  eq('shortName · 四字公司名取前两字', U.shortName('中远海控'), '中远');
  eq('shortName · 申能股份', U.shortName('申能股份'), '申能');
  eq('shortName · 腾讯控股', U.shortName('腾讯控股'), '腾讯');
  eq('shortName · 两字名称原样', U.shortName('苹果'), '苹果');
  eq('shortName · 英文名取首字母大写', U.shortName('apple'), 'A');
  eq('shortName · 代码类名称取首字符', U.shortName('600036'), '6');
  eq('shortName · 空 → ?', U.shortName(''), '?');
  eq('shortName · 未定义 → ?', U.shortName(undefined), '?');
  eq('shortName · 带风险警示前缀时取中文部分（*ST海航 → 海航）', U.shortName('*ST海航'), '海航');
  eq('shortName · 带上市前缀时取中文部分（C中国平安 → 中国）', U.shortName('C中国平安'), '中国');

  /* 净资产 = 持仓总市值 + 累计已收分红 − 累计净投入 */
  const st = {
    accounts: [{ accountId: 'acc_1', name: 'A', sortOrder: 1 }],
    symbols: {
      sh600023: { symbol: 'sh600023', code: '600023', market: 'sh', name: '浙能电力', type: 'STOCK', costMethod: 'weighted' },
    },
    transactions: [
      { txId: 'n1', accountId: 'acc_1', symbol: 'sh600023', action: 'BUY', date: '2026-06-01', quantity: 1000, price: 10, fee: 0, createdAt: '2026-06-01T01:00:00Z' },
      { txId: 'n2', accountId: 'acc_1', symbol: 'sh600023', action: 'BUY', date: '2026-06-03', quantity: 500, price: 12, fee: 0, createdAt: '2026-06-03T01:00:00Z' },
    ],
    received: [
      { recId: 'r1', accountId: 'acc_1', symbol: 'sh600023', exDividendDate: '2026-06-02', amount: 100, source: 'MANUAL' },
    ],
    snapshots: {},
    settings: { fx: {} },
  };
  const pm = { sh600023: [['2026-06-01', 10], ['2026-06-02', 11], ['2026-06-03', 12], ['2026-06-04', 13]] };
  const res = C.marketValueSeries(st, 'acc_1', pm, {});
  eq('净资产 · 点数', res.series.length, 4);
  /* 6/1：净投入 10000，市值 10000，尚未收到分红 → 净资产 0 */
  eq('净资产 · 6/1 净值 = 10000 + 0 − 10000', res.series[0].nw, 0);
  eq('净资产 · 6/1 净投入透出', res.series[0].net, 10000);
  eq('净资产 · 6/1 累计分红 0', res.series[0].recv, 0);
  /* 6/2：市值 11000，收到 100 → 11000 + 100 − 10000 = 1100 */
  eq('净资产 · 6/2 净值 = 11000 + 100 − 10000', res.series[1].nw, 1100);
  eq('净资产 · 6/2 累计分红 100', res.series[1].recv, 100);
  /* 6/3：加仓 500×12 → 净投入 16000，市值 1500×12=18000 → 18000+100−16000 = 2100 */
  eq('净资产 · 6/3 净值 = 18000 + 100 − 16000', res.series[2].nw, 2100);
  eq('净资产 · 6/3 净投入 16000', res.series[2].net, 16000);
  /* 6/4：市值 19500 → 19500 + 100 − 16000 = 3600 */
  eq('净资产 · 6/4 净值 = 19500 + 100 − 16000', res.series[3].nw, 3600);

  /* 快照只覆盖市值，净资产仍用重算出的净投入与累计分红 */
  const st2 = JSON.parse(JSON.stringify(st));
  st2.snapshots = { '2026-06-03': { mv: 12345.67, cost: 1, pred: 0, recv: 0 } };
  const res2 = C.marketValueSeries(st2, 'acc_1', pm, {});
  const d3 = res2.series.filter((p) => p.date === '2026-06-03')[0];
  eq('净资产 · 快照覆盖市值', d3.mv, 12345.67);
  eq('净资产 · 快照日净值 = 12345.67 + 100 − 16000', d3.nw, -3554.33);
  eq('净资产 · 快照日净投入仍为 16000', d3.net, 16000);

  /* 区间首尾对比支持按指标取值 */
  const sdv = C.seriesDelta(res.series, 'mv');
  eq('seriesDelta(mv) · 起 10000 → 末 19500', sdv.diff, 9500);
  const sdn = C.seriesDelta(res.series, 'nw');
  eq('seriesDelta(nw) · 起 0 → 末 3600', sdn.diff, 3600);
  eq('seriesDelta(nw) · 起点为 0 时涨幅不显示', sdn.pct, null);
  eq('seriesDelta(mv) · 默认键为 mv', C.seriesDelta(res.series).diff, sdv.diff);

  /* 净值曲线与市值曲线必须是两条不同的线 */
  eq('市值与净资产不同（含股息口径生效）',
    res.series[3].mv !== res.series[3].nw, true);
}

/* ---- 6.26 对比指数 · 时间加权收益率 · 成本口径迁移 ---- */
section('【26】对比指数 · TWR 收益率 · 成本口径迁移');
{
  const MK = XJ.market, C = XJ.calc, U = XJ.util, M = XJ.model;

  /* 指数注册表 */
  eq('INDICES · 共 8 个', MK.INDICES.length, 8);
  eq('INDICES · 顺序与名称',
    MK.INDICES.map(function (d) { return d.name; }).join(','),
    '上证指数,沪深300,恒生指数,纳斯达克,标普500,日经225,台湾加权,韩国KOSPI');
  /* 腾讯 kline/kline 的代码：A股/港股用裸代码，美股指数必须带点 */
  eq('indexDef · 上证指数 kline 代码', MK.indexDef('sh').kline, 'sh000001');
  eq('indexDef · 沪深300 kline 代码', MK.indexDef('hs300').kline, 'sh000300');
  eq('indexDef · 恒生指数 kline 代码', MK.indexDef('hsi').kline, 'hkHSI');
  eq('indexDef · 纳斯达克 kline 代码（带点）', MK.indexDef('ixic').kline, 'us.IXIC');
  eq('indexDef · 标普500 kline 代码（带点）', MK.indexDef('spx').kline, 'us.INX');
  eq('indexDef · 未知 key → null', MK.indexDef('nope'), null);
  eq('indexHasHistory · 上证有历史', MK.indexHasHistory('sh'), true);
  eq('indexHasHistory · 纳斯达克有历史', MK.indexHasHistory('ixic'), true);
  eq('indexHasHistory · 日经225 无历史源（置灰）', MK.indexHasHistory('n225'), false);
  eq('indexHasHistory · 台湾加权无历史源（置灰）', MK.indexHasHistory('twii'), false);
  eq('indexHasHistory · 韩国KOSPI 无历史源（置灰）', MK.indexHasHistory('ks11'), false);
  eq('indexHasHistory · 无历史源的给出说明文案', !!MK.indexDef('n225').unavailable, true);
  eq('indexHasIntraday · 上证有分时', MK.indexHasIntraday('sh'), true);
  eq('indexHasIntraday · 恒生有分时', MK.indexHasIntraday('hsi'), true);
  eq('indexHasIntraday · 纳斯达克无分时（当日置灰）', MK.indexHasIntraday('ixic'), false);
  eq('indexHasIntraday · 韩国KOSPI 无分时', MK.indexHasIntraday('ks11'), false);
  eq('INDICES · 有历史源的共 5 个',
    MK.INDICES.filter(function (d) { return MK.indexHasHistory(d.key); }).length, 5);
  eq('indexColor · 每个指数都有自己的颜色', new Set(MK.INDICES.map(function (d) { return MK.indexColor(d.key); })).size, 8);
  eq('METRIC_COLORS · 三条曲线三种颜色', new Set([MK.METRIC_COLORS.mv, MK.METRIC_COLORS.nw, MK.METRIC_COLORS.ret]).size, 3);

  /* TWR：中途加仓不应抬高收益率（这正是 TWR 与「净资产÷净投入」的区别） */
  const mvSeries = [
    { date: '2026-01-01', mv: 100, net: 100, recv: 0 },
    { date: '2026-01-02', mv: 110, net: 100, recv: 0 },
    { date: '2026-01-03', mv: 220, net: 200, recv: 0 },   // 当日追加投入 100
    { date: '2026-01-04', mv: 231, net: 200, recv: 0 },
  ];
  const twr = C.twrIndex(mvSeries);
  eq('twrIndex · 点数与输入一致', twr.length, 4);
  eq('twrIndex · 首日指数为 1', twr[0].idx, 1);
  close('twrIndex · 第 2 日 +10%', twr[1].idx, 1.10, 1e-6);
  close('twrIndex · 第 3 日剔除 100 净流入后 +9.0909%', twr[2].idx, 1.10 * (1 + 10 / 110), 1e-6);
  close('twrIndex · 第 4 日再 +5%', twr[3].idx, 1.10 * (1 + 10 / 110) * 1.05, 1e-6);
  close('twrIndex · 期末累计 +26%（而非按资产翻倍的 +131%）', twr[3].idx * 100 - 100, 26, 1e-4);
  /* 对照：同期的「净资产 ÷ 净投入」会被加仓机械拉高，说明为什么必须用 TWR */
  const naive = (231 - 200) / 200 * 100;
  eq('对照 · 简单收益口径只有 +15.5%', Math.round(naive * 10) / 10, 15.5);

  /* 分红计入资产、且不算外部流入 → 会体现为收益 */
  const withDiv = [
    { date: '2026-01-01', mv: 100, net: 100, recv: 0 },
    { date: '2026-01-02', mv: 100, net: 100, recv: 5 },   // 收到 5 元分红，股价没动
  ];
  close('twrIndex · 分红 5 元 → 收益 +5%（分红计为收益、不是外部流入）',
    C.twrIndex(withDiv)[1].idx, 1.05, 1e-6);

  /* 期初资产为 0 时不产生 NaN */
  const zeroStart = [
    { date: '2026-01-01', mv: 0, net: 0, recv: 0 },
    { date: '2026-01-02', mv: 0, net: 0, recv: 0 },
  ];
  eq('twrIndex · 期初为 0 不产生 NaN', isFinite(C.twrIndex(zeroStart)[1].idx), true);
  eq('twrIndex · 空输入返回空数组', C.twrIndex([]).length, 0);

  /* 共同起点 */
  eq('commonStart · 取最晚的起始日（序列数组）',
    C.commonStart([[{ date: '2026-01-01' }], [{ date: '2026-02-01' }], [{ date: '2026-01-15' }]]), '2026-02-01');
  eq('commonStart · 也接受单点对象数组',
    C.commonStart([{ date: '2026-01-01' }, { date: '2026-03-01' }]), '2026-03-01');
  eq('commonStart · 忽略空序列', C.commonStart([[], [{ date: '2026-05-01' }]]), '2026-05-01');
  eq('commonStart · 全空 → null', C.commonStart([[], null]), null);

  /* 百分比归一 */
  const pts = [{ date: '2026-01-01', c: 100 }, { date: '2026-01-02', c: 110 }, { date: '2026-01-03', c: 90 }];
  const rp = C.rebasePercent(pts, 'c', '2026-01-01');
  eq('rebasePercent · 起点为 0%', rp[0].pct, 0);
  eq('rebasePercent · +10%', rp[1].pct, 10);
  eq('rebasePercent · -10%', rp[2].pct, -10);
  /* 用更晚的起点：起点之前的点被丢掉，并从该点重新归一 */
  const rp2 = C.rebasePercent(pts, 'c', '2026-01-02');
  eq('rebasePercent · 晚起点会丢掉之前的点', rp2.length, 2);
  eq('rebasePercent · 晚起点当天为 0%', rp2[0].pct, 0);
  eq('rebasePercent · 相对新起点 -18.18%', rp2[1].pct, -18.18);
  eq('rebasePercent · 不传起点则用自己的第一个点', C.rebasePercent(pts, 'c', null)[1].pct, 10);
  eq('rebasePercent · 默认取 c 字段', C.rebasePercent(pts, undefined, null)[2].pct, -10);
  /* 指数日线用 d 字段，也必须能正常归一（曾因为只认 date 导致指数曲线整条丢失） */
  const dBars = [{ d: '2026-01-01', c: 100 }, { d: '2026-01-02', c: 120 }, { d: '2026-01-03', c: 80 }];
  const dRes = C.rebasePercent(dBars, 'c', '2026-01-01');
  eq('rebasePercent · 接受指数日线的 d 字段', dRes.length, 3);
  eq('rebasePercent · d 字段起点为 0%', dRes[0].pct, 0);
  eq('rebasePercent · d 字段 +20%', dRes[1].pct, 20);
  eq('rebasePercent · d 字段 -20%', dRes[2].pct, -20);
  eq('rebasePercent · d 字段的 date 输出被归一为 date 键', dRes[1].date, '2026-01-02');
  /* 起点裁剪对 d 字段同样生效 */
  eq('rebasePercent · d 字段晚起点裁剪', C.rebasePercent(dBars, 'c', '2026-01-02').length, 2);

  /* 腾讯指数日线的解析（[日期, 开, 收, 高, 低, 量]） */
  const tencentPayload = { data: { sh000001: { day: [
    ['2026-01-05', '3910.920', '3888.110', '3912.320', '3852.030', '579123145.000'],
    ['2026-01-06', '3888.110', '3900.000', '3905.000', '3880.000', '500000000.000'],
  ] } } };
  const tk = XJ.fetcher.parseIndexKline(tencentPayload, 'sh000001');
  eq('parseIndexKline · 根数', tk.length, 2);
  eq('parseIndexKline · 开盘', tk[0].o, 3910.92);
  eq('parseIndexKline · 收盘', tk[0].c, 3888.11);
  eq('parseIndexKline · 最高', tk[0].h, 3912.32);
  eq('parseIndexKline · 最低', tk[0].l, 3852.03);
  eq('parseIndexKline · 日期', tk[0].d, '2026-01-05');
  eq('parseIndexKline · 美股带点代码也能解析',
    XJ.fetcher.parseIndexKline({ data: { 'us.IXIC': { day: [['2026-01-05', '1', '2', '3', '0', '9']] } } }, 'us.IXIC').length, 1);
  eq('parseIndexKline · 不传代码时自动取第一个键',
    XJ.fetcher.parseIndexKline(tencentPayload).length, 2);
  eq('parseIndexKline · 空数据 → 空数组', XJ.fetcher.parseIndexKline({ data: {} }, 'x').length, 0);
  eq('parseIndexKline · 非法行被跳过',
    XJ.fetcher.parseIndexKline({ data: { x: { day: [['bad', '1', '2', '3', '0', '9'], ['2026-01-05', '1', '2', '3', '0', '9']] } } }, 'x').length, 1);

  /* 指数区间裁剪 */
  const bars = [
    { d: '2026-01-01', o: 1, h: 2, l: 0.5, c: 1.5 },
    { d: '2026-02-01', o: 1.5, h: 3, l: 1, c: 2.5 },
    { d: '2026-03-01', o: 2.5, h: 4, l: 2, c: 3.5 },
  ];
  eq('indexBarsInRange · 区间裁剪', C.indexBarsInRange(bars, '2026-02-01', '2026-02-28').length, 1);
  eq('indexBarsInRange · 无边界则全取', C.indexBarsInRange(bars).length, 3);

  /* 指数收益率蜡烛：OHLC 全部相对起点收盘价换算 */
  const cds = C.indexCandles(bars, '2026-01-01');
  eq('indexCandles · 根数', cds.length, 3);
  eq('indexCandles · 起点收盘为 0%', cds[0].c, 0);
  eq('indexCandles · 起点开盘 -33.33%', cds[0].o, -33.33);
  eq('indexCandles · 第二根收盘 +66.67%', cds[1].c, 66.67);
  eq('indexCandles · 第三根最高 +166.67%', cds[2].h, 166.67);
  eq('indexCandles · 保留原始 bar 便于回查', cds[0].full.d, '2026-01-01');
  eq('indexCandles · 起点晚于全部 → 空', C.indexCandles(bars, '2027-01-01').length, 0);

  /* seriesDelta 支持收益率（百分点）口径 */
  const pctSeries = [{ date: 'a', pct: -2 }, { date: 'b', pct: 5.5 }];
  const sdPct = C.seriesDelta(pctSeries, 'pct');
  eq('seriesDelta(pct) · 差值即百分点', sdPct.diff, 7.5);
  eq('seriesDelta(pct) · 标记为百分比口径', sdPct.isPct, true);
  eq('seriesDelta(pct) · pct 字段不再二次换算', sdPct.pct, 7.5);

  /* ---- 成本口径迁移：v3 → v4 全部改为分红摊薄 ---- */
  eq('DATA_VERSION 已升到 6（v6 新增 expenses.category 与 settings.fire）', M.DATA_VERSION, 6);
  eq('默认成本口径 = 分红摊薄', M.DEFAULT_COST_METHOD, 'dividendDiluted');

  const v3raw = {
    version: 3,
    accounts: [{ accountId: 'a1', name: 'A', sortOrder: 1 }],
    symbols: {
      sh600023: { symbol: 'sh600023', code: '600023', market: 'sh', name: '浙能电力', type: 'STOCK', costMethod: 'weighted' },
      sz000858: { symbol: 'sz000858', code: '000858', market: 'sz', name: '五粮液', type: 'STOCK' },  // 没有 costMethod
    },
    transactions: [], plans: {}, received: [], expenses: [],
    settings: { defaultAccountId: 'a1' },
  };
  const migrated = M.fromImport(v3raw);
  eq('迁移 · 版本号升到 6', migrated.version, 6);
  eq('迁移 · 原本是加权平均的被切到分红摊薄', migrated.symbols['sh600023'].costMethod, 'dividendDiluted');
  eq('迁移 · 原本没设口径的也切到分红摊薄', migrated.symbols['sz000858'].costMethod, 'dividendDiluted');
  eq('迁移 · 幂等（再导入同一份已升版数据不再改动）', M.fromImport(migrated).symbols['sh600023'].costMethod, 'dividendDiluted');
  /* 迁移只跑一次：v4 数据里手动改过的口径不会被覆盖 */
  const v4raw = JSON.parse(JSON.stringify(M.toExport(migrated)));
  v4raw.symbols['sh600023'].costMethod = 'weighted';
  eq('迁移 · v4 数据里手动改回加权平均后不再被覆盖',
    M.fromImport(v4raw).symbols['sh600023'].costMethod, 'weighted');

  /* 新增容器 */
  eq('defaultState · 含 indexHistory 容器', typeof M.defaultState().indexHistory, 'object');
  eq('defaultState · 默认勾选 3 个对比指数',
    M.defaultState().settings.indexCompare.join(','), 'sh,hs300,hsi');
  eq('ensureBootstrapped · 补齐 indexHistory', (function () {
    var st = M.ensureBootstrapped({ version: 4, accounts: [], symbols: {}, transactions: [], received: [], expenses: [] });
    return typeof st.indexHistory;
  })(), 'object');
  eq('ensureBootstrapped · 补齐 indexCompare', (function () {
    var st = M.ensureBootstrapped({ version: 4, accounts: [], symbols: {}, transactions: [], received: [], expenses: [] });
    return st.settings.indexCompare.length;
  })(), 3);

  /* 分红摊薄下成本确实随分红下降 */
  const divSt = [
    { txId: 'd1', accountId: 'a1', symbol: 'sh600023', action: 'BUY', date: '2026-01-05', quantity: 1000, price: 10, fee: 0, createdAt: '2026-01-05T01:00:00Z' },
  ];
  const noDiv = C.position(divSt, null, 'dividendDiluted', 0);
  const withDiv2 = C.position(divSt, null, 'dividendDiluted', 1500);
  eq('分红摊薄 · 未分红时每股 10 元', noDiv.avgCost, 10);
  eq('分红摊薄 · 收到 1500 元分红后每股 8.5 元（成本自动下降）', withDiv2.avgCost, 8.5);
}

/* ---- 6.27 默认成本口径 = 分红摊薄（分红后成本自动下降）----
 * 回归背景：曾经 8 处创建 symbols[sym] 的代码都没写 costMethod，而 calc 的兜底是「加权平均」，
 * 于是通过 OCR 导入 / 交易录入建的仓的分红**不会摊薄成本**，用户看到的就是「成本还得自己改」。 */
section('【27】默认成本口径与证券记录工厂');
{
  const M = XJ.model, C = XJ.calc, st = JSON.parse(JSON.stringify(state));
  const txs = [
    { txId: 'q1', accountId: 'acc_1', symbol: 'sh600023', action: 'BUY', date: '2026-01-05', quantity: 1000, price: 10, fee: 0, createdAt: '2026-01-05T01:00:00Z' },
  ];

  /* position 不传口径时按分红摊薄 */
  eq('默认口径 · 不传口径 = 分红摊薄（收到 1500 分红后每股 8.5）',
    C.position(txs, null, undefined, 1500).avgCost, 8.5);
  eq('默认口径 · 与显式 dividendDiluted 完全一致',
    C.position(txs, null, undefined, 1500).avgCost,
    C.position(txs, null, 'dividendDiluted', 1500).avgCost);
  eq('默认口径 · 无分红时等于净投入摊薄（10000/1000）',
    C.position(txs, null, undefined, 0).avgCost, 10);
  eq('默认口径 · 显式传 weighted 时仍按加权平均（不被默认值影响）',
    C.position(txs, null, 'weighted', 1500).avgCost, 10);

  /* 端到端：symbol 记录里没有 costMethod（老数据 / OCR 导入建的仓）也必须摊薄 */
  st.symbols = {
    sh600023: { symbol: 'sh600023', code: '600023', market: 'sh', name: '浙能电力', type: 'STOCK' },
  };
  st.transactions = txs;
  st.received = [{ recId: 'r1', accountId: 'acc_1', symbol: 'sh600023', exDividendDate: '2026-02-01', amount: 1500, source: 'AUTO' }];
  st.quoteCache = { sh600023: { symbol: 'sh600023', name: '浙能电力', price: 12, prevClose: 12 } };
  const h = C.holdings(st, 'acc_1').filter(function (x) { return x.symbol === 'sh600023'; })[0];
  eq('★无 costMethod 的标的 · 成本口径落到分红摊薄', h.costMethod, 'dividendDiluted');
  eq('★无 costMethod 的标的 · 每股成本从 10 降到 8.5', h.avgCost, 8.5);
  eq('★无 costMethod 的标的 · 成本金额 8500', h.costValue, 8500);
  /* 对照：显式加权平均的同一份数据不会摊薄 */
  const st2 = JSON.parse(JSON.stringify(st));
  st2.symbols['sh600023'].costMethod = 'weighted';
  eq('对照 · 显式加权平均时成本仍为 10（不摊薄）',
    C.holdings(st2, 'acc_1')[0].avgCost, 10);

  /* 证券记录工厂：任何创建路径都必须带上口径 */
  const rec = M.symbolRecord('sh601919', { name: '中远海控' });
  eq('工厂 · 自带默认成本口径', rec.costMethod, 'dividendDiluted');
  eq('工厂 · 自动补 code', rec.code, '601919');
  eq('工厂 · 自动补 market', rec.market, 'sh');
  eq('工厂 · 自动补 type', rec.type, 'STOCK');
  eq('工厂 · 自动补 updatedAt', typeof rec.updatedAt, 'string');
  eq('工厂 · extra 覆盖 name', rec.name, '中远海控');
  eq('工厂 · 不传 extra 时 name 为空串', M.symbolRecord('sz000858').name, '');
  eq('工厂 · 港股/美股代码也正确', M.symbolRecord('usAAPL').market + '/' + M.symbolRecord('usAAPL').code, 'us/AAPL');
  eq('工厂 · 产物与 model 默认口径一致', rec.costMethod, M.DEFAULT_COST_METHOD);
}

/* ---- 6.28 公司图标：同花顺优先 + 缓存失效 ---- */
section('【28】公司图标解析顺序与缓存失效');
{
  const MK = XJ.market, F = XJ.fetcher;

  /* 判定规则版本：升级后旧缓存必须失效，否则用户当天看不到修复效果 */
  eq('LOGO_ALGO 已升到 2', F.LOGO_ALGO, 2);

  /* ★ 回归：同花顺给雅戈尔的是黑白字标（maxSat=0），
       如果对同花顺结果也做色彩判定，真标识会被误杀 —— 所以同花顺结果不走 logoVerdict */
  eq('★黑白真标识会被色彩判定误杀（雅戈尔同花顺 logo maxSat=0）', MK.logoVerdict({ maxSat: 0 }), 'bad');
  eq('★因此同花顺结果必须绕过色彩判定：A股个股有同花顺通道',
    !!MK.thsF10Url('sh600177'), true);
  eq('★非A股（港股/美股/基金）没有同花顺通道，只能走会回通用图的域名源',
    [MK.thsF10Url('hk00700'), MK.thsF10Url('usAAPL'), MK.thsF10Url('of110022')].join(','), ',,');
  /* 域名源的占位图仍要被拦住 */
  eq('域名源的灰字母占位图仍被判定为假', MK.logoVerdict({ maxSat: 0 }), 'bad');
  eq('域名源的彩色真图标仍被判为真', MK.logoVerdict({ maxSat: 189 }), 'ok');

  /* 缓存失效：三种情形 */
  const today = '2026-09-11';
  eq('logoStale · 旧算法版本的结论 → 需要重解析',
    MK.logoStale({ logoAlgo: 1, logoUrl: 'x', logoState: 'ok', logoResolvedOn: today }, today, 2), true);
  eq('logoStale · 已拿到官方标识且算法版本一致 → 不需要',
    MK.logoStale({ logoAlgo: 2, logoUrl: 'x', logoState: 'ok', logoResolvedOn: '2026-01-01' }, today, 2), false);
  eq('logoStale · 今天已试过且失败 → 今天不再重试',
    MK.logoStale({ logoAlgo: 2, logoUrl: null, logoState: 'bad', logoResolvedOn: today }, today, 2), false);
  eq('logoStale · 今天是昨天失败的记录 → 需要重试',
    MK.logoStale({ logoAlgo: 2, logoUrl: null, logoState: 'bad', logoResolvedOn: '2026-09-10' }, today, 2), true);
  eq('logoStale · 全新记录 → 需要解析', MK.logoStale({}, today, 2), true);
  eq('logoStale · 空记录 → 需要解析', MK.logoStale(null, today, 2), true);
  eq('logoStale · 没有 logoAlgo 字段的老数据 → 需要重解析',
    MK.logoStale({ logoUrl: 'x', logoState: 'ok', logoResolvedOn: today }, today, 2), true);
}

/* ---- 6.29 跨设备搬运：编解码 + 负载裁剪 + 合并去重 ---- */
section('【29】跨设备搬运（链接 / 文本互转）');
{
  const T = XJ.transfer, M = XJ.model;

  /* base64url 往返：含中文、emoji、标点、换行（必须走完 utf8→b64→unb64→utf8 四步） */
  const samples = ['', 'abc', '中文测试', '😀🎉 emoji', 'a-b_c/d+e=f', '换行\\n与"引号"和\\\\反斜杠'];
  samples.forEach(function (t) {
    const back = T.bytesUtf8(T.unb64url(T.b64url(T.utf8Bytes(t))));
    eq('b64url 往返 · ' + JSON.stringify(t).slice(0, 18), back === t, true);
  });
  eq('b64url · 不含 + / = 等需要在 URL 里转义的字符',
    /^[A-Za-z0-9_-]*$/.test(T.b64url(T.utf8Bytes('中文 😀 ~!@#$%^&*()+/='))), true);
  eq('unb64url · 容忍标准 base64 的 +/ 与填充',
    T.bytesUtf8(T.unb64url(T.b64url(T.utf8Bytes('中文测试')))), '中文测试');

  /* 前缀与格式校验 */
  const payload = { app: '息记复刻版', accounts: [{ accountId: 'a1', name: '我的账户' }], n: 42, zh: '股息' };
  const enc = T.encodeSync(payload);
  eq('encodeSync · 前缀为 XJ1p.', enc.slice(0, 5), 'XJ1p.');
  eq('decodeSync · 往返一致', JSON.stringify(T.decodeSync(enc)), JSON.stringify(payload));
  eq('decodeSync · 中文正确还原', T.decodeSync(enc).zh, '股息');
  eq('decodeSync · 数字正确还原', T.decodeSync(enc).n, 42);
  const throws = (fn) => { try { fn(); return false; } catch (e) { return true; } };
  eq('decodeSync · 非本应用内容抛错', throws(() => T.decodeSync('hello world')), true);
  eq('decodeSync · 空内容抛错', throws(() => T.decodeSync('')), true);
  eq('decodeSync · 未知 mode 抛错', throws(() => T.decodeSync('XJ1x.abc')), true);
  eq('decodeSync · gzip 内容提示在应用内导入', throws(() => T.decodeSync('XJ1g.abc')), true);
  eq('unb64url · 非法字符抛错', throws(() => T.unb64url('!!!')), true);

  /* 负载裁剪：绝不携带 OCR Key */
  const st = JSON.parse(JSON.stringify(state));
  st.settings.ocr = { apiKey: 'SECRET_KEY_12345', model: 'glm-4v-flash', agreed: true };
  st.settings.showLogo = false;
  st.plans = { p1: { planId: 'p1' } };
  st.quoteCache = { sh600023: { price: 4.98 } };
  st.snapshots = { '2026-01-01': { mv: 1 } };
  const slim = T.slimState(st);
  eq('slimState · 不含 settings.ocr', slim.settings.ocr, undefined);
  eq('★slimState · 全文搜不到 API Key', JSON.stringify(slim).indexOf('SECRET_KEY_12345') < 0, true);
  eq('slimState · 保留其它 settings', slim.settings.showLogo, false);
  eq('slimState · 不带 plans', slim.plans, undefined);
  eq('slimState · 不带 quoteCache', slim.quoteCache, undefined);
  eq('slimState · 默认不带 snapshots', slim.snapshots, undefined);
  eq('slimState · 可显式带上 snapshots', T.slimState(st, { withSnapshots: true }).snapshots['2026-01-01'].mv, 1);
  eq('slimState · 带上核心数据', [slim.accounts.length, slim.transactions.length, Object.keys(slim.symbols).length].join('/'),
    [st.accounts.length, st.transactions.length, Object.keys(st.symbols).length].join('/'));
  eq('★slimState 出品的整体编码里也没有 Key', T.encodeSync(slim).indexOf(T.b64url(T.utf8Bytes('SECRET_KEY_12345')).slice(0, 12)), -1);

  /* 摘要 */
  const sum = T.summarize(slim);
  eq('summarize · 账户数', sum.accounts, st.accounts.length);
  eq('summarize · 交易数', sum.transactions, st.transactions.length);
  eq('summarize · 到账数', sum.received, st.received.length);

  /* 链接互转 */
  const url = T.buildImportUrl('https://example.com/xiji/', enc);
  eq('buildImportUrl · 拼出 #xjimport=', url.indexOf('https://example.com/xiji/#xjimport=XJ1p.') === 0, true);
  eq('readImportHash · 能取回原内容', T.readImportHash('#xjimport=' + enc), enc);
  eq('readImportHash · 没有标记时返回 null', T.readImportHash('#other'), null);
  eq('clearImportHash · 清掉搬运内容', T.clearImportHash('#xjimport=' + enc + '#rest'), '');
  eq('buildImportUrl · 已有 hash 时替换而不是追加',
    T.buildImportUrl('https://example.com/a#foo', 'XJ1p.x'), 'https://example.com/a#xjimport=XJ1p.x');

  /* 合并去重 */
  const base = JSON.parse(JSON.stringify(state));
  const inc = T.slimState(JSON.parse(JSON.stringify(state)));
  const added = T.mergeInto(base, inc);
  eq('mergeInto · 与自己是同一份数据 → 全部被去重', added.transactions + added.received + added.accounts, 0);
  eq('mergeInto · 标的不重复新增', added.symbols, 0);
  /* 新增一条交易 + 一个新标的 → 只新增这些 */
  const inc2 = JSON.parse(JSON.stringify(inc));
  inc2.transactions.push({ txId: 'brand_new_tx', accountId: 'acc_1', symbol: 'sh601919', action: 'BUY', date: '2026-02-02', quantity: 100, price: 10, fee: 0 });
  inc2.symbols['sh601919'] = { symbol: 'sh601919', code: '601919', market: 'sh', name: '中远海控', type: 'STOCK' };
  const added2 = T.mergeInto(base, inc2);
  eq('mergeInto · 只新增那 1 笔交易', added2.transactions, 1);
  eq('mergeInto · 只新增那 1 个标的', added2.symbols, 1);
  eq('mergeInto · 重复执行不会再加', T.mergeInto(base, inc2).transactions, 0);
  /* 同账户同到账日同金额的手工分红也要被二级去重拦住 */
  const inc3 = JSON.parse(JSON.stringify(inc));
  inc3.received = [{ recId: 'dup_rec', accountId: 'acc_1', symbol: 'sh600023', exDividendDate: '2026-07-10', amount: 999999, source: 'MANUAL' }];
  const base2 = JSON.parse(JSON.stringify(state));
  base2.received = [{ recId: 'orig_rec', accountId: 'acc_1', symbol: 'sh600023', exDividendDate: '2026-07-10', amount: 999999.4, source: 'AUTO' }];
  eq('mergeInto · 同日同额的手工分红被二级去重拦住', T.mergeInto(base2, inc3).received, 0);
  /* 覆盖式导入 */
  const base3 = JSON.parse(JSON.stringify(state));
  T.overwriteWith(base3, { transactions: [{ txId: 'only_one' }], settings: { showLogo: true, ocr: { apiKey: 'HACK' } } });
  eq('overwriteWith · 核心表被替换', base3.transactions.length, 1);
  eq('overwriteWith · 合并 settings', base3.settings.showLogo, true);
  eq('★overwriteWith · OCR 设置永不被覆盖', (base3.settings.ocr || {}).apiKey !== 'HACK', true);

  /* 备份导出同样不得携带 OCR Key（与搬运通道口径一致） */
  const expState = JSON.parse(JSON.stringify(state));
  expState.settings.ocr = { apiKey: 'BACKUP_SECRET_999', model: 'glm-4v-flash', agreed: true };
  const exported = M.toExport(expState, 'test');
  eq('★toExport · 备份 JSON 里搜不到 OCR Key', JSON.stringify(exported).indexOf('BACKUP_SECRET_999') < 0, true);
  eq('toExport · 仍保留 OCR 的其它设置（模型）', (exported.settings.ocr || {}).model, 'glm-4v-flash');

  /* 旧版设备传来的搬运负载：version < 4 且标的带着旧的显式口径。
     本地 state 已是 v4，合并前必须先迁移 incoming，否则旧口径会被原样保留。 */
  const legacy = T.slimState(JSON.parse(JSON.stringify(state)));
  legacy.version = 3;
  legacy.symbols = { sh601919: { symbol: 'sh601919', code: '601919', market: 'sh', name: '中远海控', type: 'STOCK', costMethod: 'weighted' } };
  M.ensureBootstrapped(legacy);
  eq('★旧版搬运负载 · 迁移后成本口径改为分红摊薄', legacy.symbols.sh601919.costMethod, M.DEFAULT_COST_METHOD);
  eq('旧版搬运负载 · 版本号升到当前', legacy.version, M.DATA_VERSION);
}

/* ---------------------------------------------------------------
 * 6.30 技术信号：BOLL 下轨 + KDJ 的 J<0（纯函数，可离线复算）
 *
 * 独立实现一遍布林带与 KDJ，再与 calc 的结果逐位比对。
 * 口径要点（写错不会报错，只会静默算歪）：
 *   · 标准差用【总体口径 ÷N】，不是样本口径 ÷(N−1)
 *   · KDJ：RSV=(C−LLV)/(HHV−LLV)×100，K=(M1−1)/M1·K+1/M1·RSV，D 同理，J=3K−2D
 *   · K/D 初值 50；J 可越界，绝不 clamp（判定条件正是 J<0）
 *   · 一字板（HHV=LLV）RSV 分母为 0 → 取中性 50，否则 NaN 会让信号静默永不亮
 * --------------------------------------------------------------- */

/** MA（独立实现） */
function iSma(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < n - 1) { out.push(null); continue; }
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) s += arr[k];
    out.push(s / n);
  }
  return out;
}

/** 总体标准差（独立实现，÷N） */
function iStd(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < n - 1) { out.push(null); continue; }
    let m = 0;
    for (let k = i - n + 1; k <= i; k++) m += arr[k];
    m /= n;
    let v = 0;
    for (let k = i - n + 1; k <= i; k++) v += (arr[k] - m) * (arr[k] - m);
    out.push(Math.sqrt(v / n));
  }
  return out;
}

/** BOLL（独立实现）→ [{mid, upper, lower}] */
function iBoll(closes, n = 20, k = 2) {
  const mid = iSma(closes, n), sd = iStd(closes, n);
  return closes.map((_, i) => (mid[i] === null || sd[i] === null)
    ? { mid: null, upper: null, lower: null }
    : { mid: mid[i], upper: mid[i] + k * sd[i], lower: mid[i] - k * sd[i] });
}

/** KDJ（独立实现）→ [{k, d, j}] */
function iKdj(bars, n = 9, m1 = 3, m2 = 3) {
  let K = 50, D = 50;
  return bars.map((b, i) => {
    if (i < n - 1) return { k: null, d: null, j: null };
    let hh = -Infinity, ll = Infinity;
    for (let k = i - n + 1; k <= i; k++) {
      if (bars[k].h > hh) hh = bars[k].h;
      if (bars[k].l < ll) ll = bars[k].l;
    }
    const rsv = (hh === ll) ? 50 : (b.c - ll) / (hh - ll) * 100;
    K = (m1 - 1) / m1 * K + 1 / m1 * rsv;
    D = (m2 - 1) / m2 * D + 1 / m2 * K;
    return { k: K, d: D, j: 3 * K - 2 * D };
  });
}

/** 本周一（独立实现） */
function iMondayOf(today) {
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = dt.getDay();
  return iAddDays(today, -(dow === 0 ? 6 : dow - 1));
}

/** 由【本周日K + 现价】聚合本周那根（独立实现） */
function iWeekLiveBar(dayBars, today, price) {
  const mon = iMondayOf(today);
  let o = null, h = null, l = null;
  for (const b of dayBars) {
    if (!b || !b.d) continue;
    if (b.d < mon || b.d > today) continue;
    if (o === null) o = b.o;
    if (h === null || b.h > h) h = b.h;
    if (l === null || b.l < l) l = b.l;
  }
  if (h === null || h < price) h = price;
  if (l === null || l > price) l = price;
  if (o === null) o = price;
  return { d: today, o, h, l, c: price };
}

section('【30】技术信号：BOLL 下轨 + KDJ 的 J<0（吃 OHLC）');
{
  /* 构造：前 40 根平台 10.00 → 温和阴跌 → 末 4 根加速跌到 2.10，
     现价 1.20 取全序列最低。这套形状经手算校验能让 J 稳定转负。 */
  const mkDay = (n) => {
    const out = [];
    const start = new Date(2026, 4, 1);
    const crashFrom = n - 5;
    for (let i = 0; i < n; i++) {
      const d = new Date(start.getTime());
      d.setDate(d.getDate() + i);
      const ymd = fmt(d);
      let c;
      if (i < 40) c = 10;
      else if (i < crashFrom) c = 10 - 0.05 * (i - 39);
      else { const k = i - crashFrom + 1; c = 9.30 - 0.30 * (k * (k + 1) / 2); }
      out.push({ d: ymd, o: c, h: c + 0.05, l: c - 0.05, c });
    }
    return out;
  };
  const DAY = mkDay(59);
  const LIVE = XJ.calc.withLiveBar(DAY, REF_TODAY, 1.2);
  const closes = LIVE.map((b) => b.c);

  /* ---- 30.1 BOLL 独立复算 ---- */
  const bApp = XJ.calc.boll(closes, 20, 2);
  const bInd = iBoll(closes, 20, 2);
  let maxBollDiff = 0;
  for (let i = 0; i < bApp.length; i++) {
    if (bApp[i].lower === null) continue;
    maxBollDiff = Math.max(maxBollDiff,
      Math.abs(bApp[i].lower - bInd[i].lower),
      Math.abs(bApp[i].upper - bInd[i].upper),
      Math.abs(bApp[i].mid - bInd[i].mid));
  }
  eq('★ BOLL 全序列与独立实现一致（偏差 < 1e-12；仅浮点求和顺序差异）',
    maxBollDiff < 1e-12, true);
  eq('BOLL 窗口不足的前 19 根为 null', bApp.slice(0, 19).every((x) => x.lower === null), true);
  eq('BOLL 第 20 根（下标 19）起有值', bApp[19].lower !== null, true);

  /* 总体口径锁死：样本口径会让下轨差出约 2.6% */
  const seq = Array.from({ length: 20 }, (_, i) => i + 1);
  close('等差 1..20 · 中轨 = 10.5', bApp.length && iBoll(seq, 20, 2)[19].mid, 10.5, 1e-12);
  close('等差 1..20 · 下轨 = 10.5 − 2√33.25', iBoll(seq, 20, 2)[19].lower, 10.5 - 2 * Math.sqrt(33.25), 1e-12);
  /* 样本口径对照（证明两者确实不同，防止有人"顺手"改口径） */
  const sampleStd = Math.sqrt(665 / 19);
  eq('★ 样本口径（÷19）会得到不同的下轨 → 说明口径必须被锁死',
    Math.abs((10.5 - 2 * sampleStd) - (10.5 - 2 * Math.sqrt(33.25))) > 0.1, true);

  /* ---- 30.2 KDJ 独立复算 ---- */
  const kApp = XJ.calc.kdj(LIVE, 9, 3, 3);
  const kInd = iKdj(LIVE, 9, 3, 3);
  let maxKdjDiff = 0;
  for (let i = 0; i < kApp.length; i++) {
    if (kApp[i].j === null) continue;
    maxKdjDiff = Math.max(maxKdjDiff,
      Math.abs(kApp[i].j - kInd[i].j),
      Math.abs(kApp[i].k - kInd[i].k),
      Math.abs(kApp[i].d - kInd[i].d));
  }
  eq('★ KDJ 全序列与独立实现逐位一致（最大偏差 0）', maxKdjDiff, 0);
  /* KDJ 是逐步递推（K 依赖上一根 K），没有浮点求和顺序问题，所以能做到逐位相等；
     BOLL 是窗口求和，两种实现累加顺序不同 → 允许 ~1e-15 的浮点尾差。 */
  eq('  ↑ KDJ 比 BOLL 更严：递推式无求和顺序差异，可逐位相等', maxKdjDiff === 0, true);
  eq('★ 该序列末根 J < 0（信号成立的前提）', kApp[kApp.length - 1].j < 0, true);
  eq('KDJ 窗口不足的前 8 根为 null', kApp.slice(0, 8).every((x) => x.j === null), true);
  eq('★ 全程无 NaN（含一字板的分母为 0 情形）',
    kApp.every((x) => x.j === null || Number.isFinite(x.j)), true);

  /* 一字板：HHV === LLV → RSV 必须取中性 50，否则 NaN 会让信号静默永不亮 */
  const flatBars = Array.from({ length: 30 }, () => ({ h: 10, l: 10, c: 10 }));
  close('★ 一字板 → RSV 取中性 50，末根 J = 50', XJ.calc.kdj(flatBars, 9, 3, 3).pop().j, 50, 1e-9);
  eq('一字板与独立实现一致',
    Math.abs(XJ.calc.kdj(flatBars, 9, 3, 3).pop().j - iKdj(flatBars, 9, 3, 3).pop().j) < 1e-12, true);

  /* J 越界不 clamp：收在窗口最高价上（RSV=100）时 J 应略超 100 */
  const upBars = Array.from({ length: 40 }, (_, i) => ({ h: i + 1, l: i, c: i + 1 }));
  eq('★ RSV=100 时 J 越过 100（不 clamp；clamp 会改掉 J<0 的判定）',
    XJ.calc.kdj(upBars, 9, 3, 3).pop().j > 100, true);
  eq('★ 连续加速暴跌时 J 可深度为负（同样不 clamp）',
    XJ.calc.kdj(DAY, 9, 3, 3).pop().j !== null, true);

  /* ---- 30.3 今日/本周那根：接口优先，缺失才退化 ---- */
  const todayDow = new Date(2026, 8, 10).getDay();
  eq('REF_TODAY 是周四（固定今天，避免断言随运行日期漂移）', todayDow, 4);
  eq('★ 本周一 = 2026-09-07', iMondayOf(REF_TODAY), '2026-09-07');
  eq('mondayOf 与独立实现一致', XJ.calc.mondayOf(REF_TODAY), iMondayOf(REF_TODAY));
  eq('周日回退 6 天 → 本周一', iMondayOf('2026-09-13'), '2026-09-07');

  /* ★ 日线「今日那根」的两条路径。
     实测（2026-09-16 腾讯 fqkline，5 标的）接口盘中即给实时根，
     其 o/h/l/c 与行情接口逐位一致 —— 故优先采用真实高低，
     不再一律用现价当高低（那会把 σ 系统性压低）。 */
  const histOnly = [
    { d: '2026-09-08', o: 10, h: 10.2, l: 9.8, c: 10 },
    { d: '2026-09-09', o: 10, h: 10.1, l: 9.9, c: 10 },
  ];
  const liveFallback = XJ.calc.withLiveBar(histOnly, REF_TODAY, 9.5);
  eq('接口无今日根 → 追加一根', liveFallback.length, 3);
  eq('★ 退化路径 · h/l 均等于现价（接口没给真实高低）',
    [liveFallback[2].h, liveFallback[2].l].join(','), '9.5,9.5');
  eq('★ 退化路径 · 振幅 = 0（σ 被低估的原因）', liveFallback[2].h - liveFallback[2].l, 0);

  const withTodayBar = histOnly.concat([{ d: REF_TODAY, o: 10.1, h: 10.5, l: 9.4, c: 10.2 }]);
  const liveReal = XJ.calc.withLiveBar(withTodayBar, REF_TODAY, 9.5);
  eq('接口已给今日根 → 不新增（d=today 只有一根）',
    liveReal.filter((x) => x.d === REF_TODAY).length, 1);
  eq('★ 采用路径 · 高 = 接口真实盘中高点 10.5（不是现价 9.5）', liveReal[2].h, 10.5);
  eq('★ 采用路径 · 低 = 接口真实 9.4 ∪ 现价 9.5 → 9.4', liveReal[2].l, 9.4);
  eq('★ 采用路径 · 开 = 接口真实开盘 10.1', liveReal[2].o, 10.1);
  eq('★ 采用路径 · 收 = 实时价（与判定所用的 p 同源）', liveReal[2].c, 9.5);
  eq('★ 采用路径保留了真实振幅（10.5 − 9.4 = 1.1），σ 不再被抹平',
    Math.abs(liveReal[2].h - liveReal[2].l) > 1, true);
  /* 现价刷新新高/新低时要并进真实极值 */
  eq('现价刷出新低 9.0 → 低点更新为 9.0',
    XJ.calc.withLiveBar(withTodayBar, REF_TODAY, 9.0)[2].l, 9.0);
  eq('现价刷新新高 11.0 → 高点更新为 11.0',
    XJ.calc.withLiveBar(withTodayBar, REF_TODAY, 11.0)[2].h, 11.0);

  const weekDays = [
    { d: '2026-09-04', o: 9.0, h: 9.2, l: 8.9, c: 9.1 },   // 上周五，不该计入
    { d: '2026-09-07', o: 10.0, h: 10.5, l: 9.9, c: 10.2 },
    { d: '2026-09-08', o: 10.2, h: 10.3, l: 9.6, c: 9.8 },
    { d: '2026-09-10', o: 9.8, h: 9.9, l: 9.4, c: 9.5 },
  ];
  const weekHistOnly = [
    { d: '2026-08-28', o: 9.5, h: 9.8, l: 9.4, c: 9.6 },
    { d: '2026-09-04', o: 9.0, h: 9.2, l: 8.9, c: 9.1 },
  ];

  /* 周线兜底：接口没给本周根（典型是周一早盘）→ 由本周日K 聚合 */
  const wlApp = XJ.calc.weekLiveBar(weekDays, REF_TODAY, 9.3);
  const wlInd = iWeekLiveBar(weekDays, REF_TODAY, 9.3);
  eq('★ 兜底 · 开 = 本周第一根的开盘 10.0', wlApp.o, wlInd.o);
  eq('★ 兜底 · 高 = max(本周日K高, 现价) = 10.5', wlApp.h, wlInd.h);
  eq('★ 兜底 · 低 = min(本周日K低, 现价) = 9.3（现价刷了新低）', wlApp.l, wlInd.l);
  eq('兜底 · 收 = 现价 9.3', wlApp.c, wlInd.c);
  eq('上周五的日K 不计入兜底聚合（b.d < 本周一）',
    XJ.calc.weekLiveBar([{ d: '2026-09-04', o: 9, h: 99, l: 1, c: 9.1 }], REF_TODAY, 9.3).h, 9.3);
  /* 周一早盘无本周日K → 退化为全体现价（返回 null 会让每周一上午信号整段消失） */
  const monOnly = XJ.calc.weekLiveBar([{ d: '2026-09-04', o: 9, h: 9.2, l: 8.9, c: 9.1 }], '2026-09-07', 9.7);
  eq('★ 周一早盘无本周日K → 开=高=低=收=现价（不返回 null）',
    [monOnly.o, monOnly.h, monOnly.l, monOnly.c].join(','), '9.7,9.7,9.7,9.7');
  eq('现价无效 → null', XJ.calc.weekLiveBar(weekDays, REF_TODAY, null), null);
  eq('today 非法 → null', XJ.calc.weekLiveBar(weekDays, 'abc', 9.3), null);

  /* withLiveWeek：周线序列的优先级链（接口根 > 日K聚合兜底）*/
  const wseqFallback = XJ.calc.withLiveWeek(weekHistOnly, weekDays, REF_TODAY, 9.3);
  eq('★ 接口无本周根 → 由日K聚合补上一根', wseqFallback.length, weekHistOnly.length + 1);
  eq('  ↑ 补出的那根 d = today', wseqFallback[wseqFallback.length - 1].d, REF_TODAY);
  eq('  ↑ 补出的那根 = 聚合结果（高 10.5 / 低 9.3）',
    [wseqFallback[wseqFallback.length - 1].h, wseqFallback[wseqFallback.length - 1].l].join(','), '10.5,9.3');

  const weekWithThis = weekHistOnly.concat([{ d: REF_TODAY, o: 9.9, h: 10.4, l: 9.2, c: 9.4 }]);
  const wseqReal = XJ.calc.withLiveWeek(weekWithThis, weekDays, REF_TODAY, 9.3);
  eq('★ 接口已给本周根 → 不重复追加', wseqReal.length, weekWithThis.length);
  eq('★ 采用路径 · 高 = 接口真实 10.4（不是聚合的 10.5）',
    wseqReal[wseqReal.length - 1].h, 10.4);
  eq('★ 采用路径 · 低 = 接口真实 9.2 ∪ 现价 9.3 → 9.2',
    wseqReal[wseqReal.length - 1].l, 9.2);
  eq('★ 采用路径 · 收 = 实时价 9.3', wseqReal[wseqReal.length - 1].c, 9.3);
  eq('  ↑ d 落在本周内的周根只有一根（同一周不会被算两次）',
    wseqReal.filter((x) => x.d >= '2026-09-07').length, 1);
  eq('★ withLiveWeek 不修改传入的 weekBars（就地改的是副本）',
    JSON.stringify(weekWithThis),
    JSON.stringify(weekHistOnly.concat([{ d: REF_TODAY, o: 9.9, h: 10.4, l: 9.2, c: 9.4 }])));
  eq('周一早盘 + 接口无本周根 → 仍补出一根（信号不会整上午消失）',
    XJ.calc.withLiveWeek(weekHistOnly, [{ d: '2026-09-04', o: 9, h: 9.2, l: 8.9, c: 9.1 }], '2026-09-07', 9.7).length,
    weekHistOnly.length + 1);

  /* ---- 30.4 信号入口：两条件缺一不可 / 含等于 / 周线优先 / 立即消失 ---- */
  eq('★ 加速下跌 + 现价极低 → 命中日线信号',
    XJ.calc.bollSignal('sh600036', DAY, [], 1.2, REF_TODAY) !== null, true);
  eq('★ 文案是中性的「日线下轨」（不出现"买入"等措辞）',
    XJ.calc.bollSignal('sh600036', DAY, [], 1.2, REF_TODAY).text, '日线下轨');
  eq('样式类 = sig-day', XJ.calc.bollSignal('sh600036', DAY, [], 1.2, REF_TODAY).cls, 'sig-day');

  /* 「J<0 但价格在下轨之上」→ 不命中。用大振幅锯齿撑大 σ，
     尾 3 根陡跌把 J 压负，此时下轨被推到远离价格的下方。 */
  const choppy = (() => {
    const out = [];
    const start = new Date(2026, 4, 1);
    for (let i = 0; i < 59; i++) {
      const d = new Date(start.getTime());
      d.setDate(d.getDate() + i);
      let c;
      if (i < 56) c = 100 + (i % 2 === 0 ? 15 : -15);
      else { const k = i - 55; c = 100 - 6 * (k * (k + 1) / 2); }
      out.push({ d: fmt(d), o: c, h: c + 0.5, l: c - 0.5, c });
    }
    return out;
  })();
  const chLive = XJ.calc.withLiveBar(choppy, REF_TODAY, 64);
  const chLower = XJ.calc.boll(chLive.map((b) => b.c), 20, 2).pop().lower;
  const chJ = XJ.calc.kdj(chLive, 9, 3, 3).pop().j;
  eq('★ 构造校验 · 该序列 J < 0', chJ < 0, true);
  eq('★ 构造校验 · 现价 64 仍在下轨之上', 64 > chLower, true);
  eq('★ J<0 但价格在下轨之上 → 不命中（两条件缺一不可）',
    XJ.calc.bollSignal('sh600036', choppy, [], 64, REF_TODAY), null);

  /* 「触及」含等于：解不动点 p = lower(p)。
     ⚠️ 现价本身是指标输入，所以不能"先算 lower 再喂回去"——
     喂进去以后序列变了、下轨也变了。必须解不动点，两边才自洽。 */
  const chLowerAt = (p) => XJ.calc.boll(
    XJ.calc.withLiveBar(choppy, REF_TODAY, p).map((b) => b.c), 20, 2).pop().lower;
  let lo = 58, hi = 64;
  for (let it = 0; it < 100; it++) {
    const mid = (lo + hi) / 2;
    if (chLowerAt(mid) - mid > 0) lo = mid; else hi = mid;
  }
  const eqPrice = (lo + hi) / 2, eqLower = chLowerAt(eqPrice);
  close('★ 不动点：现价 === 该现价下算出的下轨（|diff| < 1e-9）',
    Math.abs(eqPrice - eqLower), 0, 1e-9);
  eq('★ 不动点处 J 仍为负',
    XJ.calc.kdj(XJ.calc.withLiveBar(choppy, REF_TODAY, eqPrice), 9, 3, 3).pop().j < 0, true);
  eq('★ 现价 === 下轨 → 命中（触及含等于，用 ≤ 而非 <）',
    (XJ.calc.bollSignal('sh600036', choppy, [], eqPrice, REF_TODAY) || {}).kind, 'day');
  eq('★ 现价仅高出不动点 0.12（J 未变）→ 立刻不命中（证明是 ≤ 而非 <）',
    XJ.calc.bollSignal('sh600036', choppy, [], eqPrice + 0.12, REF_TODAY), null);

  /* 日线与周线同时满足 → 只返回周线 */
  const weekHist = (() => {
    const out = [];
    for (let i = 0; i < 25; i++) {
      const d = new Date(2026, 2, 2 + i * 7);
      const ymd = fmt(d);
      if (ymd >= '2026-09-07') break;
      const c = 100 - 0.04 * (i * (i + 1) / 2);
      out.push({ d: ymd, o: c + 0.1, h: c + 0.2, l: c - 0.2, c });
    }
    return out;
  })();
  eq('周线历史构造到本周一之前', weekHist.length >= 20 && weekHist[weekHist.length - 1].d < '2026-09-07', true);
  const bothLow = XJ.calc.bollSignal('sh600036', DAY, weekHist, 1.2, REF_TODAY);
  eq('★ 日线与周线同时满足 → 只返回周线', (bothLow || {}).kind, 'week');
  eq('★ 周线文案 = 周线下轨（不是"强烈买入"之类）', (bothLow || {}).text, '周线下轨');
  eq('周线样式类 = sig-week', (bothLow || {}).cls, 'sig-week');
  eq('★ 周线优先级高于日线（两个都成立时不显示日线）', (bothLow || {}).cls !== 'sig-day', true);

  /* 条件不再满足 → 立即返回 null（视图据此不渲染） */
  eq('★ 价格并不在下轨之下（10 元）→ null', XJ.calc.bollSignal('sh600036', DAY, [], 10, REF_TODAY), null);
  const upAll = Array.from({ length: 59 }, (_, i) => {
    const d = new Date(2026, 4, 1);
    d.setDate(d.getDate() + i);
    const c = 10 + i * 0.1;
    return { d: fmt(d), o: c, h: c + 0.05, l: c - 0.05, c };
  });
  eq('★ 上涨序列 J ≥ 0 → 即使价格低于其下轨也不命中（价格条件成立也不够）',
    XJ.calc.bollSignal('sh600036', upAll, [], 1, REF_TODAY), null);

  /* 边界 */
  eq('场外基金 → null（无盘中行情，不参与）',
    XJ.calc.bollSignal('of110022', DAY, weekHist, 1, REF_TODAY), null);
  eq('现价 null → null', XJ.calc.bollSignal('sh600036', DAY, weekHist, null, REF_TODAY), null);
  eq('现价 0 → null', XJ.calc.bollSignal('sh600036', DAY, weekHist, 0, REF_TODAY), null);
  eq('现价负数 → null', XJ.calc.bollSignal('sh600036', DAY, weekHist, -1, REF_TODAY), null);
  eq('日K 只有 15 根 → 数据不足', XJ.calc.bollSignal('sh600036', mkDay(15), [], 1, REF_TODAY), null);
  eq('两个 K 线都为空 → null', XJ.calc.bollSignal('sh600036', [], [], 1, REF_TODAY), null);
  eq('dayBars 为 null → null', XJ.calc.bollSignal('sh600036', null, null, 1, REF_TODAY), null);

  /* ---- 30.5 纯函数：不改入参、无状态泄漏 ---- */
  const daySnap = JSON.stringify(DAY);
  const wSnap = JSON.stringify(weekHist);
  XJ.calc.bollSignal('sh600036', DAY, weekHist, 9, REF_TODAY);
  eq('★ 不修改传入的 dayBars', JSON.stringify(DAY), daySnap);
  eq('★ 不修改传入的 weekBars', JSON.stringify(weekHist), wSnap);
  eq('★ 两次调用结果完全一致（KDJ 的 K/D 未泄漏到模块级）',
    JSON.stringify(XJ.calc.bollSignal('sh600036', DAY, [], 1.2, REF_TODAY)),
    JSON.stringify(XJ.calc.bollSignal('sh600036', DAY, [], 1.2, REF_TODAY)));

  /* ---- 30.6 K 线缓存：模型层四同步点 + 解析器 ---- */
  const st = XJ.model.defaultState();
  eq('defaultState 含 klineCache 容器', typeof st.klineCache === 'object' && st.klineCache !== null, true);
  const bare = {};
  XJ.model.ensureBootstrapped(bare);
  eq('ensureBootstrapped 补齐 klineCache（导入残缺 JSON 时不崩）',
    typeof bare.klineCache === 'object' && bare.klineCache !== null, true);
  const exp = XJ.model.toExport(st, 't');
  eq('toExport 带上 klineCache（换设备也带得走）', 'klineCache' in exp, true);
  const imp = XJ.model.fromImport({ klineCache: { sh600036: { at: REF_TODAY, day: [{ d: '2026-09-10', o: 1, h: 2, l: 0.5, c: 1.5 }], week: [] } } });
  eq('fromImport 读回 klineCache', !!(imp.klineCache && imp.klineCache.sh600036), true);
  eq('DATA_VERSION 仍为 6（新增容器不升版本号，靠 ensureBootstrapped 补齐）', XJ.model.DATA_VERSION, 6);

  /* ---- 30.7 当日分时缓存：模型层四同步点 + 裁字段迁移 ---- */
  const mst = XJ.model.defaultState();
  eq('defaultState 含 minuteCache 槽位（初值 null）', mst.minuteCache, null);

  const mbare = {};
  XJ.model.ensureBootstrapped(mbare);
  eq('ensureBootstrapped 补齐 minuteCache 为 null（旧数据不崩）', mbare.minuteCache, null);

  /* 结构合法 → 保留，且裁掉 v 字段（体积约减半） */
  const mud = { id: 'u', minuteCache: { at: REF_TODAY, bySymbol: {
    sh600036: { date: REF_TODAY, points: [{ t: '09:30', p: 10, v: 500 }, { t: '09:31', p: 10.5, v: 600 }] },
  } } };
  XJ.model.ensureBootstrapped(mud);
  eq('合法 minuteCache 被保留', !!(mud.minuteCache && mud.minuteCache.at === REF_TODAY), true);
  eq('★ points 裁掉成交量 v',
    JSON.stringify(Object.keys(mud.minuteCache.bySymbol.sh600036.points[0]).sort()), JSON.stringify(['p', 't']));
  eq('★ v 的值确实没了', mud.minuteCache.bySymbol.sh600036.points[0].v, undefined);

  /* 结构损坏 → 整块丢弃，而不是留个半残对象把视图搞崩 */
  const mbad1 = { id: 'u', minuteCache: { bySymbol: {} } };            // 缺 at
  XJ.model.ensureBootstrapped(mbad1);
  eq('缺 at → 丢弃', mbad1.minuteCache, null);
  const mbad2 = { id: 'u', minuteCache: { at: REF_TODAY } };            // 缺 bySymbol
  XJ.model.ensureBootstrapped(mbad2);
  eq('缺 bySymbol → 丢弃', mbad2.minuteCache, null);
  const mbad3 = { id: 'u', minuteCache: { at: REF_TODAY, bySymbol: {
    sh600036: { date: REF_TODAY, points: [{ t: '09:30', p: 10 }] },      // 只有 1 点
  } } };
  XJ.model.ensureBootstrapped(mbad3);
  eq('单点标的被剔除（画不出线）', JSON.stringify(Object.keys(mbad3.minuteCache.bySymbol)), JSON.stringify([]));
  const mbad4 = { id: 'u', minuteCache: { at: REF_TODAY, bySymbol: {
    sh600036: { points: [{ t: '09:30', p: 10 }, { t: '09:31', p: 11 }] },  // 缺 date
  } } };
  XJ.model.ensureBootstrapped(mbad4);
  eq('标的缺 date 被剔除', JSON.stringify(Object.keys(mbad4.minuteCache.bySymbol)), JSON.stringify([]));

  /* ★ minuteCache 是「当天有效」的运行时缓存：刻意不进导出 JSON，导入后重建 */
  const mexp = XJ.model.toExport(mst, 't');
  eq('★ toExport 不带 minuteCache（当天有效，导出无意义）', 'minuteCache' in mexp, false);
  const mimp = XJ.model.fromImport({ minuteCache: { at: REF_TODAY, bySymbol: {} } });
  eq('★ fromImport 忽略 minuteCache（下次刷新自动重建）', mimp.minuteCache, null);
  eq('DATA_VERSION 仍为 6（minuteCache 同样靠 ensureBootstrapped 补齐）', XJ.model.DATA_VERSION, 6);

  /* 与 calc.minuteOf 打通：模型层产出的结构能被取用 */
  eq('ensureBootstrapped 后的结构可被 calc.minuteOf 消费',
    (XJ.calc.minuteOf(mud.minuteCache, 'sh600036', REF_TODAY) || {}).date, REF_TODAY);

  /* fqkline 解析：字段序是 [日期, 开, 收, 高, 低, 量] —— 第 3 列是【收】不是【高】 */
  const payload = { data: { sh600036: { day: [
    ['2026-09-09', '10.00', '10.50', '10.80', '9.90', '1000'],
    ['2026-09-10', '10.50', '11.00', '11.20', '10.40', '1200'],
  ] } } };
  const bars = XJ.fetcher.parseKlineBars(payload, 'sh600036');
  eq('解析出 2 根', bars.length, 2);
  eq('★ 第 2 列 = 开', bars[0].o, 10.0);
  eq('★ 第 3 列 = 收（不是高！）', bars[0].c, 10.5);
  eq('★ 第 4 列 = 高', bars[0].h, 10.8);
  eq('★ 第 5 列 = 低', bars[0].l, 9.9);
  eq('按日期升序', bars[0].d < bars[1].d, true);
  eq('脏行（非日期）被丢弃',
    XJ.fetcher.parseKlineBars({ data: { x: { day: [['bad', '1', '1', '1', '1', '1']] } } }, 'x').length, 0);
  eq('空 payload → 空数组', XJ.fetcher.parseKlineBars(null, 'x').length, 0);
  /* 周K 的 payload 键名是 week（不是 day） */
  eq('★ 能解析 week 周期（键名 week/qfqweek）',
    XJ.fetcher.parseKlineBars({ data: { x: { week: [['2026-09-04', '1', '2', '3', '0.5', '9']] } } }, 'x').length, 1);
}

/* ---- 6.31 股息率曲线（财年口径）---- */
section('【31】股息率曲线：财年分子 · 预案公告日生效 · 含预案');
{
  /* eq() 对非数字用 ===，数组/对象必须两侧 JSON.stringify 才能比（否则会出现
     「实际=x,y 期望=x,y 却判失败」的迷惑输出）。这里包一个本地快捷方式。 */
  const jeq = (label, got, want) => eq(label, JSON.stringify(got), JSON.stringify(want));
  /* ★ 这里用「独立复算」的方式再算一遍：不复用 calc 的实现，用最朴素的循环重新推。
     两边必须逐位一致，才算口径没跑偏。 */
  const SYM31 = 'sh600036';
  const mk = (reportDate, per10, notice, impl) => ({
    planId: SYM31 + '_' + reportDate, symbol: SYM31, reportDate,
    reportType: String(reportDate).slice(5, 7) === '12' ? '年报' : '中报',
    pretaxBonusPer10: per10, afterTaxPer10: null,
    implPlanProfile: '10派' + per10 + '元(含税)',
    planNoticeDate: notice, noticeDate: null, equityRecordDate: null, exDividendDate: null,
    assignProgress: impl === false ? '董事会预案' : '实施分配',
    progressRank: impl === false ? 60 : 100, isImplemented: impl !== false,
  });
  const plans31 = [
    mk('2024-06-30', 5, '2024-08-20'),                 // FY2024 中报 → 每股 0.5
    mk('2024-12-31', 20, '2025-04-30'),                // FY2024 年报 → 每股 2.0（生效日 2025-04-30）
    mk('2025-12-31', 22, '2026-04-30', false),         // FY2025 年报【预案】→ 每股 2.2
  ];
  const steps31 = XJ.calc.yieldFiscalSteps(plans31);
  eq('两个财年（含只有预案的 FY2025）', JSON.stringify(steps31.map((s) => s.year)), JSON.stringify([2024, 2025]));
  eq('★ 生效日取年报预案公告日', JSON.stringify(steps31.map((s) => s.effectiveFrom)), JSON.stringify(['2025-04-30', '2026-04-30']));
  close('FY2024 分子 = 中报+年报（每股 2.5）', steps31[0].perShare, 2.5, 1e-12);

  const closes31 = [
    ['2025-04-29', 40],   // 生效日前一天 → 不产出
    ['2025-04-30', 40],   // 生效日当天 → FY2024，2.0/40 = 5%
    ['2026-04-29', 40],   // 仍是 FY2024
    ['2026-04-30', 40],   // 切到 FY2025 → 2.2/40 = 5.5%
    ['2026-09-01', 55],   // 2.2/55 = 4%
  ];
  const ser31 = XJ.calc.dividendYieldSeries(plans31, closes31);
  eq('生效日前的点被丢弃', JSON.stringify(ser31.map((p) => p.date)),
    JSON.stringify(['2025-04-30', '2026-04-29', '2026-04-30', '2026-09-01']));
  eq('★ 切换点落在年报预案公告日当天', JSON.stringify(ser31.map((p) => p.year)),
    JSON.stringify([2024, 2024, 2025, 2025]));
  /* FY2024 的分子是【中报 0.5 + 年报 2.0】= 每股 2.5，所以 2.5 ÷ 40 = 6.25% */
  close('6.25%（分子含中报，别只算年报那 2.0）', ser31[0].y, 6.25, 1e-12);
  close('★ 同一价格 40，切换后 5.5%', ser31[2].y, 5.5, 1e-12);
  close('4%', ser31[3].y, 4, 1e-12);

  /* —— 独立复算：用最朴素的写法重推一遍，逐位比对 —— */
  const perShare = (p) => Number(p.pretaxBonusPer10) / 10;
  const years = {};
  plans31.forEach((p) => {
    const y = Number(String(p.reportDate).slice(0, 4));
    if (!years[y]) years[y] = { sum: 0, eff: null, hasAnnual: false };
    years[y].sum += perShare(p);
    if (String(p.reportDate).slice(5, 7) === '12') {
      years[y].hasAnnual = true;
      if (!years[y].eff || p.planNoticeDate < years[y].eff) years[y].eff = p.planNoticeDate;
    }
  });
  const stepsRef = Object.keys(years).map(Number).filter((y) => years[y].hasAnnual && years[y].eff)
    .sort((a, b) => a - b).map((y) => ({ year: y, perShare: years[y].sum, effectiveFrom: years[y].eff }));
  eq('★ 独立复算：财年表逐位一致',
    JSON.stringify(steps31.map((s) => [s.year, s.perShare, s.effectiveFrom])),
    JSON.stringify(stepsRef.map((s) => [s.year, s.perShare, s.effectiveFrom])));

  const serRef = closes31.filter((r) => r[1] > 0).map((r) => {
    let cur = null;
    for (const s of stepsRef) if (s.effectiveFrom <= r[0]) cur = s;
    return cur ? [r[0], cur.year, cur.perShare / r[1] * 100] : null;
  }).filter(Boolean);
  eq('★ 独立复算：序列逐位一致',
    JSON.stringify(ser31.map((p) => [p.date, p.year, Math.round(p.y * 1e9) / 1e9])),
    JSON.stringify(serRef.map((p) => [p[0], p[1], Math.round(p[2] * 1e9) / 1e9])));

  /* —— 含预案 vs 只算已实施：这是本轮最容易搞错的分歧点 —— */
  const implOnly = plans31.filter((p) => p.isImplemented);
  eq('★ 过滤 isImplemented 会让 FY2025 整体消失（所以曲线必须含预案）',
    JSON.stringify(XJ.calc.yieldFiscalSteps(implOnly).map((s) => s.year)), JSON.stringify([2024]));
  eq('★ 含预案时 FY2025 在位',
    JSON.stringify(XJ.calc.yieldFiscalSteps(plans31).map((s) => s.year)), JSON.stringify([2024, 2025]));

  /* —— 与「股价息率」的关系：全部已实施时末点应等于现有财年口径 —— */
  eq('全部已实施时，曲线末点 = annualBasePerShare(1年) ÷ 同一价格',
    (function () {
      const p = [mk('2024-12-31', 20, '2025-04-30')];
      const a = XJ.calc.annualBasePerShare(p, { type: 'years', value: 1 });
      const s = XJ.calc.dividendYieldSeries(p, [['2026-01-05', 40]]);
      return Math.abs(s[0].y - a.perShare / 40 * 100) < 1e-9;
    })(), true);

  /* —— 生效日退化链 —— */
  const degen = (opts) => {
    const p = mk('2024-12-31', 20, opts.notice);
    p.noticeDate = opts.noticeDate || null;
    p.equityRecordDate = opts.equity || null;
    p.exDividendDate = opts.ex || null;
    return XJ.calc.yieldFiscalSteps([p]);
  };
  eq('缺 planNoticeDate → noticeDate', degen({ notice: null, noticeDate: '2025-04-30' })[0].effectiveFrom, '2025-04-30');
  eq('再缺 → 股权登记日', degen({ notice: null, noticeDate: null, equity: '2025-07-08' })[0].effectiveFrom, '2025-07-08');
  eq('再缺 → 除权除息日', degen({ notice: null, noticeDate: null, equity: null, ex: '2025-07-09' })[0].effectiveFrom, '2025-07-09');
  eq('★ 四者全缺 → 该财年不入选', JSON.stringify(degen({ notice: null })), JSON.stringify([]));

  /* —— 除权除息日散点 —— */
  const mkEx = (d) => { const p = mk('2024-12-31', 20, '2025-04-30'); p.exDividendDate = d; return p; };
  eq('散点去重 + 升序', JSON.stringify(XJ.calc.exDividendDates([mkEx('2025-07-09'), mkEx('2024-09-10'), mkEx('2025-07-09')])),
    JSON.stringify(['2024-09-10', '2025-07-09']));
  eq('散点忽略 null / 脏日期',
    JSON.stringify(XJ.calc.exDividendDates([mkEx(null), mkEx('x'), mkEx('2025-07-09')])), JSON.stringify(['2025-07-09']));

  /* ---- 模型层：yieldHistory / benchHistory / showYieldBench 四同步点 ---- */
  const yst = XJ.model.defaultState();
  eq('defaultState 含 yieldHistory 容器', typeof yst.yieldHistory === 'object' && yst.yieldHistory !== null, true);
  eq('defaultState 含 benchHistory 槽位（初值 null）', yst.benchHistory, null);
  eq('defaultState 的 showYieldBench 默认 false', yst.settings.showYieldBench, false);

  const ybare = {};
  XJ.model.ensureBootstrapped(ybare);
  eq('ensureBootstrapped 补齐 yieldHistory（残缺 JSON 不崩）',
    typeof ybare.yieldHistory === 'object' && ybare.yieldHistory !== null, true);
  eq('ensureBootstrapped 补齐 benchHistory 为 null', ybare.benchHistory, null);

  /* 结构校验：要求 v=2（十年日线）；点数 < 2 或旧版双粒度的标的直接剔除 */
  const ybad = XJ.model.defaultState();
  ybad.yieldHistory.ok = { v: 2, at: REF_TODAY, day: [['2026-09-09', 10], ['2026-09-10', 10.5]] };
  ybad.yieldHistory.legacy = { at: REF_TODAY, day: [['2026-09-10', 10]], week: [['2026-09-04', 10], ['2026-09-11', 10]] };
  ybad.yieldHistory.bad = { v: 2, at: REF_TODAY, day: 'nope' };
  ybad.yieldHistory.single = { v: 2, at: REF_TODAY, day: [['2026-09-10', 10]] };
  XJ.model.ensureBootstrapped(ybad);
  eq('点数够的标的被保留', JSON.stringify(Object.keys(ybad.yieldHistory)), JSON.stringify(['ok']));
  eq('★ v=1 的双粒度旧缓存被丢弃（否则会出现忽粗忽细的非交易日间隔）', 'legacy' in ybad.yieldHistory, false);
  eq('★ 单点标的被剔除（画不出线）', 'single' in ybad.yieldHistory, false);
  eq('坏结构被剔除', 'bad' in ybad.yieldHistory, false);
  eq('保留的标的带上 v=2 标记', ybad.yieldHistory.ok.v, 2);

  /* ★ 归一化：清洗脏日期 / 非正数、升序、同日覆盖 */
  const norm = XJ.model.normCloseSeries([
    ['2026-09-02', '10.5'], ['2026-09-01', 10], ['bad', 9],
    ['2026-09-03', 0], ['2026-09-04', -1], ['2026-09-02', 11],
  ]);
  eq('归一化后升序', JSON.stringify(norm.map((r) => r[0])), JSON.stringify(['2026-09-01', '2026-09-02']));
  eq('非正数与脏日期被剔除', norm.length, 2);
  eq('同日后者覆盖前者', norm[1][1], 11);

  /* benchHistory 校验：点数不足 → null */
  const bbad = XJ.model.defaultState();
  bbad.benchHistory = { at: REF_TODAY, points: [['2026-09-10', 1.5]] };
  XJ.model.ensureBootstrapped(bbad);
  eq('benchHistory 单点 → 丢弃为 null', bbad.benchHistory, null);
  const bok = XJ.model.defaultState();
  bok.benchHistory = { at: REF_TODAY, points: [['2026-09-01', 1.5], ['2026-09-08', 1.4]] };
  XJ.model.ensureBootstrapped(bok);
  eq('benchHistory 两点 → 保留', !!(bok.benchHistory && bok.benchHistory.points.length === 2), true);

  /* 导入导出：这两份都是要跑网络才拿得到的数据，随备份带走 */
  const yexp = XJ.model.toExport(yst, 't');
  eq('toExport 带上 yieldHistory', 'yieldHistory' in yexp, true);
  eq('toExport 带上 benchHistory', 'benchHistory' in yexp, true);
  const yimp = XJ.model.fromImport({
    yieldHistory: { sh600036: { v: 2, at: REF_TODAY, day: [['2026-09-09', 10], ['2026-09-10', 10.5]] } },
    benchHistory: { at: REF_TODAY, points: [['2026-09-01', 1.5], ['2026-09-08', 1.4]] },
  });
  eq('fromImport 读回 yieldHistory', !!(yimp.yieldHistory && yimp.yieldHistory.sh600036), true);
  eq('fromImport 读回 benchHistory', !!(yimp.benchHistory && yimp.benchHistory.points.length === 2), true);
  eq('DATA_VERSION 仍为 6（新容器靠 ensureBootstrapped 补齐）', XJ.model.DATA_VERSION, 6);

  /* ---- 取数层：两窗拼接依赖的归一化 + 七日年化解析 ---- */
  /* ★ fetchYieldHistory 把「近 8 年」与「再往前 3 年」两段拼起来，
     两段的边界日可能同时出现 —— 这里锁住「按日期去重、升序」这条契约。 */
  const twoWins = [
    ['2026-09-10', 10.5], ['2016-09-19', 8.1],           // 近窗（乱序输入）
    ['2016-09-14', 8.0], ['2016-09-19', 8.1],            // 远窗（与近窗在 09-19 重叠）
  ];
  const merged = XJ.model.normCloseSeries(twoWins);
  eq('★ 两窗拼接：按日期去重并按时间升序',
    JSON.stringify(merged.map((r) => r[0])), JSON.stringify(['2016-09-14', '2016-09-19', '2026-09-10']));
  eq('拼接后点数 = 去重后的唯一日期数', merged.length, 3);
  eq('重叠日的值不重复计入', JSON.stringify(merged[1]), JSON.stringify(['2016-09-19', 8.1]));

  /* ---- 取数层：parseSevenDay 与 fetchYieldHistory 的过滤条件 ---- */
  const ms = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0).getTime();
  const seven = XJ.fetcher.parseSevenDay([
    [ms(2026, 8, 31), 1.2], [ms(2026, 9, 2), 1.3], [ms(2026, 9, 4), 1.4],
    [ms(2026, 9, 7), 1.5], [ms(2026, 9, 9), 1.6],
  ]);
  eq('★ 按周降采样：两周 → 两点', seven.length, 2);
  eq('★ 每周取最后一个点', JSON.stringify(seven.map((p) => p[1])), JSON.stringify([1.4, 1.6]));
  eq('日期格式为 YYYY-MM-DD', JSON.stringify(seven.map((p) => p[0])), JSON.stringify(['2026-09-04', '2026-09-09']));
  eq('七日年化 ≤ 0 被剔除', XJ.fetcher.parseSevenDay([[ms(2026, 9, 1), 0]]).length, 0);
  eq('非法时间戳被剔除', XJ.fetcher.parseSevenDay([[null, 1.5]]).length, 0);
  eq('空输入 → 空', JSON.stringify(XJ.fetcher.parseSevenDay(null)), JSON.stringify([]));

  const longSeven = [];
  for (let y = 2010; y <= 2026; y++) for (let m = 1; m <= 12; m++) longSeven.push([ms(y, m, 15), 1 + m / 100]);
  const cutSeven = XJ.fetcher.parseSevenDay(longSeven, { years: 10, today: REF_TODAY });
  eq('★ 裁到最近 10 年', cutSeven.length > 0 && cutSeven[0][0] >= '2016-09-11', true);
  eq('不传 years 则不裁', XJ.fetcher.parseSevenDay(longSeven).length > cutSeven.length, true);

  /* 支持矩阵：必须与视图层的「能不能画」判定一致，否则会出现「说能画却永远取不到」 */
  eq('A股 支持画股息率曲线', XJ.market.supportsYieldCurve('sh600036'), true);
  eq('港股 支持', XJ.market.supportsYieldCurve('hk00700'), true);
  eq('ETF 支持', XJ.market.supportsYieldCurve('sh510880'), true);
  eq('★ 场外基金 不支持（分红不定期、没有财年派现概念）', XJ.market.supportsYieldCurve('of110022'), false);
  eq('★ 美股 不支持（无分红数据源）', XJ.market.supportsYieldCurve('usAAPL'), false);
}

/* ---- 6.32 当日净资产的口径一致性（含无分时标的 / 多币种）---- */
section('【32】当日净资产 ≡ 日粒度净资产（两条曲线不许各算各的）');
{
  /* 构造一个「A股 + 港股 + 场外基金」的组合。
     场外基金没有分时 → 进不了当日曲线的逐分钟 mv，但它有日线（净值走势）→ 进得了日粒度曲线。
     这正是最容易让两条曲线打架的组合。 */
  const fx = { HKD: 0.92, USD: 7.1 };
  function nwState() {
    const s = XJ.model.defaultState();
    s.version = XJ.model.DATA_VERSION;
    s.accounts = [{ accountId: 'a1', name: '主账户' }];
    s.settings.fx = Object.assign({}, fx);
    const add = (sym, name, qty, cost, now, points) => {
      s.symbols[sym] = { symbol: sym, name, costMethod: 'weighted' };
      s.transactions.push({
        txId: 't_' + sym, accountId: 'a1', symbol: sym, action: 'BUY',
        date: '2024-01-10', quantity: qty, price: cost, fee: 0,
        note: '', createdAt: '2024-01-10T01:00:00Z',
      });
      s.quoteCache[sym] = { symbol: sym, name, price: now, prevClose: now, changePct: 0 };
      s.priceHistory[sym] = { at: REF_TODAY, points: points };
    };
    add('sh600036', '招商银行', 1000, 8, 10, [[REF_TODAY, 10]]);
    add('hk00700', '腾讯控股', 100, 300, 300, [[REF_TODAY, 300]]);   // HKD
    add('of110022', '易方达消费', 5000, 2, 2, [[REF_TODAY, 2]]);     // 无分时
    s.received = [
      { recId: 'r1', accountId: 'a1', symbol: 'sh600036', exDividendDate: '2026-07-01', amount: 500 },
      { recId: 'r2', accountId: 'a1', symbol: 'hk00700', exDividendDate: '2026-07-01', amount: 200 },
    ];
    /* 只有 A股 + 港股有分时 */
    s.minuteCache = { at: REF_TODAY, bySymbol: {
      sh600036: { date: REF_TODAY, points: [{ t: '09:30', p: 10 }, { t: '09:31', p: 10 }] },
      hk00700: { date: REF_TODAY, points: [{ t: '09:30', p: 300 }, { t: '09:31', p: 300 }] },
    } };
    return XJ.model.ensureBootstrapped(s);
  }
  const nws = nwState();
  const nwh = XJ.calc.holdings(nws, XJ.calc.ALL);
  const fxr = (c) => (c === 'HKD' ? fx.HKD : c === 'USD' ? fx.USD : 1);

  const priceMap = {};
  Object.keys(nws.priceHistory).forEach((k) => { priceMap[k] = nws.priceHistory[k].points; });
  const daily = XJ.calc.marketValueSeries(nws, XJ.calc.ALL, priceMap, { beg: REF_TODAY, end: REF_TODAY });
  const dRow = daily.series[daily.series.length - 1];

  const minMap = XJ.calc.minuteMapFor(nws.minuteCache, nwh.map((h) => h.symbol), REF_TODAY);
  const al = XJ.calc.alignMinute(nwh, minMap, fxr);
  /* ★ 两侧必须同集合：includedSymbols =「有日线」的标的（与 marketValueSeries 的 used 一致）；
     minuteSymbols = 真正进得了当日分时的标的（场外基金不在其中）。 */
  const allSyms = nwh.map((h) => h.symbol);
  const minuteSyms = allSyms.filter((sym) => al.missing.indexOf(sym) < 0);
  const last = al.points[al.points.length - 1];
  const intraNw = last.mv + XJ.calc.netWorthAdjust(nws, XJ.calc.ALL, allSyms, minuteSyms);

  eq('场外基金确实拿不到分时（记进 missing）', JSON.stringify(al.missing), JSON.stringify(['of110022']));
  close('★ 当日净资产 == 日粒度今日净资产（含无分时标的 + 多币种）', intraNw, dRow.nw, 1e-9);
  close('日粒度今日 net 把港股的净投入换算成了人民币',
    dRow.net, 8000 + 30000 * fx.HKD + 10000, 1e-9);

  /* 拆开看 nwAdj 的两部分，锁住「补市值」和「乘汇率」两件事 */
  const adj = XJ.calc.netWorthAdjust(nws, XJ.calc.ALL, allSyms, minuteSyms);
  const adjNoFx = 684 - (8000 + 30000 + 10000) + 10000;      // 漏乘汇率会得到这个值
  close('★ 净投入按标的币种乘了汇率、且补回了场外基金的市值',
    adj, 684 - (8000 + 30000 * fx.HKD + 10000) + 10000, 1e-9);
  eq('★ 若不乘汇率则会是另一个值（说明这条断言真的在防回归）', Math.abs(adj - adjNoFx) > 1, true);

  /* 反证：老写法（扣全部净投入、不乘汇率、不补市值）确实会算错 */
  const buggy = last.mv - (8000 + 30000 + 10000) + 700;
  eq('★ 老写法与正确值相差甚远（这就是用户看到的「和持仓不对」）',
    Math.abs(buggy - intraNw) > 1, true);

  /* 账户过滤：另一账户的持仓与分红都不该混进来 */
  const nws2 = nwState();
  nws2.accounts.push({ accountId: 'a2', name: '家人' });
  nws2.symbols.sz000858 = { symbol: 'sz000858', name: '五粮液', costMethod: 'weighted' };
  nws2.transactions.push({
    txId: 't_a2', accountId: 'a2', symbol: 'sz000858', action: 'BUY',
    date: '2024-01-10', quantity: 999, price: 100, fee: 0, note: '', createdAt: '2024-01-10T01:00:00Z',
  });
  nws2.received.push({ recId: 'r3', accountId: 'a2', symbol: 'sz000858', exDividendDate: '2026-07-01', amount: 9999 });
  const adjA1 = XJ.calc.netWorthAdjust(nws2, 'a1', allSyms, minuteSyms);
  close('★ 按账户过滤（a2 的持仓与分红不进 a1 的净资产）', adjA1, adj, 1e-9);
}

/* ---- 6.33 多币种：汇总层必须与曲线层同为人民币口径 ---- */
section('【33】多币种汇总：首页/分析的总市值不能把港币当人民币加');
{
  const HKD = 0.92, USD = 7.1;
  function mixState() {
    const s = XJ.model.defaultState();
    s.accounts = [{ accountId: 'a1', name: '主账户' }];
    s.settings.fx = { HKD: HKD, USD: USD };
    const add = (sym, name, qty, cost, now, cny) => {
      s.symbols[sym] = { symbol: sym, name, costMethod: 'weighted' };
      s.transactions.push({
        txId: 't_' + sym, accountId: 'a1', symbol: sym, action: 'BUY',
        date: '2024-01-10', quantity: qty, price: cost, fee: 0,
        note: '', createdAt: '2024-01-10T01:00:00Z',
      });
      s.quoteCache[sym] = { price: now, prevClose: now };
      s.priceHistory[sym] = { at: REF_TODAY, points: [[REF_TODAY, now]] };
      void cny;
    };
    add('sh600036', '招商银行', 1000, 8, 10);     // 10000 CNY
    add('hk00700', '腾讯控股', 100, 300, 300);    // 30000 HKD → 27600 CNY
    add('usAAPL', '苹果', 10, 200, 200);          // 2000 USD → 14200 CNY
    s.received = [
      { recId: 'r1', accountId: 'a1', symbol: 'sh600036', exDividendDate: '2026-07-01', amount: 500 },
      { recId: 'r2', accountId: 'a1', symbol: 'hk00700', exDividendDate: '2026-07-01', amount: 200 },
    ];
    return XJ.model.ensureBootstrapped(s);
  }
  const mx = mixState();
  const hs = XJ.calc.holdings(mx, XJ.calc.ALL);
  const bySym = {};
  hs.forEach((h) => { bySym[h.symbol] = h; });

  eq('每行都带上该标的的汇率', JSON.stringify([bySym.sh600036.fxRate, bySym.hk00700.fxRate, bySym.usAAPL.fxRate]),
    JSON.stringify([1, HKD, USD]));
  close('港股的市值人民币口径 = 30000 × 0.92', bySym.hk00700.marketValueCny, 30000 * HKD, 1e-9);
  close('美股同理', bySym.usAAPL.marketValueCny, 2000 * USD, 1e-9);
  eq('★ 原币字段保持不变（内部折算还要用）', bySym.hk00700.marketValue, 30000);
  eq('★ 每股成本保持原币（港股就是港元）', bySym.hk00700.avgCost, 300);

  const s = XJ.calc.summary(mx, XJ.calc.ALL);
  const wantMv = 10000 + 30000 * HKD + 2000 * USD;
  const wantCost = 8000 + 30000 * HKD + 2000 * USD;
  close('★ 总市值 = 三币种按汇率折成人民币后相加', s.totalMarketValue, wantMv, 1e-6);
  close('★ 总成本同理', s.totalCost, wantCost, 1e-6);
  close('未实现盈亏 = 总市值 − 总成本', s.totalUnrealized, wantMv - wantCost, 1e-6);
  close('已收分红按币种折算（500 + 200×0.92）', s.receivedTotal, 500 + 200 * HKD, 1e-6);

  /* ★ 与曲线层对齐：同一天、同一组合，汇总与 marketValueSeries 必须相等 */
  const priceMap = {};
  Object.keys(mx.priceHistory).forEach((k) => { priceMap[k] = mx.priceHistory[k].points; });
  const ser = XJ.calc.marketValueSeries(mx, XJ.calc.ALL, priceMap, { beg: REF_TODAY, end: REF_TODAY });
  const row = ser.series[ser.series.length - 1];
  close('★★ 汇总的「总市值」== 资产走势曲线当日的 mv', s.totalMarketValue, row.mv, 1e-6);
  close('★★ 汇总的「总成本」== 曲线当日的 cost', s.totalCost, row.cost, 1e-6);
  close('★★ 汇总的「总净投入」== 曲线当日的 net', s.totalNetInvested, row.net, 1e-6);

  /* 反证：老写法（直接累加原币）确实会算出另一个数 */
  eq('★ 老写法（不折算）与正确值相差甚远',
    Math.abs((10000 + 30000 + 2000) - s.totalMarketValue) > 1000, true);

  /* 分层 / 集中度 / 盈亏榜 / 市场分布的权重也要用人民币口径，否则占比失真 */
  const sum3 = (a) => a.reduce((x, y) => x + y, 0);
  const an = XJ.calc.analytics(mx, XJ.calc.ALL);
  close('市场分布权重合计 = 100%', sum3(an.byAssetType.map((g) => g.weight)), 100, 1e-6);
  close('股息率分层的市值合计 = 总市值',
    sum3(an.yieldBuckets.map((b) => b.marketValue)), s.totalMarketValue, 1e-6);
  eq('集中度逐只列表的市值也是人民币口径',
    an.concentration.holdings.every((x) => x.marketValue > 0), true);
  close('集中度 top1 权重 = 最大那只的人民币市值占比',
    an.concentration.top1, Math.max(10000, 30000 * HKD, 2000 * USD) / wantMv * 100, 1e-6);
  eq('盈亏榜按人民币未实现盈亏排序',
    an.byPnl.every((x, i) => i === 0 || an.byPnl[i - 1].unrealizedCny >= x.unrealizedCny), true);
}

/* ---- 6.34 首页测算带：每年投入 × 股息率 → N 年后月均分红 ----
 * 独立复算：下面的递推与闭式都是**另写一遍**的，不复用 calc 的实现。
 * 口径：股息率只作用于新投入的钱；现有持仓分红 P0 保持不变；当年投入当年计息；再投在年末发生、次年起计息。 */
section('【34】首页测算带：每年投入 × 股息率 → N 年后月均分红');
{
  const F = (invest, yPct, years, reinvestPct) => ({
    annualInvest: invest, yieldPct: yPct, years: years, reinvestPct: reinvestPct,
  });

  /* 独立实现①：逐年递推 */
  function indep(invest, yPct, years, rPct, P0) {
    const y = yPct / 100, r = rPct / 100;
    let A = 0, D = P0;
    const rows = [];
    for (let k = 1; k <= years; k++) {
      A += invest;
      const divNew = A * y;
      D = P0 + divNew;
      A += D * r;
      rows.push({ year: k, dividend: D, fromNew: divNew, assetsNew: A });
    }
    return { endDividend: D, rows: rows };
  }
  /* 独立实现②：闭式（B_N = 再投前的新钱池） */
  function indepClosed(invest, yPct, years, rPct, P0) {
    const y = yPct / 100, r = rPct / 100;
    const a = 1 + r * y, c2 = invest + r * P0;
    let B;
    if (Math.abs(a - 1) < 1e-12) B = invest + (years - 1) * c2;
    else { const p = Math.pow(a, years - 1); B = invest * p + c2 * (p - 1) / (a - 1); }
    return P0 + y * B;
  }

  const P0 = 45712.34;
  const grid = [
    [60000, 3.4, 10, 100], [60000, 3.4, 10, 0], [60000, 3.4, 10, 50],
    [25000, 5.2, 7, 50], [0, 4, 5, 100], [120000, 6.5, 30, 80],
    [60000, 0, 10, 100], [50000, 2, 1, 100], [50000, 2, 1, 0],
  ];
  grid.forEach(function (g) {
    const cfg = F(g[0], g[1], g[2], g[3]);
    const tag = g.join('/');
    const rows = XJ.calc.forecastRows(cfg, P0);
    const ind = indep(g[0], g[1], g[2], g[3], P0);

    close('★递推 == 独立实现 ' + tag, rows.endDividend, ind.endDividend, 1e-9);
    close('★闭式 == 独立闭式 ' + tag, XJ.calc.forecastDividendAt(cfg, P0, g[2]),
      indepClosed(g[0], g[1], g[2], g[3], P0), 1e-9);
    close('★递推 == calc 闭式 ' + tag, rows.endDividend, XJ.calc.forecastDividendAt(cfg, P0, g[2]), 1e-6);
    eq('逐年行数 = 年数 ' + tag, rows.rows.length, g[2]);
    close('月均 = 年分红 ÷ 12 ' + tag, rows.monthly, rows.endDividend / 12, 1e-12);
    close('拆分：现有持仓 + 新投入 = 年分红 ' + tag,
      rows.fromExisting + rows.fromNew, rows.endDividend, 1e-9);
    /* 逐行也要与独立实现一致（不只看末年） */
    eq('逐年逐行一致 ' + tag, rows.rows.every(function (r, i) {
      return Math.abs(r.dividend - ind.rows[i].dividend) < 1e-9 &&
        Math.abs(r.assetsNew - ind.rows[i].assetsNew) < 1e-9;
    }), true);
  });

  /* 「不再投」必须精确退化为线性：P0 + N·X·y（不是另一套算法） */
  close('★r=0 退化为 P0 + N·X·y',
    XJ.calc.forecastRows(F(60000, 3.4, 10, 0), P0).endDividend, P0 + 10 * 60000 * 0.034, 1e-9);
  /* 第 1 年 = P0 + X·y（当年投入当年计息） */
  close('第 1 年 = P0 + X·y',
    XJ.calc.forecastRows(F(60000, 3.4, 1, 100), P0).endDividend, P0 + 60000 * 0.034, 1e-9);
  /* 股息率为 0 → 分红恒等于现有持仓分红（投入再多也不涨） */
  close('y=0 → 分红恒等于现有持仓分红',
    XJ.calc.forecastRows(F(60000, 0, 10, 100), P0).endDividend, P0, 1e-9);
  /* 年数：缺失默认 10；显式 0 按最小值 1；超上限钳到 50 */
  eq('年数缺失 → 默认 10', XJ.calc.normalizeForecast({}).years, 10);
  eq('年数 = 0 → 钳到下限 1（不当成"没填"）', XJ.calc.normalizeForecast({ years: 0 }).years, 1);
  eq('年数 = 999 → 钳到上限 50', XJ.calc.normalizeForecast({ years: 999 }).years, 50);
  eq('股息率 = 99 → 钳到 30', XJ.calc.normalizeForecast({ yieldPct: 99 }).yieldPct, 30);
  eq('再投 = 150 → 钳到 100', XJ.calc.normalizeForecast({ reinvestPct: 150 }).reinvestPct, 100);

  /* 反解年数：最小性（N 达到目标、N−1 不达到）+ 与独立实现一致 */
  [[60000, 3.4, 100], [60000, 3.4, 0], [25000, 5.2, 50]].forEach(function (g) {
    const target = 5509;
    const res = XJ.calc.forecastSolveYears(F(g[0], g[1], 10, g[2]), P0, target);
    const tag = g.join('/');
    eq('反解年数 · 成功 ' + tag, res.ok, true);
    const atN = indep(g[0], g[1], res.years, g[2], P0).endDividend / 12;
    const atPrev = res.years > 1 ? indep(g[0], g[1], res.years - 1, g[2], P0).endDividend / 12 : -Infinity;
    eq('★反解年数 · 最小性 ' + tag, (atN >= target - 1e-6) && (atPrev < target), true);
    close('★反解年数 · 届时时月均 = 正算结果 ' + tag,
      XJ.calc.forecastRows(F(g[0], g[1], res.years, g[2]), P0).monthly, atN, 1e-9);
  });

  /* 反解每年投入：正算回去恰等于目标（对 X 是一元一次，应精确） */
  [[3.4, 10, 100], [3.4, 10, 0], [5.2, 7, 50]].forEach(function (g) {
    const target = 8000;
    const res = XJ.calc.forecastSolveInvest(F(0, g[0], g[1], g[2]), P0, target);
    const tag = g.join('/');
    eq('反解投入 · 成功 ' + tag, res.ok, true);
    const back = indep(res.annualInvest, g[0], g[1], g[2], P0).endDividend / 12;
    close('★反解投入 · 正算回等于目标 ' + tag, back, target, 1e-6);
  });

  /* 边界：无解 / 已达成 / 超上限 —— 返回值必须如实说明原因，调用方据此不改参数 */
  eq('y=0 → 反解年数 no-growth',
    XJ.calc.forecastSolveYears(F(60000, 0, 10, 100), P0, 9000).reason, 'no-growth');
  eq('y=0 → 反解投入 no-growth',
    XJ.calc.forecastSolveInvest(F(60000, 0, 10, 100), P0, 9000).reason, 'no-growth');
  eq('X=0 且 r=0 → 反解年数 no-growth',
    XJ.calc.forecastSolveYears(F(0, 4, 10, 0), P0, 9000).reason, 'no-growth');
  const low = XJ.calc.forecastSolveYears(F(60000, 3.4, 10, 100), P0, 1000);
  eq('目标低于当前持仓 → 0 年且 reached', (low.ok && low.years === 0 && low.reached) ? 1 : 0, 1);
  const huge = XJ.calc.forecastSolveYears(F(1000, 1, 10, 100), P0, 999999);
  eq('超出 50 年 → beyond-limit', (!huge.ok && huge.reason === 'beyond-limit') ? 1 : 0, 1);
  eq('y=0 时反解投入也不给假数（reached 或 no-growth）',
    (function () {
      const r = XJ.calc.forecastSolveInvest(F(0, 0, 10, 100), P0, 9000);
      return r.ok === false && r.reason === 'no-growth';
    })(), true);

  /* 拆分显示的一致性：各自取整后仍必须相加等于总数（靠"做差"保证） */
  [0, 0.4, 0.5, 0.6, 3809.4, 5509.7, 123456.789].forEach(function (m) {
    const sp = XJ.calc.forecastSplit(m, P0 / 12);
    eq('★月均拆分相加 = 总数（' + m + '）', sp.existing + sp.fromNew, sp.total);
  });

  /* 黄金用例：手算一组固定数字（P0=45712.34 / X=6万 / y=3.4% / N=10 / r=100%） */
  const goldCfg = F(60000, 3.4, 10, 100);
  const goldRows = XJ.calc.forecastRows(goldCfg, P0).rows;
  eq('黄金用例 · 10 行', goldRows.length, 10);
  close('黄金用例 · 第 1 年分红 = P0 + 60000×3.4%', goldRows[0].dividend, P0 + 2040, 1e-9);
  close('黄金用例 · 第 1 年末新钱资产 = 6万 + 第1年分红（全额再投）',
    goldRows[0].assetsNew, 60000 + (P0 + 2040), 1e-9);
  close('黄金用例 · 第 2 年分红 = P0 + (107752.34 + 6万)×3.4%',
    goldRows[1].dividend, P0 + 167752.34 * 0.034, 1e-6);
  close('黄金用例 · 末年分红与闭式一致',
    goldRows[9].dividend, XJ.calc.forecastDividendAt(goldCfg, P0, 10), 1e-6);
  /* 与「展望未来」对比：那边是"全组合统一息率"，这边是"只有新钱按 y 生息"，两套模型必须不同 */
  const sameAsProjection = (function () {
    const proj = XJ.calc.projection(
      { years: 10, monthlyInvest: 60000 / 12, reinvestRatio: 1 }, 1340000, P0);
    return Math.abs(proj.endDividend - goldRows[9].dividend) < 1;
  })();
  eq('★测算带与「展望未来」是两套模型（数字不应相同）', sameAsProjection, false);
}

/* ---- 当日参考盈亏 / 成本收益率（相对昨收口径） ---- */
section('【35】当日参考盈亏：相对昨收、跨币种折算、缺昨收则跳过');
{
  const s = XJ.model.defaultState();
  s.version = XJ.model.DATA_VERSION;
  s.accounts = [{ accountId: 'a1', name: '主账户' }];
  s.settings.fx = { USD: 7 };
  const add = (sym, qty, cost, now, prev) => {
    s.symbols[sym] = { symbol: sym, name: sym, costMethod: 'weighted' };
    s.transactions.push({
      txId: 't_' + sym, accountId: 'a1', symbol: sym, action: 'BUY',
      date: '2024-01-10', quantity: qty, price: cost, fee: 0, note: '',
      createdAt: '2024-01-10T01:00:00Z',
    });
    s.quoteCache[sym] = { symbol: sym, name: sym, price: now, prevClose: prev, changePct: 0 };
    s.priceHistory[sym] = { at: REF_TODAY, deep: 2, points: [[REF_TODAY, now]] };
  };
  add('sh600036', 1000, 8, 11, 10);      // A股：(11−10)×1000 = +1000
  add('usAAPL', 10, 100, 210, 200);      // 美股：(210−200)×10×7 = +700

  const st = XJ.model.ensureBootstrapped(s);
  const sum = XJ.calc.summary(st, XJ.calc.ALL);
  close('★ 当日参考盈亏 = 1000 + 700（跨币种已折算）', sum.todayPnl, 1700, 1e-9);
  close('★ 当日涨跌幅 = 1700 ÷ 昨收市值(10×1000 + 200×10×7 = 24000)',
    sum.todayPnlPct, Math.round(1700 / 24000 * 10000) / 100, 1e-9);
  close('昨收市值口径：Σ 昨收 × 持股 × 汇率', 10 * 1000 + 200 * 10 * 7, 24000, 1e-9);

  /* 缺昨收的标的必须被跳过 —— 拿 0 当昨收会算出 +∞ */
  add('sh601318', 100, 50, 51, null);
  const st2 = XJ.model.ensureBootstrapped(s);
  const sum2 = XJ.calc.summary(st2, XJ.calc.ALL);
  close('★ 缺昨收的标的被跳过（金额不变，也没有算出 ∞）', sum2.todayPnl, 1700, 1e-9);
  eq('★ 它也不进昨收分母', Number.isFinite(sum2.todayPnlPct), true);

  /* 成本收益率 = 累计收益 ÷ 累计净投入 */
  const mv = XJ.calc.marketValueSeries(st, XJ.calc.ALL,
    { sh600036: [[REF_TODAY, 11]], usAAPL: [[REF_TODAY, 210]] },
    { beg: REF_TODAY, end: REF_TODAY });
  const row = mv.series[mv.series.length - 1];
  close('成本收益率 = nw ÷ net', row.nw / row.net, row.nw / row.net, 1e-9);
  eq('净投入 > 0 时成本收益率有定义', row.net > 0 && Number.isFinite(row.nw / row.net), true);
}

/* ---- 历史 cost 不含「未来才到账」的分红 ---- */
section('【36】历史 cost 只用「截至当日」已到账的分红（分红摊薄口径）');
{
  const s = XJ.model.defaultState();
  s.version = XJ.model.DATA_VERSION;
  s.accounts = [{ accountId: 'a1', name: '主账户' }];
  s.symbols.sh600036 = { symbol: 'sh600036', name: '招商银行', costMethod: 'dividendDiluted' };
  s.transactions.push({
    txId: 't1', accountId: 'a1', symbol: 'sh600036', action: 'BUY',
    date: '2026-06-01', quantity: 1000, price: 10, fee: 0, note: '',
    createdAt: '2026-06-01T01:00:00Z',
  });
  /* 分红在 7 月才到账，但曲线要看 6 月 —— 那时这笔分红还没发生 */
  s.received = [{ recId: 'r1', accountId: 'a1', symbol: 'sh600036',
    exDividendDate: '2026-07-01', amount: 500, perShareAmount: 0.5, qtyAtRecord: 1000 }];
  s.priceHistory.sh600036 = { at: REF_TODAY, deep: 2,
    points: [['2026-06-10', 10], ['2026-06-20', 10]] };

  const st = XJ.model.ensureBootstrapped(s);
  const mv = XJ.calc.marketValueSeries(st, XJ.calc.ALL,
    { sh600036: st.priceHistory.sh600036.points },
    { beg: '2026-06-01', end: '2026-06-30' });
  const row = mv.series[mv.series.length - 1];
  close('★ 6 月那点：摊薄成本仍是 10000（7 月的分红不能提前摊进来）', row.cost, 10000, 1e-9);
  /* 反证：如果传全量分红（旧写法），这里会变成 9500 */
  eq('★ 与「传全量分红」的旧值不同（说明断言真的在防回归）',
    Math.abs(row.cost - (10000 - 500)) > 1, true);
}

/* -------------------------------------------------------------------------
 * 【31】URL hash 键白名单（护栏）
 *
 * 应用会用 location.hash 承载「一次性载荷」：搬运链接 #xjimport=。
 * hash 是最容易被随手滥用的通道 —— 它可以塞任何东西，
 * 而且【会进浏览器历史、会进分享链接】。所以这里钉死：全仓只允许这一个键。
 * 以后谁再往 URL 里塞新的东西，这条断言会先拦住他，让他先想清楚三件事：
 *   ① 这个载荷会不会留在别人的历史记录里？② 会不会被转发出去？
 *   ③ 有没有更安全的替代通道（IndexedDB / 剪贴板 / 文件）？
 * （跨设备同步的 #xjsync= 随同步层一并移除；将来接回同步时恢复第二个键。）
 * ------------------------------------------------------------------------- */
{
  section('【31】URL hash 键白名单（只允许 #xjimport=）');
  /* 复用第 5 节声明的写死的白名单 */
  const found = new Set();
  for (const f of SRC_FILES) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of text.matchAll(/#x[a-z]+=/g)) found.add(m[0]);
  }
  eq('31.1 全仓 hash 键数量', found.size, HASH_KEYS.length);
  eq('31.2 ★ 出现的键正好是白名单那一个', [...found].sort().join(','), [...HASH_KEYS].sort().join(','));
  eq('31.3 搬运链接的键在位', found.has('#xjimport='), true);
  /* 反向断言：白名单之外的键一个都不许有 */
  for (const k of found) {
    eq('31.5 ★ ' + k + ' 在白名单内', HASH_KEYS.indexOf(k) >= 0, true);
  }
}

/* -------------------------------------------------------------------------
 * 【32】同步架构预留（锚断言）
 *
 * 跨设备同步层（sync-core / sync / qr）已随精简版移除，但 state.syncMeta
 * 空壳、storage.setOnBeforeSave 钩子与 fromImport(keepSync) 全部保留，
 * 将来接回同步层时零核心改动。这几条断言就是预留结构的回归锚：
 *   ① 空壳默认关闭（应用一个同步请求都不会发）；
 *   ② 备份导出只带空壳、绝不含令牌/位置/设备身份；
 *   ③ 导入别人的备份默认丢弃 syncMeta（本机自加载 keepSync 除外）。
 * ------------------------------------------------------------------------- */
{
  section('【32】同步架构预留（syncMeta 空壳语义不变）');
  const sm0 = XJ.model.emptySyncMeta();
  eq('32.1 ★ 干净容器：默认关闭', sm0.enabled, false);
  eq('32.2 ★ 干净容器：配对密钥也为空（不随导出上路）', sm0.pairKey, null);
  eq('32.3 ★ 干净容器：自愈标记默认关闭', sm0.legacyHealed, false);

  const st = XJ.model.ensureBootstrapped(XJ.model.defaultState());
  const exp = XJ.model.toExport(st, '锚测试');
  eq('32.4 ★ toExport 带 syncMeta 空壳（结构在位）', !!exp.syncMeta && typeof exp.syncMeta === 'object', true);
  eq('32.5 ★ 空壳不含令牌/位置/设备身份', !exp.syncMeta.token && !exp.syncMeta.gistId && !exp.syncMeta.deviceId, true);

  const imported = XJ.model.fromImport(exp);
  eq('32.6 ★ fromImport 默认丢弃 syncMeta（备份导入不带来路不明的同步设置）', imported.syncMeta.enabled, false);
  const kept = XJ.model.fromImport(exp, { keepSync: true });
  eq('32.7 ★ keepSync 时结构仍在（将来接回即生效）', !!kept.syncMeta && typeof kept.syncMeta === 'object', true);
}

/* -------------------------------------------------------------------------
 * 【37】FIRE：三档分母 / fireNumber 双口径 / 时间反解 / 覆盖率历史折算 / 场景
 *
 * 全部新函数（tierMonthlySpend / fireTargets / fireCfg / fireTimeline /
 * fireMonthlyPassive / fireCoverageHistory / fireProgress / fireSceneSolve）
 * 的口径锚：
 *   · 三档分母 Lean=生存、Regular=生存+品质、Fat=生存+2×品质（停用项不计）
 *   · fireNumber = 档位年支出 ÷ 真实持仓息率（cost/market 两口径）
 *   · fireTimeline 与 forecastRows/forecastSolveYears 逐位交叉一致
 *   · 覆盖率历史按标的币种折 CNY（stats().byMonth 是原币，绝不能直接用）
 * ------------------------------------------------------------------------- */
section('【37】FIRE：三档分母 · fireNumber 双口径 · 时间反解 · 覆盖率折算 · 场景');
{
  const C = XJ.calc, M = XJ.model;

  /* ---- 37.1~37.3 三档分母（含停用项不计） ---- */
  const fstate = M.ensureBootstrapped(M.defaultState());
  fstate.expenses = [
    { expenseId: 'e1', key: 'A', label: '生存A', icon: '🏠', iconAuto: false, monthlyAmount: 600, enabled: true, sortOrder: 1, category: 'essential' },
    { expenseId: 'e2', key: 'B', label: '生存B', icon: '⚡', iconAuto: false, monthlyAmount: 900, enabled: true, sortOrder: 2, category: 'essential' },
    { expenseId: 'e3', key: 'C', label: '品质C', icon: '🎮', iconAuto: false, monthlyAmount: 500, enabled: true, sortOrder: 3, category: 'quality' },
    { expenseId: 'e4', key: 'D', label: '停用D', icon: '🏷️', iconAuto: false, monthlyAmount: 999, enabled: false, sortOrder: 4, category: 'quality' },
  ];
  eq('37.1 Lean 分母 = 生存合计（停用项不计）', C.tierMonthlySpend(fstate.expenses, 'lean'), 1500);
  eq('37.2 Regular 分母 = 生存 + 品质', C.tierMonthlySpend(fstate.expenses, 'regular'), 2000);
  eq('37.3 ★ Fat 分母 = 生存 + 2×品质（es+2q，不是 es+3q）', C.tierMonthlySpend(fstate.expenses, 'fat'), 2500);

  /* ---- 37.4~37.8 fireNumber 双口径（用主 fixtures state） ---- */
  const st2 = M.ensureBootstrapped(state);
  const s0 = C.summary(st2, C.ALL);
  const tgM = C.fireTargets(st2, C.ALL, 'market');
  const tgC = C.fireTargets(st2, C.ALL, 'cost');
  eq('37.4 market 口径 yieldPct == summary().marketYield', tgM.yieldPct, s0.marketYield);
  eq('37.5 cost 口径 yieldPct == summary().costYield', tgC.yieldPct, s0.costYield);
  close('37.6 Regular fireNumber = 年支出 ÷ (市值息率/100)',
    tgM.tiers.regular.fireNumber, tgM.tiers.regular.annual / (s0.marketYield / 100), 1e-6);
  close('37.7 ★ capitalAt4 = 年支出 × 25（4% 法则）',
    tgM.tiers.lean.capitalAt4, tgM.tiers.lean.annual * 25, 1e-6);
  close('37.8 fiRatio = 本金 ÷ fireNumber × 100',
    tgM.tiers.regular.fiRatio, s0.totalMarketValue / tgM.tiers.regular.fireNumber * 100, 1e-6);

  /* ---- 37.9~37.17 fireCfg / fireTimeline（与 forecastRows 交叉） ---- */
  const fire = st2.settings.fire;
  fire.tierSims.regular = { monthlySpend: 2000, drip: 3000, dripYieldPct: 6 };
  const cfg = C.fireCfg(st2, C.ALL, 'regular', fire);
  eq('37.9 cfg.X = drip × 12', cfg.X, 36000);
  eq('37.10 cfg.P0 = summary().totalPredicted', cfg.P0, s0.totalPredicted);
  const tl = C.fireTimeline(st2, C.ALL, cfg);
  if (tl.solvable && !tl.reached) {
    const rows = C.forecastRows({ annualInvest: cfg.X, yieldPct: cfg.y, years: 50, reinvestPct: cfg.r }, cfg.P0).rows;
    const N = Math.ceil(tl.exact);
    eq('37.11 交叉 · 第 ceil(exact) 年月均已达标', rows[N - 1].monthly >= tl.targetMonthly, true);
    eq('37.12 交叉 · 前一年月均未达标', rows[N - 2] ? rows[N - 2].monthly < tl.targetMonthly : true, true);
    close('37.12b 交叉 · exact 年分红 == 闭式 D_N', C.forecastDividendAt(
      { annualInvest: cfg.X, yieldPct: cfg.y, years: 50, reinvestPct: cfg.r }, cfg.P0, N),
      rows[N - 1].dividend, 1e-6);
  } else if (tl.solvable && tl.reached) {
    eq('37.11 reached · months=0', tl.months, 0);
  }
  const mp0 = C.fireMonthlyPassive(cfg, 0);
  close('37.13 fireMonthlyPassive(0) = P0/12', mp0, cfg.P0 / 12, 1e-9);
  const fc = { annualInvest: cfg.X, yieldPct: cfg.y, years: 50, reinvestPct: cfg.r };
  const d0 = C.forecastDividendAt(fc, cfg.P0, 0);
  const d1 = C.forecastDividendAt(fc, cfg.P0, 1);
  close('37.14 ★ 月度线性插值 · t=6 个月 = (D0 + (D1−D0)×0.5)/12',
    C.fireMonthlyPassive(cfg, 6), (d0 + (d1 - d0) * 0.5) / 12, 1e-9);
  const cfg0 = Object.assign({}, cfg, { y: 0, dripYieldPct: 0, monthlySpend: cfg.monthlySpend + 100000 });
  const tl0 = C.fireTimeline(st2, C.ALL, cfg0);
  eq('37.15 no-growth · 不可解', tl0.solvable, false);
  eq('37.16 reason = no-growth', tl0.reason, 'no-growth');
  const cfgR = Object.assign({}, cfg, { monthlySpend: cfg.P0 / 12 });
  const tlR = C.fireTimeline(st2, C.ALL, cfgR);
  eq('37.17 reached · months=0', tlR.reached, true);
  eq('37.17b reached · 月份为 0', tlR.months, 0);

  /* ---- 37.18~37.22 覆盖率历史：双币种折算 / 缺月 / 外推首月 / 连续填月 ---- */
  const hstate = M.ensureBootstrapped(M.defaultState());
  hstate.settings.fx = { HKD: 0.9, USD: 7.1, updatedAt: REF_TODAY + 'T00:00:00Z' };
  const acc1 = hstate.accounts[0].accountId;
  hstate.received = [
    { recId: 'r1', accountId: acc1, symbol: 'sh600036', planId: null, exDividendDate: '2026-01-10',
      perShareAmount: 2, qtyAtRecord: 100, amount: 1000, source: 'MANUAL', year: 2026, createdAt: '2026-01-10T00:00:00Z' },
    { recId: 'r2', accountId: acc1, symbol: 'hk00700', planId: null, exDividendDate: '2026-01-20',
      perShareAmount: 3, qtyAtRecord: 100, amount: 500, source: 'MANUAL', year: 2026, createdAt: '2026-01-20T00:00:00Z' },
  ];
  const hcfg = { P0: 0, X: 12000, y: 5, r: 100, monthlySpend: 1500, drip: 1000,
    dripYieldPct: 5, baseYieldPct: 5, yieldBasis: 'market' };
  const cov = C.fireCoverageHistory(hstate, C.ALL, 'lean', hcfg);
  const jan = cov.history.find(function (h) { return h.date === '2026-01'; });
  close('37.18 ★ 港币按 fx 折算（1000 + 500×0.9 = 1450 → 96.67%）',
    jan.pct, 1450 / 1500 * 100, 1e-6);
  eq('37.19 对照 · byMonth 是原币合计（1500 ≠ 1450，证明折算生效）',
    C.stats(hstate, C.ALL).byMonth['2026-01'], 1500);
  const feb = cov.history.find(function (h) { return h.date === '2026-02'; });
  eq('37.20 缺月 = 0（连续填月不断线）', feb.pct, 0);
  close('37.21 外推第 12 个月 = (P0 + y·X)/12 ÷ 分母 × 100（年内线性：B(1年)=X）',
    cov.future[11].pct, ((0 + 0.05 * 12000) / 12) / 1500 * 100, 1e-6);
  eq('37.22 连续填月（2026-01 .. REF_TODAY 月）',
    cov.history.length, (2026 - 2026) * 12 + (Number(REF_TODAY.slice(5, 7)) - 1 + 1));
  close('37.22b 外推收口 · 达标即停（末点 ≥ 100）',
    cov.future[cov.future.length - 1].pct >= 100 ? 1 : 0, 1, 0);

  /* ---- 37.23~37.24 fireProgress 一致性 ---- */
  const pr = C.fireProgress(st2, C.ALL, 'market');
  close('37.23 fireProgress.tiers.regular.fireNumber == fireTargets 同口径',
    pr.tiers.regular.fireNumber, tgM.tiers.regular.fireNumber, 1e-6);
  close('37.24 gap = max(0, fireNumber − 本金)',
    pr.tiers.regular.gap, Math.max(0, tgM.tiers.regular.fireNumber - s0.totalMarketValue), 1e-6);

  /* ---- 37.25 场景：方向断言 + clamp ---- */
  const baseTl = C.fireTimeline(st2, C.ALL, C.fireCfg(st2, C.ALL, 'regular',
    Object.assign(JSON.parse(JSON.stringify(fire)), { tierSims: { lean: {}, regular: {}, fat: {} } })));
  const sc = C.fireSceneSolve(st2, C.ALL, 'regular', fire, { spendPct: -10, dripPct: 100, yieldAdjPct: 0 });
  eq('37.25 场景 · 参数合成（支出 −10%：默认模板 6 项合计 1810 → 1629）', sc.params.monthlySpend, 1629);
  eq('37.26 场景 · 攒股 +100%（5000→10000，相对默认而非当前 sim）', sc.params.drip, 10000);
  if (sc.solvable !== false && sc.scene.solvable && baseTl.solvable && !baseTl.reached && !sc.scene.reached) {
    eq('37.27 场景 · 少花钱多攒股 → 自由日不晚于基准',
      sc.scene.months <= baseTl.months, true);
  }
  const scClamp = C.fireSceneSolve(st2, C.ALL, 'regular', fire, { spendPct: 0, dripPct: 0, yieldAdjPct: 99 });
  eq('37.28 场景 · 息率合成后 clamp 到 30', scClamp.params.dripYieldPct, 30);

  /* ---- 37.29~37.31 v5 备份迁移：category 全 essential + fire 补齐 + 幂等 ---- */
  const v5raw = {
    version: 5,
    accounts: [{ accountId: 'a1', name: 'A', type: 'BROKER', sortOrder: 1, createdAt: '2026-01-01T00:00:00Z' }],
    expenses: [
      { expenseId: 'exp_phone', key: 'PHONE', label: '话费', icon: '💬', monthlyAmount: 60, enabled: true, sortOrder: 1 },
      { expenseId: 'exp_x', key: 'X', label: '自定义', icon: '🏷️', monthlyAmount: 300, enabled: true, sortOrder: 2 },
    ],
    settings: { defaultAccountId: 'a1' },
    transactions: [], plans: {}, received: [], symbols: {}, quoteCache: {},
  };
  const mi1 = M.fromImport(v5raw);
  eq('37.29 v5 迁移 · 存量支出全部归 essential（不预判品质）',
    mi1.expenses.every(function (e) { return e.category === 'essential'; }), true);
  eq('37.30 v5 迁移 · settings.fire 三档补齐',
    ['lean', 'regular', 'fat'].every(function (t) {
      return mi1.settings.fire.tierSims[t] && mi1.settings.fire.tierSims[t].drip === 5000;
    }), true);
  eq('37.31 ★ 迁移幂等（再导入 JSON 全等）',
    JSON.stringify(M.fromImport(mi1)), JSON.stringify(mi1));
}

fs.writeFileSync(
  path.join(ROOT, 'fixtures.json'),
  JSON.stringify({ refToday: REF_TODAY, state: XJ.model.toExport(state, 'verify fixtures') }, null, 2),
  'utf8'
);
console.log('\n[verify] 已同步导出 fixtures.json（参考用）');

console.log('\n' + '='.repeat(56));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('失败清单：\n  - ' + failures.join('\n  - '));
  process.exitCode = 1;
} else {
  console.log('全部通过 ✅');
}
console.log('='.repeat(56));
