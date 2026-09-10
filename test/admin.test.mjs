/**
 * Tests de l'API d'administration.
 *
 * Prérequis : serveur démarré (`npm start`) avec ADMIN_IDS contenant 424242.
 * Usage :  node test/admin.test.mjs
 */
import crypto from 'node:crypto';
import 'dotenv/config';
import { getShopPass } from './helpers.mjs';

const TOKEN = process.env.BOT_TOKEN;
const BASE = process.env.TEST_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const ADMIN_ID = 424242;
const CLIENT_ID = 999001;

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

const admin = sign({ id: ADMIN_ID, first_name: 'Patron', username: 'patron' });
const client = sign({ id: CLIENT_ID, first_name: 'Client', username: 'client' });

async function call(path, { init = admin, method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(init ? { 'X-Telegram-Init-Data': init } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, data };
}

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

/* ── Contrôle d'accès ────────────────────────────────────── */
let r = await call('/api/admin/session', { init: null });
check('Admin : sans signature → 401', r.status === 401, `HTTP ${r.status}`);

r = await call('/api/admin/session', { init: client });
check('Admin : client non-admin → 403', r.status === 403, `HTTP ${r.status}`);

r = await call('/api/admin/session');
check('Admin : accès autorisé', r.status === 200 && r.data.user.id === ADMIN_ID, `HTTP ${r.status}`);

r = await call('/api/admin/products', { init: client, method: 'POST', body: { name: 'Pirate', price: 1 } });
check('Admin : écriture par un non-admin refusée', r.status === 403, `HTTP ${r.status}`);

/* ── Produits ────────────────────────────────────────────── */
r = await call('/api/admin/products', {
  method: 'POST',
  body: {
    name: 'Café Test Éclair',
    category: 'accessoires',
    price: 350,
    stock: 7,
    short: 'Produit de test',
    description: 'Créé par la suite de tests.',
  },
});
const created = r.data;
check('Produit créé', r.status === 201, `id = ${created?.id}`);
check("Identifiant dérivé du nom sans accent", created?.id === 'cafe-test-eclair', created?.id);

r = await call('/api/admin/products', { method: 'POST', body: { name: 'Café Test Éclair', price: 100 } });
check('Identifiant en double refusé', r.status === 409, `HTTP ${r.status}`);

r = await call('/api/admin/products', { method: 'POST', body: { name: '', price: 100 } });
check('Nom vide refusé', r.status === 400, `HTTP ${r.status}`);

r = await call(`/api/admin/products/${created.id}`, { method: 'PATCH', body: { price: 420, visible: false } });
check('Produit modifié', r.data?.price === 420 && r.data?.visible === false, `prix ${r.data?.price}`);

// un produit masqué ne doit plus apparaître dans la boutique publique
r = await fetch(`${BASE}/api/catalog`).then((x) => x.json());
check(
  'Produit masqué absent de la boutique',
  !r.products.some((p) => p.id === created.id),
  `${r.products.length} produits visibles`
);

/* ── Stock ───────────────────────────────────────────────── */
r = await call(`/api/admin/products/${created.id}/stock`, { method: 'POST', body: { quantity: 3 } });
check('Stock modifié', r.data?.stock === 3, `stock = ${r.data?.stock}`);

r = await call(`/api/admin/products/${created.id}/stock`, { method: 'POST', body: { quantity: -5 } });
check('Stock négatif ramené à 0', r.data?.stock === 0, `stock = ${r.data?.stock}`);

r = await call('/api/admin/products/kartoon-kush/stock', { method: 'POST', body: { quantity: 5 } });
check('Stock global refusé sur un produit à variantes', r.status === 400, `HTTP ${r.status}`);

r = await call('/api/admin/products/kartoon-kush/stock', { method: 'POST', body: { variantId: '5g', quantity: 2 } });
const kush = r.data;
check('Stock de variante modifié', kush?.variants.find((v) => v.id === '5g').stock === 2);

/* ── Rupture de stock à la commande ──────────────────────── */
const clientPass = await getShopPass(BASE, client);

const order = (items) =>
  fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': client,
      'X-Shop-Pass': clientPass,
    },
    body: JSON.stringify({ items }),
  }).then(async (res) => ({ status: res.status, data: await res.json().catch(() => null) }));

r = await order([{ id: 'kartoon-kush', variantId: '5g', quantity: 5 }]);
check('Commande au-delà du stock refusée', r.status === 409, `HTTP ${r.status}`);

const revenueBefore = (await call('/api/admin/stats')).data.revenue;

r = await order([{ id: 'kartoon-kush', variantId: '5g', quantity: 2 }]);
const placed = r.data;
check('Commande dans le stock acceptée', r.status === 201, placed?.reference);

r = await call('/api/admin/catalog');
const after = r.data.products.find((p) => p.id === 'kartoon-kush').variants.find((v) => v.id === '5g');
check('Stock décrémenté après commande', after.stock === 0, `stock = ${after.stock}`);

r = await order([{ id: 'kartoon-kush', variantId: '5g', quantity: 1 }]);
check('Article épuisé non commandable', r.status === 409, `HTTP ${r.status}`);

/* ── Statuts de commande ─────────────────────────────────── */
r = await call(`/api/admin/orders/${placed.reference}/status`, { method: 'POST', body: { status: 'livree' } });
check('Transition illégale refusée (nouvelle → livrée)', r.status === 400, `HTTP ${r.status}`);

r = await call(`/api/admin/orders/${placed.reference}/status`, { method: 'POST', body: { status: 'confirmee' } });
check('Transition légale acceptée', r.data?.status === 'confirmee', r.data?.status);

r = await call(`/api/admin/orders/${placed.reference}/status`, { method: 'POST', body: { status: 'annulee' } });
check('Annulation acceptée', r.data?.status === 'annulee', r.data?.status);

r = await call('/api/admin/catalog');
const restored = r.data.products.find((p) => p.id === 'kartoon-kush').variants.find((v) => v.id === '5g');
check('Stock remis en rayon après annulation', restored.stock === 2, `stock = ${restored.stock}`);

r = await call(`/api/admin/orders/${placed.reference}/status`, { method: 'POST', body: { status: 'confirmee' } });
check('Commande annulée non réactivable', r.status === 400, `HTTP ${r.status}`);

/* ── Statistiques ────────────────────────────────────────── */
r = await call('/api/admin/stats');
check('Statistiques disponibles', typeof r.data?.revenue === 'number', `CA = ${r.data?.revenue}`);
check(
  "Commande annulée exclue du chiffre d'affaires",
  r.data.revenue === revenueBefore,
  `CA ${revenueBefore} → ${r.data.revenue}`
);

/* ── Nettoyage ───────────────────────────────────────────── */
r = await call(`/api/admin/products/${created.id}`, { method: 'DELETE' });
check('Produit supprimé', r.status === 204, `HTTP ${r.status}`);

r = await call(`/api/admin/products/${created.id}`, { method: 'PATCH', body: { name: 'x' } });
check('Produit supprimé introuvable', r.status === 404, `HTTP ${r.status}`);

await call('/api/admin/products/kartoon-kush/stock', { method: 'POST', body: { variantId: '5g', quantity: 12 } });

/* ── Rapport ─────────────────────────────────────────────── */
for (const { name, pass, detail } of results) {
  console.log(`${pass ? 'OK   ' : 'ECHEC'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const failed = results.filter((x) => !x.pass).length;
console.log(`\n${results.length - failed}/${results.length} tests passés`);
process.exit(failed ? 1 : 0);
