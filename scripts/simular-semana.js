#!/usr/bin/env node
/**
 * Una semana de bicifastness bien usada, dia a dia y piloto a piloto.
 *
 * Responde a tres preguntas antes de que las responda el lanzamiento:
 *
 *   1. ¿Que se rompe cuando entra gente de verdad?
 *   2. ¿Cuantos pilotos perdemos por cada cosa que se rompe?
 *   3. ¿Cuanto se gana con cada arreglo?
 *
 * Simula dos veces la MISMA semana (misma semilla, mismas personas, mismos
 * viajes): "antes", con el codigo como estaba, y "despues", con los arreglos.
 * La diferencia es lo que valen.
 *
 * Lo que sale del codigo y no se inventa: el coste en lecturas de cada pantalla
 * y de cada operacion del worker (scripts/auditar-lecturas.js, el mismo modelo
 * que docs/COSTE.md), la cuota del plan gratuito, la hora a la que se reinicia,
 * el cupo de viajes, la cadencia del worker y como se cierran las rachas.
 *
 * Lo que es una SUPOSICION va junto en `SUPUESTOS`, con su porque. Son
 * estimaciones razonables, no medidas: el lanzamiento las medira. Cambiarlas y
 * volver a correr es la forma de ver cuanto depende cada conclusion de ellas.
 *
 * Uso:
 *   node scripts/simular-semana.js                 # resumen en pantalla
 *   node scripts/simular-semana.js --altas 800     # mas gente
 *   node scripts/simular-semana.js --semilla 7     # otra semana posible
 *   node scripts/simular-semana.js --markdown      # las tablas de SIMULACION.md
 *   node scripts/simular-semana.js --escribir      # las escribe en docs/SIMULACION.md
 */

const fs = require('fs');
const path = require('path');
const coste = require('./auditar-lecturas');

// --- Lo que sale del codigo -------------------------------------------------------

const CUOTA_LECTURAS = coste.CUOTA_LECTURAS; // plan Spark
/** La cuota se reinicia a medianoche del Pacifico: las 09:00 en Madrid (docs/COSTE.md). */
const HORA_REINICIO_CUOTA = 9;
/** backend/src/config.js, LIMITES.VIAJES_POR_DIA. */
const CUPO_PUNTUA = 3;

// --- Lo que es una suposicion -----------------------------------------------------

const SUPUESTOS = {
  // Altas de la semana del lanzamiento: un pico el primer dia y una cola.
  altasPorDia: [0.32, 0.18, 0.13, 0.11, 0.1, 0.09, 0.07],
  // Tres tipos de piloto. La mezcla es la de cualquier app de habito: pocos
  // diarios que hacen la mitad del uso y muchos que lo prueban.
  tipos: {
    diario: { parte: 0.25, viajesLaborable: 2, probFinde: 0.3, bajaNatural: 0.01 },
    ocasional: { parte: 0.45, probDia: 0.35, bajaNatural: 0.03 },
    curioso: { parte: 0.3, probPrimerDia: 0.6, probDia: 0.1, bajaNatural: 0.15 },
  },
  // Del pipeline de verificacion. El ensayo (docs/ENSAYO.md) deja un 12% sin
  // aprobar; aqui un 13% va a revision humana y un 7% se rechaza solo.
  capturaInvalida: 0.06,
  veredicto: { aprobado: 0.8, revision: 0.13, rechazado: 0.07 },
  // De los rechazos automaticos, cuantos son por señales sumadas (blandas) y no
  // por una decisiva (velocidad imposible, captura repetida o manipulada).
  parteRechazoBlando: 0.5,
  // El relevo del worker (verificar-viajes.yml) se rompe algun dia: entonces
  // solo queda el cron de GitHub, que medimos en 4-6 ejecuciones al dia.
  probRelevoRoto: 0.08,
  esperaSinRelevoHoras: 3,
  // Revision humana: dos pasadas al dia entre semana; el finde, una de cada dos.
  horasRevision: [10, 21],
  probRevisaFinde: 0.5,
  // Cuantas visitas hace al dia un piloto activo (portada, subir, ranking...).
  visitasPorActivo: 4,
  // Que parte de las visitas cae antes de cada hora (curva de uso de un dia:
  // ida al trabajo, comida, vuelta). Sirve para saber a que hora se agota la cuota.
  usoAcumuladoPorHora: [0, 0, 0, 0, 0, 0, 0.01, 0.05, 0.14, 0.2, 0.24, 0.28, 0.33,
    0.4, 0.46, 0.5, 0.55, 0.62, 0.72, 0.81, 0.88, 0.93, 0.97, 0.99, 1],
  // Clanes: quien pide entrar y si el lider responde a tiempo.
  probPideClan: 0.4,
  probLiderResponde24h: 0.6,
  // Despues de los arreglos, cuantos clanes eligen entrada libre.
  parteClanesLibres: 0.4,
  // Cuanto se van, por lo que les pasa. Es lo mas incierto de todo; la
  // literatura de onboarding pone la primera experiencia fallida entre el 30 y
  // el 50% de abandono.
  baja: {
    primerViajeRechazado: 0.4,
    primerViajeCapturaInvalida: 0.08,
    primerViajeEsperaLarga: 0.2, // mas de 12 h en revision
    primerViajeLento: 0.1, // mas de 1 h hasta saber algo
    webCaida: 0.25, // intenta entrar con la cuota agotada
    rachaPerdidaInjusta: 0.15, // racha de 3+ dias perdida por un viaje en revision
    clanSinRespuesta: 0.05,
  },
};

