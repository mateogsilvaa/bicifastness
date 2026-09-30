/**
 * 02 Hoy: la pantalla que se abre cada dia.
 *
 * Responde a una sola pregunta, ¿que hago hoy?, con un orden fijo: lo que esta
 * en el aire (viaje en cola) → lo que puedo perder (racha) → lo que puedo hacer
 * (subir, misiones, ruta del dia) → donde estoy (division) → lo que ya paso.
 *
 * COSTE. Todo sale del perfil (ya leido) y de documentos publicos compartidos y
 * cacheados en la pestaña: las misiones del dia, `config/general`, el agregado
 * de la ruta del dia, el indice de grupos y tu grupo, y el del mapa. La unica
 * consulta propia es la de tu ultima marca, acotada a un documento.
 */

import {
  db, doc, getDoc, collection, getDocs, query, where, orderBy, limit,
} from '/assets/js/firebase.js';
import { el, icono, reemplazar, abrirHoja } from '/assets/js/dom.js';
import { nombreEstacion, formatearTiempo, kmEstimados } from '/assets/js/ui.js';
import { traerAgregado, puestoPorMarca } from '/assets/js/agregados.js';
import { leerCache, guardarCache } from '/assets/js/cache.js';
import { diaMadrid, diaMadridHace, minutosMadrid } from '/assets/js/dia.js';
import { INSIGNIAS } from '/assets/data/insignias.js';
import { destacar } from '/assets/js/celebrar.js';
import { anilloSemana, estadosSemana, activoHoy } from '/assets/js/anillo.js';
import { seguirViaje, viajeRecordado, olvidarViaje } from '/assets/js/estado-viaje.js';
import { abrirVerificado, abrirResuelto, tramoDe } from '/assets/js/veredicto.js';
import { diaRelativo } from '/assets/js/yo-vistas.js';

const CUPO = 3;
const DIVISIONES = {
  hierro: 'Hierro', bronce: 'Bronce', plata: 'Plata', oro: 'Oro', platino: 'Platino', leyenda: 'Leyenda',
};
/** Lo mismo que `PUNTOS_MISION` del worker, para las misiones publicadas antes. */
const PUNTOS_MISION = { distancia: 20, velocidad: 15, trayectos: 15, exploracion: 25 };
const ICONO_MISION = { distancia: 'ruta', velocidad: 'rayo', exploracion: 'pin', trayectos: 'hoy' };

const coma = (n, dec = 1) => Number(n).toFixed(dec).replace('.', ',');
const ordinal = (n) => `${n}.º`;
const $ = (idDe) => document.getElementById(idDe);

// --- Tiempo -----------------------------------------------------------------

/** Minutos que le quedan al dia en Madrid. */
function minutosHastaMedianoche() {
  return 1440 - minutosMadrid();
}
function duracion(minutos) {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
}

/** "Martes, 29 de septiembre" */
function fechaLarga() {
  const t = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid', weekday: 'long', day: 'numeric', month: 'long',
  }).format(new Date());
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// --- Cabecera ---------------------------------------------------------------

function pintarCabecera(perfil, nuevo) {
  const nombre = perfil.username || 'piloto';
  $('hoy-fecha').textContent = nuevo ? 'Bienvenido' : fechaLarga();
  $('hoy-saludo').textContent = `Hola, ${nombre}`;
  $('hoy-avatar').textContent = [...nombre][0]?.toUpperCase() || 'P';
}

// --- Subir --------------------------------------------------------------------

/** Cuantos trayectos que puntuan lleva hoy: los verificados de las misiones. */
function llevaHoy(perfil) {
  return perfil.misiones?.fecha === diaMadrid() ? (perfil.misiones.trayectos || 0) : 0;
}

function botonSubir(texto, { secundario = false, clase = '' } = {}) {
  return el('a', {
    clase: `btn grande ${secundario ? 'secundario' : ''} ${clase}`.trim(),
    attrs: { href: '/subir/', 'data-subir': '' },
  }, [icono('mas', 'icono'), el('span', { texto })]);
}

function pintarSubir(perfil, modo) {
  if (modo === 'en-cola') { reemplazar($('bloque-subir')); return; }
  const lleva = llevaHoy(perfil);
  const quedan = Math.max(0, CUPO - lleva);
  if (modo === 'salvado') {
    // 2b: con el dia salvado, "Subir otro" baja debajo de las misiones.
    reemplazar($('bloque-subir'), el('div', { clase: 'hoy-subir salvado' }, [
      botonSubir(quedan ? `Subir otro · ${quedan === 1 ? 'queda 1 que puntúa' : `quedan ${quedan} que puntúan`}` : 'Subir otro · ya sin puntos hoy', { secundario: true }),
    ]));
    return;
  }
  // 2c: con la racha en peligro, el boton solo; la ayuda va debajo.
  reemplazar($('bloque-subir'), el('div', { clase: 'hoy-subir solo-movil' }, [
    botonSubir('Subir trayecto'),
    modo === 'riesgo' ? null : el('span', { clase: 'hoy-pista', texto: `Hoy puntúan ${CUPO} · llevas ${lleva} · también desde Fotos → Compartir` }),
  ]));
}

