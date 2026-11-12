/* ==================== 状态容器（单一状态源 + 订阅） ==================== */
XJ.store = (function () {
  var U = XJ.util;

  /* 折叠默认值取自 util.FOLD（全站唯一入口，见 util.js 的说明） */
  var FOLD = U.FOLD;

  /**
   * 统一读取折叠态 —— 所有可折叠区域的**唯一读法**。
   * 未设置（undefined / null）时自动回落 FOLD.collapsed（默认折叠），
   * 所以新增折叠卡片只要在 ui 里存一个键即可，不用在视图里写 `!== false` 之类的兜底。
   * @param {string} key  ui（或传入的 src）里的键名
   * @param {object=} src 默认读 app.ui；settings 里的折叠标志（如 heroCollapsed）传 settings 对象
   */
  function folded(key, src) {
    var o = src || app.ui;
    var v = o ? o[key] : null;
    return (v === undefined || v === null) ? FOLD.collapsed : !!v;
  }

  /** 「是否展开」语义的键（如分类明细）—— 缺省回落 FOLD.open（默认不展开） */
  function isOpen(key) {
    var v = app.ui[key];
    return (v === undefined || v === null) ? FOLD.open : !!v;
  }

  var listeners = [];

  var app = {
    state: null,

    /* 运行时缓存：
       indexMinute = 对比指数的当日分时（indexKey → {date, points}），仅内存、不进导出。
       klineTriedAt = 'YYYY-MM-DD'，记录 OHLC K 线（技术信号用）今天是否已尝试过取数。
         失败也要记，否则每轮同步都会为同一只票反复重试、拖慢整体速度。
       持仓的当日分时**不在这里**：它落在 state.minuteCache（见下），要持久化。 */
    indexMinute: {},
    klineTriedAt: null,

    /** 纯 UI 状态，不持久化 */
    ui: {
      tab: 'overview',
      accountId: XJ.calc.ALL,
      calYear: null,
      calMonth: null,
      selDate: null,
      sortMode: 'dividend',     // dividend | marketValue | yield | costYield | pl | holdDays
      marketFilter: 'all',      // all | stock | etf | of | hk | us
      annualYear: null,         // 年度总览选中年份
      annualMonth: null,        // 年度总览选中月份
      calView: 'calendar',      // calendar | annual
      /* ---- 以下折叠态一律取 FOLD.collapsed / FOLD.open（全站默认「折叠」） ---- */
      pendCollapsed: FOLD.collapsed,        // 分红日历「待除权」卡片
      coverOpenCats: { essential: FOLD.open, quality: FOLD.open },  // 分红覆盖卡两类明细
      coverCollapsed: FOLD.collapsed,       // 分红覆盖卡整卡
      fireSpendMode: 'month',   // FIRE 试算 · 花费显示单位（month | day，纯显示不持久化）
      firePrRange: 'all',       // FIRE · FI 进度曲线时间尺度（today|1m|3m|6m|ytd|all|custom）
      firePrBeg: null,          // FI 进度自定义区间起（'YYYY-MM-DD'）
      firePrEnd: null,          // FI 进度自定义区间止
      fireCovRange: 'all',      // FIRE · 覆盖率曲线时间尺度（3m|6m|ytd|all|custom，月度粒度无当日/本月）
      fireCovBeg: null,         // 覆盖率自定义区间起（'YYYY-MM'）
      fireCovEnd: null,        // 覆盖率自定义区间止（'YYYY-MM'）
      /* 语义统一：true = 折叠（收起），false = 展开 */
      foldSyncConn: FOLD.collapsed,   // 我的 → 同步卡片：连接信息
      foldSyncLog: FOLD.collapsed,    // 我的 → 同步卡片：详细日志
      foldPlans: FOLD.collapsed,      // 个股页「分红档案」（内容长，默认收起）
      foldTx: FOLD.collapsed,         // 个股页「交易明细」
      foldMineTx: FOLD.collapsed,     // 我的页「交易流水」
      // 资产走势卡挂两处，控件状态各自独立：'' = 首页（nwXxx），'an' = 账户分析（anNwXxx）
      nwGran: 'day',            // 资产走势曲线：day | month
      nwRange: null,            // 资产走势曲线区间：1m | 6m | ytd | all | custom（null 时自适应）
      nwBeg: '', nwEnd: '',     // 自定义区间
      nwMetric: 'mv',           // 资产走势指标：mv 持仓市值 | nw 净资产 | ret 收益率
      nwMode: 'line',           // 收益率画法：line 曲线 | candle K线（蜡烛为选中指数）
      nwRetMode: 'twr',         // 收益率口径：twr 时间加权 | cost 成本收益率（累计收益 ÷ 累计净投入）
      anNwRetMode: 'twr',       // 账户分析那张卡的同名控件（两实例状态独立）
      nwCollapsed: FOLD.collapsed,        // 资产走势卡（首页）是否收起
      anNwCollapsed: FOLD.collapsed,      // 资产走势卡（账户分析那张）是否收起
      floatOpen: false,         // 悬浮双入口是否展开
      subPage: null,            // 子页面：null | 'analysis' | 'symbol'
      subArg: null,             // 子页面参数（如 symbol）
      busy: false,
      status: '',
      planYear: 0,              // 个股档案选中项
      detailSymbol: null,
      /* 个股详情页「股息率曲线」的时间轴选区（null = 默认最近十年）。
         由 brush 松手时**静默写入**（不走 setUI）：拖动过程要实时重画主图，
         而 setUI 会触发整页重建、滚动跳动，反过来把正在拖的手势打断。 */
      yjBeg: null,
      yjEnd: null,
      /* 平均股息率线的口径：year = 该财年整段窗口的均值（阶梯线）| cum = 自切换日起逐日累积。
         均线本身常亮、不可关闭，图例那一项点击是【换口径】而不是开关。 */
      yieldAvgMode: 'year',
      /* 分红汇总页：时间档位（year|y2|y5|all|custom）、自定义起止、当前展开的标的 */
      divsumRange: 'year',
      divsumBeg: '',
      divsumEnd: '',
      divsumOpen: '',
    },

    init: function (state) {
      this.state = state;
      var now = new Date();
      this.ui.calYear = now.getFullYear();
      this.ui.calMonth = now.getMonth() + 1;
      this.ui.selDate = null;
      return this;
    },

    /** 提交变更：mutate(state) 后落盘并通知视图 */
    commit: function (mutator, opts) {
      if (mutator) mutator(this.state);
      if (!opts || opts.save !== false) XJ.storage.saveSoon(this.state);
      this.notify();
    },

    /** 立即落盘（导入/清空等关键节点） */
    commitNow: function (mutator) {
      if (mutator) mutator(this.state);
      XJ.storage.save(this.state);
      this.notify();
    },

    /** 只改 UI 状态，不落盘 */
    setUI: function (patch) {
      Object.assign(this.ui, patch);
      this.notify();
    },

    notify: function () {
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](); } catch (e) { console.error('[render]', e); }
      }
    },

    subscribe: function (fn) { listeners.push(fn); },

    acc: function () { return this.ui.accountId || XJ.calc.ALL; },

    accounts: function () { return this.state.accounts.slice().sort(function (a, b) { return a.sortOrder - b.sortOrder; }); },

    accountName: function (id) {
      if (!id || id === XJ.calc.ALL) return '全部账户';
      var a = this.state.accounts.filter(function (x) { return x.accountId === id; })[0];
      return a ? a.name : '未知账户';
    },

    symbolName: function (sym) {
      var q = this.state.quoteCache[sym];
      if (q && q.name) return q.name;
      var s = this.state.symbols[sym];
      return s && s.name ? s.name : XJ.model.codeOf(sym);
    },

    /**
     * 合并行情到缓存与主数据。
     * 名称规则：带 XD/XR/DR 前缀时行情接口会截断原名（如「XD中国平」），
     *         此时不得用截断名去覆盖已有的完整名称。
     */
    mergeQuotes: function (quotes) {
      var st = this.state;
      var n = 0;
      var realtime = 0;
      Object.keys(quotes || {}).forEach(function (sym) {
        var q = quotes[sym];
        if (!q) return;

        /* 原地更新，避免重建对象时丢掉 nameLocked / nameHealedOn / 成本口径等字段 */
        var rec = st.symbols[sym] || XJ.model.symbolRecord(sym);
        var prevName = rec.name || '';
        var incoming = q.name || '';
        var locked = rec.nameLocked && XJ.util.hasNameInfo(prevName);
        var name = incoming;

        if (locked) {
          name = prevName;                                   // 用户手改过 → 行情不许覆盖
        } else if (q.nameTruncated && XJ.util.hasNameInfo(prevName) && prevName.length >= incoming.length) {
          name = prevName;                                   // 行情名被交易所前缀挤短，保留更长的已存名
        }
        q.name = name || incoming || prevName;

        rec.code = XJ.model.codeOf(sym);
        rec.market = XJ.model.marketOf(sym);
        /* 美股：行情返回的 f[2] 是带交易所后缀的代码（AAPL.OQ / BABA.N）。
           历史 K 线必须用它，裸代码只能取到 1~2 根。 */
        if (rec.market === 'us' && q.code) rec.quoteCode = q.code;
        rec.name = q.name || prevName || XJ.model.codeOf(sym);
        rec.type = rec.type || 'STOCK';
        /* 行情名被前缀挤占 → 打上嫌疑标记，交给 healSymbolNames 反查完整名。
           非挤占日（正常名）则清掉标记，不会白白请求。 */
        rec.nameSuspect = locked ? false : !!q.nameTruncated;
        rec.updatedAt = XJ.util.nowStamp();

        st.quoteCache[sym] = q;
        st.symbols[sym] = rec;
        n++;
        if (q.source !== 'close' && q.source !== 'nav') realtime++;
      });
      if (realtime) st.settings.lastQuoteAt = XJ.util.nowStamp();
      return n;
    },

    /** 需要取数的标的清单（当前账户下还持有的） */
    activeSymbols: function () {
      var hs = XJ.calc.holdings(this.state, this.acc());
      return hs.map(function (h) { return h.symbol; });
    },

    /* ---- 当日分时取用 ----
       实际判定逻辑在 calc.minuteOf（纯函数，可被 verify 独立复算），
       这里只负责「从哪拿缓存 + 今天是哪天」。视图层一律走这两个方法，
       不要自己去摸 state.minuteCache —— 免得各处对 date 的判定写歪。 */

    /** 某标的「最近一个交易日」的分时；没有则 null */
    minuteOf: function (symbol) {
      return XJ.calc.minuteOf(this.state.minuteCache, symbol, U.today());
    },

    /** 批量版：{ [symbol]: {date, points} }，只含可用的 */
    intradayFor: function (symbols) {
      return XJ.calc.minuteMapFor(this.state.minuteCache, symbols, U.today());
    },

    /** 这批分时属于哪个交易日（无缓存则 null），供视图标注用 */
    minuteDate: function () {
      var c = this.state.minuteCache;
      return c && c.at ? c.at : null;
    },

    searchTransactions: function (accountId, symbol) {
      return XJ.calc.txOf(this.state, accountId || this.acc(), symbol);
    },

    hasAnyData: function () {
      return this.state.transactions.length > 0;
    },

    /* ---- 折叠 / 展开：统一入口（默认值见 util.js 的 FOLD） ---- */
    FOLD: FOLD,
    folded: folded,
    isOpen: isOpen,

    /* ==================== 自选（watchlist · 六 Tab 二期） ====================
     * 全部写操作走 commit（落盘钩子自动算同步增量；wgrp/witem 指纹见 sync-core）。
     * 虚拟组：'all'（items 并集）与 'holding'（实时跟随真实持仓）不落库，
     *         视图层直接派生；groupId 一律是 'wlg_*' 字符串。 */

    wlGroups: function () {
      var M = XJ.model;
      M.ensureWatchlist(this.state);
      return this.state.watchlist.groups.slice().sort(function (a, b) {
        return (a.sortOrder || 99) - (b.sortOrder || 99);
      });
    },

    wlItems: function (groupId) {
      XJ.model.ensureWatchlist(this.state);
      var items = this.state.watchlist.items || [];
      if (!groupId || groupId === 'all') return items.slice();
      if (groupId === 'holding') {
        var hs = XJ.calc.holdings(this.state, this.acc());
        return hs.map(function (h) { return { itemId: 'hold:' + h.symbol, groupId: 'holding', symbol: h.symbol, holding: true }; });
      }
      return items.filter(function (it) { return it.groupId === groupId; });
    },

    /** 该 symbol 是否已在自选（任意分组） */
    wlHas: function (symbol) {
      return (this.state.watchlist.items || []).some(function (it) { return it.symbol === symbol; });
    },

    /** 该 symbol 所在的分组（无则 null） */
    wlGroupOf: function (symbol) {
      var it = (this.state.watchlist.items || []).filter(function (x) { return x.symbol === symbol; })[0];
      return it ? it.groupId : null;
    },

    /** 加自选：同组同代码唯一；顺手建 symbols 记录（联想名），行情刷新会自动补全 */
    wlAdd: function (groupId, symbol, name) {
      var ok = false;
      this.commit(function (s) {
        XJ.model.ensureWatchlist(s);
        var w = s.watchlist;
        if (!groupId || groupId === 'all' || groupId === 'holding') return;
        if (!w.groups.some(function (g) { return g.groupId === groupId; })) return;
        if (w.items.some(function (it) { return it.groupId === groupId && it.symbol === symbol; })) return;
        w.items.push({ itemId: XJ.util.uid('wli'), groupId: groupId, symbol: symbol, addedAt: XJ.util.nowStamp() });
        if (!s.symbols[symbol]) s.symbols[symbol] = XJ.model.symbolRecord(symbol, { name: name || '' });
        else if (name && !s.symbols[symbol].name) s.symbols[symbol].name = name;
        ok = true;
      });
      return ok;
    },

    wlRemove: function (itemId) {
      this.commit(function (s) {
        XJ.model.ensureWatchlist(s);
        s.watchlist.items = s.watchlist.items.filter(function (it) { return it.itemId !== itemId; });
      });
    },

    /** 换组（搜索页星标二次点 / 移动） */
    wlMove: function (itemId, toGroupId) {
      this.commit(function (s) {
        XJ.model.ensureWatchlist(s);
        var it = s.watchlist.items.filter(function (x) { return x.itemId === itemId; })[0];
        if (!it) return;
        if (s.watchlist.items.some(function (x) { return x.itemId !== itemId && x.groupId === toGroupId && x.symbol === it.symbol; })) return;
        it.groupId = toGroupId;
      });
    },

    wlGroupAdd: function (name) {
      var id = null;
      this.commit(function (s) {
        XJ.model.ensureWatchlist(s);
        var nm = String(name || '').trim().slice(0, 12);
        if (!nm) return;
        var maxSort = 0;
        s.watchlist.groups.forEach(function (g) { maxSort = Math.max(maxSort, g.sortOrder || 0); });
        var g = { groupId: XJ.util.uid('wlg'), name: nm, sortOrder: maxSort + 1, createdAt: XJ.util.nowStamp() };
        s.watchlist.groups.push(g);
        id = g.groupId;
      });
      return id;
    },

    wlGroupRename: function (groupId, name) {
      this.commit(function (s) {
        XJ.model.ensureWatchlist(s);
        var g = s.watchlist.groups.filter(function (x) { return x.groupId === groupId; })[0];
        var nm = String(name || '').trim().slice(0, 12);
        if (g && nm) g.name = nm;
      });
    },

    /** 删组：组内条目一并删除（同步层各发各的墓碑，删除必胜语义天然成立） */
    wlGroupRemove: function (groupId) {
      this.commit(function (s) {
        XJ.model.ensureWatchlist(s);
        if (XJ.model.WL_DEFAULT_GROUPS.some(function (d) { return d.groupId === groupId; })) return; // 默认组不可删
        s.watchlist.groups = s.watchlist.groups.filter(function (g) { return g.groupId !== groupId; });
        s.watchlist.items = s.watchlist.items.filter(function (it) { return it.groupId !== groupId; });
      });
    },

    /** 组排序：orderedIds 必须是现有组的完整排列（视图层保证） */
    wlGroupReorder: function (orderedIds) {
      this.commit(function (s) {
        XJ.model.ensureWatchlist(s);
        var byId = {};
        s.watchlist.groups.forEach(function (g) { byId[g.groupId] = g; });
        var next = [];
        (orderedIds || []).forEach(function (id, i) {
          if (byId[id]) { next.push(Object.assign(byId[id], { sortOrder: i + 1 })); delete byId[id]; }
        });
        Object.keys(byId).forEach(function (id) { next.push(byId[id]); });
        s.watchlist.groups = next;
      });
    },
  };

  return app;
})();
