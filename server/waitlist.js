import { createStore } from './store.js';

/**
 * Liste d'attente des ruptures.
 *
 * Un client touche « préviens-moi » sur un article épuisé ; dès que le stock
 * repasse au-dessus de zéro, le bot lui écrit et la liste est vidée. On ne
 * garde qu'un identifiant Telegram par ligne de catalogue — rien de plus.
 */

const MAX_PER_KEY = 500;
const store = createStore('waitlist.json', {});

/** Une ligne de catalogue : un produit, éventuellement un format. */
export function waitlistKey(productId, variantId = null) {
  return `${productId}::${variantId ?? ''}`;
}

export async function subscribe(key, userId) {
  return store.update((data) => {
    const list = Array.isArray(data[key]) ? data[key] : [];
    const value = String(userId);
    if (!list.includes(value) && list.length < MAX_PER_KEY) list.push(value);
    data[key] = list;
    return list.length;
  });
}

export async function isSubscribed(key, userId) {
  const data = await store.read();
  return (data[key] ?? []).includes(String(userId));
}

/**
 * Renvoie les inscrits et vide la liste dans la même transaction : deux
 * réassorts coup sur coup ne préviennent pas deux fois les mêmes clients.
 */
export async function takeSubscribers(key) {
  return store.update((data) => {
    const list = data[key] ?? [];
    delete data[key];
    return list;
  });
}

export async function pendingCount() {
  const data = await store.read();
  return Object.values(data).reduce((sum, list) => sum + (list?.length ?? 0), 0);
}
