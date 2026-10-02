/* ==================== 视图：规划（息覆生活 / 展望未来 / 股息统计） ==================== */
XJ.views.plan = (function () {
  var U = XJ.util, UI = XJ.ui, C = XJ.views.common;

  /* ---------------- 息覆生活 ---------------- */
  function renderCoverage(s, cov, st) {
    var ms = XJ.calc.milestone(cov.overallProgress);

    var stepper = ms.all.map(function (m, i) {
      var on = i <= ms.index;
      return '<div style="flex:1;text-align:center">' +
        '<div style="height:6px;border-radius:3px;background:' + (on ? 'var(--dividend)' : 'var(--fill)') + '"></div>' +
        '<div class="tiny" style="margin-top:5px;color:' + (on ? 'var(--dividend)' : 'var(--text-3)') +
        ';font-weight:' + (i === ms.index ? '700' : '400') + '">' + U.esc(m.name) + '</div>' +
        '</div>';
    }).join('<div style="width:4px"></div>');

    var html = '';
    html += '<div class="card">' +
      '<div class="card-head"><h2>分红覆盖</h2><div class="spacer"></div>' +
      '<span class="hint">已覆盖 ' + cov.litCount + '/' + cov.totalCount + ' 项</span></div>' +
      '<div class="metric-grid" style="margin-bottom:14px">' +
      '<div class="metric" style="box-shadow:none;background:var(--card-2)"><div class="k">固定支出总额</div><div class="v">' +
      U.moneySign(cov.totalAnnual, 0) + '</div><div class="s">年</div></div>' +
      '<div class="metric" style="box-shadow:none;background:var(--card-2)"><div class="k">预计年度分红</div><div class="v c-div">' +
      U.moneySign(cov.annualDividend, 0) + '</div><div class="s">年</div></div>' +
      '<div class="metric" style="box-shadow:none;background:var(--card-2)"><div class="k">今年已实收</div><div class="v">' +
      U.moneySign(s.receivedThisYear, 0) + '</div><div class="s">年</div></div>' +
      '</div>' +
      '<div style="display:flex;gap:4px;margin-bottom:14px">' + stepper + '</div>' +
      '<div class="kv"><span class="k">当前阶段</span><span class="v c-div">' + U.esc(ms.name) + '</span></div>' +
      '<div class="kv"><span class="k">整体覆盖进度</span><span class="v">' + U.pct(cov.overallProgress, 1) + '</span></div>' +
      (ms.next ? '<div class="kv"><span class="k">下一目标</span><span class="v muted" style="font-weight:500">' + U.esc(ms.next.name) + '（覆盖率 ' + ms.next.pct + '%）</span></div>' : '') +
      '</div>';

    /* 分红汇总入口卡 —— 刻意夹在「分红覆盖」与「下一个目标」之间。
       若「下一个目标」卡不存在（cov.nextItem 为空），入口依然紧跟分红覆盖之后，位置不变。 */
    var dsum = XJ.calc.dividendSummary(st.state, st.acc(), { type: 'year' });
    html += '<button class="card ds-entry" data-act="openDivSum">' +
      '<div class="row-main">' +
      '<div class="row-t">分红汇总</div>' +
      '<div class="row-s">今年已到账 ' + dsum.count + ' 笔' +
      (dsum.pendingTotal > 0 ? ' · 另有 ' + U.moneySign(dsum.pendingTotal, 0) + ' 预计' : '') +
      '</div></div>' +
      '<span class="ds-entry-v">' + U.moneySign(dsum.total) + '</span>' +
      '<span class="chev">' + UI.icon('chevron', 16, 2) + '</span>' +
      '</button>';

    /* 反推加仓提示 */
    if (cov.nextItem) {
      html += '<div class="card" style="background:var(--exp-lit-grad);border:1px solid var(--exp-lit-line)">' +
        '<div class="card-head" style="margin-bottom:8px"><h2 style="color:var(--pend-tag-fg)">下一个目标</h2></div>' +
        '<div style="font-size:15px;font-weight:650;color:var(--pend-tag-fg);margin-bottom:6px">' +
        U.esc(cov.nextItem.label) + ' · ' + U.moneySign(cov.nextItem.annualAmount, 0) + '/年</div>' +
        '<div class="bar"><i style="width:' + cov.nextItem.progress.toFixed(1) + '%"></i></div>' +
        '<div style="font-size:13px;color:var(--pend-tag-fg);margin-top:10px">' +
        '进度 ' + U.pct(cov.nextItem.progress, 0) + '，还差 <b>' + U.moneySign(cov.needMore) + '</b> 分红</div>' +
        '<div class="tiny" style="margin-top:6px;color:var(--pend-text)">' +
        '按假设息率 ' + U.pct(cov.assumedYieldPct, 0) + ' 测算，加仓约 <b>' + U.moneySign(cov.addCapital, 0) + '</b> 的高息标的即可点亮' +
        '</div>' +
        '</div>';
    }

    /* 支出项 */
    html += '<div class="section-title">支出项明细</div>';
    html += '<div class="exp-grid">' + cov.items.map(function (it) {
      return '<div class="exp-item' + (it.lit ? ' lit' : '') + '">' +
        '<div class="top"><span class="name">' + U.esc(it.label) + '</span></div>' +
        '<div class="amt" style="text-align:center">' + U.moneySign(it.monthlyAmount, 0) + '/月 · ' + U.moneySign(it.annualAmount, 0) + '/年</div>' +
        '<div class="bar' + (it.lit ? '' : ' blue') + '"><i style="width:' + it.progress.toFixed(1) + '%"></i></div>' +
        '<div class="state" style="text-align:center;color:' + (it.lit ? 'var(--dividend)' : 'var(--text-3)') + '">' +
        (it.lit ? '✓ 已覆盖' : '还差 ' + U.moneySign(it.remaining, 0)) +
        '</div>' +
        '</div>';
    }).join('') + '</div>';

    html += '<div style="margin-top:12px"><button class="btn-block ghost" data-act="openExpenses">编辑支出项</button></div>';
    return html;
  }

  /* ---------------- 展望未来 ---------------- */
  function renderProjection(s, proj, cfg) {
    var html = '';
    html += '<div class="card">' +
      '<div class="card-head"><h2>展望未来</h2><div class="spacer"></div><span class="hint">调整你的计划</span></div>' +
      '<div class="field-row">' +
      '<div class="field"><label>每月定投（元）</label>' +
      '<input type="text" inputmode="decimal" data-k="monthlyInvest" data-change="setProjection" value="' + U.n0(cfg.monthlyInvest) + '"></div>' +
      '<div class="field"><label>展望年限（年）</label>' +
      '<input type="text" inputmode="numeric" data-k="years" data-change="setProjection" value="' + U.n0(cfg.years) + '"></div>' +
      '</div>' +
      '<div class="field"><label>分红再投比例</label>' +
      '<div class="segmented">' +
      [0, 0.5, 1].map(function (r) {
        return '<button class="' + (Math.abs(U.n0(cfg.reinvestRatio) - r) < 1e-6 ? 'active' : '') +
          '" data-act="setReinvest" data-v="' + r + '">' + Math.round(r * 100) + '%</button>';
      }).join('') + '</div></div>' +
      '</div>';

    html += '<div class="card" style="background:var(--hero-grad)">' +
      '<div class="metric-grid" style="margin:0">' +
      '<div class="metric" style="box-shadow:none;background:transparent;padding:0">' +
      '<div class="k">现在每年</div><div class="v c-div">' + U.moneyCompact(proj.startDividend) + '</div>' +
      '<div class="s">' + U.moneySign(proj.startDividend / 12, 0) + '/月</div></div>' +
      '<div class="metric" style="box-shadow:none;background:transparent;padding:0">' +
      '<div class="k">' + U.n0(cfg.years) + ' 年后每年</div><div class="v c-div">' + U.moneyCompact(proj.endDividend) + '</div>' +
      '<div class="s">' + U.moneySign(proj.endDividend / 12, 0) + '/月</div></div>' +
      '<div class="metric" style="box-shadow:none;background:transparent;padding:0">' +
      '<div class="k">增长倍数</div><div class="v">' + (proj.multiple ? '×' + proj.multiple.toFixed(1) : '—') + '</div>' +
      '<div class="s">期初息率 ' + U.pct(proj.yieldPct) + '</div></div>' +
      '</div>' +
      '<div class="tiny" style="margin-top:10px">模型：每年先计入定投，再按期初组合息率计算当年分红，分红按设定比例再投。</div>' +
      '</div>';

    html += '<div class="card flush">' +
      '<div style="padding:14px 16px 8px"><div class="card-head" style="margin:0"><h2>逐年变化</h2>' +
      '<div class="spacer"></div><span class="hint">每年定投 + 分红再投后</span></div></div>' +
      '<div class="table-wrap"><table class="tbl"><thead><tr>' +
      '<th>年份</th><th>当年预计分红</th><th>年末预计资产</th></tr></thead><tbody>';
    proj.rows.forEach(function (r) {
      html += '<tr><td>第 ' + r.year + ' 年 <span class="tiny">' + r.calendarYear + '</span></td>' +
        '<td class="c-div">' + U.moneySign(r.dividend, 0) + '</td>' +
        '<td>' + U.moneySign(r.assetsEnd, 0) + '</td></tr>';
    });
    html += '</tbody></table></div></div>';
    return html;
  }

  /* 原「股息统计」区块（年度汇总 + 按标的）已整体移除：
     内容搬进了独立的「分红汇总」页（src/views/divsummary.js），入口就在上面那张分红汇总卡。
     放在这里会让同一份数据在发现页渲染两遍。 */

  /* ---------------- 主渲染 ---------------- */
  function render() {
    var st = XJ.store;
    var s = XJ.calc.summary(st.state, st.acc());
    var html = '';
    html += C.statusBanner();
    html += C.accountSwitcher();

    if (!st.hasAnyData()) {
      html += UI.emptyState('🎯', '暂无规划数据', '先添加持仓，息覆生活与展望未来会自动基于你的分红数据计算。',
        '<button class="ghost-btn primary" data-act="openAddHolding">添加持仓</button>');
      return html;
    }

    var cov = XJ.calc.coverage(s.totalPredicted, st.state.expenses, 7);
    html += renderCoverage(s, cov, st);
    html += '<div class="section-title">展望未来</div>';
    html += renderProjection(s, XJ.calc.projection(st.state.projection, s.totalMarketValue, s.totalPredicted), st.state.projection);
    /* 「股息统计」区块已移除 —— 内容整体搬进了独立的「分红汇总」页（入口就在上面的分红覆盖卡下面） */
    return html;
  }

  return { render: render };
})();
