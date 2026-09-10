/* ══════════════════════════════════════════════════════════════
   COFFEE SHOP 68 — logique de la Mini App
   ══════════════════════════════════════════════════════════════ */

const tg = window.Telegram?.WebApp;
const CART_KEY = 'kartoon.cart.v1';
const AGE_KEY = 'kartoon.age.ok';
const PASS_KEY = 'kartoon.pass';
/** Lignes qu'on accepte de relire : au-delà, le serveur refuse la commande. */
const CART_MAX_LINES = 50;

const state = {
  shop: { shopName: 'COFFEE SHOP 68', currency: 'EUR', sellerUsername: '' },
  categories: [],
  products: [],
  statuses: {},
  category: 'all',
  query: '',           // ce que le client cherche
  sort: 'default',     // et dans quel ordre il veut voir
  gates: {},
  features: {},       // ce que la boutique propose en ce moment
  opening: { open: true },
  fulfillment: { pickup: true, delivery: false, deliveryFee: 0, freeDeliveryFrom: null, minimumOrder: 0 },
  tiers: [],          // remises automatiques par palier
  zones: [],          // zones de livraison desservies
  zone: null,         // celle qui couvre le code postal saisi
  slotsEnabled: false,
  slots: [],          // créneaux encore réservables
  slotId: '',         // celui que le client a choisi
  promo: null,        // remise en cours : { code, discount, label, source }
  lastMessage: '',    // récapitulatif de la dernière commande, pour le renvoyer
  blocked: false,     // compte privé de commande par le vendeur
  mode: 'pickup',
  captcha: null,      // épreuve en cours
  selection: [],      // tuiles touchées
  cart: loadCart(),
  startProduct: null, // produit demandé par un lien direct, à ouvrir une fois entré
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

  state.startProduct = produitDemande();

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
    state.features = data.features ?? {};
    state.opening = data.opening ?? { open: true };
    state.fulfillment = data.fulfillment ?? state.fulfillment;
    state.tiers = data.discounts?.tiers ?? [];
    state.zones = data.zones ?? [];
    state.slotsEnabled = Boolean(data.slots?.enabled);
    applyFeatures();
    state.mode = state.fulfillment.pickup ? 'pickup' : 'delivery';
  } catch (err) {
    console.error(err);
    // Un toast disparaît en deux secondes et la grille reste vide : la boutique
    // avait alors l'air de n'avoir aucun produit, alors qu'elle était
    // simplement injoignable. Pour un client c'est une boutique abandonnée ;
    // pour le vendeur qui installe, c'est une fausse piste. On le dit donc en
    // clair, et on laisse de quoi réessayer.
    montrerPanne(err);
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
  loadSlots();
  runGates();
}

/**
 * Dit que la boutique est injoignable, plutôt que de la montrer vide.
 *
 * Les deux états se ressemblent à l'écran et ne veulent pas du tout dire la
 * même chose : « il n'y a rien à vendre » contre « je n'arrive pas à joindre
 * le serveur ». Confondre les deux envoie chercher au mauvais endroit.
 */
function montrerPanne(err) {
  const zone = $('empty');
  zone.hidden = false;
  zone.replaceChildren();

  const titre = document.createElement('strong');
  titre.textContent = 'Boutique momentanément injoignable';

  const texte = document.createElement('span');
  texte.textContent =
    "Le catalogue n'a pas pu être chargé. Ce n'est pas que la boutique est " +
    'vide : le serveur ne répond pas comme il faut.';

  const detail = document.createElement('code');
  detail.className = 'empty__detail';
  detail.textContent = String(err?.message ?? err).slice(0, 120);

  const reessayer = document.createElement('button');
  reessayer.type = 'button';
  reessayer.className = 'btn btn--primary';
  reessayer.textContent = 'Réessayer';
  reessayer.addEventListener('click', () => {
    reessayer.disabled = true;
    reessayer.textContent = 'Chargement…';
    // Un rechargement complet : plus sûr qu'un rattrapage partiel, puisqu'on
    // ne sait pas jusqu'où le démarrage était allé.
    location.reload();
  });

  zone.append(titre, texte, detail, reessayer);
  toast("Catalogue indisponible, réessaie dans un instant.");
}

