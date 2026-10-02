/* 独立验证「股息率曲线」的纯函数：
 *   calc.yieldFiscalSteps    —— 按财年汇总派现分子 + 定生效日
 *   calc.dividendYieldSeries —— 逐日股息率序列
 *   calc.yieldYearAverages   —— 分财年平均股息率（统计口径：样本数 / 门槛 / 均值）
 *   calc.yieldAverageSeries  —— 平均股息率线（year 整年窗口 ⇄ cum 自切换日累积）
 *   calc.exDividendDates     —— 除权除息日散点
 *   fetcher.parseSevenDay    —— 余额宝七日年化的解析（时间戳→日期、按周降采样、裁年数）
 *
 * 与 test-alignminute.mjs 同样的做法：在 Node 的 vm 沙箱里直接加载浏览器端的源文件，
 * 只注入最小依赖，因此这里跑的就是页面上跑的那份代码，不是复写品。
 *
 * 用法： node tools/test-yieldcurve.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ---------------- 沙箱：util → market → calc / fetcher ---------------- */
const sandbox = {
  window: {},
  console,
  Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Date,
  parseInt, parseFloat, isNaN, isFinite, Promise, setTimeout, clearTimeout,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['src/util.js', 'src/market.js', 'src/model.js', 'src/fetcher.js', 'src/calc.js']) {
  vm.runInContext(read(f), sandbox, { filename: f });
}
const XJ = sandbox.window.XJ;
const C = XJ.calc;
const F = XJ.fetcher;

let pass = 0, fail = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + '\n      got  ' + g + '\n      want ' + w); }
}
function near(label, got, want, tol) {
  if (Math.abs(got - want) <= (tol || 1e-9)) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + '  got ' + got + ' want ' + want); }
}

/** 造一条分红方案（默认已实施、税前每10股 X 元） */
function plan(symbol, reportDate, per10, opts) {
  opts = opts || {};
  return {
    planId: symbol + '_' + reportDate + (opts.tag || ''),
    symbol: symbol,
    reportDate: reportDate,
    reportType: String(reportDate).slice(5, 7) === '12' ? '年报' : '中报',
    pretaxBonusPer10: per10,
    afterTaxPer10: null,
    implPlanProfile: '10派' + per10 + '元(含税)',
    planNoticeDate: opts.notice === undefined ? null : opts.notice,
    noticeDate: opts.noticeDate || null,
    equityRecordDate: opts.equity || null,
    exDividendDate: opts.ex || null,
    assignProgress: opts.impl === false ? '董事会预案' : '实施分配',
    progressRank: opts.impl === false ? 60 : 100,
    isImplemented: opts.impl !== false,
    source: opts.source || undefined,
  };
}

const SYM = 'sh600036';

/* ================================================================
 * 1) yieldFiscalSteps —— 财年分子与生效日
 * ================================================================ */
console.log('\n--- 1) yieldFiscalSteps：按财年汇总 + 生效日 ---');
{
  const plans = [
    /* FY2024：中报 10派5 + 年报 10派20 → 每股 0.5 + 2.0 = 2.5 */
    plan(SYM, '2024-06-30', 5, { notice: '2024-08-20', ex: '2024-09-10' }),
    plan(SYM, '2024-12-31', 20, { notice: '2025-04-30', ex: '2025-07-09' }),
    /* FY2025：年报 10派22 → 每股 2.2 */
    plan(SYM, '2025-12-31', 22, { notice: '2026-04-30', ex: '2026-07-17' }),
  ];
  const steps = C.yieldFiscalSteps(plans);
  eq('两个财年都入选', steps.map(s => s.year), [2024, 2025]);
  eq('按 year 升序', steps[0].year < steps[1].year, true);
  near('FY2024 分子含中报+年报（每股 2.5）', steps[0].perShare, 2.5, 1e-12);
  near('FY2025 分子 = 2.2', steps[1].perShare, 2.2, 1e-12);
  eq('★ 生效日取【年报】的预案公告日，不是中报的', steps[0].effectiveFrom, '2025-04-30');
  eq('FY2025 生效日 = 2026-04-30', steps[1].effectiveFrom, '2026-04-30');
  eq('年报方案条数', steps.map(s => s.annualPlans), [1, 1]);
}

