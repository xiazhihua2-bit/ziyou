/* ==================== 全局数字动效（值比对 → 模糊→清晰 + 数字滚动） ====================
 * 为什么不能用纯 CSS：app.render() 是全量 innerHTML 重建，一轮行情刷新触发 5–7 次重建，
 * CSS 入场动画无法区分「数据真变了」与「只是重渲染」—— 同一个大数字会连续闪 5–7 次。
 * 值比对天然过滤无效抖动：只有 textContent 真的变了的元素才起播。
 *
 * 用法（app.js render 内两步）：
 *   var prev = XJ.anim.snapshot();   // ① innerHTML 重建【前】快照
 *   ...重建...
 *   XJ.anim.diffAndPlay(prev);       // ③ 重建【后】比对并分档播放
 *
 * 标记（视图层纯属性，不动计算逻辑）：
 *   data-anim="S|A|B|M"      档位：S 大焦点 / A 卡片主指标 / B 网格小数字 / M 微（滑杆实时值）
 *   data-anim-key="锚"       列表内显式锚（可选；缺省用文档序号，同名元素按顺序对位）
 *
 * 播放形态：
 *   · 两端文本都能拆成「前缀 + 数字 + 后缀」且前后缀一致 → 数字滚动（rAF + easeOutCubic）
 *   · 否则只做模糊→清晰（如「2037 年 1 月」「已达成」——年月滚动会错乱，只闪不滚）
 *   · M 档永远不滚动（拖动中每帧都变，滚动跟不上；只要呼吸感）
 *
 * 节流：同一元素 400ms 内不重复起播（M 档 150ms）—— 一轮刷新重建 5–7 次只播一次。
 * 降级：prefers-reduced-motion → 全部直接定值；hardwareConcurrency ≤ 4 → S/A 降为 B。
 */
