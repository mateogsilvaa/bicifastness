// Modulo de la pagina /admin/nfc/: grabar los enlaces de canje en pegatinas NFC
// y ver cuando se ha canjeado cada una.
//
// Una pegatina es un enlace de canje como los de evento (`recompensas_codigos`,
// ver admin-recompensas.js) con dos datos mas que solo ve la administracion:
// `etiqueta` (donde esta) y `escrito` (cuando se grabo). Lo de canjeado
// (`usadoPor`, `usadoPorNombre`, `usadoEn`) lo apunta el worker
// (backend/src/canjes.js): aqui solo se lee.
//
// Grabar va con Web NFC (`NDEFReader`), que solo existe en Chrome para Android
// y con la pagina en primer plano. En cualquier otro sitio se puede copiar el
// enlace y grabarlo con una app.
//
// La lista se lee una vez (y con "Actualizar"), no se escucha: cada cambio
// escuchado en una coleccion es una lectura facturada.

import {
  auth, db, doc, getDocs, setDoc, updateDoc, deleteDoc, collection, serverTimestamp,
} from '/assets/js/firebase.js';
import { iniciarPagina } from '/assets/js/ui.js';
import { id, el, estado, reemplazar, confirmar, abrirHoja } from '/assets/js/dom.js';
import { montarCabeceraAdmin, exigirAdmin } from '/assets/js/admin-cabecera.js';
import { BANNERS, LEMAS, esLibre } from '/assets/data/recompensas.js';
import { FORMA_CODIGO } from '/assets/js/canje-pendiente.js';
import { nuevoCodigo, enlaceDe } from '/assets/js/enlaces-canje.js';

iniciarPagina('admin');
montarCabeceraAdmin('nfc');

const HAY_NFC = 'NDEFReader' in window;

/** Las que se pueden ganar, con el nombre que se enseña: [id, 'Banner · Ecos']. */
const RECOMPENSAS = [
  ...Object.entries(BANNERS).filter(([c]) => !esLibre(c)).map(([c, b]) => [c, `Banner · ${b.titulo}`]),
  ...Object.entries(LEMAS).filter(([c]) => !esLibre(c)).map(([c, l]) => [c, `Lema · ${l.texto}`]),
];
const nombreDe = (clave) => RECOMPENSAS.find(([c]) => c === clave)?.[1] || clave;

let codigos = [];

const fecha = (ts) => {
  const d = ts?.toDate?.();
  return d ? d.toLocaleString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
};
const aviso = (texto, tipo = 'info') => estado(id('mensaje'), texto, tipo);

async function copiar(texto, avisoOk) {
  try {
    await navigator.clipboard.writeText(texto);
    aviso(avisoOk, 'exito');
  } catch {
    aviso('No se ha podido copiar. Selecciónalo y cópialo a mano.', 'error');
  }
}

// --- NFC --------------------------------------------------------------------------

/**
 * La hoja de "acerca la pegatina", mientras el movil espera una. Cancelar la
 * cierra y corta la espera.
 *
 * @returns {{ senal: AbortSignal, cerrar: () => void }}
 */
function hojaEsperando(titulo, texto) {
  const control = new AbortController();
  const { cerrar } = abrirHoja([
    el('h2', { texto: titulo }),
    el('p', { texto }),
    el('div', { clase: 'adm-nfc-onda', attrs: { 'aria-hidden': 'true' } }),
    el('button', { clase: 'btn plano', texto: 'Cancelar', attrs: { type: 'button' }, on: { click: () => cerrar() } }),
  ], { etiqueta: titulo, alCerrar: () => control.abort() });
  return { senal: control.signal, cerrar };
}

function errorNfc(error) {
  if (error?.name === 'AbortError') return null;
  if (error?.name === 'NotAllowedError') return 'El navegador no deja usar el NFC. Dale permiso y comprueba que el NFC del móvil está encendido.';
  if (error?.name === 'NotSupportedError') return 'Este móvil no tiene NFC, o la pegatina no admite el formato.';
  if (error?.name === 'NetworkError') return 'Se ha perdido la pegatina a mitad. Vuelve a acercarla y no la muevas.';
  return `No se ha podido: ${error?.message || error}`;
}

