const express = require("express");
const cors = require("cors");
const path = require("path");

const batteryData  = require("./battery_types.json");
const provincias   = require("./provincias.json");
const beacons      = require("./beacons.json");
const salesPoints  = require("./sales_points.json");
const nodemailer   = require("nodemailer");
const PDFDocument  = require("pdfkit");
// Conexión MariaDB (mysql2/promise)
const mysql = require('mysql2/promise');

// ⚠️ Rellena con los datos que te da Plesk (DB name/user/pass)
const pool = mysql.createPool({
  host: 'localhost',      // en Plesk suele ser 'localhost'
  user: 'balizas2_user',
  password: 'Cambiame-1',
  database: 'balizas',    // o el nombre de base de datos que creaste
  port: 3306,
  waitForConnections: true,
  connectionLimit: 5
});
const app = express();

// --- CORS ---
const ALLOWED_ORIGINS = [
  "https://comparativabalizas.es",
  "https://www.comparativabalizas.es",
  "https://widget.comparativabalizas.es",
  "https://app.comparativabalizas.es",
  "https://comparativa-balizas-mvp.onrender.com" // pruebas
];

app.disable("x-powered-by");
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // health checks, curl
    cb(null, ALLOWED_ORIGINS.includes(origin));
  },
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"]
}));

app.use(express.json());

// --- CSP para iframes ---
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors 'self' https://*.comparativabalizas.es https://*.mejorigual.org"
  );
  next();
});
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});
app.use(express.static(path.join(__dirname, '../client')));
app.get('/api/ping', (req, res) => res.json({ ok: true }));
app.use('/images', express.static(path.join(__dirname, '../client/images')));
app.use('/fonts', express.static(path.join(__dirname, '../client/fonts')));
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: "JSON malformado", message: "Verifica el formato" });
  }
  next();
});

// Verificar carga JSON
try {
  if (!batteryData || !provincias || !beacons || !salesPoints) {
    throw new Error("Error cargando JSON");
  }
  console.log('Datos cargados correctamente');
} catch (e) {
  console.error('Error crítico cargando JSON:', e);
  process.exit(1);
}

// Quita acentos usando NFD + rango de diacríticos
function stripAccents(str) {
  return str
    .normalize("NFD")            // descompone caracteres acentuados
    .replace(/[\u0300-\u036f]/g, "")  // elimina marcas de acento
    .normalize("NFC");           // (opcional) recomponer
}

function normalizarTexto(texto) {
  return stripAccents(texto + "").toLowerCase().trim();
}

function normalizarBooleano(valor) {
  const v = stripAccents(String(valor)).toLowerCase().trim();
  return ["si", "yes", "true"].includes(v);
}

// — Aquí insertas getFundaFactor —
/**
 * Devuelve el factor de vida útil según el tipo de funda.
 * @param {string} tipoFunda  "Tela", "Neopreno", "EVA Foam" o "No"
 * @returns {number} Factor numérico a multiplicar sobre la vida base
 */
function getFundaFactor(tipoFunda) {
  const map = {
    tela:     1.02,
    neopreno: 1.10,
    'eva foam': 1.25
  };
  const key = String(tipoFunda || '').toLowerCase().trim();
  return map[key] || 1.00;
}

// Obtiene datos de vida base
function getVidaBase(tipo, marca_pilas) {
  const tipoSimple = tipo.includes('9V') ? '9V' : (tipo.includes('AAA') ? 'AAA' : 'AA');
  const marcaNorm = batteryData.vida_base[tipoSimple][marca_pilas] ? marca_pilas : 'Sin marca';
  return batteryData.vida_base[tipoSimple][marcaNorm];
}

// Calcula vida ajustada
function getLifeYears(tipo, marca_pilas, provincia, desconectable, funda) {
  // Obtenemos vida base en uso y en reposo
  const { uso, shelf } = getVidaBase(tipo, marca_pilas);

  // El "factor desconexión" en años: shelf si desconectable, uso si no
  const valorDesconexion = normalizarBooleano(desconectable)
    ? shelf
    : uso;

  // Resto de factores
  const factorTemp  = getTempFactor(provincia);
  const factorFunda = getFundaFactor(funda);

  // Fórmula final: años de desconexión × factor temperatura × factor funda
  const vidaAjustada = valorDesconexion * factorTemp * factorFunda;
  return +vidaAjustada.toFixed(2);
}

