'use strict';

/**
 * Bicirating (11 · Bicis): la ficha publica de cada bici.
 *
 * Al subir un trayecto, quien lo ha hecho puede valorar la bici que uso: una
 * nota de 1 a 5, los fallos que noto y un comentario. Cada valoracion es un
 * documento privado (`valoraciones_bici`, solo lo lee su autor). El worker las
 * junta en `bicis/{numero}`, que lee cualquiera y NO lleva autor: ni uid ni
 * nombre. Eso es lo que hace que sea anonimo de verdad y no solo "no se
 * enseña".
 *
 * Aqui solo hay funciones puras. Leer y escribir es cosa del worker.
 */

const { contienePalabrasProhibidas } = require('./badwords');

/** Los fallos que se pueden marcar. Mismos codigos en reglas y navegador. */
const FALLOS = ['frenos', 'asistencia', 'bateria', 'cambios', 'ruido', 'sillin', 'luces', 'cesta', 'rueda'];

/** La media se calcula sobre este tramo; lo de antes ya no dice como esta hoy. */
const VENTANA_DIAS = 60;
/** Por debajo, no hay media: una sola opinion no es una nota. */
const MINIMO_PARA_MEDIA = 3;
/** Cuantas valoraciones sueltas se publican. El navegador las pagina de 10 en 10. */
const MAX_ULTIMAS = 50;
/** Valoraciones seguidas sin mencionar un fallo para darlo por arreglado. */
const RESUELTO_TRAS = 3;

const DIA_MS = 86400000;

/**
 * "02471" y "2471" son la misma bici. Se guarda sin ceros delante (asi lo
 * exigen tambien las reglas) y se enseña con cuatro cifras.
 */
const normalizarBici = (n) => {
  const limpio = String(n ?? '').trim().replace(/^0+(?=\d)/, '');
  return /^[1-9]\d{0,4}$/.test(limpio) ? limpio : null;
};

const redondear = (x) => Math.round(x * 10) / 10;

