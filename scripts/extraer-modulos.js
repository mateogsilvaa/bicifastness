#!/usr/bin/env node
/**
 * Extrae el <script type="module"> de cada pagina a un fichero suelto para que
 * ESLint pueda analizarlo.
 *
 * Existe porque el JavaScript de la app vive incrustado en el HTML, y sin esto
 * ninguna herramienta lo mira. El fallo que lo motivo: al cambiar la firma de
 * `reportarViaje` quedo una llamada usando una variable que ya no estaba en
 * ambito. El HTML seguia siendo valido y los tests pasaban, pero el boton de
 * reportar reventaba al pulsarlo.
 *
 * Uso: node scripts/extraer-modulos.js <directorio-destino>
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const DESTINO = process.argv[2] || path.join(RAIZ, '.modulos');

function paginas(dir, encontradas = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'backend', '.modulos'].includes(e.name)) continue;
    const completo = path.join(dir, e.name);
    if (e.isDirectory()) paginas(completo, encontradas);
    else if (e.name.endsWith('.html')) encontradas.push(completo);
  }
  return encontradas;
}

fs.rmSync(DESTINO, { recursive: true, force: true });
fs.mkdirSync(DESTINO, { recursive: true });

let total = 0;
for (const pagina of paginas(RAIZ)) {
  const html = fs.readFileSync(pagina, 'utf8');
  const bloque = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  if (!bloque) continue;

  const rel = path.relative(RAIZ, pagina).split(path.sep).join('__').replace('.html', '.js');
  // Las rutas absolutas del navegador (/assets/...) no las resuelve Node, asi
  // que se reescriben relativas a la raiz del proyecto.
  const prefijo = path.relative(DESTINO, RAIZ).split(path.sep).join('/');
  const codigo = bloque[1].split("from '/").join(`from '${prefijo}/`);
  fs.writeFileSync(path.join(DESTINO, rel), codigo, 'utf8');
  total++;
}

console.log(`${total} modulos extraidos en ${path.relative(RAIZ, DESTINO)}/`);
