/**
 * Ouverture de la boutique.
 *
 * Le bandeau côté client ne suffit pas : on peut garder la Mini App ouverte
 * et valider son panier après la fermeture. C'est donc le serveur qui refuse.
 *
 * Prérequis : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/ouverture.test.mjs
 */
import 'dotenv/config';
import { signInitData, getShopPass } from './helpers.mjs';
import { isOpenNow, defaultHours } from '../server/opening.js';

const TOKEN = process.env.BOT_TOKEN;
const BASE = process.env.TEST_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

if (!TOKEN) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer les tests.');
  process.exit(1);
}

const admin = signInitData(TOKEN, { id: 424242, first_name: 'Patron' });
const client = signInitData(TOKEN, { id: 840001, first_name: 'Client' });

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

/* ── Le calcul des horaires, sans serveur ────────────────── */

const jours = defaultHours();
const paris = (days) => ({ open: true, hours: { enabled: true, timezone: 'Europe/Paris', days } });
const at = (iso) => new Date(iso);

check('Ouvert dans le créneau', isOpenNow(paris(jours), at('2026-09-15T12:00:00Z')).open);
check('Fermé avant le créneau', !isOpenNow(paris(jours), at('2026-09-15T07:00:00Z')).open);
check('Jour marqué fermé', !isOpenNow(paris({ ...jours, mar: { closed: true } }), at('2026-09-15T12:00:00Z')).open);

const nuit = { ...jours, mar: { closed: false, from: '22:00', to: '02:00' }, mer: { closed: true } };
check('Créneau de nuit, avant minuit', isOpenNow(paris(nuit), at('2026-09-15T21:00:00Z')).open);
check('Créneau de nuit, après minuit', isOpenNow(paris(nuit), at('2026-09-15T23:00:00Z')).open, "horaire de la veille");
check('Créneau de nuit terminé', !isOpenNow(paris(nuit), at('2026-09-16T01:00:00Z')).open);
check("L'interrupteur prime sur les horaires",
  !isOpenNow({ ...paris(jours), open: false }, at('2026-09-15T12:00:00Z')).open);

/* ── Et sur le serveur ───────────────────────────────────── */

const catalog = await (await fetch(`${BASE}/api/catalog`)).json();
const product = catalog.products.find((p) => !p.variants && p.stock > 0);
await call(`/api/admin/products/${product.id}/stock`, { method: 'POST', body: { quantity: 50 } });
const panier = [{ id: product.id, quantity: 1 }];
const pass = await getShopPass(BASE, client);

const MESSAGE = 'On revient à 10 h, promis.';
await call('/api/admin/settings', { method: 'PUT', body: { opening: { open: false, message: MESSAGE } } });

let r = await fetch(`${BASE}/api/catalog`).then((x) => x.json());
check('Le catalogue annonce la fermeture', r.opening?.open === false && r.opening?.message === MESSAGE);

r = await call('/api/orders', { method: 'POST', init: client, body: { items: panier }, pass });
const data = await r.json().catch(() => ({}));
check('Commande refusée boutique fermée', r.status === 503 && data.error === MESSAGE, `HTTP ${r.status}`);

await call('/api/admin/settings', { method: 'PUT', body: { opening: { open: true } } });
r = await call('/api/orders', { method: 'POST', init: client, body: { items: panier }, pass });
check('Rouverte, la commande passe', r.status === 201, `HTTP ${r.status}`);

/* ── Un fuseau farfelu ne doit pas tout casser ───────────── */

r = await call('/api/admin/settings', {
  method: 'PUT',
  body: { opening: { hours: { enabled: true, timezone: 'Nawak/Nimporte', days: jours } } },
});
const saved = await r.json();
check('Fuseau invalide remplacé par le précédent', saved.opening.hours.timezone === 'Europe/Paris',
  saved.opening.hours.timezone);

await call('/api/admin/settings', { method: 'PUT', body: { opening: { open: true, hours: { enabled: false, timezone: 'Europe/Paris', days: jours } } } });

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Ouverture : OK'}`);
process.exit(failures ? 1 : 0);
