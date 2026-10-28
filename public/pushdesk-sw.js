// PushDesk service worker. Upload this file to the ROOT of your website (https://yoursite.com/pushdesk-sw.js)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data.json(); } catch (_) { d = { title: 'Notification', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Notification', {
    body: d.body || '',
    icon: d.icon || undefined,
    badge: d.icon || undefined,
    image: d.image || undefined,
    data: d
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  event.waitUntil((async () => {
    try { if (d.campaignId && d.server) await fetch(d.server + '/public/click/' + d.campaignId, { method: 'POST', mode: 'no-cors' }); } catch (_) {}
    if (d.url) await self.clients.openWindow(d.url);
  })());
});
