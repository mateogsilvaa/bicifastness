/**
 * Las dos mitades de la identidad de un clan, para crearlo y para cambiarlo:
 *
 * - El escudo: forma, color, segundo color con su patron, emblema o siglas.
 * - La ficha: lema, barrio, presentacion y el fondo de su mapa (claro u
 *   oscuro). El "banner" de un clan no se elige: es su territorio
 *   (mapa-clan.js).
 *
 * Las dos trabajan sobre el mismo objeto `elegido` y avisan con `cambio()`
 * cada vez que algo se mueve, para que quien las use repinte la vista previa.
 * Lo que se guarda lo vuelven a mirar las reglas (firestore.rules, `clanes`).
 */

import { el, reemplazar } from '/assets/js/dom.js';
import {
  escudoClan, svgEmblema, inicialesDe, lemaSeguro, contienePalabrasProhibidas,
  EMBLEMAS, FORMAS, PATRONES, COLORES_CLAN, MAX_LEMA, MAX_PRESENTACION, MAX_ZONA,
} from '/assets/js/escudo-clan.js';
import { mapaClan, TEMAS } from '/assets/js/mapa-clan.js';

/** Lo que lleva un clan que no ha elegido nada: el de siempre. */
export function identidadInicial(clan = {}, color = COLORES_CLAN[0]) {
  return {
    color: clan.color || color,
    color2: clan.color2 || null,
    patron: clan.patron || null,
    forma: clan.forma || 'cuadro',
    emblema: clan.emblema || null,
    siglas: clan.siglas || '',
    descripcion: clan.descripcion || '',
    zona: clan.zona || '',
    presentacion: clan.presentacion || '',
    tema: TEMAS[clan.tema] ? clan.tema : 'oscuro',
  };
}

/** Un segundo color que se distinga del primero. */
const otroColor = (c) => (c === '#111110' ? '#FFD23F' : '#111110');

/** Un bloque del editor: titulo arriba y lo que se elige debajo. */
const bloque = (titulo, ...hijos) => el('section', { clase: 'editor-bloque' }, [el('h3', { texto: titulo }), ...hijos]);

function paleta(etiqueta, actual, elegir, { usados = new Set(), fuera = null } = {}) {
  return el('div', { clase: 'paleta-clan', attrs: { role: 'radiogroup', 'aria-label': etiqueta } }, COLORES_CLAN.map((c) => el('button', {
    clase: `muestra-color${usados.has(c) ? ' usado' : ''}`,
    estilo: { background: c },
    attrs: {
      type: 'button', role: 'radio', 'aria-checked': String(c === actual), disabled: c === fuera ? '' : null,
      'aria-label': `${etiqueta} ${c}${usados.has(c) ? ', ya lo usa un clan cerca' : ''}`,
    },
    on: { click: () => elegir(c) },
  })));
}

/** Un boton de una rejilla de opciones (forma, diseño). */
function opcion({ elegida, titulo, alElegir, muestra, rotulo = true }) {
  return el('button', {
    clase: `opcion-escudo${elegida ? ' elegida' : ''}`,
    attrs: { type: 'button', role: 'radio', 'aria-checked': String(elegida), 'aria-label': titulo, title: titulo },
    on: { click: alElegir },
  }, [muestra, rotulo ? el('span', { texto: titulo }) : null]);
}

/**
 * El editor del escudo.
 *
 * @param {object} elegido  lo que se va eligiendo (se modifica en el sitio)
 * @param {Function} cambio  se llama tras cada cambio
 * @param {object} [o]
 * @param {() => string} [o.nombre]  el nombre del clan, para las iniciales
 * @param {Set<string>} [o.usados]  colores de clanes cerca
 */
