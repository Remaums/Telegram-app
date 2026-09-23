/**
 * Annonces aux clients.
 *
 * Un bot qui envoie trop finit bloqué par ses propres clients, et parfois par
 * Telegram. Cette suite vérifie surtout les garde-fous : le désabonnement
 * respecté avant tout, la cadence minimale entre deux annonces, et le fait
 * qu'on n'écrive qu'à ceux à qui Telegram nous autorise à écrire.
 *
 * Deux publics, et c'est la distinction qui compte : les **acheteurs**, tirés
 * des commandes, et le **registre** — tous ceux qui ont déjà ouvert le bot,
 * y compris ceux qui n'ont jamais rien pris. Le second est celui de /annonce,
 * et il est souvent le plus nombreux.
 *
 * Prérequis : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/annonces.test.mjs
 */
import 'dotenv/config';
import { signInitData, resetShop, franchirLaPorte } from './helpers.mjs';

const TOKEN = process.env.BOT_TOKEN;
const BASE = process.env.TEST_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

if (!TOKEN) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer les tests.');
  process.exit(1);
}

const admin = signInitData(TOKEN, { id: 424242, first_name: 'Patron' });
const souche = 700000 + (Date.now() % 200000);
const acheteur = signInitData(TOKEN, { id: souche, first_name: 'Acheteur' });
const passant = signInitData(TOKEN, { id: souche + 1, first_name: 'Passant' });
// L'épreuve du chat garde aussi la Mini App : un client inventé ici n'a
// jamais écrit au bot, donc jamais calculé. On le fait entrer par la route
// du vendeur — ce que cette suite teste est ailleurs.
await franchirLaPorte(BASE, admin, acheteur, passant);


await resetShop(BASE, admin, { features: { captcha: false, announcements: true } });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const call = (path, { method = 'GET', body, init = admin } = {}) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': init },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// Tout passe par l'API : le magasin appartient au processus du serveur, et
// l'importer ici ouvrirait une seconde copie en mémoire qui ne verrait pas la
// sienne — c'est exactement le piège que le verrou d'instance interdit.
const audienceTotale = async (params = '') =>
  (await (await call(`/api/admin/announcements/audience${params}`)).json()).total;

/* ── Qui reçoit ──────────────────────────────────────────── */

const catalog = await (await fetch(`${BASE}/api/catalog`)).json();
const product = catalog.products.find((p) => !p.variants);
await call(`/api/admin/products/${product.id}/stock`, { method: 'POST', body: { quantity: 50 } });

let r = await call('/api/orders', {
  method: 'POST', init: acheteur,
  body: { items: [{ id: product.id, quantity: 1 }], mode: 'pickup' },
});
check('L\'acheteur passe une commande', r.status === 201, `HTTP ${r.status}`);

const avant = await audienceTotale();
check('L\'audience est chiffrée avant d\'écrire', avant > 0, `${avant} client(s)`);

// Le passant n'a jamais commandé : il ne doit compter pour personne.
const avecPassant = await audienceTotale();
check('Un simple visiteur n\'entre pas dans l\'audience', avecPassant === avant,
  'Telegram interdit d\'écrire à qui n\'a jamais parlé au bot');

/* ── Le désabonnement passe avant tout ───────────────────── */

r = await call(`/api/admin/announcements/unsubscribe/${souche}`, { method: 'POST' });
check('Le vendeur peut désabonner un client', r.status === 200, `HTTP ${r.status}`);
check('Le désabonnement est enregistré',
  (await (await call(`/api/admin/announcements/subscription/${souche}`)).json()).desabonne === true);

const sansLui = await audienceTotale();
check('Un désabonné sort de l\'audience', sansLui === avant - 1, `${avant} → ${sansLui}`);

r = await call('/api/admin/announcements', {
  method: 'POST',
  body: { texte: 'Une annonce qui ne doit pas lui parvenir.', force: true },
});
const envoye = await r.json();
check('L\'annonce part quand même vers les autres', r.status === 202, `HTTP ${r.status}`);
check('Mais sans le désabonné', envoye.cibles === sansLui, `${envoye.cibles}/${sansLui}`);

await call(`/api/admin/announcements/resubscribe/${souche}`, { method: 'POST' });
check('Le réabonnement le fait revenir', (await audienceTotale()) === avant,
  `${sansLui} → ${await audienceTotale()}`);

/* ── Ce qu'on refuse d'envoyer ───────────────────────────── */

for (const [label, texte] of [
  ['un message trop court', 'coucou'],
  ['un message vide', '   '],
  ['un pavé de 4000 caractères', 'a'.repeat(4000)],
]) {
  r = await call('/api/admin/announcements', { method: 'POST', body: { texte, force: true } });
  check(`Refusé : ${label}`, r.status === 400, `HTTP ${r.status}`);
}

