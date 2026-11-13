/* ==================== Service Worker 模板 ====================
 * build.mjs 会把 388ce6b4 替换成产物内容的短 hash 后写入 dist/pwa/sw.js。
 *
 * 策略：
 *   · 导航请求（HTML）→ network-first，3 秒内网络没回来就用缓存（弱网不白屏）
 *   · 同源静态资源   → cache-first
 *   · 跨域请求一律不拦截（行情/分红/搜索/OCR 必须实时，缓存它们只会给出过期数据）
 * 注意：SW 缓存的是**应用外壳**，与 IndexedDB 里的持仓数据无关，不会影响记录。
 */
const VERSION = '388ce6b4';
const PREFIX = 'ziyou:' + self.registration.scope + ':';
const CACHE = PREFIX + VERSION;
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png',
];
const NAV_TIMEOUT = 3000;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(async (c) => {
        const response = await fetch(new URL('./index.html', self.registration.scope), { cache: 'reload' });
        if (!response.ok || !(response.headers.get('content-type') || '').includes('text/html')) throw new Error('Missing app shell');
        await c.put('./index.html', response);
        await Promise.allSettled(SHELL.filter((u) => u !== './index.html').map((u) => c.add(u)));
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (!url.href.startsWith(self.registration.scope)) return;

  if (req.mode === 'navigate' && (url.pathname === new URL('./', self.registration.scope).pathname ||
      url.pathname === new URL('./index.html', self.registration.scope).pathname)) {
    e.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match('./index.html');
        let timer;
        const network = fetch(req).then((res) => {
          if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
            cache.put('./index.html', res.clone()).catch(() => {});
            return res;
          }
          return cached || res;
        }).catch(() => cached || Response.error());
        if (!cached) return network;
        const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(cached), NAV_TIMEOUT); });
        try { return await Promise.race([network, timeout]); }
        finally { clearTimeout(timer); }
      })()
    );
    return;
  }
  if (!SHELL.some((u) => new URL(u, self.registration.scope).pathname === url.pathname)) return;

  e.respondWith(
    caches.open(CACHE).then((cache) => cache.match(req)).then((hit) => hit || fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});
