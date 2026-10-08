/* ==================== 视图：搜索加自选（subPage · 图五） ====================
 * 顶部搜索框（smartbox 联想，fetcher.fetchSymbolSearch）→ 结果行 =
 * 官方 Logo + 名称 + 市场·代码 + 价格 + 涨跌%（涨红跌绿）+ 右侧星标（图五）。
 * 范围：仅 A股 / 港股 / 美股 / ETF（确认过的决策；场外基金与指数排除）。
 * 点星 → 分组选择 sheet（单选 + 新建分组）；已在自选 = 实心星，可换组或移除。
 * 行情走模块级 memo（TTL 60s）；列表在输入态下【局部更新】，不整页重绘（保焦点）。
 */
XJ.views.search = (function () {
  var U = XJ.util, UI = XJ.ui, C = XJ.views.common;

  var PX_TTL = 60000;
  var pxMemo = { at: 0, quotes: {} };
  var pxPending = false;
  var memo = { kw: '', hits: [], shown: 0 };
  var debounceTimer = null;

  function ensurePx(syms, onDone) {
    var want = syms.filter(function (s) { return !pxMemo.quotes[s]; });
    if (pxPending || !want.length) { if (onDone) onDone(); return; }
    pxPending = true;
    XJ.fetcher.fetchQuotes(want).then(function (qs) {
      pxPending = false;
      var got = 0;
      Object.keys(qs || {}).forEach(function (k) {
        if (qs[k]) { pxMemo.quotes[k] = qs[k]; got++; }
      });
      if (got) pxMemo.at = Date.now();
      if (onDone) onDone();
    }).catch(function () { pxPending = false; if (onDone) onDone(); });
  }

  function quoteOf(sym) {
    return pxMemo.quotes[sym] || XJ.store.state.quoteCache[sym] || null;
  }

  /** 只放行 A股/港股/美股/ETF；指数与场外基金排除 */
  function tradable(sym) {
    var mk = XJ.model.marketOf(sym);
    if (['sh', 'sz', 'bj', 'hk', 'us'].indexOf(mk) < 0) return false;
    try {
      var at = XJ.market.assetType(sym);
      if (at === 'of' || at === 'INDEX' || at === '指数') return false;
    } catch (e) { /* 判定失败放行 */ }
    return true;
  }

  /* ---------------- 行渲染 ---------------- */

  function rowHtml(hit) {
    var sym = hit.symbol;
    var q = quoteOf(sym);
    var chg = q && q.price != null && q.prevClose != null ? q.price - q.prevClose : null;
    var pct = chg !== null && q.prevClose ? chg / q.prevClose * 100 : null;
    var dir = chg === null ? '' : (chg >= 0 ? 'c-up' : 'c-down');
    var inWl = XJ.store.wlHas(sym);
    var mktLabel = { sh: 'SH', sz: 'SZ', bj: 'BJ', hk: 'HK', us: 'US' }[XJ.model.marketOf(sym)] || '';
    return '<div class="card wl-row srch-row">' +
      '<div class="wl-av">' + UI.avatar(hit.name, sym, 40, C.logoFor(sym)) + '</div>' +
      '<div class="wl-nm"><span>' + U.esc(hit.name) + '</span><b>' + U.esc(hit.code) + ' · ' + mktLabel + '</b></div>' +
      '<div class="wl-px">' +
      '<b class="wl-price wl-' + (chg === null ? 'flat' : chg >= 0 ? 'up' : 'down') + '">' +
      (q && q.price != null ? U.money(q.price, q.price < 10 ? 3 : 2) : '—') + '</b>' +
      '<div class="wl-chg ' + dir + '">' + (pct === null ? '' : U.signPct(pct)) + '</div>' +
      '</div>' +
      '<button class="wl-star' + (inWl ? ' on' : '') + '" data-act="wlStar" data-sym="' + U.esc(sym) +
      '" data-name="' + U.esc(hit.name) + '" aria-label="' + (inWl ? '管理自选' : '加入自选') + '">' +
      UI.icon(inWl ? 'starF' : 'star', 19) + '</button>' +
      '</div>';
  }

  function listHtml() {
    if (!memo.kw) {
      return '<div class="card" style="text-align:center;padding:30px 18px">' +
        '<div class="tiny" style="font-size:12.5px;line-height:1.7">输入代码、名称或拼音首字母搜索<br>点右侧 <b class="c-up">☆→★</b> 加入自选分组</div></div>';
    }
    if (!memo.hits.length) {
      return '<div class="card" style="text-align:center;padding:30px 18px">' +
        '<div class="tiny" style="font-size:12.5px">没有匹配的 A股 / 港股 / 美股 / ETF</div></div>';
    }
    var shown = memo.hits.slice(0, 20);
    ensurePx(shown.map(function (h) { return h.symbol; }), function () {
      /* 行情到达后局部重绘（若 input 仍在聚焦，列表区刷新不影响输入） */
      refreshList();
    });
    return shown.map(rowHtml).join('');
  }

  /** 局部刷新列表（不整页重绘，保住输入框焦点） */
  function refreshList() {
    var el = document.getElementById('wl-srch-list');
    if (el) el.innerHTML = listHtml();
  }

  /* ---------------- 输入与联想 ---------------- */

  function onInput(e) {
    var kw = String(e.target.value || '').trim();
    memo.kw = kw;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (!kw) { memo.hits = []; refreshList(); return; }
    debounceTimer = setTimeout(function () {
      XJ.fetcher.fetchSymbolSearch(kw).then(function (hits) {
        if (memo.kw !== kw) return;                       // 已有更新的输入，丢弃旧结果
        memo.hits = (hits || []).filter(function (h) { return tradable(h.symbol); });
        refreshList();
      });
    }, 260);
  }

  function render() {
    return '<div class="card srch-card">' +
      '<div class="srch-box">' + UI.icon('search', 16) +
      '<input id="wl-srch" type="search" placeholder="代码 / 名称 / 拼音" value="' + U.esc(memo.kw) + '" autocomplete="off">' +
      (memo.kw ? '<button class="srch-clear" data-act="srchClear" aria-label="清空">' + UI.icon('close', 13) + '</button>' : '') +
      '</div>' +
      '<div class="tiny" style="margin-top:8px">仅支持 A股 · 港股 · 美股 · ETF（场外基金暂不支持自选）</div>' +
      '</div>' +
      '<div id="wl-srch-list">' + listHtml() + '</div>';
  }

  function bind() {
    var inp = document.getElementById('wl-srch');
    if (inp) {
      inp.addEventListener('input', onInput);
      try { inp.focus({ preventScroll: true }); } catch (e) { inp.focus(); }
    }
  }

  /** 清空搜索（右上 × / 重新进入） */
  function clear() {
    memo.kw = '';
    memo.hits = [];
    var inp = document.getElementById('wl-srch');
    if (inp) inp.value = '';
    refreshList();
  }

  return { render: render, bind: bind, refreshList: refreshList, clear: clear };
})();
