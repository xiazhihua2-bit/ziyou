/* ==========================================================================
 * 515450 股东持股情况 · 静态快照生成器（零依赖，Node 22 + curl）
 *
 *   node tools/build-holder-515450.mjs
 *
 * 产出：
 *   src/holder-515450.js          内嵌快照（8 个报告期 / 行业分类 / 官方 logo）
 *   tools/holder-515450-raw.json  原始明细，供复算与核验（不内嵌进单文件）
 *
 * 口径（与参考截图逐字段对齐，已用真实接口核对）：
 *   · 主数据 = 东财 RPT_F10_EH_FREEHOLDERS，filter=(HOLDER_CODE="515450")。
 *     股东主体 = 中国农业银行-南方标普中国A股大盘红利低波50ETF；
 *     HOLDER_CODE 恰好就是基金代码 515450，可直接按它反查全部参股公司。
 *   · 字段映射：HOLDER_MARKET_CAP 持有市值 / FREE_HOLDNUM_RATIO 持股比例 /
 *     CHANGE_RATIO 环比增减 / HOLDER_RANK 持股排名 / HOLDER_STATEE 新进·加仓·减仓 /
 *     HOLD_NUM 持股数 / REPORT_DATE_NAME 报告期名。
 *     抽样：2026三季报 雅戈尔 = 6.347亿 / 1.68% / -12.24% / 第6名 / 减仓，与截图一致。
 *   · 期次过滤：IS_REPORT='1' 排除 9 条临时公告日；另剔除 2020三季报（仅 1 家、
 *     与后续披露断档 4 年），保留 2024年报 ~ 2026三季报共 8 个连续正式报告期。
 *   · 行业 = 东财行情 push2 stock/get 的 f127（返回「服装家纺/铁路公路」等，
 *     与截图图例同源）；行业分布占比按持有市值加权，环比 = 本期占比 - 上期占比。
 *   · 官方 logo = 优先复用 tools/pool-515450-raw.json 里已验证的 F10 logoUrl，
 *     未覆盖的股票再走同花顺 F10 公司资料页提取；全部到齐才产出快照。
 *
 * 硬性校验：8 个报告期、最新期 19 家、29/29 行业与官方 logo 全齐。
 * 缺任意一项立即报错退出，不做降级占位（与股票池「不显示中文首字母」同一约束）。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FUND = '515450';
const HOLDER_NAME = '中国农业银行股份有限公司-南方标普中国A股大盘红利低波50交易型开放式指数证券投资基金';
const FETCHED_ON = '2026-11-07';
const MIN_END = '2024-12-31';        // 8 期起点；2020三季报断档，不纳入
const EXPECT_PERIODS = 8;
const EXPECT_LATEST = 19;

function curl(url, referer) {
  const args = ['-s', '--max-time', '30', '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'];
  if (referer) args.push('-e', referer);
  args.push(url);
  return new Promise((resolve, reject) => {
    execFile('curl', args, { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout.length) reject(err);
      else resolve(Buffer.from(stdout || ''));
    });
  });
}
const text = async (url, referer) => (await curl(url, referer)).toString('utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i < list.length) {
      const k = i++;
      try { out[k] = await fn(list[k], k); }
      catch (e) { out[k] = { __error: String(e && e.message || e) }; }
      done++;
      if (done % 10 === 0 || done === list.length) process.stdout.write(`  [${done}/${list.length}]\n`);
      await sleep(60);
    }
  }));
  return out;
}

const symOf = (code) => (/^[56]/.test(code) ? 'sh' : /^[89]/.test(code) ? 'bj' : 'sz') + code;
const secidOf = (code) => (/^[56]/.test(code) ? '1.' : '0.') + code;
const num = (v) => { const n = Number(v); return isFinite(n) ? n : null; };
const day = (s) => String(s || '').slice(0, 10);
const r2 = (v) => Math.round(v * 100) / 100;

/* ---------------- 1. 股东榜明细 ---------------- */
async function holderRows() {
  const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_EH_FREEHOLDERS&columns=ALL' +
    '&filter=(HOLDER_CODE%3D%22515450%22)&pageNumber=1&pageSize=500' +
    '&sortColumns=END_DATE&sortTypes=-1&source=WEB&client=WEB';
  const s = await text(url);
  let d;
  try { d = JSON.parse(s); } catch (e) { throw new Error('股东榜接口返回非 JSON'); }
  if (!d.success || !d.result) throw new Error('股东榜接口未返回 result：' + (d.message || ''));
  const raw = d.result.data || [];
  const rows = [];
  for (const r of raw) {
    const end = day(r.END_DATE);
    const label = String(r.REPORT_DATE_NAME || '');
    /* IS_REPORT=1 排除临时公告日；MIN_END 排除断档的 2020三季报 */
    if (String(r.IS_REPORT) !== '1') continue;
    if (end < MIN_END) continue;
    if (!/^\d{4}(年报|中报|一季报|三季报)$/.test(label)) continue;
    const code = String(r.SECURITY_CODE || '').replace(/\D/g, '');
    if (!/^\d{6}$/.test(code)) continue;
    const cap = num(r.HOLDER_MARKET_CAP);
    const ratio = num(r.FREE_HOLDNUM_RATIO);
    if (!(cap > 0) || !(ratio > 0)) continue;
    const chg = num(r.CHANGE_RATIO);
    const state = String(r.HOLDER_STATEE || '');
    rows.push({
      end, label, c: code, s: symOf(code),
      n: String(r.SECURITY_NAME_ABBR || code).replace(/\s+/g, ''),
      rank: num(r.HOLDER_RANK),
      ratio: r2(ratio),
      cap: Math.round(cap),                     // 元
      sh: num(r.HOLD_NUM),                     // 股
      chg: chg === null ? null : r2(chg),      // null = 新进
      chgName: String(r.HOLDNUM_CHANGE_NAME || ''),
      st: state || (chg === null ? '新进' : '—'),
    });
  }
  rows.sort((a, b) => a.end < b.end ? -1 : a.end > b.end ? 1 : b.cap - a.cap);
  return { rows, raw };
}

