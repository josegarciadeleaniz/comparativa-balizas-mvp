/**
 * Adaptador FINAL de tiendas (sales points)
 * Traduce sales_points.json al contrato TCO
 * NO toca fórmulas
 */

function adaptSalePoint(sp) {
  return {
    shop_id: Number(sp.id_punto),
    shop_name: String(sp.nombre_punto).trim(),
    beacon_brand: String(sp.marca_baliza).trim().toLowerCase(),
    shop_price: Number(sp.precio_venta)
  };
}

function adaptSalesPoints(rawSalesPoints) {
  if (!Array.isArray(rawSalesPoints)) return [];
  return rawSalesPoints.map(adaptSalePoint);
}

module.exports = { adaptSalesPoints };
