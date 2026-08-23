'use strict';

/**
 * Documentos agregados: lo que lee el navegador.
 *
 * El navegador no calcula nada ni recorre colecciones. El worker precalcula y
 * deja el resultado servido, y una pantalla pasa de cientos de lecturas a unas
 * pocas. Dos motivos, y el segundo es el que de verdad manda:
 *
 * 1. COSTE. El plan Spark da 50.000 lecturas al dia. Pintar el ranking leyendo
 *    `usuarios` entero son 175 lecturas por visita: 285 visitas y se acabo el
 *    dia.
 *
 * 2. PRIVACIDAD. `usuarios` lleva datos que no son de nadie mas, y por eso esta
 *    cerrada (#60). Un agregado contiene SOLO lo que se pinta: nombre, avatar y
 *    puntos. Nunca correo, ni uid en claro, ni nada que no salga ya en la
 *    pantalla.
 *
 * Esa segunda regla no es una recomendacion: hay un test que falla si un
 * agregado contiene un campo que no este en la lista blanca de abajo.
 */

const admin = require('firebase-admin');

const db = () => admin.firestore();

/**
 * Lo UNICO que puede viajar a un documento de lectura publica.
 *
 * Si hace falta un campo nuevo, se anade aqui a proposito y se piensa si es
 * publicable. Sin lista blanca, el dia que alguien meta el objeto de usuario
 * entero "para no repetir codigo", el correo vuelve a estar publicado.
 */
const CAMPOS_PUBLICABLES = ['pos', 'nombre', 'avatar', 'clan', 'puntos', 'marca', 'viajes'];

/**
 * Un documento de Firestore tiene un tope duro de 1 MiB. Un ranking largo no
 * cabe, asi que se parte en paginas. 200 filas por pagina van holgadas y son
 * mas de las que nadie mira de una sentada.
 */
const POR_PAGINA = 200;

/** Deja una fila con solo los campos publicables. */
function limpiar(fila) {
  const salida = {};
  for (const campo of CAMPOS_PUBLICABLES) {
    if (fila[campo] !== undefined && fila[campo] !== null) salida[campo] = fila[campo];
  }
  return salida;
}

/**
 * Escribe un agregado, partiendolo en paginas si hace falta.
 * Devuelve cuantas paginas ha escrito.
 */
