/* ==================== 视图：新闻（六 Tab 三期） ====================
 * 数据流：进页 render() → ensureNews()（TTL 内不重复拉）→ 回看循环逐页拉快讯 →
 *         calc.newsFilter 硬规则过滤 → 命中写 state.newsCache（本机缓存，不进同步）
 *         → setUI 触发重渲染。原始快讯流不落盘，只落「硬规则命中」的条目。
 * 结构：规则横幅 + 「仅查看自选」开关（ui.wlNewsOnly，默认关）+ 日期分组时间轴
 *       （时间精确到 YYYY-MM-DD HH:MM，北京时间）+ 空态 + 红线页脚。
 * 主源同花顺 tapp；新浪 7x24 只作主源失效时的兜底（库存浅，回看上限 3 页）。
 */
XJ.views.news = (function () {
  var U = XJ.util, UI = XJ.ui;

  var MAX_PAGES = 30;            // 回看翻页上限：15 天 ≈ 25~30 页（100 条/页）
  var SINA_MAX_PAGES = 3;        // 新浪兜底的翻页上限（总库存仅约 900 条）
  var INCR_TTL = 10 * 60 * 1000; // 增量拉取间隔：进页 10 分钟内不重复请求
  var CAP = 200;                 // 缓存命中上限（防极端行情日撑爆 localStorage）
  var LOOKBACK_DAYS = 15;        // 回看窗口（10-08 用户追加：7 → 15 天）
  var CACHE_V = 2;               // 缓存口径版本：词表/窗口变更后 +1，旧缓存整轮重扫

  var pulling = false;           // 本轮回看（含增量）进行中
  var live = null;               // 回看期间的累积命中（已合并排序）；收尾后归 null
  var prog = { page: 0, via: '' };

  function cutoffSec() { return Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400; }
  function notify() { XJ.store.setUI({ newsTick: Date.now() }); }

  function newCache() { return { v: CACHE_V, sweepMs: 0, newestAt: 0, covered: false, via: '', hits: [] }; }

  function cacheHits() {
    var c = XJ.store.state.newsCache;
    return c && Array.isArray(c.hits) ? c.hits : [];
  }

  /** 进页自动补数：没覆盖过窗口 / 缓存口径过期 → 全量回看；覆盖过但过了 TTL → 只拉增量 */
  function ensureNews() {
    if (pulling) return;
    var c = XJ.store.state.newsCache;
    if (!c || !c.covered || c.v !== CACHE_V) { runPull('sweep'); return; }
    if (Date.now() - (c.sweepMs || 0) >= INCR_TTL) runPull('incr');
  }

  /**
   * 回看循环。kind='sweep'：从第 1 页拉到「最旧一条 ≤ 7 天前」或翻页上限；
   * kind='incr'：只追到上一轮的最新一条（通常 1 页就够）。
   * 命中随拉随渲染（渐进呈现）；每轮先锁定源（tapp / sina），避免把
   * 「tapp 第 15 页翻到底」误判成主源失效。
   */
  function runPull(kind) {
    pulling = true;
    prog = { page: 0, via: '' };
    /* 旧命中先铺底：增量/回看期间列表不闪断 */
    live = XJ.calc.newsMerge(cacheHits(), [], 0, CAP);
    var seen = {};
    live.forEach(function (h) { seen[h.id] = true; });
    var prev = XJ.store.state.newsCache || newCache();
    var stopAt = kind === 'incr' ? (prev.newestAt || 0) : cutoffSec();
    var page = 0, via = null, reached = false, newest = 0;

    function publish(final) {
      if (final) {
        var c = XJ.store.state.newsCache || newCache();
        c.v = CACHE_V;
        c.sweepMs = Date.now();
        c.newestAt = Math.max(c.newestAt || 0, newest);
        c.covered = true;
        c.via = via || c.via || '';
        c.hits = live || [];
        XJ.store.state.newsCache = c;
        /* 收尾才落盘：中途关页丢弃本轮，下次进页重来（与「宁缺勿滥」同口径） */
        XJ.store.commitNow(null);
        live = null;
        pulling = false;
      }
      notify();
    }

    function step() {
      page++;
      prog.page = page;
      var job = via === null
        ? XJ.fetcher.fetchNewsFirst()
        : XJ.fetcher.fetchNewsPage(via, page).then(function (items) {
          return { items: items, via: via };
        });
      return job.then(function (res) {
        via = res.via || via || 'none';
        prog.via = via;
        var items = res.items || [];
        if (!items.length) { reached = true; return; }   // 翻到底 / 两源都不可用
        var itemsNewest = 0, oldest = 0;
        items.forEach(function (raw) {
          if (raw.ctime > itemsNewest) itemsNewest = raw.ctime;
          if (!oldest || raw.ctime < oldest) oldest = raw.ctime;
          if (seen[raw.id]) return;
          var m = XJ.calc.newsFilter(raw);
          if (!m) return;
          seen[raw.id] = true;
          live.push({
            id: raw.id, title: raw.title, digest: raw.digest, url: raw.url,
            source: raw.source, tags: (raw.tags || []).slice(0, 3),
            ents: m.hits.slice(0, 3), ctime: raw.ctime,
          });
        });
        if (itemsNewest > newest) newest = itemsNewest;
        live.sort(function (a, b) { return b.ctime - a.ctime; });
        if (live.length > CAP) live = live.slice(0, CAP);
        if (oldest <= stopAt) reached = true;            // 已覆盖到目标时间点
        if (page >= MAX_PAGES) reached = true;           // 尽力而为，不给无限循环机会
        if (via === 'sina' && page >= SINA_MAX_PAGES) reached = true;
      }).then(function () {
        publish(false);                                  // 每页都先渲染出去
        if (reached) { publish(true); return; }
        return new Promise(function (r) { setTimeout(r, 150); }).then(step);
      }).catch(function () { publish(true); });
    }
    step();
  }

  /** 手动刷新（空态按钮 / 详情页脚）：强制全量回看 */
  function refresh() {
    if (pulling) { UI.toast('正在回看中，请稍候…'); return; }
    runPull('sweep');
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

  /** 北京时间的今天 / 昨天（'YYYY-MM-DD'），日期头用来标「今天/昨天」 */
  function beijingDayKey(shiftDays) {
    return XJ.calc.newsTimeText(Math.floor(Date.now() / 1000) - shiftDays * 86400).slice(0, 10);
  }

  function dayHead(day) {
    var label = day === beijingDayKey(0) ? '今天'
      : day === beijingDayKey(1) ? '昨天' : '';
    var wd = '';
    var d = new Date(day + 'T00:00:00+08:00');
    if (!isNaN(d.getTime())) {
      wd = '周' + '日一二三四五六'.charAt(d.getUTCDay());
    }
    var md = (+day.slice(5, 7)) + '月' + (+day.slice(8, 10)) + '日';
    return '<div class="news-day">' + U.esc((label ? label + ' · ' : '') + md + (wd ? ' ' + wd : '')) + '</div>';
  }

  function rowHtml(h, hm, names) {
    var rel = XJ.calc.newsWlHits(h, names);
    var pills = '';
    (h.ents || []).forEach(function (e) {
      pills += '<span class="pill blue">' + U.esc(e) + '</span>';
    });
    rel.slice(0, 2).forEach(function (n) {
      if ((h.ents || []).indexOf(n) >= 0) return;
      pills += '<span class="pill gold">' + U.esc(n) + '</span>';
    });
    return '<div class="card news-row" data-act="newsOpen" data-id="' + U.esc(h.id) + '" role="button">' +
      '<div class="nr-time">' + hm + '</div>' +
      '<div class="nr-main">' +
      '<div class="nr-tt">' + U.esc(h.title) + '</div>' +
      (h.digest ? '<div class="nr-ds">' + U.esc(h.digest) + '</div>' : '') +
      '<div class="nr-meta"><span class="pill gray">' + U.esc(h.source || '快讯') + '</span>' + pills + '</div>' +
      '</div>' +
      UI.icon('chevron', 14) +
      '</div>';
  }

  function footHtml() {
    return '<div class="news-foot">仅为公开事实快讯，不构成投资建议 · 来源 同花顺 / 新浪财经</div>';
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
        '<span>正在回看近 ' + LOOKBACK_DAYS + ' 天快讯… 第 ' + prog.page + ' 页' +
        (prog.via === 'sina' ? '（新浪兜底）' : '') + '</span></div>';
    }

    if (!rows.length) {
      if (pulling) {
        html += '<div class="card" style="text-align:center;padding:30px 18px">' +
          '<div class="tiny">正在按硬规则筛选快讯，命中的动态会陆续出现在这里…</div></div>';
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
      if (day !== lastDay) { list += dayHead(day); lastDay = day; }
      list += rowHtml(h, full.slice(11), names);
    });
    html += '<div class="news-list">' + list + '</div>';
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
