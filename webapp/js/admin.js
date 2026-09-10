/* ══════════════════════════════════════════════════════════════
   Espace admin — gestion du stock, des produits et des commandes
   ══════════════════════════════════════════════════════════════ */

const tg = window.Telegram?.WebApp;
const LOW_STOCK = 5; // seuil d'alerte

const state = {
  currency: 'EUR',
  statuses: {},
  products: [],
  categories: [],
  orders: [],
  stats: null,
  settings: null,
  tab: 'board',
  orderFilter: '',
  editing: null, // produit en cours d'édition, null = création
};

const $ = (id) => document.getElementById(id);

init();

/* ── Démarrage ───────────────────────────────────────────── */

async function init() {
  if (tg) {
    tg.ready();
    tg.expand();
    const night = themeHex('--night-rgb', '#04160f');
    tg.setHeaderColor?.(night);
    tg.setBackgroundColor?.(night);
  }

  bindHandlers();

  try {
    const session = await api('/session');
    state.currency = session.currency;
    state.statuses = session.statuses;
    $('adminName').textContent = session.user.first_name ?? 'Admin';
    $('gate').hidden = true;
  } catch (err) {
    denyAccess(err.message);
    return;
  }

  await refreshAll();
}

function denyAccess(message) {
  const gate = $('gate');
  gate.classList.add('a-gate--denied');
  $('gateSpinner').hidden = true;
  $('gateText').textContent = message;
}

function bindHandlers() {
  for (const tab of document.querySelectorAll('.a-tab')) {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  }
  $('refreshBtn').addEventListener('click', async () => {
    haptic('light');
    await refreshAll();
    toast('Données à jour');
  });

  $('stockSearch').addEventListener('input', renderStock);
  $('addCategory').addEventListener('click', () => addCategoryRow());
  $('saveCategories').addEventListener('click', saveCategoryList);
  $('saveSettings').addEventListener('click', saveGuards);
  $('newProductBtn').addEventListener('click', () => openEditor(null));

  $('fHasVariants').addEventListener('change', syncPricingMode);
  $('fImage').addEventListener('change', syncImageField);
  $('addVariant').addEventListener('click', () => addVariantRow());
  $('saveProduct').addEventListener('click', saveProduct);
  $('deleteProduct').addEventListener('click', removeProduct);

  for (const el of document.querySelectorAll('[data-close]')) {
    el.addEventListener('click', closeEditor);
  }
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeEditor());
}

async function refreshAll() {
  const [catalog, orders, stats, settings] = await Promise.all([
    api('/catalog'),
    api('/orders'),
    api('/stats'),
    api('/settings'),
  ]);
  state.settings = settings;
  state.products = catalog.products;
  state.categories = catalog.categories.filter((c) => c.id !== 'all');
  state.orders = orders;
  state.stats = stats;

  renderBoard();
  renderOrderFilters();
  renderOrders();
  renderStock();
  renderProducts();
  renderCategories();
  renderSettings();

  $('pendingDot').hidden = stats.pending === 0;
}

/* ── Navigation ──────────────────────────────────────────── */

