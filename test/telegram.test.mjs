/**
 * Le bot nourri de vraies mises à jour Telegram.
 *
 * Les autres suites appellent l'API HTTP ; celle-ci passe par la porte que
 * franchit un message réel, avec ses entités de commande, et intercepte tout
 * ce que le bot voudrait envoyer. On y vérifie surtout qui a le droit de quoi
 * — un bouton de statut est une surface d'attaque comme une autre.
 *
 * Aucun appel réseau : l'API sortante est remplacée.
 *
 * Usage :  BOT_TOKEN=… node test/telegram.test.mjs
 */
import 'dotenv/config';

if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer les tests.');
  process.exit(1);
}

const ADMIN_ID = Number((process.env.ADMIN_IDS ?? '424242').split(',')[0].trim());

const { bot } = await import('../server/bot.js');
const { createOrder, getOrder } = await import('../server/orders.js');
const { getSettings, saveSettings } = await import('../server/settings.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

/* ── Un Telegram de façade ───────────────────────────────── */

let envois = [];
bot.api.config.use(async (prev, method, payload) => {
  envois.push({ method, payload });
  if (method === 'getMe') {
    return { ok: true, result: { id: 1, is_bot: true, first_name: 'Bot', username: 'testbot' } };
  }
  return { ok: true, result: { message_id: 1, date: 0, chat: { id: payload?.chat_id ?? 0, type: 'private' } } };
});

bot.botInfo = {
  id: 1, is_bot: true, first_name: 'Bot', username: 'testbot',
  can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business_account: false, has_main_web_app: false,
};
await bot.init();

let compteur = 1000;

/** Telegram marque les commandes par une entité : sans elle, aucun
 *  `bot.command` ne se déclenche et le test passerait à côté de tout. */
const message = (from, text, extra = {}) => {
  const entities = typeof text === 'string' && text.startsWith('/')
    ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }]
    : undefined;
  return {
    update_id: compteur++,
    message: {
      message_id: compteur, date: Math.floor(Date.now() / 1000),
      chat: { id: from.id, type: 'private' }, from, text, entities, ...extra,
    },
  };
};

const callback = (from, data) => ({
  update_id: compteur++,
  callback_query: {
    id: String(compteur), from, chat_instance: 'x', data,
    message: {
      message_id: compteur, date: Math.floor(Date.now() / 1000),
      chat: { id: from.id, type: 'private' }, from, text: 'ancien',
    },
  },
});

const ADMIN = { id: ADMIN_ID, is_bot: false, first_name: 'Patron' };
const CLIENT = { id: 777001, is_bot: false, first_name: 'Client' };

const jouer = async (update) => {
  envois = [];
  await bot.handleUpdate(update);
  return envois;
};
const dit = (e) => e.map((x) => x.payload?.text ?? x.payload?.caption ?? '').join(' | ');

/* ── Ce qui est ouvert à tous ────────────────────────────── */

await saveSettings({ features: { orderHistory: true, photos: true, verification: false } });

for (const cmd of ['/start', '/aide', '/boutique']) {
  const e = await jouer(message(CLIENT, cmd));
  check(`${cmd} répond`, e.length > 0, dit(e).slice(0, 40));
}

/* ── Ce qui est réservé ──────────────────────────────────── */

for (const cmd of ['/admin', '/ouvrir', '/fermer', '/verification on']) {
  const e = await jouer(message(CLIENT, cmd));
  check(`${cmd} est refusé à un client`, /réservé/i.test(dit(e)), dit(e).slice(0, 50));
}

/* ── Les interrupteurs du bot ────────────────────────────── */

await jouer(message(ADMIN, '/fermer'));
check('/fermer ferme la boutique', (await getSettings()).opening.open === false);
await jouer(message(ADMIN, '/ouvrir'));
check('/ouvrir la rouvre', (await getSettings()).opening.open === true);

await jouer(message(ADMIN, '/verification on'));
check('/verification on allume la vérification', (await getSettings()).features.verification === true);
await jouer(message(ADMIN, '/verification off'));
check('/verification off l\'éteint', (await getSettings()).features.verification === false);

