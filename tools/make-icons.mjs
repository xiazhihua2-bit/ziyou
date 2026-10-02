/* 一次性工具：生成 PWA 的 4 张 PNG 图标 → assets/icons/
 *
 * 项目零依赖，所以不引 npm 图形库，改用「CDP 驱动 headless Chrome + Canvas 2D」画好再导出 PNG，
 * 复用的正是 uitest.mjs 里已验证的那套 CDP 模式。
 *
 * 图标设计：稿 B「光斑水滴」（2026-10 定稿）—— 玻璃水滴内含橙红「分红」色斑，
 * 意象是「息如水滴积攒」。maskable 版整体收进中心 80% 安全区。
 *
 * 用法： node tools/make-icons.mjs
 * 只有主色或图形变了才需要重跑；产物提交进仓库，build.mjs 只做复制。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'assets', 'icons');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9401;

const TARGETS = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'apple-touch-icon.png', size: 180, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
];

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); } }, 40000);
    });
  }
}

function drawExpr(size, maskable) {
  return `(function(){
  var S=${size}, MASK=${maskable}, c=document.createElement('canvas'); c.width=c.height=S;
  var g=c.getContext('2d');
  var u=S/512;
  /* 背景：冷调浅灰蓝渐变（maskable 需要铺满全画布，内容收进中心 80% 安全区） */
  var bg=g.createLinearGradient(0,0,0,S);
  bg.addColorStop(0,'#F2F4F9'); bg.addColorStop(1,'#E4E9F4');
  g.fillStyle=bg; g.fillRect(0,0,S,S);
  var cx=S/2, cy=S*0.55, R=S*0.30;
  if (MASK) {
    /* 水滴总高约 R*2.6，整体缩到中心 80% 圆内：R × 0.72 且居中 */
    R = S*0.216;
    cx = S/2; cy = S/2 + R*0.12;
  }
  /* 水滴投影 */
  g.save(); g.shadowColor='rgba(40,60,90,.28)'; g.shadowBlur=44*u; g.shadowOffsetY=16*u;
  var body=g.createRadialGradient(cx-R*0.35,cy-R*0.45,R*0.1,cx,cy,R);
  body.addColorStop(0,'rgba(255,255,255,.98)');
  body.addColorStop(0.55,'rgba(235,240,250,.92)');
  body.addColorStop(1,'rgba(205,216,238,.88)');
  g.fillStyle=body;
  g.beginPath();
  /* 上尖下圆的滴形 */
  g.moveTo(cx, cy-R*1.52);
  g.bezierCurveTo(cx+R*0.92, cy-R*0.42, cx+R, cy+R*0.18, cx+R*0.86, cy+R*0.52);
  g.bezierCurveTo(cx+R*0.68, cy+R*1.02, cx-R*0.68, cy+R*1.02, cx-R*0.86, cy+R*0.52);
  g.bezierCurveTo(cx-R, cy+R*0.18, cx-R*0.92, cy-R*0.42, cx, cy-R*1.52);
  g.closePath(); g.fill(); g.restore();
  /* 滴内橙红「分红」色斑（下缘光晕） */
  var inner=g.createRadialGradient(cx, cy+R*0.55, R*0.05, cx, cy+R*0.4, R*0.95);
  inner.addColorStop(0,'rgba(232,70,31,.78)');
  inner.addColorStop(0.5,'rgba(240,122,60,.38)');
  inner.addColorStop(1,'rgba(240,122,60,0)');
  g.fillStyle=inner;
  g.beginPath();
  g.moveTo(cx, cy-R*1.52);
  g.bezierCurveTo(cx+R*0.92, cy-R*0.42, cx+R, cy+R*0.18, cx+R*0.86, cy+R*0.52);
  g.bezierCurveTo(cx+R*0.68, cy+R*1.02, cx-R*0.68, cy+R*1.02, cx-R*0.86, cy+R*0.52);
  g.bezierCurveTo(cx-R, cy+R*0.18, cx-R*0.92, cy-R*0.42, cx, cy-R*1.52);
  g.closePath(); g.fill();
  /* 滴身高光描边 */
  g.strokeStyle='rgba(255,255,255,.95)'; g.lineWidth=5*u;
  g.beginPath();
  g.moveTo(cx, cy-R*1.52);
  g.bezierCurveTo(cx+R*0.92, cy-R*0.42, cx+R, cy+R*0.18, cx+R*0.86, cy+R*0.52);
  g.bezierCurveTo(cx+R*0.68, cy+R*1.02, cx-R*0.68, cy+R*1.02, cx-R*0.86, cy+R*0.52);
  g.bezierCurveTo(cx-R, cy+R*0.18, cx-R*0.92, cy-R*0.42, cx, cy-R*1.52);
  g.closePath(); g.stroke();
  /* 左上反光弧 */
  g.strokeStyle='rgba(255,255,255,1)'; g.lineWidth=10*u; g.lineCap='round';
  g.beginPath(); g.arc(cx-R*0.1, cy-R*0.28, R*0.52, Math.PI*1.05, Math.PI*1.55); g.stroke();
  /* 右下小光点 */
  g.fillStyle='rgba(255,255,255,.85)';
  g.beginPath(); g.arc(cx+R*0.42, cy+R*0.52, R*0.07, 0, Math.PI*2); g.fill();
  return c.toDataURL('image/png');
})()`;
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-icon-'));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
      if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; }
    } catch (e) { /* retry */ }
    await sleep(150);
  }
  if (!wsUrl) { chrome.kill(); throw new Error('Chrome DevTools 未能启动'); }

  const cdp = new CDP(wsUrl);
  await cdp.connect();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);

  for (const t of TARGETS) {
    const res = await cdp.send('Runtime.evaluate', {
      expression: drawExpr(t.size, t.maskable), returnByValue: true,
    }, sessionId);
    if (res.exceptionDetails) throw new Error('绘制失败: ' + JSON.stringify(res.exceptionDetails).slice(0, 200));
    const dataUrl = res.result.value;
    const b64 = String(dataUrl).replace(/^data:image\/png;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    fs.writeFileSync(path.join(OUT_DIR, t.file), buf);
    console.log('  ✓ ' + t.file.padEnd(26) + t.size + '×' + t.size +
      (t.maskable ? ' (maskable)' : '') + '  ' + (buf.length / 1024).toFixed(1) + ' KB');
  }

  chrome.kill();
  console.log('\n输出目录: ' + OUT_DIR);
  console.log('设计：光斑水滴（玻璃水滴 + 橙红「分红」色斑）');
}

main().catch((e) => { console.error('生成图标失败:', e.message); process.exit(1); });
