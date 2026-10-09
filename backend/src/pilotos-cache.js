'use strict';

/**
 * Los pilotos para reconstruir los agregados, sin leer `usuarios` entera cada
 * vez.
 *
 * Cada reconstruccion necesita a TODOS los pilotos (los rankings, los grupos
 * de liga y los nombres de cada ruta), y hasta ahora los leia uno a uno: con
 * 1.000 pilotos, 1.000 lecturas por reconstruccion y hasta 96 al dia — lo mas
 * caro del worker con diferencia (docs/COSTE.md).
 *
 * Aqui se guardan en documentos aparte (`config/pilotos_N`, unos 80 por
 * documento, solo los campos que usan los agregados). Una lectura trae 80
 * pilotos. Y entre dos lecturas completas solo se vuelven a leer los pilotos
 * que el worker sabe que han cambiado: los de los viajes que ha sumado o
 * revertido.
 *
 * Lo que el worker NO ve (alguien cambia de clan desde el navegador, una
 * baja, una suspension) se recoge igual, de dos maneras: las operaciones que lo
 * saben —cierre de liga o temporada, borrado de cuenta— invalidan la cache, y
 * una lectura completa se repite como mucho cada `MAX_EDAD_MS`.
 *
 * Va en `config/` y no en `agregados/` a proposito: `agregados` lo lee cualquiera
 * sin sesion y esto lleva datos de pilotos que no son publicos.
 */

const admin = require('firebase-admin');
const { db } = require('./db');

const META = 'config/pilotos_meta';
const pagina = (n) => `config/pilotos_${n}`;

/** Pilotos por documento. Con la foto en miniatura (3 KB) son ~250 KB: de sobra por debajo de 1 MiB. */
const POR_PAGINA = 80;

/** Cada cuanto se relee `usuarios` entera aunque nadie haya invalidado nada. */
const MAX_EDAD_MS = 2 * 3600 * 1000;

/** Lo unico que usan los agregados. Nada de correos, avisos ni consentimientos. */
const CAMPOS = [
  'username', 'avatarUrl', 'fotoMini', 'division', 'grupoLiga', 'clanId', 'suspendido',
  'biciRating', 'viajesVerificados', 'puntosPorRuta', 'metrosTotales',
  'racha', 'mejorRacha', 'puntosLiga',
];

/** Un documento de `usuarios`, reducido a lo que se guarda. */
function proyectar(datos = {}) {
  const salida = {};
  for (const campo of CAMPOS) {
    if (datos[campo] !== undefined && datos[campo] !== null) salida[campo] = datos[campo];
  }
  return salida;
}

async function leerTodos() {
  const snap = await db().collection('usuarios').get();
  return snap.docs.map((d) => ({ uid: d.id, ...proyectar(d.data()) }));
}

/** Escribe todo de cero y quita las paginas que sobren. */
async function guardarCompleto(pilotos) {
  const paginas = Math.max(1, Math.ceil(pilotos.length / POR_PAGINA));
  const previo = await db().doc(META).get();
  const antes = previo.exists ? previo.data().paginas || 0 : 0;

  for (let i = 0; i < paginas; i++) {
    const trozo = {};
    for (const { uid, ...resto } of pilotos.slice(i * POR_PAGINA, (i + 1) * POR_PAGINA)) trozo[uid] = resto;
    await db().doc(pagina(i + 1)).set({ pilotos: trozo });
  }
  for (let i = paginas + 1; i <= antes; i++) await db().doc(pagina(i)).delete();

  await db().doc(META).set({
    paginas,
    total: pilotos.length,
    invalida: false,
    completoEn: Date.now(),
    actualizado: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Los pilotos al dia.
 *
 * @param {{tocados?: Iterable<string>, completos?: Array|null}} opciones
 *   `tocados`: uids cuyo documento ha cambiado desde la ultima vez.
 *   `completos`: si quien llama ya ha leido `usuarios` entera (el resumen de
 *   metricas la lee cada seis horas), se aprovecha y de paso se refresca la cache.
 * @returns {Promise<Array<{uid: string}>>}
 */
async function cargar({ tocados = [], completos = null } = {}) {
  if (completos) {
    const reducidos = completos.map(({ uid, ...resto }) => ({ uid, ...proyectar(resto) }));
    await guardarCompleto(reducidos);
    return reducidos;
  }

  const metaSnap = await db().doc(META).get();
  const meta = metaSnap.exists ? metaSnap.data() : null;
  const caducada = !meta || meta.invalida === true || !(meta.paginas > 0)
    || Date.now() - (meta.completoEn || 0) > MAX_EDAD_MS;

  const completa = async () => {
    const todos = await leerTodos();
    await guardarCompleto(todos);
    return todos;
  };
  if (caducada) return completa();

  const refs = Array.from({ length: meta.paginas }, (_, i) => db().doc(pagina(i + 1)));
  const docs = await db().getAll(...refs);
  // Una pagina que falta es una cache a medias: mas vale leerlo todo.
  if (docs.some((d) => !d.exists)) return completa();

  const paginas = docs.map((d) => ({ ...(d.data().pilotos || {}) }));
  const dondeEsta = new Map();
  paginas.forEach((p, i) => { for (const uid of Object.keys(p)) dondeEsta.set(uid, i); });

  const uids = [...new Set([...tocados].filter(Boolean).map(String))];
  const sucias = new Set();
  if (uids.length) {
    const cambiados = await db().getAll(...uids.map((uid) => db().doc(`usuarios/${uid}`)));
    for (const d of cambiados) {
      const i = dondeEsta.get(d.id);
      if (!d.exists) {
        if (i !== undefined) { delete paginas[i][d.id]; dondeEsta.delete(d.id); sucias.add(i); }
        continue;
      }
      const reducido = proyectar(d.data());
      if (i !== undefined) {
        paginas[i][d.id] = reducido;
        sucias.add(i);
        continue;
      }
      // Alguien nuevo: a la pagina con sitio, o a una nueva.
      let destino = paginas.findIndex((p) => Object.keys(p).length < POR_PAGINA);
      if (destino < 0) { paginas.push({}); destino = paginas.length - 1; }
      paginas[destino][d.id] = reducido;
      dondeEsta.set(d.id, destino);
      sucias.add(destino);
    }
  }

  if (sucias.size) {
    for (const i of sucias) await db().doc(pagina(i + 1)).set({ pilotos: paginas[i] });
    if (paginas.length !== meta.paginas) {
      await db().doc(META).set({ paginas: paginas.length }, { merge: true });
    }
  }

  return paginas.flatMap((p) => Object.entries(p).map(([uid, resto]) => ({ uid, ...resto })));
}

/** Obliga a que la proxima carga lea `usuarios` entera. Una escritura. */
async function invalidar() {
  await db().doc(META).set({ invalida: true }, { merge: true });
}

module.exports = { cargar, invalidar, proyectar, POR_PAGINA, MAX_EDAD_MS, CAMPOS };