async function escribirAgregado(nombre, filas, extra = {}) {
  const limpias = filas.map(limpiar);
  const paginas = Math.max(1, Math.ceil(limpias.length / POR_PAGINA));

  for (let i = 0; i < paginas; i++) {
    const id = i === 0 ? nombre : `${nombre}-p${i + 1}`;
    await db().doc(`agregados/${id}`).set({
      ...extra,
      filas: limpias.slice(i * POR_PAGINA, (i + 1) * POR_PAGINA),
      pagina: i + 1,
      paginas,
      total: limpias.length,
      // Se ensena como "actualizado hace X": un agregado sin fecha no se
      // distingue de uno que lleva tres dias congelado por un worker caido.
      actualizado: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  return paginas;
}

/**
 * Reconstruye todos los agregados de una vez.
 *
 * Se le pasan los datos ya leidos porque el worker los tiene en la mano tras el
 * recalculo: volver a pedirlos aqui duplicaria la lectura mas cara que hace.
 *
 * @param {Array} usuarios  documentos de usuarios, con uid
 * @param {Array} viajes    viajes verificados
 * @param {Array} clanes    documentos de clanes, con id
 * @param {Map}   estaciones  id de estacion -> stats
 */
async function reconstruir({ usuarios = [], viajes = [], clanes = [], estaciones = new Map() }) {
  const escritos = {};

  // --- Pilotos, por modo -----------------------------------------------------
  //
  // Los tres modos de docs/JUEGO.md. Que existan por separado es el cambio que
  // hace que el juego deje de ser solo de velocistas: un fondista se ve primero
  // en Fondo aunque este el ultimo en Sprint, y por eso se queda.
  //
  // El de la pestaña "Pilotos" del diseño es el general; los otros tres son un
  // filtro dentro de esa misma pestaña.
  const MODOS = {
    general: {
      // Suma de todo: es el numero publico del piloto.
      valor: (u) => u.biciRating || 0,
      extra: (u) => u.viajesVerificados || 0,
    },
    sprint: {
      // Solo los puntos por posicion en tramos: premia el tiempo.
      valor: (u) => Object.values(u.puntosPorRuta || {}).reduce((t, p) => t + p, 0),
      extra: (u) => Object.keys(u.puntosPorRuta || {}).length,
    },
    fondo: {
      // Kilometros, redondeados: el numero que mira un fondista.
      valor: (u) => Math.round((u.metrosTotales || 0) / 1000),
      extra: (u) => u.viajesVerificados || 0,
    },
    constancia: {
      // La mejor racha, no la actual: premia haber sostenido el habito, no el
      // momento concreto en que se mire la tabla.
      valor: (u) => u.mejorRacha || 0,
      extra: (u) => u.racha || 0,
    },
  };

  let pilotos = [];

  for (const [modo, { valor, extra }] of Object.entries(MODOS)) {
    const tabla = usuarios
      .map((u) => ({ u, puntos: valor(u) }))
      .filter(({ puntos }) => puntos > 0)
      .sort((a, b) => b.puntos - a.puntos)
      .map(({ u, puntos }, i) => ({
        pos: i + 1,
        nombre: u.username || 'Piloto',
        avatar: u.avatarUrl || null,
        clan: u.clanId || null,
        puntos,
        viajes: extra(u),
      }));

    await escribirAgregado(`ranking-${modo}`, tabla, { modo });
    if (modo === 'general') pilotos = tabla;
  }

  escritos.modos = Object.keys(MODOS).length;

  // --- Clanes ----------------------------------------------------------------
  const dominadas = new Map();
  for (const stats of estaciones.values()) {
    if (!stats.clanDominante) continue;
    dominadas.set(stats.clanDominante, (dominadas.get(stats.clanDominante) || 0) + 1);
  }

  const tablaClanes = clanes
    .sort((a, b) => (b.biciRating || 0) - (a.biciRating || 0))
    .map((c, i) => ({
      pos: i + 1,
      nombre: c.nombre || c.id,
      puntos: c.biciRating || 0,
      viajes: c.numMiembros || 0,
      marca: String(dominadas.get(c.id) || 0),
    }));

  escritos.clanes = await escribirAgregado('ranking-clanes', tablaClanes);

  // --- Rutas -----------------------------------------------------------------
  // Solo el mejor tiempo de cada piloto compite: si no, quien sube diez veces la
  // misma ruta ocupa medio podio.
  const nombrePorUid = new Map(usuarios.map((u) => [u.uid, u]));
  const porRuta = new Map();

  for (const v of viajes) {
    if (!v.ruta) continue;
    if (!porRuta.has(v.ruta)) porRuta.set(v.ruta, new Map());
    const mejores = porRuta.get(v.ruta);
    const previo = mejores.get(v.uid);
    if (!previo || v.tiempoSegundos < previo.tiempoSegundos) mejores.set(v.uid, v);
  }

  let rutasEscritas = 0;
  for (const [ruta, mejores] of porRuta) {
    const filas = [...mejores.values()]
      .sort((a, b) => a.tiempoSegundos - b.tiempoSegundos)
      .map((v, i) => {
        const piloto = nombrePorUid.get(v.uid);
        return {
          pos: i + 1,
          nombre: piloto?.username || v.username || 'Piloto',
          avatar: piloto?.avatarUrl || null,
          clan: piloto?.clanId || null,
          marca: v.tiempoSegundos,
        };
      });

    // El id lleva la ruta dentro, asi que una pantalla pide exactamente la que
    // le hace falta y no las 600.
    await escribirAgregado(`ruta-${ruta}`, filas, { ruta });
    rutasEscritas++;
  }
  escritos.rutas = rutasEscritas;

  // --- Indice de rutas -------------------------------------------------------
  // El selector de `/clasificacion/` necesita saber que rutas existen sin leer
  // los 600 agregados de ruta.
  await db().doc('agregados/rutas').set({
    rutas: [...porRuta.keys()].sort(),
    actualizado: admin.firestore.FieldValue.serverTimestamp(),
  });

  // --- Mapa ------------------------------------------------------------------
  // Un documento en vez de ~600 lecturas de `estaciones_stats`.
  const mapa = {};
  let conDueno = 0;
  let enDisputa = 0;

  for (const [id, stats] of estaciones) {
    // Las estaciones donde no tiene influencia nadie no se incluyen. Son la
    // inmensa mayoria al principio, y no hay nada que contar de ellas: el mapa
    // las pinta en gris por ausencia. Meterlas es pagar bytes por nada, y aqui
    // los bytes son el limite.
    if (!Object.keys(stats.cuota || {}).length) continue;

    mapa[id] = {
      // `clan` es quien CONTROLA (mas del 50%); `lider` es quien va primero.
      // No son lo mismo, y la diferencia es justo lo interesante del mapa: una
      // estacion con lider pero sin dueño esta en disputa, o sea que ahi hay
      // algo que hacer.
      clan: stats.clanDominante || null,
      lider: stats.lider || null,
      disputa: Boolean(stats.enDisputa),
      cuota: stats.cuota || {},
    };

    if (stats.clanDominante) conDueno++;
    if (stats.enDisputa) enDisputa++;
  }

  const documentoMapa = {
    estaciones: mapa,
    // Color y nombre de cada clan, para no tener que leer `clanes` ademas. SOLO
    // eso: ni miembros, ni lider, ni puntuacion. Este documento lo lee
    // cualquiera sin sesion (#60).
    clanes: Object.fromEntries(clanes.map((c) => [c.id, {
      nombre: c.nombre || c.id,
      color: c.color || null,
    }])),
    // Para la leyenda: cuantas estan en juego y cuantas tienen dueño, sin tener
    // que recorrer el mapa entero en el navegador.
    resumen: { conInfluencia: Object.keys(mapa).length, conDueno, enDisputa },
    actualizado: admin.firestore.FieldValue.serverTimestamp(),
  };

  // Un documento de Firestore tiene un tope duro de 1 MiB. Con 631 estaciones y
  // varios clanes en cada una cabe de sobra, pero si algun dia deja de caber
  // conviene enterarse aqui y no cuando la escritura falle en produccion con el
  // mapa lleno y la partida en marcha.
  const bytesMapa = Buffer.byteLength(JSON.stringify(documentoMapa), 'utf8');
  if (bytesMapa > 900000) {
    throw new Error(`el agregado del mapa ocupa ${bytesMapa} bytes: no cabe en un documento`);
  }

  await db().doc('agregados/mapa').set(documentoMapa);
  escritos.mapa = Object.keys(mapa).length;

  // --- Portada ---------------------------------------------------------------
  await db().doc('agregados/portada').set({
    pilotos: pilotos.length,
    clanes: clanes.length,
    viajes: viajes.length,
    rutas: porRuta.size,
    actualizado: admin.firestore.FieldValue.serverTimestamp(),
  });

  return escritos;
}

module.exports = {
  reconstruir,
  escribirAgregado,
  limpiar,
  CAMPOS_PUBLICABLES,
  POR_PAGINA,
};