function selectTab(name) {
  state.tab = name;
  for (const tab of document.querySelectorAll('.a-tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  }
  for (const panel of document.querySelectorAll('.a-panel')) {
    panel.hidden = panel.id !== `panel-${name}`;
  }
  window.scrollTo({ top: 0 });
  haptic('light');
}

/* ── Tableau de bord ─────────────────────────────────────── */

function renderBoard() {
  const s = state.stats;
  const kpis = [
    { label: "Chiffre d'affaires", value: formatPrice(s.revenue), cls: 'a-kpi--accent' },
    { label: "Aujourd'hui", value: formatPrice(s.revenueToday) },
    { label: 'Commandes', value: s.ordersTotal },
    { label: 'À traiter', value: s.pending, cls: s.pending ? 'a-kpi--warn' : '' },
  ];

  $('kpis').replaceChildren(
    ...kpis.map((k) => {
      const div = document.createElement('div');
      div.className = `a-kpi ${k.cls ?? ''}`.trim();
      div.innerHTML = `<span class="a-kpi__label">${escapeHtml(k.label)}</span>
        <span class="a-kpi__value">${escapeHtml(String(k.value))}</span>`;
      return div;
    })
  );

  $('topProducts').replaceChildren(
    ...(s.topProducts.length
      ? s.topProducts.map((p) =>
          listRow(p.name, `${p.quantity} vendu${p.quantity > 1 ? 's' : ''} · ${formatPrice(p.revenue)}`)
        )
      : [emptyRow('Aucune vente pour le moment.')])
  );

  const low = lowStockRows();
  $('lowStock').replaceChildren(
    ...(low.length
      ? low.map((r) =>
          listRow(r.label, r.stock === 0 ? 'Épuisé' : `Plus que ${r.stock}`)
        )
      : [emptyRow('Tous les stocks sont corrects.')])
  );
}

/** Lignes de stock au niveau ou en dessous du seuil d'alerte. */
function lowStockRows() {
  const rows = [];
  for (const product of state.products) {
    if (product.variants?.length) {
      for (const v of product.variants) {
        if (v.stock <= LOW_STOCK) rows.push({ label: `${product.name} · ${v.label}`, stock: v.stock });
      }
    } else if ((product.stock ?? 0) <= LOW_STOCK) {
      rows.push({ label: product.name, stock: product.stock ?? 0 });
    }
  }
  return rows.sort((a, b) => a.stock - b.stock);
}

function listRow(label, meta) {
  const li = document.createElement('li');
  li.innerHTML = `<span>${escapeHtml(label)}</span><span class="a-muted">${escapeHtml(meta)}</span>`;
  return li;
}

function emptyRow(text) {
  const li = document.createElement('li');
  li.className = 'a-empty';
  li.style.justifyContent = 'center';
  li.textContent = text;
  return li;
}

/* ── Commandes ───────────────────────────────────────────── */

function renderOrderFilters() {
  const filters = [{ id: '', label: 'Toutes' }, ...Object.entries(state.statuses).map(([id, s]) => ({ id, label: s.label }))];

  $('orderFilters').replaceChildren(
    ...filters.map((f) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'a-filter';
      btn.textContent = f.label;
      btn.setAttribute('aria-pressed', String(f.id === state.orderFilter));
      btn.addEventListener('click', () => {
        state.orderFilter = f.id;
        renderOrderFilters();
        renderOrders();
        haptic('light');
      });
      return btn;
    })
  );
}

function renderOrders() {
  const list = state.orders.filter((o) => !state.orderFilter || o.status === state.orderFilter);
  const container = $('ordersList');

  if (!list.length) {
    container.innerHTML = '<p class="a-empty">Aucune commande ici.</p>';
    return;
  }
  container.replaceChildren(...list.map(orderCard));
}

function orderCard(order) {
  const status = state.statuses[order.status];
  const who = order.user.username ? `@${order.user.username}` : order.user.firstName ?? `#${order.user.id}`;
  const when = new Date(order.createdAt).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });

  const card = document.createElement('article');
  card.className = 'a-order';
  card.innerHTML = `
    <div class="a-order__head">
      <span class="a-order__ref">${escapeHtml(order.reference)}</span>
      <span class="a-order__total">${formatPrice(order.total)}</span>
    </div>
    <div class="a-order__meta">${escapeHtml(who)} · ${escapeHtml(when)}
      <span class="a-status a-status--${order.status}">${status.emoji} ${escapeHtml(status.label)}</span>
    </div>
    <ul class="a-order__items">
      ${order.items
        .map((i) => `<li>${i.quantity} × ${escapeHtml(i.name)}${i.variantLabel ? ` (${escapeHtml(i.variantLabel)})` : ''} — ${formatPrice(i.lineTotal)}</li>`)
        .join('')}
    </ul>
    ${order.note ? `<p class="a-order__note">💬 ${escapeHtml(order.note)}</p>` : ''}
    <div class="a-order__actions"></div>`;

  const actions = card.querySelector('.a-order__actions');
  for (const next of status.next) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `a-btn a-btn--sm ${next === 'annulee' ? 'a-btn--danger' : 'a-btn--primary'}`;
    btn.textContent = `${state.statuses[next].emoji} ${state.statuses[next].label}`;
    btn.addEventListener('click', () => changeStatus(order.reference, next, btn));
    actions.append(btn);
  }
  if (!status.next.length) {
    actions.append(Object.assign(document.createElement('span'), {
      className: 'a-muted', textContent: 'Commande terminée.',
    }));
  }

  // Le blocage se décide en lisant une commande : c'est là qu'on voit l'abus.
  const blocked = (state.settings?.blocked ?? []).includes(String(order.user.id));
  const ban = document.createElement('button');
  ban.type = 'button';
  ban.className = 'a-btn a-btn--sm a-btn--ghost a-order__ban';
  ban.textContent = blocked ? '↩︎ Débloquer' : '⛔ Bloquer';
  ban.addEventListener('click', () => toggleBlock(order.user.id, !blocked, ban));
  actions.append(ban);

  return card;
}

