/**
 * Bicirating (11 · Bicis): lo comun a la encuesta y al buscador.
 *
 * La ficha de cada bici (`bicis/{numero}`) la escribe el worker juntando las
 * valoraciones (backend/src/bicis.js); aqui solo se lee y se pinta.
 */

import { db, auth, doc, getDoc, setDoc, serverTimestamp } from './firebase.js';

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
export async function guardarValoracion({ bici, nota, fallos = [], comentario = '', viajeId, estacion }) {
  const uid = auth.currentUser?.uid;
  const n = normalizarBici(bici);
  if (!uid || !n) throw new Error('Falta el número de la bici.');
  await setDoc(doc(db, 'valoraciones_bici', idValoracion(n, uid)), {
    bici: n,
    uid,
    dia: diaUTC(),
    nota,
    fallos: [...new Set(fallos)].filter((f) => NOMBRE_FALLO[f]),
    comentario: String(comentario || '').trim().slice(0, 280),
    viajeId,
    estacion: String(estacion || ''),
    procesada: false,
    creado: serverTimestamp(),
  });
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
