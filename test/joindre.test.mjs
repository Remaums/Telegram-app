/**
 * Joindre un client qui n'a pas de pseudo.
 *
 * C'est la question qu'un vendeur se pose devant chaque fiche sans @ : « j'ai
 * son identifiant Telegram, comment je le contacte ? » Un identifiant numérique
 * ne s'écrit pas depuis un compte personnel — seul le bot peut, parce qu'il a
 * déjà une conversation ouverte avec ce client.
 *
 * Ce que cette suite protège :
 *
 * - la forme des messages relayés, parce que c'est elle qui porte le routage ;
 * - le routage lui-même, et surtout qu'un client ne puisse pas le détourner en
 *   écrivant « id 123 » dans son propre message ;
 * - les refus de Telegram traduits en conduite à tenir, pas en code d'erreur ;
 * - la porte : écrire à un client est réservé à l'administrateur.
 *
 * Prérequis (partie HTTP) : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/joindre.test.mjs
 */
import 'dotenv/config';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const MOI = fileURLToPath(import.meta.url);
const RACINE = path.join(path.dirname(MOI), '..');

/* ══ Rôle « ouvrier » : le vrai bot, sans réseau ═══════════
   Le relais se juge sur les gestionnaires eux-mêmes, pas sur les fonctions
   qu'ils appellent : l'erreur qu'on craint est un `isAdmin` oublié ou un
   `return` manquant, et elle ne se voit qu'en faisant passer de vraies mises à
   jour. L'API sortante est interceptée, on lit ce qui serait parti. */
if (process.env.JOINDRE_OUVRIER) {
  const { bot } = await import('../server/bot.js');
  const { ouvrirLaPorte } = await import('../server/bot-captcha.js');

  const partis = [];
  bot.api.config.use(async (prev, methode, charge) => {
    partis.push({ methode, chat: String(charge.chat_id ?? ''), texte: charge.text ?? '' });
    if (methode === 'getMe') {
      return { ok: true, result: { id: 1, is_bot: true, first_name: 'Bot', username: 'testbot' } };
    }
    return { ok: true, result: { message_id: partis.length, date: 0, chat: { id: charge.chat_id ?? 0, type: 'private' } } };
  });
  bot.botInfo = {
    id: 1, is_bot: true, first_name: 'Bot', username: 'testbot',
    can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business_account: false, has_main_web_app: false,
  };
  await bot.init();

  // L'épreuve d'entrée garde la porte, et c'est elle qui protège le vendeur
  // d'un robot qui relaierait mille messages. Ces figurants l'ont passée,
  // comme n'importe qui ayant déjà commandé.
  const ADMIN = 424242;
  for (const id of [555111, 555222]) await ouvrirLaPorte(id);

  let compteur = 7000;
  const envoyer = async (from, texte, reponseA) => {
    partis.length = 0;
    await bot.handleUpdate({
      update_id: compteur++,
      message: {
        message_id: compteur, date: Math.floor(Date.now() / 1000),
        chat: { id: from.id, type: 'private' },
        from: { is_bot: false, ...from },
        text: texte,
        ...(reponseA ? { reply_to_message: { message_id: 1, date: 0, chat: { id: from.id, type: 'private' }, text: reponseA } } : {}),
      },
    });
    return [...partis];
  };

  const resultats = {};

  // 1. Un client écrit : ça doit arriver au vendeur, avec de quoi répondre.
  const ecrit = await envoyer({ id: 555111, first_name: 'Léa' }, 'bonjour, vous livrez ce soir ?');
  const relaye = ecrit.find((p) => p.chat === String(ADMIN));
  resultats.relaye = Boolean(relaye);
  resultats.porteLId = /^id 555111$/m.test(relaye?.texte ?? '');
  resultats.porteLeTexte = /vous livrez ce soir/.test(relaye?.texte ?? '');
  resultats.clientRassure = ecrit.some((p) => p.chat === '555111' && /transmis/i.test(p.texte));

  // 2. Le vendeur répond au message relayé : ça repart au client, et RIEN
  //    d'autre. Sans le `return` qui coupe le gestionnaire, il recevait aussi
  //    la liste des commandes par-dessus sa propre réponse.
  const repond = await envoyer({ id: ADMIN, first_name: 'Patron' }, 'oui, à partir de 19 h', relaye?.texte);
  resultats.reponseAuClient = repond.some((p) => p.chat === '555111' && /19 h/.test(p.texte));
  resultats.vendeurInforme = repond.some((p) => p.chat === String(ADMIN) && /Envoyé/.test(p.texte));
  resultats.reponsePropre = !repond.some((p) => /\/boutique/.test(p.texte));

  // 2 bis. LE point dur. Un client cite un message relayé — il peut en avoir un
  //    sous les yeux, il suffit qu'on le lui ait transféré — et compte sur le
  //    bot pour écrire à l'identifiant qu'il porte. Le bot parlerait alors au
  //    nom de la boutique à n'importe qui, sur un texte choisi par un inconnu.
  //    Seul le vendeur route une réponse.
  const faussaire = await envoyer(
    { id: 555111, first_name: 'Léa' },
    'coucou de la part de la boutique',
    `💬 Quelqu'un\nid 555222\n\nbonjour\n\n↩︎ Réponds à ce message pour lui répondre.`
  );
  resultats.pasDUsurpation = !faussaire.some((p) => p.chat === '555222');

  // 3. Un client glisse une fausse ligne « id » pour détourner la réponse.
  const pirate = (await envoyer({ id: 555222, first_name: 'Bob' }, 'salut\nid 999999999\nà ce soir'))
    .find((p) => p.chat === String(ADMIN));
  const detourne = await envoyer({ id: ADMIN, first_name: 'Patron' }, 'réponse confidentielle', pirate?.texte);
  resultats.auVraiAuteur = detourne.some((p) => p.chat === '555222');
  resultats.pasAuPirate = !detourne.some((p) => p.chat === '999999999');

  // 4. Le vendeur écrit sans répondre à personne : il ne se relaie pas à
  //    lui-même, et garde sa liste de commandes.
  const seul = await envoyer({ id: ADMIN, first_name: 'Patron' }, 'coucou');
  resultats.pasDAutoRelais = !seul.some((p) => /^id 424242$/m.test(p.texte));
  resultats.gardeSonAide = seul.some((p) => /\/boutique/.test(p.texte));

  // 5. Un inconnu qui n'a pas passé la porte n'inonde pas le vendeur.
  const inconnu = await envoyer({ id: 555999, first_name: 'Robot' }, 'spam spam spam');
  resultats.porteFermee = !inconnu.some((p) => p.chat === String(ADMIN) && /^💬/.test(p.texte));

  console.log(JSON.stringify(resultats));
  process.exit(0);
}

