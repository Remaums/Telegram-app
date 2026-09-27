/**
 * Le découpage d'une description de produit.
 *
 * Aucun serveur, aucun navigateur : `description.js` ne touche pas au DOM,
 * et c'est précisément pour cela qu'il existe à part. Le dessin — poser les
 * éléments — vit dans `app.js` et se regarde à l'œil ; les décisions, elles,
 * se vérifient ici.
 *
 * Ce que ces épreuves protègent : une description écrite sur plusieurs
 * lignes s'affichait en un seul pavé, parce qu'elle partait dans un
 * `textContent` qui écrase les retours à la ligne. Six lignes courtes se
 * rejoignaient, tirets compris, au milieu des phrases.
 *
 * Usage :  node test/description.test.mjs
 */
import { decouperLaDescription } from '../webapp/js/description.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const puces = (blocs) => blocs.filter((b) => b.type === 'points').flatMap((b) => b.items);
const listes = (blocs) => blocs.filter((b) => b.type === 'points').length;
const lignes = (blocs) => blocs.filter((b) => b.type === 'ligne').map((b) => b.texte);

console.log('\n── Ce que le vendeur tape ─────────────────────────');

let b = decouperLaDescription('Fleur indica cultivée en intérieur, séchée lentement puis affinée.');
check('Un paragraphe reste un seul bloc', b.length === 1 && b[0].type === 'ligne', JSON.stringify(b));

b = decouperLaDescription('LPF STATIC 2K26\nNez banane mûre\nStock limité');
check('Trois lignes restent trois lignes', lignes(b).length === 3 && listes(b) === 0,
  lignes(b).join(' | '));

b = decouperLaDescription('LPF STATIC\n- Texture souple\n- Scellé d\'origine');
check('Un tiret devient un point de liste',
  listes(b) === 1 && puces(b).length === 2 && puces(b)[0] === 'Texture souple',
  JSON.stringify(puces(b)));
check('Et le marqueur ne se retrouve pas dans le texte',
  !puces(b).some((p) => /^[-–—•*·]/.test(p)), puces(b).join(' | '));

b = decouperLaDescription('- un\n- deux\n- trois');
check('Les points qui se suivent font UNE liste', listes(b) === 1 && puces(b).length === 3,
  `${listes(b)} liste(s)`);

// Le point qui fait la différence à l'écran : sans cette coupure, la phrase
// libre deviendrait un point sans puce, coincé au milieu des autres.
b = decouperLaDescription('- un\n- deux\nUne phrase\n- trois');
check('Une ligne libre referme la liste en cours',
  listes(b) === 2 && lignes(b).length === 1 && puces(b).length === 3,
  b.map((x) => x.type).join(' → '));
check('Et l\'ordre est celui du vendeur',
  b.map((x) => x.type).join(',') === 'points,ligne,points', b.map((x) => x.type).join(','));

// Le clavier d'un téléphone propose l'un ou l'autre selon la langue : on ne
// demande pas au vendeur de connaître le bon.
b = decouperLaDescription('• a\n– b\n— c\n* d\n· e\n- f');
check('Tous les marqueurs courants comptent', puces(b).join('') === 'abcdef', puces(b).join(''));

console.log('\n── Ce qui ne doit pas produire de vide ────────────');

b = decouperLaDescription('Titre\n\n\n- un\n\n- deux');
check('Les lignes vides sont ignorées', lignes(b).length === 1 && puces(b).length === 2,
  JSON.stringify(b));
// Deux points séparés par une ligne vide restent UNE liste : la ligne vide
// n'est pas une ligne de texte, elle ne referme donc rien.
check('Une ligne vide ne coupe pas une liste', listes(b) === 1, `${listes(b)} liste(s)`);

// Un tiret oublié en fin de saisie ne doit pas fabriquer une puce vide,
// qui s'afficherait comme un point tout seul en bas de la fiche.
b = decouperLaDescription('Titre\n-\n- vrai point');
check('Un marqueur seul ne fabrique pas de puce vide',
  puces(b).length === 1 && puces(b)[0] === 'vrai point', JSON.stringify(puces(b)));

check('Une description vide ne rend rien', decouperLaDescription('').length === 0);
check('Une description absente non plus', decouperLaDescription(null).length === 0);
check('Ni une description qui n\'est que des espaces',
  decouperLaDescription('   \n\n  \t ').length === 0);

console.log('\n── Ce qui traverse sans être touché ───────────────');

// Le découpage ne nettoie pas le texte : c'est `textContent` qui le rend
// inerte, côté affichage. Si un jour quelqu'un remplace ce rendu par de
// l'innerHTML, cette épreuve ne le rattrapera pas — mais elle dit au moins
// que rien n'est perdu en route.
b = decouperLaDescription('- <b>gras</b>');
check('Le texte est rendu tel quel, sans interprétation',
  puces(b)[0] === '<b>gras</b>', puces(b)[0]);

b = decouperLaDescription('  Espaces autour  \n  - point  ');
check('Les espaces de bord sont retirés',
  lignes(b)[0] === 'Espaces autour' && puces(b)[0] === 'point',
  `${JSON.stringify(lignes(b)[0])} / ${JSON.stringify(puces(b)[0])}`);

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Description : OK'}`);
process.exit(failures ? 1 : 0);
