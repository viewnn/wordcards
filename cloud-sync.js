/**
 * ============================================================
 * WordCards 云同步模块 —— cloud-sync.js
 * ============================================================
 * 目标：让手机和电脑共用同一份学习记录，同时保留「断网可用」。
 *
 * 【整体架构：local-first（本地优先）】
 *   IndexedDB 依然是唯一的数据真相源，Supabase 只是同步后端：
 *     本地写入 → 立刻生效、立刻渲染（和以前一样快）
 *              → 打上脏标记 → 防抖后批量上行
 *     联网/切到前台 → 增量下行 → 合并 → 刷新界面
 *   因此没登录、没配置、断网时，应用的行为与改造前完全一致。
 *
 * 【同步什么】
 *   1. 学习记录（word_progress）：每个词条的 status / favorite /
 *      lastStudied / reviewCount —— 这是跨设备同步的核心。
 *   2. 用户设置（user_state.settings）：每日目标、学习模式、重复频率、
 *      词典范围、音标渐显、各类开关等。
 *   3. 今日学习会话（user_state.session）：今日队列 + 当前卡片下标，
 *      换设备后能接着上次的地方背。
 *   4. 重置信号（user_state.progress_reset_at）：任一台设备点了
 *      「清除记录」，其它设备同步时跟着清零。
 *   词库本身（dict.xlsx）不上云：它是静态数据，每台设备本地导入即可。
 *
 * 【为什么用 dict_key 而不是词条 id】
 *   词条 id 是 IndexedDB 的自增主键，同一份 dict.xlsx 在不同设备上
 *   导入顺序不同、id 就可能不同。所以用「分类 + 文本 + 音标」拼出一个
 *   稳定标识 dict_key 来做跨设备对齐；音标被纠正过导致对不上时，
 *   还会退化成「分类 + 文本」的唯一匹配再试一次。
 *
 * 【冲突解决：客户端时间戳 LWW】
 *   每条记录带一个 client_updated_at（客户端毫秒时间戳，越大越新）：
 *     - 上行：on conflict do update ... where excluded > 已有的（服务端 RPC）
 *     - 下行：云端比本地新才覆盖本地
 *   个人多设备场景下，这个策略足够；同一张卡两边同时点不同状态时，
 *   时间靠后的那次操作赢。
 *
 * 【同步时机】
 *   登录后首次登录全量合并 → 学习动作后 2.5 秒防抖上行 →
 *   页面切回前台（距上次超过 60 秒）增量下行 → 网络恢复时补同步 →
 *   设置页「同步」按钮手动触发。
 * ============================================================
 */
