/**
 * Bicis y anclajes libres por estacion, en vivo.
 *
 * Sale de CityBikes (api.citybik.es): gratuita, publica, con CORS abierto y la
 * misma fuente que usan la mayoria de webs que enseñan la disponibilidad de
 * BiciMAD. Se pide DESDE EL NAVEGADOR y no pasa por Firestore: no cuesta ni una
 * lectura de la cuota, y cada persona gasta su propio limite de CityBikes (300
 * peticiones por hora y por IP, muy por encima de lo que hace falta).
 *
 * Se guarda un minuto en la pestaña: el dato cambia cada pocos minutos en
 * origen, y volver al mapa no tiene por que volver a descargarlo.
 *
 * Si CityBikes no responde, las pantallas siguen igual sin la linea de bicis.
 */

const URL_VIVO = 'https://api.citybik.es/v2/networks/bicimad?fields=stations';
const CLAVE = 'bf_bicis_vivo';
const VIGENCIA_MS = 60 * 1000;

let enMemoria = null;
let enCurso = null;

/** "002", "2" y "2a" normalizados como los usa el resto de la web. */
export const claveEstacion = (n) => String(n ?? '').trim().toUpperCase().replace(/^0+(?=\d)/, '');

function leerGuardado() {
  try {
    const crudo = sessionStorage.getItem(CLAVE);
    if (!crudo) return null;
    const datos = JSON.parse(crudo);
    return Date.now() - datos.pedido < VIGENCIA_MS ? datos : null;
  } catch {
    return null; // sin almacenamiento, se vuelve a pedir y ya
  }
}

/**
 * La disponibilidad de todas las estaciones.
 * @returns {Promise<{pedido: number, estaciones: Object<string, {bicis: number, huecos: number, bases: number, enLinea: boolean}>}|null>}
 */
export async function bicisEnVivo({ forzar = false } = {}) {
  if (!forzar && enMemoria && Date.now() - enMemoria.pedido < VIGENCIA_MS) return enMemoria;
  if (!forzar) {
    const guardado = leerGuardado();
    if (guardado) { enMemoria = guardado; return guardado; }
  }
  if (enCurso) return enCurso;

  enCurso = (async () => {
    try {
      const control = new AbortController();
      const reloj = setTimeout(() => control.abort(), 8000);
      const respuesta = await fetch(URL_VIVO, { signal: control.signal });
      clearTimeout(reloj);
      if (!respuesta.ok) return enMemoria;
      const { network } = await respuesta.json();
      const estaciones = {};
      for (const s of network?.stations || []) {
        const k = claveEstacion(s.extra?.number);
        if (!k) continue;
        estaciones[k] = {
          bicis: Number(s.free_bikes) || 0,
          huecos: Number(s.empty_slots) || 0,
          bases: Number(s.extra?.slots) || 0,
          enLinea: s.extra?.online !== false,
        };
      }
      enMemoria = { pedido: Date.now(), estaciones };
      try { sessionStorage.setItem(CLAVE, JSON.stringify(enMemoria)); } catch { /* sin sitio, en memoria vale */ }
      return enMemoria;
    } catch {
      return enMemoria; // sin red o CityBikes caido: lo ultimo que hubiera
    } finally {
      enCurso = null;
    }
  })();
  return enCurso;
}

/** La de una estacion concreta, o null. */
export async function bicisDe(numero) {
  const datos = await bicisEnVivo();
  return datos?.estaciones?.[claveEstacion(numero)] || null;
}

/** "12 bicis · 5 huecos" */
export function textoBicis(d) {
  if (!d) return '';
  if (!d.enLinea) return 'Sin conexión ahora mismo';
  return `${d.bicis} ${d.bicis === 1 ? 'bici' : 'bicis'} · ${d.huecos} ${d.huecos === 1 ? 'hueco' : 'huecos'}`;
}

/** Hace cuanto se pidio, en palabras. */
export function haceCuanto(pedido) {
  const s = Math.round((Date.now() - pedido) / 1000);
  return s < 60 ? 'ahora mismo' : `hace ${Math.round(s / 60)} min`;
}
