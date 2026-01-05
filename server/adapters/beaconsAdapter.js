/**
 * Adaptador FINAL de balizas para el motor TCO
 * -------------------------------------------------
 * Traduce el esquema nuevo (MariaDB / dashboard)
 * al esquema LEGACY que el TCO ya esperaba.
 *
 * NO toca fórmulas.
 * NO toca nombres internos del TCO.
 * NO toca frontend.
 */

function adaptBeacon(b) {
  return {
    // === CONTRATO LEGACY DEL TCO (NO CAMBIAR) ===
    id: Number(b.id_baliza),                               // antes b.id
    price: Number(b.precio_venta),                         // antes b.price
    name: `${b.marca_baliza} ${b.modelo}`,                  // antes b.name

    // === Flags que el TCO ya usa ===
    disconnectable: Boolean(b.desconectable),
    thermal_case: String(b.funda_termica).toLowerCase() === 'sí'
  };
}

/**
 * Normaliza la colección completa
 * Asegura array limpio y consistente
 */
function adaptBeacons(rawBeacons) {
  if (!Array.isArray(rawBeacons)) return [];
  return rawBeacons.map(adaptBeacon);
}

module.exports = { adaptBeacons };
