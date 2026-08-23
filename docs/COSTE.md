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

**Resultado de las tres cosas: de 423.291 lecturas al dia a 29.397. Del 847% de
la cuota al 59%.**

## Donde se esta hoy

| Escenario | Activos/dia | Viajes acumulados | Lecturas/dia | % de la cuota |
|---|---:|---:|---:|---:|
| hoy | 6 | 1022 | 29.397 | 59% |
| u50 | 50 | 3000 | 251.306 | 503% **se agota** |
| u200 | 200 | 15.000 | 3.132.902 | 6266% **se agota** |
| u1000 | 1000 | 90.000 | 80.597.982 | 161196% **se agota** |

Tres cosas que hay que leer bien de esa tabla:

1. **Hoy se cabe, pero sin margen.** 59% de la cuota con seis personas. Hay
   margen para un mal dia, no para crecer.
2. **Con 50 usuarios activos la cuota se agota en cinco horas.** La web deja de
   funcionar hasta medianoche.
3. El crecimiento no es proporcional al numero de usuarios, es **cuadratico**:
   varias operaciones del worker leen la coleccion entera de viajes, y esa
   coleccion crece con los usuarios.

La variable que mas duele no es cuanta gente hay, sino **cuantos viajes hay
acumulados**, que sube todos los dias aunque no entre nadie nuevo.

## Coste por pantalla

| Pantalla | Lecturas por carga | De donde salen |
|---|---:|---|
| `/statssss/` | 15.765 | las cuatro colecciones enteras |
| `/territorio/` | 525 | todos los clanes + un documento por estacion |
| `/subir/` | 61 | perfil + sus 60 viajes mas recientes, para el limite diario |
| `/yo/` | 25 | perfil + temporadas + el conteo + la primera pagina del historial (20) |
| `/` | 7 | perfil + mision + config + clan + su ultimo viaje + el conteo + el agregado de la ruta |
| `/clasificacion/` | 1 | el agregado del modo; las visitas repetidas salen de la cache de sesion |

_Con 200 usuarios activos y 15.000 viajes acumulados._

## Coste por operacion del worker

| Operacion del worker | Lecturas por vez | De donde salen |
|---|---:|---|
| reconstruirAgregados (una vez por pasada CON viajes) | 15.765 | usuarios y viajes (compartidos con el resumen de metricas) + clanes + estaciones |
| recalcularTrasCambio (por viaje APROBADO) | 15.464 | recalcularRuta + TODOS los viajes verificados + TODOS los usuarios |
| metricas.resumir (una vez cada 6 h) | 15.441 | la marca del agregado + TODOS los usuarios + TODOS los viajes + 200 dias |
| prepararDia, la parte cara (UNA vez al dia) | 15.000 | TODOS los viajes verificados, para elegir la ruta del dia |
| reunirContexto (por viaje procesado) | 640 | tiempos de la ruta (tope 200) + propios (tope 40) + huellas (tope 400) |
| metricas.agregarSesiones (por pasada) | 400 | las sesiones del navegador sin agregar todavia |
| validarBasico y captura (por viaje procesado) | 62 | sus 60 viajes recientes + la captura + la distancia de la ruta |
| cola y bajas (por pasada) | 3 | las consultas de cola, recalculo pendiente y bajas |
| prepararDia (por pasada) | 2 | mision del dia + config; corta en seco si la ruta del dia ya esta elegida |
| metricas.tocaResumir (por pasada) | 1 | la marca del agregado, para saber si toca el resumen caro |

## Lo que queda, por impacto

### 1. `recalcularTrasCambio`, en cada viaje aprobado

`backend/src/puntuacion.js`. Lee **todos los viajes verificados y todos los
usuarios**, una vez por cada viaje que se aprueba. Con 15.000 viajes acumulados
son 15.464 lecturas **por viaje**: treinta y tres aprobaciones agotan la cuota
del proyecto entero.

Es la peor de las que quedan porque no depende de que nadie mire la web: basta
con que la gente suba viajes.

Los agregados ya se reconstruyen una sola vez al final de la pasada (#36), pero
esta se quedo por viaje. La salida mas simple es la misma: acumular las rutas
tocadas y recalcular una vez al final. La de fondo es que `recalcularEstacion`
solo necesita los viajes de las dos estaciones implicadas, no la coleccion
entera.

### 2. `/territorio/`

Lee todos los clanes y **un documento por estacion**: hasta 631. Ademas de la
cuota, son 631 documentos que un movil tiene que descargar y pintar en la calle.

Es exactamente lo que pide #27: un unico documento agregado del mapa. Los
agregados ya existen y esta pantalla es la unica que se quedo sin usarlos.

### 3. `/statssss/`

Lee las cuatro colecciones enteras. Se abre poco, asi que no es urgente, pero
una sola visita cuesta un tercio de la cuota diaria. Deberia leer del agregado
de metricas, que ya existe.

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
