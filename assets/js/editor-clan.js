/**
 * Las dos mitades de la identidad de un clan, para crearlo y para cambiarlo:
 *
 * - El escudo: forma, color, segundo color con su patron, emblema y siglas.
 * - La ficha: lema, barrio, presentacion y banner.
 *
 * Las dos trabajan sobre el mismo objeto `elegido` y avisan con `cambio()`
 * cada vez que algo se mueve, para que quien las use repinte la vista previa.
 * Lo que se guarda lo vuelven a mirar las reglas (firestore.rules, `clanes`).
 */

import { el, icono, reemplazar } from '/assets/js/dom.js';
import {
  escudoClan, svgEmblema, inicialesDe, lemaSeguro, contienePalabrasProhibidas,
  EMBLEMAS, FORMAS, PATRONES, COLORES_CLAN, MAX_LEMA, MAX_PRESENTACION, MAX_ZONA,
} from '/assets/js/escudo-clan.js';
import { BANNERS, BANNER_POR_DEFECTO, laTiene, imagenBanner } from '/assets/data/recompensas.js';

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
    banner: clan.banner || BANNER_POR_DEFECTO,
  };
}

/** Un segundo color que se distinga del primero. */
const otroColor = (c) => (c === '#111110' ? '#FFD23F' : '#111110');

/** Un grupo de opciones con su rotulo. */
const grupo = (rotulo, ...hijos) => el('div', { clase: 'editor-clan-grupo' }, [el('span', { clase: 'rotulo', texto: rotulo }), ...hijos]);

function paleta(etiqueta, actual, elegir, usados = new Set()) {
  return el('div', { clase: 'muestras-color', attrs: { role: 'radiogroup', 'aria-label': etiqueta } }, COLORES_CLAN.map((c) => el('button', {
    clase: `muestra-color ${usados.has(c) ? 'usado' : ''}`,
    estilo: { background: c },
    attrs: { type: 'button', role: 'radio', 'aria-checked': String(c === actual), 'aria-label': `${etiqueta} ${c}${usados.has(c) ? ', ya lo usa un clan cerca' : ''}` },
    on: { click: () => elegir(c) },
  })));
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
  const raiz = el('div', { clase: 'editor-clan' });
  const opciones = el('div', { clase: 'editor-clan-opciones' });

  const siglas = el('input', { attrs: { type: 'text', maxlength: '3', 'aria-label': 'Siglas (hasta 3)', autocapitalize: 'characters', autocomplete: 'off' } });
  siglas.value = elegido.siglas;
  siglas.addEventListener('input', () => {
    siglas.value = siglas.value.toUpperCase().replace(/[^A-Z0-9ÑÁÉÍÓÚ]/g, '').slice(0, 3);
    elegido.siglas = siglas.value;
    // Escribir siglas es querer verlas: se quita el emblema.
    elegido.emblema = null;
    pintar();
  });

  const muestraDe = (extra) => escudoClan({ ...elegido, nombre: nombre(), siglas: elegido.siglas || null, ...extra }, { clase: 'escudo-clan', tam: 18 });

  function pintar() {
    siglas.placeholder = inicialesDe(nombre()) || 'ABC';
    const conPatron = Boolean(elegido.patron && elegido.color2);

    reemplazar(opciones, [
      grupo('Forma', el('div', { clase: 'rejilla-formas', attrs: { role: 'radiogroup', 'aria-label': 'Forma' } }, Object.entries(FORMAS).map(([clave, { nombre: titulo }]) => el('button', {
        clase: `opcion-escudo${elegido.forma === clave ? ' elegida' : ''}`,
        attrs: { type: 'button', role: 'radio', 'aria-checked': String(elegido.forma === clave), 'aria-label': titulo, title: titulo },
        on: { click: () => { elegido.forma = clave; pintar(); } },
      }, [muestraDe({ forma: clave }), el('span', { texto: titulo })])))),

      grupo('Color', paleta('Color', elegido.color, (c) => {
        elegido.color = c;
        if (elegido.color2 === c) elegido.color2 = otroColor(c);
        pintar();
      }, usados), usados.size ? el('span', { clase: 'pista', texto: 'Los colores apagados ya los usa un clan con estaciones cerca de ti.' }) : null),

      grupo('Diseño', el('div', { clase: 'rejilla-formas', attrs: { role: 'radiogroup', 'aria-label': 'Diseño' } }, [
        el('button', {
          clase: `opcion-escudo${!conPatron ? ' elegida' : ''}`,
          attrs: { type: 'button', role: 'radio', 'aria-checked': String(!conPatron), 'aria-label': 'Liso', title: 'Liso' },
          on: { click: () => { elegido.patron = null; elegido.color2 = null; pintar(); } },
        }, [muestraDe({ patron: null }), el('span', { texto: 'Liso' })]),
        ...Object.entries(PATRONES).map(([clave, { nombre: titulo }]) => {
          const color2 = elegido.color2 || otroColor(elegido.color);
          return el('button', {
            clase: `opcion-escudo${conPatron && elegido.patron === clave ? ' elegida' : ''}`,
            attrs: { type: 'button', role: 'radio', 'aria-checked': String(conPatron && elegido.patron === clave), 'aria-label': titulo, title: titulo },
            on: { click: () => { elegido.patron = clave; elegido.color2 = color2; pintar(); } },
          }, [muestraDe({ patron: clave, color2 }), el('span', { texto: titulo })]);
        }),
      ])),

      conPatron ? grupo('Segundo color', paleta('Segundo color', elegido.color2, (c) => {
        if (c === elegido.color) return;
        elegido.color2 = c;
        pintar();
      }, new Set([elegido.color]))) : null,

      grupo('Emblema', el('div', { clase: 'rejilla-emblemas', attrs: { role: 'radiogroup', 'aria-label': 'Emblema' } }, [
        el('button', {
          clase: `emblema-opcion${!elegido.emblema ? ' elegida' : ''}`,
          texto: (elegido.siglas || inicialesDe(nombre()) || 'Aa').slice(0, 3),
          attrs: { type: 'button', role: 'radio', 'aria-checked': String(!elegido.emblema), 'aria-label': 'Siglas', title: 'Siglas' },
          on: { click: () => { elegido.emblema = null; pintar(); siglas.focus(); } },
        }),
        ...Object.entries(EMBLEMAS).map(([clave, { nombre: titulo }]) => el('button', {
          clase: `emblema-opcion${elegido.emblema === clave ? ' elegida' : ''}`,
          attrs: { type: 'button', role: 'radio', 'aria-checked': String(elegido.emblema === clave), 'aria-label': titulo, title: titulo },
          on: { click: () => { elegido.emblema = clave; pintar(); } },
        }, [svgEmblema(clave, 20)])),
      ])),
    ]);
    cambio();
  }

  raiz.append(opciones, el('label', { clase: 'campo campo-siglas' }, [
    el('span', { texto: 'Siglas' }),
    siglas,
    el('small', { clase: 'pista', texto: 'Hasta tres letras o números. Se ven cuando no hay emblema.' }),
  ]));
  pintar();
  raiz.repintar = pintar;
  return raiz;
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
  return el('label', { clase: 'campo' }, [el('span', { clase: 'campo-cabeza' }, [el('span', { texto: etiqueta }), cuenta]), entrada]);
}

