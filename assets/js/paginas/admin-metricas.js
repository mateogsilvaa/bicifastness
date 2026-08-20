// Modulo de la pagina /admin/metricas/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.
//
// Lee UN documento: `agregados/metricas`. La alternativa era leer los 180
// documentos diarios cada vez que se abre el panel, que es justo el problema
// que los agregados vienen a resolver.

import { auth, db, doc, getDoc, onAuthStateChanged } from '/assets/js/firebase.js';
import { iniciarPagina } from '/assets/js/ui.js';
import { id, el, estado, reemplazar } from '/assets/js/dom.js';

iniciarPagina('admin');

const VENTANAS = [
  ['hoy', 'Hoy'],
  ['semana', '7 dias'],
  ['mes', '30 dias'],
  ['semestre', '6 meses'],
];

const FILAS = [
  ['sesiones', 'Sesiones'],
  ['paginasVistas', 'Paginas vistas'],
  ['viajesVerificados', 'Trayectos verificados'],
  ['registrosCompletados', 'Registros'],
];

let resumen = null;

// --- Pintado -----------------------------------------------------------------

/**
 * Tabla de ventanas. Las cifras van en mono tabular: sin eso, comparar una
 * columna en vertical es imposible porque los digitos bailan.
 */
function pintarVentanas(ventanas) {
  reemplazar(id('ventanas'), el('div', { clase: 'tabla-scroll' }, [
    el('table', { clase: 'tabla' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { texto: '', attrs: { scope: 'col' } }),
        ...VENTANAS.map(([, etiqueta]) =>
          el('th', { texto: etiqueta, clase: 'col-marca', attrs: { scope: 'col' } })),
      ])]),
      el('tbody', {}, FILAS.map(([clave, etiqueta]) => el('tr', {}, [
        el('th', { texto: etiqueta, attrs: { scope: 'row' }, clase: 'nombre' }),
        ...VENTANAS.map(([ventana]) => el('td', { clase: 'col-marca' }, [
          el('span', { clase: 'marca', texto: String(ventanas[ventana]?.[clave] ?? 0) }),
        ])),
      ]))),
    ]),
  ]));
}

/**
 * Embudo. Se ensena el porcentaje que SOBREVIVE cada paso, no el total, porque
 * lo que se busca es donde esta la caida grande.
 */
function pintarEmbudo(ventana) {
  const pasos = [
    ['subidasAbiertas', 'Abre subir'],
    ['subidasEnviadas', 'Envia el trayecto'],
    ['viajesVerificados', 'Queda verificado'],
  ];

  const primero = ventana?.[pasos[0][0]] || 0;

  if (!primero) {
    reemplazar(id('embudo'), el('div', { clase: 'vacio' }, [
      el('h3', { texto: 'Sin datos todavia' }),
      el('p', { texto: 'Apareceran cuando alguien abra la pantalla de subir.' }),
    ]));
    return;
  }

  reemplazar(id('embudo'), pasos.map(([clave, etiqueta], i) => {
    const valor = ventana[clave] || 0;
    const porcentaje = Math.round((valor / primero) * 100);
    const anterior = i === 0 ? valor : (ventana[pasos[i - 1][0]] || 0);
    const caida = anterior ? Math.round(((anterior - valor) / anterior) * 100) : 0;

    return el('div', { clase: 'bloque' }, [
      el('div', { clase: 'fila separada' }, [
        el('span', { clase: 'nombre', texto: etiqueta }),
        el('span', { clase: 'marca', texto: `${valor}` }),
      ]),
      el('p', {
        clase: 'menor apagado',
        estilo: { margin: 'var(--e2) 0 0' },
        texto: i === 0
          ? '100% — punto de partida'
          : `${porcentaje}% del total · se cae el ${caida}% en este paso`,
      }),
    ]);
  }));
}

