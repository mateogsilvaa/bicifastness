/**
 * Piezas de interfaz comunes: tema, navegacion, nombres de estacion y el aviso
 * de cookies. Antes estaban copiadas en cada pagina con pequenas diferencias.
 */

import { ESTACIONES } from '../data/estaciones.js';
import { el, id, icono, reemplazar } from './dom.js';
import { vigilarErrores } from './errores.js';
import { medir } from './metricas.js';
import { registrarServiceWorker, leerResumenOffline } from './instalar.js';

// --- Antiframing -------------------------------------------------------------
/**
 * Impide que el sitio se cargue dentro de un marco ajeno (clickjacking).
 *
 * Esto lo hacian las cabeceras `X-Frame-Options: DENY` y `frame-ancestors
 * 'none'` de `firebase.json`. En GitHub Pages no hay cabeceras, y
 * `frame-ancestors` es una de las directivas que el navegador **ignora** cuando
 * la CSP llega por <meta>. Asi que hay que hacerlo a mano.
 *
 * Es mas debil que la cabecera y conviene saber por que:
 *   - los modulos van diferidos, asi que la pagina llega a pintarse un instante
 *     dentro del marco antes de que esto salte
 *   - un marco con `sandbox` sin `allow-top-navigation` bloquea la salida; ahi
 *     lo unico que se puede hacer es tapar el contenido
 *
 * Recuperar la proteccion de verdad exige cabeceras, es decir, un dominio
 * propio detras de Cloudflare. Esta anotado en el issue #3.
 */
if (window.top !== window.self) {
  try {
    window.top.location = window.self.location;
  } catch {
    // Marco con sandbox: no se puede navegar el contenedor. Al menos, que no
    // se vea ni se pueda pulsar nada.
    document.documentElement.style.display = 'none';
  }
}

// --- Tema --------------------------------------------------------------------
//
// Tres opciones, como en Tu -> Ajustes: Sistema (por defecto), Claro y Oscuro.
// Se guarda en `localStorage('theme')` como siempre; "Sistema" es NO guardar
// nada, asi quien ya tenia elegido un tema lo conserva tras el rediseño.

const OSCURO_DEL_SISTEMA = window.matchMedia('(prefers-color-scheme: dark)');

/** 'sistema' | 'light' | 'dark'. En modo privado `localStorage` puede lanzar. */
export function temaElegido() {
  try {
    const guardado = localStorage.getItem('theme');
    return guardado === 'light' || guardado === 'dark' ? guardado : 'sistema';
  } catch {
    return 'sistema';
  }
}

let escuchandoSistema = false;

export function aplicarTema() {
  const elegido = temaElegido();
  const tema = elegido === 'sistema' ? (OSCURO_DEL_SISTEMA.matches ? 'dark' : 'light') : elegido;
  document.documentElement.setAttribute('data-theme', tema);

  // Con "Sistema", si el movil cambia de claro a oscuro al anochecer, la web
  // cambia con el sin recargar. Se engancha una vez por pagina.
  if (!escuchandoSistema) {
    escuchandoSistema = true;
    OSCURO_DEL_SISTEMA.addEventListener('change', () => {
      if (temaElegido() === 'sistema') aplicarTema();
    });
  }
  return tema;
}

/** Elige tema y lo aplica en el acto: la vista previa es la propia pagina. */
export function elegirTema(opcion) {
  try {
    if (opcion === 'light' || opcion === 'dark') localStorage.setItem('theme', opcion);
    else localStorage.removeItem('theme');
  } catch {
    // Sin almacenamiento el tema dura lo que la pagina, que es mejor que nada.
  }
  return aplicarTema();
}

// --- Estaciones --------------------------------------------------------------
/** Normaliza un id de estacion al formato canonico: "2" -> "002". */
export function normalizarEstacion(raw) {
  const val = String(raw ?? '').trim().toUpperCase();
  const m = val.match(/^(\d+)([A-Z]?)$/);
  return m ? m[1].padStart(3, '0') + (m[2] || '') : val;
}

export function nombreEstacion(raw) {
  return ESTACIONES[normalizarEstacion(raw)]?.nombre || null;
}

