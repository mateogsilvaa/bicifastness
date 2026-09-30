/**
 * Firebase de mentira para `npm run maqueta`.
 *
 * El servidor local (scripts/servidor-local.js --maqueta) sirve ESTE fichero en
 * lugar de `assets/js/firebase.js`. Mismas exportaciones, pero todo vive en
 * memoria con datos de ejemplo: una sesion abierta, un perfil con racha, un
 * grupo de division, una ruta del dia, un clan y un mapa. Sirve para ver y
 * probar TODAS las pantallas con sesion sin cuenta, sin red y sin gastar cuota.
 *
 * Nunca se despliega: scripts/construir-sitio.js no publica `scripts/`.
 *
 * Trucos en la consola del navegador:
 *   localStorage.maqueta_sesion = 'fuera'   -> sin sesion
 *   localStorage.maqueta_perfil = 'nuevo'   -> piloto recien llegado (2e)
 *   localStorage.maqueta_perfil = 'salvado' -> hoy ya salvado (2b)
 *   localStorage.maqueta_perfil = 'admin'   -> con permisos de administracion
 *   localStorage.maqueta_perfil = 'sinclan' -> sin clan (5e)
 *   localStorage.maqueta_perfil = 'lider'   -> lider con dos solicitudes (5d)
 *   localStorage.maqueta_perfil = 'cupo'    -> ya ha subido los 3 que puntuan hoy (3n)
 *   delete localStorage.maqueta_perfil      -> lo normal (2a)
 *   localStorage.maqueta_hora = '12:00'     -> la app cree que es esa hora de
 *                                              Madrid (p. ej. '21:30' para 2c)
 * Un viaje subido pasa a verificado a los 6 segundos.
 */

// La hora de mentira: se adelanta o atrasa el reloj entero de la pagina para que
// la hora de Madrid sea la pedida. Asi se ven los estados que dependen de la hora
// (misiones de dia, racha en peligro por la noche) a cualquier hora del dia.
(() => {
  let pedida = null;
  try { pedida = localStorage.getItem('maqueta_hora'); } catch { /* sin almacenamiento */ }
  const m = String(pedida || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return;
  const Real = Date;
  const partes = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Real()).split(':');
  const ahora = Number(partes[0]) * 60 + Number(partes[1]);
  const delta = ((Number(m[1]) * 60 + Number(m[2])) - ahora) * 60000;
  class Falsa extends Real {
    constructor(...args) { if (args.length) super(...args); else super(Real.now() + delta); }
    static now() { return Real.now() + delta; }
  }
  globalThis.Date = Falsa;
})();

const UID = 'maqueta-uid';
const hoy = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date());
const inicioHoy = new Date(`${hoy}T00:00:00+02:00`).getTime();
const dia = (n) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date(Date.now() - n * 864e5));
const variante = (() => { try { return localStorage.getItem('maqueta_perfil') || ''; } catch { return ''; } })();

class Timestamp {
  constructor(ms) { this.ms = ms; }
  static now() { return new Timestamp(Date.now()); }
  static fromMillis(ms) { return new Timestamp(ms); }
  static fromDate(d) { return new Timestamp(d.getTime()); }
  toDate() { return new Date(this.ms); }
  toMillis() { return this.ms; }
  get seconds() { return Math.floor(this.ms / 1000); }
}
const hace = (min) => new Timestamp(Date.now() - min * 60000);

// --- Datos de ejemplo --------------------------------------------------------------

const nombres = ['marta.vk', 'jorge_on_wheels', 'nuria.c', 'rosa.pedal', 'dani_mad', 'lucia.bike', 'laura_pedalea',
  'pablo_rueda', 'irene.v', 'sergio88', 'ana.cleta', 'mario_vuela', 'eva.ruta', 'hugo.m', 'sara_bm', 'leo.chamberi',
  'carla.sol', 'ivan_r', 'noa.fixie', 'adri.m', 'julia.p', 'raul.bm', 'alba.v', 'teo_madrid', 'olga.r', 'bruno.c',
  'marina.q', 'dario_bm', 'celia.n', 'unai.p'];
