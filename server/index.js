// index.js
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const { OpenAI } = require('openai');

const app = express();

// ── Preparar CSV de logs ───────────────────────────────────────────────
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const csvPath = path.join(dataDir, 'requests.csv');
if (!fs.existsSync(csvPath)) {
  const header = [
    'timestamp','ctx',
    'tipo_pila','marca_pila','desconexion_polos','proteccion_termica',
    'provincia','packCost','precio_inicial','car_age','anonymous',
    'response'
  ].join(',') + '\n';
  fs.writeFileSync(csvPath, header, 'utf8');
}

// ── Middleware ────────────────────────────────────────────────────────
app.use(cors({
  origin: 'https://comparativabalizas.es',
  methods: ['GET','POST']
}));
app.use(express.json());

// ── Cliente OpenAI ───────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Prompt del sistema ─────────────────────────────────────────────────
const SYSTEM_PROMPT = `
Eres un asesor neutral de coste total de propiedad (TCO) de balizas V16 IoT para el mercado español.
Con los datos del usuario, calcula y devuelve:

1. Desglose numérico (formato texto) con valores en euros:
   • Coste inicial de compra.
   • Número estimado de reposiciones de batería en 12 años 
     (usa durabilidad típica: AA/AAA=2-3años →4-6 packs; 9V=1.5-2años →6-8 unidades; Litio=15-20años →1 unidad).
   • Coste total de baterías (packCost × reposiciones).
   • Coste funda térmica (si aplica; €6-€12 amortizable en 2 años).
   • Coste esperado de fuga (probabilidad fuga × 20 €).
   • Probabilidad de ≥1 incidencia en 12 años (según edad del coche).
   • Coste esperado multas: P_inc × P(fallo batería) × 200 €.
   • Coste total en 12 años.
   • Coste medio mensual (divide el total entre 144 meses).

2. Un breve párrafo que explique:
   - Cómo influyen estos componentes en el TCO.
   - Recomendaciones generales (sin usar “mejor/peor”, solo hechos).

Formatea la respuesta así:

Coste inicial: X €  
Coste baterías (12 años): Y €  
Coste funda térmica: Z €  
Coste esperado fuga: F €  
Coste esperado multas: M €  
Coste total (12 años): T €  
Coste medio mensual: U €  

[Breve párrafo explicativo]
`.trim();

// ── Endpoints ─────────────────────────────────────────────────────────
app.get('/',       (req, res) => res.send('API Balizas OK'));
app.get('/health', (req, res) => res.send('OK'));

app.post('/api/calcula', async (req, res) => {
  // 1) Desestructuramos inputs
  const {
    context,
    tipo_pila, marca_pila, desconexion_polos, proteccion_termica,
    provincia, packCost = 0, precio_inicial = 0,
    car_age = 0, anonymous = true
  } = req.body;

  // 2) Log petición (igual que antes)
  const lineReq = [new Date().toISOString(), context,
    tipo_pila||'', marca_pila||'', desconexion_polos||'', proteccion_termica||'',
    provincia||'', packCost, precio_inicial, car_age, anonymous
  ].join(',') + '\n';
  fs.appendFileSync(csvPath, lineReq, 'utf8');

  // 3) Parámetros base de vida útil y riesgo fuga
  const baseParams = {
    '3x AA':      { vida: 2.5,  pFuga: 0.60, unitCost: 0.50 },
    '3x AAA':     { vida: 2.5,  pFuga: 0.60, unitCost: 0.50 },
    '9 V':        { vida: 1.75, pFuga: 0.78, unitCost: 2.00 },
    'Litio':      { vida: 17.5, pFuga: 0.05, unitCost: 5.00 },
    'NiMH LSD':   { vida: 6.0,  pFuga: 0.15, unitCost: 3.50 }
  };
  const param = baseParams[tipo_pila] || { vida:2, pFuga:0.5, unitCost:0 };

  // 4) Ajustes por marca
  let vida = param.vida;
  if (marca_pila === 'Energizer' || marca_pila === 'Duracell') {
    // vida = max
  } else if (marca_pila === 'Varta') {
    vida *= 0.85;
  } else if (marca_pila === 'Marca blanca') {
    vida *= 0.5;
  }

  // 5) Ajustes por desconexión
  if (desconexion_polos === 'sí') vida *= 2;

  // 6) Ajustes por funda
  let pFuga = param.pFuga;
  if (proteccion_termica === 'sí') {
    vida *= 1 + (Math.random()*0.5 + 1.0 - 1); // +100–150%, aquí simplifico +125%
    pFuga *= 0.6;  // −40%
  }

  // 7) Cálculos
  const reps = Math.ceil(12 / vida);
  const batteryCostTotal = reps * (packCost || (4 * param.unitCost));
  const caseCost = proteccion_termica==='sí' ? 8 : 0;
  const leakCost = pFuga * 20;
  // P_inc según edad coche
  let pInc = car_age <= 0 ? 0.015
           : car_age >= 15 ? 0.258
           : 0.015 + (0.258-0.015)*(car_age/15);
  const fineCost = pInc * 0.32 * 200;  // 32% P(fallo batería)
  const totalCost = precio_inicial + batteryCostTotal + caseCost + leakCost + fineCost;
  const monthlyCost = +(totalCost / 144).toFixed(2);

  // 8) Log respuesta
  const lineRes = [new Date().toISOString(), context,
    '', '', '', '', '', '', '', '', '', // columnas anteriores
    totalCost.toFixed(2)
  ].join(',') + '\n';
  fs.appendFileSync(csvPath, lineRes, 'utf8');

  // 9) Devolver JSON estructurado
  return res.json({
    initialCost:      precio_inicial,
    batteryReps:      reps,
    batteryCost:      +batteryCostTotal.toFixed(2),
    caseCost:         caseCost,
    leakCost:         +leakCost.toFixed(2),
    fineCost:         +fineCost.toFixed(2),
    totalCost12y:     +totalCost.toFixed(2),
    monthlyCost,
    qualitative: `En este escenario … ${monthlyCost} € al mes.`
  });
});
