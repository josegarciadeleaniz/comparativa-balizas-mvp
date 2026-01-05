function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')                 // elimina acentos
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')        // quita TODO lo no alfanumérico
    .trim();
}

function findBeaconForShop(beaconBrandFromShop, beacons) {
  const target = normalize(beaconBrandFromShop);

  console.log('🔍 BUSCANDO BALIZA PARA:', beaconBrandFromShop);
  console.log('🔍 TARGET NORMALIZADO:', target);

  for (const b of beacons) {
    const candidate = normalize(b.name);

    console.log('   → comparando con:', b.name, '=>', candidate);

    if (candidate.includes(target) || target.includes(candidate)) {
      console.log('✅ MATCH BALIZA:', b.name);
      return b;
    }
  }

  console.error('❌ NO MATCH BALIZA PARA:', beaconBrandFromShop);
  console.error(
    '📋 DISPONIBLES:',
    beacons.map(b => b.name)
  );

  return null;
}

module.exports = { findBeaconForShop };
