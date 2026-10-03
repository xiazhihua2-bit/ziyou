/* ============================================================
 * 跨设备同步 · 纯逻辑单测（sync-core）
 *
 * 与 verify.mjs【30】节的分工：
 *   verify【30】锁的是「同步语义契约」（幂等 / 删除必胜 / 收敛性 / 令牌不上路）；
 *   本文件是同步层自己的开发靠测试，覆盖更细的分支与边界，改 sync-core 时先跑这个。
 *   （verify 是金标准、要独立复算；本文件允许直接调 sync-core 逐分支验证。）
 *
 * 用法： node tools/test-sync.mjs
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* 冻结时钟：与 verify 同一口径，保证结果确定 */
let CLOCK = new Date(2026, 8, 30, 12, 0, 0).getTime();
const sandbox = {
  window: {}, console,
  Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
  parseInt, parseFloat, isNaN, Promise, setTimeout, clearTimeout,
};
sandbox.globalThis = sandbox;
/* 浏览器里 atob/btoa 是全局的，vm 沙箱默认没有 —— 补上等价物，
   否则 sync-core 的 base64url 兜底路径会静默失败（并曾因此产出 'XJ1p.null' 垃圾链接）。 */
sandbox.atob = (s) => Buffer.from(String(s), 'base64').toString('binary');
sandbox.btoa = (s) => Buffer.from(String(s), 'binary').toString('base64');
class FakeDate extends Date {
  constructor(...a) { if (a.length === 0) super(CLOCK); else super(...a); }
  static now() { return CLOCK; }
}
sandbox.Date = FakeDate;
vm.createContext(sandbox);
for (const f of ['src/util.js', 'src/market.js', 'src/model.js', 'src/sync-core.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}
const XJ = sandbox.window.XJ;
const M = XJ.model, SC = XJ.syncCore;

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name); console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function eq(name, a, b) {
  const sa = typeof a === 'object' ? JSON.stringify(a) : String(a);
  const sb = typeof b === 'object' ? JSON.stringify(b) : String(b);
  ok(name + '  → ' + sa, sa === sb);
}
function section(t) { console.log('\n' + t); }
const tick = (ms) => { CLOCK += (ms === undefined ? 1000 : ms); };

/* ---------------- 夹具 ---------------- */

function freshState() {
  const s = M.ensureBootstrapped(M.defaultState());
  s.accounts = [{ accountId: 'acc_1', name: '我的账户', type: 'BROKER', sortOrder: 1, createdAt: '2026-01-01T00:00:00Z' }];
  s.settings.defaultAccountId = 'acc_1';
  s.transactions = [];
  s.received = [];
  s.symbols = {};
  s.snapshots = {};
  return s;
}
function tx(id, extra) {
  return Object.assign({
    txId: id, accountId: 'acc_1', symbol: 'sh600023', action: 'BUY',
    date: '2025-03-10', quantity: 1000, price: 4, fee: 5, note: '',
    createdAt: '2025-03-10T01:00:00Z',
  }, extra || {});
}
/* 一台设备：建夹具 → 登记底稿（seedVersions 才是「首次纳入」的正确入口） */
function dev(name) {
  const s = freshState();
  SC.meta(s).deviceId = name;
  SC.seedVersions(s);
  return s;
}

/* ============================================================
 * 1. 首次纳入 / 幂等 / 修改
 * ============================================================ */
section('【1】首次纳入既有数据：只登记、不产出 op');
{
  const a = freshState(); SC.meta(a).deviceId = 'dev_A';
  a.transactions.push(tx('t1'), tx('t2'));
  const r1 = SC.seedVersions(a);
  eq('产出 0 条 op', r1, 0);
  ok('t1 被盖上戳 rev=1 / rd=dev_A', a.transactions[0].rev === 1 && a.transactions[0].rd === 'dev_A', a.transactions[0]);
  ok('账本已登记 t1', !!a.syncMeta.versions['tx:t1']);
  eq('outbox 为空（首次纳入不发东西）', a.syncMeta.outbox.length, 0);

  section('【2】幂等：再跑一次什么都不变');
  const before = JSON.stringify(a.transactions);
  eq('第二次 diff 仍是 0 条', SC.diffToOps(a).ops.length, 0);
  eq('记录逐字节未被改动', JSON.stringify(a.transactions), before);

  section('【3】内容变化 → 产出 op，rev 递增');
  tick();
  a.transactions[0].quantity = 1200;
  const r3 = SC.diffToOps(a);
  eq('产出 1 条 op', r3.ops.length, 1);
  eq('op 指向 tx/t1/新增', [r3.ops[0].t, r3.ops[0].id, r3.ops[0].d], ['tx', 't1', 0]);
  eq('rev 递增到 2', r3.ops[0].s.rev, 2);
  eq('op 已入 outbox', a.syncMeta.outbox.length, 1);
  eq('未改动的 t2 不产出 op', r3.ops.filter((o) => o.id === 't2').length, 0);

  section('【4】指纹：与键序无关，且排除同步自己的戳');
  eq('键序不影响指纹', SC.hash(SC.stable({ b: 1, a: 2 })), SC.hash(SC.stable({ a: 2, b: 1 })));
  const t = tx('t9');
  const h1 = SC.contentHash(SC.DEFS.tx, t);
  t.rev = 7; t.rt = 999; t.rd = 'dev_Z';
  eq('★ 盖上戳不改变内容指纹', SC.contentHash(SC.DEFS.tx, t), h1);

  section('【5】删除 → 墓碑；墓碑戳冻结、不重复产出');
  tick();
  a.transactions = a.transactions.filter((x) => x.txId !== 't2');
  const r5 = SC.diffToOps(a);
  eq('产出 1 条删除 op', r5.ops.length, 1);
  eq('是删除且指向 t2', [r5.ops[0].t, r5.ops[0].id, r5.ops[0].d], ['tx', 't2', 1]);
  ok('墓碑已记', !!a.syncMeta.tombstones['tx:t2']);
  const frozen = JSON.stringify(a.syncMeta.tombstones['tx:t2']);
  tick(5000);
  eq('★ 再次 diff 不重复发墓碑', SC.diffToOps(a).ops.length, 0);
  eq('★ 墓碑戳已冻结', JSON.stringify(a.syncMeta.tombstones['tx:t2']), frozen);
}

/* ============================================================
 * 2. 远端应用 / 回声抑制 / 删除必胜
 * ============================================================ */
section('【6】新设备对齐后不产生回声');
{
  const a = dev('dev_A');
  a.transactions.push(tx('t1'));
  SC.diffToOps(a);
  a.transactions[0].quantity = 1200;
  SC.diffToOps(a);
  a.transactions.push(tx('t2'));
  SC.diffToOps(a);
  a.transactions = a.transactions.filter((x) => x.txId !== 't2');
  SC.diffToOps(a);

  const b = dev('dev_B');
  const remote = SC.buildRemote(a, { version: 3 });
  SC.mergeRemote(b, remote, 'overwrite');
  eq('B 拿到 A 的交易', b.transactions.length, 1);
  eq('拿到的是改后的数量', b.transactions[0].quantity, 1200);
  ok('B 也拿到了墓碑', !!b.syncMeta.tombstones['tx:t2']);
  eq('★ B 的 diff 产出 0 条（无回声）', SC.diffToOps(b).ops.length, 0);

  section('【7】删除必胜：另一种设备的新增不能让被删的复活');
  SC.applyOps(b, [{ t: 'tx', id: 't2', d: 0, s: { rev: 1, rt: CLOCK + 999999, rd: 'dev_C' }, r: tx('t2') }]);
  eq('被删的 t2 未复活', b.transactions.filter((x) => x.txId === 't2').length, 0);

  section('【8】墓碑之后的新内容可以救活（戳更新才允许）');
  SC.applyOps(b, [{ t: 'tx', id: 't2', d: 0, s: { rev: 99, rt: CLOCK + 999999, rd: 'dev_C' }, r: tx('t2', { quantity: 500 }) }]);
  eq('rev 更高的新内容覆盖墓碑', b.transactions.filter((x) => x.txId === 't2').length, 1);
  ok('覆盖后墓碑被清掉', !b.syncMeta.tombstones['tx:t2']);
}

/* ============================================================
 * 3. 幂等 / 收敛 / 交换律 / 时钟
 * ============================================================ */
section('【9】重复投递同一 op 无副作用');
{
  const op = [{ t: 'tx', id: 'tx_dup', d: 0, s: { rev: 1, rt: 1000, rd: 'dev_X' }, r: tx('tx_dup') }];
  const c = dev('dev_C');
  SC.applyOps(c, op);
  const once = JSON.stringify(c.transactions);
  SC.applyOps(c, JSON.parse(JSON.stringify(op)));
  eq('结果不变', JSON.stringify(c.transactions), once);
  eq('没有产生第二条', c.transactions.length, 1);

  section('【10】时钟回拨 / 三机时钟不一致：rd 兜底给出唯一结论');
  const opA = { t: 'tx', id: 'tx_skew', d: 0, s: { rev: 2, rt: 5000, rd: 'dev_A' }, r: tx('tx_skew', { quantity: 111 }) };
  const opZ = { t: 'tx', id: 'tx_skew', d: 0, s: { rev: 2, rt: 5000, rd: 'dev_Z' }, r: tx('tx_skew', { quantity: 999 }) };
  const s1 = dev('dev_1'); SC.applyOps(s1, [opA]); SC.applyOps(s1, [opZ]);
  const s2 = dev('dev_2'); SC.applyOps(s2, [opZ]); SC.applyOps(s2, [opA]);
  eq('rd 大的获胜', s1.transactions[0].quantity, 999);
  eq('换顺序同一结论（收敛，不靠时钟）', s2.transactions[0].quantity, 999);

  section('【11】交换律与收敛性');
  const dA = dev('dev_A'); dA.transactions.push(tx('tx_a', { date: '2025-01-01' })); SC.diffToOps(dA);
  const dB = dev('dev_B'); dB.transactions.push(tx('tx_b', { date: '2025-01-02' })); SC.diffToOps(dB);
  const uAB = (() => {
    const x = dev('dev_U1'); x.transactions.push(tx('tx_a', { date: '2025-01-01' })); SC.diffToOps(x);
    SC.mergeRemote(x, SC.buildRemote(dB, {}), 'merge');
    return JSON.stringify(x.transactions.map((t) => t.txId).sort());
  })();
  const uBA = (() => {
    const x = dev('dev_U2'); x.transactions.push(tx('tx_b', { date: '2025-01-02' })); SC.diffToOps(x);
    SC.mergeRemote(x, SC.buildRemote(dA, {}), 'merge');
    return JSON.stringify(x.transactions.map((t) => t.txId).sort());
  })();
  eq('★ A∪B == B∪A', uAB, uBA);

  const src = dev('dev_S');
  src.transactions.push(tx('tx_c1', { date: '2025-01-01' }), tx('tx_c2', { date: '2025-02-01', symbol: 'sz000858' }));
  SC.diffToOps(src);
  src.transactions[0].quantity = 150;
  src.transactions[1].price = 2.5;
  SC.diffToOps(src);
  const batch = SC.buildRemote(src, {}).ops;
  const orders = [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1], [0, 3, 1, 2]];
  const outs = orders.map((order) => {
    const x = dev('dev_O');
    for (const i of order) if (batch[i]) SC.applyOps(x, [JSON.parse(JSON.stringify(batch[i]))]);
    return JSON.stringify(x.transactions.map((t) => [t.txId, t.quantity, t.price]).sort());
  });
  eq('★ 5 种乱序结果全同', new Set(outs).size, 1);

  section('【12】三台设备传递 A → B → C');
  const t1 = dev('dev_T1'), t2 = dev('dev_T2'), t3 = dev('dev_T3');
  t1.transactions.push(tx('tx_chain'));
  SC.diffToOps(t1);
  SC.mergeRemote(t2, SC.buildRemote(t1, {}), 'merge');
  SC.diffToOps(t2);
  SC.mergeRemote(t3, SC.buildRemote(t2, {}), 'merge');
  eq('C 也拿到了这笔', t3.transactions.length, 1);
  eq('C 与 A 内容一致',
    JSON.stringify(t3.transactions.map((t) => [t.txId, t.quantity])),
    JSON.stringify(t1.transactions.map((t) => [t.txId, t.quantity])));
}

