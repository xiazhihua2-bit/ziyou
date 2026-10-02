/* 量一下持仓卡片分时图（.hc-spark）在各视口下的实际渲染宽度，
   确认限宽生效且没有破坏卡片布局（无溢出、价格块仍在右缘）。

   用法：node tools/measure-spark.mjs
   依赖：本机 Chrome/Edge + CDP（Node 22 自带 WebSocket / fetch，零依赖）
*/
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const APP = path.resolve('dist/息记复刻版.html');
const PORT = 9411;

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

function pickBrowser() {
  for (const b of BROWSERS) if (fs.existsSync(b)) return b;
  throw new Error('找不到 Chrome / Edge');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('DevTools 未就绪');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

const VIEWPORTS = [
  [320, 640, 'iPhone SE'],
  [375, 812, 'iPhone 常规'],
  [430, 932, 'iPhone Pro Max'],
  [600, 900, '窄平板（单列）'],
  [700, 900, '641-767 单列最宽'],
  [768, 1024, 'iPad 竖屏（两列）'],
  [900, 900, '768-1023 两列'],
  [1024, 768, 'iPad 横屏（两列）'],
  [1280, 900, '桌面（两列）'],
];

/* ---- 从 uitest.mjs 抽出种子数据：不重复维护一份 ----
   uitest.mjs 里 seed 的构造是纯数据代码（只用 SYMS/PRICES/NAMES/plan）。
   这里把 `const seed = {` 到 `const PROBE =` 之间的整段抽出来执行，
   拿到与 UI 验收完全一致的种子，避免两份数据漂移。 */
function loadSeed() {
  const src = fs.readFileSync(path.resolve('uitest.mjs'), 'utf8');
  const beg = src.indexOf('const seed = {');
  const end = src.indexOf('const PROBE = ');
  if (beg < 0 || end < 0) throw new Error('无法从 uitest.mjs 提取 seed');
  const block = src.slice(beg, end);
  /* plan() 是 seed 的辅助函数，同样在 PROBE 之前定义 */
  const helperBeg = src.lastIndexOf('function plan(', beg);
  const helper = helperBeg >= 0 ? src.slice(helperBeg, beg) : '';
  const fn = new Function(helper + block + '\nreturn seed;');
  return fn();
}

const SEED = loadSeed();
process.env.__XJ_SEED = JSON.stringify(SEED);

const MEASURE = `(() => {
  const cards = Array.from(document.querySelectorAll('.hold-card'));
  const withSpark = cards.filter(c => c.querySelector('.hc-spark svg'));
  const total = cards.length;
  if (!withSpark.length) return { error: '没有卡片渲染出分时图', total: total };
  const rows = withSpark.map(c => {
    const sp = c.querySelector('.hc-spark');
    const svg = sp.querySelector('svg');
    const px = c.querySelector('.hc-px');
    const intra = c.querySelector('.hc-intra');
    const cr = c.getBoundingClientRect();
    const sr = sp.getBoundingClientRect();
    const vr = svg.getBoundingClientRect();
    const pr = px ? px.getBoundingClientRect() : null;
    const ir = intra ? intra.getBoundingClientRect() : null;
    return {
      cardW: Math.round(cr.width),
      sparkW: Math.round(sr.width),
      svgW: Math.round(vr.width),
      svgH: Math.round(vr.height),
      pxW: pr ? Math.round(pr.width) : 0,
      pxGapRight: ir && pr ? +(ir.right - pr.right).toFixed(1) : null,
      sparkGapLeft: ir ? +(sr.left - ir.left).toFixed(1) : null,
      stretch: +(vr.width / 100).toFixed(2),
      /* 技术信号标记：确认它不会把代码/涨跌徽章挤出可视区。
         sigClipped = 元素自身被 ellipsis 截断（可接受，属 CSS 兜底）；
         codeClipped = 代码行整体溢出（不可接受）。 */
      sigW: (() => { const s = c.querySelector('.hc-sig'); return s ? Math.round(s.getBoundingClientRect().width) : 0; })(),
      sigClipped: (() => { const s = c.querySelector('.hc-sig'); return s ? s.scrollWidth > s.clientWidth + 1 : false; })(),
      codeW: (() => { const k = c.querySelector('.hc-code'); return k ? Math.round(k.getBoundingClientRect().width) : 0; })(),
      codeClipped: (() => { const k = c.querySelector('.hc-code'); return k ? k.scrollWidth > k.clientWidth + 1 : false; })(),
      sigText: (() => { const s = c.querySelector('.hc-sig'); return s ? s.textContent : ''; })(),
    };
  });
  const cols = getComputedStyle(document.querySelector('.hold-list')).gridTemplateColumns;
  return {
    docW: document.documentElement.scrollWidth,
    vw: window.innerWidth,
    cols: cols,
    shown: withSpark.length,
    total: total,
    rows: rows,
    maxStretch: Math.max(...rows.map(r => r.stretch)),
    minStretch: Math.min(...rows.map(r => r.stretch)),
  };
})()`;

/* 在页面里灌种子 + 造分时数据。
   分时图现在不再受交易时段限制（收盘后照样画），所以不必再伪装时钟；
   但缓存有「批次日期必须等于数据日期、且不晚于今天」的闸门，
   仍用同一个伪造的「今天」来写 at / date，保证两者一致。 */
const SEED_AND_MINUTE = `(() => {
  try {
    /* ---- 1) 固定一个工作日，避免周末跑出不一致的 at ---- */
    const OrigDate = Date;
    function FakeDate(...a) { return a.length ? new OrigDate(...a) : new OrigDate(fakeNow()); }
    function fakeNow() {
      const d = new OrigDate();
      if (d.getDay() === 0) d.setDate(d.getDate() + 1);
      if (d.getDay() === 6) d.setDate(d.getDate() + 2);
      d.setHours(10, 30, 0, 0);
      return d.getTime();
    }
    FakeDate.prototype = OrigDate.prototype;
    FakeDate.now = () => fakeNow();
    FakeDate.parse = OrigDate.parse;
    FakeDate.UTC = OrigDate.UTC;
    window.Date = FakeDate;

    /* ---- 2) 造分时：每只标的 61 个点（09:30~10:30），走势各不相同 ---- */
    const st = XJ.store.state;
    const syms = Object.keys(st.symbols || {});
    const today = XJ.util.today();
    const by = {};
    syms.forEach((sym, k) => {
      const q = st.quoteCache[sym] || {};
      const base = Number(q.price) || 10;
      const pts = [];
      for (let i = 0; i <= 60; i++) {
        const hh = i < 60 ? 9 : 10;
        const mm = i < 60 ? 30 + i : i - 60;
        const t = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
        /* 每只标的相位不同 → 曲线形态各异，便于肉眼分辨是否被拉伸变形 */
        const wave = Math.sin((i + k * 7) / 9) * 0.008 + (i / 60) * ((k % 3 - 1) * 0.01);
        pts.push({ t: t, p: Math.round(base * (1 + wave) * 1000) / 1000 });
      }
      by[sym] = { date: today, points: pts };
    });
    st.minuteCache = { at: today, bySymbol: by };
    XJ.store.ui.tab = 'overview';
    XJ.store.ui.floatOpen = false;
    XJ.store.notify();
    return { seeded: syms.length, missing: 0 };
  } catch (e) { return { error: String(e && e.message) }; }
})()`;

(async () => {
  const browser = pickBrowser();
  const tmp = path.join(process.env.TEMP || '.', 'xj-spark-' + Date.now());
  const proc = spawn(browser, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${tmp}`,
    '--allow-file-access-from-files',
    '--hide-scrollbars',
    'about:blank',
  ], { stdio: 'ignore' });

  let failures = 0;
  /* 技术信号标记把代码行挤到截断的情况（与水平溢出分开计数，便于定位） */
  let sigFailures = 0;
  try {
    const wsUrl = await waitDevtools();
    const ws = new WebSocket(wsUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const cdp = new CDP(ws);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    console.log('\n===== 持仓卡片分时图宽度实测 =====');
    console.log('（stretch = SVG 渲染宽度 / viewBox 宽度 100，即横向拉伸倍率；越接近 1 越不变形）\n');

    for (const [w, h, label] of VIEWPORTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: w, height: h, deviceScaleFactor: 1, mobile: w < 768,
      }, sessionId);
      await cdp.send('Page.navigate', { url: 'file:///' + APP.replace(/\\/g, '/') }, sessionId);
      await sleep(1400);
      /* 等应用启动（Store 就绪） */
      for (let i = 0; i < 40; i++) {
        const probe = await cdp.send('Runtime.evaluate', {
          expression: `!!(window.XJ && XJ.store && XJ.store.state)`, returnByValue: true,
        }, sessionId);
        if (probe.result.value) break;
        await sleep(300);
      }
      await sleep(400);

      /* 灌种子 + 分时（与 uitest.mjs 同一份种子），然后重渲染 */
      const seeded = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          try {
            XJ.store.init(XJ.model.fromImport(${JSON.stringify(SEED)}));
            XJ.store.ui.accountId = XJ.calc.ALL;
            XJ.storage.save(XJ.store.state);
            XJ.store.notify();
            return { ok: true };
          } catch (e) { return { ok: false, err: String(e && e.message) }; }
        })()`,
        returnByValue: true,
      }, sessionId);
      if (!seeded.result.value || !seeded.result.value.ok) {
        console.log(`[${w}×${h}] ${label}  ⚠ 种子注入失败：` +
          JSON.stringify(seeded.result.value));
        continue;
      }
      await sleep(500);

      const sm = await cdp.send('Runtime.evaluate', {
        expression: SEED_AND_MINUTE, returnByValue: true, awaitPromise: true,
      }, sessionId);
      void sm;
      await sleep(900);

      const r = await cdp.send('Runtime.evaluate', {
        expression: MEASURE, returnByValue: true, awaitPromise: true,
      }, sessionId);
      const v = r.result.value;

      console.log(`[${w}×${h}] ${label}`);
      if (!v || v.error) {
        console.log(`      ⚠ ${v ? v.error : '取值失败'}${v && v.total !== undefined ? '（卡片 ' + v.total + ' 张）' : ''}`);
        console.log('');
        continue;
      }
      const over = v.docW > v.vw;
      if (over) failures++;
      /* 代码行被整体截断 = 真问题（信号把代码挤没了）；信号自身被 ellipsis 截断是可接受的兜底 */
      const codeBad = v.rows.filter(row => row.codeClipped).length;
      if (codeBad) sigFailures += codeBad;
      console.log(`      文档宽 ${v.docW} / 视口 ${v.vw}  溢出=${v.docW - v.vw}` +
        `  grid=${v.cols}`);
      v.rows.forEach((row, i) => {
        const bad = row.pxGapRight === null || Math.abs(row.pxGapRight) > 1 ? ' ⚠右缘未贴齐' : '';
        const sigInfo = row.sigW
          ? `  信号「${row.sigText}」${row.sigW}px${row.sigClipped ? '（已省略）' : ''}`
          : '  无信号';
        const codeBadMark = row.codeClipped ? ' ⚠代码行被截断' : '';
        console.log(`      #${i + 1} 卡片 ${row.cardW}px → 图 ${row.sparkW}px` +
          `（SVG ${row.svgW}×${row.svgH}，拉伸 ${row.stretch}×）` +
          ` 价格块 ${row.pxW}px 右距 ${row.pxGapRight}px${bad}` +
          `\n           代码行 ${row.codeW}px${sigInfo}${codeBadMark}`);
      });
      console.log(`      → 拉伸倍率区间 ${v.minStretch}× ~ ${v.maxStretch}×`);
      console.log('');
    }

    ws.close();
  } finally {
    proc.kill();
  }

  console.log('='.repeat(52));
  console.log(failures ? `发现 ${failures} 个视口有水平溢出 ❌` : '所有视口无水平溢出 ✅');
  console.log(sigFailures
    ? `发现 ${sigFailures} 张卡片的代码行被信号标记挤到截断 ❌`
    : '信号标记未把任何卡片的代码行挤到截断 ✅');
  process.exitCode = (failures || sigFailures) ? 1 : 0;
})();
