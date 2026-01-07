// FORCE DEPLOY
const express = require("express");
const cors = require("cors");
const path = require("path");

console.log('🔥 VERSION INDEX.JS:', new Date().toISOString());

console.log('✅ shopBeaconAdapter cargado');
const { findBeaconForShop } = require('./adapters/shopBeaconAdapter');

const batteryData  = require("./battery_types.json");
const provincias   = require("./provincias.json");
const rawBeacons = require('./beacons.json');
const { adaptBeacons } = require('./adapters/beaconsAdapter');

const beacons = adaptBeacons(rawBeacons);

const { adaptSalesPoints } = require('./adapters/salesPointsAdapter');
const rawSalesPoints = require('./sales_points.json');
const salesPoints = adaptSalesPoints(rawSalesPoints);

console.log('DEBUG shops disponibles:', salesPoints.slice(0,3));


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
function normalizeBatteryBrand(brand) {
  if (!brand) return 'Marca Blanca';

  const b = brand.toString().trim().toLowerCase();

  if (b.includes('blanca')) return 'Marca Blanca';
  if (b.includes('china')) return 'China';
  if (b.includes('sin')) return 'Sin marca';
  if (b.includes('varta')) return 'Varta';
  if (b.includes('duracell')) return 'Duracell';
  if (b.includes('energizer')) return 'Energizer';
  if (b.includes('maxell')) return 'Maxell';

  return 'Marca Blanca'; // fallback seguro
}

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

