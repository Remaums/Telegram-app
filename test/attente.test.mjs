/**
 * Alertes de stock : le vendeur prévenu quand ça descend, le client prévenu
 * quand ça revient.
 *
 * Les messages Telegram ne sont pas joignables depuis les tests. Ce qui se
 * vérifie ici, c'est la mécanique : qui a le droit de s'inscrire, quand la
 * liste se vide, et qu'un réassort ne prévient qu'au franchissement de zéro.
 *
 * Prérequis : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/attente.test.mjs
 */
import 'dotenv/config';
import { signInitData, resetShop } from './helpers.mjs';

const TOKEN = process.env.BOT_TOKEN;
const BASE = process.env.TEST_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

if (!TOKEN) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer les tests.');
  process.exit(1);
}

const admin = signInitData(TOKEN, { id: 424242, first_name: 'Patron' });

// Le décor de départ, posé par cette suite plutôt que hérité de la
// précédente : sans ça, l'ordre du package.json devient un piège.
await resetShop(BASE, admin, { features: { waitlist: true, captcha: false } });
const client = signInitData(TOKEN, { id: 870001, first_name: 'Client' });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const call = (path, { method = 'GET', body, init = admin } = {}) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': init },
    body: body ? JSON.stringify(body) : undefined,
  });

/* ── Un article disponible ne se met pas en attente ──────── */

const catalog = await (await fetch(`${BASE}/api/catalog`)).json();
const product = catalog.products.find((p) => !p.variants);
await call(`/api/admin/products/${product.id}/stock`, { method: 'POST', body: { quantity: 5 } });

let r = await call('/api/waitlist', { method: 'POST', init: client, body: { id: product.id } });
check('Article disponible : inscription refusée', r.status === 400, `HTTP ${r.status}`);

/* ── Épuisé : l'inscription passe ────────────────────────── */

await call(`/api/admin/products/${product.id}/stock`, { method: 'POST', body: { quantity: 0 } });

r = await call('/api/waitlist', { method: 'POST', init: client, body: { id: product.id } });
let data = await r.json();
check('Article épuisé : inscription acceptée', r.status === 201 && data.waiting === 1, `HTTP ${r.status}`);

r = await call('/api/waitlist', { method: 'POST', init: client, body: { id: product.id } });
data = await r.json();
check('Deux inscriptions du même client ne comptent qu\'une fois', data.waiting === 1, `${data.waiting}`);

r = await call(`/api/waitlist?id=${product.id}`, { init: client });
check('Le client voit qu\'il est inscrit', (await r.json()).subscribed === true);

r = await call('/api/waitlist', { method: 'POST', init: client, body: { id: 'nimporte-quoi' } });
check('Produit inconnu refusé', r.status === 400, `HTTP ${r.status}`);

r = await fetch(`${BASE}/api/waitlist`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
check('Sans signature, pas d\'inscription', r.status === 401, `HTTP ${r.status}`);

/* ── Réassort : la liste est vidée ───────────────────────── */

await call(`/api/admin/products/${product.id}/stock`, { method: 'POST', body: { quantity: 4 } });

r = await call(`/api/waitlist?id=${product.id}`, { init: client });
check('Après réassort, la liste est vidée', (await r.json()).subscribed === false);

/* ── Une hausse sans franchissement ne réveille personne ── */

await call(`/api/admin/products/${product.id}/stock`, { method: 'POST', body: { quantity: 0 } });
await call('/api/waitlist', { method: 'POST', init: client, body: { id: product.id } });
await call(`/api/admin/products/${product.id}/stock`, { method: 'POST', body: { quantity: 0 } });

r = await call(`/api/waitlist?id=${product.id}`, { init: client });
check('Toujours à zéro : le client reste en attente', (await r.json()).subscribed === true);

/* ── Le seuil d'alerte est réglable ──────────────────────── */

r = await call('/api/admin/settings', { method: 'PUT', body: { alerts: { lowStock: 7 } } });
check('Seuil d\'alerte enregistré', (await r.json()).alerts?.lowStock === 7);

r = await call('/api/admin/settings', { method: 'PUT', body: { alerts: { lowStock: -5 } } });
check('Seuil négatif ramené dans les bornes', (await r.json()).alerts?.lowStock === 0);

await call('/api/admin/settings', { method: 'PUT', body: { alerts: { lowStock: 3 } } });
await call(`/api/admin/products/${product.id}/stock`, { method: 'POST', body: { quantity: 12 } });

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Alertes de stock : OK'}`);
process.exit(failures ? 1 : 0);