/** Invisibles y espacios raros fuera; el texto se pinta siempre como texto. */
function limpiarComentario(texto) {
  const t = String(texto || '')
    .replace(/[\u0000-\u001F\u007F​-‏‪-‮⁠-⁯﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
  if (!t) return '';
  // Un insulto no se publica. La nota y los fallos si: siguen siendo utiles.
  return contienePalabrasProhibidas(t) ? '' : t;
}

const milis = (v) => (typeof v?.toMillis === 'function' ? v.toMillis() : v instanceof Date ? v.getTime() : Number(v) || 0);

function media(lista) {
  return lista.length ? redondear(lista.reduce((s, v) => s + v.nota, 0) / lista.length) : null;
}

/**
 * La ficha de una bici a partir de sus valoraciones (las de los ultimos meses).
 *
 * @param {Array<{nota:number, fallos?:string[], comentario?:string, estacion?:string, creado:any}>} valoraciones
 * @param {{ahora?: number, vista?: {estacion:string, cuando:any}|null}} opciones
 */
function resumirBici(valoraciones, { ahora = Date.now(), vista = null } = {}) {
  const validas = valoraciones
    // Las que se hicieron sin viaje y cuya captura no demostraba esa bici
    // (worker.js, procesarValoraciones) no cuentan.
    .filter((v) => !v.rechazada)
    .filter((v) => Number.isInteger(v.nota) && v.nota >= 1 && v.nota <= 5)
    .map((v) => ({ ...v, t: milis(v.creado) }))
    .sort((a, b) => b.t - a.t);

  const recientes = validas.filter((v) => ahora - v.t <= VENTANA_DIAS * DIA_MS);
  // La de hace un mes: mismo tramo de 60 dias, pero terminado hace 30. Es lo
  // que permite decir "bajando (3,1 hace un mes)".
  const antes = validas.filter((v) => ahora - v.t > 30 * DIA_MS && ahora - v.t <= (VENTANA_DIAS + 30) * DIA_MS);

  const reparto = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const v of recientes) reparto[v.nota]++;

  const cuentaFallos = {};
  for (const v of recientes) {
    for (const f of new Set(v.fallos || [])) if (FALLOS.includes(f)) cuentaFallos[f] = (cuentaFallos[f] || 0) + 1;
  }
  // Un fallo deja de estar roto cuando las 3 valoraciones posteriores a la
  // ultima que lo menciona ya no lo dicen: alguien lo aviso, y despues tres
  // personas la han usado sin notarlo (se habra arreglado).
  const posteriores = (codigo) => validas.findIndex((v) => (v.fallos || []).includes(codigo));
  const resueltos = Object.keys(cuentaFallos).filter((c) => posteriores(c) >= RESUELTO_TRAS);
  const fallos = Object.entries(cuentaFallos)
    .filter(([codigo]) => !resueltos.includes(codigo))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([codigo, veces]) => ({ codigo, veces }));

  const hayMedia = recientes.length >= MINIMO_PARA_MEDIA;
  const mediaAntes = antes.length >= MINIMO_PARA_MEDIA ? media(antes) : null;
  const mediaAhora = hayMedia ? media(recientes) : null;

  // La ultima estacion donde se vio: la de la valoracion o el viaje mas recientes.
  const ultimaValorada = validas.find((v) => v.estacion);
  let vistaFinal = ultimaValorada ? { estacion: ultimaValorada.estacion, cuando: ultimaValorada.t } : null;
  if (vista && milis(vista.cuando) > (vistaFinal?.cuando || 0)) vistaFinal = { estacion: vista.estacion, cuando: milis(vista.cuando) };

  return {
    // Solo con 3 o mas: con menos, se enseñan las opiniones sueltas (11e).
    media: mediaAhora,
    valoraciones60: recientes.length,
    total: validas.length,
    reparto,
    fallos,
    resueltos,
    tendencia: mediaAhora !== null && mediaAntes !== null
      ? { antes: mediaAntes, direccion: mediaAhora > mediaAntes + 0.2 ? 'subiendo' : mediaAhora < mediaAntes - 0.2 ? 'bajando' : 'igual' }
      : null,
    // Sin autor. Ni uid, ni nombre, ni el id del viaje.
    ultimas: validas.slice(0, MAX_ULTIMAS).map((v) => ({
      nota: v.nota,
      fallos: (v.fallos || []).filter((f) => FALLOS.includes(f)),
      comentario: v.comentarioPublico ?? limpiarComentario(v.comentario),
      estacion: v.estacion || null,
      cuando: v.t,
    })),
    vista: vistaFinal,
    actualizado: ahora,
  };
}

/**
 * Rehace `bicis/{numero}` leyendo sus valoraciones de los ultimos 90 dias (60
 * para la media y 30 mas para la tendencia). Lo usan el worker y el borrado de
 * cuenta: quien se va se lleva tambien sus comentarios de la ficha publica.
 */
async function rehacerBici(db, numero, { ahora = Date.now() } = {}) {
  const n = normalizarBici(numero);
  if (!n) return null;
  const desde = new Date(ahora - (VENTANA_DIAS + 30) * DIA_MS);
  const [valoraciones, previo] = await Promise.all([
    db.collection('valoraciones_bici')
      .where('bici', '==', n)
      .where('creado', '>=', desde)
      .orderBy('creado', 'desc')
      .limit(300)
      .get(),
    db.doc(`bicis/${n}`).get(),
  ]);
  const ficha = resumirBici(valoraciones.docs.map((d) => d.data()), {
    ahora, vista: previo.exists ? previo.data().vista || null : null,
  });
  await db.doc(`bicis/${n}`).set({ numero: n, ...ficha });
  return ficha;
}

module.exports = {
  FALLOS, VENTANA_DIAS, MINIMO_PARA_MEDIA, MAX_ULTIMAS, RESUELTO_TRAS,
  normalizarBici, limpiarComentario, resumirBici, rehacerBici,
};
