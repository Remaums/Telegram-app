/**
 * Supprimer une commande de l'historique : le propriétaire seul.
 *
 * Le propriétaire, c'est l'administrateur déclaré dans le `.env`. Un
 * administrateur ajouté depuis le bot gère les commandes, mais il ne peut ni
 * en supprimer une, ni passer par les portes de derrière qui feraient la même
 * chose : l'effacement en masse et la restauration d'une sauvegarde, qui
 * remplace tout l'historique.
 *
 * Ce que la suite protège :
 *
 * - **le refus est côté serveur** : un administrateur ajouté qui envoie la
 *   requête à la main reçoit un 403, et la commande est toujours là ;
 * - **supprimer, c'est pour tout le monde** : la commande disparaît de la
 *   liste des administrateurs et de « Mes commandes » chez le client ;
 * - **l'avis part aussi** : le message qui annonçait la commande dans la
 *   conversation du vendeur est retiré, et quand Telegram refuse, la
 *   suppression tient quand même et l'écran le sait ;
 * - **supprimer n'est pas annuler** : le stock ne bouge pas.
 *
 * Comme `clefs.test.mjs`, le scénario tourne dans un seul processus : un
 * administrateur ajouté ici ne serait pas vu d'un serveur lancé à côté, le
 * magasin JSON gardant ses données en mémoire. L'application Express est
 * donc montée ici, sur un port libre, avec un faux Telegram.
 *
 * Usage :  BOT_TOKEN=… node test/suppression.test.mjs
 */
import 'dotenv/config';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const MOI = fileURLToPath(import.meta.url);
const RACINE = path.join(path.dirname(MOI), '..');
const PATRON = 424242;
const RECRUE = { id: 556677, first_name: 'Nina', username: 'nina_np' };

/* ══ Rôle « ouvrier » : la vraie application, un faux Telegram ══ */

