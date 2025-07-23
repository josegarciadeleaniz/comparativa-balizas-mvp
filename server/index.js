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
  // ── 1) Desestructurar incluyendo car_age ───────────────────────────
  const {
    context,
    tipo_pila, marca_pila, desconexion_polos, proteccion_termica,
    provincia, packCost = 0, precio_inicial = 0,
    car_age = 0, anonymous = true
  } = req.body;

  // ── 2) Log de petición ─────────────────────────────────────────────
  const lineReq = [
    new Date().toISOString(),
    context,
    tipo_pila||'', marca_pila||'', desconexion_polos||'', proteccion_termica||'',
    provincia||'', packCost, precio_inicial, car_age, anonymous
  ].join(',') + '\n';
  try {
    fs.appendFileSync(csvPath, lineReq, 'utf8');
  } catch (e) {
    console.warn('⚠️ No se pudo escribir petición en CSV:', e.message);
  }

  // ── 3) Cálculo de P_inc según edad del coche ────────────────────────
  let pInc;
  if (car_age <= 0)      pInc = 0.015;
  else if (car_age >= 15) pInc = 0.258;
  else pInc = 0.015 + (0.258 - 0.015) * (car_age / 15);
  console.log(`📊 Probabilidad incidencia (edad ${car_age} años): ${(pInc*100).toFixed(2)} %`);

  // ── 4) Construir prompt de usuario ─────────────────────────────────
  const userPrompt = `
Datos recibidos:
- Pilas: tipo ${tipo_pila}, marca ${marca_pila}, desconexión: ${desconexion_polos}, funda: ${proteccion_termica}
- Provincia: ${provincia}
- Coste inicial: ${precio_inicial}€
- Coste por pack de pilas (4 uds): ${packCost}€
- Edad del coche: ${car_age} años → Probabilidad de incidencia en 12 años: ${(pInc*100).toFixed(2)} %.
Calcula el TCO según las instrucciones del sistema, incluyendo el coste esperado de multas usando esta probabilidad.
`.trim();

  try {
    // ── 5) Llamada a OpenAI ───────────────────────────────────────────
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt }
      ]
    });
    const explanation = completion.choices[0].message.content.trim();
    console.log('✅ OpenAI explicó:', explanation);

    // ── 6) Log de respuesta ──────────────────────────────────────────
    const lineRes = [
      new Date().toISOString(),
      context,
      '', '', '', '', '', '', '', '', '', // columnas previas vacías
      explanation.replace(/\r?\n/g, ' ')
    ].join(',') + '\n';
    try {
      fs.appendFileSync(csvPath, lineRes, 'utf8');
    } catch (e) {
      console.warn('⚠️ No se pudo escribir respuesta en CSV:', e.message);
    }

    // ── 7) Devolver al front ─────────────────────────────────────────
    res.json({ explanation });

  } catch (err) {
    console.error('❌ Error en /api/calcula:', err);
    res.status(500).json({
      error: 'Error interno procesando la petición',
      details: err.message
    });
  }
});

// ── 8) Arranque del servidor ───────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 4000;
app.listen(PORT, () => console.log(`API escuchando en puerto ${PORT}`));
