/**
 * Tableau de bord des fonctionnalités.
 *
 * Un interrupteur qui ne ferait que masquer un bouton ne serait pas un
 * interrupteur : ce test appelle l'API directement, sans passer par la Mini
 * App, et vérifie que le serveur refuse bien ce qui est éteint.
 *
 * Prérequis : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/fonctionnalites.test.mjs
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
const client = signInitData(TOKEN, { id: 900777, first_name: 'Client' });

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

const setFeatures = (features) => call('/api/admin/settings', { method: 'PUT', body: { features } });
const catalogue = () => fetch(`${BASE}/api/catalog`).then((r) => r.json());

/* ── Préparation ─────────────────────────────────────────── */

const depart = await (await catalogue()).products;
const product = depart.find((p) => !p.variants && p.stock > 0);
await call(`/api/admin/products/${product.id}/stock`, { method: 'POST', body: { quantity: 500 } });

await call('/api/admin/settings', {
  method: 'PUT',
  body: {
    fulfillment: { pickup: true, delivery: false, deliveryFee: 0, freeDeliveryFrom: null, minimumOrder: 0 },
    // Plafond horaire large : c'est le plafond d'articles qu'on veut voir
    // jouer ici, et la fréquence a déjà sa propre suite.
    limits: { ordersPerHour: 999, unitsPerOrder: 3 },
    discounts: { tiers: [{ from: 1, percent: 10 }] },
    features: {
      ageGate: true, captcha: true, verification: false, hours: false,
      zones: true, slots: false, tiers: true, promos: true, waitlist: true,
      stockAlerts: true, limits: true, photos: true, orderHistory: true,
      clientNotifications: true,
    },
  },
});

const pass = await getShopPass(BASE, client);
const commande = (n = 1, extra = {}) =>
  call('/api/orders', { method: 'POST', init: client, pass, body: { items: [{ id: product.id, quantity: n }], ...extra } });

/* ── Le catalogue des interrupteurs ──────────────────────── */

const session = await (await call('/api/admin/session')).json();
check('Le serveur publie la liste des fonctionnalités',
  Array.isArray(session.features) && session.features.every((f) => f.key && f.label && f.hint),
  `${session.features?.length} entrées`);

const reglages = await (await call('/api/admin/settings')).json();
check('Chaque fonctionnalité a un état',
  session.features.every((f) => typeof reglages.features[f.key] === 'boolean'));

/* ── Un interrupteur suffit, sans toucher aux autres ─────── */

await setFeatures({ promos: false });
const apresUn = await (await call('/api/admin/settings')).json();
check('Couper une fonctionnalité laisse les autres tranquilles',
  apresUn.features.promos === false && apresUn.features.waitlist === true, JSON.stringify(apresUn.features));
await setFeatures({ promos: true });

/* ── Porte d'âge ─────────────────────────────────────────── */

await setFeatures({ ageGate: false });
check("La porte d'âge se coupe", (await catalogue()).gates.age === false);
await setFeatures({ ageGate: true });
check("La porte d'âge se rallume", (await catalogue()).gates.age === true);

/* ── Épreuve anti-robot ──────────────────────────────────── */

await setFeatures({ captcha: false });
let r = await call('/api/orders', {
  method: 'POST', init: client,
  body: { items: [{ id: product.id, quantity: 1 }] },   // sans laissez-passer
});
check('CAPTCHA coupé : la commande passe sans laissez-passer', r.status === 201, `HTTP ${r.status}`);
check('Le reflet historique suit', (await (await call('/api/admin/settings')).json()).captcha.enabled === false);
await setFeatures({ captcha: true });

r = await call('/api/orders', { method: 'POST', init: client, body: { items: [{ id: product.id, quantity: 1 }] } });
check('CAPTCHA rallumé : la commande est refusée sans laissez-passer',
  r.status === 403 && (await r.json()).error === 'CAPTCHA_REQUIS', `HTTP ${r.status}`);

/* ── Garde-fous ──────────────────────────────────────────── */

await setFeatures({ limits: false });
r = await commande(50);   // le plafond était à 3 articles
check('Garde-fous coupés : une grosse commande passe', r.status === 201, `HTTP ${r.status}`);
await setFeatures({ limits: true });
r = await commande(50);
check('Garde-fous rallumés : la même commande est refusée', r.status === 400, `HTTP ${r.status}`);

/* ── Remises par palier ──────────────────────────────────── */

r = await commande(1);
let data = await r.json();
check('Palier actif : la remise s\'applique', data.discount > 0, `remise ${data.discount}`);
check('Le palier est annoncé au client', (await catalogue()).discounts.tiers.length === 1);

await setFeatures({ tiers: false });
r = await commande(1);
data = await r.json();
check('Paliers coupés : plus aucune remise automatique', data.discount === 0, `remise ${data.discount}`);
check('Le palier disparaît de la vitrine', (await catalogue()).discounts.tiers.length === 0);
await setFeatures({ tiers: true });

/* ── Codes promo ─────────────────────────────────────────── */

await call('/api/admin/promos', { method: 'PUT', body: { code: 'FEATTEST', type: 'amount', value: 100, oncePerClient: false } });
r = await call('/api/promo', { method: 'POST', init: client, body: { items: [{ id: product.id, quantity: 1 }], code: 'FEATTEST' } });
check('Codes actifs : l\'aperçu répond', r.status === 200, `HTTP ${r.status}`);

