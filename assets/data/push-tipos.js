// GENERADO AUTOMATICAMENTE por scripts/build-push.js — no editar a mano.
// Fuente: backend/src/push.js
//
// Los tipos de aviso viven en el backend, que es quien decide si envia. El
// navegador solo los pinta, y tienen que ser LOS MISMOS: un interruptor para
// un tipo que el worker no conoce no apaga nada, y quien lo use pensara que si.
export const TIPOS = {"viajeResuelto":{"etiqueta":"Cuando se resuelve un trayecto","porDefecto":true},"rachaEnPeligro":{"etiqueta":"Cuando mi racha está en peligro","porDefecto":true},"recordPerdido":{"etiqueta":"Cuando alguien me quita un récord","porDefecto":true},"adelantado":{"etiqueta":"Cuando alguien me adelanta en un tramo","porDefecto":true},"recompensa":{"etiqueta":"Cuando consigo un banner o un lema","porDefecto":true},"cambioDivision":{"etiqueta":"Cuando se cierra la liga","porDefecto":true},"revisionPendiente":{"etiqueta":"Cuando hay un trayecto para revisar","porDefecto":true,"soloAdmin":true}};