/** Graba el enlace de `c` en la pegatina que se acerque y apunta cuando. */
async function grabar(c, { bloquear = false } = {}) {
  if (!HAY_NFC) {
    await copiar(enlaceDe(c.codigo), 'Este navegador no graba NFC: enlace copiado para grabarlo con una app.');
    return false;
  }
  if (bloquear && !await confirmar('La pegatina quedará bloqueada: ya no se podrá reescribir ni reponer. ¿Seguro?', { textoAceptar: 'Bloquearla', peligroso: true })) return false;

  const { senal, cerrar } = hojaEsperando('Acerca la pegatina', `${nombreDe(c.recompensa)}${c.etiqueta ? ` · ${c.etiqueta}` : ''}. Pégala a la parte de atrás del móvil y no la muevas.`);
  try {
    const lector = new window.NDEFReader();
    await lector.write({ records: [{ recordType: 'url', data: enlaceDe(c.codigo) }] }, { overwrite: true, signal: senal });
    if (bloquear) await lector.makeReadOnly({ signal: senal });
    cerrar();
    if (navigator.vibrate) navigator.vibrate(80);
    await updateDoc(doc(db, 'recompensas_codigos', c.codigo), { nfc: true, escrito: serverTimestamp() });
    aviso(`Pegatina grabada${bloquear ? ' y bloqueada' : ''}.`, 'exito');
    return true;
  } catch (error) {
    cerrar();
    const texto = errorNfc(error);
    if (texto) aviso(texto, 'error');
    return false;
  }
}

/** Lee una pegatina y dice de cual se trata y como esta. */
async function leer() {
  if (!HAY_NFC) { aviso('Este navegador no lee NFC: hace falta Chrome en Android.', 'error'); return; }
  const { senal, cerrar } = hojaEsperando('Acerca la pegatina', 'Para ver qué enlace lleva y si ya se ha canjeado.');
  try {
    const lector = new window.NDEFReader();
    const lectura = new Promise((resolver, rechazar) => {
      lector.addEventListener('reading', resolver, { once: true });
      lector.addEventListener('readingerror', () => rechazar(new Error('No se ha podido leer. Vuelve a acercarla.')), { once: true });
      senal.addEventListener('abort', () => rechazar(new DOMException('Cancelado', 'AbortError')), { once: true });
    });
    await lector.scan({ signal: senal });
    const { message } = await lectura;
    cerrar();

    const urls = message.records
      .filter((r) => r.recordType === 'url' || r.recordType === 'absolute-url')
      .map((r) => new TextDecoder().decode(r.data));
    if (!urls.length) { aviso('La pegatina está vacía, o no lleva ningún enlace.', 'info'); return; }

    let codigo = null;
    try { codigo = new URL(urls[0]).searchParams.get('c'); } catch { codigo = null; }
    if (!codigo || !FORMA_CODIGO.test(codigo)) { aviso(`Lleva otro enlace: ${urls[0]}`, 'info'); return; }

    const c = codigos.find((x) => x.codigo === codigo);
    if (!c) { aviso('Es un enlace de canje, pero ya no existe (se borró).', 'error'); return; }
    aviso(c.usadoPor
      ? `${nombreDe(c.recompensa)}${c.etiqueta ? ` · ${c.etiqueta}` : ''}: canjeada por ${c.usadoPorNombre || c.usadoPor} el ${fecha(c.usadoEn)}.`
      : `${nombreDe(c.recompensa)}${c.etiqueta ? ` · ${c.etiqueta}` : ''}: sin canjear.`, c.usadoPor ? 'info' : 'exito');
    // Que se vea en la lista, aunque los filtros la escondan.
    id('filtro-texto').value = codigo;
    id('filtro-tipo').value = 'todos';
    id('filtro-estado').value = 'todos';
    id('filtro-recompensa').value = '';
    pintarLista();
  } catch (error) {
    cerrar();
    const texto = errorNfc(error);
    if (texto) aviso(texto, 'error');
  }
}

// --- Crear ------------------------------------------------------------------------

async function crear({ recompensa, etiqueta }) {
  const c = { codigo: nuevoCodigo(), recompensa, nfc: true, etiqueta };
  await setDoc(doc(db, 'recompensas_codigos', c.codigo), {
    recompensa, nfc: true, etiqueta, por: auth.currentUser.uid, creado: serverTimestamp(),
  });
  codigos.unshift({ ...c, creado: null });
  return c;
}

