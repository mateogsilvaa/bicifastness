// Modulo de la pagina /canjear/: canjear un enlace de evento (/canjear/?c=CODIGO).
//
// EL NAVEGADOR SOLO PIDE. Aqui se deja `canjes_recompensa/{uid}` con el codigo
// y se espera a que el worker (backend/src/canjes.js) lo decida y escriba el
// resultado en el mismo documento. Por eso hay una espera de unos minutos, y
// por eso hay un boton: el enlace no se canjea solo al abrirlo.
//
// Sin sesion no se puede: se guarda el codigo, se invita a entrar, y al entrar
// se vuelve aqui (assets/js/canje-pendiente.js).

import {
  auth, db, onAuthStateChanged, doc, getDoc, setDoc, onSnapshot, serverTimestamp,
} from '/assets/js/firebase.js';
import { iniciarPagina } from '/assets/js/ui.js';
import { id, el, icono, reemplazar } from '/assets/js/dom.js';
import { BANNERS, LEMAS } from '/assets/data/recompensas.js';
import { banner, lema } from '/assets/js/perfil-publico.js';
import { FORMA_CODIGO, guardarCanje, canjePendiente, olvidarCanje } from '/assets/js/canje-pendiente.js';

iniciarPagina('yo');

const destino = id('canje');
const enUrl = new URLSearchParams(window.location.search).get('c') || '';
const codigo = FORMA_CODIGO.test(enUrl) ? enUrl : canjePendiente();
// El codigo ya esta guardado: se quita de la barra, que no se quede en el
// historial ni en lo que alguien comparta sin querer.
if (enUrl) window.history.replaceState(null, '', window.location.pathname);

const tarjeta = (hijos, clase = '') => el('div', { clase: `tarjeta-grande canje ${clase}`.trim() }, hijos);
const boton = (texto, href) => el('a', { clase: 'btn', texto, attrs: { href } });

/** La recompensa conseguida, enseñada como se vera en la ficha. */
function premio(recompensa) {
  if (BANNERS[recompensa]) {
    return el('div', { clase: 'canje-premio' }, [banner(recompensa), el('strong', { texto: `Banner · ${BANNERS[recompensa].titulo}` })]);
  }
  if (LEMAS[recompensa]) {
    return el('div', { clase: 'canje-premio' }, [lema(recompensa), el('strong', { texto: 'Lema nuevo' })]);
  }
  return el('div', { clase: 'canje-premio' }, [el('strong', { texto: 'Una recompensa nueva' })]);
}

const PANTALLAS = {
  'sin-enlace': () => tarjeta([
    icono('enlace', 'icono'),
    el('h2', { texto: 'No hay nada que canjear' }),
    el('p', { texto: 'Esta página es para los enlaces que se reparten en eventos. Abre el enlace que te hayan dado.' }),
    boton('Ir a Tú', '/yo/'),
  ]),
  'sin-sesion': () => tarjeta([
    icono('enlace', 'icono'),
    el('h2', { texto: 'Tienes un enlace de evento' }),
    el('p', { texto: 'Entra con tu cuenta (o crea una) y vuelves aquí para canjearlo. Lo guardamos para ti.' }),
    boton('Entrar', '/entrar/'),
    el('a', { clase: 'btn secundario', texto: 'Crear cuenta', attrs: { href: '/register/' } }),
  ]),
  'sin-perfil': () => tarjeta([
    icono('perfil', 'icono'),
    el('h2', { texto: 'Falta elegir tu nombre de piloto' }),
    el('p', { texto: 'Termina de crear tu cuenta y luego vuelve a abrir tu enlace: lo seguimos guardando.' }),
    boton('Terminar mi cuenta', '/'),
  ]),
  listo: (alCanjear) => tarjeta([
    icono('enlace', 'icono'),
    el('h2', { texto: 'Tienes un enlace de evento' }),
    el('p', { texto: 'Cada enlace solo lo puede canjear una persona. Si lo canjeas, te llevas un banner o un lema para tu perfil público.' }),
    el('button', { clase: 'btn', texto: 'Canjear', attrs: { type: 'button' }, on: { click: alCanjear } }),
  ]),
  // Comprobando: lo decide el worker, y tarda unos minutos.
  pendiente: () => tarjeta([
    el('h2', { texto: 'Comprobando tu enlace' }),
    el('p', { texto: 'Esto tarda unos minutos. Puedes cerrar la página: si tienes los avisos activados, te avisamos cuando esté.' }),
    el('div', { clase: 'esqueleto', attrs: { 'aria-hidden': 'true' }, estilo: { height: '84px' } }),
  ]),
  ocupado: () => tarjeta([
    el('h2', { texto: 'Ya hay otro canje en marcha' }),
    el('p', { texto: 'Hasta que termine (unos minutos) no se puede pedir otro. Cuando acabe, vuelve a abrir este enlace: lo seguimos guardando.' }),
    boton('Volver', '/yo/'),
  ]),
  ok: (recompensa) => tarjeta([
    icono('check', 'icono'),
    el('h2', { texto: '¡Conseguido!' }),
    premio(recompensa),
    el('p', { texto: 'Ya puedes ponértelo en tu perfil público.' }),
    boton('Ponérmelo', '/yo/#perfil'),
  ], 'canje-ok'),
  'ya-lo-tenias': () => tarjeta([
    icono('check', 'icono'),
    el('h2', { texto: 'Esto ya lo tenías' }),
    el('p', { texto: 'No hemos gastado el enlace: se lo puedes pasar a otra persona.' }),
    boton('Ver mi perfil público', '/yo/#perfil'),
  ]),
  usado: () => tarjeta([
    icono('aviso', 'icono'),
    el('h2', { texto: 'Este enlace ya lo ha usado otra persona' }),
    el('p', { texto: 'Cada enlace vale una sola vez. Si crees que es un error, escríbenos.' }),
    boton('Volver', '/yo/'),
  ]),
  invalido: () => tarjeta([
    icono('aviso', 'icono'),
    el('h2', { texto: 'Este enlace no vale' }),
    el('p', { texto: 'No existe o está mal copiado. Prueba a abrirlo otra vez desde donde te lo dieron.' }),
    boton('Volver', '/yo/'),
  ]),
};

