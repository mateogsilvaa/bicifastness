/**
 * El enlace de evento que alguien abrio sin tener sesion.
 *
 * Quien llega a /canjear/?c=CODIGO sin haber entrado tiene que entrar (o
 * crear la cuenta) antes de poder canjearlo, y por el camino se pierde el
 * enlace. Se guarda aqui y, al entrar, se le devuelve a /canjear/ en vez de
 * dejarle en la portada sin saber que tenia algo esperando.
 *
 * Solo el codigo, en el navegador de quien lo abrio y hasta que lo canjea.
 */

const CLAVE = 'bf_canje';
export const FORMA_CODIGO = /^[A-Za-z0-9]{16,40}$/;

export function guardarCanje(codigo) {
  try { if (FORMA_CODIGO.test(codigo)) localStorage.setItem(CLAVE, codigo); } catch { /* sin almacenamiento, hay que volver a abrir el enlace */ }
}

export function canjePendiente() {
  try {
    const c = localStorage.getItem(CLAVE);
    return FORMA_CODIGO.test(c || '') ? c : null;
  } catch {
    return null;
  }
}

export function olvidarCanje() {
  try { localStorage.removeItem(CLAVE); } catch { /* nada que olvidar */ }
}

/**
 * A donde ir despues de entrar. Una cuenta recien creada no tiene aun nombre de
 * piloto (se lo pide la portada) y sin perfil no se puede canjear: esa va a la
 * portada, y el enlace sigue guardado esperando.
 */
export function destinoTrasEntrar({ cuentaNueva = false } = {}) {
  return !cuentaNueva && canjePendiente() ? '/canjear/' : '/';
}
