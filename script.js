/* ============================================================
   JIREH – script.js
   Lógica principal: Google Sheets → Catálogo → Carrito → WhatsApp
   ============================================================ */

'use strict';

/* ──────────────────────────────────────────────────────────────
   ⚙️  CONFIGURACIÓN
   ──────────────────────────────────────────────────────────────
   SHEET_ID          → ID del Google Spreadsheet (de la URL)
   APPS_SCRIPT_URL   → URL pública del Apps Script que devuelve
                       los nombres de las hojas como JSON.
                       Ver README para cómo obtenerla.
   EXCLUDED_SHEETS   → Hojas que NO son categorías (ej. config interna)
   WHATSAPP_NUMBER   → Número con código de país, sin + ni espacios
   REFRESH_INTERVAL_MS → Refresco automático en ms (0 = desactivado)

   ✅  Para agregar una categoría nueva:
       Crear una hoja nueva en el Google Sheet con las columnas:
         id | nombre | descripcion | precio | stock | imagen
       El nombre de la pestaña se convierte automáticamente en
       una categoría del filtro. Sin tocar el código.
   ────────────────────────────────────────────────────────────── */
const CONFIG = {
  SHEET_ID:          '1pJjmUGPfrTyqZKaizTRXiqOi17xbM6jthp-qTiMKY24',

  // URL que obtenés al publicar el Apps Script como Web App
  APPS_SCRIPT_URL:   'https://script.google.com/macros/s/AKfycbzg_JPMsg3DgatrWalB6ILCIFxJ_ZZa3IKRs_ZRuxaV5BgL_TgYdoJAznJwhIeUBdMm/exec',

  // Hojas internas que nunca deben aparecer como categorías
  EXCLUDED_SHEETS:   ['Config', 'Ajustes'],

  WHATSAPP_NUMBER:   '3484541916',
  REFRESH_INTERVAL_MS: 5 * 60 * 1000,
};

/* ──────────────────────────────────────────────────────────────
   📊  GOOGLE SHEETS  –  Conexión y parseo
   ──────────────────────────────────────────────────────────────
   Flujo:
   1. fetchSheetNames()     → consulta el Apps Script → devuelve
                              los nombres de las hojas como string[]
   2. fetchSheetProducts()  → descarga el CSV de cada hoja
   3. fetchAllProducts()    → orquesta todo en paralelo

   Columnas esperadas en CADA hoja (primera fila = encabezados):
     id | nombre | descripcion | precio | stock | imagen
   ────────────────────────────────────────────────────────────── */

/**
 * Obtiene los nombres de las hojas desde el Apps Script.
 * @returns {Promise<string[]>}
 */
async function fetchSheetNames() {
  const res = await fetch(CONFIG.APPS_SCRIPT_URL);
  if (!res.ok) throw new Error(`Apps Script respondió HTTP ${res.status}`);
  const names = await res.json();
  if (!Array.isArray(names)) throw new Error('Respuesta inesperada del Apps Script.');
  return names.filter(n => !CONFIG.EXCLUDED_SHEETS.includes(n));
}

/**
 * Descarga y parsea el CSV de una hoja concreta.
 * @param {string} sheetName  – nombre exacto de la pestaña
 * @returns {Promise<Product[]>}
 */
async function fetchSheetProducts(sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const csv = await res.text();
  if (csv.trim().startsWith('<!')) {
    throw new Error(`Hoja "${sheetName}" no es pública o no existe.`);
  }
  return parseCSV(csv, sheetName);
}

/**
 * Orquesta la carga de todas las hojas en paralelo.
 * Las que fallen se descartan con aviso en consola.
 * @returns {Promise<{ products: Product[], categories: string[] }>}
 */
async function fetchAllProducts() {
  const sheetNames = await fetchSheetNames();

  if (!sheetNames.length) {
    throw new Error('No se encontraron hojas. Revisá EXCLUDED_SHEETS o el Apps Script.');
  }

  const results = await Promise.allSettled(
    sheetNames.map(name => fetchSheetProducts(name))
  );

  const categories = [];
  const products   = [];

  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.length > 0) {
      categories.push(sheetNames[i]);
      products.push(...r.value);
    } else {
      const reason = r.status === 'rejected' ? r.reason.message : 'hoja vacía';
      console.warn(`[Jireh] Hoja "${sheetNames[i]}" ignorada: ${reason}`);
    }
  });

  if (!products.length) {
    throw new Error('Ninguna hoja devolvió productos.');
  }

  return { products, categories };
}