const pintar = (nombre, dato) => reemplazar(destino, PANTALLAS[nombre](dato));

/** Escucha UN documento (no una coleccion): solo cambia cuando el worker lo resuelve. */
function esperar(usuario) {
  const parar = onSnapshot(doc(db, 'canjes_recompensa', usuario.uid), (snap) => {
    const d = snap.data();
    // Un resultado viejo de otro enlace no es el de este.
    if (!d || d.codigo !== codigo) return;
    if (d.estado === 'pendiente') { pintar('pendiente'); return; }
    if (!PANTALLAS[d.estado]) return;
    pintar(d.estado, d.recompensa);
    olvidarCanje();
    parar();
  }, () => pintar('invalido'));
}

/** Pide el canje y se queda mirando su documento hasta que el worker lo resuelve. */
async function canjear(usuario) {
  pintar('pendiente');
  try {
    // `setDoc` y no `updateDoc`: las reglas piden el documento ENTERO, sin
    // restos de un canje anterior.
    await setDoc(doc(db, 'canjes_recompensa', usuario.uid), { codigo, estado: 'pendiente', creado: serverTimestamp() });
  } catch (error) {
    console.debug('No se ha podido pedir el canje', error);
    pintar('invalido');
    return;
  }
  olvidarCanje();
  esperar(usuario);
}

onAuthStateChanged(auth, async (usuario) => {
  if (!codigo) { pintar('sin-enlace'); return; }
  if (!usuario) { guardarCanje(codigo); pintar('sin-sesion'); return; }

  let perfil = null;
  try { perfil = await getDoc(doc(db, 'usuarios', usuario.uid)); } catch { /* se pinta como sin perfil */ }
  if (!perfil?.exists()) { guardarCanje(codigo); pintar('sin-perfil'); return; }

  // Si ya hay un canje con este mismo codigo (se recargo la pagina), se sigue
  // donde estaba en vez de pedirlo otra vez.
  try {
    const previo = await getDoc(doc(db, 'canjes_recompensa', usuario.uid));
    if (previo.exists() && previo.data().codigo === codigo) {
      if (previo.data().estado === 'pendiente') { pintar('pendiente'); esperar(usuario); return; }
      pintar(previo.data().estado, previo.data().recompensa);
      olvidarCanje();
      return;
    }
    if (previo.exists() && previo.data().estado === 'pendiente') {
      // Otro enlace esperando: hasta que no se resuelva no se puede pedir otro.
      pintar('ocupado');
      return;
    }
  } catch { /* sin permiso o sin red: se deja canjear igualmente */ }

  guardarCanje(codigo);
  pintar('listo', () => canjear(usuario));
});
