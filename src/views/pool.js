/* ==================== 股票池视图（515450 · 50 只成分股） ====================
 * 入口：自选页顶部「股票池」按钮 → navTo({subPage:'pool'})；五 Tab 体系完全不动。
 *
 * 与自选列表的关系：
 *   · 行结构 / 字段顺序 / 样式全部复用 .wl-row / .wl-nm / .wl-yld / .wl-pct / .wl-px，
 *     仅去掉 64px 分时列（股票池不画分时）与删除按钮（池是只读快照）。
 *   · 头像只渲染内嵌的官方 logo data URI，**不生成 .av-txt 中文文字层** ——
 *     任何情况下（离线、图片异常）都不会出现中文首字母。
 *   · 排序直接复用 XJ.wlSort：headerHtml('pool') + sortItems（items 挂 __m），
 *     三态 无→降→升→无、箭头高亮、就地换序、状态按 groupId 'pool' 存 localStorage。
 *   · 息率 / 分位与自选同源：calc.yieldNow / calc.yieldPercentile，cur 用实时价、
 *     历史分布用快照内嵌的不复权日收盘；窗口跟随 settings.yieldPctWin。
 *
 * 数据边界：快照不进 state、不进导出、不进同步；行情只放本模块内存 pxMemo，
 * 不写 quoteCache / symbols，避免 50 只标的污染现有档案与同步账本。
 */
