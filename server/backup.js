import { getCatalog, replaceCatalog, HttpError } from './catalog.js';
import { listOrders, replaceOrders } from './orders.js';
import { getSettings, saveSettings } from './settings.js';
import { listPromos, replacePromos } from './promos.js';

/**
 * Sortir les données de la boutique, et les y remettre.
 *
 * Deux besoins différents, deux formats. Le CSV part chez le comptable : une
 * ligne par article, lisible dans n'importe quel tableur. La sauvegarde, elle,
 * est un instantané complet destiné à revenir dans la boutique — catalogue,
 * commandes, réglages et codes.
 *
 * Ce qui n'est jamais exporté : le jeton du bot, l'URL de la base, les
 * identifiants d'administrateurs. Une sauvegarde traîne dans un dossier de
 * téléchargements ; elle ne doit rien contenir qui ouvre la boutique.
 */

const VERSION = 1;

/* ── Sauvegarde ──────────────────────────────────────────── */

export async function buildBackup() {
  const [{ products, categories }, orders, settings, promos] = await Promise.all([
    getCatalog({ includeHidden: true }),
    listOrders({ limit: 100000 }),
    getSettings(),
    listPromos(),
  ]);

  return {
    version: VERSION,
    exportedAt: new Date().toISOString(),
    counts: { products: products.length, orders: orders.length, promos: promos.length },
    catalog: { products, categories },
    // Les commandes arrivent de la plus récente à la plus ancienne : on les
    // remet dans l'ordre d'origine pour qu'une restauration les replace comme
    // elles étaient.
    orders: [...orders].reverse(),
    settings,
    promos,
  };
}

/**
 * Vérifie qu'un fichier est bien une sauvegarde de cette boutique.
 *
 * Restaurer écrase tout : mieux vaut refuser un fichier douteux que découvrir
 * après coup qu'on a remplacé son catalogue par autre chose.
 */
export function inspectBackup(data) {
  if (!data || typeof data !== 'object') throw new HttpError(400, 'Fichier de sauvegarde illisible.');
  if (data.version !== VERSION) {
    throw new HttpError(400, `Sauvegarde en version ${data.version ?? '?'}, attendue ${VERSION}.`);
  }
  if (!data.catalog || !Array.isArray(data.catalog.products)) {
    throw new HttpError(400, 'Cette sauvegarde ne contient pas de catalogue.');
  }
  if (!Array.isArray(data.orders)) {
    throw new HttpError(400, 'Cette sauvegarde ne contient pas de commandes.');
  }

  return {
    exportedAt: data.exportedAt ?? null,
    products: data.catalog.products.length,
    categories: data.catalog.categories?.length ?? 0,
    orders: data.orders.length,
    promos: Array.isArray(data.promos) ? data.promos.length : 0,
  };
}

/**
 * Remet une sauvegarde en place.
 *
 * L'ordre compte : le catalogue d'abord, car les commandes s'y réfèrent, puis
 * les commandes, puis les réglages. Si l'un échoue, ce qui précède est déjà
 * écrit — on n'a pas de transaction qui traverse les quatre magasins. Le
 * rapport dit donc précisément ce qui est passé, plutôt que de laisser croire
 * à un tout-ou-rien qui n'existe pas.
 */
export async function restoreBackup(data) {
  const resume = inspectBackup(data);
  const fait = { ...resume };

  fait.catalogue = await replaceCatalog(data.catalog);
  fait.commandes = await replaceOrders(data.orders);
  fait.codes = await replacePromos(data.promos);
  // Les réglages passent par la validation habituelle : une sauvegarde
  // ancienne peut porter des champs qui n'existent plus.
  if (data.settings) fait.reglages = await saveSettings(data.settings) ? true : false;

  return fait;
}

/* ── Export comptable ────────────────────────────────────── */

const COLONNES = [
  'reference', 'date', 'statut', 'client', 'identifiant', 'mode', 'zone', 'code_postal',
  'creneau', 'produit', 'format', 'quantite', 'prix_unitaire', 'total_ligne',
  'sous_total', 'remise', 'code_promo', 'frais_livraison', 'total_commande', 'adresse', 'note',
];

/**
 * Une ligne par article commandé.
 *
 * Une ligne par commande obligerait à empiler les produits dans une cellule ;
 * une ligne par article se trie, se filtre et s'additionne dans un tableur.
 * Les totaux de la commande sont répétés sur chaque ligne — c'est redondant,
 * mais c'est ce qui permet de filtrer sans perdre le contexte.
 */
export async function ordersToCsv({ from, to, status } = {}) {
  const orders = await listOrders({ limit: 100000, status: status || undefined });
  const debut = from ? new Date(`${from}T00:00:00`) : null;
  const fin = to ? new Date(`${to}T23:59:59.999`) : null;

  const lignes = [COLONNES.join(';')];
  let retenues = 0;

  for (const order of [...orders].reverse()) {
    const quand = new Date(order.createdAt);
    if (debut && quand < debut) continue;
    if (fin && quand > fin) continue;
    retenues++;

    for (const item of order.items) {
      lignes.push(
        [
          order.reference,
          order.createdAt,
          order.status,
          order.user?.username ? `@${order.user.username}` : order.user?.firstName ?? '',
          order.user?.id ?? '',
          order.mode === 'delivery' ? 'livraison' : 'retrait',
          order.zone?.name ?? '',
          order.zone?.postalCode ?? '',
          order.slot?.label ?? '',
          item.name,
          item.variantLabel ?? '',
          item.quantity,
          euros(item.unitPrice),
          euros(item.lineTotal),
          euros(order.subtotal),
          euros(order.discount ?? 0),
          order.promoCode ?? '',
          euros(order.deliveryFee ?? 0),
          euros(order.total),
          order.contact ?? '',
          order.note ?? '',
        ].map(champ).join(';')
      );
    }
  }

  return { csv: `${lignes.join('\r\n')}\r\n`, orders: retenues, lignes: lignes.length - 1 };
}

/**
 * Les montants sortent en euros avec une virgule décimale : c'est ce
 * qu'attend un tableur configuré en français, et le point y passerait pour
 * un séparateur de milliers.
 */
function euros(centimes) {
  return (Number(centimes ?? 0) / 100).toFixed(2).replace('.', ',');
}

/**
 * Échappe un champ pour le CSV.
 *
 * Le point-virgule sépare les colonnes, le guillemet délimite, et une note
 * client peut contenir les deux. Un champ commençant par `=`, `+`, `-` ou `@`
 * est préfixé d'une apostrophe : sans ça, un tableur l'interprète comme une
 * formule — c'est par là qu'on fait exécuter n'importe quoi à quelqu'un qui
 * ouvre un export.
 */
function champ(valeur) {
  const texte = String(valeur ?? '').replace(/[\r\n]+/g, ' ').trim();
  const sur = /^[=+\-@\t]/.test(texte) ? `'${texte}` : texte;
  return /[";]/.test(sur) ? `"${sur.replace(/"/g, '""')}"` : sur;
}
