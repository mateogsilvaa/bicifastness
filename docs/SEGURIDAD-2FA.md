# Verificación en dos pasos (2FA)

Con una app de autenticación (Google Authenticator, 1Password, Authy…), por
TOTP. La comprueba **Firebase Auth**, no la web: sin servidor, un código
comprobado en el navegador no valdría nada. Firebase lo apunta en el token
firmado y las reglas de Firestore lo leen.

| Quién | Qué |
|---|---|
| Cualquier piloto | Puede activarla en **Tú > Ajustes > Seguridad**. Desde entonces, al entrar (correo o Google) se le pide el código. |
| Administración | Cada vez que entra al panel: contraseña (o Google) + código. Una vez por pestaña y hora; pasar de una sección a otra no lo repite. |

Código: `assets/js/dos-pasos.js` (activar, entrar, puerta del panel),
`assets/js/admin-cabecera.js` (`puertaDosPasos`), reglas en `firestore.rules`
(`segundoFactorAdmin`, `config/seguridad`).

## Puesta en marcha (una vez)

1. **Identity Platform.** Consola de Firebase → Authentication → Configuración
   → *Actualizar a Firebase Authentication con Identity Platform*. Es gratis
   hasta 50.000 usuarios activos al mes (los de correo y Google), y no cambia
   nada de lo que ya funciona.
2. **Encender el TOTP** (la consola no tiene botón; va por la API):

   ```bash
   GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json node scripts/activar-dos-pasos.js
   ```

3. **Tu cuenta de admin.** Entra en `/admin/`. Te ofrecerá activarla: escanea
   el QR y escribe el código. A partir de ahí cada entrada al panel lo pide.
4. **Exigirla.** Ya con el código puesto, el panel enseña abajo el botón
   **«Exigirla siempre»**. Escribe `config/seguridad { adminMfa: true }` y desde
   ese momento **las reglas** no aceptan como admin un token sin el segundo paso
   o con uno de hace más de dos horas. Aunque te roben la contraseña o la
   sesión, no hay panel.

## Si pierdes el móvil

- **Un piloto:** desde la consola de Firebase → Authentication → el usuario →
  quitar el segundo factor. O con el Admin SDK:
  `admin.auth().updateUser(uid, { multiFactor: { enrolledFactors: null } })`.
- **Tú (admin):** lo mismo para tu usuario, y además apaga la exigencia
  borrando `config/seguridad` en la consola de Firestore. **Apagarla desde la
  web no se puede a propósito:** quien robe una sesión no puede quitarla.
  Cuando vuelvas a entrar, actívala otra vez y vuelve a exigirla.

## Antes de activarla

Nada cambia hasta el paso 2: si alguien intenta activarla, se le dice que aún
no está disponible. Y hasta el paso 4 las reglas siguen aceptando el rol solo,
así que no hay forma de quedarse fuera del panel por el camino.
