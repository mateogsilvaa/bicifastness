#!/usr/bin/env node
/**
 * Saca a un fichero local las muestras de `dataset_cifras` para entrenar el
 * lector de cifras (scripts/entrenar-cifras.py). Solo imprime cuantas.
 *
 * Uso: node scripts/exportar-cifras.js salida.json
 */

const fs = require('fs');
const admin = require('./lib/firebase-admin');

async function main() {
  const credenciales = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!credenciales) throw new Error('Falta FIREBASE_SERVICE_ACCOUNT.');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(credenciales)) });
  const snap = await admin.firestore().collection('dataset_cifras').get();
  const muestras = snap.docs.flatMap((d) => d.data().muestras || [])
    .filter((m) => m && typeof m.png === 'string' && typeof m.etiqueta === 'string');
  fs.writeFileSync(process.argv[2], JSON.stringify(muestras));
  console.log(`${snap.size} viajes, ${muestras.length} muestras exportadas.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
