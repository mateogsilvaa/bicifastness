/**
 * El detalle de un trayecto ya resuelto (03 Subir · 3e, 3k, 3l y 3m; en
 * escritorio, el dialogo de 8h).
 *
 *   - Verificado: el momento que engancha. Pantalla azul, los puntos contando
 *     de 0 al total y el desglose apareciendo fila a fila.
 *   - Lo mira una persona: por que, sin cifras del antifraude, y que no hace
 *     falta hacer nada.
 *   - No cuenta: motivo y que hacer (de `motivos.js`), y la puerta a la
 *     revision humana (art. 22.3 RGPD) si lo decidio la maquina.
 *
 * Se abre sobre la pagina en la que se esta (Hoy o el historial): no es una
 * ruta propia, y cerrar devuelve exactamente a donde se estaba.
 */

import { el, icono, abrirHoja, reemplazar } from '/assets/js/dom.js';
import { nombreEstacion, formatearTiempo } from '/assets/js/ui.js';
import { estadoDeViaje, motivoDeViaje } from '/assets/js/motivos.js';
import { sinMovimiento, aparecerPorPartes, sonar } from '/assets/js/celebrar.js';
import { diaRelativo } from '/assets/js/yo-vistas.js';
import { impugnarViaje } from '/assets/js/acciones.js';

const coma = (n, dec = 1) => Number(n).toFixed(dec).replace('.', ',');

/** "Metro Bilbao → Ferraz - Templo de Debod" */
export function tramoDe(ruta, { corto = false } = {}) {
  const [a, b] = String(ruta || '').split('-');
  const nombre = (id) => {
    const n = nombreEstacion(id) || id || '—';
    return corto ? n.split(' - ')[0] : n;
  };
  return `${nombre(a)} → ${nombre(b)}`;
}

/**
 * Las filas del desglose, en el orden y con los textos de 3e. Solo lo que
 * suma o multiplica: un "×1" es ruido y hace pensar que se ha perdido algo.
 */
export function filasDesglose(viaje, { racha = null } = {}) {
  const d = viaje?.puntosDesglose || {};
  const filas = [['Por completar el trayecto', String(Math.round(d.base || 0))]];
  const km = (viaje.distanciaMetros || 0) / 1000;
  filas.push([`Por la distancia${km ? ` · ${coma(km)} km` : ''}`, String(Math.round(d.distancia || 0))]);
  const kmh = viaje.velocidadKmh;
  filas.push([`Por el ritmo${kmh ? ` · ${coma(kmh)} km/h` : ''}`, String(Math.round(d.velocidad || 0))]);

  // ×1,50 y ×2, como en 3e: dos decimales salvo que sea entero.
  const mult = (v) => `×${coma(v, 2).replace(/,00$/, '')}`;
  if ((d.multiplicadorRacha || 1) !== 1) filas.push([`Racha${racha ? ` · ${racha} días` : ''}`, mult(d.multiplicadorRacha)]);
  if ((d.multiplicadorRuta || 1) !== 1) filas.push(['Ruta del día', mult(d.multiplicadorRuta)]);
  if ((d.multiplicadorTerritorio || 1) !== 1) filas.push(['Estación de tu clan', mult(d.multiplicadorTerritorio)]);
  if (d.misiones) filas.push(['Misiones completadas', `+${d.misiones}`]);
  return filas;
}

/** Cuenta de 0 a `hasta` en `ms`. Sin movimiento, el numero final directamente. */
function contar(nodo, hasta, { prefijo = '+', ms = 900 } = {}) {
  if (sinMovimiento() || !hasta) { nodo.textContent = `${prefijo}${hasta}`; return; }
  const inicio = performance.now();
  const paso = (t) => {
    const k = Math.min(1, (t - inicio) / ms);
    // Frena al final: los ultimos numeros se leen.
    const v = Math.round(hasta * (1 - (1 - k) ** 3));
    nodo.textContent = `${prefijo}${v}`;
    if (k < 1) requestAnimationFrame(paso);
  };
  requestAnimationFrame(paso);
}

