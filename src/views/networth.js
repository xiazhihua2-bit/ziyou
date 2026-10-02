/* ==================== 视图组件：资产走势（首页独立卡） ====================
 * 三条曲线一键切换：
 *   持仓市值 —— Σ(持股数 × 当日真实收盘价/净值 × 汇率)
 *   累计收益 —— 持仓总市值 + 累计已收分红 − 累计净投入
 *               （**不等于**账户总资产：本项目没有现金概念，故不提供「总资产」曲线）
 *   收益率   —— 两种口径可切：
 *                 时间加权（TWR）剔除加仓/减仓的净流入，可与指数公平对比
 *                 成本收益率 = 累计收益 ÷ 累计净投入，即「每一元本金赚了多少」
 *   当日参考盈亏 —— 现价相对【昨收】的浮动（人民币口径，跨币种已折算）
 *
 * 收益率模式下叠加对比指数（上证 / 沪深300 / 恒生 / 纳斯达克 / 标普500；日经225 / 台湾加权 / 韩国KOSPI
 * 无免费历史源，整项不出现在图例里），
 * 指数图例可多选；折线与 K 线（蜡烛）两种画法切换；拖动时显示竖向高亮带与多值读数。
 * 区间：当日 / 本月 / 近三月 / 近6月 / 今年 / 全部 / 自定义。卡片整体可收起。
 *
 * 同一张卡挂两处：首页（ns=''）与账户分析（ns='an'），两处控件状态各自独立。
 *
 * 数据口径见 calc.marketValueSeries（市值/净投入/累计分红）与 calc.twrIndex（TWR）。
 */
