/* 部署到 GitHub Pages(ziyou 仓库,Pages legacy 分支模式 = 产物放仓库根)。
 * 沙箱内 git push 不可达、API 禁写 .github/workflows → 唯一通道 = Contents API。
 * 幂等:GET sha → PUT(内容没变 GitHub 会 409/304,脚本按 sha 跳过未变更文件)。
 * 用法: node tools/deploy-pages.mjs   (需要项目根 .token,repo 权限 classic 令牌)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = fs.readFileSync(path.join(ROOT, '.token'), 'utf8').trim();
const OWNER = 'xiazhihua2-bit';
const REPO = 'ziyou';
const API = 'https://api.github.com';
const H = {
  Authorization: 'Bearer ' + TOKEN,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'User-Agent': 'ziyou-deploy',
};

/* [仓库路径, 本地文件] —— 仓库根 = dist/pwa 产物(Pages 构建)+ src 源码 */
const FILES = [
  ['index.html', 'dist/pwa/index.html'],
  ['sw.js', 'dist/pwa/sw.js'],
  ['manifest.webmanifest', 'dist/pwa/manifest.webmanifest'],
  ['src/anim.js', 'src/anim.js'],
  ['src/app.js', 'src/app.js'],
  ['src/calc.js', 'src/calc.js'],
  ['src/fetcher.js', 'src/fetcher.js'],
  ['src/universe.js', 'src/universe.js'],
  ['src/model.js', 'src/model.js'],
  ['src/ui.js', 'src/ui.js'],
  ['src/dnd.js', 'src/dnd.js'],
  ['src/style.css', 'src/style.css'],
  ['src/sync.js', 'src/sync.js'],
  ['src/sync-core.js', 'src/sync-core.js'],
  ['src/views/overview.js', 'src/views/overview.js'],
  ['src/views/watchlist.js', 'src/views/watchlist.js'],
  ['src/views/search.js', 'src/views/search.js'],
  ['src/views/news.js', 'src/views/news.js'],
  ['src/views/plan.js', 'src/views/plan.js'],
  ['src/views/networth.js', 'src/views/networth.js'],
  ['src/views/analysis.js', 'src/views/analysis.js'],
  ['src/views/calendar.js', 'src/views/calendar.js'],
  ['src/views/divsummary.js', 'src/views/divsummary.js'],
  ['src/views/mine.js', 'src/views/mine.js'],
  ['src/views/symbol.js', 'src/views/symbol.js'],
  ['build.mjs', 'build.mjs'],
  ['tools/test-fire.mjs', 'tools/test-fire.mjs'],
  ['tools/shoot-fire.mjs', 'tools/shoot-fire.mjs'],
  ['tools/shoot-overview.mjs', 'tools/shoot-overview.mjs'],
  ['tools/shoot-tabs.mjs', 'tools/shoot-tabs.mjs'],
  ['tools/shoot-watchlist.mjs', 'tools/shoot-watchlist.mjs'],
  ['tools/shoot-news.mjs', 'tools/shoot-news.mjs'],
  ['tools/shoot-theme.mjs', 'tools/shoot-theme.mjs'],
  ['tools/sync-e2e.mjs', 'tools/sync-e2e.mjs'],
  ['tools/deploy-pages.mjs', 'tools/deploy-pages.mjs'],
];

async function api(method, url, body) {
  const r = await fetch(API + url, {
    method, headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* keep null */ }
  return { status: r.status, json };
}

let fail = 0;
for (const [repoPath, localPath] of FILES) {
  const content = fs.readFileSync(path.join(ROOT, localPath));
  const b64 = content.toString('base64');
  /* 现有 sha(不存在 = 新文件) */
  const cur = await api('GET', '/repos/' + OWNER + '/' + REPO + '/contents/' + encodeURIComponent(repoPath).replace(/%2F/g, '/') + '?ref=main');
  if (cur.status === 200 && cur.json && cur.json.content) {
    const remote = Buffer.from(cur.json.content, 'base64');
    if (remote.equals(content)) { console.log('  · ' + repoPath + ' 未变更'); continue; }
  }
  const put = await api('PUT', '/repos/' + OWNER + '/' + REPO + '/contents/' + encodeURIComponent(repoPath).replace(/%2F/g, '/'), {
    message: 'deploy: ' + repoPath + ' (anim + fire-offset + sync-fix)',
    content: b64,
    sha: cur.status === 200 && cur.json ? cur.json.sha : undefined,
  });
  if (put.status === 200 || put.status === 201) console.log('  ✓ ' + repoPath);
  else { fail++; console.log('  ✗ ' + repoPath + '  HTTP ' + put.status + ' ' + JSON.stringify(put.json || {}).slice(0, 160)); }
}

/* Pages 构建状态 */
const pages = await api('GET', '/repos/' + OWNER + '/' + REPO + '/pages');
if (pages.status === 200) console.log('  [pages] status=' + (pages.json.status || '?') + ' build_type=' + (pages.json.build_type || '?'));
else console.log('  [pages] 查询失败 HTTP ' + pages.status);

if (fail) { console.log('[deploy] 失败 ' + fail + ' 个文件'); process.exit(1); }
console.log('[deploy] 全部完成 ✓ 共 ' + FILES.length + ' 个文件(未变更的已跳过)');
