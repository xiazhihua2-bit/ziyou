/* 独立验证 FIRE 视图的全部纯函数：
 *   calc.tierMonthlySpend    —— 三档支出分母（Lean / Regular / Fat）
 *   calc.fireEffectiveSpend  —— 提取抵扣（不再投分红 → 目标支出抵扣 → effective）
 *   calc.fireTargets         —— fireNumber（成本息率 / 市值息率两口径）
 *   calc.fireCfg             —— 滑杆模拟值 → 模型入参（null 语义）
 *   calc.fireTimeline        —— 「被动收入 ≥ 目标月支出」的时间反解
 *   calc.fireMonthlyPassive  —— 月被动收入（年内线性插值）
 *   calc.fireCoverageHistory —— 覆盖率月度序列（历史折 CNY + 未来外推）
 *   calc.fireProgress        —— FI 进度（本金 ÷ fireNumber）
 *   calc.fireSceneSolve      —— 场景相对基准的 Δ
 *
 * 与 test-divsum.mjs 同样的做法：vm 沙箱直接加载浏览器端源文件（页面代码即被测代码）。
 * 合成数据覆盖：三档分母、双币种 fx、两口径切换、外推 × forecastRows 交叉、
 * 反解一致性、场景 clamp、v6 迁移幂等。
 *
 * 用法： node tools/test-fire.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ---------------- 沙箱：util → market → model → calc ---------------- */
const sandbox = {
  window: {}, console,
  Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Date,
  parseInt, parseFloat, isNaN, isFinite, Promise, setTimeout, clearTimeout,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['src/util.js', 'src/market.js', 'src/model.js', 'src/calc.js']) {
  vm.runInContext(read(f), sandbox, { filename: f });
}
const XJ = sandbox.window.XJ;
const C = XJ.calc;
const M = XJ.model;
const ALL = C.ALL;

let pass = 0, fail = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + '\n      got  ' + g + '\n      want ' + w); }
}
function close(label, got, want, tol) {
  if (Math.abs(got - want) <= (tol === undefined ? 1e-9 : tol)) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + '  got ' + got + ' want ' + want); }
}

/* ================================================================
 * 1) 三档分母：es / es+q / es+2q（停用项不计；category 只认 quality）
 * ================================================================ */
console.log('\n--- 1) 三档分母 ---');
{
  const ex = [
    { expenseId: 'a', key: 'A', label: '生存1', monthlyAmount: 600, enabled: true, category: 'essential' },
    { expenseId: 'b', key: 'B', label: '生存2', monthlyAmount: 900, enabled: true, category: 'essential' },
    { expenseId: 'c', key: 'C', label: '品质1', monthlyAmount: 500, enabled: true, category: 'quality' },
    { expenseId: 'd', key: 'D', label: '停用', monthlyAmount: 999, enabled: false, category: 'quality' },
  ];
  eq('Lean = es', C.tierMonthlySpend(ex, 'lean'), 1500);
  eq('Regular = es + q', C.tierMonthlySpend(ex, 'regular'), 2000);
  eq('★ Fat = es + 2q（非 es+3q）', C.tierMonthlySpend(ex, 'fat'), 2500);
  eq('无品质项时三档相等', [C.tierMonthlySpend([{ expenseId: 'x', key: 'X', label: 'x', monthlyAmount: 100, enabled: true }], 'lean'),
    C.tierMonthlySpend([{ expenseId: 'x', key: 'X', label: 'x', monthlyAmount: 100, enabled: true }], 'regular'),
    C.tierMonthlySpend([{ expenseId: 'x', key: 'X', label: 'x', monthlyAmount: 100, enabled: true }], 'fat')], [100, 100, 100]);
  eq('空支出 → 0', C.tierMonthlySpend([], 'regular'), 0);
}

/* ================================================================
 * 2) 合成 state（双币种 fx + 默认 expenses）—— 后续各段共用
 * ================================================================ */
function mkState() {
  const s = M.ensureBootstrapped(M.defaultState());
  s.settings.fx = { HKD: 0.9, USD: 7.1, updatedAt: '2026-09-10T00:00:00Z' };
  s.expenses = [
    { expenseId: 'a', key: 'A', label: '生存1', monthlyAmount: 600, enabled: true, sortOrder: 1, category: 'essential' },
    { expenseId: 'b', key: 'B', label: '生存2', monthlyAmount: 900, enabled: true, sortOrder: 2, category: 'essential' },
    { expenseId: 'c', key: 'C', label: '品质1', monthlyAmount: 500, enabled: true, sortOrder: 3, category: 'quality' },
  ];
  return s;
}
function addRecv(s, recId, sym, date, amount) {
  s.received.push({
    recId, accountId: s.accounts[0].accountId, symbol: sym, planId: null,
    exDividendDate: date, perShareAmount: 1, qtyAtRecord: 100,
    amount, source: 'MANUAL', year: Number(date.slice(0, 4)), createdAt: date + 'T00:00:00Z',
  });
}