export function editorEscudo(elegido, cambio, { nombre = () => '', usados = new Set() } = {}) {
  // Lo que se repinta en cada cambio va en su caja; las siglas no, para no
  // perder el foco mientras se escriben.
  const formas = el('div', { clase: 'rejilla-formas', attrs: { role: 'radiogroup', 'aria-label': 'Forma' } });
  const colores = el('div');
  const disenos = el('div', { clase: 'subbloque-diseno' });
  const emblemas = el('div', { clase: 'rejilla-emblemas', attrs: { role: 'radiogroup', 'aria-label': 'Emblema' } });

  const siglas = el('input', { attrs: { type: 'text', maxlength: '3', 'aria-label': 'Siglas, hasta tres', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false' } });
  siglas.value = elegido.siglas;
  siglas.addEventListener('input', () => {
    siglas.value = siglas.value.toUpperCase().replace(/[^A-Z0-9ÑÁÉÍÓÚ]/g, '').slice(0, 3);
    elegido.siglas = siglas.value;
    // Escribir siglas es querer verlas: se quita el emblema.
    elegido.emblema = null;
    pintar();
  });
  const muestraSiglas = el('span', { clase: 'emblema-opcion siglas', attrs: { 'aria-hidden': 'true' } });
  const filaSiglas = el('div', { clase: 'opcion-siglas', attrs: { role: 'radio', tabindex: '0', 'aria-label': 'Siglas en vez de emblema' } }, [
    muestraSiglas,
    el('span', { clase: 'textos' }, [el('strong', { texto: 'Siglas' }), el('small', { texto: 'En vez de emblema. Hasta tres.' })]),
    siglas,
  ]);
  const elegirSiglas = () => { elegido.emblema = null; pintar(); };
  filaSiglas.addEventListener('click', (ev) => { if (ev.target !== siglas) { elegirSiglas(); siglas.focus(); } });
  filaSiglas.addEventListener('keydown', (ev) => { if (ev.target === filaSiglas && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); elegirSiglas(); } });

  const opciones = el('div', { clase: 'editor-clan' }, [
    bloque('Forma', formas),
    bloque('Color', colores),
    bloque('Diseño', disenos),
    bloque('Emblema', filaSiglas, emblemas),
  ]);

  const mini = (extra) => escudoClan({ ...elegido, nombre: nombre(), siglas: elegido.siglas || null, ...extra }, { clase: 'escudo-clan', tam: 16 });

  function pintar() {
    const iniciales = elegido.siglas || inicialesDe(nombre()) || 'ABC';
    siglas.placeholder = inicialesDe(nombre()) || 'ABC';
    const conPatron = Boolean(elegido.patron && elegido.color2);
    const color2 = elegido.color2 || otroColor(elegido.color);

    reemplazar(formas, Object.entries(FORMAS).map(([clave, { nombre: titulo }]) => opcion({
      elegida: elegido.forma === clave, titulo, muestra: mini({ forma: clave, emblema: null, siglas: null, nombre: '' }),
      alElegir: () => { elegido.forma = clave; pintar(); },
    })));

    reemplazar(colores, [
      paleta('Color', elegido.color, (c) => {
        elegido.color = c;
        if (elegido.color2 === c) elegido.color2 = otroColor(c);
        pintar();
      }, { usados }),
      usados.size ? el('p', { clase: 'pista-editor', texto: 'Los colores apagados ya los usa un clan con estaciones cerca de ti.' }) : null,
    ]);

    reemplazar(disenos, [
      el('div', { clase: 'rejilla-disenos', attrs: { role: 'radiogroup', 'aria-label': 'Diseño' } }, [
        opcion({
          elegida: !conPatron, titulo: 'Liso', rotulo: false, muestra: mini({ patron: null, emblema: null, siglas: null, nombre: '' }),
          alElegir: () => { elegido.patron = null; elegido.color2 = null; pintar(); },
        }),
        ...Object.entries(PATRONES).map(([clave, { nombre: titulo }]) => opcion({
          elegida: conPatron && elegido.patron === clave, titulo, rotulo: false,
          muestra: mini({ patron: clave, color2, emblema: null, siglas: null, nombre: '' }),
          alElegir: () => { elegido.patron = clave; elegido.color2 = color2; pintar(); },
        })),
      ]),
      conPatron ? el('div', { clase: 'subbloque' }, [
        el('span', { clase: 'rotulo-editor', texto: 'Segundo color' }),
        paleta('Segundo color', elegido.color2, (c) => { elegido.color2 = c; pintar(); }, { fuera: elegido.color }),
      ]) : null,
    ]);

    muestraSiglas.textContent = iniciales.slice(0, 3);
    filaSiglas.classList.toggle('elegida', !elegido.emblema);
    filaSiglas.setAttribute('aria-checked', String(!elegido.emblema));
    reemplazar(emblemas, Object.entries(EMBLEMAS).map(([clave, { nombre: titulo }]) => el('button', {
      clase: `emblema-opcion${elegido.emblema === clave ? ' elegida' : ''}`,
      attrs: { type: 'button', role: 'radio', 'aria-checked': String(elegido.emblema === clave), 'aria-label': titulo, title: titulo },
      on: { click: () => { elegido.emblema = clave; pintar(); } },
    }, [svgEmblema(clave, 20)])));
    cambio();
  }

  pintar();
  opciones.repintar = pintar;
  return opciones;
}

/** Un campo de texto con su contador. */
function campoTexto({ etiqueta, valor, tope, placeholder, largo = false, alEscribir }) {
  const entrada = el(largo ? 'textarea' : 'input', {
    attrs: { type: largo ? null : 'text', maxlength: String(tope), placeholder, autocomplete: 'off', rows: largo ? '3' : null },
  });
  entrada.value = valor;
  const cuenta = el('small', { clase: 'contador', texto: `${valor.length}/${tope}` });
  entrada.addEventListener('input', () => {
    cuenta.textContent = `${entrada.value.length}/${tope}`;
    alEscribir(entrada.value);
  });
  return el('label', { clase: 'campo-clan' }, [el('span', { clase: 'campo-cabeza' }, [el('span', { texto: etiqueta }), cuenta]), entrada]);
}

/**
 * El editor de la ficha: lema, barrio, presentacion y el fondo del mapa.
 *
 * @param {object} [o]
 * @param {() => object} [o.mapa]  las estaciones que se pintan en el mapa ({suyas, foco})
 */
export function editorFicha(elegido, cambio, { mapa = () => ({}) } = {}) {
  const temas = el('div', { clase: 'rejilla-temas', attrs: { role: 'radiogroup', 'aria-label': 'Fondo del mapa' } });
  const pintarTemas = () => reemplazar(temas, Object.entries(TEMAS).map(([clave, { nombre }]) => el('button', {
    clase: `opcion-tema${elegido.tema === clave ? ' elegida' : ''}`,
    attrs: { type: 'button', role: 'radio', 'aria-checked': String(elegido.tema === clave), 'aria-label': `Mapa ${nombre.toLowerCase()}` },
    on: { click: () => { elegido.tema = clave; pintarTemas(); cambio(); } },
  }, [mapaClan({ color: elegido.color, tema: clave, ...mapa() }), el('span', { texto: nombre })])));
  pintarTemas();

  const raiz = el('div', { clase: 'editor-clan' }, [
    bloque('Presentación',
      campoTexto({ etiqueta: 'Lema', valor: elegido.descripcion, tope: MAX_LEMA, placeholder: 'Una frase que os defina', alEscribir: (v) => { elegido.descripcion = v; cambio(); } }),
      campoTexto({ etiqueta: 'Barrio o zona', valor: elegido.zona, tope: MAX_ZONA, placeholder: 'Chamberí, Vallecas, Moncloa…', alEscribir: (v) => { elegido.zona = v; cambio(); } }),
      campoTexto({ etiqueta: 'Sobre el clan', valor: elegido.presentacion, tope: MAX_PRESENTACION, placeholder: 'Cuándo salís, qué buscáis, a quién queréis dentro…', largo: true, alEscribir: (v) => { elegido.presentacion = v; cambio(); } })),
    bloque('Fondo del mapa',
      temas,
      el('p', { clase: 'pista-editor', texto: 'Arriba de la ficha va vuestro trozo de Madrid: las estaciones que controláis, en vuestro color.' })),
  ]);
  // El color puede haber cambiado en la otra pestaña o el otro paso.
  raiz.repintar = pintarTemas;
  return raiz;
}

/**
 * Lo que se va a guardar, limpio, o el motivo por el que no se puede.
 * Las mismas comprobaciones que las reglas, para dar un mensaje que se entienda.
 */
export function identidadParaGuardar(elegido) {
  const textos = [
    ['el lema', elegido.descripcion, MAX_LEMA, 'descripcion'],
    ['el barrio', elegido.zona, MAX_ZONA, 'zona'],
    ['la presentación', elegido.presentacion, MAX_PRESENTACION, 'presentacion'],
  ];
  const limpios = {};
  for (const [cual, valor, tope, campo] of textos) {
    const limpio = lemaSeguro(valor, tope);
    if (String(valor || '').trim() && !limpio) return { error: `En ${cual} no puede haber enlaces.` };
    if (contienePalabrasProhibidas(limpio)) return { error: `Hay algo en ${cual} que no se puede publicar.` };
    limpios[campo] = limpio;
  }
  const conPatron = Boolean(elegido.patron && elegido.color2 && elegido.color2 !== elegido.color);
  return {
    datos: {
      color: elegido.color,
      color2: conPatron ? elegido.color2 : null,
      patron: conPatron ? elegido.patron : null,
      forma: FORMAS[elegido.forma] ? elegido.forma : 'cuadro',
      emblema: EMBLEMAS[elegido.emblema] ? elegido.emblema : null,
      siglas: /^[A-Z0-9ÑÁÉÍÓÚ]{1,3}$/.test(elegido.siglas || '') ? elegido.siglas : null,
      ...limpios,
      tema: TEMAS[elegido.tema] ? elegido.tema : 'oscuro',
    },
  };
}
