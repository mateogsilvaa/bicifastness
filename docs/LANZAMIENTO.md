# Abrir la web

El sitio esta en obras. Volver a abrirlo sin plan es exactamente como se
cometieron los fallos de la v1.

**El orden importa**: cada paso depende del anterior, y los dos primeros son
condiciones para que el resto tenga sentido.

## 1. Credenciales rotadas y purgadas (#1)

- [ ] Revocada la contrasena de aplicacion de Gmail
- [ ] Borrada la API key de Gemini y creada otra (o retirada: el pipeline ya no
      la usa, el OCR corre en local)
- [ ] `/revoke` del token del bot de Telegram en @BotFather
- [ ] Apagada la instancia de PocketBase y el tunel de ngrok
- [ ] Borrada la coleccion `secrets` de Firestore
- [ ] Historial purgado con `git filter-repo`, o repositorio nuevo sin historial
- [ ] `git log -p --all` no devuelve ninguna credencial

**Esto bloquea todo lo demas.** El worker corre en GitHub Actions, que solo es
gratis e ilimitado en repositorios **publicos**, y el historial todavia contiene
la contrasena de Gmail en claro. Hacer publico el repositorio hoy es publicar
esa contrasena.

Rotar es obligatorio aunque se purgue el historial: alguien puede tener un clon
de antes.

## 2. Datos personales fuera de Firestore (#59, #60, #54)

- [ ] Reglas desplegadas: Firebase Console → Firestore → Reglas, pegando
      `firestore.rules`. **Esto no espera al CI.**
- [ ] `node scripts/migrar-datos.js --verificar` dice que ningun documento lleva
      ya `email_real`, `foto_url` ni `email`
- [ ] Migracion aplicada (`--simular` primero, siempre)
- [ ] Restaurada la lectura publica de los verificados en `firestore.rules` — la
      linea esta escrita y comentada en el propio fichero — y desplegada

**Firestore responde aunque la web este en obras.** Es un servicio aparte: el
modo mantenimiento no protege ni un dato. Lo unico que protege son las reglas.

## 3. El repositorio, publico

- [ ] Visibilidad cambiada, **solo despues del paso 1**
- [ ] Secreto `FIREBASE_SERVICE_ACCOUNT` creado
- [ ] Secreto `RESEND_API_KEY` creado, si se quieren los avisos por correo
- [ ] Variable o secreto `CORREO_ADMIN` con la direccion a la que avisar cuando
      la cuota se acerque al limite (#38). Sin ella, el aviso solo sale en el
      log del workflow, donde no lo lee nadie

## 4. El sitio se sirve (#2)

- [ ] El proyecto de Vercel apunta a `main`
- [ ] Un despliegue llega a **READY**, no a ERROR. Comprobarlo de verdad, en el
      panel: el proyecto tuvo seis despliegues seguidos en ERROR sin que nadie
      se enterara
- [ ] Las cabeceras de seguridad llegan al navegador (pestaña Red → cualquier
      documento → Cabeceras de respuesta). La CSP es la que importa
- [ ] `/assets/ocr/` se sirve: sin el motor y el modelo, la subida no puede leer
      la captura

## 5. El acceso funciona desde el dominio nuevo (#4)

- [ ] Firebase Console → Authentication → Settings → Dominios autorizados:
      anadido el dominio de Vercel
- [ ] Google Cloud Console → reCAPTCHA: anadido el dominio a la clave de sitio
- [ ] `RECAPTCHA_SITE_KEY` puesta en `assets/js/firebase.js`
- [ ] App Check en modo obligatorio para Firestore, **despues** de comprobar que
      el worker no se ve afectado: el Admin SDK no pasa por App Check
- [ ] El dominio antiguo sigue autorizado durante la transicion

Firebase Auth solo acepta peticiones desde dominios de su lista blanca. Si esto
se salta, **el login no funciona** y no hay mensaje que lo explique.

## 6. Lo legal (#55)

- [ ] Rellenados los datos del responsable — nombre, NIF, domicilio y correo de
      privacidad — en los cuatro documentos. Siguen marcados en amarillo
- [ ] `VERSION_TERMINOS` en `backend/src/config.js` y `VERSION_LEGAL` en
      `assets/js/ui.js` coinciden, y coinciden con lo que dicen los documentos

## 7. Los procesos automaticos, en seco

- [ ] `workflow_dispatch` de `verificar-viajes.yml` con `simular: true`, y la
      salida cuadra
- [ ] `workflow_dispatch` de `periodicas.yml` con `simular: true`, las dos
      operaciones. **El cierre de temporada no tiene vuelta atras**
- [ ] Reactivados los dos cron, que estan comentados a proposito

## 8. Un viaje de principio a fin

- [ ] Con una cuenta real, no con la de administracion
- [ ] Registrarse → subir una captura → esperar al worker → ver el veredicto
- [ ] El viaje llega con `distanciaMetros` y `distanciaEstimada`
- [ ] Primer administrador creado con `scripts/set-admin.js`, y esa persona ha
      cerrado sesion y ha vuelto a entrar para que su token recoja el rol
- [ ] Probado el borrado de cuenta con una cuenta de usar y tirar: es lo unico
      que no se puede probar dos veces con la misma

## 9. Abrir

- [ ] Borrado el bloque `redirects` de `vercel.json`
- [ ] Push a `main`
- [ ] Comprobado que `/`, `/subir/` y `/clasificacion/` responden

## El camino de vuelta

**Anade el bloque `redirects` a `vercel.json` y haz push.** Menos de cinco
minutos, y no hace falta tocar nada mas. El detalle esta en
[MANTENIMIENTO.md](MANTENIMIENTO.md#volver-a-modo-mantenimiento).

## Lo que hay que asumir al abrir

- **El coste no esta resuelto.** Con 50 usuarios activos la cuota diaria se
  agota en unas cinco horas. Ver [COSTE.md](COSTE.md): abrir a mucha gente antes
  de arreglar `recalcularTrasCambio` y `/territorio/` tumba la web sola.
- **Las distancias son estimadas** mientras no se genere la tabla (#6). Los
  viajes van marcados, asi que se sabe cuales.
- **La precision del OCR sobre capturas reales esta sin medir.** El banco es
  sintetico; la medicion real necesita capturas de verdad (#10, #16).

Nada de eso impide abrir a un grupo pequeno. Los tres son razones para no
anunciarlo a lo grande todavia.
