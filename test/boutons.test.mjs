/**
 * Les boutons qui ouvrent la Mini App.
 *
 * Telegram n'accepte un bouton « Mini App » qu'avec une URL HTTPS valide, et
 * son refus ne porte pas sur le bouton : il rejette le message entier. Une
 * `WEBAPP_URL` vide faisait donc répondre /start par... rien. Silence complet,
 * côté bot comme côté journal, et on allait chercher du côté du token ou des
 * droits admin un simple champ non rempli.
 *
 * Chaque scénario tourne dans son propre processus : la configuration est lue
 * une fois à l'import, et aucune ruse de cache de modules ne permet de la
 * relire autrement. Le bot ne parle pas à Telegram — l'API sortante est
 * interceptée, et on regarde ce qu'il aurait envoyé.
 *
 * Usage :  node test/boutons.test.mjs
 */
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const MOI = fileURLToPath(import.meta.url);
const RACINE = path.join(path.dirname(MOI), '..');
const ADMIN = { id: 424242, is_bot: false, first_name: 'Patron' };
const CLIENT = { id: 777333, is_bot: false, first_name: 'Client' };

/* ══ Rôle « ouvrier » : un scénario, un processus ══════════ */

if (process.env.BOUTONS_SCENARIO) {
  const commandes = JSON.parse(process.env.BOUTONS_SCENARIO);
  const { bot } = await import('../server/bot.js');

  let envois = [];
  let refus = [];
  bot.api.config.use(async (prev, method, payload) => {
    envois.push({ method, payload });
    if (method === 'getMe') {
      return { ok: true, result: { id: 1, is_bot: true, first_name: 'Bot', username: 'testbot' } };
    }
    // On rejoue le refus de Telegram : sans ça, le test validerait un message
    // que Telegram aurait en réalité rejeté, ce qui est exactement le piège
    // qu'on cherche à fermer.
    for (const b of payload?.reply_markup?.inline_keyboard?.flat?.() ?? []) {
      const u = b?.web_app?.url ?? '';
      if (!/^https:\/\/[^\s]+$/.test(u)) {
        refus.push(`${method} : URL de Mini App refusée (${JSON.stringify(u)})`);
        throw new Error('Bad Request: inline keyboard button Web App URL is invalid');
      }
    }
    return {
      ok: true,
      result: { message_id: 1, date: 0, chat: { id: payload?.chat_id ?? 0, type: 'private' } },
    };
  });

  bot.botInfo = {
    id: 1, is_bot: true, first_name: 'Bot', username: 'testbot',
    can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business_account: false, has_main_web_app: false,
  };
  await bot.init();

  let compteur = 5000;
  const resultats = [];
  for (const { from, texte } of commandes) {
    envois = [];
    refus = [];
    // Le refus de Telegram ressort du gestionnaire : on le note au lieu de
    // laisser le processus mourir, pour que le test dise lequel des cas a
    // échoué plutôt que d'afficher une trace.
    try {
      await bot.handleUpdate({
        update_id: compteur++,
        message: {
          message_id: compteur,
          date: Math.floor(Date.now() / 1000),
          chat: { id: from.id, type: 'private' },
          from,
          text: texte,
          entities: [{ type: 'bot_command', offset: 0, length: texte.split(' ')[0].length }],
        },
      });
    } catch (err) {
      refus.push(`le gestionnaire a levé : ${err.message}`);
    }
    resultats.push({
      texte,
      dit: envois.map((e) => e.payload?.text ?? '').join(' | '),
      boutons: envois.some((e) => e.payload?.reply_markup),
      refus: [...refus],
    });
  }

  console.log(`${JSON.stringify(resultats)}`);
  process.exit(0);
}

/* ══ Rôle « chef » : pose les scénarios, juge les retours ══ */

const run = promisify(execFile);

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

async function avecUrl(webappUrl, commandes, admins = { ADMIN_IDS: '424242' }) {
  const { stdout } = await run('node', [MOI], {
    cwd: RACINE,
    env: {
      ...process.env,
      WEBAPP_URL: webappUrl,
      BOT_TOKEN: process.env.BOT_TOKEN || '123456789:AAtest-token-local-pour-les-tests',
      ADMIN_IDS: '',
      ADMIN_CHAT_ID: '',
      ...admins,
      BOUTONS_SCENARIO: JSON.stringify(commandes),
    },
  });
  // Le résultat est préfixé : les avertissements de Node se mêleraient sinon
  // au JSON, et l'analyse échouerait pour une raison sans rapport.
  const ligne = stdout.split('\n').find((l) => l.startsWith(''));
  if (!ligne) throw new Error(`Aucun résultat du scénario : ${stdout.slice(0, 200)}`);
  return JSON.parse(ligne.slice(1));
}

/* ── Sans WEBAPP_URL : on répond quand même ──────────────── */

{
  const r = await avecUrl('', [
    { from: CLIENT, texte: '/start' },
    { from: CLIENT, texte: '/boutique' },
    { from: ADMIN, texte: '/admin' },
  ]);
  const [start, boutique, admin] = r;

  check('/start répond malgré une WEBAPP_URL vide', start.dit.length > 0,
    start.dit.slice(0, 50).replace(/\n/g, ' ') || 'AUCUNE RÉPONSE');
  check('/start ne propose aucun bouton qui serait refusé', start.refus.length === 0,
    start.refus.join(' | '));
  check('/boutique répond aussi', boutique.dit.length > 0, boutique.dit.slice(0, 40) || 'AUCUNE RÉPONSE');
  check('/boutique ne fait pas rejeter son message', boutique.refus.length === 0);
  check("/admin explique ce qui manque au lieu de se taire", /WEBAPP_URL/.test(admin.dit),
    admin.dit.slice(0, 60).replace(/\n/g, ' ') || 'AUCUNE RÉPONSE');
  check('/admin ne fait pas rejeter son message', admin.refus.length === 0);
}

