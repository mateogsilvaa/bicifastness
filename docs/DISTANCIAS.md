# Distancias entre estaciones

De este dato cuelgan **el modo Fondo y todo el calculo de velocidad**. Si la
distancia esta mal, los kilometros que le contamos a un piloto no son los suyos,
y eso lo nota.

El usuario **no la declara**: se deduce del par de estaciones. Es deliberado, y
significa que anadir distancia y velocidad al juego no abrio superficie nueva de
fraude.

## El problema con la estimacion

La distancia se estimaba como linea recta multiplicada por
`FISICA.FACTOR_CALLEJERO = 1,35`.

Para lo que se invento sirve: descartar imposibles fisicos. Una BiciMAD corta la
asistencia a 25 km/h, asi que hay un suelo duro de tiempo para cada par y un
factor conservador basta para detectar un tiempo inventado.

Para puntuar se queda corta. El 1,35 es un valor fijo y el error se dispara justo
donde hay un obstaculo grande de por medio: dos estaciones a los lados del
Retiro, del Manzanares o de la M-30 estan cerca en linea recta y lejos en bici.

## Las tres fuentes

`backend/src/distancias.js`, en este orden:

| Origen | De donde sale | `estimada` |
|---|---|---|
| tabla | `backend/lib/distancias.json`, precalculada con OSRM | `false` |
| cache | `distancias/{ruta}` en Firestore | `false` |
| estimacion | linea recta x 1,35 | `true` |

**La marca importa tanto como el numero.** Un consumidor que no mire `estimada`
estaria puntuando kilometros con un error grande como si fueran de ruta real. La
marca viaja hasta el documento del viaje.

El sistema nunca se queda sin valor: si el par no esta calculado, estima y lo
dice. La tabla es opcional — el repositorio se clona sin ella — y sin tabla todo
funciona, solo que todo sale estimado.

## Por que no se calcula la matriz entera

Son 631 estaciones: unos 397.000 pares. No cabe en un fichero razonable ni tiene
sentido pedirselo a un router de cortesia, y la inmensa mayoria de esos pares no
los recorre nadie nunca.

Se calculan **solo los pares que aparecen en viajes reales**, que son unos pocos
cientos.

## Como se genera

```bash
# los pares que ya existen en tiempos_viaje
export GOOGLE_APPLICATION_CREDENTIALS=/ruta/serviceAccountKey.json
node scripts/build-distancias.js --firestore

# o una lista a mano, una ruta por linea con formato "002-110"
node scripts/build-distancias.js --rutas rutas.txt

# ensayo, sin escribir
node scripts/build-distancias.js --rutas rutas.txt --simular
```

La tabla es un fichero **generado que se commitea**, como
`assets/data/estaciones.js`. **No se regenera en el CI**: necesita red y un
servicio de terceros, y un CI que dependa de una instancia de cortesia ajena se
cae el dia que esa instancia tenga un mal dia.

Hoy se commitea vacia: hace falta una pasada con credenciales para llenarla.

### El router

La instancia publica de demostracion de OSRM con perfil de bicicleta. Es de
cortesia y tiene limite de peticiones: de ahi la espera de algo mas de un
segundo entre llamadas y los reintentos.

Para una tanda grande conviene levantar OSRM en local con un extracto de Madrid
de OpenStreetMap. El formato de respuesta es el mismo.

## El bucle completo

1. Llega un viaje con una ruta que no esta en la tabla.
2. El worker la estima y marca el viaje con `distanciaEstimada: true`.
3. `build-distancias.js` la pide al router y la mete en la tabla.
4. Los viajes siguientes de esa ruta ya salen con la distancia real.

Los viajes anteriores conservan la distancia estimada. Recalcularlos exigiria
releer la coleccion entera, que es lo que la cuota del plan Spark no aguanta
(ver [COSTE.md](COSTE.md)); y como van marcados, se puede hacer mas adelante y a
proposito.

## Coste

La cache de Firestore cuesta **una lectura por viaje procesado**
(`distancias/{ruta}`, un documento). No se lee la coleccion entera: puede acabar
teniendo cientos de pares y traerlos todos en cada pasada se comeria la cuota
para nada.

La tabla viaja con el codigo y no cuesta lecturas.
