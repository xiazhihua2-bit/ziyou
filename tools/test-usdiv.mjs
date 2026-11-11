/* ============================================================================
 * 美股分红模块独立验收（零依赖，可单独运行：node tools/test-usdiv.mjs）
 *
 * 全部用固定夹具 + 独立复算，不发任何网络请求；接口行为以 2026-11-09 实测为准。
 * 覆盖：① 三种派息文案解析 ② 后缀探测 ③ 近 12 个月年度化口径
 *       ④ 未来预案不计入预测 ⑤ 真实派息日进日历 ⑥ 派息日已过自动到账且幂等
 *       ⑦ 单只失败 / 整批失败不影响其它市场
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

const TODAY = '2026-11-09';
const FIXED_MS = new Date(2026, 10, 9, 15, 0, 0).getTime();
class FakeDate extends Date {
  constructor(...a) { if (a.length === 0) super(FIXED_MS); else super(...a); }
  static now() { return FIXED_MS; }
}

const sandbox = {
  window: {}, console, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
  parseInt, parseFloat, isNaN, isFinite, Promise, setTimeout, clearTimeout, Date: FakeDate,
  encodeURIComponent, decodeURIComponent,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
/* 按依赖顺序加载：usdiv 依赖 util/market；fetcher 的 fetchDividends 会调用 XJ.usdiv */
for (const f of ['util.js', 'market.js', 'model.js', 'calc.js', 'usdiv.js', 'fetcher.js']) {
  vm.runInContext(read(f), sandbox, { filename: f });
}
const XJ = sandbox.window.XJ;
const U = XJ.util, C = XJ.calc, D = XJ.usdiv, MK = XJ.market;

let pass = 0, fail = 0;
function eq(label, a, b) {
  const ok = (a === b) || (a && b && typeof a === 'object' && JSON.stringify(a) === JSON.stringify(b));
  if (ok) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  FAIL ' + label + '  got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
function close(label, a, b, eps) {
  const ok = typeof a === 'number' && Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps);
  if (ok) { pass++; console.log('  ok  ' + label + ' = ' + a); }
  else { fail++; console.log('  FAIL ' + label + '  got=' + a + ' want=' + b); }
}
function section(t) { console.log('\n' + t); }

/* ---------------- 夹具 ---------------- */
function row(o) {
  return Object.assign({
    SECUCODE: 'AAPL.O', SECURITY_CODE: 'AAPL',
    NOTICE_DATE: '2026-07-30 00:00:00', ASSIGN_TYPE: 'Cash',
    PLAN_EXPLAIN: '每1股派0.27美元股息',
    EQUITY_RECORD_DATE: '2026-08-10 00:00:00',
    EX_DIVIDEND_DATE: '2026-08-08 00:00:00',
    BONUS_PAY_DATE: '2026-08-15 00:00:00',
    ASSIGN_PERIOD: '2026年中报',
  }, o || {});
}
function planObj(o) { return D.toPlan(row(o), 'usAAPL', '.O', TODAY); }

function mkState(plans, fx) {
  const st = XJ.model.defaultState();
  st.accounts = [{ accountId: 'acc_1', name: '测试账户', type: 'BROKER', sortOrder: 1, createdAt: '2025-01-01T00:00:00Z' }];
  st.symbols = { usAAPL: { symbol: 'usAAPL', code: 'AAPL', market: 'us', name: '苹果', type: 'STOCK' } };
  st.transactions = [{
    txId: 'u1', accountId: 'acc_1', symbol: 'usAAPL', action: 'BUY',
    date: '2025-01-06', quantity: 10, price: 200, fee: 0, createdAt: '2025-01-06T01:00:00Z',
  }];
  st.quoteCache = { usAAPL: { symbol: 'usAAPL', name: '苹果', price: 210, prevClose: 209, changePct: 0.4 } };
  st.plans = plans || {};
  st.received = [];
  XJ.model.ensureBootstrapped(st);
  st.settings.fx = fx === undefined ? { HKD: 0.92, USD: 7.1 } : fx;
  return st;
}
function addPlan(map, p) { map[p.planId] = p; return map; }

