import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Épreuve d'entrée de la boutique.
 *
 * Ce que ça vaut : la vraie barrière contre les robots reste la signature
 * Telegram vérifiée à chaque appel — sans compte Telegram, aucune commande.
 * L'épreuve ajoute une friction et un geste conscient à l'entrée ; elle est
 * donc désactivable, et elle n'est utile que si le serveur la vérifie. D'où
 * ce qui suit.
 *
 * Comment ça marche, sans rien stocker :
 *
 * - le serveur tire une grille de tuiles et signe (HMAC) la bonne réponse,
 *   accompagnée d'une expiration, d'un aléa et de l'identifiant du client ;
 * - le client ne reçoit que la grille et cette signature, jamais la réponse ;
 * - à la validation, le serveur recalcule la signature avec la réponse
 *   *envoyée* : elle ne peut correspondre que si la réponse est la bonne.
 *
 * Aucune session à conserver : la boutique redémarre, se duplique, tout
 * continue de fonctionner.
 */

// Les leurres n'ont rien de végétal : une grille de feuilles qui se
// ressemblent ferait échouer un vrai client, ce qui est le contraire du but.
const DECOYS = ['🍕', '🚗', '🔑', '⭐', '🎈', '🐟', '⚽', '🎧', '🍩', '🧊', '🪙', '🎲', '📦', '🔔'];
const TARGET = '🍁';
const GRID = 9;
const TARGET_COUNT = 3;
const CHALLENGE_TTL = 5 * 60 * 1000;   // le temps de lire la consigne
const PASS_TTL = 12 * 60 * 60 * 1000;  // ne pas réinterroger le client toute la journée

const sign = (payload) =>
  crypto.createHmac('sha256', `captcha:${config.botToken}`).update(payload).digest('hex');

const equal = (a, b) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

/** Tire une grille et renvoie de quoi l'afficher, sans la solution. */
export function buildChallenge(userId) {
  const targets = new Set();
  while (targets.size < TARGET_COUNT) targets.add(crypto.randomInt(GRID));

  // Chaque leurre est tiré sans remise : deux tuiles identiques donneraient
  // l'impression qu'on peut cliquer n'importe laquelle des deux.
  const pool = [...DECOYS];
  const tiles = Array.from({ length: GRID }, (_, i) =>
    targets.has(i) ? TARGET : pool.splice(crypto.randomInt(pool.length), 1)[0]
  );

  const nonce = crypto.randomBytes(9).toString('base64url');
  const expiresAt = Date.now() + CHALLENGE_TTL;
  const answer = [...targets].sort((a, b) => a - b).join(',');

  return {
    prompt: `Touche les ${TARGET_COUNT} feuilles`,
    tiles,
    nonce,
    expiresAt,
    token: sign(`${userId}:${nonce}:${expiresAt}:${answer}`),
  };
}

/**
 * Vérifie une réponse. La signature est recalculée à partir de la sélection
 * reçue : c'est elle qui prouve la réponse, rien n'est comparé en clair.
 */
export function solveChallenge(userId, { nonce, expiresAt, token, selection } = {}) {
  if (!nonce || !token || !Array.isArray(selection)) {
    return { ok: false, reason: 'Réponse incomplète.' };
  }
  if (!Number.isFinite(Number(expiresAt)) || Number(expiresAt) < Date.now()) {
    return { ok: false, reason: 'Épreuve expirée, on recommence.' };
  }

  const answer = [...new Set(selection.map(Number))]
    .filter((n) => Number.isInteger(n) && n >= 0 && n < GRID)
    .sort((a, b) => a - b)
    .join(',');

  if (!equal(sign(`${userId}:${nonce}:${expiresAt}:${answer}`), token)) {
    return { ok: false, reason: 'Raté. Essaie encore.' };
  }
  return { ok: true, pass: issuePass(userId) };
}

/* ── Laissez-passer ──────────────────────────────────────── */

/** Jeton signé qui évite de réinterroger le client à chaque ouverture. */
export function issuePass(userId) {
  const expiresAt = Date.now() + PASS_TTL;
  return `${expiresAt}.${sign(`pass:${userId}:${expiresAt}`)}`;
}

export function passIsValid(pass, userId) {
  if (typeof pass !== 'string' || !pass.includes('.')) return false;
  const [expiresAt, signature] = pass.split('.');
  if (!Number.isFinite(Number(expiresAt)) || Number(expiresAt) < Date.now()) return false;
  return equal(sign(`pass:${userId}:${expiresAt}`), signature ?? '');
}
