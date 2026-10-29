// Modulo de la pagina /admin/tienda/: abrir o cerrar la tienda y lo que vende.
//
// Lo que se guarda aqui (`config/tienda`) lo leen la web (que enseñar) y el
// worker (que variante pedir a la imprenta y cuanto tiene que haberse cobrado).
// Las claves secretas (Polar, imprenta, Cloudinary) NO van aqui: son secretos
// del repositorio, que solo ve el worker (docs/TIENDA.md).
//
// En Polar se venden articulos DIGITALES (pack de apoyo, gemas); lo fisico es
// un regalo que acompaña al pack y lo manda la imprenta o tu, a mano. Por eso
// aqui se ven las direcciones de los pedidos pagados y se marcan como enviados.

import {
  auth, db, doc, getDoc, getDocs, setDoc, updateDoc, collection, query, orderBy, limit, serverTimestamp,
} from '/assets/js/firebase.js';
import { ENLACE_POLAR } from '/assets/js/tienda.js';
import { BANNERS, LEMAS } from '/assets/data/recompensas.js';
import { iniciarPagina, formatearFecha } from '/assets/js/ui.js';
import { id, el, estado, reemplazar } from '/assets/js/dom.js';
import { montarCabeceraAdmin, exigirAdmin } from '/assets/js/admin-cabecera.js';
import { PRODUCTOS_DISENO } from '/assets/js/tienda-diseno.js';

iniciarPagina('admin');
montarCabeceraAdmin('tienda');

const ENLACE = ENLACE_POLAR;
const AYUDA_ENLACE = 'Un checkout link de Polar: https://buy.polar.sh/polar_cl_…';
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
    el('label', { clase: 'campo', attrs: { for: `${pre}-enlace` } }, ['Enlace de pago de Polar (checkout link del pack de apoyo)',
      el('input', { attrs: { type: 'url', id: `${pre}-enlace`, placeholder: 'https://buy.polar.sh/polar_cl_…', value: p.enlacePago || '' } })]),
    el('label', { clase: 'campo', attrs: { for: `${pre}-polar` } }, ['Id del producto en Polar',
      el('input', { attrs: { id: `${pre}-polar`, placeholder: 'el UUID del producto', value: p.polarProducto || '' } })]),
    el('label', { clase: 'campo', attrs: { for: `${pre}-variantes` } }, ['Variantes del proveedor',
      el('textarea', { attrs: { id: `${pre}-variantes`, rows: '4', placeholder: AYUDA_VARIANTES[clave] } })]),
    el('p', { clase: 'menor apagado', texto: 'El precio de aquí tiene que ser el mismo que el de Polar: el worker no manda nada si lo cobrado no cuadra. Sin variantes de la imprenta (o sin sus claves), los pedidos quedan para enviar a mano.' }),
  ]);
}

const PRODUCTO_POLAR = /^[A-Za-z0-9_-]{1,80}$/;

function leerProducto(clave) {
  const pre = `p-${clave}`;
  const nombre = PRODUCTOS_DISENO[clave].nombre;
  const enlacePago = id(`${pre}-enlace`).value.trim();
  if (enlacePago && !ENLACE.test(enlacePago)) throw new Error(`${nombre}: ${AYUDA_ENLACE}`);
  const polarProducto = id(`${pre}-polar`).value.trim();
  if (polarProducto && !PRODUCTO_POLAR.test(polarProducto)) throw new Error(`${nombre}: el id del producto de Polar no vale.`);
  const precio = Number(id(`${pre}-precio`).value);
  if (!Number.isFinite(precio) || precio < 0 || precio > 200) throw new Error(`${nombre}: el precio no vale.`);
  const activo = id(`${pre}-activo`).checked;
  const variantes = textoAVariantes(id(`${pre}-variantes`).value);
  if (activo && (!enlacePago || !polarProducto || !Object.keys(variantes).length)) {
    throw new Error(`${nombre}: para ponerlo a la venta hacen falta el enlace, el id de Polar y al menos una talla (M=0 si lo envías a mano).`);
  }
  return { activo, precio, enlacePago, polarProducto, variantes };
}

// --- Gemas -------------------------------------------------------------------------

const PACKS = ['p1', 'p2', 'p3', 'p4'];