/* 持仓：预测年分红 P0（一笔 sh600036 买入，quoteCache 给价与 predictedDividend 同源） */
function addHolding(s, sym, qty, price, annualPerShare) {
  s.symbols[sym] = { symbol: sym, code: sym.slice(2), market: sym.slice(0, 2), name: sym, type: 'STOCK', dividendBasis: { type: 'years', value: 1 } };
  s.transactions.push({ txId: 'tx_' + sym, accountId: s.accounts[0].accountId, symbol: sym, action: 'BUY', date: '2024-01-10', quantity: qty, price, fee: 0, note: '', createdAt: '2024-01-10T00:00:00Z' });
  s.plans[sym + '_2025-12-31'] = {
    planId: sym + '_2025-12-31', symbol: sym, securityCode: sym.slice(2), securityName: '',
    reportDate: '2025-12-31', reportType: '年报', pretaxBonusPer10: annualPerShare * 10, afterTaxPer10: null,
    implPlanProfile: '10派' + annualPerShare * 10 + '元', planNoticeDate: null, noticeDate: null,
    equityRecordDate: '2026-06-01', exDividendDate: '2026-06-02', assignProgress: '实施分配',
    progressRank: 100, isImplemented: true, dividendRatio: null, fetchedAt: '2026-09-01T00:00:00Z',
  };
}

const st = mkState();
addHolding(st, 'sh600036', 1000, 40, 1.2);       // P0 = 1000 × 1.2 = 1200 元/年（市值息率口径见下）
st.quoteCache['sh600036'] = { symbol: 'sh600036', name: '招商银行', code: '600036', price: 40, prevClose: 40.4, changePct: 1.0, quoteTime: '20260910150000' };
st.priceHistory['sh600036'] = { at: '2026-09-10', points: [['2026-08-01', 39], ['2026-09-01', 40], ['2026-09-10', 40]] };
st.snapshots['2026-09-10'] = { mv: 40000, cost: 40000, pred: 1200, recv: 0 };

console.log('\n--- 2) fireTargets：双口径 fireNumber ---');
{
  const s = C.summary(st, ALL);
  const tm = C.fireTargets(st, ALL, 'market');
  const tc = C.fireTargets(st, ALL, 'cost');
  close('market 口径 yieldPct == summary().marketYield', tm.yieldPct, s.marketYield, 1e-9);
  close('cost 口径 yieldPct == summary().costYield', tc.yieldPct, s.costYield, 1e-9);
  // 手工复算：市值 40000、P0 1200 → marketYield = 3%；成本 40000（无分红摊薄前）→ costYield = 3%
  close('market fireNumber(Regular) = 2000×12 ÷ 3%', tm.tiers.regular.fireNumber, 24000 / 0.03, 1e-6);
  close('market fiRatio(Regular) = 40000 / 800000 × 100', tm.tiers.regular.fiRatio, 5, 1e-9);
  close('★ capitalAt4 = 年支出 × 25', tm.tiers.lean.capitalAt4, 18000 * 25, 1e-9);
  eq('market 与 cost 是两个独立对象（口径字段不同）', [tm.yieldBasis, tc.yieldBasis], ['market', 'cost']);
}

console.log('\n--- 3) fireCfg：null 语义与 clamp ---');
{
  const fire = st.settings.fire;
  fire.tierSims.regular = { monthlySpend: null, drip: 999999, dripYieldPct: null };
  const cfg = C.fireCfg(st, ALL, 'regular', fire);
  close('monthlySpend=null → 该档真实台账 2000', cfg.monthlySpend, 2000, 1e-9);
  close('drip 超上限 → clamp 50000', cfg.drip, 50000, 1e-9);
  close('dripYieldPct=null → 组合息率（market 3%）', cfg.y, s2YieldPct(), 1e-9);
  eq('cfg.P0 = totalPredicted', cfg.P0, 1200);
  fire.tierSims.regular = { monthlySpend: 2500, drip: 3000, dripYieldPct: 6.5 };
  const cfg2 = C.fireCfg(st, ALL, 'regular', fire);
  eq('显式值直接采用', [cfg2.monthlySpend, cfg2.drip, cfg2.y], [2500, 3000, 6.5]);
  function s2YieldPct() { return C.summary(st, ALL).marketYield; }
}