XJ.anim = (function () {
  var U = XJ.util;

  var REDUCED = false;
  var LOWEND = false;
  try {
    REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    LOWEND = (navigator.hardwareConcurrency || 8) <= 4;
  } catch (e) { /* 老浏览器：按可动效处理，CSS 端还有 @media 兜底 */ }

  var THROTTLE_MS = 400;      // 常规节流窗口
  var M_THROTTLE_MS = 150;    // 微档（滑杆拖动中）节流窗口
  var MAX_DELTA = 1e9;        // 数字差值超过它就不滚动（避免无意义的漫长插值）

  var lastPlay = {};          // key → 上次起播时间戳
  var rafId = {};             // key → 进行中的 count-up rAF id

  /* ---------------- 快照 / 比对 ---------------- */

  function keyOf(el, idx) {
    var own = el.getAttribute('data-anim-key');
    return (own !== null && own !== undefined && own !== '')
      ? el.getAttribute('data-anim') + '|' + own
      : el.getAttribute('data-anim') + '|' + idx;
  }

  /** 进度条档：比对目标是 data-w(百分比数字)，不是文本 */
  function snapVal(el) {
    var w = el.getAttribute('data-w');
    return w !== null && w !== undefined ? w : el.textContent;
  }

  /** 重建前调用：记下每个动效元素的当前值 */
  function snapshot() {
    if (REDUCED) return null;
    var map = {};
    var els = document.querySelectorAll('[data-anim]');
    for (var i = 0; i < els.length; i++) map[keyOf(els[i], i)] = snapVal(els[i]);
    return map;
  }

  /** 重建后调用：与新 DOM 对位，值变了的元素分档播放 */
  function diffAndPlay(prev) {
    if (REDUCED || !prev) return;
    var els = document.querySelectorAll('[data-anim]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var key = keyOf(el, i);
      var oldTxt = prev[key];
      if (oldTxt === undefined || oldTxt === null) continue;   // 新出现的元素不播（防首屏闪烁）
      var tier = el.getAttribute('data-anim') || 'A';
      var newTxt = snapVal(el);
      if (oldTxt === newTxt) continue;                          // ★ 值没变不起播——过滤重渲染抖动的核心
      if (tier === 'bar') playBar(el, oldTxt, newTxt, key);
      else play(el, tier, oldTxt, newTxt, key);
    }
  }

  /* ---------------- 播放 ---------------- */

  var TIER_MS = { S: 280, A: 200, B: 140, M: 100 };            // 各档「模糊→清晰」回稳时长

  /** 进度条档（data-anim="bar"）：width 从旧值过渡到新值（CSS transition 接管）。
      元素每次重建都是新节点，直接写 width 不会有过渡 —— 先写旧宽度、reflow、再写新宽度。 */
  function playBar(el, oldW, newW, key) {
    var now = U.nowMs ? U.nowMs() : Date.now();
    if (lastPlay[key] && now - lastPlay[key] < THROTTLE_MS) return;
    lastPlay[key] = now;
    stop(key);
    var a = parseFloat(String(oldW).replace('%', ''));
    var b = parseFloat(String(newW).replace('%', ''));
    if (!isFinite(a) || !isFinite(b)) { el.style.width = newW; return; }
    el.style.transition = 'none';
    el.style.width = a + '%';
    void el.offsetWidth;                                        // reflow：把旧宽度固定为过渡起点
    el.style.transition = '';
    rafId[key] = requestAnimationFrame(function () {
      if (!document.contains(el)) { delete rafId[key]; return; }
      el.style.width = b + '%';
      setTimeout(function () { delete rafId[key]; }, 520);
    });
  }

  function play(el, tier, oldTxt, newTxt, key) {
    if (tier === 'S' || tier === 'A') { if (LOWEND) tier = 'B'; }  // 低端机：重模糊档降为轻档
    var isM = tier === 'M';
    var now = U.nowMs ? U.nowMs() : Date.now();
    if (lastPlay[key] && now - lastPlay[key] < (isM ? M_THROTTLE_MS : THROTTLE_MS)) return;
    lastPlay[key] = now;

    var pair = isM ? null : parsePair(oldTxt, newTxt);           // 微档禁滚动
    stop(key);
    el.style.willChange = 'filter, opacity, transform';
    el.style.transitionDuration = (TIER_MS[tier] / 1000) + 's';

    if (pair) {
      var dur = Math.min(560, Math.max(320, 320 + Math.abs(pair.b - pair.a) / (Math.abs(pair.b) + 1) * 240));
      countUp(el, tier, pair, dur, key);
    } else {
      el.classList.add('na-' + tier);
      void el.offsetWidth;                                       // 强制 reflow：让「瞬间模糊」生效
      el.textContent = newTxt;
      settle(el, tier, key, 2);                                  // 双 rAF：确保模糊帧已绘制再回清晰
    }
  }

  /** 单元素便捷入口（滑杆高频路径 firePatchDom 用）：值变才播，等价 snapshot+diff 的单元素版 */
  function patch(el, newTxt, tier) {
    if (!el) return;
    if (REDUCED) { if (el.textContent !== newTxt) el.textContent = newTxt; return; }
    var oldTxt = el.textContent;
    if (oldTxt === newTxt) return;
    var key = 'patch|' + (el.id || el.getAttribute('data-anim-key') || 'anon');
    play(el, tier || 'M', oldTxt, newTxt, key);
  }

  function countUp(el, tier, pair, dur, key) {
    el.classList.add('na-' + tier);
    void el.offsetWidth;
    var t0 = null;
    var step = function (ts) {
      if (!document.contains(el)) { delete rafId[key]; return; } // 元素已被下一轮重建顶掉 → 停
      if (t0 === null) t0 = ts;
      var p = Math.min(1, (ts - t0) / dur);
      var e = 1 - Math.pow(1 - p, 3);                            // easeOutCubic：苹果的减速手感
      el.textContent = pair.pre + fmtNum(pair.a + (pair.b - pair.a) * e, pair.dec) + pair.post;
      if (p < 1) { rafId[key] = requestAnimationFrame(step); return; }
      el.textContent = pair.raw;                                 // 末帧回到新值原样（保证格式逐位一致）
      settle(el, tier, key, 1);
    };
    rafId[key] = requestAnimationFrame(step);
  }

  /** 播完收尾：撤模糊 class → 基础态 transition 接管「模糊→清晰」→ 清理 will-change */
  function settle(el, tier, key, rafCount) {
    var done = function () {
      el.classList.remove('na-' + tier);
      el.style.willChange = '';
      el.style.transitionDuration = '';
      delete rafId[key];
    };
    if (rafCount === 2) {
      requestAnimationFrame(function () { requestAnimationFrame(done); });
    } else done();
  }

  function stop(key) {
    if (rafId[key]) { cancelAnimationFrame(rafId[key]); delete rafId[key]; }
  }

  /* ---------------- 文本解析（「前缀 + 数字 + 后缀」） ---------------- */

  var NUM_RE = /^(.*?)(-?[0-9][0-9,]*(?:\.[0-9]+)?)(.*)$/;

  /**
   * 两端文本可滚动 ⇔ 前缀、后缀完全一致，且后缀里不再含数字。
   * 「¥1.2万 → ¥3,500」后缀不同 → 拒绝（防单位跳变）；「2037 年 1 月」后缀含数字 → 拒绝（防错位滚动）。
   * 小数位数取新值的（旧值 8 → 新值 8.40，中间帧按两位小数滚）。
   */
  function parsePair(oldTxt, newTxt) {
    var a = NUM_RE.exec(String(oldTxt == null ? '' : oldTxt));
    var b = NUM_RE.exec(String(newTxt == null ? '' : newTxt));
    if (!a || !b) return null;
    if (a[1] !== b[1] || a[3] !== b[3]) return null;
    if (/[0-9]/.test(b[3])) return null;
    var av = Number(a[2].replace(/,/g, ''));
    var bv = Number(b[2].replace(/,/g, ''));
    if (!isFinite(av) || !isFinite(bv)) return null;
    if (Math.abs(bv - av) <= 1e-9 || Math.abs(bv - av) > MAX_DELTA) return null;
    var dm = /\.[0-9]+$/.exec(b[2]);
    return { pre: b[1], post: b[3], a: av, b: bv, dec: dm ? dm[0].length - 1 : 0, raw: newTxt };
  }

  function fmtNum(v, dec) {
    var s = v.toFixed(dec);
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }

  return { snapshot: snapshot, diffAndPlay: diffAndPlay, patch: patch,
    parsePair: parsePair, fmtNum: fmtNum, reduced: function () { return REDUCED; } };
})();
