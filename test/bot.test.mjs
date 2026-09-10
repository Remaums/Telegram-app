/**
 * Test du traitement des commandes depuis Telegram.
 *
 * Les boutons sous la notification vendeur ne doivent proposer que les
 * transitions autorisées : c'est ce qui empêche de marquer « livrée » une
 * commande qui n'a jamais été confirmée, ou de rouvrir une commande annulée.
 *
 * Aucun appel réseau : on vérifie le message et le clavier, pas Telegram.
 *
 * Usage :  BOT_TOKEN=… node test/bot.test.mjs
 */
import 'dotenv/config';

if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer les tests.');
  process.exit(1);
}

const { orderMessage, statusKeyboard } = await import('../server/bot.js');
const { STATUSES } = await import('../server/orders.js');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

const order = {
  reference: 'CS68-ABC123',
  status: 'nouvelle',
  createdAt: new Date().toISOString(),
  user: { id: 42, username: 'lea', firstName: 'Léa' },
  items: [
    { name: 'Néon Kush', variantLabel: '5 g', quantity: 2, lineTotal: 5400 },
    { name: 'Brique 68', variantLabel: null, quantity: 1, lineTotal: 1800 },
  ],
  total: 7200,
  contact: '06 12 34 56 78',
  note: 'Vers 18 h',
};

/* ── Le message ──────────────────────────────────────────── */

const message = orderMessage(order);
check('Référence dans le message', message.includes('CS68-ABC123'));
check('Statut lisible dans le message', message.includes(STATUSES.nouvelle.label));
check('Articles détaillés', message.includes('2 × Néon Kush (5 g)') && message.includes('1 × Brique 68'));
check('Contact et note repris', message.includes('06 12 34 56 78') && message.includes('Vers 18 h'));

/* ── Le clavier ──────────────────────────────────────────── */

const buttons = (o) => statusKeyboard(o)?.inline_keyboard.flat() ?? [];

const nouvelle = buttons(order);
check(
  'Une commande nouvelle propose confirmer et annuler',
  nouvelle.length === 2 && nouvelle.every((b) => /^st:CS68-ABC123:(confirmee|annulee)$/.test(b.callback_data)),
  nouvelle.map((b) => b.callback_data).join(' ')
);

const prete = buttons({ ...order, status: 'prete' });
check(
  'Une commande prête ne propose que livrée et annulée',
  prete.map((b) => b.callback_data.split(':')[2]).sort().join(',') === 'annulee,livree'
);

check('Une commande livrée ne propose plus rien', statusKeyboard({ ...order, status: 'livree' }) === undefined);
check('Une commande annulée ne propose plus rien', statusKeyboard({ ...order, status: 'annulee' }) === undefined);

/* ── Où livrer, et par où y aller ────────────────────────── */

// Recopier une adresse à la main dans une application de trajet, une par
// commande, c'est la faute de frappe assurée — et une faute de frappe, ici,
// c'est un livreur devant la mauvaise porte.
const aLivrer = {
  ...order,
  mode: 'delivery',
  address: { street: '12 rue des Lilas', complement: 'Bât B, 3e étage, code 1234', postalCode: '68100', city: 'Mulhouse' },
  phone: '06 12 34 56 78',
  contact: '12 rue des Lilas · Bât B, 3e étage, code 1234 · 68100 Mulhouse · 06 12 34 56 78',
};

const messageLivraison = orderMessage(aLivrer);
check("L'adresse est écrite en clair", messageLivraison.includes('12 rue des Lilas'), '');
check('Le complément aussi — étage et code de porte',
  messageLivraison.includes('code 1234'));
check('La ville et le code postal ne manquent pas',
  messageLivraison.includes('68100 Mulhouse'));
check('Le téléphone est sur sa propre ligne', /📞 06 12 34 56 78/.test(messageLivraison));

const routes = buttons(aLivrer).filter((b) => b.url);
check('Trois applications de trajet sont proposées', routes.length === 3,
  routes.map((b) => b.text).join(' '));
check('Toutes en HTTPS — Telegram rejette le message entier sinon',
  routes.every((b) => /^https:\/\//.test(b.url)), routes.map((b) => b.url.split('/')[2]).join(' '));
check('Chacune vise la même adresse',
  routes.every((b) => b.url.includes(encodeURIComponent('12 rue des Lilas, 68100 Mulhouse'))));

// Un géocodeur ne sait pas quoi faire d'un étage : beaucoup renoncent à
// chercher plutôt que de l'ignorer.
check("Le complément ne part pas dans l'itinéraire",
  routes.every((b) => !b.url.toLowerCase().includes('etage') && !b.url.includes('1234')));

check('Les boutons de statut sont toujours là',
  buttons(aLivrer).filter((b) => b.callback_data).length === 2);

// Même livrée, une commande garde son itinéraire : le vendeur peut relire le
// message et repartir. Mais un retrait n'a nulle part où aller.
check('Une commande livrée garde son itinéraire',
  buttons({ ...aLivrer, status: 'livree' }).filter((b) => b.url).length === 3);
check("Un retrait ne propose aucun itinéraire",
  buttons({ ...order, mode: 'pickup' }).every((b) => !b.url));
check("Une livraison sans adresse découpée non plus",
  buttons({ ...order, mode: 'delivery', contact: '12 rue des Lilas, Colmar' }).every((b) => !b.url));
check('Et son contact reste lisible dans le message',
  orderMessage({ ...order, mode: 'delivery', contact: '12 rue des Lilas, Colmar' })
    .includes('Adresse : 12 rue des Lilas, Colmar'));

// Telegram limite la donnée de rappel à 64 octets.
const longest = Math.max(...nouvelle.map((b) => Buffer.byteLength(b.callback_data)));
check('Donnée de rappel sous la limite Telegram', longest <= 64, `${longest} octets`);

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Traitement Telegram : OK'}`);
process.exit(failures ? 1 : 0);
