/**
 * ============================================================
 * WordCards（单词卡片）应用 —— 主逻辑 app.js
 * ============================================================
 * 整个应用由两个类组成：
 *
 * 【1. VocabDB —— 数据层】封装浏览器 IndexedDB，负责数据持久化。
 *   数据库名 VocabAppDB，当前版本 3，含 3 个对象仓库（相当于表）：
 *     - words      词条表（主键为自增 id），并建了 category / status /
 *                  createdAt / favorite / language 等索引便于查询
 *     - categories 分类表（预留）
 *     - settings   设置表，结构为 { key, value } 的键值对
 *
 * 【2. VocabApp —— 应用层】负责全部界面渲染与用户交互，按功能分块：
 *     - 初始化：init() 打开数据库 → 读设置 → 注册 Service Worker →
 *               绑定事件 → 自动导入 dict.xlsx → 加载统计 → 首次渲染
 *     - 学习页：抽词成今日队列(prepareLearnSession) → 渲染卡片(showCard)
 *               → 翻面(flipCard) → 掌握/陌生/跳过(markMastered/markDifficult/skipCard)
 *               → 更新进度条与统计(updateProgress)
 *     - 词库页：搜索、状态筛选（全部/新词/待复习/已掌握/收藏）、
 *               分类多选下拉、按分类分组渲染(renderLibrary)
 *     - 设置页：每日目标、学习模式（随机/顺序）、音标渐显、重复频率、
 *               词典范围等
 *
 * 关键概念：
 *   - dictScope：词条的词典归属，'word'=字、'phrase'=短语。两类词条始终
 *     全量常驻词库；settings.dictImportType（all/word/phrase）只决定
 *     “当前学哪一类、展示哪一类、统计算哪一类”，切换范围不会删词或清记录。
 *   - 学习统计：内部按 字/短语 分别计数（_scopeToday 今日、_scopeTotal 累计），
 *     再按当前展示范围汇总成 todayStats / totalStats 供界面显示；
 *     每天首次打开时会把昨日“今日计数”并入“累计计数”。
 *   - 学习进度：今日队列 todayWords + 当前卡片下标 currentCardIndex。
 *     离开学习页时快照到 _learnSessionSnapshot；同一天刷新页面也会从
 *     settings.learnProgress 恢复，避免进度丢失。
 *
 * 底部导航在四个页面间切换：learn（学习）/ library（词库）/ practice（练习）/ settings（设置）。
 * 页面加载完成后（DOMContentLoaded）创建 VocabApp 实例并调用 init() 启动。
 *
 * 【云同步（可选）】多端同步由独立模块 cloud-sync.js 提供，本文件只保留 4 个
 * 可选钩子（都写成 window.CloudSync?.xxx?.()，未加载该模块时等于不存在）：
 *   - VocabDB.updateWord()      → stampWord()        写库前盖变更时间戳并记入上传队列
 *   - VocabDB.setSetting()      → onSettingWritten() 设置/今日会话写完后触发上传调度
 *   - VocabApp.init() 末尾      → attach(this)       启动同步、恢复登录态、首次合并
 *   - VocabApp.clearProgress()  → onProgressCleared(scopeKeys) 把「按范围清除」同步到其它设备
 * 设计细节见 docs/supabase-sync.md。
 */

// ==================== 卡片滑动过场动画参数 ====================
/** 卡片滑动过场的缓动曲线：起步快、收尾缓，观感干脆 */
const CARD_SWIPE_EASE = 'cubic-bezier(0.25, 0.8, 0.35, 1)';
/** 滑出阶段速度：每滑过一个卡片宽度所需毫秒数，越小越快 */
const PLAY_SPEED_MS_PER_CARD_WIDTH = 900;
/** 滑出阶段时长上限（拖动距离很小时也不会太慢） */
const CARD_EXIT_MAX_MS = 140;
/** 新卡滑入中央所需毫秒数 */
const CARD_ENTRY_MS = 140;
/** 触发切卡的滑动距离阈值（px） */
const CARD_SWIPE_THRESHOLD = 80;
/** 鼠标单击翻面的延迟（ms）：给双击选词留出取消窗口，避免翻面把选中词换成另一面的文字 */
const CARD_CLICK_FLIP_DELAY_MS = 150;
/** 鼠标按住不动多久视为“长按取词”（ms） */
const CARD_MOUSE_LONG_PRESS_MS = 600;
/** 触屏按住多久先把翻面/滑动让给系统取词（ms），略早于浏览器原生长按菜单 */
const CARD_TOUCH_LONG_PRESS_MS = 450;
/** 鼠标按下后位移超过该像素数即视为“拖选文字”，本次点击不再翻面 */
const CARD_TEXT_MOVE_TOLERANCE_PX = 8;
/** 卡片上可长按选中复制的文字块（正反两面共用，配合当前可见面筛选） */
const CARD_TEXT_TILE_SELECTOR =
  '.word, .phonetic, .cantonese-word, .meaning, .example, .cantonese-example';
/** 英文/数字等“词字符”：长按取词时按这类字符的连续段扩成整词 */
const CARD_WORD_CHAR_RE = /[0-9A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF'’_-]/;
/** 中日韩字符：长按取词时按连续段扩成整词（单字也能选中自身） */
const CARD_CJK_CHAR_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/;
/** .card-stack 左右内边距（px），取不到布局时的兜底值 */
const CARD_STACK_GUTTER_PX = 8;
/** 滑出终点在“整张离屏”基础上再越界的像素数，留出取整/圆角余量 */
const CARD_CLEAR_MARGIN_PX = 8;
/** 换卡落点在滑出终点基础上再越界的像素数，确保换内容瞬间卡片本体不可见 */
const CARD_PARK_MARGIN_PX = 30;
/** 新卡入场起点在滑出终点基础上再越界的像素数，0 = 正好接在旧卡离场的位置继续滑入 */
const CARD_FINISH_MARGIN_PX = 0;
/** 收藏心形图标（学习卡两个角落与词库列表共用同一颗心） */
const HEART_ICON_SVG =
  '<svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';

// ==================== 练习页参数 ====================
/**
 * 整条音标全部输入正确后，停留多久自动切换到下一个词（ms）。
 * 留一点时间让用户看到绿色输入框与背面答案，但不要太久影响连续练习。
 */
const PRACTICE_ADVANCE_DELAY_MS = 900;

/**
 * 判定「软键盘已弹出」的最小高度差（px）。
 * 手机软键盘一般 250px 以上，而地址栏伸缩只有几十像素，用这个阈值把两者区分开。
 */
const KEYBOARD_MIN_HEIGHT_PX = 120;

// ==================== 学习范围（设置页 → 学习设置） ====================
/**
 * 学习范围：决定学习页的卡片从哪一类词条中抽取。
 *   all      全部（保持原有逻辑：按重复频率抽词，学完可进入复习轮）
 *   new      新词（status === 'new'）
 *   review   待复习（status === 'review'）
 *   mastered 已掌握（status === 'mastered'）
 *   favorite 收藏（favorite === true）
 * 具体范围一旦学完，学习页显示红字提示并冻结三个操作按钮，进度不归零；
 * 用户切换范围后，今日进度继续沿用（例如 20/100 → 21/100）。
 */
const STUDY_SCOPE_VALUES = ['all', 'new', 'review', 'mastered', 'favorite'];
/**
 * 学习范围完成进度的存储版本。
 * v2 起：学一张卡只记「全部」和“当前正在学习的 tab”，不再顺手记
 * 已掌握/待复习/收藏（否则在「新词」里学习时，这些 tab 会被误判为已学完）。
 */
const SCOPE_PASS_VERSION = 2;
/** 学习范围对应的中文名 */
const STUDY_SCOPE_LABELS = {
  all: '全部',
  new: '新词',
  review: '待复习',
  mastered: '已掌握',
  favorite: '收藏'
};

// ==================== IndexedDB 数据库操作（数据层） ====================
/**
 * 数据层类：对 IndexedDB 的 Promise 化封装。
 * 词条以普通对象存储，主键为自增 id；所有异步方法都返回 Promise。
 */
class VocabDB {
  constructor() {
    this.dbName = 'VocabAppDB'; // 数据库名（固定）
    this.version = 3;           // 数据库版本号；结构变更时 +1 会触发 onupgradeneeded
    this.db = null;             // 打开后的 IDBDatabase 实例
  }

  /** 删除整个数据库（初始化失败、重置数据时使用） */
  async deleteDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(this.dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve(); // 忽略删除失败，可能数据库不存在
      request.onblocked = () => {
        console.warn('Database deletion blocked');
        resolve();
      };
    });
  }

  /**
   * 打开（或首次创建）数据库。
   * onupgradeneeded 只在“数据库不存在 / 版本号升高”时触发：
   * 这里负责建表、建索引；老用户升级时只补缺失的索引，绝不删数据。
   */
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const oldVersion = event.oldVersion;
        
        // 词汇表
        if (!db.objectStoreNames.contains('words')) {
          const wordStore = db.createObjectStore('words', { keyPath: 'id', autoIncrement: true });
          wordStore.createIndex('category', 'category', { unique: false });
          wordStore.createIndex('status', 'status', { unique: false });
          wordStore.createIndex('createdAt', 'createdAt', { unique: false });
          wordStore.createIndex('favorite', 'favorite', { unique: false });
          wordStore.createIndex('language', 'language', { unique: false });
        } else {
          const wordStore = event.target.transaction.objectStore('words');
          // 从版本1升级：添加 favorite 索引
          if (oldVersion < 2 && !wordStore.indexNames.contains('favorite')) {
            wordStore.createIndex('favorite', 'favorite', { unique: false });
          }
          // 从版本2升级：添加 language 索引
          if (oldVersion < 3 && !wordStore.indexNames.contains('language')) {
            wordStore.createIndex('language', 'language', { unique: false });
          }
        }
        
        // 分类表
        if (!db.objectStoreNames.contains('categories')) {
          db.createObjectStore('categories', { keyPath: 'id', autoIncrement: true });
        }
        
        // 设置表
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };
    });
  }

  // ---------- 词汇（words 表）操作 ----------
  /** 新增一条词条；自动补 createdAt（创建时间）和 status='new'（新词），返回新 id */
  async addWord(word) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['words'], 'readwrite');
      const store = transaction.objectStore('words');
      word.createdAt = new Date().toISOString();
      word.status = 'new';
      const request = store.add(word);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 按 id 整体覆盖更新一条词条（put：有则更新、无则新增）。
   *
   * 【云同步钩子 1】只有「学习状态真的变了」（status / favorite / lastStudied 任一变化）
   * 才让 CloudSync 盖上变更时间戳并记入上行队列。
   *
   * 这一点非常关键：像「词典纠错 / 重新导入词典」这类**只改词典字段**的写入，
   * 旧实现也会顺手盖一个「现在」的时间戳，于是这些词条在本机与云端的冲突判定里
   * 变成「最新版本」，把它们**本机较旧的学习状态**（甚至是没学过）推上云，
   * 覆盖掉另一台设备刚学的记录 —— 现象就是「手机上学到 12/100，重开之后变回 0/100」。
   *
   * options.sync === false 时完全不参与云同步（例如批量导入词条内容）。
   *
   * 未登录 / 未配置 Supabase 时 CloudSync.stampWord 立即返回，行为与改造前完全一致。
   */
  async updateWord(word, options = {}) {
    if (options.sync !== false) {
      let learningChanged = true;
      try {
        const prev = await this.getWord(word.id);
        learningChanged = !prev ||
          (prev.status || 'new') !== (word.status || 'new') ||
          Boolean(prev.favorite) !== Boolean(word.favorite) ||
          Number(prev.lastStudied || 0) !== Number(word.lastStudied || 0);
      } catch (error) {
        // 读不到旧值就按原来的行为走：宁可多推一次，也不能漏掉学习记录
        learningChanged = true;
      }
      if (learningChanged) window.CloudSync?.stampWord?.(word);
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['words'], 'readwrite');
      const store = transaction.objectStore('words');
      const request = store.put(word);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /** 读取词库中的全部词条（返回对象数组） */
  async getAllWords() {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['words'], 'readonly');
      const store = transaction.objectStore('words');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /** 按主键 id 读取单条词条 */
  async getWord(id) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['words'], 'readonly');
      const store = transaction.objectStore('words');
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /** 批量新增词条（在同一个事务内完成，性能更好）；返回成功写入的条数 */
  async batchAddWords(words) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['words'], 'readwrite');
      const store = transaction.objectStore('words');
      let count = 0;
      
      words.forEach(word => {
        word.createdAt = new Date().toISOString();
        word.status = 'new';
        const request = store.add(word);
        request.onsuccess = () => count++;
      });
      
      transaction.oncomplete = () => resolve(count);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  /** 批量删除词条（在同一个事务内完成）；返回实际删除的条数 */
  async deleteWordsByIds(ids) {
    const uniqueIds = [...new Set(ids)].filter((id) => id !== undefined && id !== null);
    if (uniqueIds.length === 0) return 0;

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['words'], 'readwrite');
      const store = transaction.objectStore('words');
      let count = 0;

      uniqueIds.forEach(id => {
        const request = store.delete(id);
        request.onsuccess = () => count++;
      });

      transaction.oncomplete = () => resolve(count);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  // ---------- 设置（settings 表）操作：键值对存取 ----------
  /** 读取某项设置；库里没有该 key 时返回 defaultValue（即“默认值”） */
  async getSetting(key, defaultValue = null) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['settings'], 'readonly');
      const store = transaction.objectStore('settings');
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result ? request.result.value : defaultValue);
      request.onerror = () => reject(request.error);
    });
  }

  /** 写入某项设置（以 { key, value } 形式存储，同名 key 会被覆盖） */
  async setSetting(key, value) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['settings'], 'readwrite');
      const store = transaction.objectStore('settings');
      const request = store.put({ key, value });
      request.onsuccess = () => {
        resolve();
        // 【云同步钩子 2】设置写完后通知 CloudSync。
        // 只有参与同步的设置项和 learnProgress（今日学习会话）会触发上传，
        // 其余 key（统计快照、词典更新时间、同步元数据等）会被它忽略。
        window.CloudSync?.onSettingWritten?.(key, value);
      };
      request.onerror = () => reject(request.error);
    });
  }
}

// ==================== 主应用类（应用层） ====================
/**
 * 应用层类：持有全部运行状态，负责页面渲染、事件交互、学习流程、
 * 词库管理与设置读写。全局唯一实例为 window.app。
 */
class VocabApp {
  constructor() {
    this.db = new VocabDB();          // 数据层实例（IndexedDB 封装）
    this.currentPage = 'learn';       // 当前所在页面：learn 学习 / library 词库 / settings 设置
    this.currentCardIndex = 0;        // 今日学习队列中，当前卡片的下标
    this.todayWords = [];             // 今日学习队列（词条对象数组）
    /**
     * 本轮已完成的词条数（进度条口径）。
     *
     * 口径与上方的「今日已掌握 + 今日待复习」完全一致，都是
     * 「今日学过、且当前状态为 mastered/review 的**去重词条数**」：
     *
     *   本轮完成数 = 今日已计入统计的词条数 − 本轮起点(_todayRoundStart)
     *
     * 早期版本用的是「今天点过的卡片张数」，同一词条今天被学两次会记两张，
     * 于是学完 100 张时上方两个数字之和只有 98/99（差 1~2 个）。
     * 现在两个数字由同一份词条状态推导，永远对得上。
     * 本轮起点由 settings 里的 todayRoundStart 持久化（点【继续学习】时前移）。
     */
    this.todayDoneCount = 0;
    /**
     * 本轮开始时「今日已计入统计的词条数」；进度 = 今日词条数 − 这个起点
     */
    this._todayRoundStart = 0;
    /** _todayRoundStart 所属日期（用于跨天自动归零） */
    this._todayRoundDate = '';
    /**
     * 本轮起点是否已经从库里读出来。读出之前不拿统计去推 done，
     * 否则刷新瞬间会把「今日已学词条数」误当成进度、闪出完成页。
     */
    this._roundStartReady = false;
    /**
     * 今日统计是否已经算过一次。统计算出来之前，不能拿「起点 > 今日词条数」去判断起点是否失效，
     * 否则刚启动（统计还是 0）就会把好好的起点清零。
     */
    this._statsReady = false;
    /**
     * 学习页当前展示的是什么：'card' 卡片 / 'complete' 完成页 / 'empty' 空状态。
     * 云同步改写了统计之后据此纠偏 —— 明明没达标却停在完成页时切回卡片，
     * 避免用户点到一个不该出现的【继续学习】把本轮进度清零。
     */
    this._learnView = 'card';
    /**
     * 「今日目标已达成」的日期。
     *
     * 达成过之后，即使今日统计因为数据变化少了 1~2 条（例如更新词典时删掉了一个
     * 今天学过的词条、或另一台设备把某条改成了非今日），也不该让「已完成」退回 99/100 ——
     * 用户确实完成过今天的目标，这个事实要保住。点【继续学习】、改每日目标、
     * 清除记录都会清掉它；跨天自动失效。
     */
    this._todayGoalReachedDate = '';
    /**
     * 「今日目标已达成」时使用的每日目标值。
     *
     * 只记日期不够：目标从 10 改成 15 后，如果还按「已完成」的旧标记补足差额，
     * 会把 10/15 硬抬成 15/15（补足上限 5 恰好覆盖这次差值），
     * 手机上表现为「电脑端 10/15，手机一打开就是 15/15」。
     * 因此目标变了就不再沿用旧的完成态。
     */
    this._todayGoalReachedGoal = 0;
    /**
     * 还没落库完成的学习动作数量。
     *
     * 点「掌握 / 陌生」时卡片立刻切走，写库与统计重算是后台异步做的。
     * 这期间若有更早触发的统计重算先跑完，它读到的是「少一张」的旧快照，
     * 会把界面上的进度从 100 回退成 99 —— 用户看到的就是
     * 「学完了却停在 99/100，点一下【继续学习】才变 100」。
     * 所以只要还有动作在排队，就不允许统计把进度往回改。
     */
    this._pendingPersistCount = 0;
    /**
     * 统计快照是否曾经落后于乐观值（发生过「不回退」保护）。
     * 只有它成立时，学习动作全部落库后才需要再校准一次统计。
     */
    this._statsMayBeStale = false;
    /**
     * 当前队列里是否还有「今天还没计入统计」的词条。
     * 为 false 时这一轮是纯复习：进度条与今日统计都不会再增长，界面会给出提示。
     */
    this._queueHasFreshWords = true;
    /** 本轮队列的容量上限 = min(每日目标, 当前范围内词条数)；用于判断切页时能否恢复快照 */
    this._queueCapacity = 0;
    /**
     * 当前词典范围内全部词条的快照（prepareLearnSession 时写入）。
     * 「跳过」需要同步补一张新词进队列，而补牌又要读全库，所以这里缓存一份，
     * 补牌时直接从缓存里筛，避免为了同步而放弃动画时序。
     */
    this._scopePoolCache = [];
    /**
     * 词库菜单里手动改动当前「学习范围」成员后，需要强制放进学习队列的词条 id。
     *
     * 例如：学习范围是「待复习」且已经显示「已学完」，此时到词库把一条新词改成
     * 「待复习」。这条词刚写过 lastStudied（今天已计入统计），按“只抽今天没学过的词”
     * 的规则会被排除，红字提示就会一直留着。这里把这类词单独记下来，
     * 重建队列时强制排在最前面，让学习页的提示与词库里的范围标签保持一致。
     */
    this._externalScopeIncludeIds = new Set();
    /** 上面这些 id 属于哪个学习范围（切换范围时清空） */
    this._externalScopeIncludeScope = 'all';
    /**
     * 「学习范围」每一轮已经学过的词条（用 dict_key 记录，跨设备/重新导入词典都稳定）。
     *
     * 每个 tab（全部/新词/待复习/已掌握/收藏）各自维护一份：
     * 某个 tab 内的词条 key 全部出现在对应集合里，才算「这个 tab 学完一遍」，
     * 学习页才提示「已学完【…】」。之后如果词典新增词条、或者词库里把某条词
     * 新加进这个 tab，它的 key 不在集合里 → 自动取消「已学完」，继续出卡；
     * 学过之后 key 补进集合，再次学完才重新提示。
     */
    this._scopePassDone = this._emptyScopePassDone();
    /** 学习范围进度的防抖保存定时器（学习过程中每张卡都写库太重） */
    this._scopePassSaveTimer = null;
    /** 正在处理“一轮队列走完”：继续下一批 / 显示已学完，防止重复进入 */
    this._handlingScopeEnd = false;
    /**
     * 本次会话里被「跳过」的词条 id。
     * 跳过不写学习记录（不改 status / lastStudied），所以需要这份内存名单来保证
     * 跳过的词不会立刻被补回队列；新一轮会话开始时清空。
     */
    this._skippedWordIds = new Set();
    this.isFlipped = false;           // 当前卡片是否处于翻面（释义面朝上）状态
    // 全部用户设置；启动时由 loadSettings() 从数据库读取覆盖默认值
    this.settings = {
      dailyGoal: 100,                 // 每日目标（每天学习多少张卡片）
      fontSize: 'medium',             // 字号（预留）
      /** 默认先展示释义面；点击后翻到词汇面 */
      cardDefinitionFirst: false,
      learnMode: 'random',            // 学习模式：random 随机 / sequential 顺序
      /** 音标渐显延迟（秒），0表示立即显示 */
      phoneticDelay: 2,
      /** 单词重复出现频率（天），0表示每日目标内不重复 */
      repeatFrequency: 2,
      /** 词典导入范围：all / phrase / word，与设置页下拉同步 */
      dictImportType: 'all',
      /** 学习范围：all / new / review / mastered / favorite（决定学习页卡片抽词范围） */
      studyScope: 'all',
      categoryDisplay: true,          // 卡片上方是否显示分类徽标（默认开启；loadSettings 会从库中读取用户选择）
      /** 词库列表卡片中，单词下方是否显示释义（默认开启；只影响词库卡片，查看单词弹窗不受影响） */
      meaningDisplay: true,
      /** 练习页：练习范围 all / phrase / word（独立于学习页的「词典导入」） */
      practiceScope: 'all',
      /** 练习页：输入模式 with 含调值 / without 不含调值 */
      practiceToneMode: 'with',
      /**
       * 练习进度：按「字 / 短语」分别记录已经答对过的词条标识（进度条口径）。
       * 标识用 practiceDictKey()（分类|词汇|音标）而不是词条 id：id 是 IndexedDB 自增主键，
       * 换设备后会错位，同步过去会贴到别的词条上。
       * 与学习记录完全无关（练习不改 status/收藏），但会随云同步在多设备间合并。
       */
      practiceProgress: { word: [], phrase: [] }
    };
    this.todayStats = {               // 今日统计（按当前展示范围汇总后的镜像值）
      mastered: 0,                    //   今日“已掌握”次数
      review: 0,                      //   今日“待复习/陌生”次数
      total: 0                        //   今日队列长度（由 prepareLearnSession 维护）
    };
    this.totalStats = {               // 今日之前的累计统计（镜像值）
      mastered: 0,
      review: 0
    };
    this.searchQuery = '';            // 词库页搜索框内容（已转小写）
    this.filterStatus = 'all';        // 词库页状态筛选：all/new/review/mastered/favorite
    /**
     * 词库页是否只显示“今天学过的那些”词条。
     * 仅当用户从学习卡上方的「今日已掌握 / 今日待复习」点进来时为 true，
     * 直接切到词库页或手动切换选项卡都会复位为 false（累计口径）。
     */
    this._libraryTodayOnly = false;
    /** _libraryTodayOnly 为 true 时限定只显示该状态（mastered / review） */
    this._libraryTodayKind = null;
    /** 按分类(字/短语)归档的今日统计：{ word:{mastered,review}, phrase:{mastered,review} } */
    this._scopeToday = this._emptyScopeStats();
    /** 按分类(字/短语)归档的今日之前累计统计（每日跨天时并入） */
    this._scopeTotal = this._emptyScopeStats();
    /** 触摸翻面后浏览器会合成 click，需忽略下一次点击避免立刻翻回正面 */
    this._suppressNextCardClickFlip = false;
    /** 鼠标单击翻面的延迟定时器：为双击选词/拖选留出取消窗口 */
    this._cardFlipTimer = null;
    /** 本次鼠标按压是否发生了位移（拖选文字），用于抑制这次点击的翻面 */
    this._cardPointerMoved = false;
    /** 本次按压已长按取词，用于抑制松手时（合成）的翻面 */
    this._cardLongPressFired = false;
    /** 鼠标长按取到的文字：mouseup（带用户手势）时才真正写剪贴板 */
    this._cardLongPressText = '';
    /** 触屏长按取词进行中：滑动与翻面全部让位给系统选中文字 */
    this._cardTouchLongPress = false;
    /** 卡片“滑出→滑入”过场动画是否进行中；用于防止动画期间重复触发导致索引与动画错位 */
    this._cardAnimating = false;
    /** 离开学习页时保存的会话快照，用于返回学习页时恢复进度条与队列（不可仅用 switchPage 局部变量） */
    this._learnSessionSnapshot = null;
    /** 当前词典范围内各状态的词条数缓存 { mastered, review }，与词库页筛选结果一致 */
    this._cachedStatusCounts = { mastered: 0, review: 0 };
    /** 练习页：本轮练习队列（已打乱）、当前题目下标 */
    this.practiceWords = [];
    this.practiceIndex = 0;
    /** 练习页队列对应的范围（all/phrase/word）；换范围时重建队列 */
    this._practicePoolKey = null;
    /** 当前题目的目标音节（已按输入模式归一化），如 ['jat','di'] */
    this._practiceTargets = [];
    /** 当前题目音标的原始音节，如 ['jat1','di1']（翻面时展示） */
    this._practiceSyllables = [];
    /** 整条音标输入正确后「自动下一题」的定时器 */
    this._practiceAdvanceTimer = null;
    /** 当前题目是否已经答对（答对后锁住输入，避免多余输入把绿框改红） */
    this._practiceSolved = false;
    /** 答对那一刻输入框里的内容（锁定期间用来还原被误敲的字符） */
    this._practiceSolvedValue = '';
    /** 练习进度索引 { word:Set, phrase:Set }，与 settings.practiceProgress 保持同步，便于 O(1) 查询 */
    this._practiceDone = { word: new Set(), phrase: new Set() };
    /**
     * 「dict_key → 同一个词的全部词条」索引（refreshStatusCounts 时重建）。
     * 用于让同音同字的多条词条（义项）学习状态保持一致 —— 云端一行 dict_key 代表整组。
     */
    this._dictKeyIndex = null;
    /** 当前练习范围内「可练习词条」的总数（进度条分母） */
    this._practiceScopeTotal = 0;
    /** 手机端软键盘是否处于弹出状态（由 initKeyboardViewport 维护，配合 body.keyboard-open） */
    this._keyboardOpen = false;
    /** 练习页底部固定键盘是否展开（默认收起：收起时卡片才有足够高度与学习卡一致） */
    this._practiceKeyboardOpen = false;
    /**
     * 应用是否已经完成首次渲染。
     * 启动阶段会先等首次云同步落定再渲染学习页（见 init），
     * 云同步的界面刷新逻辑据此跳过「重建学习队列」，避免同一份云端进度被建两次。
     */
    this._appReady = false;
  }
  /**
   * 应用启动入口（DOMContentLoaded 后调用一次）。
   * 流程：测量滚动条 → 打开数据库 → 读取设置 → 首次使用默认词典范围为「字」
   * → 注册 Service Worker（离线缓存）→ 绑定全部事件
   * → 自动导入 dict.xlsx → 加载/迁移学习统计 → 首次渲染。
   * 任何一步失败都会走 recoverFromError() 兜底重建。
   */
  async init() {
    try {
      await this.db.init();
      await this.loadSettings();
      const savedDictType = await this.db.getSetting('dictImportType', null);
      if (savedDictType === null) {
        this.settings.dictImportType = 'word';
        await this.db.setSetting('dictImportType', 'word');
      }
      const dictTypeSelectInit = document.getElementById('dictTypeSelect');
      if (dictTypeSelectInit) {
        dictTypeSelectInit.value = this.settings.dictImportType || 'word';
      }
      this.initServiceWorker();
      this.bindEvents();
      this.initKeyboardViewport();

      // 先导入词典（字+短语全量常驻并标注分类），再加载按分类归档的统计，
      // 保证首次升级时迁移能按现有词条分类拆分历史累计记录
      await this.autoLoadDict();
      // 给旧数据里的收藏补上「收藏时间」—— 没有它收藏列表只能退化成按学习时间排，
      // 看起来就是「顺序乱的」，而用户期望的是最近收藏的排在最上面
      await this.backfillFavoriteAt();
      // 先读「本轮起点」，再算统计。顺序反了的话，第一次算统计时起点还是 0，
      // 会把「今日已学词条数」当成进度，于是刷新瞬间误判「今日目标已完成」、
      // 闪出完成页与【继续学习】按钮（用户手快一点就把本轮进度清零了）
      await this.loadTodayDoneCount();
      await this.loadTodayStats();
      // 显示上次词库更新时间
      await this.loadDictUpdateTimeDisplay();

      // 【云同步钩子 3】先启动云同步，并等首次同步落定后再渲染学习页。
      // 手机端如果先按本地空库渲染，会显示 0/100；用户背了几十张后云端记录才合并进来，
      // 进度会瞬间跳到目标并弹出【继续学习】（例如电脑端 64 + 手机端 36 = 100）。
      // 最多等 10 秒；未登录 / 未配置 / 离线时几乎立即返回，不影响本地使用。
      const cloudSync = window.CloudSync;
      let syncMaskTimer = null;
      try {
        if (cloudSync && typeof cloudSync.attach === 'function') {
          const shouldWait = typeof cloudSync.isConfigured === 'function' && cloudSync.isConfigured() &&
            typeof cloudSync.hasStoredSession === 'function' && cloudSync.hasStoredSession();
          const cloudReady = cloudSync.attach(this);
          if (shouldWait && cloudReady && typeof cloudReady.then === 'function') {
            const waitReady = typeof cloudSync.whenReady === 'function'
              ? cloudSync.whenReady(10000)
              : Promise.race([
                  cloudReady,
                  new Promise((resolve) => setTimeout(resolve, 10000))
                ]);
            // 同步通常很快：250ms 内完成就不闪遮罩；慢的时候给出明确提示
            syncMaskTimer = setTimeout(() => this.showInitialSyncPending(), 250);
            await waitReady;
          }
        }

        await this.render();
        this._appReady = true;
      } finally {
        if (syncMaskTimer) clearTimeout(syncMaskTimer);
        this.hideInitialSyncPending();
      }
      // 学习卡此刻可见：量一次高度，练习卡据此与学习卡等高
      this.syncPracticeCardHeight();
    } catch (error) {
      console.error('App initialization failed:', error);
      this.showToast('应用初始化失败，正在尝试修复...');
      await this.recoverFromError();
    }
  }
  
  /** 词典导入或清空后同步词库分类勾选与列表 */
  async refreshLibraryFiltersAfterDictChange() {
    await this.syncLibraryCategoryFilterToDictType();
    await this.renderCategoryOptions();
    await this.updateDictTypeSelectLabels();
    if (this.currentPage === 'library') {
      await this.renderLibrary();
    }
  }

  /** 依据 sheet 名判断词条分类（对应设置页的 短语/字） */
  sheetDictScope(sheetName) {
    const n = String(sheetName || '').toLowerCase();
    return /phrase|短/.test(n) ? 'phrase' : 'word';
  }

  /**
   * 旧版未标注分类的词条与某一行内容是否吻合（判断它原本来自字表还是短语表）。
   * 匹配的字段越多得分越高；行与旧词条完全同源时通常 meaning/category/phonetic 都一致。
   */
  _legacySimilarityScore(row, legacy) {
    const eq = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
    let score = 0;
    const rowMeaning = String(row.meaning ?? row.definition ?? '').trim();
    const legacyMeaning = String(legacy.definition ?? legacy.meaning ?? '').trim();
    if (rowMeaning && eq(rowMeaning, legacyMeaning)) score += 3;
    if (row.category && eq(row.category, legacy.category)) score += 2;
    if (row.phonetic && eq(row.phonetic, legacy.phonetic)) score += 2;
    if (row.example && eq(row.example, legacy.example)) score += 1;
    if (row.jyutping && eq(row.jyutping, legacy.jyutping)) score += 1;
    if (row.cantonese && eq(row.cantonese, legacy.cantonese)) score += 1;
    return score;
  }

