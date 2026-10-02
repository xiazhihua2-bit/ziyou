/* ==================== 把 dist/pwa/ 传到 GitHub（你自己的一键部署） ====================
 *
 * 为什么需要它：线上产物是【仓库根目录的静态文件】，而本机 git 没有可用的 GitHub 凭据
 * （凭据管理器在后台弹不出窗口，push 会一直挂住）。于是用 GitHub 的 Contents API
 * 直接把那几份产物 PUT 上去 —— 效果与在网页上「上传 / 覆盖文件」完全一样，只是不用手点。
 *
 * 用法：
 *   1) 把令牌写进一个文件（别粘到聊天里，免得进会话记录）：
 *        仓库根目录建一个名为  .token  的文件，里面只放那一行 ghp_…
 *      （.token 已在 .gitignore 里，不会被提交）
 *   2) node tools/deploy-github.mjs
 *
 * ★ 权限要求：需要 repo（写仓库内容）。经典令牌只要勾了 repo，gist 会连带勾上，
 *   所以同一个令牌既能部署、又能给跨设备同步用。
 *
 * 两个曾经把我自己坑到的细节（都留下一行注释，免得下次重踩）：
 *   · Contents 的 URL 必须带仓库全路径：/repos/{owner}/{repo}/contents[?ref=]
 *     少一段同样是 404，报错只有「Not Found」，很容易误判成权限或文件不存在。
 *   · 令牌权限在响应头 X-OAuth-Scopes 里，不在 JSON body 里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'xiazhihua2-bit';
const REPO = 'ziyou';

/* 仓库根目录要放哪几份文件（目标文件名 → 源文件） */
const FILES = [
  ['index.html', 'dist/pwa/index.html'],
  ['sw.js', 'dist/pwa/sw.js'],
  ['manifest.webmanifest', 'dist/pwa/manifest.webmanifest'],
];

/* ---------------- 读取令牌 ---------------- */
const tokenFile = process.argv[2] || path.join(ROOT, '.token');
let token = '';
try {
  token = fs.readFileSync(tokenFile, 'utf8').trim();
} catch (e) {
  console.error('[deploy] ✗ 读不到令牌文件：' + tokenFile);
  console.error('         请在仓库根目录建一个名为 .token 的文件，里面只写那一行令牌。');
  process.exit(1);
}
if (!token) { console.error('[deploy] ✗ 令牌文件是空的：' + tokenFile); process.exit(1); }
/* 只露前后各几位，够判断「读对了没」而不泄漏 */
console.log('[deploy] 令牌：' + token.slice(0, 4) + '…' + token.slice(-4) + '（长度 ' + token.length + '）');

