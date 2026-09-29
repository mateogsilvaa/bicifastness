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

const CACHE = 'bicifastness-v9';

// Pagina que se sirve cuando no hay red y la ruta pedida no esta cacheada.
const OFFLINE = '/offline/';

const ESTATICOS = [
  '/',
  OFFLINE,
  '/assets/css/app.css',
  '/assets/fonts/archivo-latin.woff2',
  '/assets/img/iconos.svg',
  '/assets/js/firebase.js',
  '/assets/js/dom.js',
  '/assets/js/ui.js',
  '/assets/js/instalar.js',
  '/assets/js/dia.js',
  '/assets/js/paginas/offline.js',
  '/assets/data/estaciones.js',
  '/images/icono/icono.svg',
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

  // Fotos -> Compartir -> bicifastness (`share_target` del manifiesto). La
  // imagen llega aqui como un POST que NO va a ningun servidor: se deja en
  // IndexedDB y se abre /subir/, que la recoge y la lee en el movil.
  if (peticion.method === 'POST' && url.origin === self.location.origin
    && url.pathname === '/subir/compartir') {
    evento.respondWith(recibirCompartida(peticion));
    return;
  }

  // Solo GET del propio origen. Nunca datos, nunca terceros, nunca autenticado.
  if (peticion.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (peticion.credentials === 'include') return;

  // El motor y el modelo del OCR (#8) NO pasan por aqui. Son casi seis megas, y
  // la estrategia de abajo es stale-while-revalidate: responderia rapido, si,
  // pero volveria a bajarselos por detras en cada subida. De su cache se ocupa
  // la cache HTTP del navegador.
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

  // Dos estrategias.
  //
  // El CODIGO (js, css) no lleva hash en el nombre, asi que el navegador tiene
  // que comprobar SIEMPRE si hay una version nueva. GitHub Pages lo sirve con
  // diez minutos de cache y no deja cambiarlo: por eso `redPrimero` pide con
  // `cache: 'no-cache'`, que revalida (un 304 si no ha cambiado). Servirlo stale-while-revalidate se
  // saltaba esa decision — respondia con la copia guardada y bajaba la nueva
  // por detras — asi que la primera carga despues de un despliegue mezclaba
  // HTML nuevo, que llega por red, con modulos viejos. Un armazon que importa
  // algo que ya no esta, o al reves, y que se arregla solo al recargar: el peor
  // tipo de fallo, porque no se reproduce cuando vas a mirarlo.
  //
  // Lo DEMAS (imagenes, fuentes, sonidos, datos generados) va con `immutable` a
  // un año: si cambia, cambia de nombre. Ahi la copia guardada nunca esta
  // equivocada y responder al instante es justo lo que se quiere.
  const esCodigo = /\.(css|js)$/i.test(url.pathname);

  // Lo publicado lleva la version en la URL (`?v=…`, lo pone
  // scripts/construir-sitio.js en cada despliegue): esa URL no cambia nunca de
  // contenido, asi que se sirve de la cache sin preguntar. Es lo que hace que
  // volver a abrir la app no espere a la red por cada modulo. Sin version (en
  // local), red primero.
  if (esCodigo && url.searchParams.has('v')) {
    evento.respondWith(cachePrimero(peticion));
    return;
  }

  evento.respondWith(esCodigo ? redPrimero(peticion) : cacheRapido(peticion));
});

/** Cache primero: para URLs con version, que no cambian de contenido. */
async function cachePrimero(peticion) {
  const cacheada = await caches.match(peticion);
  if (cacheada) return cacheada;
  return guardar(peticion, await fetch(peticion));
}

/**
 * Guarda la captura compartida para /subir/.
 *
 * La MISMA base y el mismo almacen que `assets/js/captura-pendiente.js`: un
 * service worker no puede importar los modulos de la pagina, asi que va copiado.
 * Si cambia alli, hay que cambiarlo aqui.
 */
