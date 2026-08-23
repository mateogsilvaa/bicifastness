#!/usr/bin/env node
/**
 * Reparte el catalogo de insignias a los dos lados desde su unica fuente.
 *
 * Antes habia DOS diccionarios copiados a mano en la raiz — `insignias.js` y
 * `cinsignias.js` —, identicos salvo por el color. Y peor: ninguna de las
 * insignias que listaban la concedia nadie, mientras que las que SI se
 * concedian (las del cierre de temporada) no estaban en ningun diccionario, asi
 * que el perfil no las pintaba. Se concedian y no se veian.
 *
 * Salidas:
 *   assets/data/insignias.js     modulo ES para el navegador
 *   backend/lib/insignias.json   para el worker, que es quien las concede
 *
 * Uso: node scripts/build-insignias.js
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const ORIGEN = path.join(RAIZ, 'data', 'insignias.json');
const FRONT = path.join(RAIZ, 'assets', 'data', 'insignias.js');
const BACK = path.join(RAIZ, 'backend', 'lib', 'insignias.json');

/** Las claves que empiezan por `_` son comentarios, no datos. */
const sinComentarios = (objeto) => Object.fromEntries(
  Object.entries(objeto).filter(([clave]) => !clave.startsWith('_')));

/** Iconos que existen de verdad en el sprite. */
function iconosDisponibles() {
  const sprite = fs.readFileSync(path.join(RAIZ, 'assets', 'img', 'iconos.svg'), 'utf8');
  return new Set([...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
}

function main() {
  const fuente = JSON.parse(fs.readFileSync(ORIGEN, 'utf8'));

  const insignias = sinComentarios(fuente.insignias);
  const temporada = sinComentarios(fuente.temporada);
  const iconos = iconosDisponibles();

  // Un icono que no existe en el sprite no da error en ninguna parte: el
  // navegador pinta un hueco. Es exactamente como se colaron las clases de
  // Flaticon, que llevaban meses sin renderizar nada.
  const rotos = [];
  for (const [clave, datos] of [...Object.entries(insignias), ...Object.entries(temporada)]) {
    if (!iconos.has(datos.icono)) rotos.push(`${clave} -> #${datos.icono}`);
  }
  if (rotos.length) {
    console.error(`Hay insignias que apuntan a un icono que no existe en el sprite:\n  ${rotos.join('\n  ')}`);
    process.exit(1);
  }

  const catalogo = { insignias, temporada };

  fs.mkdirSync(path.dirname(BACK), { recursive: true });
  fs.writeFileSync(BACK, `${JSON.stringify(catalogo)}\n`, 'utf8');

  fs.mkdirSync(path.dirname(FRONT), { recursive: true });
  fs.writeFileSync(FRONT,
    '// GENERADO AUTOMATICAMENTE por scripts/build-insignias.js — no editar a mano.\n'
    + `// Fuente: data/insignias.json (${Object.keys(insignias).length} insignias)\n`
    + `export const INSIGNIAS = ${JSON.stringify(insignias)};\n`
    + `export const TEMPORADA = ${JSON.stringify(temporada)};\n`,
    'utf8');

  console.log(`OK: ${Object.keys(insignias).length} insignias y `
    + `${Object.keys(temporada).length} sufijos de temporada repartidos a ambos lados`);
}

main();
