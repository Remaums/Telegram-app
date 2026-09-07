/**
 * Catalogue de la boutique.
 *
 * Les prix sont en centimes pour éviter les erreurs d'arrondi.
 * `image` pointe vers un SVG de webapp/assets/products/.
 * `variants` est optionnel : si présent, le client choisit un format et le prix
 * du produit devient celui de la variante.
 */

export const categories = [
  { id: 'all', label: 'Tout', emoji: '🛒' },
  { id: 'fleurs', label: 'Fleurs', emoji: '🌿' },
  { id: 'resines', label: 'Résines', emoji: '🍫' },
  { id: 'comestibles', label: 'Comestibles', emoji: '🍪' },
  { id: 'accessoires', label: 'Accessoires', emoji: '🧰' },
  { id: 'packs', label: 'Packs', emoji: '📦' },
];

export const products = [
  {
    id: 'kartoon-kush',
    stock: null, // le stock est porté par les variantes
    name: 'Néon Kush',
    category: 'fleurs',
    price: 1200,
    image: '/assets/products/jar.svg',
    badge: 'TOP VENTE',
    tags: ['Indica', 'Nuit'],
    short: 'La classique de la maison, dense et collante.',
    description:
      "Fleur indica cultivée en intérieur, séchée lentement puis affinée trois semaines en bocal. " +
      "Nez terreux et sucré, fumée ronde. Le grand classique de la maison, celui qu'on garde " +
      "pour le canapé et les séries du dimanche soir.",
    variants: [
      { id: '2g', label: '2 g', price: 1200, stock: 24 },
      { id: '5g', label: '5 g', price: 2700, stock: 12 },
      { id: '10g', label: '10 g', price: 5000, stock: 6 },
    ],
  },
  {
    id: 'yellow-toon-haze',
    stock: null, // le stock est porté par les variantes
    name: 'Yellow Neon Haze',
    category: 'fleurs',
    price: 1400,
    image: '/assets/products/bud-sativa.svg',
    badge: 'NOUVEAU',
    tags: ['Sativa', 'Jour'],
    short: 'Sativa pétillante, agrumes et pin.',
    description:
      "Une sativa lumineuse au nez citronné, coupée haute pour garder un maximum de résine. " +
      "Effet clair et bavard, parfaite pour la journée, les longues discussions et les idées " +
      "qui partent dans tous les sens.",
    variants: [
      { id: '2g', label: '2 g', price: 1400, stock: 24 },
      { id: '5g', label: '5 g', price: 3200, stock: 12 },
      { id: '10g', label: '10 g', price: 6000, stock: 6 },
    ],
  },
  {
    id: 'cardboard-cookies',
    stock: null, // le stock est porté par les variantes
    name: 'Midnight Cookies',
    category: 'fleurs',
    price: 1600,
    image: '/assets/products/bud.svg',
    tags: ['Hybride', 'Dessert'],
    short: 'Hybride gourmande, biscuit et vanille.',
    description:
      "Hybride équilibrée au profil dessert : biscuit chaud, vanille, une pointe de terre humide. " +
      "Têtes compactes couvertes de trichomes, coupe manuelle. Notre préférée pour la fin de soirée.",
    variants: [
      { id: '2g', label: '2 g', price: 1600, stock: 24 },
      { id: '5g', label: '5 g', price: 3600, stock: 12 },
    ],
  },
  {
    id: 'hash-brick',
    stock: null, // le stock est porté par les variantes
    name: 'Brique 68',
    category: 'resines',
    price: 1800,
    image: '/assets/products/hash.svg',
    badge: 'ARTISANAL',
    tags: ['Résine', 'Pressée'],
    short: 'Résine pressée à la main, souple et parfumée.',
    description:
      "Résine tamisée puis pressée à la main, texture souple qui se travaille au pouce. " +
      "Nez épicé et boisé, fumée dense. Emballée dans son petit carton kraft tamponné maison.",
    variants: [
      { id: '2g', label: '2 g', price: 1800, stock: 24 },
      { id: '5g', label: '5 g', price: 4000, stock: 12 },
    ],
  },
  {
    id: 'toon-dry-sift',
    stock: 8,
    name: 'Dry Sift 68',
    category: 'resines',
    price: 2500,
    image: '/assets/products/hash.svg',
    tags: ['Premium', 'Tamisé'],
    short: 'Pollen tamisé à froid, blond et poudreux.',
    description:
      "Tamisage à froid sur trois mailles, sans presse : un pollen blond, poudreux, qui fond " +
      "à la moindre chaleur. Le haut du panier de la sélection résine.",
  },
  {
    id: 'space-brownie',
    stock: 30,
    name: 'Space Brownie',
    category: 'comestibles',
    price: 800,
    image: '/assets/products/cookie.svg',
    tags: ['Comestible', 'Fort'],
    short: 'Brownie fondant, dosage costaud.',
    description:
      "Brownie cuit le matin même, chocolat noir 70 % et beurre infusé maison. " +
      "Attention : l'effet met 45 à 90 minutes à monter. On commence par une moitié, " +
      "on attend, on ne double pas la dose parce qu'on s'ennuie.",
  },
  {
    id: 'gummy-pack',
    stock: 40,
    name: 'Gummies Néon',
    category: 'comestibles',
    price: 1200,
    image: '/assets/products/cookie.svg',
    badge: 'FUN',
    tags: ['Comestible', 'Doux'],
    short: 'Bonbons fruités, dosage doux et régulier.',
    description:
      "Dix bonbons gélifiés aux fruits rouges, dosés bas et régulièrement pour pouvoir " +
      "ajuster tranquillement. Boîte en carton refermable, à garder hors de portée des enfants.",
  },
  {
    id: 'grinder',
    stock: 15,
    name: 'Grinder 68 · 4 parts',
    category: 'accessoires',
    price: 1500,
    image: '/assets/products/grinder.svg',
    tags: ['Accessoire'],
    short: 'Aluminium, 4 parties, tamis à pollen.',
    description:
      "Grinder aluminium quatre parties avec tamis et bac à pollen, dents aiguisées, " +
      "aimant central. Sérigraphie néon exclusive de la maison sur le couvercle.",
  },
  {
    id: 'rolling-kit',
    stock: 50,
    name: 'Kit du rouleur',
    category: 'accessoires',
    price: 600,
    image: '/assets/products/box.svg',
    tags: ['Accessoire'],
    short: 'Feuilles, filtres carton et plateau.',
    description:
      "Le kit du quotidien : trois carnets de feuilles slim, deux carnets de filtres en carton " +
      "recyclé et un petit plateau métal illustré. Tout tient dans la poche.",
  },
  {
    id: 'pack-decouverte',
    stock: 10,
    name: 'Pack Découverte',
    category: 'packs',
    price: 4500,
    image: '/assets/products/box.svg',
    badge: '-15 %',
    tags: ['Pack', 'Économique'],
    short: '3 fleurs + 1 résine + le kit complet.',
    description:
      "La boîte d'entrée : 2 g de chaque fleur du moment, 2 g de résine pressée et le " +
      "Kit du rouleur. Environ 15 % d'économie par rapport aux produits pris séparément. " +
      "Livré dans une boîte kraft illustrée, prête à offrir.",
  },
  {
    id: 'pack-collector',
    stock: 5,
    name: 'Pack Collector 68',
    category: 'packs',
    price: 8900,
    image: '/assets/products/box.svg',
    badge: 'LIMITÉ',
    tags: ['Pack', 'Édition limitée'],
    short: 'La grosse boîte, stickers et grinder inclus.',
    description:
      "Édition limitée numérotée : 5 g de fleur premium, 3 g de tamisé, le grinder sérigraphié, " +
      "une planche de stickers néon et un poster A3. Cinquante boîtes seulement, " +
      "puis on passe à la série suivante.",
  },
];

export function findProduct(id) {
  return products.find((p) => p.id === id);
}

/** Prix effectif d'un produit pour une variante donnée (ou son prix de base). */
export function resolvePrice(product, variantId) {
  if (!variantId || !product.variants) return product.price;
  const variant = product.variants.find((v) => v.id === variantId);
  return variant ? variant.price : product.price;
}
