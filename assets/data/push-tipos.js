// GENERADO AUTOMATICAMENTE por scripts/build-push.js — no editar a mano.
// Fuente: backend/src/push.js
//
// Los tipos de aviso viven en el backend, que es quien decide si envia. El
// navegador solo los pinta, y tienen que ser LOS MISMOS: un interruptor para
// un tipo que el worker no conoce no apaga nada, y quien lo use pensara que si.
export const TIPOS = {"viajeResuelto":{"etiqueta":"Cuando se resuelve un trayecto","porDefecto":true},"rachaEnPeligro":{"etiqueta":"Cuando mi racha esta en peligro","porDefecto":true},"cambioDivision":{"etiqueta":"Cuando cambio de division","porDefecto":false}};
