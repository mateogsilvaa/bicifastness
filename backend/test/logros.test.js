'use strict';

/**
 * Insignias (#24).
 *
 * De donde se viene: DOS diccionarios copiados a mano en la raiz — `insignias.js`
 * y `cinsignias.js` —, identicos salvo por el color. Ninguna de las insignias
 * que listaban la concedia nadie, y las que SI se concedian (las del cierre de
 * temporada) no estaban en ningun diccionario, asi que el perfil no las
 * pintaba. Se concedian y eran invisibles.
 *
 * Y las que se pintaban lo hacian con `<i class="fi fi-rr-home">`: clases de una
 * fuente de iconos que ninguna pagina carga ya y que la CSP no admitiria. Cajas
 * vacias.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const logros = require('../src/logros');

const RAIZ = path.join(__dirname, '..', '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

// --- El catalogo -----------------------------------------------------------------

test('hay insignias alcanzables para los tres perfiles de piloto', () => {
  // El motivo de existir de este issue: un fondista que solo ve medallas de
  // sprint concluye que esto no es para el y no vuelve.
  const porModo = {};
  for (const insignia of Object.values(logros.CATALOGO.insignias)) {
    porModo[insignia.modo] = (porModo[insignia.modo] || 0) + 1;
  }

  for (const modo of ['fondo', 'sprint', 'constancia']) {
    assert.ok((porModo[modo] || 0) >= 2,
      `solo hay ${porModo[modo] || 0} insignias de ${modo}: ese perfil de piloto se queda sin objetivos`);
  }
});

test('cada insignia apunta a un icono que existe en el sprite', () => {
  // Un icono que no existe no da error: el navegador pinta un hueco. Es como se
  // colaron las clases de Flaticon, que llevaban meses sin renderizar nada.
  const sprite = leer('assets/img/iconos.svg');
  const disponibles = new Set([...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));

  const todas = { ...logros.CATALOGO.insignias, ...logros.CATALOGO.temporada };
  for (const [clave, datos] of Object.entries(todas)) {
    assert.ok(disponibles.has(datos.icono),
      `${clave} apunta a #${datos.icono}, que no esta en el sprite`);
  }
});

test('el catalogo generado coincide con su fuente', () => {
  // Es un fichero generado. Editarlo a mano funciona hasta que alguien vuelve a
  // lanzar el generador y se lo lleva por delante.
  const fuente = JSON.parse(leer('data/insignias.json'));
  const sinComentario = (o) => Object.keys(o).filter((k) => !k.startsWith('_'));

  assert.deepStrictEqual(
    Object.keys(logros.CATALOGO.insignias).sort(),
    sinComentario(fuente.insignias).sort());
});

// --- Cuando se concede -------------------------------------------------------------

test('se concede lo que se ha ganado, y solo eso', () => {
  const novato = { viajesVerificados: 1, metrosTotales: 200, logros: [] };
  assert.deepStrictEqual(logros.nuevas(novato), ['primer-viaje']);

  const nadie = { viajesVerificados: 0, metrosTotales: 0, logros: [] };
  assert.deepStrictEqual(logros.nuevas(nadie), []);
});

test('lo que ya se tiene no se vuelve a conceder', () => {
  // Un `arrayUnion` con lo que ya esta dentro es una escritura por viaje para
  // confirmar que no hay novedad, que es justo la cuota que no sobra.
  const piloto = { viajesVerificados: 5, logros: ['primer-viaje'] };
  assert.deepStrictEqual(logros.nuevas(piloto), []);
});

test('los escalones se acumulan: quien llega de golpe se lleva los tres', () => {
  // Un usuario migrado de la v1 con 1.200 km no ha pasado por los escalones. No
  // darselos porque "no estaba cuando toco" seria arbitrario.
  const veterano = { viajesVerificados: 120, metrosTotales: 1200000, logros: [] };
  const ganadas = logros.nuevas(veterano);

  for (const clave of ['fondo-50', 'fondo-250', 'fondo-1000', 'veterano', 'centenario']) {
    assert.ok(ganadas.includes(clave), `falta ${clave}`);
  }
});

test('las que no tienen regla no se conceden solas', () => {
  // Fundador de clan, conquistador, podio de tramo. Las concede quien sabe de
  // eso: una insignia que se otorga por accidente vale menos que ninguna.
  const cualquiera = {
    viajesVerificados: 999, metrosTotales: 99999999, mejorRacha: 999,
    puntosPorRuta: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`10${i}-20${i}`, 5])),
    logros: [],
  };
  const ganadas = logros.nuevas(cualquiera);

  for (const clave of ['clan-fundador', 'clan-conquistador', 'sprint-podio']) {
    assert.ok(!ganadas.includes(clave), `${clave} se ha concedido sola`);
  }
});

test('los campos derivados salen del propio usuario, sin leer nada mas', () => {
  // Evaluar insignias no puede costar lecturas: conceder una medalla saldria
  // mas caro que verificar el viaje que la gana.
  const derivados = logros.derivados({
    puntosPorRuta: { '100-101': 10, '101-102': 5, '100-103': 3 },
  });

  assert.strictEqual(derivados.tramosConPuntos, 3);
  // 100, 101, 102 y 103: las repetidas cuentan una vez.
  assert.strictEqual(derivados.estacionesVisitadas, 4);
});

// --- Que se pinta -------------------------------------------------------------------

test('una insignia de temporada se sabe describir aunque no este en el catalogo', () => {
  // Son `temporada-2026-07-oro` y cambian cada mes: no se pueden listar una a
  // una. Antes el cierre las concedia con un id que no estaba en ningun
  // diccionario y el perfil no pintaba nada.
  const oro = logros.describir('temporada-2026-07-oro');

  assert.strictEqual(oro.modo, 'temporada');
  assert.match(oro.titulo, /Oro/);
  assert.match(oro.titulo, /2026-07/);
  assert.ok(oro.icono);
});

test('una insignia que nadie sabe describir se pinta igual, no se traga', () => {
  // Las de la v1 (`rutero_fiel`, `racha_fuego`) siguen en documentos de gente.
  // Devolver null las hacia desaparecer de la vitrina sin que nadie se enterase.
  const vieja = logros.describir('rutero_fiel');

  assert.ok(vieja.titulo, 'una insignia concedida no puede quedarse sin pintar');
  assert.ok(vieja.icono);
});

test('lo que concede el cierre de temporada es describible', () => {
  // El puente entre los dos sitios: `temporadas.js` compone los ids y esto los
  // tiene que entender. Si divergen, se conceden medallas invisibles.
  const temporadas = require('../src/temporadas');
  const premios = temporadas.insigniasDeCierre(
    [
      { uid: 'a', puntos: 100, metros: 5000, mejorRacha: 10 },
      { uid: 'b', puntos: 50, metros: 9000, mejorRacha: 2 },
      { uid: 'c', puntos: 10, metros: 100, mejorRacha: 30 },
    ],
    '2026-07');

  const todas = [...premios.values()].flat();
  assert.ok(todas.length > 0, 'el cierre no ha repartido nada');

  for (const clave of todas) {
    assert.ok(logros.deTemporada(clave),
      `el cierre concede "${clave}" y la vitrina no sabe describirla`);
  }
});

// --- Quien las concede ----------------------------------------------------------------

test('el navegador no puede escribirse insignias', () => {
  const reglas = leer('firestore.rules');
  const usuarios = reglas.slice(reglas.indexOf('match /usuarios/'), reglas.indexOf('match /solicitudes_borrado'));

  // Lo que el usuario puede tocar de su propio documento.
  const propio = usuarios.match(/allow update: if esYo\(uid\)[\s\S]*?;/)[0];
  assert.ok(!/logros/.test(propio), 'el usuario puede escribirse insignias');

  // Y el alta nace sin ninguna.
  assert.match(usuarios, /datos\(\)\.logros\.size\(\) == 0/);
});

test('el modulo que las concede no expone forma de escribir una a mano', () => {
  // La regla lo respalda, pero conviene que tambien lo haga el diseno: aqui se
  // evalua el estado del piloto y sale lo ganado. No hay funcion que reciba una
  // insignia y la conceda.
  assert.ok(!Object.keys(logros).some((f) => /^(dar|conceder|otorgar)/.test(f)),
    'hay una funcion para conceder insignias a dedo');
});
