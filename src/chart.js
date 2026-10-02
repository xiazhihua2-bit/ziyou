/* ==================== 资产变动曲线（参照同花顺） ====================
 * 零依赖内联 SVG。特性：
 *   · 纵轴金额刻度（自动取整）+ 横向网格线
 *   · 横轴日期刻度（首 / 中 / 末）
 *   · 面积渐变 + 涨红跌绿描边
 *   · 按下并拖动查看任意一天的数值（十字虚线 + 高亮点 + 气泡）
 * 固定内部坐标系 360×220，配 width:100%;height:auto —— 各端等比缩放，文字不变形。
 */
XJ.chart = (function () {
  var U = XJ.util;

  var W = 360, H = 220;
  var PL = 6, PR = 46, PT = 16, PB = 26;      // 左/右/上/下内边距（右侧留给纵轴标签）

  /** 把区间切成 3~5 个"整齐"的刻度（1/2/5 × 10^n 步长） */
  function niceScale(min, max, count) {
    count = count || 4;
    if (!isFinite(min) || !isFinite(max)) return { lo: 0, hi: 1, ticks: [0, 1] };
    if (max === min) { min -= 1; max += 1; }
    var range = max - min;
    var rough = range / count;
    var mag = Math.pow(10, Math.floor(Math.log(rough) / Math.LN10));
    var norm = rough / mag;
    var step = mag * (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1);
    var lo = Math.floor(min / step) * step;
    var hi = Math.ceil(max / step) * step;
    var ticks = [];
    for (var v = lo; v <= hi + step * 1e-6; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return { lo: lo, hi: hi, ticks: ticks };
  }

  function shortDate(d) { return String(d || '').slice(5).replace('-', '/'); }
  function ymdShort(d) {
    var s = String(d || '');
    return s.length >= 10 ? s.slice(2, 4) + '/' + s.slice(5, 7) + '/' + s.slice(8, 10) : s;
  }

  function esc(s) { return U.esc(String(s === null || s === undefined ? '' : s)); }

  var gradSeq = 0;

  /** 两个 'YYYY-MM-DD' 相差几天（用于散点吸附的距离闸门）；无法解析时返回 Infinity */
  function dayGap(a, b) {
    var g = U.daysBetween(a, b);
    return g === null ? Infinity : Math.abs(g);
  }

  /** 在有序日期数组里找与 d 最接近的下标（二分，找不到返回 -1） */
  function nearestDateIndex(dates, d) {
    var n = dates.length;
    if (!n) return -1;
    if (d <= dates[0]) return 0;
    if (d >= dates[n - 1]) return n - 1;
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (dates[mid] <= d) lo = mid; else hi = mid;
    }
    /* 谁离得近取谁 —— 必须按「天数」比，直接相减是字符串运算会得到 NaN */
    return dayGap(dates[lo], d) <= dayGap(dates[hi], d) ? lo : hi;
  }

  /* 散点吸附的最大容忍天数：超过就不画，避免把十年外的日期吸到曲线最左端 */
  var MARK_SNAP_DAYS = 7;

  /**
   * @param series [{ date:'YYYY-MM-DD', mv:number }] 按日期升序，至少 2 点
   * @param opts   { fmtY, xFormat:'short'|'ymd', xTicks, label }
   */
  function render(series, opts) {
    opts = opts || {};
    if (!series || series.length < 2) return '';

    var vals = series.map(function (p) { return p.mv; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var sc = niceScale(min, max, 4);
    var span = (sc.hi - sc.lo) || 1;
    var fmtY = opts.fmtY || U.moneyCompact;

    var x0 = PL, x1 = W - PR, y0 = PT, y1 = H - PB;
    var n = series.length;
    function px(i) { return n > 1 ? x0 + (x1 - x0) * (i / (n - 1)) : (x0 + x1) / 2; }
    function py(v) { return y1 - (v - sc.lo) / span * (y1 - y0); }

    var line = series.map(function (p, i) {
      return (i ? 'L' : 'M') + px(i).toFixed(1) + ' ' + py(p.mv).toFixed(1);
    }).join('');
    var area = line + ' L' + x1.toFixed(1) + ' ' + y1.toFixed(1) + ' L' + x0.toFixed(1) + ' ' + y1.toFixed(1) + ' Z';

    var up = vals[n - 1] >= vals[0];
    var color = opts.color || (up ? '#E0312F' : '#12A150');
    /* 渐变 id 必须每次唯一：一页可能有不止一张图，重复 id 会让后一张取到前一张的渐变 */
    var gid = 'xjcGrad' + (++gradSeq);

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="xj-chart" data-chart="' +
      esc(opts.chartKey || 'asset') + '"' +
      ' data-n="' + n + '" data-x0="' + x0 + '" data-x1="' + x1 + '"' +
      ' data-y0="' + y0 + '" data-y1="' + y1 + '" data-lo="' + sc.lo + '" data-hi="' + sc.hi + '"' +
      ' data-series="' + esc(JSON.stringify(series.map(function (p) { return { d: p.date, v: p.mv }; }))) + '">';

    svg += '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.24"/>' +
      '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>';

    /* 网格线 + 纵轴金额刻度 */
    sc.ticks.forEach(function (t) {
      var y = py(t);
      if (y < y0 - 1.5 || y > y1 + 1.5) return;
      svg += '<line x1="' + x0 + '" y1="' + y.toFixed(1) + '" x2="' + x1 + '" y2="' + y.toFixed(1) +
        '" style="stroke:var(--line)" stroke-width="1" stroke-dasharray="3 4"/>';
      svg += '<text x="' + (x1 + 5) + '" y="' + (y + 3.5).toFixed(1) + '" font-size="10" style="fill:var(--text-3)">' +
        esc(fmtY(t)) + '</text>';
    });

    svg += '<path d="' + area + '" fill="url(#' + gid + ')"/>';
    svg += '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="2" ' +
      'stroke-linejoin="round" stroke-linecap="round"/>';

    /* 横轴日期刻度：默认首/中/末三点，图 6 风格用 5 点 + yy/mm/dd */
    var want = opts.xTicks || (n >= 4 ? 3 : 2);
    var idxs = [];
    for (var k = 0; k < want; k++) {
      idxs.push(Math.round(k * (n - 1) / (want - 1)));
    }
    var seen = {};
    idxs = idxs.filter(function (i) { if (seen[i]) return false; seen[i] = 1; return true; });
    var fmtX = opts.xFormat === 'ymd' ? ymdShort : shortDate;
    idxs.forEach(function (i) {
      var anchor = (i === 0) ? 'start' : (i === n - 1) ? 'end' : 'middle';
      svg += '<text x="' + px(i).toFixed(1) + '" y="' + (y1 + 16) + '" font-size="10" ' +
        'style="fill:var(--text-3)" text-anchor="' + anchor + '">' + esc(fmtX(series[i].date)) + '</text>';
    });

    /* 标记组（拖动时显示） */
    svg += '<g class="xjc-marker" style="display:none">' +
      '<line class="xjc-vline" y1="' + y0 + '" y2="' + y1 + '" style="stroke:var(--text-2)" stroke-width="1" stroke-dasharray="3 3"/>' +
      '<circle class="xjc-dot" r="4.5" fill="#fff" stroke="' + color + '" stroke-width="2.5"/>' +
      '<g class="xjc-bub">' +
      '<rect rx="7" width="94" height="33" fill="rgba(28,28,30,0.92)"/>' +
      '<text class="xjc-bub-v" x="47" y="14.5" font-size="11.5" font-weight="700" fill="#fff" text-anchor="middle"></text>' +
      '<text class="xjc-bub-d" x="47" y="26.5" font-size="9" fill="rgba(255,255,255,0.72)" text-anchor="middle"></text>' +
      '</g></g>';

    svg += '</svg>';
    return svg;
  }

  /* ---------------- 多序列对比图（收益率 + 指数） ----------------
   * seriesList: [{ key, name, color, points:[{date, pct}], candles?:[{date,o,h,l,c}] }]
   * opts: { xTicks, height, mode:'line'|'candle', unit:'%'|'¥' }
   *
   * 与单序列图的区别：
   *   · 多条曲线各自配色（图例与曲线同色）
   *   · 拖动时显示**竖向高亮带** + 一次性列出所有曲线在该日的读数
   *   · 支持蜡烛图（指数的 OHLC 已换算成相对起点的收益率）
   */
  var CW = 360, CH = 196;
  var CPL = 8, CPR = 46, CPT = 14, CPB = 24;

  function renderCompare(seriesList, opts) {
    opts = opts || {};
    seriesList = (seriesList || []).filter(function (s) { return s && s.points && s.points.length; });
    if (!seriesList.length) return '';

    /* 横轴用所有曲线日期的并集（不同市场交易日不同） */
    var dateSet = {};
    seriesList.forEach(function (s) { s.points.forEach(function (p) { dateSet[p.date] = true; }); });
    if (opts.candles) opts.candles.forEach(function (c) { dateSet[c.date] = true; });
    /* 注意：散点的日期【不】并入 —— 它们会被吸附到第一条曲线已有的点上（见下），
       若并进来就等于给它们各开了一格，既毁掉吸附、又让横轴出现非均匀的时间步长。 */
    var dates = Object.keys(dateSet).sort();
    if (dates.length < 2) return '';
    var di = {};
    dates.forEach(function (d, i) { di[d] = i; });

    /* 纵轴范围：所有曲线的百分比 + 蜡烛的高低点都算进去 */
    var vals = [];
    seriesList.forEach(function (s) { s.points.forEach(function (p) { vals.push(U.n0(p.pct)); }); });
    if (opts.candles) {
      opts.candles.forEach(function (c) { vals.push(U.n0(c.l), U.n0(c.h)); });
    }
    if (!vals.length) return '';
    var sc = niceScale(Math.min.apply(null, vals), Math.max.apply(null, vals), 4);
    var span = (sc.hi - sc.lo) || 1;
    var fmtY = opts.fmtY || U.pctAxis;

    var x0 = CPL, x1 = CW - CPR, y0 = CPT, y1 = CH - CPB;
    var n = dates.length;
    function px(i) { return n > 1 ? x0 + (x1 - x0) * (i / (n - 1)) : (x0 + x1) / 2; }
    function py(v) { return y1 - (v - sc.lo) / span * (y1 - y0); }

    var gid = 'xjCmp' + (++gradSeq);
    var svg = '<svg viewBox="0 0 ' + CW + ' ' + CH + '" class="xj-chart xj-cmp" data-chart="' +
      esc(opts.chartKey || 'cmp') + '"' +
      ' data-n="' + n + '" data-x0="' + x0 + '" data-x1="' + x1 + '"' +
      ' data-y0="' + y0 + '" data-y1="' + y1 + '" data-lo="' + sc.lo + '" data-hi="' + sc.hi + '"' +
      ' data-cmp="' + esc(JSON.stringify({
        dates: dates,
        unit: opts.unit || '%',
        rows: seriesList.map(function (s) {
          var arr = new Array(n);
          s.points.forEach(function (p) { arr[di[p.date]] = p.pct; });
          /* ★ 前值填充 + 前向回填。
             横轴是各曲线日期的**并集**（不同市场交易日不同；余额宝基准更是周频），
             所以某条曲线在别的曲线的日期上一定有点是空的。
             不填的话拖动读数就是「—」——而曲线明明画着（折线在两点间隐含了前值），
             看起来就像「这一天没有股息率」，实际只是那天没有观测点。
             开头那一段没有更早的值可继承，用第一个已知值回填，保证任何一天都有读数。 */
          var last = null, q;
          for (q = 0; q < n; q++) {
            if (arr[q] !== undefined && arr[q] !== null) last = arr[q];
            else if (last !== null) arr[q] = last;
          }
          last = null;
          for (q = n - 1; q >= 0; q--) {
            if (arr[q] !== undefined && arr[q] !== null) last = arr[q];
            else if (last !== null) arr[q] = last;
          }
          return { name: s.name, color: s.color, vals: arr };
        }),
      })) + '">';

    svg += '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + (seriesList[0].color || '#E8461F') + '" stop-opacity="0.16"/>' +
      '<stop offset="100%" stop-color="' + (seriesList[0].color || '#E8461F') + '" stop-opacity="0"/></linearGradient></defs>';

    /* 0% 基准线单独强调（对比图里 0 轴最有意义） */
    sc.ticks.forEach(function (t) {
      var y = py(t);
      if (y < y0 - 1.5 || y > y1 + 1.5) return;
      var isZero = Math.abs(t) < 1e-9;
      svg += '<line x1="' + x0 + '" y1="' + y.toFixed(1) + '" x2="' + x1 + '" y2="' + y.toFixed(1) +
        '" style="stroke:' + (isZero ? 'var(--text-3)' : 'var(--line)') + '" stroke-width="1" stroke-dasharray="3 4"/>';
      svg += '<text x="' + (x1 + 5) + '" y="' + (y + 3.5).toFixed(1) + '" font-size="9.5" style="fill:' +
        (isZero ? 'var(--text-2)' : 'var(--text-3)') + '">' + esc(fmtY(t)) + '</text>';
    });

    /* 自定义基准虚线（如覆盖率卡的 100% 🎉）：独立于刻度线，只在值落在量程内时画 */
    if (opts.hline && opts.hline.value !== undefined) {
      var hv = Number(opts.hline.value);
      if (isFinite(hv) && hv >= sc.lo && hv <= sc.hi) {
        var hy = py(hv);
        svg += '<line x1="' + x0 + '" y1="' + hy.toFixed(1) + '" x2="' + x1 + '" y2="' + hy.toFixed(1) +
          '" style="stroke:' + (opts.hline.color || 'var(--payout)') + '" stroke-width="1.2" stroke-dasharray="5 4"/>';
        if (opts.hline.label) {
          svg += '<text x="' + (x0 + 4) + '" y="' + (hy - 4).toFixed(1) + '" font-size="9.5" style="fill:' +
            (opts.hline.color || 'var(--payout)') + '">' + esc(opts.hline.label) + '</text>';
        }
      }
    }

    /* 蜡烛（可选，指数）—— 先画，避免压住折线 */
    if (opts.candles && opts.candles.length) {
      var candleColor = opts.candleColor || '#8E8E93';
      var bw = Math.max(2.5, Math.min(10, (x1 - x0) / Math.max(dates.length, 1) * 0.66));
      opts.candles.forEach(function (c) {
        var i = di[c.date];
        if (i === undefined) return;
        var x = px(i);
        var up = c.c >= c.o;
        var col = up ? '#E0312F' : '#12A150';
        var yo = py(c.o), yc = py(c.c), yh = py(c.h), yl = py(c.l);
        svg += '<line x1="' + x.toFixed(1) + '" y1="' + yh.toFixed(1) + '" x2="' + x.toFixed(1) +
          '" y2="' + yl.toFixed(1) + '" stroke="' + col + '" stroke-width="1" vector-effect="non-scaling-stroke"/>';
        var top = Math.min(yo, yc), hgt = Math.max(1, Math.abs(yc - yo));
        svg += '<rect x="' + (x - bw / 2).toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + bw.toFixed(1) +
          '" height="' + hgt.toFixed(1) + '" fill="' + (up ? 'none' : col) + '" stroke="' + col +
          '" stroke-width="1" vector-effect="non-scaling-stroke"/>';
      });
      void candleColor;
    }

    /* 面积填充（可选，opts.area）：只支持第一条曲线（渐变 gid 只绑定了它的颜色）。
       画在折线之下 —— 先插面积 path，再走下面的折线循环。 */
    if (opts.area && seriesList[0] && seriesList[0].points.length > 1) {
      var s0 = seriesList[0];
      var d0 = s0.points.map(function (p, i) {
        return (i ? 'L' : 'M') + px(di[p.date]).toFixed(1) + ' ' + py(p.pct).toFixed(1);
      }).join('');
      if (d0) {
        var lastPt = s0.points[s0.points.length - 1];
        var areaPath = d0 + ' L' + px(di[lastPt.date]).toFixed(1) + ' ' + y1.toFixed(1) +
          ' L' + px(di[s0.points[0].date]).toFixed(1) + ' ' + y1.toFixed(1) + ' Z';
        svg += '<path d="' + areaPath + '" fill="url(#' + gid + ')" stroke="none"/>';
      }
    }

    /* 曲线 */
    seriesList.forEach(function (s) {
      var d = s.points.map(function (p, i) {
        return (i ? 'L' : 'M') + px(di[p.date]).toFixed(1) + ' ' + py(p.pct).toFixed(1);
      }).join('');
      if (!d) return;
      svg += '<path d="' + d + '" fill="none" stroke="' + (s.color || '#E8461F') +
        '" stroke-width="' + (s.width || 1.8) + '"' +
        (s.dash ? ' stroke-dasharray="' + esc(s.dash) + '" stroke-linecap="butt"' : ' stroke-linecap="round"') +
        ' stroke-linejoin="round"/>';
    });

    /* 散点标记（如「除权除息日」）—— 画在曲线之上、拖动标记之下。
       每个散点先「吸附」到**第一条曲线上最近的已有日期**，再取该日期的值定位。
       为什么是「第一条曲线自己的日期」而不是横轴并集：并集里可能混入别的曲线
       （比如余额宝基准）独有的日期，吸附过去就会取不到值而整个标记消失。
       这样也保证散点永远落在曲线上，且不会插入非均匀的时间格。
       吸附距离超过 MARK_SNAP_DAYS 就丢弃，避免把十年外的日期吸到曲线最左端画出假点。 */
    if (opts.markers && opts.markers.length && seriesList[0]) {
      var mcolor = opts.markerColor || '#E8862A';
      var s0 = seriesList[0];
      var s0dates = s0.points.map(function (p) { return p.date; }).slice().sort();
      var v0 = {};
      s0.points.forEach(function (p) { v0[p.date] = p.pct; });
      var marks = '';
      var lastDate = s0dates[s0dates.length - 1];
      opts.markers.forEach(function (m) {
        var md = typeof m === 'string' ? m : (m && m.date);
        if (!md) return;
        /* 晚于曲线最后一天的散点直接丢弃：它会被吸附到最右端，等于把「未来才除权」
           画成「已经发生过」，是个会误导人的位置错。等那天有价格了再画。 */
        if (md > lastDate) return;
        var idx = nearestDateIndex(s0dates, md);
        if (idx < 0) return;
        var snapped = s0dates[idx];
        if (dayGap(snapped, md) > MARK_SNAP_DAYS) return;
        var val = U.num(v0[snapped]);
        if (val === null) return;
        marks += '<circle cx="' + px(di[snapped]).toFixed(1) + '" cy="' + py(val).toFixed(1) +
          '" r="3.1" fill="' + mcolor + '"/>';
      });
      if (marks) svg += '<g class="xjc-marks">' + marks + '</g>';
    }

    /* 横轴日期 */
    var want = opts.xTicks || 4;
    var idxs = [], seen = {};
    for (var k = 0; k < want; k++) {
      var ii = Math.round(k * (n - 1) / (want - 1));
      if (!seen[ii]) { seen[ii] = 1; idxs.push(ii); }
    }
    idxs.forEach(function (i) {
      var anchor = (i === 0) ? 'start' : (i === n - 1) ? 'end' : 'middle';
      svg += '<text x="' + px(i).toFixed(1) + '" y="' + (y1 + 15) + '" font-size="9.5" style="fill:var(--text-3)" ' +
        'text-anchor="' + anchor + '">' + esc(ymdShort(dates[i])) + '</text>';
    });

    /* 拖动标记：竖向高亮带 + 多值气泡
       气泡宽度按内容估算 —— 早先写死 132，长名字/长金额会被截断（用户反馈「净资产显示不完整」） */
    var rowH = 15;
    var estW = function (t, fs) {
      var w = 0, str = String(t === null || t === undefined ? '' : t);
      for (var k = 0; k < str.length; k++) {
        w += str.charCodeAt(k) > 0x2e80 ? fs : fs * 0.56;   // CJK 按整字宽，其余按半宽估
      }
      return w;
    };
    var bubW = 96;
    seriesList.forEach(function (s) {
      /* 名字（最多显示 6 字）+ 数值（按最长的可能形态估） */
      var nmW = estW(String(s.name || '').slice(0, 6), 9.5);
      var valW = estW(opts.unit === 'money' ? '-¥0,000,000' : '-000.00%', 9.5);
      bubW = Math.max(bubW, 21 + nmW + 16 + valW + 11);
    });
    var bubH = seriesList.length * rowH + 16;
    svg += '<g class="xjc-cmpmarker" style="display:none">' +
      '<rect class="xjc-band" y="' + y0 + '" width="14" height="' + (y1 - y0) + '" fill="#E8A87C" fill-opacity="0.18" rx="2"/>' +
      '<line class="xjc-vline" y1="' + y0 + '" y2="' + y1 + '" style="stroke:var(--text-3)" stroke-width="1" stroke-dasharray="3 3"/>' +
      '<g class="xjc-cmpbub">' +
      '<rect rx="7" width="' + bubW + '" height="' + bubH + '" fill="rgba(28,28,30,0.92)"/>' +
      '<text class="xjc-cmpd" x="11" y="12" font-size="9" fill="rgba(255,255,255,0.66)"></text>' +
      seriesList.map(function (s, r) {
        return '<g class="xjc-cmprow" data-row="' + r + '">' +
          '<circle cx="10" cy="' + (18 + r * rowH + 4) + '" r="3" fill="' + (s.color || '#fff') + '"/>' +
          '<text class="xjc-cmpn" x="18" y="' + (21 + r * rowH + 4) + '" font-size="9.5" fill="rgba(255,255,255,0.8)"></text>' +
          '<text class="xjc-cmpv" x="' + (bubW - 8) + '" y="' + (21 + r * rowH + 4) +
          '" font-size="9.5" font-weight="700" fill="#fff" text-anchor="end"></text>' +
          '</g>';
      }).join('') +
      '</g></g>';

    svg += '</svg>';
    return svg;
  }

  /* ---------------- 时间范围选择条（brush） ----------------
   * 参考图底部那条：一条概览曲线 + 左右两个抓手指明当前可见区间。
   *
   * 为什么独立成第二个 <svg> 而不是画进主图：
   *   1) 拖动时要实时重画主图。若抓手和主图同在一个 <svg> 里，
   *      重画 innerHTML 会把抓手自身也删掉，正在进行的 pointer capture 随之中断、手势直接断；
   *   2) 完全不用去动主图 CPR / CPB 的底部留白与 px/py 坐标换算。
   *
   * BG_LABEL_Y 之上是两端日期标签（与参考图一致：日期在主图与概览条之间）。
   */
  var BW = 360, BH = 54;
  var B_LABEL_Y = 9, B_TOP = 18, B_BOT = 50;
  var B_HANDLE_W = 15, B_HANDLE_H = 22, B_MIN_SPAN = 2;

  /* 渲染输入按 chartKey 存一份：brush 拖动时要据此切片重画主图。
     不放在 DOM 的 data-* 里 —— 十年 × 多列的 JSON 塞进属性既慢又易踩转义坑。 */
  var brushReg = {};

  function brushX(idx, n) { return n > 1 ? (idx / (n - 1)) * BW : BW / 2; }

  function handleMarkup(side) {
    var s = '<g class="xjc-brush-h" data-side="' + side + '">' +
      '<rect x="' + (-B_HANDLE_W / 2) + '" y="' + (-B_HANDLE_H / 2) + '" width="' + B_HANDLE_W + '" height="' + B_HANDLE_H +
      '" rx="5" style="fill:var(--bg-elev);stroke:var(--line)" stroke-width="1" vector-effect="non-scaling-stroke"/>';
    /* 参考图抓手上的「III」三道竖线 */
    [-3, 0, 3].forEach(function (dx) {
      s += '<line x1="' + dx + '" y1="-5" x2="' + dx + '" y2="5" style="stroke:var(--text-3)" stroke-width="1.4" ' +
        'stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
    });
    return s + '</g>';
  }

  /**
   * @param points [{date, y}] 概览用的全量序列（升序，至少 2 点）
   * @param opts   { chartKey, begIdx, endIdx, onChange(begDate, endDate, isFinal), color }
   * @return SVG 字符串；points 不足时返回 ''
   */
  function brush(points, opts) {
    opts = opts || {};
    var list = (points || []).filter(function (p) { return p && p.date && U.num(p.y) !== null; });
    if (list.length < 2) return '';
    var key = opts.chartKey || 'cmp';
    var n = list.length;
    var i0 = Math.max(0, Math.min(n - 1, U.num(opts.begIdx) === null ? 0 : Math.round(U.num(opts.begIdx))));
    var i1 = Math.max(0, Math.min(n - 1, U.num(opts.endIdx) === null ? n - 1 : Math.round(U.num(opts.endIdx))));
    if (i1 - i0 < B_MIN_SPAN) i1 = Math.min(n - 1, i0 + B_MIN_SPAN);
    if (i1 - i0 < B_MIN_SPAN) i0 = Math.max(0, i1 - B_MIN_SPAN);

    brushReg[key] = { points: list, opts: opts };

    var vals = list.map(function (p) { return U.num(p.y) || 0; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var span = (hi - lo) || Math.max(Math.abs(hi) * 0.001, 1e-6);
    function by(v) { return B_BOT - ((v - lo) / span) * (B_BOT - B_TOP); }

    var line = '';
    for (var k = 0; k < n; k++) {
      line += (k ? 'L' : 'M') + brushX(k, n).toFixed(1) + ' ' + by(vals[k]).toFixed(1);
    }
    var area = line + ' L' + BW + ' ' + B_BOT + ' L0 ' + B_BOT + ' Z';
    var color = opts.color || '#7FA6D9';
    var xa0 = brushX(i0, n), xb0 = brushX(i1, n);

    var svg = '<svg viewBox="0 0 ' + BW + ' ' + BH + '" class="xj-brush" data-brush="' + esc(key) +
      '" data-n="' + n + '">' +
      '<text class="xjc-brush-beg" x="0" y="' + B_LABEL_Y + '" font-size="10.5" style="fill:var(--text-2)">' +
      esc(list[i0].date) + '</text>' +
      '<text class="xjc-brush-end" x="' + BW + '" y="' + B_LABEL_Y +
      '" font-size="10.5" style="fill:var(--text-2)" text-anchor="end">' + esc(list[i1].date) + '</text>' +
      '<rect x="0" y="' + B_TOP + '" width="' + BW + '" height="' + (B_BOT - B_TOP) +
      '" rx="7" style="fill:var(--glass-bg-2)"/>' +
      '<path d="' + area + '" fill="' + color + '" fill-opacity="0.34"/>' +
      /* 选中区间之外压一层浅色蒙版（参考图就是这个效果） */
      '<rect class="xjc-brush-mask" data-side="l" x="0" y="' + B_TOP + '" width="' + xa0.toFixed(1) +
      '" height="' + (B_BOT - B_TOP) + '" style="fill:var(--glass-bg-2)" fill-opacity="0.78"/>' +
      '<rect class="xjc-brush-mask" data-side="r" x="' + xb0.toFixed(1) + '" y="' + B_TOP + '" width="' +
      Math.max(0, BW - xb0).toFixed(1) + '" height="' + (B_BOT - B_TOP) + '" style="fill:var(--glass-bg-2)" fill-opacity="0.78"/>' +
      '<rect class="xjc-brush-sel" x="' + xa0.toFixed(1) + '" y="' + (B_TOP - 1) + '" width="' +
      Math.max(0, xb0 - xa0).toFixed(1) + '" height="' + (B_BOT - B_TOP + 2) +
      '" fill="none" style="stroke:var(--brush-line)" stroke-width="1" rx="6" vector-effect="non-scaling-stroke"/>' +
      '<g class="xjc-brush-hl" data-side="l" transform="translate(' + xa0.toFixed(1) + ',' + ((B_TOP + B_BOT) / 2) + ')">' +
      handleMarkup('l') + '</g>' +
      '<g class="xjc-brush-hr" data-side="r" transform="translate(' + xb0.toFixed(1) + ',' + ((B_TOP + B_BOT) / 2) + ')">' +
      handleMarkup('r') + '</g>' +
      '</svg>';
    return svg;
  }

  /** 依据当前 i0/i1 就地更新 brush 的抓手/蒙版/日期标签（不重画整个 SVG，保住 pointer capture） */
  function paintBrush(svg, i0, i1) {
    var key = svg.getAttribute('data-brush');
    var reg = brushReg[key];
    if (!reg) return;
    var n = reg.points.length;
    var xa = brushX(i0, n), xb = brushX(i1, n);
    var hl = svg.querySelector('.xjc-brush-hl'), hr = svg.querySelector('.xjc-brush-hr');
    var yMid = (B_TOP + B_BOT) / 2;
    if (hl) hl.setAttribute('transform', 'translate(' + xa.toFixed(1) + ',' + yMid + ')');
    if (hr) hr.setAttribute('transform', 'translate(' + xb.toFixed(1) + ',' + yMid + ')');
    var ml = svg.querySelector('.xjc-brush-mask[data-side="l"]');
    var mr = svg.querySelector('.xjc-brush-mask[data-side="r"]');
    if (ml) ml.setAttribute('width', Math.max(0, xa).toFixed(1));
    if (mr) { mr.setAttribute('x', xb.toFixed(1)); mr.setAttribute('width', Math.max(0, BW - xb).toFixed(1)); }
    var sel = svg.querySelector('.xjc-brush-sel');
    if (sel) { sel.setAttribute('x', xa.toFixed(1)); sel.setAttribute('width', Math.max(0, xb - xa).toFixed(1)); }
    var beg = svg.querySelector('.xjc-brush-beg'), end = svg.querySelector('.xjc-brush-end');
    if (beg) beg.textContent = reg.points[i0] ? reg.points[i0].date : '';
    if (end) end.textContent = reg.points[i1] ? reg.points[i1].date : '';
  }

  /** 把 brush 的当前选区回调出去（拖动中 isFinal=false，松手 isFinal=true） */
  function emitBrush(svg, i0, i1, isFinal) {
    var reg = brushReg[svg.getAttribute('data-brush')];
    if (!reg || typeof reg.opts.onChange !== 'function') return;
    var a = reg.points[i0], b = reg.points[i1];
    if (!a || !b) return;
    reg.opts.onChange(a.date, b.date, !!isFinal);
  }

  /** 点到 x 比例 → 最近的概览下标 */
  function brushIndexAt(svg, clientX) {
    var rect = svg.getBoundingClientRect();
    var ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    ratio = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
    var n = +svg.getAttribute('data-n') || 2;
    return Math.round(ratio * (n - 1));
  }

  /* ---------------- 分时走势（持仓卡片内的小图） ----------------
   * points: [{ t:'09:30', p:16.2, v:4822 }]，prevClose 用于画昨收虚线并决定涨跌配色。
   * 不画坐标轴：卡片里只有几十像素高，轴只会变成噪声。
   * preserveAspectRatio="none" 让曲线填满容器，配 vector-effect 保证描边不被拉伸。
   */
  function sparkline(points, opts) {
    opts = opts || {};
    if (!points || points.length < 2) return '';
    var W = 100, H = 34;
    var vals = points.map(function (p) { return p.p; }).filter(function (v) { return v !== null; });
    if (vals.length < 2) return '';

    var prev = U.num(opts.prevClose);
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (prev !== null && prev > 0) { lo = Math.min(lo, prev); hi = Math.max(hi, prev); }
    if (hi === lo) { hi = lo + Math.max(Math.abs(lo) * 0.001, 0.01); }
    var pad = (hi - lo) * 0.10;
    lo -= pad; hi += pad;
    var span = (hi - lo) || 1;

    var last = vals[vals.length - 1];
    var up = prev !== null && prev > 0 ? last >= prev : last >= vals[0];
    var color = up ? '#E0312F' : '#12A150';

    function px(i) { return (i / (points.length - 1)) * W; }
    function py(v) { return H - ((v - lo) / span) * (H - 3) - 1.5; }

    var line = points.map(function (p, i) {
      return (i ? 'L' : 'M') + px(i).toFixed(2) + ' ' + py(p.p).toFixed(2);
    }).join('');
    var area = line + ' L' + W + ' ' + H + ' L0 ' + H + ' Z';
    var gid = 'xjSpark' + (++gradSeq);

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="spark" preserveAspectRatio="none" aria-hidden="true">' +
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.20"/>' +
      '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/>' +
      '</linearGradient></defs>';
    if (prev !== null && prev > 0) {
      svg += '<line x1="0" y1="' + py(prev).toFixed(2) + '" x2="' + W + '" y2="' + py(prev).toFixed(2) +
        '" style="stroke:var(--text-3)" stroke-width="1" stroke-dasharray="2 2" vector-effect="non-scaling-stroke"/>';
    }
    svg += '<path d="' + area + '" fill="url(#' + gid + ')"/>' +
      '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="1.4" ' +
      'stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>' +
      '</svg>';
    return svg;
  }


  /* ---------------- 多序列对比图的拖动读数 ---------------- */
  function showCmpAt(svg, i) {
    var data;
    try { data = JSON.parse(svg.getAttribute('data-cmp') || 'null'); } catch (e) { data = null; }
    if (!data || !data.dates || !data.dates[i]) return;
    var n = +svg.getAttribute('data-n') || 0;
    var x0 = +svg.getAttribute('data-x0'), x1 = +svg.getAttribute('data-x1');
    var y0 = +svg.getAttribute('data-y0'), y1 = +svg.getAttribute('data-y1');
    var px = n > 1 ? x0 + (x1 - x0) * (i / (n - 1)) : (x0 + x1) / 2;

    var g = svg.querySelector('.xjc-cmpmarker');
    if (!g) return;
    g.style.display = '';

    /* 竖向高亮带（参考图里那根半透明橙色竖条） */
    var bandW = Math.max(6, Math.min(26, (x1 - x0) / Math.max(n, 1) * 1.6));
    var band = g.querySelector('.xjc-band');
    band.setAttribute('x', (px - bandW / 2).toFixed(1));
    band.setAttribute('width', bandW.toFixed(1));
    var vl = g.querySelector('.xjc-vline');
    vl.setAttribute('x1', px.toFixed(1));
    vl.setAttribute('x2', px.toFixed(1));

    /* 气泡：列出每条曲线在该日的读数（宽度取自渲染时算好的 rect） */
    var rows = data.rows || [];
    var bubRect = g.querySelector('.xjc-cmpbub rect');
    var bubW = bubRect ? (+bubRect.getAttribute('width') || 132) : 132;
    var bx = Math.max(0, Math.min(CW - bubW, px - bubW / 2));
    var by = Math.max(0, y0 + 2);
    g.querySelector('.xjc-cmpbub').setAttribute('transform', 'translate(' + bx.toFixed(1) + ',' + by.toFixed(1) + ')');
    g.querySelector('.xjc-cmpd').textContent = data.dates[i];
    var rowNodes = g.querySelectorAll('.xjc-cmprow');
    var unit = data.unit || '%';
    Array.prototype.forEach.call(rowNodes, function (node, r) {
      var row = rows[r];
      if (!row) return;
      var v = row.vals[i];
      var nameEl = node.querySelector('.xjc-cmpn');
      var valEl = node.querySelector('.xjc-cmpv');
      nameEl.textContent = row.name;
      if (v === null || v === undefined) valEl.textContent = '—';
      else if (unit === 'yield') valEl.textContent = Number(v).toFixed(2) + '%';
      else if (unit === '%') valEl.textContent = (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%';
      /* 金额用紧凑写法（¥12.35万），避免大额数字把气泡撑爆或反过来被截断 */
      else valEl.textContent = (v < 0 ? '-¥' : '¥') + U.moneyCompact(Math.abs(v));
      /* 超出气泡宽度的名字截断，避免压到数值 */
      if (nameEl.textContent.length > 6) nameEl.textContent = nameEl.textContent.slice(0, 6) + '…';
    });
  }

  /* ---------------- 拖动查看 ---------------- */
  var bound = false;
  var active = null;

  function locate(svg, clientX) {
    var rect = svg.getBoundingClientRect();
    var ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    ratio = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
    var n = +svg.getAttribute('data-n') || 2;
    return Math.round(ratio * (n - 1));
  }

  function showAt(svg, i) {
    var n = +svg.getAttribute('data-n') || 0;
    var series = [];
    try { series = JSON.parse(svg.getAttribute('data-series') || '[]'); } catch (e) { series = []; }
    var p = series[i];
    if (!p) return;
    var x0 = +svg.getAttribute('data-x0'), x1 = +svg.getAttribute('data-x1');
    var y0 = +svg.getAttribute('data-y0'), y1 = +svg.getAttribute('data-y1');
    var lo = +svg.getAttribute('data-lo'), hi = +svg.getAttribute('data-hi');
    var px = n > 1 ? x0 + (x1 - x0) * (i / (n - 1)) : (x0 + x1) / 2;
    var py = y1 - (p.v - lo) / ((hi - lo) || 1) * (y1 - y0);

    var g = svg.querySelector('.xjc-marker');
    if (!g) return;
    g.style.display = '';
    var vl = g.querySelector('.xjc-vline');
    vl.setAttribute('x1', px.toFixed(1));
    vl.setAttribute('x2', px.toFixed(1));
    var dot = g.querySelector('.xjc-dot');
    dot.setAttribute('cx', px.toFixed(1));
    dot.setAttribute('cy', py.toFixed(1));

    var bw = 94, bh = 33;
    var bx = Math.max(0, Math.min(W - bw, px - bw / 2));
    var by = Math.max(0, py - bh - 10);
    g.querySelector('.xjc-bub').setAttribute('transform',
      'translate(' + bx.toFixed(1) + ',' + by.toFixed(1) + ')');
    g.querySelector('.xjc-bub-v').textContent = '¥' + U.moneyCompact(p.v);
    g.querySelector('.xjc-bub-d').textContent = p.d;
  }

  function hideAll() {
    var list = document.querySelectorAll('svg[data-chart] .xjc-marker, svg[data-chart] .xjc-cmpmarker');
    Array.prototype.forEach.call(list, function (g) { g.style.display = 'none'; });
  }

  /** 统一的按位置刷新（对比图与单序列图共用一套拖动逻辑） */
  function showAnyAt(svg, i) {
    if (svg.getAttribute('data-cmp')) showCmpAt(svg, i);
    else showAt(svg, i);
  }

  /* ---------------- brush 拖动状态 ----------------
   * mode:'l' | 'r' 拖某一端；mode:'pan' 整体平移。
   * 拖动中只改 SVG 属性 + 回调（不碰 store），松手才把 isFinal=true 交出去。 */
  var brushDrag = null;

  function brushState(svg) {
    return brushReg[svg.getAttribute('data-brush')] || null;
  }

  function applyBrush(svg, i0, i1, isFinal) {
    var reg = brushState(svg);
    if (!reg) return;
    var n = reg.points.length;
    i0 = Math.max(0, Math.min(n - 1, i0));
    i1 = Math.max(0, Math.min(n - 1, i1));
    if (i1 - i0 < B_MIN_SPAN) {
      if (isFinal || i1 === n - 1) i0 = Math.max(0, i1 - B_MIN_SPAN);
      else i1 = Math.min(n - 1, i0 + B_MIN_SPAN);
    }
    paintBrush(svg, i0, i1);
    emitBrush(svg, i0, i1, isFinal);
  }

  function bind() {
    if (bound) return;
    bound = true;

    document.addEventListener('pointerdown', function (e) {
      var t = e.target;
      /* brush 必须抢在主图之前分流：它的 SVG 只有 data-brush 没有 data-chart，
         若走下面那条分支会被当成「点图表外」直接忽略掉。 */
      var bsvg = t && t.closest ? t.closest('svg[data-brush]') : null;
      if (bsvg) {
        var reg = brushState(bsvg);
        if (reg) {
          var n = reg.points.length;
          var idx = brushIndexAt(bsvg, e.clientX);
          var cur = curBrushIdx(bsvg);
          /* 抓手判定要同时认「内层 <g class="xjc-brush-h">」与「外层定位 <g class="xjc-brush-hl/hr">」——
             真实点击落在内层的 rect/line 上、closest 能上溯到 xjc-brush-h；
             但若事件正是打在外层 wrapper 上（测试里就是这样），closest('.xjc-brush-h') 匹配不到，
             会静默退化成「就近选一端」，窄选区时就会抓错边。所以两边都认，并用 data-side 定方向。 */
          var handle = t.closest
            ? (t.closest('.xjc-brush-h') || t.closest('.xjc-brush-hl') || t.closest('.xjc-brush-hr'))
            : null;
          var mode;
          if (handle) mode = handle.getAttribute('data-side') === 'l' ? 'l' : 'r';
          else if (t.closest && t.closest('.xjc-brush-sel')) mode = 'pan';
          else mode = (Math.abs(idx - cur[0]) <= Math.abs(idx - cur[1])) ? 'l' : 'r';
          brushDrag = { svg: bsvg, key: bsvg.getAttribute('data-brush'), mode: mode,
            grabIdx: idx, begIdx: cur[0], endIdx: cur[1], moved: false };
          try { bsvg.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
          hideAll();
          active = null;
          e.preventDefault();
          return;
        }
      }
      var svg = t && t.closest ? t.closest('svg[data-chart]') : null;
      if (!svg) { hideAll(); active = null; return; }     // 点图表外 → 收起
      active = svg;
      try { svg.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      showAnyAt(svg, locate(svg, e.clientX));
      e.preventDefault();
    }, { passive: false });

    document.addEventListener('pointermove', function (e) {
      if (brushDrag) {
        /* 拖动中途若发生整页重渲染（离线时失败的行情请求会 notify()），
           手上的 SVG 会脱离文档 —— 按 chartKey 把它找回来继续拖，别让手势断掉。
           重新找回时选区以 ui 里记着的范围为准（视图层每次变化都会同步过去）。 */
        if (!document.body.contains(brushDrag.svg)) {
          var again = document.querySelector('svg[data-brush="' + brushDrag.key + '"]');
          if (!again) { brushDrag = null; return; }
          var back = curBrushIdx(again);
          brushDrag.svg = again;
          brushDrag.begIdx = back[0];
          brushDrag.endIdx = back[1];
        }
        var d = brushDrag;
        var i = brushIndexAt(d.svg, e.clientX);
        if (i !== d.grabIdx) d.moved = true;
        if (d.mode === 'pan') {
          var n = brushState(d.svg) ? brushState(d.svg).points.length : 0;
          var span = d.endIdx - d.begIdx;
          var delta = i - d.grabIdx;
          var b = Math.max(0, Math.min(n - 1 - span, d.begIdx + delta));
          applyBrush(d.svg, b, b + span, false);
        } else if (d.mode === 'l') {
          applyBrush(d.svg, Math.min(i, d.endIdx - 1), d.endIdx, false);
        } else {
          applyBrush(d.svg, d.begIdx, Math.max(i, d.begIdx + 1), false);
        }
        e.preventDefault();
        return;
      }
      if (!active || !document.body.contains(active)) return;
      showAnyAt(active, locate(active, e.clientX));
      e.preventDefault();
    }, { passive: false });

    /* 抬起后**保留**读数（同花顺也是抬起后仍显示），点别处才收起 */
    document.addEventListener('pointerup', function () {
      if (brushDrag) {
        var d = brushDrag;
        brushDrag = null;
        var cur = curBrushIdx(d.svg);
        applyBrush(d.svg, cur[0], cur[1], true);   // 松手才把结果提交出去
        return;
      }
      active = null;
    });
    document.addEventListener('pointercancel', function () {
      if (brushDrag) { brushDrag = null; return; }
      active = null;
    });
  }

  /** 读 brush 当前选区下标（从 DOM 反推，避免另存一份状态导致不同步） */
  function curBrushIdx(svg) {
    var reg = brushState(svg);
    var n = reg ? reg.points.length : 2;
    var hl = svg.querySelector('.xjc-brush-hl'), hr = svg.querySelector('.xjc-brush-hr');
    function idxOf(node) {
      if (!node) return null;
      var m = /translate\(\s*([-\d.]+)/.exec(node.getAttribute('transform') || '');
      if (!m) return null;
      var x = U.num(m[1]);
      if (x === null || n < 2) return null;
      return Math.round(x / BW * (n - 1));
    }
    var a = idxOf(hl), b = idxOf(hr);
    if (a === null) a = 0;
    if (b === null) b = n - 1;
    return [Math.max(0, Math.min(n - 1, a)), Math.max(0, Math.min(n - 1, b))];
  }

  return {
    render: render, renderCompare: renderCompare, sparkline: sparkline,
    brush: brush, bind: bind, niceScale: niceScale, hideAll: hideAll,
  };
})();
