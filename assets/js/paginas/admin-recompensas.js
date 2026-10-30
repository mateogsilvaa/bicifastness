// Modulo de la pagina /admin/recompensas/: como se consigue cada banner y cada lema.
//
// Tres modos por recompensa (assets/data/recompensas.js, `TIPOS_RECOMPENSA`):
//   a mano  solo si se la das tu (Pilotos y clanes, buscando al piloto)
//   evento  eliges cuantas repartes y sale un enlace de un solo uso por cada una
//   logro   la tiene quien tenga cierta insignia, ahora y en adelante
//
// Lo que se guarda (`config/recompensas`) lo leen la web (que dice al ver algo
// bloqueado) y las reglas de Firestore (que dejan ponerse lo desbloqueado por
// logro). Los enlaces (`recompensas_codigos`) solo los ve la administracion; el
// worker (backend/src/canjes.js) es quien decide cada canje.

import {
  auth, db, doc, getDoc, getDocs, setDoc, collection, query, where, writeBatch, serverTimestamp,
} from '/assets/js/firebase.js';
import { iniciarPagina } from '/assets/js/ui.js';
import { id, el, estado, reemplazar, confirmar } from '/assets/js/dom.js';
import { montarCabeceraAdmin, exigirAdmin } from '/assets/js/admin-cabecera.js';
import { BANNERS, LEMAS, TIPOS_RECOMPENSA, esLibre, tipoDe } from '/assets/data/recompensas.js';
import { INSIGNIAS } from '/assets/data/insignias.js';
import { banner, lema } from '/assets/js/perfil-publico.js';
import { nuevoCodigo, enlaceDe } from '/assets/js/enlaces-canje.js';

iniciarPagina('admin');
montarCabeceraAdmin('recompensas');

/** Cuantos enlaces se pueden crear de una vez (un lote de Firestore admite 500). */
const MAX_REPARTO = 200;

let config = { items: {} };

async function copiar(texto, aviso) {
  try {
    await navigator.clipboard.writeText(texto);
    estado(id('mensaje'), aviso, 'exito');
  } catch {
    estado(id('mensaje'), 'No se ha podido copiar. Selecciónalo y cópialo a mano.', 'error');
  }
}

async function guardar({ avisar = true } = {}) {
  // Solo se guarda lo que no es "a mano": lo demas es lo normal y no hace falta decirlo.
  const items = {};
  for (const [clave, item] of Object.entries(config.items)) {
    if (item.tipo === 'evento') items[clave] = { tipo: 'evento' };
    if (item.tipo === 'logro') {
      if (!INSIGNIAS[item.logro]) throw new Error(`Elige la insignia de «${clave}» (o ponla a mano).`);
      items[clave] = { tipo: 'logro', logro: item.logro };
    }
  }
  await setDoc(doc(db, 'config', 'recompensas'), {
    items, por: auth.currentUser.uid, actualizado: serverTimestamp(),
  });
  config = { items };
  if (avisar) estado(id('mensaje'), 'Guardado.', 'exito');
}

// --- Enlaces de un evento ---------------------------------------------------------

