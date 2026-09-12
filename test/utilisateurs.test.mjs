/**
 * Le registre des utilisateurs du bot.
 *
 * « Client » et « utilisateur » ne se confondent pas : le premier a commandé,
 * le second a simplement ouvert le bot. Ce que cette suite protège :
 *
 * - **on note tout le monde, une fois** : la fiche se crée au premier passage
 *   et se rafraîchit ensuite, sans se dupliquer ni recompter de travers ;
 * - **on ne garde pas ce qu'on n'a pas à garder** : ni le contenu des
 *   messages, ni un autre bot pris pour un utilisateur ;
 * - **la porte tient** : le registre d'une boutique ne se lit pas sans droits.
 *
 * Le cœur est une fonction de magasin, éprouvée directement ; la route HTTP
 * est éprouvée à part, avec ses droits et le croisement des états.
 *
 * Prérequis (partie HTTP) : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/utilisateurs.test.mjs
 */
import 'dotenv/config';
import { signInitData } from './helpers.mjs';

const TOKEN = process.env.BOT_TOKEN;
const BASE = process.env.TEST_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

if (!TOKEN) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer les tests.');
  process.exit(1);
}

const { noterUtilisateur, listUsers, countUsers, chercherUtilisateurs } = await import('../server/users.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

/* ── On note, une fois, puis on rafraîchit ───────────────── */

// Un identifiant tiré au hasard : la suite se rejoue sans dépendre d'un état
// laissé par une exécution précédente.
const ID = 700000 + Math.floor(Math.random() * 200000);

const avant = await countUsers();
await noterUtilisateur({ id: ID, first_name: 'Léa', username: 'lea' });
let apres = await countUsers();
check('Un premier passage crée une fiche', apres === avant + 1, `${avant} → ${apres}`);

let fiche = (await listUsers()).find((u) => u.id === String(ID));
check('Avec ce que Telegram donne', fiche?.prenom === 'Léa' && fiche?.username === 'lea', JSON.stringify(fiche));
check('Un contact compté', fiche?.contacts === 1, `${fiche?.contacts}`);
const premier = fiche.premier;

// Deuxième passage : rien ne se duplique, la première visite ne bouge pas, le
// pseudo le plus récent l'emporte.
await new Promise((r) => setTimeout(r, 5));
await noterUtilisateur({ id: ID, first_name: 'Léa', username: 'lea_2026' });
apres = await countUsers();
check('Un deuxième passage ne crée pas de doublon', apres === avant + 1, `${apres}`);
fiche = (await listUsers()).find((u) => u.id === String(ID));
check('Il compte un contact de plus', fiche?.contacts === 2, `${fiche?.contacts}`);
check('La première visite ne bouge pas', fiche?.premier === premier);
check('La dernière visite avance', fiche?.dernier > premier);
check('Le pseudo le plus récent l emporte', fiche?.username === 'lea_2026', fiche?.username);

// Un pseudo qui disparaît ne doit pas effacer le dernier connu.
await noterUtilisateur({ id: ID, first_name: 'Léa' });
fiche = (await listUsers()).find((u) => u.id === String(ID));
check('Un pseudo retiré ne perd pas le dernier connu', fiche?.username === 'lea_2026');

/* ── Ce qu'on n'enregistre pas ───────────────────────────── */

const compteAvant = await countUsers();
await noterUtilisateur({ id: 999001, first_name: 'RoboBot', is_bot: true });
await noterUtilisateur({ first_name: 'Sans id' });
await noterUtilisateur(undefined);
check('Un autre bot, un sans-id, un vide : rien n est noté', (await countUsers()) === compteAvant,
  `${compteAvant} → ${await countUsers()}`);

const champs = Object.keys(fiche).sort().join(',');
check('Une fiche ne garde que qui/quand/combien, jamais le contenu des messages',
  champs === 'contacts,dernier,id,nom,premier,prenom,username', champs);

/* ── La recherche ────────────────────────────────────────── */

const echantillon = [
  { id: '42', prenom: 'Marc', nom: 'Ober', username: 'marco68' },
  { id: '7', prenom: 'Zoé', nom: null, username: null },
];
for (const [quoi, requete, attendu] of [
  ['un prénom', 'marc', '42'],
  ['un pseudo', 'marco68', '42'],
  ['un identifiant', '42', '42'],
  ['un nom', 'ober', '42'],
  ['les accents ignorés', 'zoe', '7'],
]) {
  const r = chercherUtilisateurs(echantillon, requete);
  check(`On retrouve par ${quoi}`, r.length === 1 && r[0].id === attendu, `${r.length} résultat(s)`);
}
check('Une recherche vide ne filtre rien', chercherUtilisateurs(echantillon, '  ').length === 2);

/* ── La route, et la porte ───────────────────────────────── */

const admin = signInitData(TOKEN, { id: 424242, first_name: 'Patron' });
const client = signInitData(TOKEN, { id: 810000 + (Date.now() % 80000), first_name: 'Client' });

let res = await fetch(`${BASE}/api/admin/users`, { headers: { 'X-Telegram-Init-Data': admin } });
let data = await res.json();
check('Le registre se sert à l administrateur',
  res.status === 200 && Array.isArray(data.users) && typeof data.total === 'number', `HTTP ${res.status}`);
check('Avec les deux nombres qui parlent : visiteurs et acheteurs',
  typeof data.total === 'number' && typeof data.acheteurs === 'number' && data.acheteurs <= data.total,
  `${data.acheteurs} / ${data.total}`);
check('Chaque fiche porte son croisement d états',
  data.users.length === 0 ||
    ['aCommande', 'bloque', 'verification', 'abonne'].every((k) => k in data.users[0]),
  Object.keys(data.users[0] ?? {}).join(','));
check('La liste est bornée : on n envoie pas tout le registre à un téléphone',
  data.users.length <= 300, `${data.users.length} envoyés`);

res = await fetch(`${BASE}/api/admin/users?q=zzz-personne-zzz`, { headers: { 'X-Telegram-Init-Data': admin } });
data = await res.json();
check('La recherche filtre côté serveur', data.montres === 0, `${data.montres}`);

res = await fetch(`${BASE}/api/admin/users`, { headers: { 'X-Telegram-Init-Data': client } });
check("Un client ne lit pas le registre du bot", res.status === 403, `HTTP ${res.status}`);

res = await fetch(`${BASE}/api/admin/users`);
check('Sans signature non plus', res.status === 401, `HTTP ${res.status}`);

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Registre des utilisateurs : OK'}`);
process.exit(failures ? 1 : 0);
