/* 独立验证「派息日弹窗 + 分红汇总」的纯函数：
 *   calc.payoutsOn        —— 某一天的派息事件（弹窗用）
 *   calc.dividendRange    —— 时间档位 → 具体区间
 *   calc.dividendSummary  —— 按区间切汇总（已到账 / 预计到账分开）
 *   calc.funEquivalent    —— 「相当于 N 个月 ___」的 N
 *
 * 与 test-yieldcurve.mjs 同样的做法：在 Node 的 vm 沙箱里直接加载浏览器端的源文件，
 * 所以这里跑的就是页面上的那份代码。
 *
 * 第 1 段拿 verify.mjs 导出的 fixtures.json（真实方案 + 真实交易）验「当天派息」；
 * 第 2 段用一份**跨 6 年 / 2 账户 / 3 标的的合成数据**做区间扫描，
 *   每一步都用**另一套独立实现**逐分复算 —— 空数据上的 0===0 不算验证。
 *
 * 用法： node tools/test-divsum.mjs
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
const U = XJ.util;
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
const r2 = (v) => Math.round(v * 100) / 100;

/* ================================================================
 * 1) 真实 fixtures —— 当天派息（弹窗的数据源）
 * ================================================================ */
console.log('\n--- 1) fixtures.json 真实方案：当天派息 ---');
const fx = JSON.parse(read('fixtures.json'));
const fxState = M.fromImport(fx.state);

{
  /* sh600023：2025-03-10 买 1000 + 2025-06-20 买 1000（2026-02-11 才卖 500）
     → 股权登记日 2025-10-16 时持股 2000；中报 10 派 0.5 → 每股 0.05 → 到账 100 */
  const p = C.payoutsOn(fxState, ALL, '2025-10-17');
  eq('当天 1 笔派息', p.count, 1);
  eq('标的', p.items.map((e) => e.symbol), ['sh600023']);
  close('★ 金额 = 2000 股 × 0.05 元 = 100', p.total, 100, 1e-9);
  eq('★ 生效日走除权除息日 → 标为推算值（弹窗要加口径小字）', p.estimated, true);
  eq('取的是股权登记日当天的持股数（登记日 10-16 之后才卖的不算）', p.items[0].qty, 2000);

  /* sz000858：2024-09-02 买 1900，年报 10 派 25.79685 → 每股 2.579685 */
  const q = C.payoutsOn(fxState, ALL, '2026-07-16');
  eq('另一只标的的派息日', q.items.map((e) => e.symbol), ['sz000858']);
  close('金额 = 1900 × 2.579685', q.total, 1900 * 2.579685, 1e-6);

  eq('没有派息的日子 → 0 笔', C.payoutsOn(fxState, ALL, '2026-07-17').count, 0);
  eq('登记日当天不算派息日（只算 payout 事件）',
    C.payoutsOn(fxState, ALL, '2025-10-16').count, 0);
}

/* ================================================================
 * 2) 合成数据：跨 6 年 / 2 账户 / 3 标的 —— 区间扫描 + 独立复算
 * ================================================================ */
console.log('\n--- 2) 合成数据：五个档位 × 每个账户，全部独立复算 ---');

const T = '2026-09-18';
const st = M.defaultState();
st.accounts = [
  { accountId: 'acc_1', name: '主账户', sortOrder: 0 },
  { accountId: 'acc_2', name: '备用账户', sortOrder: 1 },
];
st.symbols = {};
[['sh600036', '招商银行'], ['sh601318', '中国平安'], ['sz000895', '双汇发展']]
  .forEach(function (p) { st.symbols[p[0]] = M.symbolRecord(p[0], { name: p[1] }); });

