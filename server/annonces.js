import { createStore } from './store.js';
import { listOrders } from './orders.js';
import { HttpError } from './catalog.js';

/**
 * Annonces envoyées aux clients de la boutique.
 *
 * Trois garde-fous, parce qu'un bot qui envoie trop finit bloqué par ses
 * propres clients et parfois par Telegram :
 *
 * 1. **Le désabonnement est respecté d'abord.** Qui a dit stop ne reçoit plus
 *    rien, quelle que soit l'annonce.
 * 2. **Une cadence minimale entre deux annonces.** L'erreur classique n'est
 *    pas d'envoyer une fois de trop, c'est d'envoyer trois fois le même jour.
 * 3. **Un envoi étalé, jamais en rafale.** Telegram limite à une trentaine de
 *    messages par seconde et coupe au-delà ; on reste largement en dessous.
 *
 * Ce fichier ne connaît pas Telegram : il décide qui doit recevoir quoi, et
 * rend la liste. L'envoi appartient au bot.
 */

const store = createStore('annonces.json', { desabonnes: [], envois: [] });

/** Délai minimum entre deux annonces, sauf à forcer explicitement. */
export const DELAI_MINIMUM_HEURES = 12;

/* ── Qui reçoit ──────────────────────────────────────────── */

/**
 * Les clients à qui l'on peut écrire.
 *
 * On part des commandes : quelqu'un qui a commandé a ouvert une conversation
 * avec le bot, donc le bot peut lui écrire. Un simple visiteur, non — Telegram
 * refuse d'écrire à qui n'a jamais parlé au bot, et c'est très bien ainsi.
 *
 * @param {object} filtre
 * @param {number} [filtre.depuisJours]  ne garder que les clients récents
 * @param {number} [filtre.minCommandes] ne garder que les habitués
 */
export async function destinataires({ depuisJours, minCommandes = 1 } = {}) {
  const [orders, data] = await Promise.all([listOrders({ limit: 100000 }), store.read()]);
  const desabonnes = new Set((data.desabonnes ?? []).map(String));

  const seuil = depuisJours ? Date.now() - depuisJours * 86400000 : null;
  const parClient = new Map();

  for (const order of orders) {
    const id = String(order.user?.id ?? '');
    if (!id || desabonnes.has(id)) continue;
    if (seuil && new Date(order.createdAt).getTime() < seuil) continue;

    const fiche = parClient.get(id) ?? { id, commandes: 0, derniere: null, prenom: order.user.firstName };
    fiche.commandes++;
    if (!fiche.derniere || order.createdAt > fiche.derniere) fiche.derniere = order.createdAt;
    parClient.set(id, fiche);
  }

  return [...parClient.values()]
    .filter((c) => c.commandes >= minCommandes)
    .sort((a, b) => String(b.derniere).localeCompare(String(a.derniere)));
}

/* ── Désabonnement ───────────────────────────────────────── */

export async function desabonner(id) {
  const cle = String(id);
  return store.update((data) => {
    const liste = new Set((data.desabonnes ?? []).map(String));
    liste.add(cle);
    data.desabonnes = [...liste];
    return { desabonnes: data.desabonnes.length };
  });
}

export async function reabonner(id) {
  const cle = String(id);
  return store.update((data) => {
    data.desabonnes = (data.desabonnes ?? []).map(String).filter((v) => v !== cle);
    return { desabonnes: data.desabonnes.length };
  });
}

/** Tous les désabonnés d'un coup : la fiche client les lit par paquet. */
export async function listeDesabonnes() {
  const data = await store.read();
  return (data.desabonnes ?? []).map(String);
}

export async function estDesabonne(id) {
  const data = await store.read();
  return (data.desabonnes ?? []).map(String).includes(String(id));
}

/* ── Historique et cadence ───────────────────────────────── */

export async function historique(limite = 10) {
  const data = await store.read();
  return [...(data.envois ?? [])].reverse().slice(0, limite);
}

/**
 * Vérifie qu'on peut envoyer maintenant, et réserve le créneau.
 *
 * La réservation se fait dans la même mutation que la vérification : deux
 * appuis sur « Envoyer » ne doivent pas produire deux annonces.
 */
export async function reserverEnvoi({ texte, cibles, force = false }) {
  const message = String(texte ?? '').trim();
  if (message.length < 10) throw new HttpError(400, 'Une annonce fait au moins dix caractères.');
  if (message.length > 3000) throw new HttpError(400, 'Une annonce fait au plus 3000 caractères.');

  return store.update((data) => {
    const envois = data.envois ?? (data.envois = []);
    const dernier = envois[envois.length - 1];

    if (dernier && !force) {
      const heures = (Date.now() - new Date(dernier.envoyeLe).getTime()) / 3600000;
      if (heures < DELAI_MINIMUM_HEURES) {
        const reste = Math.ceil(DELAI_MINIMUM_HEURES - heures);
        throw new HttpError(
          429,
          `Dernière annonce il y a moins de ${DELAI_MINIMUM_HEURES} h. Attends encore ${reste} h, ` +
            'ou coche « envoyer quand même ».'
        );
      }
    }

    const envoi = {
      id: `${Date.now().toString(36)}`,
      texte: message,
      cibles,
      envoyeLe: new Date().toISOString(),
      recus: null,
      echecs: null,
    };
    envois.push(envoi);
    // On ne garde pas l'historique complet : cinquante annonces suffisent à
    // savoir ce qu'on a dit et quand.
    if (envois.length > 50) envois.splice(0, envois.length - 50);
    return envoi;
  });
}

/** Consigne le résultat une fois l'envoi terminé. */
export async function consignerResultat(id, { recus, echecs }) {
  return store.update((data) => {
    const envoi = (data.envois ?? []).find((e) => e.id === id);
    if (envoi) Object.assign(envoi, { recus, echecs });
    return envoi ?? null;
  });
}

/** Retire une annonce dont l'envoi n'a jamais commencé. */
export async function annulerEnvoi(id) {
  return store.update((data) => {
    data.envois = (data.envois ?? []).filter((e) => e.id !== id);
    return { envois: data.envois.length };
  });
}