/**
 * Superficie comun: pantalla entera en movil, dialogo de 480 px en escritorio
 * y, con `destino`, el panel de al lado de la lista del historial (8n).
 */
function abrirPantalla(clase, hijos, etiqueta, destino = null, { atras = false } = {}) {
  if (destino) {
    reemplazar(destino, el('div', { clase: `panel-veredicto ${clase}`, attrs: { 'aria-label': etiqueta } }, hijos));
    return () => reemplazar(destino);
  }
  const antes = document.activeElement;
  const velo = el('div', { clase: 'velo solo-escritorio' });
  // 3k / 3l: en el movil se vuelve con la flecha, arriba a la izquierda; en
  // el dialogo de escritorio, la X de siempre.
  const cerrarBoton = el('button', {
    clase: `boton-icono veredicto-cerrar${atras ? ' con-atras' : ''}`,
    attrs: { type: 'button', 'aria-label': atras ? 'Volver' : 'Cerrar' },
  }, atras ? [icono('atras', 'icono solo-movil-i'), icono('cerrar', 'icono solo-escritorio-i')] : [icono('cerrar')]);

  const pantalla = el('div', {
    clase: `pantalla-veredicto ${clase}`,
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': etiqueta, tabindex: '-1' },
  }, [cerrarBoton, ...hijos]);

  const cerrar = () => {
    velo.remove();
    pantalla.remove();
    document.removeEventListener('keydown', teclas);
    document.body.classList.remove('sin-desplazamiento');
    if (antes && typeof antes.focus === 'function') antes.focus();
  };
  const teclas = (e) => { if (e.key === 'Escape') cerrar(); };

  cerrarBoton.addEventListener('click', cerrar);
  velo.addEventListener('click', cerrar);
  document.addEventListener('keydown', teclas);
  document.body.classList.add('sin-desplazamiento');
  document.body.append(velo, pantalla);
  pantalla.focus();
  return cerrar;
}

/**
 * 3e · Verificado.
 * @param {object} viaje  documento de `tiempos_viaje`
 * @param {object} [contexto]
 * @param {number} [contexto.racha]        dias de racha tras este viaje
 * @param {string} [contexto.rutaDelDia]   puesto en la ruta del dia, si toca
 * @param {string} [contexto.mision]       progreso de una mision, en texto
 */
export function abrirVerificado(viaje, contexto = {}) {
  const total = Number(viaje.puntos) || 0;
  const sinPuntos = viaje.fueraDeCupo === true;
  const cifra = el('span', { clase: 'veredicto-cifra', texto: sinPuntos ? '0' : '+0' });

  const filas = sinPuntos ? [] : filasDesglose(viaje, { racha: contexto.racha });
  const nodosFilas = filas.map(([t, v]) => el('div', { clase: 'veredicto-fila' }, [
    el('span', { texto: t }), el('strong', { texto: v }),
  ]));

  const logros = [
    contexto.racha ? [String(contexto.racha), `Racha de ${contexto.racha} días. Hoy salvado.`] : null,
    contexto.rutaDelDia ? [contexto.rutaDelDia.puesto, contexto.rutaDelDia.texto] : null,
    contexto.mision ? [icono('ruta'), contexto.mision] : null,
  ].filter(Boolean);

  let cerrar = null;
  const seguir = el('button', {
    clase: 'btn grande blanco', texto: 'Seguir', attrs: { type: 'button' },
    on: { click: () => cerrar && cerrar() },
  });

  cerrar = abrirPantalla('verificado', [
    el('span', { clase: 'veredicto-chip' }, [icono('check', 'icono peq'), el('span', { texto: 'Verificado' })]),
    el('div', { clase: 'veredicto-titulo' }, [
      cifra,
      el('span', {
        clase: 'veredicto-sub',
        texto: sinPuntos
          ? `sin puntos · ${tramoDe(viaje.ruta, { corto: true })} · ${formatearTiempo(viaje.tiempoSegundos)}`
          : `puntos · ${tramoDe(viaje.ruta, { corto: true })} · ${formatearTiempo(viaje.tiempoSegundos)}`,
      }),
    ]),
    sinPuntos
      ? el('p', { clase: 'veredicto-nota', texto: 'Era uno más de los tres que puntúan hoy. Suma a tus kilómetros, a tus estadísticas y a tu racha.' })
      : el('div', { clase: 'veredicto-desglose' }, [
        ...nodosFilas,
        el('div', { clase: 'veredicto-fila total' }, [el('strong', { texto: 'Total' }), el('strong', { texto: String(total) })]),
      ]),
    logros.length
      ? el('div', { clase: 'veredicto-logros' }, logros.map(([marca, texto]) => el('div', {}, [
        el('span', { clase: 'veredicto-marca' }, [marca]), el('span', { texto }),
      ])))
      : null,
    el('div', { clase: 'veredicto-hueco' }),
    contexto.destino ? null : seguir,
  ], 'Trayecto verificado', contexto.destino);

  aparecerPorPartes(nodosFilas);
  if (contexto.destino) { contar(cifra, total); return cerrar; }
  if (!sinPuntos) { contar(cifra, total); sonar(); }
  seguir.focus();
  return cerrar;
}

