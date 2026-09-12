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
  bilan: null,       // le regroupement des commandes sur la période choisie
  clients: [],       // fiches reconstituées à partir des commandes
  clientsTotal: 0,
  clientOuvert: null,
  users: [],         // registre : tous ceux qui ont ouvert le bot
  usersTotal: 0,
  usersAcheteurs: 0,
  usersCharge: false, // chargé à la première ouverture de l'onglet, pas avant
  periode: 30,       // en jours ; commande tout le tableau de bord
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
    state.mediaMax = session.mediaMax ?? 8;
    $('adminName').textContent = session.user.first_name ?? 'Admin';
    $('gate').hidden = true;
  } catch (err) {
    denyAccess(err.message);
    return;
  }

  // Sans ce rattrapage, une panne de stockage laissait l'espace admin sur un
  // écran à moitié peint, sans un mot : le seul endroit où l'explication
  // aurait servi était justement celui qui ne l'affichait pas.
  try {
    await refreshAll();
  } catch (err) {
    denyAccess(err.message);
  }
}

function denyAccess(message) {
  const gate = $('gate');
  // Le rideau est déjà levé quand la session a été acceptée : une panne
  // survenue après — le stockage, par exemple — écrivait alors son message
  // dans un élément masqué, et l'écran restait à moitié peint sans un mot.
  gate.hidden = false;
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
  // L'aperçu suit aussi une adresse tapée à la main : c'est ce qui révèle
  // tout de suite une adresse qui ne charge pas.
  $('fImagePath').addEventListener('input', syncImageField);
  $('clientSearch').addEventListener('input', chercherDesClients);
  $('userSearch').addEventListener('input', chercherDesUtilisateurs);
  $('fPurgeMode').addEventListener('change', syncPurgeMode);
  $('doPurge').addEventListener('click', purgerLesCommandes);
  $('addMedia').addEventListener('click', ajouterMedia);
  $('pickMedia').addEventListener('click', () => $('mediaFile').click());
  $('mediaFile').addEventListener('change', envoyerDepuisLaGalerie);
  $('pickImage').addEventListener('click', () => $('imageFile').click());
  $('imageFile').addEventListener('change', envoyerLaVignette);
  $('addVariant').addEventListener('click', () => addVariantRow());
  $('saveProduct').addEventListener('click', saveProduct);
  $('deleteProduct').addEventListener('click', removeProduct);

  for (const el of document.querySelectorAll('[data-close]')) {
    el.addEventListener('click', closeEditor);
  }
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeEditor());
}

async function refreshAll() {
  const [catalog, orders, stats, settings, verifications, promos, bilan] = await Promise.all([
    api('/catalog'),
    api('/orders'),
    api('/stats'),
    api('/settings'),
    api('/verifications'),
    api('/promos'),
    api(`/bilan?jours=${state.periode}`),
  ]);
  const fiches = await api('/clients').catch(() => ({ total: 0, clients: [] }));
  state.settings = settings;
  state.verifications = verifications;
  state.promos = promos;
  state.annonces = await api('/announcements').catch(() => []);
  state.products = catalog.products;
  state.categories = catalog.categories.filter((c) => c.id !== 'all');
  state.orders = orders;
  state.stats = stats;
  state.bilan = bilan;
  state.clients = fiches.clients;
  state.clientsTotal = fiches.total;

  renderBoard();
  renderClients();
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
  // Le registre peut compter des milliers de visiteurs : on ne le charge qu'à
  // la première ouverture de l'onglet, pas à chaque rafraîchissement.
  if (name === 'users' && !state.usersCharge) chargerUtilisateurs();
  window.scrollTo({ top: 0 });
  haptic('light');
}

/* ── Tableau de bord ─────────────────────────────────────── */

/**
 * Le tableau de bord : ce que les commandes disent quand on les regroupe.
 *
 * Une seule teinte de remplissage dans tout le panneau, et le néon de la
 * maison réservé à une marque à la fois. Deux couleurs à distinguer
 * demanderaient au vendeur d'apprendre une légende pour lire ses ventes du
 * mardi ; la longueur des barres dit déjà tout.
 */
function renderBoard() {
  renderPeriode();

  const b = state.bilan;
  if (!b) return;
  const r = b.resume;

  // Le chiffre de la période, en tête, avec la comparaison qui lui donne un
  // sens : « 1 240 € » ne dit pas si la boutique monte ou descend.
  const sens = r.evolution === null ? '' : r.evolution >= 0 ? 'haut' : 'bas';
  $('hero').innerHTML =
    `<span class="a-hero__label">Chiffre d'affaires · ${b.periode.jours} jours</span>` +
    `<span class="a-hero__valeur goldtext">${escapeHtml(formatPrice(r.chiffre))}</span>` +
    (r.evolution === null
      ? '<span class="a-hero__delta">Pas encore de période précédente à comparer</span>'
      : `<span class="a-hero__delta a-hero__delta--${sens}">` +
        `<b>${r.evolution >= 0 ? '▲' : '▼'} ${Math.abs(r.evolution)} %</b> ` +
        `vs les ${b.periode.jours} jours d'avant (${escapeHtml(formatPrice(r.chiffreAvant))})</span>`);

  const kpis = [
    { label: 'Commandes', value: r.commandes },
    { label: 'Panier moyen', value: formatPrice(r.panierMoyen) },
    { label: 'À traiter', value: state.stats.pending, cls: state.stats.pending ? 'a-kpi--warn' : '' },
    { label: 'Clients servis', value: r.clients, note: r.nouveaux ? `dont ${r.nouveaux} nouveau${r.nouveaux > 1 ? 'x' : ''}` : 'aucun nouveau' },
    { label: 'Livraisons', value: `${r.partLivraison} %` },
    { label: 'Annulations', value: `${r.tauxAnnulation} %`, cls: r.tauxAnnulation >= 20 ? 'a-kpi--warn' : '' },
  ];
  $('kpis').replaceChildren(
    ...kpis.map((k) => {
      const div = document.createElement('div');
      div.className = `a-kpi ${k.cls ?? ''}`.trim();
      div.innerHTML =
        `<span class="a-kpi__label">${escapeHtml(k.label)}</span>` +
        `<span class="a-kpi__value">${escapeHtml(String(k.value))}</span>` +
        (k.note ? `<span class="a-kpi__note">${escapeHtml(k.note)}</span>` : '');
      return div;
    })
  );

  // Au-delà de six semaines, un jour ne fait plus qu'un trait de deux pixels :
  // on regroupe par semaine plutôt que de dessiner un peigne illisible.
  const jours = b.periode.jours > 45 ? parSemaine(b.parJour) : b.parJour;
  colonnes($('vizJours'), {
    titre: b.periode.jours > 45 ? 'Chiffre par semaine' : 'Chiffre par jour',
    points: jours.map((j) => ({ etiquette: j.etiquette, valeur: j.chiffre, detail: `${j.commandes} commande${j.commandes > 1 ? 's' : ''}` })),
    format: formatPrice,
    accent: jours.length - 1,
    colonnesTableau: ['Jour', 'Chiffre', 'Commandes'],
    lignesTableau: jours.map((j) => [j.etiquette, formatPrice(j.chiffre), String(j.commandes)]),
  });

  // Six produits au plus, le reste réuni : au-delà, on lit une liste, pas un
  // graphique — et la liste complète est juste en dessous, dépliable.
  const tete = b.produits.slice(0, 6);
  const reste = b.produits.slice(6);
  const total = reste.reduce((somme, p) => somme + p.chiffre, 0);
  const lignes = [...tete];
  if (reste.length) lignes.push({ nom: `${reste.length} autres`, chiffre: total, quantite: reste.reduce((s2, p) => s2 + p.quantite, 0) });

  barres($('vizProduits'), {
    titre: 'Chiffre par produit',
    lignes: lignes.map((p) => ({ nom: p.nom, valeur: p.chiffre, texte: `${p.quantite} vendu${p.quantite > 1 ? 's' : ''} · ${formatPrice(p.chiffre)}` })),
    colonnesTableau: ['Produit', 'Vendus', 'Chiffre'],
    lignesTableau: b.produits.map((p) => [p.nom, String(p.quantite), formatPrice(p.chiffre)]),
  });

  colonnes($('vizHeures'), {
    titre: "Commandes par tranche de 2 h",
    points: b.heures.map((h) => ({ etiquette: h.tranche, valeur: h.commandes, detail: 'commandes' })),
    format: (v) => String(v),
    accent: indiceDuMax(b.heures.map((h) => h.commandes)),
    pasDeLibelle: 2,
    colonnesTableau: ['Tranche', 'Commandes'],
    lignesTableau: b.heures.map((h) => [h.tranche, String(h.commandes)]),
  });

  colonnes($('vizSemaine'), {
    titre: 'Commandes par jour de la semaine',
    points: b.semaine.map((j) => ({ etiquette: j.jour.slice(0, 3), valeur: j.commandes, detail: formatPrice(j.chiffre) })),
    format: (v) => String(v),
    accent: indiceDuMax(b.semaine.map((j) => j.commandes)),
    colonnesTableau: ['Jour', 'Commandes', 'Chiffre'],
    lignesTableau: b.semaine.map((j) => [j.jour, String(j.commandes), formatPrice(j.chiffre)]),
  });

  // Une liste ordonnée plutôt qu'une carte : une boutique dessert cinq à vingt
  // communes, et un classement se lit d'un coup là où une carte demande de
  // comparer des tailles de pastilles.
  const villes = b.lieux.slice(0, 8);
  const autresLieux = b.lieux.slice(8);
  if (autresLieux.length) {
    villes.push({
      lieu: `${autresLieux.length} autres`,
      commandes: autresLieux.reduce((s2, l) => s2 + l.commandes, 0),
      chiffre: autresLieux.reduce((s2, l) => s2 + l.chiffre, 0),
    });
  }
  barres($('vizLieux'), {
    titre: 'Chiffre par commune',
    lignes: villes.map((l) => ({
      nom: l.lieu,
      valeur: l.chiffre,
      texte: `${l.commandes} commande${l.commandes > 1 ? 's' : ''} · ${formatPrice(l.chiffre)}`,
    })),
    colonnesTableau: ['Lieu', 'Commandes', 'Chiffre'],
    lignesTableau: b.lieux.map((l) => [l.lieu, String(l.commandes), formatPrice(l.chiffre)]),
  });

  const low = lowStockRows();
  $('lowStock').replaceChildren(
    ...(low.length
      ? low.map((r2) => listRow(r2.label, r2.stock === 0 ? 'Épuisé' : `Plus que ${r2.stock}`))
      : [emptyRow('Tous les stocks sont corrects.')])
  );
}

