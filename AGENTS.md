# AGENTS.md · 交付前必读

> 这份文件写给**接手这个仓库的 AI agent**。它记录的是「怎么把改动真正发到线上」这件事——
> 这个流程有若干反直觉的坑，照着自己摸索几乎必踩。请先读完 §2 再动手。
>
> 项目：单文件股息追踪 PWA「自由」（`src/*.js` + `src/style.css` → `build.mjs` 打包）。
> 线上唯一地址：**https://xiazhihua2-bit.github.io/ziyou/**（仓库 `xiazhihua2-bit/ziyou`，Pages 走 legacy 分支模式，产物直接放仓库根）。

---

## 1. TL;DR（已经改完代码、只差上线时）

```powershell
# 0) 用绝对路径的 node（沙箱里 PATH 没有 node）
$node = 'C:\Users\29699\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'

# 1) 构建（会自检：部署版不得含 OCR Key、sw.js 不得剩占位符）
& $node build.mjs

# 2) 回归（必须全绿再往下走）
& $node verify.mjs
& $node tools/test-wl-sort.mjs           # 自选排序相关改动才需要
& $node tools/shoot-yieldpct.mjs         # 浏览器级冒烟（分位/自选息率）
& $node tools/shoot-pool.mjs            # 股票池 50 行 / 两字段排序 / 实时联动
& $node tools/shoot-holder.mjs          # 股东持股 19 家 / 8 期切换 / 四列排序 / 展开图拖动

# 3) 部署（幂等：内容没变的文件会自动跳过）
& $node tools/deploy-pages.mjs
# 期望最后两行：
#   [pages] status=errored build_type=legacy     ← 瞬态，正常
#   [deploy] 全部完成 ✓ 共 N 个文件(未变更的已跳过)

# 4) 等 Pages 构建完成并核验（见 §6）
```

**不要 `git push`**（原因见 §3）。**不要打印 `.token` 的内容**。

---

## 2. 硬性前提（不满足就别开始）

| 前提 | 说明 |
|---|---|
| node 路径 | 沙箱内 `node` 不在 PATH，用 `C:\Users\29699\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe` |
| 文件/网络权限 | 部署要写项目根外的东西（`.git`）并直连 `api.github.com`：需要 **danger-full-access**。受限沙箱里会得到 `ECONNRESET` / `ConnectTimeoutError` |
| 令牌 | 项目根 `.token`（40 字节，classic PAT，`repo` 权限）。**已被 `.gitignore` 忽略**。读它但绝不要 `echo`/打印/写进日志 |
| 仓库身份 | `OWNER=xiazhihua2-bit`、`REPO=ziyou`，写死在 `tools/deploy-pages.mjs:12-13` |
| 不要碰 | `xiazhihua2-bit/xiji` 与 https://xiazhihua2-bit.github.io/xiji/ 已废弃（旧「息记复刻版」），不要部署、不要改 |

---

## 3. 为什么不是 `git push`

- 本机到 GitHub 的 git 通道不可用：schannel 报 `SEC_E_NO_CREDENTIALS`，切 openssl 后端则被 `connection reset`；
  `git ls-remote` / `git fetch` 也失败。
- 仓库 API 不允许 agent 写 `.github/workflows/*`（会被拒）。
- **唯一可用通道 = GitHub Contents API**，即 `tools/deploy-pages.mjs`。

git 只在**本地**用（commit 历史、blob 比对），不要指望它推远端。

---

## 4. `tools/deploy-pages.mjs` 是怎么工作的

1. 读 `.token`（第 11 行），构造 `Authorization: Bearer …`、`Accept: application/vnd.github+json`、`User-Agent: ziyou-deploy`。
2. 遍历 **`FILES` 数组（第 23-60 行，手写清单）**，每项 `[仓库路径, 本地文件]`：
   - `GET /repos/xiazhihua2-bit/ziyou/contents/<path>?ref=main` 取远端 sha；
   - 读本地文件转 base64，**逐字节比对**：相同 → 打印「未变更」跳过；
   - 不同或不存在 → `PUT` 同一路径（带 `sha` 表示更新，不带表示新建），message 形如 `deploy: src/app.js (...)`。
   - 特例：`index.html` 已超 1MB，Contents API 对它只返回元数据（`content: ''`）。脚本会自动退回
     `GET /git/blobs/<sha>` 取全文再比字节，命中则打印「未变更(>1MB，走 blob 比对)」。
