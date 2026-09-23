/**
 * La porte du bot garde aussi la boutique.
 *
 * Le calcul du premier /start gardait la conversation, et rien d'autre. Or le
 * bouton « Boutique » du menu Telegram est posé pour tout le monde d'un seul
 * geste : quelqu'un qui n'avait jamais écrit au bot pouvait l'ouvrir, remplir
 * un panier et commander sans avoir rien prouvé. L'épreuve ne servait alors
 * qu'à ceux qui passaient par le chat, c'est-à-dire pas à ceux qu'elle visait.
 *
 * Ce que cette suite protège :
 *
 * - un inconnu se fait refuser tous les appels signés, pas seulement la
 *   commande : cacher l'écran sans fermer l'API n'aurait retenu personne ;
 * - le refus se distingue d'une panne et d'un refus de signature — la Mini App
 *   doit pouvoir dire « va calculer » plutôt que « réessaie » ;
 * - les trois passe-droits du bot valent ici aussi, et pour les mêmes raisons :
 *   le vendeur, le client d'avant l'épreuve, et une boutique qui l'a éteinte ;
 * - `/api/porte` répond même porte fermée : c'est ce qui permet au voile de se
 *   lever tout seul quand le calcul vient d'être fait ;
 * - et il ne dit rien de plus qu'ouvert ou fermé.
 *
 * Prérequis : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/porte.test.mjs
 */
import 'dotenv/config';
import { signInitData, resetShop, franchirLaPorte } from './helpers.mjs';

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
const souche = 970000 + (Date.now() % 20000);
let prochain = 0;
const inconnu = () => {
  const id = souche + prochain++;
  return { id, initData: signInitData(TOKEN, { id, first_name: 'Inconnu' }) };
};

await resetShop(BASE, ADMIN, { features: { botCaptcha: true, captcha: false } });

console.log('\n── Un inconnu reste dehors ─────────────────────────');

const dehors = inconnu();

// Toutes les portes de la Mini App, pas seulement la commande : un inconnu qui
// peut lire ses favoris et poser un avis a déjà la boutique dans les mains.
const fermees = [
  ['GET', '/api/orders'],
  ['GET', '/api/profil'],
  ['GET', '/api/favoris'],
  ['GET', '/api/me'],
  ['GET', '/api/captcha'],
  ['POST', '/api/presence'],
];
for (const [method, chemin] of fermees) {
  const r = await fetch(`${BASE}${chemin}`, { method, headers: h(dehors.initData) });
  check(`${method} ${chemin} refusé`, r.status === 403, `HTTP ${r.status}`);
}

// Le motif compte autant que le code : sans lui, la Mini App ne peut pas
// distinguer « va calculer » de « tu es bloqué » ni de « la boutique est en
// panne », et dirait la mauvaise chose au client dans deux cas sur trois.
let r = await fetch(`${BASE}/api/orders`, { headers: h(dehors.initData) });
let dit = await r.json();
check('Le refus se nomme', dit.porte === 'fermee', JSON.stringify(dit.porte));
check('Le refus s explique en français', /calcul/i.test(dit.error ?? ''), dit.error);

// Une signature absente reste un 401 : la porte ne doit pas avaler le contrôle
// d'identité, sinon un inconnu non signé passerait pour un inconnu signé.
r = await fetch(`${BASE}/api/orders`, { headers: { 'Content-Type': 'application/json' } });
check('Sans signature, toujours 401', r.status === 401, `HTTP ${r.status}`);

console.log('\n── Ce que la porte veut bien dire ──────────────────');

r = await fetch(`${BASE}/api/porte`, { headers: h(dehors.initData) });
let etat = await r.json();
check('/api/porte répond porte fermée', r.status === 200, `HTTP ${r.status}`);
check('… et la dit fermée', etat.requise === true && etat.ouverte === false, JSON.stringify(etat));
check('… sans rien dire de plus',
  Object.keys(etat).sort().join(',') === 'ouverte,requise', Object.keys(etat).join(','));

r = await fetch(`${BASE}/api/porte`);
check('/api/porte exige une signature', r.status === 401, `HTTP ${r.status}`);

console.log('\n── Les trois passe-droits ──────────────────────────');

r = await fetch(`${BASE}/api/orders`, { headers: h(ADMIN) });
check('Le vendeur entre sans calculer', r.ok, `HTTP ${r.status}`);

const laisse = inconnu();
await franchirLaPorte(BASE, ADMIN, laisse.id);
r = await fetch(`${BASE}/api/orders`, { headers: h(laisse.initData) });
check('Celui que le vendeur fait entrer passe', r.ok, `HTTP ${r.status}`);

