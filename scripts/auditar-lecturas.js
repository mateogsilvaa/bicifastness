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
    coste: ({ U, V, C, E }) => U + V + C + E,
    detalle: 'las cuatro colecciones enteras',
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
    coste: ({ A }) => min1(A * 2),
    detalle: 'las sesiones del navegador sin agregar todavia',
  },
  {
    nombre: 'metricas.resumir (una vez cada 6 h)',
    veces: () => 4,
    coste: ({ U, V }) => min1(1) + U + V + min1(200),
    detalle: 'la marca del agregado + TODOS los usuarios + TODOS los viajes + 200 dias',
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
    coste: ({ U, V }) => min1(viajesEnRuta(V)) + min1(U * 0.1) + min1(U * 0.1),
    detalle: 'los viajes de esa ruta + quien ya puntuaba en ella',
  },
  {
    nombre: 'recalcularEstaciones (una vez por pasada CON viajes)',
    veces: ({ S }) => Math.min(288, Math.max(1, Math.round(S / 8))),
    coste: ({ S }) => min1(Math.min(60, S)),
    detalle: 'una lectura por estacion tocada; usuarios y viajes vienen compartidos',
  },
  {
    nombre: 'reconstruirAgregados (una vez por pasada CON viajes)',
    veces: ({ S }) => Math.min(288, Math.max(1, Math.round(S / 8))),
    coste: ({ U, V, C, E }) => U + V + C + E,
    detalle: 'usuarios y viajes (compartidos con el resumen de metricas) + clanes + estaciones',
  },
  {
    nombre: 'reunirContexto (por viaje procesado)',
    veces: ({ S }) => S,
    coste: ({ V }) => min1(Math.min(200, V)) + min1(40) + min1(400),
    detalle: 'tiempos de la ruta (tope 200) + propios (tope 40) + huellas (tope 400)',
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
    coste: ({ V }) => V,
    detalle: 'TODOS los viajes verificados, para elegir la ruta del dia',
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
