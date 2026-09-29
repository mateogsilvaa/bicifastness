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

// Firestore se coge de `db.js`, no de `admin` directamente: es lo que permite
// que el contador de cuota (#38) vea TODO lo que hace el backend.
const { db } = require('./db');
const { distribucion } = require('./verificacion');
const divisiones = require('./divisiones');
const { diaMadrid } = require('./util');

/**
 * Lo UNICO que puede viajar a un documento de lectura publica.
 *
 * Si hace falta un campo nuevo, se anade aqui a proposito y se piensa si es
 * publicable. Sin lista blanca, el dia que alguien meta el objeto de usuario
 * entero "para no repetir codigo", el correo vuelve a estar publicado.
 */
/**
 * Lo unico que sale de un agregado.
 *
 * `viajeId` lo rellena SOLO el ranking de un tramo, y esta aqui por un motivo
 * concreto: sin el no se puede denunciar un tiempo (#61). Es el id opaco de un
 * VIAJE, no de una persona: con el no se llega a nadie, porque `tiempos_viaje`
 * no se lee sin ser su dueño o la administracion.
 *
 * El `uid` NO entra, y esa es la linea. Denunciar necesitaba saber a quien se
 * señala, y en vez de publicar los uid de todo el que aparece en una
 * clasificacion, eso lo resuelve el worker leyendo el viaje.
 *
 * `limpiar` descarta lo que no venga, asi que los demas agregados siguen sin
 * publicarlo: quien no lo necesite, no lo enseña.
 */
const CAMPOS_PUBLICABLES = ['pos', 'nombre', 'avatar', 'clan', 'puntos', 'marca', 'viajes',
  'viajeId',
  // El DIA de una marca ('YYYY-MM-DD'), para "Tu mejor · ayer" y el record
  // "rosa.pedal · 14 sep" del rediseño 04. Solo el dia: ni la hora ni nada mas.
  'fecha'];

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
 * Cada cuanto se rehacen los agregados, como minimo.
 *
 * Es el segundo de los dos frenos. El otro es el modo parcial de `reconstruir`,
 * que baja el precio de UNA reconstruccion; este baja CUANTAS se hacen.
 *
 * Hacen falta los dos. Aun en parcial, una reconstruccion escribe los cuatro
 * rankings de pilotos, el de clanes, el mapa, el indice y la portada: nueve
 * escrituras largas que no dependen de lo que se haya movido. Hacerlo en cada
 * pasada con movimiento son unas 163 veces al dia con 240 subidas, y no aporta
 * nada frente a hacerlo cada cuarto de hora.
 *
 * Quince minutos no se notan. El worker ya llega con 5-15 de retraso — GitHub
 * retrasa los cron programados — asi que la clasificacion nunca ha sido
 * instantanea, y quien acaba de subir un trayecto ve su veredicto por el
 * seguimiento en vivo del propio viaje, que no pasa por aqui.
 */
const MINUTOS_ENTRE_RECONSTRUCCIONES = 15;

/**
 * La cadencia cuando el dia va apretado: una hora.
 *
 * Quince minutos es lo que se nota como "al dia" y cuesta, con 200 personas,
 * unas 38.000 lecturas diarias solo en agregados — casi toda la cuota. Una hora
 * ya no se nota tanto en una clasificacion, y es la cuarta parte. Mejor
 * clasificaciones de hace una hora toda la tarde que el modo degradado a las
 * seis y la web congelada hasta medianoche del Pacifico.
 */
const MINUTOS_SI_APRIETA = 60;

/**
 * ¿Cada cuanto toca, segun como vaya la cuota?
 *
 * Pura. Aprieta si lo gastado ya pasa del umbral de atencion, o si al ritmo
 * de hoy se va a pasar (`cuota.estimar`). La proyeccion puede exagerar a
 * primera hora —divide por poco—, pero equivocarse aqui solo cuesta que la
 * clasificacion vaya una hora por detras, no apagar nada.
 *
 * @param {{ porcentaje: number }} nivel       `cuota.nivel(consumido)`
 * @param {{ lecturas: number }|null} proyeccion `cuota.estimar(consumido)`
 */
