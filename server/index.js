require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const { OpenAI } = require('openai');

const app = express();

// ── Preparar carpeta y archivo CSV ─────────────────────────────────────
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
const csvPath = path.join(dataDir, 'requests.csv');
if (!fs.existsSync(csvPath)) {
  const header = [
    'timestamp','ctx','tipo','marca','desconecta','funda',
    'estacionamiento','provincia','packCost','coste_inicial','anonymous'
  ].join(',') + '\n';
  fs.writeFileSync(csvPath, header);
}

// Configurar CORS y JSON
app.use(cors({ origin: 'https://comparativabalizas.es' }));
app.use(express.json());

// Cliente OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Prompt del sistema: guía informativa de costes sin juicios
const SYSTEM_PROMPT = `
Eres un asesor neutral de coste total de propiedad de balizas IoT.
Genera un solo párrafo claro y profesional que indique:
1) Los factores clave a considerar al evaluar el coste total: calidad de pilas, desconexión de polos, uso de funda térmica, riesgo de fugas y coste de multas por falta de batería.
2) Cómo estos factores impactan en el coste mensual promedio durante 12 años.
3) La fórmula general: suma del coste inicial más costes de mantenimiento, dividido en mensualidades.
No hagas comparaciones de bueno/malo ni recomendaciones específicas, solo explica qué datos debe tener en cuenta el cliente y cómo se calcula el coste medio mensual.
`.trim();

// Ruta raíz para comprobar que el servicio está vivo
app.get('/', (req, res) => {
  res.status(200).send('API Balizas OK');
});

// Health check para evitar cold starts
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.post('/api/calcula', async (req, res) => {
  // <<<<<<<<<<<<<<<<<<<<< Log inicial para verificar llegada
  console.log('🟢 POST /api/calcula recibido con body:', req.body);

  const {
    tipo, marca, desconecta, funda,
    estacionamiento, provincia, packCost,
    coste_inicial = 0, anonymous = true
  } = req.body;

  // Registrar petición en CSV
  const line = [
    new Date().toISOString(), 'api_calcula',
    tipo||'', marca||'', desconecta||'', funda||'',
    estacionamiento||'', provincia||'', packCost||'',
    coste_inicial, anonymous
  ].join(',') + '\n';
  fs.appendFileSync(csvPath, line);

  // Ajuste climático para la guantera
  const clima = {
    Subterráneo: { verano: 0,  invierno: -5 },
    Normal:      { verano: 10, invierno:  0 },
    Calle:       { verano: 20, invierno: -10 }
  };
  const baseTemp       = 20;
  const { verano, invierno } = clima[estacionamiento] || clima.Normal;
  const tVerano        = baseTemp + verano;
  const tInvierno      = baseTemp + invierno;

  // Construir prompt con datos concretos
  const userPrompt = `
Datos recibidos:
- Pilas: tipo ${tipo}, marca ${marca}, desconexión: ${desconecta}, funda: ${funda}
- Provincia: ${provincia}
- Temperaturas en guantera: verano ${tVerano}°C, invierno ${tInvierno}°C
- Coste inicial: ${coste_inicial}€
- Coste por pack de pilas (4 uds): ${packCost}€
Por favor, explica en un párrafo:
- Qué factores considerar para calcular el coste total durante 12 años
- Cómo sumar esos costes de mantenimiento al precio inicial
- Cómo se obtiene el coste medio mensual resultante
`.trim();

  try {
    console.log('SYSTEM_PROMPT:', SYSTEM_PROMPT);
    console.log('USER_PROMPT:', userPrompt);

    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt }
      ]
    });

    const explanation = response.choices[0].message.content.trim();
    return res.json({ explanation });

  } catch (err) {
    console.error('Error en /api/calcula:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Escucha en el puerto definido
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`API en puerto ${PORT}`));
