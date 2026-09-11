// 固定的运行时缓存名。代码和词典请求会始终先取网络并覆盖缓存，
// 因此发布新版本时不需要手动修改缓存版本。
const CACHE_NAME = 'vocab-app-runtime-v2';
const DATA_CACHE_NAME = 'vocab-data-runtime-v2';

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
        return Promise.all(
          urlsToCache.map(url =>
            fetch(url, { cache: 'reload' }).then(response => {
              if (!response.ok) throw new Error(`Failed to cache ${url}`);
              return cache.put(url, response);
            })
          )
        );
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
          const isManagedCache =
            cacheName.startsWith('vocab-app-') || cacheName.startsWith('vocab-data-');
          if (
            isManagedCache &&
            cacheName !== CACHE_NAME &&
            cacheName !== DATA_CACHE_NAME
          ) {
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
  const isSameOrigin = url.origin === self.location.origin;

  if (request.method !== 'GET' || !isSameOrigin) {
    return;
  }

  /** 网络优先：成功后用最新响应覆盖缓存，离线时回退到缓存。 */
  const networkFirst = (cacheName, fallbackUrl) => {
    event.respondWith(
      fetch(request, { cache: 'no-cache' })
        .then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            const responseToCache = networkResponse.clone();
            caches.open(cacheName).then(cache => cache.put(request, responseToCache));
          }
          return networkResponse;
        })
        .catch(async () => {
          const cachedResponse = await caches.match(request);
          if (cachedResponse) return cachedResponse;
          if (fallbackUrl) {
            const fallbackResponse = await caches.match(fallbackUrl);
            if (fallbackResponse) return fallbackResponse;
          }
          return Response.error();
        })
    );
  };

  // 导航请求：网络优先，离线时回退到缓存的 index.html
  if (request.mode === 'navigate') {
    networkFirst(CACHE_NAME, './index.html');
    return;
  }

  // HTML/CSS/JS 与词典：网络优先，普通刷新即可拿到最新版本
  const isCodeAsset = /\.(?:html|css|js)(?:$|\?)/.test(url.pathname);
  const isDictionary = /\/dict\.xlsx$/i.test(url.pathname);
  if (isCodeAsset || isDictionary) {
    networkFirst(isDictionary ? DATA_CACHE_NAME : CACHE_NAME);
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
