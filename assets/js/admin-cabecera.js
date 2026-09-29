/**
 * La cabecera comun de administracion (09): logo, "admin", las cinco secciones
 * y, en la cola, el buscador de pilotos y clanes.
 *
 * Es una herramienta de trabajo, no parte de la app: sin barra lateral ni
 * barra inferior, y solo pensada para escritorio.
 */

import { el, reemplazar, anilloLogo } from '/assets/js/dom.js';

const SECCIONES = [
  { clave: 'revision', texto: 'Revisión', href: '/admin/#revision', contador: 'adm-cuenta-revision' },
  { clave: 'denuncias', texto: 'Denuncias', href: '/admin/#denuncias', contador: 'adm-cuenta-denuncias' },
  { clave: 'pilotos', texto: 'Pilotos y clanes', href: '/admin/#pilotos' },
  { clave: 'metricas', texto: 'Métricas', href: '/admin/metricas/' },
  { clave: 'errores', texto: 'Errores', href: '/admin/errores/' },
];

/**
 * @param {string} activa  clave de la seccion actual
 * @param {object} [opciones]
 * @param {(texto: string) => void} [opciones.alBuscar]  si se pasa, sale el buscador
 */
export function montarCabeceraAdmin(activa, { alBuscar = null } = {}) {
  document.body.classList.add('sin-navegacion', 'pagina-admin');
  let cabecera = document.querySelector('.adm-cabecera');
  if (!cabecera) {
    cabecera = el('header', { clase: 'adm-cabecera' });
    document.body.prepend(cabecera);
  }

  const buscador = alBuscar ? el('input', {
    clase: 'adm-buscar',
    attrs: { type: 'search', placeholder: 'Buscar piloto o clan', 'aria-label': 'Buscar piloto o clan', autocomplete: 'off' },
    on: { input: (e) => alBuscar(e.target.value) },
  }) : null;

  reemplazar(cabecera, [
    el('a', { clase: 'logo adm-logo', attrs: { href: '/', 'aria-label': 'bicifastness' } }, [
      anilloLogo(24), el('span', { clase: 'logo-palabra', texto: 'bicifastness' }),
    ]),
    el('span', { clase: 'adm-chip', texto: 'admin' }),
    el('nav', { clase: 'adm-nav', attrs: { 'aria-label': 'Administración' } }, SECCIONES.map((s) => el('a', {
      attrs: { href: s.href, 'aria-current': s.clave === activa ? 'page' : null, 'data-seccion': s.clave },
    }, [
      el('span', { texto: s.texto }),
      s.contador ? el('span', { clase: 'adm-contador oculto', attrs: { id: s.contador } }) : null,
    ]))),
    el('span', { clase: 'adm-hueco' }),
    buscador,
  ]);
  return { buscador };
}

/** Pone el numero de una seccion (y lo esconde a cero). */
export function contadorAdmin(idContador, n) {
  const nodo = document.getElementById(idContador);
  if (!nodo) return;
  nodo.textContent = String(n);
  nodo.classList.toggle('oculto', !n);
}

/** Marca la seccion activa sin repintar (las de /admin/ van por hash). */
export function marcarSeccionAdmin(activa) {
  for (const a of document.querySelectorAll('.adm-nav a')) {
    if (a.dataset.seccion === activa) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}
