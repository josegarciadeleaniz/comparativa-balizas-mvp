// prueba para ver si funciona GitHub script.js
// --------------------------------------------------
console.log('🔥 script.js cargado');

async function initApp() {
  console.log('📅 DOM listo - initApp arrancado');

  const endpoint = 'https://comparativa-balizas-mvp.onrender.com/api/calcula';

  // Cargo datos externos
  const [beacons, salesPoints, provincias, batteryTypes] = await Promise.all([
    fetch('beacons.json').then(r => r.json()),
    fetch('sales_points.json').then(r => r.json()),
    fetch('provincias.json').then(r => r.json()),
    fetch('battery_types.json').then(r => r.json())
  ]);
  console.log('✅ JSON cargados: beacons, salesPoints, provincias, batteryTypes');

  // Configuración de riesgo
  const riskConfig = batteryTypes.formulario_pilas.algoritmo_riesgo;
  console.log('📊 Configuración de riesgo:', riskConfig);

  // DOM references
  const choices         = document.querySelectorAll('.choice');
  const formA           = document.getElementById('formA');
  const formB           = document.getElementById('formB');
  const formC           = document.getElementById('formC');
  const backButtons     = document.querySelectorAll('.btn-back');
  const resultado       = document.getElementById('resultado');

  // Form A refs
  const selPilaA        = document.getElementById('selPilaA');
  const selMarcaPilaA   = document.getElementById('selMarcaPilaA');
  const selProvA        = document.getElementById('provincia_A');
  const desconectaA     = document.getElementById('desconexion_interna_A');
  const fundaA          = document.getElementById('funda_termica_A');
  const precioA         = document.querySelector('#formA [name="precio_compra"]');
  const selModeloA      = document.getElementById('selModeloA');
  const loadingA        = document.getElementById('loadingA');
  const errorA          = document.getElementById('errorA');

  // Form B refs
  const selBeacon       = document.getElementById('selectBeacon');
  const previewB        = document.getElementById('previewBeaconB');
  const fabricanteB     = document.getElementById('fabricante_B');
  const origenB         = document.getElementById('origen_B');
  const actuacionB      = document.getElementById('actuacion_B');
  const precioVentaB    = document.getElementById('precio_venta_B');
  const alimentacionB   = document.getElementById('alimentacion_B');
  const marcaPilasB     = document.getElementById('marca_pilas_B');
  const desconectableB  = document.getElementById('desconectable_B');
  const fundaB          = document.getElementById('funda_B');
  const selProvB        = document.getElementById('provincia_B');
  const loadingB        = document.getElementById('loadingB');
  const errorB          = document.getElementById('errorB');

  // Form C refs
  const selTienda       = document.getElementById('selectTienda');
  const selModeloTienda = document.getElementById('selectModeloTienda');
  const previewC        = document.getElementById('previewBeaconC');
  const fabricanteC     = document.getElementById('fabricante_C');
  const origenC         = document.getElementById('origen_C');
  const actuacionC      = document.getElementById('actuacion_C');
  const precioVentaC    = document.getElementById('precio_venta_C');
  const alimentacionC   = document.getElementById('alimentacion_C');
  const marcaPilasC     = document.getElementById('marca_pilas_C');
  const desconectableC  = document.getElementById('desconectable_C');
  const fundaC          = document.getElementById('funda_C');
  const fuenteC         = document.getElementById('fuente_C');
  const selProvC        = document.getElementById('provincia_C');
  const loadingC        = document.getElementById('loadingC');
  const errorC          = document.getElementById('errorC');

  let context = null;

  // Poblado de provincias
  provincias.forEach(p => {
    [selProvA, selProvB, selProvC].forEach(sel => sel.add(new Option(p, p)));
  });

  // Form A: opciones de pilas, marcas y modelo opcional
  batteryTypes.formulario_pilas.secciones[0].preguntas[0].opciones
    .forEach(o => selPilaA.add(new Option(o, o)));
  batteryTypes.formulario_pilas.secciones[1].preguntas[0].opciones
    .forEach(o => selMarcaPilaA.add(new Option(o, o)));
  // modelo opcional: lista todas las balizas
  beacons.forEach(b => {
    selModeloA.add(new Option(
      `${b.marca_baliza} – ${b.modelo}`,
      b.id_baliza
    ));
  });

  // Form B: cargar todas las balizas en un único select
  selBeacon.innerHTML = '<option value="" disabled selected>-- Selecciona baliza --</option>';
  beacons.forEach(b => {
    selBeacon.add(new Option(
      `${b.marca_baliza} – ${b.modelo}`,
      b.id_baliza
    ));
  });
  // Listener B: al cambiar, mostrar ficha
  selBeacon.addEventListener('change', () => {
    const b = beacons.find(x => x.id_baliza == selBeacon.value);
    if (!b) return;
    previewB.src         = `images/beacons/${b.imagen}`;
    fabricanteB.value    = b.Fabricante;
    origenB.value        = b.Origen;
    actuacionB.value     = b.Actuación_realizada_en_España;
    precioVentaB.value   = b.precio_venta;
    alimentacionB.value  = b.alimentacion;
    marcaPilasB.value    = b.marca_pilas;
    desconectableB.value = b.desconectable;
    fundaB.value         = b.funda;
  });

  // Form C: opciones de tiendas y tienda→modelo
  [...new Set(salesPoints.map(s => s.nombre_punto))]
    .forEach(name => selTienda.add(new Option(name, name)));
  selTienda.addEventListener('change', () => {
    selModeloTienda.innerHTML = '<option value="" disabled selected>-- Selecciona baliza --</option>';
    const items = salesPoints.filter(s => s.nombre_punto === selTienda.value);
    items.forEach((s, i) => selModeloTienda.add(new Option(`${s.marca_baliza} – ${s.modelo}`, i)));
    selModeloTienda.disabled = false;
  });
  selModeloTienda.addEventListener('change', () => {
    const items = salesPoints.filter(s => s.nombre_punto === selTienda.value);
    const sp = items[selModeloTienda.value];
    if (!sp) return;
    previewC.src         = `images/beacons/${sp.imagen}`;
    fabricanteC.value    = sp.Fabricante;
    origenC.value        = sp.Origen;
    actuacionC.value     = sp.Actuación_realizada_en_España;
    precioVentaC.value   = sp.precio_venta;
    alimentacionC.value  = sp.alimentacion;
    marcaPilasC.value    = sp.marca_pilas;
    desconectableC.value = sp.desconectable;
    fundaC.value         = sp.funda;
    fuenteC.value        = sp.fuente_oficial;
  });

  // Navegación entre formularios
  choices.forEach(choice => choice.addEventListener('click', () => {
    choices.forEach(c => c.classList.remove('selected'));
    choice.classList.add('selected');
    context = choice.dataset.ctx;
    [formA, formB, formC].forEach(f => f.classList.remove('active'));
    if (context === 'A') formA.classList.add('active');
    if (context === 'B') formB.classList.add('active');
    if (context === 'C') formC.classList.add('active');
    resultado.textContent = '';
  }));
  backButtons.forEach(btn => btn.addEventListener('click', () => {
    [formA, formB, formC].forEach(f => f.classList.remove('active'));
    choices.forEach(c => c.classList.remove('selected'));
    context = null;
    resultado.textContent = '';
  }));

  // Envío común a OpenAI
  async function submitForm(form) {
    const data = { context, anonymous: true };
    new FormData(form).forEach((v, k) => data[k] = v);

    if (context === 'A') {
      data.tipo_pila     = data.selPilaA;
      data.marca_pila    = data.selMarcaPilaA;
      data.provincia     = data.provincia;
      data.precio_compra = parseFloat(data['precio_compra']) || 0;
      data.modelo_compra = data.selModeloA || '';
    }
    if (context === 'B') {
      data.modelo    = selBeacon.value;
      data.provincia = data.provincia;
    }
    if (context === 'C') {
      data.tienda        = selTienda.value;
      data.modelo_tienda = selModeloTienda.value;
      data.provincia     = data.provincia;
    }

    console.log('Enviando a OpenAI:', data);
    resultado.textContent = '';
    if (context==='A') loadingA.style.display='inline';
    if (context==='B') loadingB.style.display='inline';
    if (context==='C') loadingC.style.display='inline';

    try {
      const res = await fetch(endpoint, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(data)
      });
      const json = await res.json();
      console.log('✅ OpenAI respondió:', json);
      resultado.textContent = json.explanation || JSON.stringify(json, null,2);
    } catch(err) {
      console.error(err);
      resultado.textContent = '❌ Error al conectar con la API';
    } finally {
      loadingA.style.display='none';
      loadingB.style.display='none';
      loadingC.style.display='none';
    }
  }

  // Attach submit handlers
  formA.addEventListener('submit', e => { e.preventDefault(); submitForm(formA); });
  formB.addEventListener('submit', e => { e.preventDefault(); submitForm(formB); });
  formC.addEventListener('submit', e => { e.preventDefault(); submitForm(formC); });
}

document.addEventListener('DOMContentLoaded', initApp);
// TEST COMMIT
