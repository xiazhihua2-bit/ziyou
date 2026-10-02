/* ==================== Service Worker 模板 ====================
 * build.mjs 会把 cafb9d18 替换成产物内容的短 hash 后写入 dist/pwa/sw.js。
 *
 * 策略：
 *   · 导航请求（HTML）→ network-first，3 秒内网络没回来就用缓存（弱网不白屏）
 *   · 同源静态资源   → cache-first
 *   · 跨域请求一律不拦截（行情/分红/搜索/OCR 必须实时，缓存它们只会给出过期数据）
 * 注意：SW 缓存的是**应用外壳**，与 IndexedDB 里的持仓数据无关，不会影响记录。
 */
const VERSION = 'cafb9d18';
const CACHE = 'ziyou-' + VERSION;
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png',
];
const NAV_TIMEOUT = 3000;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))   // 单个失败不阻塞安装
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.origin !== self.location.origin) return;      // 跨域放行，不缓存

  if (req.mode === 'navigate') {
    e.respondWith(
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          caches.match('./index.html').then((r) => r && resolve(r));
        }, NAV_TIMEOUT);
        fetch(req).then((res) => {
          clearTimeout(timer);
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
          resolve(res);
        }).catch(() => {
          clearTimeout(timer);
          caches.match('./index.html').then((r) => resolve(r || caches.match('./')));
        });
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});