/**
 * Parsea un CSV etiquetando cada producto con su categoría.
 * @param {string} csv
 * @param {string} categoria  – nombre de la hoja (= categoría)
 * @returns {Product[]}
 */
/**
 * Convierte cualquier link de Google Drive al formato directo de imagen.
 * Acepta estos formatos (todos los que Google genera al "Copiar enlace"):
 *   https://drive.google.com/file/d/FILE_ID/view?usp=sharing
 *   https://drive.google.com/open?id=FILE_ID
 *   https://drive.google.com/uc?id=FILE_ID
 * Si el link no es de Drive, lo devuelve sin cambios.
 * @param {string} url
 * @returns {string}
 */
function normalizeDriveUrl(url) {
  if (!url) return '';

  // Formato /file/d/FILE_ID/
  const fileMatch = url.match(/\/file\/d\/([^\/\?&]+)/);
  if (fileMatch) {
    return `https://lh3.googleusercontent.com/d/${fileMatch[1]}`;
  }

  // Formato ?id=FILE_ID o &id=FILE_ID
  const idMatch = url.match(/[?&]id=([^&]+)/);
  if (idMatch) {
    return `https://lh3.googleusercontent.com/d/${idMatch[1]}`;
  }

  // No es Drive, devolver tal cual (URL externa normal)
  return url;
}

function parseCSV(csv, categoria) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = splitCSVRow(lines[0]).map(h => h.toLowerCase().trim());

  return lines.slice(1)
    .map(line => {
      const values = splitCSVRow(line);
      const obj    = {};
      headers.forEach((h, i) => { obj[h] = (values[i] || '').trim(); });
      return {
        id:          obj.id ? `${categoria}__${obj.id}` : String(Math.random()),
        nombre:      obj.nombre      || 'Sin nombre',
        descripcion: obj.descripcion || '',
        precio:      parseFloat((obj.precio || '0').replace(/[^\d.,]/g, '').replace(',', '.')) || 0,
        stock:       parseInt(obj.stock, 10) || 0,
        imagen:      normalizeDriveUrl(obj.imagen || ''),
        categoria,
      };
    })
    .filter(p => p.nombre !== 'Sin nombre' || p.precio > 0);
}

/**
 * Divide una línea CSV respetando comillas dobles.
 * @param {string} row
 * @returns {string[]}
 */
function splitCSVRow(row) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      result.push(current); current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

/* ──────────────────────────────────────────────────────────────
   🛒  CARRITO  –  Estado y persistencia en localStorage
   ────────────────────────────────────────────────────────────── */

const CART_KEY = 'jireh_cart_v1';

/** @type {CartItem[]} */
let cart = loadCart();

/**
 * @typedef {{ id:string, nombre:string, precio:number, imagen:string, cantidad:number }} CartItem
 * @typedef {{ id:string, nombre:string, descripcion:string, precio:number, stock:number, imagen:string }} Product
 */

function loadCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; }
  catch { return []; }
}

function saveCart() {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
}

/**
 * Agrega un producto al carrito o aumenta su cantidad.
 * @param {Product} product
 */
function addToCart(product) {
  const existing = cart.find(i => i.id === product.id);
  if (existing) {
    if (existing.cantidad < product.stock) {
      existing.cantidad++;
    } else {
      showToast('No hay más stock disponible.');
      return;
    }
  } else {
    if (product.stock < 1) { showToast('Sin stock.'); return; }
    cart.push({
      id:       product.id,
      nombre:   product.nombre,
      precio:   product.precio,
      imagen:   product.imagen,
      cantidad: 1,
    });
  }
  saveCart();
  updateCartUI();
  showToast(`"${product.nombre}" agregado al carrito.`);
}

/**
 * Cambia la cantidad de un ítem. Si qty <= 0, lo elimina.
 * @param {string} id
 * @param {number} qty
 */
function setQuantity(id, qty) {
  if (qty <= 0) {
    removeFromCart(id);
    return;
  }
  const item = cart.find(i => i.id === id);
  if (item) { item.cantidad = qty; saveCart(); updateCartUI(); }
}

