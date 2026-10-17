// Modulo de la pagina /admin/tienda/: abrir o cerrar la tienda y lo que vende.
//
// Lo que se guarda aqui (`config/tienda`) lo leen la web (que enseñar) y el
// worker (que variante pedir a la imprenta y de que producto de Gumroad tiene
// que ser la venta). La coleccion de Printful no se edita aqui: la copia el
// worker cada hora (`config/tienda_catalogo`); aqui solo se le pone a cada
// producto su enlace de Gumroad.
// Las claves secretas (Gumroad, imprenta, Cloudinary) NO van aqui: son secretos
// del repositorio, que solo ve el worker (docs/TIENDA.md).

import {
  auth, db, doc, getDoc, getDocs, setDoc, collection, query, orderBy, limit, serverTimestamp,
} from '/assets/js/firebase.js';
import { iniciarPagina, formatearFecha } from '/assets/js/ui.js';
import { id, el, estado, reemplazar } from '/assets/js/dom.js';
import { montarCabeceraAdmin, exigirAdmin } from '/assets/js/admin-cabecera.js';
import { PRODUCTOS_DISENO } from '/assets/js/tienda-diseno.js';
import { leerCatalogo } from '/assets/js/tienda.js';

iniciarPagina('admin');
montarCabeceraAdmin('tienda');

// El mismo patron que firestore.rules y assets/js/tienda.js.
const ENLACE = /^https:\/\/([a-z0-9-]+\.)?gumroad\.com\/l\/[A-Za-z0-9_-]+$/;
const AYUDA_VARIANTES = {
  camiseta: 'Una por línea, talla=id de variante del proveedor. Ej.: M=4012',
  taza: 'Normalmente una sola: unica=id de variante. Ej.: unica=1320',
};

/** "S=4011\nM=4012" <-> { S: 4011, M: 4012 } */
const variantesATexto = (v = {}) => Object.entries(v).map(([k, n]) => `${k}=${n}`).join('\n');
function textoAVariantes(texto) {
  const salida = {};
  for (const linea of String(texto).split(/[\n,]+/)) {
    const m = linea.trim().match(/^([A-Za-z0-9]{1,12})\s*=\s*(\d{1,10})$/);
    if (linea.trim() && !m) throw new Error(`No entiendo la línea de variantes «${linea.trim()}». Va así: M=4012`);
    if (m) salida[m[1]] = Number(m[2]);
  }
  return salida;
}

function tarjetaProducto(clave, p = {}) {
  const pre = `p-${clave}`;
  return el('section', { clase: 'adm-tarjeta', attrs: { 'aria-labelledby': `${pre}-t` } }, [
    el('h2', { attrs: { id: `${pre}-t` }, texto: PRODUCTOS_DISENO[clave].nombre }),
    el('label', { clase: 'campo-check' }, [
      el('input', { attrs: { type: 'checkbox', id: `${pre}-activo`, ...(p.activo ? { checked: '' } : {}) } }),
      ' A la venta',
    ]),
    el('label', { clase: 'campo', attrs: { for: `${pre}-precio` } }, ['Precio que se enseña (€)',
      el('input', { attrs: { type: 'number', id: `${pre}-precio`, min: '0', max: '200', step: '0.01', value: String(p.precio ?? '') } })]),
    el('label', { clase: 'campo', attrs: { for: `${pre}-enlace` } }, ['Enlace del producto en Gumroad',
      el('input', { attrs: { type: 'url', id: `${pre}-enlace`, placeholder: 'https://tu-usuario.gumroad.com/l/…', value: p.enlacePago || '' } })]),
    el('label', { clase: 'campo', attrs: { for: `${pre}-variantes` } }, ['Variantes del proveedor',
      el('textarea', { attrs: { id: `${pre}-variantes`, rows: '4', placeholder: AYUDA_VARIANTES[clave] } })]),
    el('p', { clase: 'menor apagado', texto: 'El precio de aquí tiene que ser el mismo que el del producto en Gumroad (sin impuestos ni envío, que los suma Gumroad). El worker no imprime una venta que no sea de este producto.' }),
  ]);
}

function leerProducto(clave) {
  const pre = `p-${clave}`;
  const enlacePago = id(`${pre}-enlace`).value.trim();
  if (enlacePago && !ENLACE.test(enlacePago)) throw new Error(`${PRODUCTOS_DISENO[clave].nombre}: el enlace tiene que ser de un producto de Gumroad (https://….gumroad.com/l/…)`);
  const precio = Number(id(`${pre}-precio`).value);
  if (!Number.isFinite(precio) || precio < 0 || precio > 200) throw new Error(`${PRODUCTOS_DISENO[clave].nombre}: el precio no vale.`);
  const activo = id(`${pre}-activo`).checked;
  const variantes = textoAVariantes(id(`${pre}-variantes`).value);
  if (activo && (!enlacePago || !Object.keys(variantes).length)) {
    throw new Error(`${PRODUCTOS_DISENO[clave].nombre}: para ponerlo a la venta hacen falta el enlace y al menos una variante.`);
  }
  return { activo, precio, enlacePago, variantes };
}

let catalogo = null;
const eur = (n) => `${Number(n).toFixed(2).replace('.', ',')} €`;

