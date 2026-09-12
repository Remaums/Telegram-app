/* ══════════════════════════════════════════════════════════════
   Napoli Coffee — logique de la Mini App
   ══════════════════════════════════════════════════════════════ */

const tg = window.Telegram?.WebApp;
const CART_KEY = 'kartoon.cart.v1';
const AGE_KEY = 'kartoon.age.ok';
const PASS_KEY = 'kartoon.pass';
/** Lignes qu'on accepte de relire : au-delà, le serveur refuse la commande. */
const CART_MAX_LINES = 50;

const state = {
  shop: { shopName: 'Napoli Coffee', currency: 'EUR', sellerUsername: '' },
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
  derniere: null,     // la dernière commande du client, pour « la même chose »
  blocked: false,     // compte privé de commande par le vendeur
  mode: 'pickup',
  captcha: null,      // épreuve en cours
  selection: [],      // tuiles touchées
  cart: loadCart(),
  startProduct: null, // produit demandé par un lien direct, à ouvrir une fois entré
  current: null, // produit ouvert dans la fiche
  currentVariant: null,
  currentQty: 1,
  bascule: 0,       // instant du prochain changement d'état de la boutique
  decompte: null,   // minuterie du bandeau
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
  montrerLeSquelette();

  try {
    const res = await fetch('/api/catalog');
    if (!res.ok) {
      // Le serveur explique souvent la panne dans le corps — un dossier de
      // données mal attribué, par exemple. Le remplacer par « HTTP 503 »
      // jetterait précisément ce qui sert à la réparer.
      const dit = await res.json().catch(() => ({}));
      throw new Error(dit.error ?? `HTTP ${res.status}`);
    }
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
    appliquerLesAnimations();
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
  renderStatut();
  renderModes();
  renderCategories();
  renderGrid();
  renderCart();
  loadSlots();
  chargerLaDerniereCommande();
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

/**
 * Pose des cartes vides le temps que le catalogue arrive.
 *
 * Mieux qu'un écran vide : la grille montre sa forme, l'attente paraît plus
 * courte, et l'écran ne saute pas au moment où les vraies cartes arrivent —
 * elles occupent déjà la place.
 */
function montrerLeSquelette() {
  const grille = $('grid');
  if (grille.childElementCount) return;
  grille.replaceChildren(
    ...Array.from({ length: 6 }, () => {
      const faux = document.createElement('div');
      faux.className = 'squelette';
      faux.setAttribute('aria-hidden', 'true');
      return faux;
    })
  );
}

/**
 * Suspend ou rétablit tout le mouvement de la boutique.
 *
 * Deux raisons de le couper : le vendeur a éteint la fonctionnalité, ou le
 * système du client demande moins de mouvement — un réglage qu'on ne discute
 * pas, souvent posé pour raison médicale. Le CSS fait le reste ; rien ne
 * disparaît, tout devient simplement immobile.
 */
function appliquerLesAnimations() {
  const sobre = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const coupe = state.features.animations === false || sobre;
  document.documentElement.dataset.anim = coupe ? 'off' : 'on';
  return !coupe;
}

/** Vrai si la boutique a le droit de bouger. */
const anime = () => document.documentElement.dataset.anim !== 'off';

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
  // Facultatif, et c'est tout l'enjeu : la commande est déjà partie, ce bouton
  // ne sert qu'à ceux qui veulent ajouter un mot.
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
  $('reprise').addEventListener('click', () => reprendreLaCommande());
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

  $('pGalleryPrev').addEventListener('click', () => glisserGalerie(-1));
  $('pGalleryNext').addEventListener('click', () => glisserGalerie(1));

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

  // Sans zone déclarée, la boutique livre partout : un code postal n'a alors
  // rien à dire, et « on ne livre pas encore le 68100 » sous l'adresse d'une
  // boutique qui livre partout fait renoncer pour rien.
  if (!code || !state.zones.length) {
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

/**
 * Le bandeau d'état, avec le décompte jusqu'au prochain basculement.
 *
 * « Ouvert » tout seul ne dit rien d'utile : un client qui remplit son panier
 * veut savoir s'il a le temps de finir. Le décompte est relatif — rendu en
 * minutes par le serveur — parce que le téléphone du client peut être à
 * l'heure d'un autre fuseau, et qu'un « ferme dans 20 min » reste juste
 * partout.
 */
function renderStatut() {
  const bandeau = $('statutBar');

  // Sans horaires, l'état ne change pas : un bandeau qui répète « ouvert »
  // n'apprend rien et prend de la place.
  const prochain = state.opening.prochain;
  if (state.features.animations === false || state.blocked || !prochain) {
    bandeau.hidden = true;
    arreterLeDecompte();
    return;
  }

  bandeau.hidden = false;
  bandeau.classList.toggle('statut--ferme', !state.opening.open);
  $('statutTexte').textContent = state.opening.open ? 'Boutique ouverte' : 'Boutique fermée';

  // On retient l'instant du basculement plutôt que le nombre de minutes :
  // une Mini App reste ouverte des heures, et un compteur figé à l'arrivée
  // mentirait très vite.
  state.bascule = Date.now() + prochain.minutes * 60000;
  rafraichirLeDecompte();
  arreterLeDecompte();
  // Une fois par minute suffit : on n'affiche pas les secondes.
  state.decompte = setInterval(rafraichirLeDecompte, 30000);
}

function arreterLeDecompte() {
  if (state.decompte) clearInterval(state.decompte);
  state.decompte = null;
}

function rafraichirLeDecompte() {
  const reste = Math.round((state.bascule - Date.now()) / 60000);
  const verbe = state.opening.open ? 'ferme' : 'ouvre';

  if (reste <= 0) {
    // L'heure du basculement est passée : c'est au serveur de trancher, pas
    // à nous de deviner. On recharge le catalogue, qui porte l'état réel.
    $('statutCompte').textContent = '';
    arreterLeDecompte();
    refreshCatalog();
    return;
  }

  const heures = Math.floor(reste / 60);
  const minutes = reste % 60;
  $('statutCompte').textContent = heures
    ? `${verbe} dans ${heures} h${minutes ? ` ${minutes}` : ''}`
    : `${verbe} dans ${minutes} min`;
}

/**
 * La jauge de progression vers le prochain avantage.
 *
 * @returns {boolean} vrai si elle s'affiche — la phrase des paliers s'efface
 *   alors, pour ne pas dire deux fois la même chose.
 *
 * Un client à qui il manque cinq euros pour la livraison offerte les ajoute
 * presque toujours — encore faut-il qu'il le sache, et qu'il voie de combien
 * il s'en approche. La barre dit d'un coup d'œil ce qu'une phrase dit moins
 * vite.
 */
function renderJauge(subtotal) {
  const jauge = $('jauge');
  if (state.features.animations === false) {
    jauge.hidden = true;
    return false;
  }

  const objectif = prochainObjectif(subtotal);
  if (!objectif) {
    jauge.hidden = true;
    return false;
  }

  jauge.hidden = false;
  jauge.classList.toggle('jauge--atteint', objectif.atteint);
  $('jaugeTexte').textContent = objectif.texte;
  $('jaugeReste').textContent = objectif.atteint
    ? '✓'
    : `plus que ${formatPrice(objectif.seuil - subtotal)}`;
  // La largeur est bornée : au-delà du seuil, la barre est pleine, pas plus.
  const part = Math.max(4, Math.min(100, Math.round((subtotal / objectif.seuil) * 100)));
  $('jaugeBarre').style.width = `${objectif.atteint ? 100 : part}%`;
  return true;
}

/**
 * Le prochain avantage à atteindre, ou celui qu'on vient d'obtenir.
 *
 * La livraison offerte passe devant les paliers de remise quand elle est plus
 * proche : c'est celle qui parle le plus, et deux jauges à la fois ne diraient
 * plus rien du tout.
 */
function prochainObjectif(subtotal) {
  const candidats = [];

  const franco = state.fulfillment.freeDeliveryFrom;
  if (state.mode === 'delivery' && franco) {
    candidats.push({ seuil: franco, texte: 'Livraison offerte', atteint: subtotal >= franco });
  }
  for (const palier of state.tiers) {
    candidats.push({
      seuil: palier.from,
      texte: `−${palier.percent} % sur la commande`,
      atteint: subtotal >= palier.from,
    });
  }
  if (!candidats.length) return null;

  // Celui qu'on n'a pas encore atteint et qui est le plus proche ; à défaut,
  // le dernier obtenu, pour que la barre pleine reste une bonne nouvelle.
  const devant = candidats.filter((c) => !c.atteint).sort((a, b) => a.seuil - b.seuil)[0];
  if (devant) return devant;
  return candidats.sort((a, b) => b.seuil - a.seuil)[0];
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

  const cartes = list.map(productCard);

  // Chaque carte porte son rang : le CSS en tire le décalage de la cascade.
  // Le rang est plafonné, sinon la trentième carte d'un gros catalogue
  // attendrait plus d'une seconde avant de paraître.
  if (anime()) {
    cartes.forEach((carte, rang) => {
      carte.style.setProperty('--rang', String(Math.min(rang, 12)));
      carte.classList.add('card--entre');
    });
  }

  arreterLesVideosDeLaGrille(grid);
  grid.replaceChildren(...cartes);
}

/**
 * Détache les vidéos de la grille qu'on s'apprête à remplacer.
 *
 * Un élément retiré du document peut continuer à charger sa source : on coupe
 * la lecture et on détache l'adresse, comme pour la galerie d'une fiche.
 */
function arreterLesVideosDeLaGrille(grid) {
  for (const video of grid.querySelectorAll('.card__video')) {
    regardSurLaGrille?.unobserve(video);
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
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

/**
 * La vidéo à montrer dans la grille, s'il y en a une à montrer.
 *
 * Un produit dont la galerie ne contient que des vidéos n'avait rien à mettre
 * en vitrine : la grille gardait le dessin par défaut, et rien n'annonçait au
 * client qu'une vidéo l'attendait sur la fiche. On prend donc la première
 * vidéo — mais seulement faute de photo. Une photo posée par le vendeur est une
 * décision ; un dessin n'est qu'un pis-aller.
 */
function videoDeVitrine(product) {
  if (isPhoto(product.image)) return null;

  const medias = Array.isArray(product.media) ? product.media : [];
  if (medias.some((m) => m.kind === 'photo')) return null;

  const rang = medias.findIndex((m) => m.kind === 'video');
  if (rang === -1) return null;
  return {
    url: medias[rang].url ?? `/api/media/${product.id}/${rang}`,
    poster: posterDe(product, medias[rang], rang),
  };
}

/**
 * L'image à montrer en attendant que la vidéo arrive.
 *
 * Une vidéo de plusieurs mégaoctets met le temps qu'il faut, et sans `poster`
 * le cadre reste noir pendant ce temps-là : le client croit la boutique en
 * panne. Telegram fabrique justement une vignette de quelques kilo-octets pour
 * chaque vidéo qu'on lui confie — elle arrive tout de suite. À défaut,
 * l'illustration du produit tient la place : n'importe quoi vaut mieux qu'un
 * rectangle vide.
 */
function posterDe(product, media, rang) {
  if (media.thumbFileId) return `/api/media/${product.id}/${rang}/apercu`;
  return product.image || '';
}

/**
 * Les vidéos de la grille ne tournent que sous les yeux du client.
 *
 * Une carte hors écran qui continue de jouer dépense des données et de la
 * batterie pour rien. L'observateur est unique et survit aux rendus : une carte
 * retirée de la grille cesse d'être observée d'elle-même.
 */
const regardSurLaGrille =
  'IntersectionObserver' in window
    ? new IntersectionObserver(
        (entrees) => {
          for (const entree of entrees) {
            if (entree.isIntersecting && anime()) entree.target.play().catch(() => {});
            else entree.target.pause();
          }
        },
        { threshold: 0.4 }
      )
    : null;

function productCard(product) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'card';
  card.setAttribute('aria-label', `${product.name}, ${formatPrice(product.price)}`);

  const soldOut = isSoldOut(product);
  if (soldOut) card.classList.add('card--soldout');

  const fromLabel = product.variants ? '<small>dès</small> ' : '';
  const badge = soldOut ? 'ÉPUISÉ' : product.badge;
  const video = videoDeVitrine(product);
  // Muette et sans contrôles : la carte entière reste un bouton qui ouvre la
  // fiche, et aucun son ne sort d'une grille de catalogue.
  const visuel = video
    ? `<video class="card__video" src="${escapeHtml(video.url)}" poster="${escapeHtml(video.poster)}"
             muted loop playsinline
             preload="metadata" disablepictureinpicture tabindex="-1" aria-hidden="true"></video>
       <span class="card__film" aria-hidden="true">▶</span>`
    : `<img src="${product.image}" alt="" loading="lazy">`;

  card.innerHTML = `
    <div class="card__art${video ? ' card__art--video' : isPhoto(product.image) ? ' card__art--photo' : ''}">
      ${badge ? `<span class="card__badge ${soldOut ? 'card__badge--out' : ''}">${escapeHtml(badge)}</span>` : ''}
      ${visuel}
    </div>
    <div class="card__body">
      <span class="card__name">${escapeHtml(product.name)}</span>
      <span class="card__short">${escapeHtml(product.short)}</span>
      <span class="card__foot">
        <span class="card__price goldtext">${fromLabel}${formatPrice(product.price)}</span>
        <span class="card__add" aria-hidden="true">+</span>
      </span>
    </div>`;

  const lecteur = card.querySelector('.card__video');
  if (lecteur) {
    // L'attribut seul ne suffit pas partout : sans cette ligne, un navigateur
    // refuse la lecture faute de garantie que le son est coupé.
    lecteur.muted = true;
    if (regardSurLaGrille) regardSurLaGrille.observe(lecteur);
    else if (anime()) lecteur.play().catch(() => {});
  }

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
  // La galerie se monte après l'ouverture, et non avant : `openSheet` referme
  // les autres feuilles, et cette fermeture détache les vidéos — elle vidait
  // donc la galerie qu'on venait tout juste de construire.
  renderGalerie(product);
  haptic('light');
}

/**
 * Monte la galerie du produit, ou retombe sur l'illustration unique.
 *
 * Le défilement est celui du navigateur, aimanté par CSS : le glissement du
 * doigt reste celui du système, donc fluide, et il continue de marcher si le
 * script échoue. Le JavaScript ne fait que les points, les flèches, et
 * l'arrêt des vidéos.
 */
function renderGalerie(product) {
  const art = $('pImage').closest('.pdetail__art');
  const galerie = $('pGallery');
  const piste = $('pGalleryTrack');
  const points = $('pGalleryDots');

  arreterLesVideos();
  piste.replaceChildren();
  points.replaceChildren();

  const medias = Array.isArray(product.media) ? product.media : [];
  if (!medias.length) {
    // Pas de galerie : l'illustration d'origine reprend sa place.
    galerie.hidden = true;
    $('pImage').src = product.image;
    $('pImage').alt = product.name;
    art.classList.toggle('pdetail__art--photo', isPhoto(product.image));
    return;
  }

  galerie.hidden = false;
  art.classList.remove('pdetail__art--photo');

  medias.forEach((media, rang) => {
    const case_ = document.createElement('div');
    case_.className = 'galerie__media';

    if (media.kind === 'video') {
      const video = document.createElement('video');
      video.src = media.url ?? `/api/media/${product.id}/${rang}`;
      // La vignette d'abord : la fiche montre quelque chose dès son ouverture,
      // sans attendre le premier octet de la vidéo.
      const apercu = posterDe(product, media, rang);
      if (apercu) video.poster = apercu;
      video.controls = true;
      video.preload = 'metadata';
      video.playsInline = true;
      // Ni lecture automatique ni son surprise : une fiche produit qui se met
      // à parler dans un lieu public fait fermer la boutique.
      case_.append(video);

      const pastille = document.createElement('span');
      pastille.className = 'galerie__type';
      pastille.textContent = '▶ Vidéo';
      case_.append(pastille);
    } else {
      const img = document.createElement('img');
      img.src = media.url ?? `/api/media/${product.id}/${rang}`;
      img.alt = media.legende || `${product.name} — visuel ${rang + 1}`;
      img.loading = rang === 0 ? 'eager' : 'lazy';
      case_.append(img);
    }
    piste.append(case_);

    const point = document.createElement('span');
    point.className = 'galerie__point';
    point.setAttribute('role', 'tab');
    point.setAttribute('aria-selected', String(rang === 0));
    points.append(point);
  });

  const plusieurs = medias.length > 1;
  points.hidden = !plusieurs;
  $('pGalleryPrev').hidden = !plusieurs;
  $('pGalleryNext').hidden = !plusieurs;

  piste.scrollLeft = 0;
  if (plusieurs) suivreLeDefilement(piste, points);
}

/** Allume le point du média affiché, sans écouter en continu. */
function suivreLeDefilement(piste, points) {
  let attente = null;
  piste.onscroll = () => {
    if (attente) return;
    attente = setTimeout(() => {
      attente = null;
      const rang = Math.round(piste.scrollLeft / Math.max(1, piste.clientWidth));
      [...points.children].forEach((p, i) => p.setAttribute('aria-selected', String(i === rang)));
    }, 90);
  };
}

/** Déplace la galerie d'un média. */
function glisserGalerie(pas) {
  const piste = $('pGalleryTrack');
  piste.scrollBy({ left: pas * piste.clientWidth, behavior: 'smooth' });
}

/**
 * Coupe toute vidéo en cours.
 *
 * Sans ça, fermer la fiche laissait le son continuer par-dessus le catalogue :
 * le client entend une voix sans savoir d'où elle vient, et cherche le bouton
 * pour l'arrêter.
 */
function arreterLesVideos() {
  for (const video of document.querySelectorAll('#pGalleryTrack video')) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
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

/* ── « La même chose » ───────────────────────────────────── */

/**
 * Va chercher la dernière commande du client, s'il en a une.
 *
 * Sur une boutique de réassort, la plupart des commandes sont la précédente :
 * la refaire article par article est un travail qu'on peut lui épargner. Le
 * raccourci suit l'interrupteur « Mes commandes » — sans historique, il n'y a
 * rien à reprendre.
 */
async function chargerLaDerniereCommande() {
  const banniere = $('reprise');
  banniere.hidden = true;
  if (!tg?.initData || state.features.orderHistory === false) return;

  try {
    const res = await fetch('/api/orders', { headers: { 'X-Telegram-Init-Data': tg.initData } });
    if (!res.ok) return;
    const commandes = await res.json();
    state.derniere = commandes.find((c) => c.status !== 'annulee') ?? null;
    renderReprise();
  } catch {
    /* pas d'historique : le raccourci reste caché, la boutique fonctionne */
  }
}

/** La bannière ne se montre que si elle mène quelque part. */
function renderReprise() {
  const banniere = $('reprise');
  const commande = state.derniere;
  if (!commande) return void (banniere.hidden = true);

  // On regarde ce qui est encore commandable avant de proposer : promettre
  // « la même chose » puis annoncer que rien n'est disponible est pire que se
  // taire.
  const lignes = reprendreLesLignes(commande);
  if (!lignes.dispo.length) return void (banniere.hidden = true);

  const combien = lignes.dispo.reduce((somme, l) => somme + l.quantity, 0);
  $('repriseDetail').textContent =
    `${lignes.dispo.map((l) => l.nom).slice(0, 2).join(', ')}` +
    `${lignes.dispo.length > 2 ? '…' : ''} · ${combien} article${combien > 1 ? 's' : ''}`;
  banniere.hidden = false;
}

/**
 * Ce qu'on peut reprendre d'une commande, et ce qui manque.
 *
 * Le catalogue a pu bouger depuis : un produit retiré, un format supprimé, un
 * stock descendu. On reprend ce qui existe encore, dans la limite du stock, et
 * on dit ce qui manque plutôt que de laisser le client s'en apercevoir au
 * moment de payer.
 */
function reprendreLesLignes(commande) {
  const dispo = [];
  const manquants = [];

  for (const item of commande.items ?? []) {
    const produit = state.products.find((p) => p.id === item.id);
    const variante = produit?.variants?.find((v) => v.id === item.variantId) ?? null;

    if (!produit || (item.variantId && !variante)) {
      manquants.push(item.name);
      continue;
    }
    const stock = stockOf(produit, variante?.id ?? null);
    if (stock <= 0) {
      manquants.push(`${produit.name}${variante ? ` (${variante.label})` : ''}`);
      continue;
    }
    dispo.push({
      key: `${produit.id}::${variante?.id ?? ''}`,
      id: produit.id,
      variantId: variante?.id ?? null,
      quantity: Math.min(item.quantity, stock, 99),
      nom: produit.name,
      // Une quantité rabotée par le stock doit se dire : le client croirait
      // sinon avoir commandé ce qu'il avait pris la fois d'avant.
      rabote: Math.min(item.quantity, stock, 99) < item.quantity,
    });
  }
  return { dispo, manquants };
}

/** Remet la dernière commande dans le panier, et dit ce qui a changé. */
function reprendreLaCommande(commande) {
  const { dispo, manquants } = reprendreLesLignes(commande ?? state.derniere ?? {});
  if (!dispo.length) {
    toast("Rien de cette commande n'est disponible en ce moment.");
    return;
  }

  // Un panier déjà rempli ne se remplace pas dans le dos de celui qui l'a
  // rempli : on demande.
  if (state.cart.length && !confirm('Remplacer ton panier par ta dernière commande ?')) return;

  state.cart = dispo.map(({ key, id, variantId, quantity }) => ({ key, id, variantId, quantity }));
  saveCart();
  renderCart();
  revalidatePromo();
  closeSheets();
  openSheet('cartSheet');
  haptic('success');

  const rabotes = dispo.filter((l) => l.rabote).length;
  toast(
    [
      `${dispo.length} article${dispo.length > 1 ? 's' : ''} remis au panier`,
      manquants.length ? `${manquants.length} indisponible${manquants.length > 1 ? 's' : ''}` : '',
      rabotes ? 'quantité ajustée au stock' : '',
    ]
      .filter(Boolean)
      .join(' · ')
  );
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

  // La vignette part vers le panier AVANT la fermeture de la fiche : c'est
  // d'elle qu'on relève la position de départ, et une feuille refermée n'a
  // plus de position.
  const decollage = volVersLePanier();
  closeSheets();
  haptic('success');
  toast(`${product.name} ajouté au panier 🛒`);

  // La pastille saute quand la vignette la rejoint, pas avant : les deux
  // gestes racontent alors la même chose au même moment.
  const sauter = () => {
    const badge = $('cartCount');
    badge.classList.remove('pop');
    void badge.offsetWidth; // force le redémarrage de l'animation
    badge.classList.add('pop');
  };
  decollage ? decollage.then(sauter) : sauter();
}

/**
 * Fait voler la vignette du produit jusqu'au bouton du panier.
 *
 * Une copie posée par-dessus la page le temps du trajet : l'original ne bouge
 * pas, et la copie ne bloque aucun appui puisqu'elle ne reçoit pas les clics.
 * Rien de tout ça n'est nécessaire au fonctionnement — sans animation, la
 * fonction rend `null` et le panier se remplit pareil.
 *
 * @returns {Promise<void>|null} tenue jusqu'à l'arrivée, ou null si immobile.
 */
function volVersLePanier() {
  if (!anime()) return null;

  const source = $('pGallery').hidden
    ? $('pImage')
    : $('pGalleryTrack').querySelector('img');
  const cible = $('cartBtn');
  if (!source || !cible) return null;

  const depart = source.getBoundingClientRect();
  const arrivee = cible.getBoundingClientRect();
  if (!depart.width || !arrivee.width) return null;

  const copie = document.createElement('div');
  copie.className = 'vol';
  copie.style.left = `${depart.left}px`;
  copie.style.top = `${depart.top}px`;
  copie.style.width = `${depart.width}px`;
  copie.style.height = `${depart.height}px`;

  const image = document.createElement('img');
  image.src = source.currentSrc || source.src;
  image.alt = '';
  copie.append(image);
  document.body.append(copie);

  const dx = arrivee.left + arrivee.width / 2 - (depart.left + depart.width / 2);
  const dy = arrivee.top + arrivee.height / 2 - (depart.top + depart.height / 2);
  const echelle = Math.max(0.12, arrivee.width / Math.max(1, depart.width));

  return new Promise((fini) => {
    requestAnimationFrame(() => {
      copie.style.transform = `translate(${dx}px, ${dy}px) scale(${echelle})`;
      copie.style.opacity = '0.35';
    });
    // `transitionend` peut ne jamais venir — onglet en arrière-plan, animation
    // interrompue : le délai de secours garantit qu'on retire toujours la copie.
    let retire = false;
    const nettoyer = () => {
      if (retire) return;
      retire = true;
      copie.remove();
      fini();
    };
    copie.addEventListener('transitionend', nettoyer, { once: true });
    setTimeout(nettoyer, 700);
  });
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
  // L'adresse est demandée dès qu'on livre, zones ou pas : c'est le livreur
  // qui en a besoin, pas le calcul des frais.
  $('addressField').hidden = lines.length === 0 || !livraison;
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
    ? 'Téléphone (pour te prévenir à l\'arrivée)'
    : 'Téléphone (optionnel)';

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

  // La jauge se calcule avant l'affichage des remises : c'est elle qui décide
  // si la phrase des paliers a encore quelque chose à ajouter.
  const jaugeVisible = renderJauge(subtotal);

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
    // La jauge dit déjà ce qui manque, et mieux : répéter la phrase
    // juste au-dessus d'elle ferait lire deux fois la même chose.
    showPromoStatus(jaugeVisible ? '' : nextTierHint(subtotal), null);
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

  const note = $('orderNote').value.trim();
  const contact = $('orderContact').value.trim();
  const adresse = adresseSaisie();

  // On vérifie avant de toucher au bouton : désactivé puis abandonné en
  // « Préparation… », il restait mort jusqu'à ce que le panier bouge, et le
  // client n'avait plus rien sur quoi appuyer.
  if (state.mode === 'delivery') {
    // Le même reproche que le serveur, mais tout de suite, et le doigt posé
    // sur le champ qui manque : un aller-retour pour rien décourage.
    const manque = adresseIncomplete(adresse);
    if (manque) {
      toast(manque.texte);
      $(manque.champ).focus();
      return;
    }
  }

  const button = $('checkout');
  button.disabled = true;
  button.textContent = 'Préparation…';

  // Figés avant l'envoi : la commande réussie efface le code consommé et le
  // créneau réservé, et le récapitulatif doit quand même les porter.
  const remise = currentDiscount(cartTotal());
  const creneau = state.slots.find((s) => s.id === state.slotId) ?? null;
  const zone = state.zone;

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
        postalCode: adresse.postalCode || null,
        slotId: state.slotId || null,
        address: state.mode === 'delivery' ? adresse : null,
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
    // Serveur injoignable, et non refus : là, on continue. Sans commande
    // enregistrée, personne n'est prévenu : c'est le seul cas où le client est
    // emmené dans la conversation du vendeur, plus bas.
    console.warn('Enregistrement de la commande impossible :', err);
  }

  const message = buildOrderMessage(lines, note, reference, contact, remise, creneau, zone, adresse);
  // Gardé pour le bouton « Une question au vendeur » : le client peut envoyer
  // son récapitulatif s'il en a envie, mais plus rien ne l'y pousse.
  state.lastMessage = message;

  button.disabled = false;
  button.textContent = 'Commander';
  haptic('success');

  // Commande écrite côté serveur : le panier a fait son travail. Le laisser
  // plein invitait à réappuyer sur Commander — et à réserver le stock une
  // seconde fois sans que rien ne le dise.
  if (reference) {
    showOrderDone(reference, lines, remise, creneau, zone);
    // La commande qu'on vient de passer devient celle qu'on pourra reprendre.
    chargerLaDerniereCommande();
    state.cart = [];
    saveCart();
    renderCart();
    // Le stock vient de bouger : sans ce rafraîchissement, la grille propose
    // encore des articles qu'on vient soi-même d'emporter.
    refreshCatalog();
  } else {
    // Rien n'a été enregistré : le serveur n'a pas répondu, donc le vendeur
    // n'a rien reçu et ne recevra rien. La conversation est le dernier chemin
    // qui reste à cette commande — c'est le seul cas où on y emmène le client.
    openSellerChat(message);
  }
}

/** L'adresse telle qu'elle est écrite, sans juger de ce qui manque. */
function adresseSaisie() {
  const propre = (id) => $(id).value.replace(/\s+/g, ' ').trim();
  return {
    street: propre('orderStreet'),
    complement: propre('orderComplement'),
    postalCode: propre('orderPostal'),
    city: propre('orderCity'),
  };
}

/**
 * Ce qui manque pour qu'un livreur trouve la porte.
 *
 * Les mêmes règles que le serveur, qui reste seul juge : celles-ci ne sont là
 * que pour dire tout de suite quel champ remplir. Le numéro de rue n'est pas
 * exigé — un lieu-dit n'en a pas, et refuser sa commande coûterait plus cher
 * qu'une adresse imprécise.
 */
function adresseIncomplete(adresse) {
  if (adresse.street.length < 5) {
    return { champ: 'orderStreet', texte: 'Indique la rue et le numéro.' };
  }
  if (!/^\d{2,6}$/.test(adresse.postalCode)) {
    return { champ: 'orderPostal', texte: 'Indique ton code postal.' };
  }
  if (adresse.city.length < 2) return { champ: 'orderCity', texte: 'Indique la ville.' };
  return null;
}

/** Accusé de réception : sans lui, rien dans l'app ne dit que c'est parti. */
function showOrderDone(reference, lines, remise, creneau, zone) {
  const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const fee = deliveryFeeFor(subtotal);

  $('doneRef').textContent = reference;
  // Le vendeur est prévenu côté serveur : demander au client d'envoyer lui-même
  // le récapitulatif faisait arriver la commande deux fois, et laissait croire
  // qu'elle n'était pas passée tant qu'il n'avait pas appuyé sur Envoyer.
  // L'accusé du bot, lui, est une fonctionnalité que le vendeur peut couper —
  // promettre une confirmation qui n'arrivera jamais vaut moins que se taire.
  $('doneText').textContent =
    state.features.clientNotifications === false
      ? 'On a reçu ta commande, le vendeur est prévenu. Il revient vers toi très vite.'
      : 'On a reçu ta commande, le vendeur est prévenu. La confirmation arrive dans la conversation du bot.';

  // Écrire au vendeur reste possible, mais sans compte configuré le bouton
  // n'avait qu'un message d'erreur à offrir.
  $('doneChat').hidden = !state.shop.sellerUsername;

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
    // Un article épuisé entre-temps ne doit plus être promis par le raccourci.
    renderReprise();
  } catch {
    /* on garde l'affichage précédent plutôt que de vider la boutique */
  }
}

function buildOrderMessage(lines, note, reference, contact, remise, creneau, zone, adresse) {
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
  if (state.mode === 'delivery' && adresse?.street) {
    parts.push('', 'Adresse :');
    parts.push(adresse.street);
    if (adresse.complement) parts.push(adresse.complement);
    parts.push(`${adresse.postalCode} ${adresse.city}`.trim());
    if (contact) parts.push(`Téléphone : ${contact}`);
  } else if (contact) {
    parts.push(`Contact : ${contact}`);
  }
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

  // Reprendre une commande précise, pas seulement la dernière : un client
  // revient parfois sur celle d'avant.
  if (order.status !== 'annulee') {
    const reprise = document.createElement('button');
    reprise.className = 'btn btn--ghost btn--block';
    reprise.type = 'button';
    reprise.textContent = '🔁 Reprendre cette commande';
    reprise.addEventListener('click', () => reprendreLaCommande(order));
    card.append(reprise);
  }
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
  // Une vidéo laissée en lecture continuerait de parler par-dessus le
  // catalogue, sans que le client sache d'où vient le son.
  arreterLesVideos();
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
