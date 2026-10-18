/**
 * Las piezas con las que se crea y se edita un clan (16 Clanes, 16b-16e y
 * 16i): las tres pestañas del escudo (Forma, Colores, Emblema) y los campos de
 * la ficha (fondo del mapa, lema, barrio y presentacion).
 *
 * Todas trabajan sobre el mismo objeto `elegido` y avisan con `cambio()` cada
 * vez que algo se mueve, para que quien las use repinte lo que haga falta.
 * Toda miniatura se pinta con la seleccion actual: se elige viendo.
 * Lo que se guarda lo vuelven a mirar las reglas (firestore.rules, `clanes`).
 */

import { el, icono, reemplazar } from '/assets/js/dom.js';
import {
  escudoClan, inicialesDe, lemaSeguro, contienePalabrasProhibidas,
  EMBLEMAS, FORMAS, PATRONES, COLORES_CLAN, COLORES_PRINCIPALES, MAX_LEMA, MAX_PRESENTACION, MAX_ZONA,
} from '/assets/js/escudo-clan.js';
import { mapaClan, TEMAS } from '/assets/js/mapa-clan.js';

export const MAX_NOMBRE = 24;
const NEGRO = '#111110';
const BLANCO = '#FFFFFF';

/** Lo que lleva un clan que no ha elegido nada. */
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

/** Un radio con aspecto de tarjeta (forma, reparto, emblema). */
function radio({ elegido, etiqueta, alElegir, hijos }) {
  return el('button', {
    clase: 'opcion-escudo',
    attrs: { type: 'button', role: 'radio', 'aria-checked': String(elegido), 'aria-label': etiqueta, title: etiqueta },
    on: { click: alElegir },
  }, hijos);
}

/** Un circulo de color. `bloqueado` lleva el aviso de que lo usa un vecino. */
function muestra({ hex, elegido, etiqueta, alElegir, bloqueado = false, ninguno = false }) {
  return el('button', {
    clase: `muestra-color${ninguno ? ' ninguno' : ''}`,
    estilo: ninguno ? {} : { background: hex },
    attrs: {
      type: 'button', role: 'radio', 'aria-checked': String(elegido), 'aria-label': etiqueta,
      'aria-disabled': bloqueado ? 'true' : null,
    },
    on: { click: () => { if (!bloqueado) alElegir(); } },
  }, [ninguno ? icono('cerrar', 'icono') : null, bloqueado ? el('span', { clase: 'candado-color', attrs: { 'aria-hidden': 'true' } }) : null]);
}

/**
 * Las tres pestañas del escudo.
 *
 * @param {object} elegido  lo que se va eligiendo (se modifica en el sitio)
 * @param {Function} cambio  se llama tras cada cambio
 * @param {object} [o]
 * @param {() => string} [o.nombre]  el nombre del clan, para las iniciales
 * @param {Map<string,string>} [o.vecinos]  color -> nombre del clan vecino que lo lleva
 * @param {'segmentado'|'chips'} [o.estilo]  pestañas (crear) o chips (editar, 16i)
 * @returns {{barra: HTMLElement, paneles: HTMLElement, repintar: Function, ver: Function}}
 */
