/**
 * Test de concurrence : plusieurs clients visent le dernier article.
 *
 * C'est ce que le magasin doit garantir des deux côtés — fichier JSON en
 * local, Postgres en ligne (verrou de ligne le temps de la transaction) :
 * une seule commande passe, jamais de survente.
 *
 * Prérequis : serveur démarré (`npm start`) avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/concurrence.test.mjs
 */
import crypto from 'node:crypto';
import 'dotenv/config';

const TOKEN = process.env.BOT_TOKEN;
const BASE = process.env.TEST_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const ADMIN_ID = 424242;
const PRODUCT = 'kartoon-kush';
const VARIANT = '5g';
const CLIENTS = 5;

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

const setStock = (quantity) =>
  fetch(`${BASE}/api/admin/products/${PRODUCT}/stock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': admin },
    body: JSON.stringify({ variantId: VARIANT, quantity }),
  });

const buy = (n) =>
  fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': sign({ id: 900000 + n, first_name: `Client${n}` }),
    },
    body: JSON.stringify({ items: [{ id: PRODUCT, variantId: VARIANT, quantity: 1 }] }),
  }).then((res) => res.status);

const remainingStock = async () => {
  const catalog = await (await fetch(`${BASE}/api/catalog`)).json();
  const product = catalog.products.find((p) => p.id === PRODUCT);
  return product.variants.find((v) => v.id === VARIANT).stock;
};

/* ── Une seule unité en rayon, cinq acheteurs simultanés ─── */

await setStock(1);
const codes = await Promise.all(Array.from({ length: CLIENTS }, (_, i) => buy(i + 1)));
const accepted = codes.filter((c) => c === 201).length;
const refused = codes.filter((c) => c === 409).length;

check('Une seule commande acceptée', accepted === 1, `codes : ${codes.join(' ')}`);
check('Les autres reçoivent un conflit de stock', refused === CLIENTS - 1, `${refused}/${CLIENTS - 1}`);
check('Stock à zéro, aucune survente', (await remainingStock()) === 0);

await setStock(12); // on remet le rayon comme on l'a trouvé

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Concurrence : aucun survendu'}`);
process.exit(failures ? 1 : 0);
