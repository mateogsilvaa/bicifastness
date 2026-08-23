#!/usr/bin/env node
/**
 * Cuenta cuantas lecturas de Firestore cuesta cada pantalla y cada operacion
 * del worker (#34).
 *
 * Por que un modelo y no una medicion en vivo: lo que hay que saber no es lo
 * que cuesta hoy con 6 usuarios, sino como CRECE. Un modelo sacado del codigo
 * — cada `getDocs(collection(...))` es una lectura por documento — responde a
 * eso y se puede volver a correr cuando el codigo cambie, sin proyecto de
 * pruebas ni credenciales.
 *
 * El plan Spark da 50.000 lecturas y 20.000 escrituras al dia. No es una
 * factura mas alta: al agotarlo, la web deja de funcionar hasta medianoche.
 *
 * Uso:
 *   node scripts/auditar-lecturas.js              # tabla en pantalla
 *   node scripts/auditar-lecturas.js --markdown   # cuerpo de docs/COSTE.md
 *   node scripts/auditar-lecturas.js --comprobar  # falla si algo se dispara
 */

// --- Escenarios ------------------------------------------------------------------
/**
 * `U` usuarios totales, `A` activos al dia, `V` viajes verificados acumulados,
 * `C` clanes, `E` estaciones con estadisticas, `S` viajes subidos al dia.
 *
 * Los viajes acumulados son la variable que mas duele, porque no para de subir
 * aunque el numero de usuarios se quede quieto.
 */
const ESCENARIOS = {
  hoy:   { U: 175,  A: 6,    V: 1022,   C: 3,   E: 120, S: 10 },
  u50:   { U: 60,   A: 50,   V: 3000,   C: 8,   E: 300, S: 60 },
  u200:  { U: 240,  A: 200,  V: 15000,  C: 25,  E: 500, S: 240 },
  u1000: { U: 1200, A: 1000, V: 90000,  C: 90,  E: 631, S: 1200 },
};

const CUOTA_LECTURAS = 50000;

/**
 * Firestore cobra un minimo de una lectura aunque la consulta no devuelva nada,
 * asi que ninguna operacion sale gratis.
 */
const min1 = (n) => Math.max(1, Math.round(n));

/**
 * Viajes verificados que acumula una ruta.
 *
 * No se reparten por igual: unas pocas rutas concentran la mayoria. Un
 * veinteavo del total en la mas transitada es conservador.
 */
const viajesEnRuta = (V) => Math.max(1, Math.round(V / 20));

/**
 * Cuantas ventanas de tiempo tienen al menos una subida.
 *
 * No es "subidas partido por ventanas": con 240 subidas y 96 ventanas no salen
 * 96 ventanas llenas ni 2,5 ventanas, salen las que toca. Con las subidas
 * repartidas al azar, la probabilidad de que una ventana quede vacia es
 * e^(-S/W), asi que las que tienen algo son W(1 - e^(-S/W)).
 *
 * Importa porque es exactamente lo que decide cuantas veces se reconstruyen los
 * agregados, que es la operacion mas cara del worker.
 */
const ventanasConMovimiento = (subidas, ventanas) =>
  Math.max(1, Math.round(ventanas * (1 - Math.exp(-subidas / ventanas))));

/**
 * Rutas que tienen algun viaje verificado, y viajes que acumula cada una.
 *
 * Hay 631 estaciones, o sea decenas de miles de pares posibles, pero solo se
 * usan unas cuantas. Veinticinco viajes por ruta activa es lo que se ve en los
 * datos de hoy, con tope en 600 rutas: a partir de ahi lo que crece es la
 * ocupacion de cada una, no el numero de rutas.
 */
const rutasActivas = (V) => Math.min(600, Math.max(1, Math.round(V / 25)));
const viajesPorRutaActiva = (V) => Math.max(1, Math.round(V / rutasActivas(V)));

/** Rutas activas que tocan una estacion concreta. Cada ruta toca dos. */
const rutasPorEstacion = (V, E) => Math.max(1, Math.round((rutasActivas(V) * 2) / E));

/**
 * Altas dadas en los ultimos 45 dias, que son las cohortes que todavia pueden
 * cambiar. Se supone que un mes y medio trae tantas altas como personas activas
 * hay: es generoso, y lo que importa es que NO crece con lo acumulado.
 */
const altasRecientes = (U, A) => Math.max(1, Math.min(U, A));