function tarjetaGemas(g = {}) {
  const fila = (k) => {
    const p = g.packs?.[k] || {};
    return el('div', { clase: 'adm-pack' }, [
      el('label', { clase: 'campo-check' }, [el('input', { attrs: { type: 'checkbox', id: `g-${k}-activo`, ...(p.activo ? { checked: '' } : {}) } }), ` Pack ${k.slice(1)}`]),
      el('input', { attrs: { type: 'number', id: `g-${k}-gemas`, min: '1', max: '100000', placeholder: 'gemas', 'aria-label': `Gemas del pack ${k.slice(1)}`, value: String(p.gemas ?? '') } }),
      el('input', { attrs: { type: 'number', id: `g-${k}-precio`, min: '0', max: '200', step: '0.01', placeholder: '€', 'aria-label': `Precio del pack ${k.slice(1)}`, value: String(p.precio ?? '') } }),
      el('input', { attrs: { type: 'url', id: `g-${k}-enlace`, placeholder: 'https://buy.polar.sh/polar_cl_…', 'aria-label': `Enlace del pack ${k.slice(1)}`, value: p.enlacePago || '' } }),
      el('input', { attrs: { id: `g-${k}-polar`, placeholder: 'id del producto en Polar', 'aria-label': `Producto de Polar del pack ${k.slice(1)}`, value: p.polarProducto || '' } }),
    ]);
  };
  const catalogo = [...Object.entries(BANNERS).map(([c, b]) => [c, `Banner · ${b.titulo}`]), ...Object.entries(LEMAS).map(([c, l]) => [c, `Lema · ${l.texto}`])]
    .filter(([c]) => !c.startsWith('libre-'));
  return el('section', { clase: 'adm-tarjeta', attrs: { 'aria-labelledby': 'g-t' } }, [
    el('h2', { attrs: { id: 'g-t' }, texto: 'Gemas' }),
    el('p', { clase: 'menor apagado', texto: 'Paquetes de gemas que se venden en Polar, y cuántas cuesta cada banner o lema. Vacío = no se vende con gemas (se sigue ganando jugando, como todo).' }),
    ...PACKS.map(fila),
    el('div', { clase: 'adm-precios-gemas' }, catalogo.map(([c, texto]) => el('label', { clase: 'adm-precio-gema' }, [
      el('span', { texto }),
      el('input', { attrs: { type: 'number', min: '0', max: '100000', 'data-recompensa': c, 'aria-label': `Gemas: ${texto}`, value: String(g.precios?.[c] ?? '') } }),
    ]))),
  ]);
}

function leerGemas() {
  const packs = {};
  for (const k of PACKS) {
    const enlacePago = id(`g-${k}-enlace`).value.trim();
    const polarProducto = id(`g-${k}-polar`).value.trim();
    const gemas = Math.round(Number(id(`g-${k}-gemas`).value));
    const precio = Number(id(`g-${k}-precio`).value);
    const activo = id(`g-${k}-activo`).checked;
    if (!enlacePago && !polarProducto && !gemas) continue;
    if (enlacePago && !ENLACE.test(enlacePago)) throw new Error(`Pack ${k.slice(1)}: ${AYUDA_ENLACE}`);
    if (polarProducto && !PRODUCTO_POLAR.test(polarProducto)) throw new Error(`Pack ${k.slice(1)}: el id de Polar no vale.`);
    if (!(gemas > 0) || !(precio >= 0 && precio <= 200)) throw new Error(`Pack ${k.slice(1)}: faltan las gemas o el precio.`);
    if (activo && (!enlacePago || !polarProducto)) throw new Error(`Pack ${k.slice(1)}: para venderlo hacen falta el enlace y el id de Polar.`);
    packs[k] = { activo, gemas, precio, enlacePago, polarProducto };
  }
  const precios = {};
  for (const input of document.querySelectorAll('[data-recompensa]')) {
    const n = Math.round(Number(input.value));
    if (input.value !== '' && n > 0) precios[input.dataset.recompensa] = n;
  }
  return { packs, precios };
}

async function pintar() {
  const snap = await getDoc(doc(db, 'config', 'tienda'));
  const config = snap.exists() ? snap.data() : { visible: false, productos: {} };
  for (const r of document.querySelectorAll('input[name="visible"]')) r.checked = (r.value === 'si') === Boolean(config.visible);
  reemplazar(id('productos'), [
    ...Object.keys(PRODUCTOS_DISENO).map((clave) => tarjetaProducto(clave, config.productos?.[clave])),
    tarjetaGemas(config.gemas),
  ]);
  for (const clave of Object.keys(PRODUCTOS_DISENO)) id(`p-${clave}-variantes`).value = variantesATexto(config.productos?.[clave]?.variantes);
}

