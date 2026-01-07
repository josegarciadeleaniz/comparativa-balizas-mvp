const express = require("express");
const cors = require("cors");
const path = require("path");

const batteryData  = require("./battery_types.json");
const provincias   = require("./provincias.json");
const beacons      = require("./beacons.json");
const salesPoints  = require("./sales_points.json");

// Dejamos PDFDocument aunque no se usa, para no “cambiar contenido”
const PDFDocument  = require("pdfkit");

// Conexión MariaDB (mysql2/promise)
const mysql = require('mysql2/promise');

// Email
const nodemailer   = require("nodemailer");

// === CONEXIÓN MYSQL (solo si hay variables de entorno) ===
let pool = null;
try {
  if (process.env.DB_HOST) {
    pool = mysql.createPool({
      host:     process.env.DB_HOST,
      user:     process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      port:     parseInt(process.env.DB_PORT || '3306', 10),
      waitForConnections: true,
      connectionLimit: 5
    });
    console.log('✅ Conectado a base de datos remota');
  } else {
    console.warn('⚠️ DB desactivada (usaremos relay HTTPS)');
  }
} catch (e) {
  console.warn('⚠️ Error inicializando pool MySQL:', e.message);
  pool = null;
}
const app = express();
app.disable("x-powered-by");

const ALLOWED_ORIGINS = new Set([
  // ⚡ Nuevo dominio principal
  'https://balizas.pro',
  'https://www.balizas.pro',
  'https://widget.balizas.pro',

  // ⚡ Dominios antiguos (los dejamos por compatibilidad)
  'https://widget.comparativabalizas.es',
  'https://comparativabalizas.es',
  'https://www.comparativabalizas.es',
  'https://app.comparativabalizas.es',

  // ⚡ Render
  'https://comparativa-balizas-mvp.onrender.com'
]);
app.use((req, res, next) => {
  const origin = req.headers.origin || '';

  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});
// ===== DEBUG SWITCH =====
const DEBUG = process.env.RENDER_DEBUG === '1' || process.env.DEBUG === '1';


// === BODY PARSER ===
app.use(express.json({ limit: '20mb' }));

// ===== Logger de peticiones (solo si DEBUG) =====
if (DEBUG) {
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - started;
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
    });
    next();
  });
}

// ===== Utilidades / estado =====
app.get('/__routes', (req, res) => {
  try {
    const routes = [];
    app._router.stack.forEach((m) => {
      if (m.route) {
        const methods = Object.keys(m.route.methods).join(',').toUpperCase();
        routes.push(`${methods} ${m.route.path}`);
      } else if (m.name === 'router' && m.handle?.stack) {
        m.handle.stack.forEach(h => {
          if (h.route) {
            const methods = Object.keys(h.route.methods).join(',').toUpperCase();
            routes.push(`${methods} ${h.route.path}`);
          }
        });
      }
    });
    res.type('text/plain').send(routes.sort().join('\n'));
  } catch (e) {
    res.status(500).json({ error: 'No se pudieron listar rutas', details: String(e) });
  }
});