/** Distancia por calle estimada: la misma formula de respaldo que el worker. */
export function kmEstimados(origen, destino) {
  const a = ESTACIONES[normalizarEstacion(origen)];
  const b = ESTACIONES[normalizarEstacion(destino)];
  if (!a || !b) return null;
  const rad = (g) => (g * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  const recta = 2 * 6371 * Math.asin(Math.sqrt(h));
  return recta * 1.35; // FISICA.FACTOR_CALLEJERO
}

/**
 * "1.412" y "18.402", como en el diseño: con punto de miles tambien en cuatro
 * cifras (el formato de España del navegador no lo pone hasta las cinco).
 */
export function miles(n, decimales = 0) {
  const valor = Number(n) || 0;
  const [entera, fraccion] = Math.abs(valor).toFixed(decimales).split('.');
  return `${valor < 0 ? '-' : ''}${entera.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${fraccion ? `,${fraccion}` : ''}`;
}

/** "002-110" -> "Metro Callao → Intercambiador de Moncloa" */
export function nombreRuta(ruta) {
  const [origen, destino] = String(ruta || '').split('-');
  return `${nombreEstacion(origen) || origen} → ${nombreEstacion(destino) || destino}`;
}

/** Nodo con la ruta y una flecha, para no meter HTML a mano. */
export function nodoRuta(ruta) {
  const [origen, destino] = String(ruta || '').split('-');
  return el('span', { estilo: { display: 'inline-flex', alignItems: 'center', gap: '6px' } }, [
    el('span', { texto: nombreEstacion(origen) || origen }),
    el('span', { texto: '→', clase: 'apagado', attrs: { 'aria-hidden': 'true' } }),
    el('span', { texto: nombreEstacion(destino) || destino }),
  ]);
}

export function formatearTiempo(segundos) {
  const m = Math.floor(segundos / 60);
  const s = segundos % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatearFecha(valor) {
  const d = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
}

// --- Navegacion --------------------------------------------------------------
/**
 * Los CUATRO destinos de primer nivel.
 *
 * Antes eran siete, y `/home/` no era mas que un indice de enlaces a los otros
 * seis: una pantalla que existia solo para llevar a otras. Ahora ninguna lo
 * hace. `/subir/` va aparte porque no es un destino mas, es LA accion: en
 * escritorio es el boton azul de la derecha y en movil el bloque del extremo.
 */
const DESTINOS = [
  { href: '/', slug: 'ahora', texto: 'Hoy', icono: 'hoy' },
  { href: '/clasificacion/', slug: 'clasificacion', texto: 'Ranking', icono: 'clasificacion' },
  { href: '/territorio/', slug: 'territorio', texto: 'Mapa', icono: 'mapa' },
  { href: '/yo/', slug: 'yo', texto: 'Tú', icono: 'perfil' },
];

const SUBIR = { href: '/subir/', slug: 'subir', texto: 'Subir trayecto', icono: 'mas' };

/**
 * Pinta la barra superior (escritorio) y la inferior (movil).
 *
 * Las dos se pintan siempre y es el CSS quien decide cual se ve. Hacerlo por
 * ancho de pantalla en JavaScript obligaria a escuchar el redimensionado y a
 * repintar, y dejaria la barra equivocada durante el primer fotograma.
 *
 * @param {string} activo  slug del destino actual
 */
export function montarNavegacion(activo) {
  const superior = id('nav-principal');
  const inferior = id('nav-inferior');

  const esActivo = (slug) => slug === activo;

  if (superior) {
    // 08 Escritorio: desde 900 px la barra inferior pasa a un lateral de 240 px
    // con el boton azul arriba. En movil no se ve (lo decide el CSS).
    superior.className = 'lateral';
    superior.setAttribute('aria-label', 'Navegacion principal');

    reemplazar(superior,
      el('a', { clase: 'logo lateral-logo', attrs: { href: '/', 'aria-label': 'bicifastness' } }, [
        logoAnillo(28),
        // La palabra va siempre en minusculas (00 Marca y sistema).
        el('span', { clase: 'logo-palabra', texto: 'bicifastness' }),
      ]),
      el('a', {
        clase: 'btn lateral-subir',
        attrs: { href: SUBIR.href, 'aria-current': esActivo(SUBIR.slug) ? 'page' : null, 'data-subir': '' },
      }, [icono('mas', 'icono peq'), el('span', { texto: SUBIR.texto })]),
      el('div', { clase: 'lateral-destinos' }, DESTINOS.map((d) => el('a', {
        attrs: { href: d.href, 'aria-current': esActivo(d.slug) ? 'page' : null },
      }, [icono(d.icono), el('span', { texto: d.texto })]))),
      el('div', { clase: 'lateral-hueco' }),
      fichaLateral());
    // Se repinta cuando cambia el resumen (al entrar, al cargar el perfil, al
    // salir), sin esperar a la siguiente pagina.
    window.addEventListener('bf:resumen', () => {
      superior.querySelector('.lateral-ficha, .lateral-invitado')?.replaceWith(fichaLateral());
    });
  }

  if (inferior) {
    inferior.className = 'nav-inf';
    inferior.setAttribute('aria-label', 'Navegacion principal');

    const destino = (d) => el('a', {
      attrs: { href: d.href, 'aria-current': esActivo(d.slug) ? 'page' : null },
    }, [
      icono(d.icono),
      el('span', { texto: d.texto }),
    ]);

    // La accion, EN EL CENTRO: Hoy · Ranking · + · Mapa · Tu. Es lo que mas se
    // pulsa, y en el centro queda bajo el pulgar de cualquiera de las dos manos.
    reemplazar(inferior, [
      destino(DESTINOS[0]),
      destino(DESTINOS[1]),
      // El icono es la unica etiqueta visible, asi que el enlace lleva su propio
      // nombre accesible.
      el('a', {
        clase: 'subir',
        attrs: {
          href: SUBIR.href,
          'aria-label': SUBIR.texto,
          'aria-current': esActivo(SUBIR.slug) ? 'page' : null,
          'data-subir': '',
        },
      }, [el('span', { clase: 'fab' }, [icono(SUBIR.icono)])]),
      destino(DESTINOS[2]),
      destino(DESTINOS[3]),
    ]);
  }

  montarAtajosDeSubida(activo === SUBIR.slug);
}

/** El logo: la vuelta sin cerrar sobre el azul (00 Marca y sistema). */
export function logoAnillo(tam = 28) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({
    class: 'logo-anillo', viewBox: '0 0 24 24', width: tam, height: tam, 'aria-hidden': 'true', focusable: 'false',
  })) svg.setAttribute(k, String(v));
  const rect = document.createElementNS(NS, 'rect');
  rect.setAttribute('width', '24'); rect.setAttribute('height', '24'); rect.setAttribute('rx', '6.5');
  const arco = document.createElementNS(NS, 'path');
  arco.setAttribute('d', 'M12 5 A7 7 0 1 1 5.94 8.5');
  const punto = document.createElementNS(NS, 'circle');
  punto.setAttribute('cx', '5.94'); punto.setAttribute('cy', '8.5'); punto.setAttribute('r', '2.1');
  svg.append(rect, arco, punto);
  return svg;
}

