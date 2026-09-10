/* ══════════════════════════════════════════════════════════════
   COFFEE SHOP 68 — logique de la Mini App
   ══════════════════════════════════════════════════════════════ */

const tg = window.Telegram?.WebApp;
const CART_KEY = 'kartoon.cart.v1';
const AGE_KEY = 'kartoon.age.ok';
const PASS_KEY = 'kartoon.pass';

const state = {
  shop: { shopName: 'COFFEE SHOP 68', currency: 'EUR', sellerUsername: '' },
  categories: [],
  products: [],
  statuses: {},
  category: 'all',
  gates: {},
  opening: { open: true },
  fulfillment: { pickup: true, delivery: false, deliveryFee: 0, freeDeliveryFrom: null, minimumOrder: 0 },
  mode: 'pickup',
  captcha: null,      // épreuve en cours
  selection: [],      // tuiles touchées
  cart: loadCart(),
  current: null, // produit ouvert dans la fiche
  currentVariant: null,
  currentQty: 1,
};

const $ = (id) => document.getElementById(id);

/* ── Démarrage ───────────────────────────────────────────── */

init();

async function init() {
  if (tg) {
    tg.ready();
    tg.expand();
    const night = themeHex('--night-rgb', '#04160f');
    tg.setHeaderColor?.(night);
    tg.setBackgroundColor?.(night);
    tg.enableClosingConfirmation?.();
    tg.BackButton?.onClick(closeSheets);
    tg.MainButton?.onClick(() => openSheet('cartSheet'));
  }

  bindStaticHandlers();
  gateAge();

  try {
    const res = await fetch('/api/catalog');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.shop = data.shop;
    state.categories = data.categories;
    state.products = data.products;
    state.statuses = data.statuses ?? {};
    state.gates = data.gates ?? {};
    state.opening = data.opening ?? { open: true };
    state.fulfillment = data.fulfillment ?? state.fulfillment;
    state.mode = state.fulfillment.pickup ? 'pickup' : 'delivery';
  } catch (err) {
    console.error(err);
    toast("Catalogue indisponible, réessaie dans un instant.");
    return;
  }

  $('shopName').textContent = state.shop.shopName;
  document.title = `${state.shop.shopName} — Boutique`;
  const legal =
    "Produits réservés aux personnes majeures. Vérifie la législation en vigueur " +
    'chez toi avant toute commande : la disponibilité de ces produits dépend de ta juridiction.';
  $('legalNotice').textContent = legal;
  $('footLegal').textContent = legal;

  renderClosedBanner();
  renderModes();
  renderCategories();
  renderGrid();
  renderCart();
  gateCaptcha();
  gateVerification();
}

function bindStaticHandlers() {
  $('ageYes').addEventListener('click', () => {
    try { localStorage.setItem(AGE_KEY, '1'); } catch {}
    $('agegate').hidden = true;
    haptic('light');
  });
  $('ageNo').addEventListener('click', () => (tg ? tg.close() : window.history.back()));

  $('cartBtn').addEventListener('click', () => openSheet('cartSheet'));
  $('ordersBtn').addEventListener('click', openOrders);
  $('captchaSubmit').addEventListener('click', submitCaptcha);
  // Fermer la Mini App ramène le client dans la conversation du bot, là où il
  // envoie sa pièce : pas besoin de connaître le nom du bot.
  $('verifAction').addEventListener('click', () => (tg ? tg.close() : window.history.back()));
  $('checkout').addEventListener('click', checkout);

  $('qtyMinus').addEventListener('click', () => setQty(state.currentQty - 1));
  $('qtyPlus').addEventListener('click', () => setQty(state.currentQty + 1));
  $('addToCart').addEventListener('click', addCurrentToCart);
  $('notifyMe').addEventListener('click', joinWaitlist);

  for (const el of document.querySelectorAll('[data-close]')) {
    el.addEventListener('click', closeSheets);
  }
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeSheets());
}

/* ── Retrait ou livraison ────────────────────────────────── */

