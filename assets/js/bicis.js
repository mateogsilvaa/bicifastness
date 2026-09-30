/**
 * Bicirating (11 · Bicis): lo comun a la encuesta y al buscador.
 *
 * La ficha de cada bici (`bicis/{numero}`) la escribe el worker juntando las
 * valoraciones (backend/src/bicis.js); aqui solo se lee y se pinta.
 */

import { db, auth, doc, getDoc, setDoc, serverTimestamp, writeBatch } from './firebase.js';

/** Los fallos que se pueden marcar. Mismos codigos que las reglas y el worker. */
export const FALLOS = [
  ['frenos', 'Frenos'], ['asistencia', 'Asistencia'], ['bateria', 'Batería baja'],
  ['cambios', 'Cambios'], ['ruido', 'Ruido'], ['sillin', 'Sillín'],
  ['luces', 'Luces'], ['cesta', 'Cesta o candado'], ['rueda', 'Rueda pinchada'],
];
export const NOMBRE_FALLO = Object.fromEntries(FALLOS);

export const NOTAS = ['Fatal', 'Mal', 'Normal', 'Bien', 'Genial'];

/** Por debajo, sin media: se enseñan las opiniones sueltas (11e). */
export const MINIMO_PARA_MEDIA = 3;

/** "02471" y "2471" son la misma bici; se guarda sin ceros delante. */
export function normalizarBici(n) {
  const limpio = String(n ?? '').trim().replace(/^0+(?=\d)/, '');
  return /^[1-9]\d{0,4}$/.test(limpio) ? limpio : null;
}

/** Con cuatro cifras, como en la pegatina. */
export const mostrarBici = (n) => String(n ?? '').padStart(4, '0');

/** 4,0 o mas verde; de 2,5 a 3,9 ambar; por debajo, rojo. Siempre con la cifra. */
export const tonoNota = (v) => (v == null ? '' : v >= 4 ? 'bien' : v >= 2.5 ? 'medio' : 'mal');

export const cifra = (v) => (v == null ? '–' : Number(v).toFixed(1).replace('.', ','));

/** El dia UTC, que es el que exigen las reglas para "una por piloto y bici al dia". */
export const diaUTC = () => Math.floor(Date.now() / 86400000);

export const idValoracion = (bici, uid) => `${bici}_${uid}_${diaUTC()}`;

/** La ficha publica de una bici, o null si nadie la ha valorado ni visto. */
export async function leerFicha(numero) {
  const n = normalizarBici(numero);
  if (!n) return null;
  const snap = await getDoc(doc(db, 'bicis', n));
  return snap.exists() ? snap.data() : null;
}

/** Mi valoracion de hoy de esa bici, si la hay. */
export async function miValoracionDeHoy(numero) {
  const uid = auth.currentUser?.uid;
  const n = normalizarBici(numero);
  if (!uid || !n) return null;
  try {
    const snap = await getDoc(doc(db, 'valoraciones_bici', idValoracion(n, uid)));
    return snap.exists() ? snap.data() : null;
  } catch {
    return null; // no existe: las reglas no dejan leer lo que no es de nadie
  }
}

/**
 * Guarda (o cambia, el mismo dia) la valoracion. Exactamente los campos que
 * pide la regla de `valoraciones_bici`.
 */
export async function guardarValoracion({ bici, nota, fallos = [], comentario = '', viajeId, estacion, captura = null }) {
  const uid = auth.currentUser?.uid;
  const n = normalizarBici(bici);
  if (!uid || !n) throw new Error('Falta el número de la bici.');
  const datos = {
    bici: n,
    uid,
    dia: diaUTC(),
    nota,
    fallos: [...new Set(fallos)].filter((f) => NOMBRE_FALLO[f]),
    comentario: String(comentario || '').trim().slice(0, 280),
    estacion: String(estacion || '').slice(0, 4),
    procesada: false,
    creado: serverTimestamp(),
  };
  if (!captura) {
    await setDoc(doc(db, 'valoraciones_bici', idValoracion(n, uid)), { ...datos, viajeId });
    return;
  }

  // Sin viaje (11): la captura del trayecto va de prueba, en el mismo lote y
  // con el mismo cupo que las de los viajes. El worker la lee (tiene que ser
  // esta bici y de hace menos de un mes) y la borra.
  const dia = diaUTC();
  const cupoRef = doc(db, 'cupos', uid);
  const previo = (await getDoc(cupoRef)).data();
  const actual = previo && previo.dia === dia ? previo : { dia, viajes: 0, capturas: 0 };
  const capturaId = `${uid}_${dia}_c${(actual.capturas || 0) + 1}`;
  const lote = writeBatch(db);
  lote.set(doc(db, 'capturas', capturaId), { uid, datos: captura, creado: serverTimestamp() });
  lote.set(cupoRef, { dia, viajes: actual.viajes || 0, capturas: (actual.capturas || 0) + 1 });
  lote.set(doc(db, 'valoraciones_bici', idValoracion(n, uid)), { ...datos, capturaId });
  await lote.commit();
}