const CLANES = {
  c1: { nombre: 'Chamberí Fixie', color: '#13A89E' },
  c2: { nombre: 'Retiro Riders', color: '#E0A800' },
  c3: { nombre: 'Latina Rueda', color: '#C8322A' },
};
const perfilBase = {
  username: 'laura_pedalea',
  email: 'laura@example.com',
  racha: 12, mejorRacha: 23, escudos: 1, diasHastaEscudo: 3,
  ultimoDiaActivo: inicioHoy - 864e5,
  viajesVerificados: 41, metrosTotales: 96400, segundosTotales: 41000,
  puntosTemporada: 322, biciRating: 870, division: 'plata', clanId: 'c1', rolClan: 'miembro',
  puntosPorRuta: { '124-115': 60, '1-102': 30, '102-124': 20 },
  logros: ['primer-viaje', 'veterano', 'fondo-50', 'racha-7', 'sprint-cinco-tramos', 'explorador-10', 'temporada-2026-08-constancia', 'temporada-2026-07-bronce'],
  consentimiento: { terminos: { version: '1.4.0' } },
  creado: hace(60 * 24 * 40),
};
const perfiles = {
  nuevo: { ...perfilBase, username: 'Pablo', racha: 0, mejorRacha: 0, escudos: 0, viajesVerificados: 0, ultimoDiaActivo: null, puntosPorRuta: {}, clanId: null, puntosTemporada: 0 },
  salvado: {
    ...perfilBase, racha: 13, ultimoDiaActivo: inicioHoy, diasHastaEscudo: 1,
    misiones: {
      fecha: hoy, metros: 5000, mejorVelocidad: 17.2, trayectos: 1, nuevas: 0,
      progreso: [{ tipo: 'distancia', hecho: 5000, objetivo: 5000, completada: true }, { tipo: 'velocidad', hecho: 17.2, objetivo: 15, completada: true }, { tipo: 'exploracion', hecho: 0, objetivo: 1, completada: false }],
    },
  },
  admin: { ...perfilBase, admin: true },
  sinclan: { ...perfilBase, clanId: null, rolClan: null },
  lider: { ...perfilBase, rolClan: 'lider' },
};
const perfil = perfiles[variante] || perfilBase;

const filasGrupo = nombres.map((n, i) => ({ pos: i + 1, nombre: n, clan: ['c1', 'c2', 'c3'][i % 3], puntos: Math.max(0, 420 - i * 14 - (i === 6 ? 0 : 0)), viajes: 30 - i }));
filasGrupo[6].puntos = 322;
const ruta = (marcaBase) => nombres.slice(0, 9).map((n, i) => ({ pos: i + 1, nombre: n, clan: ['c1', 'c2', 'c3'][i % 3], marca: marcaBase + i * 21, viajeId: `v${i}`, fecha: dia(i % 4) }));
const estaciones = {};
const ids = ['100', '101', '102', '103', '104', '105', '107', '108', '109', '110', '112', '113', '114', '115', '117', '119', '120', '121', '122', '123', '124', '125', '126', '127', '128', '129', '130', '131', '132'];
ids.forEach((id, i) => {
  const dueno = ['c1', 'c2', 'c3', null][i % 4];
  const disputa = i % 5 === 0;
  const lider = dueno || ['c1', 'c2', 'c3'][i % 3];
  const otro = lider === 'c1' ? 'c2' : 'c1';
  estaciones[id] = disputa
    ? { clan: null, lider, disputa: true, cuota: { [lider]: 46, [otro]: 41, c3: 13 } }
    : { clan: dueno, lider, disputa: false, cuota: dueno ? { [dueno]: 60 + (i % 20), [otro]: 20 } : { [lider]: 30 } };
});
// Numeros que existen en data/emt.geojson (el mapa usa sus "number").
['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'].forEach((id, i) => {
  estaciones[id] = i % 3 === 0 ? { clan: null, lider: 'c1', disputa: true, cuota: { c1: 46, c2: 41, c3: 13 } } : { clan: ['c1', 'c2', 'c3'][i % 3], lider: ['c1', 'c2', 'c3'][i % 3], disputa: false, cuota: { [['c1', 'c2', 'c3'][i % 3]]: 64, c3: 20 } };
});
const rankingPilotos = (valor) => nombres.map((n, i) => ({ pos: i + 1, nombre: n, clan: ['c1', 'c2', 'c3'][i % 3], puntos: valor(i), viajes: 40 - i }));