// Antes: function getBatteryPackPrice(tipo, marca_pilas) { ... }
function getBatteryPackPrice(tipo, marca_pilas, sourceData) {
  // 1) Si viene precio directo en la baliza/punto de venta, lo usamos:
  if (sourceData?.precio_por_pila) {
    const unit = sourceData.precio_por_pila.precio;
    // asumimos cantidad = número de pilas que ya sabes de sourceData.tipo_pila
    const cantidad = sourceData.numero_pilas || 
                     (tipo.includes('9V') ? 1 : parseInt(tipo,10) || (tipo.includes('AAA') ? 3 : 4));
    return parseFloat((unit * cantidad).toFixed(2));
  }

  // 2) Si no existe, cae al fallback clásico:
  const precios = batteryData.precios_pilas;
  const marcaNorm = marca_pilas === 'Marca Blanca'
    ? 'Marca blanca'
    : (marca_pilas === 'No' ? 'Sin marca' : marca_pilas);

  let tipoBase, cantidad;
  if (tipo.includes('9V')) {
    tipoBase = '9V'; cantidad = 1;
  } else {
    tipoBase = tipo.includes('AAA') ? 'AAA' : 'AA';
    cantidad = parseInt(tipo.match(/^(\d+)/)?.[1]) || (tipoBase === 'AAA' ? 3 : 4);
  }
  const unit = precios[marcaNorm]?.[tipoBase]
    ?? precios['Sin marca']?.[tipoBase]
    ?? (tipoBase === 'AAA' ? 0.8 : 1.0);

  return parseFloat((unit * cantidad).toFixed(2));
}

// Factor temperatura
function getTempFactor(provincia) {
  const p = provincias.find(x => normalizarTexto(x.provincia) === normalizarTexto(provincia));
  if (!p) return 1;
  const t = p.temp_extrema_guantera;
  if (t >= 60) return 0.5;
  if (t >= 55) return 0.55;
  if (t >= 50) return 0.6;
  if (t >= 45) return 0.7;
  if (t >= 40) return 0.8;
  if (t >= 35) return 0.9;
  return 1;
}

// Riesgos
function getLeakRisk(tipo, marca_pilas) {
  const map = { "Duracell": 0.4, "Energizer": 0.4, "Varta": 0.45, "Marca Blanca": 0.55, "No": 0.6 };
  return map[marca_pilas] || 0.55;
}
function getLeakFinalRisk(tipo, marca_pilas, desconectable, funda) {
  const base = getLeakRisk(tipo, marca_pilas);
  const mit = (normalizarBooleano(desconectable) ? 0.6 : 1) * (normalizarBooleano(funda) ? 0.6 : 1);
  return +(base * mit).toFixed(4);
}
function getFineProb(edad) {
  const e = Math.min(parseInt(edad) || 0, 30);
  const base = 0.015, max = 0.258;
  return Math.min(base + ((max - base) * (e / 15)), max);
}

function generateTable({ pasos, resumen }, meta) {
  // 1) Vida base
  const { shelf, uso, fuente } = getVidaBase(meta.tipo, meta.marca_pilas);

  // 2) Valores de pasos (incluye fugas)
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
    // —— NUEVA LÓGICA DE FUGAS ——
    tasa_anual        = 0,
    fuente_sulfat     = '',
    dias_calidos      = 0,
    factor_provincia  = 1,
    fuente_temp       = '',
    fuente_dias       = '',
    prob_fuga         = 0
  } = pasos;

    // 3) Cálculos auxiliares
  const numeroPilas    = parseInt(meta.tipo.match(/^(\d+)/)?.[1] || '1', 10);
  const precioUnitario = precio_pack / numeroPilas;

  // 4) Estadísticas de temperatura (sólo para mostrar, no afectan a fugas)
  const provinciaData  = provincias.find(p => normalizarTexto(p.provincia) === normalizarTexto(meta.provincia)) || {};
  const tempMax        = provinciaData.temp_max_anual        ?? 'N/A';
  const tempMin        = provinciaData.temp_min_anual        ?? 'N/A';
  const tempMedia      = provinciaData.temp_media_anual      ?? 'N/A';
  const tempExt        = provinciaData.temp_extrema_guantera ?? 'N/A';

