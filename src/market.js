/* ==================== 市场抽象层 ====================
 * 统一 A股 / 北交所 / 港股 / 美股 / 场外基金 的：
 *   · 代码规范化与前缀
 *   · 币种
 *   · 行情字段位映射（腾讯各市场字段位置并不完全一致）
 *   · 中文名清洗规则
 */
XJ.market = (function () {
  var U = XJ.util;

  /* ---------------- 交易前缀注册表 ----------------
   * 只描述「代码前缀 → 交易所」的基本信息。
   * 分红路由、币种、资产类型一律以 ASSET 为准（见下），不要在这里判断分红。 */
  var MARKETS = {
    sh: { key: 'sh', label: '沪', kind: 'A股',   currency: 'CNY', symbol: '¥'  },
    sz: { key: 'sz', label: '深', kind: 'A股',   currency: 'CNY', symbol: '¥'  },
    bj: { key: 'bj', label: '北', kind: '北交所', currency: 'CNY', symbol: '¥'  },
    hk: { key: 'hk', label: '港', kind: '港股',   currency: 'HKD', symbol: 'HK$' },
    us: { key: 'us', label: '美', kind: '美股',   currency: 'USD', symbol: '$'  },
    of: { key: 'of', label: '基', kind: '场外基金', currency: 'CNY', symbol: '¥' },
  };

  var PREFIXES = ['sh', 'sz', 'bj', 'hk', 'us', 'of'];

  function meta(symbol) {
    if (!symbol) return null;
    return MARKETS[String(symbol).slice(0, 2)] || null;
  }
  function marketOf(symbol) { return symbol ? String(symbol).slice(0, 2) : ''; }
  function codeOf(symbol) { return symbol ? String(symbol).slice(2) : ''; }

  /**
   * 资产类型细分 —— 决定「分红数据从哪来」。
   *  A股个股(含北交所) → 东财股票分红接口       dividend: 'cn'
   *  场内基金/ETF/LOF  → 天天基金分红接口        dividend: 'fund'
   *  场外基金(of)      → 天天基金分红接口        dividend: 'fund'
   *  港股              → 东财港股 F10 分红接口   dividend: 'hk'
   *  美股              → 暂无公开可用的分红源    dividend: null（不支持自动同步，可手工补录）
   */
  var ASSET = {
    stock: { key: 'stock', label: '股票', dividend: 'cn',   quote: true  },
    etf:   { key: 'etf',   label: 'ETF',  dividend: 'fund', quote: true  },
    of:    { key: 'of',    label: '场外基金', dividend: 'fund', quote: false },
    hk:    { key: 'hk',    label: '港股', dividend: 'hk',   quote: true  },
    us:    { key: 'us',    label: '美股', dividend: null,   quote: true  },
  };

  function assetType(symbol) {
    if (!symbol) return null;
    var mk = marketOf(symbol), code = codeOf(symbol);
    if (mk === 'of') return 'of';
    if (mk === 'hk') return 'hk';
    if (mk === 'us') return 'us';
    if (mk === 'sh' && /^5/.test(code)) return 'etf';   // 沪市 5xxxxx：ETF / LOF / REITs
    if (mk === 'sz' && /^1/.test(code)) return 'etf';   // 深市 1xxxxx：ETF / LOF
    return 'stock';
  }

  function asset(symbol) { return ASSET[assetType(symbol)] || null; }
  function kind(symbol) { var a = asset(symbol); return a ? a.label : '未知'; }
  /** 东财 F10 用的 SECUCODE：sh601919 → 601919.SH */
  function secucodeOf(symbol) {
    var code = codeOf(symbol);
    var p = String(symbol).slice(0, 2);
    return code + (p === 'sh' ? '.SH' : p === 'sz' ? '.SZ' : p === 'bj' ? '.BJ' : '');
  }

  /**
   * 官方图标 URL。拿得到公司官网域名才用官方图标，否则返回 null（界面回退到字母头像）。
   * 走 icon.horse（按域名取公司图标），实测可达；`<img>` 加载无需 CORS。
   */
  function logoUrl(symbol, domain) {
    var d = cleanDomain(domain);
    if (!d) return null;
    return 'https://icon.horse/icon/' + d;
  }

  function cleanDomain(domain) {
    var d = String(domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    return (d && d.indexOf('.') > 0) ? d : '';
  }

  /**
   * 一级域名（registrable domain）：去掉最左边的一级子域。
   *   www.shenergy.net.cn → shenergy.net.cn
   *   hold.coscoshipping.com → coscoshipping.com
   * 规则「标签数 ≥ 3 就去掉第一段」对 .com 与 .com.cn 都成立。
   */
  function rootDomain(domain) {
    var d = cleanDomain(domain);
    if (!d) return '';
    var parts = d.split('.');
    if (parts.length >= 3) return parts.slice(1).join('.');
    return d;
  }

  /**
   * 官方图标的候选 URL，按优先级排列。视图层不直接拼 URL，
   * 而是由 fetcher.resolveLogo 逐个下载 + canvas 校验，取第一个「真图标」。
   *
   * 为什么是这几个：
   *  · icon.horse 覆盖面最广，但查不到域名时会回灰底字母占位图（HTTP 200）；
   *  · 公司官网自己的 favicon.ico 没有 CORS 头，fetch 读不到像素，无法验真 —— 于是改用
   *    api.xinac.net 代理（它会把该域名的真实 favicon 取回来，且带 CORS 可采样）；
   *  · 都拿不到时再由 fetcher 走同花顺 F10 兜底（A股个股）。
   */
  function logoCandidates(symbol, domain) {
    var out = [];
    var d = cleanDomain(domain);
    if (!d) return out;
    var root = rootDomain(d);
    out.push('https://icon.horse/icon/' + d);
    if (root && root !== d) out.push('https://icon.horse/icon/' + root);
    out.push('https://api.xinac.net/icon/?url=' + d);
    if (root && root !== d) out.push('https://api.xinac.net/icon/?url=' + root);
    return out;
  }

  /**
   * 同花顺 F10「公司资料」页 —— A股（沪深北）个股在这页里内嵌了**真实公司 logo**，
   * 且该页实测带 `Access-Control-Allow-Origin: *`，浏览器可直接 fetch 后正则提取。
   * 港股/ETF/场外基金没有这页（返回占位页面），美股该路径 404 → 返回 null。
   */
  function thsF10Url(symbol) {
    if (assetType(symbol) !== 'stock') return null;
    var code = codeOf(symbol);
    return code ? 'https://basic.10jqka.com.cn/' + code + '/company.html' : null;
  }

  /**
   * 该标的的公司图标是否需要（重新）解析。纯函数，便于验收。
   *   · 判定规则升级过（rec.logoAlgo 低于当前 algo）→ 需要，旧结论视为过期
   *   · 已拿到官方标识（logoUrl 且 logoState === 'ok'）→ 不需要
   *   · 今天已经试过 → 不需要（失败的一天最多重试一次，避免反复拉慢接口）
   */
  function logoStale(rec, today, algo) {
    if (!rec) return true;
    if (U.n0(rec.logoAlgo) < U.n0(algo)) return true;
    if (rec.logoUrl && rec.logoState === 'ok') return false;
    return rec.logoResolvedOn !== today;
  }

  /* 同花顺 logo 实测出现过两种 host：basic.10jqka.com.cn/ai_data/logo/company/… 与 o.thsi.cn/… */
  var THS_LOGO_RE = /https?:\/\/(?:basic\.10jqka\.com\.cn\/ai_data\/logo\/company|o\.thsi\.cn)\/[^"'\s\\)]+\.png/;

  /** 从同花顺 F10 页面 HTML 中提取公司 logo URL（纯函数，便于验收） */
  function parseThsLogo(html) {
    if (!html) return null;
    var m = String(html).match(THS_LOGO_RE);
    return m ? m[0] : null;
  }

  /**
   * 判断一张候选图标是不是「假图标」（占位图）。
   *
   * 背景：图标源查不到域名时**不会返回 404**，而是回一张通用占位图，
   * 加载成功会把我们自己的文字头像盖住 —— 用户看到的灰「H」（中远海控）、
   * 灰「W」（申能股份）、黑地球（xinac）都是这么来的。
   *
   * 判据（对 12 张真实样本实测后选定）：
   *   **整张图完全没有彩色（maxSat ≤ 12）→ 判为占位图。**
   *   实测占位图 maxSat 全为 0（灰底字母、黑地球都是纯灰阶）；
   *   而真图标都带色：招行 255、同花顺中远海控 204、同花顺申能 218、
   *   平安 255、茅台 230、腾讯 255，连黑白风格的苹果 favicon 也有 26。
   *   仅有一个条件就够了，早先「无色 + 背景占比高」的与条件会漏掉黑地球那类占位图。
   *
   * 代价：极少数本身就是纯灰度标识的公司会被判为占位图，回退成两字中文简称 ——
   * 这比冒险显示一张通用地球/字母图要好。
   *
   * @param sample { maxSat } 由 canvas 采样得到
   */
  function logoVerdict(sample) {
    if (!sample) return 'ok';
    var maxSat = U.num(sample.maxSat);
    if (maxSat === null) return 'ok';
    return maxSat <= 12 ? 'bad' : 'ok';
  }

  function dividendSource(symbol) { var a = asset(symbol); return a ? a.dividend : null; }
  /** 该标的是否支持自动同步分红（美股暂无公开可用的免费分红源） */
  function supportsDividend(symbol) { return !!dividendSource(symbol); }

  /**
   * 该标的是否能画「按财年」的股息率曲线。
   *   · 美股    → 没有分红数据源，取不到任何方案
   *   · 场外基金 → 分红不定期、没有「财年派现」这个概念，且没有盘中 K 线
   * 其余（A股 / 港股 / ETF）都可以。这个判定必须与 fetcher.fetchYieldHistory 的过滤条件一致，
   * 否则会出现「界面说能画、数据却永远取不到」的空态。
   */
  function supportsYieldCurve(symbol) {
    return supportsDividend(symbol) && assetType(symbol) !== 'of';
  }
  /** 分红数据源的中文说明（用于界面提示） */
  function dividendSourceLabel(symbol) {
    return ({ cn: '东方财富股票分红', hk: '东方财富港股 F10 分红', fund: '天天基金分红' })[dividendSource(symbol)] || '暂不支持自动同步';
  }
  function isQuoteable(symbol) { var a = asset(symbol); return !!(a && a.quote); }

  /**
   * 能否取到「当日分时」——腾讯分时接口覆盖 A股/北交所/ETF/港股/美股；
   * 场外基金无行情（quote:false），取不到。
   */
  function hasMinute(symbol) {
    var t = assetType(symbol);
    return t === 'stock' || t === 'etf' || t === 'hk' || t === 'us';
  }

  /**
   * 能否取到「历史日线」——腾讯日K覆盖 A股/北交所/ETF/港股/美股；
   * 场外基金走天天基金净值走势（Data_netWorthTrend），另有通道。
   */
  function hasDailyHistory(symbol) { return hasMinute(symbol); }

  /**
   * 公司官网域名的取数路径（用于官方图标）。
   *   cn → 东财 RPT_F10_BASIC_ORGINFO（SECUCODE=601919.SH）
   *   hk → 东财 RPT_HKF10_INFO_ORGPROFILE（SECURITY_CODE=00700）
   *   us → 东财 RPT_USF10_INFO_ORGPROFILE（SECURITY_CODE=AAPL）
   * ETF 与场外基金在该表中无数据，返回 null（界面回退字母头像）。
   */
  function orgInfoQuery(symbol) {
    var t = assetType(symbol);
    if (t === 'stock') {
      return { reportName: 'RPT_F10_BASIC_ORGINFO', filter: '(SECUCODE="' + secucodeOf(symbol) + '")' };
    }
    var code = codeOf(symbol);
    if (t === 'hk') return { reportName: 'RPT_HKF10_INFO_ORGPROFILE', filter: '(SECURITY_CODE="' + code + '")' };
    if (t === 'us') return { reportName: 'RPT_USF10_INFO_ORGPROFILE', filter: '(SECURITY_CODE="' + code + '")' };
    return null;
  }

  function label(symbol) {
    var t = assetType(symbol);
    if (t === 'hk') return '港';
    if (t === 'us') return '美';
    if (t === 'of') return '基';
    if (t === 'etf') return 'E';
    var m = marketOf(symbol);
    return m === 'sh' ? '沪' : m === 'sz' ? '深' : m === 'bj' ? '北' : '';
  }

  /**
   * 展示用证券代码：市场缩写大写 + 代码。
   *   sh600036 → SH600036   hk00700 → HK00700
   *   usAAPL   → US AAPL    of110022 → OF110022
   * 美股代码本身是字母，加空格分隔才读得出来（USAAAPL 会连成一串）。
   */
  function displayCode(symbol) {
    if (!symbol) return '';
    var mk = marketOf(symbol);
    var code = codeOf(symbol);
    if (!code) return '';
    var prefix = String(symbol).slice(0, 2).toUpperCase();
    return mk === 'us' ? prefix + ' ' + code : prefix + code;
  }

  /* ---------------- 交易时段（按北京时间） ----------------
   * 仅用于决定「当日分时图」是否展示：非交易时段不画分时，
   * 免得收盘后还挂着一条不动的线，看着像实时数据。
   *   A股/北交所：09:30–11:30、13:00–15:00
   *   港股：      09:30–12:00、13:00–16:00
   *   美股：      北京时间夜间，夏令时 21:30–04:00、冬令时 22:30–05:00，
   *              合并取 21:30–05:00 覆盖两种制式（边界多出的半小时属已知近似）
   * 场外基金无行情，恒为 false。 */
  var SESSION = {
    cn: [[570, 690], [780, 900]],
    hk: [[570, 720], [780, 960]],
  };

  function sessionOpen(symbol, date) {
    /* 用鸭子类型而不是 instanceof Date：instanceof 跨 realm（沙箱/iframe）会失效 */
    var d = (date && typeof date.getHours === 'function') ? date : new Date();
    var mins = d.getHours() * 60 + d.getMinutes();
    var day = d.getDay();                       // 0 周日 … 6 周六
    var mk = marketOf(symbol);

    if (mk === 'us') {
      if (mins >= 1290 && day >= 1 && day <= 5) return true;   // 周一–周五 21:30 之后
      if (mins < 300 && day >= 2 && day <= 6) return true;     // 周二–周六 05:00 之前
      return false;
    }

    var key = (mk === 'sh' || mk === 'sz' || mk === 'bj') ? 'cn' : mk;
    var segs = SESSION[key];
    if (!segs) return false;
    if (day < 1 || day > 5) return false;
    for (var i = 0; i < segs.length; i++) {
      if (mins >= segs[i][0] && mins < segs[i][1]) return true;
    }
    return false;
  }

  function currency(symbol) {
    var m = marketOf(symbol);
    if (m === 'hk') return 'HKD';
    if (m === 'us') return 'USD';
    return 'CNY';
  }
  function curSymbol(symbol) {
    var c = currency(symbol);
    return c === 'HKD' ? 'HK$' : c === 'USD' ? '$' : '¥';
  }

  /**
   * 美股 → 东财 secid（分时接口用）。
   * 腾讯行情给的带后缀代码形如 AAPL.OQ / BABA.N / XXX.A，
   * 后缀对应市场号：OQ=105 纳斯达克、N=106 纽交所、A=107 美交所。
   */
  function usSecid(quoteCode) {
    var m = String(quoteCode || '').match(/^(.*)\.(OQ|N|A)$/);
    if (!m) return null;
    var mk = m[2] === 'OQ' ? 105 : m[2] === 'N' ? 106 : 107;
    return mk + '.' + m[1];
  }

  /** 东财 secid（A股/港股/美股通吃，用于分时与部分历史接口） */
  function secidOf(symbol) {
    var mk = marketOf(symbol), code = codeOf(symbol);
    if (mk === 'sh') return '1.' + code;
    if (mk === 'sz' || mk === 'bj') return '0.' + code;
    if (mk === 'hk') return '116.' + code;
    return null;
  }

  /* ---------------- 对比指数注册表 ----------------
   * 用于「资产走势」的收益率曲线对比。
   *
   * 历史日线走腾讯 `web.ifzq.gtimg.cn/appstock/app/kline/kline`（`<script>` 注入，实测 400 根含 OHLC）：
   *   A股/港股指数用 sh000001 / hkHSI 这种代码；**美股指数要用 `us.IXIC` 这种带点的代码**才拿得到历史。
   *   （东财 push2his/push2 系列在 file:// 页面里被 WAF 拒（ERR_EMPTY_RESPONSE），browser 不可用。）
   * 当日分时走腾讯 minute 接口，只有 A股/港股指数有。
   *
   * 日经225 / 台湾加权 / 韩国KOSPI：腾讯（kline 与 minute 两套接口、含 us./jp./tw./kr. 各前缀）、
   * 东财 push2his/trends2、同花顺 d.10jqka.com.cn、新浪 hq.sinajs.cn 与 KC_MarketDataService、
   * 网易 chddata 全部实测拿不到浏览器可达的免费历史 —— 因此 kline 置 null、界面置灰并说明原因。
   */
  var INDICES = [
    { key: 'sh',    name: '上证指数',  kline: 'sh000001', minute: 'sh000001', region: 'A股' },
    { key: 'hs300', name: '沪深300',   kline: 'sh000300', minute: 'sh000300', region: 'A股' },
    { key: 'hsi',   name: '恒生指数',  kline: 'hkHSI',    minute: 'hkHSI',    region: '港股' },
    { key: 'ixic',  name: '纳斯达克',  kline: 'us.IXIC',  minute: null,       region: '美股' },
    { key: 'spx',   name: '标普500',   kline: 'us.INX',   minute: null,       region: '美股' },
    { key: 'n225',  name: '日经225',   kline: null, minute: null, region: '日股',
      unavailable: '暂无浏览器可达的免费历史数据源' },
    { key: 'twii',  name: '台湾加权',  kline: null, minute: null, region: '台股',
      unavailable: '暂无浏览器可达的免费历史数据源' },
    { key: 'ks11',  name: '韩国KOSPI', kline: null, minute: null, region: '韩股',
      unavailable: '暂无浏览器可达的免费历史数据源' },
  ];

  /** 指数定义（按 key 查） */
  function indexDef(key) {
    for (var i = 0; i < INDICES.length; i++) if (INDICES[i].key === key) return INDICES[i];
    return null;
  }
  function indexHasIntraday(key) {
    var d = indexDef(key);
    return !!(d && d.minute);
  }
  /** 该指数有没有可用的历史数据源（没有的界面置灰） */
  function indexHasHistory(key) {
    var d = indexDef(key);
    return !!(d && d.kline);
  }
  /** 指数自己的颜色（图例与曲线共用，保证两者同色） */
  var INDEX_COLORS = {
    sh: '#E0312F', hs300: '#E8A87C', hsi: '#B07CE8', ixic: '#3FA9C9',
    spx: '#4CAF7D', n225: '#E0A03A', twii: '#D9648F', ks11: '#6B7FD7',
  };
  function indexColor(key) { return INDEX_COLORS[key] || '#8E8E93'; }
  /** 组合自身的颜色：市值橙红、净资产蓝、收益率紫 */
  var METRIC_COLORS = { mv: '#E8461F', nw: '#3FA9C9', ret: '#7B5CE0' };

  /** A股 6 位代码 → 交易所前缀 */
  function prefixForAStock(code) {
    var c = String(code).charAt(0);
    if (c === '6' || c === '5' || c === '9') return 'sh';
    if (c === '0' || c === '1' || c === '2' || c === '3') return 'sz';
    if (c === '4' || c === '8') return 'bj';
    return 'sh';
  }

  function pad5(n) { var s = String(n); while (s.length < 5) s = '0' + s; return s; }

  /**
   * 代码规范化。marketHint 传入时强制按该市场解析（用于表单里的「市场」下拉，
   * 消除 "700" 到底是港股还是 A 股这类歧义）。
   * 返回带前缀的 symbol，或 null。
   */
  function normalize(input, marketHint) {
    if (input === null || input === undefined) return null;
    var s = String(input).trim().replace(/\s+/g, '');
    if (!s) return null;

    if (marketHint && MARKETS[marketHint]) return normalizeTo(s, marketHint);

    var lower = s.toLowerCase();
    // 1) 显式前缀： sh600023 / hk00700 / usAAPL / of110022
    var m = lower.match(/^(sh|sz|bj|hk|us|of)[._-]?(.+)$/);
    if (m) return normalizeTo(m[2], m[1]);

    // 2) 后缀形式： 600023.SH / 00700.HK / AAPL.OQ / 110022.OF
    var m2 = s.match(/^([A-Za-z0-9._-]+)[.](SH|SZ|BJ|HK|US|OF)$/i);
    if (m2) return normalizeTo(m2[1], m2[2].toLowerCase());

    // 3) 纯数字
    if (/^\d{6}$/.test(s)) return prefixForAStock(s) + s;
    // 5 位以内且以 0 开头（或不足 5 位）才判定为港股，避免把 12345 这类误判
    if (/^\d{1,4}$/.test(s)) return 'hk' + pad5(s);
    if (/^0\d{4}$/.test(s)) return 'hk' + s;
    // 4) 字母 → 美股
    if (/^[A-Za-z][A-Za-z0-9.\-]*$/.test(s)) return 'us' + usCode(s);
    return null;
  }

  function usCode(body) {
    // 去掉交易所后缀（AAPL.OQ → AAPL），腾讯接口用裸代码
    return String(body).toUpperCase().replace(/[.\-].*$/, '');
  }

  function normalizeTo(body, market) {
    var b = String(body).replace(/\s+/g, '');
    if (market === 'us') {
      var c = usCode(b);
      return /^[A-Za-z][A-Za-z0-9]{0,7}$/.test(c) ? 'us' + c : null;
    }
    if (market === 'hk') {
      if (/^\d{1,5}$/.test(b)) return 'hk' + pad5(b);
      return null;
    }
    if (market === 'of') {
      return /^\d{6}$/.test(b) ? 'of' + b : null;
    }
    // sh / sz / bj
    if (/^\d{6}$/.test(b)) return market + b;
    return null;
  }

  /* ---------------- 行情字段位映射 ---------------- */
  /* 实测：三个市场的 [1]名称 [2]代码 [3]现价 [4]昨收 [5]今开 [30]时间
     [31]涨跌额 [32]涨跌幅% [33]最高 [34]最低 [36]成交量 [37]成交额
     [38]换手率 [39]市盈率 [44]流通市值(亿) [45]总市值(亿) 位置一致。
     差异只在 [35]：A股是「价/量/额」拼接串，港股同 A 股，美股是币种(USD)。*/

  function parseTime(raw, market) {
    if (!raw) return '';
    var s = String(raw).trim();
    if (market === 'us') return s.replace(/-/g, '').replace(/[: ]/g, '').slice(0, 14); // 2026-09-09 16:00:01 → 20260909160001
    if (raw.indexOf('/') >= 0) {
      // 2026/09/10 15:50:44 → 20260910155044
      return s.replace(/[/: ]/g, '').slice(0, 14);
    }
    return s.slice(0, 14);
  }

  /** 解析腾讯行情原始串（按 ~ 分割后的数组） */
  function parseQuoteFields(symbol, raw) {
    if (!raw || typeof raw !== 'string') return null;
    var f = raw.split('~');
    if (f.length < 40) return null;
    var mk = marketOf(symbol);

    var price = U.num(f[3]);
    var prevClose = U.num(f[4]);
    if (!price || price <= 0) price = prevClose;          // 停牌兜底
    if (!price || price <= 0) return null;

    var isCn = (mk === 'sh' || mk === 'sz' || mk === 'bj');
    // 市值单位：A股/港股为「亿」，美股 [44]/[45] 亦为「亿」但需按币种理解
    return {
      symbol: symbol,
      market: mk,
      currency: mk === 'us' ? (f[35] || 'USD') : currency(symbol),
      name: cleanName(f[1]),
      nameTruncated: isTruncatedName(f[1]),
      code: f[2] || codeOf(symbol),
      price: price,
      prevClose: prevClose,
      open: U.num(f[5]),
      change: U.num(f[31]),
      changePct: U.num(f[32]),
      high: U.num(f[33]),
      low: U.num(f[34]),
      volume: U.num(f[36]),
      amount: U.num(f[37]),
      turnover: U.num(f[38]),
      pe: U.num(f[39]),
      floatCap: U.num(f[44]),      // 亿（当地货币）
      totalCap: U.num(f[45]),
      // 只有 A 股有涨跌停制度；港股/美股的 [47]/[48] 是别的含义，不可复用
      limitUp: isCn ? U.num(f[47]) : null,
      limitDown: isCn ? U.num(f[48]) : null,
      quoteTime: parseTime(f[30], mk),
      updatedAt: U.nowStamp(),
    };
  }

  /** 交易所前缀会挤掉原名的字（XD中国平），需要标记出来供上层决定是否采用 */
  var TRUNC_PREFIX = /^(XD|XR|DR|N|C)(?=[\u4e00-\u9fa5A-Za-z])/;
  function cleanName(raw) {
    if (!raw) return '';
    return String(raw).replace(/\s+/g, '');
  }
  function isTruncatedName(raw) {
    if (!raw) return false;
    return TRUNC_PREFIX.test(String(raw).replace(/\s+/g, ''));
  }

  /* ---------------- 行情请求代码 ---------------- */
  function quoteCode(symbol) {
    // 腾讯接口代码 = symbol 本身（sh600023 / hk00700 / usAAPL / of 不支持）
    return isQuoteable(symbol) ? symbol : null;
  }

  /* ---------------- 币种换算 ---------------- */
  var FX_SYMBOL = { HKD: 'whHKDCNY', USD: 'whUSDCNY' };

  function fxCode(c) { return FX_SYMBOL[c] || null; }

  /** 把字符串数组按 [1][3] 解析外汇（[1]名称 [3]最新价） */
  function parseFx(raw) {
    if (!raw || typeof raw !== 'string') return null;
    var f = raw.split('~');
    var v = U.num(f[3]);
    return (v && v > 0) ? v : null;
  }

  return {
    MARKETS: MARKETS,
    ASSET: ASSET,
    PREFIXES: PREFIXES,
    meta: meta, marketOf: marketOf, codeOf: codeOf,
    assetType: assetType, asset: asset,
    label: label, kind: kind, currency: currency, curSymbol: curSymbol,
    displayCode: displayCode,
    sessionOpen: sessionOpen, hasMinute: hasMinute, hasDailyHistory: hasDailyHistory,
    orgInfoQuery: orgInfoQuery,
    isQuoteable: isQuoteable, dividendSource: dividendSource,
    supportsDividend: supportsDividend, supportsYieldCurve: supportsYieldCurve,
    dividendSourceLabel: dividendSourceLabel,
    secucodeOf: secucodeOf, logoUrl: logoUrl, logoVerdict: logoVerdict,
    rootDomain: rootDomain, cleanDomain: cleanDomain,
    logoCandidates: logoCandidates, thsF10Url: thsF10Url,
    parseThsLogo: parseThsLogo, THS_LOGO_RE: THS_LOGO_RE,
    logoStale: logoStale,
    prefixForAStock: prefixForAStock, pad5: pad5,
    usSecid: usSecid, secidOf: secidOf,
    INDICES: INDICES, indexDef: indexDef, indexColor: indexColor,
    indexHasIntraday: indexHasIntraday, indexHasHistory: indexHasHistory,
    METRIC_COLORS: METRIC_COLORS,
    normalize: normalize,
    parseQuoteFields: parseQuoteFields,
    cleanName: cleanName, isTruncatedName: isTruncatedName,
    quoteCode: quoteCode,
    fxCode: fxCode, parseFx: parseFx,
    FX_SYMBOL: FX_SYMBOL,
  };
})();
