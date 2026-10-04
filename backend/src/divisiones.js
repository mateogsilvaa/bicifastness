'use strict';

/**
 * Divisiones (ligas) de dos semanas.
 *
 * POR QUE. En una tabla unica de 400 personas, el puesto 180 no se mueve nunca
 * y no motiva a nadie. En un grupo de 20, subir de division esta a dos buenos
 * trayectos. Es lo que hace que competir tenga sentido para alguien normal.
 *
 * LA ESCALERA, de peor a mejor (diseño 12 · Insignias de division):
 *
 *   sin clasificar   los nuevos y quien lleva dos ligas sin pedalear
 *   cobre            40% de los grupos que quedan tras las gemas
 *   plata            30%
 *   oro              20%
 *   platino          10%
 *   esmeralda        hasta 7 grupos
 *   rubi             hasta 3 grupos
 *   diamante         1 grupo, nunca mas
 *
 * Con poca gente hay un grupo por division EMPEZANDO POR ABAJO: con tres
 * grupos existen cobre, plata y oro, y nadie esta en diamante porque no hay a
 * quien ganar ahi. Segun crece la gente, los grupos nuevos nacen abajo y la
 * piramide se va llenando hacia arriba.
 *
 * Cada liga dura DOS SEMANAS. El lunes que la cierra, en cada grupo suben los
 * 4 primeros y bajan los 4 ultimos; pero manda el CUPO de cada division: si
 * los que suben no caben arriba, entran los de mas puntos y el resto se queda.
 * Despues se rehacen los grupos de cada division, parejos, y los puntos de liga
 * vuelven a cero.
 *
 * Todo el calculo son funciones puras sobre listas: se puede probar entero sin
 * Firestore, que es donde se esconden los errores de este tipo de reglas.
 */

const { diaMadrid } = require('./util');

/** De peor a mejor. El identificador es el nombre sin tilde (`rubi`). */
const NIVELES = ['cobre', 'plata', 'oro', 'platino', 'esmeralda', 'rubi', 'diamante'];

/** Antes de la primera liga con trayectos, y despues de dos ligas sin pedalear. */
const SIN_CLASIFICAR = 'sin-clasificar';

/** Cuanta gente por grupo. */
const POR_GRUPO = 20;

/** Cuantos suben y cuantos bajan de cada grupo completo. */
const MUEVEN = 4;

/** Tope de grupos de las gemas. El resto de grupos son de metal. */
const TOPES = { esmeralda: 7, rubi: 3, diamante: 1 };

/** Reparto de los grupos de metal (los que quedan tras las gemas). */
const PESOS = { cobre: 0.4, plata: 0.3, oro: 0.2, platino: 0.1 };

/** Ligas seguidas sin pedalear que te devuelven a sin clasificar. */
const LIGAS_PARA_DESCLASIFICAR = 2;

/**
 * Colocacion de quien sale de sin clasificar. Al menos el 80% va a cobre; el
 * resto, solo si destaca de verdad, a plata u oro. Platino, en un 0,05% de los
 * casos como mucho, y solo con unos numeros que casi nadie hace.
 */
const COLOCACION = {
  MAXIMO_POR_ENCIMA_DE_COBRE: 0.2,
  MAXIMO_EN_PLATINO: 0.0005,
};

const nivelDe = (division) => NIVELES.indexOf(division);
const esClasificado = (division) => nivelDe(division) >= 0;

/** La division de una clave de grupo ('plata-4' -> 'plata', 'sin-clasificar' tal cual). */
function divisionDeClave(clave) {
  const c = String(clave || '');
  if (c === SIN_CLASIFICAR) return SIN_CLASIFICAR;
  const i = c.lastIndexOf('-');
  return i > 0 ? c.slice(0, i) : c;
}

// --- Calendario ---------------------------------------------------------------

/** Cuantos dias dura una liga. */
const DIAS_POR_LIGA = 14;

/**
 * El dia que abre la web. La PRIMERA liga empieza ese dia (domingo) y dura
 * hasta el domingo de dos semanas despues: asi el fin de semana de apertura
 * cuenta, y nadie empieza en una liga que se cierra al dia siguiente con un
 * solo dia de puntos. Lo de antes del lanzamiento (pruebas) no cuenta para
 * ninguna liga.
 */
const LANZAMIENTO = '2026-11-01';

