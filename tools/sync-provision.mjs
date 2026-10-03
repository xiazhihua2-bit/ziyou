/* 建「云端盒子」（一个私有 Gist）并输出配对链接 —— 由我（开发者）代跑，用户只点一下链接。
 *
 * ★ 为什么盒子由外部建、设备端不建：
 *   当年的头号故障就是「两台设备各自点『新建同步位置』→ 各自连一个 Gist →
 *   永不互通，而界面显示成功」。设备端现在【没有】建盒入口，这个脚本就是唯一的建盒途径。
 *
 * 幂等：先按描述与文件名查重，命中即复用 —— 重复跑绝不会开出第二个盒子。
 *
 * 用法：
 *   1) 把 repo 权限的令牌放项目根 .token（或 .token.sync）
 *   2) node tools/sync-provision.mjs            # 建盒 + 输出配对链接
 *   3) 再跑一次应输出同一个 gistId（幂等自检）
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.join(ROOT, '..');

function readToken() {
  for (const f of ['.token.sync', '.token']) {
    const p = path.join(PROJ, f);
    if (fs.existsSync(p)) {
      const t = fs.readFileSync(p, 'utf8').trim();
      if (t) return t;
    }
  }
  console.error('[provision] ✗ 项目根没有 .token.sync 或 .token');
  process.exit(1);
}
const TOKEN = readToken();
const FILE = 'ziyou-sync.json';
const DESC = '自由 · 跨设备同步数据（请勿公开分享）';
const API = 'https://api.github.com';
const H = {
  'User-Agent': 'ziyou-provision',
  Authorization: 'Bearer ' + TOKEN,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function api(method, url, body) {
  const res = await fetch(API + url, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
}

/* 在 vm 沙箱里跑 sync-core，用它生成初始负载与配对链接 ——
   保证写进盒子的格式与设备端读的格式【逐字节一致】（不手写第二份实现）。 */
function makeCore() {
  const sb = { window: {}, console, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Date,
    parseInt, parseFloat, isNaN, isFinite, Promise, setTimeout, clearTimeout };
  sb.globalThis = sb;
  sb.atob = (s) => Buffer.from(String(s), 'base64').toString('binary');
  sb.btoa = (s) => Buffer.from(String(s), 'binary').toString('base64');
  /* webcrypto：没有它 sync-core 的 hasSubtle() 为假，口令会【静默回退成明文】 ——
     那正是我们要避免的（URL 里是 base64 明文令牌，谁截到链接谁就能读写云端）。 */
  sb.crypto = globalThis.crypto;
  sb.TextEncoder = TextEncoder;
  sb.TextDecoder = TextDecoder;
  vm.createContext(sb);
  for (const f of ['src/util.js', 'src/market.js', 'src/model.js', 'src/transfer.js', 'src/sync-core.js']) {
    vm.runInContext(fs.readFileSync(path.join(PROJ, f), 'utf8'), sb, { filename: f });
  }
  return sb.window.XJ;
}

const XJ = makeCore();
const M = XJ.model, CORE = XJ.syncCore;

