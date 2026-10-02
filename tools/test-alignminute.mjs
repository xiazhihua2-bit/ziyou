/* 独立验证 alignMinute：三种边界
   1) 多标的分时点数不一致
   2) 午休缺口（一个含 11:30 收盘点、一个不含）
   3) 某标的某刻缺数据 → 必须前值填充，不得产生 -100%
*/
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync('src/calc.js', 'utf8');

/* calc.js 第 8 行是裸 `XJ.calc = ...`，需要全局 XJ 已存在 ——
   verify.mjs 能跑通是因为先加载了 util.js（由它创建 XJ）。
   这里直接注入最小 XJ.util，再加载 calc.js。 */
const sandbox = {
  window: {},
  console,
  Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
  parseInt, parseFloat, isNaN, Promise, setTimeout, clearTimeout,
};
sandbox.globalThis = sandbox;
sandbox.Date = Date;
vm.createContext(sandbox);

/* util.js 的关键部分：只取 alignMinute 用到的 num */
vm.runInContext(`
  var XJ = {};
  XJ.util = {
    num: function (v) {
      if (v === null || v === undefined || v === '') return null;
      var n = parseFloat(String(v).replace(/,/g, ''));
      return isNaN(n) ? null : n;
    },
  };
  this.XJ = XJ;
  globalThis.XJ = XJ;
`, sandbox, { filename: 'stub-util.js' });

vm.runInContext(src, sandbox, { filename: 'src/calc.js' });
const C = sandbox.XJ.calc;

let pass = 0, fail = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + '\n      got  ' + g + '\n      want ' + w); }
}

console.log('\n--- 1) 点数不一致：A 有 5 点、B 只有 3 点 ---');
{
  const H = [{ symbol: 'A', qty: 10, currency: 'CNY' }, { symbol: 'B', qty: 20, currency: 'CNY' }];
  const M = {
    A: { points: [{ t: '09:30', p: 10 }, { t: '09:31', p: 11 }, { t: '09:32', p: 12 }, { t: '09:33', p: 13 }, { t: '09:34', p: 14 }] },
    B: { points: [{ t: '09:30', p: 5 }, { t: '09:31', p: 6 }, { t: '09:32', p: 7 }] },
  };
  const r = C.alignMinute(H, M);
  eq('时间轴 = A 的 5 个时刻（并集）', r.points.map(p => p.t), ['09:30', '09:31', '09:32', '09:33', '09:34']);
  eq('09:30 = 10*10 + 20*5 = 200', r.points[0].mv, 200);
  eq('09:32 = 10*12 + 20*7 = 260', r.points[2].mv, 260);
  eq('09:33 B 前值填充 → 10*13 + 20*7 = 270', r.points[3].mv, 270);
  eq('09:34 B 前值填充 → 10*14 + 20*7 = 280', r.points[4].mv, 280);
  eq('09:33 有 1 只被填充', r.points[3].filled, 1);
  eq('无 missing', r.missing, []);
}

console.log('\n--- 2) 午休缺口：A 含 11:30、B 不含，直接跳 13:00 ---');
{
  const H = [{ symbol: 'A', qty: 100, currency: 'CNY' }, { symbol: 'B', qty: 100, currency: 'CNY' }];
  const M = {
    A: { points: [{ t: '11:29', p: 10 }, { t: '11:30', p: 10.5 }, { t: '13:00', p: 11 }] },
    B: { points: [{ t: '11:29', p: 20 }, /* 无 11:30 */ { t: '13:00', p: 21 }] },
  };
  const r = C.alignMinute(H, M);
  eq('时间轴 = 11:29 / 11:30 / 13:00', r.points.map(p => p.t), ['11:29', '11:30', '13:00']);
  eq('11:30 B 用 11:29 的 20 → 100*10.5+100*20 = 3050', r.points[1].mv, 3050);
  eq('13:00 两边都命中 → 100*11+100*21 = 3200', r.points[2].mv, 3200);
  eq('11:30 有 1 只被填充', r.points[1].filled, 1);
  eq('13:00 无填充', r.points[2].filled, 0);
}

console.log('\n--- 3) 某标的整段缺数据 → 记 missing，不得出现 -100% 型塌陷 ---');
{
  const H = [{ symbol: 'A', qty: 10, currency: 'CNY' }, { symbol: 'DEAD', qty: 999, currency: 'CNY' }];
  const M = {
    A: { points: [{ t: '09:30', p: 10 }, { t: '09:31', p: 10.1 }] },
    /* DEAD 从来没有数据 */
  };
  const r = C.alignMinute(H, M);
  eq('DEAD 不计入，记 missing', r.missing, ['DEAD']);
  eq('只有 A 参与 → 100 / 101', r.points.map(p => p.mv), [100, 101]);
  eq('全程无填充', r.points.map(p => p.filled), [0, 0]);
  const vals = r.points.map(p => p.mv);
  const minV = Math.min(...vals), maxV = Math.max(...vals);
  eq('无 -100% 型塌陷（最小值 > 0）', minV > 0, true);
  eq('序列单调不降（只有 A 且在涨）', vals[1] >= vals[0], true);
  void maxV;
}

