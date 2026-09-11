// ==================== 部署更新说明 ====================
// 每次推送新版本到 GitHub Pages 前，请将下方 CACHE_NAME
// 的数字加 1（例如 v4 → v5），浏览器会自动检测 SW 更新、
// 删除旧缓存并加载最新文件。不需要额外操作。
// ====================================================
const CACHE_NAME = 'vocab-app-v1.4.2026.09.11.05';
const DATA_CACHE_NAME = 'vocab-data-v1.4.2026.09.11.05';

// 使用相对路径，避免部署在子目录时缓存失效
const urlsToCache = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// 安装 Service Worker
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
      .then(() => self.skipWaiting())
  );
});

// 激活并清理旧缓存
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME && cacheName !== DATA_CACHE_NAME) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 拦截网络请求
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  // 导航请求：网络优先，离线时回退到缓存的 index.html
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // HTML/CSS/JS 等代码文件：网络优先，确保代码改动立即生效；离线时回退缓存
  const isCodeAsset = /\.(?:html|css|js)(?:$|\?)/.test(url.pathname);
  if (isCodeAsset) {
    event.respondWith(
      fetch(request).then(networkResponse => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, responseToCache));
        return networkResponse;
      }).catch(() => caches.match(request))
    );
    return;
  }

  // 图片/图标/manifest 等：缓存优先（这些文件极少变化）
  event.respondWith(
    caches.match(request)
      .then(response => {
        if (response) {
          return response;
        }
        return fetch(request).then(networkResponse => {
          if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
            return networkResponse;
          }
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, responseToCache));
          return networkResponse;
        });
      })
      .catch(() => {
        if (request.headers.get('accept') && request.headers.get('accept').includes('text/html')) {
          return caches.match('./index.html');
        }
      })
  );
});

// 监听消息事件
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
