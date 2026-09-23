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
  notes: {},          // la note moyenne de chaque produit, venue du catalogue
  avisADonner: [],    // ses commandes reçues dont il n'a encore rien dit
  avisEnCours: null,  // la commande qu'il est en train de noter
  prenom: '',         // son prénom Telegram, pour lui montrer ce qu'il signerait
  favoris: new Set(), // les produits qu'il garde de côté
  preferences: {},    // ce qu'il accepte de recevoir
  onglet: 'filtres',       // l'écran affiché : filtres, categories, contact, profil, produit
  retour: 'filtres',       // l'onglet où la flèche de la fiche ramène
  profilVue: 'commandes',  // l'onglet ouvert dans le profil
  avisTousVisibles: false,  // « voir tous les avis » d'une fiche
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
    const night = themeHex('--night-rgb', '#141110');
    tg.setHeaderColor?.(night);
    tg.setBackgroundColor?.(night);
    tg.enableClosingConfirmation?.();
    tg.BackButton?.onClick(revenirEnArriere);
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
    state.notes = data.notes ?? {};
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
    retirerLeVoile();
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
  renderSousTitre();
  renderStatut();
  renderModes();
  renderCategories();
  renderGrid();
  renderCart();
  retirerLeVoile();
  mesurerLaBarre();
  // La barre bouge avec la rotation de l'écran et avec le clavier : une
  // mesure prise une fois au lancement se périme au premier quart de tour.
  window.addEventListener('resize', mesurerLaBarre);
  runGates();
}

/**
 * Tout ce qui demande d'être reconnu : commandes, avis, favoris, créneaux.
 *
 * Séparé de l'ouverture parce que ça se rejoue. La porte du bot peut s'ouvrir
 * pendant qu'on regarde l'écran — le client vient de calculer dans le chat et
 * revient — et il faut bien que la boutique se remplisse sans qu'il la
 * relance. Une fois suffit : le garde-fou évite que chaque voile refermé
 * redemande les mêmes quatre listes.
 */
let signeCharge = false;
function chargerLaBoutiqueSignee() {
  if (signeCharge) return;
  signeCharge = true;
  loadSlots();
  chargerLaDerniereCommande();
  chargerLesAvisADonner();
  chargerLesFavoris();
  battreLePouls();
}

/* ── Le voile de chargement ──────────────────────────────── */

/**
 * Retire le voile d'ouverture.
 *
 * `hidden` plutôt qu'un retrait du DOM : la feuille de style le fait
 * disparaître en fondu, et un élément arraché ne peut pas fondre. Il ne gêne
 * plus personne une fois transparent (`pointer-events: none`).
 */
function retirerLeVoile() {
  const voile = document.getElementById('charge');
  if (voile) voile.hidden = true;
}