const API = 'https://api.github.com';
const REPO_API = API + '/repos/' + OWNER + '/' + REPO;
const headers = {
  'Authorization': 'Bearer ' + token,
  'Accept': 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'User-Agent': 'xiji-deploy',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function api(method, url, body) {
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch (e) { /* 有些响应没有 body */ }
  /* ★ 权限在响应头里，不在 body 里 */
  return { status: res.status, data, scopes: res.headers.get('x-oauth-scopes') };
}

/* ---- 0) 先确认令牌是谁、有没有写仓库的权限（免得一次次试到 403） ---- */
const who = await api('GET', API + '/user');
if (who.status === 401) { console.error('[deploy] ✗ 令牌无效或已过期（401）'); process.exit(1); }
if (who.status !== 200) { console.error('[deploy] ✗ 连接 GitHub 失败（HTTP ' + who.status + '）'); process.exit(1); }
const scopes = who.scopes === null || who.scopes === undefined ? null : String(who.scopes);
console.log('[deploy] 令牌属于：' + (who.data && who.data.login) +
  '（权限：' + (scopes === null ? '未返回，通常是细粒度令牌' : (scopes || '（空）')) + '）');

/* ★ 经典令牌最容易踩的坑是「只勾了 gist」：gist 权限只能读写 Gist（同步用），
 *   碰不了仓库文件。此时 GitHub 对写请求返回的是 404，不是 403 ——
 *   很容易被误读成「路径不对」而白折腾。所以提前把话说明白。
 *   ★ 判断权限时务必按逗号切分【并去掉空格】：GitHub 返回的是 "gist, repo"，
 *     直接 split(',').indexOf('repo') 会因为前导空格而漏判 —— 明明有 repo 却被拦下。 */
const scopeList = (scopes || '').split(',').map((s) => s.trim()).filter(Boolean);
if (scopes !== null && scopeList.indexOf('repo') < 0) {
  console.error('\n[deploy] ✗ 这个令牌的权限是「' + (scopes || '空') + '」，没有 repo —— 不能写仓库文件。');
  console.error('         gist 权限只能读写 Gist（跨设备同步用），部署需要 repo。');
  console.error('         去这里重新生成一个（勾 repo 会连带勾上 gist，一个令牌两用）：');
  console.error('         https://github.com/settings/tokens/new?scopes=repo,gist&description=xiji-deploy');
  console.error('         生成后写进 .token，再跑一次本脚本。');
  process.exit(2);
}

const repo = await api('GET', REPO_API);
if (repo.status === 404) {
  console.error('[deploy] ✗ 令牌看不到仓库 ' + OWNER + '/' + REPO + '（需要 repo 权限）');
  process.exit(1);
}
const canPush = repo.data && repo.data.permissions && repo.data.permissions.push;
if (!canPush) { console.error('[deploy] ✗ 令牌对仓库没有写权限'); process.exit(1); }
const branch = (repo.data && repo.data.default_branch) || 'main';
console.log('[deploy] 目标仓库：' + ((repo.data && repo.data.full_name) || OWNER + '/' + REPO) +
  '（默认分支 ' + branch + '，私有=' + (repo.data && repo.data.private) + '）');

/* ---- 1) 逐个上传：先取当前 sha（更新时必须带），再 PUT ---- */
let uploaded = 0;
for (const [name, rel] of FILES) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) { console.error('[deploy] ✗ 缺少产物 ' + rel + '（先跑 node build.mjs）'); process.exit(1); }
  const buf = fs.readFileSync(src);
  const content = buf.toString('base64');
  const itemUrl = REPO_API + '/contents/' + encodeURIComponent(name);
  const cur = await api('GET', itemUrl + '?ref=' + branch);
  const sha = cur.status === 200 && cur.data ? cur.data.sha : null;
  if (cur.status !== 200 && cur.status !== 404) {
    console.error('[deploy] ⚠ 读 ' + name + ' 当前状态失败（HTTP ' + cur.status + '）：' +
      ((cur.data && cur.data.message) || ''));
  }

  const put = await api('PUT', itemUrl, {
    message: 'deploy: ' + name + '（跨设备同步修复 · 扫码配对 · 自检面板）',
    content,
    branch,
    ...(sha ? { sha } : {}),
  });
  if (put.status !== 200 && put.status !== 201) {
    console.error('[deploy] ✗ 上传 ' + name + ' 失败（HTTP ' + put.status + '）：' +
      ((put.data && put.data.message) || '') +
      (put.data && put.data.errors ? ' · ' + JSON.stringify(put.data.errors) : ''));
    console.error('         GET 当前状态 = HTTP ' + cur.status + '（404 表示这个分支下还没有这个文件）');
    process.exit(1);
  }
  uploaded++;
  console.log('[deploy] ✓ ' + name.padEnd(22) + (buf.length / 1024).toFixed(1).padStart(8) + ' KB  ' +
    (sha ? '（已覆盖旧版）' : '（新建）'));
}

/* ---- 2) 自检：真去线上一趟，确认新版已经生效 ---- */
const site = 'https://' + OWNER + '.github.io/' + REPO + '/';
console.log('\n[deploy] 已上传 ' + uploaded + ' 个文件。等 Pages 刷新（最多约 1 分钟）…');
let live = null;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 4000));
  try {
    const res = await fetch(site + 'index.html', { cache: 'no-store' });
    if (!res.ok) continue;
    const text = await res.text();
    const bytes = Buffer.byteLength(text, 'utf8');
    /* 新版一定带这两样：产品名与 SW 缓存前缀（都是代码里真实存在的字符串） */
    const hasTitle = text.indexOf('自由 · 股息收入追踪') >= 0;
    const hasSw = text.indexOf('ziyou-') >= 0;
    console.log('[deploy] 探测 ' + (i + 1) + '：' + bytes + ' 字节 · 标题=' + hasTitle + ' · SW前缀=' + hasSw);
    if (hasTitle && hasSw) { live = { bytes }; break; }
  } catch (e) { /* 还没刷新好，继续等 */ }
}

if (live) {
  console.log('\n[deploy] ✅ 线上已经是新版（' + live.bytes + ' 字节，含新标题与 SW 前缀）');
  console.log('[deploy] 网址：' + site);
  console.log('[deploy] 提醒：装到桌面的 App 要【完全关掉再打开】才会换掉旧 Service Worker。');
} else {
  console.log('\n[deploy] ⚠ 文件已上传，但还没探测到新版 —— Pages 有时要 1~3 分钟。稍后刷新 ' + site);
}
