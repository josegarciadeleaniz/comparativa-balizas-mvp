// FORCE DEPLOY — BACKEND TCO LIMPIO
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
// ===============================
// CORS (PERMITIR balizas.pro)
// ===============================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://balizas.pro');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

// ===============================
// CARGA DE DATOS (JSON)
// ===============================
let beacons = [];
let batteryData = {};
let provincias = {};

try {
  beacons = JSON.parse(fs.readFileSync(path.join(__dirname, 'beacons.json'), 'utf8'));
  batteryData = JSON.parse(fs.readFileSync(path.join(__dirname, 'battery_types.json'), 'utf8'));
  provincias = JSON.parse(fs.readFileSync(path.join(__dirname, 'provincias.json'), 'utf8'));
  console.log('✅ Datos cargados correctamente');
} catch (e) {
  console.error('❌ Error cargando JSON:', e);
  process.exit(1);
}

// ===============================
// FUNCIONES AUXILIARES
// ===============================
function normalizarBooleano(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

function getVidaBase(tipo, marca) {
  const t = batteryData[tipo];
  if (!t) return { uso: null, shelf: null };
  const m = t.marcas?.[marca] || t.marcas?.['Marca Blanca'];
  return {
    uso: m?.uso ?? null,
    shelf: m?.shelf ?? null
  };
}

function getFundaFactor(funda) {
  if (!funda) return 1;
  const f = funda.toString().toLowerCase();
  if (f.includes('eva')) return 0.6;
  if (f.includes('neopreno')) return 0.7;
  if (f.includes('tela')) return 0.8;
  return 1;
}

function lifeArrheniusYears(tipo, marca, provincia, desconectable, funda) {
  const base = getVidaBase(tipo, marca);
  if (!base.uso || !base.shelf) return null;

  const dias30 = provincias?.[provincia]?.dias_anuales_30grados ?? 0;
  const factorProvincia = 1 + (dias30 / 365);
  const baseVida = normalizarBooleano(desconectable) ? base.shelf : base.uso;
  const factorFunda = getFundaFactor(funda);

  return +(baseVida / factorProvincia * factorFunda).toFixed(3);
}

// ===============================
// ENDPOINT ÚNICO: /api/calcula
// ===============================
app.post('/api/calcula', (req, res) => {
  try {
    const {
      tipo,
      marca_pilas = 'Marca Blanca',
      desconectable,
      funda,
      provincia,
      coste_inicial,
      edad_vehiculo
    } = req.body;

    if (!tipo || !provincia) {
      return res.status(400).json({ error: 'Datos incompletos' });
    }

    const base = getVidaBase(tipo, marca_pilas);
    if (!base.uso || !base.shelf) {
      return res.status(400).json({ error: 'Vida base de pila no disponible' });
    }

    const vidaAjustada = lifeArrheniusYears(
      tipo,
      marca_pilas,
      provincia,
      desconectable,
      funda
    );

    if (!vidaAjustada) {
      return res.status(400).json({ error: 'No se pudo calcular vida útil' });
    }

    const replacements = Math.ceil(12 / vidaAjustada);
    const precioPilas = batteryData[tipo]?.precio ?? 0;
    const costePilas12y = replacements * precioPilas;

    const probIncidente =
      0.015 + ((0.258 - 0.015) * Math.min(Number(edad_vehiculo) / 15, 1));

    const costeMultas = probIncidente * 200 * 0.32;

    const total12y =
      Number(coste_inicial || 0) + costePilas12y + costeMultas;

    res.json({
      pasos: {
        vida_base_uso: base.uso,
        vida_base_shelf: base.shelf,
        vida_ajustada: vidaAjustada,
        reemplazos_12y: replacements,
        coste_pilas_12y: +costePilas12y.toFixed(2),
        coste_multas_estimado: +costeMultas.toFixed(2)
      },
      resumen: {
        total12y: +total12y.toFixed(2),
        medioAnual: +(total12y / 12).toFixed(2)
      }
    });

  } catch (e) {
    console.error('❌ Error en /api/calcula:', e);
    res.status(500).json({ error: 'Error interno de cálculo' });
  }
});

// ===============================
// ARRANQUE SERVIDOR
// ===============================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Servidor escuchando en puerto ${PORT}`);
});
