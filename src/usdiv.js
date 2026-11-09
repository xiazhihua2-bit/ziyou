/* ==================== 美股分红（东方财富美股 F10 公开报表） ====================
 * 数据源：https://datacenter-web.eastmoney.com/api/data/v1/get
 *         reportName=RPT_USF10_INFO_DIVIDEND（公开、无需登录、支持 JSONP callback）
 * 合规边界：只读取无需登录的公开公司行为数据；不访问任何原产品服务端，
 *           不携带/不模拟会员凭证，不读取需授权的用户数据，不对外分发。
 *
 * 口径（与 A股/港股方案同形，日历 / 到账 / 预测 / 回本 / CSV / 统计复用同一套逻辑）：
 *   · 只收 ASSIGN_TYPE=Cash；拆股、股票股息不进分红台账
 *   · pretaxBonusPer10 = 每股美元 × 10（全站内部单位「元/10股」），一律【税前】
 *   · BONUS_PAY_DATE 是数据源给出的【真实派息日】，标为确定值，不是「预计派息日」
 *   · reportDate = 除息日所在自然年 + '-12-31'（仅作分组键）
 *   · 预测年度分红不走财年口径：美股按季/月派息，年内未派完会系统性低估 →
 *     由 calc.annualBasePerShare 对 source='us' 改走近 12 个月（按除息日归属）合计
 *   · isImplemented 以「除息日 ≤ 今天」推断；数据源没有进度字段，界面如实写「按除息日推断」
 *   · 币种 USD；金额税前；展示按 settings.fx.USD 实时汇率折人民币；【未计入】境外预扣税
 *   · 按财年口径的股息率曲线对美股不适用（没有年报预案公告日这个切换锚点）
 */
