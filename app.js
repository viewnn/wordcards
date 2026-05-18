// ==================== IndexedDB 数据库操作 ====================
class VocabDB {
  constructor() {
    this.dbName = 'VocabAppDB';
    this.version = 3;
    this.db = null;
  }
  
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

  // 词汇操作
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

  async updateWord(word) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['words'], 'readwrite');
      const store = transaction.objectStore('words');
      const request = store.put(word);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getAllWords() {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['words'], 'readonly');
      const store = transaction.objectStore('words');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

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

  async clearAllWords() {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['words'], 'readwrite');
      const store = transaction.objectStore('words');
      const request = store.clear();
      
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // 设置操作
  async getSetting(key, defaultValue = null) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['settings'], 'readonly');
      const store = transaction.objectStore('settings');
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result ? request.result.value : defaultValue);
      request.onerror = () => reject(request.error);
    });
  }

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

// ==================== 主应用类 ====================
class VocabApp {
  constructor() {
    this.db = new VocabDB();
    this.currentPage = 'learn';
    this.currentCardIndex = 0;
    this.todayWords = [];
    this.isFlipped = false;
    this.settings = {
      dailyGoal: 50,
      cardBgColor: '#E8F5E9',
      fontSize: 'medium',
      soundEnabled: false,
      phoneticAutoRead: false,
      /** 默认先展示释义面；点击后翻到词汇面 */
      cardDefinitionFirst: false,
      learnMode: 'sequential',
      /** 音标渐显延迟（秒），0表示立即显示 */
      phoneticDelay: 0,
      /** 单词重复出现频率（天），0表示每日目标内不重复 */
      repeatFrequency: 0,
      /** 词典导入范围：all / phrase / word，与设置页下拉同步 */
      dictImportType: 'phrase'
    };
    this.todayStats = {
      mastered: 0,
      review: 0,
      total: 0
    };
    this.totalStats = {
      mastered: 0,
      review: 0
    };
    this.searchQuery = '';
    this.filterStatus = 'all';
    /** 触摸翻面后浏览器会合成 click，需忽略下一次点击避免立刻翻回正面 */
    this._suppressNextCardClickFlip = false;
    this._phoneticReadTimer = null;
    /** 词库列表当前展示的词条 id → 对象，避免点击喇叭时 await IndexedDB 导致用户手势失效而无法发声 */
    this._librarySpeakWordsById = new Map();
    /** 离开学习页时保存的会话快照，用于返回学习页时恢复进度条与队列（不可仅用 switchPage 局部变量） */
    this._learnSessionSnapshot = null;
  }

  async init() {
    try {
      this.measureScrollbarWidth();
      await this.db.init();
      await this.loadSettings();
      await this.loadTodayStats();
      const dictTypeSelectInit = document.getElementById('dictTypeSelect');
      if (dictTypeSelectInit) {
        dictTypeSelectInit.value = this.settings.dictImportType || 'phrase';
      }
      this.initServiceWorker();
      this.bindEvents();
      this.primeSpeechSynthesis();
      this.render();
      
      // 尝试自动加载 dict.xlsx 文件（每次启动都检查）
      await this.autoLoadDict();
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
    if (this.currentPage === 'library') {
      await this.renderLibrary();
    }
  }

  // 自动加载 dict.xlsx 文件
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
      
      // 获取当前选择的词典类型
      const dictTypeSelect = document.getElementById('dictTypeSelect');
      const dictType = dictTypeSelect?.value || 'all';
      
      let allWords = [];

      // 根据词典类型选择要导入的 sheet
      if (dictType === 'all') {
        for (const sheetName of workbook.SheetNames) {
          const worksheet = workbook.Sheets[sheetName];
          const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
          const words = this.parseExcel(jsonData);
          if (Array.isArray(words) && words.length > 0) {
            allWords = allWords.concat(words);
          }
        }
      } else if (dictType === 'phrase') {
        const sheetName = workbook.SheetNames.find(name => name.toLowerCase().includes('phrase')) || workbook.SheetNames[1];
        if (sheetName) {
          const worksheet = workbook.Sheets[sheetName];
          const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
          allWords = this.parseExcel(jsonData);
        }
      } else if (dictType === 'word') {
        const sheetName = workbook.SheetNames.find(name => name.toLowerCase().includes('word')) || workbook.SheetNames[0];
        if (sheetName) {
          const worksheet = workbook.Sheets[sheetName];
          const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
          allWords = this.parseExcel(jsonData);
        }
      }
      
      if (!Array.isArray(allWords) || allWords.length === 0) {
        console.log('dict.xlsx 文件内容为空或格式错误');
        await this.refreshLibraryFiltersAfterDictChange();
        return;
      }
      
      // 获取已存在的单词用于去重
      const existingWords = await this.db.getAllWords();
      const existingWordSet = new Set(existingWords.map(w => w.word.toLowerCase()));
      
      // 过滤掉已存在的单词
      const newWords = allWords.filter(w => !existingWordSet.has(w.word.toLowerCase()));
      
      if (newWords.length === 0) {
        console.log('dict.xlsx 中没有新单词');
        await this.refreshLibraryFiltersAfterDictChange();
        return;
      }
      
      await this.db.batchAddWords(newWords);
      this.showToast(`已自动导入 ${newWords.length} 个新单词`);

      await this.refreshLibraryFiltersAfterDictChange();
      
      // 如果当前在学习页面，刷新学习会话
      if (this.currentPage === 'learn') {
        this.prepareLearnSession();
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

  // 初始化 Service Worker
  initServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js')
        .then(reg => console.log('Service Worker registered'))
        .catch(err => console.log('Service Worker registration failed:', err));
    }
  }

