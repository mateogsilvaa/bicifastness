'use strict';

/**
 * Que hacer con una denuncia (#61).
 *
 * POR QUE ESTA AQUI Y NO EN EL WORKER. La comprobacion de "no te denuncies a ti
 * mismo" la hacian las reglas de Firestore, que son declarativas y no se
 * estropean solas. Dejo de poder hacerla cuando el uid del denunciado salio del
 * documento —mandarlo obligaba a publicar los uid en las clasificaciones, justo
 * lo que no se hace desde la fuga de correos (#60)— y bajo a codigo normal, que
 * si se estropea.
 *
 * Una regla de seguridad que se muda de un sitio declarativo a uno imperativo
 * necesita una prueba que la sujete, y para eso tiene que poder probarse sin
 * montar medio Firestore. De ahi que esto sea una funcion pura: entra el estado,
 * sale la decision, y el worker se ocupa de leer y escribir.
 *
 * Es el mismo reparto que ya usan `rachas.js`, `misiones.js` y `divisiones.js`.
 */

/** Estados por los que pasa una denuncia. */
const ESTADOS = {
  /** Recien creada por el navegador. Todavia no se sabe a quien señala. */
  SIN_RESOLVER: 'sin_resolver',
  /** Comprobada: hay viaje, no es suyo y no esta repetida. A la cola. */
  PENDIENTE: 'pendiente',
  /** No llega a la cola de nadie. El motivo queda escrito. */
  DESCARTADA: 'descartado',
};

/**
 * Decide que hacer con una denuncia.
 *
 * @param {object} denuncia            `{ viajeId, reportanteUid }`
 * @param {object|null} viaje          el viaje denunciado, o null si no existe
 * @param {Array} previas              denuncias que esa MISMA persona ya hizo de
 *                                     ese MISMO viaje, sin contar esta
 * @returns {{encolar: boolean, motivo?: string, reportadoUid?: string, ruta?: string}}
 */
function decidir(denuncia, viaje, previas = []) {
  if (!viaje) return { encolar: false, motivo: 'el viaje ya no existe' };

  const dueño = viaje.uid;

  // Un viaje anonimizado (su dueño borro la cuenta) se queda sin uid. No hay a
  // quien señalar, y el viaje ya no es de nadie.
  if (!dueño) return { encolar: false, motivo: 'el viaje no tiene dueño' };

  // La comprobacion que hacian las reglas.
  if (dueño === denuncia.reportanteUid) {
    return { encolar: false, motivo: 'es tu propio viaje' };
  }

  // Una por persona y viaje. Las descartadas no cuentan: si la primera se tiro
  // porque el viaje aun no existia, la segunda merece que se mire.
  //
  // Ojo, es por PERSONA y viaje, no por viaje: que dos personas distintas
  // denuncien lo mismo no es un problema, es justo la señal que le interesa a
  // quien revisa.
  if (previas.some((p) => p.estado !== ESTADOS.DESCARTADA)) {
    return { encolar: false, motivo: 'ya habias denunciado este viaje' };
  }

  return { encolar: true, reportadoUid: dueño, ruta: viaje.ruta || null };
}

module.exports = { decidir, ESTADOS };
