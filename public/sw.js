// Bela Essência – Service Worker v1.2.5
// Estratégia:
//   HTML (index.html)  → Network First (sempre busca atualização)
//   API (/api/*)       → Network Only  (nunca cacheia dados)
//   Assets estáticos   → Cache First   (ícones, manifest)

const CACHE_VERSION = 'bela-essencia-1.9.2';
const STATIC_ASSETS = ['/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

// ── Install: cacheia só assets estáticos ──────────────────────────
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(STATIC_ASSETS))
  );
  // Ativa imediatamente sem esperar tabs antigas fecharem
  self.skipWaiting();
});

// ── Activate: limpa caches antigos ───────────────────────────────
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_VERSION)
          .map(k => {
            console.log('[SW] Removendo cache antigo:', k);
            return caches.delete(k);
          })
      )
    )
  );
  // Assume controle de todas as tabs imediatamente
  self.clients.claim();
});

// ── Fetch: estratégia por tipo de recurso ────────────────────────
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // 1. API → sempre rede, nunca cacheia
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ error: 'Sem conexão com o servidor' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    return;
  }

  // 2. HTML (index.html e rotas SPA) → Network First
  //    Busca da rede; se falhar, usa cache. Garante versão sempre atualizada.
  if (e.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          // Guarda a versão mais recente no cache
          const clone = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request)) // offline fallback
    );
    return;
  }

  // 3. Assets estáticos (ícones, manifest) → Cache First
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put(e.request, clone));
        return res;
      });
    })
  );
});

// ── PUSH NOTIFICATIONS ────────────────────────────────────────────────────────
self.addEventListener('push', (e) => {
  if (!e.data) return;
  let data = {};
  try { data = e.data.json(); } catch { return; }

  const options = {
    body:             data.body || '',
    icon:             '/icons/icon-192.png',
    badge:            '/icons/icon-192.png',
    vibrate:          [200, 100, 200],
    tag:              data.data?.type || 'bela-essencia',
    renotify:         true,
    requireInteraction: true,  // Persiste até o usuário dispensar manualmente
    data:             data.data || {},
  };

  e.waitUntil(
    self.registration.showNotification(data.title || 'Bela Essência', options)
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes(url));
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});
