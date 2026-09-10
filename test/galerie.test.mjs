/**
 * Galerie photos et vidéos d'une fiche produit.
 *
 * Ce qui compte ici tient en trois points. Une adresse de média finit dans un
 * attribut `src` du navigateur : y laisser passer `javascript:` reviendrait à
 * offrir l'exécution de code à qui peut créer un produit. Réordonner ne doit
 * ni perdre ni dupliquer un média — un glisser maladroit effacerait une vidéo
 * qu'on ne récupère pas. Et la galerie est bornée : une fiche produit n'est
 * pas un album, et chaque média est une requête de plus à servir.
 *
 * Prérequis : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/galerie.test.mjs
 */
import 'dotenv/config';
import { signInitData, resetShop } from './helpers.mjs';
import { normalizeMedia, MEDIA_MAX } from '../server/catalog.js';

const TOKEN = process.env.BOT_TOKEN;
const BASE = process.env.TEST_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

if (!TOKEN) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer les tests.');
  process.exit(1);
}

const admin = signInitData(TOKEN, { id: 424242, first_name: 'Patron' });
const client = signInitData(TOKEN, { id: 810000 + (Date.now() % 90000), first_name: 'Client' });

await resetShop(BASE, admin, { features: { photos: true } });

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

/* ── Ce qu'une adresse a le droit d'être ─────────────────── */

// Un `src` est un vecteur d'exécution : ce filtre est une frontière de
// sécurité, pas une commodité d'affichage.
for (const [label, url] of [
  ['javascript:', 'javascript:alert(1)'],
  ['data: (script déguisé)', 'data:text/html,<script>alert(1)</script>'],
  ['vbscript:', 'vbscript:msgbox(1)'],
  ['HTTP en clair', 'http://sans-tls.example.com/x.jpg'],
  ['protocole relatif', '//ailleurs.example.com/x.jpg'],
  ['remontée de dossier', '/../../../etc/passwd'],
  ['chaîne vide', ''],
]) {
  check(`Refusé : ${label}`, normalizeMedia([{ kind: 'photo', url }]).length === 0, JSON.stringify(url));
}

for (const [label, url] of [
  ['chemin local', '/assets/products/x.jpg'],
  ['adresse HTTPS', 'https://exemple.fr/x.jpg'],
]) {
  check(`Accepté : ${label}`, normalizeMedia([{ kind: 'photo', url }]).length === 1);
}

check(
  'Un média sans fichier ni adresse est écarté',
  normalizeMedia([{ kind: 'photo' }, { kind: 'video' }]).length === 0
);
check(
  'Une référence Telegram suffit',
  normalizeMedia([{ kind: 'video', fileId: 'BAACAgQAAx' }]).length === 1
);
check(
  'Un type inconnu retombe sur photo',
  normalizeMedia([{ kind: 'nawak', fileId: 'x' }])[0].kind === 'photo'
);
check(
  `La galerie est bornée à ${MEDIA_MAX}`,
  normalizeMedia(Array.from({ length: 30 }, (_, i) => ({ kind: 'photo', fileId: `f${i}` }))).length === MEDIA_MAX
);

/* ── La galerie d'un vrai produit ────────────────────────── */

const catalog = await (await fetch(`${BASE}/api/catalog`)).json();
const produit = catalog.products[0];
const chemin = `/api/admin/products/${produit.id}/media`;

// On repart d'une galerie vide, quel que soit l'état laissé par un passage
// précédent : cette suite doit se rejouer.
for (let i = MEDIA_MAX; i >= 0; i--) await call(`${chemin}/${i}`, { method: 'DELETE' });

let r = await call(chemin, { method: 'POST', body: { kind: 'photo', url: '/assets/products/jar.svg' } });
let data = await r.json();
check('Une photo entre dans la galerie', r.status === 200 && data.media?.length === 1, `HTTP ${r.status}`);

r = await call(chemin, { method: 'POST', body: { kind: 'video', url: 'https://exemple.fr/demo.mp4' } });
data = await r.json();
check('Une vidéo aussi', data.media?.[1]?.kind === 'video', JSON.stringify(data.media?.[1]));

await call(chemin, { method: 'POST', body: { kind: 'photo', url: '/assets/products/bud.svg' } });

/* ── Les deux refus ne se confondent pas ─────────────────── */

r = await call(chemin, { method: 'POST', body: { kind: 'photo', url: 'javascript:alert(1)' } });
data = await r.json();
check("Une adresse refusée le dit, et ne parle pas d'une galerie pleine",
  r.status === 400 && /adresse/i.test(data.error) && !/pleine/i.test(data.error), data.error);

r = await call(chemin, { method: 'POST', body: { kind: 'photo' } });
check('Une adresse absente est refusée', r.status === 400, `HTTP ${r.status}`);