function generateTable({ pasos, resumen }, meta) {
  const { shelf, uso, fuente } = getVidaBase(meta.tipo, meta.marca_pilas);

  const esDesconectable = normalizarBooleano(meta.desconectable);
  const {
    valor_desconexion = 0,
    factor_temp       = 1,
    factor_funda: factorFunda = 1, 
    vida_ajustada     = 0,
    reposiciones      = 0,
    precio_pack       = 0,
    precio_fuente     = '',
    riesgo_temp       = 0,
    mitigacion        = 1,
    riesgo_final      = 0,
    coste_fugas       = 0,
    coste_multas: costeMultasPasos = 0,
    tasa_anual        = 0,
    fuente_sulfat     = '',
    dias_calidos      = 0,
    factor_provincia  = 1,
    fuente_temp       = '',
    fuente_dias       = '',
    prob_fuga         = 0
  } = pasos;

  const numeroPilas    = parseInt(meta.tipo.match(/^(\d+)/)?.[1] || '1', 10);
  const precioUnitario = precio_pack / numeroPilas;

  const provinciaData  = provincias.find(p => normalizarTexto(p.provincia) === normalizarTexto(meta.provincia)) || {};
  const tempMax        = provinciaData.temp_max_anual        ?? 'N/A';
  const tempMin        = provinciaData.temp_min_anual        ?? 'N/A';
  const tempMedia      = provinciaData.temp_media_anual      ?? 'N/A';
  const tempExt        = provinciaData.temp_extrema_guantera ?? 'N/A';

  const beaconView = meta?.modelo_compra
    ? (beacons.find(b => String(b.id_baliza) === String(meta.modelo_compra)) || null)
    : null;

  const disp = {
    baliza: beaconView
      ? `${beaconView.marca_baliza || ''} ${beaconView.modelo || ''}`.trim()
      : `${meta.marca_baliza || ''} ${meta.modelo || ''}`.trim(),
    fabricante: beaconView?.fabricante ?? meta.fabricante ?? '—',
    origen: beaconView?.origen ?? beaconView?.pais_origen ?? meta.origen ?? '—',
    actuacion: beaconView?.actuacion_espana ?? beaconView?.actuacion_en_espana ?? meta.actuacion_espana ?? '—',
    img: (meta.imagen_url && meta.imagen_url.trim())
        ? meta.imagen_url
        : (beaconView?.imagen ? `/images/${beaconView.imagen}` : '')
  };

  const pNuevo      = 0.015;
  const p15años     = 0.258;
  const edadRatio   = Math.min(meta.edad_vehiculo, 15) / 15;
  const probAveria  = pNuevo + (p15años - pNuevo) * edadRatio;

  const TASA_DENUNCIA_DEF   = 0.32;
  const IMPORTE_MULTA_DEF   = 200;
  const RETARDO_MESES_DEF   = 6;
  const ADHERENCIA_DEF      = 0.80;

  const mesesVida = Math.max(1, (vida_ajustada || 0) * 12);

  const factorDescon   = esDesconectable ? 0.3 : 1;
  const fundaTipoL     = (meta.funda || '').toLowerCase();
  const mitDescPct  = esDesconectable ? 0.30 : 0.00;
  const mitFundaPct = (fundaTipoL.includes('silicona') || fundaTipoL.includes('eva')) ? 0.40 : 0.00;
  const factorFundaMit = (fundaTipoL.includes('silicona') || fundaTipoL.includes('eva')) ? 0.4 : 1;
  const mitigacionCalc = factorDescon * factorFundaMit;
  const mitigacionPct   = Math.min(1, mitDescPct + mitFundaPct);
  const mitigacionMult  = 1 - mitigacionPct;
  const riesgoFinalCalc = +(((prob_fuga ?? 0) * mitigacionMult).toFixed(4));

  const probFuga01      = Math.max(0, Math.min(1, prob_fuga));
  const mitigacion01    = Math.max(0, Math.min(1, mitigacionCalc));
  const pFugaFinal      = riesgoFinalCalc;

  const costeFugaAnual  = +((meta.coste_inicial || 0) * riesgoFinalCalc).toFixed(2);
  const costeFuga12     = +(costeFugaAnual * 12).toFixed(2);

  const retardoMeses    = RETARDO_MESES_DEF;
  const adherencia      = ADHERENCIA_DEF;
  const fraccionRetraso = Math.max(0, Math.min(1, (retardoMeses * (1 - adherencia)) / mesesVida));
  const pBateriaInsuf   = Math.min(0.5, fraccionRetraso);
  const pNoFunciona     = 1 - (1 - pFugaFinal) * (1 - pBateriaInsuf);

  const tasaDenuncia     = TASA_DENUNCIA_DEF;
  const importeMulta     = IMPORTE_MULTA_DEF;
  const pMultaAnual      = probAveria * pNoFunciona * tasaDenuncia;
  const costeMultasAnual = +(importeMulta * pMultaAnual).toFixed(2);

  const probAveria12 = Array.from({ length: 12 }, (_, k) => {
    const edad = Math.min((meta.edad_vehiculo || 0) + k, 15);
    return pNuevo + (p15años - pNuevo) * (edad / 15);
  });
  const costeMultasPorAno = probAveria12.map(pInc => importeMulta * tasaDenuncia * pInc * pNoFunciona);
  const costeMultas12     = +costeMultasPorAno.reduce((a, b) => a + b, 0).toFixed(2);

  const pilas12UI  = Number(resumen?.coste_pilas ?? 0);
  const total12UI  = +((pilas12UI + costeFuga12 + costeMultas12)).toFixed(2);
	
  const puntoVenta            = meta.punto_venta || meta.nombre_punto_venta || meta.sales_point || meta.tienda || '';
  const sufijoPV              = puntoVenta ? ` por <strong>${puntoVenta}</strong>` : '';
  const textoPV               = puntoVenta ? `el punto de venta <strong>${puntoVenta}</strong>` : 'el punto de venta donde compró la baliza';
  const costeFugaCubierto3    = +(costeFugaAnual * 3).toFixed(2);
  const costeFugaNoCubierto9  = +(costeFugaAnual * 9).toFixed(2);


// 5) Descripción de la funda
let fundaDescription = '';
switch ((meta.funda || '').toLowerCase().trim()) {
  case 'tela':
    fundaDescription = `
      Las fundas textiles (lona, algodón, poliéster…) tienen conductividad térmica ≈0,05 W/m·K (poliéster) – 0,065 W/m·K (algodón).  
      Con 1 mm de grosor ofrecen R≈0,001 m²K/W, por lo que frente a un pico de 60 °C el interior se calienta casi sin retraso,  
      con solo 1–2 °C de atenuación.
      Fuente: Chua et al. “Thermal Conductivity of Recycled Textile Quilts” (2025), p. 7. :contentReference[oaicite:0]{index=0}
    `;
    break;

  case 'neopreno':
    fundaDescription = `
      El neopreno foam (trajes de buceo) tiene conductividad ≈0,054 W/m·K en estado no comprimido.  
      Con 3 mm de espesor (R≈0,055 m²K/W) atenúa picos ≈5 °C y alarga el calentamiento de minutos a decenas de minutos.  
     Fuente: “Wetsuit” en Wikipedia (actualizado 2025). :contentReference[oaicite:1]{index=1}
    `;
    break;

  case 'eva foam':
    fundaDescription = `
      Funda térmica Foam EVA tipo Evazote EV45CN tiene conductividad ≈0,038 W/m·K.  
      Con 3 mm (R≈0,079 m²K/W) atenúa picos 7–10 °C y retrasa el calentamiento de minutos a horas.  
      Fuente: Foamparts, ficha técnica EV45CN. :contentReference[oaicite:2]{index=2}
    `;
    break;

  default:
    fundaDescription = `
      Sin funda o tipo de funda desconocido. No hay aislamiento adicional más allá del encapsulado.
    `;
}
// ---- Datos visuales de baliza seleccionada (no pisa los campos que metió el usuario) ----
const hasModeloCompra =
  meta && meta.modelo_compra != null && meta.modelo_compra !== '';

  // Generación de tabla HTML con fugas sin duplicar variables
  return `
<div class="selected-data-container">
  <div class="header-stripe">Datos Seleccionados</div>
  <div class="body-data">
    <div><strong>Baliza:</strong> ${disp.baliza}</div>
    <div><strong>Fabricante:</strong> ${disp.fabricante}</div>
    <div><strong>Origen:</strong> ${disp.origen}</div>
    <div><strong>Actuación en España:</strong> ${disp.actuacion}</div>
    <div><strong>Provincia donde residirá su coche:</strong> ${meta.provincia}</div>
    ${disp.img ? `<div style="margin-top:6px">
      <img src="${disp.img}" alt="${disp.baliza}" style="max-width:160px;border-radius:8px">
    </div>` : ''}
  </div>
</div>
    <div class="highlights-container">
      <!-- Tus highlights aquí -->
    </div>

    <div class="average-cost">
      <!-- Tu promedio anual aquí -->
    </div>

    <div class="detailed-section">
      <h3 class="toggle-details">▼ Detalles completos de los cálculos</h3>
      <div class="details-content" style="display:none">
        <table class="calculation-table">
          <thead>
            <tr><th>Concepto</th><th>Cálculo</th><th>Resultado</th></tr>
          </thead>
          <tbody>
            <!-- 1) Vida base conectada -->
            <tr>
              <td>Vida de las Pilas (conectadas)<br><strong>"${meta.marca_pilas}"</strong>
</td>
              <td>
                Duración estimada con las pilas conectadas a la baliza:
                <strong>${uso.toFixed(2)} años</strong><br>
                Fuente: ${fuente}
              </td>
              <td><strong>${uso.toFixed(2)}</strong> años</td>
            </tr>

            <!-- Factor Desconexión -->
	    <tr style="background-color: #f9f9f9;">
  	      <td>
    		Factor Desconexión<br>
    		<strong>"${meta.tipo}"</strong>
  		</td>
  		<td>
    		<strong>${esDesconectable 
      		? 'Sí, contemplado en esta baliza' 
      		: 'No, no contemplado en esta baliza'}</strong>. Este factor mide el hecho de que, aunque la baliza esté apagada, si ésta permite que se  
    		desconecten las pilas de sus polos o que se guarden en un bolsillo de su funda,  
    		la vida de las pilas de la baliza aumenta significativamente.<br>
		Fuente: ${fuente}
  		</td>
  		<td>
    		<strong>${valor_desconexion.toFixed(2).replace('.', ',')}</strong> años<br>
  	      </td>
	     </tr>
            <!-- Factor temperatura -->
            <tr style="background-color: #f9f9f9;">
              <td>
                Factor Temperatura<br>
                <strong>${typeof tempExt === 'number' ? tempExt.toFixed(1) : tempExt}°C</strong>
              </td>
            <td>
  En ${meta.provincia} las temperaturas anuales oscilan entre
  <strong>${typeof tempMax === 'number' ? tempMax.toFixed(1) : tempMax}°C</strong> (máxima) y
  <strong>${typeof tempMin === 'number' ? tempMin.toFixed(1) : tempMin}°C</strong> (mínima),
  con media anual de
  <strong>${typeof tempMedia === 'number' ? tempMedia.toFixed(1) : tempMedia}°C</strong>.<br>
  Aplicamos un modelo de <strong>Arrhenius</strong> para ponderar los <strong>${dias_calidos}</strong> días/año de guantera caliente.
  El multiplicador térmico anual es:
  <em><strong>mult<sub>avg</sub> = (1 − d/365) × 1 + (d/365) × mult(T<sub>hot</sub>)</strong></em>,
  donde <em>mult(T)</em> crece exponencialmente con la temperatura respecto a 21&nbsp;°C.
  Esto acelera la autodescarga y el riesgo de fuga en los días calurosos.<br>
  Fuente: AEMET (series térmicas); documentación técnica de fabricantes; cinética de Arrhenius.
</td>

              <td><strong>${((1 - pasos.factor_temp) * 100).toFixed(1).replace('.', ',')}%</strong> descarga</td>
            </tr>

            <!-- Factor Funda -->
            <tr style="background-color: #f9f9f9;">
              <td>
                Factor Funda<br>
                   <strong>"${meta.funda === 'No' ? 'No lleva funda' : meta.funda}"</strong>
              </td>
              <td>
                ${fundaDescription.trim()}<strong>  Factor aplicado: ×${factorFunda.toFixed(2).replace('.', ',')}</strong>
              </td>
              <td><strong>×${factorFunda.toFixed(2).replace('.', ',')}</strong></td>
            </tr>

            <!-- Vida útil ajustada -->
            <tr>
  		<td>Vida útil Real de las Pilas</td>
  		<td>
  Vida útil estimada de las pilas en la baliza <strong>${meta.marca_baliza} ${meta.modelo}</strong>,
  considerando el tipo de pila <strong>(${meta.tipo})</strong>, su marca <strong>(${meta.marca_pilas})</strong>,
  la <strong>desconexión</strong> (${esDesconectable ? 'Sí' : 'No'}), el estrés térmico por provincia (modelo de <strong>Arrhenius</strong>)
  y el <strong>factor funda</strong> (${meta.funda}).<br>
  <li><strong>Vida Útil Ajustada = Vida base ${(esDesconectable?'(shelf)':'(uso)')} ÷ mult<sub>avg,SD</sub> × ${factorFunda.toFixed(2).replace('.', ',')}</strong></li>
  donde <em>mult<sub>avg,SD</sub></em> es el multiplicador térmico promedio para <em>autodescarga</em> (Arrhenius) con ${dias_calidos} días calientes.<br>
  Resultado: <strong>${vida_ajustada.toFixed(2).replace('.', ',')} años</strong>.
</td>

  		<td><strong>${vida_ajustada.toFixed(2).replace('.', ',')}</strong> años</td>
	     </tr>
            <!-- 6) Reposiciones (12 años) -->
            <tr>
              <td>Reposiciones<br><strong>(12 años)</strong></td>
              <td>
                Cambios de pilas previstos de la Baliza <strong>${meta.marca_baliza} ${meta.modelo} </strong> durante los próximos 12 años.<br><li><strong>Cambios Previstos durante la vida útil de la baliza = (12 años / ${pasos.vida_ajustada.toFixed(2).replace('.', ',')} años por packs de pilas)= ${pasos.reposiciones.toFixed(2).replace('.', ',')} cambios</strong></li>
              </td>
              <td><strong>${pasos.reposiciones.toFixed(2).replace('.', ',')}</strong></td>
            </tr>

            <!-- 7) Precio pilas -->
            <tr>
              <td>Precio de sus pilas <strong>${meta.marca_pilas}</strong></td>
              <td>
                Su baliza <strong>${meta.marca_baliza} ${meta.modelo}</strong> ha sido homologada en España con una pilas <strong>"${meta.tipo}"</strong> de la marca <strong>"${meta.marca_pilas}"</strong> cuyo precio unitario por pila actualmente es de <strong>${precioUnitario.toFixed(2).replace('.', ',')}€</strong>. Por tanto, cada reposición de pilas recomendada tendrá un coste de:<br><strong><li>Precio por reposición de pilas = ${precioUnitario.toFixed(2).replace('.', ',')}€ × ${numeroPilas}</strong>= ${pasos.precio_pack.toFixed(2).replace('.', ',')} €<br> Fuente: ${pasos.precio_fuente}
              </td>
              <td><strong>${pasos.precio_pack.toFixed(2).replace('.', ',')} €<strong/></td>
            </tr>

            <!-- 8) Coste total cambio pilas -->
            <tr style="background-color:#eaf4ff;">
              <td>Coste por <strong>cambio de pilas a 12 años</strong></td>
              <td>
                Teniendo en cuenta el número de reposiciones previstas <strong>(${pasos.reposiciones.toFixed(2).replace('.', ',')})</strong>, el número de pilas por reposición <strong>(${numeroPilas})</strong> y el precio por pila <strong>(${precioUnitario.toFixed(2).replace('.', ',')}€)</strong> de la marca <strong>"${meta.marca_pilas}"</strong> el coste previsto por cambio de pilas asumiendo las variables anteriormente descritas será de:<br> <li><strong>Coste total estimado en pilas durante 12 años= ${pasos.reposiciones.toFixed(2).replace('.', ',')} x ${numeroPilas} x ${precioUnitario.toFixed(2).replace('.', ',')}€= ${resumen.coste_pilas.toFixed(2).replace('.', ',')} €</strong></li>
              </td>
              <td><strong>${resumen.coste_pilas.toFixed(2).replace('.', ',')} €</strong></td>
            </tr>

	        <!-- —— NUEVA LÓGICA DE FUGAS —— -->
            <tr>
              <td>Riesgo de fuga anual</td>
              <td>
                La Probabilidad de Fuga en una Baliza depende las pilas y de la temperatura a las que la baliza se ve sometida. Estudios científicos muestran que las temperaturas en el interior de un coche pueden alcanzar 1.5-2x.<br>Si tenemos en cuenta los días al año en <strong>${meta.provincia}</strong> con temperaturas por encima de 30ºC  <strong>(${dias_calidos} días)</strong>  , la tasa de sulfatación de las pilas de la baliza  <strong>( ${meta.tipo}, de la marca " ${meta.marca_pilas}"), </strong>  el ratio de fugas anual de las pilas <strong>(${tasa_anual})</strong> y el factor provincia vinculado a las temperaturas máximas a lo largo de todo año <strong>(multiplica x ${factor_provincia} en ${meta.provincia})</strong>, el riesgo de fuga anual de su balizas es de:<br> 
                <li><strong>
			Riesgo de fuga Anual = ${tasa_anual} × mult<sub>avg</sub> × ${factor_provincia}</strong><small>, con <em>mult<sub>avg</sub> = (1 − d/365) + (d/365) × mult(T<sub>hot</sub>)</em>y <em>mult(T) = e^{(E<sub>a</sub>/R)(1/T<sub>ref</sub> − 1/T)}</em>.
</small>
</li>
                Fuentes: Battery University, Vehicle Cabin Temperature (NHTSA), Fuente Factor Provincia: CSIC. ${fuente_sulfat}; ${fuente_temp}, ${fuente_dias}, 
              </td>
              <td><strong>${(prob_fuga * 100).toFixed(2)} %</strong></td>
            </tr>

            <!-- 10) Mitigación de Riesgo -->
            <tr>
              <td>Mitigación de Riesgo de fugas</td>
                <td>El riesgo de fugas se reduce si la baliza permite <strong>desconectar los polos</strong> (${esDesconectable ? 'sí' : 'no'}) y si incluye <strong>funda térmica de silicona/EVA</strong> (${meta.funda}).<br>Reducciones aplicadas: <strong>${(mitDescPct*100).toFixed(0)}%</strong> (desconexión) y<strong>${(mitFundaPct*100).toFixed(0)}%</strong> (funda), combinadas como <strong>Factor de Mitigación = ${(mitigacionPct*100).toFixed(0)}%</strong>.<br> 
				La temperatura eleva el riesgo de forma exponencial (Arrhenius); desconexión elimina consumos parásitos y la funda atenúa picos térmicos.
  Fuentes: documentación técnica de fabricantes; literatura de cinética (Arrhenius).
  Fuentes: Energizer Technical Info / Battery University; estudios de temperatura en habitáculo (NHTSA/SAE). Fuente: Estudio MIT sobre fugas.
              </td>
              <td><strong>${(mitigacionPct*100).toFixed(0)}%</strong></td>
            </tr>

            <!-- 11) Riesgo final de fuga -->
<tr style="background-color:#fff7cc;">
  <td>Riesgo final de fuga anual. <strong><em>P<sub>fuga_final</sub><em></strong></td></td>
 <td>
    El riesgo final de fuga o sulfatación de las baterías de su baliza. <strong>${meta.marca_baliza} ${meta.modelo}</strong> es el resultado de aplicar el riesgo de fuga anual y la mitigación de dicho riesgo. Esta cifra que se presenta como porcentaje indica que de cada 100 balizas exactamente iguales con las mismas pilas (asumiendo que se realiza el número de reposiciones calculado anteriormente), este porcentaje de balizas sufrirán fugas, y por tanto, sulfatación y rotura, teniendo en cuenta el histórico de temperaturas de su provincia, y los datos reportados por fuentes solventes respecto al riesgo de fugas por marca y modelo de pilas: <br> <li><strong>Riesgo final de fuga = ${(prob_fuga*100).toFixed(2)}% × ${(mitigacionMult*100).toFixed(0)}% = <strong>${(riesgoFinalCalc*100).toFixed(2)}%</strong>%</strong></li>
  </td>
  <td><strong>${(riesgoFinalCalc*100).toFixed(2)}%</strong></td>
</tr>

<!-- 12) Coste de fugas -->
<tr>
  <td>Coste de fugas a a 12 años</td>
  <td>
    Teniendo en cuenta el coste inicial de su baliza <strong>${meta.marca_baliza} ${meta.modelo} (${meta.coste_inicial.toFixed(2).replace('.', ',')} €)</strong> 
    y el riesgo final de fuga calculado <strong>${(riesgoFinalCalc * 100).toFixed(2).replace('.', ',')}%</strong>, 
    el coste equivalente por fugas cada año será:<br>
    <li><strong>Coste de Fugas anual = ${meta.coste_inicial.toFixed(2).replace('.', ',')} € × ${(riesgoFinalCalc * 100).toFixed(2).replace('.', ',')}% = ${costeFugaAnual.toFixed(2).replace('.', ',')} € por año</strong></li><li><strong>Coste de Fugas 12 años = ${meta.coste_inicial.toFixed(2).replace('.', ',')} € × ${(riesgoFinalCalc * 100).toFixed(2).replace('.', ',')}% x 12 años = ${costeFuga12.toFixed(2).replace('.', ',')} € por 12 años</strong></li> Cobertura y postventa (estratégico en la compra): Durante los <strong>3 años</strong> de garantía legal, conserve su ticket de compra ya que está cubierto por 3 años de garantía en caso de rotura por fugas y ${textoPV} debería gestionar la <strong>sustitución o reparación</strong> si hay falta de conformidad (y, en su caso, <strong>rebaja de precio o reembolso</strong>).
    Para activar esta cobertura, es imprescindible seguir las <strong>recomendaciones del fabricante</strong> (especialmente <strong>cambio de pilas</strong> y almacenamiento).
    <em>Desglose del riesgo económico estimado:</em>
    <ul style="margin:6px 0 0 16px">
      <li>Cubierto por la garantía del Punto de venta (3 años): <strong>${costeFugaCubierto3.toFixed(2).replace('.', ',')} €</strong>${sufijoPV}</li>
      <li>No cubierto (9 años restantes): <strong>${costeFugaNoCubierto9.toFixed(2).replace('.', ',')} €</strong></li>
    </ul>
  </td>
  <td><strong>${costeFuga12.toFixed(2).replace('.', ',')} €</strong></td>
</tr>

            <!-- 13) Probabilidad de Avería -->
            <tr>
              <td>Probabilidad anual de Avería. <strong><br><em>P<sub>averia</sub><em></strong></td>
              <td>  Estimamos la probabilidad de incidencia (avería/accidente que exige señalización) con un modelo lineal por antigüedad del vehículo:<br>
  <li><strong>Probabilidad de avería = 1,5% + ((25,8% − 1,5%) × ${meta.edad_vehiculo} / 15) = ${(probAveria * 100).toFixed(1).replace('.', ',')}%</strong></li>
  La horquilla 1,5%→25,8% es una <em>calibración</em> coherente que indica una probabilidad de 1,5% en un coche nuevo y del 25,8% en un coche de más de 15 años, con la evidencia de que los vehículos más antiguos presentan más fallos técnicos y mayor siniestralidad. En este caso se referencia esta fórmula a la antigüedad de su coche actual que es de <strong>${meta.edad_vehiculo} años</strong><br>
  <strong>Implicación:</strong> este valor aproxima el riesgo anual de que necesites señalizar en vía.<br>
  <strong>Fuente: (ITV/DGT). Normativa:</strong> hasta el 31/12/2025 puedes señalizar con triángulos o V16; desde el 01/01/2026 la V16 <em>conectada</em> será obligatoria. No señalizar es infracción (hasta 200 €) </td>
              <td><strong>${(probAveria * 100).toFixed(1).replace('.', ',')}%</strong></td>
            </tr>
<!-- 13.2) Probabilidad de que la batería sea insuficiente -->
<tr>
  <td>Probabilidad de que la baliza no funcione cuando se necesita por descarga de las pilas. <strong><em>P<sub>batería_insuf.</sub><em></strong></td>
  <td>
  Calculamos la probabilidad de que al haber un incidente, una avería, control o ITV, la baliza no funcione por descarga de las pilas. Para ellos vamos a usar estas variables:<br>
  • <strong> Retardo = ${RETARDO_MESES_DEF} meses.</strong> Se estima que se produce cuando el propietario descubre en una comprobación rutinaria, que su baliza no funciona por las pilas. Este retardo suele coincidir con vacaciones  o con revisiones rutinarias en el taller o en la ITV.<br>
  • <strong>Adherencia = ${(ADHERENCIA_DEF*100).toFixed(0)}%</strong> Mide el porcentaje de población que normalmente sigue las recomendaciones del fabricante y que por tanto, no se ve afectada por el retardo<br>
  • <strong>Vida_ajustada = ${vida_ajustada.toFixed(2).replace('.', ',')} años → ${((vida_ajustada*12)|0)} meses (aprox.)</strong> Ya revisada anteriormente se calcula en función de las variables externas que afectan a la duración de las pilas de la Baliza<br>
  <em><strong>P<sub>batería_insuf.</sub> = (retardo × (1 − adherencia)) / (vida_ajustada × 12)</em> = (${RETARDO_MESES_DEF} × (1 − ${(ADHERENCIA_DEF*100).toFixed(0)}%)) / (${(vida_ajustada*12).toFixed(0)}) = ${(pBateriaInsuf*100).toFixed(2)}%</strong> 
</td>
  <td><strong>${(pBateriaInsuf*100).toFixed(2).replace('.', ',')}%</strong></td>
</tr>

            <!-- 14) Probabilidad de que la Baliza no funcione -->
            <tr style="background-color:#fff7cc;">
              <td>Probabilidad de que la baliza no funcione por fugas o sulfatación de las pilas. <strong><em>P<sub>no_funcione</sub><em></strong></td>
<td>
  <strong>Probabilidad de que la Baliza no funcione por sulfatación o descarga de las pilas</strong><br>
  La probabilidad de que la baliza <strong>${meta.marca_baliza} ${meta.modelo}</strong> no funcione se calcula a partir de la probabilidad de fuga o sulfatación de la misma y de que las pilas se hayan descargado y no se hayan repuesto.<br> <em><strong>P (no funciona) = 1 − (1 − P<sub>fuga_final</sub>) × (1 − P<sub>batería_insuf.</sub>)</em> = 1 - (1- ${(pFugaFinal*100).toFixed(2)}%) x (1- ${(pBateriaInsuf*100).toFixed(2)}%) = ${(pNoFunciona*100).toFixed(2)}%</strong> <br>
  En donde P<sub>fuga_final</sub> = <strong>${(pFugaFinal*100).toFixed(2)}%</strong> (sulfatación + mitigación) y P<sub>batería_insuf.</sub> = <strong>${(pBateriaInsuf*100).toFixed(2)}%</strong> (retraso de cambio vs. vida útil ajustada) y  <strong>${(pNoFunciona*100).toFixed(2)}%</strong> la probabilidad real de que la Baliza no funcione cuando se vaya a utilizar.
</td>
              <td><strong>${(pNoFunciona*100).toFixed(2).replace('.', ',')}%</strong></td>
            </tr>
<!-- 15.1) Coste de multas (anual) -->
<tr>
  <td>Coste de multas (anual)</td>
  <td>
    <em><strong>Coste anual = Multa estándar × P<sub>denuncia</sub> × P<sub>averia</sub> × P<sub>no_funcione</sub></em>
      = ${importeMulta} € × ${(tasaDenuncia*100).toFixed(0)}% × ${(probAveria*100).toFixed(1)}% × ${(pNoFunciona*100).toFixed(2)}%
      = ${costeMultasAnual.toFixed(2).replace('.', ',')} €</strong><br>
 Donde:
      <li><u>Multa estándar</u>: ${importeMulta} € equivale a la multa que contempla la puesta en marcha de la Obligatoriedad de llevar balizas conectadas a partir del 1 de enero de 2026.</li>
      <li><u>P<sub>denuncia</sub></u>: ${(tasaDenuncia*100).toFixed(0)}%. Se estima que este es el porcentaje de las actuaciones de los cuerpos y fuerzas de seguridad del estado que sobre incidentes en carretera que terminan en multa</li>
      <li><u>P<sub>averia/sub></u>: ${(probAveria*100).toFixed(1)}%. Es el ratio obtenido a partir de la antigüedad de un coche y que refleja el riesgo de avería en carretera</li>
      <li><u>P<sub>no_funcione</sub></u>:<li><u>P<sub>fuga_final</sub></u>: ${(pFugaFinal*100).toFixed(2)}% &nbsp;|&nbsp; <u>P<sub>batería_insuf.</sub></u>: ${(pBateriaInsuf*100).toFixed(2)}%. Son los términos que consideran el riesgo de multa a partir de la sulfatación de la baliza o de la descarga completa de sus pilas</li>
    </ul>
  </td>
  <td><strong>${costeMultasAnual.toFixed(2).replace('.', ',')} €</strong></td>
</tr>

<!-- 15.2) Coste de multas a 12 años -->
<tr>
  <tr style="background-color:#eaf4ff;">
  <td>Coste de multas (12 años)</td>
  <td>
  <em><strong>Coste 12 años = Σ [ Multa estándar × P<sub>denuncia</sub> × P<sub>incidente</sub>(año i) × P<sub>no_funciona</sub> ]</strong></em><br>

  <!-- Explicación corta de cómo se computa -->
  Para cada año <em>i = 1…12</em> calculamos el coste esperado de sanción y luego sumamos los 12 resultados.
  <strong>Valores que usamos</strong>
  <ul style="margin:6px 0 0 18px">
    <li>
      <u>Multa estándar</u> = <strong>${importeMulta} €</strong> 
      <small>(parametrizable; por defecto 200 €).</small>
    </li>
    <li>
      <u>P<sub>denuncia</sub></u> = <strong>${(tasaDenuncia*100).toFixed(0)}%</strong> 
      <small>(parametrizable; por defecto 32%).</small>
    </li>
    <li>
      <u>P<sub>averia</sub>(año i)</u> = 
      <em>1,5% + ((25,8% − 1,5%) × (edad_base + i − 1) / 15)</em>, 
      saturando en <strong>25,8%</strong> a partir de 15 años de antigüedad.<br>
      Edad base del vehículo: <strong>${meta.edad_vehiculo} años</strong> 
      <small>(a partir del año <strong>${Math.max(1, 16 - (meta.edad_vehiculo||0))}</strong> de la proyección ya se alcanza el 25,8%).</small>
    </li>
    <li>
      <u>P<sub>no_funcione</sub></u> =
      <em>1 − (1 − P<sub>fuga_final</sub>) × (1 − P<sub>batería_insuf.</sub>)</em><br>
      <strong>
        = 1 − (1 − ${(pFugaFinal*100).toFixed(2)}%) × (1 − ${(pBateriaInsuf*100).toFixed(2)}%)
        = ${(pNoFunciona*100).toFixed(2)}%
      </strong><br>
      <small>
        P<sub>fuga_final</sub>: riesgo de fuga anual tras mitigación (desconexión/funda).<br>
        P<sub>batería_insuf.</sub>: 
        <em>(retardo × (1 − adherencia)) / (vida_ajustada × 12)</em> 
        con retardo = ${RETARDO_MESES_DEF} meses, adherencia = ${(ADHERENCIA_DEF*100).toFixed(0)}%,
        vida_ajustada = ${vida_ajustada.toFixed(2)} años.
        En esta proyección se mantiene constante a lo largo de los 12 años
        (si mejoras mantenimiento, este valor bajaría).
      </small>
    </li>
  </ul>
  <strong>Desglose anual (i = 1…12)</strong><br>
  <small>Coste año i = Multa × P<sub>denuncia</sub> × P<sub>incidente</sub>(i) × P<sub>no_funciona</sub></small><br>
  ${costeMultasPorAno.map((c,i)=>`Año ${i+1}: ${c.toFixed(2).replace('.', ',')} €`).join(' · ')} = <strong>Total 12 años: ${costeMultas12.toFixed(2).replace('.', ',')} €</strong>
<br>
  <small>
    Notas: (1) Mantenemos constante P<sub>no_funciona</sub> para simplificar; la variación anual viene por 
    P<sub>incidente</sub>, que aumenta con la edad del vehículo y se “aplaca” en 25,8%. 
    (2) Puedes cambiar Multa estándar y P<sub>denuncia</sub> en configuración para reflejar tu escenario.
  </small>
</td>
  <td><strong>${costeMultas12.toFixed(2).replace('.', ',')} €</strong></td>
</tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ====== ENDPOINT REAL: CALCULA (VERSIÓN FINAL CERRADA) ======
app.post('/api/calcula', async (req, res) => {
  try {
    const {
      id_baliza,
      id_sales_point,
      marca,                 // marca de pilas (formulario A)
      tipo = '3x AA',
      desconectable = 'no',
      funda = 'no',
      provincia = 'Madrid',
      coste_inicial = 0,
      edad_vehiculo = 5,
      email = '',
      contexto = 'A'
    } = req.body;

    // ======================================================
    // VALIDACIONES BÁSICAS
    // ======================================================
    if (isNaN(parseFloat(coste_inicial)) || isNaN(parseInt(edad_vehiculo))) {
      return res.status(400).json({ error: 'Datos numéricos inválidos' });
    }

    // ======================================================
    // RESOLUCIÓN ÚNICA DE BALIZA (A / B / C)
    // ======================================================
    let beacon = null;

    if (id_baliza) {
      const idBuscado = String(id_baliza).trim();
      beacon = beacons.find(b => String(b.id_baliza).trim() === idBuscado);
    }

    if (!beacon && id_sales_point) {
      const sp = salesPoints.find(s => Number(s.id_punto) === Number(id_sales_point));
      if (sp) {
        const shopBrand = String(sp.marca_baliza || '').toLowerCase();
        beacon = beacons.find(b => {
          const bb = String(
            b.marca || b.marca_baliza || b.brand || b.fabricante || ''
          ).toLowerCase();
          return bb.includes(shopBrand);
        });
      }
    }

    // ======================================================
    // NORMALIZACIÓN DE MARCA DE PILAS
    // ======================================================
    let marca_pilas =
      marca ||
      beacon?.marca_pilas ||
      beacon?.battery_brand ||
      'Marca Blanca';

    // ======================================================
    // VIDA BASE Y VIDA AJUSTADA
    // ======================================================
    const baseData = getVidaBase(tipo, marca_pilas);
    const uso   = baseData.uso;
    const shelf = baseData.shelf;

    const valor_desconexion = normalizarBooleano(desconectable) ? shelf : uso;

    const vida_ajustada = lifeArrheniusYears(
      tipo,
      marca_pilas,
      provincia,
      desconectable,
      funda,
      batteryData,
      provincias
    );

    const factor_funda = getFundaFactor(funda);
    const factor_temp = +(
      vida_ajustada && valor_desconexion
        ? vida_ajustada / (valor_desconexion * factor_funda)
        : 1
    ).toFixed(3);

    // ======================================================
    // REPOSICIONES Y COSTE DE PILAS
    // ======================================================
    const reposiciones = Math.ceil(12 / vida_ajustada);
    const precio_pack  = getBatteryPackPrice(tipo, marca_pilas, beacon || {});
    const coste_pilas  = +(reposiciones * precio_pack).toFixed(2);

    // ======================================================
    // RIESGO DE FUGA (SULFATACIÓN)
    // ======================================================
    const prob_fuga = leakRiskArrhenius(
      tipo,
      marca_pilas,
      provincia,
      batteryData,
      provincias
    );

    const tieneDescon = normalizarBooleano(desconectable);
    const fundaLower  = String(funda || '').toLowerCase();

    const multDesc  = tieneDescon ? 0.70 : 1.00;
    const multFunda =
      fundaLower.includes('eva') || fundaLower.includes('silicona') ? 0.60 :
      fundaLower.includes('neopreno') ? 0.75 :
      fundaLower.includes('tela') ? 0.90 : 1.00;

    const mitigacionMult = +(multDesc * multFunda).toFixed(2);

    const riesgo_final = +(
      Math.max(0, Math.min(1, prob_fuga)) * mitigacionMult
    ).toFixed(4);

    const coste_fugas    = +((parseFloat(coste_inicial) || 0) * riesgo_final).toFixed(2);
    const coste_fugas_12 = +(coste_fugas * 12).toFixed(2);

    // ======================================================
    // MULTAS
    // ======================================================
    const importeMulta = 200;
    const tasaDenuncia = 0.32;

    const pIncHoy = getFineProb(edad_vehiculo);
    const coste_multas = +(importeMulta * tasaDenuncia * pIncHoy).toFixed(2);

    const probAveria12 = Array.from({ length: 12 }, (_, k) =>
      getFineProb((parseInt(edad_vehiculo) || 0) + k)
    );

    const coste_multas_12 = +probAveria12
      .map(p => importeMulta * tasaDenuncia * p)
      .reduce((a, b) => a + b, 0)
      .toFixed(2);

    // ======================================================
    // TOTALES
    // ======================================================
    const total12y = +(coste_pilas + coste_fugas_12 + coste_multas_12).toFixed(2);

    const resumen = {
      reposiciones,
      coste_pilas,
      coste_fugas,
      coste_fugas_12,
      coste_multas,
      coste_multas_12,
      total12y,
      medioAnual: +(total12y / 12).toFixed(2)
    };

    const pasos = {
      vida_base: uso,
      valor_desconexion,
      factor_temp,
      factor_funda,
      vida_ajustada,
      precio_pack,
      reposiciones,
      coste_pilas,
      prob_fuga,
      riesgo_final,
      coste_fugas,
      coste_multas,
      mitigacion: mitigacionMult
    };

    // ======================================================
    // META FINAL (BALIZA YA RESUELTA)
    // ======================================================
 const meta = {
  marca_baliza: beacon?.marca_baliza || 'Desconocida',
  modelo: beacon?.modelo || 'Desconocido',
  fabricante: beacon?.Fabricante || 'Desconocido',
  origen: beacon?.Origen || '',
  homologacion: beacon?.homologacion_dgt || '',

  tipo,
  marca_pilas: marca_pilas || beacon?.marca_pilas || 'Marca Blanca',
  tipo_pila: beacon?.tipo_pila || '',
  desconectable,
  funda: beacon?.funda_termica || funda,

  provincia,
  coste_inicial: Number(coste_inicial),
  edad_vehiculo: Number(edad_vehiculo)
};

    return res.json({
      meta,
      pasos,
      resumen,
      htmlTable: generateTable({ pasos, resumen }, meta)
    });

  } catch (err) {
    console.error('Error en /api/calcula:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
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

// ======================================================
// API TCO — CÁLCULO ÚNICO Y CENTRALIZADO (VERSIÓN FINAL)
// ======================================================
app.post('/api/tco', express.json(), (req, res) => {
  try {
    const {
      battery_type,
      battery_brand,
      disconnectable,
      thermal_case,
      province,
      car_age,
      beacon_id
    } = req.body;

    // -----------------------------
    // 1. BATERÍA (DESDE battery_types.json)
    // -----------------------------
    const priceObj = batteryData.precio_por_pila?.[battery_type]?.[battery_brand];
    const lifeObj  = batteryData.vida_base?.[battery_type]?.[battery_brand];
    const leakObj  = batteryData.factor_sulfatacion?.[battery_type]?.[battery_brand];

    if (!priceObj || !lifeObj || !leakObj) {
      return res.status(400).json({
        error: 'Tipo o marca de pila no válida',
        debug: {
          battery_type,
          battery_brand,
          available_brands: Object.keys(
            batteryData.precio_por_pila?.[battery_type] || {}
          )
        }
      });
    }

    const battery = {
      price: priceObj.precio,
      uso: lifeObj.uso,
      leak_risk: leakObj.tasa_anual
    };

    // -----------------------------
    // 2. PROVINCIA (provincias.json)
    // -----------------------------
    const provinceData = provincias.find(p => p.provincia === province);
    if (!provinceData) {
      return res.status(400).json({ error: 'Provincia no válida' });
    }

    // -----------------------------
    // 3. BALIZA (beacons.json)
    // -----------------------------
const beacon = findBeaconForShop(beacons, shop.beacon_brand);

if (!beacon) {
  console.error('❌ No se pudo mapear baliza de tienda:', {
    beacon_brand: shop.beacon_brand,
    disponibles: beacons.map(b => b.name)
  });

  return res.status(400).json({
    error: 'Baliza asociada no válida',
    beacon_brand: shop.beacon_brand
  });
}
    // -----------------------------
    // 4. VIDA ÚTIL REAL DE LA PILA
    // -----------------------------
    let batteryLife = battery.uso;
    if (disconnectable === true) batteryLife *= 1.6;
    if (thermal_case === true)   batteryLife *= 1.4;

    // -----------------------------
    // 5. FACTOR TEMPERATURA
    // -----------------------------
    const hotDays = provinceData.dias_anuales_30grados || 0;
    const tempFactor = Math.min(1, hotDays / 365);

    // -----------------------------
    // 6. COSTE PILAS (12 AÑOS)
    // -----------------------------
    const replacements = Math.ceil(12 / batteryLife);
    const batteryCost12y = replacements * battery.price;

    // -----------------------------
    // 7. RIESGO DE FUGA
    // -----------------------------
    const leakRisk = battery.leak_risk * tempFactor;
    const leakCost = beacon.price * leakRisk;

    // -----------------------------
    // 8. MULTAS
    // -----------------------------
    const fineProb = Math.min(
      0.015 + ((0.258 - 0.015) * (car_age / 15)),
      0.258
    );
    const finesCost = fineProb * 200 * 0.32;

    // -----------------------------
    // 9. TOTALES
    // -----------------------------
    const maintenanceTotal = batteryCost12y + leakCost + finesCost;
    const tcoTotal = beacon.price + maintenanceTotal;
    const annualAvg = maintenanceTotal / 12;

    // -----------------------------
    // 10. RESPUESTA
    // -----------------------------
    res.json({
      beacon: beacon.name,
      purchase_price: Number(beacon.price.toFixed(2)),
      battery_cost_12y: Number(batteryCost12y.toFixed(2)),
      leak_cost: Number(leakCost.toFixed(2)),
      fines_cost: Number(finesCost.toFixed(2)),
      maintenance_total: Number(maintenanceTotal.toFixed(2)),
      tco_total: Number(tcoTotal.toFixed(2)),
      annual_avg: Number(annualAvg.toFixed(2)),
      debug: {
        battery_life_years: Number(batteryLife.toFixed(2)),
        temp_factor: Number(tempFactor.toFixed(3)),
        replacements
      }
    });

  } catch (e) {
    console.error('❌ Error TCO:', e);
    res.status(500).json({ error: 'Error interno TCO' });
  }
});

// ======================================================
// API TCO — TIENDA (PRECIO TIENDA + MANTENIMIENTO BALIZA)
// ======================================================
app.post('/api/tco-shop', express.json(), (req, res) => {
	console.log('DEBUG [tco-shop] body:', req.body);
  try {
    const { shop_id, province, car_age } = req.body;

    if (!shop_id || !province || car_age === undefined) {
      return res.status(400).json({ error: 'Datos incompletos' });
    }

    // -----------------------------
    // 1. TIENDA
    // -----------------------------
    const shop = salesPoints.find(
      s => Number(s.shop_id) === Number(shop_id)
    );
    if (!shop) {
      return res.status(400).json({ error: 'Tienda no válida' });
    }

// -----------------------------
// 2. RESOLVER BALIZA (USANDO shopBeaconAdapter REAL)
// -----------------------------
console.log('DEBUG [tco-shop] shop.beacon_brand =', shop.beacon_brand);

const { findBeaconForShop } = require('./adapters/shopBeaconAdapter');

const beacon = findBeaconForShop(shop.beacon_brand, beacons);

console.log('DEBUG [tco-shop] beacon resuelta =', beacon);

if (!beacon) {
  return res.status(400).json({
    error: 'Baliza asociada no válida',
    debug: {
      beacon_brand_shop: shop.beacon_brand,
      available_beacons: beacons.map(b => b.name)
    }
  });
}


    // -----------------------------
    // 3. PROVINCIA
    // -----------------------------
    const provinceData = provincias.find(p => p.provincia === province);
    if (!provinceData) {
      return res.status(400).json({ error: 'Provincia no válida' });
    }

// -----------------------------
// 4. DATOS BATERÍA (JSON REAL)
// -----------------------------
const battery_type  = beacon.tipo_pila || beacon.alimentacion || '9V';
const battery_brand = beacon.marca_pilas || 'Marca Blanca';
const disconnectable = Boolean(beacon.desconectable);
const thermal_case   = false;

// === EXTRAER OBJETOS ===
const batteryVidaObj =
  batteryData.vida_base?.[battery_type]?.[battery_brand];

const batteryPrecioObj =
  batteryData.precio_por_pila?.[battery_type]?.[battery_brand];

const batteryLeakObj =
  batteryData.factor_sulfatacion?.[battery_type]?.[battery_brand];

// === VALIDACIÓN ESTRICTA ===
if (
  !batteryVidaObj ||
  typeof batteryVidaObj.uso !== 'number' ||
  !batteryPrecioObj ||
  typeof batteryPrecioObj.precio !== 'number' ||
  !batteryLeakObj ||
  typeof batteryLeakObj.tasa_anual !== 'number'
) {
  return res.status(400).json({
    error: 'Datos de pila inválidos',
    debug: {
      battery_type,
      battery_brand,
      batteryVidaObj,
      batteryPrecioObj,
      batteryLeakObj
    }
  });
}

// === NÚMEROS PLANOS (ÚNICOS QUE PASAN AL MOTOR) ===
const batteryLifeBase = batteryVidaObj.uso;
const batteryPrice    = batteryPrecioObj.precio;
const batteryLeakRate = batteryLeakObj.tasa_anual;

// -----------------------------
// 5. CÁLCULO MANTENIMIENTO
// -----------------------------
let batteryLife = batteryLifeBase;

if (disconnectable) batteryLife *= 1.6;
if (thermal_case)   batteryLife *= 1.4;

const hotDays = provinceData.dias_anuales_30grados || 0;
const tempFactor = Math.min(1, hotDays / 365);

const replacements = Math.ceil(12 / batteryLife);
const batteryCost12y = replacements * batteryPrice;

const leakRisk = batteryLeakRate * tempFactor;
const leakCost = Number(shop.shop_price) * leakRisk;

const fineProb = Math.min(
  0.015 + ((0.258 - 0.015) * (car_age / 15)),
  0.258
);
const finesCost = fineProb * 200 * 0.32;

const maintenance12y = batteryCost12y + leakCost + finesCost;
const tcoShop = Number(shop.shop_price) + maintenance12y;



    // -----------------------------
    // 6. RESPUESTA
    // -----------------------------
    res.json({
      shop: shop.shop_name,
      beacon: beacon.name,
      shop_price: Number(shop.shop_price.toFixed(2)),
      maintenance_12y: Number(maintenance12y.toFixed(2)),
      tco_shop: Number(tcoShop.toFixed(2)),
      debug: {
        battery_type,
        battery_brand,
        battery_life_years: Number(batteryLife.toFixed(2)),
        temp_factor: Number(tempFactor.toFixed(3)),
        replacements
      }
    });

  } catch (e) {
    console.error('❌ Error TCO Shop:', e);
    res.status(500).json({ error: 'Error interno TCO tienda' });
  }
});


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
    console.error("⚠️ Error cargando JSON (continuamos, pero API puede dar datos incompletos)");
  } else {
    console.log('Datos cargados correctamente');
  }
} catch (e) {
  console.error('⚠️ Error crítico cargando JSON:', e);
  // NO hacemos process.exit() → así no rompe CORS ni la API
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