/* ---------------- 2. 行业分类（f127） ---------------- */
async function industryOf(code) {
  const url = 'https://push2.eastmoney.com/api/qt/stock/get' +
    `?secid=${secidOf(code)}&fields=f57,f58,f127`;
  const d = JSON.parse(await text(url));
  const v = d && d.data && d.data.f127;
  const s = String(v || '').trim();
  /* f127 偶尔返回 '-' 或纯数字（异常映射），统一归到「其他」 */
  return s && !/^[-+0-9.]+$/.test(s) ? s : '其他';
}

/* ---------------- 3. 官方 logo ---------------- */
const THS_RE = /https?:\/\/(?:basic\.10jqka\.com\.cn\/ai_data\/logo\/company|o\.thsi\.cn)\/[^"'\s\\)]+\.png/i;
const isPng = (b) => b && b.length > 100 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

function poolLogoUrls() {
  const p = path.join(ROOT, 'tools/pool-515450-raw.json');
  if (!fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const out = {};
    (raw.items || []).forEach((it) => { if (it.logoUrl) out[it.code] = it.logoUrl; });
    return out;
  } catch (e) { return {}; }
}

async function logoOf(code, known) {
  const urls = [];
  if (known[code]) urls.push(known[code]);
  /* 同花顺 F10 公司资料页 / 个股首页 */
  for (const u of [`https://basic.10jqka.com.cn/${code}/company.html`, `https://basic.10jqka.com.cn/${code}/`]) {
    try {
      const html = await text(u);
      const m = html.match(THS_RE);
      if (m && urls.indexOf(m[0]) < 0) urls.push(m[0]);
    } catch (e) { /* 换下一个源 */ }
    if (urls.length >= 2) break;
  }
  for (const u of urls) {
    try {
      const b = await curl(u, `https://basic.10jqka.com.cn/${code}/company.html`);
      if (isPng(b)) return { url: u, data: 'data:image/png;base64,' + b.toString('base64') };
    } catch (e) { /* 换下一个 */ }
  }
  return null;
}

/* ---------------- 组装 ---------------- */
async function main() {
  console.log(`[holder] 基金 ${FUND} · 股东榜反查 · 取数日 ${FETCHED_ON}`);
  const { rows, raw } = await holderRows();
  const periods = [];
  const seen = {};
  rows.forEach((r) => { if (!seen[r.end]) { seen[r.end] = true; periods.push({ end: r.end, label: r.label }); } });
  console.log(`[holder] 正式报告期 ${periods.length} 期，明细 ${rows.length} 行`);
  periods.forEach((p) => console.log(`  ${p.end} ${p.label}  ${rows.filter((r) => r.end === p.end).length} 家`));
  if (periods.length !== EXPECT_PERIODS) {
    throw new Error(`报告期应为 ${EXPECT_PERIODS} 期，实际 ${periods.length} 期`);
  }
  const latest = periods[periods.length - 1].end;
  const latestCount = rows.filter((r) => r.end === latest).length;
  if (latestCount !== EXPECT_LATEST) {
    throw new Error(`最新期（${latest}）应为 ${EXPECT_LATEST} 家，实际 ${latestCount} 家`);
  }

  const codes = [...new Set(rows.map((r) => r.c))];
  console.log(`[holder] 涉及 ${codes.length} 只股票，取行业分类…`);
  const industries = await mapLimit(codes, 6, industryOf);
  console.log(`[holder] 取官方 logo…`);
  const known = poolLogoUrls();
  const logos = await mapLimit(codes, 5, async (c) => {
    let r = await logoOf(c, known);
    if (!r) { await sleep(300); r = await logoOf(c, known); }   // 换源重试一轮
    return r;
  });

  const missing = [];
  codes.forEach((c, i) => {
    if (!industries[i] || industries[i].__error) missing.push(`${c} 行业`);
    if (!logos[i] || logos[i].__error || !logos[i].data) missing.push(`${c} 官方 logo`);
  });
  if (missing.length) {
    console.error('[holder] ✗ 数据未齐（' + missing.length + ' 项）：\n  ' + missing.join('\n  '));
    throw new Error('行业/logo 校验失败：按要求不做降级占位');
  }

  const INDUSTRY = {}, LOGOS = {};
  codes.forEach((c, i) => { INDUSTRY[c] = industries[i]; LOGOS[c] = logos[i].data; });
  const ROWS = {};
  periods.forEach((p) => { ROWS[p.end] = rows.filter((r) => r.end === p.end); });

  const js = `/* ==================== 515450 股东持股情况静态快照（生成物，勿手改） ====================
 * 由 tools/build-holder-515450.mjs 生成；原始明细见 tools/holder-515450-raw.json。
 * 股东主体：${HOLDER_NAME}。
 * 主数据 = 东财 RPT_F10_EH_FREEHOLDERS(HOLDER_CODE=515450)，IS_REPORT=1 且
 * 2024-12-31 起共 ${EXPECT_PERIODS} 个连续正式报告期（剔除临时公告日与断档的 2020三季报）。
 * 行业取自行情 f127；官方 logo 为构建期内嵌的 data URI，${codes.length}/${codes.length} 全齐。
 * 快照不进 state / 导出 / 同步，不含任何实时行情。
 */
XJ.holder515450 = (function () {
  var FUND = '${FUND}';
  var HOLDER_NAME = ${JSON.stringify(HOLDER_NAME)};
  var FETCHED_ON = '${FETCHED_ON}';
  var PERIODS = ${JSON.stringify(periods)};
  var ROWS = ${JSON.stringify(ROWS)};
  var INDUSTRY = ${JSON.stringify(INDUSTRY)};
  var LOGOS = ${JSON.stringify(LOGOS)};

  function periods() { return PERIODS; }
  function latest() { return PERIODS.length ? PERIODS[PERIODS.length - 1].end : ''; }
  function rows(end) { return ROWS[end] || []; }
  function industryOf(c) { return INDUSTRY[c] || '其他'; }
  function logoOf(c) { return LOGOS[c] || ''; }
  /** 某只股票在各报告期的持股数 / 持股比例序列；未进入股东榜的期次为 null */
  function seriesOf(c) {
    return PERIODS.map(function (p) {
      var hit = null;
      var list = ROWS[p.end] || [];
      for (var i = 0; i < list.length; i++) { if (list[i].c === c) { hit = list[i]; break; } }
      return { end: p.end, label: p.label,
        sh: hit ? hit.sh : null, ratio: hit ? hit.ratio : null, cap: hit ? hit.cap : null };
    });
  }
  /** 按持有市值加权的行业占比：前 5 名 + 其他，并按上一期占比算环比（百分点） */
  function industryMix(end, prevEnd, keep) {
    keep = keep || 5;
    var list = rows(end), prev = prevEnd ? rows(prevEnd) : [];
    var total = 0, prevTotal = 0;
    var byInd = {}, byPrev = {};
    list.forEach(function (r) { var k = industryOf(r.c); byInd[k] = (byInd[k] || 0) + r.cap; total += r.cap; });
    prev.forEach(function (r) { var k = industryOf(r.c); byPrev[k] = (byPrev[k] || 0) + r.cap; prevTotal += r.cap; });
    if (!(total > 0)) return [];
    var arr = Object.keys(byInd).map(function (k) {
      var pct = byInd[k] / total * 100;
      var pp = prevTotal > 0 ? (byPrev[k] || 0) / prevTotal * 100 : 0;
      return { name: k, pct: pct, delta: pct - pp, hasPrev: prevTotal > 0 };
    }).sort(function (a, b) { return b.pct - a.pct; });
    var top = arr.slice(0, keep);
    /* 「其他」必须按【本期 top5 之外的全部行业】定义，并覆盖到上一期：
       上一期存在、本期消失的行业也要并进来，否则各分项百分点差之和不为 0
       （百分点差守恒是这项统计的自检条件）。 */
    var topNames = {};
    top.forEach(function (x) { topNames[x.name] = 1; });
    var prevOther = 0;
    Object.keys(byPrev).forEach(function (k) {
      if (!topNames[k]) prevOther += prevTotal > 0 ? byPrev[k] / prevTotal * 100 : 0;
    });
    var otherPct = 100 - top.reduce(function (n, x) { return n + x.pct; }, 0);
    if (otherPct > 0.005) {
      top.push({ name: '其他', pct: otherPct,
        delta: otherPct - prevOther, hasPrev: prevTotal > 0 });
    }
    return top;
  }
  /** 五格统计：持股家数 / 新进 / 加仓 / 不变 / 减仓 */
  function statsOf(end) {
    var list = rows(end);
    var s = { total: list.length, fresh: 0, up: 0, flat: 0, down: 0 };
    list.forEach(function (r) {
      if (r.st === '新进' || r.chg === null) s.fresh++;
      else if (r.st === '加仓') s.up++;
      else if (r.st === '减仓') s.down++;
      else if (r.chgName === '不变' || r.chg === 0) s.flat++;
    });
    return s;
  }
  return { FUND: FUND, HOLDER_NAME: HOLDER_NAME, FETCHED_ON: FETCHED_ON,
    PERIODS: PERIODS, ROWS: ROWS, INDUSTRY: INDUSTRY, LOGOS: LOGOS,
    periods: periods, latest: latest, rows: rows, industryOf: industryOf,
    logoOf: logoOf, seriesOf: seriesOf, industryMix: industryMix, statsOf: statsOf };
})();
`;
  fs.writeFileSync(path.join(ROOT, 'src/holder-515450.js'), js, 'utf8');

  const out = {
    fund: FUND, holderName: HOLDER_NAME, fetchedOn: FETCHED_ON,
    minEnd: MIN_END, periods,
    droppedNonReport: raw.filter((r) => String(r.IS_REPORT) !== '1').length,
    droppedBeforeMin: raw.filter((r) => String(r.IS_REPORT) === '1' && day(r.END_DATE) < MIN_END).length,
    industries: INDUSTRY,
    logoUrls: codes.reduce((o, c, i) => { o[c] = logos[i].url; return o; }, {}),
    rows,
    raw,
  };
  fs.writeFileSync(path.join(ROOT, 'tools/holder-515450-raw.json'), JSON.stringify(out), 'utf8');

  const bytes = Buffer.byteLength(js, 'utf8');
  console.log(`[holder] ✓ ${codes.length}/${codes.length} 行业与官方 logo 全齐`);
  console.log(`[holder] ✓ src/holder-515450.js  ${bytes} B (${(bytes / 1024).toFixed(1)} KB)`);
  console.log(`[holder] ✓ tools/holder-515450-raw.json  ${fs.statSync(path.join(ROOT, 'tools/holder-515450-raw.json')).size} B`);
  const mix = ROWS[latest].reduce((o, r) => { o[INDUSTRY[r.c]] = (o[INDUSTRY[r.c]] || 0) + r.cap; return o; }, {});
  const total = Object.values(mix).reduce((a, b) => a + b, 0);
  console.log('[holder] 最新期行业占比抽样：' + Object.keys(mix)
    .sort((a, b) => mix[b] - mix[a]).slice(0, 6)
    .map((k) => `${k} ${(mix[k] / total * 100).toFixed(2)}%`).join(' / '));
}

main().catch((e) => { console.error('[holder] 失败：' + (e && e.message || e)); process.exit(1); });