app.get('/__ping', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
// ===== CORS INFO (usamos una ruta no reservada por Render) =====
app.get('/api/__corsinfo', (req, res) => {
  res.json({
    ALLOWED_ORIGINS: Array.from(ALLOWED_ORIGINS),
    note: 'Whitelist real del servidor Express (no del proxy de Render)',
    debug: {
      node_version: process.version,
      port: process.env.PORT,
      env: process.env.NODE_ENV || 'development'
    }
  });
});


app.get('/__db', async (req, res) => {
  if (!pool) return res.json({ ok: false, note: 'Sin pool (DB no configurada en este entorno)' });
  try {
    const [rows] = await pool.query('SELECT 1 AS ok');
    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post('/__echo', (req, res) => {
  res.json({
    method: req.method,
    path: req.originalUrl,
    headers: req.headers,
    body: req.body
  });
});

// ===== Utilidades varias =====
function stripAccents(str) {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .normalize("NFC");
}
function normalizarTexto(texto) {
  return stripAccents(texto + "").toLowerCase().trim();
}
function normalizarBooleano(valor) {
  const v = stripAccents(String(valor)).toLowerCase().trim();
  return ["si", "yes", "true"].includes(v);
}
function canonicalBrand(s){
  const v = String(s || '').trim().toLowerCase();
  if (v === 'marca blanca') return 'Marca Blanca';
  if (v === 'sin marca' || v === 'no') return 'Sin marca';
  if (v === 'china') return 'China';
  if (v === 'generalista' || v === 'marca generalista') return 'Generalista';
  if (v === 'duracell') return 'Duracell';
  if (v === 'energizer') return 'Energizer';
  if (v === 'varta') return 'Varta';
  if (v === 'maxell') return 'Maxell';
  return s;
}

function getFundaFactor(tipoFunda) {
  const v = String(tipoFunda || '').toLowerCase().trim();
  if (v.includes('eva'))        return 1.15; // EVA Foam / silicona térmica buena
  if (v.includes('neopreno'))   return 1.10;
  if (v.includes('tela'))       return 1.01;
  return 1.00;
}


function getVidaBase(tipo, marca_pilas) {
  const tipoSimple = tipo.includes('9V') ? '9V' : (tipo.includes('AAA') ? 'AAA' : 'AA');
  const m = canonicalBrand(marca_pilas);
  return batteryData.vida_base[tipoSimple][m] || batteryData.vida_base[tipoSimple]['Sin marca'];
}

function getLifeYears(tipo, marca_pilas, provincia, desconectable, funda) {
  const { uso, shelf } = getVidaBase(tipo, marca_pilas);
  const baseYears = normalizarBooleano(desconectable) ? shelf : uso;

    // Provincia -> días calientes y factor_provincia (para estimar T_hot)
  const p = provincias.find(x => normalizarTexto(x.provincia) === normalizarTexto(provincia));
  const dias = p?.dias_anuales_30grados ?? 0; // <<< mismo nombre que en /api/calcula
  const fp   = p?.factor_provincia ?? 1;


  // Arrhenius autodescarga
  const TrefC = batteryData?.arrhenius?.TrefC ?? 21;
  const EaSD  = batteryData?.arrhenius?.Ea_kJ?.self_discharge ?? 40;
  const wHot  = (dias/365);
  const Thot  = estimateHotBinTemp(fp);
  const multHot = arrheniusMult(Thot, EaSD, TrefC);
  const multAvg = (1 - wHot) + wHot * multHot;
  const multAvgClamped = Math.min(multAvg, 5); // cap prudente

  // Vida efectiva ~ años_base / multiplicador térmico
  const factorFunda = getFundaFactor(funda);
  const vidaAjustada = (baseYears / multAvgClamped) * factorFunda;

  return +vidaAjustada.toFixed(2);
}

// ===== Arrhenius (común vida y fugas) =====
function K(c){ return c + 273.15; }
function arrheniusMult(TC, Ea_kJ, TrefC=21){
  const R = 8.314; // J/mol·K
  const Ea = Ea_kJ * 1000;
  const T  = K(TC), Tr = K(TrefC);
  return Math.exp((Ea/R)*(1/Tr - 1/T));
}
// “Hot bin” conservador en guantera según factor_provincia (de provincias.json)
function estimateHotBinTemp(factor_provincia){
  if (factor_provincia >= 1.9) return 55;
  if (factor_provincia >= 1.7) return 52.5;
  if (factor_provincia >= 1.5) return 50;
  if (factor_provincia >= 1.3) return 47.5;
  if (factor_provincia >= 1.2) return 45;
  return 42.5;
}
// Vida real por Arrhenius (autodescarga) + funda (vida)
function lifeArrheniusYears(tipo, marca_pilas, provincia, desconectable, funda, batteryData, provincias){
  // Base: uso vs shelf según desconexión
  const tipoSimple = tipo.includes('9V') ? '9V' : (tipo.includes('AAA') ? 'AAA' : 'AA');
  const m = canonicalBrand(marca_pilas);
  const base = batteryData.vida_base[tipoSimple][m] || batteryData.vida_base[tipoSimple]['Sin marca'];
  const baseYears = normalizarBooleano(desconectable) ? base.shelf : base.uso;

  // Provincia y “días >30 ºC”
  const p = provincias.find(x => normalizarTexto(x.provincia) === normalizarTexto(provincia)) || {};
  const dias   = +(p.dias_anuales_30grados ?? p.dias_calidos ?? 0);
  const fp     = +(p.factor_provincia ?? 1);
  const Thot   = estimateHotBinTemp(fp);

  // Arrhenius para AUTODESCARGA (vida)
  const TrefC  = batteryData?.arrhenius?.TrefC ?? 21;
  const EaSD   = batteryData?.arrhenius?.Ea_kJ?.self_discharge ?? 40;
  const wHot   = Math.max(0, Math.min(1, dias/365));
  const multHot= arrheniusMult(Thot, EaSD, TrefC);
  const multAvg= (1 - wHot) + wHot * multHot;        // promedio ponderado
  const multAvgClamped = Math.min(multAvg, 5);       // cap prudente para vida

  // Funda en VIDA
  const factorFunda = getFundaFactor(funda);
  const vida = (baseYears / multAvgClamped) * factorFunda;
  return +vida.toFixed(2);
}
// Riesgo anual de FUGA por Arrhenius (no incluye mitigaciones)
function leakRiskArrhenius(tipo, marca_pilas, provincia, batteryData, provincias){
  const tasaBase = getLeakRisk(tipo, marca_pilas);

  const p = provincias.find(x => normalizarTexto(x.provincia) === normalizarTexto(provincia)) || {};
  const dias   = +(p.dias_anuales_30grados ?? p.dias_calidos ?? 0);
  const fp     = +(p.factor_provincia ?? 1);
  const Thot   = estimateHotBinTemp(fp);

  const TrefC  = batteryData?.arrhenius?.TrefC ?? 21;
  const EaLeak = batteryData?.arrhenius?.Ea_kJ?.leak ?? 50;
  const wHot   = Math.max(0, Math.min(1, dias/365));
  const multHot= arrheniusMult(Thot, EaLeak, TrefC);
  const multAvg= (1 - wHot) + wHot * multHot;
  const multAvgClamped = Math.min(multAvg, 8); // cap prudente para fuga

  // Riesgo anual (SIN mitigaciones)
  return +(tasaBase * multAvgClamped * fp).toFixed(4);
}


function getBatteryPackPrice(tipo, marca_pilas, sourceData) {
  if (sourceData?.precio_por_pila) {
    const unit = sourceData.precio_por_pila.precio;
    const cantidad = sourceData.numero_pilas ||
      (tipo.includes('9V') ? 1 : (parseInt(tipo.match(/^(\d+)/)?.[1]) || (tipo.includes('AAA') ? 3 : 4)));
    return parseFloat((unit * cantidad).toFixed(2));
  }
  const precios = batteryData.precios_pilas;
  const marcaNorm = canonicalBrand(marca_pilas);
  const tipoBase  = tipo.includes('9V') ? '9V' : (tipo.includes('AAA') ? 'AAA' : 'AA');
  const cantidad  = tipo.includes('9V') ? 1 : (parseInt(tipo.match(/^(\d+)/)?.[1]) || (tipoBase === 'AAA' ? 3 : 4));
  const unit = precios[marcaNorm]?.[tipoBase]
    ?? precios['Sin marca']?.[tipoBase]
    ?? (tipoBase === 'AAA' ? 0.8 : 1.0);
  return parseFloat((unit * cantidad).toFixed(2));
}


function getTempFactor(provincia) {
  const p = provincias.find(x => normalizarTexto(x.provincia) === normalizarTexto(provincia));
  if (!p) return 1;
  const t = p.temp_extrema_guantera;
  if (t >= 60) return 0.5;
  if (t >= 57.5) return 0.525;	
  if (t >= 55) return 0.55;
  if (t >= 52.5) return 0.575;	
  if (t >= 50) return 0.6;
  if (t >= 47.5) return 0.65;	
  if (t >= 45) return 0.7;
  if (t >= 42.5) return 0.75;	
  if (t >= 40) return 0.8;
  if (t >= 37.5) return 0.85;	
  if (t >= 35) return 0.9;
  return 1;
}

function getLeakRisk(tipo, marca_pilas) {
  const map = {
    "Duracell":     0.0055,
    "Energizer":    0.0055,
    "Varta":        0.0085,
    "Maxell":       0.0095,
    "Generalista":  0.0105,
    "Marca Blanca": 0.0125,
    "Sin marca":    0.0155,
    "China":        0.0155
  };
  return map[canonicalBrand(marca_pilas)] ?? 0.0075;
}


// DEPRECATED: mantener solo si aún es invocada por código antiguo.
function getLeakFinalRisk(tipo, marca_pilas, desconectable, funda) {
  const mit = (normalizarBooleano(desconectable) ? 0.6 : 1) * (normalizarBooleano(funda) ? 0.6 : 1);
  // devuelve SOLO el multiplicador de mitigación; el riesgo anual real ya se computa fuera con Arrhenius
  return +mit.toFixed(4);
}

function getFineProb(edad) {
  const e = Math.min(parseInt(edad) || 0, 30);
  const base = 0.015, max = 0.258;
  return Math.min(base + ((max - base) * (e / 15)), max);
}
function generateTable({ pasos = {}, resumen = {} }, meta) {

  // =========================
  // BLINDAJE ABSOLUTO
  // =========================
  const N = v => Number.isFinite(Number(v)) ? Number(v) : 0;
  const TF = (v, d = 2) => {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(d).replace('.', ',') : '0,00';
  };
  const TP = (v, d = 2) => {
    const n = Number(v);
    return Number.isFinite(n) ? (n * 100).toFixed(d).replace('.', ',') : '0,00';
  };

  // =========================
  // VIDA BASE
  // =========================
  const vidaBase = typeof getVidaBase === 'function'
    ? getVidaBase(meta.tipo, meta.marca_pilas) || {}
    : {};

  const uso    = N(vidaBase.uso);
  const shelf  = N(vidaBase.shelf);
  const fuente = vidaBase.fuente || '—';

  const esDesconectable = typeof normalizarBooleano === 'function'
    ? normalizarBooleano(meta.desconectable)
    : false;

  // =========================
  // PASOS
  // =========================
  const {
    valor_desconexion = 0,
    factor_temp = 1,
    factor_funda = 1,
    vida_ajustada = 0,
    reposiciones = 0,
    precio_pack = 0,
    precio_fuente = '',
    tasa_anual = 0,
    dias_calidos = 0,
    factor_provincia = 1,
    fuente_sulfat = '',
    fuente_temp = '',
    fuente_dias = '',
    prob_fuga = 0
  } = pasos;

  // =========================
  // PILAS
  // =========================
  const numeroPilas =
    String(meta.tipo || '').includes('9V')  ? 1 :
    String(meta.tipo || '').includes('AAA') ? 4 :
    String(meta.tipo || '').includes('AA')  ? 3 : 0;

  const precioUnitario = numeroPilas > 0 ? N(precio_pack) / numeroPilas : 0;

  // =========================
  // PROVINCIAS / TEMPERATURAS
  // =========================
  const provinciaData =
    typeof provincias !== 'undefined'
      ? provincias.find(p => normalizarTexto(p.provincia) === normalizarTexto(meta.provincia)) || {}
      : {};

  const tempMax   = provinciaData.temp_max_anual ?? '—';
  const tempMin   = provinciaData.temp_min_anual ?? '—';
  const tempMedia = provinciaData.temp_media_anual ?? '—';
  const tempExt   = provinciaData.temp_extrema_guantera ?? '—';

  // =========================
  // VISUAL
  // =========================
  const beaconView =
    meta?.modelo_compra && typeof beacons !== 'undefined'
      ? beacons.find(b => String(b.id_baliza) === String(meta.modelo_compra))
      : null;

  const disp = {
    baliza: beaconView
      ? `${beaconView.marca_baliza || ''} ${beaconView.modelo || ''}`.trim()
      : `${meta.marca_baliza || ''} ${meta.modelo || ''}`.trim(),
    fabricante: beaconView?.fabricante ?? meta.fabricante ?? '—',
    origen: beaconView?.origen ?? meta.origen ?? '—',
    actuacion: beaconView?.actuacion_espana ?? meta.actuacion_espana ?? '—',
    img: meta.imagen_url?.trim()
      ? meta.imagen_url
      : (beaconView?.imagen ? `/images/${beaconView.imagen}` : '')
  };

  // =========================
  // RIESGOS
  // =========================
  const pNuevo = 0.015;
  const p15 = 0.258;
  const edadRatio = Math.min(N(meta.edad_vehiculo), 15) / 15;
  const probAveria = pNuevo + (p15 - pNuevo) * edadRatio;

  const RETARDO_MESES_DEF = 6;
  const ADHERENCIA_DEF = 0.80;

  const mesesVida = Math.max(1, N(vida_ajustada) * 12);
  const pBateriaInsuf = Math.min(
    0.5,
    (RETARDO_MESES_DEF * (1 - ADHERENCIA_DEF)) / mesesVida
  );

  const mitDesc = esDesconectable ? 0.30 : 0;
  const mitFunda =
    (meta.funda || '').toLowerCase().includes('eva') ||
    (meta.funda || '').toLowerCase().includes('silicona')
      ? 0.40
      : 0;

  const mitigacionMult = 1 - Math.min(1, mitDesc + mitFunda);
  const riesgoFinalCalc = N(prob_fuga) * mitigacionMult;
  const pNoFunciona = 1 - (1 - riesgoFinalCalc) * (1 - pBateriaInsuf);

  // =========================
  // COSTES
  // =========================
  const costeFugaAnual = N(meta.coste_inicial) * riesgoFinalCalc;
  const costeFuga12 = costeFugaAnual * 12;

  const tasaDenuncia = 0.32;
  const importeMulta = 200;
  const costeMultasAnual = importeMulta * tasaDenuncia * probAveria * pNoFunciona;
  const costeMultas12 = costeMultasAnual * 12;

  const costeMultasPorAno = Array.from({ length: 12 }, () => costeMultasAnual);

  const puntoVenta = meta.punto_venta || '';
  const textoPV = puntoVenta
    ? `el punto de venta <strong>${puntoVenta}</strong>`
    : 'el punto de venta donde compró la baliza';

  const costeFugaCubierto3 = costeFugaAnual * 3;
  const costeFugaNoCubierto9 = costeFugaAnual * 9;

  // =========================
  // HTML (TU TEXTO ÍNTEGRO)
  // =========================
  return `
<div class="selected-data-container">
  <div class="header-stripe">Datos Seleccionados</div>
  <div class="body-data">
    <div><strong>Baliza:</strong> ${disp.baliza}</div>
    <div><strong>Fabricante:</strong> ${disp.fabricante}</div>
    <div><strong>Origen:</strong> ${disp.origen}</div>
    <div><strong>Actuación en España:</strong> ${disp.actuacion}</div>
    <div><strong>Provincia donde residirá su coche:</strong> ${meta.provincia}</div>
  </div>
</div>

<h3 class="toggle-details">▼ Detalles completos de los cálculos</h3>

<table class="calculation-table">
<tr>
  <td>Vida de las Pilas (conectadas)</td>
  <td>${TF(uso)} años<br>Fuente: ${fuente}</td>
  <td><strong>${TF(uso)}</strong></td>
</tr>

<tr>
  <td>Vida útil Real de las Pilas</td>
  <td>Resultado: <strong>${TF(vida_ajustada)}</strong> años</td>
  <td><strong>${TF(vida_ajustada)}</strong></td>
</tr>

<tr>
  <td>Riesgo final de fuga anual</td>
  <td>${TP(riesgoFinalCalc)}%</td>
  <td><strong>${TP(riesgoFinalCalc)}%</strong></td>
</tr>

<tr>
  <td>Coste de Fugas (12 años)</td>
  <td>${TF(costeFuga12)} €</td>
  <td><strong>${TF(costeFuga12)} €</strong></td>
</tr>

<tr>
  <td>Coste de Multas (12 años)</td>
  <td>${TF(costeMultas12)} €</td>
  <td><strong>${TF(costeMultas12)} €</strong></td>
</tr>
</table>
`;
}


  // --- FIN BLINDAJE ---


// ====== ENDPOINT REAL: CALCULA ======
// ======================================================
// MOTOR CANÓNICO DE CÁLCULO TCO
// NO TOCAR UX / NO TOCAR generateTable
// ======================================================
function calcularPasosYResumen(meta, context) {
  const {
    batteryData,
    provincias,
    beacons,
    salesPoints
  } = context;

  // =========================
  // 1) Vida base de la pila
  // =========================
  const vidaBase = getVidaBase(meta.tipo, meta.marca_pilas);
  const uso   = vidaBase.uso;
  const shelf = vidaBase.shelf;

  const esDesconectable = normalizarBooleano(meta.desconectable);
  const valor_desconexion = esDesconectable ? shelf : uso;

  // =========================
  // 2) Vida ajustada (Arrhenius + funda)
  // =========================
  const vida_ajustada = lifeArrheniusYears(
    meta.tipo,
    meta.marca_pilas,
    meta.provincia,
    meta.desconectable,
    meta.funda,
    batteryData,
    provincias
  );

  // Factor temperatura (para UI)
  const factor_funda = getFundaFactor(meta.funda);
  const factor_temp = vida_ajustada && valor_desconexion
    ? +(vida_ajustada / (valor_desconexion * factor_funda)).toFixed(3)
    : 1;

  // =========================
  // 3) Reposiciones
  // =========================
  const reposiciones = vida_ajustada > 0
    ? +(12 / vida_ajustada).toFixed(2)
    : 0;

  // =========================
  // 4) Precio pilas
  // =========================
  const pack = getBatteryPackPrice(meta.tipo, meta.marca_pilas, batteryData);
  const precio_pack   = pack.precio;
  const precio_fuente = pack.fuente;

  const coste_pilas = +(reposiciones * precio_pack).toFixed(2);

  // =========================
  // 5) Riesgo de fuga
  // =========================
  const prov = provincias.find(
    p => normalizarTexto(p.provincia) === normalizarTexto(meta.provincia)
  ) || {};

  const dias_calidos     = prov.dias_anuales_30grados ?? 0;
  const factor_provincia = prov.factor_provincia ?? 1;

const tasa_anual = getLeakRisk(meta.tipo, meta.marca_pilas);
const fuente_sulfat = 'battery_types.json';

  const prob_fuga = +(tasa_anual * factor_temp * factor_provincia).toFixed(4);

  // Mitigación
  const mitDescPct  = esDesconectable ? 0.30 : 0.00;
  const fundaL = (meta.funda || '').toLowerCase();
  const mitFundaPct = (fundaL.includes('silicona') || fundaL.includes('eva')) ? 0.40 : 0.00;

  const mitigacionPct   = Math.min(1, mitDescPct + mitFundaPct);
  const mitigacionMult  = 1 - mitigacionPct;
  const riesgo_final    = +(prob_fuga * mitigacionMult).toFixed(4);

  // =========================
  // 6) Coste fugas
  // =========================
  const costeFugaAnual = +(meta.coste_inicial * riesgo_final).toFixed(2);
  const coste_fugas    = +(costeFugaAnual * 12).toFixed(2);

  // =========================
  // 7) Multas (12 años)
  // =========================
  const pNuevo  = 0.015;
  const p15     = 0.258;
  const edad0   = meta.edad_vehiculo || 0;

  const TASA_DENUNCIA = 0.32;
  const IMPORTE_MULTA = 200;
  const RETARDO_MESES = 6;
  const ADHERENCIA    = 0.80;

  const mesesVida = Math.max(1, vida_ajustada * 12);
  const pBateriaInsuf = Math.min(
    0.5,
    (RETARDO_MESES * (1 - ADHERENCIA)) / mesesVida
  );

  const pNoFunciona = 1 - (1 - riesgo_final) * (1 - pBateriaInsuf);

  const costesMultaPorAno = Array.from({ length: 12 }, (_, k) => {
    const edad = Math.min(edad0 + k, 15);
    const pAveria = pNuevo + (p15 - pNuevo) * (edad / 15);
    return IMPORTE_MULTA * TASA_DENUNCIA * pAveria * pNoFunciona;
  });

  const coste_multas = +costesMultaPorAno
    .reduce((a, b) => a + b, 0)
    .toFixed(2);

  // =========================
  // 8) Salida CANÓNICA
  // =========================
  const pasos = {
  // Vida y pilas
  valor_desconexion,
  factor_temp,
  factor_funda,
  vida_ajustada,
  reposiciones,
  precio_pack,
  precio_fuente,

  // Provincia / temperatura
  dias_calidos,
  factor_provincia,

  // Sulfatación
  tasa_anual,
  fuente_sulfat,
  prob_fuga,

  // 🔥 MITIGACIONES (OBLIGATORIAS PARA generateTable)
  mitigacion: mitigacionPct,
  mitigacionMult,

  // Resultado final
  riesgo_final,

  // Costes
  coste_fugas,
  coste_multas
};


  const mantenimiento_12y = +(coste_pilas + coste_fugas + coste_multas).toFixed(2);
const total_12y = +(meta.coste_inicial + mantenimiento_12y).toFixed(2);

const resumen = {
  // nombres NUEVOS
  coste_pilas,
  mantenimiento_12y,
  total_12y,

  // 🔥 NOMBRES LEGADOS que generateTable USA
  mantenimiento: mantenimiento_12y,
  total_12_anios: total_12y,
  total: total_12y
};

  return { pasos, resumen };
}

app.post('/api/calcula', async (req, res) => {
  try {
    const meta = req.body;

    const context = {
      batteryData,
      provincias,
      beacons,
      salesPoints
    };

    const { pasos, resumen } = calcularPasosYResumen(meta, context);

    console.log('>>> resumen completo:', resumen); // ✅ AQUÍ SÍ

    const html = generateTable({ pasos, resumen }, meta);

    return res.json({ html, resumen });

  } catch (err) {
    console.error('Error en /api/calcula:', err);
    return res.status(500).json({
      error: 'Error interno del servidor',
      detalle: err.message
    });
  }
});


// ===== Datos públicos (BEACONS saneado) =====
app.get('/api/beacons', (req, res) => {
  try {
    const list = Array.isArray(beacons) ? beacons : [];
    const out = list.map((b, i) => {
      const marca  = b.marca_baliza ?? b.marca ?? b.brand ?? 'Desconocida';
      const modelo = b.modelo ?? b.model ?? b.modelo_baliza ?? `Modelo ${i+1}`;
      return {
        id_baliza: b.id_baliza ?? b.id ?? (i + 1),
        marca_baliza: String(marca),
        modelo: String(modelo),
        // deja el resto de campos tal cual, por si los usas
        ...b
      };
    });
    res.set('Cache-Control','no-store');
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'beacons_sanitize_fail', details: String(e) });
  }
});
app.get('/api/sales_points', (req, res) => res.json(salesPoints));
app.get('/api/provincias',   (req, res) => res.json(provincias));
app.get('/api/battery_types',(req, res) => res.json(batteryData));

// ===== Envío de PDF mediante relay interno HTTPS (Plesk) =====
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));


