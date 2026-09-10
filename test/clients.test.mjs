/**
 * Les fiches clients.
 *
 * La boutique ne tient pas de fichier client : elle regroupe ce que les
 * commandes disent déjà. Ce que cette suite protège, c'est donc surtout ce que
 * l'écran ne doit pas raconter de travers — un client annulé compté comme un
 * bon client, une adresse périmée servie comme actuelle, un prénom figé à la
 * première commande — et la porte : le chiffre d'affaires d'un voisin ne
 * regarde personne.
 *
 * Prérequis (partie HTTP) : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/clients.test.mjs
 */
import 'dotenv/config';
import { ficheClients, chercherClients } from '../server/clients.js';
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

const commande = (iso, total, extra = {}) => ({
  reference: `CS68-${iso.slice(8, 10)}${String(total).slice(0, 3)}`,
  createdAt: iso,
  status: 'livree',
  mode: 'delivery',
  user: { id: 42, firstName: 'Marc', username: null },
  items: [{ name: 'Néon Kush', quantity: 1, lineTotal: total }],
  total,
  ...extra,
});

const ADRESSE = { street: '12 rue des Lilas', complement: 'Bât B', postalCode: '68100', city: 'Mulhouse' };

/* ── Ce que les commandes disent d'un client ─────────────── */

{
  const [marc] = ficheClients([
    commande('2026-02-01T18:00:00Z', 3000, { address: ADRESSE, phone: '06 12 34 56 78' }),
    commande('2026-03-01T18:00:00Z', 5000, { address: ADRESSE }),
    commande('2026-03-02T18:00:00Z', 9000, { status: 'annulee' }),
    // Le client s'est choisi un pseudo entre-temps : c'est celui-là qu'on doit
    // lire, pas celui de sa première commande.
    commande('2026-03-03T18:00:00Z', 2000, { mode: 'pickup', user: { id: 42, firstName: 'Marco', username: 'marco' } }),
  ]);

  check('Les commandes sont comptées', marc.commandes === 3, `${marc.commandes}`);
  check("Une annulée ne compte pas comme une vente", marc.annulees === 1 && marc.chiffre === 10000,
    `${marc.annulees} annulée(s), ${marc.chiffre}`);
  check('Le panier moyen porte sur ce qui a été vendu', marc.panierMoyen === 3333, `${marc.panierMoyen}`);
  check('Le nom le plus récent l emporte', marc.nom === 'Marco' && marc.username === 'marco',
    `${marc.nom} @${marc.username}`);
  check('La première et la dernière commande encadrent le client',
    marc.premiere.startsWith('2026-02-01') && marc.derniere.startsWith('2026-03-03'));
  check('Retraits et livraisons se distinguent', marc.livraisons === 2 && marc.retraits === 1,
    `${marc.livraisons} / ${marc.retraits}`);
  check('Ses habitudes se lisent', marc.produits[0]?.nom === 'Néon Kush' && marc.produits[0]?.quantite === 3,
    JSON.stringify(marc.produits));
  check("L'adresse servie deux fois n'est pas listée deux fois", marc.adresses.length === 1,
    `${marc.adresses.length} adresse(s)`);
  check('Le téléphone est retenu', marc.telephones[0] === '06 12 34 56 78');
  check('Les dernières commandes sont là, la plus récente en tête',
    marc.dernieres.length === 4 && marc.dernieres[0].date.startsWith('2026-03-03'));
}

// Un client qui déménage : les deux adresses restent, la plus récente d'abord.
{
  const [marc] = ficheClients([
    commande('2026-01-01T18:00:00Z', 3000, { address: { ...ADRESSE, street: '3 rue de la Gare' } }),
    commande('2026-03-01T18:00:00Z', 3000, { address: ADRESSE }),
  ]);
  check('Un déménagement garde les deux adresses', marc.adresses.length === 2, `${marc.adresses.length}`);
  check('La plus récente vient en premier', marc.adresses[0].street === '12 rue des Lilas', marc.adresses[0].street);
}

// Les états ne s'inventent pas : ils viennent d'ailleurs, on les recopie.
{
  const fiches = ficheClients(
    [commande('2026-03-01T18:00:00Z', 3000), commande('2026-03-02T18:00:00Z', 3000, { user: { id: 7, firstName: 'Zoé' } })],
    { bloques: ['7'], verifications: { 42: { status: 'approved' } }, desabonnes: ['42'] }
  );
  const marc = fiches.find((f) => f.id === '42');
  const zoe = fiches.find((f) => f.id === '7');
  check('Un client bloqué est signalé', zoe.bloque === true && marc.bloque === false);
  check('Une vérification acquise aussi', marc.verification === 'approved' && zoe.verification === 'none');
  check('Un désabonné des annonces aussi', marc.abonne === false && zoe.abonne === true);
  check('Le dernier venu est en tête de liste', fiches[0].id === '7', fiches[0].id);
}

