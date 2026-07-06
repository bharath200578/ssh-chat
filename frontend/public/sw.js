// Service Worker for Call of SSH Background Push Notifications

self.addEventListener('push', (event) => {
  if (!event.data) {
    console.warn('Received push event but no payload was supplied.');
    return;
  }

  try {
    const payload = event.data.json();
    const title = payload.title || 'Call of SSH';
    const options = {
      body: payload.body || 'You received a new secure message.',
      icon: '/avatar-icon.png', // Fallback icon path (browser will handle)
      badge: '/badge-icon.png',
      data: {
        peerId: payload.peerId,
        url: self.location.origin
      },
      tag: payload.peerId || 'generic-notification', // Groups notifications by sender
      renotify: true // Re-vibrate/notify if a new alert comes from the same sender
    };

    event.waitUntil(
      self.registration.showNotification(title, options)
    );
  } catch (err) {
    console.error('Failed to process incoming push payload:', err);
  }
});

self.addEventListener('notificationclick', (event) => {
  const notification = event.notification;
  notification.close(); // Dismiss the notification bubble

  const targetUrl = notification.data?.url || self.location.origin;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // 1. If a tab is already open, focus it
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url.startsWith(targetUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      
      // 2. If no tab is open, launch a new window
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
