const express = require("express");
const cors = require("cors");
const path = require("path");

const batteryData = require("./battery_types.json");
const provincias = require("./provincias.json");
const beacons = require("./beacons.json");
const salesPoints = require("./sales_points.json");

// Dejamos PDFDocument aunque no se usa, para no "cambiar contenido"
const PDFDocument = require("pdfkit");

// Conexión MariaDB (mysql2/promise)
const mysql = require('mysql2/promise');

// Email
const nodemailer = require("nodemailer");

// === CONEXIÓN MYSQL (solo si hay variables de entorno) ===
let pool = null;
try {
  if (process.env.DB_HOST) {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      port: parseInt(process.env.DB_PORT || '3306', 10),
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
]);

// CORS dinámico
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl/server-to-server
    if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);

    // También permitimos override por variable
    if (process.env.ALLOWED_ORIGIN && origin === process.env.ALLOWED_ORIGIN) return cb(null, true);

    return cb(null, false);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Helpers
function stripAccents(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}
function normalizarTexto(s) {
  return stripAccents(String(s || "")).toLowerCase().trim();
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
  if (v === 'generalista' || v === 'genérica' || v === 'generica') return 'Generalista';
  // Title-case simple
  return String(s || 'Sin marca').trim();
}
function canonicalBatteryType(s){
  const v = String(s || '').trim().toUpperCase();
  // Normalizaciones habituales
  if (v === 'AA') return '3x AA';
  if (v === 'AAA') return '3x AAA';
  if (v === '9V' || v === '9 V') return '9V';
  return String(s || '3x AA').trim();
}

// --- Arrhenius helpers (vida útil) ---
function getProvinciaData(nombre, provinciasArr) {
  const key = normalizarTexto(nombre);
  return provinciasArr.find(p => normalizarTexto(p.provincia) === key) || {};
}

// Devuelve un multiplicador anual aproximado por temperatura / días calientes.
// (Este archivo original ya lo hacía así; no reinvento).
function multAvgProvince(pData) {
  const dias = Number(pData.dias_anuales_30grados || 0);
  // clamp simple para que no explote
  const d = Math.max(0, Math.min(365, dias));
  // factor muy conservador: si hay 0 días calientes => 1.0 ; si hay 60 días => ~1.15 ; 120 => ~1.3 etc.
  return 1 + (d / 365) * 0.75;
}

// Vida útil real en años (Arrhenius + desconexión + funda)
// NOTA: mantiene el comportamiento original.
function lifeArrheniusYears(tipo, marca_pilas, provincia, desconectable, funda, batteryDataObj, provinciasArr) {
  const t = canonicalBatteryType(tipo);
  const b = canonicalBrand(marca_pilas);

  const baseData = batteryDataObj[t]?.[b] || batteryDataObj[t]?.['Sin marca'] || null;
  if (!baseData || !baseData.uso || !baseData.shelf) return NaN;

  const uso = Number(baseData.uso);
  const shelf = Number(baseData.shelf);

  const pData = getProvinciaData(provincia, provinciasArr);
  const mult = multAvgProvince(pData); // >1 acelera descarga => reduce vida

  const allowsDisconnect = normalizarBooleano(desconectable);
  const hasCase = normalizarBooleano(funda);

  // base según desconexión
  const baseYears = allowsDisconnect ? shelf : uso;

  // funda (mitiga): en tu modelo usas 0.6 para desconexión en backend nuevo;
  // aquí conservamos lógica antigua: funda mejora vida un 10% (no tocamos textos/tabla: solo vida usada en cálculos).
  const caseFactor = hasCase ? 1.10 : 1.0;

  // temperatura reduce vida
  const years = (baseYears / mult) * caseFactor;

  // clamp razonable
  return Math.max(0.25, Math.min(12, years));
}

// Precio pack pilas (por reposición)
function getBatteryPackPrice(tipo, marca_pilas, sourceData) {
  const t = canonicalBatteryType(tipo);
  const b = canonicalBrand(marca_pilas);

  // Si el fabricante/punto de venta define precio por pila, lo respetamos
  if (sourceData && sourceData.precio_por_pila && sourceData.precio_por_pila.precio != null) {
    const per = Number(sourceData.precio_por_pila.precio);
    const count = Number(batteryData[t]?.count || 0);
    if (count && per) return Number((count * per).toFixed(2));
  }

  // Si no, usamos battery_types.json
  const baseData = batteryData[t]?.[b] || batteryData[t]?.['Sin marca'] || null;
  if (!baseData || baseData.precio == null) return NaN;

  const precioPorPila = Number(baseData.precio);
  const count = Number(batteryData[t]?.count || 0);
  return Number((count * precioPorPila).toFixed(2));
}

