#!/usr/bin/env node
/**
 * Saca el banco de casos revisados a mano (`banco_revision` + `banco_capturas`)
 * a una carpeta LOCAL, para afinar el verificador con casos reales: cada caso
 * es su captura y un JSON con lo declarado, lo que vio la maquina y lo que
 * decidio la persona. Imprime ademas en que señales discrepan maquina y persona.
 *
 * Las capturas son de personas reales: la carpeta no se sube al repositorio
 * (esta en .gitignore).
 *
 * Uso: GOOGLE_APPLICATION_CREDENTIALS=... node scripts/exportar-banco-revision.js [carpeta=banco-revision]
 */

const fs = require('fs');
const path = require('path');
const admin = require('./lib/firebase-admin');

async function main() {
  const carpeta = path.resolve(process.argv[2] || 'banco-revision');
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  fs.mkdirSync(carpeta, { recursive: true });

  const casos = await db.collection('banco_revision').get();
  const porSeñal = {};
  for (const c of casos.docs) {
    const d = c.data();
    fs.writeFileSync(path.join(carpeta, `${c.id}.json`), JSON.stringify(d, null, 2));
    if (d.conCaptura) {
      const img = await db.doc(`banco_capturas/${c.id}`).get();
      const m = /^data:image\/(jpeg|png|webp);base64,(.*)$/.exec(img.exists ? img.data().datos : '');
      if (m) fs.writeFileSync(path.join(carpeta, `${c.id}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`), Buffer.from(m[2], 'base64'));
    }
    for (const s of d.automatica?.señales || []) {
      const e = (porSeñal[s.codigo] ||= { aprobados: 0, rechazados: 0 });
      if (d.humana?.decision === 'aprobado') e.aprobados++; else e.rechazados++;
    }
  }
  console.log(`${casos.size} casos en ${carpeta}`);
  console.log('Por señal, lo que decidio la persona (muchos aprobados = señal demasiado estricta):');
  console.table(porSeñal);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
