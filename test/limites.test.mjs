/**
 * Garde-fous contre les abus.
 *
 * Un client authentifié reste un inconnu : rien ne l'empêchait d'enchaîner
 * les commandes en boucle pour vider le stock, ni d'en passer une de mille
 * articles. Ce test vérifie les trois barrières et, surtout, qu'elles
 * n'empêchent pas une commande normale.
 *
 * Prérequis : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/limites.test.mjs
 */
import crypto from 'node:crypto';
import 'dotenv/config';
import { getShopPass } from './helpers.mjs';

const TOKEN = process.env.BOT_TOKEN;
const BASE = process.env.TEST_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const ADMIN_ID = 424242;

if (!TOKEN) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer les tests.');
  process.exit(1);
}

function sign(user) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify(user),
  });
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

const admin = sign({ id: ADMIN_ID, first_name: 'Patron' });

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

const api = (path, { method = 'GET', body, init = admin } = {}) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': init },
    body: body ? JSON.stringify(body) : undefined,
  });

/** Commande en franchissant d'abord l'épreuve d'entrée. */
async function buy(init, items) {
  const pass = await getShopPass(BASE, init);
  return fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': init,
      'X-Shop-Pass': pass,
    },
    body: JSON.stringify({ items }),
  });
}

/* ── Préparation : un produit avec du stock ──────────────── */

const catalog = await (await fetch(`${BASE}/api/catalog`)).json();
const product = catalog.products.find((p) => !p.variants && p.stock > 0);
await api(`/api/admin/products/${product.id}/stock`, { method: 'POST', body: { quantity: 200 } });

const settingsBefore = await (await api('/api/admin/settings')).json();
check('Réglages lisibles', typeof settingsBefore.limits?.ordersPerHour === 'number',
  `${settingsBefore.limits?.ordersPerHour} commandes/h`);

/* ── Plafond d'articles par commande ─────────────────────── */

await api('/api/admin/settings', { method: 'PUT', body: { limits: { ordersPerHour: 3, unitsPerOrder: 5 } } });

let r = await buy(sign({ id: 700001, first_name: 'Gros' }), [{ id: product.id, quantity: 6 }]);
check('Commande au-delà du plafond refusée', r.status === 400, `HTTP ${r.status}`);

r = await buy(sign({ id: 700001, first_name: 'Gros' }), [{ id: product.id, quantity: 5 }]);
check('Commande au plafond acceptée', r.status === 201, `HTTP ${r.status}`);

/* ── Fréquence ───────────────────────────────────────────── */

const spammeur = sign({ id: 700002, first_name: 'Robot' });
const codes = [];
for (let i = 0; i < 4; i++) {
  codes.push((await buy(spammeur, [{ id: product.id, quantity: 1 }])).status);
}
check('Trois commandes passent, la quatrième est refusée',
  codes.filter((c) => c === 201).length === 3 && codes[3] === 429, codes.join(' '));

/* ── Client bloqué ───────────────────────────────────────── */

const banni = { id: 700003, first_name: 'Banni' };
r = await api(`/api/admin/clients/${banni.id}/block`, { method: 'POST' });
check('Client bloqué depuis l\'admin', r.status === 200);

r = await buy(sign(banni), [{ id: product.id, quantity: 1 }]);
check('Un client bloqué ne peut plus commander', r.status === 403, `HTTP ${r.status}`);

r = await api(`/api/admin/clients/${banni.id}/unblock`, { method: 'POST' });
r = await buy(sign(banni), [{ id: product.id, quantity: 1 }]);
check('Débloqué, il commande à nouveau', r.status === 201, `HTTP ${r.status}`);

/* ── Un non-admin ne touche pas aux réglages ─────────────── */

r = await api('/api/admin/settings', { method: 'PUT', init: sign({ id: 700004, first_name: 'Curieux' }), body: { limits: { ordersPerHour: 999 } } });
check('Réglages inaccessibles à un non-admin', r.status === 403, `HTTP ${r.status}`);

/* ── Remise en état ──────────────────────────────────────── */

await api('/api/admin/settings', { method: 'PUT', body: { limits: settingsBefore.limits, blocked: [] } });

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Garde-fous : OK'}`);
process.exit(failures ? 1 : 0);
