/**
 * El lector de la maqueta (`npm run maqueta`).
 *
 * Es el de verdad (`?real`) salvo que se pida una lectura fija para ver las
 * pantallas que dependen de ella:
 *
 *   localStorage.maqueta_lectura = 'ok'     -> un trayecto leido entero (3c)
 *   localStorage.maqueta_lectura = 'varios' -> un historial con tres (3g)
 *   delete localStorage.maqueta_lectura     -> el lector de verdad
 */

import * as real from '/assets/js/extraccion.js?real';

export * from '/assets/js/extraccion.js?real';

const UNO = '9:41\nBiciMAD\nTrayecto finalizado\n124 - Metro Bilbao (124)\n115 - Ferraz - Templo de Debod (115)\nSalida 09:14\nLlegada 09:31\nDuracion 17 min 18 s\nBici 2471';
const VARIOS = [
  UNO,
  '9:41\nBiciMAD\nTrayecto finalizado\n102 - Plaza de España (102)\n001 - Puerta del Sol (001)\nSalida 08:02\nLlegada 08:13\nDuracion 11 min 04 s',
  '9:41\nBiciMAD\nTrayecto finalizado\n001 - Puerta del Sol (001)\n124 - Metro Bilbao (124)\nSalida 07:30\nLlegada 07:44\nDuracion 14 min 40 s',
].join('\n\n');

export async function extraer(imagen, alProgresar) {
  const modo = (() => { try { return localStorage.getItem('maqueta_lectura'); } catch { return null; } })();
  if (!modo) return real.extraer(imagen, alProgresar);
  // Sin esperas: con la pestaña en segundo plano los temporizadores se frenan.
  alProgresar?.('recognizing text', 1);
  const texto = modo === 'varios' ? VARIOS : UNO;
  return { disponible: true, oscura: false, confianza: 92, texto, ...real.interpretar(texto) };
}
