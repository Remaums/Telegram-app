/**
 * Export comptable, sauvegarde et restauration.
 *
 * Trois choses comptent ici. Que l'export soit lisible dans un tableur sans
 * le trahir — un point-virgule dans une note ne doit pas décaler les colonnes,
 * et une note commençant par « = » ne doit pas devenir une formule. Que la
 * sauvegarde ne transporte aucun secret : elle finira dans un dossier de
 * téléchargements. Et que la restauration remette exactement ce qu'elle a pris.
 *
 * Prérequis : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/sauvegarde.test.mjs
 */
import 'dotenv/config';
import { signInitData, resetShop, getShopPass } from './helpers.mjs';

const TOKEN = process.env.BOT_TOKEN;
const BASE = process.env.TEST_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

if (!TOKEN) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer les tests.');
  process.exit(1);
}

const admin = signInitData(TOKEN, { id: 424242, first_name: 'Patron' });
const souche = 600000 + (Date.now() % 300000);
const client = signInitData(TOKEN, { id: souche, first_name: 'Client' });

await resetShop(BASE, admin, { features: { captcha: false } });

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

/* ── Une commande qui piège le CSV ───────────────────────── */

const catalog = await (await fetch(`${BASE}/api/catalog`)).json();
const product = catalog.products.find((p) => !p.variants);
await call(`/api/admin/products/${product.id}/stock`, { method: 'POST', body: { quantity: 50 } });

const PIEGE = '=SOMME(A1:A9); "guillemets" ; point-virgule';
let r = await call('/api/orders', {
  method: 'POST', init: client,
  body: { items: [{ id: product.id, quantity: 2 }], mode: 'pickup', note: PIEGE },
});
check('Commande de référence créée', r.status === 201, `HTTP ${r.status}`);
const reference = (await r.json()).reference;

/* ── L'export ────────────────────────────────────────────── */

r = await call('/api/admin/export/orders.csv');
// Les octets bruts, pas le texte décodé : `response.text()` retire le BOM en
// silence, si bien qu'on le croirait absent alors qu'il part bien sur le fil.
const octets = new Uint8Array(await r.clone().arrayBuffer());
const csv = await r.text();
check('L\'export répond en CSV', r.headers.get('content-type')?.includes('text/csv'),
  r.headers.get('content-type'));
check('Il s\'ouvre en UTF-8 dans un tableur',
  octets[0] === 0xef && octets[1] === 0xbb && octets[2] === 0xbf,
  `premiers octets ${[...octets.slice(0, 3)].map((o) => o.toString(16)).join(' ')}`);
check('Le fichier porte un nom daté',
  /commandes-\d{4}-\d{2}-\d{2}\.csv/.test(r.headers.get('content-disposition') ?? ''),
  r.headers.get('content-disposition'));

const lignes = csv.split('\r\n').filter(Boolean);
check('L\'en-tête nomme les colonnes', lignes[0].includes('reference') && lignes[0].includes('total_commande'));

const ligne = lignes.find((l) => l.includes(reference));
check('La commande figure dans l\'export', Boolean(ligne), reference);
check('La note piégeuse est mise entre guillemets', ligne?.includes('"') === true);
check('Une formule est désamorcée', ligne?.includes("'=SOMME") === true,
  ligne?.slice(ligne.indexOf("'=") - 2, ligne.indexOf("'=") + 12));