// Riesgo fuga por tipo/marca: fallback (antiguo)
function getLeakRisk(tipo, marca_pilas) {
  const t = canonicalBatteryType(tipo);
  const b = canonicalBrand(marca_pilas);
  const baseData = batteryData[t]?.[b] || batteryData[t]?.['Sin marca'] || null;
  if (!baseData || baseData.tasa_anual == null) return 0.02; // fallback
  return Number(baseData.tasa_anual);
}

// Riesgo con Arrhenius (antiguo, conservador)
function leakRiskArrhenius(tipo, marca_pilas, provincia, batteryDataObj, provinciasArr) {
  const t = canonicalBatteryType(tipo);
  const b = canonicalBrand(marca_pilas);
  const baseData = batteryDataObj[t]?.[b] || batteryDataObj[t]?.['Sin marca'] || null;
  const tasa = baseData?.tasa_anual != null ? Number(baseData.tasa_anual) : 0.02;

  const pData = getProvinciaData(provincia, provinciasArr);
  const factorProv = Number(pData.factor_provincia || 1);

  // Ajuste moderado por provincia
  return Math.max(0, Math.min(0.95, tasa * factorProv));
}

// Mitigación por funda/desconexión (antiguo)
function mitigacion(desconectable, funda) {
  const d = normalizarBooleano(desconectable);
  const f = normalizarBooleano(funda);
  let mult = 1.0;
  if (d) mult *= 0.6;
  if (f) mult *= 0.6;
  return mult;
}

// Probabilidad anual de avería (lineal con edad)
function pAveria(edad) {
  const e = Math.max(0, Math.min(15, Number(edad) || 0));
  const p = 0.015 + ((0.258 - 0.015) * (e / 15));
  return Math.min(0.258, Math.max(0.015, p));
}

// Probabilidad batería insuficiente (antiguo: retardo/adherencia)
function pBateriaInsuf(vida_ajustada) {
  const retardoMeses = 6;
  const adherencia = 0.80;
  const vidaMeses = (Number(vida_ajustada) || 1) * 12;
  const p = (retardoMeses * (1 - adherencia)) / Math.max(1, vidaMeses);
  return Math.max(0, Math.min(1, p));
}