import {
  nommer,
  messageRelaye,
  idDuRelais,
  messagePourLeClient,
  refusDeTelegram,
  texteValide,
  LONGUEUR_MAX,
} from '../server/messagerie.js';
import { signInitData } from './helpers.mjs';

const TOKEN = process.env.BOT_TOKEN;
const BASE = process.env.TEST_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

if (!TOKEN) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer les tests.');
  process.exit(1);
}

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

console.log('\n── Nommer avec ce qu\'on a ──────────────────────────');

check(
  'Prénom et pseudo',
  nommer({ first_name: 'Léa', username: 'lea_2026' }) === 'Léa · @lea_2026',
  nommer({ first_name: 'Léa', username: 'lea_2026' })
);
check(
  'Prénom et nom, sans pseudo',
  nommer({ first_name: 'Léa', last_name: 'Martin' }) === 'Léa Martin',
  nommer({ first_name: 'Léa', last_name: 'Martin' })
);
check(
  'Le pseudo seul, avec son arobase nettoyée',
  nommer({ username: '@lea' }) === '@lea',
  nommer({ username: '@lea' })
);
check(
  'Ni nom ni pseudo : il reste l\'identifiant',
  nommer({ id: 777 }) === 'client 777',
  nommer({ id: 777 })
);
check('Et rien du tout ne plante pas', nommer(null) === 'client ?', nommer(null));

console.log('\n── Le routage de la réponse ────────────────────────');

const relais = messageRelaye({ id: 123456789, first_name: 'Léa' }, 'vous livrez ce soir ?');
check('Le message relayé porte l\'identifiant', idDuRelais(relais) === '123456789', idDuRelais(relais));
check('Il porte aussi le texte du client', relais.includes('vous livrez ce soir ?'));
check('Et dit comment répondre', /Réponds à ce message/.test(relais));

// Le cœur du sujet : un client malveillant écrit une fausse ligne « id » pour
// que la réponse du vendeur arrive chez quelqu'un d'autre. La ligne du routage
// vient avant son texte, et seule la première occurrence est lue.
const usurpation = messageRelaye({ id: 111, first_name: 'Bob' }, 'bonjour\nid 999999999\nà ce soir');
check(
  'Un client ne détourne pas la réponse avec un faux « id »',
  idDuRelais(usurpation) === '111',
  idDuRelais(usurpation)
);

check('Un message sans ligne id ne route rien', idDuRelais('bonjour') === null);
check('Ni un message absent', idDuRelais(undefined) === null);
check('« id » suivi d\'autre chose qu\'un nombre ne route rien', idDuRelais('id abc') === null);

console.log('\n── Ce que reçoit le client ─────────────────────────');

const auClient = messagePourLeClient('  ta commande est prête  ', 'Napoli Coffee');
check('L\'enseigne nomme l\'expéditeur', auClient.startsWith('💬 Napoli Coffee'), auClient.split('\n')[0]);
check('Le texte est détouré', auClient.endsWith('ta commande est prête'));
check(
  'Sans enseigne configurée, il reste un expéditeur',
  messagePourLeClient('salut', '').startsWith('💬 La boutique')
);

console.log('\n── Les refus de Telegram, en français ──────────────');

