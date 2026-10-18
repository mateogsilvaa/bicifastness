/**
 * Emblemas, formas, patrones y colores de los clanes, sin nada mas: ni DOM ni
 * imports.
 *
 * Viven aparte de escudo-clan.js para que los pueda cargar tambien el worker
 * (la tienda pinta el escudo del clan en la camiseta) con el mismo trazo que
 * la web.
 */

/** Las reglas admiten exactamente estas claves (firestore.rules, `clanes`). */
export const EMBLEMAS = {
  rayo: { nombre: 'Rayo', d: 'M13 2 4 14h7l-1 8 9-12h-7z' },
  llama: { nombre: 'Llama', d: 'M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-6 0 2 1 3 2 3 0-4 1-6 1-9z' },
  corona: { nombre: 'Corona', d: 'M3 18h18M4 8l4 4 4-7 4 7 4-4-2 10H6z' },
  estrella: { nombre: 'Estrella', d: 'm12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z' },
  montana: { nombre: 'Montaña', d: 'm2 20 7-12 4 6 3-4 6 10z' },
  rueda: { nombre: 'Rueda', d: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 6v6m-3-3h6M12 12l4-4m-4 4-4 4' },
  ola: { nombre: 'Ola', d: 'M2 15c3 0 3-3 6-3s3 3 6 3 3-3 6-3M2 20c3 0 3-3 6-3s3 3 6 3 3-3 6-3M10 9c0-3 3-5 6-5' },
  diana: { nombre: 'Diana', d: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 4a1 1 0 1 0 0 2 1 1 0 0 0 0-2z' },
  flecha: { nombre: 'Flecha', d: 'M4 20 20 4m0 0h-8m8 0v8' },
  escudo: { nombre: 'Escudo', d: 'M12 3 4 6v6c0 5 4 8 8 9 4-1 8-4 8-9V6z' },
  calavera: { nombre: 'Calavera', d: 'M12 3a8 8 0 0 0-8 8c0 3 2 5 3 6v3h10v-3c1-1 3-3 3-6a8 8 0 0 0-8-8zM9 11h.01M15 11h.01M10 20v-2m4 2v-2' },
  oso: { nombre: 'Oso', d: 'M7 4a3 3 0 1 0 0 6M17 4a3 3 0 1 1 0 6M12 7a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm-2 7h.01M14 14h.01M11 17h2' },
  bici: { nombre: 'Bici', d: 'M2 17a3.5 3.5 0 1 0 7 0 3.5 3.5 0 1 0-7 0zm13 0a3.5 3.5 0 1 0 7 0 3.5 3.5 0 1 0-7 0zM5.5 17 9 9.5h7l2.5 7.5M9 9.5l3.5 7.5L16 9.5M7.5 6.5h3' },
  pinon: { nombre: 'Piñón', d: 'M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm0 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9 7 7m10 10 2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1' },
  casco: { nombre: 'Casco', d: 'M3 16a9 9 0 0 1 18 0zM9.5 7.4 11 16M14.5 7.4 13 16M6 19h12' },
  crono: { nombre: 'Crono', d: 'M12 7a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm0 3v4l2.5 2M10 2h4M12 2v3M18.5 6.5 20 5' },
  timbre: { nombre: 'Timbre', d: 'M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 21h4M12 3v2' },
  pin: { nombre: 'Pin', d: 'M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12zm0-15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z' },
  sol: { nombre: 'Sol', d: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4' },
  luna: { nombre: 'Luna', d: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z' },
  corazon: { nombre: 'Corazón', d: 'M12 20s-8-4.9-8-10.5A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 8 2.5C20 15.1 12 20 12 20z' },
  hoja: { nombre: 'Hoja', d: 'M5 19C5 10 10 5 20 4c0 10-5 15-14 15zm0 0 8-8' },
  trofeo: { nombre: 'Trofeo', d: 'M7 4h10v5a5 5 0 0 1-10 0zM7 6H4a3 3 0 0 0 3 4m10-4h3a3 3 0 0 1-3 4m-5 4v4m-4 3h8m-7-3h6' },
  semaforo: { nombre: 'Semáforo', d: 'M8 2h8v20H8zM12 6h.01M12 12h.01M12 18h.01' },
};

/**
 * La silueta del escudo, en un lienzo de 100 x 100 (16 Clanes, EscudoClan).
 * `cuadro` es la de quien no ha elegido.
 */
export const FORMAS = {
  cuadro: { nombre: 'Cuadro', d: 'M24 4 H76 A20 20 0 0 1 96 24 V76 A20 20 0 0 1 76 96 H24 A20 20 0 0 1 4 76 V24 A20 20 0 0 1 24 4 Z' },
  circulo: { nombre: 'Círculo', d: 'M50 3 A47 47 0 1 1 49.99 3 Z' },
  hexagono: { nombre: 'Hexágono', d: 'M50 3 L91 26.5 V73.5 L50 97 L9 73.5 V26.5 Z' },
  blason: { nombre: 'Blasón', d: 'M10 6 H90 Q94 6 94 10 V46 C94 72 74 88 50 97 C26 88 6 72 6 46 V10 Q6 6 10 6 Z' },
  octogono: { nombre: 'Octógono', d: 'M31 4 H69 L96 31 V69 L69 96 H31 L4 69 V31 Z' },
};

/**
 * Como se reparten los dos colores: lo que se pinta con el segundo. El aro no
 * es un relleno: es el borde de la silueta (ver `piezasEscudo`).
 */
export const PATRONES = {
  mitad: { nombre: 'Mitad', d: 'M50 0 H100 V100 H50 Z' },
  diagonal: { nombre: 'Diagonal', d: 'M100 0 V100 H0 Z' },
  franja: { nombre: 'Franja', d: 'M0 37 H100 V63 H0 Z' },
  rayas: { nombre: 'Rayas', d: 'M14 0 H28 V100 H14 Z M43 0 H57 V100 H43 Z M72 0 H86 V100 H72 Z' },
  cuartos: { nombre: 'Cuartos', d: 'M50 0 H100 V50 H50 Z M0 50 H50 V100 H0 Z' },
  aro: { nombre: 'Aro', d: '' },
};

/** 16 colores con buen contraste con el blanco del emblema. */
export const COLORES_CLAN = [
  '#FF5A1F', '#E23D8C', '#13A89E', '#8B5CF6', '#E0A800', '#3D8B37', '#8A5A3C', '#5B6470',
  '#D7263D', '#1B80E5', '#0B7A75', '#6D28D9', '#C2410C', '#4D7C0F', '#BE185D', '#111110',
];

/** Los 8 que se ofrecen al elegir (16c), con nombre para los avisos. */
export const COLORES_PRINCIPALES = {
  '#FF5A1F': 'naranja', '#E23D8C': 'rosa', '#13A89E': 'turquesa', '#8B5CF6': 'morado',
  '#E0A800': 'mostaza', '#3D8B37': 'verde', '#8A5A3C': 'marrón', '#5B6470': 'gris',
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const SIGLAS = /^[A-Z0-9ÑÁÉÍÓÚ]{1,3}$/;

const luminancia = (h) => {
  const n = parseInt(h.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};

/**
 * Lo que hace falta para pintar un escudo, sin DOM: silueta, colores, patron,
 * tinta y que va dentro. Los datos llegan de la base de datos, asi que todo se
 * valida: lo que no sea un hex o una clave conocida no entra.
 *
 * @param {object} clan  color, color2, patron, forma, emblema, siglas
 * @param {string} [iniciales]  si no hay siglas validas
 */
export function piezasEscudo(clan = {}, iniciales = '') {
  const forma = FORMAS[clan.forma] ? clan.forma : 'cuadro';
  const c1 = HEX.test(String(clan.color || '')) ? clan.color : '#8A8F98';
  const c2 = HEX.test(String(clan.color2 || '')) ? clan.color2 : null;
  const patron = c2 && PATRONES[clan.patron] ? clan.patron : null;
  const claro = luminancia(c1) > 0.62;
  const emblema = EMBLEMAS[clan.emblema] ? clan.emblema : null;
  const siglas = emblema ? '' : (typeof clan.siglas === 'string' && SIGLAS.test(clan.siglas) ? clan.siglas : String(iniciales || '').toUpperCase().slice(0, 3));
  const sube = forma === 'blason' ? -3 : 0;
  return {
    silueta: FORMAS[forma].d,
    c1,
    c2: patron ? c2 : null,
    patron: patron && patron !== 'aro' ? PATRONES[patron].d : '',
    aro: patron === 'aro',
    tinta: claro ? '#111110' : '#FFFFFF',
    halo: claro ? 'rgba(255,255,255,.35)' : 'rgba(0,0,0,.22)',
    emblema: emblema ? EMBLEMAS[emblema].d : null,
    transformEmblema: `translate(${50 - 12 * 2.2} ${50 - 12 * 2.2 + sube}) scale(2.2)`,
    siglas,
    tamSiglas: siglas.length > 2 ? 34 : 42,
    ySiglas: (siglas.length > 2 ? 62 : 65) + sube,
  };
}
