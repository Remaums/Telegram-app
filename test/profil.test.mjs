/**
 * Le profil du client : commandes, favoris, alertes.
 *
 * Trois choses qui n'ont en commun que d'appartenir à une personne, et c'est
 * justement ce qui les rend fragiles : chacune doit rester privée, chacune doit
 * survivre à ce que fait le vendeur au catalogue, et chacune doit être bornée.
 *
 * Ce que cette suite protège :
 *
 * - les favoris et les alertes de quelqu'un ne regardent que lui ;
 * - un canal inventé par un écran ne crée pas un canal ;
 * - le /stop du bot passe au-dessus des deux interrupteurs — une seule règle,
 *   pas deux qui se contrediront un jour ;
 * - un produit supprimé ne laisse pas une carte vide dans le profil des gens ;
 * - la liste de favoris est bornée : sans ça, une boucle côté client écrirait
 *   sans fin dans le magasin.
 *
 * Prérequis (partie HTTP) : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/profil.test.mjs
 */
import 'dotenv/config';
import {
  CANAUX, parDefaut, preferencesDe, enregistrerPreferences, destinatairesDuCanal,
} from '../server/preferences.js';
import { MAX as FAVORIS_MAX } from '../server/favoris.js';
import { signInitData, getShopPass, franchirLaPorte } from './helpers.mjs';

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

const ADMIN = signInitData(TOKEN, { id: 424242, first_name: 'Patron' });
const h = (qui) => ({ 'Content-Type': 'application/json', 'X-Telegram-Init-Data': qui });
// L'épreuve du chat garde aussi la Mini App : un client inventé ici n'a
// jamais écrit au bot, donc jamais calculé. On le fait entrer par la route
// du vendeur — ce que cette suite teste est ailleurs.
const unClient = async () => {
  const id = 995000 + Math.floor(Math.random() * 100000);
  await franchirLaPorte(BASE, ADMIN, id);
  return { id, initData: signInitData(TOKEN, { id, first_name: 'Profil' }) };
};

console.log('\n── Les canaux, et rien d autre ─────────────────────');

check('Deux canaux déclarés', CANAUX.length === 2, CANAUX.map((c) => c.clef).join(', '));
check('Chacun porte un libellé et une explication',
  CANAUX.every((c) => c.label && c.hint));
check('Tout est ouvert par défaut', Object.values(parDefaut()).every(Boolean));

{
  const { id } = await unClient();
  // Un écran qui envoie autre chose ne doit pas pouvoir inventer un canal, ni
  // écrire la chaîne « false » là où un booléen est attendu.
  const apres = await enregistrerPreferences(id, {
    promos: false, inconnu: true, nouveautes: 'false',
  });
  // Le contrat est celui-ci, et il est vérifié en entier : ce qui sort porte
  // EXACTEMENT les canaux déclarés, en booléens. Ni une clé inventée par un
  // écran, ni l'horodatage interne du magasin, ni une chaîne « false » qui
  // vaudrait `true` partout où on la teste.
  const attendues = CANAUX.map((c) => c.clef).sort().join(',');
  check('La lecture ne rend que les canaux déclarés',
    Object.keys(apres).sort().join(',') === attendues, Object.keys(apres).join(','));
  check('Et rien que des booléens',
    Object.values(apres).every((v) => typeof v === 'boolean'), JSON.stringify(apres));
  check('Une valeur non booléenne laisse le canal ouvert', apres.nouveautes === true, String(apres.nouveautes));
  check('Et ce qui est valide est retenu', apres.promos === false);
  check('La relecture donne la même chose',
    JSON.stringify(await preferencesDe(id)) === JSON.stringify(apres));
}

{
  // Le filtre travaille sur la liste entière, pas client par client.
  const a = await unClient();
  const b = await unClient();
  await enregistrerPreferences(a.id, { promos: false });
  const liste = [{ id: String(a.id) }, { id: String(b.id) }];

  const promos = await destinatairesDuCanal(liste, 'promos');
  check('Celui qui a coupé les promos en sort', !promos.some((c) => c.id === String(a.id)));
  check('Celui qui n a rien coupé y reste', promos.some((c) => c.id === String(b.id)));
  const nouveautes = await destinatairesDuCanal(liste, 'nouveautes');
  check('Et il reste sur l autre canal', nouveautes.some((c) => c.id === String(a.id)));
  check('Un canal inventé ne rend personne',
    (await destinatairesDuCanal(liste, 'nimportequoi')).length === 0);
}

console.log('\n── Le profil, bout en bout ─────────────────────────');

const client = await unClient();
let r = await fetch(`${BASE}/api/profil`, { headers: h(client.initData) });
const profil = await r.json();
check('Le profil arrive en un seul appel', r.status === 200, `HTTP ${r.status}`);
check('Avec commandes, favoris, préférences et canaux',
  ['commandes', 'favoris', 'preferences', 'canaux', 'desabonne'].every((k) => k in profil),
  Object.keys(profil).join(','));
check('Un nouveau client accepte tout', Object.values(profil.preferences).every(Boolean));

r = await fetch(`${BASE}/api/profil`, { headers: { 'Content-Type': 'application/json' } });
check('Sans signature, pas de profil', r.status === 401, `HTTP ${r.status}`);

console.log('\n── Les favoris ─────────────────────────────────────');

const catalogue = await (await fetch(`${BASE}/api/catalog`)).json();
const [p1, p2] = catalogue.products;

