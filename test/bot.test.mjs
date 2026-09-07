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

// Telegram limite la donnée de rappel à 64 octets.
const longest = Math.max(...nouvelle.map((b) => Buffer.byteLength(b.callback_data)));
check('Donnée de rappel sous la limite Telegram', longest <= 64, `${longest} octets`);

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Traitement Telegram : OK'}`);
process.exit(failures ? 1 : 0);
