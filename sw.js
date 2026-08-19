/**
 * Service worker de BiciFastness.
 *
 * La version anterior tenia un fallo grave de cache: interceptaba TODAS las
 * peticiones con estrategia cache-first (`caches.match(...) || fetch(...)`),
 * incluidas las de Firestore y las llamadas a las Cloud Functions. Eso
 * significaba servir rankings caducados indefinidamente y, peor aun, dejar
 * respuestas con datos de sesion guardadas en una cache compartida del origen.
 *
 * Ahora solo se cachean los recursos estaticos propios, y todo lo demas va
 * directo a la red.
 */

const CACHE = 'bicifastness-v3';

const ESTATICOS = [
  '/',
  '/assets/css/app.css',
  '/assets/js/firebase.js',
  '/assets/js/dom.js',
  '/assets/js/ui.js',
  '/assets/data/estaciones.js',
  '/images/logo.png',
];

self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches.open(CACHE)
      // addAll falla entero si un solo recurso falla; con allSettled la
      // instalacion no se cae porque un fichero no este todavia publicado.
      .then((cache) => Promise.allSettled(ESTATICOS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches.keys()
      .then((nombres) => Promise.all(
        nombres.filter((n) => n !== CACHE).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (evento) => {
  const peticion = evento.request;
  const url = new URL(peticion.url);

  // Solo GET del propio origen. Nunca datos, nunca terceros, nunca autenticado.
  if (peticion.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (peticion.credentials === 'include') return;

  const esEstatico = /\.(css|js|png|jpg|jpeg|svg|webp|woff2?|json|geojson|mp3)$/i.test(url.pathname);
  if (!esEstatico) return;

  // Stale-while-revalidate: responde rapido y actualiza por detras.
  evento.respondWith(
    caches.match(peticion).then((cacheada) => {
      const red = fetch(peticion).then((respuesta) => {
        if (respuesta.ok && respuesta.type === 'basic') {
          const copia = respuesta.clone();
          caches.open(CACHE).then((cache) => cache.put(peticion, copia));
        }
        return respuesta;
      }).catch(() => cacheada);

      return cacheada || red;
    })
  );
});
