/**
 * Combien de fois, en combien de temps.
 *
 * Un compteur en mémoire, volontairement simple. Ce qu'il protège n'est pas
 * une base de données : c'est le téléphone du vendeur, et le peu de calcul
 * qu'un inconnu peut exiger du serveur sans avoir rien acheté.
 *
 * Ce qu'il n'est pas : un rempart contre une attaque distribuée. Il vit dans
 * un processus, et sur un hébergement sans état chaque instance a le sien. Il
 * rend l'abus fastidieux, pas impossible — et c'est déjà tout ce qu'il faut
 * contre quelqu'un qui s'ennuie avec un compte Telegram.
 *
 * La mémoire est bornée : sans cela, le compteur deviendrait lui-même le moyen
 * de faire tomber la boutique, un identifiant inventé suffisant à y ajouter
 * une entrée.
 */

/** Au-delà, on oublie les plus anciens : un compteur n'est pas un registre. */
const SUIVIS_MAX = 5000;

/**
 * @param {{max: number, fenetreMs: number, nom?: string}} regle
 */
export function creerCadence({ max, fenetreMs, nom = 'cadence' }) {
  /** @type {Map<string, number[]>} identifiant → horodatages récents */
  const vus = new Map();

  /** Jette ce qui est sorti de la fenêtre, et rend ce qui reste. */
  function recents(clef, maintenant) {
    const fenetre = (vus.get(clef) ?? []).filter((t) => maintenant - t < fenetreMs);
    if (fenetre.length) vus.set(clef, fenetre);
    else vus.delete(clef);
    return fenetre;
  }

  /**
   * Compte un passage. Rend `{ ok: true }`, ou de quoi le dire à l'intéressé.
   *
   * Le passage refusé n'est pas compté : sinon quelqu'un qui insiste
   * repousserait indéfiniment sa propre sortie de pénitence, et une erreur de
   * double-clic deviendrait un quart d'heure d'attente.
   */
  function passer(clef, maintenant = Date.now()) {
    const id = String(clef ?? '');
    if (!id) return { ok: true, restant: max };

    const fenetre = recents(id, maintenant);
    if (fenetre.length >= max) {
      const attente = Math.ceil((fenetreMs - (maintenant - fenetre[0])) / 1000);
      return { ok: false, attente: Math.max(1, attente), nom };
    }

    // L'éviction se fait à l'écriture, et sur le plus anciennement vu : une
    // purge complète à date fixe libérerait tout le monde d'un coup, y compris
    // celui qui est justement en train d'abuser.
    if (!vus.has(id) && vus.size >= SUIVIS_MAX) {
      let plusVieux = null;
      let quand = Infinity;
      for (const [autre, temps] of vus) {
        const dernier = temps[temps.length - 1] ?? 0;
        if (dernier < quand) { quand = dernier; plusVieux = autre; }
      }
      if (plusVieux !== null) vus.delete(plusVieux);
    }

    vus.set(id, [...fenetre, maintenant]);
    return { ok: true, restant: max - fenetre.length - 1 };
  }

  /** Efface le compteur de quelqu'un — après un geste légitime, par exemple. */
  function absoudre(clef) {
    vus.delete(String(clef ?? ''));
  }

  /** Pour les tests et le diagnostic : combien de personnes sont suivies. */
  const suivis = () => vus.size;

  return { passer, absoudre, suivis };
}

/** « dans 3 minutes », plutôt qu'un nombre de secondes à diviser de tête. */
export function attenteEnClair(secondes) {
  if (secondes < 60) return `${secondes} seconde${secondes > 1 ? 's' : ''}`;
  const minutes = Math.ceil(secondes / 60);
  return `${minutes} minute${minutes > 1 ? 's' : ''}`;
}
