import express from 'express';

import { config } from './config.js';
import { verifyInitData } from './telegram-auth.js';
import {
  HttpError,
  getCatalog,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  setStock,
  saveCategories,
  restoreStock,
} from './catalog.js';
import { STATUSES, listOrders, getOrder, setStatus, stats } from './orders.js';
import { getSettings, saveSettings, blockClient, unblockClient } from './settings.js';
import { listVerifications, decideVerification, resetVerification } from './verification.js';
import { notifyCustomer, notifyBackInStock } from './bot.js';
import { waitlistKey, takeSubscribers } from './waitlist.js';
import { listPromos, savePromo, deletePromo } from './promos.js';

export const adminRouter = express.Router();

/**
 * N'ouvre l'espace admin qu'aux identifiants listés dans ADMIN_IDS.
 *
 * La signature Telegram est revérifiée à chaque appel : le client ne peut pas
 * se déclarer admin, c'est l'identifiant contenu dans le `initData` signé qui
 * décide.
 */
export function requireAdmin(req, res, next) {
  const result = verifyInitData(req.get('X-Telegram-Init-Data'), config.botToken);
  if (!result.ok) {
    return res.status(401).json({ error: `Authentification refusée : ${result.reason}` });
  }
  if (!config.adminIds.includes(String(result.user.id))) {
    return res.status(403).json({ error: "Cet accès est réservé à l'administrateur." });
  }
  req.telegramUser = result.user;
  next();
}

adminRouter.use(requireAdmin);

/** Enrobe un gestionnaire async pour router les HttpError vers le client. */
const route = (handler) => async (req, res, next) => {
  try {
    await handler(req, res);
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

/* ── Session ─────────────────────────────────────────────── */

adminRouter.get(
  '/session',
  route(async (req, res) => {
    res.json({ user: req.telegramUser, statuses: STATUSES, currency: config.currency });
  })
);

/* ── Catalogue ───────────────────────────────────────────── */

adminRouter.get(
  '/catalog',
  route(async (req, res) => res.json(await getCatalog({ includeHidden: true })))
);

adminRouter.post(
  '/products',
  route(async (req, res) => res.status(201).json(await createProduct(req.body ?? {})))
);

adminRouter.patch(
  '/products/:id',
  route(async (req, res) => res.json(await updateProduct(req.params.id, req.body ?? {})))
);

adminRouter.delete(
  '/products/:id',
  route(async (req, res) => {
    await deleteProduct(req.params.id);
    res.status(204).end();
  })
);

adminRouter.post(
  '/products/:id/stock',
  route(async (req, res) => {
    const { variantId = null, quantity } = req.body ?? {};

    // Relevé AVANT l'écriture, et en valeurs : le magasin fichier renvoie une
    // référence dans son cache, que setStock modifie ensuite — comparer deux
    // objets reviendrait à comparer la même chose avec elle-même.
    const avant = stockSnapshot(await getProduct(req.params.id));
    const product = await setStock(req.params.id, variantId, quantity);

    // Réassort : ceux qui attendaient l'article sont prévenus une fois.
    await announceRestock(avant, product, variantId);

    res.json(product);
  })
);

/** Relevé des stocks en valeurs, à l'abri des mutations du magasin. */
function stockSnapshot(product) {
  if (!product) return null;
  return {
    global: Number(product.stock ?? 0),
    variants: Object.fromEntries((product.variants ?? []).map((v) => [v.id, Number(v.stock ?? 0)])),
  };
}

/**
 * Prévient les clients en attente quand un article repasse au-dessus de zéro.
 *
 * On ne notifie qu'au franchissement : remonter de 2 à 5 n'intéresse
 * personne, et la liste est vidée dans la même transaction pour qu'un second
 * réassort n'écrive pas deux fois aux mêmes.
 */
async function announceRestock(avant, after, variantId = null) {
  if (!avant || !after) return;

  const lines = after.variants?.length
    ? after.variants.map((v) => ({
        variantId: v.id,
        label: v.label,
        avant: avant.variants[v.id] ?? 0,
        apres: Number(v.stock ?? 0),
      }))
    : [{ variantId: null, label: null, avant: avant.global, apres: Number(after.stock ?? 0) }];

  for (const line of lines) {
    if (variantId && line.variantId !== variantId) continue;
    if (!(line.avant <= 0 && line.apres > 0)) continue;

    const subscribers = await takeSubscribers(waitlistKey(after.id, line.variantId));
    for (const userId of subscribers) {
      notifyBackInStock(userId, after, line.label).catch(() => {});
    }
  }
}

adminRouter.put(
  '/categories',
  route(async (req, res) => res.json(await saveCategories(req.body?.categories)))
);

/* ── Commandes ───────────────────────────────────────────── */

adminRouter.get(
  '/orders',
  route(async (req, res) => {
    res.json(await listOrders({ status: req.query.status || undefined, limit: 100 }));
  })
);

adminRouter.post(
  '/orders/:reference/status',
  route(async (req, res) => {
    const reference = req.params.reference;
    const nextStatus = req.body?.status;

    const before = await getOrder(reference);
    if (!before) throw new HttpError(404, 'Commande introuvable.');

    const { order, changed } = await setStatus(reference, nextStatus);

    // Une annulation remet les articles en rayon — et peut donc débloquer
    // des clients en attente, comme un réassort.
    if (changed && nextStatus === 'annulee') {
      const avant = new Map();
      for (const item of order.items) {
        avant.set(item.id, stockSnapshot(await getProduct(item.id)));
      }
      await restoreStock(order.items);
      for (const item of order.items) {
        await announceRestock(avant.get(item.id), await getProduct(item.id), item.variantId ?? null);
      }
    }

    if (changed) {
      notifyCustomer(order).catch((err) =>
        console.error('Notification client impossible :', err.message)
      );
    }

    res.json(order);
  })
);

/* ── Réglages et clients bloqués ─────────────────────────── */

adminRouter.get(
  '/settings',
  route(async (req, res) => res.json(await getSettings()))
);

adminRouter.put(
  '/settings',
  route(async (req, res) => res.json(await saveSettings(req.body)))
);

adminRouter.post(
  '/clients/:id/block',
  route(async (req, res) => res.json(await blockClient(req.params.id)))
);

adminRouter.post(
  '/clients/:id/unblock',
  route(async (req, res) => res.json(await unblockClient(req.params.id)))
);

/* ── Codes promo ─────────────────────────────────────────── */

adminRouter.get(
  '/promos',
  route(async (req, res) => res.json(await listPromos()))
);

adminRouter.put(
  '/promos',
  route(async (req, res) => {
    await savePromo(req.body ?? {});
    // On renvoie la liste entière : l'écran admin se réaffiche d'un bloc,
    // sans avoir à deviner où insérer la ligne créée ou modifiée.
    res.json(await listPromos());
  })
);

adminRouter.delete(
  '/promos/:code',
  route(async (req, res) => {
    await deletePromo(req.params.code);
    res.json(await listPromos());
  })
);

/* ── Vérifications d'identité ────────────────────────────── */

adminRouter.get(
  '/verifications',
  route(async (req, res) => res.json(await listVerifications()))
);

adminRouter.post(
  '/verifications/:id',
  route(async (req, res) => {
    const status = req.body?.status;
    if (status === 'none') return res.json(await resetVerification(req.params.id));
    res.json(await decideVerification(req.params.id, status, req.telegramUser.id));
  })
);

/* ── Tableau de bord ─────────────────────────────────────── */

adminRouter.get(
  '/stats',
  route(async (req, res) => res.json(await stats()))
);
