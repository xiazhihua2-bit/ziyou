/* ==================== Service Worker 模板 ====================
 * build.mjs 会把 ad5107dd 替换成产物内容的短 hash 后写入 dist/pwa/sw.js。
 *
 * 策略：
 *   · 导航请求（HTML）→ 当前完整版本的本机首页优先
 *   · 同源静态资源   → cache-first
 *   · 跨域请求一律不拦截（行情/分红/搜索/OCR 必须实时，缓存它们只会给出过期数据）
 * 注意：SW 缓存的是**应用外壳**，与 IndexedDB 里的持仓数据无关，不会影响记录。
 */
const VERSION = 'ad5107dd';
const PREFIX = 'ziyou:' + self.registration.scope + ':';
const CACHE = PREFIX + VERSION;
const SNAPSHOTS = JSON.parse('[{"url":"./pool-015e586e23fc8d74.js","integrity":"sha256-AV5YbiP8jXTdykzHNQuJSiPqYY3F4SX1DZTNatjtJiY="},{"url":"./holder-f930c332acdeda69.js","integrity":"sha256-+TDDMqze2mlxqv+pX6WVn7V/BF9NHNYB7ihGRgmijWc="}]');
const SHELL = ['./manifest.webmanifest', './icon-192.png', './icon-512.png',
  './icon-maskable-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const resources = [{url:'./index.html', integrity:'sha256-rYN1NIl0LIqGyqW1ttcPP95nqUjlJj3NE9awCtHNPJk='}, ...SNAPSHOTS];
    await Promise.all(resources.map(async asset => {
      const res = await fetch(new URL(asset.url, self.registration.scope),
        {cache:'reload', integrity:asset.integrity});
      if (!res.ok) throw new Error('Missing ' + asset.url);
      await cache.put(asset.url, res);
    }));
    await Promise.allSettled(SHELL.map(url => cache.add(url)));
  })());
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
    e.respondWith(caches.open(CACHE).then(async cache =>
      (await cache.match('./index.html')) || fetch(req)));
    return;
  }
  if (!SHELL.concat(SNAPSHOTS.map(asset => asset.url)).some((u) => new URL(u, self.registration.scope).pathname === url.pathname)) return;

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
