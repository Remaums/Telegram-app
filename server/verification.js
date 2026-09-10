import { createStore } from './store.js';
import { HttpError } from './catalog.js';

/**
 * Vérification d'âge par pièce d'identité.
 *
 * Conception : une pièce d'identité est une donnée personnelle sensible. La
 * boutique ne la télécharge pas, ne l'enregistre pas et n'en garde aucune
 * référence — le document reste dans la conversation Telegram, où le vendeur
 * le regarde puis le supprime. Ici on ne conserve que le verdict :
 *
 *   { statut, demandé le, décidé le, décidé par }
 *
 * C'est le minimum nécessaire pour savoir qui a le droit de commander, et
 * c'est déjà beaucoup : à activer seulement si la loi de ton pays l'exige.
 */

const STATUSES = ['pending', 'approved', 'refused'];

const store = createStore('verifications.json', {});

export async function getVerification(userId) {
  const data = await store.read();
  return data[String(userId)] ?? { status: 'none' };
}

export async function listVerifications() {
  const data = await store.read();
  return Object.entries(data)
    .map(([id, record]) => ({ id, ...record }))
    .sort((a, b) => (b.requestedAt ?? '').localeCompare(a.requestedAt ?? ''));
}

/** Le client vient d'envoyer un document : sa demande est en attente. */
export async function requestVerification(userId) {
  return store.update((data) => {
    const key = String(userId);
    data[key] = {
      status: 'pending',
      requestedAt: new Date().toISOString(),
      decidedAt: null,
      decidedBy: null,
    };
    return data[key];
  });
}

/** Verdict du vendeur. Aucune trace du document n'est ajoutée ici. */
export async function decideVerification(userId, status, adminId) {
  if (!STATUSES.includes(status)) throw new HttpError(400, `Statut inconnu : ${status}`);

  return store.update((data) => {
    const key = String(userId);
    data[key] = {
      ...(data[key] ?? {}),
      status,
      requestedAt: data[key]?.requestedAt ?? new Date().toISOString(),
      decidedAt: new Date().toISOString(),
      decidedBy: adminId ? String(adminId) : null,
    };
    return data[key];
  });
}

/** Retire une décision : le client repasse par la case départ. */
export async function resetVerification(userId) {
  return store.update((data) => {
    delete data[String(userId)];
    return { id: String(userId), status: 'none' };
  });
}

export function isApproved(record) {
  return record?.status === 'approved';
}
