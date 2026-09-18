/**
 * Les favoris d'un client.
 *
 * Rien qu'une liste d'identifiants de produits par personne. Ce qui compte
 * n'est pas le stockage — c'est ce qu'on en fait : un favori dit ce que
 * quelqu'un reviendra chercher, donc ce qu'il faut garder en stock et ce qu'il
 * vaut la peine de lui signaler quand ça revient.
 *
 * Volontairement sans horodatage par article : on garde l'ordre d'ajout, le
 * plus récent en tête, et c'est tout. Savoir à la seconde près quand quelqu'un
 * a aimé un produit n'aide personne et fait un dossier de plus à protéger.
 */

import { createStore } from './store.js';
import { HttpError } from './catalog.js';

const store = createStore('favoris.json', {});

/**
 * Au-delà, ce n'est plus une sélection.
 *
 * La borne n'est pas décorative : sans elle, une boucle côté client — ou
 * quelqu'un qui s'amuse — écrirait sans fin dans le magasin, et la fiche d'un
 * seul compte finirait par peser plus lourd que tout le catalogue.
 */
export const MAX = 100;

/** Les favoris d'un client, le dernier ajouté en tête. */
export async function favorisDe(userId) {
  const data = await store.read();
  return [...(data[String(userId)] ?? [])];
}

/** Vrai si ce produit est dans ses favoris. */
export async function estFavori(userId, productId) {
  return (await favorisDe(userId)).includes(String(productId));
}

/**
 * Ajoute ou retire, selon l'état actuel — et rend le nouvel état.
 *
 * Un seul appel pour les deux sens : le cœur d'une fiche produit bascule, il ne
 * connaît pas son état avant d'être touché. Deux routes obligeraient l'écran à
 * le deviner, et un écran qui devine se trompe dès qu'un autre onglet a changé
 * quelque chose.
 */
export async function basculerFavori(userId, productId) {
  const id = String(userId);
  const produit = String(productId ?? '').trim();
  if (!produit) throw new HttpError(400, 'Produit manquant.');

  return store.update((data) => {
    const liste = (data[id] ?? []).filter((p) => p !== produit);
    const etait = (data[id] ?? []).length !== liste.length;

    if (!etait) {
      if (liste.length >= MAX) {
        throw new HttpError(409, `Pas plus de ${MAX} favoris — retires-en un d'abord.`);
      }
      liste.unshift(produit);
    }

    if (liste.length) data[id] = liste;
    else delete data[id];

    return { favori: !etait, total: liste.length };
  });
}

/** Retire un produit des favoris de tout le monde : il n'existe plus. */
export async function oublierProduit(productId) {
  const produit = String(productId);
  return store.update((data) => {
    let touches = 0;
    for (const [id, liste] of Object.entries(data)) {
      const reste = liste.filter((p) => p !== produit);
      if (reste.length === liste.length) continue;
      touches += 1;
      if (reste.length) data[id] = reste;
      else delete data[id];
    }
    return touches;
  });
}

/**
 * Combien de clients ont mis chaque produit en favori.
 *
 * C'est le chiffre qui intéresse le vendeur : un article très mis en favori et
 * peu vendu est un problème de prix ou de stock, pas de goût.
 */
export async function compterParProduit() {
  const data = await store.read();
  const compte = new Map();
  for (const liste of Object.values(data)) {
    for (const produit of liste) compte.set(produit, (compte.get(produit) ?? 0) + 1);
  }
  return Object.fromEntries(compte);
}

/** Qui a mis ce produit en favori : sert à prévenir au retour en stock. */
export async function amateursDuProduit(productId) {
  const data = await store.read();
  const produit = String(productId);
  return Object.entries(data)
    .filter(([, liste]) => liste.includes(produit))
    .map(([id]) => id);
}
