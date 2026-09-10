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

/* ── L'adresse complète ──────────────────────────────────── */

// Une ligne libre laissait passer « chez Marc » : cinq caractères, aucune
// ville, et un livreur qui rappelle. L'adresse arrive donc découpée, et ce qui
// manque est nommé.

const { normalizeAddress, adresseIncomplete, liensItineraire } = await import('../server/delivery.js');

check('Une adresse recopiée est nettoyée',
  normalizeAddress({ street: '  12   rue des\n Lilas ', city: ' Mulhouse ', postalCode: ' 68100 ' }).street
    === '12 rue des Lilas');

for (const [quoi, adresse] of [
  ['sans rue', { postalCode: '68100', city: 'Mulhouse' }],
  ['une rue trop courte', { street: 'chez', postalCode: '68100', city: 'Mulhouse' }],
  ['sans code postal', { street: '12 rue des Lilas', city: 'Mulhouse' }],
  ['un code postal inventé', { street: '12 rue des Lilas', postalCode: 'ABCDE', city: 'Mulhouse' }],
  ['sans ville', { street: '12 rue des Lilas', postalCode: '68100' }],
]) {
  check(`Refusée : ${quoi}`, Boolean(adresseIncomplete(normalizeAddress(adresse))),
    adresseIncomplete(normalizeAddress(adresse)) ?? 'acceptée !');
}

// Un lieu-dit n'a pas de numéro de rue : lui refuser sa commande coûterait
// plus cher qu'une adresse imprécise.
check("Un lieu-dit sans numéro passe",
  adresseIncomplete(normalizeAddress({ street: 'Lieu-dit Les Trois Épis', postalCode: '68410', city: 'Ammerschwihr' })) === null);

check("Une adresse incomplète n'a pas d'itinéraire",
  liensItineraire(normalizeAddress({ street: '12 rue des Lilas' })) === null);

const complete = { street: '12 rue des Lilas', complement: 'Bât B, 3e étage', postalCode: '68100', city: 'Mulhouse' };

r = await commande(lignes(pourAtteindre), { mode: 'delivery', address: { ...complete, city: '' } });
data = await r.json();
check('Une adresse sans ville est refusée', r.status === 400 && /ville/i.test(data.error), data.error);

r = await commande(lignes(pourAtteindre), { mode: 'delivery', address: { ...complete, postalCode: 'nawak' } });
data = await r.json();
check('Un code postal inventé aussi', r.status === 400 && /postal/i.test(data.error), data.error);

r = await commande(lignes(pourAtteindre), {
  mode: 'delivery', address: complete, contact: '06 12 34 56 78',
});
data = await r.json();
check('Une adresse complète passe', r.status === 201, `HTTP ${r.status} — ${data.error ?? ''}`);
check("Et la commande la garde découpée",
  data.address?.street === complete.street && data.address?.city === 'Mulhouse'
    && data.address?.complement === 'Bât B, 3e étage',
  JSON.stringify(data.address));
check('Le téléphone est rangé à part', data.phone === '06 12 34 56 78', data.phone);
check('Une ligne lisible reste disponible',
  /12 rue des Lilas/.test(data.contact ?? '') && /68100 Mulhouse/.test(data.contact ?? ''), data.contact);

// Le code postal de l'adresse fait foi : deux champs pour la même chose se
// contrediraient un jour, et c'est celui-là que le client vient d'écrire.
await call('/api/admin/settings', {
  method: 'PUT',
  body: { features: { zones: true }, zones: [{ name: 'Mulhouse', postalCodes: '68100', fee: 0 }] },
});

r = await commande(lignes(pourAtteindre), {
  mode: 'delivery', address: { ...complete, postalCode: '75001', city: 'Paris' },
});
data = await r.json();
check("Une adresse hors zone est refusée sur son propre code postal",
  r.status === 400 && /75001/.test(data.error ?? ''), data.error);

r = await commande(lignes(pourAtteindre), { mode: 'delivery', address: complete });
data = await r.json();
check('Une adresse dans la zone passe', r.status === 201, `HTTP ${r.status} — ${data.error ?? ''}`);
check('Et la zone retenue porte ce code postal', data.zone?.postalCode === '68100', JSON.stringify(data.zone));

await call('/api/admin/settings', { method: 'PUT', body: { features: { zones: false }, zones: [] } });

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
