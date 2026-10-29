// Modulo de la pagina /tienda/: el producto con tus marcas, las gemas y el
// paso al pago.
//
// El flujo, sin servidor propio (docs/TIENDA.md):
//   1. Aqui se pinta la vista previa con TUS datos (assets/js/tienda-diseno.js).
//   2. "Comprar" pide la direccion de envio (la recogemos nosotros: en Polar se
//      vende un articulo digital y el regalo fisico va aparte), crea un pedido
//      borrador en Firestore y lleva al enlace de pago de Polar con tu uid y el
//      id del pedido.
//   3. El worker ve el pago en Polar, lo casa con el pedido, vuelve a sacar los
//      datos de la base de datos (no de aqui), genera el fichero de impresion
//      con el MISMO diseño y lo manda a la imprenta (o te lo deja para enviar a
//      mano).
//   4. Las gemas igual: un pack en Polar las suma al perfil, y gastarlas en un
//      banner o un lema lo decide el worker (`canjes_gemas`).

import {
  auth, db, onAuthStateChanged, doc, getDoc, getDocs, setDoc, collection, query, where, orderBy, limit,
  serverTimestamp, onSnapshot,
} from '/assets/js/firebase.js';
import { iniciarPagina, nombreEstacion, formatearTiempo } from '/assets/js/ui.js';
import { id, el, estado, reemplazar, abrirHoja } from '/assets/js/dom.js';
import { traerAgregado } from '/assets/js/agregados.js';
import { EMBLEMAS } from '/assets/data/emblemas-clan.js';
import { BANNERS, LEMAS } from '/assets/data/recompensas.js';
import { banner as dibujoBanner, lema as dibujoLema } from '/assets/js/perfil-publico.js';
import { leerTienda, productosALaVenta, packsALaVenta, enlaceDePago } from '/assets/js/tienda.js';
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
  preparar: 'Pagado: lo estamos preparando',
  entregado: 'Entregado',
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

/** Crea el borrador y lleva a pagar a Polar. */
async function irAPagar(boton, uid, enlace, datosPedido) {
  const original = boton.textContent;
  boton.disabled = true;
  boton.textContent = 'Preparando el pago…';
  try {
    const pedidoId = await idPedidoNuevo(uid);
    await setDoc(doc(db, 'pedidos_tienda', pedidoId), { uid, ...datosPedido, estado: 'borrador', creado: serverTimestamp() });
    window.location.href = enlaceDePago(enlace, uid, pedidoId);
  } catch (error) {
    estado(id('mensaje'), error.message || 'No se ha podido preparar el pago.', 'error');
    boton.disabled = false;
    boton.textContent = original;
  }
}

// --- La direccion de envio ------------------------------------------------------
//
// La recogemos nosotros: en Polar se compra un articulo digital y Polar no pide
// direccion. Se guarda en el pedido (solo lo leen tu y la administracion) y,
// para la proxima vez, en este navegador.

const CLAVE_ENVIO = 'bf_envio';
const PAISES = [['ES', 'España'], ['PT', 'Portugal'], ['FR', 'Francia'], ['IT', 'Italia'], ['DE', 'Alemania'], ['NL', 'Países Bajos'], ['BE', 'Bélgica'], ['IE', 'Irlanda'], ['AT', 'Austria']];

