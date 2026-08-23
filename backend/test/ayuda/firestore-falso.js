'use strict';

/**
 * Firestore en memoria que CUENTA lecturas y escrituras (#56).
 *
 * Sirve para lo que un ensayo general tiene que responder y ningun test de
 * unidad responde: si el cierre de temporada, las divisiones y el decaimiento
 * del mapa aguantan 200 usuarios y 5.000 viajes, y cuanta cuota se comen. Las
 * tres tocan a TODO el mundo y se estrenan en produccion el dia 1.
 *
 * No pretende ser Firestore. Implementa el trozo que usa este proyecto, y falla
 * ruidosamente ante lo que no conoce: un doble que se traga silenciosamente una
 * llamada que no entiende da un ensayo verde sobre nada.
 *
 * El contador es el motivo de que exista: contrastar lo que dice
 * docs/COSTE.md con lo que de verdad pide el codigo.
 */

const assert = require('node:assert');

class Instantanea {
  constructor(id, datos, ref = null) {
    this.id = id;
    this._datos = datos;
    // Las instantaneas de Firestore llevan `ref`, y el codigo tira de ella para
    // borrar y actualizar sin volver a construir la ruta. Sin esto el doble
    // parece funcionar hasta que algo hace `doc.ref.update()`.
    this.ref = ref;
  }
  get exists() { return this._datos !== undefined; }
  data() { return this._datos === undefined ? undefined : estructurar(this._datos); }
}

/** Copia, para que quien lea no pueda modificar el almacen por referencia. */
const estructurar = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v, reemplazar)));
const reemplazar = (clave, valor) => (valor instanceof Date ? { __fecha: valor.toISOString() } : valor);

// --- Marcadores de FieldValue -------------------------------------------------

const MARCA = Symbol('fieldValue');
const esMarca = (v) => v && typeof v === 'object' && v[MARCA];

const FieldValue = {
  serverTimestamp: () => ({ [MARCA]: 'timestamp' }),
  delete: () => ({ [MARCA]: 'delete' }),
  increment: (n) => ({ [MARCA]: 'increment', n }),
  arrayUnion: (...v) => ({ [MARCA]: 'arrayUnion', v }),
  arrayRemove: (...v) => ({ [MARCA]: 'arrayRemove', v }),
};

/** Aplica los FieldValue de `parche` sobre `previo`. */
function aplicar(previo = {}, parche = {}) {
  const salida = { ...previo };

  for (const [clave, valor] of Object.entries(parche)) {
    if (!esMarca(valor)) { salida[clave] = valor; continue; }

    switch (valor[MARCA]) {
      case 'timestamp': salida[clave] = new Date(); break;
      case 'delete': delete salida[clave]; break;
      case 'increment': salida[clave] = (Number(salida[clave]) || 0) + valor.n; break;
      case 'arrayUnion': {
        const actual = Array.isArray(salida[clave]) ? salida[clave] : [];
        salida[clave] = [...new Set([...actual, ...valor.v])];
        break;
      }
      case 'arrayRemove': {
        const actual = Array.isArray(salida[clave]) ? salida[clave] : [];
        salida[clave] = actual.filter((x) => !valor.v.includes(x));
        break;
      }
      default: throw new Error(`FieldValue desconocido: ${valor[MARCA]}`);
    }
  }
  return salida;
}

// --- Consultas -----------------------------------------------------------------

class Consulta {
  constructor(bd, coleccion, filtros = [], orden = [], tope = null, desde = null) {
    this.bd = bd;
    this.coleccion = coleccion;
    this.filtros = filtros;
    this.orden = orden;
    this.tope = tope;
    this.desde = desde;
  }

  _con(cambios) {
    return new Consulta(this.bd, this.coleccion,
      cambios.filtros || this.filtros,
      cambios.orden || this.orden,
      cambios.tope !== undefined ? cambios.tope : this.tope,
      cambios.desde !== undefined ? cambios.desde : this.desde);
  }

