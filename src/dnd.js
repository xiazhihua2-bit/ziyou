/* ==================== 长按拖拽排序引擎（vanilla · Pointer Events · 零依赖） ====================
 * 给底部 Tab（一期）与分组管理（二期）共用的通用能力。
 *
 * 用法：
 *   XJ.dnd.bind(container, {
 *     itemSel: '.tab',            // 可拖拽项选择器（容器内委托）
 *     attr: 'data-tab',           // 项的唯一 id 属性
 *     onCommit: function (ids) {} // 松手且顺序有变时回调（ids = 新顺序）；回调返回后新 DOM 已就绪
 *   });
 *
 * 交互（对齐 iOS 手感）：
 *   · 按住 320ms 起拖；起拖前位移 >8px 判定为滚动/滑动意图 → 取消，不影响点击
 *   · 起拖：vibrate(8)（Android；iOS 无振动则以视觉反馈替代）+ 拖拽项放大加影跟手、其余项半透明
 *   · 拖动：拖拽项 rAF 级跟手（Pointer Events 原生节流即可，不做多余插值）；
 *     其余项按「精确新布局 − 原布局」FLIP 补位（260ms 弹性曲线），支持不等宽槽位
 *   · 松手：顺序变了 → commit 后新 DOM 的落点项播放 spring pop；没变 → settle 弹回
 *   · justDragged 标记 350ms：点击方（gotoTab 等）必须检查，防止拖完误触切页
 *
 * 实现要点：
 *   · 容器只绑一次（container.__dnd 哨兵）——上层 render() 全量重建子节点也安全
 *   · 拖拽项 setPointerCapture：手指移出条Bar也持续收到 move/up
 *   · 项上 touch-action:none（CSS），长按期间不与页面滚动打架
 */