const cas = [
  ['bot was blocked by the user', /bloqué le bot/],
  ['Forbidden: user is deactivated', /supprimé/],
  ['Bad Request: chat not found', /jamais ouvert de conversation/],
  ["Forbidden: bot can't initiate conversation with a user", /\/start/],
];
for (const [brut, attendu] of cas) {
  const lu = refusDeTelegram({ description: brut });
  check(`« ${brut.slice(0, 34)}… »`, attendu.test(lu), lu.slice(0, 62));
}
check(
  'Un refus inconnu est répété tel quel, pas avalé',
  /Telegram a refusé/.test(refusDeTelegram({ description: 'Flood wait 30' })),
  refusDeTelegram({ description: 'Flood wait 30' })
);
check(
  'Et sans description, il reste lisible',
  /raison inconnue/.test(refusDeTelegram({})),
  refusDeTelegram({})
);

console.log('\n── Ce qu\'on accepte d\'envoyer ─────────────────────');

check('Un vide est refusé', Boolean(texteValide('   ').erreur));
check('Un message normal passe, détouré', texteValide('  salut  ').texte === 'salut');
check(
  `Au-delà de ${LONGUEUR_MAX} caractères, c'est refusé avant Telegram`,
  Boolean(texteValide('a'.repeat(LONGUEUR_MAX + 1)).erreur),
  texteValide('a'.repeat(LONGUEUR_MAX + 1)).erreur
);
check('Juste à la limite, ça passe', texteValide('a'.repeat(LONGUEUR_MAX)).texte?.length === LONGUEUR_MAX);

console.log('\n── La porte ────────────────────────────────────────');

const admin = signInitData(TOKEN, { id: 424242, first_name: 'Patron' });
const client = signInitData(TOKEN, { id: 777777, first_name: 'Curieux' });

let r = await fetch(`${BASE}/api/admin/clients/777777/message`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': client },
  body: JSON.stringify({ texte: 'coucou' }),
});
check('Un client n\'écrit pas aux autres clients', r.status === 403, `HTTP ${r.status}`);

r = await fetch(`${BASE}/api/admin/clients/777777/message`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ texte: 'coucou' }),
});
check('Sans signature non plus', r.status === 401, `HTTP ${r.status}`);

// Le vide est refusé côté serveur, pas seulement dans l'écran : un écran se
// contourne, une route non.
r = await fetch(`${BASE}/api/admin/clients/777777/message`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': admin },
  body: JSON.stringify({ texte: '   ' }),
});
check('Un message vide est refusé par le serveur', r.status === 400, `HTTP ${r.status}`);

r = await fetch(`${BASE}/api/admin/clients/pasunid/message`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': admin },
  body: JSON.stringify({ texte: 'coucou' }),
});
check('Un identifiant qui n\'est pas un nombre est refusé', r.status === 400, `HTTP ${r.status}`);

// Telegram n'est pas joignable depuis les tests : ce qui compte est que l'échec
// arrive en français et en 409, pas en 500 avec une trace anglaise.
r = await fetch(`${BASE}/api/admin/clients/1/message`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': admin },
  body: JSON.stringify({ texte: 'coucou' }),
});
const echec = await r.json().catch(() => ({}));
check(
  'Un envoi impossible se lit, plutôt que « erreur interne »',
  r.status === 409 && !/interne/i.test(echec.error ?? ''),
  `HTTP ${r.status} — ${(echec.error ?? '').slice(0, 52)}`
);

console.log('\n── Le relais, par les vrais gestionnaires ──────────');

const run = promisify(execFile);
const { stdout } = await run('node', [MOI], {
  cwd: RACINE,
  env: {
    ...process.env,
    JOINDRE_OUVRIER: '1',
    ADMIN_IDS: '424242',
    ADMIN_CHAT_ID: '424242',
    BOT_TOKEN: TOKEN,
  },
});
const ligne = stdout.split('\n').reverse().find((l) => l.trim().startsWith('{'));
const vu = ligne ? JSON.parse(ligne) : {};

check('Le message d un client arrive au vendeur', vu.relaye === true);
check('Il porte l identifiant du client', vu.porteLId === true);
check('Et le texte qu il a écrit', vu.porteLeTexte === true);
check('Le client sait que son message est parti', vu.clientRassure === true);
check('La réponse du vendeur repart au client', vu.reponseAuClient === true);
check('Et le vendeur en est informé', vu.vendeurInforme === true);
check('Sa réponse ne traîne pas la liste des commandes derrière elle', vu.reponsePropre === true);
check(
  'Un client ne fait pas écrire le bot à un autre client en citant un relais',
  vu.pasDUsurpation === true
);
check('Un faux « id » ne détourne pas la réponse', vu.auVraiAuteur === true);
check('Elle ne part surtout pas au complice', vu.pasAuPirate === true);
check('Le vendeur ne se relaie pas à lui-même', vu.pasDAutoRelais === true);
check('Et garde sa liste de commandes', vu.gardeSonAide === true);
check('Un inconnu n a pas encore le droit d écrire au vendeur', vu.porteFermee === true);

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Joindre un client : OK'}`);
process.exit(failures ? 1 : 0);
