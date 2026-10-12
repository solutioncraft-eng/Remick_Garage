// Common US makes and models for the booking form's dropdowns. Add to this list freely.
const VEHICLES = {
  'Acura': ['ILX', 'Integra', 'MDX', 'RDX', 'RSX', 'TL', 'TLX', 'TSX'],
  'Audi': ['A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'Q3', 'Q5', 'Q7', 'Q8', 'TT'],
  'BMW': ['2 Series', '3 Series', '4 Series', '5 Series', '7 Series', 'X1', 'X3', 'X5', 'X6', 'Z4'],
  'Buick': ['Enclave', 'Encore', 'Envision', 'LaCrosse', 'Lucerne', 'Regal', 'Verano'],
  'Cadillac': ['ATS', 'CTS', 'Escalade', 'SRX', 'XT4', 'XT5', 'XTS'],
  'Chevrolet': ['Blazer', 'Camaro', 'Colorado', 'Corvette', 'Cruze', 'Equinox', 'Impala', 'Malibu', 'Silverado 1500', 'Silverado 2500', 'Sonic', 'Spark', 'Suburban', 'Tahoe', 'Traverse', 'Trax'],
  'Chrysler': ['200', '300', 'Pacifica', 'PT Cruiser', 'Sebring', 'Town & Country'],
  'Dodge': ['Avenger', 'Caliber', 'Challenger', 'Charger', 'Dakota', 'Durango', 'Grand Caravan', 'Journey', 'Neon', 'Ram 1500'],
  'Fiat': ['500', '500X'],
  'Ford': ['Bronco', 'EcoSport', 'Edge', 'Escape', 'Expedition', 'Explorer', 'F-150', 'F-250', 'F-350', 'Fiesta', 'Focus', 'Fusion', 'Mustang', 'Ranger', 'Taurus', 'Transit'],
  'GMC': ['Acadia', 'Canyon', 'Sierra 1500', 'Sierra 2500', 'Terrain', 'Yukon'],
  'Honda': ['Accord', 'Civic', 'CR-V', 'Fit', 'HR-V', 'Insight', 'Odyssey', 'Passport', 'Pilot', 'Ridgeline'],
  'Hyundai': ['Accent', 'Elantra', 'Kona', 'Palisade', 'Santa Fe', 'Sonata', 'Tucson', 'Veloster'],
  'Infiniti': ['G35', 'Q50', 'QX50', 'QX60', 'QX80'],
  'Jaguar': ['F-Pace', 'XE', 'XF', 'XJ'],
  'Jeep': ['Cherokee', 'Compass', 'Gladiator', 'Grand Cherokee', 'Liberty', 'Patriot', 'Renegade', 'Wrangler'],
  'Kia': ['Forte', 'Optima', 'Rio', 'Seltos', 'Sorento', 'Soul', 'Sportage', 'Stinger', 'Telluride'],
  'Land Rover': ['Defender', 'Discovery', 'Range Rover', 'Range Rover Sport'],
  'Lexus': ['ES', 'GS', 'GX', 'IS', 'LX', 'NX', 'RX'],
  'Lincoln': ['Aviator', 'Corsair', 'MKZ', 'Navigator', 'Town Car'],
  'Mazda': ['CX-3', 'CX-30', 'CX-5', 'CX-9', 'Mazda3', 'Mazda5', 'Mazda6', 'MX-5 Miata'],
  'Mercedes-Benz': ['A-Class', 'C-Class', 'CLA', 'E-Class', 'GLA', 'GLC', 'GLE', 'S-Class'],
  'Mercury': ['Grand Marquis', 'Mariner', 'Milan', 'Sable'],
  'Mini': ['Clubman', 'Cooper', 'Countryman'],
  'Mitsubishi': ['Eclipse Cross', 'Lancer', 'Mirage', 'Outlander', 'Outlander Sport'],
  'Nissan': ['Altima', 'Armada', 'Frontier', 'Juke', 'Kicks', 'Leaf', 'Maxima', 'Murano', 'Pathfinder', 'Rogue', 'Sentra', 'Titan', 'Versa'],
  'Oldsmobile': ['Alero', 'Silhouette'],
  'Plymouth': ['Neon'],
  'Pontiac': ['G6', 'Grand Am', 'Grand Prix', 'Sunfire', 'Vibe'],
  'Porsche': ['911', 'Cayenne', 'Macan', 'Panamera'],
  'Ram': ['1500', '2500', '3500', 'ProMaster'],
  'Saturn': ['Ion', 'Outlook', 'Vue'],
  'Scion': ['FR-S', 'tC', 'xB'],
  'Subaru': ['Ascent', 'BRZ', 'Crosstrek', 'Forester', 'Impreza', 'Legacy', 'Outback', 'WRX'],
  'Suzuki': ['Grand Vitara', 'SX4'],
  'Tesla': ['Model 3', 'Model S', 'Model X', 'Model Y'],
  'Toyota': ['4Runner', 'Avalon', 'Camry', 'Corolla', 'Highlander', 'Land Cruiser', 'Prius', 'RAV4', 'Sequoia', 'Sienna', 'Tacoma', 'Tundra', 'Venza', 'Yaris'],
  'Volkswagen': ['Atlas', 'Beetle', 'Golf', 'GTI', 'Jetta', 'Passat', 'Tiguan'],
  'Volvo': ['S60', 'S80', 'S90', 'V70', 'XC40', 'XC60', 'XC90'],
};

// Dropdown that opens on click/focus, filters as you type, and still accepts typed-in values.
function combo(input, getOptions) {
  const list = document.createElement('ul');
  list.className = 'combo-list'; list.setAttribute('role', 'listbox'); list.hidden = true;
  input.parentNode.classList.add('combo');
  input.after(list);
  input.autocomplete = 'off';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  let items = [], active = -1;

  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const choose = v => { input.value = v; close(); input.dispatchEvent(new Event('change', { bubbles: true })); };
  const mark = () => [...list.children].forEach((li, i) => {
    li.classList.toggle('active', i === active);
    if (i === active) li.scrollIntoView({ block: 'nearest' });
  });
  function open() {
    const all = getOptions(), v = input.value.trim().toLowerCase();
    const exact = all.some(o => o.toLowerCase() === v);
    items = v && !exact ? all.filter(o => o.toLowerCase().includes(v)) : all;
    list.innerHTML = '';
    for (const o of items) {
      const li = document.createElement('li');
      li.setAttribute('role', 'option'); li.textContent = o;
      li.onmousedown = e => { e.preventDefault(); choose(o); }; // mousedown so it fires before blur
      list.append(li);
    }
    active = -1;
    list.hidden = !items.length;
    input.setAttribute('aria-expanded', String(items.length > 0));
  }
  input.addEventListener('focus', open);
  input.addEventListener('click', open);
  input.addEventListener('input', open);
  input.addEventListener('blur', close);
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) open();
      if (!items.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; mark();
    } else if (e.key === 'Enter' && !list.hidden && active >= 0) { e.preventDefault(); choose(items[active]); }
    else if (e.key === 'Escape') close();
  });
}
