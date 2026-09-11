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
 *     - 设置页：每日目标、学习模式（随机/顺序）、语音朗读、音效、
 *               卡片背景色、音标渐显、重复频率、词典范围等
 *     - 语音：使用浏览器自带的 Web Speech API（speechSynthesis），
 *             按词条语种（英语 / 普通话 / 粤语）挑选合适的系统音色朗读
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
 * 底部导航在三个页面间切换：learn（学习）/ library（词库）/ settings（设置）。
 * 页面加载完成后（DOMContentLoaded）创建 VocabApp 实例并调用 init() 启动。
 */

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

  /** 按 id 整体覆盖更新一条词条（put：有则更新、无则新增） */
  async updateWord(word) {
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
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}

// ==================== 主应用类（应用层） ====================
/**
 * 应用层类：持有全部运行状态，负责页面渲染、事件交互、学习流程、
 * 词库管理、设置读写与语音朗读。全局唯一实例为 window.app。
 */
class VocabApp {
  constructor() {
    this.db = new VocabDB();          // 数据层实例（IndexedDB 封装）
    this.currentPage = 'learn';       // 当前所在页面：learn 学习 / library 词库 / settings 设置
    this.currentCardIndex = 0;        // 今日学习队列中，当前卡片的下标
    this.todayWords = [];             // 今日学习队列（词条对象数组）
    this.isFlipped = false;           // 当前卡片是否处于翻面（释义面朝上）状态
    // 全部用户设置；启动时由 loadSettings() 从数据库读取覆盖默认值
    this.settings = {
      dailyGoal: 100,                 // 每日目标（每天学习多少张卡片）
      cardBgColor: '#E8F5E9',         // 卡片背景色
      fontSize: 'medium',             // 字号（预留）
      soundEnabled: false,            // 翻到释义面后自动朗读例句/释义
      speechEnabled: false,           // 总开关：语音朗读（关闭后喇叭按钮不可用）
      phoneticAutoRead: false,        // 切换卡片后自动朗读音标两遍
      /** 默认先展示释义面；点击后翻到词汇面 */
      cardDefinitionFirst: false,
      learnMode: 'random',            // 学习模式：random 随机 / sequential 顺序
      /** 音标渐显延迟（秒），0表示立即显示 */
      phoneticDelay: 2,
      /** 单词重复出现频率（天），0表示每日目标内不重复 */
      repeatFrequency: 2,
      /** 词典导入范围：all / phrase / word，与设置页下拉同步 */
      dictImportType: 'all',
      categoryDisplay: false          // 卡片上方是否显示分类徽标（默认关闭；loadSettings 会从库中读取用户选择）
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
    /** 按分类(字/短语)归档的今日统计：{ word:{mastered,review}, phrase:{mastered,review} } */
    this._scopeToday = this._emptyScopeStats();
    /** 按分类(字/短语)归档的今日之前累计统计（每日跨天时并入） */
    this._scopeTotal = this._emptyScopeStats();
    /** 触摸翻面后浏览器会合成 click，需忽略下一次点击避免立刻翻回正面 */
    this._suppressNextCardClickFlip = false;
    this._phoneticReadTimer = null;
/** 词库列表当前展示的词条 id → 对象，避免点击喇叭时 await IndexedDB 导致用户手势失效而无法发声 */
    this._librarySpeakWordsById = new Map();
    /** 离开学习页时保存的会话快照，用于返回学习页时恢复进度条与队列（不可仅用 switchPage 局部变量） */
    this._learnSessionSnapshot = null;
    /** 当前词典范围内各状态的词条数缓存 { mastered, review }，与词库页筛选结果一致 */
    this._cachedStatusCounts = { mastered: 0, review: 0 };
  }
  /**
   * 应用启动入口（DOMContentLoaded 后调用一次）。
   * 流程：测量滚动条 → 打开数据库 → 读取设置 → 首次使用默认词典范围为「字」
   * → 注册 Service Worker（离线缓存）→ 绑定全部事件 → 预加载语音音色
   * → 自动导入 dict.xlsx → 加载/迁移学习统计 → 首次渲染。
   * 任何一步失败都会走 recoverFromError() 兜底重建。
   */
  async init() {
    try {
      this.measureScrollbarWidth();
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
      this.primeSpeechSynthesis();

      // 先导入词典（字+短语全量常驻并标注分类），再加载按分类归档的统计，
      // 保证首次升级时迁移能按现有词条分类拆分历史累计记录
      await this.autoLoadDict();
      await this.loadTodayStats();
      // 显示上次词库更新时间
      await this.loadDictUpdateTimeDisplay();
      this.render();
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
          await this.db.updateWord(w);
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

      if (this.currentPage === 'learn') {
        await this.prepareLearnSession();
      }
    } catch (error) {
      console.error('自动加载 dict.xlsx 失败:', error);
      // 忽略错误，不影响应用启动
    }
  }
  
  // 测量滚动条宽度
  measureScrollbarWidth() {
    const scrollDiv = document.createElement('div');
    scrollDiv.style.cssText = 'width: 100px; height: 100px; overflow: scroll; position: absolute; top: -9999px;';
    document.body.appendChild(scrollDiv);
    const scrollbarWidth = scrollDiv.offsetWidth - scrollDiv.clientWidth;
    document.body.removeChild(scrollDiv);
    document.documentElement.style.setProperty('--scrollbar-width', `${scrollbarWidth}px`);
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
      this.bindEvents();
      await this.addSampleWords();
      this.render();
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
    this.settings.cardBgColor = await this.db.getSetting('cardBgColor', '#E8F5E9');
    this.settings.speechEnabled = await this.db.getSetting('speechEnabled', false);
    this.settings.soundEnabled = await this.db.getSetting('soundEnabled', false);
    this.settings.phoneticAutoRead = await this.db.getSetting('phoneticAutoRead', false);
    this.settings.cardDefinitionFirst = await this.db.getSetting('cardDefinitionFirst', false);
    this.settings.categoryDisplay = await this.db.getSetting('categoryDisplay', false);
    this.settings.learnMode = await this.db.getSetting('learnMode', 'random');
    this.settings.phoneticDelay = await this.db.getSetting('phoneticDelay', 2);
    this.settings.repeatFrequency = await this.db.getSetting('repeatFrequency', 2);
    this.settings.dictImportType = await this.db.getSetting('dictImportType', 'all');
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

  // 加载今日统计与累计统计（含首次升级迁移与每日跨天累加）
  async loadTodayStats() {
    const today = new Date().toDateString();
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

  /** 记录某词条的一次学习动作（kind: mastered/review，delta ±1），并按该词条分类归档 */
  async bumpScopeStats(word, kind, delta) {
    if (!word) return;
    const key = this.scopeKeyOfWord(word);
    this._scopeToday[key][kind] = Math.max(0, (Number(this._scopeToday[key][kind]) || 0) + delta);
    this.syncActiveStatsMirrors();
    await this.persistScopeStats();
  }

  /**
   * 从数据库实时统计当前词典范围的学习状态。
   * 今日只统计今天学习过、且当前状态为 mastered/review 的词条；
   * 累计统计当前所有 mastered/review 词条，确保词典增删后数字同步变化。
   * 在以下场景调用：词条状态变更、词典范围切换、初始化、清除进度等。
   */
  async refreshStatusCounts() {
    const allWords = await this.db.getAllWords();
    const scoped = allWords.filter((w) => this.isWordInActiveScope(w));
    const now = new Date();
    const today = this._emptyScopeStats();
    const total = this._emptyScopeStats();

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
    this._cachedStatusCounts = {
      mastered: total.word.mastered + total.phrase.mastered,
      review: total.word.review + total.phrase.review
    };
    this.syncActiveStatsMirrors();
    await this.persistScopeStats();
  }

  /** 清空今日与累计统计（数据管理 - 清除记录时调用） */
  async resetScopeStats() {
    this._scopeToday = this._emptyScopeStats();
    this._scopeTotal = this._emptyScopeStats();
    await this.persistScopeStats();
    this.syncActiveStatsMirrors();
  }


  /**
   * 绑定全局事件（只在启动时绑定一次）：
   * 底部导航切换、弹窗关闭、首页统计数字点击、保存单词按钮、
   * 卡片点击翻面、喇叭发音/收藏按钮（同时监听 click 与 touchstart 并去重）、
   * 卡片滑动手势、学习页三个操作按钮；设置页与词库页的事件分别委托给
   * bindSettingsEvents() / bindLibraryEvents()。
   */
  bindEvents() {
    const self = this;
    
    // 导航切换
    document.querySelector('.bottom-nav').addEventListener('click', handleNavClick);
    document.querySelector('.bottom-nav').addEventListener('touchstart', handleNavClick);
    
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

    // 模态框关闭
    document.querySelectorAll('.modal-overlay').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target === el) self.closeModals();
      });
      el.addEventListener('touchstart', (e) => {
        if (e.target === el) self.closeModals();
      });
    });
    
    // 关闭按钮
    document.querySelectorAll('.modal-close').forEach(el => {
      el.addEventListener('click', () => self.closeModals());
      el.addEventListener('touchstart', (e) => { e.preventDefault(); self.closeModals(); });
    });
    
    // 首页统计数字点击跳转
    const statMastered = document.getElementById('statMastered');
    if (statMastered) {
      statMastered.addEventListener('click', () => self.handleStatClick('mastered'));
      statMastered.addEventListener('touchstart', (e) => { e.preventDefault(); self.handleStatClick('mastered'); });
    }
    
    const statReview = document.getElementById('statReview');
    if (statReview) {
      statReview.addEventListener('click', () => self.handleStatClick('review'));
      statReview.addEventListener('touchstart', (e) => { e.preventDefault(); self.handleStatClick('review'); });
    }
    
    // 累计统计点击事件
    const totalMastered = document.getElementById('totalMastered');
    if (totalMastered) {
      totalMastered.addEventListener('click', () => self.handleTotalStatClick('mastered'));
      totalMastered.addEventListener('touchstart', (e) => { e.preventDefault(); self.handleTotalStatClick('mastered'); });
    }
    
    const totalReview = document.getElementById('totalReview');
    if (totalReview) {
      totalReview.addEventListener('click', () => self.handleTotalStatClick('review'));
      totalReview.addEventListener('touchstart', (e) => { e.preventDefault(); self.handleTotalStatClick('review'); });
    }

    // 保存单词表单
    const saveWordBtn = document.getElementById('saveWordBtn');
    saveWordBtn.addEventListener('click', () => self.saveWord());
    saveWordBtn.addEventListener('touchstart', (e) => { e.preventDefault(); self.saveWord(); });

    // 卡片点击翻转（仅非触摸设备）
    const flashcard = document.getElementById('flashcard');
    flashcard.addEventListener('click', handleCardClick);
    
    function handleCardClick(e) {
      if (self._suppressNextCardClickFlip) {
        self._suppressNextCardClickFlip = false;
        return;
      }
      if (
        !e.target.closest('.speak-btn') &&
        !e.target.closest('.favorite-btn') &&
        !e.target.closest('.language-badge')
      ) {
        self.flipCard();
      }
    }
    
    // 发音 / 收藏：移动端会先 touchstart 再合成 click；document 默认 passive 导致 preventDefault 无效，
    // 会连续触发两次。用 passive:false + 短时间忽略紧随其后的 click。
    let lastSpeakTouchTs = 0;
    let lastFavoriteTouchTs = 0;

    document.addEventListener('click', handleSpeakClick);
    document.addEventListener('touchstart', handleSpeakClick, { passive: false });

    function handleSpeakClick(e) {
      if (!self.settings.speechEnabled) return;
      const btn = e.target.closest('.speak-btn');
      if (!btn) return;
      const isVisible = window.getComputedStyle(btn).display !== 'none';
      if (!isVisible) return;

      e.stopPropagation();
      if (e.type === 'click') {
        if (Date.now() - lastSpeakTouchTs < 450) {
          if (e.cancelable) e.preventDefault();
          return;
        }
        self.speakCurrentWord();
        return;
      }
      lastSpeakTouchTs = Date.now();
      if (e.cancelable) e.preventDefault();
      self.speakCurrentWord();
    }

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
    
    // 卡片滑动
    this.initCardSwipe();
    
    // 操作按钮
    const btnDifficult = document.getElementById('btnDifficult');
    btnDifficult.addEventListener('click', () => self.markDifficult());
    btnDifficult.addEventListener('touchstart', (e) => { e.preventDefault(); self.markDifficult(); });
    
    const btnSkip = document.getElementById('btnSkip');
    btnSkip.addEventListener('click', () => self.skipCard());
    btnSkip.addEventListener('touchstart', (e) => { e.preventDefault(); self.skipCard(); });
    
    const btnMastered = document.getElementById('btnMastered');
    btnMastered.addEventListener('click', () => self.markMastered());
    btnMastered.addEventListener('touchstart', (e) => { e.preventDefault(); self.markMastered(); });
    
    // 重新开始按钮
    const restartBtn = document.getElementById('restartBtn');
    restartBtn.addEventListener('click', () => self.restartLearn());
    restartBtn.addEventListener('touchstart', (e) => { e.preventDefault(); self.restartLearn(); });

    // 设置相关
    this.bindSettingsEvents();
    
    // 搜索和筛选
    this.bindLibraryEvents();
    
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
   * 默认按当前词典范围显示（全部 / 字 / 短语）；
   * 仅当用户精确勾选了某一个分类时才显示该分类名。
   */
  updateCategoryLabel() {
    const label = document.getElementById('categoryLabel');
    if (!label) return;
    const boxes = document.querySelectorAll('#categoryOptions input[type="checkbox"]');
    const checkedBoxes = document.querySelectorAll('#categoryOptions input[type="checkbox"]:checked');
    if (boxes.length > 0 && checkedBoxes.length === 1) {
      label.textContent = checkedBoxes[0].dataset.category;
    } else {
      label.textContent = this.getDictScopeLabel();
    }
  }
  
  // 渲染分类选项（仅当前展示分类内的词条；词典短语/字不设单独勾选项）
  async renderCategoryOptions() {
    const words = (await this.db.getAllWords()).filter((w) => this.isWordInActiveScope(w));
    const categories = [...new Set(words.map((w) => w.category || '未分类'))];
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
        <span>${this.escapeHtml(cat)}</span>
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

  /** 学习页已有进度或已完成当日队列时，锁定每日目标滑块 */
  isDailyGoalSliderLocked() {
    return (
      Array.isArray(this.todayWords) &&
      this.todayWords.length > 0 &&
      (this.currentCardIndex > 0 || this.currentCardIndex >= this.todayWords.length)
    );
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

  /** 语音朗读开关影响例句朗读和音标朗读的可用状态 */
  refreshSpeechDependentToggles() {
    const speechOn = this.settings.speechEnabled;
    const soundToggle = document.getElementById('soundToggle');
    const phoneticToggle = document.getElementById('phoneticReadToggle');
    if (soundToggle) {
      soundToggle.style.opacity = speechOn ? '1' : '0.4';
      soundToggle.style.cursor = speechOn ? 'pointer' : 'not-allowed';
    }
    if (phoneticToggle) {
      phoneticToggle.style.opacity = speechOn ? '1' : '0.4';
      phoneticToggle.style.cursor = speechOn ? 'pointer' : 'not-allowed';
    }
    document.querySelectorAll('.speak-btn').forEach(btn => {
      btn.classList.toggle('disabled', !speechOn);
    });
    document.querySelectorAll('.library-speak-btn').forEach(btn => {
      btn.classList.toggle('disabled', !speechOn);
    });
  }

  /** 词典导入/范围切换后：分类下拉勾选当前展示分类下的全部真实分类（等同于「全部」） */
  async syncLibraryCategoryFilterToDictType() {
    const words = (await this.db.getAllWords()).filter((w) => this.isWordInActiveScope(w));
    const userCats = [...new Set(words.map((w) => w.category || '未分类'))];
    this.selectedCategories = [...userCats];
  }

  /** language 列标明粤语时，音标朗读优先粤拼 */
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
   * 设置页事件绑定：每日目标滑块、学习模式、卡片背景色、
   * 语音朗读总开关 / 例句自动朗读 / 音标自动朗读（后两者依赖总开关）、
   * 卡片释义优先、分类显示、音标渐显时长、重复频率、清除进度、词典范围切换。
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
      if (self.isDailyGoalSliderLocked()) {
        self.showToast('学习进行中，无法修改每日目标');
        self.refreshGoalSliderLockedState();
        return;
      }
      
      self.settings.dailyGoal = parseInt(goalSlider.value);
      await self.db.setSetting('dailyGoal', self.settings.dailyGoal);
      // 清除之前保存的学习进度，确保新目标从全新的状态开始
      await self.db.setSetting('learnProgress', null);
      self.showToast('每日目标已更新');
      
      // 立即更新进度条UI
      if (document.getElementById('progressFill')) {
        document.getElementById('progressFill').style.width = '0%';
      }
      if (document.getElementById('progressText')) {
        document.getElementById('progressText').textContent = `0/${self.settings.dailyGoal}`;
      }
      
      // 如果当前在学习页面，重新准备学习会话并更新进度
      if (self.currentPage === 'learn') {
        await self.prepareLearnSession();
        self.showCard(self.currentCardIndex);
        self.updateProgress();
      }
    });
    
    // 监听页面切换，更新滑块状态
    // 已合并到 handleNavClick 事件委托中，此监听器删除

    // 学习模式
    document.querySelectorAll('.mode-option').forEach(option => {
      option.addEventListener('click', handleModeClick);
      option.addEventListener('touchstart', handleModeClick);
    });
    
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

    // 卡片背景色
    document.querySelectorAll('.color-option').forEach(option => {
      option.addEventListener('click', handleColorClick);
      option.addEventListener('touchstart', handleColorClick);
    });
    
    async function handleColorClick(e) {
      e.preventDefault();
      const option = e.currentTarget;
      document.querySelectorAll('.color-option').forEach(o => o.classList.remove('active'));
      option.classList.add('active');
      self.settings.cardBgColor = option.dataset.color;
      await self.db.setSetting('cardBgColor', self.settings.cardBgColor);
      self.applySettings();
    }

    // 音效开关
    const speechToggle = document.getElementById('speechToggle');
    if (speechToggle) {
      speechToggle.addEventListener('click', handleSpeechToggle);
      speechToggle.addEventListener('touchstart', handleSpeechToggle);
    }

    async function handleSpeechToggle(e) {
      e.preventDefault();
      const toggle = document.getElementById('speechToggle');
      toggle.classList.toggle('active');
      self.settings.speechEnabled = toggle.classList.contains('active');
      await self.db.setSetting('speechEnabled', self.settings.speechEnabled);
      if (!self.settings.speechEnabled) {
        self.settings.soundEnabled = false;
        self.settings.phoneticAutoRead = false;
        await self.db.setSetting('soundEnabled', false);
        await self.db.setSetting('phoneticAutoRead', false);
        const st = document.getElementById('soundToggle');
        if (st) st.classList.remove('active');
        const pt = document.getElementById('phoneticReadToggle');
        if (pt) pt.classList.remove('active');
      }
      self.refreshSpeechDependentToggles();
      self.applySettings();
    }

    const soundToggle = document.getElementById('soundToggle');
    soundToggle.addEventListener('click', handleSoundToggle);
    soundToggle.addEventListener('touchstart', handleSoundToggle);
    
    async function handleSoundToggle(e) {
      if (!self.settings.speechEnabled) {
        self.showToast('请先开启「语音朗读」');
        return;
      }
      e.preventDefault();
      const toggle = document.getElementById('soundToggle');
      toggle.classList.toggle('active');
      self.settings.soundEnabled = toggle.classList.contains('active');
      await self.db.setSetting('soundEnabled', self.settings.soundEnabled);
    }

    const phoneticReadToggle = document.getElementById('phoneticReadToggle');
    if (phoneticReadToggle) {
      phoneticReadToggle.addEventListener('click', handlePhoneticReadToggle);
      phoneticReadToggle.addEventListener('touchstart', handlePhoneticReadToggle);
    }

    async function handlePhoneticReadToggle(e) {
      if (!self.settings.speechEnabled) {
        self.showToast('请先开启「语音朗读」');
        return;
      }
      e.preventDefault();
      const toggle = document.getElementById('phoneticReadToggle');
      toggle.classList.toggle('active');
      self.settings.phoneticAutoRead = toggle.classList.contains('active');
      await self.db.setSetting('phoneticAutoRead', self.settings.phoneticAutoRead);
    }

    const cardDefinitionFirstToggle = document.getElementById('cardDefinitionFirstToggle');
    if (cardDefinitionFirstToggle) {
      cardDefinitionFirstToggle.addEventListener('click', handleCardDefinitionFirstToggle);
      cardDefinitionFirstToggle.addEventListener('touchstart', handleCardDefinitionFirstToggle);
    }

    // 分类显示设置
    const categoryDisplayToggle = document.getElementById('categoryDisplayToggle');
    if (categoryDisplayToggle) {
      categoryDisplayToggle.addEventListener('click', handleCategoryDisplayToggle);
      categoryDisplayToggle.addEventListener('touchstart', handleCategoryDisplayToggle);
    }

    async function handleCardDefinitionFirstToggle(e) {
      e.preventDefault();
      const toggle = document.getElementById('cardDefinitionFirstToggle');
      toggle.classList.toggle('active');
      self.settings.cardDefinitionFirst = toggle.classList.contains('active');
      await self.db.setSetting('cardDefinitionFirst', self.settings.cardDefinitionFirst);
      if (self.currentPage === 'learn' && self.todayWords.length > 0) {
        self.cancelScheduledPhoneticRead();
        self.showCard(self.currentCardIndex);
        self.schedulePhoneticReadAfterCardSwitch();
      }
    }

    // 分类显示设置
    async function handleCategoryDisplayToggle(e) {
      e.preventDefault();
      const toggle = document.getElementById('categoryDisplayToggle');
      toggle.classList.toggle('active');
      self.settings.categoryDisplay = toggle.classList.contains('active');
      await self.db.setSetting('categoryDisplay', self.settings.categoryDisplay);
      if (self.currentPage === 'learn' && self.todayWords.length > 0) {
        self.cancelScheduledPhoneticRead();
        self.showCard(self.currentCardIndex);
        self.schedulePhoneticReadAfterCardSwitch();
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
    const clearProgressBtn = document.getElementById('clearProgressBtn');
    clearProgressBtn.addEventListener('click', () => self.clearProgress());
    clearProgressBtn.addEventListener('touchstart', (e) => { e.preventDefault(); self.clearProgress(); });
    
    // 词典类型选择事件
    const dictTypeSelect = document.getElementById('dictTypeSelect');
    if (dictTypeSelect) {
      dictTypeSelect.addEventListener('change', async () => {
        const newType = dictTypeSelect.value;

        // 字（word）与短语（phrase）的词条始终全量常驻词库并保留各自学习记录，
        // 切换范围只是改变“当前学习/展示/统计的分类”，不删除任何词条、不清空任何记录
        self.settings.dictImportType = newType;
        await self.db.setSetting('dictImportType', newType);

        // 按当前分类重新映射统计数字（全部 = 字 + 短语）
        self.syncActiveStatsMirrors();

        // 词典范围已变更，重新统计真实状态计数
        await self.refreshStatusCounts();

        // 学习队列按新范围重建，清除会话缓存，避免返回学习页时恢复旧范围的队列
        await self.db.setSetting('learnProgress', null);
        self._learnSessionSnapshot = null;
        self.currentCardIndex = 0;

        // 词库页展示范围已变化，同步分类勾选并刷新列表
        await self.syncLibraryCategoryFilterToDictType();
        await self.renderCategoryOptions();
        if (self.currentPage === 'library') {
          await self.renderLibrary();
        }

        await self.prepareLearnSession();

        self.showToast('词典已更新');
      });
    }

    updateGoalSliderState();
  }

  /** 把当前设置应用到界面：卡片背景色、语音相关控件可用状态、字号等 */
  applySettings() {
    const flashcard = document.getElementById('flashcard');
    if (flashcard) {
      flashcard.style.background = this.settings.cardBgColor;
    }

    this.refreshSpeechDependentToggles();

    const fontSizes = { small: '14px', medium: '16px', large: '20px' };
    document.documentElement.style.setProperty('--font-size-md', fontSizes[this.settings.fontSize] || '16px');
  }

  /**
   * 初始化学习卡片的触摸手势（移动端）：
   * - 短按（<500ms 且未移动）：翻转卡片；
   * - 向左滑超过 80px：标记“已掌握”；
   * - 向右滑超过 80px：跳过当前词（移到队尾）；
   * - 其余情况：卡片回弹原位。
   * 滑动过程中让卡片跟手平移并轻微旋转。
   */
  initCardSwipe() {
    const card = document.getElementById('flashcard');
    let startX = 0, startY = 0, currentX = 0;
    let isDragging = false;
    let isClick = true;
    let touchStartTime = 0;

    const self = this;

    card.addEventListener('touchstart', (e) => {
      // 检查是否点击了收藏按钮或发音按钮
      const target = e.target;
      if (
        target.closest('.favorite-btn') ||
        target.closest('.speak-btn') ||
        target.closest('.language-badge')
      ) {
        isDragging = false;
        return;
      }
      
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      currentX = 0;
      isDragging = true;
      isClick = true;
      touchStartTime = Date.now();
      card.style.transition = 'none';
    });

    card.addEventListener('touchmove', (e) => {
      if (!isDragging) return;
      currentX = e.touches[0].clientX - startX;
      const currentY = e.touches[0].clientY - startY;
      
      // 只有当滑动超过阈值时才认为是滑动
      if (Math.abs(currentX) > 10 || Math.abs(currentY) > 10) {
        isClick = false;
        // 只在水平滑动为主时处理移动效果
        if (Math.abs(currentX) > Math.abs(currentY)) {
          e.preventDefault();
          card.style.transform = `translateX(${currentX}px) rotate(${currentX * 0.05}deg)`;
        }
      }
    });

    card.addEventListener('touchend', () => {
      if (!isDragging) return;
      isDragging = false;
      card.style.transition = 'transform 0.3s ease';
      
      // 判断是否为点击（短时间内的触摸）
      const touchDuration = Date.now() - touchStartTime;
      
      if (isClick && touchDuration < 500) {
        // 触摸翻面后仍会触发合成 click，避免与 handleCardClick 重复翻面
        self._suppressNextCardClickFlip = true;
        self.flipCard();
      } else if (currentX > 80) {
        // 向右滑动（从左往右）- 跳过、下一个单词
        card.style.transform = 'translateX(150%) rotate(15deg)';
        setTimeout(() => {
          card.style.transition = 'none';
          card.style.transform = '';
          self.skipCard();
        }, 300);
      } else if (currentX < -80) {
        // 向左滑动（从右往左）- 掌握
        card.style.transform = 'translateX(-150%) rotate(-15deg)';
        setTimeout(() => {
          card.style.transition = 'none';
          card.style.transform = '';
          self.markMastered();
        }, 300);
      } else {
        // 回到原位
        card.style.transform = '';
      }
      currentX = 0;
    });
  }

  /**
   * 切换底部导航页面（learn / library / settings）。
   * 离开学习页时把当前队列与下标快照到 _learnSessionSnapshot；
   * 回到学习页时，若快照队列长度与每日目标一致则恢复进度，否则重建今日队列。
   */
  switchPage(page) {
    if (this.currentPage === page) return;

    // 离开学习页时把会话存到实例上，否则返回学习页时局部变量已丢失，会误走 prepareLearnSession 导致进度清零
    if (this.currentPage === 'learn' && this.todayWords && this.todayWords.length > 0) {
      this._learnSessionSnapshot = {
        currentCardIndex: this.currentCardIndex,
        todayWords: JSON.parse(JSON.stringify(this.todayWords)),
        todayStats: { ...this.todayStats }
      };
    }

    if (page !== 'learn') {
      this.cancelScheduledPhoneticRead();
    }
    
    this.currentPage = page;
    
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.page === page);
    });
    
    document.querySelectorAll('.page').forEach(p => {
      p.classList.toggle('active', p.id === `${page}Page`);
    });

    if (page === 'learn') {
      const snap = this._learnSessionSnapshot;
      // 只有当快照中的队列长度与当前每日目标匹配时才恢复快照
      const shouldRestoreSnapshot = snap && snap.todayWords && snap.todayWords.length > 0 && 
                                   snap.todayWords.length === this.settings.dailyGoal;
      
      if (shouldRestoreSnapshot) {
        this.todayWords = snap.todayWords;
        this.currentCardIndex = snap.currentCardIndex;
        this.todayStats = { ...snap.todayStats };
        // 统计数据以按分类归档的计数为准，避免恢复会话快照时把数字回退到旧值
        this.syncActiveStatsMirrors();
        const emptyState = document.getElementById('learnEmptyState');
        if (emptyState) emptyState.style.display = 'none';
        
        // 检查是否已经完成所有单词学习
        if (this.currentCardIndex >= this.todayWords.length) {
          // 显示完成页面
          this.showComplete();
        } else {
          // 继续显示当前卡片
          this.showCard(this.currentCardIndex);
          document.querySelector('.card-stack').style.display = 'flex';
          document.querySelector('.complete-container').style.display = 'none';
          this.schedulePhoneticReadAfterCardSwitch();
        }
        
        this.updateProgress();
      } else {
        this.prepareLearnSession();
      }
    } else if (page === 'library') {
      this.renderCategoryOptions();
      this.renderLibrary();
    } else if (page === 'settings') {
      this.renderSettings();
    }
  }

  /** 首次渲染：准备今日学习队列（学习页默认显示）并把设置应用到界面 */
  render() {
    this.prepareLearnSession();
    this.applySettings();
  }

  // 保存学习进度到 IndexedDB
  async saveLearnProgress() {
    if (!this.todayWords || this.todayWords.length === 0) return;
    
    const progress = {
      currentCardIndex: this.currentCardIndex,
      todayWords: JSON.parse(JSON.stringify(this.todayWords)),
      savedAt: new Date().toISOString()
    };
    await this.db.setSetting('learnProgress', progress);
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
   * 准备（或恢复）今日学习会话：
   * 1) 若今天保存过进度且队列长度与每日目标一致 → 恢复进度；
   * 2) 否则取当前词典范围（全部/字/短语）的词条，按“重复频率”过滤掉近期学过的；
   * 3) 随机模式打散并尽量让相邻卡片分类不同；顺序模式按 新词→待复习 排列；
   * 4) 截取每日目标数量作为今日队列，渲染第一张卡并更新进度条。
   */
  async prepareLearnSession() {
    this.cancelScheduledPhoneticRead();
    this._learnSessionSnapshot = null;

    // 尝试加载之前保存的学习进度
    const savedProgress = await this.loadLearnProgress();
    const allStoredWords = await this.db.getAllWords();
    const storedWordsById = new Map(allStoredWords.map((word) => [word.id, word]));
    const restoredTodayWords = savedProgress?.todayWords
      ? savedProgress.todayWords.map((word) => storedWordsById.get(word.id)).filter(Boolean)
      : [];
    
    // 只有保存的队列与当前词典完全对应且长度与每日目标匹配时才恢复进度
    const shouldRestoreProgress = savedProgress && 
                                  savedProgress.todayWords && 
                                  restoredTodayWords.length === savedProgress.todayWords.length &&
                                  savedProgress.todayWords.length === this.settings.dailyGoal &&
                                  this.currentCardIndex === 0;
    
    if (shouldRestoreProgress) {
      // 恢复之前的学习进度，并使用数据库中的最新词条内容，避免旧快照覆盖词典更新
      this.todayWords = restoredTodayWords;
      this.currentCardIndex = savedProgress.currentCardIndex;
      
      // 更新统计数据
      this.todayStats.total = this.todayWords.length;
      await this.db.setSetting('todayStats', this.todayStats);
      
      if (this.todayWords.length > 0) {
        const emptyState = document.getElementById('learnEmptyState');
        if (emptyState) emptyState.style.display = 'none';
        
        // 检查是否已经完成所有单词学习
        if (this.currentCardIndex >= this.todayWords.length) {
          // 显示完成页面
          this.showComplete();
        } else {
          // 继续显示当前卡片
          this.showCard(this.currentCardIndex);
          document.querySelector('.card-stack').style.display = 'flex';
          document.querySelector('.complete-container').style.display = 'none';
        }
      } else {
        this.showEmptyState();
      }
      
      this.updateProgress();
      this.refreshGoalSliderLockedState();
      return;
    }

    // 只取当前展示分类（全部/字/短语）的词条；另一分类的词条常驻词库，记录不会被清除
    const allWords = allStoredWords.filter((w) => this.isWordInActiveScope(w));
    
    // 根据重复频率筛选单词
    const frequency = this.settings.repeatFrequency;
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000; // 一天的毫秒数
    
    let availableWords = allWords;
    
    if (frequency > 0) {
      // 筛选出在重复频率时间之外的单词
      availableWords = allWords.filter(word => {
        const lastStudied = word.lastStudied || 0;
        const timePassed = now - lastStudied;
        return timePassed >= frequency * dayMs;
      });
    }
    
    let todayWords;
    if (this.settings.learnMode === 'random') {
      todayWords = this.pickRandomSpreadByCategory(availableWords, this.settings.dailyGoal);
    } else {
      const newWords = availableWords.filter((w) => w.status === 'new');
      const reviewWords = availableWords.filter((w) => w.status === 'review');
      todayWords = [...newWords, ...reviewWords].slice(0, this.settings.dailyGoal);
      if (todayWords.length < this.settings.dailyGoal && availableWords.length > 0) {
        const remaining = availableWords.filter((w) => !todayWords.find((t) => t.id === w.id));
        const needed = this.settings.dailyGoal - todayWords.length;
        todayWords = [...todayWords, ...remaining.slice(0, needed)];
      }
    }
    
    this.todayWords = todayWords;
    this.currentCardIndex = 0;
    this.todayStats.total = this.todayWords.length;
    await this.db.setSetting('todayStats', this.todayStats);
    
    if (this.todayWords.length > 0) {
      this.showCard(this.currentCardIndex);
      document.querySelector('.card-stack').style.display = 'flex';
      document.querySelector('.complete-container').style.display = 'none';
      const emptyState = document.getElementById('learnEmptyState');
      if (emptyState) emptyState.style.display = 'none';
    } else {
      this.showEmptyState();
    }
    
    // 刷新累计统计缓存后再更新进度，确保数字与词库一致
    await this.refreshStatusCounts();
    this.updateProgress();
    this.refreshGoalSliderLockedState();
  }

  /**
   * 渲染指定下标的卡片：拼接正反面 HTML（正面=词汇+音标+收藏/喇叭，
   * 背面=释义+例句），按“释义优先”设置决定初始朝向，处理音标渐显定时，
   * 并在开启音效且背面朝上时延迟自动朗读。
   */
  showCard(index) {
    if (index >= this.todayWords.length) {
      return;
    }
    
    const word = this.todayWords[index];
    const card = document.getElementById('flashcard');
    const cardInner = card.querySelector('.flashcard-inner');
    
    const isCantonese = this.isCantoneseWord(word);
    const cantonesePhoneticFirst = isCantonese || this.isImportedCantoneseLanguage(word);
    const badgeLabel = this.getLanguageBadgeLabel(word);
    
    // 添加分类标签（显示在语言标签后面）
    // 关闭"分类显示"开关时，不显示分类徽标；开启时显示 dict 表 category 列内容
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
    
    const badgeRowHtml = (badgeHtml || categoryHtml)
      ? `<div class="flashcard-badge-row">${badgeHtml}${badgeHtml && categoryHtml ? '&nbsp;&nbsp;' : ''}${categoryHtml}</div>`
      : '';

    cardInner.innerHTML = `
      <div class="flashcard-front">
        ${badgeRowHtml}
        <div class="flashcard-corner-tr">
          <button class="speak-btn" id="speakBtn">
          <svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.74 2.5-2.26 2.5-4.02zM14 3.23v2.06c2.89 1.19 5 3.65 5 6.71s-2.11 5.52-5 6.71v2.06c4.01-1.29 7-4.95 7-9.77s-2.99-8.48-7-9.77z"/></svg>
        </button>
        </div>
        <button class="favorite-btn ${word.favorite ? 'active' : ''}" id="favoriteBtn">
          <svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
        </button>
        <div class="word">${word.word}</div>
        <div class="phonetic" id="phoneticText">${cantonesePhoneticFirst ? (word.jyutping || word.phonetic || '') : (word.phonetic || word.jyutping || '')}</div>
        ${isCantonese && word.cantonese ? `<div class="cantonese-word">${word.cantonese}</div>` : ''}
        <div class="tap-hint">点击查看释义</div>
      </div>
      <div class="flashcard-back">
        <div class="flashcard-corner-tr">
          <button class="speak-btn" id="speakBtnBack">
          <svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.74 2.5-2.26 2.5-4.02zM14 3.23v2.06c2.89 1.19 5 3.65 5 6.71s-2.11 5.52-5 6.71v2.06c4.01-1.29 7-4.95 7-9.77s-2.99-8.48-7-9.77z"/></svg>
        </button>
        </div>
        <button class="favorite-btn ${word.favorite ? 'active' : ''}" id="favoriteBtnBack">
          <svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
        </button>
        <div class="meaning">${word.definition || word.meaning}</div>
        <div class="example">${word.example ? `"${word.example}"` : ''}</div>
        ${isCantonese && word.cantoneseExample ? `<div class="cantonese-example">"${word.cantoneseExample}"</div>` : ''}
        <div class="tap-hint tap-hint-back">点击查看词汇</div>
      </div>
    `;
    
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

    if (this.settings.soundEnabled && this.isFlipped) {
      setTimeout(() => {
        this.speakCurrentWord();
      }, 2000);
    }
    this.refreshSpeechDependentToggles();
  }

  /** 翻转卡片（正面↔背面）；翻到背面且开启音效时 2 秒后自动朗读例句 */
  flipCard() {
    const card = document.getElementById('flashcard');
    if (!card) {
      console.error('Flashcard element not found');
      return;
    }
    card.classList.toggle('flipped');
    this.isFlipped = !this.isFlipped;
    
    // 如果开启了自动朗读，并且翻到释义面，2秒后自动朗读例句/释义
    if (this.isFlipped && this.settings.soundEnabled) {
      setTimeout(() => {
        this.speakCurrentWord();
      }, 2000);
    }

    // 释义优先：翻到词汇面时再触发音标自动朗读（切换卡片时若停在释义面则不会误触发）
    if (!this.isFlipped && this.settings.cardDefinitionFirst) {
      this.schedulePhoneticReadAfterCardSwitch();
    }
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
   * 朗读用语种：english（含 legacy mandarin 英词卡）、cantonese、mandarin（普通话汉字）
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

  /** 该词条是否按粤语处理（决定音标优先粤拼、朗读用 zh-HK 音色） */
  isCantoneseWord(word) {
    return this.getSpeechKind(word) === 'cantonese';
  }

  /** 按语种设置语速、音高（英语略接近自然语流，减轻生硬感） */
  applyUtteranceProsody(utterance, lang) {
    const low = (lang || '').toLowerCase();
    utterance.volume = 1;
    if (low.startsWith('en')) {
      utterance.rate = 0.94;
      utterance.pitch = 1;
    } else if (low.startsWith('zh-hk')) {
      utterance.rate = 0.88;
      utterance.pitch = 1;
    } else {
      utterance.rate = 0.85;
      utterance.pitch = 1;
    }
  }

  /**
   * 在可用音色中选择较自然的美式英语（优先 en-US、高质量/神经网络等命名）
   */
  pickBestEnglishVoice(voices) {
    if (!voices || voices.length === 0) return null;
    const candidates = voices.filter((v) => (v.lang || '').toLowerCase().startsWith('en'));
    if (candidates.length === 0) return null;

    const rank = (v) => {
      const n = (v.name || '').toLowerCase();
      const l = (v.lang || '').toLowerCase();
      let s = 0;
      if (l === 'en-us') s += 100;
      else if (l.startsWith('en-us')) s += 95;
      else if (l === 'en-gb') s += 72;
      else if (l.startsWith('en-gb')) s += 68;
      else s += 45;

      try {
        if (v.localService === true) s += 12;
      } catch (e) {
        /* ignore */
      }

      if (n.includes('google') && (n.includes('us') || n.includes('english'))) s += 38;
      else if (n.includes('google')) s += 22;
      if (n.includes('natural')) s += 30;
      if (n.includes('neural')) s += 30;
      if (n.includes('premium')) s += 18;
      if (n.includes('microsoft')) s += 14;
      if (n.includes('enhanced')) s += 14;
      if (n.includes('samantha') || n.includes('aaron') || n.includes('ava')) s += 10;
      if (n.includes('compact')) s -= 28;
      if (n.includes('embedded')) s -= 18;
      return s;
    };

    let best = candidates[0];
    let bestScore = rank(best);
    for (let i = 1; i < candidates.length; i++) {
      const sc = rank(candidates[i]);
      if (sc > bestScore) {
        best = candidates[i];
        bestScore = sc;
      }
    }
    return best;
  }
  
  /** 尽早枚举语音；部分浏览器需 voiceschanged 后才填充列表 */
  primeSpeechSynthesis() {
    if (!('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.getVoices();
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * 朗读一段文本（发音功能入口）。
   * 先取消正在播放的语音，再创建 SpeechSynthesisUtterance；
   * 部分浏览器音色列表是异步加载的，这里用 voiceschanged 事件 +
   * 两个超时兜底（120ms / 1800ms）确保最终一定能开口朗读。
   */
  speakWord(text, lang = 'zh-CN') {
    if (!text) return;

    const synth = window.speechSynthesis;
    if (!synth) return;

    synth.cancel();

    try {
      if (synth.paused) synth.resume();
    } catch (e) {
      /* ignore */
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    this.applyUtteranceProsody(utterance, lang);

    let spoken = false;
    let tShort = null;
    let tFallback = null;
    const cleanup = () => {
      synth.removeEventListener('voiceschanged', onVoices);
      if (tShort != null) {
        clearTimeout(tShort);
        tShort = null;
      }
      if (tFallback != null) {
        clearTimeout(tFallback);
        tFallback = null;
      }
    };
    const speakNow = (voices) => {
      if (spoken) return;
      spoken = true;
      cleanup();
      this.trySpeakWithVoice(utterance, lang, voices || []);
    };
    function onVoices() {
      const v = synth.getVoices();
      if (v.length > 0) speakNow(v);
    }

    let voices = synth.getVoices();
    if (voices.length > 0) {
      speakNow(voices);
      return;
    }

    synth.addEventListener('voiceschanged', onVoices);
    synth.getVoices();

    tShort = setTimeout(() => {
      const v = synth.getVoices();
      if (v.length > 0) speakNow(v);
    }, 120);

    tFallback = setTimeout(() => {
      speakNow(synth.getVoices());
    }, 1800);
  }
  
  /**
   * 在系统可用音色列表里为目标语言（en / zh-CN / zh-HK）挑选最合适的音色并朗读：
   * 粤语严格匹配 zh-HK / Cantonese（避免错用普通话）；英语用 pickBestEnglishVoice 打分；
   * 普通话优先 zh-CN；都找不到时退而求其次用同语种前缀或英语音色。
   */
  trySpeakWithVoice(utterance, lang, voices) {
    if (!voices || voices.length === 0) {
      window.speechSynthesis.speak(utterance);
      return;
    }
    const want = (lang || '').toLowerCase();
    let voice = null;

    // 粤语必须用 zh-HK / Cantonese 音色；勿用「首个 zh」以免落到普通话
    if (want === 'zh-hk' || want.startsWith('zh-hk')) {
      const nameHints = (v) => {
        const n = (v.name || '').toLowerCase();
        const l = (v.lang || '').toLowerCase();
        return (
          l === 'zh-hk' ||
          l.startsWith('zh-hk') ||
          l.endsWith('-hk') ||
          n.includes('cantonese') ||
          n.includes('hong kong') ||
          n.includes('hongkong') ||
          n.includes('香港') ||
          n.includes('粤语') ||
          n.includes('粵語')
        );
      };
      voice = voices.find(v => (v.lang || '').toLowerCase() === 'zh-hk') ||
        voices.find(v => (v.lang || '').toLowerCase().startsWith('zh-hk')) ||
        voices.find(nameHints);
      if (!voice) {
        const txt = (utterance.text || '').trim();
        const latinJyutpingLike =
          txt.length > 0 &&
          !/[\u4e00-\u9fff]/.test(txt) &&
          /[a-z]{1,6}[1-6]/i.test(txt);
        if (latinJyutpingLike) {
          utterance.lang = 'en-US';
          this.applyUtteranceProsody(utterance, 'en-US');
          voice = this.pickBestEnglishVoice(voices);
        } else {
          voice = voices.find(v => (v.lang || '').toLowerCase().startsWith('zh'));
        }
      }
    } else if (want.startsWith('en')) {
      voice = this.pickBestEnglishVoice(voices);
    } else if (want.startsWith('zh')) {
      voice =
        voices.find(v => (v.lang || '').toLowerCase() === want) ||
        voices.find(v => (v.lang || '').toLowerCase().startsWith(want.split('-')[0] + '-' + (want.split('-')[1] || ''))) ||
        voices.find(v => (v.lang || '').toLowerCase() === 'zh-cn') ||
        voices.find(v => (v.lang || '').toLowerCase().startsWith('zh-cn')) ||
        voices.find(v => (v.lang || '').toLowerCase().startsWith('zh'));
    } else {
      voice =
        voices.find(v => (v.lang || '').toLowerCase() === want) ||
        voices.find(v => (v.lang || '').toLowerCase().startsWith(want.split('-')[0]));
    }

    if (!voice) {
      voice =
        voices.find(v => (v.lang || '').toLowerCase().startsWith(want.split('-')[0])) ||
        voices.find(v => (v.lang || '').toLowerCase().startsWith('en'));
    }

    if (voice) utterance.voice = voice;
    window.speechSynthesis.speak(utterance);
  }
  
  /** 与学习卡正面一致：按词条语言朗读词汇（依据语种 / 音标对应的发音逻辑） */
  speakWordEntryFront(word) {
    if (!word) return;
    const kind = this.getSpeechKind(word);
    let text;
    let lang = 'en-US';
    if (kind === 'cantonese') {
      text = (word.cantonese || word.word || '').trim();
      lang = 'zh-HK';
    } else if (kind === 'mandarin') {
      text = (word.word || '').trim();
      lang = 'zh-CN';
    } else {
      text = this.getEnglishLemmaForSpeech(word);
      lang = 'en-US';
    }
    if (!text) return;
    this.speakWord(text, lang);
  }

  // 朗读单词
  speakCurrentWord() {
    if (this.currentCardIndex >= this.todayWords.length) return;
    const word = this.todayWords[this.currentCardIndex];
    const kind = this.getSpeechKind(word);
    
    if (this.isFlipped) {
      // 卡片背面：优先播放例句，没有例句时播放释义
      const text = (word.example || '').trim() || word.definition || word.meaning || '';
      const lang = kind === 'cantonese' ? 'zh-HK' : 'zh-CN';
      this.speakWord(text, lang);
    } else {
      this.speakWordEntryFront(word);
    }
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
    await this.db.updateWord(word);

    this.todayWords.forEach((w) => {
      if (w.id === word.id) w.favorite = word.favorite;
    });
    if (this._learnSessionSnapshot?.todayWords) {
      this._learnSessionSnapshot.todayWords.forEach((w) => {
        if (w.id === word.id) w.favorite = word.favorite;
      });
    }

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
  }

  // 标记为困难
  async markDifficult() {
    if (this.currentCardIndex >= this.todayWords.length) return;
    
    const word = this.todayWords[this.currentCardIndex];
    word.status = 'review';
    word.lastStudied = Date.now(); // 记录学习时间
    await this.db.updateWord(word);
    // 按词条分类（字/短语）归档今日统计
    await this.bumpScopeStats(word, 'review', 1);
    
    // 保存学习进度
    await this.saveLearnProgress();

    // 刷新累计统计缓存（状态已变更，确保与词库页一致）
    await this.refreshStatusCounts();

    //this.showToast('已标记为需复习');// 请勿删除该注释
      this.nextCard('right');
  }

  // 跳过卡片
  skipCard() {
    // 将当前卡片移到队列末尾
    const skipped = this.todayWords.splice(this.currentCardIndex, 1)[0];
    skipped.lastStudied = Date.now(); // 记录学习时间
    // 持久化学习时间：否则"跳过"的单词在下次会话仍被视为从未学过，
    // 导致重复频率筛选（如 2 天内不再出现）失效
    this.db.updateWord(skipped).catch((err) => console.error('保存跳过学习时间失败:', err));
    this.todayWords.push(skipped);
    this.showCard(this.currentCardIndex);
    this.schedulePhoneticReadAfterCardSwitch();
  }

  // 标记为已掌握
  async markMastered() {
    if (this.currentCardIndex >= this.todayWords.length) return;
    
    const word = this.todayWords[this.currentCardIndex];
    word.status = 'mastered';
    word.lastStudied = Date.now(); // 记录学习时间
    await this.db.updateWord(word);
    // 按词条分类（字/短语）归档今日统计
    await this.bumpScopeStats(word, 'mastered', 1);
    
    // 保存学习进度
    await this.saveLearnProgress();

    // 刷新累计统计缓存（状态已变更，确保与词库页一致）
    await this.refreshStatusCounts();

    // this.showToast('太棒了！已掌握'); // 请勿删除该注释
    this.nextCard('left');
  }

  /**
   * 前进到下一张卡片（掌握/陌生操作后调用）。
   * fromDirection 指示滑出方向（left 左滑/right 右滑），用于做方向一致的
   * “旧卡滑出 → 新卡滑入”动画；已经是最后一张时显示完成页。
   */
  nextCard(fromDirection = 'right') {
    this.currentCardIndex++;
    if (this.currentCardIndex >= this.todayWords.length) {
      this.showComplete();
    } else {
      const card = document.getElementById('flashcard');
      const exitX = fromDirection === 'left' ? '-150%' : '150%';
      const exitRotate = fromDirection === 'left' ? '-15deg' : '15deg';
      const entryX = fromDirection === 'left' ? '150%' : '-150%';
      const entryRotate = fromDirection === 'left' ? '15deg' : '-15deg';
      card.style.transform = `translateX(${exitX}) rotate(${exitRotate})`;
      setTimeout(() => {
        card.style.transition = 'none';
        card.style.transform = `translateX(${entryX}) rotate(${entryRotate})`;
        this.showCard(this.currentCardIndex);
        setTimeout(() => {
          card.style.transition = 'transform 0.3s ease';
          card.style.transform = '';
          this.schedulePhoneticReadAfterCardSwitch();
        }, 20);
      }, 150);
    }
    this.updateProgress();
    this.refreshGoalSliderLockedState();
  }

  /** 取消尚未触发的“自动朗读音标”定时器（切页/重建队列时调用，避免对着旧卡片朗读） */
  cancelScheduledPhoneticRead() {
    if (this._phoneticReadTimer != null) {
      clearTimeout(this._phoneticReadTimer);
      this._phoneticReadTimer = null;
    }
  }

  /** 切换卡片约 0.5 秒后自动朗读音标两遍（需开启「音标朗读」） */
  schedulePhoneticReadAfterCardSwitch() {
    if (!this.settings.phoneticAutoRead) return;
    if (this.currentPage !== 'learn') return;
    if (this.settings.cardDefinitionFirst && this.isFlipped) return;

    this.cancelScheduledPhoneticRead();

    this._phoneticReadTimer = setTimeout(() => {
      this._phoneticReadTimer = null;
      if (!this.settings.phoneticAutoRead || this.currentPage !== 'learn') return;
      if (this.currentCardIndex >= this.todayWords.length) return;
      const word = this.todayWords[this.currentCardIndex];
      this.speakPhoneticTwice(word);
    }, 500);
  }

  /** 自动朗读音标时选用的系统 TTS 语言（须随词条语种切换，不能仅靠音标是否为拉丁字母判断） */
  getLangForPhoneticAutoRead(word, phoneticText) {
    const kind = this.getSpeechKind(word);
    if (kind === 'cantonese' || this.isImportedCantoneseLanguage(word)) return 'zh-HK';
    if (kind === 'mandarin') return 'zh-CN';
    if (/[\u4e00-\u9fff]/.test(phoneticText || '')) return 'zh-CN';
    return 'en-US';
  }

  /**
   * 自动朗读用的文本：粤语词条优先「粤拼」列，避免仍读英语音标列；
   * 其它语种优先 phonetic，其次 jyutping。
   */
  getPhoneticAutoReadRaw(word) {
    if (!word) return '';
    const jp = (word.jyutping || '').trim();
    const ph = (word.phonetic || '').trim();
    const cantoneseLang =
      this.getSpeechKind(word) === 'cantonese' || this.isImportedCantoneseLanguage(word);
    if (cantoneseLang) {
      return jp || ph;
    }
    return ph || jp;
  }

  /**
   * 是否为常见英语 IPA 书写形式。浏览器 TTS 无法按音标朗读，只能读「单词拼写」才相对标准。
   */
  looksLikeEnglishIPA(s) {
    const t = String(s || '');
    if (!t.trim()) return false;
    if (/^\s*\/.+\/\s*$/.test(t.replace(/\s/g, ''))) return true;
    if (/^\s*\//.test(t) || /\/\s*$/.test(t)) return true;
    return /[ˈˌəɛɪʊɔæɑɒɝθðʃʒŋːˑ]/.test(t);
  }

  /**
   * 英语手动朗读（与学习卡正面一致）：优先读词条正文；
   * 若正文误写成 IPA，则尝试读「音标」列里非 IPA 的拼写提示。
   */
  getEnglishLemmaForSpeech(word) {
    let t = (word.word || '').trim();
    if (!t) return '';
    if (!this.looksLikeEnglishIPA(t)) return t;
    const ph = (word.phonetic || '').trim();
    if (ph && !this.looksLikeEnglishIPA(ph)) {
      const cleaned = ph.replace(/^\/+|\/+$/g, '').trim();
      return cleaned || ph;
    }
    return t;
  }

  /** 粤拼拉丁串加分音节空格，便于 TTS 分拍（仅粤语罗马字形态时处理） */
  normalizeCantoneseRomanizationForSpeech(text) {
    let t = String(text || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
    if (!t || /[\u4e00-\u9fff]/.test(t)) return String(text || '').trim();
    if (!t.includes(' ')) {
      const parts = t.match(/[a-z]+[1-6]/g);
      const compact = t.replace(/[^a-z0-9]/gi, '');
      if (parts && parts.join('') === compact) {
        t = parts.join(' ');
      }
    }
    return t;
  }

  /** 朗读音标/粤拼字符串两遍；无内容则跳过 */
  speakPhoneticTwice(word) {
    if (!word || !this.settings.phoneticAutoRead) return;
    const raw = this.getPhoneticAutoReadRaw(word);
    if (!raw) return;

    let text = raw.replace(/^\/+|\/+$/g, '').trim();
    if (!text) text = raw;

    const kind = this.getSpeechKind(word);
    const cantonesePhonetic =
      kind === 'cantonese' || this.isImportedCantoneseLanguage(word);
    if (!cantonesePhonetic && kind === 'english' && this.looksLikeEnglishIPA(raw)) {
      const lemma = this.getEnglishLemmaForSpeech(word);
      if (lemma) text = lemma;
    }

    if (cantonesePhonetic) {
      text = this.normalizeCantoneseRomanizationForSpeech(text);
    }

    window.speechSynthesis.cancel();

    const lang = this.getLangForPhoneticAutoRead(word, text);

    let started = false;
    const run = () => {
      if (started) return;
      const voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) return;
      started = true;
      window.speechSynthesis.onvoiceschanged = null;

      const u1 = new SpeechSynthesisUtterance(text);
      u1.lang = lang;
      this.applyUtteranceProsody(u1, lang);
      u1.onend = () => {
        const u2 = new SpeechSynthesisUtterance(text);
        u2.lang = lang;
        this.applyUtteranceProsody(u2, lang);
        this.trySpeakWithVoice(u2, lang, window.speechSynthesis.getVoices());
      };
      this.trySpeakWithVoice(u1, lang, voices);
    };

    let voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) {
      window.speechSynthesis.onvoiceschanged = run;
      setTimeout(run, 100);
    } else {
      run();
    }
  }

  // 更新进度
  updateProgress() {
    const progress = this.settings.dailyGoal > 0
      ? Math.round((this.currentCardIndex / this.settings.dailyGoal) * 100)
      : 0;

    document.getElementById('progressFill').style.width = `${progress}%`;
    document.getElementById('progressText').textContent = `${this.currentCardIndex}/${this.settings.dailyGoal}`;

    // 今日统计 = 今天学习且当前状态为掌握/待复习的词条数
    document.getElementById('statMastered').textContent = this.todayStats.mastered;
    document.getElementById('statReview').textContent = this.todayStats.review;

    // 累计统计 = 当前词库中各状态的真实词条数（与词库页筛选结果一致）
    document.getElementById('totalMastered').textContent = this._cachedStatusCounts.mastered;
    document.getElementById('totalReview').textContent = this._cachedStatusCounts.review;

    // 更新可点击状态
    const statMastered = document.getElementById('statMastered');
    const statReview = document.getElementById('statReview');
    if (statMastered) {
      statMastered.style.cursor = this.todayStats.mastered >= 1 ? 'pointer' : 'default';
      statMastered.style.opacity = this.todayStats.mastered >= 1 ? '1' : '0.6';
    }
    if (statReview) {
      statReview.style.cursor = this.todayStats.review >= 1 ? 'pointer' : 'default';
      statReview.style.opacity = this.todayStats.review >= 1 ? '1' : '0.6';
    }
    // 累计统计的可点击状态
    const totalMastered = document.getElementById('totalMastered');
    const totalReview = document.getElementById('totalReview');
    if (totalMastered) {
      totalMastered.style.cursor = this._cachedStatusCounts.mastered >= 1 ? 'pointer' : 'default';
      totalMastered.style.opacity = this._cachedStatusCounts.mastered >= 1 ? '1' : '0.6';
    }
    if (totalReview) {
      totalReview.style.cursor = this._cachedStatusCounts.review >= 1 ? 'pointer' : 'default';
      totalReview.style.opacity = this._cachedStatusCounts.review >= 1 ? '1' : '0.6';
    }
  }
  
  // 处理统计数字点击
  handleStatClick(filter) {
    const count = filter === 'mastered' ? this.todayStats.mastered : this.todayStats.review;
    if (count >= 1) {
      this.filterStatus = filter;
      this.switchPage('library');
    }
  }

  // 累计统计点击处理（用缓存的真实状态计数判断，与词库页一致）
  handleTotalStatClick(filter) {
    const count = filter === 'mastered'
      ? this._cachedStatusCounts.mastered
      : this._cachedStatusCounts.review;
    if (count >= 1) {
      this.filterStatus = filter;
      this.switchPage('library');
    }
  }

  // 显示完成页面
  showComplete() {
    document.querySelector('.card-stack').style.display = 'none';
    document.querySelector('.complete-container').style.display = 'flex';
    
    document.getElementById('completeMastered').textContent = this.todayStats.mastered;
    document.getElementById('completeReview').textContent = this.todayStats.review;
  }

  // 显示空状态
  showEmptyState() {
    document.querySelector('.card-stack').style.display = 'none';
    const emptyState = document.getElementById('learnEmptyState');
    if (emptyState) emptyState.style.display = 'flex';
  }

  // 重新开始学习
  restartLearn() {
    // 重置当前卡片索引为0
    this.currentCardIndex = 0;
    // 清除保存的学习进度，确保重新生成队列
    this.db.setSetting('learnProgress', null);
    // 重新生成学习队列
    this.prepareLearnSession();
  }

  // ==================== 词库页面 ====================
  async renderLibrary() {
    // 先刷新顶部范围统计行（数量可能因词典范围切换/词条状态变更而变）
    await this.updateDictTypeSelectLabels();

    // 更新筛选按钮状态
    document.querySelectorAll('.filter-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.filter === this.filterStatus);
    });
    
    // 仅展示当前分类（全部/字/短语）的词条
    let words = (await this.db.getAllWords()).filter((w) => this.isWordInActiveScope(w));
    
    // 应用状态筛选（包括收藏筛选）
    if (this.filterStatus !== 'all') {
      if (this.filterStatus === 'favorite') {
        words = words.filter(w => w.favorite);
      } else {
        words = words.filter(w => w.status === this.filterStatus);
      }
    }
    
    // 应用分类筛选
    if (this.selectedCategories && this.selectedCategories.length > 0) {
      words = words.filter((w) => this.selectedCategories.includes(w.category || '未分类'));
    }
    
    // 应用搜索（支持单词、释义、粤拼、粤语字、粤语例句搜索）
    if (this.searchQuery) {
      const q = this.searchQuery;
      words = words.filter(w => {
        const mean = (w.definition || w.meaning || '').toLowerCase();
        const phon = (w.phonetic || w.jyutping || '').toLowerCase();
        const canto = (w.cantonese || '').toLowerCase();
        const cantoEx = (w.cantoneseExample || w.example || '').toLowerCase();
        return w.word.toLowerCase().includes(q) || mean.includes(q) || phon.includes(q) || canto.includes(q) || cantoEx.includes(q);
      });
    }
    
    const container = document.getElementById('libraryWords');
    
    if (words.length === 0) {
      this._librarySpeakWordsById = new Map();
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

    this._librarySpeakWordsById = new Map(words.map((w) => [w.id, w]));

    // 按分类分组
    const grouped = {};
    words.forEach(word => {
      const cat = word.category || '未分类';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(word);
    });
    
    const categories = Object.keys(grouped);

    let html = '';
    for (const category of categories) {
      const categoryWords = grouped[category];
      html += `
        <div class="category-section">
          <h3 class="category-title">${category} (${categoryWords.length})</h3>
          <div class="word-list">
            ${categoryWords.map(word => `
                <div class="word-item" data-id="${word.id}">
                  <div class="word-info">
                    <h3>${word.word}${word.favorite ? ' ' : ''}</h3>
                    <p>${word.definition || word.meaning}</p>
                  </div>
                  <div class="word-status">
                    ${this.filterStatus === 'favorite' ? `
                      <div class="word-actions">
                        <button type="button" class="word-action-btn library-speak-btn" data-id="${word.id}" title="发音" aria-label="发音">
                          <svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.74 2.5-2.26 2.5-4.02zM14 3.23v2.06c2.89 1.19 5 3.65 5 6.71s-2.11 5.52-5 6.71v2.06c4.01-1.29 7-4.95 7-9.77s-2.99-8.48-7-9.77z"/></svg>
                        </button>
                        <button type="button" class="word-action-btn unfavorite-btn" data-id="${word.id}">
                          <svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                        </button>
                      </div>
                    ` : `
                      ${word.favorite ? `
                        <span class="favorite-badge">★</span>
                      ` : ''}
                      ${word.status === 'mastered' ? `
                        <span class="status-switch to-review" data-id="${word.id}" data-status="review">➔陌生</span>
                      ` : ''}
                      ${word.status === 'review' ? `
                        <span class="status-switch to-mastered" data-id="${word.id}" data-status="mastered">➔掌握</span>
                      ` : ''}
                      ${word.status === 'new' ? `
                        <span class="status-switch to-review" data-id="${word.id}" data-status="review">➔陌生</span>
                      ` : ''}
                      <span class="status-badge ${word.status}">${
                        word.status === 'mastered' ? '已掌握' : 
                        word.status === 'review' ? '待复习' : '新词'
                      }</span>
                      <div class="word-actions">
                        <button type="button" class="word-action-btn library-speak-btn" data-id="${word.id}" title="发音" aria-label="发音">
                          <svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.74 2.5-2.26 2.5-4.02zM14 3.23v2.06c2.89 1.19 5 3.65 5 6.71s-2.11 5.52-5 6.71v2.06c4.01-1.29 7-4.95 7-9.77s-2.99-8.48-7-9.77z"/></svg>
                        </button>

                    </div>
                  `}
                  </div>
                </div>
            `).join('')}
          </div>
        </div>
      `;
    }
    
    container.innerHTML = html;

    // 渲染完成后同步喇叭按钮的可用状态（语音开关关闭时置灰）
    this.refreshSpeechDependentToggles();

    // 绑定编辑和删除事件
    container.querySelectorAll('.library-speak-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        if (!this.settings.speechEnabled) return;
        e.stopPropagation();
        const id = parseInt(btn.dataset.id, 10);
        const word = this._librarySpeakWordsById.get(id);
        if (word && this.settings.speechEnabled) this.speakWordEntryFront(word);
      });
    });

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

    // 状态转换标签事件
    container.querySelectorAll('.status-switch').forEach(span => {
      span.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = parseInt(span.dataset.id);
        const newStatus = span.dataset.status;
        
        const words = await this.db.getAllWords();
        const word = words.find(w => w.id === id);
        if (word) {
          const oldStatus = word.status;
          word.status = newStatus;
          word.lastStudied = Date.now();
          await this.db.updateWord(word);
          
          // 更新学习页面的状态数据
          if (this.todayWords && this.todayWords.length > 0) {
            const todayWordIndex = this.todayWords.findIndex(w => w.id === id);
            if (todayWordIndex !== -1) {
              this.todayWords[todayWordIndex].status = newStatus;
              
              // 更新统计数据（按词条分类归档今日统计，口径与学习页按钮一致）
              if (oldStatus === 'review' && newStatus === 'mastered') {
                await this.bumpScopeStats(word, 'mastered', 1);
                await this.bumpScopeStats(word, 'review', -1);
              } else if (oldStatus === 'mastered' && newStatus === 'review') {
                await this.bumpScopeStats(word, 'mastered', -1);
                await this.bumpScopeStats(word, 'review', 1);
              } else if (oldStatus === 'new' && newStatus === 'review') {
                // 新词标记为陌生，与学习页"陌生"按钮的统计口径一致
                await this.bumpScopeStats(word, 'review', 1);
              }
              
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
        await this.toggleFavorite(id);
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
    
    document.querySelectorAll('.color-option').forEach(opt => {
      opt.classList.toggle('active', opt.dataset.color === this.settings.cardBgColor);
    });
    
    document.getElementById('soundToggle').classList.toggle('active', this.settings.soundEnabled);
    const speechToggle = document.getElementById('speechToggle');
    if (speechToggle) {
      speechToggle.classList.toggle('active', this.settings.speechEnabled);
    }
    this.refreshSpeechDependentToggles();
    const phoneticReadToggle = document.getElementById('phoneticReadToggle');
    if (phoneticReadToggle) {
      phoneticReadToggle.classList.toggle('active', this.settings.phoneticAutoRead);
    }
    const cardDefinitionFirstToggle = document.getElementById('cardDefinitionFirstToggle');
    if (cardDefinitionFirstToggle) {
      cardDefinitionFirstToggle.classList.toggle('active', this.settings.cardDefinitionFirst);
    }

    const categoryDisplayToggle = document.getElementById('categoryDisplayToggle');
    if (categoryDisplayToggle) {
      categoryDisplayToggle.classList.toggle('active', this.settings.categoryDisplay);
    }

    const dictTypeEl = document.getElementById('dictTypeSelect');
    if (dictTypeEl) dictTypeEl.value = this.settings.dictImportType || 'all';

    const phoneticDelaySelect = document.getElementById('phoneticDelaySelect');
    if (phoneticDelaySelect) phoneticDelaySelect.value = String(this.settings.phoneticDelay);

    const repeatFrequencySelect = document.getElementById('repeatFrequencySelect');
    if (repeatFrequencySelect) repeatFrequencySelect.value = String(this.settings.repeatFrequency);

    this.refreshGoalSliderLockedState();
  }

  /** 设置页“清除进度”：确认后清空今日/累计统计与学习进度，把所有词条状态重置为 new，并刷新界面 */
  async clearProgress() {
    if (confirm('确定要清除所有“已掌握”和“待复习”的记录吗？')) {
      // 清除所有学习相关设置
      await this.db.setSetting('lastStudyDate', null);
      await this.db.setSetting('todayCount', 0);
      await this.db.setSetting('learnProgress', null);
      
      // 清除今日统计和累计统计（含按分类归档的字/短语计数）
      await this.resetScopeStats();
      this.todayStats = { mastered: 0, review: 0, total: 0 };
      this.totalStats = { mastered: 0, review: 0 };
      await this.db.setSetting('todayStats', this.todayStats);
      await this.db.setSetting('totalStats', this.totalStats);
      
      // 重置学习进度（进度条归零）
      this.currentCardIndex = 0;
      this._learnSessionSnapshot = null;
      
      // 更新进度条UI
      if (document.getElementById('progressFill')) {
        document.getElementById('progressFill').style.width = '0%';
      }
      if (document.getElementById('progressText')) {
        document.getElementById('progressText').textContent = `0/${this.settings.dailyGoal}`;
      }
      
      // 更新统计显示UI
      if (document.getElementById('statMastered')) {
        document.getElementById('statMastered').textContent = '0';
      }
      if (document.getElementById('statReview')) {
        document.getElementById('statReview').textContent = '0';
      }
      if (document.getElementById('totalMastered')) {
        document.getElementById('totalMastered').textContent = '0';
      }
      if (document.getElementById('totalReview')) {
        document.getElementById('totalReview').textContent = '0';
      }
      
      // 更新今日单词列表为空
      this.todayWords = [];
      
      // 重置所有单词的状态为 new
      const allWords = await this.db.getAllWords();
      for (const word of allWords) {
        if (word.status !== 'new') {
          word.status = 'new';
          await this.db.updateWord(word);
        }
      }

      // 所有状态已重置，刷新缓存使累计统计归零
      await this.refreshStatusCounts();

      this.refreshGoalSliderLockedState();

      this.showToast('所有学习记录已清除');
      
      if (this.currentPage === 'learn') {
        // 显示空状态
        this.showEmptyState();
      }
      
      // 如果当前在词库页面，刷新列表
      if (this.currentPage === 'library') {
        await this.renderLibrary();
      }
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

