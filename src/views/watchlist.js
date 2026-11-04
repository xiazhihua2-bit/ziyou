/* ==================== 视图：自选（六 Tab 二期） ====================
 * 顶栏（图三 + 需求 6）：左 = 指数卡（点卡片弹 8 指数 chips 切换），右 = 搜索框（进搜索子页）。
 * 分组行（图二）：全部 / 持仓（虚拟组）+ 自定义组 + 三条杠（分组弹层）。
 * 列表行：官方 Logo + 名称/代码 + 当日分时迷你曲线（懒加载 5 分钟缓存）+
 *         实底色块白字价格 + 涨跌额/涨跌%（涨红跌绿）。
 * 行情 / 分时走模块级 memo（TTL 缓存，不落盘、不进同步）；自选数据本身走 store 的
 * wgrp/witem（跨设备同步）。
 */
XJ.views.watchlist = (function () {
  var U = XJ.util, UI = XJ.ui, C = XJ.views.common;

  /* ---------------- 指数（图三） ---------------- */
  var WL_INDEXES = [
    { key: 'sh000001', name: '上证指数' },
    { key: 'sz399001', name: '深证成指' },
    { key: 'sz399006', name: '创业板指' },
    { key: 'sh000300', name: '沪深300' },
    { key: 'hkHSI', name: '恒生指数' },
    { key: 'hkHSTECH', name: '恒生科技' },
    { key: 'usDJI', name: '道琼斯' },
    { key: 'usIXIC', name: '纳斯达克' },
  ];
  var IDX_TTL = 60000;
  var idxMemo = { at: 0, quotes: {} };
  var idxPending = false;

  function ensureIndexQuotes() {
    if (idxPending || Date.now() - idxMemo.at < IDX_TTL) return;
    idxPending = true;
    XJ.fetcher.fetchQuotes(WL_INDEXES.map(function (i) { return i.key; })).then(function (qs) {
      idxPending = false;
      var got = 0;
      Object.keys(qs || {}).forEach(function (k) {
        if (qs[k]) { idxMemo.quotes[k] = qs[k]; got++; }
      });
      if (got) { idxMemo.at = Date.now(); XJ.store.setUI({ wlTick: Date.now() }); }
    }).catch(function () { idxPending = false; });
  }

  /* ---------------- 自选行情（价格徽章） ---------------- */
  var PX_TTL = 60000;
  var pxMemo = { at: 0, quotes: {} };
  var pxPending = false;

  function ensurePxQuotes(syms, force) {
    var want = force ? syms.slice() : syms.filter(function (s) {
      return !(pxMemo.quotes[s] && Date.now() - pxMemo.at < PX_TTL);
    });
    if (pxPending || !want.length) return;
    pxPending = true;
    XJ.fetcher.fetchQuotes(want).then(function (qs) {
      pxPending = false;
      var got = 0;
      Object.keys(qs || {}).forEach(function (k) {
        if (qs[k]) { pxMemo.quotes[k] = qs[k]; got++; }
      });
      if (got) {
        pxMemo.at = Date.now();
        /* 合并进 quoteCache：个股档案页（无持仓自选标的）直接读它拿价格/名称 */
        try { XJ.store.mergeQuotes(qs); } catch (e) { /* 忽略 */ }
        /* 整页重渲染 → 每行的「息 / 分位」用新价立刻重算（这就是「实时变动」的实现点） */
        XJ.store.setUI({ wlTick: Date.now() });
      }
    }).catch(function () { pxPending = false; });
  }

  /* ---------------- 股息率分位（只做 A股） ----------------
   * 用户定调：自选里 ETF / 港股 / 美股 / 日股 / 场外一律不显示、也不请求。
   * 数据（分红方案 + 十年日线）由 app.ensurePctData 串行补齐；进视口才发起。
   * 现价一跳，这里重算 → 分位实时变动。 */
  function pctWinOf(st) {
    var w = U.num(st.state.settings && st.state.settings.yieldPctWin);
    return XJ.calc.YIELD_PCT_WINDOWS.indexOf(w) >= 0 ? w : XJ.calc.YIELD_PCT_WINDOWS[0];
  }

  function yieldInner(st, sym) {
    if (XJ.market.assetType(sym) !== 'stock') return '';
    var plans = XJ.calc.plansOf(st.state, sym) || [];
    if (!plans.length) return '';
    var q = quoteOf(sym);
    var price = q && q.price != null ? q.price : null;
    var out = '';
    var y = XJ.calc.yieldNow(plans, price, U.today());
    if (y !== null) out += '<em class="wl-yld-t">息 ' + U.pct(y) + '</em>';
    var cache = st.state.yieldHistory && st.state.yieldHistory[sym];
    if (cache && cache.day && cache.day.length >= 2) {
      var w = pctWinOf(st);
      var r = XJ.calc.yieldPercentile(plans, cache.day, { years: w, today: U.today(), price: price });
      if (r && !r.insufficient) {
        var v = Math.round(r.pct);
        out += '<u class="wl-pct' + (v >= 80 ? ' hi' : (v <= 20 ? ' lo' : '')) + '"' +
          ' title="股息率分位：按本财年派现（含预案）÷ 实时价，高于近 ' + w + ' 年 ' +
          v + '% 的交易日">' + v + '</u>';
      }
    }
    return out;
  }

  function yieldHtmlOf(st, sym) {
    if (XJ.market.assetType(sym) !== 'stock') return '';
    return '<i class="wl-yld" data-yld="' + U.esc(sym) + '">' + yieldInner(st, sym) + '</i>';
  }

  /** 数据到齐后就地填这一行（app.ensurePctData 完成后调用，不整页重绘） */
  function fillYield(sym) {
    var el = document.querySelector('.wl-yld[data-yld="' + sym + '"]');
    if (!el) return;
    el.innerHTML = yieldInner(XJ.store, sym);
  }

  /* ---------------- 30 秒实时节拍（只在自选页、只在开市时） ----------------
   * 持仓标的由全局 refreshAll（60s）负责，这里只刷「非持仓的自选 A股」，
   * 避免同一只票被两套节拍各请求一次。页面隐藏 / 切走 Tab / 全市场休市 → 不发请求。 */
  var LIVE_MS = 30000;
  var liveSyms = [];

  function liveTick() {
    var st = XJ.store;
    if (st.ui.tab !== 'watchlist' || st.ui.subPage) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (!liveSyms.length) return;
    var open = liveSyms.filter(function (s) {
      try { return XJ.market.sessionOpen(s); } catch (e) { return false; }
    });
    if (!open.length) return;
    ensurePxQuotes(open, true);
  }
  if (typeof setInterval !== 'undefined') setInterval(liveTick, LIVE_MS);

  /* ---------------- 当日分时迷你曲线（懒加载 · 5 分钟缓存） ----------------
   * 占位节点 .wl-spark[data-pending="1"] 由 bind() 里的 IntersectionObserver 监听，
   * 进入视口才逐只拉分时（美股走东财 trends，A股/港股走腾讯 minute，见 fetcher）。
   * 拉完直接写 memo + 就地填 DOM —— 不触发整页重绘，滚动不跳。 */
  var SPARK_TTL = 300000;
  var sparkMemo = {};         // sym -> { at, svg }
  var sparkPending = {};      // sym -> true（请求去重）
  var sparkObserver = null;

  function sparkOf(sym) {
    var hit = sparkMemo[sym];
    if (hit && Date.now() - hit.at < SPARK_TTL) return hit.svg;
    return null;
  }

  function buildSparkSvg(points, prevClose) {
    if (!points || points.length < 2) return '';
    var w = 64, h = 24, pad = 1;
    var lo = Infinity, hi = -Infinity;
    points.forEach(function (p) {
      if (p.p < lo) lo = p.p;
      if (p.p > hi) hi = p.p;
    });
    if (prevClose) { if (prevClose < lo) lo = prevClose; if (prevClose > hi) hi = prevClose; }
    if (!isFinite(lo) || hi - lo < 1e-9) { hi = lo + 1; lo -= 1; }
    var span = hi - lo;
    var step = (w - pad * 2) / (points.length - 1);
    var pts = points.map(function (p, i) {
      var x = (pad + i * step).toFixed(1);
      var y = (pad + (hi - p.p) / span * (h - pad * 2)).toFixed(1);
      return x + ',' + y;
    });
    var last = points[points.length - 1].p;
    var up = prevClose ? last >= prevClose : true;
    var color = up ? 'var(--up)' : 'var(--down)';
    var baseLine = '';
    if (prevClose && prevClose >= lo && prevClose <= hi) {
      var by = (pad + (hi - prevClose) / span * (h - pad * 2)).toFixed(1);
      baseLine = '<line x1="' + pad + '" y1="' + by + '" x2="' + (w - pad) + '" y2="' + by +
        '" stroke="var(--text-3)" stroke-width=".6" stroke-dasharray="2 2" opacity=".55"/>';
    }
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h +
      '" fill="none" aria-hidden="true">' + baseLine +
      '<polyline points="' + pts.join(' ') + '" stroke="' + color + '" stroke-width="1.2" ' +
      'stroke-linejoin="round" stroke-linecap="round" fill="none"/></svg>';
  }

  function loadSpark(sym, prevClose) {
    if (sparkPending[sym] || sparkMemo[sym]) return;
    sparkPending[sym] = true;
    XJ.fetcher.fetchMinutes([sym]).then(function (map) {
      delete sparkPending[sym];
      var m = map && map[sym];
      if (!m || !m.points || m.points.length < 2) { sparkMemo[sym] = { at: Date.now(), svg: '' }; return; }
      var svg = buildSparkSvg(m.points, prevClose);
      sparkMemo[sym] = { at: Date.now(), svg: svg };
      /* 就地填充（不整页重绘，滚动不跳） */
      var el = document.querySelector('.wl-spark[data-spark="' + sym + '"]');
      if (el) { el.innerHTML = svg; el.removeAttribute('data-pending'); }
    }).catch(function () { delete sparkPending[sym]; });
  }

  /** 视图渲染后钩子（app.render 调用）：懒加载 spark + 分位数据 */
  function bind() {
    bindSpark();
    bindYield();
  }

  function bindSpark() {
    if (sparkObserver) sparkObserver.disconnect();
    var spots = Array.prototype.slice.call(document.querySelectorAll('.wl-spark[data-pending="1"]'));
    if (!spots.length) return;
    if (typeof IntersectionObserver === 'undefined') {
      spots.forEach(function (el) {
        var s0 = el.getAttribute('data-spark');
        var q0 = quoteOf(s0);
        loadSpark(s0, q0 && q0.prevClose != null ? q0.prevClose : null);
      });
      return;
    }
    sparkObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var sym = en.target.getAttribute('data-spark');
        sparkObserver.unobserve(en.target);
        var q = quoteOf(sym);
        loadSpark(sym, q && q.prevClose != null ? q.prevClose : null);
      });
    }, { rootMargin: '40px' });
    spots.forEach(function (el) { sparkObserver.observe(el); });
  }

  /* 分位数据懒加载：观察进视口的 .wl-yld 行（只对 A股 存在这个节点）。
     数据到齐后 app.ensurePctData 调 fillYield 就地填，不整页重绘。 */
  var yieldObserver = null;
  function bindYield() {
    if (yieldObserver) { yieldObserver.disconnect(); yieldObserver = null; }
    var spots = Array.prototype.slice.call(document.querySelectorAll('.wl-yld[data-yld]'));
    if (!spots.length) return;
    var ask = function (el) {
      var sym = el.getAttribute('data-yld');
      if (XJ.app && XJ.app.ensurePctData) XJ.app.ensurePctData(sym);
    };
    if (typeof IntersectionObserver === 'undefined') { spots.forEach(ask); return; }
    yieldObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        yieldObserver.unobserve(en.target);
        ask(en.target);
      });
    }, { rootMargin: '120px' });
    spots.forEach(function (el) { yieldObserver.observe(el); });
  }

  /* ---------------- 渲染 ---------------- */

  function quoteOf(sym) {
    return pxMemo.quotes[sym] || XJ.store.state.quoteCache[sym] || null;
  }

  function indexBar(st) {
    var cur = st.ui.wlIndex || WL_INDEXES[0].key;
    var meta = WL_INDEXES.filter(function (i) { return i.key === cur; })[0] || WL_INDEXES[0];
    var q = idxMemo.quotes[meta.key] || null;
    var chg = q && q.price != null && q.prevClose != null ? q.price - q.prevClose : null;
    var pct = q && chg !== null && q.prevClose ? chg / q.prevClose * 100 : null;
    var dir = chg === null ? '' : (chg >= 0 ? 'c-up' : 'c-down');
    ensureIndexQuotes();
    return '<div class="wl-topbar">' +
      '<button class="wl-index" data-act="wlIndexPick" aria-label="切换指数">' +
      '<div class="wi-name">' + U.esc(meta.name) +
      '<svg class="wi-caret" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9.5l6 6 6-6"/></svg></div>' +
      '<div class="wi-main"><b class="' + dir + '">' + (q && q.price != null ? U.money(q.price, 2) : '—') + '</b>' +
      '<span class="' + dir + '">' + (chg === null ? '' : (chg >= 0 ? '+' : '') + U.money(chg, 2) + (pct === null ? '' : ' · ' + U.signPct(pct))) + '</span></div>' +
      '</button>' +
      '<button class="wl-search" data-act="openSearch" aria-label="搜索加自选">' +
      UI.icon('search', 15) + '<span>代码 / 名称</span></button>' +
      '</div>';
  }

  function chipsBar(st, groups, cur) {
    var chips = [{ id: 'all', name: '全部' }, { id: 'holding', name: '持仓' }].concat(
      groups.map(function (g) { return { id: g.groupId, name: g.name }; }));
    return '<div class="wl-chips">' + chips.map(function (c) {
      return '<button class="wl-chip' + (cur === c.id ? ' active' : '') +
        '" data-act="wlPickGroup" data-g="' + U.esc(c.id) + '">' + U.esc(c.name) + '</button>';
    }).join('') +
      '<button class="wl-chip wl-more" data-act="openWlGroups" aria-label="管理分组">' +
      UI.icon('menu', 14) + '</button></div>';
  }

  function rowHtml(st, it) {
    var sym = it.symbol;
    var q = quoteOf(sym);
    var name = st.symbolName(sym);
    var code = XJ.model.codeOf(sym);
    var price = q && q.price != null
      ? U.money(q.price, q.price < 10 ? 3 : 2)
      : '—';
    var chg = q && q.price != null && q.prevClose != null ? q.price - q.prevClose : null;
    var pct = chg !== null && q.prevClose ? chg / q.prevClose * 100 : null;
    var dir = chg === null ? '' : (chg >= 0 ? 'up' : 'down');
    var chgTxt = chg === null ? '' :
      (chg >= 0 ? '+' : '') + U.money(chg, 2) + (pct === null ? '' : '  ' + U.signPct(pct));
    var spark = sparkOf(sym);
    return '<div class="card wl-row" data-sym="' + U.esc(sym) + '" data-act="wlOpenSymbol">' +
      '<div class="wl-av">' + UI.avatar(name, sym, 40, C.logoFor(sym)) + '</div>' +
      '<div class="wl-nm"><span>' + U.esc(name) + '</span><b>' + U.esc(code) +
      yieldHtmlOf(st, sym) + (it.holding ? '<i class="wl-tag">持仓</i>' : '') + '</b></div>' +
      '<div class="wl-spark" data-spark="' + U.esc(sym) + '"' + (spark === null ? ' data-pending="1"' : '') + '>' +
      (spark || '') + '</div>' +
      '<div class="wl-px">' +
      '<b class="wl-price wl-' + (dir || 'flat') + '">' + price + '</b>' +
      '<div class="wl-chg ' + (dir === 'up' ? 'c-up' : dir === 'down' ? 'c-down' : '') + '">' + chgTxt + '</div>' +
      '</div>' +
      (it.holding ? '' : '<button class="wl-del" data-act="wlRemoveItem" data-item="' + U.esc(it.itemId) +
        '" aria-label="从自选移除">' + UI.icon('close', 12) + '</button>') +
      '</div>';
  }

  function render() {
    var st = XJ.store;
    var groups = st.wlGroups();
    var cur = st.ui.wlGroup || 'all';
    var items = st.wlItems(cur);
    /* 组内顺序 = 加入时间（addedAt）；「持仓」虚拟组按 sortOrder 稳定序 */
    var rows = items.slice().sort(function (a, b) {
      return String(a.addedAt || '').localeCompare(String(b.addedAt || ''));
    });

    var html = '';
    html += indexBar(st);
    html += chipsBar(st, groups, cur);

    if (!rows.length) {
      var gName = cur === 'all' || cur === 'holding' ? '' :
        ((groups.filter(function (g) { return g.groupId === cur; })[0] || {}).name || '') + ' ';
      var tip = cur === 'holding' ? '还没有持仓记录' : (gName + '自选还是空的');
      html += '<div class="card" style="text-align:center;padding:38px 18px">' +
        '<div style="font-size:40px;line-height:1">⭐</div>' +
        '<div style="font-size:15px;font-weight:650;margin-top:10px">' + U.esc(tip) + '</div>' +
        '<div class="tiny" style="margin-top:6px">点上方「代码 / 名称」搜索股票，点星加入自选。</div>' +
        '</div>';
      return html;
    }

    ensurePxQuotes(rows.map(function (it) { return it.symbol; }));
    /* 实时节拍只管「非持仓的自选 A股」：持仓标的有全局 refreshAll（60s）在跑，
       这里再刷就会同一只票双请求。空列表时清掉，避免节拍打到已删除的标的。 */
    liveSyms = rows.filter(function (it) {
      return !it.holding && XJ.market.assetType(it.symbol) === 'stock';
    }).map(function (it) { return it.symbol; });
    html += '<div class="wl-list">' + rows.map(function (it) { return rowHtml(st, it); }).join('') + '</div>';
    return html;
  }

  return { render: render, bind: bind, fillYield: fillYield };
})();