// ——— Bloque ÚNICO para mostrar datos de la baliza seleccionada (sin pisar lo que metió el usuario) ———
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

  // 5) Probabilidad de avería y coste de multa (igual que antes)
  const pNuevo      = 0.015;
  const p15años     = 0.258;
  const edadRatio   = Math.min(meta.edad_vehiculo, 15) / 15;
  const probAveria  = pNuevo + (p15años - pNuevo) * edadRatio;

  const TASA_DENUNCIA_DEF   = 0.32;  // editable
  const IMPORTE_MULTA_DEF   = 200;   // o 80 según escenario, también editable
  const RETARDO_MESES_DEF   = 6;     // retraso medio en cambio de pilas
  const ADHERENCIA_DEF      = 0.80;  // cumplimiento estimado de cambios
  

// === CÁLCULOS ORDENADOS: mitigación, fugas, no-funciona, multas y sumatorios ===

// (1) Vida útil en meses para el modelo de batería insuficiente
const mesesVida = Math.max(1, (vida_ajustada || 0) * 12);

// (2) Mitigación (desconexión + funda), y riesgo final de fuga (clamp 0..1)
const factorDescon   = esDesconectable ? 0.3 : 1;
const fundaTipoL     = (meta.funda || '').toLowerCase();
const mitDescPct  = esDesconectable ? 0.30 : 0.00; // 30% de reducción si desconectable
const mitFundaPct = (fundaTipoL.includes('silicona') || fundaTipoL.includes('eva')) ? 0.40 : 0.00; // 40% si silicona/EVA
const factorFundaMit = (fundaTipoL.includes('silicona') || fundaTipoL.includes('eva')) ? 0.4 : 1;
const mitigacionCalc = factorDescon * factorFundaMit;
const mitigacionPct   = Math.min(1, mitDescPct + mitFundaPct); // p.ej. 0.30 + 0.40 = 0.70 (capado al 100%)
const mitigacionMult  = 1 - mitigacionPct;                     // multiplicador aplicado al riesgo: 0.30
const riesgoFinalCalc = +(((prob_fuga ?? 0) * mitigacionMult).toFixed(4));

const probFuga01      = Math.max(0, Math.min(1, prob_fuga));
const mitigacion01    = Math.max(0, Math.min(1, mitigacionCalc));
const pFugaFinal      = riesgoFinalCalc; // alias para tabla

// (3) Coste de fugas (anual y 12 años)
const costeFugaAnual  = +((meta.coste_inicial || 0) * riesgoFinalCalc).toFixed(2);
const costeFuga12     = +(costeFugaAnual * 12).toFixed(2);

// (4) P(batería insuficiente) y P(no funciona)
const retardoMeses    = RETARDO_MESES_DEF;  // p.ej. 6
const adherencia      = ADHERENCIA_DEF;     // p.ej. 0.80
const fraccionRetraso = Math.max(0, Math.min(1, (retardoMeses * (1 - adherencia)) / mesesVida));
const pBateriaInsuf   = Math.min(0.5, fraccionRetraso);
const pNoFunciona     = 1 - (1 - pFugaFinal) * (1 - pBateriaInsuf);

// (5) Multas: anual (año 1 con la probAveria ya calculada) y parámetros
const tasaDenuncia     = TASA_DENUNCIA_DEF; // p.ej. 0.32
const importeMulta     = IMPORTE_MULTA_DEF; // p.ej. 200
const pMultaAnual      = probAveria * pNoFunciona * tasaDenuncia;
const costeMultasAnual = +(importeMulta * pMultaAnual).toFixed(2);

// (6) Multas: progresión 12 años (Pincidente crece con la edad y satura en 25,8%)
const probAveria12 = Array.from({ length: 12 }, (_, k) => {
  const edad = Math.min((meta.edad_vehiculo || 0) + k, 15);
  return pNuevo + (p15años - pNuevo) * (edad / 15);
});
const costeMultasPorAno = probAveria12.map(pInc => importeMulta * tasaDenuncia * pInc * pNoFunciona);
const costeMultas12     = +costeMultasPorAno.reduce((a, b) => a + b, 0).toFixed(2);

