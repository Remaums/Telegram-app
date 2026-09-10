import crypto from 'node:crypto';
import { createStore } from './store.js';
import { HttpError } from './catalog.js';

const store = createStore('orders.json', []);

/** Cycle de vie d'une commande. `final` = plus aucune transition possible. */
export const STATUSES = {
  nouvelle: { label: 'Nouvelle', emoji: '🆕', next: ['confirmee', 'annulee'] },
  confirmee: { label: 'Confirmée', emoji: '✅', next: ['prete', 'annulee'] },
  prete: { label: 'Prête', emoji: '📦', next: ['livree', 'annulee'] },
  livree: { label: 'Livrée', emoji: '🎉', next: [], final: true },
  annulee: { label: 'Annulée', emoji: '❌', next: [], final: true },
};

/** Référence courte et lisible, du type CS68-7F3A9C. */
function makeReference() {
  return `CS68-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

export async function createOrder({
  user, items, subtotal, discount = 0, discountLabel = null, promoCode = null,
  deliveryFee = 0, total, mode = 'pickup', contact, note, slot = null, zone = null,
}) {
  return store.update((orders) => {
    const order = {
      reference: makeReference(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'nouvelle',
      user: {
        id: user.id,
        username: user.username ?? null,
        firstName: user.first_name ?? null,
      },
      items,
      mode,
      subtotal: subtotal ?? total,
      // Remise appliquée, avec de quoi l'expliquer au client s'il rappelle :
      // le libellé du palier, ou le code qu'il a saisi.
      discount,
      discountLabel,
      promoCode,
      deliveryFee,
      total,
      // Créneau réservé et zone desservie, tels qu'ils étaient au moment de la
      // commande : les réglages peuvent changer, la commande ne doit pas.
      slot,
      zone,
      contact: contact ?? null,
      note: note || null,
    };
    orders.push(order);
    return order;
  });
}

export async function listOrders({ userId, status, limit = 50 } = {}) {
  const orders = await store.read();
  return orders
    .filter((o) => (userId ? o.user.id === userId : true))
    .filter((o) => (status ? o.status === status : true))
    .slice(-limit)
    .reverse();
}

/**
 * Nombre de commandes passées par un client depuis un instant donné.
 *
 * Compté sur les commandes elles-mêmes plutôt que sur un compteur en mémoire :
 * la limite tient donc au redémarrage du serveur, et reste juste si plusieurs
 * instances tournent en parallèle. Les commandes annulées comptent aussi —
 * commander puis annuler en boucle reste un abus.
 */
export async function countOrdersSince(userId, since) {
  const orders = await store.read();
  const floor = since instanceof Date ? since.getTime() : Number(since);
  return orders.filter((o) => o.user.id === userId && new Date(o.createdAt).getTime() >= floor).length;
}

/**
 * Commandes déjà posées sur un créneau.
 *
 * Une commande annulée libère sa place : compter les annulations reviendrait à
 * bloquer un créneau pour un client qui ne viendra pas.
 */
export async function countOrdersForSlot(slotId) {
  const orders = await store.read();
  return orders.filter((o) => o.slot?.id === slotId && o.status !== 'annulee').length;
}

/**
 * Places déjà prises, par créneau, en une seule lecture.
 *
 * L'écran client demande une dizaine de créneaux d'un coup : les compter un
 * par un relirait tout le magasin autant de fois.
 */
export async function slotCounts() {
  const orders = await store.read();
  const counts = new Map();
  for (const order of orders) {
    if (!order.slot?.id || order.status === 'annulee') continue;
    counts.set(order.slot.id, (counts.get(order.slot.id) ?? 0) + 1);
  }
  return counts;
}

export async function getOrder(reference) {
  const orders = await store.read();
  return orders.find((o) => o.reference === reference) ?? null;
}

/**
 * Change le statut d'une commande en respectant les transitions autorisées.
 * Renvoie la commande mise à jour et son statut précédent.
 */
export async function setStatus(reference, status) {
  if (!STATUSES[status]) throw new HttpError(400, `Statut inconnu : ${status}`);

  return store.update((orders) => {
    const order = orders.find((o) => o.reference === reference);
    if (!order) throw new HttpError(404, 'Commande introuvable.');
    if (order.status === status) return { order, previous: status, changed: false };

    const allowed = STATUSES[order.status].next;
    if (!allowed.includes(status)) {
      throw new HttpError(
        400,
        `Transition impossible : « ${STATUSES[order.status].label} » → « ${STATUSES[status].label} ».`
      );
    }

    const previous = order.status;
    order.status = status;
    order.updatedAt = new Date().toISOString();
    return { order, previous, changed: true };
  });
}

/** Chiffres clés affichés sur le tableau de bord admin. */
export async function stats() {
  const orders = await store.read();
  const paid = orders.filter((o) => o.status !== 'annulee');

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const byProduct = new Map();
  for (const order of paid) {
    for (const item of order.items) {
      const key = item.name;
      const current = byProduct.get(key) ?? { name: key, quantity: 0, revenue: 0 };
      current.quantity += item.quantity;
      current.revenue += item.lineTotal;
      byProduct.set(key, current);
    }
  }

  return {
    ordersTotal: orders.length,
    ordersToday: orders.filter((o) => new Date(o.createdAt) >= startOfDay).length,
    pending: orders.filter((o) => o.status === 'nouvelle').length,
    revenue: paid.reduce((sum, o) => sum + o.total, 0),
    revenueToday: paid
      .filter((o) => new Date(o.createdAt) >= startOfDay)
      .reduce((sum, o) => sum + o.total, 0),
    topProducts: [...byProduct.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 5),
  };
}