/** Les boutons de période : ils commandent tout le panneau, d'où leur place. */
function renderPeriode() {
  const choix = [
    [7, '7 jours'],
    [30, '30 jours'],
    [90, '90 jours'],
  ];
  $('periode').replaceChildren(
    ...choix.map(([jours, label]) => {
      const bouton = document.createElement('button');
      bouton.type = 'button';
      bouton.textContent = label;
      bouton.setAttribute('aria-pressed', String(jours === state.periode));
      bouton.addEventListener('click', async () => {
        if (jours === state.periode) return;
        state.periode = jours;
        renderPeriode();
        haptic('light');
        // On garde le rendu précédent en attendant : un squelette qui clignote
        // à chaque changement de période fait sauter la page.
        $('panel-board').style.opacity = '.55';
        try {
          state.bilan = await api(`/bilan?jours=${jours}`);
          renderBoard();
        } catch (err) {
          toast(err.message);
        } finally {
          $('panel-board').style.opacity = '';
        }
      });
      return bouton;
    })
  );
}

/** Regroupe des jours en semaines, la dernière semaine en tête de son lundi. */
function parSemaine(parJour) {
  const semaines = [];
  for (const jour of parJour) {
    const dernier = semaines[semaines.length - 1];
    if (!dernier || dernier.compte === 7) {
      semaines.push({ etiquette: jour.etiquette, chiffre: 0, commandes: 0, compte: 0 });
    }
    const courante = semaines[semaines.length - 1];
    courante.chiffre += jour.chiffre;
    courante.commandes += jour.commandes;
    courante.compte++;
  }
  return semaines;
}

const indiceDuMax = (valeurs) => valeurs.indexOf(Math.max(...valeurs));

/* ── Les graphiques ──────────────────────────────────────── */

/**
 * Un histogramme, en SVG écrit à la main.
 *
 * Pas de bibliothèque : quatre graphiques ne valent pas cinquante kilo-octets
 * chargés à l'ouverture de l'espace admin, souvent sur le réseau d'un
 * téléphone. Les marques sont fines, le bout arrondi côté valeur et carré sur
 * la ligne de base, et deux pixels de fond les séparent — c'est ce vide qui
 * fait la séparation, pas un contour.
 */
function colonnes(figure, { titre, points, format, accent = -1, pasDeLibelle, colonnesTableau, lignesTableau }) {
  // Sept étiquettes au plus : trente dates côte à côte se chevauchent et ne se
  // lisent plus du tout — mieux vaut une date sur cinq, lisible.
  const pas = pasDeLibelle ?? Math.max(1, Math.ceil(points.length / 7));
  const L = 340;
  const H = 132;      // la zone tracée
  const BAS = 148;    // la bande des étiquettes, incluse dans la boîte
  const GAUCHE = 30;  // la gouttière de l'échelle

  const valeurs = points.map((p) => p.valeur);
  const max = Math.max(...valeurs, 0);
  if (!points.length || max === 0) {
    figure.innerHTML =
      `<p class="a-viz__titre">${escapeHtml(titre)}</p>` +
      '<p class="a-viz__vide">Rien à montrer sur cette période.</p>';
    return;
  }

  const bande = (L - GAUCHE) / points.length;
  const largeur = Math.max(2, Math.min(24, bande - 2)); // les 2 px de vide
  const hauteur = (v) => Math.round((v / max) * (H - 14));

  const marques = points
    .map((p, i) => {
      const x = GAUCHE + i * bande + (bande - largeur) / 2;
      // Un jour sans vente garde son trait, en gris de piste : sans lui, la
      // rangée de jours a des trous, on ne sait plus lequel on regarde, et le
      // jour souligné disparaîtrait avec sa valeur les jours creux.
      const h = p.valeur > 0 ? Math.max(3, hauteur(p.valeur)) : 2;
      const y = H - h;
      const r = Math.min(4, largeur / 2, h);
      const classe = p.valeur > 0 ? (i === accent ? 'a-col a-col--accent' : 'a-col') : 'a-col a-col--vide';
      const forme =
        `<path class="${classe}" d="M${x} ${y + r} a${r} ${r} 0 0 1 ${r} -${r} h${largeur - 2 * r} a${r} ${r} 0 0 1 ${r} ${r} V${H} H${x} Z"></path>`;
      // La zone de survol couvre toute la bande : viser une colonne de six
      // pixels au doigt est un jeu d'adresse, pas une lecture.
      return (
        `<rect class="a-col__zone" x="${GAUCHE + i * bande}" y="0" width="${bande}" height="${H}" ` +
        `tabindex="0" role="button" aria-label="${escapeHtml(`${p.etiquette} : ${format(p.valeur)}`)}" ` +
        `data-bulle="${escapeHtml(`${p.etiquette} · ${format(p.valeur)}${p.detail ? ` · ${p.detail}` : ''}`)}"></rect>${forme}`
      );
    })
    .join('');

  const etiquettes = points
    .map((p, i) =>
      i % pas === 0 || i === points.length - 1
        ? `<text class="a-axe" x="${GAUCHE + i * bande + bande / 2}" y="${BAS}" text-anchor="middle">${escapeHtml(p.etiquette)}</text>`
        : ''
    )
    .join('');

  // Une valeur posée sur une seule cap — celle qu'on souligne. Un nombre sur
  // chaque colonne ne se lit plus.
  // Rien à écrire au-dessus d'un jour sans vente : « 0 € » suspendu au bord
  // encombre l'axe et n'apprend rien que la colonne vide ne dise déjà.
  const pointe =
    accent >= 0 && points[accent]?.valeur > 0
      ? `<text class="a-axe" x="${GAUCHE + accent * bande + bande / 2}" y="${H - hauteur(points[accent].valeur) - 5}" ` +
        `text-anchor="middle">${escapeHtml(format(points[accent].valeur))}</text>`
      : '';

  figure.innerHTML =
    `<p class="a-viz__titre">${escapeHtml(titre)}</p>` +
    `<svg viewBox="0 0 ${L} ${BAS + 4}" role="img" aria-label="${escapeHtml(titre)}">` +
    `<line class="a-grille" x1="${GAUCHE}" y1="0.5" x2="${L}" y2="0.5"></line>` +
    `<line class="a-grille" x1="${GAUCHE}" y1="${H + 0.5}" x2="${L}" y2="${H + 0.5}"></line>` +
    `<text class="a-axe" x="0" y="9">${escapeHtml(format(max))}</text>` +
    `<text class="a-axe" x="0" y="${H + 3}">0</text>` +
    `${marques}${pointe}${etiquettes}</svg>` +
    tableauDeValeurs(colonnesTableau, lignesTableau);

  brancherLaBulle(figure);
}