r = await fetch(`${BASE}/api/porte`, { headers: h(laisse.initData) });
etat = await r.json();
check('… et sa porte se lit ouverte', etat.ouverte === true, JSON.stringify(etat));

// Le vendeur peut refermer : c'est ce qui permet de rejouer l'épreuve pour un
// compte devenu douteux — et de vérifier que l'ouverture n'est pas un aller simple.
r = await fetch(`${BASE}/api/admin/porte/${laisse.id}`, { method: 'DELETE', headers: h(ADMIN) });
check('Le vendeur peut refermer', r.ok, `HTTP ${r.status}`);
r = await fetch(`${BASE}/api/orders`, { headers: h(laisse.initData) });
check('… et le client se retrouve dehors', r.status === 403, `HTTP ${r.status}`);

// La porte du vendeur est une porte de vendeur : un client ne se laisse pas
// entrer lui-même.
const malin = inconnu();
r = await fetch(`${BASE}/api/admin/porte/${malin.id}`, { method: 'POST', headers: h(malin.initData) });
check('Un client ne s ouvre pas la porte', r.status === 403 || r.status === 401, `HTTP ${r.status}`);
r = await fetch(`${BASE}/api/orders`, { headers: h(malin.initData) });
check('… et il est toujours dehors', r.status === 403, `HTTP ${r.status}`);

console.log('\n── Le client d avant l épreuve ─────────────────────');

// Quelqu'un qui a déjà commandé a payé de sa personne : la porte a été posée
// après lui, elle ne doit pas le renvoyer à la caisse.
const ancien = inconnu();
await franchirLaPorte(BASE, ADMIN, ancien.id);
const catalogue = await (await fetch(`${BASE}/api/catalog`)).json();
const produit = catalogue.products.find((p) => !p.variants || p.variants.some((v) => v.stock > 0));
const variante = produit.variants?.find((v) => v.stock > 0);
r = await fetch(`${BASE}/api/orders`, {
  method: 'POST',
  headers: h(ancien.initData),
  body: JSON.stringify({
    items: [{ id: produit.id, variantId: variante?.id, quantity: 1 }],
    mode: 'pickup',
  }),
});
check('Une commande passe une fois entré', r.status === 201, `HTTP ${r.status}`);

// On le remet dehors : seule sa commande doit désormais le faire entrer.
await fetch(`${BASE}/api/admin/porte/${ancien.id}`, { method: 'DELETE', headers: h(ADMIN) });
r = await fetch(`${BASE}/api/orders`, { headers: h(ancien.initData) });
check('Un client qui a déjà commandé entre sans calculer', r.ok, `HTTP ${r.status}`);

r = await fetch(`${BASE}/api/admin/porte/${ancien.id}`, { headers: h(ADMIN) });
check('… et la porte lui est rouverte pour de bon',
  (await r.json()).ouverte === true, 'le passage est retenu, pas recalculé à chaque appel');

console.log('\n── Quand le vendeur éteint l épreuve ───────────────');

await resetShop(BASE, ADMIN, { features: { botCaptcha: false, captcha: false } });
const passant = inconnu();
r = await fetch(`${BASE}/api/orders`, { headers: h(passant.initData) });
check('Épreuve éteinte, tout le monde entre', r.ok, `HTTP ${r.status}`);
r = await fetch(`${BASE}/api/porte`, { headers: h(passant.initData) });
etat = await r.json();
check('… et /api/porte le dit', etat.requise === false && etat.ouverte === true, JSON.stringify(etat));

// Rallumée, elle referme sur le même passant : l'interrupteur n'ouvre pas une
// porte pour toujours, il la lève le temps qu'il est baissé.
await resetShop(BASE, ADMIN, { features: { botCaptcha: true, captcha: false } });
r = await fetch(`${BASE}/api/orders`, { headers: h(passant.initData) });
check('Rallumée, elle referme', r.status === 403, `HTTP ${r.status}`);

console.log('\n── Ce que la boutique montre sans signature ────────');

// Le catalogue reste public : c'est lui qui dit à la Mini App qu'elle doit
// présenter la porte, et un client hors Telegram doit pouvoir regarder.
r = await fetch(`${BASE}/api/catalog`);
const cat = await r.json();
check('Le catalogue reste ouvert', r.ok, `HTTP ${r.status}`);
check('… et annonce la porte', cat.gates?.porte === true, JSON.stringify(cat.gates));

/* ── Remise en état ──────────────────────────────────────── */
await resetShop(BASE, ADMIN, {});

console.log(`\n${failures === 0 ? '✅' : '❌'}  ${failures} test(s) en échec\n`);
process.exit(failures === 0 ? 0 : 1);
