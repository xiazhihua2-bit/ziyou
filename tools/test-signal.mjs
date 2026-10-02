/* 独立验证「技术信号」：BOLL(20,2) 布林下轨 + KDJ(9,3,3) 的 J<0 判定
   1) 基础工具：滑动均值 / 总体标准差（口径必须÷N，不是÷(N−1)）
   2) 布林带：恒定序列、等差数列、窗口不足
   3) KDJ：分母为 0 的一字板、J 可越界不被 clamp、初值影响
   4) 实时拼接：今日/本周那根优先用接口的实时根，缺失才退化
   5) 信号入口：优先级（周线优先）、触及含等于、条件不满足立即消失、边界
   6) 真实性回归：纯函数无状态泄漏、不修改入参

   固定「今天」= 2026-09-16（周三）→ 本周一 = 2026-09-14。
   固定日期是为了让「本周那根怎么取」这件事完全可复现。

   ★★ 实时口径（2026-09-16 实测后定稿，与旧版的关键差别）★★
   腾讯 fqkline 接口【盘中就给实时根】，5 标的交叉验证其 o/h/l/c 与行情接口逐位一致：
     招商银行  末根 高41.41 低40.52  ←→  行情 qt[33] 41.41 / qt[34] 40.52   ✅
     五粮液    末根 高69.69 低68.89  ←→  行情 69.69 / 68.89                 ✅
   所以「今日/本周那根」一律【优先采用接口的真实 OHLC】，
   只在接口没给时才退化为「开=高=低=收=现价」。
   旧实现无条件用现价当高低，会把布林带的 σ 系统性压低
   （招行日振幅 1.07% 被抹成 0）→ 下轨偏高 → 信号偏晚。这两条路径下面都有断言锁定。
*/
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync('src/calc.js', 'utf8');

/* calc.js 是裸 `XJ.calc = ...`，需要全局 XJ 已存在。
   本文件比 test-alignminute 多用到 U.num / U.parseYmd / U.addDays
   以及 XJ.market.assetType（判场外基金），stub 相应补齐。 */
const sandbox = {
  window: {},
  console,
  Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
  parseInt, parseFloat, isNaN, Promise, setTimeout, clearTimeout,
};
sandbox.globalThis = sandbox;
sandbox.Date = Date;
vm.createContext(sandbox);