function renderModes() {
  const { pickup, delivery, deliveryFee } = state.fulfillment;
  // Un seul mode possible : inutile de faire choisir.
  $('modeField').hidden = !(pickup && delivery);
  if (!(pickup && delivery)) return;

  const options = [
    ['pickup', '🏠 Retrait', 'sur place'],
    ['delivery', '🛵 Livraison', deliveryFee ? formatPrice(deliveryFee) : 'offerte'],
  ];

  $('modes').replaceChildren(
    ...options.map(([value, label, detail]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mode';
      btn.setAttribute('aria-pressed', String(state.mode === value));
      btn.innerHTML = `${label}<small>${escapeHtml(detail)}</small>`;
      btn.addEventListener('click', () => {
        state.mode = value;
        haptic('light');
        renderModes();
        renderCart();
      });
      return btn;
    })
  );
}

/** Frais réellement dus : le franco peut les annuler. */
function deliveryFeeFor(subtotal) {
  const { delivery, deliveryFee, freeDeliveryFrom } = state.fulfillment;
  if (state.mode !== 'delivery' || !delivery) return 0;
  if (freeDeliveryFrom !== null && subtotal >= freeDeliveryFrom) return 0;
  return deliveryFee;
}

/** Boutique fermée : on le dit, et on empêche la commande. */
function renderClosedBanner() {
  const banner = $('closedBanner');
  if (state.opening.open) {
    banner.hidden = true;
    return;
  }
  banner.textContent = state.opening.message ?? 'La boutique est fermée pour le moment.';
  banner.hidden = false;
}

/* ── Vérification d'identité ─────────────────────────────── */

/**
 * Quand le vendeur l'exige, la boutique reste fermée tant que la pièce n'a
 * pas été validée. L'écran dit où on en est plutôt que de rester muet.
 */
async function gateVerification() {
  if (!state.gates.verification || !tg?.initData) return;

  let me;
  try {
    const res = await fetch('/api/me', { headers: { 'X-Telegram-Init-Data': tg.initData } });
    if (!res.ok) return;
    me = await res.json();
  } catch (err) {
    console.error(err);
    return;
  }

  const status = me.verification.status;
  if (status === 'approved') return;

  const texts = {
    none: "Pour commander ici, une pièce d'identité doit être validée. Envoie-la en photo dans la conversation du bot : le vendeur la regarde et te répond.",
    pending: 'Ta pièce est en cours de vérification. Tu recevras la réponse dans la conversation du bot.',
    refused: "La vérification a été refusée. Écris-nous dans la conversation si tu penses que c'est une erreur.",
  };
  const titles = {
    none: 'Vérification requise',
    pending: 'En cours de vérification',
    refused: 'Vérification refusée',
  };

  $('verifTitle').textContent = titles[status] ?? titles.none;
  $('verifText').textContent = texts[status] ?? texts.none;
  $('verification').hidden = false;
}

/* ── Épreuve d'entrée ────────────────────────────────────── */

/** Rien à demander si l'épreuve est désactivée ou déjà passée aujourd'hui. */
function gateCaptcha() {
  if (!state.gates.captcha || !tg?.initData) return;
  if (readPass()) return;
  openCaptcha();
}