// --- Racha ------------------------------------------------------------------

/**
 * ¿Ha subido la racha desde la ultima vez que se pinto? En la pestaña, no en
 * disco: lo que interesa es "ha cambiado desde que lo vi" (#51).
 */
function subioLaRacha(dias) {
  try {
    const previa = Number(sessionStorage.getItem('bf_racha_vista'));
    sessionStorage.setItem('bf_racha_vista', String(dias));
    return Number.isFinite(previa) && previa > 0 && dias > previa;
  } catch {
    return false;
  }
}

function chipEscudos(n) {
  if (!n) return null;
  return el('span', { clase: 'chip-escudo' }, [
    icono('escudo', 'icono peq'),
    el('span', { texto: n === 1 ? '1 escudo guardado' : `${n} escudos guardados` }),
  ]);
}

function diasSemana() {
  const hoy = new Date(`${diaMadrid()}T12:00:00Z`).getUTCDay();
  const indiceHoy = (hoy + 6) % 7;
  return el('div', { clase: 'hoy-dias', attrs: { 'aria-hidden': 'true' } },
    ['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((d, i) => el('span', {
      clase: i === indiceHoy ? 'es-hoy' : '', texto: i === indiceHoy ? `${d} · hoy` : d,
    })));
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const nombreDia = (dia) => DIAS[new Date(`${dia}T12:00:00Z`).getUTCDay()];

/** 2f: la mejor insignia de racha que da esa marca: 'insignia "Una semana seguida"'. */
function insigniaDeRacha(dias) {
  const ganadas = Object.values(INSIGNIAS)
    .filter((i) => i.regla?.campo === 'mejorRacha' && dias >= i.regla.minimo)
    .sort((a, b) => b.regla.minimo - a.regla.minimo);
  return ganadas[0] ? `insignia "${ganadas[0].titulo}"` : null;
}

/**
 * La tarjeta de la racha, en el estado que toque (2a, 2b, 2c, 2d, 2f).
 * @returns {'pendiente'|'en-cola'|'salvado'|'riesgo'}
 */
