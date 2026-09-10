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
const { getCatalog, removeProductMedia } = await import('../server/catalog.js');
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

/* ── La porte du bot ─────────────────────────────────────── */

// Un péage, pas une énigme : un robot sait additionner. Ce qu'on vérifie, ce
// sont les trois choses qui font la différence entre une porte et un
// tourniquet — la réponse ne sort jamais du serveur, un mauvais bouton fait
// changer le calcul, et l'insistance coûte une attente.
{
  const { oublier, estPasse } = await import('../server/bot-captcha.js');

  // Un inconnu, jamais vu : les identifiants tirés au hasard rendent cette
  // suite rejouable, un client d'une exécution passée étant déjà entré.
  const INCONNU = { id: 900000 + Math.floor(Math.random() * 90000), is_bot: false, first_name: 'Passant' };
  await oublier(INCONNU.id);

  const boutons = (e) =>
    (e[0]?.payload?.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);

  e = await jouer(message(INCONNU, '/start'));
  check('Un inconnu tombe sur un calcul', /Combien font/.test(dit(e)), dit(e).slice(0, 60));
  check("Et pas sur l'accueil", !/Bienvenue/.test(dit(e)));
  let choix = boutons(e).map((d) => Number(d.split(':')[1]));
  check('Six réponses sont proposées', choix.length === 6, choix.join(' '));

  // La bonne réponse ne doit se lire nulle part : ni dans le texte, ni dans
  // les boutons autrement que noyée parmi les autres.
  const enonce = dit(e).match(/Combien font (\d+) ([+−]) (\d+)/);
  const attendu = enonce[2] === '+' ? Number(enonce[1]) + Number(enonce[3]) : Number(enonce[1]) - Number(enonce[3]);
  check('La réponse est parmi les boutons', choix.includes(attendu), `${attendu} dans ${choix.join(' ')}`);
  check("Elle n'est pas écrite dans le message",
    !new RegExp(`= ?${attendu}\\b`).test(dit(e)));

  // Tant que la porte n'est pas franchie, rien d'autre ne s'ouvre.
  e = await jouer(message(INCONNU, '/boutique'));
  check('Le catalogue reste fermé entre-temps', !/catalogue/i.test(dit(e)), dit(e).slice(0, 40));
  check('Et le calcul ne change pas entre deux messages', /Combien font/.test(dit(e)));
  const memeEnonce = dit(e).match(/Combien font (\d+) ([+−]) (\d+)/);
  check("La même épreuve est reposée telle quelle",
    memeEnonce[0] === enonce[0], `${enonce[0]} puis ${memeEnonce[0]}`);

  // Un mauvais bouton fait tirer un autre calcul : sinon il suffirait
  // d'essayer les six l'un après l'autre.
  const faux = choix.find((v) => v !== attendu);
  e = await jouer(callback(INCONNU, `cap:${faux}`));
  check('Une mauvaise réponse est refusée', /pas ça/i.test(dit(e)), dit(e).slice(0, 40));
  check('Et il reste des essais', /2 essais/.test(dit(e)), dit(e).slice(0, 60));
  const apresErreur = dit(e).match(/Combien font (\d+) ([+−]) (\d+)/);
  check('Un nouveau calcul est tiré', apresErreur[0] !== enonce[0], `${enonce[0]} → ${apresErreur[0]}`);
  check("La porte est toujours fermée", (await estPasse(INCONNU.id)) === false);

  // Trois erreurs valent une attente : c'est ce qui rend l'essai systématique
  // plus cher que le renoncement.
  let courant = apresErreur;
  for (let i = 0; i < 2; i++) {
    const juste = courant[2] === '+' ? Number(courant[1]) + Number(courant[3]) : Number(courant[1]) - Number(courant[3]);
    e = await jouer(callback(INCONNU, `cap:${juste + 1}`));
    courant = dit(e).match(/Combien font (\d+) ([+−]) (\d+)/) ?? courant;
  }
  check('Trois erreurs ferment la porte un moment', /Réessaie dans \d+ minute/.test(dit(e)), dit(e).slice(0, 50));

  e = await jouer(message(INCONNU, '/start'));
  check("Pendant l'attente, aucun calcul n'est reposé", !/Combien font/.test(dit(e)), dit(e).slice(0, 50));
  check("Et l'attente est annoncée", /Réessaie dans/.test(dit(e)));

  // On repart d'une porte neuve pour la suite : la réponse écrite plutôt que
  // touchée doit marcher aussi — un client qui tape « 12 » ne se trompe pas.
  await oublier(INCONNU.id);
  e = await jouer(message(INCONNU, '/start'));
  const dernier = dit(e).match(/Combien font (\d+) ([+−]) (\d+)/);
  const bonne = dernier[2] === '+' ? Number(dernier[1]) + Number(dernier[3]) : Number(dernier[1]) - Number(dernier[3]);

  e = await jouer(message(INCONNU, String(bonne)));
  check('Une réponse écrite ouvre aussi la porte', /Bienvenue/.test(dit(e)), dit(e).slice(0, 45));
  check('Et la porte reste ouverte', (await estPasse(INCONNU.id)) === true);

  e = await jouer(message(INCONNU, '/start'));
  check("On ne redemande jamais deux fois", !/Combien font/.test(dit(e)) && /Bienvenue/.test(dit(e)));

  // Le vendeur n'a pas à se justifier auprès de sa propre boutique.
  e = await jouer(message(ADMIN, '/start'));
  check("L'administrateur n'est jamais interrogé", !/Combien font/.test(dit(e)));

  // Un client qui a déjà commandé non plus : le prendre pour un inconnu
  // serait lui faire payer une porte qu'il a déjà franchie.
  const ANCIEN = { id: 950000 + Math.floor(Math.random() * 40000), is_bot: false, first_name: 'Fidele' };
  await oublier(ANCIEN.id);
  await createOrder({
    user: { id: ANCIEN.id, first_name: 'Fidele' },
    items: [{ id: 'x', name: 'Test', variantId: null, variantLabel: null, unitPrice: 1000, quantity: 1, lineTotal: 1000 }],
    subtotal: 1000, total: 1000, mode: 'pickup',
  });
  e = await jouer(message(ANCIEN, '/start'));
  check("Un client qui a déjà commandé entre sans rien prouver",
    !/Combien font/.test(dit(e)) && /Bienvenue/.test(dit(e)), dit(e).slice(0, 40));

  // `/admin` reste ouvert : c'est par lui qu'un vendeur qui vient d'installer
  // sa boutique découvre son identifiant Telegram. Lui opposer un calcul le
  // laisserait devant une porte dont il cherche justement la clé.
  const NOUVEAU = { id: 940000 + Math.floor(Math.random() * 10000), is_bot: false, first_name: 'Vendeur' };
  await oublier(NOUVEAU.id);
  e = await jouer(message(NOUVEAU, '/admin'));
  check("/admin répond son mode d'emploi même à un inconnu",
    /identifiant/i.test(dit(e)) && !/Combien font/.test(dit(e)), dit(e).slice(0, 45));

  // Une commande passée depuis la Mini App vaut mieux qu'un calcul : elle est
  // signée par Telegram. Le message de confirmation ne doit pas se heurter à
  // une épreuve, sinon le client verrait un calcul pour toute réponse à sa
  // commande.
  const ACHETEUR = { id: 970000 + Math.floor(Math.random() * 20000), is_bot: false, first_name: 'Acheteur' };
  await oublier(ACHETEUR.id);
  e = await jouer(message(ACHETEUR, undefined, { web_app_data: { button_text: 'x', data: '{"reference":"CS68-TEST"}' } }));
  check("Une commande envoyée depuis la Mini App passe la porte",
    /bien reçue/.test(dit(e)), dit(e).slice(0, 45));
  check('Et la porte lui reste ouverte', (await estPasse(ACHETEUR.id)) === true);

  // L'interrupteur ferme la porte pour de bon.
  const AUTRE = { id: 960000 + Math.floor(Math.random() * 30000), is_bot: false, first_name: 'Autre' };
  await saveSettings({ features: { botCaptcha: false } });
  e = await jouer(message(AUTRE, '/start'));
  check("Épreuve coupée : plus personne n'est interrogé", !/Combien font/.test(dit(e)), dit(e).slice(0, 40));
  await saveSettings({ features: { botCaptcha: true } });
}