function pedirEnvio() {
  let previo = {};
  try { previo = JSON.parse(localStorage.getItem(CLAVE_ENVIO) || '{}') || {}; } catch { /* vacio */ }
  return new Promise((resolver) => {
    let hecho = false;
    const campo = (nombre, etiqueta, attrs = {}) => el('div', { clase: 'campo' }, [
      el('label', { attrs: { for: `envio-${nombre}` }, texto: etiqueta }),
      el('input', { attrs: { id: `envio-${nombre}`, name: nombre, value: previo[nombre] || '', ...attrs } }),
    ]);
    const pais = el('select', { attrs: { id: 'envio-pais', name: 'pais' } }, PAISES.map(([c, n]) => el('option', {
      attrs: { value: c, ...(c === (previo.pais || 'ES') ? { selected: '' } : {}) }, texto: n,
    })));
    const msg = el('p', { clase: 'mensaje', attrs: { 'aria-live': 'polite' } });
    const form = el('form', { clase: 'form-envio', attrs: { novalidate: '' } }, [
      campo('nombre', 'Nombre y apellidos', { autocomplete: 'name', maxlength: '100', required: '' }),
      campo('direccion', 'Dirección', { autocomplete: 'address-line1', maxlength: '120', required: '' }),
      campo('direccion2', 'Piso, puerta… (opcional)', { autocomplete: 'address-line2', maxlength: '120' }),
      el('div', { clase: 'dos-campos' }, [
        campo('cp', 'Código postal', { autocomplete: 'postal-code', inputmode: 'numeric', maxlength: '12', required: '' }),
        campo('ciudad', 'Ciudad', { autocomplete: 'address-level2', maxlength: '60', required: '' }),
      ]),
      campo('provincia', 'Provincia (opcional)', { autocomplete: 'address-level1', maxlength: '60' }),
      el('div', { clase: 'campo' }, [el('label', { attrs: { for: 'envio-pais' }, texto: 'País' }), pais]),
      campo('telefono', 'Teléfono para el repartidor (opcional)', { autocomplete: 'tel', inputmode: 'tel', maxlength: '20' }),
      msg,
      el('button', { clase: 'btn', texto: 'Seguir al pago', attrs: { type: 'submit' } }),
      el('p', { clase: 'menor apagado', texto: 'Solo la usamos para enviarte el regalo. El pago es en Polar, que no la necesita.' }),
    ]);
    const { cerrar } = abrirHoja([el('h2', { texto: '¿A dónde te lo mandamos?' }), form], {
      etiqueta: 'Dirección de envío', clase: 'hoja-envio', alCerrar: () => { if (!hecho) resolver(null); },
    });
    form.querySelector('input').focus();
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = (n) => String(form.elements[n].value || '').trim();
      const envio = {
        nombre: v('nombre'), direccion: v('direccion'), ciudad: v('ciudad'), cp: v('cp'), pais: v('pais'),
        ...(v('direccion2') ? { direccion2: v('direccion2') } : {}),
        ...(v('provincia') ? { provincia: v('provincia') } : {}),
        ...(v('telefono') ? { telefono: v('telefono') } : {}),
      };
      if (envio.nombre.length < 2 || envio.direccion.length < 3 || envio.ciudad.length < 2) { estado(msg, 'Falta algún dato de la dirección.', 'error'); return; }
      if (!/^[A-Za-z0-9 -]{3,12}$/.test(envio.cp)) { estado(msg, 'El código postal no parece válido.', 'error'); return; }
      if (envio.telefono && !/^[0-9 +()-]{0,20}$/.test(envio.telefono)) { estado(msg, 'El teléfono solo puede llevar números.', 'error'); return; }
      try { localStorage.setItem(CLAVE_ENVIO, JSON.stringify(envio)); } catch { /* la proxima vez se escribe otra vez */ }
      hecho = true;
      cerrar();
      resolver(envio);
    });
  });
}

async function comprar(boton, { uid, producto, variante, viaje }) {
  const envio = await pedirEnvio();
  if (!envio) return;
  await irAPagar(boton, uid, producto.enlacePago, {
    producto: producto.clave, variante, ...(viaje ? { viajeId: viaje.id } : {}), envio,
  });
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
        texto: 'Compras un pack digital de apoyo en Polar y te regalamos esta pieza impresa con tus datos del momento del pago. Te llega a casa en una o dos semanas.',
      }),
    ]),
  ]));
  pintar();
}

// --- Gemas -------------------------------------------------------------------------
//
// Otra forma de apoyar: un pack de gemas en Polar, y con ellas un banner o un
// lema. Que quede claro que NADA de esto es de pago: todo se puede ganar
// jugando (pegatinas en bicis, eventos, retos), y comprarlo es solo una forma
// de echar una mano al proyecto.

