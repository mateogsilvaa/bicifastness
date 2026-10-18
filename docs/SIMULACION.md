# Una semana de bicifastness, simulada

`scripts/simular-semana.js` simula la semana del lanzamiento piloto a piloto:
quién se da de alta cada día, quién sale con la bici, cuántos viajes sube, qué
le pasa a cada viaje y cuánta cuota de Firestore se come el día. Lo hace tres
veces con **las mismas personas haciendo lo mismo** (cada suceso tiene su propio
número al azar, fijo para ese piloto y ese día):

- **Antes**: el código como estaba.
- **Después**: con los arreglos de esta tanda.
- **Después + Blaze**: además, el plan de pago por uso de Firebase, sin tope
  diario.

La diferencia entre columnas es lo que vale cada cosa.

```bash
node scripts/simular-semana.js                 # 500 altas
node scripts/simular-semana.js --altas 1000    # una semana más fuerte
node scripts/simular-semana.js --semilla 7     # otra semana posible
node scripts/simular-semana.js --escribir      # rehace las tablas de abajo
```

## Qué sale del código y qué es una suposición

**Del código**, sin inventar nada: lo que cuesta en lecturas cada pantalla y cada
operación del worker (el mismo modelo que [COSTE.md](COSTE.md)), la cuota del
plan gratuito (50.000 lecturas al día), que se reinicia a las 09:00 de Madrid,
el cupo de viajes, cómo trabaja el worker y cómo se cierran las rachas.

**Suposiciones**, todas juntas en `SUPUESTOS` al principio del script y cada una
con su porqué: la mezcla de pilotos (un 25 % diarios, un 45 % ocasionales, un
30 % curiosos), cuántos viajes se aprueban (80 %), van a revisión (13 %) o se
rechazan (7 %), cada cuánto se revisa a mano y, sobre todo, **cuánta gente se va
por cada cosa que le sale mal**. Son estimaciones razonables, no medidas. El
lanzamiento las medirá; mientras, conviene cambiarlas y volver a correr para ver
cuánto depende cada conclusión de ellas.

## Lo que se rompe, por orden de lo que cuesta

### 1. La cuota se agota por la tarde y la web se cae hasta las 9 de la mañana

Es, con diferencia, lo que más pilotos cuesta. Con 500 altas en la semana, la
cuota gratuita se agotaba **cuatro días de siete, entre las 18:00 y las 21:00**:
justo cuando los diarios vuelven del trabajo y suben su viaje. Esas tardes no
se podía subir nada hasta la mañana siguiente. Perdíamos unos **56 pilotos** y
cientos de viajes.

Arreglado en esta tanda, reduciendo lo que se lee (detalle en [COSTE.md](COSTE.md)):

| Operación | Antes, con 200 activos/día | Ahora |
|---|---:|---:|
| Dominio de las estaciones | 24.728 lecturas | 2.904 |
| Contexto antifraude de cada viaje | 11.040 | 1.680 |
| Podio de la ruta | 9.920 | 1.360 |
| **Total del día** | **86.539 (173 % de la cuota)** | **≈46.800 (94 %)** |

Con 500 altas la cuota ya no se agota ninguna tarde: solo roza el límite el viernes a las 22:00, cuando ya casi no sube nadie, y no se pierde ningún viaje. **Pasada la semana, o con un
lanzamiento más fuerte, no hay arreglo de código que baste**: con 1.000 altas
la web se sigue cayendo cada tarde, porque solo las pantallas que abre la gente
ya superan la cuota. La solución es el **plan Blaze con alerta de presupuesto**
(paso 11 de [PUESTA-EN-MARCHA.md](PUESTA-EN-MARCHA.md)). Con lo que se lee
ahora, 1.000 pilotos al día son unos 380.000 lecturas: **unos 7 € al mes**. En
la simulación, Blaze es la diferencia entre 678 y 829 pilotos que siguen al
acabar la semana.

### 2. El territorio no decaía y leía todo el historial

Esto no echa a nadie en la primera semana, pero rompía una regla del juego.
Cada vez que se recalculaba una estación, se volvían a sumar **todos** los
viajes de sus rutas, desde el primero. Así que el decaimiento no servía de
nada: un clan que dejó de pedalear hace meses seguía sumando cada vez que otro
pasaba por allí ([JUEGO.md](JUEGO.md): «mantener el territorio exige pedalear
esta semana, no la de hace tres meses»). Además, era lo que más leía del
proyecto.

Arreglado: cada viaje aprobado suma **una vez**, el día que se aprueba, y luego
decae (`puntuacion.cargarViajesNuevos`). Hay una prueba de que un clan parado
pierde la estación frente al que sigue pedaleando.

### 3. El primer viaje rechazado

Un rechazo en el primer intento es donde más gente nueva se va: la simulación
supone que el 40 %. Una parte de esos rechazos no son trampas, sino señales
blandas que se suman en alguien sin historial con el que compararse (un
recorte raro, una hora inusual, un ritmo alto).

Arreglado: **el primer trayecto de alguien no se rechaza solo por señales
sumadas; va a revisión humana** (`verificacion.evaluar`, `primerViaje`). Lo
decisivo (velocidad imposible, captura repetida o manipulada) se sigue
rechazando igual. Con 1.000 altas, las bajas por esto pasan de 17 a 11.