async function openCaptcha() {
  const error = $('captchaError');
  error.hidden = true;
  $('captcha').hidden = false;

  try {
    const res = await fetch('/api/captcha', {
      headers: { 'X-Telegram-Init-Data': tg?.initData ?? '' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const challenge = await res.json();

    if (!challenge.required) {
      $('captcha').hidden = true;
      return;
    }

    state.captcha = challenge;
    state.selection = [];
    $('captchaPrompt').textContent = challenge.prompt;
    $('captchaSubmit').disabled = true;
    renderTiles();
  } catch (err) {
    console.error(err);
    error.textContent = 'Vérification indisponible. Réessaie dans un instant.';
    error.hidden = false;
  }
}

function renderTiles() {
  $('captchaGrid').replaceChildren(
    ...state.captcha.tiles.map((tile, index) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tile';
      btn.textContent = tile;
      btn.setAttribute('aria-pressed', String(state.selection.includes(index)));
      btn.addEventListener('click', () => {
        const picked = !state.selection.includes(index);
        state.selection = picked
          ? [...state.selection, index]
          : state.selection.filter((i) => i !== index);
        // On bascule la tuile touchée plutôt que de refaire la grille :
        // redessiner ferait perdre le focus au clavier à chaque appui.
        btn.setAttribute('aria-pressed', String(picked));
        $('captchaSubmit').disabled = state.selection.length === 0;
        haptic('light');
      });
      return btn;
    })
  );
}

async function submitCaptcha() {
  const button = $('captchaSubmit');
  const error = $('captchaError');
  button.disabled = true;
  error.hidden = true;

  try {
    const res = await fetch('/api/captcha', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': tg?.initData ?? '',
      },
      body: JSON.stringify({
        nonce: state.captcha.nonce,
        expiresAt: state.captcha.expiresAt,
        token: state.captcha.token,
        selection: state.selection,
      }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      error.textContent = data.error ?? 'Raté. Essaie encore.';
      error.hidden = false;
      haptic('light');
      // Nouvelle grille : sinon on rejoue la même jusqu'à tomber juste.
      await openCaptcha();
      return;
    }

    writePass(data.pass);
    $('captcha').hidden = true;
    haptic('success');
  } catch (err) {
    console.error(err);
    error.textContent = 'Vérification indisponible. Réessaie dans un instant.';
    error.hidden = false;
    button.disabled = false;
  }
}

function readPass() {
  try { return localStorage.getItem(PASS_KEY); } catch { return null; }
}

function writePass(pass) {
  try { localStorage.setItem(PASS_KEY, pass ?? ''); } catch {}
}

function gateAge() {
  let confirmed = false;
  try { confirmed = localStorage.getItem(AGE_KEY) === '1'; } catch {}
  $('agegate').hidden = confirmed;
}

/* ── Rendu ───────────────────────────────────────────────── */

function renderCategories() {
  const nav = $('cats');
  nav.replaceChildren(
    ...state.categories.map((cat) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cat';
      btn.textContent = `${cat.emoji} ${cat.label}`;
      btn.setAttribute('aria-pressed', String(cat.id === state.category));
      btn.addEventListener('click', () => {
        state.category = cat.id;
        haptic('light');
        renderCategories();
        renderGrid();
      });
      return btn;
    })
  );
}

function renderGrid() {
  const grid = $('grid');
  const list =
    state.category === 'all'
      ? state.products
      : state.products.filter((p) => p.category === state.category);

  $('empty').hidden = list.length > 0;
  grid.replaceChildren(...list.map(productCard));
}

function productCard(product) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'card';
  card.setAttribute('aria-label', `${product.name}, ${formatPrice(product.price)}`);

  const soldOut = isSoldOut(product);
  if (soldOut) card.classList.add('card--soldout');

  const fromLabel = product.variants ? '<small>dès</small> ' : '';
  const badge = soldOut ? 'ÉPUISÉ' : product.badge;
  card.innerHTML = `
    <div class="card__art${isPhoto(product.image) ? ' card__art--photo' : ''}">
      ${badge ? `<span class="card__badge ${soldOut ? 'card__badge--out' : ''}">${escapeHtml(badge)}</span>` : ''}
      <img src="${product.image}" alt="" loading="lazy">
    </div>
    <div class="card__body">
      <span class="card__name">${escapeHtml(product.name)}</span>
      <span class="card__short">${escapeHtml(product.short)}</span>
      <span class="card__foot">
        <span class="card__price goldtext">${fromLabel}${formatPrice(product.price)}</span>
        <span class="card__add" aria-hidden="true">+</span>
      </span>
    </div>`;

  card.addEventListener('click', () => openProduct(product));
  return card;
}

function openProduct(product) {
  state.current = product;
  // On présélectionne le premier format encore disponible plutôt que le premier tout court.
  state.currentVariant = product.variants
    ? (product.variants.find((v) => Number(v.stock ?? 0) > 0) ?? product.variants[0]).id
    : null;
  state.currentQty = 1;

  $('pImage').src = product.image;
  $('pImage').alt = product.name;
  $('pImage').closest('.pdetail__art').classList.toggle('pdetail__art--photo', isPhoto(product.image));
  $('pName').textContent = product.name;
  $('pDesc').textContent = product.description;

  $('pTags').replaceChildren(
    ...(product.tags ?? []).map((t) => {
      const span = document.createElement('span');
      span.className = 'tag';
      span.textContent = t;
      return span;
    })
  );

  renderVariants();
  setQty(1);
  openSheet('productSheet');
  haptic('light');
}