3. 遍历 **`PRUNE` 数组（第 64-67 行）**：这些文件已下线，远端存在就 `DELETE`（幂等，不存在跳过）。
4. 最后 `GET /repos/…/pages` 打印 `[pages] status=… build_type=…`；有失败项则 `process.exit(1)`。

要点：

- **`FILES` 是手写的，不是目录扫描。** 新增 `src/*.js`、新增要随仓库发布的 `tools/*.mjs`，**必须手动加一行**，否则线上缺文件。
  2026-11-07 就漏过 `src/wl-sort.js`（自选排序模块）——pwa 的 `index.html` 是全内联单文件，站点没崩，
  但仓库源码镜像缺了文件，按源码排查时对不上。**新增模块后先 `grep wl-sort tools/deploy-pages.mjs` 对一遍。**
- 下线文件不要手动调 DELETE，加进 `PRUNE`，让脚本幂等处理。
- 上传的是 `dist/pwa/index.html`（**单文件全内联、OCR Key 已置空**）以及 `src/` 源码镜像；
  `dist/自由.html`（带 Key 的双击即用版）**不上传**。
- 部署耗时与文件数相关（每个文件一次 GET + 可能的 PUT）。正常一次全量约 1-3 分钟。

---

## 5. 构建与缓存版本号

- `node build.mjs` 产出两份：`dist/自由.html`（单文件，内嵌 OCR Key）与 `dist/pwa/`（**部署用**，Key 置空）。
- `sw.js` 版本号 = `sha1(bundle + css).slice(0,8)`（`build.mjs:118`）。**CSS 也计入**——只改样式也会换 sw 版本，
  否则用户端缓存不刷新。
- 构建会自检：部署版含 Key、或 sw.js 里还有版本占位符 → 直接报错退出。

---

## 6. 上线后的核验（必须做，别只看脚本退出码）

```powershell
$env:TOKEN = (Get-Content -LiteralPath .token -Raw).Trim()
$h = @{ Authorization = "Bearer $env:TOKEN"; 'User-Agent' = 'ziyou-deploy'; Accept = 'application/vnd.github+json' }

# a) Pages 构建状态：errored/building 是瞬态，轮询到 built
$b = Invoke-RestMethod -Uri 'https://api.github.com/repos/xiazhihua2-bit/ziyou/pages/builds/latest' -Headers $h -TimeoutSec 20
$b.status   # 期望 built

# b) 远程文件核对（index.html 已超 1MB，Contents API 拿不到 content，必须走 blob）
$tree = Invoke-RestMethod -Uri 'https://api.github.com/repos/xiazhihua2-bit/ziyou/git/trees/main?recursive=1' -Headers $h
$sha = ($tree.tree | Where-Object { $_.path -eq 'src/wl-sort.js' }).sha
$blob = Invoke-RestMethod -Uri "https://api.github.com/repos/xiazhihua2-bit/ziyou/git/blobs/$sha" -Headers $h
[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($blob.content -replace '\s','')).Length

# c) 线上站点是否已经是新版本
(Invoke-WebRequest 'https://xiazhihua2-bit.github.io/ziyou/sw.js?t=' + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() -UseBasicParsing).Content -match '<新 sw 版本 8 位>'
```

**核对本地与远程是否一致，要比字节，不要只比 sha**：
`git hash-object <file>` 会过 clean 过滤器（换行归一），得到的 sha 与 GitHub blob sha 可能不相等，
即使内容完全一致。判定方法：取 blob 解 base64 得到字节数组，与 `[IO.File]::ReadAllBytes()` 逐字节比较
（相同则首个不同下标 == 文件长度）。

另外：`Invoke-WebRequest` 拿到的 `.Content.Length` 是**字符数**，中文多时远小于字节数
（例如 1072558 字节 ≈ 915071 字符），别误判成「线上文件比本地小」。

---

## 7. 故障排查表