function pintarRacha(perfil, { enCola = false } = {}) {
  const dias = perfil.racha || 0;
  const escudos = perfil.escudos || 0;
  const hoy = diaMadrid();
  const salvado = activoHoy(perfil, hoy);
  const estados = estadosSemana(perfil, hoy);
  const quedan = minutosHastaMedianoche();
  const destino = $('racha');

  // 2d · El viaje esta en el aire: la racha espera al veredicto.
  if (enCola && !salvado) {
    reemplazar(destino, el('div', { clase: 'tarjeta-grande hoy-racha compacta' }, [
      anilloSemana(estados, { tam: 72, numero: String(dias) }),
      el('div', { clase: 'hoy-racha-texto' }, [
        el('strong', { texto: 'Tu racha espera al veredicto' }),
        el('span', { texto: 'En cuanto se verifique, hoy queda salvado.' }),
      ]),
    ]));
    // 2d: mientras espera, sin boton de subir; debajo van las misiones.
    return 'en-cola';
  }

  // 2b · Hoy ya esta salvado.
  if (salvado) {
    const numero = String(dias);
    const anillo = anilloSemana(estados, { tam: 120, numero, pie: 'días', variante: 'salvado' });
    const mult = coma(1 + Math.min(dias + 1, 10) * 0.05, 2);
    const escudoEn = perfil.diasHastaEscudo;
    reemplazar(destino, el('div', { clase: 'tarjeta-grande hoy-racha salvado' }, [
      anillo,
      el('div', { clase: 'hoy-racha-texto' }, [
        el('strong', { texto: 'Hoy ya está salvado' }),
        el('span', {
          texto: `Racha ×${mult} desde mañana.${escudoEn && escudos < 2
            ? ` Dentro de ${escudoEn} ${escudoEn === 1 ? 'día' : 'días'} ganas otro escudo.` : ''}`,
        }),
      ]),
    ]));
    if (subioLaRacha(dias)) destacar(anillo.querySelector('.anillo-numero'));
    return 'salvado';
  }

  // 2f · La mañana siguiente a un escudo gastado o a una racha perdida.
  const cierre = perfil.ultimoCierreRacha;
  if (cierre?.dia === hoy && cierre.rota) {
    reemplazar(destino, el('div', { clase: 'tarjeta-grande hoy-racha-2f' }, [
      el('div', { clase: 'fila-anillo' }, [
        anilloSemana(estados, { tam: 84, numero: '0' }),
        el('div', { clase: 'hoy-racha-texto' }, [
          el('strong', { texto: 'Empieza otra hoy' }),
          // 2f: "Tu racha de 23 días terminó el domingo. Sigue siendo tu mejor marca."
          el('span', { texto: `Tu racha de ${cierre.rachaPrevia} días terminó el ${nombreDia(diaMadridHace(1))}. ${cierre.rachaPrevia >= (perfil.mejorRacha || 0) ? 'Sigue siendo tu mejor marca.' : ''}`.trim() }),
        ]),
      ]),
      el('div', { clase: 'fila-dato' }, [
        el('span', { texto: 'Mejor racha' }),
        el('strong', { texto: [`${perfil.mejorRacha || cierre.rachaPrevia} días`, insigniaDeRacha(perfil.mejorRacha || cierre.rachaPrevia)].filter(Boolean).join(' · ') }),
      ]),
      botonSubir('Subir trayecto', { clase: 'solo-escritorio' }),
    ]));
    return 'pendiente';
  }
  if (cierre?.dia === hoy && cierre.escudosGastados > 0) {
    reemplazar(destino, el('div', { clase: 'tarjeta-grande hoy-racha compacta' }, [
      anilloSemana(estados, { tam: 84, numero: String(dias) }),
      el('div', { clase: 'hoy-racha-texto' }, [
        el('strong', { texto: cierre.escudosGastados > 1 ? 'Estos días te cubrieron tus escudos' : 'Ayer te cubrió un escudo' }),
        el('span', {
          texto: `Tu racha de ${dias} sigue viva. ${escudos ? `Te ${escudos === 1 ? 'queda 1 escudo' : `quedan ${escudos} escudos`}.` : 'No te quedan escudos: hoy cuenta.'}`,
        }),
      ]),
    ]));
    return 'pendiente';
  }

  // 2f · C: sin racha nunca (o a cero sin haberla perdido hoy).
  if (!dias) {
    reemplazar(destino, el('div', { clase: 'tarjeta-grande hoy-sin-racha' }, [
      el('span', { clase: 'marca-logo', attrs: { 'aria-hidden': 'true' } }),
      el('span', {}, [
        el('strong', { texto: 'Sube un trayecto hoy y empiezas racha. ' }),
        el('span', { clase: 'apagado', texto: 'Cada día seguido multiplica tus puntos, hasta ×1,5.' }),
      ]),
    ]));
    return 'pendiente';
  }

  // 2c · En peligro: desde las 20:00, sin viaje. Sin escudos, en rojo.
  if (minutosMadrid() >= 20 * 60) {
    const sinEscudos = escudos === 0;
    reemplazar(destino, el('div', { clase: `tarjeta-grande hoy-racha riesgo ${sinEscudos ? 'sin-escudos' : ''}` }, [
      el('div', { clase: 'fila-anillo' }, [
        anilloSemana(estados, { tam: 120, numero: String(dias), pie: 'días', variante: sinEscudos ? 'riesgo' : 'normal' }),
        el('div', { clase: 'hoy-racha-texto' }, sinEscudos
          ? [
            el('span', { clase: 'rotulo-rojo', texto: 'Sin escudos' }),
            el('span', { clase: 'cuenta-atras', texto: duracion(quedan) }),
            el('span', { texto: `para salvar ${dias} ${dias === 1 ? 'día' : 'días'}. Si no sales, vuelves a 0.` }),
            // 8p: en escritorio, el boton en la columna del texto.
            botonSubir('Subir trayecto', { clase: 'solo-escritorio' }),
          ]
          : [
            el('strong', { texto: 'Hoy aún no has salido' }),
            el('span', { texto: `Quedan ${duracion(quedan)}. Si no sales, se gasta tu escudo.` }),
            botonSubir('Subir trayecto', { clase: 'solo-escritorio' }),
          ]),
      ]),
    ]));
    return 'riesgo';
  }

  // 2a · Racha viva, hoy sin salir.
  reemplazar(destino, el('div', { clase: 'tarjeta-grande hoy-racha' }, [
    el('div', { clase: 'fila-anillo' }, [
      anilloSemana(estados, { tam: 120, numero: String(dias), pie: 'días' }),
      el('div', { clase: 'hoy-racha-texto' }, [
        el('strong', { texto: 'Hoy aún no has salido' }),
        el('span', {}, [
          `Un trayecto antes de las 23:59 y llegas a ${dias + 1}.`,
          // 8a: en escritorio el escudo va en la misma frase, sin chip.
          escudos ? el('span', { clase: 'solo-escritorio-i', texto: ` Tienes ${escudos === 1 ? '1 escudo guardado' : `${escudos} escudos guardados`}.` }) : null,
        ]),
        chipEscudos(escudos),
        botonSubir('Subir trayecto · o arrastra la captura aquí', { clase: 'solo-escritorio' }),
      ]),
    ]),
    diasSemana(),
  ]));
  return 'pendiente';
}