/* ============================================================
 * 4. 隐私：令牌 / Key / 本机字段永不上路
 * ============================================================ */
section('【13】令牌与 Key 绝不上路');
{
  const s = dev('dev_L');
  s.transactions.push(tx('t_leak'));
  SC.diffToOps(s);
  s.syncMeta.token = 'ghp_SUPERSECRET_LEAK';
  s.syncMeta.gistId = 'gist_leak_id';
  s.settings.ocr.apiKey = 'ocr_secret_key';
  const payload = JSON.stringify(SC.buildRemote(s, {}));
  ok('负载里没有令牌', payload.indexOf('SUPERSECRET') < 0);
  ok('负载里没有 Gist ID', payload.indexOf('gist_leak_id') < 0);
  ok('负载里没有 OCR Key', payload.indexOf('ocr_secret_key') < 0);
  ok('负载里连 syncMeta 都没有', payload.indexOf('syncMeta') < 0);

  const exp = JSON.stringify(M.toExport(s, ''));
  ok('导出 JSON 里没有令牌', exp.indexOf('SUPERSECRET') < 0);
  ok('导出 JSON 里没有 Gist ID', exp.indexOf('gist_leak_id') < 0);
  ok('导出 JSON 里没有 OCR Key', exp.indexOf('ocr_secret_key') < 0);
  eq('导出后同步开关回落为关闭', M.fromImport(M.toExport(s, '')).syncMeta.enabled, false);

  section('【14】settings 逐字段打补丁，不冲掉本机 Key');
  const loc = dev('dev_LOC');
  loc.settings.ocr.apiKey = 'KEEP_ME';
  loc.settings.reminderLeadDays = 3;
  SC.diffToOps(loc);
  const rem = dev('dev_REM');
  rem.settings.reminderLeadDays = 10;
  rem.settings.heroCollapsed = true;                 // 纯本机字段
  SC.diffToOps(rem);
  const remPayload = SC.buildRemote(rem, {});
  remPayload.snapshot.settings.rev = 99;
  remPayload.snapshot.settings.rt = CLOCK + 1000;
  SC.mergeRemote(loc, remPayload, 'merge');
  eq('远端字段被采纳', loc.settings.reminderLeadDays, 10);
  eq('★ 本机 OCR Key 未被冲掉', loc.settings.ocr.apiKey, 'KEEP_ME');
  ok('heroCollapsed 不在负载里', JSON.stringify(remPayload.snapshot.settings).indexOf('heroCollapsed') < 0);
  ok('ocr 整块不在负载里', JSON.stringify(remPayload.snapshot.settings).indexOf('"ocr"') < 0);
}

