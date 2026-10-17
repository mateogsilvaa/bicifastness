/**
 * La tienda, vista desde el resto de la app: si esta abierta y la invitacion
 * a echarle un ojo.
 *
 * La administracion la abre o la cierra en /admin/tienda/ (`config/tienda`).
 * Cerrada, no aparece en ningun sitio: ni el acceso en Tu, ni la invitacion,
 * ni la propia pagina (salvo para la administracion, que la puede probar).
 *
 * Coste: una lectura de `config/tienda` por pestaña, guardada 10 minutos.
 */

import { db, doc, getDoc } from './firebase.js';
import { el, icono, reemplazar } from './dom.js';

const CLAVE = 'bf_tienda';
/** El enlace de un producto de Gumroad: https://pepa.gumroad.com/l/abc12 */
export const ENLACE_GUMROAD = /^https:\/\/([a-z0-9-]+\.)?gumroad\.com\/l\/[A-Za-z0-9_-]+$/;
const VIGENCIA = 10 * 60 * 1000;

/** Los productos que se pueden comprar ahora: activos y con enlace de pago. */
export function productosALaVenta(config) {
  if (!config?.visible) return [];
  return Object.entries(config.productos || {})
    .filter(([, p]) => p?.activo && typeof p.enlacePago === 'string' && ENLACE_GUMROAD.test(p.enlacePago))
    .map(([clave, p]) => ({ clave, ...p }));
}

/** `config/tienda`, o null si no existe o no se puede leer. */
export async function leerTienda({ fresca = false } = {}) {
  if (!fresca) {
    try {
      const d = JSON.parse(sessionStorage.getItem(CLAVE) || 'null');
      if (d && Date.now() - d.t < VIGENCIA) return d.config;
    } catch { /* sin almacenamiento se lee */ }
  }
  try {
    const snap = await getDoc(doc(db, 'config', 'tienda'));
    const config = snap.exists() ? snap.data() : null;
    try { sessionStorage.setItem(CLAVE, JSON.stringify({ config, t: Date.now() })); } catch { /* da igual */ }
    return config;
  } catch {
    return null;
  }
}

/** ¿Hay algo que enseñar? Es lo que deciden el acceso de Tu y la invitacion. */
export async function tiendaAbierta() {
  return productosALaVenta(await leerTienda()).length > 0;
}

// --- El circulo con corazon -------------------------------------------------
//
// En Hoy, Ranking y Mapa (lo decide `iniciarPagina`): un circulo pequeño en la
// esquina que lleva a la tienda. Solo si esta abierta; si no, ni se pinta.

/** Pinta el acceso flotante a la tienda si hay algo a la venta. */
export async function montarBurbujaTienda() {
  if (document.querySelector('.burbuja-tienda')) return;
  if (!(await tiendaAbierta())) return;
  document.body.append(el('a', {
    clase: 'burbuja-tienda',
    attrs: { href: '/tienda/', 'aria-label': 'Tienda: apoya el proyecto', title: 'Tienda' },
  }, [icono('corazon')]));
}

// --- La invitacion -----------------------------------------------------------
//
// Una tarjeta en Hoy, nunca una ventana encima de nada. Para que no moleste:
//   - solo a quien ya usa la app de verdad (5 trayectos verificados y una
//     semana de cuenta): a quien acaba de llegar no se le pide nada;
//   - como mucho una vez al mes, y tres veces en total;
//   - "No volver a mostrar" es para siempre en ese navegador;
//   - y solo si no hay ya otra invitacion en pantalla (instalar, avisos).

const VISTA = 'bf_apoyo';
const DIAS_ENTRE = 30;
const VECES_MAX = 3;

function leerVista() {
  try { return JSON.parse(localStorage.getItem(VISTA) || '{}') || {}; } catch { return {}; }
}
function guardarVista(v) {
  try { localStorage.setItem(VISTA, JSON.stringify(v)); } catch { /* sin almacenamiento no se repite en esta visita */ }
}

/** ¿Toca enseñarla hoy a este perfil? Sin leer nada: solo el perfil y el navegador. */
export function tocaInvitar(perfil, ahora = Date.now(), vista = leerVista()) {
  if (vista.nunca) return false;
  if ((vista.veces || 0) >= VECES_MAX) return false;
  if (vista.ultima && ahora - vista.ultima < DIAS_ENTRE * 864e5) return false;
  if ((perfil?.viajesVerificados || 0) < 5) return false;
  const alta = perfil?.creado?.toMillis?.() ?? null;
  if (alta && ahora - alta < 7 * 864e5) return false;
  return true;
}

/**
 * Pinta la invitacion en `contenedor` si toca. Devuelve si ha salido.
 * La tienda solo se mira (una lectura) cuando todo lo demas ya dice que si.
 */
export async function ofrecerApoyo(contenedor, perfil) {
  if (!contenedor || !contenedor.classList.contains('oculto') || !tocaInvitar(perfil)) return false;
  if (!(await tiendaAbierta())) return false;

  const vista = leerVista();
  guardarVista({ ...vista, ultima: Date.now(), veces: (vista.veces || 0) + 1 });

  const cerrar = (nunca = false) => {
    if (nunca) guardarVista({ ...leerVista(), nunca: true });
    contenedor.classList.add('oculto');
    reemplazar(contenedor);
  };

  reemplazar(contenedor, el('div', { clase: 'tarjeta-grande invitacion-apoyo' }, [
    el('span', { clase: 'rotulo', texto: 'Una cosa, sin prisa' }),
    el('strong', { texto: 'BiciFastness es gratis y sin anuncios' }),
    el('p', {
      texto: 'Mantenerlo cuesta dinero: servidores, dominio y el tiempo de verificar cada trayecto. '
        + 'Si te apetece echar una mano, hay camisetas y tazas con tus propias marcas.',
    }),
    el('div', { clase: 'invitacion-apoyo-botones' }, [
      el('a', { clase: 'btn', texto: 'Ver la tienda', attrs: { href: '/tienda/' } }),
      el('button', { clase: 'btn secundario', texto: 'Ahora no', attrs: { type: 'button' }, on: { click: () => cerrar() } }),
    ]),
    el('button', {
      clase: 'invitacion-apoyo-nunca', texto: 'No volver a mostrar', attrs: { type: 'button' }, on: { click: () => cerrar(true) },
    }),
  ]));
  contenedor.classList.remove('oculto');
  return true;
}
