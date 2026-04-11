const CACHE_NAME = 'mva-bellijst-v1';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

// Push notificatie ontvangen
self.addEventListener('push', e => {
  const data = e.data?.json() || {};
  const title = data.title || 'MVA Bellijst';
  const options = {
    body: data.body || 'Bezichtiging feedback vereist',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    data: { url: data.url || '/' },
    actions: [
      { action: 'open', title: '📋 Open app' },
      { action: 'dismiss', title: 'Later' }
    ]
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

// Klik op notificatie
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(e.notification.data?.url || '/');
    })
  );
});