async function recibirCompartida(peticion) {
  try {
    const datos = await peticion.formData();
    const imagenes = datos.getAll('captura').filter((f) => f && /^image\//.test(f.type));
    if (imagenes.length) {
      const bd = await new Promise((resolver, rechazar) => {
        const abrir = indexedDB.open('bf-capturas', 1);
        abrir.onupgradeneeded = () => abrir.result.createObjectStore('pendiente');
        abrir.onsuccess = () => resolver(abrir.result);
        abrir.onerror = () => rechazar(abrir.error);
      });
      await new Promise((resolver, rechazar) => {
        const tx = bd.transaction('pendiente', 'readwrite');
        tx.objectStore('pendiente').put(imagenes, 'actual');
        tx.oncomplete = resolver;
        tx.onerror = () => rechazar(tx.error);
      });
      bd.close();
    }
  } catch (error) {
    // Si no se ha podido guardar, /subir/ se abre igual y se elige a mano.
    console.warn('No se ha podido recibir la captura compartida', error);
  }
  return Response.redirect('/subir/?pendiente=1', 303);
}

/** Guarda una respuesta si vale la pena. */
function guardar(peticion, respuesta) {
  if (!respuesta.ok || respuesta.type !== 'basic') return respuesta;
  const copia = respuesta.clone();
  caches.open(CACHE).then((cache) => cache.put(peticion, copia));
  return respuesta;
}

/**
 * Red primero, cache como red de seguridad.
 *
 * Sin conexion sigue habiendo app: se responde con lo ultimo que se guardo, que
 * es lo que hace que `/offline/` pueda pintar algo en vez de un error.
 */
async function redPrimero(peticion) {
  try {
    // `no-cache` = preguntar siempre al servidor, aunque la cache HTTP diga que
    // la copia vale diez minutos mas (GitHub Pages).
    return guardar(peticion, await fetch(peticion, { cache: 'no-cache' }));
  } catch (error) {
    const cacheada = await caches.match(peticion);
    if (cacheada) return cacheada;
    throw error;
  }
}

/** Stale-while-revalidate: responde ya y actualiza por detras. */
function cacheRapido(peticion) {
  return caches.match(peticion).then((cacheada) => {
    const red = fetch(peticion)
      .then((respuesta) => guardar(peticion, respuesta))
      .catch(() => cacheada);

    return cacheada || red;
  });
}

/**
 * Responde a una navegacion.
 *
 * Orden: red -> el armazon cacheado de esa misma pagina -> la pagina offline.
 * Lo ultimo es lo que convierte "no hay internet" en algo que se puede leer.
 */
async function navegar(peticion) {
  try {
    // Igual que el codigo: el HTML nuevo, no el de hace diez minutos.
    const respuesta = await fetch(peticion, { cache: 'no-cache' });
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

// --- Avisos push (#33) ---------------------------------------------------------

/**
 * Un aviso que llega.
 *
 * `userVisibleOnly: true` obliga a enseñar SIEMPRE algo: si este manejador no
 * muestra notificacion, el navegador enseña una generica ("Este sitio se ha
 * actualizado en segundo plano") y, si se repite, revoca el permiso.
 */
self.addEventListener('push', (evento) => {
  let datos = {};
  try {
    datos = evento.data ? evento.data.json() : {};
  } catch {
    // Un aviso con carga ilegible no puede quedarse sin enseñar nada, por lo de
    // arriba: se enseña el texto por defecto.
  }

  const titulo = datos.titulo || 'BiciFastness';

  evento.waitUntil(self.registration.showNotification(titulo, {
    body: datos.cuerpo || '',
    icon: '/images/icono/icono-192.png',
    // El icono pequeño monocromo de la barra de estado en Android.
    badge: '/images/icono/insignia-96.png',
    // Agrupa por tipo: dos avisos de racha el mismo dia se sustituyen en vez de
    // apilarse. Sin esto, volver tras un rato es encontrarse ocho.
    tag: datos.tipo || 'general',
    renotify: false,
    data: { url: datos.url || '/' },
  }));
});

/**
 * Al pulsar el aviso.
 *
 * Si ya hay una pestaña del sitio abierta se le lleva ahi en vez de abrir otra:
 * acabar con cuatro pestañas de la misma web es lo que hace que la gente deje
 * de pulsar los avisos.
 */
self.addEventListener('notificationclick', (evento) => {
  evento.notification.close();
  const destino = evento.notification.data?.url || '/';

  evento.waitUntil((async () => {
    const abiertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

    for (const cliente of abiertas) {
      if (new URL(cliente.url).origin === self.location.origin) {
        await cliente.focus();
        if ('navigate' in cliente) await cliente.navigate(destino);
        return;
      }
    }

    await self.clients.openWindow(destino);
  })());
});
