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

const CACHE = 'bicifastness-v5';

// Pagina que se sirve cuando no hay red y la ruta pedida no esta cacheada.
const OFFLINE = '/offline/';

const ESTATICOS = [
  '/',
  OFFLINE,
  '/assets/css/app.css',
  '/assets/js/firebase.js',
  '/assets/js/dom.js',
  '/assets/js/ui.js',
  '/assets/js/instalar.js',
  '/assets/data/estaciones.js',
  '/images/logo.png',
  '/images/icono/icono-192.png',
  '/manifest.webmanifest',
];

/**
 * Paginas cuyo armazon NO se guarda.
 *
 * El armazon de una pagina es HTML estatico y no lleva datos de nadie — los
 * datos llegan despues por Firestore —, pero la administracion no tiene ningun
 * sentido offline y prefiero que no quede ni su esqueleto en una cache del
 * origen.
 */
const SIN_CACHEAR = ['/admin/', '/statssss/'];

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

  // El motor y el modelo del OCR (#8) NO pasan por aqui. Son casi seis megas, y
  // la estrategia de abajo es stale-while-revalidate: responderia rapido, si,
  // pero volveria a bajarselos por detras en cada subida. De su cache se ocupa
  // la cabecera `Cache-Control` que pone Vercel, que es una semana.
  if (url.pathname.startsWith('/assets/ocr/')) return;

  // --- Navegacion: red primero, y si no hay red, algo util ------------------
  // Sin esto, abrir la app sin cobertura daba el error del navegador. Va red
  // primero y no cache primero para que nadie se quede con un armazon viejo
  // despues de un despliegue.
  if (peticion.mode === 'navigate') {
    if (SIN_CACHEAR.some((ruta) => url.pathname.startsWith(ruta))) return;
    evento.respondWith(navegar(peticion));
    return;
  }

  const esEstatico = /\.(css|js|png|jpg|jpeg|svg|webp|woff2?|json|geojson|mp3|webmanifest)$/i.test(url.pathname);
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

/**
 * Responde a una navegacion.
 *
 * Orden: red -> el armazon cacheado de esa misma pagina -> la pagina offline.
 * Lo ultimo es lo que convierte "no hay internet" en algo que se puede leer.
 */
async function navegar(peticion) {
  try {
    const respuesta = await fetch(peticion);
    if (respuesta.ok && respuesta.type === 'basic') {
      const copia = respuesta.clone();
      caches.open(CACHE).then((cache) => cache.put(peticion, copia));
    }
    return respuesta;
  } catch {
    const cache = await caches.open(CACHE);
    return (await cache.match(peticion))
      || (await cache.match(OFFLINE))
      || Response.error();
  }
}
