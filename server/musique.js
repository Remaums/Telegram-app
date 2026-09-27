/**
 * La playlist d'ambiance de la boutique.
 *
 * Fonctions pures, sans accès au magasin ni au réseau : la liste est passée en
 * argument, ce qui les rend vérifiables sans serveur et sans Telegram.
 *
 * Un morceau est `{ id, titre, fileId }`. Le fichier lui-même n'est pas ici :
 * comme les photos et les vidéos de la boutique, il vit chez Telegram et on
 * n'en garde que la référence. Le disque du serveur ne porte qu'un cache, que
 * `media-cache.js` sait reconstruire.
 */

import { randomUUID } from 'node:crypto';

/** Au-delà, ce n'est plus une ambiance de boutique mais une médiathèque. */
export const MUSIQUE_MAX = 30;

/** Un titre plus long ne tient sur aucun écran de téléphone. */
const TITRE_MAX = 80;

/**
 * Le titre qu'on affiche quand le vendeur n'en donne pas.
 *
 * Un nom de fichier reste lisible une fois débarrassé de son extension, de ses
 * tirets et de son numéro de piste : « 03_nuit-en-ville.mp3 » vaut mieux rendu
 * « Nuit en ville » que recopié tel quel sous la pastille.
 */
export function titreDepuisLeNom(nom) {
  const base = String(nom ?? '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')     // l'extension
    .replace(/^\s*\d{1,3}\s*[-_.)]\s*/, '') // un numéro de piste en tête
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return 'Sans titre';
  return (base[0].toUpperCase() + base.slice(1)).slice(0, TITRE_MAX);
}

/** Un identifiant court, qui sert d'adresse dans l'URL de lecture. */
export function nouvelIdentifiant() {
  return randomUUID().slice(0, 8);
}

/**
 * Nettoie une playlist reçue de l'admin ou relue d'un fichier ancien.
 *
 * Tout morceau sans `fileId` est jeté : c'est la seule chose qu'on ne peut
 * pas reconstruire, et une entrée sans elle serait une ligne qui ne joue rien
 * dans un écran de réglages — le genre de fantôme qu'on croit avoir supprimé.
 *
 * Les identifiants en double sont renumérotés plutôt que supprimés : deux
 * morceaux qui partagent une adresse, c'est le second qui devient injouable,
 * et personne ne devinerait pourquoi.
 */
export function normalizeMusique(input) {
  const brut = Array.isArray(input?.titres) ? input.titres : Array.isArray(input) ? input : [];
  const vus = new Set();
  const titres = [];

  for (const entree of brut) {
    if (!entree || typeof entree !== 'object') continue;
    const fileId = typeof entree.fileId === 'string' ? entree.fileId.trim() : '';
    if (!fileId) continue;

    let id = typeof entree.id === 'string' ? entree.id.trim().slice(0, 36) : '';
    if (!id || vus.has(id)) id = nouvelIdentifiant();
    vus.add(id);

    const titre = String(entree.titre ?? '').trim().slice(0, TITRE_MAX) || 'Sans titre';
    titres.push({ id, titre, fileId });
    if (titres.length >= MUSIQUE_MAX) break;
  }

  return { titres };
}

/**
 * Ce que la boutique envoie au client : les titres et leur ordre, jamais les
 * `fileId`.
 *
 * Un `file_id` Telegram est une adresse utilisable par quiconque possède le
 * token du bot, et il voyagerait ici dans une réponse publique, lisible sans
 * la moindre signature. Le client reçoit un identifiant interne ; c'est le
 * serveur qui fait la traduction, morceau par morceau.
 */
export function playlistPublique(musique, allumee) {
  if (!allumee) return { titres: [] };
  const { titres } = normalizeMusique(musique);
  return {
    titres: titres.map(({ id, titre }) => ({ id, titre, url: `/api/musique/${id}` })),
  };
}

/** Le morceau derrière un identifiant, ou `null`. */
export function morceauParId(musique, id) {
  const { titres } = normalizeMusique(musique);
  return titres.find((m) => m.id === String(id ?? '')) ?? null;
}
