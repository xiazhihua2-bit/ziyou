/* ==================== 视图：账户分析（Pro 核心卖点） ==================== */
XJ.views.analysis = (function () {
  var U = XJ.util, UI = XJ.ui, C = XJ.views.common;

  function render() {
    var st = XJ.store;
    var acc = st.acc();
    var an = XJ.calc.analytics(st.state, acc);
    var s = an.summary;
    var delta = XJ.calc.snapshotDelta(st.state);
    var lastQuote = st.state.settings.lastQuoteAt;
    var priceDate = lastQuote ? String(lastQuote).slice(5, 10).replace('-', '月') + '日' : '最近交易日';

    var html = '';

    /* ① 风险提醒（诚实前置） */
    html += '<div class="warn-card"><span class="ic">⚠️</span>' +
      '<span><b>风险提醒</b><br>本页数据基于你的持仓与最近交易日收盘价测算。行情来自公开渠道，可能存在瑕疵或延迟，' +
      '市值随行情波动，仅供参考，<b>不构成任何投资建议</b>。</span></div>';

    if (!s.count) {
      html += UI.emptyState('📊', '暂无持仓数据', '添加持仓并同步行情后，这里会显示账户的深度分析。',
        '<button class="ghost-btn primary" data-act="closeSubPage">返回</button>');
      return html;
    }

    /* ② 总资产（深色卡） */
    var unrealized = s.totalUnrealized;
    html += '<div class="hero-dark" style="margin-bottom:12px">' +
      '<div class="hd-status">当前总资产（基于 ' + U.esc(priceDate) + ' 价格）</div>' +
      '<div class="hd-amount"><span class="cur">¥</span>' + U.money(s.totalMarketValue) + '</div>' +
      (delta
        ? '<div class="hd-status" style="margin-top:6px">较上次记录 <b>' + U.signMoney(delta.mv, 0) + '</b>' +
        '<span style="opacity:.6"> · ' + U.esc(delta.prevDate) + '</span></div>'
        : '<div class="hd-status" style="margin-top:6px">还没有更早的快照，明天再来就能看到变化</div>') +
      '<div class="hd-metrics">' +
      '<div class="hd-metric"><div class="k">累计浮动盈亏</div><div class="v" style="color:' +
      (unrealized >= 0 ? '#FF8A73' : '#7BD8A6') + '">' + U.signMoney(unrealized, 0) + '</div></div>' +
      '<div class="hd-metric"><div class="k">浮盈比例</div><div class="v" style="color:' +
      (unrealized >= 0 ? '#FF8A73' : '#7BD8A6') + '">' + U.signPct(s.totalUnrealizedPct) + '</div></div>' +
      '<div class="hd-metric"><div class="k">持仓成本</div><div class="v">¥' + U.moneyCompact(s.totalCost) + '</div></div>' +
      '</div>' +
      '</div>';

    /* ③ 概览三列 */
    html += '<div class="metric-grid">' +
      '<div class="metric"><div class="k">持仓只数</div><div class="v">' + s.count + '</div><div class="s">只</div></div>' +
      '<div class="metric"><div class="k">单只平均市值</div><div class="v">¥' + U.moneyCompact(s.avgMarketValue) + '</div><div class="s">元</div></div>' +
      '<div class="metric"><div class="k">综合股息率</div><div class="v c-div">' +
      (s.marketYield === null ? '—' : U.pct(s.marketYield)) + '</div><div class="s">预测分红/市值</div></div>' +
      '</div>';

    /* ④ 资产走势（与首页同一张卡：持仓市值 / 净资产 / 收益率，区间/粒度/指数/收起齐全）
       控件状态用独立实例（ns='an'），不会与首页那张互相影响。
       它不依赖每日快照，直接由「交易流水还原持股数 × 历史收盘价」重建，所以新账户也能立刻看到曲线。 */
    html += XJ.views.networth.render('an');

    /* ⑤⑥ 一组：盈亏榜 + 股息率分层（平板横屏并排） */
    html += '<div class="an-split">';
    html += '<div class="an-col">';
    html += '<div class="section-title">持仓盈亏榜</div>';
    if (!an.byPnl.length) {
      html += '<div class="card"><div class="tiny" style="text-align:center;padding:14px 0">缺少行情时无法计算盈亏。</div></div>';
    } else {
      html += '<div class="list">' + an.byPnl.map(function (h) {
        return '<button class="list-row" data-act="openSymbol" data-symbol="' + U.esc(h.symbol) + '">' +
          UI.avatar(h.name, h.symbol, 38, C.logoOf(h)) +
          '<div class="row-main">' +
          '<div class="row-t"><span class="nm">' + U.esc(h.name) + '</span></div>' +
          '<div class="row-s">' + U.esc(XJ.market.displayCode(h.symbol)) + ' · 成本 ' + U.money(h.avgCost, 4) +
          ' · 现价 ' + (h.price === null ? '—' : U.money(h.price)) + '</div>' +
          '</div>' +
          '<div class="row-right">' +
          '<div class="row-v ' + U.dirClass(h.unrealizedCny) + '">' + U.signMoney(h.unrealizedCny, 0) + '</div>' +
          '<div class="row-v2 ' + U.dirClass(h.unrealizedPct) + '">' + U.signPct(h.unrealizedPct) + '</div>' +
          '</div>' +
          '<span class="chev">' + UI.icon('chevron', 16) + '</span>' +
          '</button>';
      }).join('') + '</div>';
      html += '<div class="tiny" style="margin:8px 2px 0">' + an.gainCount + ' 只浮盈 · ' + an.lossCount + ' 只浮亏</div>';
    }
    html += '</div>';                          // 收第 1 列 .an-col
    html += '<div class="an-col">';            // 第 2 列：股息率分层

    /* ⑥ 股息率分层（每个区间具体列出成分股） */
    html += '<div class="section-title">股息率分层</div>';
    var maxBucket = Math.max.apply(null, an.yieldBuckets.map(function (b) { return b.count; }).concat([1]));
    html += '<div class="card">' + an.yieldBuckets.map(function (b) {
      var w = Math.max(0, b.count / maxBucket * 100);
      var stocks = (b.stocks || []).length
        ? '<div class="sub-stocks">' + b.stocks.map(function (st) {
          return '<button class="sub-stock" data-act="openSymbol" data-symbol="' + U.esc(st.symbol) + '">' +
            U.esc(st.name) +
            '<b>' + (st.dividendYield === null ? '—' : U.pct(st.dividendYield, 2)) + '</b></button>';
        }).join('') + '</div>'
        : '<div class="sub-stocks"><span class="tiny" style="color:var(--text-3)">（无）</span></div>';
      return '<div style="margin-bottom:12px">' +
        '<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px">' +
        '<span style="font-weight:600">' + U.esc(b.label) + '</span>' +
        '<span class="muted">' + b.count + ' 只 · ¥' + U.moneyCompact(b.marketValue) + '</span></div>' +
        '<div class="bar"><i style="width:' + w.toFixed(1) + '%"></i></div>' +
        stocks +
        '</div>';
    }).join('') + '</div>';

    html += '</div>';                          // 收第 2 列
    html += '</div>';                          // 收第 1 组 .an-split

    /* ⑦⑧ 一组：市场分布 + 集中度 */
    html += '<div class="an-split">';
    html += '<div class="an-col">';
    html += '<div class="section-title">市场分布（每个市场具体列出成分股）</div>';
    html += '<div class="card">' + (an.byAssetType.length ? an.byAssetType.map(function (g) {
      var pct = g.weight || 0;
      var stocks = (g.stocks || []).length
        ? '<div class="sub-stocks">' + g.stocks.map(function (st) {
          return '<button class="sub-stock" data-act="openSymbol" data-symbol="' + U.esc(st.symbol) + '">' +
            U.esc(st.name) +
            '<b>' + U.pct(st.weight, 1) + '</b></button>';
        }).join('') + '</div>'
        : '';
      return '<div style="margin-bottom:12px">' +
        '<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px">' +
        '<span style="font-weight:600">' + U.esc(g.label || '—') + '</span>' +
        '<span class="muted">' + U.pct(pct, 1) + ' · ¥' + U.moneyCompact(g.marketValue) + ' · ' + g.count + ' 只</span></div>' +
        '<div class="bar"><i style="width:' + Math.max(0, pct).toFixed(1) + '%"></i></div>' +
        stocks +
        '</div>';
    }).join('') : '<div class="tiny" style="text-align:center;padding:10px 0">暂无数据</div>') + '</div>';

    html += '</div>';                          // 收第 1 列
    html += '<div class="an-col">';            // 第 2 列：集中度
    /* ⑧ 集中度（具体列出每只股票的占比与累计占比） */
    var cc = an.concentration;
    html += '<div class="section-title">集中度</div>';
    html += '<div class="card">' +
      '<div class="card-head" style="margin-bottom:8px"><h2 style="font-size:14px">' + U.esc(cc.level) + '</h2>' +
      '<div class="spacer"></div><span class="hint">HHI ' + (cc.hhi === null ? '—' : cc.hhi.toFixed(3)) + '</span></div>' +
      '<div class="kv"><span class="k">第一大持仓占比</span><span class="v">' + U.pct(cc.top1, 1) + '</span></div>' +
      '<div class="kv"><span class="k">前三大占比</span><span class="v">' + U.pct(cc.top3, 1) + '</span></div>' +
      '<div class="kv"><span class="k">前五大占比</span><span class="v">' + U.pct(cc.top5, 1) + '</span></div>';

    /* 逐只明细 */
    var cl = cc.holdings || [];
    if (cl.length) {
      var maxW = Math.max.apply(null, cl.map(function (x) { return x.weight; }).concat([1]));
      html += '<div class="sub-divider">逐只占比</div>';
      html += cl.map(function (x) {
        var isTop3 = x.rank <= 3;
        return '<button class="conc-row" data-act="openSymbol" data-symbol="' + U.esc(x.symbol) + '">' +
          '<span class="conc-rank' + (isTop3 ? ' top' : '') + '">' + x.rank + '</span>' +
          '<span class="conc-name">' + U.esc(x.name) + '</span>' +
          '<span class="conc-val">' + U.pct(x.weight, 1) + '</span>' +
          '<span class="conc-cum" title="累计占比">Σ ' + U.pct(x.cumWeight, 1) + '</span>' +
          '<span class="conc-bar"><i style="width:' + (x.weight / maxW * 100).toFixed(1) + '%"></i></span>' +
          '</button>';
      }).join('');
      if (cl.length > 3) {
        html += '<div class="tiny" style="margin-top:8px">前三大：' +
          U.esc(cl.slice(0, 3).map(function (x) { return x.name; }).join(' / ')) + '</div>';
      }
    }

    html += '</div>';                          // 收第 2 列
    html += '</div>';                          // 收第 2 组 .an-split
    html += '<div class="note-line" style="margin-top:10px">' + UI.icon('info', 13) +
      '<span>HHI（赫芬达尔指数）越大越集中：&lt;0.15 相对分散，0.15–0.25 较为集中，&gt;0.25 高度集中。' +
      'Σ 为累计占比，集中度高意味着单只标的大幅波动会显著影响账户整体。</span></div>' +
      '</div>';

    return html;
  }

  return { render: render };
})();