function renderVariants() {
  const box = $('pVariants');
  const product = state.current;
  if (!product?.variants) {
    box.replaceChildren();
    return;
  }
  box.replaceChildren(
    ...product.variants.map((v) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'variant';
      btn.setAttribute('aria-pressed', String(v.id === state.currentVariant));
      btn.disabled = Number(v.stock ?? 0) <= 0;
      btn.innerHTML = `${escapeHtml(v.label)}<small>${
        btn.disabled ? 'épuisé' : formatPrice(v.price)
      }</small>`;
      btn.addEventListener('click', () => {
        state.currentVariant = v.id;
        renderVariants();
        setQty(state.currentQty);
        haptic('light');
      });
      return btn;
    })
  );
}

function setQty(next) {
  const product = state.current;
  const available = product ? remainingFor(product, state.currentVariant) : 0;

  state.currentQty = Math.min(99, Math.max(1, next), Math.max(1, available));
  $('qtyValue').textContent = state.currentQty;

  const addButton = $('addToCart');
  const notify = $('notifyMe');

  if (available <= 0) {
    // Épuisé : plutôt qu'un bouton mort, on propose d'être prévenu.
    addButton.hidden = true;
    $('qtyValue').closest('.qty').hidden = true;
    notify.hidden = false;
    refreshWaitlistButton();
    return;
  }

  addButton.hidden = false;
  $('qtyValue').closest('.qty').hidden = false;
  notify.hidden = true;
  addButton.disabled = false;
  addButton.firstChild.textContent = 'Ajouter · ';
  $('pPrice').textContent = formatPrice(unitPrice(product, state.currentVariant) * state.currentQty);

  // On signale la fin de série : c'est ce qui fait bouger un panier.
  $('qtyPlus').disabled = state.currentQty >= available;
}

/* ── Liste d'attente ─────────────────────────────────────── */

/** Le bouton dit si le client est déjà inscrit pour cet article. */
async function refreshWaitlistButton() {
  const notify = $('notifyMe');
  notify.disabled = false;
  notify.textContent = '🔔 Préviens-moi du retour';
  if (!tg?.initData) return;

  try {
    const params = new URLSearchParams({ id: state.current.id });
    if (state.currentVariant) params.set('variantId', state.currentVariant);
    const res = await fetch(`/api/waitlist?${params}`, {
      headers: { 'X-Telegram-Init-Data': tg.initData },
    });
    if (!res.ok) return;
    if ((await res.json()).subscribed) {
      notify.disabled = true;
      notify.textContent = '🔔 Tu seras prévenu';
    }
  } catch (err) {
    console.warn(err);
  }
}

async function joinWaitlist() {
  const notify = $('notifyMe');
  notify.disabled = true;

  try {
    const res = await fetch('/api/waitlist', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': tg?.initData ?? '',
      },
      body: JSON.stringify({ id: state.current.id, variantId: state.currentVariant }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      toast(data.error ?? 'Inscription impossible.');
      notify.disabled = false;
      return;
    }

    notify.textContent = '🔔 Tu seras prévenu';
    toast('On t\'écrit dès que ça revient.');
    haptic('success');
  } catch (err) {
    console.error(err);
    toast('Inscription impossible pour le moment.');
    notify.disabled = false;
  }
}

/* ── Panier ──────────────────────────────────────────────── */

function loadCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) ?? '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveCart() {
  try { localStorage.setItem(CART_KEY, JSON.stringify(state.cart)); } catch {}
}

function addCurrentToCart() {
  const product = state.current;
  if (!product) return;

  const key = `${product.id}::${state.currentVariant ?? ''}`;
  const available = stockOf(product, state.currentVariant);
  const existing = state.cart.find((l) => l.key === key);
  if (existing) {
    existing.quantity = Math.min(99, available, existing.quantity + state.currentQty);
  } else {
    state.cart.push({
      key,
      id: product.id,
      variantId: state.currentVariant,
      quantity: state.currentQty,
    });
  }

  saveCart();
  renderCart();
  closeSheets();
  haptic('success');
  toast(`${product.name} ajouté au panier 🛒`);

  const badge = $('cartCount');
  badge.classList.remove('pop');
  void badge.offsetWidth; // force le redémarrage de l'animation
  badge.classList.add('pop');
}