/* ============================================================
 * 5. 快照：按日期写一次 + 不看汇率
 * ============================================================ */
section('【15】资产快照按日期写一次，且汇率不参与指纹');
{
  const fx1 = { mv: 1, cost: 1, pred: 1, recv: 1, fx: { HKD: 0.9 } };
  const fx2 = { mv: 1, cost: 1, pred: 1, recv: 1, fx: { HKD: 0.7 } };
  eq('只有汇率不同 → 指纹相同', SC.DEFS.snap.hash(fx1), SC.DEFS.snap.hash(fx2));

  const a = dev('dev_SA');
  a.snapshots = { '2026-09-29': JSON.parse(JSON.stringify(fx1)) };
  SC.diffToOps(a);
  a.snapshots['2026-09-29'].fx = { HKD: 0.7 };
  eq('★ 只改汇率不产出 op', SC.diffToOps(a).ops.length, 0);
  eq('★ 盖上戳之后也不产出 op（指纹排除 rev/rt/rd）', SC.diffToOps(a).ops.length, 0);

  const snapRemote = SC.buildRemote(a, { snapshot: null });
  const b = dev('dev_SB');
  b.snapshots = { '2026-09-29': { mv: 777, cost: 50, pred: 10, recv: 5, fx: { HKD: 0.8 } } };
  SC.diffToOps(b);
  SC.mergeRemote(b, snapRemote, 'merge');
  eq('★ 同一天先到先得：本地 777 未被改写', b.snapshots['2026-09-29'].mv, 777);
  eq('本机汇率被保留', b.snapshots['2026-09-29'].fx.HKD, 0.8);
}