### 4. Perder la racha por culpa nuestra

Pasaba esto: un diario sube su viaje por la tarde, el viaje va a revisión y,
antes de que nadie lo mire, el cierre de rachas de la noche cuenta el día como
perdido. Se gastaba un escudo o se rompía la racha, y al aprobarse el viaje
después no había vuelta atrás. Le pasaba justo a quien más usa la web.

Arreglado: el cierre nocturno **no juzga a quien tiene un viaje sin decidir**
posterior a su último día activo (`worker.diasEnEspera`). Si se aprueba, la
racha sigue; si se rechaza, la noche siguiente se cuenta como siempre. En la
primera semana pesa poco (hace falta llevar tres días de racha), pero crece
cada semana.

### 5. Pedir entrar en un clan y que nadie conteste

Con líderes que no miran las solicitudes, quien pide entrar se queda esperando.
Arreglado: **cada clan elige su entrada** (16e, «Entrada»):

- **Pidiendo permiso**: como hasta ahora.
- **Libre**: quien no tiene clan entra sin esperar.
- **Solo con invitación**: no se puede pedir, solo entrar con el enlace del
  líder.

Las reglas lo controlan: en un clan libre solo te puedes apuntar a ti mismo,
sin tocar nada más, y únicamente si no tienes clan; en uno de invitación no se
puede pedir.

### Lo que queda, y que no es de código

- **La revisión humana el fin de semana.** Con el primer viaje indulgente, más
  primeros viajes pasan por revisión, y si nadie revisa el sábado esperan hasta
  el lunes. La primera semana conviene revisar tres veces al día, también el
  fin de semana.
- **El relevo del worker en GitHub Actions.** Algún día se rompe y los viajes
  esperan horas al cron. Sacarlo a Cloud Run + Cloud Scheduler
  ([MANTENIMIENTO.md](MANTENIMIENTO.md)) cuesta céntimos y quita el problema de
  raíz.
- **La precisión del OCR sobre capturas reales** sigue sin medir
  ([LANZAMIENTO.md](LANZAMIENTO.md)): es la suposición de la que más depende el
  número de rechazos.
- **Reconstruir los agregados por ruta** relee los viajes de cada ruta movida.
  A partir de unos 500 pilotos al día es lo que más lee, y lo siguiente que
  habría que volver incremental.

## Resultado

<!-- simulacion:inicio -->
Semana simulada con 500 altas (semilla 2026).

**Antes de los arreglos**

| Día | Altas | Activos | Viajes | Lecturas (cuota) | Web caída | Viajes perdidos | Relevo del worker |
|---|---:|---:|---:|---:|---|---:|---|
| lun | 160 | 160 | 116 | 29.436 (59%) | — | — | bien |
| mar | 90 | 162 | 186 | 58.493 (117%) | a las 20:00 hasta las 9:00 | 64 | bien |
| mié | 65 | 153 | 184 | 56.166 (112%) | a las 21:00 hasta las 9:00 | 31 | bien |
| jue | 55 | 164 | 210 | 64.684 (129%) | a las 19:00 hasta las 9:00 | 115 | bien |
| vie | 50 | 176 | 213 | 67.026 (134%) | a las 19:00 hasta las 9:00 | 105 | bien |
| sáb | 45 | 128 | 100 | 45.235 (90%) | — | — | bien |
| dom | 35 | 130 | 107 | 47.540 (95%) | — | — | bien |

**Después de los arreglos**

| Día | Altas | Activos | Viajes | Lecturas (cuota) | Web caída | Viajes perdidos | Relevo del worker |
|---|---:|---:|---:|---:|---|---:|---|
| lun | 160 | 160 | 116 | 24.341 (49%) | — | — | bien |
| mar | 90 | 162 | 186 | 39.390 (79%) | — | — | bien |
| mié | 65 | 163 | 204 | 41.744 (83%) | — | — | bien |
| jue | 55 | 181 | 243 | 48.057 (96%) | — | — | bien |
| vie | 50 | 205 | 269 | 52.227 (104%) | a las 22:00 hasta las 9:00 | — | bien |
| sáb | 45 | 150 | 122 | 38.870 (78%) | — | — | bien |
| dom | 35 | 144 | 121 | 39.086 (78%) | — | — | bien |

| Por qué se van | Antes | Después | Después + Blaze |
|---|---:|---:|---:|
| Natural (se le olvida, no le engancha) | 61 | 64 | 64 |
| La web caída por la cuota (no pudo subir) | 56 | 0 | 0 |
| Primer viaje rechazado | 9 | 6 | 6 |
| Primera captura no válida | 3 | 3 | 3 |
| Pidió clan y nadie respondió en 48 h | 2 | 2 | 2 |
| Primer viaje más de 12 h en revisión | 0 | 2 | 2 |
| Primer viaje: más de 1 h sin saber nada | 0 | 1 | 1 |
| **Siguen al acabar la semana** | **369 de 500** | **422 de 500** | **422 de 500** |
<!-- simulacion:fin -->
