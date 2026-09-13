/**
 * Les avis des clients.
 *
 * Un avis ne se donne pas sur un produit qu'on a vu : il se donne sur un
 * produit qu'on a reçu. Chaque avis est donc attaché à une commande, et la
 * commande décide de tout — qui a le droit d'écrire, sur quel produit, et une
 * seule fois. Sans cette attache, la page d'un produit vaudrait ce que vaut le
 * premier robot qui passe.
 *
 * Ce fichier tient le magasin et les règles. Il ne connaît ni Telegram, ni
 * Express : les fonctions qui décident sont pures et se vérifient sans rien
 * démarrer.
 */

import crypto from 'node:crypto';
import { createStore } from './store.js';
import { HttpError } from './catalog.js';

const store = createStore('avis.json', []);

/** Ce qu'on accepte d'écrire. Au-delà, ce n'est plus un avis, c'est un roman. */
export const TEXTE_MAX = 600;

/**
 * Le délai après lequel une commande devient « reçue » faute de mieux.
 *
 * L'idéal serait d'attendre le statut « livrée ». Mais beaucoup de vendeurs ne
 * font jamais avancer leurs statuts au-delà de « confirmée » : attendre
 * « livrée » interdirait alors tous les avis pour toujours, sans que personne
 * ne comprenne pourquoi. Passé ce délai, on considère que le client sait de
 * quoi il parle.
 */
export const DELAI_HEURES = 24;

/** Les états qui valent réception, quel que soit le temps écoulé. */
const RECUE = new Set(['prete', 'livree']);

/**
 * Cette commande peut-elle recevoir un avis ?
 *
 * Fonction pure : la commande, l'instant, rien d'autre. Elle rend `null` quand
 * c'est possible, et sinon la raison — dite au client, pas un code.
 */
export function refusDAvis(order, { maintenant = new Date(), delaiHeures = DELAI_HEURES } = {}) {
  if (!order) return "Cette commande n'existe pas.";
  if (order.status === 'annulee') return 'Cette commande a été annulée.';
  if (RECUE.has(order.status)) return null;

  const passe = new Date(maintenant).getTime() - new Date(order.createdAt).getTime();
  if (passe >= delaiHeures * 3600000) return null;

  const reste = Math.ceil((delaiHeures * 3600000 - passe) / 3600000);
  return `Tu pourras donner ton avis quand tu auras reçu ta commande${
    reste > 0 ? ` — dans ${reste} h au plus tard` : ''
  }.`;
}

/** Une note est un entier de 1 à 5. Le reste n'en est pas une. */
export function noteValide(valeur) {
  const note = Number(valeur);
  return Number.isInteger(note) && note >= 1 && note <= 5 ? note : null;
}

/** Le texte d'un avis, détouré et borné. Vide est permis : la note suffit. */
export function texteDAvis(valeur) {
  const propre = String(valeur ?? '').replace(/\s+/g, ' ').trim();
  if (propre.length > TEXTE_MAX) {
    throw new HttpError(400, `Ton avis dépasse ${TEXTE_MAX} caractères.`);
  }
  return propre;
}

/**
 * Ce qu'une liste d'avis dit d'un produit.
 *
 * La répartition compte autant que la moyenne : 4,0 obtenu avec dix « 4 » et
 * 4,0 obtenu avec cinq « 5 » et cinq « 3 » ne racontent pas la même boutique.
 * Les avis masqués sont hors du compte — un avis retiré ne doit pas continuer
 * à peser sur la note.
 */
export function resumeParProduit(avis) {
  const par = new Map();

  for (const a of Array.isArray(avis) ? avis : []) {
    if (a.statut === 'masque') continue;
    const entree = par.get(a.productId) ?? { total: 0, nombre: 0, repartition: [0, 0, 0, 0, 0] };
    entree.total += a.note;
    entree.nombre += 1;
    entree.repartition[a.note - 1] += 1;
    par.set(a.productId, entree);
  }

  return Object.fromEntries(
    [...par.entries()].map(([productId, e]) => [
      productId,
      {
        // Un dixième de point : deux décimales donneraient une précision que
        // sept avis n'ont pas.
        moyenne: Math.round((e.total / e.nombre) * 10) / 10,
        nombre: e.nombre,
        repartition: e.repartition,
      },
    ])
  );
}

/**
 * Le nom sous lequel un avis s'affiche aux autres clients.
 *
 * Une seule fonction pour toute la boutique : si le choix d'anonymat se
 * décidait dans chaque route, il suffirait d'en oublier une pour publier un
 * prénom que quelqu'un avait demandé de taire.
 */
export function nomPublic(avis) {
  return avis?.anonyme ? null : avis?.user?.firstName ?? null;
}

/* ══ Le magasin ══════════════════════════════════════════════ */

export async function tousLesAvis() {
  return [...(await store.read())];
}

/** Les avis visibles d'un produit, du plus récent au plus ancien. */
export async function avisDuProduit(productId, { limite = 50 } = {}) {
  const tous = await store.read();
  return tous
    .filter((a) => a.productId === String(productId) && a.statut !== 'masque')
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limite);
}

/** Le résumé de tous les produits, pour le catalogue. */
export async function notesDuCatalogue() {
  return resumeParProduit(await store.read());
}

/** Les références déjà commentées par quelqu'un, pour ne pas les reproposer. */
export async function referencesDejaNotees(userId) {
  const tous = await store.read();
  const id = String(userId);
  return new Set(tous.filter((a) => String(a.user?.id) === id).map((a) => a.reference));
}

/**
 * Enregistre les avis d'une commande.
 *
 * Une commande, un passage : on écrit toutes les notes d'un coup plutôt qu'une
 * par produit. Deux raisons — le client voit un seul écran, et le magasin ne
 * peut pas se retrouver avec la moitié des notes d'une commande si le réseau
 * lâche au milieu.
 */