/** Estaciones que se mueven en una pasada: dos por viaje aprobado. */
const estacionesEnLaPasada = (S) =>
  Math.max(2, Math.min(60, Math.round((S / ventanasConMovimiento(S, 288)) * 2)));

/**
 * Rutas que se refrescan de mas en cada reconstruccion, por turno rotatorio.
 *
 * No es opcional: el agregado de una ruta lleva dentro el nombre y el avatar de
 * cada piloto, y eso cambia sin que se mueva ninguna ruta (backend/src/agregados.js).
 */
const RUTAS_POR_TURNO = 3;

/** Rutas que se mueven entre dos reconstrucciones (una cada 15 minutos). */
const rutasEnLaVentana = (S) =>
  Math.max(1, Math.min(rutasActivas(S * 60), Math.round(S / ventanasConMovimiento(S, 96))));

// --- Pantallas ---------------------------------------------------------------------
/**
 * Lecturas de UNA carga de cada pantalla, sacadas de las llamadas del propio
 * HTML. `veces` es cuantas veces al dia la abre un usuario activo.
 */
const PANTALLAS = [
  {
    ruta: '/', veces: 3,
    coste: () => 1 + 1 + 1 + 1 + 1 + 1 + 1,
    detalle: 'perfil + mision + config + clan + su ultimo viaje + el conteo + el agregado de la ruta',
  },
  {
    ruta: '/clasificacion/', veces: 2,
    // La cache de sesion se come las visitas repetidas dentro de los 2 minutos
    // de vigencia, que son la mayoria del ir y venir entre pantallas.
    coste: () => 1,
    detalle: 'el agregado del modo; las visitas repetidas salen de la cache de sesion',
  },
  {
    ruta: '/territorio/', veces: 1,
    coste: () => 1,
    detalle: 'el agregado del mapa: clanes y estaciones en un solo documento',
  },
  {
    ruta: '/yo/', veces: 1,
    coste: () => 1 + 3 + 1 + 20,
    detalle: 'perfil + temporadas + el conteo + la primera pagina del historial (20)',
  },
  {
    ruta: '/subir/', veces: 1,
    coste: () => min1(1) + min1(60),
    detalle: 'perfil + sus 60 viajes mas recientes, para el limite diario',
  },
  {
    ruta: '/statssss/', veces: 0.1,
    coste: () => 2,
    detalle: 'los agregados de portada y mapa',
  },
];



// --- Worker ------------------------------------------------------------------------
/**
 * Lecturas por operacion del worker. `veces` es cuantas veces al dia se ejecuta.
 */
