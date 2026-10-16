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
 * El dibujo de cada banner es un SVG de 1200 x 400 en
 * `assets/img/banners/{id}.svg`. Se ve recortado segun la pantalla (de 2,3:1
 * a 6:1), asi que lo importante va en la franja central.
 *
 * `como` es lo que se enseña de una recompensa que aun no tienes: como se
 * consigue, sin destripar donde esta la pegatina.
 */

const COMO_SE_GANA = 'Se gana: pegatinas en bicis, eventos e hitos.';

export const BANNERS = {
  // De serie: los tres que tiene todo el mundo.
  'libre-calzada': { titulo: 'Calzada', como: 'De serie.' },
  'libre-tinta': { titulo: 'Tinta', como: 'De serie.' },
  'libre-la-vuelta': { titulo: 'La vuelta', como: 'De serie.' },
  // Los que se ganan.
  'ecos': { titulo: 'Ecos', como: COMO_SE_GANA },
  'carril-bici': { titulo: 'Carril bici', como: COMO_SE_GANA },
  'metro': { titulo: 'Metro', como: COMO_SE_GANA },
  'atardecer': { titulo: 'Atardecer', como: COMO_SE_GANA },
  'estaciones': { titulo: 'Estaciones', como: COMO_SE_GANA },
  'regla': { titulo: 'Regla', como: COMO_SE_GANA },
  'velocidad': { titulo: 'Velocidad', como: COMO_SE_GANA },
  'neon': { titulo: 'Neón', como: COMO_SE_GANA },
  'radios': { titulo: 'Radios', como: COMO_SE_GANA },
  'pixeles': { titulo: 'Píxeles', como: COMO_SE_GANA },
  'ojos': { titulo: 'Ojos', como: COMO_SE_GANA },
  'paso-de-cebra': { titulo: 'Paso de cebra', como: COMO_SE_GANA },
  'cuestas': { titulo: 'Cuestas', como: COMO_SE_GANA },
  'ligas': { titulo: 'Ligas', como: COMO_SE_GANA },
  'confeti': { titulo: 'Confeti', como: COMO_SE_GANA },
  'meta': { titulo: 'Meta', como: COMO_SE_GANA },
  'noche': { titulo: 'Noche', como: COMO_SE_GANA },
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
export const BANNER_POR_DEFECTO = 'libre-calzada';

/** El dibujo de cada banner: un SVG de 1200 x 400 con el mismo nombre que su id. */
export const imagenBanner = (id) => `/assets/img/banners/${BANNERS[id] ? id : BANNER_POR_DEFECTO}.svg`;

export const esLibre = (id) => String(id || '').startsWith('libre-');

/** Si un piloto puede llevar esa recompensa: libre, o ganada. */
export function laTiene(id, recompensas = []) {
  return esLibre(id) || (Array.isArray(recompensas) && recompensas.includes(id));
}