// --- La simulacion -----------------------------------------------------------------

const DIAS = 7;
const LABORABLE = [true, true, true, true, true, false, false]; // empieza en lunes

/** Las lecturas del dia: el modelo de docs/COSTE.md, y el sobrecoste de antes. */
function lecturasDelDia({ U, A, V, C, E, S }, conArreglos) {
  coste.ESCENARIOS.simulacion = { U, A, V, C, E, S };
  const { total } = coste.calcular('simulacion');
  if (conArreglos) return total;

  // Lo que costaba antes de esta tanda de arreglos, con sus mismas formulas.
  const { min1, viajesEnRuta, ventanasConMovimiento, rutasPorEstacion, viajesPorRutaActiva } = coste;
  const ventanas = Math.max(1, ventanasConMovimiento(S, 96));
  const estacionesAntes = ventanas * (1 + C + Math.max(2, Math.min(60, Math.round((S / ventanas) * 2)))
    * (1 + rutasPorEstacion(V, E) * min1(viajesPorRutaActiva(V))));
  const estacionesAhora = ventanas * (min1(Math.max(1, Math.round(S / ventanas))) + C
    + Math.max(2, Math.min(60, Math.round((S / ventanas) * 2))));
  const contextoAntes = S * 39; // los 40 viajes del piloto por cada viaje, frente a su perfil
  const rutasPodio = Math.round((S * 0.5) / 3);
  const podioAntes = rutasPodio * (min1(Math.min(200, viajesEnRuta(V))) + min1(U * 0.1) * 2);
  const podioAhora = rutasPodio * (min1(Math.min(25, viajesEnRuta(V))) + 9);
  return total + (estacionesAntes - estacionesAhora) + contextoAntes + (podioAntes - podioAhora);
}

/** La hora a la que se agota la cuota ese dia, o null si no se agota. */
function horaCaida(lecturas) {
  if (lecturas <= CUOTA_LECTURAS) return null;
  const parte = CUOTA_LECTURAS / lecturas;
  const curva = SUPUESTOS.usoAcumuladoPorHora;
  for (let h = 0; h < curva.length; h++) if (curva[h] >= parte) return h;
  return 23;
}

/**
 * Un numero al azar fijo para cada cosa que puede pasar: el mismo piloto, el
 * mismo dia y el mismo suceso dan siempre el mismo numero, sea cual sea el
 * escenario. Asi "antes" y "despues" simulan a las MISMAS personas haciendo lo
 * MISMO, y la diferencia entre los dos es solo lo que cambian los arreglos (con
 * un generador en secuencia, en cuanto un escenario tira un dado de mas, todo
 * lo que viene detras es otra gente).
 */
function dado(semilla, ...claves) {
  let h = (semilla ^ 0x9e3779b9) >>> 0;
  for (const c of claves) {
    h = Math.imul(h ^ (c >>> 0), 2654435761) >>> 0;
    h ^= h >>> 15;
    h = Math.imul(h, 2246822507) >>> 0;
    h ^= h >>> 13;
  }
  return (h >>> 0) / 4294967296;
}

/** Los sucesos, para que cada uno tenga su propio dado. */
const S = {
  TIPO: 1, VIAJES: 2, HORA: 3, CAPTURA: 4, VEREDICTO: 5, BLANDO: 6, BAJA_PRIMERO: 7,
  RACHA: 8, PIDE_CLAN: 9, CLAN_LIBRE: 10, LIDER: 11, BAJA_CLAN: 12, NATURAL: 13, BAJA_CAIDA: 14,
  RELEVO: 15, REVISA: 16,
};

