// Modulo de la pagina /tienda/: el producto con tus marcas y el paso al pago.
//
// El flujo, sin servidor propio (docs/TIENDA.md):
//   1. Aqui se pinta la vista previa con TUS datos (assets/js/tienda-diseno.js).
//   2. "Comprar" crea un pedido borrador en Firestore (producto, talla y que
//      trayecto imprimir) y lleva al enlace de pago de Stripe con el id del
//      pedido como `client_reference_id`.
//   3. El worker ve el pago en Stripe, vuelve a sacar los datos de la base de
//      datos (no de aqui), genera el fichero de impresion con el MISMO diseño y
//      manda el pedido al proveedor de impresion bajo demanda.

import {
  auth, db, onAuthStateChanged, doc, getDoc, getDocs, setDoc, collection, query, where, orderBy, limit,
  serverTimestamp,
} from '/assets/js/firebase.js';
import { iniciarPagina, nombreEstacion, formatearTiempo } from '/assets/js/ui.js';
import { id, el, estado, reemplazar } from '/assets/js/dom.js';
import { traerAgregado } from '/assets/js/agregados.js';
import { EMBLEMAS } from '/assets/data/emblemas-clan.js';
import { leerTienda, productosALaVenta } from '/assets/js/tienda.js';
import { disenoSVG, PRODUCTOS_DISENO } from '/assets/js/tienda-diseno.js';

iniciarPagina('yo');

