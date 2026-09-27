/**
 * La musique d'ambiance.
 *
 * Deux moitiés. La première n'a besoin de rien : `musique.js` ne contient que
 * des fonctions pures, et le nettoyage d'une playlist se vérifie sans serveur.
 * La seconde vérifie ce que la boutique laisse sortir — et surtout ce qu'elle
 * ne laisse pas sortir : un `file_id` Telegram est une adresse utilisable par
 * quiconque possède le token du bot, et le catalogue se lit sans signature.
 *
 * Prérequis : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/musique.test.mjs
 */
import 'dotenv/config';
import { signInitData, resetShop } from './helpers.mjs';
import {
  normalizeMusique,
  playlistPublique,
  morceauParId,
  titreDepuisLeNom,
  MUSIQUE_MAX,
} from '../server/musique.js';

const TOKEN = process.env.BOT_TOKEN;
const BASE = process.env.TEST_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

if (!TOKEN) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer les tests.');
  process.exit(1);
}

const admin = signInitData(TOKEN, { id: 424242, first_name: 'Patron' });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const call = (path, { method = 'GET', body } = {}) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': admin },
    body: body ? JSON.stringify(body) : undefined,
  });

console.log('\n── Le nettoyage d\'une playlist ─────────────────────');

const troisMorceaux = {
  titres: [
    { id: 'aaa', titre: 'Nuit en ville', fileId: 'FID-1' },
    { id: 'bbb', titre: 'Pluie sur la ruelle', fileId: 'FID-2' },
    { id: 'ccc', titre: 'Dernier métro', fileId: 'FID-3' },
  ],
};

check('Une liste saine traverse sans changer',
  JSON.stringify(normalizeMusique(troisMorceaux)) === JSON.stringify(troisMorceaux));

// Sans fichier, il n'y a rien à jouer : garder l'entrée donnerait une ligne
// muette dans l'écran de réglages, le genre de fantôme qu'on croit supprimé.
check('Un morceau sans fichier est jeté',
  normalizeMusique({ titres: [{ id: 'x', titre: 'Fantôme' }] }).titres.length === 0);

check('Un morceau sans titre en reçoit un',
  normalizeMusique({ titres: [{ id: 'x', fileId: 'F' }] }).titres[0].titre === 'Sans titre');

// Deux morceaux qui partagent une adresse, c'est le second qui devient
// injouable — et personne ne devinerait pourquoi.
const doublons = normalizeMusique({
  titres: [
    { id: 'meme', titre: 'A', fileId: 'F1' },
    { id: 'meme', titre: 'B', fileId: 'F2' },
  ],
});
check('Les identifiants en double sont renumérotés, pas supprimés',
  doublons.titres.length === 2 && doublons.titres[0].id !== doublons.titres[1].id,
  doublons.titres.map((m) => m.id).join(' / '));

const trop = normalizeMusique({
  titres: Array.from({ length: MUSIQUE_MAX + 12 }, (_, i) => ({ id: `i${i}`, titre: `T${i}`, fileId: `F${i}` })),
});
check('La liste est plafonnée', trop.titres.length === MUSIQUE_MAX, `${trop.titres.length} morceaux`);

check('Une entrée absurde ne fait pas tomber le nettoyage',
  normalizeMusique({ titres: [null, 7, 'x', { fileId: 'F' }] }).titres.length === 1);

check('Un titre trop long est coupé',
  normalizeMusique({ titres: [{ id: 'a', titre: 'z'.repeat(200), fileId: 'F' }] }).titres[0].titre.length === 80);

console.log('\n── Le titre déduit du nom de fichier ───────────────');

check('L\'extension part', titreDepuisLeNom('nuit.mp3') === 'Nuit', titreDepuisLeNom('nuit.mp3'));
check('Le numéro de piste part', titreDepuisLeNom('03_nuit-en-ville.mp3') === 'Nuit en ville',
  titreDepuisLeNom('03_nuit-en-ville.mp3'));
check('Un nom vide reste lisible', titreDepuisLeNom('') === 'Sans titre');
check('Un nom qui n\'est qu\'une extension aussi', titreDepuisLeNom('.mp3') === 'Sans titre',
  titreDepuisLeNom('.mp3'));

console.log('\n── Ce qui sort, et ce qui ne sort pas ──────────────');

const publique = playlistPublique(troisMorceaux, true);
check('Les titres sortent', publique.titres.length === 3);
check('Chaque morceau porte son adresse de lecture',
  publique.titres[0].url === '/api/musique/aaa', publique.titres[0].url);
// Le point qui compte : un file_id est une clé, pas une référence interne.
check('Aucun file_id ne sort',
  !JSON.stringify(publique).includes('FID-'), JSON.stringify(publique).slice(0, 80));

check('Interrupteur éteint, la playlist est vide',
  playlistPublique(troisMorceaux, false).titres.length === 0);

check('On retrouve un morceau par son identifiant',
  morceauParId(troisMorceaux, 'bbb')?.fileId === 'FID-2');
check('Un identifiant inconnu ne rend rien', morceauParId(troisMorceaux, 'zzz') === null);

console.log('\n── La boutique ─────────────────────────────────────');

await resetShop(BASE, admin, { features: { musique: false, captcha: false } });

