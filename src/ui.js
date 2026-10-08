/* ==================== UI 基建：图标 / 组件 / 弹层 / 事件委托 ==================== */
XJ.ui = (function () {
  var U = XJ.util;

  /* ---------------- 图标 ---------------- */
  var ICONS = {
    overview: '<path d="M3.2 10.6 12 3.2l8.8 7.4"/><path d="M5.6 9.6V20a1 1 0 0 0 1 1h10.8a1 1 0 0 0 1-1V9.6"/><path d="M9.6 21v-5.8h4.8V21"/>',
    calendar: '<rect x="3.2" y="4.8" width="17.6" height="15.6" rx="3.2"/><path d="M3.2 9.6h17.6M8.2 3v3.4M15.8 3v3.4"/>',
    plan: '<circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="4.6"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/>',
    mine: '<circle cx="12" cy="8.2" r="3.6"/><path d="M4.6 20.2c.9-3.9 3.9-6.1 7.4-6.1s6.5 2.2 7.4 6.1"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20.2 4v4.4h-4.4"/>',
    plus: '<path d="M12 5.2v13.6M5.2 12h13.6"/>',
    chevron: '<path d="M9.2 5.4 15.8 12l-6.6 6.6"/>',
    back: '<path d="M14.8 5.4 8.2 12l6.6 6.6"/>',
    close: '<path d="M6.4 6.4l11.2 11.2M17.6 6.4 6.4 17.6"/>',
    menu: '<path d="M4 6.6h16M4 12h16M4 17.4h16"/>',
    /* 自选星标：空心（stroke）与实心（fill）两个形态，图五搜索结果用 */
    star: '<path d="M12 3.8l2.5 5.1 5.7.8-4.1 4 1 5.6L12 16.6l-5.1 2.7 1-5.6-4.1-4 5.7-.8z"/>',
    starF: '<path fill="currentColor" stroke="none" d="M12 3.8l2.5 5.1 5.7.8-4.1 4 1 5.6L12 16.6l-5.1 2.7 1-5.6-4.1-4 5.7-.8z"/>',
    trash: '<path d="M4.2 7h15.6"/><path d="M9.4 7V5.2a1.2 1.2 0 0 1 1.2-1.2h2.8a1.2 1.2 0 0 1 1.2 1.2V7"/><path d="M6.6 7l.8 12.1a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9L17.4 7"/>',
    edit: '<path d="M4 20h4.2L20 8.2A2.8 2.8 0 0 0 16 4.2L4.2 16v4z"/>',
    download: '<path d="M12 3.4v11.8"/><path d="M7.6 10.6 12 15l4.4-4.4"/><path d="M4.2 20h15.6"/>',
    upload: '<path d="M12 15V3.4"/><path d="M7.6 7.6 12 3.2l4.4 4.4"/><path d="M4.2 20h15.6"/>',
    search: '<circle cx="11" cy="11" r="6.4"/><path d="M15.8 15.8 20 20"/>',
    check: '<path d="M5 12.6l4.6 4.6L19 7"/>',
    info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11v5.4M12 7.9v.2"/>',
    warn: '<path d="M12 3.8 2.9 19.4h18.2z"/><path d="M12 9.8v4.2M12 17v.2"/>',
    gear: '<circle cx="12" cy="12" r="3.1"/><path d="M19.6 14.4a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.55V21a2 2 0 1 1-4 0v-.11a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1.03H3a2 2 0 1 1 0-4h.11a1.7 1.7 0 0 0 1.55-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9.1a1.7 1.7 0 0 0 1.03-1.55V3a2 2 0 1 1 4 0v.11a1.7 1.7 0 0 0 1.03 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9.1a1.7 1.7 0 0 0 1.55 1.03H21a2 2 0 1 1 0 4h-.11a1.7 1.7 0 0 0-1.29 1.03z"/>',
    wallet: '<rect x="3.2" y="5.6" width="17.6" height="12.8" rx="3"/><path d="M3.2 10h17.6"/><circle cx="16.4" cy="14.2" r="1.1" fill="currentColor" stroke="none"/>',
    chart: '<path d="M4 19.2V10M10 19.2V4.8M16 19.2v-6.4M21 19.2H3"/>',
    /* 火焰（FIRE Tab）：外焰水滴形 + 内焰小滴，与全套 1.7 描边风格一致 */
    flame: '<path d="M12 3.2c.5 2.6-.4 4.1-1.7 5.6-1.2 1.4-2.7 2.8-2.7 5.2a4.4 4.4 0 0 0 8.8 0c0-1.6-.7-2.7-1.4-3.8"/><path d="M12 20.8a2.5 2.5 0 0 1-2.5-2.5c0-1.2.8-1.9 1.5-2.8.6-.8 1-1.5 1-2.7 1.4 1.1 2.5 2.7 2.5 4.6a2.5 2.5 0 0 1-2.5 3.4z"/>',

    /* ---- 底部 Tab 填充式图标（图一长桥风：实底字形，currentColor 着色） ---- */
    /* 持仓 = 饼图：主体盘（右上缺口）+ 分离扇区 */
    'tab-hold': '<path fill="currentColor" stroke="none" d="M12 13.2V5.6A7.6 7.6 0 1 0 19.6 13.2Z"/>' +
      '<path fill="currentColor" stroke="none" d="M14.2 3.2a7.6 7.6 0 0 1 6.6 6.6h-6.6Z"/>',
    /* 自选 = 书签 + 加号镂空（evenodd） */
    'tab-watch': '<path fill="currentColor" stroke="none" fill-rule="evenodd" d="' +
      'M6.9 3.2h10.2c1.24 0 2.25 1.01 2.25 2.25v15.1c0 .93-1.05 1.47-1.8.93L12 17.9l-5.55 3.58c-.75.54-1.8 0-1.8-.93V5.45c0-1.24 1.01-2.25 2.25-2.25Z' +
      'M11.25 7.5h1.5v1.9h1.9v1.5h-1.9v1.9h-1.5v-1.9h-1.9V9.4h1.9Z"/>',
    /* 分红日历 = 台历：双挂耳（实底）+ 页身（网格圆点镂空） */
    'tab-cal': '<path fill="currentColor" stroke="none" d="M8.1 2.4c.5 0 .9.4.9.9v1.9c0 .5-.4.9-.9.9s-.9-.4-.9-.9V3.3c0-.5.4-.9.9-.9Zm7.8 0c.5 0 .9.4.9.9v1.9c0 .5-.4.9-.9.9s-.9-.4-.9-.9V3.3c0-.5.4-.9.9-.9Z"/>' +
      '<path fill="currentColor" stroke="none" fill-rule="evenodd" d="' +
      'M6.2 5.6h11.6c1.3 0 2.35 1.05 2.35 2.35v9.9c0 1.3-1.05 2.35-2.35 2.35H6.2c-1.3 0-2.35-1.05-2.35-2.35v-9.9C3.85 6.65 4.9 5.6 6.2 5.6Z' +
      'M8.15 9.35a1.05 1.05 0 1 0 0 2.1 1.05 1.05 0 0 0 0-2.1Z' +
      'M12 9.35a1.05 1.05 0 1 0 0 2.1 1.05 1.05 0 0 0 0-2.1Z' +
      'M15.85 9.35a1.05 1.05 0 1 0 0 2.1 1.05 1.05 0 0 0 0-2.1Z' +
      'M8.15 13.75a1.05 1.05 0 1 0 0 2.1 1.05 1.05 0 0 0 0-2.1Z' +
      'M12 13.75a1.05 1.05 0 1 0 0 2.1 1.05 1.05 0 0 0 0-2.1Z"/>',
    /* 新闻 = 文档 + 三行镂空（末行半长） */
    'tab-news': '<path fill="currentColor" stroke="none" fill-rule="evenodd" d="' +
      'M6.5 3.2h11c1.27 0 2.3 1.03 2.3 2.3v13c0 1.27-1.03 2.3-2.3 2.3h-11c-1.27 0-2.3-1.03-2.3-2.3v-13c0-1.27 1.03-2.3 2.3-2.3Z' +
      'M7.9 7.7h8.2a.9.9 0 0 1 0 1.8H7.9a.9.9 0 0 1 0-1.8Z' +
      'M7.9 11.2h8.2a.9.9 0 0 1 0 1.8H7.9a.9.9 0 0 1 0-1.8Z' +
      'M7.9 14.7h4.4a.9.9 0 0 1 0 1.8H7.9a.9.9 0 0 1 0-1.8Z"/>',
    /* FIRE = 实底火焰 + 内焰镂空 */
    'tab-fire': '<path fill="currentColor" stroke="none" fill-rule="evenodd" d="' +
      'M12 21.5c-3.45 0-6.25-2.68-6.25-6.1 0-2.5 1.35-4.15 2.7-5.65 1.3-1.45 2.55-2.85 2.95-4.95.25.9.35 2.15.05 3.35 1-1 1.9-2.35 2.05-4.25 2.5 1.75 4.8 4.85 4.8 8.55 0 3.42-2.8 6.1-6.25 6.1Z' +
      'M12 19.7c-1.5 0-2.7-1.15-2.7-2.6 0-1.2.75-1.95 1.45-2.75.5-.55.95-1.1 1.2-1.9.9 1.05 2.75 2.7 2.75 4.65 0 1.45-1.2 2.6-2.7 2.6Z"/>',
    /* 我的 = 实底人像 */
    'tab-mine': '<path fill="currentColor" stroke="none" d="' +
      'M12 3.4a4.15 4.15 0 1 1 0 8.3 4.15 4.15 0 0 1 0-8.3Z' +
      'M12 13.3c4.3 0 7.7 2.5 7.7 5.7 0 .94-.76 1.7-1.7 1.7H6c-.94 0-1.7-.76-1.7-1.7 0-3.2 3.4-5.7 7.7-5.7Z"/>',
  };

  function icon(name, size, stroke) {
    var p = ICONS[name] || '';
    size = size || 24;
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size +
      '" fill="none" stroke="currentColor" stroke-width="' + (stroke || 1.7) +
      '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  }

  /* ---------------- 小组件 ---------------- */
  /**
   * 头像：优先展示股票官方图标（logo 传 URL），加载失败或没有时自动回退到文字头像。
   * 回退靠 img 自身的 onerror 隐藏自己，露出底下的文字 —— 不需要额外 JS。
   * 尺寸够大（≥40px）时用两个字的中文简称，更像品牌标识；小头像仍用单个首字以免拥挤。
   */
  function avatar(name, key, size, logo, cls) {
    size = size || 38;
    var two = size >= 40;
    var txt = two ? U.shortName(name) : U.initial(name);
    var fs = two ? Math.round(size * 0.30) : Math.round(size * 0.42);
    var bg = U.colorOf(key || name);
    return '<div class="avatar"' + (cls ? ' ' + cls : '') + ' style="width:' + size + 'px;height:' + size +
      'px;background:' + bg + ';font-size:' + fs + 'px">' +
      '<span class="av-txt">' + U.esc(txt) + '</span>' +
      (logo ? '<img class="av-img" src="' + U.esc(logo) + '" alt="" loading="lazy" ' +
        'referrerpolicy="no-referrer" onerror="this.style.display=&quot;none&quot;">' : '') +
      '</div>';
  }

  function moneyCell(v, dec, forceColor) {
    return '<span class="' + (forceColor || U.dirClass(v)) + '">' + U.moneySign(v, dec) + '</span>';
  }

  function deltaPill(v, dec) {
    var d = U.direction(v);
    return '<span class="pill ' + (d === 'flat' ? 'gray' : d) + '">' + U.signPct(v, dec === undefined ? 2 : dec) + '</span>';
  }

  function emptyState(iconChar, title, desc, actionHtml) {
    return '<div class="card"><div class="empty">' +
      '<div class="ico">' + (iconChar || '🌱') + '</div>' +
      '<h3>' + U.esc(title) + '</h3>' +
      '<p>' + U.esc(desc) + '</p>' +
      (actionHtml || '') +
      '</div></div>';
  }

  /* ---------------- Toast ---------------- */
  function toast(msg, ms) {
    var root = document.getElementById('toast-root');
    if (!root) return;
    var d = document.createElement('div');
    d.className = 'toast';
    d.textContent = msg;
    root.appendChild(d);
    setTimeout(function () {
      d.style.transition = 'opacity .2s ease';
      d.style.opacity = '0';
      setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 220);
    }, ms || 1900);
  }

  /* ---------------- 弹层 ---------------- */
  /** 关闭弹层：同步清空（语义与旧版完全一致，uitest 等调用方零感知），
      出场动画由【克隆节点】播放 —— 原节点立即消失，ghost 挂 body 播 220ms 后移除。
      为什么不用「先加 closing 类再延时移除」：那会把 closeSheet 变成异步语义，
      开 A→关 A→开 B 的流程里 B 会被挂起的清场定时器一起删掉（实测 uitest 全线挂）。
      immediate=true 或 reduced-motion：不播动画。 */
  function closeSheet(immediate) {
    var root = document.getElementById('modal-root');
    if (!root) return;
    var mask = root.querySelector('.mask');
    if (!mask) return;
    var animate = !immediate && !(XJ.anim && XJ.anim.reduced());
    var ghost = animate ? mask.cloneNode(true) : null;
    root.innerHTML = '';
    if (ghost) {
      ghost.classList.add('closing');
      var host = document.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'position:fixed;inset:0;z-index:999;pointer-events:none;';
      host.appendChild(ghost);
      document.body.appendChild(host);
      setTimeout(function () { if (host.parentNode) host.parentNode.removeChild(host); }, 240);
    }
  }

  function openSheet(opts) {
    opts = opts || {};
    closeSheet();
    var root = document.getElementById('modal-root');
    var mask = document.createElement('div');
    mask.className = 'mask';
    var inner = '<div class="sheet-grip"></div>' +
      (opts.title ? '<h3' + (opts.center ? ' class="center"' : '') + '>' + U.esc(opts.title) + '</h3>' : '') +
      (opts.html || '');
    mask.innerHTML = '<div class="sheet">' + inner + '</div>';
    mask.addEventListener('click', function (e) { if (e.target === mask) closeSheet(); });
    root.appendChild(mask);
    var sheet = mask.querySelector('.sheet');
    if (opts.onMount) opts.onMount(sheet);
    return sheet;
  }

  function confirmDialog(opts) {
    return new Promise(function (resolve) {
      openSheet({
        title: opts.title || '确认操作',
        html:
          '<p class="muted" style="font-size:13.5px;line-height:1.7;margin:0 0 16px">' + (opts.html || U.esc(opts.message || '')) + '</p>' +
          '<button class="btn-block ' + (opts.danger ? 'danger' : '') + '" data-act="__confirm_ok">' + U.esc(opts.confirmText || '确定') + '</button>' +
          '<button class="btn-block ghost" data-act="__confirm_cancel">取消</button>',
        onMount: function () {
          on('__confirm_ok', function () { closeSheet(); resolve(true); });
          on('__confirm_cancel', function () { closeSheet(); resolve(false); });
        },
      });
    });
  }

  /* ---------------- 事件委托 ---------------- */
  var actions = {};
  function on(name, fn) { actions[name] = fn; }

  function runAction(node, ev) {
    var name = node.getAttribute('data-act');
    var fn = actions[name];
    if (fn) { ev.preventDefault(); fn(node, ev); }
  }

  function installDelegation() {
    document.addEventListener('click', function (ev) {
      var node = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (node) runAction(node, ev);
    });
    document.addEventListener('change', function (ev) {
      var node = ev.target && ev.target.closest ? ev.target.closest('[data-change]') : null;
      if (!node) return;
      var fn = actions[node.getAttribute('data-change')];
      if (fn) fn(node, ev);
    });
    document.addEventListener('input', function (ev) {
      var node = ev.target && ev.target.closest ? ev.target.closest('[data-input]') : null;
      if (!node) return;
      var fn = actions[node.getAttribute('data-input')];
      if (fn) fn(node, ev);
    });
  }

  /* ---------------- 表单辅助 ---------------- */
  function field(label, inputHtml, hint) {
    return '<div class="field"><label>' + U.esc(label) + '</label>' + inputHtml +
      (hint ? '<div class="err">' + U.esc(hint) + '</div>' : '') + '</div>';
  }

  function inputHtml(name, value, opts) {
    opts = opts || {};
    return '<input type="' + (opts.type || 'text') + '"' +
      (opts.inputmode ? ' inputmode="' + opts.inputmode + '"' : '') +
      (opts.placeholder ? ' placeholder="' + U.esc(opts.placeholder) + '"' : '') +
      ' data-k="' + name + '" value="' + U.esc(value === undefined || value === null ? '' : value) + '"' +
      (opts.autofocus ? ' autofocus' : '') + '>';
  }

  /** 读取弹层内所有 [data-k] 字段 */
  function readFields(scope) {
    var out = {};
    scope.querySelectorAll('[data-k]').forEach(function (n) {
      out[n.getAttribute('data-k')] = n.value;
    });
    return out;
  }

  return {
    ICONS: ICONS,
    icon: icon,
    avatar: avatar,
    moneyCell: moneyCell,
    deltaPill: deltaPill,
    emptyState: emptyState,
    toast: toast,
    openSheet: openSheet,
    closeSheet: closeSheet,
    confirm: confirmDialog,
    on: on,
    installDelegation: installDelegation,
    field: field,
    inputHtml: inputHtml,
    readFields: readFields,
  };
})();
