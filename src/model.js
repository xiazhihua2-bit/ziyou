/* ==================== 数据模型：默认值 / 校验 / 序列化 ==================== */
XJ.model = (function () {
  var U = XJ.util;

  var DATA_VERSION = 6;

  /**
   * v4：默认成本口径改成「分红摊薄」——分红到账后自动降低持仓成本。
   * 老数据（version < 4）在 ensureBootstrapped 里一次性迁移过去；
   * 迁移只跑一次，之后用户手动改过的口径不会被覆盖。
   * v5：新增 syncMeta（跨设备同步的连接信息与修订账本）。**只补容器、不动数据**，
   *     同步默认关闭，不开就等于没这回事。
   * v6：支出项新增 category（'essential' 生存 | 'quality' 品质，FIRE 视图三档分母用），
   *     存量数据**全部归 essential**（用户自行挑品质项，不做预判）；
   *     新增 settings.fire（FIRE 视图的模拟参数 / 档位 / 场景），**只补容器、不动数据**。
   */
  var DEFAULT_COST_METHOD = 'dividendDiluted';

  /** 由模板生成支出项（补上 expenseId / icon / enabled） */
  function makeExpenses(template) {
    return template.map(function (e, i) {
      return {
        expenseId: 'exp_' + e.key.toLowerCase(),
        key: e.key,
        label: e.label,
        icon: e.icon || KEY_EMOJI[e.key] || '🏷️',
        iconAuto: true,
        monthlyAmount: e.monthlyAmount,
        enabled: true,
        sortOrder: e.sortOrder === undefined ? i + 1 : e.sortOrder,
      };
    });
  }

  /* ---- 息覆生活默认支出项（与息记截图一致的 6 项，含 emoji 图标）
   * 用户可自由增删改；这里只是新装的初始值 ---- */
  var EXPENSE_TEMPLATE = [
    { key: 'PHONE', label: '话费', icon: '💬', monthlyAmount: 60, sortOrder: 1, category: 'essential' },
    { key: 'INSURANCE', label: '保险', icon: '🛡️', monthlyAmount: 200, sortOrder: 2, category: 'essential' },
    { key: 'FRUIT', label: '水果', icon: '🍎', monthlyAmount: 150, sortOrder: 3, category: 'essential' },
    { key: 'UTILITY', label: '水电燃气', icon: '⚡', monthlyAmount: 100, sortOrder: 4, category: 'essential' },
    { key: 'MEALS', label: '三餐', icon: '🍱', monthlyAmount: 600, sortOrder: 5, category: 'essential' },
    { key: 'MORTGAGE', label: '房贷/房租', icon: '🏠', monthlyAmount: 700, sortOrder: 6, category: 'essential' },
  ];

  /* v1/v2 的旧模板：仅用于识别「用户从未改过支出项」从而安全升级到新模板 */
  var LEGACY_EXPENSE_TEMPLATE = [
    { key: 'PHONE', label: '话费', monthlyAmount: 100 },
    { key: 'UTILITY', label: '水电燃气', monthlyAmount: 300 },
    { key: 'PROPERTY', label: '物业费', monthlyAmount: 200 },
    { key: 'FUEL', label: '加油', monthlyAmount: 400 },
    { key: 'MORTGAGE', label: '房贷/房租', monthlyAmount: 3000 },
    { key: 'OTHER', label: '其他消费', monthlyAmount: 500 },
    { key: 'LUNCH', label: '午餐', monthlyAmount: 600 },
  ];

  /* ---- 截图识别（智谱 GLM-4V）默认配置 ----
   * 预置 Key 让功能开箱即用；用户可在「我的 · 截图识别」改成自己的 Key。
   * 注意：单文件分发时等于把这把 Key 一起分发出去，介意请自行更换。 */
  /* 构建期占位符：build.mjs 会分别替换 ——
       单文件产物 → 内置真实 Key（本地双击用，开箱即用）
       dist/pwa/  → 置空（部署到公网等于公开 Key，会被别人消耗额度） */
  var DEFAULT_OCR_KEY = '__XJ_OCR_KEY__';

  /* ---- 支出项图标：分类 emoji 选择器 + 已知 key 的默认图标 ----
   * 历史数据里的支出项曾被统一塞成 💰，这里按 key 自动修正成语义对应的图标。 */
  var EMOJI_GROUPS = [
    { name: '居住', list: ['🏠', '🏢', '🛋️', '🔑', '💡', '💧', '🔥', '🚿', '🧹', '🚪'] },
    { name: '水电燃气', list: ['⚡', '💡', '💧', '🔥', '🚰', '🔌', '🌡️', '❄️'] },
    { name: '餐饮', list: ['🍜', '🍚', '🍱', '☕', '🥬', '🍖', '🧋', '🍞', '🥤', '🍳', '🍎', '🥗'] },
    { name: '交通', list: ['🚗', '⛽', '🚇', '🚌', '🚕', '🅿️', '🚲', '🛵', '🚄', '🛣️', '🎫'] },
    { name: '通讯数码', list: ['💬', '📶', '📱', '💻', '🖥️', '🎧', '⌚', '📡', '🖨️'] },
    { name: '健康医疗', list: ['💊', '🏥', '🦷', '👓', '🏃', '🧘', '💉', '🩺'] },
    { name: '保险金融', list: ['🛡️', '💰', '💳', '🏦', '📈', '📊', '🧾', '💵'] },
    { name: '教育成长', list: ['📚', '🎓', '✏️', '📖', '🎨', '🎹', '🗣️'] },
    { name: '人情娱乐', list: ['🎁', '🧧', '🎬', '🎮', '🎵', '⚽', '🍻', '🎂', '✈️'] },
    { name: '服饰日用', list: ['👕', '👟', '🧴', '🧻', '🛒', '🧼', '🪥', '💄'] },
    { name: '宠物其他', list: ['🐾', '🐶', '🐱', '📦', '⭐', '🔖', '🌱', '🏷️'] },
  ];

  var KEY_EMOJI = {
    PHONE: '💬', UTILITY: '⚡', PROPERTY: '🏢', FUEL: '⛽',
    MORTGAGE: '🏠', OTHER: '🛒', LUNCH: '🍜',
    INSURANCE: '🛡️', FRUIT: '🍎', MEALS: '🍱',
    WATER: '💧', ELECTRIC: '💡', GAS: '🔥', INTERNET: '📶',
    MEDICAL: '💊', EDU: '📚', SUBWAY: '🚇', CLOTHES: '👕',
    TRAVEL: '✈️', PET: '🐾',
  };

  /* ---- 首页年度分红卡可选指标（用户可自选 1~6 个） ---- */
  var HERO_METRICS = [
    { key: 'receivedThisYear', label: '今年已收',    hint: '本年度已到账的分红合计' },
    { key: 'totalCost',        label: '总成本',      hint: '按所选成本口径计算的投入合计' },
    { key: 'totalMarketValue', label: '总市值',      hint: '最近交易日收盘价 × 持股数，多币种按当日汇率折算为人民币' },
    { key: 'costYield',        label: '成本息率',    hint: '预测年度分红 ÷ 持仓总成本，反映实际投入资金的回报率' },
    { key: 'marketYield',      label: '市值息率',    hint: '预测年度分红 ÷ 当前总市值，即当前价格下的股息率' },
    { key: 'monthlyDividend',  label: '月均预测分红', hint: '预测年度分红 ÷ 12' },
  ];

  /* ---- 证券代码规范化（委托给 market.js，支持 A股/北交所/港股/美股/场外基金） ---- */
  var SYMBOL_RE = /^(sh|sz|bj|hk|us|of)[A-Za-z0-9]{1,8}$/;

  function normalizeSymbol(input, marketHint) {
    return XJ.market.normalize(input, marketHint);
  }

  function marketPrefix(code) { return XJ.market.prefixForAStock(code); }
  function codeOf(symbol) { return XJ.market.codeOf(symbol); }
  function marketOf(symbol) { return XJ.market.marketOf(symbol); }
  function marketLabel(symbol) { return XJ.market.label(symbol); }
  function currencyOf(symbol) { return XJ.market.currency(symbol); }
  function marketKind(symbol) { return XJ.market.kind(symbol); }

  /**
   * 归一化「[['YYYY-MM-DD', 数值], ...]」这类轻量序列（股息率曲线 / 余额宝基准用）。
   * 只保留日期合法、数值为正有限的行，按日期升序去重（同日后出现者覆盖前者）。
   * 坏数据一律剔除而不是抛错：这两份缓存都是外部接口产物，宁可少画也不要整页崩。
   */
  function normCloseSeries(arr) {
    if (!Array.isArray(arr)) return [];
    var map = {};
    for (var i = 0; i < arr.length; i++) {
      var row = arr[i];
      if (!row || row.length < 2) continue;
      var d = String(row[0]).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      var v = U.num(row[1]);
      if (v === null || !isFinite(v) || v <= 0) continue;
      map[d] = v;
    }
    return Object.keys(map).sort().map(function (d) { return [d, map[d]]; });
  }

  /* ---- 默认状态 ---- */
  function defaultState() {
    return {
      version: DATA_VERSION,
      createdAt: U.nowStamp(),
      accounts: [],
      symbols: {},          // symbol -> {symbol, code, market, name, type, updatedAt}
      transactions: [],
      plans: {},            // planId -> DividendPlan
      received: [],         // DividendReceived[]
      expenses: makeExpenses(EXPENSE_TEMPLATE),
      projection: {
        configId: 'proj_default',
        monthlyInvest: 5000,
        years: 10,
        reinvestRatio: 1,
        divGrowthRate: 0,
        startAssets: null,
      },
      settings: {
        id: 'app_settings',
        quoteRefreshMs: 60000,
        planCacheTTLMs: 604800000,     // 7 天
        defaultAccountId: null,
        reminderLeadDays: 3,
        lastQuoteAt: null,
        lastPlanAt: null,
        onboarded: false,
        heroMetrics: HERO_METRICS.map(function (m) { return m.key; }),
        heroCollapsed: false,
        /* 深色卡「测算带」参数（每年投入 / 股息率 / 年数 / 再投比例 / 反解目标）。
           首次启动由 ensureBootstrapped 从 projection 派生起点，之后与「展望未来」完全独立。
           yieldPct = null 表示「跟随当前组合市值息率」，用户一旦手改就固定下来。 */
        heroForecast: null,
        defaultDividendBasis: { type: 'years', value: 1 },
        fx: null,                        // { HKD, USD, updatedAt }
        ocr: {                           // 截图识别（智谱 GLM-4V）
          apiKey: DEFAULT_OCR_KEY,
          model: 'glm-4v-flash',
          agreed: false,                 // 是否已确认「截图会上传第三方」的隐私提示
          lastUsedAt: null,
        },
        showLogo: true,                  // 优先展示股票官方图标（取不到则回退字母头像）
        unsupportedDividend: [],         // 无分红数据源的标的（美股）
        indexCompare: ['sh', 'hs300', 'hsi'],   // 资产走势里默认勾选的对比指数
        showYieldBench: false,           // 股息率曲线里是否叠加「余额宝七日年化」基准线（默认关）
        /* 派息日弹窗：最近一次已经弹过的日期（'YYYY-MM-DD'）。
           当天弹过就不再打扰；存 settings 而不是 ui，是为了跨会话/跨设备导入后都不会重复弹。 */
        payoutPopupAt: null,
        /* 分红汇总里的趣味换算基准（可配置）：默认「视频会员 ¥25/月」。
           monthly ≤ 0 时界面隐藏这一行。 */
        dividendFun: { name: '视频会员', monthly: 25 },
        /* FIRE 视图（v6）：试算滑杆模拟值 / 三档 / 息率口径 / 场景。
           ★ monthlySpend / dripYieldPct 为 null 表示「跟随真实值」（该档支出台账 / 当前组合息率），
           与 heroForecast.yieldPct 的 null 语义同一范式；用户一动滑杆就落成数字固定下来。
           每档（lean/regular/fat）各自记忆模拟值，互不干扰。 */
        fire: {
          v: 1,
          yieldBasis: 'market',          // 息率口径：'cost' 成本息率 | 'market' 市值息率
          activeTier: 'regular',         // 当前选中的 FIRE 档
          tierSims: {
            lean:    { monthlySpend: null, drip: 5000, dripYieldPct: null },
            regular: { monthlySpend: null, drip: 5000, dripYieldPct: null },
            fat:     { monthlySpend: null, drip: 5000, dripYieldPct: null },
          },
          reinvestPct: 100,              // 再投比例（与 FORECAST.reinvestDefaultPct 一致）
          scenes: [],                    // [{ sceneId, name, spendPct, dripPct, yieldAdjPct }]
        },
      },
      quoteCache: {},       // symbol -> quote
      snapshots: {},        // 'YYYY-MM-DD' -> { mv, cost, pred, recv, fx }
      priceHistory: {},     // symbol -> { at:'YYYY-MM-DD', points:[['YYYY-MM-DD', price], ...] }
      indexHistory: {},     // indexKey -> { at:'YYYY-MM-DD', bars:[['YYYY-MM-DD', o, h, l, c], ...] }
      klineCache: {},       // symbol -> { at:'YYYY-MM-DD', day:[{d,o,h,l,c}], week:[...] }（技术信号用）
      /* 当日分时缓存：{ at:'YYYY-MM-DD', bySymbol:{ symbol:{ date:'YYYY-MM-DD', points:[{t,p}] } } }
         at = 这批数据的交易日（取接口 date，不是本机今日），每只标的只保留最近 1 天。
         落盘持久化：收盘后 / 周末打开也要能看到最近一个交易日的分时曲线。 */
      minuteCache: null,
      /* 股息率曲线的收盘价缓存：symbol -> { at:'YYYY-MM-DD', day:[['YYYY-MM-DD',close]], week:[...] }
         与 klineCache 分开存的理由：那套是完整 OHLC、只留 120 根、给 BOLL/KDJ 用；
         这套只要收盘价就能算股息率，且日线要留 320 根（≈1.2 年）、周线 640 根（≈12.5 年）
         来撑满「最近十年」—— 把两套需求的量级塞进同一个缓存会让技术信号白白背上一堆数据。 */
      yieldHistory: {},
      /* 余额宝七日年化（全局一份，不是 per-symbol）：
         { at:'YYYY-MM-DD', points:[['YYYY-MM-DD', pct]] }，按周降采样（约 520 点覆盖 10 年） */
      benchHistory: null,
      /* 跨设备同步的元数据（v5 新增）。★ 架构预留：当前版本同步层已剔除，
         此结构作为空壳保留，enabled 恒为 false —— 将来接回同步层时零核心改动。
         语义不变：除非 syncMeta.enabled === true，应用不会发出任何同步请求；
         token 与 gistId 绝不进任何导出（见 toExport）。 */
      syncMeta: {
        deviceId: null,
        enabled: false,
        token: null,
        gistId: null,
        version: 0,
        etag: null,
        lastOkAt: null,
        failSince: null,
        lastErr: null,
        everPaired: false,
        installMode: null,
        /* 配对密钥：本机随机生成，用于把口令/二维码里的载荷加密（见 sync-core 的 XJ2e）。
           它与 token 同级敏感 —— 只在本机持久化，绝不进 Gist、绝不进导出。
           没有它时口令回落明文（XJ1p），旧的安装链接也因此继续可用。 */
        pairKey: null,
        /* 一次性自愈标记：登录时发现「账本空但记录带修订戳」说明踩过
           「本机存档被当成导入备份解析」的旧 bug，已重建账本。见 app.js healSyncLedger。 */
        legacyHealed: false,
        /* 一次性：刚换到新的云端位置，这一次拉取必须无条件当真（见 app.js resetRemoteMemory） */
        forcePull: false,
        /* 令牌自述的权限范围：只用于界面提示，绝不进云端、绝不进导出 */
        tokenScopes: null,
        outbox: [],
        versions: {},
        tombstones: {},
      },
    };
  }

  /** 首次运行：建一个默认账户 */
  function ensureBootstrapped(state) {
    /* 先把容器补齐，后面各段逻辑才敢直接用（导入残缺 JSON 时尤为重要） */
    if (!state.settings || typeof state.settings !== 'object') state.settings = {};
    if (!Array.isArray(state.accounts)) state.accounts = [];
    if (!Array.isArray(state.expenses)) state.expenses = [];
    if (!Array.isArray(state.transactions)) state.transactions = [];
    if (!Array.isArray(state.received)) state.received = [];
    if (!state.symbols || typeof state.symbols !== 'object') state.symbols = {};
    if (!state.plans || typeof state.plans !== 'object') state.plans = {};
    if (!state.quoteCache || typeof state.quoteCache !== 'object') state.quoteCache = {};

    if (!state.accounts.length) {
      var acc = {
        accountId: U.uid('acc'),
        name: '我的账户',
        type: 'BROKER',
        sortOrder: 1,
        createdAt: U.nowStamp(),
      };
      state.accounts.push(acc);
      state.settings.defaultAccountId = acc.accountId;
    }
    if (!state.settings.defaultAccountId ||
        !state.accounts.some(function (a) { return a.accountId === state.settings.defaultAccountId; })) {
      state.settings.defaultAccountId = state.accounts[0].accountId;
    }
    // 老版本默认支出项从未被用户改动过 → 平滑升级到新的 6 项模板
    if (isUntouchedLegacy(state.expenses)) {
      state.expenses = makeExpenses(EXPENSE_TEMPLATE);
    }

    // 支出项允许用户自由增删，因此只在空集时才播撒默认模板
    if (!Array.isArray(state.expenses) || !state.expenses.length) {
      state.expenses = makeExpenses(EXPENSE_TEMPLATE);
    }
    state.expenses.forEach(function (e, i) {
      /* 图标修正：老数据被统一塞成 💰（iconAuto 未标记过），按 key 换成语义对应的图标；
         用户在图标选择器里手动选过的（iconAuto === false）永不覆盖。 */
      if (!e.icon) {
        e.icon = KEY_EMOJI[e.key] || '🏷️';
        e.iconAuto = true;
      } else if (e.icon === '💰' && e.iconAuto !== false) {
        e.icon = KEY_EMOJI[e.key] || '🏷️';
        e.iconAuto = true;
      }
      /* v6 分类归一：FIRE 三档分母用。存量数据全部归「生存」，用户在 FIRE 视图
         自行把品质项挑出去；只认 'quality'，其余脏值一律归 'essential'（幂等）。 */
      if (e.category !== 'quality') e.category = 'essential';
      if (e.sortOrder === undefined) e.sortOrder = i + 1;
      if (e.enabled === undefined) e.enabled = true;
    });
    state.expenses.sort(function (a, b) { return a.sortOrder - b.sortOrder; });

    // v3 新增容器
    if (!state.snapshots || typeof state.snapshots !== 'object') state.snapshots = {};
    if (!state.priceHistory || typeof state.priceHistory !== 'object') state.priceHistory = {};
    // v4 新增容器
    if (!state.indexHistory || typeof state.indexHistory !== 'object') state.indexHistory = {};
    /* 技术信号用的 OHLC K 线缓存：symbol -> { at:'YYYY-MM-DD', day:[{d,o,h,l,c}], week:[...] }
       与 priceHistory 分开存：那套只有收盘价、算不了 BOLL/KDJ，
       而且两者的刷新策略不同（K 线按天缓存，净值曲线按需重取）。 */
    if (!state.klineCache || typeof state.klineCache !== 'object') state.klineCache = {};
    /* 当日分时缓存（旧数据补齐 + 裁字段迁移）。
       早期版本把分时放在内存里的 state.minute（不落盘），且每个点带成交量 v；
       现在改成落盘的 minuteCache，并且只保留 { t, p }（sparkline 只用得到价，体积约减半）。*/
    if (!state.minuteCache || typeof state.minuteCache !== 'object') {
      state.minuteCache = null;
    } else {
      var mcAt = state.minuteCache.at;
      var mcBy = state.minuteCache.bySymbol;
      if (typeof mcAt !== 'string' || !mcAt || !mcBy || typeof mcBy !== 'object') {
        state.minuteCache = null;
      } else {
        var mcOut = {};
        for (var mcSym in mcBy) {
          if (!Object.prototype.hasOwnProperty.call(mcBy, mcSym)) continue;
          var mcOne = mcBy[mcSym];
          if (!mcOne || typeof mcOne !== 'object') continue;
          var mcDate = mcOne.date;
          var mcPts = mcOne.points;
          if (typeof mcDate !== 'string' || !mcDate) continue;
          if (!Array.isArray(mcPts) || mcPts.length < 2) continue;
          var mcClean = [];
          for (var mcI = 0; mcI < mcPts.length; mcI++) {
            var mcPt = mcPts[mcI];
            if (!mcPt) continue;
            mcClean.push({ t: mcPt.t, p: mcPt.p });
          }
          if (mcClean.length < 2) continue;
          mcOut[mcSym] = { date: mcDate, points: mcClean };
        }
        state.minuteCache = { at: mcAt, bySymbol: mcOut };
      }
    }
    if (!state.settings) state.settings = {};
    if (!Array.isArray(state.settings.indexCompare)) {
      state.settings.indexCompare = ['sh', 'hs300', 'hsi'];
    }
    if (state.settings.showYieldBench !== true) state.settings.showYieldBench = false;

    /* 股息率曲线的收盘价缓存（旧数据补齐 + 结构校验）。
       每只标的要有 v=2 标记 + 一段升序的 [['YYYY-MM-DD', close], ...]（只存日线，最近十年）。
       v=1 那版是「日线 320 根 + 周线 640 根」双粒度，会让曲线出现非交易日间隔，
       且与新版混存会出现粒度忽粗忽细 —— 直接丢弃、由下一次同步重取。 */
    if (!state.yieldHistory || typeof state.yieldHistory !== 'object') {
      state.yieldHistory = {};
    } else {
      var yhOut = {};
      for (var yhSym in state.yieldHistory) {
        if (!Object.prototype.hasOwnProperty.call(state.yieldHistory, yhSym)) continue;
        var yhOne = state.yieldHistory[yhSym];
        if (!yhOne || typeof yhOne !== 'object') continue;
        if (U.n0(yhOne.v) !== 2) continue;
        var yhDay = normCloseSeries(yhOne.day);
        if (yhDay.length < 2) continue;
        yhOut[yhSym] = { v: 2, at: yhOne.at || null, day: yhDay };
      }
      state.yieldHistory = yhOut;
    }
    /* 余额宝七日年化基准（全局一份）：{ at, points:[['YYYY-MM-DD', pct]] } */
    if (!state.benchHistory || typeof state.benchHistory !== 'object') {
      state.benchHistory = null;
    } else {
      var bhPts = normCloseSeries(state.benchHistory.points);
      state.benchHistory = bhPts.length >= 2 ? { at: state.benchHistory.at || null, points: bhPts } : null;
    }

    /* ---- v5 新增容器：跨设备同步元数据 ----
       只补容器、不动数据。这里【绝不从「导入的 JSON」里读 syncMeta】——
       换设备导入别人的备份时不该把对方的同步连接信息带进来（token 会被误用）。
       ★ 但本机存档读取必须走 fromImport(raw, { keepSync: true })：
         这个解析器同时也是「开机自加载」的入口，若在自加载时也把 syncMeta 丢掉，
         就变成「每打开一次网页，同步开关、令牌、云端位置、设备身份、修订账本全被清空」，
         而账本清空会让本机全部记录被当成新增反复重推 —— 云端因此越堆越大，
         最终写入被 GitHub 拒绝（HTTP 400）。
         踩过：两个入口共用一个函数、又用「不读 syncMeta」一条规则同时满足两边，
         结果是必需的功能被当成安全策略执行掉了。 */
    if (!state.syncMeta || typeof state.syncMeta !== 'object') state.syncMeta = {};
    var sm = state.syncMeta;
    if (sm.enabled !== true) sm.enabled = false;
    if (sm.everPaired !== true) sm.everPaired = false;
    if (sm.installMode !== 'merge' && sm.installMode !== 'overwrite') sm.installMode = null;
    if (sm.legacyHealed !== true) sm.legacyHealed = false;
    if (typeof sm.pairKey !== 'string') sm.pairKey = null;
    if (!Array.isArray(sm.outbox)) sm.outbox = [];
    if (!sm.versions || typeof sm.versions !== 'object') sm.versions = {};
    if (!sm.tombstones || typeof sm.tombstones !== 'object') sm.tombstones = {};
    if (sm.version === undefined || sm.version === null) sm.version = 0;

    /* ---- v3 → v4 迁移：默认成本口径改为「分红摊薄」 ----
       分红到账后自动降低持仓成本。只在版本号更旧时跑一次，
       之后用户手动改过的口径不会被再次覆盖。 */
    if (U.n0(state.version) < 4) {
      Object.keys(state.symbols || {}).forEach(function (sym) {
        var rec = state.symbols[sym];
        if (rec) rec.costMethod = DEFAULT_COST_METHOD;
      });
      state.version = DATA_VERSION;
    }
    if (!Array.isArray(state.settings.heroMetrics) || !state.settings.heroMetrics.length) {
      state.settings.heroMetrics = HERO_METRICS.map(function (m) { return m.key; });
    }
    /* 深色卡「测算带」：首次启动借「展望未来」的定投与年数当起点，之后两者完全独立。
       yieldPct 留 null = 跟随当前组合市值息率（用户手改后落成数字，不再浮动）。 */
    if (!state.settings.heroForecast || typeof state.settings.heroForecast !== 'object') {
      var pf = state.projection || {};
      var mi = U.n0(pf.monthlyInvest);
      state.settings.heroForecast = {
        annualInvest: mi > 0 ? mi * 12 : 60000,
        yieldPct: null,
        years: U.clamp(Math.round(U.n0(pf.years) || 10), 1, 50),
        reinvestPct: 100,               // 默认 100% 再投（与 FORECAST.reinvestDefaultPct 一致）
        solveFor: 'years',
      };
    }
    if (!state.settings.defaultDividendBasis) {
      state.settings.defaultDividendBasis = { type: 'years', value: 1 };
    }
    if (!state.settings.ocr || typeof state.settings.ocr !== 'object') {
      state.settings.ocr = { apiKey: DEFAULT_OCR_KEY, model: 'glm-4v-flash', agreed: false, lastUsedAt: null };
    }
    if (!state.settings.ocr.model) state.settings.ocr.model = 'glm-4v-flash';
    if (!state.settings.ocr.apiKey) state.settings.ocr.apiKey = DEFAULT_OCR_KEY;
    if (!Array.isArray(state.settings.unsupportedDividend)) state.settings.unsupportedDividend = [];

    /* ---- v6：settings.fire 补齐（只补容器、不动数据；跑两遍结果全等） ---- */
    var fire = state.settings.fire;
    if (!fire || typeof fire !== 'object') fire = state.settings.fire = {};
    if (fire.yieldBasis !== 'cost') fire.yieldBasis = 'market';
    if (fire.activeTier !== 'lean' && fire.activeTier !== 'fat') fire.activeTier = 'regular';
    if (!fire.tierSims || typeof fire.tierSims !== 'object') fire.tierSims = {};
    ['lean', 'regular', 'fat'].forEach(function (t) {
      var s = fire.tierSims[t];
      if (!s || typeof s !== 'object') s = fire.tierSims[t] = {};
      if (s.monthlySpend !== null && !isFinite(s.monthlySpend)) s.monthlySpend = null;
      if (s.drip !== null && !isFinite(s.drip)) s.drip = 5000;
      if (s.dripYieldPct !== null && !isFinite(s.dripYieldPct)) s.dripYieldPct = null;
    });
    if (!isFinite(fire.reinvestPct)) fire.reinvestPct = 100;
    if (!Array.isArray(fire.scenes)) fire.scenes = [];
    fire.scenes = fire.scenes.filter(function (sc) {
      return sc && typeof sc === 'object' && sc.sceneId;
    });

    /* ---- v6 版本号推进（category 归一已在上面无版本门地完成） ---- */
    if (U.n0(state.version) < 6) state.version = DATA_VERSION;
    return state;
  }

  /** 判断用户的支出项是否还是 v1/v2 的默认值（即从未改过） */
  function isUntouchedLegacy(list) {
    if (!Array.isArray(list) || list.length !== LEGACY_EXPENSE_TEMPLATE.length) return false;
    var byKey = {};
    list.forEach(function (e) { byKey[e.key] = e; });
    return LEGACY_EXPENSE_TEMPLATE.every(function (t) {
      var e = byKey[t.key];
      return !!e && e.label === t.label && U.n0(e.monthlyAmount) === t.monthlyAmount && e.enabled !== false;
    });
  }

  /* ---- 证券记录工厂 ----
   * 所有创建 symbols[sym] 的地方都必须走这里：**成本口径要跟着记录一起落库**。
   * 早先有 8 处各自手写对象、都没写 costMethod，于是那些标的（尤其 OCR 导入与交易录入建的仓）
   * 落到 calc 的兜底「加权平均」上 —— 分红就不会摊薄成本，用户看到的就是「成本不自动下降」。 */
  function symbolRecord(symbol, extra) {
    var rec = {
      symbol: symbol,
      code: XJ.market.codeOf(symbol),
      market: XJ.market.marketOf(symbol),
      name: '',
      type: 'STOCK',
      costMethod: DEFAULT_COST_METHOD,     // 默认「分红摊薄」：分红到账后成本自动下降
      updatedAt: U.nowStamp(),
    };
    if (extra) Object.assign(rec, extra);
    return rec;
  }

  /* ---- 校验 ---- */
  /**
   * 交易记录分三类：
   *   BUY / SELL —— 有数量、价格、手续费
   *   ADJUST     —— 「成本调整」：只带一个 signed 的 amount，加减成本基础而**不改股数**。
   *                 存在的意义：用户发现录错的成本时，只靠买卖无法在不改变股数的前提下修正成本，
   *                 于是就记一笔调整，持仓依然由「交易 + 调整」单一推导，不另存持仓表。
   */
  function validateTransaction(t) {
    var errs = [];
    if (!t.accountId) errs.push('缺少账户');
    if (!t.symbol || !SYMBOL_RE.test(t.symbol)) errs.push('证券代码格式不正确');
    if (t.action !== 'BUY' && t.action !== 'SELL' && t.action !== 'ADJUST') errs.push('交易方向不正确');
    if (!U.parseYmd(t.date)) errs.push('日期格式应为 YYYY-MM-DD');
    if (t.action === 'ADJUST') {
      if (!U.num(t.amount)) errs.push('成本调整金额不能为 0');
      return errs;
    }
    if (!(U.num(t.quantity) > 0)) errs.push('数量必须大于 0');
    if (U.num(t.price) === null || U.num(t.price) < 0) errs.push('价格不能为负（送股请填 0）');
    if (U.num(t.fee) === null || U.num(t.fee) < 0) errs.push('手续费不能为负');
    return errs;
  }

  function validateAccount(a) {
    var errs = [];
    if (!a.name || !String(a.name).trim()) errs.push('账户名称不能为空');
    return errs;
  }

  /* ---- 序列化 ---- */
  /** 一个「干净的」syncMeta：导出与搬运共用。
   *  ★ token（= 同步钥匙）与 gistId（= 数据位置）绝不上路 —— 备份文件会被转发/上传；
   *  ★ deviceId / versions / tombstones / outbox / etag 是本机状态，导出无意义且会互相污染；
   *  ★ enabled 一律置回关闭：换台设备导入别人的备份不该自动开始外发请求。 */
  function emptySyncMeta() {
    return {
      deviceId: null, enabled: false, token: null, gistId: null,
      version: 0, etag: null, lastOkAt: null, failSince: null, lastErr: null,
      everPaired: false, installMode: null, pairKey: null, legacyHealed: false,
      tokenScopes: null,
      outbox: [], versions: {}, tombstones: {},
    };
  }

  /** 只认这些字段：本机加载时用来还原同步状态。
   *  ★ 白名单而不是「整份拷贝」：老版本可能留下已废弃的脏字段，
   *    照单全收会把它们带回内存，再落盘扩散。
   *  ★ tombstones 一律从空开始 —— 墓碑是「删除凭证」，
   *    重建会误删云端数据；空墓碑只会让「合并」多留一条，方向是安全的。 */
  var SYNC_META_KEYS = [
    'deviceId', 'enabled', 'token', 'gistId', 'version', 'etag',
    'lastOkAt', 'failSince', 'lastErr', 'everPaired', 'installMode',
    'pairKey', 'legacyHealed', 'tokenScopes', 'forcePull', 'outbox', 'versions',
  ];

  /** 按白名单还原 syncMeta（本机自加载专用；导入别人的备份【绝不】走这里） */
  function normalizeSyncMeta(raw) {
    var out = emptySyncMeta();
    var src = raw || {};
    for (var i = 0; i < SYNC_META_KEYS.length; i++) {
      var k = SYNC_META_KEYS[i];
      if (src[k] === undefined) continue;
      out[k] = src[k];
    }
    if (out.enabled !== true) out.enabled = false;
    if (out.everPaired !== true) out.everPaired = false;
    if (out.installMode !== 'merge' && out.installMode !== 'overwrite') out.installMode = null;
    if (out.legacyHealed !== true) out.legacyHealed = false;
    if (out.forcePull !== true) out.forcePull = false;
    if (typeof out.pairKey !== 'string') out.pairKey = null;
    /* ★ token / gistId 只做「去空白后是不是空」的判断，【不做长度或格式校验】。
       踩过：这里原本要求非空字符串，但顺手写成「太短就当没有」的近似校验，
       于是任何短令牌（测试用的假令牌、或将来 GitHub 改格式）会在启动时被清掉 ——
       而 enabled 还留在 true，界面就变成「开关是开的、令牌没了」，同步静默停摆。
       令牌的合法性交给 GitHub 去判断，本机只负责「原样保存、如实呈现」。 */
    if (typeof out.token === 'string') { out.token = out.token.trim(); if (!out.token) out.token = null; }
    else out.token = null;
    if (typeof out.gistId === 'string') { out.gistId = out.gistId.trim(); if (!out.gistId) out.gistId = null; }
    else out.gistId = null;
    if (typeof out.deviceId !== 'string' || !out.deviceId) out.deviceId = null;
    if (!Array.isArray(out.outbox)) out.outbox = [];
    if (!out.versions || typeof out.versions !== 'object') out.versions = {};
    return out;
  }

  function toExport(state, note) {
    return {
      app: '自由',
      version: DATA_VERSION,
      exportedAt: U.nowStamp(),
      note: note || '',
      accounts: state.accounts,
      symbols: state.symbols,
      transactions: state.transactions,
      plans: state.plans,
      received: state.received,
      expenses: state.expenses,
      projection: state.projection,
      settings: (function () {
        var s = Object.assign({}, state.settings);
        delete s.lastQuoteAt;
        /* 备份文件可能被转发/上传，绝不带上 OCR API Key —— 与「跨设备搬运」口径一致。
           导入后 key 会回落为内置默认值（部署版为空，需自行在设置里填一次）。 */
        if (s.ocr && typeof s.ocr === 'object') {
          s.ocr = Object.assign({}, s.ocr);
          delete s.ocr.apiKey;
        }
        return s;
      })(),
      quoteCache: state.quoteCache,
      priceHistory: state.priceHistory,
      indexHistory: state.indexHistory,
      klineCache: state.klineCache,
      /* 股息率曲线的收盘价与余额宝基准：都是要跑网络才拿得到的历史数据，
         换设备后重新拉一遍很慢，所以随备份一起带走。 */
      yieldHistory: state.yieldHistory,
      benchHistory: state.benchHistory,
      /* minuteCache 不进导出 JSON：它是「当天分时」这种当天有效的运行时缓存，
         换台设备 / 隔几天再用都没意义，导出只会白白撑大备份文件。 */
      /* 同步元数据：只带一个空壳占位，绝不含 token / gistId / deviceId / 修订账本 */
      syncMeta: emptySyncMeta(),
    };
  }

  /** 宽松导入：字段缺失用默认值兜底，未知字段忽略。
   *  ★ opts.keepSync === true 时保留 raw.syncMeta（按白名单还原）——
   *    这是【本机存档自加载】专用；导入别人的备份必须走默认值（不带对方的令牌）。 */
  function fromImport(raw, opts) {
    if (!raw || typeof raw !== 'object') throw new Error('文件内容不是有效的 JSON 对象');
    var keepSync = !!(opts && opts.keepSync === true);
    var base = defaultState();
    var out = base;

    if (Array.isArray(raw.accounts)) out.accounts = raw.accounts.filter(function (a) { return a && a.accountId; });
    if (raw.symbols && typeof raw.symbols === 'object') out.symbols = raw.symbols;
    if (Array.isArray(raw.transactions)) out.transactions = raw.transactions.filter(function (t) { return t && t.txId; });
    if (raw.plans && typeof raw.plans === 'object') out.plans = raw.plans;
    if (Array.isArray(raw.received)) out.received = raw.received.filter(function (r) { return r && r.recId; });
    if (Array.isArray(raw.expenses) && raw.expenses.length) out.expenses = raw.expenses;
    if (raw.projection && typeof raw.projection === 'object') out.projection = Object.assign(out.projection, raw.projection);
    if (raw.settings && typeof raw.settings === 'object') out.settings = Object.assign(out.settings, raw.settings);
    if (raw.quoteCache && typeof raw.quoteCache === 'object') out.quoteCache = raw.quoteCache;
    if (raw.priceHistory && typeof raw.priceHistory === 'object') out.priceHistory = raw.priceHistory;
    if (raw.indexHistory && typeof raw.indexHistory === 'object') out.indexHistory = raw.indexHistory;
    if (raw.klineCache && typeof raw.klineCache === 'object') out.klineCache = raw.klineCache;
    if (raw.yieldHistory && typeof raw.yieldHistory === 'object') out.yieldHistory = raw.yieldHistory;
    if (raw.benchHistory && typeof raw.benchHistory === 'object') out.benchHistory = raw.benchHistory;
    /* minuteCache 刻意不在白名单内：导入后为 null，下次刷新行情时自动重建当天分时 */
    /* syncMeta 默认【不认】：导入的备份不带同步连接信息，
       out.syncMeta 保持 defaultState() 里的初始值（关闭 + 无 token）。
       只有本机存档自加载（opts.keepSync）才按白名单还原它。 */
    out.syncMeta = keepSync ? normalizeSyncMeta(raw.syncMeta) : emptySyncMeta();
    if (raw.version) out.version = raw.version;

    return ensureBootstrapped(out);
  }

  /* ---- CSV 导出 ---- */
  function csvCell(v) {
    var s = v === null || v === undefined ? '' : String(v);
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function toCsv(rows) {
    return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
  }

  function transactionsCsv(state) {
    var nameOf = function (sym) {
      var s = state.symbols[sym];
      return s ? s.name : '';
    };
    var accName = function (id) {
      var a = state.accounts.filter(function (x) { return x.accountId === id; })[0];
      return a ? a.name : '';
    };
    var rows = [['账户', '证券代码', '证券名称', '方向', '日期', '数量', '价格', '手续费', '金额', '备注']];
    state.transactions
      .slice()
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; })
      .forEach(function (t) {
        var isAdj = t.action === 'ADJUST';
        var amt = isAdj ? U.n0(t.amount) : U.n0(t.quantity) * U.n0(t.price);
        rows.push([
          accName(t.accountId), t.symbol, nameOf(t.symbol),
          isAdj ? '成本调整' : (t.action === 'BUY' ? '买入' : '卖出'), t.date,
          isAdj ? '' : t.quantity, isAdj ? '' : t.price, isAdj ? '' : U.n0(t.fee),
          amt.toFixed(2), t.note || '',
        ]);
      });
    return toCsv(rows);
  }

  function receivedCsv(state) {
    var nameOf = function (sym) { var s = state.symbols[sym]; return s ? s.name : ''; };
    var rows = [['到账日期', '年度', '证券代码', '证券名称', '每股分红(税前)', '登记数量', '到账金额', '来源']];
    state.received
      .slice()
      .sort(function (a, b) { return a.exDividendDate < b.exDividendDate ? -1 : 1; })
      .forEach(function (r) {
        rows.push([
          r.exDividendDate, r.year, r.symbol, nameOf(r.symbol),
          r.perShareAmount, r.qtyAtRecord, U.n0(r.amount).toFixed(2),
          r.source === 'AUTO' ? '自动' : '手动',
        ]);
      });
    return toCsv(rows);
  }

  return {
    DATA_VERSION: DATA_VERSION,
    DEFAULT_COST_METHOD: DEFAULT_COST_METHOD,
    EXPENSE_TEMPLATE: EXPENSE_TEMPLATE,
    LEGACY_EXPENSE_TEMPLATE: LEGACY_EXPENSE_TEMPLATE,
    HERO_METRICS: HERO_METRICS,
    EMOJI_GROUPS: EMOJI_GROUPS,
    KEY_EMOJI: KEY_EMOJI,
    DEFAULT_OCR_KEY: DEFAULT_OCR_KEY,
    makeExpenses: makeExpenses,
    SYMBOL_RE: SYMBOL_RE,
    normalizeSymbol: normalizeSymbol,
    marketPrefix: marketPrefix,
    codeOf: codeOf, marketOf: marketOf, marketLabel: marketLabel,
    currencyOf: currencyOf, marketKind: marketKind,
    defaultState: defaultState,
    ensureBootstrapped: ensureBootstrapped,
    symbolRecord: symbolRecord,
    validateTransaction: validateTransaction,
    validateAccount: validateAccount,
    toExport: toExport, fromImport: fromImport,
    emptySyncMeta: emptySyncMeta,
    normCloseSeries: normCloseSeries,
    transactionsCsv: transactionsCsv, receivedCsv: receivedCsv,
  };
})();
