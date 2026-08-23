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

Leia `usuarios` y `tiempos_viaje` enteros y se ejecutaba **en cada pasada del
worker**, o sea 288 veces al dia, hubiera pasado algo o no. Con los datos de hoy
eso son **402.000 lecturas diarias, ocho veces la cuota, con seis personas usando
la web y sin que ocurriera absolutamente nada**.

El sintoma habria sido la web cayendose todas las tardes sin explicacion.

Va como mucho **una vez cada 6 horas**: nadie mira la retencion a 30 dias
esperando verla cambiar en cinco minutos. Lo que si sigue en cada pasada es
`agregarSesiones`, que es la parte barata.

Mas abajo esta la segunda mitad de esta historia: dejar de leer las dos
colecciones enteras tambien las cuatro veces que quedaban.

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

### Reconstruir los agregados leia las cuatro colecciones enteras

Y recalcular el dominio de una estacion, las dos grandes. Las dos cosas pasaban
en **cada pasada del worker que hubiera movido algo**: 15.200 lecturas por
pasada con 15.000 viajes acumulados, unas 163 veces al dia. **Dos millones y
medio de lecturas diarias sin que nadie abriera la web.**

Lo que lo desbloqueo fue mirar para que hacen falta los viajes de verdad:

- Las cuatro clasificaciones de pilotos, la de clanes y el mapa **no los usan**.
  Salen de `usuarios`, `clanes` y `estaciones_stats`.
- Los viajes solo hacen falta para los agregados **por ruta** y para el contador
  de la portada, que ahora sale de una consulta de agregacion.
- La influencia sobre una estacion sale **solo de los viajes de las rutas que la
  tocan**, y el indice de `agregados/rutas` dice cuales son sin recorrer nada.

Asi que sabiendo QUE se ha movido, no hace falta leerlo todo. El worker apunta
las rutas que toca durante la tanda y al final reconstruye en **modo parcial**.
Y hay dos frenos, no uno: el parcial abarata UNA reconstruccion, y el limitador
de quince minutos recorta CUANTAS se hacen. Hacen falta los dos, porque incluso
en parcial cada reconstruccion escribe nueve documentos largos.

Tres detalles que no son opcionales, y cada uno tiene su test:

- Una ruta movida mientras el limitador espera **queda apuntada** en
  `config/agregados_pendientes`. El worker de Actions arranca de cero en cada
  ejecucion: sin eso, esa ruta se quedaria con el agregado viejo hasta que
  alguien volviera a subir algo ahi.
- El indice de rutas y el total de la portada **se conservan**. En parcial solo
  se conocen las rutas movidas; sobrescribir con eso dejaria el selector de
  `/clasificacion/` con una entrada y la portada diciendo que hay 8 viajes.
- Si el indice de rutas todavia no existe, el dominio **se calcula por la via
  cara**. Tomar "no lo se" por "no hay ninguna ruta" pondria la influencia a cero
  y dejaria el mapa sin dueños de un dia para otro.

### La ventana de huellas se releia por cada viaje de la tanda

`reunirContexto` traia las 400 huellas de captura mas recientes **por cada viaje
procesado**. Son los mismos documentos: con 25 viajes en una pasada, 25 veces lo
mismo. 153.600 lecturas al dia con 240 subidas, y era la operacion mas cara del
worker una vez arreglados los agregados.

Tres cambios, y el segundo mejora la deteccion en vez de empeorarla:

- La ventana se lee **una vez por ejecucion** y se cachea. No arriesga nada:
  `huellas_captura` esta cerrada en las reglas y solo la escribe este worker, las
  ejecuciones no se solapan, y las huellas que crea la propia ejecucion se meten
  en la cache segun se escriben.
- El duplicado **byte a byte** ya no se busca recorriendo la ventana: el id del
  documento ES el sha, asi que es una lectura directa. Cuesta 1 en vez de 400 y
  **pilla el duplicado por viejo que sea** — antes se escapaba todo lo que
  hubiera salido de la ventana.
- La ventana perceptual baja de 400 a 150. Solo acota la comparacion blanda, la
  que pilla una captura recomprimida o recortada, y eso se hace a los pocos dias
  del original, no meses despues.

De 640 lecturas por viaje procesado a 241, mas 150 una vez por ejecucion.

### Tres sitios mas que leian una coleccion entera

