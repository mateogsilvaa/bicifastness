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

## Lo que ya encontro

Nada mas escribir el modelo salto una operacion que se llevaba **el 95% de todas
las lecturas del proyecto**:

`metricas.resumir` necesita `usuarios` y `tiempos_viaje` enteros — la retencion
por cohortes no sale de otro sitio — y se ejecutaba **en cada pasada del
worker**, o sea 288 veces al dia, hubiera pasado algo o no. Con los datos de hoy
eso son **402.000 lecturas diarias, ocho veces la cuota, con seis personas
usando la web y sin que ocurriera absolutamente nada**.

El sintoma habria sido la web cayendose todas las tardes sin explicacion.

Arreglado con dos cambios pequenos:

- El resumen caro va como mucho **una vez cada 6 horas**. Nadie mira la
  retencion a 30 dias esperando verla cambiar en cinco minutos. Lo que si sigue
  en cada pasada es `agregarSesiones`, que es la parte barata.
- `reconstruirAgregados` y el resumen necesitan **las mismas dos colecciones**.
  Cuando coinciden — justo cuando ha habido movimiento — ahora se cargan una
  sola vez y se comparten.

Resultado: de **423.291** lecturas al dia a **30.291**. Del 847% de la cuota al
61%.

## Donde se esta hoy

| Escenario | Activos/dia | Viajes acumulados | Lecturas/dia | % de la cuota |
|---|---:|---:|---:|---:|
| hoy | 6 | 1022 | 30.291 | 61% |
| u50 | 50 | 3000 | 282.406 | 565% **se agota** |
| u200 | 200 | 15.000 | 3.627.702 | 7255% **se agota** |
| u1000 | 1000 | 90.000 | 94.369.982 | 188740% **se agota** |

Tres cosas que hay que leer bien de esa tabla:

1. **Hoy se cabe, pero sin margen.** 61% de la cuota con seis personas. Hay
   margen para un mal dia, no para crecer.
2. **Con 50 usuarios activos la cuota se agota en cuatro horas.** La web deja de
   funcionar hasta medianoche.
3. El crecimiento no es proporcional al numero de usuarios, es **cuadratico**:
   varias operaciones leen la coleccion entera de viajes, y esa coleccion crece
   con los usuarios. Multiplicar por 4 los usuarios multiplica por 13 las
   lecturas.

La variable que mas duele no es cuanta gente hay, sino **cuantos viajes hay
acumulados**, que sube todos los dias aunque no entre nadie nuevo.

## Coste por pantalla

| Pantalla | Lecturas por carga | De donde salen |
|---|---:|---|
| `/statssss/` | 15.765 | las cuatro colecciones enteras |
| `/` | 817 | perfil + mision + config + clan + TODOS sus viajes + TODOS los viajes de su ultima ruta |
| `/territorio/` | 525 | todos los clanes + un documento por estacion |
| `/yo/` | 67 | perfil + temporadas + TODO su historial, sin paginar |
| `/subir/` | 61 | perfil + sus 60 viajes mas recientes, para el limite diario |
| `/clasificacion/` | 2 | el agregado del modo, y el de clanes si se abre esa pestana |

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

## Lo que queda por arreglar, por impacto

### 1. `recalcularTrasCambio`, en cada viaje aprobado

`backend/src/puntuacion.js`. Lee **todos los viajes verificados y todos los
usuarios**, una vez por cada viaje que se aprueba. Con 15.000 viajes acumulados
son 15.464 lecturas **por viaje**: treinta y tres aprobaciones agotan la cuota
del proyecto entero.

Es la peor de las que quedan porque no depende de que nadie mire la web: basta
con que la gente suba viajes.

Los agregados ya se reconstruyen una sola vez al final de la pasada (#36), pero
esta se quedo por viaje. `recalcularEstacion` solo necesita los viajes de las
dos estaciones implicadas, no la coleccion entera; con un indice por estacion
deja de crecer con el total. La alternativa mas simple es acumular las rutas
tocadas y recalcular una vez al final, como ya se hace con los agregados.

### 2. `/territorio/`

Lee todos los clanes y **un documento por estacion**: hasta 631. Ademas de la
cuota, son 631 documentos que un movil tiene que descargar y pintar en la calle.

Es exactamente lo que pide #27: un unico documento agregado del mapa. Los
agregados ya existen (`backend/src/agregados.js`) y esta pantalla es la unica
que se quedo sin usarlos.

### 3. La portada y `/yo/`

Las dos hacen consultas **sin `limit`**:

- La portada lee todos los viajes del piloto y despues **todos los viajes
  verificados de su ultima ruta**. Esa segunda no tiene techo: una ruta popular
  con 3.000 marcas cuesta 3.000 lecturas por visita a la portada.
- `/yo/` lee el historial entero para pintar las primeras filas.

Las dos se arreglan con paginacion, que es #37.

### 4. `/statssss/`

Lee las cuatro colecciones enteras. Se abre poco, asi que no es urgente, pero
una sola visita cuesta un tercio de la cuota diaria. Deberia leer del agregado
de metricas, que ya existe.

## Lo que ya esta bien

- `/clasificacion/` cuesta **2** lecturas. Era la pantalla mas cara del proyecto
  y ahora lee de un agregado. Es el patron a copiar.
- `/subir/` esta acotada con `limit(60)`.
- `prepararDia` corta en seco si la ruta del dia ya esta elegida: la parte cara
  ocurre una vez al dia, no 288.
- `reunirContexto` tiene topes (200, 40, 400). 640 lecturas por viaje es mucho,
  pero es **constante**: no empeora al crecer el proyecto. El tope de 400
  huellas es el que mas pesa y se puede bajar sin perder casi deteccion.
- La cache de distancias cuesta **una** lectura por viaje.
- El worker consulta la cola con `limit`, asi que una pasada en vacio cuesta
  tres lecturas, no una por documento.

## Cuentas que no se han hecho aqui

- **Escrituras.** El limite es 20.000 al dia y `reconstruirAgregados` escribe en
  lotes. Merece su propia auditoria.
- **Ancho de banda.** Traerse 15.000 documentos no solo cuesta cuota: cuesta
  megas en un movil, en la calle. Eso no lo mide este modelo y es lo que decide
  si la app se siente rapida.
- El modelo supone que ninguna pantalla cachea nada entre visitas. Cuando entre
  la persistencia local (#37), las visitas repetidas dentro de una sesion
  dejaran de contar.