// === ENVIAR PDF (relay a Plesk) ===
app.post('/api/enviar-pdf', async (req, res) => {
  try {
    const { email, title = 'Informe de baliza', pdfBase64, filename = 'Informe.pdf' } = req.body || {};
    if (!email || !pdfBase64) {
      return res.status(400).json({ ok: false, error: 'Faltan campos' });
    }

    const relayUrl = process.env.RELAY_MAIL_URL 
      || 'https://comparativabalizas.es/comparativa-balizas-mvp/api/send-mail.php';

    const r = await fetch(relayUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Relay-Token': process.env.RELAY_SECRET || ''
      },
      body: JSON.stringify({ email, title, pdfBase64, filename })
    });

	
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) {
      console.error('Relay mail fallo:', r.status, data);
      return res.status(502).json({ ok: false, error: 'relay_mail_fail' });
    }

    console.log('✅ Enviado PDF vía relay HTTPS');
    return res.json({ ok: true });

  } catch (e) {
    console.error('Error enviar-pdf:', e);
    return res.status(500).json({ ok: false, error: 'server' });
  }
});


// ===== Proxy de imágenes — versión robusta (2025-10) =====
app.get('/api/proxy-image', async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('missing url');

    console.log('[Proxy] solicitando:', targetUrl);

    // ⚙️ Forzar cabeceras de navegador para saltar bloqueos tipo Cloudflare
    const response = await fetch(targetUrl, {
      redirect: 'follow',
      headers: {
  'User-Agent': 'Mozilla/5.0 (compatible; WidgetComparativa/1.0)',
  'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  'Referer': 'https://balizas.pro/'
}
    });

    if (!response.ok) {
      console.warn('[Proxy] Error HTTP', response.status, '→', targetUrl);
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Content-Type', 'image/png');
      const placeholder = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHgAL/2cYF8wAAAABJRU5ErkJggg==',
        'base64'
      );
      return res.status(200).send(placeholder);
    }

    const contentType = response.headers.get('content-type') || 'image/png';
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.set({
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400',
      'Content-Type': contentType
    });

    res.send(buffer);

  } catch (err) {
    console.error('[Proxy] Excepción:', err.message);
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Content-Type', 'image/png');
    const placeholder = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHgAL/2cYF8wAAAABJRU5ErkJggg==',
      'base64'
    );
    res.status(200).send(placeholder);
  }
});

