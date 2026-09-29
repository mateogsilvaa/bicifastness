// Modulo de la pagina /bici/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.

import {
  auth, db, onAuthStateChanged, collection, query, where, orderBy, limit, getDocs,
} from '/assets/js/firebase.js';
import { iniciarPagina, nombreEstacion, nombreRuta } from '/assets/js/ui.js';
import { id, el, icono, reemplazar } from '/assets/js/dom.js';
import {
  NOMBRE_FALLO, normalizarBici, mostrarBici, tonoNota, cifra, leerFicha, haceTiempo,
  buscadas, recordarBuscada,
} from '/assets/js/bicis.js';

iniciarPagina('territorio');

/**
 * 11 · Bicis: el buscador. Una lectura por bici buscada (`bicis/{n}`), que es
 * publica y anonima. "Las que has usado" sale de tus propios viajes, que ya se
 * pueden leer, y "Buscadas" vive solo en este navegador.
 */

const campo = id('numero-bici');
const pista = id('pista-bici');
const destino = id('bici-ficha');
const POR_PAGINA = 10;

document.querySelector('.bici-atras')?.append(icono('atras'));
id('form-bici').prepend(icono('buscar'));

const PISTA = 'Cuatro cifras, en la pegatina del guardabarros trasero.';

function estadoInicial() {
  document.querySelector('.bici-pagina').classList.remove('con-ficha');
  reemplazar(destino, el('div', { clase: 'vacio bici-inicial' }, [
    el('span', { clase: 'bici-inicial-numero', texto: '0000', attrs: { 'aria-hidden': 'true' } }),
    el('h2', { texto: 'Escribe el número de una bici' }),
    el('p', { texto: `${PISTA} Verás su nota media y lo que han contado otros pilotos antes de cogerla.` }),
  ]));
}

function pastilla(v, { grande = false } = {}) {
  return el('span', { clase: `nota-pastilla ${tonoNota(v)}${grande ? ' grande' : ''}`, texto: typeof v === 'number' && !Number.isInteger(v) ? cifra(v) : String(v) });
}

function valoracion(v) {
  const fecha = haceTiempo(v.cuando);
  const desde = v.estacion ? nombreEstacion(v.estacion) || v.estacion : null;
  return el('li', { clase: 'bici-opinion' }, [
    pastilla(v.nota),
    el('div', { clase: 'bici-opinion-texto' }, [
      v.comentario ? el('p', { texto: v.comentario }) : null,
      (v.fallos || []).length
        ? el('div', { clase: 'bici-etiquetas' }, v.fallos.map((f) => el('span', { texto: NOMBRE_FALLO[f] || f })))
        : null,
      el('small', { texto: [fecha, desde ? `desde ${desde}` : null].filter(Boolean).join(' · ') }),
    ]),
  ]);
}

/** Todas las valoraciones, de 10 en 10, con filtro (11g). */
function listaValoraciones(ultimas) {
  const filtros = [
    ['todas', `Todas · ${ultimas.length}`, () => true],
    ['comentario', `Con comentario · ${ultimas.filter((v) => v.comentario).length}`, (v) => v.comentario],
    ['bajas', '1–2', (v) => v.nota <= 2],
  ];
  let filtro = 'todas';
  let mostradas = POR_PAGINA;
  const caja = el('div');

  const pintar = () => {
    const [, , fn] = filtros.find(([k]) => k === filtro);
    const lista = ultimas.filter(fn);
    reemplazar(caja, [
      el('div', { clase: 'chips-bici', attrs: { role: 'group', 'aria-label': 'Filtrar valoraciones' } }, filtros.map(([k, texto]) => el('button', {
        clase: 'chip-filtro', texto, attrs: { type: 'button', 'aria-pressed': String(filtro === k) },
        on: { click: () => { filtro = k; mostradas = POR_PAGINA; pintar(); } },
      }))),
      lista.length
        ? el('ul', { clase: 'bici-opiniones' }, lista.slice(0, mostradas).map(valoracion))
        : el('p', { clase: 'bici-nota-pie', texto: 'Ninguna con este filtro.' }),
      lista.length > mostradas
        ? el('button', { clase: 'btn plano', texto: `Ver ${Math.min(POR_PAGINA, lista.length - mostradas)} más`, attrs: { type: 'button' }, on: { click: () => { mostradas += POR_PAGINA; pintar(); } } })
        : null,
    ]);
  };
  pintar();
  return caja;
}