if (process.env.SUPPRESSION_OUVRIER) {
  const { app } = await import('../server/index.js');
  const { bot } = await import('../server/bot.js');
  const { notifyAdmin } = await import('../server/bot.js');
  const { ajouterAdmin, retirerAdmin } = await import('../server/admins.js');
  const { createOrder, getOrder, listOrders } = await import('../server/orders.js');
  const { getCatalog } = await import('../server/catalog.js');
  const { signInitData } = await import('./helpers.mjs');

  const appels = [];
  let telegramRefuse = false;
  bot.api.config.use(async (prev, methode, charge) => {
    appels.push({ methode, charge });
    if (methode === 'deleteMessage' && telegramRefuse) {
      return { ok: false, error_code: 400, description: "Bad Request: message can't be deleted" };
    }
    if (methode === 'deleteMessage') return { ok: true, result: true };
    return { ok: true, result: { message_id: 7000 + appels.length, date: 0, chat: { id: charge.chat_id ?? 0, type: 'private' } } };
  });

  const serveur = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${serveur.address().port}`;

  const appeler = async (qui, chemin, { method = 'GET', body } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (qui) headers['X-Telegram-Init-Data'] = signInitData(process.env.BOT_TOKEN, qui);
    const res = await fetch(`${base}/api/admin${chemin}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  const patron = { id: PATRON, first_name: 'Patron' };
  const client = { id: 800000000 + Math.floor(Math.random() * 99999999), first_name: 'Client' };

  const { products } = await getCatalog();
  const produit = products.find((p) => typeof p.stock === 'number');
  if (!produit) throw new Error('Aucun produit à stock chiffré : le contrôle du stock ne prouverait rien.');
  const stockDe = async () => (await getCatalog()).products.find((p) => p.id === produit.id)?.stock;

  const passer = () =>
    createOrder({
      user: client,
      items: [{ id: produit.id, name: produit.name, quantity: 1, unitPrice: 100, lineTotal: 100 }],
      subtotal: 100, total: 100, contact: 'test suppression',
    });

  const vu = {};
  await retirerAdmin(String(RECRUE.id)).catch(() => {});
  await ajouterAdmin(RECRUE.id, { par: PATRON, nom: RECRUE.first_name });

  try {
    const premiere = await passer();
    const seconde = await passer();
    appels.length = 0;
    await notifyAdmin(premiere);
    const avis = appels.find((a) => a.methode === 'sendMessage');
    const idAvis = 7000 + appels.indexOf(avis) + 1;

    // L'écran sait à qui montrer les boutons.
    vu.sessionPatron = (await appeler(patron, '/session')).data.proprietaire;
    vu.sessionRecrue = (await appeler(RECRUE, '/session')).data.proprietaire;
    vu.recrueLitLesCommandes = (await appeler(RECRUE, '/orders')).status;

    // Un administrateur ajouté qui envoie la requête à la main.
    const refus = await appeler(RECRUE, `/orders/${premiere.reference}`, { method: 'DELETE' });
    vu.recrueRefusee = refus.status;
    vu.recrueRefusDitPourquoi = /\.env/.test(refus.data.error ?? '');
    vu.toujoursLaApresRefus = Boolean(await getOrder(premiere.reference));

    // Les portes de derrière. Des requêtes qui n'effaceraient rien même
    // acceptées : une date d'avant l'ouverture, une sauvegarde vide — le code
    // de retour suffit à dire si la porte est fermée.
    vu.purgeRecrue = (await appeler(RECRUE, '/orders/purge', {
      method: 'POST', body: { mode: 'avant', avant: '2000-01-01', confirmation: 'EFFACER', sauvegarde: false },
    })).status;
    vu.restaurationRecrue = (await appeler(RECRUE, '/backup/restore', { method: 'POST', body: {} })).status;

    // Ni un client, ni quelqu'un sans signature.
    vu.clientRefuse = (await appeler(client, `/orders/${premiere.reference}`, { method: 'DELETE' })).status;
    vu.anonymeRefuse = (await appeler(null, `/orders/${premiere.reference}`, { method: 'DELETE' })).status;
    vu.toujoursLaApresIntrus = Boolean(await getOrder(premiere.reference));

    // Le propriétaire supprime.
    const stockAvant = await stockDe();
    appels.length = 0;
    const fait = await appeler(patron, `/orders/${premiere.reference}`, { method: 'DELETE' });
    vu.patronSupprime = fait.status;
    vu.avisRetire = fait.data.avis;
    const effacement = appels.find((a) => a.methode === 'deleteMessage');
    vu.bonMessageEfface = effacement
      ? String(effacement.charge.chat_id) === String(PATRON) && effacement.charge.message_id === idAvis
      : false;
    vu.disparueDuMagasin = (await getOrder(premiere.reference)) === null;
    const listeAdmin = (await appeler(patron, '/orders')).data;
    vu.disparueDeLaListeAdmin = Array.isArray(listeAdmin) && !listeAdmin.some((o) => o.reference === premiere.reference);
    vu.disparueChezLeClient = !(await listOrders({ userId: client.id })).some((o) => o.reference === premiere.reference);
    vu.laVoisineReste = Boolean(await getOrder(seconde.reference));
    vu.stockIntact = (await stockDe()) === stockAvant;

    vu.deuxFois = (await appeler(patron, `/orders/${premiere.reference}`, { method: 'DELETE' })).status;

    // Une commande sans avis connu (passée avant ce suivi, ou sans ADMIN_CHAT_ID).
    appels.length = 0;
    vu.sansAvis = (await appeler(patron, `/orders/${seconde.reference}`, { method: 'DELETE' })).data.avis;
    vu.sansAvisNAppellePasTelegram = !appels.some((a) => a.methode === 'deleteMessage');

    // Telegram refuse (message de plus de 48 heures, ou déjà effacé à la main).
    const troisieme = await passer();
    await notifyAdmin(troisieme);
    telegramRefuse = true;
    const refusee = await appeler(patron, `/orders/${troisieme.reference}`, { method: 'DELETE' });
    telegramRefuse = false;
    vu.refusTelegramStatut = refusee.status;
    vu.refusTelegramAvis = refusee.data.avis;
    vu.refusTelegramSupprimeQuandMeme = (await getOrder(troisieme.reference)) === null;
  } finally {
    await retirerAdmin(String(RECRUE.id)).catch(() => {});
    serveur.close();
  }

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
  env: {
    ...process.env, SUPPRESSION_OUVRIER: '1',
    ADMIN_IDS: String(PATRON), ADMIN_CHAT_ID: String(PATRON), BOT_TOKEN: TOKEN,
  },
});
const ligne = stdout.split('\n').reverse().find((l) => l.trim().startsWith('{'));
const vu = ligne ? JSON.parse(ligne) : {};

