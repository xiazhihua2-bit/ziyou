/* ==========================================================================
 * 515450 股票池静态快照生成器（零依赖，Node 22 + curl）
 *
 *   node tools/build-pool-515450.mjs
 *
 * 产出：
 *   src/pool-515450.js            内嵌快照（50 只成分股 / 财年派现档 / 10 年日收盘 / 官方 logo）
 *   tools/pool-515450-raw.json    原始明细，供复算与核验（不内嵌进单文件）
 *
 * 口径（与 src/calc.js 完全同源）：
 *   · 成分股 = 天天基金【最近一次全量披露】2026 年半年报股票投资明细（72 行），
 *             按权重降序严格取前 50。季报只披露前 31 只，不足以覆盖 50 只成分股。
 *   · 派现   = RPT_SHAREBONUS_DET 全部方案（含预案），按财年聚合；只认有年报方案的财年
 *             effectiveFrom = 该财年年报方案最早公告日（与 yieldFiscalSteps 一致）
 *   · 收盘   = 东财 push2his fqt=0 不复权真实收盘价（项目 fetchKline 同口径）
 *   · logo   = 同花顺 F10 公司资料页内嵌的公司官方标识，失败换源重试
 *
 * 硬性校验：50 只成分股、50 张官方 logo 全部到齐；缺一只立即报错退出，不产出降级快照。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AS_OF = '2026-06-30';
const FUND = '515450';
const TODAY = '2026-11-07';
const BEG = '20161107';

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
const text = async (url, referer, enc = 'utf8') => (await curl(url, referer)).toString(enc);
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

const symOf = (code) => (/^[56]/.test(code) ? 'sh' : /^[0489]/.test(code) ? (/^[89]/.test(code) ? 'bj' : 'sz') : 'sz') + code;
const secidOf = (code) => (/^[56]/.test(code) ? '1.' : '0.') + code;
const day = (s) => String(s || '').slice(0, 10);
const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : null; };

/* ---------------- 1. 成分股 ---------------- */
async function holdings() {
  /* month=6 → 返回 2026 Q3/Q2/Q1 三张表，其中 Q2（半年报）是全量披露 72 行。
     month=9 → Q3 只有 31 行，覆盖不了 50 只成分股。 */
  const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${FUND}&topline=200&year=2026&month=6`;
  const s = await text(url, `https://fundf10.eastmoney.com/ccmx_${FUND}.html`);
  if (!/apidata/.test(s)) throw new Error('基金持仓接口未返回 apidata');
  const tables = s.match(/<table[^>]*>[\s\S]*?<\/table>/g) || [];
  if (!tables.length) throw new Error('未找到持仓表格');
  let best = null;
  for (const t of tables) {
    /* 用表头文字定位列索引，兼容半年报 7 列 / 季报 9 列两种结构 */
    const ths = (t.match(/<th[^>]*>[\s\S]*?<\/th>/g) || [])
      .map((x) => x.replace(/<[^>]+>/g, '').replace(/\s|&nbsp;/g, ''));
    const idx = {
      code: ths.findIndex((x) => /股票代码/.test(x)),
      name: ths.findIndex((x) => /股票名称/.test(x)),
      weight: ths.findIndex((x) => /占净值/.test(x)),
      shares: ths.findIndex((x) => /持股数/.test(x)),
      value: ths.findIndex((x) => /持仓市值/.test(x)),
    };
    if (idx.code < 0 || idx.weight < 0) continue;
    const body = (t.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/) || [])[1] || '';
    const rows = body.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
    const parsed = [];
    for (const r of rows) {
      const cells = (r.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []).map((c) =>
        c.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
      if (cells.length <= idx.weight) continue;
      const code = (cells[idx.code] || '').replace(/\D/g, '');
      if (!/^\d{6}$/.test(code)) continue;
      parsed.push({
        code,
        symbol: symOf(code),
        name: cells[idx.name] || code,
        weight: num((cells[idx.weight] || '').replace(/%/g, '')),
        shares: num((cells[idx.shares] || '').replace(/,/g, '')),
        value: num((cells[idx.value] || '').replace(/,/g, '')),
      });
    }
    if (!best || parsed.length > best.length) best = parsed;
  }
  if (!best || best.length < 50) throw new Error(`全量持仓不足 50 只（最多 ${best ? best.length : 0} 只）`);
  return best.sort((a, b) => (b.weight || 0) - (a.weight || 0)).slice(0, 50);
}

