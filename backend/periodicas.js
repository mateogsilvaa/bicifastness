#!/usr/bin/env node
'use strict';

/**
 * Operaciones periodicas del juego: cierre de temporada y de liga.
 *
 * Van aparte del worker a proposito. El worker corre cada pocos minutos y
 * procesa una cola; esto corre una vez al mes o a la semana y toca a TODOS los
 * usuarios. Mezclarlas seria arriesgar que un despliegue del worker dispare por
 * accidente un cierre de temporada.
 *
 * Uso:
 *   node backend/periodicas.js temporada --simular
 *   node backend/periodicas.js temporada --aplicar
 *   node backend/periodicas.js divisiones --simular
 *   node backend/periodicas.js divisiones --aplicar
 *   node backend/periodicas.js divisiones --aplicar --forzar   (cierra la liga
 *     en juego aunque hoy no toque; solo a mano y sabiendo lo que se hace)
 *
 * `divisiones` corre todos los lunes, pero solo HACE algo el lunes que cierra
 * una liga de dos semanas (`divisiones.esCambioDeLiga`). Los demas lunes dice
 * cuando toca y sale. Asi el cron sigue siendo semanal y sencillo, y la regla
 * de las dos semanas vive en un solo sitio, con su test.
 *
 * `--simular` es el modo por defecto a proposito: la version que escribe hay
 * que pedirla. Con la que borra por defecto, un error de tecleo cierra la
 * temporada de todo el mundo.
 */

const admin = require('firebase-admin');

const temporadas = require('./src/temporadas');
const divisiones = require('./src/divisiones');
const push = require('./src/push');
const logros = require('./src/logros');
const { diaMadrid } = require('./src/util');
const lanzamiento = require('./src/lanzamiento');
const pilotosCache = require('./src/pilotos-cache');

const [operacion] = process.argv.slice(2);
const APLICAR = process.argv.includes('--aplicar');
const FORZAR = process.argv.includes('--forzar');

function arrancar() {
  const credenciales = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!credenciales) {
    console.error('Falta FIREBASE_SERVICE_ACCOUNT.');
    process.exit(1);
  }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(credenciales)) });
  return admin.firestore();
}

const db = arrancar();

/**
 * Cierra la temporada ANTERIOR, no la actual.
 *
 * El workflow corre el dia 1: a esa hora la temporada que hay que cerrar es la
 * del mes que acaba de terminar. Cerrar la actual borraria un mes que acaba de
 * empezar.
 */
async function cerrarTemporada() {
  const actual = temporadas.idTemporada(new Date());
  const aCerrar = temporadas.temporadaAnterior(actual);

  // Antes del lanzamiento no hay temporadas de verdad: octubre fue la fase de
  // pruebas, y cerrarlo repartiria insignias de algo que no cuenta.
  if (`${aCerrar}-31` < divisiones.LANZAMIENTO) {
    console.log(`${aCerrar} es anterior al lanzamiento (${divisiones.LANZAMIENTO}): no se cierra.`);
    return;
  }

  console.log(`Temporada en curso: ${actual}`);
  console.log(`Se va a cerrar:     ${aCerrar}\n`);

  const resultado = await temporadas.cerrar(aCerrar, { simular: !APLICAR });

  if (resultado.yaCerrada) {
    console.log('Ya estaba cerrada. No se toca nada.');
    return;
  }

  if (resultado.simulado) {
    console.log(`SIMULACION: ${resultado.usuarios} usuarios, `
      + `${resultado.conPuntos} con puntos, ${resultado.insignias} insignias.`);
    console.log('\nNada se ha modificado. Repite con --aplicar.');
    return;
  }

  console.log(`Archivados ${resultado.archivados} usuarios, `
    + `${resultado.insignias} insignias repartidas.`);

  await temporadas.abrir(actual);
  console.log(`Temporada ${actual} abierta.`);
}