  /** 同分类内的两个词条内容列是否一致（一致则无需重写） */
  _sameScopeContentEqual(row, existing) {
    const eq = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();
    const rowMeaning = String(row.meaning ?? row.definition ?? '').trim();
    const oldMeaning = String(existing.definition ?? existing.meaning ?? '').trim();
    return (
      eq(rowMeaning, oldMeaning) &&
      eq(row.category, existing.category) &&
      eq(row.phonetic, existing.phonetic) &&
      eq(row.example, existing.example) &&
      eq(row.language, existing.language) &&
      eq(row.jyutping, existing.jyutping) &&
      eq(row.cantonese, existing.cantonese) &&
      eq(row.cantoneseExample, existing.cantoneseExample)
    );
  }

  // 自动加载 dict.xlsx 文件
  // 字（word sheet）与短语（phrase sheet）始终全量导入并常驻词库，每个词条标注
  // dictScope（'word'|'phrase'），同一文本若同时出现在两个字库（如「一」「钱」），
  // 会保留两条各自独立的记录，绝不跨分类覆盖。
  // settings.dictImportType 只决定当前“学习/展示/统计”使用哪个分类。
  async autoLoadDict() {
    try {
      const response = await fetch('dict.xlsx');
      if (!response.ok) {
        console.log('dict.xlsx 文件不存在，跳过自动加载');
        await this.refreshLibraryFiltersAfterDictChange();
        return;
      }

      const arrayBuffer = await response.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);
      const workbook = XLSX.read(data, { type: 'array' });

      const dictTypeSelect = document.getElementById('dictTypeSelect');
      const dictType = this.settings.dictImportType || dictTypeSelect?.value || 'all';
      if (dictTypeSelect) dictTypeSelect.value = dictType;

      // 遍历全部 sheet 导入（按 sheet 归属标注 字/短语 分类）
      let allWords = [];
      for (const sheetName of workbook.SheetNames) {
        const worksheet = workbook.Sheets[sheetName];
        if (!worksheet) continue;
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
        const words = this.parseExcel(jsonData, this.sheetDictScope(sheetName));
        if (Array.isArray(words) && words.length > 0) {
          allWords = allWords.concat(words);
        }
      }

      // 源词典同一 sheet 内可能存在完全重复的行，按“分类+内容签名”去重，避免词库出现重复词条
      if (allWords.length > 1) {
        const seen = new Set();
        const deduped = [];
        for (const w of allWords) {
          const sig = [
            w.dictScope, w.word, w.meaning, w.phonetic, w.example, w.category,
            w.language, w.jyutping, w.cantonese, w.cantoneseExample
          ]
            .map((v) => String(v ?? ''))
            .join('|');
          if (!seen.has(sig)) {
            seen.add(sig);
            deduped.push(w);
          }
        }
        if (deduped.length !== allWords.length) {
          console.log(`词典去重：移除 ${allWords.length - deduped.length} 个完全重复的词条行`);
          allWords = deduped;
        }
      }

      if (!Array.isArray(allWords) || allWords.length === 0) {
        console.log('dict.xlsx 文件内容为空或格式错误');
        await this.refreshLibraryFiltersAfterDictChange();
        return;
      }

      // 读取现有词条。同分类内可能出现“同文本但内容不同”的词条（如多读音字），
      // 因此只按文本建立分组，再按“内容吻合度”把词典行对应到它原本的那条记录上；
      // 未标注分类的旧词条单独收集，稍后同样按内容吻合度认领到它原本所属的分类。
      const existingWords = await this.db.getAllWords();
      const scopedByText = { word: new Map(), phrase: new Map() };
      const untaggedByText = new Map();
      for (const e of existingWords) {
        const t = String(e.word || '').toLowerCase();
        if (e.dictScope === 'word' || e.dictScope === 'phrase') {
          if (!scopedByText[e.dictScope].has(t)) scopedByText[e.dictScope].set(t, []);
          scopedByText[e.dictScope].get(t).push(e);
        } else {
          if (!untaggedByText.has(t)) untaggedByText.set(t, []);
          untaggedByText.get(t).push(e);
        }
      }

      // 在候选记录中挑一条与词典行内容最吻合的（无吻合则返回 null）
      const bestRowFor = (list, row) => {
        if (!list || list.length === 0) return null;
        let best = null;
        let bestScore = -1;
        for (const cand of list) {
          const s = this._legacySimilarityScore(row, cand);
          if (s > bestScore) {
            bestScore = s;
            best = cand;
          }
        }
        return bestScore >= 1 ? best : null;
      };

      // 认领一条未标注的旧词条到当前行所在分类（内容最吻合者优先）
      const adoptLegacyFor = (t, row) => {
        const list = untaggedByText.get(t);
        const best = bestRowFor(list, row);
        if (!best) return null;
        const idx = list.indexOf(best);
        list.splice(idx, 1);
        if (list.length === 0) untaggedByText.delete(t);
        return best;
      };

      // 区分新单词和需要更新的单词
      const newWords = [];
      const updateWords = [];
      // 当前词典已成功匹配到的库内记录；未进入此集合的旧记录将从词库移除
      const matchedExistingIds = new Set();
      // 每个文本本轮已匹配过的词条 id（用于同文本多条记录时逐条对应）
      const usedByText = new Map();
      // 每个“分类+文本”在词典文件中的行数（用于修复此前被整行覆盖的脏数据）
      const fileCountByKey = new Map();
      for (const w of allWords) {
        const key = (w.dictScope === 'phrase' ? 'phrase' : 'word') + '|' + String(w.word || '').toLowerCase();
        fileCountByKey.set(key, (fileCountByKey.get(key) || 0) + 1);
      }
      for (const w of allWords) {
        const t = String(w.word || '').toLowerCase();
        const scope = w.dictScope === 'phrase' ? 'phrase' : 'word';
        const arr = scopedByText[scope];
        let list = arr.get(t);
        if (!list) {
          list = [];
          arr.set(t, list);
        }
        let usedIds = usedByText.get(t);
        if (!usedIds) {
          usedIds = new Set();
          usedByText.set(t, usedIds);
        }

        let existing = null;
        // 同文本多条记录时，优先匹配“本轮尚未被使用”且内容最吻合的记录，
        // 避免把多读音字的不同词条合并/覆盖成一条
        const best = bestRowFor(
          list.filter((c) => !usedIds.has(c.id)),
          w
        );
        if (best) {
          existing = best;
          usedIds.add(best.id);
        }
        let isAdoptedLegacy = false;
        if (!existing) {
          const legacy = adoptLegacyFor(t, w);
          if (legacy) {
            list.push(legacy);
            existing = legacy;
            isAdoptedLegacy = true;
          }
        }
        if (!existing) {
          // 修复兜底：词典行与库内记录无法按内容对应时——
          // 若文件与该分类+文本的行数等于库中未被占用的记录数，说明这些记录是
          // 曾被“另一张表内容整行覆盖”的脏数据，按顺序逐条用文件内容修复；
          // 文件只有一行、库中也只剩一条时直接修复它。
          const key = scope + '|' + t;
          const unused = list.filter((c) => !usedIds.has(c.id));
          const fileRows = fileCountByKey.get(key) || 0;
          if (unused.length > 0 && (unused.length === fileRows || (unused.length === 1 && fileRows === 1))) {
            existing = unused[0];
            usedIds.add(existing.id);
          }
        }

        if (existing) {
          matchedExistingIds.add(existing.id);
          // 需要更新：认领旧词条、字段补全、或词典内容有更新（含此前被跨分类覆盖的脏数据）
          const needFieldBackfill =
            (!existing.jyutping && w.jyutping) ||
            (!existing.cantonese && w.cantonese) ||
            (!existing.cantoneseExample && w.cantoneseExample);
          const needsUpdate =
            isAdoptedLegacy ||
            needFieldBackfill ||
            !this._sameScopeContentEqual(w, existing);
          if (needsUpdate) {
            // 合并词典内容时保留学习记录（状态/收藏/学习时间等），避免已掌握、待复习记录被清空
            updateWords.push({
              ...existing,
              ...w,
              id: existing.id,
              createdAt: existing.createdAt,
              status: existing.status,
              favorite: existing.favorite,
              lastStudied: existing.lastStudied,
              reviewCount: existing.reviewCount,
              lastReview: existing.lastReview,
              nextReview: existing.nextReview,
              dictScope: scope
            });
          }
        } else {
          newWords.push(w);
        }
      }

      // 以 dict.xlsx 为最终来源：新词典中不存在的旧词条需要删除。
      // 已匹配词条仍保留原 id 与学习记录，仅删除本次没有对应行的残留数据。
      const staleWords = existingWords.filter((word) => !matchedExistingIds.has(word.id));

      if (updateWords.length > 0) {
        for (const w of updateWords) {
          // sync: false —— 这里只是在同步词典内容（音标/释义/分类等），
          // 不能给词条盖变更时间戳，否则会把本机较旧的学习状态当成「最新」推上云
          await this.db.updateWord(w, { sync: false });
        }
        console.log(`更新了 ${updateWords.length} 个单词的字段/分类标注`);
      }

      if (newWords.length > 0) {
        await this.db.batchAddWords(newWords);
      }

      if (staleWords.length > 0) {
        await this.db.deleteWordsByIds(staleWords.map((word) => word.id));
        console.log(`已从词库移除 ${staleWords.length} 个词典中不存在的旧词条`);
      }

      const changeMessages = [];
      if (newWords.length > 0) changeMessages.push(`新增 ${newWords.length} 个`);
      if (updateWords.length > 0) changeMessages.push(`更新 ${updateWords.length} 个`);
      if (staleWords.length > 0) changeMessages.push(`移除 ${staleWords.length} 个`);
      if (changeMessages.length > 0) {
        this.showToast(`词典同步完成：${changeMessages.join('，')}`);
      } else {
        console.log('dict.xlsx 中没有新单词');
      }

      // 词典内容发生变化时记录更新时间并显示在页面顶部
      if (newWords.length > 0 || updateWords.length > 0 || staleWords.length > 0) {
        const now = new Date();
        const formatted = this.formatDictUpdateTime(now);
        await this.db.setSetting('dictUpdateTime', now.toISOString());
        this.displayDictUpdateTime(formatted);
      }

      await this.refreshLibraryFiltersAfterDictChange();

      // 【注意】这里不要再调用 prepareLearnSession()。
      //
      // init() 里紧接着就会执行 render()，而 render() 内部同样会调用
      // prepareLearnSession()。连着调用两次会导致「刷新/切后台回来进度清零」：
      //   第一次会从 settings.learnProgress 恢复进度，并把 currentCardIndex
      //     设成保存下来的非 0 值（比如 15）；
      //   第二次进来时，恢复条件里的 `this.currentCardIndex === 0` 已经不成立，
      //     于是代码走到「重新抽词」分支，把刚恢复的队列整个换掉、下标归零，
      //     用户看到的就是「又从头开始背」。
      // 词典更新后的队列重建，交给 render() 里那一次即可。
    } catch (error) {
      console.error('自动加载 dict.xlsx 失败:', error);
      // 忽略错误，不影响应用启动
    }
  }
  
  /**
   * 手机端软键盘适配（只做两件事，不改动任何业务逻辑）：
   *
   * 1) 键盘弹出时给 <body> 加 .keyboard-open，并用 visualViewport 的真实可见高度
   *    约束 .app-container（见 styles.css）。iOS Safari 在键盘弹出时不会缩小布局视口，
   *    而是把整个页面往上顶，底部菜单栏会被推出屏幕、页面也只剩半截；
   *    改用「键盘上方的可视区域」来摆放应用后，菜单栏始终可见并紧贴键盘上沿，
   *    页面内容也重新从顶部开始排布。
   * 2) 记录键盘高度，供需要时使用；弹出/收起只在跨越阈值时切换 class，避免抖动。
   */
  initKeyboardViewport() {
    const vv = window.visualViewport;
    if (!vv || typeof vv.addEventListener !== 'function') return;
    // 桌面浏览器没有软键盘：不加这层适配，免得「页面缩放」（同样会改 visualViewport）
    // 被当成键盘弹出。触摸设备（手机 / 平板 / 触屏本）才启用。
    const touchCapable = (navigator.maxTouchPoints || 0) > 0;
    if (!touchCapable) return;

    const root = document.documentElement;
    const apply = () => {
      const layoutHeight = window.innerHeight || 0;
      // 页面缩放会让 vv.height 远小于 innerHeight，与键盘弹出的表现相同，
      // 这里用 scale 把缩放排除掉
      const zoomed = Math.abs((vv.scale || 1) - 1) > 0.01;
      const keyboardHeight = zoomed ? 0 : Math.max(0, layoutHeight - vv.height - vv.offsetTop);

      // 每次都要更新：键盘高度变化、地址栏伸缩、页面缩放都会改这两个值
      root.style.setProperty('--visual-viewport-height', `${Math.round(vv.height)}px`);
      root.style.setProperty('--visual-viewport-top', `${Math.round(vv.offsetTop)}px`);
      this._keyboardHeight = keyboardHeight;

      const open = keyboardHeight > KEYBOARD_MIN_HEIGHT_PX;
      if (open === this._keyboardOpen) return;
      this._keyboardOpen = open;
      document.body.classList.toggle('keyboard-open', open);

      if (open) {
        // 可视高度骤减：内容回到顶部，保证卡片和输入框都在键盘上方看得到
        const content = document.querySelector('.page-content');
        if (content) content.scrollTop = 0;
      }
    };

    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    apply();
  }

  /**
   * 让练习卡与学习卡等高：直接量学习卡的实际高度写进 CSS 变量。
   *
   * 两个页面卡片区的可用高度天生不同（学习页卡片区上方是「进度条 + 提示行 + 今日统计行」，
   * 练习页是「进度条 + 范围工具栏」），同一条 clamp 公式算出来会差几十像素，
   * 所以量出来最可靠 —— 电脑端与手机端都用同一个值，卡片高度自然一致。
   *
   * 学习页隐藏时量到的是 0，此时保留上一次的值（切勿清掉变量，否则切到练习页后
   * 又会退回 CSS 公式、两页高度重新对不上）。
   */
  syncPracticeCardHeight() {
    const learnCard = document.getElementById('flashcard');
    if (!learnCard) return;
    const height = Math.round(learnCard.getBoundingClientRect().height);
    if (height <= 0) return;
    document.documentElement.style.setProperty('--learn-card-height', `${height}px`);
  }

  /** 数据库修复后写入少量示例词，保证可立即学习 */
  async addSampleWords() {
    const samples = [
      {
        word: 'hello',
        meaning: '你好；喂',
        definition: '你好；喂',
        phonetic: '/həˈloʊ/',
        example: 'Hello, world.',
        category: '示例',
        language: '英语'
      },
      {
        word: 'apple',
        meaning: '苹果',
        definition: '苹果',
        phonetic: '/ˈæpl/',
        example: 'An apple a day.',
        category: '示例',
        language: '英语'
      }
    ];
    await this.db.batchAddWords(samples);
  }

  /** 初始化失败后的自救：删库 → 重建空库 → 写入两条示例词，保证应用能打开、能学习 */
  async recoverFromError() {
    try {
      await this.db.deleteDatabase();
      await this.db.init();
      await this.loadSettings();
      await this.loadTodayStats();
      await this.loadTodayDoneCount();
      this.bindEvents();
      await this.addSampleWords();
      await this.render();
      this._appReady = true;
      this.showToast('数据已重置，应用恢复正常');
    } catch (recoverError) {
      console.error('Recovery failed:', recoverError);
      this.showToast('无法恢复，请刷新页面重试');
    }
  }

  /** 注册 Service Worker（sw.js）实现离线缓存；发现新版本时让其立即激活并自动刷新页面 */
  initServiceWorker() {
    if ('serviceWorker' in navigator) {
      const hadController = Boolean(navigator.serviceWorker.controller);
      let isRefreshing = false;

      // 只有旧版本被新 Service Worker 替换时才刷新，首次安装不重复刷新。
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || isRefreshing) return;
        isRefreshing = true;
        window.location.reload();
      });

      // updateViaCache: 'none' —— 不让浏览器缓存 sw.js 本身，
      // 每次注册/刷新都向网络请求最新 sw.js，确保代码改动能立即被检测到
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
        // 检测到新 SW 安装后，通知它立即激活
        const updateSW = (worker) => {
          worker.postMessage({ type: 'SKIP_WAITING' });
        };
        if (reg.waiting) updateSW(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              updateSW(newWorker);
            }
          });
        });

        // 页面加载和重新回到前台时主动检查更新，正常刷新即可获取最新版本。
        const checkForUpdate = () => {
          reg.update().catch(error => {
            console.warn('Service Worker 更新检查失败:', error);
          });
        };
        checkForUpdate();
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') checkForUpdate();
        });
      }).catch(error => {
        console.error('Service Worker 注册失败:', error);
      });
    }

    // 请求持久化存储，降低浏览器自动清理 IndexedDB 的概率
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().then(persisted => {
        if (persisted) {
          console.log('[Storage] 持久化存储已启用，学习记录不易被清除');
        }
      });
    }
  }

  /** 从数据库读取全部设置项覆盖默认值；getSetting 第二参数即“用户从未设置时”的默认值 */
  async loadSettings() {
    this.settings.dailyGoal = await this.db.getSetting('dailyGoal', 100);
    this.settings.cardDefinitionFirst = await this.db.getSetting('cardDefinitionFirst', false);
    this.settings.categoryDisplay = await this.db.getSetting('categoryDisplay', true);
    this.settings.meaningDisplay = await this.db.getSetting('meaningDisplay', true);
    this.settings.learnMode = await this.db.getSetting('learnMode', 'random');
    this.settings.phoneticDelay = await this.db.getSetting('phoneticDelay', 2);
    this.settings.repeatFrequency = await this.db.getSetting('repeatFrequency', 2);
    this.settings.dictImportType = await this.db.getSetting('dictImportType', 'all');
    this.settings.studyScope = this.normalizeStudyScope(await this.db.getSetting('studyScope', 'all'));
    this.settings.practiceScope = await this.db.getSetting('practiceScope', 'all');
    this.settings.practiceToneMode = await this.db.getSetting('practiceToneMode', 'with');
    this.settings.practiceProgress = await this.db.getSetting('practiceProgress', { word: [], phrase: [] });
    // 各学习范围「已经学过一遍」的词条集合（dict_key），用于判断 tab 是否学完
    await this.loadScopePass();
    // 进度索引（Set）由持久化的列表重建
    this.initPracticeProgress();
    // 旧版本把练习进度存成本地词条 id：id 是 IndexedDB 自增主键，换设备后会错位，
    // 同步过去等于把「练过的词」贴到别的词条上。这里把旧数据迁移成跨设备稳定的 dict_key。
    await this.migratePracticeProgressIds();
  }

  // ==================== 按分类(字/短语)归档的学习统计 ====================
  // 学习记录按词条分类（word=字 / phrase=短语）分开统计：
  //   scopeToday = 今天学习且当前状态为 mastered/review 的词条数
  //   scopeTotal = 当前词库中所有 mastered/review 的词条数
  // 展示时：全部 = 字 + 短语之和；字/短语 = 各自分类。

  _emptyScopeStats() {
    return {
      word: { mastered: 0, review: 0 },
      phrase: { mastered: 0, review: 0 }
    };
  }

  // ==================== 学习范围的「学完一遍」进度 ====================
  // 每个学习范围（全部/新词/待复习/已掌握/收藏）分别记录已经学过的 dict_key。
  // 一个 tab 内的词条全部在集合里 → 该 tab 学完一遍，学习页显示红字提示。

  _emptyScopePassDone() {
    return {
      all: new Set(),
      new: new Set(),
      review: new Set(),
      mastered: new Set(),
      favorite: new Set()
    };
  }

  /** 从数据库读取各学习范围的完成集合；旧数据/异常数据按空集合处理 */
  async loadScopePass() {
    const saved = await this.db.getSetting('studyScopePass', null);
    this._scopePassDone = this._emptyScopePassDone();
    if (!saved || typeof saved !== 'object') return;

    // 旧版会把“这张卡学完后的状态 tab / 收藏 tab”也一起标记，
    // 导致在「新词」里学习时，已掌握/待复习/收藏被误判成已学完。
    // 这些具体 tab 的旧记录不可信，升级到 v2 时只保留「全部」的进度。
    const trusted = Number(saved.version) === SCOPE_PASS_VERSION;
    for (const scope of STUDY_SCOPE_VALUES) {
      if (!trusted && scope !== 'all') continue;
      const list = Array.isArray(saved[scope]) ? saved[scope] : [];
      for (const key of list) {
        if (key) this._scopePassDone[scope].add(String(key));
      }
    }
    if (!trusted) {
      // 写回 v2，避免每次启动都重复迁移
      await this.saveScopePass();
    }
  }

  /** 把各学习范围的完成集合落库（数组形式，便于 IndexedDB/JSON 存储） */
  async saveScopePass() {
    if (this._scopePassSaveTimer) {
      clearTimeout(this._scopePassSaveTimer);
      this._scopePassSaveTimer = null;
    }
    const out = { version: SCOPE_PASS_VERSION };
    for (const scope of STUDY_SCOPE_VALUES) {
      out[scope] = Array.from(this._scopePassDone[scope] || []);
    }
    await this.db.setSetting('studyScopePass', out);
  }

  /**
   * 学习过程中每张卡都整体序列化写库太重，这里防抖 1 秒；
   * 显示「已学完」、新增词条等关键节点会直接 await saveScopePass()。
   */
  scheduleSaveScopePass() {
    if (this._scopePassSaveTimer) clearTimeout(this._scopePassSaveTimer);
    this._scopePassSaveTimer = setTimeout(() => {
      this._scopePassSaveTimer = null;
      this.saveScopePass().catch((error) => {
        console.warn('[learn] 保存学习范围进度失败:', error);
      });
    }, 1000);
  }

  /** 某词条在当前学习范围内是否已经学过一遍 */
  isScopePassWordDone(word, scope = this.settings.studyScope) {
    const key = this.dictKeyOf(word);
    if (!key) return false;
    const done = this._scopePassDone[this.normalizeStudyScope(scope)];
    return Boolean(done && done.has(key));
  }

  /** 当前学习范围内还有多少词条没学过一遍 */
  countPendingScopeWords(pool, scope = this.settings.studyScope) {
    const list = Array.isArray(pool) ? pool : [];
    const done = this._scopePassDone[this.normalizeStudyScope(scope)];
    if (!done) return list.length;
    return list.filter((w) => {
      const key = this.dictKeyOf(w);
      return !key || !done.has(key);
    }).length;
  }

  /**
   * 一次学习动作完成后，把该词条记入「全部」和“当前正在学习的 tab”。
   *
   * 不能顺手记到这张卡学完后的状态 tab / 收藏 tab：
   * 例如在「新词」里点掌握，词条会变成已掌握；如果连「已掌握」也一起标记，
   * 用户之后切到「已掌握」范围时，会看到“已学完”而学不到这批新词。
   * 各具体 tab 只认“在这个 tab 里学过的卡”，互不串进度。
   */
  markScopePassDone(word) {
    const key = this.dictKeyOf(word);
    if (!key) return;
    const scopes = new Set(['all']);
    // 当前正在学习的 tab：例如「新词」里点掌握后词条会离开新词 tab，
    // 但它确实是在这一轮里学过的，记下来可以避免状态写库延迟导致 tab 又被判成“没学完”。
    const currentScope = this.normalizeStudyScope(this.settings.studyScope);
    if (currentScope) scopes.add(currentScope);
    for (const scope of scopes) {
      if (this._scopePassDone[scope]) this._scopePassDone[scope].add(key);
    }
    // 当前 tab 里，如果这张卡处理后已经离开该范围（如新词→已掌握），
    // 从缓存池里移除；这样红字提示里的【继续学习】按钮能准确判断还有没有词可学。
    if (currentScope && currentScope !== 'all' && !this.isWordInStudyScope(word, currentScope)) {
      const pool = this._scopePoolCache;
      if (Array.isArray(pool)) {
        const idx = pool.findIndex((w) => w.id === word.id);
        if (idx >= 0) pool.splice(idx, 1);
      }
    }
    this.scheduleSaveScopePass();
  }

  /**
   * 词条新加入某个 tab（词库改状态 / 新收藏 / 重新变成新词）时，
   * 把它从该 tab 的完成集合里移除，让 tab 重新变为“没学完”。
   */
  markScopePassPending(word, scopes = []) {
    const key = this.dictKeyOf(word);
    if (!key) return;
    for (const scope of scopes) {
      const s = this.normalizeStudyScope(scope);
      if (this._scopePassDone[s]) this._scopePassDone[s].delete(key);
    }
    this.scheduleSaveScopePass();
  }

  /** 清空各学习范围的“已学完”进度（清除学习记录时调用） */
  async resetScopePass() {
    this._scopePassDone = this._emptyScopePassDone();
    await this.saveScopePass();
  }

  /** 当前设置（全部/字/短语）对应的分类键列表；全部 = 字+短语 */
  activeScopeKeys() {
    const t = this.settings.dictImportType || 'all';
    if (t === 'phrase') return ['phrase'];
    if (t === 'word') return ['word'];
    return ['word', 'phrase'];
  }

  /** 词条归属的分类键；旧数据/示例词未标注时按当前展示范围兜底 */
  scopeKeyOfWord(w) {
    if (w && (w.dictScope === 'word' || w.dictScope === 'phrase')) return w.dictScope;
    const t = this.settings.dictImportType || 'all';
    return t === 'phrase' ? 'phrase' : 'word';
  }

  /** 词条是否属于当前学习/展示范围（字+短语词条常驻词库，仅按分类展示与学习） */
  isWordInActiveScope(w) {
    if (!w) return false;
    if (!w.dictScope) return (this.settings.dictImportType || 'all') === 'all';
    return this.activeScopeKeys().includes(w.dictScope);
  }

  /** 把任意值规范成合法的学习范围；非法/旧数据按「全部」处理 */
  normalizeStudyScope(value) {
    const scope = String(value == null ? '' : value).trim();
    return STUDY_SCOPE_VALUES.includes(scope) ? scope : 'all';
  }

  /** 学习范围的中文名（用于设置页、红色提示与 toast） */
  studyScopeLabel(value = this.settings.studyScope) {
    return STUDY_SCOPE_LABELS[this.normalizeStudyScope(value)] || STUDY_SCOPE_LABELS.all;
  }

  /** 当前是否选择了「全部」以外的具体范围（新词/待复习/已掌握/收藏） */
  isScopedStudyRange(value = this.settings.studyScope) {
    return this.normalizeStudyScope(value) !== 'all';
  }

  /**
   * 词条是否属于当前选择的学习范围。
   * 只负责「范围」这一层；是否属于当前词典（字/短语）仍由 isWordInActiveScope 判断。
   */
  isWordInStudyScope(word, scope = this.settings.studyScope) {
    if (!word) return false;
    switch (this.normalizeStudyScope(scope)) {
      case 'new':
        return (word.status || 'new') === 'new';
      case 'review':
        return word.status === 'review';
      case 'mastered':
        return word.status === 'mastered';
      case 'favorite':
        return Boolean(word.favorite);
      default:
        return true;
    }
  }

  /** 词条已被学习动作处理：不再需要「强制放进队列」的标记 */
  clearExternalScopeInclude(wordId) {
    if (this._externalScopeIncludeIds) this._externalScopeIncludeIds.delete(wordId);
  }

  /**
   * 词库菜单里手动改了当前「学习范围」的成员（状态标签或收藏）后调用。
   *
   * 学习范围按 tab 的“学完一遍”集合判断：用户刚在词库里把词条改成该状态时，
   * 要把它从该 tab 的完成集合里移除，否则会一直停在
   * 「已学完【待复习】，请切换范围」。
   *
   * 这里按最新范围重建队列，并把新进入范围的词条强制排到队首；
   * 今日进度、本轮起点与统计都不动（进度继续连续）。
   */
  async refreshScopedStudySessionAfterExternalChange(word, inScope) {
    if (!word || !this.isScopedStudyRange()) return false;

    const scope = this.normalizeStudyScope(this.settings.studyScope);
    const belongs = Boolean(inScope) && this.isWordInStudyScope(word, scope);
    this._externalScopeIncludeScope = scope;
    if (belongs) {
      // 新加入该 tab：从完成集合里移除，让它重新算作“没学过”
      this.markScopePassPending(word, [scope]);
      this._externalScopeIncludeIds.add(word.id);
    } else {
      this._externalScopeIncludeIds.delete(word.id);
    }

    // 旧队列/快照/红字状态都属于改动前的范围，直接丢弃；进度条与今日统计保持原值
    this._learnSessionSnapshot = null;
    this.todayWords = [];
    this.currentCardIndex = 0;
    this._queueHasFreshWords = true;
    this.clearCardDisplay();
    await this.db.setSetting('learnProgress', null);
    await this.saveScopePass();
    await this.prepareLearnSession();
    // 把重建后的队列落库：刷新页面/切换页面后，刚加入范围的词仍在队列里
    await this.saveLearnProgress();
    this.updateProgress();
    return true;
  }

  /**
   * 词条是否已经计入「今日已掌握 / 今日待复习」。
   *
   * 口径与 refreshStatusCounts() 里统计今日词条的条件逐字一致：
   *   状态是 mastered/review，且 lastStudied 落在今天。
   * 进度条用同一个判断决定「这张卡要不要推进度」，所以
   * 学完一轮后「进度条数字」与「今日已掌握 + 今日待复习」必然相等。
   */
  isWordCountedToday(word) {
    if (!word) return false;
    if (word.status !== 'mastered' && word.status !== 'review') return false;
    const studiedAt = Number(word.lastStudied);
    if (!Number.isFinite(studiedAt) || studiedAt <= 0) return false;
    return new Date(studiedAt).toDateString() === this.todayKey();
  }

  /**
   * 恢复今日队列时，把「当前卡片下标」推进到第一张今天还没学过的卡。
   *
   * 另一台设备可能学得比会话快：云端会话里的 currentCardIndex 还停在 50，
   * 但今日统计已经同步到 98/100。若直接按 50 恢复，用户会一直看到另一端
   * 已经学过的词，点「掌握」进度也不再增长（那些词今天已经计过数）。
   * 队列里还有没学过的词时，从保存的下标往后跳过已计入统计的卡；
   * 纯复习轮（整队都学过、进度本来就不该再涨）则保持原下标。
   */
  alignRestoredCardIndex(index, words) {
    const list = Array.isArray(words) ? words : [];
    const len = list.length;
    const start = Math.max(0, Math.min(Math.floor(Number(index) || 0), len));
    const hasFresh = list.some((w) => !this.isWordCountedToday(w));
    if (!hasFresh) return start;
    let next = start;
    while (next < len && this.isWordCountedToday(list[next])) next++;
    return next;
  }

  /**
   * 恢复会话时跳过「本轮已经学过一遍」的卡。
   * 学习范围是按 tab 的“学过一遍”进度判断的，与「今天是否计入统计」无关：
   * 待复习/已掌握/收藏里的词即使今天没计入统计，只要在本轮学过一遍，也不该重复出现。
   */
  alignRestoredScopeCardIndex(index, words, scope) {
    const list = Array.isArray(words) ? words : [];
    const len = list.length;
    const start = Math.max(0, Math.min(Math.floor(Number(index) || 0), len));
    const s = this.normalizeStudyScope(scope);
    const done = this._scopePassDone[s] || new Set();
    let next = start;
    while (next < len) {
      const key = this.dictKeyOf(list[next]);
      if (!key || !done.has(key)) break;
      next++;
    }
    return next;
  }

  /**
   * 「今天」的日期键。
   *
   * 用 nowMs()（同步可用时是服务端校准时间）而不是裸 Date.now()：
   * 词条的 lastStudied 也是用 nowMs() 写的，两边必须是同一时间基准，
   * 否则两端时钟有偏差时，「今天学过没有」的判断会跟着错位。
   */
  todayKey() {
    return new Date(this.nowMs()).toDateString();
  }

  /**
   * 当前时间（毫秒）。
   *
   * 云同步可用时用「服务端基准」的时间（本机时间 + 观测到的偏移）：
   * 词条的 lastStudied / syncUpdatedAt 既参与「今天学过没有」的统计判断，
   * 也参与跨设备的冲突判定 —— 两台设备系统时间差几十秒时，
   * 慢的那台刚学的记录会被另一台的旧记录盖掉，表现就是「两边都显示已同步、
   * 数字却不一样」。未登录 / 未配置同步时就是本机时间，行为与以前完全一致。
   */
  nowMs() {
    const cloud = window.CloudSync;
    if (cloud && typeof cloud.nowMs === 'function') {
      try {
        return cloud.nowMs();
      } catch (error) {
        /* 同步模块异常时退回本机时间，不影响学习 */
      }
    }
    return Date.now();
  }

  // 加载今日统计与累计统计（含首次升级迁移与每日跨天累加）
  async loadTodayStats() {
    const today = this.todayKey();
    const savedDate = await this.db.getSetting('statsDate', '');

    // 确保计数结构完整：{ word:{mastered,review}, phrase:{mastered,review} }
    const ensureShape = (obj) => ({
      word: {
        mastered: Number(obj && obj.word && obj.word.mastered) || 0,
        review: Number(obj && obj.word && obj.word.review) || 0
      },
      phrase: {
        mastered: Number(obj && obj.phrase && obj.phrase.mastered) || 0,
        review: Number(obj && obj.phrase && obj.phrase.review) || 0
      }
    });

    let scopeToday = await this.db.getSetting('scopeToday', null);
    let scopeTotal = await this.db.getSetting('scopeTotal', null);

    if (scopeToday === null || scopeTotal === null) {
      // —— 首次升级运行：把旧版全局计数迁移成按分类计数 ——
      const legacyToday = await this.db.getSetting('todayStats', { mastered: 0, review: 0, total: 0 });
      const legacyTotal = await this.db.getSetting('totalStats', { mastered: 0, review: 0 });
      if (savedDate && savedDate !== today) {
        // 跨天时先按旧逻辑把昨日今日计数并入累计，保持与用户已看到的数字衔接
        legacyTotal.mastered += legacyToday.mastered;
        legacyTotal.review += legacyToday.review;
        legacyToday.mastered = 0;
        legacyToday.review = 0;
      }

      scopeToday = this._emptyScopeStats();
      scopeTotal = this._emptyScopeStats();

      // 以词库中现有 mastered/review 记录的分类分布为权重拆分旧计数
      // （「全部」口径的合计保持不变，避免升级后累计数字跳变）
      const dist = this._emptyScopeStats();
      const words = await this.db.getAllWords();
      for (const w of words) {
        if (!w.dictScope || (w.dictScope !== 'word' && w.dictScope !== 'phrase')) continue;
        if (w.status !== 'mastered' && w.status !== 'review') continue;
        dist[w.dictScope][w.status]++;
      }
      const splitInto = (legacyVal, kind, target) => {
        if (!legacyVal) return;
        const wordN = dist.word[kind];
        const phraseN = dist.phrase[kind];
        const sum = wordN + phraseN;
        if (sum > 0) {
          const wordPart = Math.round((legacyVal * wordN) / sum);
          target.word[kind] = wordPart;
          target.phrase[kind] = legacyVal - wordPart;
        } else if (this.activeScopeKeys().length === 1) {
          target[this.activeScopeKeys()[0]][kind] = legacyVal;
        } else {
          // 无任何记录可参照：平均拆分到字、短语（合计不变）
          const wordPart = Math.floor(legacyVal / 2);
          target.word[kind] = wordPart;
          target.phrase[kind] = legacyVal - wordPart;
        }
      };
      splitInto(legacyTotal.mastered, 'mastered', scopeTotal);
      splitInto(legacyTotal.review, 'review', scopeTotal);
      splitInto(legacyToday.mastered, 'mastered', scopeToday);
      splitInto(legacyToday.review, 'review', scopeToday);
    } else {
      // 正常读取：先规范化再处理跨天累加
      scopeToday = ensureShape(scopeToday);
      scopeTotal = ensureShape(scopeTotal);
      if (savedDate !== today) {
        // 新的一天：把昨日各类别的今日统计并入该类别的累计
        for (const key of ['word', 'phrase']) {
          scopeTotal[key].mastered += scopeToday[key].mastered;
          scopeTotal[key].review += scopeToday[key].review;
        }
        scopeToday = this._emptyScopeStats();
      }
    }

    await this.db.setSetting('scopeToday', scopeToday);
    await this.db.setSetting('scopeTotal', scopeTotal);
    if (savedDate !== today) {
      await this.db.setSetting('statsDate', today);
    }

    this._scopeToday = ensureShape(scopeToday);
    this._scopeTotal = ensureShape(scopeTotal);
    this.syncActiveStatsMirrors();
    // 初始化时从数据库统计真实状态计数，供学习页累计统计显示
    await this.refreshStatusCounts();
  }

  async persistScopeStats() {
    await this.db.setSetting('scopeToday', this._scopeToday);
    await this.db.setSetting('scopeTotal', this._scopeTotal);
  }

  /** 把按分类的计数映射为当前展示范围（全部=字+短语合计）的今日/累计统计 */
  syncActiveStatsMirrors() {
    const keys = this.activeScopeKeys();
    let todayMastered = 0;
    let todayReview = 0;
    let totalMastered = 0;
    let totalReview = 0;
    for (const key of keys) {
      todayMastered += this._scopeToday[key].mastered;
      todayReview += this._scopeToday[key].review;
      totalMastered += this._scopeTotal[key].mastered;
      totalReview += this._scopeTotal[key].review;
    }
    this.todayStats.mastered = todayMastered;
    this.todayStats.review = todayReview;
    this.totalStats.mastered = totalMastered;
    this.totalStats.review = totalReview;
    // todayStats.total 是当日学习队列长度，由 prepareLearnSession 维护，此处不动
  }

  /**
   * 更新词库页顶部的范围统计行，显示各分类的词条总数：
   *   全部（5794） · 字（3828） · 短语（1966），当前词典范围高亮
   * 词库数据变化时（导入、删除、编辑、词典范围切换、进入词库页）调用。
   */
  async updateDictTypeSelectLabels() {
    const allWords = await this.db.getAllWords();
    let wordCount = 0, phraseCount = 0;
    for (const w of allWords) {
      if (w.dictScope === 'word') wordCount++;
      else if (w.dictScope === 'phrase') phraseCount++;
      else if (!w.dictScope) {
        // 兜底：没有 dictScope 的旧词条粗略归类
        const t = String(w.word || '').trim();
        if (/^[\u4e00-\u9fa5]$/.test(t)) wordCount++;
        else phraseCount++;
      }
    }
    const totalCount = allWords.length;

    const labels = { all: '全部', word: '字', phrase: '短语' };
    const counts = { all: totalCount, word: wordCount, phrase: phraseCount };
    const current = this.settings.dictImportType || 'all';

    // 只更新词库页顶部统计行（设置页下拉框保持原样：全部/短语/字）
    const scopeCountsEl = document.getElementById('dictScopeCounts');
    if (scopeCountsEl) {
      const items = ['all', 'word', 'phrase'].map((key) => {
        const cls = key === current ? 'scope-active' : '';
        return `<span class="${cls}">${labels[key]}（${counts[key]}）</span>`;
      });
      scopeCountsEl.innerHTML = items.join('<span class="scope-sep">·</span>');
    }
  }

  /**
   * 从数据库实时统计当前词典范围的学习状态。
   * 今日统计“今天学习过、且当前状态为 mastered/review”的词条，
   * 累计统计当前所有 mastered/review 词条。
   *
   * 这是学习统计的唯一口径：词条状态一变就整体重算，而不是在旧数字上做加减。
   * 否则把同一张卡先点「掌握」再点「陌生」时，掌握数不会因为状态改变而回退，
   * 两个数字会同时虚增（今日已掌握/累计已掌握各多 1，今日待复习/累计待复习各多 1）。
   *
   * 用 in-flight 队列串行化：连续操作时避免并发读库拿到旧状态，
   * 且在飞期间新来的请求排在上一次之后，保证最终数字对应最新状态。
   */
  refreshStatusCounts() {
    const run = async () => {
      const allWords = await this.db.getAllWords();
      const scoped = allWords.filter((w) => this.isWordInActiveScope(w));
      // 顺手重建「同一个词」的分组索引，供学习动作把状态同步给同词的其它义项
      this.rebuildDictKeyIndex(allWords);
      // 「今天」的判断与词条 lastStudied 用同一时间基准（同步可用时是服务端校准时间）
      const now = new Date(this.nowMs());
      const today = this._emptyScopeStats();
      const total = this._emptyScopeStats();

      // 本次只重算「当前词典范围」覆盖的分类，另一个分类沿用已有计数。
      // 否则每次学习/清除都会把另一个范围（当前是「字」时的「短语」）的统计一起抹成 0，
      // 而「按范围清除」的要求正是另一个范围完全不受影响。
      const activeKeys = this.activeScopeKeys();
      for (const key of ['word', 'phrase']) {
        if (activeKeys.includes(key)) continue;
        today[key] = { ...this._scopeToday[key] };
        total[key] = { ...this._scopeTotal[key] };
      }

      for (const word of scoped) {
        if (word.status !== 'mastered' && word.status !== 'review') continue;

        const key = this.scopeKeyOfWord(word);
        total[key][word.status]++;

        const studiedAt = Number(word.lastStudied);
        if (Number.isFinite(studiedAt) && new Date(studiedAt).toDateString() === now.toDateString()) {
          today[key][word.status]++;
        }
      }

      this._scopeToday = today;
      this._scopeTotal = total;
      this.syncActiveStatsMirrors();
      this._statsReady = true;
      // 这一次统计是刚读完库算出来的新快照，之前的「可能落后」标记作废
      this._statsMayBeStale = false;
      // 累计统计 = 当前词典范围内各状态的真实词条数（与词库页筛选结果一致）。
      // 取镜像值而不是把两个分类相加，否则「沿用」的另一个分类会被算进来
      this._cachedStatusCounts = {
        mastered: this.totalStats.mastered,
        review: this.totalStats.review
      };
      // 进度条数字与「今日已掌握 + 今日待复习」同源：都由上面的今日词条数减本轮起点得出，
      // 因此学完一批卡后两者永远相等（不会再出现差 1~2 个的情况）
      this.syncTodayDoneFromStats();
      await this.saveTodayDoneCount();
      this.updateProgress();
      await this.persistScopeStats();
    };

    this._statusCountsChain = (this._statusCountsChain || Promise.resolve()).then(run, run);
    return this._statusCountsChain;
  }

  /**
   * 今日队列里（当前卡之后，含当前卡）还有多少「今天还没计入统计」的词条。
   * 只用于判断「今天可学的词条是不是已经学完」以及完成页文案，
   * **不参与进度条分母** —— 上方的目标数值永远只等于设置页里的每日目标。
   */
  remainingFreshInQueue() {
    if (!Array.isArray(this.todayWords) || this.todayWords.length === 0) return 0;
    const start = Math.max(0, Math.min(Number(this.currentCardIndex) || 0, this.todayWords.length));
    let count = 0;
    for (let i = start; i < this.todayWords.length; i++) {
      if (!this.isWordCountedToday(this.todayWords[i])) count++;
    }
    return count;
  }

  /**
   * 清空今日与累计统计（设置页「清除」时调用）。
   * keys 省略 = 两个分类都清；传入 ['word'] / ['phrase'] 时只清对应分类的计数，
   * 这样按词典范围清除时，另一个范围（例如当前是「字」时的「短语」）的数字原样保留。
   */
  async resetScopeStats(keys = ['word', 'phrase']) {
    for (const key of keys) {
      if (!this._scopeToday[key] || !this._scopeTotal[key]) continue;
      this._scopeToday[key] = { mastered: 0, review: 0 };
      this._scopeTotal[key] = { mastered: 0, review: 0 };
    }
    await this.persistScopeStats();
    this.syncActiveStatsMirrors();
  }


  /**
   * 统一绑定「点击 + 触摸」：移动端 touchstart 先触发（preventDefault 会阻断
   * 随后合成的 click，同一动作只执行一次），桌面端走 click。
   * 与原先「click / touchstart 各写一份」完全等价；
   * preventTouch=false 用于不能阻断触摸默认行为的元素（如模态框遮罩）。
   */
  _bindTap(el, handler, preventTouch = true) {
    if (!el) return;
    el.addEventListener('click', handler);
    el.addEventListener('touchstart', (e) => {
      if (preventTouch) e.preventDefault();
      handler(e);
    }, { passive: false });
  }

  /**
   * 绑定全局事件（只在启动时绑定一次）：
   * 底部导航切换、弹窗关闭、首页统计数字点击、保存单词按钮、
   * 卡片点击翻面、收藏按钮（同时监听 click 与 touchstart 并去重）、
   * 卡片滑动手势、学习页三个操作按钮；设置页与词库页的事件分别委托给
   * bindSettingsEvents() / bindLibraryEvents()。
   */
  bindEvents() {
    const self = this;
    
    // 导航切换
    this._bindTap(document.querySelector('.bottom-nav'), handleNavClick);

    /** 导航点击处理（使用事件委托，确保点击文字/图标均可触发） */
    function handleNavClick(e) {
      e.preventDefault();
      // 使用 closest 确保获取到正确的 nav-item 元素
      const navItem = e.target.closest('.nav-item');
      if (navItem) {
        const page = navItem.dataset.page;
        self.switchPage(page);
        // 切换到设置页后更新滑块 disabled 状态
        if (page === 'settings') {
          setTimeout(() => {
            if (self.currentPage === 'settings') {
              self.refreshGoalSliderLockedState();
            }
          }, 100);
        }
      }
    }

    // 模态框关闭（遮罩层不阻断触摸默认行为，避免影响遮罩上的手势）
    document.querySelectorAll('.modal-overlay').forEach(el => {
      this._bindTap(el, (e) => {
        if (e.target === el) self.closeModals();
      }, false);
    });

    // 关闭按钮
    document.querySelectorAll('.modal-close').forEach(el => {
      this._bindTap(el, () => self.closeModals());
    });
    
    // 统计数字点击跳转：前两项是今日口径（带“只看今天学过”筛选），后两项是累计口径
    [
      ['statMastered', 'mastered', false],
      ['statReview', 'review', false],
      ['totalMastered', 'mastered', true],
      ['totalReview', 'review', true]
    ].forEach(([id, filter, total]) => {
      this._bindTap(document.getElementById(id), () =>
        total ? self.handleTotalStatClick(filter) : self.handleStatClick(filter)
      );
    });

    // 保存单词表单
    this._bindTap(document.getElementById('saveWordBtn'), () => self.saveWord());

    // 卡片单击翻面（桌面鼠标走这里；触屏的翻面在 initCardSwipe 的 touchend 里）
    const flashcard = document.getElementById('flashcard');
    this._bindCardFlipGesture(flashcard, () => self.flipCard());

    // Shift 键 = 点一下卡片（正面↔背面）。学习页与练习页都支持，
    // 统一在这里处理，避免两处监听把同一次按键翻两次。
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Shift' || e.repeat) return; // 长按不连续翻面
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // 真正的输入场景（词库搜索框、登录弹窗等可编辑控件）里不抢 Shift
      const target = e.target;
      const tag = target && target.tagName ? target.tagName.toLowerCase() : '';
      const editing = (tag === 'input' && !target.readOnly) ||
        tag === 'textarea' ||
        Boolean(target && target.isContentEditable);
      if (editing) return;

      if (self.currentPage === 'learn') {
        // 取消尚未执行的「单击翻面」：否则这次 Shift 会和上一次点击叠加成翻两下
        self._cancelPendingCardFlip();
        self.flipCard();
      } else if (self.currentPage === 'practice') {
        self._cancelPendingCardFlip();
        self.flipPracticeCard();
      }
    });
    
    // 学习页快捷键：Y = 掌握 / N = 陌生 / P = 跳过（不区分大小写）。
    // 只看学习页，避免和练习页的字母输入冲突；输入框 / 可编辑区域里不抢键。
    document.addEventListener('keydown', (e) => {
      if (self.currentPage !== 'learn') return;
      if (e.repeat || e.isComposing) return;            // 长按、输入法组合中不触发
      if (e.ctrlKey || e.metaKey || e.altKey) return;   // 不拦 Ctrl+Y 这类浏览器快捷键
      const target = e.target;
      const tag = target && target.tagName ? target.tagName.toLowerCase() : '';
      const editing = (tag === 'input' && !target.readOnly) ||
        tag === 'textarea' ||
        Boolean(target && target.isContentEditable);
      if (editing) return;

      // 用 key 的小写形式判断：Y / y 都算（Shift+Y 也一样）
      const key = String(e.key || '').toLowerCase();
      if (key === 'y') {
        e.preventDefault();
        self.markMastered();
      } else if (key === 'n') {
        e.preventDefault();
        self.markDifficult();
      } else if (key === 'p') {
        e.preventDefault();
        self.skipCard();
      }
    });

    // 收藏按钮：移动端会先 touchstart 再合成 click；document 默认 passive 导致 preventDefault 无效，
    // 会连续触发两次。用 passive:false + 短时间忽略紧随其后的 click。
    let lastFavoriteTouchTs = 0;

    document.addEventListener('click', handleFavoriteClick);
    document.addEventListener('touchstart', handleFavoriteClick, { passive: false });

    function handleFavoriteClick(e) {
      const btn = e.target.closest('.favorite-btn');
      if (!btn) return;
      const isVisible = window.getComputedStyle(btn).display !== 'none';
      if (!isVisible) return;

      e.stopPropagation();
      if (e.type === 'click') {
        if (Date.now() - lastFavoriteTouchTs < 450) {
          if (e.cancelable) e.preventDefault();
          return;
        }
        self.toggleFavorite();
        return;
      }
      lastFavoriteTouchTs = Date.now();
      if (e.cancelable) e.preventDefault();
      self.toggleFavorite();
    }
    
    // 卡片滑动 + 触屏长按取词（学习卡支持左右滑动切卡）
    this.initCardSwipe(flashcard, () => self.flipCard(), true);

    // 卡片文字长按/拖选复制（与滑动、翻面互斥）
    this.initCardTextSelection(flashcard);
    
    // 操作按钮（陌生 / 跳过 / 掌握）与学习页的【继续学习】
    [['btnDifficult', 'markDifficult'],
     ['btnSkip', 'skipCard'],
     ['btnMastered', 'markMastered']].forEach(([id, method]) => {
      this._bindTap(document.getElementById(id), () => self[method]());
    });
    this._bindTap(document.getElementById('restartBtn'), () => self.restartLearn());

    // 「已学完【…】，是否继续？」下方的蓝色【继续学习】：
    // 只重置当前学习范围的“学过一遍”进度，继续在同一个范围内学习
    this._bindTap(document.getElementById('scopeRestartBtn'), () => self.restartScopeLearn());

    // 设置相关
    this.bindSettingsEvents();
    
    // 搜索和筛选
    this.bindLibraryEvents();

    // 练习页（范围下拉、输入模式、卡片翻转、音标输入框）
    this.bindPracticeEvents();

    // 窗口尺寸变化（旋屏、改窗口大小）后重新量一次当前可见页面的卡片区位置
    window.addEventListener('resize', () => {
      this.syncPracticeCardHeight();
    });
    
  }
  
  /** 词库页事件：搜索框输入/清空、状态筛选标签（全部/新词/待复习/已掌握/收藏）、分类下拉多选 */
  bindLibraryEvents() {
    const searchInput = document.getElementById('searchInput');
    const searchClearBtn = document.getElementById('searchClearBtn');
    
    searchInput.addEventListener('input', (e) => {
      this.searchQuery = e.target.value.toLowerCase();
      searchClearBtn.style.display = this.searchQuery ? 'flex' : 'none';
      this.resetPageNum();
      this.renderLibrary();
    });
    
    searchClearBtn.addEventListener('click', () => {
      searchInput.value = '';
      this.searchQuery = '';
      searchClearBtn.style.display = 'none';
      this.resetPageNum();
      this.renderLibrary();
    });
    
    document.querySelectorAll('.filter-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.filterStatus = tab.dataset.filter;
        // 手动切换选项卡 = 看累计口径，清除“今日已掌握/今日待复习”带过来的今日筛选
        this.resetLibraryTodayFilter();
        this.resetPageNum();
        this.renderLibrary();
      });
    });
    
    // 分类下拉多选
    const dropdown = document.getElementById('categoryDropdown');
    const dropdownTrigger = dropdown.querySelector('.dropdown-trigger');
    const categoryAll = document.getElementById('category-all');
    
    dropdownTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('active');
    });
    
    // 点击其他地方关闭下拉
    document.addEventListener('click', (e) => {
      if (!dropdown.contains(e.target)) {
        dropdown.classList.remove('active');
      }
    });
    
    // 全选/取消全选
    categoryAll.addEventListener('change', (e) => {
      const checkboxes = document.querySelectorAll('#categoryOptions input[type="checkbox"]');
      checkboxes.forEach(cb => {
        cb.checked = e.target.checked;
      });
      this.updateSelectedCategories();
    });
    
    // 分类选项变化
    document.addEventListener('change', (e) => {
      if (e.target.dataset.category) {
        const allChecked = document.querySelectorAll('#categoryOptions input[type="checkbox"]:checked').length;
        const allTotal = document.querySelectorAll('#categoryOptions input[type="checkbox"]').length;
        categoryAll.checked = allChecked === allTotal && allTotal > 0;
        this.updateSelectedCategories();
      }
    });
  }
  
  // 更新选中的分类
  updateSelectedCategories() {
    const checkedBoxes = document.querySelectorAll('#categoryOptions input[type="checkbox"]:checked');
    this.selectedCategories = Array.from(checkedBoxes).map(cb => cb.dataset.category);
    
    this.updateCategoryLabel();
    
    this.resetPageNum();
    this.renderLibrary();
  }

  /** 设置页「词典导入」对应的展示文字：全部 / 字 / 短语 */
  getDictScopeLabel() {
    const t = this.settings.dictImportType || 'all';
    if (t === 'word') return '字';
    if (t === 'phrase') return '短语';
    return '全部';
  }

  /**
   * 分类下拉框触发按钮的文字：
   * - 默认显示当前词典范围（全部 / 字 / 短语）+ 当前选项卡的词条数量，如「字（27）」；
   * - 仅当用户精确勾选了某一个分类时才显示该分类名 + 数量。
   *
   * 数量用与 renderLibrary 完全相同的筛选条件（applyLibraryFilters）现算，
   * 因此「标签上的数字」永远等于「列表里的条目数」，切换选项卡/开关今日筛选、
   * 切换词典范围或分类勾选后都会同步。
   */
  async updateCategoryLabel() {
    const label = document.getElementById('categoryLabel');
    if (!label) return;

    const boxes = document.querySelectorAll('#categoryOptions input[type="checkbox"]');
    const checkedBoxes = document.querySelectorAll('#categoryOptions input[type="checkbox"]:checked');

    let name;
    if (boxes.length > 0 && checkedBoxes.length === 1) {
      name = checkedBoxes[0].dataset.category;
    } else {
      name = this.getDictScopeLabel();
    }

    // 先按已知结果刷新，避免等待读库期间数字停留在上一次选项卡的值
    const known = typeof this._libraryTabCount === 'number' ? this._libraryTabCount : null;
    label.textContent = known === null ? name : `${name}（${known}）`;

    const allWords = await this.db.getAllWords();
    const fresh = this.applyLibraryFilters(allWords).length;
    this._libraryTabCount = fresh;
    label.textContent = `${name}（${fresh}）`;
  }
  
  // 渲染分类选项（仅当前展示分类内的词条；词典短语/字不设单独勾选项）
  async renderCategoryOptions() {
    // 进入词库页时先清掉上一次的计数，避免下拉按钮短暂显示过期数字；
    // 真正的数量由随后的 renderLibrary / updateCategoryLabel 现算并写入
    this._libraryTabCount = null;
    const words = (await this.db.getAllWords()).filter((w) => this.isWordInActiveScope(w));

    // 统计每个分类在当前词典范围内的词条数。
    // 之前这个数字显示在词库列表每个分类的小标题上（aa (12)），
    // 现在小标题取消了，数量挪到下拉选项里显示成「aa（12）」。
    const countByCategory = new Map();
    for (const w of words) {
      const cat = w.category || '未分类';
      countByCategory.set(cat, (countByCategory.get(cat) || 0) + 1);
    }
    const categories = [...countByCategory.keys()];
    const container = document.getElementById('categoryOptions');

    const allLabel = document.getElementById('category-all-label');
    if (allLabel) {
      allLabel.textContent = `全部分类 (${categories.length})`;
    }

    container.innerHTML = categories
      .map(
        (cat) => `
      <label class="dropdown-item">
        <input type="checkbox" data-category="${this.escapeHtml(cat)}">
        <span>${this.escapeHtml(cat)}（${countByCategory.get(cat) || 0}）</span>
      </label>
    `
      )
      .join('');

    if (this.selectedCategories && this.selectedCategories.length > 0) {
      document.querySelectorAll('#categoryOptions input[type="checkbox"]').forEach((cb) => {
        cb.checked = this.selectedCategories.includes(cb.dataset.category);
      });
      const allChecked = document.querySelectorAll('#categoryOptions input[type="checkbox"]:checked').length;
      const allTotal = document.querySelectorAll('#categoryOptions input[type="checkbox"]').length;
      document.getElementById('category-all').checked = allChecked === allTotal && allTotal > 0;
    } else {
      document.querySelectorAll('#categoryOptions input[type="checkbox"]').forEach((cb) => {
        cb.checked = true;
      });
      document.getElementById('category-all').checked = categories.length > 0;
      this.selectedCategories = [...categories];
    }

    // 默认文字跟随当前词典范围（全部/字/短语）
    this.updateCategoryLabel();
  }
  
  // 重置页码
  resetPageNum() {
    this.currentPageNum = 1;
  }

  /** Fisher–Yates：用于在全库范围内随机当日学习队列 */
  shuffleArray(arr) {
    const a = arr;
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /**
   * 随机模式下尽量让相邻词条分类不同：每步在剩余词中优先随机挑选与上一张分类不同的词。
   */
  pickRandomSpreadByCategory(sourcePool, maxCount) {
    const pool = [...sourcePool];
    this.shuffleArray(pool);
    const out = [];
    const n = Math.min(maxCount, pool.length);
    const catOf = (w) => (w.category || '未分类');

    for (let k = 0; k < n; k++) {
      const lastCat = out.length ? catOf(out[out.length - 1]) : null;
      let candidates = [];
      for (let i = 0; i < pool.length; i++) {
        if (catOf(pool[i]) !== lastCat) candidates.push(i);
      }
      if (candidates.length === 0) {
        candidates = pool.map((_, i) => i);
      }
      const pickIdx = candidates[Math.floor(Math.random() * candidates.length)];
      out.push(pool.splice(pickIdx, 1)[0]);
    }
    return out;
  }

  /**
   * 每日目标是否禁止修改。
   *
   * 以前学习进行中会锁住滑块，结果用户想改目标却改不了，学习页还停在旧目标上
   * （甚至冒出【继续学习】）。现在改为随时可改：改完立即按新目标重建队列，
   * 学习页的分母与目标文案都跟着设置页走。
   */
  isDailyGoalSliderLocked() {
    return false;
  }

  /** 按 isDailyGoalSliderLocked() 的结果启用/禁用每日目标滑块，并同步显示数值 */
  refreshGoalSliderLockedState() {
    const goalSlider = document.getElementById('goalSlider');
    const goalValue = document.getElementById('goalValue');
    if (!goalSlider || !goalValue) return;
    const locked = this.isDailyGoalSliderLocked();
    goalSlider.disabled = locked;
    goalSlider.style.opacity = locked ? '0.5' : '1';
    goalSlider.style.cursor = locked ? 'not-allowed' : 'pointer';
    goalSlider.style.pointerEvents = locked ? 'none' : '';
    goalSlider.value = String(this.settings.dailyGoal);
    goalValue.textContent = String(this.settings.dailyGoal);
  }

  /** 词典导入/范围切换后：分类下拉勾选当前展示分类下的全部真实分类（等同于「全部」） */
  async syncLibraryCategoryFilterToDictType() {
    const words = (await this.db.getAllWords()).filter((w) => this.isWordInActiveScope(w));
    const userCats = [...new Set(words.map((w) => w.category || '未分类'))];
    this.selectedCategories = [...userCats];
  }

  /** language 列标明粤语时，卡片音标优先展示粤拼 */
  isImportedCantoneseLanguage(word) {
    const raw = String(word?.language || '').trim();
    if (!raw) return false;
    const low = raw.toLowerCase();
    return (
      /粤语|广东话|粤語|廣東話/i.test(raw) ||
      low === 'cantonese' ||
      low === 'yue' ||
      low === 'zh-yue'
    );
  }

  /**
   * 设置页事件绑定：每日目标滑块、学习模式、
   * 卡片释义优先、分类显示、显示释义、音标渐显时长、重复频率、
   * 清除进度、词典范围切换、练习设置。
   * 每个开关改动后都会立即写入数据库（setSetting），并按需刷新当前界面。
   */
  bindSettingsEvents() {
    const self = this;
    
    // 每日目标滑块
    const goalSlider = document.getElementById('goalSlider');
    const goalValue = document.getElementById('goalValue');
    
    const updateGoalSliderState = () => self.refreshGoalSliderLockedState();
    
    goalSlider.addEventListener('input', () => {
      if (self.isDailyGoalSliderLocked()) return;
      goalValue.textContent = goalSlider.value;
    });
    goalSlider.addEventListener('change', async () => {
      const nextGoal = Math.max(1, parseInt(goalSlider.value) || 100);
      if (nextGoal === self.settings.dailyGoal) {
        self.refreshGoalSliderLockedState();
        return;
      }

      self.settings.dailyGoal = nextGoal;
      await self.db.setSetting('dailyGoal', nextGoal);

      // 目标换了，「今天已完成过目标」的判定要按新目标重来
      self._todayGoalReachedDate = '';
      self._todayGoalReachedGoal = 0;
      await self.db.setSetting('todayGoalReached', null);

      // 队列长度跟着新目标变：丢掉旧进度与切页快照，按新目标重建队列。
      // 本轮起点保持不变 —— 已经学过的进度不丢，只是分母变大/变小，
      // 学习页上方的目标数字立即变成设置页里的新值。
      self._learnSessionSnapshot = null;
      await self.db.setSetting('learnProgress', null);
      await self.prepareLearnSession();
      self.updateProgress();
      self.refreshGoalSliderLockedState();
      self.showToast('每日目标已更新为 ' + nextGoal);
    });
    
    // ---------- 学习范围 ----------
    // 只重建学习队列，不重置「本轮起点」：切换范围后今日进度继续连续（如 20/100 → 21/100）
    const studyScopeSelect = document.getElementById('studyScopeSelect');
    if (studyScopeSelect) {
      studyScopeSelect.value = this.normalizeStudyScope(this.settings.studyScope);
      studyScopeSelect.addEventListener('change', async () => {
        const nextScope = self.normalizeStudyScope(studyScopeSelect.value);
        if (nextScope === self.settings.studyScope) return;

        self.settings.studyScope = nextScope;
        await self.db.setSetting('studyScope', nextScope);
        // 强制入队标记只对上一个范围有效
        self._externalScopeIncludeIds.clear();
        self._externalScopeIncludeScope = nextScope;

        // 旧队列/快照属于上一个范围，直接丢弃；进度条与今日统计保持原值
        self._learnSessionSnapshot = null;
        self.todayWords = [];
        self.currentCardIndex = 0;
        self._queueHasFreshWords = true;
        self.clearCardDisplay();
        await self.db.setSetting('learnProgress', null);

        await self.prepareLearnSession();
        self.updateProgress();
        self.showToast(`学习范围已切换为「${self.studyScopeLabel(nextScope)}」`);
      });
    }

    // 学习模式
    document.querySelectorAll('.mode-option').forEach(option => this._bindTap(option, handleModeClick));
    
    async function handleModeClick(e) {
      e.preventDefault();
      const option = e.currentTarget;
      document.querySelectorAll('.mode-option').forEach(o => o.classList.remove('active'));
      option.classList.add('active');
      self.settings.learnMode = option.dataset.mode;
      await self.db.setSetting('learnMode', self.settings.learnMode);
      // 立即按当前模式重建当日队列（含随机打散），不依赖进度是否为 0
      await self.prepareLearnSession();
      self.showToast(self.settings.learnMode === 'random' ? '已切换为随机模式' : '已切换为顺序模式');
    }

    // 三个同构开关：卡片翻转 / 分类显示 / 显示释义（「显示调值」逻辑特殊，单独在下面绑定）
    const bindSettingToggle = (id, key, after) => {
      const toggle = document.getElementById(id);
      if (!toggle) return;
      const handler = async (e) => {
        e.preventDefault();
        toggle.classList.toggle('active');
        const value = toggle.classList.contains('active');
        self.settings[key] = value;
        await self.db.setSetting(key, value);
        if (after) await after();
      };
      toggle.addEventListener('click', handler);
      toggle.addEventListener('touchstart', handler);
    };

    const refreshLearnCard = () => {
      if (self.currentPage === 'learn' && self.todayWords.length > 0) {
        self.showCard(self.currentCardIndex);
      }
    };
    bindSettingToggle('cardDefinitionFirstToggle', 'cardDefinitionFirst', refreshLearnCard);
    bindSettingToggle('categoryDisplayToggle', 'categoryDisplay', refreshLearnCard);
    // 显示释义（只控制词库列表卡片，查看单词弹窗始终显示释义）
    bindSettingToggle('meaningDisplayToggle', 'meaningDisplay', async () => {
      if (self.currentPage === 'library') await self.renderLibrary();
    });

    // ---------- 练习设置（练习页的范围与调值开关都在这里） ----------
    const practiceScopeSelect = document.getElementById('practiceScopeSelect');
    if (practiceScopeSelect) {
      practiceScopeSelect.addEventListener('change', async () => {
        self.settings.practiceScope = practiceScopeSelect.value || 'all';
        await self.db.setSetting('practiceScope', self.settings.practiceScope);
        // 范围变了：练习队列与进度条分母都要重来（下次进练习页时会自动重建）
        self._practicePoolKey = null;
        self.practiceWords = [];
        self._practiceScopeTotal = 0;
        self.refreshPracticeProgressUI();
        const label = self.settings.practiceScope === 'phrase' ? '短语'
          : (self.settings.practiceScope === 'word' ? '字' : '全部');
        self.showToast(`练习范围已切换为「${label}」`);
      });
    }

    const practiceToneToggle = document.getElementById('practiceToneToggle');
    if (practiceToneToggle) {
      practiceToneToggle.addEventListener('click', handlePracticeToneToggle);
      practiceToneToggle.addEventListener('touchstart', handlePracticeToneToggle);
    }

    async function handlePracticeToneToggle(e) {
      e.preventDefault();
      const toggle = document.getElementById('practiceToneToggle');
      toggle.classList.toggle('active');
      // 开关开启 = 含调值（调值数字必须输入正确）；关闭 = 只输入字母
      self.settings.practiceToneMode = toggle.classList.contains('active') ? 'with' : 'without';
      await self.db.setSetting('practiceToneMode', self.settings.practiceToneMode);
      self.showToast(self.settings.practiceToneMode === 'with'
        ? '已开启：调值需要输入正确'
        : '已关闭：只需输入字母');
      // 正在练习页时立刻按新口径重算当前题目的目标音标
      if (self.currentPage === 'practice') {
        self.applyPracticeTargets();
        self.resetPracticeInput();
      }
    }

    // 音标渐显设置
    const phoneticDelaySelect = document.getElementById('phoneticDelaySelect');
    if (phoneticDelaySelect) {
      phoneticDelaySelect.value = self.settings.phoneticDelay.toString();
      phoneticDelaySelect.addEventListener('change', async (e) => {
        self.settings.phoneticDelay = parseInt(e.target.value, 10);
        await self.db.setSetting('phoneticDelay', self.settings.phoneticDelay);
        self.showToast(`音标渐显延迟已设置为 ${self.settings.phoneticDelay} 秒`);
      });
    }

    // 重复频率设置
    const repeatFrequencySelect = document.getElementById('repeatFrequencySelect');
    if (repeatFrequencySelect) {
      repeatFrequencySelect.value = self.settings.repeatFrequency.toString();
      repeatFrequencySelect.addEventListener('change', async (e) => {
        self.settings.repeatFrequency = parseInt(e.target.value, 10);
        await self.db.setSetting('repeatFrequency', self.settings.repeatFrequency);
        self.showToast(`重复频率已设置为 ${self.settings.repeatFrequency} 天`);
      });
    }

    // 清除进度按钮
    this._bindTap(document.getElementById('clearProgressBtn'), () => self.clearProgress());
    
    // 词典类型选择事件
    const dictTypeSelect = document.getElementById('dictTypeSelect');
    if (dictTypeSelect) {
      dictTypeSelect.addEventListener('change', async () => {
        const newType = dictTypeSelect.value;

        // 字（word）与短语（phrase）的词条始终全量常驻词库并保留各自学习记录，
        // 切换范围只是改变“当前学习/展示/统计的分类”，不删除任何词条、不清空任何记录
        self.settings.dictImportType = newType;

        // 先同步丢掉旧范围的会话（快照 / 队列 / 下标）并清空卡片文字，再去做异步的落库与重建。
        // 否则用户在下面任意一个 await 期间点回「学习」，都会先恢复或看到旧范围（如「字」）的卡片。
        self._learnSessionSnapshot = null;
        self.todayWords = [];
        self.currentCardIndex = 0;
        self._externalScopeIncludeIds.clear();
        self.clearCardDisplay();

        try {
          await self.db.setSetting('dictImportType', newType);

          // 按当前分类重新映射统计数字（全部 = 字 + 短语）
          self.syncActiveStatsMirrors();

          // 词典范围已变更，重新统计真实状态计数
          await self.refreshStatusCounts();

          // 学习队列按新范围重建，清除会话缓存，避免返回学习页时恢复旧范围的队列
          await self.db.setSetting('learnProgress', null);
          // 换了词典范围，进度条的口径也换了，累计数一并归零
          await self.resetTodayDoneCount();

          // 词库页展示范围已变化，同步分类勾选并刷新列表
          await self.syncLibraryCategoryFilterToDictType();
          await self.renderCategoryOptions();
          if (self.currentPage === 'library') {
            await self.renderLibrary();
          }

          // 按新范围重建今日队列并渲染；currentPage 为学习页时这一步就是用户看到的卡片
          await self.prepareLearnSession();

          self.showToast('词典已更新');
        } catch (error) {
          console.error('[dict] 切换词典范围失败:', error);
          self.showToast('切换词典范围失败，请重试');
        }
      });
    }

    updateGoalSliderState();
  }

  /** 把当前设置应用到界面：练习设置控件、练习进度、字号等 */
  applySettings() {
    // 设置页「练习设置」的控件取库里的设置值
    this.refreshPracticeSettingsControls();
    // 云同步可能刚合并了练习进度：进度条跟着刷新（总数由进入练习页时算好）
    this.refreshPracticeProgressUI();

    const fontSizes = { small: '14px', medium: '16px', large: '20px' };
    document.documentElement.style.setProperty('--font-size-md', fontSizes[this.settings.fontSize] || '16px');
  }

  /**
   * 初始化卡片的触摸手势（移动端）：
   * - 短按（<500ms 且未移动）：翻转卡片（onFlip）；
   * - 长按（≥450ms 且未移动）：让位给系统取词复制，松手不翻面；
   * - 向左滑超过 80px：标记“已掌握”；
   * - 向右滑超过 80px：跳过当前词（移到队尾）；
   * - 其余情况：卡片回弹原位。
   * 滑动过程中让卡片跟手平移并轻微旋转。
   *
   * allowSwipe = false 时只保留「短按翻面 + 长按取词 + 拖动选字」这三支，
   * 不做位移与切卡（练习卡没有左右滑动，其余手感与学习卡完全一致）。
   */
  initCardSwipe(card, onFlip, allowSwipe = true) {
    card = card || document.getElementById('flashcard');
    if (!card) return;
    let startX = 0, startY = 0, currentX = 0;
    let isDragging = false;
    let isClick = true;
    let touchStartTime = 0;
    let longPressTimer = null;
    /** 背部长按取到的文字：touchend（带用户手势）时才真正写剪贴板 */
    let longPressCopyText = '';

    const self = this;

    const clearLongPressTimer = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    card.addEventListener('touchstart', (e) => {
      // 检查是否点击了收藏按钮
      const target = e.target;
      if (
        target.closest('.favorite-btn') ||
        target.closest('.language-badge')
      ) {
        isDragging = false;
        return;
      }

      // 已有选中文字：这一次触摸只用于取消选中（长按/拖选后的常见收尾动作），
      // 既不翻面也不滑动，同时吞掉随后合成的 click
      if (self._hasTextSelection()) {
        window.getSelection().removeAllRanges();
        self._suppressNextCardClickFlip = true;
        isDragging = false;
        return;
      }

      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      currentX = 0;
      isDragging = true;
      isClick = true;
      self._cardTouchLongPress = false;
      touchStartTime = Date.now();
      card.style.transition = 'none';

      // 长按：不再接管手势，让系统取词（CSS 已放开 user-select），松手也不翻面
      clearLongPressTimer();
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        self._cardTouchLongPress = true;
        isClick = false;
        // 背面只能由 JS 取词：翻面后浏览器的命中测试拿不到背面文字（详见
        // _selectCardWordAt 的注释），系统长按在背面取不到词。正面保留系统原生
        // 长按（选区手柄与系统「拷贝」菜单更符合系统习惯），这里不做干预。
        if (card.classList.contains('flipped')) {
          const text = self._selectCardWordAt(startX, startY, card);
          // 写剪贴板推迟到 touchend（带用户手势的时机），见下面的 touchend
          if (text) longPressCopyText = text;
        }
      }, CARD_TOUCH_LONG_PRESS_MS);
    });

    card.addEventListener('touchmove', (e) => {
      if (!isDragging) return;
      // 长按取词中 / 正在拖选文字：必须放手，既不能 preventDefault 也不能平移卡片，
      // 否则会打断系统选区与选区手柄的拖动
      if (self._cardTouchLongPress || self._hasTextSelection()) return;

      currentX = e.touches[0].clientX - startX;
      const currentY = e.touches[0].clientY - startY;
      
      // 只有当滑动超过阈值时才认为是滑动
      if (Math.abs(currentX) > 10 || Math.abs(currentY) > 10) {
        isClick = false;
        // 只在水平滑动为主时处理移动效果（练习卡不允许滑动切卡，跳过）
        if (allowSwipe && Math.abs(currentX) > Math.abs(currentY)) {
          e.preventDefault();
          card.style.transform = `translateX(${currentX}px) rotate(${currentX * 0.05}deg)`;
        }
      }
    });

    card.addEventListener('touchend', () => {
      clearLongPressTimer();
      const wasLongPress = self._cardTouchLongPress;
      self._cardTouchLongPress = false;

      if (!isDragging) return;
      isDragging = false;
      // 手指松开的位移占卡片宽度比例：传给 _sequenceCard，让它从卡片当前位置
      // 无缝接着滑出（同时决定了滑出时长），而不是先跳回某个固定关键帧
      const releaseRatio = currentX / self._getCardWidth();
      
      // 判断是否为点击（短时间内的触摸）
      const touchDuration = Date.now() - touchStartTime;
      
      if (wasLongPress) {
        // 长按取词：卡片全程未移动，仅还原过渡并吞掉随后合成的 click，保留选中文字
        card.style.transition = `transform ${CARD_ENTRY_MS}ms ${CARD_SWIPE_EASE}`;
        card.style.transform = '';
        self._suppressNextCardClickFlip = true;
        // 手指抬起时才有用户手势，此时写剪贴板才不会被浏览器拒绝
        if (longPressCopyText) {
          const text = longPressCopyText;
          longPressCopyText = '';
          self._copyCardText(text);
        } else if (!self._hasTextSelection()) {
          // 正面按设计交给系统原生长按取词；若系统没有给出选区（部分浏览器/WebView
          // 不支持长按选字），这里兜底由 JS 取词并复制，保证手机上长按一定能复制
          const text = self._selectCardWordAt(startX, startY, card);
          if (text) self._copyCardText(text);
        }
      } else if (isClick && touchDuration < 500 && !self._hasTextSelection()) {
        // 触摸翻面后仍会触发合成 click，避免与 click 的翻面重复
        self._suppressNextCardClickFlip = true;
        if (typeof onFlip === 'function') onFlip();
      } else if (allowSwipe && currentX > CARD_SWIPE_THRESHOLD) {
        // 向右滑动（从左往右）- 跳过、下一个单词
        // 卡片位置继续沿用拖动时写入的 transform，由 _sequenceCard 接管滑出动画，
        // 避免插入一个“瞬间跳到画外”的关键帧造成卡顿/空白
        setTimeout(() => {
          self.skipCard(releaseRatio);
        }, 0);
      } else if (allowSwipe && currentX < -CARD_SWIPE_THRESHOLD) {
        // 向左滑动（从右往左）- 掌握
        // 注意：markMastered 内部只同步推进卡片动画，写库/刷新统计放到后台执行。
        // 切勿改成「await 落库完成后再切卡」，否则卡片会在滑出后的画外位置等待 IO，
        // 产生左滑特有的卡顿闪烁（右滑「跳过」为纯内存操作，故此前无此问题）。
        setTimeout(() => {
          self.markMastered(releaseRatio);
        }, 0);
      } else {
        // 回到原位
        card.style.transition = `transform ${CARD_ENTRY_MS}ms ${CARD_SWIPE_EASE}`;
        card.style.transform = '';
      }
      currentX = 0;
    });

    // 触摸被系统中断（来电、通知、取词手势等）：复位状态并把卡片弹回原位
    card.addEventListener('touchcancel', () => {
      clearLongPressTimer();
      self._cardTouchLongPress = false;
      longPressCopyText = '';
      if (!isDragging) return;
      isDragging = false;
      card.style.transition = `transform ${CARD_ENTRY_MS}ms ${CARD_SWIPE_EASE}`;
      card.style.transform = '';
      currentX = 0;
    });
  }

  /**
   * 卡片文字长按复制（桌面鼠标 + 移动端触屏，正反两面都生效，学习卡与练习卡共用）：
   * - 鼠标：按住不动 600ms 选中指针下的整个词并复制（单字也能选中自身），
   *   按住拖动则由浏览器原生拖选；这两种情况都会取消这次「单击翻面」；
   * - 触屏：正面保留系统原生长按取词（选区菜单最符合系统习惯）；背面因为浏览器的
   *   命中测试取不到背面文字（见 _selectCardWordAt 注释），改由 JS 按坐标选中并复制；
   * - 取词全程按坐标 + DOM Range 计算，不依赖浏览器命中测试，所以翻面后同样有效。
   */
  initCardTextSelection(card) {
    card = card || document.getElementById('flashcard');
    if (!card) return;

    const self = this;
    let pressTimer = null;
    let pressX = 0;
    let pressY = 0;

    const clearPressTimer = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };

    card.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || self._isCardControl(e.target)) return;
      pressX = e.clientX;
      pressY = e.clientY;
      self._cardPointerMoved = false;
      self._cardLongPressFired = false;
      self._cardLongPressText = '';
      clearPressTimer();
      pressTimer = setTimeout(() => {
        pressTimer = null;
        // 按住不动：先选中指针下的词并取消这次点击的翻面；真正的写剪贴板放到
        // mouseup（那才是带有用户手势的时机，异步剪贴板 API 才不会被拒）
        const text = self._selectCardWordAt(pressX, pressY, card);
        if (text) {
          self._cardLongPressFired = true;
          self._cardLongPressText = text;
          self._cancelPendingCardFlip();
        }
      }, CARD_MOUSE_LONG_PRESS_MS);
    });

    card.addEventListener('mousemove', (e) => {
      if (!pressTimer && !self._cardLongPressFired) return;
      if (
        Math.abs(e.clientX - pressX) > CARD_TEXT_MOVE_TOLERANCE_PX ||
        Math.abs(e.clientY - pressY) > CARD_TEXT_MOVE_TOLERANCE_PX
      ) {
        // 变成拖选：本次点击不翻面，选区交给浏览器维护
        clearPressTimer();
        self._cardPointerMoved = true;
      }
    });

    card.addEventListener('mouseup', () => {
      clearPressTimer();
      if (self._cardLongPressText) {
        const text = self._cardLongPressText;
        self._cardLongPressText = '';
        self._copyCardText(text);
      }
    });
    card.addEventListener('mouseleave', clearPressTimer);
  }

  /** 当前朝上的一面（正面 / 背面）；card 省略时取学习卡 */
  _visibleCardFace(card) {
    const el = card || document.getElementById('flashcard');
    if (!el) return null;
    return el.querySelector(
      el.classList.contains('flipped') ? '.flashcard-back' : '.flashcard-front'
    );
  }

  /** 元素里的第一个文字节点（卡片的每个文字块都是单文本节点） */
  _firstTextNode(el) {
    if (!el) return null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    return walker.nextNode();
  }

  /**
   * 在 (x, y) 处选中一个词，返回选中的文字（没选中任何东西时返回 ''）。
   *
   * 全程按坐标 + DOM Range 计算，刻意不用 document.elementFromPoint /
   * caretRangeFromPoint：卡片翻面靠 3D 旋转 + backface-visibility，而 Chrome 的
   * 命中测试是按元素「自身」变换做背面剔除的（绘制用的却是叠加后的朝向），翻到背面后
   * 这些接口取到的是看不见的正面文字（已实测）。按“当前可见面内、包含该点的最小
   * 文字块 + Range 逐字量宽”来定位，翻面后同样准确。
   */
  _selectCardWordAt(x, y, card) {
    const face = this._visibleCardFace(card);
    if (!face) return '';

    // 1) 取包含该点的最小文字块（词条 / 音标 / 释义 / 例句）
    let tile = null;
    let tileArea = Infinity;
    face.querySelectorAll(CARD_TEXT_TILE_SELECTOR).forEach((el) => {
      if (!String(el.textContent || '').trim()) return;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const pad = 2; // 正好压在行间/边缘时也判为命中
      if (x < r.left - pad || x > r.right + pad || y < r.top - pad || y > r.bottom + pad) return;
      const area = r.width * r.height;
      if (area < tileArea) {
        tileArea = area;
        tile = el;
      }
    });
    if (!tile) return '';

    const sel = window.getSelection();
    if (!sel) return '';

    // 2) 块内定位到具体字符，再向两侧扩成整词；定位失败就退化为整块选中
    const node = this._firstTextNode(tile);
    const text = node ? (node.nodeValue || '') : '';
    const range = document.createRange();
    const index = text ? this._caretIndexInTile(node, text, x, y) : -1;
    const word = index >= 0 ? this._expandWordRange(text, index) : null;
    if (word) {
      range.setStart(node, word[0]);
      range.setEnd(node, word[1]);
    } else {
      range.selectNodeContents(tile);
    }
    sel.removeAllRanges();
    sel.addRange(range);
    return String(sel).trim();
  }

  /** 用 Range 逐字量宽，找出离 (x, y) 最近的字符下标；测不到时返回 -1 */
  _caretIndexInTile(node, text, x, y) {
    const range = document.createRange();
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < text.length; i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue; // 换行、零宽字符等量不到
      const dx = r.left + r.width / 2 - x;
      const dy = r.top + r.height / 2 - y;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  }

  /**
   * 把下标扩成整词，返回 [start, end)；取不到词时返回 null（调用方退化为整块选中）：
   * 英文/数字等按词字符连续段，中日韩按连续汉字段；落在标点或空格上时取相邻最近的词。
   */
  _expandWordRange(text, index) {
    const isWord = (ch) => CARD_WORD_CHAR_RE.test(ch);
    const isCjk = (ch) => CARD_CJK_CHAR_RE.test(ch);
    let kind = isWord(text[index]) ? 'word' : (isCjk(text[index]) ? 'cjk' : null);
    if (!kind) {
      let found = false;
      for (let i = index + 1; i < text.length && !found; i++) {
        if (isWord(text[i])) { kind = 'word'; index = i; found = true; }
        else if (isCjk(text[i])) { kind = 'cjk'; index = i; found = true; }
      }
      for (let i = index - 1; i >= 0 && !found; i--) {
        if (isWord(text[i])) { kind = 'word'; index = i; found = true; }
        else if (isCjk(text[i])) { kind = 'cjk'; index = i; found = true; }
      }
      if (!found) return null;
    }
    const match = kind === 'word' ? isWord : isCjk;
    let start = index;
    let end = index + 1;
    while (start > 0 && match(text[start - 1])) start--;
    while (end < text.length && match(text[end])) end++;
    return [start, end];
  }

  /** 复制长按选中的文字并给出提示；失败时静默跳过（选区仍在，可手动复制） */
  async _copyCardText(text, quiet) {
    if (!text) return false;
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (err) {
      ok = false;
    }
    if (!ok && document.execCommand) {
      // 老浏览器兜底：此时选区就是长按选中的文字
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    }
    if (ok && !quiet) {
      const shown = text.length > 12 ? `${text.slice(0, 12)}…` : text;
      this.showToast(`已复制：${shown}`);
    }
    return ok;
  }

  /** 当前是否存在非空文字选中（卡片文字复制与翻面/滑动手势的互斥依据） */
  _hasTextSelection() {
    const sel = window.getSelection();
    return !!(sel && !sel.isCollapsed && String(sel).length > 0);
  }

  /** 卡片上的按钮与角标：点它们不翻面，也不应触发文字选中 */
  _isCardControl(target) {
    return !!(target && target.closest && (
      target.closest('.favorite-btn') ||
      target.closest('.language-badge')
    ));
  }

  /** 取消尚未执行的「单击翻面」（双击选词、换卡、长按取词、切页时调用） */
  _cancelPendingCardFlip() {
    if (this._cardFlipTimer) {
      clearTimeout(this._cardFlipTimer);
      this._cardFlipTimer = null;
    }
  }

  /**
   * 卡片的「单击翻面」手势判定（学习卡与练习卡共用，保证两处手感一致）。
   * 下列情况都不翻面，把这次点击让给文字选择：
   *   - 双击的第二下（双击是选词，不是翻面）；
   *   - 刚刚拖动选字 / 长按取词之后的收尾点击；
   *   - 当前已经选中了文字（这次点击只用于取消选中）。
   * 单击翻面延迟 CARD_CLICK_FLIP_DELAY_MS 执行，给双击选词留出取消窗口。
   */
  _bindCardFlipGesture(card, onFlip) {
    if (!card) return;
    const self = this;

    card.addEventListener('click', (e) => {
      if (self._suppressNextCardClickFlip) {
        self._suppressNextCardClickFlip = false;
        return;
      }
      if (self._isCardControl(e.target)) return;

      // 双击的第二下：不再排翻面，把这次双击让给浏览器选中该词
      if (e.detail > 1) {
        self._cancelPendingCardFlip();
        return;
      }

      // 拖动选字 / 长按取词之后的收尾点击：保留选中，不翻面
      if (self._cardPointerMoved || self._cardLongPressFired) {
        self._cardPointerMoved = false;
        self._cardLongPressFired = false;
        return;
      }

      // 已选中文字时：这次点击只用于取消选中，不翻面（避免“选完想取消却翻了卡”）
      if (self._hasTextSelection()) {
        window.getSelection().removeAllRanges();
        return;
      }

      // 单击翻面延迟执行：期间若发生双击选词，则取消翻面
      self._cancelPendingCardFlip();
      self._cardFlipTimer = setTimeout(() => {
        self._cardFlipTimer = null;
        onFlip();
      }, CARD_CLICK_FLIP_DELAY_MS);
    });

    // 双击选词：取消待执行的翻面，保留浏览器选中的词（正反两面都适用）
    card.addEventListener('dblclick', (e) => {
      self._cancelPendingCardFlip();
      if (self._isCardControl(e.target)) e.preventDefault();
    });
  }

  /**
   * 切换底部导航页面（learn / library / practice / settings）。
   * 离开学习页时把当前队列与下标快照到 _learnSessionSnapshot；
   * 回到学习页时，若快照队列长度与每日目标一致则恢复进度，否则重建今日队列。
   */
  switchPage(page) {
    if (this.currentPage === page) return;

    // 旧页面此刻仍然可见：先量一下学习卡高度，好让练习卡与它等高
    this.syncPracticeCardHeight();

    // 切页时取消尚未执行的「单击翻面」并复位手势状态：卡片翻面是延迟执行的，
    // 不取消的话会把点击留到另一个页面的卡片上执行
    this._cancelPendingCardFlip();
    this._suppressNextCardClickFlip = false;
    this._cardPointerMoved = false;
    this._cardLongPressFired = false;
    this._cardLongPressText = '';
    this._cardTouchLongPress = false;

    // 离开学习页时把会话存到实例上，否则返回学习页时局部变量已丢失，会误走 prepareLearnSession 导致进度清零
    if (this.currentPage === 'learn' && this.todayWords && this.todayWords.length > 0) {
      this._learnSessionSnapshot = {
        currentCardIndex: this.currentCardIndex,
        todayWords: JSON.parse(JSON.stringify(this.todayWords)),
        todayStats: { ...this.todayStats },
        todayDoneCount: this.todayDoneCount,
        // 记下快照所属的词典范围与学习范围：切换后旧队列不能再被恢复
        scope: this.settings.dictImportType || 'all',
        studyScope: this.normalizeStudyScope(this.settings.studyScope)
      };
    }

    // 离开练习页时取消「自动下一题」，避免在别的页面上把练习题悄悄翻过去
    if (page !== 'practice') {
      this.cancelPracticeAdvance();
    }
    
    this.currentPage = page;
    
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.page === page);
    });
    
    document.querySelectorAll('.page').forEach(p => {
      p.classList.toggle('active', p.id === `${page}Page`);
    });

    if (page === 'learn') {
      // 兜底：队列里若混入了不属于当前词典范围的词条（刚在设置页切换过「词典导入」，
      // 或云端同步下来的范围与本地队列不一致），先整队丢弃，避免把旧范围的内容当成有效进度展示
      if ((this.todayWords || []).some((w) => !this.isWordInActiveScope(w))) {
        this.todayWords = [];
        this.currentCardIndex = 0;
        this._learnSessionSnapshot = null;
        // 队列要重建，先把旧范围的卡片文字清掉，避免重建期间还显示着它
        this.clearCardDisplay();
      }

      const snap = this._learnSessionSnapshot;
      // 只有当快照中的队列长度与「本轮队列容量」匹配时才恢复快照
      // （容量 = min(每日目标, 范围内词条数)，词条数少于目标时队列天生短一截）
      const snapshotCapacity = Number(this._queueCapacity) || this.settings.dailyGoal;
      // 快照还必须属于当前词典范围，否则切范围后回到学习页会继续显示上一个范围（如「字」）的卡片
      const snapshotMatchesScope = Boolean(
        snap &&
        (snap.scope || 'all') === (this.settings.dictImportType || 'all') &&
        (snap.studyScope || 'all') === this.normalizeStudyScope(this.settings.studyScope) &&
        Array.isArray(snap.todayWords) &&
        snap.todayWords.length > 0 &&
        snap.todayWords.every((w) => this.isWordInActiveScope(w))
      );
      const shouldRestoreSnapshot = snap && snap.todayWords && snap.todayWords.length > 0 && 
                                   snap.todayWords.length === snapshotCapacity &&
                                   snapshotMatchesScope;
      
      if (shouldRestoreSnapshot) {
        this.todayWords = snap.todayWords;
        this.currentCardIndex = snap.currentCardIndex;
        this.todayStats = { ...snap.todayStats };
        // 统计数据以按分类归档的计数为准，避免恢复会话快照时把数字回退到旧值
        this.syncActiveStatsMirrors();
        // 进度条数字由「今日词条数 − 本轮起点」推导（与上方统计同源），
        // 因此这里重新推导而不是直接采用快照里的旧张数，避免两个口径再次分叉
        this.syncTodayDoneFromStats();
        const emptyState = document.getElementById('learnEmptyState');
        if (emptyState) emptyState.style.display = 'none';

        // 与页面加载同一套规则：【继续学习】只在「今日目标已完成」时出现；
        // 队列已背完但没达标时直接重抽一轮，不要停在完成页误导用户
        if (this.isDailyGoalReached()) {
          this.showComplete();
          this.updateProgress();
        } else if (this.currentCardIndex >= this.todayWords.length) {
          // 队列走完：tab 里还有没学过一遍的词就继续出卡；全部学过才显示红字提示
          this._learnSessionSnapshot = null;
          this.handleScopeQueueEnd().catch((error) => {
            console.error('[learn] 继续当前学习范围失败:', error);
          });
        } else {
          this.showCard(this.currentCardIndex);
          document.querySelector('.card-stack').style.display = 'flex';
          document.querySelector('.complete-container').style.display = 'none';
          this.updateProgress();
        }
      } else {
        // 重建队列是异步的，这里兜住异常，避免个别统计/渲染失败变成未捕获的 Promise 异常
        this.prepareLearnSession().catch((error) => {
          console.error('[learn] 重建今日学习队列失败:', error);
        });
      }
    } else if (page === 'library') {
      this.renderCategoryOptions();
      this.renderLibrary();
    } else if (page === 'practice') {
      // 队列重建/渲染是异步的，这里兜住异常，避免个别失败变成未捕获的 Promise 异常
      this.enterPracticePage().catch((error) => {
        console.error('[practice] 准备练习题目失败:', error);
      });
    } else if (page === 'settings') {
      this.renderSettings();
    }

    // 离开词库页即结束“只看今天学过”的筛选，避免下次直接进词库时列表仍是今日口径
    if (page !== 'library') {
      this.resetLibraryTodayFilter();
    }

    // 新页面已经激活：补量它那一侧卡片区的位置，两侧都齐了就能算出练习卡的补偿高度
    this.syncPracticeCardHeight();
  }

  /**
   * 首次渲染：准备今日学习队列（学习页默认显示）并把设置应用到界面。
   * 改为 async：启动阶段要等队列真正就绪后再移除「正在同步」遮罩，
   * 否则会先闪一下空卡片。
   */
  async render() {
    await this.prepareLearnSession();
    this.applySettings();
    // 同步设置页控件状态：设置页虽未展示，但开关的初始状态必须与库里读到的设置一致
    // （例如「显示释义」默认开启，用户关了之后刷新页面，再进设置页应看到关闭态）
    this.renderSettings();
  }

  /** 启动阶段等待首次云同步时显示遮罩，避免用户先看到本机的 0/100 */
  showInitialSyncPending() {
    const mask = document.getElementById('learnSyncMask');
    if (mask) mask.style.display = 'flex';
  }

  /** 隐藏「正在同步学习进度」遮罩 */
  hideInitialSyncPending() {
    const mask = document.getElementById('learnSyncMask');
    if (mask) mask.style.display = 'none';
  }

  // 保存学习进度到 IndexedDB
  async saveLearnProgress() {
    if (!this.todayWords || this.todayWords.length === 0) return;
    
    const progress = {
      currentCardIndex: this.currentCardIndex,
      todayWords: JSON.parse(JSON.stringify(this.todayWords)),
      savedAt: new Date().toISOString(),
      // 纯复习轮（整队都是今天已学过的词）要带上标记：恢复时不能把它当成
      // 「下标落后的过期会话」丢掉，否则每次刷新都会把这轮复习从头开始
      isReviewRound: !this._queueHasFreshWords,
      // 记下这份队列属于哪个学习范围：切换范围后旧队列不能当作当前范围的进度恢复
      studyScope: this.normalizeStudyScope(this.settings.studyScope)
    };
    await this.db.setSetting('learnProgress', progress);
    // 累计张数跟着进度一起落库，否则刷新后进度条会从当前队列的下标重新算
    await this.saveTodayDoneCount();
  }

  /**
   * 读取「本轮起点」。
   *
   * 进度 = 今日已计入统计的词条数 − 本轮起点，两者都是**去重词条数**，
   * 因此进度条数字与上方的「今日已掌握 + 今日待复习」永远相等。
   *
   * 调用时机很重要：必须在算统计（loadTodayStats → refreshStatusCounts）**之前**读好。
   * 顺序反了的话，第一次算统计时起点还是 0，会把「今日已学词条数」当成进度，
   * 于是刷新瞬间误判「今日目标已完成」、闪出完成页与【继续学习】按钮，
   * 用户手快一点就把本轮进度清零了。
   *
   * 旧版本用「今日累计完成张数」单独累加（同一词条学两次会多记一张，学完 100 张时
   * 上方两数之和只有 98/99），现在统一由统计推导，旧键用完即弃。
   */
  async loadTodayDoneCount() {
    const today = this.todayKey();
    const saved = await this.db.getSetting('todayRoundStart', null);
    this._todayRoundStart = (saved && saved.date === today)
      ? Math.max(0, Math.floor(Number(saved.count) || 0))
      : 0;

    // 「今天已完成过目标」的标记（跨天自动失效；同时记录达成时的目标值，
    // 目标改过之后旧完成态不再生效，避免把 10/15 补成 15/15）
    const reached = await this.db.getSetting('todayGoalReached', null);
    const reachedToday = Boolean(reached && reached.date === today);
    // 旧版本只存了 { date }，没有 goal：无法判断是不是改目标之前留下的完成态，
    // 按「不沿用」处理，避免把 10/15 补成 15/15。新版本达成时会同时写入 goal。
    const reachedGoal = reachedToday && reached.goal != null
      ? Math.max(0, Number(reached.goal) || 0)
      : 0;
    const currentGoal = Math.max(0, Number(this.settings.dailyGoal) || 0);
    const reachedStillValid = reachedToday && reachedGoal > 0 && reachedGoal === currentGoal;
    this._todayGoalReachedDate = reachedStillValid ? today : '';
    this._todayGoalReachedGoal = reachedStillValid ? reachedGoal : 0;

    this._todayRoundDate = today;
    this._roundStartReady = true;
    this.syncTodayDoneFromStats();
    await this.saveTodayDoneCount();

    const legacy = await this.db.getSetting('todayDoneCount', null);
    if (legacy !== null) await this.db.setSetting('todayDoneCount', null);

    return this.todayDoneCount;
  }

  /** 写入「本轮起点」（带日期戳，用于跨天判断） */
  async saveTodayDoneCount() {
    // 起点还没从库里读出来时绝不能落库：否则会用内存里的默认值 0
    // 覆盖掉库里真实的本轮起点，「进度 = 统计 − 起点」就会被算成「统计」，
    // 表现为刷新瞬间误判「今日目标已完成」并闪出完成页
    if (!this._roundStartReady) return;
    await this.db.setSetting('todayRoundStart', {
      date: this._todayRoundDate || this.todayKey(),
      count: Math.max(0, Math.floor(Number(this._todayRoundStart) || 0))
    });
  }

  /** 今日已计入统计的词条数（= 上方「今日已掌握 + 今日待复习」，当前词典范围口径） */
  currentTodayStudyCount() {
    const mastered = Math.max(0, Number(this.todayStats && this.todayStats.mastered) || 0);
    const review = Math.max(0, Number(this.todayStats && this.todayStats.review) || 0);
    return mastered + review;
  }

  /**
   * 跨天（页面常驻过夜，PWA 很常见）时把本轮起点与进度归零。
   * 不做这一步的话，第二天点第一张卡时会拿昨天的完成数去比每日目标，
   * 于是「完成页」和「1/100」同时出现。
   * 返回是否真的跨天了。
   */
  rollOverRoundIfNewDay() {
    const today = this.todayKey();
    if (this._todayRoundDate && this._todayRoundDate !== today) {
      this._todayRoundDate = today;
      this._todayRoundStart = 0;
      this._roundStartReady = true;   // 跨天归零是有意义的，允许落库
      this.todayDoneCount = 0;
      // 跨天：昨天「已完成目标」的标记作废，今天重新开始
      this._todayGoalReachedDate = '';
      this._todayGoalReachedGoal = 0;
      this.db.setSetting('todayGoalReached', null).catch(() => {});
      this.saveTodayDoneCount().catch(() => {});
      return true;
    }
    if (!this._todayRoundDate) this._todayRoundDate = today;
    return false;
  }

  /**
   * 按「今日词条数 − 本轮起点」重算本轮完成数。
   * 跨天时起点自动归零（进度条每天从头开始）。
   */
  syncTodayDoneFromStats() {
    this.rollOverRoundIfNewDay();
    // 起点还没从库里读出来时，先不要把「今日统计」当成进度：
    // 那会让刷新瞬间的 done 偏大，误判「今日目标已完成」而闪出完成页
    if (!this._roundStartReady) return this.todayDoneCount;

    const counted = this.currentTodayStudyCount();
    // 起点不可能大于「今天总共学过的词条数」：起点是某一轮开始时已经学过的数量，
    // 而今天学过的词条数只会越积越多（清除记录 / 切范围都会同时重设起点）。
    // 一旦出现「起点 > 今日词条数」，说明这个起点已经失效 —— 最常见的来源是
    // 误点【继续学习】时把当时的统计当成了起点，之后统计变小（或本就没那么多），
    // 于是进度被永久压在 0/100。这里直接把它归零，让进度回到真实值。
    if (this._statsReady && this._todayRoundStart > counted) {
      console.info('[learn] 检测到本轮起点（' + this._todayRoundStart +
        '）大于今日已学词条数（' + counted + '），已重置为 0');
      this._todayRoundStart = 0;
      this.saveTodayDoneCount().catch(() => {});
    }

    const computed = Math.max(0, counted - this._todayRoundStart);

    // 还有学习动作没落库完成时，统计快照可能还「少一张」：
    // 不许用它把进度改小，否则学完最后一张会停在 99/100（要点一次【继续学习】才变 100）
    if (this._pendingPersistCount > 0 && computed < this.todayDoneCount) {
      this._statsMayBeStale = true;   // 记下来：等全部落库后要校准一次
      return this.todayDoneCount;
    }

    this.todayDoneCount = computed;

    // 「今天已经完成过目标」时保住完成态：
    // 达成之后统计可能因为数据变化少 1~2 条（更新词典删掉了一个今天学过的词条、
    // 或另一台设备把某条改成了非今日），这时不该让「已完成」退回 99/100。
    // 做法是把本轮起点相应下调相同的数量，于是 done 回到每日目标，
    // 「进度 = 今日统计 − 起点」依然严格成立（不会出现数字互相矛盾）。
    const goal = Math.max(0, Number(this.settings.dailyGoal) || 0);
    if (this._statsReady && goal > 0 &&
        this._todayGoalReachedDate === this.todayKey() &&
        this._todayGoalReachedGoal === goal &&
        this.todayDoneCount < goal) {
      const deficit = goal - this.todayDoneCount;
      // 只兜小波动（≤5 条）：差得多说明是别的问题，不能靠调起点掩盖
      if (deficit <= 5 && this._todayRoundStart >= deficit) {
        console.info('[learn] 今日目标已达成，统计回落了 ' + deficit +
          ' 条（可能是词典更新删词或同步改动），保持完成状态');
        this._todayRoundStart -= deficit;
        this.todayDoneCount = goal;
        this.saveTodayDoneCount().catch(() => {});
      }
    }

    return this.todayDoneCount;
  }

  /**
   * 设置本轮起点（云端同步今日会话时调用）。
   * 另一台设备可能已经开始过新一轮（起点不为 0），跟着它才能让两端进度条数字一致。
   */
  async setTodayRoundStart(value) {
    this._todayRoundDate = this.todayKey();
    this._todayRoundStart = Math.max(0, Math.floor(Number(value) || 0));
    this._roundStartReady = true;
    this.syncTodayDoneFromStats();
    await this.saveTodayDoneCount();
    this.updateProgress();
    this.refreshGoalSliderLockedState();
  }

  /** 今日累计进度归零（改每日目标、切换词典范围、清除记录、达标后开新一轮时调用） */
  async resetTodayDoneCount() {
    // 起点前移到「此刻今日已计入统计的词条数」：之后新学的词条才计入本轮进度
    this._todayRoundDate = this.todayKey();
    this._todayRoundStart = this.currentTodayStudyCount();
    this._roundStartReady = true;
    this.todayDoneCount = 0;
    // 开始新一轮：清掉「今日已完成」标记，之后要重新学满目标才算完成
    if (this._todayGoalReachedDate) {
      this._todayGoalReachedDate = '';
      this._todayGoalReachedGoal = 0;
      this.db.setSetting('todayGoalReached', null).catch(() => {});
    }
    await this.saveTodayDoneCount();
  }

  // 加载学习进度
  async loadLearnProgress() {
    const progress = await this.db.getSetting('learnProgress', null);
    if (!progress) return null;
    
    // 检查是否是今天保存的进度
    const savedDate = new Date(progress.savedAt).toDateString();
    const today = new Date().toDateString();
    
    if (savedDate === today) {
      return progress;
    }
    return null;
  }

  /**
   * 准备（或恢复）今日学习会话。
   *
   * 学习范围（全部/新词/待复习/已掌握/收藏）各自有一个「学完一遍」的完成集合：
   * 学习页只从当前 tab 里还没学过一遍的词条中抽卡。当前 tab 的单词全部学过一遍后，
   * 显示「已学完【…】，请切换范围」；之后如果词典新增词条、或词库里把词条新加进
   * 这个 tab，它的 key 不在完成集合里，会自动取消“已学完”并继续出卡，
   * 学过之后才再次提示。
   *
   * 队列仍然受每日目标限制：达到今日目标时先显示完成页与【继续学习】；
   * 点【继续学习】后进度归零，但学习范围的完成集合继续保留，接着学没学过的词。
   */
  async prepareLearnSession() {
    this._learnSessionSnapshot = null;
    // 新一轮会话开始：清掉上一次的「已跳过」内存名单（跳过本身不写学习记录）
    this._skippedWordIds.clear();

    this._isReviewRound = false;

    // 本次会话使用的学习范围（all/new/review/mastered/favorite）
    const studyScope = this.normalizeStudyScope(this.settings.studyScope);
    // 强制入队标记只在创建它的范围里有效
    if (this._externalScopeIncludeScope !== studyScope) {
      this._externalScopeIncludeIds.clear();
      this._externalScopeIncludeScope = studyScope;
    }

    // 尝试加载之前保存的学习进度
    const savedProgress = await this.loadLearnProgress();
    const allStoredWords = await this.db.getAllWords();
    const storedWordsById = new Map(allStoredWords.map((word) => [word.id, word]));
    const restoredTodayWords = savedProgress?.todayWords
      ? savedProgress.todayWords.map((word) => storedWordsById.get(word.id)).filter(Boolean)
      : [];

    // 只取当前展示分类（全部/字/短语）的词条；另一分类的词条常驻词库，记录不会被清除
    const allWords = allStoredWords.filter((w) => this.isWordInActiveScope(w));
    // 当前 tab 的全部词条（全部 = 当前词典范围）
    const studyScopePool = allWords.filter((w) => this.isWordInStudyScope(w, studyScope));
    // 缓存当前可抽词范围，供「跳过」同步补牌使用（见 pickSkipReplacement）
    this._scopePoolCache = studyScopePool;

    const goalValue = Math.max(0, Number(this.settings.dailyGoal) || 0);
    const doneSet = this._scopePassDone[studyScope] || new Set();
    // 当前 tab 里还没学过一遍的词条
    const pendingScopeWords = studyScopePool.filter((w) => {
      const key = this.dictKeyOf(w);
      return !key || !doneSet.has(key);
    });

    // 恢复出来的队列必须整体属于当前词典范围：切换过「词典导入」（字 ↔ 短语）后，
    // 库里可能还留着上一个范围的进度，若只比长度就恢复，学习页会继续展示旧范围的内容
    const restoredAllInActiveScope =
      restoredTodayWords.length > 0 && restoredTodayWords.every((w) => this.isWordInActiveScope(w));
    // 保存的队列还必须属于同一个「学习范围」：切换范围后不能恢复上一个范围的卡片
    const savedStudyScope = this.normalizeStudyScope(savedProgress?.studyScope);

    // 保存的队列只在今天、同一词典/学习范围、词条都还存在时恢复。
    // 队列长度限制用每日目标而不是当前待学数量：tab 的待学数量会随着学习推进而减少，
    // 用它判断会每学几张就重建队列、把卡片位置丢掉。
    const shouldRestoreProgress = savedProgress &&
                                  savedProgress.todayWords &&
                                  restoredAllInActiveScope &&
                                  restoredTodayWords.length === savedProgress.todayWords.length &&
                                  savedStudyScope === studyScope &&
                                  this.currentCardIndex === 0 &&
                                  savedProgress.todayWords.length <= goalValue;

    if (savedProgress && !shouldRestoreProgress) {
      await this.db.setSetting('learnProgress', null);
    }

    if (shouldRestoreProgress) {
      // 恢复之前的学习进度，并使用数据库中的最新词条内容，避免旧快照覆盖词典更新。
      // 队列里的词可能已经不在当前 tab（例如复习词刚被改成已掌握）：过滤掉，
      // 同时把保存的下标换算到过滤后的队列位置上。
      const savedIndex = Math.max(0, Math.min(
        Math.floor(Number(savedProgress.currentCardIndex) || 0),
        restoredTodayWords.length
      ));
      const restoredWords = [];
      let restoredIndexBefore = 0;
      for (let i = 0; i < restoredTodayWords.length; i++) {
        const w = restoredTodayWords[i];
        if (!this.isWordInStudyScope(w, studyScope)) continue;
        if (i < savedIndex) restoredIndexBefore++;
        restoredWords.push(w);
      }

      this.todayWords = restoredWords;
      // 跳过队列里本轮已经学过一遍的卡（可能来自另一台设备/云端会话）
      this.currentCardIndex = this.alignRestoredScopeCardIndex(restoredIndexBefore, restoredWords, studyScope);
      this._queueCapacity = this.todayWords.length;
      this._queueHasFreshWords = pendingScopeWords.some((w) => !this.isWordCountedToday(w));

      const emptyState = document.getElementById('learnEmptyState');
      if (emptyState) emptyState.style.display = 'none';

      // 今日目标已完成：先显示完成页与【继续学习】（点它才开始新一轮）
      if (this.isDailyGoalReached()) {
        this.todayStats.total = this.todayWords.length;
        await this.db.setSetting('todayStats', this.todayStats);
        this.showComplete();
        this.updateProgress();
        this.refreshGoalSliderLockedState();
        return;
      }

      if (this.currentCardIndex < this.todayWords.length) {
        this.todayStats.total = this.todayWords.length;
        await this.db.setSetting('todayStats', this.todayStats);
        this.showCard(this.currentCardIndex);
        document.querySelector('.card-stack').style.display = 'flex';
        document.querySelector('.complete-container').style.display = 'none';
        this.updateProgress();
        this.refreshGoalSliderLockedState();
        return;
      }

      // 队列走完：tab 里还有没学过一遍的词（新增词条或这本轮没排到）就继续组队；
      // 全部学过才显示红字提示。
      if (pendingScopeWords.length > 0) {
        this.todayWords = [];
        this.currentCardIndex = 0;
        this._learnSessionSnapshot = null;
        await this.db.setSetting('learnProgress', null);
      } else {
        this.todayStats.total = this.todayWords.length;
        await this.db.setSetting('todayStats', this.todayStats);
        this.showScopeComplete();
        this.updateProgress();
        this.refreshGoalSliderLockedState();
        return;
      }
    }

    // 队列里优先放「今天还没计入统计」的词条：它们才会让进度条与今日统计增长；
    // 今天已经学过、但本轮还没学过的词排后面，保证一个 tab 能完整走完一遍。
    const untouchedWords = pendingScopeWords.filter((w) => !this.isWordCountedToday(w));
    const alreadyTodayWords = pendingScopeWords.filter((w) => this.isWordCountedToday(w));
    // 词库里刚手动加入当前范围的词条：优先排在最前面，让用户立刻看到它
    const externalWords = this._externalScopeIncludeIds.size > 0
      ? pendingScopeWords.filter((w) => this._externalScopeIncludeIds.has(w.id))
      : [];
    /** 顺序模式排序：新词 → 待复习 → 已掌握（组内保持词典原序） */
    const orderSequential = (pool) => {
      const rank = (w) => (w.status === 'new' ? 0 : (w.status === 'review' ? 1 : 2));
      return pool
        .map((w, index) => ({ w, index, r: rank(w) }))
        .sort((a, b) => a.r - b.r || a.index - b.index)
        .map((item) => item.w);
    };

    const goal = goalValue;
    const includeWords = externalWords.slice(0, goal);
    const includeIds = new Set(includeWords.map((w) => w.id));
    const restUntouched = untouchedWords.filter((w) => !includeIds.has(w.id));
    const restAlready = alreadyTodayWords.filter((w) => !includeIds.has(w.id));
    let restSlots = Math.max(0, goal - includeWords.length);
    let restWords = [];
    if (this.settings.learnMode === 'random') {
      const pickedUntouched = this.pickRandomSpreadByCategory(restUntouched, restSlots);
      restWords = pickedUntouched;
      restSlots = Math.max(0, restSlots - pickedUntouched.length);
      restWords = restWords.concat(this.pickRandomSpreadByCategory(restAlready, restSlots));
    } else {
      const pickedUntouched = orderSequential(restUntouched).slice(0, restSlots);
      restWords = pickedUntouched;
      restSlots = Math.max(0, restSlots - pickedUntouched.length);
      restWords = restWords.concat(orderSequential(restAlready).slice(0, restSlots));
    }
    const todayWords = includeWords.concat(restWords);

    this._queueHasFreshWords = untouchedWords.length > 0;
    // 队列容量记成实际长度，供切页时的快照恢复判断使用
    this._queueCapacity = todayWords.length;
    this.todayWords = todayWords;
    this.currentCardIndex = 0;
    this.todayStats.total = this.todayWords.length;
    await this.db.setSetting('todayStats', this.todayStats);

    if (this.todayWords.length === 0) {
      if (allWords.length === 0) {
        // 词库本身为空（还没导入词典）：保留原来的空状态
        this.showEmptyState();
      } else if (this.isDailyGoalReached()) {
        this.showComplete();
      } else {
        // 当前 tab 的单词已经全部学过一遍，或这个 tab 本来就没有词条
        this.showScopeComplete();
      }
    } else if (this.isDailyGoalReached()) {
      // 今日目标已达标：不再展示卡片（例如刷新页面后进度还在、队列是新的），
      // 用户点【继续学习】会先把本轮起点前移，再开始新一轮
      this.showComplete();
    } else {
      this.showCard(this.currentCardIndex);
      document.querySelector('.card-stack').style.display = 'flex';
      document.querySelector('.complete-container').style.display = 'none';
      const emptyState = document.getElementById('learnEmptyState');
      if (emptyState) emptyState.style.display = 'none';
    }

    // 刷新累计统计缓存后再更新进度，确保数字与词库一致
    await this.refreshStatusCounts();
    this.updateProgress();
    this.refreshGoalSliderLockedState();
  }

  /**
   * 清空学习卡片上的文字。
   * 切换「词典导入」范围时同步调用：新队列是异步重建的，若不清空，
   * 用户立刻切回学习页会先看到上一个范围（如「字」）的卡片内容。
   */
  clearCardDisplay() {
    const cardInner = document.querySelector('#flashcard .flashcard-inner');
    if (!cardInner) return;
    cardInner.querySelectorAll('.word, .phonetic, .meaning, .example').forEach((el) => {
      el.textContent = '';
    });
  }

  /** 冻结/恢复学习页的三个操作按钮（范围学完时不再记录任何数值） */
  setLearnActionsDisabled(disabled) {
    const actions = document.querySelector('.card-actions');
    if (actions) actions.classList.toggle('actions-disabled', Boolean(disabled));
    ['btnSkip', 'btnMastered', 'btnDifficult'].forEach((id) => {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = Boolean(disabled);
    });
  }

  /** 收起「已学完【范围】，请切换范围」的红色提示，恢复卡片与操作按钮 */
  hideScopeComplete() {
    const hint = document.getElementById('learnScopeComplete');
    if (hint) hint.style.display = 'none';
    const flashcard = document.getElementById('flashcard');
    if (flashcard) flashcard.style.display = '';
    this.setLearnActionsDisabled(false);
  }

  /** 从数据库现算当前学习范围里还有多少词条没学过一遍 */
  async countPendingScopeWordsInDb(scope = this.settings.studyScope) {
    const s = this.normalizeStudyScope(scope);
    const words = await this.db.getAllWords();
    const pool = words.filter(
      (w) => this.isWordInActiveScope(w) && this.isWordInStudyScope(w, s)
    );
    return this.countPendingScopeWords(pool, s);
  }

  /**
   * 当前学习范围的一轮队列走完（还没到每日目标）：
   * - tab 里还有没学过一遍的词（本轮没排到 / 新增词条）→ 继续组下一批；
   * - tab 里的单词全部学过一遍 → 显示红字「已学完【…】，请切换范围」。
   *
   * 用数据库现算而不是相信队列快照：在词库改状态、收藏、词典导入新词之后，
   * 红字提示必须马上跟着消失/恢复。
   */
  async handleScopeQueueEnd() {
    if (this._handlingScopeEnd) return;
    this._handlingScopeEnd = true;
    const scopeAtStart = this.normalizeStudyScope(this.settings.studyScope);
    try {
      if (this.isDailyGoalReached()) {
        this.showComplete();
        this.updateProgress();
        this.refreshGoalSliderLockedState();
        return;
      }

      const pending = await this.countPendingScopeWordsInDb(scopeAtStart);
      // 读库期间学习范围可能被切换（设置页/云同步）：交给新的范围自己重建，别用旧范围的结果覆盖
      if (this.normalizeStudyScope(this.settings.studyScope) !== scopeAtStart) return;
      // 读库期间统计可能因云同步/其它操作变化
      if (this.isDailyGoalReached()) {
        this.showComplete();
        this.updateProgress();
        this.refreshGoalSliderLockedState();
        return;
      }

      if (pending > 0) {
        await this.prepareLearnSession();
        return;
      }

      // 当前 tab 的单词已经全部学过一遍：保存完成集合后显示红字提示
      await this.saveScopePass();
      this.showScopeComplete();
      this.updateProgress();
      this.refreshGoalSliderLockedState();
    } finally {
      this._handlingScopeEnd = false;
    }
  }

  /**
   * 当前学习范围已学完（或该范围本来就没有待学词条）：
   * 在卡片区域显示红字提示，冻结跳过 / 掌握 / 陌生三个按钮；进度条保持当前数字。
   */
  showScopeComplete() {
    this._learnView = 'scopeComplete';
    const label = this.studyScopeLabel();
    // 当前 tab 还有词 → “是否继续？”+ 蓝色继续学习；
    // tab 已经空了（例如新词全部变成已掌握）→ 没有可继续的内容，提示切换范围并隐藏按钮。
    const canContinue = Array.isArray(this._scopePoolCache) && this._scopePoolCache.length > 0;
    const text = document.getElementById('learnScopeCompleteText');
    if (text) {
      text.textContent = canContinue
        ? `已学完【${label}】，是否继续？`
        : `已学完【${label}】，请切换范围`;
    }
    const scopeRestartBtn = document.getElementById('scopeRestartBtn');
    if (scopeRestartBtn) {
      scopeRestartBtn.style.display = canContinue ? '' : 'none';
    }
    const hint = document.getElementById('learnScopeComplete');
    if (hint) hint.style.display = 'flex';
    const flashcard = document.getElementById('flashcard');
    if (flashcard) flashcard.style.display = 'none';
    const stack = document.querySelector('.card-stack');
    if (stack) stack.style.display = 'flex';
    const complete = document.querySelector('.complete-container');
    if (complete) complete.style.display = 'none';
    const emptyState = document.getElementById('learnEmptyState');
    if (emptyState) emptyState.style.display = 'none';
    this.setLearnActionsDisabled(true);
    // 把下标停在队列末尾，切页/刷新后仍能恢复成「范围已学完」而不是重新显示最后一张卡
    if (Array.isArray(this.todayWords) && this.todayWords.length > 0) {
      this.currentCardIndex = this.todayWords.length;
    }
    // 红字提示是“学完一遍”的最终状态：立即保存完成集合，刷新后仍然保持
    this.saveScopePass().catch((error) => {
      console.warn('[learn] 保存学习范围完成状态失败:', error);
    });
    this.saveLearnProgress().catch((error) => {
      console.warn('[learn] 保存范围学完状态失败:', error);
    });
  }

  /**
   * 渲染指定下标的卡片：拼接正反面 HTML（正面=词汇+音标+收藏，
   * 背面=释义+例句），按“释义优先”设置决定初始朝向，并处理音标渐显定时。
   */
  showCard(index) {
    if (index >= this.todayWords.length) {
      return;
    }

    this._learnView = 'card';
    // 切换学习卡片时，把词库菜单的分类勾选恢复为默认（全部分类），避免残留上一张卡筛选
    this.resetLibraryCategorySelection();
    // 切换范围/重新建队后，红色「已学完」提示与按钮冻结状态都要撤掉
    this.hideScopeComplete();

    // 换卡：清掉上一张卡残留的文字选中与尚未执行的「单击翻面」，
    // 避免新卡片带着旧选中态，或在滑入过程中被上一次点击翻转
    this._cancelPendingCardFlip();
    this._cardPointerMoved = false;
    this._cardLongPressFired = false;
    this._cardLongPressText = '';
    this._cardTouchLongPress = false;
    if (this._hasTextSelection()) window.getSelection().removeAllRanges();
    
    const word = this.todayWords[index];
    const card = document.getElementById('flashcard');
    const cardInner = card.querySelector('.flashcard-inner');
    
    const isCantonese = this.isCantoneseWord(word);
    const cantonesePhoneticFirst = isCantonese || this.isImportedCantoneseLanguage(word);
    // 顶部标签：第一位固定显示当前「学习范围」，后面接语言 + 分类（与练习页共用后两者）
    const scopeBadgeHtml =
      `<span class="language-badge scope-badge">${this.escapeHtml(this.studyScopeLabel())}</span>`;
    const badgesHtml = this.buildCardBadgesHtml(word);
    const badgeRowHtml =
      `<div class="flashcard-badge-row">${scopeBadgeHtml}${badgesHtml ? `&nbsp;&nbsp;${badgesHtml}` : ''}</div>`;

    cardInner.innerHTML = `
      <div class="flashcard-front">
        ${badgeRowHtml}
        <button class="favorite-btn ${word.favorite ? 'active' : ''}" id="favoriteBtn">${HEART_ICON_SVG}</button>
        <button class="favorite-btn favorite-btn-right ${word.favorite ? 'active' : ''}" id="favoriteBtnRight">${HEART_ICON_SVG}</button>
        <div class="card-content">
          <div class="word">${word.word}</div>
          <div class="phonetic" id="phoneticText">${cantonesePhoneticFirst ? (word.jyutping || word.phonetic || '') : (word.phonetic || word.jyutping || '')}</div>
          ${isCantonese && word.cantonese ? `<div class="cantonese-word">${word.cantonese}</div>` : ''}
        </div>
        <div class="tap-hint">点击查看释义（Shift）</div>
      </div>
      <div class="flashcard-back">
        <button class="favorite-btn ${word.favorite ? 'active' : ''}" id="favoriteBtnBack">${HEART_ICON_SVG}</button>
        <div class="card-content">
          <div class="meaning">${word.definition || word.meaning}</div>
          <div class="example">${word.example ? `"${word.example}"` : ''}</div>
          ${isCantonese && word.cantoneseExample ? `<div class="cantonese-example">"${word.cantoneseExample}"</div>` : ''}
        </div>
        <div class="tap-hint tap-hint-back">点击查看词汇（Shift）</div>
      </div>
    `;

    // 顶部「分类」标签可点击：跳转词库并按该分类筛选（语言标签、收藏按钮等仍不跳转）
    const catBadge = cardInner.querySelector('.category-badge');
    if (catBadge) {
      catBadge.classList.add('clickable-badge');
      catBadge.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handleCategoryBadgeClick(catBadge.textContent);
      });
    }
    
    const defFirst = !!this.settings.cardDefinitionFirst;
    if (defFirst) {
      card.classList.add('flipped');
      this.isFlipped = true;
    } else {
      card.classList.remove('flipped');
      this.isFlipped = false;
    }

    // 音标渐显逻辑
    const phoneticText = document.getElementById('phoneticText');
    if (phoneticText) {
      // 取消之前的定时器
      if (this._phoneticDelayTimer) {
        clearTimeout(this._phoneticDelayTimer);
        this._phoneticDelayTimer = null;
      }
      
      const delay = this.settings.phoneticDelay * 1000;
      if (delay > 0) {
        // 隐藏音标
        phoneticText.style.opacity = '0';
        phoneticText.style.visibility = 'hidden';
        // 延迟显示
        this._phoneticDelayTimer = setTimeout(() => {
          phoneticText.style.opacity = '1';
          phoneticText.style.visibility = 'visible';
          this._phoneticDelayTimer = null;
        }, delay);
      } else {
        // 立即显示
        phoneticText.style.opacity = '1';
        phoneticText.style.visibility = 'visible';
      }
    }
  }

  /** 翻转卡片（正面↔背面） */
  flipCard() {
    const card = document.getElementById('flashcard');
    if (!card) {
      console.error('Flashcard element not found');
      return;
    }
    card.classList.toggle('flipped');
    this.isFlipped = !this.isFlipped;
  }

  /** 格式化时间为 YYYY-MM-DD HH:mm 格式，如 2026-09-11 23:45 */
  formatDictUpdateTime(date) {
    const d = new Date(date);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** 显示词库更新时间到页面顶部的 <span id="dictUpdateTime"> */
  displayDictUpdateTime(formatted) {
    const el = document.getElementById('dictUpdateTime');
    if (el) el.textContent = formatted;
  }

  /** 从数据库读取上次词库更新时间并显示到页面顶部 */
  async loadDictUpdateTimeDisplay() {
    const saved = await this.db.getSetting('dictUpdateTime', null);
    if (saved) {
      this.displayDictUpdateTime(this.formatDictUpdateTime(saved));
    }
  }

  /** 把 & < > " 转义成 HTML 实体；所有用户/词典内容拼进 innerHTML 前都要先过它，防止注入 */
  escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 把导入表格的表头单元格（如「词汇/word/字/短语」「释义」「粤拼」）识别成内部字段名；无法识别返回 null */
  resolveImportHeaderKey(cell) {
    const raw = String(cell ?? '').trim();
    if (!raw) return null;
    const lowerAscii = /^[\x00-\x7f]+$/.test(raw) ? raw.toLowerCase() : raw;
    const pairs = [
      ['word', ['word', '词汇', '字', '短语', 'phrase']],
      ['meaning', ['meaning', '释义']],
      ['phonetic', ['phonetic', '音标']],
      ['example', ['example', '例句']],
      ['category', ['category', '分类']],
      ['language', ['language', '语言']],
      ['jyutping', ['jyutping', '粤拼', 'jytping']],
      ['cantonese', ['cantonese', '粤语字', 'cantonese_word']],
      ['cantoneseExample', ['cantoneseExample', '粤语例句', 'cantonese_example']],
    ];
    for (const [key, aliases] of pairs) {
      for (const a of aliases) {
        const na = /^[\x00-\x7f]+$/.test(a) ? a.toLowerCase() : a;
        if (lowerAscii === na || raw === a) return key;
      }
    }
    return null;
  }

  /** 根据表头行生成 { 内部字段名: 列下标 } 映射；连 word 列都识别不出时返回 null（调用方会改用旧版固定列顺序） */
  buildImportColumnMap(headerCells) {
    const colMap = {};
    headerCells.forEach((cell, idx) => {
      const key = this.resolveImportHeaderKey(cell);
      if (key) colMap[key] = idx;
    });
    return colMap.word !== undefined ? colMap : null;
  }

  /** 旧版词典的固定列顺序兜底（表头无法识别时按位置取值：词/释义/音标/例句/分类/语言/粤拼/粤语例句） */
  getLegacyImportColumnMap() {
    return {
      word: 0,
      meaning: 1,
      phonetic: 2,
      example: 3,
      category: 4,
      language: 5,
      jyutping: 6,
      cantoneseExample: 7
    };
  }

  /** 把导入的一行原始数据规范化成标准词条对象：去空白、补 meaning/definition 双字段、
   *  缺分类时记为「未分类」、缺语言时按粤拼/汉字/英文推断，并初始化学习状态字段 */
  normalizeImportedWord(raw) {
    const meaning = String(raw.meaning ?? raw.definition ?? '').trim();
    const wordText = String(raw.word ?? '').trim();
    let language = String(raw.language ?? '').trim();
    if (!language) {
      const jp = String(raw.jyutping ?? '').trim();
      if (jp && /[\u4e00-\u9fff]/.test(wordText)) language = '粤语';
      else if (/[\u4e00-\u9fff]/.test(wordText)) language = '中文';
      else language = '英语';
    }
    return {
      word: wordText,
      meaning,
      definition: meaning,
      phonetic: String(raw.phonetic ?? '').trim(),
      example: String(raw.example ?? '').trim(),
      category: String(raw.category ?? '').trim() || '未分类',
      language,
      jyutping: String(raw.jyutping ?? '').trim(),
      cantonese: String(raw.cantonese ?? '').trim(),
      cantoneseExample: String(raw.cantoneseExample ?? '').trim(),
      // 词条分类标注：仅当明确为 word/phrase 时写入，供按分类统计/筛选使用
      dictScope: raw.dictScope === 'phrase' || raw.dictScope === 'word' ? raw.dictScope : undefined,
      favorite: !!raw.favorite,
      status: raw.status || 'new',
      reviewCount: raw.reviewCount ?? 0,
      lastReview: raw.lastReview ?? null,
      nextReview: raw.nextReview ?? null
    };
  }

  /**
   * 词条语种归类：english（含 legacy mandarin 英词卡）、cantonese、mandarin（普通话汉字）。
   * 用于语言角标、粤拼优先展示等。
   */
  getSpeechKind(word) {
    if (!word) return 'english';
    const raw = String(word.language || '').trim();
    const low = raw.toLowerCase();
    if (low === 'mandarin') return 'english';
    if (/粤语|广东话|粤語|廣東話/i.test(raw) || low === 'cantonese' || low === 'yue' || low === 'zh-yue') {
      return 'cantonese';
    }
    if (/英语|英文/i.test(raw) || low === 'english' || low === 'en') return 'english';
    if (/普通话|国语|中文|汉语/i.test(raw) || low === 'chinese' || low === 'zh-cn') return 'mandarin';
    if ((word.cantonese || '').trim()) return 'cantonese';
    const jp = (word.jyutping || '').trim();
    const phon = (word.phonetic || '').trim();
    const jyutpingLike =
      jp.length > 0 ||
      (phon.length > 0 &&
        /[a-z]{1,6}\d/i.test(phon) &&
        !/[ˈˌɜɪʊθðʃʒŋː]/.test(phon));
    const w = word.word || '';
    if (jyutpingLike && /[\u4e00-\u9fff]/.test(w)) return 'cantonese';
    if (/[\u4e00-\u9fff]/.test(w)) return 'mandarin';
    return 'english';
  }

  /** 没有 language 列时，根据发音类型推断卡片角标文字（粤语/英语/中文） */
  inferLanguageBadgeLabel(word) {
    const k = this.getSpeechKind(word);
    if (k === 'cantonese') return '粤语';
    if (k === 'english') return '英语';
    if (k === 'mandarin') return '中文';
    return '';
  }

  /** 卡片角标：优先使用表中 language 列原文，兼容旧数据 */
  getLanguageBadgeLabel(word) {
    let raw = String(word.language || '').trim();
    const low = raw.toLowerCase();
    if (low === 'mandarin') raw = '英语';
    else if (low === 'cantonese') raw = '粤语';
    else if (low === 'chinese') raw = '中文';
    if (raw) return raw;
    return this.inferLanguageBadgeLabel(word);
  }

  /**
   * 卡片顶部标签（语言 + 分类）的内层 HTML，学习页与练习页共用，保证两处完全一致。
   * 语言标签取词典 language 列；分类标签（如「家电数码」）受「分类显示」开关控制，
   * 没有可显示的内容时返回空串（调用方据此决定要不要渲染整行标签）。
   */
  buildCardBadgesHtml(word) {
    if (!word) return '';
    const badgeLabel = this.getLanguageBadgeLabel(word);
    let categoryHtml = '';
    if (this.settings.categoryDisplay !== false) {
      const category = word.category || '';
      if (category) {
        categoryHtml = `<span class="language-badge category-badge">${this.escapeHtml(category)}</span>`;
      }
    }
    const badgeHtml = badgeLabel
      ? `<span class="language-badge">${this.escapeHtml(badgeLabel)}</span>`
      : '';
    if (!badgeHtml && !categoryHtml) return '';
    return `${badgeHtml}${badgeHtml && categoryHtml ? '&nbsp;&nbsp;' : ''}${categoryHtml}`;
  }

  /** 切换学习卡片时，把词库菜单的分类勾选与「按字精确筛选」恢复为默认（全部分类） */
  resetLibraryCategorySelection() {
    // 置空后，下次 renderCategoryOptions 会把它恢复为「全部分类」勾选
    this.selectedCategories = null;
    this._libraryWordExactFilter = null;
  }

  /**
   * 学习卡片顶部「分类」标签点击：跳转词库菜单并按该分类筛选。
   * - 分类 tab 一律切到「全部」；
   * - 普通分类（如「常用短语」）：分类下拉框按 category-badge 内容精确筛选；
   * - 一字类分类（一字多音 / 一字一音 / 常用一音）：除了按该分类筛选，还进一步按学习卡
   *   当前的 word 字精确筛选，词库只展示该字（word）的全部记录，而不是该分类下的所有字。
   */
  handleCategoryBadgeClick(categoryText) {
    const cat = String(categoryText ?? '').trim();
    if (!cat) return;
    // 一字类分类：跳转后只展示学习卡当前 word 字，而非整个分类的所有字
    const ONE_CHAR_CLASSES = ['一字多音', '一字一音', '常用一音'];
    const isOneCharClass = ONE_CHAR_CLASSES.includes(cat);
    // 清掉「今日已掌握/今日待复习」带过来的今日筛选，保证是从「全部」口径进入
    this.resetLibraryTodayFilter();
    this.filterStatus = 'all';
    this.resetPageNum();
    this.selectedCategories = [cat];
    if (isOneCharClass) {
      const currentWord = this.todayWords && this.todayWords[this.currentCardIndex]
        ? String(this.todayWords[this.currentCardIndex].word || '').trim()
        : '';
      this._libraryWordExactFilter = currentWord || null;
      // 清掉搜索词，避免它与「按字精确筛选」叠加出错误结果
      this.searchQuery = '';
      const searchInput = document.getElementById('searchInput');
      if (searchInput) searchInput.value = '';
      const clearBtn = document.getElementById('searchClearBtn');
      if (clearBtn) clearBtn.style.display = 'none';
    } else {
      this._libraryWordExactFilter = null;
    }
    this.switchPage('library');
  }

  /** 该词条是否按粤语处理（决定音标优先展示粤拼） */
  isCantoneseWord(word) {
    return this.getSpeechKind(word) === 'cantonese';
  }

  /**
   * 给旧数据的收藏补上「收藏时间」(favoriteAt)。
   *
   * 收藏列表按 favoriteAt 倒序（最近收藏的在最上面）；旧版本没有这个字段，
   * 只能退化成按学习时间排，列表看起来就是乱的。
   * 这里用「最近学习时间 → 本机写入时间 → 词条创建时间」依次兜底，
   * favoriteAt 只存在本机（不上云），所以用 sync:false 写库、不触发上传。
   */
  async backfillFavoriteAt() {
    let words;
    try {
      words = await this.db.getAllWords();
    } catch (error) {
      return 0;
    }
    let updated = 0;
    for (const word of words) {
      if (!word.favorite || Number(word.favoriteAt)) continue;
      const fallback = Number(word.lastStudied) || Number(word.syncUpdatedAt) ||
        (word.createdAt ? new Date(word.createdAt).getTime() : 0) || 0;
      word.favoriteAt = fallback;
      await this.db.updateWord(word, { sync: false });
      updated++;
    }
    if (updated > 0) {
      console.info(`[收藏] 已为 ${updated} 条旧收藏补上收藏时间，收藏列表按最近收藏排序`);
    }
    return updated;
  }

  // 切换收藏状态
  async toggleFavorite(wordId) {
    let word;

    if (wordId) {
      // 根据id查找单词
      const words = await this.db.getAllWords();
      word = words.find(w => w.id === wordId);
      if (!word) return;
    } else {
      // 使用当前学习的单词
      if (this.currentCardIndex >= this.todayWords.length) return;
      word = this.todayWords[this.currentCardIndex];
    }
    
    word.favorite = !word.favorite;
    if (word.favorite) {
      // 记下收藏时间：收藏列表按它倒序，刚收藏的词立刻排在最上面。
      // 不能用 lastStudied 排序 —— 刚收藏但很久没学过的词会沉到列表末尾，
      // 看起来就像「收藏没生效 / 跳过后收藏丢了」。
      word.favoriteAt = this.nowMs();
    } else {
      delete word.favoriteAt;
    }

    try {
      await this.db.updateWord(word);
    } catch (error) {
      console.error('保存收藏状态失败:', error);
      word.favorite = !word.favorite; // 回滚内存状态，避免界面与库不一致
      this.showToast('收藏保存失败，请重试');
      return;
    }

    // 同步到内存中的所有副本（今日队列 / 会话快照 / 跳过补牌缓存 / 同词分组）
    this.syncWordCopies(word);

    const shouldRefreshFavoriteUi =
      !wordId ||
      (this.currentPage === 'learn' &&
        this.currentCardIndex < this.todayWords.length &&
        this.todayWords[this.currentCardIndex]?.id === word.id);

    if (shouldRefreshFavoriteUi) {
      document.querySelectorAll('.favorite-btn').forEach((btn) => {
        btn.classList.toggle('active', word.favorite);
      });
    }
    
    this.showToast(word.favorite ? '已添加收藏' : '已取消收藏');
    // 返回更新后的词条：词库页据此判断「收藏」学习范围的成员是否变了
    return word;
  }

  /** 标记为困难；releaseOffset 含义同 skipCard（按钮触发时为 0） */
  markDifficult(releaseOffset = 0) {
    if (this._cardAnimating) return;
    // 当前学习范围已学完：按钮仍可见，但不再记录任何数值（快捷键/滑动同此逻辑）
    if (this._learnView === 'scopeComplete') return;
    if (this.currentCardIndex >= this.todayWords.length) return;

    const word = this.todayWords[this.currentCardIndex];
    // 这张卡已经处理过：撤销“词库外部加入范围”的强制入队标记
    this.clearExternalScopeInclude(word.id);
    // 进度条与「今日待复习」同口径（去重词条）：今天已经计入过统计的词条再次学习时，
    // 今日统计不会再增加，进度条也不该增加，否则两者会差出 1~2 个
    const countsTowardProgress = !this.isWordCountedToday(word);
    word.status = 'review';
    word.lastStudied = this.nowMs(); // 记录学习时间（同步可用时用服务端基准，避免两端时钟偏差）
    // 记入学习范围的“学过一遍”集合（待复习/全部/收藏等）
    this.markScopePassDone(word);

    // 乐观更新今日统计：写库是异步的，等它回来之前上方数字也要立刻 += 1，
    // 否则完成页会短暂显示 99/100（与进度条同源，所以两者一起改，始终一致）
    if (countsTowardProgress) this.bumpTodayStatsOptimistically('review');

    // 切卡动画与落库解耦：先同步推进卡片（与「跳过」一致立即开始滑出/滑入动画），
    // 再把写库、写统计、刷新累计统计放到后台执行，避免 IO 期间卡片停在画外造成卡顿
    this._sequenceCard('right', releaseOffset, countsTowardProgress);
    this._persistStudyAction(word).catch((err) => {
      console.error('保存「需复习」状态失败:', err);
    });
  }

  /**
   * 为「跳过」挑一张补进队列的新卡。
   *
   * 从当前学习范围里挑「本轮还没学过一遍、还没排进队列、本次会话也没跳过」的词。
   * 跳过不会把词标记为学过，所以补不到时调用方会把原词放回队尾，它仍然算没学完。
   *
   * 说明：候选来自 prepareLearnSession 缓存的 _scopePoolCache；本次会话跳过的词
   * 记录在 _skippedWordIds 里（只在内存，不写进学习记录）。
   */
  pickSkipReplacement(skippedWord) {
    const pool = this._scopePoolCache || [];
    if (pool.length === 0) return null;
    const scope = this.normalizeStudyScope(this.settings.studyScope);
    const done = this._scopePassDone[scope] || new Set();

    // 已在队列里的（含刚补进来的）与刚跳过的都不再选
    const queuedIds = new Set(this.todayWords.map((w) => w.id));
    if (skippedWord) queuedIds.add(skippedWord.id);

    const candidates = pool.filter((w) => {
      if (!w || queuedIds.has(w.id)) return false;
      // 本次会话已经跳过的词不再补进来：否则刚跳过的那张马上又会出现
      if (this._skippedWordIds.has(w.id)) return false;
      if (!this.isWordInActiveScope(w)) return false;
      if (!this.isWordInStudyScope(w, scope)) return false;
      // 本轮已经学过一遍的词不再补
      const key = this.dictKeyOf(w);
      if (key && done.has(key)) return false;
      return true;
    });

    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  /**
   * 跳过卡片。
   * releaseOffset：滑动松手时卡片位移占卡片宽度的比例（按钮触发时为 0），
   * 用于让过场动画从卡片当前位置无缝接续。
   *
   * 语义是「换一张没见过的词」，而不是把同一批词在今日队列里循环：
   *   1) 把当前词移出队列，并记下学习时间，使它在今天（以及重复频率静默期内）不再出现；
   *   2) 从当前词典范围补一张今天还没排进队列的新词放到队尾；补不到时
   *      （范围内确实没有新词了）才退回旧行为，把被跳过的词放回队尾；
   *   3) 队列长度保持不变，因此不会在队列末尾被误判成「今日已完成」。
   *
   * 注意 currentCardIndex 的回退：splice 把当前词移走后，原本的「下一张」已经落到
   * 当前下标上，而 _sequenceCard 会自增下标，若不回退一格就会把下一张一起吞掉
   * （旧实现在此基础上又把跳过的词挪到队尾，队列短时下一张就又看到它，表现为“循环跳过”）。
   */
  skipCard(releaseOffset = 0) {
    if (this._cardAnimating) return;
    // 当前学习范围已学完：跳过也不再生效（不换卡、不记录数值）
    if (this._learnView === 'scopeComplete') return;
    if (this.currentCardIndex >= this.todayWords.length) return;

    const skippedIndex = this.currentCardIndex;
    // 将当前卡片移出队列（纯内存操作，立即完成，保证下一张内容可同步渲染）
    const skipped = this.todayWords.splice(skippedIndex, 1)[0];

    // 跳过不记录学习进度：不写词条的 status / lastStudied，也不计入今日完成张数。
    // 只在内存里记住「本次会话已经跳过它」，避免它马上又被补回来。
    this._skippedWordIds.add(skipped.id);

    // 补一张新词到队尾；范围内没有新词可补时才把跳过的词放回队尾
    const replacement = this.pickSkipReplacement(skipped);
    this.todayWords.push(replacement || skipped);
    // 补进来的一定是「今天还没学过」的词，队列里又有能推进度的卡了
    if (replacement) this._queueHasFreshWords = true;

    // 回退一格，抵消 _sequenceCard 的自增：让补位到当前下标的「下一张」正常显示
    this.currentCardIndex = skippedIndex - 1;

    // 复用与「已掌握」相同的过场动画，保证左右滑动观感一致。
    // 第三个参数 false：跳过不计入今日完成张数，进度条与完成判断都不受影响。
    this._sequenceCard('right', releaseOffset, false);

    // 这里保存的是「今日队列」本身（跳过换掉了队列里的卡），不是学习记录：
    // 不保存的话，跳过几张后切后台/刷新，恢复出来的还是跳过之前的队列，等于跳过白做了。
    this.saveLearnProgress().catch((err) => {
      console.error('保存跳过后的今日队列失败:', err);
    });
  }

  /** 标记为已掌握；releaseOffset 含义同 skipCard */
  markMastered(releaseOffset = 0) {
    if (this._cardAnimating) return;
    // 当前学习范围已学完：按钮仍可见，但不再记录任何数值（快捷键/滑动同此逻辑）
    if (this._learnView === 'scopeComplete') return;
    if (this.currentCardIndex >= this.todayWords.length) return;

    const word = this.todayWords[this.currentCardIndex];
    // 同 markDifficult：撤销“词库外部加入范围”的强制入队标记
    this.clearExternalScopeInclude(word.id);
    // 同 markDifficult：今天已计入统计的词条不再重复推进度，保证进度条与今日统计同口径
    const countsTowardProgress = !this.isWordCountedToday(word);
    word.status = 'mastered';
    word.lastStudied = this.nowMs(); // 记录学习时间（同步可用时用服务端基准）
    // 记入学习范围的“学过一遍”集合（已掌握/全部/收藏等）
    this.markScopePassDone(word);

    // 乐观更新今日统计（理由见 markDifficult）
    if (countsTowardProgress) this.bumpTodayStatsOptimistically('mastered');

    // 同 markDifficult：先同步切卡，落库在后台进行。
    // 这样左滑（已掌握）与右滑（跳过）的动画时序完全一致，不再出现中途闪烁。
    this._sequenceCard('left', releaseOffset, countsTowardProgress);
    this._persistStudyAction(word).catch((err) => {
      console.error('保存「已掌握」状态失败:', err);
    });
  }

  /**
   * 乐观地把今日统计 +1（掌握 / 待复习）。
   *
   * 点「掌握 / 陌生」后卡片立即切走，真正的统计要等写库完成才重算；
   * 这一小段时间里上方数字与进度条都应当立刻更新，否则学完最后一张会
   * 短暂显示 99/100（用户以为最后一张没被统计）。
   * 随后的 refreshStatusCounts 会用库里的真实值覆盖，两者最终必然一致。
   */
  bumpTodayStatsOptimistically(kind) {
    const key = kind === 'review' ? 'review' : 'mastered';
    if (!this.todayStats) this.todayStats = { mastered: 0, review: 0, total: 0 };
    this.todayStats[key] = Math.max(0, Number(this.todayStats[key]) || 0) + 1;
    this.syncActiveStatsMirrors();
  }

  /**
   * 持久化一次学习动作（掌握 mastered / 需复习 review）：
   * 写词条状态 → 保存学习进度 → 按最新状态重算今日/累计统计。
   *
   * 统计不能用「在旧数字上 +1」的方式累加：同一张卡今天先点掌握、再改点陌生时，
   * 掌握数不会因为状态被改掉而回退，两个数字就会同时虚增。
   * 这里统一交给 refreshStatusCounts() 依据词条的最终状态整体重算，保证与
   * 「今日=今天学过且当前状态为掌握/待复习」「累计=当前所有掌握/待复习」的口径一致。
   *
   * 注意：本方法不参与任何动画时序，仅供后台调用，异常由调用方捕获。
   */
  async _persistStudyAction(word) {
    if (!word) return;
    this._pendingPersistCount = (this._pendingPersistCount || 0) + 1;
    try {
      await this.db.updateWord(word);
      // 同一个词（分类+词汇+音标相同）的词条可能有多条：状态必须整组一致，
      // 否则云端那一行只会代表其中一条，另一条的学习记录同步不出去、两端统计对不上
      await this.applyStatusToWordGroup(word, word.status, word.lastStudied);
      // 保存学习进度
      await this.saveLearnProgress();
      // 按最新词条状态重算今日/累计统计（含学习页与词库页显示）
      await this.refreshStatusCounts();
    } catch (error) {
      // 写库失败：刚才的乐观 +1 不再可靠，标记需要校准
      this._statsMayBeStale = true;
      throw error;
    } finally {
      this._pendingPersistCount = Math.max(0, (this._pendingPersistCount || 1) - 1);
      if (this._pendingPersistCount === 0 && this._statsMayBeStale) {
        // 之前有统计快照落后于乐观值（被「不回退」保护挡下过）：
        // 现在所有动作都已落库，用真实统计校准一次
        this._statsMayBeStale = false;
        try {
          await this.refreshStatusCounts();
        } catch (error) {
          console.warn('[learn] 收尾统计刷新失败:', error);
        }
      }
    }
  }

  /**
   * 方向一致的“旧卡滑出 → 新卡滑入”过场：fromDirection 指示滑出方向
   * （left 左滑=已掌握 / right 右滑=跳过）。
   *
   * 时序设计（目的是既快又不出现空白）：
   *   1. 滑出阶段只把卡片带到“刚好整张离屏”的位置，不空跑；
   *   2. 换内容发生在卡片已离屏之后、新卡露出之前的那一瞬间，且在画外完成，
   *      因此画面里始终有卡片，不会出现短暂的空白；
   *   3. 新卡的入场起点就接在旧卡离屏的位置上，所以两段动画在视觉上是一条
   *      连续的滑动轨迹（旧卡滑出 → 新卡从同一侧继续滑到中央）。
   *
   * releaseOffset 为松手时卡片位移占卡片宽度的比例（按钮/未拖动时为 0）：
   * 拖动越远，剩余滑出路程越短、滑出越快，避免出现忽快忽慢或空等。
   *
   * countsTowardProgress=false 时本次切卡不计入今日完成数（「跳过」用，以及
   * 「今天已经学过、已计入今日统计」的重复学习）。进度条与「今日目标已达成」的判断
   * 因此始终与上方的「今日已掌握 + 今日待复习」保持同一口径。
   *
   * 本方法完全同步、发起后立即返回，动画由定时器自行推进，因此调用方可以在
   * 触发动画后立刻去做写库等异步工作，两者互不阻塞。
   */
  _sequenceCard(fromDirection = 'right', releaseOffset = 0, countsTowardProgress = true) {
    // 防抖：过场动画进行中忽略重复触发，避免索引与动画错位
    if (this._cardAnimating) return;
    // 切卡时取消待执行的「单击翻面」，避免卡片在滑出过程中被上一次点击翻转
    this._cancelPendingCardFlip();
    this._cardPointerMoved = false;
    this._cardLongPressFired = false;
    this._cardLongPressText = '';
    this._cardTouchLongPress = false;
    this.currentCardIndex++;
    // 跨天（页面常驻过夜）时先把本轮进度归零，避免拿昨天的完成数误判「今日目标已达成」
    this.rollOverRoundIfNewDay();
    // 本轮完成数 +1。掌握/陌生且该词条今天还没计入统计时算一个；「跳过」不算
    // （countsTowardProgress=false），重复学习同一词条也不算 —— 口径与今日统计一致。
    if (countsTowardProgress) this.todayDoneCount++;
    // 队列背完、或本轮完成数达到每日目标时，收卡。
    // 第二个条件不可少：队列里还剩着卡片但目标已满时若不拦住，用户会以为「进度满了还能一直学」。
    if (this.currentCardIndex >= this.todayWords.length || this.isDailyGoalReached()) {
      if (this.isDailyGoalReached()) {
        // 每日目标达成：照旧显示完成页与【继续学习】
        this.showComplete();
        this.updateProgress();
        this.refreshGoalSliderLockedState();
      } else {
        // 还没到今日目标：只有当前 tab 里的单词全部学过一遍才提示「已学完」；
        // 还有没学过的词（本轮没排到 / 新增词条）就继续组下一批，不弹红字。
        this.updateProgress();
        this.refreshGoalSliderLockedState();
        this.handleScopeQueueEnd().catch((error) => {
          console.error('[learn] 继续当前学习范围失败:', error);
        });
      }
      return;
    }

    const card = document.getElementById('flashcard');
    const sign = fromDirection === 'left' ? -1 : 1;

    // 卡片宽度与左右留白（.card-stack 有 8px 内边距）：用于算出“刚好整张移出可视区”的精确距离
    const cardWidth = this._getCardWidth();
    const startPx = releaseOffset * cardWidth;
    const clearPx = cardWidth + CARD_CLEAR_MARGIN_PX - this._getCardGutterPx();

    // 关键帧位移（px，正=向右滑出，负=向左滑出）：
    //   startPx   松手时卡片所在位置（按钮触发时为 0=居中）
    //   clearPx   卡片“刚好整张离开可视区”的位置，滑出动画只跑到这里为止
    //   parkPx    换卡落点：再往画外多走一点，确保换内容瞬间卡片本体不可见
    //   finishPx  新卡入场起点，接在旧卡离屏处，视觉上轨迹连续
    const parkPx = clearPx + CARD_PARK_MARGIN_PX;
    const finishPx = clearPx + CARD_FINISH_MARGIN_PX;

    // 滑出时长按剩余可见路程换算：拖得越远，剩下的路越短、滑得越快
    const visibleTravelPx = Math.abs(sign * clearPx - startPx);
    const exitMs = Math.round(
      Math.min(PLAY_SPEED_MS_PER_CARD_WIDTH * (visibleTravelPx / cardWidth), CARD_EXIT_MAX_MS)
    );

    this._cardAnimating = true;
    card.style.transition = `transform ${exitMs}ms ${CARD_SWIPE_EASE}`;
    card.style.transform = this._cardTransform(sign * clearPx, cardWidth);

    setTimeout(() => {
      // 此刻旧卡整张已离开可视区：关掉过渡，在看不见的位置换内容并挪到入场起点。
      // （强制一次样式刷新，确保这个“硬”位置被浏览器采纳，否则紧接着重新启用
      //   过渡时可能被合并掉而失去补间起点）
      card.style.transition = 'none';
      card.style.transform = this._cardTransform(sign * parkPx, cardWidth);
      void card.offsetWidth;
      card.style.transform = this._cardTransform(sign * finishPx, cardWidth);
      this.showCard(this.currentCardIndex);

      // 下一帧立即启用过渡并归位：没有额外等待，新卡紧接着滑入
      const slideIn = () => {
        card.style.transition = `transform ${CARD_ENTRY_MS}ms ${CARD_SWIPE_EASE}`;
        card.style.transform = '';
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(slideIn);
      } else {
        setTimeout(slideIn, 16);
      }
      this._cardAnimating = false;
    }, exitMs);

    this.updateProgress();
    this.refreshGoalSliderLockedState();
  }

  /** 生成卡片平移+旋转的 transform 字符串；translatePx 为位移像素（正=向右滑出） */
  _cardTransform(translatePx, cardWidth) {
    const rotateDeg = cardWidth > 0 ? (translatePx / cardWidth) * 10 : 0;
    return `translateX(${Math.round(translatePx)}px) rotate(${rotateDeg}deg)`;
  }

  /** 取卡片宽度（px），用于把触摸位移换算成像素；拿不到时退回视口宽度的 85% */
  _getCardWidth() {
    const card = document.getElementById('flashcard');
    const w = card ? card.getBoundingClientRect().width : 0;
    if (w > 0) return w;
    return (window.innerWidth || 360) * 0.85;
  }

  /** 卡片左右留白（px）：用于计算“刚好整张移出可视区”的位置 */
  _getCardGutterPx() {
    const stack = document.querySelector('.card-stack');
    if (!stack) return CARD_STACK_GUTTER_PX;
    const rect = stack.getBoundingClientRect();
    // 词卡在 card-stack 内左右各留 padding，卡片宽度之外的这部分就是画外余量
    return Math.max(0, (rect.width - this._getCardWidth()) / 2) || CARD_STACK_GUTTER_PX;
  }

  /**
   * 更新进度：进度条与数字按「本轮已完成的去重词条数」计，而不是当前队列的下标。
   *
   * 本轮完成数 = 今日已计入统计的词条数 − 本轮起点，与上方的「今日已掌握 + 今日待复习」
   * 是同一口径，因此两者永远相等（早期版本按“点过的卡片张数”算，同一词条学两次会多算，
   * 学完 100 张时上方两数之和只有 98/99）。
   *
   * 分母永远是设置页里的每日目标，**不会自己变化**：
   * 上方显示的就是「已完成 / 每日目标」，只有用户在设置页改目标时它才变
   * （改目标会同时把本轮起点前移，进度从 0 开始）。
   */
  updateProgress() {
    const goal = Math.max(0, Number(this.settings.dailyGoal) || 0);
    const done = Math.max(0, Number(this.todayDoneCount) || 0);
    const shown = goal > 0 ? Math.min(done, goal) : done;
    const progress = goal > 0 ? Math.round((shown / goal) * 100) : 0;

    document.getElementById('progressFill').style.width = `${progress}%`;
    document.getElementById('progressText').textContent = `${shown}/${goal}`;

    // 今日统计 = 今天学习且当前状态为掌握/待复习的词条数
    document.getElementById('statMastered').textContent = this.todayStats.mastered;
    document.getElementById('statReview').textContent = this.todayStats.review;

    // 累计统计 = 当前词库中各状态的真实词条数（与词库页筛选结果一致）
    document.getElementById('totalMastered').textContent = this._cachedStatusCounts.mastered;
    document.getElementById('totalReview').textContent = this._cachedStatusCounts.review;

    // 可点击状态：数字 ≥ 1 才允许点击跳转（四个数字同一套规则）
    const setStatPointer = (id, count) => {
      const el = document.getElementById(id);
      if (!el) return;
      const active = count >= 1;
      el.style.cursor = active ? 'pointer' : 'default';
      el.style.opacity = active ? '1' : '0.6';
    };
    setStatPointer('statMastered', this.todayStats.mastered);
    setStatPointer('statReview', this.todayStats.review);
    setStatPointer('totalMastered', this._cachedStatusCounts.mastered);
    setStatPointer('totalReview', this._cachedStatusCounts.review);
  }
  
  /**
   * 从学习卡上方的「今日已掌握 / 今日待复习」跳到词库页：
   * 这两个数字是“今日”口径，因此同时打开“只看今天学过的”筛选，
   * 让列表条数与数字对得上；从词库菜单直接进来时不会带上这个筛选（累计口径）。
   */
  handleStatClick(filter) {
    const count = filter === 'mastered' ? this.todayStats.mastered : this.todayStats.review;
    if (count >= 1) {
      this.filterStatus = filter;
      this._libraryTodayOnly = true;
      this._libraryTodayKind = filter;
      this.switchPage('library');
    }
  }

  /** 「累计已掌握 / 累计待复习」是累计口径，跳转后按状态筛选全部，不加“今日”条件 */
  handleTotalStatClick(filter) {
    const count = filter === 'mastered'
      ? this._cachedStatusCounts.mastered
      : this._cachedStatusCounts.review;
    if (count >= 1) {
      this.filterStatus = filter;
      this._libraryTodayOnly = false;
      this._libraryTodayKind = null;
      this.switchPage('library');
    }
  }

  /** 关闭“只看今天学过的”筛选（离开词库页、或手动切换选项卡时调用） */
  resetLibraryTodayFilter() {
    this._libraryTodayOnly = false;
    this._libraryTodayKind = null;
  }

  /**
   * 今日目标是否已达成（进度条走到 100%）。
   *
   * 判定就是「本轮完成数 ≥ 设置页里的每日目标」—— 分母与它同源，
   * 目标数值只在设置页改动时才变。
   * 若今天可学的词条已经学完但还没到目标，进度条就停在真实数字上（不虚增、也不改分母），
   * 完成页会写明「今日可学词条已全部学完」。
   */
  isDailyGoalReached() {
    const goal = Math.max(0, Number(this.settings.dailyGoal) || 0);
    return goal > 0 && Math.max(0, Number(this.todayDoneCount) || 0) >= goal;
  }

  // 显示完成页面
  showComplete() {
    this._learnView = 'complete';
    // 完成页与「范围学完」红字提示互斥；按钮随卡片区域一起隐藏
    this.hideScopeComplete();
    document.querySelector('.card-stack').style.display = 'none';
    document.querySelector('.complete-container').style.display = 'flex';
    // 完成页与空状态互斥：否则「还没有可学习的单词」会和【继续学习】按钮同时出现在屏幕上
    const emptyState = document.getElementById('learnEmptyState');
    if (emptyState) emptyState.style.display = 'none';

    // 真正达成今日目标时记下日期与目标值：之后统计万一少 1~2 条
    // （词典更新删词 / 另一端改动），也不会让「已完成」退回 99/100。
    // 记录目标值是为了区分「同一个目标下的统计回落」和「目标被改过了」：
    // 后者不能再沿用旧完成态，否则 10/15 会被补成 15/15。
    const goal = Math.max(0, Number(this.settings.dailyGoal) || 0);
    if (this.isDailyGoalReached()) {
      const today = this.todayKey();
      if (this._todayGoalReachedDate !== today || this._todayGoalReachedGoal !== goal) {
        this._todayGoalReachedDate = today;
        this._todayGoalReachedGoal = goal;
        this.db.setSetting('todayGoalReached', { date: today, goal }).catch(() => {});
      }
    }

    // 文案：
    //   - 真正达到每日目标 → 「今日学习目标已完成」；
    //   - 今天可学的词条已学完但没到目标（例如范围内只剩 20 条）→ 说明原因，
    //     并且不写成分数，免得看起来像目标被改小了（目标始终是设置页里的那个数）。
    const done = Math.max(0, Number(this.todayDoneCount) || 0);
    const subtitle = document.querySelector('.complete-subtitle');
    if (subtitle) {
      if (goal > 0 && done >= goal) {
        subtitle.textContent = '今日学习目标已完成';
      } else if (this.remainingFreshInQueue() === 0) {
        subtitle.textContent = `今日可学词条已全部学完（已完成 ${Math.min(done, goal)}）`;
      } else {
        subtitle.textContent = `本轮已完成（${Math.min(done, goal)}/${goal}）`;
      }
    }
  }

  // 显示空状态（只有当前词典范围里确实一个词条都没有时才会走到这里）
  showEmptyState() {
    this._learnView = 'empty';
    this.hideScopeComplete();
    document.querySelector('.card-stack').style.display = 'none';
    const completeContainer = document.querySelector('.complete-container');
    if (completeContainer) completeContainer.style.display = 'none';
    const emptyState = document.getElementById('learnEmptyState');
    if (emptyState) emptyState.style.display = 'flex';
  }

  /**
   * 继续学习 / 再来一轮。
   *
   * 关键点：只有「本轮完成数已经达到每日目标」时才把本轮起点前移（进度归零），否则原样保留 ——
   * 进度条 = 今日已计入统计的词条数 − 本轮起点，所以没达标时它会接着往上走；
   * 「今天可学词条已学完但没到目标」的情况不清零，进度数字保持稳定，完成页会说明原因。
   */
  async restartLearn() {
    if (this.isDailyGoalReached()) {
      // 目标已达成：起点前移，进度归零，开始新的一轮（分母仍是设置页里的每日目标）
      await this.resetTodayDoneCount();
    }
    // 重置当前卡片索引为0
    this.currentCardIndex = 0;
    // 清除保存的学习进度，确保重新生成队列
    // （必须 await：否则紧接着的 prepareLearnSession 可能读回刚清掉的旧进度，
    //   表现就是点【继续学习】没有任何反应）
    // 注意这里不动本轮起点：没达标时进度条要接着上一轮的数字继续涨
    await this.db.setSetting('learnProgress', null);
    // 会话快照一并作废，避免切页时又恢复回旧队列
    this._learnSessionSnapshot = null;
    // 重新生成学习队列（范围内词条都学过时会自动进入「复习轮」）
    await this.prepareLearnSession();
  }

  /**
   * 红字「已学完【…】，是否继续？」下方的【继续学习】。
   *
   * 只重置当前学习范围的“学过一遍”集合，让该 tab 的单词重新变成待学；
   * 其它 tab 的完成进度、今日统计与本轮起点都不动，点击后仍停留在同一个学习范围。
   */
  async restartScopeLearn() {
    // 当前 tab 一个词都没有时没有可继续的内容
    if (!Array.isArray(this._scopePoolCache) || this._scopePoolCache.length === 0) return;
    const scope = this.normalizeStudyScope(this.settings.studyScope);
    this._scopePassDone[scope] = new Set();
    await this.saveScopePass();

    // 旧队列/快照/红字状态作废；今日进度保持连续
    this._learnSessionSnapshot = null;
    this.todayWords = [];
    this.currentCardIndex = 0;
    this._queueHasFreshWords = true;
    this._externalScopeIncludeIds.clear();
    this._externalScopeIncludeScope = scope;
    this.clearCardDisplay();
    await this.db.setSetting('learnProgress', null);
    await this.prepareLearnSession();
    // 把新一轮队列落库，刷新后能接着学
    await this.saveLearnProgress();
    this.updateProgress();
  }

  // ==================== 练习页面 ====================
  // 与学习页的区别：只看词汇写出粤拼音标，不写任何学习记录（不改 status/收藏/今日统计）。
  //   1) 范围可单独选（全部 / 短语 / 字），与设置页的「词典导入」互不影响；
  //   2) 输入模式可选「含调值 / 不含调值」，决定音标里的声调数字要不要一起输入；
  //   3) 卡片只保留翻转，去掉滑动、收藏与三个操作按钮；
  //   4) 卡片下方是输入框：每音节输入正确自动补空格，错误标红，整条正确标绿。

  /** 练习页事件绑定：卡片翻面、输入框、键盘开关、再练一轮（范围与调值开关在设置页） */
  bindPracticeEvents() {
    const self = this;

    const card = document.getElementById('practiceFlashcard');
    if (card) {
      // 与学习卡同一套翻面手势：单击翻面；双击选词、长按取词、拖选文字都不翻面
      this._bindCardFlipGesture(card, () => self.flipPracticeCard());
      // 触屏：短按翻面 + 长按取词复制（练习卡没有左右滑动切卡，故 allowSwipe = false）
      this.initCardSwipe(card, () => self.flipPracticeCard(), false);
      // 鼠标长按取词复制
      this.initCardTextSelection(card);
    }

    const input = document.getElementById('practiceInput');
    if (input) {
      // 「不含调值」模式下声调数字不需要输入：直接拦掉数字键，
      // 否则用户打完字母顺手敲的调值会被当成下一段的开头而判错
      input.addEventListener('beforeinput', (e) => {
        if (self.settings.practiceToneMode !== 'without') return;
        if (e.inputType === 'insertText' && /^[1-6]+$/.test(e.data || '')) {
          e.preventDefault();
        }
      });
      input.addEventListener('input', (e) => self.handlePracticeInput(e));
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        // 只有整条音标已经输入正确时才允许回车立刻进入下一题，避免误跳过
        if (input.classList.contains('success')) self.nextPracticeCard();
      });
      // 手机上聚焦输入框时把输入区滚进可视范围（底部导航/软键盘容易把它挡住）
      input.addEventListener('focus', () => {
        setTimeout(() => {
          if (self.currentPage === 'practice') input.scrollIntoView({ block: 'nearest' });
        }, 120);
      });
    }

    this._bindTap(document.getElementById('practiceRestartBtn'), () => self.restartPractice());

    // 点击输入框以外的地方就收起软键盘：键盘只服务于输入，
    // 不该一直占着半屏（点卡片看答案、切范围、切菜单时都会自动收回）
    document.addEventListener('pointerdown', (e) => {
      if (self.currentPage !== 'practice') return;
      const input = document.getElementById('practiceInput');
      if (!input || document.activeElement !== input) return;
      if (e.target === input) return;
      input.blur();
    });

    // 固定键盘（26 字母 + 1~6 调值 + 退格）：点键即输入
    const keyboard = document.getElementById('practiceKeyboard');
    if (keyboard) {
      keyboard.addEventListener('click', (e) => {
        const key = e.target.closest ? e.target.closest('.practice-key') : null;
        if (!key) return;
        e.preventDefault();
        const value = key.dataset.key;
        if (value === 'backspace') self.practiceBackspace();
        else self.practiceTypeChar(value);
      });
      // 长按键盘不要弹出系统的选择/放大镜
      keyboard.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    // 输入框右侧的箭头：展开 / 收起键盘
    const keyboardToggle = document.getElementById('practiceKeyboardToggle');
    if (keyboardToggle) {
      keyboardToggle.addEventListener('click', (e) => {
        e.preventDefault();
        self.togglePracticeKeyboard();
      });
    }

    // 桌面端物理键盘：输入框是 readonly，浏览器默认输入已被关掉，
    // 字母 / 数字 / 退格全部走与虚拟键盘相同的这一套逻辑，两边行为完全一致
    // （Shift 翻卡片在学习页与练习页都生效，统一绑在 bindEvents 里）
    document.addEventListener('keydown', (e) => {
      if (self.currentPage !== 'practice') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Backspace') {
        e.preventDefault();
        self.practiceBackspace();
        return;
      }
      if (/^[a-zA-Z]$/.test(e.key)) {
        e.preventDefault();
        self.practiceTypeChar(e.key.toLowerCase());
        return;
      }
      if (/^[1-6]$/.test(e.key)) {
        e.preventDefault();
        self.practiceTypeChar(e.key);
      }
    });
  }

  /** 输入一个字符（固定键盘与物理键盘共用）：追加到末尾后交给统一的判定逻辑 */
  practiceTypeChar(ch) {
    const input = document.getElementById('practiceInput');
    if (!input || !ch) return;
    // 「不含调值」模式不需要声调数字：按了也忽略，免得白白标红
    if (this.settings.practiceToneMode === 'without' && /[1-6]/.test(ch)) return;
    input.value += ch;
    input.selectionStart = input.selectionEnd = input.value.length;
    this.handlePracticeInput({ target: input, inputType: 'insertText', isComposing: false });
  }

  /** 退格：删掉输入框最后一个字符（已答对时 handlePracticeInput 会把内容还原） */
  practiceBackspace() {
    const input = document.getElementById('practiceInput');
    if (!input || !input.value) return;
    input.value = input.value.slice(0, -1);
    input.selectionStart = input.selectionEnd = input.value.length;
    this.handlePracticeInput({ target: input, inputType: 'deleteContentBackward', isComposing: false });
  }

  /**
   * 按当前开关状态显示 / 隐藏底部固定键盘，并同步箭头的朝向。
   * topicVisible = false（空状态、完成页）时一律隐藏：那里没有题目可做。
   */
  applyPracticeKeyboardState(topicVisible = true) {
    const open = topicVisible && !!this._practiceKeyboardOpen;
    const keyboard = document.getElementById('practiceKeyboard');
    const toggle = document.getElementById('practiceKeyboardToggle');
    if (keyboard) keyboard.style.display = open ? 'flex' : 'none';
    if (toggle) {
      toggle.classList.toggle('active', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  }

  /** 点箭头：展开 / 收起键盘 */
  togglePracticeKeyboard() {
    this._practiceKeyboardOpen = !this._practiceKeyboardOpen;
    const open = this._practiceKeyboardOpen;
    this.applyPracticeKeyboardState(true);
    // 键盘展开会挤压卡片区：把输入框滚回可视范围，别让它贴着键盘被顶出屏幕
    if (open) {
      const input = document.getElementById('practiceInput');
      if (input && typeof input.scrollIntoView === 'function') {
        setTimeout(() => input.scrollIntoView({ block: 'nearest' }), 0);
      }
    }
  }

  /** 把设置页「练习设置」里的控件刷新成当前设置值（词典导入下拉、显示调值开关） */
  refreshPracticeSettingsControls() {
    const scopeSelect = document.getElementById('practiceScopeSelect');
    if (scopeSelect) scopeSelect.value = this.settings.practiceScope || 'all';
    const toneToggle = document.getElementById('practiceToneToggle');
    if (toneToggle) {
      toneToggle.classList.toggle('active', this.settings.practiceToneMode !== 'without');
    }
  }

  /** 进入练习页：范围 / 单词顺序没变就接着上次的进度，变了才重新抽题 */
  async enterPracticePage() {
    this.cancelPracticeAdvance();
    if (this._practicePoolKey !== this.practicePoolKey() || this.practiceWords.length === 0) {
      await this.preparePracticePool();
    }
    // 池子复用时总数缓存仍然有效，但进度是实时算的，进页面就刷一次
    this.refreshPracticeProgressUI();
    this.renderPracticeCard();
  }

  /**
   * 练习队列的标识：范围 + 单词顺序。
   * 设置页改了「词典导入」（范围）或「单词顺序」（顺序 / 随机）都会让这个值变化，
   * 下次进入练习页就会按新设置重排队列。
   */
  practicePoolKey() {
    return `${this.settings.practiceScope || 'all'}|${this.settings.learnMode || 'random'}`;
  }

  /**
   * 组织本轮练习队列：取当前练习范围内的词条，只保留「音标能解析出音节」的，
   * 从第一题开始。练习不写学习记录，因此不做重复频率、进度恢复等处理。
   *
   * 队列顺序：
   *   1) 先排「还没练过」的词条，再把练过的排在后面 —— 进度条会一直往前走，
   *      而不是一遍遍重复已经完成的词；
   *   2) 组内顺序跟随设置页的「单词顺序」：随机 = 打乱，顺序 = 保持词典本身的顺序。
   */
  async preparePracticePool() {
    const scope = this.settings.practiceScope || 'all';
    const allWords = await this.db.getAllWords();
    const pool = [];
    for (const word of allWords) {
      if (scope !== 'all' && this.practiceScopeKeyOf(word) !== scope) continue;
      if (this.parsePracticeSyllables(word).length === 0) continue;
      pool.push(word);
    }

    // 进度条分母 = 当前范围内全部可练习词条（含已练过的）
    this._practiceScopeTotal = pool.length;

    const pending = [];
    const finished = [];
    for (const word of pool) {
      (this.isPracticeDone(word) ? finished : pending).push(word);
    }
    // 与学习页共用「单词顺序」设置：顺序模式按词典原序，随机模式打乱
    if ((this.settings.learnMode || 'random') !== 'sequential') {
      this.shuffleArray(pending);
      this.shuffleArray(finished);
    }

    this.practiceWords = pending.concat(finished);
    this.practiceIndex = 0;
    this._practicePoolKey = this.practicePoolKey();
    this.refreshPracticeProgressUI();
  }

  /** 词条归属的练习范围键：'phrase'（短语）或 'word'（字） */
  practiceScopeKeyOf(word) {
    return word && word.dictScope === 'phrase' ? 'phrase' : 'word';
  }

  /**
   * 练习进度用的跨设备稳定标识：分类 | 词汇 | 音标（与 cloud-sync.js 的 makeDictKey 同一套规则）。
   *
   * 不能用词条的 id —— 它是 IndexedDB 的自增主键，同一份词典在手机和电脑上导入顺序不同，
   * 同一个词完全可能拿到不同的 id。用 id 当练习进度，同步到另一台设备就会贴到别的词条上，
   * 表现为「两端的练习数据对不上」。
   */
  practiceDictKey(word) {
    if (!word) return '';
    const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/\|/g, '/');
    const text = norm(word.word);
    if (!text) return '';
    return `${this.practiceScopeKeyOf(word)}|${text}|${norm(word.phonetic)}`;
  }

  /** 词条的跨设备标识（与云同步的 dict_key、练习进度用的是同一套规则） */
  dictKeyOf(word) {
    return this.practiceDictKey(word);
  }

  /**
   * 重建「dict_key → 同一个词的全部词条」索引。
   *
   * 词典里可能存在「分类 + 词汇 + 音标」完全相同的多条词条（同音同字的义项）。
   * 云端一行 dict_key 代表整组，所以组内的学习状态必须保持一致，否则：
   *   本机组内一条 mastered、一条 review → 上行只会推其中一条 →
   *   另一条永远同步不出去 → 两端的累计统计差出几个。
   * 在 refreshStatusCounts()（每次学习动作后都会跑）里顺手重建，成本可忽略。
   */
  rebuildDictKeyIndex(words) {
    const list = Array.isArray(words) ? words : [];
    const map = new Map();
    for (const w of list) {
      const key = this.dictKeyOf(w);
      if (!key) continue;
      let group = map.get(key);
      if (!group) {
        group = [];
        map.set(key, group);
      }
      group.push(w);
    }
    this._dictKeyIndex = map;
    return map;
  }

  /**
   * 把一次学习动作同步到「同一个词」的其它词条上（分类+词汇+音标都相同）。
   * 只有组内确实有多条、且状态/学习时间不同时才写库。
   */
  async applyStatusToWordGroup(sourceWord, status, studiedAt) {
    const key = this.dictKeyOf(sourceWord);
    if (!key) return 0;
    // 索引还没建（例如刚启动、还没跑过统计）时现场建一次，避免漏掉同词的其它义项
    if (!this._dictKeyIndex) {
      try {
        this.rebuildDictKeyIndex(await this.db.getAllWords());
      } catch (error) {
        return 0;
      }
    }
    const group = this._dictKeyIndex.get(key);
    if (!group || group.length <= 1) return 0;

    let updated = 0;
    for (const word of group) {
      if (word.id === sourceWord.id) continue;
      if (word.status === status && Number(word.lastStudied) === Number(studiedAt)) continue;
      word.status = status;
      word.lastStudied = studiedAt;
      await this.db.updateWord(word);
      this.syncWordCopies(word);
      updated++;
    }
    return updated;
  }

  /** 把某个词条的最新状态同步到内存中的今日队列 / 会话快照 / 补牌缓存 / 同词分组 */
  syncWordCopies(word) {
    if (!word) return;
    const lists = [this.todayWords];
    if (this._learnSessionSnapshot && this._learnSessionSnapshot.todayWords) {
      lists.push(this._learnSessionSnapshot.todayWords);
    }
    // 「跳过」的补牌候选来自这份快照：不同步的话，补进来的词条会带着旧收藏状态，
    // 之后一旦写库就会把用户刚收藏的状态覆盖回去
    if (Array.isArray(this._scopePoolCache)) lists.push(this._scopePoolCache);
    const group = this._dictKeyIndex ? this._dictKeyIndex.get(this.dictKeyOf(word)) : null;
    if (Array.isArray(group)) lists.push(group);

    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (!item || item.id !== word.id) continue;
        item.favorite = word.favorite;
        item.favoriteAt = word.favoriteAt;
        item.status = word.status;
        item.lastStudied = word.lastStudied;
      }
    }
  }

  /** 该条目是不是旧版遗留的「词条 id」进度（数字） */
  isLegacyPracticeId(item) {
    return typeof item === 'number' || (typeof item === 'string' && /^\d+$/.test(item.trim()));
  }

  /** 把持久化的练习进度（dict_key 列表）读进内存索引 Set */
  initPracticeProgress() {
    const raw = this.settings.practiceProgress;
    const toSet = (list) => {
      const set = new Set();
      for (const item of Array.isArray(list) ? list : []) {
        if (item === null || item === undefined || item === '') continue;
        // 旧版的数字 id 无跨设备意义：这里直接忽略，由 migratePracticeProgressIds() 翻译成 dict_key
        if (this.isLegacyPracticeId(item)) continue;
        set.add(String(item));
      }
      return set;
    };
    this._practiceDone = {
      word: toSet(raw && raw.word),
      phrase: toSet(raw && raw.phrase)
    };
    this.refreshPracticeProgressUI();
  }

  /**
   * 一次性迁移：把旧版按「本机词条 id」记录的练习进度翻译成本机的 dict_key。
   * 迁移只在本地做（旧 id 只对本机有意义），迁移后立即落库并随云同步上行，
   * 于是另一台设备拿到的就是稳定的 dict_key 进度。
   */
  async migratePracticeProgressIds() {
    const raw = this.settings.practiceProgress;
    if (!raw || typeof raw !== 'object') return 0;

    const legacyLists = ['word', 'phrase'].filter((k) =>
      Array.isArray(raw[k]) && raw[k].some((item) => this.isLegacyPracticeId(item))
    );
    if (legacyLists.length === 0) return 0;

    // 旧 id 只对本机有意义，只有在「本机从未登录过云同步」时才能安全翻译。
    // 若曾开启云同步，云端旧格式里可能混着**另一台设备**的 id（旧版按并集合并），
    // 拿这些 id 在本机按 id 匹配会命中无关词条，把错误进度推上云且不可逆 ——
    // 宁可放弃这批旧进度（重练即可），也不写错。
    const cloudMeta = window.CloudSync && window.CloudSync.meta;
    if (cloudMeta && cloudMeta.lastUserId) {
      const dropped = legacyLists.reduce(
        (n, k) => n + raw[k].filter((item) => this.isLegacyPracticeId(item)).length,
        0
      );
      console.info(
        `[practice] 本机用过云同步，旧的 id 进度（${dropped} 条）可能来自另一台设备，` +
        '为避免错配已放弃；可重新练习以重建进度。'
      );
      // 用当前（不含旧 id）的索引覆盖落库，把库里的旧 id 清掉
      if (dropped > 0) await this.savePracticeProgress();
      return 0;
    }

    let allWords = [];
    try {
      allWords = await this.db.getAllWords();
    } catch (error) {
      return 0;
    }
    const byId = new Map(allWords.map((w) => [Number(w.id), w]));

    let migrated = 0;
    for (const key of legacyLists) {
      const set = this._practiceDone[key];
      for (const item of raw[key]) {
        if (!this.isLegacyPracticeId(item)) continue;
        const word = byId.get(Number(item));
        if (!word) continue; // 词条已不存在：放弃这条旧记录
        const dictKey = this.practiceDictKey(word);
        if (!dictKey) continue;
        set.add(dictKey);
        migrated++;
      }
    }
    if (migrated > 0) {
      console.info(`[practice] 练习进度已迁移为跨设备标识（${migrated} 条）`);
      await this.savePracticeProgress();
      this.refreshPracticeProgressUI();
    }
    return migrated;
  }

  /** 该词条是否已经练过（答对过） */
  isPracticeDone(word) {
    const dictKey = this.practiceDictKey(word);
    if (!dictKey) return false;
    const set = this._practiceDone[this.practiceScopeKeyOf(word)];
    return set ? set.has(dictKey) : false;
  }

  /**
   * 记录一个词条练习完成：更新内存索引 → 刷新进度条 → 落库。
   * 落库会经 VocabDB.setSetting 触发云同步钩子（practiceProgress 是参与同步的设置项），
   * 因此多设备之间会自动合并进度。
   */
  async markPracticeDone(word) {
    const dictKey = this.practiceDictKey(word);
    if (!dictKey) return;
    const set = this._practiceDone[this.practiceScopeKeyOf(word)];
    if (!set || set.has(dictKey)) return;

    set.add(dictKey);
    this.refreshPracticeProgressUI();
    await this.savePracticeProgress();
  }

  /** 把内存索引写回设置（数组按字典序，保证云端比对时 JSON 稳定） */
  async savePracticeProgress() {
    const toList = (set) => Array.from(set).map(String).sort();
    const payload = {
      word: toList(this._practiceDone.word),
      phrase: toList(this._practiceDone.phrase)
    };
    this.settings.practiceProgress = payload;
    await this.db.setSetting('practiceProgress', payload);
  }

  /** 当前范围内已经练过的词条数（只统计当前范围内真实存在的词条，词典删改后不会虚高） */
  countPracticeDoneInScope() {
    let done = 0;
    for (const word of this.practiceWords) {
      if (this.isPracticeDone(word)) done++;
    }
    return done;
  }

  /** 刷新练习页顶部进度条：已完成 / 当前范围可练习总数 */
  refreshPracticeProgressUI() {
    const total = Math.max(0, Number(this._practiceScopeTotal) || 0);
    const done = total > 0 ? this.countPracticeDoneInScope() : 0;
    const fill = document.getElementById('practiceProgressFill');
    const text = document.getElementById('practiceProgressText');
    if (fill) {
      // 宽度保留小数，不要 Math.round：词库动辄几千条（全部 5814 / 字 3811 / 短语 2003），
      // 答对一个词只占 0.0x%，取整后永远是 0%，进度条看起来就像"没更新"。
      const ratio = total > 0 ? Math.min(done, total) / total : 0;
      // toFixed + Number 去掉尾部多余的 0（100% 而不是 100.000%），同时避免浮点尾巴
      fill.style.width = `${Number((ratio * 100).toFixed(3))}%`;
      // 再给一个最小像素宽度：比例小到看不清时，也能看到进度条往前挪了一点
      fill.style.minWidth = done > 0 ? '4px' : '0px';
    }
    if (text) text.textContent = `${done}/${total}`;
  }

  /**
   * 从词条的 phonetic（缺省时用 jyutping）里取出「这个词怎么读」的粤拼音节数组。
   *
   * 词典里两种表的写法不同：
   *   - 短语表：phonetic 就是纯拼音串，如「细路仔」= "sai3 lou6 zai2"；
   *   - 字表：phonetic 后面还跟着组词，如「䂿」= "dam6，䂿（跺）脚 dam6 goek3"。
   * 所以只取开头连续的「字母 + 可选声调数字」片段，遇到中文/标点即停止。
   */
  parsePracticeSyllables(word) {
    if (!word) return [];
    const raw = String(word.phonetic || word.jyutping || '').trim();
    if (!raw) return [];
    const matched = raw.match(/^[A-Za-z]+[1-6]?(?:[ \t]+[A-Za-z]+[1-6]?)*/);
    if (!matched) return [];
    return matched[0].split(/[ \t]+/).filter(Boolean);
  }

  /**
   * 按当前输入模式归一化一个音节（统一小写；「不含调值」时去掉声调数字）。
   * 用户输入与目标音节都走这里，保证两边口径一致。
   */
  normalizePracticeSyllable(text) {
    let t = String(text ?? '').trim().toLowerCase();
    if (this.settings.practiceToneMode === 'without') {
      t = t.replace(/[1-6]+$/, '');
    }
    return t;
  }

  /** 重算当前题目的目标音节，并同步卡片背面的答案 */
  applyPracticeTargets() {
    const word = this.practiceWords[this.practiceIndex];
    const syllables = this.parsePracticeSyllables(word);
    this._practiceSyllables = syllables;
    this._practiceTargets = syllables.map((s) => this.normalizePracticeSyllable(s));
    const answerEl = document.getElementById('practicePhonetic');
    if (answerEl) answerEl.textContent = this._practiceTargets.join(' ');
    return syllables;
  }

  /** 渲染当前题目：正面只放词汇（音标是要用户写的答案，不能提前露出来），背面放答案/释义/例句 */
  renderPracticeCard() {
    const stack = document.querySelector('.practice-card-stack');
    const inputArea = document.querySelector('.practice-input-area');
    const emptyEl = document.getElementById('practiceEmptyState');
    const completeEl = document.getElementById('practiceComplete');
    if (completeEl) completeEl.style.display = 'none';

    // 当前范围内没有可练习的词条
    if (!this.practiceWords.length) {
      if (stack) stack.style.display = 'none';
      if (inputArea) inputArea.style.display = 'none';
      if (emptyEl) emptyEl.style.display = 'flex';
      this.applyPracticeKeyboardState(false);
      return;
    }
    // 一轮练完
    if (this.practiceIndex >= this.practiceWords.length) {
      this.showPracticeComplete();
      return;
    }

    const word = this.practiceWords[this.practiceIndex];
    if (emptyEl) emptyEl.style.display = 'none';
    if (stack) stack.style.display = 'flex';
    if (inputArea) inputArea.style.display = 'flex';
    this.applyPracticeKeyboardState(true);

    const wordEl = document.getElementById('practiceWord');
    if (wordEl) wordEl.textContent = word.word || '';
    // 顶部标签（语言 / 分类）与学习卡完全一致，用的是同一个生成方法
    const badgeRow = document.getElementById('practiceBadgeRow');
    if (badgeRow) {
      const badgesHtml = this.buildCardBadgesHtml(word);
      badgeRow.innerHTML = badgesHtml;
      badgeRow.style.display = badgesHtml ? '' : 'none';
    }
    this.applyPracticeTargets();
    const meaningEl = document.getElementById('practiceMeaning');
    if (meaningEl) meaningEl.textContent = word.definition || word.meaning || '';
    const exampleEl = document.getElementById('practiceExample');
    if (exampleEl) exampleEl.textContent = word.example ? `“${word.example}”` : '';

    const card = document.getElementById('practiceFlashcard');
    if (card) card.classList.remove('flipped');

    this.resetPracticeInput();
    this.focusPracticeInput();
  }

  /** 翻转练习卡；答对之后翻卡是在看答案，据此暂停 / 恢复「自动下一题」 */
  flipPracticeCard() {
    const card = document.getElementById('practiceFlashcard');
    if (!card) return;
    card.classList.toggle('flipped');
    if (this._practiceSolved) {
      if (card.classList.contains('flipped')) this.cancelPracticeAdvance();
      else this.schedulePracticeAdvance();
    }
  }

  /** 清空输入框与红/绿状态，回到「等待输入」 */
  resetPracticeInput() {
    const input = document.getElementById('practiceInput');
    if (!input) return;
    input.value = '';
    this._practiceSolved = false;
    this._practiceSolvedValue = '';
    this.setPracticeInputState('');
    this.updatePracticeHint('typing', 0);
  }

  /** 进入题目后自动聚焦输入框（在练习页时），让用户可以直接开始打字 */
  focusPracticeInput() {
    if (this.currentPage !== 'practice') return;
    const input = document.getElementById('practiceInput');
    if (!input) return;
    setTimeout(() => {
      if (this.currentPage === 'practice' && !this._practiceSolved) input.focus();
    }, 0);
  }

  /** 输入框状态：'' 普通 / 'error' 红 / 'success' 绿（顺带重画逐音节着色） */
  setPracticeInputState(state) {
    const input = document.getElementById('practiceInput');
    if (!input) return;
    input.classList.toggle('error', state === 'error');
    input.classList.toggle('success', state === 'success');
    // 每次判定完都重画一次：输入正确的音节要立刻变绿
    this.renderPracticeInputDisplay();
  }

  /**
   * 把输入框内容按音节渲染到着色显示层：**输入正确的音节显示为绿色**，
   * 输错的显示红色，还只是目标音节前缀（正在输入）的保持默认色。
   *
   * input 本身不能给局部文字上色，所以它的文字是透明的，可见内容全部由这一层画出来；
   * 两层的字体 / 内边距 / 边框 / 居中完全一致，看起来就是一个输入框。
   */
  renderPracticeInputDisplay() {
    const display = document.getElementById('practiceInputDisplay');
    if (!display) return;
    const input = document.getElementById('practiceInput');
    const raw = input ? input.value : '';
    if (!raw) {
      display.innerHTML = '';
      return;
    }

    const targets = this._practiceTargets || [];
    let html = '';
    raw.split(' ').forEach((piece, index) => {
      if (index > 0) {
        // 音节之间要留出自动补的空格。这里必须把空格包进元素里：
        // 显示层是 flex 容器，而「只含空白的匿名文本节点」在 flex 布局中不会被渲染，
        // 裸写一个空格会被整段丢掉，几个音节就会挤在一起。
        html += '<span class="sep"> </span>';
      }
      if (!piece) return;
      const norm = this.normalizePracticeSyllable(piece);
      const target = targets[index];
      const matched = target !== undefined && norm === target;
      // 还没打完（是目标音节的前缀）不着色；其余（输错或多余音节）标红
      const typing = !matched && target !== undefined && target.indexOf(norm) === 0;
      const cls = matched ? 'ok' : (typing ? 'typing' : 'bad');
      html += `<span class="${cls}">${this.escapeHtml(piece)}</span>`;
    });
    display.innerHTML = html;
  }

  /** 输入框下方的提示文字 */
  updatePracticeHint(state, matchedCount) {
    const hint = document.getElementById('practiceHint');
    if (!hint) return;
    hint.classList.toggle('error', state === 'error');
    hint.classList.toggle('success', state === 'success');

    if (state === 'success') {
      hint.textContent = '✓ 全部正确';
      return;
    }
    if (state === 'error') {
      hint.textContent = '✗ 与音标不一致，请修改标红的部分';
      return;
    }
    const total = this._practiceTargets.length;
    const modeText = this.settings.practiceToneMode === 'without' ? '不含调值' : '含调值';
    if (this.settings.practiceToneMode === 'without') {
      hint.textContent = total > 1
        ? `共 ${total} 个音节（不含调值），已完整输入【 ${Math.max(0, matchedCount)} 】个`
        : `只输入字母，不用输调值数字`;
      return;
    }
    hint.textContent = total > 1
      ? `共 ${total} 个音节（含调值），已完整输入 【 ${Math.max(0, matchedCount)} 】个`
      : `输入完整音标`;
  }

  /**
   * 音标输入的核心判定。输入框里用空格分隔音节，逐段与目标音节比较：
   *   - 某一段完整等于目标音节：若后面还有音节，就自动补一个空格（用户不必自己敲），
   *     光标直接落在新空格之后继续输入下一个音节；
   *   - 最后一段只是目标音节的前缀（如目标 jat1，刚输入到 ja）：视为「还在输入」，不报错；
   *   - 其它情况：判为拼写错误，输入框标红；
   *   - 所有音节都完整正确：输入框标绿，短暂停留后自动进入下一题。
   * 删除操作（Backspace）不会触发自动补空格，否则用户没法回退修改上一段。
   */
  handlePracticeInput(event) {
    const input = event.target;
    // 输入法组合过程中给出的是未确定的字符串，不参与判定
    if (event.isComposing || input.composing) return;

    const targets = this._practiceTargets || [];
    if (targets.length === 0) return;

    // 本题已答对：多余的输入（误敲、粘贴、删除）一律还原，避免把绿框改红；
    // 这里不用 readOnly，否则手机上键盘会先收起来、下一题再弹一次
    if (this._practiceSolved) {
      if (input.value !== this._practiceSolvedValue) input.value = this._practiceSolvedValue;
      return;
    }

    let raw = input.value;
    // 兜底：beforeinput 没能拦住时（旧浏览器、部分输入法直接上屏），
    // 「不含调值」模式下把混进来的声调数字直接剔掉
    if (this.settings.practiceToneMode === 'without' && /[1-6]/.test(raw)) {
      raw = raw.replace(/[1-6]/g, '');
      input.value = raw;
    }
    const rawParts = raw.split(' ');
    // 末尾的空片段 = 用户刚敲下的那个空格。记住它，避免再自动补一个空格（否则会连出两个）
    const hasTrailingSpace = rawParts.length > 1 && rawParts[rawParts.length - 1] === '';
    // 中间连续敲出的多个空格当噪声忽略，不因此判错
    const parts = rawParts.filter((p) => p !== '');
    const inputType = typeof event.inputType === 'string' ? event.inputType : '';
    const isInsert = inputType === '' || inputType.indexOf('insert') === 0;

    let state = 'typing';
    let matchedCount = 0;

    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const norm = this.normalizePracticeSyllable(parts[i]);
      const target = targets[i];

      // 音节数超出目标（多输入了一段），或整段只剩空格
      if (target === undefined || !norm) {
        state = 'error';
        break;
      }
      if (norm === target) {
        matchedCount = i + 1;
        // 目标音节已全部输入正确（后面若还有多余片段，会在下一轮被上面判成 error）
        if (matchedCount === targets.length) state = 'success';
        continue;
      }
      // 最后一段是目标音节的前缀：还在输入中，不算错
      if (isLast && target.indexOf(norm) === 0) break;
      state = 'error';
      break;
    }

    // 自动补空格：这一段已完整正确、后面还有音节、末尾还没有空格、是用户新键入的、且光标停在末尾
    if (
      state !== 'error' &&
      parts.length > 0 &&
      matchedCount === parts.length &&
      matchedCount < targets.length &&
      !hasTrailingSpace &&
      isInsert &&
      input.selectionStart === raw.length
    ) {
      input.value = `${raw} `;
    }

    if (state === 'success') {
      this.setPracticeInputState('success');
      this.updatePracticeHint('success', matchedCount);
      // 答对即锁定本题（换题时由 resetPracticeInput 解锁）
      this._practiceSolved = true;
      this._practiceSolvedValue = input.value;
      // 记入练习进度（写库并触发云同步），进度条随即前进
      const current = this.practiceWords[this.practiceIndex];
      this.markPracticeDone(current).catch((error) => {
        console.error('[practice] 保存练习进度失败:', error);
      });
      this.schedulePracticeAdvance();
      return;
    }

    this.cancelPracticeAdvance();
    if (state === 'error') {
      this.setPracticeInputState('error');
      this.updatePracticeHint('error', matchedCount);
    } else {
      this.setPracticeInputState('');
      this.updatePracticeHint('typing', matchedCount);
    }
  }

  /**
   * 整条音标输入正确后，短暂停留再自动进入下一题（期间可回车立刻跳过等待）。
   * 无论此刻卡片是正面还是背面都会切题 —— 在背面（蓝色面）答对时要求自动翻回正面
   * 换下一个词，nextPracticeCard → renderPracticeCard 本来就会把卡片复位到正面。
   */
  schedulePracticeAdvance() {
    this.cancelPracticeAdvance();
    this._practiceAdvanceTimer = setTimeout(() => {
      this._practiceAdvanceTimer = null;
      if (this.currentPage !== 'practice') return;
      this.nextPracticeCard();
    }, PRACTICE_ADVANCE_DELAY_MS);
  }

  /** 取消「自动下一题」定时器 */
  cancelPracticeAdvance() {
    if (this._practiceAdvanceTimer != null) {
      clearTimeout(this._practiceAdvanceTimer);
      this._practiceAdvanceTimer = null;
    }
  }

  /** 进入下一题（练完一轮则显示完成状态） */
  nextPracticeCard() {
    this.cancelPracticeAdvance();
    this.practiceIndex++;
    this.renderPracticeCard();
  }

  /** 【再练一轮】：重新抽题并从头开始 */
  async restartPractice() {
    this.cancelPracticeAdvance();
    await this.preparePracticePool();
    this.renderPracticeCard();
  }

  /** 练习页完成状态：隐去卡片、输入框与键盘，只留完成提示 */
  showPracticeComplete() {
    this.cancelPracticeAdvance();
    const stack = document.querySelector('.practice-card-stack');
    const inputArea = document.querySelector('.practice-input-area');
    const emptyEl = document.getElementById('practiceEmptyState');
    const completeEl = document.getElementById('practiceComplete');
    if (stack) stack.style.display = 'none';
    if (inputArea) inputArea.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'none';
    this.applyPracticeKeyboardState(false);
    if (completeEl) completeEl.style.display = 'flex';
    const subtitle = completeEl ? completeEl.querySelector('.complete-subtitle') : null;
    if (subtitle) subtitle.textContent = `本轮练习已完成（共 ${this.practiceWords.length} 个词条）`;
  }

  // ==================== 词库页面 ====================

  /**
   * 按当前条件筛选词库列表：词典范围 → 状态选项卡 → 分类多选 → 搜索词。
   * 与分类下拉按钮上的数量、以及 renderLibrary 实际渲染的列表共用同一套条件，
   * 保证「标签上的数字」和「列表里的条目」永远一致。
   *
   * 当 _libraryTodayOnly 为 true（用户从学习卡的「今日已掌握/今日待复习」点进来）时，
   * 额外只保留 lastStudied 是今天的词条，这样列表条数与该数字对得上。
   */
  applyLibraryFilters(allWords) {
    let words = allWords.filter((w) => this.isWordInActiveScope(w));

    // 状态选项卡
    const status = this._libraryTodayOnly ? (this._libraryTodayKind || this.filterStatus) : this.filterStatus;
    if (status === 'favorite') {
      words = words.filter((w) => w.favorite);
    } else if (status !== 'all') {
      words = words.filter((w) => w.status === status);
    }

    // “只看今天学过”的（仅今日已掌握/今日待复习入口会打开）
    if (this._libraryTodayOnly) {
      const todayKey = this.todayKey();
      words = words.filter((w) => {
        const t = Number(w.lastStudied);
        return Number.isFinite(t) && new Date(t).toDateString() === todayKey;
      });
    }

    // 分类多选
    if (this.selectedCategories && this.selectedCategories.length > 0) {
      words = words.filter((w) => this.selectedCategories.includes(w.category || '未分类'));
    }

    // 一字类（一字多音/一字一音）从学习卡跳转时：仅展示该 word 字的全部记录，
    // 而不是该分类下的所有字（此时 selectedCategories 已限定到该分类）
    if (this._libraryWordExactFilter) {
      words = words.filter((w) => String(w.word || '').trim() === this._libraryWordExactFilter);
    }

    // 搜索（支持单词、释义、粤拼、粤语字、粤语例句搜索）
    if (this.searchQuery) {
      const q = this.searchQuery;
      words = words.filter((w) => {
        const mean = (w.definition || w.meaning || '').toLowerCase();
        const phon = (w.phonetic || w.jyutping || '').toLowerCase();
        const canto = (w.cantonese || '').toLowerCase();
        const cantoEx = (w.cantoneseExample || w.example || '').toLowerCase();
        return w.word.toLowerCase().includes(q) || mean.includes(q) || phon.includes(q) || canto.includes(q) || cantoEx.includes(q);
      });
    }

    return words;
  }

  /**
   * 词库列表的排序。
   *
   * 「待复习 / 已掌握 / 收藏」按时间倒序（最近的在最上面）；
   * 「全部 / 新词」保持原来「同分类的词连续排列」的顺序，不改变用户熟悉的样子。
   *
   * 收藏用的是**收藏时间**（favoriteAt）：刚在学习页点了收藏的词要立刻出现在收藏列表顶端。
   * 若沿用学习时间排序，刚收藏但很久没学过（甚至从没学过，时间为 0）的词会沉到列表最末尾，
   * 看起来就像「收藏没生效」或「跳过之后收藏丢了」。
   */
  orderLibraryWords(words, effectiveStatus) {
    const TIME_SORTED_TABS = ['review', 'mastered', 'favorite'];
    if (!TIME_SORTED_TABS.includes(effectiveStatus)) {
      const grouped = new Map();
      words.forEach((word) => {
        const cat = word.category || '未分类';
        if (!grouped.has(cat)) grouped.set(cat, []);
        grouped.get(cat).push(word);
      });
      const ordered = [];
      grouped.forEach((list) => { ordered.push(...list); });
      return ordered;
    }

    const timeOf = (w) => effectiveStatus === 'favorite'
      ? (Number(w.favoriteAt) || Number(w.lastStudied) || 0)
      : (Number(w.lastStudied) || 0);

    return words.slice().sort((a, b) => {
      const ta = timeOf(a);
      const tb = timeOf(b);
      if (tb !== ta) return tb - ta;                      // 最近的在前
      return (Number(a.id) || 0) - (Number(b.id) || 0);   // 时间相同按 id 稳定排序
    });
  }

  async renderLibrary() {
    // 先刷新顶部范围统计行（数量可能因词典范围切换/词条状态变更而变）
    await this.updateDictTypeSelectLabels();

    // 更新筛选按钮状态
    document.querySelectorAll('.filter-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.filter === this.filterStatus);
    });

    // 当前选项卡下的词条（范围/状态/今日/分类/搜索条件完全一致 → 列表条数即标签数字）
    const allWords = await this.db.getAllWords();
    const words = this.applyLibraryFilters(allWords);

    // 分类下拉按钮上显示当前选项卡的词条数量，如「字（27）」
    this._libraryTabCount = words.length;
    this.updateCategoryLabel();

    const container = document.getElementById('libraryWords');
    
    if (words.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">
            <svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
          </div>
          <h3 class="empty-title">词库为空</h3>
          <p class="empty-desc">暂无单词数据</p>
        </div>
      `;
      document.getElementById('pagination')?.remove();
      return;
    }

    // ---- 决定列表顺序 ----（规则见 orderLibraryWords）
    const effectiveStatus = this._libraryTodayOnly
      ? (this._libraryTodayKind || this.filterStatus)
      : this.filterStatus;

    const orderedWords = this.orderLibraryWords(words, effectiveStatus);
    
    // 每个分类的小标题（原来的「aa (12)」）已取消，数量改到分类下拉选项里显示
    // 「显示释义」关闭时，卡片上只保留单词本身（单词下方那行释义不渲染）；
    // 仅影响词库列表卡片，点开卡片的「查看单词」弹窗始终展示释义。
    const showMeaningInCard = this.settings.meaningDisplay !== false;
    // 词库列表右侧的「查看」小眼睛（灰色）
    const viewIconSvg = '<svg viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>';
    const html = `
      <div class="word-list">
        ${orderedWords.map(word => `
                <div class="word-item" data-id="${word.id}">
                  <div class="word-info">
                    <h3>${word.word}</h3>
                    ${showMeaningInCard ? `<p>${word.definition || word.meaning}</p>` : ''}
                  </div>
                  <div class="word-status">
                    ${effectiveStatus === 'favorite' ? `
                      <div class="word-actions">
                        <button type="button" class="word-action-btn unfavorite-btn" data-id="${word.id}" title="取消收藏" aria-label="取消收藏">${HEART_ICON_SVG}</button>
                        <button type="button" class="word-action-btn library-view-btn view-btn" data-id="${word.id}" title="查看" aria-label="查看单词">
                          ${viewIconSvg}
                        </button>
                      </div>
                    ` : effectiveStatus === 'all' ? `
                      <span class="status-badge ${word.status}">${
                        word.status === 'mastered' ? '已掌握' : 
                        word.status === 'review' ? '待复习' : '新词'
                      }</span>
                      <button type="button" class="word-action-btn library-view-btn view-btn" data-id="${word.id}" title="查看" aria-label="查看单词">
                        ${viewIconSvg}
                      </button>
                    ` : `
                      ${word.favorite ? `
                        <span class="favorite-badge" title="已收藏">已收藏</span>
                      ` : `
                        <span class="status-switch favorite-switch" data-id="${word.id}" title="添加到收藏">➔收藏</span>
                      `}
                      ${word.status === 'mastered' ? `
                        <span class="status-switch to-review" data-id="${word.id}" data-status="review">➔陌生</span>
                      ` : ''}
                      ${word.status === 'review' ? `
                        <span class="status-switch to-mastered" data-id="${word.id}" data-status="mastered">➔掌握</span>
                      ` : ''}
                      ${word.status === 'new' ? `
                        <span class="status-switch to-review" data-id="${word.id}" data-status="review">➔陌生</span>
                      ` : ''}
                      ${word.status === 'new' ? `
                        <span class="status-switch to-mastered" data-id="${word.id}" data-status="mastered">➔已掌握</span>
                      ` : ''}
                      <button type="button" class="word-action-btn library-view-btn view-btn" data-id="${word.id}" title="查看" aria-label="查看单词">
                        ${viewIconSvg}
                      </button>
                    `}
                  </div>
                </div>
        `).join('')}
      </div>
    `;
    
    container.innerHTML = html;

    container.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id);
        this.viewWord(id);
      });
    });

    // 卡片点击事件 - 显示详情弹窗
    container.querySelectorAll('.word-item').forEach(item => {
      item.style.cursor = 'pointer';
      item.addEventListener('click', (e) => {
        // 如果点击的是按钮或标签等可交互元素，则不触发卡片点击
        if (e.target.closest('.word-action-btn') || e.target.closest('.status-switch') || e.target.closest('.unfavorite-btn')) {
          return;
        }
        const id = parseInt(item.dataset.id);
        this.viewWord(id);
      });
    });

    // 「➔收藏」标签：点一下即把该单词加入收藏，收藏列表按收藏时间倒序
    container.querySelectorAll('.favorite-switch').forEach(span => {
      span.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = parseInt(span.dataset.id, 10);
        const word = await this.toggleFavorite(id);
        if (word) {
          // 收藏 tab 的成员变了：把它从“学过一遍”集合里移除，收藏 tab 重新变为没学完
          this.markScopePassPending(word, ['favorite']);
          // 学习范围正好是「收藏」时，刚收藏的词要立刻进入学习队列（不能继续停在“已学完”）
          if (this.normalizeStudyScope(this.settings.studyScope) === 'favorite') {
            await this.refreshScopedStudySessionAfterExternalChange(word, word.favorite);
          } else {
            await this.saveScopePass();
          }
        }
        await this.renderLibrary();
      });
    });

    // 状态转换标签事件（只绑定带 data-status 的标签，避免误伤「➔收藏」）
    container.querySelectorAll('.status-switch[data-status]').forEach(span => {
      span.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = parseInt(span.dataset.id);
        const newStatus = span.dataset.status;
        
        const words = await this.db.getAllWords();
        const word = words.find(w => w.id === id);
        if (word) {
          // 记下改动前是否属于当前学习范围：状态标签变化可能让词条进入/离开该范围
          const studyScope = this.normalizeStudyScope(this.settings.studyScope);
          const scopedStudy = this.isScopedStudyRange(studyScope);
          const wasInStudyScope = scopedStudy && this.isWordInStudyScope(word, studyScope);

          word.status = newStatus;
          word.lastStudied = this.nowMs();
          await this.db.updateWord(word);
          // 同一个词的多条词条（同音同字的义项）状态保持一致，云端那一行才代表完整记录
          await this.applyStatusToWordGroup(word, newStatus, word.lastStudied);
          
          // 更新学习页面的状态数据
          if (this.todayWords && this.todayWords.length > 0) {
            const todayWordIndex = this.todayWords.findIndex(w => w.id === id);
            if (todayWordIndex !== -1) {
              this.todayWords[todayWordIndex].status = newStatus;
              
              // 统计不在此处按 delta 增减：词条状态已变更，统一交给下方
              // refreshStatusCounts() 依据最终状态整体重算，避免来回切换状态时数字虚增
              
              // 更新学习会话快照（以便切换回学习页面时能看到更新后的数据）
              if (this._learnSessionSnapshot) {
                const snapWordIndex = this._learnSessionSnapshot.todayWords.findIndex(w => w.id === id);
                if (snapWordIndex !== -1) {
                  this._learnSessionSnapshot.todayWords[snapWordIndex].status = newStatus;
                  this._learnSessionSnapshot.todayStats = { ...this.todayStats };
                }
              }
              
              // 如果当前在学习页面，更新UI
              if (this.currentPage === 'learn') {
                this.updateProgress();
              }
            }
          }

          // 刷新累计统计缓存（词库内状态切换后，确保学习页累计数字一致）
          await this.refreshStatusCounts();
          if (this.currentPage === 'learn') {
            this.updateProgress();
          }

          // 状态标签变化后，该词条进入了另一个 tab。把它从新 tab 的
          // “学过一遍”集合里移除：对那个 tab 来说它是新增的，不能算已学完。
          if (newStatus === 'new' || newStatus === 'review' || newStatus === 'mastered') {
            this.markScopePassPending(word, [newStatus]);
          }

          // 状态标签变化让词条进入/离开当前学习范围时，学习页的红字提示与队列
          // 必须跟着更新：例如「待复习」已显示学完，在词库把一条新词改成待复习后，
          // 再回学习页应当直接看到这张卡，而不是继续显示「已学完【待复习】」。
          const nowInStudyScope = scopedStudy && this.isWordInStudyScope(word, studyScope);
          if (scopedStudy && wasInStudyScope !== nowInStudyScope) {
            await this.refreshScopedStudySessionAfterExternalChange(word, nowInStudyScope);
          } else {
            await this.saveScopePass();
          }

          this.renderLibrary();
          // this.showToast(newStatus === 'mastered' ? '已标记为掌握' : '已标记为待复习'); // 请勿删除该注释
        }
      });
    });

    // 取消收藏按钮事件
    container.querySelectorAll('.unfavorite-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id);
        const word = await this.toggleFavorite(id);
        if (word) {
          // 取消收藏后它已经不在收藏 tab；同时清掉旧完成标记，下次重新收藏会算新增
          this.markScopePassPending(word, ['favorite']);
          // 学习范围是「收藏」时，取消收藏意味着该词离开范围，队列与提示要同步更新
          if (this.normalizeStudyScope(this.settings.studyScope) === 'favorite') {
            await this.refreshScopedStudySessionAfterExternalChange(word, word.favorite);
          } else {
            await this.saveScopePass();
          }
        }
        this.renderLibrary();
      });
    });
  }

  /** 打开弹窗查看指定词条（只读模式：禁用输入框、隐藏保存按钮） */
  async viewWord(id) {
    const words = await this.db.getAllWords();
    const word = words.find(w => w.id === id);
    if (!word) return;

    document.getElementById('wordId').value = word.id;
    document.getElementById('wordInput').value = word.word;
    document.getElementById('meaningInput').value = word.definition || word.meaning || '';
    document.getElementById('phoneticInput').value = word.phonetic || '';
    document.getElementById('exampleInput').value = word.example || '';
    document.getElementById('categoryInput').value = word.category || '';

    // 「词汇」后面的语种标签：取词典 language 列原文；该词条没有语种时隐藏标签
    const languageTag = document.getElementById('wordLanguageTag');
    if (languageTag) {
      const language = String(word.language || '').trim();
      languageTag.textContent = language;
      languageTag.hidden = !language;
    }

    document.getElementById('addWordModal').classList.add('active');
    document.getElementById('modalTitle').textContent = '查看单词';
    
    // 禁用所有输入框，只读模式
    const inputs = document.querySelectorAll('#wordForm input, #wordForm textarea');
    inputs.forEach(input => input.disabled = true);
    
    // 隐藏保存按钮
    document.getElementById('saveWordBtn').style.display = 'none';
  }


  // ==================== 设置页面 ====================
  renderSettings() {
    document.getElementById('goalSlider').value = this.settings.dailyGoal;
    document.getElementById('goalValue').textContent = this.settings.dailyGoal;
    
    // 学习模式
    document.querySelectorAll('.mode-option').forEach(opt => {
      opt.classList.toggle('active', opt.dataset.mode === this.settings.learnMode);
    });
    
    const cardDefinitionFirstToggle = document.getElementById('cardDefinitionFirstToggle');
    if (cardDefinitionFirstToggle) {
      cardDefinitionFirstToggle.classList.toggle('active', this.settings.cardDefinitionFirst);
    }

    const categoryDisplayToggle = document.getElementById('categoryDisplayToggle');
    if (categoryDisplayToggle) {
      categoryDisplayToggle.classList.toggle('active', this.settings.categoryDisplay);
    }

    // 显示释义：默认开启，未设置过时按 true 处理
    const meaningDisplayToggle = document.getElementById('meaningDisplayToggle');
    if (meaningDisplayToggle) {
      meaningDisplayToggle.classList.toggle('active', this.settings.meaningDisplay !== false);
    }

    const dictTypeEl = document.getElementById('dictTypeSelect');
    if (dictTypeEl) dictTypeEl.value = this.settings.dictImportType || 'all';

    const studyScopeEl = document.getElementById('studyScopeSelect');
    if (studyScopeEl) studyScopeEl.value = this.normalizeStudyScope(this.settings.studyScope);

    const phoneticDelaySelect = document.getElementById('phoneticDelaySelect');
    if (phoneticDelaySelect) phoneticDelaySelect.value = String(this.settings.phoneticDelay);

    const repeatFrequencySelect = document.getElementById('repeatFrequencySelect');
    if (repeatFrequencySelect) repeatFrequencySelect.value = String(this.settings.repeatFrequency);

    this.refreshGoalSliderLockedState();
  }

  /**
   * 设置页「清除」：只清除**当前词典范围**的学习记录。
   *
   * 范围由设置里的「词典导入」决定（字 / 短语 / 全部）：
   *   - 只把该范围内的词条状态重置为「新词」，并把学习时间一并清掉
   *     （清完立刻就能重新学，不会被「重复频率」挡在静默期里）；
   *   - 今日/累计统计只清该分类的计数，另一个范围的记录完全不受影响；
   *   - 词库本身（词条、收藏）不会被删除。
   */
  async clearProgress() {
    const scopeKeys = this.activeScopeKeys();
    const isAll = scopeKeys.length > 1;
    const scopeLabel = isAll ? '全部（字 + 短语）' : (scopeKeys[0] === 'word' ? '字' : '短语');
    const keepLabel = isAll ? null : (scopeKeys[0] === 'word' ? '短语' : '字');
    const cloudHint = window.CloudSync?.isActive?.() ? '（已登录，云端记录也会一起清除）' : '';
    const keepHint = keepLabel ? `\n「${keepLabel}」的学习记录会保留。` : '';

    const ok = confirm(
      `确定要清除「${scopeLabel}」范围内的所有“已掌握”和“待复习”记录吗？${keepHint}${cloudHint}`
    );
    if (!ok) return;

    const allWords = await this.db.getAllWords();
    const scopedWords = allWords.filter((w) => this.isWordInActiveScope(w));
    this.showToast(`正在清除「${scopeLabel}」的学习记录…`);

    // 1) 只重置当前范围内词条的状态与学习时间（词库本身不动）
    for (const word of scopedWords) {
      if (word.status === 'new' && !word.lastStudied) continue; // 本来就没记录，跳过写入
      word.status = 'new';
      word.lastStudied = 0;
      await this.db.updateWord(word);
    }

    // 2) 今日/累计统计：只清当前范围对应的分类
    await this.resetScopeStats(scopeKeys);

    // 3) 今日学习会话与进度（会话本来就只是当前范围的队列）
    await this.db.setSetting('lastStudyDate', null);
    await this.db.setSetting('todayCount', 0);
    await this.db.setSetting('learnProgress', null);
    this.todayStats = { mastered: 0, review: 0, total: 0 };
    this.totalStats = { mastered: 0, review: 0 };
    await this.db.setSetting('todayStats', this.todayStats);
    await this.db.setSetting('totalStats', this.totalStats);
    this.currentCardIndex = 0;
    this._learnSessionSnapshot = null;
    this.todayWords = [];
    this._externalScopeIncludeIds.clear();
    this._externalScopeIncludeScope = this.normalizeStudyScope(this.settings.studyScope);
    // 学习记录清空后，各 tab 的“学过一遍”进度也重新开始
    await this.resetScopePass();
    await this.resetTodayDoneCount();

    // 4) 统计以数据库重算为准（只影响当前范围），进度条与四个数字一并刷新
    await this.refreshStatusCounts();
    this.refreshGoalSliderLockedState();

    this.showToast(`「${scopeLabel}」的学习记录已清除`);

    if (this.currentPage === 'learn') {
      // 记录已清空，队列要按新状态重建（范围内词条现在都是新词）
      await this.prepareLearnSession();
    }

    // 如果当前在词库页面，刷新列表
    if (this.currentPage === 'library') {
      await this.renderLibrary();
    }

    // 【云同步钩子 4】按范围清除也要同步出去。因为不再广播全局重置时间戳
    // （那会让其它设备把字和短语一起清零），改为让刚被重置为 new 的这批词条
    // 走普通上行同步，云端按 dict_key 逐条覆盖，其它范围的行完全不动。
    try {
      await window.CloudSync?.onProgressCleared?.(scopeKeys);
    } catch (error) {
      console.warn('云同步清除记录失败（不影响本地清除）:', error);
    }
  }

  // ==================== 模态框（新增/查看单词弹窗） ====================
  /** 关闭所有弹窗，并把表单恢复为可编辑状态（查看模式会禁用输入框、隐藏保存按钮） */
  closeModals() {
    document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('active'));
    
    // 重置表单状态
    const inputs = document.querySelectorAll('#wordForm input, #wordForm textarea');
    inputs.forEach(input => input.disabled = false);
    
    // 显示保存按钮
    document.getElementById('saveWordBtn').style.display = '';

    // 语种标签随词条显示，关闭时一并清空，避免下次打开弹窗残留上一个词条的语种
    const languageTag = document.getElementById('wordLanguageTag');
    if (languageTag) {
      languageTag.textContent = '';
      languageTag.hidden = true;
    }
  }

  /**
   * 保存弹窗中的词条（新增或编辑）。
   * 有隐藏 id 时为编辑：先取出库中完整记录再合并表单字段，
   * 避免 put 整体覆盖把 status / lastStudied 等学习数据清空；
   * 无 id 时为新增。保存后按所在页面刷新词库或重建学习队列。
   */
  async saveWord() {
    try {
      const id = document.getElementById('wordId').value;
      // 默认使用普通话，不再需要语言选择
      const lang = 'mandarin';
      
      const wordInput = document.getElementById('wordInput');
      const meaningInput = document.getElementById('meaningInput');
      
      if (!wordInput || !meaningInput) {
        this.showToast('表单加载失败，请重试');
        return;
      }
      
      const word = {
        word: wordInput.value.trim(),
        definition: meaningInput.value.trim(),
        phonetic: document.getElementById('phoneticInput')?.value.trim() || '',
        example: document.getElementById('exampleInput')?.value.trim() || '',
        category: document.getElementById('categoryInput')?.value.trim() || '未分类',
        language: lang
      };

      if (!word.word || !word.definition) {
        this.showToast('请填写词汇和释义');
        return;
      }

      if (id) {
        word.id = parseInt(id);
        // put 会整体替换记录：只传表单字段会把 status/lastStudied 等学习数据清空，
        // 导致重复频率筛选把该词当作从未学过而提前重现，因此先合并已保存的完整记录
        const existing = await this.db.getWord(word.id);
        await this.db.updateWord({ ...(existing || {}), ...word });
        this.showToast('词汇已更新');
      } else {
        await this.db.addWord(word);
        this.showToast('词汇添加成功');
      }

      this.closeModals();
      if (this.currentPage === 'library') {
        this.renderLibrary();
        this.renderCategoryOptions();
      }
      if (this.currentPage === 'learn') {
        this.prepareLearnSession();
      }
    } catch (error) {
      console.error('保存单词失败:', error);
      this.showToast('保存失败，请重试');
    }
  }

  // 解析Excel数据（首行为表头，列名规则与 resolveImportHeaderKey 一致）
  // dictScope：该 sheet 归属的词典分类（word=字 / phrase=短语）
  parseExcel(data, dictScope) {
    if (!data || data.length < 2) return [];
    const headerCells = data[0].map((c) => String(c ?? '').trim());
    let colMap = this.buildImportColumnMap(headerCells);
    if (!colMap) colMap = this.getLegacyImportColumnMap();

    const words = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row) continue;

      const get = (key) => {
        const idx = colMap[key];
        if (idx === undefined || idx === null) return '';
        return String(row[idx] ?? '').trim();
      };

      const wordText = get('word');
      if (!wordText) continue;

      words.push(
        this.normalizeImportedWord({
          word: wordText,
          meaning: get('meaning'),
          phonetic: get('phonetic'),
          example: get('example'),
          category: get('category'),
          language: get('language'),
          jyutping: get('jyutping'),
          cantonese: get('cantonese'),
          cantoneseExample: get('cantoneseExample'),
          dictScope
        })
      );
    }
    return words;
  }

  /** 屏幕底部弹出一条短暂提示（2.5 秒后自动消失） */
  showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
  }
}

// ==================== 启动应用 ====================
// 等 DOM 解析完成后再创建应用实例（此时所有按钮/弹窗元素都已存在，可以绑定事件）
document.addEventListener('DOMContentLoaded', () => {
  window.app = new VocabApp();  // 挂到 window 上，方便控制台调试
  window.app.init();            // 执行初始化流程（数据库 → 设置 → 词典 → 统计 → 渲染）
});