Con los agregados y las huellas resueltos, lo que quedaba arriba eran tres
consultas sin techo. Ninguna necesitaba lo que pedia:

- **`recalcularRuta`** leia TODOS los viajes verificados de una ruta por cada
  viaje aprobado. Solo puntuan los siete primeros y solo cuenta el mejor tiempo
  de cada piloto, asi que ahora lee los 200 mas rapidos: a quien se cae del podio
  se le quitan los puntos por la otra consulta, la de quien ya puntuaba. El
  indice que hace falta para ordenar ya existia.
- **`prepararDia`** leia `tiempos_viaje` ENTERA una vez al dia para saber cuantos
  viajes tiene cada tramo y elegir la ruta destacada. Ese conteo lo puede dejar
  escrito la reconstruccion de agregados, que ya tiene los viajes en la mano:
  ahora va en `agregados/rutas` y `prepararDia` lo lee de una vez. De 15.000
  lecturas a 1.
- **`recalcularEstacion`** leia `usuarios` entera para una sola cosa: de que clan
  es cada piloto. Eso esta en `clanes/{id}.miembros`, que son 25 documentos en
  vez de 200 — y ademas es la fuente de verdad, porque `usuarios.clanId` lo
  escribe cada uno en su propio documento.

### El resumen de metricas leia la coleccion de viajes entera

Era el ULTIMO sitio que lo hacia, y mientras siguiera ahi el coste del proyecto
crecia solo por llevar tiempo abierto, aunque no entrara nadie nuevo. 15.441
lecturas cada seis horas con 15.000 viajes acumulados.

Lo desbloquea una observacion sobre lo que es una cohorte. "Que porcentaje de los
que se dieron de alta esa semana seguia subiendo trayectos a los 1, 7, 14 y 30
dias" es un numero que, pasados esos 30 dias, **ya no puede cambiar**: esta
congelado para siempre. Se estaban leyendo dos colecciones enteras, cuatro veces
al dia, para recalcular cifras que llevaban meses fijas.

Ahora solo se recalculan las cohortes vivas — las de los ultimos cuarenta y cinco
dias — y las demas se copian del resumen anterior. Y de los viajes de un piloto
hace falta UNO: el mas lejano, porque la pregunta de una cohorte es "¿hasta
cuando siguio ahi?". Una lectura por cabeza, con un indice que ya existia.

Los totales y los viajes por ventana salen de consultas de conteo, que cobran una
lectura por cada MIL documentos contados. De 15.441 lecturas a 677.

Dos detalles con su test:

- La primera vez SI se calcula todo, una sola vez. Se conservan doce semanas de
  cohorte pero solo seis y pico siguen vivas: las otras cinco no se pueden
  deducir de nada, asi que o se calculan una vez o no existen nunca.
- Los usuarios se leen desde el LUNES de hace cuarenta y cinco dias, no desde el
  dia cuarenta y cinco. Cortando a media semana, esa semana saldria sin los que
  se dieron de alta entre su lunes y el corte.

De paso, el aviso de racha en peligro tiraba de la misma carga compartida, que
traia `tiempos_viaje` entera: 15.000 lecturas al dia para un aviso que no mira ni
un viaje. Ahora lee solo `usuarios`, y corta por la hora antes de leer nada.

### Un turno de refresco, para lo que la reconstruccion parcial no ve

El agregado de una ruta lleva dentro el nombre, el avatar y el clan de cada
piloto. Eso no cambia cuando cambia la ruta: cambia cuando alguien se renombra o
entra en un clan. En parcial solo se rehacen las rutas movidas, asi que ese
piloto se quedaria con el nombre viejo en las diez tablas donde sale.

Lo tapaba la reconstruccion completa que caia cada seis horas con el resumen de
metricas. Ese acoplamiento era invisible y acaba de desaparecer, asi que ahora se
dice a proposito: cada reconstruccion refresca ademas **tres rutas por turno
rotatorio**, con el cursor guardado en el propio indice. Da la vuelta al catalogo
cada dos dias y medio y cuesta unas 75 lecturas por reconstruccion; veinte por
turno lo arreglarian en tres horas y costarian 44.000 lecturas al dia, mas que
todo lo que gasta hoy el worker junto.

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

**Resultado con los datos de hoy: de 423.291 lecturas al dia a 12.882. Del 847%
de la cuota al 26%.**