console.log('\n--- 4) 汇率生效 ---');
{
  const H = [{ symbol: 'HK', qty: 100, currency: 'HKD' }];
  const M = { HK: { points: [{ t: '09:30', p: 10 }, { t: '09:31', p: 11 }] } };
  const r = C.alignMinute(H, M, (c) => (c === 'HKD' ? 0.9 : 1));
  eq('100 * 10 * 0.9 = 900', r.points[0].mv, 900);
  eq('100 * 11 * 0.9 = 990', r.points[1].mv, 990);
}

console.log('\n--- 5) 空输入不炸 ---');
{
  eq('无持仓 → 空', C.alignMinute([], {}).points, []);
  eq('无分时 → 空', C.alignMinute([{ symbol: 'A', qty: 1, currency: 'CNY' }], {}).points, []);
  eq('points 为 null → 空', C.alignMinute([{ symbol: 'A', qty: 1, currency: 'CNY' }], { A: { points: null } }).points, []);
}

/* ---- 以下模拟 views/networth.buildIntraday 的三种指标口径 ----
   视图层不方便在 Node 里整体加载（依赖 store/DOM），因此把它的换算公式
   在测试里独立复现一遍。公式一旦改动，这里必须同步 —— 这就是断言的意义。 */
function intradayMetric(alPoints, metric, adj) {
  if (metric === 'ret') {
    const base = alPoints[0].mv;
    if (!(base > 0)) return null;
    return alPoints.map(p => Math.round((p.mv / base - 1) * 10000) / 100);
  }
  return alPoints.map(p => Math.round((p.mv + adj) * 100) / 100);
}

console.log('\n--- 6) 当日「持仓市值」= 分时市值绝对值（不是百分比） ---');
{
  const H = [{ symbol: 'A', qty: 100, currency: 'CNY' }];
  const M = { A: { points: [{ t: '09:30', p: 10 }, { t: '09:31', p: 10.5 }, { t: '14:55', p: 11 }] } };
  const r = C.alignMinute(H, M);
  const mv = intradayMetric(r.points, 'mv', 0);
  eq('市值序列 = 1000 / 1050 / 1100（元）', mv, [1000, 1050, 1100]);
  eq('首点不等于 0（旧实现只有百分比时首点为 0）', mv[0] !== 0, true);
}

console.log('\n--- 7) 当日「净资产」= 市值 + (累计已收分红 − 累计净投入) ---');
{
  const H = [{ symbol: 'A', qty: 100, currency: 'CNY' }];
  const M = { A: { points: [{ t: '09:30', p: 10 }, { t: '09:31', p: 10.5 }] } };
  const r = C.alignMinute(H, M);
  /* 净投入 800（= 100 股 × 8 元成本）、累计已收分红 300 → adj = 300 - 800 = -500 */
  const adj = 300 - 800;
  const nw = intradayMetric(r.points, 'nw', adj);
  eq('净资产 = 1000-500 / 1050-500', nw, [500, 550]);
  eq('净资产恒小于市值（净投入 > 已收分红时）', nw[0] < 1000, true);
}

console.log('\n--- 8) 当日「收益率」基准 = 首个报价，且基准为 0 时不给曲线 ---');
{
  const H = [{ symbol: 'A', qty: 100, currency: 'CNY' }];
  const M = { A: { points: [{ t: '09:30', p: 10 }, { t: '09:31', p: 11 }, { t: '09:32', p: 9 }] } };
  const r = C.alignMinute(H, M);
  eq('首点必为 0%', intradayMetric(r.points, 'ret', 0)[0], 0);
  eq('+10% / −10%', intradayMetric(r.points, 'ret', 0), [0, 10, -10]);
  /* 基准为 0（无有效持仓市值）→ 视图层应放弃画收益率曲线，而不是算出 -100% 或 Infinity */
  eq('基准为 0 → null（不画）', intradayMetric([{ t: '09:30', mv: 0 }, { t: '09:31', mv: 5 }], 'ret', 0), null);
}