/**
 * El lunes desde el que se cuentan las ligas de dos semanas. Tiene un gemelo
 * en `assets/js/ligas.js` (un test los compara): si solo se moviera aqui, la
 * web diria "cambia el lunes 16" y el cambio caeria el 23.
 */
const ANCLA_LIGA = '2026-11-02';

/** Dias entre dos fechas 'YYYY-MM-DD'. */
const diasEntre = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);

/** Suma dias a una fecha 'YYYY-MM-DD'. */
function sumarDias(fecha, n) {
  // A mediodia UTC, que en Madrid es el mismo dia con cualquier horario.
  return diaMadrid(new Date(Date.parse(`${fecha}T12:00:00Z`) + n * 864e5));
}

/** El lunes en que empieza la liga de dos semanas del dia dado, sin la primera. */
function lunesDeLiga(dia) {
  const vueltas = Math.floor(diasEntre(ANCLA_LIGA, dia) / DIAS_POR_LIGA);
  return sumarDias(ANCLA_LIGA, vueltas * DIAS_POR_LIGA);
}

/** ¿Cae el dia en la primera liga (o antes del lanzamiento)? */
const enPrimeraLiga = (dia) => diasEntre(ANCLA_LIGA, dia) < DIAS_POR_LIGA;

/** El dia en que empezo la liga que esta en juego el dia dado. */
function inicioLiga(dia) {
  return enPrimeraLiga(dia) ? LANZAMIENTO : lunesDeLiga(dia);
}

/** El ultimo dia (domingo) de la liga en juego el dia dado. */
function finLiga(dia) {
  return sumarDias(enPrimeraLiga(dia) ? ANCLA_LIGA : lunesDeLiga(dia), DIAS_POR_LIGA - 1);
}

/**
 * ¿Empieza liga nueva este dia? Es cuando toca cerrar la anterior. El dia del
 * lanzamiento no: antes no hay ninguna liga que cerrar.
 */
const esCambioDeLiga = (dia) => !enPrimeraLiga(dia) && lunesDeLiga(dia) === dia;

// --- Cuantos grupos tiene cada division ---------------------------------------

/** Reparte `resto` grupos entre los metales 40/30/20/10, al menos uno cada uno. */
function repartirMetales(resto) {
  const metales = Object.keys(PESOS);
  const grupos = Object.fromEntries(metales.map((n) => [n, 1]));
  for (let dados = metales.length; dados < resto; dados++) {
    // El que mas lejos este de su parte; en empate, el de mas abajo.
    let mejor = metales[0];
    for (const n of metales) {
      if (resto * PESOS[n] - grupos[n] > resto * PESOS[mejor] - grupos[mejor]) mejor = n;
    }
    grupos[mejor]++;
  }
  return grupos;
}

/**
 * Cuantos grupos le tocan a cada division con `pilotos` clasificados.
 *
 * Con siete grupos o menos, uno por division empezando por cobre: con tres
 * grupos existen cobre, plata y oro. Con mas, diamante tiene 1 y lo que queda
 * tras las gemas se reparte 40/30/20/10 entre los metales; cada grupo de mas va
 * donde mas falta, y en empate abajo, asi que los grupos nuevos nacen abajo.
 *
 * Las gemas crecen con la piramide, sin invertirla: esmeralda nunca tiene mas
 * grupos que platino (hasta 7) y rubi, como mucho la mitad que esmeralda (hasta
 * 3). Con un tope fijo de golpe, 300 personas daban dos grupos de esmeralda y
 * uno de platino.
 */
function gruposPorNivel(pilotos) {
  const total = Math.ceil(Math.max(0, pilotos) / POR_GRUPO);
  const grupos = Object.fromEntries(NIVELES.map((n) => [n, 0]));
  if (!total) return grupos;

  if (total <= NIVELES.length) {
    for (const n of NIVELES.slice(0, total)) grupos[n] = 1;
    return grupos;
  }

  const metalesCon = (esmeralda, rubi) => repartirMetales(total - TOPES.diamante - esmeralda - rubi);
  // La esmeralda mas grande que no supere a platino, con rubi en la mitad.
  const rubiPara = (e) => Math.min(TOPES.rubi, Math.ceil(e / 2));
  let esmeralda = TOPES.esmeralda;
  while (esmeralda > 1 && esmeralda > metalesCon(esmeralda, rubiPara(esmeralda)).platino) esmeralda--;
  const rubi = rubiPara(esmeralda);

  Object.assign(grupos, metalesCon(esmeralda, rubi), { esmeralda, rubi, diamante: TOPES.diamante });
  return grupos;
}

