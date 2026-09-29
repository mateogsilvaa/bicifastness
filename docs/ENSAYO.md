# Ensayo general

Casi todo el juego se estrena en produccion sin haber corrido nunca con volumen.
El **cierre de temporada**, en concreto, toca a todos los usuarios y pone
contadores a cero. No puede ser la primera vez el dia 1, con gente mirando y sin
vuelta atras.

Hay dos niveles, y el primero no necesita nada.

## 1. El ensayo sin red

```bash
cd backend && node --test test/ensayo.test.js
```

Ejecuta las operaciones periodicas **de verdad** — el mismo codigo que corre en
produccion — sobre 200 usuarios, 20 clanes y 5.000 viajes repartidos en tres
meses, contra un Firestore en memoria que **cuenta lecturas y escrituras**
(`backend/test/ayuda/firestore-falso.js`).

Corre en el CI, sin credenciales y sin emulador. Lo que responde:

| Pregunta | Como |
|---|---|
| ¿Terminan? | Se ejecutan enteras sobre el volumen completo |
| ¿Archivan bien? | Comprueba usuario a usuario que se archiva lo suyo |
| ¿Destruyen algo? | Comprueba que el cierre **no** toca BiciRating, kilometros ni viajes |
| ¿Cuanto cuestan? | Imprime lecturas y escrituras de cada operacion |
| ¿Se recuperan? | Corta el proceso a mitad y comprueba el reintento |

Coste medido de las tres periodicas juntas, con ese volumen:

```
temporadas.cerrar                  ~200 lecturas   ~401 escrituras
puntuacion.reconstruirAgregados   ~5.200 lecturas ~2.000 escrituras
TOTAL                              5.649 lecturas  2.451 escrituras
                                   11% de la cuota  12% de la cuota
```

Caben de sobra en un dia. Contrastar con [COSTE.md](COSTE.md), que mide el otro
lado: lo que cuesta el dia a dia, no las periodicas.

### Lo que este ensayo ya deja atado

- **Cerrar dos veces no archiva ceros encima de lo bueno.** El cierre pone la
  marca ANTES de archivar. Si el proceso muere a mitad, el reintento no vuelve a
  archivar: se pierde parte del reseteo — que arregla solo el worker al
  recalcular — pero no se destruye el archivo. Un reintento que archivara sobre
  el estado ya reseteado guardaria ceros encima del mes real.
- **`--simular` no escribe absolutamente nada.** Comprobado contando
  escrituras, no leyendo el codigo.
- **Los lotes no pasan de 500 operaciones.** Con 200 usuarios y dos operaciones
  cada uno son 400 justos: el margen es de un usuario mas por lote.
- **Ningun agregado publica un campo que no salga en pantalla.** Ni uid ni
  correo ni clanId (#60).
- **Ninguna pagina de un agregado se pasa de 1 MiB**, que es el tope duro de un
  documento.
- **El decaimiento va por diferencia de fechas, no por ejecuciones.** Ejecutarlo
  dos veces el mismo dia no descuenta dos veces. Importa porque GitHub retrasa
  los cron programados: un decaimiento que dependiera de cuantas veces corre
  dejaria el mapa a cero el dia que el workflow se dispare cuatro veces.
- **Un viaje incompleto no tumba la reconstruccion.** Pasa con datos de la v1 a
  medio migrar.

### El generador

`scripts/lib/generador.js`. Es **determinista**: un generador con
`Math.random()` da un ensayo distinto cada vez, y entonces cuando algo falla no
se puede repetir y cuando pasa no se sabe si es que esta bien o es que hoy
tocaron datos faciles. Con semilla, un fallo se reproduce pasando el mismo
numero.

Los repartos **no son uniformes**, y ese es el punto:

- Un quinto de la gente hace la mitad de los viajes, y hay una cola larga de
  cuentas que subieron dos veces y lo dejaron.
- Doce rutas concentran mas de la mitad de los viajes: la gente repite trayecto.
- Un 12% de los viajes no llego a aprobarse.
- Un tercio de la gente no tiene clan.

Con todo el mundo igual, el cierre de temporada y las divisiones se comportan de
una forma que no es la real.

## 2. El ensayo con Firestore de verdad

Para lo que el anterior no puede responder: como se comporta Firestore con este
volumen, si los indices declarados bastan, y si las pantallas tiran en un movil.

```bash
# emulador
firebase emulators:start --only firestore
FIRESTORE_EMULATOR_HOST=localhost:8080 node scripts/generar-datos.js --aplicar

# o un proyecto aparte
export GOOGLE_APPLICATION_CREDENTIALS=/ruta/serviceAccountKey-PRUEBAS.json
node scripts/generar-datos.js --aplicar --proyecto bicifastness-pruebas
```

**Nunca contra produccion.** El script se niega si el proyecto no lleva
"pruebas", "test", "dev" o "staging" en el nombre: sembrar 200 usuarios de
mentira encima de los de verdad no se deshace, habria que separarlos uno a uno.

Despues, y en este orden:

1. `node backend/periodicas.js divisiones --simular`
2. `node backend/periodicas.js temporada --simular`
3. Los dos con `--aplicar`, comparando la salida con la de la simulacion
4. Abrir las pantallas en un movil de verdad: `/clasificacion/`, `/territorio/`
   y `/yo/` con 5.000 viajes detras
5. Contrastar las lecturas de la consola de Firebase con [COSTE.md](COSTE.md)

## Lo que sigue sin ensayarse

- **Las pantallas con volumen.** Necesita el paso 2 y un movil. El modelo de
  COSTE.md dice cuantas lecturas, no si la pagina va a tirones.
- **Gemini caido y cuota agotada.** El ensayo sin red cubre que el worker muera
  a mitad, pero no un servicio externo devolviendo errores raros.
- **El worker entero de punta a punta.** Lo cubre el banco de capturas
  (`backend/test/banco.test.js`), que es otro ensayo con otro objetivo.
