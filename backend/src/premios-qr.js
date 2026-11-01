'use strict';

/**
 * El sorteo de las pegatinas con QR (assets/js/premio-qr.js).
 *
 * Una peticion por cuenta (`premios_qr/{uid}`, que las reglas no dejan repetir
 * ni cambiar). Aqui se decide, en una transaccion con el contador global
 * `config/premios_qr`:
 *   - los 30 primeros se llevan el banner `estaciones`;
 *   - cada uno, un 2% de llevarse el lema `desde-el-origen`, hasta 30 en total.
 * Lo que ya tenga no se le vuelve a dar ni gasta cupo.
 */

const BANNER = 'estaciones';
const LEMA = 'desde-el-origen';
const CUPO_BANNERS = 30;
const CUPO_LEMAS = 30;
const PROB_LEMA = 0.02;

/** Pura: que le toca a uno, dado lo que queda y su tirada. */
function sortear({ banners, lemas, tiene = [], azar = Math.random() }) {
  const banner = banners < CUPO_BANNERS && !tiene.includes(BANNER);
  const lema = lemas < CUPO_LEMAS && !tiene.includes(LEMA) && azar < PROB_LEMA;
  return { banner, lema };
}

async function procesarPremiosQr({ db, admin, simular = false, avisar = null, azar = Math.random }) {
  if (simular) return { resueltos: 0 };
  const pendientes = await db.collection('premios_qr').where('estado', '==', 'pendiente').limit(50).get();
  let resueltos = 0;
  for (const d of pendientes.docs) {
    const uid = d.id;
    try {
      const r = await db.runTransaction(async (t) => {
        const refCont = db.doc('config/premios_qr');
        const refUsu = db.doc(`usuarios/${uid}`);
        const [cont, usu] = await Promise.all([t.get(refCont), t.get(refUsu)]);
        const c = cont.exists ? cont.data() : {};
        const u = usu.exists ? usu.data() : null;
        const premio = u && !u.suspendido
          ? sortear({ banners: c.banners || 0, lemas: c.lemas || 0, tiene: u.recompensas || [], azar: azar() })
          : { banner: false, lema: false };
        const nuevas = [premio.banner ? BANNER : null, premio.lema ? LEMA : null].filter(Boolean);
        if (nuevas.length) {
          t.update(refUsu, { recompensas: admin.firestore.FieldValue.arrayUnion(...nuevas) });
          t.set(refCont, {
            banners: admin.firestore.FieldValue.increment(premio.banner ? 1 : 0),
            lemas: admin.firestore.FieldValue.increment(premio.lema ? 1 : 0),
          }, { merge: true });
        }
        t.update(d.ref, { estado: 'resuelto', banner: premio.banner, lema: premio.lema, resuelto: admin.firestore.FieldValue.serverTimestamp() });
        return premio;
      });
      resueltos++;
      if ((r.banner || r.lema) && avisar) await avisar(uid).catch(() => { /* sin aviso, pero ya lo tiene */ });
    } catch (error) {
      console.warn(`  premio de pegatina de ${uid} no resuelto:`, error.message);
    }
  }
  if (pendientes.size) console.log(`Premios de pegatina: ${resueltos} sorteado(s).`);
  return { resueltos };
}

module.exports = { procesarPremiosQr, sortear, BANNER, LEMA, CUPO_BANNERS, CUPO_LEMAS, PROB_LEMA };
