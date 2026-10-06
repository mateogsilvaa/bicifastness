// Modulo de la pagina /admin/panel/: el panel de control.
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.
//
// Una mirada para saber si todo va bien: cuanta gente hay, que pide atencion
// (revision, denuncias), si el worker esta vivo y cuanta cuota gasta, como va
// la liga y la ruta de la semana, y quien ha hecho que en la administracion.
//
// Lecturas por visita: unas quince, casi todas de agregados que ya existen y
// dos conteos (que cobran una lectura por cada mil documentos).

import {
  db, doc, getDoc, getDocs, collection, query, where, orderBy, limit, getCountFromServer,
} from '/assets/js/firebase.js';
import { iniciarPagina, nombreEstacion, formatearTiempo, miles } from '/assets/js/ui.js';
import { id, el, estado, reemplazar } from '/assets/js/dom.js';
import { montarCabeceraAdmin, exigirAdmin } from '/assets/js/admin-cabecera.js';
import { NOMBRES as DIVISIONES, emblemaLiga, cuandoCambia, fechaCorta } from '/assets/js/ligas.js';
import { lunesDeLaSemana, diasHastaFinDeSemana } from '/assets/js/dia.js';

iniciarPagina('admin');
montarCabeceraAdmin('panel');

const REPO = 'https://github.com/mateogsilvaa/bicifastness';
const LIMITES_CUOTA = { lecturas: 50000, escrituras: 20000 };

const leer = async (ruta) => {
  try {
    const snap = await getDoc(doc(db, ...ruta.split('/')));
    return snap.exists() ? snap.data() : null;
  } catch {
    return null;
  }
};
const contar = async (consulta) => {
  try {
    return (await getCountFromServer(consulta)).data().count;
  } catch {
    return null;
  }
};

/** "hace 3 min", "hace 2 h" */
function hace(fecha) {
  if (!fecha) return 'nunca';
  const min = Math.round((Date.now() - fecha.getTime()) / 60000);
  if (min < 1) return 'ahora mismo';
  if (min < 60) return `hace ${min} min`;
  if (min < 1440) return `hace ${Math.round(min / 60)} h`;
  return `hace ${Math.round(min / 1440)} días`;
}

/** Semaforo por antigüedad: verde hasta `bien` minutos, ambar hasta `regular`. */
function semaforo(fecha, bien, regular) {
  if (!fecha) return 'mal';
  const min = (Date.now() - fecha.getTime()) / 60000;
  return min <= bien ? 'ok' : min <= regular ? 'aviso' : 'mal';
}

function kpi(etiqueta, valor, nota = '', enlace = null) {
  const cuerpo = [
    el('span', { clase: 'menor apagado', texto: etiqueta }),
    el('strong', { clase: 'd2', texto: valor === null ? '—' : miles(valor) }),
    nota ? el('span', { clase: 'menor apagado', texto: nota }) : null,
  ];
  return enlace
    ? el('a', { clase: 'adm-kpi', attrs: { href: enlace }, estilo: { textDecoration: 'none', color: 'inherit' } }, cuerpo)
    : el('div', { clase: 'adm-kpi' }, cuerpo);
}

const fila = (izq, der) => el('div', {}, [el('span', {}, [].concat(izq)), el('span', {}, [].concat(der))]);