async function main() {
  /* ============ ① 三种派息文案解析 ============ */
  section('【1】PLAN_EXPLAIN 三种形态 + 只认美元 + 拆股过滤');
  close('「每1股派0.27美元股息」→ 每股 0.27', D.parsePerShare('每1股派0.27美元股息'), 0.27);
  close('「每1份派0.75143美元股息」→ 每份 0.75143', D.parsePerShare('每1份派0.75143美元股息'), 0.75143);
  close('「每1份ADR派1.085439美元股息」→ 每份 1.085439', D.parsePerShare('每1份ADR派1.085439美元股息'), 1.085439);
  close('「每10股派2.7美金股息」→ 每股 0.27（金额 ÷ 份数）', D.parsePerShare('每10股派2.7美金股息'), 0.27);
  eq('非美元文案「每1股派0.27港元股息」→ null', D.parsePerShare('每1股派0.27港元股息'), null);
  eq('拆股/股票股息文案 → null', D.parsePerShare('每10股送1股'), null);
  eq('空文案 → null', D.parsePerShare(''), null);
  close('同形方案 pretaxBonusPer10 = 每股美元 × 10', planObj().pretaxBonusPer10, 2.7);
  eq('同形方案 currency = USD / source = us', planObj().currency + '/' + planObj().source, 'USD/us');
  eq('税前口径 afterTaxPer10 = null', planObj().afterTaxPer10, null);
  eq('真实派息日 = BONUS_PAY_DATE（确定值，不是推算）', planObj().payoutDate, '2026-08-15');
  eq('reportDate = 除息日自然年 + -12-31', planObj().reportDate, '2026-12-31');
  eq('ASSIGN_TYPE=Stock（股票股息）不进台账', D.toPlan(row({ ASSIGN_TYPE: 'Stock' }), 'usAAPL', '.O', TODAY), null);
  eq('ASSIGN_TYPE 缺失也按「只收 Cash」排除', D.toPlan(row({ ASSIGN_TYPE: '' }), 'usAAPL', '.O', TODAY), null);
  eq('斜杠日期也能归一化', D.d10('2026/08/15'), '2026-08-15');

  /* ============ ② 后缀探测（首次命中即解析，缓存复用） ============ */
  section('【2】SECUCODE 后缀探测 .O → .N → .A');
  let calls = [];
  D.clearSuffixCache();
  D.useRequester(function (sec) {
    calls.push(sec);
    if (sec === 'AAPL.O') return [row()];
    return [];
  });
  let r = await D.fetchSymbol('usAAPL');
  eq('.O 首次命中：只发 1 次请求（探测与正式取数合并）', calls.join(','), 'AAPL.O');
  eq('.O 命中 → 后缀 .O', r.suffix, '.O');
  eq('.O 命中 → 解析出 1 条方案', r.plans.length, 1);
  eq('命中后 noData = false', r.noData, false);
  r = await D.fetchSymbol('usAAPL');
  eq('后缀缓存命中：再次同步仍只发 1 次请求', calls.join(','), 'AAPL.O,AAPL.O');
  eq('缓存命中取的是 known 后缀', D.suffixMap.usAAPL, '.O');

  D.clearSuffixCache();
  calls = [];
  D.useRequester(function (sec) {
    calls.push(sec);
    if (sec === 'KO.N') return [row({ SECUCODE: 'KO.N', SECURITY_CODE: 'KO' })];
    return [];
  });
  r = await D.fetchSymbol('usKO');
  eq('.O 空 → 继续 .N 命中，共 2 次请求', calls.join(','), 'KO.O,KO.N');
  eq('后缀 = .N（KO 在纽交所，实测 KO.O 返回 0 行）', r.suffix, '.N');

  D.clearSuffixCache();
  calls = [];
  D.useRequester(function (sec) { calls.push(sec); return []; });
  r = await D.fetchSymbol('usXYZ');
  eq('三个后缀都空 → 请求 3 次', calls.join(','), 'XYZ.O,XYZ.N,XYZ.A');
  eq('三个后缀都空 → 返回空方案，不编造数据', r.plans.length, 0);
  eq('三个后缀都空 → noData = true（界面如实展示空态）', r.noData, true);

  D.clearSuffixCache();
  calls = [];
  D.useRequester(function (sec) {
    calls.push(sec);
    if (sec === 'MSFT.O') throw new Error('单只接口异常');
    if (sec === 'MSFT.N') return [row({ SECUCODE: 'MSFT.N', SECURITY_CODE: 'MSFT' })];
    return [];
  });
  r = await D.fetchSymbol('usMSFT');
  eq('单只请求抛错 → 不 reject，自动试下一个后缀', calls.join(','), 'MSFT.O,MSFT.N');
  eq('单只请求抛错后仍能拿到方案', r.plans.length, 1);

  /* ============ ③ 近 12 个月年度化（不走财年） ============ */
  section('【3】预测年分红 = 近 12 个月（按除息日归属）已实施每股派息合计');
  eq('美股已接入自动同步', MK.dividendSource('usAAPL'), 'us');
  eq('美股 supportsDividend = true', MK.supportsDividend('usAAPL'), true);
  eq('美股 supportsYieldCurve = false（无年报预案公告日锚点）', MK.supportsYieldCurve('usAAPL'), false);

  const ttmPlans = {};
  /* 窗口内 4 个季度各 $0.25 → 合计 1.00；2025-10-01 那笔 $9.99 在 365 天窗口外，必须排除 */
  ['2025-11-15', '2026-02-15', '2026-05-15', '2026-08-15'].forEach(function (d) {
    addPlan(ttmPlans, D.toPlan(row({
      EX_DIVIDEND_DATE: d + ' 00:00:00',
      EQUITY_RECORD_DATE: d + ' 00:00:00',
      BONUS_PAY_DATE: d + ' 00:00:00',
      PLAN_EXPLAIN: '每1股派0.25美元股息',
    }), 'usAAPL', '.O', TODAY));
  });
  addPlan(ttmPlans, D.toPlan(row({
    EX_DIVIDEND_DATE: '2025-10-01 00:00:00',
    EQUITY_RECORD_DATE: '2025-10-01 00:00:00',
    BONUS_PAY_DATE: '2025-10-01 00:00:00',
    PLAN_EXPLAIN: '每1股派9.99美元股息',
  }), 'usAAPL', '.O', TODAY));
  const list = Object.keys(ttmPlans).map(function (k) { return ttmPlans[k]; });
  /* 独立复算：cutoff = 2026-11-09 − 365 天 = 2025-11-09；4 × 0.25 = 1.00 */
  close('独立复算 trailingPerShare = 4 × 0.25 = 1.00', C.trailingPerShare(list, TODAY), 1.00);
  const ab = C.annualBasePerShare(list, { type: 'years', value: 1 });
  eq('美股 basis = usTtm（没走财年）', ab.basis, 'usTtm');
  close('美股每股年分红 = 1.00（财年口径只会有 0.75）', ab.perShare, 1.00);
  const stTtm = mkState(ttmPlans);
  const hTtm = C.holdings(stTtm, 'acc_1').filter(function (x) { return x.symbol === 'usAAPL'; })[0];
  eq('持仓 annualBasis = usTtm', hTtm.annualBasis, 'usTtm');
  close('持仓预测年分红 = 10 股 × 1.00 = 10.00（USD 税前）', hTtm.predictedDividend, 10.00);

  /* ============ ④ 未来预案不计入预测，但进日历 ============ */
  section('【4】已公告未除息的未来方案：不进预测，照常进日历');
  const future = D.toPlan(row({
    EX_DIVIDEND_DATE: '2026-12-01 00:00:00',
    EQUITY_RECORD_DATE: '2026-12-02 00:00:00',
    BONUS_PAY_DATE: '2026-12-15 00:00:00',
  }), 'usAAPL', '.O', TODAY);
  eq('除息日 > 今天 → isImplemented = false（按除息日推断）', future.isImplemented, false);
  eq('未来方案 assignProgress = 公告预案', future.assignProgress, '公告预案');
  const withFuture = {};
  Object.keys(ttmPlans).forEach(function (k) { withFuture[k] = ttmPlans[k]; });
  withFuture[future.planId] = future;
  close('未来预案不计入近 12 个月年化（仍是 1.00）',
    C.trailingPerShare(Object.keys(withFuture).map(function (k) { return withFuture[k]; }), TODAY), 1.00);
  const evF = C.calendarEvents(mkState(withFuture), 'acc_1', null, null)
    .filter(function (e) { return e.type === 'payout' && e.date === '2026-12-15'; });
  eq('未来预案仍生成日历派息事件', evF.length, 1);
  eq('未来预案日历状态 = UPCOMING', evF[0].status, 'UPCOMING');
  eq('未来预案日历标「预案」', evF[0].isImplemented, false);

  /* ============ ⑤ 真实派息日进日历（不标「预计」） ============ */
  section('【5】BONUS_PAY_DATE 是真实派息日 → 白名单 + 日历');
  const p5 = planObj();
  eq('payoutInfo.exact = true（真实派息日白名单含 us）', C.payoutInfo(p5).exact, true);
  eq('payoutInfo.date = 真实派息日 2026-08-15', C.payoutInfo(p5).date, '2026-08-15');
  const st5 = mkState(addPlan({}, p5));
  const ev5 = C.calendarEvents(st5, 'acc_1', null, null)
    .filter(function (e) { return e.type === 'payout'; });
  eq('日历生成 1 个派息事件', ev5.length, 1);
  eq('日历派息日 = 2026-08-15（不是除息日 2026-08-08）', ev5[0].date, '2026-08-15');
  eq('日历不标「预计」', ev5[0].isEstimate, false);
  eq('日历文案 = 派息日', ev5[0].label, '派息日');
  close('日历金额 = 10 股 × 0.27 = 2.70（USD 税前）', ev5[0].amount, 2.70);

  /* ============ ⑥ 派息日已过自动到账 + 幂等 + 二级去重 ============ */
  section('【6】派息日已过自动到账（税前）、幂等键、二级去重');
  const st6 = mkState(addPlan({}, planObj()));
  const added1 = C.applyAutoReceived(st6);
  eq('首次登记新增 1 笔', added1, 1);
  eq('received 共 1 笔', st6.received.length, 1);
  eq('幂等键绑定 planId', st6.received[0].planId, planObj().planId);
  eq('到账日 = 真实派息日', st6.received[0].exDividendDate, '2026-08-15');
  /* 独立复算：10 股 × 0.27 美元/股 = 2.70 USD（税前，未计税） */
  close('到账金额 = 10 × 0.27 = 2.70（税前 USD）', st6.received[0].amount, 2.70);
  close('每股金额 = 0.27', st6.received[0].perShareAmount, 0.27);
  eq('到账来源 = AUTO', st6.received[0].source, 'AUTO');
  eq('二次执行新增 0 笔（planId + 账户幂等）', C.applyAutoReceived(st6), 0);
  eq('二次执行后仍只有 1 笔', st6.received.length, 1);

  const st6b = mkState(addPlan({}, planObj()));
  st6b.received.push({
    recId: 'rec_manual_1', accountId: 'acc_1', symbol: 'usAAPL', planId: null,
    exDividendDate: '2026-08-15', perShareAmount: 0.27, qtyAtRecord: 10,
    amount: 2.70, source: 'MANUAL', year: 2026, createdAt: '2026-08-16T00:00:00Z',
  });
  eq('手工补录同标的+同账户+同日+金额相符 → 自动登记被二级去重拦住',
    C.applyAutoReceived(st6b), 0);
  eq('二级去重后仍只有 1 笔，不重复计数', st6b.received.length, 1);

  /* ============ 展示层：按实时汇率折人民币 / 汇率缺失显示 USD ============ */
  section('【6b】单笔分红金额展示（底层仍存 USD 税前原币）');
  eq('汇率 = settings.fx.USD = 7.1', D.usdRate(st6), 7.1);
  eq('美股 2.70 USD × 7.1 = ¥19.17', D.moneyText(st6, 'usAAPL', 2.70), '¥19.17');
  eq('非美股沿用原展示（不折算）', D.moneyText(st6, 'sh600036', 2.70), '¥2.70');
  const stNoFx = mkState({}, {});
  eq('汇率缺失时 usdRate = null', D.usdRate(stNoFx), null);
  eq('汇率缺失时显示 USD 原币，绝不按 1 折算', D.moneyText(stNoFx, 'usAAPL', 2.70), '$2.70');
  eq('口径说明含「未计入境外预扣税」', D.rateNote(st6, 'usAAPL').indexOf('未计入境外预扣税') >= 0, true);

  /* ============ ⑦ 单只失败 / 整批失败不影响其它市场 ============ */
  section('【7】失败隔离（单只 / 三个后缀都空 / 整批失败）');
  D.clearSuffixCache();
  calls = [];
  D.useRequester(function (sec) {
    calls.push(sec);
    if (sec.indexOf('BAD') === 0) throw new Error('这只票接口挂了');
    if (sec === 'GOOD.O') return [row({ SECUCODE: 'GOOD.O', SECURITY_CODE: 'GOOD' })];
    return [];
  });
  const batch = await D.fetchAll(['usBAD', 'usGOOD']);
  eq('第一只整只失败，批量仍完成（不 reject）', !!batch, true);
  eq('第一只返回空方案，不编造', batch.plans.usBAD.length, 0);
  eq('第一只进 noData 列表（界面展示空态）', batch.noData.join(','), 'usBAD');
  eq('第二只照常拿到方案', batch.plans.usGOOD.length, 1);

  /* 整批失败：把美股组整体 mock 成 reject，验证 fetchDividends 不中断其它分组 */
  const realFetchAll = D.fetchAll;
  D.fetchAll = function () { return Promise.reject(new Error('美股整批失败')); };
  let res7;
  try { res7 = await XJ.fetcher.fetchDividends(['usAAPL', 'jp8058']); }
  catch (e) { res7 = { threw: String(e) }; }
  eq('美股整批失败 → fetchDividends 不 reject', !!(res7 && !res7.threw), true);
  eq('美股整批失败 → plans 为空对象', Object.keys(res7.plans || {}).length, 0);
  eq('其它市场分组不受影响：日股仍归入 unsupported', (res7.unsupported || []).join(','), 'jp8058');
  eq('美股不再被误列为「无分红源」', (res7.unsupported || []).indexOf('usAAPL') < 0, true);
  D.fetchAll = realFetchAll;
  D.useRequester(null);
  D.clearSuffixCache();

  /* ============ ⑧ 美股行情别名（伯克希尔 BRK 裸代码无数据） ============ */
  section('【8】美股行情别名：usBRK → usBRK.B（收盘价 / 市值 / 涨跌徽章）');
  eq('别名表 BRK → BRK.B', MK.US_QUOTE_ALIAS.BRK, 'BRK.B');
  eq('usQuoteCode(usBRK) = usBRK.B', MK.usQuoteCode('usBRK'), 'usBRK.B');
  eq('usQuoteCode(usAAPL) 保持裸代码', MK.usQuoteCode('usAAPL'), 'usAAPL');
  eq('非美股不受影响', MK.usQuoteCode('sh600023'), 'sh600023');
  eq('带点代码拆出容器 v_usBRK / 键 B', JSON.stringify(MK.quoteVarParts('usBRK.B')),
    JSON.stringify({ holder: 'v_usBRK', key: 'B' }));
  eq('普通代码无容器', MK.quoteVarParts('usAAPL'), null);

  /* 真链路：mock <script> 注入，验证别名 URL、容器预定义、同批其它标的互不干扰 */
  function fakeRaw(code, price, prev, chg, pct) {
    const f = new Array(52).fill('');
    f[1] = '测试名'; f[2] = code;
    f[3] = String(price); f[4] = String(prev); f[5] = String(price);
    f[30] = '20261109113758'; f[31] = String(chg); f[32] = String(pct);
    f[33] = String(price); f[34] = String(price); f[35] = 'USD';
    f[36] = '1000'; f[37] = '1000'; f[38] = '0.1'; f[39] = '15';
    f[44] = '100'; f[45] = '100';
    return f.join('~');
  }
  const win = sandbox.window;
  let lastSrc = '';
  let holderWasObject = false;
  sandbox.document = {
    createElement: function () {
      return { async: false, charset: '', src: '', onload: null, onerror: null, parentNode: null };
    },
    head: {
      appendChild: function (s) {
        lastSrc = s.src;
        const m = /q=([^&]*)/.exec(s.src);
        const codes = (m ? decodeURIComponent(m[1]) : '').split(',');
        codes.forEach(function (c) {
          const parts = MK.quoteVarParts(c);
          const isBrk = c.indexOf('BRK') >= 0;
          const raw = isBrk
            ? fakeRaw('BRK.B.N', 569.07, 570.89, -1.82, -0.32)
            : fakeRaw('AAPL.OQ', 349.82, 342.37, 7.45, 2.18);
          if (parts) {
            holderWasObject = !!win[parts.holder] && typeof win[parts.holder] === 'object';
            if (!win[parts.holder]) win[parts.holder] = {};
            win[parts.holder][parts.key] = raw;   // 对应腾讯 `v_usBRK.B="..."` 的属性赋值
          } else {
            win['v_' + c] = raw;
          }
        });
        setTimeout(function () { if (s.onload) s.onload(); }, 0);
      },
    },
  };
  const quotes = await XJ.fetcher.fetchQuotes(['usBRK', 'usAAPL']);
  eq('请求 URL 用别名 usBRK.B（不是无数据的 usBRK）',
    lastSrc.indexOf('usBRK.B') >= 0 && lastSrc.indexOf('usBRK,') < 0, true);
  eq('注入前已预定义 window.v_usBRK 容器（否则腾讯 script 抛 ReferenceError）', holderWasObject, true);
  eq('★ 伯克希尔拿到行情（原来的 usBRK 返回空）', !!quotes.usBRK, true);
  close('★ BRK 收盘价 = 569.07 USD', quotes.usBRK && quotes.usBRK.price, 569.07);
  close('★ BRK 涨跌幅 = -0.32%（涨跌徽章可渲染）', quotes.usBRK && quotes.usBRK.changePct, -0.32);
  eq('★ BRK 行情代码 = BRK.B.N（K 线可用）', quotes.usBRK && quotes.usBRK.code, 'BRK.B.N');
  eq('★ 同一批次 AAPL 不受带点代码影响', !!quotes.usAAPL, true);
  close('AAPL 收盘价 = 349.82', quotes.usAAPL && quotes.usAAPL.price, 349.82);
  delete sandbox.document;

  /* ============ ⑨ 实时汇率 / 按日汇率曲线 / 图标域名 / 股数格式 ============ */
  section('【9】实时汇率 · A股+美股三条曲线 · 图标域名 · 股数四位小数');
  eq('股数 1.944 → 1.944', U.qtyText(1.944), '1.944');
  eq('★ 浮点尾数 1.9440000000000002 → 1.944', U.qtyText(1.9440000000000002), '1.944');
  eq('1.94444 → 1.9444（最多四位）', U.qtyText(1.94444), '1.9444');
  eq('整数 1000 → 1,000', U.qtyText(1000), '1,000');
  eq('U.thousands 兜底浮点尾数', U.thousands(1.9440000000000002), '1.944');
  eq('★ BRK 官方域名兜底（东财查不到）', MK.usOfficialDomain('usBRK'), 'www.berkshirehathaway.com');
  eq('QQQ 官方域名兜底', MK.usOfficialDomain('usQQQ'), 'www.invesco.com');
  eq('SCHD 官方域名兜底', MK.usOfficialDomain('usSCHD'), 'www.schwab.com');
  eq('非美股不查域名表', MK.usOfficialDomain('sh600023'), null);
  eq('图标算法版本已升级（旧 bad 缓存失效）', XJ.fetcher.LOGO_ALGO, 3);
  const doms = await XJ.fetcher.fetchCompanyDomains(['usBRK', 'usQQQ']);
  eq('BRK 域名不用请求东财就能拿到', doms.usBRK, 'www.berkshirehathaway.com');
  eq('QQQ 域名不用请求东财就能拿到', doms.usQQQ, 'www.invesco.com');

  /* --- A股(CNY) + 美股(USD) 组合：按日汇率曲线 --- */
  const cs = XJ.model.defaultState();
  cs.accounts = [{ accountId: 'acc_1', name: '测试账户', type: 'BROKER', sortOrder: 1, createdAt: '2026-01-01T00:00:00Z' }];
  cs.symbols = {
    sh600023: { symbol: 'sh600023', code: '600023', market: 'sh', name: '浙能电力', type: 'STOCK', costMethod: 'weighted' },
    usAAPL: { symbol: 'usAAPL', code: 'AAPL', market: 'us', name: '苹果', type: 'STOCK', costMethod: 'weighted' },
  };
  cs.transactions = [
    { txId: 'c1', accountId: 'acc_1', symbol: 'sh600023', action: 'BUY', date: '2026-01-05', quantity: 1000, price: 4, fee: 0, createdAt: '2026-01-05T01:00:00Z' },
    { txId: 'c2', accountId: 'acc_1', symbol: 'usAAPL', action: 'BUY', date: '2026-01-05', quantity: 10, price: 200, fee: 0, createdAt: '2026-01-05T01:00:00Z' },
  ];
  cs.received = [];
  cs.quoteCache = {
    sh600023: { symbol: 'sh600023', name: '浙能电力', price: 5, prevClose: 5, changePct: 0 },
    usAAPL: { symbol: 'usAAPL', name: '苹果', price: 210, prevClose: 210, changePct: 0 },
  };
  XJ.model.ensureBootstrapped(cs);
  const days = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];
  const priceMap = {
    sh600023: days.map((d) => [d, 5]),
    usAAPL: days.map((d) => [d, 210]),
  };
  /* 独立复算：A股 1000×5 = 5000 CNY；美股 10×210 = 2100 USD
     mv   = 5000 + 2100×rate      → 7.0:19700  7.1:19910  7.5:20750
     net  = 1000×4 + 10×200×rate = 4000 + 2000×rate */
  function snapOf(rate) {
    return { mv: 5000 + 2100 * rate, cost: 4000 + 2000 * rate, pred: 0, recv: 0,
      net: 4000 + 2000 * rate, fx: { HKD: 0.9, USD: rate } };
  }
  cs.snapshots = { '2026-01-06': snapOf(7.0), '2026-01-07': snapOf(7.1) };
  cs.settings.fx = { HKD: 0.9, USD: 7.0, updatedAt: '2026-01-08T00:00:00.000Z' };

  /* 夹具把「今天」固定为 01-08（可注入，便于独立复算） */
  const sA = C.marketValueSeries(cs, 'acc_1', priceMap, { fx: { HKD: 0.9, USD: 7.0 }, today: '2026-01-08' }).series;
  const sB = C.marketValueSeries(cs, 'acc_1', priceMap, { fx: { HKD: 0.9, USD: 7.5 }, today: '2026-01-08' }).series;
  const at = (arr, d) => arr.filter((p) => p.date === d)[0];
  eq('曲线覆盖 4 个交易日', sA.length, 4);
  close('★ 无快照历史日（沿用首条快照汇率 7.0）mv = 19700', at(sA, '2026-01-05').mv, 19700, 1e-9);
  close('★ 实时汇率改 7.5，历史日仍 19700（不漂移）', at(sB, '2026-01-05').mv, 19700, 1e-9);
  close('★ 快照日 01-06 用当日汇率 7.0 → 19700', at(sA, '2026-01-06').mv, 19700, 1e-9);
  close('★ 快照日 01-07 用当日汇率 7.1 → 19910', at(sA, '2026-01-07').mv, 19910, 1e-9);
  close('★ 今天 01-08 用实时汇率 7.0 → 19700', at(sA, '2026-01-08').mv, 19700, 1e-9);
  close('★ 实时汇率改 7.5 → 今天 mv = 20750（实时生效）', at(sB, '2026-01-08').mv, 20750, 1e-9);
  sA.forEach(function (p) {
    close('恒等式 nw = mv + recv − net @' + p.date, p.nw, p.mv + p.recv - p.net, 1e-9);
  });
  eq('★ 01-06 flow = 0（无交易，汇率变化不算现金流）', at(sA, '2026-01-06').flow, 0);
  eq('★ 01-07 flow = 0', at(sA, '2026-01-07').flow, 0);
  eq('★ TWR 历史段不受实时汇率污染',
    JSON.stringify(C.twrIndex(sA).slice(0, 3).map((p) => p.idx)),
    JSON.stringify(C.twrIndex(sB).slice(0, 3).map((p) => p.idx)));
  const bs = C.buildSnapshot(cs, 'acc_1', { HKD: 0.9, USD: 7.1 });
  close('★ 快照 net = 4000 + 2000×7.1 = 18200', bs && bs.net, 18200, 1e-9);
  close('★ 快照 mv = 5000 + 2100×7.1 = 19910', bs && bs.mv, 19910, 1e-9);
  eq('★ 快照记录写入当日汇率（供历史曲线还原）', JSON.stringify(bs && bs.fx), JSON.stringify({ HKD: 0.9, USD: 7.1 }));

  /* ============ 【10】区间收益 + 统一重建曲线（2026-11-11 定稿） ============
     固定夹具：A股 1000 股 @5（净投入 5000）+ 美股 10 股 @200（净投入 2000 USD），
     USD=7.1 → 总净投入 19200 CNY；A股价恒 5.1，美股价按日期给。
       mv(d) = 1000×5.1 + 10×usPx×7.1 = 5100 + 71×usPx
       nw(d) = mv(d) − 19200
     日期 / 美股价 / 可手工复算的 nw：
       02-02 / 150 → 15750 → −3450      08-12 / 180 → 17880 → −1320
       11-02 / 200 → 19300 →   100      11-03 / 200 → 19300 →   100
       11-04 / 210 → 20010 →   810      11-05 / 210 → 20010 →   810
  */
  section('【10】区间收益 · 统一重建（A股 + 美股可独立复算）');
  function mkMix(o) {
    const s = XJ.model.defaultState();
    s.accounts = [{ accountId: 'acc_1', name: '混合账户', type: 'BROKER', sortOrder: 1, createdAt: '2025-01-01T00:00:00Z' }];
    s.symbols = {
      sh600023: { symbol: 'sh600023', code: '600023', market: 'sh', name: 'A股', type: 'STOCK', costMethod: 'weighted' },
      usAAPL: { symbol: 'usAAPL', code: 'AAPL', market: 'us', name: '苹果', type: 'STOCK', costMethod: 'weighted' },
    };
    s.transactions = [
      { txId: 'a1', accountId: 'acc_1', symbol: 'sh600023', action: 'BUY', date: '2025-01-06', quantity: 1000, price: 5, fee: 0, createdAt: '2025-01-06T01:00:00Z' },
      { txId: 'a2', accountId: 'acc_1', symbol: 'usAAPL', action: 'BUY', date: '2025-01-06', quantity: 10, price: 200, fee: 0, createdAt: '2025-01-06T01:00:00Z' },
    ];
    s.received = []; s.plans = {};
    XJ.model.ensureBootstrapped(s);
    s.settings.fx = { HKD: 0.92, USD: 7.1 };
    s.snapshots = (o && o.snapshots) || {};
    s.quoteCache = (o && o.quoteCache) || {};
    return s;
  }
  const MIX_DAYS = ['2026-02-02', '2026-08-12', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'];
  const MIX_US = [150, 180, 200, 200, 210, 210];
  const mixPm = {
    sh600023: MIX_DAYS.map((d) => [d, 5.1]),
    usAAPL: MIX_DAYS.map((d, i) => [d, MIX_US[i]]),
  };
  const mixFx = { HKD: 0.92, USD: 7.1 };
  const mix = mkMix();
  const atMix = (arr, d) => arr.filter((p) => p.date === d)[0];
  const allMix = C.marketValueSeries(mix, 'acc_1', mixPm, { fx: mixFx }).series;
  eq('夹具 · 6 个日期点', allMix.length, 6);
  close('夹具 · 02-02 nw = 15750 − 19200', atMix(allMix, '2026-02-02').nw, -3450, 1e-9);
  close('夹具 · 11-02 nw = 19300 − 19200', atMix(allMix, '2026-11-02').nw, 100, 1e-9);
  close('夹具 · 11-04 nw = 20010 − 19200', atMix(allMix, '2026-11-04').nw, 810, 1e-9);

  /* ① 不同区间给出不同数字 —— 这正是「本月收益 / 三个月收益」要的东西 */
  const gains = {};
  ['1m', '3m', 'ytd', 'all'].forEach(function (r) {
    const cr = C.chartRange(r, '2026-11-09', '', '');
    const sr = C.downsample(C.marketValueSeries(mix, 'acc_1', mixPm, {
      beg: cr.beg, end: cr.end, fx: mixFx,
    }).series, 'day');
    gains[r] = C.rangeReturn(sr);
  });
  eq('★ 本月区间收益 = 810 − 100', gains['1m'].gain, 710);
  eq('★ 近三月区间收益 = 810 − (−1320)', gains['3m'].gain, 2130);
  eq('★ 今年区间收益 = 810 − (−3450)', gains['ytd'].gain, 4260);
  eq('全部区间收益 = 今年（首点相同）', gains['all'].gain, 4260);
  eq('★ 本月 / 近三月 / 今年三个数字互不相同',
    gains['1m'].gain !== gains['3m'].gain && gains['3m'].gain !== gains['ytd'].gain &&
    gains['1m'].gain !== gains['ytd'].gain, true);
  eq('本月期初总资产 = 19300（mv 19300 + recv 0）', gains['1m'].base, 19300);
  close('★ 本月区间收益率 = 710 ÷ 19300', gains['1m'].pct, 710 / 19300 * 100, 1e-9);
  eq('建仓以来累计总收益 = 810（副信息）', gains['1m'].cumGain, 810);
  eq('所有区间曲线首点归零',
    ['1m', '3m', 'ytd', 'all'].every((k) => gains[k].points[0].gain === 0), true);
  eq('所有区间曲线末点 == 大数字',
    ['1m', '3m', 'ytd', 'all'].every((k) => gains[k].points[gains[k].points.length - 1].gain === gains[k].gain), true);

  /* ② 反证旧口径：seriesDelta(nw) 拿「期初累计收益」当分母会给出假数字 */
  const mid = C.marketValueSeries(mix, 'acc_1', mixPm, {
    beg: '2026-11-03', end: '2026-11-04', fx: mixFx,
  }).series;
  close('反证 · 旧口径 710 ÷ 100 = +710%', C.seriesDelta(mid, 'nw').pct, 710, 1e-9);
  close('新口径 · 710 ÷ 19300 ≈ +3.68%', C.rangeReturn(mid).pct, 710 / 19300 * 100, 1e-9);
  eq('★ 旧口径比真实收益率放大 100 倍以上',
    C.seriesDelta(mid, 'nw').pct / C.rangeReturn(mid).pct > 100, true);

  /* ③ 清仓标的：已实现盈亏与已收分红必须留在累计收益里，不能凭空消失 */
  const sold = mkMix();
  sold.transactions.push({ txId: 'a3', accountId: 'acc_1', symbol: 'usAAPL', action: 'SELL',
    date: '2026-11-04', quantity: 10, price: 260, fee: 0, createdAt: '2026-11-04T01:00:00Z' });
  sold.received.push({ recId: 'r1', accountId: 'acc_1', symbol: 'usAAPL', exDividendDate: '2026-08-15',
    amount: 2.7, perShareAmount: 0.27, qtyAtRecord: 10, source: 'us', createdAt: '2026-08-15T01:00:00Z' });
  const so = C.marketValueSeries(sold, 'acc_1', mixPm, { beg: '2026-11-01', end: '2026-11-09', fx: mixFx }).series;
  close('清仓前 · 累计已收分红 2.7 × 7.1 = 19.17', atMix(so, '2026-11-03').recv, 19.17, 1e-9);
  close('清仓后 · 已收分红仍保留（旧口径会归零）', atMix(so, '2026-11-04').recv, 19.17, 1e-9);
  close('清仓后 · 市值只剩 A股 1000×5.1', atMix(so, '2026-11-04').mv, 5100, 1e-9);
  close('清仓后 · 净投入 = 5000 + (2000−2600)×7.1 = 740', atMix(so, '2026-11-04').net, 740, 1e-9);
  close('★ 清仓后累计收益 = 5100 + 19.17 − 740（已实现 4260 + 分红 19.17 + A股浮盈 100）',
    atMix(so, '2026-11-04').nw, 4379.17, 1e-9);

  /* ④ 完全没有日线的标的：按现价补常量，曲线不再整块消失 / 锯齿 */
  const noUs = mkMix({ quoteCache: { usAAPL: { symbol: 'usAAPL', price: 210, prevClose: 210 } } });
  const pm2 = { sh600023: mixPm.sh600023 };
  const nu = C.marketValueSeries(noUs, 'acc_1', pm2, { fx: mixFx });
  eq('缺日线 · usAAPL 如实进 missing', nu.missing.join(','), 'usAAPL');
  close('缺日线 · 按现价 210 补市值 = 5100 + 10×210×7.1', nu.series[0].mv, 20010, 1e-9);
  const jumps = nu.series.slice(1).map((p, i) => Math.abs(p.nw - nu.series[i].nw));
  eq('★ 缺日线标的补常量后曲线零跳变', Math.max.apply(null, jumps), 0);

  /* ⑤ 快照不再覆盖数值：有/无快照的 nw 序列逐日一致 */
  const withSnap = mkMix({ snapshots: {
    '2026-11-04': { mv: 99999, cost: 1, pred: 0, recv: 0, net: 1, fx: { HKD: 0.92, USD: 7.1 } },
  } });
  const ws = C.marketValueSeries(withSnap, 'acc_1', mixPm, { beg: '2026-11-01', end: '2026-11-09', fx: mixFx }).series;
  const plain = C.marketValueSeries(mkMix(), 'acc_1', mixPm, { beg: '2026-11-01', end: '2026-11-09', fx: mixFx }).series;
  eq('★ 有/无快照的 nw 序列完全一致', ws.map((p) => p.nw).join(','), plain.map((p) => p.nw).join(','));
  close('快照日 mv 不被 99999 覆盖（仍按日线 20010）', atMix(ws, '2026-11-04').mv, 20010, 1e-9);
  eq('快照日仍标 source=snapshot（仅表示当日有快照）', atMix(ws, '2026-11-04').source, 'snapshot');

  /* ---------------- 汇总 ---------------- */
  console.log('\n============================================');
  console.log('test-usdiv: ' + pass + ' passed, ' + fail + ' failed');
  console.log('============================================');
  if (fail) process.exit(1);
}

main().catch(function (e) {
  console.error('test-usdiv 异常：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
