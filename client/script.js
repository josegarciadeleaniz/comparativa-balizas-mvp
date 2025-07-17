const endpoint = 'https://baliza-api-on-render.onrender.com/api/calcula';

let context = null;

// Elementos
const step0 = document.getElementById('step0');
const formA = document.getElementById('formA');
const formB = document.getElementById('formB');
const formC = document.getElementById('formC');
const resultado = document.getElementById('resultado');

// Paso 0: elegir ruta
step0.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => {
    context = btn.dataset.ctx;
    step0.classList.add('hidden');
    if (context === 'A') formA.classList.remove('hidden');
    if (context === 'B') formB.classList.remove('hidden');
    if (context === 'C') formC.classList.remove('hidden');
  });
});

// Escucha envíos
[formA, formB, formC].forEach(form => {
  form.addEventListener('submit', async e => {
    e.preventDefault();
    // Recoge datos comunes
    const data = { context };
    new FormData(form).forEach((val, key) => data[key] = val);

    // Campos extra según contexto B
    if (context === 'B') {
      // extraer PVP y packCost a partir del modelo
      const pvpMap = { 'v16-standard':30, 'v16-pro':45, 'v16-luxe':60 };
      const packMap = { 'v16-standard':3, 'v16-pro':3, 'v16-luxe':3 };
      data.pvp = pvpMap[data.modelo];
      data.packCost = packMap[data.modelo];
    }

    // Llamada a la API
    resultado.textContent = 'Cargando…';
    resultado.classList.remove('hidden');
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify(data)
      });
      const info = await res.json();
      resultado.textContent = JSON.stringify(info, null, 2);
    } catch (err) {
      resultado.textContent = 'Error al conectar con la API';
      console.error(err);
    }
  });
});