/** 2c · Lo que sale debajo cuando la racha esta en peligro. */
function pintarAyudaRiesgo(perfil) {
  // La estacion que mas aparece en sus tramos: la que tiene mas a mano.
  const veces = new Map();
  for (const ruta of Object.keys(perfil?.puntosPorRuta || {})) {
    for (const e of ruta.split('-')) veces.set(e, (veces.get(e) || 0) + 1);
  }
  const [habitual] = [...veces.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  reemplazar($('misiones'), el('div', { clase: 'pila hoy-ayuda' }, [
    el('div', { clase: 'tarjeta-grande media' }, [
      // 8p: en escritorio, una sola frase: "Lo más corto que te salva: cualquier…".
      el('strong', {}, ['Lo más corto que te salva', el('span', { clase: 'solo-escritorio-i', texto: ':' })]),
      el('span', { clase: 'apagado' }, [
        el('span', { clase: 'solo-movil-i' }, [
          'Cualquier trayecto verificado cuenta, aunque sea corto y lento. ',
          habitual ? 'Tu estación más usada: ' : null,
          habitual ? el('strong', { texto: nombreEstacion(habitual) || habitual }) : null,
          habitual ? '. ' : null,
          'Recuerda: vale la hora de llegada de la captura, no la de subida; puedes subirla mañana.',
        ]),
        el('span', { clase: 'solo-escritorio-i', texto: ' cualquier trayecto verificado cuenta. Vale la hora de llegada de la captura, no la de subida: puedes subirla mañana.' }),
      ]),
    ]),
    el('div', { clase: 'aviso tonal' }, [
      icono('escudo', 'icono'),
      el('p', { texto: 'Cada 7 días activos ganas un escudo (máximo 2). Se gasta solo si un día no sales.' }),
    ]),
  ]));
}

// --- Misiones -----------------------------------------------------------------

async function misionesDeHoy() {
  const clave = `misiones-${diaMadrid()}`;
  const guardado = leerCache(clave);
  if (guardado !== undefined) return guardado;
  const snap = await getDoc(doc(db, 'config', 'misiones', 'dias', diaMadrid()));
  const datos = snap.exists() ? snap.data().misiones || [] : [];
  guardarCache(clave, datos);
  return datos;
}

function textoHecha(m, p) {
  if (m.tipo === 'distancia') return `${coma((p.hecho || 0) / 1000)} de ${coma(m.objetivo / 1000)} km · hecha`;
  if (m.tipo === 'velocidad') return `Hecha con ${coma(p.hecho || 0)} km/h`;
  return 'Hecha';
}
function textoProgreso(m, p) {
  if (!p || !p.hecho) return null;
  if (m.tipo === 'distancia') return `${coma(p.hecho / 1000)} de ${coma(m.objetivo / 1000)} km`;
  if (m.tipo === 'trayectos') return `${p.hecho} de ${m.objetivo}`;
  if (m.tipo === 'velocidad') return `Tu mejor hoy: ${coma(p.hecho)} km/h`;
  return null;
}

async function pintarMisiones(perfil, { conBarras = true } = {}) {
  const destino = $('misiones');
  try {
    const lista = await misionesDeHoy();
    if (!lista.length) { reemplazar(destino); return; }
    const progreso = perfil.misiones?.fecha === diaMadrid() ? (perfil.misiones.progreso || []) : [];
    const hechas = progreso.filter((p) => p?.completada).length;

    reemplazar(destino, el('section', { clase: 'hoy-misiones', attrs: { 'aria-labelledby': 'titulo-misiones' } }, [
      el('div', { clase: 'hoy-seccion' }, [
        el('h2', { attrs: { id: 'titulo-misiones' }, texto: 'Misiones de hoy' }),
        el('span', { texto: `${hechas} de ${lista.length}` }),
      ]),
      el('div', { clase: 'lista-misiones' }, lista.map((m, i) => {
        const p = progreso[i];
        const hecha = Boolean(p?.completada);
        const puntos = m.puntos || PUNTOS_MISION[m.tipo] || 0;
        const pct = Math.max(0, Math.min(100, ((p?.hecho || 0) / (m.objetivo || 1)) * 100));
        const sub = hecha ? textoHecha(m, p) : textoProgreso(m, p);
        return el('div', { clase: `mision ${hecha ? 'hecha' : ''}` }, [
          el('span', { clase: 'mision-icono' }, [icono(hecha ? 'check' : (ICONO_MISION[m.tipo] || 'ruta'))]),
          el('span', { clase: 'mision-texto' }, [
            el('span', { clase: 'mision-titulo', texto: m.texto }),
            hecha || !conBarras
              ? (sub ? el('span', { clase: 'mision-sub', texto: sub }) : null)
              : el('span', { clase: 'progreso', attrs: { role: 'progressbar', 'aria-valuenow': String(Math.round(pct)), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': m.texto } }, [
                el('span', { estilo: { width: `${pct}%` } }),
              ]),
          ]),
          el('span', { clase: 'mision-puntos', texto: `+${puntos}` }),
        ]);
      })),
    ]));
  } catch (error) {
    console.debug('Sin misiones', error);
    reemplazar(destino);
  }
}

// --- Viaje en el aire (2d) y recien verificado (2b) -----------------------------

function haceMinutos(fecha) {
  const t = fecha?.toDate?.()?.getTime?.() ?? (fecha ? new Date(fecha).getTime() : null);
  if (!t) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

function tarjetaEnCola(viaje) {
  const min = haceMinutos(viaje.creado);
  // Diez minutos estimados. Nunca llega al 100 % sola: eso lo decide el worker.
  const pct = Math.min(92, ((min ?? 0) / 10) * 100);
  const [a, b] = String(viaje.ruta || '').split('-');
  return el('div', { clase: 'tarjeta-grande hoy-cola' }, [
    el('div', { clase: 'fila-cola' }, [
      el('span', { clase: 'chip-cola' }, [el('span', { clase: 'punto' }), el('span', { texto: 'En cola' })]),
      el('span', { clase: 'hace', texto: min === null ? 'subido ahora' : `subido hace ${min} min` }),
    ]),
    el('div', { clase: 'fila-cola abajo' }, [
      el('div', { clase: 'cola-ruta' }, [
        el('strong', { texto: nombreEstacion(a) || a || '—' }),
        el('span', { texto: `→ ${nombreEstacion(b) || b || '—'}` }),
      ]),
      el('span', { clase: 'cola-tiempo', texto: formatearTiempo(viaje.tiempoSegundos) }),
    ]),
    el('span', { clase: 'progreso gruesa azul' }, [el('span', { estilo: { width: `${pct}%` } })]),
    el('span', { clase: 'apagado menor cola-nota', texto: 'Suele tardar unos diez minutos. Puedes cerrar la app: te avisamos.' }),
  ]);
}

function tarjetaResuelta(viaje, perfil) {
  const aprobado = viaje.estado === 'aprobado';
  const rechazado = viaje.estado === 'rechazado';
  const titulo = aprobado
    ? (viaje.fueraDeCupo ? 'Verificado · sin puntos' : `Verificado · +${viaje.puntos || 0} pts`)
    : rechazado ? 'No cuenta' : 'Lo mira una persona';
  const hora = viaje.creado?.toDate?.()
    ? new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' }).format(viaje.creado.toDate())
    : null;
  return el('button', {
    clase: `tarjeta-grande hoy-veredicto ${aprobado ? 'ok' : rechazado ? 'mal' : 'revision'}`,
    attrs: { type: 'button' },
    on: {
      click: () => (aprobado
        ? abrirVerificado(viaje, { racha: perfil.racha })
        : abrirResuelto(viaje)),
    },
  }, [
    el('span', { clase: 'veredicto-icono' }, [icono(aprobado ? 'check' : rechazado ? 'cerrar' : 'reloj')]),
    el('span', { clase: 'veredicto-texto' }, [
      el('strong', { texto: titulo }),
      el('span', { texto: [tramoDe(viaje.ruta, { corto: true }), hora].filter(Boolean).join(' · ') }),
    ]),
    icono('derecha', 'icono peq'),
  ]);
}

/**
 * Sigue el viaje recien subido (un solo documento, y solo hasta el veredicto:
 * `estado-viaje.js`). Devuelve si habia uno en el aire.
 */
function seguirViajeEnCurso(perfil, alResolver) {
  const destino = $('viaje-en-curso');
  const viajeId = viajeRecordado();
  if (!viajeId) return false;

  // La primera respuesta es el estado al abrir; solo un cambio POSTERIOR es un
  // veredicto que llega con la app abierta.
  let respuestas = 0;
  seguirViaje(viajeId, (viaje) => {
    const primera = respuestas++ === 0;
    if (!viaje) { olvidarViaje(); reemplazar(destino); return; }
    if (viaje.estado === 'pendiente' || viaje.estado === 'extrayendo') {
      reemplazar(destino, tarjetaEnCola(viaje));
      return;
    }
    reemplazar(destino, tarjetaResuelta(viaje, perfil));
    olvidarViaje();
    // Llega el veredicto con la app abierta: se celebra en el acto (3e).
    if (!primera && viaje.estado === 'aprobado') abrirVerificado(viaje, { racha: (perfil.racha || 0) + (activoHoy(perfil) ? 0 : 1) });
    if (alResolver) alResolver(viaje);
  });
  return true;
}

// --- Ruta del dia -------------------------------------------------------------

async function configGeneral() {
  const guardado = leerCache('config-general');
  if (guardado !== undefined) return guardado;
  const snap = await getDoc(doc(db, 'config', 'general'));
  const datos = snap.exists() ? snap.data() : null;
  guardarCache('config-general', datos);
  return datos;
}

async function pintarRutaDelDia(perfil) {
  const destino = $('ruta-del-dia');
  try {
    const ruta = (await configGeneral())?.rutaDestacada;
    if (!ruta) { reemplazar(destino); return; }
    const agregado = await traerAgregado(`ruta-${ruta}`).catch(() => null);
    const deHoy = agregado?.hoyDia === diaMadrid() ? (agregado.hoy || []) : [];
    const mia = deHoy.find((f) => f.nombre === perfil.username);
    const [a, b] = ruta.split('-');
    const distancia = kmEstimados(a, b);
    const km = distancia ? `${coma(distancia)} km` : null;

    reemplazar(destino, el('a', {
      clase: 'tarjeta-ruta-dia', attrs: { href: `/clasificacion/?ruta=${encodeURIComponent(ruta)}` },
    }, [
      el('div', { clase: 'fila-cola' }, [
        el('span', { clase: 'x2', texto: 'Ruta del día · ×2' }),
        el('span', { clase: 'cierra' }, [
          `cierra en ${Math.floor(minutosHastaMedianoche() / 60)} h`,
          el('span', { clase: 'solo-movil-i', texto: ` ${minutosHastaMedianoche() % 60} min` }),
        ]),
      ]),
      el('div', { clase: 'ruta-dia-nombre' }, [
        el('strong', {}, [
          nombreEstacion(a) || a,
          // 8a: en escritorio, el tramo entero en una linea.
          el('span', { clase: 'solo-escritorio-i', texto: ` → ${nombreEstacion(b) || b}` }),
        ]),
        el('span', { clase: 'solo-movil-i', texto: `→ ${nombreEstacion(b) || b}${km ? ` · ${km}` : ''}` }),
      ]),
      el('div', { clase: 'ruta-dia-filas' }, [
        ...deHoy.slice(0, 3).map((f) => el('div', { clase: 'ruta-dia-fila' }, [
          el('span', { clase: 'pos', texto: String(f.pos) }),
          el('span', { texto: f.nombre }),
          el('strong', { texto: formatearTiempo(f.marca) }),
        ])),
        !deHoy.length ? el('div', { clase: 'ruta-dia-fila' }, [
          el('span', { clase: 'pos', texto: '–' }),
          el('span', { texto: 'Nadie tiene tiempo hoy todavía' }),
          el('strong', { texto: '' }),
        ]) : null,
        el('div', { clase: 'ruta-dia-fila tuya' }, mia
          ? [el('span', { clase: 'pos', texto: String(mia.pos) }), el('span', { texto: 'Tú' }), el('strong', { texto: formatearTiempo(mia.marca) })]
          : [
            el('span', { clase: 'pos', texto: '–' }),
            el('span', { texto: 'Tú, sin tiempo hoy' }),
            el('strong', { texto: agregado?.hoyPilotos ? `${agregado.hoyPilotos} ${agregado.hoyPilotos === 1 ? 'piloto' : 'pilotos'}` : '' }),
          ]),
      ]),
    ]));
  } catch (error) {
    console.debug('Sin ruta del dia', error);
    reemplazar(destino);
  }
}

// --- Division -------------------------------------------------------------------

/** Tu grupo de division: dos lecturas publicas y cacheadas. */
export async function miGrupo(nombre) {
  if (!nombre) return null;
  const indice = await traerAgregado('grupos').catch(() => null);
  const clave = indice?.porPiloto?.[nombre];
  if (!clave) return null;
  const grupo = await traerAgregado(`grupo-${clave}`).catch(() => null);
  if (!grupo) return null;
  const filas = grupo.filas || [];
  const yo = filas.find((f) => f.nombre === nombre);
  return { clave, filas, yo, mueven: grupo.mueven ?? 5, total: grupo.total ?? filas.length };
}

export function nombreGrupo(clave) {
  const [nivel, numero] = String(clave || '').split('-');
  return `${DIVISIONES[nivel] || nivel} · grupo ${numero}`;
}

async function pintarDivision(perfil) {
  const destino = $('division');
  try {
    const grupo = await miGrupo(perfil.username);
    if (!grupo?.yo) { reemplazar(destino); return; }
    const { yo, filas, mueven, total } = grupo;
    const umbral = filas[mueven - 1];
    const detalle = yo.pos <= mueven
      ? 'en zona de subida'
      : umbral ? `a ${Math.max(1, umbral.puntos - yo.puntos + 1)} pts de subir` : '';

    reemplazar(destino, el('a', { clase: 'tarjeta-grande hoy-division', attrs: { href: '/clasificacion/' } }, [
      el('div', { clase: 'hoy-seccion' }, [
        el('strong', { texto: nombreGrupo(grupo.clave) }),
        el('span', {}, [el('span', { clase: 'solo-movil-i', texto: 'se decide el ' }), 'lunes']),
      ]),
      el('div', { clase: 'division-puesto' }, [
        el('span', { clase: 'cifra-grande', texto: ordinal(yo.pos) }),
        el('span', { texto: `de ${total}${detalle ? ` · ${detalle}` : ''}` }),
      ]),
      el('div', { clase: 'barras-grupo', attrs: { 'aria-hidden': 'true' } }, filas.map((f, i) => el('span', {
        clase: f.nombre === perfil.username ? 'yo' : i < mueven ? 'sube' : i >= filas.length - mueven ? 'baja' : '',
        estilo: { height: f.nombre === perfil.username ? '22px' : `${Math.max(6, 16 - i * 0.3)}px` },
      }))),
      mueven ? el('div', { clase: 'leyenda-grupo' }, [
        el('span', { clase: 'sube', texto: `suben ${mueven}` }),
        el('span', { clase: 'baja', texto: `bajan ${mueven}` }),
      ]) : null,
    ]));
  } catch (error) {
    console.debug('Sin grupo', error);
    reemplazar(destino);
  }
}

// --- Lo que ya paso: ultima marca y clan -----------------------------------------

async function pintarUltimaMarca(uid) {
  const destino = $('ultima-marca');
  try {
    // Una consulta acotada a UN documento (#37): nunca la ruta entera.
    const snap = await getDocs(query(
      collection(db, 'tiempos_viaje'),
      where('uid', '==', uid),
      where('verificado', '==', true),
      orderBy('fechaViaje', 'desc'),
      limit(1),
    ));
    if (snap.empty) { reemplazar(destino); return; }
    const ultimo = snap.docs[0].data();
    const agregado = await traerAgregado(`ruta-${ultimo.ruta}`).catch(() => null);
    const { puesto, total } = puestoPorMarca(agregado, ultimo.tiempoSegundos);
    reemplazar(destino, el('a', {
      clase: 'tarjeta-grande media hoy-mini',
      attrs: { href: `/clasificacion/?ruta=${encodeURIComponent(ultimo.ruta)}` },
    }, [
      el('span', { clase: 'rotulo', texto: `Última marca · ${diaRelativo(ultimo.fechaViaje)}` }),
      el('span', { clase: 'cifra-media', texto: formatearTiempo(ultimo.tiempoSegundos) }),
      el('span', {
        clase: 'rotulo',
        texto: puesto ? `${ordinal(puesto)} de ${total} en ${tramoDe(ultimo.ruta, { corto: true })}` : tramoDe(ultimo.ruta, { corto: true }),
      }),
    ]));
  } catch (error) {
    console.debug('Sin ultima marca', error);
    reemplazar(destino);
  }
}

async function pintarClan(perfil) {
  const destino = $('estado-clan');
  if (!perfil.clanId) {
    reemplazar(destino, el('a', { clase: 'tarjeta-grande media hoy-mini', attrs: { href: '/territorio/#clanes' } }, [
      el('span', { clase: 'rotulo', texto: 'Sin clan' }),
      el('span', { clase: 'cifra-media', texto: '0' }),
      el('span', { clase: 'rotulo', texto: 'Únete a uno y conquistad estaciones' }),
    ]));
    return;
  }
  try {
    const mapa = await traerAgregado('mapa').catch(() => null);
    const clan = mapa?.clanes?.[perfil.clanId];
    if (!clan) { reemplazar(destino); return; }
    const suyas = Object.values(mapa.estaciones || {}).filter((e) => e.clan === perfil.clanId);
    const asedio = suyas.filter((e) => e.disputa).length;
    const iniciales = String(clan.nombre || '').split(/\s+/).filter(Boolean).slice(0, 2)
      .map((p) => [...p][0]).join('').toUpperCase();
    reemplazar(destino, [
      el('a', { clase: 'tarjeta-grande media hoy-mini solo-movil', attrs: { href: '/territorio/#mi-clan' } }, [
        el('span', { clase: 'rotulo con-punto' }, [
          el('span', { clase: 'punto-clan', estilo: { background: clan.color || 'var(--tinta-3)' } }),
          el('span', { texto: clan.nombre }),
        ]),
        el('span', { clase: 'cifra-media', texto: String(suyas.length) }),
        el('span', { clase: 'rotulo', texto: `estaciones${asedio ? ` · ${asedio} en asedio` : ''}` }),
      ]),
      el('a', { clase: 'hoy-clan-fila solo-escritorio', attrs: { href: '/territorio/#mi-clan' } }, [
        el('span', { clase: 'insignia-clan', estilo: { background: clan.color || 'var(--tinta-3)' }, texto: iniciales }),
        el('span', { clase: 'datos' }, [
          el('strong', { texto: clan.nombre }),
          el('span', { texto: `${suyas.length} ${suyas.length === 1 ? 'estación' : 'estaciones'}${asedio ? ` · ${asedio} en asedio` : ''}` }),
        ]),
      ]),
    ]);
  } catch (error) {
    console.debug('Sin clan', error);
    reemplazar(destino);
  }
}

// --- 2g · Cambio de division ------------------------------------------------------

function avisarCambioDivision(perfil) {
  const cambio = perfil.ultimoCambioDivision;
  if (!cambio?.fecha) return;
  const clave = 'bf_division_vista';
  try {
    if (localStorage.getItem(clave) === cambio.fecha) return;
  } catch { return; }

  const niveles = Object.keys(DIVISIONES);
  const sube = niveles.indexOf(cambio.hasta) > niveles.indexOf(cambio.desde);
  const desde = DIVISIONES[cambio.desde] || cambio.desde;
  const hasta = DIVISIONES[cambio.hasta] || cambio.hasta;

  const { cerrar } = abrirHoja([
    el('div', { clase: 'cambio-division' }, [
      el('div', { clase: 'cambio-chips' }, [
        el('span', { clase: 'chip-division antes', texto: desde }),
        icono('flecha', 'icono'),
        el('span', { clase: `chip-division despues ${cambio.hasta}`, texto: hasta }),
      ]),
      el('h2', { texto: sube ? `Subes a ${hasta}` : `Bajas a ${hasta}` }),
      el('p', {
        texto: sube
          ? `Acabaste ${ordinal(cambio.puesto)} de ${cambio.total} en tu grupo. Esta semana compites con pilotos nuevos, todos desde 0.`
          : `Acabaste ${ordinal(cambio.puesto)} de ${cambio.total}. Esta semana, a recuperar ${desde}.`,
      }),
    ]),
    el('div', { clase: 'cifras-cambio' }, [
      el('div', {}, [el('strong', { texto: String(cambio.puntos || 0) }), el('span', { texto: 'pts semana' })]),
      el('div', {}, [el('strong', { texto: ordinal(cambio.puesto) }), el('span', { texto: `de ${cambio.total}` })]),
    ]),
    el('a', { clase: 'btn', texto: 'Ver mi grupo nuevo', attrs: { href: '/clasificacion/' } }),
  ], {
    etiqueta: sube ? `Subes a ${hasta}` : `Bajas a ${hasta}`,
    clase: 'dialogo-escritorio hoja-division',
    alCerrar: () => { try { localStorage.setItem(clave, cambio.fecha); } catch { /* modo privado */ } },
  });
  // Tambien cuenta como vista si se sigue el enlace.
  try { localStorage.setItem(clave, cambio.fecha); } catch { /* modo privado */ }
  return cerrar;
}

// --- Montaje ------------------------------------------------------------------------

/**
 * Pinta Hoy entero para un perfil ya leido.
 * @param {{uid: string}} usuario
 * @param {object} perfil
 */
export async function pintarHoy(usuario, perfil) {
  // Quien aun no ha subido nada ve el Hoy de verdad (racha a 0, misiones, ruta
  // del dia): la pantalla de bienvenida con los tres pasos sobraba.
  pintarCabecera(perfil, false);

  const enCola = seguirViajeEnCurso(perfil, () => {});
  const modo = pintarRacha(perfil, { enCola });
  pintarSubir(perfil, modo);

  if (modo === 'riesgo') pintarAyudaRiesgo(perfil);
  else await pintarMisiones(perfil, { conBarras: !enCola });

  avisarCambioDivision(perfil);

  // Lo secundario, en paralelo: no bloquea lo de arriba.
  await Promise.all([
    pintarRutaDelDia(perfil),
    pintarDivision(perfil),
    pintarUltimaMarca(usuario.uid),
    pintarClan(perfil),
  ]);
}
