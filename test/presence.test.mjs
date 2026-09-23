/**
 * Qui est dans la boutique en ce moment.
 *
 * ⚠️ Ce n'est pas le « en ligne » de Telegram, et la suite le vérifie surtout
 * par ce qu'elle ne teste pas : **Telegram ne donne pas le statut en ligne aux
 * bots.** Aucune méthode, aucun contournement. Ce qu'on mesure, c'est ce qui se
 * passe chez nous — un message reçu, une boutique ouverte — et le libellé doit
 * dire « actif », jamais « en ligne », partout où le chiffre s'affiche.
 *
 * Ce que cette suite protège :
 *
 * - la fenêtre : passé le délai, on n'est plus là, et la liste ne garde pas les
 *   fantômes ;
 * - la borne mémoire, sans laquelle la présence deviendrait elle-même le moyen
 *   de faire enfler le serveur ;
 * - l'exclusion des administrateurs, parce que « 1 actif » quand on est seul
 *   dans sa boutique est une fausse joie, pas une information ;
 * - la porte : savoir qui regarde le catalogue ne regarde pas les clients.
 *
 * Prérequis (partie HTTP) : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/presence.test.mjs
 */
import 'dotenv/config';
import {
  noterPassage, estActif, actifs, visites, clientsActifs, visitesDesClients,
  oublierTout, taille, FENETRE_MS, MEMOIRE_MS,
} from '../server/presence.js';
import { signInitData, franchirLaPorte } from './helpers.mjs';

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

console.log('\n── La fenêtre ──────────────────────────────────────');

{
  oublierTout();
  const maintenant = Date.now();

  noterPassage('a', 'boutique', maintenant);
  check('Un passage à l instant compte', estActif('a', maintenant));
  check('Une seconde avant la fin de fenêtre aussi',
    estActif('a', maintenant + FENETRE_MS - 1000));
  check('Une seconde après, non', !estActif('a', maintenant + FENETRE_MS + 1000));
  check('Quelqu un qui n est jamais venu non plus', !estActif('jamais', maintenant));
  check('Un identifiant vide ne crée personne',
    (noterPassage('', 'boutique', maintenant), actifs(maintenant).length === 1));
}

{
  // Le ménage se fait à la lecture, pas sur une minuterie : une minuterie qui
  // tourne pour personne est du travail que le serveur fait pour rien.
  oublierTout();
  const vieux = Date.now() - FENETRE_MS - 1000;
  for (let i = 0; i < 5; i += 1) noterPassage(`mort-${i}`, 'boutique', vieux);
  noterPassage('vivant', 'boutique');

  const vus = actifs();
  check('La liste ne garde que les vivants', vus.length === 1 && vus[0].id === 'vivant',
    vus.map((v) => v.id).join(','));
  check('Et les périmés sont bien oubliés, pas seulement masqués',
    (noterPassage('autre', 'boutique'), actifs().length === 2));
}

{
  oublierTout();
  const maintenant = Date.now();
  noterPassage('vieux', 'boutique', maintenant - 60_000);
  noterPassage('neuf', 'boutique', maintenant);
  const vus = actifs(maintenant);
  check('Le plus récemment vu vient en tête', vus[0].id === 'neuf', vus.map((v) => v.id).join(','));
  check('Et chacun porte son ancienneté en secondes', vus[1].depuis === 60, String(vus[1].depuis));
}

{
  // D'où vient le signe de vie : les deux ne se valent pas pour un vendeur.
  oublierTout();
  noterPassage('client', 'boutique');
  noterPassage('bavard', 'conversation');
  const vus = actifs();
  check('On sait qui est dans la boutique',
    vus.find((v) => v.id === 'client')?.ou === 'boutique');
  check('Et qui est dans la conversation',
    vus.find((v) => v.id === 'bavard')?.ou === 'conversation');
}

console.log('\n── La traîne des trente minutes ────────────────────');