function simular({ altas = 500, semilla = 2026, conArreglos = true, sinTopeCuota = false } = {}) {
  const pilotos = [];
  const bajas = {};
  const darDeBaja = (p, motivo) => {
    if (!p.activo) return;
    p.activo = false;
    bajas[motivo] = (bajas[motivo] || 0) + 1;
  };

  let viajesAcumulados = 0;
  let clanesCreados = 0;
  const dias = [];

  for (let d = 0; d < DIAS; d++) {
    // Altas del dia.
    const nuevas = Math.round(altas * SUPUESTOS.altasPorDia[d]);
    for (let i = 0; i < nuevas; i++) {
      const id = pilotos.length;
      const r = dado(semilla, S.TIPO, id);
      const t = SUPUESTOS.tipos;
      const tipo = r < t.diario.parte ? 'diario' : r < t.diario.parte + t.ocasional.parte ? 'ocasional' : 'curioso';
      pilotos.push({ id, tipo, alta: d, activo: true, viajes: 0, racha: 0, escudos: 0, pidioClan: false, enClan: false, esperaClanDesde: null });
    }
    if (d === 0) clanesCreados = Math.max(3, Math.round(nuevas * 0.04));
    else clanesCreados += Math.round(nuevas * 0.02);

    const relevoRoto = dado(semilla, S.RELEVO, d) < SUPUESTOS.probRelevoRoto;
    const revisaHoy = LABORABLE[d] || dado(semilla, S.REVISA, d) < SUPUESTOS.probRevisaFinde;

    // Quien sale hoy y cuantos viajes sube.
    let subidas = 0;
    let activosHoy = 0;
    const deHoy = [];
    for (const p of pilotos) {
      if (!p.activo) continue;
      const t = SUPUESTOS.tipos[p.tipo];
      const u = dado(semilla, S.VIAJES, p.id, d);
      let viajes = 0;
      if (p.tipo === 'diario') viajes = LABORABLE[d] ? t.viajesLaborable : (u < t.probFinde ? 1 : 0);
      else if (p.tipo === 'ocasional') viajes = u < t.probDia ? 1 : 0;
      else viajes = u < (p.alta === d ? t.probPrimerDia : t.probDia) ? 1 : 0;
      viajes = Math.min(viajes, CUPO_PUNTUA * 2);
      if (viajes || p.alta === d) activosHoy++;
      if (viajes) deHoy.push({ p, viajes });
      subidas += viajes;
    }

    // La cuota de hoy, con lo que mueve el dia.
    const lecturas = lecturasDelDia({
      U: pilotos.length,
      A: Math.max(1, Math.round(activosHoy * SUPUESTOS.visitasPorActivo / 3)),
      V: viajesAcumulados + 1,
      C: Math.max(1, clanesCreados),
      E: Math.min(631, 120 + viajesAcumulados / 10),
      S: Math.max(1, subidas),
    }, conArreglos);
    // Con el plan Blaze no hay tope: se paga lo que se lee y la web no se cae.
    const caida = sinTopeCuota ? null : horaCaida(lecturas);

    let perdidosPorCaida = 0;
    let rachasSalvadas = 0;
    for (const { p, viajes } of deHoy) {
      // A que hora sale a subir: los diarios, por la tarde; el resto, cuando sea.
      const uh = dado(semilla, S.HORA, p.id, d);
      const hora = p.tipo === 'diario' ? 18 + Math.floor(uh * 4) : 8 + Math.floor(uh * 14);
      if (caida !== null && hora >= caida) {
        perdidosPorCaida += viajes;
        if (dado(semilla, S.BAJA_CAIDA, p.id, d) < SUPUESTOS.baja.webCaida) darDeBaja(p, 'La web caída por la cuota (no pudo subir)');
        continue;
      }

      const primero = p.viajes === 0;
      let diaContado = false;
      for (let v = 0; v < viajes && p.activo; v++) {
        if (dado(semilla, S.CAPTURA, p.id, d, v) < SUPUESTOS.capturaInvalida) {
          if (primero && v === 0 && dado(semilla, S.BAJA_PRIMERO, p.id, d, v) < SUPUESTOS.baja.primerViajeCapturaInvalida) darDeBaja(p, 'Primera captura no válida');
          continue;
        }
        const r = dado(semilla, S.VEREDICTO, p.id, d, v);
        const vd = SUPUESTOS.veredicto;
        let decision = r < vd.aprobado ? 'aprobado' : r < vd.aprobado + vd.revision ? 'revision' : 'rechazado';
        // Despues: el primer trayecto no se rechaza solo por señales sumadas,
        // va a revision (verificacion.evaluar, `primerViaje`).
        if (conArreglos && primero && v === 0 && decision === 'rechazado'
          && dado(semilla, S.BLANDO, p.id, d, v) < SUPUESTOS.parteRechazoBlando) decision = 'revision';
        p.viajes++;
        viajesAcumulados++;

        // Cuanto tarda en saber algo.
        let espera = relevoRoto ? SUPUESTOS.esperaSinRelevoHoras : 0.1;
        if (decision === 'revision') {
          const siguiente = revisaHoy ? SUPUESTOS.horasRevision.find((h) => h > hora) : undefined;
          espera += siguiente !== undefined ? siguiente - hora : 24 - hora + SUPUESTOS.horasRevision[0] + (LABORABLE[(d + 1) % 7] ? 0 : 12);
        }

        if (primero && v === 0) {
          const ub = dado(semilla, S.BAJA_PRIMERO, p.id, d, v);
          if (decision === 'rechazado' && ub < SUPUESTOS.baja.primerViajeRechazado) { darDeBaja(p, 'Primer viaje rechazado'); break; }
          if (decision === 'revision' && espera > 12 && ub < SUPUESTOS.baja.primerViajeEsperaLarga) { darDeBaja(p, 'Primer viaje más de 12 h en revisión'); break; }
          if (decision !== 'rechazado' && espera > 1 && ub < SUPUESTOS.baja.primerViajeLento) { darDeBaja(p, 'Primer viaje: más de 1 h sin saber nada'); break; }
        }
        if (decision === 'rechazado') continue;
        diaContado = true;

        // La racha. Antes, un viaje sin decidir a medianoche dejaba el dia sin
        // contar: escudo gastado o racha rota, y no volvia al aprobarse.
        if (hora + espera >= 24 && p.racha >= 3) {
          if (conArreglos) rachasSalvadas++;
          else if (p.escudos > 0) p.escudos--;
          else {
            p.racha = 0;
            if (dado(semilla, S.RACHA, p.id, d) < SUPUESTOS.baja.rachaPerdidaInjusta) { darDeBaja(p, 'Racha perdida por un viaje en revisión'); break; }
          }
        }
      }
      if (p.activo && diaContado) {
        p.racha++;
        if (p.racha % 7 === 0) p.escudos = Math.min(2, p.escudos + 1);
      }

      // Clanes: hacia el tercer dia, parte de la gente pide entrar en uno.
      if (p.activo && !p.pidioClan && d - p.alta >= 2 && dado(semilla, S.PIDE_CLAN, p.id, d) < SUPUESTOS.probPideClan) {
        p.pidioClan = true;
        const libre = conArreglos && dado(semilla, S.CLAN_LIBRE, p.id) < SUPUESTOS.parteClanesLibres;
        if (libre || dado(semilla, S.LIDER, p.id) < SUPUESTOS.probLiderResponde24h) p.enClan = true;
        else p.esperaClanDesde = d;
      }
    }

    // Quien pidio clan hace dos dias y sigue sin respuesta.
    for (const p of pilotos) {
      if (p.activo && !p.enClan && p.esperaClanDesde !== null && d - p.esperaClanDesde >= 2) {
        if (dado(semilla, S.BAJA_CLAN, p.id) < SUPUESTOS.baja.clanSinRespuesta) darDeBaja(p, 'Pidió clan y nadie respondió en 48 h');
        p.esperaClanDesde = null;
      }
    }

    // La baja natural de cada dia: la que no tiene que ver con nada que fallemos.
    for (const p of pilotos) {
      if (p.activo && p.alta < d && dado(semilla, S.NATURAL, p.id, d) < SUPUESTOS.tipos[p.tipo].bajaNatural / (p.viajes ? 2 : 1)) {
        darDeBaja(p, 'Natural (se le olvida, no le engancha)');
      }
    }

    dias.push({
      dia: d + 1, altas: nuevas, activos: activosHoy, subidas, lecturas,
      cuota: Math.round((lecturas / CUOTA_LECTURAS) * 100), caida, perdidosPorCaida, relevoRoto, rachasSalvadas,
    });
  }

  const siguen = pilotos.filter((p) => p.activo).length;
  return { altas: pilotos.length, siguen, bajas, dias };
}

