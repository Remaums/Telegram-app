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

/**
 * Deux durées, et c'est la distinction qui fait tout l'écran.
 *
 * `FENETRE_MS` : au-delà, on n'est plus **là**. Trois minutes, parce que c'est
 * l'ordre de grandeur d'une page qu'on garde ouverte sans y toucher.
 *
 * `MEMOIRE_MS` : combien de temps on se souvient d'un passage. Une demi-heure,
 * et c'est ce qui permet de lire la boutique plutôt qu'un instantané — savoir
 * que onze personnes sont passées depuis une demi-heure vaut mieux que savoir
 * que deux y sont à la seconde où l'on regarde. Un vendeur qui ouvre son écran
 * entre deux clients ne voyait, sinon, qu'une boutique vide.
 */
export const FENETRE_MS = 3 * 60 * 1000;
export const MEMOIRE_MS = 30 * 60 * 1000;

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

  // Combien de fois cette personne s'est manifestée dans la demi-heure.
  // Quelqu'un qui revient trois fois n'est pas quelqu'un qui passe une fois, et
  // c'est souvent celui-là qui hésite devant un produit.
  const avant = presents.get(id);
  const frais = avant && maintenant - avant.vu < MEMOIRE_MS;
  presents.set(id, { vu: maintenant, ou, passages: frais ? (avant.passages ?? 1) + 1 : 1 });
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
  return visites({ depuisMs: FENETRE_MS, maintenant });
}

/**
 * Les passages récents, du plus frais au plus ancien.
 *
 * C'est la même mémoire qu'`actifs`, lue sur une fenêtre plus large : « là
 * maintenant » et « passé dans la demi-heure » sont deux questions, pas deux
 * magasins. Chaque ligne porte `actif`, pour que l'écran distingue d'un coup
 * d'œil celui qui est encore là de celui qui vient de partir.
 *
 * Le ménage se fait ici, sur `MEMOIRE_MS` : oublier à trois minutes effacerait
 * précisément ce que cette fonction existe pour montrer.
 */
export function visites({ depuisMs = MEMOIRE_MS, maintenant = Date.now() } = {}) {
  const fenetre = Math.min(depuisMs, MEMOIRE_MS);
  const vus = [];

  for (const [id, etat] of presents) {
    const age = maintenant - etat.vu;
    if (age >= MEMOIRE_MS) {
      presents.delete(id);
      continue;
    }
    if (age >= fenetre) continue;
    vus.push({
      id,
      ou: etat.ou,
      depuis: Math.round(age / 1000),
      actif: age < FENETRE_MS,
      passages: etat.passages ?? 1,
    });
  }

  return vus.sort((a, b) => a.depuis - b.depuis);
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
  return visitesDesClients(adminIds, { depuisMs: FENETRE_MS, maintenant });
}

/** Les passages récents, administrateurs retirés. Même raison. */
export function visitesDesClients(adminIds = [], { depuisMs = MEMOIRE_MS, maintenant = Date.now() } = {}) {
  const patrons = new Set(adminIds.map(String));
  return visites({ depuisMs, maintenant }).filter((p) => !patrons.has(p.id));
}

/**
 * Combien de personnes occupent la mémoire, oubliés compris.
 *
 * Ce n'est pas le nombre de visiteurs — c'est ce que le serveur porte. Deux
 * usages : le diagnostic, et la vérification que le ménage se fait vraiment.
 * Sans elle, supprimer l'éviction ne se voyait nulle part : la lecture filtre
 * déjà ce qui est périmé, si bien que la mémoire pouvait enfler en silence
 * pendant que l'écran affichait les bons chiffres.
 */
export const taille = () => presents.size;

/** Pour les tests : on repart d'une boutique vide. */
export function oublierTout() {
  presents.clear();
}
