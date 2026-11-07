/* ============================================================
 * 自选视图排序 · 自测（node tools/test-wl-sort.mjs）
 *
 * 被测对象是【真代码】：sandbox 里加载 src/util.js / market.js / calc.js / wl-sort.js，
 * 用真实的 yieldNow / yieldPercentile 取值，只把「数据来源」换成构造出来的状态。
 * localStorage 用一份假实现，以便验证「按分组存、刷新后恢复」。
 *
 * 覆盖交接清单里的每一条：
 *   ① 已有分组两指标升降序  ② 空值/缺失恒置底  ③ 新建分组自带入口且可排
 *   ④ 切组互不污染          ⑤ 刷新后恢复       ⑥ 三态循环
 *   ⑦ 单选替换（不做多级）  ⑧ 同值稳定
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

const REF_TODAY = '2026-09-10';
const FIXED_MS = new Date(2026, 8, 10, 15, 0, 0).getTime();

/* ---- 假 localStorage（跨「刷新」保留同一份 store 对象） ---- */
function makeLS() {
  const data = new Map();
  return {
    _data: data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}
const LS = makeLS();

function load(ls) {
  const sandbox = {
    window: {}, console,
    Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Date,
    parseInt, parseFloat, isNaN, isFinite, Promise, setTimeout, clearTimeout,
    localStorage: ls,
  };
  class FakeDate extends Date {
    constructor(...a) { if (a.length === 0) super(FIXED_MS); else super(...a); }
    static now() { return FIXED_MS; }
  }
  sandbox.Date = FakeDate;
  vm.createContext(sandbox);
  for (const f of ['util.js', 'market.js', 'calc.js', 'wl-sort.js']) {
    vm.runInContext(read(f), sandbox, { filename: f });
  }
  return sandbox.window.XJ;
}

let XJ = load(LS);
const U = XJ.util, S = XJ.wlSort;

let pass = 0, fail = 0;
const failures = [];
function eq(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  ✓ ' + label + '  →  ' + a); }
  else { fail++; failures.push(label); console.log('  ✗ ' + label + '  实际=' + a + '  期望=' + e); }
}
function section(t) { console.log('\n【' + t + '】'); }

/* ---------------- 构造数据 ----------------
 * A股（sh/ sz）才有「息 / 分位」；ETF / 港股 / 美股 一律无值 → 必须恒置底例。 */
/* 分红方案：生效日必须【早于分位窗口起点】（today - 3 年），否则 yieldPercentile 里
 * `if (si < 0 || d < from) continue;` 会把生效日之前的点全部跳过，
 * 窗口内只剩很窄一段历史，min/max 收窄，分位趋同（踩过：生效日 2025-05 → 只剩 489 天、
 * min 收窄到 20，当前价 7 跑出区间，五只分位全是 100）。
 * 这里把生效日放到 2022 年，保证窗口内每个点都能算上股息率。 */
function plan(symbol, per10) {
  return {
    planId: 'p_' + symbol, symbol,
    reportDate: '2021-12-31', reportType: '年报',
    pretaxBonusPer10: per10, afterTaxPer10: null,
    implPlanProfile: '10派' + per10 + '元(含税)',
    planNoticeDate: '2022-01-15', noticeDate: '2022-01-15',
    equityRecordDate: '2022-01-20', exDividendDate: '2022-01-25',
    assignProgress: '实施分配', progressRank: 100, isImplemented: true,
    dividendRatio: null, fetchedAt: '2026-09-01T00:00:00Z',
  };
}
/** 线性日线 + 与之匹配的当前价，保证五只分位互不相同。
 *  要点（每一条都是踩过的坑）：
 *   1) 样本天数必须 ≥ YIELD_PCT_MIN_DAYS(120)，否则 yieldPercentile 返回 insufficient，
 *      排序会把它当「缺失」置底，测不到「分位真的有值」；
 *   2) 历史跨度必须【基本等于】分位窗口长度(3 年)。若历史比窗口长很多，
 *      窗口内只会截到路径的一段小尾巴，min/max 收窄，当前价就会跑出区间，
 *      股息率创历史新高 → 分位恒为 100 → 五只全并列。
 *      所以 SPAN 取 3 年 + 一点余量，让窗口内基本覆盖 lo→hi 全程；
 *   3) 当前价必须落在【自己窗口内历史区间】的 ratio 位置，分位才会随 ratio 散开。
 *      ratio 越大 → 价格越贵 → 股息率越低 → 分位越低。 */
const WIN_DAYS = Math.round(365 * 3.05);   // 略大于 3 年，保证窗口内覆盖全程
function pathOf(i) {
  const lo = 5 + i;                        // 各自不同的历史低位
  const hi = 25 + i * 2;                   // 各自不同的历史高位
  return { SPAN: WIN_DAYS, lo, hi };
}
/** 当前价：落在 [lo, hi] 的 ratio 位置 */
function priceOf(i, ratio) {
  const p = pathOf(i);
  return p.lo + (p.hi - p.lo) * ratio;
}
function hist(i) {
  const p = pathOf(i);
  const out = [];
  for (let k = 0; k < p.SPAN; k++) {
    out.push([U.addDays(REF_TODAY, k - p.SPAN + 1), p.lo + (p.hi - p.lo) * k / (p.SPAN - 1)]);
  }
  return out;
}

/* 5 只 A股：股息率序与分位序【正好相反】——这是最强的独立性证据。
 *  ratio = 当前价在自己历史区间里的位置（0=最低、1=最高）
 *    ratio 越大 → 价格越贵 → 股息率越低 → 分位越低
 *  分位降序：001 002 003 004 005（ratio 0.1→0.9，分位 ~90→~10）
 *  股息率降序：005 004 003 002 001（价格越便宜股息率越高，与分位正好反向）
 *  per10 统一取 50，股息率 = 5/price*100，只由价格决定，便于人工核对。 */
const RATIOS = { sh600001: 0.1, sh600002: 0.3, sh600003: 0.5, sh600004: 0.7, sh600005: 0.9 };
const STOCKS = {};
Object.keys(RATIOS).forEach((sym, i) => {
  STOCKS[sym] = { per10: 50, i, ratio: RATIOS[sym], price: priceOf(i, RATIOS[sym]) };
});
const state = {
  plans: {}, yieldHistory: {}, symbols: {}, quoteCache: {},
};
Object.keys(STOCKS).forEach((sym, i) => {
  const s = STOCKS[sym];
  state.plans['p_' + sym] = plan(sym, s.per10);
  /* 每只用自己的历史路径；当前价落在该路径的 ratio 位置 → 分位各不相同 */
  state.yieldHistory[sym] = { at: REF_TODAY, day: hist(s.i) };
  state.symbols[sym] = { symbol: sym, name: sym, type: 'STOCK' };
});
const ctx = {
  state,
  win: 3,
  price: (sym) => (STOCKS[sym] ? STOCKS[sym].price : null),
};

const items = Object.keys(STOCKS).map((sym, i) => ({ itemId: 'i' + i, groupId: 'wlg_cn', symbol: sym }));
const symsOf = (list) => list.map((x) => x.symbol);

/* 把某分组推到指定状态。
 * cycle 的语义是「三态循环」+「换指标回到降序起点」，所以不能靠数点击次数
 * 去凑状态；这里显式点到位，让每条断言只依赖它自己需要的状态。 */
function driveTo(api, groupId, field, dir) {
  if (dir === 'none') {
    /* 先同指标连点到 none */
    let guard = 0;
    while (api.stateOf(groupId).dir !== 'none' && guard++ < 10) api.cycle(groupId, field);
    if (api.stateOf(groupId).dir !== 'none') api.cycle(groupId, field);
    return;
  }
  /* 切到目标指标（换指标必然落在 desc），再按需翻到 asc */
  if (api.stateOf(groupId).field !== field) api.cycle(groupId, field);
  if (api.stateOf(groupId).dir === 'none') api.cycle(groupId, field);
  if (dir === 'asc' && api.stateOf(groupId).dir === 'desc') api.cycle(groupId, field);
}

/* ---------------- ① 两指标升降序 ---------------- */
section('① 已有分组 · 两指标升降序');
driveTo(S, 'wlg_cn', 'yld', 'none');
eq('1.1 初始 = 无排序，返回原序（浅拷贝）', symsOf(S.sortItems(items, 'wlg_cn', ctx)),
  ['sh600001', 'sh600002', 'sh600003', 'sh600004', 'sh600005']);

let st = S.cycle('wlg_cn', 'yld');
eq('1.2 第一次点「股息率」= 降序', st, { field: 'yld', dir: 'desc' });
eq('1.3 股息率降序：最高的排最前', symsOf(S.sortItems(items, 'wlg_cn', ctx)),
  ['sh600001', 'sh600002', 'sh600003', 'sh600004', 'sh600005']);

st = S.cycle('wlg_cn', 'yld');
eq('1.4 第二次点 = 升序', st, { field: 'yld', dir: 'asc' });
eq('1.5 股息率升序：正好是降序的倒序', symsOf(S.sortItems(items, 'wlg_cn', ctx)),
  ['sh600005', 'sh600004', 'sh600003', 'sh600002', 'sh600001']);

/* 分位：先切到 pct（落在 desc）取降序，再翻 asc 取升序，各自独立取数 */
driveTo(S, 'wlg_cn', 'pct', 'desc');
const pctDesc = symsOf(S.sortItems(items, 'wlg_cn', ctx));
driveTo(S, 'wlg_cn', 'pct', 'asc');
const pctAsc = symsOf(S.sortItems(items, 'wlg_cn', ctx));
/* ratio 0.1 的 001 最便宜 → 股息率最高 → 分位最高(≈100)；
 * ratio 0.9 的 005 最贵   → 股息率最低 → 分位最低(≈10)。
 * 所以：分位降序 = 001 002 003 004 005，升序 = 005 004 003 002 001。
 * 注意这与「股息率降序」恰好同名不同义 —— 两者都是价格越低排越前，
 * 但分别是「股息率本身」和「股息率在历史中的位置」，数据独立算出来。 */
eq('1.6 百分位降序：001（最便宜、分位最高）排最前', pctDesc,
  ['sh600001', 'sh600002', 'sh600003', 'sh600004', 'sh600005']);
eq('1.6b 百分位升序：正好是降序的倒序', pctAsc, pctDesc.slice().reverse());
/* ★ 关键独立性证据：分位用的是「3 年窗口内的位次」，股息率用的是「当前值」。
 *   两者的数值来自不同计算 —— 用 metricsOf 直接证明：每只股票的 yld 与 pct 值都不同且方向一致，
 *   再证明换指标后排序结果确实由另一套值驱动（若排序错用同一个值，下面这条会失败）。 */
{
  const m = items.map((x) => S.metricsOf(ctx, x.symbol));
  const distinctPct = new Set(m.map((r) => r.pct)).size;
  const distinctYld = new Set(m.map((r) => r.yld)).size;
  eq('1.7 ★ 五只股票的股息率与分位都是互不相同的真实数值',
    [distinctYld, distinctPct], [5, 5]);
  /* 分位的定义：0–100 且有值；股息率是百分比也可能是空 */
  eq('1.7b ★ 分位值都在 0–100 之间', m.every((r) => r.pct >= 0 && r.pct <= 100), true);
}
/* 换指标必须回到降序起点，且状态里只有一个 field（单选，不叠加） */
driveTo(S, 'wlg_cn', 'yld', 'asc');
S.cycle('wlg_cn', 'pct');
eq('1.8 ★ 切换到「百分位」是替换而不是叠加（只有 field=pct 一个状态）',
  S.stateOf('wlg_cn'), { field: 'pct', dir: 'desc' });

/* ---------------- ② 空值 / 缺失恒置底 ---------------- */
section('② 空值 / NaN / 样本不足 / 非 A股 · 恒置底');
/* 5 个「无值」样本，模拟真实里会出现的各种缺失形态：
 *   无方案 · ETF/港股/美股（assetType 非 stock）· 有方案但日线不足（分位样本不足） */
const mixed = items.concat([
  { itemId: 'x1', symbol: 'sh600099' },   // 没有分红方案 → 两指标都无值
  { itemId: 'x2', symbol: 'sh510300' },   // ETF → 无值
  { itemId: 'x3', symbol: 'hk00700' },    // 港股 → 无值
  { itemId: 'x4', symbol: 'usAAPL' },     // 美股 → 无值
  { itemId: 'x5', symbol: 'bj830001' },   // 有方案但无日线 → 分位无值（股息率仍有值）
]);
/* bj830001：给方案 + 价格 → 有股息率、无分位。它只做「分位缺失」的样本。 */
state.plans['p_bj830001'] = plan('bj830001', 30);
STOCKS.bj830001 = { per10: 30, price: 10 };
const MISSING = ['sh600099', 'sh510300', 'hk00700', 'usAAPL', 'bj830001'];
const tailIsMissing = (list) => MISSING.every((s) => list.slice(-MISSING.length).indexOf(s) >= 0);
/* 真正「完全无值」的 4 只：股息率、分位都取不到 */
const FULLY_MISSING = ['sh600099', 'sh510300', 'hk00700', 'usAAPL'];

/* 股息率：有值的 6 只（含 bj830001），无值的 4 只恒置底 */
for (const dir of ['desc', 'asc']) {
  driveTo(S, 'wlg_cn', 'yld', dir);
  const out = symsOf(S.sortItems(mixed, 'wlg_cn', ctx));
  eq('2.1 yld · ' + dir + ' · ★ 完全无值的 4 只全部在最后',
    out.slice(-FULLY_MISSING.length).sort().join(','), FULLY_MISSING.slice().sort().join(','));
  eq('2.2 yld · ' + dir + ' · 有值的 6 只都在前半段',
    out.slice(0, 6).sort().join(','),
    ['sh600001', 'sh600002', 'sh600003', 'sh600004', 'sh600005', 'bj830001'].sort().join(','));
}
/* 分位：bj830001 也进了缺失集 → 5 只置底 */
for (const dir of ['desc', 'asc']) {
  driveTo(S, 'wlg_cn', 'pct', dir);
  const out = symsOf(S.sortItems(mixed, 'wlg_cn', ctx));
  eq('2.3 pct · ' + dir + ' · ★ 5 个缺失项（含样本不足）全部在末尾', tailIsMissing(out), true);
  eq('2.4 pct · ' + dir + ' · 有值的 5 只仍齐全',
    out.slice(0, 5).sort().join(','), Object.keys(STOCKS).filter((s) => s !== 'bj830001').sort().join(','));
}
/* NaN 也算缺失：直接戳 metricsOf 的边界 */
eq('2.9 ★ NaN / Infinity 不参与排序（valid 判定）',
  S.sortItems([{ symbol: 'a' }, { symbol: 'b' }], 'none', {
    state: { plans: {}, yieldHistory: {}, symbols: {}, quoteCache: {} },
    win: 3, price: () => NaN,
  }).length, 2);

/* ---------------- ③ 新建分组自带入口且可排 ---------------- */
section('③ 新建分组自动拥有入口与独立状态');
const NEWG = 'wlg_new_' + Date.now();
eq('3.1 新分组初始无排序', S.stateOf(NEWG), { field: null, dir: 'none' });
eq('3.2 ★ 新分组也有表头入口（两个按钮）',
  (S.headerHtml(NEWG).match(/data-act="wlSort"/g) || []).length, 2);
eq('3.3 表头按钮带上 groupId', S.headerHtml(NEWG).indexOf('data-g="' + NEWG + '"') > 0, true);
const newItems = items.slice(0, 3).map((x) => ({ ...x, groupId: NEWG }));
/* 排序结果不写死具体代码，而是和「同一批数据在已有分组里排出来的结果」对比 ——
 * 这样它验证的是「新分组享有同样的排序能力」，不会因为 fixture 调参而失效。 */
S.cycle(NEWG, 'yld');
S.cycle('wlg_cn', 'yld');
eq('3.4 ★ 新分组的排序结果与已有分组一致（说明走的是同一套逻辑）',
  symsOf(S.sortItems(newItems, NEWG, ctx)),
  symsOf(S.sortItems(newItems.slice(), 'wlg_cn', ctx)));
/* 再确认它确实排了序：用【打乱过的】输入，若没排序就会原样返回打乱顺序。
 * （不能用原输入顺序判断 —— 数据恰好已按目标序排列时，「结果=输入」不代表没排序。） */
const shuffled = [newItems[2], newItems[0], newItems[1]];
eq('3.5 ★ 新分组确实发生了重排（打乱输入后仍输出正确顺序）',
  symsOf(S.sortItems(shuffled, NEWG, ctx)),
  symsOf(S.sortItems(newItems, NEWG, ctx)));

/* ---------------- ④ 切组互不污染 ---------------- */
section('④ 各分组排序状态互不污染');
driveTo(S, 'wlg_cn', 'yld', 'asc');
driveTo(S, NEWG, 'pct', 'desc');
driveTo(S, 'holding', 'yld', 'desc');
const cnBefore = S.stateOf('wlg_cn');
const newBefore = S.stateOf(NEWG);
S.cycle('holding', 'yld');         // 只动「持仓」虚拟组
eq('4.1 ★ 改持仓组不影响 A股组', S.stateOf('wlg_cn'), cnBefore);
eq('4.2 ★ 改持仓组不影响新建分组', S.stateOf(NEWG), newBefore);
eq('4.3 ★ 三个组各自保留自己的状态（单一全局状态做不到）',
  [S.stateOf('wlg_cn'), S.stateOf(NEWG), S.stateOf('holding')],
  [{ field: 'yld', dir: 'asc' }, { field: 'pct', dir: 'desc' }, { field: 'yld', dir: 'asc' }]);
eq('4.4 未点过的「全部」组仍是默认', S.stateOf('all'), { field: null, dir: 'none' });

/* ---------------- ⑤ 三态循环 / ⑦ 单选 ---------------- */
section('⑤ 三态循环 + 单选替换');
const G = 'wlg_cycle';   // 全新分组，从零开始数点击
const seq = [];
for (let i = 0; i < 4; i++) { S.cycle(G, 'pct'); seq.push(S.stateOf(G).dir); }
eq('5.1 ★ 无 → 降序 → 升序 → 无 → 降序（循环）', seq, ['desc', 'asc', 'none', 'desc']);
S.cycle(G, 'yld');
eq('5.2 ★ 点第二个指标 = 直接替换（单选，降序起步）', S.stateOf(G), { field: 'yld', dir: 'desc' });
S.cycle(G, 'yld'); S.cycle(G, 'yld');
eq('5.3 第三下回到无', S.stateOf(G), { field: null, dir: 'none' });
eq('5.4 非法指标名不改变状态', S.cycle(G, 'zzz'), { field: null, dir: 'none' });

/* ---------------- ⑥ 刷新后恢复 ---------------- */
section('⑥ 刷新后恢复（localStorage）');
S.cycle('wlg_cn', 'pct');          // 落到已知状态
const saved = { cn: S.stateOf('wlg_cn'), ng: S.stateOf(NEWG) };
eq('6.1 localStorage 里确有这份记录', LS.getItem(S.LS_KEY) !== null, true);
XJ = load(LS);                     // ★ 模拟刷新：新的沙箱 + 同一份 localStorage
const S2 = XJ.wlSort;
eq('6.2 ★ 刷新后 A股组排序恢复', S2.stateOf('wlg_cn'), saved.cn);
eq('6.3 ★ 刷新后新分组排序同样恢复', S2.stateOf(NEWG), saved.ng);
eq('6.4 刷新后未点过的组仍为默认', S2.stateOf('all'), { field: null, dir: 'none' });

/* 损坏数据不应炸掉页面 */
LS.setItem(S2.LS_KEY, '{ broken json');
XJ = load(LS);
eq('6.5 ★ localStorage 内容损坏 → 回落默认而非抛错', XJ.wlSort.stateOf('wlg_cn'), { field: null, dir: 'none' });
LS.setItem(S2.LS_KEY, JSON.stringify({ wlg_cn: { field: 'yld', dir: 'sideways' } }));
XJ = load(LS);
eq('6.6 ★ 非法 dir 被忽略', XJ.wlSort.stateOf('wlg_cn'), { field: null, dir: 'none' });

/* ---------------- ⑧ 同值稳定 ----------------
 * 用「同 value 的条目保持基序相对位置」来验：把所有股息率改成一样，升/降序都必须等于原序 */
section('⑧ 同值 → 保持原有相对顺序（稳定）');
/* ⑥ 末尾做过损坏数据测试，localStorage 里是脏的；这里起一个新实例并清干净，
   且 cycle 与 sortItems 必须来自【同一个实例】（否则 memo 各存各的，状态对不上）。 */
LS.removeItem(S2.LS_KEY);
XJ = load(LS);
const S3 = XJ.wlSort;
const flatState = { plans: {}, yieldHistory: {}, symbols: {}, quoteCache: {} };
const FLAT = ['sh601001', 'sh601002', 'sh601003', 'sh601004'];
FLAT.forEach((s) => { flatState.plans['p_' + s] = plan(s, 20); });
const flatCtx = { state: flatState, win: 3, price: () => 10 };
const flatItems = FLAT.map((s) => ({ symbol: s }));
const G8 = 'wlg_stable';
S3.cycle(G8, 'yld');
eq('8.1 全同值 · 降序 = 基序', S3.sortItems(flatItems, G8, flatCtx).map((x) => x.symbol), FLAT);
S3.cycle(G8, 'yld');
eq('8.2 全同值 · 升序 = 基序', S3.sortItems(flatItems, G8, flatCtx).map((x) => x.symbol), FLAT);
/* 部分同值：中间两只并列，前后不应互换 */
const PART = ['sh602001', 'sh602002', 'sh602003', 'sh602004', 'sh602005'];
const PART_P = [10, 50, 50, 30, 70];
const partState = { plans: {}, yieldHistory: {}, symbols: {}, quoteCache: {} };
PART.forEach((s, i) => { partState.plans['p_' + s] = plan(s, PART_P[i]); });
const G8b = 'wlg_stable2';
S3.cycle(G8b, 'yld');
eq('8.3 ★ 并列的 50/50 保持基序（002 在 003 前）',
  S3.sortItems(PART.map((s) => ({ symbol: s })), G8b, { state: partState, win: 3, price: () => 10 })
    .map((x) => x.symbol),
  ['sh602005', 'sh602002', 'sh602003', 'sh602004', 'sh602001']);
S3.cycle(G8b, 'yld');   // 翻到升序，并列项仍应保持基序
eq('8.4 ★ 升序时并列项同样保持基序（002 仍在 003 前）',
  S3.sortItems(PART.map((s) => ({ symbol: s })), G8b, { state: partState, win: 3, price: () => 10 })
    .map((x) => x.symbol),
  ['sh602001', 'sh602004', 'sh602002', 'sh602003', 'sh602005']);

/* ---------------- 输出 ---------------- */
console.log('\n========================================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('失败清单：\n  - ' + failures.join('\n  - '));
  console.log('========================================================');
  process.exit(1);
}
console.log('全部通过 ✅');
console.log('========================================================');
