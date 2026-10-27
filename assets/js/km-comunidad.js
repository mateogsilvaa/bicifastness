/**
 * Los kilometros de la comunidad por semana, para la story de los lunes
 * (/admin/redes/, pieza "Kilómetros de la comunidad").
 *
 * Funciones puras: entran viajes verificados ({ fechaViaje, distanciaMetros,
 * tiempoSegundos, uid }) y salen las cifras. Sin red, para poder probarlas.
 */

import { lunesDeLaSemana, sumarDias } from './dia.js';

/** Las ultimas `n` semanas completas (sin la que esta en curso), de la mas vieja a la mas nueva. */
export function kmPorSemana(viajes, hoy, n = 8) {
  const actual = lunesDeLaSemana(new Date(`${hoy}T12:00:00Z`));
  const lunes = Array.from({ length: n }, (_, i) => sumarDias(actual, -7 * (n - i)));
  const semanas = new Map(lunes.map((l) => [l, { lunes: l, metros: 0, trayectos: 0, segundos: 0, pilotos: new Set() }]));
  for (const v of viajes) {
    const dia = String(v.fechaViaje || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) continue;
    const s = semanas.get(lunesDeLaSemana(new Date(`${dia}T12:00:00Z`)));
    if (!s) continue;
    s.metros += Number(v.distanciaMetros) || 0;
    s.segundos += Number(v.tiempoSegundos) || 0;
    s.trayectos += 1;
    if (v.uid) s.pilotos.add(v.uid);
  }
  return lunes.map((l) => {
    const s = semanas.get(l);
    return { lunes: l, km: s.metros / 1000, trayectos: s.trayectos, horas: s.segundos / 3600, pilotos: s.pilotos.size };
  });
}

/** Cuanto cambia `a` respecto a `b`, en %. `null` si no hay con que comparar. */
export function variacion(a, b) {
  if (!b) return null;
  return Math.round(((a - b) / b) * 100);
}

/**
 * Distancias conocidas para ponerle cara a los kilometros. Se elige la que
 * deja una cifra mas "contable" (entre 1 y 20 veces), y si no, la mas cercana.
 */
const DISTANCIAS = [
  { km: 4.4, texto: (x) => `${x} vueltas al Retiro` },
  { km: 10.5, texto: (x) => `${x} veces la Castellana entera` },
  { km: 32.5, texto: (x) => `${x} vueltas a la M-30` },
  { km: 42.195, texto: (x) => `${x} maratones` },
  { km: 72, texto: (x) => (x === '1' ? 'De Madrid a Toledo' : `${x} veces de Madrid a Toledo`) },
  { km: 90, texto: (x) => (x === '1' ? 'De Madrid a Segovia' : `${x} veces de Madrid a Segovia`) },
  { km: 620, texto: (x) => (x === '1' ? 'De Madrid a Barcelona' : `${x} veces de Madrid a Barcelona`) },
  { km: 780, texto: (x) => (x === '1' ? 'El Camino de Santiago francés' : `${x} Caminos de Santiago`) },
  { km: 3300, texto: (x) => (x === '1' ? 'Una Vuelta a España' : `${x} Vueltas a España`) },
  { km: 40075, texto: (x) => (x === '1' ? 'Una vuelta al mundo' : `${x} vueltas al mundo`) },
];

const cifra = (n) => (n >= 10 ? String(Math.round(n)) : n.toFixed(1).replace('.', ',').replace(/,0$/, ''));

/** Las dos equivalencias mas vistosas para `km`. */
export function equivalencias(km) {
  if (!km) return [];
  const opciones = DISTANCIAS.map((d) => ({ d, veces: km / d.km }))
    .filter((o) => o.veces >= 0.95)
    .sort((a, b) => {
      // Lo mas "contable": cerca de 1-12 veces, y de las grandes antes.
      const pa = a.veces <= 12 ? 0 : 1;
      const pb = b.veces <= 12 ? 0 : 1;
      return pa - pb || b.d.km - a.d.km;
    });
  return opciones.slice(0, 2).map((o) => o.d.texto(cifra(o.veces)));
}

/** CO₂ que no ha salido de un coche por esos km (≈120 g/km de un turismo medio). */
export const kgCO2 = (km) => Math.round(km * 0.12);
