#!/usr/bin/env node
/**
 * Activa la verificacion en dos pasos con app de autenticacion (TOTP) en el
 * proyecto de Firebase. Se hace UNA vez. La consola no tiene boton para el
 * TOTP: solo se enciende por la API, que es lo que hace esto.
 *
 * Antes, en la consola: Authentication > Configuracion > "Actualizar a
 * Identity Platform" (docs/SEGURIDAD-2FA.md). Sin eso, esto falla.
 *
 * Uso:
 *   export GOOGLE_APPLICATION_CREDENTIALS=/ruta/serviceAccountKey.json
 *   node scripts/activar-dos-pasos.js
 *   node scripts/activar-dos-pasos.js --apagar
 */

const admin = require('./lib/firebase-admin');

async function main() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error('Falta GOOGLE_APPLICATION_CREDENTIALS apuntando al JSON de la cuenta de servicio.');
    process.exit(1);
  }
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const apagar = process.argv.includes('--apagar');
  await admin.auth().projectConfigManager().updateProjectConfig({
    multiFactorConfig: {
      providerConfigs: [{
        state: apagar ? 'DISABLED' : 'ENABLED',
        // Cuantos codigos de antes y de despues se aceptan: 5 son ±2,5 min de
        // reloj desajustado entre el movil y Google.
        totpProviderConfig: { adjacentIntervals: 5 },
      }],
    },
  });
  console.log(apagar ? 'Dos pasos (TOTP) apagado.' : 'Dos pasos (TOTP) activado. Ya se puede activar desde Tú > Ajustes > Seguridad.');
}

main().catch((error) => {
  console.error('No se ha podido cambiar:', error.message);
  console.error('¿Esta el proyecto actualizado a Identity Platform? Ver docs/SEGURIDAD-2FA.md');
  process.exit(1);
});
