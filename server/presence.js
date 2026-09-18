/**
 * Qui est là, en ce moment.
 *
 * ⚠️ Ce n'est pas le « en ligne » de Telegram, et il faut le dire clairement :
 * **Telegram ne donne pas cette information aux bots.** Le statut en ligne, la
 * dernière connexion, le « est en train d'écrire » d'un contact — rien de tout
 * cela n'est accessible à un bot, quelle que soit la méthode. Seuls les vrais
 * clients Telegram y ont droit, et encore, selon la confidentialité choisie.
 *
 * Ce qu'on peut savoir, en revanche, c'est ce qui se passe chez nous : un
 * message reçu par le bot, une boutique ouverte, un panier rempli. C'est même
 * l'information la plus utile des deux — un vendeur ne veut pas savoir qui a
 * Telegram ouvert, il veut savoir qui regarde son catalogue à l'instant.
 *
 * D'où : « actif », et non « en ligne ». La nuance est écrite partout où le
 * chiffre s'affiche, parce qu'un vendeur qui croit voir un statut Telegram
 * finira par se demander pourquoi son client « hors ligne » vient de commander.
 *
 * En mémoire, et c'est délibéré : une présence est éphémère par nature. Un
 * redémarrage remet tout le monde à zéro, ce qui est exactement juste —
 * personne n'est « en train de regarder » une boutique qui vient de repartir.
 * Et rien n'est écrit sur le disque à chaque requête.
 */

/** Au-delà de ce délai sans signe de vie, on n'est plus là. */
export const FENETRE_MS = 3 * 60 * 1000;

/**
 * Le nombre de personnes suivies.
 *
 * Borné, comme tout ce qui grandit avec le trafic : sans cela, la présence
 * deviendrait elle-même le moyen de faire enfler la mémoire du serveur.
 */
const SUIVIS_MAX = 2000;

/** @type {Map<string, {vu: number, ou: string}>} */
const presents = new Map();

/**
 * Note un signe de vie.
 *
 * `ou` dit d'où vient le signe : la conversation du bot, ou la boutique. Les
 * deux ne se valent pas pour un vendeur — quelqu'un dans la boutique a le
 * catalogue sous les yeux, quelqu'un dans la conversation attend une réponse.
 */
export function noterPassage(userId, ou = 'boutique', maintenant = Date.now()) {
  const id = String(userId ?? '');
  if (!id) return;

  // L'éviction se fait à l'écriture, sur le plus anciennement vu : une purge
  // à date fixe libérerait tout le monde d'un coup.
  if (!presents.has(id) && presents.size >= SUIVIS_MAX) {
    let plusVieux = null;
    let quand = Infinity;
    for (const [autre, etat] of presents) {
      if (etat.vu < quand) { quand = etat.vu; plusVieux = autre; }
    }
    if (plusVieux !== null) presents.delete(plusVieux);
  }

  presents.set(id, { vu: maintenant, ou });
}

/** Vrai si cette personne a donné signe de vie dans la fenêtre. */
export function estActif(userId, maintenant = Date.now()) {
  const etat = presents.get(String(userId ?? ''));
  return Boolean(etat) && maintenant - etat.vu < FENETRE_MS;
}

/**
 * Tout le monde, du plus récemment vu au plus ancien.
 *
 * Le ménage se fait ici plutôt que sur une minuterie : la liste n'est lue que
 * par l'écran d'administration, et une minuterie qui tourne pour personne est
 * du travail que le serveur fait pour rien.
 */
export function actifs(maintenant = Date.now()) {
  const vivants = [];
  for (const [id, etat] of presents) {
    if (maintenant - etat.vu >= FENETRE_MS) {
      presents.delete(id);
      continue;
    }
    vivants.push({ id, ou: etat.ou, depuis: Math.round((maintenant - etat.vu) / 1000) });
  }
  return vivants.sort((a, b) => a.depuis - b.depuis);
}

/** Combien de personnes sont là, sans construire la liste. */
export const combienActifs = (maintenant = Date.now()) => actifs(maintenant).length;

/**
 * Les présents, sans les administrateurs.
 *
 * Le vendeur qui tape /enligne se comptait lui-même, et « 1 personne active »
 * alors qu'on est seul dans sa boutique n'est pas une information, c'est une
 * fausse joie. Ce qu'on cherche ici, ce sont les clients.
 */
export function clientsActifs(adminIds = [], maintenant = Date.now()) {
  const patrons = new Set(adminIds.map(String));
  return actifs(maintenant).filter((p) => !patrons.has(p.id));
}

/** Pour les tests : on repart d'une boutique vide. */
export function oublierTout() {
  presents.clear();
}
