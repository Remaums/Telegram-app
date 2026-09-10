/**
 * Épreuve d'entrée.
 *
 * Le point sensible n'est pas l'écran : c'est que le serveur exige le
 * laissez-passer au moment de commander. Sans ça, sauter l'écran suffirait.
 *
 * Prérequis : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/captcha.test.mjs
 */
import crypto from 'node:crypto';
import 'dotenv/config';
import { resetShop } from './helpers.mjs';

const TOKEN = process.env.BOT_TOKEN;
const BASE = process.env.TEST_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

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

const admin = sign({ id: 424242, first_name: 'Patron' });

// Le décor de départ, posé par cette suite plutôt que hérité de la
// précédente : sans ça, l'ordre du package.json devient un piège.
await resetShop(BASE, admin, { features: { captcha: true } });
const client = sign({ id: 810001, first_name: 'Client' });
const autre = sign({ id: 810002, first_name: 'Autre' });

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

await call('/api/admin/settings', { method: 'PUT', body: { captcha: { enabled: true } } });
const catalog = await (await fetch(`${BASE}/api/catalog`)).json();
check('Le catalogue annonce la porte', catalog.gates?.captcha === true);

const product = catalog.products.find((p) => !p.variants && p.stock > 0);
await call(`/api/admin/products/${product.id}/stock`, { method: 'POST', body: { quantity: 100 } });
const panier = [{ id: product.id, quantity: 1 }];

/* ── Sans laissez-passer, pas de commande ────────────────── */

let r = await call('/api/orders', { method: 'POST', init: client, body: { items: panier } });
let data = await r.json().catch(() => ({}));
check('Commande sans épreuve refusée', r.status === 403 && data.error === 'CAPTCHA_REQUIS', `HTTP ${r.status}`);

/* ── L'épreuve, résolue puis rejouée ─────────────────────── */

const challenge = await (await call('/api/captcha', { init: client })).json();
check('Grille servie', Array.isArray(challenge.tiles) && challenge.tiles.length === 9);

const cibles = challenge.tiles.map((t, i) => (t === '🍁' ? i : -1)).filter((i) => i >= 0);

r = await call('/api/captcha', { method: 'POST', init: client, body: { ...challenge, selection: [] } });
check('Réponse vide refusée', r.status === 400, `HTTP ${r.status}`);

const fausse = [...Array(9).keys()].filter((i) => !cibles.includes(i)).slice(0, 3);
r = await call('/api/captcha', { method: 'POST', init: client, body: { ...challenge, selection: fausse } });
check('Mauvaise réponse refusée', r.status === 400, `HTTP ${r.status}`);

r = await call('/api/captcha', { method: 'POST', init: client, body: { ...challenge, selection: cibles } });
const { pass } = await r.json();
check('Bonne réponse acceptée', r.status === 200 && typeof pass === 'string');

/* ── Le laissez-passer est nominatif ─────────────────────── */

r = await call('/api/orders', { method: 'POST', init: autre, body: { items: panier }, pass });
check('Laissez-passer inutilisable par un autre', r.status === 403, `HTTP ${r.status}`);

r = await call('/api/orders', { method: 'POST', init: client, body: { items: panier }, pass });
check('Commande acceptée avec le laissez-passer', r.status === 201, `HTTP ${r.status}`);

r = await call('/api/orders', { method: 'POST', init: client, body: { items: panier }, pass: '9999999999999.deadbeef' });
check('Laissez-passer forgé refusé', r.status === 403, `HTTP ${r.status}`);

/* ── Désactivée, la porte s'efface ───────────────────────── */

await call('/api/admin/settings', { method: 'PUT', body: { captcha: { enabled: false } } });
r = await call('/api/orders', { method: 'POST', init: autre, body: { items: panier } });
check('Épreuve désactivée : la commande passe', r.status === 201, `HTTP ${r.status}`);

await call('/api/admin/settings', { method: 'PUT', body: { captcha: { enabled: true } } });

console.log(`\n${failures ? `${failures} test(s) en échec` : "Épreuve d'entrée : OK"}`);
process.exit(failures ? 1 : 0);