  where(campo, op, valor) {
    assert.ok(['==', '!=', '>', '>=', '<', '<=', 'in', 'array-contains'].includes(op),
      `operador no soportado por el doble: ${op}`);
    return this._con({ filtros: [...this.filtros, { campo, op, valor }] });
  }

  orderBy(campo, direccion = 'asc') {
    return this._con({ orden: [...this.orden, { campo, direccion }] });
  }

  limit(n) { return this._con({ tope: n }); }
  startAfter(instantanea) { return this._con({ desde: instantanea }); }

  async get() {
    const docs = this._resolver();
    // Firestore cobra un minimo de una lectura aunque no devuelva nada.
    this.bd.lecturas += Math.max(1, docs.length);
    return { docs, size: docs.length, empty: docs.length === 0 };
  }

  /** La consulta de agregacion: una lectura por cada 1.000 contados. */
  async count() {
    const docs = this._resolver();
    this.bd.lecturas += Math.max(1, Math.ceil(docs.length / 1000));
    return { data: () => ({ count: docs.length }) };
  }

  _resolver() {
    const almacen = this.bd._coleccion(this.coleccion);
    let filas = [...almacen.entries()].map(([id, datos]) => ({ id, datos }));

    for (const { campo, op, valor } of this.filtros) {
      filas = filas.filter(({ datos }) => comparar(leerCampo(datos, campo), op, valor));
    }

    for (const { campo, direccion } of [...this.orden].reverse()) {
      filas.sort((a, b) => {
        const x = leerCampo(a.datos, campo);
        const y = leerCampo(b.datos, campo);
        const signo = x < y ? -1 : (x > y ? 1 : 0);
        return direccion === 'desc' ? -signo : signo;
      });
    }

    if (this.desde) {
      const corte = filas.findIndex((f) => f.id === this.desde.id);
      if (corte >= 0) filas = filas.slice(corte + 1);
    }
    if (this.tope !== null) filas = filas.slice(0, this.tope);

    return filas.map(({ id, datos }) =>
      new Instantanea(id, datos, new RefDocumento(this.bd, `${this.coleccion}/${id}`)));
  }
}

const leerCampo = (datos, campo) =>
  campo.split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), datos);

function comparar(valor, op, referencia) {
  const norm = (v) => (v instanceof Date ? v.getTime() : v);
  const a = norm(valor);
  const b = norm(referencia);

  switch (op) {
    case '==': return a === b;
    case '!=': return a !== b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '<': return a < b;
    case '<=': return a <= b;
    case 'in': return Array.isArray(b) && b.includes(a);
    case 'array-contains': return Array.isArray(valor) && valor.includes(referencia);
    default: throw new Error(`operador no soportado: ${op}`);
  }
}

// --- Referencias -----------------------------------------------------------------

class RefDocumento {
  constructor(bd, ruta) {
    this.bd = bd;
    this.ruta = ruta;
    this.id = ruta.split('/').pop();
  }

  async get() {
    this.bd.lecturas++;
    const { coleccion, id } = partir(this.ruta);
    return new Instantanea(id, this.bd._coleccion(coleccion).get(id), this);
  }

  /**
   * La escritura de verdad, sin contar ni pasar por el metodo publico.
   *
   * Existe porque un lote de Firestore NO llama a `ref.set()`: lleva las
   * operaciones a la red por su cuenta. Cuando el doble lo hacia asi, cualquier
   * envoltorio sobre los metodos publicos — el contador de cuota, por ejemplo —
   * contaba dos veces cada operacion de un lote.
   */
  _aplicar(operacion, datos, opciones = {}) {
    const { coleccion, id } = partir(this.ruta);
    const almacen = this.bd._coleccion(coleccion);

    if (operacion === 'delete') { almacen.delete(id); return; }

    if (operacion === 'update') {
      // Firestore falla si el documento no existe; el doble tambien, o un error
      // real pasaria desapercibido en el ensayo.
      assert.ok(almacen.has(id), `update sobre un documento que no existe: ${this.ruta}`);
      almacen.set(id, aplicar(almacen.get(id), datos));
      return;
    }

    const previo = opciones.merge ? almacen.get(id) : undefined;
    almacen.set(id, aplicar(previo, datos));
  }

