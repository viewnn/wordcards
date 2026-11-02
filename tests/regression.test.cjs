// 无第三方依赖：node --test tests/regression.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');

test('重复频率覆盖零天、三天边界、旧记录及待学数量', () => {
  const context = vm.createContext({ window: {}, document: { addEventListener() {} }, console });
  vm.runInContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), context);
  const app = vm.runInContext('Object.create(VocabApp.prototype)', context);
  const now = 1800000000000;
  app.settings = { repeatFrequency: 3, studyScope: 'all' };
  app.nowMs = () => now;
  app.dictKeyOf = word => word.word;
  app._scopePassDone = { all: new Set(['done']) };
  assert.equal(app.normalizeRepeatFrequency(undefined), 3);
  assert.equal(app.normalizeRepeatFrequency(null), 3);
  assert.equal(app.normalizeRepeatFrequency(9), 3);
  assert.equal(app.normalizeRepeatFrequency('0'), 0);
  assert.equal(app.isWordOutsideRepeatWindow({}), true);
  assert.equal(app.isWordOutsideRepeatWindow({ lastStudied: 'invalid' }), true);
  assert.equal(app.isWordOutsideRepeatWindow({ lastStudied: now + 1 }), false);
  assert.equal(app.isWordOutsideRepeatWindow({ lastStudied: now - 3 * 86400000 + 1 }), false);
  assert.equal(app.isWordOutsideRepeatWindow({ lastStudied: now - 3 * 86400000 }), true);
  assert.equal(app.countPendingScopeWords([
    { word: 'new' }, { word: 'recent', lastStudied: now }, { word: 'done' }
  ]), 1);
  app.settings.repeatFrequency = 0;
  assert.equal(app.isWordOutsideRepeatWindow({ lastStudied: now }), true);
});

test('云端切换练习范围时，当前练习页立即重建，其他页面延迟重建', async () => {
  const source = fs.readFileSync(path.join(root, 'cloud-sync.js'), 'utf8');
  const start = source.indexOf('  CloudSyncEngine.prototype.applyRemoteSettings =');
  const end = source.indexOf('\n  /**', start);
  const context = vm.createContext({
    CloudSyncEngine: function () {}, SYNCED_SETTING_KEYS: ['practiceScope'],
    stableStringify: JSON.stringify, console
  });
  vm.runInContext(source.slice(start, end), context);
  const apply = vm.runInContext('CloudSyncEngine.prototype.applyRemoteSettings', context);
  for (const currentPage of ['practice', 'settings']) {
    let rebuilt = 0;
    let refreshed = 0;
    const app = {
      currentPage, _appReady: true, settings: { practiceScope: 'all' },
      db: { async setSetting() {} }, applySettings() {}, renderSettings() {},
      async enterPracticePage() { rebuilt++; this._practiceScopeTotal = 2005; },
      refreshPracticeProgressUI() { refreshed++; }
    };
    await apply.call({ app, meta: {}, async saveMeta() {} }, { practiceScope: 'phrase' });
    assert.equal(rebuilt, currentPage === 'practice' ? 1 : 0);
    assert.equal(refreshed, currentPage === 'practice' ? 0 : 1);
    assert.equal(app._practiceScopeTotal, currentPage === 'practice' ? 2005 : 0);
  }
});

function database() {
  const window = {};
  const context = vm.createContext({ window, document: { addEventListener() {} }, console });
  vm.runInContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), context);
  const db = vm.runInContext('new VocabDB()', context);
  const calls = [];
  const request = { result: 42 };
  const transaction = {
    objectStore() {
      return new Proxy({}, { get: (_, method) => (...args) => {
        calls.push([method, ...args]);
        return request;
      } });
    },
    abort() { this.onabort(); }
  };
  db.db = { transaction: () => transaction };
  return { db, window, calls, transaction, request };
}