export const NOMBRE_DIVISION = {
  hierro: 'Hierro', bronce: 'Bronce', plata: 'Plata', oro: 'Oro', platino: 'Platino', leyenda: 'Leyenda',
};

/**
 * Lo de abajo del lateral: tu ficha, o la invitacion a entrar.
 *
 * Sale del resumen que cada pantalla con sesion guarda en este dispositivo
 * (`guardarResumenOffline`): pintar el lateral no puede costar una lectura en
 * cada pagina. Cerrar sesion lo borra (`olvidarResumenOffline`).
 */
function fichaLateral() {
  const yo = leerResumenOffline();
  if (!yo?.username) {
    return el('div', { clase: 'lateral-invitado' }, [
      el('span', { texto: 'Entra para subir tus tiempos y unirte a un clan.' }),
      el('a', { clase: 'btn secundario', texto: 'Entrar', attrs: { href: '/entrar/' } }),
    ]);
  }
  const division = NOMBRE_DIVISION[yo.division] || null;
  return el('a', { clase: 'lateral-ficha', attrs: { href: '/yo/' } }, [
    el('span', { clase: 'avatar-inicial peque', texto: [...yo.username][0]?.toUpperCase() || 'P' }),
    el('span', { clase: 'datos' }, [
      el('strong', { texto: yo.username }),
      yo.grupo || division ? el('small', { texto: yo.grupo || division }) : null,
    ]),
    yo.racha ? el('span', { clase: 'racha-mini', attrs: { title: `Racha de ${yo.racha} días` } }, [
      logoAnillo(14), el('span', { texto: String(yo.racha) }),
    ]) : null,
  ]);
}