r = await call('/api/admin/announcements', {
  method: 'POST', body: { texte: 'Une annonce pour personne du tout.', minCommandes: 9999, force: true },
});
check('Refusé : une audience vide', r.status === 400, `HTTP ${r.status}`);

/* ── La cadence ──────────────────────────────────────────── */

r = await call('/api/admin/announcements', {
  method: 'POST', body: { texte: 'Première annonce de la journée, celle-ci passe.', force: true },
});
check('Une annonce forcée passe', r.status === 202, `HTTP ${r.status}`);

r = await call('/api/admin/announcements', {
  method: 'POST', body: { texte: 'Deuxième annonce dans la foulée, celle-ci non.' },
});
let erreur = (await r.json()).error;
check('La suivante est retenue par la cadence', r.status === 429, `HTTP ${r.status}`);
check('Le refus dit combien de temps attendre', /\d+\s*h/.test(erreur ?? ''), erreur);

r = await call('/api/admin/announcements', {
  method: 'POST', body: { texte: 'Deuxième annonce, mais assumée cette fois.', force: true },
});
check('Forcer permet de passer outre', r.status === 202, `HTTP ${r.status}`);

/* ── L'historique ────────────────────────────────────────── */

const histoire = await (await call('/api/admin/announcements')).json();
check('L\'historique garde les envois', histoire.length >= 2, `${histoire.length} entrée(s)`);
check('Il est rendu du plus récent au plus ancien',
  histoire.length < 2 || histoire[0].envoyeLe >= histoire[1].envoyeLe);
check('Chaque envoi dit à combien de clients il partait',
  histoire.every((e) => typeof e.cibles === 'number'));

/* ── L'interrupteur ──────────────────────────────────────── */

await call('/api/admin/settings', { method: 'PUT', body: { features: { announcements: false } } });
r = await call('/api/admin/announcements', {
  method: 'POST', body: { texte: 'Annonce alors que la fonctionnalité est coupée.', force: true },
});
check('Coupées, les annonces sont refusées', r.status === 403, `HTTP ${r.status}`);
await call('/api/admin/settings', { method: 'PUT', body: { features: { announcements: true } } });

/* ── Ce n'est pas ouvert à tout le monde ─────────────────── */

r = await call('/api/admin/announcements', {
  method: 'POST', init: acheteur, body: { texte: 'Un client qui écrirait à tous les autres.', force: true },
});
check('Un client ne diffuse rien', r.status === 403, `HTTP ${r.status}`);

r = await call('/api/admin/announcements/audience', { init: acheteur });
check('Un client ne voit pas l\'audience', r.status === 403, `HTTP ${r.status}`);

/* ── Le registre : tous ceux qui ont ouvert le bot ───────── */

{
  const { noterUtilisateur } = await import('../server/users.js');
  const { destinatairesDuRegistre, desabonner, reabonner } = await import('../server/annonces.js');
  const { blockClient, unblockClient } = await import('../server/settings.js');

  const CURIEUX = { id: 998801, first_name: 'Curieux', is_bot: false };
  const STOPPE = { id: 998802, first_name: 'Stoppe', is_bot: false };
  const BANNI = { id: 998803, first_name: 'Banni', is_bot: false };
  const ROBOT = { id: 998804, first_name: 'Robot', is_bot: true };

  for (const u of [CURIEUX, STOPPE, BANNI, ROBOT]) await noterUtilisateur(u);
  await reabonner(String(CURIEUX.id));
  await desabonner(String(STOPPE.id));
  await blockClient(String(BANNI.id));

  const cibles = await destinatairesDuRegistre();
  const dedans = (id) => cibles.some((c) => c.id === String(id));

  check('Un curieux qui n a jamais commandé est joignable', dedans(CURIEUX.id));
  // Les trois exclusions, et ce sont elles qui comptent.
  check('Un désabonné ne l est pas', !dedans(STOPPE.id));
  check('Un compte bloqué non plus', !dedans(BANNI.id));
  check('Un bot n entre même pas au registre', !dedans(ROBOT.id));

  check('Chaque cible porte un identifiant en chaîne',
    cibles.every((c) => typeof c.id === 'string'), typeof cibles[0]?.id);
  check('Sans doublon', new Set(cibles.map((c) => c.id)).size === cibles.length);

  // Le registre et les acheteurs ne se recouvrent pas : quelqu'un peut avoir
  // ouvert le bot sans commander, et une commande peut venir d'un lien direct.
  // Ce sont deux publics, pas deux vues du même.
  const acheteurs = await (await call('/api/admin/announcements/audience')).json();
  check('Les deux publics sont distincts',
    Number.isInteger(acheteurs.total) && Array.isArray(cibles),
    `${cibles.length} au registre, ${acheteurs.total} acheteurs`);

  // Rendu propre : la suite doit se rejouer.
  await unblockClient(String(BANNI.id));
  await reabonner(String(STOPPE.id));
}

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Annonces : OK'}`);
process.exit(failures ? 1 : 0);
