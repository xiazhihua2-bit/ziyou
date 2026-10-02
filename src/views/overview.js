/* ==================== 视图：概览 + 持仓（含公共组件与个股档案） ==================== */
XJ.views = XJ.views || {};

/* ---------------- 公共组件 ---------------- */
XJ.views.common = (function () {
  var U = XJ.util, UI = XJ.ui;

  function accountSwitcher() {
    var st = XJ.store;
    var list = [{ id: XJ.calc.ALL, name: '全部账户' }].concat(
      st.accounts().map(function (a) { return { id: a.accountId, name: a.name }; })
    );
    if (list.length <= 2 && !st.state.transactions.length) return '';
    var cur = st.acc();
    return '<div class="segmented" style="margin-bottom:12px">' +
      list.map(function (a) {
        return '<button class="' + (a.id === cur ? 'active' : '') + '" data-act="switchAccount" data-id="' +
          U.esc(a.id) + '">' + U.esc(a.name) + '</button>';
      }).join('') + '</div>';
  }

  var SLOGANS = [
    '分红就像生日礼物，每年都会准时到来',
    '一股一股地攒，一年一年地收，这就是收息的浪漫',
    '被动收入是打开人生选择权的钥匙',
    '时间的力量，远比你想象的强大',
    '每一次加仓，都是在给未来加薪',
    '方向对了，就不怕路远',
    '你不需要很厉害才能开始，你需要开始才能变厉害',
    '你在做一件大多数人不愿意做的事：延迟满足',
    '收息之路没有捷径，但每一步都不会白走',
    '持仓在默默为你工作',
  ];
  function slogan() {
    var d = new Date();
    var doy = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
    return SLOGANS[doy % SLOGANS.length];
  }

  function statusBanner() {
    var st = XJ.store;
    var parts = [];
    if (st.ui.busy) {
      parts.push('<div class="offline-bar">' + UI.icon('refresh', 15) + '<span>' + U.esc(st.ui.status || '正在同步数据…') + '</span></div>');
    } else if (st.ui.status) {
      parts.push('<div class="offline-bar">' + UI.icon('info', 15) + '<span>' + U.esc(st.ui.status) + '</span></div>');
    }
    if (st.state.settings.lastQuoteAt && st.ui.offline) {
      parts.push('<div class="offline-bar">' + UI.icon('warn', 15) +
        '<span>行情未能刷新，当前展示缓存数据（' + U.esc(String(st.state.settings.lastQuoteAt).slice(5, 16).replace('T', ' ')) + '）</span></div>');
    }
    return parts.join('');
  }

  function planBasisLabel(h) {
    if (!h || !h.annualPerShare) return '暂无分红方案';
    if (h.annualBasis === 'fiscal') {
      var d = h.annualBasisDetail || {};
      if (d.years > 1) return '近 ' + d.years + ' 个财年年均（' + d.fromYear + '–' + d.year + '）';
      return '最近一财年（' + h.annualBasisYear + '）方案';
    }
    if (h.annualBasis === 'ttm') return '按近 12 个月方案年化';
    if (h.annualBasis === 'fundTtm') return '按近 12 个月已分配金额年化';
    if (h.annualBasis === 'single') return '按 ' + h.annualBasisYear + ' 年方案预估';
    return '暂无分红方案';
  }

  function costMethodLabel(m) {
    return ({ weighted: '加权平均', diluted: '摊薄成本', dividendDiluted: '分红摊薄' })[m] || '加权平均';
  }

  function progressLabel(plan) {
    var p = plan.assignProgress || '';
    if (p.indexOf('实施分配') >= 0) return { cls: 'div', text: '已实施' };
    if (p.indexOf('股东大会通过') >= 0) return { cls: 'blue', text: '股东大会通过' };
    if (p.indexOf('董事会决议通过') >= 0) return { cls: 'gray', text: '董事会预案' };
    if (p.indexOf('取消') >= 0) return { cls: 'gray', text: '已取消' };
    return { cls: 'gray', text: p || '—' };
  }

  function dateCell(d) { return d ? d : '<span class="muted">—</span>'; }

  /** 指标旁的解释气泡 */
  function qmark(text) {
    return '<span class="qmark" data-act="explain" data-text="' + U.esc(text) + '">?</span>';
  }

  /**
   * 持仓的公司图标 URL。
   * 由同步管线多源解析后写进 symbols[sym].logoUrl（icon.horse → 公司官网 favicon → 同花顺 F10），
   * 每个候选都经过 canvas 验真，占位图不会走到这里。
   * 返回 null 时视图回退到「中文简称」文字头像。
   */
  function logoOf(h) {
    if (!h || !h.logoUrl) return null;
    try { if (XJ.store.state.settings.showLogo === false) return null; } catch (e) { /* 忽略 */ }
    return h.logoUrl;
  }

  /** 只有 symbol 时的公司图标（分红日历 / 年度总览等列表用） */
  function logoFor(symbol) {
    var meta = (XJ.store.state.symbols && XJ.store.state.symbols[symbol]) || {};
    return logoOf({ symbol: symbol, logoUrl: meta.logoUrl });
  }

  /* ---------------- 个股详情：跳转到独立页（见 views/symbol.js） ---------------- */
  function openSymbolDetail(symbol) {
    XJ.store.setUI({ subPage: 'symbol', subArg: symbol, floatOpen: false });
    window.scrollTo(0, 0);
  }

  return {
    logoOf: logoOf,
    logoFor: logoFor,
    accountSwitcher: accountSwitcher,
    slogan: slogan,
    statusBanner: statusBanner,
    planBasisLabel: planBasisLabel,
    costMethodLabel: costMethodLabel,
    progressLabel: progressLabel,
    qmark: qmark,
    openSymbolDetail: openSymbolDetail,
  };
})();

