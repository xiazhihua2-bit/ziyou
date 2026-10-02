/* 一次性工具：初始化 xiazhihua2-bit/ziyou 仓库（Contents API，git push 在本环境不可用）
 *
 * 做四件事：
 *   1) 建公开仓库（已存在则跳过）
 *   2) 批量上传：源码 + 构建/验收脚本 + assets + workflow + README + .gitignore + dist/pwa/
 *   3) 启用 GitHub Pages（build_type = workflow，配合 deploy-pages.yml）
 *   4) 自检线上可达
 *
 * 用法：先把 repo 权限的 classic 令牌放进项目根的 .token 文件，然后 node tools/init-repo.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.join(ROOT, '..');
const OWNER = 'xiazhihua2-bit';
const REPO = 'ziyou';
const API = 'https://api.github.com';
const BRANCH = 'main';

const TOKEN = (fs.existsSync(path.join(PROJ, '.token')) ? fs.readFileSync(path.join(PROJ, '.token'), 'utf8') : '').trim();
if (!TOKEN) {
  console.error('[init] ✗ 项目根目录没有 .token 文件（放一个 repo 权限的 classic 令牌）');
  process.exit(1);
}

const headers = {
  'User-Agent': 'ziyou-init',
  Authorization: 'Bearer ' + TOKEN,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
};
async function api(method, url, body) {
  const res = await fetch(API + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* 空响应 */ }
  return { status: res.status, data };
}

/* ---------- 文件清单：源码 + 工程 + 产物（PWA，Key 置空版） ---------- */
const DIRS = ['src', 'src/views', 'assets', 'assets/icons', 'tools', '.github', '.github/workflows', 'dist', 'dist/pwa'];
const EXCLUDE = /(^|\/)(\.token|\.token\.txt|息记复刻版\.html|自由\.html|shots|node_modules|dist\/息记复刻版\.html)$/;

function listFiles() {
  const out = [];
  for (const d of DIRS) {
    const abs = path.join(PROJ, d);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      const rel = (d === '' ? name : d + '/' + name);
      const full = path.join(abs, name);
      if (fs.statSync(full).isDirectory()) continue;
      if (EXCLUDE.test(rel)) continue;
      out.push(rel);
    }
  }
  for (const top of ['build.mjs', 'verify.mjs', 'uitest.mjs', 'livetest.mjs', 'template.html', 'README.md', '.gitignore', 'fixtures.json']) {
    if (fs.existsSync(path.join(PROJ, top))) out.push(top);
  }
  return [...new Set(out)];
}

async function main() {
  /* 1) 建仓库 */
  console.log('[init] 创建仓库 ' + OWNER + '/' + REPO + ' …');
  let r = await api('POST', '/user/repos', {
    name: REPO, description: '自由 · 股息收入追踪 —— 记录持仓与分红，看股息覆盖生活的进度。只做记录，不荐股。',
    homepage: 'https://' + OWNER + '.github.io/' + REPO + '/',
    private: false, has_issues: false, has_wiki: false, has_projects: false, auto_init: false,
  });
  if (r.status === 201) console.log('[init] ✓ 仓库已创建');
  else if (r.status === 422) console.log('[init] · 仓库已存在，跳过');
  else { console.error('[init] ✗ 建仓失败 ' + r.status + ': ' + JSON.stringify(r.data).slice(0, 300)); process.exit(1); }

  /* 2) 批量上传（串行 + 每文件一个 commit，简单可靠） */
  const files = listFiles();
  console.log('[init] 上传 ' + files.length + ' 个文件 …');
  let up = 0, skip = 0;
  for (const rel of files) {
    const content = fs.readFileSync(path.join(PROJ, rel));
    const b64 = content.toString('base64');
    /* 先查现有文件拿 sha（404 = 新文件） */
    const exist = await api('GET', '/repos/' + OWNER + '/' + REPO + '/contents/' + encodeURIComponent(rel).replace(/%2F/g, '/') + '?ref=' + BRANCH);
    const sha = exist.status === 200 ? exist.data.sha : undefined;
    const put = await api('PUT', '/repos/' + OWNER + '/' + REPO + '/contents/' + encodeURIComponent(rel).replace(/%2F/g, '/'), {
      message: (sha ? 'update ' : 'add ') + rel,
      content: b64, branch: BRANCH, sha,
    });
    if (put.status === 200 || put.status === 201) { up++; process.stdout.write('  ✓ ' + rel + (sha ? '（更新）' : '') + '\n'); }
    else if (put.status === 409 || put.status === 422) { skip++; console.log('  · ' + rel + ' 冲突跳过'); }
    else { console.error('  ✗ ' + rel + ' → ' + put.status + ' ' + JSON.stringify(put.data).slice(0, 160)); }
  }
  console.log('[init] 上传完成：' + up + ' 个成功 / ' + skip + ' 个跳过');

  /* 3) 启用 Pages（Actions 源） */
  const pages = await api('POST', '/repos/' + OWNER + '/' + REPO + '/pages', { build_type: 'workflow' });
  if (pages.status === 201 || pages.status === 204) console.log('[init] ✓ Pages 已启用（Source = GitHub Actions）');
  else if (pages.status === 409) console.log('[init] · Pages 已启用过，跳过');
  else console.log('[init] ⚠ Pages 启用返回 ' + pages.status + '（可能需在网页 Settings→Pages 手动选「GitHub Actions」）: ' + JSON.stringify(pages.data).slice(0, 200));

  /* 4) 等待 Actions 构建并自检 */
  const site = 'https://' + OWNER + '.github.io/' + REPO + '/';
  console.log('[init] 等待首次部署（Actions 构建约 1-2 分钟）…');
  for (let i = 0; i < 40; i++) {
    await new Promise((r2) => setTimeout(r2, 5000));
    try {
      const res = await fetch(site + 'index.html', { cache: 'no-store' });
      if (res.ok) {
        const text = await res.text();
        if (text.indexOf('自由 · 股息收入追踪') >= 0) {
          console.log('[init] ✅ 线上就绪：' + site);
          process.exit(0);
        }
      }
    } catch (e) { /* retry */ }
    process.stdout.write('  · 探测 ' + (i + 1) + ' …\n');
  }
  console.log('[init] ⚠ 超时未探测到 —— 去仓库 Actions 页看构建状态，或稍后刷新 ' + site);
}

main().catch((e) => { console.error('[init] 失败:', e.message); process.exit(1); });
