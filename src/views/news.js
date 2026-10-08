/* ==================== 新闻（Tab · 三期上线占位） ====================
 * 完整形态（已确认方案，见 .workbuddy/memory/2026-10-08.md）：
 *   同花顺主源 + 新浪/腾讯 fallback 链 · 传奇投资者实体词表（图七约 40 实体）·
 *   纯关键词硬规则（完成时态/金额结构词 + 传闻排除词，宁缺勿滥）· 回看 7 天 + 空态 ·
 *   详情弹窗 · 「仅查看自选」开关（默认关）· newsCache 本机缓存（不进同步）。
 * 一期先给六 Tab 完整骨架，页面本体随三期交付。 */
XJ.views.news = (function () {
  var UI = XJ.ui;

  function render() {
    var html = '';
    html += '<div class="slogan-bar warm">' + UI.icon('info', 15) +
      '<span>传奇投资者动态追踪搭建中：只收可核验的已成交事实，宁精勿多</span></div>';
    html += '<div class="card" style="text-align:center;padding:42px 18px">' +
      '<div style="font-size:42px;line-height:1">📰</div>' +
      '<div style="font-size:15px;font-weight:650;margin-top:12px">新闻快讯还没接好</div>' +
      '<div class="tiny" style="margin-top:6px;line-height:1.6">三期将上线：巴菲特 / 伯克希尔 / 李嘉诚家族等<br>传奇投资者的已成交动态（快讯源 · 硬规则过滤）</div>' +
      '</div>';
    return html;
  }

  return { render: render };
})();
