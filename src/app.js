/* ==================== 入口：启动 / 路由 / 全部交互动作 ==================== */
(function () {
  var U = XJ.util, UI = XJ.ui, M = XJ.model, S = XJ.store, C = XJ.calc;

  var TABS = [
    { id: 'overview', label: '持仓', icon: 'overview' },
    { id: 'calendar', label: '分红日历', icon: 'calendar' },
    { id: 'find', label: 'FIRE', icon: 'flame' },
    { id: 'mine', label: '我的', icon: 'mine' },
  ];

  /* 「发现」Tab 当前复用规划视图（息覆生活 / 展望未来 / 股息统计）。
     自选盯盘为后续待办；股票筛选器已按需求移除，不再列入任何一期范围。 */
  XJ.views.find = XJ.views.plan;

  /* ---------------- 骨架 ---------------- */
  function mountShell() {
    var root = document.getElementById('app');
    root.innerHTML =
      '<div class="app-shell">' +
      '<header class="topbar" id="view-top"></header>' +
      '<main class="view-body" id="view-body"></main>' +
      '<nav class="tabbar"><div class="tabbar-inner" id="view-tabs"></div></nav>' +
      '</div>' +
      '<div id="float-root"></div>';
  }

  /* ---------------- 悬浮双入口（截图识别 / 手动添加） ---------------- */
  function renderFloat() {
    var root = document.getElementById('float-root');
    if (!root) return;
    if (S.ui.tab !== 'overview' || S.ui.subPage) { root.innerHTML = ''; return; }
    var open = !!S.ui.floatOpen;
    root.innerHTML =
      (open ? '<div class="float-mask" data-act="closeFloat"></div>' : '') +
      '<div class="float-wrap">' +
      (open
        ? '<div class="float-menu">' +
        '<button class="float-item" data-act="floatOcr"><span class="ic">📷</span>截图识别</button>' +
        '<button class="float-item" data-act="floatManual"><span class="ic">✏️</span>手动添加</button>' +
        '</div>'
        : '') +
      '<button class="float-btn' + (open ? ' open' : '') + '" data-act="toggleFloat" aria-label="添加持仓">' +
      UI.icon('plus', 25, 2) + '</button>' +
      '</div>';
  }

  var notifyTimer = null;
  function throttledNotify(delay) {
    if (notifyTimer) return;
    notifyTimer = setTimeout(function () { notifyTimer = null; render(); }, delay === undefined ? 300 : delay);
  }

  function topHtml() {
    /* 子页面：返回 + 居中标题 */
    if (S.ui.subPage) {
      var subTitle = {
        analysis: '账户分析',
        divsummary: '分红汇总',
        symbol: S.ui.subArg ? S.symbolName(S.ui.subArg) : '个股详情',
      }[S.ui.subPage] || '';
      return '<div class="topbar-row">' +
        '<button class="icon-btn" data-act="closeSubPage" aria-label="返回">' + UI.icon('back', 18) + '</button>' +
        '<div style="flex:1;text-align:center;min-width:0"><h1 style="font-size:17px">' + U.esc(subTitle) + '</h1></div>' +
        '<div style="width:34px;flex:0 0 auto"></div>' +
        '</div>';
    }

    var meta = {
      overview: ['自由', '股息收入追踪'],
      calendar: ['分红日历', '股权登记 · 除权除息 · 派息日'],
      find: ['FIRE', '被动收入 · 财务自由试算'],
      mine: ['我的', '账户 · 数据 · 设置'],
    }[S.ui.tab] || ['自由', ''];

    var sub = meta[1];
    if (S.ui.tab === 'overview' && S.hasAnyData()) {
      var s = C.summary(S.state, S.acc());
      sub = '总市值 ' + U.moneySign(s.totalMarketValue, 0) + ' · ' + S.accountName(S.acc());
    }

    return '<div class="topbar-row">' +
      '<div style="min-width:0">' +
      '<h1>' + U.esc(meta[0]) + '</h1>' +
      '<div class="sub">' + U.esc(sub) + '</div>' +
      '</div>' +
      '<div class="spacer"></div>' +
      '<button class="icon-btn' + (S.ui.busy ? ' spinning' : '') + '" data-act="refresh" title="同步数据" aria-label="同步数据">' +
      UI.icon('refresh', 18) + '</button>' +
      (S.ui.tab === 'overview' ? '' :
        '<button class="icon-btn" data-act="openAddHolding" title="添加持仓" aria-label="添加持仓">' +
        UI.icon('plus', 19) + '</button>') +
      '</div>';
  }

  function tabsHtml() {
    if (S.ui.subPage) return '';
    return TABS.map(function (t) {
      return '<button class="tab' + (S.ui.tab === t.id ? ' active' : '') + '" data-act="gotoTab" data-tab="' + t.id + '">' +
        UI.icon(t.icon, 24, S.ui.tab === t.id ? 1.9 : 1.6) +
        '<span>' + t.label + '</span></button>';
    }).join('');
  }

  function viewHtml() {
    if (S.ui.subPage && XJ.views[S.ui.subPage]) {
      try { return XJ.views[S.ui.subPage].render(); }
      catch (e) {
        console.error('[sub]', S.ui.subPage, e);
        return '<div class="card"><div class="tiny c-up">页面渲染出错：' + U.esc(e.message) + '</div></div>';
      }
    }
    var v = XJ.views[S.ui.tab] || XJ.views.overview;
    try {
      return v.render();
    } catch (e) {
      console.error('[view]', S.ui.tab, e);
      return '<div class="card"><div class="tiny c-up">页面渲染出错：' + U.esc(e.message) + '</div></div>';
    }
  }

  function render() {
    var top = document.getElementById('view-top');
    var body = document.getElementById('view-body');
    var tabs = document.getElementById('view-tabs');
    if (!top || !body || !tabs) { mountShell(); return render(); }
    top.innerHTML = topHtml();
    body.innerHTML = viewHtml();
    tabs.innerHTML = tabsHtml();
    var nav = document.querySelector('.tabbar');
    if (nav) nav.style.display = S.ui.subPage ? 'none' : '';
    var shell = document.querySelector('.app-shell');
    if (shell) shell.style.paddingBottom = S.ui.subPage ? '24px' : '';
    renderFloat();
    if (XJ.chart) XJ.chart.bind();
  }

  /* ---------------- 行情与分红数据刷新（与跨设备同步无关） ---------------- */
  var syncing = false;

  function refreshAll(opts) {
    opts = opts || {};
    if (syncing) return Promise.resolve();
    var syms = S.activeSymbols();
    if (!syms.length) {
      if (!opts.silent) UI.toast('还没有持仓，先添加一只吧');
      return Promise.resolve();
    }
    syncing = true;
    S.ui.busy = true;
    S.ui.status = '正在同步行情…';
    S.ui.offline = false;
    render();

    return Promise.all([
      XJ.fetcher.fetchQuotes(syms),
      XJ.fetcher.fetchFX().catch(function () { return {}; }),
    ]).then(function (res) {
      var quotes = res[0] || {}, fx = res[1] || {};
      if (Object.keys(fx).length) {
        S.state.settings.fx = Object.assign({}, fx, { updatedAt: U.nowStamp() });
      }

      var n = S.mergeQuotes(quotes);
      if (!n) S.ui.offline = true;
      else S.state.settings.lastPlanAt = null;

      /* 当日分时：任何时段都请求（收盘后接口照样返回当天完整数据，落盘保存）。
         放在行情合并之后，因为美股分时需要行情里带交易所后缀的代码。
         失败/无数据不阻塞主流程。 */
      refreshMinutes(syms);

      S.ui.status = '正在同步分红方案…';
      throttledNotify(0);

      return XJ.fetcher.fetchDividends(syms, function (kind, i, t, sym, label) {
        S.ui.status = '正在同步' + (label || '分红方案') + ' ' + i + '/' + t + '…';
        throttledNotify(400);
      });
    }).then(function (res) {
      var planMap = (res && res.plans) || {};
      var planCount = 0;
      Object.keys(planMap).forEach(function (sym) {
        planMap[sym].forEach(function (p) {
          S.state.plans[p.planId] = p;
          planCount++;
        });
      });
      var unsupported = (res && res.unsupported) || [];
      S.state.settings.unsupportedDividend = unsupported;

      /* 补公司官网域名 → 用于展示股票官方图标（拿不到的自动弹回字母头像） */
      var needDomain = syms.filter(function (s) {
        return !(S.state.symbols[s] && S.state.symbols[s].domain);
      });
      return XJ.fetcher.fetchCompanyDomains(needDomain).then(function (domains) {
        Object.keys(domains).forEach(function (s) {
          if (S.state.symbols[s]) S.state.symbols[s].domain = domains[s];
        });
        return healSymbolNames();
      }).then(function (healed) {
        var recAdded = C.applyAutoReceived(S.state);
        S.state.settings.lastPlanAt = U.nowStamp();
        /* 每日资产快照（人民币口径，同一天覆盖同一条） */
        C.writeSnapshot(S.state, S.ui.accountId, S.state.settings.fx);
        S.ui.busy = false;
        S.ui.status = '';
        syncing = false;
        S.commitNow(null);
        if (!opts.silent) {
          var msg = '已同步 ' + syms.length + ' 只标的' + (recAdded ? '，新增 ' + recAdded + ' 笔到账' : '');
          if (healed) msg += '，补全 ' + healed + ' 个名称';
          if (unsupported.length) msg += '；' + unsupported.length + ' 只美股暂无分红数据源，可手工补录';
          UI.toast(msg);
        }
        /* 收尾工作放后台：官方图标解析、历史行情、对比指数（都可能慢，不该卡住主流程） */
        resolveLogosNow(false);
        ensureHistory(false);
        ensureKline(false);
        ensureYieldHistory(false);
        ensureIndexData(false);
        refreshIndexMinutes();
        /* 余额宝基准只在用户打开了那条曲线时才拉 */
        if (S.state.settings && S.state.settings.showYieldBench) ensureBench(false);
      });
    }).catch(function (e) {
      console.error('[sync]', e);
      S.ui.busy = false;
      S.ui.status = '同步失败，可稍后重试';
      S.ui.offline = true;
      syncing = false;
      S.commitNow(null);
    });
  }

  /**
   * 刷新当日分时。
   *
   * 口径：分时数据**落盘**存进 state.minuteCache，收盘后依然保留，
   * 这样用户晚上 / 周末打开「资产走势 → 当日」还能看到最近一个交易日的走势。
   *
   * 三个刻意的取舍：
   *  1) 不按交易时段过滤。腾讯的分时接口收盘后照样返回当天完整数据
   *     （实测 18:44 取招行/五粮液/红利ETF 各 267 个点，末点 15:30），
   *     收盘后点「刷新行情」就该真去拉一次；曾经这里带 sessionOpen 过滤，
   *     收盘后直接清空缓存 →「当日」曲线永远空、点刷新还是空，死循环。
   *  2) 失败 / 空结果一律保留旧缓存，不写空值 —— 免得一次网络抖动把曲线抹掉。
   *  3) 每个点只留 { t, p }，砍掉用不到的成交量 v（体积约减半）。
   *
   * at 语义：缓存批次的**交易日**，取自接口返回的 date，不是本机今日。
   * 同一交易日按 symbol 合并（个别标的失败不清掉成功的），跨天则整体替换。
   */
  function refreshMinutes(syms) {
    var all = (syms || []).filter(function (s) {
      return XJ.market.hasMinute(s);
    });
    if (!all.length) return;
    XJ.fetcher.fetchMinutes(all).then(function (m) {
      if (!m || !Object.keys(m).length) return;

      /* 归一化：只留 { t, p }，并丢掉点数为 0 的标的 */
      var clean = {};
      Object.keys(m).forEach(function (sym) {
        var one = m[sym];
        if (!one || !one.date || !one.points) return;
        var pts = [];
        for (var i = 0; i < one.points.length; i++) {
          var p = one.points[i];
          if (!p || !p.t) continue;
          pts.push({ t: p.t, p: p.p });
        }
        if (pts.length < 2) return;
        clean[sym] = { date: one.date, points: pts };
      });
      if (!Object.keys(clean).length) return;

      /* 这批数据属于哪个交易日：各标的的 date 理论一致，取第一个即可 */
      var at = clean[Object.keys(clean)[0]].date;
      var prev = S.state.minuteCache;
      var by = {};

      if (prev && prev.at === at && prev.bySymbol) {
        /* 同一天：先铺旧的，再用新的覆盖 —— 个别标的这次没取到就沿用上次的 */
        Object.keys(prev.bySymbol).forEach(function (sym) { by[sym] = prev.bySymbol[sym]; });
        Object.keys(clean).forEach(function (sym) { by[sym] = clean[sym]; });
      } else {
        /* 新的一天：整体替换，每只标的只留这一批 */
        by = clean;
      }

      S.state.minuteCache = { at: at, bySymbol: by };
      S.commit(null);
    }).catch(function () { /* 分时失败不影响其它 */ });
  }

  /**
   * 公司图标解析（背景执行，多源）。
   * 目标：每只持仓都要有图标。能解析到官方标识就存 URL；解析不到就标 'bad'，
   * 界面回退到「中文简称」文字头像（两个字，像一枚品牌标识）。
   *
   * 之所以不直接用域名拼 URL：icon.horse 对查不到的域名会回灰底拉丁字母占位图（HTTP 200），
   * 会把我们自己的文字头像盖成无意义的字母。所以每个候选都要 canvas 验真，
   * 都不过再走同花顺 F10（A股个股内嵌真实公司 logo，且该页 CORS 放行）。
   *
   * 已解析到 URL 的永久缓存；解析不到/unknown 的每天最多重试一次。
   */
  var logoResolving = false;
  function resolveLogosNow(force) {
    if (logoResolving || !S.state) return Promise.resolve(0);
    var today = U.today();
    var algo = XJ.fetcher.LOGO_ALGO;
    var need = [];
    XJ.calc.holdings(S.state, S.acc()).forEach(function (h) {
      var rec = S.state.symbols[h.symbol];
      if (!rec) return;
      /* 判定规则升级过（logoAlgo 比当前旧）→ 缓存结论视为过期，立刻重解析，
         否则用户当天看到的旧结论（尤其 'bad'）会一直保留到第二天 */
      if (!force && !XJ.market.logoStale(rec, today, algo)) return;
      need.push({ symbol: h.symbol, domain: rec.domain || null });
    });
    if (!need.length) return Promise.resolve(0);

    logoResolving = true;
    return XJ.fetcher.resolveLogos(need, 2).then(function (hits) {
      var got = 0;
      need.forEach(function (it) {
        var rec = S.state.symbols[it.symbol];
        if (!rec) return;
        var hit = hits[it.symbol];
        rec.logoResolvedOn = today;
        rec.logoAlgo = algo;
        if (hit && hit.url) {
          rec.logoUrl = hit.url;
          rec.logoSource = hit.source;
          rec.logoState = 'ok';
          got++;
        } else if (rec.logoState !== 'ok') {
          rec.logoUrl = null;
          rec.logoState = 'bad';
        }
      });
      logoResolving = false;
      S.commitNow(null);
      return got;
    }).catch(function () { logoResolving = false; return 0; });
  }

  /**
   * 保证对比指数有历史日线（每天刷新一次，缓存落在 state.indexHistory）。
   * 只在「收益率」曲线被打开时才需要，避免无谓请求。
   */
  var indexBusy = false;
  function ensureIndexData(force) {
    if (indexBusy || !S.state) return Promise.resolve(0);
    var keys = S.state.settings.indexCompare || [];
    if (!keys.length) return Promise.resolve(0);
    var today = U.today();
    var need = keys.filter(function (k) {
      if (!XJ.market.indexHasHistory(k)) return false;   // 日经/台湾/韩国暂无数据源
      if (force) return true;
      var rec = S.state.indexHistory[k];
      return !rec || !rec.bars || rec.bars.length < 2 || rec.at !== today;
    });
    if (!need.length) return Promise.resolve(0);

    indexBusy = true;
    S.ui.historyBusy = true;
    S.notify();
    return XJ.fetcher.fetchIndexHistory(need, { today: today, count: 400 })
      .then(function (map) {
        var got = 0;
        Object.keys(map).forEach(function (k) {
          if (!map[k] || !map[k].bars || map[k].bars.length < 2) return;
          S.state.indexHistory[k] = map[k];
          got++;
        });
        indexBusy = false;
        S.ui.historyBusy = false;
        S.commitNow(null);
        return got;
      }).catch(function () {
        indexBusy = false;
        S.ui.historyBusy = false;
        S.notify();
        return 0;
      });
  }

  /**
   * 指数当日分时（「当日」区间用）。
   * 一直留在内存里，不落盘 —— 指数分时只在画「当日」对比线时才用得上，
   * 没必要占用户 localStorage。收盘后同样照拉（与持仓分时口径一致）。
   * 只有腾讯覆盖到的市场有数据，其余指数在界面上置灰。
   */
  function refreshIndexMinutes() {
    var keys = (S.state.settings.indexCompare || []).filter(function (k) {
      return XJ.market.indexHasIntraday(k);
    });
    if (!keys.length) { S.indexMinute = {}; return; }
    XJ.fetcher.fetchIndexMinutes(keys).then(function (m) {
      if (!m || !Object.keys(m).length) return;   // 失败保留旧缓存
      S.indexMinute = m;
      S.notify();
    }).catch(function () { /* 分时失败不影响其它 */ });
  }

  /**
   * 保证「资产走势」有历史价格可用（每只标的每天刷新一次，
   * 缓存落在 state.priceHistory，随 JSON 一起导出，换设备也带得走）。
   */
  var historyBusy = false;
  function ensureHistory(force) {
    if (historyBusy || !S.state) return Promise.resolve(0);
    var syms = S.activeSymbols();
    if (!syms.length) return Promise.resolve(0);
    var today = U.today();
    if (!S.ui.historyTriedAt) S.ui.historyTriedAt = {};
    var need = syms.filter(function (sym) {
      if (!(XJ.market.hasDailyHistory(sym) || XJ.market.assetType(sym) === 'of')) return false;
      var rec = S.state.priceHistory[sym];
      if (force) return true;
      if (!rec || !rec.points || rec.points.length < 2) {
        return S.ui.historyTriedAt[sym] !== today;      // 今天试过且失败 → 先不重试
      }
      /* ★ 老缓存只有 400 根（≈1.6 年），必须主动深取一次打上 deep: 2；
         之后每天只做增量，不再重拉十年。 */
      if (rec.deep !== 2) return true;
      return rec.at !== today;
    });
    if (!need.length) return Promise.resolve(0);

    historyBusy = true;
    S.ui.historyBusy = true;
    S.notify();
    need.forEach(function (sym) { S.ui.historyTriedAt[sym] = today; });

    /* 美股需要带交易所后缀的代码（行情同步时记下来的 quoteCode）才能取到完整日线 */
    var codes = {};
    need.forEach(function (sym) {
      var rec = S.state.symbols[sym];
      if (rec && rec.quoteCode) codes[sym] = rec.quoteCode;
    });

    /* 首次 / 老缓存升级：深取一次（≈10 年，分两窗拼接）；
       之后每天只增量拉最近 800 天再与旧点合并 —— 长历史只付一次代价。 */
    var deep = need.filter(function (sym) {
      var rec = S.state.priceHistory[sym];
      return !rec || rec.deep !== 2;
    });
    var shallow = need.filter(function (sym) { return deep.indexOf(sym) < 0; });

    function finishDeep() {
      if (!deep.length) return Promise.resolve(0);
      return XJ.fetcher.fetchLongCloseSeries(deep, { codes: codes, today: today }).then(function (map) {
        var n = 0;
        Object.keys(map).forEach(function (sym) {
          if (!map[sym] || map[sym].length < 2) return;
          S.state.priceHistory[sym] = { at: today, deep: 2, points: map[sym] };
          n++;
        });
        return n;
      }).catch(function () { return 0; });
    }

    function finishShallow() {
      if (!shallow.length) return Promise.resolve(0);
      return XJ.fetcher.fetchPriceHistory(shallow, { beg: U.addDays(today, -800), end: today, codes: codes })
        .then(function (map) {
          var n = 0;
          Object.keys(map).forEach(function (sym) {
            var fresh = map[sym];
            if (!fresh || fresh.length < 2) return;
            var old = (S.state.priceHistory[sym] && S.state.priceHistory[sym].points) || [];
            /* 合并：只保留「比新数据第一天更早」的旧点，避免重复与覆盖 */
            var cut = fresh[0][0];
            var keep = old.filter(function (p) { return p[0] < cut; });
            S.state.priceHistory[sym] = { at: today, deep: 2, points: keep.concat(fresh) };
            n++;
          });
          return n;
        }).catch(function () { return 0; });
    }

    return finishDeep().then(finishShallow).then(function (a) {
      var got = a;
      historyBusy = false;
      S.ui.historyBusy = false;
      S.commitNow(null);
      return got;
    }).catch(function () {
      historyBusy = false;
      S.ui.historyBusy = false;
      S.notify();
      return 0;
    });
  }

  /**
   * 股息率曲线的收盘价缓存（每只标的每天刷新一次，落在 state.yieldHistory）。
   *
   * 与 ensureHistory 的区别：那套只取 400 根日线（≈1.5 年）给资产走势用；
   * 这套要「最近十年」，而腾讯日线硬上限 2000 根只够 8.2 年，
   * 所以额外取一套周线（640 根 ≈ 12.5 年），由视图层按可见跨度自行切换粒度。
   *
   * 失败的记账方式与 ensureHistory 一致（按标的、按天），避免每轮同步反复重试同一只。
   */
  var yieldBusy = false;
  function ensureYieldHistory(force) {
    if (yieldBusy || !S.state) return Promise.resolve(0);
    var syms = S.activeSymbols().filter(function (s) { return XJ.market.supportsYieldCurve(s); });
    if (!syms.length) return Promise.resolve(0);
    var today = U.today();
    if (!S.ui.yieldTriedAt) S.ui.yieldTriedAt = {};
    if (!S.state.yieldHistory) S.state.yieldHistory = {};
    var need = syms.filter(function (sym) {
      var rec = S.state.yieldHistory[sym];
      if (force) return true;
      /* v=2 起改成「最近十年日线」（分两个窗口取），旧的双粒度缓存一律重取 */
      if (!rec || rec.v !== 2 || !rec.day || rec.day.length < 2) return S.ui.yieldTriedAt[sym] !== today;
      return rec.at !== today;
    });
    if (!need.length) return Promise.resolve(0);

    yieldBusy = true;
    need.forEach(function (sym) { S.ui.yieldTriedAt[sym] = today; });

    var codes = {};
    need.forEach(function (sym) {
      var rec = S.state.symbols[sym];
      if (rec && rec.quoteCode) codes[sym] = rec.quoteCode;
    });

    return XJ.fetcher.fetchYieldHistory(need, { codes: codes }).then(function (map) {
      var got = 0;
      Object.keys(map).forEach(function (sym) {
        var pack = map[sym];
        if (!pack || !pack.day || pack.day.length < 2) return;
        S.state.yieldHistory[sym] = { v: 2, at: today, day: pack.day };
        got++;
      });
      yieldBusy = false;
      S.commitNow(null);
      return got;
    }).catch(function () {
      yieldBusy = false;
      S.notify();
      return 0;
    });
  }

  /**
   * 余额宝七日年化（股息率曲线的对比基准）。
   * 只在用户打开图例里那条曲线时才拉 —— 默认关闭，不必白白多一次请求。
   */
  var benchBusy = false;
  function ensureBench(force) {
    if (benchBusy || !S.state) return Promise.resolve(0);
    if (!force && S.state.benchHistory && S.state.benchHistory.points &&
      S.state.benchHistory.points.length >= 2 && S.state.benchHistory.at === U.today()) {
      return Promise.resolve(0);
    }
    benchBusy = true;
    return XJ.fetcher.fetchBenchSevenDay().then(function (pts) {
      benchBusy = false;
      if (!pts || pts.length < 2) { S.notify(); return 0; }
      S.state.benchHistory = { at: U.today(), points: pts };
      S.commitNow(null);
      return pts.length;
    }).catch(function () {
      benchBusy = false;
      S.notify();
      return 0;
    });
  }

  /**
   * 技术信号的 OHLC K 线缓存（每只标的每天刷新一次，落在 state.klineCache）。
   *
   * 与 ensureHistory 的分工：
   *   - ensureHistory 取的是【收盘价序列】，供资产走势画曲线（不复权、要长期）；
   *   - ensureKline 取的是【完整 OHLC】，供 BOLL / KDJ 计算（只需近 60 根）。
   * 两套缓存互不干扰：K 线拿不到时资产走势照常，反之亦然。
   *
   * 场外基金（of）没有盘中 K 线，直接排除；美股要靠 quoteCode 带交易所后缀。
   */
  var klineBusy = false;
  function ensureKline(force) {
    if (klineBusy || !S.state) return Promise.resolve(0);
    var syms = S.activeSymbols();
    if (!syms.length) return Promise.resolve(0);
    var today = U.today();
    /* 失败也要记账，否则每轮同步都会为同一只票反复重试。
       与 ensureHistory 用 S.ui.historyTriedAt 不同，这里 S.klineTriedAt 是单一日期的
       整体标记：K 线是一次性批量请求，全体共用一次尝试。 */
    if (force) S.klineTriedAt = null;
    if (!S.state.klineCache) S.state.klineCache = {};
    if (S.klineTriedAt === today) return Promise.resolve(0);

    var need = syms.filter(function (sym) {
      if (XJ.market.assetType(sym) === 'of') return false;
      var rec = S.state.klineCache[sym];
      if (force) return true;
      if (!rec || !rec.day || rec.day.length < 2) return true;   // 从未取到过 → 再试
      return rec.at !== today;
    });
    if (!need.length) { S.klineTriedAt = today; return Promise.resolve(0); }

    klineBusy = true;
    S.klineTriedAt = today;

    /* 美股需要带交易所后缀的代码（行情同步时记下来的 quoteCode）才能取到完整 K 线 */
    var codes = {};
    need.forEach(function (sym) {
      var rec = S.state.symbols[sym];
      if (rec && rec.quoteCode) codes[sym] = rec.quoteCode;
    });

    return XJ.fetcher.fetchKlineBundle(need, { count: 60, codes: codes }).then(function (map) {
      var got = 0;
      Object.keys(map).forEach(function (sym) {
        var pack = map[sym];
        if (!pack || !pack.day || pack.day.length < 2) return;
        /* 分析只用近 60 根，但留 120 根余量：多出的历史让 KDJ 的 K/D 从初值 50 收敛得更充分 */
        var day = pack.day.length > 120 ? pack.day.slice(-120) : pack.day;
        var week = (pack.week || []).length > 120 ? pack.week.slice(-120) : (pack.week || []);
        S.state.klineCache[sym] = { at: today, day: day, week: week };
        got++;
      });
      klineBusy = false;
      S.commitNow(null);
      return got;
    }).catch(function () {
      klineBusy = false;
      S.notify();
      return 0;
    });
  }

  function healSymbolNames() {
    var today = U.today();
    var need = Object.keys(S.state.symbols).filter(function (sym) {
      var m = S.state.symbols[sym] || {};
      if (m.nameLocked) return false;
      if (m.nameHealedOn === today) return false;
      if (!U.hasNameInfo(m.name)) return true;
      return m.nameSuspect !== false;
    });
    if (!need.length) return Promise.resolve(0);

    return XJ.fetcher.fetchNames(need).then(function (map) {
      var healed = 0;
      need.forEach(function (sym) {
        var m = S.state.symbols[sym];
        if (!m) return;
        m.nameHealedOn = today;
        var nm = map[sym];
        if (!nm || !U.hasNameInfo(nm)) return;          // 没查到就保留嫌疑标记，下次再试
        if (nm.length >= String(m.name || '').length) {
          m.name = nm;
          if (S.state.quoteCache[sym]) S.state.quoteCache[sym].name = nm;
          healed++;
        }
        m.nameSuspect = false;                          // 已反查过，不再重复
      });
      return healed;
    }).catch(function () { return 0; });
  }

  /**
   * 按市场拉取单只标的的分红方案并落库。美股无公开免费源 → 直接返回空数组。
   */
  function pullPlansFor(sym) {
    if (!XJ.market.dividendSource(sym)) return Promise.resolve([]);
    return XJ.fetcher.fetchDividends([sym]).then(function (res) {
      var plans = (res && res.plans && res.plans[sym]) || [];
      plans.forEach(function (p) { S.state.plans[p.planId] = p; });
      C.applyAutoReceived(S.state);
      S.commitNow(null);
      return plans;
    }).catch(function () { return []; });
  }

  function refreshOne(symbol) {
    var src = XJ.market.dividendSource(symbol);
    UI.toast('正在同步 ' + S.symbolName(symbol) + '…');
    /* 股息率曲线要的那份长历史收盘价，也一并强制重取（它是独立缓存，不在 fetchQuotes 里） */
    if (XJ.market.supportsYieldCurve(symbol)) {
      S.ui.yieldTriedAt = S.ui.yieldTriedAt || {};
      delete S.ui.yieldTriedAt[symbol];
      var ycodes = {};
      var yrec = S.state.symbols[symbol];
      if (yrec && yrec.quoteCode) ycodes[symbol] = yrec.quoteCode;
      XJ.fetcher.fetchYieldHistory([symbol], { codes: ycodes }).then(function (map) {
        var pack = map && map[symbol];
        if (!pack || !pack.day || pack.day.length < 2) return;
        S.state.yieldHistory[symbol] = { v: 2, at: U.today(), day: pack.day };
        S.ui.yjBeg = null; S.ui.yjEnd = null;      // 重取后回到默认「最近十年」
        S.commitNow(null);
      }).catch(function () { /* 曲线取数失败不影响下面的行情与分红同步 */ });
    }
    XJ.fetcher.fetchQuotes([symbol]).then(function (quotes) {
      S.mergeQuotes(quotes);
      return pullPlansFor(symbol);
    }).then(function (plans) {
      var added = C.applyAutoReceived(S.state);
      S.commitNow(null);
      if (!src) {
        UI.toast('行情已更新；' + XJ.market.kind(symbol) + '暂无分红数据源，可在分红记录里手工补录');
      } else {
        UI.toast('同步完成' + (plans.length ? '，' + plans.length + ' 条分红方案' : '') +
          (added ? '，新增 ' + added + ' 笔到账' : ''));
      }
    }).catch(function () {
      UI.toast('同步失败，请稍后重试');
    });
  }

  /* ---------------- 通用表单辅助 ---------------- */
  function accountOptions(selected) {
    return S.accounts().map(function (a) {
      return '<option value="' + U.esc(a.accountId) + '"' + (a.accountId === selected ? ' selected' : '') + '>' +
        U.esc(a.name) + '</option>';
    }).join('');
  }

  function pickFile(accept) {
    return new Promise(function (resolve) {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = accept || '.json';
      inp.style.position = 'fixed';
      inp.style.left = '-9999px';
      document.body.appendChild(inp);
      var done = false;
      function finish(val) {
        if (done) return;
        done = true;
        if (inp.parentNode) inp.parentNode.removeChild(inp);
        resolve(val);
      }
      inp.addEventListener('change', function () {
        var f = inp.files && inp.files[0];
        if (!f) return finish(null);
        var fr = new FileReader();
        fr.onload = function () { finish(String(fr.result)); };
        fr.onerror = function () { finish(null); };
        fr.readAsText(f, 'utf-8');
      });
      inp.click();
      setTimeout(function () { if (!done && !inp.files.length) { /* 用户可能取消，不做处理 */ } }, 60000);
    });
  }

  /* ---------------- 交互动作 ---------------- */
  UI.on('gotoTab', function (node) {
    S.setUI({ tab: node.getAttribute('data-tab'), status: '', subPage: null, floatOpen: false });
    window.scrollTo(0, 0);
  });

  /* ---- 子页面路由 ---- */
  UI.on('openAnalysis', function () {
    S.setUI({ subPage: 'analysis' });
    window.scrollTo(0, 0);
  });

  UI.on('closeSubPage', function () {
    S.setUI({ subPage: null, subArg: null });
  });

  UI.on('closeSheet', function () { UI.closeSheet(); });

  UI.on('switchAccount', function (node) {
    S.setUI({ accountId: node.getAttribute('data-id'), selDate: null });
    refreshAll({ silent: true });
  });

  UI.on('setSort', function (node) {
    S.setUI({ sortMode: node.getAttribute('data-mode') });
  });

  /* 「资产变动」快照曲线已被账户分析里的「资产走势」卡取代，setChartRange 动作随之移除 */

  UI.on('setMarketFilter', function (node) {
    S.setUI({ marketFilter: node.getAttribute('data-key') });
  });

  UI.on('toggleHero', function () {
    S.commit(function (s) { s.settings.heroCollapsed = !s.settings.heroCollapsed; });
  });

  UI.on('openMetricSettings', function () {
    var all = M.HERO_METRICS;
    var chosen = S.state.settings.heroMetrics || all.map(function (m) { return m.key; });
    var html = all.map(function (m) {
      var on = chosen.indexOf(m.key) >= 0;
      return '<label class="list-row" style="cursor:pointer">' +
        '<div class="row-main"><div class="row-t">' + U.esc(m.label) + '</div>' +
        '<div class="row-s" style="white-space:normal">' + U.esc(m.hint) + '</div></div>' +
        '<input type="checkbox" data-metric="' + m.key + '"' + (on ? ' checked' : '') +
        ' style="width:20px;height:20px;flex:0 0 auto">' +
        '</label>';
    }).join('');
    html += '<button class="btn-block" data-act="saveMetricSettings">保存</button>' +
      '<div class="tiny" style="margin-top:8px">至少选 1 个，最多 6 个。</div>';
    UI.openSheet({ title: '设置首页指标', html: html });
  });

  UI.on('saveMetricSettings', function (node) {
    var sheet = node.closest('.sheet');
    var keys = [];
    sheet.querySelectorAll('[data-metric]').forEach(function (n) {
      if (n.checked) keys.push(n.getAttribute('data-metric'));
    });
    if (!keys.length) return UI.toast('至少要选 1 个指标');
    S.commit(function (s) { s.settings.heroMetrics = keys; });
    UI.closeSheet();
    UI.toast('已保存');
  });

  /* ---------------- 深色卡「测算带」：编辑参数 / 反解 / 逐年明细 ----------------
   * 月均是派生量（= f(每年投入, 股息率, 年数, 再投比例)），不存储；
   * 编辑月均 = 拿目标去反解「年数」或「每年投入」并写回参数，反解失败则一个参数都不动。
   */

  /** 当前测算上下文（把「跟随市值息率」解析成具体数字） */
  function forecastCtx() {
    var st = S.state;
    var cfg = st.settings.heroForecast || {};
    var s = C.summary(st, S.acc());
    var follow = (cfg.yieldPct === null || cfg.yieldPct === undefined);
    var mvYield = U.n0(s.marketYield);
    return {
      cfg: cfg,
      baseDividend: U.n0(s.totalPredicted),
      yieldPct: follow ? (mvYield > 0 ? mvYield : 4) : U.n0(cfg.yieldPct),
    };
  }
  function forecastCfgOf(ctx) {
    return {
      annualInvest: ctx.cfg.annualInvest, yieldPct: ctx.yieldPct,
      years: ctx.cfg.years, reinvestPct: ctx.cfg.reinvestPct,
    };
  }
  function forecastPatch(patch) {
    S.commit(function (s) {
      s.settings.heroForecast = Object.assign({}, s.settings.heroForecast, patch);
    });
  }
  function forecastReason(res, which) {
    if (res.reason === 'no-growth') return '股息率或投入为 0 时分红不会增长，无法反解';
    if (res.reason === 'beyond-limit') {
      return which === 'invest'
        ? '按当前假设每年需投入 ' + (U.n0(res.exact) / 10000).toFixed(0) + ' 万，超出上限（10000 万）'
        : '按当前假设需要约 ' + Math.ceil(U.n0(res.exact)) + ' 年，超出 50 年上限';
    }
    return '无法反解';
  }

  /* 可编辑字段：万元 / 百分比 / 年 —— 输入与存储单位不同，统一在这里换算 */
  var HF_FIELDS = {
    annualInvest: { title: '每年投入金额', unit: '万元', range: '0 – 10000 万', dec: 1,
      get: function (c) { return U.n0(c.annualInvest) / 10000; },
      set: function (v) { return U.clamp(v * 10000, 0, C.FORECAST.investMaxYuan); } },
    yieldPct: { title: '股息率', unit: '%', range: '0 – 30%', dec: 1,
      get: function (c, ctx) { return U.n0(ctx.yieldPct); },
      set: function (v) { return U.clamp(v, 0, C.FORECAST.yieldMaxPct); } },
    years: { title: '年数', unit: '年', range: '1 – 50 年', dec: 0,
      get: function (c) { return U.n0(c.years) || 10; },
      set: function (v) { return U.clamp(Math.round(v), C.FORECAST.yearsMin, C.FORECAST.yearsMax); } },
    reinvestPct: { title: '分红再投比例', unit: '%', range: '0 – 100%', dec: 0,
      get: function (c) { return U.n0(c.reinvestPct); },
      set: function (v) { return U.clamp(v, 0, 100); } },
  };

  UI.on('editForecast', function (node) {
    var key = node.getAttribute('data-k');
    var ctx = forecastCtx();
    var fc = C.forecastRows(forecastCfgOf(ctx), ctx.baseDividend);

    /* 编辑「月均预测分红」= 给一个目标，反解年数或每年投入 */
    if (key === 'monthly') {
      var solveFor = ctx.cfg.solveFor === 'invest' ? 'invest' : 'years';
      UI.openSheet({
        title: '设定目标月均分红',
        html: '<div class="tiny" style="line-height:1.7;margin-bottom:10px">' +
          '填一个目标月均分红，系统会反解<b>' + (solveFor === 'invest' ? '每年投入金额' : '年数') +
          '</b>并写回参数。当前月均约 ' + U.moneySign(U.n0(fc.monthly), 0) + '。</div>' +
          UI.field('目标月均分红（元）',
            UI.inputHtml('hfTarget', Math.round(U.n0(fc.monthly)), { inputmode: 'numeric' })) +
          '<button class="btn-block" data-act="solveForecast">反解</button>' +
          '<button class="btn-block ghost" data-act="closeSheet">取消</button>',
      });
      return;
    }

    var f = HF_FIELDS[key];
    if (!f) return;
    var cur = f.get(ctx.cfg, ctx);
    var shown = cur.toFixed(f.dec);
    UI.openSheet({
      title: '修改' + f.title,
      html: UI.field(f.title + '（' + f.unit + '）',
        UI.inputHtml('hfVal', shown, { inputmode: f.dec ? 'decimal' : 'numeric' })) +
        '<button class="btn-block" data-act="saveForecast" data-v="' + key + '">确定</button>' +
        '<button class="btn-block ghost" data-act="closeSheet">取消</button>' +
        '<div class="tiny" style="margin-top:8px">取值范围：' + U.esc(f.range) +
        (key === 'yieldPct' ? '；改过之后不再跟随组合市值息率' : '') + '</div>',
    });
  });

  UI.on('saveForecast', function (node) {
    var key = node.getAttribute('data-v');
    var f = HF_FIELDS[key];
    var input = document.querySelector('.sheet [data-k="hfVal"]');
    if (!f || !input) return;
    var raw = U.num(input.value);
    if (raw === null) return UI.toast('请输入一个数字');
    var patch = {};
    patch[key] = f.set(raw);
    forecastPatch(patch);
    UI.closeSheet();
  });

  UI.on('solveForecast', function () {
    var input = document.querySelector('.sheet [data-k="hfTarget"]');
    var target = input ? U.num(input.value) : null;
    if (target === null || target < 0) return UI.toast('请输入一个有效的月均金额');
    var ctx = forecastCtx();
    var cfg = forecastCfgOf(ctx);
    var solveFor = ctx.cfg.solveFor === 'invest' ? 'invest' : 'years';

    if (solveFor === 'invest') {
      var ri = C.forecastSolveInvest(cfg, ctx.baseDividend, target);
      if (!ri.ok) return UI.toast(forecastReason(ri, 'invest'));
      forecastPatch({ annualInvest: ri.annualInvest });
      UI.closeSheet();
      UI.toast(ri.reached ? '当前假设下已能达到该目标，每年投入已设为 0'
        : '已把每年投入设为 ' + (ri.annualInvest / 10000).toFixed(1) + ' 万');
      return;
    }
    var ry = C.forecastSolveYears(cfg, ctx.baseDividend, target);
    if (!ry.ok) return UI.toast(forecastReason(ry, 'years'));
    if (ry.reached) {
      UI.closeSheet();
      return UI.toast('当前持仓的分红已经达到该月均目标');
    }
    forecastPatch({ years: ry.years });
    UI.closeSheet();
    UI.toast('反解得 ' + ry.years + ' 年（精确 ' + ry.exact.toFixed(1) + ' 年）');
  });

  UI.on('setForecastSolve', function (node) {
    forecastPatch({ solveFor: node.getAttribute('data-v') === 'invest' ? 'invest' : 'years' });
  });

  UI.on('forecastDetail', function () {
    var ctx = forecastCtx();
    var fc = C.forecastRows(forecastCfgOf(ctx), ctx.baseDividend);
    var html = '<div class="tiny" style="line-height:1.7;margin-bottom:10px">' +
      '现有持仓每年分红 ' + U.moneySign(ctx.baseDividend, 0) + ' 保持不变；每年投入 ' +
      (U.n0(fc.cfg.annualInvest) / 10000).toFixed(1) + ' 万按 ' + ctx.yieldPct.toFixed(1) +
      '% 生息；再投比例 ' + Math.round(U.n0(fc.cfg.reinvestPct)) + '%，再投于年末发生、从次年起才计息。' +
      '</div>' +
      '<div class="table-wrap"><table class="tbl"><thead><tr>' +
      '<th>年份</th><th>当年分红</th><th>其中新投入</th><th>年末新钱资产</th></tr></thead><tbody>' +
      fc.rows.map(function (r) {
        return '<tr><td>第 ' + r.year + ' 年 <span class="tiny">' + r.calendarYear + '</span></td>' +
          '<td class="c-div">' + U.moneySign(r.dividend, 0) + '</td>' +
          '<td>' + U.moneySign(r.fromNew, 0) + '</td>' +
          '<td>' + U.moneySign(r.assetsNew, 0) + '</td></tr>';
      }).join('') +
      '</tbody></table></div>';
    UI.openSheet({ title: '逐年明细', html: html });
  });

  UI.on('explain', function (node) {
    UI.openSheet({
      title: '口径说明',
      html: '<p class="muted" style="font-size:13.5px;line-height:1.85;margin:0">' +
        U.esc(node.getAttribute('data-text')) + '</p>',
    });
  });

  /* ---- 成本口径切换 ---- */
  var COST_METHODS = [
    ['weighted', '加权平均', '买入成本按加权平均计算；卖出时按均价结转，产生「已实现盈亏」。'],
    ['diluted', '摊薄成本', '(累计买入 − 累计卖出) ÷ 持股数。卖出回款直接冲减投入，成本可能为负。'],
    ['dividendDiluted', '分红摊薄', '(净投入 − 累计已收分红) ÷ 持股数。用收到的分红继续摊薄成本，可能为负。'],
  ];
  function costMethodName(m) {
    return ({ weighted: '加权平均', diluted: '摊薄成本', dividendDiluted: '分红摊薄' })[m] || '加权平均';
  }

  UI.on('openCostMethod', function (node) {
    var sym = node.getAttribute('data-symbol');
    var meta = S.state.symbols[sym] || {};
    var cur = meta.costMethod || M.DEFAULT_COST_METHOD;
    var html = COST_METHODS.map(function (o) {
      return '<button class="list-row" data-act="setCostMethod" data-symbol="' + U.esc(sym) + '" data-m="' + o[0] + '">' +
        '<div class="row-main"><div class="row-t">' + o[1] +
        (cur === o[0] ? ' <span class="pill blue">当前</span>' : '') + '</div>' +
        '<div class="row-s" style="white-space:normal">' + U.esc(o[2]) + '</div></div></button>';
    }).join('');
    html += '<div class="tiny" style="margin-top:10px">摊薄口径下不再展示「已实现盈亏」（成本是动态的，该指标失去意义）。</div>';
    UI.openSheet({ title: '成本口径 · ' + S.symbolName(sym), html: html });
  });

  UI.on('setCostMethod', function (node) {
    var sym = node.getAttribute('data-symbol');
    var m = node.getAttribute('data-m');
    S.commit(function (s) {
      if (!s.symbols[sym]) {
        s.symbols[sym] = M.symbolRecord(sym, { name: M.codeOf(sym) });
      }
      s.symbols[sym].costMethod = m;
    });
    UI.closeSheet();
    UI.toast('成本口径已切换为「' + costMethodName(m) + '」');
  });

  /* ---- 分红预测口径（财年计数） ---- */
  UI.on('openBasisEditor', function (node) {
    var sym = node.getAttribute('data-symbol');
    var meta = S.state.symbols[sym] || {};
    var b = meta.dividendBasis || S.state.settings.defaultDividendBasis || { type: 'years', value: 1 };
    var val = b.type === 'custom' ? 0 : (b.value || 1);

    var html = '<div class="field"><label>按财年个数</label><div class="segmented">' +
      [1, 3, 5].map(function (n) {
        return '<button class="' + (b.type === 'years' && val === n ? 'active' : '') +
          '" data-act="setBasis" data-symbol="' + U.esc(sym) + '" data-v="' + n + '">近' + n + '年</button>';
      }).join('') + '</div></div>' +
      '<div class="tiny" style="margin-bottom:14px">这里的「年」是<b>完整财年</b>个数：近1年 = 最近 1 个完整财年；' +
      '近3年 = 最近 3 个完整财年的方案合计 ÷ 3。数据不足 N 年时按实际可用年数计算，不会被低估。</div>' +
      UI.field('或指定起始财年', UI.inputHtml('startYear', b.type === 'custom' ? b.startYear : '', { placeholder: '如 2022', inputmode: 'numeric' })) +
      '<button class="btn-block" data-act="saveBasisCustom" data-symbol="' + U.esc(sym) + '">按起始财年计算</button>' +
      '<div class="tiny" style="margin-top:10px">该口径同时决定「预测年度分红 / 成本息率 / 市值息率」。</div>';
    UI.openSheet({ title: '分红预测口径 · ' + S.symbolName(sym), html: html });
  });

  UI.on('setBasis', function (node) {
    var sym = node.getAttribute('data-symbol');
    var v = U.num(node.getAttribute('data-v')) || 1;
    S.commit(function (s) {
      if (!s.symbols[sym]) {
        s.symbols[sym] = M.symbolRecord(sym, { name: M.codeOf(sym) });
      }
      s.symbols[sym].dividendBasis = { type: 'years', value: v };
    });
    UI.closeSheet();
    UI.toast('已切换为近 ' + v + ' 个财年');
  });

  UI.on('saveBasisCustom', function (node) {
    var sym = node.getAttribute('data-symbol');
    var f = UI.readFields(node.closest('.sheet'));
    var y = Math.round(U.n0(f.startYear));
    if (!y || y < 1990 || y > 2100) return UI.toast('请输入有效的起始财年（如 2022）');
    S.commit(function (s) {
      if (!s.symbols[sym]) {
        s.symbols[sym] = M.symbolRecord(sym, { name: M.codeOf(sym) });
      }
      s.symbols[sym].dividendBasis = { type: 'custom', startYear: y };
    });
    UI.closeSheet();
    UI.toast('已按起始财年 ' + y + ' 计算');
  });

  /* ---- 删除持仓 ---- */
  UI.on('deleteHolding', function (node) {
    var sym = node.getAttribute('data-symbol');
    var acc = S.ui.accountId;
    var name = S.symbolName(sym);
    var inScope = function (o) { return o.symbol === sym && (acc === C.ALL || o.accountId === acc); };

    var txs = S.state.transactions.filter(inScope);
    var recs = S.state.received.filter(inScope);
    if (!txs.length && !recs.length) return UI.toast('该持仓没有可删除的记录');

    var h = C.holdings(S.state, acc).filter(function (x) { return x.symbol === sym; })[0];
    var scopeText = (acc === C.ALL) ? '全部账户' : '当前账户';

    UI.confirm({
      title: '删除「' + name + '」',
      html: '将从<b>' + scopeText + '</b>移除该持仓：<br>' +
        '· 交易记录 <b>' + txs.length + '</b> 笔<br>' +
        '· 分红记录 <b>' + recs.length + '</b> 笔' +
        (h ? '<br><br>当前持有 <b>' + U.thousands(h.qty) + '</b> 股' +
          (h.marketValueCny !== null ? '，市值 ' + U.moneySign(h.marketValueCny) : '') : '') +
        '<br><br><span style="color:var(--up)">删除后不可撤销</span>，建议先在「我的 · 数据管理」导出一份 JSON 备份。',
      confirmText: '删除',
      danger: true,
    }).then(function (ok) {
      if (!ok) return;
      S.commit(function (s) {
        s.transactions = s.transactions.filter(function (t) { return !inScope(t); });
        s.received = s.received.filter(function (r) { return !inScope(r); });
        /* 该标的若已无任何交易，连同元数据与行情缓存一并清掉 */
        var still = s.transactions.some(function (t) { return t.symbol === sym; });
        if (!still) {
          delete s.symbols[sym];
          delete s.quoteCache[sym];
          s.plans = Object.keys(s.plans || {}).reduce(function (acc2, k) {
            if (s.plans[k].symbol !== sym) acc2[k] = s.plans[k];
            return acc2;
          }, {});
        }
      });
      UI.toast('已删除「' + name + '」');
    });
  });

  UI.on('openSymbol', function (node) {
    S.setUI({ subPage: 'symbol', subArg: node.getAttribute('data-symbol'), floatOpen: false });
    window.scrollTo(0, 0);
  });

  /* ---- 补录分红记录 ---- */
  UI.on('openReceiveEditor', function (node) {
    var sym = node.getAttribute('data-symbol');
    var accNow = S.acc() === C.ALL ? S.state.settings.defaultAccountId : S.acc();
    var h = C.holdings(S.state, S.acc()).filter(function (x) { return x.symbol === sym; })[0];
    var html =
      UI.field('到账日期', UI.inputHtml('date', U.today(), { type: 'date' })) +
      '<div class="field-row">' +
      UI.field('每股分红（税前，元）',
        '<input type="text" inputmode="decimal" data-k="perShare" data-input="rcPreview" placeholder="0.28">') +
      UI.field('登记数量（股）',
        '<input type="text" inputmode="numeric" data-k="qty" data-input="rcPreview" value="' + (h ? h.qty : '') + '">') +
      '</div>' +
      UI.field('所属账户', '<select data-k="accountId">' + accountOptions(accNow) + '</select>') +
      '<div class="tiny" id="xj-rc-preview" style="margin-bottom:12px">金额 = 每股分红 × 登记数量</div>' +
      '<button class="btn-block" data-act="saveReceive" data-symbol="' + U.esc(sym) + '">保存到账记录</button>' +
      '<div class="tiny" style="margin-top:10px">手工补录的记录标记为「手动」，不会被自动同步覆盖。</div>';
    UI.openSheet({ title: '补录分红 · ' + S.symbolName(sym), html: html });
  });

  UI.on('rcPreview', function (node) {
    var sheet = node.closest('.sheet');
    if (!sheet) return;
    var f = UI.readFields(sheet);
    var amt = U.n0(f.perShare) * U.n0(f.qty);
    var box = sheet.querySelector('#xj-rc-preview');
    if (box) box.innerHTML = '金额 = ' + U.money(f.perShare, 4) + ' × ' + U.thousands(f.qty) +
      ' = <b class="c-div">' + U.moneySign(amt) + '</b>';
  });

  UI.on('saveReceive', function (node) {
    var sym = node.getAttribute('data-symbol');
    var f = UI.readFields(node.closest('.sheet'));
    var perShare = U.num(f.perShare);
    var qty = U.num(f.qty);
    if (!(perShare > 0)) return UI.toast('每股分红必须大于 0');
    if (!(qty > 0)) return UI.toast('登记数量必须大于 0');
    var date = /^\d{4}-\d{2}-\d{2}$/.test(f.date || '') ? f.date : U.today();
    var amount = Math.round(qty * perShare * 100) / 100;
    var accId = f.accountId || S.state.settings.defaultAccountId;

    /* 去重：同一标的 + 同一账户 + 同一到账日 + 金额相符 → 已存在，拒绝重复记录 */
    var dup = S.state.received.some(function (r) {
      return U.sameDividend(r, {
        accountId: accId, symbol: sym, exDividendDate: date, amount: amount,
      });
    });
    if (dup) return UI.toast('该标的在这天已有一笔金额相同的分红记录；如需重复记录，请先删除原记录');

    S.commit(function (s) {
      s.received.push({
        recId: U.uid('rec'),
        accountId: accId,
        symbol: sym,
        planId: null,
        exDividendDate: date,
        perShareAmount: perShare,
        qtyAtRecord: qty,
        amount: amount,
        source: 'MANUAL',
        year: U.yearOf(date),
        createdAt: U.nowStamp(),
      });
    });
    UI.closeSheet();
    UI.toast('已补录一笔分红');
  });

  UI.on('deleteReceive', function (node) {
    var id = node.getAttribute('data-id');
    var rec = S.state.received.filter(function (r) { return r.recId === id; })[0];
    if (!rec) return;
    if (rec.source === 'AUTO') return UI.toast('自动登记的记录请通过调整交易或分红方案来修正');
    UI.confirm({ title: '删除分红记录', message: '确定删除这条手工补录的分红记录吗？', confirmText: '删除', danger: true })
      .then(function (ok) {
        if (!ok) return;
        S.commit(function (s) { s.received = s.received.filter(function (r) { return r.recId !== id; }); });
        UI.toast('已删除');
      });
  });

  /* ---- 编辑持仓 ---- */
  UI.on('openPositionEditor', function (node) {
    var sym = node.getAttribute('data-symbol');
    var meta = S.state.symbols[sym] || {};
    var h = C.holdings(S.state, S.acc()).filter(function (x) { return x.symbol === sym; })[0];
    var basis = meta.dividendBasis || S.state.settings.defaultDividendBasis || { type: 'years', value: 1 };
    var basisLabel = basis.type === 'custom'
      ? ('起始财年 ' + basis.startYear)
      : ('近 ' + (basis.value || 1) + ' 个财年');

    var html = '<div class="field" style="margin-bottom:12px"><label>显示名称</label>' +
      '<input type="text" data-k="dispName" value="' + U.esc(meta.name && U.hasNameInfo(meta.name) ? meta.name : '') + '" ' +
      'placeholder="' + U.esc(S.symbolName(sym)) + '"></div>' +
      '<button class="btn-block" data-act="saveSymbolName" data-symbol="' + U.esc(sym) + '">保存名称</button>' +
      '<div class="card" style="margin:12px 0">' +
      '<div class="kv"><span class="k">当前持股</span><span class="v">' +
      (h ? U.thousands(h.qty) + ' 股' : '—') + '</span></div>' +
      '<div class="kv"><span class="k">当前成本</span><span class="v">' +
      (h ? U.money(h.avgCost, 4) : '—') + '</span></div>' +
      '<div class="kv"><span class="k">成本口径</span><span class="v">' +
      U.esc(XJ.views.common.costMethodLabel(meta.costMethod || M.DEFAULT_COST_METHOD)) + '</span></div>' +
      '<div class="kv"><span class="k">分红预测口径</span><span class="v">' + U.esc(basisLabel) + '</span></div>' +
      '</div>' +
      '<button class="btn-block" data-act="addTxFor" data-symbol="' + U.esc(sym) + '">加仓 / 减仓 / 送股</button>' +
      '<button class="btn-block ghost" data-act="openCostMethod" data-symbol="' + U.esc(sym) + '">切换成本口径</button>' +
      '<button class="btn-block ghost" data-act="openBasisEditor" data-symbol="' + U.esc(sym) + '">切换分红预测口径</button>' +
      '<label class="list-row" style="cursor:pointer;margin-top:8px;border-radius:12px;background:var(--card-2)">' +
      '<div class="row-main"><div class="row-t">标记为负成本</div>' +
      '<div class="row-s" style="white-space:normal">成本已通过卖出全部收回，回本进度直接显示 100%</div></div>' +
      '<input type="checkbox" data-k="costRecovered"' + (meta.costRecovered ? ' checked' : '') +
      ' data-change="setCostRecovered" data-symbol="' + U.esc(sym) + '" style="width:20px;height:20px;flex:0 0 auto">' +
      '</label>' +
      '<div class="tiny" style="margin-top:10px">持仓由交易流水推导，因此没有「直接改数量/成本」的入口——' +
      '请通过加仓、减仓或送股记录调整，这样才能保证成本与盈亏可复算。</div>';
    UI.openSheet({ title: '编辑持仓 · ' + S.symbolName(sym), html: html });
  });

  UI.on('saveSymbolName', function (node) {
    var sym = node.getAttribute('data-symbol');
    var sheet = node.closest('.sheet');
    var f = UI.readFields(sheet);
    var nm = String(f.dispName || '').trim();
    if (!nm) return UI.toast('请输入名称');
    S.commit(function (s) {
      if (!s.symbols[sym]) {
        s.symbols[sym] = M.symbolRecord(sym, { name: nm });
      } else {
        s.symbols[sym].name = nm;
      }
      s.symbols[sym].nameLocked = true;   // 手动命名 → 行情与补全都不再覆盖
      s.symbols[sym].nameSuspect = false;
      if (s.quoteCache[sym]) s.quoteCache[sym].name = nm;
    });
    UI.closeSheet();
    UI.toast('名称已更新为「' + nm + '」');
  });

  UI.on('setCostRecovered', function (node) {
    var sym = node.getAttribute('data-symbol');
    var val = !!node.checked;
    S.commit(function (s) {
      if (!s.symbols[sym]) {
        s.symbols[sym] = M.symbolRecord(sym, { name: M.codeOf(sym) });
      }
      s.symbols[sym].costRecovered = val;
    });
    UI.toast(val ? '已标记为负成本' : '已取消标记');
  });

  UI.on('selDate', function (node) {
    var d = node.getAttribute('data-date');
    S.setUI({ selDate: d || null });
  });

  UI.on('calPrev', function () {
    var y = S.ui.calYear, m = S.ui.calMonth - 1;
    if (m < 1) { m = 12; y--; }
    S.setUI({ calYear: y, calMonth: m, selDate: null });
  });

  UI.on('calNext', function () {
    var y = S.ui.calYear, m = S.ui.calMonth + 1;
    if (m > 12) { m = 1; y++; }
    S.setUI({ calYear: y, calMonth: m, selDate: null });
  });

  UI.on('calToday', function () {
    var n = new Date();
    S.setUI({ calYear: n.getFullYear(), calMonth: n.getMonth() + 1, selDate: null, annualMonth: null });
    UI.toast('已回到今天');
  });

  UI.on('togglePend', function () {
    S.setUI({ pendCollapsed: !S.ui.pendCollapsed });
  });

  UI.on('setCalView', function (node) {
    S.setUI({ calView: node.getAttribute('data-v') });
  });

  UI.on('annualPrev', function () {
    var cur = S.ui.annualYear || (C.availableYears(S.state, S.acc())[0]) || U.yearOf(U.today());
    S.setUI({ annualYear: cur - 1, annualMonth: null });
  });

  UI.on('annualNext', function () {
    var cur = S.ui.annualYear || (C.availableYears(S.state, S.acc())[0]) || U.yearOf(U.today());
    S.setUI({ annualYear: cur + 1, annualMonth: null });
  });

  UI.on('selAnnualMonth', function (node) {
    S.setUI({ annualMonth: U.num(node.getAttribute('data-m')) });
  });

  UI.on('refresh', function () {
    UI.toast('正在同步最新数据…');
    refreshAll();
  });

  UI.on('refreshOne', function (node) {
    refreshOne(node.getAttribute('data-symbol'));
  });

  /* 股息率曲线的「余额宝七日年化」基准线开关（默认关闭，状态持久化在 settings 里） */
  UI.on('toggleYieldBench', function () {
    var on = !(S.state.settings && S.state.settings.showYieldBench === true);
    S.commit(function (s) { s.settings.showYieldBench = on; });
    if (on) ensureBench(false);
  });

  /* 平均股息率线的口径切换：整年均值 ⇄ 自切换日起累积。
     注意这不是「开/关」—— 均线常亮不可关闭，点图例只是换一条口径。 */
  UI.on('switchYieldAvg', function () {
    S.setUI({ yieldAvgMode: S.ui.yieldAvgMode === 'cum' ? 'year' : 'cum' });
  });

  /* ---------------- 派息日弹窗 + 分红汇总 ----------------
   * 弹窗触发：当天有派息事件（口径与「分红日历」完全同源，都是 calc.calendarEvents 的 payout 事件）。
   * 弹出频次：每天最多一次 —— 标记写进 settings.payoutPopupAt，跨会话 / 跨设备导入都不会重复弹。
   * 刻意**不在 render 里弹**：分红方案是异步拉的，太早判断会「今天明明有派息却弹不出来」，
   * 所以挂在 boot 的两个时点上各试一次（幂等）。 */
  function payoutPopupHtml(p) {
    var rows = p.items.map(function (e) {
      return '<div class="pp-row">' +
        '<span class="pp-nm">' + U.esc(e.name || XJ.model.codeOf(e.symbol)) + '</span>' +
        '<span class="pp-amt">+' + U.moneySign(e.amount) + '</span>' +
        '</div>';
    }).join('');
    return '<div class="pp-card" role="dialog" aria-label="今日分红到账">' +
      '<div class="pp-art">' +
      '<span class="pp-e1">🤑</span>' +
      '<span class="pp-sp pp-s1">💛</span><span class="pp-sp pp-s2">✨</span>' +
      '<span class="pp-sp pp-s3">💛</span><span class="pp-sp pp-s4">✨</span>' +
      '</div>' +
      '<div class="pp-title">今日分红到账</div>' +
      '<div class="pp-total">+' + U.moneySign(p.total) + '</div>' +
      '<div class="pp-rows">' + rows + '</div>' +
      '<button class="pp-main" data-act="viewDivRecords">查看分红记录</button>' +
      '<button class="pp-ghost" data-act="closeSheet">我知道了</button>' +
      /* A 股的派息日在本项目里是推算值（= 除权除息日），必须如实说明，
         否则用户发现钱没到会以为是 bug。只有确实是推算值时才显示这一行。 */
      (p.estimated ? '<div class="pp-note">A 股派息日按除权除息日推算，实际到账可能晚 1-2 天。</div>' : '') +
      '</div>';
  }

  function maybeShowPayoutPopup() {
    try {
      if (!S.state || !S.hasAnyData()) return;
      if (document.querySelector('.pp-mask')) return;                 // 已经弹着
      var today = U.today();
      if (S.state.settings.payoutPopupAt === today) return;           // 今天弹过了
      var p = C.payoutsOn(S.state, S.acc(), today);
      /* 今天没有派息 → 既不弹、也**不记标记**（否则方案还没同步到就白白错过一整天） */
      if (!p.items.length) return;
      S.state.settings.payoutPopupAt = today;
      XJ.storage.saveSoon(S.state);                                   // 直接落盘，不走 commit（那会触发整页重渲染）
      var root = document.getElementById('modal-root');
      if (!root) return;
      var mask = document.createElement('div');
      mask.className = 'mask pp-mask';
      mask.innerHTML = payoutPopupHtml(p);
      mask.addEventListener('click', function (e) { if (e.target === mask) UI.closeSheet(); });
      root.appendChild(mask);
    } catch (e) { console.warn('[payoutPopup]', e); }
  }

  UI.on('viewDivRecords', function () {
    UI.closeSheet();
    S.setUI({ subPage: 'divsummary', floatOpen: false });
  });

  UI.on('openDivSum', function () { S.setUI({ subPage: 'divsummary', floatOpen: false }); });

  UI.on('setDivsumRange', function (node) {
    var v = node.getAttribute('data-v');
    var patch = { divsumRange: v, divsumOpen: '' };
    /* 首次切到「自定义」时给个有意义的默认区间，否则会落到「今天~今天」的空结果 */
    if (v === 'custom' && !S.ui.divsumBeg) {
      patch.divsumBeg = U.yearOf(U.today()) + '-01-01';
      patch.divsumEnd = U.today();
    }
    S.setUI(patch);
  });

  UI.on('toggleDivsumSym', function (node) {
    var sym = node.getAttribute('data-sym');
    S.setUI({ divsumOpen: S.ui.divsumOpen === sym ? '' : sym });
  });

  UI.on('setDivsumBeg', function (node) { S.setUI({ divsumBeg: node.value || '' }); });
  UI.on('setDivsumEnd', function (node) { S.setUI({ divsumEnd: node.value || '' }); });

  UI.on('openDivFunSetting', function () {
    var fun = (S.state.settings && S.state.settings.dividendFun) || { name: '视频会员', monthly: 25 };
    UI.openSheet({
      title: '分红换算基准',
      html:
        '<div class="tiny" style="line-height:1.7;margin:-4px 0 12px">' +
        '「分红汇总」页会把累计分红换算成「相当于 N 个月 ___」，这里改的就是那个换算对象与月费。' +
        '月费填 0 或留空则隐藏那一行。</div>' +
        UI.field('换算对象', UI.inputHtml('name', fun.name, { placeholder: '如：视频会员' })) +
        UI.field('每月费用（元）', UI.inputHtml('monthly', fun.monthly, { inputmode: 'decimal' })) +
        '<button class="btn-block" data-act="saveDivFun">保存</button>' +
        '<button class="btn-block ghost" data-act="closeSheet">取消</button>',
    });
  });

  UI.on('saveDivFun', function () {
    var box = document.querySelector('.sheet');
    var f = box ? UI.readFields(box) : {};
    S.commit(function (s) {
      s.settings.dividendFun = {
        name: String(f.name || '').trim() || '视频会员',
        monthly: U.n0(f.monthly),
      };
    });
    UI.closeSheet();
    UI.toast('已保存');
  });

  /* ---- 悬浮双入口 ---- */
  UI.on('toggleFloat', function () { S.setUI({ floatOpen: !S.ui.floatOpen }); });
  UI.on('closeFloat', function () { S.setUI({ floatOpen: false }); });
  UI.on('floatManual', function () {
    S.setUI({ floatOpen: false });
    setTimeout(showAddHolding, 180);
  });
  /* ---- 截图识别（智谱 GLM-4V 多模态） ---- */
  /* kind: 'holding' 持仓概览 | 'trade' 交易记录。同一份草稿可容纳两种结果。 */
  function newOcrDraft() {
    return {
      kind: 'holding', rows: [], trades: [], name: '', symbol: null,
      busy: false, msg: '', accountId: null, date: null,
      lastDataUrl: null, forcedKind: null,
    };
  }
  var ocrDraft = newOcrDraft();

  UI.on('floatOcr', function () {
    S.setUI({ floatOpen: false });
    setTimeout(showOcr, 180);
  });

  function showOcr() {
    var cfg = S.state.settings.ocr || {};
    if (!cfg.agreed) return showOcrPrivacy();
    if (!cfg.apiKey) return openOcrSettings();
    UI.openSheet({ title: '截图识别', html: ocrSheetHtml() });
  }

  function showOcrPrivacy() {
    UI.openSheet({
      title: '截图识别 · 使用前请知悉',
      html: '<div class="tiny" style="line-height:1.9">' +
        '「截图识别」会把你的持仓截图上传到 <b>智谱 AI 开放平台</b>（open.bigmodel.cn）进行识别，' +
        '结果返回后由本应用写入本地。' +
        '<br><br>· 本应用<b>没有后端</b>，截图不经过作者的任何服务器' +
        '<br>· 智谱如何处理图片请见其官网隐私政策；介意上传请改用「✏️ 手动添加」' +
        '<br>· 默认使用免费模型 <b>GLM-4V-Flash</b>，也可换成自己的 Key' +
        '</div>' +
        '<button class="btn-block" data-act="ocrAgree">我已了解，继续</button>' +
        '<button class="btn-block ghost" data-act="closeSheet">取消</button>',
    });
  }
  UI.on('ocrAgree', function () {
    S.commit(function (s) { s.settings.ocr.agreed = true; });
    showOcr();
  });

  function ocrSheetHtml() {
    var cfg = S.state.settings.ocr || {};
    if (ocrDraft.busy) {
      return '<div class="empty" style="padding:26px 10px"><div class="ico">🔍</div>' +
        '<h3>正在识别…</h3><p id="xj-ocr-msg">' + U.esc(ocrDraft.msg || '正在处理') + '</p>' +
        '<div class="loading-inline">' + UI.icon('refresh', 14) + '<span>模型：' + U.esc(cfg.model) + '</span></div></div>';
    }
    var empty = !ocrDraft.rows.length && !ocrDraft.trades.length;
    if (empty) {
      return '<div class="warn-card"><span class="ic">ⓘ</span><span>' +
        '支持两类截图：<b>①持仓概览</b>（有持仓数量与成本列）<br><b>②交易记录</b>（逐笔买卖，含价格/数量/金额）。' +
        '上传后会自动判断类型，识别结果先列出来让你核对，确认后才写入。可一次选多张。</span></div>' +
        '<button class="btn-block" data-act="pickOcrImages">选择截图（可多张）</button>' +
        '<button class="btn-block ghost" data-act="openOcrSettings">识别设置 · ' + U.esc(modelLabel(cfg.model)) + '</button>' +
        '<div class="tiny" style="margin-top:12px">识别由智谱 GLM-4V 完成，截图会上传到智谱服务器。</div>';
    }
    /* 同一份草稿里若混了两种结果，优先展示交易记录（信息更完整） */
    if (ocrDraft.trades.length) return tradeSheetHtml();
    return holdingSheetHtml();
  }

  /** 模式切换芯片：可强制重识别为另一类 */
  function kindChips() {
    var opts = [['auto', '自动判断'], ['holding', '持仓概览'], ['trade', '交易记录']];
    var cur = ocrDraft.forcedKind || 'auto';
    var canSwitch = !!ocrDraft.lastDataUrl;
    return '<div class="chips" style="padding-bottom:8px">' + opts.map(function (o) {
      return '<button class="chip' + (o[0] === cur ? ' active' : '') + '"' +
        (canSwitch ? ' data-act="setOcrKind" data-v="' + o[0] + '"' : ' disabled style="opacity:.5"') +
        '>' + o[1] + '</button>';
    }).join('') + '</div>';
  }

  /** ① 持仓概览结果 */
  function holdingSheetHtml() {
    var accNow = ocrDraft.accountId ||
      (S.acc() === C.ALL ? S.state.settings.defaultAccountId : S.acc());
    var usable = ocrDraft.rows.filter(function (r) { return !r.skip && r.symbol && r.quantity > 0; });
    var html = kindChips();
    html += '<div class="tiny" style="margin-bottom:8px">识别到 <b>' + ocrDraft.rows.length +
      '</b> 条，可导入 <b class="c-div">' + usable.length + '</b> 条。请逐行核对：</div>';
    html += '<div class="list" style="box-shadow:none;border:1px solid var(--line);margin-bottom:12px">' +
      ocrDraft.rows.map(function (r, i) {
        return '<div class="list-row" style="padding:10px 12px">' +
          '<input type="checkbox" data-ocr="' + i + '" data-change="ocrToggle"' + (r.skip ? '' : ' checked') +
          ' style="width:18px;height:18px;flex:0 0 auto">' +
          '<div class="row-main">' +
          '<div class="row-t"><span class="nm">' + U.esc(r.name || '未识别名称') + '</span>' +
          (r.symbol
            ? '<span class="pill gray">' + U.esc(XJ.market.label(r.symbol)) + '</span>'
            : '<span class="pill down">缺代码</span>') +
          (r.quantity > 0 ? '' : '<span class="pill down">缺数量</span>') +
          '</div>' +
          '<div class="row-s">' + U.esc(r.symbol || r.code || '—') + ' · ' +
          (r.quantity > 0 ? U.thousands(r.quantity) + '股' : '数量缺失') + ' · 成本 ' +
          (r.cost === null ? '—' : U.money(r.cost, 4)) + '</div>' +
          '</div>' +
          '<button class="ghost-btn" data-act="editOcrRow" data-i="' + i + '">核对</button>' +
          '</div>';
      }).join('') + '</div>';
    html += '<div class="field-row">' +
      UI.field('导入到账户', '<select data-k="accountId">' + accountOptions(accNow) + '</select>') +
      UI.field('建仓日期', UI.inputHtml('date', ocrDraft.date || U.today(), { type: 'date' })) +
      '</div>';
    html += '<button class="btn-block" data-act="importOcrRows"' + (usable.length ? '' : ' disabled') + '>' +
      '导入 ' + usable.length + ' 条持仓</button>';
    html += '<button class="btn-block ghost" data-act="pickOcrImages">再选几张截图</button>';
    html += '<div class="tiny" style="margin-top:10px">导入会为每条生成一笔「买入」记录（成本取识别到的成本价）。' +
      '识别有偏差时请先点「核对」修正。</div>';
    return html;
  }

  /** ② 交易记录结果 */
  function tradeSheetHtml() {
    var accNow = ocrDraft.accountId ||
      (S.acc() === C.ALL ? S.state.settings.defaultAccountId : S.acc());
    var list = ocrDraft.trades;
    var cnt = { BUY: 0, SELL: 0, DIV: 0 };
    var ok = { BUY: 0, SELL: 0, DIV: 0 };
    list.forEach(function (t) {
      cnt[t.action]++;
      if (t.skip) return;
      if (t.action === 'DIV') { if (t.amount > 0 && t.date) ok.DIV++; return; }
      if (t.quantity > 0 && t.date) ok[t.action]++;
    });
    var ACT = { BUY: ['买入', 'up'], SELL: ['卖出', 'down'], DIV: ['分红', 'div'] };

    var html = kindChips();
    html += '<div class="warn-card" style="margin-bottom:10px"><span class="ic">📋</span><span>' +
      '识别为 <b>交易记录</b>：共 <b>' + list.length + '</b> 条（买入 ' + cnt.BUY + ' · 卖出 ' + cnt.SELL +
      ' · 分红 ' + cnt.DIV + '）。逐笔导入后，<b>持仓数量与成本会由这些交易自动推导</b>，' +
      '比直接读汇总数字更准、可复算。</span></div>';

    html += '<div class="field-row">' +
      UI.field('股票名称', UI.inputHtml('stockName', ocrDraft.name || '', { placeholder: '如 中远海控' })) +
      UI.field('股票代码',
        '<input type="text" data-k="stockCode" data-input="ocrStockCode" placeholder="如 601919" ' +
        'value="' + U.esc(ocrDraft.symbol ? M.codeOf(ocrDraft.symbol) : '') + '">') +
      '</div>';
    html += '<div class="tiny" id="xj-ocr-sym" style="margin:-4px 0 10px">' + ocrSymPreview() + '</div>';

    html += '<div class="list" style="box-shadow:none;border:1px solid var(--line);margin-bottom:12px">' +
      list.map(function (t, i) {
        var a = ACT[t.action] || ACT.BUY;
        var right = t.action === 'DIV'
          ? U.moneySign(t.amount)
          : (t.quantity !== null ? U.thousands(t.quantity) + '股 × ' + U.money(t.price, t.price < 10 ? 3 : 2) : '缺数量');
        return '<div class="list-row" style="padding:10px 12px">' +
          '<input type="checkbox" data-ocr-trade="' + i + '" data-change="ocrTradeToggle"' +
          (t.skip ? '' : ' checked') + ' style="width:18px;height:18px;flex:0 0 auto">' +
          '<div class="row-main">' +
          '<div class="row-t"><span class="pill ' + a[1] + '">' + a[0] + '</span>' +
          '<span class="nm" style="font-size:13px;color:var(--text-2)">' + U.esc(t.date || '缺日期') + '</span></div>' +
          '<div class="row-s">' + U.esc(right) +
          (t.amount !== null && t.action !== 'DIV' ? ' · 金额 ' + U.moneySign(t.amount) : '') +
          (t.fee ? ' · 费用 ' + U.money(t.fee, 2) : '') + '</div>' +
          '</div></div>';
      }).join('') + '</div>';

    html += '<div class="field-row">' +
      UI.field('导入到账户', '<select data-k="accountId">' + accountOptions(accNow) + '</select>') +
      UI.field('', '<div class="tiny" style="padding-top:8px">日期取自每条记录</div>') +
      '</div>';

    var total = ok.BUY + ok.SELL;
    var parts = [];
    if (ok.BUY) parts.push(ok.BUY + ' 买');
    if (ok.SELL) parts.push(ok.SELL + ' 卖');
    html += '<button class="btn-block" data-act="importOcrTrades"' + ((total + ok.DIV) ? '' : ' disabled') + '>' +
      '导入 ' + total + ' 笔交易' + (parts.length ? '（' + parts.join(' + ') + '）' : '') +
      (ok.DIV ? ' + ' + ok.DIV + ' 笔分红' : '') + '</button>';
    html += '<button class="btn-block ghost" data-act="pickOcrImages">再选几张截图</button>';
    html += '<div class="tiny" style="margin-top:10px">分红行会写入「分红记录」（到账日取该行日期）；' +
      '交易行会生成买入/卖出记录。核对无误后再导入。</div>';
    return html;
  }

  function modelLabel(key) {
    var m = XJ.ocr.MODELS.filter(function (x) { return x.key === key; })[0];
    return m ? m.label : (key || XJ.ocr.DEFAULT_MODEL);
  }

  UI.on('pickOcrImages', function () {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.multiple = true;
    inp.style.position = 'fixed';
    inp.style.left = '-9999px';
    document.body.appendChild(inp);
    inp.addEventListener('change', function () {
      var files = Array.prototype.slice.call(inp.files || []);
      if (inp.parentNode) inp.parentNode.removeChild(inp);
      if (!files.length) return;
      runOcr(files);
    });
    inp.click();
  });

  /** 把一次识别的结果并入草稿（两类结果可共存，界面优先展示交易记录） */
  function applyOcrResult(res, fallbackRef) {
    if (!res) return;
    if (res.retried && fallbackRef) fallbackRef.v = true;
    if (res.kind === 'trade') {
      ocrDraft.trades = ocrDraft.trades.concat(res.trades || []);
      /* 多张截图可能来自不同股票：换了股票但新图没给代码 → 旧代码必须作废 */
      var id = XJ.ocr.mergeTradeIdentity({ name: ocrDraft.name, symbol: ocrDraft.symbol }, res);
      ocrDraft.name = id.name;
      ocrDraft.symbol = id.symbol;
    } else {
      (res || []).forEach(function (r) {
        r.symbol = M.normalizeSymbol(r.code) || null;
        r.skip = false;
        ocrDraft.rows.push(r);
      });
    }
  }

  /** 交易记录面板里的标的预览（让用户一眼看出会不会张冠李戴） */
  function ocrSymPreview() {
    var sym = ocrDraft.symbol;
    if (!sym) return '尚未确定标的 —— 请填写股票代码，导入时按代码匹配。';
    var meta = S.state.symbols[sym];
    var nm = meta && U.hasNameInfo(meta.name) ? meta.name : '';
    return '将导入到 <b>' + U.esc(sym) + '</b> · ' + U.esc(XJ.market.kind(sym)) +
      (nm ? ' · ' + U.esc(nm) : '') + (ocrDraft.name ? '（识别名称：' + U.esc(ocrDraft.name) + '）' : '');
  }

  UI.on('ocrStockCode', function (node) {
    var code = String(node.value || '').replace(/[^0-9A-Za-z]/g, '');
    ocrDraft.symbol = M.normalizeSymbol(code) || null;
    var box = document.querySelector('#xj-ocr-sym');
    if (box) box.innerHTML = ocrSymPreview();
  });

  function runOcr(files) {
    var cfg = S.state.settings.ocr || {};
    ocrDraft.busy = true;
    ocrDraft.msg = '正在读取图片…';
    UI.openSheet({ title: '截图识别', html: ocrSheetHtml() });

    var chain = Promise.resolve();
    var failed = [];
    var used = { v: false };

    files.forEach(function (f, idx) {
      chain = chain.then(function () {
        ocrDraft.msg = '正在识别第 ' + (idx + 1) + '/' + files.length + ' 张…';
        var box = document.querySelector('#xj-ocr-msg');
        if (box) box.textContent = ocrDraft.msg;
        return XJ.ocr.fileToDataUrl(f).then(function (dataUrl) {
          ocrDraft.lastDataUrl = dataUrl;
          /* 自动判断截图类型 + 双模型兜底 */
          return XJ.ocr.recognizeAuto(dataUrl, {
            apiKey: cfg.apiKey, model: cfg.model,
            kind: ocrDraft.forcedKind || undefined,
          });
        }).then(function (res) {
          applyOcrResult(res, used);
        }).catch(function (e) {
          failed.push((f.name || ('第 ' + (idx + 1) + ' 张')) + '：' + e.message);
        });
      });
    });

    chain.then(function () {
      ocrDraft.busy = false;
      ocrDraft.msg = '';
      if (!ocrDraft.accountId) {
        ocrDraft.accountId = S.acc() === C.ALL ? S.state.settings.defaultAccountId : S.acc();
      }
      S.commit(function (s) { s.settings.ocr.lastUsedAt = U.nowStamp(); });
      UI.openSheet({ title: '截图识别', html: ocrSheetHtml() });

      var n = ocrDraft.rows.length + ocrDraft.trades.length;
      var tail = used.v ? '（已自动换用更强模型）' : '';
      if (failed.length) UI.toast(failed.length + ' 张识别失败：' + failed[0].slice(0, 40));
      else if (!n) UI.toast('没有识别到内容，换张更清晰的截图试试');
      else if (ocrDraft.trades.length) UI.toast('识别为交易记录 ' + ocrDraft.trades.length + ' 条' + tail);
      else UI.toast('识别到 ' + ocrDraft.rows.length + ' 条持仓' + tail);
    }).catch(function (e) {
      ocrDraft.busy = false;
      ocrDraft.msg = '';
      console.error('[ocr]', e);
      UI.openSheet({
        title: '截图识别失败',
        html: '<div class="warn-card"><span class="ic">⚠️</span><span>' + U.esc(e.message || '未知错误') + '</span></div>' +
          '<button class="btn-block" data-act="pickOcrImages">重新选择截图</button>' +
          '<button class="btn-block ghost" data-act="openOcrSettings">检查识别设置</button>',
      });
    });
  }

  /** 手动切换识别类型 → 用最后一张图重识别 */
  UI.on('setOcrKind', function (node) {
    var v = node.getAttribute('data-v');
    ocrDraft.forcedKind = (v === 'auto') ? null : v;
    if (!ocrDraft.lastDataUrl) {
      UI.openSheet({ title: '截图识别', html: ocrSheetHtml() });
      return;
    }
    var cfg = S.state.settings.ocr || {};
    ocrDraft.rows = [];
    ocrDraft.trades = [];
    ocrDraft.name = '';
    ocrDraft.symbol = null;
    ocrDraft.busy = true;
    ocrDraft.msg = '正在按「' + (({ holding: '持仓概览', trade: '交易记录' })[v] || '自动判断') + '重新识别…';
    UI.openSheet({ title: '截图识别', html: ocrSheetHtml() });
    XJ.ocr.recognizeAuto(ocrDraft.lastDataUrl, {
      apiKey: cfg.apiKey, model: cfg.model, kind: ocrDraft.forcedKind || undefined,
    }).then(function (res) {
      ocrDraft.busy = false;
      applyOcrResult(res, { v: false });
      UI.openSheet({ title: '截图识别', html: ocrSheetHtml() });
    }).catch(function (e) {
      ocrDraft.busy = false;
      UI.openSheet({ title: '截图识别', html: ocrSheetHtml() });
      UI.toast('重识别失败：' + e.message);
    });
  });

  UI.on('ocrTradeToggle', function (node) {
    var i = +node.getAttribute('data-ocr-trade');
    if (ocrDraft.trades[i]) ocrDraft.trades[i].skip = !node.checked;
    UI.openSheet({ title: '截图识别', html: ocrSheetHtml() });
  });

  UI.on('importOcrTrades', function (node) {
    var sheet = node.closest('.sheet');
    var f = UI.readFields(sheet);
    /* 关键：以输入框为准（用户看到的真源），只有为空才回退到草稿里的 symbol。
       历史 bug：草稿优先，导致用户手改代码不生效 —— 中远海控被写成了保利发展。 */
    var sym = XJ.ocr.resolveSymbol(f.stockCode, ocrDraft.symbol);
    if (!sym) return UI.toast('请填写或确认股票代码');
    var name = String(f.stockName || '').trim();
    var accId = f.accountId || S.state.settings.defaultAccountId;

    var batch = U.uid('ib');
    var txs = [], divs = [], skipReasons = [], dupDiv = 0;
    (ocrDraft.trades || []).forEach(function (t, i) {
      if (t.skip) return;
      var at = '第 ' + (i + 1) + ' 条';
      if (!t.date) { skipReasons.push(at + '缺日期'); return; }
      if (t.action === 'DIV') {
        if (!(t.amount > 0)) { skipReasons.push(at + '分红金额无效'); return; }
        divs.push({ date: t.date, amount: t.amount });
        return;
      }
      /* 数量一律取绝对值 —— 券商流水里卖出常写成 -200 股。
         这正是「卖出全部丢失」bug 的根因：负数过不了 quantity > 0 的检查。 */
      var qty = Math.abs(U.n0(t.quantity));
      if (!(qty > 0)) { skipReasons.push(at + '缺数量'); return; }
      txs.push({
        txId: U.uid('tx'), accountId: accId, symbol: sym,
        action: (t.action === 'SELL' ? 'SELL' : 'BUY'),
        date: t.date, quantity: qty,
        price: Math.abs(U.n0(t.price)),
        fee: Math.abs(U.n0(t.fee)),
        note: '截图识别导入', importBatch: batch, createdAt: U.nowStamp(),
      });
    });
    var nBuy = txs.filter(function (t) { return t.action === 'BUY'; }).length;
    var nSell = txs.filter(function (t) { return t.action === 'SELL'; }).length;
    if (!txs.length && !divs.length) {
      return UI.toast(skipReasons.length ? ('没有可导入的记录：' + skipReasons[0]) : '没有可导入的记录');
    }

    S.commit(function (s) {
      txs.forEach(function (t) { s.transactions.push(t); });
      /* 分红行按当日实际持股反推每股金额，让「分红记录」显示得完整 */
      divs.forEach(function (d) {
        var pos = C.position(s.transactions.filter(function (t) {
          return t.symbol === sym && t.accountId === accId;
        }), d.date, 'weighted');
        var qty = pos.qty;
        /* 去重：同一标的 + 同一账户 + 同一到账日 + 金额相符 → 已有（自动或手动）就不再记一次 */
        var dup = s.received.some(function (r) {
          return U.sameDividend(r, {
            accountId: accId, symbol: sym, exDividendDate: d.date, amount: d.amount,
          });
        });
        if (dup) { dupDiv++; return; }
        s.received.push({
          recId: U.uid('rec'), accountId: accId, symbol: sym, planId: null,
          exDividendDate: d.date,
          perShareAmount: qty > 0 ? Math.round(d.amount / qty * 10000) / 10000 : 0,
          qtyAtRecord: qty,
          amount: d.amount, source: 'MANUAL', year: U.yearOf(d.date), createdAt: U.nowStamp(),
        });
      });
      if (!s.symbols[sym]) {
        s.symbols[sym] = M.symbolRecord(sym, { name: U.hasNameInfo(name) ? name : '' });
      } else if (U.hasNameInfo(name)) {
        s.symbols[sym].name = name;
      }
    });

    UI.closeSheet();
    ocrDraft = newOcrDraft();

    /* 导入后自检：写入的买入/卖出条数必须与预期一致。
       任何丢失都要打日志暴露出来，而不是静默吞掉（历史 bug 教训）。 */
    var written = S.state.transactions.filter(function (t) { return t.importBatch === batch; });
    var wBuy = written.filter(function (t) { return t.action === 'BUY'; }).length;
    var wSell = written.filter(function (t) { return t.action === 'SELL'; }).length;
    if (wBuy !== nBuy || wSell !== nSell) {
      console.error('[ocr-import] 条数不一致', { expect: { buy: nBuy, sell: nSell }, actual: { buy: wBuy, sell: wSell } });
      UI.toast('⚠️ 导入条数异常（买入 ' + wBuy + '/' + nBuy + '，卖出 ' + wSell + '/' + nSell + '），请检查数据');
      return;
    }

    UI.toast('已导入 买入 ' + wBuy + ' 笔 · 卖出 ' + wSell + ' 笔' +
      (divs.length ? ' · 分红 ' + (divs.length - dupDiv) + ' 笔' : '') +
      (dupDiv ? '（' + dupDiv + ' 笔分红已存在，已跳过）' : '') +
      (skipReasons.length ? '；跳过 ' + skipReasons.length + ' 条：' + skipReasons[0] : ''));
    refreshAll({ silent: true });
  });

  UI.on('ocrToggle', function (node) {
    var i = +node.getAttribute('data-ocr');
    if (ocrDraft.rows[i]) ocrDraft.rows[i].skip = !node.checked;
    var usable = ocrDraft.rows.filter(function (r) { return !r.skip && r.symbol && r.quantity > 0; }).length;
    UI.openSheet({ title: '截图识别', html: ocrSheetHtml() });
  });

  UI.on('editOcrRow', function (node) {
    var i = +node.getAttribute('data-i');
    var r = ocrDraft.rows[i];
    if (!r) return;
    UI.openSheet({
      title: '核对第 ' + (i + 1) + ' 条',
      html: UI.field('股票名称', UI.inputHtml('name', r.name || '')) +
        UI.field('股票代码', UI.inputHtml('code', r.code || '', { placeholder: '600023 / hk00700 / AAPL' })) +
        '<div class="field-row">' +
        UI.field('持股数量', UI.inputHtml('quantity', r.quantity === null ? '' : r.quantity, { inputmode: 'numeric' })) +
        UI.field('成本价', UI.inputHtml('cost', r.cost === null ? '' : r.cost, { inputmode: 'decimal' })) +
        '</div>' +
        '<button class="btn-block" data-act="saveOcrRow" data-i="' + i + '">保存</button>' +
        '<button class="btn-block danger" data-act="dropOcrRow" data-i="' + i + '">从识别结果中移除</button>',
    });
  });

  UI.on('saveOcrRow', function (node) {
    var i = +node.getAttribute('data-i');
    var f = UI.readFields(node.closest('.sheet'));
    var r = ocrDraft.rows[i];
    if (!r) return;
    r.name = String(f.name || '').trim();
    r.code = String(f.code || '').replace(/[^0-9A-Za-z]/g, '') || null;
    r.quantity = U.num(f.quantity);
    r.cost = U.num(f.cost);
    r.symbol = M.normalizeSymbol(r.code) || null;
    UI.closeSheet();
    setTimeout(function () { UI.openSheet({ title: '截图识别', html: ocrSheetHtml() }); }, 140);
  });

  UI.on('dropOcrRow', function (node) {
    var i = +node.getAttribute('data-i');
    ocrDraft.rows.splice(i, 1);
    UI.closeSheet();
    setTimeout(function () { UI.openSheet({ title: '截图识别', html: ocrSheetHtml() }); }, 140);
  });

  UI.on('importOcrRows', function (node) {
    var sheet = node.closest('.sheet');
    var f = UI.readFields(sheet);
    var accId = f.accountId || S.state.settings.defaultAccountId;
    var date = /^\d{4}-\d{2}-\d{2}$/.test(f.date || '') ? f.date : U.today();

    var ok = [], bad = [];
    ocrDraft.rows.forEach(function (r) {
      if (r.skip) return;
      if (!r.symbol || !(r.quantity > 0)) { bad.push(r); return; }
      ok.push(r);
    });
    if (!ok.length) return UI.toast('没有可导入的有效行（需要代码与数量）');

    S.commit(function (s) {
      ok.forEach(function (r) {
        s.transactions.push({
          txId: U.uid('tx'), accountId: accId, symbol: r.symbol, action: 'BUY',
          date: date,
          quantity: r.quantity,
          price: r.cost === null ? 0 : r.cost,
          fee: 0,
          note: '截图识别导入',
          createdAt: U.nowStamp(),
        });
        if (!s.symbols[r.symbol]) {
          s.symbols[r.symbol] = {
            symbol: r.symbol, code: M.codeOf(r.symbol), market: M.marketOf(r.symbol),
            name: U.hasNameInfo(r.name) ? r.name : '', type: 'STOCK', updatedAt: U.nowStamp(),
          };
        } else if (U.hasNameInfo(r.name)) {
          s.symbols[r.symbol].name = r.name;
        }
      });
    });

    UI.closeSheet();
    ocrDraft = newOcrDraft();
    UI.toast('已导入 ' + ok.length + ' 条持仓' + (bad.length ? '，' + bad.length + ' 条因缺代码/数量被跳过' : ''));
    refreshAll({ silent: true });
  });

  /* ---- 识别设置 ---- */
  function openOcrSettings() {
    var cfg = S.state.settings.ocr || {};
    var html =
      '<div class="field"><label>模型</label><div class="segmented">' +
      XJ.ocr.MODELS.map(function (m) {
        return '<button class="' + (cfg.model === m.key ? 'active' : '') +
          '" data-act="setOcrModel" data-key="' + m.key + '">' + U.esc(m.label.replace(/GLM-|V-/g, '')) + '</button>';
      }).join('') + '</div></div>' +
      '<div class="tiny" style="margin-bottom:14px">' +
      U.esc((XJ.ocr.MODELS.filter(function (m) { return m.key === cfg.model; })[0] || {}).note || '') + '</div>' +
      UI.field('智谱 API Key', UI.inputHtml('apiKey', cfg.apiKey || '', { placeholder: '在 open.bigmodel.cn 获取' })) +
      '<div class="tiny" style="margin-bottom:14px">已预置一把可用 Key，可直接使用；换成自己的更安全。' +
      '单文件分发时等于把 Key 一起分发出去，介意请务必更换。</div>' +
      '<button class="btn-block" data-act="saveOcrSettings">保存</button>' +
      '<div class="tiny" style="margin-top:10px">截图会上传到智谱服务器；本应用没有后端，不经过任何中间服务器。</div>';
    UI.openSheet({ title: '截图识别设置', html: html });
  }
  UI.on('openOcrSettings', openOcrSettings);

  UI.on('setOcrModel', function (node) {
    S.commit(function (s) { s.settings.ocr.model = node.getAttribute('data-key'); });
    openOcrSettings();
  });

  UI.on('saveOcrSettings', function (node) {
    var f = UI.readFields(node.closest('.sheet'));
    var key = String(f.apiKey || '').trim();
    if (!key) return UI.toast('请填写 API Key');
    if (key.length < 20) return UI.toast('API Key 看起来不完整');
    S.commit(function (s) { s.settings.ocr.apiKey = key; });
    UI.closeSheet();
    UI.toast('已保存');
  });

  /* ---- 添加持仓（三步式表单） ---- */
  var MK_TABS = [
    { key: 'a', label: 'A股', hint: 'auto' },
    { key: 'etf', label: 'ETF', hint: 'auto' },
    { key: 'of', label: '基金', hint: 'of' },
    { key: 'hk', label: '港股', hint: 'hk' },
    { key: 'us', label: '美股', hint: 'us' },
    { key: 'custom', label: '自定义', hint: 'auto' },
  ];
  function newDraft() {
    return {
      symbol: null, name: '', mkTab: 'a', query: '', results: '',
      costMethod: M.DEFAULT_COST_METHOD, negative: false, basis: { type: 'years', value: 1 },
      basisPreview: '--', basisHint: '', focusQuery: false,
    };
  }
  var draft = newDraft();
  var searchTimer = null;

  function draftHint() {
    var t = MK_TABS.filter(function (x) { return x.key === draft.mkTab; })[0];
    return t ? t.hint : 'auto';
  }

  function stepHead(n, title, hint) {
    var done = (n === 1 && draft.symbol) || (n > 1 && draft.symbol);
    return '<div style="display:flex;align-items:center;gap:9px;margin:16px 0 10px">' +
      '<span style="width:22px;height:22px;border-radius:50%;flex:0 0 auto;display:flex;align-items:center;justify-content:center;' +
      'font-size:12px;font-weight:700;' + (done ? 'background:var(--text);color:#fff' : 'background:rgba(120,120,128,.16);color:var(--text-2)') + '">' + n + '</span>' +
      '<span style="font-size:15px;font-weight:650">' + title + '</span>' +
      '<span style="flex:1"></span>' +
      '<span class="tiny">' + (hint || '') + '</span>' +
      '</div>';
  }

  function resultsHtml(list) {
    if (!list || !list.length) {
      return '<div class="tiny" style="padding:6px 2px 2px">没有匹配结果。若确定代码，可切到「自定义」直接输入完整代码（如 sh600023 / hk00700 / usAAPL）。</div>';
    }
    return '<div class="list" style="box-shadow:none;border:1px solid var(--line);margin-bottom:4px">' +
      list.slice(0, 8).map(function (x) {
        return '<button class="list-row" data-act="pickSymbol" data-symbol="' + U.esc(x.symbol) + '" data-name="' + U.esc(x.name) + '">' +
          UI.avatar(x.name, x.symbol, 32) +
          '<div class="row-main"><div class="row-t"><span class="nm">' + U.esc(x.name) + '</span></div>' +
          '<div class="row-s">' + U.esc(x.code) + ' · ' + U.esc(x.kind) + '</div></div>' +
          '<span class="chev">' + UI.icon('chevron', 15) + '</span></button>';
      }).join('') + '</div>';
  }

  function updateBasisPreview() {
    if (!draft.symbol) { draft.basisPreview = '--'; draft.basisHint = ''; return; }
    var plans = C.plansOf(S.state, draft.symbol);
    if (!plans.length) {
      draft.basisPreview = '--';
      draft.basisHint = '暂无分红方案，添加后会自动同步';
      return;
    }
    var b = draft.basis.type === 'custom'
      ? { type: 'custom', startYear: U.n0(draft.basis.startYear) || (U.yearOf(U.today()) - 4) }
      : draft.basis;
    var a = C.annualBasePerShare(plans, b);
    draft.basisPreview = '¥' + U.money(a.perShare, 4);
    if (a.basis === 'fiscal') {
      draft.basisHint = a.years > 1
        ? ('近 ' + a.years + ' 个完整财年（' + a.fromYear + '–' + a.year + '）合计 ¥' +
          U.money(a.total, 4) + ' ÷ ' + a.years)
        : ('最近一财年（' + a.year + '）方案合计 ¥' + U.money(a.total, 4));
      if (a.capped) draft.basisHint += '（数据只有 ' + a.available + ' 年，按实际年数计算）';
    } else if (a.basis === 'fundTtm') {
      draft.basisHint = '基金按近 12 个月已分配金额年化';
    } else if (a.basis === 'ttm') {
      draft.basisHint = '无年报方案，按近 12 个月方案年化';
    } else {
      draft.basisHint = '暂无可用分红方案';
    }
  }

  function addHoldingHtml() {
    var today = U.today();
    var picked = !!draft.symbol;
    var accNow = S.acc() === C.ALL ? S.state.settings.defaultAccountId : S.acc();
    var dis = picked ? '' : ' disabled';
    var dim = picked ? '' : 'opacity:.42;';
    var qmark = XJ.views.common.qmark;
    var html = '';

    html += '<div style="display:flex;justify-content:center;gap:5px;margin:2px 0 6px">' +
      [1, 2, 3].map(function (i) {
        var on = i <= (picked ? 3 : 1);
        return '<span style="height:6px;border-radius:3px;background:' + (on ? 'var(--text)' : 'rgba(120,120,128,.2)') +
          ';width:' + (i === (picked ? 3 : 1) ? '18px' : '6px') + ';transition:width .2s"></span>';
      }).join('') + '</div>';

    /* ── 步骤 1 ── */
    html += stepHead(1, '选择股票', picked ? '' : '先选股');
    html += '<div class="chips" style="padding-bottom:8px">' + MK_TABS.map(function (t) {
      return '<button class="chip' + (draft.mkTab === t.key ? ' active' : '') +
        '" data-act="pickMarket" data-key="' + t.key + '">' + t.label + '</button>';
    }).join('') + '</div>';
    html += '<div class="field" style="margin-bottom:8px">' +
      '<input type="text" data-k="query" data-input="symbolSearch" autocomplete="off" ' +
      'placeholder="' + (draft.mkTab === 'custom' ? '输入完整代码，如 sh600023 / hk00700 / usAAPL' : '输入股票名称或代码搜索') + '" ' +
      'value="' + U.esc(draft.query) + '"></div>';
    html += '<div id="xj-search-results">' + (draft.results || '') + '</div>';
    if (picked) {
      html += '<div class="card" style="margin:0 0 4px;padding:10px 12px;background:var(--card-2);box-shadow:none">' +
        '已选 <b>' + U.esc(draft.name) + '</b> <span class="tiny">' + U.esc(draft.symbol) + ' · ' +
        U.esc(XJ.market.kind(draft.symbol)) + '</span></div>';
    }

    /* ── 步骤 2 ── */
    html += stepHead(2, '持仓信息', picked ? '' : '选股后自动展开');
    html += '<fieldset' + dis + ' style="border:0;padding:0;margin:0;' + dim + '">';
    html += '<div class="field-row">' +
      UI.field('持仓数量 *', UI.inputHtml('quantity', '', { inputmode: 'numeric', placeholder: '股数' })) +
      UI.field('买入日期 *', UI.inputHtml('date', today, { type: 'date' })) +
      '</div>';
    html += '<div class="field-row">' +
      UI.field('交易费用（可选）', UI.inputHtml('fee', '', { inputmode: 'decimal', placeholder: '元' })) +
      UI.field('所属账户', '<select data-k="accountId">' + accountOptions(accNow) + '</select>') +
      '</div>';
    html += '<div class="field"><label>当前成本 *' + qmark('成本口径决定「成本息率」「分红回本进度」怎么算。摊薄口径下卖出回款会直接冲减投入，成本可能为负。') + '</label>' +
      '<div class="segmented" style="margin-bottom:8px">' +
      [['dividendDiluted', '分红摊薄'], ['diluted', '摊薄成本'], ['weighted', '加权平均']].map(function (o) {
        return '<button class="' + (draft.costMethod === o[0] ? 'active' : '') +
          '" data-act="pickCostMethod" data-key="' + o[0] + '">' + o[1] + '</button>';
      }).join('') + '</div>' +
      '<div style="display:flex;align-items:center;gap:8px">' +
      '<input type="text" inputmode="decimal" data-k="price" placeholder="成本价" style="flex:1">' +
      '<span class="tiny" style="white-space:nowrap;flex:0 0 auto">' + U.esc(XJ.market.curSymbol(draft.symbol || 'sh000000')) + '/股</span>' +
      '</div>' +
      '<div class="tiny" style="margin-top:6px">支持正数与零（送股填 0）。若成本为负，是「卖出回款超过买入支出」的结果，' +
      '系统会按所选口径自动算出，无需手填。</div></div>';
    html += '<label class="switch tiny" style="margin:4px 0 6px"><input type="checkbox" data-k="negativeCost"' +
      (draft.negative ? ' checked' : '') + '> 标记为负成本（成本已通过卖出全部收回）</label>';
    html += '</fieldset>';

    /* ── 步骤 3 ── */
    html += stepHead(3, '分红预测口径', picked ? '' : '选股后自动展开');
    html += '<fieldset' + dis + ' style="border:0;padding:0;margin:0;' + dim + '">';
    html += '<div class="segmented">' +
      [1, 3, 5].map(function (n) {
        return '<button class="' + (draft.basis.type === 'years' && draft.basis.value === n ? 'active' : '') +
          '" data-act="pickBasis" data-v="' + n + '">近' + n + '年</button>';
      }).join('') +
      '<button class="' + (draft.basis.type === 'custom' ? 'active' : '') + '" data-act="pickBasis" data-v="0">自定义</button>' +
      '</div>';
    if (draft.basis.type === 'custom') {
      html += '<div class="field" style="margin-top:10px"><label>起始财年</label>' +
        '<input type="text" inputmode="numeric" data-k="startYear" data-input="basisStartYear" value="' +
        (U.n0(draft.basis.startYear) || (U.yearOf(U.today()) - 4)) + '"></div>';
    }
    html += '<div style="margin-top:10px;font-size:13px">年均每股分红 <b id="xj-basis-preview" style="color:var(--dividend)">' +
      U.esc(draft.basisPreview) + '</b></div>' +
      '<div class="tiny" id="xj-basis-hint" style="margin-top:4px">' +
      U.esc(draft.basisHint || '取最近 1 个完整财年的分红记录，计算每股派息') + '</div>' +
      '</fieldset>';

    html += '<button class="btn-block" data-act="saveAddHolding"' + dis + ' style="margin-top:16px">确认添加</button>';
    html += '<div class="tiny" style="margin-top:10px">持仓由交易流水推导：这一步会生成一笔「买入」记录，' +
      '因此「成本息率 / 分红回本进度」等指标都可被独立复算。追加或减仓请在该标的详情页的「交易明细」里记一笔。</div>';
    return html;
  }

  function paintAddHolding() {
    var sheet = document.querySelector('.sheet');
    if (!sheet) return;
    sheet.innerHTML = '<div class="sheet-grip"></div><h3>添加持仓</h3>' + addHoldingHtml();
    if (draft.focusQuery) {
      var q = sheet.querySelector('[data-k="query"]');
      if (q) {
        q.focus();
        try { q.setSelectionRange(q.value.length, q.value.length); } catch (e) {}
      }
    }
  }

  function showAddHolding() {
    draft = newDraft();
    UI.openSheet({ title: '添加持仓', html: addHoldingHtml() });
  }

  UI.on('openAddHolding', function () { showAddHolding(); });

  UI.on('pickMarket', function (node) {
    draft.mkTab = node.getAttribute('data-key');
    draft.symbol = null; draft.name = ''; draft.results = '';
    draft.focusQuery = true;
    updateBasisPreview();
    paintAddHolding();
  });

  UI.on('pickCostMethod', function (node) {
    draft.costMethod = node.getAttribute('data-key');
    paintAddHolding();
  });

  UI.on('pickBasis', function (node) {
    var v = U.num(node.getAttribute('data-v'));
    draft.basis = v ? { type: 'years', value: v } : { type: 'custom', startYear: U.yearOf(U.today()) - 4 };
    updateBasisPreview();
    paintAddHolding();
  });

  UI.on('basisStartYear', function (node) {
    var y = Math.round(U.n0(node.value));
    if (y < 1990 || y > 2100) return;
    draft.basis = { type: 'custom', startYear: y };
    updateBasisPreview();
    var sheet = document.querySelector('.sheet');
    if (!sheet) return;
    var prev = sheet.querySelector('#xj-basis-preview');
    var hint = sheet.querySelector('#xj-basis-hint');
    if (prev) prev.textContent = draft.basisPreview;
    if (hint) hint.textContent = draft.basisHint;
  });

  UI.on('pickSymbol', function (node) {
    draft.symbol = node.getAttribute('data-symbol');
    draft.name = node.getAttribute('data-name');
    draft.results = '';
    draft.query = draft.name;
    draft.focusQuery = false;
    updateBasisPreview();
    paintAddHolding();
  });

  UI.on('symbolSearch', function (node) {
    var kw = node.value;
    draft.query = kw;
    draft.focusQuery = true;
    if (searchTimer) clearTimeout(searchTimer);

    var box = document.querySelector('.sheet #xj-search-results');

    /* 自定义模式：直接按代码解析（无需联网） */
    if (draft.mkTab === 'custom') {
      var sym = M.normalizeSymbol(kw, draftHint());
      var changed = (sym || null) !== (draft.symbol || null);
      draft.symbol = sym || null;
      draft.name = sym ? kw.trim() : '';
      if (changed) {
        draft.focusQuery = true;
        updateBasisPreview();
        paintAddHolding();                       // 让步骤 2 / 3 立即展开
        return;
      }
      if (box) {
        box.innerHTML = sym
          ? '<div class="tiny" style="padding:4px 2px">已识别 <b>' + U.esc(sym) + '</b>（' + U.esc(XJ.market.kind(sym)) + '）</div>'
          : '<div class="tiny" style="padding:4px 2px">无法识别该代码，请检查格式。</div>';
      }
      return;
    }

    if (!kw || kw.length < 1) {
      if (box) box.innerHTML = '';
      draft.results = '';
      return;
    }
    searchTimer = setTimeout(function () {
      XJ.fetcher.fetchSymbolSearch(kw).then(function (list) {
        draft.results = resultsHtml(list);
        var b = document.querySelector('.sheet #xj-search-results');
        if (b) b.innerHTML = draft.results;
      });
    }, 320);
  });

  UI.on('saveAddHolding', function (node) {
    var sheet = node.closest('.sheet');
    var f = UI.readFields(sheet);
    var sym = draft.symbol || M.normalizeSymbol(f.query, draftHint());
    if (!sym) return UI.toast('请先选择股票');
    if (!(U.num(f.quantity) > 0)) return UI.toast('持仓数量必须大于 0');
    var price = U.num(f.price);
    if (price === null) return UI.toast('请输入成本价（送股填 0）');
    if (price < 0) return UI.toast('成本价不能为负；负成本请通过「摊薄口径 + 卖出回款」或勾选「标记为负成本」实现');

    var accId = f.accountId || S.state.settings.defaultAccountId;
    var tx = {
      txId: U.uid('tx'), accountId: accId, symbol: sym, action: 'BUY',
      date: /^\d{4}-\d{2}-\d{2}$/.test(f.date || '') ? f.date : U.today(),
      quantity: U.num(f.quantity), price: price, fee: U.n0(f.fee),
      note: '', createdAt: U.nowStamp(),
    };
    var errs = M.validateTransaction(tx);
    if (errs.length) return UI.toast(errs[0]);

    var neg = !!sheet.querySelector('[data-k="negativeCost"]').checked;
    S.commit(function (s) {
      s.transactions.push(tx);
      if (!s.symbols[sym]) {
        s.symbols[sym] = M.symbolRecord(sym, { name: U.hasNameInfo(draft.name) ? draft.name : '' });
      }
      s.symbols[sym].costMethod = draft.costMethod;
      s.symbols[sym].dividendBasis = draft.basis;
      if (neg) s.symbols[sym].costRecovered = true;
    });

    UI.closeSheet();
    UI.toast('已添加 ' + (draft.name || sym) + '，正在同步行情…');
    draft = newDraft();

    XJ.fetcher.fetchQuotes([sym]).then(function (q) {
      if (S.mergeQuotes(q)) S.commitNow(null);
      return ensureSymbolAssets(sym);
    });
    pullPlansFor(sym);
  });

  /**
   * 补齐单只标的的「附属资料」：公司官网域名 → 公司图标。
   * 新加入的持仓要立刻拿到图标，所以添加/导入后单独跑一次，不必等下一轮整体同步。
   * 只处理这一只，不做全量重解析。
   */
  function ensureSymbolAssets(sym) {
    if (!S.state.symbols[sym]) return Promise.resolve(false);
    return Promise.resolve().then(function () {
      if (S.state.symbols[sym].domain) return null;
      return XJ.fetcher.fetchCompanyDomains([sym]).then(function (m) {
        if (m && m[sym] && S.state.symbols[sym]) S.state.symbols[sym].domain = m[sym];
      }).catch(function () { });
    }).then(function () {
      return XJ.fetcher.resolveLogo(sym, S.state.symbols[sym].domain || null);
    }).then(function (hit) {
      var rec = S.state.symbols[sym];
      if (!rec) return false;
      rec.logoResolvedOn = U.today();
      rec.logoAlgo = XJ.fetcher.LOGO_ALGO;
      if (hit && hit.url) {
        rec.logoUrl = hit.url;
        rec.logoSource = hit.source;
        rec.logoState = 'ok';
      } else if (rec.logoState !== 'ok') {
        rec.logoUrl = null;
        rec.logoState = 'bad';
      }
      S.commitNow(null);
      return true;
    }).catch(function () { return false; });
  }

  /* ---- 交易编辑 ---- */
  function showTxEditor(id, presetSym) {
    var tx = id ? S.state.transactions.filter(function (t) { return t.txId === id; })[0] : null;

    /* 成本调整是独立的记录类型：没有数量/价格，只有一个 signed 的调整金额 */
    if (tx && tx.action === 'ADJUST') return showAdjustEditor(tx);

    var accSelected = tx ? tx.accountId : (S.acc() === C.ALL ? S.state.settings.defaultAccountId : S.acc());

    var html =
      UI.field('所属账户', '<select data-k="accountId">' + accountOptions(accSelected) + '</select>') +
      UI.field('股票代码', UI.inputHtml('code', tx ? M.codeOf(tx.symbol) : (presetSym ? M.codeOf(presetSym) : ''), { placeholder: '600023', inputmode: 'numeric' })) +
      UI.field('交易方向', '<select data-k="action">' +
        '<option value="BUY"' + (tx && tx.action === 'SELL' ? '' : ' selected') + '>买入 / 加仓</option>' +
        '<option value="SELL"' + (tx && tx.action === 'SELL' ? ' selected' : '') + '>卖出 / 减仓</option>' +
        '</select>') +
      '<div class="field-row">' +
      UI.field('数量（股）', UI.inputHtml('quantity', tx ? tx.quantity : '', { inputmode: 'numeric' })) +
      UI.field('价格（元）', UI.inputHtml('price', tx ? tx.price : '', { inputmode: 'decimal' })) +
      '</div>' +
      '<div class="field-row">' +
      UI.field('手续费（元）', UI.inputHtml('fee', tx ? U.n0(tx.fee) : '0', { inputmode: 'decimal' })) +
      UI.field('交易日期', UI.inputHtml('date', tx ? tx.date : U.today(), { type: 'date' })) +
      '</div>' +
      UI.field('备注', UI.inputHtml('note', tx ? (tx.note || '') : '', { placeholder: '可选' })) +
      '<button class="btn-block" data-act="saveTx" data-id="' + U.esc(id || '') + '">' + (tx ? '保存修改' : '保存交易') + '</button>' +
      (tx ? '<button class="btn-block danger" data-act="deleteTx" data-id="' + U.esc(id) + '">删除这笔交易</button>' : '');

    UI.openSheet({ title: tx ? '编辑交易' : '记一笔交易', html: html });
  }

  /** 「成本调整」记录的编辑器：只改金额与日期 */
  function showAdjustEditor(tx) {
    var html =
      '<div class="field"><label>标的</label>' +
      '<div class="kv" style="padding:0"><span class="k">' + U.esc(S.symbolName(tx.symbol)) + '</span>' +
      '<span class="v">' + U.esc(XJ.market.displayCode(tx.symbol)) + '</span></div></div>' +
      UI.field('调整金额（元，可为负）', UI.inputHtml('amount', tx.amount, { inputmode: 'decimal' })) +
      UI.field('日期', UI.inputHtml('date', tx.date, { type: 'date' })) +
      UI.field('备注', UI.inputHtml('note', tx.note || '', { placeholder: '可选' })) +
      '<button class="btn-block" data-act="saveTx" data-id="' + U.esc(tx.txId) + '" data-adjust="1">保存修改</button>' +
      '<button class="btn-block danger" data-act="deleteTx" data-id="' + U.esc(tx.txId) + '">删除这笔调整</button>' +
      '<div class="tiny" style="margin-top:10px;line-height:1.7">' +
      '成本调整只改变成本基础，不改变持股数量。' +
      '</div>';
    UI.openSheet({ title: '编辑成本调整', html: html });
  }

  UI.on('editTx', function (node) {
    var id = node.getAttribute('data-id');
    if (id) showTxEditor(id);
  });

  UI.on('toggleFoldPlans', function () {
    S.setUI({ foldPlans: !(S.ui.foldPlans !== false) });
  });

  UI.on('toggleFoldTx', function () {
    S.setUI({ foldTx: !(S.ui.foldTx !== false) });
  });

  UI.on('toggleFoldMineTx', function () {
    S.setUI({ foldMineTx: !(S.ui.foldMineTx !== false) });
  });

  /* ---------------- 资产走势：指标 / 区间 / 粒度 / 模式 / 收起 ----------------
   * 这张卡挂了两处（首页 ns=''、账户分析 ns='an'），控件状态各自独立：
   * 按钮上带 data-ns，这里统一换算成对应实例的 ui 键再写入。 */
  function nwNs(node) {
    return (node && node.getAttribute && node.getAttribute('data-ns')) || '';
  }
  function nwPatch(ns, kv) {
    var out = {};
    Object.keys(kv).forEach(function (field) {
      out[XJ.views.networth.keyOf(ns, field)] = kv[field];
    });
    return out;
  }

  UI.on('setNwMetric', function (node) {
    var ns = nwNs(node);
    var v = node.getAttribute('data-v');
    S.setUI(nwPatch(ns, { metric: (v === 'nw' || v === 'ret') ? v : 'mv' }));
    /* 切到收益率时，如果指数历史还没拉过就先拉一次 */
    if (v === 'ret') ensureIndexData(false);
  });

  UI.on('setNwMode', function (node) {
    S.setUI(nwPatch(nwNs(node), { mode: node.getAttribute('data-v') === 'candle' ? 'candle' : 'line' }));
  });

  /* 收益率口径：时间加权（TWR）/ 成本收益率。只影响收益率模式的取数与文案 */
  UI.on('setNwRetMode', function (node) {
    S.setUI(nwPatch(nwNs(node), { retMode: node.getAttribute('data-v') === 'cost' ? 'cost' : 'twr' }));
  });

  /** 勾选 / 取消对比指数 */
  UI.on('toggleIndex', function (node) {
    var key = node.getAttribute('data-v');
    if (!XJ.market.indexDef(key)) return;
    if (!XJ.market.indexHasHistory(key)) { UI.toast('该指数暂无免费历史数据源'); return; }
    var cur = (S.state.settings.indexCompare || []).slice();
    var i = cur.indexOf(key);
    if (i >= 0) cur.splice(i, 1); else cur.push(key);
    S.commit(function (s) { s.settings.indexCompare = cur; });
    ensureIndexData(false);
  });

  /** 清空公司图标缓存并重新解析（图标源改版或想立刻刷新时用） */
  UI.on('refreshLogos', function () {
    var n = 0;
    XJ.calc.holdings(S.state, S.acc()).forEach(function (h) {
      var rec = S.state.symbols[h.symbol];
      if (!rec) return;
      rec.logoUrl = null;
      rec.logoState = null;
      rec.logoResolvedOn = null;
      rec.logoAlgo = 0;
      rec.domain = null;          // 域名也一并重取，避免域名源改版后一直用旧的
      n++;
    });
    S.commitNow(null);
    UI.toast('正在重新解析 ' + n + ' 只标的的公司图标…');
    Promise.all([
      XJ.fetcher.fetchCompanyDomains(XJ.calc.holdings(S.state, S.acc()).map(function (h) { return h.symbol; }))
        .then(function (m) {
          Object.keys(m || {}).forEach(function (s2) {
            if (S.state.symbols[s2]) S.state.symbols[s2].domain = m[s2];
          });
        }).catch(function () { }),
    ]).then(function () { return resolveLogosNow(true); }).then(function (got) {
      UI.toast(got ? ('已获取 ' + got + ' 只标的的公司图标') : '暂时没有解析到新的公司图标');
    });
  });

  UI.on('toggleNw', function (node) {
    var ns = nwNs(node);
    var cur = S.ui[XJ.views.networth.keyOf(ns, 'collapsed')];
    S.setUI(nwPatch(ns, { collapsed: !cur }));
  });

  UI.on('setNwGran', function (node) {
    S.setUI(nwPatch(nwNs(node), { gran: node.getAttribute('data-v') === 'month' ? 'month' : 'day' }));
  });

  UI.on('setNwRange', function (node) {
    var ns = nwNs(node);
    var v = node.getAttribute('data-v') || 'all';
    var patch = { range: v };
    if (v === 'custom' && !S.ui[XJ.views.networth.keyOf(ns, 'beg')]) {
      var t = U.today();
      patch.beg = U.addDays(t, -90);
      patch.end = t;
    }
    S.setUI(nwPatch(ns, patch));
  });

  UI.on('setNwCustom', function (node) {
    var ns = nwNs(node);
    var card = (node.closest && node.closest('.nw-card')) || document;
    var beg = card.querySelector('[data-k="nwBeg"]');
    var end = card.querySelector('[data-k="nwEnd"]');
    S.setUI(nwPatch(ns, {
      range: 'custom',
      beg: beg ? beg.value : S.ui[XJ.views.networth.keyOf(ns, 'beg')],
      end: end ? end.value : S.ui[XJ.views.networth.keyOf(ns, 'end')],
    }));
  });

  UI.on('fetchHistory', function () {
    UI.toast('正在获取历史行情…');
    Promise.all([ensureHistory(true), ensureKline(true), ensureIndexData(true)]).then(function (r) {
      var n = (r[0] || 0) + (r[1] || 0) + (r[2] || 0);
      UI.toast(n ? '已更新 ' + n + ' 项历史行情' : '历史行情获取失败，可稍后重试');
    });
  });

  /* ---------------- 持仓明细：改数量 / 改成本 ----------------
   * 架构上持仓由交易流水推导，所以两个编辑器都不直接写数量或成本，
   * 而是换算成一笔「调整」记录追加到流水里，持仓仍是单一真源。
   */

  /** 弹层里带 data-symbol 的按钮就是当前编辑的标的 */
  function sheetSymbol(sheet) {
    var b = sheet && sheet.querySelector('[data-symbol]');
    return b ? b.getAttribute('data-symbol') : S.ui.subArg;
  }

  /** 改数量：补一笔买入/卖出，使股数对上；价格可选「当前成本价（每股成本不变）」「0 元（送股/转增）」「手动」 */
  function showQtyEditor(symbol) {
    var st = XJ.store;
    var acc = st.acc();
    var h = XJ.calc.holdings(st.state, acc).filter(function (x) { return x.symbol === symbol; })[0];
    if (!h) return UI.toast('当前账户下没有该标的的持仓');

    /* 这一屏改的是【每股成本 / 成交价】，单位是标的的原币（港股就是港元）。
       金额一律带币种符号显示，不能写死 ¥ —— 否则港股会显示成「¥300 的每股成本」。 */
    var cs = U.esc(h.curSymbol);
    var unit = h.currency === 'CNY' ? '元' : h.currency;

    var html =
      '<div class="field"><label>当前持仓</label>' +
      '<div class="kv" style="padding:0"><span class="k">' + U.thousands(h.qty) + ' 股</span>' +
      '<span class="v">' + cs + U.money(h.avgCost, 4) + ' / 股</span></div></div>' +
      '<div class="field"><label>修改为（股）</label>' +
      '<input type="text" inputmode="numeric" data-k="qty" data-input="qtyPreview" value="' + U.esc(U.n0(h.qty)) + '"></div>' +
      '<div class="field"><label>调整价格</label>' +
      '<select data-k="mode" data-input="qtyPreview">' +
      '<option value="avg" selected>以当前成本价 ' + cs + U.money(h.avgCost, 4) + ' 补记（每股成本不变）</option>' +
      '<option value="zero">以 0 ' + U.esc(unit) + '补记（送股 / 转增，总成本不变）</option>' +
      '<option value="custom">手动输入价格</option>' +
      '</select></div>' +
      '<div class="field"><label>手动价格（' + U.esc(unit) + '）</label>' +
      '<input type="text" inputmode="decimal" data-k="price" data-input="qtyPreview" value="' + U.esc(U.money(h.avgCost, 4)) + '"></div>' +
      '<div id="xj-qty-preview" class="note-line" style="margin:4px 0 12px">' +
      UI.icon('info', 13) + '<span>输入目标数量后查看将要补记的交易</span></div>' +
      accountHint() +
      '<button class="btn-block" data-act="saveQty" data-symbol="' + U.esc(symbol) + '">保存</button>';

    UI.openSheet({
      title: '修改持仓数量',
      html: html,
      onMount: function (sheet) { updateQtyPreview(sheet, symbol); },
    });
  }

  /** 「全部账户」下补记的交易只能落到某一个账户，这里明确说清楚落到哪 */
  function accountHint() {
    if (S.acc() !== C.ALL) return '';
    var a = S.state.accounts.filter(function (x) {
      return x.accountId === S.state.settings.defaultAccountId;
    })[0];
    if (!a) return '';
    return '<div class="tiny" style="margin:-6px 0 10px">当前是「全部账户」视图，补记的记录将记入默认账户「' +
      U.esc(a.name) + '」。</div>';
  }

  function qtyRowPlan(sheet, symbol) {
    var h = XJ.calc.holdings(S.state, S.acc()).filter(function (x) { return x.symbol === symbol; })[0];
    if (!h) return null;
    var f = UI.readFields(sheet);
    var target = U.num(f.qty);
    if (target === null || target < 0) return { err: '数量不能为负' };
    var diff = Math.round((target - h.qty) * 1e6) / 1e6;
    if (Math.abs(diff) < 1e-6) return { err: '数量没有变化' };
    var price;
    if (f.mode === 'zero') price = 0;
    else if (f.mode === 'custom') price = U.num(f.price);
    else price = h.avgCost;
    if (price === null || price < 0) return { err: '价格不能为负' };
    return {
      diff: diff, price: price,
      action: diff > 0 ? 'BUY' : 'SELL',
      qty: Math.abs(diff),
      amount: Math.abs(diff) * price,
      avgCost: h.avgCost,
    };
  }

  function updateQtyPreview(sheet, symbol) {
    var box = sheet.querySelector('#xj-qty-preview');
    if (!box) return;
    var p = qtyRowPlan(sheet, symbol);
    var text;
    if (!p) text = '找不到该持仓';
    else if (p.err) text = p.err;
    else {
      /* 预览「调整后」的每股成本：直接把将要补记的交易丢给同一个 position() 引擎算，
         保证预览与保存后的结果完全一致（不在视图里另写一套公式）。 */
      var h = XJ.calc.holdings(S.state, S.acc()).filter(function (x) { return x.symbol === symbol; })[0];
      var cs = U.esc(h ? h.curSymbol : '¥');       // 金额是原币口径，币种符号跟着标的走
      var previewTx = {
        txId: '__preview__', accountId: S.acc() === XJ.calc.ALL ? S.state.settings.defaultAccountId : S.acc(),
        symbol: symbol, action: p.action, date: U.today(),
        quantity: p.qty, price: p.price, fee: 0, createdAt: U.nowStamp(),
      };
      var before = XJ.calc.txOf(S.state, S.acc(), symbol).filter(function (t) { return t.txId !== '__preview__'; });
      var after = XJ.calc.position(before.concat([previewTx]), null, h.costMethod, h.receivedTotal);
      text = '将补记：' + (p.action === 'BUY' ? '买入' : '卖出') + ' ' + U.thousands(p.qty) + ' 股 @ ' +
        cs + U.money(p.price, 4) + '（金额 ' + cs + U.money(p.amount, 2) + '，日期 ' + U.today() + '）' +
        '<br>调整后：' + U.thousands(after.qty) + ' 股 · 每股成本 ' + cs + U.money(after.avgCost, 4);
    }
    box.innerHTML = UI.icon('info', 13) + '<span>' + text + '</span>';
  }

  UI.on('editQty', function (node) { showQtyEditor(node.getAttribute('data-symbol')); });

  UI.on('qtyPreview', function (node) {
    var sheet = node.closest('.sheet');
    if (sheet) updateQtyPreview(sheet, sheetSymbol(sheet));
  });

  UI.on('saveQty', function (node) {
    var symbol = node.getAttribute('data-symbol');
    var sheet = node.closest('.sheet');
    var p = qtyRowPlan(sheet, symbol);
    if (!p) return UI.toast('找不到该持仓');
    if (p.err) return UI.toast(p.err);

    var tx = {
      txId: U.uid('tx'),
      accountId: S.acc() === XJ.calc.ALL ? S.state.settings.defaultAccountId : S.acc(),
      symbol: symbol,
      action: p.action,
      date: U.today(),
      quantity: p.qty,
      price: p.price,
      fee: 0,
      note: '持仓数量调整',
      createdAt: U.nowStamp(),
    };
    S.commit(function (s) { s.transactions.push(tx); });
    UI.closeSheet();
    UI.toast('已补记一笔' + (p.action === 'BUY' ? '买入' : '卖出') + '，持仓数量已更新');
  });

  /** 改成本：不动股数，补一笔「成本调整」记录（signed amount） */
  function showCostEditor(symbol) {
    var h = XJ.calc.holdings(S.state, S.acc()).filter(function (x) { return x.symbol === symbol; })[0];
    if (!h) return UI.toast('当前账户下没有该标的的持仓');

    /* 同 showQtyEditor：这一屏的金额都是【原币】的每股成本/成本合计，币种符号要跟着标的走 */
    var cs = U.esc(h.curSymbol);
    var unit = h.currency === 'CNY' ? '元' : h.currency;
    var html =
      '<div class="field"><label>当前持仓与成本</label>' +
      '<div class="kv" style="padding:0"><span class="k">' + U.thousands(h.qty) + ' 股</span>' +
      '<span class="v">均价 ' + cs + U.money(h.avgCost, 4) + ' · 合计 ' + cs + U.money(h.costValue, 2) + '</span></div></div>' +
      '<div class="field"><label>修改为（每股成本，' + U.esc(unit) + '）</label>' +
      '<input type="text" inputmode="decimal" data-k="avg" data-input="costPreview" value="' + U.esc(U.money(h.avgCost, 4)) + '"></div>' +
      '<div id="xj-cost-preview" class="note-line" style="margin:4px 0 12px">' +
      UI.icon('info', 13) + '<span>输入目标成本后查看将要补记的调整金额</span></div>' +
      accountHint() +
      '<button class="btn-block" data-act="saveCost" data-symbol="' + U.esc(symbol) + '">保存</button>' +
      '<div class="tiny" style="margin-top:10px;line-height:1.7">' +
      '成本调整只改变成本基础，不改变持股数量；它会以「成本调整」记录出现在交易明细里，可随时删除。' +
      '</div>';

    UI.openSheet({
      title: '修改当前成本',
      html: html,
      onMount: function (sheet) { updateCostPreview(sheet, symbol); },
    });
  }

  function costAdjustPlan(sheet, symbol) {
    var h = XJ.calc.holdings(S.state, S.acc()).filter(function (x) { return x.symbol === symbol; })[0];
    if (!h) return null;
    var target = U.num(UI.readFields(sheet).avg);
    if (target === null) return { err: '请输入目标成本' };
    /* 输入框只显示 4 位小数，真实均价可能还有更多位。
       若「输入值」与「界面显示的均价」四舍五入到 4 位后相同，就认为没有改动，
       免得打开弹层就提示「补记 -¥0.01」，看着像有变化其实没有。 */
    var shown = Math.round(h.avgCost * 10000) / 10000;
    if (Math.round(target * 10000) / 10000 === shown) return { err: '成本没有变化' };
    /* 摊薄口径的成本 = 净投入 ÷ 股数，改均价等价于改净投入 */
    var basis = h.costMethod === 'weighted' ? h.qty * h.avgCost : h.costValue;
    var amount = Math.round((target * h.qty - basis) * 100) / 100;
    if (Math.abs(amount) < 0.01) return { err: '成本没有变化' };
    return { amount: amount, target: target, basis: basis };
  }

  function updateCostPreview(sheet, symbol) {
    var box = sheet.querySelector('#xj-cost-preview');
    if (!box) return;
    var p = costAdjustPlan(sheet, symbol);
    /* 成本调整的金额是【原币】口径（改的就是每股成本，港股即港元），所以用币种符号而非 ¥ */
    var h0 = XJ.calc.holdings(S.state, S.acc()).filter(function (x) { return x.symbol === symbol; })[0];
    var cs = U.esc(h0 ? h0.curSymbol : '¥');
    var text = !p ? '找不到该持仓'
      : p.err ? p.err
        : '将补记一笔成本调整：' + (p.amount > 0 ? '+' : '−') + cs + U.money(Math.abs(p.amount), 2) +
          '（成本合计 ' + cs + U.money(p.basis, 2) + ' → ' + cs + U.money(p.basis + p.amount, 2) + '）';
    box.innerHTML = UI.icon('info', 13) + '<span>' + text + '</span>';
  }

  UI.on('editCost', function (node) { showCostEditor(node.getAttribute('data-symbol')); });

  UI.on('costPreview', function (node) {
    var sheet = node.closest('.sheet');
    if (sheet) updateCostPreview(sheet, sheetSymbol(sheet));
  });

  UI.on('saveCost', function (node) {
    var symbol = node.getAttribute('data-symbol');
    var sheet = node.closest('.sheet');
    var p = costAdjustPlan(sheet, symbol);
    if (!p) return UI.toast('找不到该持仓');
    if (p.err) return UI.toast(p.err);

    var tx = {
      txId: U.uid('tx'),
      accountId: S.acc() === XJ.calc.ALL ? S.state.settings.defaultAccountId : S.acc(),
      symbol: symbol,
      action: 'ADJUST',
      date: U.today(),
      amount: p.amount,
      note: '成本调整至 ' + U.money(p.target, 4) + ' / 股',
      createdAt: U.nowStamp(),
    };
    var errs = M.validateTransaction(tx);
    if (errs.length) return UI.toast(errs[0]);

    S.commit(function (s) { s.transactions.push(tx); });
    UI.closeSheet();
    UI.toast('已补记成本调整 ' + U.signMoney(p.amount));
  });

  UI.on('openTxEditor', function (node) {
    showTxEditor(node.getAttribute('data-id'), node.getAttribute('data-symbol'));
  });

  UI.on('addTxFor', function (node) {
    var sym = node.getAttribute('data-symbol');
    UI.closeSheet();
    setTimeout(function () { showTxEditor(null, sym); }, 200);
  });

  UI.on('saveTx', function (node) {
    var id = node.getAttribute('data-id');
    var sheet = node.closest('.sheet');
    var f = UI.readFields(sheet);

    /* 成本调整分支：只带金额 */
    if (node.getAttribute('data-adjust')) {
      var old = S.state.transactions.filter(function (t) { return t.txId === id; })[0];
      if (!old) return UI.toast('记录不存在');
      var adj = Object.assign({}, old, {
        amount: U.num(f.amount),
        date: f.date || old.date,
        note: f.note || '',
      });
      var aerrs = M.validateTransaction(adj);
      if (aerrs.length) return UI.toast(aerrs[0]);
      S.commit(function (s) {
        var i = s.transactions.findIndex(function (t) { return t.txId === id; });
        if (i >= 0) s.transactions[i] = adj;
      });
      UI.closeSheet();
      UI.toast('已保存');
      return;
    }

    var sym = M.normalizeSymbol(f.code);
    if (!sym) return UI.toast('股票代码格式不正确');

    var tx = {
      txId: id || U.uid('tx'),
      accountId: f.accountId,
      symbol: sym,
      action: f.action === 'SELL' ? 'SELL' : 'BUY',
      date: f.date || U.today(),
      quantity: U.num(f.quantity),
      price: U.num(f.price),
      fee: U.n0(f.fee),
      note: f.note || '',
      createdAt: U.nowStamp(),
    };
    var errs = M.validateTransaction(tx);
    if (errs.length) return UI.toast(errs[0]);

    // 卖出数量不得超过当前持仓
    if (tx.action === 'SELL') {
      var existing = S.state.transactions.filter(function (t) {
        return t.accountId === tx.accountId && t.symbol === sym && t.txId !== tx.txId;
      });
      var pos = C.position(existing);
      if (U.n0(tx.quantity) > pos.qty + 1e-6) {
        return UI.toast('卖出数量超过当前持仓 ' + U.thousands(pos.qty) + ' 股');
      }
    }

    S.commit(function (s) {
      var i = s.transactions.findIndex(function (t) { return t.txId === tx.txId; });
      if (i >= 0) s.transactions[i] = tx; else s.transactions.push(tx);
      if (!s.symbols[sym]) s.symbols[sym] = M.symbolRecord(sym, { name: M.codeOf(sym) });
    });
    UI.closeSheet();
    UI.toast('已保存');
    if (!S.state.quoteCache[sym]) {
      XJ.fetcher.fetchQuotes([sym]).then(function (q) {
        if (S.mergeQuotes(q)) S.commitNow(null);
      });
    }
    pullPlansFor(sym);
  });

  UI.on('deleteTx', function (node) {
    var id = node.getAttribute('data-id');
    UI.confirm({ title: '删除交易', message: '确定删除这笔交易记录吗？相关持仓与成本会一并重算。', confirmText: '删除', danger: true })
      .then(function (ok) {
        if (!ok) return;
        S.commit(function (s) {
          s.transactions = s.transactions.filter(function (t) { return t.txId !== id; });
          s.received = s.received.filter(function (r) { return r.source !== 'AUTO'; });
          C.applyAutoReceived(s);
        });
        UI.closeSheet();
        UI.toast('已删除');
      });
  });

  /* ---- 账户 ---- */
  UI.on('openAccountEditor', function (node) {
    var id = node.getAttribute('data-id');
    var acc = id ? S.state.accounts.filter(function (a) { return a.accountId === id; })[0] : null;
    var html =
      UI.field('账户名称', UI.inputHtml('name', acc ? acc.name : '', { placeholder: '如 东财证券 / 家人账户' })) +
      UI.field('类型', '<select data-k="type">' +
        '<option value="BROKER"' + (acc && acc.type === 'BROKER' ? ' selected' : '') + '>券商账户</option>' +
        '<option value="FAMILY"' + (acc && acc.type === 'FAMILY' ? ' selected' : '') + '>家人账户</option>' +
        '<option value="OTHER"' + (acc && acc.type === 'OTHER' ? ' selected' : '') + '>其他</option>' +
        '</select>') +
      '<label class="switch tiny" style="margin:6px 0 14px"><input type="checkbox" data-k="isDefault"' +
      (acc && acc.accountId === S.state.settings.defaultAccountId ? ' checked' : '') + '> 设为默认账户</label>' +
      '<button class="btn-block" data-act="saveAccount" data-id="' + U.esc(id || '') + '">' + (acc ? '保存' : '创建账户') + '</button>' +
      (acc && S.state.accounts.length > 1
        ? '<button class="btn-block danger" data-act="deleteAccount" data-id="' + U.esc(id) + '">删除账户</button>'
        : '');
    UI.openSheet({ title: acc ? '编辑账户' : '新建账户', html: html });
  });

  UI.on('saveAccount', function (node) {
    var id = node.getAttribute('data-id');
    var sheet = node.closest('.sheet');
    var f = UI.readFields(sheet);
    if (!f.name || !String(f.name).trim()) return UI.toast('账户名称不能为空');
    var isDefault = !!sheet.querySelector('[data-k="isDefault"]').checked;

    S.commit(function (s) {
      var acc = id ? s.accounts.filter(function (a) { return a.accountId === id; })[0] : null;
      if (acc) { acc.name = String(f.name).trim(); acc.type = f.type; }
      else {
        acc = {
          accountId: U.uid('acc'), name: String(f.name).trim(), type: f.type,
          sortOrder: s.accounts.length + 1, createdAt: U.nowStamp(),
        };
        s.accounts.push(acc);
      }
      if (isDefault) s.settings.defaultAccountId = acc.accountId;
    });
    UI.closeSheet();
    UI.toast('已保存');
  });

  UI.on('deleteAccount', function (node) {
    var id = node.getAttribute('data-id');
    var cnt = S.state.transactions.filter(function (t) { return t.accountId === id; }).length;
    UI.confirm({
      title: '删除账户',
      message: '该账户下有 ' + cnt + ' 笔交易记录，删除后这些记录也会一并移除，且不可恢复。',
      confirmText: '确认删除', danger: true,
    }).then(function (ok) {
      if (!ok) return;
      S.commit(function (s) {
        s.accounts = s.accounts.filter(function (a) { return a.accountId !== id; });
        s.transactions = s.transactions.filter(function (t) { return t.accountId !== id; });
        s.received = s.received.filter(function (r) { return r.accountId !== id; });
        if (s.settings.defaultAccountId === id) s.settings.defaultAccountId = s.accounts[0] ? s.accounts[0].accountId : null;
      });
      if (S.ui.accountId === id) S.setUI({ accountId: C.ALL });
      UI.closeSheet();
      UI.toast('已删除账户');
    });
  });

  /* ---- 支出项 ---- */
  UI.on('openExpenses', function () {
    var list = S.state.expenses.slice().sort(function (a, b) { return a.sortOrder - b.sortOrder; });
    var html = list.map(function (e) {
      return UI.field(e.label + '（元/月）',
        '<input type="text" inputmode="decimal" data-k="exp_' + e.key + '" value="' + U.n0(e.monthlyAmount) + '">');
    }).join('') +
      '<button class="btn-block" data-act="saveExpenses">保存</button>' +
      '<button class="btn-block ghost" data-act="addExpense">+ 新增支出项</button>' +
      '<div class="tiny" style="margin-top:10px">息覆生活按「年支出 = 月支出 × 12」计算，并按金额从小到大依次点亮。' +
      '点击首页覆盖卡片上的任一图标也可单独编辑或删除。</div>';
    UI.openSheet({ title: '息覆生活 · 支出项设置', html: html });
  });

  /** 支出项编辑表单（含分类 emoji 图标选择器 + 生存/品质分类） */
  function expenseFormHtml(e) {
    var groups = M.EMOJI_GROUPS || [];
    var cat = e.category === 'quality' ? 'quality' : 'essential';
    return '' +
      '<div class="field"><label>分类（FIRE 视图三档分母）</label>' +
      '<div class="segmented" style="width:100%">' +
      '<button type="button" data-act="setExpenseCategory" data-v="essential" class="xp-cat' + (cat === 'essential' ? ' active' : '') + '" style="flex:1">🛡 生存支出</button>' +
      '<button type="button" data-act="setExpenseCategory" data-v="quality" class="xp-cat' + (cat === 'quality' ? ' active' : '') + '" style="flex:1">✨ 品质支出</button>' +
      '</div>' +
      '<input type="hidden" data-k="category" value="' + cat + '">' +
      '<div class="tiny" style="margin-top:6px">生存支出计入 Lean FIRE；品质支出只计入 Regular / Fat。</div>' +
      '</div>' +
      '<div class="field"><label>图标</label>' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
      '<span id="xj-icon-preview" style="width:44px;height:44px;border-radius:12px;background:var(--dividend-soft);' +
      'display:flex;align-items:center;justify-content:center;font-size:24px;flex:0 0 auto">' +
      U.esc(e.icon || '🏷️') + '</span>' +
      '<span class="tiny">点下方任意图标即可更换；选中后会自动记住，不会再被系统覆盖。</span></div>' +
      '<div class="emoji-pick">' +
      groups.map(function (g) {
        return '<div class="emoji-group"><div class="emoji-gname">' + U.esc(g.name) + '</div>' +
          '<div class="emoji-row">' + g.list.map(function (ic) {
            return '<button type="button" class="emoji-btn' + (ic === e.icon ? ' active' : '') +
              '" data-act="pickExpenseIcon" data-icon="' + U.esc(ic) + '">' + ic + '</button>';
          }).join('') + '</div></div>';
      }).join('') +
      '</div>' +
      '<input type="hidden" data-k="icon" value="' + U.esc(e.icon || '🏷️') + '">' +
      '</div>' +
      UI.field('名称', UI.inputHtml('label', e.label)) +
      UI.field('每月支出（元）', UI.inputHtml('monthlyAmount', U.n0(e.monthlyAmount), { inputmode: 'decimal' })) +
      '<label class="switch tiny" style="margin:6px 0 14px"><input type="checkbox" data-k="enabled"' +
      (e.enabled ? ' checked' : '') + '> 参与覆盖计算</label>' +
      '<button class="btn-block" data-act="saveExpenseEditor" data-key="' + U.esc(e.key) + '">保存</button>' +
      '<button class="btn-block danger" data-act="deleteExpense" data-key="' + U.esc(e.key) + '">删除该支出项</button>';
  }

  UI.on('pickExpenseIcon', function (node) {
    var sheet = node.closest('.sheet');
    if (!sheet) return;
    var ic = node.getAttribute('data-icon');
    Array.prototype.forEach.call(sheet.querySelectorAll('.emoji-btn.active'), function (b) {
      b.classList.remove('active');
    });
    node.classList.add('active');
    var inp = sheet.querySelector('[data-k="icon"]');
    if (inp) inp.value = ic;
    var prev = sheet.querySelector('#xj-icon-preview');
    if (prev) prev.textContent = ic;
  });

  /* 编辑器内切换生存/品质分类（纯表单状态，保存时落库） */
  UI.on('setExpenseCategory', function (node) {
    var sheet = node.closest('.sheet');
    if (!sheet) return;
    var v = node.getAttribute('data-v');
    Array.prototype.forEach.call(sheet.querySelectorAll('.xp-cat.active'), function (b) {
      b.classList.remove('active');
    });
    node.classList.add('active');
    var inp = sheet.querySelector('[data-k="category"]');
    if (inp) inp.value = v;
  });

  UI.on('openExpenseEditor', function (node) {
    var key = node.getAttribute('data-key');
    var e = S.state.expenses.filter(function (x) { return x.key === key; })[0];
    if (!e) return;
    var html =
      expenseFormHtml(e);
    UI.openSheet({ title: '编辑支出项', html: html });
  });

  UI.on('deleteExpense', function (node) {
    var key = node.getAttribute('data-key');
    var e = S.state.expenses.filter(function (x) { return x.key === key; })[0];
    if (!e) return;
    if (S.state.expenses.length <= 1) return UI.toast('至少保留 1 个支出项');
    UI.confirm({
      title: '删除支出项',
      message: '删除「' + e.label + '」后，它不再参与分红覆盖计算。',
      confirmText: '删除', danger: true,
    }).then(function (ok) {
      if (!ok) return;
      S.commit(function (s) { s.expenses = s.expenses.filter(function (x) { return x.key !== key; }); });
      UI.closeSheet();
      UI.toast('已删除');
    });
  });

  UI.on('addExpense', function () {
    var key = 'CUSTOM' + Date.now().toString(36).toUpperCase();
    var order = S.state.expenses.length + 1;
    S.commit(function (s) {
      s.expenses.push({
        expenseId: 'exp_' + key.toLowerCase(), key: key, label: '新支出项', icon: '💰',
        monthlyAmount: 100, enabled: true, sortOrder: order, category: 'essential',
      });
    });
    UI.closeSheet();
    setTimeout(function () { showExpenseEditor(key); }, 160);
  });

  function showExpenseEditor(key) {
    var e = S.state.expenses.filter(function (x) { return x.key === key; })[0];
    if (!e) return;
    var html =
      expenseFormHtml(e);
    UI.openSheet({ title: '新增支出项', html: html });
  }

  UI.on('saveExpenseEditor', function (node) {
    var key = node.getAttribute('data-key');
    var sheet = node.closest('.sheet');
    var f = UI.readFields(sheet);
    var en = !!sheet.querySelector('[data-k="enabled"]').checked;
    S.commit(function (s) {
      s.expenses.forEach(function (e) {
        if (e.key !== key) return;
        e.label = String(f.label || e.label).trim() || e.label;
        e.icon = String(f.icon || e.icon || '🏷️').trim().slice(0, 4) || '🏷️';
        e.iconAuto = false;          // 用户确认过图标 → 不再被自动修正覆盖
        e.monthlyAmount = Math.max(0, U.n0(f.monthlyAmount));
        e.enabled = en;
        e.category = (f.category === 'quality') ? 'quality' : 'essential';
      });
    });
    UI.closeSheet();
    UI.toast('已保存');
  });

  UI.on('saveExpenses', function (node) {
    var sheet = node.closest('.sheet');
    var f = UI.readFields(sheet);
    S.commit(function (s) {
      s.expenses.forEach(function (e) {
        var v = f['exp_' + e.key];
        if (v !== undefined) e.monthlyAmount = Math.max(0, U.n0(v));
      });
    });
    UI.closeSheet();
    UI.toast('已保存');
  });

  /* ==================== FIRE 视图动作 ====================
   * ★ 滑杆联动是「局部更新」：input（高频）绝不走 S.setUI/S.commit——
   *   全量重渲染会让拖动卡顿；input 只就地改大数字/提示行 DOM（rAF 节流），
   *   change（松手）才 commit 持久化并整页刷新一次（覆盖率曲线等统一更新）。 */
  var fireRAF = null;

  /** 用一个「滑杆临时值」构造 fireCfg（不碰 state，纯读） */
  function fireCfgWithOverride(k, v) {
    var fire = S.state.settings.fire;
    var tier = fire.activeTier;
    var f2 = Object.assign({}, fire);
    if (k === 'reinvest') { f2.reinvestPct = v; return C.fireCfg(S.state, S.acc(), tier, f2); }
    var sim = Object.assign({}, fire.tierSims[tier]);
    if (k === 'monthlySpend') sim.monthlySpend = v;
    else if (k === 'drip') sim.drip = v;
    else if (k === 'dripYieldPct') sim.dripYieldPct = v;
    var sims = Object.assign({}, fire.tierSims);
    sims[tier] = sim;
    return C.fireCfg(S.state, S.acc(), tier, Object.assign({}, fire, { tierSims: sims }));
  }

  function fireTierName(tier) {
    return tier === 'lean' ? 'Lean FIRE' : tier === 'fat' ? 'Fat FIRE' : 'Regular FIRE';
  }

  function fireMonthsText(months) {
    if (months === null || months === undefined) return '—';
    if (months <= 0) return '已达成';
    var y = Math.floor(months / 12);
    var m = Math.round(months - y * 12);
    if (m === 12) { y += 1; m = 0; }
    if (y <= 0) return m + ' 个月';
    if (m <= 0) return y + ' 年';
    return y + ' 年 ' + m + ' 个月';
  }

  function fireBigText(tl) {
    if (!tl.solvable) return '—';
    if (tl.reached) return '已达成';
    var ym = tl.date || U.ymOf(U.today());
    return Number(ym.slice(0, 4)) + ' 年 ' + Number(ym.slice(5, 7)) + ' 月';
  }

  function fireSubText(tl) {
    if (!tl.solvable) {
      return tl.reason === 'beyond-limit' ? '按当前参数 50 年内无法达成' : '投入与息率不足以增长——请调高攒股金额或息率';
    }
    if (tl.reached) return '🎉 当前被动收入已覆盖目标支出';
    var startYear = Number(U.ymOf(U.today()).slice(0, 4));
    var endYear = startYear + Math.ceil(tl.months / 12);
    return '预计 ' + endYear + '–' + (endYear + 1) + ' 年间达成';
  }

  /** 就地刷新大数字 / 副行 / 提示行（滑杆 input 高频路径） */
  function firePatchDom(cfg) {
    var tl = C.fireTimeline(S.state, S.acc(), cfg);
    var big = document.getElementById('fire-big-num');
    var sub = document.getElementById('fire-big-sub');
    var tip = document.getElementById('fire-tip-line');
    var txt = fireBigText(tl);
    if (big) {
      if (big.textContent !== txt) {
        big.classList.add('blur');
        void big.offsetWidth;                      // 强制 reflow，让 blur→clear 过渡触发
        big.textContent = txt;
        requestAnimationFrame(function () { big.classList.remove('blur'); });
      }
    }
    if (sub) sub.textContent = fireSubText(tl);
    if (tip) {
      var base = C.fireTimeline(S.state, S.acc(), C.fireCfg(S.state, S.acc(), S.state.settings.fire.activeTier,
        { yieldBasis: S.state.settings.fire.yieldBasis, reinvestPct: S.state.settings.fire.reinvestPct,
          tierSims: { lean: {}, regular: {}, fat: {} } }));
      var seg = '';
      if (tl.solvable && base.solvable && !tl.reached && !base.reached && tl.months !== base.months) {
        var d = base.months - tl.months;           // 正 = 提前
        seg = (d >= 0 ? '自由日提前 ' : '自由日推后 ') + fireMonthsText(Math.abs(d)) + ' · ';
      }
      var t = S.state.settings.fire.activeTier;
      var cap4 = C.fireTargets(S.state, S.acc(), S.state.settings.fire.yieldBasis);
      var cap = cap4.tiers[t] ? cap4.tiers[t].capitalAt4 : 0;
      tip.textContent = seg + '完全覆盖约需 ' + U.moneySign(cap, 0) + ' 生息资产（按 4% 法则）';
    }
    return tl;
  }

  UI.on('fireSliderInput', function (node) {
    if (fireRAF) return;
    fireRAF = requestAnimationFrame(function () {
      fireRAF = null;
      var k = node.getAttribute('data-k');
      var v = Number(node.value);
      /* 数值回显与滑杆填充（就地） */
      var val = document.getElementById('fs-val-' + k);
      if (val) {
        if (k === 'monthlySpend') {
          val.textContent = S.ui.fireSpendMode === 'day'
            ? '¥' + (v / C.FIRE.daysPerMonth).toFixed(2) + '/日'
            : U.moneySign(v, 0);
        } else if (k === 'drip') {
          val.textContent = U.moneySign(v, 0);
        } else if (k === 'reinvest') {
          val.textContent = U.pct(v, 0);
        } else {
          val.textContent = U.pct(v, 1);
        }
      }
      node.style.setProperty('--p', ((v - Number(node.min)) / (Number(node.max) - Number(node.min)) * 100) + '%');
      firePatchDom(fireCfgWithOverride(k, v));
    });
  });

  UI.on('fireSliderCommit', function (node) {
    var k = node.getAttribute('data-k');
    var v = Number(node.value);
    if (k === 'reinvest') {
      S.commit(function (s) { s.settings.fire.reinvestPct = v; });
      return;
    }
    var tier = S.state.settings.fire.activeTier;
    S.commit(function (s) {
      var sim = s.settings.fire.tierSims[tier];
      if (k === 'monthlySpend') sim.monthlySpend = v;
      else if (k === 'drip') sim.drip = v;
      else if (k === 'dripYieldPct') sim.dripYieldPct = v;
    });
  });

  UI.on('setFireTier', function (node) {
    var v = node.getAttribute('data-v');
    if (v === S.state.settings.fire.activeTier) return;
    S.commit(function (s) {
      s.settings.fire.activeTier = v;
      /* ★ 切档时每月花费强制同步为该档真实台账支出（置 null = 跟随台账），
         不保留上一档的手动模拟值；每月攒股与息率仍各自记忆。 */
      s.settings.fire.tierSims[v].monthlySpend = null;
    });   // 整页重渲染：滑杆回该档真实支出
  });

  UI.on('setFireYieldBasis', function (node) {
    var v = node.getAttribute('data-v') === 'cost' ? 'cost' : 'market';
    if (v === S.state.settings.fire.yieldBasis) return;
    S.commit(function (s) { s.settings.fire.yieldBasis = v; });   // fireNumber/默认息率/显示口径联动
  });

  UI.on('fireSpendMode', function (node) {
    S.setUI({ fireSpendMode: node.getAttribute('data-v') === 'day' ? 'day' : 'month' });
  });

  UI.on('fireReset', function () {
    var tier = S.state.settings.fire.activeTier;
    S.commit(function (s) {
      s.settings.fire.tierSims[tier] = { monthlySpend: null, drip: 5000, dripYieldPct: null };
    });
    UI.toast('已重置为当前真实值');
  });

  /* ---- FIRE 曲线时间尺度（FI 进度七档 / 覆盖率五档，自定义弹起止） ---- */
  var FIRE_PR_RANGES = ['today', '1m', '3m', '6m', 'ytd', 'all'];
  var FIRE_COV_RANGES = ['3m', '6m', 'ytd', 'all'];

  UI.on('setFirePrRange', function (node) {
    var v = node.getAttribute('data-v');
    if (FIRE_PR_RANGES.indexOf(v) >= 0) {
      S.setUI({ firePrRange: v, firePrBeg: null, firePrEnd: null });
    } else if (v === 'custom') {
      var html =
        UI.field('开始日期', UI.inputHtml('beg', S.ui.firePrBeg || '', { type: 'date' })) +
        UI.field('结束日期', UI.inputHtml('end', S.ui.firePrEnd || '', { type: 'date' })) +
        '<button class="btn-block" data-act="setFirePrCustom">应用区间</button>';
      UI.openSheet({ title: '自定义时间区间', html: html });
    }
  });

  UI.on('setFirePrCustom', function (node) {
    var f = UI.readFields(node.closest('.sheet'));
    var beg = String(f.beg || '').slice(0, 10);
    var end = String(f.end || '').slice(0, 10);
    if (!beg || !end || beg > end) return UI.toast('请填写有效的起止日期');
    UI.closeSheet();
    S.setUI({ firePrRange: 'custom', firePrBeg: beg, firePrEnd: end });
  });

  UI.on('setFireCovRange', function (node) {
    var v = node.getAttribute('data-v');
    if (FIRE_COV_RANGES.indexOf(v) >= 0) {
      S.setUI({ fireCovRange: v, fireCovBeg: null, fireCovEnd: null });
    } else if (v === 'custom') {
      var html2 =
        UI.field('开始月份', UI.inputHtml('beg', S.ui.fireCovBeg || '', { type: 'month' })) +
        UI.field('结束月份（外推段始终显示）', UI.inputHtml('end', S.ui.fireCovEnd || '', { type: 'month' })) +
        '<button class="btn-block" data-act="setFireCovCustom">应用区间</button>';
      UI.openSheet({ title: '自定义月份区间', html: html2 });
    }
  });

  UI.on('setFireCovCustom', function (node) {
    var f = UI.readFields(node.closest('.sheet'));
    var beg = String(f.beg || '').slice(0, 7);
    var end = String(f.end || '').slice(0, 7);
    if (!beg || (end && beg > end)) return UI.toast('请填写有效的起始月份');
    UI.closeSheet();
    S.setUI({ fireCovRange: 'custom', fireCovBeg: beg, fireCovEnd: end });
  });

  /* ---- 展望参数 ---- */
  UI.on('setProjection', function (node) {
    var key = node.getAttribute('data-k');
    var v = U.num(node.value);
    if (v === null) return;
    if (key === 'years') v = U.clamp(Math.round(v), 1, 50);
    if (key === 'monthlyInvest') v = Math.max(0, v);
    S.commit(function (s) { s.projection[key] = v; });
  });

  UI.on('setReinvest', function (node) {
    var v = U.num(node.getAttribute('data-v'));
    S.commit(function (s) { s.projection.reinvestRatio = v === null ? 1 : v; });
  });

  /* ---- 导入导出 ---- */
  UI.on('exportJson', function () {
    var data = M.toExport(S.state, '自由数据备份');
    var ts = U.today() + '_' + new Date().toTimeString().slice(0, 5).replace(':', '');
    U.download('自由数据_' + ts + '.json', JSON.stringify(data, null, 2), 'application/json');
    UI.toast('已导出 JSON 备份');
  });

  UI.on('importJson', function () {
    pickFile('.json,application/json').then(function (text) {
      if (!text) return;
      var raw;
      try { raw = JSON.parse(text); } catch (e) { return UI.toast('文件不是有效的 JSON'); }
      return UI.confirm({
        title: '导入数据',
        message: '导入将覆盖本机当前的全部数据（账户、持仓、交易、分红记录）。确定继续吗？',
        confirmText: '覆盖导入', danger: true,
      }).then(function (ok) {
        if (!ok) return;
        var next;
        try { next = M.fromImport(raw); } catch (e) { return UI.toast('导入失败：' + e.message); }
        S.init(next);
        S.ui.accountId = C.ALL;
        S.commitNow(null);
        UI.toast('导入成功：' + next.transactions.length + ' 笔交易');
        refreshAll({ silent: true });
      });
    });
  });

  UI.on('exportCsvTx', function () {
    if (!S.state.transactions.length) return UI.toast('暂无交易记录');
    U.download('自由交易流水_' + U.today() + '.csv', M.transactionsCsv(S.state), 'text/csv');
    UI.toast('已导出交易流水');
  });

  UI.on('exportCsvRec', function () {
    if (!S.state.received.length) return UI.toast('暂无分红到账记录');
    U.download('自由分红台账_' + U.today() + '.csv', M.receivedCsv(S.state), 'text/csv');
    UI.toast('已导出分红台账');
  });

  UI.on('clearData', function () {
    UI.confirm({
      title: '清空本地数据',
      html: '将删除本机保存的<b>全部</b>账户、持仓、交易与分红记录，且无法恢复。<br><br>建议先「导出全部数据（JSON）」做备份。',
      confirmText: '我已备份，清空', danger: true,
    }).then(function (ok) {
      if (!ok) return;
      /* ★ 架构预留：将来接回同步层时，这里要恢复「keepSync」逻辑——
         同步连接信息（deviceId / token / gistId / 修订账本 / 墓碑）必须跨清空保留，
         否则下一次同步会把云端已有的一切当成「本机新增」整份推回去，或反过来当成删除。 */
      XJ.storage.clear().then(function () {
        var fresh = M.ensureBootstrapped(M.defaultState());
        S.init(fresh);
        S.ui.accountId = C.ALL;
        S.commitNow(null);
        UI.toast('已清空');
      });
    });
  });

  /* ---- 提醒 ---- */
  UI.on('openReminderSetting', function () {
    var html =
      UI.field('提前提醒天数', UI.inputHtml('days', U.n0(S.state.settings.reminderLeadDays), { inputmode: 'numeric' })) +
      '<button class="btn-block" data-act="saveReminderSetting">保存</button>' +
      '<div class="tiny" style="margin-top:10px">以 file:// 方式打开时浏览器不支持系统级推送，提醒仅在页面打开时以顶部横幅与提示条呈现。</div>';
    UI.openSheet({ title: '分红提前提醒', html: html });
  });

  UI.on('saveReminderSetting', function (node) {
    var f = UI.readFields(node.closest('.sheet'));
    var d = U.clamp(Math.round(U.n0(f.days)), 0, 30);
    S.commit(function (s) { s.settings.reminderLeadDays = d; });
    UI.closeSheet();
    UI.toast('已设置为提前 ' + d + ' 天');
  });

  UI.on('checkReminders', function () {
    var today = U.today();
    var lead = U.n0(S.state.settings.reminderLeadDays);
    var ups = C.upcomingPayouts(S.state, S.acc(), today);
    var soon = ups.filter(function (e) { return U.daysBetween(today, e.date) <= lead; });

    var html;
    if (!ups.length) {
      html = '<div class="tiny" style="text-align:center;padding:16px 0">暂无待收分红。</div>';
    } else {
      html = soon.length
        ? '<div class="tiny" style="margin-bottom:10px">以下 ' + soon.length + ' 笔在提醒窗口内（提前 ' + lead + ' 天）：</div>'
        : '<div class="tiny" style="margin-bottom:10px">提醒窗口内暂无；以下是全部待收分红：</div>';
      var list = soon.length ? soon : ups.slice(0, 12);
      html += '<div class="list" style="box-shadow:none">' + list.map(function (e) {
        var d = U.daysBetween(today, e.date);
        return '<div class="list-row">' +
          UI.avatar(e.name, e.symbol) +
          '<div class="row-main"><div class="row-t">' + U.esc(e.name) + '</div>' +
          '<div class="row-s">' + e.date + ' · ' + (d === 0 ? '今天' : d + ' 天后') + ' · ' + U.thousands(e.qty) + ' 股</div></div>' +
          '<div class="row-right"><div class="row-v c-div">' + U.moneySign(e.amount) + '</div></div>' +
          '</div>';
      }).join('') + '</div>';
    }
    UI.openSheet({ title: '待收分红提醒', html: html });
  });

  /* ---------------- 跨设备搬运 ----------------
   * 手机 ↔ 平板 ↔ 电脑之间搬数据，不引入任何后端：
   * 把精简后的 state 编成一段「XJ1…」文本或链接，用微信/QQ/备忘录传过去，在另一台设备导入。
   * 编解码与合并去重都在 src/transfer.js（纯函数，verify 里有完整往返断言）。 */

  var XFER_SNAPSHOTS = false;   // 是否连每日快照一起搬（体积大，默认不带）

  function transferPayload() {
    return XJ.transfer.slimState(S.state, { withSnapshots: XFER_SNAPSHOTS });
  }

  function transferHint(encoded) {
    var n = String(encoded || '').length;
    var tips = '长度 ' + n + ' 字符';
    if (n > 1500) {
      tips += ' · 较长，建议用「文本」通过微信/QQ 发送，链接可能被截断';
    }
    return tips;
  }

  function showTransferSheet() {
    var sum = XJ.transfer.summarize(transferPayload());
    var html =
      '<div class="tiny" style="line-height:1.7;margin-bottom:12px">' +
      '把数据编码成一段文本或链接，通过<strong>微信 / QQ / 备忘录</strong>发到另一台设备，' +
      '在那里打开或粘贴即可导入。<strong>不经过任何服务器</strong>，API Key 不会被带走。' +
      '</div>' +
      '<div class="card" style="box-shadow:none;background:var(--card-2);margin-bottom:12px;padding:12px 14px">' +
      '<div class="kv" style="padding:4px 0"><span class="k">将搬运</span><span class="v">' +
      sum.accounts + ' 个账户 · ' + sum.symbols + ' 只标的 · ' + sum.transactions + ' 笔交易</span></div>' +
      '<div class="kv" style="padding:4px 0"><span class="k">分红到账 / 支出项</span><span class="v">' +
      sum.received + ' 笔 / ' + sum.expenses + ' 项</span></div>' +
      '<div class="tiny" style="margin-top:6px">不含分红方案与行情缓存（到新设备会自动重新拉取）</div>' +
      '</div>' +
      '<label class="switch tiny" style="margin:0 0 12px"><input type="checkbox" data-input="xferSnapshots"' +
      (XFER_SNAPSHOTS ? ' checked' : '') + '> 一并搬运每日资产快照（体积较大，但新设备无法重建）</label>' +
      '<button class="btn-block" data-act="xferLink">生成导入链接</button>' +
      '<button class="btn-block ghost" data-act="xferText">生成导入文本</button>' +
      '<button class="btn-block ghost" data-act="xferRead">从剪贴板导入</button>' +
      /* 剪贴板读取在部分 iOS Safari / 非安全上下文下不可用，留一个粘贴框兜底 */
      '<div class="field" style="margin-top:12px"><label>或把另一台设备发来的搬运文本粘贴到这里</label>' +
      '<textarea id="xj-xfer-paste" rows="3" placeholder="XJ1g.… 或 XJ1p.…" ' +
      'style="width:100%;font-size:12px;font-family:var(--mono);padding:10px;border:1px solid var(--line);border-radius:11px"></textarea></div>' +
      '<button class="btn-block ghost" data-act="xferPaste">导入粘贴的文本</button>' +
      '<div id="xj-xfer-out" style="margin-top:12px"></div>';
    UI.openSheet({
      title: '跨设备搬运',
      html: html,
      onMount: function (sheet) { sheet.setAttribute('data-xfer', '1'); },
    });
  }

  /** 生成结果展示（链接 / 文本都会用到） */
  function showTransferOut(encoded, asLink) {
    var box = document.getElementById('xj-xfer-out');
    if (!box) return;
    var text = asLink ? XJ.transfer.buildImportUrl(location.href.split('#')[0], encoded) : encoded;
    box.innerHTML =
      '<div class="field"><label>' + (asLink ? '把这行链接发到另一台设备打开' : '把这段文本发到另一台设备，在「从剪贴板导入」里粘贴') + '</label>' +
      '<textarea readonly rows="4" style="width:100%;font-size:12px;font-family:var(--mono);padding:10px;border:1px solid var(--line);border-radius:11px">' +
      U.esc(text) + '</textarea>' +
      '<div class="tiny" style="margin-top:6px">' + U.esc(transferHint(encoded)) + '</div></div>' +
      '<button class="btn-block" data-act="xferCopy" data-text="' + U.esc(text) + '">复制</button>';
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { UI.toast('已复制'); })
        .catch(function () { UI.toast('复制失败，请长按选中后手动复制'); });
    }
    UI.toast('当前环境不支持自动复制，请长按选中后手动复制');
    return Promise.resolve();
  }

  /** 解析成功后的导入确认：先给摘要，再让用户选合并 / 覆盖 */
  function confirmImport(incoming) {
    var sum = XJ.transfer.summarize(incoming);
    var html =
      '<div class="tiny" style="line-height:1.7;margin-bottom:10px">将要导入：</div>' +
      '<div class="card" style="box-shadow:none;background:var(--card-2);margin-bottom:14px;padding:12px 14px">' +
      '<div class="kv" style="padding:4px 0"><span class="k">账户</span><span class="v">' + sum.accounts + ' 个</span></div>' +
      '<div class="kv" style="padding:4px 0"><span class="k">持仓标的</span><span class="v">' + sum.symbols + ' 只</span></div>' +
      '<div class="kv" style="padding:4px 0"><span class="k">交易记录</span><span class="v">' + sum.transactions + ' 笔</span></div>' +
      '<div class="kv" style="padding:4px 0"><span class="k">分红到账</span><span class="v">' + sum.received + ' 笔</span></div>' +
      '</div>' +
      '<button class="btn-block" data-act="xferDoMerge">合并导入（推荐，自动去重）</button>' +
      '<button class="btn-block danger" data-act="xferDoOverwrite">覆盖导入（清掉本机现有记录）</button>' +
      '<button class="btn-block ghost" data-act="closeSheet">取消</button>' +
      '<div class="tiny" style="margin-top:10px;line-height:1.7">' +
      '合并按主键去重：账户 accountId · 交易 txId · 到账 recId，同一笔不会重复；' +
      '覆盖会先用导入的内容替换本机的账户/持仓/交易/到账记录，请谨慎。' +
      '</div>';
    UI.openSheet({
      title: '确认导入',
      html: html,
      onMount: function () { pendingImport = incoming; },
    });
  }

  var pendingImport = null;

  function applyImport(mode) {
    var incoming = pendingImport;
    if (!incoming) return UI.toast('没有待导入的内容');
    /* 旧版本设备传来的数据先跑一次迁移：否则其 symbols 里显式的旧成本口径
       （costMethod='weighted'）会被原样保留 —— 本地 state 已是 v4，合并后不会再触发迁移。 */
    try {
      if (U.n0(incoming.version) < M.DATA_VERSION) M.ensureBootstrapped(incoming);
    } catch (e) { console.warn('[xfer] 迁移导入内容失败（不影响导入）', e); }
    var msg = '';
    S.commitNow(function (s) {
      if (mode === 'overwrite') {
        XJ.transfer.overwriteWith(s, incoming);
        msg = '已覆盖导入';
      } else {
        var added = XJ.transfer.mergeInto(s, incoming);
        msg = '已合并：新增 ' + (added.transactions + added.received + added.accounts) + ' 条记录';
      }
      /* 导入后重算自动到账，保证一致性 */
      try { C.applyAutoReceived(s); } catch (e) { /* 忽略 */ }
    });
    pendingImport = null;
    UI.closeSheet();
    UI.toast(msg);
  }

  /** 启动时检查 #xjimport=，有就弹确认 */
  function checkImportHash() {
    var raw = null;
    try { raw = XJ.transfer.readImportHash(location.hash); } catch (e) { /* 忽略 */ }
    if (!raw) return;
    /* 立刻清掉地址栏里的负载，避免刷新时反复提示 */
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* 忽略 */ }
    XJ.transfer.decode(raw).then(function (obj) {
      confirmImport(obj);
    }).catch(function (e) {
      UI.toast('链接里的搬运内容无法识别：' + (e && e.message ? e.message : '格式错误'));
    });
  }

  UI.on('openTransfer', function () { showTransferSheet(); });
  UI.on('xferSnapshots', function (node) { XFER_SNAPSHOTS = !!node.checked; });

  /* ==================== 跨设备同步 ====================
   * 配对链接形如  <站点>/#xjsync=XJ2e.<密文>  或  #xjsync=XJ1p.<明文>
   * 落地顺序：可用性门禁 → 解码 → 指纹校验 → 落地前 preflight → 写入 →
   *          verifyPair 六项校验 → 立刻清地址栏。
   * ★ 落地前先校验、落地后再验证，是这次重做时最关键的两道闸：
   *   当年的头号故障正是「配对界面显示成功、但两台设备连的是不同的盒子，
   *   数据永远不通」—— 只看「请求成功」是查不出这种失败的。 */

  /** 同步是否可用：必须是有域名的 http(s) 页面。
   *  双击打开 HTML（file://）时浏览器按 file:// 分区存储、SW 不可用，
   *  同步在这种形态下不可能工作 —— 浏览器硬限制，不是 bug。 */
  function syncAvailable() {
    try { return location.protocol === 'http:' || location.protocol === 'https:'; }
    catch (e) { return false; }
  }

  function checkPairHash() {
    var hash = location.hash || '';
    if (hash.indexOf(XJ.syncCore.INSTALL_KEY) !== 0) return;
    if (!syncAvailable()) {
      UI.toast('当前打开方式不支持跨设备同步（请用网址打开，而不是双击本地文件）');
      return;
    }
    var payload = null;
    try { payload = XJ.syncCore.readInstallHash(hash); } catch (e) { /* 忽略 */ }
    if (!payload) {
      /* 密文（XJ2e）优先：口令文本可能被聊天软件折行/加零宽字符，用容错解析 */
      var text = hash.slice(XJ.syncCore.INSTALL_KEY.length);
      try {
        /* parsePairText 返回口令字符串（容错解析：去零宽/全角/空白/尾标点） */
        var codeStr = XJ.syncCore.parsePairText ? XJ.syncCore.parsePairText(text) : null;
        if (codeStr) return applyPairCode(codeStr);
      } catch (e) { /* 忽略 */ }
      UI.toast('配对链接无法识别（可能被聊天软件截断了）');
      return;
    }
    /* 立刻清地址栏：链接本身等同钥匙，不该留在历史记录里 */
    clearPairHash();
    return doApplyPair(payload);
  }
  function clearPairHash() {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* 忽略 */ }
  }

  function doApplyPair(payload) {
    UI.toast('正在连接云端…');
    return XJ.sync.preflightPair(payload).then(function (pre) {
      if (!pre.ok) { UI.toast('配对失败：' + (pre.msg || pre.reason)); return null; }
      /* 不传 installMode：由 applyPair 自行判定首次对齐方式 ——
         新设备（本机只有默认支出项）以云端为准，已有数据则合并。
         写死 merge 会让新手机的默认支出项顶掉云端里的真实数据。 */
      var applied = XJ.sync.applyPair(payload);
      if (!applied.ok) { UI.toast('配对失败：' + (applied.msg || applied.reason)); return null; }
      if (XJ.storage && XJ.storage.save) XJ.storage.save(S.state);
      return XJ.sync.verifyPair().then(function (v) {
        if (!v.ok) {
          UI.toast('已连接但校验未通过：' + (v.reasons || []).join('；'));
        } else {
          UI.toast('同步已连接（云端第 ' + v.version + ' 版）');
        }
        XJ.sync.start();
        S.notify();
        return v;
      });
    }).catch(function (e) {
      UI.toast('配对失败：' + (e && e.message ? e.message : '网络错误'));
    });
  }

  /** 口令文本（XJ2e 密文 / XJ1p 明文）落地 —— 面板「粘贴口令」与链接共用同一条路径 */
  function applyPairCode(codeStr) {
    return XJ.syncCore.decodePairCode(codeStr).then(function (r) {
      if (!r.ok) { UI.toast('口令无法识别：' + (r.reason || '格式错误')); return null; }
      var key = r.key || null;
      if (key) { try { S.state.syncMeta.pairKey = key; } catch (e) { /* 忽略 */ } }
      return doApplyPair({ token: r.token, gistId: r.gistId, boxFingerprint: r.boxFingerprint });
    }).catch(function (e) {
      UI.toast('口令无法识别：' + (e && e.message ? e.message : '格式错误'));
    });
  }

  /* ---- 面板动作（精简面板：开关 + 立即同步 + 重新配对 + 复制口令 + 重置） ---- */
  UI.on('toggleSync', function (node) {
    XJ.sync.setEnabled(!!node.checked);
    S.notify();
    UI.toast(node.checked ? '已开启同步' : '已关闭同步（不再发送任何数据）');
  });

  UI.on('syncNow', function () {
    UI.toast('正在同步…');
    XJ.sync.tick({ force: true }).then(function (r) {
      if (r && r.ok) UI.toast('同步完成');
      else if (r && r.reason === 'rate') UI.toast('触发 GitHub 限流，稍后自动继续');
      else UI.toast('同步未成功：' + ((r && r.reason) || '未知'));
      S.notify();
    });
  });

  UI.on('syncRepair', function () {
    var html = UI.field('把配对口令粘贴到这里',
      '<input type="text" data-k="code" placeholder="XJ2e.… 或 XJ1p.…" autocomplete="off">') +
      '<button class="btn-block" data-act="syncRepairGo">连接</button>' +
      '<div class="tiny" style="margin-top:10px">口令就是别人发给你的那条同步链接里 <code>#xjsync=</code> 后面的部分。' +
      '连接成功后建议清掉对方的聊天记录 —— 链接等同云端钥匙。</div>';
    UI.openSheet({ title: '重新配对', html: html });
  });
  UI.on('syncRepairGo', function (node) {
    var f = UI.readFields(node.closest('.sheet'));
    var text = String(f.code || '').trim();
    if (!text) return UI.toast('请先粘贴口令');
    var m = text.match(/#?xjsync=(.+)$/);
    if (m) text = m[1];
    UI.closeSheet();
    return applyPairCode(text);
  });

  UI.on('syncCopyCode', function () {
    var m = S.state.syncMeta || {};
    if (!m.token || !m.gistId) return UI.toast('还没有连接信息');
    /* encodePairCode 是异步的（要 crypto.subtle 加密），且返回 { code, plain } */
    return XJ.syncCore.encodePairCode({ token: m.token, gistId: m.gistId, key: m.pairKey || undefined })
      .then(function (r) {
        var code = r && r.code;
        if (!code) return UI.toast('生成口令失败（浏览器不支持加密，请改用链接方式）');
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code).then(function () {
            UI.toast('口令已复制');
            /* 剪贴板里不该留着钥匙：用完即清 */
            setTimeout(function () { try { navigator.clipboard.writeText(''); } catch (e) {} }, 8000);
          }).catch(function () { showCodeFallback(code); });
        } else {
          showCodeFallback(code);
        }
      }).catch(function () { UI.toast('生成口令失败，请改用链接方式'); });
  });
  function showCodeFallback(code) {
    UI.openSheet({
      title: '配对口令',
      html: '<div class="field"><textarea rows="4" readonly style="width:100%;font-size:12px">' +
        U.esc(code) + '</textarea></div><div class="tiny">长按全选复制到另一台设备的「重新配对」里。</div>',
    });
  }

  UI.on('syncReset', function () {
    UI.confirm({
      title: '重置同步连接',
      message: '本机数据不会被删除，但需要重新配对才能继续同步。已配对过的其他设备不受影响。',
      confirmText: '重置连接', danger: true,
    }).then(function (ok) {
      if (!ok) return;
      S.commit(function (s) {
        var sm = s.syncMeta || {};
        sm.enabled = false; sm.token = null; sm.gistId = null; sm.etag = null;
        sm.version = 0; sm.outbox = []; sm.versions = {}; sm.everPaired = false;
        sm.forcePull = false; sm.lastErr = null; sm.failSince = null;
        /* deviceId 与墓碑刻意保留：它们不是「连接」，且墓碑丢了删除会被复活 */
      });
      XJ.sync.stop();
      S.notify();
      UI.toast('已重置连接');
    });
  });

  UI.on('syncFoldConn', function () { S.setUI({ foldSyncConn: !S.ui.foldSyncConn }); });
  UI.on('syncFoldLog', function () { S.setUI({ foldSyncLog: !S.ui.foldSyncLog }); });

  /* file:// 打开时首屏就说明白，而不是等用户点进面板才发现 */
  if (!syncAvailable()) {
    setTimeout(function () {
      UI.toast('提示：本地文件方式不支持跨设备同步');
    }, 1200);
  }
  UI.on('xferLink', function () {
    XJ.transfer.encode(transferPayload()).then(function (enc) { showTransferOut(enc, true); });
  });
  UI.on('xferText', function () {
    XJ.transfer.encode(transferPayload()).then(function (enc) { showTransferOut(enc, false); });
  });
  UI.on('xferCopy', function (node) { copyText(node.getAttribute('data-text') || ''); });
  UI.on('xferRead', function () {
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function (txt) {
        if (!txt || !txt.trim()) return UI.toast('剪贴板是空的');
        return XJ.transfer.decode(txt.trim()).then(confirmImport);
      }).catch(function () {
        UI.toast('读不到剪贴板，请在下方粘贴');
      });
    } else {
      UI.toast('当前环境不支持读剪贴板，请在下方粘贴');
    }
  });
  UI.on('xferPaste', function () {
    var el = document.getElementById('xj-xfer-paste');
    var txt = el && el.value ? el.value.trim() : '';
    if (!txt) return UI.toast('请先粘贴搬运文本');
    XJ.transfer.decode(txt).then(confirmImport).catch(function (e) {
      UI.toast('无法识别搬运内容：' + (e && e.message ? e.message : '格式错误'));
    });
  });
  UI.on('xferDoMerge', function () { applyImport('merge'); });
  UI.on('xferDoOverwrite', function () { applyImport('overwrite'); });

  /* ---------------- PWA manifest（仅单文件版需要） ----------------
   * 部署版（dist/pwa/）由 build.mjs 写死静态 manifest + PNG 图标 + Service Worker；
   * 若页面上已存在静态 manifest 声明，这里什么都不做 —— 否则会出现两个 <link rel="manifest">。 */
  function injectManifest() {
    if (document.querySelector('link[rel="manifest"]')) return;
    try {
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
        '<rect width="512" height="512" rx="112" fill="#E8461F"/>' +
        '<text x="256" y="340" font-size="260" font-family="PingFang SC,Microsoft YaHei,sans-serif" font-weight="700" fill="#fff" text-anchor="middle">自</text></svg>';
      var iconUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      var manifest = {
        name: '自由 · 股息收入追踪',
        short_name: '自由',
        description: '记录每一笔股息收入，看分红覆盖生活的进度。只做记录，不荐股。',
        start_url: location.href,
        scope: location.href.replace(/[^/]*$/, ''),
        display: 'standalone',
        /* 与部署版 dist/pwa/manifest.webmanifest 对齐：平板要能横屏 */
        orientation: 'any',
        background_color: '#F2F2F7',
        theme_color: '#F2F2F7',
        icons: [
          { src: iconUrl, sizes: '512x512', type: 'image/svg+xml', purpose: 'any' },
          { src: iconUrl, sizes: '192x192', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      };
      var blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
      var link = document.createElement('link');
      link.rel = 'manifest';
      link.href = URL.createObjectURL(blob);
      document.head.appendChild(link);
      if (!document.querySelector('link[rel="apple-touch-icon"]')) {
        var apple = document.createElement('link');
        apple.rel = 'apple-touch-icon';
        apple.href = iconUrl;
        document.head.appendChild(apple);
      }
    } catch (e) { /* file:// 下可能受限，忽略即可 */ }
  }

  /* ---------------- Service Worker（只有部署版才有；file:// 必须静默跳过） ---------------- */
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;   // file:// 跳过
    try {
      navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
        .catch(function (e) { console.warn('[sw] 注册失败（不影响使用）', e); });
    } catch (e) { /* 忽略 */ }
  }

  /* ---------------- 后台提醒轮询 ---------------- */
  var lastRemindKey = '';
  function reminderTick() {
    if (!S.state) return;
    var lead = U.n0(S.state.settings.reminderLeadDays);
    var today = U.today();
    var ups = C.upcomingPayouts(S.state, S.acc(), today);
    var soon = ups.filter(function (e) { return U.daysBetween(today, e.date) <= lead; });
    if (!soon.length) return;
    var key = soon.map(function (e) { return e.planId + e.date; }).join(',');
    if (key === lastRemindKey) return;
    lastRemindKey = key;
    var total = U.sum(soon, function (e) { return e.amount; });
    UI.toast('有 ' + soon.length + ' 笔分红即将到账，预计 ' + U.moneySign(total), 3200);
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    mountShell();
    if (S.ui.tab === 'overview') { /* 默认 */ }

    /* ★ 架构预留：将来接入跨设备同步时，在这里挂 XJ.storage.setOnBeforeSave 钩子
       （方向 sync → storage，落盘前算出增量 op；见 storage.js 同名钩子与 model.js 的 syncMeta 空壳）。
       当前版本同步层已剔除，state.syncMeta 仅保留空壳结构。 */

    XJ.storage.init().then(function (mode) {
      return XJ.storage.load();
    }).then(function (loaded) {
      var state;
      if (loaded) {
        /* ★ keepSync：这是【本机存档】而不是别人的备份，必须把同步设置带进来。
           （当前 syncMeta 恒为空壳，此参数等价 no-op；将来接回同步层后立即恢复原语义：
           若丢弃它，每次打开网页都会清空开关/令牌/设备身份，本机记录会被反复当成新增重推。） */
        try { state = M.fromImport(loaded, { keepSync: true }); }
        catch (e) { console.warn('[load] 数据损坏，已重置', e); state = M.ensureBootstrapped(M.defaultState()); }
      } else {
        state = M.ensureBootstrapped(M.defaultState());
      }
      /* 一次性数据自愈：合并历史遗留的重复到账记录
         （早期版本的自动登记幂等键拦不住「手工/OCR 补录的同一天同一笔」，会记两次） */
      var dupFixed = 0;
      try { dupFixed = XJ.calc.dedupeDividends(state); } catch (e) { console.warn('[dedupe]', e); }
      S.init(state);
      if (dupFixed) {
        XJ.storage.save(state);
        UI.toast('已合并 ' + dupFixed + ' 条重复的分红到账记录');
      }
      S.ui.accountId = C.ALL;
      UI.installDelegation();
      S.subscribe(render);
      injectManifest();
      registerSW();

      /* ---- 跨设备同步：挂钩 + 前后台监听（接回预留点，app.js:3626） ---- */
      XJ.sync.attach();
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) XJ.sync.onVisible();
      });
      window.addEventListener('pagehide', function () { XJ.sync.flushNow(); });
      /* 应用已开着时又点了一条配对链接：hash 导航不会重载页面，必须靠这个兜住 */
      window.addEventListener('hashchange', function () {
        if (/#xjsync=/.test(location.hash || '')) checkPairHash();
      });

      /* 从带 #xjsync= 的链接打开 → 落地配对（必须排在首屏对齐之前，
         否则用户会先看到「空数据」再跳变） */
      checkPairHash();

      render();
      /* 首屏等一次对齐（最多 4 秒）：配对后先拉一次，用户看到的就是对齐后的数据 */
      XJ.sync.isFirstPaintSynced();
      XJ.sync.start();
      /* 从带 #xjimport= 的链接打开 → 询问是否导入 */
      setTimeout(function () { checkImportHash(); }, 400);
      /* 派息日弹窗：这里试一次（分红方案本地就有缓存，离线也能弹），
         行情刷新完成后再试一次兜底（首装 / 缓存过期时靠那次）。两次都幂等，不会重复弹。 */
      setTimeout(maybeShowPayoutPopup, 600);
      refreshAll({ silent: true }).then(function () { maybeShowPayoutPopup(); });
      setInterval(function () {
        if (!document.hidden) refreshAll({ silent: true });
      }, Math.max(60000, U.n0(S.state.settings.quoteRefreshMs) || 60000));
      setInterval(reminderTick, 60000);
      reminderTick();
    }).catch(function (e) {
      console.error('[boot]', e);
      var state = M.ensureBootstrapped(M.defaultState());
      S.init(state);
      UI.installDelegation();
      S.subscribe(render);
      render();
      UI.toast('本地存储初始化异常，数据将仅保留在本次会话中');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