const ORDEN_TALLAS = ['XS', 'S', 'M', 'L', 'XL', '2XL', 'XXL', '3XL'];
const euros = (n) => `${Number(n).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

const ESTADOS_PEDIDO = {
  borrador: 'Sin pagar',
  pagado: 'Pagado: preparando el diseño',
  en_proveedor: 'Pagado: en manos de la imprenta',
  en_produccion: 'Imprimiéndose',
  enviado: 'Enviado',
  revisar: 'Pagado: lo estamos revisando',
  error: 'Ha habido un problema: te escribimos',
};

/** Lo que sale impreso, con los datos de este piloto. El worker hace lo mismo. */
function datosDiseno(perfil, clan, viaje, puesto) {
  const [o, d] = String(viaje?.ruta || '').split('-');
  return {
    nombre: perfil.username,
    clan: clan ? {
      nombre: clan.nombre, color: clan.color,
      emblemaD: EMBLEMAS[clan.emblema]?.d || null,
      texto: clan.siglas || String(clan.nombre || '').split(/\s+/).map((p) => [...p][0] || '').join('').slice(0, 3).toUpperCase(),
    } : null,
    tiempo: viaje ? formatearTiempo(viaje.tiempoSegundos) : null,
    origen: viaje ? nombreEstacion(o) || o : null,
    destino: viaje ? nombreEstacion(d) || d : null,
    puesto: puesto?.pos || null,
    total: puesto?.total || null,
  };
}

/**
 * La mejor marca de cada tramo: el trayecto verificado mas rapido de cada ruta.
 * La primera es la del tramo donde mas puntos tienes, que es "tu" ruta.
 */
function mejoresMarcas(viajes, perfil) {
  const porRuta = new Map();
  for (const v of viajes) {
    const actual = porRuta.get(v.ruta);
    if (!actual || v.tiempoSegundos < actual.tiempoSegundos) porRuta.set(v.ruta, v);
  }
  const puntos = perfil.puntosPorRuta || {};
  return [...porRuta.values()].sort((a, b) => (puntos[b.ruta] || 0) - (puntos[a.ruta] || 0)).slice(0, 12);
}

function imagenDiseno(producto, datos) {
  const svg = disenoSVG(producto, datos, { muestra: true });
  return el('img', {
    clase: `tienda-muestra ${producto}`,
    attrs: { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, alt: `Vista previa: ${PRODUCTOS_DISENO[producto].nombre} con tus datos` },
  });
}

/** El siguiente id libre de hoy (las reglas dejan cinco al dia). */
async function idPedidoNuevo(uid) {
  const dia = Math.floor(Date.now() / 864e5);
  const snap = await getDocs(query(collection(db, 'pedidos_tienda'), where('uid', '==', uid)));
  const usados = new Set(snap.docs.map((d) => d.id));
  for (let k = 0; k < 5; k++) {
    const candidato = `${uid}_${dia}_${k}`;
    if (!usados.has(candidato)) return candidato;
  }
  throw new Error('Por hoy ya has empezado cinco pedidos. Vuelve mañana.');
}

async function comprar(boton, { uid, producto, variante, viaje }) {
  const original = boton.textContent;
  boton.disabled = true;
  boton.textContent = 'Preparando el pago…';
  try {
    const pedidoId = await idPedidoNuevo(uid);
    await setDoc(doc(db, 'pedidos_tienda', pedidoId), {
      uid, producto: producto.clave, variante, ...(viaje ? { viajeId: viaje.id } : {}),
      estado: 'borrador', creado: serverTimestamp(),
    });
    // Sin el correo en la URL: Stripe lo pide en el propio pago.
    window.location.href = `${producto.enlacePago}?client_reference_id=${encodeURIComponent(pedidoId)}`;
  } catch (error) {
    estado(id('mensaje'), error.message || 'No se ha podido preparar el pago.', 'error');
    boton.disabled = false;
    boton.textContent = original;
  }
}

function pintarTienda({ usuario, perfil, clan, marcas, puesto, productos }) {
  const elegido = { producto: productos[0], viaje: marcas[0] || null, variante: null };
  const muestra = el('div', { clase: 'tienda-muestra-marco' });
  const tallas = el('div', { clase: 'tienda-opciones', attrs: { role: 'radiogroup', 'aria-label': 'Talla' } });
  const boton = el('button', { clase: 'btn grande', attrs: { type: 'button' } });
  const rotuloTalla = el('span', { clase: 'rotulo', texto: 'Talla' });

  const pintar = () => {
    const variantes = Object.keys(elegido.producto.variantes || {})
      .sort((a, b) => (ORDEN_TALLAS.indexOf(a) + 1 || 99) - (ORDEN_TALLAS.indexOf(b) + 1 || 99));
    if (!variantes.includes(elegido.variante)) elegido.variante = variantes.includes('M') ? 'M' : variantes[0] || null;
    reemplazar(muestra, imagenDiseno(elegido.producto.clave, datosDiseno(perfil, clan, elegido.viaje, puesto)));
    reemplazar(tallas, variantes.length > 1 ? variantes.map((v) => el('button', {
      attrs: { type: 'button', role: 'radio', 'aria-checked': String(v === elegido.variante), 'aria-pressed': String(v === elegido.variante) },
      texto: v, on: { click: () => { elegido.variante = v; pintar(); } },
    })) : []);
    tallas.classList.toggle('oculto', variantes.length <= 1);
    rotuloTalla.classList.toggle('oculto', variantes.length <= 1);
    boton.textContent = `Comprar · ${euros(elegido.producto.precio)}`;
    boton.disabled = !elegido.variante;
  };

  const productosNodo = el('div', { clase: 'tienda-opciones', attrs: { role: 'radiogroup', 'aria-label': 'Producto' } });
  const pintarProductos = () => reemplazar(productosNodo, productos.map((p) => el('button', {
    attrs: { type: 'button', role: 'radio', 'aria-checked': String(p === elegido.producto), 'aria-pressed': String(p === elegido.producto) },
    texto: `${PRODUCTOS_DISENO[p.clave]?.nombre || p.clave} · ${euros(p.precio)}`,
    on: { click: () => { elegido.producto = p; pintarProductos(); pintar(); } },
  })));
  pintarProductos();

  const selectorMarca = marcas.length ? el('select', {
    attrs: { id: 'tienda-marca', 'aria-label': 'Qué tiempo imprimir' },
    on: { change: (e) => { elegido.viaje = marcas[Number(e.target.value)] || null; pintar(); } },
  }, marcas.map((v, i) => {
    const [o, d] = String(v.ruta).split('-');
    return el('option', { attrs: { value: String(i) }, texto: `${formatearTiempo(v.tiempoSegundos)} · ${nombreEstacion(o) || o} → ${nombreEstacion(d) || d}` });
  })) : null;

  boton.addEventListener('click', () => comprar(boton, {
    uid: usuario.uid, producto: elegido.producto, variante: elegido.variante, viaje: elegido.viaje,
  }));

  reemplazar(id('tienda-contenido'), el('div', { clase: 'tienda-producto' }, [
    muestra,
    el('div', { clase: 'tienda-ajustes' }, [
      el('span', { clase: 'rotulo', texto: 'Producto' }),
      productosNodo,
      selectorMarca ? el('label', { clase: 'campo', attrs: { for: 'tienda-marca' } }, ['Qué tiempo imprimir', selectorMarca]) : null,
      rotuloTalla,
      tallas,
      boton,
      el('p', {
        clase: 'menor apagado',
        texto: 'Se imprime con tus datos del momento del pago. Pagas en Stripe y te llega a casa en una o dos semanas.',
      }),
    ]),
  ]));
  pintar();
}

async function pintarPedidos(uid) {
  try {
    const snap = await getDocs(query(collection(db, 'pedidos_tienda'), where('uid', '==', uid), orderBy('creado', 'desc'), limit(10)));
    // Los borradores sin pagar no son pedidos: no se enseñan.
    const pedidos = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.estado !== 'borrador');
    if (!pedidos.length) return;
    reemplazar(id('lista-pedidos'), pedidos.map((p) => el('div', { clase: 'tienda-pedido' }, [
      el('strong', { texto: `${PRODUCTOS_DISENO[p.producto]?.nombre || p.producto}${p.variante && p.variante !== 'unica' ? ` · ${p.variante}` : ''}` }),
      el('span', { clase: `chip ${p.estado === 'error' ? 'rechazado' : p.estado === 'enviado' ? 'verificado' : 'revision'}`, texto: ESTADOS_PEDIDO[p.estado] || p.estado }),
    ])));
    id('mis-pedidos').classList.remove('oculto');
  } catch {
    /* sin lista de pedidos la tienda funciona igual */
  }
}

onAuthStateChanged(auth, async (usuario) => {
  if (new URLSearchParams(window.location.search).has('gracias')) {
    estado(id('mensaje'), '¡Gracias! El pago ha llegado bien. En unos minutos tu pedido pasa a la imprenta y te avisamos cuando salga.', 'exito');
  }
  if (!usuario) {
    reemplazar(id('tienda-contenido'), el('div', { clase: 'vacio' }, [
      el('p', { texto: 'Los productos llevan tus marcas, así que hace falta entrar.' }),
      el('a', { clase: 'btn', texto: 'Entrar', attrs: { href: '/entrar/' } }),
    ]));
    return;
  }

  try {
    const [config, perfilSnap, token] = await Promise.all([
      leerTienda({ fresca: true }),
      getDoc(doc(db, 'usuarios', usuario.uid)),
      usuario.getIdTokenResult().catch(() => null),
    ]);
    const esAdmin = token?.claims?.admin === true;
    // La administracion la puede probar cerrada; el resto, solo abierta.
    const productos = productosALaVenta(esAdmin && config ? { ...config, visible: true } : config);
    if (!productos.length) {
      reemplazar(id('tienda-contenido'), el('div', { clase: 'vacio' }, [
        el('p', { texto: 'La tienda está cerrada ahora mismo. Vuelve pronto.' }),
      ]));
      return;
    }
    if (esAdmin && !config?.visible) estado(id('mensaje'), 'Vista de administración: la tienda está oculta para el resto.', 'info');

    const perfil = perfilSnap.exists() ? perfilSnap.data() : { username: usuario.displayName || 'Piloto' };
    const [clanSnap, viajesSnap, ranking] = await Promise.all([
      perfil.clanId ? getDoc(doc(db, 'clanes', perfil.clanId)).catch(() => null) : null,
      getDocs(query(collection(db, 'tiempos_viaje'), where('uid', '==', usuario.uid), where('verificado', '==', true), orderBy('creado', 'desc'), limit(40))),
      traerAgregado('ranking-general').catch(() => null),
    ]);
    const fila = ranking?.filas?.find((f) => f.nombre === perfil.username);
    const puesto = fila ? { pos: fila.pos, total: ranking.total ?? ranking.filas.length } : null;
    const marcas = mejoresMarcas(viajesSnap.docs.map((d) => ({ id: d.id, ...d.data() })), perfil);

    if (!marcas.length) {
      reemplazar(id('tienda-contenido'), el('div', { clase: 'vacio' }, [
        el('p', { texto: 'Tu camiseta lleva tu mejor tiempo, y todavía no tienes ningún trayecto verificado.' }),
        el('a', { clase: 'btn', texto: 'Subir un trayecto', attrs: { href: '/subir/' } }),
      ]));
      return;
    }

    pintarTienda({ usuario, perfil, clan: clanSnap?.exists?.() ? clanSnap.data() : null, marcas, puesto, productos });
    pintarPedidos(usuario.uid);
  } catch (error) {
    reemplazar(id('tienda-contenido'), el('div', { clase: 'vacio', texto: `No se ha podido cargar la tienda: ${error.message}` }));
  }
});
