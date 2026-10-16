'use strict';

/**
 * Canjes de recompensas por enlace de evento.
 *
 * LA REGLA DE SIEMPRE: el navegador PIDE, el worker DECIDE. Quien abre un
 * enlace de evento (/canjear/?c=CODIGO) deja en `canjes_recompensa/{su uid}` un
 * `{ codigo, estado: 'pendiente' }`. Aqui se comprueba, con credenciales de
 * servicio, que ese codigo existe y no se ha usado, y entonces —y solo
 * entonces— se apunta la recompensa en `usuarios/{uid}.recompensas`, que el
 * navegador no puede escribir. Un banner que el navegador pueda darse no es un
 * premio, es un campo de texto.
 *
 * Los codigos viven en `recompensas_codigos/{codigo}`, que solo la
 * administracion lee y crea. Son largos y al azar (>90 bits): quien tiene el
 * enlace lo canjea, pero nadie puede listarlos ni adivinarlos. Y como cada
 * piloto solo puede tener UNA peticion pendiente a la vez (su doc es su uid),
 * probar codigos al azar sale a uno por pasada del worker.
 *
 * Resultado de cada peticion, en el mismo documento:
 *   ok            canjeado: ya la tiene
 *   ya-lo-tenias  la tenia: el codigo NO se gasta, vale para otra persona
 *   usado         lo canjeo otra persona
 *   invalido      el codigo no existe, o la cuenta no puede canjear
 */

const ID_RECOMPENSA = /^[a-z0-9-]{1,40}$/;
const CODIGO = /^[A-Za-z0-9]{16,40}$/;

/** Cuantas peticiones se atienden por pasada. De sobra: son pocas, y una a una. */
const POR_PASADA = 50;

/**
 * Decide UNA peticion, dentro de una transaccion: dos personas con el mismo
 * enlace a la vez no pueden llevarse las dos el premio.
 *
 * @returns {Promise<{estado: string, recompensa?: string}>}
 */
async function decidir({ db, admin, uid, codigo }) {
  if (!CODIGO.test(String(codigo))) return { estado: 'invalido' };

  const refCodigo = db.doc(`recompensas_codigos/${codigo}`);
  const refUsuario = db.doc(`usuarios/${uid}`);

  return db.runTransaction(async (t) => {
    const [cod, usuario] = await Promise.all([t.get(refCodigo), t.get(refUsuario)]);
    if (!usuario.exists || usuario.data().suspendido) return { estado: 'invalido' };
    if (!cod.exists) return { estado: 'invalido' };

    const c = cod.data();
    if (!ID_RECOMPENSA.test(String(c.recompensa))) return { estado: 'invalido' };
    if (c.usadoPor) return { estado: 'usado' };

    const suyas = Array.isArray(usuario.data().recompensas) ? usuario.data().recompensas : [];
    // La tiene: el enlace queda libre para otra persona en vez de gastarse.
    if (suyas.includes(c.recompensa)) return { estado: 'ya-lo-tenias', recompensa: c.recompensa };

    t.update(refCodigo, {
      usadoPor: uid,
      usadoPorNombre: String(usuario.data().username || '').slice(0, 24),
      usadoEn: admin.firestore.FieldValue.serverTimestamp(),
    });
    t.update(refUsuario, { recompensas: admin.firestore.FieldValue.arrayUnion(c.recompensa) });
    return { estado: 'ok', recompensa: c.recompensa };
  });
}

/**
 * Atiende las peticiones pendientes.
 *
 * Coste: UNA consulta por pasada (casi siempre vacia). Por cada peticion, dos
 * lecturas y dos escrituras mas la del resultado.
 *
 * @param {object} o
 * @param {Function} [o.avisar]  `(uid, recompensa) => Promise`, el push de "ya la tienes"
 */
async function procesarCanjes({ db, admin, simular = false, avisar = null }) {
  // En simulacion no se toca nada: ni se canjea ni se deja un resultado.
  if (simular) return { ok: 0, usado: 0, invalido: 0, 'ya-lo-tenias': 0 };

  const pendientes = await db.collection('canjes_recompensa')
    .where('estado', '==', 'pendiente')
    .limit(POR_PASADA)
    .get();

  const resumen = { ok: 0, usado: 0, invalido: 0, 'ya-lo-tenias': 0 };
  for (const doc of pendientes.docs) {
    const uid = doc.id;
    try {
      const resultado = await decidir({ db, admin, uid, codigo: doc.data().codigo });
      await doc.ref.update({
        estado: resultado.estado,
        recompensa: resultado.recompensa || null,
        resuelto: admin.firestore.FieldValue.serverTimestamp(),
      });
      resumen[resultado.estado]++;
      // El aviso es un extra: si falla, el canje ya esta hecho y vale igual.
      if (resultado.estado === 'ok' && avisar) await avisar(uid, resultado.recompensa).catch(() => { /* sin aviso, pero canjeado */ });
    } catch (error) {
      // Se queda pendiente y se reintenta en la pasada siguiente.
      console.warn(`  canje de ${uid} no resuelto:`, error.message);
    }
  }

  if (pendientes.size) console.log(`Canjes: ${JSON.stringify(resumen)}`);
  return resumen;
}

module.exports = { procesarCanjes, decidir, CODIGO, ID_RECOMPENSA };
