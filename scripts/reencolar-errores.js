#!/usr/bin/env node
/**
 * Devuelve a la cola los viajes que el worker mando a revision porque SE
 * ROMPIO el (motivo `error_worker`), no porque el viaje tuviera nada raro.
 *
 * Se lanza desde Actions > Administracion > reencolar-errores, despues de
 * desplegar el arreglo del fallo. Solo cuenta: no imprime nada de nadie.
 *
 * Uso: node scripts/reencolar-errores.js [--simular]
 */

const admin = require('./lib/firebase-admin');

async function main() {
  const simular = process.argv.includes('--simular');
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();

  // Solo por estado (sin indice compuesto): la cola de revision es corta y
  // el motivo se filtra aqui.
  const enRevision = await db.collection('tiempos_viaje').where('estado', '==', 'revision').get();
  const atascados = { docs: enRevision.docs.filter((d) => (d.data().motivos || []).includes('error_worker')) };
  atascados.size = atascados.docs.length;

  // Los que ya ha tocado una persona se respetan: solo vuelven los que
  // siguen esperando sin que nadie los haya mirado.
  const vuelven = atascados.docs.filter((d) => !d.data().revisadoPor);
  console.log(`En revision por un fallo del worker: ${atascados.size}. Vuelven a la cola: ${vuelven.length}.`);
  if (simular) return;

  for (let i = 0; i < vuelven.length; i += 400) {
    const lote = db.batch();
    for (const d of vuelven.slice(i, i + 400)) {
      lote.update(d.ref, {
        estado: 'pendiente',
        motivos: admin.firestore.FieldValue.delete(),
        avisoRevision: admin.firestore.FieldValue.delete(),
        reencolado: admin.firestore.FieldValue.increment(1),
      });
    }
    await lote.commit();
  }
  console.log('Hecho. La siguiente pasada del worker los procesa.');
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
