/* ==================== 跨设备同步 · 编排层 ====================
 * 职责：把「纯逻辑内核」（sync-core：增量 / 冲突 / 墓碑）与「传输层」
 * （sync-transport：whoami / pull / push）编排成一轮轮同步，并维护 UI 状态。
 * ★ 本文件【不认识】Gist —— 全部网络动作走 XJ.syncTransport.get()。
 *
 * 三条铁律（都是踩过坑换来的，别改）：
 *   ① 唯一的闸门是 syncMeta.enabled（外加「令牌与位置都齐」）。不额外加
 *      「本会话是否已 start」这类运行闩 —— 那会让「关掉再打开后立刻点立即同步」
 *      被静默拒绝（enabled 才是权威）。
 *   ② 推不推只看「有没有待推送的增量」，与「pull 有没有变化」无关。否则
 *      「另一端先写、本机随后改」这一轮只拉不推，改动要等下一轮才出去。
 *   ③ 只有确认推送成功才清 outbox，否则崩溃会丢增量。
 *
 * 关闭同步 = 零外发：stop() 清定时器并摘掉落盘钩子；任何请求都先过 enabled 判断。
 */
XJ.sync = (function () {
  var U = XJ.util;
  var CORE = XJ.syncCore;
  var TR = XJ.syncTransport;

  var POLL_MS = 60000;            // 前台轮询间隔（与行情刷新同节奏）
  var PUSH_DELAY_MS = 2000;        // 本地改动后的推送防抖
  var FIRST_PULL_TIMEOUT = 4000;   // 首屏等一次对齐的上限
  var VISIBLE_STALE_MS = 3000;     // 回前台时超过这么久没同步就立刻补一次
  var RETRY_MAX = 3;               // 412 撞车的重试次数
  var LOG_MAX = 40;                // 详细日志的内存行数（不落盘）

  var timer = null, pushTimer = null, blockedUntil = 0;
  var running = false;
  var applyingRemote = false;      // 应用远端期间抑制 op 发射
  var lastAttemptAt = 0;
  var listeners = [];
  var logLines = [];

  function state() { return (XJ.store && XJ.store.state) || null; }
  function meta() { return CORE.meta(state() || {}); }

  /* ---------------- 日志（面板「详细日志」折叠区；只在内存里） ---------------- */
  function log(kind, text) {
    logLines.push({ ts: U.nowStamp(), kind: kind, text: String(text || '') });
    if (logLines.length > LOG_MAX) logLines.splice(0, logLines.length - LOG_MAX);
  }
  function logAll() { return logLines.slice(); }

  /* ---------------- 状态自述（面板状态行） ---------------- */
  function isOn() {
    var m = meta();
    return !!(m && m.enabled && m.token && m.gistId);
  }
  function status() {
    var m = meta();
    return {
      enabled: !!m.enabled,
      paired: !!m.everPaired,
      hasToken: !!m.token,
      gistId: m.gistId,
      boxFingerprint: m.gistId ? CORE.boxFingerprintOf(m.gistId) : '',
      version: U.n0(m.version),
      pending: (m.outbox || []).length,
      ledger: Object.keys(m.versions || {}).length,
      tombstones: Object.keys(m.tombstones || {}).length,
      lastOkAt: m.lastOkAt,
      lastErr: m.lastErr || null,
      failSince: m.failSince || null,
      deviceId: m.deviceId,
      storageMode: XJ.storage && XJ.storage.getMode ? XJ.storage.getMode() : '?',
      rateResetAt: blockedUntil || null,
    };
  }
  function onChange(fn) { listeners.push(fn); }
  function notify() { for (var i = 0; i < listeners.length; i++) { try { listeners[i](); } catch (e) { console.error('[sync] listener', e); } } }

  /* ---------------- 失败记账（禁止静默失败） ---------------- */
  function noteError(m, kind, msg) {
    m.lastErr = { kind: kind, msg: String(msg || ''), at: U.nowStamp() };
    if (!m.failSince) m.failSince = U.nowStamp();
    log('err', kind + ' · ' + msg);
    notify();
  }
  function noteOk(m) {
    m.lastOkAt = U.nowStamp();
    m.lastErr = null;
    m.failSince = null;
  }
  function noteScopes(m, scopes) {
    if (typeof scopes === 'string' && scopes) m.tokenScopes = scopes;
  }
  function mkStop(reason, msg) {
    var e = new Error(msg || reason);
    e.__stop = true;
    e.reason = reason;
    e.msg = msg || reason;      // ★ 带上完整文案：catch 里要用它，别用 reason 覆盖掉细节
    return e;
  }

  /** 网络层失败分诊：fetch 抛的 TypeError 本身【分不清】断网与预检被拦，
   *  只能靠启发式。文案必须如实说「两种可能」而不是替用户下结论。 */
  function classifyNetError(e) {
    if (e && e.__stop) return { kind: e.reason || 'net', msg: e.msg || e.reason };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return { kind: 'offline', msg: '设备当前离线，恢复网络后会自动继续同步' };
    }
    var isHttpPage = location.protocol === 'http:';
    var apiHttps = TR.apiBase().slice(0, 8) === 'https:';
    if (isHttpPage && apiHttps) {
      /* 这一条是确定的：https 页面在 http 页面里发 https 请求，浏览器必然拦 */
      return { kind: 'cors', msg: '页面是 http 而云端是 https，混合内容被浏览器拦住了。请改用 https 网址打开' };
    }
    return { kind: 'net', msg: '没能连上云端：设备没网，或网络中间设备（公司/学校网关、代理）拦下了请求。恢复后会自动重试' };
  }

  /* ---------------- 落盘钩子：算出本轮增量 ---------------- */
  function beforeSave(st) {
    if (applyingRemote) return;                    // 应用远端期间不发射（防回声）
    try {
      var m = CORE.meta(st);
      if (!m.enabled) return;                      // 没开同步就什么都不算
      CORE.diffToOps(st);                          // 默认模式：增量进 outbox（与 state 同一次落盘）
      schedulePush();
    } catch (e) { console.error('[sync] beforeSave', e); }
  }
  function attach() {
    if (XJ.storage && XJ.storage.setOnBeforeSave) XJ.storage.setOnBeforeSave(beforeSave);
  }
  function detach() {
    if (XJ.storage && XJ.storage.setOnBeforeSave) XJ.storage.setOnBeforeSave(null);
  }

  function schedulePush() {
    if (!isOn()) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { pushTimer = null; tick({ silent: true }); }, PUSH_DELAY_MS);
  }
  /** 离开页面时尽力把改动推出去（不保证完成，只做尝试）。返回 Promise 供调用方 await。 */
  function flushNow() {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    if (!isOn()) return Promise.resolve({ ok: false, reason: 'off' });
    return tick({ silent: true });
  }

  /* ---------------- 串行队列：来晚的排队，不丢 ----------------
     ★ 曾经 running 为真就直接返回 {ok:false, reason:'busy'}，
       结果一条都不推而界面显示成功。现在一律排队。 */
  var queue = Promise.resolve();
  function enqueue(fn) {
    var run = queue.then(fn, fn);
    queue = run.then(function () {}, function () {});
    return run;
  }

  function tick(opts) { return enqueue(function () { return doTick(opts); }); }

  function doTick(opts) {
    opts = opts || {};
    var s = state();
    if (!s) return Promise.resolve({ ok: false, reason: 'no-state' });
    var m = CORE.meta(s);
    if (!m.enabled || !m.token || !m.gistId) return Promise.resolve({ ok: false, reason: 'off' });
    /* 限流退避：只挡【自动轮询】。用户手动点「立即同步」照发（opts.force）——
       GitHub 的限额按小时计，挡住手动重试没有意义，只会让用户以为坏了。 */
    if (!opts.force && Date.now() < blockedUntil) {
      return Promise.resolve({ ok: false, reason: 'rate', until: blockedUntil });
    }

    running = true;
    lastAttemptAt = Date.now();
    var tr = TR.get();
    var cfg = { token: m.token, gistId: m.gistId, etag: m.etag };
    if (!applyingRemote) { try { CORE.diffToOps(s, { noQueue: true }); } catch (e) { /* 忽略 */ } }

    var result = { ok: false, pulled: 0, applied: 0, pushed: 0, deletions: 0 };

    return Promise.resolve()
      .then(function () { return tr.pull(cfg); })
      .then(function (res) {
        if (res.scopes !== undefined && res.scopes !== null) noteScopes(m, res.scopes);
        if (res.rate && res.rate.limited && res.rate.waitMs > 0) {
          blockedUntil = Date.now() + res.rate.waitMs;
        }
        if (res.status === 304) return { unchanged: true, etag: res.etag };
        if (res.status === 401) { noteError(m, 'auth', '令牌已失效或被删除。请在「我的 → 同步」点「重新配对」'); throw mkStop('auth'); }
        if (res.status === 403) {
          if (res.rate && res.rate.limited) {
            var at = res.rate.resetAt ? new Date(res.rate.resetAt).toLocaleTimeString() : '稍后';
            throw mkStop('rate', '触发 GitHub 限流，将于 ' + at + ' 后自动恢复');
          }
          noteError(m, 'forbidden', '令牌权限不足，读不到这个云端位置（需要 gist 权限）。请重新配对');
          throw mkStop('forbidden');
        }
        if (res.status === 404) { noteError(m, 'missing', '云端位置不存在或已被删除。本机数据完好无损，请点「重新配对」恢复'); throw mkStop('missing'); }
        if (res.status === 429) {
          var at2 = res.rate && res.rate.resetAt ? new Date(res.rate.resetAt).toLocaleTimeString() : '稍后';
          throw mkStop('rate', '触发 GitHub 限流，将于 ' + at2 + ' 后自动恢复');
        }
        if (res.status !== 200) { noteError(m, 'http', '读取失败（HTTP ' + res.status + '）' + ghMsg(res)); throw mkStop('http'); }
        if (res.public === true) { noteError(m, 'public', '这个云端位置是公开的。公开的会被 GitHub 吊销令牌，且你的数据对所有人可见 —— 请「重置连接」后重新配对'); throw mkStop('public'); }
        if (res.corrupt) { noteError(m, 'corrupt', '云端数据格式无法解析，已跳过本轮（不会覆盖本机数据）'); throw mkStop('corrupt'); }
        if (res.missing || !res.data) { m.forcePull = false; return { needSeed: true, etag: res.etag, empty: true }; }
        var remote = res.data;
        /* forcePull：「刚换到新位置」的一次性放行 —— 新位置 version 与本地刚被
           重置的 0 会恰好相同，不放行就会把整次拉取短路掉（接回来却什么都没同步）。 */
        if (!m.forcePull && U.n0(remote.version) === U.n0(m.version)) return { unchanged: true, etag: res.etag };
        return { remote: remote, etag: res.etag };
      })
      .then(function (stepRes) {
        if (!stepRes) return null;
        if (stepRes.remote) {
          var mode = m.everPaired ? 'merge' : firstMode(s);
          applyingRemote = true;
          try {
            var r = CORE.mergeRemote(s, stepRes.remote, mode);
            result.mode = mode;
            result.applied = r.applied;
            result.deletions = r.deleted;
          } finally { applyingRemote = false; }
          m.etag = stepRes.etag || m.etag;
          m.forcePull = false;
        } else if (stepRes.etag) {
          m.etag = stepRes.etag;
          if (m.forcePull) m.forcePull = false;
        }
        /* ★ 推不推只看有没有待推的增量 */
        var needPush = (m.outbox || []).length > 0 || stepRes.needSeed;
        if (!needPush) { result.ok = true; result.unchanged = !!stepRes.unchanged; noteOk(m); log('ok', stepRes.empty ? '云端是空的，已记录待初始化' : '无变化'); return null; }

        /* etag 缺失时的降级：读-改-写（先确保 version 一致再写），宁可可能覆盖一次，
           也不能因为「拿不到乐观锁」就彻底不同步。 */
        if (!m.etag) {
          return tr.pull({ token: m.token, gistId: m.gistId, force: true }).then(function (r2) {
            if (r2.status === 200 && r2.data && U.n0(r2.data.version) !== U.n0(m.version)) {
              applyingRemote = true;
              try { CORE.mergeRemote(s, r2.data, m.everPaired ? 'merge' : firstMode(s)); } finally { applyingRemote = false; }
            }
            if (r2.etag) m.etag = r2.etag;
            log('warn', '云端未返回 ETag，本轮为读-改-写模式');
            return doPush(s, m, tr, result);
          });
        }
        return doPush(s, m, tr, result);
      })
      .then(function () {
        result.ok = true;
        noteOk(m);
        notify();
        return result;
      })
      .catch(function (e) {
        var info = classifyNetError(e);
        /* 文案大多在抛出前已记账（带具体时间/原因），这里只补「还没记过」的，
           绝不用 reason 覆盖掉更详细的那条 —— 那正是「界面只显示『限流』两个字」的由来。 */
        var cur = m.lastErr;
        if (!cur || cur.kind !== info.kind) {
          noteError(m, info.kind || 'net', info.msg || '同步失败');
        } else {
          log('err', info.kind + ' · ' + (info.msg || ''));
          notify();
        }
        result.ok = false;
        result.reason = info.kind;
        return result;                            // 绝不 reject
      })
      .then(function (r) { running = false; return r; });
  }

  /**
   * 推送，并在成功后【回读校验】：确认云端 version 就是我们刚写的那个。
   * 目的：GitHub Gist 不支持 If-Match（实测任何 ETag 都 400），所以没法在服务端原子拒绝
   * 并发写；改成「写完确认」—— 若云端 version 比我们写的更大，说明期间有另一台设备写过，
   * 这时拉回合并再重试，把「静默覆盖」变成「自动修复」。
   */
  function verifyPushed(s, m, tr, attempt, myVersion) {
    return tr.pull({ token: m.token, gistId: m.gistId, force: true }).then(function (r) {
      if (r.status !== 200 || !r.data) return { ok: true, skip: true };   // 回读失败不阻塞主流程
      var cloudVer = U.n0(r.data.version);
      /* 判定标准是「云端现在是不是我写的那一版」，而不是「云端版本是否更大」——
         后者会误判：早先的实现把本机记录的版本原样写回云端，版本号并不单调，
         于是「云端更大」经常成立 → 误以为有并发 → 反复合并重推，
         最终把云端版本写回旧值、另一台设备按旧快照覆盖（实测踩过：B 的数据被清空）。 */
      if (cloudVer === U.n0(myVersion)) return { ok: true, cloudVer: cloudVer };
      /* 云端比本机新 → 有人并发写：合并后重试 */
      if (attempt >= RETRY_MAX) return { ok: false, reason: 'conflict' };
      log('warn', '写入后校验发现云端已被其他设备推进（第 ' + (attempt + 1) + ' 次重新对齐）');
      applyingRemote = true;
      try { CORE.mergeRemote(s, r.data, 'merge'); } finally { applyingRemote = false; }
      m.version = U.n0(r.data.version);
      if (r.etag) m.etag = r.etag;
      return doPush(s, m, tr, {}, attempt + 1);
    }).catch(function () { return { ok: true, skip: true }; });
  }

  function doPush(s, m, tr, result, attempt) {
    /* ★ snapshot 每次都带全量：云端那份是「全量 + 增量尾巴」，新设备只靠它就够。
       早先为了省流量在增量推送时写 snapshot:null，把全量段抹掉了 ——
       新设备再也无法一次拉完。几十 KB 量级下，正确性远比省流量重要。 */
    /* ★ 版本号单调递增：云端里存的是「本机上一次看到的版本 + 1」。
       写回本机记录的旧值会让版本号倒退，进而让别端的「版本相同就跳过合并」判断失效。 */
    var myVersion = U.n0(m.version) + 1;
    var next = CORE.buildRemote(s, { version: myVersion });
    var outboxLen = (m.outbox || []).length;
    return pushWithRetry(s, m, next, tr, 0).then(function (pr) {
      if (!pr.ok) throw mkStop(pr.reason || 'push');
      m.outbox = m.outbox.slice(outboxLen);       // ★ 只有确认成功才清
      m.version = myVersion;
      if (pr.etag) m.etag = pr.etag;
      result.pushed = outboxLen;
      log('push', '已推送 ' + outboxLen + ' 条变更（云端第 ' + myVersion + ' 版）');
      return verifyPushed(s, m, tr, attempt || 0, myVersion);
    }).then(function (v) {
      if (v && v.ok === false) {
        throw mkStop('conflict', '写入冲突，重试多次仍未成功（云端可能被另一台设备频繁修改）');
      }
    });
  }

  /** 412 撞车（别人先写了）→ 拉回合并再重试。
   *  ★ 重试时必须【无条件重取】：只用条件请求很可能拿到 304，本地就拿不到新的
   *     version 号，重试会继续撞车直到耗尽次数。 */
  function pushWithRetry(s, m, next, tr, attempt) {
    var tr2 = tr;
    return tr2.push({ token: m.token, gistId: m.gistId, etag: m.etag, data: next }).then(function (r) {
      if (r.scopes) noteScopes(m, r.scopes);
      if (r.rate && r.rate.limited && r.rate.waitMs > 0) blockedUntil = Date.now() + r.rate.waitMs;
      if (r.status === 200 || r.status === 201) return { ok: true, etag: r.etag };
      if (r.status === 401) { noteError(m, 'auth', '令牌已失效或被删除，请重新配对'); return { ok: false, reason: 'auth' }; }
      if (r.status === 412) {
        if (attempt >= RETRY_MAX) { noteError(m, 'conflict', '写入冲突，重试多次仍未成功（云端可能被另一台设备频繁修改）'); return { ok: false, reason: 'conflict' }; }
        log('warn', '写入撞车（第 ' + (attempt + 1) + ' 次），拉回合并后重试');
        return tr2.pull({ token: m.token, gistId: m.gistId, force: true }).then(function (pr) {
          if (pr.status !== 200 || !pr.data) return { ok: false, reason: 'pull' };
          applyingRemote = true;
          try { CORE.mergeRemote(s, pr.data, 'merge'); } finally { applyingRemote = false; }
          if (pr.etag) m.etag = pr.etag;
          var retryDelay = attempt >= 1 ? (attempt === 1 ? 1000 : 2000) : 0;
          var go = function () { return pushWithRetry(s, m, CORE.buildRemote(s, { version: U.n0(m.version) }), tr2, attempt + 1); };
          return retryDelay ? new Promise(function (r) { setTimeout(r, retryDelay); }).then(go) : go();
        });
      }
      if (r.status === 403 || r.status === 429) {
        var at = r.rate && r.rate.resetAt ? new Date(r.rate.resetAt).toLocaleTimeString() : '';
        noteError(m, 'rate', at ? '触发 GitHub 限流，将于 ' + at + ' 后自动恢复' : 'GitHub 拒绝了这次写入（限流或权限不足）');
        return { ok: false, reason: 'rate' };
      }
      if (r.status === 404) { noteError(m, 'missing', '云端位置不存在或已被删除。本机数据完好无损，请重新配对'); return { ok: false, reason: 'missing' }; }
      noteError(m, 'http', '写入失败（HTTP ' + r.status + '）' + ghMsg(r));
      return { ok: false, reason: 'http' };
    }).catch(function (e) {
      var info = classifyNetError(e);
      noteError(m, info.kind, info.msg);
      return { ok: false, reason: info.kind };
    });
  }

  function ghMsg(res) {
    var d = res && res.data;
    if (!d) return '';
    var msg = d.message || '';
    if (Array.isArray(d.errors) && d.errors.length) {
      msg += (msg ? ' · ' : '') + d.errors.map(function (x) { return x.message || x.code || ''; }).filter(Boolean).join('；');
    }
    return msg ? '（GitHub：' + msg + '）' : '';
  }

  function firstMode(s) {
    var m = CORE.meta(s);
    if (m.installMode === 'merge' || m.installMode === 'overwrite') return m.installMode;
    return CORE.firstSyncMode(s);       // ask 的判定在 core 里，UI 负责弹窗
  }

  /* ---------------- 配对：落地前 preflight + 落地后 verify（不看 HTTP 201） ---------------- */

  /** 落地前校验：令牌有效 + 有 gist 权 + 盒子存在且私有可解析 + 指纹一致 */
  function preflightPair(payload) {
    var tr = TR.get();
    return tr.whoami({ token: payload.token }).then(function (who) {
      if (who.status !== 200) return { ok: false, reason: 'auth', msg: '令牌无效或已失效' };
      var scopes = who.scopes;
      if (scopes !== null && scopes !== undefined && scopes !== '' &&
          String(scopes).split(',').indexOf('gist') < 0) {
        return { ok: false, reason: 'nogist', msg: '这个令牌没有 gist 权限，读写云端会被拒绝' };
      }
      return tr.pull({ token: payload.token, gistId: payload.gistId, force: true }).then(function (r) {
        if (r.status === 404) return { ok: false, reason: 'missing', msg: '云端位置不存在或已被删除' };
        if (r.status === 401) return { ok: false, reason: 'auth', msg: '令牌无效或已失效' };
        if (r.status !== 200) return { ok: false, reason: 'http', msg: '读取云端失败（HTTP ' + r.status + '）' };
        if (r.public === true) return { ok: false, reason: 'public', msg: '这个云端位置是公开的（公开的会被 GitHub 吊销令牌）' };
        var remote = r.data;
        if (remote) return { ok: true, remote: remote, etag: r.etag, empty: !!r.missing };
        return { ok: true, etag: r.etag, empty: true };
      });
    }).catch(function (e) {
      var info = classifyNetError(e);
      return { ok: false, reason: info.kind, msg: info.msg };
    });
  }

  /**
   * 落地：把令牌与位置写进本机 syncMeta（令牌只存本机，绝不进 Gist / 导出文件）。
   *
   * ★ 首次接入的对齐方式在这里判定，判错的后果很具体（两条都是实测踩出来的）：
   *   · 本机【实质空白】（新买的手机：只有应用自带的默认支出项，没有交易与到账）
   *     → overwrite：直接采用云端那一份。否则那 6 个默认支出项会被 diff 当成
   *       「用户新增的记录」推上云端，把另一台设备的真实数据顶掉。
   *   · 本机【已有真实数据】→ merge：让 diff 把本机数据全量推上去。
   *     ★ 这里【不能】先调 seedVersions：它会把本地数据登记成「已见过」，
   *       diff 于是产出 0 条 op —— 而首次接入时云端往往还是空的，数据就永远
   *       推不上去（症状：A 首轮同步显示成功，云端仍是空的，另一台拉不到任何东西）。
   *       「别把已在云端的数据再推一遍」这件事由后续每轮的 versions 账本负责。
   */
  function applyPair(payload, opts) {
    var s = state();
    if (!s) return { ok: false, reason: 'no-state' };
    var m = CORE.meta(s);
    /* 指纹先验：链接被改动过 / 来自另一个盒子时立即拒绝，不写任何东西 */
    if (payload.boxFingerprint && payload.boxFingerprint !== CORE.boxFingerprintOf(payload.gistId)) {
      return { ok: false, reason: 'boxmismatch', msg: '链接里的位置指纹与云端不匹配，可能是链接被改动过' };
    }
    m.token = payload.token;
    m.gistId = payload.gistId;
    m.enabled = true;
    m.forcePull = true;                 // 一次性放行：否则 version 相同会短路整次拉取
    if (opts && opts.resetMemory) {
      m.version = 0; m.etag = null; m.outbox = []; m.versions = {};
    }
    if (opts && opts.installMode) m.installMode = opts.installMode;
    else m.installMode = isBlankDevice(s) ? 'overwrite' : 'merge';
    if (m.installMode === 'merge') {
      /* ★ 首次接入且本机有真实数据 → 把本机数据全量入队。
         背景：云端盒子是【外部预建】的（设备端没有建盒入口，那是防「盒子分裂」的根本办法），
         所以首次接入时云端往往是空的；而落盘钩子在此之前从未跑过，outbox 是空的
         —— 于是 needPush 恒为 false，数据永远推不上去（症状：首轮同步显示成功、
         云端仍是空的、另一台设备拉不到任何东西）。
         enqueueAll 正是为这个场景准备的：把云端没有的全部入队。
         「别把已在云端的数据重复推一遍」由后续每轮的 versions 账本负责。 */
      try { CORE.enqueueAll(s); } catch (e) { console.error('[sync] enqueueAll', e); }
    }
    log('pair', '已写入连接信息（位置 ' + CORE.boxFingerprintOf(m.gistId) + ' · 首次对齐：' +
      (m.installMode === 'overwrite' ? '以云端为准' : '把本机数据推上云端') + '）');
    return { ok: true, mode: m.installMode };
  }

  /** 本机是否「实质空白」：没有交易、没有到账、支出项就是应用自带的默认模板 */
  function isBlankDevice(s) {
    if (!s) return true;
    if ((s.transactions || []).length) return false;
    if ((s.received || []).length) return false;
    var tpl = (XJ.model && XJ.model.EXPENSE_TEMPLATE) || [];
    var exp = s.expenses || [];
    if (!tpl.length || exp.length !== tpl.length) return false;
    /* 逐项比 key + 金额：用户改过任何一项就算「有自己的数据」 */
    for (var i = 0; i < tpl.length; i++) {
      var hit = null;
      for (var j = 0; j < exp.length; j++) {
        if (exp[j].key === tpl[i].key) { hit = exp[j]; break; }
      }
      if (!hit || U.n0(hit.monthlyAmount) !== U.n0(tpl[i].monthlyAmount)) return false;
    }
    return true;
  }

  /**
   * 配对成功判定（六项全过）——★ 绝不以「HTTP 201」当成功：
   *   当年的头号故障就是「两台设备各自新建盒子、界面却显示成功、永不互通」。
   */
  function verifyPair() {
    var s = state();
    var m = meta();
    return tick({ silent: true }).then(function (r) {
      var problems = [];
      if (!r || !r.ok) problems.push('第一轮同步未成功（' + ((r && r.reason) || '未知') + '）');
      if (m.lastOkAt === null || m.lastOkAt === undefined) problems.push('没有成功记录');
      if (U.n0(m.version) <= 0) problems.push('云端版本号没有推进（云端可能是空的）');
      if (Object.keys(m.versions || {}).length === 0) problems.push('修订账本为空，没有登记任何记录');
      if (!m.everPaired) problems.push('配对状态没有落定');
      if (problems.length) {
        return { ok: false, reasons: problems };
      }
      return { ok: true, version: U.n0(m.version), ledger: Object.keys(m.versions).length };
    });
  }

  /* ---------------- 开关与轮询 ---------------- */
  function start() {
    detach();
    if (timer) clearInterval(timer);
    if (!isOn()) return false;
    timer = setInterval(function () {
      if (typeof document !== 'undefined' && document.hidden) return;   // 后台不轮询
      tick({ silent: true });
    }, POLL_MS);
    return true;
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    detach();                        // 摘掉落盘钩子 → 关闭后零外发
  }
  function setEnabled(on) {
    var s = state();
    if (!s) return;
    var m = CORE.meta(s);
    m.enabled = !!on;
    if (on) { attach(); start(); tick({ silent: true }); }
    else { stop(); }
    notify();
  }
  /** 回前台：超过 VISIBLE_STALE_MS 没同步就立刻补一次 */
  function onVisible() {
    if (!isOn()) return;
    if (Date.now() - lastAttemptAt < VISIBLE_STALE_MS) return;
    tick({ silent: true });
  }
  function isFirstPaintSynced() {
    if (!isOn()) return Promise.resolve(null);
    return Promise.race([
      tick({ silent: true }),
      new Promise(function (r) { setTimeout(function () { r(null); }, FIRST_PULL_TIMEOUT); }),
    ]).catch(function () { return null; });
  }

  return {
    POLL_MS: POLL_MS,
    isOn: isOn, status: status, onChange: onChange, notify: notify,
    attach: attach, detach: detach, start: start, stop: stop, schedulePush: schedulePush,
    setEnabled: setEnabled, onVisible: onVisible, flushNow: flushNow,
    tick: tick, isFirstPaintSynced: isFirstPaintSynced,
    preflightPair: preflightPair, applyPair: applyPair, verifyPair: verifyPair,
    isBlankDevice: isBlankDevice,   // 导出供联调脚本直接断言
    logAll: logAll,
    setTransport: function (t) {
      /* 换传输实现 = 换环境：此前的限流退避时刻不再有意义（也便于测试复位） */
      blockedUntil = 0;
      return TR.setTransport(t);
    },
    apiBase: function () { return TR.apiBase(); },
    setApiBase: function (b) { TR.setApiBase(b); },
  };
})();