// (7) Punto de venta y desglose de cobertura 3/9
const puntoVenta            = meta.punto_venta || meta.nombre_punto_venta || meta.sales_point || meta.tienda || '';
const sufijoPV              = puntoVenta ? ` por <strong>${puntoVenta}</strong>` : '';
const textoPV               = puntoVenta ? `el punto de venta <strong>${puntoVenta}</strong>` : 'el punto de venta donde compró la baliza';
const costeFugaCubierto3    = +(costeFugaAnual * 3).toFixed(2);
const costeFugaNoCubierto9  = +(costeFugaAnual * 9).toFixed(2);

// (8) Total 12 años (para mostrar en la tabla)
const pilas12UI  = Number(resumen?.coste_pilas ?? 0); // ya viene a 12 años
const total12UI  = +((pilas12UI + costeFuga12 + costeMultas12)).toFixed(2);


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
                Picos en guantera de
                <strong>${typeof tempExt === 'number' ? tempExt.toFixed(1) : tempExt}°C</strong>,  
                provocando una pérdida de carga de
                <strong>${(pasos.factor_temp * 100).toFixed(1).replace('.', ',')}%</strong>.<br>Fuente: AEMET
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
		    Vida útil estimada de las pilas de una baliza <strong>${meta.marca_baliza} ${meta.modelo}</strong>,  
		    teniendo en cuenta la vida de las pilas según el tipo <strong>(${meta.tipo}</strong>),  
		    su marca <strong>(${meta.marca_pilas}</strong>), si la baliza permite la desconexión de las pilas a sus polos mientras no se utilice <strong>(${esDesconectable ? 'Sí' : 'No'})</strong>, la descarga que producen las temperaturas extremas que se suelen dar en primavera, verano y otoño en <strong>${meta.provincia}</strong>, y el factor funda, si ésta se entrega junto con la baliza (<strong>${meta.funda}</strong>).<br> <li><strong>Vida Útil Ajustada = ${valor_desconexion.toFixed(2).replace('.', ',')} × ${factor_temp.toFixed(2).replace('.', ',')} × ${factorFunda.toFixed(2).replace('.', ',')}= ${vida_ajustada.toFixed(2).replace('.', ',')}</strong></li>
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
                <li><strong>Riesgo de fuga Anual= (${dias_calidos} / 365) × ${tasa_anual} × ${factor_provincia} = ${(prob_fuga * 100).toFixed(2)} %</strong></li>
                Fuentes: Battery University, Vehicle Cabin Temperature (NHTSA), Fuente Factor Provincia: CSIC. ${fuente_sulfat}; ${fuente_temp}, ${fuente_dias}, 
              </td>
              <td><strong>${(prob_fuga * 100).toFixed(2)} %</strong></td>
            </tr>

            <!-- 10) Mitigación de Riesgo -->
            <tr>
              <td>Mitigación de Riesgo</td>
              <td>
                El riesgo de fugas se puede mitigar si la baliza dispone de la posibilidad de desconexión de los polos, <strong>(${esDesconectable ? 'sí' : 'no'})</strong>, con un <strong>${(mitDescPct*100).toFixed(0)}%</strong> de reducción. Si además lleva funda térmica de silicona/ EVA Foam  el factor funda genera un <strong>(<strong>${(mitFundaPct*100).toFixed(0)}%</strong> extra.)</strong>. La Degradación de las baterías de una baliza no sigue un criterio lineal, y estudios científicos demuestran que dicha degradación aumenta el riesgo de fuga en 15% por cada 5ºC por encima de 30ºC. En su Baliza <strong>${meta.marca_baliza} ${meta.modelo} </strong> este factor mitigación es por tanto de:<br> <strong><li>Factor de Mitigación = ${(mitDescPct*100).toFixed(0)}% + ${(mitFundaPct*100).toFixed(0)}% = ${(mitigacionPct*100).toFixed(0)}%</strong><br>. Fuente: Estudio MIT sobre fugas.
              </td>
              <td><strong>${(mitigacionPct*100).toFixed(0)}%</strong></td>
            </tr>

            <!-- 11) Riesgo final de fuga -->
