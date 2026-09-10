import crypto from 'node:crypto';

/** Signe un `initData` comme le ferait Telegram au lancement de la Mini App. */
export function signInitData(token, user, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    user: JSON.stringify(user),
  });
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

/**
 * Franchit l'épreuve d'entrée et renvoie le laissez-passer.
 *
 * Les suites qui testent la commande doivent passer par la même porte que les
 * clients : contourner l'épreuve dans les tests reviendrait à ne jamais
 * vérifier qu'elle laisse effectivement entrer.
 */
export async function getShopPass(base, initData) {
  const res = await fetch(`${base}/api/captcha`, { headers: { 'X-Telegram-Init-Data': initData } });
  if (!res.ok) return '';

  const challenge = await res.json();
  if (!challenge.required) return '';

  // Les leurres sont tirés sans remise : la seule tuile répétée est la cible.
  const counts = new Map();
  for (const tile of challenge.tiles) counts.set(tile, (counts.get(tile) ?? 0) + 1);
  const target = [...counts.entries()].find(([, n]) => n > 1)?.[0];
  const selection = challenge.tiles
    .map((tile, index) => (tile === target ? index : -1))
    .filter((index) => index >= 0);

  const solved = await fetch(`${base}/api/captcha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData },
    body: JSON.stringify({
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
      token: challenge.token,
      selection,
    }),
  });
  if (!solved.ok) throw new Error(`Épreuve d'entrée non résolue : HTTP ${solved.status}`);
  return (await solved.json()).pass;
}

/**
 * Remet la boutique dans un état connu avant une suite.
 *
 * Les suites tournent à la file sur le même serveur : sans ça, celle qui
 * coupe les remises fait échouer celle qui les teste, et l'ordre du
 * `package.json` devient un piège invisible. Chacune pose donc son décor
 * complet, et ne dépend plus de ce que la précédente a laissé.
 *
 * @param {string} base      URL du serveur
 * @param {string} initData  un `initData` d'administrateur
 * @param {object} patch     ce que la suite veut en plus ou en moins
 */
export async function resetShop(base, initData, patch = {}) {
  const body = {
    features: {
      ageGate: true, captcha: true, verification: false, hours: false,
      zones: true, slots: false, tiers: true, promos: true, waitlist: true,
      stockAlerts: true, limits: true, photos: true, orderHistory: true,
      clientNotifications: true,
      ...(patch.features ?? {}),
    },
    fulfillment: {
      pickup: true, delivery: false, deliveryFee: 0, freeDeliveryFrom: null, minimumOrder: 0,
      ...(patch.fulfillment ?? {}),
    },
    // Plafonds larges par défaut : une suite qui enchaîne les commandes pour
    // tester autre chose ne doit pas buter sur le quota horaire. Celles qui
    // vérifient les garde-fous posent leurs propres valeurs.
    limits: { ordersPerHour: 999, unitsPerOrder: 999, ...(patch.limits ?? {}) },
    alerts: { lowStock: 3, ...(patch.alerts ?? {}) },
    discounts: { tiers: patch.discounts?.tiers ?? [] },
    zones: patch.zones ?? [],
    slots: { leadMinutes: 60, daysAhead: 7, days: {}, ...(patch.slots ?? {}) },
    opening: {
      open: true,
      message: 'La boutique est fermée pour le moment. Reviens un peu plus tard !',
      ...(patch.opening ?? {}),
    },
  };

  const res = await fetch(`${base}/api/admin/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Réglages de départ refusés : HTTP ${res.status}`);
  return res.json();
}