/* ── Une URL en HTTP : Telegram la refuserait ─────────────── */

{
  const r = await avecUrl('http://pas-de-tls.example.com', [
    { from: CLIENT, texte: '/start' },
    { from: ADMIN, texte: '/admin' },
  ]);
  check('Une URL en HTTP ne produit aucun bouton refusé', r.every((x) => x.refus.length === 0),
    r.flatMap((x) => x.refus).join(' | '));
  check('/start répond tout de même', r[0].dit.length > 0, r[0].dit.slice(0, 40) || 'AUCUNE RÉPONSE');
  check('/admin le signale', /WEBAPP_URL/.test(r[1].dit), r[1].dit.slice(0, 50).replace(/\n/g, ' '));
}

/* ── Avec une URL correcte : les boutons reviennent ──────── */

{
  const r = await avecUrl('https://boutique.exemple.fr', [
    { from: CLIENT, texte: '/start' },
    { from: ADMIN, texte: '/admin' },
    { from: CLIENT, texte: '/admin' },
  ]);

  check('Avec une URL HTTPS, /start porte son bouton',
    r[0].boutons && r[0].refus.length === 0, `boutons ${r[0].boutons}`);
  check("/admin ouvre l'espace admin pour l'admin",
    r[1].boutons && r[1].refus.length === 0, r[1].dit.slice(0, 45));
  check("Un client n'obtient pas l'espace admin",
    /réservé/i.test(r[2].dit) && !r[2].boutons, r[2].dit.slice(0, 45));
}

/* ── Qui a le droit d'ouvrir l'espace admin ──────────────── */

const URL_OK = 'https://boutique.exemple.fr';

{
  // Le geste naturel à l'installation : on efface l'exemple d'ADMIN_IDS et on
  // ne renseigne que son ADMIN_CHAT_ID. `.env.example` promet que ça marche.
  const r = await avecUrl(URL_OK, [{ from: ADMIN, texte: '/admin' }],
    { ADMIN_IDS: '', ADMIN_CHAT_ID: String(ADMIN.id) });
  check("ADMIN_CHAT_ID seul suffit à être admin", r[0].boutons,
    r[0].dit.slice(0, 70).replace(/\n/g, ' '));
}

{
  // L'inverse, et les deux ensemble : aucune des deux ne doit masquer l'autre.
  const r = await avecUrl(URL_OK, [{ from: ADMIN, texte: '/admin' }],
    { ADMIN_IDS: String(ADMIN.id), ADMIN_CHAT_ID: '' });
  check('ADMIN_IDS seul suffit aussi', r[0].boutons);

  const deux = await avecUrl(URL_OK, [{ from: ADMIN, texte: '/admin' }],
    { ADMIN_IDS: '111,222', ADMIN_CHAT_ID: String(ADMIN.id) });
  check("ADMIN_CHAT_ID s'ajoute à une liste ADMIN_IDS déjà remplie", deux[0].boutons,
    deux[0].dit.slice(0, 60).replace(/\n/g, ' '));
}

{
  // Un refus doit donner de quoi se déclarer, pas seulement dire non.
  const r = await avecUrl(URL_OK, [{ from: CLIENT, texte: '/admin' }],
    { ADMIN_IDS: String(ADMIN.id) });
  check('Un non-admin est refusé', !r[0].boutons && /réservé/i.test(r[0].dit));
  check('Le refus lui donne son identifiant',
    r[0].dit.includes(String(CLIENT.id)), r[0].dit.slice(0, 80).replace(/\n/g, ' '));
  check('Et lui dit où le mettre', /ADMIN_IDS/.test(r[0].dit));
}

{
  // Aucun admin déclaré : le cas où la boutique n'est gérable par personne.
  const r = await avecUrl(URL_OK, [{ from: ADMIN, texte: '/admin' }],
    { ADMIN_IDS: '', ADMIN_CHAT_ID: '' });
  check("Sans aucun admin, /admin refuse", !r[0].boutons);
  check("Et le dit franchement", /[Aa]ucun administrateur/.test(r[0].dit),
    r[0].dit.slice(0, 80).replace(/\n/g, ' '));
}

{
  // Le chiffre en trop : l'erreur de recopie la plus commune, et la plus
  // pénible à voir — deux nombres de dix chiffres se ressemblent trop.
  const presque = `${CLIENT.id}9`;
  const r = await avecUrl(URL_OK, [{ from: CLIENT, texte: '/admin' }], { ADMIN_IDS: presque });
  check('Une faute de frappe à un chiffre est désignée',
    r[0].dit.includes(presque) && /faute de frappe/i.test(r[0].dit),
    r[0].dit.split('\n').filter((l) => l.includes('⚠')).join(' ').slice(0, 90));
}

{
  // Et on ne crie pas au loup quand les identifiants n'ont rien à voir.
  const r = await avecUrl(URL_OK, [{ from: CLIENT, texte: '/admin' }], { ADMIN_IDS: '111222333' });
  check("Un identifiant sans rapport ne déclenche pas l'alerte",
    !/faute de frappe/i.test(r[0].dit), r[0].dit.slice(0, 60).replace(/\n/g, ' '));
}

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Boutons Mini App : OK'}`);
process.exit(failures ? 1 : 0);