<tr style="background-color:#fff7cc;">
  <td>Riesgo final de fuga. <strong><em>P<sub>fuga_final</sub><em></strong></td></td>
 <td>
    El riesgo final de fuga o sulfatación de las baterías de su baliza. <strong>${meta.marca_baliza} ${meta.modelo}</strong> es el resultado de aplicar el riesgo de fuga anual y la mitigación de dicho riesgo. Esta cifra que se presenta como porcentaje indica que de cada 100 balizas exactamente iguales con las mismas pilas (asumiendo que se realiza el número de reposiciones calculado anteriormente), este porcentaje de balizas sufrirán fugas, y por tanto, sulfatación y rotura, teniendo en cuenta el histórico de temperaturas de su provincia, y los datos reportados por fuentes solventes respecto al riesgo de fugas por marca y modelo de pilas: <br> <li><strong>Riesgo final de fuga = ${(prob_fuga*100).toFixed(2)}% × ${(mitigacionMult*100).toFixed(0)}% = <strong>${(riesgoFinalCalc*100).toFixed(2)}%</strong>%</strong></li>
  </td>
  <td><strong>${(riesgoFinalCalc*100).toFixed(2)}%</strong></td>
</tr>

<!-- 12) Coste de fugas -->
<tr>
  <td>Coste de fugas</td>
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
              <td>Probabilidad de Avería. <strong><br><em>P<sub>averia</sub><em></strong></td>
              <td>  Estimamos la probabilidad de incidencia (avería/accidente que exige señalización) con un modelo lineal por antigüedad del vehículo:<br>
  <li><strong>Probabilidad de avería = 1,5% + ((25,8% − 1,5%) × ${meta.edad_vehiculo} / 15) = ${(probAveria * 100).toFixed(1).replace('.', ',')}%</strong></li>
  La horquilla 1,5%→25,8% es una <em>calibración</em> coherente que indica una probabilidad de 1,5% en un coche nuevo y del 25,8% en un coche de más de 15 años, con la evidencia de que los vehículos más antiguos presentan más fallos técnicos y mayor siniestralidad. En este caso se referencia esta fórmula a la antigüedad de su coche actual que es de <strong>${meta.edad_vehiculo} años</strong><br>
  <strong>Implicación:</strong> este valor aproxima el riesgo anual de que necesites señalizar en vía.<br>
  <strong>Fuente: (ITV/DGT). Normativa:</strong> hasta el 31/12/2025 puedes señalizar con triángulos o V16; desde el 01/01/2026 la V16 <em>conectada</em> será obligatoria. No señalizar es infracción (hasta 200 €) </td>
              <td><strong>${(probAveria * 100).toFixed(1).replace('.', ',')}%</strong></td>
            </tr>
<!-- 13.2) Probabilidad de que la batería sea insuficiente -->
<tr>
  <td>Probabilidad de que la batería sea insuficiente. <strong><em>P<sub>batería_insuf.</sub><em></strong></td>
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
              <td>Probabilidad de que la baliza no funcione. <strong><em>P<sub>no_funcione</sub><em></strong></td>
<td>
  <strong>Probabilidad de que la Baliza no funcione por sulfatación o descarga de las pilas</strong><br>
  La probabilidad de que la baliza <strong>${meta.marca_baliza} ${meta.modelo}</strong> no funcione se calcula a partir de la probabilidad de fuga o sulfatación de la misma y de que las pilas se hayan descargado y no se hayan repuesto.<br> <em><strong>P (no funciona) = 1 − (1 − P<sub>fuga_final</sub>) × (1 − P<sub>batería_insuf.</sub>)</em> = 1 - (1- ${(pFugaFinal*100).toFixed(2)}%) x (1- ${(pBateriaInsuf*100).toFixed(2)}%) = ${(pNoFunciona*100).toFixed(2)}%</strong> <br>
  En donde P<sub>fuga_final</sub> = <strong>${(pFugaFinal*100).toFixed(2)}%</strong> (sulfatación + mitigación) y P<sub>batería_insuf.</sub> = <strong>${(pBateriaInsuf*100).toFixed(2)}%</strong> (retraso de cambio vs. vida útil ajustada) y  <strong>${(pNoFunciona*100).toFixed(2)}%</strong> la probabilidad real de que la Baliza no funcione cuando se vaya a utilizar.
</td>
              <td><strong>${(pNoFunciona*100).toFixed(2).replace('.', ',')}%</strong></td>
            </tr>
<!-- 15.1) Coste de multas (anual) -->
<tr style="background-color:#fff;">
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