/* ── La vignette d'une vidéo ─────────────────────────────── */

// Telegram fabrique une petite image pour chaque vidéo qu'on lui confie. Elle
// vaut quelques kilo-octets contre quelques mégaoctets : c'est elle qui
// s'affiche pendant que la vidéo arrive, et sans elle la carte reste vide.
const laVideo = (vignette) => ({
  video: {
    file_id: `BAAC-${Math.random().toString(36).slice(2)}`,
    file_unique_id: 'v',
    width: 320,
    height: 240,
    duration: 3,
    file_size: 4096,
    ...vignette,
  },
  caption: 'Dry Sift 68',
});

const galerieDe = async () => {
  const p = (await getCatalog({ includeHidden: true })).products.find((x) => x.name === 'Dry Sift 68');
  return { id: p.id, media: p.media ?? [] };
};

const auDepart = (await galerieDe()).media.length;

e = await jouer(message(ADMIN, undefined, laVideo({ thumbnail: { file_id: 'AAQ-vignette', file_unique_id: 't' } })));
check('Une vidéo envoyée au bot entre dans la galerie', /ajout/i.test(dit(e)), dit(e).slice(0, 40));
let galerie = await galerieDe();
check('Et sa vignette est gardée avec elle', galerie.media.at(-1)?.thumbFileId === 'AAQ-vignette',
  JSON.stringify(galerie.media.at(-1)));

// `thumb` était son nom avant Bot API 7.0 : un serveur auto-hébergé plus
// ancien répond encore comme ça, et la vignette ne doit pas se perdre.
await jouer(message(ADMIN, undefined, laVideo({ thumb: { file_id: 'AAQ-ancienne', file_unique_id: 't' } })));
galerie = await galerieDe();
check('L\'ancien nom du champ est compris aussi', galerie.media.at(-1)?.thumbFileId === 'AAQ-ancienne');

// Une vidéo sans vignette ne doit pas en inventer une.
await jouer(message(ADMIN, undefined, laVideo({})));
galerie = await galerieDe();
check("Une vidéo sans vignette n'en invente pas", galerie.media.at(-1)?.thumbFileId === undefined);

// On rend la galerie telle qu'on l'a trouvée.
for (let i = galerie.media.length - 1; i >= auDepart; i--) await removeProductMedia(galerie.id, i);

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