check('Le nombre de colonnes est constant',
  new Set(lignes.map((l) => l.replace(/"[^"]*"/g, '').split(';').length)).size === 1,
  [...new Set(lignes.map((l) => l.replace(/"[^"]*"/g, '').split(';').length))].join('/'));
check('Les montants sortent à la française', /;\d+,\d{2};/.test(ligne ?? ''));

/* ── L'export sur une période ────────────────────────────── */

const demain = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
r = await call(`/api/admin/export/orders.csv?from=${demain}`);
const vide = (await r.text()).split('\r\n').filter(Boolean);
check('Une période sans commande ne rend que l\'en-tête', vide.length === 1, `${vide.length} ligne(s)`);

/* ── La sauvegarde ───────────────────────────────────────── */

r = await call('/api/admin/backup');
const backup = await r.json();
check('La sauvegarde annonce ce qu\'elle contient',
  backup.counts?.products > 0 && backup.counts?.orders > 0, JSON.stringify(backup.counts));
check('Elle porte un numéro de version', backup.version === 1, `${backup.version}`);

const brut = JSON.stringify(backup);
check('Aucun jeton de bot n\'en sort', !/\d{8,}:AA[\w-]{30,}/.test(brut));
check('Aucune adresse de base n\'en sort', !/postgres:\/\/|DATABASE_URL/.test(brut));
check('Aucune liste d\'administrateurs n\'en sort', !/adminIds/.test(brut));
check('Les commandes sont dans l\'ordre où elles sont arrivées',
  backup.orders.length < 2 ||
    backup.orders[0].createdAt <= backup.orders[backup.orders.length - 1].createdAt);

/* ── Ce qu'on refuse de restaurer ────────────────────────── */

for (const [label, corps] of [
  ['un objet vide', {}],
  ['une version inconnue', { version: 99, catalog: { products: [] }, orders: [] }],
  ['une sauvegarde sans catalogue', { version: 1, orders: [] }],
  ['un catalogue qui n\'en est pas un', { version: 1, catalog: 'x', orders: [] }],
  ['une sauvegarde sans commandes', { version: 1, catalog: { products: [] } }],
]) {
  r = await call('/api/admin/backup/inspect', { method: 'POST', body: corps });
  check(`Refusé : ${label}`, r.status === 400, `HTTP ${r.status}`);
}

/* ── L'aller-retour ──────────────────────────────────────── */

const jetable = await (await call('/api/admin/products', {
  method: 'POST',
  body: { name: 'Intrus', category: 'fleurs', price: 100, stock: 1, short: 'x' },
})).json();
await call('/api/admin/settings', { method: 'PUT', body: { fulfillment: { deliveryFee: 4242 } } });

const fait = await (await call('/api/admin/backup/restore', { method: 'POST', body: backup })).json();
check('La restauration rend son compte',
  fait.catalogue?.products === backup.counts.products, JSON.stringify(fait.catalogue));

const apres = await (await fetch(`${BASE}/api/catalog`)).json();
check('Le produit ajouté après la sauvegarde a disparu',
  !apres.products.some((p) => p.id === jetable.id));
check('Le réglage modifié est revenu', apres.fulfillment.deliveryFee === 0,
  `${apres.fulfillment.deliveryFee}`);

const relu = await (await call('/api/admin/backup')).json();
check('Toutes les commandes sont revenues',
  relu.counts.orders === backup.counts.orders, `${relu.counts.orders}/${backup.counts.orders}`);
check('Le catalogue est revenu entier',
  relu.counts.products === backup.counts.products, `${relu.counts.products}/${backup.counts.products}`);

/* ── Un compteur de code ne se remet pas à zéro ──────────── */

await call('/api/admin/promos/SAUVE', { method: 'DELETE' });
await call('/api/admin/promos', {
  method: 'PUT', body: { code: 'SAUVE', type: 'percent', value: 10, maxUses: 5, oncePerClient: false },
});
await call('/api/orders', {
  method: 'POST', init: client,
  body: { items: [{ id: product.id, quantity: 1 }], mode: 'pickup', promoCode: 'SAUVE' },
});

const avecCode = await (await call('/api/admin/backup')).json();
await call('/api/admin/backup/restore', { method: 'POST', body: avecCode });
const promo = (await (await call('/api/admin/promos')).json()).find((p) => p.code === 'SAUVE');
check('Restaurer ne rend pas un code déjà consommé', promo?.uses === 1, `uses ${promo?.uses}`);
await call('/api/admin/promos/SAUVE', { method: 'DELETE' });

/* ── Ce n'est pas ouvert à tout le monde ─────────────────── */

for (const route of ['/api/admin/backup', '/api/admin/export/orders.csv']) {
  r = await call(route, { init: client });
  check(`Un client n'accède pas à ${route.split('/').pop()}`, r.status === 403, `HTTP ${r.status}`);
}
r = await call('/api/admin/backup/restore', { method: 'POST', init: client, body: backup });
check('Un client ne restaure pas la boutique', r.status === 403, `HTTP ${r.status}`);

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Export et sauvegarde : OK'}`);
process.exit(failures ? 1 : 0);
