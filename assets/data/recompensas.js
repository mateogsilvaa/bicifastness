/**
 * Banners y lemas del perfil publico: lo que se ve arriba de tu ficha cuando
 * alguien la abre desde el ranking.
 *
 * Dos clases, y la diferencia esta EN EL ID, no en un campo:
 *
 * - Los que empiezan por `libre-` los puede poner cualquiera desde el primer
 *   dia. Son los de partida.
 * - Los demas hay que ganarlos: los apunta el worker o la administracion en
 *   `usuarios/{uid}.recompensas` (el navegador no puede escribir ese campo).
 *   La idea es que salgan de pegatinas NFC en bicis concretas, de eventos y
 *   de hitos; mientras no exista el canje, se conceden desde /admin/.
 *
 * Las reglas de Firestore (`vitrinas/{nombre}`) comprueban exactamente eso: un
 * id `libre-*`, o uno que este en tu lista de recompensas. Por eso el prefijo
 * no se puede cambiar sin cambiar tambien las reglas.
 *
 * El aspecto de cada banner vive en el CSS (`.banner-{id}`), no aqui: un
 * fondo es diseño, y asi el catalogo no lleva estilos.
 *
 * `como` es lo que se enseña de una recompensa que aun no tienes: como se
 * consigue, sin destripar donde esta la pegatina.
 */

export const BANNERS = {
  'libre-asfalto': { titulo: 'Asfalto', como: 'De serie.' },
  'libre-amanecer': { titulo: 'Amanecer', como: 'De serie.' },
  'libre-retiro': { titulo: 'Retiro', como: 'De serie.' },
  'libre-carril': { titulo: 'Carril bici', como: 'De serie.' },
  'pegatina-azul': { titulo: 'Pegatina azul', como: 'Escanea el primero una pegatina BiciFastness escondida en una bici.' },
  'madrid-noche': { titulo: 'Madrid de noche', como: 'Escondido en una pegatina de alguna bici. Hay que encontrarla.' },
  'kilometro-cero': { titulo: 'Kilómetro cero', como: 'En la pegatina de una bici que pasa por Sol.' },
  'fundador': { titulo: 'Fundador', como: 'Para quien estuvo en la primera tanda.' },
};

export const LEMAS = {
  'libre-rodando': { texto: 'Rodando por Madrid', como: 'De serie.' },
  'libre-cada-dia': { texto: 'Un día más, una estación más', como: 'De serie.' },
  'libre-sin-prisa': { texto: 'Sin prisa, pero sin pausa', como: 'De serie.' },
  'libre-cuestas': { texto: 'Las cuestas también cuentan', como: 'De serie.' },
  'cazapegatinas': { texto: 'Cazador de pegatinas', como: 'Escanea el primero una pegatina BiciFastness.' },
  'llegue-primero': { texto: 'Llegué el primero', como: 'Escondido en una pegatina de alguna bici.' },
  'desde-el-principio': { texto: 'Estuve desde el principio', como: 'Para quien estuvo en la primera tanda.' },
};

/** El banner que lleva quien no ha elegido ninguno. */
export const BANNER_POR_DEFECTO = 'libre-asfalto';

export const esLibre = (id) => String(id || '').startsWith('libre-');

/** Si un piloto puede llevar esa recompensa: libre, o ganada. */
export function laTiene(id, recompensas = []) {
  return esLibre(id) || (Array.isArray(recompensas) && recompensas.includes(id));
}