console.log('\n--- 4) fireTimeline：与 forecastRows 交叉 + 三分支 ---');
{
  const fire = st.settings.fire;
  fire.tierSims.regular = { monthlySpend: 2000, drip: 5000, dripYieldPct: 8 };
  const cfg = C.fireCfg(st, ALL, 'regular', fire);
  const tl = C.fireTimeline(st, ALL, cfg);
  const rows = C.forecastRows({ annualInvest: cfg.X, yieldPct: cfg.y, years: 50, reinvestPct: cfg.r }, cfg.P0).rows;
  eq('solvable', tl.solvable, true);
  const N = Math.ceil(tl.exact);
  eq('交叉 · 第 ceil(exact) 年达标', rows[N - 1].monthly >= tl.targetMonthly, true);
  eq('交叉 · 前一年未达标', rows[N - 2].monthly < tl.targetMonthly, true);
  close('交叉 · D_N 与闭式逐位', C.forecastDividendAt({ annualInvest: cfg.X, yieldPct: cfg.y, years: 50, reinvestPct: cfg.r }, cfg.P0, N), rows[N - 1].dividend, 1e-9);
  close('fromNow 拆分 · y×12+m == round(exact×12)', tl.fromNow.y * 12 + tl.fromNow.m, Math.round(tl.exact * 12), 1e-9);

  // reached：目标 ≤ 当前被动收入（P0/12=100；目标 100 → reached）
  const tlR = C.fireTimeline(st, ALL, Object.assign({}, cfg, { monthlySpend: 100 }));
  eq('reached · months=0', [tlR.reached, tlR.months], [true, 0]);
  // no-growth：息率 0 且目标高于当前
  const tl0 = C.fireTimeline(st, ALL, Object.assign({}, cfg, { y: 0, dripYieldPct: 0, monthlySpend: 3000 }));
  eq('no-growth · 不可解', [tl0.solvable, tl0.reason], [false, 'no-growth']);
  // beyond-limit：极小投入 + 极大目标（y=30%，drip=100 → 50 年内不可能覆盖 30000/月）
  const tlB = C.fireTimeline(st, ALL, Object.assign({}, cfg, { dripYieldPct: 30, drip: 100, X: 1200, monthlySpend: 30000 }));
  eq('beyond-limit', tlB.solvable === false && tlB.reason === 'beyond-limit', true);
}

console.log('\n--- 5) fireMonthlyPassive：月度线性插值 × forecastRows 交叉 ---');
{
  const cfg = C.fireCfg(st, ALL, 'regular', Object.assign({}, st.settings.fire,
    { tierSims: { lean: {}, regular: { monthlySpend: 2000, drip: 5000, dripYieldPct: 8 }, fat: {} } }));
  const fc = { annualInvest: cfg.X, yieldPct: cfg.y, years: 50, reinvestPct: cfg.r };
  close('t=0 → P0/12', C.fireMonthlyPassive(cfg, 0), cfg.P0 / 12, 1e-9);
  [3, 6, 18, 30].forEach(function (mo) {
    const k = Math.floor(mo / 12), i = mo - k * 12;
    const Dk = C.forecastDividendAt(fc, cfg.P0, k);
    const Dk1 = C.forecastDividendAt(fc, cfg.P0, k + 1);
    close('t=' + mo + ' 月 == 年内线性', C.fireMonthlyPassive(cfg, mo), (Dk + (Dk1 - Dk) * (i / 12)) / 12, 1e-9);
  });
  const rows = C.forecastRows(fc, cfg.P0).rows;
  close('t=12 个月 == rows[0].monthly', C.fireMonthlyPassive(cfg, 12), rows[0].monthly, 1e-9);
  close('t=24 个月 == rows[1].monthly', C.fireMonthlyPassive(cfg, 24), rows[1].monthly, 1e-9);
}