/* ============================================================
 * 6. 不会误删 / 首次接入模式 / 墓碑上路
 * ============================================================ */
section('【16】本机从未持有的远端记录绝不被当成删除');
{
  const s = dev('dev_MIS');
  s.syncMeta.versions['tx:remote_only'] = { rev: 1, rt: 1, rd: 'dev_OTHER', h: 'deadbeef', q: 0 };
  eq('★ 不发墓碑', SC.diffToOps(s).ops.filter((o) => o.d === 1).length, 0);

  const s2 = dev('dev_MIS2');
  SC.mergeRemote(s2, {
    v: 1, version: 5, snapshot: null, tombstones: [],
    ops: [{ t: 'acc', id: 'acc_remote', s: { rev: 1, rt: 111, rd: 'dev_X' }, d: 0, r: { accountId: 'acc_remote', name: '远端账户', type: 'BROKER', sortOrder: 2 } }],
  }, 'merge');
  eq('远端账户被合并进来', s2.accounts.filter((a) => a.accountId === 'acc_remote').length, 1);
  eq('也没有反过来产出删除', SC.diffToOps(s2).ops.filter((o) => o.d === 1).length, 0);

  section('【17】首次接入模式判定（防静默覆盖已有数据）');
  eq('空白设备 → 直接覆盖', SC.firstSyncMode(freshState()), 'overwrite');
  const dirty = freshState();
  dirty.transactions.push(tx('tx_own'));
  eq('★ 已有自己的账 → 询问用户', SC.firstSyncMode(dirty), 'ask');
  const paired = freshState();
  paired.syncMeta.everPaired = true;
  eq('曾配对过 → 一律合并', SC.firstSyncMode(paired), 'merge');

  section('【18】本机新增会被推给远端；墓碑随负载上路');
  const push = dev('dev_PUSH');
  push.transactions.push(tx('tx_new'));
  const pushOps = SC.diffToOps(push).ops;
  eq('★ 本机新增产出 1 条 op', pushOps.length, 1);
  ok('该 op 带 payload 能推给远端', SC.buildRemote(push, {}).ops.some((o) => o.id === 'tx_new' && o.r));

  const carrier = dev('dev_TC');
  carrier.transactions.push(tx('tx_del'));
  SC.diffToOps(carrier);
  carrier.transactions = [];
  SC.diffToOps(carrier);
  const carried = SC.buildRemote(carrier, {});
  eq('★ 墓碑随负载一起上路', (carried.tombstones || []).length >= 1, true);
  const freshDev = dev('dev_FRESH');
  SC.mergeRemote(freshDev, carried, 'overwrite');
  ok('新设备登记了墓碑', !!freshDev.syncMeta.tombstones['tx:tx_del']);
  SC.applyOps(freshDev, [{ t: 'tx', id: 'tx_del', d: 0, s: { rev: 1, rt: 1, rd: 'dev_X' }, r: tx('tx_del') }]);
  eq('★ 复活被墓碑挡住', freshDev.transactions.length, 0);

  section('【19】覆盖式对齐不产生反向删除（clearData / 首次配对的关键）');
  const ovr = dev('dev_OVR');
  ovr.transactions.push(tx('tx_old1'), tx('tx_old2'));
  SC.diffToOps(ovr);
  ovr.syncMeta.tombstones['tx:tx_gone'] = { rev: 1, rt: 1, rd: 'dev_OVR' };
  SC.mergeRemote(ovr, {
    v: 1, version: 9, tombstones: [],
    snapshot: { accounts: [], symbols: {}, transactions: [], received: [], expenses: [], settings: {}, projection: {} }, ops: [],
  }, 'overwrite');
  eq('★ 不吐出反向删除', SC.diffToOps(ovr).ops.filter((o) => o.d === 1).length, 0);
  ok('已有墓碑被保留', !!ovr.syncMeta.tombstones['tx:tx_gone']);
}

