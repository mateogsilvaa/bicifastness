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

/** Icono de Flaticon. Se genera aparte porque no lleva contenido. */
export function icono(clases, estilo = {}) {
  return el('i', { clase: clases, estilo });
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
  const colores = { info: 'var(--primary)', error: '#ff4444', exito: '#00C851', aviso: '#ffbb33' };
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
      estilo: { background: peligroso ? '#ff4444' : 'var(--primary)', flex: '1' },
      on: { click: () => { cerrar(); resolver(true); } },
    });
    const cancelar = el('button', {
      texto: 'Cancelar',
      estilo: { background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-main)', flex: '1' },
      on: { click: () => { cerrar(); resolver(false); } },
    });

    const caja = el('div', {
      attrs: { role: 'alertdialog', 'aria-modal': 'true' },
      estilo: {
        background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '16px',
        padding: '24px', maxWidth: '420px', width: '90%', boxShadow: '0 20px 50px rgba(0,0,0,.4)',
      },
    }, [
      el('p', { texto: mensaje, estilo: { margin: '0 0 20px', lineHeight: '1.5' } }),
      el('div', { estilo: { display: 'flex', gap: '10px' } }, [cancelar, aceptar]),
    ]);

    const fondo = el('div', {
      estilo: {
        position: 'fixed', inset: '0', background: 'rgba(0,0,0,.75)', zIndex: '10000',
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
