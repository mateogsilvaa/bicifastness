#!/usr/bin/env node
/**
 * Concede o retira el rol de administrador desde la linea de comandos.
 *
 * Existe para resolver el problema del huevo y la gallina: el callable
 * `gestionarAdmin` exige que quien llama ya sea administrador, asi que el primero
 * hay que crearlo desde fuera, con las credenciales de servicio del proyecto.
 *
 * Uso:
 *   export GOOGLE_APPLICATION_CREDENTIALS=/ruta/serviceAccountKey.json
 *   node scripts/set-admin.js tu@correo.com
 *   node scripts/set-admin.js tu@correo.com --quitar
 *
 * El fichero de credenciales NO debe subirse al repositorio.
 */

const admin = require('firebase-admin');

async function main() {
  const email = process.argv[2];
  const quitar = process.argv.includes('--quitar');

  if (!email || email.startsWith('--')) {
    console.error('Uso: node scripts/set-admin.js <correo> [--quitar]');
    process.exit(1);
  }

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error('Falta GOOGLE_APPLICATION_CREDENTIALS apuntando al JSON de la cuenta de servicio.');
    console.error('Se descarga en: Consola de Firebase > Configuracion del proyecto > Cuentas de servicio.');
    process.exit(1);
  }

  admin.initializeApp({ credential: admin.credential.applicationDefault() });

  const usuario = await admin.auth().getUserByEmail(email.toLowerCase());

  await admin.auth().setCustomUserClaims(usuario.uid, quitar ? {} : { admin: true });
  await admin.firestore().doc(`usuarios/${usuario.uid}`).set({ esAdmin: !quitar }, { merge: true });

  await admin.firestore().collection('auditoria_admin').add({
    adminUid: 'script:set-admin',
    accion: 'admin:cambio_rol',
    detalle: { objetivo: usuario.uid, email, conceder: !quitar },
    creado: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`${quitar ? 'Retirado' : 'Concedido'} el rol de administrador a ${email} (uid ${usuario.uid}).`);
  console.log('Importante: esa persona debe cerrar sesion y volver a entrar para que su token recoja el cambio.');
  process.exit(0);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
