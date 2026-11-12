import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = (file) => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const ctx = vm.createContext({ XJ: {}, console });
ctx.window = ctx;
for (const file of ['util', 'market', 'model', 'calc']) vm.runInContext(source('src/' + file + '.js'), ctx);

const C = ctx.XJ.calc;
const symbol = 'usAAPL';
const plan = { planId: 'p', symbol, source: 'us', isImplemented: true, reportDate: '2024-12-31',
  exDividendDate: '2025-01-07', payoutDate: '2025-02-10', pretaxBonusPer10: 10 };
const tx = (accountId, date, action) => ({ accountId, symbol, date, action, quantity: 10, price: 100 });
const ledger = { accounts: [{ accountId: 'sold' }, { accountId: 'late' }], symbols: {},
  transactions: [tx('sold', '2025-01-01', 'BUY'), tx('sold', '2025-01-15', 'SELL'), tx('late', '2025-01-15', 'BUY')],
  received: [], plans: { p: plan }, quoteCache: {}, settings: { fx: { USD: 7.2, updatedAt: '2025-02-11' } },
  snapshots: { '2025-02-07': { fx: { USD: 7 } }, '2025-02-11': { fx: { USD: 7.2 } } } };
const events = (account) => C.calendarEvents(ledger, account, plan.payoutDate, plan.payoutDate);
assert.equal(events('sold')[0].amount, 10);
assert.equal(events('late').length, 0);
assert.equal(events(C.ALL)[0].amount, 10);
assert.equal(C.applyAutoReceived(ledger), 1);
assert.equal(C.applyAutoReceived(ledger), 0);
assert.equal(ledger.received[0].accountId, 'sold');
assert.equal(C.historicalReceiptCny(ledger, ledger.received[0]), 70);
assert.equal(C.historicalReceiptCny({ settings: ledger.settings }, ledger.received[0]), null);
assert.equal(C.autoDividendNeedsReview(ledger, { ...ledger.received[0], accountId: 'late' }), true);
assert.equal(C.fxRate('USD', {}), null);
assert.equal(C.dividendAmounts({ settings: {} }, [{ symbol, amount: 10 }, { symbol: 'sh600036', amount: 5 }], false).total, 5);
const originalEx = plan.exDividendDate;
delete plan.exDividendDate;
assert.equal(events('late')[0].needsReview, true);
assert.equal(C.applyAutoReceived(ledger), 0);
plan.exDividendDate = originalEx;

async function storageFixture(primary, fallback, { abort = false, pending = false } = {}) {
  const key = 'ziyou_state_v1';
  const local = new Map([[key, JSON.stringify(fallback)]]);
  if (pending) local.set(key + '_pending', '1');
  let stored = primary;
  const db = { transaction() {
    const transaction = { objectStore() {
      return {
        get() {
          const request = { result: stored };
          queueMicrotask(() => request.onsuccess());
          return request;
        },
        put(value, recordKey) {
          const request = {};
          queueMicrotask(() => {
            request.onsuccess?.();
            queueMicrotask(() => {
              if (recordKey === 'state' && abort) transaction.onabort?.();
              else {
                if (recordKey === 'state') stored = value;
                transaction.oncomplete?.();
              }
            });
          });
          return request;
        },
        delete() { queueMicrotask(() => transaction.oncomplete?.()); },
      };
    } };
    return transaction;
  } };
  const sandbox = { XJ: {}, setTimeout: () => 0, indexedDB: { open() {
    const request = { result: db };
    queueMicrotask(() => request.onsuccess());
    return request;
  } }, localStorage: { getItem: (k) => local.get(k), removeItem: (k) => local.delete(k),
    setItem: (k, value) => local.set(k, value) } };
  sandbox.window = sandbox;
  vm.runInNewContext(source('src/storage.js'), sandbox);
  const storage = sandbox.XJ.storage;
  assert.equal(await storage.init(), 'idb');
  return { storage, local, current: () => stored };
}