// --- Grupos dentro de una division --------------------------------------------

/**
 * Reparte a los de UNA division en `n` grupos parejos: se ordenan por puntos y
 * se reparten en serpiente (1, 2, 3, 3, 2, 1...), asi ningun grupo se lleva a
 * los tres mejores. Los tamaños se diferencian en uno como mucho.
 */
function repartirParejo(miembros, n) {
  const orden = [...miembros].sort((a, b) => (b.puntos || 0) - (a.puntos || 0) || String(a.uid).localeCompare(String(b.uid)));
  const grupos = Array.from({ length: Math.max(1, n) }, () => []);
  orden.forEach((p, i) => {
    const vuelta = Math.floor(i / grupos.length);
    const pos = i % grupos.length;
    grupos[vuelta % 2 === 0 ? pos : grupos.length - 1 - pos].push(p);
  });
  return grupos;
}

/**
 * Los grupos de todo el mundo, para pintar las tablas mientras la liga corre.
 *
 * Manda el grupo GUARDADO en el cierre (`grupo`): asi el grupo no cambia en
 * mitad de la liga. Quien no lo tiene (perfiles de antes de esta escala) se
 * reparte en grupos de su division. Los sin clasificar van todos juntos, en
 * una sola tabla, y solo los que ya tienen puntos en esta liga: son los que
 * entraran en la escalera al cerrarla.
 *
 * Cada grupo sale ordenado por puntos de la liga en juego.
 */
function repartirEnGrupos(pilotos) {
  const grupos = new Map();
  const meter = (clave, p) => {
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(p);
  };

  const sueltos = new Map();
  for (const p of pilotos) {
    if (!esClasificado(p.division)) {
      if ((p.puntos || 0) > 0) meter(SIN_CLASIFICAR, p);
      continue;
    }
    if (p.grupo && divisionDeClave(p.grupo) === p.division) meter(p.grupo, p);
    else {
      if (!sueltos.has(p.division)) sueltos.set(p.division, []);
      sueltos.get(p.division).push(p);
    }
  }

  for (const [division, miembros] of sueltos) {
    const ya = [...grupos.keys()].filter((k) => divisionDeClave(k) === division).length;
    repartirParejo(miembros, Math.ceil(miembros.length / POR_GRUPO))
      .forEach((g, i) => g.forEach((p) => meter(`${division}-${ya + i + 1}`, p)));
  }

  for (const miembros of grupos.values()) miembros.sort((a, b) => (b.puntos || 0) - (a.puntos || 0));
  return grupos;
}

/** Cuantos suben y cuantos bajan en un grupo de este tamaño. */
const cuantosMueven = (tamano) => Math.min(MUEVEN, Math.floor(tamano / 3));

/**
 * Lo que pide cada piloto de un grupo al cerrar: subir, bajar o quedarse.
 *
 * Dos reglas que no son obvias y que importan:
 *
 * 1. Quien no ha competido en toda la liga NO baja. Castigar la ausencia con un
 *    descenso empuja a abandonar del todo. Tampoco sube: no ha hecho nada. (Si
 *    se ausenta dos ligas, vuelve a sin clasificar: eso lo decide `cerrarLiga`.)
 * 2. Un grupo pequeño no mueve a todo el mundo: como mucho un tercio por lado.
 */
function movimientos(clave, miembros) {
  const division = divisionDeClave(clave);
  const nivel = nivelDe(division);
  const activos = miembros.filter((p) => (p.puntos || 0) > 0);

  if (activos.length < 3) return { suben: [], bajan: [], sinCambios: miembros };
  const cuantos = cuantosMueven(miembros.length);
  if (cuantos === 0) return { suben: [], bajan: [], sinCambios: miembros };

  const orden = [...miembros].sort((a, b) => (b.puntos || 0) - (a.puntos || 0));
  const conPuesto = (p, destino) => ({
    ...p, division: destino, desde: division, puesto: orden.indexOf(p) + 1, total: miembros.length,
  });

  const suben = nivel === NIVELES.length - 1 ? [] : orden
    .filter((p) => (p.puntos || 0) > 0)
    .slice(0, cuantos)
    .map((p) => conPuesto(p, NIVELES[nivel + 1]));
  const idsSuben = new Set(suben.map((p) => p.uid));

  const bajan = nivel === 0 ? [] : orden
    .filter((p) => (p.puntos || 0) > 0 && !idsSuben.has(p.uid))
    .slice(-cuantos)
    .map((p) => conPuesto(p, NIVELES[nivel - 1]));

  const movidos = new Set([...suben, ...bajan].map((p) => p.uid));
  return { suben, bajan, sinCambios: miembros.filter((p) => !movidos.has(p.uid)) };
}

