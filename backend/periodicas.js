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

  const pilotos = snap.docs.map((d) => ({
    uid: d.id,
    // Los puntos de ESTA liga, no los del mes: con ligas de dos semanas, los
    // de temporada mezclarian dos ligas distintas.
    puntos: d.data().puntosLiga || 0,
    division: d.data().division || 'hierro',
    datos: d.data(),
  }));

  const cambios = divisiones.calcularSemana(pilotos);
  const conPuntos = pilotos.filter((p) => p.puntos !== 0);

  console.log(`${pilotos.length} pilotos, ${cambios.length} cambian de liga, `
    + `${conPuntos.length} con puntos que vuelven a cero.\n`);

  const resumen = {};
  for (const c of cambios) resumen[c.division] = (resumen[c.division] || 0) + 1;
  for (const [nivel, n] of Object.entries(resumen)) console.log(`  a ${nivel}: ${n}`);

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

  // Solo se escriben los que cambian: con 400 pilotos y 40 movimientos, escribir
  // los 400 es tirar cuota.
  //
  // Con el cambio va `ultimoCambioDivision`, en la MISMA escritura: es lo que
  // enseña Hoy una sola vez el lunes (02 Hoy · 2g). Sin el, el piloto veria
  // otra liga sin saber por que ni desde donde. Y la insignia de la liga, si es
  // la primera vez que llega.
  const fecha = hoy;
  const cambiados = new Set();
  for (let i = 0; i < cambios.length; i += 400) {
    const lote = db.batch();
    for (const c of cambios.slice(i, i + 400)) {
      const insignias = logros.nuevas({ ...c.datos, division: c.division });
      lote.update(db.doc(`usuarios/${c.uid}`), {
        division: c.division,
        puntosLiga: 0,
        ultimoCambioDivision: {
          desde: c.desde, hasta: c.division, puesto: c.puesto, total: c.total,
          puntos: c.puntos || 0, fecha,
        },
        ...(insignias.length ? { logros: admin.firestore.FieldValue.arrayUnion(...insignias) } : {}),
      });
      cambiados.add(c.uid);
    }
    await lote.commit();
  }

  // Y la liga nueva empieza para todos desde 0: los que no cambian tambien.
  const aCero = conPuntos.filter((p) => !cambiados.has(p.uid));
  for (let i = 0; i < aCero.length; i += 400) {
    const lote = db.batch();
    for (const p of aCero.slice(i, i + 400)) lote.update(db.doc(`usuarios/${p.uid}`), { puntosLiga: 0 });
    await lote.commit();
  }

  console.log(`\n${cambios.length} ligas actualizadas y ${aCero.length + cambiados.size} marcadores a cero.`);

  // El aviso (07 · 7a: "Subes a Oro"). Desactivado por defecto: solo a quien lo
  // ha pedido. Un fallo aqui no deshace nada de lo anterior.
  const nombre = (n) => n.charAt(0).toUpperCase() + n.slice(1);
  let avisados = 0;
  for (const c of cambios) {
    const sube = divisiones.NIVELES.indexOf(c.division) > divisiones.NIVELES.indexOf(c.desde);
    try {
      const r = await push.enviar(c.uid, 'cambioDivision', {
        titulo: sube ? `Subes a ${nombre(c.division)}` : `Bajas a ${nombre(c.division)}`,
        cuerpo: sube
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
  else {
    console.error('Operacion desconocida. Usa: temporada | divisiones');
    process.exit(1);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
