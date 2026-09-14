/**
 * Les clés de la boutique : qui peut ouvrir l'espace admin.
 *
 * Donner les clés, c'est donner toutes les commandes, toutes les fiches
 * clients, le catalogue et le droit d'effacer l'historique. Cette suite
 * protège donc surtout les refus — un non-administrateur qui distribue des
 * accès, un intrus qui touche le bouton de confirmation, un identifiant du
 * `.env` qu'une conversation pourrait retirer.
 *
 * Ce dernier point est le plus important : le `.env` est la racine de
 * confiance, il vit sur le serveur. Si le bot pouvait l'entamer, il suffirait
 * d'une session ouverte sur un téléphone perdu pour mettre le propriétaire
 * dehors de sa propre boutique, sans recours.
 *
 * Le scénario complet tourne dans un seul processus, parce que c'est la seule
 * façon honnête de le vérifier : le magasin JSON garde ses données en mémoire,
 * donc un ajout fait ici ne serait pas vu par un serveur lancé à côté. Le bot
 * ajoute, et c'est `requireAdmin` — le vrai, celui de l'espace admin — qui est
 * interrogé juste après.
 *
 * Usage :  BOT_TOKEN=… node test/clefs.test.mjs
 */
import 'dotenv/config';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const MOI = fileURLToPath(import.meta.url);
const RACINE = path.join(path.dirname(MOI), '..');
const PATRON = 424242;
const RECRUE = { id: 555777, first_name: 'Sofia', username: 'sofia_np' };
const INTRUS = { id: 555888, first_name: 'Intrus' };

/* ══ Rôle « ouvrier » : le vrai bot et le vrai portier ═════ */

