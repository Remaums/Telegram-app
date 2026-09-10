/**
 * Registre des fonctionnalités activables.
 *
 * Une seule liste, ici, qui sert à trois choses : les valeurs par défaut, la
 * validation de ce qu'enregistre l'admin, et les libellés affichés dans le
 * tableau de bord. Ajouter une fonctionnalité, c'est ajouter une ligne — pas
 * la recopier dans trois fichiers qui finiraient par diverger.
 *
 * Un interrupteur ne sert que s'il est respecté **côté serveur** : masquer un
 * bouton dans la Mini App ne ferme rien, l'appel reste possible. Chaque clé
 * ci-dessous est donc vérifiée dans une route ou un envoi, jamais seulement
 * dans l'affichage.
 */

export const FEATURES = [
  {
    key: 'ageGate',
    label: "Porte d'âge",
    hint: "L'écran « as-tu 18 ans ? » à l'ouverture de la boutique.",
    default: true,
  },
  {
    key: 'captcha',
    label: 'Épreuve anti-robot',
    hint: 'Une grille de tuiles à résoudre avant de pouvoir commander.',
    default: true,
  },
  {
    key: 'verification',
    label: "Vérification d'identité",
    hint: "Le client fait valider une pièce dans la conversation du bot avant de commander.",
    default: false,
  },
  {
    key: 'hours',
    label: 'Horaires automatiques',
    hint: 'La boutique se ferme et se rouvre toute seule selon la grille de la semaine.',
    default: false,
  },
  {
    key: 'zones',
    label: 'Zones de livraison',
    hint: 'Seuls les codes postaux déclarés sont desservis, avec leurs propres tarifs.',
    default: true,
  },
  {
    key: 'slots',
    label: 'Créneaux',
    hint: 'Le client réserve une plage horaire, avec une capacité par créneau.',
    default: false,
  },
  {
    key: 'search',
    label: 'Recherche au catalogue',
    hint: 'Une barre de recherche et un tri (prix, nouveautés) au-dessus de la grille.',
    default: true,
  },
  {
    key: 'tiers',
    label: 'Remises par palier',
    hint: 'Une remise automatique au-delà d\'un montant de panier.',
    default: true,
  },
  {
    key: 'promos',
    label: 'Codes promo',
    hint: 'Le champ « code promo » du panier. Les codes déjà créés sont conservés.',
    default: true,
  },
  {
    key: 'announcements',
    label: 'Annonces aux clients',
    hint: 'Écrire à ceux qui ont déjà commandé — nouveauté, promo, fermeture exceptionnelle.',
    default: false,
  },
  {
    key: 'waitlist',
    label: "Liste d'attente",
    hint: 'Sur un article épuisé, le client demande à être prévenu du retour.',
    default: true,
  },
  {
    key: 'stockAlerts',
    label: 'Alertes de stock',
    hint: 'Le bot te prévient dès qu\'une commande fait passer un article sous le seuil.',
    default: true,
  },
  {
    key: 'limits',
    label: 'Garde-fous anti-abus',
    hint: 'Plafond de commandes par heure et d\'articles par commande.',
    default: true,
  },
  {
    key: 'photos',
    label: 'Photos par le bot',
    hint: "Changer la photo d'un produit en l'envoyant au bot avec son nom en légende.",
    default: true,
  },
  {
    key: 'orderHistory',
    label: '« Mes commandes »',
    hint: "L'écran où le client relit ses commandes et leur statut.",
    default: true,
  },
  {
    key: 'clientNotifications',
    label: 'Suivi envoyé au client',
    hint: 'Confirmation de commande et messages à chaque changement de statut.',
    default: true,
  },
];

/** Toutes les fonctionnalités à leur valeur par défaut. */
export function defaultFeatures() {
  return Object.fromEntries(FEATURES.map((f) => [f.key, f.default]));
}

/**
 * Nettoie un objet reçu du client.
 *
 * Les clés inconnues sont ignorées et les absentes gardent leur valeur
 * actuelle : l'écran d'admin peut n'envoyer qu'un seul interrupteur.
 */
export function normalizeFeatures(input, current = {}) {
  const base = { ...defaultFeatures(), ...pick(current) };
  return { ...base, ...pick(input) };
}

function pick(source) {
  if (!source || typeof source !== 'object') return {};
  const out = {};
  for (const { key } of FEATURES) {
    if (source[key] !== undefined) out[key] = Boolean(source[key]);
  }
  return out;
}