/* ---------------- 概览视图 ---------------- */
XJ.views.overview = (function () {
  var U = XJ.util, UI = XJ.ui, C = XJ.views.common;

  function sortHoldings(rows, mode) {
    var list = rows.slice();
    /* 排序一律用人民币口径：混币排序会让港股/美股的名次失真（港币数值天然更大） */
    if (mode === 'marketValue') list.sort(function (a, b) { return (b.marketValueCny || 0) - (a.marketValueCny || 0); });
    else if (mode === 'yield') list.sort(function (a, b) { return (b.dividendYield || 0) - (a.dividendYield || 0); });
    else if (mode === 'costYield') list.sort(function (a, b) { return (b.costYield || 0) - (a.costYield || 0); });
    else if (mode === 'pl') list.sort(function (a, b) { return (b.unrealizedPct || -1e9) - (a.unrealizedPct || -1e9); });
    else if (mode === 'holdDays') list.sort(function (a, b) { return (b.holdDays || 0) - (a.holdDays || 0); });
    else list.sort(function (a, b) { return (b.predictedDividend || 0) - (a.predictedDividend || 0); });
    return list;
  }

  /* ---------------- 年度分红卡（深色） ---------------- */
  /**
   * 当日参考盈亏（首页深色卡里的一行）。
   * 口径 = 现价相对【昨收】的浮动，人民币、跨币种已折算；缺昨收的标的跳过。
   * 文案刻意中性：只陈述数字，不给任何建议。
   */
  function todayPnlLine(s) {
    if (s.todayPnl === null || s.todayPnl === undefined) return '';
    var up = s.todayPnl >= 0;
    return '<div class="hd-today"><span class="' + (up ? 'c-up' : 'c-down') + '">' +
      (up ? '▲' : '▼') + ' 当日参考盈亏 ' + U.signMoney(s.todayPnl, 0) +
      (s.todayPnlPct === null ? '' : ' · ' + U.signPct(s.todayPnlPct)) + '</span>' +
      '<span class="hd-today-note">较昨收 · 跨币种已折算</span></div>';
  }

  function heroCard(st, s, proj, stat) {
    var cfg = st.state.settings;
    var collapsed = !!cfg.heroCollapsed;
    var all = XJ.model.HERO_METRICS;
    var chosen = (cfg.heroMetrics && cfg.heroMetrics.length) ? cfg.heroMetrics : all.map(function (m) { return m.key; });

    var vals = {
      receivedThisYear: U.moneySign(s.receivedThisYear, 0),
      totalCost: '¥' + U.moneyCompact(s.totalCost),
      totalMarketValue: '¥' + U.moneyCompact(s.totalMarketValue),
      costYield: s.costYield === null ? '已回本' : U.pct(s.costYield),
      marketYield: s.marketYield === null ? '—' : U.pct(s.marketYield),
      monthlyDividend: U.moneySign(s.monthlyDividend, 0),
    };
    var accent = { costYield: 1, marketYield: 1, monthlyDividend: 1, receivedThisYear: 1 };

    var metrics = chosen.map(function (key) {
      var m = all.filter(function (x) { return x.key === key; })[0];
      if (!m) return '';
      return '<div class="hd-metric' + (accent[key] ? ' accent' : '') + '">' +
        '<div class="k">' + U.esc(m.label) + C.qmark(m.hint) + '</div>' +
        '<div class="v">' + U.esc(vals[key] || '—') + '</div>' +
        '</div>';
    }).join('');

    var statusLine = stat.since
      ? '收息第 <b>' + stat.days + '</b> 天，你的耐心正在被时间奖励 🎁'
      : '还没有开始计算收息天数，添加第一笔买入即可';

    var years = U.n0(st.state.projection.years) || 10;
    var mult = proj.multiple ? '· ' + years + ' 年可达 <b>' + proj.multiple.toFixed(1) + ' 倍</b>' : '';

    /* 收起态必须保留一个「展开」按钮 —— 早先的实现把 .hd-actions 一起隐藏了，
       于是点「收起」之后再也没有入口能展开，等于把自己锁死。 */
    var actions = collapsed
      ? '<button class="hd-expand" data-act="toggleHero">展开 ⌄ 查看全部指标</button>' +
        '<button data-act="openMetricSettings">⚙ 设置指标</button>'
      : '<button data-act="toggleHero">收起 ⌃</button>' +
        '<button data-act="openMetricSettings">⚙ 设置指标</button>';

    return '<div class="hero-dark' + (collapsed ? ' collapsed' : '') + '">' +
      '<div class="hd-status">' + statusLine + '</div>' +
      '<div class="hd-row">' +
      '<div>' +
      '<div class="lbl">预测年度分红</div>' +
      '<div class="hd-amount"><span class="cur">¥</span>' + U.money(s.totalPredicted) + '</div>' +
      '</div>' +
      '<div class="hd-badge">基于 <b>' + s.count + '</b> 只持仓<br>' + mult + '</div>' +
      '</div>' +
      /* 当日参考盈亏：现价相对【昨收】的浮动（人民币口径，跨币种已折算）。
         刻意放在 hd-row 下方独立一行、不塞进 HERO_METRICS —— 老用户的
         settings.heroMetrics 里没有这个 key，塞进去会导致它默认不显示。 */
      (collapsed ? '' : todayPnlLine(s)) +
      (collapsed ? '' : '<div class="hd-metrics">' + metrics + '</div>') +
      (collapsed ? '' : forecastStrip(st, s)) +
      '<div class="hd-collapsed-hint">已收起 · 点下方「展开」查看全部指标</div>' +
      '<div class="hd-actions">' + actions + '</div>' +
      '</div>';
  }

  /* ---------------- 深色卡「测算带」 ----------------
   * 「在当前持仓下，每年投入 X 万、买入 y% 股息率的股票，N 年后月均预测分红约 Z」。
   *
   * Z 是**派生量**：永远等于 f(X, y, N, r) 的计算结果，不单独存储。
   * 编辑它只是「取目标 → 反解 N 或 X → 写回参数 → 重新正算」，
   * 所以界面上不可能出现与参数自相矛盾的数字（这是需求里「不允许计算矛盾」的落法）。
   * 口径与公式见 calc.js 的 forecastRows 注释；与「展望未来」是两套独立模型。 */
  function wanText(yuan) {
    return String(Math.round(U.n0(yuan) / 1000) / 10);   // 元 → 万，保留 1 位小数
  }

  function forecastStrip(st, s) {
    var cfg = st.state.settings.heroForecast || {};
    var P0 = U.n0(s.totalPredicted);
    var follow = (cfg.yieldPct === null || cfg.yieldPct === undefined);
    var mvYield = U.n0(s.marketYield);
    /* 未手改过 → 跟随组合市值息率；组合还没有市值数据时按 4% 假设（口径说明里写明） */
    var yPct = follow ? (mvYield > 0 ? mvYield : 4) : U.n0(cfg.yieldPct);

    var fc = XJ.calc.forecastRows({
      annualInvest: cfg.annualInvest, yieldPct: yPct,
      years: cfg.years, reinvestPct: cfg.reinvestPct,
    }, P0);
    var split = XJ.calc.forecastSplit(fc.monthly, P0 / 12);
    var solveFor = cfg.solveFor === 'invest' ? 'invest' : 'years';

    function numBtn(k, text) {
      return '<button class="hf-num" data-act="editForecast" data-k="' + k + '">' + U.esc(text) + '</button>';
    }

    return '<div class="hd-forecast">' +
      '<div class="hf-line">在当前持仓下，每年投入' +
      numBtn('annualInvest', wanText(fc.cfg.annualInvest)) + '万，买入' +
      numBtn('yieldPct', yPct.toFixed(1) + '%') + ' 股息率的股票，' +
      numBtn('years', String(fc.cfg.years)) + '年后月均预测分红约' +
      numBtn('monthly', U.moneySign(split.total, 0)) + '</div>' +
      '<div class="hf-sub">其中现有持仓 ' + U.moneySign(split.existing, 0) +
      ' + 新投入 ' + U.moneySign(split.fromNew, 0) +
      '<span class="hf-dot">·</span>分红再投' +
      numBtn('reinvestPct', String(Math.round(fc.cfg.reinvestPct)) + '%') + '</div>' +
      '<div class="hf-foot">' +
      '<span class="hf-solve">编辑月均时反解' +
      '<button class="hf-chip' + (solveFor === 'years' ? ' active' : '') +
      '" data-act="setForecastSolve" data-v="years">年数</button>' +
      '<button class="hf-chip' + (solveFor === 'invest' ? ' active' : '') +
      '" data-act="setForecastSolve" data-v="invest">每年投入</button></span>' +
      '<button class="hf-link" data-act="forecastDetail">逐年明细 ›</button>' +
      C.qmark('假设：现有持仓按当前「预测年度分红」保持不变；每年新投入与再投部分按你填的股息率生息；' +
        '再投发生在年末，从次年起才计息。股息率未手动设置时跟随当前组合市值息率（组合还没有市值数据时按 4% 假设）。' +
        '这里是按你设定的假设做的推演，与「发现 · 展望未来」是两套口径（那边把期初息率作用于全部资产），不代表实际收益。') +
      '</div></div>';
  }

  /* ---------------- 分红覆盖 ---------------- */
  function coverageCard(st, cov, ms) {
    /* 先算出「已点亮」集合，再排序：已覆盖的排左边、未覆盖的排右边，同组内按原顺序。
       （依赖 litKeys，所以顺序不能颠倒） */
    var litKeys = {};
    cov.items.forEach(function (it) { if (it.lit) litKeys[it.key] = true; });
    var nextKey = cov.nextItem ? cov.nextItem.key : null;
    var list = st.state.expenses.slice().sort(function (a, b) {
      var la = litKeys[a.key] ? 0 : 1;
      var lb = litKeys[b.key] ? 0 : 1;
      if (la !== lb) return la - lb;
      return (a.sortOrder || 0) - (b.sortOrder || 0);
    });

    var icons = list.map(function (e) {
      var on = litKeys[e.key];
      var cls = 'cover-icon' + (on ? ' on' : '') + (e.key === nextKey ? ' next' : '');
      return '<button class="' + cls + '" data-act="openExpenseEditor" data-key="' + U.esc(e.key) + '">' +
        '<span class="box">' + U.esc(e.icon || '💰') + '</span>' +
        '<span class="nm">' + U.esc(e.label) + '</span>' +
        '</button>';
    }).join('');

    return '<div class="card">' +
      '<div class="card-head">' +
      '<h2>分红覆盖</h2><div class="spacer"></div>' +
      '<span class="hint">' + U.esc(ms.name) + '</span>' +
      '<button class="ghost-btn" data-act="gotoTab" data-tab="find">详情</button></div>' +
      '<div class="cover-icons">' + icons + '</div>' +
      '<div style="display:flex;align-items:baseline;gap:8px;margin:4px 0 8px">' +
      '<div style="font-size:24px;font-weight:750;letter-spacing:-.8px;color:var(--dividend)">' + cov.litCount +
      '<span style="font-size:14px;color:var(--text-3);font-weight:600">/' + cov.totalCount + '</span></div>' +
      '<div class="muted" style="font-size:12.5px">项支出已被股息覆盖</div>' +
      '</div>' +
      '<div class="bar"><i style="width:' + cov.overallProgress.toFixed(1) + '%"></i></div>' +
      '<div class="tiny" style="margin-top:8px">' +
      (cov.nextItem
        ? '再攒 <b class="c-div">' + U.moneySign(cov.needMore) + '</b> 分红就能点亮 ' +
        (cov.nextItem.icon || '') + U.esc(cov.nextItem.label)
        : '全部支出项已被股息覆盖，恭喜！') +
      '</div>' +
      '</div>';
  }

  /* ---------------- 持仓卡片 ----------------
   * 结构：身份行（图标 / 名称 + 实心涨跌徽章 / 代码）→ 当日分时（交易时段内）→ 四列数据。
   * 代码用市场缩写大写（SH601919），不再单独挂「沪」标签，也不再写「· 股票」。
   */

  /**
   * 技术信号标记（BOLL 下轨 + KDJ 的 J<0）。
   *
   * 口径与红线：
   *   - 文案是中性的「日线下轨 / 周线下轨」，不出现「买入/卖出/推荐」等字样
   *     （项目红线：只做记录，不构成投资建议）。
   *   - 结果【绝不缓存】：K 线缓存是历史，现价每跳一次都可能让信号亮/灭，
   *     所以每次 render 都现算一遍。
   *   - 周线优先于日线（两个都亮时只显示周线）。
   *
   * @returns 有信号时返回 { text, cls }，否则 null
   */
  function signalOf(h) {
    var st = XJ.store;
    var cache = st.state.klineCache && st.state.klineCache[h.symbol];
    if (!cache || !cache.day || cache.day.length < 2) return null;
    var sig = XJ.calc.bollSignal(h.symbol, cache.day, cache.week || [], h.price, XJ.util.today());
    if (!sig) return null;
    return { text: sig.text, cls: sig.cls };
  }

  function holdingCard(h) {
    var chg = h.changePct;
    var dir = (chg === null || chg === undefined) ? 'flat' : U.direction(chg);
    /* 成本口径标签（分红摊薄 / 加权平均 / 摊薄成本）不再挂在名字旁 —— 太占地方，
       名字会被挤到只剩一两个字。口径在个股详情页的「持仓明细」里仍完整可见。
       这里只保留极少触发、但出现即重要的「已回本」。 */
    var tag = h.costRecovered ? '<span class="hc-tag pill div">已回本</span>' : '';
    var mvDec = (h.marketValueCny !== null && Math.abs(h.marketValueCny) >= 10000) ? 0 : 2;

    /* 技术信号（中性文案，随现价每次重算；周线优先于日线） */
    var sigObj = signalOf(h);
    var sig = sigObj
      ? '<span class="hc-sig ' + sigObj.cls + '">' + U.esc(sigObj.text) + '</span>'
      : '';

    /* 当日分时：收盘后也画（缓存里留着最近一个交易日的数据，落盘持久化）。
       非当日的数据挂一行小字标注日期，免得收盘后 / 周末看到一条静止曲线误以为实时。 */
    var min = XJ.store.minuteOf(h.symbol);
    var minToday = min && min.date === U.today();
    var showMin = !!(min && min.points && min.points.length >= 2);
    var intra = '';
    if (showMin) {
      var prev = h.prevClose;
      var chgAmt = (h.price !== null && h.price !== undefined && prev) ? h.price - prev : null;
      /* 当日参考盈亏（人民币口径）：持股数 ×（现价 − 昨收）× 该标的币种汇率 */
      var dayPnl = (chgAmt !== null && h.qty > 0) ? chgAmt * h.qty * (U.n0(h.fxRate) || 1) : null;
      /* 现价与涨跌额都按 2 位小数（A 股行情惯例，也对齐参考图的「16.20 / -0.18」） */
      intra = '<div class="hc-intra">' +
        '<div class="hc-spark">' + XJ.chart.sparkline(min.points, { prevClose: prev }) + '</div>' +
        '<div class="hc-px">' +
        '<b class="' + U.dirClass(chg) + '">' + (h.price === null ? '—' : U.money(h.price, 2)) + '</b>' +
        '<span class="' + U.dirClass(chgAmt) + '">' +
        (chgAmt === null ? '' : (chgAmt > 0 ? '+' : '') + U.money(chgAmt, 2)) + '</span>' +
        (minToday ? '' : '<i class="hc-at">' + U.esc(U.mdShort(min.date)) + '</i>') +
        '</div>' +
        /* 当日参考盈亏（金额）：持股数 ×（现价 − 昨收）× 汇率 —— 报价一变就跟着变 */
        (dayPnl === null ? '' : '<div class="hc-daypnl ' + U.dirClass(dayPnl) + '">当日 ' +
          U.signMoney(dayPnl, 0) + '</div>') +
        '</div>';
    }

    /* 卡片主体是「进详情」按钮，删除是独立按钮 —— 不能嵌套 button */
    return '<div class="hold-card">' +
      '<button class="hc-main" data-act="openSymbol" data-symbol="' + U.esc(h.symbol) + '">' +
      '<div class="hc-head">' +
      UI.avatar(h.name, h.symbol, 42, C.logoOf(h), 'hc-avatar') +
      '<div class="hc-id">' +
      /* 名字独占第一行（涨跌幅徽章已移到下一行的代码旁），窄屏也能完整显示 */
      '<div class="hc-name"><span class="nm">' + U.esc(h.name) + '</span>' + tag + '</div>' +
      '<div class="hc-code">' + U.esc(XJ.market.displayCode(h.symbol)) +
      (chg === null || chg === undefined ? '' : '<span class="chg ' + dir + '">' + U.signPct(chg) + '</span>') +
      sig +
      '</div>' +
      '</div>' +
      '<div class="hc-right">' +
      '<div class="hc-div">' + U.moneySign(h.predictedDividendCny) + '</div>' +
      '<div class="hc-div-lbl">预测分红</div>' +
      '</div>' +
      '</div>' +
      intra +
      '<div class="hc-grid">' +
      '<div class="hc-cell"><div class="k">持仓</div><div class="v">' + U.thousands(h.qty) + '股</div></div>' +
      '<div class="hc-cell"><div class="k">市值</div><div class="v">' + U.moneySign(h.marketValueCny, mvDec) + '</div></div>' +
      '<div class="hc-cell"><div class="k">成本</div><div class="v' + (h.avgCost < 0 ? ' c-div' : '') + '">' + U.money(h.avgCost, 4) + '</div></div>' +
      '<div class="hc-cell"><div class="k">股价息</div><div class="v c-div">' + (h.dividendYield === null ? '—' : U.pct(h.dividendYield)) + '</div></div>' +
      '</div>' +
      '</button>' +
      '<button class="hc-del" data-act="deleteHolding" data-symbol="' + U.esc(h.symbol) + '" ' +
      'aria-label="删除该持仓" title="删除该持仓">' + UI.icon('trash', 15, 1.8) + '</button>' +
      '</div>';
  }

  /* ---------------- 市场筛选芯片 ---------------- */
  function marketChips(st, rows) {
    var counts = { all: rows.length };
    rows.forEach(function (h) { counts[h.assetType] = (counts[h.assetType] || 0) + 1; });
    var order = [
      { key: 'all', label: '全部' },
      { key: 'stock', label: 'A股' },
      { key: 'etf', label: 'ETF' },
      { key: 'of', label: '场外基金' },
      { key: 'hk', label: '港股' },
      { key: 'us', label: '美股' },
    ];
    var cur = st.ui.marketFilter || 'all';
    var visible = order.filter(function (o) { return counts[o.key]; });
    // 只有一种资产类型时，筛选没有意义
    if (visible.filter(function (o) { return o.key !== 'all'; }).length <= 1) return '';
    return '<div class="chips">' + visible.map(function (o) {
      return '<button class="chip' + (o.key === cur ? ' active' : '') + '" data-act="setMarketFilter" data-key="' + o.key + '">' +
        '<span class="dotm"></span>' + U.esc(o.label) + ' ' + (counts[o.key] || 0) + '</button>';
    }).join('') + '</div>';
  }

  function render() {
    var st = XJ.store;
    var s = XJ.calc.summary(st.state, st.acc());
    var cov = XJ.calc.coverage(s.totalPredicted, st.state.expenses, 7);
    var ms = XJ.calc.milestone(cov.overallProgress);
    var proj = XJ.calc.projection(st.state.projection, s.totalMarketValue, s.totalPredicted);
    var stat = XJ.calc.statDays(st.state, st.acc());

    var html = '';
    html += C.statusBanner();
    html += C.accountSwitcher();

    if (!st.hasAnyData()) {
      html += UI.emptyState('🌱', '还没有持仓记录',
        '添加第一只持仓，开始记录你的每一笔股息收入。只需股票代码、持有数量和成本价。',
        '<button class="ghost-btn primary" data-act="openAddHolding">' + UI.icon('plus', 15) + ' 添加持仓</button>');
      html += renderAboutCard();
      return html;
    }

    html += heroCard(st, s, proj, stat);
    html += '<div class="slogan-bar">' + UI.icon('info', 15) + '<span>' + U.esc(C.slogan()) + '</span></div>';
    html += coverageCard(st, cov, ms);

    /* ---- 资产走势（市值 / 净资产曲线，卡片自带标题与折叠） ---- */
    html += XJ.views.networth.render();

    /* ---- 我的持仓 ---- */
    var all = sortHoldings(s.holdings, st.ui.sortMode);
    var filter = st.ui.marketFilter || 'all';
    var rows = filter === 'all' ? all : all.filter(function (h) { return h.assetType === filter; });

    var sortLabel = {
      dividend: '预测分红', marketValue: '市值', yield: '股价息',
      costYield: '成本息率', pl: '盈亏', holdDays: '持股天数',
    }[st.ui.sortMode] || '预测分红';

    html += '<div class="section-title" style="display:flex;align-items:center">' +
      '<span>我的持仓 · ' + all.length + ' 只</span><span style="flex:1"></span>' +
      '<span class="tiny">按' + sortLabel + '排序</span></div>';

    html += '<div class="chips">' + [['dividend', '分红'], ['marketValue', '市值'], ['yield', '股价息'], ['costYield', '成本息率'], ['pl', '盈亏']].map(function (o) {
      return '<button class="chip' + (st.ui.sortMode === o[0] ? ' active' : '') + '" data-act="setSort" data-mode="' + o[0] + '">' + o[1] + '</button>';
    }).join('') + '</div>';

    html += marketChips(st, all);

    if (!rows.length) {
      html += UI.emptyState('📭', '没有符合条件的持仓', '换个筛选条件，或添加一笔新的持仓。',
        '<button class="ghost-btn primary" data-act="openAddHolding">添加持仓</button>');
    } else {
      html += '<div class="hold-list">' + rows.map(holdingCard).join('') + '</div>';
    }

    html += '<div style="margin-top:12px"><button class="btn-block ghost" data-act="openAddHolding">' +
      UI.icon('plus', 16) + ' 添加持仓</button></div>';

    html += renderAboutCard();
    return html;
  }

  function renderAboutCard() {
    return '<div class="card" style="margin-top:14px">' +
      '<div class="tiny" style="line-height:1.8">' +
      '<b style="color:var(--text-2)">只做记录</b> · 本应用不提供股票买卖、不推荐标的、不提供任何投资建议。' +
      '分红方案来自公开数据，派息日为按除权除息日推算的<b>预估值</b>（基金/港股为数据源给出的真实发放日），请以券商实际到账为准。' +
      '</div></div>';
  }

  return {
    render: render,
    sortHoldings: sortHoldings,
    holdingCard: holdingCard,
    heroCard: heroCard,
    marketChips: marketChips,
  };
})();
