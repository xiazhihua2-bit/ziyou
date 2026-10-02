/* ==================== 视图：个股详情（独立页） ==================== */
XJ.views.symbol = (function () {
  var U = XJ.util, UI = XJ.ui, C = XJ.views.common;

  /**
   * 技术信号（BOLL 下轨 + KDJ 的 J<0）。
   * 与持仓卡片保持同一口径：中性文案、周线优先、结果不缓存、每次 render 现算。
   * 这里单独实现一份（而非从 views.common 导出），是因为两处取 price 的方式不同：
   * 卡片用 h.price，详情页在无持仓时会退回 quoteCache 的价格。
   */
  function signalOf(symbol, price) {
    var cache = XJ.store.state.klineCache && XJ.store.state.klineCache[symbol];
    if (!cache || !cache.day || cache.day.length < 2) return null;
    var sig = XJ.calc.bollSignal(symbol, cache.day, cache.week || [], price, U.today());
    return sig ? { text: sig.text, cls: sig.cls } : null;
  }

  /* ---------------- 股息率曲线（财年口径） ----------------
   * 口径见 calc.yieldFiscalSteps / calc.dividendYieldSeries 的注释。
   *
   * 时间轴：默认最近十年，**一律交易日（日线）粒度**。
   * 腾讯单次 count 上限 2000 根（只够 8.2 年），所以取数分两个窗口拼接
   * （见 fetcher.fetchYieldHistory），而不是退回周线 —— 退周线会让相邻点差好几天。
   */
  var YJ_COLOR = '#E8461F';        // 股息率（与分红金额同色）
  var YJ_BENCH_COLOR = '#E9A93C';  // 余额宝七日年化
  var YJ_MARK_COLOR = '#F08A24';   // 除权除息日散点
  var YJ_AVG_COLOR = '#4A7BB0';    // 历史平均股息率（分财年，虚线）—— 中性冷色，不与涨红跌绿抢语义
  var YJ_TEN_YEARS = 3653;         // ≈10 年

  function yjBenchOn(st) {
    return !!(st.state.settings && st.state.settings.showYieldBench === true);
  }

  function sliceByDate(list, beg, end) {
    return (list || []).filter(function (p) { return p.date >= beg && p.date <= end; });
  }

  /**
   * 生成股息率卡片。
   * @param symbol 内部代码
   * @param plans  该标的的全部 DividendPlan
   * @param st     XJ.store
   * @param h      持仓行（可能为 undefined，无持仓也照常出图）
   */
  function yieldCard(symbol, plans, st, h) {
    var open = '<div class="card yj-card" style="margin-bottom:12px">';
    var head = function (hint, extra) {
      return '<div class="card-head" style="margin-bottom:10px">' +
        '<h2>股息率</h2>' +
        C.qmark('股息率 = 该财年派现总额 ÷ 当时总市值 × 100%。' +
          '数学上等价于「每股派现 ÷ 当时股价」（总股本约掉）。' +
          '分子的生效时点取该财年年报的预案公告日；含已公告的预案。') +
        '<span class="hint">' + U.esc(hint) + '</span>' +
        '<div class="spacer"></div>' + (extra || '') + '</div>';
    };

    /* ① 不支持的市场：美股无分红源、场外基金没有「财年派现」概念 */
    if (!XJ.market.supportsYieldCurve(symbol)) {
      var why = XJ.market.assetType(symbol) === 'of'
        ? '场外基金的分红不定期、没有「财年派现」这个概念'
        : XJ.market.kind(symbol) + '暂无公开可用的免费分红数据源';
      return open + head('不适用') +
        '<div class="tiny" style="line-height:1.7">因' + U.esc(why) +
        '，无法按财年口径绘制股息率曲线。</div></div>';
    }

    var steps = XJ.calc.yieldFiscalSteps(plans || []);
    var cache = (st.state.yieldHistory && st.state.yieldHistory[symbol]) || null;
    var closes = (cache && cache.day) || [];

    /* ② 没有可用的财年方案 */
    if (!steps.length) {
      return open + head('—') +
        '<div class="tiny" style="line-height:1.7">还没有可用的年报分红数据。' +
        '点下方「同步该标的数据」获取分红方案后即可绘制。</div></div>';
    }

    /* ③ 有方案但收盘价缓存还没到位 */
    if (closes.length < 2) {
      return open + head('—',
        '<button class="ghost-btn" data-act="refreshOne" data-symbol="' + U.esc(symbol) + '">刷新</button>') +
        '<div class="tiny" style="line-height:1.7">' +
        (st.ui.busy ? '正在获取历史收盘价…' : '还没有历史收盘价。点右上「刷新」拉取后即可绘制曲线。') +
        '</div></div>';
    }

    /* ---- 序列（只保留算得出股息率的点） ---- */
    var all = XJ.calc.dividendYieldSeries(plans, closes);
    if (all.length < 2) {
      /* 价格有了，但没有任何一天落在财年生效日之后（例如刚上市的新股） */
      return open + head('—') +
        '<div class="tiny" style="line-height:1.7">历史收盘价与已公告的分红方案没有重叠区间，暂时画不出曲线。</div></div>';
    }

    /* ---- 平均股息率线（分财年） ----
       口径由 ui.yieldAvgMode 决定，且**只吃 2022-01-01 起的样本**（calc 内部固定）。
       刻意不用时间轴选区去切样本：均值是「该财年」的属性，不该随缩放而变。 */
    var avgMode = st.ui.yieldAvgMode === 'cum' ? 'cum' : 'year';
    var avgGroups = XJ.calc.yieldYearAverages(plans, closes);
    var avgAll = XJ.calc.yieldAverageSeries(plans, closes, avgMode);

    /* 默认最近十年：右端取序列最后一天，左端取「最后一天 − 10 年」但不早于序列起点 */
    var endD = all[all.length - 1].date;
    var begLimit = all[0].date;
    var begD = U.addDays(endD, -YJ_TEN_YEARS);
    if (!begD || begD < begLimit) begD = begLimit;
    /* 若用户上次拖过时间轴，恢复他选的范围（静默写在 ui 里，见 onChange） */
    if (st.ui.yjBeg && st.ui.yjEnd && st.ui.yjEnd >= begLimit && st.ui.yjBeg <= endD && st.ui.yjBeg < st.ui.yjEnd) {
      begD = st.ui.yjBeg < begLimit ? begLimit : st.ui.yjBeg;
      endD = st.ui.yjEnd > endD ? endD : st.ui.yjEnd;
    }

    var marks = XJ.calc.exDividendDates(plans || []);
    var benchPts = (st.state.benchHistory && st.state.benchHistory.points) || [];
    var showBench = yjBenchOn(st);

    function buildMain(beg, end) {
      var pts = sliceByDate(all, beg, end);
      if (pts.length < 2) {
        return { html: '<div class="tiny" style="padding:18px 0;text-align:center">该区间内数据不足。</div>' };
      }
      var seriesList = [{
        key: 'yj', name: '股息率', color: YJ_COLOR,
        points: pts.map(function (p) { return { date: p.date, pct: p.y }; }),
      }];
      /* 平均股息率线：与主曲线同一批日期（同一个 dividendYieldSeries 派生），按区间直接切片。
         样本门槛只会落在首尾两个财年段 —— 中间的财年都有约 240 个交易日，不可能不足 120 天 ——
         所以被跳过的那段永远在序列两端，折线不会跨过它连出一条假的斜线。 */
      var av = sliceByDate(avgAll, beg, end);
      if (av.length >= 2) {
        seriesList.push({
          key: 'avg', name: '历史平均股息率', color: YJ_AVG_COLOR, dash: '6 4', width: 1.5,
          points: av.map(function (p) { return { date: p.date, pct: p.y }; }),
        });
      }
      if (showBench && benchPts.length) {
        var bp = sliceByDate(benchPts.map(function (p) { return { date: p[0], y: p[1] }; }), beg, end);
        if (bp.length >= 2) {
          seriesList.push({
            key: 'bench', name: '余额宝七日年化', color: YJ_BENCH_COLOR,
            points: bp.map(function (p) { return { date: p.date, pct: p.y }; }),
          });
        }
      }
      var svg = XJ.chart.renderCompare(seriesList, {
        chartKey: 'yield', unit: 'yield', fmtY: U.pctAxis, xTicks: 4,
        markers: marks, markerColor: YJ_MARK_COLOR,
      });
      return { html: svg || '<div class="tiny" style="padding:18px 0;text-align:center">该区间内数据不足。</div>' };
    }

    var built = buildMain(begD, endD);

    /* brush 的概览序列：与主图同一批数据，这样拖动时左右边界一眼能对上 */
    var overview = all;

    function idxOfDate(list, d) {
      var best = 0, bestGap = Infinity;
      for (var i = 0; i < list.length; i++) {
        var g = Math.abs(U.daysBetween(list[i].date, d) || 0);
        if (g < bestGap) { bestGap = g; best = i; }
      }
      return best;
    }

    /* 拖动时间轴：**不碰 store**，直接重画主图容器的 innerHTML。
       brush 是独立的第二个 SVG，所以重画主图不会销毁抓手、手势不会断。 */
    function onChange(b, e, isFinal) {
      if (!(b && e) || b >= e) return;
      var box = document.querySelector('.yj-chart[data-yj-chart="1"]');
      if (box) box.innerHTML = buildMain(b, e).html;
      /* 每次变化都**静默**记进 ui（不走 setUI，否则整页重建 + 滚动跳动）。
         拖动中记是为了「万一中途被后台重渲染打断」时能接着拖（chart.js 会据此把选区找回来）；
         松手后记是为了让后续任何整页重渲染都能恢复用户选定的范围。 */
      st.ui.yjBeg = b;
      st.ui.yjEnd = e;
      void isFinal;
    }

    var brushHtml = XJ.chart.brush(overview, {
      chartKey: 'yield',
      begIdx: idxOfDate(overview, begD),
      endIdx: idxOfDate(overview, endD),
      color: '#A8C4E8',
      onChange: onChange,
    });

    /* ---- 图例 ----
       余额宝那条是「开 / 关」；平均股息率那条**不是开关**（均线常亮、不可关闭），
       点它是换口径 —— 所以刻意不给它 off 态，否则会被读成「这条线已关闭」。 */
    var benchOn = showBench && benchPts.length >= 2;
    var avgCum = avgMode === 'cum';
    var legend = '<div class="yj-legend">' +
      '<span class="on"><i class="ln" style="background:' + YJ_COLOR + '"></i>股息率</span>' +
      '<button class="yj-leg-btn" data-act="switchYieldAvg"' +
      ' title="点击切换口径：该财年整年均值 ⇄ 自切换日起逐日累积">' +
      '<i class="ln dash" style="--lnc:' + YJ_AVG_COLOR + '"></i>历史平均股息率 · ' +
      (avgCum ? '自切换日起累积' : '整年均值') + '</button>' +
      '<button class="yj-leg-btn' + (benchOn ? ' on' : ' off') + '" data-act="toggleYieldBench">' +
      '<i class="ln" style="background:' + (benchOn ? YJ_BENCH_COLOR : 'var(--text-3)') + '"></i>余额宝七日年化收益率</button>' +
      '<span class="on"><i class="sq" style="background:' + YJ_MARK_COLOR + '"></i>除权除息日</span>' +
      '</div>';

    /* ---- 当前读数 vs 均线：只给「高于 / 低于」，不给任何建议性措辞 ---- */
    var viewPts = sliceByDate(all, begD, endD);
    var lastPt = viewPts.length ? viewPts[viewPts.length - 1] : null;
    var avgStat = '';
    if (lastPt) {
      var avgRef = null;
      for (var ai = avgAll.length - 1; ai >= 0; ai--) {
        if (avgAll[ai].date <= lastPt.date) { avgRef = avgAll[ai]; break; }
      }
      if (avgRef && avgRef.year === lastPt.year) {
        avgStat = '当前 ' + lastPt.y.toFixed(2) + '% · FY' + lastPt.year +
          (avgCum ? ' 累积均值 ' : ' 均值 ') + avgRef.y.toFixed(3) + '% → ' +
          (lastPt.y >= avgRef.y ? '高于均值' : '低于均值');
      } else {
        var gg = null;
        for (var yi = 0; yi < avgGroups.length; yi++) {
          if (avgGroups[yi].year === lastPt.year) gg = avgGroups[yi];
        }
        if (gg) {
          avgStat = 'FY' + gg.year + ' 生效 ' + gg.days + ' 个交易日，不足 ' +
            XJ.calc.YIELD_AVG_MIN_DAYS + ' 天，暂不绘制该财年平均线。';
        }
      }
    }
    var avgStatHtml = avgStat ? '<div class="tiny yj-avg-stat">' + avgStat + '</div>' : '';

    var benchTip = '';
    if (benchOn) benchTip = '余额宝七日年化为周频（该数据本身极平滑，画日频只是徒增体积）。';
    else if (showBench) benchTip = '正在获取余额宝七日年化数据…';

    return open + head('最近十年 · 日线',
      '<button class="ghost-btn" data-act="refreshOne" data-symbol="' + U.esc(symbol) + '">刷新</button>') +
      legend + avgStatHtml +
      '<div class="yj-chart" data-yj-chart="1">' + built.html + '</div>' +
      (brushHtml ? '<div class="yj-brush">' + brushHtml + '</div>' : '') +
      '<div class="tiny yj-note" style="line-height:1.7">' +
      '注：股息率 = 该财年派现总额 ÷ 当时总市值（等价于每股派现 ÷ 当时股价）；' +
      '分子含已公告的预案，以最终实施方案为准。' +
      (benchTip ? '<br>' + U.esc(benchTip) : '') +
      '<br>曲线上的橙色方块是除权除息日；拖动下方时间轴可缩放时间尺度。' +
      '<br>平均股息率按财年分段计算：一个财年窗口内分子是常数，所以均线的高低只反映价格，' +
      '与「当年分红比历史平均多还是少」无关。' +
      (avgCum
        ? '当前口径「自切换日起累积」：只用生效日到当天的样本，没有前视偏差；代价是财年开头样本少、均线会较陡。'
        : '当前口径「整年均值」：用该财年整段窗口的样本，线条平稳；代价是年内用到了后面才发生的价格，回看历史信号有前视偏差。') +
      '<br>分子换档（年报预案公告日）会让均线跳一格，切换日附近读数仅供参考；' +
      '新财年样本不足 ' + XJ.calc.YIELD_AVG_MIN_DAYS + ' 个交易日时，该财年段不绘制。' +
      '</div></div>';
  }

  function render() {
    var st = XJ.store;
    var symbol = st.ui.subArg;
    if (!symbol) {
      return UI.emptyState('🔍', '未指定标的', '请从持仓列表进入。',
        '<button class="ghost-btn primary" data-act="closeSubPage">返回</button>');
    }

    var acc = st.acc();
    var h = XJ.calc.holdings(st.state, acc).filter(function (x) { return x.symbol === symbol; })[0];
    var plans = XJ.calc.plansOf(st.state, symbol);
    var txs = XJ.calc.txOf(st.state, acc, symbol).slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    var recs = st.state.received.filter(function (r) {
      return r.symbol === symbol && (acc === XJ.calc.ALL || r.accountId === acc);
    }).sort(function (a, b) { return a.exDividendDate < b.exDividendDate ? 1 : -1; });

    var name = st.symbolName(symbol);
    var quote = st.state.quoteCache[symbol];
    var price = h ? h.price : (quote ? U.num(quote.price) : null);
    var html = '';

    /* 技术信号（中性文案「日线下轨 / 周线下轨」，周线优先）。
       与持仓卡片共用同一套纯函数与口径，结果每次 render 现算、不缓存。 */
    var sigObj = signalOf(symbol, price);
    var sig = sigObj ? '<span class="hc-sig ' + sigObj.cls + '">' + U.esc(sigObj.text) + '</span>' : '';

    /* 无分红数据源的市场（如美股）如实提示，并给出手工补录的出口 */
    if (!XJ.market.supportsDividend(symbol)) {
      html += '<div class="warn-card"><span class="ic">ⓘ</span><span>' +
        '<b>' + U.esc(XJ.market.kind(symbol)) + '暂无公开可用的免费分红数据源</b>，无法自动同步分红方案与派息日。<br>' +
        '可在下方「分红记录」中手工补录历史分红，系统会照常计算股价息率与分红回本进度。</span></div>';
    }

    /* ① 预测年分红 */
    if (h) {
      html += '<div class="card" style="background:var(--slogan-grad);border:1px solid var(--warn-line);margin-bottom:12px">' +
        '<div style="display:flex;align-items:flex-start">' +
        '<div style="flex:1;min-width:0">' +
        '<div class="muted" style="font-size:12px">预测年分红</div>' +
        '<div style="font-size:32px;font-weight:750;letter-spacing:-1.2px;color:var(--dividend);margin-top:3px">' +
        U.moneySign(h.predictedDividendCny) + '</div>' +
        '<div class="tiny" style="margin-top:6px">每股 ' + U.money(h.annualPerShare, 4) + ' × ' + U.thousands(h.qty) + '股</div>' +
        '<div class="tiny" style="margin-top:2px">' + U.esc(C.planBasisLabel(h)) + '</div>' +
        '</div>' +
        '<button class="ghost-btn" data-act="openBasisEditor" data-symbol="' + U.esc(symbol) + '">觉得不准？</button>' +
        '</div>' +
        '</div>';
    }

    /* ② 当前市值 */
    html += '<div class="card" style="margin-bottom:12px">' +
      '<div style="display:flex;align-items:center;gap:12px">' +
      UI.avatar(name, symbol, 44, C.logoOf(h)) +
      '<div style="flex:1;min-width:0">' +
      '<div class="row-t"><span class="nm">' + U.esc(name) + '</span>' +
      (h && h.changePct !== null && h.changePct !== undefined
        ? '<span class="chg ' + (U.direction(h.changePct) === 'flat' ? 'flat' : U.direction(h.changePct)) + '">' + U.signPct(h.changePct) + '</span>' : '') +
      '</div>' +
      '<div class="row-s">' + U.esc(XJ.market.displayCode(symbol)) + sig + '</div>' +
      '</div>' +
      '<div style="text-align:right">' +
      '<div class="row-v ' + U.dirClass(h ? h.changePct : null) + '">' +
      (price === null ? '—' : U.money(price, price >= 100 ? 2 : 3)) + '</div>' +
      '<div class="row-v2">' + U.esc(XJ.market.currency(symbol)) + '</div>' +
      '</div></div>';

    if (h) {
      html += '<div class="hc-grid">' +
        '<div class="hc-cell"><div class="k">当前市值</div><div class="v">' + U.moneySign(h.marketValueCny) + '</div></div>' +
        '<div class="hc-cell"><div class="k">收盘价 × 股数</div><div class="v">' +
        (price === null ? '—' : U.money(price) + ' × ' + U.thousands(h.qty)) + '</div></div>' +
        '</div>';
    } else {
      html += '<div class="tiny" style="margin-top:10px">当前账户下没有该标的的持仓。</div>';
    }
    html += '</div>';

    /* ★ 股息率曲线（财年口径）—— 紧跟当前市值，位置最醒目。
       无持仓也照常渲染：这是标的的基本面属性，与是否持有无关。 */
    html += yieldCard(symbol, plans, st, h);

    if (h) {
      /* ③④⑤ 双息率 */
      html += '<div class="hc-grid" style="margin:0 0 12px;padding:0">' +
        '<div class="card" style="margin:0;padding:12px 14px">' +
        '<div class="tiny">成本息率' + C.qmark('每股年分红 ÷ 持仓成本 = ' + U.money(h.annualPerShare, 4) + ' ÷ ' + U.money(h.avgCost, 4)) + '</div>' +
        '<div style="font-size:22px;font-weight:730;color:var(--dividend);margin-top:3px">' +
        (h.costYield === null ? '已回本' : U.pct(h.costYield)) + '</div>' +
        '<div class="tiny">成本 ' + U.money(h.avgCost, 4) + '</div></div>' +
        '<div class="card" style="margin:0;padding:12px 14px">' +
        '<div class="tiny">股价息率' + C.qmark('每股年分红 ÷ 最新收盘价') + '</div>' +
        '<div style="font-size:22px;font-weight:730;color:var(--dividend);margin-top:3px">' +
        (h.dividendYield === null ? '—' : U.pct(h.dividendYield)) + '</div>' +
        '<div class="tiny">基于收盘价 ' + (price === null ? '—' : U.money(price)) + '</div></div>' +
        '</div>';

      /* ⑥⑦ 持仓明细：数量与成本可直接改（改的是流水，见下方说明） */
      html += '<div class="card" style="margin-bottom:12px">' +
        '<div class="card-head"><h2>持仓明细</h2><div class="spacer"></div>' +
        '<span class="hint">点带笔的数值可修改</span></div>' +
        '<button class="kv-edit" data-act="editQty" data-symbol="' + U.esc(symbol) + '">' +
        '<span class="k">持仓数量</span>' +
        '<span class="v">' + U.thousands(h.qty) + ' 股<span class="pen">' + UI.icon('edit', 13, 1.9) + '</span></span></button>' +
        '<button class="kv-edit" data-act="editCost" data-symbol="' + U.esc(symbol) + '">' +
        '<span class="k">当前成本' + C.qmark('成本口径：' + C.costMethodLabel(h.costMethod)) + '</span>' +
        '<span class="v">' + U.money(h.avgCost, 4) +
        ' <span class="pill div">' + C.costMethodLabel(h.costMethod) + '</span>' +
        '<span class="pen">' + UI.icon('edit', 13, 1.9) + '</span></span></button>' +
        '<div class="kv"><span class="k">已实现盈亏' + C.qmark('由卖出价格与卖出时点的加权成本共同决定，所以不可直接编辑') + '</span>' +
        '<span class="v ' + (h.costMethod === 'weighted' ? U.dirClass(h.realizedCny) : 'muted') + '">' +
        (h.costMethod === 'weighted' ? U.signMoney(h.realizedCny) : '摊薄口径下不适用') + '</span></div>' +
        '<div class="kv"><span class="k">持股天数' + C.qmark('自首笔买入日起算') + '</span>' +
        '<span class="v">' + h.holdDays + ' 天' + (h.holdSince ? '（' + U.esc(h.holdSince) + ' 起）' : '') + '</span></div>' +
        '<div class="kv"><span class="k">累计已获分红</span><span class="v c-div">' + U.moneySign(h.receivedTotalCny) + '</span></div>' +
        (h.costMethod === 'dividendDiluted'
          ? (h.receivedTotalCny > 0
            ? '<div class="note-line" style="margin-top:8px">' + UI.icon('check', 13) +
              /* 这一句讲的是「每股成本被摊薄了多少」，而每股成本是**原币**（港股就是港元），
                 所以金额也用原币并标出币种符号，否则 ¥ 总额配 HK$ 每股会自相矛盾。 */
              '<span>已用累计分红 <b class="c-div">' + U.esc(h.curSymbol) + U.money(h.receivedTotal, 0) +
              '</b> 摊薄成本（每股摊薄 ' + U.esc(h.curSymbol) + U.money(h.receivedTotal / (h.qty || 1), 4) +
              '）—— 分红到账后成本自动下降，无需手工改。</span></div>'
            : '<div class="note-line" style="margin-top:8px">' + UI.icon('info', 13) +
              '<span>当前口径是「分红摊薄」，但该标的还没有已到账的分红记录，所以成本尚未下降；' +
              '分红到账后会自动摊薄（A股按除权除息日、基金与港股按数据源给出的派息日）。</span></div>')
          : '') +
        '<div class="note-line" style="margin-top:8px">' + UI.icon('info', 13) +
        '<span>持仓由交易流水推导，因此改动会落成一笔记录：改数量补一笔买入/卖出，改成本补一笔「成本调整」，都可以在下方交易明细里删除。</span></div>' +
        '</div>';

    /* ⑧ 交易明细（可伸缩；点击任意一行可编辑）
     * 另外把该标的的**分红到账**以只读行并入，这样「分红摊薄成本」是怎么降下来的能直接看到
     * （同花顺的交易流水也是这么呈现的）。分红只是展示，真正的计算仍走 received 记录，
     * 因此不会与分红记录重复计数。 */
    /* 分红记录/流水里的「金额」一列都带 ¥，所以先换成人民币，避免港币分红显示成 ¥ 原值 */
    var yRate = XJ.calc.cnyRateOf(st.state, symbol);
    var divRows = recs.map(function (r) {
      return { kind: 'div', date: r.exDividendDate, amount: U.n0(r.amount) * yRate, perShare: U.n0(r.perShareAmount),
               qty: U.n0(r.qtyAtRecord), source: r.source };
    });
    var txFolded = st.ui.foldTx !== false;      // 默认收起
    html += '<div class="card flush" style="margin-bottom:12px">';
    html += '<div style="padding:14px 16px 8px"><div class="card-head" style="margin:0">' +
      '<button class="fold-head" data-act="toggleFoldTx">' +
      '<h2>交易明细</h2>' +
      '<span class="hint">' + txs.length + ' 笔' + (divRows.length ? ' + 分红 ' + divRows.length + ' 笔' : '') + '</span>' +
      '<span class="fold-caret' + (txFolded ? ' folded' : '') + '">' + UI.icon('chevron', 14) + '</span>' +
      '</button>' +
      '<div class="spacer"></div>' +
      '<button class="ghost-btn" data-act="addTxFor" data-symbol="' + U.esc(symbol) + '">+ 添加</button></div>' +
      '<div class="tiny" style="margin-top:2px">点击任意一行即可编辑；送股/转增用 0 元买入记录即可（股数增加而总成本不变）</div>' +
      '</div>';
    if (!txs.length && !divRows.length) {
      html += '<div style="padding:0 16px 16px" class="tiny">暂无交易记录。</div>';
    } else if (txFolded) {
      html += '<div class="fold-hint">已收起，共 ' + txs.length + ' 笔' +
        (divRows.length ? ' 交易 + ' + divRows.length + ' 笔分红摊薄' : '') + ' · 点标题展开查看</div>';
    } else {
      html += '<div class="table-wrap"><table class="tbl"><thead><tr>' +
        '<th>日期</th><th>方向</th><th>数量</th><th>价格</th><th>金额</th><th></th></tr></thead><tbody>';
      var combined = txs.map(function (t) { return { kind: 'tx', t: t, date: t.date }; })
        .concat(divRows)
        .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
      combined.forEach(function (row) {
        if (row.kind === 'div') {
          html += '<tr class="tx-row tx-div" title="分红到账自动摊薄成本（只读；手工补录的分红可在下方「分红记录」里删除）">' +
            '<td>' + U.esc(row.date) + '</td>' +
            '<td><span class="pill div">分红摊薄</span></td>' +
            '<td><span class="muted">—</span></td>' +
            '<td>' + (row.perShare > 0 ? U.money(row.perShare, 4) : '<span class="muted">—</span>') + '</td>' +
            '<td class="c-div">' + U.moneySign(row.amount) + '</td>' +
            '<td class="tx-edit">' + (row.source === 'AUTO' ? '<span class="tiny">自动</span>' : '<span class="tiny">手动</span>') + '</td>' +
            '</tr>';
          return;
        }
        var t = row.t;
        var isAdj = t.action === 'ADJUST';
        var amt = isAdj ? U.n0(t.amount) : U.n0(t.quantity) * U.n0(t.price);
        var dirPill = isAdj
          ? '<span class="pill div">成本调整</span>'
          : '<span class="pill ' + (t.action === 'BUY' ? 'up' : 'down') + '">' +
            (t.action === 'BUY' ? (U.n0(t.price) === 0 ? '送股' : '买入') : '卖出') + '</span>';
        html += '<tr class="tx-row" data-act="editTx" data-id="' + U.esc(t.txId) + '" title="点击编辑这笔记录">' +
          '<td>' + U.esc(t.date) + '</td>' +
          '<td>' + dirPill + '</td>' +
          '<td>' + (isAdj ? '<span class="muted">—</span>' : U.thousands(t.quantity)) + '</td>' +
          '<td>' + (isAdj ? '<span class="muted">—</span>' : U.money(t.price, 4)) + '</td>' +
          '<td class="' + (isAdj ? U.dirClass(amt) : '') + '">' + U.signMoney(amt) + '</td>' +
          '<td class="tx-edit">' + UI.icon('edit', 13) + '</td>' +
          '</tr>';
      });
      html += '</tbody></table></div>';
    }
    html += '</div>';

      /* ⑨ 分红回本进度 */
      html += '<div class="card" style="margin-bottom:12px">' +
        '<div class="card-head" style="margin-bottom:10px"><h2>分红回本进度</h2><div class="spacer"></div>' +
        '<span class="hint">' + (h.costRecovered ? '已标记回本' : U.pct(h.recoveryPct, 1)) + '</span></div>' +
        '<div class="bar' + (h.recoveryPct >= 100 ? ' green' : '') + '"><i style="width:' +
        U.clamp(h.recoveryPct, 0, 100).toFixed(1) + '%"></i></div>' +
        '<div class="recover-grid">' +
        '<div class="rc"><div class="k">净投入</div><div class="v">' + U.moneySign(h.netInvestedCny, 0) + '</div></div>' +
        '<div class="rc accent"><div class="k">已收回分红</div><div class="v">' + U.moneySign(h.receivedTotalCny, 0) + '</div></div>' +
        '<div class="rc"><div class="k">剩余待回收</div><div class="v">' + U.moneySign(h.remainingCny, 0) + '</div></div>' +
        '</div>' +
        '<div class="kv" style="margin-top:6px"><span class="k">预计回本</span><span class="v">' +
        (h.remainingCny <= 0 ? '已回本' : (h.expectedYears === null ? '—' : h.expectedYears.toFixed(1) + ' 年')) +
        '</span></div>' +
        '<div class="note-line" style="margin-top:8px">' + UI.icon('info', 13) +
        '<span>净投入 = 累计买入 − 累计卖出（卖出回款也算收回本金）；剩余待回收 ÷ 当前年分红 = 预计回本年。</span></div>' +
        '</div>';
    }

    /* ⑩ 分红档案（可折叠） */
    html += '<div class="card flush" style="margin-bottom:12px">';
    var planFolded = st.ui.foldPlans !== false;      // 默认收起（条数多时很长）
    html += '<div style="padding:14px 16px 8px"><div class="card-head" style="margin:0">' +
      '<button class="fold-head" data-act="toggleFoldPlans">' +
      '<h2>分红档案</h2>' +
      '<span class="hint">' + plans.length + ' 条</span>' +
      '<span class="fold-caret' + (planFolded ? ' folded' : '') + '">' + UI.icon('chevron', 14) + '</span>' +
      '</button>' +
      '<div class="spacer"></div>' +
      '<button class="ghost-btn" data-act="openBasisEditor" data-symbol="' + U.esc(symbol) + '">口径</button></div></div>';
    if (!plans.length) {
      html += '<div style="padding:0 16px 16px" class="tiny">暂无分红数据，点下方「同步该标的数据」获取。</div>';
    } else if (planFolded) {
      html += '<div style="padding:0 16px 14px" class="tiny">已收起，共 ' + plans.length +
        ' 条方案与预案 · 点标题展开查看</div>';
    } else {
      html += '<div class="table-wrap"><table class="tbl"><thead><tr>' +
        '<th>报告期</th><th>方案</th><th>股权登记日</th><th>除权除息日</th><th>状态</th></tr></thead><tbody>';
      plans.forEach(function (p) {
        var pl = C.progressLabel(p);
        html += '<tr>' +
          '<td>' + U.esc(p.reportDate) + '<div class="tiny">' + U.esc(p.reportType) + '</div></td>' +
          '<td style="text-align:left">' + U.esc(p.implPlanProfile || ('10派' + U.money(p.pretaxBonusPer10, 4) + '元')) + '</td>' +
          '<td>' + (p.equityRecordDate || '<span class="muted">—</span>') + '</td>' +
          '<td>' + (p.exDividendDate || '<span class="muted">—</span>') + '</td>' +
          '<td><span class="pill ' + pl.cls + '">' + U.esc(pl.text) + '</span></td>' +
          '</tr>';
      });
      html += '</tbody></table></div>';
    }
    html += '</div>';

    /* ⑪ 分红记录 */
    html += '<div class="card flush" style="margin-bottom:12px">';
    html += '<div style="padding:14px 16px 8px"><div class="card-head" style="margin:0"><h2>分红记录</h2>' +
      '<div class="spacer"></div><span class="hint">累计 ' +
      U.moneySign(U.sum(recs, function (r) { return r.amount; }) * yRate) + '</span>' +
      '<button class="ghost-btn" data-act="openReceiveEditor" data-symbol="' + U.esc(symbol) + '">+ 添加</button></div></div>';
    if (!recs.length) {
      html += '<div style="padding:0 16px 16px" class="tiny">还没有到账记录。已实施且派息日已过的方案会自动登记；历史数据可手动补录。</div>';
    } else {
      html += '<div class="table-wrap"><table class="tbl"><thead><tr>' +
        '<th>到账日</th><th>每股(税前)</th><th>数量</th><th>金额</th></tr></thead><tbody>';
      recs.forEach(function (r) {
        html += '<tr><td>' + U.esc(r.exDividendDate) + '<div class="tiny">' +
          (r.source === 'AUTO' ? '自动' : '手动') + '</div></td>' +
          '<td>' + (r.perShareAmount > 0 ? U.money(r.perShareAmount, 4) : '<span class="muted">—</span>') + '</td>' +
          '<td>' + (r.qtyAtRecord > 0 ? U.thousands(r.qtyAtRecord) : '<span class="muted">—</span>') + '</td>' +
          '<td class="c-div">' + U.moneySign(r.amount * yRate) +
          (r.source === 'MANUAL'
            ? '<div><button class="tiny" style="color:var(--up);margin-top:2px" data-act="deleteReceive" data-id="' +
            U.esc(r.recId) + '">删除</button></div>'
            : '') +
          '</td></tr>';
      });
      html += '</tbody></table></div>';
    }
    html += '</div>';

    /* ⑫ 操作 */
    html += '<button class="btn-block" data-act="addTxFor" data-symbol="' + U.esc(symbol) + '">记一笔交易</button>';
    html += '<button class="btn-block ghost" data-act="openPositionEditor" data-symbol="' + U.esc(symbol) + '">⚙ 编辑持仓</button>';
    html += '<button class="btn-block ghost" data-act="refreshOne" data-symbol="' + U.esc(symbol) + '">同步该标的数据</button>';

    return html;
  }

  return { render: render };
})();