// --- Salida ------------------------------------------------------------------------

const num = (n) => Math.round(n).toLocaleString('es-ES');
const DIAS_SEMANA = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];

function tablaDias(r) {
  const filas = r.dias.map((d) => `| ${DIAS_SEMANA[d.dia - 1]} | ${d.altas} | ${d.activos} | ${d.subidas} | ${num(d.lecturas)} (${d.cuota}%) | `
    + `${d.caida === null ? '—' : `a las ${d.caida}:00 hasta las ${HORA_REINICIO_CUOTA}:00`} | ${d.perdidosPorCaida || '—'} | ${d.relevoRoto ? 'roto' : 'bien'} |`);
  return ['| Día | Altas | Activos | Viajes | Lecturas (cuota) | Web caída | Viajes perdidos | Relevo del worker |',
    '|---|---:|---:|---:|---:|---|---:|---|', ...filas].join('\n');
}

function tablaBajas(antes, despues, blaze) {
  const motivos = [...new Set([...Object.keys(antes.bajas), ...Object.keys(despues.bajas), ...Object.keys(blaze.bajas)])]
    .sort((a, b) => (antes.bajas[b] || 0) - (antes.bajas[a] || 0));
  const filas = motivos.map((m) => `| ${m} | ${antes.bajas[m] || 0} | ${despues.bajas[m] || 0} | ${blaze.bajas[m] || 0} |`);
  return ['| Por qué se van | Antes | Después | Después + Blaze |', '|---|---:|---:|---:|', ...filas,
    `| **Siguen al acabar la semana** | **${antes.siguen} de ${antes.altas}** | **${despues.siguen} de ${despues.altas}** | **${blaze.siguen} de ${blaze.altas}** |`].join('\n');
}

