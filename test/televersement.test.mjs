/**
 * Envoi d'une photo ou d'une vidéo depuis la galerie du téléphone.
 *
 * Le fichier ne touche jamais le disque de la boutique : il traverse le
 * serveur et repart vers Telegram, d'où on ne garde que la référence. Ce qui
 * compte ici, c'est donc ce qu'on accepte de faire traverser.
 *
 * Le type déclaré décide, jamais l'extension : un exécutable renommé « .jpg »
 * ne doit pas se faire passer pour une image. Et les plafonds s'alignent sur ce
 * que Telegram sait *rendre*, pas sur ce qu'il accepte de recevoir — un bot
 * peut envoyer cinquante mégaoctets de vidéo mais n'en télécharge que vingt,
 * si bien qu'un fichier plus lourd serait rangé dans la galerie pour y rester
 * noir.
 *
 * Prérequis : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/televersement.test.mjs
 */
import 'dotenv/config';
import { signInitData, resetShop } from './helpers.mjs';
import { POIDS_MAX } from '../server/bot.js';
import { MEDIA_MAX } from '../server/catalog.js';

const TOKEN = process.env.BOT_TOKEN;
const BASE = process.env.TEST_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

if (!TOKEN) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer les tests.');
  process.exit(1);
}

const admin = signInitData(TOKEN, { id: 424242, first_name: 'Patron' });
const client = signInitData(TOKEN, { id: 820000 + (Date.now() % 70000), first_name: 'Client' });

await resetShop(BASE, admin, { features: { photos: true } });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const catalog = await (await fetch(`${BASE}/api/catalog`)).json();
const produit = catalog.products[0];
const chemin = `/api/admin/products/${produit.id}/media`;

const call = (path, opts = {}) =>
  fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'X-Telegram-Init-Data': admin, ...(opts.headers ?? {}) },
  });

/** Envoie un corps brut sur la route de téléversement. */
const televerser = (octets, type, { nom = 'essai', init = admin } = {}) =>
  fetch(`${BASE}${chemin}/upload?nom=${encodeURIComponent(nom)}`, {
    method: 'POST',
    headers: { 'Content-Type': type, 'X-Telegram-Init-Data': init },
    body: octets,
  });

// On repart d'une galerie vide : cette suite doit se rejouer.
for (let i = MEDIA_MAX; i >= 0; i--) await call(`${chemin}/${i}`, { method: 'DELETE' });

/* ── Ce qu'on refuse de faire traverser ──────────────────── */

// Le type déclaré fait foi. Un fichier nommé « photo.jpg » mais annoncé comme
// autre chose ne passe pas : l'extension est une convention, pas une preuve.
for (const [label, type] of [
  ['un exécutable', 'application/x-msdownload'],
  ['du HTML', 'text/html'],
  ['du JSON', 'application/json'],
  ['un PDF', 'application/pdf'],
  ['un type absent', 'application/octet-stream'],
]) {
  const r = await televerser(Buffer.from('MZ nawak'), type, { nom: 'photo.jpg' });
  const corps = await r.json().catch(() => ({}));
  check(`Refusé malgré un nom en .jpg : ${label}`, r.status === 400, `HTTP ${r.status} — ${corps.error ?? ''}`.slice(0, 90));
}

let r = await televerser(Buffer.alloc(0), 'image/jpeg');
check('Un corps vide est refusé', r.status === 400, `HTTP ${r.status}`);

/* ── Les plafonds ────────────────────────────────────────── */

// Un octet de trop suffit : c'est la limite exacte qui compte, pas l'ordre de
// grandeur. On vise juste au-dessus pour ne pas fabriquer un tampon inutile.
r = await televerser(Buffer.alloc(POIDS_MAX.photo + 1), 'image/jpeg');
let corps = await r.json().catch(() => ({}));
check('Une photo trop lourde est refusée', r.status === 413, `HTTP ${r.status}`);
check('Et le refus donne le poids et la limite', /Mo/.test(corps.error ?? ''),
  (corps.error ?? '').split('\n')[0]?.slice(0, 80));

r = await televerser(Buffer.alloc(POIDS_MAX.video + 1), 'video/mp4');
check('Une vidéo trop lourde est refusée', r.status === 413, `HTTP ${r.status}`);

// Le plafond vidéo est plus haut que le plafond photo : une vidéo de quinze
// mégaoctets passe la porte là où une photo du même poids serait refusée.
check('Les deux plafonds diffèrent', POIDS_MAX.video > POIDS_MAX.photo,
  `photo ${POIDS_MAX.photo / 1048576} Mo, vidéo ${POIDS_MAX.video / 1048576} Mo`);

/* ── Un produit qui n'existe pas ─────────────────────────── */

r = await fetch(`${BASE}/api/admin/products/produit-fantome/media/upload?nom=x`, {
  method: 'POST',
  headers: { 'Content-Type': 'image/jpeg', 'X-Telegram-Init-Data': admin },
  body: Buffer.from('...'),
});
check('Un produit inconnu répond 404', r.status === 404, `HTTP ${r.status}`);

/* ── Ce n'est pas ouvert à tout le monde ─────────────────── */