st.transactions = [
  { txId: 't1', accountId: 'acc_1', symbol: 'sh600036', date: '2024-01-05', action: 'BUY', quantity: 2000, price: 30, fee: 5, createdAt: '2024-01-05T01:00:00Z' },
  { txId: 't2', accountId: 'acc_1', symbol: 'sh601318', date: '2024-01-05', action: 'BUY', quantity: 1000, price: 45, fee: 5, createdAt: '2024-01-05T01:00:00Z' },
  { txId: 't3', accountId: 'acc_2', symbol: 'sz000895', date: '2026-01-05', action: 'BUY', quantity: 500, price: 25, fee: 5, createdAt: '2026-01-05T01:00:00Z' },
  { txId: 't4', accountId: 'acc_2', symbol: 'sh600036', date: '2024-01-05', action: 'BUY', quantity: 600, price: 30, fee: 5, createdAt: '2024-01-05T01:00:00Z' },
];
st.plans = {
  /* 今年之内、还没到期 → 应进「预计到账」：2000 股 × 0.10 = 200 */
  f1: { planId: 'f1', symbol: 'sh600036', reportDate: '2026-06-30', reportType: '中报', pretaxBonusPer10: 1, planNoticeDate: null, noticeDate: null, equityRecordDate: '2026-11-20', exDividendDate: '2026-11-20', isImplemented: true },
  /* 1000 股 × 0.40 = 400 */
  f2: { planId: 'f2', symbol: 'sh601318', reportDate: '2025-12-31', reportType: '年报', pretaxBonusPer10: 4, planNoticeDate: null, noticeDate: null, equityRecordDate: '2026-10-15', exDividendDate: '2026-10-15', isImplemented: true },
  /* 四个日期全缺 → 一律忽略 */
  f3: { planId: 'f3', symbol: 'sz000895', reportDate: '2026-03-31', reportType: '一季报', pretaxBonusPer10: 99, planNoticeDate: null, noticeDate: null, equityRecordDate: null, exDividendDate: null, isImplemented: false },
};

const RECV = [
  ['acc_1', 'sh600036', '2021-07-01', 900],
  ['acc_1', 'sh600036', '2022-07-08', 960],
  ['acc_1', 'sh600036', '2023-07-07', 1020],
  ['acc_1', 'sh600036', '2024-07-10', 1440],
  ['acc_1', 'sh600036', '2025-07-09', 2000],
  ['acc_1', 'sh601318', '2023-06-20', 600],
  ['acc_1', 'sh601318', '2024-06-20', 660],
  ['acc_1', 'sh601318', '2025-06-20', 720],
  ['acc_1', 'sh601318', '2026-06-20', 750],
  ['acc_2', 'sh600036', '2024-05-10', 300],
  ['acc_2', 'sh600036', '2025-05-10', 400],
  ['acc_2', 'sh600036', '2026-05-10', 500],
  ['acc_2', 'sz000895', '2026-08-15', 1200],
];
st.received = RECV.map(function (r, i) {
  return {
    recId: 'r' + (i + 1), accountId: r[0], symbol: r[1], planId: null,
    exDividendDate: r[2], perShareAmount: 0, qtyAtRecord: 0, amount: r[3],
    source: 'AUTO', createdAt: r[2] + 'T01:00:00Z',
  };
});

/** 独立实现①：直接扫 received 求和（不走 calc 的任何聚合） */
function indepTotal(acc, beg, end) {
  let s = 0;
  RECV.forEach(function (r) {
    if (acc !== ALL && r[0] !== acc) return;
    if (r[2] < beg || r[2] > end) return;
    s += r[3];
  });
  return s;
}
/** 独立实现②：按标的 */
function indepBySymbol(acc, beg, end) {
  const m = {};
  RECV.forEach(function (r) {
    if (acc !== ALL && r[0] !== acc) return;
    if (r[2] < beg || r[2] > end) return;
    m[r[1]] = (m[r[1]] || 0) + r[3];
  });
  return m;
}
/** 独立实现③：按年 */
function indepByYear(acc, beg, end) {
  const m = {};
  RECV.forEach(function (r) {
    if (acc !== ALL && r[0] !== acc) return;
    if (r[2] < beg || r[2] > end) return;
    const y = Number(r[2].slice(0, 4));
    m[y] = (m[y] || 0) + r[3];
  });
  return m;
}

const RANGES = {
  year: ['2026-01-01', '2026-12-31'],
  y2: ['2025-01-01', '2026-12-31'],
  y5: ['2022-01-01', '2026-12-31'],
  /* 「历史至今」的起点**随账户变**（各账户最早的一笔到账不同），所以单独算 */
  all: ['2021-07-01', T],
  custom: ['2024-01-01', '2025-12-31'],
};
function allBeg(acc) {
  let min = null;
  RECV.forEach(function (r) {
    if (acc !== ALL && r[0] !== acc) return;
    if (!min || r[2] < min) min = r[2];
  });
  return min || '2026-01-01';
}
const ACCOUNTS = [ALL, 'acc_1', 'acc_2'];