let r = await call('/api/admin/settings', {
  method: 'PUT',
  body: { musique: troisMorceaux, features: { musique: false } },
});
check('La playlist s\'enregistre', r.ok, `HTTP ${r.status}`);

let cat = await (await fetch(`${BASE}/api/catalog`)).json();
check('Éteinte, la boutique n\'annonce aucun morceau', (cat.musique?.titres ?? []).length === 0,
  JSON.stringify(cat.musique));

// Un interrupteur ne sert que s'il est respecté côté serveur : masquer la
// pastille ne ferme rien, l'URL resterait appelable.
r = await fetch(`${BASE}/api/musique/aaa`);
check('Éteinte, la lecture est refusée', r.status === 404, `HTTP ${r.status}`);

await call('/api/admin/settings', { method: 'PUT', body: { features: { musique: true } } });
cat = await (await fetch(`${BASE}/api/catalog`)).json();
check('Allumée, les trois morceaux sont annoncés', (cat.musique?.titres ?? []).length === 3);
check('Dans l\'ordre du vendeur', cat.musique.titres[0].titre === 'Nuit en ville',
  cat.musique.titres.map((m) => m.titre).join(' · '));
check('Et toujours sans file_id', !JSON.stringify(cat.musique).includes('FID-'));

r = await fetch(`${BASE}/api/musique/inconnu`);
check('Un morceau inconnu répond 404', r.status === 404, `HTTP ${r.status}`);

// L'ordre est ce que l'écran de réglages modifie le plus souvent : on vérifie
// qu'une liste réordonnée revient réordonnée, et pas triée autrement.
const inverse = { titres: [...troisMorceaux.titres].reverse() };
await call('/api/admin/settings', { method: 'PUT', body: { musique: inverse } });
cat = await (await fetch(`${BASE}/api/catalog`)).json();
check('Réordonnée, la playlist garde le nouvel ordre',
  cat.musique.titres[0].titre === 'Dernier métro',
  cat.musique.titres.map((m) => m.titre).join(' · '));

r = await call('/api/admin/musique/aaa', { method: 'PATCH', body: { titre: 'Nuit en ville (remix)' } });
check('Un morceau se renomme', r.ok, `HTTP ${r.status}`);
r = await call('/api/admin/musique/aaa', { method: 'PATCH', body: { titre: '   ' } });
check('Mais pas vers un titre vide', r.status === 400, `HTTP ${r.status}`);

r = await call('/api/admin/musique/aaa', { method: 'DELETE' });
const reste = await r.json();
check('Un morceau se retire', r.ok && reste.titres.length === 2, `${reste.titres?.length} restants`);
r = await call('/api/admin/musique/aaa', { method: 'DELETE' });
check('Le retirer deux fois répond 404', r.status === 404, `HTTP ${r.status}`);

console.log('\n── L\'envoi d\'un morceau ────────────────────────────');

// Ce qui suit ne vérifie pas l'aller-retour avec Telegram — injoignable
// depuis une machine d'intégration — mais tout ce qui se passe avant lui, et
// c'est là que le premier envoi réel a échoué : la route n'était pas déclarée
// auprès du lecteur de corps brut, le binaire tombait dans `express.json()`,
// et la boutique répondait « Aucun fichier reçu » sur un fichier bien arrivé.
const envoyer = (corps, type, nom = 'essai.mp3') =>
  fetch(`${BASE}/api/admin/musique/upload?nom=${encodeURIComponent(nom)}`, {
    method: 'POST',
    headers: { 'Content-Type': type, 'X-Telegram-Init-Data': admin },
    body: corps,
  });

r = await envoyer(Buffer.from('ID3\x04\x00\x00\x00' + 'x'.repeat(4000)), 'audio/mpeg');
let dit = await r.json().catch(() => ({}));
check('Le corps brut arrive jusqu\'à la route',
  dit.error !== 'Aucun fichier reçu.', dit.error ?? `HTTP ${r.status}`);

r = await envoyer(Buffer.from('ceci est un texte'), 'text/plain', 'notes.txt');
dit = await r.json().catch(() => ({}));
check('Un fichier qui n\'est pas un morceau est refusé',
  r.status === 400 && /morceau/i.test(dit.error ?? ''), dit.error ?? `HTTP ${r.status}`);

// Telegram ne rend pas à un bot un fichier de plus de 20 Mo : au-delà,
// l'envoi réussirait et la lecture échouerait pour toujours.
r = await envoyer(Buffer.alloc(20 * 1024 * 1024 + 512 * 1024, 7), 'audio/mpeg');
dit = await r.json().catch(() => ({}));
check('Un morceau de plus de 20 Mo est refusé, avec la raison',
  r.status === 400 && /20 Mo/.test(dit.error ?? ''), (dit.error ?? `HTTP ${r.status}`).slice(0, 70));

// La porte : la playlist est un réglage de boutique, pas une donnée publique.
r = await fetch(`${BASE}/api/admin/musique/aaa`, { method: 'DELETE' });
check('Un client ne touche pas à la playlist', r.status === 401, `HTTP ${r.status}`);

await call('/api/admin/settings', { method: 'PUT', body: { musique: { titres: [] }, features: { musique: false } } });

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Musique : OK'}`);
process.exit(failures ? 1 : 0);