console.log('\n── Qui voit le bouton ──────────────────────────────');
check('Le propriétaire est reconnu comme tel', vu.sessionPatron === true);
check('Un administrateur ajouté ne l est pas', vu.sessionRecrue === false, String(vu.sessionRecrue));
check('Mais il lit toujours les commandes', vu.recrueLitLesCommandes === 200, `HTTP ${vu.recrueLitLesCommandes}`);

console.log('\n── Qui peut supprimer ──────────────────────────────');
check('Un administrateur ajouté est refusé', vu.recrueRefusee === 403, `HTTP ${vu.recrueRefusee}`);
check('Et le refus dit pourquoi', vu.recrueRefusDitPourquoi === true);
check('La commande est toujours là', vu.toujoursLaApresRefus === true);
check('Pas d effacement en masse par la porte de derrière', vu.purgeRecrue === 403, `HTTP ${vu.purgeRecrue}`);
check('Ni de restauration qui remplacerait l historique', vu.restaurationRecrue === 403, `HTTP ${vu.restaurationRecrue}`);
check('Un client est refusé', vu.clientRefuse === 403, `HTTP ${vu.clientRefuse}`);
check('Une requête sans signature aussi', vu.anonymeRefuse === 401, `HTTP ${vu.anonymeRefuse}`);
check('La commande a survécu aux intrus', vu.toujoursLaApresIntrus === true);

console.log('\n── Ce que fait la suppression ──────────────────────');
check('Le propriétaire supprime', vu.patronSupprime === 200, `HTTP ${vu.patronSupprime}`);
check('La commande quitte le magasin', vu.disparueDuMagasin === true);
check('Et la liste des administrateurs', vu.disparueDeLaListeAdmin === true);
check('Et « Mes commandes » chez le client', vu.disparueChezLeClient === true);
check('Sans emporter sa voisine', vu.laVoisineReste === true);
check('Le stock ne bouge pas : supprimer n est pas annuler', vu.stockIntact === true);
check('Supprimer deux fois : introuvable', vu.deuxFois === 404, `HTTP ${vu.deuxFois}`);

console.log('\n── L avis dans la conversation du vendeur ──────────');
check('L avis de la commande est retiré', vu.avisRetire === 'retire', String(vu.avisRetire));
check('C est bien ce message-là, dans cette conversation-là', vu.bonMessageEfface === true);
check('Sans avis connu, on le dit', vu.sansAvis === 'aucun', String(vu.sansAvis));
check('Et on ne dérange pas Telegram pour rien', vu.sansAvisNAppellePasTelegram === true);
check('Telegram refuse : la suppression tient', vu.refusTelegramStatut === 200 && vu.refusTelegramSupprimeQuandMeme === true,
  `HTTP ${vu.refusTelegramStatut}`);
check('Et l écran sait qu il reste un message à effacer', vu.refusTelegramAvis === 'impossible', String(vu.refusTelegramAvis));

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Suppression des commandes : OK'}`);
process.exit(failures ? 1 : 0);