async function guardar() {
  const productos = {};
  for (const clave of Object.keys(PRODUCTOS_DISENO)) productos[clave] = leerProducto(clave);
  const gemas = leerGemas();
  const visible = document.querySelector('input[name="visible"]:checked')?.value === 'si';
  await setDoc(doc(db, 'config', 'tienda'), {
    visible, productos, gemas, por: auth.currentUser.uid, actualizado: serverTimestamp(),
  });
  try { sessionStorage.removeItem('bf_tienda'); } catch { /* nada que olvidar */ }
  const aLaVenta = Object.values(productos).filter((p) => p.activo).length + Object.values(gemas.packs).filter((p) => p.activo).length;
  estado(id('mensaje'), visible
    ? `Tienda visible con ${aLaVenta} producto${aLaVenta === 1 ? '' : 's'} a la venta.`
    : 'Tienda oculta: nadie la ve salvo la administración.', 'exito');
}

const ESTADOS = {
  pagado: 'Pagado', preparar: 'ENVIAR A MANO', en_proveedor: 'En el proveedor (borrador)', en_produccion: 'Confirmado al proveedor',
  enviado: 'Enviado', entregado: 'Gemas entregadas', revisar: 'REVISAR', error: 'ERROR',
};

/** La direccion de un pedido en una linea, para copiarla en la etiqueta. */
const lineaEnvio = (e) => (e ? [e.nombre, e.direccion, e.direccion2, `${e.cp} ${e.ciudad}`, e.provincia, e.pais, e.telefono && `tel. ${e.telefono}`].filter(Boolean).join(' · ') : '');

async function pintarPedidos() {
  const snap = await getDocs(query(collection(db, 'pedidos_tienda'), orderBy('creado', 'desc'), limit(40)));
  const pagados = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.estado !== 'borrador');
  reemplazar(id('lista-pedidos'), pagados.length
    ? pagados.map((p) => {
      const enviable = ['preparar', 'pagado', 'en_proveedor', 'en_produccion'].includes(p.estado) && p.producto !== 'gemas';
      return el('div', { clase: 'adm-estado-fila' }, [
        el('span', {}, [
          el('strong', { texto: p.producto === 'gemas' ? `Gemas ${p.gemas || ''}` : `${PRODUCTOS_DISENO[p.producto]?.nombre || p.producto} ${p.variante || ''}` }),
          el('small', { texto: ` · ${p.creado?.toDate ? formatearFecha(p.creado.toDate()) : ''}${p.importe ? ` · ${(p.importe / 100).toFixed(2)} €` : ''}${p.polarPedido ? ` · Polar ${p.polarPedido}` : ''}` }),
          p.envio ? el('small', { clase: 'adm-envio', texto: lineaEnvio(p.envio) }) : null,
          p.mensajeError ? el('small', { texto: ` · ${p.mensajeError}` }) : null,
        ]),
        el('span', { clase: `chip ${['error', 'revisar', 'preparar'].includes(p.estado) ? 'rechazado' : 'revision'}`, texto: ESTADOS[p.estado] || p.estado }),
        enviable ? el('button', {
          clase: 'btn plano', texto: 'Marcar enviado', attrs: { type: 'button' },
          on: {
            click: async (e) => {
              e.currentTarget.disabled = true;
              try {
                await updateDoc(doc(db, 'pedidos_tienda', p.id), { estado: 'enviado', enviadoEn: serverTimestamp() });
                await pintarPedidos();
              } catch (error) {
                estado(id('mensaje'), `No se ha podido marcar: ${error.message}`, 'error');
              }
            },
          },
        }) : null,
      ]);
    })
    : [el('p', { clase: 'menor apagado', texto: 'Ningún pedido pagado todavía.' })]);
}

id('btn-guardar').addEventListener('click', () => guardar()
  .catch((error) => estado(id('mensaje'), `No se ha podido guardar: ${error.message}`, 'error')));

exigirAdmin('tienda').then(() => Promise.all([pintar(), pintarPedidos()])).catch((error) => {
  estado(id('mensaje'), `No se ha podido cargar: ${error.message}`, 'error');
});
