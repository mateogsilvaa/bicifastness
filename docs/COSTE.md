# Cuanto cuesta cada pantalla

El plan Spark da **50.000 lecturas y 20.000 escrituras al dia**. No es una
factura mas alta al pasarse: al agotarlo, **la web deja de funcionar hasta
medianoche**.

Los numeros de aqui no son una intuicion. Salen de `scripts/auditar-lecturas.js`,
que modela el coste a partir de las llamadas que hay en el codigo — cada
`getDocs(collection(...))` es una lectura por documento — y se puede volver a
correr cuando el codigo cambie:

```bash
node scripts/auditar-lecturas.js              # tabla en pantalla
node scripts/auditar-lecturas.js --markdown   # las tablas de este documento
node scripts/auditar-lecturas.js --comprobar  # falla si algo se dispara
```

Se modela en vez de medir en vivo porque lo que hay que saber no es lo que
cuesta hoy con seis usuarios, sino **como crece**.

## Lo que ya encontro, y ya esta arreglado

### `metricas.resumir` se llevaba el 95% de todas las lecturas

Necesita `usuarios` y `tiempos_viaje` enteros — la retencion por cohortes no
sale de otro sitio — y se ejecutaba **en cada pasada del worker**, o sea 288
veces al dia, hubiera pasado algo o no. Con los datos de hoy eso son **402.000
lecturas diarias, ocho veces la cuota, con seis personas usando la web y sin que
ocurriera absolutamente nada**.

El sintoma habria sido la web cayendose todas las tardes sin explicacion.

- El resumen caro va como mucho **una vez cada 6 horas**. Nadie mira la
  retencion a 30 dias esperando verla cambiar en cinco minutos. Lo que si sigue
  en cada pasada es `agregarSesiones`, que es la parte barata.
- `reconstruirAgregados` y el resumen necesitan **las mismas dos colecciones**.
  Cuando coinciden — justo cuando ha habido movimiento — se cargan una sola vez.

### `recalcularTrasCambio` leia las dos colecciones por cada viaje aprobado

Recalcular el dominio de una estacion cuesta leer `tiempos_viaje` y `usuarios`
enteros, y se hacia una vez por cada viaje que se aprobaba: 15.464 lecturas por
viaje con 15.000 acumulados, o sea que **treinta y tres aprobaciones agotaban la
cuota del proyecto entero**. Y no dependia de que nadie mirase la web: bastaba
con que la gente subiera viajes.

Ahora los puntos de la ruta si se rehacen viaje a viaje — cambian la
clasificacion y el siguiente de la tanda tiene que verla al dia — pero el
dominio de las estaciones se acumula y se recalcula **una vez al final**, con la
carga que para entonces ya esta en la mano. Recalcular la misma estacion diez
veces en una pasada daba diez veces el mismo resultado.

### `/territorio/` leia 631 documentos

