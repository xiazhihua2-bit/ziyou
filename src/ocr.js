/* ==================== 截图识别（智谱 GLM-4V 多模态） ====================
 * 直连智谱开放平台 https://open.bigmodel.cn/api/paas/v4/chat/completions
 *
 * 实测结论（2026-09-10）：
 *   · file:// 页面下 **CORS 放行**（origin=file:// 也能直接 fetch），无需任何后端
 *   · glm-4v-flash（免费）识别持仓数字完全准确，约 5s
 *   · glm-4.1v-thinking-flash（免费）带推理，适合复杂版式，但需关闭思考否则会占满 max_tokens
 *
 * 隐私提示：截图会上传到智谱服务器。界面在首次使用时明确告知。
 */
XJ.ocr = (function () {
  var U = XJ.util;

  var ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
  var DEFAULT_MODEL = 'glm-4v-flash';

  var MODELS = [
    { key: 'glm-4v-flash', label: 'GLM-4V-Flash', maxTokens: 1024,
      note: '免费 · 快（约 5 秒）· 数字识别准，推荐（上限 1024 tokens）' },
    { key: 'glm-4.1v-thinking-flash', label: 'GLM-4.1V-Thinking-Flash', maxTokens: 2048,
      note: '免费 · 带推理，适合复杂版式（较慢；已自动关闭思考）' },
    { key: 'glm-4v-plus', label: 'GLM-4V-Plus', maxTokens: 2048,
      note: '付费 · 识别率最高' },
  ];

  function maxTokensOf(model) {
    var m = MODELS.filter(function (x) { return x.key === model; })[0];
    return (m && m.maxTokens) || 1024;
  }

  /* 交易记录提示词：与「持仓概览」不同，这张图里没有持仓数量与成本，只有逐笔成交 */
  var TRADE_PROMPT = [
    '这是券商App的「交易记录」/「成交记录」列表截图（通常页头有股票名称与代码）。',
    '请提取**该股票的身份**与**图中所有交易记录**，只输出一个 JSON 对象，不要解释文字，不要 Markdown 代码块。',
    '格式：',
    '{"name":"股票名称","code":"股票代码","trades":[{"date":"2026-08-28","action":"买入","price":16.950,"quantity":200,"amount":3390.00,"fee":0.38}]}',
    '规则：',
    '1. date 统一为 YYYY-MM-DD；图中只有 08-28 这类省略年份的写法时，补上当前年份',
    '2. action 归一化为三种：买入 / 卖出 / 分红（原图可能写「证券买入」「买」「卖」「股息入账」「利息归本」等）',
    '3. price / quantity / amount / fee 必须原样保留小数点，去掉 ¥ 与千分位逗号；图中没有的字段填 null',
    '3b. **数量与金额一律填正数**：券商流水里卖出的负号（如 -200 股 / -3390.00 元）只是方向标记，',
    '    请去掉负号，方向完全由 action 字段表达。这一条非常重要，漏掉会导致卖出记录丢失。',
    '4. 「分红」「股息」「利息」这类行 action 填「分红」，amount 填到账金额，price 与 quantity 填 null',
    '5. 「送股」「转增」「红股」按 action「买入」且 price 填 0',
    '6. **买入与卖出都必须提取，一条都不能漏**；也不要把「浮动盈亏」「当日参考盈亏」「持仓天数」「个股仓位」「分红收益」这类汇总数字当成交易',
    '7. 第一个字符必须是 {',
  ].join('\n');

  var CLASSIFY_PROMPT = [
    '这张券商App截图属于哪种？只回答一个词，不要输出任何其它内容：',
    '如果是「多条买卖交易记录列表」（每条记录含价格 / 数量 / 金额），回答 TRADE',
    '如果是「持仓列表」或「个股持仓概览」（含持仓数量与成本），回答 HOLDING',
  ].join('\n');

  /* 提示词经过实测调优：
     · 必须显式要求「保留小数点」，否则 glm-4v-flash 会把 23.9950 读成 239950
     · 必须显式列出字段的中文标签，否则容易把「市值/浮动盈亏」误当作成本或数量 */
  var PROMPT = [
    '这是券商App的持仓列表或个股详情截图，请提取图中所有股票持仓。',
    '只输出一个 JSON 数组，不要解释文字，不要 Markdown 代码块，第一个字符必须是 [ 。',
    '元素格式：{"name":"名称","code":"代码","quantity":持股数,"cost":成本价,"price":现价}',
    '数值规则（重要）：',
    '- 必须原样保留小数点。图中写 23.9950 就输出 23.9950，写 23.89 就输出 23.89',
    '- 只可去掉货币符号(¥ $)与千分位逗号，绝对不要去掉小数点',
    '- 识别不到就填 null，不要猜测或编造',
    '字段规则：',
    '- name 与 code 通常在页面标题栏或列表行首；code 为纯代码：A股/ETF 6 位数字，港股 5 位数字，美股字母如 AAPL',
    '- quantity 是持股数量（不是可用数量、不是市值）',
    '- cost 是每股成本（标签通常是「成本」「摊薄成本」「持仓成本」）',
    '- price 是当前每股价格（标签通常是「现价」「最新价」「收盘价」）',
    '- 若截图只有一只股票，也返回只含一个元素的数组',
  ].join('\n');

  /* ---------------- 图片预处理：等比缩到 1280 宽并转 JPEG，减小请求体 ---------------- */
  function fileToDataUrl(file, maxW) {
    maxW = maxW || 1280;
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onerror = function () { reject(new Error('文件读取失败')); };
      fr.onload = function () {
        var raw = String(fr.result);
        var img = new Image();
        img.onerror = function () {
          // 极端情况下（如 HEIC）直接回退原图，交给模型处理
          resolve(raw);
        };
        img.onload = function () {
          try {
            var scale = Math.min(1, maxW / (img.width || maxW));
            var w = Math.max(1, Math.round((img.width || maxW) * scale));
            var h = Math.max(1, Math.round((img.height || maxW) * scale));
            var cv = document.createElement('canvas');
            cv.width = w; cv.height = h;
            var ctx = cv.getContext('2d');
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            resolve(cv.toDataURL('image/jpeg', 0.9));
          } catch (e) {
            resolve(raw);
          }
        };
        img.src = raw;
      };
      fr.readAsDataURL(file);
    });
  }

  /* ---------------- 从模型输出里稳健地抠出 JSON ---------------- */
  function extractJson(text) {
    var s = String(text || '');
    s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();   // 去思考过程
    s = s.replace(/<\|[^|]*\|>/g, '').trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();

    var a = s.indexOf('['), b = s.lastIndexOf(']');
    if (a >= 0 && b > a) {
      s = s.slice(a, b + 1);
    } else {
      var oa = s.indexOf('{'), ob = s.lastIndexOf('}');
      if (oa < 0 || ob <= oa) throw new Error('模型未返回可解析的 JSON：' + s.slice(0, 140));
      s = '[' + s.slice(oa, ob + 1) + ']';
    }

    var arr;
    try {
      arr = JSON.parse(s);
    } catch (e1) {
      try {
        arr = JSON.parse(s.replace(/,\s*([\]}])/g, '$1').replace(/([{,]\s*)([A-Za-z_\u4e00-\u9fa5]+)\s*:/g, '$1"$2":'));
      } catch (e2) {
        throw new Error('JSON 解析失败：' + s.slice(0, 140));
      }
    }
    if (!Array.isArray(arr)) arr = [arr];

    var out = [];
    arr.forEach(function (r) {
      var n = normalizeRow(r);
      if (!n) return;
      // 只要有任何一项可用信息就保留：模型读不到名称/代码时，用户可以在「核对」里补
      var meaningful = n.code || n.name ||
        (n.quantity !== null && (n.cost !== null || n.price !== null));
      if (meaningful) out.push(n);
    });
    return out;
  }

  function toNum(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
    return isNaN(n) ? null : n;
  }

  function pick(r, keys) {
    for (var i = 0; i < keys.length; i++) {
      if (r[keys[i]] !== undefined && r[keys[i]] !== null && r[keys[i]] !== '') return r[keys[i]];
    }
    return null;
  }

  /** 兼容模型返回中文键名或英文字段 */
  function normalizeRow(r) {
    if (!r || typeof r !== 'object') return null;
    var name = String(pick(r, ['name', '股票名称', '名称', 'stock_name']) || '').trim();
    var codeRaw = String(pick(r, ['code', '股票代码', '代码', 'symbol', 'ticker']) || '').trim();
    var code = codeRaw.replace(/[^0-9A-Za-z]/g, '') || null;
    return {
      name: name,
      code: code,
      quantity: toNum(pick(r, ['quantity', '持仓数量', '数量', '持股数量', '股数', 'shares'])),
      cost: toNum(pick(r, ['cost', '成本价', '成本', '持仓成本', '摊薄成本'])),
      price: toNum(pick(r, ['price', '现价', '当前价', '市价', '最新价'])),
    };
  }

  /* ---------------- 调用模型（返回原始文本） ---------------- */
  function callModel(dataUrl, opts) {
    opts = opts || {};
    var key = opts.apiKey;
    if (!key) return Promise.reject(new Error('未配置智谱 API Key'));

    var model = opts.model || DEFAULT_MODEL;
    var body = {
      model: model,
      temperature: opts.temperature === undefined ? 0.05 : opts.temperature,
      max_tokens: opts.maxTokens || maxTokensOf(model),
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: opts.prompt || PROMPT },
        ],
      }],
    };
    if (/thinking/i.test(model)) body.thinking = { type: 'disabled' };

    return fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) { /* 下面统一报错 */ }
        if (!j) throw new Error('接口返回非 JSON（HTTP ' + r.status + '）：' + t.slice(0, 120));
        if (!r.ok) {
          var msg = (j.error && (j.error.message || j.error.code)) || j.message || ('HTTP ' + r.status);
          if (r.status === 401 || /invalid.*api.*key|认证失败/i.test(String(msg))) {
            throw new Error('API Key 无效或已过期，请在「我的 · 截图识别设置」中更新');
          }
          throw new Error('识别失败：' + msg);
        }
        var c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        if (!c) throw new Error('模型没有返回内容');
        return { content: c, usage: j.usage || null };
      });
    }).catch(function (e) {
      if (e && e.name === 'TypeError') throw new Error('网络请求失败（可能是断网或浏览器拦截了跨域请求）');
      throw e;
    });
  }

  /* ---------------- 识别持仓概览 ---------------- */
  function recognize(dataUrl, opts) {
    return callModel(dataUrl, opts).then(function (res) {
      var rows = extractJson(res.content);
      rows.usage = res.usage;
      return rows;
    });
  }

  /* ---------------- 识别交易记录 ---------------- */
  /* 顺序即优先级：先判卖出，再判买入（含送股/转增/红股），最后才判分红。
     注意不要把「入账」当成分红特征 —— 「红股入账」是送股（买入，价格 0）。 */
  var ACT_MAP = [
    [/卖出|SELL|减仓|赎回/i, 'SELL'],
    [/红股|送股|转增|买入|BUY|建仓|加仓|申购|^买/i, 'BUY'],
    [/分红|股息|红利|派息|利息|DIV/i, 'DIV'],
  ];
  function normAction(a) {
    var s = String(a || '');
    for (var i = 0; i < ACT_MAP.length; i++) if (ACT_MAP[i][0].test(s)) return ACT_MAP[i][1];
    return 'BUY';
  }
  function normDate(d, fallbackYear) {
    var s = String(d || '').trim();
    if (!s) return null;
    s = s.replace(/[年月]/g, '-').replace(/日/g, '').replace(/[./]/g, '-').replace(/-+$/, '');
    var m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return m[1] + '-' + String(+m[2]).padStart(2, '0') + '-' + String(+m[3]).padStart(2, '0');
    m = s.match(/^(\d{1,2})-(\d{1,2})$/);
    if (m) return (fallbackYear || new Date().getFullYear()) + '-' +
      String(+m[1]).padStart(2, '0') + '-' + String(+m[2]).padStart(2, '0');
    return null;
  }
  function normalizeTradeRow(r, year) {
    if (!r || typeof r !== 'object') return null;
    var action = normAction(pick(r, ['action', 'direction', 'type', '方向', '操作', '业务名称', '摘要']));
    var date = normDate(pick(r, ['date', '日期', '成交日期', '发生日期', '交易日期']), year);
    var priceRaw = toNum(pick(r, ['price', '价格', '成交价格', '成交均价', '均价']));
    var qtyRaw = toNum(pick(r, ['quantity', '数量', '成交数量', '股数']));
    var amtRaw = toNum(pick(r, ['amount', '金额', '成交金额', '发生金额']));
    var feeRaw = toNum(pick(r, ['fee', '费用', '手续费', '佣金', '交易税费']));

    /* 券商流水常把卖出写成负数（数量 -200 / 金额 -3390）。
       ① 负号只表示方向 → 一律取绝对值存数量与金额
       ② 若模型把方向读成了「买入」但数值为负，按负数纠正为卖出 */
    var neg = (qtyRaw !== null && qtyRaw < 0) || (amtRaw !== null && amtRaw < 0);
    if (neg && action === 'BUY') action = 'SELL';

    var price = priceRaw === null ? null : Math.abs(priceRaw);
    var quantity = qtyRaw === null ? null : Math.abs(qtyRaw);
    var amount = amtRaw === null ? null : Math.abs(amtRaw);
    var fee = feeRaw === null ? null : Math.abs(feeRaw);

    if (!date && price === null && quantity === null && amount === null) return null;
    if (action === 'DIV') { price = null; quantity = null; }
    return { date: date, action: action, price: price, quantity: quantity, amount: amount, fee: fee };
  }

  function cleanText(text) {
    var s = String(text || '');
    s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    s = s.replace(/<\|[^|]*\|>/g, '').trim();
    return s.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  }

  function extractTradeJson(text) {
    var s = cleanText(text);
    var year = new Date().getFullYear();
    var obj = null;
    var oa = s.indexOf('{'), ob = s.lastIndexOf('}');
    if (oa >= 0 && ob > oa) {
      try { obj = JSON.parse(s.slice(oa, ob + 1)); } catch (e1) { obj = null; }
    }
    var arr = [], name = '', code = '';
    if (obj && (obj.trades || obj.records || obj.list || obj.items)) {
      name = String(obj.name || obj['名称'] || obj.stockName || obj['股票名称'] || '').trim();
      code = String(obj.code || obj['代码'] || obj.stockCode || obj['股票代码'] || '').replace(/[^0-9A-Za-z]/g, '');
      arr = obj.trades || obj.records || obj.list || obj.items;
    } else {
      var a = s.indexOf('['), b = s.lastIndexOf(']');
      if (a < 0 || b <= a) throw new Error('模型未返回可解析的 JSON：' + s.slice(0, 140));
      try { arr = JSON.parse(s.slice(a, b + 1)); } catch (e2) {
        throw new Error('JSON 解析失败：' + s.slice(0, 140));
      }
    }
    if (!Array.isArray(arr)) arr = [arr];
    var rows = [];
    arr.forEach(function (r) { var n = normalizeTradeRow(r, year); if (n) rows.push(n); });
    return {
      name: name, code: code, trades: rows,
      symbol: code ? (XJ.market.normalize(code) || null) : null,
    };
  }

  function recognizeTrades(dataUrl, opts) {
    return callModel(dataUrl, Object.assign({}, opts, { prompt: TRADE_PROMPT })).then(function (res) {
      var out = extractTradeJson(res.content);
      out.usage = res.usage;
      return out;
    });
  }

  /* ---------------- 截图类型判断（一次轻量调用） ---------------- */
  function classify(dataUrl, opts) {
    opts = opts || {};
    if (!opts.apiKey) return Promise.resolve('holding');
    return callModel(dataUrl, {
      apiKey: opts.apiKey, model: opts.model,
      prompt: CLASSIFY_PROMPT, temperature: 0, maxTokens: 8,
    }).then(function (res) {
      return /TRADE/i.test(res.content) ? 'trade' : 'holding';
    }).catch(function () { return 'holding'; });
  }

  /**
   * 自动识别：先判断截图类型，再用对应提示词识别。
   *   holding → 输出持仓行数组（带 model / score 附加属性）
   *   trade   → 输出 { name, code, symbol, trades:[] }
   * 结果质量不足时自动换用更强的模型重试一次。
   */
  function recognizeAuto(dataUrl, opts) {
    opts = opts || {};
    var forced = opts.kind;                       // 'holding' | 'trade' | undefined(自动)
    return (forced ? Promise.resolve(forced) : classify(dataUrl, opts)).then(function (kind) {
      var run = function (model) {
        return kind === 'trade'
          ? recognizeTrades(dataUrl, { apiKey: opts.apiKey, model: model })
          : recognize(dataUrl, { apiKey: opts.apiKey, model: model });
      };
      var score = function (res) {
        return kind === 'trade' ? scoreTrades(res.trades) : scoreRows(res);
      };
      return run(opts.model || DEFAULT_MODEL).then(function (res) {
        if (score(res) >= GOOD_ENOUGH || !opts.apiKey || (opts.model || DEFAULT_MODEL) === FALLBACK_MODEL) {
          res.kind = kind; res.model = opts.model || DEFAULT_MODEL; res.retried = false;
          return res;
        }
        return run(FALLBACK_MODEL).then(function (res2) {
          var best = score(res2) > score(res) ? res2 : res;
          best.kind = kind; best.model = best === res2 ? FALLBACK_MODEL : (opts.model || DEFAULT_MODEL);
          best.retried = true;
          return best;
        }).catch(function () {
          res.kind = kind; res.model = opts.model || DEFAULT_MODEL; res.retried = false;
          return res;
        });
      }).catch(function (e) {
        e.kind = kind;
        throw e;
      });
    });
  }

  /** 交易记录的完整度：date / action / (price|amount) / quantity（分红行不要 quantity） */
  function scoreTrades(trades) {
    if (!trades || !trades.length) return 0;
    var total = 0, filled = 0;
    trades.forEach(function (t) {
      total += 4;
      if (t.date) filled++;
      if (t.action) filled++;
      if (t.price !== null || t.amount !== null) filled++;
      if (t.action === 'DIV' || (t.quantity !== null && t.quantity > 0)) filled++;
    });
    return total ? filled / total : 0;
  }

  /**
   * 双模型兜底：先用主模型（快、免费）识别；若关键字段完整度不足，
   * 自动用更强的模型重试一次，取两者中更完整的那份结果。
   * 解决"识别出了名称与代码，但数量与成本全缺失"这类漏读。
   */
  var FALLBACK_MODEL = 'glm-4.1v-thinking-flash';
  var GOOD_ENOUGH = 0.85;

  /** 关键字段完整度（0~1）：code / quantity / cost 三项 */
  function scoreRows(rows) {
    if (!rows || !rows.length) return 0;
    var total = 0, filled = 0;
    rows.forEach(function (r) {
      total += 3;
      if (r.code) filled++;
      if (r.quantity !== null && r.quantity > 0) filled++;
      if (r.cost !== null) filled++;
    });
    return total ? filled / total : 0;
  }

  function recognizeWithFallback(dataUrl, opts) {
    opts = opts || {};
    var primary = opts.model || DEFAULT_MODEL;
    var fallback = opts.fallbackModel || FALLBACK_MODEL;
    var tried = [];

    function attempt(model) {
      return recognize(dataUrl, { apiKey: opts.apiKey, model: model, prompt: opts.prompt })
        .then(function (rows) {
          tried.push({ model: model, rows: rows, score: scoreRows(rows) });
          return rows;
        });
    }

    return attempt(primary).then(function (first) {
      var s1 = scoreRows(first);
      if (s1 >= GOOD_ENOUGH || !opts.apiKey || primary === fallback) {
        if (first && first.length) { first.model = primary; first.score = s1; }
        return first;
      }
      return attempt(fallback).then(function () {
        var best = tried.slice().sort(function (a, b) { return b.score - a.score; })[0];
        var rows = (best && best.rows && best.rows.length) ? best.rows : first;
        if (rows) { rows.model = best ? best.model : primary; rows.score = best ? best.score : s1; rows.retried = true; }
        return rows;
      }).catch(function () {
        if (first) { first.model = primary; first.score = s1; }
        return first;
      });
    });
  }

  /**
   * 解析最终要写入的 symbol。
   * **输入框优先** —— 它是用户屏幕上看到的真源；只有输入框为空时才回退到草稿里的值。
   * （历史 bug：草稿优先导致用户手改代码不生效，中远海控被写成了保利发展）
   */
  function resolveSymbol(typedCode, draftSymbol) {
    var code = String(typedCode || '').replace(/[^0-9A-Za-z]/g, '');
    if (code) return XJ.market.normalize(code) || null;
    return draftSymbol || null;
  }

  /**
   * 多张截图分批识别时，判断新结果是否换了另一只股票。
   * 换了股票但新图没给出代码 → 旧的代码必须作废，否则会张冠李戴。
   */
  function mergeTradeIdentity(cur, res) {
    var next = { name: cur.name || '', symbol: cur.symbol || null };
    var nameChanged = !!(res.name && cur.name && res.name !== cur.name);
    if (res.symbol) next.symbol = res.symbol;
    else if (nameChanged) next.symbol = null;
    if (res.name) next.name = res.name;
    return next;
  }

  return {
    ENDPOINT: ENDPOINT,
    resolveSymbol: resolveSymbol,
    mergeTradeIdentity: mergeTradeIdentity,
    DEFAULT_MODEL: DEFAULT_MODEL,
    FALLBACK_MODEL: FALLBACK_MODEL,
    GOOD_ENOUGH: GOOD_ENOUGH,
    scoreRows: scoreRows,
    scoreTrades: scoreTrades,
    recognizeWithFallback: recognizeWithFallback,
    recognizeAuto: recognizeAuto,
    recognizeTrades: recognizeTrades,
    extractTradeJson: extractTradeJson,
    normalizeTradeRow: normalizeTradeRow,
    normAction: normAction,
    normDate: normDate,
    classify: classify,
    callModel: callModel,
    TRADE_PROMPT: TRADE_PROMPT,
    CLASSIFY_PROMPT: CLASSIFY_PROMPT,
    MODELS: MODELS,
    maxTokensOf: maxTokensOf,
    PROMPT: PROMPT,
    fileToDataUrl: fileToDataUrl,
    extractJson: extractJson,
    normalizeRow: normalizeRow,
    recognize: recognize,
  };
})();