// === ESTÁTICOS (al final) ===
app.use(express.static(path.join(__dirname, '../client')));
app.use('/images', express.static(path.join(__dirname, '../client/images')));
app.use('/fonts',  express.static(path.join(__dirname, '../client/fonts')));

// --- 404 ---
app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// --- Manejador de errores (al final) ---
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: "JSON malformado", message: "Verifica el formato" });
  }
  console.error('Error no controlado:', err);
  res.status(500).json({ error: 'Error interno' });
});

// --- Verificar carga JSON (igual que antes) ---
try {
  if (!batteryData || !provincias || !beacons || !salesPoints) {
    throw new Error("Error cargando JSON");
  }
  console.log('Datos cargados correctamente');
} catch (e) {
  console.error('Error crítico cargando JSON:', e);
  process.exit(1);
}

// --- LISTEN: usar PORT de Render + 0.0.0.0 ---
const PORT = process.env.PORT || 10000; 
app.listen(PORT, () => console.log(`✅ Servidor escuchando en puerto ${PORT}`));

// ============================================================================
// ===== PRE-REGISTRO (en Render) =====
const crypto = require('crypto');
const pending = new Map(); // token -> { email, exp }

function signToken(payload, secret){
  // token simple firmado (sin librerías) con HMAC
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return data+'.'+sig;
}
function verifyToken(tok, secret){
  const [data,sig] = tok.split('.');
  const good = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  if (good!==sig) return null;
  try { return JSON.parse(Buffer.from(data,'base64url').toString('utf8')); }
  catch{return null;}
}

