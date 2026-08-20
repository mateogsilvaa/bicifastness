// Modulo de la pagina /admin/errores/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.

import { auth, db, collection, getDocs, deleteDoc, doc, onAuthStateChanged } from '/assets/js/firebase.js';
import { iniciarPagina, formatearFecha } from '/assets/js/ui.js';
import { id, el, estado, reemplazar, confirmar } from '/assets/js/dom.js';

iniciarPagina('admin');

let errores = [];

// --- CSV ---------------------------------------------------------------------

/**
 * Escapa un valor para CSV.
 *
 * Lo importante no son las comillas: es la primera linea. Un mensaje de error
 * que empiece por `=`, `+`, `-` o `@` lo interpreta Excel como FORMULA al abrir
 * el fichero, y `=cmd|'/c calc'!A1` llega a ejecutar cosas. Como el mensaje
 * puede venir de una excepcion con texto que controla un tercero, se le antepone
 * un apostrofo para que Excel lo trate como texto.
 */
function celda(valor) {
  let texto = String(valor ?? '');

  if (/^[=+\-@\t\r]/.test(texto)) texto = `'${texto}`;

  // Comillas dobles duplicadas, y el campo entero entrecomillado si lleva
  // separador, comillas o saltos de linea.
  if (/[";\n\r]/.test(texto)) texto = `"${texto.replace(/"/g, '""')}"`;
  return texto;
}

function generarCsv(filas) {
  const columnas = ['huella', 'sesiones', 'mensaje', 'pagina', 'navegador', 'version', 'ancho', 'conSesion', 'ultimaVez', 'pila'];

  const lineas = [
    columnas.join(';'),
    ...filas.map((f) => [
      f.id,
      f.sesiones || 0,
      f.mensaje || '',
      f.pagina || '',
      f.navegador || '',
      f.version || '',
      f.ancho || '',
      f.conSesion ? 'si' : 'no',
      f.visto?.toDate?.()?.toISOString() || '',
      f.pila || '',
    ].map(celda).join(';')),
  ];

  // Separador `;` y BOM UTF-8: es lo que abre Excel en español sin partir las
  // columnas ni romper los acentos.
  return `﻿${lineas.join('\r\n')}`;
}

function descargarCsv() {
  const filas = filtrados();
  if (!filas.length) {
    estado(id('mensaje'), 'No hay errores que descargar con esos filtros.');
    return;
  }

  const blob = new Blob([generarCsv(filas)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const enlace = el('a', {
    attrs: { href: url, download: `errores-${new Date().toISOString().slice(0, 10)}.csv` },
  });

  document.body.append(enlace);
  enlace.click();
  enlace.remove();
  // Sin esto el blob se queda en memoria hasta que se recarga la pagina.
  URL.revokeObjectURL(url);
}

// --- Filtros -----------------------------------------------------------------

function filtrados() {
  const version = id('filtro-version').value;
  const pagina = id('filtro-pagina').value;

  return errores.filter((e) =>
    (!version || e.version === version)
    && (!pagina || e.pagina === pagina));
}

function llenarFiltro(elemento, valores, etiqueta) {
  reemplazar(elemento, [
    el('option', { texto: etiqueta, attrs: { value: '' } }),
    ...[...new Set(valores)].filter(Boolean).sort().map((v) =>
      el('option', { texto: v, attrs: { value: v } })),
  ]);
}

// --- Pintado -----------------------------------------------------------------

async function borrar(huella, boton) {
  if (!await confirmar('Marcar este error como resuelto lo borra. Si vuelve a pasar, reaparece.')) return;

  boton.disabled = true;
  try {
    await deleteDoc(doc(db, 'errores_cliente', huella));
    errores = errores.filter((e) => e.id !== huella);
    pintar();
  } catch (error) {
    boton.disabled = false;
    estado(id('mensaje'), `No se ha podido borrar: ${error.message}`, 'error');
  }
}

function pintar() {
  const filas = filtrados()
    .sort((a, b) => (b.sesiones || 0) - (a.sesiones || 0));

  if (!filas.length) {
    reemplazar(id('lista'), el('div', { clase: 'vacio' }, [
      el('h3', { texto: 'Ningun error registrado' }),
      el('p', { texto: 'Es una buena noticia, pero comprueba que la recogida esta desplegada.' }),
    ]));
    return;
  }

  // Sin innerHTML: aqui se pinta texto que ha escrito un tercero (el mensaje de
  // la excepcion). Es exactamente como se colo el XSS de la v1, y ademas en
  // esta misma pantalla.
  reemplazar(id('lista'), filas.map((e) => el('div', { clase: 'bloque' }, [
    el('div', { clase: 'fila separada' }, [
      el('span', { clase: 'chip rechazado', texto: `${e.sesiones || 0} sesiones` }),
      el('span', { clase: 'menor apagado', texto: e.visto?.toDate ? formatearFecha(e.visto.toDate()) : '' }),
    ]),

    el('p', { clase: 'nombre', texto: e.mensaje || '(sin mensaje)', estilo: { margin: 'var(--e3) 0' } }),

    el('div', { clase: 'fila', estilo: { flexWrap: 'wrap', gap: 'var(--e4)' } }, [
      el('span', { clase: 'clan', texto: e.pagina || '?' }),
      el('span', { clase: 'clan', texto: e.navegador || '?' }),
      el('span', { clase: 'clan', texto: `v${e.version || '?'}` }),
      el('span', { clase: 'clan', texto: `${e.ancho || '?'} px` }),
      el('span', { clase: 'clan', texto: e.conSesion ? 'con sesion' : 'sin sesion' }),
    ]),

    e.pila
      ? el('details', { estilo: { marginTop: 'var(--e3)' } }, [
        el('summary', { clase: 'menor apagado', texto: 'Ver la pila' }),
        el('pre', {
          clase: 'menor',
          texto: String(e.pila).split('|').join('\n'),
          estilo: { whiteSpace: 'pre-wrap', overflowX: 'auto', margin: 'var(--e2) 0 0' },
        }),
      ])
      : null,

    el('button', {
      clase: 'btn plano',
      texto: 'Marcar como resuelto',
      attrs: { type: 'button' },
      on: { click: (evento) => borrar(e.id, evento.currentTarget) },
    }),
  ])));
}

// --- Carga -------------------------------------------------------------------

id('btn-csv').addEventListener('click', descargarCsv);
id('filtro-version').addEventListener('change', pintar);
id('filtro-pagina').addEventListener('change', pintar);

onAuthStateChanged(auth, async (usuario) => {
  if (!usuario) {
    estado(id('mensaje'), 'Necesitas iniciar sesion como administrador.', 'error');
    return;
  }

  try {
    const snap = await getDocs(collection(db, 'errores_cliente'));
    errores = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    llenarFiltro(id('filtro-version'), errores.map((e) => e.version), 'Todas');
    llenarFiltro(id('filtro-pagina'), errores.map((e) => e.pagina), 'Todas');
    pintar();
  } catch (error) {
    console.debug('No se han podido cargar los errores', error);
    estado(id('mensaje'),
      error.code === 'permission-denied'
        ? 'Esta pantalla es solo para administradores.'
        : 'No se han podido cargar los errores.',
      'error');
  }
});
