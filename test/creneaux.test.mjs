/**
 * Créneaux et zones de livraison.
 *
 * Deux garde-fous à vérifier : on ne livre pas un code postal qu'on ne dessert
 * pas, et on ne met pas dix commandes sur un créneau qui en tient deux.
 *
 * Prérequis : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/creneaux.test.mjs
 */
import 'dotenv/config';
import { signInitData, getShopPass } from './helpers.mjs';

const TOKEN = process.env.BOT_TOKEN;
const BASE = process.env.TEST_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

if (!TOKEN) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer les tests.');
  process.exit(1);
}

const admin = signInitData(TOKEN, { id: 424242, first_name: 'Patron' });
const client = signInitData(TOKEN, { id: 880001, first_name: 'Client' });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const call = (path, { method = 'GET', body, init = admin, pass } = {}) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': init,
      ...(pass ? { 'X-Shop-Pass': pass } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

/* ── Préparation ───────────────────────────────────────── */

const catalog = await (await fetch(`${BASE}/api/catalog`)).json();
const product = catalog.products.find((p) => !p.variants && p.stock > 0);
const prix = product.price;
await call(`/api/admin/products/${product.id}/stock`, { method: 'POST', body: { quantity: 500 } });
const pass = await getShopPass(BASE, client);

const FRAIS_GENERAL = 700;
const FRAIS_CENTRE = 300;
const FRAIS_VALLEE = 900;
const MINIMUM_VALLEE = prix * 3;

// Les créneaux couvrent toute la semaine : le test doit passer un mardi comme
// un dimanche. Large au départ — la capacité sera resserrée plus bas, une fois
// qu'on saura combien de places un magasin déjà entamé a déjà consommées.
const JOURS = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
const CAPACITE = 50;
const grille = Object.fromEntries(
  JOURS.map((jour) => [jour, [{ from: '00:00', to: '23:59', capacity: CAPACITE }]])
);

await call('/api/admin/settings', {
  method: 'PUT',
  body: {
    fulfillment: { pickup: true, delivery: true, deliveryFee: FRAIS_GENERAL, freeDeliveryFrom: null, minimumOrder: 0 },
    limits: { ordersPerHour: 100, unitsPerOrder: 999 },
    discounts: { tiers: [] },
    zones: [
      { name: 'Colmar centre', postalCodes: '68000, 68001', fee: FRAIS_CENTRE },
      { name: 'Vallée', postalCodes: ['68140'], fee: FRAIS_VALLEE, minimumOrder: MINIMUM_VALLEE },
    ],
    // Sans délai de préparation : sinon le créneau du jour disparaîtrait
    // pendant les dernières minutes avant minuit.
    // Trois jours proposés : celui d'aujourd'hui est déjà commencé et sort de
    // la liste, il en reste donc deux — un pour les zones, un pour la capacité.
    slots: { enabled: true, leadMinutes: 0, daysAhead: 3, days: grille },
  },
});

const lignes = (n) => [{ id: product.id, quantity: n }];
const commande = (n, extra = {}, init = client, jeton = pass) =>
  call('/api/orders', { method: 'POST', init, pass: jeton, body: { items: lignes(n), ...extra } });

/* ── Ce que la boutique annonce ──────────────────────────── */

const publie = await (await fetch(`${BASE}/api/catalog`)).json();
check('Les zones sont annoncées au client',
  publie.zones?.length === 2 && publie.zones[0].postalCodes.includes('68000'),
  JSON.stringify(publie.zones?.map((z) => z.name)));
check('La boutique dit que les créneaux sont actifs', publie.slots?.enabled === true);

const dispo = await (await fetch(`${BASE}/api/slots`)).json();
check('Des créneaux sont proposés', dispo.enabled && dispo.slots.length >= 1, `${dispo.slots.length} créneaux`);
check('Chaque créneau annonce ses places',
  dispo.slots.every((s) => typeof s.left === 'number' && typeof s.label === 'string'));

const creneau = dispo.slots[0];
const dernier = dispo.slots[dispo.slots.length - 1];
check('Deux créneaux distincts pour la suite du test', creneau.id !== dernier.id,
  dispo.slots.map((s) => s.id).join(' '));

/* ── Zones ───────────────────────────────────────────────── */

let r = await commande(1, { mode: 'delivery', contact: '3 rue de Paris', slotId: creneau.id });
check('Livraison sans code postal refusée', r.status === 400, `HTTP ${r.status}`);

r = await commande(1, { mode: 'delivery', contact: '3 rue de Paris', postalCode: '75000', slotId: creneau.id });
let data = await r.json();
check('Code postal hors zone refusé', r.status === 400, `HTTP ${r.status}`);
check('Le refus nomme le code postal', String(data.error).includes('75000'), data.error);

r = await commande(1, { mode: 'delivery', contact: '3 rue de Paris', postalCode: '68000', slotId: creneau.id });
data = await r.json();
check('Les frais viennent de la zone, pas des conditions générales',
  r.status === 201 && data.deliveryFee === FRAIS_CENTRE, `${data.deliveryFee} au lieu de ${FRAIS_GENERAL}`);
check('La zone est enregistrée avec la commande',
  data.zone?.name === 'Colmar centre' && data.zone?.postalCode === '68000', JSON.stringify(data.zone));

/* ── Le minimum de la zone prime ─────────────────────────── */

r = await commande(1, { mode: 'delivery', contact: '3 rue du Val', postalCode: '68140', slotId: creneau.id });
data = await r.json();
check('Sous le minimum de la zone, la commande est refusée', r.status === 400, `HTTP ${r.status}`);
check('Le refus nomme la zone', String(data.error).includes('Vallée'), data.error);

r = await commande(3, { mode: 'delivery', contact: '3 rue du Val', postalCode: '68140', slotId: dernier.id });
data = await r.json();
check('Au-dessus du minimum, la zone lointaine facture son tarif',
  r.status === 201 && data.deliveryFee === FRAIS_VALLEE, `frais ${data.deliveryFee}`);

/* ── Le retrait ignore les zones ─────────────────────────── */

r = await commande(1, { mode: 'pickup', slotId: dernier.id });
data = await r.json();
check('Le retrait ne demande pas de code postal',
  r.status === 201 && data.deliveryFee === 0 && data.zone === null, `HTTP ${r.status}`);

/* ── Créneaux ────────────────────────────────────────────── */

r = await commande(1, { mode: 'pickup' });
check('Commander sans créneau est refusé', r.status === 400, `HTTP ${r.status}`);

r = await commande(1, { mode: 'pickup', slotId: '1999-01-01|18:00' });
check('Un créneau inventé est refusé', r.status === 400, `HTTP ${r.status}`);

r = await commande(1, { mode: 'pickup', slotId: creneau.id });
data = await r.json();
check('Le créneau est enregistré avec son libellé',
  r.status === 201 && data.slot?.id === creneau.id && typeof data.slot?.label === 'string',
  JSON.stringify(data.slot));

/* ── Capacité ────────────────────────────────────────────── */

/** État courant d'un créneau, tel que le client le voit. */
const etatDe = async (id) =>
  (await (await fetch(`${BASE}/api/slots`)).json()).slots.find((s) => s.id === id);

// La capacité est resserrée sur la place suivante : le test vaut donc aussi
// sur un magasin qui a déjà servi, sans dépendre d'un fichier vierge.
const dejaPris = CAPACITE - (await etatDe(creneau.id)).left;
const jourDuCreneau = JOURS[new Date(`${creneau.date}T12:00:00Z`).getUTCDay()];
await call('/api/admin/settings', {
  method: 'PUT',
  body: {
    slots: {
      enabled: true, leadMinutes: 0, daysAhead: 3,
      days: { ...grille, [jourDuCreneau]: [{ from: '00:00', to: '23:59', capacity: dejaPris + 1 }] },
    },
  },
});

check('Il reste exactement une place', (await etatDe(creneau.id)).left === 1,
  JSON.stringify(await etatDe(creneau.id)));

r = await commande(1, { mode: 'pickup', slotId: creneau.id });
check('La dernière place est prenable', r.status === 201, `HTTP ${r.status}`);

const plein = await etatDe(creneau.id);
check('Le créneau consommé est annoncé complet', plein?.full === true && plein?.left === 0,
  JSON.stringify(plein));

r = await commande(1, { mode: 'pickup', slotId: creneau.id });
data = await r.json();
check('Un créneau complet refuse la commande', r.status === 409, `HTTP ${r.status}`);
check('Le refus propose de changer de créneau', String(data.error).includes('complet'), data.error);

/* ── Une annulation rend la place ───────────────────────── */

const commandes = await (await call('/api/admin/orders')).json();
const aAnnuler = commandes.find((o) => o.slot?.id === creneau.id && o.status === 'nouvelle');
await call(`/api/admin/orders/${aAnnuler.reference}/status`, { method: 'POST', body: { status: 'annulee' } });

check('Une annulation libère la place', (await etatDe(creneau.id))?.left === 1,
  JSON.stringify(await etatDe(creneau.id)));

r = await commande(1, { mode: 'pickup', slotId: creneau.id });
check('La place libérée est reprenable', r.status === 201, `HTTP ${r.status}`);

/* ── Créneaux coupés : plus rien n'est exigé ─────────────── */

await call('/api/admin/settings', { method: 'PUT', body: { slots: { enabled: false } } });
r = await commande(1, { mode: 'pickup' });
data = await r.json();
check('Créneaux coupés, la commande passe sans créneau',
  r.status === 201 && data.slot === null, `HTTP ${r.status}`);

const eteint = await (await fetch(`${BASE}/api/slots`)).json();
check('La boutique ne propose plus de créneau', eteint.enabled === false && eteint.slots.length === 0);

// Couper l'interrupteur ne doit pas effacer la grille de la semaine.
const reglages = await (await call('/api/admin/settings')).json();
check('La grille survit à l\'extinction',
  reglages.slots.days.lun.length === 1 && reglages.slots.days.lun[0].from === '00:00',
  JSON.stringify(reglages.slots.days.lun));

/* ── Zones retirées : on livre partout à nouveau ─────────── */

await call('/api/admin/settings', { method: 'PUT', body: { zones: [] } });
r = await commande(1, { mode: 'delivery', contact: '9 rue Ailleurs', postalCode: '75000' });
data = await r.json();
check('Sans zone déclarée, on livre partout aux conditions générales',
  r.status === 201 && data.deliveryFee === FRAIS_GENERAL, `HTTP ${r.status}, frais ${data.deliveryFee}`);

/* ── Remise en état ──────────────────────────────────────── */

await call('/api/admin/settings', {
  method: 'PUT',
  body: {
    fulfillment: { pickup: true, delivery: false, deliveryFee: 0, freeDeliveryFrom: null, minimumOrder: 0 },
    limits: { ordersPerHour: 5, unitsPerOrder: 30 },
    zones: [],
    slots: { enabled: false, leadMinutes: 60, daysAhead: 7, days: {} },
  },
});

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Créneaux et zones : OK'}`);
process.exit(failures ? 1 : 0);