const datos = {
  [`usuarios/${UID}`]: perfil,
  [`nombres_usuario/${perfil.username.toLowerCase()}`]: { uid: UID },
  [`cupos/${UID}`]: { dia: Math.floor(Date.now() / 864e5), viajes: variante === 'salvado' ? 1 : variante === 'cupo' ? 3 : 0, capturas: variante === 'cupo' ? 3 : 0 },
  'config/general': { rutaDestacada: '124-115', mantenimiento: false },
  [`config/misiones/dias/${hoy}`]: {
    fecha: hoy,
    misiones: [
      { tipo: 'distancia', objetivo: 5000, texto: 'Recorre 5 km hoy', ayuda: 'Suman todos tus trayectos del dia.', puntos: 20 },
      { tipo: 'velocidad', objetivo: 15, texto: 'Más de 15 km/h en un trayecto', ayuda: 'Basta con que lo consigas en uno.', puntos: 15 },
      { tipo: 'exploracion', objetivo: 1, texto: 'Termina en una estación nueva', ayuda: 'Cualquiera en la que no hayas acabado antes.', puntos: 25 },
    ],
  },
  'agregados/ruta-124-115': { filas: ruta(401), total: 9, pagina: 1, paginas: 1, hoyDia: hoy, hoy: ruta(401).slice(0, 5).map((f, i) => ({ ...f, pos: i + 1, marca: f.marca + 5 })), hoyPilotos: 14, actualizado: hace(4) },
  'agregados/ruta-1-102': { filas: ruta(349), total: 9, pagina: 1, paginas: 1, actualizado: hace(4) },
  'agregados/ruta-102-124': { filas: ruta(560), total: 9, pagina: 1, paginas: 1, actualizado: hace(4) },
  'agregados/rutas': { rutas: ['124-115', '1-102', '102-124'], viajesPorRuta: { '124-115': 31, '1-102': 18, '102-124': 12 }, actualizado: hace(4) },
  'agregados/grupos': { porPiloto: Object.fromEntries(nombres.map((n) => [n, 'plata-4'])), actualizado: hace(4) },
  'agregados/grupo-plata-4': { filas: filasGrupo, grupo: 'plata-4', mueven: 5, total: 30, pagina: 1, paginas: 1, actualizado: hace(4) },
  'agregados/ranking-general': { filas: rankingPilotos((i) => 1200 - i * 31), total: 30, pagina: 1, paginas: 1, modo: 'general', actualizado: hace(4) },
  'agregados/ranking-sprint': { filas: rankingPilotos((i) => 400 - i * 11), total: 30, pagina: 1, paginas: 1, modo: 'sprint', actualizado: hace(4) },
  'agregados/ranking-fondo': { filas: rankingPilotos((i) => Math.round(310 - i * 8.5)), total: 30, pagina: 1, paginas: 1, modo: 'fondo', actualizado: hace(4) },
  'agregados/ranking-constancia': { filas: rankingPilotos((i) => 40 - i), total: 30, pagina: 1, paginas: 1, modo: 'constancia', actualizado: hace(4) },
  'agregados/ranking-clanes': { filas: Object.entries(CLANES).map(([, c], i) => ({ pos: i + 1, nombre: c.nombre, puntos: 5200 - i * 900, viajes: 12 - i * 3, marca: String(9 - i * 2) })), total: 3, pagina: 1, paginas: 1, actualizado: hace(4) },
  'agregados/mapa': { estaciones, clanes: CLANES, resumen: { dominadas: 22, enDisputa: 5 }, actualizado: hace(4) },
  'agregados/portada': { viajesHoy: 57, pilotos: 412, actualizado: hace(4) },
  'agregados/metricas': {
    ventanas: Object.fromEntries([['hoy', 1], ['semana', 7], ['mes', 30], ['semestre', 180]].map(([k, f]) => [k, {
      sesiones: 312 * f, paginasVistas: 1400 * f, subidasAbiertas: 137 * f, subidasConFoto: 125 * f, subidasEnviadas: 107 * f,
      subidasFallidas: 3 * f, registrosAbiertos: 20 * f, registrosCompletados: 14 * f, viajesVerificados: 99 * f,
    }])),
    cohortes: [{ semana: '2026-W38', total: 40, d1: 22, d7: 15, d14: 12, d30: 9 }],
    actualizado: hace(10),
  },
};
for (const [id, c] of Object.entries(CLANES)) {
  datos[`clanes/${id}`] = { ...c, descripcion: 'Salimos de Chamberí cada mañana.', lider: id === 'c1' ? (variante === 'lider' ? UID : 'otro-uid') : 'x', miembros: id === 'c1' ? ['otro-uid', ...(perfil.clanId ? [UID] : [])] : ['x'], oficiales: [], solicitudes: id === 'c1' && variante === 'lider' ? ['s1', 's2'] : [], numMiembros: 12, biciRating: 5200, creado: hace(60 * 24 * 90) };
}
// 6d: temporadas cerradas, con sus premios en `logros`.
[['2026-08', 1132, 212, 'plata'], ['2026-07', 1214, 3, 'oro'], ['2026-06', 702, 401, 'bronce'], ['2026-05', 388, 688, 'hierro']]
  .forEach(([temporada, puntos, posicion, division]) => { datos[`usuarios/${UID}/temporadas/${temporada}`] = { temporada, puntos, posicion, division }; });
