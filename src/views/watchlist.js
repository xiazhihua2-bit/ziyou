/* ==================== 自选（Tab · 二期上线占位） ====================
 * 完整形态（已确认方案，见 .workbuddy/memory/2026-10-08.md）：
 *   分组 chips（全部/持仓虚拟组 + 美股/港股/A股）· 指数栏 · 分组管理 sheet ·
 *   搜索加自选（空心星→实心星）· 行内分时懒加载 · 点行进个股档案。
 * 一期先给六 Tab 完整骨架，页面本体随二期交付。 */
XJ.views.watchlist = (function () {
  var UI = XJ.ui;

  function render() {
    var html = '';
    html += '<div class="slogan-bar warm">' + UI.icon('info', 15) +
      '<span>自选盯盘搭建中：分组、指数栏与搜索加自选将在下一期上线</span></div>';
    html += '<div class="card" style="text-align:center;padding:42px 18px">' +
      '<div style="font-size:42px;line-height:1">⭐</div>' +
      '<div style="font-size:15px;font-weight:650;margin-top:12px">自选清单还没建好</div>' +
      '<div class="tiny" style="margin-top:6px;line-height:1.6">二期将支持：分组管理 · 官方图标 · 分时迷你曲线 · 指数行情</div>' +
      '</div>';
    return html;
  }

  return { render: render };
})();