// --- Salir de sin clasificar ------------------------------------------------------

/** Que parte de los puntos de esta liga queda por debajo de `puntos` (0..1). */
function percentil(puntos, todos) {
  if (!todos.length) return 0;
  return todos.filter((p) => p < puntos).length / todos.length;
}

/**
 * Donde entra alguien que sale de sin clasificar (indice de NIVELES).
 *
 * - Nuevo: cobre. Plata si queda por encima del 95% de los puntos de la liga;
 *   oro por encima del 99%.
 * - Vuelve tras estar arriba: dos divisiones por debajo de la mejor que tuvo
 *   (como mucho oro), y una mas si vuelve fuerte (por encima del 90%).
 * - Platino solo para quien estuvo en esmeralda o mas y vuelve por encima del
 *   99,5%, o un nuevo por encima del 99,9%. Y aun asi, con cupo (`cerrarLiga`).
 */
function nivelDeEntrada({ puntos = 0, divisionMaxima = -1 }, todos) {
  const p = percentil(puntos, todos);
  const PLATA = 1;
  const ORO = 2;
  const PLATINO = 3;
  if (divisionMaxima < 0) {
    if (p >= 0.999) return PLATINO;
    if (p >= 0.99) return ORO;
    if (p >= 0.95) return PLATA;
    return 0;
  }
  if (divisionMaxima >= nivelDe('esmeralda') && p >= 0.995) return PLATINO;
  let nivel = Math.max(0, Math.min(ORO, divisionMaxima - 2));
  if (p >= 0.9) nivel = Math.min(ORO, nivel + 1);
  return nivel;
}

// --- El cierre ------------------------------------------------------------------

/**
 * Cierra una liga. Funcion pura: recibe a todos y devuelve donde queda cada
 * uno. `periodicas.js` solo escribe lo que sale de aqui.
 *
 * @param {Array<{uid, division, grupo, puntos, ligasInactivas, divisionMaxima, ligasJugadas}>} pilotos
 *   `puntos` son los de la liga que se cierra; `divisionMaxima` es un indice de
 *   NIVELES (o -1).
 * @returns {Array<{uid, division, grupo, desde, grupoDesde, puesto, total, puntos,
 *   ligasInactivas, divisionMaxima, ligasJugadas, cambia}>}
 */
