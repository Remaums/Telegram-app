import { config } from './config.js';

/**
 * Photos de produits envoyées au bot.
 *
 * Le fichier n'est jamais recopié chez nous : on garde la référence Telegram
 * et on sert l'image à la demande. Trois raisons : le disque est en lecture
 * seule en serverless, une photo écrite sur un VPS disparaîtrait au prochain
 * déploiement ailleurs, et il n'y a rien de plus à sauvegarder.
 *
 * Telegram renvoie un chemin de fichier valable environ une heure : on le
 * garde en mémoire trois quarts d'heure pour ne pas réinterroger l'API à
 * chaque affichage.
 */

const PATH_TTL = 45 * 60 * 1000;
const cache = new Map();

/** URL de téléchargement d'un fichier Telegram, résolue puis mémorisée. */
export async function resolveFileUrl(fileId) {
  const cached = cache.get(fileId);
  if (cached && cached.expiresAt > Date.now()) return cached.url;

  const res = await fetch(`${config.telegramApiRoot}/bot${config.botToken}/getFile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description ?? 'fichier introuvable chez Telegram');

  const url = `${config.telegramApiRoot}/file/bot${config.botToken}/${data.result.file_path}`;
  cache.set(fileId, { url, expiresAt: Date.now() + PATH_TTL });
  return url;
}

/**
 * Retrouve le produit visé par la légende d'une photo.
 *
 * L'identifiant ou le nom exact l'emportent toujours. Sinon on cherche la
 * légende dans les noms : une seule correspondance suffit, plusieurs
 * renvoient la liste. Écraser la photo du mauvais produit se répare mal —
 * mieux vaut demander de préciser que deviner. « neon » ne désigne rien
 * quand la boutique vend « Néon Kush » et « Yellow Neon Haze ».
 */
export function matchProduct(caption, products) {
  const needle = normalize(caption);
  if (!needle) return { match: null, candidates: [] };

  const exact = products.find((p) => normalize(p.id) === needle || normalize(p.name) === needle);
  if (exact) return { match: exact, candidates: [] };

  const contains = products.filter(
    (p) => normalize(p.name).includes(needle) || normalize(p.id).includes(needle)
  );
  if (contains.length === 1) return { match: contains[0], candidates: [] };

  return { match: null, candidates: contains.slice(0, 8) };
}

function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^\/photo\s*/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
