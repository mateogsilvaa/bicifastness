/**
 * Construccion segura de interfaz.
 *
 * El agujero mas grave que tenia el panel de admin era esto:
 *
 *   grid.innerHTML += `<div>Email: ${data.email_real}</div>
 *                      <img onclick="verFoto('${data.foto_url}')">`;
 *
 * Como `email_real` y `foto_url` los controlaba quien subia el viaje, bastaba
 * con registrarse con un nombre preparado para ejecutar JavaScript DENTRO de la
 * sesion del administrador. Desde ahi se leia la API key de Gemini y se hacia
 * cualquier cosa con permisos de admin.
 *
 * Este modulo elimina la clase entera del problema: aqui no se concatena HTML.
 * Todo el texto entra por textContent, que nunca interpreta marcado, y los
 * eventos se enganchan con addEventListener en vez de con atributos onclick.
 */

/**
 * Crea un elemento.
 * @param {string} etiqueta
 * @param {object} props  clase, texto, atributos (attrs), estilos y eventos (on)
 * @param {Array}  hijos
 */
export function el(etiqueta, props = {}, hijos = []) {
  const nodo = document.createElement(etiqueta);

  if (props.clase) nodo.className = props.clase;
  // texto, nunca HTML: aqui muere el XSS.
  if (props.texto !== undefined) nodo.textContent = String(props.texto);
  if (props.titulo !== undefined) nodo.title = String(props.titulo);

  for (const [nombre, valor] of Object.entries(props.attrs || {})) {
    if (valor === null || valor === undefined || valor === false) continue;
    nodo.setAttribute(nombre, String(valor));
  }

  Object.assign(nodo.style, props.estilo || {});

  for (const [evento, manejador] of Object.entries(props.on || {})) {
    nodo.addEventListener(evento, manejador);
  }

  for (const hijo of [].concat(hijos)) {
    if (hijo === null || hijo === undefined || hijo === false) continue;
    nodo.append(hijo instanceof Node ? hijo : document.createTextNode(String(hijo)));
  }

  return nodo;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/**
 * Icono del sprite propio (`assets/img/iconos.svg`).
 *
 * Va aparte de `el()` porque un <svg> NO se crea con `createElement`: hay que
 * usar `createElementNS`, o el navegador construye un elemento HTML llamado
 * "svg" que no pinta nada. El fallo es silencioso, que es lo peor que tiene.
 *
 * El <svg> siempre `aria-hidden`: si el icono es la unica etiqueta de un
 * control, es el CONTROL el que necesita `aria-label`.
 *
 * @param {string} nombre  id del simbolo, sin la almohadilla
 * @param {string} [clase]
 */
export function icono(nombre, clase = 'icono') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', clase);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const uso = document.createElementNS(SVG_NS, 'use');
  const destino = `/assets/img/iconos.svg#${nombre}`;
  uso.setAttribute('href', destino);
  // Safari por debajo de la 16 ignora `href` a secas en <use>.
  uso.setAttributeNS(XLINK_NS, 'xlink:href', destino);

  svg.append(uso);
  return svg;
}

/**
 * Imagen con origen validado.
 * Solo se admiten https:, data:image/ y blob:. Bloquea `javascript:` y
 * cualquier otro esquema que pudiera venir de la base de datos.
 */
export function imagen(src, props = {}) {
  const nodo = el('img', props);
  nodo.src = urlSegura(src) || '';
  nodo.addEventListener('error', () => { nodo.style.visibility = 'hidden'; });
  return nodo;
}

/** Devuelve la URL si su esquema es seguro; si no, null. */
export function urlSegura(url) {
  const texto = String(url ?? '').trim();
  if (/^https:\/\//i.test(texto)) return texto;
  if (/^data:image\/(png|jpe?g|webp|svg\+xml);base64,/i.test(texto)) return texto;
  if (/^blob:/i.test(texto)) return texto;
  return null;
}

/** Vacia un contenedor y le mete los hijos indicados. */
export function reemplazar(contenedor, ...hijos) {
  contenedor.replaceChildren(...hijos.flat().filter(Boolean));
  return contenedor;
}

/** Atajo de document.getElementById. */
export const id = (nombre) => document.getElementById(nombre);

/** Escapado de texto para los pocos sitios donde de verdad hace falta HTML. */
export function escapar(valor) {
  return String(valor ?? '').replace(/[&<>"'/]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;', '/': '&#47;',
  }[c]));
}

/** Mensaje de estado accesible (lo anuncian los lectores de pantalla). */
export function estado(contenedor, texto, tipo = 'info') {
  const colores = { info: 'var(--azul)', error: 'var(--rojo)', exito: 'var(--verde)', aviso: 'var(--ambar)' };
  contenedor.textContent = texto;
  contenedor.style.color = colores[tipo] || colores.info;
  contenedor.setAttribute('role', tipo === 'error' ? 'alert' : 'status');
  contenedor.setAttribute('aria-live', tipo === 'error' ? 'assertive' : 'polite');
}