Era la ultima pantalla que recorria colecciones enteras. El agregado del mapa ya
existia — lo escribia el worker — y la pantalla simplemente no lo usaba: seguia
leyendo `clanes` y `estaciones_stats` a mano (#27). Una lectura en vez de 631.

De paso, el agregado deja fuera las estaciones donde no tiene influencia nadie,
que son la inmensa mayoria al principio, y lleva un guardarrail de tamano: un
documento tiene un tope duro de 1 MiB, y conviene enterarse al escribirlo y no
cuando la escritura falle en produccion con el mapa lleno.

### La portada leia una ruta entera en cada visita

`pintarUltimaMarca` traia todos los viajes del piloto y despues **todos los
viajes verificados de su ultima ruta**. Esa segunda consulta no tenia techo
ninguno: una ruta popular con 3.000 marcas costaba 3.000 lecturas cada vez que
alguien abria la portada, que es la pantalla que mas se abre.

Ahora el puesto sale del agregado de la ruta, que el worker ya deja ordenado.

### `/yo/` traia el historial entero para pintar tres filas

Quien lleva un ano usando esto acumula cientos de viajes, y se pagaban todos en
cada visita a su perfil. Ahora pagina de 20 en 20 con `startAfter`, y el total
sale de la consulta de conteo de Firestore, que cobra una lectura por cada 1.000
documentos contados.

**Resultado: de 423.291 lecturas al dia a 22.035. Del 847% de la cuota al 44%.**

## Donde se esta hoy

| Escenario | Activos/dia | Viajes acumulados | Lecturas/dia | % de la cuota |
|---|---:|---:|---:|---:|
| hoy | 6 | 1022 | 22.035 | 44% |
| u50 | 50 | 3000 | 143.316 | 287% **se agota** |
| u200 | 200 | 15.000 | 1.269.982 | 2540% **se agota** |
| u1000 | 1000 | 90.000 | 27.818.982 | 55638% **se agota** |


Tres cosas que hay que leer bien de esa tabla:

1. **Hoy se cabe con holgura.** 44% de la cuota con seis personas.
2. **Con 50 usuarios activos la cuota se agota en ocho horas.** Mejor que las
   dos y media de partida, pero sigue sin llegar a medianoche.
3. El crecimiento no es proporcional al numero de usuarios, es **cuadratico**:
   varias operaciones del worker leen la coleccion entera de viajes, y esa
   coleccion crece con los usuarios.

La variable que mas duele no es cuanta gente hay, sino **cuantos viajes hay
acumulados**, que sube todos los dias aunque no entre nadie nuevo.

## Coste por pantalla

| Pantalla | Lecturas por carga | De donde salen |
|---|---:|---|
| `/statssss/` | 15.765 | las cuatro colecciones enteras |
| `/subir/` | 61 | perfil + sus 60 viajes mas recientes, para el limite diario |
| `/yo/` | 25 | perfil + temporadas + el conteo + la primera pagina del historial (20) |
| `/` | 7 | perfil + mision + config + clan + su ultimo viaje + el conteo + el agregado de la ruta |
| `/clasificacion/` | 1 | el agregado del modo; las visitas repetidas salen de la cache de sesion |
| `/territorio/` | 1 | el agregado del mapa: clanes y estaciones en un solo documento |

_Con 200 usuarios activos y 15.000 viajes acumulados._

## Coste por operacion del worker

| Operacion del worker | Lecturas por vez | De donde salen |
|---|---:|---|
| reconstruirAgregados (una vez por pasada CON viajes) | 15.765 | usuarios y viajes (compartidos con el resumen de metricas) + clanes + estaciones |
| metricas.resumir (una vez cada 6 h) | 15.441 | la marca del agregado + TODOS los usuarios + TODOS los viajes + 200 dias |
| prepararDia, la parte cara (UNA vez al dia) | 15.000 | TODOS los viajes verificados, para elegir la ruta del dia |
| recalcularRuta (por viaje APROBADO) | 798 | los viajes de esa ruta + quien ya puntuaba en ella |
| reunirContexto (por viaje procesado) | 640 | tiempos de la ruta (tope 200) + propios (tope 40) + huellas (tope 400) |
| metricas.agregarSesiones (por pasada) | 400 | las sesiones del navegador sin agregar todavia |
| validarBasico y captura (por viaje procesado) | 62 | sus 60 viajes recientes + la captura + la distancia de la ruta |
| recalcularEstaciones (una vez por pasada CON viajes) | 60 | una lectura por estacion tocada; usuarios y viajes vienen compartidos |
| cola y bajas (por pasada) | 3 | las consultas de cola, recalculo pendiente y bajas |
| prepararDia (por pasada) | 2 | mision del dia + config; corta en seco si la ruta del dia ya esta elegida |
| metricas.tocaResumir (por pasada) | 1 | la marca del agregado, para saber si toca el resumen caro |

## Lo que queda, por impacto

### 1. `reconstruirAgregados`

Lee las cuatro colecciones y se ejecuta una vez por cada pasada del worker que
haya movido algo. Con 240 subidas al dia repartidas, son unas treinta pasadas y
472.950 lecturas.

Es el precio de reconstruir desde cero. La palanca obvia es la misma que se uso
con el resumen de metricas: no rehacerlo mas de cada N minutos. Como el worker
ya llega con 5-15 minutos de retraso — GitHub retrasa los cron programados —,
un limite de 15 minutos apenas se nota y divide el coste por tres. La alternativa
de fondo es reconstruir solo lo que ha cambiado, que es bastante mas trabajo.

### 2. `/statssss/`

Lee las cuatro colecciones enteras: 15.765 lecturas por visita, un tercio de la
cuota diaria de una sentada. Deberia leer de `agregados/portada` y
`agregados/metricas`, que ya existen y ya tienen los numeros que pinta.

### 3. `metricas.agregarSesiones`

Lee `sesiones_web` entera en **cada pasada**, 288 veces al dia. Con 200 activos
son 400 documentos por pasada: 115.200 al dia. Podar es barato, pero leerlo todo
para podar no.

### 4. `prepararDia` y `reunirContexto`

`prepararDia` lee todos los viajes una vez al dia para elegir la ruta destacada.
Es una sola vez, asi que no urge, pero crece con la coleccion.

`reunirContexto` cuesta 640 lecturas por viaje procesado y es **constante**: no
empeora al crecer el proyecto. El tope de 400 huellas es el que mas pesa y se
puede bajar sin perder casi deteccion.

## Lo que ya esta bien

- `/clasificacion/` cuesta **1** lectura, y las visitas repetidas dentro de la
  misma pestana cuestan **cero**. Era la pantalla mas cara del proyecto. Es el
  patron a copiar.
- Los conteos van con la consulta de agregacion de Firestore, que cobra **una
  lectura por cada 1.000 documentos contados**. Traerse la coleccion para hacer
  `.length` costaba una por documento.
- `/subir/` esta acotada con `limit(60)`.
- `prepararDia` corta en seco si la ruta del dia ya esta elegida: la parte cara
  ocurre una vez al dia, no 288.
- `reunirContexto` tiene topes (200, 40, 400). 640 lecturas por viaje es mucho,
  pero es **constante**: no empeora al crecer el proyecto. El tope de 400
  huellas es el que mas pesa y se puede bajar sin perder casi deteccion.
- La cache de distancias cuesta **una** lectura por viaje.
- El worker consulta la cola con `limit`, asi que una pasada en vacio cuesta
  tres lecturas, no una por documento.
- Leaflet solo se carga en `/territorio/`, no en el arranque comun.

## Y ahora se vigila sola

Este documento modela lo que DEBERIA costar cada operacion. Lo que cuesta de
verdad depende de cuanta gente entre hoy y de cuantos viajes haya acumulados, y
eso solo se sabe midiendo.

El worker lo mide (#38): toda la instancia de Firestore del backend va envuelta
en un contador, y al final de cada pasada suma lo consumido a `cuota/{dia}`.

- Al **70%** y al **90%** sale un correo a `CORREO_ADMIN`, una sola vez por
  umbral: con el worker corriendo cada cinco minutos, avisar mientras se este
  por encima serian 288 correos en un dia malo y a partir del tercero nadie los
  lee.
- Por encima del **95%** entra en **modo degradado**: deja de reconstruir
  agregados, de resumir metricas y de recalcular el dominio de las estaciones,
  pero sigue verificando viajes. La clasificacion se queda unos minutos vieja en
  vez de que la web caiga entera hasta medianoche.
- La grafica de los ultimos catorce dias esta en `/admin/metricas/`.

**Lo que el worker cuenta no es el total.** Lo que leen los navegadores no pasa
por ahi y no hay forma de contarlo sin pedirselo a Firebase. Es un suelo, y el
aviso lo dice.

## Cuentas que no se han hecho aqui

- **Escrituras.** El limite es 20.000 al dia y `reconstruirAgregados` escribe en
  lotes. Merece su propia auditoria.
- **Ancho de banda.** Traerse 15.000 documentos no solo cuesta cuota: cuesta
  megas en un movil, en la calle. Eso no lo mide este modelo y es lo que decide
  si la app se siente rapida.
- La cache local de Firestore (#37) sirve sin gastar cuota las consultas que no
  han cambiado, pero el modelo **no la descuenta**: cuanto ahorra depende de
  cuanto se repita cada persona, y suponerlo es como se acaba con un numero
  optimista que no protege de nada. Lo que hay aqui es el techo.