XJ.dnd = (function () {
  var HOLD_MS = 320;      // 长按起拖阈值
  var CANCEL_PX = 8;      // 起拖前允许的位移（超过视为滚动）
  var DRAG_SCALE = 1.08;  // 拖拽项放大倍数

  var justDragged = false;
  var justTimer = null;
  function markDragged() {
    justDragged = true;
    if (justTimer) clearTimeout(justTimer);
    justTimer = setTimeout(function () { justDragged = false; }, 350);
  }

  function bind(container, opts) {
    if (!container || container.__dnd) return;
    container.__dnd = true;
    opts = opts || {};
    var itemSel = opts.itemSel || '.tab';
    var attr = opts.attr || 'data-tab';
    var AXIS = opts.axis === 'y' ? 'y' : 'x';       // 'x' 横向（Tab）/ 'y' 纵向（分组管理）
    var POS = AXIS === 'y' ? 'offsetTop' : 'offsetLeft';
    var SIZE = AXIS === 'y' ? 'offsetHeight' : 'offsetWidth';
    var T = AXIS === 'y' ? 'translateY' : 'translateX';

    /* 长按拖拽时不要弹出系统菜单/选择 */
    container.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    /* 拖完 350ms 内的 click 一律吞掉（捕获阶段），防落位误触 */
    container.addEventListener('click', function (e) {
      if (justDragged) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    var st = null;   // 进行中的手势状态（pointerdown → up 全程）

    function measure() {
      var els = Array.prototype.slice.call(container.querySelectorAll(itemSel));
      var all = els.map(function (el) {
        return { el: el, id: el.getAttribute(attr), x: el[POS], w: el[SIZE] };
      });
      var gap = all.length > 1 ? (all[1].x - (all[0].x + all[0].w)) : 0;
      return { all: all, gap: gap };
    }

    /** 精确布局：order（id 数组）里排在 slot j 的项，其左缘 x */
    function slotX(m, order, j) {
      var x = m.all[0].x;
      for (var i = 0; i < j; i++) {
        var r = findById(m, order[i]);
        x += (r ? r.w : 0) + m.gap;
      }
      return x;
    }
    function findById(m, id) {
      for (var i = 0; i < m.all.length; i++) if (m.all[i].id === id) return m.all[i];
      return null;
    }

    function applyShifts(m, order) {
      for (var i = 0; i < m.all.length; i++) {
        var r = m.all[i];
        if (r.id === st.id) continue;
        var j = order.indexOf(r.id);
        var dx = slotX(m, order, j) - r.x;
        r.el.style.transform = dx ? T + '(' + dx + 'px)' : '';
      }
    }

    function startDrag() {
      st.dragging = true;
      markDragged();
      try { if (navigator.vibrate) navigator.vibrate(8); } catch (e) { /* 桌面无振动 */ }
      var m = measure();
      st.m = m;
      st.item = findById(m, st.id).el;
      st.order = m.all.map(function (r) { return r.id; });
      try { st.item.setPointerCapture(st.pointerId); } catch (e) { /* 老浏览器降级 */ }
      st.item.classList.add('dnd-drag');
      for (var i = 0; i < m.all.length; i++) {
        if (m.all[i].id !== st.id) m.all[i].el.classList.add('dnd-drift');
      }
      document.body.classList.add('dnd-active');
    }

    function moveDrag(e) {
      var dx = e.clientX - st.startX;
      if (AXIS === 'y') dx = e.clientY - st.startY;
      st.item.style.transform = T + '(' + dx + 'px) scale(' + DRAG_SCALE + ')';
      /* 槽位判定：拖拽项当前中心，压过多少个其它项的（已补位）中心 → 目标槽位。
         相等也算越过（>=）：拖到某项正中心 = 取代它的位置（把该项挤向反方向）。 */
      var m = st.m;
      var base = findById(m, st.id);
      var px = base.x + base.w / 2 + dx;
      var count = 0;
      for (var k = 0; k < st.order.length; k++) {
        if (st.order[k] === st.id) continue;
        var cx = slotX(m, st.order, k) + findById(m, st.order[k]).w / 2;
        if (px >= cx) count++;
      }
      var from = st.order.indexOf(st.id);
      if (count !== from) {
        st.order.splice(from, 1);
        st.order.splice(count, 0, st.id);
        applyShifts(m, st.order);
      }
    }

    function endDrag(commit) {
      if (!st) return;
      var wasDragging = st.dragging;
      var order = st.order;
      var itemId = st.id;
      var item = st.item;
      var m = st.m;
      if (wasDragging) {
        markDragged();
        document.body.classList.remove('dnd-active');
        if (commit && order && opts.onCommit) {
          var from = order.indexOf(itemId);
          var original = m.all.map(function (r) { return r.id; });
          if (from >= 0 && order.join('\u0001') !== original.join('\u0001')) {
            /* 先把拖拽项摆到目标槽位的视觉位置，再 commit —— 重渲染后零跳变 */
            var base = findById(m, itemId);
            /* finalDx = 新槽位中心 − 原中心 */
            var finalDx = (slotX(m, order, order.indexOf(itemId)) + base.w / 2) - (base.x + base.w / 2);
            item.style.transform = T + '(' + finalDx + 'px) scale(1)';
            opts.onCommit(order.slice());
            /* commit → 上层重渲染（同步）→ 新 DOM 上播放落位弹跳 */
            var fresh = container.querySelector('[' + attr + '="' + itemId + '"]');
            if (fresh) {
              fresh.classList.add('dnd-pop');
              setTimeout(function () { fresh.classList.remove('dnd-pop'); }, 340);
            }
          } else {
            settleBack(item);
          }
        } else {
          settleBack(item);
        }
      }
      st = null;
    }

    function settleBack(item) {
      item.classList.remove('dnd-drag');
      item.classList.add('dnd-settle');
      item.style.transform = '';
      var el = item;
      setTimeout(function () { el.classList.remove('dnd-settle'); }, 240);
      /* 其余项也弹回 */
      var m2 = measure();
      for (var i = 0; i < m2.all.length; i++) {
        if (m2.all[i].el !== el) m2.all[i].el.style.transform = '';
      }
    }

    container.addEventListener('pointerdown', function (e) {
      if (st || justDragged) return;
      var tgt = e.target;
      var item = tgt && tgt.closest ? tgt.closest(itemSel) : null;
      if (!item || !container.contains(item)) return;
      st = {
        id: item.getAttribute(attr),
        item: item,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        timer: null,
        dragging: false,
      };
      st.timer = setTimeout(function () {
        if (st && !st.dragging) startDrag();
      }, HOLD_MS);
    });

    container.addEventListener('pointermove', function (e) {
      if (!st) return;
      if (!st.dragging) {
        /* 未起拖：位移超阈值 → 是滚动/滑动，取消长按 */
        var dxE = Math.abs(e.clientX - st.startX), dyE = Math.abs(e.clientY - st.startY);
        if (dxE > CANCEL_PX || dyE > CANCEL_PX) {
          if (st.timer) clearTimeout(st.timer);
          st = null;
        }
        return;
      }
      e.preventDefault();
      moveDrag(e);
    });

    container.addEventListener('pointerup', function (e) {
      if (!st) return;
      if (st.timer) clearTimeout(st.timer);
      endDrag(true);
    });
    container.addEventListener('pointercancel', function () {
      if (!st) return;
      if (st.timer) clearTimeout(st.timer);
      endDrag(false);
    });
  }

  return {
    bind: bind,
    isJustDragged: function () { return justDragged; },
  };
})();
