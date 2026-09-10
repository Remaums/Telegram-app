/**
 * Codes promo et remises par palier.
 *
 * Le point qui compte : un client ne cumule jamais les deux, et les montants
 * sont recalculés côté serveur — un code n'est pas une réduction que le client
 * s'accorde lui-même dans le corps de la requête.
 *
 * Prérequis : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/promos.test.mjs
 */
import 'dotenv/config';
import { signInitData, getShopPass, resetShop } from './helpers.mjs';

const TOKEN = process.env.BOT_TOKEN;
const BASE = process.env.TEST_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

if (!TOKEN) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer les tests.');
  process.exit(1);
}

const admin = signInitData(TOKEN, { id: 424242, first_name: 'Patron' });

// Le décor de départ, posé par cette suite plutôt que hérité de la
// précédente : sans ça, l'ordre du package.json devient un piège.
await resetShop(BASE, admin, { features: { tiers: true, promos: true, slots: false, zones: false } });
const client = signInitData(TOKEN, { id: 860001, first_name: 'Client' });
const autre = signInitData(TOKEN, { id: 860002, first_name: 'Autre' });

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

/* ── Préparation ─────────────────────────────────────────
   Les seuils se déduisent du prix réel du produit : les coder en dur
   rendrait le test faux dès qu'on change le catalogue. */

const catalog = await (await fetch(`${BASE}/api/catalog`)).json();
const product = catalog.products.find((p) => !p.variants && p.stock > 0);
const prix = product.price;
await call(`/api/admin/products/${product.id}/stock`, { method: 'POST', body: { quantity: 500 } });

const passClient = await getShopPass(BASE, client);
const passAutre = await getShopPass(BASE, autre);

// Un palier à 4 articles, pour qu'un panier de 2 passe en dessous.
const PALIER = prix * 4;

await call('/api/admin/settings', {
  method: 'PUT',
  body: {
    fulfillment: { pickup: true, delivery: false, deliveryFee: 0, freeDeliveryFrom: null, minimumOrder: 0 },
    limits: { ordersPerHour: 100, unitsPerOrder: 999 },
    discounts: { tiers: [{ from: PALIER, percent: 10 }] },
  },
});

const lignes = (n) => [{ id: product.id, quantity: n }];
const commande = (n, extra = {}, init = client, pass = passClient) =>
  call('/api/orders', { method: 'POST', init, pass, body: { items: lignes(n), ...extra } });
const apercu = (n, code, init = client) =>
  call('/api/promo', { method: 'POST', init, body: { items: lignes(n), code } });

/* ── Les paliers sont annoncés à la boutique ─────────────── */

const publie = await (await fetch(`${BASE}/api/catalog`)).json();
check('Le palier est visible côté client',
  publie.discounts?.tiers?.[0]?.percent === 10, JSON.stringify(publie.discounts));

/* ── Remise automatique ──────────────────────────────────── */

let r = await commande(2);
let data = await r.json();
check('Sous le palier, aucune remise',
  r.status === 201 && data.discount === 0 && data.total === data.subtotal, `remise ${data.discount}`);

r = await commande(4);
data = await r.json();
check('Au palier, la remise est appliquée par le serveur',
  r.status === 201 && data.discount === Math.round(prix * 4 * 0.1)
    && data.total === data.subtotal - data.discount,
  `${data.subtotal} − ${data.discount} = ${data.total}`);
check('Le libellé du palier accompagne la commande',
  typeof data.discountLabel === 'string' && data.discountLabel.includes('10'), data.discountLabel);

/* ── Création d'un code ──────────────────────────────────── */

await call('/api/admin/promos/TESTPROMO', { method: 'DELETE' });
await call('/api/admin/promos/TESTMONTANT', { method: 'DELETE' });
await call('/api/admin/promos/TESTUNIQUE', { method: 'DELETE' });

r = await call('/api/admin/promos', {
  method: 'PUT',
  body: { code: 'testpromo', type: 'percent', value: 20 },
});
let promos = await r.json();
check('Le code est créé et normalisé en majuscules',
  r.status === 200 && promos.some((p) => p.code === 'TESTPROMO'), JSON.stringify(promos.map((p) => p.code)));

r = await call('/api/admin/promos', { method: 'PUT', body: { code: 'AB', type: 'percent', value: 10 } });
check('Un code trop court est refusé', r.status === 400, `HTTP ${r.status}`);

r = await call('/api/admin/promos', { method: 'PUT', body: { code: 'ENORME', type: 'percent', value: 95 } });
check('Une remise au-dessus de 90 % est refusée', r.status === 400, `HTTP ${r.status}`);

/* ── L'espace codes reste fermé aux clients ──────────────── */

r = await call('/api/admin/promos', { init: client });
check('Un client ne voit pas la liste des codes', r.status === 403, `HTTP ${r.status}`);

/* ── Aperçu ──────────────────────────────────────────────── */

r = await apercu(2, 'TESTPROMO');
data = await r.json();
check('L\'aperçu chiffre la remise sans commander',
  r.status === 200 && data.discount === Math.round(prix * 2 * 0.2) && data.code === 'TESTPROMO',
  JSON.stringify(data));

