/* 阶段 0 前置验证：真实浏览器里 GitHub API 到底能不能用（只读，不写任何东西）
 *
 * ★ 为什么必须真机测：Node 的 fetch 不执行同源策略，历史测试全部用 Node + 假服务端，
 *   所以「浏览器能不能发出去」这件事从来没被验证过 —— 而它决定整个同步方案是否可行。
 *
 * 跑两遍：
 *   1) origin = about:blank（最严格，等价于 file:// 的 origin:null）
 *   2) origin = https://xiazhihua2-bit.github.io（用户真实使用环境）
 *
 * 断言（任一不过就不该往下做）：
 *   · /user 返回 200
 *   · response.headers.get('etag') 非 null   ← 乐观锁的全部前提
 *   · x-ratelimit-reset / x-ratelimit-remaining / x-oauth-scopes 可读
 *
 * 用法： node tools/sync-cors-probe.mjs   （令牌放项目根 .token）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.join(ROOT, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9361;

const TOKEN = fs.existsSync(path.join(PROJ, '.token')) ? fs.readFileSync(path.join(PROJ, '.token'), 'utf8').trim() : '';
if (!TOKEN) { console.error('[cors-probe] ✗ 项目根没有 .token'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.events = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('WebSocket 连接失败'));
      this.ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.id && this.pending.has(m.id)) {
          const { resolve: rs, reject: rj } = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (m.error) rj(new Error(JSON.stringify(m.error))); else rs(m.result);
        } else if (m.method) this.events.push(m);
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); } }, 40000);
    });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

let fail = 0;
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const ok = (m) => console.log('  ✓ ' + m);

/* 页面内探针：真实 fetch + 读响应头 */
const PROBE = `(async function(token){
  function out(){ return {
    whoami: null, etag: null, reset: null, remaining: null, scopes: null,
    err: null, status: null,
  }; }
  try {
    var r = await fetch('https://api.github.com/user', { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json' } });
    var res = out();
    res.status = r.status;
    res.etag = r.headers.get('etag');
    res.reset = r.headers.get('x-ratelimit-reset');
    res.remaining = r.headers.get('x-ratelimit-remaining');
    res.scopes = r.headers.get('x-oauth-scopes');
    var j = await r.json().catch(function(){ return null; });
    res.whoami = j && j.login ? j.login : null;
    return res;
  } catch (e) {
    var res2 = out();
    res2.err = String(e && e.message || e);
    return res2;
  }
})`;

async function probe(cdp, sessionId, label) {
  const r = await cdp.send('Runtime.evaluate', { expression: `${PROBE}(${JSON.stringify(TOKEN)})`, awaitPromise: true, returnByValue: true }, sessionId);
  return r.result.value || { err: '无返回' };
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-cors-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank',
], { stdio: 'ignore' });

try {
  let wsUrl = null;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch (e) { /* retry */ }
    await sleep(150);
  }
  if (!wsUrl) throw new Error('Chrome DevTools 未能启动');
  const cdp = new CDP(wsUrl);
  await cdp.connect();
  const t = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const a = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const sid = a.sessionId;
  await cdp.send('Page.enable', {}, sid);
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('Network.enable', {}, sid);

  for (const [label, url] of [
    ['origin = about:blank（最严格，近似 file:// 的 null origin）', 'about:blank'],
    ['origin = https://xiazhihua2-bit.github.io（用户真实环境）', 'https://xiazhihua2-bit.github.io/ziyou/'],
  ]) {
    console.log('\n--- ' + label + ' ---');
    if (url !== 'about:blank') {
      await cdp.send('Page.navigate', { url }, sid);
      await sleep(1200);
    }
    const preflight = cdp.events.filter((m) => m.method === 'Network.requestWillBeSent' && /api\.github\.com/.test(m.params.request.url));
    const r = await probe(cdp, sid, label);
    if (r.err) { bad('fetch 失败：' + r.err); continue; }
    if (r.status === 200) ok('GET /user → 200（whoami=' + r.whoami + '）');
    else { bad('GET /user → HTTP ' + r.status); continue; }
    if (r.etag) ok('ETag JS 可读：' + r.etag.slice(0, 24) + (r.etag.length > 24 ? '…' : ''));
    else bad('★ ETag 读不到 —— 乐观锁不可用，必须改道（整个方案的前提）');
    if (r.reset && r.remaining !== null) ok('限流头可读：remaining=' + r.remaining + ' reset=' + r.reset);
    else bad('限流头读不到（403 无法精确退避）');
    console.log('    令牌权限（x-oauth-scopes）: ' + (r.scopes === null ? '（无此头，视为细粒度令牌）' : r.scopes));
    if (preflight.length) console.log('    观测到 ' + preflight.length + ' 条 api.github.com 请求');
  }
  cdp.close();
} catch (e) {
  console.error('[cors-probe] 异常:', e.message);
  fail++;
} finally {
  try { chrome.kill(); } catch (e) {}
}

console.log('\n' + (fail === 0 ? '[cors-probe] 全部通过 ✓ 可以进入阶段 1' : '[cors-probe] 失败 ' + fail + ' 项 ✗'));
process.exitCode = fail === 0 ? 0 : 1;
