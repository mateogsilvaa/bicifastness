/**
 * Los enlaces de canje que crea la administracion (`recompensas_codigos`):
 * como se inventa un codigo y a donde lleva. Lo usan /admin/recompensas/ (los
 * de evento) y /admin/nfc/ (los de pegatina). Quien decide si un codigo vale es
 * el worker (backend/src/canjes.js), no esto.
 */

// Sin 0/O/1/l/I: se copian y se escriben a mano alguna vez.
const ALFABETO = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Un codigo al azar de 20 caracteres (~99 bits): no se puede adivinar ni listar. */
export function nuevoCodigo() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (b) => ALFABETO[b % ALFABETO.length]).join('');
}

export const enlaceDe = (codigo) => `${window.location.origin}/canjear/?c=${codigo}`;