/**
 * Elimina un ítem del carrito.
 * @param {string} id
 */
function removeFromCart(id) {
  cart = cart.filter(i => i.id !== id);
  saveCart();
  updateCartUI();
}

/**
 * Calcula el total del carrito.
 * @returns {number}
 */
function getCartTotal() {
  return cart.reduce((sum, i) => sum + i.precio * i.cantidad, 0);
}

/**
 * Devuelve la cantidad total de artículos en el carrito.
 * @returns {number}
 */
function getCartCount() {
  return cart.reduce((sum, i) => sum + i.cantidad, 0);
}

/* ──────────────────────────────────────────────────────────────
   🖼️  RENDER  –  Catálogo y Carrito
   ────────────────────────────────────────────────────────────── */

/** @type {Product[]} */
let allProducts = [];

/**
 * Categoría actualmente seleccionada.
 * '*' significa "todas".
 * @type {string}
 */
let activeCategory = '*';

/**
 * Renderiza las cards del catálogo.
 * @param {Product[]} products
 */
function renderCatalog(products) {
  const grid      = document.getElementById('productsGrid');
  const emptyEl   = document.getElementById('emptyState');

  grid.innerHTML = '';

  if (!products.length) {
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';

  products.forEach(p => {
    const inCart   = cart.find(i => i.id === p.id);
    const outStock = p.stock === 0;
    const lowStock = p.stock > 0 && p.stock <= 5;

    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.id = p.id;

    const stockBadge = outStock
      ? `<span class="card__stock-badge card__stock-badge--out">Sin stock</span>`
      : lowStock
        ? `<span class="card__stock-badge card__stock-badge--low">Últimas unidades</span>`
        : `<span class="card__stock-badge card__stock-badge--ok">Disponible</span>`;

    const imgSrc = p.imagen
      ? p.imagen
      : `https://placehold.co/400x300/E8E3DA/8A8278?text=${encodeURIComponent(p.nombre)}`;

    const addedClass = inCart ? 'added' : '';
    const addedLabel = inCart ? '✓ En el carrito' : 'Agregar al carrito';

    card.innerHTML = `
      <div class="card__img-wrap">
        <img class="card__img" src="${imgSrc}" alt="${p.nombre}" loading="lazy"
          onerror="this.src='https://placehold.co/400x300/E8E3DA/8A8278?text=Sin+imagen'">
        ${stockBadge}
      </div>
      <div class="card__body">
        <h3 class="card__name">${p.nombre}</h3>
        <p class="card__desc">${p.descripcion}</p>
        <p class="card__price">${formatPrice(p.precio)}</p>
      </div>
      <div class="card__footer">
        <button class="card__add-btn ${addedClass}"
          data-id="${p.id}"
          ${outStock ? 'disabled' : ''}>
          ${outStock ? 'Sin stock' : addedLabel}
        </button>
      </div>
    `;

    // Event listener del botón
    const btn = card.querySelector('.card__add-btn');
    btn.addEventListener('click', () => {
      addToCart(p);
      // Actualizar estado visual de este botón
      btn.classList.add('added');
      btn.textContent = '✓ En el carrito';
    });

    grid.appendChild(card);
  });
}

/**
 * Renderiza el panel del carrito.
 */
function renderCartPanel() {
  const body     = document.getElementById('cartBody');
  const emptyEl  = document.getElementById('cartEmpty');
  const footerEl = document.getElementById('cartFooter');
  const totalEl  = document.getElementById('cartTotal');

  // Limpiar ítems anteriores (mantener el empty msg)
  body.querySelectorAll('.cart-item').forEach(el => el.remove());

  if (!cart.length) {
    emptyEl.style.display = 'block';
    footerEl.style.display = 'none';
    return;
  }

  emptyEl.style.display = 'none';
  footerEl.style.display = 'flex';
  totalEl.textContent = formatPrice(getCartTotal());

  cart.forEach(item => {
    const el = document.createElement('div');
    el.className = 'cart-item';

    const imgSrc = item.imagen
      ? item.imagen
      : `https://placehold.co/72x72/E8E3DA/8A8278?text=${encodeURIComponent(item.nombre)}`;

    el.innerHTML = `
      <img class="cart-item__img" src="${imgSrc}" alt="${item.nombre}"
        onerror="this.src='https://placehold.co/72x72/E8E3DA/8A8278?text=img'">
      <div class="cart-item__info">
        <span class="cart-item__name">${item.nombre}</span>
        <span class="cart-item__price">${formatPrice(item.precio)}</span>
        <div class="cart-item__qty">
          <button class="qty-btn" data-action="dec" data-id="${item.id}" aria-label="Quitar uno">−</button>
          <span class="qty-value">${item.cantidad}</span>
          <button class="qty-btn" data-action="inc" data-id="${item.id}" aria-label="Agregar uno">+</button>
        </div>
      </div>
      <button class="cart-item__remove" data-id="${item.id}" aria-label="Eliminar">&times;</button>
    `;

    // Controles cantidad
    el.querySelectorAll('.qty-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const current = cart.find(i => i.id === btn.dataset.id)?.cantidad || 0;
        const product = allProducts.find(p => p.id === btn.dataset.id);
        const maxQty  = product ? product.stock : 99;

        if (btn.dataset.action === 'inc') {
          if (current < maxQty) { setQuantity(btn.dataset.id, current + 1); }
          else { showToast('Sin más stock disponible.'); }
        } else {
          setQuantity(btn.dataset.id, current - 1);
        }
      });
    });

    // Eliminar
    el.querySelector('.cart-item__remove').addEventListener('click', () => {
      removeFromCart(item.id);
    });

    body.appendChild(el);
  });
}