async function changeStatus(reference, status, button) {
  if (status === 'annulee' && !confirm('Annuler cette commande ? Le stock sera remis en rayon.')) return;

  button.disabled = true;
  try {
    await api(`/orders/${reference}/status`, { method: 'POST', body: { status } });
    haptic('success');
    toast(`${reference} → ${state.statuses[status].label}`);
    await refreshAll();
  } catch (err) {
    toast(err.message);
    button.disabled = false;
  }
}

/* ── Stock ───────────────────────────────────────────────── */

function renderStock() {
  const query = $('stockSearch').value.trim().toLowerCase();
  const list = state.products.filter((p) => !query || p.name.toLowerCase().includes(query));
  const container = $('stockList');

  if (!list.length) {
    container.innerHTML = '<p class="a-empty">Aucun produit ne correspond.</p>';
    return;
  }
  container.replaceChildren(...list.map(stockCard));
}

function stockCard(product) {
  const card = document.createElement('div');
  card.className = 'a-stock';
  card.innerHTML = `
    <div class="a-stock__name">
      ${escapeHtml(product.name)}
      ${product.visible === false ? '<span class="a-stock__hidden">MASQUÉ</span>' : ''}
    </div>
    <div class="a-stock__rows"></div>`;

  const rows = card.querySelector('.a-stock__rows');
  const entries = product.variants?.length
    ? product.variants.map((v) => ({ label: v.label, variantId: v.id, stock: v.stock }))
    : [{ label: 'Stock', variantId: null, stock: product.stock ?? 0 }];

  for (const entry of entries) rows.append(stockRow(product, entry));
  return card;
}

function stockRow(product, entry) {
  const row = document.createElement('div');
  row.className = 'a-stock__row';
  if (entry.stock === 0) row.classList.add('a-stock__row--out');
  else if (entry.stock <= LOW_STOCK) row.classList.add('a-stock__row--low');

  row.innerHTML = `
    <span class="a-stock__label">${escapeHtml(entry.label)}</span>
    <span class="a-stepper">
      <button type="button" data-act="minus" aria-label="Retirer">−</button>
      <input type="number" min="0" inputmode="numeric" value="${entry.stock}" aria-label="Stock ${escapeHtml(entry.label)}">
      <button type="button" data-act="plus" aria-label="Ajouter">+</button>
    </span>`;

  const input = row.querySelector('input');
  const commit = async (value) => {
    const quantity = Math.max(0, Math.floor(Number(value)));
    if (!Number.isFinite(quantity)) return;
    input.value = quantity;
    try {
      await api(`/products/${product.id}/stock`, {
        method: 'POST',
        body: { variantId: entry.variantId, quantity },
      });
      // On met le cache local à jour sans tout recharger : la saisie reste fluide.
      entry.stock = quantity;
      applyStockToState(product.id, entry.variantId, quantity);
      row.classList.toggle('a-stock__row--out', quantity === 0);
      row.classList.toggle('a-stock__row--low', quantity > 0 && quantity <= LOW_STOCK);
      renderBoard();
      haptic('light');
    } catch (err) {
      toast(err.message);
    }
  };

  row.querySelector('[data-act="minus"]').addEventListener('click', () => commit(Number(input.value) - 1));
  row.querySelector('[data-act="plus"]').addEventListener('click', () => commit(Number(input.value) + 1));
  input.addEventListener('change', () => commit(input.value));
  return row;
}