/**
 * Des barres horizontales, en HTML.
 *
 * Un nom de produit tient rarement dans une colonne verticale : ici il a toute
 * la largeur, la barre est en dessous, et la valeur au bout de la ligne.
 */
function barres(figure, { titre, lignes, colonnesTableau, lignesTableau }) {
  const max = Math.max(...lignes.map((l) => l.valeur), 0);
  if (!lignes.length || max === 0) {
    figure.innerHTML =
      `<p class="a-viz__titre">${escapeHtml(titre)}</p>` +
      '<p class="a-viz__vide">Aucune vente sur cette période.</p>';
    return;
  }

  figure.innerHTML =
    `<p class="a-viz__titre">${escapeHtml(titre)}</p>` +
    '<div class="a-barres">' +
    lignes
      .map(
        (l) =>
          '<div class="a-barre">' +
          `<div class="a-barre__tete"><b>${escapeHtml(l.nom)}</b>` +
          `<span class="a-barre__valeur">${escapeHtml(l.texte)}</span></div>` +
          `<div class="a-barre__piste"><div class="a-barre__part" style="width:${Math.max(2, Math.round((l.valeur / max) * 100))}%"></div></div>` +
          '</div>'
      )
      .join('') +
    '</div>' +
    tableauDeValeurs(colonnesTableau, lignesTableau);
}

/**
 * Le même contenu, en tableau, replié sous le graphique.
 *
 * Une bulle de survol n'existe pas au doigt et ne se lit pas au lecteur
 * d'écran : aucune valeur ne doit n'être accessible que par elle.
 */
function tableauDeValeurs(colonnes_, lignes) {
  if (!colonnes_?.length || !lignes?.length) return '';
  return (
    '<details><summary>Voir les chiffres</summary><table><thead><tr>' +
    colonnes_.map((c) => `<th>${escapeHtml(c)}</th>`).join('') +
    '</tr></thead><tbody>' +
    lignes
      .map((ligne) => `<tr>${ligne.map((c) => `<td>${escapeHtml(String(c))}</td>`).join('')}</tr>`)
      .join('') +
    '</tbody></table></details>'
  );
}

/** Une bulle unique, posée près du doigt, qui ne retient jamais l'information. */
function brancherLaBulle(figure) {
  const montrer = (zone, x, y) => {
    let bulle = document.getElementById('bulleViz');
    if (!bulle) {
      bulle = document.createElement('div');
      bulle.id = 'bulleViz';
      bulle.className = 'a-bulle';
      document.body.append(bulle);
    }
    bulle.textContent = zone.dataset.bulle ?? '';
    bulle.style.left = `${Math.min(window.innerWidth - 12, Math.max(12, x))}px`;
    bulle.style.top = `${Math.max(8, y - 44)}px`;
    bulle.style.transform = 'translateX(-50%)';
    bulle.hidden = false;
  };
  const cacher = () => {
    const bulle = document.getElementById('bulleViz');
    if (bulle) bulle.hidden = true;
  };

  for (const zone of figure.querySelectorAll('.a-col__zone')) {
    zone.addEventListener('pointerenter', (e) => montrer(zone, e.clientX, e.clientY));
    zone.addEventListener('pointerdown', (e) => montrer(zone, e.clientX, e.clientY));
    zone.addEventListener('pointerleave', cacher);
    zone.addEventListener('focus', () => {
      const boite = zone.getBoundingClientRect();
      montrer(zone, boite.left + boite.width / 2, boite.top);
    });
    zone.addEventListener('blur', cacher);
  }
}

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

/* ── Clients ─────────────────────────────────────────────── */

/**
 * Les fiches clients.
 *
 * Rien n'est collecté pour cet écran : il regroupe ce que les commandes disent
 * déjà. Une carte repliée porte l'essentiel — qui, combien de fois, combien —
 * et s'ouvre sur le reste : adresses servies, produits habituels, états.
 */
function renderClients() {
  const liste = state.clients;
  $('clientCount').textContent = liste.length
    ? `${state.clientsTotal} client${state.clientsTotal > 1 ? 's' : ''}` +
      (state.clientsTotal > liste.length ? ` · les ${liste.length} plus récents` : '')
    : '';

  const conteneur = $('clientsList');
  if (!liste.length) {
    conteneur.innerHTML = `<p class="a-empty">${
      $('clientSearch').value.trim() ? 'Personne ne correspond.' : 'Aucun client pour le moment.'
    }</p>`;
    return;
  }
  conteneur.replaceChildren(...liste.map(carteClient));
}

/* ── Utilisateurs ────────────────────────────────────────── */

/** Charge le registre. Appelé à la première ouverture de l'onglet. */
async function chargerUtilisateurs(q = '') {
  try {
    const data = await api(`/users?q=${encodeURIComponent(q)}`);
    state.users = data.users;
    state.usersTotal = data.total;
    state.usersAcheteurs = data.acheteurs;
    state.usersMontres = data.montres;
    state.usersCharge = true;
    renderUsers();
  } catch (err) {
    $('usersList').innerHTML = `<p class="a-empty">${escapeHtml(err.message)}</p>`;
  }
}

/**
 * Tous ceux qui ont ouvert le bot, curieux compris.
 *
 * En tête, les deux nombres qui comptent : combien de gens ont poussé la
 * porte, et combien ont fini par commander. L'écart, c'est ce que la boutique
 * laisse repartir sans rien vendre — le seul chiffre qu'un onglet « clients »
 * ne peut pas montrer, puisqu'un client, par définition, a déjà commandé.
 */
function renderUsers() {
  const acheteurs = state.usersAcheteurs;
  const total = state.usersTotal;
  const taux = total ? Math.round((acheteurs / total) * 100) : 0;
  $('userStat').innerHTML =
    `<div class="a-kpi"><span class="a-kpi__label">Visiteurs du bot</span>` +
    `<span class="a-kpi__value">${total}</span></div>` +
    `<div class="a-kpi a-kpi--accent"><span class="a-kpi__label">Ont commandé</span>` +
    `<span class="a-kpi__value">${acheteurs}</span>` +
    `<span class="a-kpi__note">${taux} % des visiteurs</span></div>`;

  const liste = state.users;
  const q = $('userSearch').value.trim();
  $('userCount').textContent = q
    ? `${state.usersMontres} résultat${state.usersMontres > 1 ? 's' : ''}`
    : liste.length
      ? `${total} visiteur${total > 1 ? 's' : ''}` +
        (total > liste.length ? ` · les ${liste.length} plus récents` : '')
      : '';

  const conteneur = $('usersList');
  if (!liste.length) {
    conteneur.innerHTML = `<p class="a-empty">${
      q ? 'Personne ne correspond.' : 'Personne n\'a encore ouvert le bot.'
    }</p>`;
    return;
  }
  conteneur.replaceChildren(...liste.map(carteUtilisateur));
}

