'use strict';

/**
 * Vigilancia de la cuota diaria de Firestore (#38).
 *
 * El plan Spark da 50.000 lecturas y 20.000 escrituras al dia. Al agotarlas la
 * web no va lenta: **deja de funcionar hasta medianoche**, y no hay aviso. Con
 * un proyecto que quiere mantenimiento casi nulo, enterarse por los usuarios no
 * vale.
 *
 * docs/COSTE.md modela lo que DEBERIA costar cada operacion. Esto mide lo que
 * cuesta de verdad, que no es lo mismo: el modelo no sabe cuanta gente entra
 * hoy ni cuantos viajes hay ya acumulados.
 *
 * COMO SE MIDE. `contar(db)` devuelve un envoltorio de Firestore que suma
 * lecturas y escrituras segun pasan. Es deliberadamente tonto: solo envuelve
 * los metodos que usa este proyecto y deja pasar todo lo demas tal cual. Si el
 * contador falla, la operacion tiene que seguir adelante igual — medir el
 * consumo no puede ser el motivo de que el worker deje de verificar viajes.
 *
 * Lo que NO mide: lo que lee el navegador. Eso no pasa por aqui y no hay forma
 * de contarlo sin pedirselo a la consola de Firebase. Por eso el aviso lleva
 * escrito que es un suelo, no el total.
 */

const admin = require('firebase-admin');

// Firestore se coge de `db.js`, igual que el resto. Asi las escrituras del
// propio registro de cuota tambien se cuentan: son parte del gasto.
const { db } = require('./db');
const { diaEnZona, minutosDelDiaEnZona } = require('./util');

/** Limites del plan Spark. */
const LIMITES = {
  LECTURAS: 50000,
  ESCRITURAS: 20000,
};

/**
 * Umbrales de aviso, en porcentaje del limite.
 *
 * El de 70 existe para que dé tiempo a hacer algo: al 90 quedan un par de horas
 * de margen y a esa altura ya solo se puede apagar cosas.
 */
const UMBRALES = { ATENCION: 70, ALERTA: 90, DEGRADADO: 95 };

/**
 * La zona del contador, y no es un capricho.
 *
 * Las cuotas diarias de Firestore se reinician **alrededor de medianoche del
 * Pacifico**, no a medianoche UTC. Contando por dias UTC, el contador se ponia a
 * cero a las 00:00 UTC — las 16:00 o 17:00 en el Pacifico — cuando al consumo
 * real le quedaban siete u ocho horas de dia.
 *
 * O sea que justo en el tramo en que mas cerca se esta del limite, esto decia
 * que se llevaba gastado casi nada: ni aviso, ni modo degradado. La proteccion
 * se apagaba sola en el peor momento posible.
 *
 * https://firebase.google.com/docs/firestore/quotas
 */
const ZONA_CUOTA = 'America/Los_Angeles';

const dia = (fecha = new Date()) => diaEnZona(fecha, ZONA_CUOTA);

// --- El contador ----------------------------------------------------------------

/**
 * Envuelve una instancia de Firestore para contar lo que pasa por ella.
 *
 * Devuelve `{ db, coste }`, donde `coste` es un objeto vivo que se va
 * actualizando. No se copia: leerlo al final de la ejecucion da el total.
 */