function pintarGemas({ usuario, perfil, config }) {
  const packs = packsALaVenta(config);
  const precios = config?.gemas?.precios || {};
  const enVenta = Object.entries(precios)
    .filter(([clave, precio]) => (BANNERS[clave] || LEMAS[clave]) && Number(precio) > 0 && !clave.startsWith('libre-'))
    .sort((a, b) => a[1] - b[1]);
  if (!packs.length && !enVenta.length) return;

  let saldo = Number(perfil.gemas) || 0;
  const tienes = new Set(perfil.recompensas || []);
  const saldoNodo = el('strong', { clase: 'gemas-saldo', texto: `${saldo} gemas` });
  const msg = el('p', { clase: 'mensaje', attrs: { 'aria-live': 'polite' } });

  const canjear = async (boton, clave, precio) => {
    if (saldo < precio) { estado(msg, `Te faltan ${precio - saldo} gemas.`, 'error'); return; }
    boton.disabled = true;
    estado(msg, 'Canjeando… tarda unos minutos.');
    try {
      await setDoc(doc(db, 'canjes_gemas', usuario.uid), { recompensa: clave, estado: 'pendiente', creado: serverTimestamp() });
    } catch (error) {
      console.debug('Canje de gemas', error);
      estado(msg, 'Ya tienes otro canje en marcha. Espera a que termine.', 'error');
      boton.disabled = false;
      return;
    }
    const parar = onSnapshot(doc(db, 'canjes_gemas', usuario.uid), (snap) => {
      const r = snap.data();
      if (!r || r.estado === 'pendiente') return;
      parar();
      if (r.estado === 'ok') {
        saldo -= precio;
        saldoNodo.textContent = `${saldo} gemas`;
        tienes.add(clave);
        boton.textContent = 'Ya es tuyo';
        estado(msg, '¡Hecho! Ya puedes ponértelo en tu perfil público.', 'exito');
      } else {
        boton.disabled = false;
        estado(msg, {
          'ya-la-tienes': 'Ya lo tenías: no se han gastado gemas.',
          'sin-gemas': 'No te llegan las gemas.',
          'no-esta': 'Esto ya no está a la venta.',
        }[r.estado] || 'No ha salido bien.', 'error');
      }
    }, () => estado(msg, 'Lo comprobamos en unos minutos. Vuelve luego.', 'info'));
  };

  reemplazar(id('gemas'), [
    el('h2', { attrs: { id: 't-gemas' }, texto: 'Gemas' }),
    el('div', { clase: 'tarjeta-grande gemas-aviso' }, [
      el('strong', { texto: 'Todo se puede conseguir gratis' }),
      el('p', { texto: 'Cada banner y cada lema se gana jugando: pegatinas escondidas en bicis, eventos y retos. Comprarlos con gemas no da ninguna ventaja en el juego: es solo una forma de apoyar el proyecto si te apetece.' }),
    ]),
    el('div', { clase: 'gemas-cabeza' }, [el('span', { texto: 'Tienes' }), saldoNodo]),
    packs.length ? el('div', { clase: 'gemas-packs' }, packs.map((p) => {
      const boton = el('button', { clase: 'btn secundario', attrs: { type: 'button' }, texto: `${p.gemas} gemas · ${euros(p.precio)}` });
      boton.addEventListener('click', () => irAPagar(boton, usuario.uid, p.enlacePago, { producto: 'gemas', variante: p.clave }));
      return boton;
    })) : null,
    enVenta.length ? el('div', { clase: 'gemas-catalogo' }, enVenta.map(([clave, precio]) => {
      const esBanner = Boolean(BANNERS[clave]);
      const ya = tienes.has(clave);
      const boton = el('button', {
        clase: 'btn plano', attrs: { type: 'button', ...(ya ? { disabled: '' } : {}) },
        texto: ya ? 'Ya es tuyo' : `${precio} gemas`,
      });
      boton.addEventListener('click', () => canjear(boton, clave, Number(precio)));
      return el('div', { clase: 'gemas-item' }, [
        esBanner ? dibujoBanner(clave, { clase: 'gemas-banner' }) : el('span', { clase: 'gemas-lema' }, [dibujoLema(clave)]),
        el('span', { clase: 'gemas-nombre', texto: esBanner ? `Banner · ${BANNERS[clave].titulo}` : 'Lema' }),
        boton,
      ]);
    })) : null,
    msg,
  ]);
  id('gemas').classList.remove('oculto');
}

async function pintarPedidos(uid) {
  try {
    const snap = await getDocs(query(collection(db, 'pedidos_tienda'), where('uid', '==', uid), orderBy('creado', 'desc'), limit(10)));
    // Los borradores sin pagar no son pedidos: no se enseñan.
    const pedidos = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.estado !== 'borrador');
    if (!pedidos.length) return;
    reemplazar(id('lista-pedidos'), pedidos.map((p) => el('div', { clase: 'tienda-pedido' }, [
      el('strong', {
        texto: p.producto === 'gemas'
          ? `Gemas${p.gemas ? ` · ${p.gemas}` : ''}`
          : `${PRODUCTOS_DISENO[p.producto]?.nombre || p.producto}${p.variante && p.variante !== 'unica' ? ` · ${p.variante}` : ''}`,
      }),
      el('span', { clase: `chip ${p.estado === 'error' ? 'rechazado' : ['enviado', 'entregado'].includes(p.estado) ? 'verificado' : 'revision'}`, texto: ESTADOS_PEDIDO[p.estado] || p.estado }),
    ])));
    id('mis-pedidos').classList.remove('oculto');
  } catch {
    /* sin lista de pedidos la tienda funciona igual */
  }
}

onAuthStateChanged(auth, async (usuario) => {
  if (new URLSearchParams(window.location.search).has('gracias')) {
    estado(id('mensaje'), '¡Gracias! El pago ha llegado bien. En unos minutos lo verás en «Tus pedidos»: las gemas, en tu saldo; el regalo, de camino a la imprenta.', 'exito');
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
    const vista = esAdmin && config ? { ...config, visible: true } : config;
    const productos = productosALaVenta(vista);
    const perfilPrevio = perfilSnap.exists() ? perfilSnap.data() : { username: usuario.displayName || 'Piloto' };
    pintarGemas({ usuario, perfil: perfilPrevio, config: vista });
    if (!productos.length && !packsALaVenta(vista).length) {
      reemplazar(id('tienda-contenido'), el('div', { clase: 'vacio' }, [
        el('p', { texto: 'La tienda está cerrada ahora mismo. Vuelve pronto.' }),
      ]));
      return;
    }
    if (esAdmin && !config?.visible) estado(id('mensaje'), 'Vista de administración: la tienda está oculta para el resto.', 'info');
    pintarPedidos(usuario.uid);
    if (!productos.length) { reemplazar(id('tienda-contenido')); return; }

    const perfil = perfilPrevio;
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