async function alCrear({ yGrabar }) {
  const recompensa = id('nueva-recompensa').value;
  const etiqueta = id('nueva-etiqueta').value.trim().slice(0, 60);
  if (!recompensa) { aviso('Elige qué da la pegatina.', 'error'); return; }
  const botones = [id('btn-crear-grabar'), id('btn-crear')];
  botones.forEach((b) => { b.disabled = true; });
  try {
    const c = await crear({ recompensa, etiqueta });
    aviso('Enlace creado.', 'exito');
    id('nueva-etiqueta').value = '';
    if (yGrabar) await grabar(c, { bloquear: id('nueva-bloquear').checked });
    await cargar();
  } catch (error) {
    aviso(`No se ha podido crear: ${error.message}`, 'error');
  } finally {
    botones.forEach((b) => { b.disabled = false; });
  }
}

// --- Lista ------------------------------------------------------------------------

/** Lo canjeado mas reciente arriba; lo demas, lo ultimo creado primero. */
function ordenar(a, b) {
  const ua = a.usadoEn?.toMillis?.() || 0;
  const ub = b.usadoEn?.toMillis?.() || 0;
  if (ua || ub) return ub - ua;
  // Recien creado aun no trae la hora del servidor: va el primero.
  const ahora = Date.now();
  return (b.creado?.toMillis?.() ?? ahora) - (a.creado?.toMillis?.() ?? ahora);
}

function filtrados() {
  const tipo = id('filtro-tipo').value;
  const est = id('filtro-estado').value;
  const recompensa = id('filtro-recompensa').value;
  const texto = id('filtro-texto').value.trim().toLowerCase();
  return codigos.filter((c) => (tipo === 'todos' || c.nfc)
    && (est === 'todos' || (est === 'canjeados' ? c.usadoPor : !c.usadoPor))
    && (!recompensa || c.recompensa === recompensa)
    && (!texto || [c.codigo, c.etiqueta, c.usadoPorNombre, nombreDe(c.recompensa)].some((v) => String(v || '').toLowerCase().includes(texto))));
}

function pintarResumen() {
  const nfc = codigos.filter((c) => c.nfc);
  const canjeadas = nfc.filter((c) => c.usadoPor);
  const ultima = canjeadas.reduce((m, c) => (!m || (c.usadoEn?.toMillis?.() || 0) > (m.usadoEn?.toMillis?.() || 0) ? c : m), null);
  const fila = (a, b) => el('div', {}, [el('span', { texto: a }), el('span', { texto: b })]);
  reemplazar(id('resumen'), [
    fila('Pegatinas', String(nfc.length)),
    fila('Grabadas', String(nfc.filter((c) => c.escrito).length)),
    fila('Canjeadas', String(canjeadas.length)),
    fila('Esperando a alguien', String(nfc.length - canjeadas.length)),
    fila('Último canje', ultima ? `${fecha(ultima.usadoEn)} · ${ultima.etiqueta || nombreDe(ultima.recompensa)}` : '—'),
  ]);
}

function campoEtiqueta(c) {
  const campo = el('input', {
    attrs: { type: 'text', maxlength: '60', value: c.etiqueta || '', placeholder: 'Dónde está', 'aria-label': `Dónde está la pegatina ${c.codigo}`, autocomplete: 'off' },
    on: {
      change: async (e) => {
        const etiqueta = e.target.value.trim().slice(0, 60);
        try {
          await updateDoc(doc(db, 'recompensas_codigos', c.codigo), { etiqueta });
          c.etiqueta = etiqueta;
          aviso('Guardado.', 'exito');
        } catch (error) {
          aviso(`No se ha podido guardar: ${error.message}`, 'error');
        }
      },
    },
  });
  return campo;
}

