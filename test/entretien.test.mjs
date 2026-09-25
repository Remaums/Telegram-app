/**
 * L'entretien quotidien : sauvegarder, puis oublier.
 *
 * Deux besognes qui existaient déjà en boutons et que personne ne cliquait.
 * Les automatiser, c'est confier à une minuterie le droit de détruire des
 * données — d'où cette suite, qui vérifie surtout ce qu'elle ne doit PAS
 * faire.
 *
 * Ce qu'elle protège :
 *
 * - une besogne faite aujourd'hui ne se refait pas : redémarrer le serveur
 *   quatre fois n'envoie pas quatre sauvegardes ;
 * - l'oubli passe après la sauvegarde, jamais avant. Une sauvegarde qui
 *   échoue arrête tout : détruire sans filet est la seule faute qu'on ne
 *   rattrape pas ;
 * - une commande encore en cours garde son adresse, quel que soit son âge.
 *   Une livraison sans adresse est impossible à faire, et personne ne
 *   verrait pourquoi ;
 * - le délai a un plancher. Un réglage restauré d'une vieille sauvegarde ne
 *   doit pas pouvoir effacer les commandes de la semaine ;
 * - ce qui part, c'est ce qui désigne quelqu'un. Les montants restent, sinon
 *   le bilan de l'an dernier s'évapore avec les adresses.
 *
 * Usage :  BOT_TOKEN=… node test/entretien.test.mjs
 */
import 'dotenv/config';
import {
  dateLimite, jourDe, aFaire, JOURS_MIN, BATTEMENT_MS,
} from '../server/entretien.js';
import { trierPourPurge } from '../server/orders.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const LE_15 = Date.parse('2026-06-15T10:00:00Z');
const commande = (jour, status = 'livree', extra = {}) => ({
  reference: `CS68-${jour.replace(/-/g, '')}`,
  createdAt: `${jour}T12:00:00.000Z`,
  status,
  user: { id: 777, username: 'lea', firstName: 'Léa' },
  address: { street: '12 rue des Lilas', city: 'Colmar', postcode: '68000' },
  phone: '0600000000',
  contact: '12 rue des Lilas, Colmar',
  note: 'sonner deux fois',
  total: 5400,
  items: [{ id: 'x', quantity: 2, lineTotal: 5400 }],
  zone: 'centre',
  ...extra,
});

console.log('\n── Le compte des jours ─────────────────────────────');

check('La limite recule du bon nombre de jours',
  dateLimite(30, LE_15) === '2026-05-16', dateLimite(30, LE_15));
check('Le jour civil se lit', jourDe(LE_15) === '2026-06-15', jourDe(LE_15));

// Le plancher ne protège pas d'une faute de frappe — le panel borne déjà la
// saisie — mais d'un réglage arrivé d'ailleurs : une vieille sauvegarde, une
// écriture à la main dans le fichier.
for (const [valeur, nom] of [[0, 'zéro'], [-999, 'négatif'], [null, 'absent'],
                             ['bonjour', 'du texte'], [NaN, 'NaN']]) {
  check(`Un délai ${nom} retombe sur le plancher`,
    dateLimite(valeur, LE_15) === dateLimite(JOURS_MIN, LE_15), dateLimite(valeur, LE_15));
}
check('Le plancher laisse au moins une semaine', JOURS_MIN >= 7, `${JOURS_MIN} jours`);
check('Un délai au-dessus du plancher est respecté',
  dateLimite(90, LE_15) === '2026-03-17', dateLimite(90, LE_15));

console.log('\n── Une fois par jour, pas une de plus ──────────────');

check('Jamais fait : à faire', aFaire(null, LE_15) === true);
check('Fait aujourd hui : plus à faire', aFaire('2026-06-15', LE_15) === false);
check('Fait hier : à refaire', aFaire('2026-06-14', LE_15) === true);
// Le cas du redémarrage : quatre lancements dans la même journée.
check('Quatre redémarrages, une seule sauvegarde',
  [0, 3600e3, 7200e3, 10800e3].every((d) => aFaire('2026-06-15', LE_15 + d) === false));
// On compte en jours civils et non en durées : « toutes les 24 h » ferait
// glisser l'heure un peu plus tard chaque jour.
check('Le battement regarde toutes les heures', BATTEMENT_MS === 3600000, `${BATTEMENT_MS} ms`);

console.log('\n── Ce que l oubli a le droit de toucher ────────────');

const lot = [
  commande('2026-01-10', 'livree'),      // vieille et finie → à oublier
  commande('2026-01-11', 'annulee'),     // vieille et finie → à oublier
  commande('2026-01-12', 'nouvelle'),    // vieille mais en cours → intouchable
  commande('2026-01-13', 'confirmee'),   // vieille mais en cours → intouchable
  commande('2026-01-14', 'prete'),       // vieille mais en cours → intouchable
  commande('2026-06-14', 'livree'),      // récente → intouchable
];