XJ.usdiv = (function () {
  'use strict';
  var U = XJ.util;

  var API = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
  var REPORT = 'RPT_USF10_INFO_DIVIDEND';
  /* SECUCODE 后缀：.O 纳斯达克 / .N 纽交所 / .A 美交所·ARCA。
     实测 AAPL.O MSFT.O NVDA.O QQQ.O、KO.N JNJ.N V.N O.N TSM.N、SCHD.A SPY.A 命中；
     AAPL.N / KO.O 返回 0 行（不是接口报错）。 */
  var SUFFIXES = ['.O', '.N', '.A'];
  var TIMEOUT = 12000;
  var GAP = 90;                // 批量逐只间隔（ms），避免限流
  var cbSeq = 0;
  var suffixMap = {};          // symbol -> 命中的后缀（本次会话内存缓存，不落盘、不进同步）
  var requester = null;        // 可注入的请求实现（独立测试用；生产恒为 null）

  /** 东财日期可能是 '2026-08-07 00:00:00' 或 '2026/08/07'，统一成 YYYY-MM-DD */
  function d10(v) {
    if (!v) return null;
    var s = String(v).trim().slice(0, 10).replace(/\//g, '-');
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  }

  /**
   * 解析「每1股派0.27美元股息 / 每1份派0.75143美元股息 / 每1份ADR派1.085439美元股息」。
   * 返回【每股（份）税前美元金额】；每股金额 = 宣派金额 ÷ 份数。
   * 只认美元文案：其它币种宁可留空也不猜。拆股 / 股票股息不匹配 → null。
   */
  function parsePerShare(text) {
    if (!text) return null;
    var t = String(text);
    var m = t.match(/每\s*([\d.]+)\s*(?:股|份\s*(?:ADR)?)\s*派\s*([\d.]+)\s*(?:美元|美金)/i);
    if (!m) return null;
    if (!/(美元|美金|USD)/i.test(t)) return null;
    var units = U.num(m[1]), amt = U.num(m[2]);
    if (units === null || amt === null || units <= 0 || amt <= 0) return null;
    return amt / units;
  }

  /** 原始行 → 与 A股/港股/基金完全同形的 DividendPlan */
  function toPlan(row, symbol, suffix, today) {
    if (!row || !symbol) return null;
    /* 只收现金派息：股票股息 / 拆股 / 配股都不进分红台账 */
    if (!/^cash/i.test(String(row.ASSIGN_TYPE || ''))) return null;

    var ex = d10(row.EX_DIVIDEND_DATE);
    var pay = d10(row.BONUS_PAY_DATE);
    var rec = d10(row.EQUITY_RECORD_DATE);
    var notice = d10(row.NOTICE_DATE);
    var per = parsePerShare(row.PLAN_EXPLAIN);
    if (per === null || per <= 0) return null;
    if (!ex && !pay) return null;

    var anchor = ex || pay || notice || '';
    var year = anchor ? anchor.slice(0, 4) : String(U.today()).slice(0, 4);
    var reportDate = year + '-12-31';                    // 自然年分组键
    var implemented = !!ex && ex <= (today || U.today()); // 按除息日推断，非官方进度

    return {
      planId: symbol + '_' + (ex || pay || notice || 'na') + '_' + per.toFixed(6),
      symbol: symbol,
      securityCode: row.SECURITY_CODE || XJ.market.codeOf(symbol),
      securityName: row.SECURITY_NAME_ABBR || '',
      reportDate: reportDate,
      reportType: row.ASSIGN_PERIOD || '美股分红',
      pretaxBonusPer10: per * 10,
      afterTaxPer10: null,                              // 税前口径，未计入境外预扣税
      implPlanProfile: row.PLAN_EXPLAIN || ('每1股派' + per + '美元股息'),
      planNoticeDate: notice,
      noticeDate: notice,
      equityRecordDate: rec,
      exDividendDate: ex,
      payoutDate: pay,                                  // 真实派息日
      assignProgress: implemented ? '实施分配' : '公告预案',
      progressRank: implemented ? 100 : 60,
      isImplemented: implemented,
      dividendRatio: null,
      currency: 'USD',
      source: 'us',
      assignType: row.ASSIGN_TYPE || 'Cash',
      assignPeriod: row.ASSIGN_PERIOD || null,
      marketSuffix: suffix || null,
      fetchedAt: U.nowStamp(),
    };
  }

  function buildUrl(secucode) {
    return API +
      '?reportName=' + REPORT + '&columns=ALL' +
      '&filter=' + encodeURIComponent('(SECUCODE="' + secucode + '")') +
      '&pageNumber=1&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1' +
      '&source=WEB&client=WEB';
  }

  /** JSONP：file:// 单文件页面唯一可靠通道（与港股分红同一 host）。任何失败都 resolve(null) */
  function jsonp(url) {
    return new Promise(function (resolve) {
      var name = 'xjus_' + (++cbSeq) + '_' + Date.now().toString(36);
      var s = document.createElement('script');
      var settled = false;
      var timer = setTimeout(function () { finish(null); }, TIMEOUT);
      function cleanup() {
        clearTimeout(timer);
        try { delete window[name]; } catch (e) { window[name] = undefined; }
        try { if (s.parentNode) s.parentNode.removeChild(s); } catch (e) { /* noop */ }
      }
      function finish(v) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(v || null);
      }
      window[name] = function (res) { finish(res || null); };
      s.charset = 'utf-8';
      s.src = url + '&callback=' + name;
      s.onerror = function () { finish(null); };
      document.head.appendChild(s);
    });
  }

  /** 取一个 SECUCODE 的原始行；接口失败 / 空数据都返回 []（绝不 reject） */
  function fetchOne(secucode) {
    if (requester) {
      return Promise.resolve().then(function () { return requester(secucode); })
        .then(function (rows) { return Array.isArray(rows) ? rows : []; })
        .catch(function () { return []; });
    }
    return jsonp(buildUrl(secucode)).then(function (res) {
      if (!res || !res.result || !Array.isArray(res.result.data)) return [];
      return res.result.data;
    }).catch(function () { return []; });
  }

  /**
   * 后缀探测与正式取数【合并为同一次请求】：.O→.N→.A，第一个返回非空数据的即为该标的后缀，
   * 命中后直接用这一批 rows 解析（不再发第二次请求），并缓存后缀。
   * 三个后缀都空 = 公开报表无记录 / 该标的不派息 → 返回空方案（界面如实展示空态，不编造）。
   */
  function fetchSymbol(symbol) {
    var code = XJ.market.codeOf(symbol);
    var known = suffixMap[symbol];
    var candidates = known
      ? [known].concat(SUFFIXES.filter(function (x) { return x !== known; }))
      : SUFFIXES.slice();
    var today = U.today();
    var i = 0;

    function step() {
      if (i >= candidates.length) {
        return Promise.resolve({ symbol: symbol, plans: [], suffix: null, noData: true });
      }
      var suf = candidates[i++];
      return fetchOne(code + suf).then(function (rows) {
        if (!rows || !rows.length) return step();
        suffixMap[symbol] = suf;
        var seen = {}, plans = [];
        rows.forEach(function (r) {
          var p = toPlan(r, symbol, suf, today);
          if (p && !seen[p.planId]) { seen[p.planId] = true; plans.push(p); }
        });
        plans.sort(function (a, b) {
          var x = a.exDividendDate || a.payoutDate || '';
          var y = b.exDividendDate || b.payoutDate || '';
          return x < y ? 1 : -1;
        });
        return { symbol: symbol, plans: plans, suffix: suf, noData: false };
      });
    }
    return step();
  }

  /** 批量串行 + 间隔；单只失败不中断其它标的。返回 { plans: {sym: plans[]}, noData: sym[] } */
  function fetchAll(symbols, onProgress) {
    symbols = (symbols || []).filter(function (s, i, a) { return s && a.indexOf(s) === i; });
    var bySym = {}, noData = [], i = 0;
    function step() {
      if (i >= symbols.length) return Promise.resolve({ plans: bySym, noData: noData });
      var sym = symbols[i++];
      return fetchSymbol(sym).then(function (r) {
        bySym[sym] = r.plans;
        if (r.noData) noData.push(sym);
        if (onProgress) onProgress(i, symbols.length, sym);
        if (i >= symbols.length) return { plans: bySym, noData: noData };
        return new Promise(function (res) { setTimeout(res, GAP); }).then(step);
      });
    }
    if (!symbols.length) return Promise.resolve({ plans: bySym, noData: noData });
    return step();
  }

  /* ---------------- 展示层辅助（仅美股，底层金额仍存 USD 税前原币） ---------------- */

  function isUs(symbol) { return XJ.market.assetType(symbol) === 'us'; }

  /** 实时汇率 settings.fx.USD（腾讯 whUSDCNY）；缺失或非法返回 null */
  function usdRate(state) {
    var fx = state && state.settings && state.settings.fx;
    var v = fx ? U.num(fx.USD) : null;
    return (v && v > 0) ? v : null;
  }

  /**
   * 单笔分红金额的展示文本：
   *   · 非美股 → 沿用 U.moneySign（¥ 原值，既有口径不动）
   *   · 美股 + 汇率可用 → 按实时汇率折成 ¥
   *   · 美股 + 汇率缺失 → 显示 USD 原币「$x.xx」，绝不按 1 折算造成 1 美元当 1 元的假数字
   */
  function moneyText(state, symbol, amount, dec) {
    if (!isUs(symbol)) return U.moneySign(amount, dec);
    var r = usdRate(state);
    if (!r) return '$' + U.money(amount, dec);
    return U.moneySign(U.n0(amount) * r, dec);
  }

  /** 金额旁的口径说明（税前 / 汇率 / 未计税） */
  function rateNote(state, symbol) {
    if (!isUs(symbol)) return '';
    var r = usdRate(state);
    return (r ? '按实时汇率 ' + r + ' 折人民币' : '汇率未取到，暂未折算（USD 原币）') +
      ' · 税前，未计入境外预扣税';
  }

  /** 测试注入点：useRequester(fn) 替换底层取数，useRequester(null) 复位 */
  function useRequester(fn) { requester = fn || null; }
  function clearSuffixCache() {
    Object.keys(suffixMap).forEach(function (k) { delete suffixMap[k]; });
  }

  return {
    API: API, REPORT: REPORT, SUFFIXES: SUFFIXES,
    suffixMap: suffixMap,
    d10: d10, parsePerShare: parsePerShare, toPlan: toPlan, buildUrl: buildUrl,
    fetchOne: fetchOne, fetchSymbol: fetchSymbol, fetchAll: fetchAll,
    isUs: isUs, usdRate: usdRate, moneyText: moneyText, rateNote: rateNote,
    useRequester: useRequester, clearSuffixCache: clearSuffixCache,
  };
})();
