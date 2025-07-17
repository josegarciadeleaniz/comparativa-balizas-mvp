require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.post('/api/calcula', async (req, res) => {
  const { tipo, marca, desconecta, funda, estacionamiento, provincia, packCost } = req.body;
  const clima = {
    Subterráneo: { verano: 0, invierno: -5 },
    Normal:       { verano: 10, invierno: 0 },
    Calle:        { verano: 20, invierno: -10 }
  };
  const baseTemp = 20;
  const { verano, invierno } = clima[estacionamiento];
  const tVerano = baseTemp + verano;
  const tInvierno = baseTemp + invierno;

  const prompt = `
Basándote en:
- Tipo de pila: ${tipo}
- Marca: ${marca}
- Autodesconexión: ${desconecta}
- Funda térmica: ${funda}
- Condiciones: veranos a ${tVerano}°C, inviernos a ${tInvierno}°C
- Pack cost por 4 pilas: ${packCost}€
Para 12 años, calcula:
A) Nº de cambios de pilas
B) Coste aproximado de cambios
C) Riesgo acumulado de fuga (%)
D) Coste por multas e ITV (€)
Devuélvelo en JSON con campos: cambios, coste_pilas, riesgo_fuga, coste_multas.
  `.trim();

  try {
    const completion = await openai.createChatCompletion({
      model: 'gpt-4-turbo',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0
    });
    const info = JSON.parse(completion.data.choices[0].message.content);
    res.json(info);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error con ChatGPT' });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`API en puerto ${PORT}`));