/* ============================================================
 * 7. 迁移 / 墓碑封顶 / 状态自述
 * ============================================================ */
section('【20】老版本负载先补容器再同步');
{
  const legacy = M.fromImport({ version: 3, transactions: [tx('tx_legacy')], symbols: { sh600023: { symbol: 'sh600023', name: '浙能电力' } } });
  eq('被迁移到当前版本', legacy.version, M.DATA_VERSION);
  ok('有了 syncMeta 容器', !!legacy.syncMeta);
  eq('同步默认关闭', legacy.syncMeta.enabled, false);
  eq('首次纳入不产出 op', SC.seedVersions(legacy), 0);

  section('【21】墓碑封顶：只裁最老的');
  const gcDev = dev('dev_GC');
  const mGC = SC.meta(gcDev);
  for (let i = 0; i < SC.TOMB_CAP + 50; i++) mGC.tombstones['tx:gc_' + i] = { rev: 1, rt: 1000 + i, rd: 'dev_GC' };
  SC.gcTombstones(mGC);
  eq('裁到上限', Object.keys(mGC.tombstones).length, SC.TOMB_CAP);
  ok('★ 留下的最新的', !!mGC.tombstones['tx:gc_' + (SC.TOMB_CAP + 49)]);
  ok('最老的已移除', !mGC.tombstones['tx:gc_0']);

  section('【22】状态自述');
  const st = SC.status(gcDev);
  eq('默认关闭', st.enabled, false);
  eq('未配对', st.paired, false);
  eq('墓碑数已计入状态', st.tombstoneCount, SC.TOMB_CAP);
  eq('缺 syncMeta 时也能安全自述', SC.status({}).enabled, false);
}

