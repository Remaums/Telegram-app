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

/* ── Ce qui se déduit : rang, rythme, habitudes ──────────── */

{
  // Un vendredi soir, un samedi soir, un vendredi soir : l'habitude est le
  // vendredi. Les heures sont en UTC dans les données et en Europe/Paris à
  // l'affichage — 22 h UTC un vendredi, c'est minuit samedi à Paris, donc on
  // vérifie bien que le fuseau est appliqué et pas ignoré.
  const [marc] = ficheClients(
    [
      commande('2026-03-06T19:00:00Z', 3000),  // vendredi 20 h à Paris
      commande('2026-03-07T19:00:00Z', 3000),  // samedi 20 h
      commande('2026-03-13T19:00:00Z', 6000),  // vendredi 20 h
    ],
    { timezone: 'Europe/Paris', maintenant: new Date('2026-03-20T19:00:00Z') }
  );

  check('Le rythme moyen se calcule entre la première et la dernière', marc.frequence === 4, `${marc.frequence} j`);
  check('Le jour habituel ressort', marc.habitudes.jour === 'vendredi', String(marc.habitudes.jour));
  check('L heure habituelle est celle du fuseau de la boutique', marc.habitudes.heure === 20, String(marc.habitudes.heure));
  check('Les jours depuis la dernière commande se comptent', marc.joursDepuis === 7, `${marc.joursDepuis}`);
  check('Les articles se totalisent', marc.articles === 3, `${marc.articles}`);
  check('Sans deuxième commande, il n y a pas de rythme à inventer',
    ficheClients([commande('2026-03-06T19:00:00Z', 3000)])[0].frequence === null);
}

{
  // Le fuseau change le jour : 23 h UTC un vendredi est déjà samedi à Paris.
  const minuit = [commande('2026-03-06T23:30:00Z', 3000)];
  check('À Paris, 23 h 30 UTC un vendredi est un samedi',
    ficheClients(minuit, { timezone: 'Europe/Paris' })[0].habitudes.jour === 'samedi',
    ficheClients(minuit, { timezone: 'Europe/Paris' })[0].habitudes.jour);
  check('En UTC, ça reste un vendredi',
    ficheClients(minuit, { timezone: 'UTC' })[0].habitudes.jour === 'vendredi',
    ficheClients(minuit, { timezone: 'UTC' })[0].habitudes.jour);
  check('Un fuseau inconnu ne fait pas tomber la page',
    ficheClients(minuit, { timezone: 'Mars/Olympus' }).length === 1);
}

{
  // Le taux d'annulation se lit sur le total des commandes, pas sur les
  // honorées : trois annulées sur quatre font 75 %, pas 300 %.
  const [marc] = ficheClients([
    commande('2026-03-01T18:00:00Z', 3000),
    commande('2026-03-02T18:00:00Z', 3000, { status: 'annulee' }),
    commande('2026-03-03T18:00:00Z', 3000, { status: 'annulee' }),
    commande('2026-03-04T18:00:00Z', 3000, { status: 'annulee' }),
  ]);
  check('Le taux d annulation est un pourcentage du total', marc.tauxAnnulation === 75, `${marc.tauxAnnulation} %`);
  check('Les états de toutes les commandes sont comptés, annulées comprises',
    marc.statuts.find((e) => e.status === 'annulee')?.nombre === 3,
    JSON.stringify(marc.statuts));
}

{
  // Le rang se calcule sur l'ensemble des fiches : c'est le seul chiffre qui ne
  // peut pas sortir d'une fiche prise seule.
  const fiches = ficheClients([
    commande('2026-03-01T18:00:00Z', 1000, { user: { id: 1, firstName: 'Petit' } }),
    commande('2026-03-02T18:00:00Z', 9000, { user: { id: 2, firstName: 'Gros' } }),
    commande('2026-03-03T18:00:00Z', 5000, { user: { id: 3, firstName: 'Moyen' } }),
  ]);
  const rang = (id) => fiches.find((f) => f.id === id).rang;
  check('Le meilleur client est premier', rang('2') === 1, `#2 → ${rang('2')}`);
  check('Le plus petit est dernier', rang('1') === 3, `#1 → ${rang('1')}`);
  check('Et chacun sait sur combien', fiches[0].surTotal === 3, `${fiches[0].surTotal}`);
  check('L ordre d affichage reste chronologique, pas par chiffre', fiches[0].id === '3', fiches[0].id);
}

{
  // Les codes promo réclamés, pas les paliers automatiques : un palier n'est pas
  // un code, et les confondre ferait croire à une remise demandée.
  const [marc] = ficheClients([
    commande('2026-03-01T18:00:00Z', 3000, { promoCode: 'BIENVENUE', discountLabel: 'Palier 2' }),
    commande('2026-03-02T18:00:00Z', 3000, { promoCode: 'BIENVENUE' }),
    commande('2026-03-03T18:00:00Z', 3000, { discountLabel: 'Palier 3' }),
  ]);
  check('Les codes utilisés sont comptés', marc.promos[0]?.code === 'BIENVENUE' && marc.promos[0]?.fois === 2,
    JSON.stringify(marc.promos));
  check('Un palier automatique n est pas pris pour un code', marc.promos.length === 1, `${marc.promos.length}`);
}

{
  // Les notes laissées à la commande : elles se perdent sinon dans une commande
  // d'il y a trois semaines, alors que le client les a écrites pour être lues.
  const [marc] = ficheClients([
    commande('2026-03-01T18:00:00Z', 3000, { note: 'sonnez deux fois' }),
    commande('2026-03-02T18:00:00Z', 3000),
  ]);
  check('Les notes du client sont remontées', marc.notes.length === 1 && marc.notes[0].texte === 'sonnez deux fois',
    JSON.stringify(marc.notes));
  check('Et elles portent la commande dont elles viennent', Boolean(marc.notes[0].reference));
}

{
  // Le registre du bot : l'écart entre « il regarde » et « il achète » est la
  // seule chose qu'aucune commande ne raconte.
  const [marc] = ficheClients([commande('2026-03-01T18:00:00Z', 3000)], {
    vus: [{ id: 42, premier: '2026-01-05T10:00:00Z', dernier: '2026-03-10T10:00:00Z', contacts: 31 }],
  });
  check('Il connaît la boutique avant sa première commande',
    marc.vu.premiere.startsWith('2026-01-05'), marc.vu.premiere);
  check('Et on sait combien de fois il l a ouverte', marc.vu.contacts === 31, `${marc.vu.contacts}`);
  check('Un client absent du registre n invente rien',
    ficheClients([commande('2026-03-01T18:00:00Z', 3000)])[0].vu === null);
}

{
  // Tous les produits, pas les trois premiers : l'écran replié en montre trois,
  // déplié il montre la liste, et c'est elle qui dit quoi garder en stock.
  const [marc] = ficheClients([
    commande('2026-03-01T18:00:00Z', 3000, {
      items: [
        { name: 'A', quantity: 1, lineTotal: 100 },
        { name: 'B', quantity: 2, lineTotal: 200 },
        { name: 'C', quantity: 3, lineTotal: 300 },
        { name: 'D', quantity: 4, lineTotal: 400 },
      ],
    }),
  ]);
  check('La liste des produits n est plus tronquée à trois', marc.produits.length === 4, `${marc.produits.length}`);
  check('Le plus pris vient en tête', marc.produits[0].nom === 'D', marc.produits[0].nom);
}

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