/* ── Réordonner ──────────────────────────────────────────── */

const avant = (await (await call('/api/admin/catalog')).json()).products.find((p) => p.id === produit.id).media;

r = await call(chemin, { method: 'PUT', body: { ordre: [2, 0, 1] } });
data = await r.json();
check('Réordonner suit exactement la permutation demandée',
  JSON.stringify(data.media) === JSON.stringify([avant[2], avant[0], avant[1]]),
  data.media?.map((m) => m.kind).join(' '));
check('Et ne perd rien', data.media.length === avant.length, `${avant.length} → ${data.media.length}`);

// Un ordre qui ajoute, retire ou double doit être refusé : ces trois cas
// feraient disparaître un média sans que personne ne l'ait demandé.
for (const [label, ordre] of [
  ['un rang en double', [0, 0, 1]],
  ['un rang hors bornes', [0, 1, 9]],
  ['trop court', [0, 1]],
  ['trop long', [0, 1, 2, 0]],
  ['un rang négatif', [0, 1, -1]],
  ['des mots', ['a', 'b', 'c']],
  ['rien du tout', null],
]) {
  const rep = await call(chemin, { method: 'PUT', body: { ordre } });
  check(`Ordre refusé : ${label}`, rep.status === 400, `HTTP ${rep.status}`);
}

const apresRefus = (await (await call('/api/admin/catalog')).json()).products.find((p) => p.id === produit.id).media;
check('Aucun ordre refusé n a modifié la galerie',
  JSON.stringify(apresRefus) === JSON.stringify(data.media), `${apresRefus.length} médias`);

/* ── Retirer ─────────────────────────────────────────────── */

r = await call(`${chemin}/1`, { method: 'DELETE' });
data = await r.json();
check('Retirer un média le retire', data.media.length === 2, `${data.media.length} restants`);
check('Et garde les autres dans l ordre',
  JSON.stringify(data.media) === JSON.stringify([apresRefus[0], apresRefus[2]]));

for (const rang of ['9', '-1', 'nawak']) {
  const rep = await call(`${chemin}/${rang}`, { method: 'DELETE' });
  check(`Retirer un rang inexistant est refusé : ${rang}`, rep.status === 400, `HTTP ${rep.status}`);
}

/* ── Ce que le client reçoit ─────────────────────────────── */

