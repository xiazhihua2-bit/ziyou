/* ==================== 视图：我的（数据管理 / 账户 / 设置） ==================== */
XJ.views.mine = (function () {
  var U = XJ.util, UI = XJ.ui;

  function renderAccounts() {
    var st = XJ.store;
    var list = st.accounts();
    var counts = {};
    st.state.transactions.forEach(function (t) {
      counts[t.accountId] = (counts[t.accountId] || 0) + 1;
    });

    var html = '<div class="card flush">' +
      '<div style="padding:14px 16px 10px"><div class="card-head" style="margin:0"><h2>账户管理</h2>' +
      '<div class="spacer"></div><span class="hint">' + list.length + ' 个</span></div></div>';
    html += list.map(function (a) {
      return '<button class="list-row" data-act="openAccountEditor" data-id="' + U.esc(a.accountId) + '">' +
        '<div class="row-main">' +
        '<div class="row-t">' + U.esc(a.name) +
        (a.accountId === st.state.settings.defaultAccountId ? '<span class="pill blue">默认</span>' : '') +
        '</div>' +
        '<div class="row-s">' + U.esc({ BROKER: '券商账户', FAMILY: '家人账户', OTHER: '其他' }[a.type] || '其他') +
        ' · ' + (counts[a.accountId] || 0) + ' 笔交易</div>' +
        '</div>' +
        '<span class="chev">' + UI.icon('chevron', 16) + '</span>' +
        '</button>';
    }).join('');
    html += '</div>';
    html += '<div style="margin-top:10px"><button class="btn-block ghost" data-act="openAccountEditor">' +
      UI.icon('plus', 16) + ' 新建账户</button></div>';
    return html;
  }

  function renderTransactions() {
    var st = XJ.store;
    var folded = st.ui.foldMineTx !== false;      // 默认收起（最多 30 条，收起后页面清爽）
    var txs = st.state.transactions.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (b.createdAt || '') < (a.createdAt || '') ? -1 : 1;
    }).slice(0, 30);

    var html = '<div class="card flush">' +
      '<div style="padding:14px 16px 10px">' +
      '<div class="card-head" style="margin:0">' +
      '<button class="fold-head" data-act="toggleFoldMineTx">' +
      '<h2>交易流水</h2>' +
      '<span class="hint">共 ' + st.state.transactions.length + ' 笔</span>' +
      '<span class="fold-caret' + (folded ? ' folded' : '') + '">' + UI.icon('chevron', 14) + '</span>' +
      '</button>' +
      '<div class="spacer"></div>' +
      '<button class="ghost-btn" data-act="openTxEditor">' + UI.icon('plus', 14) + ' 记一笔</button>' +
      '</div></div>';
    if (!txs.length) {
      html += '<div style="padding:0 16px 16px" class="tiny">暂无交易记录。持仓由交易流水推导，添加交易即可建立持仓。</div>';
    } else if (folded) {
      html += '<div class="fold-hint">已收起，最近 ' + txs.length + ' 笔 · 点标题展开查看</div>';
    } else {
      html += txs.map(function (t) {
        var isAdj = t.action === 'ADJUST';
        var amt = isAdj ? U.n0(t.amount) : U.n0(t.quantity) * U.n0(t.price);
        return '<button class="list-row" data-act="openTxEditor" data-id="' + U.esc(t.txId) + '">' +
          '<div class="row-main">' +
          '<div class="row-t">' + U.esc(st.symbolName(t.symbol)) +
          (isAdj
            ? '<span class="pill div">成本调整</span>'
            : '<span class="pill ' + (t.action === 'BUY' ? 'up' : 'down') + '">' + (t.action === 'BUY' ? '买入' : '卖出') + '</span>') +
          '</div>' +
          '<div class="row-s">' + U.esc(XJ.market.displayCode(t.symbol)) + ' · ' + U.esc(t.date) + ' · ' +
          U.esc(st.accountName(t.accountId)) +
          (isAdj ? '' : ' · ' + U.thousands(t.quantity) + '股 @ ' + U.money(t.price, 3)) + '</div>' +
          '</div>' +
          '<div class="row-right"><div class="row-v' + (isAdj ? ' ' + U.dirClass(amt) : '') + '">' + U.signMoney(amt) + '</div>' +
          (!isAdj && U.n0(t.fee) ? '<div class="row-v2">费 ' + U.money(t.fee) + '</div>' : '') +
          '</div>' +
          '<span class="chev">' + UI.icon('chevron', 16) + '</span>' +
          '</button>';
      }).join('');
    }
    html += '</div>';
    return html;
  }

  function renderExpenses() {
    var st = XJ.store;
    var list = st.state.expenses.slice().sort(function (a, b) { return a.sortOrder - b.sortOrder; });
    var total = U.sum(list.filter(function (e) { return e.enabled; }), function (e) { return U.n0(e.monthlyAmount) * 12; });

    var html = '<div class="card flush">' +
      '<div style="padding:14px 16px 10px"><div class="card-head" style="margin:0"><h2>息覆生活 · 支出项</h2>' +
      '<div class="spacer"></div><span class="hint">' + U.moneySign(total, 0) + '/年</span></div></div>';
    html += list.map(function (e) {
      return '<button class="list-row" data-act="openExpenseEditor" data-key="' + U.esc(e.key) + '">' +
        '<div class="row-main">' +
        '<div class="row-t">' + U.esc(e.label) +
        (e.enabled ? '' : '<span class="pill gray">已停用</span>') + '</div>' +
        '<div class="row-s">' + U.moneySign(e.monthlyAmount, 0) + '/月 · ' + U.moneySign(U.n0(e.monthlyAmount) * 12, 0) + '/年</div>' +
        '</div>' +
        '<span class="chev">' + UI.icon('chevron', 16) + '</span>' +
        '</button>';
    }).join('');
    html += '</div>';
    return html;
  }

  function renderData() {
    var st = XJ.store;
    var s = XJ.calc.summary(st.state, st.acc());
    var modeLabel = XJ.storage.modeLabel();
    var lastQuote = st.state.settings.lastQuoteAt;

    var html = '<div class="card flush">' +
      '<div style="padding:14px 16px 10px"><div class="card-head" style="margin:0"><h2>数据管理</h2></div></div>';

    html += '<button class="list-row" data-act="exportJson">' +
      '<div class="row-main"><div class="row-t">' + UI.icon('download', 17) + ' 导出全部数据（JSON）</div>' +
      '<div class="row-s">含账户、持仓、交易、分红方案与到账记录，可在其他设备导入</div></div>' +
      '<span class="chev">' + UI.icon('chevron', 16) + '</span></button>';

    html += '<button class="list-row" data-act="openTransfer">' +
      '<div class="row-main"><div class="row-t">📱 跨设备搬运（手机 / 平板）</div>' +
      '<div class="row-s">生成一段文本或链接，用微信/QQ 发到另一台设备打开即可导入，不经过任何服务器</div></div>' +
      '<span class="chev">' + UI.icon('chevron', 16) + '</span></button>';

    html += '<button class="list-row" data-act="importJson">' +
      '<div class="row-main"><div class="row-t">' + UI.icon('upload', 17) + ' 导入数据（JSON）</div>' +
      '<div class="row-s">从别的设备/浏览器迁移数据</div></div>' +
      '<span class="chev">' + UI.icon('chevron', 16) + '</span></button>';

    html += '<button class="list-row" data-act="exportCsvTx">' +
      '<div class="row-main"><div class="row-t">' + UI.icon('download', 17) + ' 导出交易流水（CSV）</div>' +
      '<div class="row-s">可用 Excel 直接打开</div></div>' +
      '<span class="chev">' + UI.icon('chevron', 16) + '</span></button>';

    html += '<button class="list-row" data-act="exportCsvRec">' +
      '<div class="row-main"><div class="row-t">' + UI.icon('download', 17) + ' 导出分红台账（CSV）</div>' +
      '<div class="row-s">按到账日期排序</div></div>' +
      '<span class="chev">' + UI.icon('chevron', 16) + '</span></button>';

    html += '<button class="list-row" data-act="clearData">' +
      '<div class="row-main"><div class="row-t c-up">' + UI.icon('trash', 17) + ' 清空本地数据</div>' +
      '<div class="row-s">删除本机保存的全部记录，操作前建议先导出备份</div></div>' +
      '<span class="chev">' + UI.icon('chevron', 16) + '</span></button>';

    html += '</div>';

    html += '<div class="card">' +
      '<div class="kv"><span class="k">存储方式</span><span class="v">' + U.esc(modeLabel) + '</span></div>' +
      '<div class="kv"><span class="k">持仓标的</span><span class="v">' + s.count + ' 只</span></div>' +
      '<div class="kv"><span class="k">交易 / 到账记录</span><span class="v">' + st.state.transactions.length + ' / ' + st.state.received.length + '</span></div>' +
      '<div class="kv"><span class="k">最近行情同步</span><span class="v muted" style="font-weight:400">' +
      (lastQuote ? U.esc(String(lastQuote).slice(0, 16).replace('T', ' ')) : '尚未同步') + '</span></div>' +
      '</div>';
    return html;
  }

  function renderSettings() {
    var st = XJ.store;
    var s = st.state.settings;
    var html = '<div class="card flush">' +
      '<div style="padding:14px 16px 10px"><div class="card-head" style="margin:0"><h2>提醒与设置</h2></div></div>';
    html += '<button class="list-row" data-act="openOcrSettings">' +
      '<div class="row-main"><div class="row-t">📷 截图识别设置</div>' +
      '<div class="row-s">智谱 GLM-4V 多模态识别 · 模型与 API Key（截图会上传到智谱服务器）</div></div>' +
      '<span class="chev">' + UI.icon('chevron', 16) + '</span></button>';
    html += '<button class="list-row" data-act="openReminderSetting">' +
      '<div class="row-main"><div class="row-t">分红提前提醒</div>' +
      '<div class="row-s">在除权除息日前 ' + U.n0(s.reminderLeadDays) + ' 天提示（需保持页面打开）</div></div>' +
      '<span class="chev">' + UI.icon('chevron', 16) + '</span></button>';
    html += '<button class="list-row" data-act="openDivFunSetting">' +
      '<div class="row-main"><div class="row-t">🎁 分红换算基准</div>' +
      '<div class="row-s">「分红汇总」里「相当于 N 个月 ___」的换算对象与月费（当前 ' +
      U.esc((s.dividendFun && s.dividendFun.name) || '视频会员') + ' ¥' +
      U.thousands(U.n0(s.dividendFun && s.dividendFun.monthly)) + '/月）</div></div>' +
      '<span class="chev">' + UI.icon('chevron', 16) + '</span></button>';
    html += '<button class="list-row" data-act="refreshLogos">' +
      '<div class="row-main"><div class="row-t">🏷 重新获取公司图标</div>' +
      '<div class="row-s">清空图标缓存并重新解析（A股个股取同花顺，港股美股取官网图标）</div></div>' +
      '<span class="chev">' + UI.icon('chevron', 16) + '</span></button>';
    html += '<button class="list-row" data-act="checkReminders">' +
      '<div class="row-main"><div class="row-t">立即检查待收分红</div>' +
      '<div class="row-s">列出即将到账的分红</div></div>' +
      '<span class="chev">' + UI.icon('chevron', 16) + '</span></button>';
    html += '</div>';

    html += '<div class="card">' +
      '<div class="card-head"><h2>关于</h2></div>' +
      '<div class="tiny" style="line-height:1.85">' +
      '<b>自由</b> · 单文件 PWA。数据默认全部保存在你自己的浏览器里，' +
      '只在取行情与分红时访问公开接口。<br><br>' +
      '<b>只做记录</b>：本应用不提供股票买卖、不推荐标的、不提供任何投资建议或收益承诺。<br><br>' +
      '<b>数据来源</b>：行情来自腾讯财经公开接口，分红方案来自东方财富与天天基金公开接口，均为公开信息的整理，可能存在延迟或偏差，请以券商与交易所披露为准。<br><br>' +
      '<b>已知局限</b>：<br>' +
      '· A 股分红数据源没有独立的「派息日」字段，口径上「派息日 = 除权除息日」，界面标注为「预计派息日」；基金与港股为数据源给出的真实派息日<br>' +
      '· 美股无公开可用的免费分红源，只提供行情、成本与盈亏，分红可在个股页手工补录<br>' +
      '· 分红统一按税前口径，未计入分红个税<br>' +
      '· 多币种以人民币折算为主口径；汇率缺失时按 1 折算<br>' +
      '· 跨设备迁移用「跨设备搬运」或 JSON 导出导入，数据不经过任何服务器<br>' +
      '· 直接以 file:// 打开时浏览器不支持 Service Worker 与系统级推送' +
      '</div></div>';
    return html;
  }

  function render() {
    var html = '';
    html += renderAccounts();
    html += '<div class="section-title">交易记录</div>';
    html += renderTransactions();
    html += '<div class="section-title">息覆生活</div>';
    html += renderExpenses();
    html += '<div class="section-title">账户分析</div>';
    html += '<div class="card flush">' +
      '<button class="list-row" data-act="openAnalysis">' +
      '<div class="row-main"><div class="row-t">📊 账户分析</div>' +
      '<div class="row-s">资产走势曲线（市值/净资产/收益率） · 持仓盈亏榜 · 股息率分层 · 市场分布 · 集中度</div></div>' +
      '<span class="chev">' + UI.icon('chevron', 16) + '</span></button>' +
      '</div>';

    html += '<div class="section-title">数据</div>';
    html += renderData();
    html += '<div class="section-title">设置</div>';
    html += renderSettings();
    return html;
  }

  return { render: render };
})();
