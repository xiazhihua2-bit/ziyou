/* ==================== 视图：搜索加自选（subPage · 图五） ====================
 * 顶部搜索框（smartbox 联想，fetcher.fetchSymbolSearch）→ 结果行 =
 * 官方 Logo + 名称 + 市场·代码 + 价格 + 涨跌%（涨红跌绿）+ 右侧星标（图五）。
 * 范围：A股 / 港股 / 美股(指数成分) / 日股(日经225成分) / ETF（确认过的决策；场外基金与指数排除）。
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
    /* 无新行情可取（或另一批在途）就不回调：在途批次完成时会自己刷新，无待取时列表已带缓存行情。
       同步调 onDone 会 listHtml→ensurePx→onDone→listHtml 无限递归（stack overflow） */
    if (pxPending || !want.length) return;
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

  /** 只放行 A股/港股/美股/ETF/日股；指数与场外基金排除；
   *  美股/日股另受指数成分白名单约束（标普500/纳指100/道指30/日经225） */
  function tradable(sym) {
    var mk = XJ.model.marketOf(sym);
    if (['sh', 'sz', 'bj', 'hk', 'us', 'jp'].indexOf(mk) < 0) return false;
    if (mk === 'us' && !XJ.universe.hasUs(sym)) return false;
    if (mk === 'jp' && !XJ.universe.hasJp(sym)) return false;
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
    var mktLabel = { sh: 'SH', sz: 'SZ', bj: 'BJ', hk: 'HK', us: 'US', jp: 'JP' }[XJ.model.marketOf(sym)] || '';
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
        '<div class="tiny" style="font-size:12.5px">没有匹配的 A股 / 港股 / 美股成分 / 日经225成分 / ETF</div></div>';
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
        /* 腾讯联想不覆盖日股：白名单本地匹配补齐（日股唯一入口、美股兜底） */
        XJ.universe.searchLocal(kw).forEach(function (h) {
          if (tradable(h.symbol) && !memo.hits.some(function (x) { return x.symbol === h.symbol; })) memo.hits.push(h);
        });
        refreshList();
        /* 搜索行头像：自选/非持仓标的此前不解析 logo → 命中后异步补官方图标，
           回填走局部刷新（不整页重绘，保输入焦点） */
        if (XJ.app && XJ.app.ensureLogosFor) {
          XJ.app.ensureLogosFor(memo.hits.slice(0, 12).map(function (h) { return h.symbol; }), function () {
            if (memo.kw === kw) refreshList();
          });
        }
      });
    }, 260);
  }

  function render() {
    return '<div class="card srch-card">' +
      '<div class="srch-box">' + UI.icon('search', 16) +
      '<input id="wl-srch" type="search" placeholder="代码 / 名称 / 拼音" value="' + U.esc(memo.kw) + '" autocomplete="off">' +
      (memo.kw ? '<button class="srch-clear" data-act="srchClear" aria-label="清空">' + UI.icon('close', 13) + '</button>' : '') +
      '</div>' +
      '<div class="tiny" style="margin-top:8px">支持 A股 · 港股 · ETF · 美股（限标普/纳指100/道指成分）· 日股（限日经225成分）；场外基金暂不支持自选</div>' +
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