function bindStaticHandlers() {
  $('ageYes').addEventListener('click', () => {
    try { localStorage.setItem(AGE_KEY, '1'); } catch {}
    $('agegate').hidden = true;
    haptic('light');
    runGates();
  });
  $('ageNo').addEventListener('click', () => (tg ? tg.close() : window.history.back()));

  $('cartBtn').addEventListener('click', () => openSheet('cartSheet'));
  $('ordersBtn').addEventListener('click', openOrders);
  $('captchaSubmit').addEventListener('click', submitCaptcha);
  // Fermer la Mini App ramène le client dans la conversation du bot, là où il
  // envoie sa pièce : pas besoin de connaître le nom du bot.
  $('verifAction').addEventListener('click', () => (tg ? tg.close() : window.history.back()));
  $('checkout').addEventListener('click', checkout);
  $('doneChat').addEventListener('click', () => openSellerChat(state.lastMessage));
  $('verifBrowse').addEventListener('click', () => {
    // Le serveur refuse la commande de toute façon : rien n'oblige à cacher
    // la boutique pendant que la pièce est examinée.
    $('verification').hidden = true;
    toast('Tu pourras commander une fois ta pièce validée.');
  });
  $('promoApply').addEventListener('click', applyPromo);
  $('promoCode').addEventListener('keydown', (e) => e.key === 'Enter' && applyPromo());
  $('findInput').addEventListener('input', () => {
    state.query = $('findInput').value;
    renderGrid();
  });
  $('findClear').addEventListener('click', () => {
    state.query = '';
    $('findInput').value = '';
    $('findInput').focus();
    renderGrid();
  });
  $('findSort').addEventListener('change', () => {
    state.sort = $('findSort').value;
    renderGrid();
  });
  $('orderPostal').addEventListener('input', () => {
    state.zone = findZone($('orderPostal').value);
    renderCart();
  });
  $('orderSlot').addEventListener('change', () => {
    state.slotId = $('orderSlot').value;
    renderCart();
  });
  $('promoCode').addEventListener('input', () => {
    if (!promoError) return;
    promoError = null;
    renderCart();
  });

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
  const { pickup, delivery } = state.fulfillment;
  // Un seul mode possible : inutile de faire choisir.
  $('modeField').hidden = !(pickup && delivery);
  if (!(pickup && delivery)) return;

  // Le tarif affiché est celui qui sera facturé : la zone reconnue l'emporte
  // sur les conditions générales, et un franco atteint le ramène à zéro.
  const fee = deliveryFeeIfDelivering(cartTotal());
  const options = [
    ['pickup', '🏠 Retrait', 'sur place'],
    ['delivery', '🛵 Livraison', fee ? formatPrice(fee) : 'offerte'],
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

/** Retire de l'interface ce que la boutique n'offre pas en ce moment. */
function applyFeatures() {
  $('ordersBtn').hidden = state.features.orderHistory === false;
  $('promoField').hidden = state.features.promos === false;
  $('findBar').hidden = state.features.search === false;
}

/* ── Zones et créneaux ───────────────────────────────────── */

/** La zone qui couvre ce code postal, ou null si personne ne le dessert. */
function findZone(postalCode) {
  const code = String(postalCode ?? '').trim();
  if (!/^\d{2,6}$/.test(code)) return null;
  return state.zones.find((zone) => zone.postalCodes.includes(code)) ?? null;
}

/** Les zones remplacent les conditions générales là où elles en ont. */
function conditions(subtotal) {
  const { deliveryFee, freeDeliveryFrom, minimumOrder } = state.fulfillment;
  const zone = state.zone;
  return {
    fee: zone ? zone.fee : deliveryFee,
    franco: zone ? zone.freeFrom ?? freeDeliveryFrom : freeDeliveryFrom,
    minimum: zone ? zone.minimumOrder ?? minimumOrder : minimumOrder,
  };
}

/**
 * Ce que coûterait la livraison de ce panier, mode courant mis à part.
 *
 * Sert au bouton « Livraison » : il annonçait le tarif brut, si bien qu'il
 * réclamait 5 € pendant que le total, franco atteint, n'en facturait aucun.
 */
function deliveryFeeIfDelivering(subtotal) {
  if (!state.fulfillment.delivery) return 0;
  const { fee, franco } = conditions(subtotal);
  return franco !== null && subtotal >= franco ? 0 : fee;
}

/** Frais réellement dus : le mode retrait les annule aussi. */
function deliveryFeeFor(subtotal) {
  return state.mode === 'delivery' ? deliveryFeeIfDelivering(subtotal) : 0;
}

/** Dit tout de suite si on descend jusque chez lui, et à quelles conditions. */
function renderZoneStatus() {
  const el = $('zoneStatus');
  const code = $('orderPostal').value.trim();

  if (!code) {
    el.hidden = true;
    return;
  }
  if (!state.zone) {
    el.textContent = `On ne livre pas encore le ${code}. Le retrait sur place reste possible.`;
    el.hidden = false;
    el.classList.add('promo__status--ko');
    el.classList.remove('promo__status--ok');
    return;
  }

  const details = [
    state.zone.fee ? `${formatPrice(state.zone.fee)} de livraison` : 'livraison offerte',
    state.zone.minimumOrder ? `minimum ${formatPrice(state.zone.minimumOrder)}` : null,
  ].filter(Boolean);
  el.textContent = `${state.zone.name} · ${details.join(' · ')}`;
  el.hidden = false;
  el.classList.add('promo__status--ok');
  el.classList.remove('promo__status--ko');
}

/** Charge les créneaux encore réservables. Silencieux en cas d'échec : le
 *  serveur revalide de toute façon, et une commande sans créneau vaut mieux
 *  qu'un panier bloqué. */
async function loadSlots() {
  if (!state.slotsEnabled) return;
  try {
    const res = await fetch('/api/slots');
    if (!res.ok) return;
    const data = await res.json();
    state.slots = data.slots ?? [];
    // Le créneau choisi a pu se remplir pendant que le panier était ouvert.
    if (!state.slots.some((s) => s.id === state.slotId && !s.full)) state.slotId = '';
    renderSlots();
  } catch {
    /* réseau capricieux : on garde ce qu'on a */
  }
}

function renderSlots() {
  const select = $('orderSlot');
  const options = [
    Object.assign(document.createElement('option'), {
      value: '', textContent: state.slots.length ? 'Choisis un créneau' : 'Aucun créneau disponible',
      disabled: true,
    }),
    ...state.slots.map((slot) =>
      Object.assign(document.createElement('option'), {
        value: slot.id,
        // Un créneau complet reste affiché : le faire disparaître donnerait
        // l'impression d'un bug à qui l'avait vu une minute plus tôt.
        textContent: slot.full
          ? `${slot.label} — complet`
          : slot.left <= 2
            ? `${slot.label} — ${slot.left} place${slot.left > 1 ? 's' : ''}`
            : slot.label,
        disabled: slot.full,
      })
    ),
  ];
  select.replaceChildren(...options);
  select.value = state.slotId;
  if (!select.value) select.selectedIndex = 0;
}

/* ── Remises ─────────────────────────────────────────────── */

/**
 * Remise automatique du panier, calculée ici pour l'affichage.
 *
 * Les paliers sont publics : les recopier côté client évite un aller-retour
 * réseau à chaque « + ». Le serveur refait le calcul au moment de la commande,
 * c'est lui qui fait foi.
 */
function tierDiscountFor(subtotal) {
  const palier = state.tiers
    .filter((t) => subtotal >= t.from)
    .sort((a, b) => b.from - a.from)[0];

  if (!palier) return { discount: 0, label: null };
  return {
    discount: Math.round((subtotal * palier.percent) / 100),
    label: `−${palier.percent} % dès ${formatPrice(palier.from)}`,
  };
}

/** Remise finalement appliquée : le code saisi ou le palier, le meilleur. */
function currentDiscount(subtotal) {
  const palier = tierDiscountFor(subtotal);
  if (state.promo && state.promo.discount >= palier.discount) return state.promo;
  return palier.discount > 0 ? { ...palier, code: null, source: 'tier' } : { discount: 0, label: null };
}

/**
 * Dernier refus de code, retenu jusqu'à la prochaine saisie.
 *
 * Sans ça, le réaffichage du panier écrasait aussitôt « Code inconnu » par la
 * remise automatique en cours : le client voyait sa saisie ne rien faire, sans
 * savoir pourquoi.
 */
let promoError = null;

/** Encourage sans mentir : le prochain palier et ce qu'il manque pour l'avoir. */
function nextTierHint(subtotal) {
  const next = state.tiers.filter((t) => subtotal < t.from).sort((a, b) => a.from - b.from)[0];
  if (!next) return '';
  return `−${next.percent} % dès ${formatPrice(next.from)} : il manque ${formatPrice(next.from - subtotal)}.`;
}

async function applyPromo() {
  const input = $('promoCode');
  const code = input.value.trim();
  const lines = detailedCart();

  if (!code) {
    state.promo = null;
    promoError = null;
    showPromoStatus('', null);
    renderCart();
    return;
  }
  if (!lines.length) return showPromoStatus('Ajoute d\'abord un article.', false);

  const button = $('promoApply');
  button.disabled = true;
  promoError = null;
  try {
    const result = await previewPromo(code, lines);
    // Le serveur peut préférer le palier au code : dans ce cas il ne renvoie
    // pas de code, et le dire évite de faire croire que la saisie n'a rien fait.
    state.promo = result.code ? result : null;
    showPromoStatus(
      result.code
        ? `Code ${result.code} appliqué : −${formatPrice(result.discount)}`
        : `Ta remise automatique (${result.label}) est plus avantageuse : on la garde.`,
      true
    );
    haptic('success');
  } catch (err) {
    state.promo = null;
    promoError = err.message;
  } finally {
    button.disabled = false;
    renderCart();
  }
}

async function previewPromo(code, lines) {
  const res = await fetch('/api/promo', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': tg?.initData ?? '',
    },
    body: JSON.stringify({
      code,
      items: lines.map((l) => ({ id: l.id, variantId: l.variantId, quantity: l.quantity })),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Code refusé.');
  return data;
}

function showPromoStatus(message, ok) {
  const el = $('promoStatus');
  el.textContent = message;
  el.hidden = !message;
  el.classList.toggle('promo__status--ok', ok === true);
  el.classList.toggle('promo__status--ko', ok === false);
}

/**
 * Le panier a bougé alors qu'un code était posé : son montant a changé, et il
 * peut même ne plus être valable (minimum de panier). On revalide au calme
 * plutôt qu'à chaque appui sur « + ».
 */
let promoTimer;
function revalidatePromo() {
  if (!state.promo) return;
  clearTimeout(promoTimer);
  promoTimer = setTimeout(async () => {
    const lines = detailedCart();
    const code = state.promo?.code;
    if (!code || !lines.length) {
      state.promo = null;
      showPromoStatus('', null);
      renderCart();
      return;
    }
    try {
      const result = await previewPromo(code, lines);
      state.promo = result.code ? result : null;
    } catch (err) {
      state.promo = null;
      promoError = err.message;
    }
    renderCart();
  }, 400);
}

/** Boutique fermée : on le dit, et on empêche la commande. */
function renderClosedBanner() {
  const banner = $('closedBanner');
  // Un compte bloqué passe devant l'horaire : c'est la vraie raison pour
  // laquelle ce client-là ne pourra pas commander, quelle que soit l'heure.
  if (state.blocked) {
    banner.textContent =
      "Ce compte ne peut pas passer commande. Écris-nous dans la conversation si c'est une erreur.";
    banner.hidden = false;
    return;
  }
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
/**
 * Ce que le serveur sait de ce client : blocage et vérification.
 *
 * Lu une fois et gardé : la porte de vérification et le bandeau de compte
 * bloqué en avaient besoin tous les deux, et deux appels pour la même
 * réponse feraient clignoter l'écran au démarrage.
 */
async function loadMe() {
  if (!tg?.initData) return null;
  try {
    const res = await fetch('/api/me', { headers: { 'X-Telegram-Init-Data': tg.initData } });
    if (!res.ok) return null;
    const me = await res.json();
    state.blocked = Boolean(me.blocked);
    renderClosedBanner();
    renderCart();
    return me;
  } catch (err) {
    console.error(err);
    return null;
  }
}

/** @returns {boolean} vrai si le voile reste affiché. */
async function gateVerification() {
  const me = await loadMe();
  if (!state.gates.verification || !me) return false;

  const status = me.verification.status;
  if (status === 'approved') return false;

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
  return true;
}

/* ── Épreuve d'entrée ────────────────────────────────────── */

/** Rien à demander si l'épreuve est désactivée ou déjà passée aujourd'hui. */
async function gateCaptcha() {
  if (!state.gates.captcha || !tg?.initData) return false;
  if (readPass()) return false;
  await openCaptcha();
  return !$('captcha').hidden;
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
    // On repasse par le séquenceur plutôt que d'appeler la porte suivante :
    // lui seul connaît l'ordre, et ce qui attend derrière la dernière — une
    // fiche ouverte par un lien direct, par exemple. Le laissez-passer étant
    // écrit, les portes déjà franchies se contentent de se taire.
    await runGates();
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

/**
 * Les portes d'entrée, une à la fois.
 *
 * Les trois écrans sont des voiles plein cadre au même niveau : les ouvrir
 * ensemble revenait à empiler la vérification par-dessus l'épreuve, qui
 * avalait alors tous les appuis — le client ne pouvait littéralement plus
 * entrer. Chacune appelle donc la suivante en se refermant.
 */
async function runGates() {
  if (gateAge()) return;
  if (await gateCaptcha()) return;
  if (await gateVerification()) return;
  ouvrirProduitDemande();
}

/**
 * Le produit désigné par le lien qui a ouvert la boutique.
 *
 * Telegram remet le paramètre de `?startapp=` tel quel dans `start_param`.
 * Le `?p=` de l'URL sert de secours pour tester hors de Telegram — et pour
 * les clients qui ouvrent la boutique dans un navigateur.
 */
function produitDemande() {
  const param = tg?.initDataUnsafe?.start_param
    ?? new URLSearchParams(location.search).get('startapp')
    ?? '';
  return /^p_[A-Za-z0-9_-]+$/.test(param) ? param.slice(2) : null;
}

/**
 * Ouvre la fiche demandée, une fois les portes franchies.
 *
 * Un lien peut survivre à l'article qu'il désignait : retiré du catalogue,
 * masqué, renommé. Le client ne doit pas rester devant une boutique muette à
 * se demander si le QR a marché — on lui dit, et il reste dans le catalogue.
 */
function ouvrirProduitDemande() {
  const id = state.startProduct;
  if (!id) return;
  // Consommé une bonne fois : refermer la fiche ne doit pas la rouvrir à la
  // prochaine porte franchie.
  state.startProduct = null;

  const product = state.products.find((p) => p.id === id);
  if (!product) {
    toast("Cet article n'est plus au catalogue. Voici le reste de la boutique.");
    return;
  }
  openProduct(product);
}

/** @returns {boolean} vrai si la porte reste ouverte. */
function gateAge() {
  // Appelée avant le catalogue au premier affichage : sans réponse du serveur
  // on garde la porte fermée, plus prudent que de l'ouvrir par défaut.
  if (state.features.ageGate === false) {
    $('agegate').hidden = true;
    return false;
  }
  let confirmed = false;
  try { confirmed = localStorage.getItem(AGE_KEY) === '1'; } catch {}
  $('agegate').hidden = confirmed;
  return !confirmed;
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
  const cherche = state.features.search !== false;
  const list = trier(
    state.products
      .filter((p) => state.category === 'all' || p.category === state.category)
      .filter((p) => !cherche || correspond(p, state.query))
  );

  $('findClear').hidden = !state.query;
  // La zone a peut-être servi à annoncer une panne : on la remet en simple
  // ligne de texte avant de s'en servir.
  const zone = $('empty');
  if (zone.childElementCount) zone.replaceChildren();
  zone.hidden = list.length > 0;
  // Le message d'absence doit dire de quoi il parle : « rien dans cette
  // catégorie » quand on cherche « banane » enverrait chercher au mauvais endroit.
  $('empty').textContent = state.query
    ? `Rien ne correspond à « ${state.query.trim()} ».`
    : 'Rien dans cette catégorie pour le moment.';

  grid.replaceChildren(...list.map(productCard));
}

/**
 * Le produit répond-il à la recherche ?
 *
 * On cherche dans le nom, l'accroche, les étiquettes et la description, sans
 * accents ni casse : personne ne tape « Néon » avec l'accent sur un clavier de
 * téléphone. Chaque mot doit se retrouver quelque part, dans n'importe quel
 * ordre — « kush banane » et « banane kush » trouvent la même chose.
 */
function correspond(produit, requete) {
  const mots = normaliser(requete).split(/\s+/).filter(Boolean);
  if (!mots.length) return true;

  const foin = normaliser(
    [produit.name, produit.short, produit.description, produit.badge, ...(produit.tags ?? [])].join(' ')
  );
  return mots.every((mot) => foin.includes(mot));
}

function normaliser(texte) {
  return String(texte ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function trier(produits) {
  const copie = [...produits];
  switch (state.sort) {
    case 'price-asc':
      return copie.sort((a, b) => a.price - b.price);
    case 'price-desc':
      return copie.sort((a, b) => b.price - a.price);
    case 'name':
      return copie.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    case 'new':
      // Sans date, un produit passe pour ancien : mieux vaut le laisser en bas
      // que le faire remonter en tête des nouveautés.
      return copie.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
    default:
      // Ordre du catalogue, mais les articles épuisés glissent en fin de liste :
      // ils ne doivent pas occuper le haut de la vitrine.
      return copie.sort((a, b) => Number(isSoldOut(a)) - Number(isSoldOut(b)));
  }
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
    // Épuisé : plutôt qu'un bouton mort, on propose d'être prévenu — sauf si
    // la liste d'attente est coupée, auquel cas il n'y a rien à promettre.
    addButton.hidden = true;
    $('qtyValue').closest('.qty').hidden = true;
    notify.hidden = state.features.waitlist === false;
    if (!notify.hidden) refreshWaitlistButton();
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

/**
 * Relit le panier laissé par la visite précédente, en s'en méfiant.
 *
 * Ce contenu a pu être trafiqué, tronqué, ou écrit par une version plus
 * ancienne de la boutique. Sans nettoyage, une ligne à `null` faisait planter
 * le rendu, une quantité en texte affichait « NaN € » avec un bouton
 * Commander toujours actif, et une quantité négative sortait un total négatif.
 * Rien de tout ça n'aurait été accepté par le serveur — autant ne pas le
 * montrer au client.
 */
function loadCart() {
  let raw;
  try {
    raw = JSON.parse(localStorage.getItem(CART_KEY) ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  // Les doublons sont fusionnés plutôt qu'empilés : deux lignes du même
  // article se comptaient deux fois dans le badge et dans le total.
  const parCle = new Map();
  for (const ligne of raw) {
    if (!ligne || typeof ligne !== 'object') continue;

    const id = typeof ligne.id === 'string' ? ligne.id.trim() : '';
    if (!id) continue;

    const variantId = typeof ligne.variantId === 'string' && ligne.variantId ? ligne.variantId : null;
    const quantity = Math.floor(Number(ligne.quantity));
    if (!Number.isFinite(quantity) || quantity < 1) continue;

    const key = `${id}::${variantId ?? ''}`;
    const dejaLa = parCle.get(key);
    const total = Math.min(99, (dejaLa?.quantity ?? 0) + quantity);
    parCle.set(key, { key, id, variantId, quantity: total });
  }
  return [...parCle.values()].slice(0, CART_MAX_LINES);
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
  revalidatePromo();
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
      // Le stock a pu fondre depuis que l'article est au panier : la ligne
      // porte de quoi le dire, plutôt que d'annoncer un total qu'on ne
      // pourra pas honorer.
      const stock = stockOf(product, line.variantId);
      return {
        ...line, product, variant, unitPrice: price, stock,
        lineTotal: price * line.quantity,
        short: Math.max(0, line.quantity - stock),
      };
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
  const remise = currentDiscount(subtotal);
  const { minimum, franco } = conditions(subtotal);
  // Minimum et franco se jugent sur le panier avant remise, comme le serveur.
  const manque = Math.max(0, minimum - subtotal);

  $('cartEmpty').hidden = lines.length > 0;
  $('noteField').hidden = lines.length === 0;
  $('promoField').hidden = lines.length === 0 || state.features.promos === false;

  const livraison = state.mode === 'delivery';
  $('modeField').hidden = lines.length === 0 || !(state.fulfillment.pickup && state.fulfillment.delivery);
  $('contactField').hidden = lines.length === 0;
  $('postalField').hidden = lines.length === 0 || !livraison || state.zones.length === 0;
  $('slotField').hidden = lines.length === 0 || !state.slotsEnabled;
  $('slotFieldLabel').textContent = livraison ? 'Créneau de livraison' : 'Créneau de retrait';
  renderZoneStatus();
  renderModes();

  // Avec un vrai sélecteur de créneau, inviter à en demander un dans la note
  // enverrait deux réponses contradictoires au vendeur.
  $('orderNote').placeholder = state.slotsEnabled
    ? 'Point de retrait, code de la porte, question…'
    : 'Créneau souhaité, point de retrait, question…';

  $('contactLabel').textContent = livraison
    ? 'Adresse de livraison (obligatoire)'
    : 'Téléphone ou adresse (optionnel)';

  // Bloquer le bouton plutôt que laisser partir une commande que le serveur
  // refusera : le client verrait un aller-retour pour rien.
  const zoneManquante = livraison && state.zones.length > 0 && !state.zone;
  const creneauManquant = state.slotsEnabled && !state.slotId;
  const rupture = lines.some((l) => l.short > 0);
  $('checkout').disabled =
    lines.length === 0 || state.blocked || !state.opening.open || manque > 0
    || zoneManquante || creneauManquant || rupture;
  $('checkout').textContent = state.blocked
    ? 'Commande impossible'
    : !state.opening.open
      ? 'Boutique fermée'
      : rupture
        ? 'Ajuste ton panier'
        : creneauManquant && !zoneManquante && manque === 0 && lines.length
          ? 'Choisis un créneau'
          : 'Commander';

  const details = [
    remise.discount ? `remise ${formatPrice(remise.discount)} déduite` : null,
    fee ? `dont ${formatPrice(fee)} de livraison` : null,
  ].filter(Boolean);
  $('cartTotalLabel').textContent = details.length ? `Total · ${details.join(', ')}` : 'Total';
  $('cartTotal').textContent = formatPrice(subtotal - remise.discount + fee);

  // Prix barré : ce que le panier aurait coûté sans la remise.
  const strike = $('cartStrike');
  strike.hidden = remise.discount === 0;
  strike.textContent = remise.discount ? formatPrice(subtotal + fee) : '';

  if (promoError) {
    showPromoStatus(promoError, false);
  } else if (remise.discount && remise.label) {
    showPromoStatus(
      remise.source === 'tier'
        ? `Remise automatique ${remise.label} : −${formatPrice(remise.discount)}`
        : `Code ${remise.code} : ${remise.label}, soit −${formatPrice(remise.discount)}`,
      true
    );
  } else if (!state.promo && !$('promoCode').value.trim()) {
    showPromoStatus(nextTierHint(subtotal), null);
  }

  const hint = $('cartHint');
  const manquants = lines.filter((l) => l.short > 0);
  if (manquants.length) {
    hint.textContent =
      manquants.length === 1
        ? `${manquants[0].product.name} : ${manquants[0].stock ? `il n'en reste que ${manquants[0].stock}` : 'plus de stock'}. Ajuste la quantité pour continuer.`
        : `${manquants.length} articles ne sont plus disponibles en quantité voulue. Ajuste ton panier pour continuer.`;
    hint.hidden = false;
  } else if (manque > 0 && lines.length) {
    const ou = state.zone ? ` pour ${state.zone.name}` : '';
    hint.textContent = `Commande minimum${ou} ${formatPrice(minimum)} : il manque ${formatPrice(manque)}.`;
    hint.hidden = false;
  } else if (livraison && fee && franco !== null && lines.length) {
    hint.textContent = `Livraison offerte à partir de ${formatPrice(franco)} : il manque ${formatPrice(franco - subtotal)}.`;
    hint.hidden = false;
  } else {
    hint.hidden = true;
  }

  $('cartList').replaceChildren(...lines.map(cartRow));
  syncMainButton();
}

function cartRow(line) {
  const li = document.createElement('li');
  li.className = line.short ? 'cart-item cart-item--short' : 'cart-item';
  li.innerHTML = `
    <span class="cart-item__art${isPhoto(line.product.image) ? ' cart-item__art--photo' : ''}"><img src="${line.product.image}" alt=""></span>
    <span class="cart-item__info">
      <span class="cart-item__name">${escapeHtml(line.product.name)}</span>
      <span class="cart-item__meta">${line.variant ? escapeHtml(line.variant.label) + ' · ' : ''}${formatPrice(line.lineTotal)}</span>
      ${line.short ? `<span class="cart-item__short">${line.stock ? `il n'en reste que ${line.stock}` : 'épuisé'}</span>` : ''}
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
  revalidatePromo();
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
  // Figés avant l'envoi : la commande réussie efface le code consommé et le
  // créneau réservé, et le récapitulatif doit quand même les porter.
  const remise = currentDiscount(cartTotal());
  const creneau = state.slots.find((s) => s.id === state.slotId) ?? null;
  const zone = state.zone;

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
        promoCode: state.promo?.code ?? null,
        postalCode: state.zone ? $('orderPostal').value.trim() : null,
        slotId: state.slotId || null,
        contact,
        note,
      }),
    });
    if (res.ok) {
      reference = (await res.json()).reference;
      // Le code vient d'être consommé côté serveur : le garder ferait échouer
      // la commande suivante avec un message incompréhensible.
      if (state.promo) {
        state.promo = null;
        promoError = null;
        $('promoCode').value = '';
        showPromoStatus('', null);
      }
      // Une place vient d'être prise : la liste et le choix repartent à neuf.
      state.slotId = '';
      loadSlots();
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
      // Quelque chose a bougé sous nos pieds : un dernier article emporté par
      // un autre client, un créneau qui vient de se remplir. On relit les deux
      // plutôt que de deviner lequel — le refus est un chemin rare, et un code
      // 409 recouvre justement les deux cas.
      await Promise.all([refreshCatalog(), loadSlots()]);

      // Un refus est un refus. Poursuivre vers la conversation du vendeur
      // enverrait quand même la commande — un compte bloqué, une boutique
      // fermée ou un article épuisé arriveraient chez le vendeur comme si de
      // rien n'était, en contournant précisément ce qu'on vient de refuser.
      toast(data.error ?? 'Commande refusée.');
      button.disabled = false;
      button.textContent = 'Commander';
      renderCart();
      return;
    }
  } catch (err) {
    // Serveur injoignable, et non refus : là, on continue. Le client arrive
    // dans la conversation avec son récapitulatif, le vendeur fait le reste.
    console.warn('Enregistrement de la commande impossible :', err);
  }

  const message = buildOrderMessage(lines, note, reference, contact, remise, creneau, zone);
  state.lastMessage = message;
  openSellerChat(message);

  button.disabled = false;
  button.textContent = 'Commander';
  haptic('success');

  // Commande écrite côté serveur : le panier a fait son travail. Le laisser
  // plein invitait à réappuyer sur Commander — et à réserver le stock une
  // seconde fois sans que rien ne le dise.
  if (reference) {
    showOrderDone(reference, lines, remise, creneau, zone);
    state.cart = [];
    saveCart();
    renderCart();
    // Le stock vient de bouger : sans ce rafraîchissement, la grille propose
    // encore des articles qu'on vient soi-même d'emporter.
    refreshCatalog();
  }
}

/** Accusé de réception : sans lui, rien dans l'app ne dit que c'est parti. */
function showOrderDone(reference, lines, remise, creneau, zone) {
  const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const fee = deliveryFeeFor(subtotal);

  $('doneRef').textContent = reference;
  $('doneText').textContent = state.shop.sellerUsername
    ? 'On a reçu ta commande. Le récapitulatif est prêt dans la conversation du vendeur : envoie-le pour confirmer.'
    : 'On a reçu ta commande. Le vendeur revient vers toi dans la conversation.';

  const lignes = [
    ...lines.map((l) => `${l.quantity} × ${l.product.name}${l.variant ? ` (${l.variant.label})` : ''}`),
    state.mode === 'delivery' ? `🛵 Livraison${zone ? ` — ${zone.name}` : ''}` : '🏠 Retrait sur place',
    creneau ? `🕒 ${creneau.label}` : null,
    remise.discount ? `Remise${remise.code ? ` ${remise.code}` : ''} : −${formatPrice(remise.discount)}` : null,
    `<b>Total : ${formatPrice(subtotal - remise.discount + fee)}</b>`,
  ].filter(Boolean);

  $('doneLines').replaceChildren(
    ...lignes.map((texte) => {
      const li = document.createElement('li');
      li.innerHTML = texte.startsWith('<b>') ? texte : escapeHtml(texte);
      return li;
    })
  );
  openSheet('doneSheet');
}

/** Relit le catalogue pour que les stocks affichés soient ceux du serveur. */
async function refreshCatalog() {
  try {
    const res = await fetch('/api/catalog');
    if (!res.ok) return;
    const data = await res.json();
    state.products = data.products;
    renderGrid();
  } catch {
    /* on garde l'affichage précédent plutôt que de vider la boutique */
  }
}

function buildOrderMessage(lines, note, reference, contact, remise, creneau, zone) {
  const parts = [`Bonjour ! Je souhaite commander sur ${state.shop.shopName} 🌿`, ''];

  for (const line of lines) {
    const variant = line.variant ? ` (${line.variant.label})` : '';
    parts.push(`• ${line.quantity} × ${line.product.name}${variant} — ${formatPrice(line.lineTotal)}`);
  }

  const subtotal = cartTotal();
  const fee = deliveryFeeFor(subtotal);
  parts.push('', state.mode === 'delivery' ? '🛵 Livraison' : '🏠 Retrait sur place');
  if (zone) parts.push(`Secteur : ${zone.name}`);
  if (creneau) parts.push(`Créneau : ${creneau.label}`);
  if (remise.discount) {
    parts.push(`Sous-total : ${formatPrice(subtotal)}`);
    parts.push(`Remise${remise.code ? ` ${remise.code}` : ''} : −${formatPrice(remise.discount)}`);
  }
  if (fee) parts.push(`Frais de livraison : ${formatPrice(fee)}`);
  parts.push(`Total : ${formatPrice(subtotal - remise.discount + fee)}`);
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
  // Les places partent pendant qu'on remplit son panier : on rafraîchit à
  // l'ouverture plutôt que de servir la liste chargée au démarrage.
  if (id === 'cartSheet') loadSlots();
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

  const subtotal = cartTotal();
  const total = subtotal - currentDiscount(subtotal).discount + deliveryFeeFor(subtotal);
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
