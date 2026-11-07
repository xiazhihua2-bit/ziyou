/* ==================== 股东持股情况（515450 · 独立子页） ====================
 * 入口：股票池页顶部「股东持股情况」按钮 → navTo({subPage:'holder'})。
 * 五 Tab 体系、TAB_IDS、tabOrder、同步层一律不动；快照不进 state / 导出 / 同步。
 *
 * 口径（与参考截图逐字段对齐，构建期真实取数、离线可用）：
 *   · 主体 = 515450 这只 ETF 作为「十大流通股东」出现在上市公司股东榜的汇总。
 *   · 持有市值 / 持股比例（占该股流通股本）/ 环比增减 / 持股排名 / 新进·增持·减仓标签。
 *   · 报告期 8 期可切（2024年报 ~ 2026三季报），行业分布按持有市值加权（前 5 + 其他）。
 *   · 行展开 = 该股在各报告期的持股数柱 + 持股比例折线（双轴），拖动读数 + 底部区间条。
 *
 * 状态边界：报告期 / 展开态放 S.ui（不落盘、不进同步）；brush 选区放模块内变量，
 * 拖动过程只替换主图 SVG，绝不 setUI 触发整页重渲（会打断 pointer capture）。
 */
XJ.views.holder = (function () {
  var U = XJ.util, S = XJ.store, H = XJ.holder515450;
  var HS = XJ.holderSort, HC = XJ.holderChart, CH = XJ.chart;

  var GROUP = 'holder';
  var BRUSH_KEY = 'holderBarsBrush';
  /* brush 选区：松手也不写 S.ui，避免整页重建打断手势 */
  var brushSel = { beg: null, end: null };

  function esc(s) { return U.esc(String(s === null || s === undefined ? '' : s)); }
  function fx(v, n) { return Number(v).toFixed(n === undefined ? 2 : n); }

  function periodOf() {
    var p = S.ui.holderPeriod || H.latest();
    var ps = H.periods();
    for (var i = 0; i < ps.length; i++) if (ps[i].end === p) return p;
    return H.latest();
  }
  function prevOf(end) {
    var ps = H.periods();
    for (var i = 0; i < ps.length; i++) if (ps[i].end === end) return i > 0 ? ps[i - 1].end : null;
    return null;
  }
  function labelOf(end) {
    var ps = H.periods();
    for (var i = 0; i < ps.length; i++) if (ps[i].end === end) return ps[i].label;
    return end;
  }

  /* ---------------- 数据（显示与排序共用同一份，口径不分叉） ---------------- */
  function rowsOf() {
    var list = H.rows(periodOf()).map(function (r) {
      return { r: r, __m: { cap: r.cap, ratio: r.ratio, chg: r.chg, rank: r.rank } };
    });
    return HS.sortItems(list, GROUP);
  }
  function detailSeries(code) {
    var all = H.seriesOf(code);
    var beg = brushSel.beg, end = brushSel.end;
    if (!beg || !end) return all;
    var out = all.filter(function (p) { return p.end >= beg && p.end <= end; });
    return out.length ? out : all;
  }

  /* ---------------- 各区块 ---------------- */
  function headHtml() {
    return '<div class="card holder-head">' +
      '<div class="hh-t"><i class="hh-bar"></i>股东持有上市公司</div>' +
      '<div class="tiny">南方标普中国A股大盘红利低波50ETF · 十大流通股东口径</div>' +
      '<div class="tiny">持股比例 = 占该股流通股本比例 · 持股排名 = 在十大流通股东中的名次</div>' +
      '</div>';
  }

  function filterHtml() {
    var cur = periodOf(), ps = H.periods().slice().reverse();
    var opts = ps.map(function (p) {
      return '<option value="' + esc(p.end) + '"' + (p.end === cur ? ' selected' : '') + '>' +
        esc(p.label) + '</option>';
    }).join('');
    return '<div class="holder-filter">' +
      '<label class="hf-l">股东类型：<select class="hf-sel" aria-label="股东类型" disabled>' +
      '<option>十大流通股东</option></select></label>' +
      '<label class="hf-r">报告期：<select class="hf-sel" data-change="holderPeriod" aria-label="报告期">' +
      opts + '</select></label></div>';
  }

  function statsHtml(end) {
    var s = H.statsOf(end);
    var cell = function (label, val, cls) {
      return '<div class="hs-cell"><span>' + label + '</span><b class="' + (cls || '') + '">' + val + '</b></div>';
    };
    return '<div class="holder-stats">' +
      cell('持股家数', s.total + '家') +
      cell('新进', s.fresh ? s.fresh + '家' : '--') +
      cell('加仓', s.up ? s.up + '家' : '--', 'c-up') +
      cell('不变', s.flat ? s.flat + '家' : '--') +
      cell('减仓', s.down ? s.down + '家' : '--', 'c-down') +
      '</div>';
  }

  function donutHtml(end) {
    var mix = H.industryMix(end, prevOf(end), 5);
    return '<div class="card holder-ind">' +
      '<div class="hi-t">持股行业分布(共参股' + H.rows(end).length + '家)</div>' +
      HC.donut(mix) +
      '<div class="tiny hi-note">按持有市值加权 · 括号内为较上一报告期的百分点变化</div>' +
      '</div>';
  }

  function tagOf(r) {
    if (r.st === '新进' || r.chg === null) return '<em class="hr-tag up">新进</em>';
    if (r.st === '加仓') return '<em class="hr-tag up">增持</em>';
    if (r.st === '减仓') return '<em class="hr-tag down">减仓</em>';
    return '';
  }

  function rowHtml(row, open) {
    var r = row.r;
    var av = '<div class="avatar" style="width:28px;height:28px;background:' + U.colorOf(r.s) + '">' +
      '<img class="av-img" src="' + esc(H.logoOf(r.c)) + '" alt="' + esc(r.n) + ' 官方标识" loading="lazy"></div>';
    var chg = r.chg === null ? '新进' : (r.chg > 0 ? '+' : '') + fx(r.chg) + '%';
    var chgCls = r.chg === null ? 'flat' : (r.chg > 0 ? 'up' : 'down');
    return '<div class="card holder-item" data-code="' + esc(r.c) + '">' +
      '<div class="holder-row" data-act="holderExpand" data-code="' + esc(r.c) + '">' +
      '<div class="hr-name">' + av +
      '<div class="hr-nm"><b>' + esc(r.n) + '</b><span>' + esc(r.c) + tagOf(r) + '</span></div></div>' +
      '<div class="hr-v">' + fx(r.cap / 1e8, 3) + '亿</div>' +
      '<div class="hr-v">' + fx(r.ratio) + '%</div>' +
      '<div class="hr-v ' + chgCls + '">' + chg + '</div>' +
      '<div class="hr-rank">' + (r.rank == null ? '—' : r.rank) +
      '<i class="hr-arrow">' + (open ? '⌃' : '⌄') + '</i></div>' +
      '</div>' +
      (open ? detailHtml(r) : '') + '</div>';
  }

  function detailHtml(r) {
    var code = r.c;
    var all = H.seriesOf(code);
    var main = HC.barsLine(detailSeries(code), { chartKey: 'holderBars' });
    var points = all.map(function (p) {
      return { date: p.end, y: p.sh === null ? 0 : p.sh / 1e4 };
    });
    var brush = '';
    if (CH && CH.brush && points.length >= 2) {
      brush = CH.brush(points, {
        chartKey: BRUSH_KEY,
        color: '#7FA6D9',
        onChange: function (beg, end) {
          brushSel = { beg: beg, end: end };
          /* 只替换主图：brush 是独立 SVG，重画它就会丢掉正在拖的手势 */
          var box = document.querySelector('.holder-detail .hd-main');
          if (box) box.innerHTML = HC.barsLine(detailSeries(code), { chartKey: 'holderBars' });
        },
      });
    }
    return '<div class="holder-detail" data-code="' + esc(code) + '">' +
      '<div class="hd-legend"><i class="hd-k bar"></i>持股数(股)<i class="hd-k line"></i>持股比例</div>' +
      '<div class="hd-main">' + main + '</div>' +
      (brush ? '<div class="hd-brush">' + brush + '</div>' : '') +
      '<button class="hd-more" data-act="holderOpenSymbol" data-sym="' + esc(r.s) + '">' +
      '查看 ' + esc(r.n) + ' 个股详情<span>›</span></button>' +
      '</div>';
  }

  function render() {
    var end = periodOf(), rows = rowsOf();
    var open = S.ui.holderExpand || null;
    return headHtml() +
      filterHtml() +
      statsHtml(end) +
      donutHtml(end) +
      HS.headerHtml(GROUP) +
      '<div class="holder-sortstat">' + esc(HS.statOf(GROUP, rows.length)) + '</div>' +
      '<div class="holder-list">' + rows.map(function (x) {
        return rowHtml(x, open === x.r.c);
      }).join('') + '</div>' +
      '<div class="holder-foot tiny">' +
      '数据截至 ' + esc(labelOf(end)) + '（' + esc(end) + '） · 取数日 ' + esc(H.FETCHED_ON) + '<br>' +
      '东财十大流通股东明细 · 静态快照离线可用 · 不随实时行情变动' +
      '</div>';
  }

  /* ---------------- 就地换序（不重建整页、不闪、不跳滚动） ---------------- */
  function applyOrder(rows) {
    var list = document.querySelector('.holder-list');
    if (!list || !rows.length) return false;
    var byCode = {};
    Array.prototype.forEach.call(list.children, function (el) {
      var c = el.getAttribute && el.getAttribute('data-code');
      if (c) byCode[c] = el;
    });
    if (Object.keys(byCode).length !== rows.length) return false;
    var used = {}, ordered = [];
    for (var i = 0; i < rows.length; i++) {
      var c = rows[i].r.c, el = byCode[c];
      if (!el || used[c]) return false;
      used[c] = true; ordered.push(el);
    }
    ordered.forEach(function (el) { list.appendChild(el); });
    return true;
  }
  function replaceBar() {
    var bar = document.querySelector('.holder-thead');
    if (bar) {
      var wrap = document.createElement('div');
      wrap.innerHTML = HS.headerHtml(GROUP);
      if (wrap.firstChild) bar.parentNode.replaceChild(wrap.firstChild, bar);
    }
    var stat = document.querySelector('.holder-sortstat');
    if (stat) stat.textContent = HS.statOf(GROUP, rowsOf().length);
  }
  function toggleSort(g, f) {
    if (g && g !== GROUP) return;
    HS.cycle(GROUP, f);
    if (applyOrder(rowsOf())) { replaceBar(); return; }
    S.setUI({ holderSortTick: Date.now() });
  }

  /* ---------------- 报告期 / 展开 ---------------- */
  function setPeriod(end) {
    brushSel = { beg: null, end: null };
    S.setUI({ holderPeriod: end, holderExpand: null });
    window.scrollTo(0, 0);
  }
  function toggleExpand(code) {
    var next = S.ui.holderExpand === code ? null : code;
    S.ui.holderExpand = next;                  // 不 notify：就地增删展开面板
    brushSel = { beg: null, end: null };
    var list = document.querySelector('.holder-list');
    if (!list) { S.setUI({ holderExpand: next }); return; }
    var rows = H.rows(periodOf()), hit = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].c === code) { hit = rows[i]; break; }
    Array.prototype.forEach.call(list.querySelectorAll('.holder-item'), function (el) {
      var c = el.getAttribute('data-code');
      var d = el.querySelector('.holder-detail');
      var isOpen = c === next;
      if (d && !isOpen) d.parentNode.removeChild(d);
      if (!d && isOpen && hit) el.insertAdjacentHTML('beforeend', detailHtml(hit));
      var ar = el.querySelector('.hr-arrow');
      if (ar) ar.textContent = isOpen ? '⌃' : '⌄';
    });
    HC.hideAll();
  }

  function bind() { HC.bind(); }

  function debug() {
    return {
      periods: H.periods().length,
      period: periodOf(),
      rows: H.rows(periodOf()).length,
      logos: Object.keys(H.LOGOS).length,
      industries: Object.keys(H.INDUSTRY).length,
      sort: HS.stateOf(GROUP),
      expand: S.ui.holderExpand || null,
      brush: !!brushSel.beg,
    };
  }

  return {
    render: render, bind: bind, debug: debug,
    toggleSort: toggleSort, toggleExpand: toggleExpand, setPeriod: setPeriod,
  };
})();