  // 加载设置
  async loadSettings() {
    this.settings.dailyGoal = await this.db.getSetting('dailyGoal', 50);
    this.settings.cardBgColor = await this.db.getSetting('cardBgColor', '#E8F5E9');
    this.settings.fontSize = await this.db.getSetting('fontSize', 'medium');
    this.settings.soundEnabled = await this.db.getSetting('soundEnabled', false);
    this.settings.phoneticAutoRead = await this.db.getSetting('phoneticAutoRead', false);
    this.settings.cardDefinitionFirst = await this.db.getSetting('cardDefinitionFirst', false);
    this.settings.learnMode = await this.db.getSetting('learnMode', 'sequential');
    this.settings.phoneticDelay = await this.db.getSetting('phoneticDelay', 0);
    this.settings.repeatFrequency = await this.db.getSetting('repeatFrequency', 0);
    this.settings.dictImportType = await this.db.getSetting('dictImportType', 'phrase');
  }

  // 加载今日统计和累计统计
  async loadTodayStats() {
    // 加载累计统计数据
    this.totalStats = await this.db.getSetting('totalStats', { mastered: 0, review: 0 });
    
    const today = new Date().toDateString();
    const savedDate = await this.db.getSetting('statsDate', '');
    
    if (savedDate !== today) {
      // 新的一天，先将昨日的统计累加到累计统计中
      const yesterdayStats = await this.db.getSetting('todayStats', { mastered: 0, review: 0, total: 0 });
      this.totalStats.mastered += yesterdayStats.mastered;
      this.totalStats.review += yesterdayStats.review;
      await this.db.setSetting('totalStats', this.totalStats);
      
      // 重置今日统计
      this.todayStats = { mastered: 0, review: 0, total: 0 };
      await this.db.setSetting('statsDate', today);
      await this.db.setSetting('todayStats', this.todayStats);
    } else {
      this.todayStats = await this.db.getSetting('todayStats', { mastered: 0, review: 0, total: 0 });
    }
  }


