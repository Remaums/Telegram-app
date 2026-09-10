/**
 * Retrait, livraison, frais et minimum de commande.
 *
 * Tous les montants sont recalculés côté serveur : ce test vérifie surtout
 * qu'un client ne choisit pas ses propres frais, et que le franco s'applique.
 *
 * Prérequis : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/livraison.test.mjs
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
await resetShop(BASE, admin, { features: { zones: false, slots: false } });
const client = signInitData(TOKEN, { id: 850001, first_name: 'Client' });

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
   Les seuils se déduisent du prix réel du produit : coder « 15 € »
   en dur rendrait le test faux dès qu'on change le catalogue. */

const catalog = await (await fetch(`${BASE}/api/catalog`)).json();
const product = catalog.products.find((p) => !p.variants && p.stock > 0);
const prix = product.price;
await call(`/api/admin/products/${product.id}/stock`, { method: 'POST', body: { quantity: 200 } });
const pass = await getShopPass(BASE, client);

const MINIMUM = prix + 100;      // un article passe juste en dessous
const FRAIS = 500;
const FRANCO = prix * 3;

await call('/api/admin/settings', {
  method: 'PUT',
  body: {
    fulfillment: { pickup: true, delivery: true, deliveryFee: FRAIS, freeDeliveryFrom: FRANCO, minimumOrder: MINIMUM },
    limits: { ordersPerHour: 100, unitsPerOrder: 999 },
  },
});

const commande = (items, extra = {}) =>
  call('/api/orders', { method: 'POST', init: client, pass, body: { items, ...extra } });
const lignes = (n) => [{ id: product.id, quantity: n }];

/* ── Minimum de commande ─────────────────────────────────── */

let r = await commande(lignes(1), { mode: 'pickup' });
check('Sous le minimum, la commande est refusée', r.status === 400, `HTTP ${r.status}`);

/* ── Retrait : pas de frais ──────────────────────────────── */

const pourAtteindre = Math.ceil(MINIMUM / prix);
r = await commande(lignes(pourAtteindre), { mode: 'pickup' });
let data = await r.json();
check('Retrait accepté, sans frais',
  r.status === 201 && data.deliveryFee === 0 && data.total === data.subtotal, `frais ${data.deliveryFee}`);
check('Le mode est enregistré', data.mode === 'pickup', data.mode);

/* ── Livraison : adresse exigée, frais ajoutés ───────────── */

r = await commande(lignes(pourAtteindre), { mode: 'delivery' });
check('Livraison sans adresse refusée', r.status === 400, `HTTP ${r.status}`);

r = await commande(lignes(pourAtteindre), { mode: 'delivery', contact: '12 rue des Lilas, Colmar' });
data = await r.json();
check('Frais de livraison ajoutés par le serveur',
  r.status === 201 && data.deliveryFee === FRAIS && data.total === data.subtotal + FRAIS,
  `${data.subtotal} + ${data.deliveryFee} = ${data.total}`);

/* ── Franco ──────────────────────────────────────────────── */

const pourFranco = Math.ceil(FRANCO / prix);
r = await commande(lignes(pourFranco), { mode: 'delivery', contact: '12 rue des Lilas, Colmar' });
data = await r.json();
check('Au-delà du franco, la livraison est offerte',
  r.status === 201 && data.deliveryFee === 0 && data.total === data.subtotal, `frais ${data.deliveryFee}`);

/* ── Un mode désactivé n'est pas utilisable ──────────────── */

await call('/api/admin/settings', { method: 'PUT', body: { fulfillment: { pickup: true, delivery: false } } });
r = await commande(lignes(pourAtteindre), { mode: 'delivery', contact: '12 rue des Lilas' });
check('Livraison coupée : le mode est refusé', r.status === 400, `HTTP ${r.status}`);

r = await call('/api/admin/settings', { method: 'PUT', body: { fulfillment: { pickup: false, delivery: false } } });
check('Impossible de tout couper', r.status === 400, `HTTP ${r.status}`);

/* ── Remise en état ──────────────────────────────────────── */

await call('/api/admin/settings', {
  method: 'PUT',
  body: {
    fulfillment: { pickup: true, delivery: false, deliveryFee: 0, freeDeliveryFrom: null, minimumOrder: 0 },
    limits: { ordersPerHour: 5, unitsPerOrder: 30 },
  },
});

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Retrait et livraison : OK'}`);
process.exit(failures ? 1 : 0);
