/* ==================== 股东持股情况 · 四列表头排序 ====================
 * 与 XJ.wlSort 的关系：**完全独立的一套**，绝不改 wl-sort.js。
 *   · 自选 / 股票池的排序态存在 xj.wl.sort，本页存在 xj.holder.sort；
 *     groupId 固定 'holder'，两边互不污染（verify 有隔离断言）。
 *   · 交互沿用项目惯例：三态循环 无 → 降序 → 升序 → 无，单选（点第二个指标替换第一个），
 *     缺值恒置底、同值稳定排序、状态按 groupId 存 localStorage。
 *   · 表头不是自选那种按钮条，而是与截图一致的紧凑五列表头：
 *     「持有股票」不可排，其余四列点击排序，箭头 ↕ / ↓ / ↑ + 高亮。
 *
 * 状态只放内存 + localStorage，不进 state、不进导出、不进同步。
 */
XJ.holderSort = (function () {
  var U = XJ.util;

  var FIELDS = [
    { key: 'cap', label: '持有市值' },
    { key: 'ratio', label: '持股比例' },
    { key: 'chg', label: '环比增减' },
    { key: 'rank', label: '持股排名' },
  ];
  var DIRS = ['none', 'desc', 'asc'];
  var LS_KEY = 'xj.holder.sort';
  var GROUP = 'holder';

  var memo = null;

  function lsGet() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return {};
      var obj = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      return obj && typeof obj === 'object' ? obj : {};
    } catch (e) { return {}; }
  }
  function lsSet(obj) {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return;
      localStorage.setItem(LS_KEY, JSON.stringify(obj));
    } catch (e) { /* 隐私模式：排序失效但页面照常可用 */ }
  }
  function store() { if (!memo) memo = lsGet(); return memo; }
  function fieldMeta(k) {
    for (var i = 0; i < FIELDS.length; i++) if (FIELDS[i].key === k) return FIELDS[i];
    return null;
  }
  function stateOf(groupId) {
    var g = String(groupId || GROUP);
    var s = store()[g];
    if (!s || !fieldMeta(s.field) || DIRS.indexOf(s.dir) < 0 || s.dir === 'none') {
      return { field: null, dir: 'none' };
    }
    return { field: s.field, dir: s.dir };
  }
  /** 同指标 none→desc→asc→none；换指标 = 直接降序 */
  function cycle(groupId, field) {
    if (!fieldMeta(field)) return stateOf(groupId);
    var g = String(groupId || GROUP), cur = stateOf(g), next;
    if (cur.field !== field) next = { field: field, dir: 'desc' };
    else if (cur.dir === 'desc') next = { field: field, dir: 'asc' };
    else next = { field: null, dir: 'none' };
    var all = store();
    if (next.dir === 'none') delete all[g]; else all[g] = next;
    lsSet(all);
    return next;
  }

  function valid(v) { return typeof v === 'number' && isFinite(v); }
  function valueOf(it, field) {
    var m = it && it.__m ? it.__m : it;
    var v = m ? m[field] : null;
    return valid(v) ? v : null;
  }

  /** 稳定排序 + 缺失恒置底；无排序时返回浅拷贝 */
  function sortItems(items, groupId) {
    var list = (items || []).slice();
    var s = stateOf(groupId);
    if (!s.field || s.dir === 'none') return list;
    var scored = list.map(function (it, i) {
      return { it: it, i: i, v: valueOf(it, s.field) };
    });
    var dir = s.dir === 'asc' ? 1 : -1;
    scored.sort(function (a, b) {
      if (a.v === null && b.v === null) return a.i - b.i;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      if (a.v !== b.v) return a.v > b.v ? dir : -dir;
      return a.i - b.i;
    });
    return scored.map(function (x) { return x.it; });
  }

  /** 表头：与行共用同一套 grid 列宽，点按钮切换三态 */
  function headerHtml(groupId) {
    var g = String(groupId || GROUP), s = stateOf(g);
    var out = '<div class="holder-thead" data-holder-thead="' + U.esc(g) + '">' +
      '<span class="ht-name">持有股票</span>';
    FIELDS.forEach(function (f) {
      var on = s.field === f.key;
      var mark = !on ? '↕' : (s.dir === 'desc' ? '↓' : '↑');
      var tip = !on ? ('按' + f.label + '排序')
        : (s.dir === 'desc' ? (f.label + '：降序 → 点一下改升序') : (f.label + '：升序 → 点一下取消'));
      out += '<button type="button" class="ht-btn' + (on ? ' on' : '') + '"' +
        ' data-act="holderSort" data-g="' + U.esc(g) + '" data-f="' + f.key + '"' +
        ' aria-pressed="' + (on ? 'true' : 'false') + '" title="' + U.esc(tip) + '">' +
        U.esc(f.label) + '<i class="ht-mk' + (on ? ' on' : '') + '">' + mark + '</i></button>';
    });
    return out + '</div>';
  }

  function statOf(groupId, total) {
    var s = stateOf(groupId);
    if (!s.field) return '默认：按持有市值降序 · 共 ' + total + ' 家';
    var meta = fieldMeta(s.field);
    return '当前：按' + meta.label + (s.dir === 'desc' ? '降序 ↓' : '升序 ↑') + ' · 共 ' + total + ' 家';
  }

  function _reset() { memo = null; }

  return {
    FIELDS: FIELDS, GROUP: GROUP, LS_KEY: LS_KEY,
    stateOf: stateOf, cycle: cycle, sortItems: sortItems,
    headerHtml: headerHtml, statOf: statOf, _reset: _reset,
  };
})();