const publique = await (await fetch(`${BASE}/api/catalog`)).json();
const vuParLeClient = publique.products.find((p) => p.id === produit.id);
check('La galerie arrive jusqu au client', (vuParLeClient.media ?? []).length === 2);
check('Aucune référence Telegram ne fuite dans une adresse',
  vuParLeClient.media.every((m) => !m.url || /^\/|^https:\/\//.test(m.url)));

/* ── La route qui sert les médias ────────────────────────── */

r = await fetch(`${BASE}/api/media/${produit.id}/0`, { redirect: 'manual' });
check('Un média hébergé ailleurs est renvoyé vers son adresse',
  r.status === 302 && r.headers.get('location') === vuParLeClient.media[0].url,
  `HTTP ${r.status} → ${r.headers.get('location')}`);

r = await fetch(`${BASE}/api/media/${produit.id}/99`);
check('Un rang inexistant répond 404', r.status === 404, `HTTP ${r.status}`);

r = await fetch(`${BASE}/api/media/produit-fantome/0`);
check('Un produit inconnu aussi', r.status === 404, `HTTP ${r.status}`);

// Coupée, la fonctionnalité photos ferme aussi les médias : un interrupteur
// qui laisse passer ce qu'il éteint ne sert à rien.
await call('/api/admin/settings', { method: 'PUT', body: { features: { photos: false } } });
r = await fetch(`${BASE}/api/media/${produit.id}/0`, { redirect: 'manual' });
check('Photos coupées, les médias ne sont plus servis', r.status === 404, `HTTP ${r.status}`);
await call('/api/admin/settings', { method: 'PUT', body: { features: { photos: true } } });

/* ── Ce n'est pas ouvert à tout le monde ─────────────────── */

r = await call(chemin, { method: 'POST', init: client, body: { kind: 'photo', url: '/x.jpg' } });
check("Un client n'ajoute pas de média", r.status === 403, `HTTP ${r.status}`);

r = await call(`${chemin}/0`, { method: 'DELETE', init: client });
check("Un client n'en retire pas", r.status === 403, `HTTP ${r.status}`);

r = await call(chemin, { method: 'PUT', init: client, body: { ordre: [1, 0] } });
check("Un client ne réordonne pas", r.status === 403, `HTTP ${r.status}`);

/* ── Le plafond ──────────────────────────────────────────── */

for (let i = 0; i < MEDIA_MAX; i++) {
  await call(chemin, { method: 'POST', body: { kind: 'photo', url: `/assets/products/jar.svg?${i}` } });
}
r = await call(chemin, { method: 'POST', body: { kind: 'photo', url: '/assets/products/box.svg' } });
data = await r.json();
check('Au-delà du plafond, on refuse en le disant',
  r.status === 400 && /pleine/i.test(data.error), data.error);

const pleine = (await (await call('/api/admin/catalog')).json()).products.find((p) => p.id === produit.id).media;
check(`La galerie n a pas dépassé ${MEDIA_MAX}`, pleine.length === MEDIA_MAX, `${pleine.length} médias`);

/* ── L'aperçu d'une vidéo ────────────────────────────────── */

// Une vidéo pèse mille fois sa vignette. Sans `poster`, la carte reste vide le
// temps qu'elle arrive — quelques secondes sur un téléphone en 4G — et le
// client croit la boutique en panne. La vignette, elle, arrive tout de suite.

for (let i = MEDIA_MAX; i >= 0; i--) await call(`${chemin}/${i}`, { method: 'DELETE' });

check('Une vignette est gardée avec le média',
  normalizeMedia([{ kind: 'video', fileId: 'BAAC', thumbFileId: 'AAQ-vignette' }])[0]?.thumbFileId === 'AAQ-vignette');
check("Elle ne s'invente pas pour autant",
  normalizeMedia([{ kind: 'video', fileId: 'BAAC' }])[0]?.thumbFileId === undefined);

// Des médias hébergés chez Telegram : la route d'ajout par adresse ne sert
// qu'aux visuels d'ailleurs, ceux-ci arrivent par le bot ou le téléversement.
await call(`/api/admin/products/${produit.id}`, {
  method: 'PATCH',
  body: {
    media: [
      { kind: 'video', fileId: 'BAAC-video', thumbFileId: 'AAQ-vignette' },
      { kind: 'video', fileId: 'BAAC-sans-vignette' },
      { kind: 'photo', url: '/assets/products/jar.svg' },
    ],
  },
});

const avecVignette = (await (await fetch(`${BASE}/api/catalog`)).json()).products
  .find((p) => p.id === produit.id).media;
check('La vignette arrive jusqu au client', avecVignette[0]?.thumbFileId === 'AAQ-vignette');

r = await fetch(`${BASE}/api/media/${produit.id}/0/apercu`);
data = await r.json().catch(() => ({}));
check("L'aperçu part chercher la vignette, pas la vidéo", r.status !== 404, `HTTP ${r.status}`);
check("Et s'il échoue, il dit pourquoi", !/interne/i.test(data.error ?? ''), (data.error ?? '').slice(0, 60));

r = await fetch(`${BASE}/api/media/${produit.id}/1/apercu`);
check("Sans vignette, pas d'aperçu à servir", r.status === 404, `HTTP ${r.status}`);

r = await fetch(`${BASE}/api/media/produit-fantome/0/apercu`);
check('Un produit inconnu répond 404', r.status === 404, `HTTP ${r.status}`);

// Retrouver la vignette d'une vidéo d'avant : Telegram n'est pas joignable
// depuis les tests, mais tout ce qui précède l'appel doit se tenir.
r = await call(`${chemin}/1/apercu`, { method: 'POST' });
data = await r.json().catch(() => ({}));
check("Retrouver un aperçu passe par Telegram", [200, 502, 409].includes(r.status), `HTTP ${r.status}`);
check("Et l'échec se lit", r.status === 200 || !/interne/i.test(data.error ?? ''), (data.error ?? '').slice(0, 60));

r = await call(`${chemin}/2/apercu`, { method: 'POST' });
data = await r.json().catch(() => ({}));
check("Une photo n'a pas d'aperçu à retrouver", r.status === 400 && /photo/i.test(data.error ?? ''), data.error);

r = await call(`${chemin}/99/apercu`, { method: 'POST' });
check('Un rang inexistant est refusé', r.status === 400, `HTTP ${r.status}`);

r = await call(`${chemin}/1/apercu`, { method: 'POST', init: client });
check("Un client ne va rien chercher chez Telegram", r.status === 403, `HTTP ${r.status}`);

await call('/api/admin/settings', { method: 'PUT', body: { features: { photos: false } } });
r = await fetch(`${BASE}/api/media/${produit.id}/0/apercu`);
check("Photos coupées, l'aperçu se ferme aussi", r.status === 404, `HTTP ${r.status}`);
await call('/api/admin/settings', { method: 'PUT', body: { features: { photos: true } } });

// On rend le produit tel qu'on l'a trouvé.
for (let i = MEDIA_MAX; i >= 0; i--) await call(`${chemin}/${i}`, { method: 'DELETE' });

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Galerie produit : OK'}`);
process.exit(failures ? 1 : 0);
