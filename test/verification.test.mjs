/**
 * Vérification d'identité.
 *
 * Deux choses comptent ici : que la boutique reste fermée tant que le verdict
 * n'est pas rendu, et qu'on ne conserve rien d'autre que ce verdict — pas de
 * document, pas de référence vers le fichier Telegram.
 *
 * Prérequis : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/verification.test.mjs
 */
import 'dotenv/config';
import { signInitData, getShopPass } from './helpers.mjs';

const TOKEN = process.env.BOT_TOKEN;
const BASE = process.env.TEST_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

if (!TOKEN) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer les tests.');
  process.exit(1);
}

const sign = (user) => signInitData(TOKEN, user);
const admin = sign({ id: 424242, first_name: 'Patron' });
const CLIENT_ID = 830001;
const client = sign({ id: CLIENT_ID, first_name: 'Client' });

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

/* ── Préparation ─────────────────────────────────────────── */

const catalog = await (await fetch(`${BASE}/api/catalog`)).json();
const product = catalog.products.find((p) => !p.variants && p.stock > 0);
await call(`/api/admin/products/${product.id}/stock`, { method: 'POST', body: { quantity: 100 } });
const panier = [{ id: product.id, quantity: 1 }];
const pass = await getShopPass(BASE, client);

await call('/api/admin/settings', { method: 'PUT', body: { verification: { enabled: true } } });
await call(`/api/admin/verifications/${CLIENT_ID}`, { method: 'POST', body: { status: 'none' } });

/* ── Porte fermée tant qu'il n'y a pas de verdict ────────── */

let r = await call('/api/orders', { method: 'POST', init: client, body: { items: panier }, pass });
let data = await r.json().catch(() => ({}));
check('Commande refusée sans vérification', r.status === 403 && data.error === 'VERIFICATION_REQUISE', `HTTP ${r.status}`);

r = await call('/api/me', { init: client });
data = await r.json();
check('Le client connaît son état', data.verification?.required === true && data.verification?.status === 'none',
  `${data.verification?.status}`);

/* ── En attente : toujours fermé ─────────────────────────── */

await call(`/api/admin/verifications/${CLIENT_ID}`, { method: 'POST', body: { status: 'pending' } });
r = await call('/api/orders', { method: 'POST', init: client, body: { items: panier }, pass });
check('En attente, la commande reste refusée', r.status === 403, `HTTP ${r.status}`);

/* ── Refusé, puis validé ─────────────────────────────────── */

await call(`/api/admin/verifications/${CLIENT_ID}`, { method: 'POST', body: { status: 'refused' } });
r = await call('/api/orders', { method: 'POST', init: client, body: { items: panier }, pass });
check('Refusé, la commande est refusée', r.status === 403, `HTTP ${r.status}`);

r = await call(`/api/admin/verifications/${CLIENT_ID}`, { method: 'POST', body: { status: 'approved' } });
const record = await r.json();
check('Verdict enregistré avec sa date et son auteur',
  record.status === 'approved' && Boolean(record.decidedAt) && record.decidedBy === '424242');

check('Aucun document ni référence conservés',
  !JSON.stringify(record).match(/file_id|file_unique_id|photo|document/i),
  Object.keys(record).join(', '));

r = await call('/api/orders', { method: 'POST', init: client, body: { items: panier }, pass });
check('Validé, la commande passe', r.status === 201, `HTTP ${r.status}`);

/* ── Le client ne se valide pas lui-même ─────────────────── */

r = await call(`/api/admin/verifications/${CLIENT_ID}`, { method: 'POST', init: client, body: { status: 'approved' } });
check('Un client ne peut pas se valider', r.status === 403, `HTTP ${r.status}`);

/* ── Désactivée, la porte s'efface ───────────────────────── */

await call('/api/admin/settings', { method: 'PUT', body: { verification: { enabled: false } } });
const autre = sign({ id: 830002, first_name: 'Autre' });
r = await call('/api/orders', {
  method: 'POST', init: autre, body: { items: panier }, pass: await getShopPass(BASE, autre),
});
check('Vérification désactivée : la commande passe', r.status === 201, `HTTP ${r.status}`);

console.log(`\n${failures ? `${failures} test(s) en échec` : "Vérification d'identité : OK"}`);
process.exit(failures ? 1 : 0);
