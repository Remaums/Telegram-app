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
  verifications: [],
  promos: [],
  featureList: [],   // catalogue des interrupteurs, servi par le serveur
  annonces: [],      // historique des annonces envoyées
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
    state.featureList = session.features ?? [];
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
  $('saveOpening').addEventListener('click', saveOpening);
  $('saveFulfillment').addEventListener('click', saveFulfillment);
  $('addZone').addEventListener('click', () => addZoneRow());
  $('saveZones').addEventListener('click', saveZones);
  $('saveSlots').addEventListener('click', saveSlots);
  $('addTier').addEventListener('click', () => addTierRow());
  $('saveTiers').addEventListener('click', saveTiers);
  $('savePromo').addEventListener('click', savePromo);
  $('sendAnnounce').addEventListener('click', envoyerAnnonce);
  for (const id of ['fAnnounceDays', 'fAnnounceMin']) {
    $(id).addEventListener('input', compterAudience);
  }
  $('linkTarget').addEventListener('change', chargerLien);
  $('copyLink').addEventListener('click', copierLien);
  $('sendQr').addEventListener('click', envoyerQr);
  $('productLink').addEventListener('click', () => {
    const id = state.editing?.id;
    closeEditor();
    selectTab('settings');
    $('linkTarget').value = id ?? '';
    chargerLien();
    $('linkTarget').scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  $('exportCsv').addEventListener('click', exporterCommandes);
  $('downloadBackup').addEventListener('click', envoyerSauvegarde);
  $('pickBackup').addEventListener('click', () => $('restoreFile').click());
  $('restoreFile').addEventListener('change', lireSauvegarde);
  $('doRestore').addEventListener('click', restaurer);
  $('fPromoType').addEventListener('change', syncPromoValueLabel);
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
  const [catalog, orders, stats, settings, verifications, promos] = await Promise.all([
    api('/catalog'),
    api('/orders'),
    api('/stats'),
    api('/settings'),
    api('/verifications'),
    api('/promos'),
  ]);
  state.settings = settings;
  state.verifications = verifications;
  state.promos = promos;
  state.annonces = await api('/announcements').catch(() => []);
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
    ${livraisonBloc(order)}
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

/**
 * Où, quand, et pourquoi ce total-là.
 *
 * La carte ne montrait que la référence, le client et les articles : le
 * vendeur qui prépare depuis la Mini App ne savait ni où livrer ni à quelle
 * heure, et un total plus bas que la somme des lignes ressemblait à un bug.
 */
function livraisonBloc(order) {
  const livraison = order.mode === 'delivery';
  const lignes = [];

  lignes.push(
    livraison
      ? `🛵 Livraison${order.zone ? ` — ${escapeHtml(order.zone.name)} (${escapeHtml(order.zone.postalCode ?? '')})` : ''}`
      : '🏠 Retrait sur place'
  );
  if (order.slot?.label) lignes.push(`🕒 ${escapeHtml(order.slot.label)}`);
  if (order.contact) lignes.push(`📍 ${escapeHtml(order.contact)}`);

  // Le détail du calcul n'apparaît que s'il y a quelque chose à expliquer.
  if (order.discount || order.deliveryFee) {
    lignes.push(`Sous-total : ${formatPrice(order.subtotal ?? order.total)}`);
    if (order.discount) {
      lignes.push(
        `Remise${order.promoCode ? ` ${escapeHtml(order.promoCode)}` : ''} : −${formatPrice(order.discount)}` +
          `${order.discountLabel ? ` (${escapeHtml(order.discountLabel)})` : ''}`
      );
    }
    if (order.deliveryFee) lignes.push(`Frais de livraison : ${formatPrice(order.deliveryFee)}`);
  }

  return `<ul class="a-order__ship">${lignes.map((l) => `<li>${l}</li>`).join('')}</ul>`;
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
  // Un produit qui n'existe pas encore n'a pas de lien : il n'aurait nulle
  // part où mener.
  $('productLink').hidden = !product;
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
    <input class="a-variant__price" type="text" inputmode="decimal" placeholder="Prix"
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

const DAYS = [
  ['lun', 'Lundi'], ['mar', 'Mardi'], ['mer', 'Mercredi'], ['jeu', 'Jeudi'],
  ['ven', 'Vendredi'], ['sam', 'Samedi'], ['dim', 'Dimanche'],
];

function renderSettings() {
  const settings = state.settings;
  if (!settings) return;

  renderFeatures();
  renderLinkTargets();

  const opening = settings.opening ?? { open: true, hours: {} };
  $('fOpen').checked = Boolean(opening.open);
  $('fClosedMessage').value = opening.message ?? '';
  $('fTimezone').value = opening.hours?.timezone ?? 'Europe/Paris';
  // La grille ne s'affiche que si les horaires sont allumés : la régler pour
  // rien donnerait l'impression qu'ils s'appliquent.
  $('hoursBlock').hidden = !settings.features?.hours;
  renderHours(opening.hours?.days ?? {});

  const fulfillment = settings.fulfillment ?? {};
  $('fPickup').checked = Boolean(fulfillment.pickup);
  $('fDelivery').checked = Boolean(fulfillment.delivery);
  $('fDeliveryFee').value = ((fulfillment.deliveryFee ?? 0) / 100).toFixed(2);
  $('fFreeFrom').value = fulfillment.freeDeliveryFrom === null || fulfillment.freeDeliveryFrom === undefined
    ? ''
    : (fulfillment.freeDeliveryFrom / 100).toFixed(2);
  $('fMinimum').value = ((fulfillment.minimumOrder ?? 0) / 100).toFixed(2);

  renderAnnonces();
  compterAudience();
  renderZones(settings.zones ?? []);
  renderSlots(settings.slots ?? {});
  renderTiers(settings.discounts?.tiers ?? []);
  renderPromos();

  renderVerifications();
  $('fOrdersPerHour').value = settings.limits.ordersPerHour;
  $('fLowStock').value = settings.alerts?.lowStock ?? 3;
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

function renderHours(days) {
  $('hoursRows').replaceChildren(
    ...DAYS.map(([key, label]) => {
      const slot = days[key] ?? { closed: false, from: '10:00', to: '22:00' };
      const row = document.createElement('div');
      row.className = 'a-hours';
      row.dataset.day = key;
      row.innerHTML = `
        <span class="a-hours__day">${label}</span>
        <input class="a-hours__from" type="time" value="${escapeHtml(slot.from ?? '10:00')}" aria-label="Ouverture ${label}">
        <input class="a-hours__to" type="time" value="${escapeHtml(slot.to ?? '22:00')}" aria-label="Fermeture ${label}">
        <label class="a-hours__closed"><input type="checkbox" ${slot.closed ? 'checked' : ''}> fermé</label>`;

      const inputs = row.querySelectorAll('input[type="time"]');
      const closed = row.querySelector('.a-hours__closed input');
      const sync = () => inputs.forEach((i) => { i.disabled = closed.checked; });
      closed.addEventListener('change', sync);
      sync();
      return row;
    })
  );
}

async function saveOpening() {
  const button = $('saveOpening');
  button.disabled = true;
  try {
    const days = Object.fromEntries(
      [...$('hoursRows').children].map((row) => [
        row.dataset.day,
        {
          closed: row.querySelector('.a-hours__closed input').checked,
          from: row.querySelector('.a-hours__from').value,
          to: row.querySelector('.a-hours__to').value,
        },
      ])
    );

    state.settings = await api('/settings', {
      method: 'PUT',
      body: {
        opening: {
          open: $('fOpen').checked,
          message: $('fClosedMessage').value.trim(),
          hours: { timezone: $('fTimezone').value.trim(), days },
        },
      },
    });
    renderSettings();
    toast($('fOpen').checked ? 'Boutique ouverte' : 'Boutique fermée');
    haptic('success');
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
}

async function saveFulfillment() {
  const button = $('saveFulfillment');
  button.disabled = true;
  try {
    const franco = $('fFreeFrom').value.trim();
    state.settings = await api('/settings', {
      method: 'PUT',
      body: {
        fulfillment: {
          pickup: $('fPickup').checked,
          delivery: $('fDelivery').checked,
          deliveryFee: montantOuZero($('fDeliveryFee').value),
          // Champ vide : pas de franco du tout, ce qui n'est pas la même
          // chose qu'un franco à 0 € (livraison toujours offerte).
          freeDeliveryFrom: franco === '' ? null : toCents(franco),
          minimumOrder: montantOuZero($('fMinimum').value),
        },
      },
    });
    renderSettings();
    toast('Livraison enregistrée');
    haptic('success');
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
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
        alerts: { lowStock: Number($('fLowStock').value) },
      },
    });
    renderSettings();
    toast('Réglages enregistrés');
    haptic('success');
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
}

/* ── Annonces ────────────────────────────────────────────── */

/**
 * Combien de clients recevraient l'annonce, avec les critères courants.
 *
 * Affiché avant d'écrire : le vendeur doit savoir s'il parle à trois personnes
 * ou à trois cents avant de choisir son ton — et avant d'appuyer.
 */
let audienceTimer;
function compterAudience() {
  clearTimeout(audienceTimer);
  audienceTimer = setTimeout(async () => {
    const zone = $('announceAudience');
    const params = new URLSearchParams();
    if ($('fAnnounceDays').value) params.set('depuisJours', $('fAnnounceDays').value);
    if ($('fAnnounceMin').value) params.set('minCommandes', $('fAnnounceMin').value);

    try {
      const r = await api(`/announcements/audience?${params}`);
      zone.textContent = r.total
        ? `${r.total} client(s) recevraient ce message${r.apercu.length ? ` — ${r.apercu.join(', ')}${r.total > r.apercu.length ? '…' : ''}` : ''}.`
        : 'Personne ne correspond à ces critères pour le moment.';
    } catch (err) {
      zone.textContent = err.message;
    }
  }, 350);
}

async function envoyerAnnonce() {
  const texte = $('fAnnounce').value.trim();
  if (texte.length < 10) return toast('Une annonce fait au moins dix caractères.');

  const cibles = $('announceAudience').textContent;
  if (!confirm(`Envoyer cette annonce ?\n\n${cibles}`)) return;

  const bouton = $('sendAnnounce');
  bouton.disabled = true;
  try {
    const r = await api('/announcements', {
      method: 'POST',
      body: {
        texte,
        depuisJours: $('fAnnounceDays').value || undefined,
        minCommandes: $('fAnnounceMin').value || undefined,
        force: $('fAnnounceForce').checked,
      },
    });
    $('fAnnounce').value = '';
    $('fAnnounceForce').checked = false;
    toast(`Annonce partie vers ${r.cibles} client(s)`);
    haptic('success');
    // L'envoi continue en arrière-plan : on relit l'historique un peu plus
    // tard pour afficher le nombre réellement reçu.
    setTimeout(async () => {
      state.annonces = await api('/announcements').catch(() => state.annonces);
      renderAnnonces();
    }, 4000);
    state.annonces = await api('/announcements').catch(() => state.annonces);
    renderAnnonces();
  } catch (err) {
    toast(err.message);
  } finally {
    bouton.disabled = false;
  }
}

function renderAnnonces() {
  const liste = $('announceHistory');
  const envois = state.annonces ?? [];

  if (!envois.length) {
    liste.replaceChildren(Object.assign(document.createElement('li'), {
      className: 'a-empty', textContent: 'Aucune annonce envoyée.',
    }));
    return;
  }

  liste.replaceChildren(
    ...envois.map((envoi) => {
      const li = document.createElement('li');
      const quand = new Date(envoi.envoyeLe).toLocaleString('fr-FR', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      });
      const resultat = envoi.recus === null
        ? `envoi en cours vers ${envoi.cibles}`
        : `${envoi.recus} reçue(s)${envoi.echecs ? `, ${envoi.echecs} échec(s)` : ''}`;

      const info = document.createElement('span');
      info.className = 'a-promo';
      info.innerHTML =
        `<span class="a-promo__meta">${escapeHtml(quand)} · ${escapeHtml(resultat)}</span>` +
        `<span>${escapeHtml(envoi.texte.slice(0, 90))}${envoi.texte.length > 90 ? '…' : ''}</span>`;
      li.append(info);
      return li;
    })
  );
}

/* ── Liens directs et QR codes ───────────────────────────── */

/** Ce que le dernier chargement a rendu, pour le copier sans redemander. */
let lienCourant = null;

/**
 * Remplit le menu des destinations.
 *
 * Les articles masqués y figurent quand même, avec la mention : on prépare
 * souvent le flyer avant de mettre l'article en ligne, et découvrir à ce
 * moment-là qu'il faudra le rendre visible vaut mieux que le découvrir
 * imprimé.
 */
function renderLinkTargets() {
  const select = $('linkTarget');
  const choisi = select.value;
  fillSelect(select, [
    ['', '🏪 La boutique'],
    ...state.products.map((p) => [p.id, `${p.name}${p.visible === false ? ' (masqué)' : ''}`]),
  ]);
  select.value = state.products.some((p) => p.id === choisi) ? choisi : '';
}

async function chargerLien() {
  const cible = $('linkTarget').value;
  const erreur = $('linkError');
  erreur.hidden = true;
  $('linkBox').hidden = true;

  try {
    const r = await api(`/link${cible ? `?product=${encodeURIComponent(cible)}` : ''}`);
    lienCourant = r;
    // Le SVG vient de notre propre générateur : il n'y a là-dedans qu'un
    // rectangle et un chemin, tous deux faits de nombres.
    $('linkQr').innerHTML = r.svg;
    $('linkUrl').textContent = r.url;
    $('linkWarn').textContent = r.hidden
      ? "Cet article est masqué : le lien ouvrira la boutique sans le montrer. Rends-le visible avant d'imprimer."
      : '';
    $('linkWarn').hidden = !r.hidden;
    $('linkBox').hidden = false;
  } catch (err) {
    lienCourant = null;
    erreur.textContent = err.message;
    erreur.hidden = false;
  }
}

/**
 * Copie le lien.
 *
 * `navigator.clipboard` n'est pas toujours là dans la WebView de Telegram :
 * on retombe alors sur une sélection, que le vendeur copie d'un appui long.
 */
async function copierLien() {
  if (!lienCourant) return;
  try {
    await navigator.clipboard.writeText(lienCourant.url);
    toast('Lien copié');
    haptic('success');
  } catch {
    const plage = document.createRange();
    plage.selectNodeContents($('linkUrl'));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(plage);
    toast('Appui long sur le lien pour le copier');
  }
}

async function envoyerQr() {
  const bouton = $('sendQr');
  bouton.disabled = true;
  try {
    const cible = $('linkTarget').value;
    await api('/link/send', { method: 'POST', body: { product: cible || undefined } });
    toast('QR envoyé dans la conversation');
    haptic('success');
  } catch (err) {
    toast(err.message);
  } finally {
    bouton.disabled = false;
  }
}

/* ── Export et sauvegarde ────────────────────────────────── */

/** La sauvegarde choisie, gardée le temps de la confirmation. */
let sauvegardeChoisie = null;

async function exporterCommandes() {
  const bouton = $('exportCsv');
  bouton.disabled = true;
  try {
    const r = await api('/export/orders/send', {
      method: 'POST',
      body: { from: $('fExportFrom').value || undefined, to: $('fExportTo').value || undefined },
    });
    toast(`${r.orders} commande(s) envoyées dans la conversation`);
    haptic('success');
  } catch (err) {
    toast(err.message);
  } finally {
    bouton.disabled = false;
  }
}

async function envoyerSauvegarde() {
  const bouton = $('downloadBackup');
  bouton.disabled = true;
  try {
    const r = await api('/backup/send', { method: 'POST' });
    toast(`Sauvegarde envoyée dans la conversation (${Math.round(r.octets / 1024)} Ko)`);
    haptic('success');
  } catch (err) {
    toast(err.message);
  } finally {
    bouton.disabled = false;
  }
}

/**
 * Lit le fichier choisi et dit ce qu'il contient.
 *
 * On montre le contenu avant de proposer le remplacement : restaurer efface
 * la boutique, et personne ne doit découvrir après coup qu'il a chargé la
 * sauvegarde du mois dernier.
 */
async function lireSauvegarde(event) {
  const fichier = event.target.files?.[0];
  event.target.value = '';
  if (!fichier) return;

  const zone = $('restorePreview');
  zone.hidden = true;
  sauvegardeChoisie = null;

  try {
    const texte = await fichier.text();
    const data = JSON.parse(texte);
    const resume = await api('/backup/inspect', { method: 'POST', body: data });

    sauvegardeChoisie = data;
    const quand = resume.exportedAt
      ? new Date(resume.exportedAt).toLocaleString('fr-FR')
      : 'date inconnue';
    $('restoreSummary').textContent =
      `Sauvegarde du ${quand} : ${resume.products} produit(s), ${resume.categories} catégorie(s), ` +
      `${resume.orders} commande(s), ${resume.promos} code(s).`;
    zone.hidden = false;
  } catch (err) {
    toast(err instanceof SyntaxError ? 'Ce fichier n\'est pas une sauvegarde.' : err.message);
  }
}

async function restaurer() {
  if (!sauvegardeChoisie) return;
  if (!confirm('Remplacer toute la boutique par cette sauvegarde ? Les données actuelles seront perdues.')) return;

  const bouton = $('doRestore');
  bouton.disabled = true;
  try {
    const fait = await api('/backup/restore', { method: 'POST', body: sauvegardeChoisie });
    sauvegardeChoisie = null;
    $('restorePreview').hidden = true;
    toast(`Restauré : ${fait.catalogue.products} produits, ${fait.commandes.orders} commandes`);
    haptic('success');
    await refreshAll();
  } catch (err) {
    toast(err.message);
  } finally {
    bouton.disabled = false;
  }
}

/* ── Tableau de bord des fonctionnalités ─────────────────── */

function renderFeatures() {
  const values = state.settings?.features ?? {};

  $('featureList').replaceChildren(
    ...state.featureList.map(({ key, label, hint }) => {
      const row = document.createElement('label');
      row.className = 'a-feature';

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(values[key]);
      input.addEventListener('change', () => toggleFeature(key, input));

      const text = document.createElement('span');
      text.className = 'a-feature__text';
      text.innerHTML = `<b>${escapeHtml(label)}</b><small>${escapeHtml(hint)}</small>`;

      row.append(input, text);
      return row;
    })
  );
}

/**
 * Un interrupteur s'applique tout de suite.
 *
 * Pas de bouton « Enregistrer » : sur un tableau de bord, un état coché mais
 * pas encore enregistré est un piège — on croit avoir coupé une fonctionnalité
 * qui tourne toujours. En cas d'échec, la case revient à sa position réelle.
 */
async function toggleFeature(key, input) {
  const wanted = input.checked;
  input.disabled = true;
  try {
    state.settings = await api('/settings', { method: 'PUT', body: { features: { [key]: wanted } } });
    renderSettings();
    const label = state.featureList.find((f) => f.key === key)?.label ?? key;
    toast(`${label} ${wanted ? 'activé' : 'désactivé'}`);
    haptic('success');
  } catch (err) {
    input.checked = !wanted;
    toast(err.message);
  } finally {
    input.disabled = false;
  }
}

/* ── Zones de livraison ──────────────────────────────────── */

function renderZones(zones) {
  $('zoneRows').replaceChildren(...zones.map((zone) => zoneRow(zone)));
}

function zoneRow(zone = {}) {
  const box = document.createElement('div');
  box.className = 'a-zone';
  box.innerHTML = `
    <div class="a-zone__head">
      <input class="a-zone__name" maxlength="40" placeholder="Nom du secteur"
             value="${escapeHtml(zone.name ?? '')}" aria-label="Nom de la zone">
    </div>
    <input class="a-zone__codes" placeholder="Codes postaux : 68000, 68001…"
           value="${escapeHtml((zone.postalCodes ?? []).join(', '))}" aria-label="Codes postaux">
    <div class="a-row">
      <label class="a-field"><span>Frais (€)</span>
        <input class="a-zone__fee" type="text" inputmode="decimal"
               value="${((zone.fee ?? 0) / 100).toFixed(2)}"></label>
      <label class="a-field"><span>Minimum (€)</span>
        <input class="a-zone__min" type="text" inputmode="decimal"
               placeholder="général" value="${zone.minimumOrder == null ? '' : (zone.minimumOrder / 100).toFixed(2)}"></label>
      <label class="a-field"><span>Franco (€)</span>
        <input class="a-zone__franco" type="text" inputmode="decimal"
               placeholder="général" value="${zone.freeFrom == null ? '' : (zone.freeFrom / 100).toFixed(2)}"></label>
    </div>`;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'a-btn a-btn--sm a-btn--danger';
  remove.textContent = 'Retirer la zone';
  remove.addEventListener('click', () => box.remove());
  box.querySelector('.a-zone__head').append(remove);
  return box;
}

function addZoneRow() {
  $('zoneRows').append(zoneRow());
}

async function saveZones() {
  const button = $('saveZones');
  button.disabled = true;
  try {
    const zones = [...$('zoneRows').children].map((box) => ({
      name: box.querySelector('.a-zone__name').value,
      postalCodes: box.querySelector('.a-zone__codes').value,
      fee: toCents(box.querySelector('.a-zone__fee').value),
      // Vide veut dire « celui de la boutique », ce qui n'est pas zéro.
      minimumOrder: optional(box.querySelector('.a-zone__min').value),
      freeFrom: optional(box.querySelector('.a-zone__franco').value),
    }));

    state.settings = await api('/settings', { method: 'PUT', body: { zones } });
    renderSettings();
    // Une zone sans nom ou sans code postal est écartée à l'enregistrement :
    // le dire évite de croire qu'elle est passée.
    const gardees = state.settings.zones.length;
    toast(gardees === zones.length ? 'Zones enregistrées' : `${gardees} zone(s) sur ${zones.length} retenue(s)`);
    haptic('success');
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
}

function optional(value) {
  return String(value).trim() === '' ? null : toCents(value);
}

/** Champ laissé vide : c'est zéro, et non « ne touche à rien ». */
function montantOuZero(value) {
  return String(value ?? '').trim() === '' ? 0 : toCents(value);
}

/* ── Créneaux ────────────────────────────────────────────── */

function renderSlots(slots) {
  $('slotsBlock').hidden = !slots.enabled;
  $('fSlotLead').value = slots.leadMinutes ?? 60;
  $('fSlotDays').value = slots.daysAhead ?? 7;

  $('slotRows').replaceChildren(
    ...DAYS.map(([key, label]) => {
      const box = document.createElement('div');
      box.className = 'a-slotday';
      box.dataset.day = key;
      box.innerHTML = `<div class="a-slotday__head"><span>${label}</span></div><div class="a-slotday__rows"></div>`;

      const rows = box.querySelector('.a-slotday__rows');
      for (const slot of slots.days?.[key] ?? []) rows.append(slotRow(slot));

      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'a-btn a-btn--sm a-btn--ghost';
      add.textContent = '+ créneau';
      add.addEventListener('click', () => rows.append(slotRow()));
      box.querySelector('.a-slotday__head').append(add);
      return box;
    })
  );
}

function slotRow({ from = '18:00', to = '20:00', capacity = 10 } = {}) {
  const row = document.createElement('div');
  row.className = 'a-slot';
  row.innerHTML = `
    <input class="a-slot__from" type="time" value="${escapeHtml(from)}" aria-label="Début">
    <span class="a-slot__unit">→</span>
    <input class="a-slot__to" type="time" value="${escapeHtml(to)}" aria-label="Fin">
    <input class="a-slot__cap" type="number" min="1" max="999" inputmode="numeric"
           value="${Number(capacity)}" aria-label="Places">
    <span class="a-slot__unit">pl.</span>`;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'a-btn a-btn--sm a-btn--ghost';
  remove.textContent = '✕';
  remove.setAttribute('aria-label', 'Retirer ce créneau');
  remove.addEventListener('click', () => row.remove());
  row.append(remove);
  return row;
}

async function saveSlots() {
  const button = $('saveSlots');
  button.disabled = true;
  try {
    const days = Object.fromEntries(
      [...$('slotRows').children].map((box) => [
        box.dataset.day,
        [...box.querySelectorAll('.a-slot')].map((row) => ({
          from: row.querySelector('.a-slot__from').value,
          to: row.querySelector('.a-slot__to').value,
          capacity: Number(row.querySelector('.a-slot__cap').value),
        })),
      ])
    );

    state.settings = await api('/settings', {
      method: 'PUT',
      body: {
        slots: {
          leadMinutes: Number($('fSlotLead').value),
          daysAhead: Number($('fSlotDays').value),
          days,
        },
      },
    });
    renderSettings();
    toast('Créneaux enregistrés');
    haptic('success');
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
}

/* ── Remises ─────────────────────────────────────────────── */

function renderTiers(tiers) {
  $('tierRows').replaceChildren(...tiers.map((t) => tierRow(t)));
}

function tierRow({ from = 0, percent = 5 } = {}) {
  const row = document.createElement('div');
  row.className = 'a-tier';
  row.innerHTML = `
    <span class="a-tier__unit">dès</span>
    <input class="a-tier__from" type="text" inputmode="decimal"
           value="${(from / 100).toFixed(2)}" aria-label="Montant du palier en euros">
    <span class="a-tier__unit">€ →</span>
    <input class="a-tier__percent" type="number" min="1" max="90" inputmode="numeric"
           value="${Number(percent)}" aria-label="Pourcentage de remise">
    <span class="a-tier__unit">%</span>`;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'a-btn a-btn--sm a-btn--ghost';
  remove.textContent = '✕';
  remove.setAttribute('aria-label', 'Retirer ce palier');
  remove.addEventListener('click', () => row.remove());
  row.append(remove);
  return row;
}

function addTierRow() {
  if ($('tierRows').children.length >= 5) return toast('Cinq paliers au maximum.');
  $('tierRows').append(tierRow());
}

async function saveTiers() {
  const button = $('saveTiers');
  button.disabled = true;
  try {
    const tiers = [...$('tierRows').children].map((row) => ({
      from: toCents(row.querySelector('.a-tier__from').value),
      percent: Number(row.querySelector('.a-tier__percent').value),
    }));
    state.settings = await api('/settings', { method: 'PUT', body: { discounts: { tiers } } });
    renderSettings();
    toast(tiers.length ? 'Paliers enregistrés' : 'Paliers retirés');
    haptic('success');
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
}

function syncPromoValueLabel() {
  $('fPromoValueLabel').textContent =
    $('fPromoType').value === 'percent' ? 'Remise (%)' : 'Remise (€)';
}

function renderPromos() {
  const list = $('promosList');
  if (!state.promos.length) {
    list.replaceChildren(Object.assign(document.createElement('li'), {
      className: 'a-empty', textContent: 'Aucun code pour le moment.',
    }));
    return;
  }

  list.replaceChildren(
    ...state.promos.map((promo) => {
      const li = document.createElement('li');
      const epuise = promo.maxUses !== null && promo.uses >= promo.maxUses;
      const expire = promo.expiresAt && promo.expiresAt < new Date().toISOString().slice(0, 10);
      if (!promo.active || epuise || expire) li.className = 'a-promo--off';

      const valeur = promo.type === 'percent' ? `−${promo.value} %` : `−${formatPrice(promo.value)}`;
      const details = [
        promo.minSubtotal ? `dès ${formatPrice(promo.minSubtotal)}` : null,
        promo.maxUses !== null ? `${promo.uses}/${promo.maxUses} usages` : `${promo.uses} usages`,
        promo.expiresAt ? `jusqu'au ${promo.expiresAt}` : null,
        promo.oncePerClient ? '1×/client' : null,
        !promo.active ? 'désactivé' : epuise ? 'épuisé' : expire ? 'expiré' : null,
      ].filter(Boolean);

      const info = document.createElement('span');
      info.className = 'a-promo';
      info.innerHTML = `
        <span class="a-promo__code">${escapeHtml(promo.code)} · ${escapeHtml(valeur)}</span>
        <span class="a-promo__meta">${escapeHtml(details.join(' · '))}</span>`;
      li.append(info);

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'a-btn a-btn--sm a-btn--ghost';
      edit.textContent = 'Modifier';
      edit.addEventListener('click', () => fillPromoForm(promo));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'a-btn a-btn--sm a-btn--danger';
      remove.textContent = 'Supprimer';
      remove.addEventListener('click', () => removePromo(promo.code, remove));

      li.append(edit, remove);
      return li;
    })
  );
}

/** Recharge le formulaire depuis un code existant : l'enregistrer l'écrase,
 *  en gardant son compteur d'usages. */
function fillPromoForm(promo) {
  $('fPromoCode').value = promo.code;
  $('fPromoType').value = promo.type;
  $('fPromoValue').value = promo.type === 'percent' ? promo.value : (promo.value / 100).toFixed(2);
  $('fPromoMin').value = promo.minSubtotal ? (promo.minSubtotal / 100).toFixed(2) : '';
  $('fPromoExpires').value = promo.expiresAt ?? '';
  $('fPromoMaxUses').value = promo.maxUses ?? '';
  $('fPromoOnce').checked = promo.oncePerClient;
  $('fPromoActive').checked = promo.active;
  syncPromoValueLabel();
  $('fPromoCode').scrollIntoView({ block: 'center', behavior: 'smooth' });
}

async function savePromo() {
  const button = $('savePromo');
  button.disabled = true;
  try {
    const type = $('fPromoType').value;
    const brut = $('fPromoValue').value;
    const min = $('fPromoMin').value.trim();
    const maxUses = $('fPromoMaxUses').value.trim();

    state.promos = await api('/promos', {
      method: 'PUT',
      body: {
        code: $('fPromoCode').value,
        type,
        // Un pourcentage est un entier, un montant est en centimes : deux
        // unités différentes derrière le même champ.
        value: type === 'percent' ? Number(brut) : toCents(brut),
        minSubtotal: min === '' ? 0 : toCents(min),
        expiresAt: $('fPromoExpires').value || null,
        maxUses: maxUses === '' ? null : Number(maxUses),
        oncePerClient: $('fPromoOnce').checked,
        active: $('fPromoActive').checked,
      },
    });
    renderPromos();
    toast('Code enregistré');
    haptic('success');
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
}

async function removePromo(code, button) {
  button.disabled = true;
  try {
    state.promos = await api(`/promos/${encodeURIComponent(code)}`, { method: 'DELETE' });
    renderPromos();
    toast('Code supprimé');
  } catch (err) {
    toast(err.message);
    button.disabled = false;
  }
}

const VERIF_LABELS = {
  pending: '⏳ En attente',
  approved: '✅ Validé',
  refused: '❌ Refusé',
};

function renderVerifications() {
  const list = $('verificationsList');
  if (!state.verifications.length) {
    list.replaceChildren(Object.assign(document.createElement('li'), {
      className: 'a-empty', textContent: 'Aucune demande pour le moment.',
    }));
    return;
  }

  list.replaceChildren(
    ...state.verifications.map((record) => {
      const li = document.createElement('li');
      const when = record.requestedAt
        ? new Date(record.requestedAt).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })
        : '';
      li.innerHTML = `<span>#${escapeHtml(record.id)}
        <span class="a-muted">${escapeHtml(VERIF_LABELS[record.status] ?? record.status)}${when ? ` · ${when}` : ''}</span></span>`;

      const actions = document.createElement('span');
      actions.className = 'a-verif__actions';
      for (const [status, label] of [['approved', '✅'], ['refused', '❌'], ['none', '↩︎']]) {
        if (record.status === status) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'a-btn a-btn--sm a-btn--ghost';
        btn.textContent = label;
        btn.title = { approved: 'Valider', refused: 'Refuser', none: 'Réinitialiser' }[status];
        btn.addEventListener('click', () => decideVerification(record.id, status, btn));
        actions.append(btn);
      }
      li.append(actions);
      return li;
    })
  );
}

async function decideVerification(id, status, button) {
  button.disabled = true;
  try {
    await api(`/verifications/${id}`, { method: 'POST', body: { status } });
    state.verifications = await api('/verifications');
    renderVerifications();
    toast('Vérification mise à jour');
    haptic('success');
  } catch (err) {
    toast(err.message);
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

/**
 * Un montant saisi, en centimes.
 *
 * `Number('')` vaut zéro : sans ce garde-fou, un champ prix resté vide — ou
 * vidé par un `input[type=number]` qui refuse la virgule — enregistrait le
 * produit à 0 €. NaN remonte maintenant jusqu'au message d'erreur.
 */
function toCents(value) {
  const texte = String(value ?? '').trim().replace(',', '.');
  if (!texte) return NaN;
  const number = Number(texte);
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
