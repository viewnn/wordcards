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
  /**
   * 切回前台/窗口重新获得焦点时的最小拉取间隔（毫秒）。
   * 刻意取小值：「打开就能看到最新数据」比省这点请求重要；
   * 同一秒内的连续 focus/visibility 抖动仍会被挡掉。
   */
  var FOCUS_PULL_MIN_INTERVAL_MS = 5 * 1000;
  /**
   * 距上次「全量同步」超过该时长时，回到前台直接做一次全量双向同步。
   * 增量拉取虽然轻，但依赖游标；全量能顺带把设置、今日会话、练习进度一起对齐，
   * 是「多端最终一致」的兜底。
   */
  var RESUME_FULL_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;
  /**
   * 应用停留前台时，多久自动检查一次云端更新（毫秒）。
   * 用来覆盖「另一台设备一直开着不动」的场景——只靠切前台触发的话，
   * 电脑开着不切换标签页就永远看不到手机上的新进度。
   * 用的是增量拉取，没有变化时服务端只返回空数组，开销很小。
   */
  var AUTO_PULL_INTERVAL_MS = 60 * 1000;
  /** 同步失败后自动重试：最大次数与首次延迟（退避：5s → 10s → 20s → 40s → 60s） */
  var RETRY_MAX_TIMES = 5;
  var RETRY_BASE_DELAY_MS = 5000;
  /**
   * 逻辑时间戳允许超前当前时间的上限（毫秒）。
   * 超过它的时间戳一律视为「历史脏数据」（早期版本时钟异常 / 偏移算错留下的）：
   * 这种戳会让这台设备在冲突判定里永远赢，从而**再也接收不到另一台设备的学习记录**
   * （现象：另一端学到 45/100，这边刷新多少次都是 0/100）。
   */
  var STAMP_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
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
    'phoneticAutoRead',
    // 练习页的范围与调值开关：两端不一致时进度条的分母、题目难度都不同，
    // 用户会以为是「练习数据没同步」，所以一起同步
    'practiceScope',
    'practiceToneMode',
    // 练习页的练习进度（按 字/短语 记录的已完成词条标识）：云端按并集合并，见 applyRemoteSettings
    'practiceProgress'
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
   * 练习进度的合并：按「字 / 短语」分别取并集（不是覆盖）。
   *
   * 设置整体是 LWW（较晚一次生效）同步的，但练习进度是逐题累加出来的：
   * 如果也按覆盖处理，两台设备各自练过的词条会互相抹掉。
   * 取并集后，客户端发现「本地与云端不同」会把合并结果再推回云端，
   * 于是多台设备的练习进度能持续累加。
   *
   * 列表元素是 practiceDictKey()（分类|词汇|音标）—— 跨设备稳定。
   * 早期版本的列表元素是 IndexedDB 自增 id，换设备必然错位，这里直接忽略
   * （客户端会先把旧 id 迁移成 dict_key 再上行，见 app.js 的 migratePracticeProgressIds）。
   */
  function mergePracticeProgress(local, remote) {
    var out = {};
    var keys = ['word', 'phrase'];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var seen = new Set();
      var lists = [local && local[key], remote && remote[key]];
      for (var l = 0; l < lists.length; l++) {
        var list = Array.isArray(lists[l]) ? lists[l] : [];
        for (var n = 0; n < list.length; n++) {
          var raw = list[n];
          if (raw === null || raw === undefined) continue;
          var text = String(raw).trim();
          if (!text) continue;
          if (/^\d+$/.test(text)) continue; // 旧版的本地词条 id：没有跨设备意义
          seen.add(text);
        }
      }
      // 排序：保证两侧合并出的 JSON 完全一致，避免每次都误判为「有变化」而反复上传。
      // 必须与 app.js 的 savePracticeProgress() 用同一种排序（默认字典序）
      out[key] = Array.from(seen).sort();
    }
    return out;
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
      return '连接 Supabase 超时，请检查网络后重试！';
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
      /** 上次「全量双向同步」完成的时间：resumeSync 用它决定回到前台走全量还是增量 */
      lastFullSyncAt: 0,
      lastPullCursor: null,
      lastPushedSettingsJson: '',
      lastPushedSessionJson: '',
      progressResetAt: 0,
      lastUserId: null,
      /**
       * 与服务端的时钟偏移估计（毫秒）：本地时间 + 该值 ≈ 服务端时间。
       * 冲突判定用的是客户端逻辑时间戳，如果两台设备的系统时间有偏差
       * （手机和电脑差几十秒很常见），较慢的那台怎么操作都赢不了，
       * 于是「两边都显示已同步，内容却不一样」。这里用服务端回传的时间校准。
       * null 表示还没观测到；取最近若干次观测里最大的一个（网络抖动只会让观测偏低）。
       */
      serverOffsetMs: null,
      /** 最近几次的时钟偏移观测（滑动窗口，避免单次异常值长期生效） */
      serverOffsetSamples: [],
      /** 本机最近生成过的逻辑时间戳：保证时间戳单调递增，改系统时间也不会倒退 */
      lastStamp: 0,
      /** 设置 / 会话各自的客户端逻辑时间戳（LWW 判定依据，越大越新） */
      settingsUpdatedAt: 0,
      sessionUpdatedAt: 0
    };

    /** 本地词条索引，同步过程中反复用到，重建一次即可 */
    this._localByKey = null;
    this._localByText = null;

    /** 抑制标志：为 true 时本地写入不再打脏标记（防止把云端数据又推回去） */
    this._suppress = false;

    /** 本机最近一次改动设置 / 今日会话的时刻（内存）：避免本地刚改的内容被云端旧版本覆盖 */
    this._localSettingsTouchedAt = 0;
    this._localSessionTouchedAt = 0;

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

    var session = await this.readSessionOnce();

    if (!session || !session.user) {
      // token 正在后台刷新时，getSession 可能**短暂**返回空。若在这里直接判成「未登录」，
      // 用户看到的就是「第一次打开停在旧数据 / 不显示已登录，刷新一次才正常」。
      // 稍等一下再取一次，能挡掉大部分这类时序问题。
      await new Promise(function (resolve) { setTimeout(resolve, 800); });
      session = await this.readSessionOnce();
    }

    if (!session || !session.user) {
      this.user = null;
      this.setStatus('signed-out', '未登录');
      return;
    }

    this.user = session.user;
    this.setStatus('idle', '等待同步');
    await this.syncAll('bootstrap');
  };

  /**
   * 取一次登录会话：先 getSession，取不到再显式 refreshSession 兜底
   * （access token 过期但 refresh token 还有效时，能免去重新输密码）。
   */
  CloudSyncEngine.prototype.readSessionOnce = async function () {
    var result = await this.client.auth.getSession().catch(function () {
      // getSession 本身也可能因网络异常抛错：当作「暂时取不到」，走下面的刷新兜底
      return null;
    });
    var session = result && result.data ? result.data.session : null;
    if (session && session.user) return session;

    try {
      var refreshed = await withTimeout(this.client.auth.refreshSession(), AUTH_TIMEOUT_MS, 'TIMEOUT');
      return refreshed && refreshed.data ? refreshed.data.session : null;
    } catch (error) {
      return null;
    }
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
      // 时间戳与重置信号也要归零：每个账号的云端版本是独立的一套，
      // 沿用上一个账号的时间戳会让「云端是否更新」的判断全部失效
      this.meta.settingsUpdatedAt = 0;
      this.meta.sessionUpdatedAt = 0;
      this.meta.progressResetAt = 0;
      this.meta.lastStamp = 0;
      // 内存里的「本机刚改过」时间也要清：否则会把上一个账号的设置/会话
      // 当成「比新账号云端更新」而推上去，污染新账号
      this._localSettingsTouchedAt = 0;
      this._localSessionTouchedAt = 0;
    }

    this.renderUi();

    if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || switchedUser) {
      if (this.meta.lastUserId !== user.id) {
        this.meta.lastUserId = user.id;
        this.saveMeta().catch(function () {});
      }
      this.syncAll(event === 'SIGNED_IN' ? 'sign-in' : 'session-restore').catch(function () {});
      return;
    }

    // token 自动续期成功（长时间挂后台后很常见）：顺手确认一次云端是否有更新，
    // 这样「手机放了一晚再打开」也能立刻拿到电脑端最新的学习记录
    if (event === 'TOKEN_REFRESHED') {
      this.resumeSync('token-refreshed').catch(function () {});
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

    // 页面切到后台：立刻把待上行的改动推出去，避免「手机锁屏后这边的学习记录没上传」
    document.addEventListener('visibilitychange', function () {
      if (!self.isActive()) return;
      if (document.visibilityState === 'hidden') {
        // 关掉「自动同步」后不做任何自动上传（与设置页的说明一致）
        if (!self.isAutoSyncOn()) return;
        self.flushDirty().catch(function () {});
        return;
      }
      // 切回前台：先补传本机改动，再拉取云端更新（详见 resumeSync）
      self.resumeSync('visible').catch(function () {});
    });

    // 桌面端切到别的窗口再切回来（只切窗口、标签页一直可见时不会触发 visibilitychange）
    global.addEventListener('focus', function () {
      if (!self.isActive()) return;
      if (document.visibilityState === 'hidden') return;
      self.resumeSync('focus').catch(function () {});
    });

    // 窗口 load 之后再补一次同步：兜住「attach 那一刻网络 / 登录态 / 本地库还没完全就绪」
    // 的情况，避免第一次打开停在旧数据上、要再刷新一次才同步过来。
    // 与启动时的 bootstrap 同步共用同一个 Promise，不会重复请求。
    var kickAfterLoad = function () {
      if (!self.isActive()) return;
      self.resumeSync('window-load').catch(function () {});
    };
    if (document.readyState === 'complete') {
      setTimeout(kickAfterLoad, 0);
    } else {
      global.addEventListener('load', kickAfterLoad);
    }

    // 应用一直停在前台时的兜底轮询。浏览器在后台会把定时器节流到分钟级，
    // 所以这里再显式判断一次可见性，避免在后台空跑。
    if (this._pullTimer) clearInterval(this._pullTimer);
    this._pullTimer = setInterval(function () {
      if (document.visibilityState !== 'visible') return;
      if (!self.isActive() || !self.isAutoSyncOn()) return;
      if (self._syncPromise || self._pullPromise) return; // 已有同步在跑，别叠加
      self.pullAndMerge().catch(function () {});
    }, AUTO_PULL_INTERVAL_MS);
  };

  /**
   * 「打开 / 切回前台」时的同步入口 —— 这是多端一致性的主要保障。
   *
   *   1) 先把本机待上传的改动推出去（不然云端的旧记录可能先落地，让人以为没同步）；
   *   2) 距上次**全量**同步超过 RESUME_FULL_SYNC_MIN_INTERVAL_MS（或从未同步过）
   *      → 走一次全量双向同步：学习记录、设置、今日会话、练习进度一起收敛；
   *   3) 否则走轻量增量拉取（节流 5 秒），频繁切换窗口时不会反复请求。
   *
   * 之所以不是每次都全量：几千条记录的全量拉取在弱网下要几秒；
   * 而增量 + 5 分钟一次全量兜底，既快又能保证最终一致。
   */
  CloudSyncEngine.prototype.resumeSync = async function (reason) {
    if (!this.isActive()) return false;
    if (!this.isAutoSyncOn()) return false;

    try {
      await this.flushDirty();
    } catch (error) {
      // 上传失败不影响下面拉取云端最新数据
      console.warn('[cloud-sync] 回到前台时上传失败，继续拉取云端:', error);
    }

    var now = Date.now();
    var lastFullSync = toNumber(this.meta.lastFullSyncAt, 0);
    if (!lastFullSync || now - lastFullSync > RESUME_FULL_SYNC_MIN_INTERVAL_MS) {
      return this.syncAll(reason || 'resume');
    }
    if (now - toNumber(this.meta.lastPullAt, 0) < FOCUS_PULL_MIN_INTERVAL_MS) {
      return false; // 刚刚拉过，别重复请求
    }
    return this.pullAndMerge();
  };

  /**
   * 同步失败后的自动重试（指数退避：5s → 10s → 20s → 40s → 60s，最多 5 次）。
   *
   * 没有它的话，打开应用那一刻网络恰好不通（手机刚联网、隧道里、Supabase 抖动）就会
   * 停在「同步异常」上，用户得手动点同步 —— 而这正是「打开另一端却看不到最新数据」的常见原因。
   * 离线时不排重试，交给 online 事件。
   */
  CloudSyncEngine.prototype.scheduleSyncRetry = function () {
    if (!this.isActive() || !this.isAutoSyncOn()) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

    this._retryCount = (this._retryCount || 0) + 1;
    if (this._retryCount > RETRY_MAX_TIMES) return;

    var delay = Math.min(60000, RETRY_BASE_DELAY_MS * Math.pow(2, this._retryCount - 1));
    var self = this;
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(function () {
      self._retryTimer = null;
      self.syncAll('retry').catch(function () {});
    }, delay);
    console.info('[cloud-sync] 同步失败，' + Math.round(delay / 1000) + ' 秒后自动重试（第 ' + this._retryCount + ' 次）');
  };

  /** 同步成功：清掉重试计数与待重试定时器 */
  CloudSyncEngine.prototype.clearSyncRetry = function () {
    this._retryCount = 0;
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
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

  // ---------------------------------------------------------------- 逻辑时间戳

  /**
   * 生成客户端逻辑时间戳（毫秒），它就是上行时的 client_updated_at：
   *   1) 以服务端时间为基准（本地时间 + 观测到的偏移）：两台设备系统时间有偏差时，
   *      冲突判定才不会变成「时钟快的那台永远赢」；
   *   2) 保证单调递增：同一毫秒内连续操作、或系统时间被回拨，都不会生成更小的时间戳。
   */
  CloudSyncEngine.prototype.nextStamp = function () {
    var offset = toNumber(this.meta.serverOffsetMs, 0);
    var t = Date.now() + offset;
    var last = toNumber(this.meta.lastStamp, 0);
    if (!Number.isFinite(t) || t <= last) t = last + 1;
    this.meta.lastStamp = t;
    return t;
  };

  /**
   * 当前时间（毫秒），已按服务端时钟校准。app.js 写词条 lastStudied 时用它，
   * 这样「今天学过没有」的判断与冲突判定用的是同一时间基准。
   * 未登录 / 未配置时就是本机时间。
   */
  CloudSyncEngine.prototype.nowMs = function () {
    if (!this.isActive()) return Date.now();
    return Date.now() + toNumber(this.meta.serverOffsetMs, 0);
  };

  /**
   * 用服务端回传的时间（word_progress.updated_at，服务端 now()）校准本机时钟偏移。
   *
   * 观测值 = 服务端写入时刻 − 本地收到响应的时刻 = 真实偏移 − 下行耗时，
   * 所以观测只会偏低；取最近几次观测里最大的一个最接近真值
   * （结果可能为负，表示本地时钟偏快）。
   */
  CloudSyncEngine.prototype.observeServerTime = function (serverTimeMs) {
    var server = toNumber(serverTimeMs, 0);
    if (!server) return;
    var observed = server - Date.now();
    // 超过 30 分钟的偏差说明本机系统时间本身有问题（不是普通漂移）。
    // 这种时候宁可不校准：日界判断与 lastStudied 都用同一个基准，
    // 强行校准反而会让「今天」的边界跟用户看到的墙上时钟错开。
    if (!Number.isFinite(observed) || Math.abs(observed) > 30 * 60 * 1000) return;

    // 滑动窗口取最大值：观测值只会因网络耗时偏低，取大的更接近真值；
    // 用窗口而不是单个累计值，是为了让一次异常观测在几次之后自动失效
    var samples = Array.isArray(this.meta.serverOffsetSamples)
      ? this.meta.serverOffsetSamples.slice(-4)
      : [];
    samples.push(observed);
    this.meta.serverOffsetSamples = samples;

    var best = samples[0];
    for (var i = 1; i < samples.length; i++) {
      if (samples[i] > best) best = samples[i];
    }
    this.meta.serverOffsetMs = best;
  };

  /**
   * 用本机已有数据给逻辑时间戳「打底」：取所有词条 syncUpdatedAt / lastStudied 的最大值。
   *
   * 用途：升级到「服务端校准时钟」后，本机历史时间戳可能比校准后的时间戳更大
   * （例如本机时钟本来就快）。若不做这一步，本机的新操作会生成更小的时间戳，
   * 被自己历史推上去的云端旧记录挡住 —— 表现就是「刚点的操作没生效、状态被回滚」。
   *
   * 顺带做一次**脏数据修复**：明显超前当前时间的 syncUpdatedAt（见
   * STAMP_FUTURE_TOLERANCE_MS）会被拉回该词条真实的学习时间。
   * 这类戳的危害是「这台设备永远赢」，从而再也接收不到另一台设备的学习记录 ——
   * 用户看到的就是「电脑端 45/100，手机端怎么刷新都是 0/100」。
   */
  CloudSyncEngine.prototype.seedLastStampFromLocal = async function () {
    var words = await this.app.db.getAllWords();
    var nowAligned = Date.now() + toNumber(this.meta.serverOffsetMs, 0);
    var maxStamp = 0;
    var fixed = [];

    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      var stamp = toNumber(w.syncUpdatedAt, 0);
      if (stamp > nowAligned + STAMP_FUTURE_TOLERANCE_MS) {
        w.syncUpdatedAt = toNumber(w.lastStudied, 0);
        fixed.push(w);
        stamp = w.syncUpdatedAt;
      }
      var s = Math.max(stamp, toNumber(w.lastStudied, 0));
      if (s > maxStamp) maxStamp = s;
    }

    if (fixed.length > 0) {
      try {
        await this.bulkWriteWords(fixed);
        console.info('[cloud-sync] 已修正 ' + fixed.length + ' 条超前异常的同步时间戳，之后即可正常接收云端记录');
      } catch (error) {
        console.warn('[cloud-sync] 修正异常时间戳失败:', error);
      }
    }

    // 元数据里的 lastStamp 也要拉回合理范围，否则接下来生成的时间戳会继续「未来」
    if (toNumber(this.meta.lastStamp, 0) > nowAligned + STAMP_FUTURE_TOLERANCE_MS) {
      this.meta.lastStamp = 0;
    }
    if (maxStamp > toNumber(this.meta.lastStamp, 0)) {
      this.meta.lastStamp = maxStamp;
      await this.saveMeta();
    }
    return maxStamp;
  };

  // ---------------------------------------------------------------- 本地索引

  /**
   * 重建「dict_key → 词条[]」与「分类+文本 → 词条[]」两张索引表。
   *
   * 用数组而不是单个词条：词典里可能存在「分类 + 词汇 + 音标」完全相同的多条词条
   * （同音同字但释义不同的义项）。原先只留最后一条，云端那一行就只会写到其中一条上，
   * 两台设备各自写中的是「不同的一条」时，看起来就是「都显示已同步、内容却不同」。
   * 现在同 key 的整组一起更新，两端必然一致。
   */
  CloudSyncEngine.prototype.rebuildLocalIndex = async function () {
    var words = await this.app.db.getAllWords();
    var byKey = new Map();
    var byText = new Map();

    for (var i = 0; i < words.length; i++) {
      var word = words[i];
      var key = makeDictKey(word);
      if (!key) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(word);

      var textKey = makeTextKey(scopeOf(word), word.word);
      if (!byText.has(textKey)) byText.set(textKey, []);
      byText.get(textKey).push(word);
    }

    this._localByKey = byKey;
    this._localByText = byText;
    return { byKey: byKey, byText: byText, total: words.length };
  };

  /**
   * 按 dict_key 找本地词条（同 key 的多条全部返回）。
   * 精确匹配失败时退化成「分类 + 文本」匹配——词典更新时音标可能被纠正，
   * 此时 dict_key 会变，但学习记录不该丢。只有当该文本在本地唯一时才敢回退，
   * 多读音字这种「同文本多条」的情况宁可放弃，也不错配。
   */
  CloudSyncEngine.prototype.resolveLocalWords = function (dictKey) {
    if (!this._localByKey) return [];
    var hit = this._localByKey.get(dictKey);
    if (hit && hit.length > 0) return hit;

    var parsed = parseDictKey(dictKey);
    if (!parsed) return [];
    var list = this._localByText ? this._localByText.get(makeTextKey(parsed.scope, parsed.text)) : null;
    if (list && list.length === 1) return list;
    return [];
  };

  /** 按 dict_key 找本地词条（取第一条，供今日会话恢复等「一个词条就够」的场景使用） */
  CloudSyncEngine.prototype.resolveLocalWord = function (dictKey) {
    var list = this.resolveLocalWords(dictKey);
    return list.length > 0 ? list[0] : null;
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

    // 改动时间：优先用写入时打的时间戳，老数据退化成学习时间。
    // 明显超前当前时间的戳按脏数据处理（见 STAMP_FUTURE_TOLERANCE_MS）：
    // 忽略它，避免本机拿一个「未来」的版本号永远压住另一台设备的真实记录 ——
    // 那会导致这边再也同步不到对方的进度（一直显示 0/100）。
    var nowAligned = Date.now() + toNumber(this.meta.serverOffsetMs, 0);
    var stamp = toNumber(word.syncUpdatedAt, 0);
    if (stamp > nowAligned + STAMP_FUTURE_TOLERANCE_MS) stamp = 0;
    var clientUpdatedAt = Math.max(stamp, lastStudied || 0);

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
      if (!row) continue;
      // 同 dict_key 的多条词条（同音同字的义项）会拼出同一行：保留时间戳更大的那条。
      // 否则「云端是否更新」的判定会随遍历顺序忽大忽小，时间戳小的会把大的盖掉，
      // 导致本机明明有更新的记录却不被推上去。
      var prev = map.get(row.dict_key);
      if (!prev || toNumber(row.client_updated_at, 0) >= toNumber(prev.client_updated_at, 0)) {
        map.set(row.dict_key, row);
      }
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

    // 本机对这个词条的改动必须比它已有的记录更新：否则会被自己历史推上去的云端值挡住，
    // 用户看到的就是「点了掌握，刷新后又被改回去」
    var previous = Math.max(toNumber(word.syncUpdatedAt, 0), toNumber(word.lastStudied, 0));
    var stamp = this.nextStamp();
    if (stamp <= previous) {
      stamp = previous + 1;
      if (stamp > toNumber(this.meta.lastStamp, 0)) this.meta.lastStamp = stamp;
    }
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
    if (SYNCED_SETTING_KEYS.indexOf(key) >= 0) {
      // 记下「本机刚刚改过设置」的时刻：同步时用它和云端时间戳比较，
      // 免得本机刚改的设置被云端的旧版本盖掉（这是「两端设置各显示各的」的另一个来源）
      this._localSettingsTouchedAt = this.nowMs();
      this.schedulePush();
      return;
    }
    if (key === 'learnProgress') {
      this._localSessionTouchedAt = this.nowMs();
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

    // 回传行的 updated_at 是服务端 now()（刚刚写入的时刻）→ 用它校准本机时钟偏移
    var latestServerTime = 0;
    for (var j = 0; j < accepted.length; j++) {
      var row = accepted[j];
      if (!row || !row.updated_at) continue;
      var t = new Date(row.updated_at).getTime();
      if (Number.isFinite(t) && t > latestServerTime) latestServerTime = t;
    }
    if (latestServerTime) this.observeServerTime(latestServerTime);

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

  /**
   * 全量拉取云端学习记录。
   *
   * 分页用主键 dict_key 而不是 client_updated_at + offset：
   * offset 分页在「拉取过程中云端又被另一台设备写入」时会错位（重复或漏行），
   * 按主键游标翻页则不会漏 —— 最多把一个词条拉两次，而合并是幂等的。
   */
  CloudSyncEngine.prototype.fetchAllProgress = async function () {
    var all = [];
    var cursor = null;

    for (var page = 0; page < MAX_PULL_PAGES; page++) {
      var query = this.client
        .from('word_progress')
        .select('dict_key,status,favorite,last_studied,review_count,client_updated_at,updated_at')
        .eq('user_id', this.user.id)
        .order('dict_key', { ascending: true })
        .limit(PULL_PAGE_SIZE);
      if (cursor !== null) query = query.gt('dict_key', cursor);

      var result = await withTimeout(query, REQUEST_TIMEOUT_MS, 'TIMEOUT');
      if (result.error) throw result.error;

      var data = result.data || [];
      all = all.concat(data);
      if (data.length < PULL_PAGE_SIZE) break;
      cursor = data[data.length - 1].dict_key;
      if (!cursor) break;
    }
    return all;
  };

  /**
   * 增量拉取：只取服务端 updated_at 不早于游标的行。
   *
   * 必须循环翻页：一次学习会话加上另一台设备的改动完全可能超过一页，
   * 旧实现只拉一页却把游标推到「本页最后一行」，剩下的行就再也拉不回来了。
   * 用 gte 而不是 gt：同一批 RPC 写入的行 updated_at 相同，gt 会漏掉同批的其余行；
   * gte 只会重复拉取，而合并是幂等的。
   */
  CloudSyncEngine.prototype.fetchProgressSince = async function (cursor) {
    if (!cursor) return this.fetchAllProgress();

    var all = [];
    var since = cursor;

    for (var page = 0; page < MAX_PULL_PAGES; page++) {
      var result = await withTimeout(
        this.client
          .from('word_progress')
          .select('dict_key,status,favorite,last_studied,review_count,client_updated_at,updated_at')
          .eq('user_id', this.user.id)
          .gte('updated_at', since)
          .order('updated_at', { ascending: true })
          .order('dict_key', { ascending: true })
          .limit(PULL_PAGE_SIZE),
        REQUEST_TIMEOUT_MS,
        'TIMEOUT'
      );

      if (result.error) throw result.error;
      var data = result.data || [];
      all = all.concat(data);
      if (data.length < PULL_PAGE_SIZE) break;

      // 下一页从「本页最后一行的服务端时间」继续；同一时间戳的行会被再拉一次（幂等），
      // 因此不会漏掉与最后一行同批写入的其它词条
      var lastUpdatedAt = data[data.length - 1].updated_at;
      if (!lastUpdatedAt || lastUpdatedAt === since) break; // 防死循环
      since = lastUpdatedAt;
    }
    return all;
  };

  /**
   * 把云端行写入本地词条。
   * 只写「真的不一样」的，尽量少触发 IndexedDB 写入。
   * 返回实际改动的条数。
   */
  CloudSyncEngine.prototype.applyRowsLocally = async function (rows) {
    var changedWords = [];
    var pending = [];
    var corrections = 0;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      // 同 dict_key 的多条词条（同音同字的不同义项）一起写，避免两台设备各自只更新其中一条
      var group = this.resolveLocalWords(row.dict_key);
      if (group.length === 0) continue; // 本地没有这个词条（词典版本不同），跳过

      var status = row.status === 'mastered' || row.status === 'review' ? row.status : 'new';
      var favorite = Boolean(row.favorite);
      var lastStudied = row.last_studied == null ? null : toNumber(row.last_studied, null);
      var clientUpdatedAt = toNumber(row.client_updated_at, 0);

      for (var g = 0; g < group.length; g++) {
        var word = group[g];
        var statusChanged = (word.status || 'new') !== status;
        var favoriteChanged = Boolean(word.favorite) !== favorite;
        var timeChanged =
          lastStudied !== null && toNumber(word.lastStudied, 0) !== lastStudied;
        var stampChanged = toNumber(word.syncUpdatedAt, 0) < clientUpdatedAt;

        // 状态与收藏都一致、只有学习时间不同时，保留较晚的那个。
        //
        // 「学习时间倒退」几乎总是另一端用旧记录覆盖了新记录（例如词典更新时误盖了时间戳），
        // 而真正的「清除记录」会同时把状态改回 new，不会被这里挡住；
        // 不做这个保护的话，就会出现「手机上学到 12/100，重新打开变回 0/100」。
        if (!statusChanged && !favoriteChanged && timeChanged &&
            toNumber(word.lastStudied, 0) > toNumber(lastStudied, 0)) {
          timeChanged = false;
          // 本机保留的是更新的一份：把它重新推回云端纠正那一行。
          // 否则云端会一直停在旧的学习时间，另一台设备（以及以后重装的设备）
          // 都拿不到这份今天的学习记录，表现就是「那边永远 0/100」。
          var nowAligned = Date.now() + toNumber(this.meta.serverOffsetMs, 0);
          var cloudStampIsDirty = clientUpdatedAt > nowAligned + STAMP_FUTURE_TOLERANCE_MS;
          var cloudStampTooFar = clientUpdatedAt > nowAligned + 24 * 60 * 60 * 1000;
          var newStamp = this.nextStamp();
          // 云端那行带着「未来」的脏时间戳时，必须压过它才推得上去；
          // 但超前超过一天就放弃压过（避免把这个未来时间戳继续放大），
          // 本机仍然靠下面的保护保留正确数据，等真实时间追上即可
          if (cloudStampIsDirty && !cloudStampTooFar) {
            newStamp = Math.max(newStamp, clientUpdatedAt + 1);
          }
          word.syncUpdatedAt = newStamp;
          if (newStamp > toNumber(this.meta.lastStamp, 0)) this.meta.lastStamp = newStamp;
          var corrected = this.rowFromWord(word);
          if (corrected) {
            corrected.client_updated_at = word.syncUpdatedAt;
            this.dirty.set(corrected.dict_key, corrected);
            pending.push(word);
            corrections++;
          }
        }

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
    }

    if (pending.length === 0) return 0;

    await this.bulkWriteWords(pending);
    // 界面上正在背的卡片可能就包含这些词条，把内存里的副本一起更新，
    // 否则卡片上的收藏按钮、状态标签会显示成旧值
    this.syncInMemoryCopies(changedWords);
    // 有需要回推纠正的行时，安排一次上行（全量同步里会立刻推，其它路径走防抖）
    if (corrections > 0) {
      console.info('[cloud-sync] 云端有 ' + corrections + ' 条记录的学习时间比本机旧，已安排回推纠正');
      this.schedulePush();
    }
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

  /** 同步 app 内存中「今日队列 / 会话快照 / 跳过补牌缓存」里对应词条的状态 */
  CloudSyncEngine.prototype.syncInMemoryCopies = function (words) {
    if (!words || words.length === 0) return;
    var byId = new Map();
    for (var i = 0; i < words.length; i++) byId.set(words[i].id, words[i]);

    var lists = [this.app.todayWords];
    if (this.app._learnSessionSnapshot && this.app._learnSessionSnapshot.todayWords) {
      lists.push(this.app._learnSessionSnapshot.todayWords);
    }
    // 「跳过」的补牌候选来自 _scopePoolCache：不同步的话，补进来的词条会带着旧状态，
    // 之后一写库就把刚同步下来的收藏/状态覆盖回旧值
    if (Array.isArray(this.app._scopePoolCache)) {
      lists.push(this.app._scopePoolCache);
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
        list[k].favoriteAt = fresh.favoriteAt;
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

    // 词条状态已被清零，今日统计与进度都要跟着归零。
    // 必须先重算统计再重置进度：resetTodayDoneCount() 是「把本轮起点前移到当前今日词条数」，
    // 若此时 todayStats 还停留在清零前的旧值，起点会被抬到旧统计上，
    // 于是当天进度条长期为 0、每日目标永远达不成
    if (touched.length > 0 && typeof this.app.refreshStatusCounts === 'function') {
      try {
        await this.app.refreshStatusCounts();
      } catch (error) {
        console.warn('[cloud-sync] 重置后重算统计失败:', error);
      }
    }
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
    var rangeChanged = false;
    var goalChanged = false;
    this._suppress = true;
    try {
      for (var i = 0; i < SYNCED_SETTING_KEYS.length; i++) {
        var key = SYNCED_SETTING_KEYS[i];
        if (settings[key] === undefined || settings[key] === null) continue;

        // 练习进度是逐题累加出来的：与本地取并集，而不是像其它设置那样整份覆盖，
        // 否则两台设备各自练过的词条会互相抹掉。合并结果比云端更全时，
        // 调用方（_doSyncAll / flushDirty）会发现「本地与云端不同」并把并集推回云端。
        if (key === 'practiceProgress') {
          var merged = mergePracticeProgress(this.app.settings.practiceProgress, settings[key]);
          if (stableStringify(merged) === stableStringify(this.app.settings.practiceProgress || {})) continue;
          this.app.settings.practiceProgress = merged;
          if (typeof this.app.initPracticeProgress === 'function') this.app.initPracticeProgress();
          await this.app.db.setSetting(key, merged);
          applied++;
          continue;
        }

        if (this.app.settings[key] === settings[key]) continue;
        this.app.settings[key] = settings[key];
        if (key === 'dictImportType') rangeChanged = true;
        if (key === 'dailyGoal') goalChanged = true;
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

      // 云端改过「词典导入」范围或「每日目标」：本地学习队列必须按新设置重建，
      // 否则学习页会继续展示旧范围（如「字」）的卡片，或停在旧目标的进度的完成页上
      if (rangeChanged || goalChanged) {
        try {
          this.app._learnSessionSnapshot = null;
          if (rangeChanged) {
            this.app.todayWords = [];
            this.app.currentCardIndex = 0;
            if (typeof this.app.clearCardDisplay === 'function') this.app.clearCardDisplay();
          }
          if (goalChanged) {
            // 目标换了，「今天已完成过目标」按新目标重新判定
            this.app._todayGoalReachedDate = '';
            await this.app.db.setSetting('todayGoalReached', null);
          }
          await this.app.db.setSetting('learnProgress', null);
          await this.app.prepareLearnSession();
          if (this.app.currentPage === 'library') await this.app.renderLibrary();
        } catch (error) {
          console.warn('[cloud-sync] 应用云端设置后重建学习队列失败:', error);
        }
      }

      // 记下「云端当前是什么」而不是「本地当前是什么」：
      // 练习进度按并集合并后本地可能比云端更全，这份差异必须在下次上行时推回云端，
      // 若在这里记成本地内容，flushDirty 会认为「已推送过」而永远不推，两端就分叉了
      this.meta.lastPushedSettingsJson = stableStringify(settings);
      await this.saveMeta();
    }
    return applied;
  };

  /**
   * 练习进度按并集合并，且**不受设置 LWW 门控**。
   *
   * 设置整体是「时间戳大的赢」，但练习进度是逐题累加出来的、只增不减：
   * 若也走 LWW，本机今天练过几题（本地改动时间更新）之后就再也不会吸收
   * 另一台设备的练习进度，反而把纯本地的进度整份推上去覆盖云端 ——
   * 结果就是两端都显示「已同步」，练习数据却永远不一样。
   * 因此每次同步都无条件把云端的并进来（并集是幂等的、只增不减），
   * 再由调用方按「本地是否比云端更全」决定要不要推回云端。
   */
  CloudSyncEngine.prototype.mergeRemotePracticeProgress = async function (settings) {
    if (!settings || settings.practiceProgress === undefined || settings.practiceProgress === null) return false;

    var local = this.app.settings.practiceProgress;
    var merged = mergePracticeProgress(local, settings.practiceProgress);
    if (stableStringify(merged) === stableStringify(local || {})) return false;

    this._suppress = true;
    try {
      this.app.settings.practiceProgress = merged;
      if (typeof this.app.initPracticeProgress === 'function') this.app.initPracticeProgress();
      await this.app.db.setSetting('practiceProgress', merged);
    } finally {
      this._suppress = false;
    }
    return true;
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
      // 本轮起点：进度条 = 今日已计入统计的词条数 − 本轮起点。
      // 带上它，另一台设备恢复今天的会话后进度条数字才与本机一致
      roundStart: toNumber(this.app._todayRoundStart, 0),
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

    // 本机在云端那份会话之后又改过今日会话（学了几张 / 跳了几张）：本地更新，不恢复云端
    var remoteAt = options ? toNumber(options.remoteUpdatedAt, 0) : 0;
    if (remoteAt > 0 && toNumber(this._localSessionTouchedAt, 0) > remoteAt) {
      var touchedProgress = await this.app.db.getSetting('learnProgress', null);
      if (touchedProgress && touchedProgress.savedAt &&
          new Date(touchedProgress.savedAt).toDateString() === session.date) {
        return false;
      }
    }

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

    // 换设备接着背：进度条 = 今日已计入统计的词条数 − 本轮起点，
    // 把云端会话里的「本轮起点」一并恢复，两台设备的进度条数字才一致。
    // （早期版本这里按「队列下标」补张数，与今日统计口径不一致，会多出 1~2 个）
    //
    // 但只在「本机今天还没开始过新一轮」时采纳远端起点：
    // 起点代表这台设备自己的轮次。一旦本机已经开始了（起点 > 0 或今天已完成过目标），
    // 用另一台设备的起点覆盖会让进度凭空差 1~2 个 —— 典型现象就是
    // 「明明完成了 100/100，重开却变成 99/100」（另一端统计差 1 时它的起点是 101）。
    var localStart = toNumber(this.app._todayRoundStart, 0);
    var localRoundStarted = localStart > 0 || Boolean(this.app._todayGoalReachedDate);
    if (!localRoundStarted && session.roundStart !== undefined && session.roundStart !== null &&
        typeof this.app.setTodayRoundStart === 'function') {
      try {
        await this.app.setTodayRoundStart(session.roundStart);
      } catch (error) {
        console.warn('[cloud-sync] 对齐今日进度起点失败:', error);
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

  /**
   * 调用 push_user_state；只传想改的字段，null 表示不动。
   * 返回服务端**最终**的那一行（可能不是我们刚推上去的版本 —— 见 adoptServerUserState）。
   */
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
   * 采纳服务端返回的用户状态行（设置 / 今日会话）。
   *
   * push_user_state 是**按时间戳条件更新**的：服务端已有更新的版本时，本次上行会被
   * 静默忽略（RPC 不报错，只把云端当前值回传）。旧实现直接假定「我推的就是云端的」，
   * 于是本地记下「已推送」、之后再也不会重推 —— 两台设备都显示「已同步」，
   * 设置 / 今日会话却永远停在两份不同的内容上（典型现象：手机改了每日目标或练习范围，
   * 电脑端数字却对不上）。这里用服务端返回值做最终对齐。
   */
  CloudSyncEngine.prototype.adoptServerUserState = async function (row, options) {
    var result = { settings: false, session: false };
    if (!row) return result;
    var opts = options || {};

    // ---- 设置 ----
    if (!opts.sessionOnly) {
      var remoteSettingsAt = toNumber(row.settings_updated_at, 0);
      // 与全量同步同一个口径：本机刚改过的设置（_localSettingsTouchedAt）也要算进来，
      // 否则这里会绕过「保护本机新改动」的判断，把用户刚改的设置静默还原成云端旧值
      var localSettingsAt = Math.max(
        toNumber(this.meta.settingsUpdatedAt, 0),
        toNumber(this._localSettingsTouchedAt, 0)
      );
      if (row.settings && remoteSettingsAt > localSettingsAt) {
        // 云端更新：应用它（练习进度在里面按并集合并，不会抹掉本机练过的题）
        await this.applyRemoteSettings(row.settings);
        this.meta.settingsUpdatedAt = remoteSettingsAt;
        // 记为「云端内容」：合并出的并集若比云端更全，会在下一次上行时补推
        this.meta.lastPushedSettingsJson = stableStringify(row.settings);
        await this.saveMeta();
        result.settings = true;
      }
    }

    // ---- 今日会话 ----
    if (!opts.settingsOnly) {
      var remoteSessionAt = toNumber(row.session_updated_at, 0);
      var localSessionAt = toNumber(this.meta.sessionUpdatedAt, 0);
      if (remoteSessionAt > localSessionAt) {
        // 记住云端版本：本机后续若还要推送，时间戳必须压过它（本机有新操作时）
        this.meta.sessionUpdatedAt = remoteSessionAt;
        await this.saveMeta();
        result.session = true;
      }
    }

    return result;
  };

  /** 推送设置/会话时使用的时间戳：既保证本机单调递增，也确保压过已知的云端版本 */
  CloudSyncEngine.prototype.nextStateStamp = function (knownServerStamp) {
    var base = Math.max(this.nextStamp(), toNumber(knownServerStamp, 0) + 1);
    this.meta.lastStamp = Math.max(toNumber(this.meta.lastStamp, 0), base);
    return base;
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
    // 本机「从没推送过设置」且「从没同步过」（例如换设备后第一次打开）时，
    // 不要拿本地这份默认/旧设置去推 —— 那会用更新的时间戳把另一台设备刚改的设置覆盖掉。
    // 交给紧随其后的首次全量同步判断方向：云端有就用云端的，云端没有才推本地的。
    var settingsUntouched = !this.meta.lastPushedSettingsJson && !toNumber(this.meta.lastFullSyncAt, 0);
    if (settingsJson !== this.meta.lastPushedSettingsJson && !settingsUntouched) {
      patch.settings = settings;
      patch.settingsUpdatedAt = this.nextStateStamp(this.meta.settingsUpdatedAt);
    }

    var session = await this.collectLocalSession();
    var sessionJson = stableStringify(session);
    if (sessionJson !== this.meta.lastPushedSessionJson) {
      // 只有「本机在已知的云端会话之后又动过今日会话」才推：
      // 否则本机只是打开页面/刷新，就会把另一台设备正在用的队列覆盖掉，
      // 被服务端拒绝时还会每次学习都重复上传同一份
      var localSessionIntent = toNumber(this._localSessionTouchedAt, 0);
      var knownRemoteSessionAt = toNumber(this.meta.sessionUpdatedAt, 0);
      if (session && localSessionIntent > knownRemoteSessionAt) {
        patch.session = session;
        patch.sessionUpdatedAt = this.nextStateStamp(this.meta.sessionUpdatedAt);
      } else {
        // 本机没有更新的意图（或今天还没有会话）：只记下现状，云端那份才是更新的
        this.meta.lastPushedSessionJson = sessionJson;
      }
    }

    if (Object.keys(patch).length === 0) return false;

    var row = await this.pushUserState(patch);
    if (row && row.updated_at) this.observeServerTime(new Date(row.updated_at).getTime());

    // 判断「服务端是否接受了本次推送」用**内容比较**而不是时间戳大小：
    // 时间戳相等时服务端同样不会更新内容（schema.sql 的条件是严格大于），
    // 只比大小会把这种情况误判为「已推送」，本地与云端就此永久分叉
    var settingsAccepted = patch.settings === undefined || !row || stableStringify(row.settings) === settingsJson;
    var sessionAccepted = patch.session === undefined || !row || stableStringify(row.session) === sessionJson;

    if (patch.settings !== undefined && settingsAccepted) {
      this.meta.settingsUpdatedAt = patch.settingsUpdatedAt;
      this.meta.lastPushedSettingsJson = settingsJson;
    }
    if (patch.session !== undefined) {
      if (sessionAccepted) {
        this.meta.sessionUpdatedAt = patch.sessionUpdatedAt;
        this.meta.lastPushedSessionJson = sessionJson;
      } else {
        // 被服务端拒绝：云端那份才是当前版本，记下来（否则每次学习都会重复上传）
        this.meta.sessionUpdatedAt = Math.max(
          toNumber(this.meta.sessionUpdatedAt, 0),
          toNumber(row.session_updated_at, 0)
        );
        this.meta.lastPushedSessionJson = stableStringify(row.session);
      }
    }
    await this.adoptServerUserState(row, {
      settingsOnly: patch.session === undefined,
      sessionOnly: patch.settings === undefined
    });

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
      // 首次同步前给逻辑时间戳打底（只做一次）：取本机所有词条里最大的时间戳，
      // 保证之后生成的 client_updated_at 不会比本机历史上传过的记录更旧
      if (!this._stampSeeded) {
        this._stampSeeded = true;
        try {
          await this.seedLastStampFromLocal();
        } catch (error) {
          console.warn('[cloud-sync] 初始化逻辑时间戳失败（不影响同步）:', error);
        }
      }

      // 1) 用户状态：设置 / 今日会话 / 重置信号
      var state = await this.fetchUserState();

      // 2) 重置信号优先处理，后面的合并才不会被已作废的数据带偏
      await this.applyRemoteReset(state.progress_reset_at);

      // 3) 云端学习记录全量拉取
      var remoteRows = await this.fetchAllProgress();

      // 顺手记下本次看到的服务端最大时间：同步完成后用它推进增量拉取游标，
      // 否则下一次增量会把整份历史重新拉一遍。必须在过滤作废行之前统计
      var maxServerUpdatedAt = 0;
      for (var ri = 0; ri < remoteRows.length; ri++) {
        var rowTime = new Date(remoteRows[ri].updated_at).getTime();
        if (Number.isFinite(rowTime) && rowTime > maxServerUpdatedAt) maxServerUpdatedAt = rowTime;
      }

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

      // 6) 练习进度先无条件并集合并（不受设置 LWW 门控）：
      //    它是逐题累加的，必须无条件吸收云端的，才不会被本机较新的时间戳挡住
      await this.mergeRemotePracticeProgress(state.settings);

      // 6.1) 其它设置：谁的时间戳新听谁的；推上去之后必须核对服务端返回的最终值
      var localSettingsJson = stableStringify(this.collectLocalSettings());
      var remoteSettingsJson = stableStringify(state.settings || {});
      var remoteSettingsAt = toNumber(state.settings_updated_at, 0);
      // 本机设置「最后一次被别人看到」的时间：已推送的时间戳，或本机刚改过的时刻
      var localSettingsIntentAt = Math.max(
        toNumber(this.meta.settingsUpdatedAt, 0),
        toNumber(this._localSettingsTouchedAt, 0)
      );

      // 云端有内容、与本地不同、且时间戳比本机这次改动更新 → 采用云端
      if (remoteSettingsAt > 0 &&
          remoteSettingsJson !== localSettingsJson &&
          remoteSettingsAt > localSettingsIntentAt) {
        await this.applyRemoteSettings(state.settings);
        this.meta.settingsUpdatedAt = remoteSettingsAt;
      }
      // 对齐后若本地与云端仍不同，说明本地这份才是用户最新的意图 → 推上去
      var settingsAfterApply = this.collectLocalSettings();
      if (stableStringify(settingsAfterApply) !== remoteSettingsJson) {
        var settingsStamp = this.nextStateStamp(this.meta.settingsUpdatedAt);
        var settingsRow = await this.pushUserState({
          settings: settingsAfterApply,
          settingsUpdatedAt: settingsStamp
        });
        if (settingsRow && settingsRow.updated_at) {
          this.observeServerTime(new Date(settingsRow.updated_at).getTime());
        }
        // 用内容比较判断服务端是否接受了本次推送（时间戳相等时服务端同样不更新内容）
        var settingsAccepted = !settingsRow ||
          stableStringify(settingsRow.settings) === stableStringify(settingsAfterApply);
        if (settingsAccepted) {
          this.meta.settingsUpdatedAt = settingsStamp;
          this.meta.lastPushedSettingsJson = stableStringify(settingsAfterApply);
        } else {
          // 服务端已有更新的版本（另一台设备刚改过）：以云端为准，别让本地一直分叉
          await this.adoptServerUserState(settingsRow, { settingsOnly: true });
        }
      } else {
        this.meta.lastPushedSettingsJson = stableStringify(settingsAfterApply);
        // 内容一致时也要记下云端版本时间戳，否则本机「已知的云端版本」会长期滞后，
        // 下次容易被更旧的时间戳判定误导
        if (remoteSettingsAt > toNumber(this.meta.settingsUpdatedAt, 0)) {
          this.meta.settingsUpdatedAt = remoteSettingsAt;
        }
      }

      // 7) 今日会话：谁的时间戳新听谁的；本地没有更新就恢复云端的队列
      var remoteSessionAt = toNumber(state.session_updated_at, 0);
      var sessionApplied = await this.applyRemoteSession(state.session, {
        remoteUpdatedAt: remoteSessionAt
      });
      if (sessionApplied) {
        this.meta.sessionUpdatedAt = Math.max(toNumber(this.meta.sessionUpdatedAt, 0), remoteSessionAt);
        await this.saveMeta();
      } else {
        await this.pushStateIfChanged();
      }

      // 8) 刷新界面（统计口径完全由词条状态实时算出，所以同步后必须重算）
      await this.refreshLocalViews(appliedCount > 0);

      // 8.1) 本次合并中发现「云端那份比本机旧」而需要回推纠正的行：立刻推上去，
      //      让云端和以后的设备都能拿到正确（更晚）的学习时间
      if (this.dirty.size > 0) {
        try {
          await this.flushDirty();
        } catch (error) {
          console.warn('[cloud-sync] 回推纠正失败，稍后会自动重试:', error);
        }
      }

      // 增量拉取的游标推进到本次全量看到的最大服务端时间：否则下一次增量
      // 会把整份历史重新拉一遍（几千行），首次同步后又慢又费流量
      if (maxServerUpdatedAt > 0) {
        this.meta.lastPullCursor = new Date(maxServerUpdatedAt).toISOString();
      }

      this.meta.lastSyncAt = Date.now();
      // 单独记「上次全量同步」：resumeSync 用它决定回到前台是全量还是增量，
      // 而 lastSyncAt 会被增量拉取刷新，只能用于界面显示
      this.meta.lastFullSyncAt = Date.now();
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
      this.clearSyncRetry();
      return true;
    } catch (error) {
      var offline = !navigator.onLine || /Failed to fetch|NetworkError|Load failed/i.test(String(error && error.message));
      this.setStatus(offline ? 'offline' : 'error', offline ? '当前离线，联网后会自动同步' : humanizeError(error));
      console.warn('[cloud-sync] 同步失败(' + (reason || 'manual') + '):', error);
      // 打开应用那一刻网络恰好不通时，靠自动重试补上（离线交给 online 事件）
      if (!offline) this.scheduleSyncRetry();
      throw error;
    }
  };

  /**
   * 增量拉取（切回前台 / 前台轮询时用）：只取服务端 updated_at 变化过的行 + 用户状态。
   * 比 syncAll 轻，适合频繁调用。
   *
   * 并发保护：
   *   - 正在全量同步时直接复用它的 Promise（全量本身就包含增量要做的所有事），
   *     避免两个流程同时写本地、互相覆盖；
   *   - 已在增量拉取时复用同一个 Promise，避免轮询与切前台撞在一起。
   */
  CloudSyncEngine.prototype.pullAndMerge = function () {
    if (!this.isActive()) return Promise.resolve(false);
    if (this._syncPromise) return this._syncPromise;
    if (this._pullPromise) return this._pullPromise;

    var self = this;
    this._pullPromise = this._doPullAndMerge().finally(function () {
      self._pullPromise = null;
    });
    return this._pullPromise;
  };

  CloudSyncEngine.prototype._doPullAndMerge = async function () {
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
          // 刻意**不弹轻提示**：另一端改个状态、学几张卡都会走到这里，
          // 每次弹一条会一直打断使用。顶部云徽标已经能说明状态，
          // 需要细节时看徽标或控制台（只有「更新词典」才弹提示）。
          console.info('[cloud-sync] 已从云端更新 ' + changed + ' 条学习记录（不弹提示）');
        } else {
          this.setStatus('synced', '已是最新');
        }

        var last = usable[usable.length - 1] || remoteRows[remoteRows.length - 1];
        if (last && last.updated_at) this.meta.lastPullCursor = last.updated_at;
      } else {
        this.setStatus('synced', '已是最新');
      }

      // 3) 设置与今日会话也可能在别的设备上改过。
      //    练习进度先无条件并集合并（它是逐题累加的，不能走 LWW，见 mergeRemotePracticeProgress）；
      //    其它设置的条件与全量同步一致：只有云端时间戳比「本机已推送 / 刚改动」的时刻更新时才采用，
      //    否则本机刚改的设置会被云端旧值盖掉（两端就会各显示各的）。
      //    注意这里不补推：本机与云端内容不同时，下一次 flushDirty 会把它推上去，
      //    并且那时用的时间戳压得过云端版本。
      await this.mergeRemotePracticeProgress(state.settings);
      var remoteSettingsAt = toNumber(state.settings_updated_at, 0);
      var remoteSettingsJson = stableStringify(state.settings || {});
      var localSettingsIntentAt = Math.max(
        toNumber(this.meta.settingsUpdatedAt, 0),
        toNumber(this._localSettingsTouchedAt, 0)
      );
      if (remoteSettingsAt > 0 &&
          remoteSettingsAt > localSettingsIntentAt &&
          remoteSettingsJson !== stableStringify(this.collectLocalSettings())) {
        await this.applyRemoteSettings(state.settings);
        this.meta.settingsUpdatedAt = remoteSettingsAt;
      }
      var sessionApplied = await this.applyRemoteSession(state.session, {
        strict: true,
        remoteUpdatedAt: toNumber(state.session_updated_at, 0)
      });
      if (sessionApplied) {
        this.meta.sessionUpdatedAt = Math.max(
          toNumber(this.meta.sessionUpdatedAt, 0),
          toNumber(state.session_updated_at, 0)
        );
      }

      this.meta.lastSyncAt = Date.now();
      await this.saveMeta();
      this.clearSyncRetry();
      return true;
    } catch (error) {
      console.warn('[cloud-sync] 增量拉取失败:', error);
      var offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      this.setStatus(offline ? 'offline' : 'error', humanizeError(error));
      // 增量失败同样安排一次退避重试，避免「打开时拉取失败」后再也自动不试
      if (!offline) this.scheduleSyncRetry();
      return false;
    }
  };

  // ---------------------------------------------------------------- 同步诊断

  /**
   * 同步诊断（只在浏览器控制台使用，界面上没有入口）：
   * 把云端学习记录与本机逐条对比，回答「为什么两端的数字不一样」。
   *
   * 结果分三类（每类都带具体词条，能直接定位到是哪个词）：
   *   1) 仅本机有 —— 这些记录没上传成功（未登录时学的、或上次推送失败），点一次「同步」即可补上；
   *   2) 仅云端有 —— 本机词典里没有这个词条。词典（dict.xlsx）本身不参与同步，
   *      两端词条集合不同时，统计只会算本机存在的词条，累计数字必然不同；
   *   3) 状态/时间不同 —— 同一 dict_key 两端不一致，点一次「同步」就会按时间戳收敛。
   *
   * 用法：await CloudSyncDebug.diagnose() / CloudSyncDebug.printDiagnosis(结果)
   */
  CloudSyncEngine.prototype.diagnose = async function () {
    if (!this.isActive()) return null;
    var app = this.app;

    var words = await app.db.getAllWords();
    var localByKey = new Map();
    for (var i = 0; i < words.length; i++) {
      var row = this.rowFromWord(words[i]);
      if (!row) continue;
      var prev = localByKey.get(row.dict_key);
      if (!prev || toNumber(row.client_updated_at, 0) >= toNumber(prev.client_updated_at, 0)) {
        localByKey.set(row.dict_key, row);
      }
    }

    var remoteRows = await this.fetchAllProgress();
    var remoteByKey = new Map();
    for (var j = 0; j < remoteRows.length; j++) remoteByKey.set(remoteRows[j].dict_key, remoteRows[j]);

    var todayKey = typeof app.todayKey === 'function' ? app.todayKey() : new Date().toDateString();
    var describe = function (row) {
      var statusLabel = row.status === 'mastered' ? '已掌握'
        : (row.status === 'review' ? '待复习' : '新词');
      var t = row.last_studied == null ? 0 : toNumber(row.last_studied, 0);
      var when = t
        ? (new Date(t).toDateString() === todayKey ? '今天学过' : new Date(t).toLocaleDateString('zh-CN') + ' 学过')
        : '没有学习时间';
      return statusLabel + ' · ' + when;
    };
    var sameRow = function (l, r) {
      var lStatus = l.status === 'mastered' || l.status === 'review' ? l.status : 'new';
      var rStatus = r.status === 'mastered' || r.status === 'review' ? r.status : 'new';
      return lStatus === rStatus &&
        Boolean(l.favorite) === Boolean(r.favorite) &&
        toNumber(l.last_studied, 0) === toNumber(r.last_studied, 0);
    };

    var onlyLocal = [];
    var onlyRemote = [];
    var differing = [];
    localByKey.forEach(function (l, key) {
      var r = remoteByKey.get(key);
      if (!r) {
        onlyLocal.push({ key: key, local: describe(l) });
        return;
      }
      if (!sameRow(l, r)) differing.push({ key: key, local: describe(l), remote: describe(r) });
    });
    remoteByKey.forEach(function (r, key) {
      if (!localByKey.has(key)) onlyRemote.push({ key: key, remote: describe(r) });
    });

    return {
      local: {
        wordCount: words.length,
        scopedWordCount: words.filter(function (w) { return app.isWordInActiveScope(w); }).length,
        scope: app.settings.dictImportType || 'all',
        today: { mastered: app.todayStats.mastered, review: app.todayStats.review },
        total: { mastered: app.totalStats.mastered, review: app.totalStats.review },
        dictUpdateTime: await app.db.getSetting('dictUpdateTime', null)
      },
      cloud: {
        rows: remoteRows.length,
        usableRows: remoteRows.length - onlyRemote.length
      },
      onlyLocal: onlyLocal,
      onlyRemote: onlyRemote,
      differing: differing
    };
  };

  /** 把诊断结果打到控制台（含「怎么看」的说明） */
  CloudSyncEngine.prototype.printDiagnosis = function (r) {
    if (!r) return;
    var localTotal = r.local.total.mastered + r.local.total.review;
    var lines = [];
    lines.push('==== WordCards 同步诊断 ====');
    lines.push('本机词条：' + r.local.wordCount + '（当前词典范围：' + r.local.scope +
      '，范围内 ' + r.local.scopedWordCount + ' 条）');
    lines.push('本机今天：已掌握 ' + r.local.today.mastered + ' / 待复习 ' + r.local.today.review);
    lines.push('本机累计：已掌握 ' + r.local.total.mastered + ' / 待复习 ' + r.local.total.review +
      '（合计 ' + localTotal + '）');
    lines.push('云端记录：' + r.cloud.rows + ' 行（其中本机词典里能找到的 ' + r.cloud.usableRows + ' 行）');
    lines.push('');
    lines.push('—— 仅本机有（没上传成功）：' + r.onlyLocal.length + ' 条');
    r.onlyLocal.slice(0, 30).forEach(function (x) { lines.push('   ' + x.key + '   ' + x.local); });
    lines.push('—— 仅云端有（本机词典里没有这个词条，通常是两端词典版本不同）：' + r.onlyRemote.length + ' 条');
    r.onlyRemote.slice(0, 30).forEach(function (x) { lines.push('   ' + x.key + '   ' + x.remote); });
    lines.push('—— 状态/时间不一致（点一次「同步」会按较晚的一次收敛）：' + r.differing.length + ' 条');
    r.differing.slice(0, 30).forEach(function (x) {
      lines.push('   ' + x.key + '   本机 ' + x.local + ' / 云端 ' + x.remote);
    });
    if (r.onlyLocal.length > 30 || r.onlyRemote.length > 30 || r.differing.length > 30) {
      lines.push('（清单只显示前 30 条）');
    }
    lines.push('');
    lines.push('【怎么看】');
    lines.push('* 「仅云端有」是两端累计数字不同的主要原因：词典不上云，两端词条集合不同时');
    lines.push('  统计只算本机存在的词条。请在两端确认「词库更新」时间一致（更新词典后各刷新一次页面）。');
    lines.push('* 「仅本机有」点一次「同步」即可补传；「状态/时间不一致」也会在同步后自动收敛。');
    console.log(lines.join('\n'));
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
        // 立刻重建队列的两种情况：
        //   1) 还没开始背（下标为 0）—— 不会打断正在学习的人；
        //   2) 学习页正停在完成页、但按最新统计并没有达标（例如刷新瞬间统计才对齐，
        //      或云端把记录改少了）—— 必须切回学习卡片，否则用户会点到一个
        //      不该出现的【继续学习】，一点就把本轮进度清零。
        var atStart = this.app.currentCardIndex === 0;
        var wrongCompletePage = this.app._learnView === 'complete' &&
          typeof this.app.isDailyGoalReached === 'function' &&
          !this.app.isDailyGoalReached();
        if (this.app.currentPage === 'learn' && (atStart || wrongCompletePage)) {
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
    document.getElementById('cloudAuthHint').textContent = '登录后多台设备将共用同一份学习记录。';

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
          ? '云同步尚未启用（' + this.statusDetail + '）'
          : '云同步尚未启用';
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
    humanizeError: humanizeError,
    /** 同步诊断：对比本机与云端的记录差异。用法：await CloudSyncDebug.diagnose() */
    diagnose: function () { return global.CloudSync.diagnose(); },
    printDiagnosis: function (result) { return global.CloudSync.printDiagnosis(result); }
  };
})(window);
