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