const old = { transactions: [{ txId: 'old' }] };
const backup = { transactions: [{ txId: 'backup' }] };
const restored = await storageFixture(null, backup);
assert.equal((await restored.storage.load()).transactions[0].txId, 'backup');
assert.equal(restored.current().transactions[0].txId, 'backup');
assert.equal(restored.local.size, 0);
const interrupted = await storageFixture(null, backup, { abort: true });
assert.equal((await interrupted.storage.load()).transactions[0].txId, 'backup');
assert.equal(interrupted.current(), null);
assert.equal(interrupted.local.size, 1);
const conflict = await storageFixture(old, backup);
assert.equal(await conflict.storage.load(), old);
assert.equal(conflict.storage.recoveryCopy().transactions[0].txId, 'backup');
const recentFallback = await storageFixture(old, backup, { pending: true });
assert.equal((await recentFallback.storage.load()).transactions[0].txId, 'backup');

const handlers = {}, deleted = [], written = [];
const scope = 'https://example.test/ziyou/';
const html = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html' } });
const cached = html('saved shell');
let network = () => Promise.resolve(html('server failure', 500));
vm.runInNewContext(source('assets/sw.template.js'), {
  URL, Response, setTimeout: (fn) => setTimeout(fn, 2), clearTimeout,
  fetch: () => network(),
  self: { registration: { scope }, addEventListener: (name, fn) => { handlers[name] = fn; },
    clients: { claim: async () => {} }, skipWaiting: async () => {} },
  caches: {
    keys: async () => ['other-app-cache', 'ziyou:' + scope + ':old', 'ziyou:' + scope + ':__XJ_VERSION__'],
    delete: async (key) => deleted.push(key),
    open: async () => ({ match: async () => cached.clone(), put: async (key) => written.push(key), add: async () => {} }),
  },
});
function dispatch(type, request) {
  return new Promise((resolve) => handlers[type]({ request, waitUntil: resolve, respondWith: resolve }));
}
await dispatch('activate');
assert.deepEqual(deleted, ['ziyou:' + scope + ':old']);
assert.equal(await (await dispatch('fetch', { url: scope, method: 'GET', mode: 'navigate' })).text(), 'saved shell');
assert.equal(written.length, 0);
network = () => new Promise(() => {});
assert.equal(await (await dispatch('fetch', { url: scope, method: 'GET', mode: 'navigate' })).text(), 'saved shell');
network = () => Promise.resolve(html('new shell'));
assert.equal(await (await dispatch('fetch', { url: scope, method: 'GET', mode: 'navigate' })).text(), 'new shell');
assert.deepEqual(written, ['./index.html']);

const apiContext = vm.createContext({ XJ: {}, URL, console, clearTimeout,
  setTimeout: (fn, delay) => delay < 200 ? setTimeout(fn, 0) : 0 });
apiContext.window = apiContext;
apiContext.document = {
  createElement: () => ({}),
  head: { appendChild(script) {
    const url = new URL(script.src);
    if (url.searchParams.get('filter').includes('600036')) {
      apiContext[url.searchParams.get('callback')]({ success: true, result: { data: [] } });
      script.onload();
    } else script.onerror();
  } },
};
for (const file of ['util', 'market', 'model', 'fetcher']) vm.runInContext(source('src/' + file + '.js'), apiContext);
const fetched = await apiContext.XJ.fetcher.fetchDividends(['sh600036', 'sh600023']);
assert.deepEqual(Array.from(fetched.noData), ['sh600036']);
assert.deepEqual(Array.from(fetched.failed), ['sh600023']);
const market = apiContext.XJ.market;
const fields = Array(50).fill('');
fields[1] = '招商银行'; fields[2] = '600036'; fields[3] = '42'; fields[4] = '40';
assert.equal(market.parseQuoteFields('sh600036', fields.join('~')).changePct, 5);
fields[32] = '0';
assert.equal(market.parseQuoteFields('sh600036', fields.join('~')).changePct, 0);
fields[3] = ''; fields[32] = '';
assert.equal(market.parseQuoteFields('sh600036', fields.join('~')).changePct, null);
const close = apiContext.XJ.fetcher.closingQuoteOf('of110022', [['2026-11-09', 1], ['2026-11-10', 1.25]]);
assert.equal(close.changePct, 25);
assert.equal(close.quoteTime, '20261110');
assert.equal(close.source, 'nav');
assert.equal(apiContext.XJ.fetcher.closingQuoteOf('sh600036', [['2026-11-10', 40]]).changePct, null);
console.log('Upgrade checks passed: dividend eligibility, currency gaps, ledger recovery, cache isolation, offline navigation and partial refresh.');