console.log('\n--- 9) minuteOf：只认「这批」的分时，脏数据不画 ---');
{
  const pts = [{ t: '09:30', p: 10 }, { t: '09:31', p: 10.5 }];
  const today = '2026-09-16';

  /* 正常：批次日 = 数据日 = 今天 */
  const good = { at: today, bySymbol: { A: { date: today, points: pts } } };
  eq('当天批次 → 取到', C.minuteOf(good, 'A', today), { date: today, points: pts });

  /* ★ 产品口径是「显示最近一个交易日」，不是「只显示今天」。
     所以缓存里整整一批昨天的数据（周末打开时就是这样）**应该**画出来，
     由视图层的日期角标负责告诉用户这不是实时。
     这里锁住这个契约，免得日后有人误加 `date === today` 把周末功能砍掉。 */
  const lastTradingDay = { at: '2026-09-15', bySymbol: { A: { date: '2026-09-15', points: pts } } };
  eq('★ 自洽的「上一交易日」批次照画（周末可见上周五走势）',
    (C.minuteOf(lastTradingDay, 'A', today) || {}).date, '2026-09-15');

  /* ★ 真正的闸门：批次 at 与标的 date 不一致 = 脏数据/混批 → 不画 */
  const mixed = { at: today, bySymbol: { A: { date: '2026-09-15', points: pts } } };
  eq('★ 标的 date ≠ 批次 at（脏数据）不画', C.minuteOf(mixed, 'A', today), null);
  /* 反向：批次旧、标的却是未来 → 同样不画 */
  eq('★ 标的 date 新于批次 at → 不画',
    C.minuteOf({ at: '2026-09-15', bySymbol: { A: { date: today, points: pts } } }, 'A', today), null);

  /* 未来日期不画 */
  const future = { at: '2026-09-17', bySymbol: { A: { date: '2026-09-17', points: pts } } };
  eq('未来日期不画', C.minuteOf(future, 'A', today), null);

  /* 单点 / 空点 → 不画（与 alignMinute 门槛一致） */
  eq('单点不画（至少 2 点）',
    C.minuteOf({ at: today, bySymbol: { A: { date: today, points: [{ t: '09:30', p: 10 }] } } }, 'A', today), null);
  eq('空 points 不画',
    C.minuteOf({ at: today, bySymbol: { A: { date: today, points: [] } } }, 'A', today), null);

  /* 缓存缺失 / 结构不全 → 不画，且不抛 */
  eq('cache 为 null', C.minuteOf(null, 'A', today), null);
  eq('cache 无 at', C.minuteOf({ bySymbol: {} }, 'A', today), null);
  eq('cache 无 bySymbol', C.minuteOf({ at: today }, 'A', today), null);
  eq('symbol 不存在于缓存', C.minuteOf(good, 'ZZZ', today), null);
  eq('symbol 为空', C.minuteOf(good, '', today), null);
}

console.log('\n--- 10) minuteMapFor：批量取，只含可用的 ---');
{
  const pts = [{ t: '09:30', p: 10 }, { t: '09:31', p: 10.5 }];
  const today = '2026-09-16';
  const cache = {
    at: today,
    bySymbol: {
      A: { date: today, points: pts },
      B: { date: '2026-09-15', points: pts },     // date ≠ at → 脏数据
      C: { date: today, points: [{ t: '09:30', p: 1 }] },  // 单点
      D: { date: today, points: pts },
    },
  };
  const m = C.minuteMapFor(cache, ['A', 'B', 'C', 'D', 'MISSING'], today);
  eq('只留下 A 与 D', Object.keys(m).sort(), ['A', 'D']);
  eq('A 的 points 原样带出', m.A.points, pts);
  eq('可被 alignMinute 直接消费', C.alignMinute(
    [{ symbol: 'A', qty: 10, currency: 'CNY' }, { symbol: 'D', qty: 10, currency: 'CNY' }], m).points.length, 2);
  eq('空 symbols → 空对象', C.minuteMapFor(cache, [], today), {});
  eq('null symbols → 空对象', C.minuteMapFor(cache, null, today), {});
  eq('null cache → 空对象', C.minuteMapFor(null, ['A'], today), {});
  /* 缓存带 v 字段也应能用（旧数据兼容） */
  const withV = { at: today, bySymbol: { A: { date: today, points: [{ t: '09:30', p: 10, v: 5 }, { t: '09:31', p: 11, v: 6 }] } } };
  eq('旧数据带成交量 v 也能取', C.minuteOf(withV, 'A', today).points.length, 2);
}