const auto = trierPourPurge(lot, {
  mode: 'anonymiser', avant: dateLimite(30, LE_15), seulementFinies: true,
});
check('Seules les vieilles commandes finies sont oubliées',
  auto.anonymisees === 2, `${auto.anonymisees} anonymisée(s)`);
check('Aucune commande n est supprimée', auto.effacees === 0);
check('Toutes les commandes restent en place', auto.gardees.length === lot.length);

const parStatut = Object.fromEntries(auto.gardees.map((o) => [o.status, o.anonymise === true]));
check('Une commande en cours garde son adresse, même vieille',
  parStatut.nouvelle === false && parStatut.confirmee === false && parStatut.prete === false,
  JSON.stringify(parStatut));

const oubliee = auto.gardees.find((o) => o.status === 'annulee');
check('Ce qui désigne quelqu un est parti',
  oubliee.address === null && oubliee.phone === null && oubliee.contact === null &&
  oubliee.note === null && oubliee.user.id === null && oubliee.user.firstName === null,
  JSON.stringify({ a: oubliee.address, t: oubliee.phone, u: oubliee.user.id }));
check('Ce qui fait la comptabilité est resté',
  oubliee.total === 5400 && oubliee.items.length === 1 && oubliee.reference.startsWith('CS68-'),
  `${oubliee.total} centimes`);
check('Le secteur reste : il désigne une commune, pas une porte',
  oubliee.zone === 'centre', String(oubliee.zone));

// Repasser dessus ne doit rien recompter : sans le drapeau `anonymise`, le
// vendeur verrait « 40 commandes oubliées » tous les jours pour toujours.
const encore = trierPourPurge(auto.gardees, {
  mode: 'anonymiser', avant: dateLimite(30, LE_15), seulementFinies: true,
});
check('Un second passage ne recompte rien', encore.anonymisees === 0, `${encore.anonymisees}`);

console.log('\n── Le bouton du panel n a pas changé ───────────────');

// L'effacement manuel reste ce qu'il était : le vendeur qui clique sait ce
// qu'il efface, la minuterie non. La différence tient à qui décide.
const manuel = trierPourPurge(lot, { mode: 'anonymiser', avant: dateLimite(30, LE_15) });
check('Sans le garde-fou, tout ce qui est vieux part',
  manuel.anonymisees === 5, `${manuel.anonymisees} anonymisée(s)`);
check('Et la commande récente reste épargnée',
  manuel.gardees.find((o) => o.createdAt.startsWith('2026-06-14')).anonymise !== true);

const tout = trierPourPurge(lot, { mode: 'tout' });
check('Le mode « tout » vide encore', tout.gardees.length === 0 && tout.effacees === lot.length);

console.log('\n── La sauvegarde d abord, l oubli ensuite ──────────');

// La garantie qui compte le plus de toute cette suite. L'ordre des deux
// besognes n'est pas une préférence : une sauvegarde qui échoue — Telegram
// injoignable, quota plein, réseau coupé — doit arrêter le passage AVANT
// qu'on ne détruise quoi que ce soit. Sans ce test, quelqu'un peut un jour
// entourer la sauvegarde d'un try/catch bien intentionné, et l'oubli se
// mettrait à tourner sans filet, en silence.
const { passage, journal } = await import('../server/entretien.js');
const { getSettings, saveSettings } = await import('../server/settings.js');

const reglagesAvant = await getSettings();
try {
  // `oubliJours: 3650` : même si l'oubli s'exécutait par erreur, dix ans en
  // arrière ne touchent rien. On teste l'enchaînement, pas la destruction.
  await saveSettings({
    entretien: { sauvegardeAuto: true, oubliAuto: true, oubliJours: 3650 },
  });

  const avant = await journal();
  let parti = false;
  let erreur = null;
  try {
    await passage({
      envoyer: async () => {
        parti = true;
        throw new Error('Telegram injoignable');
      },
    });
  } catch (err) {
    erreur = err;
  }

  check('La sauvegarde a bien été tentée', parti === true);
  check('Le passage s arrête sur l échec',
    erreur !== null && /injoignable/.test(erreur.message), erreur?.message ?? 'aucune erreur');

  const apres = await journal();
  check('Rien n a été oublié après une sauvegarde ratée',
    apres.oubli === avant.oubli, `${avant.oubli} → ${apres.oubli}`);
  check('Et la sauvegarde n est pas notée comme faite',
    apres.sauvegarde === avant.sauvegarde, `${avant.sauvegarde} → ${apres.sauvegarde}`);
} finally {
  // On remet les réglages du vendeur : une suite de tests n'a pas à décider
  // qu'il efface ses adresses.
  await saveSettings({ entretien: reglagesAvant.entretien ?? {} });
}

console.log(`\n${failures === 0 ? '✅' : '❌'}  ${failures} test(s) en échec\n`);
process.exit(failures === 0 ? 0 : 1);