function pintarCohortes(cohortes) {
  if (!cohortes?.length) {
    reemplazar(id('cohortes'), el('div', { clase: 'vacio' }, [
      el('h3', { texto: 'Sin cohortes todavia' }),
      el('p', { texto: 'Hace falta al menos una semana de altas.' }),
    ]));
    return;
  }

  const pct = (parte, total) => (total ? `${Math.round((parte / total) * 100)}%` : '—');

  reemplazar(id('cohortes'), el('div', { clase: 'tabla-scroll' }, [
    el('table', { clase: 'tabla' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { texto: 'Semana', attrs: { scope: 'col' } }),
        el('th', { texto: 'Altas', clase: 'col-marca', attrs: { scope: 'col' } }),
        ...['1 dia', '7 dias', '14 dias', '30 dias'].map((t) =>
          el('th', { texto: t, clase: 'col-marca', attrs: { scope: 'col' } })),
      ])]),
      el('tbody', {}, cohortes.map((c) => el('tr', {}, [
        el('th', { texto: c.semana, attrs: { scope: 'row' }, clase: 'clan' }),
        el('td', { clase: 'col-marca' }, [el('span', { clase: 'marca', texto: String(c.total) })]),
        ...['d1', 'd7', 'd14', 'd30'].map((d) =>
          el('td', { clase: 'col-marca' }, [
            el('span', { clase: 'marca', texto: pct(c[d], c.total) }),
          ])),
      ]))),
    ]),
  ]));
}

// --- CSV ---------------------------------------------------------------------

/** Mismo escapado que en la pagina de errores: Excel ejecuta formulas. */
function celda(valor) {
  let texto = String(valor ?? '');
  if (/^[=+\-@\t\r]/.test(texto)) texto = `'${texto}`;
  if (/[";\n\r]/.test(texto)) texto = `"${texto.replace(/"/g, '""')}"`;
  return texto;
}

function descargarCsv() {
  if (!resumen) return;

  const lineas = [['seccion', 'clave', 'ventana', 'valor'].join(';')];

  for (const [ventana] of VENTANAS) {
    for (const [clave] of FILAS) {
      lineas.push(['uso', clave, ventana, resumen.ventanas?.[ventana]?.[clave] ?? 0].map(celda).join(';'));
    }
  }

  for (const c of resumen.cohortes || []) {
    for (const d of ['total', 'd1', 'd7', 'd14', 'd30']) {
      lineas.push(['cohorte', d, c.semana, c[d] ?? 0].map(celda).join(';'));
    }
  }

  const blob = new Blob([`﻿${lineas.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const enlace = el('a', {
    attrs: { href: url, download: `metricas-${new Date().toISOString().slice(0, 10)}.csv` },
  });

  document.body.append(enlace);
  enlace.click();
  enlace.remove();
  URL.revokeObjectURL(url);
}

// --- Carga -------------------------------------------------------------------

id('btn-csv').addEventListener('click', descargarCsv);

onAuthStateChanged(auth, async (usuario) => {
  if (!usuario) {
    estado(id('mensaje'), 'Necesitas iniciar sesion como administrador.', 'error');
    return;
  }

  try {
    const snap = await getDoc(doc(db, 'agregados', 'metricas'));

    if (!snap.exists()) {
      estado(id('mensaje'),
        'Todavia no hay metricas. Las genera el worker en su primera pasada.');
      return;
    }

    resumen = snap.data();

    const marca = resumen.actualizado?.toDate?.();
    if (marca) {
      id('actualizado').textContent = `Actualizado ${marca.toLocaleString('es-ES')}`;
    }

    pintarVentanas(resumen.ventanas || {});
    // El embudo se mira sobre 30 dias: en un dia suelto hay demasiado poco
    // volumen para que los porcentajes signifiquen algo.
    pintarEmbudo(resumen.ventanas?.mes || {});
    pintarCohortes(resumen.cohortes);
  } catch (error) {
    console.debug('No se han podido cargar las metricas', error);
    estado(id('mensaje'),
      error.code === 'permission-denied'
        ? 'Esta pantalla es solo para administradores.'
        : 'No se han podido cargar las metricas.',
      'error');
  }
});
