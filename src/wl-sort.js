/* ==================== 自选视图 · 按分组排序（共用 hook） ====================
 * 需求：每个分组内的股票，支持按「股息率」「百分位」排序。
 *   ① 所有已有分组都有，以后新建的分组也自动有 —— 所以排序状态按 groupId 存，
 *      不写死任何组；分组一旦存在就自然拥有入口（虚拟组 'all' / 'holding' 同样有）。
 *   ② 单选：点了第二个指标就替换第一个（不做多级排序）。
 *   ③ 三态循环：无 → 降序 → 升序 → 无。
 *   ④ 空值 / 缺失（null、NaN、样本不足、非 A股）一律固定排最后，与升降序无关。
 *   ⑤ 同值保持原有相对顺序（稳定排序），每次算都用同一份基序，不会「同值互相蹦」。
 *   ⑥ 记住排序：按分组存 localStorage，刷新后恢复。
 *
 * 状态只放内存 + localStorage，**不落 state、不进导出、不进同步** ——
 * 排序是「这台设备上这张列表怎么摆」的显示偏好，不是数据本身。
 */
XJ.wlSort = (function () {
  var U = XJ.util;

  /* 可选指标：key 与数据取法一一对应（见 valueOf） */
  var FIELDS = [
    { key: 'yld', label: '股息率', unit: '%' },     // 本财年派现 ÷ 现价 × 100
    { key: 'pct', label: '百分位', unit: '' },      // 0–100，股息率在近 N 年交易日中的位置
  ];

  var DIRS = ['none', 'desc', 'asc'];
  var LS_KEY = 'xj.wl.sort';                      // 全站唯一前缀，见 util 约定

  /** 内存镜像：{ [groupId]: { field, dir } }；首次用到时从 localStorage 灌一次 */
  var memo = null;

  function lsGet() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return {};
      var raw = localStorage.getItem(LS_KEY);
      var obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === 'object' ? obj : {};
    } catch (e) { return {}; }
  }

  function lsSet(obj) {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return;
      localStorage.setItem(LS_KEY, JSON.stringify(obj));
    } catch (e) { /* 隐私模式 / 配额满：排序失效但页面照常可用 */ }
  }

  function store() {
    if (!memo) memo = lsGet();
    return memo;
  }

  function fieldMeta(key) {
    return FIELDS.filter(function (f) { return f.key === key; })[0] || null;
  }

  /** 某分组的排序状态（永远返回对象，未设置 = { field: null, dir: 'none' }） */
  function stateOf(groupId) {
    var g = String(groupId || 'all');
    var s = store()[g];
    if (!s || !fieldMeta(s.field) || DIRS.indexOf(s.dir) < 0 || s.dir === 'none') {
      return { field: null, dir: 'none' };
    }
    return { field: s.field, dir: s.dir };
  }

  /** 三态推进：同指标 none→desc→asc→none；点另一个指标 = 直接降序（替换，不做多级） */
  function cycle(groupId, field) {
    if (!fieldMeta(field)) return stateOf(groupId);
    var g = String(groupId || 'all');
    var cur = stateOf(g);
    var next;
    if (cur.field !== field) next = { field: field, dir: 'desc' };
    else if (cur.dir === 'desc') next = { field: field, dir: 'asc' };
    else next = { field: null, dir: 'none' };
    var all = store();
    if (next.dir === 'none') delete all[g]; else all[g] = next;
    lsSet(all);
    return next;
  }

  /* ---------------- 取值（排序依据） ----------------
   * 取法与列表行上「息 / 分位」的显示**完全同源**：同一个 yieldNow / yieldPercentile、
   * 同一份行情 md、同一份分位缓存 —— 保证「看到的数」和「排出来的序」不会打架。
   *
   * @param ctx { state, price(sym)->Number|null, win(Number) }
   * @return { yld: Number|null, pct: Number|null }
   */
  function metricsOf(ctx, sym) {
    var st = ctx.state;
    var plans = XJ.calc.plansOf(st, sym) || [];
    if (!plans.length) return { yld: null, pct: null };
    var price = ctx.price(sym);
    var yld = XJ.calc.yieldNow(plans, price, U.today());
    var pct = null;
    var cache = st.yieldHistory && st.yieldHistory[sym];
    if (cache && cache.day && cache.day.length >= 2) {
      var r = XJ.calc.yieldPercentile(plans, cache.day, { years: ctx.win, today: U.today(), price: price });
      /* 样本不足 / 无可用财年 → 视为缺失，排最后（与行上的「样本不足」一致） */
      if (r && !r.insufficient && typeof r.pct === 'number' && isFinite(r.pct)) pct = r.pct;
    }
    return { yld: yld, pct: pct };
  }

  /** 有效数值才算数：null / undefined / NaN / Infinity 一律视为「无值」 */
  function valid(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /**
   * 按分组状态给条目排序（稳定 + 缺失恒置底）。
   * @param items 已经是「基序」的数组（本视图里是 addedAt 升序），不改它
   * @param groupId 分组 id —— 状态按它取，各组的排序互不污染
   * @param ctx  { state, price, win }
   * @return 新数组（无排序时返回原数组的浅拷贝）
   */
  function sortItems(items, groupId, ctx) {
    var list = (items || []).slice();
    var s = stateOf(groupId);
    if (!s.field || s.dir === 'none') return list;

    /* 先算好值，再排 —— 取值只在比较器外面跑一遍，避免 O(n log n) 次重复计算 */
    var scored = list.map(function (it, i) {
      var m = it && it.__m ? it.__m : metricsOf(ctx, it.symbol);
      return { it: it, i: i, v: valid(m[s.field]) ? m[s.field] : null };
    });
    var dir = s.dir === 'asc' ? 1 : -1;
    scored.sort(function (a, b) {
      var av = a.v, bv = b.v;
      if (av === null && bv === null) return a.i - b.i;       // 都缺 → 保持原相对顺序
      if (av === null) return 1;                              // 缺 → 恒置底（不分升降序）
      if (bv === null) return -1;
      if (av !== bv) return av > bv ? dir : -dir;
      return a.i - b.i;                                       // 同值 → 保持原相对顺序
    });
    return scored.map(function (x) { return x.it; });
  }

  /** 表头按钮：点表头文字即排序；箭头 + 高亮标示当前态 */
  function headerHtml(groupId) {
    var s = stateOf(groupId);
    return '<div class="wl-sortbar">' + FIELDS.map(function (f) {
      var on = s.field === f.key;
      var mark = !on ? '\u2195' : (s.dir === 'desc' ? '\u2193' : '\u2191');   // ↕ / ↓ / ↑
      var tip = !on ? ('按' + f.label + '排序')
        : (s.dir === 'desc' ? (f.label + '：降序 → 点一下改升序') : (f.label + '：升序 → 点一下取消'));
      return '<button type="button" class="wl-sortbtn' + (on ? ' on' : '') + '"' +
        ' data-act="wlSort" data-g="' + U.esc(groupId) + '" data-f="' + f.key + '"' +
        ' aria-pressed="' + (on ? 'true' : 'false') + '" title="' + U.esc(tip) + '">' +
        U.esc(f.label) + '<i class="wl-sortmk' + (on ? ' on' : '') + '" aria-hidden="true">' + mark + '</i>' +
        '</button>';
    }).join('') + '</div>';
  }

  /* 自测用：清空内存镜像（不改 localStorage） */
  function _reset() { memo = null; }

  return {
    FIELDS: FIELDS,
    stateOf: stateOf,
    cycle: cycle,
    metricsOf: metricsOf,
    sortItems: sortItems,
    headerHtml: headerHtml,
    _reset: _reset,
    LS_KEY: LS_KEY,
  };
})();
