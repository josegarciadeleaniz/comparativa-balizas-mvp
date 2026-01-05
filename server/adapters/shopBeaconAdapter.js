/**
 * Adapter TIENDA → BALIZA
 * Traduce beacon_brand (tienda) a beacon.id (motor TCO)
 * NO toca JSONs
 * NO inventa
 */

function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function findBeaconForShop(beacons, beacon_brand) {
  const target = normalize(beacon_brand);

  const match = beacons.find(b =>
    normalize(b.name).includes(target)
  );

  return match || null;
}

module.exports = { findBeaconForShop };