async function pintarEnlaces(destino, recompensa) {
  reemplazar(destino, el('div', { clase: 'esqueleto', attrs: { 'aria-hidden': 'true' }, estilo: { height: '60px' } }));
  const snap = await getDocs(query(collection(db, 'recompensas_codigos'), where('recompensa', '==', recompensa)));
  const codigos = snap.docs.map((d) => ({ codigo: d.id, ...d.data() }))
    .sort((a, b) => Number(Boolean(a.usadoPor)) - Number(Boolean(b.usadoPor)) || a.codigo.localeCompare(b.codigo));
  const libres = codigos.filter((c) => !c.usadoPor);

  if (!codigos.length) {
    reemplazar(destino, el('p', { clase: 'menor apagado', texto: 'Todavía no has creado ningún enlace.' }));
    return { libres: 0, total: 0 };
  }

  reemplazar(destino, [
    el('div', { clase: 'adm-fila-botones' }, [
      el('button', {
        clase: 'btn secundario', texto: `Copiar los ${libres.length} libres`, attrs: { type: 'button', disabled: libres.length ? null : '' },
        on: { click: () => copiar(libres.map((c) => enlaceDe(c.codigo)).join('\n'), `${libres.length} enlaces copiados, uno por línea.`) },
      }),
      el('button', {
        clase: 'btn plano', texto: 'Borrar los libres', attrs: { type: 'button', disabled: libres.length ? null : '' },
        on: {
          click: async () => {
            if (!await confirmar(`¿Borrar los ${libres.length} enlaces sin usar? Los que ya has repartido dejarán de valer.`, { textoAceptar: 'Borrar', peligroso: true })) return;
            const lote = writeBatch(db);
            for (const c of libres) lote.delete(doc(db, 'recompensas_codigos', c.codigo));
            await lote.commit();
            await pintarEnlaces(destino, recompensa);
          },
        },
      }),
    ]),
    el('ul', { clase: 'adm-enlaces' }, codigos.map((c) => el('li', { clase: c.usadoPor ? 'usado' : '' }, [
      el('code', { texto: c.codigo }),
      c.usadoPor
        ? el('span', { clase: 'apagado', texto: `Canjeado por ${c.usadoPorNombre || c.usadoPor}` })
        : el('button', {
          clase: 'btn plano', texto: 'Copiar enlace', attrs: { type: 'button' },
          on: { click: () => copiar(enlaceDe(c.codigo), 'Enlace copiado.') },
        }),
    ]))),
  ]);
  return { libres: libres.length, total: codigos.length };
}

// --- Una tarjeta por recompensa -----------------------------------------------------

const OPCIONES_LOGRO = Object.entries(INSIGNIAS).map(([clave, i]) => [clave, `${i.titulo} · ${i.descripcion}`]);

