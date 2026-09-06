import express from 'express';

import { config } from './config.js';
import { verifyInitData } from './telegram-auth.js';
import {
  HttpError,
  getCatalog,
  createProduct,
  updateProduct,
  deleteProduct,
  setStock,
  saveCategories,
  restoreStock,
} from './catalog.js';
import { STATUSES, listOrders, getOrder, setStatus, stats } from './orders.js';
import { notifyCustomer } from './bot.js';

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
    res.json(await setStock(req.params.id, variantId, quantity));
  })
);

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

    // Une annulation remet les articles en rayon.
    if (changed && nextStatus === 'annulee') {
      await restoreStock(order.items);
    }

    if (changed) {
      notifyCustomer(order).catch((err) =>
        console.error('Notification client impossible :', err.message)
      );
    }

    res.json(order);
  })
);

/* ── Tableau de bord ─────────────────────────────────────── */

adminRouter.get(
  '/stats',
  route(async (req, res) => res.json(await stats()))
);
