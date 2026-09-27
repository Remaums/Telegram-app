/**
 * La description d'un produit, découpée en blocs.
 *
 * Module séparé, et sans une ligne de DOM : c'est ici que vivent les
 * décisions — quelle ligne est un point de liste, où une liste commence et
 * s'arrête — donc ici que vivent les bugs. Séparé, ce découpage se vérifie
 * dans la suite de tests ordinaire, sans navigateur ; mêlé à la construction
 * des éléments, il aurait exigé Playwright dans `npm test`, et la suite ne
 * tournerait plus sur un serveur sans navigateur installé.
 *
 * Le dessin, lui, reste dans `app.js` : c'est lui qui pose les éléments, un
 * par un, en `textContent`.
 */

/**
 * Les marqueurs qu'un vendeur tape spontanément en début de ligne.
 *
 * Le tiret cadratin et le point médian en font partie : le clavier d'un
 * téléphone propose l'un ou l'autre selon la langue, et on ne va pas
 * demander au vendeur de connaître le bon.
 */
const MARQUEUR = /^[-–—•*·]\s*/;

/**
 * Découpe une description en blocs affichables.
 *
 * Rend un tableau de `{ type: 'ligne', texte }` et `{ type: 'points', items }`.
 * Les points qui se suivent sont groupés en une seule liste ; une ligne sans
 * marqueur referme la liste en cours, parce que l'agglutiner donnerait un
 * point sans puce au milieu des autres.
 *
 * Une description d'un seul tenant rend un seul bloc `ligne` : le vendeur qui
 * écrit un paragraphe garde son paragraphe.
 */
export function decouperLaDescription(texte) {
  const lignes = String(texte ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const blocs = [];
  for (const ligne of lignes) {
    if (MARQUEUR.test(ligne)) {
      const dernier = blocs[blocs.length - 1];
      const item = ligne.replace(MARQUEUR, '');
      // Un marqueur seul sur sa ligne ne dit rien : on ne fabrique pas une
      // puce vide pour un tiret oublié en fin de saisie.
      if (!item) continue;
      if (dernier?.type === 'points') dernier.items.push(item);
      else blocs.push({ type: 'points', items: [item] });
    } else {
      blocs.push({ type: 'ligne', texte: ligne });
    }
  }
  return blocs;
}
