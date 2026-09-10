/**
 * Entrées hostiles et cas tordus.
 *
 * Cette suite ne vérifie pas des fonctionnalités mais des refus : ce que le
 * serveur doit rejeter, borner ou nettoyer quand on lui envoie autre chose que
 * ce que la Mini App enverrait. Chaque ligne vient d'un défaut réellement
 * trouvé en sondant l'API.
 *
 * Prérequis : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/robustesse.test.mjs
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
const client = signInitData(TOKEN, { id: 910001, first_name: 'Client' });

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
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

/* ── Préparation ─────────────────────────────────────────── */

const catalog = await (await fetch(`${BASE}/api/catalog`)).json();
const product = catalog.products.find((p) => !p.variants && p.stock > 0);
await call(`/api/admin/products/${product.id}/stock`, { method: 'POST', body: { quantity: 500 } });
await call('/api/admin/settings', {
  method: 'PUT',
  body: {
    fulfillment: { pickup: true, delivery: true, deliveryFee: 0, freeDeliveryFrom: null, minimumOrder: 0 },
    limits: { ordersPerHour: 999, unitsPerOrder: 999 },
    discounts: { tiers: [] },
    zones: [],
    // L'épreuve doit être active : c'est elle qui donne un sens au
    // laissez-passer qu'on tentera d'emprunter plus bas.
    features: { captcha: true, verification: false, slots: false, zones: true,
                promos: true, tiers: true, limits: true, waitlist: true,
                orderHistory: true, ageGate: true, hours: false, photos: true,
                stockAlerts: true, clientNotifications: true },
  },
});
const pass = await getShopPass(BASE, client);
const commande = (body) => call('/api/orders', { method: 'POST', init: client, pass, body });

/* ── Le corps de la requête ──────────────────────────────── */

let r = await call('/api/orders', { method: 'POST', init: client, pass, body: '{pas du json' });
check('Un JSON malformé donne 400, pas 500', r.status === 400, `HTTP ${r.status}`);

r = await call('/api/orders', {
  method: 'POST', init: client, pass,
  body: { items: [{ id: product.id, quantity: 1 }], note: 'x'.repeat(1_000_000) },
});
check('Un corps trop gros donne 413, pas 500', r.status === 413, `HTTP ${r.status}`);

/* ── Les quantités ───────────────────────────────────────── */

// `Number([2])` vaut 2 : un tableau se faisait passer pour une quantité.
for (const [label, quantity] of [
  ['un tableau', [2]],
  ['un objet', {}],
  ['la valeur nulle', null],
  ['un décimal', 1.5],
  ['un négatif', -3],
  ['zéro', 0],
  ['du texte', 'deux'],
]) {
  r = await commande({ items: [{ id: product.id, quantity }], mode: 'pickup' });
  check(`Quantité refusée : ${label}`, r.status === 400, `HTTP ${r.status}`);
}

r = await commande({ items: [{ id: product.id, quantity: '2' }], mode: 'pickup' });
check('Une quantité en chaîne numérique reste acceptée', r.status === 201, `HTTP ${r.status}`);

/* ── Les prix ────────────────────────────────────────────── */

// `Number(null)` et `Number('')` valent zéro : un champ prix vide créait un
// produit gratuit, que n'importe qui pouvait alors commander.
for (const [label, price] of [['absent', undefined], ['nul', null], ['vide', ''], ['négatif', -100]]) {
  r = await call('/api/admin/products', {
    method: 'POST',
    body: { name: `Sonde ${label}`, category: 'fleurs', price, stock: 1 },
  });
  check(`Prix refusé : ${label}`, r.status === 400, `HTTP ${r.status}`);
}

r = await call('/api/admin/products', {
  method: 'POST',
  body: { name: 'Sonde gratuite', category: 'fleurs', price: 0, stock: 1 },
});
check('Un zéro délibéré reste accepté', r.status === 201, `HTTP ${r.status}`);
if (r.status === 201) await call(`/api/admin/products/${(await r.json()).id}`, { method: 'DELETE' });

r = await call('/api/admin/products', {
  method: 'POST',
  body: { name: 'Sonde format', category: 'fleurs', price: 500, variants: [{ label: '2 g', price: null }] },
});
check('Un format sans prix est refusé', r.status === 400, `HTTP ${r.status}`);

/* ── Les catégories ──────────────────────────────────────── */

const avant = catalog.categories.filter((c) => c.id !== 'all');
r = await call('/api/admin/categories', {
  method: 'PUT',
  body: { categories: [{ label: 'Doublon', emoji: '🌿' }, { label: 'Doublon', emoji: '🍀' }, { label: '  ' }] },
});
let categories = await r.json();
check('Deux catégories de même nom sont fusionnées', categories.length === 1, JSON.stringify(categories.map((c) => c.id)));
check('Une catégorie sans nom est écartée', !categories.some((c) => !c.label.trim()));

