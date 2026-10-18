/**
 * Où est parti l'avis de chaque commande, dans la conversation du vendeur.
 *
 * Supprimer une commande de l'historique ne sert pas à grand-chose si son
 * avis reste affiché, avec le client, l'adresse et les articles, dans la
 * conversation ou le groupe où les autres administrateurs lisent. Pour
 * pouvoir le retirer, il faut savoir lequel c'était : Telegram ne retrouve
 * pas un message par son contenu.
 *
 * Rangé à part, et pas dans la commande elle-même : la commande est renvoyée
 * telle quelle au client dans « Mes commandes », et il n'a pas à y lire
 * l'identifiant de la conversation du vendeur.
 *
 * Telegram refuse d'effacer un message de plus de 48 heures : au-delà, la
 * fiche ne servirait plus à rien, elle est oubliée à l'écriture suivante.
 */

import { createStore } from './store.js';

const store = createStore('messages-admin.json', {});

export const DUREE_EFFACABLE = 48 * 60 * 60 * 1000;

/** Retient le message qui a annoncé cette commande au vendeur. */
export async function noterMessage(reference, chatId, messageId) {
  await store.update((data) => {
    const maintenant = Date.now();
    for (const [ref, m] of Object.entries(data)) {
      if (!(Date.parse(m.envoyeLe) >= maintenant - DUREE_EFFACABLE)) delete data[ref];
    }
    data[reference] = { chatId: String(chatId), messageId, envoyeLe: new Date(maintenant).toISOString() };
  });
}

/**
 * Rend le message d'une commande et l'oublie, ou `null` s'il n'y en a pas
 * (commande d'avant ce suivi, ou annonce trop vieille pour être effacée).
 */
export async function reprendreMessage(reference) {
  return store.update((data) => {
    const message = data[reference] ?? null;
    delete data[reference];
    if (!message || !(Date.parse(message.envoyeLe) >= Date.now() - DUREE_EFFACABLE)) return null;
    return message;
  });
}