// Endpoints
app.post('/api/calcula', async (req, res) => {
  try {
    // en la cabecera del handler:
const {
  id_baliza,
  id_sales_point,
  marca,
  tipo = '3x AA',
  desconectable = 'no',
  funda = 'no',
  provincia = 'Madrid',
  coste_inicial = 0,
  edad_vehiculo = 5,
  marca_baliza = 'Desconocida',
  modelo = 'Desconocido',
  modelo_compra = ''          // <--- AÑADIR
} = req.body;
    const marca_pilas = marca;

    if (isNaN(parseFloat(coste_inicial)) || isNaN(parseInt(edad_vehiculo))) {
      return res.status(400).json({ error: 'Datos numéricos inválidos' });
    }

    // 0) Datos de la baliza o punto de venta
    const beaconInfo     = beacons.find(b => b.id_baliza === id_baliza);
    const salesPointInfo = salesPoints.find(s => s.id_punto === id_sales_point)
    const sourceData     = beaconInfo || salesPointInfo || {};

    // Vida base
    const baseData = getVidaBase(tipo, marca_pilas);
    const uso  = baseData.uso;
    const shelf = baseData.shelf;

    // 1) Valor de desconexión en años
    const valor_desconexion = normalizarBooleano(desconectable)
      ? shelf
      : uso;

    // 2) Temperatura y funda
    const factor_temp  = getTempFactor(provincia);
    const factor_funda = getFundaFactor(funda);

    // 3) Vida ajustada
    const vida_ajustada = +(
      valor_desconexion *
      factor_temp *
      factor_funda
    ).toFixed(2);

    // 4) Reposiciones, precio y demás
    const reposiciones = Math.ceil(12 / vida_ajustada);
    const precio_pack = getBatteryPackPrice(tipo, marca_pilas, sourceData);
    let precio_fuente;
    if (sourceData.precio_por_pila) {
      precio_fuente = sourceData.precio_por_pila.fuente;
    } else {
      precio_fuente = 'battery_types.json';
    }
    const coste_pilas  = parseFloat((reposiciones * precio_pack).toFixed(2));

    console.log('--- Sulfatación: datos de entrada ---', {
    id_baliza,
    id_sales_point,
    tipo,
    marca_pilas
    });

 // —— NUEVA LÓGICA DE FUGAS —— 

  // 5a) Sulfatación anual
    const fuenteData = beacons.find(b => b.id_baliza === id_baliza)
                       || salesPoints.find(s => s.id_punto === id_sales_point)
                       || {};
    console.log('fuenteData.factor_sulfatacion:', fuenteData.factor_sulfatacion);
    const tasa_anual     = fuenteData.factor_sulfatacion?.tasa_anual     ?? getLeakRisk(tipo, marca_pilas);
    const fuente_sulfat  = fuenteData.factor_sulfatacion?.fuente         ?? 'battery_types.json';

    // 5b) Clima de la provincia
    const pData          = provincias.find(p=>normalizarTexto(p.provincia)===normalizarTexto(provincia))||{};
    console.log('pData.dias_anuales_30grados, factor_provincia:', pData.dias_anuales_30grados, pData.factor_provincia);
    const dias_calidos   = pData.dias_anuales_30grados ?? 0;
    const factor_prov    = pData.factor_provincia        ?? 1;
    const fuente_temp    = pData.fuente_temp_extrema     ?? 'provincias.json';
    const fuente_dias    = pData.fuente_dias_calidos     ?? 'provincias.json';

    // 5c) Probabilidad de fuga anual
    const prob_fuga      = +((dias_calidos/365) * tasa_anual * factor_prov).toFixed(4);

    // —— FIN LÓGICA DE FUGAS —— 

// 6) Riesgo final y coste de fugas (calcular aquí, no usar variables de generateTable)
const factorDescon   = normalizarBooleano(desconectable) ? 0.3 : 1;
const fundaLower     = String(funda || '').toLowerCase();
const factorFundaMit = (fundaLower.includes('silicona') || fundaLower.includes('eva')) ? 0.4 : 1;
const mitigacionCalc = factorDescon * factorFundaMit;

const riesgo_final   = +(Math.max(0, Math.min(1, prob_fuga)) * mitigacionCalc).toFixed(4); // 0..1
const coste_fugas    = +((parseFloat(coste_inicial) || 0) * riesgo_final).toFixed(2);       // €/año
const coste_fugas_12 = +(coste_fugas * 12).toFixed(2); 

// 6b) Coste de MULTAS: anual y 12 años (fórmula nueva)
const importeMulta  = 200;   // parametrizable
const tasaDenuncia  = 0.32;  // parametrizable
const retardoMeses  = 6;     // parametrizable
const adherencia    = 0.80;  // parametrizable

// Necesario para P(batería insuficiente) y P(no_funciona)
const mesesVida       = Math.max(1, (vida_ajustada || 0) * 12);
const pBateriaInsuf   = Math.min(0.5, (retardoMeses * (1 - adherencia)) / mesesVida);
const pNoFunciona     = 1 - (1 - riesgo_final) * (1 - pBateriaInsuf);

// *** Aquí está la clave: en el endpoint NO hay probAveria; usa getFineProb ***
const pIncHoy = getFineProb(edad_vehiculo); // 0..1 (capado a 25,8% a ≥15 años)
const coste_multas = +(importeMulta * tasaDenuncia * pIncHoy * pNoFunciona).toFixed(2);

// Progresión 12 años con getFineProb
const probAveria12 = Array.from({ length: 12 }, (_, k) =>
  getFineProb((parseInt(edad_vehiculo) || 0) + k)
);
const coste_multas_12 = +probAveria12
  .map(pInc => importeMulta * tasaDenuncia * pInc * pNoFunciona)
  .reduce((a, b) => a + b, 0)
  .toFixed(2);

// (Opcional) debug
// console.log('multas NUEVO:', { coste_multas, coste_multas_12, pNoFunciona, probAveria });

const total12y = Number((coste_pilas + coste_fugas_12 + coste_multas_12).toFixed(2));

const resumen = {
  reposiciones,
  coste_pilas,
  coste_fugas,        // anual
  coste_fugas_12,     // 12 años
  coste_multas,       // anual  ✅
  coste_multas_12,    // 12 años ✅
  total12y,
  medioAnual: Number((total12y / 12).toFixed(2))
};

    const pasos = {
  vida_base:         uso,
  valor_desconexion,
  factor_temp,
  factor_funda,
  vida_ajustada,
  precio_pack,
  precio_fuente,
  reposiciones,
  coste_pilas,
  tasa_anual,
  fuente_sulfat,
  dias_calidos,
  factor_provincia: factor_prov,
  fuente_temp,
  fuente_dias,
  prob_fuga,
  riesgo_final,      // 0..1
  coste_fugas,       // €/año
  coste_multas       // €/año (NUEVO)
};

    const meta = {
  marca_baliza,
  modelo,
  modelo_compra,              // <--- AÑADIR
  tipo,
  marca_pilas,
  desconectable,
  funda,
  provincia,
  coste_inicial: parseFloat(coste_inicial),
  edad_vehiculo: parseInt(edad_vehiculo)
};
    try {
      const userEmail = req.body.email || ''; // El frontend debe enviar el email
      const contexto = req.body.contexto || 'A'; // El frontend debe enviar el contexto (A, B, C)
      
      // Crear hash del usuario para tracking anónimo
      const userHash = userEmail ? require('crypto').createHash('md5').update(userEmail).digest('hex') : 'anonimo';
      
      await pool.query(
        `INSERT INTO calculos_usuarios 
         (user_email, user_hash, contexto, marca_baliza, modelo_baliza, provincia, coste_inicial, coste_12_anios, datos_entrada, datos_resultado) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userEmail,
          userHash,
          contexto,
          marca_baliza,
          modelo,
          provincia,
          parseFloat(coste_inicial),
          total12y, // Este es el coste total a 12 años que ya calculas
          JSON.stringify(req.body), // Todos los datos de entrada
          JSON.stringify({ // Los resultados del cálculo
            meta,
            pasos, 
            resumen,
            total_12_anios: total12y
          })
        ]
      );
      
      console.log('✅ Cálculo guardado en BD para tracking');
      
    } catch (dbError) {
      console.warn('⚠️ Error guardando cálculo en BD (continuando):', dbError);
      // NO fallar la petición aunque falle el guardado del tracking
    }

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
// Endpoint para guardar/verificar leads
app.post('/api/guardar-lead', async (req, res) => {
  try {
    const { name, company, email, selection } = req.body;
    
    if (!email || !name) {
      return res.status(400).json({ error: 'Faltan datos obligatorios' });
    }
    
    // Verificar si el email ya existe
    const [existing] = await pool.query(
      'SELECT id FROM leads WHERE email = ?',
      [email]
    );
    
    let userId;
    if (existing.length > 0) {
      // Actualizar lead existente
      userId = existing[0].id;
      await pool.query(
        'UPDATE leads SET name = ?, company = ?, last_seen = NOW() WHERE id = ?',
        [name, company, userId]
      );
    } else {
      // Crear nuevo lead
      const [result] = await pool.query(
        'INSERT INTO leads (name, company, email, created_at, last_seen) VALUES (?, ?, ?, NOW(), NOW())',
        [name, company, email]
      );
      userId = result.insertId;
    }
    
    // Guardar también la selección inicial si se proporciona
    if (selection) {
      await pool.query(
        'INSERT INTO lead_selections (lead_id, selection_data) VALUES (?, ?)',
        [userId, JSON.stringify(selection)]
      );
    }
    
    res.json({ 
      success: true, 
      user_id: userId,
      message: existing.length > 0 ? 'Lead actualizado' : 'Lead creado'
    });
    
  } catch (error) {
    console.error('Error en /api/guardar-lead:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});
app.get('/api/beacons',      (req, res) => res.json(beacons));
app.get('/api/sales_points', (req, res) => res.json(salesPoints));
app.get('/api/provincias',   (req, res) => res.json(provincias));
app.get('/api/battery_types',(req, res) => res.json(batteryData));
app.post('/api/enviar-pdf', async (req, res) => {
  try {
    const { email, title = 'Informe de baliza', resumenText = '', detalleText = '' } = req.body || {};
    if (!email) {
      return res.status(400).json({ ok: false, error: 'Falta el email' });
    }

    // 1) Generar PDF con pdfkit (texto simple)
    const doc = new PDFDocument({ size: 'A4', margins: { top: 50, left: 50, right: 50, bottom: 50 } });
    const chunks = [];
    doc.on('data', d => chunks.push(d));

    doc.fontSize(18).text(title, { align: 'center' }).moveDown();
    doc.fontSize(12).text('Resumen', { underline: true }).moveDown(0.5);
    doc.text(resumenText || '—', { lineGap: 2 }).moveDown();
    doc.text('Detalle', { underline: true }).moveDown(0.5);
    doc.text(detalleText || '—', { lineGap: 2 });

    doc.end();

    // 2) Cuando acabe el PDF, enviar email
    doc.on('end', async () => {
      try {
        const pdfBuffer = Buffer.concat(chunks);

        // Transport: usa SMTP real si pones variables de entorno,
        // si no, cae a cuenta de prueba (Ethereal)
        let transporter;
        if (process.env.SMTP_HOST) {
          transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || '587', 10),
            secure: process.env.SMTP_SECURE === 'true',
            auth: (process.env.SMTP_USER && process.env.SMTP_PASS)
              ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
              : undefined
          });
        } else {
          const testAcc = await nodemailer.createTestAccount();
          transporter = nodemailer.createTransport({
            host: 'smtp.ethereal.email',
            port: 587,
            secure: false,
            auth: { user: testAcc.user, pass: testAcc.pass }
          });
        }

        const info = await transporter.sendMail({
          from: process.env.MAIL_FROM || 'Baliza <no-reply@local>',
          to: email,
          subject: title,
          text: `${resumenText}\n\n${detalleText}`,
          attachments: [{ filename: `${title}.pdf`, content: pdfBuffer }]
        });

        const previewUrl = nodemailer.getTestMessageUrl(info) || null;
        return res.json({ ok: true, previewUrl });
      } catch (e2) {
        console.error('Fallo enviando email:', e2);
        return res.status(500).json({ ok: false, error: 'Error al enviar el correo' });
      }
    });
  } catch (e) {
    console.error('Error en /api/enviar-pdf:', e);
    return res.status(500).json({ ok: false, error: 'Error interno al generar/enviar PDF' });
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

// --- LISTEN: SOLO UNO, AL FINAL ---
const PORT = Number(process.env.PORT) || 3003;
app.listen(PORT, () => console.log("Escuchando en", PORT));
