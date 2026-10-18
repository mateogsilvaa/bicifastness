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
 * La silueta del escudo. `cuadro` es la de siempre y la que lleva quien no ha
 * elegido; las demas se recortan con `clip-path` (app.css, `.escudo-clan`).
 */
export const FORMAS = {
  cuadro: { nombre: 'Cuadrado' },
  circulo: { nombre: 'Círculo' },
  hexagono: { nombre: 'Hexágono' },
  blason: { nombre: 'Blasón' },
  octogono: { nombre: 'Octógono' },
};

/**
 * Como se reparten los dos colores. Sin patron (o sin segundo color) el escudo
 * es liso, como hasta ahora.
 */
export const PATRONES = {
  mitad: { nombre: 'Mitad' },
  diagonal: { nombre: 'Diagonal' },
  franja: { nombre: 'Franja' },
  rayas: { nombre: 'Rayas' },
  cuartos: { nombre: 'Cuartos' },
  aro: { nombre: 'Aro' },
};

/** 16 colores con buen contraste con el blanco del emblema. */
export const COLORES_CLAN = [
  '#FF5A1F', '#E23D8C', '#13A89E', '#8B5CF6', '#E0A800', '#3D8B37', '#8A5A3C', '#5B6470',
  '#D7263D', '#1B80E5', '#0B7A75', '#6D28D9', '#C2410C', '#4D7C0F', '#BE185D', '#111110',
];

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * El fondo del escudo como valor de `background` de CSS. Los colores llegan de
 * la base de datos: lo que no sea un hex de verdad no entra.
 */
export function fondoEscudo({ color, color2, patron } = {}, porDefecto = 'var(--tinta-3)') {
  const a = HEX.test(String(color || '')) ? color : porDefecto;
  const b = HEX.test(String(color2 || '')) ? color2 : null;
  if (!b || !PATRONES[patron] || b === a) return a;
  switch (patron) {
    case 'mitad': return `linear-gradient(90deg, ${a} 50%, ${b} 50%)`;
    case 'diagonal': return `linear-gradient(135deg, ${a} 50%, ${b} 50%)`;
    case 'franja': return `linear-gradient(180deg, ${a} 36%, ${b} 36% 64%, ${a} 64%)`;
    case 'rayas': return `repeating-linear-gradient(90deg, ${a} 0 16.66%, ${b} 16.66% 33.33%)`;
    case 'cuartos': return `conic-gradient(${a} 0 25%, ${b} 0 50%, ${a} 0 75%, ${b} 0)`;
    case 'aro': return `radial-gradient(circle, ${a} 56%, ${b} calc(56% + 1px))`;
    default: return a;
  }
}