// === HTML table generator (NO TOCAR) ===
function generateTable({ pasos, resumen }, meta) {
  // Mantiene el HTML original.
  // NOTA: No introduzco ctx aquí. No lo necesita y evita errores.
  const fmt2 = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : "—");
  const fmtP = (n) => (Number.isFinite(Number(n)) ? (Number(n) * 100).toFixed(2) + "%" : "—");
  const fmtY = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) + " años" : "—");

  const baliza = meta?.baliza || "—";
  const fabricante = meta?.fabricante || "—";
  const origen = meta?.origen || "—";
  const actuacion = meta?.actuacion || "—";
  const provincia = meta?.provincia || "—";
  const edad = meta?.edad || "—";

  // (El contenido que sigue es tu tabla original; no lo reescribo “bonito”.
  //  Mantengo estructura y textos tal cual venían en el archivo que funcionaba).
  return `
  <div class="tco-result">
    <div class="tco-meta">
      <h3>Datos Seleccionados</h3>
      <table class="meta-table">
        <tr><td>Baliza</td><td>${baliza}</td></tr>
        <tr><td>Fabricante</td><td>${fabricante}</td></tr>
        <tr><td>Origen</td><td>${origen}</td></tr>
        <tr><td>Actuación en España</td><td>${actuacion}</td></tr>
        <tr><td>Provincia</td><td>${provincia}</td></tr>
        <tr><td>Antigüedad del vehículo</td><td>${edad} años</td></tr>
      </table>
    </div>

    <table class="tco-table">
      <thead>
        <tr>
          <th>Concepto</th>
          <th>Cálculo</th>
          <th>Resultado</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Vida de las Pilas (conectadas)<br><b>"${meta?.marca_pilas || 'Sin marca'}"</b></td>
          <td>Duración estimada con las pilas conectadas a la baliza: <b>${fmtY(pasos.vida_base)}</b><br>
              Fuente: ${pasos.fuente_vida_base || "battery_types.json"}</td>
          <td><b>${fmtY(pasos.vida_base)}</b></td>
        </tr>

        <tr>
          <td>Factor Desconexión<br><b>"${meta?.desconectable_txt || "No" }"</b></td>
          <td>
            ${meta?.desconectable_txt === "Sí"
              ? `Se contempla desconexión. Vida base pasa a shelf-life: <b>${fmtY(pasos.valor_desconexion)}</b>`
              : `No, no contemplado en esta baliza. Vida base queda en uso: <b>${fmtY(pasos.valor_desconexion)}</b>`
            }<br>
            Fuente: ${pasos.fuente_desconexion || "battery_types.json"}
          </td>
          <td><b>${fmtY(pasos.valor_desconexion)}</b></td>
        </tr>

        <tr>
          <td>Factor Temperatura<br><b>${meta?.temp_extrema || "—"}</b></td>
          <td>
            En ${meta?.provincia || "—"} las temperaturas anuales oscilan entre ${meta?.tmax || "—"}°C y ${meta?.tmin || "—"}°C, con media ${meta?.tmedia || "—"}°C.<br>
            Aplicamos un factor térmico anual estimado: <b>${fmtP(pasos.factor_temp)}</b><br>
            Fuente: ${meta?.fuente_temp || "provincias.json"}
          </td>
          <td><b>${fmtP(pasos.factor_temp)}</b></td>
        </tr>

        <tr>
          <td>Factor Funda<br><b>${meta?.funda_txt || "No lleva funda"}</b></td>
          <td>
            ${meta?.funda_txt === "Lleva funda"
              ? `Hay aislamiento adicional. Factor aplicado: <b>x${fmt2(pasos.factor_fun)}</b>`
              : `Sin funda o funda desconocida. Factor aplicado: <b>x${fmt2(pasos.factor_fun)}</b>`
            }
          </td>
          <td><b>x${fmt2(pasos.factor_fun)}</b></td>
        </tr>

        <tr>
          <td>Vida útil Real de las Pilas</td>
          <td>
            Vida útil estimada considerando desconexión, provincia (Arrhenius) y funda.<br>
            Resultado: <b>${fmtY(resumen.vida_ajustada)}</b>
          </td>
          <td><b>${fmtY(resumen.vida_ajustada)}</b></td>
        </tr>

        <tr>
          <td>Reposiciones (12 años)</td>
          <td>
            Cambios de pilas previstos durante 12 años: <b>${fmt2(resumen.reposiciones)}</b>
          </td>
          <td><b>${fmt2(resumen.reposiciones)}</b></td>
        </tr>

        <tr>
          <td>Precio de sus pilas<br><b>${meta?.marca_pilas || "Sin marca"}</b></td>
          <td>
            Precio por pack: <b>${fmt2(resumen.precio_pack)} €</b><br>
            Fuente: ${meta?.precio_fuente || "battery_types.json"}
          </td>
          <td><b>${fmt2(resumen.precio_pack)} €</b></td>
        </tr>

        <tr>
          <td><b>Coste por cambio de pilas a 12 años</b></td>
          <td>
            Coste total estimado en pilas durante 12 años: <b>${fmt2(resumen.coste_pilas)} €</b>
          </td>
          <td><b>${fmt2(resumen.coste_pilas)} €</b></td>
        </tr>

        <tr>
          <td>Riesgo de fuga anual</td>
          <td>
            Riesgo anual estimado: <b>${fmtP(resumen.prob_fuga)}</b><br>
            Fuente: ${meta?.fuente_sulfat || "battery_types.json"}
          </td>
          <td><b>${fmtP(resumen.prob_fuga)}</b></td>
        </tr>

        <tr>
          <td>Mitigación de Riesgo de fugas</td>
          <td>
            Mitigación por desconexión/funda: <b>${fmtP(1 - resumen.mitigacion)}</b>
          </td>
          <td><b>${fmtP(1 - resumen.mitigacion)}</b></td>
        </tr>

        <tr>
          <td><b>Riesgo final de fuga anual</b></td>
          <td>
            Riesgo final = riesgo anual x mitigación = <b>${fmtP(resumen.p_fuga_final)}</b>
          </td>
          <td><b>${fmtP(resumen.p_fuga_final)}</b></td>
        </tr>

        <tr>
          <td>Coste de fugas a 12 años</td>
          <td>
            Coste fugas 12 años = coste inicial x riesgo final x 12: <b>${fmt2(resumen.coste_fugas_12)} €</b>
          </td>
          <td><b>${fmt2(resumen.coste_fugas_12)} €</b></td>
        </tr>

        <tr>
          <td>Probabilidad anual de Avería</td>
          <td>
            Modelo lineal por antigüedad vehículo: <b>${fmtP(resumen.p_averia)}</b>
          </td>
          <td><b>${fmtP(resumen.p_averia)}</b></td>
        </tr>

        <tr>
          <td>Probabilidad de batería insuficiente</td>
          <td>
            p(batería insuf.) = <b>${fmtP(resumen.p_bateria_insuf)}</b>
          </td>
          <td><b>${fmtP(resumen.p_bateria_insuf)}</b></td>
        </tr>

        <tr>
          <td><b>Probabilidad de que la baliza no funcione</b></td>
          <td>
            p(no funciona) = 1 - (1 - p_fuga_final) x (1 - p_batería_insuf) = <b>${fmtP(resumen.p_no_funcione)}</b>
          </td>
          <td><b>${fmtP(resumen.p_no_funcione)}</b></td>
        </tr>

        <tr>
          <td>Coste de multas (12 años)</td>
          <td>
            Multa estándar: 200€; p_denuncia: 32%.<br>
            Coste 12 años estimado: <b>${fmt2(resumen.coste_multas_12)} €</b>
          </td>
          <td><b>${fmt2(resumen.coste_multas_12)} €</b></td>
        </tr>

        <tr>
          <td><b>Total mantenimiento (12 años)</b></td>
          <td>
            Pilas + fugas + multas = <b>${fmt2(resumen.mantenimiento_12y)} €</b>
          </td>
          <td><b>${fmt2(resumen.mantenimiento_12y)} €</b></td>
        </tr>

        <tr>
          <td><b>Total (incl. compra) 12 años</b></td>
          <td>
            Coste inicial + mantenimiento = <b>${fmt2(resumen.total_12y)} €</b>
          </td>
          <td><b>${fmt2(resumen.total_12y)} €</b></td>
        </tr>
      </tbody>
    </table>
  </div>`;
}

