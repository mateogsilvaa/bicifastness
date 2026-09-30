// Modulo de la pagina /bici/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.

import {
  auth, db, onAuthStateChanged, collection, query, where, orderBy, limit, getDocs,
} from '/assets/js/firebase.js';
import { iniciarPagina, nombreEstacion, nombreRuta } from '/assets/js/ui.js';
import { id, el, icono, reemplazar, abrirHoja } from '/assets/js/dom.js';
import {
  NOMBRE_FALLO, normalizarBici, mostrarBici, cifra, leerFicha, haceTiempo,
  buscadas, recordarBuscada, estrellas, notaDeFicha,
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


function valoracion(v) {
  const fecha = haceTiempo(v.cuando);
  const desde = v.estacion ? nombreEstacion(v.estacion) || v.estacion : null;
  return el('li', { clase: 'bici-opinion' }, [
    estrellas(v.nota, { tam: 16 }),
    el('div', { clase: 'bici-opinion-texto' }, [
      v.comentario ? el('p', { texto: v.comentario }) : null,
      (v.fallos || []).length
        ? el('div', { clase: 'bici-etiquetas' }, v.fallos.map((f) => el('span', { texto: NOMBRE_FALLO[f] || f })))
        : null,
      el('small', { texto: [fechaCorta(v.cuando), fecha, desde ? `desde ${desde}` : null].filter(Boolean).join(' · ') }),
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

/** "29 sept." */
function fechaCorta(ms) {
  if (!ms) return null;
  return new Date(ms).toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'short' });
}

/**
 * La ficha: nota en estrellas con las reseñas al lado, lo que esta roto AHORA
 * (lo que tres reseñas seguidas ya no mencionan se da por arreglado, en el
 * worker), las tres ultimas reseñas con su fecha y, debajo, todas.
 */
function pintarFicha(n, ficha) {
  document.querySelector('.bici-pagina').classList.add('con-ficha');
  const ultimas = ficha?.ultimas || [];
  const cuenta = ultimas.length ? Math.max(ficha?.valoraciones60 || 0, ultimas.length) : 0;
  const vista = ficha?.vista;
  const nota = notaDeFicha(ficha);
  const rotos = ficha?.fallos || [];
  const arreglados = ficha?.resueltos || [];

  const cabeza = el('div', { clase: 'bici-ficha-cabeza' }, [
    el('span', { clase: 'bici-rotulo', texto: 'Bici' }),
    el('h2', { clase: 'bici-numero', texto: mostrarBici(n) }),
    el('div', { clase: 'bici-estrellas' }, nota != null
      ? [estrellas(nota, { tam: 22 }), el('strong', { texto: cifra(nota) }), el('span', { texto: `(${cuenta} ${cuenta === 1 ? 'reseña' : 'reseñas'})` })]
      : [estrellas(0, { tam: 22 }), el('span', { texto: '(sin reseñas)' })]),
    vista?.estacion
      ? el('p', { clase: 'bici-vista' }, [
        'Vista por última vez en ',
        el('strong', { texto: nombreEstacion(vista.estacion) || vista.estacion }),
        `, ${haceTiempo(vista.cuando)}`,
      ])
      : null,
  ]);

  const valorar = el('button', {
    clase: 'btn grande', attrs: { type: 'button' }, on: { click: () => valorarSinViaje(n) },
  }, [icono('mas', 'icono'), 'Valorar esta bici']);

  const roto = rotos.length
    ? el('div', { clase: 'bloque bici-roto', attrs: { role: 'status' } }, [
      icono('aviso', 'icono'),
      el('div', {}, [
        el('strong', { texto: 'Avisan de que tiene algo roto' }),
        el('div', { clase: 'bici-etiquetas' }, rotos.map((f) => el('span', { texto: `${NOMBRE_FALLO[f.codigo] || f.codigo} · ${f.veces}` }))),
      ]),
    ])
    : el('div', { clase: 'bloque bici-bien' }, [
      icono('comprobado', 'icono'),
      el('span', {
        texto: arreglados.length
          ? `Sin averías ahora. ${arreglados.map((c) => NOMBRE_FALLO[c] || c).join(', ')}: arreglado según las últimas reseñas.`
          : 'Nadie ha avisado de averías.',
      }),
    ]);

  if (!ultimas.length) {
    reemplazar(destino, [
      cabeza,
      el('div', { clase: 'vacio' }, [
        el('h3', { texto: `Nadie ha valorado la ${mostrarBici(n)} todavía` }),
        el('p', { texto: 'Si la has usado, sé el primero: sube la captura de ese trayecto y ponle estrellas.' }),
      ]),
      valorar,
    ]);
    return;
  }

  reemplazar(destino, [
    cabeza,
    roto,
    el('div', { clase: 'bici-seccion' }, [el('h3', { texto: 'Últimas reseñas' })]),
    el('ul', { clase: 'bici-opiniones' }, ultimas.slice(0, 3).map(valoracion)),
    valorar,
    ultimas.length > 3
      ? el('details', { clase: 'bici-todas' }, [
        el('summary', { texto: `Ver las ${ultimas.length} reseñas` }),
        listaValoraciones(ultimas),
      ])
      : null,
    el('p', { clase: 'bici-nota-pie', texto: 'Las reseñas las hacen otros pilotos y son orientativas. Para una avería, avisa también a BiciMAD desde su app.' }),
  ]);
}

/**
 * Valorar sin subir un viaje: hace falta la captura del trayecto en que se uso
 * (para no opinar de una bici que no has cogido). Se lee aqui mismo: tiene que
 * salir el numero de ESTA bici y no tener mas de un mes. El worker lo vuelve a
 * comprobar con la captura antes de contarla.
 */
async function valorarSinViaje(n) {
  if (!auth.currentUser) { window.location.href = '/entrar/'; return; }
  const entrada = el('input', { attrs: { type: 'file', accept: 'image/*', hidden: '' } });
  const estadoTxt = el('p', { clase: 'encuesta-pista', attrs: { 'aria-live': 'polite' } });
  const cuerpo = el('div', { clase: 'valorar-bici' }, [
    el('h2', { texto: `Valorar la ${mostrarBici(n)}` }),
    el('p', { texto: 'Sube la captura del trayecto en el que la usaste (de la app de BiciMAD). No cuenta como viaje: solo demuestra que la has cogido.' }),
    el('button', { clase: 'btn grande', attrs: { type: 'button' }, on: { click: () => entrada.click() } }, [icono('imagen', 'icono'), 'Elegir captura']),
    estadoTxt,
    entrada,
  ]);
  abrirHoja(cuerpo, { etiqueta: 'Valorar esta bici', clase: 'dialogo-escritorio' });

  entrada.addEventListener('change', async () => {
    const fichero = entrada.files?.[0];
    if (!fichero) return;
    estadoTxt.classList.remove('error');
    estadoTxt.textContent = 'Leyendo la captura…';
    const [{ extraer, cerrar: soltarLector }, { comprimir }, { encuestaBici }, { diaMadridHace }] = await Promise.all([
      import('/assets/js/extraccion.js'), import('/assets/js/precheck.js'),
      import('/assets/js/encuesta-bici.js'), import('/assets/js/dia.js'),
    ]);
    const url = URL.createObjectURL(fichero);
    const img = new Image();
    img.src = url;
    // Si no decodifica, extraer() devuelve { disponible: false } y se dice abajo.
    await img.decode().catch(() => null);
    const lectura = await extraer(img, (_, a) => { estadoTxt.textContent = `Leyendo la captura… ${Math.round(a * 100)} %`; });
    soltarLector();
    URL.revokeObjectURL(url);
    const mal = (texto) => { estadoTxt.textContent = texto; estadoTxt.classList.add('error'); entrada.value = ''; };
    if (!lectura.disponible) { mal('No hemos podido leer la captura. Prueba con la original, sin recortar.'); return; }
    const leida = normalizarBici(lectura.numeroBici);
    if (!leida) { mal('En esta captura no se lee el número de la bici. Tiene que ser la del trayecto, con el número arriba.'); return; }
    if (leida !== n) { mal(`Esta captura es de la bici ${mostrarBici(leida)}, no de la ${mostrarBici(n)}.`); return; }
    if (lectura.fecha && lectura.fecha < diaMadridHace(30)) { mal('Esa captura tiene más de un mes. Solo cuentan los trayectos recientes.'); return; }
    const comprimida = await comprimir(fichero).catch(() => null);
    if (!comprimida?.dataUrl) { mal('No se ha podido preparar la imagen. Prueba con otra.'); return; }
    reemplazar(cuerpo, encuestaBici({ bici: n, captura: comprimida.dataUrl, estacionLeida: lectura.origen || '' }));
  });
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
    media != null ? el('span', { clase: 'bici-fila-nota' }, [estrellas(media, { tam: 14 }), el('small', { texto: cifra(media) })]) : el('small', { clase: 'bici-pocos', texto: 'Sin reseñas' }),
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
