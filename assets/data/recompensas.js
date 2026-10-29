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
 *
 * `colaboracion` (opcional) es para los banners hechos con un artista o una
 * empresa: `{ nombre: 'Quien sea', logo: 'quien-sea.svg' }`, con el logo en
 * `assets/img/colaboraciones/`. Debajo del banner sale "bicifastness x" y el
 * logo; sin ese campo, no sale nada.
 */

import { INSIGNIAS } from './insignias.js';

const COMO_SE_GANA = 'Es difícil: sale de pegatinas escondidas en bicis, de eventos y de retos.';

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

/**
 * Los lemas. Salvo el de serie, hay que ganarlos, y se quiere que cuesten: lo
 * que lleva alguien en su ficha tiene que decir algo de esa persona.
 *
 * Todos se pintan igual (`.lema` en app.css): un reflejo metalico que cruza
 * el texto. Lo que los distingue es el texto, no el efecto.
 */
export const LEMAS = {
  // El de serie: lo tiene todo el mundo.
  'libre-cuestas': { texto: 'Las cuestas también cuentan', como: 'De serie.' },
  // Los que se ganan.
  'mas-rapido-que-el-bus': { texto: 'Más rápido que el autobús', como: COMO_SE_GANA },
  'madrid-es-mi-circuito': { texto: 'Madrid es mi circuito', como: COMO_SE_GANA },
  'mi-clan-mi-territorio': { texto: 'Mi clan, mi territorio', como: COMO_SE_GANA },
  'culpa-de-la-bateria': { texto: 'Culpa de la batería', como: COMO_SE_GANA },
  'hoy-no-llego-tarde': { texto: 'Hoy no llego tarde (mentira)', como: COMO_SE_GANA },
  'estuve-aqui': { texto: 'Yo estuve aquí desde el principio', como: 'Para quien tenía cuenta antes del reinicio.' },
  'desde-el-origen': { texto: 'Desde el origen', como: 'Para quien estuvo desde el primer día.' },
  'acab': { texto: 'ACAB (All Cars Are Bastards)', como: COMO_SE_GANA },
  'biciloverrr': { texto: 'Biciloverrr', como: COMO_SE_GANA },
  'fundador': { texto: 'Fundador', como: 'Para quien estuvo en la primera tanda.' },
  'im-a-winner': { texto: "I'm a winner bitch", como: COMO_SE_GANA },
};

/** El banner que lleva quien no ha elegido ninguno. */
export const BANNER_POR_DEFECTO = 'libre-calzada';

/** El dibujo de cada banner: un SVG de 1200 x 400 con el mismo nombre que su id. */
export const imagenBanner = (id) => `/assets/img/banners/${BANNERS[id] ? id : BANNER_POR_DEFECTO}.svg`;

/** El logo de una colaboracion, o null si el banner no es de ninguna. */
export function colaboracionDe(id) {
  const c = BANNERS[id]?.colaboracion;
  if (!c?.nombre || !/^[a-z0-9-]+\.(svg|png|webp)$/.test(String(c.logo || ''))) return null;
  return { nombre: c.nombre, logo: `/assets/img/colaboraciones/${c.logo}` };
}

export const esLibre = (id) => String(id || '').startsWith('libre-');

/**
 * Los tres modos de conseguir una recompensa (los decide la administracion en
 * /admin/recompensas/ y viven en `config/recompensas`):
 * - manual: solo si te la da la administracion.
 * - evento: con un enlace de un solo uso que se reparte en un evento.
 * - logro: se tiene en cuanto se tiene cierta insignia.
 */
export const TIPOS_RECOMPENSA = { manual: 'A mano', evento: 'Evento', logro: 'Logro' };

/** El modo de una recompensa segun la config (que puede no existir o venir rara). */
export function tipoDe(id, config) {
  const t = config?.items?.[id]?.tipo;
  return TIPOS_RECOMPENSA[t] ? t : 'manual';
}

/**
 * Si un piloto puede llevar esa recompensa: de serie, ganada (`recompensas`,
 * que solo escriben la administracion y el worker) o de logro, o sea que tiene
 * la insignia a la que la administracion la ha atado.
 *
 * Es lo mismo que comprueban las reglas de Firestore al guardar la vitrina.
 */
export function laTiene(id, { recompensas = [], logros = [] } = {}, config = null) {
  if (esLibre(id)) return true;
  if (Array.isArray(recompensas) && recompensas.includes(id)) return true;
  const logro = tipoDe(id, config) === 'logro' ? config.items[id].logro : null;
  return Boolean(logro) && Array.isArray(logros) && logros.includes(logro);
}

/**
 * Lo que se le dice a quien ve esa recompensa bloqueada: segun como se
 * consiga, y sin destripar nada que deba seguir escondido.
 */
export function comoSeGana(id, como, config) {
  const tipo = tipoDe(id, config);
  if (tipo === 'evento') return 'Se reparte en eventos: hace falta un enlace especial.';
  if (tipo === 'logro') {
    const insignia = INSIGNIAS[config.items[id].logro];
    if (insignia) return `Se consigue con la insignia «${insignia.titulo}».`;
  }
  return como;
}