| 症状 | 真实原因 | 处理 |
|---|---|---|
| `TypeError: fetch failed` + `ConnectTimeoutError / ECONNRESET` | 受限沙箱掐了到 api.github.com 的连接；或瞬时抖动 | 换 danger-full-access 重跑；先 `Invoke-WebRequest https://api.github.com/rate_limit` 探活，通了再重试一次 |
| `[pages] status=errored` | 连续推送后的瞬态 | 等 20-60s，轮询 `/pages/builds/latest` 到 `built`；仍 errored 看 `error.message` |
| 站点 200 但还是旧界面 | ① sw 缓存 ② index.html 没真上传 ③ 用户端没刷新 | 查远程 `sw.js` 版本是否等于本地；查远程 `index.html` 字节是否等于 `dist/pwa/index.html`；让用户强刷一次 |
| 远程缺某个 `src/*.js` | `FILES` 手写清单漏加 | 补进 `FILES` 再跑一次部署 |
| `GET contents` 返回 `content: ''` | 文件 > 1MB（`index.html` 已超） | 用 `git/trees` + `git/blobs` |
| 每次部署都 `✓ index.html`（其实没改） | 旧逻辑：`content: ''` 被判成「不同」，于是每次重推、每次多一个 commit | 2026-11-07 已修（自动走 blob 比对）。若仍出现，说明 blob 比对没命中，检查 `cur.json.sha`/`size` 是否正常返回 |
| 构建报「部署版含 OCR Key」 | `build.mjs` 的置空逻辑被改动 | 查 `build.mjs` 里 pwa 产物那段的 Key 替换 |
| `node: command not found` | 沙箱 PATH 无 node | 用 §2 的绝对路径 |

---

## 8. 新增/删除一个要上线的文件

**新增**
1. 加进 `build.mjs` 的 `JS_FILES`（若要在单文件里内联）；
2. 加进 `tools/deploy-pages.mjs` 的 `FILES`（若要以源码镜像形式出现在仓库）；
3. 构建 → verify → 部署 → §6 核验远程能找到该文件。

**删除**
1. 从 `JS_FILES` / `FILES` 移除；
2. 路径加进 `tools/deploy-pages.mjs` 的 `PRUNE`（让远端也删掉，幂等）；
3. 部署后确认 `[pages]` 输出里有「已不存在」。

---

## 9. 回滚

仓库是「内容直推」的，没有部署流水线可重放。回滚 = 找回旧内容再推一次：

1. `git log --oneline -- <path>` 找到旧版本，`git show <commit>:<path> > <path>` 覆盖工作区；
2. 重新 `node build.mjs`（若是源码改动）→ `node tools/deploy-pages.mjs`；
3. 走 §6 核验。

---

## 10. 提交前自检清单

- [ ] `node build.mjs` 通过，记下新的 `sw.js` 版本号
- [ ] `node verify.mjs` 全绿（当前基线 1529 项） + `node tools/test-usdiv.mjs`（美股分红 / 行情别名 / 按日汇率曲线 117 项）
- [ ] 相关浏览器探针全绿（`tools/shoot-*.mjs`，含 `shoot-pool.mjs`、`shoot-holder.mjs`）
- [ ] `tools/deploy-pages.mjs` 的 `FILES` / `PRUNE` 已同步本次增删的文件
- [ ] 没有把 `.token`、OCR Key、`.workbuddy/` 里的内容写进任何要提交的文件
- [ ] 部署后 `[pages]` 到 `built`，远程 `sw.js` 版本与本地一致
- [ ] 线上地址能打开：https://xiazhihua2-bit.github.io/ziyou/

---

## 11. 股票池（515450）快照再生

`src/pool-515450.js` 是**生成物，不要手改**。要更新成分股 / 分红 / 图标时：

```powershell
& $node tools/build-pool-515450.mjs      # 重新取数 → 覆盖 src/pool-515450.js + tools/pool-515450-raw.json
& $node build.mjs                        # 快照内联进单文件，sw 版本会跟着变
& $node verify.mjs
& $node tools/shoot-pool.mjs
```

取数口径与坑（改脚本前先读 `tools/build-pool-515450.mjs` 头注释）：

- **季报只披露 31 只**，覆盖不了 50 只成分股 → 用 `year=2026&month=6` 返回的**半年报全量表（72 行）**按权重取前 50，
  数据日期标注 `2026-06-30`。`FundArchivesDatas.aspx` 必须带 `Referer: .../ccmx_515450.html`，否则 404；返回是 UTF-8。
- 历史收盘走 `push2his.eastmoney.com` 且 **`fqt=0` 不复权**（与 `src/fetcher.js` 的 `fetchKline` / 分位口径同源；用 `fqt=1` 前复权会算错）。
- 财年派现按 `RPT_SHAREBONUS_DET` 聚合成「每年一条等效年报方案」，直接喂 `calc.yieldFiscalSteps` / `yieldNow` / `yieldPercentile`，零新公式。
- 官方 logo 走同花顺 F10 `basic.10jqka.com.cn/<code>/company.html` 内嵌 PNG，下载转 data URI；
  **50/50 全齐是硬校验**，缺一只直接报错退出、不产出降级快照（页面不生成中文首字母文字层）。