const WORKER = [
  {
    nombre: 'metricas.agregarSesiones (por pasada)',
    veces: () => 288,
    // Cada sesion se suma una vez y se borra: entre pasada y pasada solo esta
    // lo que ha llegado en esos cinco minutos.
    coste: ({ A }) => min1((A * 2) / 288),
    detalle: 'las sesiones llegadas desde la pasada anterior',
  },
  {
    nombre: 'metricas.resumir (una vez cada 6 h)',
    veces: () => 4,
    // Las cohortes congeladas se copian del resumen anterior; las vivas salen de
    // los usuarios dados de alta hace poco, a una lectura por cabeza para su
    // ultimo trayecto. Los totales y las ventanas, de consultas de conteo.
    coste: ({ U, V, A }) => min1(200) + min1(1) + altasRecientes(U, A) * 2
      + min1(U / 1000) + min1(V / 1000) * 5,
    detalle: 'los 200 dias + el resumen anterior + las altas recientes y su ultimo viaje '
      + '+ los conteos de totales y ventanas',
  },
  {
    nombre: 'avisarRachasEnPeligro (UNA vez al dia, a las 20:00)',
    veces: () => 1,
    coste: ({ U }) => U,
    detalle: 'TODOS los usuarios, para ver a quien se le cae la racha',
  },
  {
    nombre: 'metricas.tocaResumir (por pasada)',
    veces: () => 288,
    coste: () => min1(1),
    detalle: 'la marca del agregado, para saber si toca el resumen caro',
  },
  {
    nombre: 'recalcularRuta (por viaje APROBADO)',
    veces: ({ S }) => Math.round(S * 0.5),
    // Acotado a los 200 mas rapidos de la ruta: solo puntuan los siete
    // primeros, y a quien se cae del podio se le quitan los puntos por la otra
    // consulta.
    coste: ({ U, V }) => min1(Math.min(200, viajesEnRuta(V))) + min1(U * 0.1) + min1(U * 0.1),
    detalle: 'los 200 mas rapidos de esa ruta + quien ya puntuaba en ella',
  },
  {
    nombre: 'recalcularEstaciones (una vez por pasada CON viajes)',
    veces: ({ S }) => ventanasConMovimiento(S, 288),
    // La influencia sobre una estacion sale SOLO de los viajes de las rutas que
    // la tocan, y el indice de `agregados/rutas` dice cuales son. Antes esto
    // leia `usuarios` y `tiempos_viaje` enteros.
    coste: ({ C, V, E, S }) => min1(1) + C + estacionesEnLaPasada(S)
      * (min1(1) + rutasPorEstacion(V, E) * min1(viajesPorRutaActiva(V))),
    detalle: 'el indice de rutas + los clanes (de ahi sale de quien es cada piloto) '
      + '+ los viajes de las rutas que tocan cada estacion',
  },
  {
    nombre: 'reconstruirAgregados (parcial, como mucho cada 15 min)',
    // 96 ventanas al dia; solo cuentan las que hayan tenido alguna subida.
    veces: ({ S }) => ventanasConMovimiento(S, 96),
    // Los viajes solo hacen falta para los agregados POR RUTA y para el contador
    // de la portada. Los rankings de pilotos, el de clanes y el mapa salen de
    // usuarios, clanes y estaciones_stats.
    coste: ({ U, V, C, E, S }) => U + C + E
      + (rutasEnLaVentana(S) + RUTAS_POR_TURNO) * min1(viajesPorRutaActiva(V))
      + min1(V / 1000)
      + min1(3),
    detalle: 'usuarios + clanes + estaciones + los viajes de las rutas movidas '
      + 'y de las tres del turno de refresco + el conteo agregado '
      + '+ el indice, la portada y las rutas pendientes',
  },
  {
    nombre: 'agregados.tocaReconstruir (por pasada con movimiento)',
    veces: ({ S }) => ventanasConMovimiento(S, 288),
    coste: () => min1(1),
    detalle: 'la marca del agregado de portada, para saber si toca',
  },
  {
    nombre: 'reunirContexto (por viaje procesado)',
    veces: ({ S }) => S,
    // La ventana de huellas ya no va aqui: se lee una vez por ejecucion, no una
    // por viaje. El duplicado exacto es una lectura por el id del documento.
    coste: ({ V }) => min1(Math.min(200, V)) + min1(40) + min1(1),
    detalle: 'tiempos de la ruta (tope 200) + propios (tope 40) + el duplicado exacto por id',
  },
  {
    nombre: 'la ventana de huellas (una vez por ejecucion CON viajes)',
    veces: ({ S }) => ventanasConMovimiento(S, 288),
    coste: () => min1(150),
    detalle: 'las 150 huellas mas recientes, cacheadas para toda la ejecucion',
  },
  {
    nombre: 'prepararDia (por pasada)',
    veces: () => 288,
    coste: () => min1(2),
    detalle: 'mision del dia + config; corta en seco si la ruta del dia ya esta elegida',
  },
  {
    nombre: 'prepararDia, la parte cara (UNA vez al dia)',
    veces: () => 1,
    // El conteo por ruta sale del indice que deja la reconstruccion de
    // agregados. Antes leia `tiempos_viaje` entera.
    coste: () => min1(1),
    detalle: 'el indice de rutas, que ya trae cuantos viajes tiene cada tramo',
  },
  {
    nombre: 'validarBasico y captura (por viaje procesado)',
    veces: ({ S }) => S,
    coste: () => min1(60) + min1(1) + min1(1),
    detalle: 'sus 60 viajes recientes + la captura + la distancia de la ruta',
  },
  {
    nombre: 'cola y bajas (por pasada)',
    veces: () => 288,
    coste: () => min1(1) + min1(1) + min1(1),
    detalle: 'las consultas de cola, recalculo pendiente y bajas',
  },
];

// --- Calculo -------------------------------------------------------------------------

