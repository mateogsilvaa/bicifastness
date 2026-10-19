#!/usr/bin/env node
/**
 * Borra TODOS los viajes y TODOS los clanes. Las cuentas se quedan.
 *
 * A diferencia del lanzamiento (backend/src/lanzamiento.js), que deja los
 * viajes como "primera tanda", esto los BORRA, con todo lo que cuelga de ellos:
 *   - tiempos_viaje y sus capturas, huellas, auditorias y denuncias
 *   - clanes, sus invitaciones y sus usos
 *   - el territorio (estaciones_stats) y los agregados (rankings, mapa,
 *     clanes...), que el worker rehace en la siguiente pasada
 *   - la cache de pilotos de los agregados (config/pilotos_*)
 * Y a cada piloto le pone a cero lo que salia de esos viajes (puntos,
 * kilometros, racha, insignias, division, clan): un piloto con 870 puntos y
 * ningun viaje es un dato roto. Nombre, foto, vitrina, banners ganados,
 * ajustes y avisos NO se tocan.
 *
 * NO SE PUEDE DESHACER. Por eso simula por defecto y solo borra con
 * `--de-verdad`. Se lanza desde Actions > Administracion; solo imprime
 * recuentos (el log es publico).
 *
 * Uso: node scripts/borrar-viajes-y-clanes.js [--de-verdad]
 */

const admin = require('./lib/firebase-admin');

/** Lo que se borra entero. */
const COLECCIONES = [
  'tiempos_viaje', 'capturas', 'huellas_captura', 'auditorias', 'reportes',
  'clanes', 'invitaciones', 'usos_invitacion',
  'estaciones_stats', 'agregados', 'cupos',
];

/** Lo que vuelve a cero en cada piloto (lo mismo que el lanzamiento, mas el clan). */
function contadoresACero() {
  const borrar = admin.firestore.FieldValue.delete();
  return {
    biciRating: 0, viajesVerificados: 0, viajesSinPuntos: 0, puntosPorRuta: {},
    metrosTotales: 0, segundosTotales: 0, puntosTemporada: 0, puntosLiga: 0,
    racha: 0, mejorRacha: 0, escudos: 0, ultimoDiaActivo: null,
    misiones: borrar, misionesCompletadas: 0, logros: [],
    division: borrar, divisionMaxima: borrar, grupo: borrar, grupoDesde: borrar, grupoLiga: borrar,
    clanId: null, rolClan: borrar,
  };
}

async function enLotes(db, refs, operacion) {
  for (let i = 0; i < refs.length; i += 400) {
    const lote = db.batch();
    for (const ref of refs.slice(i, i + 400)) operacion(lote, ref);
    await lote.commit();
  }
}

async function main() {
  const deVerdad = process.argv.includes('--de-verdad');
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();

  const recuento = {};
  const refs = {};
  for (const c of COLECCIONES) {
    // `select()` sin campos: solo las referencias, sin bajarse el contenido.
    const snap = await db.collection(c).select().get();
    refs[c] = snap.docs.map((d) => d.ref);
    recuento[c] = snap.size;
  }
  const cache = await db.collection('config').where(admin.firestore.FieldPath.documentId(), '>=', 'pilotos_')
    .where(admin.firestore.FieldPath.documentId(), '<', 'pilotos`').select().get();
  const usuarios = await db.collection('usuarios').select().get();
  recuento.cachePilotos = cache.size;
  recuento.usuariosAPonerACero = usuarios.size;

  console.log(`${deVerdad ? 'BORRANDO' : 'SIMULACION (no se toca nada)'}: ${JSON.stringify(recuento)}`);
  if (!deVerdad) {
    console.log('Para borrar de verdad: operacion "borrar-viajes-y-clanes" con confirmar = BORRAR.');
    return;
  }

  for (const c of COLECCIONES) await enLotes(db, refs[c], (lote, ref) => lote.delete(ref));
  await enLotes(db, cache.docs.map((d) => d.ref), (lote, ref) => lote.delete(ref));
  const cero = contadoresACero();
  await enLotes(db, usuarios.docs.map((d) => d.ref), (lote, ref) => lote.update(ref, cero));
  // Que el worker rehaga los agregados en la siguiente pasada, aunque no haya viajes.
  await db.doc('config/pilotos_meta').set({ invalida: true, paginas: 0, total: 0 }, { merge: true });
  console.log('Hecho. El worker rehara los rankings y el mapa (vacios) en su proxima pasada.');
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