function tarjeta(clave, { vista, nombre, tipoDeRecompensa }) {
  const item = config.items[clave] || { tipo: 'manual' };
  const extra = el('div', { clase: 'adm-extra' });
  const resumen = el('span', { clase: 'apagado' });

  const pintarExtra = () => {
    const tipo = tipoDe(clave, { items: { [clave]: item } });
    if (tipo === 'logro') {
      const selector = el('select', {
        attrs: { 'aria-label': `Insignia que desbloquea ${nombre}` },
        on: { change: (e) => { item.logro = e.target.value; config.items[clave] = item; } },
      }, [
        el('option', { texto: 'Elige una insignia…', attrs: { value: '' } }),
        ...OPCIONES_LOGRO.map(([k, texto]) => el('option', { texto, attrs: { value: k, selected: item.logro === k ? '' : null } })),
      ]);
      reemplazar(extra, [el('label', { clase: 'campo' }, ['Se desbloquea con la insignia', selector])]);
      resumen.textContent = '';
    } else if (tipo === 'evento') {
      const cuantos = el('input', { attrs: { type: 'number', min: '1', max: String(MAX_REPARTO), value: '10', inputmode: 'numeric', 'aria-label': 'Cuántos enlaces crear' } });
      const lista = el('div');
      const repartir = el('button', {
        clase: 'btn', texto: 'Crear enlaces', attrs: { type: 'button' },
        on: {
          click: async () => {
            const n = Math.floor(Number(cuantos.value));
            if (!(n >= 1 && n <= MAX_REPARTO)) { estado(id('mensaje'), `Entre 1 y ${MAX_REPARTO} enlaces.`, 'error'); return; }
            repartir.disabled = true;
            try {
              // Sin esto, lo que se reparte y lo que dice la config no coincidirian.
              config.items[clave] = { tipo: 'evento' };
              await guardar({ avisar: false });
              const lote = writeBatch(db);
              for (let i = 0; i < n; i++) {
                lote.set(doc(db, 'recompensas_codigos', nuevoCodigo()), { recompensa: clave, por: auth.currentUser.uid, creado: serverTimestamp() });
              }
              await lote.commit();
              estado(id('mensaje'), `${n} enlaces creados. Cópialos y repártelos.`, 'exito');
              const r = await pintarEnlaces(lista, clave);
              resumen.textContent = `${r.libres} libres de ${r.total}`;
            } catch (error) {
              estado(id('mensaje'), `No se han podido crear: ${error.message}`, 'error');
            } finally {
              repartir.disabled = false;
            }
          },
        },
      });
      const detalles = el('details', { clase: 'adm-detalles' }, [el('summary', { texto: 'Ver los enlaces' }), lista]);
      detalles.addEventListener('toggle', () => {
        if (detalles.open) pintarEnlaces(lista, clave).then((r) => { resumen.textContent = `${r.libres} libres de ${r.total}`; });
      }, { once: true });
      reemplazar(extra, [
        el('div', { clase: 'adm-fila-botones' }, [
          el('label', { clase: 'campo' }, ['Cuántos repartes', cuantos]),
          repartir,
        ]),
        detalles,
      ]);
    } else {
      reemplazar(extra, el('p', { clase: 'menor apagado', texto: 'Solo la tiene quien se la des tú, desde Pilotos y clanes.' }));
      resumen.textContent = '';
    }
  };

  const modo = el('select', {
    attrs: { 'aria-label': `Cómo se consigue ${nombre}` },
    on: {
      change: (e) => {
        item.tipo = e.target.value;
        if (item.tipo !== 'logro') delete item.logro;
        config.items[clave] = item;
        pintarExtra();
      },
    },
  }, Object.entries(TIPOS_RECOMPENSA).map(([valor, texto]) => el('option', {
    texto, attrs: { value: valor, selected: tipoDe(clave, { items: { [clave]: item } }) === valor ? '' : null },
  })));

  pintarExtra();
  return el('section', { clase: 'adm-tarjeta adm-recompensa', attrs: { 'aria-label': nombre } }, [
    el('div', { clase: 'adm-recompensa-cabeza' }, [
      vista,
      el('div', {}, [el('strong', { texto: nombre }), el('span', { clase: 'apagado', texto: tipoDeRecompensa }), resumen]),
      modo,
    ]),
    extra,
  ]);
}

function pintar() {
  const ganables = [
    ...Object.entries(BANNERS).filter(([c]) => !esLibre(c)).map(([c, b]) => [c, {
      vista: banner(c, { clase: 'mini' }), nombre: b.titulo, tipoDeRecompensa: 'Banner',
    }]),
    ...Object.entries(LEMAS).filter(([c]) => !esLibre(c)).map(([c, l]) => [c, {
      vista: el('div', { clase: 'adm-lema' }, [lema(c)]), nombre: l.texto, tipoDeRecompensa: 'Lema',
    }]),
  ];
  reemplazar(id('recompensas'), ganables.map(([clave, datos]) => tarjeta(clave, datos)));
}

id('btn-guardar').addEventListener('click', async () => {
  const boton = id('btn-guardar');
  boton.disabled = true;
  try {
    await guardar();
  } catch (error) {
    estado(id('mensaje'), `No se ha podido guardar: ${error.message}`, 'error');
  } finally {
    boton.disabled = false;
  }
});

exigirAdmin('recompensas').then(async () => {
  try {
    const snap = await getDoc(doc(db, 'config', 'recompensas'));
    if (snap.exists() && snap.data().items) config = { items: snap.data().items };
  } catch (error) {
    estado(id('mensaje'), `No se ha podido leer la configuración: ${error.message}`, 'error');
  }
  pintar();
}).catch((error) => {
  estado(id('mensaje'), `No se ha podido abrir: ${error.message}`, 'error');
});