r = await televerser(Buffer.from('...'), 'image/jpeg', { init: client });
check("Un client ne téléverse pas", r.status === 403, `HTTP ${r.status}`);

r = await fetch(`${BASE}${chemin}/upload?nom=x`, {
  method: 'POST',
  headers: { 'Content-Type': 'image/jpeg' },
  body: Buffer.from('...'),
});
check('Sans signature non plus', r.status === 401, `HTTP ${r.status}`);

/* ── Le nom du fichier ───────────────────────────────────── */

// Le nom voyage dans l'URL et finit chez Telegram : on le nettoie plutôt que
// de faire confiance à ce que le téléphone envoie.
r = await televerser(Buffer.from('...'), 'image/jpeg', { nom: '../../etc/passwd' });
check(
  "Un nom qui remonte l'arborescence ne fait pas planter la route",
  [400, 502, 409].includes(r.status),
  `HTTP ${r.status}`
);

/* ── Le passage de relais vers Telegram ──────────────────── */

// Telegram n'est pas joignable depuis les tests : ce qui compte est que le
// refus soit net et expliqué, pas qu'il aboutisse.
r = await televerser(Buffer.alloc(1024), 'image/jpeg', { nom: 'vraie-photo.jpg' });
corps = await r.json().catch(() => ({}));
check(
  'Un envoi valide atteint la remise à Telegram',
  [200, 502, 409].includes(r.status),
  `HTTP ${r.status} — ${(corps.error ?? 'ajouté').slice(0, 60)}`
);
check(
  "Et s'il échoue, il dit pourquoi plutôt que « erreur interne »",
  r.status === 200 || !/interne/i.test(corps.error ?? ''),
  (corps.error ?? '').slice(0, 70)
);

/* ── L'image principale ──────────────────────────────────── */

const vignette = (octets, type, { init = admin, id = produit.id } = {}) =>
  fetch(`${BASE}/api/admin/products/${id}/image/upload?nom=photo.jpg`, {
    method: 'POST',
    headers: { 'Content-Type': type, 'X-Telegram-Init-Data': init },
    body: octets,
  });

// Une vignette de catalogue ne se joue pas : la vidéo est refusée là où la
// galerie l'accepte, et le refus doit dire pourquoi plutôt que de renvoyer un
// message de type générique.
r = await vignette(Buffer.alloc(1024), 'video/mp4');
corps = await r.json().catch(() => ({}));
check("Une vidéo n'est pas une image principale", r.status === 400, `HTTP ${r.status}`);
check('Et le refus le dit clairement', /vidéo ne s'affiche pas/i.test(corps.error ?? ''),
  (corps.error ?? '').slice(0, 80));

r = await vignette(Buffer.alloc(1024), 'application/pdf');
check('Un PDF non plus', r.status === 400, `HTTP ${r.status}`);

r = await vignette(Buffer.alloc(POIDS_MAX.photo + 1), 'image/jpeg');
check('Le plafond photo vaut aussi pour la vignette', r.status === 413, `HTTP ${r.status}`);

r = await vignette(Buffer.alloc(0), 'image/jpeg');
check('Un corps vide est refusé', r.status === 400, `HTTP ${r.status}`);

r = await vignette(Buffer.alloc(1024), 'image/jpeg', { id: 'produit-fantome' });
check('Un produit inconnu répond 404', r.status === 404, `HTTP ${r.status}`);

r = await vignette(Buffer.alloc(1024), 'image/jpeg', { init: client });
check("Un client ne change pas la vignette", r.status === 403, `HTTP ${r.status}`);

r = await vignette(Buffer.alloc(1024), 'image/jpeg');
corps = await r.json().catch(() => ({}));
check('Une photo valide atteint la remise à Telegram',
  [200, 502, 409].includes(r.status), `HTTP ${r.status}`);
check("Et l'échec se lit, plutôt que « erreur interne »",
  r.status === 200 || !/interne/i.test(corps.error ?? ''), (corps.error ?? '').slice(0, 70));

// La galerie pleine ne gêne pas la vignette : ce sont deux choses distinctes.
/* ── La galerie pleine ───────────────────────────────────── */

for (let i = 0; i < MEDIA_MAX; i++) {
  await fetch(`${BASE}${chemin}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': admin },
    body: JSON.stringify({ kind: 'photo', url: `/assets/products/jar.svg?${i}` }),
  });
}
r = await televerser(Buffer.alloc(1024), 'image/jpeg');
corps = await r.json().catch(() => ({}));
check('Galerie pleine : on refuse avant même de déranger Telegram',
  r.status === 400 && /pleine/i.test(corps.error ?? ''), corps.error);

r = await vignette(Buffer.alloc(1024), 'image/jpeg');
check("Une galerie pleine n'empêche pas de changer la vignette",
  r.status !== 400, `HTTP ${r.status}`);

// On rend le produit tel qu'on l'a trouvé.
for (let i = MEDIA_MAX; i >= 0; i--) await call(`${chemin}/${i}`, { method: 'DELETE' });

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Téléversement de médias : OK'}`);
process.exit(failures ? 1 : 0);