r = await call('/api/admin/categories', { method: 'PUT', body: { categories: [{ label: '   ' }] } });
check('Une liste sans aucun nom est refusée', r.status === 400, `HTTP ${r.status}`);

await call('/api/admin/categories', { method: 'PUT', body: { categories: avant } });

/* ── Le texte reçu du client ─────────────────────────────── */

r = await commande({ items: [{ id: product.id, quantity: 1 }], mode: 'pickup', note: 'a'.repeat(5000) });
let data = await r.json();
let order = (await (await call('/api/admin/orders')).json()).find((o) => o.reference === data.reference);
check('Une note trop longue est tronquée à 500', order?.note?.length === 500, `${order?.note?.length}`);

r = await commande({ items: [{ id: product.id, quantity: 1 }], mode: 'delivery', contact: 'b'.repeat(5000) });
data = await r.json();
order = (await (await call('/api/admin/orders')).json()).find((o) => o.reference === data.reference);
check('Une adresse trop longue est tronquée à 200', order?.contact?.length === 200, `${order?.contact?.length}`);

const HTML = '<img src=x onerror=alert(1)>';
r = await commande({ items: [{ id: product.id, quantity: 1 }], mode: 'pickup', note: HTML });
data = await r.json();
order = (await (await call('/api/admin/orders')).json()).find((o) => o.reference === data.reference);
check('Le HTML d\'une note est stocké tel quel, à charge de l\'affichage de l\'échapper',
  order?.note === HTML, order?.note);

/* ── Les réglages ────────────────────────────────────────── */

await call('/api/admin/settings', { method: 'PUT', body: { fulfillment: { deliveryFee: -5000 } } });
let settings = await (await call('/api/admin/settings')).json();
check('Des frais négatifs sont ramenés à zéro', settings.fulfillment.deliveryFee >= 0, `${settings.fulfillment.deliveryFee}`);

settings = await (await call('/api/admin/settings', {
  method: 'PUT', body: { opening: { hours: { timezone: 'Mars/Olympus' } } },
})).json();
check('Un fuseau inconnu est ignoré', settings.opening.hours.timezone !== 'Mars/Olympus', settings.opening.hours.timezone);

settings = await (await call('/api/admin/settings', {
  method: 'PUT', body: { zones: [{ name: 'Z', postalCodes: 'abc, 68000, <script>' }] },
})).json();
check('Les codes postaux non numériques sont écartés',
  JSON.stringify(settings.zones[0]?.postalCodes) === '["68000"]', JSON.stringify(settings.zones[0]?.postalCodes));

settings = await (await call('/api/admin/settings', {
  method: 'PUT', body: { slots: { days: { lun: [{ from: '10:00', to: '12:00', capacity: 0 }] } } },
})).json();
check('Une capacité nulle est remontée à un', settings.slots.days.lun[0]?.capacity >= 1,
  JSON.stringify(settings.slots.days.lun));

/* ── Les remises ─────────────────────────────────────────── */

await call('/api/admin/promos/ENORME', { method: 'DELETE' });
await call('/api/admin/promos', {
  method: 'PUT', body: { code: 'ENORME', type: 'amount', value: 9999999, oncePerClient: false },
});
r = await commande({ items: [{ id: product.id, quantity: 1 }], mode: 'pickup', promoCode: 'ENORME' });
data = await r.json();
check('Une remise plus grosse que le panier ne rend pas d\'argent',
  r.status === 201 && data.total === 0, `total ${data.total}`);
await call('/api/admin/promos/ENORME', { method: 'DELETE' });

/* ── Ce qui appartient à autrui ──────────────────────────── */

const autre = signInitData(TOKEN, { id: 910002, first_name: 'Autre' });
const passAutre = await getShopPass(BASE, autre);
r = await call('/api/orders', {
  method: 'POST', init: client, pass: passAutre,
  body: { items: [{ id: product.id, quantity: 1 }], mode: 'pickup' },
});
check('Le laissez-passer d\'un autre client est refusé', r.status === 403, `HTTP ${r.status}`);

const tiers = signInitData(TOKEN, { id: 910003, first_name: 'Tiers' });
const sesCommandes = await (await call('/api/orders', { init: tiers })).json();
check('On ne lit que ses propres commandes', sesCommandes.length === 0, `${sesCommandes.length}`);

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

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Robustesse : OK'}`);
process.exit(failures ? 1 : 0);