XJ.views.networth = (function () {
  var U = XJ.util, UI = XJ.ui, MK = XJ.market;

  var GRANS = [['day', '日'], ['month', '月']];
  var RANGES = [
    ['today', '当日'], ['1m', '本月'], ['3m', '近三月'],
    ['6m', '近6月'], ['ytd', '今年'], ['all', '全部'], ['custom', '自定义'],
  ];
  var METRICS = [['mv', '持仓市值'], ['nw', '累计收益'], ['ret', '收益率']];
  var MODES = [['line', '曲线收益率'], ['candle', 'K线收益率']];
  var RET_MODES = [['twr', '时间加权'], ['cost', '成本收益率']];

  /* 同一张卡挂两处（首页 + 账户分析），每处一套**独立**的控件状态：
     ns = ''    → nwMetric / nwRange / nwGran / nwBeg / nwEnd / nwMode / nwCollapsed
     ns = 'an'  → anNwMetric / anNwRange / …（前缀 + 首字母大写）
     app.js 的动作处理器通过 keyOf() 写入对应实例，互不影响。 */
  var NS_BASE = {
    metric: 'nwMetric', range: 'nwRange', gran: 'nwGran',
    beg: 'nwBeg', end: 'nwEnd', mode: 'nwMode', collapsed: 'nwCollapsed',
    retMode: 'nwRetMode',
  };
  function keyOf(ns, field) {
    var base = NS_BASE[field];
    return ns ? ns + base.charAt(0).toUpperCase() + base.slice(1) : base;
  }
  function getUI(ns, field) { return XJ.store.ui[keyOf(ns, field)]; }

  /** 区间自适应：历史不足半年时默认看全部，否则默认近 6 月 */
  function defaultRange(state, accountId) {
    var txs = state.transactions.filter(function (t) {
      return accountId === XJ.calc.ALL || t.accountId === accountId;
    });
    if (!txs.length) return 'all';
    var first = txs.map(function (t) { return t.date; }).sort()[0];
    var span = U.daysBetween(first, U.today());
    return (span !== null && span >= 180) ? '6m' : 'all';
  }

  /* 重建结果缓存：marketValueSeries 要按「每个交易日 × 每只标的」重算，是这一页最重的一步，
     而排序、筛选、折叠等纯 UI 操作都会触发重渲染。指纹包含了所有会影响结果的量。
     两处实例区间/粒度可能不同，因此按指纹存多条（超过 4 条淘汰最旧的）。 */
  var cache = {};
  var cacheOrder = [];

  function fingerprint(st, acc, range, gran, beg, end) {
    var s = st.state;
    var histStamp = '';
    Object.keys(s.priceHistory || {}).forEach(function (k) {
      histStamp += k + ':' + (s.priceHistory[k].points || []).length + ';';
    });
    Object.keys(s.indexHistory || {}).forEach(function (k) {
      histStamp += k + ':' + ((s.indexHistory[k] || {}).bars || []).length + ';';
    });
    return [acc, range, gran, beg || '', end || '',
      s.transactions.length, s.received.length,
      Object.keys(s.snapshots || {}).length, histStamp,
      (s.settings.fx && s.settings.fx.HKD) || '', (s.settings.fx && s.settings.fx.USD) || '',
    ].join('|');
  }

  function build(st, ns) {
    var acc = st.acc();
    var range = getUI(ns, 'range') || defaultRange(st.state, acc);
    var gran = getUI(ns, 'gran') === 'month' ? 'month' : 'day';
    var beg = getUI(ns, 'beg') || '';
    var end = getUI(ns, 'end') || '';
    var key = fingerprint(st, acc, range, gran, beg, end);
    if (cache[key]) return cache[key];

    var priceMap = {};
    Object.keys(st.state.priceHistory || {}).forEach(function (sym) {
      var rec = st.state.priceHistory[sym];
      if (rec && rec.points && rec.points.length) priceMap[sym] = rec.points;
    });

    var cr = XJ.calc.chartRange(range, U.today(), beg, end);
    var res = XJ.calc.marketValueSeries(st.state, acc, priceMap, {
      beg: cr.beg, end: cr.end, fx: st.state.settings.fx,
    });
    /* 成本收益率 = 累计收益 ÷ 累计净投入（每一元本金赚了多少，含股息）。
       净投入 ≤ 0（本金已被卖出/分红全部收回）时没有意义 → 给 null，绝不给 Infinity。 */
    var costRet = res.series.map(function (p) {
      var net = U.n0(p.net);
      return { date: p.date, idx: net > 0 ? U.n0(p.nw) / net : null };
    });
    var value = {
      range: range, beg: cr.beg, end: cr.end, res: res,
      series: XJ.calc.downsample(res.series, gran),
      twr: XJ.calc.downsample(XJ.calc.twrIndex(res.series), gran),
      costRet: XJ.calc.downsample(costRet, gran),
    };
    cache[key] = value;
    cacheOrder.push(key);
    while (cacheOrder.length > 4) delete cache[cacheOrder.shift()];
    return value;
  }

  /** ns = '' 首页实例；ns = 'an' 账户分析实例（两套控件状态互不影响） */
  function render(ns) {
    ns = ns || '';
    var st = XJ.store;
    var metricV = getUI(ns, 'metric');
    var metric = (metricV === 'nw' || metricV === 'ret') ? metricV : 'mv';
    var mode = getUI(ns, 'mode') === 'candle' ? 'candle' : 'line';
    var gran = getUI(ns, 'gran') === 'month' ? 'month' : 'day';
    var collapsed = !!getUI(ns, 'collapsed');
    var beg = getUI(ns, 'beg') || '';
    var end = getUI(ns, 'end') || '';
    var b = build(st, ns);
    var series = b.series;

    var rangeLabel = (RANGES.filter(function (r) { return r[0] === b.range; })[0] || ['', '全部'])[1];
    var metricLabel = (METRICS.filter(function (m) { return m[0] === metric; })[0] || ['', ''])[1];
    var granLabel = gran === 'month' ? '月粒度' : '日粒度';
    var isPct = metric === 'ret';
    var isToday = b.range === 'today';
    /* 收益率口径：twr（时间加权）| cost（成本收益率）。只影响收益率模式 */
    var retMode = getUI(ns, 'retMode') === 'cost' ? 'cost' : 'twr';
    var retLabel = retMode === 'cost' ? '成本收益率' : '时间加权';

    var html = '<div class="card nw-card' + (collapsed ? ' collapsed' : '') + '" data-ns="' + ns + '">';

    /* 标题行（首页那张带 01 序号；账户分析里不带） */
    html += '<div class="card-head" style="margin-bottom:6px">' +
      (ns ? '' : '<span class="nw-no">01</span>') +
      '<h2>资产走势</h2><div class="spacer"></div>' +
      '<span class="hint">' + U.esc(metricLabel) + ' · ' + U.esc(rangeLabel) +
      (collapsed || isToday ? '' : ' · ' + U.esc(granLabel)) + '</span>' +
      '<button class="fold-head nw-fold" data-act="toggleNw" data-ns="' + ns + '" aria-label="展开或收起">' +
      '<span class="fold-caret' + (collapsed ? ' folded' : '') + '">' + UI.icon('chevron', 14) + '</span>' +
      '</button></div>';

    if (collapsed) {
      var lastC = series.length ? series[series.length - 1] : null;
      var mini = '';
      if (lastC) {
        mini = (isPct && b.twr.length)
          ? '<span class="nw-mini-v">' + U.signPct(b.twr[b.twr.length - 1].idx * 100 - 100) + '</span>'
          : '<span class="nw-mini-v">' + U.moneySign(lastC[metric]) + '</span>';
      }
      html += '<div class="nw-mini">' + mini +
        '<span class="nw-mini-l">' + U.esc(metricLabel) +
        (lastC ? ' · 截至 ' + U.esc(lastC.date) : ' · 暂无数据') + '</span></div>';
      html += '</div>';
      return html;
    }

    /* 指标切换 + 日/月粒度（当日为分时曲线，不再需要粒度） */
    html += '<div class="nw-toprow">' +
      '<div class="nw-metrics">' + METRICS.map(function (m) {
        return '<button class="nw-metric' + (m[0] === metric ? ' active' : '') +
          '" data-act="setNwMetric" data-ns="' + ns + '" data-v="' + m[0] + '">' + m[1] + '</button>';
      }).join('') + '</div>' +
      '<div class="spacer" style="flex:1"></div>' +
      (isToday ? '' : '<div class="segmented nw-seg nw-gran">' + GRANS.map(function (g) {
        return '<button class="' + (g[0] === gran ? 'active' : '') + '" data-act="setNwGran" data-ns="' + ns +
          '" data-v="' + g[0] + '">' + g[1] + '</button>';
      }).join('') + '</div>') +
      '</div>';

    /* 收益率口径切换（只在收益率模式下出现）：时间加权 / 成本收益率 */
    if (isPct) {
      html += '<div class="nw-ranges nw-ranges-top nw-retmodes">' + RET_MODES.map(function (m) {
        return '<button class="chip' + (m[0] === retMode ? ' active' : '') +
          '" data-act="setNwRetMode" data-ns="' + ns + '" data-v="' + m[0] + '">' + m[1] + '</button>';
      }).join('') + '</div>';
    }

    /* 区间条（对齐参考图：当日/本月/近三月/近6月/今年/全部/自定义） */
    html += '<div class="nw-ranges nw-ranges-top">' + RANGES.map(function (r) {
      return '<button class="chip' + (r[0] === b.range ? ' active' : '') +
        '" data-act="setNwRange" data-ns="' + ns + '" data-v="' + r[0] + '">' + r[1] + '</button>';
    }).join('') + '</div>';

    if (b.range === 'custom') {
      html += '<div class="field-row" style="margin:8px 0 2px">' +
        '<div class="field" style="margin:0"><label>开始日期</label>' +
        '<input type="date" data-k="nwBeg" data-ns="' + ns + '" data-change="setNwCustom" value="' + U.esc(beg) + '"></div>' +
        '<div class="field" style="margin:0"><label>结束日期</label>' +
        '<input type="date" data-k="nwEnd" data-ns="' + ns + '" data-change="setNwCustom" value="' + U.esc(end) + '"></div>' +
        '</div>';
    }

    /* ---- 组装要画的数据 ---- */
    var chartSeries = [];
    var candles = null;
    var candleName = '';
    var common = null;
    var intradayMissing = [];

    if (isToday) {
      /* 当日：三种指标都走分时曲线（收益率用百分比并可叠加指数；市值 / 净资产用绝对金额）。
         早先只有收益率分支处理「当日」，另两种指标落到日粒度序列上——而「当日」区间下日序列
         只剩 1 个点，于是必然命中空态，看起来像「曲线不显示」。
         当日没有「共同起点」一说（横轴是时刻不是日期），故不计算 common。 */
      chartSeries = buildIntraday(st, metric, retMode);
      intradayMissing = buildIntraday.missing || [];
    } else if (isPct && retMode === 'cost') {
      /* 成本收益率：直接画【水平值】= 累计收益 ÷ 累计净投入。
         刻意**不叠加指数** —— 指数没有「本金」概念，两者零点不同（组合从 0% 起步、
         指数归一化到共同起点），叠在一起比会被误读。口径行里写明了。 */
      chartSeries = [{
        key: 'ret', name: '成本收益率', color: MK.METRIC_COLORS.ret,
        points: b.costRet.filter(function (p) { return p.idx !== null; }).map(function (p) {
          return { date: p.date, pct: Math.round(p.idx * 10000) / 100 };
        }),
      }];
    } else if (isPct) {
      /* 组合收益率：与指数取共同起点，才谈得上可比 */
      var idxPts0 = b.twr.map(function (p) { return { date: p.date, idx: p.idx }; });
      var rawIdx = [];
      (st.state.settings.indexCompare || []).forEach(function (key) {
        var def = MK.indexDef(key);
        var rec = st.state.indexHistory[key];
        if (!def || !rec || !rec.bars || rec.bars.length < 2) return;
        var bars = XJ.calc.indexBarsInRange(rec.bars, b.beg, b.end);
        if (bars.length < 2) return;
        rawIdx.push({ key: key, def: def, bars: bars, first: bars[0].d });
      });
      common = XJ.calc.commonStart(
        [{ date: idxPts0.length ? idxPts0[0].date : '' }].concat(rawIdx.map(function (r) { return { date: r.first }; }))
      );
      /* 日粒度：组合 + 指数都以「相对共同起点的百分比」表示 */
      var portPts = XJ.calc.rebasePercent(idxPts0, 'idx', common);
      if (portPts.length >= 2) {
        chartSeries.push({
          key: 'ret', name: '组合收益率', color: MK.METRIC_COLORS.ret, points: portPts,
        });
      }
      rawIdx.forEach(function (r) {
        if (mode === 'candle') {
          /* K线模式：只画组合折线 + **第一个**选中指数的蜡烛（组合没有 OHLC）。
             否则一堆指数曲线会把蜡烛整片盖住，什么也看不出来。 */
          if (!candles) {
            candles = XJ.calc.indexCandles(r.bars, common);
            candleName = r.def.name;
          }
          return;
        }
        var pts = XJ.calc.rebasePercent(r.bars, 'c', common);
        if (pts.length < 2) return;
        chartSeries.push({ key: r.key, name: r.def.name, color: MK.indexColor(r.key), points: pts });
      });
    } else {
      var color = metric === 'nw' ? MK.METRIC_COLORS.nw : MK.METRIC_COLORS.mv;
      chartSeries = [{ key: metric, name: metricLabel, color: color, points: series.map(function (p) {
        return { date: p.date, pct: p[metric] };
      }) }];
    }

    /* ---- 指数图例（多选） ----
       只列出**有历史数据源**的指数；日经225 / 台湾加权 / 韩国KOSPI 没有可用的免费历史源，
       整项不出现在图例里（不做假数据、也不占位置）。「当日」区间下没有分时的（美股指数）仍置灰说明。 */
    if (isPct) {
      var usableIdx = MK.INDICES.filter(function (d) { return MK.indexHasHistory(d.key); });
      html += '<div class="nw-idx">' + usableIdx.map(function (d) {
        var on = (st.state.settings.indexCompare || []).indexOf(d.key) >= 0;
        var why = (isToday && !MK.indexHasIntraday(d.key)) ? '当日无分时数据' : '';
        var usable = !why;
        return '<button class="nw-idxitem' + (on && usable ? ' on' : '') + (usable ? '' : ' off') +
          '" data-act="toggleIndex" data-v="' + d.key + '"' + (usable ? '' : ' disabled') +
          ' title="' + U.esc(usable ? d.name : d.name + '：' + why) + '">' +
          '<i style="background:' + (on && usable ? MK.indexColor(d.key) : '') + '"></i>' +
          U.esc(d.name) + (usable ? '' : '<em class="nw-idxno">当日无分时</em>') +
          '</button>';
      }).join('') + '</div>';
      /* 曲线 / K 线切换 */
      html += '<div class="nw-modes">' +
        '<div class="segmented nw-seg">' + MODES.map(function (m) {
          return '<button class="' + (m[0] === mode ? 'active' : '') + '" data-act="setNwMode" data-ns="' + ns +
            '" data-v="' + m[0] + '">' + m[1] + '</button>';
        }).join('') + '</div>' +
        '<div class="spacer" style="flex:1"></div>' +
        '<span class="tiny">' + (mode === 'candle' ? '蜡烛为选中指数' : '') + '</span>' +
        '</div>';
    }

    /* ---- 数据不足时给空态（放在图例之后，这样指数选择条仍然可见可操作） ---- */
    if (!chartSeries.length || chartSeries[0].points.length < 2) {
      var hasAnyHistory = Object.keys(st.state.priceHistory || {}).length > 0;
      /* 当日空态分三种，别再说一句放之四海皆准的废话：
         ① 正在拉 → 等一会
         ② 缓存里有数据、但当前持仓一只都没覆盖（全是场外基金 / 美股 / 停牌）→ 说清楚是哪类
         ③ 真的没有 → 引导去点刷新 */
      var intradayMsg;
      if (isToday) {
        if (st.ui.busy) {
          intradayMsg = '正在获取当日分时行情，稍后即可看到曲线…';
        } else if (buildIntraday.calledWithMinuteCache && intradayMissing.length) {
          /* 缓存有数据，但当前持仓一只都没覆盖到 → 是标的类型问题，不是网络问题 */
          intradayMsg = '当前持仓没有可用的分时数据（场外基金、停牌标的没有分时），画不出当日曲线。';
        } else {
          intradayMsg = '还没有当日的分时行情。点下方「刷新行情」拉一次；收盘后也照样能拉到当天数据。';
        }
      }
      html += '<div class="tiny" style="padding:14px 2px;text-align:center;line-height:1.8">' +
        (isToday
          ? intradayMsg
          : (st.ui.historyBusy
            ? '正在获取历史行情，稍后即可看到曲线…'
            : (hasAnyHistory
              ? '区间内没有足够的交易日数据。换个区间（如「全部」）看看。'
              : '还没有历史行情数据。点下方「获取历史行情」后即可画出曲线。'))) +
        '</div>';
      if (isToday && !st.ui.busy) {
        html += '<button class="btn-block ghost" data-act="refresh">刷新行情</button>';
      }
      if (!isToday && !st.ui.historyBusy && !hasAnyHistory) {
        html += '<button class="btn-block ghost" data-act="fetchHistory">获取历史行情</button>';
      }
      html += '</div>';
      return html;
    }

    /* 当日曲线取的是「最近一个交易日」那批分时（收盘后/周末照样能看）。
       若它不是今天，标题里要写明日期 —— 否则「当日盘中 · 截至 14:59」会被读成实时行情，
       进而觉得「涨跌和我持仓对不上」。 */
    var minuteDay = isToday ? st.minuteDate() : null;
    var dayHint = (minuteDay && minuteDay !== U.today()) ? '（' + U.mdShort(minuteDay) + '）' : '';

    /* ---- 大数字 ---- */
    var delta = null;
    if (isPct && !isToday && retMode === 'cost') {
      /* 成本收益率：大数字就是当前水平值（不是相对起点的变化） */
      var crLast = b.costRet.length ? b.costRet[b.costRet.length - 1] : null;
      var crv = crLast && crLast.idx !== null ? crLast.idx * 100 : null;
      html += '<div class="nw-amount' + (crv !== null && crv < 0 ? ' down' : '') + '">' +
        (crv === null ? '—' : U.signPct(crv)) + '</div>';
      html += '<div class="tiny nw-sub">成本收益率 = 累计收益 ÷ 累计净投入（含股息）' +
        (crLast ? ' · 截至 ' + U.esc(crLast.date) : '') + '</div>';
    } else if (isPct && !isToday) {
      var lastIdx = b.twr.length ? b.twr[b.twr.length - 1] : null;
      var baseIdx = null;
      if (common) {
        b.twr.forEach(function (p) { if (baseIdx === null && p.date >= common) baseIdx = p.idx; });
      }
      var cur = lastIdx ? lastIdx.idx * 100 - 100 : null;
      var basePct = baseIdx ? baseIdx * 100 - 100 : 0;
      html += '<div class="nw-amount' + (cur !== null && cur < 0 ? ' down' : '') + '">' +
        (cur === null ? '—' : U.signPct(cur - basePct)) + '</div>';
      html += '<div class="tiny nw-sub">组合时间加权收益率（TWR，含股息）· 起点 ' +
        U.esc(common || '—') + '</div>';
      if (cur !== null) {
        /* 与各指数同期涨幅逐条对比 */
        var rows = chartSeries.filter(function (s) { return s.key !== 'ret'; }).map(function (s) {
          var last = s.points[s.points.length - 1];
          return { name: s.name, pct: last ? last.pct : null, color: s.color };
        });
        if (rows.length) {
          html += '<div class="nw-vs">' + rows.map(function (r) {
            var diff = r.pct === null ? null : cur - r.pct;
            return '<span class="nw-vsitem"><i style="background:' + r.color + '"></i>' + U.esc(r.name) +
              '<b>' + (r.pct === null ? '—' : U.signPct(r.pct)) + '</b>' +
              (diff === null ? '' : '<em class="' + (diff >= 0 ? 'c-up' : 'c-down') + '">' +
                (diff >= 0 ? '领先 ' : '落后 ') + U.pct(Math.abs(diff)) + '</em>') + '</span>';
          }).join('') + '</div>';
        }
      }
    } else if (isPct) {
      /* 当日收益率：大数字 = 相对当日首个报价的涨跌幅；下方逐条对比各指数当日涨幅 */
      var pv = chartSeries[0];
      var lastT = pv ? pv.points[pv.points.length - 1] : null;
      var curP = lastT ? lastT.pct : null;
      html += '<div class="nw-amount' + (curP !== null && curP < 0 ? ' down' : '') + '">' +
        (curP === null ? '—' : U.signPct(curP)) + '</div>';
      html += '<div class="tiny nw-sub">' +
        (retMode === 'cost' ? '成本收益率 = 当日参考盈亏 ÷ 累计净投入' : '组合收益率（TWR，含股息）') +
        ' · 当日' + dayHint + '盘中' +
        (lastT ? ' · 截至 ' + U.esc(lastT.date) : '') + '</div>';
      /* 当日参考盈亏（金额）：相对昨收。用户明确要的就是这一行 */
      var tpR = buildIntraday.todayPnl;
      if (tpR) {
        html += '<div style="margin-top:7px"><span class="nw-delta ' + (tpR.amount >= 0 ? 'up' : 'down') + '">' +
          (tpR.amount >= 0 ? '▲' : '▼') + ' 当日参考盈亏 ' + U.signMoney(tpR.amount, 0) +
          '</span> <span class="tiny">较昨收，跨币种已折算</span></div>';
      }
      var idxRows = chartSeries.filter(function (s) { return s.key !== 'ret'; }).map(function (s) {
        var last = s.points[s.points.length - 1];
        return { name: s.name, pct: last ? last.pct : null, color: s.color };
      });
      if (curP !== null && idxRows.length) {
        html += '<div class="nw-vs">' + idxRows.map(function (r) {
          var diff = r.pct === null ? null : curP - r.pct;
          return '<span class="nw-vsitem"><i style="background:' + r.color + '"></i>' + U.esc(r.name) +
            '<b>' + (r.pct === null ? '—' : U.signPct(r.pct)) + '</b>' +
            (diff === null ? '' : '<em class="' + (diff >= 0 ? 'c-up' : 'c-down') + '">' +
              (diff >= 0 ? '领先 ' : '落后 ') + U.pct(Math.abs(diff)) + '</em>') + '</span>';
        }).join('') + '</div>';
      }
    } else {
      var curV = (isToday && chartSeries.length)
        ? chartSeries[0].points[chartSeries[0].points.length - 1].pct
        : (series.length ? series[series.length - 1][metric] : null);
      html += '<div class="nw-amount">' + (curV === null ? '—' : U.moneySign(curV)) + '</div>';
      html += '<div class="tiny nw-sub">' + U.esc(metricLabel) +
        (isToday && chartSeries.length
          ? ' · 当日' + dayHint + '盘中 · 截至 ' + U.esc(chartSeries[0].points[chartSeries[0].points.length - 1].date)
          : (series.length ? ' · 截至 ' + U.esc(series[series.length - 1].date) : '')) + '</div>';
      if (isToday && chartSeries.length) {
        /* 当日参考盈亏 = 相对【昨收】的浮动。
           早先这里用「曲线首末点相减」，等于把隔夜跳空整段算漏了（9:30 开盘就跳空的话它记不到）。 */
        var tpM = buildIntraday.todayPnl;
        if (tpM) {
          html += '<div style="margin-top:7px"><span class="nw-delta ' + (tpM.amount >= 0 ? 'up' : 'down') + '">' +
            (tpM.amount >= 0 ? '▲' : '▼') + ' 当日参考盈亏 ' + U.signMoney(tpM.amount, 0) +
            '</span> <span class="tiny">较昨收，跨币种已折算</span></div>';
        } else {
          var firstP = chartSeries[0].points[0].pct;
          var lastP = chartSeries[0].points[chartSeries[0].points.length - 1].pct;
          var dToday = lastP - firstP;
          html += '<div style="margin-top:7px"><span class="nw-delta ' + (dToday >= 0 ? 'up' : 'down') + '">' +
            (dToday >= 0 ? '▲' : '▼') + ' 今日 ' + U.signMoney(dToday, 0) + '</span></div>';
        }
      } else if (series.length >= 2) {
        delta = XJ.calc.seriesDelta(series, metric);
        if (delta) {
          var up = delta.diff >= 0;
          html += '<div style="margin-top:7px"><span class="nw-delta ' + (up ? 'up' : 'down') + '">' +
            (up ? '▲' : '▼') + ' 较区间起点 ' + U.signMoney(delta.diff, 0) +
            (delta.pct === null ? '' : ' · ' + U.pct(delta.pct, 1)) + '</span></div>';
        }
      }
    }

    /* ---- 图表 ---- */
    var chartPts = chartSeries.map(function (s) {
      return { key: s.key, name: s.name, color: s.color, points: s.points };
    });
    html += '<div class="nw-chart">' + XJ.chart.renderCompare(chartPts, {
      mode: isToday ? 'line' : mode, candles: candles, xTicks: 4,
      unit: isPct ? '%' : 'money',
      fmtY: isPct ? U.pctAxis : U.moneyAxis,
    }) + '</div>';

    /* 图例：与曲线同色；K线模式额外标明蜡烛属于哪个指数 */
    html += '<div class="nw-legend nw-legend-left">' + chartSeries.map(function (s) {
      return '<span><i style="background:' + s.color + '"></i>' + U.esc(s.name) + '</span>';
    }).join('') +
      (candles && candles.length
        ? '<span><i class="candle"></i>' + U.esc(candleName) + ' 收益率 K 线</span>' : '') +
      '</div>';

    /* 口径与缺口说明 */
    var notes = [];
    if (isToday) {
      notes.push('当日为分时曲线：按各标的的分钟报价对齐后累加，某只标的缺某个时刻的报价时沿用其前值');
      if (isPct) {
        notes.push(retMode === 'cost'
          ? '成本收益率 = 当日参考盈亏 ÷ 累计净投入（每一元本金今天赚了多少）'
          : '涨跌幅以【昨收】为基准（与同花顺/券商一致），指数同样按昨收归一化；' +
            '尚未开盘的标的在分子里贡献 0、在分母里照常占权重，所以不会把涨幅放大');
      } else if (metric === 'nw') {
        notes.push('累计收益 = 分时持仓总市值 + 累计已收分红 − 累计净投入（没有分时的标的按其最新市值、并按币种折算计入）');
      } else {
        notes.push('持仓市值按分时价格折算人民币；跨市场标的按设置里的汇率换算');
      }
    } else if (isPct) {
      if (retMode === 'cost') {
        notes.push('成本收益率 = 累计收益 ÷ 累计净投入（含股息），即「每一元本金赚了多少」；' +
          '刻意不叠加指数 —— 指数没有本金概念，两者零点不同，叠在一起比会被误读');
      } else {
        notes.push('收益率 = 时间加权收益率（TWR）：按日剔除加仓/减仓的净流入后再连乘，可与指数公平对比');
        notes.push('指数涨幅按同一区间起点归一化；不同市场交易日不同，取共同起点');
      }
      if (mode === 'candle' && candles && candles.length) {
        notes.push('蜡烛为「' + candleName + '」的收益率 K 线（组合没有 K 线，仍以折线显示）');
      }
    } else if (metric === 'nw') {
      notes.push('累计收益 = 持仓总市值 + 累计已收分红 − 累计净投入（分红再投会重复计入）。' +
        '它**不等于**账户总资产 —— 本项目没有现金概念，故不提供「总资产」曲线');
    } else {
      notes.push('按「交易流水还原持股数 × 当日真实收盘价」折算人民币；同日有每日快照时以快照为准');
    }
    if (!isToday && b.res.missing.length) {
      notes.push('有 ' + b.res.missing.length + ' 只标的没有历史行情（场外基金净值或长期停牌），未计入曲线');
    }
    if (isToday && intradayMissing && intradayMissing.length) {
      notes.push('有 ' + intradayMissing.length + ' 只标的没有当日分时（场外基金 / 美股 / 长期停牌），' +
        '不参与逐分钟曲线' + (metric === 'nw' ? '（累计收益里按其最新市值、并按币种折算作为常量计入）' : '，未计入曲线'));
    }
    html += '<div class="note-line" style="margin-top:8px">' + UI.icon('info', 13) +
      '<span>' + U.esc(notes.join('；')) + '</span></div>';

    html += '</div>';
    return html;
  }

  /** 当日分时的汇率取值（HKD / USD 换人民币，未配置时按 1） */
  function fxRate(st, cur) {
    var fx = st.state.settings.fx || {};
    if (cur === 'HKD') return U.num(fx.HKD) || 1;
    if (cur === 'USD') return U.num(fx.USD) || 1;
    return 1;
  }

  /**
   * 每只标的的**昨收**（原币/股），当日盈亏与当日收益率的基准。
   *
   * 兜底链：行情给的 prevClose → 该标的日线最后一根收盘 → 现价。
   * 三者都没有（新加的标的、行情还没回来）则该标的既不进分子也不进分母 ——
   * 绝不用 0 当昨收，否则会算出 +∞ 的涨幅。
   */
  function prevCloseMap(st, hs) {
    var m = {};
    (hs || []).forEach(function (h) {
      var v = U.num(h.prevClose);
      if (v !== null && v > 0) { m[h.symbol] = v; return; }
      var rec = st.state.priceHistory && st.state.priceHistory[h.symbol];
      var pts = rec && rec.points;
      if (pts && pts.length) {
        v = U.num(pts[pts.length - 1][1]);
        if (v !== null && v > 0) { m[h.symbol] = v; return; }
      }
      v = U.num(h.price);
      if (v !== null && v > 0) m[h.symbol] = v;
    });
    return m;
  }

  /**
   * 指数的「昨收」= 分时批次日之前最后一根日线收盘。
   * 这样指数那条线与组合同为「较昨收」，跟同花顺的指数涨幅口径一致。
   * 取不到时返回 null，调用方退化为「首个分时点」（保持旧行为）。
   */
  function indexPrevClose(st, key, minuteDate) {
    var rec = st.state.indexHistory && st.state.indexHistory[key];
    if (!rec || !rec.bars || !rec.bars.length || !minuteDate) return null;
    var prev = null;
    for (var i = 0; i < rec.bars.length; i++) {
      if (rec.bars[i].d < minuteDate) prev = U.num(rec.bars[i].c);
      else break;
    }
    return prev !== null && prev > 0 ? prev : null;
  }

  /**
   * 与 calc.marketValueSeries 的 `used` **同源**：该账户下「有日线」的标的。
   * 当日累计收益要和日粒度对齐，两边就必须用同一个标的集合 ——
   * 否则「有日线但无分时」（场外基金）和「无日线但有分红」的标的会让两条曲线打架。
   */
  function dailySymbols(st, acc) {
    var seen = {}, out = [];
    (st.state.transactions || []).forEach(function (t) {
      if (acc && acc !== XJ.calc.ALL && t.accountId !== acc) return;
      if (seen[t.symbol]) return;
      var rec = st.state.priceHistory && st.state.priceHistory[t.symbol];
      if (!rec || !rec.points || !rec.points.length) return;
      seen[t.symbol] = 1;
      out.push(t.symbol);
    });
    return out;
  }

  /**
   * 「当日」曲线：用分时数据画当天走势。
   * 组合：每个时刻 Σ(当日持股数 × 该时刻价格 × 汇率)，多标的按**时间戳**对齐（calc.alignMinute），
   * 缺失时刻沿用前值，因此不会因某只标的少一个报价点就整段塌陷。
   * 三种指标各取所需：
   *   收益率   → **相对昨收**的百分比（与指数同坐标系，可叠加对比）
   *   持仓市值 → 组合市值的绝对值（元）
   *   累计收益 → 持仓总市值 + 累计已收分红 − 累计净投入（元），随市值实时波动
   * @param metric 'ret' | 'mv' | 'nw'
   */
  function buildIntraday(st, metric, retMode) {
    var out = [];
    var acc = st.acc();
    var hs = XJ.calc.holdings(st.state, acc);
    var mode = retMode === 'cost' ? 'cost' : 'twr';

    /* 与日粒度**同一批「有日线」的标的** —— 当日累计收益 / 成本收益率都要跟它对齐 */
    var daily = dailySymbols(st, acc);
    var dailySet = {};
    daily.forEach(function (s) { dailySet[s] = 1; });

    /* 成本收益率的分母：累计净投入（人民币口径，同集合） */
    var netCnyCache = null;
    function netInvestedCny() {
      if (netCnyCache !== null) return netCnyCache;
      netCnyCache = 0;
      hs.forEach(function (h) { if (dailySet[h.symbol]) netCnyCache += U.n0(h.netInvestedCny); });
      return netCnyCache;
    }

    /* ---- 组合分时：按时间戳对齐后累加 ----
       分时来自 state.minuteCache（落盘、收盘后仍在），只取「最近一个交易日」那批，
       所以收盘后 / 周末也能画出当天走势；陈旧批次由 calc.minuteOf 挡掉。 */
    var syms = hs.map(function (h) { return h.symbol; });
    var minMap = st.intradayFor(syms);

    /* ★ 恒用 full 模式：额外拿到「全组合昨收市值 base」与每点的「相对昨收盈亏 pnl」。
       旧的当日收益率拿「首个时刻的 mv」当分母 —— 那一刻往往只有部分市场在交易
       （A 股 09:30，美股 21:30），分母偏小会把涨幅放大好几倍。
       mv 本身的算法没变，市值 / 累计收益两条曲线数值不受影响。 */
    var al = XJ.calc.alignMinute(hs, minMap, function (cur) { return fxRate(st, cur); },
      { full: true, prev: prevCloseMap(st, hs) });
    var mvPts = al.points;

    /* 累计收益在当日 = 逐分钟组合市值 + 常量项（分红 − 净投入 + 无分时标的的市值）。
       常量项走 calc.netWorthAdjust —— 口径与「全部」区间的 marketValueSeries 完全一致，
       别在这里内联手算（曾经内联的版本漏了汇率、又把无分时标的的成本扣了却没算它的市值，
       一个含场外基金的组合能差出好几万）。 */
    var nwAdj = 0;
    if (metric === 'nw') {
      var minuteSyms = syms.filter(function (s) { return al.missing.indexOf(s) < 0; });
      nwAdj = XJ.calc.netWorthAdjust(st.state, acc, daily, minuteSyms);
    }

    if (mvPts.length >= 2) {
      var color = metric === 'nw' ? MK.METRIC_COLORS.nw
        : metric === 'ret' ? MK.METRIC_COLORS.ret : MK.METRIC_COLORS.mv;
      var name = metric === 'nw' ? '累计收益' : metric === 'ret' ? '组合' : '持仓市值';

      if (metric === 'ret') {
        /* 收益率 = 当刻盈亏 ÷ 分母。两个口径共用同一个分子（相对昨收的当日参考盈亏）：
             twr  → ÷ 全组合昨收市值（= 当日涨跌幅，与同花顺一致）
             cost → ÷ 累计净投入（每一元本金今天赚了多少）
           分母必须 > 0，否则算出无意义的大数 */
        var denom = U.n0(al.base);
        if (mode === 'cost') denom = netInvestedCny();
        if (denom > 0) {
          var isCost = mode === 'cost';
          out.push({
            key: 'ret', name: isCost ? '成本收益率' : name, color: color,
            points: mvPts.map(function (p) {
              return { date: p.t, pct: Math.round((U.n0(p.pnl) / denom) * 10000) / 100 };
            }),
          });
        }
      } else {
        /* 市值 / 净资产：绝对值。净资产在当日把「累计已收分红 − 累计净投入」当常量加进去，
           盘中的分红到账会让这个常量台阶式跳一次，这是符合预期的（分红是离散事件） */
        out.push({
          key: metric, name: name, color: color,
          points: mvPts.map(function (p) {
            return { date: p.t, pct: Math.round((p.mv + nwAdj) * 100) / 100 };
          }),
        });
      }
    }

    /* 当日参考盈亏：末点的「相对昨收」盈亏（金额 + 百分比），供 render 直接读。
       口径 = Σ 持股数 ×（当刻价 − 昨收）× 汇率，跨币种已折算。 */
    buildIntraday.todayPnl = (function () {
      var base = U.n0(al.base);
      if (mvPts.length < 2 || !(base > 0)) return null;
      var last = mvPts[mvPts.length - 1];
      var amt = U.n0(last.pnl);
      return {
        at: last.t, base: base, amount: amt,
        pct: Math.round((amt / base) * 10000) / 100,
      };
    })();

    /* ---- 指数分时（仅收益率模式叠加，与日粒度口径一致） ---- */
    if (metric === 'ret') {
      var im = st.indexMinute || {};
      (st.state.settings.indexCompare || []).forEach(function (key) {
        var def = MK.indexDef(key);
        var m = im[key];
        if (!def || !m || !m.points || m.points.length < 2) return;
        /* 指数分时同样按时间戳取点，并把「首个有效价」当基准（首个点可能为空） */
        var raw = m.points.filter(function (p) { return p && p.t && U.num(p.p) !== null; })
          .sort(function (a, b) { return a.t < b.t ? -1 : a.t > b.t ? 1 : 0; });
        if (raw.length < 2) return;
        /* 指数也按【昨收】做基准（与组合新口径一致，这样跟同花顺的指数涨幅对得上）；
           取不到昨收时退化为「首个分时价」，保持旧行为。 */
        var ibase = indexPrevClose(st, key, st.minuteDate()) || U.num(raw[0].p);
        if (!ibase) return;
        out.push({
          key: key, name: def.name, color: MK.indexColor(key),
          points: raw.map(function (p) {
            return { date: p.t, pct: Math.round((U.num(p.p) / ibase - 1) * 10000) / 100 };
          }),
        });
      });
    }

    /* 缺口标的（没有分时的：场外基金 / 美股 / 长期停牌），由 render 写进说明行 */
    buildIntraday.missing = al.missing || [];
    /* 缓存里到底有没有可用分时 —— 空态文案据此区分「还没拉」和「拉不到」 */
    buildIntraday.calledWithMinuteCache = Object.keys(minMap).length > 0;
    return out;
  }

  /* keyOf 导出给 app.js：动作处理器据此把控件写入对应实例（'' = 首页，'an' = 账户分析） */
  return { render: render, keyOf: keyOf };
})();
