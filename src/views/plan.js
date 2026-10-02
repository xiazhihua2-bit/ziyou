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
    if (k === 'drip') return '<span>0</span><span>1万</span><span>2万</span><span>3万</span><span>4万</span><span>5万</span>';
    return '<span>0</span><span>1万</span><span>2万</span><span>3万</span>';
  }

  /* ---------------- 卡 1：大数字 ---------------- */
  function bigCardHtml(fire, tier, tl) {
    var title = '距离财务自由（' + tierName(tier) + '）';
    var sub;
    if (!tl.solvable) {
      sub = tl.reason === 'beyond-limit'
        ? '按当前参数 50 年内无法达成'
        : '投入与息率不足以增长——请调高攒股金额或息率';
    } else if (tl.reached) {
      sub = '🎉 当前被动收入已覆盖目标支出';
    } else {
      var startYear = Number(U.ymOf(U.today()).slice(0, 4));
      var endYear = startYear + Math.ceil(tl.months / 12);
      sub = '预计 ' + endYear + '–' + (endYear + 1) + ' 年间达成';
    }
    var big = !tl.solvable ? '—' : (tl.reached ? '已达成' : monthsText(tl.months));
    return '<div class="card fire-hero">' +
      '<div class="fire-hero-title">' + title + '</div>' +
      '<div class="fire-big" id="fire-big-num">' + big + '</div>' +
      '<div class="fire-sub" id="fire-big-sub">' + sub + '</div>' +
      '<div class="fire-hero-note">被动收入 = 现有持仓分红 + 每月攒股按息率滚出的分红（再投 ' +
      U.n0(fire.reinvestPct) + '%）</div>' +
      '</div>';
  }

  /* ---------------- 卡 2：试算滑杆 ---------------- */
  function sliderCardHtml(st, fire, tier, cfg, targets) {
    var spendMode = st.ui.fireSpendMode === 'day' ? 'day' : 'month';
    var spendVal = spendMode === 'day'
      ? '¥' + (cfg.monthlySpend / X.FIRE.daysPerMonth).toFixed(2) + '/日'
      : U.moneySign(cfg.monthlySpend, 0);
    var spendLabel = spendMode === 'day' ? '每日花费' : '每月花费';
    var spendSwitch =
      '<span class="segmented fs-mini" role="group">' +
      '<button type="button" data-act="fireSpendMode" data-v="day"' + (spendMode === 'day' ? ' style="background:var(--bg-elev);color:var(--text)"' : '') + '>日</button>' +
      '<button type="button" data-act="fireSpendMode" data-v="month"' + (spendMode === 'month' ? ' style="background:var(--bg-elev);color:var(--text)"' : '') + '>月</button>' +
      '</span>';

    var yieldLabel = '攒股息率（' + (fire.yieldBasis === 'cost' ? '成本' : '市值') + '口径' +
      (fire.tierSims[tier].dripYieldPct === null ? ' · 跟随组合' : '') + '）';
    var basisChip =
      '<span class="segmented fs-mini" role="group">' +
      '<button type="button" data-act="setFireYieldBasis" data-v="cost"' + (fire.yieldBasis === 'cost' ? ' style="background:var(--bg-elev);color:var(--text)"' : '') + '>成本</button>' +
      '<button type="button" data-act="setFireYieldBasis" data-v="market"' + (fire.yieldBasis === 'market' ? ' style="background:var(--bg-elev);color:var(--text)"' : '') + '>市值</button>' +
      '</span>';

    /* 提示行：相对全默认基准的 Δ + 4% 法则参考（Δ 只在用户动过滑杆后出现） */
    var sim = fire.tierSims[tier] || {};
    var touched = sim.monthlySpend !== null || (sim.drip !== null && sim.drip !== 5000) || sim.dripYieldPct !== null;
    var tip;
    if (touched) {
      var cleanFire = { yieldBasis: fire.yieldBasis, reinvestPct: fire.reinvestPct, tierSims: { lean: {}, regular: {}, fat: {} } };
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
    var cap4 = targets.tiers[tier].capitalAt4;

    return '<div class="card">' +
      '<div class="card-head"><h2>⚖ 试算</h2><span class="spacer"></span>' +
      '<button class="chip" data-act="fireReset">重置</button></div>' +
      sliderHtml('monthlySpend', spendLabel, 0, X.FIRE.spendMax, X.FIRE.spendStep, cfg.monthlySpend, spendVal, spendSwitch) +
      sliderHtml('drip', '每月攒股', 0, X.FIRE.dripMax, X.FIRE.dripStep, cfg.drip, U.moneySign(cfg.drip, 0)) +
      sliderHtml('dripYieldPct', yieldLabel, 0, 30, 0.1, cfg.dripYieldPct, U.pct(cfg.dripYieldPct, 1), basisChip) +
      tip +
      '<div class="tiny" style="margin-top:8px">完全覆盖约需 ' + U.moneySign(cap4, 0) + ' 生息资产（按 4% 法则折算，仅作参考）。' +
      '息率默认跟随当前组合（' + U.pct(targets.yieldPct === null ? 0 : targets.yieldPct, 2) + '），拖动后固定。</div>' +
      '</div>';
  }

  /* ---------------- 卡 3：FI 进度（图 3） ---------------- */
  function progressCardHtml(st, fire, tier) {
    var pr = X.fireProgress(st.state, st.acc(), fire.yieldBasis);
    var bars = ['lean', 'regular', 'fat'].map(function (t) {
      var d = pr.tiers[t];
      var pct = d.ratio === null ? 0 : Math.min(100, Math.max(0, d.ratio));
      var active = t === tier;
      return '<div class="fi-row' + (active ? ' active' : '') + '">' +
        '<div class="fi-row-t"><b>' + tierName(t) + '</b><span class="fi-goal">' +
        (d.fireNumber === null ? '暂无法测算' : tierTag(t) + ' · ' + U.moneyCompact(d.fireNumber)) + '</span>' +
        '<span class="fi-pct">' + (d.ratio === null ? '—' : U.pct(d.ratio, 1)) + '</span></div>' +
        '<div class="bar"><i style="width:' + pct + '%' + (active ? ';background:var(--dividend)' : '') + '"></i></div>' +
        '</div>';
    }).join('');

    var chartHtml = '';
    if (pr.series.length > 1) {
      var pts = pr.series.map(function (p) { return { date: p.date, pct: p.mv }; });
      chartHtml = '<div class="fi-chart">' + XJ.chart.renderCompare(
        [{ name: 'FI 本金', color: '#3FA9C9', points: pts }],
        { unit: 'money', fmtY: function (v) { return U.moneyCompact(v); }, xTicks: 4, area: true, chartKey: 'firePr' }) +
        '</div>';
    } else {
      chartHtml = '<div class="tiny" style="padding:8px 0">正在获取历史行情，资产曲线稍后自动出现。</div>';
    }

    var d0 = pr.tiers[tier];
    var sim = st.state.settings.fire.tierSims[tier] || {};
    var drip = sim.drip === null ? 5000 : sim.drip;
    var note;
    if (d0.fireNumber === null) {
      note = '组合息率暂无法计算（成本非正或无持仓），FI 进度待行情刷新后自动恢复。';
    } else if (d0.gap <= 0) {
      note = '🎉 已越过 ' + tierName(tier) + ' 的本金门槛（' + U.moneyCompact(d0.fireNumber) + '）。';
    } else {
      var years = drip > 0 ? Math.ceil(d0.gap / (drip * 12)) : null;
      note = '距 ' + tierName(tier) + ' 还差 ' + U.moneyCompact(d0.gap) +
        (years ? '；按每月攒股 ' + U.moneySign(drip, 0) + ' 粗算约 ' + years + ' 年（这个数没有计入投资收益）。' : '。');
    }
    return '<div class="card">' +
      '<div class="card-head"><h2>◎ FI 进度</h2><span class="spacer"></span>' +
      '<span class="fi-principal">FI 本金 <b>' + U.moneyCompact(pr.fiPrincipal) + '</b></span></div>' +
      bars + chartHtml +
      '<div class="fire-note">' + note + '</div>' +
      (pr.missing && pr.missing.length ? '<div class="tiny" style="margin-top:6px">' + pr.missing.length + ' 只标的暂无历史行情，未计入曲线。</div>' : '') +
      '</div>';
  }

  /* ---------------- 卡 4：覆盖率曲线（图 2） ---------------- */
  function coverageCardHtml(st, fire, tier, cfg) {
    var cov = X.fireCoverageHistory(st.state, st.acc(), tier, cfg);
    var chips = ['lean', 'regular', 'fat'].map(function (t) {
      return '<button type="button" class="chip' + (t === tier ? ' active' : '') +
        '" data-act="setFireTier" data-v="' + t + '">' + tierName(t).replace(' FIRE', '') + '</button>';
    }).join('');

    var pct = cov.currentPct;
    var head = '<div class="cov-head"><span class="cov-num">' + (pct === null ? '—' : U.pct(pct, 1)) + '</span>' +
      '<span class="cov-hint">达到 100% 即 ' + tierName(tier) + ' 达成</span></div>';

    var points = cov.history.concat(cov.future).filter(function (p) { return p.pct !== null; });
    var chartHtml = '';
    if (points.length > 1) {
      chartHtml = '<div class="cov-chart">' + XJ.chart.renderCompare(
        [{ name: '被动收入覆盖率', color: '#007AFF', points: points }],
        { unit: '%', fmtY: function (v) { return v.toFixed(0) + '%'; }, xTicks: 4,
          area: true, hline: { value: 100, color: 'var(--payout)', label: '100% 🎉' }, chartKey: 'fireCov' }) +
        '</div>';
    } else {
      chartHtml = '<div class="tiny" style="padding:8px 0">到账记录不足，暂无法画覆盖率曲线（有分红到账后自动出现）。</div>';
    }

    var passiveNow = X.fireMonthlyPassive(cfg, 0);
    var gapM = Math.max(0, cfg.monthlySpend - passiveNow);
    var targets = X.fireTargets(st.state, st.acc(), fire.yieldBasis);
    var cap4 = targets.tiers[tier] ? targets.tiers[tier].capitalAt4 : null;
    var note = '月均被动收入 ' + U.moneySign(passiveNow, 2) + '，目标月支出 ' + U.moneySign(cfg.monthlySpend, 2) +
      (gapM > 0 ? '——每月再补 ' + U.moneySign(gapM, 2) + ' 被动现金流即可完全覆盖' : '——已完全覆盖 🎉') +
      (cap4 ? '（约需 ' + U.moneyCompact(cap4) + ' 生息资产，按 4% 法则）' : '') + '。';

    return '<div class="card">' +
      '<div class="card-head"><h2>◉ 被动收入覆盖率</h2><span class="spacer"></span><span class="fs-mini-seg">' + chips + '</span></div>' +
      head + chartHtml +
      '<div class="fire-note">' + note + '</div>' +
      '</div>';
  }

  /* ---------------- 卡 5：场景模拟（图 4） ---------------- */
  function scenesCardHtml(st, fire, tier) {
    var scenes = fire.scenes || [];
    var rows = scenes.map(function (sc) {
      var r = X.fireSceneSolve(st.state, st.acc(), tier, fire, sc);
      var delta = '—';
      var cls = '';
      if (r.delta) {
        delta = (r.delta.earlier ? '提前 ' : '推后 ') + monthsText(r.delta.y * 12 + r.delta.m);
        cls = r.delta.earlier ? 'c-up' : 'c-down';
      } else if (r.scene && r.scene.solvable && r.scene.reached) {
        delta = '立即达成';
      }
      return '<button class="list-row" data-act="openFireSceneDetail" data-id="' + sc.sceneId + '">' +
        '<div class="row-main"><div class="row-t">' + U.esc(sc.name) + '</div>' +
        '<div class="row-s">支出 ' + (sc.spendPct >= 0 ? '+' : '') + sc.spendPct + '% · 攒股 ' +
        (sc.dripPct >= 0 ? '+' : '') + sc.dripPct + '% · 息率 ' + (sc.yieldAdjPct >= 0 ? '+' : '') +
        sc.yieldAdjPct + 'pp</div></div>' +
        '<div class="row-right"><div class="row-v ' + cls + '">' + delta + '</div></div>' +
        '<span class="chev">' + UI.icon('chevron', 16) + '</span></button>';
    }).join('');

    return '<div class="card">' +
      '<div class="card-head"><h2>🌊 场景模拟</h2><span class="spacer"></span></div>' +
      '<div class="tiny" style="margin-bottom:10px">加一个「要是我换个城市 / 涨薪 / 降花费」的方案，看看自由日会怎么动。场景只做对比，不影响实际数字。</div>' +
      (rows || '') +
      '<button class="btn-block ghost" data-act="addFireScene">+ 添加场景</button>' +
      '</div>';
  }

  /* ---------------- 卡 6：支出分组（生存 / 品质） ---------------- */
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
    var targets = X.fireTargets(st.state, st.acc(), fire.yieldBasis);
    var cfg = X.fireCfg(st.state, st.acc(), tier, fire);
    var tl = X.fireTimeline(st.state, st.acc(), cfg);

    html += bigCardHtml(fire, tier, tl);
    html += sliderCardHtml(st, fire, tier, cfg, targets);
    html += progressCardHtml(st, fire, tier);
    html += coverageCardHtml(st, fire, tier, cfg);
    html += scenesCardHtml(st, fire, tier);
    html += expensesCardHtml(st);
    html += entryCardHtml(st);

    html += '<div class="note-line" style="margin-top:4px"><span class="ic">ℹ️</span><span>' +
      'FIRE 试算基于你自己的持仓分红与支出台账推演，只做记录与参考，不构成任何投资建议。</span></div>';
    return html;
  }

  /* ---------------- 场景详情弹层 ---------------- */
  function openSceneDetail(id) {
    var st = XJ.store;
    var fire = st.state.settings.fire || {};
    var sc = (fire.scenes || []).filter(function (x) { return x.sceneId === id; })[0];
    if (!sc) return;
    var tier = tierKey(fire);
    var r = X.fireSceneSolve(st.state, st.acc(), tier, fire, sc);
    var html =
      '<div class="kv"><span class="k">目标月支出</span><span class="v">' + U.moneySign(r.params.monthlySpend, 0) +
      '（' + (sc.spendPct >= 0 ? '+' : '') + sc.spendPct + '%）</span></div>' +
      '<div class="kv"><span class="k">每月攒股</span><span class="v">' + U.moneySign(r.params.drip, 0) +
      '（' + (sc.dripPct >= 0 ? '+' : '') + sc.dripPct + '%）</span></div>' +
      '<div class="kv"><span class="k">攒股息率</span><span class="v">' + U.pct(r.params.dripYieldPct, 2) +
      '（' + (sc.yieldAdjPct >= 0 ? '+' : '') + sc.yieldAdjPct + 'pp）</span></div>' +
      '<div class="kv"><span class="k">' + tierName(tier) + ' 自由日</span><span class="v">' +
      (r.scene.solvable ? (r.scene.reached ? '已达成' : monthsText(r.scene.months)) : '不可解') + '</span></div>' +
      (r.delta ? '<div class="kv"><span class="k">相对基准</span><span class="v ' + (r.delta.earlier ? 'c-up' : 'c-down') + '">' +
        (r.delta.earlier ? '提前 ' : '推后 ') + monthsText(r.delta.y * 12 + r.delta.m) + '</span></div>' : '') +
      '<button class="btn-block danger" data-act="deleteFireScene" data-id="' + sc.sceneId + '">删除该场景</button>';
    UI.openSheet({ title: U.esc(sc.name), html: html });
  }
  UI.on('openFireSceneDetail', function (node) { openSceneDetail(node.getAttribute('data-id')); });

  return { render: render };
})();
