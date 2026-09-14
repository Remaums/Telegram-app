/**
 * Qui a le droit d'ouvrir l'espace admin.
 *
 * Deux sources, et l'ordre compte :
 *
 * 1. **`ADMIN_IDS` / `ADMIN_CHAT_ID` dans le `.env`.** C'est la racine de
 *    confiance. Elle vit en dehors de la boutique, sur le serveur, et ne se
 *    modifie qu'avec un accès au fichier. Le bot ne peut donc pas l'entamer :
 *    quoi qu'il arrive dans une conversation, le propriétaire garde sa clé.
 * 2. **Ceux que le propriétaire a ajoutés depuis le bot.** Ceux-là s'ajoutent
 *    et se retirent d'une commande, sans toucher au serveur ni redémarrer.
 *
 * C'est exactement pour ça que `retirerAdmin` refuse un administrateur du
 * `.env` : si le bot pouvait les retirer, il suffirait d'une session ouverte
 * sur un téléphone perdu pour mettre le propriétaire dehors de sa propre
 * boutique, sans recours.
 */

import { createStore } from './store.js';
import { config } from './config.js';
import { HttpError } from './catalog.js';

const store = createStore('admins.json', []);

/** Au-delà, ce n'est plus une équipe, c'est une fuite. */
const MAX = 20;

/**
 * Le cache, et pourquoi il expire.
 *
 * `estAdmin` est appelé à chaque message reçu, parfois plusieurs fois pour un
 * seul — le relire à chaque fois ferait une requête Postgres par appui de
 * bouton. Mais un cache éternel serait pire : sur un hébergement sans état,
 * chaque instance garderait sa propre liste, et un administrateur ajouté
 * resterait dehors sans que personne ne comprenne pourquoi. Trente secondes :
 * assez pour ne pas marteler la base, assez peu pour qu'un ajout se voie le
 * temps d'aller le dire à l'intéressé.
 */
const MEMOIRE = 30_000;
let cache = null;
let cacheJusqua = 0;

/** Vide le cache : appelé après chaque écriture, pour ne pas attendre. */
function oublier() {
  cache = null;
  cacheJusqua = 0;
}

async function ajoutes() {
  if (cache && Date.now() < cacheJusqua) return cache;
  // Une copie, pas la référence du magasin. Le magasin fichier rend son tableau
  // vivant : le garder ferait voir les écritures sans jamais vider le cache, et
  // tout marcherait — jusqu'au jour où la boutique passe sur Postgres, qui rend
  // un objet neuf à chaque lecture. Le bogue n'apparaîtrait qu'en ligne, sur la
  // seule fonctionnalité qu'on ne veut pas voir se tromper.
  cache = [...(await store.read())];
  cacheJusqua = Date.now() + MEMOIRE;
  return cache;
}

/** Les identifiants déclarés dans le `.env`, qui ne se retirent pas d'ici. */
export const adminsDuFichier = () => config.adminIds.map(String);

/** Vrai si cet identifiant ouvre l'espace admin, d'une source ou de l'autre. */
export async function estAdmin(id) {
  const cible = String(id ?? '');
  if (!cible) return false;
  if (adminsDuFichier().includes(cible)) return true;
  return (await ajoutes()).some((a) => a.id === cible);
}

/**
 * Tout le monde, avec sa provenance.
 *
 * La provenance n'est pas un détail d'affichage : c'est elle qui dit ce qu'on
 * peut faire de cette ligne. Un `fichier` ne se retire que sur le serveur.
 */
export async function listerAdmins() {
  const liste = await ajoutes();
  const parId = new Map(liste.map((a) => [a.id, a]));

  return [
    ...adminsDuFichier().map((id) => ({
      id,
      source: 'fichier',
      // Un identifiant peut être dans les deux : le `.env` l'emporte, mais on
      // garde ce que le bot sait de lui plutôt que d'afficher un numéro nu.
      nom: parId.get(id)?.nom ?? null,
      username: parId.get(id)?.username ?? null,
    })),
    ...liste
      .filter((a) => !adminsDuFichier().includes(a.id))
      .map((a) => ({ ...a, source: 'bot' })),
  ];
}

/**
 * Ajoute un administrateur.
 *
 * Le contrôle d'unicité est dans la même opération que l'écriture : le faire
 * avant laisserait deux ajouts simultanés inscrire deux fois la même personne.
 */
export async function ajouterAdmin(id, { par = null, nom = null, username = null } = {}) {
  const cible = String(id ?? '').trim();
  if (!/^\d+$/.test(cible)) throw new HttpError(400, 'Un identifiant Telegram est un nombre.');

  if (adminsDuFichier().includes(cible)) {
    throw new HttpError(409, 'Cet identifiant est déjà administrateur par le fichier .env.');
  }

  const fiche = await store.update((liste) => {
    if (liste.some((a) => a.id === cible)) {
      throw new HttpError(409, 'Cette personne est déjà administratrice.');
    }
    if (liste.length >= MAX) {
      throw new HttpError(409, `Pas plus de ${MAX} administrateurs ajoutés depuis le bot.`);
    }
    const neuf = {
      id: cible,
      nom: nom ?? null,
      username: username ? String(username).replace(/^@/, '') : null,
      ajoutePar: par ? String(par) : null,
      ajouteLe: new Date().toISOString(),
    };
    liste.push(neuf);
    return neuf;
  });

  oublier();
  return fiche;
}

/** Retire un administrateur ajouté depuis le bot. Jamais un du `.env`. */
export async function retirerAdmin(id) {
  const cible = String(id ?? '').trim();

  if (adminsDuFichier().includes(cible)) {
    throw new HttpError(
      403,
      'Celui-là vient du fichier .env : il se retire sur le serveur, pas depuis le bot. ' +
        "C'est ce qui garantit qu'une conversation ne peut pas te mettre dehors de ta propre boutique."
    );
  }

  const parti = await store.update((liste) => {
    const rang = liste.findIndex((a) => a.id === cible);
    if (rang === -1) throw new HttpError(404, "Cette personne n'est pas administratrice.");
    return liste.splice(rang, 1)[0];
  });

  oublier();
  return parti;
}
