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
    'provincia','packCost','precio_inicial','anonymous',
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
Eres un asesor neutral de coste total de propiedad de balizas IoT.
Genera un solo párrafo claro y profesional que indique:
1) Los factores clave a considerar al evaluar el coste total: calidad de pilas, desconexión de polos, uso de funda térmica, riesgo de fugas y coste de multas por falta de batería.
2) Cómo estos factores impactan en el coste mensual promedio durante 12 años.
3) La fórmula general: suma del coste inicial más costes de mantenimiento, dividido en mensualidades.
No hagas comparaciones de bueno/malo ni recomendaciones específicas, solo explica qué datos debe tener en cuenta el cliente y cómo se calcula el coste medio mensual.
`.trim();

// ── Endpoints ─────────────────────────────────────────────────────────
app.get('/',       (req, res) => res.send('API Balizas OK'));
app.get('/health', (req, res) => res.send('OK'));

app.post('/api/calcula', async (req, res) => {
  const {
    context,
    tipo_pila, marca_pila, desconexion_polos, proteccion_termica,
    provincia, packCost = 0, precio_inicial = 0, anonymous = true
  } = req.body;

  // 1) Log petición
  const lineReq = [
    new Date().toISOString(),
    context,
    tipo_pila || '',
    marca_pila || '',
    desconexion_polos || '',
    proteccion_termica || '',
    provincia || '',
    packCost,
    precio_inicial,
    anonymous
  ].join(',') + '\n';
  try {
    fs.appendFileSync(csvPath, lineReq, 'utf8');
  } catch (e) {
    console.warn('⚠️ No se pudo escribir petición en CSV:', e.message);
  }

  // 2) Construir prompt de usuario
  const userPrompt = `
Datos recibidos:
- Pilas: tipo ${tipo_pila}, marca ${marca_pila}, desconexión: ${desconexion_polos}, funda: ${proteccion_termica}
- Provincia: ${provincia}
- Coste inicial: ${precio_inicial}€
- Coste por pack de pilas (4 uds): ${packCost}€
Por favor, explica en un párrafo:
- Qué factores considerar para calcular el coste total durante 12 años
- Cómo sumar esos costes de mantenimiento al precio inicial
- Cómo se obtiene el coste medio mensual resultante
`.trim();

  try {
    // 3) Llamada a OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt }
      ]
    });
    const explanation = completion.choices[0].message.content.trim();

    console.log('✅ OpenAI explicó:', explanation);

    // 4) Log respuesta
    const lineRes = [
      new Date().toISOString(),
      context,
      '', '', '', '', '', '', '', '', // rellenamos columnas previas para alinear
      explanation.replace(/\r?\n/g, ' ')
    ].join(',') + '\n';
    try {
      fs.appendFileSync(csvPath, lineRes, 'utf8');
    } catch (e) {
      console.warn('⚠️ No se pudo escribir respuesta en CSV:', e.message);
    }

    // 5) Devolver al front
    return res.json({ explanation });

  } catch (err) {
    console.error('❌ Error en /api/calcula:', err);
    return res.status(500).json({
      error: 'Error interno procesando la petición',
      details: err.message
    });
  }
});

// ── Arranque del servidor ───────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 4000;
app.listen(PORT, () => console.log(`API escuchando en puerto ${PORT}`));