// --- Subir desde cualquier pantalla ---------------------------------------------
//
// 03 Subir y 08 Escritorio: el + abre directamente el selector de fotos (a partir
// de la tercera vez; las dos primeras se enseña la hoja que explica que captura
// subir), Ctrl/⌘+V pega una captura en cualquier pantalla, arrastrar una imagen
// sobre la ventana la suelta para leerla, y N lleva a subir. En todos los casos la
// imagen se deja en `captura-pendiente.js` y /subir/ la recoge al cargar.

const CLAVE_SUBIDAS = 'bf_subidas_abiertas';

/** Cuantas veces se ha abierto la subida en este navegador. */
export function vecesSubidaAbierta() {
  try { return Number(localStorage.getItem(CLAVE_SUBIDAS)) || 0; } catch { return 0; }
}
export function anotarSubidaAbierta() {
  try { localStorage.setItem(CLAVE_SUBIDAS, String(vecesSubidaAbierta() + 1)); } catch { /* modo privado */ }
}

let atajosMontados = false;

async function irASubirCon(ficheros) {
  const { guardarPendiente } = await import('./captura-pendiente.js');
  if (await guardarPendiente(ficheros)) window.location.href = '/subir/?pendiente=1';
}

const escribiendo = (objetivo) => objetivo instanceof HTMLElement
  && (objetivo.isContentEditable || /^(input|textarea|select)$/i.test(objetivo.tagName));

