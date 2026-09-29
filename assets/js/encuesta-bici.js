/**
 * 11a / 11b / 11f / 11h · "¿Qué tal la bici?", en la pantalla de Subido.
 *
 * Nunca bloquea: va debajo del mensaje, con "Saltar", y si no se responde no
 * pasa nada ni se vuelve a pedir para ese trayecto. Un toque en la nota ya
 * guarda; los fallos y el comentario son opcionales y se mandan con "Enviar".
 *
 * El numero llega leido de la captura si el lector lo encontro; si no, se
 * escribe. Solo se comprueba el formato: no hay lista publica de la flota.
 */

import { el, reemplazar } from './dom.js';
import {
  FALLOS, NOTAS, normalizarBici, mostrarBici, tonoNota, cifra,
  guardarValoracion, miValoracionDeHoy, leerFicha, MINIMO_PARA_MEDIA,
} from './bicis.js';

/**
 * @param {{bici?: string, viajeId: string, ruta: string}} viaje
 * @returns {HTMLElement}
 */
export function encuestaBici({ bici = '', viajeId, ruta }) {
  const estacion = String(ruta || '').split('-')[0];
  const estado = {
    bici: normalizarBici(bici),
    leida: Boolean(normalizarBici(bici)),
    editando: !normalizarBici(bici),
    nota: null,
    fallos: new Set(),
    comentario: '',
    guardando: false,
    error: '',
  };

  const tarjeta = el('section', { clase: 'encuesta-bici', attrs: { 'aria-labelledby': 'encuesta-titulo' } });

  const guardar = async () => {
    if (!estado.bici || !estado.nota) return false;
    estado.guardando = true;
    try {
      await guardarValoracion({
        bici: estado.bici, nota: estado.nota, fallos: [...estado.fallos],
        comentario: estado.comentario, viajeId, estacion,
      });
      estado.error = '';
      return true;
    } catch {
      estado.error = 'No se ha podido guardar. Vuelve a intentarlo.';
      pintar();
      return false;
    } finally {
      estado.guardando = false;
    }
  };

  const cerrar = () => {
    document.removeEventListener('keydown', teclas);
    tarjeta.remove();
  };

  // 11f: teclas 1–5 dan la nota; Intro envia. Solo con el foco fuera de un campo.
  function teclas(evento) {
    if (!tarjeta.isConnected) { document.removeEventListener('keydown', teclas); return; }
    const foco = document.activeElement?.tagName;
    if (foco === 'INPUT' || foco === 'TEXTAREA' || evento.ctrlKey || evento.metaKey || evento.altKey) return;
    if (/^[1-5]$/.test(evento.key) && estado.bici && !estado.editando) {
      evento.preventDefault();
      elegirNota(Number(evento.key));
    } else if (evento.key === 'Enter' && estado.nota) {
      evento.preventDefault();
      enviar();
    }
  }
  document.addEventListener('keydown', teclas);

  async function elegirNota(n) {
    estado.nota = n;
    pintar();
    await guardar(); // un toque ya guarda
  }

  async function enviar() {
    if (estado.guardando) return;
    if (await guardar()) pintarEnviada();
  }

  async function pintarEnviada() {
    document.removeEventListener('keydown', teclas);
    const n = estado.bici;
    const linea = el('p', { clase: 'encuesta-media', texto: 'Tu valoración ya está guardada.' });
    reemplazar(tarjeta, el('div', { clase: 'encuesta-hecha' }, [
      el('span', { clase: `nota-pastilla ${tonoNota(estado.nota)}`, texto: String(estado.nota) }),
      el('div', { clase: 'encuesta-hecha-texto' }, [
        el('strong', { texto: `Gracias. Bici ${mostrarBici(n)}: ${estado.nota} de 5` }),
        linea,
      ]),
      el('a', { clase: 'enlace-fuerte', texto: 'Ver ficha', attrs: { href: `/bici/?n=${encodeURIComponent(n)}` } }),
    ]));
    const ficha = await leerFicha(n).catch(() => null);
    if (ficha?.media != null && ficha.valoraciones60 >= MINIMO_PARA_MEDIA) {
      linea.textContent = `Su media es ${cifra(ficha.media)} con ${ficha.valoraciones60} valoraciones. La tuya contará en unos minutos.`;
    } else {
      linea.textContent = 'Eres de los primeros en valorarla: su nota saldrá con unas pocas más.';
    }
  }

  function campoNumero() {
    const entrada = el('input', {
      attrs: {
        id: 'encuesta-numero', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '5',
        autocomplete: 'off', placeholder: '2400', 'aria-describedby': 'encuesta-pista',
        value: estado.bici ? mostrarBici(estado.bici) : '',
      },
    });
    const pista = el('p', { clase: 'encuesta-pista', attrs: { id: 'encuesta-pista' } });
    const revisar = (definitivo) => {
      const valor = entrada.value.replace(/\D/g, '');
      if (valor !== entrada.value) entrada.value = valor;
      const n = normalizarBici(valor);
      const mal = valor.length >= 3 && !n;
      entrada.setAttribute('aria-invalid', String(mal));
      pista.textContent = mal
        ? 'No conocemos ninguna bici con ese número.'
        : 'Está en la pegatina del guardabarros trasero y en el historial de la app de BiciMAD.';
      pista.classList.toggle('error', mal);
      if (definitivo && n) {
        estado.bici = n;
        estado.leida = false;
        estado.editando = false;
        pintar();
      }
    };
    entrada.addEventListener('input', () => revisar(false));
    entrada.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); revisar(true); } });
    entrada.addEventListener('change', () => revisar(true));
    revisar(false);
    return el('div', { clase: 'encuesta-numero' }, [
      el('label', { texto: 'Número de la bici', attrs: { for: 'encuesta-numero' } }),
      entrada,
      pista,
    ]);
  }

  function pintar() {
    const sinNumero = !estado.bici || estado.editando;
    reemplazar(tarjeta, [
      el('div', { clase: 'encuesta-cabeza' }, [
        el('div', {}, [
          el('h3', { texto: '¿Qué tal la bici?', attrs: { id: 'encuesta-titulo' } }),
          el('p', { texto: 'Ayuda a otros a saber qué bici coger. Es anónimo.' }),
        ]),
        el('button', { clase: 'btn plano pequeno', texto: 'Saltar', attrs: { type: 'button' }, on: { click: cerrar } }),
      ]),
      sinNumero
        ? campoNumero()
        : el('div', { clase: 'encuesta-bici-fila' }, [
          el('span', { clase: 'encuesta-rotulo', texto: 'Bici' }),
          el('strong', { clase: 'encuesta-numero-leido', texto: mostrarBici(estado.bici) }),
          el('span', { clase: 'encuesta-origen', texto: estado.leida ? 'leída de la captura' : 'escrita a mano' }),
          el('button', {
            clase: 'enlace-fuerte', texto: 'Cambiar', attrs: { type: 'button' },
            on: { click: () => { estado.editando = true; pintar(); tarjeta.querySelector('input')?.focus(); } },
          }),
        ]),
      el('div', { clase: 'encuesta-notas', attrs: { role: 'radiogroup', 'aria-label': 'Nota de la bici' } },
        NOTAS.map((texto, i) => {
          const v = i + 1;
          return el('button', {
            clase: 'encuesta-nota',
            attrs: {
              type: 'button', role: 'radio', 'aria-checked': String(estado.nota === v),
              disabled: sinNumero ? '' : null, title: `${v} · ${texto}`,
            },
            on: { click: () => elegirNota(v) },
          }, [el('strong', { texto: String(v) }), el('span', { texto: texto })]);
        })),
      el('div', { clase: 'encuesta-fallos' }, [
        el('p', { clase: 'encuesta-rotulo' }, ['¿Algo no iba bien? ', el('span', { texto: '(opcional)' })]),
        el('div', { clase: 'encuesta-chips' }, FALLOS.map(([codigo, nombre]) => el('button', {
          clase: 'chip-filtro',
          attrs: { type: 'button', 'aria-pressed': String(estado.fallos.has(codigo)), disabled: sinNumero ? '' : null },
          texto: nombre,
          on: {
            click: (e) => {
              if (estado.fallos.has(codigo)) estado.fallos.delete(codigo);
              else estado.fallos.add(codigo);
              e.currentTarget.setAttribute('aria-pressed', String(estado.fallos.has(codigo)));
            },
          },
        }))),
      ]),
      (() => {
        const area = el('textarea', {
          attrs: { rows: 2, maxlength: '280', placeholder: 'Añade un comentario (opcional)', 'aria-label': 'Comentario', disabled: sinNumero ? '' : null },
        });
        area.value = estado.comentario;
        area.addEventListener('input', () => { estado.comentario = area.value; });
        return area;
      })(),
      estado.error ? el('p', { clase: 'encuesta-pista error', texto: estado.error }) : null,
      el('div', { clase: 'encuesta-enviar' }, [
        el('button', {
          clase: 'btn', texto: 'Enviar valoración',
          attrs: { type: 'button', disabled: estado.nota && !sinNumero ? null : '' },
          on: { click: enviar },
        }),
        el('span', { clase: 'encuesta-tecla', texto: 'Intro para enviar' }),
      ]),
    ]);
  }

  // 11h: si ya la valoro hoy, se dice y se deja cambiar.
  async function empezar() {
    pintar();
    if (!estado.bici) return;
    const previa = await miValoracionDeHoy(estado.bici);
    if (!previa || !tarjeta.isConnected) return;
    reemplazar(tarjeta, el('div', { clase: 'encuesta-hecha' }, [
      el('span', { clase: `nota-pastilla ${tonoNota(previa.nota)}`, texto: String(previa.nota) }),
      el('div', { clase: 'encuesta-hecha-texto' }, [
        el('strong', { texto: `Ya valoraste la ${mostrarBici(estado.bici)} hoy.` }),
        el('p', { clase: 'encuesta-media', texto: 'Puedes cambiar tu nota hasta medianoche.' }),
      ]),
      el('button', {
        clase: 'enlace-fuerte', texto: 'Cambiar', attrs: { type: 'button' },
        on: {
          click: () => {
            estado.nota = previa.nota;
            estado.fallos = new Set(previa.fallos || []);
            estado.comentario = previa.comentario || '';
            pintar();
          },
        },
      }),
    ]));
  }

  empezar();
  return tarjeta;
}