export async function deposerAvis({ order, notes, texte, user, anonyme = false }) {
  const produitsDeLaCommande = new Set((order.items ?? []).map((i) => String(i.id)));
  const propre = texteDAvis(texte);

  const aEcrire = [];
  for (const [productId, valeur] of Object.entries(notes ?? {})) {
    // Une note sur un produit absent de la commande n'est pas une erreur de
    // frappe : c'est quelqu'un qui essaie de noter ce qu'il n'a pas acheté.
    if (!produitsDeLaCommande.has(String(productId))) {
      throw new HttpError(400, "Cet article n'est pas dans cette commande.");
    }
    const note = noteValide(valeur);
    if (note === null) throw new HttpError(400, 'Une note va de 1 à 5 étoiles.');
    aEcrire.push({ productId: String(productId), note });
  }

  if (!aEcrire.length) throw new HttpError(400, 'Mets au moins une note.');

  return store.update((liste) => {
    // Une commande ne porte qu'un avis, jamais deux. Un deuxième envoi n'est
    // pas une erreur à refuser : c'est quelqu'un qui se ravise, ou qui ajoute
    // un mot à une note donnée d'un doigt depuis le bot. On remplace.
    //
    // Le remplacement est ici, dans la même opération que l'écriture : le
    // vérifier avant laisserait deux envois partis en même temps créer deux
    // avis, et gonfler la moyenne du produit avec une seule commande.
    const anciens = [];
    for (let i = liste.length - 1; i >= 0; i -= 1) {
      if (liste[i].reference === order.reference) anciens.push(...liste.splice(i, 1));
    }

    const maintenant = new Date().toISOString();
    // La date d'origine survit à la correction : un avis d'avril corrigé en
    // juin reste un avis d'avril, et ne remonte pas en tête de liste.
    const createdAt = anciens.length
      ? anciens.map((a) => a.createdAt).sort()[0]
      : maintenant;

    const neufs = aEcrire.map(({ productId, note }) => {
      const avant = anciens.find((a) => a.productId === productId);
      return {
        id: avant?.id ?? `av_${crypto.randomBytes(5).toString('hex')}`,
        reference: order.reference,
        productId,
        note,
        texte: propre,
        // Signé ou non : c'est le client qui décide, à chaque avis. Le vendeur,
        // lui, voit toujours qui a écrit — c'est sa boutique, et un avis anonyme
        // reste rattaché à une commande qu'il doit pouvoir retrouver. L'anonymat
        // est vis-à-vis des autres clients, pas du vendeur : le promettre à
        // celui-ci aussi serait mentir, puisque la commande le dit.
        anonyme: Boolean(anonyme),
        user: {
          id: String(user?.id ?? order.user?.id ?? ''),
          firstName: user?.first_name ?? order.user?.firstName ?? null,
          username: user?.username ?? order.user?.username ?? null,
        },
        createdAt,
        modifieLe: anciens.length ? maintenant : null,
        // Un avis masqué par le vendeur ne se republie pas d'une correction du
        // client : ce serait rendre la modération inutile.
        statut: avant?.statut ?? 'publie',
        reponse: avant?.reponse ?? null,
      };
    });

    liste.push(...neufs);
    return neufs;
  });
}

/**
 * L'avis qu'un client a déjà donné sur une commande, ou `null`.
 *
 * Sert à rouvrir l'écran sur ce qu'il avait mis, plutôt que sur cinq étoiles
 * vides qui lui feraient croire que son avis s'est perdu.
 */
export async function avisDeLaCommande(reference, userId) {
  const tous = await store.read();
  const siens = tous.filter(
    (a) => a.reference === String(reference) && String(a.user?.id) === String(userId)
  );
  if (!siens.length) return null;
  return {
    texte: siens[0].texte,
    anonyme: Boolean(siens[0].anonyme),
    notes: Object.fromEntries(siens.map((a) => [a.productId, a.note])),
    createdAt: siens[0].createdAt,
  };
}

/** Masque ou republie un avis. Masquer ne l'efface pas : on peut revenir. */
export async function changerStatut(id, statut) {
  if (!['publie', 'masque'].includes(statut)) throw new HttpError(400, 'Statut inconnu.');
  return store.update((liste) => {
    const avis = liste.find((a) => a.id === id);
    if (!avis) throw new HttpError(404, 'Avis introuvable.');
    avis.statut = statut;
    return avis;
  });
}

/**
 * La réponse du vendeur, publiée sous l'avis.
 *
 * Une réponse vaut mieux qu'un avis effacé : un « désolé, on a corrigé » sous
 * une mauvaise note en dit plus long sur une boutique que trois cinq étoiles.
 */
export async function repondreALAvis(id, texte) {
  const propre = texteDAvis(texte);
  return store.update((liste) => {
    const avis = liste.find((a) => a.id === id);
    if (!avis) throw new HttpError(404, 'Avis introuvable.');
    avis.reponse = propre ? { texte: propre, createdAt: new Date().toISOString() } : null;
    return avis;
  });
}

export async function supprimerAvis(id) {
  return store.update((liste) => {
    const index = liste.findIndex((a) => a.id === id);
    if (index === -1) throw new HttpError(404, 'Avis introuvable.');
    return liste.splice(index, 1)[0];
  });
}

/** Efface les avis d'un produit supprimé : ils ne mènent plus nulle part. */
export async function oublierProduit(productId) {
  return store.update((liste) => {
    const id = String(productId);
    let effaces = 0;
    for (let i = liste.length - 1; i >= 0; i -= 1) {
      if (liste[i].productId === id) {
        liste.splice(i, 1);
        effaces += 1;
      }
    }
    return effaces;
  });
}