/* ================================================================
 * 【23】支出分类（category）变更必须产出 op
 *   ★ 这条锁的是一个真实缺陷：exp 的内容指纹曾漏掉 category，
 *     于是「在 A 设备把某项从生存改成品质」既不推送也不报错 —— 静默不同步。
 * ================================================================ */
section('【23】支出分类变更必须产出 op（指纹含 category）');
{
  const d = dev('dev_CAT');
  d.expenses = [
    { expenseId: 'e1', key: 'MEALS', label: '三餐', icon: '🍱', monthlyAmount: 600, enabled: true, sortOrder: 1, category: 'essential' },
  ];
  SC.seedVersions(d);
  eq('登记后不产生 op（首次纳入只登记）', SC.diffToOps(d, { noQueue: true }).ops.length, 0);

  /* 只改分类，其余不动 → 必须产出 1 条 op */
  d.expenses[0].category = 'quality';
  const ops = SC.diffToOps(d, { noQueue: true }).ops;
  eq('★ 仅改 category（生存→品质）也产出 op', ops.length, 1);
  eq('op 指向该支出项', ops[0] && ops[0].t + ':' + ops[0].id, 'exp:e1');
  ok('op 不是删除', ops[0] && ops[0].d === 0);

  /* 幂等：同一状态下再跑一次不应再产出 */
  eq('改完再跑不重复产出', SC.diffToOps(d, { noQueue: true }).ops.length, 0);

  /* 分类进快照：另一台设备才拿得到 */
  const snap = SC.buildSnapshot(d);
  const snapExp = (snap.expenses || []).filter((e) => e.expenseId === 'e1')[0];
  eq('★ 快照里带 category', snapExp && snapExp.category, 'quality');
}

/* ================================================================
 * 【24】令牌与 Key 绝不上路（v6 补：fire 要同步，ocr 绝不同步）
 * ================================================================ */