function pintarFicha(n, ficha) {
  document.querySelector('.bici-pagina').classList.add('con-ficha');
  const ultimas = ficha?.ultimas || [];
  const cuenta = ficha?.valoraciones60 || 0;
  const vista = ficha?.vista;

  const cabeza = el('div', { clase: 'bici-ficha-cabeza' }, [
    el('span', { clase: 'bici-rotulo', texto: 'Bici' }),
    el('h2', { clase: 'bici-numero', texto: mostrarBici(n) }),
    vista?.estacion
      ? el('p', { clase: 'bici-vista' }, [
        'Vista por última vez en ',
        el('strong', { texto: nombreEstacion(vista.estacion) || vista.estacion }),
        `, ${haceTiempo(vista.cuando)}`,
      ])
      : null,
  ]);

  // Sin ninguna valoracion: invitacion a ser el primero (11e).
  if (!ultimas.length) {
    reemplazar(destino, [
      cabeza,
      el('div', { clase: 'vacio' }, [
        el('h3', { texto: `Nadie ha valorado la ${mostrarBici(n)} todavía` }),
        el('p', { texto: 'Si la usas, al subir el trayecto podrás ser el primero.' }),
      ]),
    ]);
    return;
  }

  const hayMedia = ficha.media != null;
  const reparto = ficha.reparto || {};
  const maxReparto = Math.max(1, ...Object.values(reparto));
  const tendencia = ficha.tendencia && ficha.tendencia.direccion !== 'igual'
    ? ` · ${ficha.tendencia.direccion} (${cifra(ficha.tendencia.antes)} hace un mes)`
    : '';

  reemplazar(destino, [
    cabeza,
    hayMedia
      ? el('div', { clase: 'bloque bici-media' }, [
        el('div', { clase: 'bici-media-cifra' }, [
          pastilla(ficha.media, { grande: true }),
          el('div', {}, [
            el('strong', { texto: 'de 5' }),
            el('span', { texto: `${cuenta} valoraciones · 60 días${tendencia}` }),
          ]),
        ]),
        el('div', { clase: 'bici-reparto', attrs: { 'aria-label': 'Reparto de notas' } }, [5, 4, 3, 2, 1].map((v) => el('div', { clase: 'bici-barra' }, [
          el('span', { texto: String(v) }),
          el('i', { clase: tonoNota(v) }, [el('b', { estilo: { width: `${((reparto[v] || 0) / maxReparto) * 100}%` } })]),
          el('small', { texto: String(reparto[v] || 0) }),
        ]))),
      ])
      : el('div', { clase: 'bloque bici-pocas' }, [
        el('strong', { texto: `${ultimas.length} ${ultimas.length === 1 ? 'valoración' : 'valoraciones'}` }),
        el('p', { texto: 'Aún no hay suficientes para una nota media. Estas son las que hay:' }),
      ]),
    hayMedia && (ficha.fallos || []).length
      ? el('div', { clase: 'bloque' }, [
        el('div', { clase: 'bici-seccion' }, [el('h3', { texto: 'Lo que más se repite' }), el('span', { texto: '60 días' })]),
        ...ficha.fallos.map((f) => el('div', { clase: 'bici-fallo' }, [
          el('span', { texto: NOMBRE_FALLO[f.codigo] || f.codigo }),
          el('i', {}, [el('b', { estilo: { width: `${(f.veces / Math.max(1, cuenta)) * 100}%` } })]),
          el('small', { texto: `${f.veces} de ${cuenta}` }),
        ])),
      ])
      : null,
    el('div', { clase: 'bici-seccion' }, [el('h3', { texto: hayMedia ? 'Últimas valoraciones' : 'Valoraciones' })]),
    hayMedia ? listaValoraciones(ultimas) : el('ul', { clase: 'bici-opiniones' }, ultimas.map(valoracion)),
    el('p', { clase: 'bici-nota-pie', texto: 'Las valoraciones las hacen otros pilotos y son orientativas. Para una avería, avisa también a BiciMAD desde su app.' }),
  ]);
}