let e = await jouer(message(ADMIN, '/verification nawak'));
check('Un argument farfelu obtient une explication', dit(e).length > 0, dit(e).slice(0, 50));

/* ── Les boutons de statut ───────────────────────────────── */

const commande = await createOrder({
  user: { id: CLIENT.id, first_name: 'Client' },
  items: [{ id: 'x', name: 'Test', variantId: null, variantLabel: null, unitPrice: 1000, quantity: 1, lineTotal: 1000 }],
  subtotal: 1000, total: 1000, mode: 'pickup',
});

e = await jouer(callback(CLIENT, `st:${commande.reference}:confirmee`));
check('Un client ne change pas un statut',
  /réservé/i.test(e.find((x) => x.method === 'answerCallbackQuery')?.payload?.text ?? ''));
check('Et le statut n\'a pas bougé', (await getOrder(commande.reference)).status === 'nouvelle');

await jouer(callback(ADMIN, `st:${commande.reference}:confirmee`));
check('L\'administrateur, lui, le change', (await getOrder(commande.reference)).status === 'confirmee');

// De « confirmée » à « livrée » sans passer par « prête » : interdit.
await jouer(callback(ADMIN, `st:${commande.reference}:livree`));
check('Une transition interdite est refusée',
  (await getOrder(commande.reference)).status === 'confirmee');

e = await jouer(callback(ADMIN, 'st:CS68-INEXISTANT:confirmee'));
check('Une référence inconnue ne fait pas planter le bot',
  Boolean(e.find((x) => x.method === 'answerCallbackQuery')));

e = await jouer(callback(ADMIN, `st:${commande.reference}:nimportequoi`));
check('Un statut inventé non plus', e.length > 0, dit(e).slice(0, 40));

/* ── Les images ──────────────────────────────────────────── */

const photo = { photo: [{ file_id: 'AgACfake', file_unique_id: 'u', width: 100, height: 100 }] };

e = await jouer(message(ADMIN, undefined, { ...photo, caption: '' }));
check('Photo sans légende : le bot explique', /légende/i.test(dit(e)), dit(e).slice(0, 45));

e = await jouer(message(ADMIN, undefined, { ...photo, caption: 'produit qui n existe pas' }));
check('Légende sans correspondance : le bot liste', /correspond/i.test(dit(e)), dit(e).slice(0, 45));

e = await jouer(message(CLIENT, undefined, photo));
check('Pièce envoyée alors que la vérification est coupée : le bot le dit',
  /identité/i.test(dit(e)), dit(e).slice(0, 60));

await saveSettings({ features: { photos: false } });
e = await jouer(message(ADMIN, undefined, { ...photo, caption: 'Dry Sift 68' }));
check('Photos coupées : le bot le dit à l\'administrateur', /désactiv/i.test(dit(e)), dit(e).slice(0, 50));
await saveSettings({ features: { photos: true } });

/* ── L'historique suit son interrupteur ──────────────────── */

await saveSettings({ features: { orderHistory: false } });
e = await jouer(message(CLIENT, '/commandes'));
check('/commandes respecte l\'interrupteur « Mes commandes »', !/CS68/.test(dit(e)), dit(e).slice(0, 50));

await saveSettings({ features: { orderHistory: true } });
e = await jouer(message(CLIENT, '/commandes'));
check('Rallumé, il ressert l\'historique', /CS68|pas encore/.test(dit(e)), dit(e).slice(0, 40));

/* ── Tout le reste ───────────────────────────────────────── */

for (const [label, texte] of [
  ['un bonjour', 'bonjour'],
  ['une commande inconnue', '/nawak'],
  ['du HTML', '<img src=x onerror=alert(1)>'],
  ['un pavé de 4000 caractères', 'a'.repeat(4000)],
  ['des emoji seuls', '🌿🔥😀'],
]) {
  const envoyes = await jouer(message(CLIENT, texte));
  check(`Le bot répond à ${label}`, envoyes.length > 0, dit(envoyes).slice(0, 35));
}

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Bot Telegram : OK'}`);
process.exit(failures ? 1 : 0);