function fila(c) {
  const botones = [];
  if (!c.usadoPor) {
    botones.push(el('button', {
      clase: 'btn', texto: c.escrito ? 'Volver a grabar' : 'Grabar', attrs: { type: 'button' },
      on: { click: async () => { if (await grabar(c)) await cargar(); } },
    }));
    botones.push(el('button', {
      clase: 'btn plano', texto: 'Copiar enlace', attrs: { type: 'button' },
      on: { click: () => copiar(enlaceDe(c.codigo), 'Enlace copiado.') },
    }));
    botones.push(el('button', {
      clase: 'btn plano', texto: 'Borrar', attrs: { type: 'button' },
      on: {
        click: async () => {
          if (!await confirmar('¿Borrar este enlace? Si ya está en una pegatina, dejará de valer.', { textoAceptar: 'Borrar', peligroso: true })) return;
          try {
            await deleteDoc(doc(db, 'recompensas_codigos', c.codigo));
            codigos = codigos.filter((x) => x !== c);
            pintar();
          } catch (error) {
            aviso(`No se ha podido borrar: ${error.message}`, 'error');
          }
        },
      },
    }));
  } else if (c.nfc) {
    // La pegatina sigue pegada pero ya no da nada: un enlace nuevo, mismo sitio.
    botones.push(el('button', {
      clase: 'btn secundario', texto: 'Reponer', attrs: { type: 'button', title: 'Crea un enlace nuevo con lo mismo y lo graba en la pegatina' },
      on: {
        click: async () => {
          try {
            const nuevo = await crear({ recompensa: c.recompensa, etiqueta: c.etiqueta || '' });
            await grabar(nuevo);
            await cargar();
          } catch (error) {
            aviso(`No se ha podido reponer: ${error.message}`, 'error');
          }
        },
      },
    }));
  }

  const estadoCanje = c.usadoPor
    ? el('div', { clase: 'adm-nfc-estado canjeado' }, [
      el('strong', { texto: `Canjeada por ${c.usadoPorNombre || c.usadoPor}` }),
      el('span', { texto: fecha(c.usadoEn) }),
    ])
    : el('div', { clase: 'adm-nfc-estado' }, [
      el('strong', { texto: 'Sin canjear' }),
      el('span', { texto: c.escrito ? `Grabada el ${fecha(c.escrito)}` : (c.nfc ? 'Sin grabar' : 'Enlace de evento') }),
    ]);

  return el('li', { clase: c.usadoPor ? 'usado' : '' }, [
    el('div', { clase: 'adm-nfc-que' }, [
      el('strong', { texto: nombreDe(c.recompensa) }),
      el('code', { texto: c.codigo }),
    ]),
    campoEtiqueta(c),
    estadoCanje,
    el('div', { clase: 'adm-acciones' }, botones),
  ]);
}

function pintarLista() {
  const lista = filtrados().sort(ordenar);
  if (!lista.length) {
    reemplazar(id('lista'), el('p', { clase: 'menor apagado', texto: codigos.some((c) => c.nfc) ? 'Nada con estos filtros.' : 'Todavía no hay ninguna pegatina. Crea la primera arriba.' }));
    return;
  }
  reemplazar(id('lista'), el('ul', { clase: 'adm-nfc-lista' }, lista.map(fila)));
}

function pintar() {
  pintarResumen();
  pintarLista();
}

async function cargar() {
  const snap = await getDocs(collection(db, 'recompensas_codigos'));
  codigos = snap.docs.map((d) => ({ codigo: d.id, ...d.data() }));
  pintar();
}

// --- Arranque ---------------------------------------------------------------------

reemplazar(id('nueva-recompensa'), [
  el('option', { texto: 'Elige…', attrs: { value: '' } }),
  ...RECOMPENSAS.map(([c, texto]) => el('option', { texto, attrs: { value: c } })),
]);
reemplazar(id('filtro-recompensa'), [
  el('option', { texto: 'Todas', attrs: { value: '' } }),
  ...RECOMPENSAS.map(([c, texto]) => el('option', { texto, attrs: { value: c } })),
]);
for (const f of ['filtro-tipo', 'filtro-estado', 'filtro-recompensa']) id(f).addEventListener('change', pintarLista);
id('filtro-texto').addEventListener('input', pintarLista);

if (!HAY_NFC) {
  estado(id('aviso-nfc'), 'Este navegador no puede grabar NFC (solo Chrome en Android). Puedes crear las pegatinas y copiar los enlaces.', 'info');
  id('btn-crear-grabar').textContent = 'Crear y copiar enlace';
}

id('btn-crear-grabar').addEventListener('click', () => alCrear({ yGrabar: true }));
id('btn-crear').addEventListener('click', () => alCrear({ yGrabar: false }));
id('btn-leer').addEventListener('click', leer);
id('btn-recargar').addEventListener('click', () => cargar().then(() => aviso('Actualizado.', 'exito')).catch((error) => aviso(`No se ha podido leer: ${error.message}`, 'error')));

exigirAdmin('nfc').then(cargar).catch((error) => {
  aviso(`No se ha podido abrir: ${error.message}`, 'error');
});
