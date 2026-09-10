import { createStore } from './store.js';
import { products as seedProducts, categories as seedCategories } from './data/products.js';

/**
 * Catalogue modifiable depuis l'espace admin.
 *
 * Au premier démarrage, `data/catalog.json` est créé à partir du catalogue
 * d'exemple de `data/products.js`. Ensuite, c'est le fichier JSON qui fait foi :
 * le module d'exemple ne sert plus que de graine.
 */
const store = createStore('catalog.json', () => {
  // Les produits d'exemple reçoivent tous la date d'installation : le tri
  // « nouveautés » les laisse donc dans l'ordre du catalogue, et le premier
  // produit que le vendeur ajoute passe naturellement devant.
  const installe = new Date().toISOString();
  return {
    products: structuredClone(seedProducts).map((p) => ({ visible: true, createdAt: installe, ...p })),
    categories: structuredClone(seedCategories),
  };
});

/* ── Lecture ─────────────────────────────────────────────── */

export async function getCatalog({ includeHidden = false } = {}) {
  const data = await store.read();
  const products = includeHidden ? data.products : data.products.filter((p) => p.visible !== false);
  return { products, categories: data.categories };
}

export async function getProduct(id, { includeHidden = true } = {}) {
  const data = await store.read();
  const product = data.products.find((p) => p.id === id);
  if (!product) return null;
  if (!includeHidden && product.visible === false) return null;
  return product;
}

/** Stock disponible pour un produit, ou pour une de ses variantes. */
export function stockOf(product, variantId = null) {
  if (product.variants?.length) {
    const variant = product.variants.find((v) => v.id === variantId);
    return variant ? Number(variant.stock ?? 0) : 0;
  }
  return Number(product.stock ?? 0);
}

/** Prix effectif d'un produit pour une variante donnée. */
export function priceOf(product, variantId = null) {
  const variant = product.variants?.find((v) => v.id === variantId);
  return variant ? variant.price : product.price;
}

/* ── Écriture : produits ─────────────────────────────────── */

export async function createProduct(input) {
  return store.update((data) => {
    const product = normalizeProduct(input);
    if (data.products.some((p) => p.id === product.id)) {
      throw new HttpError(409, `L'identifiant « ${product.id} » est déjà utilisé.`);
    }
    data.products.push(product);
    return product;
  });
}

export async function updateProduct(id, patch) {
  return store.update((data) => {
    const index = data.products.findIndex((p) => p.id === id);
    if (index === -1) throw new HttpError(404, 'Produit introuvable.');
    // L'identifiant sert de clé dans les commandes déjà passées : il ne bouge pas.
    const merged = normalizeProduct({ ...data.products[index], ...patch, id });
    data.products[index] = merged;
    return merged;
  });
}

/**
 * Rattache une photo envoyée au bot à un produit.
 *
 * On enregistre la référence du fichier chez Telegram, pas le fichier : rien
 * à écrire sur le disque (impossible en serverless), rien à sauvegarder, et
 * la photo suit la boutique si elle change d'hébergeur. Le paramètre `v`
 * force les navigateurs à recharger l'image après un changement.
 */
export async function setProductPhoto(id, fileId) {
  return store.update((data) => {
    const index = data.products.findIndex((p) => p.id === id);
    if (index === -1) throw new HttpError(404, 'Produit introuvable.');

    data.products[index] = normalizeProduct({
      ...data.products[index],
      id,
      photoFileId: fileId,
      image: `/api/photo/${id}?v=${Date.now().toString(36)}`,
    });
    return data.products[index];
  });
}

export async function deleteProduct(id) {
  return store.update((data) => {
    const index = data.products.findIndex((p) => p.id === id);
    if (index === -1) throw new HttpError(404, 'Produit introuvable.');
    return data.products.splice(index, 1)[0];
  });
}

/** Fixe le stock d'un produit ou d'une variante à une valeur absolue. */
export async function setStock(id, variantId, quantity) {
  const value = Math.max(0, Math.floor(Number(quantity)));
  if (!Number.isFinite(value)) throw new HttpError(400, 'Quantité invalide.');

  return store.update((data) => {
    const product = data.products.find((p) => p.id === id);
    if (!product) throw new HttpError(404, 'Produit introuvable.');

    if (variantId) {
      const variant = product.variants?.find((v) => v.id === variantId);
      if (!variant) throw new HttpError(404, 'Variante introuvable.');
      variant.stock = value;
    } else {
      if (product.variants?.length) {
        throw new HttpError(400, 'Ce produit a des variantes : précise laquelle.');
      }
      product.stock = value;
    }
    return product;
  });
}

/**
 * Décrémente le stock pour les lignes d'une commande, en tout ou rien.
 *
 * La vérification et l'écriture se font dans la même mutation : deux commandes
 * simultanées ne peuvent pas passer toutes les deux sur le dernier article.
 */