console.log('\n--- 2) 只有中报的财年不入选（「上一年财报」指年报） ---');
{
  const steps = C.yieldFiscalSteps([
    plan(SYM, '2024-06-30', 5, { notice: '2024-08-20' }),     // 只有中报
    plan(SYM, '2025-12-31', 20, { notice: '2026-04-30' }),    // 有年报
  ]);
  eq('只留下 FY2025', steps.map(s => s.year), [2025]);
}

console.log('\n--- 3) 生效日的退化链：planNoticeDate → noticeDate → equityRecordDate → exDividendDate ---');
{
  const a = C.yieldFiscalSteps([plan(SYM, '2024-12-31', 20, { notice: null, noticeDate: '2025-04-30' })]);
  eq('缺 planNoticeDate → 用 noticeDate', a[0].effectiveFrom, '2025-04-30');

  const b = C.yieldFiscalSteps([plan(SYM, '2024-12-31', 20, { notice: null, noticeDate: null, equity: '2025-07-08' })]);
  eq('再缺 → 用股权登记日', b[0].effectiveFrom, '2025-07-08');

  const c = C.yieldFiscalSteps([plan(SYM, '2024-12-31', 20, { notice: null, noticeDate: null, equity: null, ex: '2025-07-09' })]);
  eq('再缺 → 用除权除息日', c[0].effectiveFrom, '2025-07-09');

  const d = C.yieldFiscalSteps([plan(SYM, '2024-12-31', 20, {})]);
  eq('★ 四个日期全缺 → 该财年不入选（无法定生效时点）', d, []);
}

console.log('\n--- 4) ★ 含预案：未实施的方案也要计入（与「公告日生效」自洽） ---');
{
  const steps = C.yieldFiscalSteps([
    plan(SYM, '2024-12-31', 20, { notice: '2025-04-30', impl: true }),
    plan(SYM, '2025-12-31', 22, { notice: '2026-04-30', impl: false }),   // 已公告、尚未实施
  ]);
  eq('FY2025 的预案照样入选', steps.map(s => s.year), [2024, 2025]);
  near('分子用的是预案金额 2.2', steps[1].perShare, 2.2, 1e-12);
  eq('生效日就是预案公告日', steps[1].effectiveFrom, '2026-04-30');

  /* 反证：若过滤掉未实施，FY2025 整个消失 —— 这正是不能用 isImplemented 过滤的原因 */
  const implOnly = C.yieldFiscalSteps([
    plan(SYM, '2025-12-31', 22, { notice: '2026-04-30', impl: false }),
  ]);
  eq('★ 只有预案、没有已实施方案 → 仍能出一个财年（若过滤 isImplemented 这里会是空）',
    implOnly.map(s => s.year), [2025]);
}

console.log('\n--- 5) 该财年一分钱没派 → 不入选 ---');
{
  const steps = C.yieldFiscalSteps([
    plan(SYM, '2024-12-31', 0, { notice: '2025-04-30' }),
    plan(SYM, '2025-12-31', 20, { notice: '2026-04-30' }),
  ]);
  eq('零派现的财年被剔除（0% 息率没有意义）', steps.map(s => s.year), [2025]);
}

console.log('\n--- 6) 同年多条年报方案 → 生效日取最早那条 ---');
{
  const steps = C.yieldFiscalSteps([
    plan(SYM, '2024-12-31', 10, { notice: '2025-05-20', tag: 'a' }),
    plan(SYM, '2024-12-31', 10, { notice: '2025-04-30', tag: 'b' }),
  ]);
  eq('取最早的公告日', steps[0].effectiveFrom, '2025-04-30');
  near('同年两条都累加进分子', steps[0].perShare, 2.0, 1e-12);
}

