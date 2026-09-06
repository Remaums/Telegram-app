import crypto from 'node:crypto';

/**
 * Vérifie la signature du `initData` transmis par la Mini App.
 *
 * Telegram signe les données du lancement avec une clé dérivée du token du bot.
 * Sans cette vérification, n'importe qui pourrait poster une commande en se
 * faisant passer pour un autre utilisateur : on ne fait jamais confiance au
 * `user` envoyé par le client tel quel.
 *
 * @see https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * @returns {{ok: true, user: object, authDate: Date} | {ok: false, reason: string}}
 */
export function verifyInitData(initData, botToken, { maxAgeSeconds = 86400 } = {}) {
  if (!initData || typeof initData !== 'string') {
    return { ok: false, reason: 'initData manquant' };
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'hash manquant' };

  params.delete('hash');
  // Le "data check string" : paires clé=valeur triées par clé, séparées par \n.
  const dataCheckString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const expected = Buffer.from(computed, 'hex');
  const received = Buffer.from(hash, 'hex');
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    return { ok: false, reason: 'signature invalide' };
  }

  // Une signature valide reste valide pour toujours : on borne sa durée de vie
  // pour qu'un initData intercepté ne soit pas rejouable des mois plus tard.
  const authDateRaw = Number(params.get('auth_date'));
  if (!Number.isFinite(authDateRaw)) return { ok: false, reason: 'auth_date invalide' };
  const ageSeconds = Math.floor(Date.now() / 1000) - authDateRaw;
  if (ageSeconds > maxAgeSeconds) return { ok: false, reason: 'session expirée' };

  let user;
  try {
    user = JSON.parse(params.get('user') ?? 'null');
  } catch {
    return { ok: false, reason: 'champ user illisible' };
  }
  if (!user?.id) return { ok: false, reason: 'utilisateur absent' };

  return { ok: true, user, authDate: new Date(authDateRaw * 1000) };
}
