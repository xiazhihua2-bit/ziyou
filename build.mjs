/* 零依赖构建脚本：把多文件源码合并成单文件 HTML，并产出可部署的 PWA 目录
 * 用法： node build.mjs
 *
 * 产出两份互不影响的东西：
 *   dist/息记复刻版.html   单文件，双击即用（内置 OCR Key，可当离线备份、可微信发文件）
 *   dist/pwa/             部署用（index.html + manifest + Service Worker + PNG 图标），OCR Key 置空
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// JS 拼接顺序即执行顺序，必须与源码里的依赖关系一致
const JS_FILES = [
  'src/util.js',
  'src/market.js',
  'src/model.js',
  'src/storage.js',
  'src/transfer.js',
  'src/fetcher.js',
  'src/ocr.js',
  'src/chart.js',
  'src/calc.js',
  'src/store.js',
  'src/ui.js',
  'src/views/overview.js',
  'src/views/networth.js',
  'src/views/calendar.js',
  'src/views/plan.js',
  'src/views/divsummary.js',
  'src/views/mine.js',
  'src/views/analysis.js',
  'src/views/symbol.js',
  'src/app.js',
];

/* OCR 默认 Key：只注入单文件产物；部署版置空（公开即等于把额度送人） */
const OCR_KEY = 'd02efc3249e0441483dc039e165575a6.MBAiWDVCypcG1tCk';
const KEY_PLACEHOLDER = '__XJ_OCR_KEY__';

const APP_NAME = '自由 · 股息收入追踪';
const SHORT_NAME = '自由';
const THEME = '#F2F2F7';
const ICON_FILES = ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];

const css = read('src/style.css');
const body = JS_FILES.map((f) => `\n/* ==================== ${f} ==================== */\n${read(f)}`).join('\n');
const bundle = `(function(){\n'use strict';\n${body}\n})();`;
const tpl = read('template.html');

/** 渲染 HTML。key 传 null 表示置空（部署版） */
function renderHtml(key, headExtra) {
  const app = (key === null || key === undefined)
    ? bundle
    : bundle.split(KEY_PLACEHOLDER).join(key);
  return tpl
    .replace('__HEAD__', headExtra || '')
    .replace('__CSS__', () => css)
    .replace('__APP__', () => app);
}

const distDir = path.join(ROOT, 'dist');
fs.mkdirSync(distDir, { recursive: true });

/* ---------------- ① 单文件产物（保持现状：双击即用、内置 Key） ---------------- */
const singleHtml = renderHtml(OCR_KEY, '');
const singleFile = path.join(distDir, '自由.html');
fs.writeFileSync(singleFile, singleHtml, 'utf8');

/* ---------------- ② 部署产物 dist/pwa/ ---------------- */
const pwaDir = path.join(distDir, 'pwa');
fs.rmSync(pwaDir, { recursive: true, force: true });
fs.mkdirSync(pwaDir, { recursive: true });

const version = createHash('sha1').update(bundle).digest('hex').slice(0, 8);
const head = [
  '<link rel="manifest" href="./manifest.webmanifest">',
  '<link rel="apple-touch-icon" href="./apple-touch-icon.png">',
].join('\n');
fs.writeFileSync(path.join(pwaDir, 'index.html'), renderHtml(null, head), 'utf8');

const manifest = {
  name: APP_NAME,
  short_name: SHORT_NAME,
  description: '记录每一笔股息收入，看分红覆盖生活的进度。只做记录，不荐股。',
  /* 全部用相对路径：同一份目录既能部署到根路径（Vercel），也能部署到子路径（GitHub Pages /repo/） */
  start_url: './',
  scope: './',
  display: 'standalone',
  orientation: 'any',
  background_color: THEME,
  theme_color: THEME,
  lang: 'zh-CN',
  icons: [
    { src: './icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: './icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: './icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};
fs.writeFileSync(path.join(pwaDir, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2), 'utf8');

const sw = read('assets/sw.template.js').replaceAll('__XJ_VERSION__', version);
fs.writeFileSync(path.join(pwaDir, 'sw.js'), sw, 'utf8');

/* 关掉 GitHub Pages 的 Jekyll 处理：部署更快、行为更可预测 */
fs.writeFileSync(path.join(pwaDir, '.nojekyll'), '', 'utf8');

/* 图标提交进仓库（assets/icons/），构建只做复制 —— 构建因此不依赖 Chrome，别人也能复现 */
const iconDir = path.join(ROOT, 'assets', 'icons');
let copied = 0;
ICON_FILES.forEach((f) => {
  const src = path.join(iconDir, f);
  if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(pwaDir, f)); copied++; }
});

/* ---------------- 自检 ---------------- */
const kb = (Buffer.byteLength(singleHtml, 'utf8') / 1024).toFixed(1);
console.log(`[build] ok -> ${singleFile}`);
console.log(`[build] size = ${kb} KB, js files = ${JS_FILES.length}, sw version = ${version}`);
console.log(`[build] pwa -> ${pwaDir}  (图标 ${copied}/${ICON_FILES.length})`);
if (copied < ICON_FILES.length) {
  console.log('[build] ⚠️ 缺少 PNG 图标，请先运行: node tools/make-icons.mjs');
}
if (fs.readFileSync(path.join(pwaDir, 'index.html'), 'utf8').includes(OCR_KEY)) {
  console.error('[build] ✗ 部署版里竟然含有 OCR Key！已中止');
  process.exit(1);
}
console.log('[build] ✓ 部署版已确认不含 OCR Key');

/* 必须全局替换：模板里 __XJ_VERSION__ 先出现在头部注释，非全局 replace 只会改到注释，
 * 真正起作用的 const VERSION 会残留占位符 → 缓存名恒定、旧缓存永不清理、更新到不了已安装设备 */
if (sw.includes('__XJ_VERSION__')) {
  console.error('[build] ✗ sw.js 里仍有 __XJ_VERSION__ 占位符：SW 版本号未替换，缓存将永不更新');
  process.exit(1);
}
console.log('[build] ✓ sw.js 版本号已替换为 ' + version);