for (const acc of ACCOUNTS) {
  for (const key of Object.keys(RANGES)) {
    const spec = RANGES[key];
    const beg = key === 'all' ? allBeg(acc) : spec[0];
    /* 已到账的上界 = min(区间末, 今天)；all 档的区间末本来就是今天 */
    const cap = spec[1] < T ? spec[1] : T;
    const range = key === 'custom'
      ? { type: 'custom', beg: beg, end: spec[1] }
      : { type: key };
    const s = C.dividendSummary(st, acc, range, T);
    const tag = '[' + (acc === ALL ? '全部' : acc) + '/' + key + ']';

    eq('区间起点 ' + tag, s.range.beg, beg);
    close('★ total 与独立复算逐分一致 ' + tag, r2(s.total), r2(indepTotal(acc, beg, cap)), 0.005);
    eq('count = records.length ' + tag, s.count, s.records.length);
    close('按标的合计 = 总额 ' + tag,
      r2(s.bySymbolList.reduce((a, g) => a + g.amount, 0)), r2(s.total), 0.005);
    close('按年合计 = 总额 ' + tag,
      r2(s.years.reduce((a, y) => a + s.byYear[y], 0)), r2(s.total), 0.005);
    eq('按标的集合与独立复算一致 ' + tag,
      s.bySymbolList.map((g) => g.symbol).sort(), Object.keys(indepBySymbol(acc, beg, cap)).sort());
    eq('按年集合与独立复算一致 ' + tag,
      s.years.slice().sort(), Object.keys(indepByYear(acc, beg, cap)).map(Number).sort());
    eq('按标的按金额降序 ' + tag,
      s.bySymbolList.every((g, i) => i === 0 || s.bySymbolList[i - 1].amount >= g.amount), true);
    eq('按年从新到旧 ' + tag,
      s.years.every((y, i) => i === 0 || s.years[i - 1] > y), true);
    eq('★ 已到账记录一律 ≤ 今天 ' + tag,
      s.records.every((rec) => rec.exDividendDate <= T), true);
    eq('★ 预计到账事件一律 > 今天 ' + tag,
      s.pending.every((e) => e.date > T), true);
    eq('明细里每只标的的记录数 = 该标的 count ' + tag,
      s.bySymbolList.every((g) => g.records.length === g.count), true);
  }
}

console.log('\n--- 2b) 具体数字（人肉核对过的锚点） ---');
{
  const all = C.dividendSummary(st, ALL, { type: 'all' }, T);
  close('历史至今 = 11450', all.total, 11450, 1e-9);
  eq('历史至今 13 笔', all.count, 13);
  eq('历史至今起点 = 最早一笔', all.range.beg, '2021-07-01');
  eq('历史至今按年降序 = 2026..2021',
    all.years, [2026, 2025, 2024, 2023, 2022, 2021]);
  close('按年 2024 = 1440+660+300', all.byYear[2024], 2400, 1e-9);
  close('按年 2025 = 2000+720+400', all.byYear[2025], 3120, 1e-9);
  eq('按标的降序 = 招行 / 平安 / 双汇',
    all.bySymbolList.map((g) => g.symbol), ['sh600036', 'sh601318', 'sz000895']);
  close('招行合计 = 6320 + 1200', all.bySymbolList[0].amount, 7520, 1e-9);
  eq('★ 历史至今不含未来 → 预计 0', all.pendingTotal, 0);

  const y = C.dividendSummary(st, ALL, { type: 'year' }, T);
  close('今年已到账 750+500+1200 = 2450', y.total, 2450, 1e-9);
  /* 预计 = 招行 2000×0.10=200（acc_1） + 平安 1000×0.40=400（acc_1）
            + 招行 600×0.10=60（acc_2 也持有招行，同一条预案照样适用） */
  close('★ 今年预计到账 200+400+60 = 660', y.pendingTotal, 660, 1e-9);
  eq('今年预计 2 笔（★ 全部账户下同一标的会合并成一条事件）', y.pendingCount, 2);
  eq('预计明细按金额降序：平安 400 / 招行 260',
    y.pendingList.map((g) => [g.symbol, Math.round(g.amount)]),
    [['sh601318', 400], ['sh600036', 260]]);
  close('★ 主数字不含预计（是 2450 而不是 3110）', y.total, 2450, 1e-9);

  const y5 = C.dividendSummary(st, ALL, { type: 'y5' }, T);
  close('近5年 = 10550（排掉 2021 那 900）', y5.total, 10550, 1e-9);

  /* 账户过滤 */
  close('acc_1 历史至今 = 9050', C.dividendSummary(st, 'acc_1', { type: 'all' }, T).total, 9050, 1e-9);
  close('acc_2 历史至今 = 2400', C.dividendSummary(st, 'acc_2', { type: 'all' }, T).total, 2400, 1e-9);
  close('acc_2 今年预计 = 60（acc_2 持有招行 600 股，招行中报预案照样适用）',
    C.dividendSummary(st, 'acc_2', { type: 'year' }, T).pendingTotal, 60, 1e-9);
  close('acc_1 今年预计 = 600（招行 200 + 平安 400）',
    C.dividendSummary(st, 'acc_1', { type: 'year' }, T).pendingTotal, 600, 1e-9);
  eq('未知账户 → 0 笔', C.dividendSummary(st, 'acc_x', { type: 'all' }, T).count, 0);
}

