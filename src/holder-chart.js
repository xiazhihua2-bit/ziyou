/* ==================== 股东持股情况 · 环形图 / 双轴柱线图 ====================
 * 零依赖内联 SVG，与项目 chart.js 同一套风格 fixed viewBox + width:100%。
 *
 * 分工：
 *   · donut()      行业分布环形图（前 5 大 + 其他）+ 图例与环比，配色对齐参考截图。
 *   · barsLine()   展开态：蓝色柱 = 持股数（左轴·万股），橙色折线 = 持股比例（右轴·%）。
 *   · 底部区间条  复用 XJ.chart.brush()（抓手 / 蒙版 / 拖动重绘保护都由它负责），
 *     本模块只提供主图；选区变化时视图只替换 .hd-main 里的主图 SVG，不碰 brush SVG。
 *   · 主图读数    自实现一套轻量拖动读数：chart.js 的 showAt() 固定按金额格式化，
 *     这里要显示「持股数 X万股 / 持股比例 Y%」，故用 svg[data-hb] 单独分流，
 *     与 chart.js 的 svg[data-chart] / svg[data-brush] 互不干扰。
 *
 * 未进入股东榜的期次为 null：不补零、不画假点，横轴按实际有数据的期次排列。
 */
XJ.holderChart = (function () {
  var U = XJ.util;
  var COLORS = ['#4A8FE0', '#F3B93F', '#9B6DD6', '#2FC2B4', '#EE5C9A', '#F58A2E'];
  var BLUE = '#3B82F6', ORANGE = '#F58A2E';

  function esc(s) { return U.esc(String(s === null || s === undefined ? '' : s)); }
  function fx(v, n) { return Number(v).toFixed(n === undefined ? 2 : n); }

  /* ---------------- 行业分布环形图 ---------------- */
  function donut(mix) {
    var list = mix || [];
    var R = 52, C = 2 * Math.PI * R, acc = 0;
    var segs = list.map(function (x, i) {
      var len = Math.max(0, x.pct) / 100 * C;
      var col = COLORS[i % COLORS.length];
      var s = '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="' + col +
        '" stroke-width="26" stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) +
        '" stroke-dashoffset="' + (-acc).toFixed(2) + '" transform="rotate(-90 70 70)"/>';
      acc += len;
      return s;
    }).join('');
    var legend = list.map(function (x, i) {
      var col = COLORS[i % COLORS.length];
      var d = x.hasPrev ? Math.round(x.delta) : null;
      var cls = d === null ? '' : (d > 0 ? 'up' : (d < 0 ? 'down' : 'flat'));
      var dtxt = d === null ? '' : (cls === 'up' ? '+' : '') + d + '%';
      return '<div class="hl-row"><i class="hl-dot" style="background:' + col + '"></i>' +
        '<span class="hl-nm">' + esc(x.name) + '</span>' +
        '<b class="hl-pct">' + fx(x.pct) + '%</b>' +
        (dtxt ? '<em class="hl-delta ' + cls + '">(' + esc(dtxt) + ')</em>' : '') + '</div>';
    }).join('');
    return '<div class="holder-donut">' +
      '<svg viewBox="0 0 140 140" class="holder-donut-svg" role="img" aria-label="持股行业分布环形图">' +
      segs + '</svg>' +
      '<div class="holder-legend">' + legend + '</div></div>';
  }

  /* ---------------- 双轴柱线图 ---------------- */
  var W = 360, H = 196, PL = 42, PR = 40, PT = 14, PB = 36;

  function niceMax(v) {
    if (!(v > 0) || !isFinite(v)) return 1;
    var mag = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
    var n = v / mag;
    var step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return step * mag;
  }
  function shortLabel(label) {
    var s = String(label || '');
    var m = /^(\d{4})(.*)$/.exec(s);
    if (!m) return s.slice(0, 4);
    return [m[1], m[2].replace(/报$/, '')];
  }

  /**
   * @param series [{end,label,sh,ratio,cap}] 已按报告期升序、已按 brush 选区切片
   * @return SVG 字符串；有效点少于 1 个返回 ''
   */
  function barsLine(series, opts) {
    opts = opts || {};
    var list = (series || []).filter(function (p) { return p && p.label; });
    if (!list.length) return '';
    var n = list.length;
    var x0 = PL, x1 = W - PR, y0 = PT, y1 = H - PB;
    var shMax = niceMax(Math.max.apply(null, list.map(function (p) { return p.sh === null ? 0 : p.sh / 1e4; })));
    var rtMax = niceMax(Math.max.apply(null, list.map(function (p) { return p.ratio === null ? 0 : p.ratio; })));
    function cx(i) { return x0 + (x1 - x0) * (i + 0.5) / n; }
    function pySh(v) { return y1 - (v / shMax) * (y1 - y0); }
    function pyRt(v) { return y1 - (v / rtMax) * (y1 - y0); }
    var bw = Math.max(6, Math.min(28, (x1 - x0) / n * 0.5));

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="holder-bars" data-hb="' +
      esc(opts.chartKey || 'holder') + '" data-n="' + n + '" data-x0="' + x0 + '" data-x1="' + x1 +
      '" data-y0="' + y0 + '" data-y1="' + y1 + '" data-shmax="' + shMax + '" data-rtmax="' + rtMax +
      '" data-hb-series="' + esc(JSON.stringify(list.map(function (p) {
        return { label: p.label, sh: p.sh, ratio: p.ratio };
      }))) + '" aria-label="持股数与持股比例走势">';

    /* 左右轴刻度与横向网格：共用 4 档，左右各自量程 */
    for (var k = 0; k <= 4; k++) {
      var y = y1 - (y1 - y0) * k / 4;
      svg += '<line x1="' + x0 + '" y1="' + y.toFixed(1) + '" x2="' + x1 + '" y2="' + y.toFixed(1) +
        '" style="stroke:var(--line)" stroke-width="1" stroke-dasharray="3 4"/>';
      svg += '<text x="' + (x0 - 5) + '" y="' + (y + 3.5).toFixed(1) + '" font-size="9.5" text-anchor="end" ' +
        'style="fill:var(--text-3)">' + esc(fx(shMax * k / 4, shMax >= 100 ? 0 : 1)) + '万</text>';
      svg += '<text x="' + (x1 + 5) + '" y="' + (y + 3.5).toFixed(1) + '" font-size="9.5" ' +
        'style="fill:var(--text-3)">' + esc(fx(rtMax * k / 4, 0)) + '%</text>';
    }

    /* 柱：持股数（万股） */
    list.forEach(function (p, i) {
      if (p.sh === null || !(p.sh > 0)) return;
      var top = pySh(p.sh / 1e4), h = Math.max(1, y1 - top);
      svg += '<rect x="' + (cx(i) - bw / 2).toFixed(1) + '" y="' + top.toFixed(1) +
        '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2" fill="' + BLUE + '"/>';
    });

    /* 折线：持股比例（%），跳过空期不连假点 */
    var seg = [], cur = [];
    list.forEach(function (p, i) {
      if (p.ratio === null) { if (cur.length) seg.push(cur); cur = []; return; }
      cur.push([cx(i).toFixed(1), pyRt(p.ratio).toFixed(1)]);
    });
    if (cur.length) seg.push(cur);
    seg.forEach(function (pts) {
      if (pts.length < 1) return;
      var d = pts.map(function (q, i) { return (i ? 'L' : 'M') + q[0] + ' ' + q[1]; }).join('');
      svg += '<path d="' + d + '" fill="none" stroke="' + ORANGE + '" stroke-width="1.8" ' +
        'stroke-linejoin="round" stroke-linecap="round"/>';
    });
    list.forEach(function (p, i) {
      if (p.ratio === null) return;
      svg += '<circle cx="' + cx(i).toFixed(1) + '" cy="' + pyRt(p.ratio).toFixed(1) +
        '" r="2.8" fill="' + ORANGE + '"/>';
    });

    /* 横轴：n>5 时隔一个显示，避免 8 期标签挤成一团 */
    list.forEach(function (p, i) {
      if (n > 5 && i % 2 === 1 && i !== n - 1) return;
      var sl = shortLabel(p.label);
      svg += '<text x="' + cx(i).toFixed(1) + '" y="' + (y1 + 16) + '" font-size="9" text-anchor="middle" ' +
        'style="fill:var(--text-3)">' + esc(sl[0]) + '</text>';
      svg += '<text x="' + cx(i).toFixed(1) + '" y="' + (y1 + 27) + '" font-size="9" text-anchor="middle" ' +
        'style="fill:var(--text-3)">' + esc(sl[1]) + '</text>';
    });

    /* 拖动读数：竖虚线 + 气泡（抬起后保留，点别处才收起） */
    svg += '<g class="hb-marker" style="display:none">' +
      '<line class="hb-vline" y1="' + y0 + '" y2="' + y1 + '" style="stroke:var(--text-3)" stroke-width="1" stroke-dasharray="3 3"/>' +
      '<g class="hb-bub">' +
      '<rect rx="7" width="132" height="49" fill="rgba(28,28,30,0.92)"/>' +
      '<text class="hb-d" x="9" y="14" font-size="9" fill="rgba(255,255,255,0.7)"></text>' +
      '<text class="hb-sh" x="9" y="29" font-size="10.5" font-weight="700" fill="#fff"></text>' +
      '<text class="hb-rt" x="9" y="43" font-size="10.5" font-weight="700" fill="#fff"></text>' +
      '</g></g>';
    return svg + '</svg>';
  }

  /* ---------------- 主图拖动读数 ---------------- */
  var bound = false, active = null;

  function locate(svg, clientX) {
    var rect = svg.getBoundingClientRect();
    var ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    var vx = Math.max(0, Math.min(1, ratio)) * W;
    var n = +svg.getAttribute('data-n') || 1;
    var x0 = +svg.getAttribute('data-x0'), x1 = +svg.getAttribute('data-x1');
    var i = Math.round((vx - x0) / (x1 - x0) * n - 0.5);
    return Math.max(0, Math.min(n - 1, i));
  }

  function showAt(svg, i) {
    var data;
    try { data = JSON.parse(svg.getAttribute('data-hb-series') || '[]'); } catch (e) { return; }
    var p = data[i];
    if (!p) return;
    var g = svg.querySelector('.hb-marker');
    if (!g) return;
    var n = +svg.getAttribute('data-n') || 1;
    var x0 = +svg.getAttribute('data-x0'), x1 = +svg.getAttribute('data-x1');
    var x = x0 + (x1 - x0) * (i + 0.5) / n;
    g.style.display = '';
    var vl = g.querySelector('.hb-vline');
    vl.setAttribute('x1', x.toFixed(1)); vl.setAttribute('x2', x.toFixed(1));
    var bw = 132;
    var bx = Math.max(0, Math.min(W - bw, x - bw / 2));
    g.querySelector('.hb-bub').setAttribute('transform', 'translate(' + bx.toFixed(1) + ',16)');
    g.querySelector('.hb-d').textContent = p.label;
    g.querySelector('.hb-sh').textContent = '持股数(股)  ' +
      (p.sh === null ? '—' : fx(p.sh / 1e4, 2) + '万');
    g.querySelector('.hb-rt').textContent = '持股比例  ' +
      (p.ratio === null ? '—' : fx(p.ratio, 2) + '%');
  }

  function hideAll() {
    var list = document.querySelectorAll('svg[data-hb] .hb-marker');
    Array.prototype.forEach.call(list, function (g) { g.style.display = 'none'; });
  }

  function bind() {
    if (bound) return;
    bound = true;
    document.addEventListener('pointerdown', function (e) {
      var t = e.target;
      var svg = t && t.closest ? t.closest('svg[data-hb]') : null;
      if (!svg) { hideAll(); active = null; return; }
      active = svg;
      try { svg.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      showAt(svg, locate(svg, e.clientX));
      e.preventDefault();
    }, { passive: false });
    document.addEventListener('pointermove', function (e) {
      if (!active || !document.body.contains(active)) return;
      showAt(active, locate(active, e.clientX));
      e.preventDefault();
    }, { passive: false });
    document.addEventListener('pointerup', function () { active = null; });
    document.addEventListener('pointercancel', function () { active = null; });
  }

  return {
    COLORS: COLORS, donut: donut, barsLine: barsLine,
    bind: bind, hideAll: hideAll, niceMax: niceMax,
  };
})();