  async set(datos, opciones = {}) {
    this.bd.escrituras++;
    this._aplicar('set', datos, opciones);
  }

  async update(datos) {
    this.bd.escrituras++;
    this._aplicar('update', datos);
  }

  async delete() {
    this.bd.escrituras++;
    this._aplicar('delete');
  }

  collection(nombre) { return new RefColeccion(this.bd, `${this.ruta}/${nombre}`); }
}

class RefColeccion extends Consulta {
  constructor(bd, ruta) {
    super(bd, ruta);
    this.ruta = ruta;
  }
  doc(id) { return new RefDocumento(this.bd, `${this.ruta}/${id}`); }
}

/** `usuarios/uid-1/temporadas/2026-07` -> coleccion `usuarios/uid-1/temporadas`. */
function partir(ruta) {
  const partes = ruta.split('/');
  return { coleccion: partes.slice(0, -1).join('/'), id: partes[partes.length - 1] };
}

// --- Lote ------------------------------------------------------------------------

class Lote {
  constructor(bd) {
    this.bd = bd;
    this.operaciones = [];
  }
  // Se apunta la escritura sin pasar por los metodos publicos de la referencia,
  // igual que hace Firestore: un lote no llama a `ref.set()`.
  set(ref, datos, opciones) { this.operaciones.push([ref, 'set', datos, opciones]); return this; }
  update(ref, datos) { this.operaciones.push([ref, 'update', datos]); return this; }
  delete(ref) { this.operaciones.push([ref, 'delete']); return this; }

  async commit() {
    // Un lote de Firestore admite 500 operaciones. Pasarse es un error en
    // produccion, asi que aqui tambien.
    assert.ok(this.operaciones.length <= 500,
      `lote de ${this.operaciones.length} operaciones: el maximo de Firestore es 500`);

    for (const [ref, operacion, datos, opciones] of this.operaciones) {
      this.bd.escrituras++;
      ref._aplicar(operacion, datos, opciones);
    }
    this.operaciones = [];
  }
}

// --- La base ---------------------------------------------------------------------

class FirestoreFalso {
  constructor() {
    this.datos = new Map();
    this.lecturas = 0;
    this.escrituras = 0;
  }

  _coleccion(nombre) {
    if (!this.datos.has(nombre)) this.datos.set(nombre, new Map());
    return this.datos.get(nombre);
  }

  collection(nombre) { return new RefColeccion(this, nombre); }
  doc(ruta) { return new RefDocumento(this, ruta); }
  batch() { return new Lote(this); }

  /**
   * Lee varios documentos de una tacada. Cuenta una lectura por documento, y
   * devuelve tambien los que no existen: Firestore hace lo mismo, y el codigo
   * que lo usa cuenta con que la lista salga en el mismo orden que entro.
   */
  async getAll(...refs) {
    this.lecturas += Math.max(1, refs.length);
    return refs.map((ref) => {
      const { coleccion, id } = partir(ref.ruta);
      return new Instantanea(id, this._coleccion(coleccion).get(id), ref);
    });
  }

  /** Mete documentos sin contarlos: es la preparacion, no el ensayo. */
  sembrar(coleccion, documentos, clave = 'id') {
    const almacen = this._coleccion(coleccion);
    for (const d of documentos) {
      const { [clave]: id, ...resto } = d;
      almacen.set(String(id), resto);
    }
  }

  /** Deja una coleccion vacia. Para sembrar un caso concreto encima de otro. */
  vaciar(coleccion) { this._coleccion(coleccion).clear(); }

  contar(coleccion) { return this._coleccion(coleccion).size; }
  leer(ruta) {
    const { coleccion, id } = partir(ruta);
    return this._coleccion(coleccion).get(id);
  }

  reiniciarContador() { this.lecturas = 0; this.escrituras = 0; }
  get coste() { return { lecturas: this.lecturas, escrituras: this.escrituras }; }
}

module.exports = { FirestoreFalso, FieldValue, aplicar };