function calcular(escenario) {
  const e = ESCENARIOS[escenario];

  const pantallas = PANTALLAS.map((p) => {
    const porCarga = min1(p.coste(e));
    return { ...p, porCarga, alDia: Math.round(porCarga * p.veces * e.A) };
  });

  const worker = WORKER.map((o) => {
    const porVez = min1(o.coste(e));
    const veces = o.veces(e);
    return { ...o, porVez, veces, alDia: Math.round(porVez * veces) };
  });

  const totalPantallas = pantallas.reduce((t, p) => t + p.alDia, 0);
  const totalWorker = worker.reduce((t, o) => t + o.alDia, 0);
  const total = totalPantallas + totalWorker;

  return { e, pantallas, worker, totalPantallas, totalWorker, total };
}

const num = (n) => n.toLocaleString('es-ES');
const pct = (n) => `${Math.round((n / CUOTA_LECTURAS) * 100)}%`;

function imprimirTexto() {
  for (const nombre of Object.keys(ESCENARIOS)) {
    const r = calcular(nombre);
    console.log(`\n=== ${nombre} — ${r.e.A} activos/dia, ${num(r.e.V)} viajes acumulados ===`);

    console.log('\n  Pantallas (por carga / al dia):');
    for (const p of r.pantallas.sort((a, b) => b.alDia - a.alDia)) {
      console.log(`    ${p.ruta.padEnd(14)} ${String(num(p.porCarga)).padStart(9)} ${String(num(p.alDia)).padStart(11)}`);
    }

    console.log('\n  Worker (por vez / al dia):');
    for (const o of r.worker.sort((a, b) => b.alDia - a.alDia)) {
      console.log(`    ${o.nombre.slice(0, 42).padEnd(44)} ${String(num(o.porVez)).padStart(7)} ${String(num(o.alDia)).padStart(11)}`);
    }

    console.log(`\n  TOTAL: ${num(r.total)} lecturas/dia — ${pct(r.total)} de la cuota`);
    if (r.total > CUOTA_LECTURAS) {
      const horas = (CUOTA_LECTURAS / r.total) * 24;
      console.log(`  LA CUOTA SE AGOTA EN ${horas.toFixed(1)} HORAS. La web deja de funcionar hasta medianoche.`);
    }
  }
}

function imprimirMarkdown() {
  console.log('| Pantalla | Lecturas por carga | De donde salen |');
  console.log('|---|---:|---|');
  const base = calcular('u200');
  for (const p of [...base.pantallas].sort((a, b) => b.porCarga - a.porCarga)) {
    console.log(`| \`${p.ruta}\` | ${num(p.porCarga)} | ${p.detalle} |`);
  }

  console.log('\n| Operacion del worker | Lecturas por vez | De donde salen |');
  console.log('|---|---:|---|');
  for (const o of [...base.worker].sort((a, b) => b.porVez - a.porVez)) {
    console.log(`| ${o.nombre} | ${num(o.porVez)} | ${o.detalle} |`);
  }

  console.log('\n| Escenario | Activos/dia | Viajes acumulados | Lecturas/dia | % de la cuota |');
  console.log('|---|---:|---:|---:|---:|');
  for (const nombre of Object.keys(ESCENARIOS)) {
    const r = calcular(nombre);
    const aviso = r.total > CUOTA_LECTURAS ? ' **se agota**' : '';
    console.log(`| ${nombre} | ${r.e.A} | ${num(r.e.V)} | ${num(r.total)} | ${pct(r.total)}${aviso} |`);
  }
}

/** Devuelve las operaciones que por si solas se comen la cuota. */
function insostenibles(escenario = 'u200') {
  const r = calcular(escenario);
  return [
    ...r.pantallas.map((p) => ({ que: p.ruta, alDia: p.alDia })),
    ...r.worker.map((o) => ({ que: o.nombre, alDia: o.alDia })),
  ].filter((x) => x.alDia > CUOTA_LECTURAS);
}

if (require.main === module) {
  if (process.argv.includes('--markdown')) {
    imprimirMarkdown();
  } else if (process.argv.includes('--comprobar')) {
    const malas = insostenibles();
    for (const m of malas) console.error(`  ${m.que}: ${num(m.alDia)} lecturas/dia, por si sola`);
    console.log(malas.length
      ? `\n${malas.length} operacion(es) se comen la cuota diaria con 200 usuarios activos.`
      : 'Ninguna operacion se come la cuota por si sola con 200 usuarios activos.');
    process.exit(malas.length ? 1 : 0);
  } else {
    imprimirTexto();
  }
}

module.exports = { ESCENARIOS, PANTALLAS, WORKER, CUOTA_LECTURAS, calcular, insostenibles };
