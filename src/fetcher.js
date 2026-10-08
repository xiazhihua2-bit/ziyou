/* ==================== 取数层 ====================
 * 两个数据源均通过 <script> 注入实现，天然绕开 CORS，file:// 下可直接用。
 *  A) 腾讯行情   https://qt.gtimg.cn/q=sh600023,sz000858   （GBK 编码的 JS 变量赋值）
 *  B) 东财分红   datacenter-web.eastmoney.com/api/data/v1/get （支持 JSONP callback）
 */
XJ.fetcher = (function () {
  var U = XJ.util;

  var QUOTE_URL = 'https://qt.gtimg.cn/q=';
  var PLAN_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
  var QUOTE_TIMEOUT = 9000;
  var PLAN_TIMEOUT = 14000;
  var CHUNK = 40;             // 腾讯单次建议不超过 40 只
  var PLAN_GAP = 120;         // 分红方案逐只查询的间隔（ms）

  var cbSeq = 0;
  var lastError = null;

  /* ---------------- 行情 ---------------- */

  /** 交易所除权除息/新股等前缀，行情接口会把它们拼在名称前并截断原名 */
  var NAME_PREFIX = /^(XD|XR|DR|N|C)(?=[\u4e00-\u9fa5A-Za-z])/;

  function cleanName(raw) {
    if (!raw) return '';
    return String(raw).replace(/\s+/g, '').replace(NAME_PREFIX, '');
  }

  /** 行情解析已下沉到 market.js（各市场字段位不同），此处仅做转发与名称清洗 */
  function parseQuote(symbol, raw) {
    var q = XJ.market.parseQuoteFields(symbol, raw);
    if (q) {
      q.nameRaw = raw.split('~')[1] || '';
      q.name = cleanName(q.nameRaw);
    }
    return q;
  }

  /** 拉取汇率：港币 / 美元 兑 人民币 */
  function fetchFX() {
    var curs = Object.keys(XJ.market.FX_SYMBOL);
    if (!curs.length) return Promise.resolve({});
    var codes = curs.map(function (c) { return XJ.market.FX_SYMBOL[c]; });
    return new Promise(function (resolve) {
      loadScript(QUOTE_URL + codes.join(','), 'GBK', QUOTE_TIMEOUT, function (ok) {
        var out = {};
        if (!ok) return resolve(out);
        curs.forEach(function (cur) {
          var v = XJ.market.parseFx(window['v_' + XJ.market.FX_SYMBOL[cur]]);
          if (v) out[cur] = v;
        });
        resolve(out);
      });
    });
  }

  function loadScript(src, charset, timeout, onDone) {
    var s = document.createElement('script');
    s.async = true;
    if (charset) s.charset = charset;
    var settled = false;
    var timer = setTimeout(function () { finish(false); }, timeout);
    function cleanup() {
      clearTimeout(timer);
      s.onload = s.onerror = null;
      if (s.parentNode) s.parentNode.removeChild(s);
    }
    function finish(ok) {
      if (settled) return;
      settled = true;
      cleanup();
      onDone(ok);
    }
    s.onload = function () { finish(true); };
    s.onerror = function () { finish(false); };
    s.src = src;
    document.head.appendChild(s);
  }

  /** 拉取行情：分片并发，单只失败不影响整体（非行情类标的自动跳过） */
  function fetchQuotes(symbols) {
    symbols = (symbols || []).filter(function (s, i, a) {
      return s && a.indexOf(s) === i && XJ.market.isQuoteable(s);
    });
    if (!symbols.length) return Promise.resolve({});

    var chunks = [];
    for (var i = 0; i < symbols.length; i += CHUNK) chunks.push(symbols.slice(i, i + CHUNK));

    var out = {};
    var pending = chunks.length;

    return new Promise(function (resolve) {
      function oneChunk(ch) {
        loadScript(QUOTE_URL + ch.join(','), 'GBK', QUOTE_TIMEOUT, function (ok) {
          if (ok) {
            ch.forEach(function (sym) {
              var q = parseQuote(sym, window['v_' + sym]);
              if (q) out[sym] = q;
            });
          } else {
            lastError = new Error('行情接口请求失败');
          }
          pending--;
          if (pending <= 0) resolve(out);
        });
      }
      chunks.forEach(oneChunk);
    });
  }

  /* ---------------- 分红方案 ---------------- */

  var PROGRESS_RANK = [
    [/实施分配/, 100],
    [/股东大会通过/, 70],
    [/董事会决议通过/, 60],
    [/预案/, 50],
    [/取消/, 0],
  ];
  function rankOf(progress) {
    var s = progress || '';
    for (var i = 0; i < PROGRESS_RANK.length; i++) {
      if (PROGRESS_RANK[i][0].test(s)) return PROGRESS_RANK[i][1];
    }
    return 40;
  }

  function d10(v) {
    if (!v) return null;
    var s = String(v).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  }

  function reportTypeOf(reportDate) {
    var m = reportDate.slice(5, 7);
    if (m === '12') return '年报';
    if (m === '06') return '中报';
    if (m === '03') return '一季报';
    if (m === '09') return '三季报';
    return '其它';
  }

  function parsePlanRow(row, symbol) {
    var reportDate = d10(row.REPORT_DATE);
    if (!reportDate) return null;
    var progress = row.ASSIGN_PROGRESS || '';
    if (rankOf(progress) === 0) return null;               // 已取消分配，不展示

    var pretax = U.num(row.PRETAX_BONUS_RMB);
    var profile = row.IMPL_PLAN_PROFILE || '';
    var m = profile.match(/扣税后([\d.]+)元/);
    var afterTax = m ? U.num(m[1]) : null;

    return {
      planId: symbol + '_' + reportDate,
      symbol: symbol,
      securityCode: row.SECURITY_CODE || XJ.model.codeOf(symbol),
      securityName: row.SECURITY_NAME_ABBR || '',
      reportDate: reportDate,
      reportType: reportTypeOf(reportDate),
      pretaxBonusPer10: pretax === null ? 0 : pretax,
      afterTaxPer10: afterTax,
      implPlanProfile: profile,
      planNoticeDate: d10(row.PLAN_NOTICE_DATE),
      noticeDate: d10(row.NOTICE_DATE),
      equityRecordDate: d10(row.EQUITY_RECORD_DATE),
      exDividendDate: d10(row.EX_DIVIDEND_DATE),
      assignProgress: progress,
      progressRank: rankOf(progress),
      isImplemented: progress.indexOf('实施分配') >= 0,
      dividendRatio: U.num(row.DIVIDENT_RATIO),
      fetchedAt: U.nowStamp(),
    };
  }

  /** 同一 reportDate 可能返回多条（预案/实施），合并为一条：取进度最高者，日期互补 */
  function mergeByReportDate(plans) {
    var map = {};
    plans.forEach(function (p) {
      var cur = map[p.planId];
      if (!cur) { map[p.planId] = p; return; }
      var win = (p.progressRank || 0) > (cur.progressRank || 0) ? p : cur;
      var lose = win === p ? cur : p;
      ['equityRecordDate', 'exDividendDate', 'planNoticeDate', 'noticeDate',
        'afterTaxPer10', 'implPlanProfile'].forEach(function (k) {
          if ((win[k] === null || win[k] === undefined || win[k] === '') &&
            lose[k] !== null && lose[k] !== undefined && lose[k] !== '') win[k] = lose[k];
        });
      map[p.planId] = win;
    });
    return Object.keys(map).map(function (k) { return map[k]; });
  }

  /** 拉取单个标的的全部分红方案（JSONP） */
  function fetchPlans(symbol) {
    var code = XJ.model.codeOf(symbol);
    var cbName = 'xjcb_' + (++cbSeq) + '_' + Date.now().toString(36);
    var url = PLAN_URL +
      '?reportName=RPT_SHAREBONUS_DET&columns=ALL' +
      '&filter=' + encodeURIComponent('(SECURITY_CODE="' + code + '")') +
      '&pageNumber=1&pageSize=100&sortColumns=REPORT_DATE&sortTypes=-1' +
      '&source=WEB&client=WEB&callback=' + cbName;

    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () { finish(null); }, PLAN_TIMEOUT);

      function cleanup() {
        clearTimeout(timer);
        try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
      }
      function finish(res) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(res);
      }

      window[cbName] = function (res) { finish(res || null); };
      loadScript(url, null, PLAN_TIMEOUT, function (ok) {
        if (!ok) { lastError = new Error('分红接口请求失败'); finish(null); }
        // onload 但回调没触发的情况由 timeout 兜底
      });
    }).then(function (res) {
      if (!res || !res.result || !Array.isArray(res.result.data)) return [];
      var parsed = [];
      res.result.data.forEach(function (row) {
        var p = parsePlanRow(row, symbol);
        if (p) parsed.push(p);
      });
      return mergeByReportDate(parsed).sort(function (a, b) {
        return a.reportDate < b.reportDate ? 1 : -1;
      });
    });
  }

  /** 批量拉取：逐只串行 + 间隔，避免被限流 */
  function fetchAllPlans(symbols, onProgress) {
    symbols = (symbols || []).filter(function (s, i, a) { return s && a.indexOf(s) === i; });
    var result = {};      // symbol -> plans[]
    var i = 0;

    function step() {
      if (i >= symbols.length) return Promise.resolve(result);
      var sym = symbols[i++];
      return fetchPlans(sym).then(function (plans) {
        result[sym] = plans;
        if (onProgress) onProgress(i, symbols.length, sym);
        if (i >= symbols.length) return result;
        return new Promise(function (r) { setTimeout(r, PLAN_GAP); }).then(step);
      });
    }
    if (!symbols.length) return Promise.resolve(result);
    return step();
  }

  /* ---------------- 基金分红（天天基金） ----------------
   * 接口返回 JS 变量赋值： var pageinfo=[总页数,每页,当前页]; var jjfh_data=[[...]];
   * 行字段顺序：[基金代码, 基金简称, 权益登记日, 除息日, 每份分红(元), 分红发放日, 类型码]
   * 全市场按基金代码升序分页，需本地按代码筛选。
   * 优势：基金有【独立的分红发放日】，不必像 A 股那样用 T+1 推算。
   */
  var FUND_DIV_URL = 'https://fund.eastmoney.com/Data/funddataIndex_Interface.aspx';
  var FUND_MAX_PAGES = 80;      // 安全上限：单年最多抓 80 页（8000 条）
  var FUND_GAP = 90;

  function parseFundDivRow(r) {
    if (!Array.isArray(r) || r.length < 6) return null;
    var pay = d10(r[5]);
    var ex = d10(r[3]);
    var reg = d10(r[2]);
    if (!ex && !reg && !pay) return null;
    return {
      fundCode: String(r[0] || ''),
      fundName: String(r[1] || ''),
      equityRecordDate: reg,
      exDividendDate: ex,
      perShare: U.num(r[4]),
      payoutDate: pay,
    };
  }

  function fetchFundDivPage(year, page) {
    var src = FUND_DIV_URL + '?dt=8&page=' + page + '&rank=BZDM&sort=asc&gs=&ftype=&year=' + year;
    return new Promise(function (resolve) {
      loadScript(src, 'GBK', PLAN_TIMEOUT, function (ok) {
        if (!ok) return resolve(null);
        var data = window.jjfh_data;
        var info = window.pageinfo;
        try { window.jjfh_data = null; window.pageinfo = null; } catch (e) {}
        resolve({ data: Array.isArray(data) ? data : null, info: info || null });
      });
    });
  }

  /** 抓某一年的全市场基金分红（分页），返回已解析行数组 */
  function fetchFundDivYear(year, onProgress) {
    var all = [];
    var page = 1;
    var totalPages = 1;

    function step() {
      if (page > totalPages || page > FUND_MAX_PAGES) return Promise.resolve(all);
      var cur = page;
      return fetchFundDivPage(year, cur).then(function (res) {
        if (!res || !res.data) { totalPages = 0; return all; }
        res.data.forEach(function (r) {
          var row = parseFundDivRow(r);
          if (row) all.push(row);
        });
        if (res.info && res.info[0]) totalPages = +res.info[0];
        if (onProgress) onProgress(cur, totalPages, year, all.length);
        page = cur + 1;
        if (page > totalPages || page > FUND_MAX_PAGES) return all;
        return new Promise(function (r) { setTimeout(r, FUND_GAP); }).then(step);
      });
    }
    return step();
  }

  /** 只为指定基金代码抓分红（跨多个年份） */
  function fetchFundDividends(codes, years, onProgress) {
    var wanted = {};
    (codes || []).forEach(function (c) { wanted[String(c)] = true; });
    if (!Object.keys(wanted).length) return Promise.resolve({});

    var out = {};
    var chain = Promise.resolve();
    (years || []).forEach(function (y) {
      chain = chain.then(function () {
        return fetchFundDivYear(y, onProgress).then(function (rows) {
          rows.forEach(function (r) {
            if (!wanted[r.fundCode]) return;
            (out[r.fundCode] || (out[r.fundCode] = [])).push(r);
          });
        });
      });
    });
    return chain.then(function () { return out; });
  }

  /** 基金分红行 → 统一的 DividendPlan 结构（复用现有日历/到账/统计链路） */
  function fundRowToPlan(row, symbol) {
    var dateKey = row.exDividendDate || row.equityRecordDate || row.payoutDate;
    var per10 = (row.perShare === null ? 0 : row.perShare) * 10;
    return {
      planId: symbol + '_' + dateKey,
      symbol: symbol,
      securityCode: row.fundCode,
      securityName: row.fundName,
      reportDate: dateKey,
      reportType: '基金分红',
      pretaxBonusPer10: per10,
      afterTaxPer10: null,
      implPlanProfile: '每10份派现金' + per10.toFixed(4) + '元',
      planNoticeDate: null,
      noticeDate: null,
      equityRecordDate: row.equityRecordDate,
      exDividendDate: row.exDividendDate,
      payoutDate: row.payoutDate,      // ← 真实发放日，非推算
      assignProgress: '实施分配',
      progressRank: 100,
      isImplemented: true,
      dividendRatio: null,
      source: 'fund',
      fetchedAt: U.nowStamp(),
    };
  }

  /**
   * 按内部 symbol 反查**完整名称**。
   * 存在意义：行情接口的名称字段会被交易所前缀挤占 —— 除息日腾讯返回「XD中国平」，
   * 剥掉前缀只剩「中国平」，而联想接口按代码能拿到未截断的「中国平安」。
   */
  function fetchNames(symbols) {
    var list = (symbols || []).filter(function (s, i, a) { return s && a.indexOf(s) === i; });
    if (!list.length) return Promise.resolve({});
    var out = {};
    var i = 0;
    function step() {
      if (i >= list.length) return Promise.resolve(out);
      var sym = list[i++];
      return fetchSymbolSearch(XJ.market.codeOf(sym)).then(function (rows) {
        var hit = rows.filter(function (r) { return r.symbol === sym; })[0];
        if (!hit) {
          var code = XJ.market.codeOf(sym);
          hit = rows.filter(function (r) { return r.code === code && r.symbol === sym; })[0];
        }
        if (hit && hit.name) out[sym] = hit.name;
      }).catch(function () { /* 单只失败不影响其它 */ }).then(function () {
        if (i >= list.length) return out;
        return new Promise(function (r) { setTimeout(r, 80); }).then(step);
      });
    }
    return step();
  }

  /* ---------------- 股票搜索（腾讯联想 smartbox） ----------------
   * 返回 JS 变量赋值： v_hint="sz~000895~双汇发展~shfz~GP-A^..."
   * 字段：[市场, 代码, 名称, 拼音首字母, 类型]，多条以 ^ 分隔
   */
  var HINT_URL = 'https://smartbox.gtimg.cn/s3/';

  function parseHint(raw) {
    if (!raw || typeof raw !== 'string') return [];
    var out = [];
    raw.split('^').forEach(function (item) {
      var f = String(item).split('~');
      if (f.length < 4) return;
      var mk = f[0], code = f[1], name = f[2], pinyin = f[3], type = f[4] || '';
      var sym = XJ.market.normalize(mk + code) || XJ.market.normalize(code);
      if (!sym) return;
      if (out.some(function (x) { return x.symbol === sym; })) return;
      out.push({
        symbol: sym, code: code, market: mk, name: name,
        pinyin: pinyin, type: type, kind: XJ.market.kind(sym),
      });
    });
    return out;
  }

  function fetchSymbolSearch(keyword) {
    return new Promise(function (resolve) {
      var kw = String(keyword || '').trim();
      if (kw.length < 1) return resolve([]);
      var src = HINT_URL + '?v=2&q=' + encodeURIComponent(kw) + '&t=all&c=1';
      loadScript(src, 'GBK', 6000, function (ok) {
        if (!ok) return resolve([]);
        var raw = window.v_hint;
        try { window.v_hint = ''; } catch (e) { window.v_hint = undefined; }
        resolve(parseHint(raw));
      });
    });
  }

  /* ---------------- 港股分红（东财港股 F10） ----------------
   * RPT_HKF10_MAIN_DIVBASIC，与 A 股分红同一个 host，支持 JSONP。
   * 字段：YEAR 财政年度 · REPORT_TYPE 分配类型 · PLAN_EXPLAIN 方案文案
   *       EX_DIVIDEND_DATE 除净日 · DIVIDEND_DATE 派息日 · TRANSFER_END_DATE 截止过户日
   *       IS_BFP = 1 表示「未派发或宣派股息」，需过滤
   * 优势：港股带【独立派息日】，不必像 A 股那样用 T+1 推算。
   * 注意：美股暂无公开可用的免费分红源，不做自动同步（可手工补录）。
   */
  var HK_PLAN_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';

  /** '2026/05/15' → '2026-05-15' */
  function dslash(v) {
    if (!v) return null;
    var s = String(v).slice(0, 10).replace(/\//g, '-');
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  }

  /** 从方案文案里抠出每股现金分红（港币）。人民币派息时优先取括号里的港币折算值 */
  function parseHkPerShare(text) {
    if (!text) return null;
    var t = String(text);
    // ① 「(相当于港币0.0049元)」—— 人民币派息时的港币折算值
    var m = t.match(/相当于港?[元币]\s*([\d.]+)\s*元/);
    if (m) return U.num(m[1]);
    // ② 「(相当于每股派18.13港元)」
    m = t.match(/相当于每股派\s*([\d.]+)\s*港?[元币]/);
    if (m) return U.num(m[1]);
    // ③ 「每股派港币5.3元」
    m = t.match(/每股派港[元币]\s*([\d.]+)\s*元/);
    if (m) return U.num(m[1]);
    // ④ 「每股派1.15港元」
    m = t.match(/每股派\s*([\d.]+)\s*港元/);
    if (m) return U.num(m[1]);
    // ⑤ 「每股派人民币X元」（无港币折算值时的兜底）
    m = t.match(/每股派人民币\s*([\d.]+)\s*元/);
    if (m) return U.num(m[1]);
    return null;
  }

  /** 财政年度 + 分配类型 → 报告期（让财年口径对港股同样成立） */
  function hkReportDate(year, reportType) {
    var rt = reportType || '';
    var md = rt.indexOf('年度') >= 0 ? '12-31'
      : rt.indexOf('中期') >= 0 ? '06-30'
        : rt.indexOf('一季度') >= 0 ? '03-31'
          : rt.indexOf('三季度') >= 0 ? '09-30' : '12-31';
    return year ? (year + '-' + md) : null;
  }

  function parseHkRow(row, symbol) {
    if (!row) return null;
    if (String(row.IS_BFP) === '1') return null;              // 未派发或宣派股息
    var ex = dslash(row.EX_DIVIDEND_DATE);
    var pay = dslash(row.DIVIDEND_DATE);
    if (!ex && !pay) return null;
    var per = parseHkPerShare(row.PLAN_EXPLAIN);
    if (per === null || per <= 0) return null;

    var year = row.YEAR ? String(row.YEAR) : '';
    var rd = hkReportDate(year, row.REPORT_TYPE) || ex || pay;
    return {
      planId: symbol + '_' + rd + '_' + (ex || pay),
      symbol: symbol,
      securityCode: row.SECURITY_CODE || XJ.model.codeOf(symbol),
      securityName: row.SECURITY_NAME_ABBR || '',
      reportDate: rd,
      reportType: row.REPORT_TYPE || '港股分红',
      pretaxBonusPer10: per * 10,
      afterTaxPer10: null,
      implPlanProfile: row.PLAN_EXPLAIN || ('每股派港币' + per + '元'),
      planNoticeDate: d10(row.NOTICE_DATE),
      noticeDate: d10(row.NOTICE_DATE),
      equityRecordDate: null,
      exDividendDate: ex,
      payoutDate: pay,                       // ← 真实派息日
      transferEndDate: row.TRANSFER_END_DATE || null,
      assignProgress: '实施分配',
      progressRank: 100,
      isImplemented: true,
      dividendRatio: null,
      currency: 'HKD',
      source: 'hk',
      fetchedAt: U.nowStamp(),
    };
  }

  function fetchHkPlans(symbol) {
    var code = XJ.model.codeOf(symbol);
    var cbName = 'xjhk_' + (++cbSeq) + '_' + Date.now().toString(36);
    var url = HK_PLAN_URL +
      '?reportName=RPT_HKF10_MAIN_DIVBASIC&columns=ALL' +
      '&filter=' + encodeURIComponent('(SECURITY_CODE="' + code + '")') +
      '&pageNumber=1&pageSize=100&sortColumns=NOTICE_DATE&sortTypes=-1' +
      '&source=WEB&client=WEB&callback=' + cbName;

    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () { finish(null); }, PLAN_TIMEOUT);
      function cleanup() {
        clearTimeout(timer);
        try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
      }
      function finish(res) {
        if (settled) return;
        settled = true; cleanup(); resolve(res);
      }
      window[cbName] = function (res) { finish(res || null); };
      loadScript(url, null, PLAN_TIMEOUT, function (ok) {
        if (!ok) { lastError = new Error('港股分红接口请求失败'); finish(null); }
      });
    }).then(function (res) {
      if (!res || !res.result || !Array.isArray(res.result.data)) return [];
      var out = [], seen = {};
      res.result.data.forEach(function (row) {
        var p = parseHkRow(row, symbol);
        if (p && !seen[p.planId]) { seen[p.planId] = true; out.push(p); }
      });
      return out;
    });
  }

  function fetchAllHkPlans(symbols, onProgress) {
    var result = {}, i = 0;
    function step() {
      if (i >= symbols.length) return Promise.resolve(result);
      var sym = symbols[i++];
      return fetchHkPlans(sym).then(function (plans) {
        result[sym] = plans;
        if (onProgress) onProgress(i, symbols.length, sym);
        if (i >= symbols.length) return result;
        return new Promise(function (r) { setTimeout(r, PLAN_GAP); }).then(step);
      });
    }
    if (!symbols.length) return Promise.resolve(result);
    return step();
  }

  /**
   * 取公司官网域名（用于展示官方图标）。
   * 走东财 F10 的公司资料表，按市场路由（见 market.orgInfoQuery）：
   *   A股个股 → RPT_F10_BASIC_ORGINFO     港股 → RPT_HKF10_INFO_ORGPROFILE
   *   美股    → RPT_USF10_INFO_ORGPROFILE
   * ETF 与场外基金在该表中无数据 → 返回空，界面自动回退字母头像。
   * ORG_WEB 可能是「www.ccb.cn,www.ccb.com」这样的多域名串，取第一个。
   */
  function fetchCompanyDomains(symbols) {
    var list = (symbols || []).filter(function (s, i, a) {
      if (!s || a.indexOf(s) !== i) return false;
      return !!XJ.market.orgInfoQuery(s);
    });
    if (!list.length) return Promise.resolve({});
    var out = {};
    var i = 0;

    function one(sym) {
      var q = XJ.market.orgInfoQuery(sym);
      var cbName = 'xjdom_' + (++cbSeq) + '_' + Date.now().toString(36);
      var url = HK_PLAN_URL +
        '?reportName=' + q.reportName + '&columns=SECURITY_CODE,ORG_WEB' +
        '&filter=' + encodeURIComponent(q.filter) +
        '&pageSize=1&source=WEB&client=WEB&callback=' + cbName;
      return new Promise(function (resolve) {
        var settled = false;
        var timer = setTimeout(function () { finish(null); }, PLAN_TIMEOUT);
        function cleanup() {
          clearTimeout(timer);
          try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
        }
        function finish(res) {
          if (settled) return;
          settled = true; cleanup(); resolve(res);
        }
        window[cbName] = function (res) { finish(res || null); };
        loadScript(url, null, PLAN_TIMEOUT, function () { finish(null); });
      }).then(function (res) {
        var row = res && res.result && res.result.data && res.result.data[0];
        var web = row && row.ORG_WEB;
        if (web) {
          var first = String(web).split(',')[0].trim();
          if (first) out[sym] = first;
        }
      });
    }

    function step() {
      if (i >= list.length) return Promise.resolve(out);
      var sym = list[i++];
      return one(sym).catch(function () { /* 单只失败不影响其它 */ }).then(function () {
        if (i >= list.length) return out;
        return new Promise(function (r) { setTimeout(r, 80); }).then(step);
      });
    }
    return step();
  }

  /* ---------------- 当日分时 ----------------
   * 腾讯分时 https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=sh600036&_var=xxx
   * 返回结构： data.<code>.data.data = ["0930 41.75 4822 20131850.00", ...]（时间 价格 累计手数 累计金额）
   *            data.<code>.data.date = "20260911"
   * 场外基金无行情 → 不参与。
   */
  var MINUTE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=';

  /** 纯解析：把原始 JSON 对象转成 { date, points:[{t,p,v}] } */
  function parseMinute(payload, symbol) {
    var node = payload && payload.data && payload.data[symbol];
    var d = node && node.data;
    if (!d || !d.data || !d.data.length) return null;
    var points = [];
    d.data.forEach(function (line) {
      var f = String(line).split(/\s+/);
      if (f.length < 2) return;
      var t = f[0];
      if (!/^\d{4}$/.test(t)) return;
      points.push({ t: t.slice(0, 2) + ':' + t.slice(2), p: U.num(f[1]), v: U.num(f[2]) });
    });
    if (!points.length) return null;
    var raw = String(d.date || '');
    var date = /^\d{8}$/.test(raw) ? raw.slice(0, 4) + '-' + raw.slice(4, 6) + '-' + raw.slice(6) : '';
    return { symbol: symbol, date: date, points: points };
  }

  /** 逐只取当日分时（并发，单只失败不影响整体） */
  function fetchMinutes(symbols) {
    var list = (symbols || []).filter(function (s, i, a) {
      return s && a.indexOf(s) === i && XJ.market.hasMinute(s);
    });
    if (!list.length) return Promise.resolve({});
    var out = {};
    return Promise.all(list.map(function (sym) {
      /* 美股走东财分时：腾讯分时接口对美股只回 1 个点，画不出走势 */
      if (XJ.market.marketOf(sym) === 'us') {
        return fetchUsTrends(sym).then(function (m) { if (m) out[sym] = m; });
      }
      var varName = 'xjmin_' + (++cbSeq) + '_' + Date.now().toString(36);
      return new Promise(function (resolve) {
        loadScript(MINUTE_URL + sym + '&_var=' + varName, null, PLAN_TIMEOUT, function () {
          var m = parseMinute(window[varName], sym);
          if (m) out[sym] = m;
          try { delete window[varName]; } catch (e) { window[varName] = undefined; }
          resolve();
        });
      });
    })).then(function () { return out; });
  }

  /* ---------------- 美股分时（东财 trends2，支持 JSONP） ----------------
   * https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=105.AAPL&...
   * data.trends = ["2026-09-10 21:30,316.625", ...]（北京时间，每分钟一根）
   */
  var TRENDS_URL = 'https://push2his.eastmoney.com/api/qt/stock/trends2/get';

  /** 纯解析：trends 字符串数组 → { date, points:[{t,p}] } */
  function parseTrends(trends) {
    if (!trends || !trends.length) return null;
    var points = [];
    var date = '';
    trends.forEach(function (row) {
      var f = String(row).split(',');
      if (f.length < 2) return;
      var dt = f[0].trim();
      var p = U.num(f[1]);
      if (!dt || p === null) return;
      if (!date) date = dt.slice(0, 10);
      points.push({ t: dt.slice(11, 16), p: p, v: null });
    });
    if (points.length < 2) return null;
    return { date: date, points: points };
  }

  function fetchUsTrends(sym, quoteCode) {
    var rec = quoteCode;
    if (!rec) {
      try { rec = XJ.store && XJ.store.state && XJ.store.state.symbols[sym] && XJ.store.state.symbols[sym].quoteCode; } catch (e) { /* 忽略 */ }
    }
    /* 没有带后缀的行情代码时，依次试纳斯达克(105)/纽交所(106) */
    var candidates = [];
    var primary = XJ.market.usSecid(rec);
    if (primary) candidates.push(primary);
    else {
      var body = XJ.market.codeOf(sym).split('.')[0];
      candidates.push('105.' + body, '106.' + body);
    }

    function one(secid) {
      var cbName = 'xjtr_' + (++cbSeq) + '_' + Date.now().toString(36);
      var url = TRENDS_URL + '?secid=' + secid +
        '&fields1=f1,f2,f3,f4,f5&fields2=f51,f53&iscr=0&ndays=1&iscca=0&source=WEB&client=WEB&callback=' + cbName;
      return new Promise(function (resolve) {
        var settled = false;
        var timer = setTimeout(function () { finish(null); }, PLAN_TIMEOUT);
        function cleanup() {
          clearTimeout(timer);
          try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
        }
        function finish(res) {
          if (settled) return;
          settled = true; cleanup(); resolve(res);
        }
        window[cbName] = function (res) { finish(res || null); };
        loadScript(url, null, PLAN_TIMEOUT, function () { finish(null); });
      }).then(function (res) {
        var m = parseTrends(res && res.data && res.data.trends);
        if (m) m.symbol = sym;
        return m;
      }).catch(function () { return null; });
    }

    var chain = Promise.resolve(null);
    candidates.forEach(function (secid) {
      chain = chain.then(function (cur) { return cur || one(secid); });
    });
    return chain;
  }

  /* ---------------- 历史日线 / 净值 ----------------
   * 股票 / ETF / 港股 / 美股：腾讯日K
   *   https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600036,day,2026-01-01,2026-12-31,320,&_var=xxx
   *   行格式 [日期, 开, 收, 高, 低, 量]，取「收」。不加 fq 参数即不复权，
   *   历史市值必须用不复权的真实收盘价，否则除权前的价格会被前复权改写。
   * 场外基金：天天基金净值走势
   *   https://fund.eastmoney.com/pingzhongdata/<code>.js 的 Data_netWorthTrend=[{x:ms,y:nav}]
   */
  var KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=';
  var FUND_NAV_URL = 'https://fund.eastmoney.com/pingzhongdata/';

  /** 纯解析：腾讯日K payload → [['YYYY-MM-DD', close], ...]（升序） */
  function parseKline(payload, symbol) {
    var node = payload && payload.data && payload.data[symbol];
    if (!node) return [];
    var rows = node.day || node.qfqday || node.hfqday;
    if (!rows || !rows.length) return [];
    var out = [];
    rows.forEach(function (r) {
      if (!r || r.length < 3) return;
      var d = String(r[0]).slice(0, 10);
      var c = U.num(r[2]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || c === null || c <= 0) return;
      out.push([d, c]);
    });
    out.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
    return out;
  }

  /** 纯解析：天天基金 Data_netWorthTrend → [['YYYY-MM-DD', nav], ...]（升序，仅保留单位净值） */
  function parseFundNav(trend) {
    if (!trend || !trend.length) return [];
    var out = [];
    trend.forEach(function (row) {
      var ms = U.num(row && row.x), nav = U.num(row && row.y);
      if (ms === null || nav === null || nav <= 0) return;
      var d = new Date(ms);
      if (isNaN(d.getTime())) return;
      out.push([d.getFullYear() + '-' + U.pad2(d.getMonth() + 1) + '-' + U.pad2(d.getDate()), nav]);
    });
    out.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
    return out;
  }

  function fetchKline(sym, beg, end, codeOverride) {
    var varName = 'xjkl_' + (++cbSeq) + '_' + Date.now().toString(36);
    /* 美股必须带上交易所后缀（腾讯行情 f[2] 给的就是 AAPL.OQ / BABA.N），
       用裸代码只能拿到 1~2 根 K 线，画不出历史曲线。 */
    var code = codeOverride ? XJ.market.marketOf(sym) + codeOverride : sym;
    var url = KLINE_URL + code + ',day,' + (beg || '') + ',' + (end || '') + ',640,&_var=' + varName;
    return new Promise(function (resolve) {
      loadScript(url, null, PLAN_TIMEOUT, function () {
        var pts = parseKline(window[varName], code);
        try { delete window[varName]; } catch (e) { window[varName] = undefined; }
        resolve(pts);
      });
    });
  }

  function fetchFundNav(sym) {
    return new Promise(function (resolve) {
      var prev = window.Data_netWorthTrend;
      var had = Object.prototype.hasOwnProperty.call(window, 'Data_netWorthTrend');
      loadScript(FUND_NAV_URL + XJ.market.codeOf(sym) + '.js', 'utf-8', PLAN_TIMEOUT, function () {
        var trend = window.Data_netWorthTrend;
        var pts = parseFundNav(trend);
        /* 还原全局，避免污染其它基金的读取 */
        if (had) window.Data_netWorthTrend = prev;
        else { try { delete window.Data_netWorthTrend; } catch (e) { window.Data_netWorthTrend = undefined; } }
        resolve(pts);
      });
    });
  }

  /**
   * 取「尽可能长」的日线收盘价序列（给资产走势曲线用）。
   *
   * 与 fetchPriceHistory 的区别：那个单次只取 640 根（≈2.5 年）；
   * 这个按【两个窗口拼接】拿满约 10 年 —— 腾讯 fqkline 单次 `count` 上限 2000 根
   * （≈8.2 年，2050 起直接空返回），但 `beg`/`end` 是生效的，所以拆成
   * `[今天−8年, 今天]` 与 `[今天−11年, 今天−8年]` 两次请求再按日期合并。
   * 实测 2601 根 / 10.7 年、无重复无缝隙（这套写法先在 fetchYieldHistory 里验证过）。
   *
   * 场外基金走天天基金净值走势（本身就是全量），不受窗口限制。
   *
   * @return { symbol: [[date, close], ...] }（升序，已按 maxBars 截尾）
   */
  var LONG_SPAN_DAYS = [0, 2920, 4020];   // 今天 / 8 年前 / 11 年前
  var LONG_MAX_BARS = 2700;               // ≈10.7 年，再往上裁

  function fetchLongCloseSeries(symbols, opts) {
    opts = opts || {};
    var list = (symbols || []).filter(function (s, i, a) {
      return s && a.indexOf(s) === i && (XJ.market.hasDailyHistory(s) || XJ.market.assetType(s) === 'of');
    });
    if (!list.length) return Promise.resolve({});
    var codes = opts.codes || {};
    var today = opts.today || U.today();
    var maxBars = U.num(opts.maxBars) || LONG_MAX_BARS;
    var wins = [
      { beg: U.addDays(today, -LONG_SPAN_DAYS[1]), end: today, count: 2000 },
      { beg: U.addDays(today, -LONG_SPAN_DAYS[2]), end: U.addDays(today, -LONG_SPAN_DAYS[1]), count: 900 },
    ];
    var out = {};
    var i = 0;

    function trim(pts) {
      pts = XJ.model.normCloseSeries(pts);
      if (pts.length > maxBars) pts = pts.slice(-maxBars);
      return pts;
    }
    function step() {
      if (i >= list.length) return Promise.resolve(out);
      var sym = list[i++];
      if (XJ.market.assetType(sym) === 'of') {
        return fetchFundNav(sym).catch(function () { return []; }).then(function (pts) {
          pts = trim(pts);
          if (pts.length >= 2) out[sym] = pts;
        }).then(function () {
          if (i >= list.length) return out;
          return new Promise(function (r) { setTimeout(r, 120); }).then(step);
        });
      }
      /* 窗口逐个串行取，窗口之间也留间隔，避免被限流 */
      var rows = [], w = 0;
      function nextWindow() {
        if (w >= wins.length) return Promise.resolve();
        var win = wins[w++];
        return fetchKlineBars(sym, 'day', win.count, codes[sym], win.beg, win.end)
          .catch(function () { return []; })
          .then(function (bars) {
            (bars || []).forEach(function (b) { rows.push([b.d, b.c]); });
            return new Promise(function (r) { setTimeout(r, 120); }).then(nextWindow);
          });
      }
      return nextWindow().then(function () {
        var pts = trim(rows);
        if (pts.length >= 2) out[sym] = pts;
      }).then(function () {
        if (onHistoryTick) onHistoryTick(i, list.length, sym);
        if (i >= list.length) return out;
        return new Promise(function (r) { setTimeout(r, 150); }).then(step);
      });
    }
    return step();
  }

  var onHistoryTick = null;
  function setHistoryProgress(fn) { onHistoryTick = fn; }

  /* ---------------- 官方图标真伪校验 ----------------
   * icon.horse 对查不到的域名会返回灰底字母占位图（HTTP 200），
   * 不校验的话这张无意义的灰字母会盖住我们自己的中文头像。
   * 它带 `Access-Control-Allow-Origin: *`，所以可以 fetch + canvas 采样后判定。
   * 采样指标：maxSat（最大通道差，衡量有无彩色）、bgRatio（占比最高的量化色块比例）。
   */
  var LOGO_SAMPLE_SIZE = 32;

  function sampleImage(bitmap) {
    var c = document.createElement('canvas');
    c.width = LOGO_SAMPLE_SIZE; c.height = LOGO_SAMPLE_SIZE;
    var g = c.getContext('2d');
    if (!g) return null;
    g.drawImage(bitmap, 0, 0, LOGO_SAMPLE_SIZE, LOGO_SAMPLE_SIZE);
    var px = g.getImageData(0, 0, LOGO_SAMPLE_SIZE, LOGO_SAMPLE_SIZE).data;
    var maxSat = 0;
    var hist = {};
    var n = LOGO_SAMPLE_SIZE * LOGO_SAMPLE_SIZE;
    for (var i = 0; i < px.length; i += 4) {
      var r = px[i], gg = px[i + 1], b = px[i + 2];
      var s = Math.max(r, gg, b) - Math.min(r, gg, b);
      if (s > maxSat) maxSat = s;
      var k = ((r >> 4) << 8) | ((gg >> 4) << 4) | (b >> 4);
      hist[k] = (hist[k] || 0) + 1;
    }
    var top = 0;
    Object.keys(hist).forEach(function (k) { if (hist[k] > top) top = hist[k]; });
    return { maxSat: maxSat, bgRatio: top / n, colors: Object.keys(hist).length };
  }

  var LOGO_CHECK_TIMEOUT = 20000;

  /**
   * 校验一张图标：返回 'ok' | 'bad' | 'unknown'。
   * 'unknown'（超时/解码失败/不支持）一律按可显示处理 —— 宁可偶尔显示占位图，
   * 也不要把真图标误判成假的。
   * 超时给到 20s：icon.horse 首次为冷门域名抓图标实测要 12s 以上，
   * 给短了会把「慢的占位图」误判成 unknown，于是假图标又被显示出来。
   */
  function checkLogo(url) {
    if (!url || typeof fetch !== 'function' || typeof createImageBitmap !== 'function') {
      return Promise.resolve('unknown');
    }
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, LOGO_CHECK_TIMEOUT);
    return fetch(url, ctl ? { signal: ctl.signal } : undefined).then(function (r) {
      if (!r.ok) return 'unknown';
      return r.blob();
    }).then(function (blob) {
      if (!blob) return 'unknown';
      return createImageBitmap(blob).then(function (bmp) {
        try {
          var sample = sampleImage(bmp);
          if (bmp.close) bmp.close();
          if (!sample) return 'unknown';
          return XJ.market.logoVerdict(sample);
        } finally { /* 采样完成 */ }
      });
    }).catch(function () { return 'unknown'; }).then(function (v) {
      clearTimeout(timer);
      return v;
    });
  }

  /**
   * 批量校验官方图标。concurrency 限并发（icon.horse 首次取一个域名可能 10s 以上）。
   * resolve({ symbol: 'ok' | 'bad' | 'unknown' })
   */
  function verifyLogos(input, concurrency) {
    var pairs = Object.keys(input || {}).map(function (sym) { return { sym: sym, url: input[sym] }; })
      .filter(function (p) { return p.url; });
    if (!pairs.length) return Promise.resolve({});
    var out = {};
    var idx = 0;
    var limit = Math.max(1, concurrency || 3);
    function worker() {
      if (idx >= pairs.length) return Promise.resolve();
      var p = pairs[idx++];
      return checkLogo(p.url).then(function (v) { out[p.sym] = v; return worker(); });
    }
    var workers = [];
    for (var i = 0; i < Math.min(limit, pairs.length); i++) workers.push(worker());
    return Promise.all(workers).then(function () { return out; });
  }

  /* ---------------- 公司标识解析（多源） ----------------
   * 目标：每只持仓都要有图标；能拿到官方标识就优先用官方标识。
   * 依次尝试：
   *   ① market.logoCandidates —— icon.horse（完整域名 / 一级域名）、公司官网 favicon.ico、xinac 代理
   *   ② 同花顺 F10 公司资料页 —— A股个股内嵌真实公司 logo，且该页带 CORS 头可跨域读取
   * 每一个候选都用 checkLogo（canvas 采样）验真，占位图直接跳过。
   */

  /** 取同花顺 F10 页面并从中提取公司 logo（CORS 放行，可直接 fetch） */
  function fetchThsLogo(symbol) {
    var page = XJ.market.thsF10Url(symbol);
    if (!page || typeof fetch !== 'function') return Promise.resolve(null);
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, PLAN_TIMEOUT);
    return fetch(page, ctl ? { signal: ctl.signal } : undefined).then(function (r) {
      if (!r.ok) return null;
      return r.text();
    }).then(function (html) {
      return XJ.market.parseThsLogo(html);
    }).catch(function () { return null; }).then(function (u) {
      clearTimeout(timer);
      return u;
    });
  }

  /**
   * 公司标识解析算法版本。
   * 每次调整判定规则都要 +1：缓存里低于当前版本的结论会被视为过期并重新解析，
   * 否则用户当天看到的旧结论（尤其是 'bad'）会一直保留到第二天。
   */
  var LOGO_ALGO = 2;

  /**
   * 解析单只标的的公司标识，返回 { symbol, url, source } 或 null（→ 用文字头像）。
   *
   * 顺序（A股个股优先同花顺）：
   *   ① 同花顺 F10 公司资料页的 logo —— **逐家资产，直接采用，不做色彩判定**。
   *      实测沪深北 14/14 各不相同、无通用占位图；且不少公司的标识本身就是黑白的
   *      （雅戈尔 = 黑色「雅戈尔 YOUNGOR」字标），做色彩判定会把真标识误杀 —— 曾经的缺陷。
   *   ② icon.horse / xinac —— 这两个源查不到时会回**通用占位图**（灰底字母、黑地球），
   *      因此必须用 checkLogo 的 canvas 采样判定（整张图无彩色即视为占位图）。
   */
  function resolveLogo(symbol, domain) {
    var domainStep = function () {
      var cands = XJ.market.logoCandidates(symbol, domain);
      var idx = 0;
      function next() {
        if (idx >= cands.length) return Promise.resolve(null);
        var url = cands[idx++];
        return checkLogo(url).then(function (v) {
          if (v === 'ok') return { symbol: symbol, url: url, source: 'domain', algo: LOGO_ALGO };
          return next();
        });
      }
      return next();
    };
    var thsStep = function () {
      if (!XJ.market.thsF10Url(symbol)) return Promise.resolve(null);
      return fetchThsLogo(symbol).then(function (u) {
        return u ? { symbol: symbol, url: u, source: 'ths', algo: LOGO_ALGO } : null;
      });
    };

    /* A股个股：同花顺在前（更可靠）；其它市场：同花顺没有对应页面，直接走域名通道 */
    var steps = XJ.market.thsF10Url(symbol) ? [thsStep, domainStep] : [domainStep];
    var i = 0;
    function run() {
      if (i >= steps.length) return Promise.resolve(null);
      var step = steps[i++];
      return step().catch(function () { return null; }).then(function (hit) {
        return hit || run();
      });
    }
    return run().catch(function () { return null; });
  }

  /** 批量解析（并发 2：同花顺单页 300KB，且 icon.horse 冷门域名很慢） */
  function resolveLogos(items, concurrency) {
    var list = (items || []).filter(function (x) { return x && x.symbol; });
    if (!list.length) return Promise.resolve({});
    var out = {};
    var idx = 0;
    var limit = Math.max(1, concurrency || 2);
    function worker() {
      if (idx >= list.length) return Promise.resolve();
      var it = list[idx++];
      return resolveLogo(it.symbol, it.domain).then(function (r) {
        if (r) out[r.symbol] = r;
        return worker();
      });
    }
    var workers = [];
    for (var i = 0; i < Math.min(limit, list.length); i++) workers.push(worker());
    return Promise.all(workers).then(function () { return out; });
  }

  /**
   * 批量取历史价格。返回 { symbol: [['YYYY-MM-DD', price], ...] }
   * 串行 + 间隔，避免被限流；单只失败不影响其它。
   */
  function fetchPriceHistory(symbols, opts) {
    opts = opts || {};
    var list = (symbols || []).filter(function (s, i, a) {
      return s && a.indexOf(s) === i && (XJ.market.hasDailyHistory(s) || XJ.market.assetType(s) === 'of');
    });
    if (!list.length) return Promise.resolve({});
    var beg = opts.beg || '', end = opts.end || '';
    var codes = opts.codes || {};
    var out = {};
    var i = 0;
    function step() {
      if (i >= list.length) return Promise.resolve(out);
      var sym = list[i++];
      var job = XJ.market.assetType(sym) === 'of'
        ? fetchFundNav(sym)
        : fetchKline(sym, beg, end, codes[sym]);
      return job.catch(function () { return []; }).then(function (pts) {
        /* 美股兜底：没有行情代码（首次同步、还没拿到 f[2]）时裸代码只能取到 1~2 根，
           这里依次试纳斯达克/纽交所后缀，取到像样的日线为止。 */
        if (XJ.market.marketOf(sym) === 'us' && (!pts || pts.length < 5) && !codes[sym]) {
          var chain = Promise.resolve(pts);
          ['OQ', 'N'].forEach(function (sfx) {
            chain = chain.then(function (cur) {
              if (cur && cur.length >= 5) return cur;
              return fetchKline(sym, beg, end, XJ.market.codeOf(sym).split('.')[0] + '.' + sfx);
            });
          });
          return chain;
        }
        return pts;
      }).then(function (pts) {
        if (pts && pts.length) out[sym] = pts;
        if (onHistoryTick) onHistoryTick(i, list.length, sym);
        if (i >= list.length) return out;
        return new Promise(function (r) { setTimeout(r, 120); }).then(step);
      });
    }
    return step();
  }

  /* ---------------- 对比指数：日线（含 OHLC）+ 当日分时 ----------------
   * 日线走腾讯 `web.ifzq.gtimg.cn/appstock/app/kline/kline`（`<script>` 注入）：
   *   param=<代码>,day,,,<根数>，行格式 [日期, 开, 收, 高, 低, 量] —— 取 O/H/L/C 供 K线（蜡烛）模式用。
   *   注意：A股/港股指数用 sh000001 / hkHSI；**美股指数要用 us.IXIC / us.INX 这种带点的代码**。
   *   东财 push2his/push2 系列在 file:// 页面被 WAF 拒（ERR_EMPTY_RESPONSE），故不采用。
   * 分时走腾讯 minute 接口，只有 A股/港股指数有。
   */
  var IDX_KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=';

  /** 纯解析：腾讯指数日线 → [{d,o,h,l,c}]（升序） */
  function parseIndexKline(payload, code) {
    var node = null;
    if (payload && payload.data) {
      node = code ? payload.data[code] : payload.data[Object.keys(payload.data)[0]];
    }
    var rows = node && (node.day || node.qfqday);
    if (!rows || !rows.length) return [];
    var out = [];
    rows.forEach(function (r) {
      if (!r || r.length < 5) return;
      var d = String(r[0]).slice(0, 10);
      var o = U.num(r[1]), c = U.num(r[2]), h = U.num(r[3]), l = U.num(r[4]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
      if (o === null || c === null || h === null || l === null) return;
      out.push({ d: d, o: o, h: h, l: l, c: c });
    });
    out.sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
    return out;
  }

  function fetchIndexKline(key, count) {
    var def = XJ.market.indexDef(key);
    if (!def || !def.kline) return Promise.resolve([]);
    var varName = 'xjidk_' + (++cbSeq) + '_' + Date.now().toString(36);
    var url = IDX_KLINE_URL + def.kline + ',day,,,' + (count || 400) + '&_var=' + varName;
    return new Promise(function (resolve) {
      loadScript(url, null, PLAN_TIMEOUT, function () {
        var bars = parseIndexKline(window[varName], def.kline);
        try { delete window[varName]; } catch (e) { window[varName] = undefined; }
        resolve(bars);
      });
    }).catch(function () { return []; });
  }

  /**
   * 批量拉指数日线。返回 { key: { at, bars } }；串行 + 间隔避免被限流。
   * 没有历史源的指数（日经/台湾/韩国）直接跳过。
   */
  function fetchIndexHistory(keys, opts) {
    opts = opts || {};
    var list = (keys || []).filter(function (k, i, a) {
      return k && a.indexOf(k) === i && XJ.market.indexHasHistory(k);
    });
    if (!list.length) return Promise.resolve({});
    var today = opts.today || U.today();
    var out = {};
    var i = 0;
    function step() {
      if (i >= list.length) return Promise.resolve(out);
      var key = list[i++];
      return fetchIndexKline(key, opts.count || 400).then(function (bars) {
        if (bars && bars.length > 1) out[key] = { at: today, bars: bars };
        if (onHistoryTick) onHistoryTick(i, list.length, key);
        if (i >= list.length) return out;
        return new Promise(function (r) { setTimeout(r, 120); }).then(step);
      });
    }
    return step();
  }

  /* ---------------- 技术信号用：带 OHLC 的日K / 周K ----------------
   * 与上面 fetchKline（只要收盘价、画净值曲线）分开：技术信号要算 BOLL / KDJ，
   * 必须有【最高价、最低价】，所以单开一条通道，互不影响原有缓存结构。
   *
   * 复用腾讯 fqkline（与 fetchKline 同一个端点），但：
   *   - 周期可传 day / week / month（接口原生支持，不必自己聚合）
   *   - 解析出完整 OHLC
   * ⚠️ 字段序是 [日期, 开, 收, 高, 低, 量] —— 第 3 列是【收】不是【高】。
   *    这与常见的 OHLC 顺序不同，写错不会报错、只会让指标静默算歪。
   */

  /** 纯解析：腾讯 fqkline payload → [{d,o,h,l,c}]（升序） */
  function parseKlineBars(payload, symbol) {
    var node = payload && payload.data && payload.data[symbol];
    if (!node) return [];
    var rows = node.day || node.qfqday || node.hfqday ||
               node.week || node.qfqweek || node.month || node.qfqmonth;
    if (!rows || !rows.length) return [];
    var out = [];
    rows.forEach(function (r) {
      if (!r || r.length < 5) return;
      var d = String(r[0]).slice(0, 10);
      var o = U.num(r[1]), c = U.num(r[2]), h = U.num(r[3]), l = U.num(r[4]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
      if (o === null || c === null || h === null || l === null) return;
      if (o <= 0 || c <= 0 || h <= 0 || l <= 0) return;
      out.push({ d: d, o: o, h: h, l: l, c: c });
    });
    out.sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
    return out;
  }

  /**
   * 取单只标的指定周期的 OHLC K 线。
   * @param sym  内部代码，如 sh600036
   * @param period 'day' | 'week' | 'month'
   * @param count 根数上限（默认 60，够 KDJ 的 K/D 从初值 50 收敛）
   * @param codeOverride 美股必须带交易所后缀（复用 fetchPriceHistory 的口径）
   * @param beg/end 可选起止日期（'YYYY-MM-DD'）。**这两个参数是真的生效的**
   *        —— 实测 `code,day,2015-06-01,2015-12-31,640,` 精确返回该区间的 146 根。
   *        缺省时留空（`code,day,,,60,`），与旧调用完全等价。
   */
  function fetchKlineBars(sym, period, count, codeOverride, beg, end) {
    var varName = 'xjkb_' + (++cbSeq) + '_' + Date.now().toString(36);
    var code = codeOverride ? XJ.market.marketOf(sym) + codeOverride : sym;
    var p = period === 'week' ? 'week' : (period === 'month' ? 'month' : 'day');
    var url = KLINE_URL + code + ',' + p + ',' + (beg || '') + ',' + (end || '') + ',' +
      (count || 60) + ',&_var=' + varName;
    return new Promise(function (resolve) {
      loadScript(url, null, PLAN_TIMEOUT, function () {
        var bars = parseKlineBars(window[varName], code);
        try { delete window[varName]; } catch (e) { window[varName] = undefined; }
        resolve(bars);
      });
    }).catch(function () { return []; });
  }

  /**
   * 批量取「日K + 周K」两套 OHLC。返回 { symbol: { day: [...], week: [...] } }
   * 串行 + 间隔，避免被限流；单只失败不影响其它。
   * 场外基金（of）没有盘中 K 线，直接跳过。
   */
  function fetchKlineBundle(symbols, opts) {
    opts = opts || {};
    var list = (symbols || []).filter(function (s, i, a) {
      return s && a.indexOf(s) === i && XJ.market.assetType(s) !== 'of';
    });
    if (!list.length) return Promise.resolve({});
    var count = opts.count || 60;
    var codes = opts.codes || {};
    var out = {};
    var i = 0;
    function step() {
      if (i >= list.length) return Promise.resolve(out);
      var sym = list[i++];
      return fetchKlineBars(sym, 'day', count, codes[sym]).then(function (day) {
        /* 日K 拿不到就没有任何指标可算，不必再请求周K */
        if (!day || !day.length) return null;
        return fetchKlineBars(sym, 'week', count, codes[sym]).then(function (week) {
          out[sym] = { day: day, week: week || [] };
          return null;
        });
      }).then(function () {
        if (onHistoryTick) onHistoryTick(i, list.length, sym);
        if (i >= list.length) return out;
        return new Promise(function (r) { setTimeout(r, 150); }).then(step);
      });
    }
    return step();
  }

  /**
   * 股息率曲线用的收盘价：**最近十年的日线**（只取收盘价，股息率 = 每股派现 ÷ 收盘价，用不到 OHLC）。
   *
   * ★ 为什么是「分两个窗口」：
   *   腾讯 fqkline 单次 `count` 的**硬上限是 2000 根**（实测 2000 正常、2050 起直接空返回），
   *   而 2000 根日线只有约 8.2 年，撑不满「最近十年」。
   *   好在它的 `beg`/`end` 参数**是生效的**（实测 `code,day,2015-06-01,2015-12-31,640,`
   *   精确返回该区间的 146 根 —— 早先误以为被忽略，是因为拿 11 年的宽区间去测，被 count 截断成了最近 640 根）。
   *   于是拆成「近 8 年」+「再往前 3 年」两次请求再拼接：实测合计 2601 根、跨 3907 天、无重复无缝隙。
   *   两个窗口的边界日可能同时出现在两边，交给 normCloseSeries 按日期去重。
   *
   * 与 klineCache 分开存：那套是完整 OHLC、只留 120 根、给 BOLL/KDJ 用；
   * 把两套量级混在一起会让技术信号白白背上一堆数据。
   */
  var YIELD_SPAN_DAYS = [0, 2920, 4020];   // 今天 / 8 年前 / 11 年前，切成两段
  var YIELD_MAX_BARS = 2700;               // ≈10.7 年日线，再往上裁
  function fetchYieldHistory(symbols, opts) {
    opts = opts || {};
    var list = (symbols || []).filter(function (s, i, a) {
      return s && a.indexOf(s) === i && XJ.market.assetType(s) !== 'of';
    });
    if (!list.length) return Promise.resolve({});
    var codes = opts.codes || {};
    var today = opts.today || U.today();
    var wins = [
      { beg: U.addDays(today, -YIELD_SPAN_DAYS[1]), end: today, count: 2000 },
      { beg: U.addDays(today, -YIELD_SPAN_DAYS[2]), end: U.addDays(today, -YIELD_SPAN_DAYS[1]), count: 900 },
    ];
    var out = {};
    var i = 0;
    function step() {
      if (i >= list.length) return Promise.resolve(out);
      var sym = list[i++];
      var rows = [];
      var w = 0;
      /* 窗口逐个串行取，窗口之间也留间隔，避免被限流 */
      function nextWindow() {
        if (w >= wins.length) return Promise.resolve();
        var win = wins[w++];
        return fetchKlineBars(sym, 'day', win.count, codes[sym], win.beg, win.end).then(function (bars) {
          (bars || []).forEach(function (b) { rows.push([b.d, b.c]); });
          return new Promise(function (r) { setTimeout(r, 120); }).then(nextWindow);
        });
      }
      return nextWindow().then(function () {
        var pts = XJ.model.normCloseSeries(rows);
        if (pts.length > YIELD_MAX_BARS) pts = pts.slice(-YIELD_MAX_BARS);
        if (pts.length >= 2) out[sym] = { day: pts };
        return null;
      }).then(function () {
        if (onHistoryTick) onHistoryTick(i, list.length, sym);
        if (i >= list.length) return out;
        return new Promise(function (r) { setTimeout(r, 150); }).then(step);
      });
    }
    return step();
  }

  /* ---- 余额宝七日年化（对比基准） ----
   * 天天基金 pingzhongdata 里的 Data_sevenDaysYearIncome = [[毫秒时间戳, 七日年化%], ...]，
   * 与场外基金净值走同一条 <script> 注入通道（该域没有 CORS 头，只能靠注入执行 JS 变量）。
   */
  var BENCH_FUND_CODE = '000198';                 // 天弘余额宝
  var BENCH_KEEP_YEARS = 10;

  /**
   * 纯解析：[[毫秒, pct], ...] → [['YYYY-MM-DD', pct], ...]（升序、按周降采样、裁到最近 10 年）
   *
   * 为什么按周：原始是日频（约 4856 点 / 13 年），但七日年化是极平滑的曲线，
   * 日频画在 360px 宽的图上纯属浪费存储与渲染；按周取每周最后一个点即可。
   */
  function parseSevenDay(arr, opts) {
    opts = opts || {};
    if (!arr || !arr.length) return [];
    var byWeek = {};
    for (var i = 0; i < arr.length; i++) {
      var row = arr[i];
      if (!row || row.length < 2) continue;
      var ms = U.num(row[0]), v = U.num(row[1]);
      if (ms === null || v === null || !isFinite(v) || v <= 0) continue;
      var d = new Date(ms);
      if (isNaN(d.getTime())) continue;
      var ymd = d.getFullYear() + '-' + U.pad2(d.getMonth() + 1) + '-' + U.pad2(d.getDate());
      var wk = weekKey(d);
      /* 同周内后出现的点覆盖前面的 → 最终留下每周最后一个点 */
      if (!byWeek[wk] || ymd > byWeek[wk][0]) byWeek[wk] = [ymd, v];
    }
    var out = Object.keys(byWeek).sort().map(function (k) { return byWeek[k]; });
    out.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
    var years = U.num(opts.years);
    if (years && years > 0) {
      var today = opts.today || U.today();
      var cutoff = U.addDays(today, -Math.round(years * 365.25));
      out = out.filter(function (r) { return r[0] >= cutoff; });
    }
    return out;
  }

  /** 'YYYY-MM-DD' 的 ISO 周键（周一为起点），用于按周降采样 */
  function weekKey(d) {
    var t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var dow = (t.getDay() + 6) % 7;               // 周一=0 … 周日=6
    t.setDate(t.getDate() - dow);
    return t.getFullYear() + '-' + U.pad2(t.getMonth() + 1) + '-' + U.pad2(t.getDate());
  }

  function fetchBenchSevenDay() {
    return new Promise(function (resolve) {
      var prev = window.Data_sevenDaysYearIncome;
      var had = Object.prototype.hasOwnProperty.call(window, 'Data_sevenDaysYearIncome');
      loadScript(FUND_NAV_URL + BENCH_FUND_CODE + '.js', 'utf-8', PLAN_TIMEOUT, function () {
        var raw = window.Data_sevenDaysYearIncome;
        var pts = parseSevenDay(raw, { years: BENCH_KEEP_YEARS, today: U.today() });
        /* 还原全局，避免污染其它 pingzhongdata 读取 */
        if (had) window.Data_sevenDaysYearIncome = prev;
        else { try { delete window.Data_sevenDaysYearIncome; } catch (e) { window.Data_sevenDaysYearIncome = undefined; } }
        resolve(pts);
      });
    }).catch(function () { return []; });
  }

  function fetchIndexMinutes(keys) {
    var list = (keys || []).filter(function (k) {
      var d = XJ.market.indexDef(k);
      return d && d.minute;
    });
    if (!list.length) return Promise.resolve({});
    var out = {};
    return Promise.all(list.map(function (key) {
      var def = XJ.market.indexDef(key);
      var varName = 'xjidm_' + (++cbSeq) + '_' + Date.now().toString(36);
      return new Promise(function (resolve) {
        loadScript(MINUTE_URL + def.minute + '&_var=' + varName, null, PLAN_TIMEOUT, function () {
          var m = parseMinute(window[varName], def.minute);
          if (m) out[key] = m;
          try { delete window[varName]; } catch (e) { window[varName] = undefined; }
          resolve();
        });
      });
    })).then(function () { return out; });
  }

  /**
   * A股 → 东财股票分红；港股 → 东财港股 F10；ETF/场外基金 → 天天基金；
   * 美股 → 无公开免费源，归入 unsupported（界面提供手工补录）
   * 返回 { plans: {symbol: DividendPlan[]}, unsupported: symbol[], groups }
   */
  function fetchDividends(symbols, onProgress) {
    symbols = (symbols || []).filter(function (s, i, a) { return s && a.indexOf(s) === i; });
    var groups = { cn: [], hk: [], fund: [], none: [] };
    symbols.forEach(function (s) {
      var src = XJ.market.dividendSource(s) || 'none';
      (groups[src] || groups.none).push(s);
    });

    var out = {};
    var chain = Promise.resolve();

    if (groups.cn.length) {
      chain = chain.then(function () {
        return fetchAllPlans(groups.cn, function (i, t, sym) {
          if (onProgress) onProgress('cn', i, t, sym, 'A股分红方案');
        });
      }).then(function (m) { Object.keys(m).forEach(function (k) { out[k] = m[k]; }); });
    }

    if (groups.hk.length) {
      chain = chain.then(function () {
        return fetchAllHkPlans(groups.hk, function (i, t, sym) {
          if (onProgress) onProgress('hk', i, t, sym, '港股分红方案');
        });
      }).then(function (m) { Object.keys(m).forEach(function (k) { out[k] = m[k]; }); });
    }

    if (groups.fund.length) {
      chain = chain.then(function () {
        var codes = groups.fund.map(function (s) { return XJ.model.codeOf(s); });
        var y = new Date().getFullYear();
        return fetchFundDividends(codes, [y, y - 1, y - 2], function (page, pages, year) {
          if (onProgress) onProgress('fund', page, pages, null, '基金分红 ' + year + ' 年');
        });
      }).then(function (byCode) {
        groups.fund.forEach(function (sym) {
          var rows = byCode[XJ.model.codeOf(sym)] || [];
          out[sym] = rows.map(function (r) { return fundRowToPlan(r, sym); });
        });
      });
    }

    return chain.then(function () {
      return { plans: out, unsupported: groups.none.slice(), groups: groups };
    });
  }

  /* ---------------- 新闻快讯（10-08 重做版） ----------------
   * 主源：东财资讯检索 search-api-web（10-08 实测 HTTP 200 + CORS 全开 + JSONP 兜底；
   *   此前 WAF 拦截的是 np-listapi 资讯列表接口，搜索接口是另一条通道）。
   *   按 calc.NEWS_RULES.searchTerms 主体词逐个检索（sort=time 最新 N 条），
   *   自带 date/title/content/mediaName/url —— 天然满足「时间可核验 + 有来源 + 有原文」。
   *   注意东财相关性很松（正文命中也返回，实测搜「伯克希尔」返回红利策略文章），
   *   精度由 calc.newsFilter 的标题二次命中把关。
   * Fallback：新浪 7x24（zhibo_id=152）。响应被 try{cb(...)}catch(e){} 包裹 ——
   *   <script> 注入照样执行；数据在 result.data.feed.list[]，字段 rich_text /
   *   create_time('YYYY-MM-DD HH:MM:SS' 北京时间)。总库存仅约 900 条，
   *   只在东财整轮失败时兜底近况。
   * 两源统一成 { id, title, digest, url, source, tags, ctime }（ctime = Unix 秒）；
   * 去重与过滤交给 calc.newsMerge / calc.newsFilter（纯函数，verify 可独立复算）。 */
  var NEWS_SEARCH_URL = 'https://search-api-web.eastmoney.com/search/jsonp';
  var NEWS_SEARCH_PER_SIZE = 8;   /* 每词最新 N 条（sort=time） */
  var NEWS_SINA_URL = 'https://zhibo.sina.com.cn/api/zhibo/feed';
  var NEWS_SINA_PAGESIZE = 50;

  /** '2026-10-08 14:52:44'（北京时间）→ Unix 秒。
   *  手写字符串解析 + 固定 -8 小时偏移，不走 new Date('...')——
   *  那会按设备时区解析，海外设备会把新浪的时间算歪。 */
  function beijingStamp(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || ''));
    if (!m) return null;
    var ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6]);
    return isNaN(ms) ? null : Math.floor(ms / 1000);
  }

  /** 剥 HTML 标记与东财高亮 <em>、反转义、折叠空白（title/content 都带 <em>） */
  function stripEmTags(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** 解包 JSONP 文本 `cb({...})` → 对象（非 JSONP 的纯 JSON 也兼容） */
  function parseJsonpText(text) {
    var t = String(text || '').trim();
    var m = t.match(/^[\w$]+\(([\s\S]*)\)\s*;?\s*$/);
    if (m) t = m[1];
    try { return JSON.parse(t); } catch (e) { return null; }
  }

  /** 纯解析：东财检索 payload → 统一新闻条目数组（digest 截 500 字防缓存膨胀） */
  function parseNewsEm(payload) {
    var arr = payload && payload.result && payload.result.cmsArticleWebOld;
    if (!Array.isArray(arr)) return [];
    var out = [];
    arr.forEach(function (a) {
      if (!a || !a.title) return;
      var ctime = beijingStamp(a.date);
      if (ctime === null) return;
      out.push({
        id: 'em' + String(a.code || a.url || a.date),
        title: stripEmTags(a.title).slice(0, 120),
        digest: stripEmTags(a.content).slice(0, 500),
        url: String(a.url || ''),
        source: String(a.mediaName || '东财'),
        tags: [],
        ctime: ctime,
      });
    });
    return out;
  }

  /** 纯解析：新浪 zhibo payload → 统一新闻条目数组（rich_text 即标题，无独立摘要） */
  function parseNewsSina(payload) {
    var node = payload && payload.result && payload.result.data && payload.result.data.feed;
    var list = node && Array.isArray(node.list) ? node.list : [];
    var out = [];
    list.forEach(function (row) {
      if (!row || row.id === undefined) return;
      var text = String(row.rich_text || '').trim();
      var ctime = beijingStamp(row.create_time);
      if (!text || ctime === null) return;
      out.push({
        id: 'sina' + row.id,
        title: text,
        digest: '',
        url: String(row.docurl || ''),
        source: '新浪7x24',
        tags: (Array.isArray(row.tag) ? row.tag : []).map(function (t) {
          return t && t.name ? String(t.name) : '';
        }).filter(function (s) { return s; }),
        ctime: ctime,
      });
    });
    return out;
  }

  /** 通用 JSONP 单发（新闻接口共用）：callback 触发或脚本失败都 resolve，不 reject */
  function fetchNewsJsonp(url, cbName) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () { finish(null); }, PLAN_TIMEOUT);
      function cleanup() {
        clearTimeout(timer);
        try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
      }
      function finish(res) {
        if (settled) return;
        settled = true; cleanup(); resolve(res);
      }
      window[cbName] = function (res) { finish(res || null); };
      loadScript(url, null, PLAN_TIMEOUT, function (ok) {
        if (!ok) { lastError = new Error('新闻接口请求失败'); finish(null); }
        /* onload 但回调没触发的情况由 timeout 兜底 */
      });
    }).catch(function () { return null; });
  }

  /** 东财按词检索：fetch 主路（CORS 全开）→ 9s 未回转 JSONP 注入兜底；
   *  两路都失败返回 []，绝不 reject（下游串行循环不希望被单词打断） */
  function fetchNewsSearch(kw, size) {
    size = size || NEWS_SEARCH_PER_SIZE;
    var param = encodeURIComponent(JSON.stringify({
      uid: '', keyword: String(kw || ''), type: ['cmsArticleWebOld'],
      client: 'web', clientType: 'web', clientVersion: 'curr',
      param: { cmsArticleWebOld: { searchScope: 'default', sort: 'time', pageIndex: 1, pageSize: size, preTag: '<em>', postTag: '</em>' } },
    }));
    return new Promise(function (resolve) {
      var phase = 'fetch';                       // fetch → jsonp → done
      function done(list) {
        if (phase === 'done') return;
        phase = 'done';
        resolve(Array.isArray(list) ? list : []);
      }
      function jsonp() {
        if (phase !== 'fetch') return;
        phase = 'jsonp';
        var cbName = 'xjnew_' + (++cbSeq) + '_' + Date.now().toString(36);
        window[cbName] = function (res) { done(parseNewsEm(res)); };
        loadScript(NEWS_SEARCH_URL + '?cb=' + cbName + '&param=' + param, null, 9000, function (ok) {
          try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
          if (!ok) { done([]); return; }
          /* onload 但回调没触发（被 try{}catch 包裹/返回非 JSON）→ 宽限后放弃 */
          setTimeout(function () { if (phase === 'jsonp') done([]); }, 500);
        });
      }
      setTimeout(jsonp, 9000);                   // fetch 主路超时闸
      try {
        fetch(NEWS_SEARCH_URL + '?cb=cb&param=' + param).then(function (r) {
          return r.text();
        }).then(function (t) {
          if (phase !== 'fetch') return;
          done(parseNewsEm(parseJsonpText(t)));
        }).catch(jsonp);
      } catch (e) { jsonp(); }
    });
  }

  /** 按词表逐个检索（串行 + 120ms 间隔防限流，参考页实测安全值）。
   *  onEach(items, kw)：每词完成即回调 —— 视图用它做渐进渲染。
   *  resolve(全部原始条目)；单词失败只跳过该词，不打断整轮。 */
  function fetchNewsSearchMulti(keywords, perSize, onEach) {
    var list = (keywords || []).filter(Boolean);
    var out = [];
    var i = 0;
    return new Promise(function (resolve) {
      function step() {
        if (i >= list.length) return resolve(out);
        var kw = list[i++];
        fetchNewsSearch(kw, perSize).then(function (items) {
          items = items || [];
          out = out.concat(items);
          if (onEach) { try { onEach(items, kw); } catch (e) { /* 渲染层异常不拦取数 */ } }
          setTimeout(step, 120);
        }).catch(function () { setTimeout(step, 120); });
      }
      step();
    });
  }

  /** 新浪 7x24 第 N 页（1 起）→ 统一条目数组（失败返回 []） */
  function fetchNewsSinaPage(page) {
    var cbName = 'xjnws_' + (++cbSeq) + '_' + Date.now().toString(36);
    var url = NEWS_SINA_URL +
      '?page=' + (page > 0 ? page : 1) + '&page_size=' + NEWS_SINA_PAGESIZE +
      '&zhibo_id=152&tag_id=0&dire=f&dpc=1&callback=' + cbName;
    return fetchNewsJsonp(url, cbName).then(function (res) {
      return res ? parseNewsSina(res) : [];
    });
  }

  return {
    fetchQuotes: fetchQuotes,
    fetchFX: fetchFX,
    fetchSymbolSearch: fetchSymbolSearch,
    fetchNames: fetchNames,
    parseHint: parseHint,
    fetchPlans: fetchPlans,
    fetchAllPlans: fetchAllPlans,
    fetchHkPlans: fetchHkPlans,
    fetchAllHkPlans: fetchAllHkPlans,
    fetchCompanyDomains: fetchCompanyDomains,
    fetchMinutes: fetchMinutes,
    parseMinute: parseMinute,
    parseTrends: parseTrends,
    fetchPriceHistory: fetchPriceHistory,
    parseKline: parseKline,
    parseKlineBars: parseKlineBars,
    fetchKlineBars: fetchKlineBars,
    fetchKlineBundle: fetchKlineBundle,
    fetchYieldHistory: fetchYieldHistory,
    fetchLongCloseSeries: fetchLongCloseSeries,
    LONG_MAX_BARS: LONG_MAX_BARS,
    parseSevenDay: parseSevenDay,
    fetchBenchSevenDay: fetchBenchSevenDay,
    parseFundNav: parseFundNav,
    setHistoryProgress: setHistoryProgress,
    fetchIndexHistory: fetchIndexHistory,
    fetchIndexMinutes: fetchIndexMinutes,
    parseIndexKline: parseIndexKline,
    checkLogo: checkLogo,
    verifyLogos: verifyLogos,
    resolveLogo: resolveLogo,
    resolveLogos: resolveLogos,
    LOGO_ALGO: LOGO_ALGO,
    fetchThsLogo: fetchThsLogo,
    parseHkRow: parseHkRow,
    parseHkPerShare: parseHkPerShare,
    hkReportDate: hkReportDate,
    fetchDividends: fetchDividends,
    fetchNewsSearch: fetchNewsSearch,
    fetchNewsSearchMulti: fetchNewsSearchMulti,
    fetchNewsSinaPage: fetchNewsSinaPage,
    parseNewsEm: parseNewsEm,
    parseNewsSina: parseNewsSina,
    stripEmTags: stripEmTags,
    parseJsonpText: parseJsonpText,
    beijingStamp: beijingStamp,
    NEWS_SEARCH_PER_SIZE: NEWS_SEARCH_PER_SIZE,
    NEWS_SINA_PAGESIZE: NEWS_SINA_PAGESIZE,
    fetchFundDivPage: fetchFundDivPage,
    fetchFundDivYear: fetchFundDivYear,
    fetchFundDividends: fetchFundDividends,
    parseFundDivRow: parseFundDivRow,
    fundRowToPlan: fundRowToPlan,
    parseQuote: parseQuote,
    cleanName: cleanName,
    parsePlanRow: parsePlanRow,
    mergeByReportDate: mergeByReportDate,
    getLastError: function () { return lastError; },
  };
})();
