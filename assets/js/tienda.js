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
import { el, reemplazar } from './dom.js';

const CLAVE = 'bf_tienda';
const VIGENCIA = 10 * 60 * 1000;

/** Un enlace de pago de Polar (o de su entorno de pruebas). Lo mismo que las reglas. */
export const ENLACE_POLAR = /^https:\/\/(buy\.polar\.sh\/polar_cl_[A-Za-z0-9]+|sandbox-api\.polar\.sh\/v1\/checkout-links\/polar_cl_[A-Za-z0-9]+\/redirect)$/;

/** Los productos que se pueden comprar ahora: activos y con enlace de pago. */
export function productosALaVenta(config) {
  if (!config?.visible) return [];
  return Object.entries(config.productos || {})
    .filter(([, p]) => p?.activo && ENLACE_POLAR.test(p.enlacePago || ''))
    .map(([clave, p]) => ({ clave, ...p }));
}

/** Los paquetes de gemas a la venta, de menos a mas. */
export function packsALaVenta(config) {
  if (!config?.visible) return [];
  return Object.entries(config.gemas?.packs || {})
    .filter(([, p]) => p?.activo && ENLACE_POLAR.test(p.enlacePago || '') && p.gemas > 0)
    .map(([clave, p]) => ({ clave, ...p }))
    .sort((a, b) => a.gemas - b.gemas);
}

/**
 * El enlace de pago con lo que nos hace falta para casar el pago con el pedido
 * (backend/src/tienda.js): quien es (`customer_external_id`) y que pedido.
 */
export function enlaceDePago(enlace, uid, pedidoId) {
  const url = new URL(enlace);
  url.searchParams.set('customer_external_id', uid);
  url.searchParams.set('reference_id', pedidoId);
  url.searchParams.set('metadata', JSON.stringify({ pedido: pedidoId }));
  return url.toString();
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
  const config = await leerTienda();
  return productosALaVenta(config).length > 0 || packsALaVenta(config).length > 0;
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