export function pestanasEscudo(elegido, cambio, { nombre = () => '', vecinos = new Map(), estilo = 'segmentado' } = {}) {
  const PESTANAS = [['forma', 'Forma'], ['colores', 'Colores'], ['emblema', 'Emblema']];
  let actual = 'forma';
  const botones = {};
  const barra = el('div', {
    clase: estilo === 'chips' ? 'chips-clan' : 'segmentado',
    attrs: { role: 'tablist', 'aria-label': 'Partes del escudo' },
  }, PESTANAS.map(([clave, texto]) => {
    botones[clave] = el('button', { texto, attrs: { type: 'button', role: 'tab' }, on: { click: () => ver(clave) } });
    return botones[clave];
  }));
  const paneles = el('div', { clase: 'paneles-escudo' });

  const mini = (extra = {}) => escudoClan({ ...elegido, nombre: nombre(), siglas: elegido.siglas || null, ...extra });

  const pintores = {
    forma: () => el('div', { clase: 'rejilla-formas', attrs: { role: 'radiogroup', 'aria-label': 'Forma' } },
      Object.entries(FORMAS).map(([clave, { nombre: titulo }]) => radio({
        elegido: elegido.forma === clave, etiqueta: titulo,
        alElegir: () => { elegido.forma = clave; pintar(); },
        // Al crear, la forma sola (16b); al editar, con lo que ya lleva (16i).
        hijos: [estilo === 'chips' ? mini({ forma: clave }) : mini({ forma: clave, emblema: null, siglas: null, nombre: '' }), el('span', { texto: titulo })],
      }))),

    colores: () => {
      const principales = Object.keys(COLORES_PRINCIPALES);
      const vecino = principales.find((c) => vecinos.has(c));
      const segundos = [null, NEGRO, BLANCO, ...principales.filter((c) => c !== elegido.color).slice(0, 5)];
      const conSegundo = Boolean(elegido.color2);
      return el('div', { clase: 'panel-colores' }, [
        el('div', { clase: 'opciones-titulo' }, [el('span', { texto: 'Color del clan' }), el('small', { texto: 'el del mapa' })]),
        el('div', { clase: 'rejilla-colores', attrs: { role: 'radiogroup', 'aria-label': 'Color del clan' } }, principales.map((hex) => muestra({
          hex, elegido: elegido.color === hex, bloqueado: vecinos.has(hex),
          etiqueta: vecinos.has(hex) ? `${COLORES_PRINCIPALES[hex]}, lo lleva ${vecinos.get(hex)}` : COLORES_PRINCIPALES[hex],
          alElegir: () => {
            elegido.color = hex;
            if (elegido.color2 === hex) elegido.color2 = NEGRO;
            pintar();
          },
        }))),
        vecino ? el('p', { clase: 'opciones-nota', texto: `El ${COLORES_PRINCIPALES[vecino]} lo lleva ${vecinos.get(vecino)}, vecino tuyo.` }) : null,
        el('div', { clase: 'opciones-titulo' }, [el('span', { texto: 'Segundo color' })]),
        el('div', { clase: 'rejilla-colores', attrs: { role: 'radiogroup', 'aria-label': 'Segundo color' } }, segundos.map((hex) => muestra({
          hex, ninguno: !hex, elegido: (elegido.color2 || null) === hex,
          etiqueta: !hex ? 'Ninguno' : hex === NEGRO ? 'Negro' : hex === BLANCO ? 'Blanco' : COLORES_PRINCIPALES[hex],
          alElegir: () => {
            elegido.color2 = hex;
            elegido.patron = hex ? (elegido.patron || 'diagonal') : null;
            pintar();
          },
        }))),
        el('div', { clase: 'opciones-titulo' }, [el('span', { texto: 'Reparto' })]),
        el('div', {
          clase: 'rejilla-patrones', attrs: { role: 'radiogroup', 'aria-label': 'Reparto', 'aria-disabled': conSegundo ? null : 'true' },
        }, Object.entries(PATRONES).map(([clave, { nombre: titulo }]) => radio({
          elegido: conSegundo && elegido.patron === clave, etiqueta: titulo,
          alElegir: () => { elegido.patron = clave; elegido.color2 ||= NEGRO; pintar(); },
          hijos: [mini({ patron: clave, color2: elegido.color2 || NEGRO, emblema: null, siglas: null, nombre: '' }), el('span', { texto: titulo })],
        }))),
      ]);
    },

    // La primera casilla son las siglas: elegirla quita el emblema (16d).
    emblema: () => el('div', { clase: 'rejilla-emblemas', attrs: { role: 'radiogroup', 'aria-label': 'Emblema' } }, [
      radio({
        elegido: !elegido.emblema, etiqueta: 'Siglas',
        alElegir: () => { elegido.emblema = null; pintar(); },
        hijos: [mini({ emblema: null })],
      }),
      ...Object.entries(EMBLEMAS).map(([clave, { nombre: titulo }]) => radio({
        elegido: elegido.emblema === clave, etiqueta: titulo,
        alElegir: () => { elegido.emblema = clave; pintar(); },
        hijos: [mini({ emblema: clave })],
      })),
    ]),
  };

  function pintar() {
    reemplazar(paneles, pintores[actual]());
    cambio();
  }
  function ver(clave) {
    actual = clave;
    for (const [k, b] of Object.entries(botones)) b.setAttribute('aria-selected', String(k === clave));
    pintar();
  }
  ver('forma');
  return { barra, paneles, repintar: pintar, ver };
}