section('【24】载荷边界：fire 上路 / ocr·apiKey·令牌绝不上路');
{
  const d = dev('dev_SEC');
  d.settings.fire = {
    v: 1, yieldBasis: 'market', activeTier: 'regular',
    tierSims: { lean: { monthlySpend: null, drip: 5000, dripYieldPct: null },
      regular: { monthlySpend: 2000, drip: 8000, dripYieldPct: 5 },
      fat: { monthlySpend: null, drip: 5000, dripYieldPct: null } },
    reinvestPct: 80, scenes: [{ sceneId: 's1', name: '换城市', spendPct: -20, dripPct: 50, yieldAdjPct: 0 }],
  };
  d.settings.ocr = { apiKey: 'ocr_secret_key_value', model: 'glm-4v-flash', agreed: true, lastUsedAt: null };
  SC.seedVersions(d);
  SC.meta(d).token = 'SUPERSECRET_TOKEN';
  SC.meta(d).gistId = 'gist_leak_id_0000000000000000';

  const payload = JSON.stringify(SC.buildRemote(d, {}));
  ok('★ 载荷里有 fire（FIRE 试算参数要同步）', payload.indexOf('"fire"') >= 0);
  ok('★ 载荷里有场景名', payload.indexOf('换城市') >= 0);
  ok('载荷里没有令牌', payload.indexOf('SUPERSECRET_TOKEN') < 0);
  ok('载荷里没有 Gist ID', payload.indexOf('gist_leak_id') < 0);
  ok('载荷里没有 OCR Key', payload.indexOf('ocr_secret_key_value') < 0);
  ok('载荷里连 ocr 块都没有', payload.indexOf('"ocr"') < 0);

  const snap = SC.buildSnapshot(d);
  const fireOk = snap.settings && snap.settings.fire && snap.settings.fire.reinvestPct === 80;
  ok('★ 快照 settings 里 fire 完整', !!fireOk);
  ok('快照 settings 里没有 ocr/apiKey',
    JSON.stringify(snap.settings || {}).indexOf('apiKey') < 0);

  /* 白名单本身也要锁住：将来有人「顺手」把 ocr 加进白名单，这条会红 */
  ok('★ SETTINGS_SYNC 白名单含 fire', SC.SETTINGS_SYNC.indexOf('fire') >= 0);
  ok('★ SETTINGS_SYNC 白名单不含 ocr', SC.SETTINGS_SYNC.indexOf('ocr') < 0);
  ok('★ SYNC_META_KEYS 白名单含 tombstones（墓碑跨重启）',
    M.SYNC_META_KEYS.indexOf('tombstones') >= 0);
}

/* ================================================================
 * 【25】盒子指纹：链接被改动 / 来自另一个盒子时明确拒绝
 * ================================================================ */
section('【25】盒子指纹：防「两台设备各连各的盒子」');
{
  const GIST = 'a1b2c3d4e5f6a7b8';
  const fp = SC.boxFingerprintOf(GIST);
  ok('指纹是 4-4 形式', /^[0-9a-f]{4}-[0-9a-f]{4}$/.test(fp));
  eq('同位置指纹恒定（纯函数）', SC.boxFingerprintOf(GIST), fp);
  ok('不同位置指纹不同', SC.boxFingerprintOf('ffffffffffffffff') !== fp);
  eq('非法 Gist ID 返回空串', SC.boxFingerprintOf('not-a-gist'), '');

  const enc = SC.encodeInstall({ token: 'ghp_testtoken', gistId: GIST });
  ok('安装链接可编码', !!enc);
  const dec = SC.decodeInstall(enc);
  eq('解码还原 token', dec && dec.token, 'ghp_testtoken');
  eq('解码还原 Gist ID', dec && dec.gistId, GIST);
  eq('★ 解码带出盒子指纹', dec && dec.boxFingerprint, fp);

  /* 模拟链接被改动：Gist ID 换成另一个（指纹随之不匹配）→ 必须拒绝 */
  const body = JSON.parse(Buffer.from(enc.slice('XJ1p.'.length).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  const tampered = 'XJ1p.' + Buffer.from(JSON.stringify(
    Object.assign({}, body, { g: 'ffffffffffffffff', b: fp }))).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  eq('★ 指纹与 Gist ID 不匹配 → 拒绝解码', SC.decodeInstall(tampered), null);

  /* 老格式（无 b 字段）→ 补算后接受，不阻断迁移 */
  const legacy = 'XJ1p.' + Buffer.from(JSON.stringify({ v: 1, t: 'ghp_testtoken', g: GIST })).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const decLegacy = SC.decodeInstall(legacy);
  ok('老格式链接（无指纹字段）仍可解', !!decLegacy);
  eq('老格式解出时补上指纹', decLegacy && decLegacy.boxFingerprint, fp);
}

console.log('\n' + '='.repeat(56));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('失败清单：\n  - ' + failures.join('\n  - '));
  process.exitCode = 1;
} else {
  console.log('全部通过 ✅');
}
console.log('='.repeat(56));
