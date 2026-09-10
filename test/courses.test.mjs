/**
 * Courses : plusieurs commandes qui partent en même temps.
 *
 * Un contrôle qui lit d'abord et écrit ensuite n'en est pas un : entre les
 * deux, tout le monde passe. Cette suite envoie des rafales simultanées et
 * vérifie qu'aucun compteur ne déborde. Les identifiants de clients sont
 * tirés à chaque exécution : un quota déjà consommé par le passage précédent
 * rendrait le test complaisant.
 *
 * Prérequis : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/courses.test.mjs
 */
import 'dotenv/config';
import { signInitData } from './helpers.mjs';

const TOKEN = process.env.BOT_TOKEN;
const BASE = process.env.TEST_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

if (!TOKEN) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer les tests.');
  process.exit(1);
}

const admin = signInitData(TOKEN, { id: 424242, first_name: 'Patron' });
// Chaque exécution a ses propres clients : sinon le quota horaire d'hier
// ferait passer le test pour vert sans rien avoir vérifié.
const souche = 100000 + (Date.now() % 800000);
const clients = Array.from({ length: 8 }, (_, i) => signInitData(TOKEN, { id: souche + i, first_name: `R${i}` }));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const call = (path, { method = 'GET', body, init = admin } = {}) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': init },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const JOURS = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
const grille = (capacity) =>
  Object.fromEntries(JOURS.map((j) => [j, [{ from: '00:00', to: '23:59', capacity }]]));

/* ── Préparation ─────────────────────────────────────────── */

await call('/api/admin/settings', {
  method: 'PUT',
  body: {
    features: { ageGate: false, captcha: false, verification: false, hours: false, zones: false,
                slots: false, tiers: false, promos: true, waitlist: true, stockAlerts: false,
                limits: false, photos: true, orderHistory: true, clientNotifications: false },
    fulfillment: { pickup: true, delivery: false, deliveryFee: 0, freeDeliveryFrom: null, minimumOrder: 0 },
    limits: { ordersPerHour: 999, unitsPerOrder: 999 },
    zones: [], discounts: { tiers: [] },
    opening: { open: true },
  },
});

const catalog = await (await fetch(`${BASE}/api/catalog`)).json();
const product = catalog.products.find((p) => !p.variants);
const ligne = { items: [{ id: product.id, quantity: 1 }], mode: 'pickup' };
const commande = (init, extra = {}) =>
  call('/api/orders', { method: 'POST', init, body: { ...ligne, ...extra } });
const rafale = (extra = {}, qui = clients) => Promise.all(qui.map((c) => commande(c, extra)));

/* ── Le dernier article ──────────────────────────────────── */

await call(`/api/admin/products/${product.id}/stock`, { method: 'POST', body: { quantity: 3 } });
let reponses = await rafale();
let acceptees = reponses.filter((r) => r.status === 201).length;
check('Trois en stock, trois commandes servies sur huit', acceptees === 3,
  reponses.map((r) => r.status).join(' '));

let apres = (await (await fetch(`${BASE}/api/catalog`)).json()).products.find((p) => p.id === product.id);
check('Le stock touche zéro sans passer dessous', apres.stock === 0, `stock ${apres.stock}`);

/* ── Le créneau ──────────────────────────────────────────── */

await call(`/api/admin/products/${product.id}/stock`, { method: 'POST', body: { quantity: 900 } });
await call('/api/admin/settings', {
  method: 'PUT',
  body: { features: { slots: true }, slots: { leadMinutes: 0, daysAhead: 2, days: grille(500) } },
});

// La capacité est resserrée sur deux places de plus que ce qui est déjà pris :
// le test vaut donc aussi sur un magasin qui a déjà servi.
let dispo = await (await fetch(`${BASE}/api/slots`)).json();
const creneau = dispo.slots[0];
const jourDu = JOURS[new Date(`${creneau.date}T12:00:00Z`).getUTCDay()];
const dejaPris = 500 - creneau.left;
await call('/api/admin/settings', {
  method: 'PUT',
  body: {
    slots: {
      leadMinutes: 0, daysAhead: 2,
      days: { ...grille(500), [jourDu]: [{ from: '00:00', to: '23:59', capacity: dejaPris + 2 }] },
    },
  },
});