/* ================================================================
 * 11) ★ full 模式：当日收益率的分母必须是【全组合】昨收市值
 *    真实场景 —— 组合里有 A 股（09:30 开盘）和美股（北京 21:30 开盘）：
 *    旧的「首个时刻 mv」当分母时，09:30 那一刻只有 A 股在报价，
 *    分母偏小会把当日涨幅放大好几倍。full 模式给出的 base 才含全组合。
 * ================================================================ */
console.log('\n--- 11) ★ full 模式：base = 全组合昨收市值（含尚未开盘的标的） ---');
{
  const H = [
    { symbol: 'A', qty: 10, currency: 'CNY' },      // A股
    { symbol: 'US', qty: 2, currency: 'USD' },      // 美股，USD
  ];
  const M = {
    A: { points: [{ t: '09:30', p: 11 }, { t: '09:31', p: 11.2 }] },
    US: { points: [{ t: '21:30', p: 210 }, { t: '21:31', p: 211 }] },
  };
  const fxr = (c) => (c === 'USD' ? 7 : 1);
  const PREV = { A: 10, US: 200 };

  const raw = C.alignMinute(H, M, fxr);                    // 旧口径（缺省）
  const full = C.alignMinute(H, M, fxr, { full: true, prev: PREV });

  /* 默认模式必须与旧版逐字节一致：不返回 base，不产出 pnl/pending */
  eq('缺省模式不返回 base', raw.base === undefined, true);
  eq('缺省模式的点里没有 pnl/pending 字段',
    Object.keys(raw.points[0]).join(','), 't,mv,filled');

  eq('★ base = 10×10 + 2×200×7 = 2900（全组合昨收市值）', full.base, 2900);
  eq('★ 09:30 那一刻美股尚未开盘 → pending = 1', full.points[0].pending, 1);
  eq('09:30 的 pnl 只含 A 股：(11−10)×10 = 10', full.points[0].pnl, 10);
  eq('09:31 仍是 1 只未开盘', full.points[1].pending, 1);
  eq('09:31 pnl = (11.2−10)×10 = 12', full.points[1].pnl, 12);
  eq('★ 21:30 美股开盘后 pending = 0', full.points[2].pending, 0);
  eq('★ 21:30 pnl = A 的 12 + 美股 (210−200)×2×7 = 140 → 152', full.points[2].pnl, 152);
  eq('21:31 pnl = A 的 12 + (211−200)×2×7 = 166', full.points[3].pnl, 166);

  /* ★ 反证：这正是用户看到的「当日收益率偏高」 */
  const oldPct = (raw.points[raw.points.length - 1].mv / raw.points[0].mv - 1) * 100;
  const newPct = full.points[full.points.length - 1].pnl / full.base * 100;
  eq('★ 旧口径把 09:30 的 mv 当分母 → 分母只含 A 股（100）',
    raw.points[0].mv, 110);
  eq('★ 旧口径算出的当日涨幅被放大数倍（' + oldPct.toFixed(2) + '% vs 新口径 ' +
    newPct.toFixed(2) + '%）', Math.abs(oldPct) > Math.abs(newPct) * 2, true);

  /* 昨收缺失 → 退化为该标的首个分时价（从 0 起算，不污染组合） */
  const noPrev = C.alignMinute([{ symbol: 'A', qty: 10, currency: 'CNY' }], M, fxr, { full: true });
  eq('缺昨收 → 用首个分时价兜底（base = 110）', noPrev.base, 110);
  eq('缺昨收 → 该标的 pnl 从 0 起算', noPrev.points[0].pnl, 0);

  /* 完全没分时的标的：full 模式仍留在 series 里占权重，并全程记 pending */
  const withOf = C.alignMinute(
    [{ symbol: 'A', qty: 10, currency: 'CNY' }, { symbol: 'OF', qty: 100, currency: 'CNY' }],
    M, fxr, { full: true, prev: { A: 10, OF: 2 } });
  eq('★ 无分时标的进 base（10×10 + 100×2 = 300）', withOf.base, 300);
  eq('★ 它全程 pending', withOf.points.every((p) => p.pending === 1), true);
  eq('它不进 mv（mv 仍只有 A）', withOf.points[0].mv, 110);
  eq('它也不进 missing 之外的 pnl 分子', withOf.points[0].pnl, 10);

  /* 边界：全都没有分时 */
  const none = C.alignMinute([{ symbol: 'OF', qty: 100, currency: 'CNY' }], {}, fxr,
    { full: true, prev: { OF: 2 } });
  eq('全无分时 → points 为空、base 仍算得出', [none.points.length, none.base], [0, 200]);
  eq('全无分时 → missing 记下它', none.missing, ['OF']);
}

console.log('\n' + '='.repeat(48));
console.log('alignMinute 独立验证：' + pass + ' 通过 / ' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;