let rechercheUsersEnAttente = null;
function chercherDesUtilisateurs() {
  clearTimeout(rechercheUsersEnAttente);
  rechercheUsersEnAttente = setTimeout(() => chargerUtilisateurs($('userSearch').value.trim()), 250);
}

/**
 * Une ligne du registre.
 *
 * Repliée, elle dit qui, quand vu la dernière fois, et son état d'un coup
 * d'œil (a commandé, bloqué…). Ouverte, elle donne les dates, le nombre de
 * contacts, et de quoi agir : écrire, voir la fiche Telegram, bloquer.
 */
function carteUtilisateur(u) {
  const carte = document.createElement('article');
  carte.className = 'a-client';

  const qui = u.username ? `@${u.username}` : [u.prenom, u.nom].filter(Boolean).join(' ') || `#${u.id}`;
  const etats = [
    u.aCommande ? `<span class="a-etat a-etat--ok">🛒 ${u.commandes} cmd</span>` : '',
    u.bloque ? '<span class="a-etat a-etat--ko">⛔ bloqué</span>' : '',
    u.verification === 'approved' ? '<span class="a-etat">🪪 vérifié</span>' : '',
    u.abonne ? '' : '<span class="a-etat">🔕 désabonné</span>',
  ].filter(Boolean).join('');

  carte.innerHTML = `
    <button class="a-client__tete" type="button" aria-expanded="false">
      <span class="a-client__qui">${escapeHtml(qui)}</span>
      <span class="a-client__meta">${escapeHtml(ilYA(u.dernier))} · ${u.contacts} contact${u.contacts > 1 ? 's' : ''}${etats ? ` · ${etats}` : ''}</span>
    </button>
    <div class="a-client__detail" hidden></div>`;

  const tete = carte.querySelector('.a-client__tete');
  const detail = carte.querySelector('.a-client__detail');
  tete.addEventListener('click', () => {
    const ouvert = detail.hidden;
    detail.hidden = !ouvert;
    tete.setAttribute('aria-expanded', String(ouvert));
    if (ouvert && !detail.childElementCount) detail.append(detailUtilisateur(u));
    haptic('light');
  });
  return carte;
}

function detailUtilisateur(u) {
  const bloc = document.createElement('div');
  const nom = [u.prenom, u.nom].filter(Boolean).join(' ') || '—';
  const faits = [
    ['Nom Telegram', nom],
    ['Pseudo', u.username ? `@${u.username}` : '—'],
    ['Identifiant', u.id],
    ['Première visite', new Date(u.premier).toLocaleDateString('fr-FR')],
    ['Dernière visite', new Date(u.dernier).toLocaleDateString('fr-FR')],
    ['Contacts', String(u.contacts)],
  ];

  bloc.innerHTML =
    `<dl class="a-client__chiffres">${faits
      .map(([l, v]) => `<div><dt>${escapeHtml(l)}</dt><dd>${escapeHtml(String(v))}</dd></div>`)
      .join('')}</dl>` +
    (u.aCommande
      ? `<p class="a-client__gris" style="margin-top:12px">Ce visiteur a déjà commandé — sa fiche complète est dans l'onglet Clients.</p>`
      : '') +
    `<h3 class="a-client__h3">Comment le joindre</h3><div class="a-client__joindre"></div>` +
    '<div class="a-client__actions"></div>' +
    '<div class="a-client__telegram" hidden></div>';

  // Le même bloc que sur une fiche client : un curieux qui n'a jamais commandé
  // se joint exactement de la même façon, et c'est souvent lui qu'on veut
  // relancer.
  bloc.querySelector('.a-client__joindre').append(joindreBloc(u));

  const actions = bloc.querySelector('.a-client__actions');

  const tg = document.createElement('button');
  tg.className = 'a-btn';
  tg.type = 'button';
  tg.textContent = '👤 Fiche Telegram';
  tg.addEventListener('click', () => chargerFicheTelegram(u.id, bloc, tg));
  actions.append(tg);

  const ban = document.createElement('button');
  ban.className = `a-btn ${u.bloque ? '' : 'a-btn--danger'}`.trim();
  ban.type = 'button';
  ban.textContent = u.bloque ? '↩︎ Débloquer' : '⛔ Bloquer';
  ban.addEventListener('click', async () => {
    await toggleBlock(u.id, !u.bloque, ban);
    u.bloque = !u.bloque;
    ban.textContent = u.bloque ? '↩︎ Débloquer' : '⛔ Bloquer';
    ban.className = `a-btn ${u.bloque ? '' : 'a-btn--danger'}`.trim();
    ban.disabled = false;
  });
  actions.append(ban);
  return bloc;
}

let rechercheEnAttente = null;

/** La recherche part au serveur : elle porte sur toutes les fiches, pas sur
 *  les deux cents envoyées. Une frappe rapide ne déclenche qu'un appel. */
function chercherDesClients() {
  clearTimeout(rechercheEnAttente);
  rechercheEnAttente = setTimeout(async () => {
    const q = $('clientSearch').value.trim();
    try {
      const fiches = await api(`/clients?q=${encodeURIComponent(q)}`);
      state.clients = fiches.clients;
      state.clientsTotal = fiches.total;
      renderClients();
    } catch (err) {
      toast(err.message);
    }
  }, 250);
}

function carteClient(fiche) {
  const carte = document.createElement('article');
  carte.className = 'a-client';

  const qui = fiche.username ? `@${fiche.username}` : fiche.nom ?? `#${fiche.id}`;
  const depuis = fiche.derniere ? ilYA(fiche.derniere) : '—';
  // Sans pseudo, l'identifiant EST l'adresse : il doit se voir sans déplier,
  // sinon on ne sait même pas qu'on a de quoi joindre ce client.
  const sansPseudo = fiche.username ? '' : `<span class="a-etat">id ${escapeHtml(fiche.id)}</span>`;
  const etats = [
    fiche.bloque ? '<span class="a-etat a-etat--ko">⛔ bloqué</span>' : '',
    fiche.verification === 'approved' ? '<span class="a-etat a-etat--ok">🪪 vérifié</span>' : '',
    fiche.verification === 'pending' ? '<span class="a-etat">🪪 en attente</span>' : '',
    fiche.abonne ? '' : '<span class="a-etat">🔕 désabonné</span>',
    sansPseudo,
  ].filter(Boolean).join('');

  carte.innerHTML = `
    <button class="a-client__tete" type="button" aria-expanded="false">
      <span class="a-client__qui">${escapeHtml(qui)}${fiche.nom && fiche.username ? ` · ${escapeHtml(fiche.nom)}` : ''}</span>
      <span class="a-client__chiffre">${formatPrice(fiche.chiffre)}</span>
      <span class="a-client__meta">${fiche.commandes} commande${fiche.commandes > 1 ? 's' : ''} · ${escapeHtml(depuis)}${etats ? ` · ${etats}` : ''}</span>
    </button>
    <div class="a-client__detail" hidden></div>`;

  const tete = carte.querySelector('.a-client__tete');
  const detail = carte.querySelector('.a-client__detail');
  tete.addEventListener('click', () => {
    const ouvert = detail.hidden;
    detail.hidden = !ouvert;
    tete.setAttribute('aria-expanded', String(ouvert));
    if (ouvert && !detail.childElementCount) detail.append(detailClient(fiche));
    haptic('light');
  });
  return carte;
}

