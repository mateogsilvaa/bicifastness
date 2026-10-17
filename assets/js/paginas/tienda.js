// Modulo de la pagina /tienda/: la coleccion de Printful, el producto con tus
// marcas y el paso al pago.
//
// La coleccion son los productos ya montados en Printful, con sus fotos y sus
// precios (los copia el worker a `config/tienda_catalogo`). Se ven sin entrar;
// para comprar hace falta cuenta, porque el pedido se apunta a tu nombre.
//
// El flujo de los personalizados, sin servidor propio (docs/TIENDA.md):
//   1. Aqui se pinta la vista previa con TUS datos (assets/js/tienda-diseno.js).
//   2. "Comprar" crea un pedido borrador en Firestore (producto, talla y que
//      trayecto imprimir) y lleva al producto en Gumroad con el id del pedido
//      en la URL, que rellena el campo personalizado `pedido` del pago.
//   3. El worker ve la venta en Gumroad, vuelve a sacar los datos de la base de
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
import { leerTienda, leerCatalogo, productosALaVenta, catalogoALaVenta } from '/assets/js/tienda.js';
import { disenoSVG, PRODUCTOS_DISENO } from '/assets/js/tienda-diseno.js';

iniciarPagina('yo');

const ORDEN_TALLAS = ['XS', 'S', 'M', 'L', 'XL', '2XL', 'XXL', '3XL'];
const euros = (n) => `${Number(n).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
/** El precio en su moneda (el catalogo trae la de Printful, normalmente EUR). */
function precio(n, moneda = 'EUR') {
  try {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency: moneda }).format(n);
  } catch {
    return euros(n);
  }
}

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
    // Sin el correo en la URL: Gumroad lo pide en el propio pago. `wanted=true`
    // va directo al pago, y `pedido` rellena el campo personalizado del mismo
    // nombre, que es por donde el worker sabe que imprimir.
    const destino = new URL(producto.enlacePago);
    destino.searchParams.set('wanted', 'true');
    destino.searchParams.set('pedido', pedidoId);
    window.location.href = destino.href;
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
        texto: 'Se imprime con tus datos del momento del pago. Pagas en Gumroad, que suma el envío y los impuestos de tu país, y te llega a casa en una o dos semanas.',
      }),
    ]),
  ]));
  pintar();
}

/**
 * La coleccion: una rejilla de fichas y, al tocar una, su detalle con las
 * tallas y el boton de comprar.
 */
function pintarCatalogo({ usuario, productos }) {
  const contenedor = id('catalogo-contenido');
  id('tienda-catalogo').classList.remove('oculto');

  const rejilla = () => reemplazar(contenedor, el('div', { clase: 'tienda-rejilla' }, productos.map((p) => el('button', {
    clase: 'tienda-ficha',
    attrs: { type: 'button', 'aria-label': `${p.nombre}, desde ${precio(p.variantes[0].precio, p.variantes[0].moneda)}` },
    on: { click: () => detalle(p) },
  }, [
    p.imagen || p.variantes[0].imagen
      ? el('img', { attrs: { src: p.imagen || p.variantes[0].imagen, alt: '', loading: 'lazy' } })
      : el('span', { clase: 'tienda-ficha-sinfoto' }),
    el('strong', { texto: p.nombre }),
    // "desde" solo si las tallas no cuestan todas lo mismo.
    el('span', { texto: `${p.variantes.at(-1).precio > p.variantes[0].precio ? 'desde ' : ''}${precio(p.variantes[0].precio, p.variantes[0].moneda)}` }),
  ]))));

  const detalle = (p) => {
    let elegida = p.variantes[0];
    const foto = el('div', { clase: 'tienda-muestra-marco' });
    const opciones = el('div', { clase: 'tienda-opciones', attrs: { role: 'radiogroup', 'aria-label': 'Talla o modelo' } });
    const boton = el('button', { clase: 'btn grande', attrs: { type: 'button' } });
    const pintar = () => {
      const src = elegida.imagen || p.imagen;
      reemplazar(foto, src ? el('img', { clase: 'tienda-muestra', attrs: { src, alt: `${p.nombre} · ${elegida.nombre}` } }) : null);
      foto.classList.toggle('oculto', !src);
      reemplazar(opciones, p.variantes.length > 1 ? p.variantes.map((v) => el('button', {
        attrs: { type: 'button', role: 'radio', 'aria-checked': String(v === elegida), 'aria-pressed': String(v === elegida) },
        texto: v.nombre, on: { click: () => { elegida = v; pintar(); } },
      })) : []);
      boton.textContent = usuario ? `Comprar · ${precio(elegida.precio, elegida.moneda)}` : 'Entra para comprar';
    };
    boton.addEventListener('click', () => {
      if (!usuario) { window.location.href = '/entrar/'; return; }
      comprar(boton, { uid: usuario.uid, producto: p, variante: elegida.id, viaje: null });
    });
    reemplazar(contenedor, el('div', { clase: 'tienda-producto' }, [
      foto,
      el('div', { clase: 'tienda-ajustes' }, [
        el('button', { clase: 'btn plano tienda-volver', attrs: { type: 'button' }, texto: '← Toda la colección', on: { click: rejilla } }),
        el('h3', { texto: p.nombre }),
        opciones,
        boton,
        el('p', { clase: 'menor apagado', texto: 'Pagas en Gumroad, que suma el envío y los impuestos de tu país. Lo fabrica y lo envía Printful.' }),
      ]),
    ]));
    pintar();
  };

  rejilla();
}

async function pintarPedidos(uid, catalogo) {
  try {
    const snap = await getDocs(query(collection(db, 'pedidos_tienda'), where('uid', '==', uid), orderBy('creado', 'desc'), limit(10)));
    // Los borradores sin pagar no son pedidos: no se enseñan.
    const pedidos = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.estado !== 'borrador');
    if (!pedidos.length) return;
    reemplazar(id('lista-pedidos'), pedidos.map((p) => el('div', { clase: 'tienda-pedido' }, [
      el('strong', { texto: nombrePedido(p, catalogo) }),
      el('span', { clase: `chip ${p.estado === 'error' ? 'rechazado' : p.estado === 'enviado' ? 'verificado' : 'revision'}`, texto: ESTADOS_PEDIDO[p.estado] || p.estado }),
    ])));
    id('mis-pedidos').classList.remove('oculto');
  } catch {
    /* sin lista de pedidos la tienda funciona igual */
  }
}

/** "Camiseta · M" o "Sudadera · L · Negro": el producto de un pedido, con su variante. */
function nombrePedido(p, catalogo) {
  const pf = String(p.producto || '').match(/^pf_(\d+)$/);
  if (pf) {
    const prod = catalogo?.productos?.[pf[1]];
    const variante = prod?.variantes?.[p.variante]?.nombre;
    return prod ? `${prod.nombre}${variante ? ` · ${variante}` : ''}` : 'Producto de la colección';
  }
  return `${PRODUCTOS_DISENO[p.producto]?.nombre || p.producto}${p.variante && p.variante !== 'unica' ? ` · ${p.variante}` : ''}`;
}

onAuthStateChanged(auth, async (usuario) => {
  if (new URLSearchParams(window.location.search).has('gracias')) {
    estado(id('mensaje'), '¡Gracias! El pago ha llegado bien. En unos minutos tu pedido pasa a la imprenta y te avisamos cuando salga.', 'exito');
  }

  try {
    const [config, catalogo, perfilSnap, token] = await Promise.all([
      leerTienda({ fresca: true }),
      leerCatalogo(),
      usuario ? getDoc(doc(db, 'usuarios', usuario.uid)) : null,
      usuario ? usuario.getIdTokenResult().catch(() => null) : null,
    ]);
    const esAdmin = token?.claims?.admin === true;
    // La administracion la puede probar cerrada; el resto, solo abierta.
    const vista = esAdmin && config ? { ...config, visible: true } : config;
    const productos = productosALaVenta(vista);
    const coleccion = catalogoALaVenta(vista, catalogo);
    if (!productos.length && !coleccion.length) {
      id('t-personal').classList.add('oculto');
      reemplazar(id('tienda-contenido'), el('div', { clase: 'vacio' }, [
        el('p', { texto: 'La tienda está cerrada ahora mismo. Vuelve pronto.' }),
      ]));
      return;
    }
    if (esAdmin && !config?.visible) estado(id('mensaje'), 'Vista de administración: la tienda está oculta para el resto.', 'info');
    if (coleccion.length) pintarCatalogo({ usuario, productos: coleccion });
    if (usuario) pintarPedidos(usuario.uid, catalogo);

    // --- Con tus marcas ---
    if (!productos.length) {
      id('tienda-personal').classList.add('oculto');
      return;
    }
    if (!usuario) {
      reemplazar(id('tienda-contenido'), el('div', { clase: 'vacio' }, [
        el('p', { texto: 'Estos llevan tus marcas, así que hace falta entrar.' }),
        el('a', { clase: 'btn', texto: 'Entrar', attrs: { href: '/entrar/' } }),
      ]));
      return;
    }

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
  } catch (error) {
    reemplazar(id('tienda-contenido'), el('div', { clase: 'vacio', texto: `No se ha podido cargar la tienda: ${error.message}` }));
  }
});
