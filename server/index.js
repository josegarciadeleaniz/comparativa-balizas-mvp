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
Eres un asesor neutral de coste total de propiedad (TCO) de balizas V16 IoT para el mercado español.
Con los datos del usuario, calcula y devuelve:

1. Desglose numérico (formato texto) con valores en euros:
   • Coste inicial de compra.
   • Número estimado de reposiciones de batería en 12 años (usa durabilidad típica: 
     • AA/AAA: vida útil 2-3 años → 4-6 packs.  
     • 9 V: vida útil 1.5-2 años → 6-8 unidades.  
     • Litio: vida útil 15-20 años → 1 unidad). :contentReference[oaicite:0]{index=0}
   • Coste total de baterías (packCost × reposiciones).
   • Coste funda térmica (si aplica; €15).
   • Coste esperado de multas: Probabilidad de fallo (%) × 200 €. 
     • Sin funda ni desconexión: fallo ≈ 32 %.  
     • Con funda: fallo ≈ 12 %.  
     • Con desconexión física + funda: fallo ≈ 9 %. :contentReference[oaicite:1]{index=1}
   • Coste total en 12 años (suma de todos los anteriores).
   • Coste medio mensual (divide el total entre 144 meses).

2. Un breve párrafo que explique:
   - Cómo influyen cada uno de estos componentes en el TCO.
   - Qué recomendaciones generales se derivan del análisis (sin usar lenguaje comparativo “mejor/peor”, sólo hechos).

Formatea la respuesta así:

Coste inicial: X €  
Coste baterías (12 años): Y €  
Coste funda térmica: Z €  
Coste esperado multas: W €  
Coste total (12 años): T €  
Coste medio mensual: M €  

[Breve párrafo explicativo]
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
