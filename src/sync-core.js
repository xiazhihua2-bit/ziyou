/* ==================== 跨设备同步 · 纯逻辑内核 ====================
 * 这一层【只有纯函数】：不碰 DOM、不碰网络、不碰 storage。
 * 因此 verify.mjs 能把它丢进 Node 沙箱独立复算 —— 与 calc.js 同一套待遇。
 * 网络与编排在 src/sync.js（一层薄壳），存储钩子在 src/storage.js（只是一个钩子槽）。
 *
 * 设计要点（与 docs/跨设备同步-方案评估与设计.md 一致）：
 *   · 真源只有 transactions / received / accounts / expenses / symbols / settings
 *     / projection / snapshots。持仓、成本、息率全是 calc 派生的
 *     → 同步底层事实即可，派生值自动收敛，不存在「持仓表双写冲突」。
 *   · 每条记录带一个【修订戳】{ rev, rt, rd }：
 *       rev = 修订号（每次内容变化 +1）  rt = 修订时刻（毫秒）  rd = 设备号
 *     比较顺序 rev → rt → rd。★ rd 兜底是必须的：三台设备的手动时钟可能不一致，
 *     只靠时间戳会出现「后改的被先改的覆盖」；有了 rd 做最终仲裁，
 *     任意两端对同一条冲突都能得出【同一个结论】（收敛性）。
 *   · 删除写【墓碑】：硬删除在另一端会「复活」，墓碑则永远压过新增。
 *   · syncMeta.versions 是「我们知道的所有记录」的账本，每条记两样东西：
 *       h = 上次见到的内容指纹（用来判「这条被改过没有」，避免给 36 处 commit 逐个加参数）
 *       q = 是否「在本机见过实体」（=1）。用来区分两种「本地没有」：
 *             有 q 却没实体  → 本机把它删了     → 发墓碑
 *             无 q 且无实体  → 本机从来没有这条 → 只登记，绝不当删除（否则会误删别的设备的数据）
 *   · 新设备首次拉取后必须把远端戳【全部登记】进 versions（adoptVersions），
 *     否则下一步 diff 会认为「这些我一条没看过」而把整份数据反向推回去，形成回声。
 *
 * ★ 两条踩过的坑（别再犯）：
 *   ① 内容指纹必须排除同步自己的 rev/rt/rd，否则「盖上戳」本身会被当成内容变化，
 *      每次落盘都多出一条无意义的 op。
 *   ② 「本机新产生的记录」必须产出 op —— 否则「手机加仓」永远推不到平板。
 *      与「首次纳入既有数据」的区分只能靠调用方：attach() 走 seedVersions() 只登记，
 *      平时的落盘走 diffToOps() 凡未登记的一律当作新增。
 */

