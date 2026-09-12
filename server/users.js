import { createStore } from './store.js';

/**
 * Le registre des utilisateurs du bot.
 *
 * « Client » et « utilisateur », ce n'est pas la même chose : un client a
 * commandé (voir clients.js), un utilisateur a simplement ouvert le bot. La
 * plupart des gens font /start, regardent, et ne commandent pas — sans ce
 * registre, ils n'existent nulle part, et on ne sait pas combien de curieux
 * la boutique laisse repartir les mains vides.
 *
 * On note donc chaque personne qui touche le bot, à sa première interaction,
 * et on tient à jour trois choses : quand on l'a vue pour la première fois,
 * quand pour la dernière, et combien de fois elle a écrit. Rien du contenu de
 * ses messages : le nombre de contacts se compte, ce qu'elle raconte ne se
 * garde pas — ce serait excessif, et un fichier qu'on n'a pas ne fuit pas.
 *
 * Le magasin est borné : une boutique très fréquentée ne doit pas voir son
 * fichier grossir sans fin. Au-delà du plafond, les plus anciennement vus
 * cèdent la place — ils n'ont de toute façon pas commandé, sinon ils seraient
 * dans clients.js, qui ne s'efface pas, lui.
 */

const MAX = 20000;
const store = createStore('users.json', {});

/**
 * Note le passage d'une personne. Idempotent : appelé à chaque interaction,
 * il crée la fiche la première fois et se contente de la rafraîchir ensuite.
 *
 * @param {{id:number, first_name?:string, last_name?:string, username?:string, is_bot?:boolean}} from
 */
export async function noterUtilisateur(from) {
  if (!from?.id || from.is_bot) return; // un autre bot n'est pas un utilisateur
  const id = String(from.id);
  const maintenant = new Date().toISOString();

  return store.update((data) => {
    const connu = data[id];
    data[id] = {
      id,
      prenom: from.first_name ?? connu?.prenom ?? null,
      nom: from.last_name ?? connu?.nom ?? null,
      username: from.username ?? connu?.username ?? null,
      // Le pseudo peut disparaître : on garde le dernier connu plutôt que de
      // le perdre, mais le plus récent l'emporte tant qu'il existe.
      premier: connu?.premier ?? maintenant,
      dernier: maintenant,
      contacts: (connu?.contacts ?? 0) + 1,
    };

    // Ménage seulement quand le plafond est franchi, et par lots : trier
    // vingt mille fiches à chaque /start coûterait plus cher que le service.
    const cles = Object.keys(data);
    if (cles.length > MAX) {
      cles
        .sort((a, b) => String(data[a].dernier).localeCompare(String(data[b].dernier)))
        .slice(0, cles.length - MAX)
        .forEach((vieille) => delete data[vieille]);
    }
    return data[id];
  });
}

/** Toutes les fiches, la plus récemment vue en tête. */
export async function listUsers() {
  const data = await store.read();
  return Object.values(data).sort((a, b) => String(b.dernier).localeCompare(String(a.dernier)));
}

/** Combien de personnes le bot a-t-il vues, en tout. */
export async function countUsers() {
  return Object.keys(await store.read()).length;
}

/**
 * Cherche dans le registre : prénom, nom, pseudo, identifiant.
 *
 * Sans accents ni casse, chaque mot devant se retrouver quelque part — comme
 * partout ailleurs dans la boutique, pour que le vendeur n'ait pas à deviner
 * quelle recherche marche où.
 */
export function chercherUtilisateurs(fiches, requete) {
  const propre = normaliser(requete);
  if (!propre) return fiches;
  return fiches.filter((u) => {
    const foin = normaliser([u.id, u.prenom, u.nom, u.username].join(' '));
    return propre.split(/\s+/).every((mot) => foin.includes(mot));
  });
}

function normaliser(valeur) {
  return String(valeur ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
