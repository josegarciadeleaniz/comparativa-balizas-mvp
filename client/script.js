// script.js
// --------------------------------------------------
console.log('🔥 script.js cargado');

async function initApp() {
  console.log('📅 DOM listo - initApp arrancado');
  const endpoint = 'https://comparativa-balizas-mvp.onrender.com/api/calcula';

  // Función auxiliar para leer valores con fallback
  function getVal(id, fallback = '') {
    const el = document.getElementById(id);
    return el ? el.value : fallback;
  }

  // Mapa de costes de packs
  const packCosts = {
    '3x AA': 4 * 0.50,
    '3x AAA': 4 * 0.50,
    '9 V': 2.00,
    'Litio': 5.00,
    'NiMH LSD': 3.50
  };

  // 1) Cargo datos
  const [beacons, salesPoints, provincias, batteryTypes] = await Promise.all([
    fetch('beacons.json').then(r => r.json()),
    fetch('sales_points.json').then(r => r.json()),
    fetch('provincias.json').then(r => r.json()),
    fetch('battery_types.json').then(r => r.json())
  ]);
  console.log('✅ Datos cargados');

  // 2) Referencias DOM
  const tabs       = document.querySelectorAll('.choice');
  const formA      = document.getElementById('formA');
  const formB      = document.getElementById('formB');
  const formC      = document.getElementById('formC');
  const resultado  = document.getElementById('resultado');

  // Form A refs
  const selPilaA      = document.getElementById('selPilaA');
  const selMarcaPilaA = document.getElementById('selMarcaPilaA');
  const selProvA      = document.getElementById('provincia_A');
  const desconectaA   = document.getElementById('desconexion_interna_A');
  const fundaA        = document.getElementById('funda_termica_A');
  const precioA       = document.getElementById('precio_compra_A');
  const selModeloA    = document.getElementById('selModeloA');
  const carAgeA       = document.getElementById('car_age_A');

  // Form B refs
  const selBeacon     = document.getElementById('selectBeacon');
  const selProvB      = document.getElementById('provincia_B');
  const carAgeB       = document.getElementById('car_age_B');

  // Form C refs
  const selTienda        = document.getElementById('selectTienda');
  const selModeloTienda  = document.getElementById('selectModeloTienda');
  const selProvC         = document.getElementById('provincia_C');
  const carAgeC          = document.getElementById('car_age_C');

  // Poblado de provincias
  provincias.forEach(p => {
    selProvA.add(new Option(p, p));
    selProvB.add(new Option(p, p));
    selProvC.add(new Option(p, p));
  });

  // Poblado Form A: pilas y modelo
  batteryTypes.formulario_pilas.secciones[0].preguntas[0].opciones
    .forEach(o => selPilaA.add(new Option(o, o)));
  batteryTypes.formulario_pilas.secciones[1].preguntas[0].opciones
    .forEach(o => selMarcaPilaA.add(new Option(o, o)));
  beacons.forEach(b => {
    selModeloA.add(new Option(`${b.marca_baliza} – ${b.modelo}`, b.id_baliza));
  });

  // Poblado Form B: balizas
  selBeacon.innerHTML = '<option value="" disabled selected>-- Selecciona --</option>';
  beacons.forEach(b => selBeacon.add(new Option(`${b.marca_baliza} – ${b.modelo}`, b.id_baliza)));

  // Poblado Form C: tiendas y modelos
  [...new Set(salesPoints.map(s => s.nombre_punto))]
    .forEach(name => selTienda.add(new Option(name, name)));
  selTienda.addEventListener('change', () => {
    selModeloTienda.innerHTML = '<option value="" disabled selected>-- Selecciona --</option>';
    const items = salesPoints.filter(s => s.nombre_punto === selTienda.value);
    items.forEach((s, i) => selModeloTienda.add(new Option(`${s.marca_baliza} – ${s.modelo}`, i)));
    selModeloTienda.disabled = false;
  });

  // Función común de envío
  async function submit() {
    let data = { context: document.querySelector('.choice.selected').dataset.ctx };
    let carAge = 0;

    if (data.context === 'A') {
      carAge = parseFloat(carAgeA.value) || 0;
      data = {
        ...data,
        tipo_pila:          selPilaA.value,
        marca_pila:         selMarcaPilaA.value,
        desconexion_polos:  desconectaA.value,
        proteccion_termica: fundaA.value,
        provincia:          selProvA.value,
        precio_inicial:     parseFloat(precioA.value) || 0,
        modelo_compra:      selModeloA.value || '',
        packCost:           packCosts[selPilaA.value] || 0,
        car_age:            carAge
      };
    } else if (data.context === 'B') {
      carAge = parseFloat(carAgeB.value) || 0;
      data = {
        ...data,
        modelo:     selBeacon.value,
        provincia:  selProvB.value,
        car_age:    carAge
      };
    } else if (data.context === 'C') {
      carAge = parseFloat(carAgeC.value) || 0;
      data = {
        ...data,
        tienda:        selTienda.value,
        modelo_tienda: selModeloTienda.value,
        provincia:     selProvC.value,
        car_age:       carAge
      };
    }

    console.log('Enviando a OpenAI:', data);
    // Mostrar resultados
    document.getElementById('results').style.display = 'block';

    try {
      const res  = await fetch(endpoint, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(data)
      });
      const json = await res.json();
      console.log('✅ OpenAI respondió:', json);

      // Rellenar tabla
      document.getElementById('res_initialCost').textContent  = json.initialCost + ' €';
      document.getElementById('res_reps').textContent         = json.batteryReps;
      document.getElementById('res_batteryCost').textContent  = json.batteryCost + ' €';
      document.getElementById('res_caseCost').textContent     = json.caseCost + ' €';
      document.getElementById('res_leakCost').textContent     = json.leakCost + ' €';
      document.getElementById('res_fineCost').textContent     = json.fineCost + ' €';
      document.getElementById('res_totalCost12y').textContent = json.totalCost12y + ' €';
      document.getElementById('res_monthlyCost').textContent  = json.monthlyCost + ' €';
      document.getElementById('res_qualitative').textContent  = json.qualitative;

    } catch (err) {
      console.error(err);
      resultado.textContent = '❌ Error al conectar con la API';
    }
  }

  // Attach handlers
  formA.addEventListener('submit', e => { e.preventDefault(); submit(); });
  formB.addEventListener('submit', e => { e.preventDefault(); submit(); });
  formC.addEventListener('submit', e => { e.preventDefault(); submit(); });
}

// Inicializar
document.addEventListener('DOMContentLoaded', initApp);