/** Enrichit les lignes du panier avec les données produit à jour. */
function detailedCart() {
  return state.cart
    .map((line) => {
      const product = state.products.find((p) => p.id === line.id);
      if (!product) return null;
      const variant = product.variants?.find((v) => v.id === line.variantId) ?? null;
      const price = variant?.price ?? product.price;
      return { ...line, product, variant, unitPrice: price, lineTotal: price * line.quantity };
    })
    .filter(Boolean);
}

function cartTotal() {
  return detailedCart().reduce((sum, l) => sum + l.lineTotal, 0);
}

function renderCart() {
  const lines = detailedCart();
  const count = lines.reduce((sum, l) => sum + l.quantity, 0);

  const badge = $('cartCount');
  badge.textContent = count;
  badge.hidden = count === 0;

  const subtotal = cartTotal();
  const fee = deliveryFeeFor(subtotal);
  const { minimumOrder, freeDeliveryFrom } = state.fulfillment;
  const manque = Math.max(0, minimumOrder - subtotal);

  $('cartEmpty').hidden = lines.length > 0;
  $('noteField').hidden = lines.length === 0;
  $('modeField').hidden = lines.length === 0 || !(state.fulfillment.pickup && state.fulfillment.delivery);
  $('contactField').hidden = lines.length === 0;

  const livraison = state.mode === 'delivery';
  $('contactLabel').textContent = livraison
    ? 'Adresse de livraison (obligatoire)'
    : 'Téléphone ou adresse (optionnel)';

  $('checkout').disabled = lines.length === 0 || !state.opening.open || manque > 0;
  $('checkout').textContent = state.opening.open ? 'Commander' : 'Boutique fermée';

  $('cartTotalLabel').textContent = fee ? `Total · dont ${formatPrice(fee)} de livraison` : 'Total';
  $('cartTotal').textContent = formatPrice(subtotal + fee);

  const hint = $('cartHint');
  if (manque > 0 && lines.length) {
    hint.textContent = `Commande minimum ${formatPrice(minimumOrder)} : il manque ${formatPrice(manque)}.`;
    hint.hidden = false;
  } else if (livraison && fee && freeDeliveryFrom !== null && lines.length) {
    hint.textContent = `Livraison offerte à partir de ${formatPrice(freeDeliveryFrom)} : il manque ${formatPrice(freeDeliveryFrom - subtotal)}.`;
    hint.hidden = false;
  } else {
    hint.hidden = true;
  }

  $('cartList').replaceChildren(...lines.map(cartRow));
  syncMainButton();
}

function cartRow(line) {
  const li = document.createElement('li');
  li.className = 'cart-item';
  li.innerHTML = `
    <span class="cart-item__art${isPhoto(line.product.image) ? ' cart-item__art--photo' : ''}"><img src="${line.product.image}" alt=""></span>
    <span class="cart-item__info">
      <span class="cart-item__name">${escapeHtml(line.product.name)}</span>
      <span class="cart-item__meta">${line.variant ? escapeHtml(line.variant.label) + ' · ' : ''}${formatPrice(line.lineTotal)}</span>
    </span>
    <span class="cart-item__ctl">
      <button type="button" data-act="minus" aria-label="Retirer un">−</button>
      <span>${line.quantity}</span>
      <button type="button" data-act="plus" aria-label="Ajouter un">+</button>
    </span>`;

  li.querySelector('[data-act="minus"]').addEventListener('click', () => changeLine(line.key, -1));
  li.querySelector('[data-act="plus"]').addEventListener('click', () => changeLine(line.key, +1));
  return li;
}

function changeLine(key, delta) {
  const line = state.cart.find((l) => l.key === key);
  if (!line) return;

  const product = state.products.find((p) => p.id === line.id);
  if (delta > 0 && product && line.quantity >= stockOf(product, line.variantId)) {
    toast('Stock maximum atteint');
    return;
  }

  line.quantity += delta;
  if (line.quantity < 1) state.cart = state.cart.filter((l) => l.key !== key);
  saveCart();
  renderCart();
  haptic('light');
}

/* ── Commande ────────────────────────────────────────────── */