XJ.views.pool = (function () {
  var U = XJ.util, UI = XJ.ui, S = XJ.store, C = XJ.calc, P = XJ.pool515450;

  var GROUP = 'pool';
  var PX_TTL = 60000;
  var pxMemo = { at: 0, quotes: {} };
  var pxPending = false;

  /* ---------------- 取值（显示与排序共用同一份，口径不分叉） ---------------- */

  function winOf() {
    var w = U.num(S.state.settings && S.state.settings.yieldPctWin);
    return C.YIELD_PCT_WINDOWS.indexOf(w) >= 0 ? w : C.YIELD_PCT_DEFAULT;
  }

  function quoteOf(sym) {
    return pxMemo.quotes[sym] || (S.state.quoteCache && S.state.quoteCache[sym]) || null;
  }

  /** 实时价优先；没拉到时用快照最后一个收盘价兜底（离线首屏也能完整展示 50 行） */
  function priceOf(it) {
    var q = quoteOf(it.s);
    if (q && q.price != null && q.price > 0) {
      return { price: q.price, prevClose: q.prevClose != null ? q.prevClose : null, live: true };
    }
    var cs = P.closesOf(it);
    return { price: cs.length ? cs[cs.length - 1][1] : null, prevClose: null, live: false };
  }

  function metricsOf(it, price) {
    if (!(price > 0)) return { yld: null, pct: null };
    var yld = C.yieldNow(it.plans, price, U.today());
    var pct = null;
    var cs = P.closesOf(it);
    if (cs.length >= 2) {
      var r = C.yieldPercentile(it.plans, cs, {
        years: winOf(), today: U.today(), price: price,
      });
      if (r && !r.insufficient && typeof r.pct === 'number' && isFinite(r.pct)) pct = r.pct;
    }
    return { yld: yld, pct: pct };
  }

  function rowsOf() {
    return P.items().map(function (it) {
      var px = priceOf(it);
      return { symbol: it.s, item: it, px: px, __m: metricsOf(it, px.price) };
    });
  }

  function sortedRows(base) {
    /* __m 已给出，sortItems 不会再去 state 里取 plans/yieldHistory */
    return XJ.wlSort.sortItems(base || rowsOf(), GROUP, {});
  }

  /* ---------------- 渲染 ---------------- */

  function yieldHtml(m) {
    var v = m.pct === null ? null : Math.round(m.pct);
    var out = '<i class="wl-yld">';
    if (m.yld !== null) out += '<em class="wl-yld-t">息 ' + U.pct(m.yld) + '</em>';
    if (v === null) {
      out += '<u class="wl-pct lo" title="近 ' + winOf() + ' 年样本不足 120 个交易日">样本不足</u>';
    } else {
      out += '<u class="wl-pct' + (v >= 80 ? ' hi' : (v <= 20 ? ' lo' : '')) + '"' +
        ' title="股息率分位：按本财年派现（含预案）÷ 实时价，高于近 ' + winOf() + ' 年 ' + v + '% 的交易日">分位 ' + v + '</u>';
    }
    return out + '</i>';
  }

  function rowHtml(row) {
    var it = row.item, sym = row.symbol;
    var code = XJ.model.codeOf(sym);
    var price = row.px.price;
    var priceTxt = price ? U.money(price, price < 10 ? 3 : 2) : '—';
    var chg = row.px.live && row.px.prevClose ? price - row.px.prevClose : null;
    var pctChg = chg !== null && row.px.prevClose ? chg / row.px.prevClose * 100 : null;
    var dir = chg === null ? 'flat' : (chg >= 0 ? 'up' : 'down');
    var chgTxt = chg === null ? '' :
      (chg >= 0 ? '+' : '') + U.money(chg, 2) + (pctChg === null ? '' : '  ' + U.signPct(pctChg));

    /* 官方图标：只有 .av-img，没有 .av-txt —— 绝不回退中文首字母 */
    var av = '<div class="avatar" style="width:40px;height:40px;background:' + U.colorOf(sym) + '">' +
      '<img class="av-img" src="' + U.esc(it.logo) + '" alt="' + U.esc(it.n) + ' 官方标识" loading="lazy"></div>';

    return '<div class="card wl-row pool-row" data-sym="' + U.esc(sym) + '" data-act="poolOpenSymbol">' +
      '<div class="wl-av">' + av + '</div>' +
      '<div class="wl-nm"><span>' + U.esc(it.n) + '</span><b><span class="wl-code">' + U.esc(code) + '</span></b>' +
      yieldHtml(row.__m) + '</div>' +
      '<div class="wl-px">' +
      '<b class="wl-price wl-' + dir + '">' + priceTxt + '</b>' +
      '<div class="wl-chg ' + (dir === 'up' ? 'c-up' : dir === 'down' ? 'c-down' : '') + '">' + chgTxt + '</div>' +
      '</div>' +
      '</div>';
  }

  function headHtml() {
    return '<div class="card pool-head">' +
      '<div class="pool-h1">股票池 <span>' + U.esc(P.FUND) + '</span></div>' +
      '<div class="tiny">南方标普中国A股大盘红利低波50ETF · ' + P.items().length + ' 只成分股</div>' +
      '<div class="tiny">数据截至 ' + U.esc(P.AS_OF) + '（半年报全量持仓） · 近 ' + winOf() + ' 年股息率分位</div>' +
      '<div class="tiny">息率与分位按实时价重算 · 价格每 60 秒跟随刷新</div>' +
      '</div>';
  }

  function sortStat() {
    var s = XJ.wlSort.stateOf(GROUP);
    if (!s.field) return '默认：按成分股权重 · 共 ' + P.items().length + ' 只';
    var label = s.field === 'yld' ? '股息率' : '百分位';
    return '当前：按' + label + (s.dir === 'desc' ? '降序 ↓' : '升序 ↑') + ' · 共 ' + P.items().length + ' 只';
  }

  function render() {
    var rows = sortedRows();
    return headHtml() +
      XJ.wlSort.headerHtml(GROUP) +
      '<div class="pool-sortstat">' + U.esc(sortStat()) + '</div>' +
      '<div class="wl-list" data-wl-group="' + GROUP + '">' +
      rows.map(rowHtml).join('') + '</div>' +
      '<div class="pool-foot tiny">静态快照离线可用 · 股息率分位口径与自选列表一致</div>';
  }

  /* ---------------- 就地换序（不重建整页、不闪、不跳滚动） ---------------- */

  function applyOrder(rows) {
    var list = document.querySelector('.wl-list[data-wl-group="' + GROUP + '"]');
    if (!list || !rows.length) return false;
    var bySym = {};
    Array.prototype.forEach.call(list.children, function (el) {
      var s = el.getAttribute && el.getAttribute('data-sym');
      if (s) bySym[s] = el;
    });
    if (Object.keys(bySym).length !== rows.length) return false;
    var used = {}, ordered = [];
    for (var i = 0; i < rows.length; i++) {
      var s = rows[i].symbol, el = bySym[s];
      if (!el || used[s]) return false;
      used[s] = true;
      ordered.push(el);
    }
    ordered.forEach(function (el) { list.appendChild(el); });
    return true;
  }

  function replaceBar() {
    var bar = document.querySelector('.wl-sortbar');
    if (bar) {
      var wrap = document.createElement('div');
      wrap.innerHTML = XJ.wlSort.headerHtml(GROUP);
      if (wrap.firstChild) bar.parentNode.replaceChild(wrap.firstChild, bar);
    }
    var stat = document.querySelector('.pool-sortstat');
    if (stat) stat.textContent = sortStat();
  }

  function toggleSort(g, f) {
    if (g && g !== GROUP) return;
    XJ.wlSort.cycle(GROUP, f);
    if (applyOrder(sortedRows())) { replaceBar(); return; }
    S.setUI({ poolSortTick: Date.now() });   // 兜底：换序失败就整页重绘
  }

  /* ---------------- 实时行情（进页一次 + 全局 60s 节拍） ---------------- */

  function ensureQuotes(force) {
    if (pxPending || S.ui.subPage !== GROUP) return;
    if (!force && Date.now() - pxMemo.at < PX_TTL) return;
    pxPending = true;
    XJ.fetcher.fetchQuotes(P.symbols()).then(function (qs) {
      pxPending = false;
      var n = 0;
      Object.keys(qs || {}).forEach(function (k) {
        if (qs[k]) { pxMemo.quotes[k] = qs[k]; n++; }
      });
      if (n) {
        pxMemo.at = Date.now();
        /* 整页重渲 → 息率 / 分位 / 价格 / 排序按新价一起重算，排序态保持不变 */
        S.setUI({ poolTick: Date.now() });
      }
    }).catch(function () { pxPending = false; });
  }

  function bind() { ensureQuotes(false); }
  function tickQuotes(force) { ensureQuotes(force !== false); }

  /* 供浏览器探针断言用（不参与渲染） */
  function debug() {
    return {
      count: P.items().length,
      logos: P.items().filter(function (x) { return /^data:image\/png;base64,/.test(x.logo); }).length,
      days: P.DAYS.length,
      win: winOf(),
      sort: XJ.wlSort.stateOf(GROUP),
      liveQuotes: Object.keys(pxMemo.quotes).length,
    };
  }

  return {
    render: render, bind: bind, tickQuotes: tickQuotes,
    toggleSort: toggleSort, debug: debug,
  };
})();