function minutosEntreReconstrucciones(nivel, proyeccion, limiteLecturas = 50000, umbral = 70) {
  const aprieta = (nivel?.porcentaje || 0) >= umbral
    || (proyeccion && proyeccion.lecturas >= limiteLecturas * (umbral / 100));
  return aprieta ? MINUTOS_SI_APRIETA : MINUTOS_ENTRE_RECONSTRUCCIONES;
}

/**
 * ¿Toca rehacer los agregados?
 *
 * Pura, para poder probar el limitador sin tocar Firestore. `undefined` o una
 * marca ilegible devuelven `true`: es preferible una reconstruccion de mas que
 * una clasificacion congelada para siempre.
 */
function hayQueReconstruir(marca, ahora = Date.now(), minutos = MINUTOS_ENTRE_RECONSTRUCCIONES) {
  if (marca === null || marca === undefined) return true;

  // `serverTimestamp()` vuelve como Timestamp, no como cadena. Contemplar solo
  // el string haria que esto dijera siempre que si y el limitador no limitase.
  const cuando = typeof marca?.toMillis === 'function' ? marca.toMillis() : Date.parse(marca);
  if (!Number.isFinite(cuando)) return true;

  return (ahora - cuando) >= minutos * 60000;
}

/**
 * La misma pregunta, leyendo la marca del agregado de portada. Una lectura.
 *
 * Se mira en Firestore y no en una variable del proceso: el worker arranca de
 * cero en cada ejecucion de Actions, asi que cualquier estado en memoria vale
 * para una pasada.
 */
async function tocaReconstruir(ahora = Date.now(), minutos = MINUTOS_ENTRE_RECONSTRUCCIONES) {
  try {
    const snap = await db().doc('agregados/portada').get();
    return hayQueReconstruir(snap.exists ? snap.data().actualizado : null, ahora, minutos);
  } catch {
    return true;
  }
}

/**
 * Cuantas rutas de mas se refrescan en cada reconstruccion parcial.
 *
 * EL PROBLEMA QUE RESUELVE. El agregado de una ruta lleva dentro el nombre, el
 * avatar y el clan de cada piloto. Eso no cambia cuando cambia la ruta: cambia
 * cuando alguien se renombra, se cambia el avatar o entra en un clan. En parcial
 * solo se rehacen las rutas movidas, asi que ese piloto se quedaria con el
 * nombre viejo en las diez tablas donde sale hasta que alguien volviera a subir
 * un viaje a cada una.
 *
 * Antes lo tapaba la reconstruccion completa que caia cada seis horas con el
 * resumen de metricas. El resumen ya no lee los viajes, asi que esa completa ya
 * no ocurre y hace falta decirlo a proposito.
 *
 * TRES Y NO VEINTE. Con 600 rutas y unas 88 reconstrucciones al dia, tres por
 * turno dan la vuelta al catalogo cada dos dias y medio, y cuestan unas 75
 * lecturas por reconstruccion. Veinte lo arreglarian en tres horas y costarian
 * 44.000 lecturas al dia: mas que todo lo que gasta hoy el worker junto.
 *
 * El turno es rotatorio y el cursor va en el propio indice, asi que no hay que
 * acordarse de nada entre ejecuciones.
 */
const RUTAS_POR_TURNO = 3;

/**
 * Las `cuantas` rutas siguientes a `desde`, dando la vuelta al final.
 *
 * Pura, y con una razon: un turno que no diera la vuelta dejaria de refrescar el
 * final del catalogo para siempre en cuanto el cursor llegara ahi, y eso no lo
 * nota nadie hasta que alguien se queja de un nombre viejo.
 */
function turnoDeRutas(rutas, desde, cuantas = RUTAS_POR_TURNO) {
  if (!Array.isArray(rutas) || !rutas.length || cuantas <= 0) return [];

  const ordenadas = [...rutas].sort();
  const corte = desde ? ordenadas.findIndex((r) => r > desde) : 0;
  const arranque = corte === -1 ? 0 : corte;

  const turno = [];
  for (let i = 0; i < Math.min(cuantas, ordenadas.length); i++) {
    turno.push(ordenadas[(arranque + i) % ordenadas.length]);
  }
  return turno;
}