/** Le détail d'une fiche : tout ce que la boutique sait, et rien de plus. */
function detailClient(fiche) {
  const bloc = document.createElement('div');

  // Les nombres qui se lisent d'un coup d'œil. Le rang d'abord : savoir qu'on
  // tient son troisième meilleur client change la façon de lui répondre.
  const chiffres = [
    ['Rang', fiche.rang ? `${fiche.rang}ᵉ / ${fiche.surTotal}` : '—'],
    ['Commandes', String(fiche.commandes)],
    ['Dépensé', formatPrice(fiche.chiffre)],
    ['Panier moyen', formatPrice(fiche.panierMoyen)],
    ['Articles', String(fiche.articles ?? 0)],
    ['Annulées', fiche.annulees ? `${fiche.annulees} · ${fiche.tauxAnnulation} %` : '0'],
    ['Livraisons', `${fiche.livraisons} / ${fiche.livraisons + fiche.retraits}`],
    ['Dernière', fiche.joursDepuis === null ? '—' : joursEnClair(fiche.joursDepuis)],
    ['Rythme', rythmeEnClair(fiche.frequence)],
    ['Client depuis', fiche.premiere ? new Date(fiche.premiere).toLocaleDateString('fr-FR') : '—'],
  ];

  // Ce que le registre du bot ajoute : l'écart entre « il regarde » et « il
  // achète ». C'est le seul endroit où ça se voit.
  if (fiche.vu) {
    chiffres.push(
      ['Connaît la boutique', fiche.vu.premiere ? new Date(fiche.vu.premiere).toLocaleDateString('fr-FR') : '—'],
      ['Ouvertures du bot', String(fiche.vu.contacts ?? 0)]
    );
  }

  const adresses = fiche.adresses.length
    ? fiche.adresses
        .map((a) => {
          const route = itineraire(a);
          return (
            '<li>' +
            `${escapeHtml(a.street)}${a.complement ? `<br><span class="a-client__gris">${escapeHtml(a.complement)}</span>` : ''}` +
            `<br>${escapeHtml(`${a.postalCode} ${a.city}`.trim())}` +
            (a.fois > 1 ? ` <span class="a-client__gris">· ${a.fois} livraisons</span>` : '') +
            (route
              ? `<span class="a-route">` +
                `<a href="${escapeHtml(route.maps)}" target="_blank" rel="noopener">🗺 Maps</a>` +
                `<a href="${escapeHtml(route.waze)}" target="_blank" rel="noopener">🚗 Waze</a>` +
                `<a href="${escapeHtml(route.plans)}" target="_blank" rel="noopener">🧭 Plans</a></span>`
              : '') +
            '</li>'
          );
        })
        .join('')
    : '<li class="a-client__gris">Aucune livraison — retrait sur place.</li>';

  const habitudes = [
    fiche.habitudes?.jour ? `plutôt le <b>${escapeHtml(fiche.habitudes.jour)}</b>` : null,
    fiche.habitudes?.heure !== null && fiche.habitudes?.heure !== undefined
      ? `vers <b>${String(fiche.habitudes.heure).padStart(2, '0')} h</b>`
      : null,
  ].filter(Boolean);

  // L'état des commandes en cours : trois « prête » qui dorment, c'est une
  // information que le chiffre d'affaires ne donne pas.
  const statuts = (fiche.statuts ?? [])
    .map((e) => `${escapeHtml(state.statuses[e.status]?.label ?? e.status)} <span class="a-client__gris">× ${e.nombre}</span>`)
    .join(' · ');

  bloc.innerHTML =
    `<dl class="a-client__chiffres">${chiffres
      .map(([label, valeur]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(valeur)}</dd></div>`)
      .join('')}</dl>` +
    `<h3 class="a-client__h3">Comment le joindre</h3><div class="a-client__joindre"></div>` +
    (habitudes.length ? `<h3 class="a-client__h3">Quand il commande</h3><p>Il commande ${habitudes.join(', ')}.</p>` : '') +
    (fiche.produits.length
      ? `<h3 class="a-client__h3">Ce qu'il prend</h3><p>${fiche.produits
          .map((p) => `${escapeHtml(p.nom)} <span class="a-client__gris">× ${p.quantite}</span>`)
          .join(' · ')}</p>`
      : '') +
    (statuts ? `<h3 class="a-client__h3">Où en sont ses commandes</h3><p>${statuts}</p>` : '') +
    `<h3 class="a-client__h3">Où livrer</h3><ul class="a-client__adresses">${adresses}</ul>` +
    (fiche.telephones.length
      ? `<h3 class="a-client__h3">Téléphone</h3><p>${fiche.telephones
          .map((t) => `<a href="tel:${escapeHtml(t.replace(/\s/g, ''))}">${escapeHtml(t)}</a>`)
          .join(' · ')}</p>`
      : '') +
    (fiche.promos?.length
      ? `<h3 class="a-client__h3">Codes utilisés</h3><p>${fiche.promos
          .map((p) => `<b>${escapeHtml(p.code)}</b>${p.fois > 1 ? ` <span class="a-client__gris">× ${p.fois}</span>` : ''}`)
          .join(' · ')}</p>`
      : '') +
    (fiche.notes?.length
      ? `<h3 class="a-client__h3">Ce qu'il a écrit</h3><ul class="a-client__notes">${fiche.notes
          .map(
            (n) =>
              `<li>« ${escapeHtml(n.texte)} »<br><span class="a-client__gris">${escapeHtml(n.reference ?? '')} · ${
                n.date ? new Date(n.date).toLocaleDateString('fr-FR') : ''
              }</span></li>`
          )
          .join('')}</ul>`
      : '') +
    `<h3 class="a-client__h3">Dernières commandes</h3><ul class="a-client__commandes">${fiche.dernieres
      .map(
        (c) =>
          `<li><b>${escapeHtml(c.reference)}</b> · ${new Date(c.date).toLocaleDateString('fr-FR')} · ` +
          `${formatPrice(c.total)} · ${escapeHtml(state.statuses[c.status]?.label ?? c.status)}` +
          `${c.mode === 'delivery' ? ' · 🛵' : ' · 🏠'}</li>`
      )
      .join('')}</ul>` +
    '<div class="a-client__actions"></div>' +
    '<div class="a-client__telegram" hidden></div>';

  bloc.querySelector('.a-client__joindre').append(joindreBloc(fiche));

  const actions = bloc.querySelector('.a-client__actions');

  // Ce que Telegram veut bien dire, à la demande : un appel par client, et
  // seulement quand le vendeur le demande.
  const tg = document.createElement('button');
  tg.className = 'a-btn';
  tg.type = 'button';
  tg.textContent = '👤 Fiche Telegram';
  tg.addEventListener('click', () => chargerFicheTelegram(fiche.id, bloc, tg));
  actions.append(tg);

  const ban = document.createElement('button');
  ban.className = `a-btn ${fiche.bloque ? '' : 'a-btn--danger'}`.trim();
  ban.type = 'button';
  ban.textContent = fiche.bloque ? '↩︎ Débloquer' : '⛔ Bloquer';
  ban.addEventListener('click', async () => {
    await toggleBlock(fiche.id, !fiche.bloque, ban);
    fiche.bloque = !fiche.bloque;
    ban.textContent = fiche.bloque ? '↩︎ Débloquer' : '⛔ Bloquer';
    ban.className = `a-btn ${fiche.bloque ? '' : 'a-btn--danger'}`.trim();
    ban.disabled = false;
  });
  actions.append(ban);

  return bloc;
}

/**
 * Les chemins pour joindre quelqu'un, du plus sûr au plus hasardeux.
 *
 * Un identifiant Telegram numérique ne se contacte pas depuis un compte
 * personnel : c'est la question qui revient devant chaque client sans pseudo.
 * Le bot, lui, le peut — il a déjà une conversation ouverte avec ce client,
 * c'est même d'elle que vient l'identifiant. Le message par le bot est donc
 * proposé en premier, et c'est le seul chemin qui marche pour tout le monde.
 */
function joindreBloc(fiche) {
  const bloc = document.createElement('div');
  const id = String(fiche.id);

  bloc.innerHTML =
    `<p class="a-client__id">Identifiant Telegram <code>${escapeHtml(id)}</code>` +
    `<button class="a-btn a-btn--mince" type="button" data-copier>⧉ copier</button></p>` +
    (fiche.username
      ? `<p class="a-client__gris">Pseudo <b>@${escapeHtml(fiche.username)}</b> — joignable aussi depuis ton compte.</p>`
      : `<p class="a-client__gris">Pas de pseudo public : un identifiant numérique ne s'écrit pas depuis ton compte ` +
        `personnel. Le bot, lui, a déjà une conversation ouverte avec ce client.</p>`) +
    '<div class="a-client__joindre-actions"></div>' +
    '<div class="a-compose" hidden>' +
    `<textarea class="a-compose__texte" rows="3" maxlength="3500" placeholder="Ton message, envoyé par le bot…"></textarea>` +
    '<div class="a-compose__bar">' +
    '<button class="a-btn a-btn--ok" type="button" data-envoyer>Envoyer</button>' +
    '<button class="a-btn" type="button" data-annuler>Annuler</button>' +
    '<span class="a-compose__etat"></span>' +
    '</div></div>';

  const actions = bloc.querySelector('.a-client__joindre-actions');
  const compose = bloc.querySelector('.a-compose');
  const texte = bloc.querySelector('.a-compose__texte');
  const etat = bloc.querySelector('.a-compose__etat');

  bloc.querySelector('[data-copier]').addEventListener('click', (ev) => copier(id, ev.currentTarget));

  const parLeBot = document.createElement('button');
  parLeBot.className = 'a-btn a-btn--ok';
  parLeBot.type = 'button';
  parLeBot.textContent = '💬 Écrire par le bot';
  parLeBot.addEventListener('click', () => {
    compose.hidden = !compose.hidden;
    if (!compose.hidden) texte.focus();
  });
  actions.append(parLeBot);

  if (fiche.username) {
    const direct = document.createElement('a');
    direct.className = 'a-btn';
    direct.href = `https://t.me/${fiche.username}`;
    direct.target = '_blank';
    direct.rel = 'noopener';
    direct.textContent = '↗ Depuis ton compte';
    actions.append(direct);
  }

  const telephone = fiche.telephones?.[0];
  if (telephone) {
    const appel = document.createElement('a');
    appel.className = 'a-btn';
    appel.href = `tel:${telephone.replace(/\s/g, '')}`;
    appel.textContent = '📞 Appeler';
    actions.append(appel);
  }

  bloc.querySelector('[data-annuler]').addEventListener('click', () => {
    compose.hidden = true;
    etat.textContent = '';
  });

  const envoyer = bloc.querySelector('[data-envoyer]');
  envoyer.addEventListener('click', async () => {
    const message = texte.value.trim();
    if (!message) {
      etat.textContent = 'Écris quelque chose.';
      etat.className = 'a-compose__etat a-compose__etat--ko';
      return;
    }
    envoyer.disabled = true;
    etat.className = 'a-compose__etat';
    etat.textContent = 'Envoi…';
    try {
      await api(`/clients/${encodeURIComponent(id)}/message`, { method: 'POST', body: { texte: message } });
      etat.className = 'a-compose__etat a-compose__etat--ok';
      etat.textContent = '✅ Envoyé. Sa réponse arrivera dans ta conversation avec le bot.';
      texte.value = '';
      haptic('success');
    } catch (err) {
      etat.className = 'a-compose__etat a-compose__etat--ko';
      etat.textContent = err.message;
    }
    envoyer.disabled = false;
  });

  return bloc;
}

