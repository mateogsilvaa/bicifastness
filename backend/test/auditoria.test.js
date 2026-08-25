'use strict';

/**
 * La auditoria fuera del documento del viaje.
 *
 * DE DONDE SE VIENE. El worker guardaba el veredicto entero dentro del viaje, y
 * las reglas dejan que su dueño lea su viaje entero. El veredicto esta escrito
 * para QUIEN REVISA: riesgo acumulado, gravedad de cada señal y mensajes con los
 * numeros exactos ("distancia perceptual 4", "2,7 desviaciones por debajo de la
 * media de la ruta"). Cualquiera con la consola del navegador abierta tenia el
 * manual del antifraude: cuanto puede acercarse a cada umbral sin saltarlo.
 *
 * `assets/js/motivos.js` tapaba la puerta — la interfaz nunca ha enseñado esos
 * textos — pero la ventana seguia abierta.
 *
 * Lo que se prueba aqui es que la ventana esta cerrada y que sigue habiendo con
 * que explicarle a la persona por que le han rechazado el viaje.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

/** El codigo sin comentarios: un comentario que nombre algo no es usarlo. */
const sinComentarios = (fuente) => fuente
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const cargarModuloCliente = async (rel) => {
  const fuente = leer(rel).replace(/from '\/assets\//g, "from '../../assets/");
  const tmp = path.join(__dirname, `.tmp-${path.basename(rel)}`);
  fs.writeFileSync(tmp, fuente);
  try {
    return await import(`file://${tmp}`);
  } finally {
    fs.unlinkSync(tmp);
  }
};

// --- Lo que ya no se guarda en el viaje ---------------------------------------

test('el worker no vuelve a meter el veredicto dentro del viaje', () => {
  const worker = sinComentarios(leer('backend/worker.js'));

  // `auditoria:` solo puede aparecer para BORRARLO del viaje.
  const escrituras = worker.match(/auditoria:\s*[^,\n]+/g) || [];
  for (const escritura of escrituras) {
    assert.match(escritura, /FieldValue\.delete\(\)/,
      `el worker escribe la auditoria en el viaje: "${escritura.trim()}"`);
  }

  assert.match(worker, /auditorias\/\$\{viajeId\}/,
    'el analisis no se guarda en su propia coleccion');
});

test('las reglas solo dejan leer la auditoria a la administracion', () => {
  const reglas = leer('firestore.rules');
  const inicio = reglas.indexOf('match /auditorias/{viajeId}');

  assert.ok(inicio > -1, 'no hay reglas para la coleccion de auditorias');

  const bloque = reglas.slice(inicio, reglas.indexOf('match /', inicio + 10));
  assert.match(bloque, /allow read: if esAdmin\(\)/);
  assert.match(bloque, /allow write: if false/);
});

test('el mensaje de un error interno no acaba en el documento del viaje', () => {
  // El camino de fallo escribia `mensaje: error.message` dentro del viaje, y ahi
  // caben rutas de fichero y detalles del servidor.
  const worker = sinComentarios(leer('backend/worker.js'));
  const bloque = worker.slice(worker.indexOf('cuenta.error++'));

  assert.ok(!/doc\.ref\.update\([\s\S]{0,400}error\.message/.test(bloque),
    'el mensaje del error sigue yendo al viaje');
  assert.match(bloque, /escribirAuditoria\([\s\S]{0,300}error\.message/,
    'el mensaje del error deberia ir a la auditoria');
});

test('el correo de viaje anulado no repite el resumen del antifraude', () => {
  // `auditoria.resumen` esta escrito para quien revisa y lleva numeros dentro.
  // Enviarlo por correo es la misma fuga por otro sitio.
  const worker = sinComentarios(leer('backend/worker.js'));
  const bloque = worker.slice(worker.indexOf('plantillas.viajeAnulado'));

  assert.ok(!/auditoria\?\.resumen/.test(bloque.slice(0, 400)),
    'el correo sigue mandando el resumen de la auditoria');
});

// --- Lo que se queda, y por que basta ------------------------------------------

test('los codigos llegan ordenados de mas grave a menos', async () => {
  // El orden lo pone el servidor porque es lo unico que se lleva de la
  // gravedad: los pesos son parte del manual del antifraude y no bajan.
  const { motivoDeViaje } = await cargarModuloCliente('assets/js/motivos.js');

  const motivo = motivoDeViaje({ motivos: ['ruta_no_coincide', 'horario_inusual'] });
  assert.match(motivo.texto, /estaciones que has escrito/);
});

test('un viaje sin migrar todavia se explica igual', async () => {
  // Mientras `scripts/migrar-auditorias.js` no haya pasado, hay viajes con la
  // forma antigua. Si el respaldo no ordenara por gravedad, el motivo seria el
  // de la primera señal emitida, que es la del orden de las comprobaciones y no
  // la razon del rechazo.
  const { motivoDeViaje } = await cargarModuloCliente('assets/js/motivos.js');

  const motivo = motivoDeViaje({
    auditoria: {
      señales: [
        { codigo: 'horario_inusual', gravedad: 10, mensaje: 'A las 03:12.' },
        { codigo: 'ruta_no_coincide', gravedad: 60, mensaje: 'Se lee 2-110 y se declara 2-115.' },
      ],
    },
  });

  assert.match(motivo.texto, /estaciones que has escrito/);
});

test('el panel no lee la auditoria del documento del viaje', () => {
  const panel = sinComentarios(leer('assets/js/paginas/admin.js'));

  assert.match(panel, /getDoc\(doc\(db, 'auditorias', viajeId\)\)/,
    'el panel no pide la auditoria a su coleccion');
  // El sugerido del selector y el resumen del historial salen de `motivos`, que
  // ya viene ordenado: pedir la auditoria para eso serian veinte lecturas mas.
  assert.ok(!/viaje\.auditoria\?\.señales/.test(panel),
    'el selector de motivo sigue tirando de la auditoria del viaje');
  assert.ok(!/auditoria\?\.riesgo/.test(panel),
    'el resumen del historial sigue tirando del riesgo de cada viaje');
});

test('borrar la cuenta se lleva tambien las auditorias', () => {
  // Llevan dentro lo que se leyo en la captura: estaciones, horas y duracion de
  // un trayecto suyo. El viaje se anonimiza y se queda; el analisis no.
  const borrado = sinComentarios(leer('backend/src/borrado.js'));

  assert.match(borrado, /auditorias\/\$\{doc\.id\}/,
    'el borrado no toca la coleccion de auditorias');
  assert.match(borrado, /auditoria: admin\.firestore\.FieldValue\.delete\(\)/,
    'el viaje anonimizado conserva la auditoria vieja dentro');
});

test('la migracion copia antes de borrar, y en el mismo lote', () => {
  // Un viaje al que se le borrara la auditoria sin haberla copiado perderia el
  // analisis para siempre, y es lo unico que tiene quien revisa para decidir.
  const script = leer('scripts/migrar-auditorias.js');

  const copia = script.indexOf('lote.set(db.doc(`auditorias/');
  const borra = script.indexOf('auditoria: admin.firestore.FieldValue.delete()');

  assert.ok(copia > -1 && borra > -1, 'la migracion no hace las dos cosas');
  assert.ok(copia < borra, 'la migracion borra antes de copiar');
  assert.match(sinComentarios(script), /lote\.commit\(\)/,
    'las dos escrituras deberian ir en el mismo lote');
});
