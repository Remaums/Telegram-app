/**
 * Les liens qui ouvrent la boutique au bon endroit.
 *
 * Un flyer colle un QR code, le client le scanne, et il tombe sur l'article
 * annoncé — pas sur un catalogue où il devra le retrouver. Telegram appelle
 * ça un lien direct : `t.me/<bot>?startapp=<paramètre>`, le paramètre étant
 * remis tel quel à la Mini App au démarrage.
 *
 * Le format du paramètre est contraint par Telegram : lettres, chiffres,
 * tiret et souligné, rien d'autre. D'où le préfixe court `p_` plutôt qu'un
 * chemin, et la vérification systématique avant de fabriquer un lien qui
 * s'ouvrirait sur une erreur.
 */

/** Ce que Telegram accepte dans un `startapp`. */
const AUTORISE = /^[A-Za-z0-9_-]{1,512}$/;

const PRODUIT = 'p_';

/** Le paramètre de démarrage qui désigne un produit, ou null s'il est inutilisable. */
export function productStartParam(id) {
  const brut = String(id ?? '').trim();
  // Sans identifiant, `p_` seul passerait la vérification et fabriquerait un
  // lien qui ne désigne rien — que la lecture rejetterait à l'autre bout.
  if (!brut) return null;
  const param = `${PRODUIT}${brut}`;
  return AUTORISE.test(param) ? param : null;
}

/**
 * Lit un paramètre de démarrage.
 *
 * Rend `{ kind: 'product', id }` ou null. Un paramètre inconnu n'est pas une
 * erreur : la boutique s'ouvre normalement, comme si de rien n'était. Un lien
 * peut survivre au format qui l'a produit, et un client n'a pas à en pâtir.
 */
export function parseStartParam(param) {
  const brut = String(param ?? '').trim();
  if (!brut || !AUTORISE.test(brut)) return null;
  if (brut.startsWith(PRODUIT)) {
    const id = brut.slice(PRODUIT.length);
    return id ? { kind: 'product', id } : null;
  }
  return null;
}

/** Le lien qui ouvre la boutique, sans destination particulière. */
export function shopLink(botUsername) {
  const nom = String(botUsername ?? '').replace(/^@/, '').trim();
  if (!/^[A-Za-z0-9_]{3,64}$/.test(nom)) return null;
  return `https://t.me/${nom}?startapp`;
}

/** Le lien qui ouvre la boutique sur la fiche d'un produit. */
export function productLink(botUsername, id) {
  const base = shopLink(botUsername);
  const param = productStartParam(id);
  if (!base || !param) return null;
  return `${base}=${param}`;
}