console.log('\n--- 7) 空输入不炸 ---');
{
  eq('空数组 → 空', C.yieldFiscalSteps([]), []);
  eq('null → 空', C.yieldFiscalSteps(null), []);
  eq('含 null 元素 → 跳过', C.yieldFiscalSteps([null, plan(SYM, '2025-12-31', 20, { notice: '2026-04-30' })]).length, 1);
}

/* ================================================================
 * 8) dividendYieldSeries —— 逐日股息率
 * ================================================================ */
console.log('\n--- 8) dividendYieldSeries：切换点、分子、百分比 ---');
{
  const plans = [
    plan(SYM, '2024-12-31', 20, { notice: '2025-04-30' }),   // 每股 2.0，2025-04-30 生效
    plan(SYM, '2025-12-31', 22, { notice: '2026-04-30' }),   // 每股 2.2，2026-04-30 生效
  ];
  const closes = [
    ['2025-01-10', 50],
    ['2025-04-29', 40],
    ['2025-04-30', 40],
    ['2026-04-29', 40],
    ['2026-04-30', 40],
    ['2026-09-01', 55],
  ];
  const s = C.dividendYieldSeries(plans, closes);
  eq('★ 生效日之前的点不产出（前两条被丢掉）',
    s.map(p => p.date), ['2025-04-30', '2026-04-29', '2026-04-30', '2026-09-01']);
  eq('★ 生效日【当天】就生效（用的是 <=）', s[0].year, 2024);
  near('2.0 ÷ 40 × 100 = 5%', s[0].y, 5, 1e-12);
  eq('切换前一天仍属 FY2024', s[1].year, 2024);
  eq('★ 切换当天即为 FY2025', s[2].year, 2025);
  near('★ 同一价格 40 下，分子换成了 2.2 → 5.5%', s[2].y, 5.5, 1e-12);
  near('2.2 ÷ 55 × 100 = 4%', s[3].y, 4, 1e-12);
}

console.log('\n--- 9) 与现有「股价息率」的口径关系（差异只在预案） ---');
{
  const plans = [
    plan(SYM, '2024-12-31', 20, { notice: '2025-04-30' }),
    plan(SYM, '2025-12-31', 22, { notice: '2026-04-30' }),
  ];
  const closes = [['2026-09-01', 40]];
  const s = C.dividendYieldSeries(plans, closes);
  const annual = C.annualBasePerShare(plans, { type: 'years', value: 1 });
  near('★ 全部已实施时，末点 = 现有 annualBasePerShare 口径',
    s[0].y, annual.perShare / 40 * 100, 1e-12);

  /* 加了未实施预案后，曲线末点会高于「股价息率」（后者只算已实施） */
  const plans2 = plans.concat([plan(SYM, '2026-12-31', 30, { notice: '2027-04-30', impl: false })]);
  const s2 = C.dividendYieldSeries(plans2, [['2027-05-01', 40]]);
  const annual2 = C.annualBasePerShare(plans2, { type: 'years', value: 1 });
  eq('★ 有未实施预案时，曲线末点高于只算已实施的股价息率',
    s2.length > 0 && s2[s2.length - 1].y / 100 * 40 > annual2.perShare, true);
}

console.log('\n--- 10) 边界：空输入 / 脏价格 / 无效日期 ---');
{
  const plans = [plan(SYM, '2024-12-31', 20, { notice: '2025-04-30' })];
  eq('无方案 → 空', C.dividendYieldSeries([], [['2025-05-01', 40]]), []);
  eq('无价格 → 空', C.dividendYieldSeries(plans, []), []);
  eq('null 价格序列 → 空', C.dividendYieldSeries(plans, null), []);
  eq('价格为 0 的行被跳过', C.dividendYieldSeries(plans, [['2025-05-01', 0], ['2025-05-02', 40]]).length, 1);
  eq('负价格被跳过', C.dividendYieldSeries(plans, [['2025-05-01', -1]]), []);
  eq('非数字价格被跳过', C.dividendYieldSeries(plans, [['2025-05-01', 'x']]), []);
  eq('长度不足的行被跳过', C.dividendYieldSeries(plans, [['2025-05-01']]), []);
  eq('所有点都在生效日之前 → 空', C.dividendYieldSeries(plans, [['2025-01-01', 40]]), []);
  /* 一个财年都没生效时，不该产出任何点（曲线自然从第一个财年生效日开始） */
  eq('无任何财年 → 空', C.dividendYieldSeries([plan(SYM, '2024-12-31', 20, {})], [['2025-05-01', 40]]), []);
}

