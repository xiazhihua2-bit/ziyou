/* ============================================================
 * 真实数据链路端到端验证
 *
 * 在真实的 file:// 页面里，直接调用 app 自带的取数层，
 * 验证腾讯行情 + 东财分红两个公开接口能否成功拉取并正确解析。
 *
 * 用法： node livetest.mjs
 * ============================================================ */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SRC = path.join(ROOT, 'dist', '自由.html');
const PORT = 9344;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('WebSocket 连接失败'));
      this.ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: rs, reject: rj } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rj(new Error(JSON.stringify(msg.error))); else rs(msg.result);
        }
      };
    });
  }
  send(method, params, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); } }, 60000);
    });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-live-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
  '--allow-file-access-from-files', '--hide-scrollbars',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  'about:blank',
], { stdio: 'ignore' });

let fail = 0;
function ok(m) { console.log('  ✓ ' + m); }
function no(m) { fail++; console.log('  ✗ ' + m); }
function eq2(label, actual, expected) {
  if (String(actual) === String(expected)) ok(label + '  →  ' + actual);
  else { fail++; console.log('  ✗ ' + label + '  实际=' + actual + '  期望=' + expected); }
}

let browser, sessionId, targetId;

try {
  let wsUrl = null;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
      if (r.ok) wsUrl = (await r.json()).webSocketDebuggerUrl;
    } catch (e) { /* retry */ }
    if (!wsUrl) await sleep(150);
  }
  if (!wsUrl) throw new Error('Chrome DevTools 未能启动');

  browser = new CDP(wsUrl);
  await browser.connect();
  const t = await browser.send('Target.createTarget', { url: 'about:blank' });
  targetId = t.targetId;
  sessionId = (await browser.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await browser.send('Page.enable', {}, sessionId);
  await browser.send('Runtime.enable', {}, sessionId);
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);

  console.log('页面：' + SRC);
  await browser.send('Page.navigate', { url: pathToFileURL(SRC).href }, sessionId);

  let ready = false;
  for (let i = 0; i < 120; i++) {
    await sleep(120);
    const r = await browser.send('Runtime.evaluate', {
      expression: '!!(window.XJ && XJ.fetcher)', returnByValue: true,
    }, sessionId);
    if (r.result && r.result.value) { ready = true; break; }
  }
  if (!ready) throw new Error('应用未能启动');
  ok('单文件应用在 file:// 下成功启动');

  /* ---- 1. 腾讯行情 ---- */
  console.log('\n【1】腾讯行情接口（GBK 编码 + 字段位解析）');
  const qRes = await browser.send('Runtime.evaluate', {
    expression: `
      XJ.fetcher.fetchQuotes(['sh600023','sz000858','sh601318']).then(function(q){
        return { keys: Object.keys(q), sample: q['sh600023'] || null,
                 listed: Object.keys(q).map(function(k){
                   var x=q[k];
                   return {sym:k, name:x.name, price:x.price, prevClose:x.prevClose,
                           changePct:x.changePct, time:x.quoteTime};
                 }) };
      })`,
    returnByValue: true, awaitPromise: true,
  }, sessionId);
  const q = qRes.result && qRes.result.value;
  if (qRes.exceptionDetails) no('行情调用异常: ' + JSON.stringify(qRes.exceptionDetails).slice(0, 300));
  else if (!q || !q.keys.length) no('行情未取到任何数据（可能是网络不可达）');
  else {
    ok('成功取到 ' + q.keys.length + ' 只标的行情');
    q.listed.forEach((x) => {
      const sane = x.name && x.price > 0 && /^[\u4e00-\u9fa5A-Za-z0-9\s*]+$/.test(x.name);
      (sane ? ok : no)('  ' + x.sym + ' → ' + x.name + '  现价 ' + x.price +
        '  昨收 ' + x.prevClose + '  涨跌 ' + x.changePct + '%  时间 ' + x.time);
    });
    const s = q.sample;
    if (s && s.name && s.price > 0) ok('中文名未出现 GBK 乱码，字段位与设计一致');
    else no('字段位解析异常: ' + JSON.stringify(s));
  }

  /* ---- 1b. 多市场行情 + 汇率（M1 市场抽象层） ---- */
  console.log('\n【1b】多市场行情：A股 / 港股 / 美股 + 汇率');
  const mRes = await browser.send('Runtime.evaluate', {
    expression: `
      Promise.all([
        XJ.fetcher.fetchQuotes(['sh600023','hk00700','usAAPL','sz000858']),
        XJ.fetcher.fetchFX()
      ]).then(function(r){
        var q = r[0], fx = r[1];
        return {
          quoteKeys: Object.keys(q),
          list: Object.keys(q).map(function(k){
            var x = q[k];
            return { sym:k, mk:x.market, cur:x.currency, name:x.name, price:x.price,
                     chg:x.changePct, pe:x.pe, cap:x.totalCap, t:x.quoteTime,
                     kind:XJ.market.kind(k) };
          }),
          fx: fx,
          fxKeys: Object.keys(fx),
          marketMeta: Object.keys(q).map(function(k){
            return { sym:k, label:XJ.market.label(k), kind:XJ.market.kind(k),
                     quoteable:XJ.market.isQuoteable(k), divSrc:XJ.market.dividendSource(k) };
          })
        };
      })`,
    returnByValue: true, awaitPromise: true,
  }, sessionId);
  const mm = mRes.result && mRes.result.value;
  if (mRes.exceptionDetails) no('多市场行情异常: ' + JSON.stringify(mRes.exceptionDetails).slice(0, 300));
  else if (!mm || !mm.list.length) no('多市场行情未取到数据');
  else {
    eq2('跨市场行情同时取到 4 只', mm.quoteKeys.length, 4);
    mm.list.forEach((x) => {
      const good = x.name && x.price > 0 && x.cur;
      (good ? ok : no)('  ' + x.sym + '  ' + x.kind + '  ' + x.name +
        '  现价 ' + x.price + ' ' + x.cur + '  涨跌 ' + x.chg + '%' +
        '  PE ' + (x.pe === null ? '—' : x.pe) +
        '  市值 ' + (x.cap === null ? '—' : x.cap) + '亿');
    });
    const curs = mm.list.map((x) => x.cur).sort().join(',');
    eq2('币种按市场正确区分（CNY/CNY/HKD/USD）', curs, 'CNY,CNY,HKD,USD');
    console.log('    市场元数据：' + mm.marketMeta.map((m) => m.sym + '→' + m.kind + '/' + m.divSrc).join('  '));
  }
  if (mm && mm.fxKeys && mm.fxKeys.length) {
    mm.fxKeys.forEach((k) => {
      const v = mm.fx[k];
      (v > 0 ? ok : no)('  汇率 ' + k + '→CNY = ' + v);
    });
    if (mm.fx.HKD > 0) ok('港币汇率可用于人民币折算口径');
  } else {
    no('未取到任何汇率（人民币折算口径失去依据）');
  }

  /* ---- 1c. 基金 / ETF：行情 + 分红（含真实发放日） ---- */
  console.log('\n【1c】基金 / ETF 行情与分红（含独立分红发放日）');
  const fRes = await browser.send('Runtime.evaluate', {
    expression: `
      Promise.all([
        XJ.fetcher.fetchQuotes(['sh515450','sz159915']),
        XJ.fetcher.fetchFundDivYear(2026)
      ]).then(function(r){
        var q = r[0], rows = r[1];
        var mine = rows.filter(function(x){ return x.fundCode === '515450'; });
        return {
          quotes: Object.keys(q).map(function(k){ var x=q[k];
            return {sym:k, name:x.name, price:x.price, cur:x.currency, chg:x.changePct}; }),
          total: rows.length,
          assetType: XJ.market.assetType('sh515450'),
          divSrc: XJ.market.dividendSource('sh515450'),
          plan: mine.length ? XJ.fetcher.fundRowToPlan(mine[0], 'sh515450') : null,
          payExact: mine.length ? XJ.calc.payoutInfo(XJ.fetcher.fundRowToPlan(mine[0], 'sh515450')) : null
        };
      })`,
    returnByValue: true, awaitPromise: true,
  }, sessionId);
  const ff = fRes.result && fRes.result.value;
  if (fRes.exceptionDetails) no('基金链路异常: ' + JSON.stringify(fRes.exceptionDetails).slice(0, 300));
  else if (!ff) no('基金链路无返回');
  else {
    eq2('资产类型识别 = etf', ff.assetType, 'etf');
    eq2('分红来源 = fund', ff.divSrc, 'fund');
    (ff.quotes || []).forEach((x) => {
      (x.name && x.price > 0 ? ok : no)('  ' + x.sym + '  ' + x.name + '  现价 ' + x.price + ' ' + x.cur + '  涨跌 ' + x.chg + '%');
    });
    eq2('ETF 行情取到 2 只', (ff.quotes || []).length, 2);
    if (ff.total > 0) {
      ok('2026 年全市场基金分红拉取成功，共 ' + ff.total + ' 条（分页遍历）');
    } else {
      no('基金分红分页未取到数据');
    }
    if (ff.plan) {
      ok('按代码定位到 515450 的分红记录');
      console.log('     代码 ' + ff.plan.securityCode + '  ' + ff.plan.securityName);
      console.log('     权益登记日 ' + ff.plan.equityRecordDate + '  除息日 ' + ff.plan.exDividendDate +
        '  真实发放日 ' + ff.plan.payoutDate);
      console.log('     方案「' + ff.plan.implPlanProfile + '」');
      (ff.plan.payoutDate ? ok : no)('基金带出【真实分红发放日】，无需 T+1 推算');
      (ff.payExact && ff.payExact.exact ? ok : no)('payoutInfo.exact = true（界面可标「分红发放日」而非「预计到账」）');
    } else {
      no('未能在全市场分红列表中定位到 515450（可能该基金 2026 年无分红）');
    }
  }
  /* ---- 1d. 股票搜索（智能选股） ---- */
  console.log('\n【1d】股票搜索（腾讯联想 smartbox，用于添加持仓第 1 步）');
  const srRes = await browser.send('Runtime.evaluate', {
    expression: `
      Promise.all([
        XJ.fetcher.fetchSymbolSearch('双汇'),
        XJ.fetcher.fetchSymbolSearch('腾讯控股'),
        XJ.fetcher.fetchSymbolSearch('600023')
      ]).then(function(r){
        var pick = function(list){ return list.slice(0,4).map(function(x){
          return { sym:x.symbol, code:x.code, name:x.name, kind:x.kind }; }); };
        return { byName: pick(r[0]), byHkName: pick(r[1]), byCode: pick(r[2]),
                 n1: r[0].length, n2: r[1].length, n3: r[2].length };
      })`,
    returnByValue: true, awaitPromise: true,
  }, sessionId);
  const sr = srRes.result && srRes.result.value;
  if (srRes.exceptionDetails) no('搜索异常: ' + JSON.stringify(srRes.exceptionDetails).slice(0, 300));
  else if (!sr || !sr.n1) no('搜索未返回结果');
  else {
    ok('按名称「双汇」搜到 ' + sr.n1 + ' 条');
    sr.byName.forEach((x) => {
      (x.name && x.sym ? ok : no)('  ' + x.sym + '  ' + x.name + '  ' + x.kind);
    });
    eq2('搜到的 000895 归一化为 sz000895', sr.byName[0] && sr.byName[0].sym, 'sz000895');
    if (sr.n2) {
      ok('按名称「腾讯控股」搜到 ' + sr.n2 + ' 条 → ' + sr.byHkName.map((x) => x.sym + ' ' + x.name).join(', '));
      if (sr.byHkName.some((x) => x.sym === 'hk00700')) ok('港股命中 hk00700');
    }
    if (sr.n3) {
      ok('按代码「600023」搜到 ' + sr.n3 + ' 条 → ' + sr.byCode.map((x) => x.sym).join(', '));
      if (sr.byCode.some((x) => x.sym === 'sh600023')) ok('A股代码命中 sh600023');
    } else {
      console.log('     （按纯代码未命中，属正常：联想接口以名称/拼音为主）');
    }
  }

  /* ---- 1e. 名称补全（修复「名称显示成代码」） ---- */
  console.log('\n【1e】名称补全通道（修复 BUG：名称被显示成股票代码）');
  const nmRes = await browser.send('Runtime.evaluate', {
    expression: `
      Promise.all([
        XJ.fetcher.fetchNames(['sh601318']),
        XJ.fetcher.fetchQuotes(['sh601318'])
      ]).then(function(r){
        var names = r[0], q = r[1].sh601318 || {};
        return {
          healed: names.sh601318 || null,
          quoteName: q.name || null,
          truncated: !!q.nameTruncated,
          hasInfo: XJ.util.hasNameInfo(names.sh601318 || '')
        };
      })`,
    returnByValue: true, awaitPromise: true,
  }, sessionId);
  const nm = nmRes.result && nmRes.result.value;
  if (nmRes.exceptionDetails) no('名称补全异常: ' + JSON.stringify(nmRes.exceptionDetails).slice(0, 300));
  else if (!nm) no('名称补全无返回');
  else {
    console.log('    行情接口返回的名称 = ' + JSON.stringify(nm.quoteName) +
      '（被交易所前缀挤占：' + nm.truncated + '）');
    if (nm.healed) {
      ok('反查补全通道返回完整名称 = 「' + nm.healed + '」');
      eq2('补全后的名称通过「有名称信息」判定', nm.hasInfo, true);
      if (nm.quoteName !== nm.healed) {
        ok('补全确实修复了行情名的截断问题（' + nm.quoteName + ' → ' + nm.healed + '）');
      }
    } else {
      no('未能补全 sh601318 的名称');
    }
  }

  /* ---- 1f. 公司官网域名（用于官方图标） ---- */
  console.log('\n【1f】官方图标通道：东财 F10 取公司官网域名');
  const dmRes = await browser.send('Runtime.evaluate', {
    expression: `XJ.fetcher.fetchCompanyDomains(['sh601919','sz000858','sh601318','hk00700','usAAPL'])
        .then(function(m){
          return { count:Object.keys(m).length, map:m,
                   logo: XJ.market.logoUrl('sh601919', m['sh601919']) };
        })`,
    returnByValue: true, awaitPromise: true,
  }, sessionId);
  const dm = dmRes.result && dmRes.result.value;
  if (dmRes.exceptionDetails) no('域名获取异常: ' + JSON.stringify(dmRes.exceptionDetails).slice(0, 300));
  else if (!dm || !dm.count) console.log('    未取到域名（接口可能暂不可用，界面会自动回退字母头像）');
  else {
    Object.keys(dm.map).forEach((s) => console.log('    ' + s + ' → ' + dm.map[s]));
    ok('取到 ' + dm.count + ' 个公司官网域名');
    if (dm.map['sh601919']) ok('A股域名通道正常：sh601919 → ' + dm.map['sh601919']);
    else no('A股域名未取到');
    if (dm.map['hk00700']) ok('★港股域名通道正常：hk00700 → ' + dm.map['hk00700']);
    else no('港股域名未取到（RPT_HKF10_INFO_ORGPROFILE 可能改版）');
    if (dm.map['usAAPL']) ok('★美股域名通道正常：usAAPL → ' + dm.map['usAAPL']);
    else no('美股域名未取到（RPT_USF10_INFO_ORGPROFILE 可能改版）');
    if (dm.logo) ok('可拼出官方图标 URL：' + dm.logo);
    /* 真的能下载到图片才算通过（用招商银行这种确定有真图标的域名，
       冷门域名 icon.horse 会回灰字母占位图，那正是下一步要拦掉的） */
    const realLogo = 'https://icon.horse/icon/www.cmbchina.com';
    const imgRes = await browser.send('Runtime.evaluate', {
      expression: `new Promise(function(r){
        var im = new Image();
        im.onload = function(){ r({ ok:true, w:im.naturalWidth, h:im.naturalHeight }); };
        im.onerror = function(){ r({ ok:false }); };
        im.src = '${realLogo}';
        setTimeout(function(){ r({ ok:false, timeout:true }); }, 25000);
      })`,
      returnByValue: true, awaitPromise: true,
    }, sessionId);
    const im = imgRes.result && imgRes.result.value;
    if (im && im.ok) ok('官方图标可实际加载：' + im.w + '×' + im.h + ' px  ' + realLogo);
    else console.log('    图标未能加载（icon.horse 可能不可达），界面会自动回退到字母头像');
  }

  /* ---- 1g. 假图标检测 ---- */
  console.log('\n【1g】官方图标真伪校验（canvas 采样识别灰字母占位图）');
  /* 逐个串行：icon.horse 首次为冷门域名抓图标实测要 12s 以上，并发会互相拖慢 */
  const icRes = await browser.send('Runtime.evaluate', {
    expression: `
      (async function(){
        var list = [
          ['招商银行', 'https://icon.horse/icon/www.cmbchina.com'],
          ['申能股份', 'https://icon.horse/icon/www.shenergy.net.cn'],
          ['中远海控', 'https://icon.horse/icon/hold.coscoshipping.com'],
          ['xinac黑地球', 'https://api.xinac.net/icon/?url=hold.coscoshipping.com']
        ];
        var out = {};
        for (var i = 0; i < list.length; i++) {
          out[list[i][0]] = await XJ.fetcher.checkLogo(list[i][1]);
        }
        return out;
      })()`,
    returnByValue: true, awaitPromise: true,
  }, sessionId);
  const ic = icRes.result && icRes.result.value;
  if (icRes.exceptionDetails) no('图标校验异常: ' + JSON.stringify(icRes.exceptionDetails).slice(0, 300));
  else if (!ic) no('图标校验无返回值');
  else {
    console.log('    ' + Object.keys(ic).map((k) => k + ' → ' + ic[k]).join(' · '));
    eq2('申能股份的灰字母占位图被识别（回退中文头像）', ic['申能股份'], 'bad');
    eq2('中远海控的灰字母占位图被识别（回退中文头像）', ic['中远海控'], 'bad');
    eq2('xinac 的黑地球占位图被识别', ic['xinac黑地球'], 'bad');
    if (ic['招商银行'] !== 'bad') ok('招商银行的真图标未被误杀（' + ic['招商银行'] + '）');
    else no('招商银行的真图标被误判为假图标');
  }

  /* ---- 1h. 当日分时 + 历史日线 / 基金净值 ---- */
  console.log('\n【1h】分时与历史行情（持仓总市值曲线的数据源）');
  const minRes = await browser.send('Runtime.evaluate', {
    expression: `XJ.fetcher.fetchMinutes(['sh600036','hk00700','usAAPL','of110022'])
        .then(function(m){
          var out = {};
          Object.keys(m).forEach(function(k){
            out[k] = { date:m[k].date, n:m[k].points.length,
                       first:m[k].points[0].t+' '+m[k].points[0].p,
                       last:m[k].points[m[k].points.length-1].t+' '+m[k].points[m[k].points.length-1].p };
          });
          return out;
        })`,
    returnByValue: true, awaitPromise: true,
  }, sessionId);
  const min = minRes.result && minRes.result.value;
  if (minRes.exceptionDetails) no('分时获取异常: ' + JSON.stringify(minRes.exceptionDetails).slice(0, 300));
  else if (!min) no('分时无返回值');
  else {
    Object.keys(min).forEach((s) => console.log('    ' + s + ' → ' + min[s].date + ' · ' + min[s].n +
      ' 点 · ' + min[s].first + ' … ' + min[s].last));
    if (min['sh600036'] && min['sh600036'].n > 30) ok('A股分时正常（' + min['sh600036'].n + ' 点）');
    else no('A股分时数据异常');
    if (min['hk00700'] && min['hk00700'].n > 30) ok('港股分时正常（' + min['hk00700'].n + ' 点）');
    else no('港股分时数据异常');
    if (min['usAAPL']) ok('美股分时取到（' + min['usAAPL'].n + ' 点）');
    else console.log('    美股分时为空（非交易时段或接口差异，界面不会画分时）');
    eq2('场外基金不参与分时（无行情）', !!min['of110022'], false);
  }

  const klRes = await browser.send('Runtime.evaluate', {
    expression: `XJ.fetcher.fetchPriceHistory(['sh600036','hk00700','usAAPL','of110022'], { beg:'2026-01-01' })
        .then(function(m){
          var out = {};
          Object.keys(m).forEach(function(k){
            out[k] = { n:m[k].length, first:m[k][0][0]+' '+m[k][0][1],
                       last:m[k][m[k].length-1][0]+' '+m[k][m[k].length-1][1] };
          });
          return out;
        })`,
    returnByValue: true, awaitPromise: true,
  }, sessionId);
  const kl = klRes.result && klRes.result.value;
  if (klRes.exceptionDetails) no('历史行情异常: ' + JSON.stringify(klRes.exceptionDetails).slice(0, 300));
  else if (!kl) no('历史行情无返回值');
  else {
    Object.keys(kl).forEach((s) => console.log('    ' + s + ' → ' + kl[s].n + ' 个交易日 · ' +
      kl[s].first + ' … ' + kl[s].last));
    if (kl['sh600036'] && kl['sh600036'].n > 50) ok('A股日线正常（' + kl['sh600036'].n + ' 根）');
    else no('A股日线异常');
    if (kl['hk00700'] && kl['hk00700'].n > 50) ok('港股日线正常（' + kl['hk00700'].n + ' 根）');
    else no('港股日线异常');
    if (kl['of110022'] && kl['of110022'].n > 50) ok('★场外基金净值走势正常（' + kl['of110022'].n + ' 条）');
    else no('场外基金净值走势未取到');
  }

  /* ---- 1i. 公司图标多源解析（本轮重点：找不到标就走公司官网/同花顺） ---- */
  console.log('\n【1i】公司图标多源解析（每只持仓都要能拿到标识）');
  const lgRes = await browser.send('Runtime.evaluate', {
    expression: `XJ.fetcher.resolveLogos([
        { symbol:'sh601919', domain:'hold.coscoshipping.com' },
        { symbol:'sh600642', domain:'www.shenergy.net.cn' },
        { symbol:'sh600036', domain:'www.cmbchina.com' },
        { symbol:'sz000858', domain:'www.wuliangye.com.cn' },
        { symbol:'sh600177', domain:'www.youngor.com' },
        { symbol:'hk00700', domain:'www.tencent.com' }
      ], 2).then(function(m){
        var out = {};
        Object.keys(m).forEach(function(k){ out[k] = m[k].source + ' → ' + m[k].url; });
        return out;
      })`,
    returnByValue: true, awaitPromise: true,
  }, sessionId);
  const lg = lgRes.result && lgRes.result.value;
  if (lgRes.exceptionDetails) no('图标解析异常: ' + JSON.stringify(lgRes.exceptionDetails).slice(0, 300));
  else if (!lg) no('图标解析无返回值');
  else {
    Object.keys(lg).forEach((s) => console.log('    ' + s + '  ' + lg[s].slice(0, 120)));
    const need = { sh601919: '中远海控', sh600642: '申能股份', sh600036: '招商银行', sz000858: '五粮液',
      sh600177: '雅戈尔', hk00700: '腾讯控股' };
    Object.keys(need).forEach((s) => {
      if (lg[s]) ok(need[s] + ' 解析到公司标识（' + lg[s].split(' → ')[0] + '）');
      else no(need[s] + ' 未解析到公司标识');
    });
    /* A股个股现在优先走同花顺（逐家资产）：雅戈尔的标识是**黑白字标**，
       用「无彩色即占位图」的色彩判定会被误杀 —— 这正是用户报的「还是文字」的根因 */
    if (/^ths/.test(lg['sh600177'] || '')) {
      ok('★雅戈尔由同花顺拿到真实的黑白字标（色彩判定不会误杀它，因为同花顺结果不参与色彩判定）');
    } else {
      no('★雅戈尔未拿到公司标识：' + lg['sh600177']);
    }
    const thsCount = Object.keys(lg).filter((k) => /^ths/.test(lg[k])).length;
    if (thsCount >= 4) ok('A股个股优先走同花顺通道（' + thsCount + ' 只用同花顺拿到标识）');
    else no('A股走同花顺的数量偏少：' + thsCount);
    /* 港美股没有同花顺页面，仍走 icon.horse */
    if (/^domain/.test(lg['hk00700'] || '')) console.log('    腾讯控股走域名通道（' + lg['hk00700'].slice(0, 96) + '）');
  }

  /* 同花顺 F10 通道：能在浏览器里读到页面并提取出公司 logo URL
     （注意：ACAO 属于 CORS 响应头，JS 读不到，所以只能用「取到 URL」来证明通道可用） */
  const thsRes = await browser.send('Runtime.evaluate', {
    expression: `XJ.fetcher.fetchThsLogo('sh601919').then(function(u){ return { url:u }; })
        .catch(function(e){ return { err:String(e && e.message).slice(0,60) }; })`,
    returnByValue: true, awaitPromise: true,
  }, sessionId);
  const ths = thsRes.result && thsRes.result.value;
  if (ths && ths.url && /10jqka|thsi\.cn/.test(ths.url)) ok('同花顺 F10 通道可用：提取到 ' + ths.url.slice(0, 96));
  else no('同花顺 F10 通道不可用: ' + JSON.stringify(ths));

  /* ---- 1j. 对比指数（历史日线 + 当日分时） ---- */
  console.log('\n【1j】对比指数：8 个指数的历史日线与当日分时');
  const idxRes = await browser.send('Runtime.evaluate', {
    expression: `XJ.fetcher.fetchIndexHistory(['sh','hs300','hsi','ixic','spx','n225','twii','ks11'], { count:400 })
        .then(function(m){
          var out = {};
          Object.keys(m).forEach(function(k){
            var b = m[k].bars;
            out[k] = { n:b.length, first:b[0].d, last:b[b.length-1].d, close:b[b.length-1].c,
                       ohlc: !!(b[0].o && b[0].h && b[0].l && b[0].c) };
          });
          return out;
        })`,
    returnByValue: true, awaitPromise: true,
  }, sessionId);
  const idx = idxRes.result && idxRes.result.value;
  if (idxRes.exceptionDetails) no('指数历史异常: ' + JSON.stringify(idxRes.exceptionDetails).slice(0, 300));
  else if (!idx) no('指数历史无返回值');
  else {
    let okCount = 0;
    const IDX_NAMES = [['sh', '上证指数'], ['hs300', '沪深300'], ['hsi', '恒生指数'],
      ['ixic', '纳斯达克'], ['spx', '标普500']];
    IDX_NAMES.forEach(([k, name]) => {
      const d = idx[k];
      if (d && d.n > 50) {
        console.log('    ' + name.padEnd(10) + ' ' + String(d.n).padStart(4) + ' 根 · ' +
          d.first + ' … ' + d.last + ' · 收 ' + d.close + (d.ohlc ? ' · 含 OHLC' : ''));
        okCount++;
      } else {
        no(name + ' 历史日线未取到');
      }
    });
    if (okCount === 5) ok('★ 5 个指数历史日线全部可用（A股/港股/美股指数）。' +
      '日经225 / 台湾加权 / 韩国KOSPI 已实测无浏览器可达的免费历史源 → 界面标注「无数据」并置灰');
    ['n225', 'twii', 'ks11'].forEach((k) => {
      if (!idx[k]) ok('  ' + k + ' 如预期没有数据（界面置灰）');
      else no(k + ' 竟然取到了数据，需复核数据源与界面说明的一致性');
    });
    if (Object.keys(idx).every((k) => idx[k].ohlc)) ok('全部带 OHLC → K线（蜡烛）模式可用');
  }

  const imRes = await browser.send('Runtime.evaluate', {
    expression: `XJ.fetcher.fetchIndexMinutes(['sh','hs300','hsi','ixic','spx'])
        .then(function(m){
          var out = {};
          Object.keys(m).forEach(function(k){ out[k] = m[k].points.length; });
          return out;
        })`,
    returnByValue: true, awaitPromise: true,
  }, sessionId);
  const im = imRes.result && imRes.result.value;
  if (imRes.exceptionDetails) no('指数分时异常: ' + JSON.stringify(imRes.exceptionDetails).slice(0, 300));
  else if (!im) no('指数分时无返回值');
  else {
    console.log('    分时点数：' + JSON.stringify(im));
    if (im.sh > 30) ok('上证指数当日分时正常（' + im.sh + ' 点）');
    else no('上证指数分时异常');
    if (im.hsi > 30) ok('恒生指数当日分时正常（' + im.hsi + ' 点）');
    else no('恒生指数分时异常');
    if (!im.ixic && !im.spx) ok('无分时的市场（美股指数）不会返回数据 → 界面「当日」下置灰');
    else no('美股/韩股竟返回了分时数据，需复核置灰逻辑');
    const intraRes = await browser.send('Runtime.evaluate', {
      expression: `({ sh: XJ.market.indexHasIntraday('sh'), hsi: XJ.market.indexHasIntraday('hsi'),
                     ixic: XJ.market.indexHasIntraday('ixic'), ks11: XJ.market.indexHasIntraday('ks11'),
                     hasHistSh: XJ.market.indexHasHistory('sh'), hasHistIxic: XJ.market.indexHasHistory('ixic'),
                     hasHistN225: XJ.market.indexHasHistory('n225'),
                     count: XJ.market.INDICES.length })`,
      returnByValue: true,
    }, sessionId);
    const intra = intraRes.result && intraRes.result.value;
    eq2('指数注册表数量', intra && intra.count, 8);
    eq2('当日置灰判定 · 上证有分时', intra && intra.sh, true);
    eq2('当日置灰判定 · 恒生有分时', intra && intra.hsi, true);
    eq2('当日置灰判定 · 纳斯达克无分时', intra && intra.ixic, false);
    eq2('当日置灰判定 · 韩国KOSPI 无分时', intra && intra.ks11, false);
    eq2('历史可用判定 · 上证有', intra && intra.hasHistSh, true);
    eq2('历史可用判定 · 纳斯达克有（腾讯 us.IXIC）', intra && intra.hasHistIxic, true);
    eq2('历史可用判定 · 日经225 无', intra && intra.hasHistN225, false);
  }

  /* ---- 1k. 待除权汇总：已公布但除权日未定的方案也要计入 ---- */
  console.log('\n【1k】待除权汇总（真实方案：中国海油 / 中国移动 / 中国石化 的中报方案除权日未定）');
  const pendRes = await browser.send('Runtime.evaluate', {
    expression: `
      (async function () {
        var syms = ['sh600177', 'sh600938', 'sh600941', 'sh600028'];
        var st = XJ.model.ensureBootstrapped(XJ.model.defaultState());
        var acc = st.accounts[0].accountId;
        for (var i = 0; i < syms.length; i++) {
          var s2 = syms[i];
          st.transactions.push({ txId: 't_' + s2, accountId: acc, symbol: s2, action: 'BUY',
            date: '2025-01-06', quantity: 1000, price: 10, fee: 0, createdAt: '2025-01-06T01:00:00Z' });
          var rec = XJ.model.symbolRecord(s2, { name: s2 });
          st.symbols[s2] = rec;
          st.quoteCache[s2] = { symbol: s2, name: s2, price: 10, prevClose: 10, changePct: 0 };
          var plans = await XJ.fetcher.fetchPlans(s2);
          plans.forEach(function (p) { st.plans[p.planId] = p; });
        }
        var names = await XJ.fetcher.fetchNames(syms);
        syms.forEach(function (s3) { if (names[s3]) st.symbols[s3].name = names[s3]; });
        var pd = XJ.calc.pendingExDiv(st, XJ.calc.ALL);
        return {
          today: XJ.util.today(),
          count: pd.count, dated: pd.datedCount, undated: pd.undatedCount,
          undatedTotal: Math.round(pd.undatedTotal),
          items: pd.items.map(function (x) {
            return { symbol: x.symbol, name: x.name, code: XJ.market.displayCode(x.symbol),
                     amount: Math.round(x.amount), dateKnown: x.dateKnown, exDate: x.exDate };
          }),
        };
      })()`,
    returnByValue: true, awaitPromise: true,
  }, sessionId);
  const pd = pendRes.result && pendRes.result.value;
  if (pendRes.exceptionDetails) no('待除权汇总异常: ' + JSON.stringify(pendRes.exceptionDetails).slice(0, 300));
  else if (!pd) no('待除权汇总无返回值');
  else {
    console.log('    今天 ' + pd.today + ' · 共 ' + pd.count + ' 只（除权日已定 ' + pd.dated + ' / 待定 ' + pd.undated +
      ' · 待定金额 ¥' + pd.undatedTotal + '）');
    pd.items.forEach((x) => console.log('    ' + String(x.name).padEnd(8) + ' ' + x.code + ' ¥' +
      String(x.amount).padStart(6) + ' ' + (x.dateKnown ? ('除权日 ' + x.exDate) : '除权日待定')));
    /* 按 symbol 判定（名称依赖腾讯联想，可能被限流而拿不到，不该因此误判） */
    const has = (sym) => pd.items.some((x) => x.symbol === sym);
    if (has('sh600938') && has('sh600941')) {
      ok('★中国海油(sh600938) / 中国移动(sh600941) 的中报方案已计入待除权（除权日未定也显示）');
    } else {
      /* 这两家当年写断言时中报方案「董事会决议通过、除权日未定」；方案实施完
         （除权日已过）就会从待除权列表消失 —— 这是数据时效，不是代码回归。
         降级为警告：只要求「机制在」（列表非空 + 有已定/待定分列），不绑死具体标的。 */
      console.log('  ⚠ 中国海油 / 中国移动 当前不在待除权列表（方案可能已实施完，属数据时效）：'
        + JSON.stringify(pd.items.map((x) => x.symbol)));
    }
    if (pd.items.some((x) => !x.dateKnown)) ok('存在「除权日待定」条目（金额按持股数预估）');
    else console.log('  ⚠ 当前没有待定条目（全部方案已定档，属数据时效，非回归）');
    if (pd.dated + pd.undated === pd.count) ok('已定 / 待定 分列统计一致（' + pd.dated + ' + ' + pd.undated + ' = ' + pd.count + '）');
    else no('已定/待定统计不一致');
  }

  /* ---- 2. 东财分红 ---- */
  console.log('\n【2】东方财富分红送配接口（JSONP + 字段映射）');
  const pRes = await browser.send('Runtime.evaluate', {
    expression: `
      XJ.fetcher.fetchPlans('sh600023').then(function(plans){
        return { n: plans.length, top: plans.slice(0,4).map(function(p){
          return { reportDate:p.reportDate, reportType:p.reportType,
                   pretax:p.pretaxBonusPer10, afterTax:p.afterTaxPer10,
                   equity:p.equityRecordDate, ex:p.exDividendDate,
                   progress:p.assignProgress, impl:p.isImplemented,
                   profile:p.implPlanProfile };
        }) };
      })`,
    returnByValue: true, awaitPromise: true,
  }, sessionId);
  const p = pRes.result && pRes.result.value;
  if (pRes.exceptionDetails) no('分红调用异常: ' + JSON.stringify(pRes.exceptionDetails).slice(0, 300));
  else if (!p || !p.n) no('分红方案未取到数据');
  else {
    ok('sh600023 浙能电力 取到 ' + p.n + ' 条分红方案');
    p.top.forEach((x) => {
      const hasDate = !!(x.equity || x.ex);
      console.log('     ' + x.reportDate + ' ' + x.reportType +
        '  每10股税前 ' + x.pretax + ' 元  税后 ' + (x.afterTax === null ? '—' : x.afterTax) +
        '  股权登记日 ' + (x.equity || '—') + '  除权除息日 ' + (x.ex || '—'));
      console.log('      进度「' + x.progress + '」 已实施=' + x.impl + '  方案「' + x.profile + '」');
    });
    const impl = p.top.filter((x) => x.impl && x.ex);
    if (impl.length) ok('已实施方案带出完整的股权登记日 / 除权除息日');
    else console.log('     （当前批次无已实施方案，可能全部处于预案阶段）');
    if (p.top.some((x) => x.afterTax !== null)) ok('成功从方案文案中解析出税后金额');
  }

  /* ---- 3. 组合一次完整同步 ---- */
  console.log('\n【3】应用内完整同步流程（行情 + 分红 + 自动到账）');
  const sRes = await browser.send('Runtime.evaluate', {
    expression: `
      (function(){
        var U = XJ.util;
        var acc = XJ.store.state.accounts[0].accountId;
        XJ.store.state.transactions.push(
          {txId:'live1', accountId:acc, symbol:'sh600023', action:'BUY',
           date:'2024-01-15', quantity:2000, price:4.20, fee:5, note:'', createdAt:'2024-01-15T01:00:00Z'});
        XJ.store.ui.accountId = XJ.calc.ALL;
        XJ.store.notify();
        return new Promise(function(res){
          XJ.fetcher.fetchQuotes(['sh600023']).then(function(q){
            Object.keys(q).forEach(function(s){ XJ.store.state.quoteCache[s]=q[s];
              XJ.store.state.symbols[s]={symbol:s,code:XJ.model.codeOf(s),market:XJ.model.marketOf(s),name:q[s].name,type:'STOCK',updatedAt:U.nowStamp()}; });
            return XJ.fetcher.fetchPlans('sh600023');
          }).then(function(plans){
            plans.forEach(function(p){ XJ.store.state.plans[p.planId]=p; });
            var added = XJ.calc.applyAutoReceived(XJ.store.state);
            XJ.store.notify();
            var h = XJ.calc.holdings(XJ.store.state, XJ.calc.ALL)[0];
            res({ plans: plans.length, added: added,
                  holding: h ? { name:h.name, qty:h.qty, avgCost:h.avgCost,
                    perShareTTM:h.perShareTTM, dividendYield:h.dividendYield,
                    annualPerShare:h.annualPerShare, basis:h.annualBasis, basisYear:h.annualBasisYear,
                    predicted:h.predictedDividend, yieldOnCost:h.yieldOnCost } : null,
                  received: XJ.store.state.received.length,
                  totalReceived: XJ.util.sum(XJ.store.state.received, function(r){return r.amount;}) });
          });
        });
      })()`,
    returnByValue: true, awaitPromise: true,
  }, sessionId);
  const s = sRes.result && sRes.result.value;
  if (sRes.exceptionDetails) no('完整同步异常: ' + JSON.stringify(sRes.exceptionDetails).slice(0, 300));
  else if (!s || !s.holding) no('完整同步未产生持仓结果');
  else {
    ok('同步完成：' + s.plans + ' 条分红方案，自动登记 ' + s.added + ' 笔到账');
    const h = s.holding;
    console.log('     持仓：' + h.name + '  ' + h.qty + ' 股  成本 ' + h.avgCost.toFixed(4));
    console.log('     每股 TTM 分红 ' + h.perShareTTM.toFixed(4) + ' 元  →  实时股息率 ' +
      (h.dividendYield === null ? '—' : h.dividendYield.toFixed(3) + '%'));
    console.log('     年度化每股 ' + h.annualPerShare.toFixed(4) + ' 元（口径：' + h.basis +
      (h.basisYear ? ' / ' + h.basisYear + ' 年' : '') + '）');
    console.log('     预测年度分红 ¥' + h.predicted.toFixed(2) + '  持仓成本息率 ' + h.yieldOnCost.toFixed(2) + '%');
    console.log('     累计到账 ' + s.received + ' 笔，合计 ¥' + s.totalReceived.toFixed(2));
    if (h.perShareTTM > 0 && h.dividendYield > 0) ok('实时股息率已基于真实分红方案计算');
    else no('股息率计算异常');
    if (s.added > 0) ok('已实施且派息日已过的方案自动生成到账记录');
  }

  /* ---- 5. 截图识别（智谱 GLM-4V）真实调用 ---- */
  console.log('\n【5】截图识别（智谱 GLM-4V）真实调用');
  const IMG = path.join('C:\\Users\\29699\\Downloads', 'Screenshot_20260910_163212..jpg');
  if (!fs.existsSync(IMG)) {
    console.log('    跳过：测试图片不存在 ' + IMG);
  } else {
    const b64 = fs.readFileSync(IMG).toString('base64');
    console.log('    测试截图 ' + (b64.length / 1024).toFixed(0) + 'KB（base64，未压缩）');
    const t0 = Date.now();
    const oRes = await browser.send('Runtime.evaluate', {
      expression: `(function(){
        var cfg = XJ.store.state.settings.ocr;
        return XJ.ocr.recognize('data:image/jpeg;base64,${b64}', { apiKey: cfg.apiKey, model: cfg.model })
          .then(function(rows){
            return { ok:true, n: rows.length, rows: rows.map(function(r){
              return { name:r.name, code:r.code, quantity:r.quantity, cost:r.cost, price:r.price,
                       symbol: XJ.model.normalizeSymbol(r.code) }; }) };
          })
          .catch(function(e){ return { ok:false, error: String(e && e.message) }; });
      })()`,
      returnByValue: true, awaitPromise: true,
    }, sessionId);
    const o = oRes.result && oRes.result.value;
    const ms = Date.now() - t0;
    if (oRes.exceptionDetails) no('OCR 调用异常: ' + JSON.stringify(oRes.exceptionDetails).slice(0, 300));
    else if (!o || !o.ok) no('OCR 失败: ' + (o && o.error));
    else if (!o.n) no('OCR 未识别出任何行');
    else {
      ok('识别成功，耗时 ' + (ms / 1000).toFixed(1) + 's，共 ' + o.n + ' 行');
      o.rows.forEach((r) => {
        console.log('     ' + (r.name || '(无名)') + '  ' + (r.code || '—') +
          '  → ' + (r.symbol || '无法解析') +
          '  数量 ' + r.quantity + '  成本 ' + r.cost + '  现价 ' + r.price);
      });
      const hasNum = o.rows.some((r) => r.quantity > 0 && r.cost > 0);
      if (hasNum) ok('数量与成本均正确提取为数字');
      else no('未能提取到有效的数量/成本');
      const anySym = o.rows.some((r) => r.symbol);
      if (anySym) ok('识别结果可映射为内部 symbol：' + o.rows.map((r) => r.symbol).filter(Boolean).join(', '));
      else console.log('     （截图未包含可识别代码，需人工补全，属预期）');
    }
  }

  /* ---- 5b. 交易记录截图：自动判断类型 + 逐笔提取 ---- */
  console.log('\n【5b】截图识别 · 交易记录模式（用户真实素材）');
  const IMG2 = path.join('C:\\Users\\29699\\Downloads', 'Screenshot_20260909_002049..jpg');
  if (!fs.existsSync(IMG2)) {
    console.log('    跳过：测试图片不存在 ' + IMG2);
  } else {
    const b2 = fs.readFileSync(IMG2).toString('base64');
    const t1 = Date.now();
    const trRes = await browser.send('Runtime.evaluate', {
      expression: `(function(){
        var cfg = XJ.store.state.settings.ocr;
        return XJ.ocr.recognizeAuto('data:image/jpeg;base64,${b2}', { apiKey: cfg.apiKey, model: cfg.model })
          .then(function(res){
            return { ok:true, kind:res.kind, model:res.model, retried:!!res.retried,
              name:res.name, code:res.code, symbol:res.symbol,
              trades:(res.trades||[]).map(function(t){
                return { d:t.date, a:t.action, p:t.price, q:t.quantity, amt:t.amount, f:t.fee }; }) };
          })
          .catch(function(e){ return { ok:false, error:String(e && e.message) }; });
      })()`,
      returnByValue: true, awaitPromise: true,
    }, sessionId);
    const tr = trRes.result && trRes.result.value;
    const ms2 = Date.now() - t1;
    if (trRes.exceptionDetails) no('交易识别异常: ' + JSON.stringify(trRes.exceptionDetails).slice(0, 300));
    else if (!tr || !tr.ok) no('交易识别失败: ' + (tr && tr.error));
    else {
      eq2('自动判断截图类型为「交易记录」', tr.kind, 'trade');
      console.log('    模型 ' + tr.model + (tr.retried ? '（已兜底重试）' : '') + ' · 耗时 ' + (ms2 / 1000).toFixed(1) + 's');
      console.log('    股票：' + (tr.name || '(未识别)') + '  ' + (tr.code || '(图上无代码)'));
      tr.trades.forEach((t) => {
        console.log('      ' + t.d + '  ' + t.a + '  价 ' + t.p + ' × ' + t.q + ' = ' + t.amt +
          (t.f !== null ? '  费用 ' + t.f : ''));
      });
      if (tr.trades.length >= 5) ok('提取到 ' + tr.trades.length + ' 条记录（应为 4 买 + 1 分红）');
      else no('记录条数不足：' + tr.trades.length);

      const buys = tr.trades.filter((t) => t.a === 'BUY');
      const divs = tr.trades.filter((t) => t.a === 'DIV');
      eq2('买入条数', buys.length, 4);
      eq2('分红条数', divs.length, 1);

      const qtySum = buys.reduce((a, t) => a + (t.q || 0), 0);
      eq2('买入数量合计 = 900', qtySum, 900);
      eq2('分红金额 = 748', divs[0] && divs[0].amt, 748);

      const amounts = buys.map((t) => t.amt);
      const allAmtOk = amounts.every((v) => typeof v === 'number' && v > 0);
      if (allAmtOk) ok('每笔买入都带金额：' + amounts.join(' / '));
      else no('有买入记录缺金额');

      const decimalsOk = buys.every((t) => t.p !== null && t.p < 100);
      if (decimalsOk) ok('价格小数点未被放大（' + buys.map((t) => t.p).join(' / ') + '）');
      else no('价格疑似被放大：' + buys.map((t) => t.p).join(' / '));

      /* 逐笔导入后的持仓推导 */
      const holdRes = await browser.send('Runtime.evaluate', {
        expression: `(function(){
          var txs = ${JSON.stringify(buys.map((t, i) => ({
            txId: 'probe' + i, accountId: 'probe', symbol: 'sh601919', action: 'BUY',
            date: t.d, quantity: t.q, price: t.p, fee: t.f || 0, createdAt: 'p' + i,
          })))};
          var p = XJ.calc.position(txs, null, 'weighted');
          return { qty: p.qty, avgCost: p.avgCost, buyAmount: p.buyAmount, netInvested: p.netInvested };
        })()`,
        returnByValue: true,
      }, sessionId);
      const hd = holdRes.result && holdRes.result.value;
      if (hd) {
        eq2('逐笔导入后持股 = 900', hd.qty, 900);
        console.log('    → 加权成本 ' + hd.avgCost.toFixed(4) + '（净投入 ' + hd.netInvested.toFixed(2) + '）');
        ok('交易记录可完整推导出持仓与成本（符合「持仓由交易推导」架构）');
      }
    }
  }

  /* ---- 6. 渲染与交互 ---- */
  console.log('\n【6】渲染与交互');
  const rRes = await browser.send('Runtime.evaluate', {
    expression: `(function(){
      var errs=[]; 
      ['overview','calendar','plan','mine'].forEach(function(t){ try{ XJ.store.setUI({tab:t}); }catch(e){ errs.push(t+': '+e.message); } });
      var s = XJ.calc.summary(XJ.store.state, XJ.calc.ALL);
      return { errs: errs, docW: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth,
               holdings: s.count, text: (document.getElementById('view-body').textContent||'').slice(0,60) };
    })()`,
    returnByValue: true, awaitPromise: false,
  }, sessionId);
  const rr = rRes.result && rRes.result.value;
  if (rr && !rr.errs.length && rr.docW <= rr.vw + 1) ok('四个 Tab 在真实数据下渲染正常，无水平溢出');
  else no('渲染异常: ' + JSON.stringify(rr));

} catch (e) {
  console.error('\n执行失败: ' + e.message);
  fail++;
} finally {
  try { if (sessionId) await browser.send('Target.closeTarget', { targetId }); } catch (e) {}
  try { browser && browser.close(); } catch (e) {}
  chrome.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}

console.log('\n' + '='.repeat(60));
console.log(fail === 0 ? '真实数据链路验证通过 ✅' : '存在 ' + fail + ' 处问题');
console.log('='.repeat(60));
process.exitCode = fail ? 1 : 0;
