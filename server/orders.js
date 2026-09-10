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

/**
 * Écrit une commande, et vérifie au passage ce qui se compte sur les commandes.
 *
 * `guards` porte les limites qui ne peuvent pas être contrôlées à l'avance :
 * le plafond horaire d'un client et la capacité d'un créneau se lisent tous
 * deux dans ce magasin. Les vérifier depuis une lecture séparée laissait
 * passer une rafale entière — dix requêtes simultanées lisaient toutes
 * « zéro commande » avant que la première n'écrive. Ici, le comptage et
 * l'écriture sont dans la même mutation : le magasin fichier ne peut pas
 * interrompre une fonction synchrone, et Postgres tient la ligne verrouillée.
 */
export async function createOrder({
  user, items, subtotal, discount = 0, discountLabel = null, promoCode = null,
  deliveryFee = 0, total, mode = 'pickup', contact, note, slot = null, zone = null,
  address = null, phone = null, guards = null,
}) {
  return store.update((orders) => {
    if (guards?.maxPerHour) {
      const depuis = guards.since ?? Date.now() - 60 * 60 * 1000;
      const recentes = orders.filter(
        (o) => o.user.id === user.id && new Date(o.createdAt).getTime() >= depuis
      ).length;
      if (recentes >= guards.maxPerHour) {
        throw new HttpError(
          429,
          `Trop de commandes en une heure (${guards.maxPerHour} maximum). Réessaie plus tard, ou écris-nous.`
        );
      }
    }

    if (guards?.slot) {
      const prises = orders.filter(
        (o) => o.slot?.id === guards.slot.id && o.status !== 'annulee'
      ).length;
      if (prises >= guards.slot.capacity) {
        throw new HttpError(409, `Le créneau ${guards.slot.label} est complet. Prends-en un autre.`);
      }
    }

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
      // L'adresse découpée, telle que le client l'a saisie : c'est elle qui
      // sert à ouvrir un itinéraire, là où `contact` n'est bon qu'à lire.
      address,
      phone,
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
 * Toutes les commandes, pour un calcul d'ensemble.
 *
 * Le bilan a besoin de l'historique complet, pas des cinquante dernières : la
 * première commande d'un client est ce qui le distingue d'un nouveau, et elle
 * peut dater de l'an dernier.
 */
export async function allOrders() {
  return [...(await store.read())];
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

/* ══ Effacer, ou oublier ═════════════════════════════════════ */

/**
 * Ce que devient le magasin après un effacement. Fonction pure : elle décide,
 * `purgerCommandes` écrit.
 *
 * Trois façons de repartir, et elles ne se valent pas :
 *
 * - `tout` : le magasin est vidé. C'est la remise à zéro d'une boutique qu'on
 *   ouvre pour de bon après l'avoir essayée.
 * - `avant` : les commandes antérieures à une date s'en vont, les récentes
 *   restent. Le chiffre d'affaires de l'an dernier disparaît avec elles.
 * - `anonymiser` : les commandes restent avec leurs montants — le bilan ne
 *   bouge pas — mais perdent ce qui désigne quelqu'un : nom, identifiant,
 *   adresse, téléphone, note. C'est presque toujours le bon choix : on garde sa
 *   comptabilité sans garder le domicile de ses clients de l'an dernier.
 *
 * La date se compare en date civile : une commande du jour même de la limite
 * est conservée, la limite est le premier jour qu'on garde.
 */
export function trierPourPurge(orders, { mode, avant } = {}) {
  const liste = Array.isArray(orders) ? orders : [];
  if (mode === 'tout') return { gardees: [], effacees: liste.length, anonymisees: 0 };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(avant ?? ''))) {
    throw new HttpError(400, 'Donne une date, au format AAAA-MM-JJ.');
  }
  const vieille = (o) => String(o?.createdAt ?? '').slice(0, 10) < avant;

  if (mode === 'avant') {
    const gardees = liste.filter((o) => !vieille(o));
    return { gardees, effacees: liste.length - gardees.length, anonymisees: 0 };
  }

  if (mode === 'anonymiser') {
    let anonymisees = 0;
    const gardees = liste.map((o) => {
      if (!vieille(o) || o.anonymise) return o;
      anonymisees++;
      return {
        ...o,
        // Ce qui désigne quelqu'un s'en va. Ce qui fait une comptabilité reste :
        // montants, articles, mode, créneau — et le secteur, qui désigne une
        // commune, pas une porte.
        user: { id: null, username: null, firstName: null },
        address: null,
        phone: null,
        contact: null,
        note: null,
        anonymise: true,
      };
    });
    return { gardees, effacees: 0, anonymisees };
  }

  throw new HttpError(400, `Effacement inconnu : ${mode}`);
}

/** Applique l'effacement. Rien n'est récupérable ensuite, d'où la sauvegarde. */
export async function purgerCommandes({ mode, avant } = {}) {
  return store.update((orders) => {
    const { gardees, effacees, anonymisees } = trierPourPurge(orders, { mode, avant });
    orders.length = 0;
    orders.push(...gardees);
    return { effacees, anonymisees, restantes: gardees.length };
  });
}

/**
 * Remplace toutes les commandes.
 *
 * Réservé à la restauration. On ne revalide pas leur contenu — une commande
 * passée est un fait, pas une saisie —, mais on écarte ce qui n'a ni
 * référence ni client : une ligne abîmée ferait planter l'affichage.
 */
export async function replaceOrders(orders) {
  if (!Array.isArray(orders)) throw new HttpError(400, 'Liste de commandes invalide.');

  const propres = orders.filter((o) => o && typeof o === 'object' && o.reference && o.user?.id);
  return store.update((data) => {
    data.length = 0;
    data.push(...propres);
    return { orders: propres.length, ecartees: orders.length - propres.length };
  });
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