vm.runInContext(`
  var XJ = {};
  XJ.util = {
    num: function (v) {
      if (v === null || v === undefined || v === '') return null;
      var n = parseFloat(String(v).replace(/,/g, ''));
      return isNaN(n) ? null : n;
    },
    n0: function (v) {
      var n = XJ.util.num(v);
      return n === null ? 0 : n;
    },
    pad2: function (n) { return (n < 10 ? '0' : '') + n; },
    ymd: function (d) {
      return d.getFullYear() + '-' + XJ.util.pad2(d.getMonth() + 1) + '-' + XJ.util.pad2(d.getDate());
    },
    parseYmd: function (s) {
      if (!s) return null;
      var m = String(s).slice(0, 10).split('-');
      if (m.length !== 3) return null;
      var y = +m[0], mo = +m[1], da = +m[2];
      if (!y || !mo || !da) return null;
      var d = new Date(y, mo - 1, da);
      return isNaN(d.getTime()) ? null : d;
    },
    addDays: function (s, n) {
      var d = XJ.util.parseYmd(s);
      if (!d) return null;
      d.setDate(d.getDate() + n);
      return XJ.util.ymd(d);
    },
  };
  /* assetType 只用来判「场外基金不参与」，按 src/market.js:48 的口径裁剪出最小实现 */
  XJ.market = {
    assetType: function (symbol) {
      if (!symbol) return null;
      var mk = String(symbol).slice(0, 2), code = String(symbol).slice(2);
      if (mk === 'of') return 'of';
      if (mk === 'hk') return 'hk';
      if (mk === 'us') return 'us';
      if (mk === 'sh' && /^5/.test(code)) return 'etf';
      if (mk === 'sz' && /^1/.test(code)) return 'etf';
      return 'stock';
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
/* 浮点比对：BOLL/KDJ 是连续平滑的结果，不可能逐位相等 */
function near(label, got, want, tol) {
  const t = tol === undefined ? 1e-6 : tol;
  const ok = Number.isFinite(got) && Math.abs(got - want) <= t;
  if (ok) { pass++; console.log('  ✓ ' + label + '  →  ' + got); }
  else { fail++; console.log('  ✗ ' + label + '\n      got  ' + got + '\n      want ' + want + ' (±' + t + ')'); }
}

const TODAY = '2026-09-16';          // 周三
const MONDAY = '2026-09-14';         // 本周一
const FRI = '2026-09-11';            // 上周五

console.log('\n--- 1) 基础工具：滑动均值 / 总体标准差 ---');
{
  eq('smaSeries([1,2,3,4], 2) 窗口不足处为 null', C.smaSeries([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  eq('smaSeries([1,2,3], 3) 只有末项有值', C.smaSeries([1, 2, 3], 3), [null, null, 2]);
  eq('smaSeries([], 3) → 空', C.smaSeries([], 3), []);
  eq('stdSeries([2,2,2,2], 2) 恒定序列标准差为 0', C.stdSeries([2, 2, 2, 2], 2), [null, 0, 0, 0]);
  /* ★ 口径锁死：总体标准差（÷N）。样本口径（÷(N−1)）会得到 0.7071...
     —— 这个断言就是用来防止有人「顺手」改成样本口径的。
     [1,2] 的均值 1.5，偏差 ±0.5 → √(0.25/2)=0.5（总体） / √(0.25/1)=0.7071（样本） */
  near('★ stdSeries([1,2,3,4], 2) 末项 = 0.5（总体口径 ÷N；样本口径会是 0.7071）',
    C.stdSeries([1, 2, 3, 4], 2)[3], 0.5);
  eq('stdSeries([5], 3) 窗口不足 → null', C.stdSeries([5], 3), [null]);
}

console.log('\n--- 2) 布林带 BOLL(20,2) ---');
{
  const flat = [];
  for (let i = 0; i < 25; i++) flat.push(10);
  const bf = C.boll(flat, 20, 2);
  eq('恒定序列 → 末根 mid=upper=lower=10（标准差为 0，三轨重合）', bf[bf.length - 1].mid, 10);
  eq('恒定序列 → upper 也是 10', bf[bf.length - 1].upper, 10);
  eq('恒定序列 → lower 也是 10', bf[bf.length - 1].lower, 10);
  eq('窗口不足的前 19 根三个值均为 null', bf.slice(0, 19).every(x => x.mid === null && x.upper === null && x.lower === null), true);
  eq('第 20 根（下标 19）开始有值', bf[19].mid !== null, true);

  /* 等差 1..20：均值 10.5，总体标准差 = √(Σ(i−10.5)²/20) = √(665/20) = √33.25 ≈ 5.766281
     下轨 = 10.5 − 2×5.766281 ≈ −1.032563 */
  const seq = [];
  for (let i = 1; i <= 20; i++) seq.push(i);
  const bs = C.boll(seq, 20, 2);
  const last = bs[bs.length - 1];
  near('等差 1..20 → 中轨 = 10.5', last.mid, 10.5);
  near('等差 1..20 → 下轨 ≈ −1.032563（总体标准差 √33.25≈5.766281）', last.lower, 10.5 - 2 * Math.sqrt(33.25));

  eq('窗口不足：[1,2,3] 配 N=20 → 末根 lower 为 null', C.boll([1, 2, 3], 20, 2).pop().lower, null);
  eq('k 缺省按 2 处理（与显式 k=2 一致）', C.boll(seq).pop().upper, C.boll(seq, 20, 2).pop().upper);
  eq('空数组 → 空', C.boll([], 20, 2), []);
}

console.log('\n--- 3) KDJ(9,3,3) ---');
{
  /* 一字板：N 日最高 === 最低 → RSV 分母为 0。
     必须取中性 50，否则 RSV=NaN → J=NaN，而 NaN<0 恒 false，
     信号会静默地永不亮起 —— 这是最难排查的一类失效。 */
  const flatBars = [];
  for (let i = 0; i < 30; i++) flatBars.push({ h: 10, l: 10, c: 10 });
  const kf = C.kdj(flatBars, 9, 3, 3);
  near('★ 一字板（HHV=LLV）→ RSV 取中性 50，末根 J 精确为 50', kf[kf.length - 1].j, 50);
  eq('一字板 → 末根 K 也收敛到 50', Math.round(kf[kf.length - 1].k * 1e6) / 1e6, 50);
  eq('一字板 → 全程无 NaN', kf.every(x => x.j === null || !Number.isNaN(x.j)), true);

  /* ============================================================
     关于「J 能到多大 / 多小」——三条由实测确立的构造规则。
     手算递推与 C.kdj 在下面每个 case 上都逐位一致（最大偏差 0.000e+0），
     所以「J 没越界」从来不是实现问题，而是 fixture 没造对。
     ============================================================ */

  /* 规则一：J 想超过 100，收盘必须【收在窗口最高价上】。
     若 c 恒低于 h（如 h=i+1 而 c=i+0.9），RSV 收敛到 (c−ll)/(hh−ll) = 8.9/9 ≈ 98.9，
     平滑后 K≈D≈98.9 → J = 3K−2D ≈ 99，永远到不了 100。
     只有 c 贴上 h（RSV=100）才能把 J 推过 100。 */
  const upLoose = [];
  for (let i = 0; i < 40; i++) upLoose.push({ h: i + 1, l: i, c: i + 0.9 });
  near('单调上涨但收盘【未】站在窗口最高 → J 收敛到 ≈98.89，不到 100（记录这个边界）',
    C.kdj(upLoose, 9, 3, 3).slice(-1)[0].j, 98.8912, 1e-3);

  /* J 越界是 KDJ 的固有性质，绝不能 clamp —— 本功能的判定条件是 J<0，clamp 会改掉结论。 */
  const up = [];
  for (let i = 0; i < 40; i++) up.push({ h: i + 1, l: i, c: i + 1 });
  const ku = C.kdj(up, 9, 3, 3);
  eq('★ 单调上涨且收盘贴在窗口最高（RSV=100）→ 末根 J > 100（不 clamp，KDJ 固有性质）',
    ku[ku.length - 1].j > 100, true);
  eq('  ↑ 且 J 只是略微越界（≈100.0024），不是爆炸式增长', ku[ku.length - 1].j < 101, true);

  /* 规则二：等速下跌不足以让 J 转负（反直觉）。
     下跌时 h=40−i、l=39−i、c=39.2−i，窗口最低价恒等于末根最低价，
     RSV 稳定在 (39.2−ll)/(hh−ll) = 0.2/1 = 20 → K/D 收敛到 20 → J ≈ +20。
     实测收敛值 +2.22（初值 50 在长序列里被逐步磨掉）。 */
  const flat = [];
  for (let i = 0; i < 40; i++) flat.push({ h: 40 - i, l: 39 - i, c: 39.2 - i });
  eq('等速下跌不足以让 J 转负（记录这个反直觉的事实）',
    C.kdj(flat, 9, 3, 3).slice(-1)[0].j > 0, true);

  /* 规则三：要 J 转负，需要【连续多根】加速下跌。
     平滑式 K = 2/3·K + 1/3·RSV 意味着单根 RSV 归零只能把 K 拉下 1/3，
     下一根就被 D 的反向平滑托回来 —— 实测「末根单根暴跌」仅把 J 压到 +1.41。 */
  const crash1 = [];
  for (let i = 0; i < 40; i++) {
    if (i < 39) crash1.push({ h: 40 - i, l: 39 - i, c: 39.2 - i });
    else crash1.push({ h: 2, l: 0.5, c: 0.6 });
  }
  eq('★ 末【单】根暴跌不够：J 仅降到 +1.41，仍未转负（平滑的滞后性）',
    C.kdj(crash1, 9, 3, 3).slice(-1)[0].j > 0, true);
  near('  ↑ 实测该值 = +1.4066', C.kdj(crash1, 9, 3, 3).slice(-1)[0].j, 1.4066, 1e-3);

  const dn = [];
  for (let i = 0; i < 40; i++) {
    if (i < 37) dn.push({ h: 40 - i, l: 39 - i, c: 39.2 - i });
    else { const k = i - 36; dn.push({ h: 40 - i, l: 39 - i, c: 39.2 - i - 8 * k }); }
  }
  const kd = C.kdj(dn, 9, 3, 3);
  eq('★ 连续 3 根加速暴跌 → 末根 J < 0（这正是信号成立的条件）', kd[kd.length - 1].j < 0, true);
  near('  ↑ 实测该值 ≈ −284.20（J 可深度为负，同样不 clamp）',
    kd[kd.length - 1].j, -284.1998, 1e-2);

  eq('不足 N 根 → 前 8 根三个值均为 null', C.kdj(up.slice(0, 5), 9, 3, 3).every(x => x.k === null && x.d === null && x.j === null), true);
  eq('空数组 → 空', C.kdj([], 9, 3, 3), []);

  /* 初值影响显式记录：同一个末根，只喂最后 12 根 vs 喂全 40 根，J 不相等。
     这说明「喂足够长历史」不是可选项 —— 缓存取 60 根而不是刚好 20 根就是为了这个。 */
  const short = C.kdj(up.slice(-12), 9, 3, 3);
  const long = C.kdj(up, 9, 3, 3);
  const jShort = short[short.length - 1].j, jLong = long[long.length - 1].j;
  eq('★ 初值影响：只喂 12 根与喂 40 根的 J 不相等（故缓存取 60 根让 K/D 收敛）',
    Math.abs(jShort - jLong) > 1e-9, true);
}

console.log('\n--- 4) 实时拼接：今日那根 / 本周那根（接口优先，缺失退化） ---');
{
  const hist = [
    { d: '2026-09-10', o: 10, h: 10.2, l: 9.8, c: 10 },
    { d: '2026-09-11', o: 10, h: 10.1, l: 9.9, c: 10 },
  ];

  /* ---- 路径 A：接口未给今日根 → 退化为「开=高=低=收=现价」 ---- */
  const a = C.withLiveBar(hist, TODAY, 9.5);
  eq('接口无今日根 → 追加一根', a.length, 3);
  eq('追加那根的 d = today', a[2].d, TODAY);
  eq('追加那根的 c = 现价', a[2].c, 9.5);
  eq('★ 退化路径：h/l 也等于现价（接口没给真实高低，只能如此）', [a[2].h, a[2].l], [9.5, 9.5]);
  eq('追加那根标记 live', a[2].live, true);

  /* ---- 路径 B：接口已给今日根 → ★ 原样采用真实 o/h/l/c ---- */
  const withToday = hist.concat([{ d: TODAY, o: 10.1, h: 10.5, l: 9.4, c: 10.2 }]);
  const b = C.withLiveBar(withToday, TODAY, 9.5);
  eq('接口已含 today → 不新增根', b.length, 3);
  eq('  ↑ d = today 的根只有一根（不重复）', b.filter(x => x.d === TODAY).length, 1);
  eq('★ 高 = 接口的真实盘中高点 10.5（不是现价 9.5）', b[2].h, 10.5);
  eq('★ 低 = 接口的真实盘中低点 9.4 ∪ 现价 9.5 → 9.4', b[2].l, 9.4);
  eq('★ 开 = 接口的真实开盘 10.1', b[2].o, 10.1);
  eq('★ 收 = 实时价（校正为判定所用的同一个 p，避免自相矛盾）', b[2].c, 9.5);

  /* 现价刷出新低/新高时，真实极值要被并进去（否则盘中破新低不反映） */
  const bLow = C.withLiveBar(withToday, TODAY, 9.0);
  eq('★ 现价 9.0 低于接口低点 9.4 → 低点被刷新为 9.0', bLow[2].l, 9.0);
  const bHigh = C.withLiveBar(withToday, TODAY, 11.0);
  eq('★ 现价 11.0 高于接口高点 10.5 → 高点被刷新为 11.0', bHigh[2].h, 11.0);

  /* ★ 这才是本次改造的收益所在：振幅不再被抹成 0 */
  eq('★ 旧行为（h=l=现价）会让今日根振幅 = 0', a[2].h - a[2].l, 0);
  near('★ 新行为保留真实振幅 ≈1.1（10.5 − 9.4，浮点故用容差）', b[2].h - b[2].l, 1.1, 1e-9);

  /* 未来日期的脏根要被丢掉（时区/数据源错乱时会遇到） */
  const dirty = hist.concat([{ d: '2026-09-20', o: 1, h: 1, l: 1, c: 1 }]);
  eq('丢掉 d > today 的脏根', C.withLiveBar(dirty, TODAY, 10).filter(x => x.d === '2026-09-20').length, 0);

  /* ---- 本周那根：接口已有 vs 缺失 ---- */
  const weekHistOnly = [
    { d: '2026-08-28', o: 9.5, h: 9.8, l: 9.4, c: 9.6 },
    { d: FRI, o: 9.0, h: 9.2, l: 8.9, c: 9.1 },
  ];
  const dayBars = [
    { d: FRI, o: 9.0, h: 9.2, l: 8.9, c: 9.1 },
    { d: MONDAY, o: 10.0, h: 10.5, l: 9.9, c: 10.2 },
    { d: '2026-09-15', o: 10.2, h: 10.3, l: 9.6, c: 9.8 },
    { d: TODAY, o: 9.8, h: 9.9, l: 9.4, c: 9.5 },
  ];

  /* 路径 A：接口没给本周那根（模拟周一早盘）→ 由日K聚合 */
  const wlA = C.withLiveWeek(weekHistOnly, dayBars, TODAY, 9.3);
  eq('★ 接口无本周那根 → 补上聚合的那根', wlA.length, 3);
  const lastA = wlA[wlA.length - 1];
  eq('  ↑ 聚合根 d = today', lastA.d, TODAY);
  eq('  ↑ 开 = 本周第一根日K 的开盘价 10.0', lastA.o, 10.0);
  eq('  ↑ 高 = max(本周日K高, 现价) = max(10.5,10.3,9.9,9.3) = 10.5', lastA.h, 10.5);
  eq('  ↑ 低 = min(本周日K低, 现价) = min(9.9,9.6,9.4,9.3) = 9.3（现价刷了新低）', lastA.l, 9.3);
  eq('  ↑ 收 = 现价', lastA.c, 9.3);
  eq('  ↑ 标记 live', lastA.live, true);
  eq('  ↑ 上周五那根仍在（未被误删）', wlA.some(x => x.d === FRI), true);

  /* 路径 B：接口已给本周那根 → 原样采用，只校正收盘 */
  const weekWithThis = weekHistOnly.concat([{ d: TODAY, o: 9.9, h: 10.4, l: 9.2, c: 9.4 }]);
  const wlB = C.withLiveWeek(weekWithThis, dayBars, TODAY, 9.3);
  eq('★ 接口已给本周那根 → 不重复追加（长度仍是 3）', wlB.length, 3);
  const lastB = wlB[wlB.length - 1];
  eq('  ↑ 高 = 接口的真实 10.4（不用聚合值 10.5）', lastB.h, 10.4);
  eq('  ↑ 低 = 接口的真实 9.2 ∪ 现价 9.3 → 9.2', lastB.l, 9.2);
  eq('  ↑ 收 = 实时价 9.3（校正为判定所用的 p）', lastB.c, 9.3);
  eq('  ↑ d = today 的周根只有一根（不会同一周算两次）',
    wlB.filter(x => x.d >= MONDAY).length, 1);

  /* 接口周K 里若有「本周一之前但已在本周内」的根，也算本周那根
     （接口的周K日期用的是该周最后一个交易日，本周未收盘时就是今天） */
  const wlMon = C.withLiveWeek(weekHistOnly.concat([{ d: MONDAY, o: 10, h: 10.5, l: 9.9, c: 10.1 }]), dayBars, TODAY, 9.3);
  eq('★ 接口给的周根日期落在本周内（d >= 周一）即视为本周根，不再聚合',
    wlMon.length, 3);

  /* 兜底函数本身的行为（weekLiveBar 直调） */
  const wb = C.weekLiveBar(dayBars, TODAY, 9.3);
  eq('weekLiveBar 兜底：高取本周真实极值 ∪ 现价', wb.h, 10.5);
  eq('weekLiveBar 兜底：低取本周真实极值 ∪ 现价', wb.l, 9.3);
  eq('上周五的日K 不计入（b.d < 本周一）', C.weekLiveBar([{ d: FRI, o: 9, h: 99, l: 1, c: 9.1 }], TODAY, 9.3).h, 9.3);

  /* 周一早盘：本周还没有任何日 K → 退化为全体现价，而不是返回 null
     （若返回 null，每周一上午的周线信号都会整段消失） */
  const monOnly = C.weekLiveBar([{ d: FRI, o: 9, h: 9.2, l: 8.9, c: 9.1 }], MONDAY, 9.7);
  eq('★ 周一早盘无本周日K → 开=高=低=收=现价（不返回 null）',
    [monOnly.o, monOnly.h, monOnly.l, monOnly.c], [9.7, 9.7, 9.7, 9.7]);
  /* 且 withLiveWeek 在这个场景下也要能补出那根 */
  eq('★ 周一早盘 + 接口无本周根 → withLiveWeek 仍补出一根（信号不会整上午消失）',
    C.withLiveWeek(weekHistOnly, [{ d: FRI, o: 9, h: 9.2, l: 8.9, c: 9.1 }], MONDAY, 9.7).length, 3);

  eq('today 非法 → null', C.weekLiveBar(dayBars, 'abc', 9.3), null);
  eq('现价无效 → null', C.weekLiveBar(dayBars, TODAY, null), null);
  eq('mondayOf(周三 2026-09-16) → 2026-09-14', C.mondayOf('2026-09-16'), '2026-09-14');
  eq('mondayOf(周日 2026-09-20) → 本周一 2026-09-14（周日回退 6 天）', C.mondayOf('2026-09-20'), '2026-09-14');

  /* ★ 不修改入参（withLiveWeek 会就地改最后一根的 h/l/c，必须改的是副本） */
  const wkSnap = JSON.stringify(weekWithThis);
  C.withLiveWeek(weekWithThis, dayBars, TODAY, 9.3);
  eq('★ withLiveWeek 不修改传入的 weekBars（就地改动的是副本）',
    JSON.stringify(weekWithThis), wkSnap);
}

/* ---------------- 构造一份可手算的 K 线 ----------------
   「让 J 转负」不是随便造一段下跌就行的，实测踩过四个坑
   （前三条的实测值见第 3 组的三条规则）：

     ① 收盘必须【真跌到窗口最低之下】。等速下跌 c 恒在窗口最低上方，
        RSV 稳定在 20 左右，J 收敛到 +2.22，永远为正。
     ② 单根暴跌也不够。平滑式 K = 2/3·K + 1/3·RSV 有滞后，
        一根 RSV=0 只能把 K 拉下 1/3，实测 J 仅到 +1.41。
     ③ 必须【连续多根】加速下跌，才把 K 彻底压低、进而把 D 带下来。
     ④ ★ 末根（现价那根）必须是全窗口最低，否则前功尽弃。
        踩过的坑：跌幅给太大导致中间几根跌到负价（−8.70），
        而现价 1.2 反而【高于】那几根 → 窗口 ll = −8.75、
        RSV = (1.2+8.75)/(9.45+8.75) ≈ 54.7 → J 直接弹回 +39.6。
        （真实行情不会为负，这个坑纯粹是 fixture 造出来的。）

   所以：前 40 根恒 10.00（布林带收窄）→ 温和阴跌到 9.30
   → 末 4 根加速跌到 2.10 → 现价取 1.20，是全序列最低。 */
function buildBars(n) {
  const bars = [];
  const start = new Date(2026, 4, 1);        // 2026-05-01 起，逐日递增（指标不看交易日历）
  /* 暴跌起点：从倒数第 5 根开始（保证追加 live 根后仍在跌势中） */
  const crashFrom = n - 5;
  for (let i = 0; i < n; i++) {
    const d = new Date(start.getTime());
    d.setDate(d.getDate() + i);
    const ymd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    let c;
    if (i < 40) {
      c = 10;                                 // 平台期（布林带收窄）
    } else if (i < crashFrom) {
      c = 10 - 0.05 * (i - 39);               // 温和阴跌：10.00 → 9.30
    } else {
      /* 末段加速暴跌，但整体保持在正价区间：
         9.30 → 8.10 → 5.70 → 2.10（累计跌幅呈等差和，末根仍 > 现价 1.20） */
      const k = i - crashFrom + 1;
      c = 9.30 - 0.30 * (k * (k + 1) / 2);    // −0.60, −1.80, −3.60, −6.00 → 8.70, 7.50, 5.70, 3.30
    }
    bars.push({ d: ymd, o: c, h: c + 0.05, l: c - 0.05, c: c });
  }
  return bars;
}
const DAY_BARS = buildBars(59);              // 59 根：末根日期 2026-06-28，远早于 TODAY
/* 现价：全序列最低（1.20 < 末根收盘 3.30），保证 KDJ 的 J 为负、且价格足够低 */
const LOW_PRICE = 1.2;

/* 单调上涨序列：h / l / c 必须【同步】抬高。
   踩过的坑：只把 c 改成 10+i*0.1 而沿用暴跌序列的 h/l，
   KDJ 仍然读到那段暴跌历史，J 照样为负，断言就测不到「J≥0 时价格再低也不亮」。 */
const UP_BARS = (function () {
  const out = [];
  const start = new Date(2026, 4, 1);
  for (let i = 0; i < 59; i++) {
    const d = new Date(start.getTime());
    d.setDate(d.getDate() + i);
    const ymd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const c = 10 + i * 0.1;
    out.push({ d: ymd, o: c, h: c + 0.05, l: c - 0.05, c: c });
  }
  return out;
})();

console.log('\n--- 5) 信号入口 bollSignal ---');
{
  /* 先把真实下轨与 J 探出来，避免把断言写死在「我以为的数字」上 */
  const live = C.withLiveBar(DAY_BARS, TODAY, LOW_PRICE);
  const bb = C.boll(live.map(b => b.c), 20, 2);
  const lower = bb[bb.length - 1].lower;
  const kk = C.kdj(live, 9, 3, 3);
  const j = kk[kk.length - 1].j;
  eq('★ 加速下跌序列的 J 已转负（信号条件之一成立）', j < 0, true);
  eq('该序列的下轨是一个有限数', Number.isFinite(lower), true);

  /* 先确认「J 为负」这件事本身不会单独触发信号 —— 即两个条件缺一不可。
     ⚠️ 不能简单地「把现价改成下轨上方」来测：现价是【指标输入的一部分】
     （它会成为末根的 o/h/l/c），改现价 = 改整条指标序列，下轨和 J 都会跟着变。
     实测在这条暴跌序列上，无论现价取 3.30 / 2.00 / 1.20 / 0.01，
     J 恒为 −2.65、下轨恒在 3.88 以上 —— 现价永远在下轨下方，「高于下轨」根本不可达。

     正确构造（已实测校验）：先来一段【大振幅】横向震荡（±15 锯齿）把 20 日标准差撑大，
     让下轨被推到远离价格的下方；再在尾 3 根做【陡】跌（−6/−18/−36）把 J 压负。
     这样「J < 0 但现价 > 下轨」才真实存在（实测 p=64 时 lower≈60.30、J≈−14.0）。 */
  const choppy = [];
  for (let i = 0; i < 59; i++) {
    const d = new Date(2026, 4, 1);
    d.setDate(d.getDate() + i);
    const ymd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    let c;
    if (i < 56) c = 100 + (i % 2 === 0 ? 15 : -15);            // 115/85 交替 → σ 很大
    else { const k = i - 55; c = 100 - 6 * (k * (k + 1) / 2); } // 尾 3 根陡跌：94, 82, 64
    choppy.push({ d: ymd, o: c, h: c + 0.5, l: c - 0.5, c: c });
  }
  const chLower = C.boll(C.withLiveBar(choppy, TODAY, 64).map(b => b.c), 20, 2).pop().lower;
  const chJ = C.kdj(C.withLiveBar(choppy, TODAY, 64), 9, 3, 3).slice(-1)[0].j;
  eq('★ 构造校验：该序列在 p=64 时 J < 0（实测 ≈−14.0）', chJ < 0, true);
  eq('★ 构造校验：该序列在 p=64 时现价仍在【下轨之上】（实测 lower≈60.30）', 64 > chLower, true);
  eq('★ J < 0 且现价在下轨之上 → 不命中（两个条件缺一不可）',
    C.bollSignal('sh600036', choppy, [], 64, TODAY), null);

  /* 数据充足、价格合理时不该有信号 */
  eq('价格远离下轨（10 元）→ null', C.bollSignal('sh600036', DAY_BARS, [], 10, TODAY), null);

  /* ★ 「触及」含等于（用 ≤ 而非 <）—— 必须用【自洽】的方式验证。
     ⚠️ 关键陷阱：现价本身是指标输入（它成为末根的 o/h/l/c），
     所以「先算出 lower、再把 lower 当现价喂回去」是错的 ——
     喂进去以后整条序列变了，下轨也跟着变，两边的数字不再对应。
     （在 DAY_BARS 上就是如此：J 在 p≈4.9 转正，而下轨零点在 p≈5.94，
     两个区间不重叠，所以那条序列上「p===lower 且 J<0」根本不可达。）
     正确做法：解不动点 p = lower(p)。在 choppy 上该根收敛到
     p = 59.130265935371646，且此处 J 仍为 −14.75 → 恰好命中。
     这同时验证了「≤ 含等于」和「两条件须同时成立」。 */
  function chLowerAt(p) {
    return C.boll(C.withLiveBar(choppy, TODAY, p).map(b => b.c), 20, 2).pop().lower;
  }
  let lo = 58, hi = 64;
  for (let it = 0; it < 100; it++) {
    const mid = (lo + hi) / 2;
    if (chLowerAt(mid) - mid > 0) lo = mid; else hi = mid;      // lower > p → 往高价走
  }
  const eqPrice = (lo + hi) / 2;
  const eqLower = chLowerAt(eqPrice);
  eq('★ 二分求出不动点：现价 === 该现价下算出的下轨（|diff| < 1e-9）',
    Math.abs(eqPrice - eqLower) < 1e-9, true);
  eq('★ 该不动点处 J 仍为负（实测 ≈−14.75）',
    C.kdj(C.withLiveBar(choppy, TODAY, eqPrice), 9, 3, 3).slice(-1)[0].j < 0, true);
  const hitEq = C.bollSignal('sh600036', choppy, [], eqPrice, TODAY);
  eq('★ 现价 === 下轨 → 命中（触及含等于，用 ≤ 而非 <）', hitEq && hitEq.kind, 'day');
  eq('日线信号文案 = 日线下轨', hitEq && hitEq.text, '日线下轨');
  eq('日线信号样式类 = sig-day', hitEq && hitEq.cls, 'sig-day');

  /* 只比不动点高一点点（+0.12）→ 立刻不命中。
     这是「≤ 而不是 <」最锋利的证明：J 条件完全没变（仍 −14.75），
     唯一的差别是价格越过了下轨。 */
  eq('★ 现价仅高出不动点 0.12（J 未变，仍为负）→ 不命中（证明是 ≤ 而非 <）',
    C.bollSignal('sh600036', choppy, [], eqPrice + 0.12, TODAY), null);

  /* 现价明显低于自己的下轨 → 必命中。
     用一个足够低的价格（其下轨必然随之走低，但下跌幅度远小于价格跌幅，
     实测现价 1.20 → 下轨 4.33，price <= lower 成立）。 */
  const hitBelow = C.bollSignal('sh600036', DAY_BARS, [], LOW_PRICE, TODAY);
  eq('跌破下轨（现价 1.20，其下轨 4.33）→ 命中', hitBelow && hitBelow.kind, 'day');

  /* 条件不再满足 → 立刻返回 null（视图据此不渲染）。
     同样不能靠「把价格改高」来测（会改变指标）；用另一条 J ≥ 0 的序列来表示。 */
  eq('★ 不再满足即消失：上涨序列的 J ≥ 0 → 即使价格低于其下轨也返回 null',
    C.bollSignal('sh600036', UP_BARS, [], 1, TODAY), null);
  eq('  ↑ 该序列的 J 实测 ≈20.99（远大于 0）',
    C.kdj(C.withLiveBar(UP_BARS, TODAY, 1), 9, 3, 3).slice(-1)[0].j > 0, true);
  eq('  ↑ 且该序列在现价 1 时下轨 ≈8.05，价格【确实】在下轨之下（价格条件已满足）',
    1 < C.boll(C.withLiveBar(UP_BARS, TODAY, 1).map(b => b.c), 20, 2).pop().lower, true);

  /* 日线与周线同时满足 → 周线优先。
     周线历史同样要避开「跌到负价」的坑：25 周若用 0.2 的等差和会跌到 −50。
     这里改用每 2 周才加一的温和加速，25 周累计跌幅 ≈ 8.4，全程正价。 */
  const weekHist = [];
  for (let i = 0; i < 25; i++) {
    const d = new Date(2026, 2, 2 + i * 7);       // 2026-03-02 起，每 7 天一周
    const ymd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    if (ymd >= MONDAY) break;
    const c = 100 - 0.04 * (i * (i + 1) / 2);     // i=24 时累计 12 → 88，始终为正
    weekHist.push({ d: ymd, o: c + 0.1, h: c + 0.2, l: c - 0.2, c: c });
  }
  eq('周线历史构造到了本周一之前', weekHist.length >= 20 && weekHist[weekHist.length - 1].d < MONDAY, true);
  const wLower = (function () {
    const wl = weekHist.concat([C.weekLiveBar(DAY_BARS, TODAY, LOW_PRICE)]);
    return C.boll(wl.map(b => b.c), 20, 2).pop().lower;
  })();
  const bothLow = C.bollSignal('sh600036', DAY_BARS, weekHist, Math.min(LOW_PRICE, wLower), TODAY);
  eq('★ 日线与周线同时满足 → 只返回周线（kind = week）', bothLow && bothLow.kind, 'week');
  eq('周线信号文案 = 周线下轨（不是「强烈买入」之类的措辞）', bothLow && bothLow.text, '周线下轨');
  eq('周线信号样式类 = sig-week', bothLow && bothLow.cls, 'sig-week');

  /* 边界 */
  eq('场外基金 of110022 → null（无盘中行情，不参与）', C.bollSignal('of110022', DAY_BARS, weekHist, 1, TODAY), null);
  eq('现价 null → null', C.bollSignal('sh600036', DAY_BARS, weekHist, null, TODAY), null);
  eq('现价 0 → null', C.bollSignal('sh600036', DAY_BARS, weekHist, 0, TODAY), null);
  eq('现价负数 → null', C.bollSignal('sh600036', DAY_BARS, weekHist, -1, TODAY), null);
  eq('日K 只有 15 根 → 数据不足，日线不亮', C.bollSignal('sh600036', buildBars(15), [], 1, TODAY), null);
  eq('周K 为空数组 → 不崩、周线不亮（日K 数据充足且现价极低时仍可能亮日线）',
    C.bollSignal('sh600036', DAY_BARS, [], LOW_PRICE) !== undefined, true);
  eq('两个 K 线都为空 → null', C.bollSignal('sh600036', [], [], 1, TODAY), null);
  eq('dayBars 为 null → null', C.bollSignal('sh600036', null, null, 1, TODAY), null);
  eq('today 非法字符串 → 不抛异常（仍可判日线）',
    (() => { try { C.bollSignal('sh600036', DAY_BARS, [], LOW_PRICE, ''); return true; } catch (e) { return false; } })(), true);
}

console.log('\n--- 6) 真实性回归：纯函数 / 不改入参 ---');
{
  /* 深拷贝前后对比：bollSignal 绝不能就地修改传入的 K 线数组
     （视图层会传 store 里的缓存对象，被改掉会导致缓存污染） */
  const daySnap = JSON.stringify(DAY_BARS);
  const weekSnap = [];
  C.bollSignal('sh600036', DAY_BARS, weekSnap, 9, TODAY);
  eq('★ 不修改传入的 dayBars（深比较前后）', JSON.stringify(DAY_BARS), daySnap);

  const weekBars = [{ d: FRI, o: 9, h: 9.2, l: 8.9, c: 9.1 }];
  const wSnap = JSON.stringify(weekBars);
  C.bollSignal('sh600036', DAY_BARS, weekBars, 9, TODAY);
  eq('★ 不修改传入的 weekBars', JSON.stringify(weekBars), wSnap);

  /* 同一输入两次调用结果必须完全一致。
     若 KDJ 的 pk/pd 被误写成模块级变量（而非函数内局部），
     第二次调用会带着上一次的累积值 —— 这条断言就是防这个。 */
  const r1 = C.bollSignal('sh600036', DAY_BARS, [], 9, TODAY);
  const r2 = C.bollSignal('sh600036', DAY_BARS, [], 9, TODAY);
  eq('★ 两次调用结果完全一致（KDJ 状态未泄漏到模块级）', JSON.stringify(r1), JSON.stringify(r2));

  const k1 = C.kdj(DAY_BARS, 9, 3, 3).pop().j;
  const k2 = C.kdj(DAY_BARS, 9, 3, 3).pop().j;
  eq('★ kdj 同样无状态泄漏', k1, k2);

  /* 真实形状的数据不产生 NaN / 崩溃 */
  const dump = C.kdj(DAY_BARS, 9, 3, 3);
  eq('真实数据全程无 NaN', dump.every(x => x.j === null || Number.isFinite(x.j)), true);
  eq('结果长度与输入等长', dump.length, DAY_BARS.length);
}

console.log('\n' + '='.repeat(48));
console.log('技术信号独立验证：' + pass + ' 通过 / ' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;
