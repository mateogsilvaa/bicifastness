#!/usr/bin/env node
/**
 * Saca la auditoria del documento del viaje.
 *
 * EL PROBLEMA. El worker guardaba el veredicto entero dentro del viaje, y las
 * reglas dejan que su dueño lea su viaje entero. El veredicto esta escrito para
 * QUIEN REVISA: riesgo acumulado, gravedad de cada señal y mensajes con los
 * numeros exactos ("distancia perceptual 4", "2,7 desviaciones por debajo de la
 * media de la ruta"). O sea que cualquiera con la consola del navegador abierta
 * tenia el manual del antifraude: cuanto puede acercarse a cada umbral sin
 * saltarlo.
 *
 * `assets/js/motivos.js` ya tapaba la puerta — la interfaz nunca ha enseñado
 * esos textos — pero la ventana seguia abierta.
 *
 * QUE HACE. Por cada viaje que todavia lleve `auditoria` dentro:
 *
 *   1. Copia el analisis a `auditorias/{viajeId}`, que solo lee la
 *      administracion.
 *   2. Deja en el viaje `motivos`: los codigos de las señales, ordenados de mas
 *      grave a menos. Son etiquetas estables, sin un solo numero, y son lo que
 *      `motivos.js` necesita para explicarle el rechazo a la persona.
 *   3. Borra `auditoria` del viaje.
 *
 * Las tres cosas van en el mismo lote: o pasa entero o no pasa nada. Un viaje al
 * que se le borrara la auditoria sin haberla copiado perderia el analisis para
 * siempre, y ese analisis es lo unico que tiene quien revisa para decidir.
 *
 * Es idempotente: los viajes que ya no llevan `auditoria` se saltan, asi que se
 * puede lanzar dos veces sin miedo y se puede parar a medias y retomar.
 *
 * Uso:
 *   export GOOGLE_APPLICATION_CREDENTIALS=/ruta/serviceAccountKey.json
 *   node scripts/migrar-auditorias.js --simular    # no escribe nada
 *   node scripts/migrar-auditorias.js --aplicar
 *
 * Mientras queden viajes sin migrar no se rompe nada: `motivos.js` y el panel
 * saben leer las dos formas. Lo que no se cierra hasta el final es la fuga.
 */

const admin = require('firebase-admin');

const SIMULAR = !process.argv.includes('--aplicar');

// Un lote de Firestore admite 500 operaciones y aqui van tres por viaje.
const POR_LOTE = 150;

admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

/**
 * Los codigos de un veredicto, de mas grave a menos.
 *
 * Mismo criterio que `codigosDeVeredicto` en el worker: el orden lo pone el
 * servidor y es lo unico que se lleva de la gravedad, para que `motivos.js`
 * pueda coger el primero que conozca sin recibir los pesos.
 */
function codigosDe(auditoria) {
  return [...(auditoria?.señales || [])]
    .sort((a, b) => (b?.gravedad || 0) - (a?.gravedad || 0))
    .map((s) => s?.codigo)
    .filter(Boolean);
}

async function migrar() {
  const resumen = { vistos: 0, migrados: 0, yaEstaban: 0, sinSeñales: 0 };

  let desde = null;

  for (;;) {
    let consulta = db.collection('tiempos_viaje')
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(POR_LOTE);
    if (desde) consulta = consulta.startAfter(desde);

    const pagina = await consulta.get();
    if (pagina.empty) break;

    desde = pagina.docs[pagina.docs.length - 1].id;
    resumen.vistos += pagina.size;

    const pendientes = pagina.docs.filter((d) => d.data().auditoria);
    resumen.yaEstaban += pagina.size - pendientes.length;

    if (!pendientes.length) continue;

    const lote = db.batch();

    for (const viaje of pendientes) {
      const auditoria = viaje.data().auditoria;
      const codigos = codigosDe(auditoria);
      if (!codigos.length) resumen.sinSeñales++;

      lote.set(db.doc(`auditorias/${viaje.id}`), {
        ...auditoria,
        viajeId: viaje.id,
        // De cuando se migro, no de cuando se analizo: la fecha del analisis es
        // `revisadoEn` y esa se queda en el viaje. Inventar aqui una fecha de
        // creacion haria parecer que todos los viajes se analizaron hoy.
        migrado: admin.firestore.FieldValue.serverTimestamp(),
      });

      lote.update(viaje.ref, {
        motivos: codigos,
        auditoria: admin.firestore.FieldValue.delete(),
      });

      resumen.migrados++;
    }

    if (!SIMULAR) await lote.commit();
    console.log(`  ${resumen.vistos} viajes vistos, ${resumen.migrados} para migrar...`);
  }

  return resumen;
}

/** Cuantos viajes siguen llevando la auditoria dentro. */
async function comprobar() {
  let sucios = 0;
  let desde = null;

  for (;;) {
    let consulta = db.collection('tiempos_viaje')
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(400);
    if (desde) consulta = consulta.startAfter(desde);

    const pagina = await consulta.get();
    if (pagina.empty) break;

    desde = pagina.docs[pagina.docs.length - 1].id;
    sucios += pagina.docs.filter((d) => d.data().auditoria).length;
  }

  return sucios;
}

async function main() {
  console.log(SIMULAR
    ? 'SIMULACION: no se escribe nada.\n'
    : 'APLICANDO los cambios.\n');

  const resumen = await migrar();

  console.log('\nResumen:');
  console.log(`  viajes revisados:       ${resumen.vistos}`);
  console.log(`  con auditoria dentro:   ${resumen.migrados}`);
  console.log(`  ya migrados:            ${resumen.yaEstaban}`);
  console.log(`  sin ninguna señal:      ${resumen.sinSeñales}`);

  if (SIMULAR) {
    console.log('\nNada se ha modificado. Vuelve a lanzarlo con --aplicar.');
    return;
  }

  const sucios = await comprobar();
  console.log(sucios === 0
    ? '\nNingun viaje lleva ya la auditoria dentro.'
    : `\nCUIDADO: quedan ${sucios} viajes con la auditoria dentro.`);
}

main().catch((error) => {
  console.error('Error en la migracion:', error);
  process.exit(1);
});
