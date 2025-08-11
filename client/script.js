// script.js – Versión limpia y funcional
console.log('🔥 script.js cargado');

let beacons, salesPoints, provincias, batteryTypes;
const endpoint       = 'http://localhost:3003/api/calcula';
const imagesBasePath = '/images/beacons/';

let batteryData;
fetch('/api/battery_types')    // sin punto y coma aquí
  .then(r => {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  })
  .then(json => batteryData = json)
  .catch(err => console.error(err));

let selectedBeaconA = null; // solo para “Datos seleccionados” en Form A


// — Helpers —
function formatEuros(x) {
  return '€' + Number(x || 0).toFixed(2).replace('.', ',');
}

function formatNumber(n) {
  return Number(n || 0).toFixed(2).replace('.', ',');
}
// Opciones base
const TIPOS_PILA  = ['3x AA', '3x AAA', '4x AAA', '1x 9V'];
const MARCAS_PILA = ['Duracell', 'Energizer', 'Varta', 'Maxell', 'Marca Blanca', 'Sin marca'];

// Utilidad para rellenar un <select>
function fillSelect(select, options, placeholder) {
  if (!select) return;
  select.innerHTML = ''; // limpia
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = placeholder;
  opt0.disabled = true;
  opt0.selected = true;
  select.appendChild(opt0);

  options.forEach(v => {
    const op = document.createElement('option');
    op.value = v;
    op.textContent = v;
    select.appendChild(op);
  });
}


// — Toggle detalles completos —
function handleToggleDetails(e) {
  const toggle = e.target.closest('.toggle-details');
  if (!toggle) return;
  const content = toggle.nextElementSibling;
  if (!content) return;
  const show = content.style.display === 'none';
  content.style.display = show ? 'block' : 'none';
  toggle.textContent = show
    ? '▲ Ocultar detalles de cálculo'
    : '▼ Detalles completos de los cálculos';
  if (show) content.scrollIntoView({ behavior: 'smooth' });
}

