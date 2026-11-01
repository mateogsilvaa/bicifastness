#!/usr/bin/env node
/**
 * Por que van los viajes a revision: solo RECUENTOS, sin un solo dato de nadie
 * (el log de Actions es publico).
 *
 * Lee las auditorias (el veredicto completo del worker) de los viajes desde
 * una fecha y cuenta: decisiones, riesgo, que señales salen y cuanto pesan, y
 * que decidio despues la administracion en los que fueron a revision. Es lo
 * que hace falta para mover un umbral con datos y no a ojo.
 *
 * Uso: node scripts/analizar-revisiones.js [desde=2026-11-01]
 */

const admin = require('./lib/firebase-admin');

async function main() {
  const desde = process.argv[2] || '2026-11-01';
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();

  const viajes = await db.collection('tiempos_viaje').where('fechaViaje', '>=', desde).get();
  const auditorias = new Map();
  const ids = viajes.docs.map((d) => d.id);
  for (let i = 0; i < ids.length; i += 300) {
    const refs = ids.slice(i, i + 300).map((id) => db.doc(`auditorias/${id}`));
    if (refs.length) for (const a of await db.getAll(...refs)) if (a.exists) auditorias.set(a.id, a.data());
  }

  const decisiones = {};
  const estados = {};
  const señales = {};
  const enRevision = {};
  const soloEnRevision = {};
  const riesgos = { '0-9': 0, '10-19': 0, '20-29': 0, '30-39': 0, '40-49': 0, '50-69': 0, '70+': 0 };
  const tramo = (r) => (r < 10 ? '0-9' : r < 20 ? '10-19' : r < 30 ? '20-29' : r < 40 ? '30-39' : r < 50 ? '40-49' : r < 70 ? '50-69' : '70+');
  const manual = {};
  const variantes = {};

  for (const v of viajes.docs) {
    const viaje = v.data();
    estados[viaje.estado] = (estados[viaje.estado] || 0) + 1;
    const a = auditorias.get(v.id);
    if (!a) continue;
    decisiones[a.decision] = (decisiones[a.decision] || 0) + 1;
    riesgos[tramo(a.riesgo || 0)]++;
    variantes[a.varianteCaptura || '?'] = (variantes[a.varianteCaptura || '?'] || 0) + 1;
    const codigos = (a.señales || []).map((s) => s.codigo);
    for (const s of a.señales || []) {
      const e = (señales[s.codigo] ||= { veces: 0, gravedad: 0 });
      e.veces++; e.gravedad += s.gravedad || 0;
      if (a.decision === 'revision') enRevision[s.codigo] = (enRevision[s.codigo] || 0) + 1;
    }
    if (a.decision === 'revision') {
      const clave = codigos.slice().sort().join('+') || '(ninguna)';
      soloEnRevision[clave] = (soloEnRevision[clave] || 0) + 1;
      if (viaje.revisadoPor && viaje.revisadoPor !== 'automatico') {
        manual[viaje.estado] = (manual[viaje.estado] || 0) + 1;
      }
    }
  }

  const media = Object.fromEntries(Object.entries(señales)
    .sort((x, y) => y[1].veces - x[1].veces)
    .map(([c, e]) => [c, `${e.veces} veces, gravedad media ${(e.gravedad / e.veces).toFixed(1)}`]));
  const ordenar = (o) => Object.fromEntries(Object.entries(o).sort((x, y) => y[1] - x[1]));

  console.log(`Viajes desde ${desde}: ${viajes.size} (con auditoria: ${auditorias.size})`);
  console.log('Estado actual:', JSON.stringify(estados));
  console.log('Decision automatica:', JSON.stringify(decisiones));
  console.log('Riesgo:', JSON.stringify(riesgos));
  console.log('Variante de captura:', JSON.stringify(ordenar(variantes)));
  console.log('Señales (todas):', JSON.stringify(media, null, 1));
  console.log('Señales en los que fueron a revision:', JSON.stringify(ordenar(enRevision), null, 1));
  console.log('Combinaciones que mandan a revision:', JSON.stringify(ordenar(soloEnRevision), null, 1));
  console.log('Lo que decidio despues la administracion:', JSON.stringify(manual));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