/** La coleccion de Printful: una fila por producto, con su enlace de Gumroad. */
function pintarCatalogo(enlaces = {}) {
  const productos = Object.entries(catalogo?.productos || {});
  if (!productos.length) {
    reemplazar(id('lista-catalogo'), el('p', {
      clase: 'menor apagado',
      texto: 'Todavía no hay nada copiado de Printful. Comprueba que el secreto PRINTFUL_TOKEN está puesto y espera a la siguiente pasada del worker.',
    }));
    return;
  }
  reemplazar(id('lista-catalogo'), productos.map(([idPf, p]) => {
    const precios = Object.values(p.variantes || {}).map((v) => v.precio).filter(Number.isFinite);
    const min = Math.min(...precios), max = Math.max(...precios);
    const imagen = /^https:\/\/files\.cdn\.printful\.com\//.test(p.imagen || '') ? p.imagen : null;
    return el('div', { clase: 'adm-catalogo-fila' }, [
      imagen ? el('img', { attrs: { src: imagen, alt: '', loading: 'lazy' } }) : el('span', { clase: 'adm-catalogo-sinfoto' }),
      el('div', { clase: 'adm-catalogo-datos' }, [
        el('strong', { texto: p.nombre }),
        el('small', { texto: `${precios.length} variante${precios.length === 1 ? '' : 's'} · ${min === max ? eur(min) : `${eur(min)} a ${eur(max)}`}` }),
        el('input', {
          attrs: {
            type: 'url', id: `cat-${idPf}`, 'data-catalogo': idPf, 'aria-label': `Enlace de Gumroad de ${p.nombre}`,
            placeholder: 'Enlace de Gumroad (vacío = no se vende)', value: enlaces[idPf] || '',
          },
        }),
      ]),
    ]);
  }));
}

/** { id de Printful: enlace } con los enlaces rellenos; uno que no sea de Gumroad para el guardado. */
function leerCatalogoEnlaces() {
  const salida = {};
  for (const input of document.querySelectorAll('[data-catalogo]')) {
    const enlace = input.value.trim();
    if (!enlace) continue;
    if (!ENLACE.test(enlace)) throw new Error(`${catalogo?.productos?.[input.dataset.catalogo]?.nombre || 'Un producto'}: el enlace tiene que ser de un producto de Gumroad (https://….gumroad.com/l/…)`);
    salida[input.dataset.catalogo] = enlace;
  }
  return salida;
}

async function pintar() {
  const snap = await getDoc(doc(db, 'config', 'tienda'));
  const config = snap.exists() ? snap.data() : { visible: false, productos: {} };
  try { sessionStorage.removeItem('bf_tienda_catalogo'); } catch { /* se lee fresco igual */ }
  catalogo = await leerCatalogo();
  pintarCatalogo(config.catalogo);
  for (const r of document.querySelectorAll('input[name="visible"]')) r.checked = (r.value === 'si') === Boolean(config.visible);
  reemplazar(id('productos'), Object.keys(PRODUCTOS_DISENO).map((clave) => tarjetaProducto(clave, config.productos?.[clave])));
  for (const clave of Object.keys(PRODUCTOS_DISENO)) id(`p-${clave}-variantes`).value = variantesATexto(config.productos?.[clave]?.variantes);
}

async function guardar() {
  const productos = {};
  for (const clave of Object.keys(PRODUCTOS_DISENO)) productos[clave] = leerProducto(clave);
  const enlaces = leerCatalogoEnlaces();
  const visible = document.querySelector('input[name="visible"]:checked')?.value === 'si';
  await setDoc(doc(db, 'config', 'tienda'), {
    visible, productos, catalogo: enlaces, por: auth.currentUser.uid, actualizado: serverTimestamp(),
  });
  try { sessionStorage.removeItem('bf_tienda'); } catch { /* nada que olvidar */ }
  const aLaVenta = Object.values(productos).filter((p) => p.activo).length + Object.keys(enlaces).length;
  estado(id('mensaje'), visible
    ? `Tienda visible con ${aLaVenta} producto${aLaVenta === 1 ? '' : 's'} a la venta.`
    : 'Tienda oculta: nadie la ve salvo la administración.', 'exito');
}

const ESTADOS = {
  pagado: 'Pagado', en_proveedor: 'En el proveedor (borrador)', en_produccion: 'Confirmado al proveedor',
  enviado: 'Enviado', revisar: 'REVISAR', error: 'ERROR',
};

async function pintarPedidos() {
  const snap = await getDocs(query(collection(db, 'pedidos_tienda'), orderBy('creado', 'desc'), limit(30)));
  const pagados = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.estado !== 'borrador');
  reemplazar(id('lista-pedidos'), pagados.length
    ? pagados.map((p) => el('div', { clase: 'adm-estado-fila' }, [
      el('span', {}, [
        el('strong', { texto: String(p.producto || '').startsWith('pf_')
          ? `${catalogo?.productos?.[p.producto.slice(3)]?.nombre || 'Colección'} · ${catalogo?.productos?.[p.producto.slice(3)]?.variantes?.[p.variante]?.nombre || p.variante}`
          : `${PRODUCTOS_DISENO[p.producto]?.nombre || p.producto} ${p.variante || ''}` }),
        el('small', { texto: ` · ${p.creado?.toDate ? formatearFecha(p.creado.toDate()) : ''}${p.importe ? ` · ${(p.importe / 100).toFixed(2)} ${p.moneda === 'usd' ? 'USD' : '€'}` : ''}` }),
        p.mensajeError ? el('small', { texto: ` · ${p.mensajeError}` }) : null,
      ]),
      el('span', { clase: `chip ${['error', 'revisar'].includes(p.estado) ? 'rechazado' : 'revision'}`, texto: ESTADOS[p.estado] || p.estado }),
    ]))
    : [el('p', { clase: 'menor apagado', texto: 'Ningún pedido pagado todavía.' })]);
}

id('btn-guardar').addEventListener('click', () => guardar()
  .catch((error) => estado(id('mensaje'), `No se ha podido guardar: ${error.message}`, 'error')));

exigirAdmin('tienda').then(() => pintar()).then(() => pintarPedidos()).catch((error) => {
  estado(id('mensaje'), `No se ha podido cargar: ${error.message}`, 'error');
});