function applyStockToState(productId, variantId, quantity) {
  const product = state.products.find((p) => p.id === productId);
  if (!product) return;
  if (variantId) {
    const variant = product.variants?.find((v) => v.id === variantId);
    if (variant) variant.stock = quantity;
  } else {
    product.stock = quantity;
  }
}

/* ── Produits ────────────────────────────────────────────── */

function renderProducts() {
  const container = $('productsList');
  if (!state.products.length) {
    container.innerHTML = '<p class="a-empty">Aucun produit. Crée le premier !</p>';
    return;
  }

  container.replaceChildren(
    ...state.products.map((product) => {
      const total = product.variants?.length
        ? product.variants.reduce((sum, v) => sum + v.stock, 0)
        : product.stock ?? 0;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `a-product ${product.visible === false ? 'a-product--hidden' : ''}`.trim();
      btn.innerHTML = `
        <span class="a-product__art"><img src="${product.image}" alt=""></span>
        <span class="a-product__info">
          <span class="a-product__name">${escapeHtml(product.name)}</span>
          <span class="a-product__meta">${formatPrice(product.price)} · ${total} en stock${product.visible === false ? ' · masqué' : ''}</span>
        </span>
        <span aria-hidden="true">›</span>`;
      btn.addEventListener('click', () => openEditor(product));
      return btn;
    })
  );
}

/* ── Éditeur ─────────────────────────────────────────────── */

/** Valeur du menu qui bascule sur la saisie libre d'un chemin de photo. */
const CUSTOM_IMAGE = '__custom__';

const IMAGES = [
  ['/assets/products/jar.svg', 'Bocal'],
  ['/assets/products/bud.svg', 'Fleur'],
  ['/assets/products/bud-sativa.svg', 'Fleur sativa'],
  ['/assets/products/hash.svg', 'Résine'],
  ['/assets/products/cookie.svg', 'Comestible'],
  ['/assets/products/grinder.svg', 'Grinder'],
  ['/assets/products/box.svg', 'Carton'],
  [CUSTOM_IMAGE, '📷 Ma photo (chemin ou adresse)'],
];