Con 200 activos y 15.000 viajes acumulados, que es donde se ve si algo escala:
reconstruir los agregados pasa de **15.765 lecturas cada vez a 858**, y
recalcular el dominio de una tanda de estaciones de **15.200 a 179** y el
resumen de metricas de **15.441 a 677**. El total del escenario baja de 1.269.982
lecturas al dia a 265.379, y el de mil usuarios de 27,8 millones a 1,9.

Y lo que mas importa a largo plazo: **ya no queda ni un sitio que lea
`tiempos_viaje` entera**. El coste depende de cuanta gente entra y cuanto se
sube, no de cuanto tiempo lleva el proyecto abierto.

## Donde se esta hoy

| Escenario | Activos/dia | Viajes acumulados | Lecturas/dia | % de la cuota |
|---|---:|---:|---:|---:|
| hoy | 6 | 1022 | 12.882 | 26% |
| u50 | 50 | 3000 | 64.673 | 129% **se agota** |
| u200 | 200 | 15.000 | 265.379 | 531% **se agota** |
| u1000 | 1000 | 90.000 | 1.929.697 | 3859% **se agota** |


Tres cosas que hay que leer bien de esa tabla:

1. **Hoy se cabe con holgura.** 26% de la cuota con seis personas.
2. **Con 50 usuarios activos la cuota se agota a las diecinueve horas.** Mejor
   que las ocho de la vuelta anterior y que las dos y media de partida, pero
   sigue sin llegar a medianoche.
3. **Nada crece ya con la coleccion de viajes.** Ni una sola operacion la lee
   entera. Lo que queda crece con la gente activa y con las subidas, que es como
   tiene que ser: el coste ya no sube solo por llevar mas tiempo abierto.

La variable que mas duele no es cuanta gente hay, sino **cuantos viajes hay
acumulados**, que sube todos los dias aunque no entre nadie nuevo.

## Coste por pantalla

| Pantalla | Lecturas por carga | De donde salen |
|---|---:|---|
| `/subir/` | 61 | perfil + sus 60 viajes mas recientes, para el limite diario |
| `/yo/` | 25 | perfil + temporadas + el conteo + la primera pagina del historial (20) |
| `/` | 7 | perfil + mision + config + clan + su ultimo viaje + el conteo + el agregado de la ruta |
| `/statssss/` | 2 | los agregados de portada y mapa |
| `/clasificacion/` | 1 | el agregado del modo; las visitas repetidas salen de la cache de sesion |
| `/territorio/` | 1 | el agregado del mapa: clanes y estaciones en un solo documento |

_Con 200 usuarios activos y 15.000 viajes acumulados._

## Coste por operacion del worker

| Operacion del worker | Lecturas por vez | De donde salen |
|---|---:|---|
| reconstruirAgregados (parcial, como mucho cada 15 min) | 933 | usuarios + clanes + estaciones + los viajes de las rutas movidas y de las tres del turno de refresco + el conteo agregado + el indice, la portada y las rutas pendientes |
| metricas.resumir (una vez cada 6 h) | 677 | los 200 dias + el resumen anterior + las altas recientes y su ultimo viaje + los conteos de totales y ventanas |
| recalcularRuta (por viaje APROBADO) | 248 | los 200 mas rapidos de esa ruta + quien ya puntuaba en ella |
| reunirContexto (por viaje procesado) | 241 | tiempos de la ruta (tope 200) + propios (tope 40) + el duplicado exacto por id |
| avisarRachasEnPeligro (UNA vez al dia, a las 20:00) | 240 | TODOS los usuarios, para ver a quien se le cae la racha |
| recalcularEstaciones (una vez por pasada CON viajes) | 179 | el indice de rutas + los clanes (de ahi sale de quien es cada piloto) + los viajes de las rutas que tocan cada estacion |
| la ventana de huellas (una vez por ejecucion CON viajes) | 150 | las 150 huellas mas recientes, cacheadas para toda la ejecucion |
| validarBasico y captura (por viaje procesado) | 62 | sus 60 viajes recientes + la captura + la distancia de la ruta |
| cola y bajas (por pasada) | 3 | las consultas de cola, recalculo pendiente y bajas |
| prepararDia (por pasada) | 2 | mision del dia + config; corta en seco si la ruta del dia ya esta elegida |
| metricas.agregarSesiones (por pasada) | 1 | las sesiones llegadas desde la pasada anterior |
| metricas.tocaResumir (por pasada) | 1 | la marca del agregado, para saber si toca el resumen caro |
| agregados.tocaReconstruir (por pasada con movimiento) | 1 | la marca del agregado de portada, para saber si toca |
| prepararDia, la parte cara (UNA vez al dia) | 1 | el indice de rutas, que ya trae cuantos viajes tiene cada tramo |