XJ.syncCore = (function () {
  var U = XJ.util;

  /* 同步文件里 ops 最多留这么多条；超了就让 sync.js 折叠（重建 snapshot） */
  var OPS_CAP = 200;
  /* 墓碑上限：只增不减会一直占体积，超过就按最老的裁 */
  var TOMB_CAP = 2000;

  /* 同步的 settings 白名单。刻意【不含】ocr（含 API Key）、
     lastQuoteAt / lastPlanAt / quoteRefreshMs / fx（本机口径）、
     payoutPopupAt / heroCollapsed（「这台设备弹过/收起过没」，同步只会添乱）。 */
  var SETTINGS_SYNC = [
    'defaultAccountId', 'reminderLeadDays', 'heroMetrics', 'heroForecast',
    'defaultDividendBasis', 'showLogo', 'unsupportedDividend', 'indexCompare',
    'showYieldBench', 'dividendFun', 'onboarded',
    /* v6 新增：FIRE 试算参数与场景（整体 LWW）。
       取舍说明：fire 作为一个顶层字段被整体复制，两台设备同时改不同场景会丢一个 ——
       接受它。理由：① FIRE 是单人自用参数，实际几乎不会并发编辑；
       ② 场景是数组，做「按 sceneId 逐项合并」会把核心层复杂度显著抬高；
       ③ 丢失可恢复（重填即可），而代码复杂度不可逆。
       将来若真需要，在 DEFS.set 加一个 nested 钩子即可扩展。 */
    'fire',
  ];

  /* ---------------- 通用小工具 ---------------- */

  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  function toMs(stamp, fallback) {
    if (typeof stamp === 'number' && isFinite(stamp)) return stamp;
    var t = Date.parse(String(stamp || ''));
    return isFinite(t) ? t : fallback;
  }

  /** 稳定序列化：对象键按字典序，丢掉 undefined → 同一内容必得同一字符串 */
  function stable(v) {
    if (v === null || v === undefined) return 'null';
    var t = typeof v;
    if (t === 'number') return isFinite(v) ? String(v) : 'null';
    if (t === 'boolean') return v ? 'true' : 'false';
    if (t === 'string') return JSON.stringify(v);
    if (v instanceof Array) {
      var parts = [];
      for (var i = 0; i < v.length; i++) parts.push(stable(v[i]));
      return '[' + parts.join(',') + ']';
    }
    if (t === 'object') {
      var keys = Object.keys(v).sort();
      var kv = [];
      for (var k = 0; k < keys.length; k++) {
        if (v[keys[k]] === undefined) continue;
        kv.push(JSON.stringify(keys[k]) + ':' + stable(v[keys[k]]));
      }
      return '{' + kv.join(',') + '}';
    }
    return 'null';
  }

  /** 32 位 FNV-1a，输出 8 位十六进制。够用且稳定，不依赖 crypto（verify 沙箱里没有）。 */
  function hash(str) {
    var h = 0x811c9dc5, s = String(str);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  /* ---------------- 实体定义 ----------------
   * 每类实体给出：容器 / 主键 / 内容指纹 / 能否新增 / 是否逐字段打补丁。
   * ★ 「内容指纹」刻意【排除】本地时间戳（createdAt / updatedAt）与可重取缓存，
   *   否则每台设备的本地时间不同，会被误判成「都改过」而互相覆盖。
   */

  function byId(list, key, id) {
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i][key] === id) return list[i];
    }
    return null;
  }

  function pick(obj, fields) {
    var out = {};
    for (var i = 0; i < fields.length; i++) out[fields[i]] = obj ? obj[fields[i]] : undefined;
    return out;
  }

  /** 数组容器的 id 提取：必须返回【字符串主键】而不是记录本身。
      （踩过：曾经写成 `return s.transactions`，于是 def.get(state, '[object Object]')
        永远取不到记录 —— 表现为「改动不产出 op」，而且只有对象键的那几类正常。） */
  function idsOf(list, key) {
    var out = [];
    for (var i = 0; i < (list || []).length; i++) {
      var r = list[i];
      if (r && r[key] !== undefined && r[key] !== null) out.push(r[key]);
    }
    return out;
  }

  /** 内容指纹：一律【排除】同步自己的修订戳字段。
   *  ★ 踩过：snap 的指纹没排除 rt/rd，而 diffToOps 会把戳写在记录上，
   *    于是「盖上戳」本身被算成内容变化 → 每次落盘都多出一条无意义的 op。 */
  function contentHash(def, rec) {
    var f = {};
    Object.keys(rec || {}).forEach(function (k) {
      if (k === 'rev' || k === 'rt' || k === 'rd') return;
      f[k] = rec[k];
    });
    return def.hash(f);
  }

  var DEFS = {
    tx: {
      key: 'txId',
      all: function (s) { return idsOf(s.transactions, 'txId'); },
      get: function (s, id) { return byId(s.transactions || [], 'txId', id); },
      hash: function (r) {
        return hash(stable(pick(r, ['accountId', 'symbol', 'action', 'date', 'quantity',
          'price', 'fee', 'amount', 'note'])));
      },
      canAdd: true,
    },
    rec: {
      key: 'recId',
      all: function (s) { return idsOf(s.received, 'recId'); },
      get: function (s, id) { return byId(s.received || [], 'recId', id); },
      hash: function (r) {
        return hash(stable(pick(r, ['accountId', 'symbol', 'planId', 'exDividendDate',
          'perShareAmount', 'qtyAtRecord', 'amount', 'source', 'year'])));
      },
      canAdd: true,
    },
    acc: {
      key: 'accountId',
      all: function (s) { return idsOf(s.accounts, 'accountId'); },
      get: function (s, id) { return byId(s.accounts || [], 'accountId', id); },
      hash: function (r) { return hash(stable(pick(r, ['name', 'type', 'sortOrder']))); },
      canAdd: true,
    },
    exp: {
      key: 'expenseId',
      all: function (s) { return idsOf(s.expenses, 'expenseId'); },
      get: function (s, id) { return byId(s.expenses || [], 'expenseId', id); },
      /* ★ pick 必须含 category（v6 新增的生存/品质分类）。
         漏掉它的后果特别隐蔽：在 A 设备把某项从「生存」改成「品质」，
         B 设备永远收不到；而 A 设备每次保存都因指纹不变而认为「没变」，
         于是既不推送也不报错 —— 静默不同步。 */
      hash: function (r) {
        return hash(stable(pick(r, ['key', 'label', 'icon', 'iconAuto', 'monthlyAmount',
          'enabled', 'sortOrder', 'category'])));
      },
      canAdd: true,
    },
    sym: {
      key: 'symbol',
      all: function (s) { return Object.keys(s.symbols || {}); },
      get: function (s, id) { return (s.symbols || {})[id]; },
      hash: function (r) {
        /* 只取【用户意图】字段：logoUrl / logoState / domain 是可重取的缓存，
           updatedAt 是行情写的本地时间 —— 都不该算作「用户改过」。 */
        return hash(stable(pick(r, ['symbol', 'code', 'market', 'name', 'nameLocked',
          'nameSuspect', 'type', 'costMethod', 'dividendBasis', 'costRecovered'])));
      },
      canAdd: true,
    },
    snap: {
      key: 'date',
      all: function (s) { return Object.keys(s.snapshots || {}); },
      get: function (s, id) { return (s.snapshots || {})[id]; },
      hash: function (r) {
        /* 只用这几个【客观字段】，刻意不遍历 Object.keys ——
           既排除 fx（本机汇率，两机不同会每天互相改写），
           也顺带排除 diffToOps 写在记录上的 rev/rt/rd 修订戳。 */
        return hash(stable(pick(r, ['mv', 'cost', 'pred', 'recv'])));
      },
      /* ★ 快照按日期【写一次】：两台设备同一天各自算出的 mv 可能因行情新旧差几块钱，
         若允许 LWW 会每天互相改写。先到先得，只补本机没有的日期。 */
      oncePerId: true,
      canAdd: true,
    },
    set: {
      key: null,
      all: function () { return ['app_settings']; },
      get: function (s) { return s.settings; },
      hash: function (r) { return hash(stable(pick(r || {}, SETTINGS_SYNC))); },
      patch: true,       // 合并时按白名单逐字段打补丁，绝不整块替换（否则会连 OCR Key 一起冲掉）
      canAdd: false,
    },
    proj: {
      key: null,
      all: function () { return ['proj_default']; },
      get: function (s) { return s.projection; },
      hash: function (r) {
        return hash(stable(pick(r || {}, ['monthlyInvest', 'years', 'reinvestRatio',
          'divGrowthRate', 'startAssets'])));
      },
      canAdd: false,
    },
  };

  var TYPES = ['tx', 'rec', 'acc', 'exp', 'sym', 'snap', 'set', 'proj'];

  function vid(t, id) { return t + ':' + id; }

  /* ---------------- syncMeta 容器 ---------------- */

  var META_DEFAULT = {
    deviceId: null, enabled: false, token: null, gistId: null,
    version: 0, etag: null, lastOkAt: null,
    failSince: null, lastErr: null, everPaired: false,
    /* 令牌自述的权限范围（GitHub 的 X-OAuth-Scopes）。只在本机记录、只用于界面提示，
       绝不写进 Gist、绝不进导出 —— 它和令牌同级敏感。 */
    tokenScopes: null,
    /* 由安装链接写入的「这台设备首次接入时用哪种方式对齐」，见 firstSyncMode。
       首轮同步成功后由 sync.js 清空，之后一律走 merge。 */
    installMode: null,
    /* 一次性：刚换到一个新的云端位置，这一次拉取必须无条件当真。
       见 app.js 的 resetRemoteMemory —— 新位置的 version 可能与本地归零后的 0 相同，
       而「版本相同＝没变化」的短路会让整次拉取失效。合并后由 sync.js 清掉。 */
    forcePull: false,
    outbox: [], versions: {}, tombstones: {},
  };

  function meta(state) {
    if (!state.syncMeta || typeof state.syncMeta !== 'object') state.syncMeta = {};
    var m = state.syncMeta;
    if (!Array.isArray(m.outbox)) m.outbox = [];
    if (!m.versions || typeof m.versions !== 'object') m.versions = {};
    if (!m.tombstones || typeof m.tombstones !== 'object') m.tombstones = {};
    if (m.enabled !== true) m.enabled = false;
    if (m.everPaired !== true) m.everPaired = false;
    /* installMode 归一化：只认 'merge' / 'overwrite'，其余一律回到 null。
       ★ 这样 meta() 返回的对象始终有个确定的 installMode，
         不会让「老版本导入的 state」留下一个 undefined 的模糊状态。 */
    if (m.installMode !== 'merge' && m.installMode !== 'overwrite') m.installMode = null;
    if (m.forcePull !== true) m.forcePull = false;
    if (m.version === undefined || m.version === null) m.version = 0;
    if (m.tokenScopes !== null && m.tokenScopes !== undefined) m.tokenScopes = String(m.tokenScopes);
    else m.tokenScopes = null;
    if (!m.deviceId) m.deviceId = U.uid('dev');
    return m;
  }

  function makeStamp(rev, rt, rd) {
    return { rev: U.n0(rev), rt: U.n0(rt), rd: String(rd === undefined || rd === null ? '' : rd) };
  }

  function stampOf(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.rev === undefined || obj.rev === null) return null;
    return makeStamp(obj.rev, obj.rt, obj.rd);
  }

  /** a 是否比 b 更新。rev → rt → rd 依次比较，rd 保证任意两端得出同一结论。 */
  function newer(a, b) {
    if (!b) return !!a;
    if (!a) return false;
    if (U.n0(a.rev) !== U.n0(b.rev)) return U.n0(a.rev) > U.n0(b.rev);
    if (U.n0(a.rt) !== U.n0(b.rt)) return U.n0(a.rt) > U.n0(b.rt);
    return String(a.rd || '') > String(b.rd || '');
  }

  /** 现在（毫秒）。走 Date.now() 便于 verify 用假时钟冻结。 */
  function nowMs() { return Date.now(); }

  /* ---------------- 内容变化 → op（写入前调用） ---------------- */

  /**
   * 把 state 里所有「内容变了 / 本地没了 / 还没登记过」的记录算成 op，并更新 versions。
   * 【幂等】：内容没变就不会再产出 op，也不会改动任何东西。
   *
   * opts.seed = true 时走「首次纳入」语义：未登记的记录只登记、不产出 op。
   * 供 seedVersions() 使用 —— 那才是「把既有数据纳入同步」的正确入口。
   *
   * 返回 { ops, changed }：ops 是本次产生的增量（也追加进了 outbox，除非 opts.noQueue）。
   */
  function diffToOps(state, opts) {
    opts = opts || {};
    var m = meta(state);
    var dev = m.deviceId;
    var t = nowMs();
    var ops = [];
    var visible = {};

    for (var ti = 0; ti < TYPES.length; ti++) {
      var type = TYPES[ti];
      var def = DEFS[type];
      var ids = def.all(state);

      for (var ii = 0; ii < ids.length; ii++) {
        var id = ids[ii];
        var rec = def.get(state, id);
        if (!rec || typeof rec !== 'object') continue;
        var key = vid(type, id);
        visible[key] = true;

        var h = contentHash(def, rec);
        var known = m.versions[key];

        if (known && known.q === 1) {
          if (known.h === h) {
            /* ① 内容没变 → 无事可做（这是绝大多数保存的情形） */
            if (!stampOf(rec)) {
              /* 极少数：账本里有，记录上却没戳 → 补上，不再发 op */
              rec.rev = known.rev; rec.rt = known.rt; rec.rd = known.rd;
            }
            continue;
          }
          /* ② 内容变了 → 修订号 +1，产出 op */
          var revEdit = U.n0(known.rev) + 1;
          rec.rev = revEdit; rec.rt = t; rec.rd = dev;
          known.rev = revEdit; known.rt = t; known.rd = dev; known.h = h;
          ops.push({ t: type, id: id, s: makeStamp(revEdit, t, dev), d: 0 });
          continue;
        }

        /* ③ 账本里没有这条 → 是本机新产生的记录（用户新增、或自动登记的到账），
              必须产出 op 推给远端，否则「手机加仓」永远到不了平板。 */
        if (!opts.seed) {
          var revNew = U.n0(rec.rev) || 1;
          rec.rev = revNew; rec.rt = t; rec.rd = dev;
          m.versions[key] = { rev: revNew, rt: t, rd: dev, h: h, q: 1 };
          ops.push({ t: type, id: id, s: makeStamp(revNew, t, dev), d: 0 });
          continue;
        }

        /* ④ 首次纳入既有数据（只在 seedVersions 里走到）：只登记，不产出 op。
              起点从 createdAt 派生，好让两端对同一条的起点尽量接近。 */
        var seedRev = U.n0(rec.rev) || 1;
        var seedRt = rec.rt !== undefined && rec.rt !== null ? U.n0(rec.rt) : toMs(rec.createdAt, t);
        var seedRd = rec.rd || dev;
        rec.rev = seedRev; rec.rt = seedRt; rec.rd = seedRd;
        m.versions[key] = { rev: seedRev, rt: seedRt, rd: seedRd, h: h, q: 1 };
      }
    }

    /* ⑤ 账本里有「q=1」（本机见过实体）却已看不见 → 本机把它删了 → 发墓碑。
          q 不是 1 的说明本机从来没有这条（别的设备加的），绝不当成删除，否则会误删别人的数据。 */
    var vkeys = Object.keys(m.versions);
    for (var vi = 0; vi < vkeys.length; vi++) {
      var vk = vkeys[vi];
      var entry = m.versions[vk];
      if (entry.q !== 1) continue;                 // 本机从未持有 → 留着当「远端已知」，不发墓碑
      if (visible[vk]) continue;
      var cut = vk.indexOf(':');
      var vt = vk.slice(0, cut);
      if (!DEFS[vt]) { delete m.versions[vk]; continue; }
      var vid0 = vk.slice(cut + 1);
      var tomb = m.tombstones[vk];

      /* ★ 修复「墓碑修订号漂移」：墓碑一旦发出，它的 (rev, rt, rd) 就【冻结】。
         曾经写成每次 diff 都 entry.rev + 1，后果是——
           ① 别处新加的远端 op 需要救活这条时，比不过被反复推高的墓碑 → 永远救不活；
           ② 墓碑自己每次落盘都产出 op → 无谓的网络流量。
         冻结点取「墓碑自己的时刻」；只有拿不到时才回落到当下，保证墓碑在「先删除后编辑」里不输。 */
      var nstamp = tomb
        ? makeStamp(tomb.rev, tomb.rt, tomb.rd)
        : makeStamp(U.n0(entry.rev) + 1, U.n0(entry.rt) || t, dev);
      if (!tomb || newer(nstamp, makeStamp(tomb.rev, tomb.rt, tomb.rd))) {
        m.tombstones[vk] = { rev: nstamp.rev, rt: nstamp.rt, rd: nstamp.rd };
        ops.push({ t: vt, id: vid0, s: nstamp, d: 1 });
      }
      delete m.versions[vk];
    }

    if (!opts.noQueue) {
      for (var oi = 0; oi < ops.length; oi++) m.outbox.push(ops[oi]);
    }
    gcTombstones(m);
    return { ops: ops, changed: ops.length };
  }

  /** 把既有数据「登记」进账本，但不产生任何 op（首次落盘 / 打开同步时用） */
  function seedVersions(state) {
    return diffToOps(state, { noQueue: true, seed: true }).ops.length;
  }

  /**
   * 把本机【全部实体】作为 upsert 放进 outbox，下一次推送就会带上完整并集。
   *
   * 为什么需要它：增量的前提是「账本记得每条长什么样」。可一旦设备换到另一个
   * 云端位置（或者账本曾经被清空过），账本对这份数据的记忆就与目标位置无关了 ——
   * diffToOps 会认为「全都见过、没变化」，于是本机独有的记录【永远不会被推上去】。
   * 表现就是「接了回来，两边却还是不一样」。
   *
   * ★ 只放 upsert、不放墓碑：墓碑要保留在各自那边，靠「删除必胜」在合并时生效。
   *   这条路径如果顺手发墓碑，就会把「本机没有」当成「本机删了」，那是不可逆的伤害。
   * ★ 同键去重：outbox 里可能已经有同一条的 op，重复入队只会让负载翻倍。
   * ★ opts.keys 可以只挑一部分实体（切换位置时用来挑「云端还没有的那几条」）。
   * ★ 增量为 0 时是空操作（返回 0），不产生任何流量。
   *
   * ★★ 调用时机很重要：必须在【合并之后】。合并之后账本里已经记下「云端有哪些」，
   *    此时只补推云端没有的那几条，才是真正的并集。
   *    如果先无条件全推、再合并，本机把已在云端的记录又推一遍，
   *    每输一次版本号就涨一次 —— 那正是「重复增量把云端撑大、最后写入被拒」的老路。
   */
  function enqueueAll(state, opts) {
    opts = opts || {};
    var only = opts.keys && typeof opts.keys === 'object' ? opts.keys : null;
    var m = meta(state);
    var have = {};
    for (var oi = 0; oi < m.outbox.length; oi++) {
      var o = m.outbox[oi];
      if (o && o.t && !o.d) have[vid(o.t, o.id)] = true;
    }
    var added = 0;
    for (var ti = 0; ti < TYPES.length; ti++) {
      var type = TYPES[ti];
      var def = DEFS[type];
      if (!def) continue;
      var ids = def.all(state);
      for (var ii = 0; ii < ids.length; ii++) {
        var id = ids[ii];
        var key = vid(type, id);
        if (have[key]) continue;
        if (only && !only[key]) continue;
        var rec = def.get(state, id);
        if (!rec || typeof rec !== 'object') continue;
        var st = stampOf(rec) || makeStamp(1, toMs(rec.createdAt, 0), m.deviceId);
        m.outbox.push({ t: type, id: id, s: makeStamp(st.rev, st.rt, st.rd), d: 0 });
        have[key] = true;
        added++;
      }
    }
    gcTombstones(m);
    return added;
  }

  /** 墓碑清单（推给远端用）：一条删除必须让新设备也知道「这条是被删了」，而不只是「没有」 */
  function tombstoneList(m) {
    var out = [];
    Object.keys(m.tombstones || {}).forEach(function (vk) {
      var cut = vk.indexOf(':');
      var vt = vk.slice(0, cut);
      if (!DEFS[vt]) return;
      var t = m.tombstones[vk];
      out.push({ t: vt, id: vk.slice(cut + 1), s: makeStamp(t.rev, t.rt, t.rd) });
    });
    return out;
  }

  /** 墓碑封顶：按 (rt, rev, id) 最老的裁掉，避免无限增长 */
  function gcTombstones(m) {
    var keys = Object.keys(m.tombstones || {});
    if (keys.length <= TOMB_CAP) return 0;
    keys.sort(function (a, b) {
      var x = m.tombstones[a], y = m.tombstones[b];
      if (U.n0(x.rt) !== U.n0(y.rt)) return U.n0(x.rt) - U.n0(y.rt);
      return a < b ? -1 : a > b ? 1 : 0;
    });
    var drop = keys.length - TOMB_CAP;
    for (var i = 0; i < drop; i++) delete m.tombstones[keys[i]];
    return drop;
  }

  /* ---------------- 应用远端 op ---------------- */

  function containerList(state, type) {
    if (type === 'tx') return state.transactions;
    if (type === 'rec') return state.received;
    if (type === 'acc') return state.accounts;
    if (type === 'exp') return state.expenses;
    return null;
  }

  function containerMap(state, type) {
    if (type === 'sym') return state.symbols || (state.symbols = {});
    if (type === 'snap') return state.snapshots || (state.snapshots = {});
    return null;
  }

  function addRecord(state, type, id, next) {
    if (type === 'tx') { state.transactions.push(next); return true; }
    if (type === 'rec') { state.received.push(next); return true; }
    if (type === 'acc') { state.accounts.push(next); return true; }
    if (type === 'exp') { state.expenses.push(next); return true; }
    var map = containerMap(state, type);
    if (map) { map[id] = next; return true; }
    return false;
  }

  function replaceRecord(state, type, id, next, def) {
    var list = containerList(state, type);
    if (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i][def.key] === id) { list[i] = next; return true; }
      }
      return false;
    }
    var map = containerMap(state, type);
    if (map) { map[id] = next; return true; }
    return false;
  }

  function removeRecord(state, type, id, def) {
    var list = containerList(state, type);
    if (list) {
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i] && list[i][def.key] === id) { list.splice(i, 1); return true; }
      }
      return false;
    }
    var map = containerMap(state, type);
    if (map && map[id] !== undefined) { delete map[id]; return true; }
    return false;
  }

  /** 推给远端前把同步专用的戳字段摘掉（线路上用 op 里的 s 表达） */
  function stripSyncFields(rec) {
    var out = {};
    Object.keys(rec || {}).forEach(function (k) {
      if (k === 'rev' || k === 'rt' || k === 'rd') return;
      out[k] = rec[k];
    });
    return out;
  }

  /**
   * 就地把远端 op 应用到 state。返回 { applied, skipped, deleted }。
   * 必须【幂等】：网络重投、重复拉取都会发生，同一 op 应用两次结果必须一致。
   * 这里顺带更新 versions，因此随后的 diff 天然产出 0 条 op（双重防回声）。
   */
  function applyOps(state, ops) {
    var m = meta(state);
    var res = { applied: 0, skipped: 0, deleted: 0 };
    if (!Array.isArray(ops)) return res;

    /* 账本条目：q=1 本机持有；q=0 只是「知道有这条」（远端删除时这样记，
       免得下一步 diff 把它当成「我删的」再发一次墓碑）。 */
    function note(key, stamp, h, hasLocal) {
      m.versions[key] = {
        rev: U.n0(stamp.rev), rt: U.n0(stamp.rt), rd: String(stamp.rd || ''),
        h: h, q: hasLocal ? 1 : 0,
      };
    }

    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (!op || !op.t) { res.skipped++; continue; }
      var def = DEFS[op.t];
      if (!def) { res.skipped++; continue; }
      var key = vid(op.t, op.id);
      var st = makeStamp(op.s && op.s.rev, op.s && op.s.rt, op.s && op.s.rd);
      var local = def.get(state, op.id);
      var localStamp = stampOf(local);

      /* ---- 删除 ---- */
      if (op.d) {
        /* 本地在墓碑之后又被改过（戳更新）→ 保留本地；否则删除获胜 */
        if (local && localStamp && newer(localStamp, st)) {
          note(key, localStamp, contentHash(def, local), true);
        } else {
          m.tombstones[key] = { rev: st.rev, rt: st.rt, rd: st.rd };
          if (local) { removeRecord(state, op.t, op.id, def); res.deleted++; }
          note(key, st, undefined, false);
        }
        res.applied++;
        continue;
      }

      /* ---- 新增 / 修改 ---- */
      var remoteRec = op.r;
      if (!remoteRec || typeof remoteRec !== 'object') { res.skipped++; continue; }

      /* 快照：按日期写一次，先到先得 */
      if (def.oncePerId && local) {
        note(key, localStamp || st, contentHash(def, local), true);
        res.skipped++;
        continue;
      }

      /* 墓碑压过「新增」；只有远端戳更新（= 墓碑之后的新内容）才允许覆盖墓碑 */
      var tomb = m.tombstones[key];
      if (tomb && !newer(st, makeStamp(tomb.rev, tomb.rt, tomb.rd))) {
        res.skipped++;
        continue;
      }
      if (tomb) delete m.tombstones[key];

      /* 本地这条更旧才允许替换 */
      if (local && localStamp && !newer(st, localStamp)) {
        note(key, localStamp, contentHash(def, local), true);
        res.skipped++;
        continue;
      }

      var next = stripSyncFields(remoteRec);
      next.rev = st.rev; next.rt = st.rt; next.rd = st.rd;

      if (local) {
        if (op.t === 'set') {
          /* settings：按白名单逐字段打补丁，绝不整块替换 —— 否则会连 OCR Key 一起冲掉。
             但若本地 settings 上还没有戳，说明它从未纳入同步，先整块打底再盖字段。 */
          if (!stampOf(local)) {
            Object.keys(remoteRec).forEach(function (k) {
              if (k === 'ocr' || k === 'apiKey') return;
              local[k] = clone(remoteRec[k]);
            });
          } else {
            for (var si = 0; si < SETTINGS_SYNC.length; si++) {
              var f = SETTINGS_SYNC[si];
              if (remoteRec[f] !== undefined) local[f] = clone(remoteRec[f]);
            }
          }
          local.rev = st.rev; local.rt = st.rt; local.rd = st.rd;
        } else if (op.t === 'proj') {
          Object.keys(remoteRec).forEach(function (k) { local[k] = clone(remoteRec[k]); });
          local.rev = st.rev; local.rt = st.rt; local.rd = st.rd;
        } else {
          replaceRecord(state, op.t, op.id, next, def);
        }
      } else if (def.canAdd) {
        addRecord(state, op.t, op.id, next);
      } else {
        res.skipped++; continue;
      }

      var nowRec = (op.t === 'set' || op.t === 'proj') ? null : def.get(state, op.id);
      note(key, st, nowRec ? contentHash(def, nowRec) : contentHash(def, remoteRec), true);
      res.applied++;
    }
    return res;
  }

  /* ---------------- 生成 snapshot / 远端负载 ---------------- */

  /** snapshot = 全量核心数据（含戳），供新设备一次拉完即可用 */
  function buildSnapshot(state) {
    var snap = {
      accounts: [], symbols: {}, transactions: [], received: [],
      expenses: [], snapshots: {}, settings: {}, projection: {},
    };
    for (var ti = 0; ti < TYPES.length; ti++) {
      var type = TYPES[ti];
      var def = DEFS[type];
      var ids = def.all(state);
      for (var ii = 0; ii < ids.length; ii++) {
        var id = ids[ii];
        var rec = def.get(state, id);
        if (!rec || typeof rec !== 'object') continue;
        var copy = stripSyncFields(rec);
        var st = stampOf(rec) || makeStamp(1, toMs(rec.createdAt, 0), 'seed');
        copy.rev = st.rev; copy.rt = st.rt; copy.rd = st.rd;
        if (type === 'set') snap.settings = copy;
        else if (type === 'proj') snap.projection = copy;
        else if (type === 'sym') snap.symbols[id] = copy;
        else if (type === 'snap') snap.snapshots[id] = copy;
        else if (type === 'tx') snap.transactions.push(copy);
        else if (type === 'rec') snap.received.push(copy);
        else if (type === 'acc') snap.accounts.push(copy);
        else if (type === 'exp') snap.expenses.push(copy);
      }
    }
    /* ★ settings 只带白名单字段：绝不让 OCR Key 上路 */
    var s = snap.settings || {};
    var slim = {};
    for (var si = 0; si < SETTINGS_SYNC.length; si++) {
      var f = SETTINGS_SYNC[si];
      if (s[f] !== undefined) slim[f] = s[f];
    }
    if (s.rev !== undefined) { slim.rev = s.rev; slim.rt = s.rt; slim.rd = s.rd; }
    snap.settings = slim;
    return snap;
  }

  /** 用 snapshot 把本地登记满（首次配对后防回声） */
  function adoptVersions(state, remote) {
    var m = meta(state);
    var snap = (remote && remote.snapshot) || {};
    var n = 0;
    for (var ti = 0; ti < TYPES.length; ti++) {
      var type = TYPES[ti];
      var def = DEFS[type];
      var ids = def.all(snap);
      for (var ii = 0; ii < ids.length; ii++) {
        var id = ids[ii];
        var rec = def.get(snap, id);
        if (!rec || typeof rec !== 'object') continue;
        var st = stampOf(rec);
        if (!st) continue;
        var key = vid(type, id);
        var cur = m.versions[key];
        if (cur && cur.q === 1 && !newer(st, makeStamp(cur.rev, cur.rt, cur.rd))) continue;
        var localRec = def.get(state, id);
        m.versions[key] = {
          rev: st.rev, rt: st.rt, rd: st.rd,
          h: contentHash(def, localRec || rec),
          q: localRec ? 1 : 0,
        };
        n++;
      }
    }
    return n;
  }

  /* ---------------- 首次配对 / 整份对齐 ---------------- */

  /**
   * 用远端数据对齐本地。
   *   'overwrite' 清空本地核心容器，以远端为准（新设备首次配对）
   *   'merge'     两边并集，按主键去重、按修订戳取新（已记过账的设备接入时用）
   * 返回 { mode, applied, skipped, deleted }。
   */
  function mergeRemote(state, remote, mode) {
    var m = meta(state);
    var useOverwrite = mode === 'overwrite';
    var snap = (remote && remote.snapshot) || {};

    if (useOverwrite) {
      state.transactions = [];
      state.received = [];
      state.accounts = [];
      state.expenses = [];
      state.symbols = {};
      state.snapshots = {};
      /* 清空 versions，但【保留 tombstones 与连接信息】——
         否则下一步会认为「我把所有东西都删了」并到处发墓碑。 */
      m.versions = {};
      /* ★ 必须在这次赋值【之后】重新取一次 meta。
         applyOps 内部会重新调用 meta(state)、发现 versions 不是对象就换成新对象，
         于是这里手里的 m 会变成悬空引用 —— 后面写 m.version / m.everPaired 全部落空。
         （踩过：表现为「覆盖式对齐后版本号永远是 0」，同步会因此反复重推。） */
      m = meta(state);
    }

    var all = [];

    /* 先灌墓碑：它决定了随后哪些记录会被拒绝（删除必胜） */
    var tombs = (remote && remote.tombstones) || [];
    for (var xi = 0; xi < tombs.length; xi++) {
      var tb = tombs[xi];
      if (!tb || !DEFS[tb.t]) continue;
      all.push({ t: tb.t, id: tb.id, d: 1, s: makeStamp(tb.s && tb.s.rev, tb.s && tb.s.rt, tb.s && tb.s.rd) });
    }

    for (var ti = 0; ti < TYPES.length; ti++) {
      var type = TYPES[ti];
      var def = DEFS[type];
      var ids = def.all(snap);
      for (var ii = 0; ii < ids.length; ii++) {
        var id = ids[ii];
        var rec = def.get(snap, id);
        if (!rec || typeof rec !== 'object') continue;
        all.push({
          t: type, id: id, d: 0, r: rec,
          s: stampOf(rec) || makeStamp(1, toMs(rec.createdAt, 0), 'remote'),
        });
      }
    }

    /* ops 是 snapshot 之后的最新增量：必须补在里面，否则首次配对漏拉最近改动。
       （对同一 id 重复给出没关系——戳相同，第二次会被 newer() 挡掉。） */
    var ops = (remote && remote.ops) || [];
    for (var oi = 0; oi < ops.length; oi++) {
      var op = ops[oi];
      if (!op || !DEFS[op.t]) continue;
      var d = DEFS[op.t];
      var payload = op.r;
      if (!payload && !op.d) {
        payload = op.t === 'set' ? snap.settings
          : op.t === 'proj' ? snap.projection
            : d.get(snap, op.id);
      }
      if (!op.d && (!payload || typeof payload !== 'object')) continue;
      all.push({
        t: op.t, id: op.id, d: op.d ? 1 : 0, r: payload,
        s: makeStamp(op.s && op.s.rev, op.s && op.s.rt, op.s && op.s.rd),
      });
    }

    var res = applyOps(state, all);
    res.mode = useOverwrite ? 'overwrite' : 'merge';
    m.version = U.n0(remote && remote.version);
    m.everPaired = true;
    /* ★ 安装链接锚定的首次对齐方式【只用一次】：已经按它对齐并配对成功，立刻清掉。
       否则以后每次换 Gist / 重连都会重演一次覆盖，那是不可逆的伤害。 */
    m.installMode = null;
    /* 远端 snapshot 里还有没被 op 覆盖到的戳，一并登记，避免回声 */
    adoptVersions(state, remote);
    return res;
  }

  /**
   * 把 outbox 里的 op 补上 payload（取自本地 state），生成要推送的远端文件。
   * 返回 { v, version, deviceId, at, snapshot, tombstones, ops }。
   */
  function buildRemote(state, opts) {
    opts = opts || {};
    var m = meta(state);
    var src = opts.ops || m.outbox || [];
    /* snapshot 只算一次：每个 op 都调一次 buildSnapshot 是平方级浪费 */
    var snap = opts.snapshot === null ? null : (opts.snapshot || buildSnapshot(state));
    var out = [];
    for (var i = 0; i < src.length; i++) {
      var op = src[i];
      var def = DEFS[op.t];
      if (!def) continue;
      var one = { t: op.t, id: op.id, s: makeStamp(op.s && op.s.rev, op.s && op.s.rt, op.s && op.s.rd), d: op.d ? 1 : 0 };
      if (!op.d) {
        var rec = op.t === 'set' ? (snap ? snap.settings : state.settings)
          : op.t === 'proj' ? (snap ? snap.projection : state.projection)
            : def.get(state, op.id);
        if (!rec) continue;                       // 已删除：跳过（墓碑才是它的归宿）
        one.r = stripSyncFields(rec);
      }
      out.push(one);
      if (out.length >= 500) break;
    }
    return {
      v: 1,
      version: U.n0(opts.version !== undefined ? opts.version : m.version) + 1,
      deviceId: m.deviceId,
      at: U.nowStamp(),
      snapshot: snap,
      /* ★ 墓碑必须一起上路：没有它，新设备无法区分「这条被删了」和「本来就没有」，
         于是被删的记录会在它那儿复活。 */
      tombstones: tombstoneList(m),
      ops: out,
    };
  }

  /* ---------------- 首次接入的安全判定（见计划 §4） ---------------- */

  /**
   *   · 安装链接已锚定（installMode = 'merge' | 'overwrite'）→ 用用户选的那个
   *   · 从未配对过，且本机是空白（无交易、无到账） → 'overwrite'（无摩擦）
   *   · 从未配对过，但本机已有自己的记账数据       → 'ask'（界面弹窗让用户选）
   *   · 曾配对过（换设备/重装后重连）              → 'merge'（绝不覆盖）
   *
   *  ★ 为什么要有 installMode 这一层：sync.js 的自动路径过去把 'ask' 一律降级成
   *    merge，于是「在已有数据的设备上点安装链接」会静默合并 —— 而合并是不可逆的。
   *    现在界面必须先问清楚，把答案锚在 syncMeta 里，核心层照它执行。
   */
  function firstSyncMode(state) {
    var m = meta(state);
    if (m.installMode === 'merge' || m.installMode === 'overwrite') return m.installMode;
    if (m.everPaired) return 'merge';
    var hasData = (state.transactions && state.transactions.length > 0) ||
      (state.received && state.received.length > 0);
    return hasData ? 'ask' : 'overwrite';
  }

  /* ---------------- 安装链接（一劳永逸的配对捷径） ---------------- */

  /**
   *  一次配对，三台设备各点一次，之后永远不再配置。
   *
   *  链接形如  https://<站点>/#xjsync=XJ1p.<base64url>
   *  载荷      { v:1, t:令牌, g:GistID }
   *
   *  ★ 这是【唯一】一条把令牌带出本机的路径，因此规则写死在这里：
   *    · 只带 v / t / g 三样，绝不含 deviceId、versions、outbox、etag —— 那些是本机状态
   *    · 编码复用 transfer 的 base64url（UTF-8 → 字节 → base64url，无填充），
   *      目的是缩短链接长度，并让链接被误贴到网页时不会触发明文匹配。
   *      ★ 这不是安全措施：链接本身就是钥匙，拿到链接 = 拿到读写云端的权限。
   *    · 任何一处不合法一律返回 null，绝不抛错、绝不「尽力猜」
   */

  var INSTALL_KEY = '#xjsync=';
  /* 只认明文编码（XJ1p.）。XJ1g. 是 gzip 变体，链接太长没意义，直接拒绝。 */
  var INSTALL_PREFIX = 'XJ1p.';
  var INSTALL_MAX = 1200;                       // 链接里那一小段的长度上限
  var GIST_ID_RE = /^[0-9a-f]{16,40}$/i;

  /** base64url 编码器：优先用 transfer 借来的字节/base64 工具（避免在两层里各写一份） */
  function b64urlOf(str) {
    var T = XJ.transfer || {};
    if (typeof T.b64url === 'function' && typeof T.utf8Bytes === 'function') {
      return T.b64url(T.utf8Bytes(str));
    }
    /* transfer 不在场时的兜底：只支持 ASCII（令牌与 Gist ID 都是 ASCII） */
    try { return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
    catch (e) { return null; }
  }

  /** base64url 解码器：返回字符串或 null（绝不抛错） */
  function unb64urlOf(s) {
    var T = XJ.transfer || {};
    if (typeof T.unb64url === 'function' && typeof T.bytesUtf8 === 'function') {
      try {
        var bytes = T.unb64url(s);
        if (!bytes || !bytes.length) return null;
        return T.bytesUtf8(bytes);
      } catch (e) { return null; }
    }
    try { return atob(String(s).replace(/-/g, '+').replace(/_/g, '/')); } catch (e) { return null; }
  }

  /**
   * 盒子指纹：Gist 位置的 8 位短指纹。
   * 用途（防「盒子分裂」的第一道可见闸）：两台设备若连到不同 Gist，
   * 用户在面板上一眼就能看出指纹不同 —— 当年的故障正是「两台设备各自新建
   * 盒子、界面却显示成功、永不互通」。
   * 刻意用 FNV 的 hash 而不是 SHA-256：后者需要 crypto.subtle，file:// 下不可用，
   * 会让指纹在某些环境静默退化成空值。纯函数，verify 沙箱可复算。
   */
  function boxFingerprintOf(gistId) {
    var g = String(gistId === undefined || gistId === null ? '' : gistId).trim();
    if (!GIST_ID_RE.test(g)) return '';
    var fp = hash(g);
    return fp.slice(0, 4) + '-' + fp.slice(4);
  }

  /** 配对信息 → 安装链接载荷（同步纯函数，verify 沙箱可复算） */
  function encodeInstall(cfg) {
    var c = cfg || {};
    var token = String(c.token === undefined || c.token === null ? '' : c.token).trim();
    var gistId = String(c.gistId === undefined || c.gistId === null ? '' : c.gistId).trim();
    if (!token || token.length > 300) return null;
    if (!GIST_ID_RE.test(gistId)) return null;
    /* 载荷带 b（盒子指纹）：链接被改动过、或来自另一个盒子时，落地即拒 */
    /* ★ b64urlOf 失败时必须立刻拒绝，不能把 null 拼进字符串 ——
       那样会产出 'XJ1p.null' 这种【看起来合法、其实解不开】的垃圾链接，
       而调用方只检查「返回值非空」就会以为配对链接生成成功。 */
    var body = b64urlOf(JSON.stringify({ v: 1, t: token, g: gistId, b: boxFingerprintOf(gistId) }));
    if (!body) return null;
    var enc = INSTALL_PREFIX + body;
    if (enc.length > INSTALL_MAX) return null;
    return enc;
  }

  /** 安装链接载荷 → 配对信息。任何不合法都返回 null。 */
  function decodeInstall(str) {
    var s = String(str === undefined || str === null ? '' : str).trim();
    if (!s || s.length > INSTALL_MAX) return null;
    if (s.indexOf(INSTALL_PREFIX) !== 0) return null;
    var body = unb64urlOf(s.slice(INSTALL_PREFIX.length));
    if (!body) return null;
    var o = null;
    try { o = JSON.parse(body); } catch (e) { return null; }
    if (!o || typeof o !== 'object') return null;
    if (o.v !== 1) return null;                 // 格式版本不认识就明确拒绝
    /* 复用编码侧的校验，保证「能解出来的必能重新编回去」 */
    if (!encodeInstall({ token: o.t, gistId: o.g })) return null;
    /* 盒子指纹：缺省（老格式）补算后接受；带了却不一致 → 明确拒绝（防篡改/防错盒子） */
    var fp = boxFingerprintOf(o.g);
    if (o.b !== undefined && o.b !== null && String(o.b) !== fp) return null;
    return { token: String(o.t).trim(), gistId: String(o.g).trim(), boxFingerprint: fp };
  }

  /** 从 location.hash 取出安装载荷（没有则返回 null） */
  function readInstallHash(hash) {
    var h = String(hash === undefined || hash === null ? '' : hash);
    var i = h.indexOf(INSTALL_KEY);
    if (i < 0) return null;
    return decodeInstall(h.slice(i + INSTALL_KEY.length));
  }

  /** 清掉地址栏里的安装载荷，避免刷新时反复执行 */
  function clearInstallHash(hash) {
    var h = String(hash === undefined || hash === null ? '' : hash);
    var i = h.indexOf(INSTALL_KEY);
    return i < 0 ? h : h.slice(0, i);
  }

  /** 用站点基址拼出完整安装链接；base 里的 # 会被去掉（照 transfer 的规矩） */
  function buildInstallUrl(base, cfg) {
    var enc = encodeInstall(cfg);
    if (!enc) return null;
    return String(base || '').split('#')[0] + INSTALL_KEY + enc;
  }

  /* ---------------- 接入口令（带口令的加密载荷 XJ2e） ----------------
   *
   * 为什么要有这一层，而不是直接用明文 XJ1p：
   *   口令与二维码会出现在**屏幕、截图、聊天记录**里。明文的话，任何人拿到那张图
   *   都能 base64 解出令牌 —— 那等于把钥匙印在屏幕上。
   *   XJ2e 把载荷用一次性密钥加密，令牌不再以明文形式出现在图片里。
   *
   * ★ 诚实说明：口令里【也带着密钥】（否则新设备无法解开）。所以这层加密
   *   挡的是「被扫到/被看到明文令牌」，不是「拿到口令的人」——
   *   拿到口令本来就等于拿到写权限，这一点在界面上必须如实写明。
   *
   * 格式：XJ2e.<base64url(12字节 nonce)>.<base64url(密钥 16 字节)>.<base64url(密文||tag)>
   *   · AES-GCM 128 位；密钥随机生成，不依赖密码，避免引入 KDF 与用户密码
   *   · 密文里是 JSON {v:1, t:令牌, g:位置}，与 XJ1p 的载荷同构
   *   · 环境不支持 crypto.subtle（file:// 或老浏览器）→ 回落明文 XJ1p，
   *     并在界面上如实标注「当前环境口令未加密」，而不是假装加密了
   */
  var PAIR_PREFIX = 'XJ2e.';
  var PAIR_MAX = 1400;

  /** 环境是否支持 AES-GCM（file:// 下 crypto.subtle 通常不存在） */
  function hasSubtle() {
    try {
      return !!(typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.encrypt === 'function');
    } catch (e) { return false; }
  }

  /** 生成一个新的配对密钥（128 位，32 位十六进制） */
  function newPairKey() {
    var bytes = new Uint8Array(16);
    try {
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(bytes);
      } else {
        for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
      }
    } catch (e) {
      for (var j = 0; j < bytes.length; j++) bytes[j] = Math.floor(Math.random() * 256);
    }
    var out = '';
    for (var k = 0; k < bytes.length; k++) out += ('0' + bytes[k].toString(16)).slice(-2);
    return out;
  }

  /** 十六进制密钥 → 字节数组（非法返回 null） */
  function keyBytes(hex) {
    var s = String(hex || '');
    if (!/^[0-9a-f]{32}$/i.test(s)) return null;
    var out = new Uint8Array(16);
    for (var i = 0; i < 16; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }

  /** 任意字节 → base64url。
   *  ★ 这里【不能】借 transfer.utf8Bytes：那是「字符串 → UTF-8 字节」的编码器，
   *    而这些已经是原始字节了。套上去会把 ≥0x80 的字节再编一次成两字节，
   *    nonce 从 12 字节涨到 18 字节，解密时必然认证失败
   *    （表现为「口令解不开」，但编码那一侧看起来完全正常 —— 极难往回追）。
   *    正确做法是走 transfer 的 b64url（它本来就是收「字节数组」的）。 */
  function bytesToB64url(bytes) {
    var arr = [];
    for (var i = 0; i < bytes.length; i++) arr.push(bytes[i] & 0xff);
    var T = XJ.transfer || {};
    if (typeof T.b64url === 'function') return T.b64url(arr);
    var s = '';
    for (var j = 0; j < arr.length; j++) s += String.fromCharCode(arr[j]);
    try { return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); } catch (e) { return null; }
  }

  /** base64url → 字节数组（一律返回真正的 Uint8Array：WebCrypto 只收 ArrayBufferView） */
  function b64urlToBytes(s) {
    var T = XJ.transfer || {};
    var raw = null;
    if (typeof T.unb64url === 'function') {
      try { raw = T.unb64url(String(s)); } catch (e) { raw = null; }
    }
    if (!raw || !raw.length) {
      try {
        var bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
        raw = [];
        for (var i = 0; i < bin.length; i++) raw.push(bin.charCodeAt(i));
      } catch (e2) { return null; }
    }
    var out = new Uint8Array(raw.length);
    for (var k = 0; k < raw.length; k++) out[k] = raw[k] & 0xff;
    return out;
  }

  /** 把令牌与位置编成口令。环境不支持加密时回落明文（返回值里的 plain 标注了这件事）。 */
  function encodePairCode(cfg) {
    var c = cfg || {};
    var plain = encodeInstall({ token: c.token, gistId: c.gistId });
    if (!plain) return Promise.resolve(null);
    if (!hasSubtle()) return Promise.resolve({ code: plain, plain: true });

    var kb = keyBytes(c.key);
    if (!kb) return Promise.resolve({ code: plain, plain: true });

    var nonce = new Uint8Array(12);
    try {
      if (crypto.getRandomValues) crypto.getRandomValues(nonce);
      else for (var i = 0; i < 12; i++) nonce[i] = Math.floor(Math.random() * 256);
    } catch (e) { for (var j = 0; j < 12; j++) nonce[j] = Math.floor(Math.random() * 256); }

    var payload = (XJ.transfer && XJ.transfer.utf8Bytes)
      ? XJ.transfer.utf8Bytes(JSON.stringify({ v: 1, t: String(c.token || '').trim(), g: String(c.gistId || '').trim() }))
      : null;
    if (!payload) return Promise.resolve({ code: plain, plain: true });
    var data = new Uint8Array(payload);

    return crypto.subtle.importKey('raw', kb, { name: 'AES-GCM' }, false, ['encrypt'])
      .then(function (key) { return crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, data); })
      .then(function (buf) {
        var ct = new Uint8Array(buf);
        var code = PAIR_PREFIX + bytesToB64url(nonce) + '.' + bytesToB64url(kb) + '.' + bytesToB64url(ct);
        if (!code || code.length > PAIR_MAX) return { code: plain, plain: true };
        return { code: code, plain: false };
      })
      .catch(function () { return { code: plain, plain: true }; });
  }

  /**
   * 口令 → 配对信息。任何不合法一律 { ok:false }，绝不抛错。
   * @returns Promise<{ok:true, token, gistId, plain:boolean, key:string|null}
   *                  | {ok:false, reason:'format'|'crypto'|'no-crypto'|'bad-key'}>
   */
  function decodePairCode(code) {
    var s = String(code === undefined || code === null ? '' : code).trim();
    if (!s || s.length > PAIR_MAX) return Promise.resolve({ ok: false, reason: 'format' });

    /* 明文（旧安装链接 / 不支持加密的环境）：直接复用既有解码器 */
    if (s.indexOf(INSTALL_PREFIX) === 0) {
      var old = decodeInstall(s);
      return Promise.resolve(old
        ? { ok: true, token: old.token, gistId: old.gistId, plain: true, key: null }
        : { ok: false, reason: 'format' });
    }

    if (s.indexOf(PAIR_PREFIX) !== 0) return Promise.resolve({ ok: false, reason: 'format' });
    var parts = s.slice(PAIR_PREFIX.length).split('.');
    if (parts.length !== 3) return Promise.resolve({ ok: false, reason: 'format' });
    if (!hasSubtle()) return Promise.resolve({ ok: false, reason: 'no-crypto' });

    var nonce = b64urlToBytes(parts[0]);
    var kb = b64urlToBytes(parts[1]);
    var ct = b64urlToBytes(parts[2]);
    if (!nonce || nonce.length !== 12 || !kb || kb.length !== 16 || !ct || !ct.length) {
      return Promise.resolve({ ok: false, reason: 'format' });
    }

    return crypto.subtle.importKey('raw', kb, { name: 'AES-GCM' }, false, ['decrypt'])
      .then(function (key) { return crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct); })
      .then(function (buf) {
        var text = (XJ.transfer && XJ.transfer.bytesUtf8)
          ? XJ.transfer.bytesUtf8(Array.prototype.slice.call(new Uint8Array(buf)))
          : null;
        if (!text) return { ok: false, reason: 'crypto' };
        var o = null;
        try { o = JSON.parse(text); } catch (e) { return { ok: false, reason: 'crypto' }; }
        if (!o || o.v !== 1) return { ok: false, reason: 'crypto' };
        /* 复用编码侧的校验：能解出来的必能重新编回明文形式 */
        if (!encodeInstall({ token: o.t, gistId: o.g })) return { ok: false, reason: 'crypto' };
        var hex = '';
        for (var i = 0; i < kb.length; i++) hex += ('0' + kb[i].toString(16)).slice(-2);
        return { ok: true, token: String(o.t).trim(), gistId: String(o.g).trim(), plain: false, key: hex };
      })
      .catch(function () { return { ok: false, reason: 'bad-key' }; });
  }

  /** 从一段文本里找出口令（容忍前后文字、换行、全角、零宽、完整链接）。纯函数，无异步。 */
  function parsePairText(raw) {
    var s = String(raw === undefined || raw === null ? '' : raw);
    if (!s) return null;
    /* ① 去掉零宽与不可见字符：从聊天软件复制出来常带这些，肉眼完全看不出来 */
    s = s.replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, '');
    /* ② 全角 → 半角：输入法把口令变成全角是最常见的「看起来一模一样但不能用」 */
    s = s.replace(/[\uff01-\uff5e]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xfee0); })
      .replace(/\u3000/g, ' ');
    /* ③ 编成一个字符都不带空白的版本：口令本身不含空白，所以「去掉全部空白」是无损的。
       ★ 这一步必须放在切词【之前】—— 聊天软件常把长口令按行折断，
         先按空白切的话只会切到第一行，用户看到的是「口令格式不对」，
         而真正的原因是他复制的那段被换行拆开了。 */
    var flat = s.replace(/\s+/g, '');
    var at0 = flat.indexOf(INSTALL_PREFIX);
    var at1 = flat.indexOf(PAIR_PREFIX);
    var start = at0 >= 0 ? at0 : at1;
    if (start >= 0 && start + 8 <= flat.length) return cutCode(flat.slice(start));
    /* ④ 没找到前缀：也许整段就是口令（下面按行切词兜住带引号/标点的情形） */
    var t = s.trim();
    if (t.indexOf(INSTALL_PREFIX) === 0 || t.indexOf(PAIR_PREFIX) === 0) return cutCode(t);
    /* ⑤ 完整链接 / 带 #xjsync= 的片段：取键之后到空白或引号之前那一段 */
    var idx = s.indexOf(INSTALL_KEY);
    if (idx >= 0) {
      var rest = s.slice(idx + INSTALL_KEY.length);
      var m = rest.match(/[^\s"'<>）)】]+/);
      if (m) return cutCode(m[0]);
    }
    return null;
  }

  /** 把口令尾巴上粘着的标点切掉（微信里复制常带句号/逗号） */
  function cutCode(s) {
    var out = String(s || '').trim();
    /* 只允许 base64url 与分隔点：遇到别的字符就截断 */
    var m = out.match(/^[A-Za-z0-9._-]+/);
    if (!m) return null;
    out = m[0].replace(/[.]+$/, '');
    if (out.length < 8) return null;
    return out;
  }

  /** 从口令里取回配对密钥（明文口令返回 null） */
  function pairKeyOf(code) {
    var s = String(code || '');
    if (s.indexOf(PAIR_PREFIX) !== 0) return null;
    var parts = s.slice(PAIR_PREFIX.length).split('.');
    if (parts.length !== 3) return null;
    var kb = b64urlToBytes(parts[1]);
    if (!kb || kb.length !== 16) return null;
    var hex = '';
    for (var i = 0; i < kb.length; i++) hex += ('0' + kb[i].toString(16)).slice(-2);
    return hex;
  }

  /** 保证 state 上有一个配对密钥（没有就生成并写回）。返回密钥。 */
  function ensurePairKey(state) {
    var m = meta(state);
    if (!/^[0-9a-f]{32}$/i.test(String(m.pairKey || ''))) m.pairKey = newPairKey();
    return m.pairKey;
  }

  /* ---------------- 状态自述（给界面用） ---------------- */

  function status(state) {
    var m = state && state.syncMeta;
    if (!m) return { enabled: false, pending: 0, version: 0, lastOkAt: null };
    return {
      enabled: m.enabled === true,
      paired: !!(m.token && m.gistId),
      pending: (m.outbox || []).length,
      version: U.n0(m.version),
      lastOkAt: m.lastOkAt || null,
      failSince: m.failSince || null,
      lastErr: m.lastErr || null,
      deviceId: m.deviceId,
      everPaired: m.everPaired === true,
      tokenScopes: m.tokenScopes || null,
      legacyHealed: m.legacyHealed === true,
      installMode: m.installMode || null,
      tombstoneCount: Object.keys(m.tombstones || {}).length,
    };
  }

  return {
    OPS_CAP: OPS_CAP,
    TOMB_CAP: TOMB_CAP,
    SETTINGS_SYNC: SETTINGS_SYNC,
    TYPES: TYPES,
    DEFS: DEFS,
    META_DEFAULT: META_DEFAULT,
    meta: meta,
    vid: vid,
    hash: hash,
    stable: stable,
    pick: pick,
    idsOf: idsOf,
    contentHash: contentHash,
    newer: newer,
    makeStamp: makeStamp,
    stampOf: stampOf,
    stripSyncFields: stripSyncFields,
    diffToOps: diffToOps,
    seedVersions: seedVersions,
    tombstoneList: tombstoneList,
    applyOps: applyOps,
    buildSnapshot: buildSnapshot,
    buildRemote: buildRemote,
    adoptVersions: adoptVersions,
    mergeRemote: mergeRemote,
    firstSyncMode: firstSyncMode,
    INSTALL_KEY: INSTALL_KEY,
    INSTALL_PREFIX: INSTALL_PREFIX,
    boxFingerprintOf: boxFingerprintOf,
    encodeInstall: encodeInstall,
    decodeInstall: decodeInstall,
    readInstallHash: readInstallHash,
    clearInstallHash: clearInstallHash,
    buildInstallUrl: buildInstallUrl,
    /* 接入口令（加密载荷 XJ2e）与容错解析 */
    PAIR_PREFIX: PAIR_PREFIX,
    hasSubtle: hasSubtle,
    newPairKey: newPairKey,
    encodePairCode: encodePairCode,
    decodePairCode: decodePairCode,
    parsePairText: parsePairText,
    pairKeyOf: pairKeyOf,
    ensurePairKey: ensurePairKey,
    ensurePairKey: ensurePairKey,
    /* 切换云端位置 / 重来一次：把本机全部实体作为待推送项（保证并集） */
    enqueueAll: enqueueAll,
    gcTombstones: gcTombstones,
    status: status,
    nowMs: nowMs,
    toMs: toMs,
  };
})();