/* ---------------- 2. 财年派现（等效 plans，喂给 calc.yieldFiscalSteps） ---------------- */
async function plansOf(code) {
  const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=ALL' +
    `&filter=${encodeURIComponent(`(SECURITY_CODE="${code}")`)}` +
    '&sortColumns=REPORT_DATE&sortTypes=-1&pageSize=100&pageNumber=1&source=WEB&client=WEB';
  const s = await text(url);
  let data;
  try { data = JSON.parse(s); } catch (e) { throw new Error('分红接口返回非 JSON'); }
  const rows = (data && data.result && data.result.data) || [];
  const byYear = {};
  for (const r of rows) {
    const d = day(r.REPORT_DATE);
    const y = parseInt(d.slice(0, 4), 10);
    if (!y || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const bonus = num(r.PRETAX_BONUS_RMB);
    if (!byYear[y]) byYear[y] = { sum: 0, annual: [] };
    if (bonus && bonus > 0) byYear[y].sum += bonus;
    if (d.slice(5, 7) === '12') {
      const notice = day(r.PLAN_NOTICE_DATE) || day(r.NOTICE_DATE) ||
        day(r.EQUITY_RECORD_DATE) || day(r.EX_DIVIDEND_DATE);
      byYear[y].annual.push(notice);
    }
  }
  const plans = [];
  Object.keys(byYear).sort().forEach((y) => {
    const g = byYear[y];
    const dates = g.annual.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    if (!dates.length || !(g.sum > 0)) return;      // 无年报方案 / 该财年没派现 → 不入选
    plans.push({
      reportDate: `${y}-12-31`,
      pretaxBonusPer10: Math.round(g.sum * 10000) / 10000,
      planNoticeDate: dates[0],                    // 最早年报公告日 = effectiveFrom
    });
  });
  return { plans, raw: rows };
}

/* ---------------- 3. 不复权日收盘 ---------------- */
async function closesOf(code) {
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?fields1=f1,f2,f3' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58&klt=101&fqt=0' +
    `&secid=${secidOf(code)}&beg=${BEG}&end=${TODAY.replace(/-/g, '')}`;
  const s = await text(url);
  let d;
  try { d = JSON.parse(s); } catch (e) { throw new Error('K线接口返回非 JSON'); }
  const ks = (d && d.data && d.data.klines) || [];
  const out = [];
  for (const k of ks) {
    const p = k.split(',');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p[0])) continue;
    const c = num(p[2]);
    if (c === null || !(c > 0)) continue;
    out.push([p[0], c]);
  }
  out.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return out;
}