- 价格序列按全局交易日历对齐，uint32（分）base64 内嵌，停牌日为 0（`calc.yieldPercentile` 会跳过）。
  快照约 928 KB，单文件约 1.94 MB —— Contents API 对 `index.html` 已走 blob 比对，脚本能正确处理。
- 新增的 5 个文件（`src/pool-515450.js`、`src/views/pool.js`、`tools/build-pool-515450.mjs`、
  `tools/pool-515450-raw.json`、`tools/shoot-pool.mjs`）已同时登记在 `build.mjs` 的 `JS_FILES`、
  `verify.mjs` 的 `SRC_FILES` 与 `deploy-pages.mjs` 的 `FILES`；再增文件记得三处都补。

---

## 12. 股东持股情况（515450）快照再生

`src/holder-515450.js` 是**生成物，不要手改**。要更新报告期 / 行业 / 图标时：

```powershell
& $node tools/build-holder-515450.mjs    # 重新取数 → 覆盖 src/holder-515450.js + tools/holder-515450-raw.json
& $node build.mjs
& $node verify.mjs
& $node tools/shoot-holder.mjs
```

口径与坑（改脚本前先读 `tools/build-holder-515450.mjs` 头注释）：

- **这一页不是基金持仓明细**：主体是 515450 这只 ETF 作为**十大流通股东**出现在上市公司股东榜的汇总。
  东财 `RPT_F10_EH_FREEHOLDERS` 的 `HOLDER_CODE` 恰好就是基金代码，用它反查即可。
  字段一一对应：`HOLDER_MARKET_CAP` 持有市值 / `FREE_HOLDNUM_RATIO` 持股比例（占流通股本）/
  `CHANGE_RATIO` 环比增减 / `HOLDER_RANK` 持股排名 / `HOLDER_STATEE` 新进·加仓·减仓 /
  `HOLD_NUM` 持股数 / `REPORT_DATE_NAME` 报告期名。
- **期次过滤两道**：`IS_REPORT='1'` 排除 9 条临时公告日；再按 `END_DATE >= 2024-12-31` 剔除
  `2020三季报`（仅 1 家、断档 4 年），保留 **2024年报 ~ 2026三季报共 8 期**。最新期严格 19 家。
- 行业分类走行情 `push2 .../stock/get?fields=f127`（`ulist.np/get` 的 f127 不是行业，别用批量接口）；
  行业占比**按持有市值加权**，前 5 大 + 其他；「其他」的环比必须把**上一期存在、本期消失**的行业
  也归进来，否则各分项百分点差之和不为 0（verify 42.13 有守恒断言）。
- 官方 logo 优先复用 `tools/pool-515450-raw.json` 里已验证的 F10 `logoUrl`，未覆盖的股票再抓同花顺 F10；
  **28/28 全齐是硬校验**，缺一张直接报错退出、不做中文首字母降级。
- 展开图的 8 期序列来自 `seriesOf(code)`，未进入股东榜的期次为 `null`：不补零、不画假点。
  底部区间条复用 `XJ.chart.brush()`，选区变化**只替换 `.hd-main` 里的主图 SVG**，
  绝不整页重渲（会打断 pointer capture）；主图读数走 `svg[data-hb]` 单独分流，
  不与 `chart.js` 的 `svg[data-chart]` 混淆。
- 排序是**独立的 `src/holder-sort.js`**（`xj.holder.sort`，4 字段），绝不改 `wl-sort.js` /
  `xj.wl.sort`；verify 42.22 与 shoot-holder ⑬ 都有隔离断言。
- 状态 `S.ui.holderPeriod` / `holderExpand` 只放 UI、不落盘、不进同步；本页**不拉实时行情**，
  市值与持股数是报告期时点值，不随价格变动。
- 本次新增的 7 个文件（4 个 `src/*` + `tools/build-holder-515450.mjs`、
  `tools/holder-515450-raw.json`、`tools/shoot-holder.mjs`）已登记在 `build.mjs`、
  `verify.mjs`、`deploy-pages.mjs` 三处清单。