/** 3k y 3l · Lo mira una persona / No cuenta. */
export function abrirResuelto(viaje, { alPedirRevision = null, destino = null, pedir: pedirPropio = null } = {}) {
  if (viaje.estado === 'aprobado') return abrirVerificado(viaje, { destino });

  const rechazado = viaje.estado === 'rechazado';
  const textos = estadoDeViaje(viaje.estado);
  const motivo = motivoDeViaje(viaje);
  const cuando = diaRelativo(viaje.fechaViaje);
  const puedePedir = rechazado && viaje.revisadoPor === 'automatico' && !viaje.impugnado;

  let cerrar = null;
  // 3l: "Creo que es un error: que lo mire una persona"; 8n, mas corto, al
  // lado de "Corregir y volver a subir".
  const pedir = puedePedir
    ? el('button', { clase: 'btn plano pedir-revision', attrs: { type: 'button' } }, [
      el('span', { clase: 'solo-movil-i', texto: 'Creo que es un error: que lo mire una persona' }),
      el('span', { clase: 'solo-escritorio-i', texto: 'Que lo mire una persona' }),
    ])
    : null;
  pedir?.addEventListener('click', () => {
    if (pedirPropio) { pedirPropio(pedir); return; }
    pedirRevisionHumana(viaje, () => {
      if (cerrar) cerrar();
      if (alPedirRevision) alPedirRevision();
    });
  });

  cerrar = abrirPantalla(rechazado ? 'rechazado' : 'revision', [
    // 3l / 8n: la pastilla dice "No cuenta"; el titulo ya explica el resto.
    el('span', { clase: `chip ${rechazado ? 'rechazado' : 'revision'}`, texto: rechazado ? 'No cuenta' : textos.titulo }),
    rechazado
      ? el('div', { clase: 'veredicto-cabeza' }, [
        el('h2', { texto: 'No lo hemos podido dar por bueno' }),
        el('span', { texto: `${tramoDe(viaje.ruta, { corto: true })} · ${formatearTiempo(viaje.tiempoSegundos)} · ${cuando}` }),
      ])
      : el('div', { clase: 'veredicto-cabeza' }, [
        el('span', { clase: 'veredicto-tiempo', texto: formatearTiempo(viaje.tiempoSegundos) }),
        el('span', { texto: `${tramoDe(viaje.ruta, { corto: true })} · ${cuando}` }),
      ]),
    el('div', { clase: 'tarjeta-grande veredicto-motivo' }, rechazado
      ? [
        el('span', { clase: 'rotulo', texto: motivo.dePersona ? 'Lo que dice quien lo ha revisado' : 'Motivo' }),
        el('strong', { texto: motivo.texto }),
        motivo.queHacer ? el('span', { clase: 'rotulo', texto: 'Qué hacer' }) : null,
        motivo.queHacer ? el('span', { clase: 'que-hacer', texto: motivo.queHacer }) : null,
      ]
      : [
        el('strong', { texto: viaje.impugnado ? 'Has pedido revisión humana.' : motivo.texto }),
        el('span', {
          clase: 'apagado',
          texto: viaje.impugnado
            ? 'Un administrador lo mirará.'
            : 'Todo lo que no está claro lo confirma una persona. No hace falta que hagas nada.',
        }),
      ]),
    el('p', { clase: 'veredicto-nota' }, rechazado
      ? [
        el('span', { clase: destino ? 'oculto' : '', texto: 'Tu racha no se ha tocado: sigue contando hasta medianoche.' }),
        el('span', { clase: destino ? '' : 'oculto', texto: 'Tu racha no se ha tocado.' }),
      ]
      : ['Normalmente el mismo día. Te avisamos por correo y en el móvil.']),
    el('div', { clase: 'veredicto-hueco' }),
    el('div', { clase: 'veredicto-botones' }, [
      rechazado ? el('a', { clase: 'btn grande', texto: 'Corregir y volver a subir', attrs: { href: '/subir/' } }) : null,
      pedir,
    ]),
    viaje.impugnado && rechazado ? el('p', { clase: 'veredicto-nota', texto: 'Has pedido revisión humana. Un administrador lo mirará.' }) : null,
  ], textos.titulo, destino, { atras: true });
  return cerrar;
}

