// Service Worker para notificaciones push
const CACHE_NAME = 'bicifastness-v1';

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll([
                '/',
                '/images/logo.png',
                '/sounds/notification.mp3'
            ]);
        })
    );
});

self.addEventListener('push', (event) => {
    const options = {
        body: event.data ? event.data.text() : 'Nuevo viaje pendiente',
        icon: '/images/logo.png',
        badge: '/images/logo.png',
        vibrate: [200, 100, 200],
        data: {
            url: '/admin/'
        },
        actions: [
            {
                action: 'open',
                title: 'Ver Admin'
            },
            {
                action: 'dismiss',
                title: 'Ignorar'
            }
        ]
    };

    event.waitUntil(
        self.registration.showNotification('🚴 Nuevo Viaje Pendiente', options)
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    if (event.action === 'open' || !event.action) {
        event.waitUntil(
            clients.openWindow(event.notification.data.url || '/admin/')
        );
    }
});

self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request)
            .then(response => {
                return response || fetch(event.request);
            })
    );
});