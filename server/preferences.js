/**
 * Ce que chaque client accepte de recevoir.
 *
 * Deux canaux, séparés parce qu'ils ne se valent pas : être prévenu d'une
 * nouveauté est une invitation, être prévenu d'une promo est une affaire. Les
 * mêmes personnes ne veulent pas les deux, et les mélanger fait perdre les deux
 * — celui que les nouveautés lassent coupe tout, promos comprises.
 *
 * Ouverts par défaut, et c'est un choix assumé : quelqu'un qui a commandé ici a
 * ouvert une conversation avec le bot, et la boutique n'écrit qu'à ses clients.
 * Ce qui compte est que couper soit immédiat, visible et respecté partout — pas
 * qu'il faille cocher une case pour exister.
 *
 * Le /stop du bot reste au-dessus de tout : qui a dit stop ne reçoit plus rien,
 * quel que soit l'état de ces deux interrupteurs. Une seule règle à retenir,
 * plutôt que deux qui se contredisent un jour.
 */

import { createStore } from './store.js';
import { estDesabonne, listeDesabonnes } from './annonces.js';

const store = createStore('preferences.json', {});

/** Les canaux que la boutique sait adresser. */
export const CANAUX = [
  {
    clef: 'nouveautes',
    label: 'Nouveaux produits',
    hint: "Un message quand un article arrive au catalogue.",
  },
  {
    clef: 'promos',
    label: 'Promos et codes',
    hint: 'Un message quand une remise ou un code promo démarre.',
  },
];

const CLEFS = CANAUX.map((c) => c.clef);

/** Tout est ouvert tant que personne n'a rien coupé. */
export const parDefaut = () => Object.fromEntries(CLEFS.map((c) => [c, true]));

/** Ce qu'un client accepte, avec les valeurs par défaut pour ce qu'il n'a pas dit. */
export async function preferencesDe(userId) {
  const data = await store.read();
  const sien = data[String(userId)] ?? {};
  return Object.fromEntries(CLEFS.map((c) => [c, sien[c] !== false]));
}

/**
 * Enregistre ce que le client vient de choisir.
 *
 * Seules les clés connues sont retenues, et seulement si elles sont booléennes :
 * un écran qui envoie autre chose ne doit pas pouvoir inventer un canal, ni
 * écrire `"false"` — la chaîne — là où un `false` est attendu.
 */
export async function enregistrerPreferences(userId, recues) {
  const id = String(userId);
  const propre = {};
  for (const clef of CLEFS) {
    if (typeof recues?.[clef] === 'boolean') propre[clef] = recues[clef];
  }

  await store.update((data) => {
    data[id] = { ...(data[id] ?? {}), ...propre, maj: new Date().toISOString() };
    return data[id];
  });

  return preferencesDe(id);
}

/**
 * Peut-on écrire à cette personne sur ce canal ?
 *
 * Le désabonnement global passe avant : c'est lui qu'on a promis de respecter
 * « quelle que soit l'annonce », et une préférence de canal ne doit pas pouvoir
 * le contredire.
 */
export async function accepte(userId, canal) {
  if (!CLEFS.includes(canal)) return false;
  if (await estDesabonne(userId)) return false;
  return (await preferencesDe(userId))[canal];
}

/**
 * Filtre une liste de destinataires sur un canal.
 *
 * Deux lectures pour toute la liste, pas deux par personne : une diffusion à
 * trois cents clients ferait six cents allers-retours au magasin, et sur
 * Postgres autant de requêtes.
 */
export async function destinatairesDuCanal(clients, canal) {
  if (!CLEFS.includes(canal)) return [];
  const [data, desabonnes] = await Promise.all([store.read(), listeDesabonnes()]);
  const coupes = new Set(desabonnes.map(String));

  return (clients ?? []).filter((c) => {
    const id = String(c.id);
    if (coupes.has(id)) return false;
    return data[id]?.[canal] !== false;
  });
}

/**
 * Qui accepte quoi, pour l'écran d'administration.
 *
 * Rendu par identifiant plutôt que par canal : les fiches clients affichent une
 * personne à la fois, et croiser deux listes dans l'écran reviendrait à refaire
 * ce travail à chaque carte.
 */
export async function toutesLesPreferences() {
  const data = await store.read();
  return Object.fromEntries(
    Object.entries(data).map(([id, sien]) => [
      id,
      Object.fromEntries(CLEFS.map((c) => [c, sien[c] !== false])),
    ])
  );
}

/** Combien de clients acceptent chaque canal, parmi ceux qu'on peut joindre. */
export async function compterParCanal(clients) {
  const compte = {};
  for (const canal of CLEFS) {
    compte[canal] = (await destinatairesDuCanal(clients, canal)).length;
  }
  return compte;
}
