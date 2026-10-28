// 서비스 워커: 앱 셸 캐시(네트워크 우선) + 웹 푸시 알림
const CACHE = 'pds-v3';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'store.js', 'data.js', 'config.js', 'manifest.json', 'icon.svg', 'icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});

// 서버(pds-push)가 보낸 알림: { title, body, url, tag }
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || 'PDS 플래너', {
      body: d.body || '', icon: 'icon-192.png', badge: 'icon-192.png', tag: d.tag || undefined,
      data: { url: d.url || './' },
    }),
    // 마지막으로 받은 푸시 기록 (수신 확인용)
    caches.open(CACHE).then(c => c.put('./__last-push', new Response(JSON.stringify({ ...d, at: new Date().toISOString() }), { headers: { 'Content-Type': 'application/json' } }))).catch(() => { }),
  ]));
});
// 알림을 누르면 열려 있는 앱으로 이동(없으면 새 창). url 예: ./?tab=do&date=2026-10-30
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const c = cs.find(x => x.url.startsWith(self.registration.scope));
    if (c) { c.postMessage({ type: 'open', url }); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
