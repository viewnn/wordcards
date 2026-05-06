const CACHE_NAME = 'vocab-app-v3';
const DATA_CACHE_NAME = 'vocab-data-v1';

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
  
  // 对于导航请求，优先使用缓存
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html')
        .then(cachedResponse => {
          if (cachedResponse) {
            return cachedResponse;
          }
          return fetch(request);
        })
    );
    return;
  }
  
  // 对于其他请求，使用缓存优先策略
  event.respondWith(
    caches.match(request)
      .then(response => {
        // 返回缓存或网络请求
        if (response) {
          return response;
        }
        
        return fetch(request).then(networkResponse => {
          // 检查是否是有效的响应
          if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
            return networkResponse;
          }
          
          // 克隆响应并缓存
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME)
            .then(cache => {
              cache.put(request, responseToCache);
            });
            
          return networkResponse;
        });
      })
      .catch(() => {
        // 离线时返回适当的替代内容
        if (request.headers.get('accept').includes('text/html')) {
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