  // 绑定事件
  bindEvents() {
    const self = this;
    
    // 导航切换
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', handleNavClick);
      item.addEventListener('touchstart', handleNavClick);
    });
    
    function handleNavClick(e) {
      e.preventDefault();
      // 使用 closest 确保获取到正确的 nav-item 元素
      const navItem = e.target.closest('.nav-item');
      if (navItem) {
        const page = navItem.dataset.page;
        self.switchPage(page);
      }
    }

    // 导入按钮
    const importBtn = document.getElementById('importBtn');
    importBtn.addEventListener('click', () => self.showImportModal());
    importBtn.addEventListener('touchstart', (e) => { e.preventDefault(); self.showImportModal(); });
    
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
    
    // 导入确认
    const confirmImportBtn = document.getElementById('confirmImportBtn');
    confirmImportBtn.addEventListener('click', () => self.confirmImport());
    confirmImportBtn.addEventListener('touchstart', (e) => { e.preventDefault(); self.confirmImport(); });
    
    // 文件选择
    document.getElementById('importFile').addEventListener('change', (e) => self.handleFileSelect(e));
    
    // 导入拖拽
    const importZone = document.getElementById('importZone');
    importZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      importZone.classList.add('dragover');
    });
    importZone.addEventListener('dragleave', () => {
      importZone.classList.remove('dragover');
    });
    importZone.addEventListener('drop', (e) => {
      e.preventDefault();
      importZone.classList.remove('dragover');
      if (e.dataTransfer.files.length) {
        self.handleFileSelect({ target: { files: e.dataTransfer.files } });
      }
    });

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
  
  // 词库页面事件绑定
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
    
    const label = document.getElementById('categoryLabel');
    if (this.selectedCategories.length === 0) {
      label.textContent = '选择分类';
    } else if (this.selectedCategories.length === 1) {
      label.textContent = this.selectedCategories[0];
    } else {
      label.textContent = `全部`;
    }
    
    this.resetPageNum();
    this.renderLibrary();
  }
  
  // 渲染分类选项（仅词条自身的分类列，词典短语/字不设单独勾选项）
  async renderCategoryOptions() {
    const words = await this.db.getAllWords();
    const categories = [...new Set(words.map((w) => w.category || '未分类'))];
    const container = document.getElementById('categoryOptions');

    const allLabel = document.getElementById('category-all-label');
    if (allLabel) {
      allLabel.textContent = `全部 (${categories.length})`;
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

  /** 词典导入后：分类下拉勾选全部真实分类（等同于「全部」），列表展示当前库全部词条 */
  async syncLibraryCategoryFilterToDictType() {
    const words = await this.db.getAllWords();
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

  // 设置事件绑定
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
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => {
        setTimeout(() => {
          if (self.currentPage === 'settings') {
            updateGoalSliderState();
          }
        }, 100);
      });
    });

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
    const soundToggle = document.getElementById('soundToggle');
    soundToggle.addEventListener('click', handleSoundToggle);
    soundToggle.addEventListener('touchstart', handleSoundToggle);
    
    async function handleSoundToggle(e) {
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
        self.settings.dictImportType = dictTypeSelect.value;
        await self.db.setSetting('dictImportType', self.settings.dictImportType);
        await self.db.clearAllWords();
        // 进入词库时应用「全部」筛选；导入完成后立即切换筛选状态
        self.filterStatus = 'all';
        // 词典切换后词库已重建，清除学习会话缓存，避免返回学习页时恢复旧队列
        await self.db.setSetting('learnProgress', null);
        self._learnSessionSnapshot = null;
        self.currentCardIndex = 0;
        self.todayStats = { mastered: 0, review: 0, total: 0 };
        await self.db.setSetting('todayStats', self.todayStats);
        await self.autoLoadDict();

        if (self.currentPage === 'library') {
          await self.renderLibrary();
        }

        await self.prepareLearnSession();

        self.showToast('词典已更新');
      });
    }

    updateGoalSliderState();
  }

  // 应用设置
  applySettings() {
    const flashcard = document.getElementById('flashcard');
    if (flashcard) {
      flashcard.style.background = this.settings.cardBgColor;
    }

    const fontSizes = { small: '14px', medium: '16px', large: '20px' };
    document.documentElement.style.setProperty('--font-size-md', fontSizes[this.settings.fontSize] || '16px');
  }

  // 初始化卡片滑动
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

  // 切换页面
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

  // 渲染页面
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

  // 准备学习会话
  async prepareLearnSession() {
    this.cancelScheduledPhoneticRead();
    this._learnSessionSnapshot = null;

    // 尝试加载之前保存的学习进度
    const savedProgress = await this.loadLearnProgress();
    
    // 只有在保存的队列长度与当前每日目标匹配时才恢复进度
    const shouldRestoreProgress = savedProgress && 
                                  savedProgress.todayWords && 
                                  savedProgress.todayWords.length === this.settings.dailyGoal &&
                                  this.currentCardIndex === 0;
    
    if (shouldRestoreProgress) {
      // 恢复之前的学习进度
      this.todayWords = savedProgress.todayWords;
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

    const allWords = await this.db.getAllWords();
    
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
    
    this.updateProgress();
    this.refreshGoalSliderLockedState();
  }

  // 显示卡片
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
    const category = word.category || '';
    const categoryHtml = category
      ? `<span class="language-badge category-badge">${this.escapeHtml(category)}</span>`
      : '';
    
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
  }

  // 翻转卡片
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

  escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  resolveImportHeaderKey(cell) {
    const raw = String(cell ?? '').trim();
    if (!raw) return null;
    const lowerAscii = /^[\x00-\x7f]+$/.test(raw) ? raw.toLowerCase() : raw;
    const pairs = [
      ['word', ['word', '词汇']],
      ['meaning', ['meaning', '释义']],
      ['phonetic', ['phonetic', '音标']],
      ['example', ['example', '例句']],
      ['category', ['category', '分类']],
      ['language', ['language', '语言']],
    ];
    for (const [key, aliases] of pairs) {
      for (const a of aliases) {
        const na = /^[\x00-\x7f]+$/.test(a) ? a.toLowerCase() : a;
        if (lowerAscii === na || raw === a) return key;
      }
    }
    return null;
  }

  buildImportColumnMap(headerCells) {
    const colMap = {};
    headerCells.forEach((cell, idx) => {
      const key = this.resolveImportHeaderKey(cell);
      if (key) colMap[key] = idx;
    });
    return colMap.word !== undefined ? colMap : null;
  }

  /** 无 recognized 表头时使用的历史列下标 */
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

  parseCSVLine(line) {
    const out = [];
    let cur = '';
    let i = 0;
    let inQ = false;
    while (i < line.length) {
      const c = line[i];
      if (inQ) {
        if (c === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i += 2;
            continue;
          }
          inQ = false;
          i++;
          continue;
        }
        cur += c;
        i++;
        continue;
      }
      if (c === '"') {
        inQ = true;
        i++;
        continue;
      }
      if (c === ',') {
        out.push(cur.trim());
        cur = '';
        i++;
        continue;
      }
      cur += c;
      i++;
    }
    out.push(cur.trim());
    return out;
  }

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

  // 发音功能
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
    this.todayStats.review++;
    await this.db.setSetting('todayStats', this.todayStats);
    
    // 保存学习进度
    await this.saveLearnProgress();
    
    //this.showToast('已标记为需复习');// 请勿删除该注释
    this.nextCard();
  }

  // 跳过卡片
  skipCard() {
    // 将当前卡片移到队列末尾
    const skipped = this.todayWords.splice(this.currentCardIndex, 1)[0];
    skipped.lastStudied = Date.now(); // 记录学习时间
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
    this.todayStats.mastered++;
    await this.db.setSetting('todayStats', this.todayStats);
    
    // 保存学习进度
    await this.saveLearnProgress();
    
    // this.showToast('太棒了！已掌握'); // 请勿删除该注释
    this.nextCard();
  }

  // 下一张卡片
  nextCard() {
    this.currentCardIndex++;
    if (this.currentCardIndex >= this.todayWords.length) {
      this.showComplete();
    } else {
      const card = document.getElementById('flashcard');
      card.style.transform = 'translateX(100%) rotate(15deg)';
      setTimeout(() => {
        card.style.transition = 'none';
        card.style.transform = 'translateX(-100%) rotate(-15deg)';
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
    
    document.getElementById('statMastered').textContent = this.todayStats.mastered;
    document.getElementById('statReview').textContent = this.todayStats.review;
    
    // 更新累计统计显示
    document.getElementById('totalMastered').textContent = this.totalStats.mastered + this.todayStats.mastered;
    document.getElementById('totalReview').textContent = this.totalStats.review + this.todayStats.review;
    
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
  }
  
  // 处理统计数字点击
  handleStatClick(filter) {
    const count = filter === 'mastered' ? this.todayStats.mastered : this.todayStats.review;
    if (count >= 1) {
      this.filterStatus = filter;
      this.switchPage('library');
    }
  }

  // 累计统计点击处理
  handleTotalStatClick(filter) {
    const count = filter === 'mastered' 
      ? this.totalStats.mastered + this.todayStats.mastered 
      : this.totalStats.review + this.todayStats.review;
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
    // 更新筛选按钮状态
    document.querySelectorAll('.filter-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.filter === this.filterStatus);
    });
    
    let words = await this.db.getAllWords();
    
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
    
    // 应用搜索
    if (this.searchQuery) {
      const q = this.searchQuery;
      words = words.filter(w => {
        const mean = (w.definition || w.meaning || '').toLowerCase();
        return w.word.toLowerCase().includes(q) || mean.includes(q);
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
          <p class="empty-desc">点击上方按钮导入词库开始学习</p>
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
                      <span class="status-badge ${word.status}">${
                        word.status === 'mastered' ? '已掌握' : 
                        word.status === 'review' ? '待复习' : '新词'
                      }</span>
                      <div class="word-actions">
                        <button type="button" class="word-action-btn library-speak-btn" data-id="${word.id}" title="发音" aria-label="发音">
                          <svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.74 2.5-2.26 2.5-4.02zM14 3.23v2.06c2.89 1.19 5 3.65 5 6.71s-2.11 5.52-5 6.71v2.06c4.01-1.29 7-4.95 7-9.77s-2.99-8.48-7-9.77z"/></svg>
                        </button>
                        <button type="button" class="word-action-btn view-btn" data-id="${word.id}">
                          <svg viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
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

    // 绑定编辑和删除事件
    container.querySelectorAll('.library-speak-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id, 10);
        const word = this._librarySpeakWordsById.get(id);
        if (word) this.speakWordEntryFront(word);
      });
    });

    container.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id);
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
          await this.db.updateWord(word);
          
          // 更新学习页面的状态数据
          if (this.todayWords && this.todayWords.length > 0) {
            const todayWordIndex = this.todayWords.findIndex(w => w.id === id);
            if (todayWordIndex !== -1) {
              this.todayWords[todayWordIndex].status = newStatus;
              
              // 更新统计数据
              if (oldStatus === 'review' && newStatus === 'mastered') {
                this.todayStats.mastered++;
                this.todayStats.review--;
              } else if (oldStatus === 'mastered' && newStatus === 'review') {
                this.todayStats.mastered--;
                this.todayStats.review++;
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

  // 查看单词
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
    const phoneticReadToggle = document.getElementById('phoneticReadToggle');
    if (phoneticReadToggle) {
      phoneticReadToggle.classList.toggle('active', this.settings.phoneticAutoRead);
    }
    const cardDefinitionFirstToggle = document.getElementById('cardDefinitionFirstToggle');
    if (cardDefinitionFirstToggle) {
      cardDefinitionFirstToggle.classList.toggle('active', this.settings.cardDefinitionFirst);
    }

    const dictTypeEl = document.getElementById('dictTypeSelect');
    if (dictTypeEl) dictTypeEl.value = this.settings.dictImportType || 'phrase';

    const phoneticDelaySelect = document.getElementById('phoneticDelaySelect');
    if (phoneticDelaySelect) phoneticDelaySelect.value = String(this.settings.phoneticDelay);

    const repeatFrequencySelect = document.getElementById('repeatFrequencySelect');
    if (repeatFrequencySelect) repeatFrequencySelect.value = String(this.settings.repeatFrequency);

    this.refreshGoalSliderLockedState();
  }

  // 清除学习进度
  async clearProgress() {
    if (confirm('确定要清除所有“已掌握”和“待复习”的记录吗？')) {
      // 清除所有学习相关设置
      await this.db.setSetting('lastStudyDate', null);
      await this.db.setSetting('todayCount', 0);
      await this.db.setSetting('learnProgress', null);
      
      // 清除今日统计和累计统计
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

  // ==================== 模态框 ====================
  showImportModal() {
    document.getElementById('importModal').classList.add('active');
    document.getElementById('importPreview').innerHTML = '';
    this.importedWords = [];
  }

  closeModals() {
    document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('active'));
    
    // 重置表单状态
    const inputs = document.querySelectorAll('#wordForm input, #wordForm textarea');
    inputs.forEach(input => input.disabled = false);
    
    // 显示保存按钮
    document.getElementById('saveWordBtn').style.display = '';
  }

  // 保存单词
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
        await this.db.updateWord(word);
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

  // 处理文件选择
  handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;

    const fileName = file.name.toLowerCase();
    
    if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
      // 处理Excel文件
      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const data = new Uint8Array(event.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          const worksheet = workbook.Sheets[workbook.SheetNames[0]];
          const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
          
          const words = this.parseExcel(jsonData);
          if (!Array.isArray(words)) {
            this.showToast('文件格式错误');
            return;
          }

          this.importedWords = words;
          this.showImportPreview(words);
        } catch (error) {
          this.showToast('Excel文件解析失败');
          console.error(error);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      // 处理JSON和CSV文件
      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const content = event.target.result;
          let words = [];

          if (fileName.endsWith('.json')) {
            const parsed = JSON.parse(content);
            const arr = Array.isArray(parsed) ? parsed : (parsed.words || []);
            if (!Array.isArray(arr)) {
              this.showToast('JSON 格式错误：应为词汇数组');
              return;
            }
            words = arr.map((item) => this.normalizeImportedWord(item));
          } else if (fileName.endsWith('.csv')) {
            words = this.parseCSV(content);
          } else {
            this.showToast('请选择 JSON、CSV、XLSX 或 XLS 文件');
            return;
          }

          if (!Array.isArray(words)) {
            this.showToast('文件格式错误');
            return;
          }

          this.importedWords = words;
          this.showImportPreview(words);
        } catch (error) {
          this.showToast('文件解析失败');
          console.error(error);
        }
      };
      reader.readAsText(file);
    }
  }

  // 解析Excel数据（首行为表头，列名规则与 parseCSV / resolveImportHeaderKey 一致）
  parseExcel(data) {
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
          cantoneseExample: get('cantoneseExample')
        })
      );
    }
    return words;
  }

  // 解析 CSV（首行为表头，与 Excel 一致）
  parseCSV(content) {
    const lines = content.trim().split(/\r?\n/).filter((l) => l.length);
    if (lines.length < 2) return [];

    const headerParts = this.parseCSVLine(lines[0]);
    let colMap = this.buildImportColumnMap(headerParts);
    if (!colMap) colMap = this.getLegacyImportColumnMap();

    const words = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = this.parseCSVLine(lines[i]);
      const get = (key) => {
        const idx = colMap[key];
        if (idx === undefined || idx === null) return '';
        return String(parts[idx] ?? '').trim();
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
          cantoneseExample: get('cantoneseExample')
        })
      );
    }

    return words;
  }

  // 显示导入预览
  showImportPreview(words) {
    const preview = document.getElementById('importPreview');
    preview.innerHTML = `
      <p style="margin-bottom: 12px; color: var(--text-secondary);">
        共 ${words.length} 条数据，确认导入？
      </p>
    `;
  }

  // 确认导入
  async confirmImport() {
    if (!this.importedWords || this.importedWords.length === 0) {
      this.showToast('请先选择文件');
      return;
    }

    // 获取导入模式
    const importMode = document.querySelector('input[name="importMode"]:checked')?.value || 'append';
    
    if (importMode === 'overwrite') {
      // 覆盖模式：先清空词库
      await this.db.clearAllWords();
    }

    const count = await this.db.batchAddWords(this.importedWords);
    this.showToast(`成功导入 ${count} 个单词`);
    this.closeModals();
    
    if (this.currentPage === 'library') {
      this.renderLibrary();
      this.renderCategoryOptions();
    }
    if (this.currentPage === 'learn') {
      this.prepareLearnSession();
    }
  }

  // Toast 提示
  showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
  }
}

// ==================== 启动应用 ====================
document.addEventListener('DOMContentLoaded', () => {
  window.app = new VocabApp();
  window.app.init();
});