datos['agregados/clan-c1'] = {
  clanId: 'c1', nombre: CLANES.c1.nombre, color: CLANES.c1.color,
  miembros: [
    { uid: 'otro-uid', nombre: 'jorge_on_wheels', puntos: 1212, viajes: 44, metros: 120000, semana: 212 },
    { uid: UID, nombre: perfil.username, puntos: 870, viajes: 41, metros: 96400, semana: 188 },
  ],
  candidatos: variante === 'lider' ? [
    { uid: 's1', nombre: 'sergio.bm', puntos: 1400, viajes: 38, metros: 80000, division: 'plata', clanId: null },
    { uid: 's2', nombre: 'carla_fx', puntos: 300, viajes: 6, metros: 9000, division: 'bronce', clanId: 'c2' },
  ] : [],
};
nombres.slice(0, 8).forEach((n, i) => {
  datos[`tiempos_viaje/${UID}_v${i}`] = {
    uid: UID, username: perfil.username, ruta: ['124-115', '1-102', '102-124'][i % 3], tiempoSegundos: 700 + i * 37,
    fechaViaje: dia(i), estado: i === 2 ? 'rechazado' : i === 4 ? 'revision' : 'aprobado', verificado: i !== 2 && i !== 4,
    motivos: i === 2 ? ['ruta_no_coincide'] : [], revisadoPor: 'automatico', puntos: 56 - i, distanciaMetros: 2100, velocidadKmh: 9.8,
    puntosDesglose: { base: 10, distancia: 13, velocidad: 4, multiplicadorRacha: 1.5, multiplicadorRuta: 1, multiplicadorTerritorio: 1 },
    numeroBici: ['2471', '1180', '932', '2215', '1740', '2471', '318', '1180'][i],
    creado: hace(60 * 24 * i + 30),
  };
});

// 11 · Bicis: fichas de ejemplo (lo que escribe backend/src/bicis.js).
const ms = (min) => Date.now() - min * 60000;
const opinion = (nota, min, estacion, comentario, fallos = []) => ({ nota, cuando: ms(min), estacion, comentario, fallos });
datos['bicis/2471'] = {
  numero: '2471', media: 2.3, valoraciones60: 14, total: 19,
  reparto: { 5: 1, 4: 1, 3: 3, 2: 4, 1: 5 },
  fallos: [{ codigo: 'frenos', veces: 9 }, { codigo: 'asistencia', veces: 6 }, { codigo: 'bateria', veces: 4 }],
  tendencia: { antes: 3.1, direccion: 'bajando' },
  ultimas: [
    opinion(1, 120, '124', 'El freno trasero casi no frena. No la cojáis para bajar la Castellana.', ['frenos']),
    opinion(2, 60 * 26, '40', 'La asistencia se corta en cuanto hay cuesta.', ['asistencia', 'bateria']),
    opinion(3, 60 * 30, '124', 'Se puede usar, pero el sillín no se queda fijo.', ['sillin']),
    opinion(1, 60 * 24 * 3, '1', 'Frenos fatal y un ruido constante en la rueda delantera.', ['frenos', 'ruido']),
    opinion(4, 60 * 24 * 4, '102', 'Bien, algo lenta al arrancar.'),
    ...Array.from({ length: 9 }, (_, k) => opinion([2, 1, 3, 2, 5, 1, 2, 3, 1][k], 60 * 24 * (5 + k), '115', k % 2 ? '' : 'Frena poco.', k % 3 ? [] : ['frenos'])),
  ],
  vista: { estacion: '124', cuando: ms(120) },
};
datos['bicis/1180'] = { numero: '1180', media: 4.6, valoraciones60: 8, total: 8, reparto: { 5: 5, 4: 3, 3: 0, 2: 0, 1: 0 }, fallos: [], tendencia: null, ultimas: [opinion(5, 60 * 20, '1', 'Perfecta, batería al 90 %.')], vista: { estacion: '1', cuando: ms(60 * 20) } };
datos['bicis/318'] = { numero: '318', media: null, valoraciones60: 2, total: 2, reparto: { 5: 0, 4: 1, 3: 1, 2: 0, 1: 0 }, fallos: [], tendencia: null, ultimas: [opinion(4, 60 * 24 * 3, '1', 'Todo bien, la batería al 80 %.'), opinion(3, 60 * 24 * 9, '40', 'Un poco de ruido en los cambios.', ['cambios', 'ruido'])], vista: null };
datos[`valoraciones_bici/1180_${UID}_${Math.floor(Date.now() / 86400000) - 1}`] = { bici: '1180', uid: UID, nota: 5, fallos: [], comentario: '', creado: hace(60 * 24) };