/** 3m · Pedir revision humana. Texto opcional de hasta 280 caracteres. */
export function pedirRevisionHumana(viaje, alTerminar) {
  const campo = el('textarea', {
    attrs: { id: 'alegacion', rows: '4', maxlength: '280', placeholder: 'La captura es la original…' },
  });
  const cuenta = el('span', { clase: 'hoja-cuenta derecha', texto: '0 / 280' });
  const error = el('p', { clase: 'acceso-error', attrs: { 'aria-live': 'polite' } });
  campo.addEventListener('input', () => { cuenta.textContent = `${campo.value.length} / 280`; });

  const enviar = el('button', { clase: 'btn', texto: 'Enviar a revisión', attrs: { type: 'button' } });
  const { cerrar } = abrirHoja([
    el('h2', { texto: 'Que lo mire una persona' }),
    el('p', { texto: 'Un administrador verá tu captura y lo que escribas. Si tenía razón el análisis, el trayecto sigue sin contar.' }),
    el('div', { clase: 'pila', estilo: { gap: '6px' } }, [
      el('label', { clase: 'menor apagado', texto: '¿Qué crees que ha pasado? (opcional)', attrs: { for: 'alegacion' } }),
      campo,
      cuenta,
    ]),
    enviar,
    error,
  ], { etiqueta: 'Pedir revisión humana', clase: 'hoja-revision dialogo-escritorio' });

  enviar.addEventListener('click', async () => {
    enviar.disabled = true;
    enviar.textContent = 'Enviando…';
    // Las reglas piden al menos 15 caracteres; el texto es opcional para la
    // persona, asi que sin nada se manda la peticion tal cual.
    const escrito = campo.value.trim();
    const alegacion = escrito.length >= 15 ? escrito : `Pido revisión humana. ${escrito}`.trim();
    try {
      await impugnarViaje(viaje.id, alegacion);
      cerrar();
      if (alTerminar) alTerminar();
    } catch (e) {
      error.textContent = e.message || 'No se ha podido enviar. Inténtalo otra vez.';
      enviar.disabled = false;
      enviar.textContent = 'Enviar a revisión';
    }
  });
  campo.focus();
}