check('Une commande sans client est écartée, pas devinée',
  ficheClients([commande('2026-03-01T18:00:00Z', 3000, { user: {} })]).length === 0);
check('Un magasin vide ne fait pas planter la fiche',
  ficheClients([]).length === 0 && ficheClients(null).length === 0);

/* ── La recherche ────────────────────────────────────────── */

{
  const fiches = ficheClients([
    commande('2026-03-01T18:00:00Z', 3000, {
      address: ADRESSE, phone: '06 12 34 56 78',
      user: { id: 42, firstName: 'Marc', username: 'marco68' },
    }),
    commande('2026-03-02T18:00:00Z', 3000, { user: { id: 7, firstName: 'Zoé' } }),
  ]);

  for (const [quoi, requete] of [
    ['un prénom', 'marc'],
    ['un pseudo', 'marco68'],
    ['un identifiant', '42'],
    ['un téléphone', '0612345678'],
    ['une rue', 'lilas'],
    ['une ville', 'mulhouse'],
    ['un code postal', '68100'],
    ['deux mots dans le désordre', 'lilas marc'],
  ]) {
    const trouves = chercherClients(fiches, requete);
    check(`On retrouve un client par ${quoi}`, trouves.length === 1 && trouves[0].id === '42',
      `${trouves.length} résultat(s)`);
  }

  check('Les accents ne gênent pas', chercherClients(fiches, 'zoe').length === 1);
  check('Une recherche vide ne filtre rien', chercherClients(fiches, '  ').length === 2);
  check('Rien ne correspond : rien ne sort', chercherClients(fiches, 'nawak').length === 0);
}

/* ── La porte ────────────────────────────────────────────── */

const admin = signInitData(TOKEN, { id: 424242, first_name: 'Patron' });
const client = signInitData(TOKEN, { id: 840000 + (Date.now() % 50000), first_name: 'Client' });

let r = await fetch(`${BASE}/api/admin/clients`, { headers: { 'X-Telegram-Init-Data': admin } });
let data = await r.json();
check('La liste se sert à l administrateur',
  r.status === 200 && Array.isArray(data.clients) && typeof data.total === 'number', `HTTP ${r.status}`);
check('Elle est bornée : on n envoie pas mille fiches à un téléphone',
  data.clients.length <= 200, `${data.clients.length} envoyées sur ${data.total}`);

r = await fetch(`${BASE}/api/admin/clients?q=zzz-personne-zzz`, { headers: { 'X-Telegram-Init-Data': admin } });
data = await r.json();
check('La recherche filtre côté serveur', data.total === 0, `${data.total}`);

r = await fetch(`${BASE}/api/admin/clients/999999999999`, { headers: { 'X-Telegram-Init-Data': admin } });
data = await r.json().catch(() => ({}));
check('Un inconnu répond 404, en le disant', r.status === 404 && /jamais commandé/i.test(data.error ?? ''),
  data.error);

// Telegram n'est pas joignable depuis les tests : ce qui compte est que le
// refus se lise, et qu'il n'arrive jamais en « erreur interne ».
r = await fetch(`${BASE}/api/admin/clients/424242/telegram`, { headers: { 'X-Telegram-Init-Data': admin } });
data = await r.json().catch(() => ({}));
check('La fiche Telegram se demande à la demande', [200, 404, 502].includes(r.status), `HTTP ${r.status}`);
check("Et son échec se lit", r.status === 200 || !/interne/i.test(data.error ?? ''), (data.error ?? '').slice(0, 60));

for (const chemin of ['/clients', '/clients/42', '/clients/42/telegram', '/clients/42/photo']) {
  r = await fetch(`${BASE}/api/admin${chemin}`, { headers: { 'X-Telegram-Init-Data': client } });
  check(`Un client n'ouvre pas ${chemin}`, r.status === 403, `HTTP ${r.status}`);
}

r = await fetch(`${BASE}/api/admin/clients`);
check('Sans signature non plus', r.status === 401, `HTTP ${r.status}`);

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Fiches clients : OK'}`);
process.exit(failures ? 1 : 0);