/* ================================================================
 * 11) exDividendDates
 * ================================================================ */
console.log('\n--- 11) exDividendDates：去重 + 升序 + 过滤脏值 ---');
{
  const plans = [
    plan(SYM, '2024-12-31', 20, { ex: '2025-07-09' }),
    plan(SYM, '2024-06-30', 5, { ex: '2024-09-10' }),
    plan(SYM, '2024-12-31', 20, { ex: '2025-07-09', tag: 'dup' }),   // 重复
    plan(SYM, '2023-12-31', 10, { ex: null }),                       // 缺
    plan(SYM, '2022-12-31', 10, { ex: 'not-a-date' }),               // 脏
  ];
  eq('去重 + 升序', C.exDividendDates(plans), ['2024-09-10', '2025-07-09']);
  eq('空输入 → 空', C.exDividendDates([]), []);
  eq('null → 空', C.exDividendDates(null), []);
}

/* ================================================================
 * 12) parseSevenDay —— 余额宝七日年化
 * ================================================================ */
console.log('\n--- 12) parseSevenDay：时间戳→日期、按周取最后一点、裁年数 ---');
{
  const ms = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0).getTime();
  /* 2026-08-31 是周一，2026-09-04 是周五 → 同一 ISO 周（周一起算） */
  const raw = [
    [ms(2026, 8, 31), 1.20],   // 周一
    [ms(2026, 9, 2), 1.30],    // 周三
    [ms(2026, 9, 4), 1.40],    // 周五 ← 该周应留这个
    [ms(2026, 9, 7), 1.50],    // 下周一（新的一周）
    [ms(2026, 9, 9), 1.60],
  ];
  const pts = F.parseSevenDay(raw);
  eq('两周 → 两个点', pts.length, 2);
  eq('★ 每周取最后一个点', pts.map(p => p[1]), [1.40, 1.60]);
  eq('日期升序且格式为 YYYY-MM-DD', pts.map(p => p[0]), ['2026-09-04', '2026-09-09']);

  /* 乱序输入也要按日期取该周最大那天 */
  const shuffled = [
    [ms(2026, 9, 4), 1.40],
    [ms(2026, 8, 31), 1.20],
    [ms(2026, 9, 2), 1.30],
  ];
  eq('乱序输入仍取该周最后一天', F.parseSevenDay(shuffled).map(p => p[1]), [1.40]);

  /* 脏数据 */
  eq('零点被跳过（七日年化不可能 ≤ 0）',
    F.parseSevenDay([[ms(2026, 9, 1), 0], [ms(2026, 9, 2), 1.5]]).length, 1);
  eq('非数字被跳过', F.parseSevenDay([[ms(2026, 9, 1), 'x'], [ms(2026, 9, 2), 1.5]]).length, 1);
  eq('非法时间戳被跳过', F.parseSevenDay([[null, 1.5]]).length, 0);
  eq('长度不足的行被跳过', F.parseSevenDay([[ms(2026, 9, 1)]]).length, 0);
  eq('空输入 → 空', F.parseSevenDay([]), []);
  eq('null → 空', F.parseSevenDay(null), []);

  /* 裁年数：给 20 年数据，只要近 10 年 */
  const long = [];
  for (let y = 2010; y <= 2026; y++) for (let m = 1; m <= 12; m++) long.push([ms(y, m, 15), 1.0 + m / 100]);
  const cut = F.parseSevenDay(long, { years: 10, today: '2026-09-17' });
  eq('★ 裁到最近 10 年（2010~2026 裁完只剩 2016 之后）',
    cut.length > 0 && cut[0][0] >= '2016-09-18', true);
  eq('裁完后仍按日期升序', cut.every((p, i) => i === 0 || cut[i - 1][0] <= p[0]), true);
  eq('不传 years 则不裁', F.parseSevenDay(long).length > cut.length, true);
}