console.log('\n--- 6) fireCoverageHistory：折 CNY / 缺月 / 外推 ---');
{
  const hs = mkState();
  addRecv(hs, 'r1', 'sh600036', '2026-01-10', 1000);   // CNY 1000
  addRecv(hs, 'r2', 'hk00700', '2026-01-20', 500);     // HKD 500 → ×0.9 = 450
  hs.symbols['hk00700'] = { symbol: 'hk00700', code: '00700', market: 'hk', name: '腾讯控股', type: 'STOCK' };
  const cfg = { P0: 0, X: 12000, y: 10, r: 100, monthlySpend: 1500, drip: 1000, dripYieldPct: 10, baseYieldPct: 10, yieldBasis: 'market' };
  const cov = C.fireCoverageHistory(hs, ALL, 'lean', cfg);
  const jan = cov.history.find(h => h.date === '2026-01');
  close('★ 2026-01 = (1000 + 500×0.9)/1500 × 100', jan.pct, 1450 / 1500 * 100, 1e-9);
  eq('对照 · byMonth 原币 = 1500（≠1450，折算确实生效）', C.stats(hs, ALL).byMonth['2026-01'], 1500);
  const feb = cov.history.find(h => h.date === '2026-02');
  close('缺月 = 0', feb.pct, 0, 1e-9);
  const yms = cov.history.map(h => h.date);
  eq('首月 = 首笔到账月', yms[0], '2026-01');
  eq('末月 = 当前月（沙箱真实时钟）', yms[yms.length - 1], XJ.util.ymOf(XJ.util.today()));
  let contiguous = true;
  for (let i = 1; i < yms.length; i++) {
    const [yy, mm] = yms[i - 1].split('-').map(Number);
    const nxt = (mm === 12) ? (yy + 1) + '-01' : yy + '-' + String(mm + 1).padStart(2, '0');
    if (yms[i] !== nxt) contiguous = false;
  }
  eq('无断档（逐月连续）', contiguous, true);
  close('外推第 12 个月 == (P0 + y·X)/12 ÷ 分母', cov.future[11].pct, ((0 + 0.10 * 12000) / 12) / 1500 * 100, 1e-9);
  close('外推收口 · 末点 ≥ 100（达标即停）', cov.future[cov.future.length - 1].pct >= 100 ? 1 : 0, 1, 0);
  close('外推单调不减（被动收入只增）',
    cov.future.every((p, i) => i === 0 || p.pct >= cov.future[i - 1].pct) ? 1 : 0, 1, 0);
}

console.log('\n--- 7) fireProgress：与 fireTargets 一致 + series 末点 ---');
{
  const pr = C.fireProgress(st, ALL, 'market');
  const tg = C.fireTargets(st, ALL, 'market');
  close('fireNumber 与 fireTargets 逐位一致', pr.tiers.regular.fireNumber, tg.tiers.regular.fireNumber, 1e-9);
  close('fiRatio == 本金 ÷ fireNumber × 100', pr.tiers.regular.ratio, pr.fiPrincipal / pr.tiers.regular.fireNumber * 100, 1e-9);
  close('gap = max(0, fireNumber − 本金)', pr.tiers.regular.gap, Math.max(0, pr.tiers.regular.fireNumber - pr.fiPrincipal), 1e-9);
  close('series 末点 == 快照 mv（快照覆盖口径）', pr.series.length ? pr.series[pr.series.length - 1].mv : 0, 40000, 1e-9);
}

console.log('\n--- 8) fireSceneSolve：方向 / clamp / 相对默认 ---');
{
  const fire = st.settings.fire;
  fire.tierSims.regular = { monthlySpend: 2500, drip: 3000, dripYieldPct: 6.5 };
  const base = C.fireSceneSolve(st, ALL, 'regular', fire, { spendPct: 0, dripPct: 0, yieldAdjPct: 0 });
  close('基准（全 0 场景）== 默认参数（spend=台账 2000，不随 sim 2500）', base.params.monthlySpend, 2000, 1e-9);
  close('基准 drip = 5000（相对默认，而非 sim 3000）', base.params.drip, 5000, 1e-9);
  const sc = C.fireSceneSolve(st, ALL, 'regular', fire, { spendPct: -20, dripPct: 100, yieldAdjPct: 2 });
  close('场景参数：spend 2000×0.8=1600', sc.params.monthlySpend, 1600, 1e-9);
  close('场景参数：drip 5000×2=10000', sc.params.drip, 10000, 1e-9);
  close('场景参数：息率 3%+2=5%', sc.params.dripYieldPct, 5, 1e-9);
  if (sc.scene.solvable && base.scene.solvable && !base.scene.reached) {
    eq('少花钱多攒股 → 自由日不晚于基准', sc.scene.months <= base.scene.months, true);
    close('Δ = scene.months − base.months（有符号）',
      sc.delta.y * 12 + sc.delta.m, Math.round(Math.abs(sc.scene.months - base.scene.months)), 1e-9);
  }
  const cl = C.fireSceneSolve(st, ALL, 'regular', fire, { spendPct: 0, dripPct: 0, yieldAdjPct: 99 });
  close('息率 clamp 到 30', cl.params.dripYieldPct, 30, 1e-9);
  const cl2 = C.fireSceneSolve(st, ALL, 'regular', fire, { spendPct: -999, dripPct: 0, yieldAdjPct: 0 });
  eq('spend clamp 到 −100%（目标 0 → reached）', [cl2.scene.reached, cl2.params.monthlySpend], [true, 0]);
}

