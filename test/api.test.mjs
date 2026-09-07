/**
 * Tests de l'API commandes.
 *
 * Prérequis : le serveur doit tourner (`npm start`) avec le même BOT_TOKEN.
 * Usage :  BOT_TOKEN=... node test/api.test.mjs
 */
import crypto from 'node:crypto';
import 'dotenv/config';

const TOKEN = process.env.BOT_TOKEN;
const BASE = process.env.TEST_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

if (!TOKEN) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer les tests.');
  process.exit(1);
}

function signInitData(user, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify(user) });
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

const post = (init, body) =>
  fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(init ? { 'X-Telegram-Init-Data': init } : {}) },
    body: JSON.stringify(body),
  });

const user = { id: 424242, first_name: 'Test', username: 'client_test' };
const valid = signInitData(user);
const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

// 1. sans signature
let r = await post(null, { items: [{ id: 'kartoon-kush', quantity: 1 }] });
check('Requête non signée rejetée', r.status === 401, `HTTP ${r.status}`);

// 2. signature bidon
r = await post('auth_date=1&user=%7B%22id%22%3A1%7D&hash=deadbeef', { items: [{ id: 'kartoon-kush', quantity: 1 }] });
check('Signature forgée rejetée', r.status === 401, `HTTP ${r.status}`);

// 3. signature périmée (2 jours)
r = await post(signInitData(user, Math.floor(Date.now() / 1000) - 172800), { items: [{ id: 'kartoon-kush', quantity: 1 }] });
check('Signature expirée rejetée', r.status === 401, `HTTP ${r.status}`);

// 4. commande valide, avec un prix client falsifié à 1 centime
r = await post(valid, {
  items: [{ id: 'kartoon-kush', variantId: '5g', quantity: 2, unitPrice: 1, lineTotal: 1 }],
  note: 'test',
});
let body = await r.json();
check('Commande valide acceptée', r.status === 201, `HTTP ${r.status}`);
check('Prix client falsifié ignoré (2×27 € = 54 €)', body.total === 5400, `total = ${body.total} centimes`);
check('Référence générée', /^CS68-[0-9A-F]{6}$/.test(body.reference ?? ''), body.reference);

// 5. produit inexistant
r = await post(valid, { items: [{ id: 'produit-pirate', quantity: 1 }] });
check('Produit inconnu rejeté', r.status === 400, `HTTP ${r.status}`);

// 6. quantité invalide
r = await post(valid, { items: [{ id: 'kartoon-kush', variantId: '2g', quantity: -5 }] });
check('Quantité négative rejetée', r.status === 400, `HTTP ${r.status}`);

// 7. variante inexistante
r = await post(valid, { items: [{ id: 'kartoon-kush', variantId: '999g', quantity: 1 }] });
check('Variante inconnue rejetée', r.status === 400, `HTTP ${r.status}`);

// 8. panier vide
r = await post(valid, { items: [] });
check('Panier vide rejeté', r.status === 400, `HTTP ${r.status}`);

// 9. historique
r = await fetch(`${BASE}/api/orders`, { headers: { 'X-Telegram-Init-Data': valid } });
const list = await r.json();
check('Historique du client accessible', Array.isArray(list) && list.length >= 1, `${list.length} commande(s)`);

for (const { name, pass, detail } of results) {
  console.log(`${pass ? 'OK  ' : 'ECHEC'}  ${name}  (${detail})`);
}
const failed = results.filter((x) => !x.pass).length;
console.log(`\n${results.length - failed}/${results.length} tests passés`);
process.exit(failed ? 1 : 0);