/**
 * El editor de la ficha: lema, barrio, presentacion y banner. El clan puede
 * llevar los banners de serie y cualquiera que haya ganado su lider.
 *
 * @param {object} perfil  el del lider (sus recompensas y logros)
 * @param {object|null} config  `config/recompensas`
 */
export function editorFicha(elegido, cambio, { perfil = null, config = null } = {}) {
  const tiene = (clave) => laTiene(clave, perfil || {}, config);
  const banners = el('div', { clase: 'vitrina-opciones', attrs: { role: 'radiogroup', 'aria-label': 'Banner del clan' } });
  const pintarBanners = () => reemplazar(banners, Object.entries(BANNERS).filter(([clave]) => tiene(clave) || clave === elegido.banner).map(([clave, b]) => el('button', {
    clase: 'opcion-banner',
    attrs: { type: 'button', role: 'radio', 'aria-checked': String(clave === elegido.banner), 'aria-label': b.titulo },
    on: { click: () => { elegido.banner = clave; pintarBanners(); cambio(); } },
  }, [
    el('div', { clase: 'banner-piloto', attrs: { 'aria-hidden': 'true' }, estilo: { backgroundImage: `url("${imagenBanner(clave)}")` } }),
    el('span', { texto: b.titulo }),
  ])));
  pintarBanners();

  return el('div', { clase: 'editor-clan' }, [
    campoTexto({ etiqueta: 'Lema', valor: elegido.descripcion, tope: MAX_LEMA, placeholder: 'Una frase que os defina', alEscribir: (v) => { elegido.descripcion = v; cambio(); } }),
    campoTexto({ etiqueta: 'Barrio o zona', valor: elegido.zona, tope: MAX_ZONA, placeholder: 'Chamberí, Vallecas, Moncloa…', alEscribir: (v) => { elegido.zona = v; cambio(); } }),
    campoTexto({ etiqueta: 'Presentación', valor: elegido.presentacion, tope: MAX_PRESENTACION, placeholder: 'Cuándo salís, qué buscáis, a quién queréis dentro…', largo: true, alEscribir: (v) => { elegido.presentacion = v; cambio(); } }),
    grupo('Banner', banners, el('span', { clase: 'pista' }, [icono('candado', 'icono peq'), ' Los banners que gane el líder también los puede llevar el clan.'])),
  ]);
}

/**
 * Lo que se va a guardar, limpio, o el motivo por el que no se puede.
 * Las mismas comprobaciones que las reglas, para dar un mensaje que se entienda.
 */
export function identidadParaGuardar(elegido) {
  const textos = [
    ['lema', elegido.descripcion, MAX_LEMA],
    ['barrio', elegido.zona, MAX_ZONA],
    ['presentación', elegido.presentacion, MAX_PRESENTACION],
  ];
  const limpios = {};
  for (const [cual, valor, tope] of textos) {
    const limpio = lemaSeguro(valor, tope);
    if (String(valor || '').trim() && !limpio) return { error: `El ${cual === 'presentación' ? 'texto de presentación' : cual} no puede llevar enlaces.` };
    if (contienePalabrasProhibidas(limpio)) return { error: `Ese ${cual === 'presentación' ? 'texto de presentación' : cual} no se puede publicar.` };
    limpios[cual] = limpio;
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
      descripcion: limpios.lema,
      zona: limpios.barrio,
      presentacion: limpios['presentación'],
      banner: BANNERS[elegido.banner] ? elegido.banner : BANNER_POR_DEFECTO,
    },
  };
}