## Lo que queda, por impacto

Los numeros son del escenario u200: 200 activos al dia, 240 subidas y 15.000
viajes acumulados.

### 1. `reconstruirAgregados` — 82.104 lecturas/dia

Ya va en parcial y como mucho cada quince minutos. Lo que queda son `usuarios`
(200) y `estaciones_stats` (500) enteras en cada reconstruccion. Las
clasificaciones de pilotos necesitan a todo el mundo por definicion; lo que se
puede acotar es el mapa, que solo cambia en las estaciones tocadas y podria
escribirse con `merge` en vez de rehacerse entero.

### 2. `reunirContexto` — 57.840 lecturas/dia

241 por viaje procesado, casi todo el tope de 200 mejores tiempos de la ruta. El
veredicto solo usa la distribucion y el record, asi que el tope se puede bajar
bastante. Es **constante**: no empeora al crecer el proyecto, solo al subir mas
viajes.

### 3. `recalcularRuta` y `recalcularEstaciones` — unas 30.000 cada una

Las dos ya estan acotadas y las dos pagan lo mismo: una consulta por ruta, con su
minimo de una lectura aunque no devuelva nada. Bajar de ahi pide mantener por
ruta un documento con el mejor tiempo de cada piloto, que es un estado derivado
mas que puede desincronizarse. No compensa todavia.

### 4. `/subir/` — 12.200 lecturas/dia

Ya no es el worker: es la pantalla mas cara que queda. Trae los 60 viajes
recientes del piloto para comprobar el cupo diario, y eso lo puede decir un
contador en su propio perfil.

### 5. Lo que se mira por encima del hombro

`avisarRachasEnPeligro` lee `usuarios` entera una vez al dia. `agregarSesiones`
y las consultas de cola van 288 veces al dia pero cuestan una o dos lecturas.
Ninguna de las dos cosas escala mal; estan aqui para que no se olviden.

## Lo que ya esta bien

- `/clasificacion/` cuesta **1** lectura, y las visitas repetidas dentro de la
  misma pestana cuestan **cero**. Era la pantalla mas cara del proyecto. Es el
  patron a copiar.
- Los conteos van con la consulta de agregacion de Firestore, que cobra **una
  lectura por cada 1.000 documentos contados**. Traerse la coleccion para hacer
  `.length` costaba una por documento.
- `/subir/` esta acotada con `limit(60)`.
- `prepararDia` corta en seco si la ruta del dia ya esta elegida, y el conteo
  por tramo sale del indice de rutas: una lectura, no la coleccion entera.
- `reunirContexto` tiene topes y es **constante**: no empeora al crecer el
  proyecto. La ventana de huellas se lee una vez por ejecucion, no una por viaje,
  y el duplicado exacto es una lectura por el id del documento.
- `/statssss/` lee dos agregados. Leia las cuatro colecciones enteras: 15.765
  lecturas por visita, un tercio de la cuota diaria de una sentada.
- `metricas.agregarSesiones` suma y borra: entre pasada y pasada solo esta lo
  que ha llegado en esos cinco minutos. Leia `sesiones_web` entera 288 veces al
  dia.
- Los agregados se reconstruyen **solo con lo que se ha movido**, y como mucho
  cada quince minutos. Un turno rotatorio de tres rutas refresca lo que la
  parcial no puede ver, como un nombre de piloto que ha cambiado.
- Las cohortes de retencion **solo se recalculan mientras pueden cambiar**.
  Pasados 30 dias el numero esta congelado y se copia del resumen anterior.
- `recalcularRuta` lee los 200 mas rapidos de la ruta, no la ruta entera: solo
  puntuan los siete primeros.
- El dominio de una estacion sale de los viajes de las rutas que la tocan, y de
  que clan es cada piloto sale de `clanes`, no de `usuarios` entera.
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