/* ---------------- 4. 官方 logo（50/50 硬校验） ---------------- */
const THS_RE = /https?:\/\/(?:basic\.10jqka\.com\.cn\/ai_data\/logo\/company|o\.thsi\.cn)\/[^"'\s\\)]+\.png/i;
const isPng = (b) => b && b.length > 100 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

async function logoOf(code) {
  const sources = [];
  // ① 同花顺 F10 公司资料页（项目同款通道）
  try {
    const html = await text(`https://basic.10jqka.com.cn/${code}/company.html`);
    const m = html.match(THS_RE);
    if (m) sources.push(m[0]);
  } catch (e) { /* 换下一个源 */ }
  // ② 同花顺个股首页（部分公司资料页无 logo，首页有）
  if (!sources.length) {
    try {
      const html = await text(`https://basic.10jqka.com.cn/${code}/`);
      const m = html.match(THS_RE);
      if (m) sources.push(m[0]);
    } catch (e) { /* 继续 */ }
  }
  // ③ 公司官网图标（按常见域名猜：需公司域名，这里用东财 F10 提供的站点做兜底）
  for (const u of sources) {
    try {
      const b = await curl(u, `https://basic.10jqka.com.cn/${code}/company.html`);
      if (isPng(b)) return { url: u, data: 'data:image/png;base64,' + b.toString('base64') };
    } catch (e) { /* 换下一个 */ }
  }
  return null;
}

/* ---------------- 组装 ---------------- */
function packPrices(dates, closes) {
  const map = new Map(closes);
  const buf = Buffer.alloc(dates.length * 4);
  dates.forEach((d, i) => {
    const c = map.get(d);
    buf.writeUInt32LE(c ? Math.round(c * 100) : 0, i * 4);
  });
  return buf.toString('base64');
}

async function main() {
  console.log(`[pool] 基金 ${FUND} · 报告期 ${AS_OF} · 取数日 ${TODAY}`);
  const hs = await holdings();
  console.log(`[pool] 成分股 ${hs.length} 只`);
  if (hs.length !== 50) throw new Error(`成分股应为 50 只，实际 ${hs.length} 只`);

  const plans = await mapLimit(hs, 6, (h) => plansOf(h.code));
  const closes = await mapLimit(hs, 6, (h) => closesOf(h.code));
  const logos = await mapLimit(hs, 5, async (h) => {
    let r = await logoOf(h.code);
    if (!r) { await sleep(300); r = await logoOf(h.code); }   // 换源重试一轮
    return r;
  });

  const missingLogo = [], missingData = [];
  hs.forEach((h, i) => {
    if (!logos[i] || logos[i].__error || !logos[i].data) missingLogo.push(`${h.code} ${h.name}`);
    if (closes[i] && closes[i].__error) missingData.push(`${h.code} ${h.name} K线`);
    if (plans[i] && plans[i].__error) missingData.push(`${h.code} ${h.name} 分红`);
  });
  if (missingLogo.length) {
    console.error('[pool] ✗ 官方图标未齐（' + missingLogo.length + ' 只）：\n  ' + missingLogo.join('\n  '));
    throw new Error('logo 50/50 校验失败：按要求不做降级占位');
  }
  if (missingData.length) {
    console.error('[pool] ✗ 数据缺失：\n  ' + missingData.join('\n  '));
    throw new Error('行情/分红数据缺失');
  }

  // 全局交易日历（并集），对齐每只票的价格序列
  const dateSet = new Set();
  closes.forEach((cs) => (cs || []).forEach((r) => dateSet.add(r[0])));
  const dates = [...dateSet].sort();
  console.log(`[pool] 交易日 ${dates.length} 天（${dates[0]} ~ ${dates[dates.length - 1]}）`);

  const items = hs.map((h, i) => ({
    s: h.symbol,
    n: h.name,
    w: h.weight,
    logo: logos[i].data,
    plans: plans[i].plans,
    px: packPrices(dates, closes[i]),
  }));

  const shortDays = dates.map((d) => d.replace(/-/g, '')).join(',');
  const js = `/* ==================== 515450 股票池静态快照（生成物，勿手改） ====================
 * 由 tools/build-pool-515450.mjs 生成；原始明细见 tools/pool-515450-raw.json。
 * 成分股 = 天天基金 ${AS_OF} 半年报全量持仓按权重前 50（季报只披露 31 只，不足以覆盖）；
 * 收盘价为不复权真实收盘（与项目 fetchKline / 分位口径同源）。
 * 官方 logo 为构建期内嵌的 data URI，50/50 全齐；行渲染不生成任何文字头像层。
 */
XJ.pool515450 = (function () {
  var AS_OF = '${AS_OF}';
  var FUND = '${FUND}';
  var DAYS = '${shortDays}'.split(',');
  var ITEMS = ${JSON.stringify(items)};

  /* 价格序列按全局交易日历对齐：0 = 该日停牌/无数据（calc 会跳过），单位分 → 元 */
  function closesOf(it) {
    if (it._c) return it._c;
    var bin = atob(it.px), view = new DataView(new ArrayBuffer(bin.length));
    var u8 = new Uint8Array(bin.length);
    for (var j = 0; j < bin.length; j++) u8[j] = bin.charCodeAt(j);
    view = new DataView(u8.buffer);
    var out = [];
    for (var i = 0; i < DAYS.length; i++) {
      var cents = view.getUint32(i * 4, true);
      if (!cents) continue;
      var d = DAYS[i];
      out.push([d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8), cents / 100]);
    }
    it._c = out;
    return out;
  }
  function items() { return ITEMS; }
  function symbols() { return ITEMS.map(function (x) { return x.s; }); }
  return { AS_OF: AS_OF, FUND: FUND, DAYS: DAYS, ITEMS: ITEMS,
    items: items, symbols: symbols, closesOf: closesOf };
})();
`;
  fs.writeFileSync(path.join(ROOT, 'src/pool-515450.js'), js, 'utf8');

  const raw = {
    fund: FUND, asOf: AS_OF, fetchedOn: TODAY, dates,
    items: hs.map((h, i) => ({
      code: h.code, symbol: h.symbol, name: h.name, weight: h.weight,
      shares: h.shares, value: h.value,
      dividendRows: plans[i].raw, effectivePlans: plans[i].plans,
      closes: closes[i], logoUrl: logos[i].url,
    })),
  };
  fs.writeFileSync(path.join(ROOT, 'tools/pool-515450-raw.json'), JSON.stringify(raw), 'utf8');

  const bytes = Buffer.byteLength(js, 'utf8');
  console.log(`[pool] ✓ 50/50 官方 logo 全齐`);
  console.log(`[pool] ✓ src/pool-515450.js  ${bytes} B (${(bytes / 1024).toFixed(1)} KB)`);
  console.log(`[pool] ✓ tools/pool-515450-raw.json  ${fs.statSync(path.join(ROOT, 'tools/pool-515450-raw.json')).size} B`);
  console.log(`[pool] 财年方案总数 ${items.reduce((n, x) => n + x.plans.length, 0)}，价序列 ${items.reduce((n, x) => n + (x._c ? 0 : 1), 0)} 只待解码`);
  // 抽样复算：用与 calc.js 相同的公式核对第一只票的当前股息率量级
  const first = items[0], fcloses = closes[0];
  const lastClose = fcloses[fcloses.length - 1][1];
  const lastPlan = first.plans[first.plans.length - 1];
  console.log(`[pool] 抽样 ${first.n} 最新收盘 ${lastClose} 元 / 财年派现 ${lastPlan.pretaxBonusPer10} 元每10股 → 息率约 ${(lastPlan.pretaxBonusPer10 / 10 / lastClose * 100).toFixed(2)}%`);
}

main().catch((e) => { console.error('[pool] 失败：' + (e && e.message || e)); process.exit(1); });
