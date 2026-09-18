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
  noterPassage, estActif, actifs, clientsActifs, oublierTout, FENETRE_MS,
} from '../server/presence.js';
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
const h = (qui) => ({ 'Content-Type': 'application/json', 'X-Telegram-Init-Data': qui });

// Un appel signé suffit : c'est la porte d'entrée qui note le passage, pas
// chaque route — une route ajoutée demain sera comptée sans qu'on y pense.
await fetch(`${BASE}/api/orders`, { headers: h(CLIENT) });

let r = await fetch(`${BASE}/api/admin/presence`, { headers: h(ADMIN) });
const vu = await r.json();
check('La présence se lit depuis le panel', r.status === 200, `HTTP ${r.status}`);
check('Un appel signé a suffi à marquer le passage',
  vu.actifs.some((a) => String(a.id) === '999501'), `${vu.total} actif(s)`);
check('La fenêtre voyage avec la réponse',
  vu.fenetreSecondes === Math.round(FENETRE_MS / 1000), String(vu.fenetreSecondes));
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
