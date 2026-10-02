/* 一次性工具：生成「自由」图形化图标 3 稿设计小样 → shots/icon-drafts/
 * 稿 A：玻璃圆角方块叠层（账本层层 · 底层橙红透出）
 * 稿 B：光斑水滴（玻璃水滴内含分红橙红斑）
 * 稿 C：四瓣玻璃花（复利生长 · 中心橙红圆点）
 * 仅供挑选，定稿后把选定 drawExpr 移植进 make-icons.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'shots', 'icon-drafts');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9403;

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

/* ---------- 公共：圆角矩形路径 ---------- */
const rrPath = `function rr(g,x,y,w,h,r){g.beginPath();g.moveTo(x+r,y);g.arcTo(x+w,y,x+w,y+h,r);g.arcTo(x+w,y+h,x,y+h,r);g.arcTo(x,y+h,x,y,r);g.arcTo(x,y,x+w,y,r);g.closePath();}`;

/* ---------- 稿 A：玻璃方块叠层 ---------- */
function draftA(size) {
  return `(function(){
  var S=${size}, c=document.createElement('canvas'); c.width=c.height=S;
  var g=c.getContext('2d'); ${rrPath}
  var u=S/512;
  /* 背景：暖白到浅琥珀的柔和渐变（浅色系统感） */
  var bg=g.createLinearGradient(0,0,S,S);
  bg.addColorStop(0,'#FDF9F3'); bg.addColorStop(1,'#F6E9DC');
  g.fillStyle=bg; g.fillRect(0,0,S,S);
  /* 底层：橙红渐变大圆角块 */
  var x=64*u,y=88*u,w=384*u,h=340*u,r=96*u;
  var grad=g.createLinearGradient(x,y,x+w,y+h);
  grad.addColorStop(0,'#F0713C'); grad.addColorStop(1,'#E8461F');
  g.save(); g.shadowColor='rgba(232,70,31,.35)'; g.shadowBlur=40*u; g.shadowOffsetY=14*u;
  g.fillStyle=grad; rr(g,x,y,w,h,r); g.fill(); g.restore();
  /* 玻璃层 1（右上错位） */
  g.save();
  g.shadowColor='rgba(30,30,40,.18)'; g.shadowBlur=26*u; g.shadowOffsetY=10*u;
  g.fillStyle='rgba(255,255,255,.55)';
  rr(g,x+w*0.34,y-h*0.16,w*0.62,h*0.52,r*0.62); g.fill(); g.restore();
  g.strokeStyle='rgba(255,255,255,.85)'; g.lineWidth=2.5*u;
  rr(g,x+w*0.34,y-h*0.16,w*0.62,h*0.52,r*0.62); g.stroke();
  /* 玻璃层 2（左下错位，压住橙红块一角） */
  g.save();
  g.shadowColor='rgba(30,30,40,.16)'; g.shadowBlur=22*u; g.shadowOffsetY=8*u;
  g.fillStyle='rgba(255,255,255,.42)';
  rr(g,x-w*0.10,y+h*0.52,w*0.56,h*0.44,r*0.55); g.fill(); g.restore();
  g.strokeStyle='rgba(255,255,255,.8)'; g.lineWidth=2.5*u;
  rr(g,x-w*0.10,y+h*0.52,w*0.56,h*0.44,r*0.55); g.stroke();
  /* 顶部高光弧 */
  g.strokeStyle='rgba(255,255,255,.9)'; g.lineWidth=5*u; g.lineCap='round';
  g.beginPath(); g.arc(x+w/2, y+h*0.16, w*0.30, Math.PI*1.15, Math.PI*1.85); g.stroke();
  return c.toDataURL('image/png');
})()`;
}

/* ---------- 稿 B：光斑水滴 ---------- */
function draftB(size) {
  return `(function(){
  var S=${size}, c=document.createElement('canvas'); c.width=c.height=S;
  var g=c.getContext('2d'); ${rrPath}
  var u=S/512;
  /* 背景：冷调浅灰蓝 */
  var bg=g.createLinearGradient(0,0,0,S);
  bg.addColorStop(0,'#F2F4F9'); bg.addColorStop(1,'#E4E9F4');
  g.fillStyle=bg; g.fillRect(0,0,S,S);
  var cx=S/2, cy=S*0.55, R=S*0.30;
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

/* ---------- 稿 C：四瓣玻璃花 ---------- */
function draftC(size) {
  return `(function(){
  var S=${size}, c=document.createElement('canvas'); c.width=c.height=S;
  var g=c.getContext('2d'); ${rrPath}
  var u=S/512;
  var bg=g.createLinearGradient(0,0,S,S);
  bg.addColorStop(0,'#F7F5F0'); bg.addColorStop(1,'#EFE6DA');
  g.fillStyle=bg; g.fillRect(0,0,S,S);
  var cx=S/2, cy=S/2, R=S*0.26;
  /* 四瓣：上下左右，磨砂玻璃圆瓣 */
  var angles=[-Math.PI/2, 0, Math.PI/2, Math.PI];
  angles.forEach(function(a,i){
    var px=cx+Math.cos(a)*R*0.78, py=cy+Math.sin(a)*R*0.78;
    g.save();
    g.shadowColor='rgba(40,40,50,.20)'; g.shadowBlur=30*u; g.shadowOffsetY=10*u;
    var petal=g.createRadialGradient(px-R*0.3,py-R*0.3,R*0.1,px,py,R*0.9);
    petal.addColorStop(0,'rgba(255,255,255,.95)');
    petal.addColorStop(1,'rgba(236,240,246,.68)');
    g.fillStyle=petal;
    g.beginPath(); g.arc(px,py,R*0.72,0,Math.PI*2); g.fill(); g.restore();
    g.strokeStyle='rgba(255,255,255,.9)'; g.lineWidth=3.5*u;
    g.beginPath(); g.arc(px,py,R*0.72,0,Math.PI*2); g.stroke();
  });
  /* 中心橙红圆点（分红语义） */
  g.save(); g.shadowColor='rgba(232,70,31,.45)'; g.shadowBlur=30*u; g.shadowOffsetY=6*u;
  var core=g.createLinearGradient(cx-R*0.5,cy-R*0.5,cx+R*0.5,cy+R*0.5);
  core.addColorStop(0,'#F0713C'); core.addColorStop(1,'#E8461F');
  g.fillStyle=core;
  g.beginPath(); g.arc(cx,cy,R*0.46,0,Math.PI*2); g.fill(); g.restore();
  g.strokeStyle='rgba(255,255,255,.9)'; g.lineWidth=4*u;
  g.beginPath(); g.arc(cx,cy,R*0.46,0,Math.PI*2); g.stroke();
  return c.toDataURL('image/png');
})()`;
}

const DRAFTS = [
  ['draft-a-panes-192.png', draftA],
  ['draft-b-drop-192.png', draftB],
  ['draft-c-petals-192.png', draftC],
];

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-icon-draft-'));
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
  for (const [file, fn] of DRAFTS) {
    const res = await cdp.send('Runtime.evaluate', { expression: fn(192), returnByValue: true }, sessionId);
    if (res.exceptionDetails) throw new Error(file + ' 绘制失败: ' + JSON.stringify(res.exceptionDetails).slice(0, 300));
    const buf = Buffer.from(String(res.result.value).replace(/^data:image\/png;base64,/, ''), 'base64');
    fs.writeFileSync(path.join(OUT_DIR, file), buf);
    console.log('  ✓ ' + file + '  ' + (buf.length / 1024).toFixed(1) + ' KB');
  }
  chrome.kill();
  console.log('输出: ' + OUT_DIR);
}
main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