function correr(argv) {
  const valor = (nombre, defecto) => {
    const i = argv.indexOf(nombre);
    return i >= 0 ? Number(argv[i + 1]) : defecto;
  };
  const altas = valor('--altas', 500);
  const semilla = valor('--semilla', 2026);
  const antes = simular({ altas, semilla, conArreglos: false });
  const despues = simular({ altas, semilla, conArreglos: true });
  const blaze = simular({ altas, semilla, conArreglos: true, sinTopeCuota: true });
  return { altas, semilla, antes, despues, blaze };
}

function markdown({ altas, semilla, antes, despues, blaze }) {
  return [
    `Semana simulada con ${altas} altas (semilla ${semilla}).`,
    '',
    '**Antes de los arreglos**',
    '',
    tablaDias(antes),
    '',
    '**Después de los arreglos**',
    '',
    tablaDias(despues),
    '',
    tablaBajas(antes, despues, blaze),
  ].join('\n');
}

const MARCA_INICIO = '<!-- simulacion:inicio -->';
const MARCA_FIN = '<!-- simulacion:fin -->';

if (require.main === module) {
  const argv = process.argv.slice(2);
  const r = correr(argv);
  if (argv.includes('--escribir')) {
    const doc = path.join(__dirname, '..', 'docs', 'SIMULACION.md');
    const texto = fs.readFileSync(doc, 'utf8');
    const a = texto.indexOf(MARCA_INICIO);
    const b = texto.indexOf(MARCA_FIN);
    if (a < 0 || b < 0) throw new Error('docs/SIMULACION.md no tiene las marcas de la tabla');
    fs.writeFileSync(doc, `${texto.slice(0, a + MARCA_INICIO.length)}\n${markdown(r)}\n${texto.slice(b)}`);
    console.log('docs/SIMULACION.md actualizado.');
  } else if (argv.includes('--markdown')) {
    console.log(markdown(r));
  } else {
    for (const [nombre, s] of [['ANTES', r.antes], ['DESPUES', r.despues], ['DESPUES + BLAZE', r.blaze]]) {
      console.log(`\n=== ${nombre} — ${s.siguen} de ${s.altas} siguen al acabar la semana ===`);
      for (const d of s.dias) {
        console.log(`  ${DIAS_SEMANA[d.dia - 1]}  activos ${String(d.activos).padStart(4)}  viajes ${String(d.subidas).padStart(4)}  `
          + `lecturas ${num(d.lecturas).padStart(8)} (${String(d.cuota).padStart(3)}%)  `
          + `${d.caida === null ? '' : `CAIDA desde las ${d.caida}:00, ${d.perdidosPorCaida} viajes perdidos`}`);
      }
      for (const [motivo, n] of Object.entries(s.bajas).sort((a, b) => b[1] - a[1])) console.log(`  - ${motivo}: ${n}`);
    }
  }
}

module.exports = { simular, SUPUESTOS, correr, markdown };