reponses = await rafale({ slotId: creneau.id });
acceptees = reponses.filter((r) => r.status === 201).length;
check('Deux places, deux commandes servies sur huit', acceptees === 2,
  reponses.map((r) => r.status).join(' '));

dispo = await (await fetch(`${BASE}/api/slots`)).json();
check('Le créneau ne se surbooke pas',
  dispo.slots.find((s) => s.id === creneau.id)?.left === 0,
  JSON.stringify(dispo.slots.find((s) => s.id === creneau.id)));

await call('/api/admin/settings', { method: 'PUT', body: { features: { slots: false } } });

/* ── Le code à usage unique ──────────────────────────────── */

await call('/api/admin/promos/COURSE', { method: 'DELETE' });
await call('/api/admin/promos', {
  method: 'PUT',
  body: { code: 'COURSE', type: 'percent', value: 50, maxUses: 1, oncePerClient: false },
});

reponses = await rafale({ promoCode: 'COURSE' });
let corps = await Promise.all(reponses.map((r) => r.json().catch(() => ({}))));
check('Un code « une seule fois » ne sert qu\'une fois',
  corps.filter((d) => d.promoCode === 'COURSE').length === 1,
  reponses.map((r) => r.status).join(' '));

let promo = (await (await call('/api/admin/promos')).json()).find((p) => p.code === 'COURSE');
check('Son compteur ne dépasse pas son quota', promo.uses === 1, `${promo.uses}/${promo.maxUses}`);
await call('/api/admin/promos/COURSE', { method: 'DELETE' });

/* ── Le code une-fois-par-client ─────────────────────────── */

await call('/api/admin/promos/PERSO', { method: 'DELETE' });
await call('/api/admin/promos', {
  method: 'PUT',
  body: { code: 'PERSO', type: 'percent', value: 20, oncePerClient: true },
});

const seul = clients[0];
reponses = await Promise.all(Array.from({ length: 8 }, () => commande(seul, { promoCode: 'PERSO' })));
corps = await Promise.all(reponses.map((r) => r.json().catch(() => ({}))));
check('« Une fois par client » tient face à une rafale du même client',
  corps.filter((d) => d.promoCode === 'PERSO').length === 1,
  reponses.map((r) => r.status).join(' '));
await call('/api/admin/promos/PERSO', { method: 'DELETE' });

/* ── Un code rendu quand la commande échoue ──────────────── */

await call('/api/admin/promos/RENDU', { method: 'DELETE' });
await call('/api/admin/promos', {
  method: 'PUT',
  body: { code: 'RENDU', type: 'percent', value: 30, maxUses: 5, oncePerClient: false },
});
await call(`/api/admin/products/${product.id}/stock`, { method: 'POST', body: { quantity: 0 } });

const r = await commande(clients[1], { promoCode: 'RENDU' });
check('Stock envolé : la commande est refusée', r.status === 409, `HTTP ${r.status}`);
promo = (await (await call('/api/admin/promos')).json()).find((p) => p.code === 'RENDU');
check('Le code n\'est pas grillé par une commande qui n\'a pas eu lieu', promo.uses === 0, `uses ${promo.uses}`);
await call('/api/admin/promos/RENDU', { method: 'DELETE' });

/* ── Le plafond horaire ──────────────────────────────────── */

await call(`/api/admin/products/${product.id}/stock`, { method: 'POST', body: { quantity: 900 } });
await call('/api/admin/settings', {
  method: 'PUT',
  body: { features: { limits: true }, limits: { ordersPerHour: 3, unitsPerOrder: 999 } },
});

const pressé = signInitData(TOKEN, { id: souche + 50, first_name: 'Presse' });
reponses = await Promise.all(Array.from({ length: 10 }, () => commande(pressé)));
acceptees = reponses.filter((r) => r.status === 201).length;
check('Le plafond horaire tient en rafale', acceptees === 3, reponses.map((r) => r.status).join(' '));

/* ── Remise en état ──────────────────────────────────────── */

await call('/api/admin/settings', {
  method: 'PUT',
  body: {
    features: { captcha: true, ageGate: true, limits: true, slots: false },
    limits: { ordersPerHour: 5, unitsPerOrder: 30 },
    slots: { enabled: false, leadMinutes: 60, daysAhead: 7, days: {} },
  },
});

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Courses simultanées : OK'}`);
process.exit(failures ? 1 : 0);