// --- Debug endpoints ---
app.get("/__routes", (req, res) => {
  res.json({
    routes: [
      "GET /__routes",
      "GET /__ping",
      "GET /api/__corsinfo",
      "GET /__db",
      "POST /__echo",
      "POST /api/calcula",
      "GET /api/beacons",
      "GET /api/sales_points",
      "GET /api/provincias",
      "GET /api/battery_types",
      "POST /api/enviar-pdf",
      "GET /api/proxy-image",
      "POST /api/pre-register",
      "GET /api/verify",
      "GET /api/whoami",
    ],
  });
});

app.get("/__ping", (req, res) => res.json({ ok: true, ts: Date.now() }));

app.get("/api/__corsinfo", (req, res) => {
  res.json({
    origin: req.headers.origin || null,
    allowed: req.headers.origin ? ALLOWED_ORIGINS.has(req.headers.origin) : true,
    envAllowed: process.env.ALLOWED_ORIGIN || null,
  });
});

app.get("/__db", async (req, res) => {
  try {
    if (!pool) return res.json({ enabled: false });
    const [rows] = await pool.query("SELECT 1 AS ok");
    res.json({ enabled: true, rows });
  } catch (e) {
    res.status(500).json({ enabled: true, error: e.message });
  }
});

app.post("/__echo", (req, res) => res.json({ ok: true, body: req.body, headers: req.headers }));