{
  // « Là maintenant » et « passé récemment » sont deux questions, pas deux
  // magasins : c'est la même mémoire, lue sur deux fenêtres.
  oublierTout();
  const T = Date.now();
  noterPassage('ici', 'boutique', T);
  noterPassage('parti', 'boutique', T - 12 * 60 * 1000);
  noterPassage('presque', 'conversation', T - 29 * 60 * 1000);
  noterPassage('oublie', 'boutique', T - 31 * 60 * 1000);

  const vus = visites({ maintenant: T });
  const ids = vus.map((v) => v.id);

  check('La traîne garde une demi-heure', ids.includes('presque'), ids.join(','));
  check('Et oublie au-delà', !ids.includes('oublie'), ids.join(','));
  check('Du plus frais au plus ancien', ids.join(',') === 'ici,parti,presque', ids.join(','));

  check('Celui qui est encore là est marqué actif', vus.find((v) => v.id === 'ici')?.actif === true);
  check('Celui d il y a douze minutes ne l est pas',
    vus.find((v) => v.id === 'parti')?.actif === false);
  check('Mais il figure quand même dans la traîne', ids.includes('parti'));

  // La distinction est ce qui rend l'écran lisible : « actifs » n'est qu'un
  // sous-ensemble de « visites ».
  const ici = actifs(T).map((v) => v.id);
  check('« Actifs » reste le sous-ensemble court', ici.join(',') === 'ici', ici.join(','));

  check('Chaque visite porte son ancienneté en secondes',
    vus.find((v) => v.id === 'parti')?.depuis === 720,
    String(vus.find((v) => v.id === 'parti')?.depuis));
  check('Et d où venait le signe de vie',
    vus.find((v) => v.id === 'presque')?.ou === 'conversation');

  // Une fenêtre plus large que la mémoire ne ressuscite personne.
  check('On ne peut pas demander plus loin que la mémoire',
    visites({ depuisMs: MEMOIRE_MS * 10, maintenant: T }).length === 3);
}

{
  // Le ménage doit vraiment libérer la mémoire, pas seulement masquer les
  // périmés à la lecture. Sans ce contrôle, la mémoire pouvait enfler en
  // silence pendant que l'écran affichait les bons chiffres.
  oublierTout();
  const T = Date.now();
  for (let i = 0; i < 50; i += 1) noterPassage(`vieux-${i}`, 'boutique', T - 31 * 60 * 1000);
  noterPassage('frais', 'boutique', T);

  check('Les périmés occupent la mémoire avant lecture', taille() === 51, String(taille()));
  visites({ maintenant: T });
  check('La lecture les évacue pour de bon', taille() === 1, `${taille()} en mémoire`);
}

{
  // Revenir trois fois en vingt minutes n'est pas passer une fois : c'est
  // souvent quelqu'un qui hésite devant un produit.
  oublierTout();
  const T = Date.now();
  for (let i = 0; i < 3; i += 1) noterPassage('revient', 'boutique', T - (20 - i * 5) * 60 * 1000);

  const lui = visites({ maintenant: T })[0];
  check('Les passages répétés sont comptés', lui.passages === 3, String(lui.passages));
  check('Et la date retenue est la dernière', lui.depuis === 600, String(lui.depuis));

  // Passé la mémoire, le compteur repart : sinon un habitué finirait avec des
  // centaines de passages qui ne veulent plus rien dire.
  oublierTout();
  noterPassage('lointain', 'boutique', T - 40 * 60 * 1000);
  noterPassage('lointain', 'boutique', T);
  check('Un retour après la mémoire repart de un',
    visites({ maintenant: T })[0].passages === 1);
}

console.log('\n── Les administrateurs ne se comptent pas ──────────');