async function pintar() {
  estado(id('mensaje'), '');
  const [portada, ligas, general, enRevision, denuncias, cuotaSnap] = await Promise.all([
    leer('agregados/portada'),
    leer('agregados/ligas'),
    leer('config/general'),
    contar(query(collection(db, 'tiempos_viaje'), where('estado', '==', 'revision'))),
    contar(query(collection(db, 'reportes'), where('estado', '==', 'pendiente'))),
    getDocs(query(collection(db, 'cuota'), orderBy('__name__', 'desc'), limit(1))).catch(() => null),
  ]);

  // --- Cifras ---
  reemplazar(id('kpis'), [
    kpi('Pilotos que puntúan', portada?.pilotos ?? null, portada ? `${miles(portada.usuarios || 0)} cuentas` : ''),
    kpi('Trayectos', portada?.viajes ?? null, portada ? `${miles(portada.rutas || 0)} rutas distintas` : ''),
    kpi('En revisión', enRevision, 'esperan a una persona', '/admin/#revision'),
    kpi('Denuncias', denuncias, 'pendientes', '/admin/#denuncias'),
  ]);

  // --- Sistema: worker, cuota y agregados ---
  const cuota = cuotaSnap?.docs?.[0]?.data() || null;
  const pasada = cuota?.actualizado?.toDate?.() || null;
  const reconstruido = portada?.actualizado?.toDate?.() || null;
  const pct = (n, lim) => `${Math.round(((n || 0) / lim) * 100)}%`;
  reemplazar(id('sistema'), [
    fila('Worker (verificación)', el('span', { clase: `adm-semaforo ${semaforo(pasada, 15, 60)}`, texto: hace(pasada) })),
    fila('Clasificaciones', el('span', { clase: `adm-semaforo ${semaforo(reconstruido, 30, 180)}`, texto: hace(reconstruido) })),
    fila('Lecturas hoy (worker)', cuota ? `${miles(cuota.lecturas || 0)} · ${pct(cuota.lecturas, LIMITES_CUOTA.lecturas)}` : '—'),
    fila('Escrituras hoy (worker)', cuota ? `${miles(cuota.escrituras || 0)} · ${pct(cuota.escrituras, LIMITES_CUOTA.escrituras)}` : '—'),
    fila('Pasadas hoy', cuota ? miles(cuota.pasadas || 0) : '—'),
  ]);

  // --- Liga ---
  const niveles = ligas?.niveles || [];
  reemplazar(id('liga'), niveles.length ? [
    el('p', { clase: 'menor apagado', texto: ligas.inicio && ligas.fin
      ? `Del ${fechaCorta(ligas.inicio)} al ${fechaCorta(ligas.fin)} · se cierra ${cuandoCambia()}` : '' }),
    el('div', { clase: 'adm-divisiones' }, niveles.map((n) => el('div', {}, [
      emblemaLiga(n.nivel, { tamano: 22, apagado: !n.pilotos }),
      el('span', { texto: DIVISIONES[n.nivel] || n.nivel }),
      el('strong', { texto: `${n.pilotos}${n.grupos?.length ? ` · ${n.grupos.length}g` : ''}` }),
    ]))),
  ] : el('p', { clase: 'apagado', texto: 'Todavía no hay ligas: se forman con el primer trayecto verificado.' }));

  // --- Ruta de la semana ---
  const ruta = general?.rutaDestacada || null;
  if (ruta) {
    const ag = await leer(`agregados/ruta-${ruta}`);
    const [a, b] = ruta.split('-');
    const deSemana = ag?.semanaDesde === lunesDeLaSemana() ? ag.semana || [] : [];
    reemplazar(id('ruta-semana'), [
      el('p', {}, [el('strong', { texto: `${nombreEstacion(a) || a} → ${nombreEstacion(b) || b}` })]),
      el('p', { clase: 'menor apagado', texto: `×2 hasta el domingo · quedan ${diasHastaFinDeSemana()} días · ${ag?.semanaPilotos || 0} pilotos` }),
      el('div', { clase: 'adm-estado-lista' }, deSemana.length
        ? deSemana.slice(0, 3).map((f) => fila(`${f.pos}. ${f.nombre}`, formatearTiempo(f.marca)))
        : [fila('Nadie todavía esta semana', '')]),
      el('a', { clase: 'enlace-fuerte', texto: 'Cambiarla', attrs: { href: '/admin/#pilotos' } }),
    ]);
  } else {
    reemplazar(id('ruta-semana'), el('p', { clase: 'apagado', texto: 'Sin ruta de la semana todavía.' }));
  }

  // --- Accesos ---
  const enlace = (texto, href, externo = false) => el('a', {
    clase: 'btn secundario', texto, attrs: { href, ...(externo ? { target: '_blank', rel: 'noopener' } : {}) },
  });
  reemplazar(id('atajos'), [
    enlace('Cola de revisión', '/admin/#revision'),
    enlace('Denuncias', '/admin/#denuncias'),
    enlace('Pilotos y clanes', '/admin/#pilotos'),
    enlace('Errores', '/admin/errores/'),
    enlace('Métricas', '/admin/metricas/'),
    enlace('Historias y posts', '/admin/redes/'),
    enlace('Worker en GitHub', `${REPO}/actions/workflows/verificar-viajes.yml`, true),
    enlace('Cierres de liga y temporada', `${REPO}/actions/workflows/periodicas.yml`, true),
    enlace('Consola de Firebase', 'https://console.firebase.google.com/project/bicifastness/overview', true),
  ]);

  // --- Registro ---
  try {
    const snap = await getDocs(query(collection(db, 'auditoria_admin'), orderBy('creado', 'desc'), limit(12)));
    const uids = [...new Set(snap.docs.map((d) => d.data().adminUid).filter(Boolean))];
    const nombres = new Map(await Promise.all(uids.map(async (u) => [u, (await leer(`usuarios/${u}`))?.username || u.slice(0, 6)])));
    reemplazar(id('registro'), snap.empty
      ? fila('Sin actividad todavía', '')
      : snap.docs.map((d) => {
        const r = d.data();
        return fila(`${nombres.get(r.adminUid) || '—'} · ${r.accion}`, hace(r.creado?.toDate?.() || null));
      }));
  } catch {
    reemplazar(id('registro'), fila('No se ha podido leer el registro', ''));
  }

  id('actualizado').textContent = `Actualizado ${new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
}

id('btn-recargar').addEventListener('click', () => pintar().catch((e) => estado(id('mensaje'), e.message, 'error')));

exigirAdmin('panel').then(() => pintar()).catch((error) => {
  estado(id('mensaje'), 'No se ha podido cargar el panel.', 'error');
  console.debug(error);
});