/** Change le mot sous l'anneau, quand l'attente a une raison qu'on sait dire. */
function direPendantLeChargement(texte) {
  const ligne = document.getElementById('chargeTexte');
  if (ligne) ligne.textContent = texte;
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
  for (const bouton of $('tabbar').querySelectorAll('.tabbar__item')) {
    bouton.addEventListener('click', () => {
      montrerLOnglet(bouton.dataset.onglet);
      haptic('light');
    });
  }
  $('contactTelegram').addEventListener('click', () =>
    openSellerChat(`Bonjour ${state.shop.shopName} 👋`));
  $('pCoeur').addEventListener('click', async () => {
    if (!state.current) return;
    await basculerFavori(state.current.id);
    peindreLeCoeur($('pCoeur'), state.current.id);
    // La grille derrière la feuille porte le même cœur : sans ça, il reste
    // allumé après qu'on l'a éteint ici.
    renderGrid();
  });
  for (const onglet of $('profilOnglets').querySelectorAll('.profil__onglet')) {
    onglet.addEventListener('click', () => {
      montrerLaVue(onglet.dataset.vue);
      haptic('light');
    });
  }
  $('pRetour').addEventListener('click', () => { montrerLOnglet(state.retour); haptic('light'); });
  $('captchaSubmit').addEventListener('click', submitCaptcha);
  // Fermer la Mini App ramène le client dans la conversation du bot, là où il
  // envoie sa pièce : pas besoin de connaître le nom du bot.
  $('verifAction').addEventListener('click', () => (tg ? tg.close() : window.history.back()));
  $('porteAction').addEventListener('click', () => (tg ? tg.close() : window.history.back()));
  $('porteRetry').addEventListener('click', () => reprendreSiLaPorteEstOuverte({ dire: true }));
  $('checkout').addEventListener('click', checkout);
  // Facultatif, et c'est tout l'enjeu : la commande est déjà partie, ce bouton
  // ne sert qu'à ceux qui veulent ajouter un mot.
  $('doneChat').addEventListener('click', () => openSellerChat(state.lastMessage));
  $('suggestionAvis').addEventListener('click', () => ouvrirLAvis(state.avisADonner[0]));
  $('avisEnvoyer').addEventListener('click', envoyerLAvis);
  for (const choix of $('avisSignature').querySelectorAll('.signature__choix')) {
    choix.addEventListener('click', () => {
      state.avisEnCours.anonyme = choix.dataset.anonyme === 'oui';
      renderSignature();
      haptic('light');
    });
  }
  // La note de la fiche descend jusqu'aux avis : c'est ce qu'on attend d'une
  // note sur laquelle on peut appuyer.
  $('pNote').addEventListener('click', () => {
    $('pAvis').scrollIntoView({ behavior: anime() ? 'smooth' : 'auto', block: 'start' });
  });
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
  document.addEventListener('keydown', (e) => e.key === 'Escape' && revenirEnArriere());
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
  // Le profil reste accessible même sans historique : il porte aussi les
  // favoris et les alertes, et chaque section dit elle-même si elle est éteinte.
  // Un onglet qui n'ouvre que des sections éteintes n'a rien à montrer : on
  // le retire de la barre, qui passe alors à trois colonnes toute seule.
  const profilVide =
    state.features.orderHistory === false &&
    state.features.favoris === false &&
    state.features.announcements === false;
  const ongletProfil = $('tabbar').querySelector('[data-onglet="profil"]');
  ongletProfil.hidden = profilVide;
  $('tabbar').style.gridTemplateColumns = `repeat(${profilVide ? 3 : 4}, 1fr)`;
  if (profilVide && state.onglet === 'profil') montrerLOnglet('filtres');
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

/* ── Les quatre onglets ──────────────────────────────────── */

/**
 * Mesure la barre du bas, et le dit à la feuille de style.
 *
 * Deux choses se posent dessus : le corps de la page, qui doit s'arrêter
 * au-dessus, et la barre d'achat de la fiche produit. Une valeur écrite en
 * dur dans le CSS se trompe dès que le téléphone grossit le texte du système
 * ou que l'encoche change la marge basse — et la dernière carte du catalogue
 * finit sous les onglets, hors de portée.
 */
function mesurerLaBarre() {
  const barre = $('tabbar');
  const haut = barre?.offsetHeight;
  if (haut) document.documentElement.style.setProperty('--tabbar-h', `${haut}px`);
}



const ONGLETS = {
  filtres: 'vueFiltres',
  categories: 'vueCategories',
  contact: 'vueContact',
  profil: 'vueProfil',
};

/* La fiche produit est une vue de plus, mais pas un onglet : on y entre
   depuis une carte, jamais depuis la barre du bas. */
const VUES = { ...ONGLETS, produit: 'vueProduit' };

/**
 * Montre un écran, et un seul.
 *
 * Les quatre vues sont des sections voisines plutôt que quatre pages : la
 * grille garde alors sa position de défilement, ses images chargées et la
 * recherche en cours quand on va voir son profil et qu'on revient. Les
 * remonter à chaque aller-retour aurait fait clignoter tout l'écran pour
 * rien.
 *
 * Le défilement, lui, repart en haut : arriver au milieu d'un écran qu'on
 * vient d'ouvrir donne l'impression d'avoir raté le début.
 */
function montrerLOnglet(nom) {
  if (!VUES[nom]) nom = 'filtres';
  const change = state.onglet !== nom;

  // D'où l'on vient, pour savoir où la flèche de la fiche doit ramener. On
  // ne retient qu'un onglet : revenir d'une fiche ouverte depuis une autre
  // fiche (par les suggestions du bas) doit rendre le catalogue, pas
  // remonter une pile de fiches que personne ne se rappelle avoir empilée.
  if (nom === 'produit' && state.onglet !== 'produit') state.retour = state.onglet;
  // Quitter la fiche coupe ses vidéos : une bande-son qui continue par-dessus
  // le catalogue laisse chercher d'où vient le bruit.
  if (change && state.onglet === 'produit') arreterLesVideos();

  state.onglet = nom;

  for (const [clef, id] of Object.entries(VUES)) $(id).hidden = clef !== nom;
  for (const bouton of $('tabbar').querySelectorAll('.tabbar__item')) {
    bouton.setAttribute('aria-selected', String(bouton.dataset.onglet === nom));
  }
  syncBackButton();

  // Chaque écran se remplit au moment où on le demande, pas au lancement :
  // le profil est un appel réseau, et les rayons un catalogue entier à
  // disposer. Les construire d'avance ralentirait l'ouverture de la boutique
  // pour deux écrans sur trois que le client n'ouvrira pas.
  if (nom === 'categories') renderRayons();
  if (nom === 'contact') renderContact();
  if (nom === 'profil') ouvrirProfil();

  if (change) window.scrollTo({ top: 0, behavior: 'auto' });
}

/* ── Les rayons ──────────────────────────────────────────── */

/**
 * Le catalogue rangé par catégorie, chacune sous son intitulé.
 *
 * L'autre onglet répond à « je cherche ça » ; celui-ci répond à « montre-moi
 * ce que tu as ». Les produits sont les mêmes, et les cartes aussi — une
 * deuxième sorte de carte aurait voulu dire deux endroits à corriger le jour
 * où le prix s'affiche autrement.
 *
 * Une catégorie vide n'est pas montrée : un rayon avec zéro article dit au
 * client qu'on n'a rien, alors qu'on n'a simplement rien ici.
 */
function renderRayons() {
  const hote = $('rayons');
  const rayons = state.categories
    .filter((cat) => cat.id !== 'all')
    .map((cat) => ({ cat, produits: trier(state.products.filter((p) => p.category === cat.id)) }))
    .filter(({ produits }) => produits.length > 0);

  $('rayonsVide').hidden = rayons.length > 0;

  hote.replaceChildren(
    ...rayons.map(({ cat, produits }) => {
      const bloc = document.createElement('section');
      bloc.className = 'rayon';

      const tete = document.createElement('div');
      tete.className = 'rayon__tete';
      const nom = document.createElement('h2');
      nom.className = 'rayon__nom';
      nom.textContent = `${cat.emoji ?? ''} ${cat.label}`.trim();
      const compte = document.createElement('span');
      compte.className = 'rayon__compte';
      compte.textContent = `${produits.length} produit${produits.length > 1 ? 's' : ''}`;
      tete.append(nom, compte);

      const grille = document.createElement('div');
      grille.className = 'rayon__grille';
      grille.append(...produits.map(productCard));

      bloc.append(tete, grille);
      return bloc;
    })
  );
}

/* ── Contact ─────────────────────────────────────────────── */

/**
 * L'écran « écris-nous ».
 *
 * Il ne fait qu'une chose, et c'est voulu : ouvrir la conversation. Le reste
 * — horaires, mode de retrait — est rappelé dessous parce que c'est
 * précisément ce qu'on vient demander quand on ne trouve pas la réponse, et
 * qu'une réponse affichée coûte moins cher qu'une réponse à écrire.
 */
function renderContact() {
  const sans = !state.shop.sellerUsername;
  $('contactTelegram').disabled = sans;
  $('contactFine').textContent = sans
    ? "Le compte vendeur n'est pas encore renseigné : reviens un peu plus tard."
    : `Tu écris à @${state.shop.sellerUsername}. Réponse dès qu'on est dispo.`;

  const lignes = [];
  const ouvert = state.opening?.open !== false;
  lignes.push([ouvert ? '🟢' : '🔴', ouvert ? 'Boutique ouverte' : 'Boutique fermée',
    ouvert ? 'On prend les commandes.' : (state.opening?.message ?? 'On rouvre bientôt.')]);
  if (state.fulfillment?.pickup) lignes.push(['🤝', 'Retrait sur place', 'Rendez-vous convenu dans la conversation.']);
  if (state.fulfillment?.delivery) lignes.push(['🛵', 'Livraison', 'Adresse demandée au moment de la commande.']);
  lignes.push(['💶', 'Paiement en espèces', 'À la remise, rien à avancer.']);

  $('contactInfos').replaceChildren(
    ...lignes.map(([emoji, titre, detail]) => {
      const ligne = document.createElement('div');
      ligne.className = 'contact__info';
      const icone = document.createElement('span');
      icone.setAttribute('aria-hidden', 'true');
      icone.textContent = emoji;
      const texte = document.createElement('span');
      const fort = document.createElement('b');
      fort.textContent = titre;
      texte.append(fort, document.createTextNode(` — ${detail}`));
      ligne.append(icone, texte);
      return ligne;
    })
  );
}

/* ── La porte du bot ─────────────────────────────────────── */

/**
 * L'épreuve se passe dans la conversation, pas ici.
 *
 * Le bouton « Boutique » en bas à gauche du chat est posé pour tout le monde
 * d'un seul geste — Telegram ne sait pas le montrer aux uns et le cacher aux
 * autres. Quelqu'un qui n'a jamais écrit au bot pouvait donc entrer ici sans
 * avoir répondu au calcul. Le serveur refuse maintenant ses appels ; cet écran
 * lui dit pourquoi, et où aller.
 *
 * On ne rejoue pas le calcul dans la Mini App : deux épreuves pour une seule
 * porte, c'est une de trop, et celle du chat a l'avantage d'exister avant que
 * la boutique s'ouvre — c'est exactement ce qu'on veut garder.
 */
let sondeDeLaPorte = null;

/** @returns {boolean} vrai si le voile reste affiché. */
async function gatePorte() {
  if (!state.gates.porte || !tg?.initData) return false;
  if (await porteOuverte()) return false;

  $('porte').hidden = false;
  lancerLaSonde();
  return true;
}

/**
 * Demande au serveur si la porte est ouverte.
 *
 * Une panne ne vaut pas une ouverture : si la réponse ne vient pas, tout le
 * reste de l'API est injoignable de la même façon, et lever le voile ne
 * donnerait qu'une boutique où rien ne marche. On garde l'écran, avec de quoi
 * réessayer.
 */
async function porteOuverte() {
  try {
    const res = await fetch('/api/porte', {
      headers: { 'X-Telegram-Init-Data': tg?.initData ?? '' },
    });
    if (!res.ok) return false;
    const etat = await res.json();
    return etat.requise === false || etat.ouverte === true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

/**
 * Guette l'instant où le calcul est fait.
 *
 * Le client répond dans le chat puis revient : s'il fallait qu'il ferme et
 * rouvre la boutique pour que l'écran change, la moitié l'abandonnerait là.
 * On regarde donc au retour d'onglet — le moment exact où ça vient d'arriver —
 * et toutes les cinq secondes tant que la page est visible, jamais quand elle
 * ne l'est pas : personne ne lit un écran caché, et la batterie non plus.
 */
function lancerLaSonde() {
  if (sondeDeLaPorte) return;
  sondeDeLaPorte = setInterval(() => {
    if (document.visibilityState === 'visible') reprendreSiLaPorteEstOuverte();
  }, 5000);
  document.addEventListener('visibilitychange', auRetourDeLaConversation);
}

function arreterLaSonde() {
  if (sondeDeLaPorte) clearInterval(sondeDeLaPorte);
  sondeDeLaPorte = null;
  document.removeEventListener('visibilitychange', auRetourDeLaConversation);
}

function auRetourDeLaConversation() {
  if (document.visibilityState === 'visible') reprendreSiLaPorteEstOuverte();
}

/**
 * Lève le voile si le calcul vient d'être fait, et remplit la boutique.
 *
 * @param {{dire?: boolean}} [options] `dire` fait répondre à un appui sur
 *   « J'ai répondu » même quand la porte est encore fermée : un bouton qui ne
 *   fait rien passe pour cassé.
 */
async function reprendreSiLaPorteEstOuverte({ dire = false } = {}) {
  if ($('porte').hidden) return true;
  if (!(await porteOuverte())) {
    if (dire) toast('Pas encore — réponds au calcul dans la conversation.');
    return false;
  }
  arreterLaSonde();
  $('porte').hidden = true;
  haptic('success');
  // Le séquenceur reprend où il s'était arrêté : l'épreuve de tuiles et la
  // vérification d'identité attendent derrière, et lui seul connaît l'ordre.
  runGates();
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
  if (await gatePorte()) return;

  // Passé la porte, les appels signés ont un sens, et c'est le bon moment :
  // les deux voiles qui restent empêchent de commander, pas de lire ses
  // commandes — le bouton « Regarder la boutique en attendant » le dit assez.
  chargerLaBoutiqueSignee();

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
/**
 * La photo à montrer pour un produit, quand il en a une.
 *
 * Deux endroits portent une image : le champ « photo » de la fiche, que le
 * vendeur choisit dans une liste, et la galerie, où il dépose ce qu'il
 * photographie lui-même. Seul le premier alimentait la vignette du
 * catalogue — si bien qu'un produit dont le vendeur avait importé trois
 * belles photos continuait de s'afficher avec le dessin par défaut, et il
 * fallait ouvrir la fiche pour voir la marchandise.
 *
 * L'ordre est celui de l'intention : une photo choisie dans le champ est une
 * décision, la première de la galerie en est une aussi, le dessin n'est qu'un
 * pis-aller.
 *
 * @returns {string|null} l'adresse d'une vraie photo, ou `null` s'il n'y en a
 *   aucune — auquel cas le dessin par défaut reprend sa place.
 */
function photoDeVitrine(product) {
  if (isPhoto(product.image)) return product.image;

  const medias = Array.isArray(product.media) ? product.media : [];
  const rang = medias.findIndex((m) => m.kind === 'photo');
  if (rang === -1) return null;
  return medias[rang].url ?? `/api/media/${product.id}/${rang}`;
}

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
  const note = noteDe(product);
  // Muette et sans contrôles : la carte entière reste un bouton qui ouvre la
  // fiche, et aucun son ne sort d'une grille de catalogue.
  const photo = video ? null : photoDeVitrine(product);
  const visuel = video
    ? `<video class="card__video" src="${escapeHtml(video.url)}" poster="${escapeHtml(video.poster)}"
             muted loop playsinline
             preload="metadata" disablepictureinpicture tabindex="-1" aria-hidden="true"></video>
       <span class="card__film" aria-hidden="true">▶</span>`
    : `<img src="${escapeHtml(photo ?? product.image)}" alt="" loading="lazy">`;

  card.innerHTML = `
    <div class="card__art${video ? ' card__art--video' : photo ? ' card__art--photo' : ''}">
      ${badge ? `<span class="card__badge ${soldOut ? 'card__badge--out' : ''}">${escapeHtml(badge)}</span>` : ''}
      ${visuel}
    </div>
    <div class="card__body">
      <span class="card__name">${escapeHtml(product.name)}</span>
      <span class="card__short">${escapeHtml(product.short)}</span>
      ${note ? `<span class="card__note">${etoiles(note.moyenne)} <small>${note.nombre}</small></span>` : ''}
      <span class="card__foot">
        <span class="card__price goldtext">${fromLabel}${formatPrice(product.price)}</span>
        <span class="card__add" aria-hidden="true">+</span>
      </span>
    </div>`;

  // Le cœur est posé sur l'illustration, pas dans le corps : il doit rester
  // atteignable au pouce sans ouvrir la fiche, et ne pas pousser le prix.
  if (state.features.favoris !== false && tg?.initData) {
    const coeur = document.createElement('button');
    coeur.type = 'button';
    coeur.className = 'card__coeur';
    coeur.textContent = '♥';
    peindreLeCoeur(coeur, product.id);
    coeur.addEventListener('click', async (ev) => {
      // Sans ça, mettre en favori ouvrirait la fiche par-dessus : la carte
      // entière est un bouton.
      ev.stopPropagation();
      await basculerFavori(product.id);
      peindreLeCoeur(coeur, product.id);
    });
    card.querySelector('.card__art').append(coeur);
  }

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
  renderPoints(product);

  $('pTags').replaceChildren(
    ...(product.tags ?? []).map((t) => {
      const span = document.createElement('span');
      span.className = 'tag';
      span.textContent = t;
      return span;
    })
  );

  const coeur = $('pCoeur');
  coeur.hidden = state.features.favoris === false || !tg?.initData;
  if (!coeur.hidden) peindreLeCoeur(coeur, product.id);

  renderVariants();
  setQty(1);
  // Chaque fiche repart repliée : « voir tous les avis » d'un produit n'a pas à
  // décider de l'affichage du suivant.
  state.avisTousVisibles = false;
  chargerLesAvis(product);
  renderSuggestions(product);

  // Les feuilles ouvertes se referment : arriver sur une fiche avec le panier
  // encore déployé par-dessus n'aurait aucun sens.
  closeSheets();
  montrerLOnglet('produit');
  $('pRetourTexte').textContent = libelleDuRetour();

  // La galerie se monte après l'affichage, et non avant : la fermeture des
  // feuilles détache les vidéos — elle vidait donc la galerie qu'on venait
  // tout juste de construire.
  renderGalerie(product);
  // Et elle s'ouvre sur la photo du format présélectionné, quand il en a une.
  // Le report d'un tour de boucle laisse la feuille prendre sa largeur : un
  // défilement calculé sur une piste encore à zéro n'irait nulle part.
  if (state.currentVariant) {
    requestAnimationFrame(() => montrerLeMediaDuFormat(state.currentVariant));
  }
  haptic('light');
}

/**
 * L'anneau qui tourne pendant qu'une vidéo se charge, et sa durée.
 *
 * Une vidéo de plusieurs mégaoctets sur un réseau de téléphone met le temps
 * qu'elle met. La vignette tient la place, mais elle ne dit rien : le client
 * appuie sur lecture, rien ne bouge, et il croit la vidéo cassée — alors
 * qu'elle arrive. L'anneau dit qu'elle arrive.
 *
 * Quatre événements suffisent à couvrir tous les cas, et ils sont tous posés
 * avant que la source ne soit lue à fond : `canplay` et `playing` pour
 * l'effacer, `waiting` pour le remettre quand la lecture se vide en cours de
 * route, `error` pour cesser de faire attendre devant une vidéo qui ne
 * viendra pas. Une vidéo déjà en cache ne déclenche parfois aucun des deux
 * premiers : on regarde donc aussi l'état au montage.
 *
 * La durée s'affiche dès que les métadonnées arrivent — quelques kilo-octets,
 * bien avant l'image. Savoir qu'on s'engage dans neuf secondes ou dans deux
 * minutes change la décision d'appuyer.
 */
function voileDeChargement(video) {
  const voile = document.createElement('span');
  voile.className = 'vcharge';
  voile.setAttribute('aria-hidden', 'true');

  const anneau = document.createElement('span');
  anneau.className = 'vcharge__arc';
  const duree = document.createElement('span');
  duree.className = 'vcharge__duree';
  duree.hidden = true;
  voile.append(anneau, duree);

  const montrer = () => voile.classList.remove('vcharge--fini');
  const cacher = () => voile.classList.add('vcharge--fini');

  video.addEventListener('canplay', cacher);
  video.addEventListener('playing', cacher);
  video.addEventListener('waiting', montrer);
  // Une vidéo injoignable ne doit pas laisser tourner l'anneau indéfiniment :
  // le client attendrait quelque chose qui n'arrive pas.
  video.addEventListener('error', cacher);
  // Tous les conteneurs ne portent pas leur durée : un WebM produit à la
  // volée annonce volontiers `Infinity`. Dans ce cas on ne montre rien —
  // « 0:00 » sur une vidéo d'une minute est pire que pas de durée du tout.
  video.addEventListener('loadedmetadata', () => {
    const lisible = enMinutes(video.duration);
    duree.hidden = lisible === null;
    if (lisible) duree.textContent = lisible;
  });

  // HAVE_CURRENT_DATA : la vidéo était déjà en mémoire, aucun événement ne
  // viendra. Sans cette ligne, l'anneau tournait pour toujours au deuxième
  // passage sur la même fiche.
  if (video.readyState >= 2) cacher();

  return voile;
}

/** « 1:07 », ou `null` quand le fichier ne dit pas combien il dure. */
function enMinutes(secondes) {
  if (!Number.isFinite(secondes) || secondes <= 0) return null;
  const entier = Math.round(secondes);
  return `${Math.floor(entier / 60)}:${String(entier % 60).padStart(2, '0')}`;
}

/**
 * Les deux carrousels du bas de fiche : « même catégorie » et « tu vas aimer ».
 *
 * Tous les deux sortent du catalogue déjà en mémoire. Une suggestion ne vaut
 * pas un aller-retour réseau : si elle arrive après que le client a fait
 * défiler jusqu'en bas, elle arrive trop tard, et si elle le fait attendre,
 * elle lui a coûté plus qu'elle ne lui rapporte.
 *
 * « Tu vas aimer » n'est pas un moteur de recommandation : c'est ce qui
 * partage une étiquette avec la fiche ouverte, puis, à défaut, les mieux
 * notés du reste. Le dire autrement serait mentir sur ce que la boutique
 * sait de ses clients — c'est-à-dire rien.
 */
const SUGGESTIONS_MAX = 10;

function renderSuggestions(produit) {
  const autres = state.products.filter((p) => p.id !== produit.id && !isSoldOut(p));

  const memeRayon = autres.filter((p) => p.category === produit.category).slice(0, SUGGESTIONS_MAX);
  const categorie = state.categories.find((c) => c.id === produit.category);
  $('pMemeCategorieTitre').textContent = categorie
    ? `Même catégorie · ${categorie.label}`
    : 'Même catégorie';
  remplirLaPiste('pMemeCategorie', 'pMemeCategoriePiste', memeRayon);

  const etiquettes = new Set((produit.tags ?? []).map((t) => String(t).toLowerCase()));
  const parEtiquette = autres.filter(
    (p) => p.category !== produit.category &&
      (p.tags ?? []).some((t) => etiquettes.has(String(t).toLowerCase()))
  );
  const complement = autres
    .filter((p) => p.category !== produit.category && !parEtiquette.includes(p))
    .sort((a, b) => (state.notes[b.id]?.moyenne ?? 0) - (state.notes[a.id]?.moyenne ?? 0));
  remplirLaPiste('pAimerAussi', 'pAimerAussiPiste', [...parEtiquette, ...complement].slice(0, SUGGESTIONS_MAX));
}

/** Une piste, ou rien du tout : un carrousel vide est un titre qui ment. */
function remplirLaPiste(sectionId, pisteId, produits) {
  $(sectionId).hidden = produits.length === 0;
  if (!produits.length) return $(pisteId).replaceChildren();
  $(pisteId).replaceChildren(...produits.map(carteSuggeree));
}

/**
 * La vignette d'une suggestion : plus petite qu'une carte de la grille.
 *
 * Elle ne reprend pas `productCard` : une carte de grille porte un cœur, une
 * pastille, une accroche sur deux lignes et un bouton « + ». Posée dans un
 * carrousel de 120 px, elle devient illisible, et le « + » se touche par
 * accident quand on fait glisser la piste.
 */
function carteSuggeree(produit) {
  const carte = document.createElement('button');
  carte.type = 'button';
  carte.className = 'suggestion';
  carte.setAttribute('aria-label', `${produit.name}, ${formatPrice(produit.price)}`);

  const vignette = document.createElement('span');
  vignette.className = 'suggestion__art';
  const image = document.createElement('img');
  // Photo importée d'abord, dessin ensuite : une piste de suggestions faite
  // de dessins par défaut ne donne envie d'ouvrir aucune des fiches.
  image.src = photoDeVitrine(produit) ?? produit.image ?? '';
  image.alt = '';
  image.loading = 'lazy';
  vignette.append(image);

  const nom = document.createElement('span');
  nom.className = 'suggestion__nom';
  nom.textContent = produit.name;

  const prix = document.createElement('span');
  prix.className = 'suggestion__prix';
  prix.textContent = formatPrice(produit.price);

  carte.append(vignette, nom, prix);
  carte.addEventListener('click', () => {
    openProduct(produit);
    window.scrollTo({ top: 0, behavior: 'auto' });
  });
  return carte;
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
    const photo = photoDeVitrine(product);
    $('pImage').src = photo ?? product.image;
    $('pImage').alt = product.name;
    art.classList.toggle('pdetail__art--photo', Boolean(photo));
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

      case_.append(voileDeChargement(video));
    } else {
      const img = document.createElement('img');
      img.src = media.url ?? `/api/media/${product.id}/${rang}`;
      img.alt = media.legende || `${product.name} — visuel ${rang + 1}`;
      img.loading = rang === 0 ? 'eager' : 'lazy';
      case_.append(img);
    }

    // Le nom du format, sur le média qui lui est rattaché : le client qui fait
    // défiler la galerie sait ce qu'il regarde sans avoir à comparer avec les
    // boutons de format, et celui qui a choisi son format se reconnaît.
    const format = (product.variants ?? []).find((v) => v.id === media.variantId);
    if (format) {
      const etiquette = document.createElement('span');
      etiquette.className = 'galerie__format';
      etiquette.textContent = format.label;
      case_.append(etiquette);
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

/**
 * Amène la galerie sur la photo du format choisi.
 *
 * Silencieux quand ce format n'a pas de photo à lui : déplacer la galerie vers
 * un média au hasard serait pire que ne rien faire, et beaucoup de produits
 * n'auront jamais qu'une photo pour tous leurs formats.
 */
function montrerLeMediaDuFormat(variantId) {
  const medias = state.current?.media ?? [];
  const rang = medias.findIndex((m) => m.variantId === variantId);
  if (rang < 0) return;

  const piste = $('pGalleryTrack');
  if (!piste || piste.clientWidth === 0) return;
  // Une vidéo qui jouait pendant qu'on change de format continuerait à parler
  // par-dessus la photo qu'on vient d'amener.
  arreterLesVideos();
  piste.scrollTo({ left: rang * piste.clientWidth, behavior: anime() ? 'smooth' : 'auto' });
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

/**
 * Les caractéristiques, en puces.
 *
 * Elles ne remplacent pas la description : celle-ci raconte, celles-là se
 * lisent en diagonale. Un client qui compare deux variétés parcourt six
 * points ; il ne lit pas deux paragraphes l'un après l'autre.
 *
 * Rien à afficher, rien d'affiché : une liste vide sous le titre laisserait
 * un blanc qu'on prendrait pour un écran mal chargé.
 */
function renderPoints(product) {
  const liste = $('pPoints');
  const points = Array.isArray(product.points) ? product.points.filter(Boolean) : [];
  liste.hidden = points.length === 0;
  liste.replaceChildren(
    ...points.map((texte) => {
      const item = document.createElement('li');
      item.textContent = texte;
      return item;
    })
  );
}

function renderVariants() {
  const box = $('pVariants');
  const product = state.current;
  if (!product?.variants) {
    box.replaceChildren();
    $('pVariantsTitre').hidden = true;
    return;
  }
  $('pVariantsTitre').hidden = false;
  box.replaceChildren(
    ...product.variants.map((v) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'variant';
      btn.setAttribute('aria-pressed', String(v.id === state.currentVariant));
      btn.disabled = Number(v.stock ?? 0) <= 0;

      // Deux lignes montées en éléments plutôt qu'en HTML recollé : le libellé
      // vient du vendeur, et une chaîne concaténée redevient du balisage à la
      // première apostrophe mal placée.
      const poids = document.createElement('span');
      poids.className = 'variant__poids';
      poids.textContent = v.label;
      const prix = document.createElement('span');
      prix.className = 'variant__prix';
      prix.textContent = btn.disabled ? 'épuisé' : formatPrice(v.price);
      btn.append(poids, prix);

      btn.addEventListener('click', () => {
        state.currentVariant = v.id;
        renderVariants();
        setQty(state.currentQty);
        // La galerie suit le format choisi : c'est tout l'intérêt de rattacher
        // une photo à une variété. Sans ce saut, le client choisit « Bubble
        // Gum » et continue de regarder la photo de la Banana Kush.
        montrerLeMediaDuFormat(v.id);
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
  montrerLOnglet(state.retour);
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
  badge.textContent = `${count} article${count > 1 ? 's' : ''}`;
  badge.hidden = count === 0;

  // Le montant sur la pastille : c'est la question qu'on se pose devant un
  // panier, pas le nombre de lignes. Panier vide, il n'y a rien à dire.
  const pastille = $('cartTotalPill');
  pastille.hidden = count === 0;
  pastille.textContent = count === 0 ? '' : formatPrice(cartTotal());
  // Le profil affiche le même nombre : sans ça, il restait sur la valeur
  // qu'il avait à l'ouverture pendant qu'on remplissait le panier derrière.
  if (state.onglet === 'profil') renderChiffres();

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
    <span class="cart-item__art${photoDeVitrine(line.product) ? ' cart-item__art--photo' : ''}"><img src="${escapeHtml(photoDeVitrine(line.product) ?? line.product.image)}" alt=""></span>
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
    // Et une commande plus ancienne a pu devenir notable entre-temps.
    chargerLesAvisADonner();
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
    // Les notes bougent aussi : un avis déposé à l'instant doit se voir sur la
    // grille sans qu'on ait à rouvrir la boutique.
    state.notes = data.notes ?? {};
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

/**
 * Montre ou cache la flèche de Telegram selon ce qui est ouvert.
 *
 * Deux choses la méritent maintenant — une feuille, et la fiche produit — et
 * elles s'ouvrent et se ferment par des chemins différents. Chacune la
 * réglant de son côté, elle restait affichée sur le catalogue après qu'on
 * avait refermé une feuille depuis une fiche : un bouton retour qui ne
 * revient nulle part.
 */
function syncBackButton() {
  const feuille = [...document.querySelectorAll('.sheet')].some((f) => !f.hidden);
  const fiche = state.onglet === 'produit';
  if (feuille || fiche) tg?.BackButton?.show();
  else tg?.BackButton?.hide();
}

/** « Retour au catalogue », « Retour aux catégories »… — dire où l'on retombe. */
function libelleDuRetour() {
  return {
    filtres: 'Retour au catalogue',
    categories: 'Retour aux catégories',
    contact: 'Retour',
    profil: 'Retour au profil',
  }[state.retour] ?? 'Retour';
}

/** La flèche de Telegram, et celle de la fiche, font la même chose. */
function revenirEnArriere() {
  const feuille = [...document.querySelectorAll('.sheet')].some((f) => !f.hidden);
  if (feuille) return closeSheets();
  if (state.onglet === 'produit') return montrerLOnglet(state.retour);
}

function openSheet(id) {
  closeSheets();
  $(id).hidden = false;
  document.body.style.overflow = 'hidden';
  syncBackButton();
  syncMainButton();
  // Les places partent pendant qu'on remplit son panier : on rafraîchit à
  // l'ouverture plutôt que de servir la liste chargée au démarrage.
  if (id === 'cartSheet') loadSlots();
}

function closeSheets() {
  // Une vidéo laissée en lecture continuerait de parler par-dessus le
  // catalogue, sans que le client sache d'où vient le son.
  // Les vidéos ne sont plus ici : la galerie vit dans la page de la fiche,
  // et c'est en la quittant qu'on les arrête. Fermer le panier par-dessus une
  // fiche ne doit pas couper la vidéo qu'on regardait derrière.
  for (const sheet of document.querySelectorAll('.sheet')) sheet.hidden = true;
  document.body.style.overflow = '';
  syncBackButton();
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

/* ── Avis ────────────────────────────────────────────────── */

/**
 * Cinq étoiles, pleines jusqu'à la note.
 *
 * La demi-étoile est volontairement absente : une moyenne de 4,3 s'écrit à
 * côté en chiffres, et un demi-glyphe rend la ligne illisible sur la carte d'un
 * catalogue à deux colonnes.
 */
function etoiles(note) {
  const pleines = Math.round(Number(note) || 0);
  return '★'.repeat(pleines) + '☆'.repeat(Math.max(0, 5 - pleines));
}

/** La note d'un produit, telle que le catalogue l'a envoyée. */
function noteDe(product) {
  return state.notes?.[product?.id] ?? null;
}

/**
 * La suggestion d'avis, en haut du catalogue.
 *
 * Elle ne s'adresse qu'à qui a reçu quelque chose sans rien en dire. Un client
 * qui n'a rien à noter ne doit jamais la voir — une boutique qui réclame un
 * avis à quelqu'un qui n'a rien acheté se fait fermer l'application.
 */
async function chargerLesAvisADonner() {
  const banniere = $('suggestionAvis');
  banniere.hidden = true;
  state.avisADonner = [];
  if (!tg?.initData || state.features.avis === false) return;

  // Son prénom vient de Telegram : l'écran d'avis lui montre ainsi ce qu'il
  // signerait exactement, plutôt qu'un « avec mon prénom » abstrait.
  state.prenom = tg.initDataUnsafe?.user?.first_name ?? '';

  try {
    const res = await fetch('/api/avis', { headers: { 'X-Telegram-Init-Data': tg.initData } });
    if (!res.ok) return;
    state.avisADonner = (await res.json()).aDonner ?? [];
    renderSuggestionAvis();
  } catch {
    /* pas de suggestion : la boutique marche très bien sans */
  }
}

function renderSuggestionAvis() {
  const banniere = $('suggestionAvis');
  const [commande] = state.avisADonner;
  if (!commande) return void (banniere.hidden = true);

  const noms = commande.produits.map((p) => p.nom);
  const detail = noms.length > 2
    ? `${noms.slice(0, 2).join(', ')} et ${noms.length - 2} autre${noms.length > 3 ? 's' : ''}`
    : noms.join(', ');

  // Noter et ajouter un mot ne sont pas le même geste : demander « ton avis »
  // à quelqu'un qui vient de mettre cinq étoiles donne l'impression de n'avoir
  // rien vu.
  banniere.querySelector('b').textContent = commande.deja ? 'Ajoute un mot' : "Comment c'était ?";
  $('suggestionAvisDetail').textContent = commande.deja
    ? `Tu as noté ${detail}`
    : `Ton avis sur ${detail}`;
  banniere.hidden = false;
}

/**
 * Ouvre l'écran d'avis sur une commande.
 *
 * Une étoile par produit, et un seul champ de texte : le client a reçu une
 * commande, pas trois formulaires. Un produit qu'il ne veut pas noter, il le
 * laisse à zéro et on ne l'envoie pas.
 */
function ouvrirLAvis(commande) {
  if (!commande) return;

  // Ce qu'il avait déjà mis — une étoile touchée dans la conversation du bot,
  // par exemple. Rouvrir sur cinq étoiles vides lui ferait croire que son geste
  // s'est perdu, et il repartirait sans ajouter le mot qu'on lui demande.
  const deja = commande.deja ?? null;
  state.avisEnCours = {
    reference: commande.reference,
    notes: { ...(deja?.notes ?? {}) },
    anonyme: Boolean(deja?.anonyme),
  };

  const noms = commande.produits.map((p) => p.nom).join(', ');
  $('avisIntro').textContent = deja
    ? `Tu as déjà noté ${noms}. Ajoute un mot, si tu veux.`
    : `Commande ${commande.reference} — ${noms}`;
  $('avisTexte').value = '';

  $('avisProduits').replaceChildren(
    ...commande.produits.map((produit) => ligneDeNotation(produit, state.avisEnCours.notes[produit.id] ?? 0))
  );

  $('avisSigneNom').textContent = state.prenom ? `Avec « ${state.prenom} »` : 'Avec mon prénom';
  renderSignature();

  $('avisEnvoyer').disabled = false;
  $('avisEnvoyer').textContent = 'Envoyer';
  openSheet('avisSheet');
  haptic('light');
}

/**
 * Signé ou anonyme, à chaque avis.
 *
 * Le choix se repose à chaque fois plutôt que de se retenir une fois pour
 * toutes : on ne dit pas la même chose sous son prénom selon ce qu'on achète,
 * et un réglage oublié dans un menu publierait un nom que personne n'a voulu.
 */
function renderSignature() {
  for (const choix of $('avisSignature').querySelectorAll('.signature__choix')) {
    const anonyme = choix.dataset.anonyme === 'oui';
    choix.setAttribute('aria-pressed', String(anonyme === state.avisEnCours.anonyme));
  }
}

/** Un produit, cinq boutons. Toucher une étoile note jusqu'à elle. */
function ligneDeNotation(produit, depart = 0) {
  const ligne = document.createElement('div');
  ligne.className = 'notation';
  ligne.innerHTML =
    `<span class="notation__nom">${escapeHtml(produit.nom)}` +
    `${produit.variante ? ` <small>${escapeHtml(produit.variante)}</small>` : ''}</span>` +
    '<div class="notation__etoiles" role="group"></div>';

  const boite = ligne.querySelector('.notation__etoiles');
  const boutons = [];

  const peindre = (jusqua) => {
    boutons.forEach((b, rang) => b.classList.toggle('est-pleine', rang < jusqua));
  };
  // Peint après la boucle : les boutons n'existent pas encore ici.
  queueMicrotask(() => peindre(depart));

  for (let note = 1; note <= 5; note += 1) {
    const bouton = document.createElement('button');
    bouton.type = 'button';
    bouton.className = 'notation__etoile';
    bouton.textContent = '★';
    bouton.setAttribute('aria-label', `${note} étoile${note > 1 ? 's' : ''}`);
    bouton.addEventListener('click', () => {
      state.avisEnCours.notes[produit.id] = note;
      peindre(note);
      haptic('light');
    });
    boutons.push(bouton);
    boite.append(bouton);
  }

  return ligne;
}

async function envoyerLAvis() {
  const bouton = $('avisEnvoyer');
  const encours = state.avisEnCours;
  if (!encours) return;

  const notes = encours.notes;
  if (!Object.keys(notes).length) {
    toast('Touche au moins une étoile.');
    haptic('warning');
    return;
  }

  bouton.disabled = true;
  bouton.textContent = 'Envoi…';
  try {
    const res = await fetch('/api/avis', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': tg?.initData ?? '',
      },
      body: JSON.stringify({
        reference: encours.reference,
        notes,
        texte: $('avisTexte').value,
        anonyme: encours.anonyme,
      }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Avis refusé.');

    closeSheets();
    toast('Merci pour ton avis !');
    haptic('success');
    // La commande notée sort de la file : la bannière propose la suivante, ou
    // disparaît. Et le catalogue reprend les moyennes, que cet avis vient de
    // faire bouger.
    state.avisADonner = state.avisADonner.filter((c) => c.reference !== encours.reference);
    state.avisEnCours = null;
    renderSuggestionAvis();
    refreshCatalog();
  } catch (err) {
    toast(err.message);
    haptic('error');
  }
  bouton.disabled = false;
  bouton.textContent = 'Envoyer';
}

/**
 * Les avis d'un produit, dans sa fiche.
 *
 * Chargés à l'ouverture de la fiche et pas avec le catalogue : la moyenne tient
 * dans un nombre et voyage avec la grille, les commentaires sont du texte qu'on
 * ne télécharge que pour le produit qu'on regarde.
 */
async function chargerLesAvis(product) {
  const section = $('pAvis');
  const lien = $('pNote');
  const resume = noteDe(product);

  // La note est déjà connue : on l'affiche sans attendre le réseau.
  if (resume) {
    lien.innerHTML =
      `<span class="note__etoiles">${etoiles(resume.moyenne)}</span>` +
      `<span class="note__chiffre">${resume.moyenne.toFixed(1).replace('.', ',')}</span>` +
      `<span class="note__nombre">${resume.nombre} avis</span>`;
    lien.hidden = false;
  } else {
    lien.hidden = true;
  }

  section.hidden = true;
  if (state.features.avis === false) return;

  try {
    const res = await fetch(`/api/avis/${encodeURIComponent(product.id)}`);
    if (!res.ok) return;
    const data = await res.json();
    // La fiche a pu changer pendant l'aller-retour : on n'écrit pas les avis
    // d'un produit dans la fiche d'un autre.
    if (state.current?.id !== product.id) return;
    renderAvis(data);
  } catch {
    /* les avis ne sont pas la boutique : leur absence ne bloque rien */
  }
}

function renderAvis({ avis, resume }) {
  const section = $('pAvis');
  if (!avis?.length) return void (section.hidden = true);

  $('pAvisTitre').textContent = `Avis (${resume?.nombre ?? avis.length})`;
  $('pAvisBarres').replaceChildren(resume ? barresDeNotes(resume) : document.createComment(''));

  // Trois avis visibles, le reste sur demande : une fiche produit n'est pas un
  // forum, et le bouton « Ajouter » doit rester à portée de pouce.
  const visibles = state.avisTousVisibles ? avis : avis.slice(0, 3);
  $('pAvisListe').replaceChildren(...visibles.map(carteDAvis));

  const plus = $('pAvisPlus');
  plus.hidden = state.avisTousVisibles || avis.length <= 3;
  plus.textContent = `Voir les ${avis.length} avis`;
  plus.onclick = () => {
    state.avisTousVisibles = true;
    renderAvis({ avis, resume });
  };

  section.hidden = false;
}

/**
 * La répartition des notes, en barres.
 *
 * Elle dit ce que la moyenne cache : 4,0 obtenu avec dix « 4 » et 4,0 obtenu
 * avec cinq « 5 » et cinq « 3 » ne racontent pas la même boutique.
 */
function barresDeNotes(resume) {
  const bloc = document.createElement('div');
  const maximum = Math.max(...resume.repartition, 1);

  bloc.innerHTML = [5, 4, 3, 2, 1]
    .map((note) => {
      const combien = resume.repartition[note - 1];
      const part = Math.round((combien / maximum) * 100);
      return (
        '<div class="avis__barre">' +
        `<span class="avis__barre-note">${note}★</span>` +
        `<span class="avis__barre-piste"><span class="avis__barre-plein" style="width:${part}%"></span></span>` +
        `<span class="avis__barre-nombre">${combien}</span>` +
        '</div>'
      );
    })
    .join('');

  return bloc;
}

function carteDAvis(avis) {
  const li = document.createElement('li');
  li.className = 'avis__item';
  li.innerHTML =
    '<div class="avis__tete">' +
    `<span class="avis__etoiles">${etoiles(avis.note)}</span>` +
    `<span class="avis__qui">${escapeHtml(avis.prenom ?? 'Client')}</span>` +
    `<span class="avis__quand">${escapeHtml(dateCourte(avis.createdAt))}</span>` +
    '</div>' +
    (avis.texte ? `<p class="avis__texte">${escapeHtml(avis.texte)}</p>` : '') +
    (avis.reponse
      ? '<div class="avis__reponse">' +
        `<b>Réponse de la boutique</b><p>${escapeHtml(avis.reponse.texte)}</p></div>`
      : '');
  return li;
}

function dateCourte(iso) {
  const quand = new Date(iso);
  if (!Number.isFinite(quand.getTime())) return '';
  return quand.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

/* ── Profil ──────────────────────────────────────────────── */

/**
 * Ouvre le profil, et charge tout d'un coup.
 *
 * Commandes, favoris et alertes arrivent dans la même réponse : trois
 * allers-retours pour ouvrir un écran, c'est trois occasions de l'afficher à
 * moitié rempli sur un réseau de téléphone.
 */
async function ouvrirProfil() {
  // La vue est déjà à l'écran quand on arrive par la barre du bas ; l'appel
  // reste pour les autres chemins — le cœur d'un favori qu'on retire, par
  // exemple, qui recharge la liste en repassant par ici.
  if (state.onglet !== 'profil') return montrerLOnglet('profil');
  montrerLaVue(state.profilVue);

  $('profilNom').textContent = state.prenom ? state.prenom : 'Mon profil';
  $('profilVignette').textContent = (state.prenom || '?').trim().charAt(0).toUpperCase();
  $('profilQui').textContent = state.prenom ? 'Client Napoli Coffee' : '';
  renderChiffres();
  $('ordersEmpty').hidden = false;
  $('ordersEmpty').textContent = 'Chargement…';

  if (!tg?.initData) {
    $('ordersEmpty').textContent = 'Ouvre la boutique depuis Telegram pour retrouver tes commandes.';
    return;
  }

  try {
    const res = await fetch('/api/profil', { headers: { 'X-Telegram-Init-Data': tg.initData } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const profil = await res.json();

    state.favoris = new Set(profil.favoris.map((p) => p.id));
    state.preferences = profil.preferences;

    renderCommandes(profil.commandes);
    renderFavoris(profil.favoris);
    renderAlertes(profil);
    renderPastilleProfil();
    renderChiffres(profil.commandes?.length);
    // La grille porte les mêmes cœurs : les repeindre ici évite qu'un favori
    // retiré depuis le profil reste allumé derrière la feuille.
    renderGrid();
  } catch (err) {
    console.error(err);
    $('ordersEmpty').textContent = 'Profil indisponible pour le moment.';
  }
}

/** Une vue à la fois : les trois d'un bloc feraient défiler trois écrans. */
function montrerLaVue(vue) {
  state.profilVue = vue;
  for (const onglet of $('profilOnglets').querySelectorAll('.profil__onglet')) {
    onglet.setAttribute('aria-selected', String(onglet.dataset.vue === vue));
  }
  for (const section of document.querySelectorAll('.profil__vue')) {
    section.hidden = section.dataset.vue !== vue;
  }
}

function renderCommandes(commandes) {
  const liste = $('ordersList');
  const vide = $('ordersEmpty');
  liste.replaceChildren();

  if (state.features.orderHistory === false) {
    vide.hidden = false;
    vide.textContent = "L'historique des commandes n'est pas activé sur cette boutique.";
    return;
  }
  if (!commandes.length) {
    vide.hidden = false;
    vide.textContent = "Tu n'as pas encore passé de commande.";
    return;
  }
  vide.hidden = true;
  liste.replaceChildren(...commandes.map(orderCard));
}

/**
 * Les favoris, en cartes qu'on peut rouvrir.
 *
 * Une carte mène à la fiche produit, pas au panier : un favori est une envie,
 * pas une commande. Le raccourci « ajouter » ferait acheter un format et une
 * quantité que personne n'a choisis.
 */
function renderFavoris(favoris) {
  const liste = $('favorisList');
  const vide = $('favorisEmpty');
  const compte = $('favorisCompte');

  compte.hidden = !favoris.length;
  compte.textContent = String(favoris.length);

  if (state.features.favoris === false) {
    liste.replaceChildren();
    vide.hidden = false;
    vide.textContent = "Les favoris ne sont pas activés sur cette boutique.";
    return;
  }
  if (!favoris.length) {
    liste.replaceChildren();
    vide.hidden = false;
    vide.textContent = 'Touche le ♥ sur un produit pour le garder ici.';
    return;
  }

  vide.hidden = true;
  liste.replaceChildren(
    ...favoris.map((produit) => {
      const carte = document.createElement('article');
      carte.className = 'favori';
      const epuise = isSoldOut(produit);

      carte.innerHTML =
        `<img class="favori__image" src="${escapeHtml(photoDeVitrine(produit) ?? produit.image)}" alt="" loading="lazy">` +
        '<div class="favori__corps">' +
        `<span class="favori__nom">${escapeHtml(produit.name)}</span>` +
        `<span class="favori__prix goldtext">${produit.variants ? '<small>dès</small> ' : ''}${formatPrice(produit.price)}</span>` +
        (epuise ? '<span class="favori__etat">Épuisé — active l\'alerte de retour</span>' : '') +
        '</div>' +
        '<button class="favori__coeur" type="button" aria-label="Retirer des favoris">♥</button>';

      carte.querySelector('.favori__image').addEventListener('click', () => openProduct(produit));
      carte.querySelector('.favori__corps').addEventListener('click', () => openProduct(produit));
      carte.querySelector('.favori__coeur').addEventListener('click', async (ev) => {
        ev.stopPropagation();
        await basculerFavori(produit.id);
        // On recharge la liste plutôt que de retirer la carte à la main : le
        // compteur, le vide et la grille doivent bouger ensemble.
        ouvrirProfil();
      });
      return carte;
    })
  );
}

/**
 * Les interrupteurs d'alertes.
 *
 * Construits depuis ce que le serveur déclare, pas depuis une liste recopiée
 * ici : ajouter un canal côté serveur doit suffire à le voir apparaître.
 */
function renderAlertes({ canaux, preferences, desabonne }) {
  $('profilStop').hidden = !desabonne;

  $('alertesList').replaceChildren(
    ...canaux.map((canal) => {
      const ligne = document.createElement('button');
      ligne.type = 'button';
      ligne.className = 'alerte';
      ligne.setAttribute('role', 'switch');
      ligne.setAttribute('aria-checked', String(preferences[canal.clef] !== false));
      ligne.innerHTML =
        '<span class="alerte__texte">' +
        `<b>${escapeHtml(canal.label)}</b>` +
        `<small>${escapeHtml(canal.hint)}</small>` +
        '</span>' +
        '<span class="alerte__bouton" aria-hidden="true"></span>';

      ligne.addEventListener('click', () => basculerAlerte(canal.clef, ligne));
      return ligne;
    })
  );
}

async function basculerAlerte(clef, ligne) {
  const avant = ligne.getAttribute('aria-checked') === 'true';
  // On bascule tout de suite : un interrupteur qui attend le réseau avant de
  // bouger donne l'impression de ne pas avoir été touché, et on appuie deux fois.
  ligne.setAttribute('aria-checked', String(!avant));
  haptic('light');

  try {
    const res = await fetch('/api/profil/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': tg?.initData ?? '' },
      body: JSON.stringify({ [clef]: !avant }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.preferences = await res.json();
    ligne.setAttribute('aria-checked', String(state.preferences[clef] !== false));
  } catch {
    // Le serveur n'a pas suivi : on remet l'interrupteur où il était, sinon
    // l'écran promet un réglage qui n'existe pas.
    ligne.setAttribute('aria-checked', String(avant));
    toast('Réglage non enregistré, réessaie.');
    haptic('error');
  }
}

/* ── Favoris ─────────────────────────────────────────────── */

/** Charge les identifiants seuls : de quoi peindre les cœurs de la grille. */
async function chargerLesFavoris() {
  state.favoris = new Set();
  if (!tg?.initData || state.features.favoris === false) return;
  try {
    const res = await fetch('/api/favoris', { headers: { 'X-Telegram-Init-Data': tg.initData } });
    if (!res.ok) return;
    const data = await res.json();
    state.favoris = new Set(data.favoris);
    renderPastilleProfil();
    renderGrid();
  } catch {
    /* pas de favoris : la boutique marche très bien sans */
  }
}

const estFavori = (id) => state.favoris?.has(id) ?? false;

/**
 * Met ou retire un favori, et rend le nouvel état.
 *
 * L'écran est peint avant la réponse du serveur — un cœur qui attend le réseau
 * paraît cassé — mais il est remis en place si le serveur refuse.
 */
async function basculerFavori(productId) {
  const avant = estFavori(productId);
  if (avant) state.favoris.delete(productId);
  else state.favoris.add(productId);
  renderPastilleProfil();
  haptic('light');

  try {
    const res = await fetch('/api/favoris', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': tg?.initData ?? '' },
      body: JSON.stringify({ id: productId }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);

    const { favori } = await res.json();
    if (favori) state.favoris.add(productId);
    else state.favoris.delete(productId);
  } catch (err) {
    if (avant) state.favoris.add(productId);
    else state.favoris.delete(productId);
    toast(err.message);
    haptic('error');
  }

  renderPastilleProfil();
  return estFavori(productId);
}

/**
 * Les quatre compteurs en haut du profil.
 *
 * Aucun n'est un chiffre qu'il faudrait aller chercher : le panier et les
 * favoris sont déjà en mémoire, le catalogue aussi, et le nombre de commandes
 * arrive avec le profil. Un compteur qui coûterait un appel réseau de plus
 * n'aurait pas sa place ici — on ouvre cet écran pour ses commandes, pas pour
 * son nombre de commandes.
 *
 * @param {number} [commandes] le compte venu du serveur ; sinon on garde
 *   celui qu'on affichait déjà, plutôt que de repasser à zéro le temps du
 *   chargement.
 */
let commandesConnues = null;
function renderChiffres(commandes) {
  if (Number.isFinite(commandes)) commandesConnues = commandes;

  const lignes = [
    ['panier', state.cart.reduce((somme, l) => somme + l.quantity, 0), 'Panier'],
    ['commandes', commandesConnues ?? '—', 'Commandes'],
    ['favoris', state.favoris?.size ?? 0, 'Favoris'],
    ['produits', state.products.length, 'Produits'],
  ];

  $('profilChiffres').replaceChildren(
    ...lignes.map(([clef, valeur, label]) => {
      const colonne = document.createElement('div');
      // « plein » teinte le nombre : un panier vide et un panier à trois
      // articles ne doivent pas se ressembler dans un bandeau de quatre
      // chiffres qu'on parcourt d'un regard.
      const plein = Number(valeur) > 0;
      colonne.className = `chiffre chiffre--${clef}${plein ? ' chiffre--plein' : ''}`;
      const nombre = document.createElement('b');
      nombre.className = 'chiffre__valeur';
      nombre.textContent = String(valeur);
      const nom = document.createElement('span');
      nom.className = 'chiffre__label';
      nom.textContent = label;
      colonne.append(nombre, nom);
      return colonne;
    })
  );
}

/**
 * La ligne sous l'enseigne : ouvert ou fermé, et la taille du catalogue.
 *
 * Deux informations qu'on cherche en arrivant, et qui occupaient jusqu'ici
 * un bandeau à part poussant le catalogue vers le bas. Sous le nom, elles ne
 * coûtent pas une ligne d'écran — et elles suivent l'en-tête, qui reste
 * collé en haut pendant qu'on fait défiler.
 */
function renderSousTitre() {
  const ligne = $('shopSous');
  if (!ligne) return;
  const ouvert = state.opening?.open !== false;
  const etat = document.createElement('b');
  etat.textContent = ouvert ? 'Ouvert' : 'Fermé';
  etat.classList.toggle('est-ferme', !ouvert);
  const combien = state.products.length;
  ligne.replaceChildren(
    etat,
    document.createTextNode(combien ? ` · ${combien} produit${combien > 1 ? 's' : ''}` : '')
  );
}

/** Le compteur sur l'icône du profil : il dit qu'il y a quelque chose à y voir. */
function renderPastilleProfil() {
  const pastille = $('profilPastille');
  const combien = state.favoris?.size ?? 0;
  pastille.hidden = combien === 0;
  pastille.textContent = String(combien);
}

/** Le cœur d'une fiche produit, avec son état. */
function peindreLeCoeur(bouton, id) {
  const actif = estFavori(id);
  bouton.classList.toggle('est-favori', actif);
  bouton.setAttribute('aria-pressed', String(actif));
  bouton.setAttribute('aria-label', actif ? 'Retirer des favoris' : 'Mettre en favori');
}

/* ── Présence ────────────────────────────────────────────── */

/**
 * Dit au serveur qu'on est toujours là.
 *
 * Sans ce battement, quelqu'un qui lit une fiche produit pendant cinq minutes
 * disparaîtrait de la liste des présents : le serveur ne compte que les appels,
 * et lire n'en fait aucun.
 *
 * Deux précautions qui comptent sur un téléphone :
 *
 * - **rien ne bat quand la page n'est pas visible.** Une boutique laissée
 *   ouverte dans un onglet de fond ne doit ni consommer de données ni faire
 *   croire au vendeur qu'un client la regarde ;
 * - **le premier geste au retour**, pour que revenir sur la boutique se voie
 *   tout de suite et pas à la minute suivante.
 */
function battreLePouls() {
  if (!tg?.initData) return;

  const battre = () => {
    if (document.visibilityState !== 'visible') return;
    fetch('/api/presence', {
      method: 'POST',
      headers: { 'X-Telegram-Init-Data': tg.initData },
      // La réponse ne nous intéresse pas, et une coupure de réseau n'a aucune
      // raison de remonter : ce n'est qu'un signe de vie.
      keepalive: true,
    }).catch(() => {});
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') battre();
  });
  setInterval(battre, 60000);
}