// --- Motor en memoria --------------------------------------------------------------

const oyentes = new Map();
const avisar = (ruta) => { for (const cb of oyentes.get(ruta) || []) setTimeout(() => cb(snapDoc(ruta)), 0); };

function snapDoc(ruta) {
  const d = datos[ruta];
  return { id: ruta.split('/').pop(), ref: { path: ruta, id: ruta.split('/').pop() }, exists: () => d !== undefined, data: () => (d === undefined ? undefined : JSON.parse(JSON.stringify(d), revivir)) };
}
// Los Timestamp sobreviven a la copia.
function revivir(_k, v) { return v && typeof v === 'object' && typeof v.ms === 'number' && Object.keys(v).length === 1 ? new Timestamp(v.ms) : v; }

const valor = (obj, campo) => String(campo).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const cmp = (a, b) => {
  const x = a?.ms ?? a; const y = b?.ms ?? b;
  return x < y ? -1 : x > y ? 1 : 0;
};

function aplicar(previo, cambios) {
  const nuevo = { ...(previo || {}) };
  for (const [k, v] of Object.entries(cambios)) {
    const partes = k.split('.');
    let o = nuevo;
    for (const p of partes.slice(0, -1)) { o[p] = { ...(o[p] || {}) }; o = o[p]; }
    const hoja = partes[partes.length - 1];
    if (v && v.__op === 'inc') o[hoja] = (o[hoja] || 0) + v.n;
    else if (v && v.__op === 'union') o[hoja] = [...new Set([...(o[hoja] || []), ...v.xs])];
    else if (v && v.__op === 'remove') o[hoja] = (o[hoja] || []).filter((x) => !v.xs.includes(x));
    else if (v && v.__op === 'delete') delete o[hoja];
    else if (v && v.__op === 'now') o[hoja] = Timestamp.now();
    else o[hoja] = v;
  }
  return nuevo;
}

export const app = {};
export const auth = { currentUser: null };
export const db = { maqueta: true };

const sesion = () => { try { return localStorage.getItem('maqueta_sesion') !== 'fuera'; } catch { return true; } };
const usuario = { uid: UID, email: perfil.email, emailVerified: true, displayName: perfil.username, providerData: [{ providerId: 'password' }], getIdTokenResult: async () => ({ claims: { admin: Boolean(perfil.admin) } }), getIdToken: async () => 'maqueta' };

export function onAuthStateChanged(_a, cb) {
  auth.currentUser = sesion() ? usuario : null;
  setTimeout(() => cb(auth.currentUser), 50);
  return () => {};
}
export async function signInWithEmailAndPassword() { localStorage.removeItem('maqueta_sesion'); return { user: usuario }; }
export async function createUserWithEmailAndPassword() { return { user: usuario }; }
export async function signOut() { localStorage.setItem('maqueta_sesion', 'fuera'); auth.currentUser = null; }
export async function sendPasswordResetEmail() {}
export async function sendEmailVerification() {}
export async function verifyPasswordResetCode() { return 'piloto@example.com'; }
export async function confirmPasswordReset() {}
export async function applyActionCode() {}
export function getAdditionalUserInfo() { return { isNewUser: false }; }
export async function entrarConGoogle() { localStorage.removeItem('maqueta_sesion'); return { user: usuario }; }

export function collection(_db, ...segs) { return { tipo: 'col', path: segs.join('/') }; }
export function doc(base, ...segs) {
  const path = base?.tipo === 'col' ? [base.path, ...segs].join('/') : segs.join('/');
  return { tipo: 'doc', path, id: path.split('/').pop() };
}
export function query(col, ...restricciones) { return { ...col, restricciones }; }
export const where = (campo, op, v) => ({ t: 'where', campo, op, v });
export const orderBy = (campo, dir = 'asc') => ({ t: 'orderBy', campo, dir });
export const limit = (n) => ({ t: 'limit', n });
export const startAfter = () => ({ t: 'startAfter' });