console.log('\n--- 9) v6 迁移幂等（v5 备份 → v6） ---');
{
  const v5raw = {
    version: 5,
    accounts: [{ accountId: 'a1', name: 'A', type: 'BROKER', sortOrder: 1, createdAt: '2026-01-01T00:00:00Z' }],
    expenses: [
      { expenseId: 'e1', key: 'PHONE', label: '话费', icon: '💬', monthlyAmount: 60, enabled: true, sortOrder: 1 },
    ],
    settings: { defaultAccountId: 'a1' },
    transactions: [], plans: {}, received: [], symbols: {}, quoteCache: {},
  };
  const m1 = M.fromImport(v5raw);
  eq('存量支出全归 essential', m1.expenses.every(e => e.category === 'essential'), true);
  eq('settings.fire 三档补齐（drip 默认 5000）',
    ['lean', 'regular', 'fat'].every(t => m1.settings.fire.tierSims[t].drip === 5000), true);
  eq('版本号 → 6', m1.version, 6);
  /* createdAt 由 defaultState() 每次现生成（toExport/fromImport 白名单都不带它），
     幂等断言需剔除这个纯本机时间戳再比较全量 JSON。 */
  const strip = (o) => { const c = JSON.parse(JSON.stringify(o)); delete c.createdAt; return JSON.stringify(c); };
  eq('★ 幂等（再导入除 createdAt 外 JSON 全等）', strip(M.fromImport(m1)), strip(m1));
}