async function checkout() {
  const lines = detailedCart();
  if (!lines.length) return;

  const button = $('checkout');
  button.disabled = true;
  button.textContent = 'Préparation…';

  const note = $('orderNote').value.trim();
  const contact = $('orderContact').value.trim();

  if (state.mode === 'delivery' && contact.length < 5) {
    toast('Indique ton adresse de livraison.');
    $('orderContact').focus();
    return;
  }

  // On enregistre la commande côté serveur pour avoir une référence et une
  // trace. Si le serveur ne répond pas, on continue quand même : l'essentiel
  // est que le client arrive dans la conversation avec son récapitulatif.
  let reference = null;
  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': tg?.initData ?? '',
        'X-Shop-Pass': readPass() ?? '',
      },
      body: JSON.stringify({
        items: lines.map((l) => ({ id: l.id, variantId: l.variantId, quantity: l.quantity })),
        mode: state.mode,
        contact,
        note,
      }),
    });
    if (res.ok) {
      reference = (await res.json()).reference;
    } else {
      const data = await res.json().catch(() => ({}));
      // Le laissez-passer a expiré : on refait l'épreuve plutôt que d'envoyer
      // le client dans la conversation avec une commande non enregistrée.
      if (data.error === 'VERIFICATION_REQUISE') {
        closeSheets();
        await gateVerification();
        button.disabled = false;
        button.textContent = 'Commander';
        return;
      }
      if (data.error === 'CAPTCHA_REQUIS') {
        writePass('');
        closeSheets();
        await openCaptcha();
        button.disabled = false;
        button.textContent = 'Commander';
        return;
      }
      toast(data.error ?? 'Commande refusée.');
    }
  } catch (err) {
    console.warn('Enregistrement de la commande impossible :', err);
  }

  const message = buildOrderMessage(lines, note, reference, contact);
  openSellerChat(message);

  button.disabled = false;
  button.textContent = 'Commander';
  haptic('success');
}

function buildOrderMessage(lines, note, reference, contact) {
  const parts = [`Bonjour ! Je souhaite commander sur ${state.shop.shopName} 🌿`, ''];

  for (const line of lines) {
    const variant = line.variant ? ` (${line.variant.label})` : '';
    parts.push(`• ${line.quantity} × ${line.product.name}${variant} — ${formatPrice(line.lineTotal)}`);
  }

  const fee = deliveryFeeFor(cartTotal());
  parts.push('', state.mode === 'delivery' ? '🛵 Livraison' : '🏠 Retrait sur place');
  if (fee) parts.push(`Frais de livraison : ${formatPrice(fee)}`);
  parts.push(`Total : ${formatPrice(cartTotal() + fee)}`);
  if (reference) parts.push(`Réf : ${reference}`);
  if (contact) parts.push(`${state.mode === 'delivery' ? 'Adresse' : 'Contact'} : ${contact}`);
  if (note) parts.push('', `Note : ${note}`);

  return parts.join('\n');
}

