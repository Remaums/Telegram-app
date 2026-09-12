/**
 * Écrire à un client qui n'a pas de @.
 *
 * Un identifiant Telegram numérique ne se contacte pas : depuis un compte
 * personnel, on ne peut écrire qu'à un pseudo, et beaucoup de clients n'en ont
 * pas. Le bot, lui, le peut — il a déjà une conversation ouverte avec chacun
 * d'eux, c'est même d'elle que vient l'identifiant. Le canal existait donc
 * depuis le début, il n'était simplement pas branché.
 *
 * Ce module ne contient que la forme des messages et le routage : pas d'appel
 * réseau, pas de magasin. Il se vérifie donc sans bot et sans Telegram.
 */

/** Comment nommer quelqu'un avec ce qu'on a de lui. */
export function nommer(from) {
  const prenom = String(from?.first_name ?? from?.prenom ?? '').trim();
  const nom = String(from?.last_name ?? from?.nom ?? '').trim();
  const pseudo = String(from?.username ?? '').replace(/^@/, '').trim();
  const entier = [prenom, nom].filter(Boolean).join(' ');

  if (entier && pseudo) return `${entier} · @${pseudo}`;
  if (entier) return entier;
  if (pseudo) return `@${pseudo}`;
  return `client ${from?.id ?? '?'}`;
}

/**
 * Le message du client, tel qu'il arrive au vendeur.
 *
 * La deuxième ligne porte l'identifiant : c'est elle qui permettra de router la
 * réponse. Elle vient *avant* le texte du client, et c'est volontaire — le
 * routage ne lit que la première occurrence, donc personne ne peut détourner la
 * réponse du vendeur en écrivant « id 123 » dans son propre message.
 */
export function messageRelaye(from, texte) {
  return (
    `💬 ${nommer(from)}\n` +
    `id ${from?.id ?? '?'}\n\n` +
    `${String(texte ?? '').trim()}\n\n` +
    '↩︎ Réponds à ce message pour lui répondre.'
  );
}

/**
 * L'identifiant porté par un message relayé, ou `null`.
 *
 * Ne lit que la première occurrence : voir `messageRelaye`.
 */
export function idDuRelais(texte) {
  const trouve = String(texte ?? '').match(/^id (\d+)$/m);
  return trouve ? trouve[1] : null;
}

/** Le message du vendeur, tel qu'il arrive au client. */
export function messagePourLeClient(texte, nomBoutique) {
  const enseigne = String(nomBoutique ?? '').trim();
  return `💬 ${enseigne || 'La boutique'}\n\n${String(texte ?? '').trim()}`;
}

/**
 * Ce que Telegram refuse, dit en français.
 *
 * « Forbidden: bot was blocked by the user » dans une interface d'admin
 * n'apprend rien à personne. Chaque cas a une conduite à tenir différente, et
 * c'est elle qu'il faut lire.
 */
export function refusDeTelegram(erreur) {
  const raison = String(erreur?.description ?? erreur?.message ?? '');

  if (/bot was blocked by the user/i.test(raison)) {
    return "Ce client a bloqué le bot : aucun message ne lui arrivera tant qu'il ne le débloque pas.";
  }
  if (/user is deactivated/i.test(raison)) {
    return 'Ce compte Telegram a été supprimé.';
  }
  if (/chat not found/i.test(raison)) {
    return "Telegram ne connaît pas ce compte : il n'a jamais ouvert de conversation avec le bot.";
  }
  if (/can't initiate conversation|bot can't initiate/i.test(raison)) {
    return "Le bot ne peut pas écrire le premier : ce client doit d'abord lui envoyer /start.";
  }
  return `Telegram a refusé : ${raison || 'raison inconnue'}`;
}

/** Ce qu'un vendeur peut envoyer d'un coup, sans que Telegram tronque. */
export const LONGUEUR_MAX = 3500;

/** Refuse le vide et borne la longueur. Renvoie le texte prêt à partir. */
export function texteValide(valeur) {
  const propre = String(valeur ?? '').trim();
  if (!propre) return { erreur: 'Écris quelque chose avant d\'envoyer.' };
  if (propre.length > LONGUEUR_MAX) {
    return { erreur: `Message trop long : ${propre.length} caractères pour ${LONGUEUR_MAX} au maximum.` };
  }
  return { texte: propre };
}
