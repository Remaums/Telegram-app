import { createStore } from './store.js';
import { HttpError } from './catalog.js';

/**
 * Réglages de la boutique : ce qui se change en exploitation, sans toucher au
 * code ni redéployer. Le fichier est créé au premier accès avec ces valeurs.
 */
const DEFAULTS = {
  // Garde-fous contre les abus. Généreux par défaut : ils doivent gêner un
  // robot, pas un client qui commande deux fois dans la soirée.
  limits: {
    ordersPerHour: 5,   // commandes par client et par heure
    unitsPerOrder: 30,  // articles cumulés dans une même commande
  },
  // Épreuve d'entrée de la boutique. Vérifiée côté serveur au moment de
  // commander : la désactiver rouvre la boutique immédiatement.
  captcha: { enabled: true },
  // Identifiants Telegram privés de commande, sous forme de chaînes.
  blocked: [],
};

const store = createStore('settings.json', () => structuredClone(DEFAULTS));

/** Réglages complets : les valeurs par défaut comblent les champs absents. */
export async function getSettings() {
  const data = await store.read();
  return {
    ...DEFAULTS,
    ...data,
    limits: { ...DEFAULTS.limits, ...(data.limits ?? {}) },
    captcha: { ...DEFAULTS.captcha, ...(data.captcha ?? {}) },
    blocked: Array.isArray(data.blocked) ? data.blocked : [],
  };
}

export async function saveSettings(patch) {
  if (!patch || typeof patch !== 'object') throw new HttpError(400, 'Réglages invalides.');

  return store.update((data) => {
    if (patch.limits) {
      data.limits = {
        ordersPerHour: bounded(patch.limits.ordersPerHour, 1, 100, DEFAULTS.limits.ordersPerHour),
        unitsPerOrder: bounded(patch.limits.unitsPerOrder, 1, 999, DEFAULTS.limits.unitsPerOrder),
      };
    }
    if (patch.captcha) {
      data.captcha = { enabled: Boolean(patch.captcha.enabled) };
    }
    if (patch.blocked) {
      data.blocked = normalizeIds(patch.blocked);
    }
    return { ...DEFAULTS, ...data };
  });
}

/** Prive un client de commande ; le geste se fait depuis une commande reçue. */
export async function blockClient(id) {
  const value = String(id).trim();
  if (!/^\d{1,20}$/.test(value)) throw new HttpError(400, 'Identifiant Telegram invalide.');

  return store.update((data) => {
    const blocked = normalizeIds(data.blocked ?? []);
    if (!blocked.includes(value)) blocked.push(value);
    data.blocked = blocked;
    return { ...DEFAULTS, ...data };
  });
}

export async function unblockClient(id) {
  const value = String(id).trim();
  return store.update((data) => {
    data.blocked = normalizeIds(data.blocked ?? []).filter((v) => v !== value);
    return { ...DEFAULTS, ...data };
  });
}

export function isBlocked(settings, id) {
  return settings.blocked.includes(String(id));
}

/* ── Validation ──────────────────────────────────────────── */

function bounded(value, min, max, fallback) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** Identifiants Telegram : des entiers, en chaînes, sans doublon. */
function normalizeIds(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((v) => String(v).trim()).filter((v) => /^\d{1,20}$/.test(v)))].slice(0, 500);
}
