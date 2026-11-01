/**
 * Las pegatinas de las bicis llevan un QR a bicifastness.es (los NFC de debajo
 * no funcionan). Quien entra escaneandolo puede llevarse un premio al azar,
 * una vez por cuenta: lo sortea el worker (backend/src/premios-qr.js), nunca el
 * navegador.
 *
 * Como el QR apunta a la portada a secas, "viene del QR" es: llega a la
 * portada desde el movil sin venir de otra web (escanear con la camara se ve
 * asi), o con `?qr` en la direccion. Lo puede imitar quien teclee la direccion
 * en el movil, y da igual: es un premio cosmetico, uno por cuenta, y con cupo.
 */

import { db, doc, getDoc, setDoc, onSnapshot, serverTimestamp } from './firebase.js';
import { el, abrirHoja } from './dom.js';
import { banner, lema } from './perfil-publico.js';

const CLAVE = 'bf_vino_qr';
const PEDIDO = 'bf_premio_qr_pedido';
const guardado = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const guardar = (k, v) => { try { localStorage.setItem(k, v); } catch { /* modo privado */ } };

/** Se llama al cargar la portada: apunta si se ha llegado por el QR. */
export function apuntarSiVieneDelQr() {
  const conParametro = new URLSearchParams(window.location.search).has('qr');
  const movil = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const instalada = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const nav = performance.getEntriesByType?.('navigation')?.[0]?.type;
  const desdeFuera = !document.referrer && nav !== 'reload' && nav !== 'back_forward';
  if (conParametro || (movil && !instalada && desdeFuera)) guardar(CLAVE, String(Date.now()));
}

/**
 * Con sesion y perfil: si vino del QR y aun no lo ha pedido, lo pide y, cuando
 * el worker sortea (unos minutos), le enseña el resultado.
 */
export async function pedirPremioQr(uid) {
  if (!uid || !guardado(CLAVE)) return;
  const ref = doc(db, 'premios_qr', uid);
  try {
    if (!guardado(PEDIDO)) {
      const ya = await getDoc(ref);
      if (!ya.exists()) await setDoc(ref, { estado: 'pendiente', creado: serverTimestamp() });
      guardar(PEDIDO, '1');
    }
    const parar = onSnapshot(ref, (snap) => {
      const r = snap.data();
      if (!r || r.estado !== 'resuelto') return;
      parar();
      if (guardado(`${PEDIDO}_visto`)) return;
      guardar(`${PEDIDO}_visto`, '1');
      mostrar(r);
    }, () => { /* sin permiso o sin red: lo vera la proxima vez */ });
  } catch {
    // Ya lo habia pedido (las reglas no dejan repetir) o no hay red: nada.
  }
}

function mostrar(r) {
  const premios = [
    r.banner ? el('div', { clase: 'premio-qr-item' }, [banner('estaciones'), el('span', { texto: 'Banner Estaciones' })]) : null,
    r.lema ? el('p', { clase: 'regalo-lema' }, [lema('desde-el-origen')]) : null,
  ].filter(Boolean);
  let cerrar = null;
  ({ cerrar } = abrirHoja([
    el('h2', { texto: premios.length ? '¡Premio de la pegatina!' : 'Esta vez no ha habido suerte' }),
    el('p', {
      clase: 'apagado',
      texto: premios.length
        ? 'Has llegado escaneando una pegatina de una BiciMAD y te ha tocado:'
        : 'Has llegado por una pegatina, pero esta vez no tocaba premio. Hay más repartidas por Madrid: síguenos para saber dónde.',
    }),
    ...premios,
    el('div', { clase: 'dos-botones-hoja' }, [
      premios.length ? el('a', { clase: 'btn', texto: 'Ponérmelo', attrs: { href: '/yo/#perfil' } }) : null,
      el('button', { clase: 'btn plano', texto: premios.length ? 'Luego' : 'Vale', attrs: { type: 'button' }, on: { click: () => cerrar() } }),
    ]),
  ], { etiqueta: 'Premio de la pegatina' }));
}