function openEditor(product) {
  state.editing = product;
  $('editorTitle').textContent = product ? 'Modifier' : 'Nouveau produit';
  $('deleteProduct').hidden = !product;
  $('editorError').hidden = true;

  fillSelect($('fCategory'), state.categories.map((c) => [c.id, `${c.emoji} ${c.label}`]));
  fillSelect($('fImage'), IMAGES);
  syncImageField();

  $('fName').value = product?.name ?? '';
  $('fShort').value = product?.short ?? '';
  $('fDesc').value = product?.description ?? '';
  $('fCategory').value = product?.category ?? state.categories[0]?.id ?? '';
  $('fBadge').value = product?.badge ?? '';
  $('fTags').value = (product?.tags ?? []).join(', ');
  // Une photo déposée dans le dossier n'est pas dans la liste : on bascule
  // alors sur la saisie libre, pré-remplie avec le chemin enregistré.
  const image = product?.image ?? IMAGES[0][0];
  const known = IMAGES.some(([value]) => value === image);
  $('fImage').value = known ? image : CUSTOM_IMAGE;
  $('fImagePath').value = known ? '' : image;
  syncImageField();
  $('fVisible').checked = product ? product.visible !== false : true;

  const hasVariants = Boolean(product?.variants?.length);
  $('fHasVariants').checked = hasVariants;
  $('fPrice').value = hasVariants ? '' : product ? (product.price / 100).toFixed(2) : '';
  $('fStock').value = hasVariants ? '' : product?.stock ?? 0;

  $('variantRows').replaceChildren();
  if (hasVariants) for (const v of product.variants) addVariantRow(v);
  else addVariantRow();

  syncPricingMode();
  $('editor').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeEditor() {
  $('editor').hidden = true;
  document.body.style.overflow = '';
  state.editing = null;
}

function syncPricingMode() {
  const withVariants = $('fHasVariants').checked;
  $('simplePricing').hidden = withVariants;
  $('variantPricing').hidden = !withVariants;
}

function addVariantRow(variant = null) {
  const row = document.createElement('div');
  row.className = 'a-variant';
  row.innerHTML = `
    <input class="a-variant__label" placeholder="2 g" value="${escapeHtml(variant?.label ?? '')}">
    <input class="a-variant__price" type="number" step="0.01" min="0" inputmode="decimal" placeholder="Prix"
      value="${variant ? (variant.price / 100).toFixed(2) : ''}">
    <input class="a-variant__stock" type="number" min="0" inputmode="numeric" placeholder="Stock"
      value="${variant?.stock ?? 0}">
    <button class="a-variant__del" type="button" aria-label="Supprimer ce format">✕</button>`;
  row.querySelector('.a-variant__del').addEventListener('click', () => row.remove());
  $('variantRows').append(row);
}

function collectForm() {
  const payload = {
    name: $('fName').value.trim(),
    short: $('fShort').value.trim(),
    description: $('fDesc').value.trim(),
    category: $('fCategory').value,
    badge: $('fBadge').value.trim() || undefined,
    tags: $('fTags').value.split(',').map((t) => t.trim()).filter(Boolean),
    image: currentImage(),
    visible: $('fVisible').checked,
  };

  if (!payload.image) throw new Error('Indique le chemin de la photo.');

  if ($('fHasVariants').checked) {
    payload.variants = [...document.querySelectorAll('#variantRows .a-variant')]
      .map((row) => ({
        label: row.querySelector('.a-variant__label').value.trim(),
        price: toCents(row.querySelector('.a-variant__price').value),
        stock: Number(row.querySelector('.a-variant__stock').value || 0),
      }))
      .filter((v) => v.label);
    if (!payload.variants.length) throw new Error('Ajoute au moins un format.');
    payload.price = Math.min(...payload.variants.map((v) => v.price));
  } else {
    payload.variants = null;
    payload.price = toCents($('fPrice').value);
    payload.stock = Number($('fStock').value || 0);
  }

  if (!payload.name) throw new Error('Le nom est obligatoire.');
  if (!Number.isFinite(payload.price)) throw new Error('Prix invalide.');
  return payload;
}

async function saveProduct() {
  const button = $('saveProduct');
  const error = $('editorError');
  error.hidden = true;
  button.disabled = true;

  try {
    const payload = collectForm();
    if (state.editing) {
      await api(`/products/${state.editing.id}`, { method: 'PATCH', body: payload });
    } else {
      await api('/products', { method: 'POST', body: payload });
    }
    haptic('success');
    toast(state.editing ? 'Produit mis à jour' : 'Produit créé');
    closeEditor();
    await refreshAll();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
}

async function removeProduct() {
  if (!state.editing) return;
  if (!confirm(`Supprimer « ${state.editing.name} » ? Cette action est définitive.`)) return;

  try {
    await api(`/products/${state.editing.id}`, { method: 'DELETE' });
    haptic('success');
    toast('Produit supprimé');
    closeEditor();
    await refreshAll();
  } catch (err) {
    toast(err.message);
  }
}

/* ── Image du produit ────────────────────────────────────── */

/** Chemin retenu : le menu, ou la saisie libre quand « Ma photo » est choisi. */
function currentImage() {
  if ($('fImage').value !== CUSTOM_IMAGE) return $('fImage').value;
  return $('fImagePath').value.trim();
}

function syncImageField() {
  $('imagePathField').hidden = $('fImage').value !== CUSTOM_IMAGE;
}

/* ── Réglages ────────────────────────────────────────────── */

function renderSettings() {
  const settings = state.settings;
  if (!settings) return;

  $('fOrdersPerHour').value = settings.limits.ordersPerHour;
  $('fUnitsPerOrder').value = settings.limits.unitsPerOrder;

  const list = $('blockedList');
  if (!settings.blocked.length) {
    list.replaceChildren(Object.assign(document.createElement('li'), {
      className: 'a-empty', textContent: 'Personne n\'est bloqué.',
    }));
    return;
  }

  list.replaceChildren(
    ...settings.blocked.map((id) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>#${escapeHtml(id)}</span>`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'a-btn a-btn--sm a-btn--ghost';
      btn.textContent = 'Débloquer';
      btn.addEventListener('click', () => toggleBlock(id, false, btn));
      li.append(btn);
      return li;
    })
  );
}

async function saveGuards() {
  const button = $('saveSettings');
  button.disabled = true;
  try {
    state.settings = await api('/settings', {
      method: 'PUT',
      body: {
        limits: {
          ordersPerHour: Number($('fOrdersPerHour').value),
          unitsPerOrder: Number($('fUnitsPerOrder').value),
        },
      },
    });
    renderSettings();
    toast('Garde-fous enregistrés');
    haptic('success');
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
}

async function toggleBlock(id, block, button) {
  button.disabled = true;
  try {
    state.settings = await api(`/clients/${id}/${block ? 'block' : 'unblock'}`, { method: 'POST' });
    renderSettings();
    renderOrders();
    toast(block ? `Client #${id} bloqué` : `Client #${id} débloqué`);
    haptic('success');
  } catch (err) {
    toast(err.message);
    button.disabled = false;
  }
}

/* ── Catégories ──────────────────────────────────────────── */

/**
 * Les catégories sont enregistrées d'un bloc (PUT /categories) : l'écran
 * édite une copie de travail, et rien ne part tant qu'on n'enregistre pas.
 */
function renderCategories() {
  $('categoryRows').replaceChildren(...state.categories.map(categoryRow));
}

function categoryRow(category = { id: '', label: '', emoji: '•' }) {
  const row = document.createElement('div');
  row.className = 'a-catrow';
  row.dataset.id = category.id;
  row.innerHTML = `
    <input class="a-category__emoji" maxlength="4" value="${escapeHtml(category.emoji ?? '•')}" aria-label="Emoji">
    <input class="a-category__label" maxlength="40" value="${escapeHtml(category.label ?? '')}" placeholder="Nom de la catégorie">
    <button class="a-variant__del" type="button" aria-label="Supprimer">✕</button>`;

  row.querySelector('button').addEventListener('click', () => {
    const used = state.products.filter((p) => p.category === category.id).length;
    if (used) {
      toast(`${used} produit(s) utilisent cette catégorie.`);
      return;
    }
    row.remove();
  });
  return row;
}

function addCategoryRow() {
  $('categoryRows').append(categoryRow());
}

async function saveCategoryList() {
  const categories = [...$('categoryRows').children]
    .map((row) => ({
      // On garde l'identifiant existant : les produits pointent dessus.
      id: row.dataset.id || undefined,
      label: row.querySelector('.a-category__label').value.trim(),
      emoji: row.querySelector('.a-category__emoji').value.trim() || '•',
    }))
    .filter((c) => c.label);

  if (!categories.length) {
    toast('Il faut au moins une catégorie.');
    return;
  }

  const button = $('saveCategories');
  button.disabled = true;
  try {
    await api('/categories', { method: 'PUT', body: { categories } });
    await refreshAll();
    toast('Catégories enregistrées');
    haptic('success');
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
}

/* ── Utilitaires ─────────────────────────────────────────── */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/admin${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': tg?.initData ?? '',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
  return data;
}

function fillSelect(select, entries) {
  select.replaceChildren(
    ...entries.map(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    })
  );
}

function toCents(value) {
  const number = Number(String(value).replace(',', '.'));
  return Number.isFinite(number) ? Math.round(number * 100) : NaN;
}

function formatPrice(cents) {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: state.currency || 'EUR',
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

let toastTimer;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

function haptic(type) {
  const h = tg?.HapticFeedback;
  if (!h) return;
  if (type === 'success') h.notificationOccurred?.('success');
  else h.impactOccurred?.(type);
}

/** Telegram n'accepte que des couleurs hexadécimales : on convertit les
 *  jetons « R G B » du thème pour que la barre native suive la palette. */
function themeHex(token, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token);
  const parts = raw.match(/\d+/g);
  if (!parts || parts.length < 3) return fallback;
  return `#${parts.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
}