/** La nota que se enseña: la media si hay 3 o mas, y si no, la de las que haya. */
export function notaDeFicha(ficha) {
  if (ficha?.media != null) return ficha.media;
  const notas = (ficha?.ultimas || []).map((v) => v.nota).filter(Number.isFinite);
  return notas.length ? notas.reduce((a, b) => a + b, 0) / notas.length : null;
}

// --- Estrellas --------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const RUTA_ESTRELLA = 'M12 2.6l2.9 6 6.5.9-4.8 4.5 1.2 6.5L12 17.4l-5.8 3.1 1.2-6.5-4.8-4.5 6.5-.9z';

function estrellaSvg(tam) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(tam));
  svg.setAttribute('height', String(tam));
  svg.setAttribute('aria-hidden', 'true');
  const ruta = document.createElementNS(SVG_NS, 'path');
  ruta.setAttribute('d', RUTA_ESTRELLA);
  svg.append(ruta);
  return svg;
}

/** Cinco estrellas rellenas hasta `valor` (admite decimales: 3,6 son 3 y media larga). */
export function estrellas(valor, { tam = 18 } = {}) {
  const fila = (clase) => {
    const capa = document.createElement('span');
    capa.className = `estrellas-capa ${clase}`;
    for (let i = 0; i < 5; i++) capa.append(estrellaSvg(tam));
    return capa;
  };
  const caja = document.createElement('span');
  caja.className = 'estrellas';
  caja.setAttribute('role', 'img');
  caja.setAttribute('aria-label', valor == null ? 'Sin nota' : `${cifra(valor)} de 5 estrellas`);
  const llenas = fila('llenas');
  llenas.style.width = `${Math.max(0, Math.min(5, Number(valor) || 0)) * 20}%`;
  caja.append(fila('vacias'), llenas);
  return caja;
}

/** Cinco estrellas que se tocan para dar la nota (1 a 5). */
export function selectorEstrellas(valor, alElegir, { deshabilitado = false, tam = 36 } = {}) {
  const grupo = document.createElement('div');
  grupo.className = 'selector-estrellas';
  grupo.setAttribute('role', 'radiogroup');
  grupo.setAttribute('aria-label', 'Nota de la bici');
  const botones = [];
  const marcar = (hasta) => botones.forEach((b, i) => b.classList.toggle('encendida', i < hasta));
  for (let v = 1; v <= 5; v++) {
    const boton = document.createElement('button');
    boton.type = 'button';
    boton.className = 'estrella-boton';
    boton.setAttribute('role', 'radio');
    boton.setAttribute('aria-checked', String(valor === v));
    boton.setAttribute('aria-label', `${v} ${v === 1 ? 'estrella' : 'estrellas'} · ${NOTAS[v - 1]}`);
    if (deshabilitado) boton.disabled = true;
    boton.append(estrellaSvg(tam));
    boton.addEventListener('click', () => alElegir(v));
    boton.addEventListener('pointerenter', () => marcar(v));
    boton.addEventListener('pointerleave', () => marcar(valor || 0));
    botones.push(boton);
    grupo.append(boton);
  }
  marcar(valor || 0);
  return grupo;
}

/** Hace cuanto, en palabras cortas. */
export function haceTiempo(ms) {
  if (!ms) return '';
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 60) return min <= 1 ? 'ahora mismo' : `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  if (d === 1) return 'ayer';
  if (d < 7) return `hace ${d} días`;
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' }).format(new Date(ms));
}

// --- Buscadas (solo en este navegador) ---------------------------------------

const CLAVE_BUSCADAS = 'bf_bicis_buscadas';

export function buscadas() {
  try {
    const lista = JSON.parse(localStorage.getItem(CLAVE_BUSCADAS) || '[]');
    return Array.isArray(lista) ? lista.filter((x) => normalizarBici(x.n)).slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function recordarBuscada(n, media) {
  try {
    const lista = buscadas().filter((x) => x.n !== n);
    lista.unshift({ n, media: media ?? null });
    localStorage.setItem(CLAVE_BUSCADAS, JSON.stringify(lista.slice(0, 8)));
  } catch { /* sin almacenamiento, sin historial */ }
}