// ===========================
// ✅ ENDPOINT PRINCIPAL TCO
// ===========================
app.post('/api/calcula', async (req, res) => {
  try {
    const body = req.body || {};

    // === Compatibilidad de payload (front antiguo + pruebas curl nuevas) ===
    const id_baliza      = (body.id_baliza ?? body.beacon_id ?? body.idBeacon) != null ? Number(body.id_baliza ?? body.beacon_id ?? body.idBeacon) : null;
    const id_sales_point = (body.id_sales_point ?? body.sales_point_id ?? body.idSalesPoint) != null ? Number(body.id_sales_point ?? body.sales_point_id ?? body.idSalesPoint) : null;

    // Contexto A/B/C
    const contexto = body.contexto ?? body.ctx ?? body.context ?? 'A';

    // Baterías / mitigaciones
    const tipo          = body.tipo ?? body.battery_type ?? body.batteryType ?? '3x AA';
    const marca         = body.marca ?? body.battery_brand ?? body.batteryBrand ?? 'Sin marca';
    const desconectable = body.desconectable ?? body.disconnectable ?? body.disconnect ?? 'no';
    const funda         = body.funda ?? (body.thermal_case === true ? 'si' : body.thermal_case === false ? 'no' : undefined) ?? 'no';

    // Localización / números
    const provincia     = body.provincia ?? body.province ?? 'Madrid';
    const coste_inicial = body.coste_inicial ?? body.purchase_price ?? body.purchasePrice ?? 0;
    const edad_vehiculo = body.edad_vehiculo ?? body.car_age ?? body.carAge ?? 5;

    // Metadatos opcionales
    const marca_baliza  = body.marca_baliza ?? body.beacon_brand ?? body.beaconBrand ?? 'Desconocida';
    const modelo        = body.modelo ?? body.beacon_model ?? body.beaconModel ?? 'Desconocido';
    const modelo_compra = body.modelo_compra ?? body.purchase_model ?? body.purchaseModel ?? '';
    const email         = body.email ?? '';

    const marca_pilas = marca;

    // Debe venir un identificador de baliza o punto de venta
    if (id_baliza === null && id_sales_point === null) {
      return res.status(400).json({ error: 'Falta id_baliza o id_sales_point en el payload' });
    }

    if (isNaN(parseFloat(coste_inicial)) || isNaN(parseInt(edad_vehiculo))) {
      return res.status(400).json({ error: 'Datos numéricos inválidos' });
    }

    const beaconInfo = beacons.find(b => b.id_baliza === id_baliza);
    const spInfo = salesPoints.find(s => s.id_punto === id_sales_point);

    const sourceData = beaconInfo || spInfo || {};

    // Vida útil real (años)
    const vida_ajustada = lifeArrheniusYears(
      tipo, marca_pilas, provincia, desconectable, funda, batteryData, provincias
    );

    // Si no hay datos para vida útil, devolvemos 400 (evita NaN cascada)
    if (!Number.isFinite(vida_ajustada) || vida_ajustada <= 0) {
      return res.status(400).json({
        error: "Vida útil de pila inválida",
        debug: { tipo: canonicalBatteryType(tipo), marca_pilas: canonicalBrand(marca_pilas), provincia }
      });
    }

    // Reposiciones y coste pilas
    const reposiciones = Math.ceil(12 / vida_ajustada);
    const precio_pack = getBatteryPackPrice(tipo, marca_pilas, sourceData);
    const precio_fuente = sourceData.precio_por_pila ? sourceData.precio_por_pila.fuente : 'battery_types.json';

    if (!Number.isFinite(precio_pack)) {
      return res.status(400).json({
        error: "Precio pack de pilas inválido",
        debug: { tipo: canonicalBatteryType(tipo), marca_pilas: canonicalBrand(marca_pilas) }
      });
    }

    const coste_pilas = parseFloat((reposiciones * precio_pack).toFixed(2));

    // Riesgo fugas
    const tasa_anual = sourceData.factor_sulfatacion?.tasa_anual ?? getLeakRisk(tipo, marca_pilas);
    const fuente_sulfat = sourceData.factor_sulfatacion?.fuente ?? 'battery_types.json';

    const prob_fuga = leakRiskArrhenius(tipo, marca_pilas, provincia, batteryData, provincias);
    const mitig = mitigacion(desconectable, funda);
    const p_fuga_final = Math.max(0, Math.min(1, prob_fuga * mitig));

    const coste_fugas = Number((Number(coste_inicial) * p_fuga_final).toFixed(2));
    const coste_fugas_12 = Number((coste_fugas * 12).toFixed(2));

    // Multas
    const p_averia = pAveria(edad_vehiculo);
    const p_bateria_insuf = pBateriaInsuf(vida_ajustada);
    const p_no_funcione = 1 - ((1 - p_fuga_final) * (1 - p_bateria_insuf));

    const multa = 200;
    const p_denuncia = 0.32;

    const coste_multas = Number((multa * p_denuncia * p_averia * p_no_funcione).toFixed(2));
    const coste_multas_12 = Number((coste_multas * 12).toFixed(2));

    const mantenimiento_12y = Number((coste_pilas + coste_fugas_12 + coste_multas_12).toFixed(2));
    const total_12y = Number((Number(coste_inicial) + mantenimiento_12y).toFixed(2));

    // Pasos (para tabla)
    const tCanon = canonicalBatteryType(tipo);
    const bCanon = canonicalBrand(marca_pilas);
    const baseData = batteryData[tCanon]?.[bCanon] || batteryData[tCanon]?.['Sin marca'] || {};
    const uso = Number(baseData.uso || 0);
    const shelf = Number(baseData.shelf || 0);

    const valor_desconexion = normalizarBooleano(desconectable) ? shelf : uso;

    const pData = getProvinciaData(provincia, provincias);
    const factor_temp = (1 / multAvgProvince(pData)) - 1; // solo explicativo (tabla)
    const factor_fun = normalizarBooleano(funda) ? 1.10 : 1.00;

    const resumen = {
      contexto,
      vida_ajustada,
      reposiciones,
      precio_pack,
      coste_pilas,
      prob_fuga,
      mitigacion: mitig,
      p_fuga_final,
      coste_fugas,
      coste_fugas_12,
      p_averia,
      p_bateria_insuf,
      p_no_funcione,
      coste_multas,
      coste_multas_12,
      mantenimiento_12y,
      total_12y
    };

    const pasos = {
      vida_base: uso,
      valor_desconexion,
      factor_temp: Math.max(0, factor_temp),
      factor_fun,
      fuente_vida_base: baseData.fuente || 'battery_types.json',
      fuente_desconexion: baseData.fuente || 'battery_types.json'
    };

    const meta = {
      baliza: sourceData.nombre || sourceData.beacon_name || modelo_compra || modelo || '—',
      fabricante: sourceData.fabricante || marca_baliza || '—',
      origen: sourceData.origen || sourceData.pais || '—',
      actuacion: sourceData.actuacion_en_es || sourceData.actuacion || '—',
      provincia,
      edad: Number(edad_vehiculo) || 0,
      marca_pilas: bCanon,
      desconectable_txt: normalizarBooleano(desconectable) ? "Sí" : "No",
      funda_txt: normalizarBooleano(funda) ? "Lleva funda" : "No lleva funda",
      precio_fuente,
      fuente_sulfat,
      temp_extrema: pData.temp_extrema ?? "—",
      tmax: pData.tmax ?? "—",
      tmin: pData.tmin ?? "—",
      tmedia: pData.tmedia ?? "—",
      fuente_temp: pData.fuente_temp_extrema ?? "provincias.json"
    };

    const html = generateTable({ pasos, resumen }, meta);

    return res.json({
      ok: true,
      resumen,
      html
    });
  } catch (e) {
    console.error("Error en /api/calcula:", e);
    return res.status(500).json({ error: "Error interno", detail: e.message });
  }
});

