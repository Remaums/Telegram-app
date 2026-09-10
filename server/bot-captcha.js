import crypto from 'node:crypto';
import { createStore } from './store.js';

/**
 * La porte du bot : un petit calcul au premier contact.
 *
 * Ce que ça vaut, et ce que ça ne vaut pas. Un robot sait additionner : ce
 * calcul n'est pas une énigme, c'est un péage. Il coûte un aller-retour et une
 * attente à qui voudrait inonder la boutique de faux comptes, et rien du tout
 * à un client — un geste, une fois. La vraie barrière reste ailleurs : une
 * commande passe par la Mini App, dont chaque appel est signé par Telegram.
 *
 * Trois choix qui font la différence entre une porte et un tourniquet :
 *
 * - la réponse ne quitte jamais le serveur. Les boutons ne portent que la
 *   valeur proposée ; le calcul juste est rangé ici, avec l'épreuve ;
 * - un mauvais bouton fait tirer un nouveau calcul. Sinon il suffirait
 *   d'essayer les six boutons l'un après l'autre pour entrer ;
 * - trois erreurs valent dix minutes d'attente. C'est ce qui rend l'essai
 *   systématique plus cher que le renoncement.
 *
 * Et un client qui a déjà commandé entre sans rien prouver : lui demander de
 * calculer serait le prendre pour un inconnu.
 */

const DELAI = 15 * 60 * 1000; // le temps de lire et de répondre
const ESSAIS_MAX = 3;
const PAUSE = 10 * 60 * 1000; // après trois erreurs
const CHOIX = 6;
const ECART = 6; // les leurres restent proches : ils doivent être crédibles

const store = createStore('captcha-bot.json', {});

/** Ce qu'on sait de quelqu'un devant la porte. */
const etatDe = (data, userId) => data[String(userId)] ?? {};

export async function estPasse(userId) {
  const data = await store.read();
  return etatDe(data, userId).passe === true;
}

/** Ouvre la porte sans épreuve — pour un client déjà connu de la boutique. */
export async function ouvrirLaPorte(userId) {
  return store.update((data) => {
    data[String(userId)] = { passe: true, depuis: new Date().toISOString() };
    return true;
  });
}

/** Referme la porte : sert à rejouer une épreuve, et aux tests. */
export async function oublier(userId) {
  return store.update((data) => {
    delete data[String(userId)];
    return true;
  });
}

/**
 * L'épreuve à poser à quelqu'un qui n'est pas encore passé.
 *
 * Une épreuve encore valable est reposée telle quelle : en tirer une nouvelle
 * à chaque message laisserait autant de grilles ouvertes, et la même personne
 * verrait le calcul changer sous ses yeux entre deux messages.
 */
export async function demanderLEpreuve(userId) {
  return store.update((data) => {
    const cle = String(userId);
    const etat = etatDe(data, userId);
    if (etat.passe) return { passe: true };

    const maintenant = Date.now();
    if (etat.pauseJusqua > maintenant) return { pause: minutes(etat.pauseJusqua - maintenant) };

    if (etat.attente && etat.attente.expireA > maintenant) return { epreuve: montrable(etat.attente) };

    const attente = tirerUnCalcul(maintenant);
    data[cle] = { ...etat, attente };
    return { epreuve: montrable(attente) };
  });
}

/**
 * Vérifie une réponse.
 *
 * @returns {Promise<{ok: true} | {ok: false, raison: string, epreuve?: object,
 *   pause?: number, restants?: number}>}
 */
export async function repondre(userId, valeur) {
  return store.update((data) => {
    const cle = String(userId);
    const etat = etatDe(data, userId);
    if (etat.passe) return { ok: true };

    const maintenant = Date.now();
    if (etat.pauseJusqua > maintenant) {
      return { ok: false, raison: 'pause', pause: minutes(etat.pauseJusqua - maintenant) };
    }

    // Sans épreuve en cours — expirée, ou boutons d'un message d'hier — on ne
    // juge rien : on en repose une.
    if (!etat.attente || etat.attente.expireA <= maintenant) {
      const attente = tirerUnCalcul(maintenant);
      data[cle] = { ...etat, attente };
      return { ok: false, raison: 'expiree', epreuve: montrable(attente) };
    }

    if (Number(valeur) === etat.attente.reponse) {
      data[cle] = { passe: true, depuis: new Date(maintenant).toISOString() };
      return { ok: true };
    }

    const essais = (etat.essais ?? 0) + 1;
    if (essais >= ESSAIS_MAX) {
      // On efface l'épreuve avec le compteur : après la pause, tout est neuf.
      data[cle] = { pauseJusqua: maintenant + PAUSE };
      return { ok: false, raison: 'trop', pause: minutes(PAUSE) };
    }

    const attente = tirerUnCalcul(maintenant);
    data[cle] = { essais, attente };
    return { ok: false, raison: 'faux', restants: ESSAIS_MAX - essais, epreuve: montrable(attente) };
  });
}

/** Ce qu'on a le droit de montrer d'une épreuve : tout sauf la réponse. */
const montrable = (attente) => ({ texte: attente.texte, choix: attente.choix });

const minutes = (millisecondes) => Math.max(1, Math.ceil(millisecondes / 60000));

/**
 * Tire une addition ou une soustraction à un chiffre.
 *
 * Rien au-delà : l'épreuve doit être franchie par quelqu'un qui commande d'une
 * main dans la rue, pas seulement par qui aime les chiffres. La soustraction
 * ne descend jamais sous zéro — un résultat négatif ferait hésiter, et une
 * hésitation coûte un client.
 */
function tirerUnCalcul(maintenant) {
  const a = crypto.randomInt(2, 10);
  const b = crypto.randomInt(2, 10);
  const addition = crypto.randomInt(2) === 0;

  const [x, y] = addition ? [a, b] : [Math.max(a, b), Math.min(a, b)];
  const reponse = addition ? x + y : x - y;

  return {
    texte: `${x} ${addition ? '+' : '−'} ${y}`,
    reponse,
    choix: melanger(reponse),
    expireA: maintenant + DELAI,
  };
}

/**
 * Les six boutons : la bonne réponse et cinq voisines.
 *
 * Le mélange est un Fisher-Yates : trier au hasard donne un ordre biaisé, et
 * la bonne réponse finirait plus souvent à la même place — ce qui suffirait à
 * la trouver sans compter.
 */
function melanger(reponse) {
  const bassin = [];
  for (let v = Math.max(0, reponse - ECART); v <= reponse + ECART; v++) {
    if (v !== reponse) bassin.push(v);
  }

  const liste = [reponse];
  while (liste.length < CHOIX) liste.push(...bassin.splice(crypto.randomInt(bassin.length), 1));

  for (let i = liste.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [liste[i], liste[j]] = [liste[j], liste[i]];
  }
  return liste;
}