function cerrarLiga(pilotos) {
  const activo = (p) => (p.puntos || 0) > 0;
  const todosLosPuntos = pilotos.filter(activo).map((p) => p.puntos);

  // 1. Quien lleva dos ligas sin pedalear sale de la escalera.
  const estado = pilotos.map((p) => {
    const inactivas = activo(p) ? 0 : (p.ligasInactivas || 0) + 1;
    const clasificado = esClasificado(p.division) && inactivas < LIGAS_PARA_DESCLASIFICAR;
    return { ...p, inactivas, clasificado };
  });

  // 2. Lo que pide cada clasificado segun su grupo.
  const objetivo = new Map();
  const enGrupo = repartirEnGrupos(estado.filter((p) => p.clasificado));
  for (const [clave, miembros] of enGrupo) {
    const { suben, bajan } = movimientos(clave, miembros);
    const orden = [...miembros].sort((a, b) => (b.puntos || 0) - (a.puntos || 0));
    for (const p of miembros) {
      const mov = [...suben, ...bajan].find((m) => m.uid === p.uid);
      objetivo.set(p.uid, {
        p,
        nivel: nivelDe(mov ? mov.division : p.division),
        ya: nivelDe(p.division),
        grupoDesde: clave,
        puesto: orden.indexOf(p) + 1,
        total: miembros.length,
      });
    }
  }

  // 3. Los sin clasificar que han pedaleado esta liga entran en la escalera.
  const entran = estado.filter((p) => !p.clasificado && activo(p))
    .map((p) => ({ p, nivel: nivelDeEntrada({ puntos: p.puntos, divisionMaxima: p.divisionMaxima ?? -1 }, todosLosPuntos) }))
    .sort((a, b) => b.nivel - a.nivel || (b.p.puntos || 0) - (a.p.puntos || 0));
  // Al menos el 80% a cobre, y platino casi nunca: se quedan los de mas nivel y
  // mas puntos; los demas, a cobre (o a oro, si iban a platino sin cupo).
  let porEncima = Math.floor(entran.length * COLOCACION.MAXIMO_POR_ENCIMA_DE_COBRE);
  let enPlatino = Math.floor(entran.length * COLOCACION.MAXIMO_EN_PLATINO);
  for (const e of entran) {
    if (e.nivel >= 3) { if (enPlatino > 0) enPlatino--; else e.nivel = 2; }
    if (e.nivel > 0) { if (porEncima > 0) porEncima--; else e.nivel = 0; }
    objetivo.set(e.p.uid, { p: e.p, nivel: e.nivel, ya: -1, grupoDesde: SIN_CLASIFICAR, puesto: null, total: null });
  }

  // 4. Se llenan las divisiones de arriba abajo, cada una hasta su cupo. Lo que
  //    no cabe baja a la siguiente. En cada division entran primero los que
  //    vienen de arriba, despues los que ya estaban y por ultimo los que suben;
  //    dentro de cada uno, por puntos.
  const cupos = gruposPorNivel(objetivo.size);
  const pendientes = [...objetivo.values()];
  const colocados = new Map();
  for (let nivel = NIVELES.length - 1; nivel >= 0; nivel--) {
    const cupo = nivel === 0 ? Infinity : cupos[NIVELES[nivel]] * POR_GRUPO;
    const candidatos = pendientes
      .filter((o) => !colocados.has(o.p.uid) && o.nivel >= nivel)
      .sort((a, b) => (b.nivel - a.nivel)
        || (Number(b.ya === nivel) - Number(a.ya === nivel))
        || ((b.p.puntos || 0) - (a.p.puntos || 0))
        || String(a.p.uid).localeCompare(String(b.p.uid)));
    for (const o of candidatos.slice(0, cupo)) colocados.set(o.p.uid, { ...o, final: nivel });
  }

  // 5. Grupos nuevos, parejos, dentro de cada division.
  const grupoNuevo = new Map();
  for (const division of NIVELES) {
    const suyos = [...colocados.values()].filter((o) => NIVELES[o.final] === division).map((o) => o.p);
    if (!suyos.length) continue;
    repartirParejo(suyos, Math.ceil(suyos.length / POR_GRUPO))
      .forEach((g, i) => g.forEach((p) => grupoNuevo.set(p.uid, `${division}-${i + 1}`)));
  }

  return estado.map((p) => {
    const o = colocados.get(p.uid);
    const division = o ? NIVELES[o.final] : SIN_CLASIFICAR;
    const nivel = o ? o.final : -1;
    const antes = esClasificado(p.division) ? p.division : SIN_CLASIFICAR;
    return {
      uid: p.uid,
      division,
      grupo: o ? grupoNuevo.get(p.uid) : null,
      desde: antes,
      grupoDesde: o ? o.grupoDesde : (p.grupo || null),
      puesto: o ? o.puesto : null,
      total: o ? o.total : null,
      puntos: p.puntos || 0,
      ligasInactivas: p.inactivas,
      divisionMaxima: Math.max(p.divisionMaxima ?? -1, nivel),
      ligasJugadas: (p.ligasJugadas || 0) + (activo(p) ? 1 : 0),
      cambia: division !== antes,
    };
  });
}

module.exports = {
  NIVELES,
  SIN_CLASIFICAR,
  POR_GRUPO,
  MUEVEN,
  TOPES,
  PESOS,
  LIGAS_PARA_DESCLASIFICAR,
  COLOCACION,
  DIAS_POR_LIGA,
  ANCLA_LIGA,
  LANZAMIENTO,
  inicioLiga,
  finLiga,
  esCambioDeLiga,
  sumarDias,
  nivelDe,
  esClasificado,
  divisionDeClave,
  gruposPorNivel,
  repartirParejo,
  repartirEnGrupos,
  cuantosMueven,
  movimientos,
  nivelDeEntrada,
  cerrarLiga,
};
