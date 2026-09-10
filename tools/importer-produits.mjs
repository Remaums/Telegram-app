/**
 * Remet des produits du catalogue de départ dans une boutique déjà installée.
 *
 * Le catalogue d'exemple ne se pose qu'une fois, au tout premier démarrage :
 * une fois `catalog.json` créé, il n'est plus jamais relu. Un produit ajouté
 * au dépôt après coup — parce qu'un flyer est arrivé, par exemple — n'a donc
 * aucun moyen d'atteindre une boutique en service. C'est ce que cet outil fait.
 *
 *   node tools/importer-produits.mjs                    # liste, ne change rien
 *   node tools/importer-produits.mjs --tout             # importe ce qui manque
 *   node tools/importer-produits.mjs plasma-static-banana-kush
 *   node tools/importer-produits.mjs --tout --remplacer # écrase aussi l'existant
 *
 * Deux garde-fous. Sans argument, il ne fait que regarder : on voit d'abord ce
 * qui va se passer. Et il n'écrase jamais un produit déjà présent sans
 * `--remplacer`, parce que le vendeur y a peut-être changé un prix ou un stock,
 * et qu'un import silencieux les lui reprendrait.
 *
 * L'outil parle au magasin, pas au fichier : il marche donc aussi bien sur les
 * fichiers JSON que sur Postgres.
 */
import 'dotenv/config';
import { products as catalogueDeDepart, categories as categoriesDeDepart } from '../server/data/products.js';
import { getCatalog, createProduct, updateProduct, saveCategories } from '../server/catalog.js';

const args = process.argv.slice(2);
const tout = args.includes('--tout');
const remplacer = args.includes('--remplacer');
const demandes = args.filter((a) => !a.startsWith('--'));

const gras = (t) => `\x1b[1m${t}\x1b[0m`;
const vert = (t) => `\x1b[32m${t}\x1b[0m`;
const jaune = (t) => `\x1b[33m${t}\x1b[0m`;

const euros = (c) => `${(c / 100).toFixed(2)} €`;

/** Ce qu'un produit propose, en une ligne lisible. */
const resume = (p) =>
  p.variants?.length
    ? p.variants.map((v) => `${v.label} ${euros(v.price)}`).join(' · ')
    : `${euros(p.price)}, ${p.stock ?? 0} en stock`;

const catalogue = await getCatalog({ includeHidden: true });
const presents = new Map(catalogue.products.map((p) => [p.id, p]));

// Sans identifiant demandé, on considère tout le catalogue de départ.
const candidats = demandes.length
  ? catalogueDeDepart.filter((p) => demandes.includes(p.id))
  : catalogueDeDepart;

const introuvables = demandes.filter((d) => !catalogueDeDepart.some((p) => p.id === d));
if (introuvables.length) {
  console.error(`\n  Inconnus au catalogue de départ : ${introuvables.join(', ')}`);
  console.error(`  Disponibles : ${catalogueDeDepart.map((p) => p.id).join(', ')}\n`);
  process.exit(1);
}

const manquants = candidats.filter((p) => !presents.has(p.id));
const deja = candidats.filter((p) => presents.has(p.id));

console.log(`\n${gras('Catalogue de la boutique')} : ${catalogue.products.length} produit(s)`);

if (manquants.length) {
  console.log(`\n${gras('Absents de ta boutique')} :`);
  for (const p of manquants) console.log(`  ${jaune('+')} ${p.name}  —  ${resume(p)}`);
}
if (deja.length) {
  console.log(`\n${gras('Déjà présents')}${remplacer ? ' (seront écrasés)' : ' (laissés tels quels)'} :`);
  for (const p of deja) console.log(`  ${vert('=')} ${p.name}  —  ${resume(presents.get(p.id))}`);
}

if (!manquants.length && !(remplacer && deja.length)) {
  console.log(`\n  Rien à importer : ta boutique a déjà tout ça.\n`);
  process.exit(0);
}

if (!tout && !demandes.length) {
  console.log(
    `\n  ${gras('Aucun changement fait.')} Pour importer ce qui manque :\n` +
      `      node tools/importer-produits.mjs --tout\n` +
      `  Ou un produit précis :\n` +
      `      node tools/importer-produits.mjs ${manquants[0]?.id ?? candidats[0].id}\n`
  );
  process.exit(0);
}

// Les catégories d'abord : un produit rangé dans une catégorie qui n'existe pas
// n'apparaîtrait sous aucun onglet de la boutique.
const besoins = new Set(candidats.map((p) => p.category));
const connues = new Set(catalogue.categories.map((c) => c.id));
const aAjouter = [...besoins].filter((id) => !connues.has(id));
if (aAjouter.length) {
  const ajout = categoriesDeDepart.filter((c) => aAjouter.includes(c.id));
  await saveCategories([
    ...catalogue.categories.filter((c) => c.id !== 'all'),
    ...ajout,
  ]);
  // Ajoutées en fin de liste, donc en dernier onglet : on ne réordonne pas
  // ce que le vendeur a peut-être arrangé lui-même, on le prévient.
  console.log(
    `\n  Catégories ajoutées en fin de liste : ${ajout.map((c) => c.label).join(', ')}` +
      "\n  (l'ordre des onglets se règle dans l'espace admin, onglet Catégories)"
  );
}

console.log('');
let ajoutes = 0;
let ecrases = 0;

for (const p of candidats) {
  const existe = presents.has(p.id);
  if (existe && !remplacer) continue;

  // `visible: true` explicite : le catalogue de départ ne porte pas le champ,
  // et un produit importé doit se voir, sinon l'import semble n'avoir rien fait.
  const aEcrire = { ...p, visible: true };

  try {
    if (existe) {
      await updateProduct(p.id, aEcrire);
      ecrases++;
      console.log(`  ${vert('↻')} ${p.name} remplacé`);
    } else {
      await createProduct(aEcrire);
      ajoutes++;
      console.log(`  ${vert('+')} ${p.name} ajouté  —  ${resume(p)}`);
    }
  } catch (err) {
    console.error(`  ${jaune('!')} ${p.name} : ${err.message}`);
  }
}

console.log(
  `\n  ${gras(`${ajoutes} ajouté(s)`)}${ecrases ? `, ${ecrases} remplacé(s)` : ''}.` +
    '\n  Les changements sont déjà en base : rien à redémarrer.' +
    '\n  Ouvre la boutique pour vérifier, et ajuste les stocks dans l\'onglet Stock.\n'
);
