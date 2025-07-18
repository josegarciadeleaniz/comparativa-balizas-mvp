require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');

const app = express();

// Permitir CORS solo desde tu front-end
app.use(cors({ origin: 'https://comparativabalizas.es' }));
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Prompt del sistema: devuelve solo JSON
const SYSTEM_PROMPT = `
Eres un analista frío y preciso. Devuélveme *solo* un JSON con estos campos:
  - cambios: número entero (veces que cambiarás pilas)
  - coste_pilas: número (euros)
  - riesgo_fuga: número (porcentaje)
  - coste_multas: número (euros)
  - coste_total: número (euros)
Nada de texto adicional ni comentarios.
`.trim();

app.post('/api/calcula', async (req, res) => {
  const { tipo, marca, desconecta, funda, estacionamiento, provincia, packCost } = req.body;

  // Cálculo de temperaturas según aparcamiento
  const clima = {
    Subterráneo: { verano: 0, invierno: -5 },
    Normal:       { verano: 10, invierno: 0 },
    Calle:        { verano: 20, invierno: -10 }
  };
  const baseTemp     = 20;
  const { verano, invierno } = clima[estacionamiento] || clima.Normal;
  const tVerano      = baseTemp + verano;
  const tInvierno    = baseTemp + invierno;

  const userPrompt = `
Basándote en:
- Tipo de pila: ${tipo}
- Marca: ${marca}
- Autodesconexión: ${desconecta}
- Funda térmica: ${funda}
- Provincia: ${provincia}
- Condiciones de temperatura: verano ${tVerano}°C, invierno ${tInvierno}°C
- Coste por pack de pilas (4 uds): ${packCost}€
Para 12 años de uso, calcula:
1) Número de cambios de pilas
2) Coste total de cambios de pilas
3) Riesgo total de fugas (%)
4) Coste por multas e ITV (€)
Devuélvelo únicamente en formato JSON con campos:
  cambios, coste_pilas, riesgo_fuga, coste_multas, coste_total
`.trim();

  try {
    console.log('Prompt usado:', userPrompt);

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt }
      ]
    });

    const jsonResponse = completion.choices[0].message.content;
    const info = JSON.parse(jsonResponse);
    return res.json(info);

  } catch (err) {
    console.error('Error en /api/calcula:', err);
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`API en puerto ${PORT}`));
