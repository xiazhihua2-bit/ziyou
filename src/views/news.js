/* ==================== 视图：新闻（六 Tab 三期 · 10-08 重做版） ====================
 * 数据流：进页 render() → ensureNews()（TTL 内不重复拉）→ 按 searchTerms 主体词
 *         逐个检索东财（串行防限流）→ calc.newsFilter 标题二次命中（精度闸）→
 *         命中写 state.newsCache（本机缓存，不进同步）→ setUI 渐进重渲染。
 *         东财整轮颗粒无收 → 新浪 7x24 兜底 1~3 页。
 * 结构：规则横幅 + 「仅查看自选」开关（ui.wlNewsOnly，默认关）+ 时间轴列表
 *       （左列日期同日仅首条显示 + 绿点 + 竖线，北京时间）+ 空态 + 红线页脚。
 * 与旧版（同花顺 tapp 全量翻页回看）的差异：请求量 3000+ 条 → ~400 条；
 *   每条自带来源媒体与原文链接；冷词会翻出数月前旧闻，靠 15 天时间下限挡。
 */
XJ.views.news = (function () {
  var U = XJ.util, UI = XJ.ui;

  var PER_SIZE = 8;              // 每主体词取东财最新 N 条（fetcher.NEWS_SEARCH_PER_SIZE 同源）
  var SINA_MAX_PAGES = 3;        // 新浪兜底翻页上限（总库存仅约 900 条）
  var INCR_TTL = 10 * 60 * 1000; // 增量拉取间隔：进页 10 分钟内不重复请求
  var CAP = 200;                 // 缓存命中上限（防极端行情日撑爆 localStorage）
  var LOOKBACK_DAYS = 15;        // 时间下限：冷词检索会翻出数月前旧闻，15 天外一律丢弃
  var CACHE_V = 3;               // 缓存口径版本：词表/窗口/主源变更后 +1，旧缓存整轮重扫

  var pulling = false;           // 本轮检索（含兜底）进行中
  var live = null;               // 本轮累积命中（已合并排序）；收尾后归 null
  var prog = { done: 0, total: 0, via: '' };

  function cutoffSec() { return Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400; }
  function notify() { XJ.store.setUI({ newsTick: Date.now() }); }

  function newCache() { return { v: CACHE_V, sweepMs: 0, newestAt: 0, covered: false, via: '', hits: [] }; }

  function cacheHits() {
    var c = XJ.store.state.newsCache;
    return c && Array.isArray(c.hits) ? c.hits : [];
  }

  /** 进页自动补数：没跑过 / 缓存口径过期 / 过 TTL → 重跑一轮检索。
   *  东财 sort=time 返回的天然是最新条目，增量靠 newsMerge 按 id 去重。 */
  function ensureNews() {
    if (pulling) return;
    var c = XJ.store.state.newsCache;
    if (!c || !c.covered || c.v !== CACHE_V || Date.now() - (c.sweepMs || 0) >= INCR_TTL) runPull();
  }

  /**
   * 检索轮：searchTerms 逐词查东财，每词命中即渐进渲染；收尾才 commitNow 落盘
   * （中途关页丢弃本轮，下次进页重来——与「宁缺勿滥」同口径）。
   * 旧命中先铺底：列表不闪断。
   */
  function runPull() {
    pulling = true;
    prog = { done: 0, total: 0, via: '' };
    live = XJ.calc.newsMerge(cacheHits(), [], cutoffSec(), CAP);
    var seen = {};
    live.forEach(function (h) { seen[h.id] = true; });
    var terms = (XJ.calc.NEWS_RULES && XJ.calc.NEWS_RULES.searchTerms) || [];
    prog.total = terms.length;
    var emOk = 0, newest = 0;

    /** 原始条目 → 五道闸过滤 → 并入 live（时间下限挡冷词旧闻） */
    function absorb(items) {
      (items || []).forEach(function (raw) {
        if (!raw || seen[raw.id]) return;
        if ((U.num(raw.ctime) || 0) < cutoffSec()) return;
        var m = XJ.calc.newsFilter(raw);
        if (!m) return;
        seen[raw.id] = true;
        live.push({
          id: raw.id, title: raw.title, digest: raw.digest, url: raw.url,
          source: raw.source, tags: (raw.tags || []).slice(0, 3),
          ents: m.hits.slice(0, 3), ctime: raw.ctime,
        });
        if (raw.ctime > newest) newest = raw.ctime;
      });
      live.sort(function (a, b) { return b.ctime - a.ctime; });
      if (live.length > CAP) live = live.slice(0, CAP);
    }

    function publish(final, via) {
      if (final) {
        var c = XJ.store.state.newsCache || newCache();
        c.v = CACHE_V;
        c.sweepMs = Date.now();
        c.newestAt = Math.max(c.newestAt || 0, newest);
        c.covered = true;
        c.via = via || c.via || '';
        c.hits = live || [];
        XJ.store.state.newsCache = c;
        XJ.store.commitNow(null);
        live = null;
        pulling = false;
      }
      notify();
    }

    XJ.fetcher.fetchNewsSearchMulti(terms, PER_SIZE, function (items) {
      prog.done++;
      if (items && items.length) emOk++;
      absorb(items);
      notify();                                      // 每词先渲染出去（动效层 400ms 节流兜着）
    }).then(function () {
      if (emOk > 0) { publish(true, 'em'); return; }
      /* 东财整轮颗粒无收（接口挂/全词失败）→ 新浪 7x24 兜底，1 页有数据才续 2~3 页 */
      prog.via = 'sina';
      var sinaPage = 0;
      function sinaStep() {
        sinaPage++;
        return XJ.fetcher.fetchNewsSinaPage(sinaPage).then(function (items) {
          absorb(items);
          notify();
          if (items && items.length && sinaPage < SINA_MAX_PAGES) {
            return new Promise(function (r) { setTimeout(r, 150); }).then(sinaStep);
          }
        });
      }
      sinaStep().then(function () { publish(true, 'sina'); })
        .catch(function () { publish(true, 'sina'); });
    }).catch(function () { publish(true, 'em'); });
  }

  /** 手动刷新（空态按钮 / 详情页脚）：强制全量重检 */
  function refresh() {
    if (pulling) { UI.toast('正在检索中，请稍候…'); return; }
    runPull();
  }

  /* ---------------- 渲染 ---------------- */

  /** 自选/持仓标的的显示名清单（「仅查看自选」过滤 + 行内相关标注共用） */
  function watchedNames() {
    var st = XJ.store;
    var names = [];
    var add = function (sym) {
      var rec = st.state.symbols[sym];
      var q = st.state.quoteCache[sym];
      var n = (rec && rec.name) || (q && q.name) || '';
      if (n && names.indexOf(n) < 0) names.push(n);
    };
    try {
      XJ.calc.holdings(st.state, XJ.calc.ALL).forEach(function (h) { add(h.symbol); });
    } catch (e) { /* 状态未就绪时跳过持仓 */ }
    var wl = st.state.watchlist && st.state.watchlist.items;
    (wl || []).forEach(function (it) { add(it.symbol); });
    return names;
  }

  /** 时间轴行：左列日期（同日仅首条显示，传 null 则占位空）+ 绿点 + 竖线 */
  function rowHtml(h, day, names) {
    var rel = XJ.calc.newsWlHits(h, names);
    var pills = '';
    (h.ents || []).forEach(function (e) {
      pills += '<span class="pill blue">' + U.esc(e) + '</span>';
    });
    rel.slice(0, 2).forEach(function (n) {
      if ((h.ents || []).indexOf(n) >= 0) return;
      pills += '<span class="pill gold">' + U.esc(n) + '</span>';
    });
    if (h.source) pills += '<span class="tl-src">' + U.esc(h.source) + '</span>';
    return '<div class="news-row" data-act="newsOpen" data-id="' + U.esc(h.id) + '" role="button">' +
      '<div class="tl-side">' +
      '<div class="tl-date">' + (day ? U.esc(day) : '') + '</div>' +
      '<div class="tl-dot"></div><div class="tl-line"></div></div>' +
      '<div class="tl-body">' +
      '<div class="row-t">' + U.esc(h.title) + '</div>' +
      (h.digest && h.digest !== h.title ? '<div class="tl-sum">' + U.esc(h.digest) + '</div>' : '') +
      (pills ? '<div class="tl-meta">' + pills + '</div>' : '') +
      '</div></div>';
  }

  function footHtml() {
    return '<div class="news-foot">仅为公开事实快讯，不构成投资建议 · 来源 东财搜索 / 新浪财经</div>';
  }

  function render() {
    var st = XJ.store;
    var html = '';
    html += '<div class="slogan-bar warm">' + UI.icon('info', 15) +
      '<span>只收已成交可核验的事实：实体命中 + 完成时态，传闻一律不收</span></div>';

    var wlOnly = !!st.ui.wlNewsOnly;
    html += '<div class="card news-ctl">' +
      '<div class="row-main"><div class="row-t">仅查看自选</div>' +
      '<div class="row-s">只显示提到自选或持仓标的的条目</div></div>' +
      '<label class="switch"><input type="checkbox" data-act="newsToggleWl"' + (wlOnly ? ' checked' : '') +
      ' aria-label="仅查看自选"><span></span></label>' +
      '</div>';

    ensureNews();

    var hits = live || cacheHits();
    var names = watchedNames();
    var rows = wlOnly
      ? hits.filter(function (h) { return XJ.calc.newsWlHits(h, names).length; })
      : hits;

    if (pulling) {
      html += '<div class="news-prog">' + UI.icon('refresh', 13) +
        '<span>正在按 ' + prog.total + ' 个监控主体检索近 ' + LOOKBACK_DAYS + ' 天动态… ' +
        prog.done + '/' + prog.total + (prog.via === 'sina' ? '（新浪兜底）' : '') +
        '</span></div>';
    }

    if (!rows.length) {
      if (pulling) {
        html += '<div class="card" style="text-align:center;padding:30px 18px">' +
          '<div class="tiny">正在按硬规则筛选检索结果，命中的动态会陆续出现在这里…</div></div>';
      } else {
        html += UI.emptyState('📰', '近 ' + LOOKBACK_DAYS + ' 天无相关动态',
          '硬规则只收已成交的可核验事实，宁缺勿滥。',
          '<button class="btn-block" data-act="newsRefresh" style="max-width:220px;margin:14px auto 0">手动刷新</button>');
      }
      html += footHtml();
      return html;
    }

    var lastDay = '';
    var list = '';
    rows.forEach(function (h) {
      var full = XJ.calc.newsTimeText(h.ctime);        // 'YYYY-MM-DD HH:MM'
      var day = full.slice(0, 10);
      var showDay = day !== lastDay ? day.slice(5) : '';   // 左列 'MM-DD'，同日仅首条
      lastDay = day;
      list += rowHtml(h, showDay, names);
    });
    html += '<div class="card flush news-tl">' + list + '</div>';
    html += footHtml();
    return html;
  }

  /** 点行 → 详情 sheet（全文 + 来源 + 时间 + 标签 + 原文链接） */
  function openDetail(id) {
    var h = null;
    (live || cacheHits()).forEach(function (x) { if (x.id === id) h = x; });
    if (!h) { UI.toast('条目已过期，请刷新后再试'); return; }
    var full = XJ.calc.newsTimeText(h.ctime);
    var tags = (h.tags || []).map(function (t) {
      return '<span class="pill gray">' + U.esc(t) + '</span>';
    }).join('') + (h.ents || []).map(function (e) {
      return '<span class="pill blue">' + U.esc(e) + '</span>';
    }).join('');
    UI.openSheet({
      title: '快讯详情',
      html: '<div class="nd-tt">' + U.esc(h.title) + '</div>' +
        '<div class="nd-meta">' + U.esc(full) + ' · ' + U.esc(h.source || '快讯') + '</div>' +
        (tags ? '<div class="nr-meta" style="margin-top:10px">' + tags + '</div>' : '') +
        (h.digest ? '<div class="nd-ds">' + U.esc(h.digest) + '</div>' : '') +
        (h.url
          ? '<a class="btn-block" href="' + U.esc(h.url) + '" target="_blank" rel="noopener noreferrer">阅读原文</a>'
          : '') +
        '<div class="tiny" style="margin-top:10px;text-align:center">仅为公开事实快讯，不构成投资建议</div>',
    });
  }

  return { render: render, refresh: refresh, openDetail: openDetail };
})();