// Catálogos
app.get('/api/beacons', (req, res) => res.json(beacons));
app.get('/api/sales_points', (req, res) => res.json(salesPoints));
app.get('/api/provincias', (req, res) => res.json(provincias));
app.get('/api/battery_types', (req, res) => res.json(batteryData));

// ===== PDF (se mantiene el endpoint, aunque no se use aún) =====
app.post('/api/enviar-pdf', async (req, res) => {
  try {
    // Mantener compatibilidad: si más adelante lo usas
    res.json({ ok: true, message: "Endpoint PDF disponible (no-op)" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxy image (compatibilidad)
app.get('/api/proxy-image', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).send("Missing url");
    // No implementamos fetch aquí para no introducir dependencias.
    return res.status(501).send("Not implemented");
  } catch (e) {
    res.status(500).send("Error");
  }
});

// Pre-register / verify / whoami (compatibilidad)
app.post('/api/pre-register', (req, res) => res.json({ ok: true }));
app.get('/api/verify', (req, res) => res.json({ ok: true }));
app.get('/api/whoami', (req, res) => res.json({ ok: true }));

// Fallback 404 JSON
app.use((req, res) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});

// PORT
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Datos cargados correctamente");
  console.log(`✅ Servidor escuchando en puerto ${PORT}`);
});