export async function reserveStock(lines) {
  return store.update((data) => {
    const insufficient = [];

    for (const line of lines) {
      const product = data.products.find((p) => p.id === line.id);
      if (!product) throw new HttpError(400, `Produit inconnu : ${line.id}`);
      const available = stockOf(product, line.variantId);
      if (available < line.quantity) {
        insufficient.push({ name: product.name, variantId: line.variantId, available });
      }
    }

    if (insufficient.length) {
      const details = insufficient
        .map((i) => `${i.name} (reste ${i.available})`)
        .join(', ');
      throw new HttpError(409, `Stock insuffisant : ${details}`);
    }

    // On renvoie ce qui reste après coup : c'est l'appelant qui décide
    // d'alerter, la couche catalogue ne connaît pas Telegram.
    const remaining = [];
    for (const line of lines) {
      const product = data.products.find((p) => p.id === line.id);
      if (product.variants?.length) {
        const variant = product.variants.find((v) => v.id === line.variantId);
        variant.stock = Number(variant.stock ?? 0) - line.quantity;
        remaining.push({ id: product.id, name: product.name, variantLabel: variant.label, left: variant.stock });
      } else {
        product.stock = Number(product.stock ?? 0) - line.quantity;
        remaining.push({ id: product.id, name: product.name, variantLabel: null, left: product.stock });
      }
    }
    return remaining;
  });
}

/** Remet le stock en place (annulation d'une commande). */
export async function restoreStock(lines) {
  return store.update((data) => {
    for (const line of lines) {
      const product = data.products.find((p) => p.id === line.id);
      if (!product) continue;
      if (product.variants?.length) {
        const variant = product.variants.find((v) => v.id === line.variantId);
        if (variant) variant.stock = Number(variant.stock ?? 0) + line.quantity;
      } else {
        product.stock = Number(product.stock ?? 0) + line.quantity;
      }
    }
    return true;
  });
}

/* ── Écriture : catégories ───────────────────────────────── */

export async function saveCategories(categories) {
  if (!Array.isArray(categories) || categories.length === 0) {
    throw new HttpError(400, 'Il faut au moins une catégorie.');
  }
  return store.update((data) => {
    // Deux catégories de même nom donnent le même identifiant : les produits
    // de l'une se retrouveraient rangés dans l'autre, et le filtre afficherait
    // deux onglets qui montrent la même chose. On garde la première.
    const vus = new Set();
    const propres = [];
    for (const c of categories) {
      const label = String(c.label ?? '').trim().slice(0, 40);
      const id = slug(c.id ?? label);
      if (!id || !label || vus.has(id)) continue;
      vus.add(id);
      propres.push({ id, label, emoji: String(c.emoji ?? '•').slice(0, 4) });
    }
    if (!propres.length) throw new HttpError(400, 'Il faut au moins une catégorie nommée.');

    data.categories = propres;
    return data.categories;
  });
}

/* ── Validation ──────────────────────────────────────────── */

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Un montant en centimes, ou rien.
 *
 * `Number(null)` et `Number('')` valent zéro : sans ce filtre, un champ prix
 * resté vide créait un produit à 0 €, que n'importe qui pouvait alors
 * commander gratuitement. Un zéro délibérément saisi, lui, reste accepté.
 */
function montant(value, message) {
  const fourni =
    typeof value === 'number' || (typeof value === 'string' && value.trim() !== '');
  const cents = fourni ? Math.round(Number(value)) : NaN;
  if (!Number.isFinite(cents) || cents < 0) throw new HttpError(400, message);
  return cents;
}

function normalizeProduct(input) {
  const name = String(input.name ?? '').trim();
  if (!name) throw new HttpError(400, 'Le nom est obligatoire.');

  const id = slug(input.id || name);
  if (!id) throw new HttpError(400, "L'identifiant est invalide.");

  const price = montant(input.price, 'Prix invalide.');

  const variants = Array.isArray(input.variants) && input.variants.length
    ? input.variants.map((v) => {
        const label = String(v.label ?? '').trim();
        if (!label) throw new HttpError(400, 'Chaque format doit avoir un libellé.');
        const vPrice = montant(v.price, `Prix invalide pour le format « ${label} ».`);
        return {
          id: slug(v.id || label),
          label,
          price: vPrice,
          stock: Math.max(0, Math.floor(Number(v.stock ?? 0))),
        };
      })
    : null;

  return {
    id,
    // Date d'entrée au catalogue, posée une fois puis conservée : sans elle,
    // « nouveautés » ne voudrait rien dire. Un produit déjà présent avant
    // cette version prend la date du jour où on le touche, faute de mieux.
    createdAt: input.createdAt ?? new Date().toISOString(),
    name: name.slice(0, 60),
    category: slug(input.category ?? 'all') || 'all',
    // Sans variante, le prix de la fiche fait foi ; avec variantes, on affiche
    // le prix du format le moins cher comme prix d'appel.
    price: variants ? Math.min(...variants.map((v) => v.price)) : price,
    stock: variants ? null : Math.max(0, Math.floor(Number(input.stock ?? 0))),
    image: String(input.image ?? '/assets/products/box.svg').slice(0, 300),
    // Photo envoyée au bot : on garde la référence Telegram, pas le fichier.
    photoFileId: input.photoFileId ? String(input.photoFileId).slice(0, 200) : undefined,
    badge: input.badge ? String(input.badge).slice(0, 20) : undefined,
    tags: Array.isArray(input.tags) ? input.tags.slice(0, 6).map((t) => String(t).slice(0, 24)) : [],
    short: String(input.short ?? '').slice(0, 140),
    description: String(input.description ?? '').slice(0, 2000),
    visible: input.visible !== false,
    variants,
  };
}

/** Transforme un texte libre en identifiant utilisable dans une URL. */
function slug(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}