function contar(firestore) {
  const coste = { lecturas: 0, escrituras: 0 };

  const sumarLectura = (n) => { coste.lecturas += Math.max(1, n || 0); };
  const sumarEscritura = (n = 1) => { coste.escrituras += n; };

  /** Envuelve lo que devuelve una consulta para contar los documentos leidos. */
  function contarGet(promesa) {
    return promesa.then((resultado) => {
      try {
        // Una consulta trae `size`; un documento suelto, no.
        sumarLectura(typeof resultado?.size === 'number' ? resultado.size : 1);
      } catch { /* contar nunca puede romper la operacion */ }
      return resultado;
    });
  }

  function envolverConsulta(consulta) {
    return new Proxy(consulta, {
      get(objetivo, propiedad, receptor) {
        const valor = Reflect.get(objetivo, propiedad, objetivo);
        if (typeof valor !== 'function') return valor;

        // `get` y `count` son las que cuestan.
        if (propiedad === 'get') return (...args) => contarGet(valor.apply(objetivo, args));
        if (propiedad === 'count') {
          return (...args) => envolverConsulta(valor.apply(objetivo, args));
        }

        // El resto de una consulta (`where`, `orderBy`, `limit`, `startAfter`,
        // `doc`) devuelve otra consulta o una referencia: hay que seguir
        // envolviendo o se pierde la cuenta a partir del primer `where`.
        return (...args) => {
          const siguiente = valor.apply(objetivo, args);
          if (propiedad === 'doc') return envolverDocumento(siguiente);
          return siguiente && typeof siguiente === 'object' ? envolverConsulta(siguiente) : siguiente;
        };
      },
    });
  }

  const ESCRIBEN = new Set(['set', 'update', 'delete', 'create']);

  function envolverDocumento(ref) {
    return new Proxy(ref, {
      get(objetivo, propiedad) {
        const valor = Reflect.get(objetivo, propiedad, objetivo);
        if (typeof valor !== 'function') return valor;

        if (propiedad === 'get') return (...args) => contarGet(valor.apply(objetivo, args));
        if (ESCRIBEN.has(propiedad)) {
          return (...args) => {
            sumarEscritura();
            return valor.apply(objetivo, args);
          };
        }
        if (propiedad === 'collection') {
          return (...args) => envolverConsulta(valor.apply(objetivo, args));
        }
        return (...args) => valor.apply(objetivo, args);
      },
    });
  }

  /**
   * Un lote no escribe hasta el `commit`, asi que se cuentan las operaciones
   * apuntadas y se suman de golpe. Contarlas al apuntarlas daria de mas cuando
   * un lote se descarta sin confirmar.
   */
  function envolverLote(lote) {
    let apuntadas = 0;

    return new Proxy(lote, {
      get(objetivo, propiedad) {
        const valor = Reflect.get(objetivo, propiedad, objetivo);
        if (typeof valor !== 'function') return valor;

        if (ESCRIBEN.has(propiedad)) {
          return (...args) => {
            apuntadas++;
            valor.apply(objetivo, args);
            return envolverLote(objetivo);
          };
        }
        if (propiedad === 'commit') {
          return (...args) => {
            sumarEscritura(apuntadas);
            apuntadas = 0;
            return valor.apply(objetivo, args);
          };
        }
        return (...args) => valor.apply(objetivo, args);
      },
    });
  }

  /**
   * Una transaccion, que es el unico sitio del que el contador no se enteraba.
   *
   * `runTransaction` caia en el `default` del switch de abajo y pasaba de
   * largo: todo lo que ocurria dentro —lecturas y escrituras— quedaba fuera de
   * la cuenta. En el worker eso es una lectura y una escritura por CADA viaje
   * aprobado, o sea justo lo que crece con el uso. Y un dia que alguien meta en
   * una transaccion algo que lea cincuenta documentos, el contador seguiria
   * diciendo cero.
   *
   * Es el peor sitio donde tener un punto ciego: `docs/COSTE.md` modela lo que
   * DEBERIA costar y esto mide lo que cuesta de verdad, asi que la comparacion
   * salia mal sin que nada lo delatara.
   *
   * LECTURAS Y ESCRITURAS NO SE CUENTAN IGUAL, y no es un capricho. Una
   * transaccion se REINTENTA sola cuando hay contienda, y en cada reintento la
   * funcion se ejecuta entera otra vez:
   *
   *   - las lecturas de cada intento ocurrieron de verdad y Firestore las
   *     cobra, asi que se suman segun pasan
   *   - las escrituras solo se confirman UNA vez, la del intento que sale bien,
   *     asi que se apuntan aparte y se suman al final. Es la misma idea que ya
   *     usa `envolverLote` con su `commit`: apuntar no es escribir
   */
  function envolverTransaccion(ejecutar) {
    return (funcion, ...resto) => {
      let escriturasDelIntento = 0;

      const envolverTx = (tx) => new Proxy(tx, {
        get(objetivo, propiedad) {
          const valor = Reflect.get(objetivo, propiedad, objetivo);
          if (typeof valor !== 'function') return valor;

          if (propiedad === 'get') {
            return (...args) => contarGet(valor.apply(objetivo, args));
          }
          if (propiedad === 'getAll') {
            return (...args) => valor.apply(objetivo, args).then((docs) => {
              sumarLectura(docs.length);
              return docs;
            });
          }
          if (ESCRIBEN.has(propiedad)) {
            return (...args) => {
              escriturasDelIntento++;
              valor.apply(objetivo, args);
              // Devuelve la propia transaccion, para poder encadenar.
              return envolverTx(objetivo);
            };
          }
          return (...args) => valor.apply(objetivo, args);
        },
      });

      return ejecutar((tx) => {
        // Cada intento empieza de cero: si este no llega a confirmarse, sus
        // escrituras no se han cobrado.
        escriturasDelIntento = 0;
        return funcion(envolverTx(tx));
      }, ...resto).then((resultado) => {
        sumarEscritura(escriturasDelIntento);
        return resultado;
      });
    };
  }

  const envuelta = new Proxy(firestore, {
    get(objetivo, propiedad) {
      const valor = Reflect.get(objetivo, propiedad, objetivo);
      if (typeof valor !== 'function') return valor;

      switch (propiedad) {
        case 'collection': return (...a) => envolverConsulta(valor.apply(objetivo, a));
        case 'doc': return (...a) => envolverDocumento(valor.apply(objetivo, a));
        case 'batch': return (...a) => envolverLote(valor.apply(objetivo, a));
        case 'runTransaction': return envolverTransaccion(valor.bind(objetivo));
        case 'getAll': return (...a) => valor.apply(objetivo, a).then((docs) => {
          sumarLectura(docs.length);
          return docs;
        });
        default: return (...a) => valor.apply(objetivo, a);
      }
    },
  });

  return { db: envuelta, coste };
}

