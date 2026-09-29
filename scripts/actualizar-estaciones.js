#!/usr/bin/env node
/**
 * Pone al dia `data/emt.geojson` con las estaciones que BiciMAD tiene ahora.
 *
 * La fuente oficial (datos.madrid.es, "bikestationbicimad") se publica de
 * tarde en tarde: la ultima copia trae 631 estaciones, y BiciMAD ya tiene mas
 * de 670 funcionando. Las que faltan son justo las nuevas (Pozuelo, Aravaca,
 * Vicalvaro, Sanchinarro...), y un trayecto que empieza o acaba en una de ellas
 * no se podia subir: "esa estacion no existe".
 *
 * Asi que se fusionan dos fuentes:
 *
 *   1. la oficial, que manda en todo lo que trae (nombre, direccion, bases y
 *      estado), porque es la del Ayuntamiento;
 *   2. la lista EN VIVO de CityBikes (api.citybik.es, gratuita y publica, la
 *      misma que usan la mayoria de webs que enseñan bicis por estacion), de
 *      la que solo se AÑADEN las estaciones que la oficial no tiene.
 *
 * Nunca se borra una estacion: una que hoy no sale en vivo puede estar solo
 * desconectada, y borrarla dejaria huerfanos los trayectos que ya la usan.
 *
 * Uso:
 *   node scripts/actualizar-estaciones.js                 # descarga CityBikes
 *   node scripts/actualizar-estaciones.js --oficial f.json # y ademas otra copia oficial
 *   node scripts/actualizar-estaciones.js --vivo cb.json   # sin red, con una copia guardada
 *   node scripts/actualizar-estaciones.js --simular        # solo cuenta, no escribe
 *
 * Despues: `npm run datos` regenera assets/data/estaciones.js y
 * backend/lib/estaciones.json.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GEOJSON = path.join(ROOT, 'data', 'emt.geojson');
const URL_VIVO = 'https://api.citybik.es/v2/networks/bicimad?fields=stations';

const args = process.argv.slice(2);
const valor = (bandera) => { const i = args.indexOf(bandera); return i >= 0 ? args[i + 1] : null; };
const SIMULAR = args.includes('--simular');

/** "002" y "2" son la misma estacion; "25a" y "25A" tambien. */
const clave = (n) => String(n ?? '').trim().toUpperCase().replace(/^0+(?=\d)/, '');

function leerJson(fichero) {
  // Los ficheros del Ayuntamiento vienen con BOM.
  return JSON.parse(fs.readFileSync(fichero, 'utf8').replace(/^﻿/, ''));
}

async function estacionesEnVivo() {
  const local = valor('--vivo');
  if (local) return leerJson(local).network.stations;
  const respuesta = await fetch(URL_VIVO, { headers: { 'User-Agent': 'bicifastness (actualizar-estaciones)' } });
  if (!respuesta.ok) throw new Error(`CityBikes respondio ${respuesta.status}`);
  return (await respuesta.json()).network.stations;
}

/** Una estacion de CityBikes convertida al formato del geojson oficial. */
function aFeature(s, objectId) {
  const numero = String(s.extra?.number || '').trim();
  // Los nombres nuevos vienen a veces en mayusculas y con espacios de mas:
  // "660 -  LA FINCA". Se deja el numero delante, como en la oficial.
  const resto = String(s.name || '').replace(/^\s*[\dA-Za-z]+\s*[-–]\s*/, '').replace(/\s+/g, ' ').trim();
  const bonito = resto === resto.toUpperCase()
    ? resto.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, sep, letra) => sep + letra.toUpperCase())
    : resto;
  return {
    type: 'Feature',
    id: objectId,
    geometry: { type: 'Point', coordinates: [Number(s.longitude), Number(s.latitude)] },
    properties: {
      OBJECTID: objectId,
      Activate: s.extra?.online === false ? 0 : 1,
      Address: String(s.extra?.address || '').trim(),
      Name: `${numero} - ${bonito}`,
      number: numero,
      TotalBases: Number(s.extra?.slots) || (Number(s.free_bikes || 0) + Number(s.empty_slots || 0)),
      State: s.extra?.online === false ? 'NOT_IN_SERVICE' : 'IN_SERVICE',
      Fuente: 'citybikes',
      POINT_X: Number(s.longitude),
      POINT_Y: Number(s.latitude),
    },
  };
}

async function main() {
  const actual = leerJson(GEOJSON);
  const oficial = valor('--oficial') ? leerJson(valor('--oficial')) : null;

  // 1. La oficial manda en lo que trae.
  const porNumero = new Map(actual.features.map((f) => [clave(f.properties.number), f]));
  let actualizadas = 0;
  for (const f of oficial?.features || []) {
    const k = clave(f.properties.number);
    if (!k) continue;
    if (!porNumero.has(k) || JSON.stringify(porNumero.get(k).properties) !== JSON.stringify(f.properties)) actualizadas++;
    porNumero.set(k, f);
  }

  // 2. En vivo solo añade lo que falta.
  const vivo = await estacionesEnVivo();
  let siguienteId = Math.max(0, ...[...porNumero.values()].map((f) => Number(f.properties.OBJECTID) || 0)) + 1;
  const nuevas = [];
  for (const s of vivo) {
    const k = clave(s.extra?.number);
    if (!k || porNumero.has(k)) continue;
    if (!Number.isFinite(Number(s.latitude)) || !Number.isFinite(Number(s.longitude))) continue;
    const f = aFeature(s, siguienteId++);
    porNumero.set(k, f);
    nuevas.push(f.properties.Name);
  }

  const features = [...porNumero.values()].sort((a, b) => (Number(a.properties.OBJECTID) || 0) - (Number(b.properties.OBJECTID) || 0));
  console.log(`Oficial: ${actualizadas} cambiadas. En vivo: ${vivo.length} estaciones, ${nuevas.length} nuevas.`);
  for (const n of nuevas) console.log(`  + ${n}`);
  console.log(`Total: ${features.length} estaciones.`);

  if (SIMULAR) { console.log('\nSIMULACION: no se ha escrito nada.'); return; }
  fs.writeFileSync(GEOJSON, `${JSON.stringify({ ...actual, features }, null, 2)}\n`, 'utf8');
  console.log(`Escrito ${path.relative(ROOT, GEOJSON)}. Ahora: npm run datos`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
