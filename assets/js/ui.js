/**
 * Piezas de interfaz comunes: tema, navegacion, nombres de estacion y el aviso
 * de cookies. Antes estaban copiadas en cada pagina con pequenas diferencias.
 */

import { ESTACIONES } from '../data/estaciones.js';
import { el, id, icono, reemplazar } from './dom.js';

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
export function aplicarTema() {
  const guardado = localStorage.getItem('theme');
  const tema = guardado || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', tema);
  return tema;
}

export function alternarTema() {
  const nuevo = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', nuevo);
  localStorage.setItem('theme', nuevo);
  return nuevo;
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
  { href: '/', slug: 'ahora', texto: 'Ahora', icono: 'reloj' },
  { href: '/clasificacion/', slug: 'clasificacion', texto: 'Clasificacion', icono: 'clasificacion' },
  { href: '/territorio/', slug: 'territorio', texto: 'Territorio', icono: 'mapa' },
  { href: '/yo/', slug: 'yo', texto: 'Perfil', icono: 'perfil' },
];

const SUBIR = { href: '/subir/', slug: 'subir', texto: 'Subir tiempo', icono: 'subir' };

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
    superior.className = 'nav-sup';
    superior.setAttribute('aria-label', 'Navegacion principal');

    reemplazar(superior,
      el('a', { clase: 'marca', attrs: { href: '/' } }, [
        el('img', { attrs: { src: '/images/logo.png', alt: '', width: 28, height: 28 } }),
        el('span', { texto: 'BiciFastness' }),
      ]),
      el('div', { clase: 'destinos' }, DESTINOS.map((d) => el('a', {
        texto: d.texto,
        attrs: { href: d.href, 'aria-current': esActivo(d.slug) ? 'page' : null },
      }))),
      el('a', {
        clase: 'btn',
        texto: SUBIR.texto,
        attrs: { href: SUBIR.href, 'aria-current': esActivo(SUBIR.slug) ? 'page' : null },
      }));
  }

  if (inferior) {
    inferior.className = 'nav-inf';
    inferior.setAttribute('aria-label', 'Navegacion principal');

    reemplazar(inferior, [
      ...DESTINOS.map((d) => el('a', {
        attrs: { href: d.href, 'aria-current': esActivo(d.slug) ? 'page' : null },
      }, [
        icono(d.icono),
        el('span', { texto: d.texto }),
      ])),
      // El icono es la unica etiqueta visible, asi que el enlace lleva su propio
      // nombre accesible.
      el('a', {
        clase: 'subir',
        attrs: {
          href: SUBIR.href,
          'aria-label': SUBIR.texto,
          'aria-current': esActivo(SUBIR.slug) ? 'page' : null,
        },
      }, [icono(SUBIR.icono)]),
    ]);
  }
}

// --- Consentimiento legal ----------------------------------------------------
/**
 * Version vigente de los textos legales.
 * DEBE coincidir con LEGAL.VERSION_TERMINOS de functions/src/config.js: el
 * servidor rechaza subir viajes si el consentimiento registrado no es el de la
 * version actual. Hay una prueba que comprueba que ambos valores no se separen.
 */
export const VERSION_LEGAL = '1.0.0';

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
    texto: 'Aceptar y continuar',
    estilo: { width: 'auto', padding: '10px 22px', margin: '0', flexShrink: '0' },
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
    attrs: { role: 'alert' },
    estilo: {
      position: 'fixed', bottom: '0', left: '0', right: '0', zIndex: '9100',
      background: 'var(--bg-card)', borderTop: '2px solid var(--aviso)',
      padding: '16px 20px', display: 'flex', flexWrap: 'wrap', gap: '14px',
      alignItems: 'center', justifyContent: 'center', fontSize: '.86rem',
    },
  }, [
    el('span', { estilo: { flex: '1 1 320px', color: 'var(--text-muted)' } }, [
      'Hemos actualizado los ',
      el('a', { texto: 'Terminos de Uso', attrs: { href: '/legal/terminos/', target: '_blank', rel: 'noopener' }, estilo: { color: 'var(--primary)' } }),
      ' y la ',
      el('a', { texto: 'Politica de Privacidad', attrs: { href: '/legal/privacidad/', target: '_blank', rel: 'noopener' }, estilo: { color: 'var(--primary)' } }),
      '. Revisalos y aceptalos para poder seguir subiendo tiempos.',
    ]),
    boton,
  ]);

  document.body.appendChild(aviso);
  return true;
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
  if (localStorage.getItem(CLAVE)) return;

  const cerrar = () => { localStorage.setItem(CLAVE, new Date().toISOString()); banner.remove(); };

  const banner = el('div', {
    attrs: { role: 'region', 'aria-label': 'Aviso de cookies' },
    estilo: {
      position: 'fixed', bottom: '0', left: '0', right: '0', zIndex: '9000',
      background: 'var(--bg-card)', borderTop: '1px solid var(--border)',
      padding: '16px 20px', display: 'flex', flexWrap: 'wrap', gap: '12px',
      alignItems: 'center', justifyContent: 'center', fontSize: '.85rem',
      boxShadow: '0 -4px 20px rgba(0,0,0,.2)',
    },
  }, [
    el('span', {
      texto: 'Usamos unicamente cookies tecnicas necesarias para mantener tu sesion. No hacemos seguimiento publicitario.',
      estilo: { flex: '1 1 320px', color: 'var(--text-muted)' },
    }),
    el('a', {
      texto: 'Politica de cookies',
      attrs: { href: '/legal/cookies/' },
      estilo: { color: 'var(--primary)', fontWeight: '600', textDecoration: 'none' },
    }),
    el('button', {
      texto: 'Entendido',
      estilo: { width: 'auto', padding: '10px 24px', margin: '0' },
      on: { click: cerrar },
    }),
  ]);

  document.body.appendChild(banner);
}

// --- Pie legal ---------------------------------------------------------------
/** Enlaces legales obligatorios, presentes en todas las paginas. */
export function montarPieLegal() {
  const pie = id('pie-legal');
  if (!pie) return;

  const enlaces = [
    ['Aviso legal', '/legal/aviso-legal/'],
    ['Privacidad', '/legal/privacidad/'],
    ['Terminos de uso', '/legal/terminos/'],
    ['Cookies', '/legal/cookies/'],
  ];

  reemplazar(pie,
    el('div', {
      estilo: { display: 'flex', flexWrap: 'wrap', gap: '16px', justifyContent: 'center', marginBottom: '8px' },
    }, enlaces.map(([texto, href]) => el('a', {
      texto, attrs: { href }, estilo: { color: 'var(--text-muted)', textDecoration: 'none', fontSize: '.8rem' },
    }))),
    el('p', {
      texto: 'BiciFastness es un proyecto independiente sin relacion con BiciMAD ni con la EMT de Madrid.',
      estilo: { color: 'var(--text-muted)', fontSize: '.75rem', margin: '0', textAlign: 'center' },
    }));
}

/** Arranque comun de cualquier pagina de la app. */
export function iniciarPagina(seccionActiva) {
  aplicarTema();
  montarNavegacion(seccionActiva);
  montarPieLegal();
  montarAvisoCookies();
}
