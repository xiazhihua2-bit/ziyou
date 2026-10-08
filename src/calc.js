/* ==================== 计算引擎（纯函数为主） ====================
 * 除 applyAutoReceived 外，全部为无副作用纯函数：不碰 DOM、不碰存储。
 * 口径说明：
 *  - 金额单位「元」，数量单位「股」
 *  - 预计到账 / 预测分红一律使用【税前】每股派息，与「息记」口径一致
 *  - 实时股息率 = 近 12 个月已实施分配的每股税前分红合计 ÷ 现价
 */
XJ.calc = (function () {
  var U = XJ.util;
  var ALL = '__all__';

  /* ---------------- 基础 ---------------- */

  function perSharePretax(plan) { return U.n0(plan.pretaxBonusPer10) / 10; }
  function perShareAfterTax(plan) {
    if (plan.afterTaxPer10 !== null && plan.afterTaxPer10 !== undefined) return U.n0(plan.afterTaxPer10) / 10;
    return perSharePretax(plan);
  }
  /**
   * 派息落地日期（到账日）。优先级：
   *   1) plan.payoutDate —— 仅当数据源确实给了独立派息日时采用（基金 / 港股）
   *   2) 除权除息日      —— A 股数据源没有独立派息日字段，且按产品口径
   *                        「A 股派息日 = 除权除息日」（同一天），不做 T+1 推算
   *   3) 股权登记日      —— 兜底
   * exact=true 表示是数据源给出的确定日期，UI 才可以说「派息日」而非「预计派息日」。
   */
  function payoutInfo(plan) {
    var hasRealPayout = (plan.source === 'hk' || plan.source === 'fund') && plan.payoutDate;
    if (hasRealPayout) return { date: plan.payoutDate, exact: true };
    if (plan.exDividendDate) return { date: plan.exDividendDate, exact: false };
    if (plan.equityRecordDate) return { date: plan.equityRecordDate, exact: false };
    if (plan.payoutDate) return { date: plan.payoutDate, exact: true };
    return { date: null, exact: false };
  }
  function payoutDate(plan) { return payoutInfo(plan).date; }

  /**
   * 分红【归属锚点】——用于「近 12 个月」这类时间窗口统计。
   * 锚点是除权除息日：红利在除权除息日即归属持有人，
   * 若用「发放日」做锚点，会出现除权后、发放前这几天该笔分红凭空消失的怪异现象。
   */
  function dividendAnchor(plan) {
    return plan.exDividendDate || plan.equityRecordDate || plan.payoutDate || null;
  }
  function reportYear(plan) { return U.num(String(plan.reportDate).slice(0, 4)); }
  function isAnnualReport(plan) { return String(plan.reportDate).slice(5, 7) === '12'; }

  function plansOf(state, symbol) {
    var out = [];
    var keys = Object.keys(state.plans);
    for (var i = 0; i < keys.length; i++) {
      var p = state.plans[keys[i]];
      if (p && p.symbol === symbol) out.push(p);
    }
    return out.sort(function (a, b) { return a.reportDate < b.reportDate ? 1 : -1; });
  }

  /** 该标的的每股税前合计（近 12 个月，按除权除息日归属） */
  function trailingPerShare(plans, todayStr) {
    var cutoff = U.addDays(todayStr, -365);
    var s = 0;
    plans.forEach(function (p) {
      if (!p.isImplemented) return;
      var d = dividendAnchor(p);
      if (!d) return;
      if (d > cutoff && d <= todayStr) s += perSharePretax(p);
    });
    return s;
  }

  /**
   * 财年口径「年均每股分红」——预测年度分红 / 成本息率 / 市值息率三者共用。
   *
   * basis（口径配置，来自 symbols[sym].dividendBasis）：
   *   { type:'years',  value:N }   近 N 个完整财年（默认 {years,1}，即「最近一财年」）
   *   { type:'custom', startYear } 自选起始财年
   *
   * 「近 N 年」的 N 是【财年个数】，不是自然日窗口：
   *   最近财年 Y = 已实施方案中含年报(12-31)的最大报告年度
   *   分母 = min(N, 可用财年数)，可用财年数 = Y − 最早报告年度 + 1
   *   分子 = 报告年度 ∈ [Y−分母+1, Y] 的全部已实施方案每股税前分红（含各财年中报）
   *
   * 降级链：财年 → 无年报则近12个月(ttm) → 再无则单条(single) → 无方案(none)
   * N=1 时与旧版「取最近一个含年报的报告年度合计」完全等价。
   */
  function annualBasePerShare(plans, basis) {
    var impl = plans.filter(function (p) { return p.isImplemented; });
    if (!impl.length) return { perShare: 0, total: 0, basis: 'none', year: null, years: 0 };

    // 基金分红不定期（可能一年多次、也可能不分配），按近 12 个月年化更贴近事实
    if (impl[0].source === 'fund') {
      var ft = trailingPerShare(plans, U.today());
      return { perShare: ft, total: ft, basis: 'fundTtm', year: null, years: 0 };
    }

    var allYears = impl.map(reportYear).filter(function (y) { return y; });
    var annualYears = impl.filter(isAnnualReport).map(reportYear).filter(function (y) { return y; });

    if (annualYears.length) {
      var latestYear = Math.max.apply(null, annualYears);
      var earliestYear = Math.min.apply(null, allYears);
      var available = Math.max(1, latestYear - earliestYear + 1);

      var b = basis || { type: 'years', value: 1 };
      var requested;
      if (b.type === 'custom' && b.startYear) {
        requested = Math.max(1, latestYear - U.num(b.startYear) + 1);
      } else {
        requested = Math.max(1, Math.round(U.n0(b.value) || 1));
      }

      var use = Math.min(requested, available);
      var fromYear = latestYear - use + 1;
      var grp = impl.filter(function (p) {
        var y = reportYear(p);
        return y >= fromYear && y <= latestYear;
      });
      var total = U.sum(grp, perSharePretax);

      return {
        perShare: total / use,
        total: total,
        basis: 'fiscal',
        year: latestYear,
        fromYear: fromYear,
        years: use,
        requested: requested,
        available: available,
        capped: use < requested,          // 数据不足 N 年，已按可用年数计算
      };
    }

    var ttm = trailingPerShare(plans, U.today());
    if (ttm > 0) return { perShare: ttm, total: ttm, basis: 'ttm', year: null, years: 0 };

    var latest = impl.slice().sort(function (a, b2) { return a.reportDate < b2.reportDate ? 1 : -1; })[0];
    var single = perSharePretax(latest);
    return { perShare: single, total: single, basis: 'single', year: reportYear(latest), years: 0 };
  }

  /* ---------------- 股息率曲线（财年口径） ----------------
   * 口径：某时点的股息率 = 该财年派现总额 ÷ 当时总市值 × 100%
   *                       = 该财年每股派现合计 ÷ 当时股价 × 100%
   * （总股本在分子分母中约掉；历史时点的总股本拿不到，且这与东财 DIVIDENT_RATIO 同一口径。）
   *
   * 与 annualBasePerShare 的两个关键差别：
   *   1) 分子**含已公告的预案**（不过滤 isImplemented）—— 因为生效时点选的是「预案公告日」，
   *      若只算已实施，公告日切换就形同虚设（要等 2~3 个月后的除权除息日才生效）。
   *   2) 只认**含年报**的财年：「上一年财报」指年报，光有中报不足以为一个财年定调。
   */

  /**
   * 财年分子表。返回 [{ year, perShare, effectiveFrom, annualPlans }]，按 year 升序。
   *   year          报告年度
   *   perShare      该财年【全部】方案的每股税前派现合计（含中报/季报，含预案）
   *   effectiveFrom 该财年的生效日 = 年报方案的预案公告日
   *                 （退化为 noticeDate → equityRecordDate → exDividendDate；全缺则不入选）
   *   annualPlans   该财年的年报方案条数
   */
  function yieldFiscalSteps(plans) {
    var byYear = {};
    (plans || []).forEach(function (p) {
      if (!p) return;
      var y = reportYear(p);
      if (!y) return;
      if (!byYear[y]) byYear[y] = { sum: 0, annual: [] };
      byYear[y].sum += perSharePretax(p);
      if (isAnnualReport(p)) byYear[y].annual.push(p);
    });

    var out = [];
    Object.keys(byYear).forEach(function (key) {
      var y = U.num(key);
      var g = byYear[key];
      if (!y || !g.annual.length) return;          // 没有年报的财年不作候选
      if (!(g.sum > 0)) return;                    // 该财年一分钱都没派 → 不参与（股息率 0 无意义）
      /* 生效日取该财年最早一条年报方案的公告日；缺则沿退化链往下找 */
      var best = null;
      g.annual.forEach(function (p) {
        var d = p.planNoticeDate || p.noticeDate || p.equityRecordDate || p.exDividendDate || null;
        if (!d) return;
        if (!best || d < best) best = d;
      });
      if (!best) return;                           // 连公告日都拿不到 → 无法定生效时点
      out.push({ year: y, perShare: g.sum, effectiveFrom: best, annualPlans: g.annual.length });
    });

    out.sort(function (a, b) { return a.year - b.year; });
    return out;
  }

  /**
   * 股息率时间序列。
   * @param plans  该标的的全部 DividendPlan（含预案）
   * @param closes [['YYYY-MM-DD', close], ...] 升序（不复权收盘价）
   * @return [{ date, y, year }] —— y 为百分比；生效日之前的点不产出（曲线自然从第一个财年起）
   *
   * 用双指针推进财年，整体 O(n+m)。分子在一年内是常数，只有到了下一年报预案公告日才跳一次 ——
   * 所以曲线上的「台阶」位置就是各年年报的公告日，这是符合预期且可验证的。
   */
  function dividendYieldSeries(plans, closes) {
    var steps = yieldFiscalSteps(plans);
    if (!steps.length) return [];
    var list = closes || [];
    var out = [];
    var si = -1;                                   // 当前生效的财年下标
    for (var i = 0; i < list.length; i++) {
      var row = list[i];
      if (!row || row.length < 2) continue;
      var d = String(row[0]).slice(0, 10);
      var c = U.num(row[1]);
      if (c === null || !(c > 0)) continue;
      /* 把所有「生效日 <= 当天」的财年都吃掉，最后一个即为当前生效的 */
      while (si + 1 < steps.length && steps[si + 1].effectiveFrom <= d) si++;
      if (si < 0) continue;                        // 还没到任何一个财年的生效日
      var s = steps[si];
      out.push({ date: d, y: s.perShare / c * 100, year: s.year });
    }
    return out;
  }

  /* ---------------- 平均股息率线（分财年） ----------------
   *
   * 为什么必须「分财年」而不是全期一个均值：
   * 一个财年窗口内分子（每股派现合计）是常数，所以「该财年的平均股息率」完全由价格决定，
   * 于是「高于 / 低于均线」才能被读成估值位置的相对高低。
   * 若改用全期单一均值（方案A），均线的高/低于就被分子档位锁死 ——
   * 实测中远海控 2022-01-01 起 1142 个交易日里，只有 FY2022 那 241 天高于全期均值、
   * 其余 901 天恒为「低于」，穿越次数仅 2 次，信号等于失效。
   * （对照：分财年口径下同一标的穿越 54 次。）
   */

  /** 平均股息率线的样本起点（用户定：日历年 2022-01-01 起） */
  var YIELD_AVG_FROM = '2022-01-01';
  /** 整年窗口口径的最小样本量：不足则该财年段整段不画。120 个交易日 ≈ 半年。 */
  var YIELD_AVG_MIN_DAYS = 120;

  /**
   * 分财年平均股息率（统计口径，供界面读文案用）。
   *
   * @param plans  该标的的全部 DividendPlan
   * @param closes [['YYYY-MM-DD', close], ...] 升序
   * @return [{ year, perShare, from, to, days, avg, ok }]
   *         avg 为百分比；ok=false 表示样本 < YIELD_AVG_MIN_DAYS（界面据此提示、不绘制）
   *
   * 样本一律从 YIELD_AVG_FROM 起算，所以跨 2022 年初的那个财年只取到后半段
   * （长江电力 FY2020 只剩 77 天 → ok=false → 不画）。
   */
  function yieldYearAverages(plans, closes) {
    var shareOf = {};
    yieldFiscalSteps(plans).forEach(function (s) { shareOf[s.year] = s.perShare; });

    var out = [];
    var cur = null;
    dividendYieldSeries(plans, closes).forEach(function (p) {
      if (p.date < YIELD_AVG_FROM) return;
      /* 财年档沿时间单调递增（steps 按 year 排序、effectiveFrom 随之递增），
         所以按「相邻不同年」切段是安全的，同一年不会分成两段。 */
      if (!cur || cur.year !== p.year) {
        cur = { year: p.year, sum: 0, days: 0, from: p.date, to: p.date };
        out.push(cur);
      }
      cur.sum += p.y; cur.days++; cur.to = p.date;
    });

    out.forEach(function (g) {
      g.avg = g.days ? g.sum / g.days : null;
      g.perShare = shareOf[g.year] === undefined ? null : shareOf[g.year];
      g.ok = g.days >= YIELD_AVG_MIN_DAYS;
    });
    return out;
  }

  /**
   * 平均股息率线（可直接画进图表的点序列，与股息率曲线同轴）。
   *
   * mode='year' 该财年【整段窗口】的均值 → 每财年一条水平线（阶梯）；
   *             样本不足的财年整段不画（避免用半年的样本冒充一年的水平）。
   * mode='cum'  从该财年生效日起【逐日累积】的均值 → 是个爬升的曲线，
   *             无前视偏差（只用当日及之前的样本），所以**不设样本门槛** ——
   *             「样本少所以均值不可信」正是它要如实反映的东西。
   *
   * 两种口径都只在【该财年窗口内】取样本，因此均线的起伏只由价格产生；
   * 差别仅在于「是否用到了本财年后面才发生的价格」。
   *
   * @return [{ date, y, year, enough }] —— y 为百分比
   */
  function yieldAverageSeries(plans, closes, mode) {
    var cum = mode === 'cum';
    var avgOf = {}, okOf = {};
    yieldYearAverages(plans, closes).forEach(function (g) {
      avgOf[g.year] = g.avg; okOf[g.year] = g.ok;
    });

    var out = [];
    var cur = null;
    dividendYieldSeries(plans, closes).forEach(function (p) {
      if (p.date < YIELD_AVG_FROM) return;
      if (!cur || cur.year !== p.year) cur = { year: p.year, sum: 0, days: 0 };
      cur.sum += p.y; cur.days++;
      if (cum) {
        out.push({ date: p.date, y: cur.sum / cur.days, year: p.year, enough: true });
        return;
      }
      if (!okOf[p.year]) return;
      out.push({ date: p.date, y: avgOf[p.year], year: p.year, enough: true });
    });
    return out;
  }

  /** 除权除息日清单（升序、去重），供曲线打散点用 */
  function exDividendDates(plans) {
    var seen = {};
    (plans || []).forEach(function (p) {
      var d = p && p.exDividendDate;
      if (!d) return;
      d = String(d).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
      seen[d] = 1;
    });
    return Object.keys(seen).sort();
  }

  /* ---------------- 持仓成本 ---------------- */

  function cmpTx(a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    var ca = a.createdAt || '', cb = b.createdAt || '';
    if (ca !== cb) return ca < cb ? -1 : 1;
    return (a.txId || '') < (b.txId || '') ? -1 : 1;
  }

  /**
   * 持仓核心。costMethod：
   *   'weighted'        加权平均（默认，原有行为，卖出产生已实现盈亏）
   *   'diluted'         摊薄成本 = (买入总额 − 卖出总额) ÷ 持股数
   *   'dividendDiluted' 分红摊薄 = (净投入 − 累计已收分红) ÷ 持股数
   * 摊薄类口径下「已实现盈亏」无意义，统一置 0（由上层隐藏该指标）。
   * receivedTotal 仅在 costMethod='dividendDiluted' 时参与计算。
   */
  /**
   * 默认成本口径：**分红摊薄** —— 分红到账后持仓成本自动下降。
   * 与 model.DEFAULT_COST_METHOD 保持一致；这里再兜一层，
   * 是为了让「没有显式写过 costMethod 的老记录」也按分红摊薄算（否则分红不会摊薄成本）。
   */
  function defaultCostMethod() {
    return (XJ.model && XJ.model.DEFAULT_COST_METHOD) || 'dividendDiluted';
  }

  function position(txs, upToDate, costMethod, receivedTotal) {
    var list = txs.slice().sort(cmpTx);
    var qty = 0, costBasis = 0, avg = 0, realized = 0;
    var buyAmount = 0, sellAmount = 0, buyFees = 0, sellFees = 0, count = 0;
    var adjustAmount = 0;

    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (upToDate && t.date > upToDate) break;
      count++;

      /* 「成本调整」：只加减成本基础，不改变股数。
         股数为 0（已清仓）时忽略，否则会凭空造出一个金额而无对应股数。 */
      if (t.action === 'ADJUST') {
        if (qty > 0) {
          var a = U.n0(t.amount);
          costBasis += a;
          adjustAmount += a;
          avg = qty > 0 ? costBasis / qty : 0;
        }
        continue;
      }

      var q = U.n0(t.quantity), p = U.n0(t.price), f = U.n0(t.fee);
      if (t.action === 'BUY') {
        costBasis += q * p + f;
        qty += q;
        buyAmount += q * p;
        buyFees += f;
        avg = qty > 0 ? costBasis / qty : 0;
      } else {
        var sq = Math.min(q, qty);
        realized += sq * (p - avg) - f;
        costBasis -= sq * avg;
        qty -= sq;
        sellAmount += sq * p;
        sellFees += f;
        if (qty <= 1e-9) { qty = 0; costBasis = 0; avg = 0; }
        else avg = costBasis / qty;
      }
    }

    /* 净投入 = 买入总额 − 卖出净得 + 成本调整（调整是对真实投入的修正，理应计入） */
    var net = (buyAmount + buyFees) - (sellAmount - sellFees) + adjustAmount;

    var method = costMethod || defaultCostMethod();
    if (method !== 'weighted' && qty > 0) {
      var basis = net;
      if (method === 'dividendDiluted') basis -= U.n0(receivedTotal);
      costBasis = basis;
      avg = basis / qty;
      realized = 0;                       // 摊薄口径下不谈已实现盈亏
    }

    return {
      qty: qty, avgCost: avg, costBasis: costBasis, realized: realized,
      buyAmount: buyAmount, sellAmount: sellAmount, adjustAmount: adjustAmount,
      buyFees: buyFees, sellFees: sellFees, fees: buyFees + sellFees,
      netInvested: net, count: count, costMethod: method,
    };
  }

  function txOf(state, accountId, symbol) {
    return state.transactions.filter(function (t) {
      if (symbol && t.symbol !== symbol) return false;
      if (accountId && accountId !== ALL && t.accountId !== accountId) return false;
      return true;
    });
  }

  /* ---------------- 持仓明细 ---------------- */

  function holdings(state, accountId) {
    var acc = accountId || ALL;
    var bySym = {};
    state.transactions.forEach(function (t) {
      if (acc !== ALL && t.accountId !== acc) return;
      (bySym[t.symbol] || (bySym[t.symbol] = [])).push(t);
    });

    /* 该账户下每只标的的累计已收分红（分红摊薄成本与回本进度都要用） */
    var receivedBySym = {};
    state.received.forEach(function (r) {
      if (acc !== ALL && r.accountId !== acc) return;
      receivedBySym[r.symbol] = (receivedBySym[r.symbol] || 0) + U.n0(r.amount);
    });

    var today = U.today();
    var rows = [];

    Object.keys(bySym).forEach(function (sym) {
      var txs = bySym[sym];
      var meta = state.symbols[sym] || {};
      var costMethod = meta.costMethod || defaultCostMethod();
      var recvTotal = receivedBySym[sym] || 0;

      var pos = position(txs, null, costMethod, recvTotal);
      if (pos.qty <= 0) return;                       // 已清仓不进持仓列表

      var q = state.quoteCache[sym] || null;
      var price = q ? U.num(q.price) : null;
      var name = (q && q.name) || meta.name || XJ.model.codeOf(sym);

      var plans = plansOf(state, sym);
      var ttm = trailingPerShare(plans, today);
      var annual = annualBasePerShare(plans, meta.dividendBasis);

      var marketValue = price ? pos.qty * price : null;
      var costValue = pos.qty * pos.avgCost;           // 摊薄口径下可能为负
      var unrealized = price ? marketValue - costValue : null;
      var unrealizedPct = (price && costValue > 0) ? unrealized / costValue * 100 : null;

      /* 股价息率：与预测分红同用财年口径；缺财年方案时退回 TTM */
      var yldPerShare = annual.perShare > 0 ? annual.perShare : ttm;
      var dividendYield = (price && price > 0 && yldPerShare > 0) ? yldPerShare / price * 100 : null;

      var predictedDividend = pos.qty * annual.perShare;

      /* 成本息率：成本为负（已回本）时不显示百分比 */
      var costYield = costValue > 0 ? predictedDividend / costValue * 100 : null;
      var marketYield = marketValue > 0 ? predictedDividend / marketValue * 100 : null;

      /* 分红回本进度 */
      var netInvested = pos.netInvested;
      var remaining = Math.max(0, netInvested - recvTotal);
      var recoveryPct = (meta.costRecovered || netInvested <= 0)
        ? 100
        : U.clamp(recvTotal / netInvested * 100, 0, 100);
      var expectedYears = (remaining > 0 && predictedDividend > 0)
        ? remaining / predictedDividend : (remaining > 0 ? null : 0);

      /* 持股天数：首笔买入日起算 */
      var buys = txs.filter(function (t) { return t.action === 'BUY' && t.date; })
        .map(function (t) { return t.date; }).sort();
      var since = buys.length ? buys[0] : null;
      var holdDays = since ? Math.max(0, U.daysBetween(since, today) || 0) : 0;

      /* ---- 人民币口径的「金额」字段 ----
         应用的主口径是人民币：首页总市值、资产走势曲线、每日快照用的都是折算后的值。
         这里把金额类字段一并折好，避免「有的地方折、有的地方不折」——
         曾经 summary() 把港币金额当人民币直接相加，而曲线是折过的，
         结果同一个组合出现两个总市值（实测 40,000 vs 37,600）。
         ★ **原币字段全部保留不动**：buildSnapshot / netWorthAdjust / alignMinute 里
         已经各自做过折算，改这里会导致重复折算；而且 position() 的分红摊薄要用原币的分红合计。
         ★ **每股数字（price / avgCost / prevClose）不折**：港股的价格本来就是港元，
         折了反而与行情软件对不上。 */
      var rate = fxRate(XJ.market.currency(sym), (state.settings && state.settings.fx) || {});
      var marketValueCny = marketValue === null ? null : marketValue * rate;
      var costValueCny = costValue * rate;
      var unrealizedCny = marketValue === null ? null : marketValueCny - costValueCny;

      rows.push({
        symbol: sym,
        code: XJ.model.codeOf(sym),
        market: XJ.model.marketOf(sym),
        assetType: XJ.market.assetType(sym),
        kindLabel: XJ.market.kind(sym),
        currency: XJ.market.currency(sym),
        domain: (state.symbols[sym] && state.symbols[sym].domain) || null,
        /* 已解析出的公司图标 URL（由同步管线多源解析后写入 symbols[sym].logoUrl）；
           为空时视图回退到中文简称头像 */
        logoUrl: (state.symbols[sym] && state.symbols[sym].logoUrl) || null,
        adjustAmount: pos.adjustAmount,
        curSymbol: XJ.market.curSymbol(sym),
        name: name,
        qty: pos.qty,
        avgCost: pos.avgCost,
        costValue: costValue,
        costMethod: costMethod,
        costRecovered: !!meta.costRecovered,
        netInvested: netInvested,
        buyAmount: pos.buyAmount,
        sellAmount: pos.sellAmount,
        price: price,
        prevClose: q ? U.num(q.prevClose) : null,
        changePct: q ? U.num(q.changePct) : null,
        quoteTime: q ? q.quoteTime : null,
        marketValue: marketValue,
        unrealized: unrealized,
        unrealizedPct: unrealizedPct,
        realized: pos.realized,
        /* 人民币口径（汇总与界面显示 ¥ 时一律用这几个；原币字段供内部折算复用） */
        fxRate: rate,
        marketValueCny: marketValueCny,
        costValueCny: costValueCny,
        unrealizedCny: unrealizedCny,
        realizedCny: pos.realized * rate,
        netInvestedCny: netInvested * rate,
        receivedTotalCny: recvTotal * rate,
        predictedDividendCny: predictedDividend * rate,
        perShareTTM: ttm,
        dividendYield: dividendYield,
        annualPerShare: annual.perShare,
        annualBasis: annual.basis,
        annualBasisYear: annual.year,
        annualBasisYears: annual.years,
        annualBasisDetail: annual,
        predictedDividend: predictedDividend,
        yieldOnCost: costYield,
        costYield: costYield,
        marketYield: marketYield,
        receivedTotal: recvTotal,
        remaining: remaining,
        /* 人民币口径的「剩余待回收」= 净投入 − 已收分红（与上面同源，只是换算单位） */
        remainingCny: Math.max(0, netInvested * rate - recvTotal * rate),
        recoveryPct: recoveryPct,
        expectedYears: expectedYears,
        holdDays: holdDays,
        holdSince: since,
        planCount: plans.length,
        implementedCount: plans.filter(function (p) { return p.isImplemented; }).length,
        hasPlans: plans.length > 0,
      });
    });

    rows.sort(function (a, b) {
      return (b.predictedDividend || 0) - (a.predictedDividend || 0);
    });
    return rows;
  }

  /* ---------------- 组合汇总 ---------------- */

  function summary(state, accountId) {
    var acc = accountId || ALL;
    var hs = holdings(state, acc);
    var today = U.today();
    var curYear = U.yearOf(today);

    var totalMarketValue = 0, totalCost = 0, totalPredicted = 0,
      totalRealized = 0, missingQuote = 0;
    var totalTodayPnl = 0, totalPrevMv = 0;

    /* ★ 一律用人民币口径的字段（holdings 里已按各标的币种折好）。
       早先这里直接累加 h.marketValue / h.costValue（原币），
       持有港股/美股的组合会把外币金额当人民币相加，而资产走势曲线与每日快照是折过的
       → 同一个组合、同一个界面出现两个总市值。 */
    hs.forEach(function (h) {
      totalCost += h.costValueCny;
      totalPredicted += h.predictedDividendCny;
      totalRealized += h.realizedCny;
      if (h.marketValue === null) missingQuote++;
      else totalMarketValue += h.marketValueCny;

      /* 当日参考盈亏 = Σ 持股数 ×（现价 − 昨收）× 汇率（跨币种已折算）。
         缺昨收的标的（新加的、行情还没回）直接跳过 —— 绝不拿 0 当昨收，那会算出 +∞。 */
      var pc = U.num(h.prevClose), px = U.num(h.price);
      if (pc !== null && pc > 0 && px !== null && h.qty > 0) {
        var fr = U.n0(h.fxRate) || 1;
        totalTodayPnl += (px - pc) * h.qty * fr;
        totalPrevMv += pc * h.qty * fr;
      }
    });

    /* 分红同样按「该标的的币种」折算（港币分红不能当人民币加） */
    var fxNow = (state.settings && state.settings.fx) || {};
    var recvCny = function (r) {
      return U.n0(r.amount) * fxRate(XJ.market.currency(r.symbol), fxNow);
    };

    var receivedThisYear = U.sum(state.received.filter(function (r) {
      if (acc !== ALL && r.accountId !== acc) return false;
      return (r.year || U.yearOf(r.exDividendDate)) === curYear;
    }), recvCny);

    var receivedTotal = U.sum(state.received.filter(function (r) {
      return acc === ALL || r.accountId === acc;
    }), recvCny);

    var compositeYield = totalMarketValue > 0 ? totalPredicted / totalMarketValue * 100 : null;

    var ups = upcomingPayouts(state, acc, today);
    var nextPayout = ups.length ? ups[0] : null;

    /* 净投入（摊薄口径的累计投入） */
    var totalNetInvested = 0;
    /* 单只平均市值、按资产类型分组（人民币口径） */
    var byAssetType = {};
    hs.forEach(function (h) {
      totalNetInvested += h.netInvestedCny;
      var k = h.assetType || 'stock';
      var g = byAssetType[k] || (byAssetType[k] = { key: k, label: h.kindLabel, count: 0, marketValue: 0, predicted: 0 });
      g.count++;
      g.marketValue += (h.marketValueCny || 0);
      g.predicted += (h.predictedDividendCny || 0);
    });
    var assetTypeList = Object.keys(byAssetType)
      .map(function (k) { return byAssetType[k]; })
      .sort(function (a, b) { return b.marketValue - a.marketValue; });

    return {
      holdings: hs,
      count: hs.length,
      totalMarketValue: totalMarketValue,
      totalCost: totalCost,
      totalNetInvested: totalNetInvested,
      totalUnrealized: totalMarketValue - totalCost,
      totalUnrealizedPct: totalCost > 0 ? (totalMarketValue - totalCost) / totalCost * 100 : null,
      totalPredicted: totalPredicted,
      totalRealized: totalRealized,
      receivedThisYear: receivedThisYear,
      receivedTotal: receivedTotal,
      compositeYield: compositeYield,
      /* 成本息率：预测年度分红 ÷ 总成本（成本非正时不显示） */
      costYield: totalCost > 0 ? totalPredicted / totalCost * 100 : null,
      /* 市值息率：预测年度分红 ÷ 总市值 */
      marketYield: compositeYield,
      /* 月均预测分红：预测年度分红 ÷ 12 */
      monthlyDividend: totalPredicted / 12,
      avgMarketValue: hs.length ? totalMarketValue / hs.length : 0,
      byAssetType: assetTypeList,
      missingQuote: missingQuote,
      nextPayout: nextPayout,
      upcomingCount: ups.length,
      /* 当日参考盈亏：现价相对【昨收】的浮动，人民币口径；不含当日已到账分红。
         todayPnlPct = ÷ 昨收市值（= 组合当日涨跌幅），分母 ≤ 0 时为 null。 */
      todayPnl: Math.round(totalTodayPnl * 100) / 100,
      todayPnlPct: totalPrevMv > 0 ? Math.round(totalTodayPnl / totalPrevMv * 10000) / 100 : null,
    };
  }

  /* ---------------- 分红日历事件 ---------------- */

  /**
   * 生成日历事件（只针对当前账户持有的标的）。
   * 派息日字段缺失，统一按「除权除息日 T+1」推算并标注为【预计到账】。
   */
  function calendarEvents(state, accountId, fromDate, toDate) {
    var acc = accountId || ALL;
    var hs = holdings(state, acc);
    var out = [];
    var today = U.today();

    hs.forEach(function (h) {
      var txs = txOf(state, acc, h.symbol);
      var plans = plansOf(state, h.symbol);
      plans.forEach(function (p) {
        var hasDate = p.equityRecordDate || p.exDividendDate;
        if (!hasDate) return;

        var posAtReg = position(txs, p.equityRecordDate || p.exDividendDate);
        var qty = posAtReg.qty > 0 ? posAtReg.qty : h.qty;
        var ps = perSharePretax(p);
        var amount = qty * ps;

        var pay = payoutInfo(p);
        var seq = [];
        if (p.equityRecordDate) seq.push({ type: 'register', date: p.equityRecordDate, label: '股权登记日', amount: null });
        if (p.exDividendDate) seq.push({ type: 'exdiv', date: p.exDividendDate, label: '除权除息日', amount: null });
        if (pay.date) seq.push({
          type: 'payout', date: pay.date, amount: amount,
          // 决策 D5：统一用「派息日」；A 股为推算值，故标注「预计」
          label: pay.exact ? '派息日' : '预计派息日',
        });

        seq.forEach(function (e) {
          if (fromDate && e.date < fromDate) return;
          if (toDate && e.date > toDate) return;
          out.push({
            date: e.date,
            type: e.type,
            label: e.label,
            symbol: h.symbol,
            name: h.name,
            code: h.code,
            planId: p.planId,
            reportDate: p.reportDate,
            reportType: p.reportType,
            perShare: ps,
            perShareProfile: p.implPlanProfile,
            qty: qty,
            amount: e.amount,
            assignProgress: p.assignProgress,
            isImplemented: p.isImplemented,
            // 只有「到账」事件可能是推算值；登记日/除权日是数据源给定的事实
            isEstimate: e.type === 'payout' ? !pay.exact : false,
            isEstimatePayout: !pay.exact,
            status: e.date > today ? 'UPCOMING' : e.date === today ? 'TODAY' : 'DONE',
          });
        });
      });
    });

    out.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (b.amount || 0) - (a.amount || 0);
    });
    return out;
  }

  /** 待收分红（派息日在今天之后），按日期升序 */
  function upcomingPayouts(state, accountId, fromDate) {
    var evs = calendarEvents(state, accountId, fromDate || U.today(), null);
    return evs.filter(function (e) { return e.type === 'payout'; });
  }

  /** 某月的日历数据：格子事件 + 本月待收统计 */
  function monthView(state, accountId, year, month) {
    var ym = year + '-' + U.pad2(month);
    var from = ym + '-01';
    var to = ym + '-' + U.pad2(new Date(year, month, 0).getDate());
    var evs = calendarEvents(state, accountId, from, to);

    var byDate = {};
    evs.forEach(function (e) { (byDate[e.date] || (byDate[e.date] = [])).push(e); });

    var today = U.today();
    var pending = evs.filter(function (e) { return e.type === 'payout' && e.date >= today; });
    var monthTotal = U.sum(pending, function (e) { return e.amount; });
    var receivedInMonth = U.sum(evs.filter(function (e) { return e.type === 'payout' && e.date < today; }),
      function (e) { return e.amount; });

    return {
      ym: ym, year: year, month: month, from: from, to: to,
      events: evs, byDate: byDate,
      pendingCount: pending.length, pendingTotal: monthTotal, receivedTotal: receivedInMonth,
    };
  }

  /* ---------------- 息覆生活 ---------------- */

  function coverage(annualDividend, expenses, assumedYieldPct) {
    var ay = assumedYieldPct === undefined || assumedYieldPct === null ? 7 : U.n0(assumedYieldPct);
    /* 2026-10-05：分红先填【生存支出】、生存全亮后才流向【品质支出】；
       类内仍按金额从便宜到贵（同一笔钱点亮更多项的最优点亮顺序）。 */
    var CAT_ORDER = { essential: 0, quality: 1 };
    var items = expenses
      .filter(function (e) { return e.enabled; })
      .map(function (e) {
        return {
          expenseId: e.expenseId, key: e.key, label: e.label,
          category: e.category === 'quality' ? 'quality' : 'essential',
          monthlyAmount: U.n0(e.monthlyAmount),
          annualAmount: U.n0(e.monthlyAmount) * 12,
        };
      })
      .sort(function (a, b) {
        var ca = CAT_ORDER[a.category] || 0, cb = CAT_ORDER[b.category] || 0;
        if (ca !== cb) return ca - cb;
        return a.annualAmount - b.annualAmount;
      });

    var div = U.n0(annualDividend);
    var running = 0, lit = 0;

    var out = items.map(function (it) {
      var need = running + it.annualAmount;
      if (it.annualAmount > 0 && need <= div) {
        running = need; lit++;
        return Object.assign({}, it, { lit: true, progress: 100, remaining: 0, covered: it.annualAmount });
      }
      if (it.annualAmount === 0) {
        lit++;
        return Object.assign({}, it, { lit: true, progress: 100, remaining: 0, covered: 0 });
      }
      var avail = Math.max(0, div - running);
      /* ★ 部分覆盖也要把额度占掉：剩余分红一旦被这一项吃掉，后面任何项都不该再点亮。
         旧实现只在「整项点亮」时推进 running —— 按金额升序时不显形（后面的项只会更贵），
         改成「先生存后品质」后顺序不再单调，会出现「生存项半覆盖 + 便宜品质项仍点亮」
         的双重计入。这里统一占额，与独立复算逐位对齐。 */
      running += avail;
      return Object.assign({}, it, {
        lit: false,
        progress: avail / it.annualAmount * 100,
        remaining: it.annualAmount - avail,
        covered: avail,
      });
    });

    var totalAnnual = U.sum(items, function (x) { return x.annualAmount; });
    var nextItem = null;
    for (var i = 0; i < out.length; i++) { if (!out[i].lit) { nextItem = out[i]; break; } }
    var needMore = nextItem ? nextItem.remaining : 0;
    var addCapital = (needMore > 0 && ay > 0) ? needMore / (ay / 100) : 0;

    /* 两大类聚合（生存 / 品质）：分红先填生存、生存全亮后才流到品质，
       所以生存未满时品质组的 coveredAnnual 必然是 0（瀑布在类间不回头）。 */
    var groups = { essential: catGroup('essential'), quality: catGroup('quality') };
    function catGroup(cat) {
      var g = { category: cat, count: 0, litCount: 0, monthlyAmount: 0,
        totalAnnual: 0, coveredAnnual: 0, remaining: 0, progress: 0 };
      out.forEach(function (it) {
        if (it.category !== cat) return;
        g.count++;
        if (it.lit) g.litCount++;
        g.totalAnnual += it.annualAmount;
        g.monthlyAmount += it.monthlyAmount;
        g.coveredAnnual += it.covered || 0;
      });
      g.remaining = Math.max(0, g.totalAnnual - g.coveredAnnual);
      g.progress = g.totalAnnual > 0 ? U.clamp(g.coveredAnnual / g.totalAnnual * 100, 0, 100) : 0;
      return g;
    }

    return {
      items: out,
      groups: groups,
      litCount: lit,
      totalCount: items.length,
      coveredAnnual: running,
      totalAnnual: totalAnnual,
      annualDividend: div,
      overallProgress: totalAnnual > 0 ? U.clamp(div / totalAnnual * 100, 0, 100) : 0,
      nextItem: nextItem,
      needMore: needMore,
      addCapital: addCapital,
      assumedYieldPct: ay,
    };
  }

  /** 星级成长之路：按覆盖率给 5 档 */
  var MILESTONES = [
    { name: '初出茅庐', pct: 0 },
    { name: '小有所成', pct: 20 },
    { name: '渐入佳境', pct: 50 },
    { name: '收息达人', pct: 80 },
    { name: '财务自由', pct: 100 },
  ];
  function milestone(overallProgress) {
    var p = U.n0(overallProgress);
    var idx = 0;
    for (var i = 0; i < MILESTONES.length; i++) if (p >= MILESTONES[i].pct) idx = i;
    return { index: idx, name: MILESTONES[idx].name, all: MILESTONES,
      next: idx < MILESTONES.length - 1 ? MILESTONES[idx + 1] : null };
  }

  /* ---------------- 展望未来 ---------------- */

  /**
   * 逐年复利模拟（口径已与「息记」截图逐位核对）：
   *   yield₀ = 期初年分红 / 期初资产
   *   for k = 1..N:
   *     assets += 月定投 × 12
   *     div_k   = assets × yield₀
   *     assets += div_k × 再投比例
   */
  function projection(cfg, startAssets, baseDividend) {
    var N = Math.max(1, Math.round(U.n0(cfg && cfg.years) || 10));
    var M = U.n0(cfg && cfg.monthlyInvest);
    var r = (cfg && cfg.reinvestRatio !== undefined && cfg.reinvestRatio !== null)
      ? U.clamp(U.n0(cfg.reinvestRatio), 0, 1) : 1;

    var start = U.n0(startAssets);
    var div0 = U.n0(baseDividend);
    var yield0 = start > 0 ? div0 / start : 0;

    var assets = start;
    var rows = [];
    var thisYear = new Date().getFullYear();

    for (var k = 1; k <= N; k++) {
      assets += M * 12;
      var div = assets * yield0;
      assets += div * r;
      rows.push({
        year: k,
        calendarYear: thisYear + k,
        dividend: div,
        monthly: div / 12,
        assetsEnd: assets,
        contribution: M * 12,
        reinvest: div * r,
        multiple: div0 > 0 ? div / div0 : null,
      });
    }

    return {
      rows: rows,
      startAssets: start,
      startDividend: div0,
      yieldPct: yield0 * 100,
      endDividend: rows.length ? rows[rows.length - 1].dividend : div0,
      endAssets: rows.length ? rows[rows.length - 1].assetsEnd : start,
      multiple: (div0 > 0 && rows.length) ? rows[rows.length - 1].dividend / div0 : null,
      totalContribution: M * 12 * N,
    };
  }

  /* ---------------- 首页测算带：每年投入 × 股息率 → N 年后月均分红 ----------------
   * 与「展望未来」是**两套不同口径**，故意不共用（各自独立）：
   *   · 展望未来：期初息率 = 组合年分红 ÷ 组合市值，作用于**全部资产**且逐年恒定；
   *   · 本测算：股息率只作用于**新投入的钱**，现有持仓的预测年度分红 P0 保持不变。
   *
   * 设 X = 每年投入（元）、y = 股息率、r = 再投比例（0–1）、P0 = 现有持仓预测年度分红（元）：
   *   A ← 0                         「新钱池」资产（本金 + 历年再投），按 y 生息
   *   for k = 1..N:
   *     A += X                      当年投入（当年即产生整年分红，与 projection 的次序一致）
   *     divNew = A × y
   *     D = P0 + divNew             当年总分红
   *     A += D × r                  年末再投（买同样 y% 的股票，从次年起才计息）
   *   月均 = D ÷ 12
   *
   * 闭式（用于反解与交叉校验）：
   *   令 a = 1 + r·y，B_k =「当年投入后、**年末再投前**」的新钱池，A_k = 年末再投后的池子
   *     B_1 = X,  B_{k+1} = a·B_k + (r·P0 + X),  A_k = a·B_k + r·P0
   *     B_N = (a == 1) ? X + (N−1)(r·P0 + X)
   *                    : X·a^(N−1) + (r·P0 + X)·(a^(N−1) − 1)/(a − 1)
   *     D_N = P0 + y·B_N
   *   ⚠️ 当年分红必须用 **B_N（再投前）**：年末再投的那笔从次年起才计息。
   *      早先把 A_N 当成 B_N 用，导致 r>0 时闭式与递推差一截（自检抓到的真实缺陷）。
   *   r = 0 时 a = 1、B_N = N·X → D_N = P0 + N·X·y ——「不再投」是这套公式的特例，
   *   因此**不存在第二套算法**（不要另写一个"线性版本"）。
   */
  var FORECAST = {
    investMaxYuan: 100000000,   // 每年投入上限：10000 万
    investMaxWan: 10000,
    yieldMaxPct: 30,            // 股息率上限 30%
    yearsMin: 1,
    yearsMax: 50,
    reinvestDefaultPct: 100,
  };

  /** 输入规整：所有测算入口先过这里，保证 X / y / N / r 只在合法范围内 */
  function normalizeForecast(cfg) {
    cfg = cfg || {};
    var invest = U.n0(cfg.annualInvest);
    /* 年数：缺失/null 视为默认 10；显式写 0 则按最小值 1 处理（不能把 0 当成"没填"） */
    var yearsRaw = U.num(cfg.years);
    var years = (yearsRaw === null) ? 10 : Math.round(yearsRaw);
    return {
      annualInvest: invest > 0 ? Math.min(invest, FORECAST.investMaxYuan) : 0,
      yieldPct: U.clamp(U.n0(cfg.yieldPct), 0, FORECAST.yieldMaxPct),
      years: U.clamp(years, FORECAST.yearsMin, FORECAST.yearsMax),
      reinvestPct: U.clamp(U.n0(cfg.reinvestPct), 0, 100),
    };
  }

  /** 逐年递推：返回逐年明细与期末结果（月均是派生量，不单独存储） */
  function forecastRows(cfg, baseDividend) {
    var c = normalizeForecast(cfg);
    var X = c.annualInvest;
    var y = c.yieldPct / 100;
    var r = c.reinvestPct / 100;
    var P0 = Math.max(0, U.n0(baseDividend));

    var A = 0;
    var rows = [];
    var thisYear = new Date().getFullYear();
    for (var k = 1; k <= c.years; k++) {
      A += X;
      var divNew = A * y;
      var D = P0 + divNew;
      A += D * r;
      rows.push({
        year: k,
        calendarYear: thisYear + k,
        invest: X,
        dividend: D,
        monthly: D / 12,
        fromExisting: P0,
        fromNew: divNew,
        reinvest: D * r,
        assetsNew: A,
      });
    }
    var last = rows[rows.length - 1] || null;
    return {
      cfg: c,
      baseDividend: P0,
      rows: rows,
      endDividend: last ? last.dividend : P0,
      monthly: last ? last.monthly : P0 / 12,
      fromExisting: P0,
      fromNew: last ? last.fromNew : 0,
      assetsNew: last ? last.assetsNew : 0,
      totalContribution: X * c.years,
    };
  }

  /**
   * 闭式：第 N 年「当年投入后、年末再投前」的新钱池 B_N。
   * 其余所有闭式（年分红、两个反解）都由它派生，避免各处各写一遍公式。
   */
  function forecastPoolAt(cfg, baseDividend, years) {
    var c = normalizeForecast(cfg);
    var X = c.annualInvest, y = c.yieldPct / 100, r = c.reinvestPct / 100;
    var P0 = Math.max(0, U.n0(baseDividend));
    var N = Math.max(0, Math.round(U.n0(years)));
    if (N <= 0) return 0;
    var a = 1 + r * y;
    var c2 = X + r * P0;
    if (Math.abs(a - 1) < 1e-12) return X + (N - 1) * c2;
    var p = Math.pow(a, N - 1);
    return X * p + c2 * (p - 1) / (a - 1);
  }

  /** 闭式：第 N 年的年分红（与 forecastRows 交叉校验；反解也用它） */
  function forecastDividendAt(cfg, baseDividend, years) {
    var c = normalizeForecast(cfg);
    var P0 = Math.max(0, U.n0(baseDividend));
    return P0 + (c.yieldPct / 100) * forecastPoolAt(cfg, P0, years);
  }

  /**
   * 反解年数：目标月均 T → 最少需要多少年。
   * ok=false 时 reason ∈ 'no-growth' | 'beyond-limit'，调用方**不得改写任何参数**（避免写入假值）。
   */
  function forecastSolveYears(cfg, baseDividend, targetMonthly) {
    var c = normalizeForecast(cfg);
    var X = c.annualInvest, y = c.yieldPct / 100, r = c.reinvestPct / 100;
    var P0 = Math.max(0, U.n0(baseDividend));
    var need = U.n0(targetMonthly) * 12;
    if (need <= P0) return { ok: true, years: 0, exact: 0, reached: true };
    if (y <= 0) return { ok: false, reason: 'no-growth' };
    var B = (need - P0) / y;                     // 目标所需的 B_N
    var a = 1 + r * y;
    var c2 = X + r * P0;
    var b = X * a + r * P0;
    var n;
    if (Math.abs(a - 1) < 1e-12) {
      if (c2 <= 0) return { ok: false, reason: 'no-growth' };   // X=0 且 r=0：新钱池永远是 0
      n = 1 + (B - X) / c2;
    } else {
      if (b <= 0) return { ok: false, reason: 'no-growth' };
      var p = (B * (a - 1) + c2) / b;            // = a^(N−1)
      if (!(p > 0)) return { ok: false, reason: 'no-growth' };
      n = 1 + Math.log(p) / Math.log(a);
    }
    if (!isFinite(n)) return { ok: false, reason: 'no-growth' };
    if (n > FORECAST.yearsMax) return { ok: false, reason: 'beyond-limit', exact: n };
    return { ok: true, years: Math.max(1, Math.ceil(n - 1e-9)), exact: n, reached: false };
  }

  /**
   * 反解每年投入：目标月均 T + 年数 N → 每年需要投多少（元/年）。
   * 对 X 是**一元一次**（B_N 关于 X 线性），所以是闭式解，不需要迭代。
   * ok=false 时 reason ∈ 'no-growth' | 'beyond-limit'，同样不得改写参数。
   */
  function forecastSolveInvest(cfg, baseDividend, targetMonthly) {
    var c = normalizeForecast(cfg);
    var y = c.yieldPct / 100, r = c.reinvestPct / 100, N = c.years;
    var P0 = Math.max(0, U.n0(baseDividend));
    var need = U.n0(targetMonthly) * 12;
    if (need <= P0) return { ok: true, annualInvest: 0, reached: true };
    if (y <= 0) return { ok: false, reason: 'no-growth' };
    var B = (need - P0) / y;
    var a = 1 + r * y;
    var X;
    if (Math.abs(a - 1) < 1e-12) {
      X = (B - r * P0 * (N - 1)) / N;
    } else {
      var p = Math.pow(a, N - 1);
      X = (B - r * P0 * (p - 1) / (a - 1)) / (p + (p - 1) / (a - 1));
    }
    if (!isFinite(X)) return { ok: false, reason: 'no-growth' };
    if (X <= 0) return { ok: true, annualInvest: 0, reached: true };
    if (X > FORECAST.investMaxYuan) return { ok: false, reason: 'beyond-limit', exact: X };
    return { ok: true, annualInvest: X, reached: false };
  }

  /** 月均拆分：总数与「现有持仓」各自取整后**做差**得到「新投入」，
   *  保证 现有持仓 + 新投入 == 总数（不会出现差 1 元的观感矛盾） */
  function forecastSplit(totalMonthly, existingMonthly) {
    var total = Math.round(U.n0(totalMonthly));
    var exist = Math.min(total, Math.max(0, Math.round(U.n0(existingMonthly))));
    return { total: total, existing: exist, fromNew: total - exist };
  }

  /* ==================== FIRE（财务自由试算） ====================
   * 口径总纲（全部新函数共用，不得各写一套）：
   *   被动收入(t) = P0/12 + 新钱池月分红(t)/12
   *   P0 = summary().totalPredicted（现有持仓预测年分红，恒定不随时间变）
   *   新钱完全按 forecastRows 口径：当年投入当年即生息、年末再投次年起息；
   *   forecastRows 是年度递推 → 月度插值统一为「年内线性」：
   *     D(k + i/12) = D_k + (D_{k+1} − D_k) × i/12    （k 完整年，i=0..11）
   *
   * 三档定义（用户拍板）：
   *   Lean    = 被动收入覆盖【生存支出】
   *   Regular = 被动收入覆盖【生存 + 品质支出】
   *   Fat     = 被动收入覆盖【生存 + 200% 品质支出】（即 es + 2q）
   */
  var FIRE = {
    spendMax: 30000, spendStep: 10,     // 花费滑杆（元/月）
    dripMax: 50000, dripStep: 100,      // 每月攒股滑杆（元/月）
    daysPerMonth: 30.44,                // 日↔月显示换算（年平均月长度）
    capitalRule4: 0.04,                 // 4% 法则（仅提示条参考文案用）
    futureMonthsCap: 600,               // 覆盖率外推封顶 50 年
    /* 2026-10-05：去掉「分红再投」滑杆后引擎固定值 = 0（分红全额抵扣花费、不滚入复利）。
       settings.fire.reinvestPct 字段保留只为兼容存量数据，引擎不再读它。 */
    reinvestFixed: 0,
  };

  /** 'YYYY-MM' 加 n 个月（n 可负），返回 'YYYY-MM' */
  function ymAdd(ym, n) {
    var y = parseInt(String(ym).slice(0, 4), 10);
    var m = parseInt(String(ym).slice(5, 7), 10) - 1 + n;
    y += Math.floor(m / 12);
    m = ((m % 12) + 12) % 12;
    return y + '-' + String(m + 1).padStart(2, '0');
  }

  /** 三档月支出分母：enabled 项；es=Σ生存、q=Σ品质；lean=es、regular=es+q、fat=es+2q */
  function tierMonthlySpend(expenses, tier) {
    var es = 0, q = 0;
    (expenses || []).forEach(function (e) {
      if (!e || !e.enabled) return;
      var m = Math.max(0, U.n0(e.monthlyAmount));
      if (e.category === 'quality') q += m; else es += m;
    });
    if (tier === 'lean') return es;
    if (tier === 'fat') return es + 2 * q;
    return es + q;
  }

  /**
   * 提取抵扣：把分红当作可直接支配的现金流，从该档月支出里扣掉。
   *   offset    = P0/12 × (1 − r/100)      持仓月均分红中可自由支配的部分
   *   effective = max(0, base − offset)     抵扣后目标支出（= 按当前口径今天的现金缺口）
   *   covered   = 分红已够覆盖整档支出 → effective = 0，界面判「已达成」
   * ★ 2026-10-05 去掉「分红再投」滑杆：引擎固定 r = FIRE.reinvestFixed = 0
   *   （分红全额抵扣花费、不滚入复利；积累只由「每月攒股」驱动）。
   *   r 参数保留只是为了纯函数单测，生产路径（fireCfg / fireTargets）一律传 0。
   * ★ offset 是【持仓级】的（分红与档位无关），三档只差分母 base。
   */
  function fireEffectiveSpend(cfg) {
    cfg = cfg || {};
    var base = Math.max(0, U.n0(cfg.monthlySpend));
    var divNow = Math.max(0, U.n0(cfg.P0)) / 12;
    var rRaw = (cfg.r === undefined || cfg.r === null) ? cfg.reinvestPct : cfg.r;
    var r = U.clamp(U.n0(rRaw), 0, 100) / 100;
    var offset = divNow * (1 - r);
    return {
      base: base,
      offset: offset,
      effective: Math.max(0, base - offset),
      covered: base > 0 && offset >= base,
    };
  }

  /**
   * 三档 FIRE 目标与 FI 进度。
   * fireNumber = 档位年支出 ÷ 真实持仓息率（口径 yieldBasis：'cost'|'market'）；
   *   ★ 年支出口径 = 档位原始月支出 base × 12（总额口径，2026-10-04 用户拍板）——
   *     抵扣（effective）只做「今天现金缺口」展示，不再拉低 FI number
   *     （旧口径 effective 先减掉 offset、又隐含 fiPrincipal 生出同一笔分红，双重计入）。
   * 息率 ≤ 0 / 成本非正 → fireNumber = null（界面如实显示「暂无法测算」）。
   * capitalAt4 = 真实台账年支出 ÷ 4%（4% 法则参考值；FIRE number 才是主口径）。
   * monthly/annual 保留【真实台账】口径不动，抵扣后的数看 effective/baseMonthly。
   */
  function fireTargets(state, acc, yieldBasis) {
    var s = summary(state, acc);
    var basis = yieldBasis === 'cost' ? 'cost' : 'market';
    var yieldPct = (basis === 'cost') ? s.costYield : s.compositeYield;
    if (yieldPct !== null && !isFinite(yieldPct)) yieldPct = null;
    var r = FIRE.reinvestFixed;      // 固定 0：分红全额抵扣，不再有「再投比例」这个变量
    var tiers = {};
    ['lean', 'regular', 'fat'].forEach(function (t) {
      var monthly = tierMonthlySpend(state.expenses, t);
      var annual = monthly * 12;
      var eff = fireEffectiveSpend({ monthlySpend: monthly, P0: s.totalPredicted, r: r });
      var fireNumber = (yieldPct !== null && yieldPct > 0) ? annual / (yieldPct / 100) : null;
      tiers[t] = {
        monthly: monthly,
        annual: annual,
        offset: eff.offset,
        effective: eff.effective,
        covered: eff.covered,
        fireNumber: fireNumber,
        fiRatio: (fireNumber !== null && fireNumber > 0 && s.totalMarketValue > 0)
          ? s.totalMarketValue / fireNumber * 100 : null,
        capitalAt4: annual / FIRE.capitalRule4,
      };
    });
    return { tiers: tiers, yieldPct: yieldPct, yieldBasis: basis, fiPrincipal: s.totalMarketValue,
      offsetMonthly: Math.max(0, U.n0(s.totalPredicted)) / 12 * (1 - r / 100) };
  }

  /**
   * 归一化某档的试算参数（滑杆值 → 模型入参）。
   * null 语义：monthlySpend=null → 该档真实台账；dripYieldPct=null → 当前组合息率（按口径）。
   */
  function fireCfg(state, acc, tier, fire) {
    fire = fire || (state.settings && state.settings.fire) || {};
    var s = summary(state, acc);
    var basis = fire.yieldBasis === 'cost' ? 'cost' : 'market';
    var baseYieldPct = (basis === 'cost') ? s.costYield : s.compositeYield;
    if (baseYieldPct !== null && !isFinite(baseYieldPct)) baseYieldPct = null;

    var sim = (fire.tierSims && fire.tierSims[tier]) || {};
    var monthlySpend = U.num(sim.monthlySpend);
    if (monthlySpend === null) monthlySpend = tierMonthlySpend(state.expenses, tier);
    monthlySpend = U.clamp(monthlySpend, 0, FIRE.spendMax);

    var drip = U.num(sim.drip);
    if (drip === null) drip = 5000;
    drip = U.clamp(drip, 0, FIRE.dripMax);

    var dripYieldPct = U.num(sim.dripYieldPct);
    if (dripYieldPct === null) dripYieldPct = baseYieldPct;
    dripYieldPct = (dripYieldPct === null) ? 0 : U.clamp(dripYieldPct, 0, FORECAST.yieldMaxPct);

    return {
      P0: Math.max(0, U.n0(s.totalPredicted)),       // 现有持仓预测年分红（恒定）
      X: drip * 12,                                   // 年投入（新钱）
      y: dripYieldPct,                                // 攒股息率 %
      r: FIRE.reinvestFixed,                  // 固定 0（再投滑杆已移除，注释见 FIRE.reinvestFixed）
      monthlySpend: monthlySpend,                     // 目标月支出（当前档模拟值）
      drip: drip,
      dripYieldPct: dripYieldPct,
      baseYieldPct: baseYieldPct,                     // 组合真实息率（口径内），供场景合成
      yieldBasis: basis,
    };
  }

  /** cfg → forecast 家族的 cfg 形状（避免两处形状漂移） */
  function fireAsForecast(cfg) {
    return { annualInvest: cfg.X, yieldPct: cfg.y, years: FORECAST.yearsMax, reinvestPct: cfg.r };
  }

  /**
   * 距离财务自由的时间：解「被动收入(t) ≥ 档位目标月支出」（总额口径）。
   * ★ 目标取 fireEffectiveSpend(cfg).base，不再用 effective（抵扣后）反解：
   *   offset 本来就是分红的一部分——若先从目标里减掉、再拿全额分红去比，
   *   同一笔钱被计入两次（2026-10-04 修复：大卡片「已达成」与「还差 1057」矛盾的根因）。
   *   offset ≥ base（抵扣覆盖整档）→ need=base×12 ≤ P0 自然成立 → reached，
   *   coveredByOffset 如实透出供文案区分「抵扣达成」与「分红达成」。
   * reached（目标 ≤ 当前被动收入）→ months=0；
   * reason ∈ 'no-growth' | 'beyond-limit' 原样透出（调用方不得改参数）。
   */
  function fireTimeline(state, acc, cfg) {
    var eff = fireEffectiveSpend(cfg);
    var target = eff.base;
    var solved = forecastSolveYears(fireAsForecast(cfg), cfg.P0, target);
    var todayYm = U.ymOf(U.today());
    var extra = {
      targetMonthly: target,
      baseMonthly: eff.base,
      offsetMonthly: eff.offset,
      coveredByOffset: eff.covered,
      monthlyPassive0: cfg.P0 / 12,
    };
    if (solved.ok && solved.reached) {
      return Object.assign({ solvable: true, reached: true, exact: 0, months: 0, date: todayYm,
        fromNow: { y: 0, m: 0 } }, extra);
    }
    if (!solved.ok) {
      return Object.assign({ solvable: false, reason: solved.reason, exact: solved.exact || null,
        months: null, date: null, fromNow: null }, extra);
    }
    var months = solved.exact * 12;
    var yy = Math.floor(months / 12);
    var mm = Math.round(months - yy * 12);
    if (mm === 12) { yy += 1; mm = 0; }
    return Object.assign({ solvable: true, reached: false, exact: solved.exact, months: months,
      date: ymAdd(todayYm, Math.round(months)), fromNow: { y: yy, m: mm } }, extra);
  }

  /** 小数月 t（t/12=年）的月被动收入；t=0 → P0/12（与「当前」对齐）。年内线性插值。 */
  function fireMonthlyPassive(cfg, tMonths) {
    var t = Math.max(0, U.n0(tMonths));
    var k = Math.floor(t / 12);
    var i = t - k * 12;
    var fc = fireAsForecast(cfg);
    var Dk = forecastDividendAt(fc, cfg.P0, k);
    var Dk1 = forecastDividendAt(fc, cfg.P0, k + 1);
    return (Dk + (Dk1 - Dk) * (i / 12)) / 12;
  }

  /**
   * 被动收入覆盖率月度序列（图 2 曲线数据）。
   * ★ 历史段自行遍历 received 并按标的币种折 CNY —— stats().byMonth 是原币合计，
   *   跨币种直接加总会把港币当人民币（踩过：summary 的 recvCny 范式，calc.js 同款）。
   * ★ 分母 = fireEffectiveSpend(cfg).base（档位原始目标支出，总额口径）——
   *   与大卡片达成日同源：曲线 ≥100% 的交点就是 fireTimeline 反解出的自由日。
   *   （effective 只在注脚里做「按当前再投习惯今天的现金缺口」展示。）
   * 历史段缺月填 0（连续填月不断线）；未来段从当月起按月外推，≥100% 即停或 600 个月封顶。
   * base ≤ 0（该档没有任何启用支出）→ 全部 pct = null，由视图显示「—」。
   */
  function fireCoverageHistory(state, acc, tier, cfg) {
    var fxNow = (state.settings && state.settings.fx) || {};
    var eff = fireEffectiveSpend(cfg);
    var target = eff.base;
    var byMonth = {};
    state.received.forEach(function (r) {
      if (acc !== ALL && r.accountId !== acc) return;
      var ym = U.ymOf(r.exDividendDate);
      if (!ym) return;
      var cny = U.n0(r.amount) * fxRate(XJ.market.currency(r.symbol), fxNow);
      byMonth[ym] = (byMonth[ym] || 0) + cny;
    });
    var todayYm = U.ymOf(U.today());
    var keys = Object.keys(byMonth).filter(function (k) { return k <= todayYm; }).sort();
    var history = [];
    if (keys.length) {
      var cur = keys[0];
      while (cur <= todayYm) {
        var amt = byMonth[cur] || 0;
        history.push({ date: cur, pct: target > 0 ? amt / target * 100 : null });
        cur = ymAdd(cur, 1);
      }
    }
    var future = [];
    for (var j = 1; j <= FIRE.futureMonthsCap; j++) {
      var mp = fireMonthlyPassive(cfg, j);      // t 单位=月
      var pct = target > 0 ? mp / target * 100 : null;
      future.push({ date: ymAdd(todayYm, j), pct: pct });
      if (pct !== null && pct >= 100) break;
    }
    var currentPct = null;
    if (history.length && history[history.length - 1].pct !== null) {
      currentPct = history[history.length - 1].pct;
    } else if (future.length) {
      currentPct = future[0].pct;
    }
    return { history: history, future: future, currentPct: currentPct, targetMonthly: target,
      baseMonthly: eff.base, offsetMonthly: eff.offset, coveredByOffset: eff.covered };
  }

  /**
   * FI 进度卡数据：FI 本金（持仓市值）÷ 各档 FIRE number。
   * series 复用 marketValueSeries（历史市值曲线，含快照覆盖口径）；
   * 粗算年数不在这里算——视图层拿 gap 与 drip 自行除（要标注「不计入投资收益」）。
   */
  function fireProgress(state, acc, yieldBasis) {
    var priceMap = {};
    Object.keys(state.priceHistory || {}).forEach(function (sym) {
      var ph = state.priceHistory[sym];
      priceMap[sym] = (ph && ph.points) || [];
    });
    var mvs = marketValueSeries(state, acc, priceMap);
    var targets = fireTargets(state, acc, yieldBasis);
    var tiers = {};
    ['lean', 'regular', 'fat'].forEach(function (t) {
      var fn = targets.tiers[t].fireNumber;
      tiers[t] = {
        fireNumber: fn,
        ratio: (fn !== null && fn > 0) ? targets.fiPrincipal / fn * 100 : null,
        gap: (fn !== null) ? Math.max(0, fn - targets.fiPrincipal) : null,
      };
    });
    return { fiPrincipal: targets.fiPrincipal, series: mvs.series, tiers: tiers, missing: mvs.missing };
  }

  /**
   * 场景求解：相对「全默认基准」的自由日变化。
   * 场景参数语义（相对【默认值】而非当前模拟值）：
   *   spendPct    相对该档真实台账支出的 % 变化
   *   dripPct     相对默认攒股 5000 的 % 变化
   *   yieldAdjPct 息率偏移百分点（合成后 clamp 0–30）
   */
  function fireSceneSolve(state, acc, tier, fire, scene) {
    fire = fire || (state.settings && state.settings.fire) || {};
    var base = fireCfg(state, acc, tier, fire);
    var defSpend = tierMonthlySpend(state.expenses, tier);
    var spendPct = U.clamp(U.n0(scene && scene.spendPct), -100, 300);
    var dripPct = U.clamp(U.n0(scene && scene.dripPct), -100, 900);
    var yieldAdj = U.clamp(U.n0(scene && scene.yieldAdjPct), -30, 30);
    var baseY = base.baseYieldPct === null ? 0 : base.baseYieldPct;
    var drip2 = U.clamp(5000 * (1 + dripPct / 100), 0, FIRE.dripMax);
    var y2 = U.clamp(baseY + yieldAdj, 0, FORECAST.yieldMaxPct);
    var cfg2 = {
      P0: base.P0, X: drip2 * 12, y: y2, r: base.r,
      monthlySpend: U.clamp(defSpend * (1 + spendPct / 100), 0, FIRE.spendMax),
      drip: drip2, dripYieldPct: y2, baseYieldPct: base.baseYieldPct, yieldBasis: base.yieldBasis,
    };
    var tScene = fireTimeline(state, acc, cfg2);
    var cleanFire = { yieldBasis: fire.yieldBasis, reinvestPct: fire.reinvestPct,
      tierSims: { lean: {}, regular: {}, fat: {} } };   // 全默认（monthlySpend/dripYieldPct=null, drip=5000）
    // 注：cleanFire 曾带 reinvestPct —— 再投滑杆移除后引擎不再读它，留着无害、删了更干净
    var tBase = fireTimeline(state, acc, fireCfg(state, acc, tier, cleanFire));
    var deltaMonths = (tScene.solvable && tBase.solvable)
      ? tScene.months - tBase.months : null;
    var delta = null;
    if (deltaMonths !== null) {
      var neg = deltaMonths < 0;
      var abs = Math.abs(deltaMonths);
      delta = { earlier: neg, months: deltaMonths, y: Math.floor(abs / 12), m: Math.round(abs - Math.floor(abs / 12) * 12) };
    }
    return { scene: tScene, base: tBase, delta: delta,
      params: { monthlySpend: cfg2.monthlySpend, drip: drip2, dripYieldPct: y2 } };
  }

  /* ---------------- 股息统计 ---------------- */

  function stats(state, accountId) {
    var acc = accountId || ALL;
    var byYear = {}, byMonth = {}, bySymbol = {}, bySymbolYear = {};
    var list = state.received.filter(function (r) { return acc === ALL || r.accountId === acc; });

    list.forEach(function (r) {
      var amt = U.n0(r.amount);
      var y = r.year || U.yearOf(r.exDividendDate);
      var ym = U.ymOf(r.exDividendDate);
      byYear[y] = (byYear[y] || 0) + amt;
      byMonth[ym] = (byMonth[ym] || 0) + amt;
      var b = bySymbol[r.symbol] || (bySymbol[r.symbol] = { symbol: r.symbol, amount: 0, count: 0 });
      b.amount += amt; b.count++;
      var key = r.symbol + '|' + y;
      bySymbolYear[key] = (bySymbolYear[key] || 0) + amt;
    });

    var years = Object.keys(byYear).map(Number).filter(function (n) { return !isNaN(n); }).sort(function (a, b) { return b - a; });
    var months = Object.keys(byMonth).filter(Boolean).sort();

    return {
      byYear: byYear, byMonth: byMonth, bySymbol: bySymbol, bySymbolYear: bySymbolYear,
      years: years, months: months,
      total: U.sum(list, function (r) { return r.amount; }),
      records: list,
      bySymbolList: Object.keys(bySymbol).map(function (k) { return bySymbol[k]; })
        .sort(function (a, b) { return b.amount - a.amount; }),
    };
  }

  /** 单月明细 */
  function monthDetail(state, accountId, ym) {
    return state.received
      .filter(function (r) {
        if (accountId && accountId !== ALL && r.accountId !== accountId) return false;
        return U.ymOf(r.exDividendDate) === ym;
      })
      .sort(function (a, b) { return a.exDividendDate < b.exDividendDate ? -1 : 1; });
  }

  /* ---------------- 派息日弹窗 + 分红汇总 ---------------- */

  /**
   * 某一天的派息事件（「今日分红到账」弹窗用）。
   *
   * 与「分红日历」完全同源（都走 calendarEvents），所以弹窗里的金额、名称、笔数
   * 跟日历上看到的一定一致，不会出现「两处数字打架」。
   * 注意 `estimated`：A 股的派息日在本项目里是**推算值**（= 除权除息日），
   * 界面据此提示「实际到账可能晚 1-2 天」，不要当成确定事实。
   */
  function payoutsOn(state, accountId, date) {
    var d = date || U.today();
    var items = calendarEvents(state, accountId || ALL, d, d)
      .filter(function (e) { return e.type === 'payout'; });
    return {
      date: d,
      items: items,
      count: items.length,
      total: U.sum(items, function (e) { return U.n0(e.amount); }),
      estimated: items.some(function (e) { return e.isEstimate; }),
    };
  }

  /** 分红汇总的时间档位（界面按这个顺序渲染胶囊，calc 与视图共用一份，避免两边写死不同步） */
  var DIVSUM_RANGES = [
    { key: 'year', label: '今年' },
    { key: 'y2', label: '近2年' },
    { key: 'y5', label: '近5年' },
    { key: 'all', label: '历史至今' },
    { key: 'custom', label: '自定义' },
  ];

  /**
   * 把档位解析成具体区间 [beg, end]。
   *
   *   今年   → 本年 01-01 ~ 本年 12-31
   *   近2年  → 去年 01-01 ~ 本年 12-31     （近5年同理，往前 4 年）
   *   历史至今 → 最早一条到账记录 ~ 今天
   *   自定义 → 调用方给的起止
   *
   * 上界刻意取「年末」而不是「今天」：这样「今年」档的**预计到账**才能把本年剩余
   * 还没发的分红算进来。而「历史至今」语义上不含未来，所以它的 end 就是今天
   * —— 于是那一档预计恒为 0，符合预期。
   */
  function dividendRange(state, accountId, range, today) {
    var t = today || U.today();
    var y = U.yearOf(t) || 0;
    var r = range || 'year';
    var type = typeof r === 'string' ? r : (r.type || 'year');

    if (type === 'custom') {
      var b = (r && r.beg) || t, e = (r && r.end) || t;
      return { type: 'custom', beg: b, end: e < b ? b : e };
    }
    if (type === 'all') {
      var acc = accountId || ALL;
      var min = null;
      state.received.forEach(function (x) {
        if (acc !== ALL && x.accountId !== acc) return;
        var d = x.exDividendDate;
        if (!d) return;
        if (!min || d < min) min = d;
      });
      return { type: 'all', beg: min || (y + '-01-01'), end: t };
    }
    var back = type === 'y5' ? 4 : (type === 'y2' ? 1 : 0);
    return { type: type, beg: (y - back) + '-01-01', end: y + '-12-31' };
  }

  /**
   * 分红汇总（按任意时间区间切）。
   *
   * 与 calc.stats 的分工：stats 按自然年/月全量聚合、不支持区间（给旧的「股息统计」区块用）；
   * 这个函数按 [beg, end] 取数，并把两种口径**分开**给：
   *   total        —— 已到账（只可能 ≤ 今天），主数字用它，保证与「我的·分红流水」逐笔对得上
   *   pendingTotal —— 区间内还没到账的预计，界面上单独一行，绝不混进主数字
   */
  function dividendSummary(state, accountId, range, today) {
    var acc = accountId || ALL;
    var t = today || U.today();
    var rg = dividendRange(state, acc, range, t);
    var endCap = rg.end < t ? rg.end : t;          // 已到账的上界还受「今天」约束

    var records = state.received.filter(function (r) {
      if (acc !== ALL && r.accountId !== acc) return false;
      var d = r.exDividendDate;
      return !!d && d >= rg.beg && d <= endCap;
    }).sort(function (a, b) { return a.exDividendDate < b.exDividendDate ? -1 : 1; });

    var bySymbol = {};
    var byYear = {};
    records.forEach(function (r) {
      var g = bySymbol[r.symbol] ||
        (bySymbol[r.symbol] = { symbol: r.symbol, amount: 0, count: 0, records: [] });
      g.amount += U.n0(r.amount);
      g.count++;
      g.records.push(r);
      var y = U.yearOf(r.exDividendDate);
      if (y) byYear[y] = (byYear[y] || 0) + U.n0(r.amount);
    });
    var bySymbolList = Object.keys(bySymbol).map(function (k) { return bySymbol[k]; })
      .sort(function (a, b) { return b.amount - a.amount; });
    /* 年份从新到旧（原「股息统计」的年度汇总就是这个顺序） */
    var years = Object.keys(byYear).map(Number).filter(function (n) { return !isNaN(n); })
      .sort(function (a, b) { return b - a; });

    /* 预计到账：今天之后、区间之内还要发的（「历史至今」档 end = 今天 → 恒空） */
    var pending = [];
    if (rg.end > t) {
      pending = calendarEvents(state, acc, U.addDays(t, 1), rg.end)
        .filter(function (e) { return e.type === 'payout'; });
    }
    var pendBy = {};
    pending.forEach(function (e) {
      var g = pendBy[e.symbol] || (pendBy[e.symbol] = { symbol: e.symbol, amount: 0, count: 0 });
      g.amount += U.n0(e.amount);
      g.count++;
    });

    return {
      range: rg,
      records: records,
      count: records.length,
      total: U.sum(records, function (r) { return U.n0(r.amount); }),
      bySymbolList: bySymbolList,
      byYear: byYear,
      years: years,
      pending: pending,
      pendingCount: pending.length,
      pendingTotal: U.sum(pending, function (e) { return U.n0(e.amount); }),
      pendingList: Object.keys(pendBy).map(function (k) { return pendBy[k]; })
        .sort(function (a, b) { return b.amount - a.amount; }),
      firstDate: records.length ? records[0].exDividendDate : null,
      lastDate: records.length ? records[records.length - 1].exDividendDate : null,
    };
  }

  /**
   * 「这些分红相当于 N 个月<换算对象>」的 N。
   * 月费 ≤ 0 或分红为 0 时返回 null（界面据此隐藏这一行，不显示「相当于 0 个月」）。
   */
  function funEquivalent(total, monthly) {
    var m = U.n0(monthly);
    if (!(m > 0)) return null;
    if (!(U.n0(total) > 0)) return null;
    return Math.floor(U.n0(total) / m);
  }

  /* ---------------- 每日资产快照 ---------------- */

  /**
   * 构建「今天」的资产快照（**人民币口径**）。键 = 本地日期，天然幂等。
   * fx: { HKD, USD } 汇率，缺失时按 1 折算并在快照中记录 null。
   */
  function buildSnapshot(state, accountId, fx) {
    var s = summary(state, accountId);
    if (!s.count) return null;
    var f = fx || (state.settings && state.settings.fx) || {};
    var rate = { CNY: 1, HKD: U.n0(f.HKD) || 1, USD: U.n0(f.USD) || 1 };

    var mv = 0, cost = 0, pred = 0;
    s.holdings.forEach(function (h) {
      var r = rate[h.currency] || 1;
      if (h.marketValue !== null) mv += h.marketValue * r;
      cost += h.costValue * r;
      pred += h.predictedDividend * r;
    });

    var recv = 0;
    state.received.forEach(function (rec) {
      if (accountId && accountId !== ALL && rec.accountId !== accountId) return;
      recv += U.n0(rec.amount) * (rate[XJ.market.currency(rec.symbol)] || 1);
    });

    var r2 = function (v) { return Math.round(v * 100) / 100; };
    return {
      mv: r2(mv), cost: r2(cost), pred: r2(pred), recv: r2(recv),
      fx: (f.HKD || f.USD) ? { HKD: U.num(f.HKD), USD: U.num(f.USD) } : null,
    };
  }

  /** 写入当天快照（同一天覆盖同一条）。返回是否写入成功。 */
  function writeSnapshot(state, accountId, fx) {
    var snap = buildSnapshot(state, accountId, fx);
    if (!snap) return false;
    if (!state.snapshots) state.snapshots = {};
    state.snapshots[U.today()] = snap;
    return true;
  }

  function snapshotDates(state) {
    return state.snapshots ? Object.keys(state.snapshots).sort() : [];
  }

  /** 资产曲线数据点（按快照日期升序）。days = 0 表示全部区间 */
  function snapshotSeries(state, days) {
    var ds = snapshotDates(state);
    if (!ds.length) return [];
    var out = ds.map(function (d) {
      var s = state.snapshots[d] || {};
      return { date: d, mv: U.n0(s.mv), cost: U.n0(s.cost), pred: U.n0(s.pred) };
    });
    if (days > 0) {
      var cutoff = U.addDays(U.today(), -days);
      out = out.filter(function (p) { return p.date >= cutoff; });
    }
    return out;
  }

  /** 与「上次记录」的对比：最新快照 − 前一条快照 */
  function snapshotDelta(state) {
    var ds = snapshotDates(state);
    if (ds.length < 2) return null;
    var cur = state.snapshots[ds[ds.length - 1]];
    var prev = state.snapshots[ds[ds.length - 2]];
    return {
      date: ds[ds.length - 1],
      prevDate: ds[ds.length - 2],
      mv: U.n0(cur.mv) - U.n0(prev.mv),
      cost: U.n0(cur.cost) - U.n0(prev.cost),
      prevMv: U.n0(prev.mv),
      curMv: U.n0(cur.mv),
    };
  }

  /* ---------------- 待除权汇总 ---------------- */

  /**
   * 「已公布分红方案、等待除权日」汇总。
   *
   * 纳入两类方案（这正是「等待除权日」的字面含义）：
   *   ① 除权日已确定且在未来 —— 预计可得金额是确定的
   *   ② 方案已公布但除权日尚未确定（东财 ASSIGN_PROGRESS 多为「董事会决议通过」，
   *      EX_DIVIDEND_DATE 为空）—— 金额按当前持股数预估，除权日待定
   *
   * 早先只统计 ①，于是中国海油 / 中国移动 / 中国石化这类「中报方案已公布、除权日还没公告」的持仓
   * 完全不显示（用户报的缺陷）。②的金额是估算，界面必须如实标注「除权日待定」。
   *
   * 排除：已取消的方案、每股派息 ≤ 0、除权日已过（归到账记录）。
   * ② 额外加 400 天报告期窗口，避免陈年未实施方案常驻这张卡。
   */
  var PENDING_UNDATED_WINDOW = 400;

  function pendingExDiv(state, accountId) {
    var acc = accountId || ALL;
    var hs = holdings(state, acc);
    var today = U.today();
    var bySym = {};

    hs.forEach(function (h) {
      plansOf(state, h.symbol).forEach(function (p) {
        if (/取消/.test(p.assignProgress || '')) return;
        var ps = perSharePretax(p);
        if (ps <= 0) return;

        var hasEx = !!p.exDividendDate;
        var future = hasEx && p.exDividendDate > today;
        var undated = !hasEx;
        if (!future && !undated) return;                  // 除权日已过 → 归到账记录

        if (undated) {
          var rd = p.reportDate ? String(p.reportDate).slice(0, 10) : '';
          if (!rd) return;
          var age = U.daysBetween(rd, today);
          if (age === null || age > PENDING_UNDATED_WINDOW) return;
        }

        var g = bySym[h.symbol] || (bySym[h.symbol] = {
          symbol: h.symbol, name: h.name, code: h.code,
          qty: h.qty, currency: h.currency, assetType: h.assetType, kindLabel: h.kindLabel,
          amount: 0, per10: 0, exDate: null, reportType: '',
          undatedCount: 0, datedAmount: 0, undatedAmount: 0, events: [],
        });
        var amt = h.qty * ps;
        g.amount += amt;
        if (future) {
          g.datedAmount += amt;
          if (!g.exDate || p.exDividendDate < g.exDate) g.exDate = p.exDividendDate;
        } else {
          g.undatedCount++;
          g.undatedAmount += amt;
        }
        if (!g.per10) { g.per10 = U.n0(p.pretaxBonusPer10); g.reportType = p.reportType || ''; }
        g.events.push({
          date: p.exDividendDate || null, perShare: ps, amount: amt,
          name: h.name, symbol: h.symbol, reportType: p.reportType,
          implemented: p.isImplemented, dateKnown: future,
        });
      });
    });

    /* 排序：除权日已确定的在前（按除权日升序），除权日待定的在后（按预估金额降序） */
    var list = Object.keys(bySym).map(function (k) { return bySym[k]; })
      .map(function (g) { g.dateKnown = !!g.exDate; return g; })
      .sort(function (a, b) {
        if (a.dateKnown !== b.dateKnown) return a.dateKnown ? -1 : 1;
        if (a.exDate && b.exDate && a.exDate !== b.exDate) return a.exDate < b.exDate ? -1 : 1;
        return b.amount - a.amount;
      });

    return {
      count: list.length,
      total: U.sum(list, function (x) { return x.amount; }),
      datedCount: list.filter(function (x) { return x.dateKnown; }).length,
      undatedCount: list.filter(function (x) { return !x.dateKnown; }).length,
      datedTotal: U.sum(list.filter(function (x) { return x.dateKnown; }), function (x) { return x.amount; }),
      undatedTotal: U.sum(list.filter(function (x) { return !x.dateKnown; }), function (x) { return x.amount; }),
      items: list,
    };
  }

  /* ---------------- 收息天数 ---------------- */

  /**
   * 收息天数。**含首日**：买入当天即「收息第 1 天」，所以 days = 今天 − 首笔买入日 + 1。
   * 只要存在买入记录就一定有值（≥1），不会出现"已买入却显示 0 天"的情况。
   */
  function statDays(state, accountId) {
    var acc = accountId || ALL;
    var dates = [];
    state.transactions.forEach(function (t) {
      if (acc !== ALL && t.accountId !== acc) return;
      if (t.action === 'BUY' && t.date) dates.push(t.date);
    });
    if (!dates.length) return { days: 0, since: null };
    dates.sort();
    var since = dates[0];
    var diff = U.daysBetween(since, U.today());
    if (diff === null || isNaN(diff)) diff = 0;
    return { days: Math.max(1, Math.round(diff) + 1), since: since };
  }

  /* ---------------- 年度总览 ---------------- */

  /**
   * 某年的分红总览。月均口径：当前年度 ÷ 已过去月份数；历史年度 ÷ 12
   * （已用截图数字验证：3686.54 ÷ 9 = 409.62）
   */
  function annualView(state, accountId, year) {
    var acc = accountId || ALL;
    var today = U.today();
    var curYear = U.yearOf(today);
    var months = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    var records = [];
    var symSet = {};

    state.received.forEach(function (r) {
      if (acc !== ALL && r.accountId !== acc) return;
      var y = r.year || U.yearOf(r.exDividendDate);
      if (y !== year) return;
      var m = U.monthOf(r.exDividendDate);
      var amt = U.n0(r.amount);
      if (m >= 1 && m <= 12) months[m - 1] += amt;
      records.push(r);
      symSet[r.symbol] = true;
    });

    var total = U.sum(months, function (x) { return x; });
    var denom = (year === curYear) ? U.monthOf(today) : 12;
    return {
      year: year,
      total: total,
      count: records.length,
      symbolCount: Object.keys(symSet).length,
      months: months,
      monthlyAvg: denom > 0 ? total / denom : 0,
      denom: denom,
      records: records.sort(function (a, b) {
        return a.exDividendDate < b.exDividendDate ? -1 : 1;
      }),
    };
  }

  /** 可选年份：有到账记录或交易的年份 + 当前年，降序 */
  function availableYears(state, accountId) {
    var acc = accountId || ALL;
    var set = {};
    set[U.yearOf(U.today())] = true;
    state.received.forEach(function (r) {
      if (acc !== ALL && r.accountId !== acc) return;
      var y = r.year || U.yearOf(r.exDividendDate);
      if (y) set[y] = true;
    });
    state.transactions.forEach(function (t) {
      if (acc !== ALL && t.accountId !== acc) return;
      var y = U.yearOf(t.date);
      if (y) set[y] = true;
    });
    return Object.keys(set).map(Number).filter(function (n) { return !isNaN(n); })
      .sort(function (a, b) { return b - a; });
  }

  /* ---------------- 账户分析 ---------------- */

  /**
   * 深度账户分析：盈亏榜、股息率分层、资产类型分布、集中度（HHI）。
   */
  function analytics(state, accountId) {
    var s = summary(state, accountId);
    var hs = s.holdings;

    /* 盈亏榜 */
    var byPnl = hs.slice()
      .filter(function (h) { return h.unrealizedCny !== null; })
      .sort(function (a, b) { return b.unrealizedCny - a.unrealizedCny; });

    /* 股息率分层 */
    var buckets = [
      { key: 'lt2', label: '2% 以下', min: 0, max: 2, count: 0, marketValue: 0, stocks: [] },
      { key: '2to4', label: '2%–4%', min: 2, max: 4, count: 0, marketValue: 0, stocks: [] },
      { key: '4to6', label: '4%–6%', min: 4, max: 6, count: 0, marketValue: 0, stocks: [] },
      { key: '6to8', label: '6%–8%', min: 6, max: 8, count: 0, marketValue: 0, stocks: [] },
      { key: 'gt8', label: '8% 以上', min: 8, max: Infinity, count: 0, marketValue: 0, stocks: [] },
      { key: 'na', label: '暂无分红', min: null, max: null, count: 0, marketValue: 0, stocks: [] },
    ];
    hs.forEach(function (h) {
      var y = h.dividendYield;
      var b = buckets[buckets.length - 1];
      if (y !== null && y !== undefined && !isNaN(y)) {
        for (var i = 0; i < buckets.length - 1; i++) {
          if (y >= buckets[i].min && y < buckets[i].max) { b = buckets[i]; break; }
        }
        if (y >= buckets[buckets.length - 2].min) b = buckets[buckets.length - 2];
      }
      b.count++;
      b.marketValue += (h.marketValueCny || 0);
      b.stocks.push({
        symbol: h.symbol, name: h.name, marketValue: h.marketValueCny || 0,
        dividendYield: (y === null || y === undefined || isNaN(y)) ? null : y,
      });
    });
    buckets.forEach(function (b) {
      b.stocks.sort(function (x, y2) { return (y2.marketValue || 0) - (x.marketValue || 0); });
    });

    /* 市场分布（含成分股与占比） */
    var assetMap = {};
    hs.forEach(function (h) {
      var k = h.assetType || 'stock';
      var g = assetMap[k] || (assetMap[k] = {
        key: k, label: h.kindLabel, count: 0, marketValue: 0, predicted: 0, stocks: [],
      });
      g.count++;
      g.marketValue += (h.marketValueCny || 0);
      g.predicted += (h.predictedDividendCny || 0);
      g.stocks.push({ symbol: h.symbol, name: h.name, marketValue: h.marketValueCny || 0 });
    });
    var byAssetType = Object.keys(assetMap).map(function (k) { return assetMap[k]; })
      .sort(function (a, b) { return b.marketValue - a.marketValue; });
    var marketTotal = U.sum(byAssetType, function (g) { return g.marketValue; });
    byAssetType.forEach(function (g) {
      g.weight = marketTotal > 0 ? g.marketValue / marketTotal * 100 : 0;
      g.stocks.sort(function (a, b) { return b.marketValue - a.marketValue; });
      g.stocks.forEach(function (st) {
        st.weight = g.marketValue > 0 ? st.marketValue / g.marketValue * 100 : 0;
      });
    });

    /* 集中度（人民币口径：原币混币排序会让港股/美股的名次与占比都失真） */
    var sorted = hs.slice().sort(function (a, b) {
      return (b.marketValueCny || 0) - (a.marketValueCny || 0);
    });
    var totalMv = U.sum(sorted, function (h) { return h.marketValueCny || 0; });
    function topShare(n) {
      return totalMv > 0
        ? U.sum(sorted.slice(0, n), function (h) { return h.marketValueCny || 0; }) / totalMv * 100
        : null;
    }
    var hhi = totalMv > 0
      ? U.sum(sorted, function (h) { var w = (h.marketValueCny || 0) / totalMv; return w * w; })
      : null;
    var level = hhi === null ? '—' : hhi >= 0.25 ? '高度集中' : hhi >= 0.15 ? '较为集中' : '相对分散';

    /* 逐只集中度（含累计占比，让用户看清前三大到底是哪三只） */
    var cum = 0;
    var concentrationList = sorted.map(function (h, i) {
      var w = totalMv > 0 ? (h.marketValueCny || 0) / totalMv * 100 : 0;
      cum += w;
      return {
        rank: i + 1, symbol: h.symbol, name: h.name,
        marketValue: h.marketValueCny || 0, weight: w, cumWeight: cum,
      };
    });

    return {
      summary: s,
      byPnl: byPnl,
      topGainers: byPnl.slice(0, 5),
      topLosers: byPnl.slice(-5).filter(function (h) { return h.unrealizedCny < 0; }).reverse(),
      yieldBuckets: buckets,
      byAssetType: byAssetType,
      concentration: {
        total: totalMv,
        top1: topShare(1), top3: topShare(3), top5: topShare(5), top10: topShare(10),
        hhi: hhi, level: level,
        /* 逐只占比 + 累计占比，用于在界面上具体列出每只股票 */
        holdings: concentrationList,
      },
      lossCount: byPnl.filter(function (h) { return h.unrealizedCny < 0; }).length,
      gainCount: byPnl.filter(function (h) { return h.unrealizedCny > 0; }).length,
    };
  }

  /* ---------------- 自动到账（唯一的写操作） ---------------- */

  /**
   * 对「已实施分配且派息日已过」的方案自动生成到账记录。
   * 幂等键 = planId + accountId。返回新增条数。
   */
  function applyAutoReceived(state) {
    var today = U.today();
    var added = 0;
    var keys = Object.keys(state.plans);

    for (var i = 0; i < keys.length; i++) {
      var p = state.plans[keys[i]];
      if (!p || !p.isImplemented) continue;
      var payDate = payoutDate(p);
      if (!payDate || payDate > today) continue;
      var ps = perSharePretax(p);
      if (ps <= 0) continue;

      for (var a = 0; a < state.accounts.length; a++) {
        var acc = state.accounts[a];

        var txs = state.transactions.filter(function (t) {
          return t.accountId === acc.accountId && t.symbol === p.symbol;
        });
        if (!txs.length) continue;

        var pos = position(txs, p.equityRecordDate || payDate);
        if (pos.qty <= 0) continue;

        var amount = Math.round(pos.qty * ps * 100) / 100;

        /* 二级去重：
             ① 同一方案（planId + 账户）→ 幂等，老规则
             ② 同一标的 + 同一账户 + 同一到账日 + 金额相符 → 视为同一笔
           ② 是为了拦住「手工补录 / OCR 导入的分红（planId 为 null）」与自动登记重复计数，
           否则同一天同一笔分红会被记两次（自动 + 手动）。 */
        var dup = state.received.some(function (r) {
          if (r.planId === p.planId && r.accountId === acc.accountId) return true;
          return U.sameDividend(r, {
            accountId: acc.accountId, symbol: p.symbol,
            exDividendDate: payDate, amount: amount,
          });
        });
        if (dup) continue;

        state.received.push({
          recId: U.uid('rec'),
          accountId: acc.accountId,
          symbol: p.symbol,
          planId: p.planId,
          exDividendDate: payDate,
          perShareAmount: ps,
          qtyAtRecord: pos.qty,
          amount: amount,
          source: 'AUTO',
          year: U.yearOf(payDate),
          createdAt: U.nowStamp(),
        });
        added++;
      }
    }
    return added;
  }

  /* ---------------- 时间范围辅助 ---------------- */

  function historyRange(state) {
    var dates = [];
    state.transactions.forEach(function (t) { if (t.date) dates.push(t.date); });
    state.received.forEach(function (r) { if (r.exDividendDate) dates.push(r.exDividendDate); });
    if (!dates.length) return { min: U.today(), max: U.today() };
    dates.sort();
    return { min: dates[0], max: dates[dates.length - 1] };
  }

  /* ---------------- 重复分红清理 ---------------- */

  /**
   * 合并历史遗留的重复到账记录。
   * 判定用 U.sameDividend（同标的 + 同账户 + 同到账日 + 金额相符），保留最早创建的一条。
   * 自动登记与手工/OCR 补录在旧版本里可能各写一条（幂等键只覆盖了自动的那条），这里做一次性自愈。
   * 幂等：重复执行不会再有变化。
   */
  function dedupeDividends(state) {
    var list = (state.received || []).slice().sort(function (a, b) {
      var ca = a.createdAt || '', cb = b.createdAt || '';
      if (ca !== cb) return ca < cb ? -1 : 1;
      return String(a.recId || '') < String(b.recId || '') ? -1 : 1;
    });
    var kept = [];
    var removed = 0;
    list.forEach(function (r) {
      if (kept.some(function (k) { return U.sameDividend(k, r); })) { removed++; return; }
      kept.push(r);
    });
    if (removed) state.received = kept;
    return removed;
  }

  /* ---------------- 持仓总市值历史（快照 + 日线重建） ---------------- */

  /** 取某标的在某日或之前最近一个交易日的价格（前值填充；早于全部历史则返回 null） */
  function priceOn(points, date) {
    if (!points || !points.length) return null;
    var lo = 0, hi = points.length - 1, hit = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (points[mid][0] <= date) { hit = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return hit < 0 ? null : U.num(points[hit][1]);
  }

  /** 汇率：人民币恒为 1；缺失时按 1 折算（与全应用口径一致） */
  function fxRate(currency, fx) {
    if (currency === 'HKD') return U.num(fx && fx.HKD) || 1;
    if (currency === 'USD') return U.num(fx && fx.USD) || 1;
    return 1;
  }

  /**
   * 某标的的「原币 → 人民币」汇率。
   * 视图层要显示 ¥ 金额（分红记录、明细行等）时统一走这里，避免各处自己取汇率取错。
   */
  function cnyRateOf(state, symbol) {
    return fxRate(XJ.market.currency(symbol), (state && state.settings && state.settings.fx) || {});
  }

  /**
   * 由交易流水还原「每个交易日的持股数」。
   * 走的是同一个 position()，因此与页面显示的持仓完全同源。
   */
  function qtyOn(txs, date, costMethod, receivedTotal) {
    return position(txs, date, costMethod, receivedTotal).qty;
  }

  /**
   * 持仓总市值历史序列（人民币口径）。
   *
   * priceMap: { symbol: [['YYYY-MM-DD', price], ...] }（升序，价格可为收盘价或基金净值）
   * 返回 [{ date, mv, cost, source }]，按日期升序。
   *
   * 规则：
   *   · 日期全集 = 各标的日线日期的并集 ∩ [beg, end]，并限定在首笔交易之后
   *   · 每个标的按「该日持股数 × 该日（或之前最近一个交易日的）价格 × 汇率」求和
   *   · 同日若有每日快照，用快照数值覆盖（快照用的是当日实时行情与真实汇率，更准）
   *   · 缺少日线的标的（场外基金未取到净值等）不计入，另由 missing 字段如实回传
   */
  function marketValueSeries(state, accountId, priceMap, opts) {
    opts = opts || {};
    priceMap = priceMap || {};
    var acc = accountId || ALL;
    var fx = opts.fx || (state.settings && state.settings.fx) || {};

    var txs = state.transactions.filter(function (t) {
      return acc === ALL || t.accountId === acc;
    });
    if (!txs.length) return { series: [], missing: [], used: [] };

    var syms = [];
    txs.forEach(function (t) { if (syms.indexOf(t.symbol) < 0) syms.push(t.symbol); });

    /* 各标的的交易日集合，顺便挑出「没有日线」的标的 */
    var dateSet = {};
    var used = [], missing = [];
    syms.forEach(function (sym) {
      var pts = priceMap[sym];
      if (!pts || !pts.length) { missing.push(sym); return; }
      used.push(sym);
      pts.forEach(function (p) { dateSet[p[0]] = true; });
    });
    if (!used.length) return { series: [], missing: missing, used: used };

    /* 首笔交易之前不该有市值 */
    var firstTx = txs.map(function (t) { return t.date; }).sort()[0];
    var snapDates = state.snapshots ? Object.keys(state.snapshots) : [];
    snapDates.forEach(function (d) { dateSet[d] = true; });   // 快照日期也纳入（可能有 K 线没有的日期）

    var dates = Object.keys(dateSet)
      .filter(function (d) { return d >= firstTx; })
      .filter(function (d) { return (!opts.beg || d >= opts.beg) && (!opts.end || d <= opts.end); })
      .sort();
    if (!dates.length) return { series: [], missing: missing, used: used };

    /* 每只标的的持仓与累计分红（分红摊薄口径要用），按日取 position 会重复计算，
       这里预先按「交易日期」切片，避免 O(日期数 × 交易数) 的重复排序开销。 */
    var perSym = {};
    used.forEach(function (sym) {
      var stx = txs.filter(function (t) { return t.symbol === sym; });
      var recs = state.received.filter(function (r) {
        return r.symbol === sym && (acc === ALL || r.accountId === acc);
      }).slice().sort(function (a, b) {
        return String(a.exDividendDate || '') < String(b.exDividendDate || '') ? -1 : 1;
      });
      var meta = state.symbols[sym] || {};
      perSym[sym] = {
        txs: stx.sort(cmpTx),
        method: meta.costMethod || defaultCostMethod(),
        /* 注意：这里**不预存**「全量分红合计」—— 分红摊薄成本必须用截至当日已到账的分红
           （receivedOn(recs, d)），用全量会把「未来才到账的分红」提前摊进历史成本。 */
        recs: recs,
        currency: XJ.market.currency(sym),
        points: priceMap[sym],
      };
    });

    /* 某日之前（含）累计到账分红 —— 净资产曲线要用 */
    function receivedOn(recs, date) {
      var s = 0;
      for (var k = 0; k < recs.length; k++) {
        var d = recs[k].exDividendDate;
        if (d && d <= date) s += U.n0(recs[k].amount);
        else if (d > date) break;                 // recs 已按日期升序
      }
      return s;
    }

    var series = [];
    for (var i = 0; i < dates.length; i++) {
      var d = dates[i];
      var mv = 0, cost = 0, net = 0, recv = 0, hasAny = false;
      used.forEach(function (sym) {
        var info = perSym[sym];
        var px = priceOn(info.points, d);
        if (px === null) return;
        var pos = position(info.txs, d, info.method, receivedOn(info.recs, d));
        if (pos.qty <= 0) return;
        var rate = fxRate(info.currency, fx);
        mv += pos.qty * px * rate;
        cost += pos.costBasis * rate;
        net += pos.netInvested * rate;
        recv += receivedOn(info.recs, d) * rate;
        hasAny = true;
      });
      if (!hasAny) continue;

      var snap = state.snapshots && state.snapshots[d];
      var useMv = (snap && U.num(snap.mv) !== null) ? U.n0(snap.mv) : null;
      var mvOut = useMv !== null ? useMv : Math.round(mv * 100) / 100;
      var netOut = Math.round(net * 100) / 100;
      /* 净资产 = 持仓总市值 + 累计已收分红 − 累计净投入（含股息的总收益口径，用户确认） */
      series.push({
        date: d,
        mv: mvOut,
        cost: useMv !== null ? U.n0(snap.cost) : Math.round(cost * 100) / 100,
        net: netOut,
        recv: Math.round(recv * 100) / 100,
        nw: Math.round((mvOut + recv - net) * 100) / 100,
        source: useMv !== null ? 'snapshot' : 'kline',
      });
    }
    return { series: series, missing: missing, used: used };
  }

  /** 日/月粒度降采样：月粒度取每月最后一个点 */
  function downsample(series, granularity) {
    if (granularity !== 'month' || !series || series.length < 2) return series || [];
    var out = [];
    for (var i = 0; i < series.length; i++) {
      var cur = series[i];
      var next = series[i + 1];
      if (!next || next.date.slice(0, 7) !== cur.date.slice(0, 7)) out.push(cur);
    }
    return out;
  }

  /** 区间起止（今天为基准）。range: today | 1m | 3m | 6m | ytd | all | custom */
  function chartRange(range, today, customBeg, customEnd) {
    var end = customEnd || today;
    var beg = null;
    if (range === 'today') beg = today;
    else if (range === '1m') beg = U.addDays(U.ymOf(today) + '-01', 0);      // 本月
    else if (range === '3m') beg = U.addDays(today, -91);
    else if (range === '6m') beg = U.addDays(today, -182);
    else if (range === 'ytd') beg = today.slice(0, 4) + '-01-01';
    else if (range === 'custom') beg = customBeg || null;
    return { beg: beg, end: end };
  }

  /**
   * 序列的首尾对比：用于「较区间起点 +¥X · N%」。
   * key 默认 'mv'；净资产传 'nw'（金额差 + 百分比）；收益率传 'pct'（本身就是百分点）。
   */
  function seriesDelta(series, key) {
    if (!series || series.length < 2) return null;
    key = key || 'mv';
    var a = series[0], b = series[series.length - 1];
    var av = U.n0(a[key]), bv = U.n0(b[key]);
    var diff = bv - av;
    var isPct = key === 'pct';
    return {
      from: a.date, to: b.date,
      first: av, last: bv,
      diff: diff,
      isPct: isPct,
      /* 收益率序列直接给百分点差；金额序列给涨幅百分比 */
      pct: isPct ? (bv - av) : (av > 0 ? diff / av * 100 : null),
    };
  }

  /* ---------------- 时间加权收益率（TWR） ----------------
   * 口径：按日计算「剔除当日净流入/流出」后的收益，再逐日连乘。
   *   总资产 Vₜ = 持仓市值 + 累计已收分红（分红到手就是现金，计入资产）
   *   外部流 Fₜ = 累计净投入ₜ − 累计净投入ₜ₋₁（加仓/减仓是外部流入流出，不算收益）
   *   当日收益 rₜ = (Vₜ − Vₜ₋₁ − Fₜ) ÷ Vₜ₋₁
   *   收益率指数 Iₜ = Iₜ₋₁ × (1 + rₜ)，起算日 I = 1
   *
   * 为什么不用「净资产 ÷ 净投入」：中途加仓会把那个比值机械拉低，与指数涨跌幅无法公平对比。
   * 分红不算外部流（它是投资所得），因此不会被剔除 —— 这正是「含股息收益」的体现。
   *
   * @param series marketValueSeries 的输出（含 date / mv / net / recv）
   * @return [{ date, idx, mv, net, recv }]，idx 为首日 1.0 的收益率指数
   */
  function twrIndex(series) {
    if (!series || !series.length) return [];
    var out = [];
    var idx = 1, prevV = null, prevNet = null;
    for (var i = 0; i < series.length; i++) {
      var p = series[i];
      var V = U.n0(p.mv) + U.n0(p.recv);
      var net = U.n0(p.net);
      if (prevV === null) {
        out.push({ date: p.date, idx: 1, mv: p.mv, net: net, recv: p.recv });
      } else {
        var flow = net - prevNet;
        var r = prevV > 1e-6 ? (V - prevV - flow) / prevV : 0;
        if (!isFinite(r)) r = 0;
        idx = idx * (1 + r);
        out.push({ date: p.date, idx: Math.round(idx * 1e8) / 1e8, mv: p.mv, net: net, recv: p.recv });
      }
      prevV = V; prevNet = net;
    }
    return out;
  }

  /**
   * 一组序列里最晚的起始日期 —— 各曲线都从这里开始才谈得上可比。
   * 参数既可以是「序列数组的数组」（如 [seriesA, seriesB]），
   * 也可以是「单点对象数组」（如 [{date},{date}]），按元素形状自动识别。
   */
  function commonStart(seriesList) {
    var latest = null;
    (seriesList || []).forEach(function (s) {
      if (!s) return;
      var first = Array.isArray(s) ? (s[0] && s[0].date) : s.date;
      if (!first) return;
      if (latest === null || first > latest) latest = first;
    });
    return latest;
  }

  /**
   * 把序列换算成「相对共同起点的百分比收益」。
   * @param points [{ date, <valueKey> }] 或 [{ d, <valueKey> }]（指数日线用 d）
   * @param valueKey 取值字段，默认 'c'（指数收盘价）；组合收益率指数传 'idx'
   * @param startDate 共同起点；为空则用自己的第一个点
   * @return [{ date, pct }]，起点当天为 0
   */
  function rebasePercent(points, valueKey, startDate) {
    if (!points || !points.length) return [];
    valueKey = valueKey || 'c';
    /* 指数日线用 d、组合序列用 date —— 两种都接受 */
    var dateOf = function (p) { return p.date !== undefined ? p.date : p.d; };
    var start = startDate || dateOf(points[0]);
    var base = null, out = [];
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      var d = dateOf(p);
      if (!d || d < start) continue;
      var v = U.num(p[valueKey]);
      if (v === null) continue;
      if (base === null) {
        base = v;
        out.push({ date: d, pct: 0 });
        continue;
      }
      out.push({ date: d, pct: base > 0 ? Math.round((v / base - 1) * 10000) / 100 : 0 });
    }
    return out;
  }

  /** 指数日线（[{d,o,h,l,c}]）裁到 [beg, end] */
  function indexBarsInRange(bars, beg, end) {
    return (bars || []).filter(function (b) {
      return (!beg || b.d >= beg) && (!end || b.d <= end);
    });
  }

  /**
   * 指数「收益率蜡烛」：把每日 O/H/L/C 都换算成相对起点收盘价的百分比，
   * 于是蜡烛与折线共用同一套 % 坐标，能和组合收益率直接比。
   */
  function indexCandles(bars, startDate) {
    if (!bars || !bars.length) return [];
    var start = startDate || bars[0].d;
    var base = null;
    for (var i = 0; i < bars.length; i++) {
      if (bars[i].d >= start) { base = bars[i].c; break; }
    }
    if (!base || base <= 0) return [];
    var out = [];
    bars.forEach(function (b) {
      if (b.d < start) return;
      var f = function (v) { return Math.round((v / base - 1) * 10000) / 100; };
      out.push({ date: b.d, o: f(b.o), h: f(b.h), l: f(b.l), c: f(b.c), full: b });
    });
    return out;
  }

  /* ==================== 技术信号：BOLL 布林带 + KDJ ====================
   * 只做指标计算与「是否触及下轨」的客观判定，不含任何操作建议 ——
   * 项目红线是「只做记录、不荐股」，故文案与函数名一律使用中性描述。
   */

  /* 指标参数集中在这里，便于日后用行情软件实测校准。
     BOLL(20, 2)：中轨 = MA20，上下轨 = 中轨 ± 2 × 标准差（总体口径）
     KDJ(9, 3, 3)：RSV 取 9 日；K、D 各 3 日平滑；J = 3K − 2D */
  var SIG_BOLL_N = 20, SIG_BOLL_K = 2;
  var SIG_KDJ_N = 9, SIG_KDJ_M1 = 3, SIG_KDJ_M2 = 3;
  /* KDJ 的 K、D 初值（通达信口径取 50）。
     初值的影响不会立刻消失 —— 所以要喂足够长（≥3×N）的历史让 K/D 收敛，
     缓存之所以取 60 根而不是刚好 20 根，就是为了这个。 */
  var SIG_KDJ_INIT = 50;
  /* 信号所需的最少有效根数（窗口不足时无值可判，一律不亮） */
  var SIG_MIN_BARS = SIG_BOLL_N;

  var SIG_DAY = { kind: 'day', text: '日线下轨', cls: 'sig-day' };
  var SIG_WEEK = { kind: 'week', text: '周线下轨', cls: 'sig-week' };

  /**
   * 滑动窗口均值。
   * 窗口不足的位置返回 null（而不是拿不完整的窗口凑一个数）——
   * 这样 BOLL 的起点与主流行情软件一致：第 N 根才开始有值。
   * @param {number[]} arr
   * @param {number} n 窗口长度
   * @return {(number|null)[]} 与 arr 等长
   */
  function smaSeries(arr, n) {
    var src = arr || [];
    n = n || 1;
    var out = [], sum = 0;
    for (var i = 0; i < src.length; i++) {
      sum += src[i];
      if (i >= n) sum -= src[i - n];
      out.push(i >= n - 1 ? sum / n : null);
    }
    return out;
  }

  /**
   * 滑动窗口【总体】标准差（除以 N，不是样本口径的 N−1）。
   * 口径必须固定为总体：样本口径会让下轨偏低约 2.6%，
   * 而本功能恰恰是在「价格贴着下轨」的临界场景下做判定，这点偏差足以翻转结论。
   * @param {number[]} arr
   * @param {number} n
   * @return {(number|null)[]}
   */
  function stdSeries(arr, n) {
    var src = arr || [];
    n = n || 1;
    var out = [];
    for (var i = 0; i < src.length; i++) {
      if (i < n - 1) { out.push(null); continue; }
      var mean = 0, k;
      for (k = i - n + 1; k <= i; k++) mean += src[k];
      mean /= n;
      var v = 0;
      for (k = i - n + 1; k <= i; k++) v += (src[k] - mean) * (src[k] - mean);
      out.push(Math.sqrt(v / n));
    }
    return out;
  }

  /**
   * 布林带 BOLL(N, K)：中轨 = MA(N)，上/下轨 = 中轨 ± K × 标准差。
   * 返回【全序列】而非只返回最后一根 —— 单测可以逐根断言，
   * 也便于日后画图回看；调用方取末项即可。
   * @param {number[]} closes 收盘价序列（升序）
   * @param {number} n 周期，默认 20
   * @param {number} k 倍数，默认 2
   * @return {{ mid:number, upper:number, lower:number, i:number }[]}
   *   长度与 closes 相同；窗口不足的位置三个值均为 null
   */
  function boll(closes, n, k) {
    n = n || SIG_BOLL_N;
    k = (k === undefined || k === null) ? SIG_BOLL_K : k;
    var src = [], raw = closes || [];
    for (var i = 0; i < raw.length; i++) {
      var v = U.num(raw[i]);
      /* 脏值兜底为 0，避免 NaN 顺着窗口扩散；调用方负责先剔除无效根 */
      src.push(v === null ? 0 : v);
    }
    if (!src.length) return [];
    var mid = smaSeries(src, n), sd = stdSeries(src, n);
    var out = [];
    for (var j = 0; j < src.length; j++) {
      if (mid[j] === null || sd[j] === null) {
        out.push({ mid: null, upper: null, lower: null, i: j });
      } else {
        out.push({
          mid: mid[j],
          upper: mid[j] + k * sd[j],
          lower: mid[j] - k * sd[j],
          i: j,
        });
      }
    }
    return out;
  }

  /**
   * KDJ(N, M1, M2)：
   *   RSV = (C − N 日内最低) / (N 日内最高 − N 日内最低) × 100
   *   K = (M1−1)/M1 × 前K + 1/M1 × RSV      （M1=3 即 K = 2/3·前K + 1/3·RSV）
   *   D = (M2−1)/M2 × 前D + 1/M2 × K
   *   J = 3K − 2D
   * J 的取值【不设上下限】—— 超出 0~100 是 KDJ 的固有性质，
   * 本功能的判定条件正是 J < 0，clamp 会把信号彻底改掉。
   * @param {{h:number,l:number,c:number}[]} bars 含高/低/收的 K 线（升序）
   * @param {number} n 默认 9
   * @param {number} m1 默认 3
   * @param {number} m2 默认 3
   * @return {{k:number,d:number,j:number,i:number}[]} 长度与 bars 相同；不足 N 根处为 null
   */
  function kdj(bars, n, m1, m2) {
    n = n || SIG_KDJ_N; m1 = m1 || SIG_KDJ_M1; m2 = m2 || SIG_KDJ_M2;
    var list = bars || [];
    if (!list.length) return [];
    var out = [];
    var pk = SIG_KDJ_INIT, pd = SIG_KDJ_INIT;
    for (var i = 0; i < list.length; i++) {
      if (i < n - 1) { out.push({ k: null, d: null, j: null, i: i }); continue; }
      var hh = -Infinity, ll = Infinity, ok = true;
      for (var k = i - n + 1; k <= i; k++) {
        var b = list[k] || {};
        var h = U.num(b.h), l = U.num(b.l);
        if (h === null || l === null) { ok = false; break; }
        if (h > hh) hh = h;
        if (l < ll) ll = l;
      }
      var c = U.num((list[i] || {}).c);
      if (!ok || c === null) { out.push({ k: null, d: null, j: null, i: i }); continue; }
      /* N 日最高 === 最低（一字板、停牌横盘、数据源只给一个价）时分母为 0。
         取中性值 50：RSV 一旦变成 NaN，J 就是 NaN，而 `NaN < 0` 恒为 false
         —— 信号会静默地永不亮起，极难排查，故必须在这里兜住。 */
      var rsv = (hh === ll) ? SIG_KDJ_INIT : (c - ll) / (hh - ll) * 100;
      pk = (m1 - 1) / m1 * pk + 1 / m1 * rsv;
      pd = (m2 - 1) / m2 * pd + 1 / m2 * pk;
      out.push({ k: pk, d: pd, j: 3 * pk - 2 * pd, i: i });
    }
    return out;
  }

  /** 本周一（'YYYY-MM-DD'）；today 非法时原样返回（退化为「不过滤」） */
  function mondayOf(today) {
    var t = U.parseYmd(today);
    if (!t) return today;
    var dow = t.getDay();                    // 0 = 周日
    var back = dow === 0 ? 6 : dow - 1;
    return U.addDays(today, -back) || today;
  }

  /**
   * 把「已收盘的历史 K 线」与「今日实时那根」拼成一条连续序列。
   *
   * ★ 实测（2026-09-16，腾讯 fqkline，5 标的交叉验证）：
   *   接口盘中给的「今日那根」就是实时根，其 o/h/l/c 与行情接口逐位一致：
   *     招商银行  末根 高41.41 低40.52  ←→  行情 qt[33] 41.41 / qt[34] 40.52   ✅
   *     五粮液    末根 高69.69 低68.89  ←→  行情 69.69 / 68.89                 ✅
   *   即：**不是「尚未收盘的旧值」，更不是只有现价**。
   *   所以当接口已给今日根时【原样采用】，保留真实的盘中最高/最低。
   *
   * 为什么不能一律「开=高=低=收=现价」：
   *   那样会让今日根的 h−l = 0，把布林带的 σ 系统性压低
   *   （招商银行 40.95 / 41.41 / 40.52 的日振幅 1.07% 被抹成 0），
   *   而下轨 = 中轨 − 2σ 恰恰是本功能的判定依据 —— σ 偏小则下轨偏高，信号会偏晚。
   *
   * 回退（接口未给今日根时，如早盘开盘前、或数据源当日缺根）：
   *   退化为「开=高=低=收=现价」，仍参与计算，保证信号不整段消失。
   *   verify【30】锁定了这条回退路径。
   *
   * @param {{d,o,h,l,c}[]} bars 历史 K 线（升序，【可含】今日那根）
   * @param {string} today 'YYYY-MM-DD'
   * @param {number} price 实时价（用于回退，以及校正今日根的收盘）
   * @return {{d,o,h,l,c,live?}[]} 新数组（不修改入参）
   */
  function withLiveBar(bars, today, price) {
    var list = bars || [], out = [];
    var p = U.num(price);
    var todayBar = null;

    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b || !b.d) continue;
      if (b.d > today) continue;               // 未来根一律丢弃（脏数据）
      if (b.d === today) { todayBar = b; continue; }   // 今日根另作处理
      out.push({ d: b.d, o: b.o, h: b.h, l: b.l, c: b.c });
    }

    if (todayBar) {
      /* 接口已给今日根：原样采用真实 o/h/l/c。
         唯一校正：收盘价用实时价（接口可能给的是若干秒前的快照，
         而信号判定用的 p 就是当下现价，两者必须一致，否则会出现
         「按接口收价判命中、按现价判不命中」的自相矛盾）。 */
      var h = U.num(todayBar.h), l = U.num(todayBar.l), o = U.num(todayBar.o);
      if (p !== null && p > 0) {
        if (h === null || p > h) h = p;
        if (l === null || p < l) l = p;
        if (o === null) o = p;
        out.push({ d: today, o: o, h: h, l: l, c: p, live: true });
      } else {
        out.push({ d: today, o: o, h: h, l: l, c: U.num(todayBar.c), live: true });
      }
    } else {
      /* 接口未给今日根 → 回退：开=高=低=收=现价 */
      if (p === null || p <= 0) return out;
      out.push({ d: today, o: p, h: p, l: p, c: p, live: true });
    }
    return out;
  }

  /**
   * 由【日 K】聚合出【本周那根未收盘周 K】—— **回退路径**。
   *
   * ★ 实测（2026-09-16）：腾讯周 K 接口盘中给的「本周那根」日期就是今天、
   *   收价 = 现价，且 开/高/低 与「本周日K聚合」的结果**逐位一致**：
   *     招商银行  接口 开41.34 高41.83 低40.52  ←→  聚合 41.34 / 41.83 / 40.52  ✅
   *     五粮液    接口 开69.76 高70.00 低68.89  ←→  聚合 69.76 / 70.00 / 68.89  ✅
   *   所以主路径**优先用接口那根**（口径与行情软件一致，且少一次聚合计算）。
   *
   * 本函数仅在接口没给「本周那根」时兜底 —— 最典型的是**周一早盘**：
   * 此时接口可能还没生成本周的周 K，若不兜底则在聚合结果之外，
   * 整个上午的周线信号都会消失。反推：接口给的是「上周五收盘」那根，
   * 与现价脱节，也不能直接用（否则信号半天不动）。
   *
   * 兜底口径：
   *   开 = 本周第一根日 K 的开盘价
   *   高 = 本周所有日 K 的最高价 ∪ 现价
   *   低 = 本周所有日 K 的最低价 ∪ 现价
   *   收 = 现价
   *
   * @param {{d,o,h,l,c}[]} dayBars 日 K（升序，含今日）
   * @param {string} today 'YYYY-MM-DD'
   * @param {number} price 实时价
   * @return {{d,o,h,l,c,live}|null} today 非法或现价无效时返回 null
   */
  function weekLiveBar(dayBars, today, price) {
    var p = U.num(price);
    if (p === null || p <= 0) return null;
    var mon = mondayOf(today);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(mon)) return null;

    var o = null, h = null, l = null;
    var list = dayBars || [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b || !b.d) continue;
      if (b.d < mon || b.d > today) continue;      // 只吃本周一 → 今天
      if (o === null) o = U.num(b.o);
      var bh = U.num(b.h), bl = U.num(b.l);
      if (bh !== null && (h === null || bh > h)) h = bh;
      if (bl !== null && (l === null || bl < l)) l = bl;
    }
    if (h === null || h < p) h = p;
    if (l === null || l > p) l = p;
    if (o === null) o = p;
    return { d: today, o: o, h: h, l: l, c: p, live: true };
  }

  /**
   * 拼出「实时周 K 序列」：历史周 K + 本周那根（优先接口，缺失则聚合兜底）。
   *
   * 拆成独立纯函数是为了让单测能直接断言这条**优先级链**，
   * 而不必去构造完整的 day/week 缓存。
   *
   * @param {{d,o,h,l,c}[]} weekBars 接口周 K（升序，【可含】本周那根）
   * @param {{d,o,h,l,c}[]} dayBars 日 K（升序，含今日；仅兜底时用到）
   * @param {string} today 'YYYY-MM-DD'
   * @param {number} price 实时价
   * @return {{d,o,h,l,c,live?}[]}
   */
  function withLiveWeek(weekBars, dayBars, today, price) {
    var mon = mondayOf(today);
    var p = U.num(price);
    var out = [], hasThisWeek = false;
    var wk = weekBars || [];

    for (var i = 0; i < wk.length; i++) {
      var b = wk[i];
      if (!b || !b.d) continue;
      if (b.d > today) continue;              // 未来根丢弃
      if (b.d >= mon) { hasThisWeek = true; } // 本周那根（d 在 [周一, 今天] 区间内）
      out.push({ d: b.d, o: b.o, h: b.h, l: b.l, c: b.c });
    }

    if (hasThisWeek) {
      /* 主路径：接口已给本周那根。只把收盘校正为实时价，
         高/低保留接口的真实盘中极值。 */
      var last = out[out.length - 1];
      if (p !== null && p > 0) {
        var h = U.num(last.h), l = U.num(last.l);
        if (h === null || p > h) h = p;
        if (l === null || p < l) l = p;
        last.h = h; last.l = l; last.c = p; last.live = true;
      }
    } else {
      /* 回退路径：接口没给本周那根（典型：周一早盘）→ 由本周日 K 聚合 */
      var wlb = weekLiveBar(dayBars, today, p);
      if (wlb) out.push(wlb);
    }
    return out;
  }

  /**
   * 技术信号的统一入口 —— 优先级也收敛在这里，视图层只负责展示。
   *
   * 判定（用户口径，不得擅改）：
   *   日线：现价 ≤ 日线实时布林下轨 且 日线实时 KDJ 的 J < 0
   *   周线：现价 ≤ 周线实时布林下轨 且 周线实时 KDJ 的 J < 0
   *   两者同时成立 → 只返回周线（周线权重更高）
   * 「触及」含【等于】（用 ≤ 而非 <）。
   * 条件不满足即返回 null，视图据此立刻不渲染 —— 天然满足「不再满足就立即消失」。
   *
   * 「实时」的含义（2026-09-16 实测后定稿）：
   *   日线 = 历史日 K + 今日那根（**原样采用接口给的实时 o/h/l/c**，
   *          保留真实盘中最高/最低；接口缺今日根时才退化为「开=高=低=收=现价」）
   *   周线 = 历史周 K + 本周那根（**优先用接口给的实时那根**；
   *          接口缺本周根时才由本周日 K 聚合）
   *   收盘价一律校正为传入的实时价 p，与判定所用的 p 保持同源。
   *
   * @param {string} symbol 标的
   * @param {{d,o,h,l,c}[]} dayBars 日 K 缓存（可含今日那根）
   * @param {{d,o,h,l,c}[]} weekBars 周 K 缓存（可含本周那根）
   * @param {number} price 实时价
   * @param {string} today 'YYYY-MM-DD'
   * @return {null|{kind:'day'|'week', text:string, cls:string}}
   */
  function bollSignal(symbol, dayBars, weekBars, price, today) {
    var p = U.num(price);
    if (p === null || p <= 0) return null;

    /* 场外基金没有盘中行情，单位净值本身就是收盘价，
       「实时价格触及下轨」无从谈起 —— 直接不参与，而不是拿净值硬凑一个信号。 */
    if (XJ.market.assetType(symbol) === 'of') return null;

    var dayHit = false, weekHit = false;

    /* ---- 日线 ---- */
    var live = withLiveBar(dayBars, today, p);
    if (live.length >= SIG_MIN_BARS) {
      var closes = live.map(function (b) { return b.c; });
      var bb = boll(closes, SIG_BOLL_N, SIG_BOLL_K);
      var lastB = bb.length ? bb[bb.length - 1] : null;
      var kk = kdj(live, SIG_KDJ_N, SIG_KDJ_M1, SIG_KDJ_M2);
      var lastK = kk.length ? kk[kk.length - 1] : null;
      if (lastB && lastB.lower !== null && lastK && lastK.j !== null) {
        dayHit = (p <= lastB.lower) && (lastK.j < 0);
      }
    }

    /* ---- 周线 ---- */
    var wlive = withLiveWeek(weekBars, dayBars, today, p);
    if (wlive.length >= SIG_MIN_BARS) {
      var wcloses = wlive.map(function (b) { return b.c; });
      var wbb = boll(wcloses, SIG_BOLL_N, SIG_BOLL_K);
      var wlastB = wbb.length ? wbb[wbb.length - 1] : null;
      var wkk = kdj(wlive, SIG_KDJ_N, SIG_KDJ_M1, SIG_KDJ_M2);
      var wlastK = wkk.length ? wkk[wkk.length - 1] : null;
      if (wlastB && wlastB.lower !== null && wlastK && wlastK.j !== null) {
        weekHit = (p <= wlastB.lower) && (wlastK.j < 0);
      }
    }

    if (weekHit) return { kind: SIG_WEEK.kind, text: SIG_WEEK.text, cls: SIG_WEEK.cls };
    if (dayHit) return { kind: SIG_DAY.kind, text: SIG_DAY.text, cls: SIG_DAY.cls };
    return null;
  }

  /**
   * 把多只标的的「当日分时」按【时间戳】对齐后累加成组合市值序列。
   *
   * 为什么必须按时间戳而不是按下标：
   *   各标的的分时点数天然不同（停牌、新上市、数据源返回条数、美股点数完全不同），
   *   用数组下标对齐等于假设「第 i 个点就是同一时刻」，一旦某标的缺某个时刻，
   *   它的贡献会整段消失，算出来的组合值出现台阶式下跌，极端情况直接算出 -100%。
   *
   * 时间轴取所有标的时间戳的【有序并集】；某标的在某时刻没有数据时用【前值填充】
   * （沿用它在该时刻之前最后一个有效价格），而不是跳过 —— 跳过正是造成台阶跳水的直接原因。
   *
   * @param {Array} holdings  [{ symbol, qty, currency }]
   * @param {Object} minutes  { [symbol]: { points: [{ t:'09:30', p:16.2 }] } }
   * @param {Function} rateFn 币种 → 汇率（可选，默认恒为 1）
   * @param {Object} opts     （可选，**缺省时行为与旧版逐字节一致**）
   *        opts.full    true → 额外计算「相对昨收」的当日盈亏与全组合昨收市值基准
   *        opts.prev    { symbol: 昨收 }（原币）。缺失时退化为该标的【首个分时价】，
   *                     即它对当日的贡献从 0 起算，不会污染组合
   * @return {{ points: [{ t, mv, filled, pnl?, pending? }], missing: [symbol], base? }}
   *   points[].mv      = 该时刻 Σ(持股数 × 价格 × 汇率)
   *   points[].filled  = 该时刻有多少只标的用了前值填充（有分时、但不是恰好命中该时刻）
   *   points[].pending = （full）该时刻之前【完全没有报价】的标的数 —— 与 filled 语义不同，
   *                      典型场景是 A 股 09:30 时美股还没开盘（21:30）
   *   points[].pnl     = （full）该时刻 Σ 持股数 ×(价格 − 昨收)× 汇率 = 当日参考盈亏
   *   base             = （full）Σ 持股数 × 昨收 × 汇率 = 【全组合】昨收市值
   *                      ★ 这就是当日收益率该用的分母：旧的「首个时刻的 mv」只含当时已开盘的标的，
   *                        组合里有跨时区标的时会让分母偏小、收益率被放大数倍
   *   missing          = 完全没有可用分时数据的标的
   */
  function alignMinute(holdings, minutes, rateFn, opts) {
    opts = opts || {};
    var full = !!opts.full;
    var prevMap = opts.prev || {};
    var rate = typeof rateFn === 'function' ? rateFn : function () { return 1; };
    var hs = (holdings || []).filter(function (h) {
      return h && h.symbol && U.num(h.qty) !== null;
    });
    var mins = minutes || {};

    /* 每只标的：points 转成按时间升序的数组（数据源本就升序，这里保守排一次），
       并记录它的第一个有效时刻，便于后续「从头就没有数据」的判定 */
    var series = [], missing = [], tset = {};
    hs.forEach(function (h) {
      var m = mins[h.symbol];
      var pts = (m && m.points) ? m.points.filter(function (p) {
        return p && p.t && U.num(p.p) !== null;
      }) : [];
      if (pts.length < 2) { missing.push(h.symbol); }
      else {
        pts = pts.slice().sort(function (a, b) { return a.t < b.t ? -1 : a.t > b.t ? 1 : 0; });
        pts.forEach(function (p) { tset[p.t] = 1; });
      }
      /* 默认模式：没有分时的标的完全不进 series（与旧版逐字节一致）；
         full 模式：让它留在 series 里占「昨收」权重（当日盈亏贡献 0），
         这样 base 才是【全组合】的昨收市值，而不是「当时已开盘那几只」的。 */
      if (pts.length < 2 && !full) return;
      var prev = U.num(prevMap[h.symbol]);
      if (prev === null && pts.length) prev = U.num(pts[0].p);   // 兜底：从 0 起算，不污染组合
      series.push({
        symbol: h.symbol, qty: U.num(h.qty),
        rate: U.num(rate(h.currency)) || 1,
        pts: pts.length >= 2 ? pts : [], prev: prev,
      });
    });
    if (!series.length) {
      return full ? { points: [], missing: missing, base: 0 } : { points: [], missing: missing };
    }

    /* "HH:MM" 的字典序即时间序 */
    var times = Object.keys(tset).sort();

    var out = [];
    var cursor = {};      // symbol → 已推进到的下标（指针推进，避免 O(n²) 查找）
    var lastPrice = {};   // symbol → 最后一个有效价格（前值填充用）
    series.forEach(function (s) { cursor[s.symbol] = -1; });

    /* full：全组合昨收市值 —— 当日收益率的分母 */
    var base = 0;
    if (full) {
      series.forEach(function (s) { if (s.prev !== null) base += s.qty * s.prev * s.rate; });
    }

    times.forEach(function (t) {
      var sum = 0, filled = 0, live = 0, pending = 0, pnl = 0;
      series.forEach(function (s) {
        var i = cursor[s.symbol];
        /* 指针只前进：把所有 t' <= t 的点吃掉，最后一个即为该时刻的有效价 */
        while (i + 1 < s.pts.length && s.pts[i + 1].t <= t) { i++; lastPrice[s.symbol] = s.pts[i].p; }
        cursor[s.symbol] = i;
        var price = lastPrice[s.symbol];
        if (price === null || price === undefined) {
          /* 该标的在此刻之前完全没有报价（尚未开盘 / 当天停牌）。
             mv 里不含它（与旧版一致）；full 模式记一笔 pending，而它在 base 里已占权重，
             于是「分子贡献 0 + 分母含它」= 按常量参与，不会把收益率放大。 */
          if (full && s.prev !== null) pending++;
          return;
        }
        live++;
        if (i >= 0 && s.pts[i].t !== t) filled++;            // 用了前值填充（不是恰好命中该时刻）
        sum += s.qty * price * s.rate;
        if (full && s.prev !== null) pnl += s.qty * (price - s.prev) * s.rate;
      });
      /* 一个标的都没覆盖到的时刻没有意义，跳过（极少数标的停牌的时段） */
      if (!live) return;
      var pt = { t: t, mv: sum, filled: filled };
      if (full) {
        pt.pending = pending;
        pt.pnl = Math.round(pnl * 100) / 100;
      }
      out.push(pt);
    });

    return full
      ? { points: out, missing: missing, base: Math.round(base * 100) / 100 }
      : { points: out, missing: missing };
  }

  /**
   * 当日净资产曲线要加的**常量项**（盘口无关，全天不变）：
   *   累计已收分红 − 累计净投入 + 没有分时的那些标的的静态市值
   *
   * ★ 必须与 marketValueSeries 的口径**完全对齐**，否则「当日」和「全部」两张曲线
   *   会给出两个不同的净资产。踩过的两个坑：
   *   ① 净投入/分红要**按标的币种乘汇率** —— marketValueSeries 里是 `pos.netInvested * rate`，
   *      漏乘的话持有港股/美股的组合会按外币原值（而不是人民币）去扣成本。
   *   ② **没有分时的标的（场外基金 / 美股 / 长期停牌）必须把它的市值补回来** ——
   *      它进不了逐分钟的 mv（alignMinute 会把它记进 missing），
   *      若只扣它的净投入、不加它的市值，净资产会凭空少掉「市值」这一整块。
   *      早就这么写的结果：一个含 5 万元场外基金的组合，当日净资产比真实值少了 4 万。
   *
   * @param minuteSymbols 真正参与当日分时曲线的标的（= 持仓标的 − alignMinute 的 missing）
   * @param includedSymbols 参与计算的标的集合，**必须与 marketValueSeries 的 `used` 一致**
   *        （即「有日线」的标的）。不传则不过滤（旧行为）。
   *        不拉齐集合的后果：「无日线但有分红」的标的会被这里算进常量项、
   *        在日粒度曲线里却完全不存在 → 两条累计收益打架。
   */
  function netWorthAdjust(state, accountId, includedSymbols, minuteSymbols) {
    var acc = accountId || ALL;
    var inc = {};
    (includedSymbols || []).forEach(function (s) { inc[s] = true; });
    var hasMinute = {};
    (minuteSymbols || []).forEach(function (s) { hasMinute[s] = true; });
    var fx = (state.settings && state.settings.fx) || {};

    var adj = 0;
    holdings(state, acc).forEach(function (h) {
      if (includedSymbols && !inc[h.symbol]) return;
      var rate = fxRate(XJ.market.currency(h.symbol), fx);
      adj -= U.n0(h.netInvested) * rate;
      /* 无分时的标的：它的市值全天是个常量，直接按现价补进来。
         ★ 必须乘汇率 —— marketValue 是**原币**（holdings 的成对字段约定），
           漏乘会让持有港/美股的组合当日累计收益少算「市值 ×(汇率−1)」。 */
      if (!hasMinute[h.symbol]) adj += U.n0(h.marketValue) * rate;
    });
    (state.received || []).forEach(function (r) {
      if (acc !== ALL && r.accountId !== acc) return;
      if (includedSymbols && !inc[r.symbol]) return;
      adj += U.n0(r.amount) * fxRate(XJ.market.currency(r.symbol), fx);
    });
    return adj;
  }

  /* ---- 当日分时缓存取用（纯函数） ----
     cache 结构：{ at:'YYYY-MM-DD', bySymbol:{ symbol:{ date:'YYYY-MM-DD', points:[{t,p}] } } }
     at 是这批数据的**交易日**（来自接口 date，不是本机今日）。
     每只标的只存最近 1 天，所以判定的核心是「这标的数据是不是这一批的」。

     为什么必须有 date === cache.at 这道闸门：
     缓存是落盘的，隔天打开时里面还留着昨天的数据。若不校验，
     就会把昨天的走势当成今天画出来 —— 曲线看着正常，实际是错的。
     落到这里的 date 一律来自数据源，所以用等值比较即可。 */
  function minuteOf(cache, symbol, today) {
    if (!cache || typeof cache !== 'object') return null;
    if (typeof cache.at !== 'string' || !cache.at) return null;
    var by = cache.bySymbol;
    if (!by || typeof by !== 'object') return null;
    if (!symbol) return null;
    var m = by[symbol];
    if (!m || typeof m !== 'object') return null;
    /* 陈旧批次不画：这份数据必须属于当前缓存批次那一天 */
    if (m.date !== cache.at) return null;
    /* 不画未来：接口 date 理论上不会超前，但导入脏数据时可能 */
    if (typeof today === 'string' && today && m.date > today) return null;
    var pts = m.points;
    if (!pts || !pts.length || pts.length < 2) return null;
    return { date: m.date, points: pts };
  }

  /* 批量版：只返回可用的，供 alignMinute 直接消费（缺失的不进结果） */
  function minuteMapFor(cache, symbols, today) {
    var out = {};
    var list = symbols || [];
    for (var i = 0; i < list.length; i++) {
      var sym = list[i];
      if (!sym) continue;
      var m = minuteOf(cache, sym, today);
      if (m) out[sym] = m;
    }
    return out;
  }

  /* ==================== 新闻硬规则（六 Tab 三期） ====================
   * 用户拍板（2026-10-08 决策 10）：纯关键词硬规则，弃 GLM ——
   * 「已成交可核验」的事实才收录，宁缺勿滥。三道闸依次为：
   *   ① 传闻排除词 —— 一票否决（据悉/拟/或将/知情人士…，凡是「还没发生」的一律不收）
   *   ② 实体词表命中 —— 必过（传奇投资者与其旗下平台，图七监控清单）
   *   ③ 完成时态 / 金额结构词 —— 必过（宣布/完成/斥资/亿/%…没有动作与量级的不收）
   * 词表刻意做成可维护配置：新增实体只需往 NEWS_RULES.entities 加一个词。 */

  var NEWS_RULES = {
    /* 传奇投资者与旗下平台（图七监控清单，可继续增补）。拉丁词按不区分大小写匹配 */
    entities: [
      /* 伯克希尔系 */
      '巴菲特', '伯克希尔', '波克夏', '哈撒韦', 'BRK', '芒格',
      '阿贝尔', '康布斯', 'Todd Combs', 'Weschler',
      /* 长和系（四平台）+ 李氏家族 */
      '李嘉诚', '李泽钜', '李泽楷', '长和', '长江实业', '长实集团', '和黄', '电能实业',
      'CK Hutchison', 'CK Asset', 'CK Infrastructure', 'Power Assets',
      /* 海外传奇投资机构 */
      'Exor', 'LVMH', '路威酩轩', '阿尔诺', 'Arnault',
      '橡树资本', 'Oaktree', '霍华德·马克斯', 'Howard Marks',
      '高瓴', 'Hillhouse', 'HHLR', '段永平',
      /* 日本五大商社 */
      '三菱商事', '三井物产', '伊藤忠', '住友商事', '丸红', '五大商社',
      /* 其它主权基金 / 传奇企业 */
      'Reliance', '信实工业', '安巴尼', 'Ambani', 'PIF', '沙特公共投资基金',
      'Mubadala', '穆巴达拉', '三星', '淡马锡', 'Temasek', 'GIC',
    ],
    /* 完成时态 / 金额结构词：有了实体还不够，必须有「动作 + 量级」才像已成交事实 */
    facts: [
      '完成', '宣布', '达成', '签署', '交割', '公告', '披露', '公布', '落定', '敲定',
      '斥资', '增持', '减持', '回购', '买入', '购入', '卖出', '出售', '收购', '中标',
      '派息', '宣派', '分红', '除净', '派发', '上调', '获批',
      ' 亿', '亿元', '亿美元', '亿港元', '%',
    ],
    /* 传闻排除词：一票否决，优先级最高（宁缺勿滥） */
    rumors: [
      '据悉', '据称', '据传', '传闻', '传言', '或将', '拟', '有意', '考虑', '寻求',
      '计划', '筹备', '磋商', '洽谈', '探讨', '评估中', '知情人士', '消息称',
      '消息人士', '接近', '有望', '预计', '或以', '意在', '据说',
    ],
  };

  /** 词表命中：纯中文走 indexOf；拉丁词（含空格/点）按不区分大小写正则匹配 */
  function newsTextHas(text, word) {
    if (!word) return false;
    if (/^[A-Za-z0-9][A-Za-z0-9 .&·'-]*$/.test(word)) {
      var re = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      return re.test(text);
    }
    return text.indexOf(word) >= 0;
  }

  /**
   * 硬规则判定。返回 null（不收）或 { hits: [命中的实体词...] }（按词表序）。
   * 判定顺序刻意固定：传闻否决 → 实体 → 结构。测试与行为都依赖这个顺序。
   */
  function newsFilter(item) {
    if (!item) return null;
    var text = String(item.title || '') + '\n' + String(item.digest || '');
    if (!text.replace(/\s/g, '')) return null;
    var i;
    for (i = 0; i < NEWS_RULES.rumors.length; i++) {
      if (newsTextHas(text, NEWS_RULES.rumors[i])) return null;
    }
    var hits = [];
    for (i = 0; i < NEWS_RULES.entities.length; i++) {
      if (newsTextHas(text, NEWS_RULES.entities[i])) hits.push(NEWS_RULES.entities[i]);
    }
    if (!hits.length) return null;
    for (i = 0; i < NEWS_RULES.facts.length; i++) {
      if (newsTextHas(text, NEWS_RULES.facts[i])) return { hits: hits };
    }
    return null;
  }

  /**
   * 「仅查看自选」的命中：条目正文里出现自选 / 持仓标的的名称（≥2 字）即相关。
   * 返回命中的名称数组（空数组 = 不相关）。纯函数，视图层每轮渲染现算。
   */
  function newsWlHits(item, names) {
    var text = String(item && item.title || '') + '\n' + String(item && item.digest || '');
    var out = [];
    (names || []).forEach(function (n) {
      if (n && String(n).length >= 2 && text.indexOf(n) >= 0) out.push(n);
    });
    return out;
  }

  /**
   * Unix 秒 → 'YYYY-MM-DD HH:MM'。
   * ★ 固定按北京时间（UTC+8）格式化：新闻是境内市场语境，不跟设备时区走，
   *   海外设备的用户看到的也是同一串北京时间。手写 UTC 分量拼接，不经过 toLocaleString。
   */
  function newsTimeText(ctime) {
    var t = U.num(ctime);
    if (t === null || t <= 0) return '';
    var d = new Date((t + 8 * 3600) * 1000);
    return d.getUTCFullYear() + '-' + U.pad2(d.getUTCMonth() + 1) + '-' + U.pad2(d.getUTCDate()) +
      ' ' + U.pad2(d.getUTCHours()) + ':' + U.pad2(d.getUTCMinutes());
  }

  /**
   * 合并新闻命中：按 id 去重（新的优先）、ctime 降序、裁掉 cutoff 之前的旧闻、裁到 cap 条。
   * 用于「上一轮缓存 + 本轮新命中」的合并，两边谁先谁后结果一致。
   */
  function newsMerge(oldHits, newHits, cutoffSec, cap) {
    var seen = {};
    var out = [];
    (newHits || []).concat(oldHits || []).forEach(function (it) {
      if (!it || !it.id || seen[it.id]) return;
      if (cutoffSec && (U.num(it.ctime) || 0) < cutoffSec) return;
      seen[it.id] = true;
      out.push(it);
    });
    out.sort(function (a, b) { return (U.num(b.ctime) || 0) - (U.num(a.ctime) || 0); });
    if (cap && out.length > cap) out = out.slice(0, cap);
    return out;
  }

  return {
    ALL: ALL,
    alignMinute: alignMinute,
    netWorthAdjust: netWorthAdjust,
    cnyRateOf: cnyRateOf,
    minuteOf: minuteOf,
    minuteMapFor: minuteMapFor,
    perSharePretax: perSharePretax,
    perShareAfterTax: perShareAfterTax,
    payoutDate: payoutDate,
    payoutInfo: payoutInfo,
    dividendAnchor: dividendAnchor,
    plansOf: plansOf,
    trailingPerShare: trailingPerShare,
    annualBasePerShare: annualBasePerShare,
    yieldFiscalSteps: yieldFiscalSteps,
    dividendYieldSeries: dividendYieldSeries,
    yieldYearAverages: yieldYearAverages,
    yieldAverageSeries: yieldAverageSeries,
    YIELD_AVG_FROM: YIELD_AVG_FROM,
    YIELD_AVG_MIN_DAYS: YIELD_AVG_MIN_DAYS,
    exDividendDates: exDividendDates,
    position: position,
    txOf: txOf,
    holdings: holdings,
    summary: summary,
    calendarEvents: calendarEvents,
    upcomingPayouts: upcomingPayouts,
    monthView: monthView,
    coverage: coverage,
    milestone: milestone,
    MILESTONES: MILESTONES,
    projection: projection,
    FORECAST: FORECAST,
    normalizeForecast: normalizeForecast,
    forecastRows: forecastRows,
    forecastPoolAt: forecastPoolAt,
    forecastDividendAt: forecastDividendAt,
    forecastSolveYears: forecastSolveYears,
    forecastSolveInvest: forecastSolveInvest,
    forecastSplit: forecastSplit,
    stats: stats,
    monthDetail: monthDetail,
    /* v6 新增：派息日弹窗 + 分红汇总 */
    payoutsOn: payoutsOn,
    dividendRange: dividendRange,
    dividendSummary: dividendSummary,
    funEquivalent: funEquivalent,
    DIVSUM_RANGES: DIVSUM_RANGES,
    applyAutoReceived: applyAutoReceived,
    historyRange: historyRange,
    dedupeDividends: dedupeDividends,
    /* v3 新增 */
    buildSnapshot: buildSnapshot,
    writeSnapshot: writeSnapshot,
    snapshotDates: snapshotDates,
    snapshotSeries: snapshotSeries,
    snapshotDelta: snapshotDelta,
    pendingExDiv: pendingExDiv,
    statDays: statDays,
    annualView: annualView,
    availableYears: availableYears,
    analytics: analytics,
    /* v4 新增：持仓总市值历史 */
    marketValueSeries: marketValueSeries,
    downsample: downsample,
    chartRange: chartRange,
    seriesDelta: seriesDelta,
    priceOn: priceOn,
    /* v5 新增：收益率曲线与指数对比 */
    twrIndex: twrIndex,
    commonStart: commonStart,
    rebasePercent: rebasePercent,
    indexBarsInRange: indexBarsInRange,
    indexCandles: indexCandles,
    /* FIRE 视图（v6）：财务自由试算 */
    FIRE: FIRE,
    tierMonthlySpend: tierMonthlySpend,
    fireEffectiveSpend: fireEffectiveSpend,
    fireTargets: fireTargets,
    fireCfg: fireCfg,
    fireTimeline: fireTimeline,
    fireMonthlyPassive: fireMonthlyPassive,
    fireCoverageHistory: fireCoverageHistory,
    fireProgress: fireProgress,
    fireSceneSolve: fireSceneSolve,
    netInvested: function (txs, upToDate) {
      var p = position(txs, upToDate, 'weighted');
      return {
        buyAmount: p.buyAmount, sellAmount: p.sellAmount,
        buyFees: p.buyFees, sellFees: p.sellFees,
        gross: p.buyAmount + p.buyFees,
        net: p.netInvested,
      };
    },
    /* v6 新增：技术信号（布林带下轨 + KDJ） */
    smaSeries: smaSeries,
    stdSeries: stdSeries,
    boll: boll,
    kdj: kdj,
    mondayOf: mondayOf,
    withLiveBar: withLiveBar,
    withLiveWeek: withLiveWeek,
    weekLiveBar: weekLiveBar,
    bollSignal: bollSignal,
    /* v7 新增（六 Tab 三期）：新闻硬规则 */
    NEWS_RULES: NEWS_RULES,
    newsFilter: newsFilter,
    newsWlHits: newsWlHits,
    newsTimeText: newsTimeText,
    newsMerge: newsMerge,
  };
})();
