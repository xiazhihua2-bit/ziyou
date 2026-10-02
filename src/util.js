/* ==================== 命名空间 & 通用工具 ==================== */
var XJ = window.XJ || (window.XJ = {});

XJ.util = (function () {
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /* ---- 日期：全部走本地日期字符串 YYYY-MM-DD，规避时区问题 ---- */
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function today() { return ymd(new Date()); }
  function nowStamp() { return new Date().toISOString(); }

  /** 'YYYY-MM-DD' → 'MM-DD'（卡片角标用；长度不足则原样返回） */
  function mdShort(s) {
    var t = String(s || '');
    return t.length >= 10 ? t.slice(5, 10) : t;
  }

  function parseYmd(s) {
    if (!s) return null;
    var m = String(s).slice(0, 10).split('-');
    if (m.length !== 3) return null;
    var y = +m[0], mo = +m[1], da = +m[2];
    if (!y || !mo || !da) return null;
    var d = new Date(y, mo - 1, da);
    return isNaN(d.getTime()) ? null : d;
  }

  function addDays(s, n) {
    var d = parseYmd(s);
    if (!d) return null;
    d.setDate(d.getDate() + n);
    return ymd(d);
  }

  function daysBetween(a, b) {
    var da = parseYmd(a), db = parseYmd(b);
    if (!da || !db) return null;
    return Math.round((db - da) / 86400000);
  }

  function yearOf(s) { var d = parseYmd(s); return d ? d.getFullYear() : null; }
  function monthOf(s) { var d = parseYmd(s); return d ? d.getMonth() + 1 : null; }
  function ymOf(s) { return s ? String(s).slice(0, 7) : ''; }

  /* ---- 数值 ---- */
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    /* 先剔除千分位逗号与货币/单位符号，再 parseFloat。
       否则 parseFloat('-3,390.00') 会在逗号处截断，错误地得到 -3。 */
    var s = String(v).replace(/[,\s¥$元股手]/g, '').trim();
    if (!s) return null;
    var n = parseFloat(s);
    return isNaN(n) ? null : n;
  }
  function n0(v) { var n = num(v); return n === null ? 0 : n; }

  function thousands(str) {
    var parts = String(str).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }

  /** 金额：默认 2 位小数 + 千分位 */
  function money(v, dec) {
    var n = num(v);
    if (n === null) return '—';
    if (dec === undefined) dec = 2;
    var neg = n < 0;
    var s = thousands(Math.abs(n).toFixed(dec));
    return (neg ? '-' : '') + s;
  }
  /** 带 ¥ 符号 */
  function moneySign(v, dec) {
    var s = money(v, dec);
    return s === '—' ? s : '¥' + s;
  }
  /** 大额紧凑：12345 -> 1.23万 */
  function moneyCompact(v) {
    var n = num(v);
    if (n === null) return '—';
    var a = Math.abs(n);
    if (a >= 1e8) return (n / 1e8).toFixed(2) + '亿';
    if (a >= 1e4) return (n / 1e4).toFixed(2) + '万';
    return money(n, 2);
  }
  /** 坐标轴百分比刻度：0.0% / 12.5%（收益率曲线与指数对比用） */
  function pctAxis(v) {
    var n = num(v);
    if (n === null) return '';
    return (Math.abs(n) >= 10 ? n.toFixed(0) : n.toFixed(1)) + '%';
  }

  /** 坐标轴刻度：整万/整亿，避免「121.00万」这种拖长的标签把图挤小 */
  function moneyAxis(v) {
    var n = num(v);
    if (n === null) return '';
    var a = Math.abs(n);
    if (a >= 1e8) { var y = n / 1e8; return (Math.abs(y) >= 10 ? y.toFixed(0) : y.toFixed(1)) + '亿'; }
    if (a >= 1e4) { var w = n / 1e4; return (Math.abs(w) >= 10 ? w.toFixed(0) : w.toFixed(1)) + '万'; }
    return money(n, 0);
  }
  function pct(v, dec) {
    var n = num(v);
    if (n === null) return '—';
    if (dec === undefined) dec = 2;
    return n.toFixed(dec) + '%';
  }
  function signPct(v, dec) {
    var n = num(v);
    if (n === null) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(dec === undefined ? 2 : dec) + '%';
  }
  function signMoney(v, dec) {
    var n = num(v);
    if (n === null) return '—';
    return (n > 0 ? '+' : n < 0 ? '-' : '') + '¥' + money(Math.abs(n), dec);
  }
  /** 涨跌方向 class：>0 涨红 / <0 跌绿 / =0 灰 */
  function dirClass(v) {
    var n = num(v);
    if (n === null || n === 0) return 'c-flat';
    return n > 0 ? 'c-up' : 'c-down';
  }
  function direction(v) {
    var n = num(v);
    if (n === null || n === 0) return 'flat';
    return n > 0 ? 'up' : 'down';
  }

  /* ---- ID ---- */
  var seq = 0;
  function uid(prefix) {
    seq++;
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + seq.toString(36) +
      Math.random().toString(36).slice(2, 6);
  }

  /* ---- 字符串 ---- */
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  /** 取首字用于头像（中文取首字，字母取首字母） */
  function initial(name) {
    if (!name) return '?';
    var s = String(name).replace(/^[*\s]+/, '');
    return s.charAt(0) || '?';
  }
  /**
   * 取前两字作为「简称头像」。拿不到公司图标时用它代替单个首字 —— 两个字的中文简称
   * （中远海控→中远、申能股份→申能）更像一枚品牌标识，而不是一个字母。
   * 带前缀的摘帽/风险警示名（*ST海航、C中国平安）优先取其中的中文部分，避免头像变成「S」。
   */
  function shortName(name) {
    if (!name) return '?';
    var s = String(name).replace(/^[*\s]+/, '').replace(/\s+/g, '');
    if (!s) return '?';
    var cjk = s.match(/[\u4e00-\u9fa5]{1,2}/);
    if (cjk) return cjk[0];
    if (/^[0-9A-Za-z]/.test(s)) return s.charAt(0).toUpperCase();
    return s.slice(0, 2);
  }
  /** 由 symbol 稳定派生一个颜色 */
  var AVATAR_COLORS = ['#5B8DEF', '#E0685A', '#4CAF7D', '#B07CE8', '#E0A03A',
    '#3FA9C9', '#D9648F', '#6B7FD7', '#C4884A', '#4FA3A0'];
  function colorOf(key) {
    var h = 0, s = String(key || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100000;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  /**
   * 两笔金额是否可视为「同一笔」。
   * 用途：分红去重 —— 自动登记的金额是「持股数 × 每股」算出来的，
   * 而手工补录/OCR 导入的是券商页面上的数字，两者可能有几分钱差异，需要容差。
   * 判定：完全相等，或相差 ≤ 1 元，或相差 ≤ 1%。
   */
  function closeAmount(a, b) {
    var x = n0(a), y = n0(b);
    if (x === y) return true;
    if (x <= 0 || y <= 0) return false;
    var diff = Math.abs(x - y);
    return diff <= 1 || diff <= Math.max(x, y) * 0.01;
  }

  /**
   * 两笔分红是否指向同一次分配。
   * 键：同一标的 + 同一账户 + 同一到账日 + 金额相符。
   */
  function sameDividend(r, o) {
    if (!r || !o) return false;
    if (r.accountId !== o.accountId) return false;
    if (r.symbol !== o.symbol) return false;
    if (String(r.exDividendDate || '') !== String(o.exDividendDate || '')) return false;
    return closeAmount(r.amount, o.amount);
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* 判断一个字符串是否含有「名称信息」。
     纯代码（601318 / sh601318 / AAPL）、纯数字、空白 —— 都算"没有信息量"。 */
  var CODE_LIKE = /^[0-9A-Za-z.\-]+$/;
  function hasNameInfo(s) {
    var t = String(s === null || s === undefined ? '' : s).trim();
    if (!t) return false;
    return !CODE_LIKE.test(t);
  }

  /* 数字转中文（用于「共七笔」这类文案），0 与 >10 的复杂情形直接返回阿拉伯数字 */
  var CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  function cn(v) {
    var n = Math.round(num(v) === null ? 0 : num(v));
    if (n <= 0) return String(n);
    if (n <= 10) return CN_NUM[n];
    if (n < 20) return '十' + CN_NUM[n - 10];
    if (n < 100) return CN_NUM[Math.floor(n / 10)] + '十' + (n % 10 ? CN_NUM[n % 10] : '');
    return String(n);
  }
  function sum(arr, fn) {
    var t = 0;
    for (var i = 0; i < arr.length; i++) t += n0(fn ? fn(arr[i]) : arr[i]);
    return t;
  }
  function groupBy(arr, keyFn) {
    var m = {};
    for (var i = 0; i < arr.length; i++) {
      var k = keyFn(arr[i]);
      (m[k] || (m[k] = [])).push(arr[i]);
    }
    return m;
  }

  /** 下载文本为文件 */
  function download(filename, text, mime) {
    var blob = new Blob(['\ufeff' + text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
  }

  return {
    pad2: pad2, ymd: ymd, today: today, nowStamp: nowStamp, mdShort: mdShort,
    parseYmd: parseYmd, addDays: addDays, daysBetween: daysBetween,
    yearOf: yearOf, monthOf: monthOf, ymOf: ymOf,
    num: num, n0: n0, money: money, moneySign: moneySign, moneyCompact: moneyCompact,
    moneyAxis: moneyAxis, pctAxis: pctAxis,
    pct: pct, signPct: signPct, signMoney: signMoney, thousands: thousands,
    dirClass: dirClass, direction: direction,
    uid: uid, esc: esc, initial: initial, shortName: shortName, colorOf: colorOf,
    clamp: clamp, sum: sum, groupBy: groupBy, download: download, cn: cn,
    hasNameInfo: hasNameInfo,
    closeAmount: closeAmount,
    sameDividend: sameDividend,
  };
})();
