import { createStore } from './store.js';
import { HttpError } from './catalog.js';

/**
 * Codes promo et remises automatiques par palier.
 *
 * Règle retenue : le client obtient **la meilleure des deux** remises, jamais
 * les deux cumulées. Cumuler ouvre la porte aux additions surprises (un code
 * de 20 % sur un panier déjà remisé de 15 %) et rend le prix final difficile
 * à expliquer au téléphone.
 */

const store = createStore('promos.json', {});

/* ── Codes ───────────────────────────────────────────────── */

export async function listPromos() {
  const data = await store.read();
  return Object.entries(data)
    .map(([code, promo]) => ({ code, ...promo }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

export async function savePromo(input) {
  const code = normalizeCode(input?.code);
  if (!code) throw new HttpError(400, 'Code invalide : lettres et chiffres, 3 à 20 caractères.');

  const type = input.type === 'amount' ? 'amount' : 'percent';
  const value = Math.round(Number(input.value));
  if (!Number.isFinite(value) || value <= 0) throw new HttpError(400, 'Valeur de remise invalide.');
  if (type === 'percent' && value > 90) throw new HttpError(400, 'Remise plafonnée à 90 %.');

  return store.update((data) => {
    const previous = data[code] ?? {};
    data[code] = {
      type,
      value,
      // Montant minimum de panier pour que le code s'applique.
      minSubtotal: Math.max(0, Math.round(Number(input.minSubtotal ?? 0)) || 0),
      expiresAt: input.expiresAt ? String(input.expiresAt).slice(0, 10) : null,
      maxUses: input.maxUses ? Math.max(1, Math.round(Number(input.maxUses))) : null,
      oncePerClient: input.oncePerClient !== false,
      active: input.active !== false,
      uses: previous.uses ?? 0,
      usedBy: previous.usedBy ?? [],
    };
    return { code, ...data[code] };
  });
}

export async function deletePromo(code) {
  return store.update((data) => {
    delete data[normalizeCode(code)];
    return { ok: true };
  });
}

/**
 * Vérifie un code pour un panier donné, sans le consommer.
 *
 * @returns {{code: string, discount: number, label: string}}
 */
export async function checkPromo(code, subtotal, userId) {
  const key = normalizeCode(code);
  const promo = (await store.read())[key];
  verifier(promo, subtotal, userId);
  return { code: key, discount: discountOf(promo, subtotal), label: labelOf(promo) };
}

/** Les conditions d'un code, en un seul endroit : l'aperçu et la réservation
 *  doivent refuser exactement les mêmes cas. */
function verifier(promo, subtotal, userId) {
  if (!promo || !promo.active) throw new HttpError(400, 'Code inconnu.');
  if (promo.expiresAt && promo.expiresAt < today()) throw new HttpError(400, 'Ce code a expiré.');
  if (promo.maxUses !== null && promo.uses >= promo.maxUses) {
    throw new HttpError(400, 'Ce code a déjà servi le nombre de fois prévu.');
  }
  if (promo.oncePerClient && promo.usedBy.includes(String(userId))) {
    throw new HttpError(400, 'Tu as déjà utilisé ce code.');
  }
  if (subtotal < promo.minSubtotal) {
    throw new HttpError(400, `Ce code s'applique à partir de ${(promo.minSubtotal / 100).toFixed(2)} €.`);
  }
}

/**
 * Vérifie et consomme le code en une seule opération.
 *
 * Contrôler puis consommer plus tard laissait huit commandes simultanées
 * emporter un code marqué « un seul usage » : toutes lisaient le compteur à
 * zéro avant qu'aucune ne l'incrémente. La vérification vit désormais dans la
 * mutation qui incrémente — le magasin fichier ne peut pas interrompre une
 * fonction synchrone, et Postgres tient la ligne verrouillée le temps de la
 * transaction.
 *
 * @returns {{code: string, discount: number, label: string}}
 */
export async function reservePromo(code, subtotal, userId) {
  const key = normalizeCode(code);
  return store.update((data) => {
    const promo = data[key];
    verifier(promo, subtotal, userId);

    promo.uses = (promo.uses ?? 0) + 1;
    if (promo.oncePerClient && !promo.usedBy.includes(String(userId))) {
      promo.usedBy.push(String(userId));
    }
    return { code: key, discount: discountOf(promo, subtotal), label: labelOf(promo) };
  });
}

/**
 * Rend un code réservé.
 *
 * Sert quand la commande échoue après coup — stock envolé, créneau complet —
 * ou quand la remise automatique s'avère plus avantageuse : sans ça, un code
 * serait grillé par une commande qui n'a jamais existé.
 */
export async function releasePromo(code, userId) {
  const key = normalizeCode(code);
  return store.update((data) => {
    const promo = data[key];
    if (!promo) return null;
    promo.uses = Math.max(0, (promo.uses ?? 0) - 1);
    promo.usedBy = (promo.usedBy ?? []).filter((v) => v !== String(userId));
    return promo;
  });
}

/**
 * Remplace tous les codes.
 *
 * Réservé à la restauration. Chaque code repasse par la validation, mais son
 * compteur d'usages est repris tel quel : sinon restaurer une sauvegarde
 * rendrait à tout le monde un code déjà consommé.
 */
export async function replacePromos(promos) {
  if (!Array.isArray(promos)) return { promos: 0 };

  return store.update((data) => {
    for (const cle of Object.keys(data)) delete data[cle];
    let gardes = 0;
    for (const promo of promos) {
      const code = normalizeCode(promo?.code);
      if (!code) continue;
      const type = promo.type === 'amount' ? 'amount' : 'percent';
      const value = Math.round(Number(promo.value));
      if (!Number.isFinite(value) || value <= 0) continue;

      data[code] = {
        type,
        value: type === 'percent' ? Math.min(90, value) : value,
        minSubtotal: Math.max(0, Math.round(Number(promo.minSubtotal ?? 0)) || 0),
        expiresAt: promo.expiresAt ? String(promo.expiresAt).slice(0, 10) : null,
        maxUses: promo.maxUses ? Math.max(1, Math.round(Number(promo.maxUses))) : null,
        oncePerClient: promo.oncePerClient !== false,
        active: promo.active !== false,
        uses: Math.max(0, Math.round(Number(promo.uses ?? 0)) || 0),
        usedBy: Array.isArray(promo.usedBy) ? promo.usedBy.map(String) : [],
      };
      gardes++;
    }
    return { promos: gardes };
  });
}

/* ── Paliers automatiques ────────────────────────────────── */

/**
 * Remise automatique selon le sous-total.
 *
 * @param tiers [{ from: centimes, percent: 1..90 }]
 */
export function tierDiscount(tiers, subtotal) {
  const applicable = (tiers ?? [])
    .filter((t) => Number.isFinite(Number(t.from)) && subtotal >= Number(t.from))
    .sort((a, b) => Number(b.from) - Number(a.from))[0];

  if (!applicable) return { discount: 0, label: null };
  const percent = Math.min(90, Math.max(1, Math.round(Number(applicable.percent))));
  return {
    discount: Math.round((subtotal * percent) / 100),
    label: `−${percent} % dès ${(Number(applicable.from) / 100).toFixed(2)} €`,
  };
}

export function normalizeTiers(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((t) => ({
      from: Math.max(0, Math.round(Number(t.from))),
      percent: Math.min(90, Math.max(1, Math.round(Number(t.percent)))),
    }))
    .filter((t) => Number.isFinite(t.from) && Number.isFinite(t.percent))
    .sort((a, b) => a.from - b.from)
    .slice(0, 5);
}

/* ── Utilitaires ─────────────────────────────────────────── */

function discountOf(promo, subtotal) {
  const raw = promo.type === 'percent' ? Math.round((subtotal * promo.value) / 100) : promo.value;
  // Une remise ne rend jamais d'argent : elle est bornée au panier.
  return Math.min(subtotal, Math.max(0, raw));
}

function labelOf(promo) {
  return promo.type === 'percent' ? `−${promo.value} %` : `−${(promo.value / 100).toFixed(2)} €`;
}

function normalizeCode(value) {
  const code = String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code.length >= 3 && code.length <= 20 ? code : '';
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/* ── La meilleure des deux ───────────────────────────────── */

/**
 * Remise finalement appliquée à un panier : le code saisi ou le palier
 * automatique, selon ce qui arrange le client — jamais les deux.
 *
 * Un code invalide remonte son erreur (le client l'a tapé, il doit savoir
 * pourquoi il ne passe pas) ; l'absence de code, elle, laisse simplement le
 * palier jouer seul.
 *
 * @returns {{discount: number, label: string|null, code: string|null, source: 'promo'|'tier'|null}}
 */
export async function bestDiscount({ code, subtotal, userId, tiers, reserve = false }) {
  const palier = tierDiscount(tiers, subtotal);
  // `reserve` distingue l'aperçu de la commande : l'un ne fait que regarder,
  // l'autre prend la place. Un aperçu qui consommerait le code le griller à
  // chaque fois que le client tape son code pour voir.
  const promo = code
    ? reserve
      ? await reservePromo(code, subtotal, userId)
      : await checkPromo(code, subtotal, userId)
    : null;

  if (promo && promo.discount >= palier.discount) {
    return { discount: promo.discount, label: promo.label, code: promo.code, source: 'promo' };
  }
  // Le palier l'emporte : le code réservé pour rien est rendu tout de suite.
  if (promo && reserve) await releasePromo(promo.code, userId).catch(() => {});

  if (palier.discount > 0) {
    return { discount: palier.discount, label: palier.label, code: null, source: 'tier' };
  }
  return { discount: 0, label: null, code: null, source: null };
}
