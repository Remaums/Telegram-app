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