let pedida = 0;
async function buscar(valor, { apuntar = true } = {}) {
  const n = normalizarBici(valor);
  if (!n) {
    pista.textContent = String(valor || '').length >= 3 ? 'No conocemos ninguna bici con ese número.' : PISTA;
    pista.classList.toggle('error', String(valor || '').length >= 3);
    if (!valor) estadoInicial();
    return;
  }
  pista.textContent = '';
  pista.classList.remove('error');
  const mia = ++pedida;
  reemplazar(destino, el('div', { clase: 'esqueleto', estilo: { height: '320px' } }));
  let ficha = null;
  try {
    ficha = await leerFicha(n);
  } catch {
    if (mia === pedida) reemplazar(destino, el('div', { clase: 'vacio', texto: 'No se ha podido cargar. Prueba otra vez en un momento.' }));
    return;
  }
  if (mia !== pedida) return;
  pintarFicha(n, ficha);
  recordarBuscada(n, ficha?.media ?? null);
  pintarRecientes();
  if (apuntar) {
    const url = new URL(window.location.href);
    url.searchParams.set('n', n);
    history.replaceState(null, '', url);
  }
}

// --- Buscadas y usadas -----------------------------------------------------------

let usadas = [];

function fila({ n, texto, detalle, media }) {
  return el('li', {}, [el('a', { clase: 'bici-fila', attrs: { href: `/bici/?n=${n}` }, on: { click: (e) => { e.preventDefault(); campo.value = mostrarBici(n); buscar(n); } } }, [
    el('strong', { texto: mostrarBici(n) }),
    el('span', { clase: 'bici-fila-texto' }, [texto ? el('span', { texto }) : null, detalle ? el('small', { texto: detalle }) : null]),
    media != null ? pastilla(media) : el('small', { clase: 'bici-pocos', texto: 'Pocos datos' }),
  ])]);
}

function pintarRecientes() {
  const lista = buscadas();
  reemplazar(id('bici-recientes'), [
    lista.length ? el('h2', { clase: 'bici-subtitulo', texto: 'Buscadas' }) : null,
    lista.length ? el('ul', { clase: 'bici-lista' }, lista.map((b) => fila({ n: b.n, media: b.media }))) : null,
    usadas.length ? el('h2', { clase: 'bici-subtitulo', texto: 'Las que has usado' }) : null,
    usadas.length ? el('ul', { clase: 'bici-lista' }, usadas.map(fila)) : null,
  ]);
}

async function cargarUsadas(uid) {
  try {
    const [viajes, notas] = await Promise.all([
      getDocs(query(collection(db, 'tiempos_viaje'), where('uid', '==', uid), orderBy('creado', 'desc'), limit(30))),
      getDocs(query(collection(db, 'valoraciones_bici'), where('uid', '==', uid), orderBy('creado', 'desc'), limit(30))),
    ]);
    const miNota = {};
    for (const d of notas.docs) if (!(d.data().bici in miNota)) miNota[d.data().bici] = d.data().nota;
    const vistas = new Set();
    const lista = [];
    for (const d of viajes.docs) {
      const v = d.data();
      const n = normalizarBici(v.numeroBici);
      if (!n || vistas.has(n)) continue;
      vistas.add(n);
      const cuando = v.creado?.toDate?.();
      lista.push({
        n,
        texto: [cuando ? haceTiempo(cuando.getTime()) : null, nombreRuta(v.ruta)].filter(Boolean).join(' · '),
        detalle: n in miNota ? `Tu nota: ${miNota[n]}` : 'Sin valorar',
        media: null,
      });
      if (lista.length >= 5) break;
    }
    // La media de cada una: una lectura por bici, cinco como mucho.
    await Promise.all(lista.map(async (u) => { u.media = (await leerFicha(u.n).catch(() => null))?.media ?? null; }));
    usadas = lista;
    pintarRecientes();
  } catch {
    // Sin indice o sin red: la lista es un extra, el buscador sigue.
  }
}

// --- Arranque --------------------------------------------------------------------

id('form-bici').addEventListener('submit', (e) => { e.preventDefault(); buscar(campo.value); });
let espera = null;
campo.addEventListener('input', () => {
  const limpio = campo.value.replace(/\D/g, '');
  if (limpio !== campo.value) campo.value = limpio;
  clearTimeout(espera);
  // Con cuatro cifras ya se busca; con menos, se espera a que termine de escribir.
  espera = setTimeout(() => buscar(campo.value), limpio.length >= 4 ? 0 : 700);
});

const inicial = new URLSearchParams(window.location.search).get('n');
pista.textContent = PISTA;
pintarRecientes();
if (inicial) {
  campo.value = mostrarBici(normalizarBici(inicial) || inicial);
  buscar(inicial, { apuntar: false });
} else {
  estadoInicial();
  campo.focus();
}

onAuthStateChanged(auth, (u) => { if (u) cargarUsadas(u.uid); });