/**
 * Copie un identifiant, et le dit.
 *
 * Le retour est écrit dans le bouton plutôt que dans un toast : la fiche est
 * longue, le bouton est sous le pouce, et un message qui s'affiche en haut de
 * l'écran passe inaperçu. Le presse-papier est refusé dans certaines WebView —
 * alors on le dit, plutôt que de ne rien faire.
 */
async function copier(valeur, bouton) {
  const avant = bouton.textContent;
  try {
    await navigator.clipboard.writeText(valeur);
    bouton.textContent = '✓ copié';
    haptic('success');
  } catch {
    bouton.textContent = '⚠ sélectionne-le à la main';
  }
  setTimeout(() => { bouton.textContent = avant; }, 1800);
}

/**
 * Le rythme d'un client, en français.
 *
 * Zéro jour entre deux commandes n'est pas une absence de rythme : c'est
 * quelqu'un qui commande plusieurs fois dans la même journée. « tous les 0 j »
 * ne voulait rien dire.
 */
function rythmeEnClair(jours) {
  if (jours === null || jours === undefined) return '—';
  if (jours === 0) return 'plusieurs/jour';
  if (jours === 1) return 'chaque jour';
  return `tous les ${jours} j`;
}

/** « il y a 3 jours » à partir d'un nombre de jours déjà calculé côté serveur. */
function joursEnClair(jours) {
  if (jours <= 0) return "aujourd'hui";
  if (jours === 1) return 'hier';
  if (jours < 31) return `il y a ${jours} j`;
  return `il y a ${Math.round(jours / 30)} mois`;
}

async function chargerFicheTelegram(id, bloc, bouton) {
  bouton.disabled = true;
  bouton.textContent = '…';
  const zone = bloc.querySelector('.a-client__telegram');
  try {
    const fiche = await api(`/clients/${id}/telegram`);
    const nom = [fiche.prenom, fiche.nom].filter(Boolean).join(' ');
    const naissance = fiche.naissance
      ? `${String(fiche.naissance.jour).padStart(2, '0')}/${String(fiche.naissance.mois).padStart(2, '0')}` +
        (fiche.naissance.annee ? `/${fiche.naissance.annee}` : '')
      : null;

    zone.innerHTML =
      (fiche.photo ? `<img class="a-client__photo" src="/api/admin/clients/${encodeURIComponent(id)}/photo" alt="">` : '') +
      '<div>' +
      `<b>${escapeHtml(nom || 'Sans nom')}</b>` +
      (fiche.username ? `<br>@${escapeHtml(fiche.username)}` : '<br><span class="a-client__gris">aucun pseudo</span>') +
      (fiche.pseudos?.length ? `<br><span class="a-client__gris">aussi ${fiche.pseudos.map((u) => `@${escapeHtml(u)}`).join(', ')}</span>` : '') +
      `<br><span class="a-client__gris">identifiant ${escapeHtml(String(fiche.id))}</span>` +
      (naissance
        ? `<br><span class="a-client__gris">anniversaire déclaré ${escapeHtml(naissance)}` +
          ' — déclaratif, Telegram ne le vérifie pas</span>'
        : '') +
      (fiche.prive ? '<br><span class="a-client__gris">profil non retrouvable depuis un transfert</span>' : '') +
      (fiche.bio ? `<br><span class="a-client__gris">« ${escapeHtml(fiche.bio)} »</span>` : '') +
      '</div>';
    zone.hidden = false;
    bouton.remove();
  } catch (err) {
    zone.innerHTML = `<span class="a-client__gris">${escapeHtml(err.message)}</span>`;
    zone.hidden = false;
    bouton.disabled = false;
    bouton.textContent = '👤 Fiche Telegram';
  }
}