if (process.env.CLEFS_OUVRIER) {
  const { bot } = await import('../server/bot.js');
  const { ouvrirLaPorte } = await import('../server/bot-captcha.js');
  const { estAdmin, listerAdmins, retirerAdmin } = await import('../server/admins.js');
  const { noterUtilisateur } = await import('../server/users.js');
  const { requireAdmin } = await import('../server/admin.js');
  const { signInitData } = await import('./helpers.mjs');

  const partis = [];
  bot.api.config.use(async (prev, methode, charge) => {
    partis.push({ chat: String(charge.chat_id ?? ''), texte: charge.text ?? '', clavier: charge.reply_markup });
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

  for (const id of [RECRUE.id, INTRUS.id]) await ouvrirLaPorte(id);
  // La recrue a déjà écrit au bot : c'est ce qui permet de la retrouver par
  // pseudo, Telegram ne le faisant pas pour le compte d'un bot.
  await noterUtilisateur({ ...RECRUE, is_bot: false });
  await retirerAdmin(String(RECRUE.id)).catch(() => {});

  let compteur = 9000;
  const envoyer = async (from, texte) => {
    partis.length = 0;
    await bot.handleUpdate({
      update_id: ++compteur,
      message: {
        message_id: compteur, date: Math.floor(Date.now() / 1000),
        chat: { id: from.id, type: 'private' }, from: { is_bot: false, ...from }, text: texte,
        entities: texte.startsWith('/')
          ? [{ type: 'bot_command', offset: 0, length: texte.split(' ')[0].length }] : [],
      },
    });
    return [...partis];
  };
  const toucher = async (from, data) => {
    partis.length = 0;
    await bot.handleUpdate({
      update_id: ++compteur,
      callback_query: {
        id: String(compteur), from: { is_bot: false, ...from }, chat_instance: 'x', data,
        message: { message_id: compteur - 1, date: 0, chat: { id: from.id, type: 'private' }, text: 'confirmation' },
      },
    });
    return [...partis];
  };

  /** Interroge le vrai portier de l'espace admin, sans passer par le réseau. */
  const portier = (id) =>
    new Promise((resolve) => {
      const req = {
        get: () => signInitData(process.env.BOT_TOKEN, { id, first_name: 'Qui' }),
      };
      const res = {
        status(code) { this.code = code; return this; },
        json() { resolve(this.code); },
      };
      requireAdmin(req, res, (err) => resolve(err ? 500 : 200));
    });

  const vu = {};

  // Un non-administrateur ne distribue pas d'accès.
  await envoyer(INTRUS, `/addadmin ${RECRUE.id}`);
  vu.intrusNAjoutePas = !(await estAdmin(RECRUE.id));
  vu.intrusRefuse = (await envoyer(INTRUS, '/admins'))
    .some((p) => /réservée à l'administrateur/.test(p.texte));

  // Le patron demande, et rien n'est encore fait : l'ajout passe par une
  // confirmation, parce qu'un identifiant mal recopié donnerait la boutique.
  const demande = await envoyer({ id: PATRON, first_name: 'Patron' }, '/addadmin @sofia_np');
  vu.demandeConfirmation = demande.some((p) => Boolean(p.clavier));
  vu.rienAvantConfirmation = !(await estAdmin(RECRUE.id));
  vu.boutonPorteLId = JSON.stringify(demande.find((p) => p.clavier)?.clavier)
    .includes(`adm+:${RECRUE.id}`);

  // Un pseudo que le bot n'a jamais vu : le refus doit dire quoi faire.
  vu.pseudoInconnuExplique = (await envoyer({ id: PATRON, first_name: 'Patron' }, '/addadmin @jamais_vu_ici'))
    .some((p) => /\/start/.test(p.texte));

  // Un intrus qui touche le bouton de confirmation ne s'ouvre pas la porte.
  await toucher(INTRUS, `adm+:${RECRUE.id}`);
  vu.intrusNeConfirmePas = !(await estAdmin(RECRUE.id));

  // Annuler n'ajoute personne.
  await toucher({ id: PATRON, first_name: 'Patron' }, 'adm:non');
  vu.annulerNAjoutePas = !(await estAdmin(RECRUE.id));

  // Avant l'ajout, l'espace admin lui est fermé.
  vu.portierAvant = await portier(RECRUE.id);

  // Le patron confirme.
  const confirme = await toucher({ id: PATRON, first_name: 'Patron' }, `adm+:${RECRUE.id}`);
  vu.ajoutee = await estAdmin(RECRUE.id);
  vu.recruePrevenue = confirme.some((p) => p.chat === String(RECRUE.id) && /administrateur/.test(p.texte));
  // Le point qui compte : l'espace admin s'ouvre vraiment, sans redémarrage.
  vu.portierApres = await portier(RECRUE.id);
  vu.recrueLitLaListe = (await envoyer(RECRUE, '/admins')).some((p) => /administrateur/.test(p.texte));

  // Deux fois la même personne, et un identifiant qui n'en est pas un.
  vu.doublonRefuse = (await envoyer({ id: PATRON, first_name: 'Patron' }, `/addadmin ${RECRUE.id}`))
    .some((p) => /déjà administrateur/.test(p.texte));
  vu.identifiantInvalide = (await envoyer({ id: PATRON, first_name: 'Patron' }, '/addadmin !!!'))
    .some((p) => /identifiant numérique|pseudo/.test(p.texte));

  // LE point dur : un administrateur du .env ne se retire pas depuis le bot.
  const tentative = await envoyer({ id: PATRON, first_name: 'Patron' }, `/deladmin ${PATRON}`);
  vu.envIntouchable = await estAdmin(PATRON);
  vu.envExplique = tentative.some((p) => /\.env/.test(p.texte));

  // Retirer la recrue referme la porte, tout de suite.
  const retrait = await envoyer({ id: PATRON, first_name: 'Patron' }, '/deladmin @sofia_np');
  vu.retiree = !(await estAdmin(RECRUE.id));
  vu.retraitAnnonce = retrait.some((p) => p.chat === String(RECRUE.id));
  vu.portierApresRetrait = await portier(RECRUE.id);
  vu.listeFinale = (await listerAdmins()).map((a) => `${a.id}:${a.source}`).join(',');

  console.log(JSON.stringify(vu));
  process.exit(0);
}

/* ══ Rôle « chef » : pose le scénario, juge les retours ═══ */

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer les tests.');
  process.exit(1);
}

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const run = promisify(execFile);
const { stdout } = await run('node', [MOI], {
  cwd: RACINE,
  env: { ...process.env, CLEFS_OUVRIER: '1', ADMIN_IDS: String(PATRON), ADMIN_CHAT_ID: String(PATRON), BOT_TOKEN: TOKEN },
});
const ligne = stdout.split('\n').reverse().find((l) => l.trim().startsWith('{'));
const vu = ligne ? JSON.parse(ligne) : {};

console.log('\n── Qui peut distribuer les clés ────────────────────');
check('Un non-administrateur ne peut pas en ajouter un', vu.intrusNAjoutePas === true);
check('Ni même lire la liste', vu.intrusRefuse === true);

console.log('\n── L ajout passe par une confirmation ──────────────');
check('Le bot demande confirmation avant de donner les clés', vu.demandeConfirmation === true);
check('Rien n est fait tant qu on n a pas confirmé', vu.rienAvantConfirmation === true);
check('Le bouton porte bien l identifiant visé', vu.boutonPorteLId === true);
check('Annuler n ajoute personne', vu.annulerNAjoutePas === true);
check('Un intrus ne confirme pas à la place du patron', vu.intrusNeConfirmePas === true);

console.log('\n── Ce que l ajout ouvre vraiment ───────────────────');
check('Avant, l espace admin lui est fermé', vu.portierAvant === 403, `HTTP ${vu.portierAvant}`);
check('Après confirmation, elle est administratrice', vu.ajoutee === true);
check('Et l espace admin s ouvre, sans redémarrage', vu.portierApres === 200, `HTTP ${vu.portierApres}`);
check('Elle est prévenue qu elle a les clés', vu.recruePrevenue === true);
check('Et elle peut lire la liste', vu.recrueLitLaListe === true);

console.log('\n── Ce qu on refuse ─────────────────────────────────');
check('Ajouter deux fois la même personne', vu.doublonRefuse === true);
check('Un identifiant qui n en est pas un', vu.identifiantInvalide === true);
check('Un pseudo inconnu : le refus dit quoi faire', vu.pseudoInconnuExplique === true);

console.log('\n── La racine de confiance ──────────────────────────');
check('Un administrateur du .env ne se retire pas depuis le bot', vu.envIntouchable === true);
check('Et le refus dit pourquoi', vu.envExplique === true);

console.log('\n── Reprendre les clés ──────────────────────────────');
check('Le retrait fonctionne', vu.retiree === true);
check('L intéressée est prévenue', vu.retraitAnnonce === true);
check('Et l espace admin se referme aussitôt', vu.portierApresRetrait === 403, `HTTP ${vu.portierApresRetrait}`);
check('Il ne reste que le .env', vu.listeFinale === `${PATRON}:fichier`, String(vu.listeFinale));

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Clés de la boutique : OK'}`);
process.exit(failures ? 1 : 0);