/** Un campo de texto con su contador dentro, a la derecha (16e). */
export function campoTexto({ etiqueta, valor = '', tope, placeholder = '', largo = false, alEscribir, id = null }) {
  const entrada = el(largo ? 'textarea' : 'input', {
    attrs: { id, type: largo ? null : 'text', maxlength: String(tope), placeholder, autocomplete: 'off', rows: largo ? '3' : null },
  });
  entrada.value = valor;
  const cuenta = el('small', { clase: 'contador', texto: `${valor.length}/${tope}` });
  entrada.addEventListener('input', () => {
    alEscribir(entrada.value);
    cuenta.textContent = `${entrada.value.length}/${tope}`;
  });
  const campo = el('label', { clase: 'campo-clan' }, [
    el('span', { clase: 'etiqueta', texto: etiqueta }),
    el('span', { clase: `caja${largo ? ' larga' : ''}` }, [entrada, cuenta]),
  ]);
  campo.entrada = entrada;
  return campo;
}

/**
 * Los campos de la ficha (16e): fondo del mapa con dos miniaturas del mapa
 * real, lema, barrio y presentacion.
 *
 * @param {object} [o]
 * @param {() => object} [o.mapa]  las estaciones que se pintan ({suyas, foco, vecinas})
 * @param {boolean} [o.plegar]  la presentacion bajo "Añadir presentación" (crear, en el movil)
 * @param {boolean} [o.siglas]  con el campo de siglas (editar: al crear van en el paso 1)
 */
export function camposFicha(elegido, cambio, { mapa = () => ({}), plegar = false, siglas = false } = {}) {
  const temas = el('div', { clase: 'rejilla-temas', attrs: { role: 'radiogroup', 'aria-label': 'Fondo del mapa' } });
  const pintarTemas = () => reemplazar(temas, Object.entries(TEMAS).map(([clave, { nombre }]) => el('button', {
    clase: 'opcion-tema',
    attrs: { type: 'button', role: 'radio', 'aria-checked': String(elegido.tema === clave), 'aria-label': `Fondo ${nombre.toLowerCase()}` },
    on: { click: () => { elegido.tema = clave; pintarTemas(); cambio(); } },
  }, [
    el('span', { clase: 'miniatura-mapa' }, [mapaClan({ color: elegido.color, tema: clave, ...mapa(), ancho: 170 })]),
    el('span', { clase: 'nombre-tema', texto: nombre }),
  ])));
  pintarTemas();

  const presentacion = campoTexto({
    etiqueta: 'Presentación', valor: elegido.presentacion, tope: MAX_PRESENTACION, largo: true,
    placeholder: 'Cuándo salís, por dónde, a quién queréis dentro…', alEscribir: (v) => { elegido.presentacion = v; cambio(); },
  });

  let campoSiglas = null;
  if (siglas) {
    campoSiglas = campoTexto({
      etiqueta: 'Siglas', valor: elegido.siglas, tope: 3, alEscribir: (v) => {
        const limpio = v.toUpperCase().replace(/[^A-Z0-9ÑÁÉÍÓÚ]/g, '').slice(0, 3);
        if (limpio !== v) campoSiglas.entrada.value = limpio;
        elegido.siglas = limpio;
        cambio();
      },
    });
  }

  const raiz = el('div', { clase: 'campos-ficha' }, [
    el('span', { clase: 'etiqueta-suelta', texto: 'Fondo del mapa' }),
    temas,
    campoTexto({ etiqueta: 'Lema', valor: elegido.descripcion, tope: MAX_LEMA, placeholder: 'Una frase que os defina', alEscribir: (v) => { elegido.descripcion = v; cambio(); } }),
    el('div', { clase: 'campos-dos' }, [
      campoTexto({ etiqueta: 'Barrio', valor: elegido.zona, tope: MAX_ZONA, placeholder: 'Chamberí', alEscribir: (v) => { elegido.zona = v; cambio(); } }),
      campoSiglas,
    ]),
    plegar
      ? el('details', { clase: 'plegable-presentacion', attrs: { open: elegido.presentacion ? '' : null } }, [
        el('summary', {}, [icono('mas', 'icono'), el('span', { texto: 'Añadir presentación' })]),
        presentacion,
      ])
      : presentacion,
  ]);
  // El color puede cambiar en otra pestaña: las miniaturas del mapa, con el.
  raiz.repintar = pintarTemas;
  return raiz;
}

/** Las siglas que se proponen al escribir el nombre (16a). */
export const siglasDe = (nombre) => inicialesDe(nombre).replace(/[^A-Z0-9ÑÁÉÍÓÚ]/g, '').slice(0, 3);

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