/**
 * Actualiza badge, panel del carrito y botones del catálogo.
 */
function updateCartUI() {
  // Badge
  const count   = getCartCount();
  const badge   = document.getElementById('cartBadge');
  badge.textContent = count;
  badge.classList.toggle('visible', count > 0);

  // Panel
  renderCartPanel();

  // Refrescar estado de botones del catálogo (sin re-renderizar todo)
  document.querySelectorAll('.card__add-btn').forEach(btn => {
    const id      = btn.dataset.id;
    const inCart  = cart.find(i => i.id === id);
    const product = allProducts.find(p => p.id === id);
    if (!product) return;
    if (product.stock === 0) return;
    if (inCart) {
      btn.classList.add('added');
      btn.textContent = '✓ En el carrito';
    } else {
      btn.classList.remove('added');
      btn.textContent = 'Agregar al carrito';
    }
  });
}

/* ──────────────────────────────────────────────────────────────
   📱  WHATSAPP  –  Generación del mensaje
   ────────────────────────────────────────────────────────────── */

/**
 * Genera el mensaje de WhatsApp y abre el link.
 * @param {string} nombre
 * @param {string} celular
 * @param {string} comentarios
 */
function sendWhatsApp(nombre, celular, comentarios) {
  const lines = [];

  lines.push('Hola! Me gustar\u00eda hacer un pedido para recoger en tienda');
  lines.push('');
  lines.push(`\u2022 *Nombre:* ${nombre}`);
  lines.push(`\u2022 *Celular:* ${celular}`);
  if (comentarios.trim()) {
    lines.push(`\u2022 *Comentarios:* ${comentarios.trim()}`);
  }
  lines.push('');
  lines.push('Con los siguientes productos:');
  lines.push('');
  cart.forEach(item => {
    lines.push(`${item.nombre} (x${item.cantidad})`);
  });
  lines.push('');
  lines.push(`*TOTAL: ${formatPrice(getCartTotal())}*`);

  const message = lines.join('\n');
  const url     = `https://wa.me/${CONFIG.WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

/* ──────────────────────────────────────────────────────────────
   🔍  BUSCADOR
   ────────────────────────────────────────────────────────────── */

/**
 * Filtra allProducts aplicando simultáneamente búsqueda de texto y categoría activa.
 * @param {string} query  – texto del buscador
 * @param {string} cat    – categoría activa ('*' = todas)
 * @returns {Product[]}
 */
function filterProducts(query, cat) {
  const q = query.toLowerCase().trim();
  return allProducts.filter(p => {
    const matchText = !q ||
      p.nombre.toLowerCase().includes(q) ||
      p.descripcion.toLowerCase().includes(q);
    const matchCat  = cat === '*' || p.categoria === cat;
    return matchText && matchCat;
  });
}

/**
 * Puebla el <select id="categorySelect"> con las categorías recibidas.
 * Siempre empieza con la opción "Todas las categorías".
 * Si la categoría activa ya no existe, la resetea a '*'.
 * @param {string[]} categories
 */
function renderCategories(categories) {
  const select   = document.getElementById('categorySelect');
  const clearBtn = document.getElementById('clearCategory');
  if (!select) return;

  // Guardar la selección actual para reponerla si sigue existiendo
  const current = select.value;

  // Reconstruir opciones
  select.innerHTML = '<option value="*">Todas las categorías</option>';
  categories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value       = cat;
    opt.textContent = cat;
    select.appendChild(opt);
  });

  // Reponer selección anterior o resetear
  if (categories.includes(current)) {
    select.value   = current;
    activeCategory = current;
  } else {
    select.value   = '*';
    activeCategory = '*';
  }

  // Sincronizar estado visual del select y el botón limpiar
  select.classList.toggle('active', activeCategory !== '*');
  if (clearBtn) clearBtn.hidden = activeCategory === '*';
}

/* ──────────────────────────────────────────────────────────────
   🎨  HELPERS UI
   ────────────────────────────────────────────────────────────── */

/**
 * Formatea un número como precio en ARS.
 * @param {number} n
 * @returns {string}
 */
function formatPrice(n) {
  return '$' + Math.round(n).toLocaleString('es-AR');
}

let toastTimeout;
/**
 * Muestra un toast de notificación.
 * @param {string} msg
 */
function showToast(msg) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 2800);
}

/* ──────────────────────────────────────────────────────────────
   🔐  VALIDACIÓN DEL FORMULARIO
   ────────────────────────────────────────────────────────────── */

/**
 * Valida los campos y devuelve true si todo está OK.
 * @returns {boolean}
 */
function validateForm() {
  let valid = true;

  const name   = document.getElementById('clientName').value.trim();
  const phone  = document.getElementById('clientPhone').value.trim();
  const nameErr  = document.getElementById('nameError');
  const phoneErr = document.getElementById('phoneError');

  nameErr.textContent  = '';
  phoneErr.textContent = '';

  if (!name || name.length < 3) {
    nameErr.textContent = 'Ingresá tu nombre completo.';
    valid = false;
  }
  if (!phone || !/^[\d\s\-+()]{7,20}$/.test(phone)) {
    phoneErr.textContent = 'Ingresá un número de celular válido.';
    valid = false;
  }

  return valid;
}

/* ──────────────────────────────────────────────────────────────
   📋  RESUMEN DEL PEDIDO (dentro del modal)
   ────────────────────────────────────────────────────────────── */

function renderOrderSummary() {
  const el = document.getElementById('orderSummary');
  el.innerHTML = '';

  cart.forEach(item => {
    const row = document.createElement('div');
    row.className = 'order-summary__row';
    row.innerHTML = `
      <span>${item.nombre} ×${item.cantidad}</span>
      <span>${formatPrice(item.precio * item.cantidad)}</span>
    `;
    el.appendChild(row);
  });

  const totalRow = document.createElement('div');
  totalRow.className = 'order-summary__row order-summary__row--total';
  totalRow.innerHTML = `<span>Total</span><span>${formatPrice(getCartTotal())}</span>`;
  el.appendChild(totalRow);
}

/* ──────────────────────────────────────────────────────────────
   🚀  INICIALIZACIÓN
   ────────────────────────────────────────────────────────────── */

async function init() {
  // ── Elementos del DOM ─────────────────────────────────────
  const statusEl      = document.getElementById('status');
  const searchInput   = document.getElementById('searchInput');
  const cartBtn       = document.getElementById('cartBtn');
  const cartClose     = document.getElementById('cartClose');
  const cartOverlay   = document.getElementById('cartOverlay');
  const cartPanel     = document.getElementById('cartPanel');
  const checkoutBtn   = document.getElementById('checkoutBtn');
  const modalOverlay  = document.getElementById('modalOverlay');
  const modalClose    = document.getElementById('modalClose');
  const sendWA        = document.getElementById('sendWhatsApp');
  const hamburger     = document.getElementById('hamburger');
  const mobileNav     = document.getElementById('mobileNav');

  // ── Cargar catálogo ───────────────────────────────────────
  async function loadAndRender() {
    try {
      statusEl.classList.remove('hidden');
      const { products, categories } = await fetchAllProducts();
      allProducts = products;
      statusEl.classList.add('hidden');
      // Actualizar el selector de categorías con las hojas recibidas
      renderCategories(categories);
      applyFilters();
      updateCartUI();
    } catch (err) {
      statusEl.innerHTML = `
        <p style="color:var(--c-danger)">
          ⚠️ No se pudieron cargar los productos.<br>
          <small>Verificá que el Google Sheet sea público y que el ID sea correcto.</small>
        </p>
        <p style="font-size:.8rem;color:var(--c-muted);margin-top:8px;">Error: ${err.message}</p>
      `;
      console.error('[Jireh] Error al cargar productos:', err);
    }
  }

  await loadAndRender();

  // Refresco automático
  if (CONFIG.REFRESH_INTERVAL_MS > 0) {
    setInterval(loadAndRender, CONFIG.REFRESH_INTERVAL_MS);
  }

  // ── Helper central de filtros ─────────────────────────────
  // Aplica búsqueda + categoría y re-renderiza el catálogo.
  function applyFilters() {
    const query    = searchInput.value;
    const filtered = filterProducts(query, activeCategory);
    renderCatalog(filtered);
    updateCartUI();
  }

  // ── Buscador ──────────────────────────────────────────────
  searchInput.addEventListener('input', applyFilters);

  // ── Selector de categorías ────────────────────────────────
  const categorySelect = document.getElementById('categorySelect');
  const clearCategory  = document.getElementById('clearCategory');

  if (categorySelect) {
    categorySelect.addEventListener('change', () => {
      activeCategory = categorySelect.value;
      // Actualizar estado visual
      categorySelect.classList.toggle('active', activeCategory !== '*');
      if (clearCategory) clearCategory.hidden = activeCategory === '*';
      applyFilters();
    });
  }

  // Botón ✕ para quitar el filtro de categoría
  if (clearCategory) {
    clearCategory.addEventListener('click', () => {
      activeCategory = '*';
      if (categorySelect) {
        categorySelect.value = '*';
        categorySelect.classList.remove('active');
      }
      clearCategory.hidden = true;
      applyFilters();
    });
  }

  // ── Carrito: abrir / cerrar ───────────────────────────────
  function openCart() {
    cartPanel.classList.add('open');
    cartOverlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeCart() {
    cartPanel.classList.remove('open');
    cartOverlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  cartBtn.addEventListener('click', openCart);
  cartClose.addEventListener('click', closeCart);
  cartOverlay.addEventListener('click', closeCart);

  // ── Modal: abrir / cerrar ─────────────────────────────────
  function openModal() {
    if (!cart.length) { showToast('Agregá productos antes de finalizar.'); return; }
    renderOrderSummary();
    modalOverlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    closeCart();
  }
  function closeModal() {
    modalOverlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  checkoutBtn.addEventListener('click', openModal);
  modalClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', e => {
    if (e.target === modalOverlay) closeModal();
  });

  // ── Enviar pedido por WhatsApp ────────────────────────────
  sendWA.addEventListener('click', () => {
    if (!validateForm()) return;
    const nombre      = document.getElementById('clientName').value.trim();
    const celular     = document.getElementById('clientPhone').value.trim();
    const comentarios = document.getElementById('clientComments').value;
    sendWhatsApp(nombre, celular, comentarios);
  });

  // ── Hamburger ─────────────────────────────────────────────
  hamburger.addEventListener('click', () => {
    mobileNav.classList.toggle('open');
  });

  // ── Teclado: cerrar con Escape ────────────────────────────
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeCart(); closeModal(); }
  });

  // ── UI inicial del carrito ────────────────────────────────
  updateCartUI();
}

/* Función global para el mobile nav (usada en el HTML con onclick) */
function closeMobileNav() {
  document.getElementById('mobileNav').classList.remove('open');
}

// ── Arrancar cuando el DOM esté listo ───────────────────────
document.addEventListener('DOMContentLoaded', init);