/** Dialogo de confirmacion accesible, sustituto de `confirm()`. */
export function confirmar(mensaje, { textoAceptar = 'Aceptar', peligroso = false } = {}) {
  return new Promise((resolver) => {
    const aceptar = el('button', {
      texto: textoAceptar,
      clase: peligroso ? 'btn-peligro' : '',
      estilo: { flex: '1', margin: '0', minWidth: '0' },
      on: { click: () => { cerrar(); resolver(true); } },
    });
    const cancelar = el('button', {
      texto: 'Cancelar',
      clase: 'btn-fantasma',
      estilo: { flex: '1', margin: '0', minWidth: '0' },
      on: { click: () => { cerrar(); resolver(false); } },
    });

    const caja = el('div', {
      attrs: { role: 'alertdialog', 'aria-modal': 'true' },
      clase: 'card',
      estilo: { maxWidth: '440px', width: '100%' },
    }, [
      el('p', { texto: mensaje, estilo: { margin: '0 0 20px', lineHeight: '1.5' } }),
      el('div', { estilo: { display: 'flex', gap: '10px' } }, [cancelar, aceptar]),
    ]);

    const fondo = el('div', {
      estilo: {
        position: 'fixed', inset: '0', background: 'rgba(4,6,10,.86)',
        backdropFilter: 'blur(4px)', zIndex: '10000',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
      },
      on: {
        click: (e) => { if (e.target === fondo) { cerrar(); resolver(false); } },
        keydown: (e) => { if (e.key === 'Escape') { cerrar(); resolver(false); } },
      },
    }, [caja]);

    function cerrar() { fondo.remove(); }
    document.body.appendChild(fondo);
    aceptar.focus();
  });
}

/**
 * Dialogo para pedir un texto. Sustituye a `window.prompt`, que en movil sale
 * como una alerta del sistema, no se puede estilar, ignora el tema oscuro y
 * algunos navegadores lo bloquean directamente.
 */
export function pedirTexto(mensaje, {
  etiqueta = '', textoAceptar = 'Enviar', multilinea = true,
  minimo = 0, exacto = null, marcador = '',
} = {}) {
  return new Promise((resolver) => {
    const campo = el(multilinea ? 'textarea' : 'input', {
      attrs: { id: 'campo-dialogo', rows: multilinea ? 4 : null, placeholder: marcador },
      estilo: { marginBottom: '4px', resize: 'vertical' },
    });

    const pista = el('p', {
      estilo: { fontSize: '.75rem', color: 'var(--tinta-3)', margin: '0 0 14px', minHeight: '18px' },
    });

    const aceptar = el('button', {
      texto: textoAceptar,
      attrs: { disabled: '' },
      estilo: { flex: '1', margin: '0', minWidth: '0' },
      on: { click: () => { cerrar(); resolver(campo.value.trim()); } },
    });

    // El boton no se habilita hasta que lo escrito cumple: asi el aviso llega
    // antes de pulsar y no despues, con un error.
    const revisar = () => {
      const valor = campo.value.trim();
      let fallo = null;
      if (exacto !== null && valor !== exacto) fallo = `Escribe exactamente: ${exacto}`;
      else if (minimo && valor.length < minimo) fallo = `Faltan ${minimo - valor.length} caracteres.`;
      pista.textContent = fallo || '';
      aceptar.disabled = Boolean(fallo) || !valor;
    };
    campo.addEventListener('input', revisar);

    const cancelar = el('button', {
      clase: 'btn-fantasma',
      texto: 'Cancelar',
      estilo: { flex: '1', margin: '0', minWidth: '0' },
      on: { click: () => { cerrar(); resolver(null); } },
    });

    const caja = el('div', {
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': mensaje },
      clase: 'card',
      estilo: { maxWidth: '460px', width: '100%' },
    }, [
      el('p', { texto: mensaje, estilo: { margin: '0 0 16px', lineHeight: '1.5' } }),
      etiqueta ? el('label', { texto: etiqueta, attrs: { for: 'campo-dialogo' } }) : null,
      campo,
      pista,
      el('div', { estilo: { display: 'flex', gap: '10px' } }, [cancelar, aceptar]),
    ]);

    const fondo = el('div', {
      estilo: {
        position: 'fixed', inset: '0', background: 'rgba(4,6,10,.86)',
        backdropFilter: 'blur(4px)', zIndex: '10000', display: 'flex',
        alignItems: 'center', justifyContent: 'center', padding: '20px',
      },
      on: {
        click: (e) => { if (e.target === fondo) { cerrar(); resolver(null); } },
        keydown: (e) => { if (e.key === 'Escape') { cerrar(); resolver(null); } },
      },
    }, [caja]);

    function cerrar() { fondo.remove(); }
    document.body.appendChild(fondo);
    campo.focus();
  });
}

/**
 * Aviso flotante. Sustituye a `alert()`, que congela la pagina entera y en
 * movil es especialmente molesto.
 */
export function avisar(mensaje, tipo = 'error') {
  const colores = { error: 'var(--rojo)', exito: 'var(--verde)', info: 'var(--azul)' };

  const nodo = el('div', {
    attrs: { role: tipo === 'error' ? 'alert' : 'status' },
    texto: mensaje,
    estilo: {
      position: 'fixed', left: '50%', bottom: 'calc(var(--alto-barra) + 16px)',
      transform: 'translateX(-50%)', zIndex: '10002', maxWidth: 'min(440px, calc(100vw - 32px))',
      background: 'var(--papel-2)', color: 'var(--tinta)',
      border: '1px solid var(--linea)', borderLeft: `3px solid ${colores[tipo] || colores.info}`,
      borderRadius: 'var(--radio)', padding: '13px 16px', fontSize: '.88rem',
      animation: 'surgir 260ms ease both',
    },
  });

  document.body.appendChild(nodo);
  setTimeout(() => {
    nodo.style.transition = 'opacity 260ms';
    nodo.style.opacity = '0';
    setTimeout(() => nodo.remove(), 280);
  }, tipo === 'error' ? 5200 : 3200);
}

/**
 * Esqueletos de carga. Dan idea de la forma de lo que viene, en vez de un
 * "Cargando..." que no dice nada y provoca un salto cuando llegan los datos.
 */
export function esqueleto(cantidad = 4, alto = 68) {
  return Array.from({ length: cantidad }, (_, i) => el('div', {
    clase: 'esqueleto',
    attrs: { 'aria-hidden': 'true' },
    estilo: { height: `${alto}px`, animationDelay: `${i * 90}ms` },
  }));
}