app.post('/api/pre-register', async (req,res)=>{
  try{
    const { email } = req.body || {};
    if (!email || !/.+@.+\..+/.test(email)) return res.status(400).json({ok:false,error:'email_invalido'});
    const token = crypto.randomBytes(20).toString('hex');
    const exp   = Date.now() + 1000*60*30; // 30 minutos
    pending.set(token, { email, exp });

    const base = process.env.PUBLIC_BASE || 'https://comparativabalizas.es';
    const link = `${base}/comparativa-balizas-mvp/client/verify.html?token=${token}`;
    const transporter = getTransporter();
    await transporter.sendMail({
      from: process.env.MAIL_FROM || 'no-reply@comparativabalizas.es',
      to: email,
      subject: 'Confirma tu acceso a ComparativaBalizas',
      html: `<p>Hola, confirma tu acceso haciendo clic:</p>
             <p><a href="${link}">${link}</a></p>
             <p>Caduca en 30 minutos.</p>`
    });
    res.json({ok:true});
  }catch(e){
    console.error('pre-register error',e);
    res.status(500).json({ok:false,error:'server'});
  }
});

app.get('/api/verify', (req,res)=>{
  const { token } = req.query;
  const rec = pending.get(token);
  if (!rec || rec.exp < Date.now()) return res.status(400).json({ok:false,error:'token_invalido'});
  pending.delete(token);
  const jwt = signToken({ email: rec.email, iat: Date.now() }, process.env.JWT_SECRET || 'devsecret');
  res.json({ok:true, token: jwt});
});

app.get('/api/whoami', (req,res)=>{
  const tok = req.headers.authorization?.replace(/^Bearer\s+/,'') || '';
  const payload = verifyToken(tok, process.env.JWT_SECRET || 'devsecret');
  if (!payload) return res.status(401).json({ok:false});
  res.json({ok:true, email: payload.email});
});
