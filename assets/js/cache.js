/**
 * Cache de sesion para documentos agregados (#37).
 *
 * Que resuelve: los agregados los reconstruye el worker como mucho una vez cada
 * pasada, o sea cada 5-15 minutos. El navegador, en cambio, los volvia a pedir
 * cada vez que alguien entraba en la pantalla. Ir a la clasificacion, mirar el
 * perfil y volver costaba las lecturas dos veces para pintar exactamente lo
 * mismo.
 *
 * Por que `sessionStorage` y no `localStorage`: esto vive lo que dure la pestana
 * y se va al cerrarla. Un dato de clasificacion guardado durante dias en el
 * disco de alguien no aporta nada y es una copia mas que mantener.
 *
 * Y por que no basta la cache de Firestore: la persistente sirve la consulta sin
 * gastar cuota, pero sigue yendo a la red a comprobar si cambio. Esto se la
 * ahorra del todo mientras el dato sea reciente.
 *
 * NUNCA para datos de una persona concreta. `sessionStorage` es del origen, no
 * de la sesion de Firebase: si alguien cierra sesion y entra otra cuenta en la
 * misma pestana, lo guardado sigue ahi. Aqui solo van agregados, que son
 * publicos por definicion.
 */

/**
 * Cuanto se considera reciente un agregado.
 *
 * El worker corre cada 5 minutos y GitHub retrasa las ejecuciones programadas,
 * asi que el dato real ya viene con varios minutos de antiguedad. Dos minutos de
 * cache no anaden retraso perceptible y se comen la mayoria de las idas y
 * venidas entre pantallas.
 */
const VIGENCIA_MS = 2 * 60 * 1000;

const clave = (nombre) => `bf_agregado:${nombre}`;

/**
 * Lo guardado, si sigue siendo reciente. `undefined` significa "no hay nada
 * utilizable", que no es lo mismo que `null`: un agregado que todavia no existe
 * se cachea COMO null, para no volver a preguntar por el cada vez.
 */
export function leerCache(nombre, ahora = Date.now()) {
  try {
    const crudo = sessionStorage.getItem(clave(nombre));
    if (!crudo) return undefined;

    const { datos, guardadoEn } = JSON.parse(crudo);
    if (!Number.isFinite(guardadoEn) || (ahora - guardadoEn) > VIGENCIA_MS) {
      sessionStorage.removeItem(clave(nombre));
      return undefined;
    }
    return datos;
  } catch {
    // Modo privado, cuota llena o JSON corrupto. Quedarse sin cache es
    // molesto; quedarse sin pantalla, no.
    return undefined;
  }
}

export function guardarCache(nombre, datos, ahora = Date.now()) {
  try {
    sessionStorage.setItem(clave(nombre), JSON.stringify({ datos, guardadoEn: ahora }));
  } catch {
    // `sessionStorage` tiene un tope de unos 5 MB y un agregado paginado puede
    // ser grande. Si no cabe, se sigue sin cache: no es un error.
  }
}

/**
 * Vacia lo cacheado. Hay que llamarlo al cerrar sesion: aunque los agregados
 * sean publicos, dejar rastro de la sesion anterior en la pestana confunde.
 */
export function vaciarCache() {
  try {
    for (const k of Object.keys(sessionStorage)) {
      if (k.startsWith('bf_agregado:')) sessionStorage.removeItem(k);
    }
  } catch { /* nada que vaciar */ }
}

export { VIGENCIA_MS };