async function actualizarDivisiones() {
  const hoy = diaMadrid();

  if (!divisiones.esCambioDeLiga(hoy) && !FORZAR) {
    console.log(`Hoy (${hoy}) no cierra ninguna liga. La que esta en juego empezo el `
      + `${divisiones.inicioLiga(hoy)} y acaba el ${divisiones.finLiga(hoy)}.`);
    return;
  }

  // La liga que se cierra es la que estaba en juego AYER: hoy ya empieza otra.
  // Con --forzar en un dia cualquiera, es la que esta en juego.
  const cerrada = divisiones.esCambioDeLiga(hoy)
    ? divisiones.inicioLiga(divisiones.sumarDias(hoy, -1))
    : divisiones.inicioLiga(hoy);
  console.log(`Se cierra la liga del ${cerrada} al ${divisiones.finLiga(cerrada)}.\n`);

  // La misma marca que el cierre de temporada, y por lo mismo: cerrar dos veces
  // la misma liga subiria a los mismos dos veces y pondria a cero los puntos
  // de la liga nueva, que ya habria empezado a sumar.
  const marca = db.doc(`config/ligas/cerradas/${cerrada}`);
  if ((await marca.get()).exists) {
    console.log('Ya estaba cerrada. No se toca nada.');
    return;
  }

  const snap = await db.collection('usuarios').get();
  const datosDe = new Map(snap.docs.map((d) => [d.id, d.data()]));

  // Toda la regla esta en `divisiones.cerrarLiga`, que es pura y tiene sus
  // tests: subidas, bajadas, cupos de cada division, quien vuelve a sin
  // clasificar y donde entra quien sale de ahi. Aqui solo se escribe.
  const resultado = divisiones.cerrarLiga(snap.docs.map((d) => {
    const u = d.data();
    const maxima = Number.isInteger(u.divisionMaxima) ? u.divisionMaxima : divisiones.nivelDe(u.division);
    return {
      uid: d.id,
      division: divisiones.esClasificado(u.division) ? u.division : divisiones.SIN_CLASIFICAR,
      grupo: u.grupoLiga || null,
      // Los puntos de ESTA liga, no los del mes.
      puntos: u.puntosLiga || 0,
      ligasInactivas: u.ligasInactivas || 0,
      divisionMaxima: maxima,
      ligasJugadas: u.ligasJugadas || 0,
    };
  }));

  const cambios = resultado.filter((r) => r.cambia);
  const resumen = {};
  for (const r of resultado) resumen[r.division] = (resumen[r.division] || 0) + 1;
  console.log(`${resultado.length} pilotos, ${cambios.length} cambian de division.\n`);
  for (const [nivel, n] of Object.entries(resumen)) console.log(`  ${nivel.padEnd(16)} ${n}`);
  console.log('\nGrupos por division:', JSON.stringify(divisiones.gruposPorNivel(
    resultado.filter((r) => r.division !== divisiones.SIN_CLASIFICAR).length)));

  if (!APLICAR) {
    console.log('\nSIMULACION: nada se ha modificado. Repite con --aplicar.');
    return;
  }

  // PRIMERO la marca, igual que en `temporadas.cerrar`.
  await marca.set({
    cerrada: admin.firestore.FieldValue.serverTimestamp(),
    hasta: divisiones.finLiga(cerrada),
    cambios: cambios.length,
  });

  // Se escribe a quien le cambia ALGO: division, grupo, contadores o puntos.
  // Los que siguen sin clasificar y sin pedalear no se tocan.
  const fecha = hoy;
  const nombre = (n) => ({ rubi: 'Rubí', 'sin-clasificar': 'Sin clasificar' }[n] || (n.charAt(0).toUpperCase() + n.slice(1)));
  const escribir = resultado.filter((r) => {
    const u = datosDe.get(r.uid) || {};
    return r.cambia || r.grupo !== (u.grupoLiga || null) || (u.puntosLiga || 0) !== 0
      || r.ligasInactivas !== (u.ligasInactivas || 0) || r.divisionMaxima !== u.divisionMaxima;
  });
  for (let i = 0; i < escribir.length; i += 400) {
    const lote = db.batch();
    for (const r of escribir.slice(i, i + 400)) {
      const u = datosDe.get(r.uid) || {};
      // La insignia de la division, si es la primera vez que llega.
      const insignias = logros.nuevas({ ...u, division: r.division, divisionMaxima: r.divisionMaxima });
      lote.update(db.doc(`usuarios/${r.uid}`), {
        division: r.division,
        grupoLiga: r.grupo,
        puntosLiga: 0,
        ligasInactivas: r.ligasInactivas,
        divisionMaxima: r.divisionMaxima,
        ligasJugadas: r.ligasJugadas,
        // Lo que enseña Hoy una sola vez (02 Hoy · 2g). A quien vuelve a sin
        // clasificar por no pedalear no se le pone: no hay nada que celebrar ni
        // nadie mirando, y al volver vera donde entra.
        ...(r.cambia && r.division !== divisiones.SIN_CLASIFICAR ? {
          ultimoCambioDivision: {
            desde: r.desde, hasta: r.division, puesto: r.puesto, total: r.total,
            puntos: r.puntos, fecha,
          },
        } : {}),
        ...(insignias.length ? { logros: admin.firestore.FieldValue.arrayUnion(...insignias) } : {}),
      });
    }
    await lote.commit();
  }

  console.log(`\n${escribir.length} perfiles escritos, ${cambios.length} con division nueva.`);

  // El aviso (07 · 7a: "Subes a Oro"). Desactivado por defecto: solo a quien lo
  // ha pedido. Un fallo aqui no deshace nada de lo anterior.
  let avisados = 0;
  for (const c of cambios.filter((x) => x.division !== divisiones.SIN_CLASIFICAR)) {
    const entra = c.desde === divisiones.SIN_CLASIFICAR;
    const sube = entra || divisiones.nivelDe(c.division) > divisiones.nivelDe(c.desde);
    try {
      const r = await push.enviar(c.uid, 'cambioDivision', {
        titulo: entra ? `Entras en ${nombre(c.division)}` : sube ? `Subes a ${nombre(c.division)}` : `Bajas a ${nombre(c.division)}`,
        cuerpo: entra
          ? 'Ya compites en un grupo de 20. Dos semanas para subir.'
          : sube
            ? `Acabaste ${c.puesto}.º de tu grupo. Dos semanas nuevas, rivales nuevos.`
            : `Tienes dos semanas para recuperar ${nombre(c.desde)}.`,
        url: '/clasificacion/',
      });
      avisados += r.enviados || 0;
    } catch (error) {
      console.warn(`  aviso de liga no enviado a ${c.uid}:`, error.message);
    }
  }
  if (avisados) console.log(`${avisados} avisos de liga enviados.`);
}

async function main() {
  console.log(APLICAR ? '=== APLICANDO ===\n' : '=== SIMULACION ===\n');

  if (operacion === 'temporada') await cerrarTemporada();
  else if (operacion === 'divisiones') await actualizarDivisiones();
  else if (operacion === 'lanzamiento') {
    const r = await lanzamiento.lanzar({ simular: !APLICAR, forzar: FORZAR });
    console.log(JSON.stringify(r));
  } else {
    console.error('Operacion desconocida. Usa: temporada | divisiones | lanzamiento');
    process.exit(1);
  }

  // Estas operaciones cambian a muchos pilotos a la vez (division, grupo,
  // puntos): la cache de la reconstruccion parcial no lo sabe, asi que se
  // invalida y la proxima reconstruccion lee `usuarios` entera una vez.
  if (APLICAR) await pilotosCache.invalidar().catch((error) => console.warn('No se ha podido invalidar la cache de pilotos:', error.message));

  process.exit(0);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
