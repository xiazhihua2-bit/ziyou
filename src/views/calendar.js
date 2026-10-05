/* ==================== 视图：分红日历 + 年度总览（同一 Tab 分段切换） ==================== */
XJ.views.calendar = (function () {
  var U = XJ.util, UI = XJ.ui, C = XJ.views.common;

  var TYPE_META = {
    register: { dot: 'register', color: 'var(--blue)', label: '股权登记日' },
    exdiv: { dot: 'exdiv', color: 'var(--up)', label: '除权除息日' },
    payout: { dot: 'payout', color: 'var(--payout)', label: '派息日' },
  };

  /* ---------------- 顶部切换 ---------------- */
  function segSwitch(st) {
    var cur = st.ui.calView || 'calendar';
    return '<div class="segmented" style="margin-bottom:12px">' +
      [['calendar', '日历'], ['annual', '年度总览']].map(function (o) {
        return '<button class="' + (o[0] === cur ? 'active' : '') + '" data-act="setCalView" data-v="' + o[0] + '">' + o[1] + '</button>';
      }).join('') + '</div>';
  }

  /* ---------------- 待除权（已公布方案、等待除权日）—— 对齐息记的卡片样式 ---------------- */
  /** 去掉多余的尾随 0：2.0000 → 2、25.1000 → 25.1、8.1331 → 8.1331 */
  function trimNum(v) {
    var s = U.money(v, 4);
    return s.indexOf('.') >= 0 ? s.replace(/\.?0+$/, '') : s;
  }

  function pendingCard(st, pend) {
    if (!pend.count) return '';
    var collapsed = XJ.store.folded('pendCollapsed');   // 默认折叠（util.FOLD.collapsed）
    return '<div class="pend-card' + (collapsed ? ' collapsed' : '') + '">' +
      '<button class="pend-head" data-act="togglePend">' +
      '<span class="pend-ico">💌</span>' +
      '<span class="pend-hmain">' +
      '<span class="pend-title">你有 <b>' + pend.count + '</b> 只持仓已公布分红方案，等待除权日</span>' +
      '<span class="pend-sub" data-anim="A">预计共可得 <b>' + U.moneySign(pend.total) + '</b>' +
      /* 除权日还没公告的那部分金额是估算，这里如实说明，不混进确定值里 */
      (pend.undatedTotal > 0
        ? '<i class="pend-subnote" data-anim="A">其中 ' + U.moneySign(pend.undatedTotal) + ' 除权日待定</i>'
        : '') +
      '</span>' +
      '</span>' +
      '<span class="pend-caret">' + UI.icon('chevron', 16) + '</span>' +
      '</button>' +
      '<div class="pend-body">' +
      pend.items.map(function (it) {
        /* 第二行右侧放「除权日 / 除权日待定」；日期只显示 MM-DD（完整日期放 title），
           否则窄屏上会把左边的「每10股派 X 元 · 持有 N股」挤掉 */
        return '<button class="pend-item" data-act="openSymbol" data-symbol="' + U.esc(it.symbol) +
          '" title="' + U.esc(it.exDate ? '除权日 ' + it.exDate : '除权日尚未公告（金额按当前持股数预估）') + '">' +
          '<span class="pi-row">' +
          '<span class="pi-name">' + U.esc(it.name) +
          '<i class="pi-tag">' + U.esc(XJ.market.displayCode(it.symbol)) + '</i></span>' +
          '<span class="pi-amt" data-anim="A">' + U.moneySign(it.amount) + '</span>' +
          '</span>' +
          '<span class="pi-row">' +
          '<span class="pi-desc">每10股派 ' + trimNum(it.per10) + ' 元 · 持有 ' + U.thousands(it.qty) + '股</span>' +
          '<span class="pi-when">' + (it.exDate
            ? '除权日 ' + U.esc(String(it.exDate).slice(5))
            : '<i class="pi-tbd">除权日待定</i>') +
          (it.undatedCount && it.exDate ? ' +' + it.undatedCount + ' 待定' : '') +
          '</span>' +
          '</span>' +
          '</button>';
      }).join('') +
      '<div class="pend-foot">📅 ' + (pend.undatedCount
        ? '除权日尚未公告的方案，金额按当前持股数预估；'
        : '') +
      '除权日确定后的第二天，会自动排进日历，到账当天系统自动登记</div>' +
      '</div>' +
      '</div>';
  }

  /* ---------------- 日历 ---------------- */
  function eventLine(e) {
    var m = TYPE_META[e.type] || TYPE_META.payout;
    var right = e.amount === null || e.amount === undefined
      ? ''
      : '<div class="row-v c-div">' + U.moneySign(e.amount) + '</div>';
    var sub = (e.type === 'payout')
      ? '每股派息 ' + U.money(e.perShare, 4) + ' · 登记数量 ' + U.thousands(e.qty) + ' 股 · ' +
      (e.isEstimate ? '预计派息日到账 ' : '派息日到账 ') + U.moneySign(e.amount)
      : '每股派息 ' + U.money(e.perShare, 4) + ' · 登记数量 ' + U.thousands(e.qty) + ' 股';
    return '<button class="list-row" data-act="openSymbol" data-symbol="' + U.esc(e.symbol) + '">' +
      UI.avatar(e.name, e.symbol, 38, C.logoFor(e.symbol)) +
      '<div class="row-main">' +
      '<div class="row-t"><span class="nm">' + U.esc(e.name) + '</span>' +
      (e.isImplemented ? '' : '<span class="pill gray">预案</span>') +
      '</div>' +
      '<div class="row-s">' + U.esc(XJ.market.displayCode(e.symbol)) + ' · ' +
      '<span style="color:' + m.color + ';font-weight:600">' + U.esc(m.label) + '</span> · ' + sub + '</div>' +
      '</div>' +
      '<div class="row-right">' + right +
      '<div class="row-v2">' + U.esc(e.reportDate.slice(0, 7)) + ' ' + U.esc(e.reportType) + '</div>' +
      '</div>' +
      '<span class="chev">' + UI.icon('chevron', 16) + '</span>' +
      '</button>';
  }

  function monthGrid(mv, selDate) {
    var first = new Date(mv.year, mv.month - 1, 1);
    var startPad = first.getDay();
    var daysInMonth = new Date(mv.year, mv.month, 0).getDate();
    var prevDays = new Date(mv.year, mv.month - 1, 0).getDate();
    var today = U.today();

    var cells = '';
    for (var i = startPad - 1; i >= 0; i--) cells += '<div class="cal-cell other">' + (prevDays - i) + '</div>';
    for (var d = 1; d <= daysInMonth; d++) {
      var ds = mv.year + '-' + U.pad2(mv.month) + '-' + U.pad2(d);
      var evs = mv.byDate[ds] || [];
      var types = {};
      evs.forEach(function (e) { types[e.type] = true; });
      var cls = 'cal-cell';
      if (ds === today) cls += ' today';
      else if (evs.length) cls += ' has';
      if (selDate === ds && ds !== today) cls += ' sel';
      var dots = ['register', 'exdiv', 'payout'].filter(function (t) { return types[t]; })
        .map(function (t) { return '<span class="cal-dot ' + t + '"></span>'; }).join('');
      cells += '<div class="' + cls + '"' + (evs.length ? ' data-act="selDate" data-date="' + ds + '"' : '') + '>' +
        '<span>' + d + '</span>' +
        (dots ? '<span class="cal-dots">' + dots + '</span>' : '<span class="cal-dots"></span>') +
        '</div>';
    }
    var total = startPad + daysInMonth;
    var tail = (7 - (total % 7)) % 7;
    for (var t = 1; t <= tail; t++) cells += '<div class="cal-cell other">' + t + '</div>';
    return cells;
  }

  function renderCalendar(st, acc) {
    var y = st.ui.calYear, m = st.ui.calMonth;
    var mv = XJ.calc.monthView(st.state, acc, y, m);
    var pend = XJ.calc.pendingExDiv(st.state, acc);
    var html = '';

    /* 待除权：已公布分红方案、等待除权日（息记同款卡片） */
    if (pend.count > 0) {
      html += pendingCard(st, pend);
    } else if (mv.receivedTotal > 0) {
      html += '<div class="cal-banner" data-anim="A" style="background:var(--payout-banner-grad);border-color:var(--payout-banner-line);color:var(--payout-banner-fg)">' +
        '本月已到账分红 <b style="color:var(--down)">' + U.moneySign(mv.receivedTotal) + '</b>，当前没有等待除权的方案。</div>';
    } else {
      html += '<div class="cal-banner" data-anim="A" style="background:var(--card-2);border-color:var(--line);color:var(--text-2)">' +
        '当前没有等待除权的分红方案。</div>';
    }

    /* 月历（平板横屏时与右侧事件区并排，见 style.css 的 .cal-split） */
    html += '<div class="cal-split">';
    html += '<div class="card">' +
      '<div class="cal-head">' +
      '<button class="icon-btn" data-act="calPrev">' + UI.icon('chevron', 16) + '</button>' +
      '<div class="ym">' + y + ' 年 ' + m + ' 月</div>' +
      '<button class="icon-btn" data-act="calNext">' + UI.icon('chevron', 16) + '</button>' +
      '</div>' +
      '<div style="text-align:center;margin:-6px 0 10px"><button class="tiny" style="color:var(--blue);font-weight:600" data-act="calToday">点击回今天</button></div>' +
      '<div class="cal-week"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div>' +
      '<div class="cal-grid">' + monthGrid(mv, st.ui.selDate) + '</div>' +
      '<div class="cal-legend">' +
      '<span><i style="background:var(--blue)"></i>股权登记</span>' +
      '<span><i style="background:var(--up)"></i>除权除息</span>' +
      '<span><i style="background:var(--payout)"></i>派息日</span>' +
      '</div>' +
      '<div class="note-line" style="justify-content:center;margin-top:12px">' +
      UI.icon('info', 13) +
      '<span>分红数据已更新至上一个交易日，新披露的方案次日排入日历；A 股口径为「派息日 = 除权除息日」（数据源无独立派息日字段），基金与港股为数据源给出的真实发放日</span>' +
      '</div>' +
      '</div>';

    /* 当日 / 当月事件（右侧一列，与左侧月历并排，见 .cal-split） */
    html += '<div class="cal-col">';
    var sel = st.ui.selDate;
    var listEvents = sel ? (mv.byDate[sel] || []) : mv.events;
    var title = sel ? (sel + ' · ' + listEvents.length + ' 个事件') : ('本月全部事件 · ' + mv.events.length);

    html += '<div class="section-title" style="display:flex;align-items:center"><span>' + U.esc(title) + '</span>' +
      '<span style="flex:1"></span>' +
      (sel ? '<button class="tiny" style="color:var(--blue);font-weight:600" data-act="selDate" data-date="">显示全月</button>' : '') +
      '</div>';

    if (!listEvents.length) {
      html += '<div class="card"><div class="tiny" style="text-align:center;padding:14px 0">' +
        (sel ? '这一天没有分红安排。' : '本月没有分红安排。') + '</div></div>';
    } else {
      html += '<div class="list">' + listEvents.map(eventLine).join('') + '</div>';
    }
    html += '</div>';                 // 收 .cal-col
    html += '</div>';                 // 收 .cal-split
    return html;
  }

  /* ---------------- 年度总览 ---------------- */
  function renderAnnual(st, acc) {
    var years = XJ.calc.availableYears(st.state, acc);
    var year = st.ui.annualYear || years[0] || U.yearOf(U.today());
    var av = XJ.calc.annualView(st.state, acc, year);
    var max = Math.max.apply(null, av.months.concat([1]));
    var curMonth = U.monthOf(U.today());
    var isCurYear = year === U.yearOf(U.today());

    /* 默认选中月：优先当月（有数据时），否则取最近有数据的月份，再否则取当月 */
    var selMonth = st.ui.annualMonth;
    if (!selMonth) {
      if (isCurYear && av.months[curMonth - 1] > 0) selMonth = curMonth;
      else {
        for (var i = 12; i >= 1; i--) { if (av.months[i - 1] > 0) { selMonth = i; break; } }
        if (!selMonth) selMonth = isCurYear ? curMonth : 12;
      }
    }

    var html = '';

    /* 年份切换 */
    html += '<div class="cal-head">' +
      '<button class="icon-btn" data-act="annualPrev">' + UI.icon('chevron', 16) + '</button>' +
      '<div class="ym">' + year + ' 年</div>' +
      '<button class="icon-btn" data-act="annualNext">' + UI.icon('chevron', 16) + '</button>' +
      '</div>' +
      '<div style="text-align:center;margin:-6px 0 12px"><span class="tiny">年度分红总览</span></div>';

    /* 大数字 */
    html += '<div class="card" style="background:var(--slogan-grad);border:1px solid var(--warn-line)">' +
      '<div style="font-size:12px;color:var(--warn-fg)">年度已到账分红</div>' +
      '<div style="font-size:34px;font-weight:750;letter-spacing:-1.2px;color:var(--dividend);margin-top:4px">' +
      U.moneySign(av.total) + '</div>' +
      '<div class="tiny" style="margin-top:6px">共 ' + U.cn(av.count) + ' 笔，来自 ' + av.symbolCount + ' 只持仓</div>' +
      '</div>';

    /* 柱状图 */
    html += '<div class="card">' +
      '<div class="bars">' + av.months.map(function (v, i) {
        var mo = i + 1;
        var pct = max > 0 ? Math.max(0, v / max * 100) : 0;
        var cls = 'bar-col' + (v <= 0 ? ' zero' : '') + (mo === selMonth ? ' sel' : '');
        return '<button class="' + cls + '" data-act="selAnnualMonth" data-m="' + mo + '" style="background:none;padding:0">' +
          (mo === selMonth && v > 0 ? '<span class="amt">' + U.moneySign(v, 0) + '</span>' : '') +
          '<span class="barv" style="height:' + (v > 0 ? Math.max(6, pct) : 0) + '%"></span>' +
          '<span class="mm">' + mo + '</span>' +
          '</button>';
      }).join('') + '</div>' +
      '<div class="bar-legend">' +
      '<span><i style="background:var(--dividend-mid)"></i>已到账</span>' +
      '<span><i style="background:var(--fill)"></i>暂无记录</span>' +
      '<span><i style="background:var(--dividend)"></i>选中月</span>' +
      '</div>' +
      '</div>';

    /* 月度明细 */
    var monthRecords = av.records.filter(function (r) { return U.monthOf(r.exDividendDate) === selMonth; });
    var monthTotal = U.sum(monthRecords, function (r) { return r.amount; });
    html += '<div class="section-title" style="display:flex;align-items:center">' +
      '<span>' + selMonth + '月到账明细</span><span style="flex:1"></span>' +
      '<span class="c-div" style="font-weight:700">' + U.moneySign(monthTotal) + '</span></div>';

    if (!monthRecords.length) {
      html += '<div class="card"><div class="tiny" style="text-align:center;padding:14px 0">该月没有到账记录。</div></div>';
    } else {
      html += '<div class="list">' + monthRecords.map(function (r) {
        return '<button class="list-row" data-act="openSymbol" data-symbol="' + U.esc(r.symbol) + '">' +
          UI.avatar(XJ.store.symbolName(r.symbol), r.symbol, 38, C.logoFor(r.symbol)) +
          '<div class="row-main">' +
          '<div class="row-t"><span class="nm">' + U.esc(XJ.store.symbolName(r.symbol)) + '</span></div>' +
          '<div class="row-s">' + U.esc(XJ.market.displayCode(r.symbol)) + ' · ' +
          U.esc(r.exDividendDate) + ' 到账 · ' + U.thousands(r.qtyAtRecord) + ' 股 × ' +
          U.money(r.perShareAmount, 4) + '</div>' +
          '</div>' +
          '<div class="row-right"><div class="row-v c-div">' + U.moneySign(r.amount) + '</div></div>' +
          '<span class="chev">' + UI.icon('chevron', 16) + '</span>' +
          '</button>';
      }).join('') + '</div>';
    }

    /* 月均 */
    html += '<div class="card" style="margin-top:12px;background:var(--slogan-grad)">' +
      '<div class="tiny" style="color:var(--warn-fg)">平均每月到账，持仓在默默为你工作 🌱</div>' +
      '<div style="font-size:18px;font-weight:700;color:var(--dividend);margin-top:4px">' +
      U.moneySign(av.monthlyAvg) + '<span class="tiny" style="color:var(--pend-text);font-weight:400;margin-left:6px">/月</span></div>' +
      '<div class="tiny" style="margin-top:4px">' +
      (isCurYear ? '按已过去的 ' + av.denom + ' 个月平均' : '按 12 个月平均') + '</div>' +
      '</div>';

    return html;
  }

  function render() {
    var st = XJ.store;
    var acc = st.acc();
    var html = '';
    html += C.statusBanner();
    html += C.accountSwitcher();

    if (!st.hasAnyData()) {
      html += UI.emptyState('📅', '暂无分红日历',
        '添加持仓并同步分红方案后，这里会显示每只标的的股权登记日、除权除息日与派息日。',
        '<button class="ghost-btn primary" data-act="openAddHolding">添加持仓</button>');
      return html;
    }

    html += segSwitch(st);
    html += (st.ui.calView === 'annual') ? renderAnnual(st, acc) : renderCalendar(st, acc);
    return html;
  }

  return { render: render, TYPE_META: TYPE_META };
})();