console.log('\n--- 2c) 区间语义 ---');
{
  const tY = U.yearOf(T);
  eq('今年 → 01-01 ~ 12-31（上界取年末，好让预计到账算得进来）',
    [C.dividendRange(st, ALL, 'year', T).beg, C.dividendRange(st, ALL, 'year', T).end],
    [tY + '-01-01', tY + '-12-31']);
  eq('近2年 → 去年年初起', C.dividendRange(st, ALL, 'y2', T).beg, (tY - 1) + '-01-01');
  eq('近5年 → 往前 4 年', C.dividendRange(st, ALL, 'y5', T).beg, (tY - 4) + '-01-01');
  eq('★ 历史至今 → 上界就是今天', C.dividendRange(st, ALL, 'all', T).end, T);
  eq('传字符串档位也认（等价 {type:\'year\'}）',
    C.dividendRange(st, ALL, 'year', T).type, 'year');
  eq('自定义：end 早于 beg 时被夹到 beg',
    (function () { const r = C.dividendRange(st, ALL, { type: 'custom', beg: '2025-06-01', end: '2025-01-01' }, T); return [r.beg, r.end]; })(),
    ['2025-06-01', '2025-06-01']);
  eq('档位缺省 → 按今年',
    C.dividendRange(st, ALL, undefined, T).beg, tY + '-01-01');
  eq('DIVSUM_RANGES 五档（界面按这个顺序渲染）',
    C.DIVSUM_RANGES.map((x) => x.key), ['year', 'y2', 'y5', 'all', 'custom']);
  eq('每档都有中文标签', C.DIVSUM_RANGES.every((x) => !!x.label), true);
}

/* ================================================================
 * 3) 边界与趣味换算
 * ================================================================ */
console.log('\n--- 3) 趣味换算 / 空输入 ---');
{
  eq('5736.94 / 25 → 229（与参考图一致）', C.funEquivalent(5736.94, 25), 229);
  eq('不足一个月 → 0', C.funEquivalent(10, 25), 0);
  eq('月费为 0 → null（界面隐藏该行）', C.funEquivalent(5000, 0), null);
  eq('月费为负 → null', C.funEquivalent(5000, -3), null);
  eq('月费非数字 → null', C.funEquivalent(5000, 'abc'), null);
  eq('分红为 0 → null', C.funEquivalent(0, 25), null);
  eq('分红为负 → null', C.funEquivalent(-100, 25), null);
  eq('月费是小数也照算', C.funEquivalent(100, 12.5), 8);
}

{
  const empty = M.defaultState();
  empty.accounts = [{ accountId: 'acc_1', name: '主账户', sortOrder: 0 }];
  const s = C.dividendSummary(empty, ALL, { type: 'all' }, T);
  close('无任何记录 → 总额 0', s.total, 0, 1e-9);
  eq('无任何记录 → 0 笔', s.count, 0);
  eq('无任何记录 → 按标的 / 按年均为空', [s.bySymbolList, s.years], [[], []]);
  eq('无任何记录 → 历史至今起点退回今年年初', s.range.beg, '2026-01-01');
  eq('无方案 → 预计 0', s.pendingTotal, 0);
  eq('空状态跑 payoutsOn 不炸', C.payoutsOn(empty, ALL, T).count, 0);
  eq('空状态跑 dividendRange 不炸', C.dividendRange(empty, ALL, 'all', T).end, T);
}

console.log('\n' + '='.repeat(52));
console.log('分红汇总独立验证：' + pass + ' 通过 / ' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;