console.log('\n--- 8) fireEffectiveSpend：提取抵扣（再投比例 → 可支配分红 → 目标支出） ---');
{
  /* A. 纯函数公式：offset = P0/12 × (1−r/100)；effective = max(0, base − offset) */
  const E = (base, P0, r, extra) => C.fireEffectiveSpend(Object.assign({ monthlySpend: base, P0, r }, extra || {}));
  close('★ r=100% → offset=0（回归：默认路径零变化）', E(2000, 1200, 100).offset, 0, 1e-9);
  close('★ r=100% → effective === base（逐位）', E(2000, 1200, 100).effective, 2000, 1e-9);
  close('r=50% → offset = 100×0.5 = 50', E(2000, 1200, 50).offset, 50, 1e-9);
  close('r=50% → effective = 1950', E(2000, 1200, 50).effective, 1950, 1e-9);
  close('r=0% → offset = 全额月分红 100', E(2000, 1200, 0).offset, 100, 1e-9);
  close('r=0% → effective = 1900', E(2000, 1200, 0).effective, 1900, 1e-9);
  close('r 超 100 → clamp 100（offset=0）', E(2000, 1200, 150).offset, 0, 1e-9);
  close('P0 负数 → 按 0（offset=0）', E(2000, -5, 0).offset, 0, 1e-9);
  eq('cfg.r 缺失 → 回退 reinvestPct 字段', C.fireEffectiveSpend({ monthlySpend: 2000, P0: 1200, reinvestPct: 0 }).offset, 100);

  /* B. 抵扣达成：offset ≥ base → effective=0 且 covered */
  const cov8 = E(80, 1200, 0);
  close('抵扣 ≥ 支出 → effective = 0', cov8.effective, 0, 1e-9);
  eq('covered = true', cov8.covered, true);
  eq('base=0 不算 covered（无目标即无「达成」语义）', E(0, 1200, 0).covered, false);

  /* C. 三档一致性：offset 持仓级（三档相同），effective 差值 === base 差值 */
  st.settings.fire.reinvestPct = 0;
  const tg0 = C.fireTargets(st, ALL, 'market');
  close('Lean effective = 1500−100', tg0.tiers.lean.effective, 1400, 1e-9);
  close('Regular effective = 2000−100', tg0.tiers.regular.effective, 1900, 1e-9);
  close('Fat effective = 2500−100', tg0.tiers.fat.effective, 2400, 1e-9);
  eq('★ 三档 offset 相同（持仓级抵扣）', [tg0.tiers.lean.offset, tg0.tiers.regular.offset, tg0.tiers.fat.offset], [100, 100, 100]);
  close('effective 差值 === base 差值（500）', tg0.tiers.fat.effective - tg0.tiers.lean.effective,
    tg0.tiers.fat.monthly - tg0.tiers.lean.monthly, 1e-9);
  close('fireNumber(Regular) = 1900×12 ÷ 3%', tg0.tiers.regular.fireNumber, 1900 * 12 / 0.03, 1e-6);
  close('fireNumber 比值 = effective/base', tg0.tiers.regular.fireNumber / (24000 / 0.03), 1900 / 2000, 1e-9);
  close('offsetMonthly 透出 = 100', tg0.offsetMonthly, 100, 1e-9);

  /* D. fireTimeline：target = effective；抵扣覆盖全部支出 → reached(0) */
  const fire0 = st.settings.fire;
  fire0.tierSims.regular = { monthlySpend: 2000, drip: 5000, dripYieldPct: 8 };
  const cfg0 = C.fireCfg(st, ALL, 'regular', fire0);
  const tl0 = C.fireTimeline(st, ALL, cfg0);
  close('tl.targetMonthly = effective(1900)', tl0.targetMonthly, 1900, 1e-9);
  close('tl.baseMonthly = 2000', tl0.baseMonthly, 2000, 1e-9);
  close('tl.offsetMonthly = 100', tl0.offsetMonthly, 100, 1e-9);
  close('tl.monthlyPassive0 = P0/12 = 100', tl0.monthlyPassive0, 100, 1e-9);
  eq('coveredByOffset = false（抵扣未覆盖全部）', tl0.coveredByOffset, false);
  fire0.tierSims.regular = { monthlySpend: 80, drip: 5000, dripYieldPct: 8 };
  const tlC = C.fireTimeline(st, ALL, C.fireCfg(st, ALL, 'regular', fire0));
  eq('★ 抵扣覆盖全部支出 → reached', tlC.reached, true);
  eq('coveredByOffset = true', tlC.coveredByOffset, true);
  close('months = 0', tlC.months, 0, 1e-9);
  close('targetMonthly = 0', tlC.targetMonthly, 0, 1e-9);

  /* E. 覆盖率分母 = effective（cfg 直构，免依赖 received 细节） */
  const cfgE = { P0: 1200, X: 12000, y: 10, r: 0, monthlySpend: 2000, drip: 1000, dripYieldPct: 10, baseYieldPct: 10, yieldBasis: 'market' };
  const covE = C.fireCoverageHistory(st, ALL, 'regular', cfgE);
  close('cov.targetMonthly = 1900（抵扣后）', covE.targetMonthly, 1900, 1e-9);
  close('cov.baseMonthly = 2000', covE.baseMonthly, 2000, 1e-9);
  close('cov.offsetMonthly = 100', covE.offsetMonthly, 100, 1e-9);
  eq('cov.coveredByOffset = false', covE.coveredByOffset, false);
  const cfgZ = Object.assign({}, cfgE, { monthlySpend: 80 });
  const covZ = C.fireCoverageHistory(st, ALL, 'regular', cfgZ);
  close('★ 目标归零 → pct 全 null（视图翻译为「已完全覆盖」）',
    covZ.history.every(h => h.pct === null) && covZ.future.every(f => f.pct === null) ? 1 : 0, 1, 0);
  eq('coveredByOffset = true', covZ.coveredByOffset, true);

  /* F. fireProgress 与 fireTargets 口径一致（r=0 下再验，FI 进度卡继承抵扣） */
  const pr0 = C.fireProgress(st, ALL, 'market');
  close('progress.fireNumber == targets.fireNumber（抵扣口径同步）', pr0.tiers.regular.fireNumber, tg0.tiers.regular.fireNumber, 1e-9);

  /* 还原默认（后续组依赖 state 干净） */
  st.settings.fire.reinvestPct = 100;
  fire0.tierSims.regular = { monthlySpend: 2000, drip: 5000, dripYieldPct: 8 };
}

console.log('\n' + '='.repeat(52));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exitCode = 1; else console.log('全部通过 ✅');
console.log('='.repeat(52));