function resolver(q) {
  const prefijo = `${q.path}/`;
  let docs = Object.keys(datos).filter((k) => k.startsWith(prefijo) && !k.slice(prefijo.length).includes('/')).map(snapDoc);
  for (const r of q.restricciones || []) {
    if (r.t === 'where') {
      docs = docs.filter((d) => {
        const x = valor(d.data(), r.campo);
        switch (r.op) {
          case '==': return cmp(x, r.v) === 0;
          case '!=': return cmp(x, r.v) !== 0;
          case '>': return cmp(x, r.v) > 0;
          case '>=': return cmp(x, r.v) >= 0;
          case '<': return cmp(x, r.v) < 0;
          case '<=': return cmp(x, r.v) <= 0;
          case 'in': return r.v.includes(x);
          case 'array-contains': return (x || []).includes(r.v);
          default: return true;
        }
      });
    }
  }
  for (const r of (q.restricciones || []).filter((x) => x.t === 'orderBy').reverse()) {
    docs.sort((a, b) => cmp(valor(a.data(), r.campo), valor(b.data(), r.campo)) * (r.dir === 'desc' ? -1 : 1));
  }
  const tope = (q.restricciones || []).find((r) => r.t === 'limit');
  if (tope) docs = docs.slice(0, tope.n);
  return docs;
}

export async function getDoc(ref) { return snapDoc(ref.path); }
export async function getDocs(q) {
  const docs = resolver(q);
  return { docs, empty: !docs.length, size: docs.length, forEach: (f) => docs.forEach(f) };
}
export const getDocsFromCache = getDocs;
export async function getCountFromServer(q) { const n = resolver(q).length; return { data: () => ({ count: n }) }; }

function escribir(ruta, cambios, { unir = true } = {}) {
  datos[ruta] = unir ? aplicar(datos[ruta], cambios) : aplicar({}, cambios);
  avisar(ruta);
  // Un viaje nuevo se verifica solo a los 6 segundos, como haria el worker.
  if (ruta.startsWith('tiempos_viaje/') && cambios.estado === 'pendiente') {
    setTimeout(() => {
      datos[ruta] = aplicar(datos[ruta], {
        estado: 'aprobado', verificado: true, revisadoPor: 'automatico', puntos: 69, distanciaMetros: 2100, velocidadKmh: 7.3,
        puntosDesglose: { base: 10, distancia: 13, velocidad: 0, multiplicadorRacha: 1.5, multiplicadorRuta: 2, multiplicadorTerritorio: 1 },
      });
      avisar(ruta);
    }, 6000);
  }
}
export async function setDoc(ref, d, opciones = {}) { escribir(ref.path, d, { unir: Boolean(opciones.merge) }); }
export async function updateDoc(ref, d) { escribir(ref.path, d); }
export async function addDoc(col, d) { const ref = doc(col, `auto${Date.now()}`); escribir(ref.path, d, { unir: false }); return ref; }
export async function deleteDoc(ref) { delete datos[ref.path]; avisar(ref.path); }
export function writeBatch() {
  const ops = [];
  return {
    set(ref, d, o = {}) { ops.push(() => escribir(ref.path, d, { unir: Boolean(o.merge) })); return this; },
    update(ref, d) { ops.push(() => escribir(ref.path, d)); return this; },
    delete(ref) { ops.push(() => { delete datos[ref.path]; }); return this; },
    async commit() { ops.forEach((f) => f()); },
  };
}
export async function runTransaction(_db, f) { return f({ get: getDoc, set: (r, d) => escribir(r.path, d, { unir: false }), update: (r, d) => escribir(r.path, d) }); }
export const serverTimestamp = () => ({ __op: 'now' });
export const increment = (n) => ({ __op: 'inc', n });
export const arrayUnion = (...xs) => ({ __op: 'union', xs });
export const arrayRemove = (...xs) => ({ __op: 'remove', xs });
export const deleteField = () => ({ __op: 'delete' });
export { Timestamp };

export function onSnapshot(ref, cb) {
  if (!oyentes.has(ref.path)) oyentes.set(ref.path, new Set());
  oyentes.get(ref.path).add(cb);
  setTimeout(() => cb(snapDoc(ref.path)), 30);
  return () => oyentes.get(ref.path)?.delete(cb);
}

export function traducirError(error) { return error?.message || 'Ha ocurrido un error.'; }
export function traducirErrorAuth() { return 'No se ha podido completar la operacion.'; }
export function avatarPorDefecto() { return ''; }