await setFeatures({ promos: false });
r = await call('/api/promo', { method: 'POST', init: client, body: { items: [{ id: product.id, quantity: 1 }], code: 'FEATTEST' } });
check('Codes coupés : l\'aperçu refuse', r.status === 400, `HTTP ${r.status}`);

// Le code envoyé quand même ne doit pas s'appliquer en douce.
r = await commande(1, { promoCode: 'FEATTEST' });
data = await r.json();
check('Codes coupés : un code envoyé à la main est ignoré',
  r.status === 201 && data.promoCode === null, JSON.stringify({ s: r.status, c: data.promoCode }));

await setFeatures({ promos: true });
await call('/api/admin/promos/FEATTEST', { method: 'DELETE' });

/* ── Liste d'attente ─────────────────────────────────────── */

// Un article épuisé, pour pouvoir s'inscrire.
const rupture = (await catalogue()).products.find((p) => !p.variants && p.id !== product.id);
await call(`/api/admin/products/${rupture.id}/stock`, { method: 'POST', body: { quantity: 0 } });

r = await call('/api/waitlist', { method: 'POST', init: client, body: { id: rupture.id } });
check('Liste active : l\'inscription est acceptée', r.status === 201, `HTTP ${r.status}`);

await setFeatures({ waitlist: false });
r = await call('/api/waitlist', { method: 'POST', init: client, body: { id: rupture.id } });
check('Liste coupée : l\'inscription est refusée', r.status === 403, `HTTP ${r.status}`);
r = await call(`/api/waitlist?id=${rupture.id}`, { init: client });
check('Liste coupée : personne n\'est déclaré inscrit', (await r.json()).subscribed === false);
await setFeatures({ waitlist: true });

/* ── Mes commandes ───────────────────────────────────────── */

r = await call('/api/orders', { init: client });
check('Historique actif : le client relit ses commandes', (await r.json()).length > 0);

await setFeatures({ orderHistory: false });
r = await call('/api/orders', { init: client });
check('Historique coupé : la liste est vide', (await r.json()).length === 0);
await setFeatures({ orderHistory: true });

/* ── Photos ──────────────────────────────────────────────── */

await setFeatures({ photos: false });
r = await fetch(`${BASE}/api/photo/${product.id}`);
check('Photos coupées : la route ne sert plus rien', r.status === 404, `HTTP ${r.status}`);
await setFeatures({ photos: true });

/* ── Zones ───────────────────────────────────────────────── */

await call('/api/admin/settings', {
  method: 'PUT',
  body: {
    fulfillment: { pickup: true, delivery: true, deliveryFee: 400 },
    zones: [{ name: 'Secteur test', postalCodes: '68000', fee: 100 }],
  },
});
r = await commande(1, { mode: 'delivery', contact: '1 rue Ailleurs', postalCode: '75000' });
check('Zones actives : un code postal hors zone est refusé', r.status === 400, `HTTP ${r.status}`);

await setFeatures({ zones: false });
r = await commande(1, { mode: 'delivery', contact: '1 rue Ailleurs', postalCode: '75000' });
data = await r.json();
check('Zones coupées : on livre partout aux conditions générales',
  r.status === 201 && data.deliveryFee === 400, `HTTP ${r.status}, frais ${data.deliveryFee}`);
check('Zones coupées : la vitrine n\'en annonce aucune', (await catalogue()).zones.length === 0);

/* ── Les réglages survivent à l'extinction ──────────────── */

const conserves = await (await call('/api/admin/settings')).json();
check('Une zone éteinte n\'est pas effacée',
  conserves.zones.length === 1 && conserves.zones[0].name === 'Secteur test',
  JSON.stringify(conserves.zones.map((z) => z.name)));

await setFeatures({ zones: true });
check('Rallumée, la zone est de retour', (await catalogue()).zones.length === 1);

/* ── Créneaux ────────────────────────────────────────────── */

await call('/api/admin/settings', {
  method: 'PUT',
  body: {
    slots: { leadMinutes: 0, daysAhead: 3, days: { lun: [{ from: '00:00', to: '23:59', capacity: 9 }] } },
  },
});
await setFeatures({ slots: true });
check('Créneaux allumés : la boutique en propose', (await (await fetch(`${BASE}/api/slots`)).json()).enabled === true);
r = await commande(1, { mode: 'pickup' });
check('Créneaux allumés : commander sans créneau est refusé', r.status === 400, `HTTP ${r.status}`);

await setFeatures({ slots: false });
r = await commande(1, { mode: 'pickup' });
check('Créneaux coupés : la commande passe sans créneau', r.status === 201, `HTTP ${r.status}`);

const grille = await (await call('/api/admin/settings')).json();
check('La grille de la semaine survit à l\'extinction',
  grille.slots.days.lun.length === 1, JSON.stringify(grille.slots.days.lun));

/* ── Remise en état ──────────────────────────────────────── */

await call(`/api/admin/products/${rupture.id}/stock`, { method: 'POST', body: { quantity: 12 } });
await call('/api/admin/settings', {
  method: 'PUT',
  body: {
    fulfillment: { pickup: true, delivery: false, deliveryFee: 0, freeDeliveryFrom: null, minimumOrder: 0 },
    limits: { ordersPerHour: 5, unitsPerOrder: 30 },
    discounts: { tiers: [] },
    zones: [],
    features: {
      ageGate: true, captcha: true, verification: false, hours: false,
      zones: true, slots: false, tiers: true, promos: true, waitlist: true,
      stockAlerts: true, limits: true, photos: true, orderHistory: true,
      clientNotifications: true,
    },
  },
});

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Fonctionnalités activables : OK'}`);
process.exit(failures ? 1 : 0);