/** Ouvre la conversation du vendeur avec le récapitulatif pré-rempli. */
function openSellerChat(message) {
  const username = state.shop.sellerUsername;
  if (!username) {
    toast("Le compte vendeur n'est pas encore configuré.");
    return;
  }

  // Telegram tronque les URL très longues : on garde le message sous une
  // taille sûre, le détail complet restant côté serveur avec la référence.
  const text = message.length > 1500 ? `${message.slice(0, 1490)}…` : message;
  const url = `https://t.me/${username}?text=${encodeURIComponent(text)}`;

  if (tg?.openTelegramLink) {
    tg.openTelegramLink(url);
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

/* ── Mes commandes ───────────────────────────────────────── */

/**
 * L'historique vit côté serveur : c'est l'identifiant Telegram signé qui
 * décide de ce qu'on affiche, jamais le panier local.
 */
async function openOrders() {
  const list = $('ordersList');
  const empty = $('ordersEmpty');
  list.replaceChildren();
  empty.hidden = false;
  empty.textContent = 'Chargement…';
  openSheet('ordersSheet');
  haptic('light');

  try {
    const res = await fetch('/api/orders', {
      headers: { 'X-Telegram-Init-Data': tg?.initData ?? '' },
    });
    if (res.status === 401) {
      empty.textContent = 'Ouvre la boutique depuis Telegram pour retrouver tes commandes.';
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const orders = await res.json();
    if (!orders.length) {
      empty.textContent = "Tu n'as pas encore passé de commande.";
      return;
    }

    empty.hidden = true;
    list.replaceChildren(...orders.map(orderCard));
  } catch (err) {
    console.error(err);
    empty.textContent = 'Historique indisponible pour le moment.';
  }
}

function orderCard(order) {
  const status = state.statuses[order.status] ?? { label: order.status, emoji: '•' };
  const date = new Date(order.createdAt).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

  const card = document.createElement('article');
  card.className = 'order';
  card.innerHTML = `
    <div class="order__head">
      <span class="order__ref">${escapeHtml(order.reference)}</span>
      <span class="order__status order__status--${escapeHtml(order.status)}">${status.emoji} ${escapeHtml(status.label)}</span>
    </div>
    <p class="order__date">${escapeHtml(date)}</p>
    <ul class="order__items">
      ${order.items
        .map(
          (i) =>
            `<li>${i.quantity} × ${escapeHtml(i.name)}${
              i.variantLabel ? ` <small>${escapeHtml(i.variantLabel)}</small>` : ''
            }</li>`
        )
        .join('')}
    </ul>
    <p class="order__total">${formatPrice(order.total)}</p>`;
  return card;
}

/* ── Panneaux ────────────────────────────────────────────── */

function openSheet(id) {
  closeSheets();
  $(id).hidden = false;
  document.body.style.overflow = 'hidden';
  tg?.BackButton?.show();
  syncMainButton();
}

function closeSheets() {
  for (const sheet of document.querySelectorAll('.sheet')) sheet.hidden = true;
  document.body.style.overflow = '';
  tg?.BackButton?.hide();
  syncMainButton();
}

/** Le bouton natif de Telegram sert de raccourci vers le panier. */
function syncMainButton() {
  const main = tg?.MainButton;
  if (!main) return;

  const total = cartTotal() + deliveryFeeFor(cartTotal());
  const sheetOpen = [...document.querySelectorAll('.sheet')].some((s) => !s.hidden);

  if (total > 0 && !sheetOpen) {
    main.setText(`VOIR MON PANIER · ${formatPrice(total)}`);
    main.setParams?.({ color: themeHex('--neon-rgb', '#c6ff3d'), text_color: themeHex('--ink-rgb', '#030c08') });
    main.show();
  } else {
    main.hide();
  }
}

/* ── Utilitaires ─────────────────────────────────────────── */

/**
 * Une illustration SVG flotte au milieu de son halo ; une photo, elle, doit
 * remplir le cadre. On distingue les deux sur l'extension du fichier.
 */
function isPhoto(src) {
  return !/\.svg($|[?#])/i.test(String(src ?? ''));
}

/** Telegram n'accepte que des couleurs hexadécimales : on convertit les
 *  jetons « R G B » du thème pour que la barre native suive la palette. */
function themeHex(token, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token);
  const parts = raw.match(/\d+/g);
  if (!parts || parts.length < 3) return fallback;
  return `#${parts.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
}

/** Stock disponible pour un produit, ou pour une de ses variantes. */
function stockOf(product, variantId = null) {
  if (product.variants?.length) {
    const variant = product.variants.find((v) => v.id === variantId);
    return variant ? Number(variant.stock ?? 0) : 0;
  }
  return Number(product.stock ?? 0);
}

/** Un produit est épuisé quand aucune de ses variantes n'est disponible. */
function isSoldOut(product) {
  return product.variants?.length
    ? product.variants.every((v) => Number(v.stock ?? 0) <= 0)
    : stockOf(product) <= 0;
}

/** Ce qu'il reste après déduction de ce qui est déjà dans le panier. */
function remainingFor(product, variantId) {
  const key = `${product.id}::${variantId ?? ''}`;
  const inCart = state.cart.find((l) => l.key === key)?.quantity ?? 0;
  return Math.max(0, stockOf(product, variantId) - inCart);
}

function unitPrice(product, variantId) {
  if (!product) return 0;
  const variant = product.variants?.find((v) => v.id === variantId);
  return variant?.price ?? product.price;
}

function formatPrice(cents) {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: state.shop.currency || 'EUR',
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
