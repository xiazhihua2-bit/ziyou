/* ==================== 视图：分红汇总（独立子页面） ====================
 *
 * 取代了原先挂在「发现」页底部的「股息统计」区块 —— 内容搬到这里，并且多了：
 *   · 五个时间档位（今年 / 近2年 / 近5年 / 历史至今 / 自定义）
 *   · 「已到账」与「预计到账」分开列（预计绝不混进主数字）
 *   · 每只标的可展开的到账明细
 *
 * 口径全部来自 calc.dividendSummary（纯函数，verify.mjs 里有对应断言），
 * 视图层只负责排版，不自己算钱。
 */
XJ.views.divsummary = (function () {
  var U = XJ.util, UI = XJ.ui, C = XJ.views.common;

  /* ---------------- 时间档位 ---------------- */
  function chips(cur) {
    return '<div class="ds-ranges">' + XJ.calc.DIVSUM_RANGES.map(function (r) {
      return '<button class="chip' + (cur === r.key ? ' active' : '') +
        '" data-act="setDivsumRange" data-v="' + r.key + '">' + U.esc(r.label) + '</button>';
    }).join('') + '</div>';
  }

  function customRow(st) {
    if (st.ui.divsumRange !== 'custom') return '';
    return '<div class="ds-custom">' +
      '<input type="date" data-change="setDivsumBeg" aria-label="起始日期" value="' +
      U.esc(st.ui.divsumBeg || '') + '">' +
      '<span class="ds-custom-sep">至</span>' +
      '<input type="date" data-change="setDivsumEnd" aria-label="结束日期" value="' +
      U.esc(st.ui.divsumEnd || '') + '">' +
      '</div>';
  }

  /* ---------------- 主卡 ---------------- */
  function hero(sum, fun) {
    var n = XJ.calc.funEquivalent(sum.total, fun.monthly);
    return '<div class="card ds-hero">' +
      '<div class="ds-cap">分红总额</div>' +
      '<div class="ds-total">' + U.moneySign(sum.total) + '</div>' +
      '<div class="ds-rule"></div>' +
      '<div class="ds-kv"><span>到账笔数</span><span>' + sum.count + ' 笔</span></div>' +
      '<div class="ds-kv"><span>涉及标的</span><span>' + sum.bySymbolList.length + ' 只</span></div>' +
      (sum.pendingTotal > 0
        ? '<div class="ds-kv ds-pend"><span>另有预计到账</span><span>' +
          U.moneySign(sum.pendingTotal) + '</span></div>'
        : '') +
      (n !== null
        ? '<div class="ds-fun">这些分红相当于 ' + U.thousands(n) + ' 个月' +
          U.esc(fun.name) + ' 🎵</div>'
        : '') +
      '<div class="ds-quote">这些都是你的持仓为你赚来的被动收入 🫰</div>' +
      '</div>';
  }

  /* ---------------- 按标的（可展开到账明细） ---------------- */
  function symList(sum, st) {
    var open = st.ui.divsumOpen || '';
    return '<div class="section-title">按标的</div>' +
      sum.bySymbolList.map(function (g) {
        var isOpen = open === g.symbol;
        var rows = g.records.map(function (r) {
          var qty = U.n0(r.qtyAtRecord);
          return '<div class="ds-rec">' +
            '<span class="ds-rec-d">' + U.esc(String(r.exDividendDate || '').slice(5)) + '</span>' +
            '<span class="ds-rec-m">每股 ' + U.money(r.perShareAmount, 3) +
            ' × ' + U.thousands(qty) + ' 股</span>' +
            '<span class="ds-rec-a">' + U.moneySign(r.amount) + '</span>' +
            '</div>';
        }).join('');
        return '<div class="ds-sym' + (isOpen ? ' open' : '') + '">' +
          '<button class="ds-row" data-act="toggleDivsumSym" data-sym="' + U.esc(g.symbol) + '"' +
          ' aria-expanded="' + (isOpen ? 'true' : 'false') + '">' +
          '<span class="ds-code">' + U.esc(XJ.model.codeOf(g.symbol)) + '</span>' +
          '<span class="ds-name">' + U.esc(st.symbolName(g.symbol)) + '</span>' +
          '<span class="ds-sp"></span>' +
          '<span class="ds-amt">' + U.moneySign(g.amount) + '</span>' +
          '<span class="chev">' + UI.icon('chevron', 15, 2) + '</span>' +
          '</button>' +
          (isOpen ? '<div class="ds-detail">' + rows + '</div>' : '') +
          '</div>';
      }).join('');
  }

  /* ---------------- 按年（原「发现 · 股息统计」的年度汇总，搬到这里） ----------------
     区间跨 2 个自然年以上才有意义，单年区间不占版面。 */
  function yearBars(sum) {
    if (sum.years.length < 2) return '';
    var max = Math.max.apply(null, sum.years.map(function (y) { return sum.byYear[y]; }).concat([1]));
    return '<div class="section-title">按年</div><div class="card">' +
      sum.years.map(function (y) {
        var amt = sum.byYear[y];
        var w = Math.max(2, amt / max * 100);
        return '<div class="ds-year">' +
          '<div class="ds-year-top"><span>' + y + ' 年</span>' +
          '<span class="c-div ds-year-amt">' + U.moneySign(amt) + '</span></div>' +
          '<div class="bar"><i style="width:' + w.toFixed(1) + '%"></i></div>' +
          '</div>';
      }).join('') + '</div>';
  }

  /* ---------------- 主渲染 ---------------- */
  function render() {
    var st = XJ.store;
    var html = '';
    html += C.statusBanner();
    html += C.accountSwitcher();

    if (!st.hasAnyData()) {
      html += UI.emptyState('📒', '还没有数据',
        '先添加持仓。分红到账后系统会自动登记，这里就会汇总出来。',
        '<button class="ghost-btn primary" data-act="openAddHolding">添加持仓</button>');
      return html;
    }

    /* 档位校验：ui 里可能是旧值/脏值，一律退回「今年」 */
    var key = st.ui.divsumRange;
    var known = XJ.calc.DIVSUM_RANGES.some(function (r) { return r.key === key; });
    if (!known) key = 'year';

    var sum = XJ.calc.dividendSummary(st.state, st.acc(), {
      type: key, beg: st.ui.divsumBeg, end: st.ui.divsumEnd,
    });
    var fun = (st.state.settings && st.state.settings.dividendFun) || { name: '视频会员', monthly: 25 };

    html += '<div class="ds-head">分红汇总</div>';
    html += chips(key);
    html += customRow(st);

    if (!(sum.total > 0) && !(sum.pendingTotal > 0)) {
      html += UI.emptyState('🌾', '这个区间没有分红',
        '换一个时间档位看看，或者在「我的 · 分红流水」里补录一笔。');
      return html;
    }

    html += hero(sum, fun);

    if (sum.total > 0) {
      html += symList(sum, st);
      html += yearBars(sum);
    } else {
      html += '<div class="card"><div class="tiny" style="line-height:1.8">' +
        '这个区间还没有分红到账，另有 <b class="c-div">' + U.moneySign(sum.pendingTotal) +
        '</b> 预计到账（' + sum.pendingCount + ' 笔）。到账后会自动登记在这里。</div></div>';
    }

    html += '<div class="tiny ds-note">' +
      '口径：金额一律为<b>税前</b>；「分红总额」只统计<b>已到账</b>（与「我的 · 分红流水」逐笔一致），' +
      '未到账的部分单列在「另有预计到账」里，不混进总额。' +
      'A 股派息日按除权除息日推算，实际到账可能晚 1-2 天。' +
      '</div>';
    return html;
  }

  return { render: render };
})();