/**
 * Donde se apuntan las rutas que esperan reconstruccion.
 *
 * Hace falta porque los dos frenos se estorban: si una pasada mueve la ruta
 * 043-110 y el limitador de quince minutos decide que no toca reconstruir, esa
 * ruta se perderia — el worker de Actions arranca de cero en cada ejecucion, asi
 * que no hay memoria entre una y otra. La siguiente reconstruccion rehace solo
 * las rutas de SU pasada y el agregado de 043-110 se queda viejo hasta que
 * alguien vuelva a subir algo ahi.
 *
 * Vive en `config/`, que las reglas dejan leer solo a administracion: no es un
 * agregado, no lo pinta nadie, y en `agregados/` seria un documento publico que
 * no es una clasificacion.
 */
const PENDIENTES = 'config/agregados_pendientes';

const listaDe = (valores) => [...new Set([...(valores || [])].filter(Boolean).map(String))];

/**
 * Apunta rutas y estaciones para la proxima reconstruccion. Una escritura.
 *
 * Van juntas porque se pierden por el mismo motivo: la pasada las ha movido y el
 * limitador ha dicho que todavia no toca reconstruir.
 */
async function apuntarPendientes(rutas, estaciones = []) {
  const conRutas = listaDe(rutas);
  const conEstaciones = listaDe(estaciones);
  if (!conRutas.length && !conEstaciones.length) return 0;

  await db().doc(PENDIENTES).set({
    ...(conRutas.length
      ? { rutas: admin.firestore.FieldValue.arrayUnion(...conRutas) }
      : {}),
    ...(conEstaciones.length
      ? { estaciones: admin.firestore.FieldValue.arrayUnion(...conEstaciones) }
      : {}),
    actualizado: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return conRutas.length + conEstaciones.length;
}

/** Lo apuntado. Una lectura. */
async function leerPendientes() {
  try {
    const doc = await db().doc(PENDIENTES).get();
    const datos = doc.exists ? doc.data() : {};
    return {
      rutas: Array.isArray(datos.rutas) ? datos.rutas : [],
      estaciones: Array.isArray(datos.estaciones) ? datos.estaciones : [],
    };
  } catch {
    return { rutas: [], estaciones: [] };
  }
}

/**
 * Vacia la lista. Se llama DESPUES de reconstruir, no antes: si la
 * reconstruccion falla, lo apuntado sigue apuntado para el proximo intento.
 */
async function olvidarPendientes() {
  await db().doc(PENDIENTES).set({
    rutas: [],
    estaciones: [],
    actualizado: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

/**
 * La entrada del mapa de una estacion, en la forma en que la escribe el
 * agregado, y de vuelta.
 *
 * Las dos direcciones estan juntas a proposito: son la misma traduccion, y
 * separarlas es como se acaba con un `disputa` que se lee de un campo que se
 * escribe con otro nombre.
 */
function aEntradaDeMapa(stats) {
  return {
    // `clan` es quien CONTROLA (mas del 50%); `lider` es quien va primero.
    clan: stats.clanDominante || null,
    lider: stats.lider || null,
    disputa: Boolean(stats.enDisputa),
    cuota: stats.cuota || {},
  };
}

function deEntradaDeMapa(entrada) {
  return {
    clanDominante: entrada.clan || null,
    lider: entrada.lider || null,
    enDisputa: Boolean(entrada.disputa),
    cuota: entrada.cuota || {},
  };
}

/**
 * Reconstruye los agregados.
 *
 * Se le pasan los datos ya leidos porque el worker los tiene en la mano tras el
 * recalculo: volver a pedirlos aqui duplicaria la lectura mas cara que hace.
 *
 * MODO PARCIAL. Los viajes solo hacen falta para dos cosas: los agregados POR
 * RUTA y el contador de la portada. Las cuatro clasificaciones de pilotos, la de
 * clanes y el mapa salen de `usuarios`, `clanes` y `estaciones_stats`. Asi que
 * cuando solo se han movido unas rutas concretas no hace falta leer los viajes
 * enteros: basta con los de esas rutas, y el resto del agregado sale igual. Es
 * la diferencia entre 15.000 lecturas y 750 en cada reconstruccion.
 *
 * En parcial hay dos cosas que no se pueden deducir de lo que se ha leido y por
 * eso se piden aparte: el total de viajes (`totalViajes`, que sale de una
 * consulta de conteo) y las rutas que ya existian (`rutasPrevias`, del propio
 * indice). Sin ellas la portada diria que hay tres viajes en total y el selector
 * de rutas se quedaria con las tres ultimas.
 *
 * @param {Array}  usuarios     documentos de usuarios, con uid
 * @param {Array}  viajes       viajes verificados: todos, o los de las rutas tocadas
 * @param {Array}  clanes       documentos de clanes, con id
 * @param {Map}    estaciones   id de estacion -> stats
 * @param {boolean} parcial      `viajes` trae solo unas rutas, no todas
 * @param {Array}  rutasPrevias  rutas que ya estaban en el indice (solo en parcial)
 * @param {Object} conteosPrevios viajes por ruta que ya estaban (solo en parcial)
 * @param {Array}  rutasRehechas rutas que se han consultado (solo en parcial)
 * @param {number} totalViajes   viajes verificados que hay (solo en parcial)
 * @param {string} refrescadaHasta  por donde va el turno de refresco
 */
async function reconstruir({
  usuarios = [], viajes = [], clanes = [], estaciones = new Map(),
  parcial = false, rutasPrevias = [], conteosPrevios = {}, rutasRehechas = [],
  totalViajes = null, refrescadaHasta = null,
}) {
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

  // --- Grupos de division (02 Hoy, 04 Ranking) --------------------------------
  //
  // "El puesto 180 de 400 no motiva; el 7.º de 30 a dos trayectos de subir, si."
  // El ranking se abre en TU grupo, y Hoy dice a cuantos puntos estas de subir.
  //
  // Los grupos salen de la MISMA funcion que decide los ascensos del lunes
  // (`divisiones.repartirEnGrupos`), sobre los puntos de hoy: lo que se ve aqui
  // es exactamente lo que pasaria si el lunes fuera ahora. No se guarda en el
  // perfil de nadie ni cuesta una lectura: `usuarios` ya esta cargado.
  //
  // El indice `agregados/grupos` dice en que grupo esta cada nombre de piloto
  // (los nombres ya son publicos en cualquier clasificacion): con el, una
  // pantalla pide su grupo en dos lecturas en vez de probar los treinta.
  const grupos = divisiones.repartirEnGrupos(usuarios.map((u) => ({
    uid: u.uid,
    puntos: u.puntosTemporada || 0,
    division: u.division || 'hierro',
    u,
  })));
  const porPiloto = {};
  for (const [clave, miembros] of grupos) {
    const filas = miembros.map((p, i) => ({
      pos: i + 1,
      nombre: p.u.username || 'Piloto',
      clan: p.u.clanId || null,
      puntos: p.puntos,
      viajes: p.u.viajesVerificados || 0,
    }));
    await escribirAgregado(`grupo-${clave}`, filas, {
      grupo: clave,
      // Cuantos suben y cuantos bajan en ESTE grupo: un grupo incompleto mueve
      // menos (`divisiones.movimientos`), y pintar "suben 5" en uno de siete
      // seria mentir.
      mueven: Math.min(divisiones.MUEVEN, Math.floor(miembros.length / 3)),
    });
    for (const f of filas) porPiloto[f.nombre] = clave;
  }
  await db().doc('agregados/grupos').set({
    porPiloto,
    actualizado: admin.firestore.FieldValue.serverTimestamp(),
  });
  escritos.grupos = grupos.size;

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

  // Viajes EN CRUDO por ruta, no pilotos. Es lo que mira `misiones.rutaDelDia`
  // para descartar los tramos que no mueve nadie, y contarlo aqui — donde los
  // viajes ya estan leidos — le ahorra al worker recorrer la coleccion entera
  // una vez al dia solo para elegir la ruta destacada.
  const brutosPorRuta = new Map();

  // Y todos los tiempos de cada ruta, para su distribucion. La comprobacion
  // antifraude que compara un tiempo con la media del tramo la sacaba de los 200
  // MAS RAPIDOS, porque su consulta iba ordenada: en cuanto una ruta pasaba de
  // 200 marcas medía contra la cola rapida y se iba deformando sola. Aqui estan
  // TODOS, que es lo que la comprobacion siempre quiso (src/verificacion.js).
  const tiemposPorRuta = new Map();

  for (const v of viajes) {
    if (!v.ruta) continue;
    brutosPorRuta.set(v.ruta, (brutosPorRuta.get(v.ruta) || 0) + 1);
    if (!tiemposPorRuta.has(v.ruta)) tiemposPorRuta.set(v.ruta, []);
    tiemposPorRuta.get(v.ruta).push(v.tiempoSegundos);
    if (!porRuta.has(v.ruta)) porRuta.set(v.ruta, new Map());
    const mejores = porRuta.get(v.ruta);
    const previo = mejores.get(v.uid);
    if (!previo || v.tiempoSegundos < previo.tiempoSegundos) mejores.set(v.uid, v);
  }

  // Una ruta consultada que no ha devuelto ningun viaje se ha quedado VACIA:
  // le han anulado el ultimo. Hay que escribirla igualmente, con cero filas, o
  // el agregado publico se queda ensenando una clasificacion que ya no existe.
  // Se apuntan para sacarlas luego del indice.
  const vaciadas = new Set();
  if (parcial) {
    for (const ruta of rutasRehechas) {
      if (porRuta.has(ruta)) continue;
      porRuta.set(ruta, new Map());
      vaciadas.add(ruta);
    }
  }

  // La tabla de HOY de cada ruta: el mejor tiempo de cada piloto con viaje de
  // hoy (dia de Madrid). Es la de la ruta del dia, "la clasificacion que empieza
  // vacia cada mañana" (04 · 4d), y la que cuenta "14 pilotos hoy".
  const hoy = diaMadrid();
  const hoyPorRuta = new Map();
  for (const v of viajes) {
    if (!v.ruta || String(v.fechaViaje || '').slice(0, 10) !== hoy) continue;
    if (!hoyPorRuta.has(v.ruta)) hoyPorRuta.set(v.ruta, new Map());
    const delDia = hoyPorRuta.get(v.ruta);
    const previo = delDia.get(v.uid);
    if (!previo || v.tiempoSegundos < previo.tiempoSegundos) delDia.set(v.uid, v);
  }

  const aFila = (v, i) => {
    const piloto = nombrePorUid.get(v.uid);
    return {
      pos: i + 1,
      nombre: piloto?.username || v.username || 'Piloto',
      avatar: piloto?.avatarUrl || null,
      clan: piloto?.clanId || null,
      marca: v.tiempoSegundos,
      fecha: String(v.fechaViaje || '').slice(0, 10) || null,
      // Para poder denunciar este tiempo. Solo el id del viaje: quien es su
      // dueño lo resuelve el worker (#61).
      viajeId: v.viajeId || null,
    };
  };

  let rutasEscritas = 0;
  for (const [ruta, mejores] of porRuta) {
    const filas = [...mejores.values()]
      .sort((a, b) => a.tiempoSegundos - b.tiempoSegundos)
      .map(aFila);

    // Por la lista blanca, igual que las filas: lo que va en `extra` no pasa
    // por `escribirAgregado`.
    const filasHoy = [...(hoyPorRuta.get(ruta) || new Map()).values()]
      .sort((a, b) => a.tiempoSegundos - b.tiempoSegundos)
      .map(aFila)
      .map(limpiar);

    // El id lleva la ruta dentro, asi que una pantalla pide exactamente la que
    // le hace falta y no las 600.
    //
    // `distribucion` NO se pinta: la usa el worker para la comprobacion
    // estadistica del antifraude. Va aqui porque este es el unico sitio donde
    // los tiempos de la ruta estan todos juntos, y asi verificar un viaje cuesta
    // una lectura en vez de doscientas.
    const { muestras, media, desviacion } = distribucion(tiemposPorRuta.get(ruta) || []);

    await escribirAgregado(`ruta-${ruta}`, filas, {
      ruta,
      // `hoyDia` dice de que dia es `hoy`: una ruta que no se mueve en una
      // reconstruccion parcial conserva la tabla de ayer, y el navegador la
      // descarta si no es la de hoy en vez de enseñarla como si lo fuera.
      hoy: filasHoy.slice(0, 50),
      hoyDia: hoy,
      hoyPilotos: filasHoy.length,
      distribucion: {
        muestras,
        media: Math.round(media),
        desviacion: Math.round(desviacion * 100) / 100,
      },
    });
    rutasEscritas++;
  }
  escritos.rutas = rutasEscritas;

  // --- Indice de rutas -------------------------------------------------------
  // El selector de `/clasificacion/` necesita saber que rutas existen sin leer
  // los 600 agregados de ruta.
  //
  // En parcial se UNE con lo que ya habia: `porRuta` solo tiene las rutas que se
  // han movido, y sobrescribir con eso dejaria el selector con dos entradas.
  const rutasConocidas = parcial
    ? [...new Set([...rutasPrevias, ...porRuta.keys()])].filter((r) => !vaciadas.has(r)).sort()
    : [...porRuta.keys()].sort();

  // Lo mismo con los conteos: en parcial solo se conocen los de las rutas
  // movidas, asi que se mezclan con los que ya habia.
  const viajesPorRuta = parcial ? { ...conteosPrevios } : {};
  for (const [ruta, cuantos] of brutosPorRuta) viajesPorRuta[ruta] = cuantos;
  for (const ruta of vaciadas) delete viajesPorRuta[ruta];

  await db().doc('agregados/rutas').set({
    rutas: rutasConocidas,
    viajesPorRuta,
    // Por donde va el turno de refresco. Va aqui y no en un documento aparte
    // porque este ya se lee y se escribe en cada reconstruccion: guardarlo en
    // otro sitio seria una lectura y una escritura de mas por nada.
    ...(refrescadaHasta ? { refrescadaHasta } : {}),
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

    // `clan` es quien CONTROLA (mas del 50%); `lider` es quien va primero. No son
    // lo mismo, y la diferencia es justo lo interesante del mapa: una estacion
    // con lider pero sin dueño esta en disputa, o sea que ahi hay algo que hacer.
    mapa[id] = aEntradaDeMapa(stats);

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
    // `pilotos` son los que PUNTUAN; `usuarios`, las cuentas que hay. No es lo
    // mismo y se confunde facil: quien acaba de registrarse cuenta como cuenta
    // pero todavia no aparece en ninguna clasificacion.
    pilotos: pilotos.length,
    usuarios: usuarios.length,
    clanes: clanes.length,
    // En parcial `viajes` son solo los de las rutas tocadas: el total viene de
    // una consulta de conteo, que cuesta una lectura por cada mil viajes.
    viajes: totalViajes === null ? viajes.length : totalViajes,
    rutas: rutasConocidas.length,
    actualizado: admin.firestore.FieldValue.serverTimestamp(),
  });

  return escritos;
}

module.exports = {
  reconstruir,
  turnoDeRutas,
  RUTAS_POR_TURNO,
  apuntarPendientes,
  leerPendientes,
  olvidarPendientes,
  aEntradaDeMapa,
  deEntradaDeMapa,
  PENDIENTES,
  tocaReconstruir,
  hayQueReconstruir,
  minutosEntreReconstrucciones,
  MINUTOS_ENTRE_RECONSTRUCCIONES,
  MINUTOS_SI_APRIETA,
  escribirAgregado,
  limpiar,
  CAMPOS_PUBLICABLES,
  POR_PAGINA,
};
