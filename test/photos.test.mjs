/**
 * Photos de produits envoyées au bot.
 *
 * On ne peut pas appeler Telegram depuis les tests : ce qui se vérifie ici,
 * c'est la partie qui décide — retrouver le produit visé par une légende, et
 * enregistrer la référence sans jamais recopier le fichier.
 *
 * Usage :  BOT_TOKEN=… node test/photos.test.mjs
 */
import 'dotenv/config';

if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer les tests.');
  process.exit(1);
}

const { matchProduct } = await import('../server/photos.js');
const { setProductPhoto, getProduct, getCatalog } = await import('../server/catalog.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const products = [
  { id: 'neon-kush', name: 'Néon Kush' },
  { id: 'yellow-neon-haze', name: 'Yellow Neon Haze' },
  { id: 'brique-68', name: 'Brique 68' },
  { id: 'dry-sift-68', name: 'Dry Sift 68' },
];

/* ── Retrouver le produit visé ───────────────────────────── */

check('Identifiant exact', matchProduct('neon-kush', products).match?.id === 'neon-kush');
check('Nom exact, accents et casse ignorés', matchProduct('NEON KUSH', products).match?.id === 'neon-kush');
check('Légende préfixée par la commande', matchProduct('/photo Néon Kush', products).match?.id === 'neon-kush');
check('Début de nom sans ambiguïté', matchProduct('brique', products).match?.id === 'brique-68');

const ambigu = matchProduct('neon', products);
check('Ambiguïté : on rend la liste au lieu de choisir',
  ambigu.match === null && ambigu.candidates.length === 2,
  ambigu.candidates.map((p) => p.id).join(', '));

const inconnu = matchProduct('parapluie', products);
check('Légende inconnue : aucune correspondance', inconnu.match === null && inconnu.candidates.length === 0);
check('Légende vide : aucune correspondance', matchProduct('', products).match === null);

/* ── Enregistrer la photo sans stocker le fichier ────────── */

const { products: reels } = await getCatalog({ includeHidden: true });
const cible = reels[0];
const avant = cible.image;

const apres = await setProductPhoto(cible.id, 'AgACAgQAAxkBAAI-FAKE-FILE-ID');
check('La référence Telegram est conservée', apres.photoFileId === 'AgACAgQAAxkBAAI-FAKE-FILE-ID');
check("L'image pointe vers la route de service", apres.image.startsWith(`/api/photo/${cible.id}?v=`), apres.image);
check("L'image a bien changé", apres.image !== avant);

const relu = await getProduct(cible.id);
check('Le produit relu porte la nouvelle image', relu.image === apres.image);
check('Aucun fichier n\'est stocké dans le produit',
  !JSON.stringify(relu).match(/base64|data:image/), 'aucune donnée binaire');

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Photos de produits : OK'}`);
process.exit(failures ? 1 : 0);
