/* ==================== 视图：FIRE（被动收入 · 财务自由试算） ====================
 * 卡片顺序：大数字 → 试算滑杆 → FI 进度（图3） → 覆盖率曲线（图2） → 场景（图4）
 *           → 支出分组（生存/品质） → 分红汇总入口。
 * 计算全部来自 calc.js 的 FIRE section（verify【37】与 tools/test-fire.mjs 锁口径），
 * 视图内不做任何内联计算 —— 每个数字都能在断言里找到来源。
 */
XJ.views.plan = (function () {
  var U = XJ.util, UI = XJ.ui, C = XJ.views.common, X = XJ.calc;

  function tierKey(fire) {
    return fire && (fire.activeTier === 'lean' || fire.activeTier === 'fat') ? fire.activeTier : 'regular';
  }
  function tierName(t) { return t === 'lean' ? 'Lean FIRE' : t === 'fat' ? 'Fat FIRE' : 'Regular FIRE'; }
  function tierTag(t) { return t === 'lean' ? '生存线自由' : t === 'fat' ? '富足自由（生存 + 200% 品质）' : '当前生活方式自由'; }

  function monthsText(months) {
    if (months === null || months === undefined) return '—';
    if (months <= 0) return '已达成';
    var y = Math.floor(months / 12);
    var m = Math.round(months - y * 12);
    if (m === 12) { y += 1; m = 0; }
    if (y <= 0) return m + ' 个月';
    if (m <= 0) return y + ' 年';
    return y + ' 年 ' + m + ' 个月';
  }

  /* ---------------- 滑杆 ---------------- */
  function sliderHtml(k, label, min, max, step, val, valText, headExtra) {
    var p = (val - min) / (max - min) * 100;
    return '<div class="fire-slider">' +
      '<div class="fs-head"><label>' + label + '</label>' + (headExtra || '') +
      '<span class="fs-val" id="fs-val-' + k + '">' + valText + '</span></div>' +
      '<input type="range" class="fs-range" min="' + min + '" max="' + max + '" step="' + step +
      '" value="' + val + '" style="--p:' + p + '%"' +
      ' data-input="fireSliderInput" data-change="fireSliderCommit" data-k="' + k + '" aria-label="' + label + '">' +
      '<div class="fs-ticks">' + ticksFor(k) + '</div>' +
      '</div>';
  }
  function ticksFor(k) {
    if (k === 'dripYieldPct') return '<span>0%</span><span>10%</span><span>20%</span><span>30%</span>';
    if (k === 'reinvest') return '<span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span>';
    if (k === 'drip') return '<span>0</span><span>1万</span><span>2万</span><span>3万</span><span>4万</span><span>5万</span>';
    return '<span>0</span><span>1万</span><span>2万</span><span>3万</span>';
  }

  /* ---------------- 卡 1：大数字（具体年月 + 档位切换 chips） ---------------- */
  function tierChipsHtml(tier) {
    return ['lean', 'regular', 'fat'].map(function (t) {
      return '<button type="button" class="chip' + (t === tier ? ' active' : '') +
        '" data-act="setFireTier" data-v="' + t + '">' + tierName(t).replace(' FIRE', '') + '</button>';
    }).join('');
  }

  function bigCardHtml(fire, tier, tl) {
    var title = '距离财务自由';
    var big, sub;
    if (!tl.solvable) {
      big = '—';
      sub = tl.reason === 'beyond-limit'
        ? '按当前参数 50 年内无法达成'
        : '投入与息率不足以增长——请调高攒股金额或息率';
    } else if (tl.reached) {
      big = '已达成';
      /* reached 有两种来路：纯被动收入覆盖 / 不再投分红把目标抵扣到 0 —— 文案如实区分 */
      sub = tl.coveredByOffset
        ? '🎉 不再投的分红已抵扣全部目标支出'
        : '🎉 当前被动收入已覆盖目标支出';
    } else {
      var ym = tl.date || U.ymOf(U.today());
      big = Number(ym.slice(0, 4)) + ' 年 ' + Number(ym.slice(5, 7)) + ' 月';
      sub = '距今日 ' + monthsText(tl.months);
    }
    return '<div class="card fire-hero fi-glass">' +
      '<div class="fire-hero-row"><span class="fire-hero-title">' + title + '</span>' +
      '<span class="fs-mini-seg fi-glass" role="group">' + tierChipsHtml(tier) + '</span></div>' +
      '<div class="fire-big" id="fire-big-num" data-anim="S">' + big + '</div>' +
      '<div class="fire-sub" id="fire-big-sub" data-anim="A">' + sub + '</div>' +
      '<div class="fire-hero-note">被动收入 = 现有持仓分红 + 每月攒股按息率滚出的分红（再投 ' +
      U.n0(fire.reinvestPct) + '%，可在下方试算卡调节）</div>' +
      '</div>';
  }

  /* ---------------- 卡 2：试算滑杆（四根：花费/攒股/息率/再投） ---------------- */
  function sliderCardHtml(st, fire, tier, cfg, targets) {
    var spendMode = st.ui.fireSpendMode === 'day' ? 'day' : 'month';
    var spendVal = spendMode === 'day'
      ? '¥' + (cfg.monthlySpend / X.FIRE.daysPerMonth).toFixed(2) + '/日'
      : U.moneySign(cfg.monthlySpend, 0);
    var spendLabel = spendMode === 'day' ? '每日消费' : '每月花费';
    var spendSwitch =
      '<span class="segmented fs-mini fi-glass" role="group">' +
      '<button type="button" class="' + (spendMode === 'day' ? 'on' : '') + '" data-act="fireSpendMode" data-v="day">日</button>' +
      '<button type="button" class="' + (spendMode === 'month' ? 'on' : '') + '" data-act="fireSpendMode" data-v="month">月</button>' +
      '</span>';

    /* 提示行：相对全默认基准的 Δ + 按市值息率折算的生息资产（随行情自动更新） */
    var sim = fire.tierSims[tier] || {};
    var touched = sim.monthlySpend !== null || (sim.drip !== null && sim.drip !== 5000) || sim.dripYieldPct !== null;
    var tip;
    if (touched) {
      var cleanFire = { yieldBasis: 'market', reinvestPct: fire.reinvestPct, tierSims: { lean: {}, regular: {}, fat: {} } };
      var baseTl = X.fireTimeline(st.state, st.acc(), X.fireCfg(st.state, st.acc(), tier, cleanFire));
      var cur = X.fireTimeline(st.state, st.acc(), cfg);
      if (cur.solvable && !cur.reached && baseTl.solvable && !baseTl.reached) {
        var d = baseTl.months - cur.months;          // 正 = 提前
        tip = '<div class="fire-tip ' + (d >= 0 ? 'good' : 'warn') + '" id="fire-tip-line">' +
          (d >= 0 ? '自由日提前 ' : '自由日推后 ') + monthsText(Math.abs(d)) + '</div>';
      } else if (cur.reached) {
        tip = '<div class="fire-tip good" id="fire-tip-line">🎉 按当前滑杆参数，被动收入已可覆盖目标支出</div>';
      } else {
        tip = '<div class="fire-tip" id="fire-tip-line">按当前参数' + (cur.solvable ? '' : '暂无法测算（息率与投入不足以增长）') + '</div>';
      }
    } else {
      tip = '<div class="fire-tip" id="fire-tip-line">拖动滑杆试试「少花一点 / 多攒一点」对自由日的影响</div>';
    }
    var tierTarget = targets.tiers[tier];
    var capText = tierTarget.fireNumber === null
      ? '暂无法测算'
      : U.moneySign(tierTarget.fireNumber, 0) + '（按当前市值息率 ' + U.pct(targets.yieldPct === null ? 0 : targets.yieldPct, 2) + ' 折算）';

    /* 提取抵扣行：随「分红再投」滑杆实时联动（firePatchDom 就地更新同一 id）。
       base = 当前滑杆模拟支出（cfg.monthlySpend），offset = 持仓月均分红 ×（1−r） */
    var eff = X.fireEffectiveSpend(cfg);
    var effLine = '<div class="fs-offset" id="fire-spend-eff">' +
      '抵扣后目标 <b>' + U.moneySign(eff.effective, 0) + '/月</b>' +
      '<span class="fs-off-amt">（不再投分红抵扣 −' + U.moneySign(eff.offset, 0) + '/月）</span>' +
      (eff.covered ? '<span class="fs-off-done"> · 已完全抵扣 🎉</span>' : '') +
      '</div>';

    return '<div class="card fi-glass">' +
      '<div class="card-head"><h2>⚖ 试算</h2><span class="spacer"></span>' +
      '<button class="chip" data-act="fireReset">重置</button></div>' +
      sliderHtml('monthlySpend', spendLabel, 0, X.FIRE.spendMax, X.FIRE.spendStep, cfg.monthlySpend, spendVal, spendSwitch) +
      sliderHtml('drip', '每月攒股', 0, X.FIRE.dripMax, X.FIRE.dripStep, cfg.drip, U.moneySign(cfg.drip, 0)) +
      sliderHtml('dripYieldPct', '攒股息率（市值口径）', 0, 30, 0.1, cfg.dripYieldPct, U.pct(cfg.dripYieldPct, 1)) +
      /* 再投比例精确到 1%：每 10% 一档太粗，抵扣额对再投很敏感 */
      sliderHtml('reinvest', '分红再投', 0, 100, 1, U.n0(fire.reinvestPct), U.pct(U.n0(fire.reinvestPct), 0)) +
      effLine +
      tip +
      '<div class="tiny" style="margin-top:8px">完全覆盖约需 ' + capText +
      ' 生息资产，随行情刷新自动更新。息率默认跟随当前组合（' +
      U.pct(targets.yieldPct === null ? 0 : targets.yieldPct, 2) + '），拖动后固定。</div>' +
      '</div>';
  }

  /* 当日分时市值：薄封装 networth 已验证的链路（holdings → minuteCache → alignMinute）。
     返回 [{date:'HH:MM', pct:mv}]；无分时数据返回 []。 */
  function buildIntradayMv(st) {
    var hs = X.holdings(st.state, st.acc());
    if (!hs.length) return [];
    var syms = hs.map(function (h) { return h.symbol; });
    var minMap = st.intradayFor ? st.intradayFor(syms) : {};
    if (!minMap || !Object.keys(minMap).length) return [];
    var fx = (st.state.settings && st.state.settings.fx) || {};
    var rateFn = function (sym) { return fx[XJ.market.currency(sym)] || 1; };
    var prevMap = {};
    hs.forEach(function (h) {
      var pc = U.num(h.prevClose);
      if (pc === null || pc <= 0) pc = U.num(h.price);
      if (pc !== null && pc > 0) prevMap[h.symbol] = pc;
    });
    var al = X.alignMinute(hs, minMap, rateFn, { full: true, prev: prevMap });
    return (al && al.points || []).map(function (p) {
      return { date: p.t, pct: p.mv };
    });
  }

  /* 时间尺度 chips 行 */
  function rangeChipsHtml(current, ranges, act) {
    var LABELS = { today: '当日', '1m': '本月', '3m': '近三月', '6m': '近半年', ytd: '今年以来', all: '全部', custom: '自定义' };
    return ranges.map(function (r) {
      return '<button type="button" class="chip' + (r === current ? ' active' : '') +
        '" data-act="' + act + '" data-v="' + r + '">' + LABELS[r] + '</button>';
    }).join('');
  }

  function ymAddLocal(ym, n) {
    var y = parseInt(String(ym).slice(0, 4), 10);
    var m = parseInt(String(ym).slice(5, 7), 10) - 1 + n;
    y += Math.floor(m / 12);
    m = ((m % 12) + 12) % 12;
    return y + '-' + String(m + 1).padStart(2, '0');
  }

  /* 按尺度切片（月序列按月粒度对齐；日序列走 chartRange） */
  function slicePoints(points, range, beg, end, isMonthly) {
    if (range === 'all') return points;
    if (isMonthly) {
      var curYm = U.ymOf(U.today());
      var startYm = null;
      if (range === 'custom') startYm = beg || null;
      else if (range === '3m') startYm = ymAddLocal(curYm, -2);
      else if (range === '6m') startYm = ymAddLocal(curYm, -5);
      else if (range === 'ytd') startYm = curYm.slice(0, 4) + '-01';
      if (!startYm) return points;
      return points.filter(function (p) { return p.date >= startYm; });
    }
    var r = X.chartRange(range === 'today' ? 'all' : range, U.today(), beg, end);
    return points.filter(function (p) { return (!r.beg || p.date >= r.beg) && (!r.end || p.date <= r.end); });
  }

  /* ---------------- 卡 3：FI 进度（图 3，七档时间尺度） ---------------- */
  function progressCardHtml(st, fire, tier, targets) {
    var pr = X.fireProgress(st.state, st.acc(), 'market');
    var bars = ['lean', 'regular', 'fat'].map(function (t) {
      var d = pr.tiers[t];
      var pct = d.ratio === null ? 0 : Math.min(100, Math.max(0, d.ratio));
      var active = t === tier;
      return '<div class="fi-row' + (active ? ' active' : '') + '">' +
        '<div class="fi-row-t"><b>' + tierName(t) + '</b><span class="fi-goal" data-anim="A" data-anim-key="' + t + ':goal">' +
        (d.fireNumber === null ? '暂无法测算' : tierTag(t) + ' · ' + U.moneyCompact(d.fireNumber)) + '</span>' +
        '<span class="fi-pct" data-anim="A" data-anim-key="' + t + ':pct">' + (d.ratio === null ? '—' : U.pct(d.ratio, 1)) + '</span></div>' +
        '<div class="bar"><i data-anim="bar" data-anim-key="' + t + ':bar" style="width:' + pct + '%' + (active ? ';background:var(--dividend)' : '') + '"></i></div>' +
        '</div>';
    }).join('');

    var range = st.ui.firePrRange || 'all';
    var chartHtml = '';
    var chartNote = '';
    if (range === 'today') {
      var pts = buildIntradayMv(st);
      if (pts.length > 1) {
        chartHtml = XJ.chart.renderCompare(
          [{ name: 'FI 本金（当日）', color: '#3FA9C9', points: pts }],
          { unit: 'money', fmtY: function (v) { return U.moneyAxis(v); }, xTicks: 4, area: true, chartKey: 'firePr' });
      } else {
        chartNote = '<div class="tiny" style="padding:8px 0">当日分时数据暂缺（收盘后或新装设备），切到其他时间尺度查看历史。</div>';
      }
    } else if (pr.series.length > 1) {
      var sliced = slicePoints(pr.series, range, st.ui.firePrBeg, st.ui.firePrEnd, false);
      if (sliced.length > 1) {
        chartHtml = XJ.chart.renderCompare(
          [{ name: 'FI 本金', color: '#3FA9C9', points: sliced.map(function (p) { return { date: p.date, pct: p.mv }; }) }],
          { unit: 'money', fmtY: function (v) { return U.moneyAxis(v); }, xTicks: 4, area: true, chartKey: 'firePr' });
      } else {
        chartNote = '<div class="tiny" style="padding:8px 0">该区间内数据不足，换一个更宽的时间尺度试试。</div>';
      }
    } else {
      chartNote = '<div class="tiny" style="padding:8px 0">正在获取历史行情，资产曲线稍后自动出现。</div>';
    }
    var chips = rangeChipsHtml(range, ['today', '1m', '3m', '6m', 'ytd', 'all', 'custom'], 'setFirePrRange');

    /* 小字补全（⑧）：缺口 + 市值息率下的每月新增分红 + 线性推算年月（精确到月） */
    var d0 = pr.tiers[tier];
    var sim = st.state.settings.fire.tierSims[tier] || {};
    var drip = sim.drip === null ? 5000 : sim.drip;
    var yPct = targets.yieldPct;
    var note;
    if (d0.fireNumber === null) {
      note = '组合市值息率暂无法计算（成本非正或无持仓），FI 进度待行情刷新后自动恢复（随行情自动更新）。';
    } else if (d0.gap <= 0) {
      note = '🎉 已越过 ' + tierName(tier) + ' 的本金门槛（' + U.moneyCompact(d0.fireNumber) + '）。';
    } else {
      var newDivM = drip * (yPct === null ? 0 : yPct) / 1200;      // 每月攒股新增月分红
      var monthsNeed = drip > 0 ? Math.ceil(d0.gap / drip) : null; // 线性：本金缺口 ÷ 每月攒股
      var needTxt = monthsNeed ? (Math.floor(monthsNeed / 12) + ' 年 ' + (monthsNeed % 12) + ' 个月') : '—';
      note = '距 ' + tierName(tier) + ' 还差 ' + U.moneyCompact(d0.gap) +
        '；按市值息率 ' + U.pct(yPct === null ? 0 : yPct, 2) + '，每月攒股 ' + U.moneySign(drip, 0) +
        ' 可新增月分红 ' + U.moneySign(newDivM, 2) + '，按此推算预计还需 ' + needTxt +
        '（不计价差与收益变化，随行情刷新自动更新）。';
    }
    return '<div class="card fi-glass">' +
      '<div class="card-head"><h2>◎ FI 进度</h2><span class="spacer"></span>' +
      '<span class="fi-principal">FI 本金 <b data-anim="B">' + U.moneyCompact(pr.fiPrincipal) + '</b></span></div>' +
      bars +
      '<div class="fs-mini-seg fi-range-row fi-glass">' + chips + '</div>' +
      (chartHtml ? '<div class="fi-chart">' + chartHtml + '</div>' : chartNote) +
      '<div class="fire-note">' + note + '</div>' +
      (pr.missing && pr.missing.length ? '<div class="tiny" style="margin-top:6px">' + pr.missing.length + ' 只标的暂无历史行情，未计入曲线。</div>' : '') +
      '</div>';
  }

  /* ---------------- 卡 4：覆盖率曲线（图 2，五档时间尺度 + 年均大数字） ---------------- */
  function coverageCardHtml(st, fire, tier, cfg, targets) {
    var cov = X.fireCoverageHistory(st.state, st.acc(), tier, cfg);
    var chips = ['lean', 'regular', 'fat'].map(function (t) {
      return '<button type="button" class="chip' + (t === tier ? ' active' : '') +
        '" data-act="setFireTier" data-v="' + t + '">' + tierName(t).replace(' FIRE', '') + '</button>';
    }).join('');

    /* 大数字 = 近 12 个月平均覆盖率（当前月没分红时不再误导为 0%） */
    var hist = cov.history.filter(function (p) { return p.pct !== null; });
    var recent = hist.slice(-12);
    var avgPct = recent.length
      ? U.sum(recent, function (p) { return p.pct; }) / recent.length
      : (cov.future.length ? cov.future[0].pct : null);
    var head = '<div class="cov-head"><span class="cov-num" data-anim="S">' +
      (avgPct === null ? (cov.coveredByOffset ? '🎉' : '—') : U.pct(avgPct, 1)) + '</span>' +
      '<span class="cov-hint">' + (cov.coveredByOffset
        ? '抵扣后目标已归零——不再投的分红已完全覆盖'
        : '近 12 个月平均 · 达到 100% 即 ' + tierName(tier) + ' 达成') + '</span></div>';

    var range = st.ui.fireCovRange || 'all';
    var histPts = slicePoints(hist, range, st.ui.fireCovBeg, st.ui.fireCovEnd, true);
    var points = histPts.concat(cov.future).filter(function (p) { return p.pct !== null; });
    var chartSvg = '';
    if (points.length > 1) {
      chartSvg = XJ.chart.renderCompare(
        [{ name: '被动收入覆盖率', color: '#007AFF', points: points }],
        { unit: '%', fmtY: function (v) { return v.toFixed(0) + '%'; }, xTicks: 4,
          area: true, hline: { value: 100, color: 'var(--payout)', label: '100% 🎉' }, chartKey: 'fireCov' });
    } else {
      chartHtml = '<div class="tiny" style="padding:8px 0">到账记录不足，暂无法画覆盖率曲线（有分红到账后自动出现）。</div>';
    }
    var covChips = rangeChipsHtml(range, ['3m', '6m', 'ytd', 'all', 'custom'], 'setFireCovRange');

    /* 小字（⑩）：缺口 + 攒股新增月分红 + 市值息率折算（非 4% 法则）。
       ★ 口径与曲线分母一致 = 抵扣后目标（effective），不是台账原始支出。 */
    var passiveNow = X.fireMonthlyPassive(cfg, 0);
    var eff = X.fireEffectiveSpend(cfg);
    var gapM = Math.max(0, eff.effective - passiveNow);
    var tierTarget = targets.tiers[tier];
    var sim = fire.tierSims[tier] || {};
    var drip = sim.drip === null ? 5000 : sim.drip;
    var yPct = targets.yieldPct;
    var newDivM = drip * (yPct === null ? 0 : yPct) / 1200;
    var note = '月均被动收入 ' + U.moneySign(passiveNow, 2) + '，抵扣后目标月支出 ' + U.moneySign(eff.effective, 2) +
      (eff.offset > 0 ? '（原 ' + U.moneySign(eff.base, 2) + ' − 不再投分红抵扣 ' + U.moneySign(eff.offset, 2) + '）' : '') +
      (gapM > 0 ? '——每月再补 ' + U.moneySign(gapM, 2) + ' 被动现金流即可完全覆盖' : '——已完全覆盖 🎉') +
      '；每月攒股 ' + U.moneySign(drip, 0) + ' 按市值息率新增月分红 ' + U.moneySign(newDivM, 2) +
      (tierTarget && tierTarget.fireNumber !== null
        ? '，完全覆盖约需 ' + U.moneyCompact(tierTarget.fireNumber) + ' 生息资产（按市值息率折算，随行情自动更新）'
        : '') + '。';

    return '<div class="card fi-glass">' +
      '<div class="card-head"><h2>◉ 被动收入覆盖率</h2><span class="spacer"></span><span class="fs-mini-seg">' + chips + '</span></div>' +
      head +
      '<div class="fs-mini-seg fi-range-row fi-glass">' + covChips + '</div>' +
      (chartSvg ? '<div class="cov-chart">' + chartSvg + '</div>' : '<div class="tiny" style="padding:8px 0">到账记录不足，暂无法画覆盖率曲线（有分红到账后自动出现）。</div>') +
      '<div class="fire-note">' + note + '</div>' +
      '</div>';
  }

  /* ---------------- 卡 5：支出分组（生存 / 品质） ---------------- */
  function expensesCardHtml(st) {
    function group(cat, title, hint) {
      var list = st.state.expenses.filter(function (e) {
        return e.enabled && (e.category === 'quality' ? 'quality' : 'essential') === cat;
      }).sort(function (a, b) { return a.sortOrder - b.sortOrder; });
      var total = U.sum(list, function (e) { return e.monthlyAmount; });
      var items = list.map(function (e) {
        return '<button class="exp-item" data-act="openExpenseEditor" data-key="' + U.esc(e.key) + '">' +
          '<div class="top">' + U.esc(e.icon || '🏷️') + '</div>' +
          '<div class="name">' + U.esc(e.label) + '</div>' +
          '<div class="amt">' + U.moneySign(e.monthlyAmount, 0) + '/月</div>' +
          '</button>';
      }).join('');
      return '<div class="exp-group">' +
        '<div class="exp-group-t"><b>' + title + '</b><span class="tiny">' + hint + ' · 合计 ' + U.moneySign(total, 0) + '/月</span></div>' +
        '<div class="exp-grid">' + (items || '<div class="tiny" style="grid-column:1/-1">暂无条目——点下方「编辑支出项」添加。</div>') + '</div>' +
        '</div>';
    }
    return '<div class="card">' +
      '<div class="card-head"><h2>🏠 支出分类</h2><span class="spacer"></span></div>' +
      group('essential', '生存支出', 'Lean FIRE 的分母') +
      group('quality', '品质支出', 'Regular / Fat FIRE 的分母') +
      '<button class="btn-block ghost" data-act="openExpenses">编辑支出项（金额批量调整 / 新增）</button>' +
      '</div>';
  }

  /* ---------------- 卡 7：分红汇总入口（原样保留） ---------------- */
  function entryCardHtml(st) {
    var dsum = XJ.calc.dividendSummary(st.state, st.acc(), { type: 'year' });
    return '<button class="card ds-entry" data-act="openDivSum">' +
      '<div><div class="card-head" style="margin:0"><h2>📊 分红汇总</h2></div>' +
      '<div class="row-s">今年已到账 ' + dsum.count + ' 笔' + (dsum.pendingTotal ? ' · 另有预计 ' + U.moneySign(dsum.pendingTotal, 0) : '') + '</div></div>' +
      '<div class="ds-entry-v">' + U.moneySign(dsum.total, 0) + '</div></button>';
  }

  /* ---------------- 主渲染 ---------------- */
  function render() {
    var st = XJ.store;
    var html = '';
    html += C.statusBanner();
    html += C.accountSwitcher();

    if (!st.hasAnyData()) {
      html += UI.emptyState('🔥', '还没有持仓数据', '先添加一笔持仓，FIRE 试算会基于你的预测分红自动开始。',
        '<button class="ghost-btn primary" data-act="openAddHolding">添加持仓</button>');
      return html;
    }

    var fire = st.state.settings.fire || {};
    var tier = tierKey(fire);
    var targets = X.fireTargets(st.state, st.acc(), 'market');
    var cfg = X.fireCfg(st.state, st.acc(), tier, fire);
    var tl = X.fireTimeline(st.state, st.acc(), cfg);

    html += bigCardHtml(fire, tier, tl);
    html += sliderCardHtml(st, fire, tier, cfg, targets);
    html += progressCardHtml(st, fire, tier, targets);
    html += coverageCardHtml(st, fire, tier, cfg, targets);
    html += expensesCardHtml(st);
    html += entryCardHtml(st);

    html += '<div class="note-line" style="margin-top:4px"><span class="ic">ℹ️</span><span>' +
      'FIRE 试算基于你自己的持仓分红与支出台账推演，只做记录与参考，不构成任何投资建议。</span></div>';
    return html;
  }

  return { render: render };
})();