/* ================================================================
 * 13) 模型层：normCloseSeries 归一化
 * ================================================================ */
console.log('\n--- 13) model.normCloseSeries：清洗 + 升序 + 去重 ---');
{
  const M = XJ.model;
  const got = M.normCloseSeries([
    ['2026-09-02', '10.5'],
    ['2026-09-01', 10],
    ['bad-date', 9],
    ['2026-09-03', 0],
    ['2026-09-04', -1],
    ['2026-09-05', null],
    ['2026-09-02', 11],          // 与第一条同日 → 后者覆盖
    ['2026-09-06'],
  ]);
  eq('清洗后升序', got.map(r => r[0]), ['2026-09-01', '2026-09-02']);
  eq('字符串数字被转成数值', got[0][1], 10);
  eq('同日后出现者覆盖前者', got[1][1], 11);
  eq('非数组 → 空', M.normCloseSeries(null), []);
  eq('字符串 → 空', M.normCloseSeries('x'), []);
}

/* ================================================================
 * 14) yieldYearAverages / yieldAverageSeries —— 分财年平均股息率线
 * ================================================================ */

/** 生成 [beg, end] 的逐日日期串（含周末，纯函数不关心交易日） */
function dayList(beg, end) {
  const out = [];
  const d = new Date(beg + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
  while (d <= last) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
const flat = (dates, price) => dates.map((d) => [d, price]);

console.log('\n--- 14) yieldYearAverages：分财年切段 / 起点 / 门槛 ---');
{
  const plans = [
    plan(SYM, '2020-12-31', 10, { notice: '2021-05-01' }),   // FY2020 每股 1.0，2021-05-01 生效
    plan(SYM, '2021-12-31', 8, { notice: '2022-03-01' }),    // FY2021 每股 0.8
    plan(SYM, '2022-12-31', 12, { notice: '2023-03-01' }),   // FY2022 每股 1.2
  ];
  const closes = flat(dayList('2021-06-01', '2023-08-31'), 40);
  const g = C.yieldYearAverages(plans, closes);
  eq('切出三个财年段、按财年升序', g.map((x) => x.year), [2020, 2021, 2022]);
  eq('★ 样本起点被裁到 2022-01-01（2021 年的收盘价一并不计）', g[0].from, '2022-01-01');
  eq('FY2020 段末 = 下一切换前一天', g[0].to, '2022-02-28');
  eq('FY2021 段从切换当天起', g[1].from, '2022-03-01');
  eq('FY2020 样本只剩 1~2 月共 59 天', g[0].days, 59);
  eq('★ 59 天 < 120 → ok=false（该财年段不画）', g[0].ok, false);
  eq('★ 完整的财年段 ok=true', g.slice(1).map((x) => x.ok), [true, true]);
  near('FY2020 均值 = 1.0 ÷ 40 = 2.5%', g[0].avg, 2.5, 1e-9);
  near('FY2021 均值 = 0.8 ÷ 40 = 2%', g[1].avg, 2, 1e-9);
  eq('带上该财年的每股派现（供界面读文案）', g.map((x) => x.perShare), [1, 0.8, 1.2]);
}

console.log('\n--- 15) yieldAverageSeries：两种口径的差别 ---');
{
  const plans = [plan(SYM, '2022-12-31', 10, { notice: '2023-01-10' })];   // 每股 1.0
  const closes = [
    ['2023-01-10', 30],   // 1.0 ÷ 30 = 3.3333%
    ['2023-01-11', 60],   // 1.0 ÷ 60 = 1.6667%
    ['2023-01-12', 30],   // 3.3333%
  ];
  const year = C.yieldAverageSeries(plans, closes, 'year');
  const cum = C.yieldAverageSeries(plans, closes, 'cum');

  eq('★ 整年窗口口径：样本只有 3 天 → 整段不画', year, []);
  eq('★ 累积口径不设门槛 → 照画', cum.length, 3);
  eq('累积口径逐日累积：(3.3333) / (3.3333+1.6667)/2 / 三天均值',
    cum.map((p) => +p.y.toFixed(4)), [3.3333, 2.5, 2.7778]);

  /* 给足样本后天数达标，整年口径才是「同一财年一个常数」 */
  const many = flat(dayList('2023-01-10', '2023-06-30'), 40);
  const y2 = C.yieldAverageSeries(plans, many, 'year');
  const c2 = C.yieldAverageSeries(plans, many, 'cum');
  eq('整年口径：全段都是同一个数（阶梯）', new Set(y2.map((p) => p.y)).size, 1);
  near('且等于该财年均值 2.5%', y2[0].y, 2.5, 1e-9);
  eq('累积口径：首点等于当天股息率（尚无历史可平均）', +c2[0].y.toFixed(4), 2.5);
  eq('★ 价格不动时两种口径最终重合', +c2[c2.length - 1].y.toFixed(6), +y2[0].y.toFixed(6));
}

console.log('\n--- 16) ★ 均线与曲线同源：日期、财年归属必须逐点对齐 ---');
{
  const plans = [
    plan(SYM, '2020-12-31', 10, { notice: '2021-05-01' }),
    plan(SYM, '2021-12-31', 12, { notice: '2022-03-01' }),
    plan(SYM, '2022-12-31', 14, { notice: '2023-03-01' }),
  ];
  const closes = flat(dayList('2021-06-01', '2024-06-30'), 40);
  const all = C.dividendYieldSeries(plans, closes);
  const byDate = {};
  all.forEach((p) => { byDate[p.date] = p; });

  const okYear = C.yieldAverageSeries(plans, closes, 'year');
  const okCum = C.yieldAverageSeries(plans, closes, 'cum');
  for (const [label, ser] of [['整年', okYear], ['累积', okCum]]) {
    eq(label + '口径：每个均线点的日期都在曲线上，且财年归属一致',
      ser.every((p) => byDate[p.date] && byDate[p.date].year === p.year), true);
    eq(label + '口径：日期升序无重复',
      ser.every((p, i) => i === 0 || ser[i - 1].date < p.date), true);
    eq(label + '口径：末点与曲线末点同日',
      ser[ser.length - 1].date, all[all.length - 1].date);
  }
  eq('整年口径：被门槛挡掉的财年在结果里完全不出现',
    okYear.some((p) => p.year === 2020), false);
  eq('累积口径：同一段照样出现（无门槛）',
    okCum.some((p) => p.year === 2020), true);
}

console.log('\n--- 17) 平均线的边界：空输入 / 无效参数不炸 ---');
{
  eq('无方案 → 空', C.yieldYearAverages([], [['2022-06-01', 40]]), []);
  eq('无价格 → 空', C.yieldYearAverages([plan(SYM, '2021-12-31', 10, { notice: '2022-03-01' })], []), []);
  eq('null → 空', C.yieldYearAverages(null, null), []);
  eq('序列：无数据 → 空', C.yieldAverageSeries(null, null, 'year'), []);
  eq('★ 未知 mode 退回整年口径（不是累积）',
    C.yieldAverageSeries([plan(SYM, '2021-12-31', 10, { notice: '2022-03-01' })], [['2022-06-01', 40]], 'xxx').length, 0);
  eq('日期在 2022-01-01 之前 → 一律不产出',
    C.yieldAverageSeries([plan(SYM, '2020-12-31', 10, { notice: '2020-05-01' })], [['2021-06-01', 40]], 'cum'), []);
}

console.log('\n' + '='.repeat(48));
console.log('股息率曲线独立验证：' + pass + ' 通过 / ' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;