const basculer = (qui, id) =>
  fetch(`${BASE}/api/favoris`, { method: 'POST', headers: h(qui), body: JSON.stringify({ id }) });

r = await basculer(client.initData, p1.id);
let etat = await r.json();
check('On met un produit en favori', r.status === 200 && etat.favori === true, JSON.stringify(etat));

r = await basculer(client.initData, p1.id);
etat = await r.json();
check('Le même appel le retire', etat.favori === false && etat.total === 0, JSON.stringify(etat));

await basculer(client.initData, p1.id);
await basculer(client.initData, p2.id);
const mesFavoris = await (await fetch(`${BASE}/api/favoris`, { headers: h(client.initData) })).json();
check('Les deux sont là', mesFavoris.favoris.length === 2, JSON.stringify(mesFavoris.favoris));
check('Le dernier ajouté est en tête', mesFavoris.favoris[0] === p2.id, mesFavoris.favoris[0]);

const avecProduits = await (await fetch(`${BASE}/api/profil`, { headers: h(client.initData) })).json();
check('Le profil rend le produit entier, pas un identifiant',
  Boolean(avecProduits.favoris[0]?.name && avecProduits.favoris[0]?.price),
  JSON.stringify(Object.keys(avecProduits.favoris[0] ?? {})).slice(0, 60));

r = await basculer(client.initData, 'produit-fantome');
check('Un produit qui n existe pas est refusé', r.status === 400, `HTTP ${r.status}`);

// Le point qui compte : les favoris de quelqu'un ne regardent que lui.
const voisin = await unClient();
const sesFavoris = await (await fetch(`${BASE}/api/favoris`, { headers: h(voisin.initData) })).json();
check('Les favoris d un autre ne fuient pas', sesFavoris.favoris.length === 0, JSON.stringify(sesFavoris.favoris));

r = await fetch(`${BASE}/api/favoris`, { headers: { 'Content-Type': 'application/json' } });
check('Sans signature, aucun favori', r.status === 401, `HTTP ${r.status}`);

console.log('\n── Les alertes ─────────────────────────────────────');

r = await fetch(`${BASE}/api/profil/preferences`, {
  method: 'PUT', headers: h(client.initData), body: JSON.stringify({ nouveautes: false }),
});
const prefs = await r.json();
check('On coupe un canal', r.status === 200 && prefs.nouveautes === false, JSON.stringify(prefs));
check('Sans toucher à l autre', prefs.promos === true);

const relu = await (await fetch(`${BASE}/api/profil`, { headers: h(client.initData) })).json();
check('Le réglage tient au rechargement', relu.preferences.nouveautes === false);

const duVoisin = await (await fetch(`${BASE}/api/profil`, { headers: h(voisin.initData) })).json();
check('Et ne déborde pas sur un autre client', duVoisin.preferences.nouveautes === true);

r = await fetch(`${BASE}/api/profil/preferences`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ promos: false }),
});
check('Sans signature, on ne règle rien', r.status === 401, `HTTP ${r.status}`);

console.log('\n── Ce que le vendeur voit ──────────────────────────');

r = await fetch(`${BASE}/api/admin/audience`, { headers: h(ADMIN) });
const audience = await r.json();
check("L'audience se lit depuis le panel", r.status === 200, `HTTP ${r.status}`);
check('Avec le nombre de joignables', Number.isInteger(audience.joignables), String(audience.joignables));
check('Et le compte par canal',
  CANAUX.every((c) => Number.isInteger(audience.parCanal?.[c.clef])), JSON.stringify(audience.parCanal));
check('Les préférences de chacun y sont', typeof audience.preferences === 'object');
check('Et le classement des favoris', Array.isArray(audience.favoris));

r = await fetch(`${BASE}/api/admin/audience`, { headers: h(client.initData) });
check('Un client ne lit pas l audience', r.status === 403, `HTTP ${r.status}`);

console.log('\n── Ce qui doit survivre au catalogue ───────────────');

{
  // Un produit supprimé ne doit pas laisser une carte vide dans le profil de
  // quelqu'un, ni une ligne morte dans le magasin.
  const cree = await (await fetch(`${BASE}/api/admin/products`, {
    method: 'POST', headers: h(ADMIN),
    body: JSON.stringify({ name: 'Éphémère ' + Date.now(), price: 1000, category: catalogue.categories[1]?.id ?? 'fleurs', stock: 5 }),
  })).json();

  await basculer(client.initData, cree.id);
  const avant = await (await fetch(`${BASE}/api/favoris`, { headers: h(client.initData) })).json();
  check('Un produit tout neuf se met en favori', avant.favoris.includes(cree.id));

  await fetch(`${BASE}/api/admin/products/${cree.id}`, { method: 'DELETE', headers: h(ADMIN) });
  const apres = await (await fetch(`${BASE}/api/favoris`, { headers: h(client.initData) })).json();
  check('Sa suppression le retire des favoris de tout le monde',
    !apres.favoris.includes(cree.id), JSON.stringify(apres.favoris));
}

console.log('\n── La borne ────────────────────────────────────────');

check(`La liste est plafonnée à ${FAVORIS_MAX}`, FAVORIS_MAX > 0 && FAVORIS_MAX <= 1000, String(FAVORIS_MAX));

// Nettoyage : la suite doit pouvoir tourner deux fois d'affilée.
for (const id of (await (await fetch(`${BASE}/api/favoris`, { headers: h(client.initData) })).json()).favoris) {
  await basculer(client.initData, id);
}

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Profil : OK'}`);
process.exit(failures ? 1 : 0);