r = await apercu(2, 'NEXISTEPAS');
check('Un code inconnu est refusé', r.status === 400, `HTTP ${r.status}`);

/* ── La meilleure des deux, jamais les deux ──────────────── */

r = await apercu(4, 'TESTPROMO');
data = await r.json();
const cumul = Math.round(prix * 4 * 0.3);
check('Code et palier ne se cumulent pas',
  data.discount === Math.round(prix * 4 * 0.2) && data.discount !== cumul,
  `${data.discount} au lieu de ${cumul}`);
check('Le meilleur des deux gagne', data.source === 'promo', data.source);

// Un panier au palier, avec un code moins avantageux : le palier l'emporte.
await call('/api/admin/promos', { method: 'PUT', body: { code: 'TESTFAIBLE', type: 'percent', value: 2 } });
r = await apercu(4, 'TESTFAIBLE');
data = await r.json();
check('Un code moins avantageux ne dégrade pas la remise automatique',
  data.source === 'tier' && data.code === null && data.discount === Math.round(prix * 4 * 0.1),
  JSON.stringify(data));

/* ── Montant fixe et panier minimum ──────────────────────── */

await call('/api/admin/promos', {
  method: 'PUT',
  body: { code: 'TESTMONTANT', type: 'amount', value: 300, minSubtotal: prix * 3 },
});

r = await apercu(1, 'TESTMONTANT');
check('Sous le panier minimum, le code est refusé', r.status === 400, `HTTP ${r.status}`);

r = await apercu(3, 'TESTMONTANT');
data = await r.json();
check('Au-dessus du minimum, le montant fixe s\'applique', data.discount === 300, JSON.stringify(data));

/* ── Le client ne choisit pas sa remise ──────────────────── */

r = await call('/api/orders', {
  method: 'POST',
  init: client,
  pass: passClient,
  body: { items: lignes(2), promoCode: 'TESTPROMO', discount: 999999, total: 1 },
});
data = await r.json();
check('Remise et total envoyés par le client sont ignorés',
  r.status === 201 && data.discount === Math.round(prix * 2 * 0.2) && data.total === data.subtotal - data.discount,
  `${data.subtotal} − ${data.discount} = ${data.total}`);

/* ── Une fois par client ─────────────────────────────────── */

r = await commande(2, { promoCode: 'TESTPROMO' });
check('Le même client ne réutilise pas le code', r.status === 400, `HTTP ${r.status}`);

r = await commande(2, { promoCode: 'TESTPROMO' }, autre, passAutre);
data = await r.json();
check('Un autre client peut encore l\'utiliser',
  r.status === 201 && data.promoCode === 'TESTPROMO', `HTTP ${r.status}`);

/* ── Nombre d'usages ─────────────────────────────────────── */

await call('/api/admin/promos', {
  method: 'PUT',
  body: { code: 'TESTUNIQUE', type: 'percent', value: 5, maxUses: 1, oncePerClient: false },
});

r = await commande(1, { promoCode: 'TESTUNIQUE' });
check('Premier usage accepté', r.status === 201, `HTTP ${r.status}`);
r = await commande(1, { promoCode: 'TESTUNIQUE' });
check('Au-delà du quota, le code ne passe plus', r.status === 400, `HTTP ${r.status}`);

/* ── Expiration et désactivation ─────────────────────────── */

await call('/api/admin/promos', {
  method: 'PUT',
  body: { code: 'TESTPROMO', type: 'percent', value: 20, expiresAt: '2020-01-01' },
});
r = await apercu(2, 'TESTPROMO', autre);
check('Un code expiré est refusé', r.status === 400, `HTTP ${r.status}`);

await call('/api/admin/promos', {
  method: 'PUT',
  body: { code: 'TESTPROMO', type: 'percent', value: 20, active: false },
});
r = await apercu(2, 'TESTPROMO', autre);
check('Un code désactivé est refusé', r.status === 400, `HTTP ${r.status}`);

/* ── Les compteurs survivent à une modification ──────────── */

promos = await (await call('/api/admin/promos')).json();
const compte = promos.find((p) => p.code === 'TESTPROMO');
check('Modifier un code ne remet pas son compteur à zéro', compte.uses >= 2, `${compte?.uses} usages`);

/* ── Suppression ─────────────────────────────────────────── */

for (const code of ['TESTPROMO', 'TESTMONTANT', 'TESTUNIQUE', 'TESTFAIBLE']) {
  promos = await (await call(`/api/admin/promos/${code}`, { method: 'DELETE' })).json();
}
check('Les codes de test sont supprimés',
  !promos.some((p) => p.code.startsWith('TEST')), JSON.stringify(promos.map((p) => p.code)));

/* ── Remise en état ──────────────────────────────────────── */

await call('/api/admin/settings', {
  method: 'PUT',
  body: {
    discounts: { tiers: [] },
    limits: { ordersPerHour: 5, unitsPerOrder: 30 },
  },
});

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Codes promo et remises : OK'}`);
process.exit(failures ? 1 : 0);