test('单条写入只在事务提交后返回 id', async () => {
  const { db, transaction } = database();
  let completed = false;
  const word = { word: 'test' };
  const pending = db.addWord(word).then(id => { completed = true; return id; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(word.status, 'new');
  transaction.oncomplete();
  assert.equal(await pending, 42);
});

test('事务中止拒绝写入且不通知同步模块', async () => {
  const { db, transaction, window } = database();
  let notified = false;
  window.CloudSync = { onSettingWritten() { notified = true; } };
  const pending = db.setSetting('goal', 100);
  transaction.onabort();
  await assert.rejects(pending, /aborted/);
  assert.equal(notified, false);
});

test('设置提交后通知同步，钩子异常不否定本地写入', async () => {
  const { db, transaction, window } = database();
  let notified = false;
  window.CloudSync = { onSettingWritten(key, value) {
    assert.equal(key, 'goal');
    assert.equal(value, 100);
    notified = true;
    throw new Error('sync unavailable');
  } };
  const pending = db.setSetting('goal', 100);
  assert.equal(notified, false);
  transaction.oncomplete();
  await pending;
  assert.equal(notified, true);
});

test('批量写入统一初始化，删除去重并保留合法的零 id', async () => {
  const { db, transaction, calls } = database();
  const words = [{ word: 'a' }, { word: 'b' }];
  const adding = db.batchAddWords(words);
  transaction.oncomplete();
  assert.equal(await adding, 2);
  assert.equal(words[0].createdAt, words[1].createdAt);
  assert.equal(calls.length, 2);
  calls.length = 0;
  const deleting = db.deleteWordsByIds([0, 1, 1, null, undefined]);
  transaction.oncomplete();
  assert.equal(await deleting, 2);
  assert.deepEqual(calls, [['delete', 0], ['delete', 1]]);
  assert.equal(await db.batchAddWords([]), 0);
  assert.equal(await db.deleteWordsByIds([]), 0);
});

test('入队异常主动中止事务，批量事务失败不会返回成功数', async () => {
  const { db, transaction } = database();
  let aborted = false;
  transaction.abort = () => { aborted = true; transaction.onabort(); };
  await assert.rejects(db._transaction('words', 'readwrite', () => {
    throw new Error('invalid data');
  }));
  assert.equal(aborted, true);
  const pending = db.batchAddWords([{ word: 'a' }]);
  transaction.error = new Error('quota exceeded');
  transaction.onabort();
  await assert.rejects(pending, /quota exceeded/);
});

function serviceWorker({ fetch, match = async () => undefined, put = async () => {} }) {
  const handlers = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), {
    self: { location: { origin: 'https://example.com' }, addEventListener(type, fn) { handlers[type] = fn; } },
    caches: { match, open: async () => ({ put }) },
    fetch, URL, Response, console
  });
  return async (pathname, mode = 'cors') => {
    const waits = [];
    let response;
    handlers.fetch({
      request: { url: `https://example.com${pathname}`, method: 'GET', mode, headers: new Headers() },
      waitUntil(promise) { waits.push(promise); },
      respondWith(promise) { response = promise; }
    });
    const result = await response;
    await Promise.all(waits);
    return { result, waits };
  };
}

test('网络响应可用时缓存写入受生命周期保护', async () => {
  let writes = 0;
  const run = serviceWorker({ fetch: async () => new Response('latest'), put: async () => { writes++; } });
  const { result, waits } = await run('/app.js');
  assert.equal(await result.text(), 'latest');
  assert.equal(writes, 1);
  assert.equal(waits.length, 1);
});

test('缓存配额错误不影响网络响应', async () => {
  const run = serviceWorker({ fetch: async () => new Response('latest'), put: async () => { throw new Error('quota'); } });
  assert.equal(await (await run('/app.js')).result.text(), 'latest');
});

test('离线导航返回首页缓存，普通资源无缓存时返回错误响应', async () => {
  const fetch = async () => { throw new Error('offline'); };
  const run = serviceWorker({ fetch, match: async key => key === './index.html' ? new Response('offline home') : undefined });
  assert.equal(await (await run('/route', 'navigate')).result.text(), 'offline home');
  assert.equal((await run('/missing.png')).result.type, 'error');
  assert.equal((await run('/app.js')).result.type, 'error');
});