/** « il y a 3 jours », plutôt qu'une date à soustraire de tête. */
function ilYA(iso) {
  const jours = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (jours <= 0) return "aujourd'hui";
  if (jours === 1) return 'hier';
  if (jours < 31) return `il y a ${jours} jours`;
  const mois = Math.round(jours / 30);
  return `il y a ${mois} mois`;
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
/**
 * Les liens d'itinéraire d'une commande, ou rien.
 *
 * Le complément reste dehors : « 3e étage, code 1234 » n'aide aucun géocodeur,
 * et beaucoup renoncent à chercher plutôt que de l'ignorer. Les commandes
 * d'avant l'adresse découpée n'ont rien à ouvrir — leur ligne de contact
 * s'affiche telle quelle.
 */
function itineraire(address) {
  if (!address?.street || !address.city || !/^\d{2,6}$/.test(address.postalCode ?? '')) return null;
  const q = encodeURIComponent(`${address.street}, ${address.postalCode} ${address.city}`);
  return {
    maps: `https://www.google.com/maps/dir/?api=1&destination=${q}`,
    waze: `https://waze.com/ul?q=${q}&navigate=yes`,
    plans: `https://maps.apple.com/?daddr=${q}`,
  };
}

function livraisonBloc(order) {
  const livraison = order.mode === 'delivery';
  const lignes = [];

  lignes.push(
    livraison
      ? `🛵 Livraison${order.zone ? ` — ${escapeHtml(order.zone.name)} (${escapeHtml(order.zone.postalCode ?? '')})` : ''}`
      : '🏠 Retrait sur place'
  );
  if (order.slot?.label) lignes.push(`🕒 ${escapeHtml(order.slot.label)}`);

  // L'adresse sur plusieurs lignes, comme sur une enveloppe, et de quoi ouvrir
  // un itinéraire : recopier une adresse à la main dans une application de
  // trajet, une par commande, c'est la faute de frappe assurée.
  const route = livraison ? itineraire(order.address) : null;
  if (route) {
    lignes.push(`📍 ${escapeHtml(order.address.street)}`);
    if (order.address.complement) lignes.push(`&nbsp;&nbsp;&nbsp;${escapeHtml(order.address.complement)}`);
    lignes.push(`&nbsp;&nbsp;&nbsp;${escapeHtml(`${order.address.postalCode} ${order.address.city}`.trim())}`);
    if (order.phone) lignes.push(`📞 ${escapeHtml(order.phone)}`);
    lignes.push(
      '<span class="a-route">' +
        `<a href="${escapeHtml(route.maps)}" target="_blank" rel="noopener">🗺 Maps</a>` +
        `<a href="${escapeHtml(route.waze)}" target="_blank" rel="noopener">🚗 Waze</a>` +
        `<a href="${escapeHtml(route.plans)}" target="_blank" rel="noopener">🧭 Plans</a>` +
      '</span>'
    );
  } else if (order.contact) {
    lignes.push(`📍 ${escapeHtml(order.contact)}`);
  }

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
  // Ni de galerie : un média a besoin d'un produit auquel se rattacher.
  $('mediaBlock').hidden = !product;
  if (product) renderMedia(product);
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
  // Comme la galerie : pas de produit, pas d'envoi possible — le fichier
  // n'aurait aucune fiche à laquelle se rattacher.
  $('pickImage').hidden = !product;
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
  // L'aperçu montre ce que verront les clients dans la grille.
  const source = currentImage();
  const apercu = $('fImageApercu');
  apercu.src = source || '/assets/products/box.svg';
  apercu.alt = '';
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
  if (!$('fPurgeDate').value) {
    const troisMois = new Date(Date.now() - 90 * 86400000);
    $('fPurgeDate').value = troisMois.toISOString().slice(0, 10);
  }
  syncPurgeMode();
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

/* ── Galerie d'un produit ────────────────────────────────── */

/**
 * Liste les médias de la fiche, vignettes comprises.
 *
 * On montre la vraie image plutôt que son adresse : c'est la seule façon de
 * vérifier d'un coup d'œil qu'on a bien mis la bonne, et de repérer celle qui
 * ne charge pas.
 */
function renderMedia(product) {
  state.editing = product;
  const liste = $('mediaList');
  const medias = product.media ?? [];
  const plafond = state.mediaMax ?? 8;

  $('mediaHint').textContent = medias.length
    ? `${medias.length} média${medias.length > 1 ? 's' : ''} sur ${plafond}. Le premier s'affiche en premier dans la fiche.`
    : "Aucun média : la fiche montre l'illustration du produit. Tu peux aussi envoyer une photo ou une vidéo au bot, avec le nom du produit en légende.";

  if (!medias.length) return liste.replaceChildren();

  liste.replaceChildren(
    ...medias.map((media, rang) => {
      const item = document.createElement('div');
      item.className = 'a-media__item';

      const vignette = document.createElement('span');
      vignette.className = 'a-media__vignette';
      const source = media.url ?? `/api/media/${product.id}/${rang}`;
      if (media.kind === 'video') {
        // `preload=metadata` : on veut la première image, pas la vidéo entière.
        // Et la vignette de Telegram si on l'a, qui arrive avant tout le reste.
        const v = document.createElement('video');
        v.src = source;
        if (media.thumbFileId) v.poster = `/api/media/${product.id}/${rang}/apercu`;
        v.preload = 'metadata';
        v.muted = true;
        vignette.append(v);
      } else {
        const img = document.createElement('img');
        img.src = source;
        img.alt = '';
        // Une adresse qui ne charge pas doit se voir, pas laisser un carré vide.
        img.addEventListener('error', () => {
          vignette.replaceChildren();
          vignette.textContent = '⚠';
          vignette.title = 'Ce média ne se charge pas';
        });
        vignette.append(img);
      }

      const texte = document.createElement('span');
      texte.className = 'a-media__texte';
      texte.innerHTML =
        `<b>${rang + 1}. ${media.kind === 'video' ? '🎬 Vidéo' : '🖼 Photo'}` +
        `${rang === 0 ? ' · en tête' : ''}</b>` +
        `<span>${escapeHtml(media.url ?? 'envoyé au bot')}</span>`;

      const actions = document.createElement('span');
      actions.className = 'a-media__actions';

      const monter = document.createElement('button');
      monter.type = 'button';
      monter.textContent = '↑';
      monter.title = 'Monter';
      monter.disabled = rang === 0;
      monter.addEventListener('click', () => deplacerMedia(product.id, rang, rang - 1));

      const descendre = document.createElement('button');
      descendre.type = 'button';
      descendre.textContent = '↓';
      descendre.title = 'Descendre';
      descendre.disabled = rang === medias.length - 1;
      descendre.addEventListener('click', () => deplacerMedia(product.id, rang, rang + 1));

      const retirer = document.createElement('button');
      retirer.type = 'button';
      retirer.textContent = '✕';
      retirer.title = 'Retirer';
      retirer.addEventListener('click', () => retirerMedia(product.id, rang));

      actions.append(monter, descendre);

      // Une vidéo d'avant, sans aperçu : la boutique peut aller le chercher.
      // Sans lui, sa carte reste vide le temps que la vidéo arrive.
      if (media.kind === 'video' && media.fileId && !media.thumbFileId) {
        const apercu = document.createElement('button');
        apercu.type = 'button';
        apercu.textContent = '🖼';
        apercu.title = "Retrouver l'aperçu de cette vidéo";
        apercu.addEventListener('click', () => retrouverApercu(product.id, rang, apercu));
        actions.append(apercu);
      }

      actions.append(retirer);
      item.append(vignette, texte, actions);
      return item;
    })
  );
}

/**
 * Va chercher chez Telegram l'aperçu d'une vidéo déjà en galerie.
 *
 * Le bouton disparaît de lui-même une fois l'aperçu trouvé : il n'y a plus
 * rien à demander.
 */
async function retrouverApercu(id, rang, bouton) {
  bouton.disabled = true;
  bouton.textContent = '…';
  try {
    const produit = await api(`/products/${id}/media/${rang}/apercu`, { method: 'POST' });
    await rafraichirApresMedia(produit);
    toast('Aperçu retrouvé');
    haptic('success');
  } catch (err) {
    bouton.disabled = false;
    bouton.textContent = '🖼';
    toast(err.message);
  }
}

/**
 * Envoie les fichiers choisis dans la galerie du téléphone.
 *
 * `XMLHttpRequest` plutôt que `fetch` : lui seul sait dire où en est l'envoi.
 * Sur un réseau de mobile, une vidéo de vingt mégaoctets prend une minute, et
 * un bouton grisé sans nouvelle pousse à recharger la page en plein transfert.
 *
 * Les fichiers partent l'un après l'autre : en parallèle, ils se disputeraient
 * la bande passante et l'ordre d'arrivée dans la galerie serait celui du
 * hasard, pas celui de la sélection.
 */
async function envoyerDepuisLaGalerie(event) {
  const fichiers = [...(event.target.files ?? [])];
  event.target.value = ''; // sans ça, rechoisir le même fichier ne déclencherait rien
  if (!fichiers.length) return;

  const zone = $('mediaEnvoi');
  const barre = $('mediaProgres');
  const etat = $('mediaEtat');
  zone.hidden = false;
  $('pickMedia').disabled = true;

  let envoyes = 0;
  try {
    for (const [rang, fichier] of fichiers.entries()) {
      const suite = fichiers.length > 1 ? ` (${rang + 1}/${fichiers.length})` : '';
      etat.textContent = `Envoi${suite}…`;
      barre.style.width = '0%';

      const produit = await televerser(fichier, (part) => {
        barre.style.width = `${Math.round(part * 100)}%`;
        etat.textContent = part >= 1 ? `Traitement${suite}…` : `Envoi${suite} · ${Math.round(part * 100)} %`;
      });

      envoyes++;
      await rafraichirApresMedia(produit);
    }
    toast(envoyes > 1 ? `${envoyes} médias ajoutés` : 'Média ajouté');
    haptic('success');
  } catch (err) {
    // On dit combien sont passés : après trois vidéos dont la deuxième échoue,
    // « erreur » tout seul ne dit pas où on en est.
    toast(envoyes ? `${envoyes} envoyé(s), puis : ${err.message}` : err.message);
  } finally {
    zone.hidden = true;
    barre.style.width = '0%';
    $('pickMedia').disabled = false;
  }
}

/** Un fichier, en corps brut, avec l'avancement rapporté au fur et à mesure. */
function televerser(fichier, avance, chemin = 'media') {
  return new Promise((resolve, rejeter) => {
    const requete = new XMLHttpRequest();
    const nom = encodeURIComponent(fichier.name || 'media');
    requete.open('POST', `/api/admin/products/${state.editing.id}/${chemin}/upload?nom=${nom}`);
    requete.setRequestHeader('Content-Type', fichier.type || 'application/octet-stream');
    requete.setRequestHeader('X-Telegram-Init-Data', tg?.initData ?? '');

    requete.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) avance(e.loaded / e.total);
    });

    requete.addEventListener('load', () => {
      let corps = {};
      try { corps = JSON.parse(requete.responseText); } catch {}
      if (requete.status >= 200 && requete.status < 300) return resolve(corps);
      rejeter(new Error(corps.error ?? `Envoi refusé (${requete.status})`));
    });
    requete.addEventListener('error', () => rejeter(new Error('Réseau interrompu pendant l envoi.')));
    requete.addEventListener('abort', () => rejeter(new Error('Envoi interrompu.')));

    requete.send(fichier);
  });
}

