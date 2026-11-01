#!/usr/bin/env node
/**
 * Vuelve a pasar el OCR por los casos revisados a mano (`banco_revision` +
 * `banco_capturas`) y dice, campo a campo, que lee bien y que no, con el
 * codigo de ahora. Es lo que hace falta para afinar el lector con capturas de
 * verdad (las de Android, sobre todo) sin sacar las imagenes de Firestore.
 *
 * SOLO imprime aciertos y fallos (si/no), la variante, la confianza y las
 * señales: ni rutas, ni horas, ni nombres. El log de Actions es publico.
 *
 * Uso: node scripts/diagnosticar-banco.js
 */

const path = require('path');
const admin = require('./lib/firebase-admin');

const B = path.join(__dirname, '..', 'backend', 'src');
const { leerCaptura, releerCaptura, elegirTrayecto, cerrar } = require(path.join(B, 'ocr'));
const { evaluar } = require(path.join(B, 'verificacion'));
const imagen = require(path.join(B, 'imagen'));

const sinCeros = (v) => String(v || '').replace(/^0+/, '');

async function main() {
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  const casos = await db.collection('banco_revision').get();
  console.log(`${casos.size} casos revisados a mano.\n`);
  const resumen = {};
  let n = 0;
  for (const c of casos.docs) {
    const d = c.data();
    n++;
    const cap = d.conCaptura ? await db.doc(`banco_capturas/${c.id}`).get() : null;
    if (!cap?.exists) { console.log(`#${n}: sin captura guardada`); continue; }
    const { buffer } = imagen.decodificarDataUrl(cap.data().datos);
    const ruta = d.declarado?.ruta || '';
    const tiempo = d.declarado?.tiempoSegundos;
    const cual = { tiempoSegundos: tiempo, fecha: String(d.declarado?.fechaViaje || '').slice(0, 10) };
    const lectura = elegirTrayecto(await leerCaptura({ buffer }), ruta, cual);
    const segunda = lectura.disponible && lectura.esBicimad ? elegirTrayecto(await releerCaptura({ buffer }), ruta, cual) : null;
    const insp = await imagen.inspeccionar(buffer);
    const [o, de] = ruta.split('-').map(sinCeros);
    const v = evaluar({
      ruta, tiempoSegundos: tiempo, lectura, segundaLectura: segunda, ancho: insp.ancho, alto: insp.alto,
      fechaViaje: d.declarado?.fechaViaje, subidoEn: null, capturadaEn: null, uid: 'x', capturaId: c.id,
      hashSha: 'x', hashPerceptual: '0', shaPrevios: [], hashesPrevios: [], viajesMismoDia: [], usosBici: [],
      primerViaje: false, distribucionRuta: null, velocidadesPrevias: [],
    });
    const si = (b) => (b ? 'si' : 'NO');
    const variante = lectura.variante || d.variante || '?';
    console.log(`#${n} [${variante}, ${insp.ancho}x${insp.alto}] persona: ${d.humana?.decision} | antes: ${d.automatica?.decision}`
      + ` | ahora: ${v.decision}${v.impecable ? ' (impecable)' : ''}`);
    console.log(`   lee: bicimad ${si(lectura.esBicimad)}, origen ${si(sinCeros(lectura.origen) === o)}, destino ${si(sinCeros(lectura.destino) === de)},`
      + ` duracion ${si(Number.isFinite(lectura.segundosDuracion) && Math.abs(lectura.segundosDuracion - tiempo) <= 5)},`
      + ` horas ${si(lectura.horaSalida && lectura.horaLlegada)}, confianza ${lectura.confianza ?? '-'}`
      + ` | 2.a lectura: ${segunda ? `origen ${si(sinCeros(segunda.origen) === o)}, duracion ${si(Math.abs((segunda.segundosDuracion ?? -999) - tiempo) <= 5)}` : 'no'}`);
    console.log(`   señales: ${v.señales.map((s) => `${s.codigo}(${s.gravedad})`).join(' ') || 'ninguna'}`);
    const k = `${variante}:${v.decision}`;
    resumen[k] = (resumen[k] || 0) + 1;
  }
  console.log('\nResumen (variante:decision ahora):', JSON.stringify(resumen));
  await cerrar();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