// — Actualiza los campos de detalle en A/B/C —
function updateDetails(item, prefix) {
  if (!item) return;
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.value = v ?? '';
  };
  set(`fabricante_${prefix}`, item.Fabricante);
  set(`origen_${prefix}`,     item.Origen);
  set(`actuacion_${prefix}`,  item.Actuación_realizada_en_España);
  set(`precio_venta_${prefix}`, item.precio_venta?.toFixed(2) + ' €');
  set(`alimentacion_${prefix}`, item.alimentacion);
  set(`marca_pilas_${prefix}`,
      item.marca_pilas === 'Marca Blanca' ? 'Marca blanca' : item.marca_pilas || 'Sin marca');
  set(`desconectable_${prefix}`,
      item.desconectable === 'Si' ? 'Sí' : 'No');
  set(`funda_termica_${prefix}`, item.funda_termica || 'No');

  const img = document.getElementById(`previewBeacon${prefix}`);
  if (img) {
    img.style.display = 'none';
    if (item.imagen) {
      img.onerror = () => img.style.display = 'none';
      img.src = imagesBasePath + item.imagen;
      img.style.display = 'block';
    }
  }
}
// — Muestra resultados tras el cálculo —
function showResults(data, json) {
  window.lastCalculationData = { data, json };
  const results = document.getElementById('results');
  results.innerHTML = '';
  results.style.display = 'block';
  const ctx = document.querySelector('.choice.selected').dataset.ctx;

  // 1) DATOS SELECCIONADOS
  const sel = document.createElement('div');
  sel.className = 'selected-data-container';
  // Cabecera
  const stripe = document.createElement('div');
  stripe.className = 'header-stripe';
  stripe.textContent = 'Datos Seleccionados';
  sel.appendChild(stripe);
  // Cuerpo
  const body = document.createElement('div');
  body.className = 'body-data';
  const ul = document.createElement('ul');
  ul.className = 'meta-list';
  [
  { label: 'Baliza',
    value: `${data.marca_baliza || ''} ${data.modelo || ''}`.trim() },
  { label: 'Fabricante',
    value: data.fabricante || document.getElementById(`fabricante_${ctx}`)?.value || '–' },
  { label: 'Origen',
    value: data.origen || document.getElementById(`origen_${ctx}`)?.value || '–' },
  { label: 'Actuación en España',
    value: data.actuacion_espana || document.getElementById(`actuacion_${ctx}`)?.value || '–' },
  { label: 'Provincia donde residirá su coche:',
    value: data.provincia || '–' },
  { label: 'Antigüedad de su coche',
    value: `${data.edad_vehiculo || 0} años` }
].forEach(f => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${f.label}</span><span>${f.value}</span>`;
    ul.appendChild(li);
  });
  body.appendChild(ul);
if (ctx === 'A' && data.imagen_url) {
  const divImg = document.createElement('div');
  divImg.className = 'result-image';
  const img = document.createElement('img');
  img.src = data.imagen_url;
  img.alt = `Foto de ${data.modelo || ''}`;
  img.onerror = () => img.style.display = 'none';
  divImg.appendChild(img);
  body.appendChild(divImg);
}
// Imagen (solo B/C)
  if (ctx === 'B' || ctx === 'C') {
    const divImg = document.createElement('div');
    divImg.className = 'result-image';
    const img = document.createElement('img');
    img.src = document.getElementById(`previewBeacon${ctx}`).src;
    img.alt = `Foto de ${data.modelo || ''}`;
    img.onerror = () => img.style.display = 'none';
    divImg.appendChild(img);
    body.appendChild(divImg);
  }

  sel.appendChild(body);
  results.appendChild(sel);

// 2) HIGHLIGHTS
const highlights = document.createElement('div');
highlights.className = 'highlights-container';

// Valores seguros (con fallback)
const r = json?.resumen ?? {};
const purchase = Number(data?.coste_inicial ?? 0);

const pilas12  = Number(r.coste_pilas ?? 0); // ya es a 12 años
const fugas12  = Number(r.coste_fugas_12 ?? ((r.coste_fugas ?? 0) * 12));
const multas12 = Number(r.coste_multas_12 ?? ((r.coste_multas ?? 0) * 12));

console.log('pilas12=', pilas12, 'fugas12=', fugas12, 'multas12=', multas12);
const maintenance = pilas12 + fugas12 + multas12;
const totalCost   = purchase + maintenance;
const avgValue    = maintenance / 12;

[
  { label: 'Precio de compra de su baliza actual', value: formatEuros(purchase) },
  { label: 'Gasto previsto de mantenimiento de su baliza durante los próximos 12 años', value: formatEuros(maintenance) },
  { label: `Gasto total de compra y mantenimiento de su baliza "${data.marca_baliza} ${data.modelo}" durante los próximos 12 años`, value: formatEuros(totalCost) },
].forEach(h => {
  const row = document.createElement('div');
  row.className = 'highlight-row';
  row.innerHTML = `<div class="label">${h.label}</div><div class="value">${h.value}</div>`;
  highlights.appendChild(row);
});

results.appendChild(highlights);

// 3) GASTO MEDIO ANUAL
const avg = document.createElement('div');
avg.className = 'average-cost';
avg.innerHTML = `
  <div class="label">
    Gasto medio anual estimado<br>
    <small>por mantenimiento los próximos 12 años</small>
  </div>
  <div class="value">${formatEuros(avgValue)}</div>
`;
results.appendChild(avg);

 // 4) DETALLES COLAPSABLES
if (json.htmlTable) {
  const tmp = document.createElement('div');
  tmp.innerHTML = json.htmlTable;
  const calcTable = tmp.querySelector('table.calculation-table');
  if (calcTable) {
    const det = document.createElement('div');
    det.className = 'detailed-section';
    det.innerHTML = `
      <h3 class="toggle-details">▼ Detalles completos de los cálculos</h3>
      <div class="details-content" style="display:none;"></div>
    `;
    det.querySelector('.details-content').appendChild(calcTable);
    results.appendChild(det);

    // Manejo del toggle (AÑADIDO)
    det.querySelector('.toggle-details').addEventListener('click', function() {
      const content = this.nextElementSibling;
      const isHidden = content.style.display === 'none';
      content.style.display = isHidden ? 'block' : 'none';
      this.textContent = isHidden 
        ? '▲ Ocultar detalles de cálculo' 
        : '▼ Detalles completos de los cálculos';
      
      // Scroll suave al mostrar (opcional)
      if (isHidden) {
        content.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
const validRows = Array.from(det.querySelectorAll('table.calculation-table tr'))
  .filter(tr => tr.cells?.length > 0 && tr.cells[0]); // Filtramos solo filas válidas

validRows.forEach(tr => {
  const firstCellText = tr.cells[0].textContent.toLowerCase();
  
  // Aplicamos clases condicionalmente en una sola operación
  tr.classList.toggle('row-reposiciones', firstCellText.includes('reposiciones'));
  
  tr.classList.toggle('row-fondo-azul', [
    'coste total estimado por cambio de pilas',
    'coste de fugas',
    'coste de multas'
  ].some(term => firstCellText.includes(term)));
});

    }
  }
} // <-- Cierra showResults()

async function handleSubmit() {
  let data;

  // 1. Determinar contexto y recoger valores comunes
  const ctx   = document.querySelector('.choice.selected').dataset.ctx;
  const prov  = document.getElementById(`provincia_${ctx}`).value;
  const edad  = +document.getElementById(`car_age_${ctx}`).value || 0;

  // 2. Construir payload según Form A, B o C
if (ctx === 'A') {
  const idSel = parseInt(document.getElementById('selModeloA')?.value || '', 10);
  const beaconSel = Number.isFinite(idSel) ? beacons.find(x => x.id_baliza === idSel) : null;

  data = {
    tipo:          document.getElementById('selPilaA').value,
    marca:         document.getElementById('selMarcaPilaA').value,
    desconectable: document.getElementById('desconexion_interna_A').value,
    funda:         document.getElementById('funda_termica_A').value,
    provincia:     prov,
    coste_inicial: +document.getElementById('precio_compra_A').value || 0,
    edad_vehiculo: edad,
    // SOLO para que el servidor pueda “pintar” fabricante/origen/actuación si eligieron modelo
    modelo_compra: idSel || '',
    // Metadatos opcionales (NO pisan lo que el usuario metió en el form)
    ...(beaconSel && {
      id_baliza:        beaconSel.id_baliza,
      marca_baliza:     beaconSel.marca_baliza,
      modelo:           beaconSel.modelo,
      fabricante:       beaconSel.Fabricante,
      origen:           beaconSel.Origen,
      actuacion_espana: beaconSel.Actuación_realizada_en_España,
      imagen_url:       beaconSel.imagen ? (imagesBasePath + beaconSel.imagen) : ''
    })
  };
}

else {
    // Forms B o C
    const sel = ctx === 'B'
      ? document.getElementById('selectBeacon')
      : document.getElementById('selectModeloTienda');
    const arr = ctx === 'B'
      ? beacons
      : salesPoints.filter(s => s.nombre_punto === document.getElementById('selectTienda').value);
    const b = ctx === 'B'
      ? beacons.find(x => x.id_baliza == sel.value)
      : arr[sel.selectedIndex - 1];
    if (!b) {
      alert('Selecciona una baliza válida');
      return;
    }
 data = {
      // Contexto B: envío id_baliza
      ...(ctx === 'B' && { id_baliza: b.id_baliza }),
      // Contexto C: envío id_sales_point
      ...(ctx === 'C' && { id_sales_point: b.id_punto }),
      marca_baliza:   b.marca_baliza,
      fabricante:     b.Fabricante,
      modelo:         b.modelo,
      tipo:           b.alimentacion,
      marca:          b.marca_pilas || 'Sin marca',
      origen:         b.Origen,
      actuacion:      b.Actuación_realizada_en_España,
      desconectable:  b.desconectable,
      funda:          b.funda_termica,
      provincia:      prov,
      coste_inicial:  b.precio_venta || 0,
      edad_vehiculo:  edad,
      numero_pilas:   b.numero_pilas,
      precio_por_pila:b.precio_por_pila
    };
  }

  console.log("Payload de /api/calcula:", data);

  // 3. Llamada única y gestión de respuesta
  try {
    const res = await fetch(endpoint, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();

    // 4. Invocar showResults para pintar TODO
    showResults(data, json);

  } catch (err) {
    console.error("Error en envío:", err);
    alert("Ha ocurrido un error: " + err.message);
  }
}
// — Inicialización —  
// preventDefault en el listener, no dentro de handleSubmit
['formA', 'formB', 'formC'].forEach(id => {
  document.getElementById(id).addEventListener('submit', e => {
    e.preventDefault();
    handleSubmit();
  });
});

async function initApp() {
  console.log('📅 DOM listo - initApp arrancado');
  [beacons, salesPoints, provincias, batteryTypes] = await Promise.all([
    fetch('/api/beacons').then(r => r.json()),
    fetch('/api/sales_points').then(r => r.json()),
    fetch('/api/provincias').then(r => r.json()),
    fetch('/api/battery_types').then(r => r.json())
  ]);
window.BEACONS = beacons;

  // Referencias
  const selA  = document.getElementById('selPilaA'),
        selMA = document.getElementById('selMarcaPilaA'),
        selMdA= document.getElementById('selModeloA'),
        selB  = document.getElementById('selectBeacon'),
        selT  = document.getElementById('selectTienda'),
        selMdT= document.getElementById('selectModeloTienda');

  // Form A: provincias y pilas
  provincias.forEach(p => ['A','B','C'].forEach(ctx => {
    const s = document.getElementById(`provincia_${ctx}`);
    if (s) s.add(new Option(p.provincia, p.provincia));
  }));
// Rellenar selects de tipo y marca
const selTipo  = document.getElementById('tipo_pila');
const selMarca = document.getElementById('marca_pilas');
fillSelect(selTipo,  TIPOS_PILA,  '— Selecciona tipo de pila —');
fillSelect(selMarca, MARCAS_PILA, '— Selecciona marca de pilas —');

// Si eliges una baliza en el Formulario A, precargamos tipo/marca si existen en el JSON
const selBaliza = document.getElementById('select-baliza'); // usa el id real de tu select de baliza
if (selBaliza) {
  selBaliza.addEventListener('change', async () => {
    const id = parseInt(selBaliza.value, 10);
    if (!id) return;
    // Intenta usar caché global si ya tienes; si no, trae /api/beacons al vuelo
    let beaconsList = window.BEACONS;
    if (!Array.isArray(beaconsList)) {
      try {
        const r = await fetch('/api/beacons');
        beaconsList = await r.json();
        window.BEACONS = beaconsList;
      } catch { beaconsList = []; }
    }
    const b = beaconsList.find(x => x.id_baliza === id);
    if (b) {
      // Precarga tipo/marca si vienen informados en el JSON
      if (b.tipo && selTipo)  selTipo.value  = b.tipo;
      if (b.marca_pilas && selMarca) selMarca.value = b.marca_pilas;
    }
  });
}
  if (batteryTypes.formulario_pilas) {
    selA.innerHTML  = '<option disabled selected>-- Selecciona tipo de pila --</option>';
    selMA.innerHTML = '<option disabled selected>-- Selecciona marca de pila --</option>';
    batteryTypes.formulario_pilas.secciones[0].preguntas[0].opciones
      .forEach(o => selA.add(new Option(o,o)));
    batteryTypes.formulario_pilas.secciones[1].preguntas[0].opciones
      .forEach(o => selMA.add(new Option(o,o)));
  }
  if (selMdA) {
    selMdA.innerHTML = '<option value="">— opcional —</option>';
    beacons.forEach(b => selMdA.add(new Option(`${b.marca_baliza} – ${b.modelo}`, b.id_baliza)));
    selMdA.addEventListener('change', () => {
      const b = beacons.find(x => x.id_baliza == selMdA.value);
      if (b) updateDetails(b,'A');
    });
  }

  // Form B: balizas
  if (selB) {
    selB.innerHTML = '<option disabled selected>-- Selecciona baliza --</option>';
    beacons.forEach(b => selB.add(new Option(`${b.marca_baliza} - ${b.modelo}`, b.id_baliza)));
    selB.addEventListener('change', () => {
      const b = beacons.find(x=>x.id_baliza==selB.value);
      if (b) updateDetails(b,'B');
    });
  }

  // Form C: tiendas
  if (selT) {
    selT.innerHTML = '<option disabled selected>-- Selecciona tienda --</option>';
    Array.from(new Set(salesPoints.map(s=>s.nombre_punto)))
      .forEach(n => selT.add(new Option(n,n)));
    selT.addEventListener('change', () => {
      selMdT.disabled = false;
      selMdT.innerHTML = '<option disabled selected>-- Selecciona modelo --</option>';
      salesPoints.filter(s => s.nombre_punto===selT.value)
        .forEach((m,i)=> selMdT.add(new Option(`${m.marca_baliza} - ${m.modelo}`, i)));
    });
    selMdT.addEventListener('change', () => {
      const arr = salesPoints.filter(s=>s.nombre_punto===selT.value);
      const c = arr[selMdT.selectedIndex - 1];
      if (c) updateDetails(c,'C');
    });
  }

  document.querySelectorAll('.choice').forEach(ch => ch.addEventListener('click', function(){
    document.querySelectorAll('.choice').forEach(x=>x.classList.remove('selected'));
    this.classList.add('selected');
    document.querySelectorAll('form').forEach(f=>f.classList.remove('active'));
    document.getElementById(`form${this.dataset.ctx}`).classList.add('active');
    document.getElementById('results').style.display = 'none';
  }));
  document.querySelectorAll('.btn-back').forEach(b=>{
    b.addEventListener('click', ()=>{
      document.querySelectorAll('.choice').forEach(x=>x.classList.remove('selected'));
      document.querySelectorAll('form').forEach(f=>f.classList.remove('active'));
      document.getElementById('results').style.display = 'none';
    });
  });
}

document.addEventListener('DOMContentLoaded', initApp);