/**
 * Envoie la vignette du produit depuis la galerie du téléphone.
 *
 * Un seul fichier : une vignette, par définition, ne se choisit pas à
 * plusieurs. Le reste emprunte le même chemin que la galerie.
 */
async function envoyerLaVignette(event) {
  const fichier = event.target.files?.[0];
  event.target.value = '';
  if (!fichier) return;

  const zone = $('imageEnvoi');
  const barre = $('imageProgres');
  zone.hidden = false;
  $('pickImage').disabled = true;

  try {
    const produit = await televerser(
      fichier,
      (part) => {
        barre.style.width = `${Math.round(part * 100)}%`;
        $('imageEtat').textContent = part >= 1 ? 'Traitement…' : `Envoi · ${Math.round(part * 100)} %`;
      },
      'image'
    );

    // Le formulaire suit : sans ça, enregistrer la fiche réécrirait l'ancienne
    // image par-dessus celle qu'on vient d'envoyer.
    state.editing = produit;
    montrerImage(produit.image);
    const catalog = await api('/catalog');
    state.products = catalog.products;
    renderProducts();
    renderStock();

    toast('Image principale mise à jour');
    haptic('success');
  } catch (err) {
    toast(err.message);
  } finally {
    zone.hidden = true;
    barre.style.width = '0%';
    $('pickImage').disabled = false;
  }
}

/**
 * Aligne le menu, le champ d'adresse et l'aperçu sur une image donnée.
 *
 * Une photo envoyée au bot n'est dans aucune des propositions du menu : elle
 * bascule donc sur « ma photo », dont le champ porte alors l'adresse servie
 * par la boutique.
 */
function montrerImage(image) {
  const connue = IMAGES.some(([valeur]) => valeur === image);
  $('fImage').value = connue ? image : CUSTOM_IMAGE;
  $('fImagePath').value = connue ? '' : image;
  syncImageField();
}

async function ajouterMedia() {
  const url = $('fMediaUrl').value.trim();
  if (!url) return toast("Donne l'adresse de la photo ou de la vidéo");

  const bouton = $('addMedia');
  bouton.disabled = true;
  try {
    const produit = await api(`/products/${state.editing.id}/media`, {
      method: 'POST',
      body: { kind: $('fMediaKind').value, url },
    });
    $('fMediaUrl').value = '';
    await rafraichirApresMedia(produit);
    toast('Média ajouté');
    haptic('success');
  } catch (err) {
    toast(err.message);
  } finally {
    bouton.disabled = false;
  }
}

async function retirerMedia(id, rang) {
  try {
    await rafraichirApresMedia(await api(`/products/${id}/media/${rang}`, { method: 'DELETE' }));
    toast('Média retiré');
  } catch (err) {
    toast(err.message);
  }
}

async function deplacerMedia(id, de, vers) {
  const medias = state.editing?.media ?? [];
  const ordre = medias.map((_, i) => i);
  [ordre[de], ordre[vers]] = [ordre[vers], ordre[de]];
  try {
    await rafraichirApresMedia(await api(`/products/${id}/media`, { method: 'PUT', body: { ordre } }));
  } catch (err) {
    toast(err.message);
  }
}

/** Remet la liste à jour, et le catalogue derrière — la vignette a pu changer. */
async function rafraichirApresMedia(produit) {
  renderMedia(produit);
  const catalog = await api('/catalog');
  state.products = catalog.products;
  renderProducts();
  renderStock();
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

/* ── Effacer des commandes ───────────────────────────────── */

/** « Tout effacer » n'a pas de date : le champ disparaît plutôt que mentir. */
function syncPurgeMode() {
  $('fPurgeDateField').hidden = $('fPurgeMode').value === 'tout';
}

/**
 * Efface, ou fait oublier.
 *
 * Trois garde-fous avant d'écrire quoi que ce soit : le mot tapé à la main, la
 * question posée en clair avec le nombre de commandes concernées, et la
 * sauvegarde qui part dans la conversation. Le serveur redemande le mot de son
 * côté — une interface se contourne, une commande curl n'a pas d'écran de
 * confirmation.
 */
async function purgerLesCommandes() {
  const mode = $('fPurgeMode').value;
  const avant = $('fPurgeDate').value;
  const sauvegarde = $('fPurgeBackup').checked;

  if (mode !== 'tout' && !avant) {
    toast('Choisis une date.');
    return $('fPurgeDate').focus();
  }
  if ($('fPurgeConfirm').value.trim().toUpperCase() !== 'EFFACER') {
    toast('Écris EFFACER pour confirmer.');
    return $('fPurgeConfirm').focus();
  }

  // Combien de commandes sont concernées : « ça ne se rattrape pas » compte
  // moins qu'un nombre. On le calcule sur ce qu'on a sous la main.
  const concernees =
    mode === 'tout'
      ? state.orders.length
      : state.orders.filter((o) => String(o.createdAt).slice(0, 10) < avant).length;
  const geste = mode === 'anonymiser' ? 'anonymiser' : 'effacer';
  const phrase =
    mode === 'tout'
      ? 'Tout effacer : toutes les commandes de la boutique disparaissent. Continuer ?'
      : `${geste === 'anonymiser' ? 'Anonymiser' : 'Effacer'} les commandes d'avant le ${avant} ` +
        `(au moins ${concernees} sur les ${state.orders.length} affichées). Continuer ?`;
  if (!confirm(phrase)) return;

  const bouton = $('doPurge');
  bouton.disabled = true;
  bouton.textContent = sauvegarde ? 'Sauvegarde…' : 'Effacement…';
  try {
    // `api()` sérialise lui-même : lui passer du texte déjà sérialisé enverrait
    // une chaîne JSON là où le serveur attend un objet, et il refuserait.
    const fait = await api('/orders/purge', {
      method: 'POST',
      body: { mode, avant, sauvegarde, confirmation: 'EFFACER' },
    });
    $('fPurgeConfirm').value = '';
    await refreshAll();
    toast(
      fait.anonymisees
        ? `${fait.anonymisees} commande(s) anonymisée(s)`
        : `${fait.effacees} commande(s) effacée(s) · ${fait.restantes} restante(s)`
    );
    haptic('success');
  } catch (err) {
    toast(err.message);
  } finally {
    bouton.disabled = false;
    bouton.textContent = 'Effacer';
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