function montarAtajosDeSubida(enSubir) {
  if (atajosMontados) return;
  atajosMontados = true;

  // /subir/ se ocupa de todo esto por su cuenta: ahi la imagen se lee en el acto.
  if (enSubir) return;

  // El +: selector de fotos en la propia pantalla, sin pasar por una pagina
  // intermedia. Solo con un gesto de la persona se puede abrir un selector, por
  // eso va en el clic y no al llegar a /subir/.
  document.addEventListener('click', (evento) => {
    const enlace = evento.target.closest?.('[data-subir]');
    if (!enlace) return;
    // En escritorio el boton lleva SIEMPRE a /subir/ (8f: la captura a la
    // izquierda y el billete a la derecha); nada de saltarse la pagina.
    if (window.matchMedia('(min-width: 900px)').matches) return;
    // 3a: las dos primeras veces, en el movil, la hoja de subida sobre esta
    // misma pantalla.
    if (vecesSubidaAbierta() < 2) {
      evento.preventDefault();
      anotarSubidaAbierta();
      import('./hoja-subir.js').then((m) => m.abrirHojaSubir());
      return;
    }
    evento.preventDefault();
    const selector = document.createElement('input');
    selector.type = 'file';
    selector.accept = 'image/*';
    selector.multiple = true;
    selector.addEventListener('change', () => {
      if (selector.files?.length) irASubirCon(selector.files);
    });
    selector.click();
  });

  document.addEventListener('keydown', (evento) => {
    if (evento.key !== 'n' && evento.key !== 'N') return;
    if (evento.metaKey || evento.ctrlKey || evento.altKey || escribiendo(evento.target)) return;
    window.location.href = '/subir/';
  });

  document.addEventListener('paste', async (evento) => {
    if (escribiendo(evento.target)) return;
    const { imagenesDe } = await import('./captura-pendiente.js');
    const imagenes = imagenesDe(evento.clipboardData);
    if (!imagenes.length) return;
    evento.preventDefault();
    irASubirCon(imagenes);
  });

  // Arrastrar: toda la ventana es zona de soltar (8b).
  let capa = null;
  let dentro = 0;
  const conImagen = (e) => [...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file');
  const quitar = () => { capa?.remove(); capa = null; dentro = 0; document.body.classList.remove('soltando'); };

  window.addEventListener('dragenter', (e) => {
    if (!conImagen(e)) return;
    dentro += 1;
    if (capa) return;
    // 8b: la pantalla de detras se apaga y se desenfoca; delante, una captura
    // de ejemplo con el + y lo que se puede soltar.
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    capa = el('div', { clase: 'capa-soltar', attrs: { 'aria-hidden': 'true' } }, [
      el('div', { clase: 'capa-soltar-marco' }, [
        el('div', { clase: 'capa-soltar-dibujo' }, [
          el('span', { clase: 'capa-soltar-fondo' }),
          el('span', { clase: 'capa-soltar-captura' }, [el('img', { attrs: { src: '/images/ejemplo.jpg', alt: '' } })]),
          el('span', { clase: 'capa-soltar-mas' }, [icono('mas')]),
        ]),
        el('strong', { texto: 'Suéltala para leerla' }),
        el('span', { texto: 'Leemos estaciones, tiempo y horas en tu navegador. Puedes soltar varias a la vez: cada una es un trayecto.' }),
        el('span', { clase: 'capa-soltar-chips' }, [
          el('span', { texto: 'JPG · PNG · WebP · HEIC' }),
          el('span', { texto: 'Hasta 30 días atrás' }),
          el('span', { texto: 'Hoy puntúan 3' }),
        ]),
      ]),
      el('div', { clase: 'capa-soltar-teclas' }, [
        el('kbd', { texto: 'Esc' }), 'cancelar', el('span', { clase: 'hueco' }),
        el('kbd', { texto: mac ? '⌘ V' : 'Ctrl V' }), 'también pega una captura copiada',
      ]),
    ]);
    document.body.append(capa);
    document.body.classList.add('soltando');
  });
  window.addEventListener('dragover', (e) => { if (capa) e.preventDefault(); });
  window.addEventListener('dragleave', () => { dentro -= 1; if (dentro <= 0) quitar(); });
  window.addEventListener('drop', async (e) => {
    if (!capa) return;
    e.preventDefault();
    quitar();
    const { imagenesDe } = await import('./captura-pendiente.js');
    const imagenes = imagenesDe(e.dataTransfer);
    if (imagenes.length) irASubirCon(imagenes);
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') quitar(); });
}

// --- Consentimiento legal ----------------------------------------------------
/**
 * Version vigente de los textos legales.
 * DEBE coincidir con LEGAL.VERSION_TERMINOS de functions/src/config.js: el
 * servidor rechaza subir viajes si el consentimiento registrado no es el de la
 * version actual. Hay una prueba que comprueba que ambos valores no se separen.
 */
export const VERSION_LEGAL = '1.4.0';

/**
 * Si los textos legales han cambiado desde que la persona los acepto, se le pide
 * que vuelva a aceptarlos. Sin esto el servidor bloqueaba la subida de viajes
 * con un "debes aceptar la version vigente" que no se podia resolver desde
 * ninguna pantalla.
 *
 * @param {object} perfil       datos del documento de usuario
 * @param {Function} aceptar    callable `aceptarLegal`
 * @returns {boolean}           true si hay que re-aceptar
 */
export function pedirReaceptacion(perfil, aceptar) {
  const aceptada = perfil?.consentimiento?.terminos?.version;
  if (!aceptada || aceptada === VERSION_LEGAL) return false;

  const boton = el('button', {
    clase: 'btn',
    texto: 'Aceptar y continuar',
    attrs: { type: 'button' },
    on: {
      click: async () => {
        boton.disabled = true;
        boton.textContent = 'Guardando...';
        try {
          await aceptar();
          aviso.remove();
        } catch (error) {
          boton.disabled = false;
          boton.textContent = 'Reintentar';
          console.error(error);
        }
      },
    },
  });

  const aviso = el('div', {
    // 07 · 7c: tarjeta oscura en la misma pila que el aviso de cookies, anclada
    // SOBRE la barra inferior. No se puede cerrar: sin aceptar no se sube.
    clase: 'aviso-flotante oscuro',
    attrs: { role: 'alert' },
  }, [
    el('p', {}, [
      'Hemos actualizado los ',
      el('a', { texto: 'términos de uso', attrs: { href: '/legal/terminos/', target: '_blank', rel: 'noopener' } }),
      ' y la ',
      el('a', { texto: 'política de privacidad', attrs: { href: '/legal/privacidad/', target: '_blank', rel: 'noopener' } }),
      '. Revísalos y acéptalos para poder seguir subiendo tiempos.',
    ]),
    boton,
  ]);

  pilaDeAvisos().append(aviso);
  return true;
}

/**
 * La pila de avisos flotantes (cookies, terminos, instalar): tarjetas apiladas
 * sobre la barra inferior en movil y abajo a la derecha en escritorio (8q). Una
 * sola pila para que nunca se tapen entre ellas.
 */
export function pilaDeAvisos() {
  let pila = document.querySelector('.pila-avisos');
  if (!pila) {
    pila = el('div', { clase: 'pila-avisos' });
    document.body.append(pila);
  }
  return pila;
}

// --- Aviso de cookies --------------------------------------------------------
/**
 * Banner de cookies conforme al RGPD y al art. 22.2 de la LSSI.
 *
 * Solo usamos cookies tecnicas (la sesion de Firebase Auth y App Check), que
 * estan exentas de consentimiento previo; por eso el aviso es informativo y no
 * bloquea nada. Si algun dia se anade analitica o publicidad, habra que cambiar
 * esto por un consentimiento real con rechazo tan facil como la aceptacion.
 */
export function montarAvisoCookies() {
  const CLAVE = 'bf_cookies_v1';
  try { if (localStorage.getItem(CLAVE)) return; } catch { return; }

  const banner = el('div', {
    clase: 'aviso-flotante cookies',
    attrs: { role: 'region', 'aria-label': 'Aviso de cookies' },
  }, [
    el('p', {}, [
      'Solo usamos cookies técnicas: tu sesión y la protección contra bots. Nada de publicidad ni analítica. ',
      el('a', { texto: 'Más información', attrs: { href: '/legal/cookies/' } }),
    ]),
    el('button', {
      clase: 'btn tonal',
      texto: 'Entendido',
      attrs: { type: 'button' },
      on: {
        click: () => {
          try { localStorage.setItem(CLAVE, new Date().toISOString()); } catch { /* modo privado */ }
          banner.remove();
        },
      },
    }),
  ]);

  pilaDeAvisos().append(banner);
}

export function montarPieLegal() {
  const pie = id('pie-legal');
  if (!pie) return;

  const enlaces = [
    ['Aviso legal', '/legal/aviso-legal/'],
    ['Privacidad', '/legal/privacidad/'],
    ['Terminos de uso', '/legal/terminos/'],
    ['Cookies', '/legal/cookies/'],
  ];

  pie.className = 'pie';

  reemplazar(pie,
    el('nav', { attrs: { 'aria-label': 'Enlaces legales' } },
      enlaces.map(([texto, href]) => el('a', { texto, attrs: { href } }))),
    el('p', {
      clase: 'menor',
      texto: 'BiciFastness es un proyecto independiente sin relacion con BiciMAD ni con la EMT de Madrid.',
    }));
}

/** Arranque comun de cualquier pagina de la app. */
export function iniciarPagina(seccionActiva) {
  // Lo primero: si algo revienta mas abajo, queremos enterarnos.
  vigilarErrores();
  vigilarCarga();
  medir();
  aplicarTema();
  montarNavegacion(seccionActiva);
  montarPieLegal();
  montarAvisoCookies();
  // Sin service worker no hay ni instalacion ni pantalla offline (#52). Se
  // registra en todas las paginas porque cualquiera puede ser la primera que
  // alguien abre.
  registrarServiceWorker();
}

/**
 * Pantalla en blanco. Si una lectura se queda colgada (red que no contesta, la
 * cache de Safari…) la pagina se quedaba vacia o con los esqueletos de carga
 * para siempre, sin error y sin salida. A los 12 s, si sigue asi, se dice y se
 * ofrece reintentar. No toca nada si la pagina ya ha pintado su contenido.
 */
function vigilarCarga() {
  setTimeout(() => {
    const principal = document.querySelector('main');
    if (!principal) return;
    const visibles = [...principal.querySelectorAll('.esqueleto')].filter((e) => e.offsetParent !== null);
    const vacia = principal.innerText.trim().length < 20;
    if (!vacia && !visibles.length) return;
    if (document.getElementById('aviso-carga')) return;
    const boton = document.createElement('button');
    boton.type = 'button';
    boton.className = 'btn';
    boton.textContent = 'Reintentar';
    boton.addEventListener('click', () => window.location.reload());
    const aviso = document.createElement('div');
    aviso.id = 'aviso-carga';
    aviso.className = 'aviso-carga';
    aviso.setAttribute('role', 'alert');
    const texto = document.createElement('span');
    texto.textContent = 'Esto no ha terminado de cargar. Suele ser la conexión.';
    aviso.append(texto, boton);
    document.body.append(aviso);
  }, 12000);
}