{
  oublierTout();
  noterPassage('424242', 'conversation');
  noterPassage('client-1', 'boutique');

  check('Le vendeur est bien noté comme présent', estActif('424242'));
  const clients = clientsActifs(['424242']);
  check('Mais il ne figure pas dans les clients actifs',
    clients.length === 1 && clients[0].id === 'client-1', clients.map((c) => c.id).join(','));
  check('Seul dans sa boutique, le vendeur voit zéro client',
    (oublierTout(), noterPassage('424242', 'conversation'), clientsActifs(['424242']).length === 0));

  // Et il ne s'y compte pas non plus dans la traîne : sinon il se verrait
  // passer toute la journée dans sa propre liste de visites.
  oublierTout();
  const T = Date.now();
  noterPassage('424242', 'conversation', T - 10 * 60 * 1000);
  noterPassage('client-2', 'boutique', T - 10 * 60 * 1000);
  const trainee = visitesDesClients(['424242'], { maintenant: T });
  check('Ni dans la traîne des trente minutes',
    trainee.length === 1 && trainee[0].id === 'client-2', trainee.map((v) => v.id).join(','));
}

console.log('\n── La mémoire est bornée ───────────────────────────');

{
  oublierTout();
  for (let i = 0; i < 2600; i += 1) noterPassage(`foule-${i}`, 'boutique');
  const suivis = actifs().length;
  check('Le suivi est plafonné', suivis <= 2000, `${suivis} suivis pour 2600 passages`);
  check('Et ce sont les derniers arrivés qui restent', estActif('foule-2599'));
}

console.log('\n── Ce que voit le vendeur ──────────────────────────');

const ADMIN = signInitData(TOKEN, { id: 424242, first_name: 'Patron' });
const CLIENT = signInitData(TOKEN, { id: 999501, first_name: 'Passant' });
// L'épreuve du chat garde aussi la Mini App : un client inventé ici n'a
// jamais écrit au bot, donc jamais calculé. On le fait entrer par la route
// du vendeur — ce que cette suite teste est ailleurs.
await franchirLaPorte(BASE, ADMIN, CLIENT);
const h = (qui) => ({ 'Content-Type': 'application/json', 'X-Telegram-Init-Data': qui });

// Un appel signé suffit : c'est la porte d'entrée qui note le passage, pas
// chaque route — une route ajoutée demain sera comptée sans qu'on y pense.
await fetch(`${BASE}/api/orders`, { headers: h(CLIENT) });

let r = await fetch(`${BASE}/api/admin/presence`, { headers: h(ADMIN) });
const vu = await r.json();
check('La présence se lit depuis le panel', r.status === 200, `HTTP ${r.status}`);
check('Un appel signé a suffi à marquer le passage',
  vu.actifs.some((a) => String(a.id) === '999501'), `${vu.total} actif(s)`);
check('La fenêtre « actif » voyage avec la réponse',
  vu.fenetreSecondes === Math.round(FENETRE_MS / 1000), String(vu.fenetreSecondes));
check('La mémoire aussi',
  vu.memoireSecondes === Math.round(MEMOIRE_MS / 1000), String(vu.memoireSecondes));
check('La traîne est rendue à part des actifs',
  Array.isArray(vu.visites) && Number.isInteger(vu.visitesTotal),
  `${vu.total} actif(s), ${vu.visitesTotal} visite(s)`);
check('Et les actifs en sont un sous-ensemble',
  vu.actifs.every((a) => vu.visites.some((v) => v.id === a.id)) && vu.total <= vu.visitesTotal);
check('Chaque visite dit si elle est encore active',
  vu.visites.every((v) => typeof v.actif === 'boolean'));
check("Le vendeur ne s'y compte pas lui-même",
  !vu.actifs.some((a) => String(a.id) === '424242'));

r = await fetch(`${BASE}/api/presence`, { method: 'POST', headers: h(CLIENT) });
check('Le battement de la boutique ouverte répond sans contenu', r.status === 204, `HTTP ${r.status}`);

console.log('\n── La porte ────────────────────────────────────────');

r = await fetch(`${BASE}/api/admin/presence`, { headers: h(CLIENT) });
check('Un client ne voit pas qui est dans la boutique', r.status === 403, `HTTP ${r.status}`);

r = await fetch(`${BASE}/api/admin/presence`);
check('Sans signature non plus', r.status === 401, `HTTP ${r.status}`);

r = await fetch(`${BASE}/api/presence`, { method: 'POST' });
check('Et on ne se déclare pas présent sans signature', r.status === 401, `HTTP ${r.status}`);

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Présence : OK'}`);
process.exit(failures ? 1 : 0);
