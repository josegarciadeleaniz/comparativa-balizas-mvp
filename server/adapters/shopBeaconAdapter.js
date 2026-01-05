function normalize(str = '') {
  return String(str)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita acentos
    .replace(/[^a-z0-9]+/g, ' ')                      // limpia símbolos
    .trim();
}

function resolveBeaconFromShop(beacons, shopBeaconBrand) {
  const wanted = normalize(shopBeaconBrand);

  // 1) match fuerte por inclusión normalizada
  let match = beacons.find(b =>
    normalize(b.name).includes(wanted) ||
    wanted.includes(normalize(b.name))
  );

  if (match) return match;

  // 2) fallback por marca conocida
  const knownBrands = [
    { key: 'help flash', match: 'help flash' },
    { key: 'sos', match: 'sos' },
    { key: '3e', match: '3e' },
    { key: 'car lite', match: 'car lite' }
  ];

  const brand = knownBrands.find(b => wanted.includes(b.key));
  if (!brand) return null;

  return beacons.find(b =>
    normalize(b.name).includes(brand.match)
  ) || null;
}

module.exports = { resolveBeaconFromShop };