async function main() {
  console.log('[provision] 1/5 校验令牌');
  const who = await api('GET', '/user');
  if (who.status !== 200) { console.error('[provision] ✗ 令牌无效（HTTP ' + who.status + '）'); process.exit(1); }
  const scopes = who.data && who.data.login ? who.data.login : '?';
  console.log('        账号 ' + scopes);

  console.log('[provision] 2/5 查重（按描述 + 文件名）');
  const list = await api('GET', '/gists?per_page=100');
  const mine = (list.data || []).filter((g) => g.description === DESC && g.files && g.files[FILE]);
  if (mine.length) {
    console.log('        ★ 命中已有盒子，复用（不会新建）: ' + mine.map((g) => g.id).join(', '));
  }

  /* 注意：/gists 列表接口【不返回】files.content（只给文件名与大小），
     所以这里只凭「描述 + 有该文件」判定命中；内容校验留到第 4 步的单条读取。 */
  let gistId = mine.length ? mine[0].id : null;

  if (!gistId) {
    console.log('[provision] 3/5 新建私有盒子');
    const fresh = M.ensureBootstrapped(M.defaultState());
    CORE.meta(fresh).deviceId = 'provision_bot';
    CORE.seedVersions(fresh);
    const payload = CORE.buildRemote(fresh, { version: 1 });
    const made = await api('POST', '/gists', {
      description: DESC, public: false, files: { [FILE]: { content: JSON.stringify(payload) } },
    });
    if (made.status !== 201 || !made.data || !made.data.id) {
      console.error('[provision] ✗ 建盒失败（HTTP ' + made.status + '）：' + JSON.stringify(made.data).slice(0, 200));
      process.exit(1);
    }
    gistId = made.data.id;
    console.log('        已创建: ' + gistId);
  } else {
    console.log('[provision] 3/5 跳过新建（复用）');
  }

  console.log('[provision] 4/5 校验盒子');
  const got = await api('GET', '/gists/' + encodeURIComponent(gistId));
  if (got.status !== 200) { console.error('[provision] ✗ 读不到盒子（HTTP ' + got.status + '）'); process.exit(1); }
  if (got.data.public === true) { console.error('[provision] ✗ 盒子是公开的 —— 公开会被 GitHub 吊销令牌'); process.exit(1); }
  if (!got.data.files || !got.data.files[FILE]) { console.error('[provision] ✗ 盒子里没有 ' + FILE); process.exit(1); }
  if (typeof got.data.files[FILE].content !== 'string') {
    console.error('[provision] ✗ 盒子里没读到文件内容（keys=' + JSON.stringify(Object.keys(got.data.files[FILE])) + '）');
    process.exit(1);
  }
  const parsed = JSON.parse(got.data.files[FILE].content);
  console.log('        私有 ✓ · 文件在位 ✓ · 云端版本 ' + (parsed.version || 0) + ' · 位置指纹 ' + CORE.boxFingerprintOf(gistId));

  console.log('[provision] 5/5 生成配对链接');
  /* 优先用加密口令（XJ2e，带盒子指纹）；设备端不支持加密时回退明文（XJ1p） */
  let link = null, form = '';
  const site = 'https://xiazhihua2-bit.github.io/ziyou/';
  const key = CORE.newPairKey();
  const pr = await CORE.encodePairCode({ token: TOKEN, gistId, key });
  const pair = pr && pr.code;
  if (pair && pr.plain) {
    form = 'XJ1p（⚠ 明文载荷：本机缺 WebCrypto，链接里是 base64 的令牌）';
    link = site + '#xjsync=' + pair;
  } else if (pair) {
    form = 'XJ2e（加密口令，含盒子指纹）';
    link = site + '#xjsync=' + pair;
  } else {
    const inst = CORE.encodeInstall({ token: TOKEN, gistId });
    form = 'XJ1p（明文安装载荷）';
    link = inst ? site + '#xjsync=' + inst : null;
  }
  if (!link) { console.error('[provision] ✗ 配对链接生成失败'); process.exit(1); }

  /* 本地留档：盒子 id 便于日后重建；令牌绝不落盘 */
  fs.writeFileSync(path.join(PROJ, '.gist-id'), gistId + '\n', 'utf8');
  const gitignore = path.join(PROJ, '.gitignore');
  if (!fs.readFileSync(gitignore, 'utf8').includes('.gist-id')) {
    fs.appendFileSync(gitignore, '\n# 同步云端位置（本地留档，含 gistId，不含令牌）\n.gist-id\n.token.sync\n', 'utf8');
  }

  console.log('\n============================================================');
  console.log('盒子 ID   ' + gistId);
  console.log('位置指纹 ' + CORE.boxFingerprintOf(gistId) + '   ← 面板上会常显，用来核对两台设备是否连同一个盒子');
  console.log('口令形式 ' + form);
  console.log('\n把下面这条链接在【手机 / 平板】上点开即完成配对：\n');
  console.log(link);
  console.log('\n（每台设备点一次。链接等同云端钥匙，配对完成后请清掉转发记录。）');
  console.log('============================================================\n');
}

main().catch((e) => { console.error('[provision] 失败:', e.message); process.exit(1); });