// --- Registro y aviso -------------------------------------------------------------

/**
 * Suma lo consumido en esta pasada al contador del dia.
 *
 * Va con `increment` y no reescribiendo el total: el worker no sabe lo que
 * llevan las pasadas anteriores, y leerlo para sumarlo costaria una lectura mas
 * cada vez.
 */
async function registrar(coste, fecha = new Date()) {
  const ref = db().doc(`cuota/${dia(fecha)}`);

  await ref.set({
    lecturas: admin.firestore.FieldValue.increment(coste.lecturas),
    escrituras: admin.firestore.FieldValue.increment(coste.escrituras),
    pasadas: admin.firestore.FieldValue.increment(1),
    actualizado: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

/**
 * Proyecta el consumo del dia entero a partir de lo que va.
 *
 * Reparte de forma lineal sobre las horas transcurridas. Es tosco a proposito:
 * un modelo mas fino de la curva de uso diario acertaria mas al mediodia y
 * seguiria sin decir nada util a las nueve de la manana, que es cuando serviria
 * de algo enterarse.
 */
function estimar(consumido, fecha = new Date()) {
  // Minutos del dia DE LA CUOTA, no del dia UTC: se esta proyectando el consumo
  // de una ventana que empieza a medianoche del Pacifico.
  const minutos = minutosDelDiaEnZona(fecha, ZONA_CUOTA);
  // Antes de la primera media hora no se proyecta: dividir por casi cero da
  // cifras absurdas que solo generarian avisos falsos.
  if (minutos < 30) return null;

  const proporcion = minutos / (24 * 60);
  return {
    lecturas: Math.round((consumido.lecturas || 0) / proporcion),
    escrituras: Math.round((consumido.escrituras || 0) / proporcion),
  };
}

/**
 * Nivel de alarma segun lo consumido HASTA AHORA, no segun la proyeccion.
 *
 * La proyeccion sirve para avisar pronto; el modo degradado tiene que
 * dispararse con lo que ya se ha gastado de verdad, porque apagar media web por
 * una proyeccion optimista o pesimista seria peor que el problema.
 */
function nivel(consumido) {
  const porcentaje = Math.max(
    ((consumido.lecturas || 0) / LIMITES.LECTURAS) * 100,
    ((consumido.escrituras || 0) / LIMITES.ESCRITURAS) * 100,
  );

  if (porcentaje >= UMBRALES.DEGRADADO) return { nivel: 'degradado', porcentaje };
  if (porcentaje >= UMBRALES.ALERTA) return { nivel: 'alerta', porcentaje };
  if (porcentaje >= UMBRALES.ATENCION) return { nivel: 'atencion', porcentaje };
  return { nivel: 'normal', porcentaje };
}

/**
 * ¿Hay que avisar, y de que?
 *
 * Solo se avisa al SUBIR de umbral, no en cada pasada: con el worker corriendo
 * cada cinco minutos, avisar mientras se este por encima del 70% son 288
 * correos en un dia malo, y a partir del tercero nadie los lee.
 */
function avisoPendiente(consumido, avisado = null) {
  const orden = ['normal', 'atencion', 'alerta', 'degradado'];
  const actual = nivel(consumido);

  if (actual.nivel === 'normal') return null;
  if (avisado && orden.indexOf(avisado) >= orden.indexOf(actual.nivel)) return null;

  return actual;
}

module.exports = {
  contar,
  registrar,
  estimar,
  nivel,
  avisoPendiente,
  LIMITES,
  UMBRALES,
  dia,
};