(function (global) {
  'use strict';

  // ==================== 配置 ====================
  var CONFIG = global.SUPABASE_CONFIG || {};
  var CONFIGURED = Boolean(CONFIG.url && CONFIG.anonKey);

  // ==================== 可调参数 ====================
  /** 学习动作后延迟多久上行（毫秒）：合并连续操作，避免一卡一请求 */
  var AUTO_PUSH_DEBOUNCE_MS = 2500;
  /** 页面切回前台时，距上次拉取超过多久才真正拉取（毫秒） */
  var FOCUS_PULL_MIN_INTERVAL_MS = 30 * 1000;
  /**
   * 应用停留前台时，多久自动检查一次云端更新（毫秒）。
   * 用来覆盖「另一台设备一直开着不动」的场景——只靠切前台触发的话，
   * 电脑开着不切换标签页就永远看不到手机上的新进度。
   * 用的是增量拉取，没有变化时服务端只返回空数组，开销很小。
   */
  var AUTO_PULL_INTERVAL_MS = 60 * 1000;
  /** 单次 RPC 上行最多多少条记录 */
  var PUSH_BATCH_SIZE = 300;
  /** 下行分页大小 */
  var PULL_PAGE_SIZE = 1000;
  /** 下行最多翻多少页（防御性上限） */
  var MAX_PULL_PAGES = 60;
  /** dict_key 各段之间的分隔符 */
  var SEP = '|';
  /** 本地记录同步元数据的设置项名（只存在本机，不上云） */
  var META_SETTING_KEY = 'cloudSyncMeta';
  /** 登录/注册等认证请求的超时（毫秒）：弱网或网络不通时避免按钮一直卡在「处理中」 */
  var AUTH_TIMEOUT_MS = 20000;
  /** 普通数据同步请求的超时（毫秒） */
  var REQUEST_TIMEOUT_MS = 30000;

  /**
   * 参与云同步的用户设置项。
   * 只放「跨设备希望一致」的偏好；像词库更新时间、统计快照这类
   * 可以从词条状态推导出来的数据不需要同步。
   */
  var SYNCED_SETTING_KEYS = [
    'dailyGoal',
    'learnMode',
    'repeatFrequency',
    'dictImportType',
    'phoneticDelay',
    'cardDefinitionFirst',
    'categoryDisplay',
    'meaningDisplay',
    'soundEnabled',
    'speechEnabled',
    'phoneticAutoRead'
  ];

  /** Supabase 英文错误 → 中文提示 */
  var AUTH_ERROR_MESSAGES = {
    'Invalid login credentials': '邮箱或密码不正确',
    'Email not confirmed': '邮箱还没验证：请先到邮箱点确认链接（也可在 Supabase 控制台关闭 Confirm email）',
    'Password should be at least 6 characters': '密码至少需要 6 位',
    'Email rate limit exceeded': '邮件发送太频繁，请稍后再试',
    'For security purposes, you can only request this after 60 seconds': '操作太频繁，请 60 秒后再试',
    'Unable to validate email address: invalid format': '邮箱格式不正确',
    'New password should be different from the old password': '新密码不能和旧密码相同'
  };

  // ==================== 工具函数 ====================

  /**
   * 规范化 Supabase 项目地址。
   * 从 Supabase 控制台的 API 页面复制地址时，很容易把表格里显示的
   * `https://xxx.supabase.co/rest/v1` 整段抄过来，但 createClient() 要的是
   * 项目根地址（SDK 自己会拼 /auth/v1、/rest/v1）。这里自动去掉多余的路径，
   * 否则注册/登录会打到 /rest/v1/auth/v1/... 上，返回 404 PGRST125 且现象是
   * 「点了按钮没反应」——非常难排查。
   */
  function normalizeSupabaseUrl(raw) {
    var original = String(raw == null ? '' : raw).trim();
    var url = original.replace(/\/+$/, '');
    var stripped = url.replace(/\/(rest|auth|storage|realtime|functions)\/v1$/i, '');
    return {
      url: stripped,
      original: original,
      corrected: stripped !== url,
      looksLikeSupabase: /\.supabase\.(co|in)$/i.test(stripped) || /^https?:\/\//i.test(stripped)
    };
  }

  /**
   * 给 Promise 加超时。
   * 网络不通时 fetch 可能挂起很久，界面就会一直停在「注册中…」，
   * 用户看到的就是「点了没反应」。加超时才能给出明确的失败原因。
   */
  function withTimeout(promise, ms, hint) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error(hint || 'TIMEOUT'));
      }, ms);

      promise.then(
        function (value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        function (error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  /** 文本规范化：去首尾空白、合并连续空白、转小写（保证跨设备拼出的 key 一致） */
  function normalizeText(value) {    return String(value == null ? '' : value)
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /** 词条的词典归属：word（字）/ phrase（短语）；旧数据未标注时按「字」兜底 */
  function scopeOf(word) {
    if (!word) return 'word';
    if (word.dictScope === 'phrase') return 'phrase';
    if (word.dictScope === 'word') return 'word';
    // 与 app.js 的兜底口径保持一致：未标注的旧词条按「字」处理
    return 'word';
  }

  /**
   * 生成词条的跨设备稳定标识。
   * 用「分类 + 文本 + 音标」而不是 id：id 是 IndexedDB 自增的，换设备导入
   * 顺序不同就会错位。文本里若含分隔符 '|' 会破坏解析，统一替换掉。
   */
  function makeDictKey(word) {
    if (!word) return '';
    var scope = scopeOf(word);
    var text = normalizeText(word.word).replace(/\|/g, '/');
    if (!text) return '';
    var phonetic = normalizeText(word.phonetic).replace(/\|/g, '/');
    return scope + SEP + text + SEP + phonetic;
  }

  /** 「分类 + 文本」组成的宽松键，用于 dict_key 精确匹配失败时的回退匹配 */
  function makeTextKey(scope, text) {
    return scope + SEP + normalizeText(text).replace(/\|/g, '/');
  }

  /** 解析 dict_key → { scope, text }；解析不了返回 null */
  function parseDictKey(key) {
    var parts = String(key || '').split(SEP);
    if (parts.length < 2) return null;
    var scope = parts[0] === 'phrase' ? 'phrase' : 'word';
    return { scope: scope, text: parts[1] };
  }

  /** 数字兜底：非有限数一律返回 fallback */
  function toNumber(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  /** 数组按固定大小切块 */
  function chunk(list, size) {
    var out = [];
    for (var i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  /**
   * 与键顺序无关的 JSON 序列化。
   * 用途：比较「本地设置/会话」和「刚从 Supabase 读回来的」是不是同一份内容。
   * 必须用它而不是 JSON.stringify——PostgreSQL 的 jsonb 会重排键顺序，
   * 直接用 JSON.stringify 比较，每次都会误判成「内容变了」而重复上行。
   */
  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
      return '[' + value.map(stableStringify).join(',') + ']';
    }
    var keys = Object.keys(value).sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      parts.push(JSON.stringify(keys[i]) + ':' + stableStringify(value[keys[i]]));
    }
    return '{' + parts.join(',') + '}';
  }

  /** 把任意错误翻译成好读、可操作的中文提示 */
  function humanizeError(error) {
    if (!error) return '未知错误';

    // 取出可读的原始信息；Supabase 有时抛的是普通对象而不是 Error
    var raw = '';
    if (typeof error === 'string') {
      raw = error;
    } else {
      raw = String(error.message || error.error_description || error.error || error.msg || '');
    }
    if (!raw || raw === '[object Object]') {
      try {
        raw = JSON.stringify(error);
      } catch (e) {
        raw = String(error);
      }
    }

    // ---- 配置/环境类问题：给出明确的下一步动作 ----
    if (raw === 'TIMEOUT' || /超时/.test(raw)) {
      return '连接 Supabase 超时，请检查网络后重试（若一直超时，可能是当前网络无法访问 supabase.co）';
    }
    if (/PGRST125|Invalid path specified in request URL/i.test(raw)) {
      return '请求地址不对：请检查 supabase-config.js 里的 url，应填项目根地址 ' +
        '（形如 https://xxxx.supabase.co，末尾不要带 /rest/v1 或 /auth/v1）';
    }
    if (/42P01|relation .* does not exist/i.test(raw)) {
      return '数据表不存在：请先在 Supabase 的 SQL Editor 里执行 supabase/schema.sql';
    }
    if (/row-level security|violates row-level security/i.test(raw)) {
      return '被行级安全策略拒绝了：请确认 supabase/schema.sql 已完整执行（含 RLS 策略部分）';
    }
    if (/JWT|Invalid API key|No API key/i.test(raw)) {
      return 'anon key 无效：请重新从 Supabase 的 Project Settings → API 复制 anon public key';
    }
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(raw)) {
      return '网络连接失败，请检查网络后重试';
    }

    if (AUTH_ERROR_MESSAGES[raw]) return AUTH_ERROR_MESSAGES[raw];
    // 前缀匹配兜底（Supabase 有时会加后缀）
    for (var key in AUTH_ERROR_MESSAGES) {
      if (raw.indexOf(key) === 0) return AUTH_ERROR_MESSAGES[key];
    }
    return raw;
  }

  // ==================== 同步引擎 ====================
  function CloudSyncEngine() {
    this.app = null;
    this.client = null;
    this.user = null;

    /** 界面状态：disabled | signed-out | idle | syncing | synced | offline | error */
    this.status = 'disabled';
    /** 最近一次同步结果说明，显示在设置页 */
    this.statusDetail = '';

    /** 待上行的学习记录：dict_key → 行数据 */
    this.dirty = new Map();
    /** 本机同步元数据（存在 IndexedDB，不上云） */
    this.meta = {
      autoSync: CONFIG.autoSync !== false,
      lastSyncAt: 0,
      lastPullAt: 0,
      lastPullCursor: null,
      lastPushedSettingsJson: '',
      lastPushedSessionJson: '',
      progressResetAt: 0,
      lastUserId: null
    };

    /** 本地词条索引，同步过程中反复用到，重建一次即可 */
    this._localByKey = null;
    this._localByText = null;

    /** 抑制标志：为 true 时本地写入不再打脏标记（防止把云端数据又推回去） */
    this._suppress = false;

    this._pushTimer = null;
    this._syncPromise = null;
    this._attached = false;
    // 前台只提供登录：账号由管理员在 Supabase 后台创建
    this._unsubscribeAuth = null;
    /** SDK 是否可用：null=还没判断，true=可用，false=CDN 没加载成功 */
    this.sdkReady = null;
  }

  // ---------------------------------------------------------------- 生命周期

  /**
   * 由 app.js 在初始化完成时调用。
   * 未配置 Supabase 或未加载 SDK 时直接返回，不影响任何本地功能。
   */
  CloudSyncEngine.prototype.attach = function (app) {
    if (this._attached) return;
    this._attached = true;
    this.app = app;

    this.bindUi();
    this.bindNetworkHooks();

    if (!CONFIGURED) {
      this.status = 'disabled';
      this.statusDetail = '请先填写 supabase-config.js';
      this.renderUi();
      console.info(
        '[cloud-sync] 未配置 Supabase，云同步停用，应用以本地模式运行。\n' +
        '  开启方法：① 在 supabase.com 建项目 ② 执行 supabase/schema.sql ' +
        '③ 把 Project URL 和 anon key 填进 supabase-config.js'
      );
      return;
    }
    if (!global.supabase || typeof global.supabase.createClient !== 'function') {
      this.sdkReady = false;
      this.status = 'disabled';
      this.statusDetail = 'Supabase SDK 未加载，请检查网络或 CDN 地址';
      this.renderUi();
      console.warn('[cloud-sync] 未检测到 supabase-js SDK，云同步停用。');
      return;
    }
    this.sdkReady = true;

    // 自动纠正「把 /rest/v1 一起复制进来」这类常见填错
    var normalized = normalizeSupabaseUrl(CONFIG.url);
    this.resolvedUrl = normalized.url;
    if (normalized.corrected) {
      console.warn(
        '[cloud-sync] supabase-config.js 里的 url 带了多余的路径，已自动纠正。\n' +
        '  你填的：' + normalized.original + '\n' +
        '  实际用：' + normalized.url + '\n' +
        '  createClient 需要的是项目根地址（形如 https://xxxx.supabase.co，不带 /rest/v1）。'
      );
      // 提示一次即可，避免每次刷新都弹
      if (!this._urlNoticeShown) {
        this._urlNoticeShown = true;
        try {
          this.app.showToast('配置里的 Supabase 地址带了多余路径，已自动纠正');
        } catch (e) { /* 界面还没就绪时忽略 */ }
      }
    }

    // 先按「已配置、未登录」渲染一次：这样登录入口立刻可见，
    // 不会在 bootstrap 的这几十毫秒里显示成「未启用」而让人以为没生效
    this.renderUi();

    // 再读本机元数据（自动同步开关、上次同步时间等），然后建立客户端并恢复登录态
    this.loadMeta()
      .catch(function () {})
      .then(this.bootstrap.bind(this))
      .catch(function (error) {
        console.error('[cloud-sync] 初始化失败:', error);
      });
  };

  /** 创建 Supabase 客户端、恢复登录态、注册登录态监听 */
  CloudSyncEngine.prototype.bootstrap = async function () {
    var self = this;

    this.client = global.supabase.createClient(this.resolvedUrl || CONFIG.url, CONFIG.anonKey, {
      auth: {
        // 会话持久化在 localStorage，关掉浏览器再打开仍是登录状态
        persistSession: true,
        autoRefreshToken: true,
        // 处理邮件确认/找回密码跳回来时地址里带的 token
        detectSessionInUrl: true,
        storageKey: 'wordcards.auth'
      },
      global: {
        headers: { 'x-application-name': 'wordcards' }
      }
    });

    // 登录态变化（含 token 自动刷新）。
    // 注意：回调里不能直接 await 其它 supabase 调用，官方建议推迟到下一个事件循环。
    var authResult = this.client.auth.onAuthStateChange(function (event, session) {
      setTimeout(function () {
        self.handleAuthEvent(event, session);
      }, 0);
    });
    this._unsubscribeAuth = authResult && authResult.data ? authResult.data.subscription : null;

    var sessionResult = await this.client.auth.getSession();
    var session = sessionResult && sessionResult.data ? sessionResult.data.session : null;

    if (!session || !session.user) {
      this.user = null;
      this.setStatus('signed-out', '未登录');
      return;
    }

    this.user = session.user;
    this.setStatus('idle', '等待同步');
    await this.syncAll('bootstrap');
  };

  /** 登录态变化处理 */
  CloudSyncEngine.prototype.handleAuthEvent = function (event, session) {
    var user = session && session.user ? session.user : null;

    if (event === 'SIGNED_OUT' || !user) {
      this.user = null;
      this.dirty.clear();
      this.setStatus('signed-out', '未登录');
      return;
    }

    var switchedUser = !this.user || this.user.id !== user.id;
    this.user = user;

    if (switchedUser) {
      // 换了账号：清空待上行队列，避免把上一个账号的改动写到新账号下
      this.dirty.clear();
      this.meta.lastPullCursor = null;
      this.meta.lastPushedSettingsJson = '';
      this.meta.lastPushedSessionJson = '';
    }

    this.renderUi();

    if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || switchedUser) {
      if (this.meta.lastUserId !== user.id) {
        this.meta.lastUserId = user.id;
        this.saveMeta().catch(function () {});
      }
      this.syncAll(event === 'SIGNED_IN' ? 'sign-in' : 'session-restore').catch(function () {});
    }
  };

  /** 网络与前台切换时的同步触发 */
  CloudSyncEngine.prototype.bindNetworkHooks = function () {
    var self = this;

    global.addEventListener('online', function () {
      if (!self.isActive()) return;
      self.setStatus('idle', '网络已恢复，正在同步…');
      self.syncAll('online').catch(function () {});
    });

    global.addEventListener('offline', function () {
      if (!self.isActive()) return;
      self.setStatus('offline', '当前离线，恢复网络后会自动同步');
    });

    document.addEventListener('visibilitychange', function () {
      if (!self.isActive()) return;

      if (document.visibilityState === 'hidden') {
        // 页面被切走/关闭前尽量把待上行数据推出去
        self.flushDirty().catch(function () {});
        return;
      }

      // 切回前台：先补传本机改动，再拉取云端更新
      self.flushDirty().catch(function () {});
      var now = Date.now();
      if (now - self.meta.lastPullAt > FOCUS_PULL_MIN_INTERVAL_MS) {
        self.pullAndMerge().catch(function () {});
      }
    });

    // 应用一直停在前台时的兜底轮询。浏览器在后台会把定时器节流到分钟级，
    // 所以这里再显式判断一次可见性，避免在后台空跑。
    if (this._pullTimer) clearInterval(this._pullTimer);
    this._pullTimer = setInterval(function () {
      if (document.visibilityState !== 'visible') return;
      if (!self.isActive() || !self.isAutoSyncOn()) return;
      if (self._syncPromise) return; // 已有同步在跑，别叠加
      self.pullAndMerge().catch(function () {});
    }, AUTO_PULL_INTERVAL_MS);
  };

  // ---------------------------------------------------------------- 状态判定

  /** 已配置 SDK 且已登录，才认为同步通道可用 */
  CloudSyncEngine.prototype.isActive = function () {
    return Boolean(this.client && this.user);
  };

  /** 是否开启自动同步（关掉后只在你手动点时同步，但改动仍会被记录） */
  CloudSyncEngine.prototype.isAutoSyncOn = function () {
    return this.meta.autoSync !== false;
  };

  // ---------------------------------------------------------------- 本地元数据

  CloudSyncEngine.prototype.loadMeta = async function () {
    var saved = await this.app.db.getSetting(META_SETTING_KEY, null);
    if (saved && typeof saved === 'object') {
      // 逐字段合并，保证新版本新增字段有默认值
      for (var key in this.meta) {
        if (Object.prototype.hasOwnProperty.call(saved, key) && saved[key] !== undefined) {
          this.meta[key] = saved[key];
        }
      }
    }
    // 配置文件里的 autoSync 只作为「本机从未设置过」时的默认值
    if (!saved || typeof saved !== 'object' || saved.autoSync === undefined) {
      this.meta.autoSync = CONFIG.autoSync !== false;
    }
  };

  CloudSyncEngine.prototype.saveMeta = async function () {
    await this.app.db.setSetting(META_SETTING_KEY, this.meta);
  };

  // ---------------------------------------------------------------- 本地索引

  /** 重建「dict_key → 词条」与「分类+文本 → 词条[]」两张索引表 */
  CloudSyncEngine.prototype.rebuildLocalIndex = async function () {
    var words = await this.app.db.getAllWords();
    var byKey = new Map();
    var byText = new Map();

    for (var i = 0; i < words.length; i++) {
      var word = words[i];
      var key = makeDictKey(word);
      if (!key) continue;
      byKey.set(key, word);

      var textKey = makeTextKey(scopeOf(word), word.word);
      if (!byText.has(textKey)) byText.set(textKey, []);
      byText.get(textKey).push(word);
    }

    this._localByKey = byKey;
    this._localByText = byText;
    return { byKey: byKey, byText: byText, total: words.length };
  };

  /**
   * 按 dict_key 找本地词条。
   * 精确匹配失败时退化成「分类 + 文本」匹配——词典更新时音标可能被纠正，
   * 此时 dict_key 会变，但学习记录不该丢。只有当该文本在本地唯一时才敢回退，
   * 多读音字这种「同文本多条」的情况宁可放弃，也不错配。
   */
  CloudSyncEngine.prototype.resolveLocalWord = function (dictKey) {
    if (!this._localByKey) return null;
    var hit = this._localByKey.get(dictKey);
    if (hit) return hit;

    var parsed = parseDictKey(dictKey);
    if (!parsed) return null;
    var list = this._localByText ? this._localByText.get(makeTextKey(parsed.scope, parsed.text)) : null;
    if (list && list.length === 1) return list[0];
    return null;
  };

  // ---------------------------------------------------------------- 行数据转换

  /**
   * 把本地词条转成云端行；没有任何学习痕迹（新词、没收藏、没学过）时返回 null，
   * 这类词条不上云——既省流量，也避免词典更新把几千条词条全标成「本地有改动」。
   */
  CloudSyncEngine.prototype.rowFromWord = function (word) {
    var key = makeDictKey(word);
    if (!key) return null;

    var status = word.status === 'mastered' || word.status === 'review' ? word.status : 'new';
    var favorite = Boolean(word.favorite);
    var lastStudied = word.lastStudied == null ? null : toNumber(word.lastStudied, null);
    var reviewCount = Math.max(toNumber(word.reviewCount, 0), 0);

    // 改动时间：优先用写入时打的时间戳，老数据退化成学习时间
    var clientUpdatedAt = Math.max(toNumber(word.syncUpdatedAt, 0), lastStudied || 0);

    var hasTrace = status !== 'new' || favorite || (lastStudied !== null && lastStudied > 0);
    if (!hasTrace) return null;

    return {
      dict_key: key,
      status: status,
      favorite: favorite,
      last_studied: lastStudied,
      review_count: reviewCount,
      client_updated_at: clientUpdatedAt
    };
  };

  /** 收集本地全部「有学习痕迹」的记录：dict_key → 行数据 */
  CloudSyncEngine.prototype.collectLocalProgress = async function () {
    var words = await this.app.db.getAllWords();
    var map = new Map();
    for (var i = 0; i < words.length; i++) {
      var row = this.rowFromWord(words[i]);
      if (row) map.set(row.dict_key, row);
    }
    return map;
  };

  // ---------------------------------------------------------------- 本地写入钩子（app.js 调用）

  /**
   * 【钩子 1】词条即将写入 IndexedDB 时调用（app.js 的 VocabDB.updateWord）。
   * 这里做两件事：
   *   1. 给词条盖上 syncUpdatedAt 时间戳——它就是冲突判定用的 client_updated_at，
   *      跟着词条一起落库，所以刷新页面、关掉浏览器都不会丢。
   *   2. 记入待上行队列。
   * 未登录时不打时间戳也不记队列，行为与改造前完全一致。
   */
  CloudSyncEngine.prototype.stampWord = function (word) {
    if (!word || this._suppress || !this.isActive()) return;

    var stamp = Date.now();
    word.syncUpdatedAt = stamp;

    var row = this.rowFromWord(word);
    if (!row) {
      // 状态被清回「新词」且没有其它痕迹：从待上行队列里撤掉
      this.dirty.delete(makeDictKey(word));
      return;
    }
    row.client_updated_at = stamp; // 本次变更一定是最新的
    this.dirty.set(row.dict_key, row);
    this.schedulePush();
  };

  /**
   * 【钩子 2】设置写入 IndexedDB 后调用（app.js 的 VocabDB.setSetting）。
   * 只关心参与同步的设置项与今日学习会话。
   */
  CloudSyncEngine.prototype.onSettingWritten = function (key) {
    if (this._suppress || !this.isActive()) return;
    if (SYNCED_SETTING_KEYS.indexOf(key) >= 0 || key === 'learnProgress') {
      this.schedulePush();
    }
  };

  /**
   * 【钩子 3】用户点了设置页的「清除」（app.js 的 clearProgress 末尾）。
   * scopeKeys：本次清除的词典范围，['word'] / ['phrase'] / ['word','phrase']。
   *
   * 旧实现是广播一个只增不减的全局重置时间戳（user_state.progress_reset_at），
   * 其它设备收到后会把**所有**范围的记录一起清零；而「清除」现在是按词典范围
   * 生效的，所以改为让这批刚被重置为 new 的词条走普通上行同步：
   * 云端按 dict_key 逐条覆盖成 new，字/短语各自独立，也不需要改数据库结构。
   */
  CloudSyncEngine.prototype.onProgressCleared = async function (scopeKeys) {
    if (!this.isActive()) return;

    var labels = { word: '字', phrase: '短语' };
    var scopeLabel = Array.isArray(scopeKeys) && scopeKeys.length === 1
      ? labels[scopeKeys[0]] || '当前范围'
      : '全部';

    try {
      // 这些词条在 clearProgress 里刚被 updateWord 重置为 new（已进入 dirty 队列），
      // 这里立即上行而不等防抖，保证其它设备下一次拉取拿到的就是清除后的状态。
      // 不能像旧实现那样 clear() 掉队列，否则这批 new 就传不出去了。
      await this.flushDirty();
      this.setStatus('synced', '已清除「' + scopeLabel + '」的云端记录');
    } catch (error) {
      console.warn('[cloud-sync] 清除记录上行失败，将在下次同步重试:', error);
      this.setStatus('error', '清除记录上传失败，稍后会自动重试');
    }
  };

  // ---------------------------------------------------------------- 上行

  /** 防抖调度：合并短时间内的多次改动，避免一张卡一个请求 */
  CloudSyncEngine.prototype.schedulePush = function () {
    if (!this.isActive() || !this.isAutoSyncOn()) return;
    var self = this;
    if (this._pushTimer) clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(function () {
      self._pushTimer = null;
      self.flushDirty().catch(function (error) {
        console.warn('[cloud-sync] 自动上行失败:', error);
      });
    }, AUTO_PUSH_DEBOUNCE_MS);
  };

  /** 推送待上行队列 + 检查设置/会话是否有变化 */
  CloudSyncEngine.prototype.flushDirty = async function () {
    if (!this.isActive()) return;

    // 注意：Map 的 values() 返回的是迭代器，不能用 Array.prototype.slice.call
    // 去转换（切片只认类数组对象，对迭代器会得到空数组），必须用 Array.from
    var rows = Array.from(this.dirty.values());
    var settingsChanged =
      stableStringify(this.collectLocalSettings()) !== this.meta.lastPushedSettingsJson;

    // 学习记录、设置都没变时，仍要看一眼今日会话（跳过卡片不会写 learnProgress，
    // 但队列顺序变了，只有做内容对比才抓得住）
    if (rows.length === 0 && !settingsChanged) {
      await this.pushStateIfChanged();
      return;
    }

    // 先清空再推送：推送期间新产生的改动会重新入队，不会被这次误清
    this.dirty.clear();
    this.setStatus('syncing', '正在上传…');

    try {
      if (rows.length > 0) {
        var accepted = await this.pushRows(rows);
        await this.reconcileAccepted(rows, accepted);
      }

      await this.pushStateIfChanged();

      this.meta.lastSyncAt = Date.now();
      await this.saveMeta();
      this.setStatus('synced', '已同步');
    } catch (error) {
      // 失败：把这次的行放回队列，下次重试（同一 key 保留时间戳更大的那条）
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var prev = this.dirty.get(row.dict_key);
        if (!prev || toNumber(prev.client_updated_at, 0) < toNumber(row.client_updated_at, 0)) {
          this.dirty.set(row.dict_key, row);
        }
      }
      var offline = !navigator.onLine || /Failed to fetch|NetworkError|Load failed/i.test(String(error && error.message));
      this.setStatus(offline ? 'offline' : 'error', offline ? '当前离线，记录已存在本机，联网后自动上传' : humanizeError(error));
      throw error;
    }
  };

  /** 批量调用 push_progress，返回云端解决冲突后的最终行 */
  CloudSyncEngine.prototype.pushRows = async function (rows) {
    var accepted = [];
    var batches = chunk(rows, PUSH_BATCH_SIZE);

    for (var i = 0; i < batches.length; i++) {
      var result = await withTimeout(
        this.client.rpc('push_progress', { p_rows: batches[i] }),
        REQUEST_TIMEOUT_MS,
        'TIMEOUT'
      );
      if (result.error) throw result.error;
      if (Array.isArray(result.data)) {
        accepted = accepted.concat(result.data);
      }
    }
    return accepted;
  };

  /**
   * 处理「我以为我赢了，其实云端有更新的版本」的情况：
   * push_progress 会回传这些词条在云端的最终状态，比本地新的就写回本地。
   */
  CloudSyncEngine.prototype.reconcileAccepted = async function (sentRows, acceptedRows) {
    if (!acceptedRows || acceptedRows.length === 0) return 0;

    var sentByKey = new Map();
    for (var i = 0; i < sentRows.length; i++) sentByKey.set(sentRows[i].dict_key, sentRows[i]);

    var toApply = [];
    for (var j = 0; j < acceptedRows.length; j++) {
      var remote = acceptedRows[j];
      var sent = sentByKey.get(remote.dict_key);
      if (!sent) continue;
      if (toNumber(remote.client_updated_at, 0) > toNumber(sent.client_updated_at, 0)) {
        toApply.push(remote);
      }
    }
    if (toApply.length === 0) return 0;

    await this.rebuildLocalIndex();
    return this.applyRowsLocally(toApply);
  };

  // ---------------------------------------------------------------- 下行

  /** 全量拉取云端学习记录（分页；不做游标，避免同一时间戳翻页漏数据） */
  CloudSyncEngine.prototype.fetchAllProgress = async function () {
    var all = [];
    var offset = 0;

    for (var page = 0; page < MAX_PULL_PAGES; page++) {
      var result = await withTimeout(
        this.client
          .from('word_progress')
          .select('dict_key,status,favorite,last_studied,review_count,client_updated_at,updated_at')
          .eq('user_id', this.user.id)
          .order('client_updated_at', { ascending: true })
          .range(offset, offset + PULL_PAGE_SIZE - 1),
        REQUEST_TIMEOUT_MS,
        'TIMEOUT'
      );

      if (result.error) throw result.error;
      var data = result.data || [];
      all = all.concat(data);
      if (data.length < PULL_PAGE_SIZE) break;
      offset += PULL_PAGE_SIZE;
    }
    return all;
  };

  /** 增量拉取：只取服务端 updated_at 晚于游标的行 */
  CloudSyncEngine.prototype.fetchProgressSince = async function (cursor) {
    if (!cursor) return this.fetchAllProgress();

    var result = await withTimeout(
      this.client
        .from('word_progress')
        .select('dict_key,status,favorite,last_studied,review_count,client_updated_at,updated_at')
        .eq('user_id', this.user.id)
        .gte('updated_at', cursor)
        .order('updated_at', { ascending: true })
        .limit(PULL_PAGE_SIZE),
      REQUEST_TIMEOUT_MS,
      'TIMEOUT'
    );

    if (result.error) throw result.error;
    return result.data || [];
  };

  /**
   * 把云端行写入本地词条。
   * 只写「真的不一样」的，尽量少触发 IndexedDB 写入。
   * 返回实际改动的条数。
   */
  CloudSyncEngine.prototype.applyRowsLocally = async function (rows) {
    var changedWords = [];
    var pending = [];

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var word = this.resolveLocalWord(row.dict_key);
      if (!word) continue; // 本地没有这个词条（词典版本不同），跳过

      var status = row.status === 'mastered' || row.status === 'review' ? row.status : 'new';
      var favorite = Boolean(row.favorite);
      var lastStudied = row.last_studied == null ? null : toNumber(row.last_studied, null);
      var clientUpdatedAt = toNumber(row.client_updated_at, 0);

      var statusChanged = (word.status || 'new') !== status;
      var favoriteChanged = Boolean(word.favorite) !== favorite;
      var timeChanged =
        lastStudied !== null && toNumber(word.lastStudied, 0) !== lastStudied;
      var stampChanged = toNumber(word.syncUpdatedAt, 0) < clientUpdatedAt;

      if (!statusChanged && !favoriteChanged && !timeChanged) {
        // 内容一致，只把时间戳补齐，避免下次同步又判定为「本地待确认」
        if (stampChanged) {
          word.syncUpdatedAt = clientUpdatedAt;
          pending.push(word);
        }
        continue;
      }

      if (statusChanged) word.status = status;
      if (favoriteChanged) word.favorite = favorite;
      if (timeChanged) word.lastStudied = lastStudied;
      word.syncUpdatedAt = clientUpdatedAt;
      pending.push(word);
      changedWords.push(word);
    }

    if (pending.length === 0) return 0;

    await this.bulkWriteWords(pending);
    // 界面上正在背的卡片可能就包含这些词条，把内存里的副本一起更新，
    // 否则卡片上的收藏按钮、状态标签会显示成旧值
    this.syncInMemoryCopies(changedWords);
    return changedWords.length;
  };

  /**
   * 批量写回词条（一个事务写完）。
   * 直接操作底层 IndexedDB 而不是调用 app.db.updateWord：
   * 一是快得多（首次同步可能几千条），二是绕开 stampWord 钩子防止回环。
   */
  CloudSyncEngine.prototype.bulkWriteWords = function (words) {
    var idb = this.app.db.db;
    return new Promise(function (resolve, reject) {
      var tx = idb.transaction(['words'], 'readwrite');
      var store = tx.objectStore('words');
      for (var i = 0; i < words.length; i++) store.put(words[i]);
      tx.oncomplete = function () { resolve(words.length); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error('IndexedDB 事务被中止')); };
    });
  };

  /** 同步 app 内存中「今日队列 / 会话快照」里对应词条的状态 */
  CloudSyncEngine.prototype.syncInMemoryCopies = function (words) {
    if (!words || words.length === 0) return;
    var byId = new Map();
    for (var i = 0; i < words.length; i++) byId.set(words[i].id, words[i]);

    var lists = [this.app.todayWords];
    if (this.app._learnSessionSnapshot && this.app._learnSessionSnapshot.todayWords) {
      lists.push(this.app._learnSessionSnapshot.todayWords);
    }

    for (var l = 0; l < lists.length; l++) {
      var list = lists[l];
      if (!Array.isArray(list)) continue;
      for (var k = 0; k < list.length; k++) {
        var fresh = byId.get(list[k].id);
        if (!fresh) continue;
        list[k].status = fresh.status;
        list[k].favorite = fresh.favorite;
        list[k].lastStudied = fresh.lastStudied;
        list[k].syncUpdatedAt = fresh.syncUpdatedAt;
      }
    }
  };

  // ---------------------------------------------------------------- 重置信号

  /**
   * 应用云端「清除记录」信号：把重置时间点之前的学习状态清零。
   * 重置之后又学过的词条（时间戳更大）保留，避免把新学的也清掉。
   */
  CloudSyncEngine.prototype.applyRemoteReset = async function (remoteResetAt) {
    var resetAt = toNumber(remoteResetAt, 0);
    var localResetAt = toNumber(this.meta.progressResetAt, 0);
    if (!resetAt || resetAt <= localResetAt) return 0;

    var words = await this.app.db.getAllWords();
    var touched = [];

    for (var i = 0; i < words.length; i++) {
      var word = words[i];
      var effStamp = Math.max(toNumber(word.syncUpdatedAt, 0), toNumber(word.lastStudied, 0));
      if (effStamp > resetAt) continue; // 重置之后学的，保留
      if ((word.status && word.status !== 'new') || word.favorite) {
        word.status = 'new';
        word.favorite = false;
        word.syncUpdatedAt = resetAt;
        touched.push(word);
      }
    }

    if (touched.length > 0) {
      this._suppress = true;
      try {
        await this.bulkWriteWords(touched);
      } finally {
        this._suppress = false;
      }
      this.syncInMemoryCopies(touched);
    }

    this.meta.progressResetAt = resetAt;
    await this.saveMeta();

    // 词条状态已被清零，今日累计张数也要一起归零，否则进度条会停在旧数字上
    if (typeof this.app.resetTodayDoneCount === 'function') {
      try {
        await this.app.resetTodayDoneCount();
      } catch (error) {
        console.warn('[cloud-sync] 重置今日进度计数失败:', error);
      }
    }

    console.info('[cloud-sync] 已应用云端重置信号，清零', touched.length, '条记录');
    return touched.length;
  };

  // ---------------------------------------------------------------- 设置 / 会话

  /** 从 app.settings 里挑出参与同步的项 */
  CloudSyncEngine.prototype.collectLocalSettings = function () {
    var out = {};
    for (var i = 0; i < SYNCED_SETTING_KEYS.length; i++) {
      var key = SYNCED_SETTING_KEYS[i];
      if (this.app.settings[key] !== undefined) out[key] = this.app.settings[key];
    }
    return out;
  };

  /** 应用云端设置到内存、IndexedDB 与界面控件 */
  CloudSyncEngine.prototype.applyRemoteSettings = async function (settings) {
    if (!settings || typeof settings !== 'object') return 0;

    var applied = 0;
    this._suppress = true;
    try {
      for (var i = 0; i < SYNCED_SETTING_KEYS.length; i++) {
        var key = SYNCED_SETTING_KEYS[i];
        if (settings[key] === undefined || settings[key] === null) continue;
        if (this.app.settings[key] === settings[key]) continue;
        this.app.settings[key] = settings[key];
        await this.app.db.setSetting(key, settings[key]);
        applied++;
      }
    } finally {
      this._suppress = false;
    }

    if (applied > 0) {
      // 让设置页控件与学习页按新设置重新渲染
      try {
        this.app.applySettings();
        this.app.renderSettings();
      } catch (error) {
        console.warn('[cloud-sync] 应用云端设置后刷新界面失败:', error);
      }
      this.meta.lastPushedSettingsJson = stableStringify(this.collectLocalSettings());
      await this.saveMeta();
    }
    return applied;
  };

  /** 收集本地今日学习会话（只同步「今天」的，跨天的没有意义） */
  CloudSyncEngine.prototype.collectLocalSession = async function () {
    var progress = await this.app.db.getSetting('learnProgress', null);
    if (!progress || !Array.isArray(progress.todayWords) || progress.todayWords.length === 0) return null;

    var savedAt = progress.savedAt || new Date().toISOString();
    var dateKey;
    try {
      dateKey = new Date(savedAt).toDateString();
    } catch (error) {
      return null;
    }
    if (dateKey !== new Date().toDateString()) return null;

    var keys = [];
    for (var i = 0; i < progress.todayWords.length; i++) {
      var key = makeDictKey(progress.todayWords[i]);
      if (key) keys.push(key);
    }
    if (keys.length === 0) return null;

    return {
      date: dateKey,
      currentCardIndex: toNumber(progress.currentCardIndex, 0),
      goal: toNumber(this.app.settings.dailyGoal, 0),
      savedAt: savedAt,
      dictKeys: keys
    };
  };

  /**
   * 应用云端今日会话（换设备接着背）。
   * 只有「今天」「本地今天还没有会话」「用户当前不在学习中」时才应用，
   * 避免把正在背的队列冲掉。
   *
   * options.strict 为 true 时更保守：只要用户此刻停在学习页且队列非空就跳过。
   * 后台轮询（pullAndMerge）用 strict，防止每分钟检查一次更新时把卡片换掉；
   * 全量同步（登录、启动、手动点同步）不用 strict，这样新设备登录后
   * 仍能正常恢复手机上的今日队列。
   */
  CloudSyncEngine.prototype.applyRemoteSession = async function (session, options) {
    if (!session || !Array.isArray(session.dictKeys) || session.dictKeys.length === 0) return false;
    if (session.date !== new Date().toDateString()) return false;

    if (options && options.strict) {
      if (this.app.currentPage === 'learn' && this.app.todayWords && this.app.todayWords.length > 0) {
        return false;
      }
    }

    if (this.app.todayWords && this.app.todayWords.length > 0 && this.app.currentCardIndex > 0) return false;

    var local = await this.app.db.getSetting('learnProgress', null);
    if (local && local.savedAt) {
      var localDate = new Date(local.savedAt).toDateString();
      var localStamp = new Date(local.savedAt).getTime();
      var remoteStamp = session.savedAt ? new Date(session.savedAt).getTime() : 0;
      if (localDate === session.date && localStamp >= remoteStamp) return false;
    }

    await this.rebuildLocalIndex();

    var words = [];
    var seen = new Set();
    for (var i = 0; i < session.dictKeys.length; i++) {
      var word = this.resolveLocalWord(session.dictKeys[i]);
      if (!word || seen.has(word.id)) continue;
      seen.add(word.id);
      words.push(word);
    }
    if (words.length === 0) return false;

    var index = Math.min(Math.max(toNumber(session.currentCardIndex, 0), 0), words.length);
    this._suppress = true;
    try {
      await this.app.db.setSetting('learnProgress', {
        currentCardIndex: index,
        todayWords: words,
        savedAt: session.savedAt || new Date().toISOString()
      });
    } finally {
      this._suppress = false;
    }

    this.meta.lastPushedSessionJson = stableStringify(session);
    await this.saveMeta();

    // 换设备接着背：云端会话只带「队列下标」，本地进度条按累计张数算，
    // 因此把累计数补到不低于该下标，进度条才与卡片位置对得上
    var localDone = toNumber(this.app.todayDoneCount, 0);
    if (index > localDone && typeof this.app.saveTodayDoneCount === 'function') {
      this.app.todayDoneCount = index;
      try {
        await this.app.saveTodayDoneCount();
      } catch (error) {
        console.warn('[cloud-sync] 对齐今日进度计数失败:', error);
      }
    }

    // 让学习页按同步过来的队列重建（prepareLearnSession 会读取刚写入的 learnProgress）
    if (this.app.currentPage === 'learn') {
      this.app.currentCardIndex = 0;
      this.app._learnSessionSnapshot = null;
      try {
        await this.app.prepareLearnSession();
      } catch (error) {
        console.warn('[cloud-sync] 恢复云端学习会话失败:', error);
      }
    }
    return true;
  };

  // ---------------------------------------------------------------- 用户状态（设置/会话/重置）

  CloudSyncEngine.prototype.fetchUserState = async function () {
    var result = await withTimeout(
      this.client
        .from('user_state')
        .select('settings,settings_updated_at,session,session_updated_at,progress_reset_at')
        .eq('user_id', this.user.id)
        .maybeSingle(),
      REQUEST_TIMEOUT_MS,
      'TIMEOUT'
    );

    if (result.error) throw result.error;
    return (
      result.data || {
        settings: {},
        settings_updated_at: 0,
        session: null,
        session_updated_at: 0,
        progress_reset_at: 0
      }
    );
  };

  /** 调用 push_user_state；只传想改的字段，null 表示不动 */
  CloudSyncEngine.prototype.pushUserState = async function (patch) {
    var result = await withTimeout(
      this.client.rpc('push_user_state', {
        p_settings: patch.settings === undefined ? null : patch.settings,
        p_settings_updated_at: patch.settingsUpdatedAt === undefined ? null : patch.settingsUpdatedAt,
        p_session: patch.session === undefined ? null : patch.session,
        p_session_updated_at: patch.sessionUpdatedAt === undefined ? null : patch.sessionUpdatedAt,
        p_progress_reset_at: patch.progressResetAt === undefined ? null : patch.progressResetAt
      }),
      REQUEST_TIMEOUT_MS,
      'TIMEOUT'
    );
    if (result.error) throw result.error;
    return Array.isArray(result.data) ? result.data[0] : result.data;
  };

  /**
   * 如果设置或今日会话变了就推上去。
   * 会话用「内容对比」而不是事件标记：跳过卡片之类的操作不会写 learnProgress，
   * 但队列顺序其实变了，靠内容对比才抓得住。
   * 返回是否真的发出了请求。
   */
  CloudSyncEngine.prototype.pushStateIfChanged = async function () {
    var patch = {};

    var settings = this.collectLocalSettings();
    var settingsJson = stableStringify(settings);
    if (settingsJson !== this.meta.lastPushedSettingsJson) {
      patch.settings = settings;
      patch.settingsUpdatedAt = Date.now();
    }

    var session = await this.collectLocalSession();
    var sessionJson = stableStringify(session);
    if (sessionJson !== this.meta.lastPushedSessionJson) {
      if (session) {
        patch.session = session;
        patch.sessionUpdatedAt = Date.now();
      } else {
        // 本地今天没有有效会话（还没开始学 / 已跨天）：只记下现状，
        // 服务端不允许把会话显式清空，跨天自然失效即可
        this.meta.lastPushedSessionJson = sessionJson;
      }
    }

    if (Object.keys(patch).length === 0) return false;

    await this.pushUserState(patch);

    if (patch.settings !== undefined) this.meta.lastPushedSettingsJson = settingsJson;
    if (patch.session !== undefined) this.meta.lastPushedSessionJson = sessionJson;
    await this.saveMeta();
    return true;
  };

  // ---------------------------------------------------------------- 同步主流程

  /**
   * 全量双向同步。并发调用会复用同一个 Promise，不会重复跑。
   * 步骤：拉云端用户状态 → 应用重置信号 → 拉全部学习记录 → 逐条合并
   *      → 上行本地更新更晚的记录 → 上行设置/会话 → 刷新界面
   */
  CloudSyncEngine.prototype.syncAll = function (reason) {
    if (!this.isActive()) return Promise.resolve(false);
    if (this._syncPromise) return this._syncPromise;

    var self = this;
    this._syncPromise = this._doSyncAll(reason).finally(function () {
      self._syncPromise = null;
    });
    return this._syncPromise;
  };

  CloudSyncEngine.prototype._doSyncAll = async function (reason) {
    this.setStatus('syncing', '正在同步…');

    try {
      // 1) 用户状态：设置 / 今日会话 / 重置信号
      var state = await this.fetchUserState();

      // 2) 重置信号优先处理，后面的合并才不会被已作废的数据带偏
      await this.applyRemoteReset(state.progress_reset_at);

      // 3) 云端学习记录全量拉取
      var remoteRows = await this.fetchAllProgress();

      // 重置时间点之前的行已经作废，直接无视
      var resetAt = toNumber(this.meta.progressResetAt, 0);
      if (resetAt > 0) {
        remoteRows = remoteRows.filter(function (row) {
          return toNumber(row.client_updated_at, 0) > resetAt;
        });
      }

      // 4) 建立本地索引并双向合并
      await this.rebuildLocalIndex();
      var localMap = await this.collectLocalProgress();

      // 云端行按 dict_key 建索引，避免下面两层遍历变成 O(n²)
      var remoteByKey = new Map();
      for (var i = 0; i < remoteRows.length; i++) {
        remoteByKey.set(remoteRows[i].dict_key, remoteRows[i]);
      }

      // 云端比本地新（或本地没有）→ 下行覆盖本地
      var remoteNewer = [];
      remoteByKey.forEach(function (row, key) {
        var local = localMap.get(key);
        if (!local || toNumber(row.client_updated_at, 0) > toNumber(local.client_updated_at, 0)) {
          remoteNewer.push(row);
        }
      });
      var appliedCount = await this.applyRowsLocally(remoteNewer);

      // 本地比云端新（或云端没有）→ 上行
      var toPush = [];
      var pushedTotal = 0;
      localMap.forEach(function (local, key) {
        var remote = remoteByKey.get(key);
        if (!remote || toNumber(local.client_updated_at, 0) > toNumber(remote.client_updated_at, 0)) {
          toPush.push(local);
        }
      });

      if (toPush.length > 0) {
        var accepted = await this.pushRows(toPush);
        // reconcileAccepted 返回「云端版本更新、本地被反向下行」的条数，
        // 其余就是本地真正写进云端的条数
        var remoteWins = await this.reconcileAccepted(toPush, accepted);
        pushedTotal = Math.max(toPush.length - remoteWins, 0);
        appliedCount += remoteWins;
      }

      // 6) 设置：云端更新就用云端，本地更新就推上去
      var localSettingsJson = stableStringify(this.collectLocalSettings());
      var remoteSettingsJson = stableStringify(state.settings || {});
      var remoteSettingsNewer =
        toNumber(state.settings_updated_at, 0) > 0 && remoteSettingsJson !== localSettingsJson;

      if (remoteSettingsNewer) {
        await this.applyRemoteSettings(state.settings);
      }
      // 应用完云端设置后若本地与云端仍不同，说明本地这份更新 → 推上去
      var settingsAfterApply = this.collectLocalSettings();
      if (stableStringify(settingsAfterApply) !== remoteSettingsJson) {
        await this.pushUserState({
          settings: settingsAfterApply,
          settingsUpdatedAt: Date.now()
        });
      }
      this.meta.lastPushedSettingsJson = stableStringify(settingsAfterApply);

      // 7) 今日会话：云端更新就恢复，否则把本地的推上去
      var sessionApplied = await this.applyRemoteSession(state.session);
      if (!sessionApplied) {
        await this.pushStateIfChanged();
      } else {
        await this.saveMeta();
      }

      // 8) 刷新界面（统计口径完全由词条状态实时算出，所以同步后必须重算）
      await this.refreshLocalViews(appliedCount > 0);

      this.meta.lastSyncAt = Date.now();
      this.meta.lastPullAt = Date.now();
      await this.saveMeta();

      var changedTotal = appliedCount;
      var summary;
      if (changedTotal > 0 && pushedTotal > 0) {
        summary = '双向同步完成：云端更新 ' + changedTotal + ' 条，本地上传 ' + pushedTotal + ' 条';
      } else if (changedTotal > 0) {
        summary = '已从云端更新 ' + changedTotal + ' 条记录';
      } else if (pushedTotal > 0) {
        summary = '已上传本机 ' + pushedTotal + ' 条记录';
      } else {
        summary = '已是最新';
      }
      this.setStatus('synced', summary);
      return true;
    } catch (error) {
      var offline = !navigator.onLine || /Failed to fetch|NetworkError|Load failed/i.test(String(error && error.message));
      this.setStatus(offline ? 'offline' : 'error', offline ? '当前离线，联网后会自动同步' : humanizeError(error));
      console.warn('[cloud-sync] 同步失败(' + (reason || 'manual') + '):', error);
      throw error;
    }
  };

  /**
   * 增量拉取（切回前台时用）：只取服务端 updated_at 变化过的行 + 用户状态。
   * 比 syncAll 轻，适合频繁调用。
   */
  CloudSyncEngine.prototype.pullAndMerge = async function () {
    if (!this.isActive()) return false;

    try {
      // 1) 用户状态：重置信号必须最先处理，否则会把已作废的记录又拉回本地
      var state = await this.fetchUserState();
      await this.applyRemoteReset(state.progress_reset_at);

      // 2) 增量拉学习记录
      var remoteRows = await this.fetchProgressSince(this.meta.lastPullCursor);
      this.meta.lastPullAt = Date.now();

      if (remoteRows.length > 0) {
        var resetAt = toNumber(this.meta.progressResetAt, 0);
        // 重置时间点之前的行已经作废，拉回来也要丢掉
        var usable = remoteRows.filter(function (row) {
          return toNumber(row.client_updated_at, 0) > resetAt;
        });

        await this.rebuildLocalIndex();
        var localMap = await this.collectLocalProgress();
        var newer = [];
        for (var i = 0; i < usable.length; i++) {
          var local = localMap.get(usable[i].dict_key);
          if (!local || toNumber(usable[i].client_updated_at, 0) > toNumber(local.client_updated_at, 0)) {
            newer.push(usable[i]);
          }
        }

        var changed = await this.applyRowsLocally(newer);
        if (changed > 0) {
          // 这里传 false：增量拉取可能是后台轮询触发的，
          // 不重建今日队列，免得正在背单词时卡片突然换成另一张
          await this.refreshLocalViews(false);
          this.setStatus('synced', '已从云端更新 ' + changed + ' 条记录');
          // 正在背单词时不弹提示打扰，顶部徽标已经能说明状态
          if (this.app.currentPage !== 'learn') {
            this.app.showToast('已同步云端学习记录（' + changed + ' 条）');
          }
        } else {
          this.setStatus('synced', '已是最新');
        }

        var last = usable[usable.length - 1] || remoteRows[remoteRows.length - 1];
        if (last && last.updated_at) this.meta.lastPullCursor = last.updated_at;
      } else {
        this.setStatus('synced', '已是最新');
      }

      // 3) 设置与今日会话也可能在别的设备上改过
      await this.applyRemoteSettings(state.settings);
      await this.applyRemoteSession(state.session, { strict: true });

      this.meta.lastSyncAt = Date.now();
      await this.saveMeta();
      return true;
    } catch (error) {
      console.warn('[cloud-sync] 增量拉取失败:', error);
      this.setStatus(navigator.onLine ? 'error' : 'offline', humanizeError(error));
      return false;
    }
  };

  /**
   * 同步后刷新本地界面：统计数字、学习页、词库页。
   * rebuildLearnQueue 为 true 时（本地确实被云端改写了）还要让今日队列失效：
   * 学习状态变了会影响「重复频率」筛选结果，旧队列里可能残留别的设备已经
   * 掌握过的词；同时丢弃离开学习页时的快照，这样切回学习页会重新抽词。
   */
  CloudSyncEngine.prototype.refreshLocalViews = async function (rebuildLearnQueue) {
    if (!this.app) return;
    try {
      // 统计完全由词条状态实时算出，状态变了就必须整体重算
      await this.app.refreshStatusCounts();

      if (rebuildLearnQueue) {
        this.app._learnSessionSnapshot = null;
        // 只在还没开始背（下标为 0）时立刻重建，避免打断正在学习的人
        if (this.app.currentPage === 'learn' && this.app.currentCardIndex === 0) {
          await this.app.prepareLearnSession();
        }
      }

      if (this.app.currentPage === 'library') {
        await this.app.renderLibrary();
      } else if (this.app.currentPage === 'learn') {
        // 只刷新当前卡片上可能过期的显示（收藏按钮等），不重建队列以免打断学习
        this.app.updateProgress();
        var word = this.app.todayWords && this.app.todayWords[this.app.currentCardIndex];
        if (word) {
          document.querySelectorAll('.favorite-btn').forEach(function (btn) {
            btn.classList.toggle('active', Boolean(word.favorite));
          });
        }
      }
    } catch (error) {
      console.warn('[cloud-sync] 刷新界面失败:', error);
    }
  };

  // ---------------------------------------------------------------- 认证操作

  CloudSyncEngine.prototype.signIn = async function (email, password) {
    if (!this.client) throw new Error('Supabase 客户端尚未就绪，请稍后重试');
    var result = await withTimeout(
      this.client.auth.signInWithPassword({ email: email, password: password }),
      AUTH_TIMEOUT_MS,
      'TIMEOUT'
    );
    if (result.error) throw result.error;
    this.user = result.data.user;
    return result.data.user;
  };

  CloudSyncEngine.prototype.signOut = async function () {
    if (this._pushTimer) {
      clearTimeout(this._pushTimer);
      this._pushTimer = null;
    }
    // 退出前尽量把本地改动推上去，避免丢最后一次学习记录
    try {
      if (this.isActive()) await this.flushDirty();
    } catch (error) {
      console.warn('[cloud-sync] 退出前同步失败（本地记录仍在）:', error);
    }

    await this.client.auth.signOut();
    this.user = null;
    this.dirty.clear();
    this.setStatus('signed-out', '未登录');
  };

  CloudSyncEngine.prototype.sendPasswordReset = async function (email) {
    if (!this.client) throw new Error('Supabase 客户端尚未就绪，请稍后重试');
    var redirectTo = global.location.origin + global.location.pathname;
    var result = await withTimeout(
      this.client.auth.resetPasswordForEmail(email, { redirectTo: redirectTo }),
      AUTH_TIMEOUT_MS,
      'TIMEOUT'
    );
    if (result.error) throw result.error;
    return true;
  };

  // ---------------------------------------------------------------- 界面

  /** 绑定设置页与弹窗里的所有事件（元素在 index.html 中） */
  CloudSyncEngine.prototype.bindUi = function () {
    var self = this;
    var $ = function (id) { return document.getElementById(id); };

    var signInBtn = $('cloudSignInBtn');
    if (signInBtn) signInBtn.addEventListener('click', function () { self.openAuthModal(); });

    var syncNowBtn = $('cloudSyncNowBtn');
    if (syncNowBtn) {
      syncNowBtn.addEventListener('click', function () {
        self.syncAll('manual')
          .then(function () { self.app.showToast('同步完成'); })
          .catch(function (error) { self.app.showToast('同步失败：' + humanizeError(error)); });
      });
    }

    var signOutBtn = $('cloudSignOutBtn');
    if (signOutBtn) {
      signOutBtn.addEventListener('click', function () {
        if (!confirm('确定退出登录吗？本机学习记录会保留，重新登录后可继续同步。')) return;
        self.signOut()
          .then(function () { self.app.showToast('已退出登录'); })
          .catch(function (error) { self.app.showToast('退出失败：' + humanizeError(error)); });
      });
    }

    var autoToggle = $('cloudAutoSyncToggle');
    if (autoToggle) {
      autoToggle.addEventListener('click', function () {
        self.meta.autoSync = !self.isAutoSyncOn();
        autoToggle.classList.toggle('active', self.meta.autoSync);
        self.saveMeta().catch(function () {});
        self.app.showToast(self.meta.autoSync ? '已开启自动同步' : '已关闭自动同步（仍可手动同步）');
        if (self.meta.autoSync) self.schedulePush();
      });
    }

    var badge = $('cloudBadge');
    if (badge) {
      badge.addEventListener('click', function () {
        if (!self.app) return;
        self.app.switchPage('settings');
        var section = $('cloudSection');
        if (section && section.scrollIntoView) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    // ---- 登录 / 注册弹窗 ----
    var closeBtn = $('cloudAuthClose');
    if (closeBtn) closeBtn.addEventListener('click', function () { self.closeAuthModal(); });

    var authModal = $('cloudAuthModal');
    if (authModal) {
      authModal.addEventListener('click', function (event) {
        if (event.target === authModal) self.closeAuthModal();
      });
    }

    var form = $('cloudAuthForm');
    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        self.submitAuth();
      });
    }

    // 提交按钮在弹窗 footer 里（form 之外），所以单独绑一次
    var authSubmit = $('cloudAuthSubmit');
    if (authSubmit) {
      authSubmit.addEventListener('click', function () { self.submitAuth(); });
    }
    var passwordInput = $('cloudAuthPassword');
    if (passwordInput) {
      passwordInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          self.submitAuth();
        }
      });
    }

    var forgot = $('cloudAuthForgot');
    if (forgot) {
      forgot.addEventListener('click', function () { self.handleForgotPassword(); });
    }

    // ---- 找回密码弹窗 ----
    var resetModal = $('cloudResetModal');
    if (resetModal) {
      resetModal.addEventListener('click', function (event) {
        if (event.target === resetModal) self.closeResetModal();
      });
    }
    var resetClose = $('cloudResetClose');
    if (resetClose) resetClose.addEventListener('click', function () { self.closeResetModal(); });
    var resetForm = $('cloudResetForm');
    if (resetForm) {
      resetForm.addEventListener('submit', function (event) {
        event.preventDefault();
        self.submitPasswordReset();
      });
    }
    var resetSubmit = $('cloudResetSubmit');
    if (resetSubmit) {
      resetSubmit.addEventListener('click', function () { self.submitPasswordReset(); });
    }
  };

  /**
   * 打开登录弹窗。
   * 前台不再提供注册（账号在 Supabase 后台添加），因此弹窗只有登录一种形态；
   * 参数仅为兼容旧调用保留，传入什么都不影响。
   */
  CloudSyncEngine.prototype.openAuthModal = function () {
    var modal = document.getElementById('cloudAuthModal');
    if (!modal) return;

    this.setAuthError('');
    document.getElementById('cloudAuthTitle').textContent = '登录账号';
    document.getElementById('cloudAuthSubmit').textContent = '登录';
    document.getElementById('cloudAuthHint').textContent = '登录后手机与电脑共用同一份学习记录。';

    modal.classList.add('active');
    var emailInput = document.getElementById('cloudAuthEmail');
    if (emailInput) setTimeout(function () { emailInput.focus(); }, 60);
  };

  CloudSyncEngine.prototype.closeAuthModal = function () {
    var modal = document.getElementById('cloudAuthModal');
    if (modal) modal.classList.remove('active');
    var password = document.getElementById('cloudAuthPassword');
    if (password) password.value = '';
    this.setAuthError('');
  };

  CloudSyncEngine.prototype.openResetModal = function () {
    var modal = document.getElementById('cloudResetModal');
    if (!modal) return;
    var email = document.getElementById('cloudAuthEmail');
    var resetEmail = document.getElementById('cloudResetEmail');
    if (email && resetEmail && email.value) resetEmail.value = email.value;
    this.setResetError('');
    modal.classList.add('active');
  };

  CloudSyncEngine.prototype.closeResetModal = function () {
    var modal = document.getElementById('cloudResetModal');
    if (modal) modal.classList.remove('active');
    this.setResetError('');
  };

  /**
   * 显示/隐藏弹窗内的错误提示。
   * 注意 display 必须显式写 'block' —— 写成 '' 只会清掉内联样式，
   * 而 CSS 里 .cloud-error 本身就是 display:none，结果就是错误永远不显示，
   * 用户点了按钮看起来「毫无反应」。
   */
  CloudSyncEngine.prototype.setAuthError = function (message) {
    var el = document.getElementById('cloudAuthError');
    if (!el) return;
    el.textContent = message || '';
    el.style.display = message ? 'block' : 'none';
  };

  CloudSyncEngine.prototype.setResetError = function (message) {
    var el = document.getElementById('cloudResetError');
    if (!el) return;
    el.textContent = message || '';
    el.style.display = message ? 'block' : 'none';
  };

  CloudSyncEngine.prototype.setAuthBusy = function (busy) {
    var submit = document.getElementById('cloudAuthSubmit');
    if (!submit) return;
    submit.disabled = busy;
    submit.textContent = busy ? '登录中…' : '登录';
  };

  /** 提交登录表单 */
  CloudSyncEngine.prototype.submitAuth = async function () {
    var email = (document.getElementById('cloudAuthEmail').value || '').trim();
    var password = document.getElementById('cloudAuthPassword').value || '';

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.setAuthError('请输入正确的邮箱地址');
      return;
    }
    if (!password || password.length < 6) {
      this.setAuthError('密码至少需要 6 位');
      return;
    }

    this.setAuthError('');
    this.setAuthBusy(true);

    try {
      await this.signIn(email, password);
      this.closeAuthModal();
      this.app.showToast('登录成功，正在同步…');
      await this.syncAll('sign-in');
    } catch (error) {
      this.setAuthError(humanizeError(error));
    } finally {
      this.setAuthBusy(false);
    }
  };

  /** 忘记密码：先弹窗收集邮箱，再发重置邮件 */
  CloudSyncEngine.prototype.handleForgotPassword = function () {
    this.openResetModal();
  };

  CloudSyncEngine.prototype.submitPasswordReset = async function () {
    var email = (document.getElementById('cloudResetEmail').value || '').trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.setResetError('请输入正确的邮箱地址');
      return;
    }

    var submit = document.getElementById('cloudResetSubmit');
    if (submit) { submit.disabled = true; submit.textContent = '发送中…'; }
    this.setResetError('');

    try {
      await this.sendPasswordReset(email);
      this.closeResetModal();
      this.app.showToast('重置密码邮件已发送，请查收邮箱');
    } catch (error) {
      this.setResetError(humanizeError(error));
    } finally {
      if (submit) { submit.disabled = false; submit.textContent = '发送重置邮件'; }
    }
  };

  // ---------------------------------------------------------------- 界面渲染

  CloudSyncEngine.prototype.setStatus = function (status, detail) {
    this.status = status;
    if (detail !== undefined) this.statusDetail = detail;
    this.renderUi();
  };

  /** 把当前状态画到设置页区块与顶部徽标上 */
  CloudSyncEngine.prototype.renderUi = function () {
    var $ = function (id) { return document.getElementById(id); };
    if (!$('cloudSection')) return;

    // sdkReady 为 false 表示 CDN 没加载成功：此时即便填了配置也连不上，
    // 同样走「未启用 + 原因说明」的引导界面，而不是给一个点了没反应的登录按钮
    var configured = Boolean(CONFIGURED) && this.sdkReady !== false;
    var missing = $('cloudConfigMissing');
    var signedOut = $('cloudSignedOut');
    var signedIn = $('cloudSignedIn');
    var badge = $('cloudBadge');
    var stateTag = $('cloudStateTag');

    /** 统一的徽标 / 角标绘制：徽标始终可见，点击都能跳到设置页 */
    var paintBadge = function (state, label, title) {
      if (badge) {
        badge.setAttribute('data-state', state);
        badge.setAttribute('title', title || label);
        var badgeText = $('cloudBadgeText');
        if (badgeText) badgeText.textContent = label;
      }
      if (stateTag) {
        stateTag.textContent = label;
        stateTag.className = 'cloud-state-tag' + (state === 'synced' ? ' is-on' : '');
      }
    };

    // 情况一：没配置 Supabase。
    // 注意这里不显示登录入口——没填 url/anonKey 时登录必然失败，
    // 显示按钮只会让人以为功能坏了。改为给出明确的三步开启引导。
    if (!configured) {
      if (missing) missing.style.display = '';
      if (signedOut) signedOut.style.display = 'none';
      if (signedIn) signedIn.style.display = 'none';
      var missingText = $('cloudConfigMissingText');
      if (missingText) {
        missingText.textContent = this.statusDetail
          ? '云同步还没有启用（' + this.statusDetail + '）'
          : '云同步还没有启用';
      }
      paintBadge('disabled', '未启用', this.statusDetail || '云同步未启用，点击查看开启方法');
      return;
    }
    if (missing) missing.style.display = 'none';

    var loggedIn = Boolean(this.user);
    if (signedOut) signedOut.style.display = loggedIn ? 'none' : '';
    if (signedIn) signedIn.style.display = loggedIn ? '' : 'none';

    if (!loggedIn) {
      paintBadge('signed-out', '未登录', '尚未登录，点击前往登录');
      return;
    }

    var emailEl = $('cloudUserEmail');
    if (emailEl) emailEl.textContent = this.user.email || '已登录';

    var lastSync = $('cloudLastSyncText');
    if (lastSync) {
      lastSync.textContent = this.meta.lastSyncAt
        ? '上次同步：' + new Date(this.meta.lastSyncAt).toLocaleString('zh-CN', { hour12: false })
        : '尚未同步过';
    }

    var autoToggle = $('cloudAutoSyncToggle');
    if (autoToggle) autoToggle.classList.toggle('active', this.isAutoSyncOn());

    var syncBtn = $('cloudSyncNowBtn');
    if (syncBtn) {
      syncBtn.disabled = this.status === 'syncing';
      syncBtn.textContent = this.status === 'syncing' ? '同步中…' : '同步';
    }

    // 顶部徽标：已登录时反映真实同步状态
    var label = '已同步';
    if (this.status === 'syncing') label = '同步中';
    else if (this.status === 'offline') label = '离线';
    else if (this.status === 'error') label = '同步异常';
    else if (this.status === 'idle') label = '待同步';
    paintBadge(this.status, label, this.statusDetail || label);
  };

  // ==================== 对外暴露单例 ====================
  global.CloudSync = new CloudSyncEngine();

  // 便于在控制台调试：CloudSyncDebug.makeDictKey(app.todayWords[0])
  global.CloudSyncDebug = {
    makeDictKey: makeDictKey,
    parseDictKey: parseDictKey,
    makeTextKey: makeTextKey,
    normalizeSupabaseUrl: normalizeSupabaseUrl,
    withTimeout: withTimeout,
    rowFromWord: function (word) { return global.CloudSync.rowFromWord(word); },
    stableStringify: stableStringify,
    humanizeError: humanizeError
  };
})(window);
