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
import { notifyCustomer, notifyBackInStock, sendFileToAdmin } from './bot.js';
import { waitlistKey, takeSubscribers } from './waitlist.js';
import { listPromos, savePromo, deletePromo } from './promos.js';
import { FEATURES } from './features.js';
import { buildBackup, restoreBackup, inspectBackup, ordersToCsv } from './backup.js';

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
    // Le catalogue des interrupteurs vient du serveur : ajouter une
    // fonctionnalité n'oblige pas à retoucher le HTML de l'admin.
    res.json({
      user: req.telegramUser,
      statuses: STATUSES,
      currency: config.currency,
      features: FEATURES,
    });
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
  // Sans liste d'attente, personne n'attend : rien à annoncer.
  if (!(await getSettings()).features.waitlist) return;

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

    if (changed && (await getSettings()).features.clientNotifications) {
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

/* ── Export et sauvegarde ────────────────────────────────── */

/**
 * Les commandes en tableur, une ligne par article.
 *
 * Le fichier est envoyé en pièce jointe avec un nom daté : c'est ce que le
 * comptable ouvrira dans six mois sans se demander de quand il date.
 */
adminRouter.get(
  '/export/orders.csv',
  route(async (req, res) => {
    const { csv, orders, lignes } = await ordersToCsv({
      from: req.query.from,
      to: req.query.to,
      status: req.query.status,
    });

    const jour = new Date().toISOString().slice(0, 10);
    // Le BOM force les tableurs à lire l'UTF-8 : sans lui, « Néon » devient
    // « NÃ©on » à l'ouverture, et le vendeur croit son export abîmé.
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="commandes-${jour}.csv"`);
    res.setHeader('X-Orders-Count', String(orders));
    res.setHeader('X-Lines-Count', String(lignes));
    res.send(`\ufeff${csv}`);
  })
);

adminRouter.get(
  '/backup',
  route(async (req, res) => {
    const backup = await buildBackup();
    const jour = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="boutique-${jour}.json"`);
    res.send(JSON.stringify(backup, null, 2));
  })
);

/** Ce qu'une sauvegarde contient, avant de décider de l'appliquer. */
/**
 * Les mêmes fichiers, mais envoyés dans la conversation du bot.
 *
 * C'est le chemin qui marche vraiment depuis un téléphone : la Mini App
 * demande, le fichier arrive dans le chat.
 */
adminRouter.post(
  '/export/orders/send',
  route(async (req, res) => {
    const { csv, orders, lignes } = await ordersToCsv({
      from: req.body?.from,
      to: req.body?.to,
      status: req.body?.status,
    });
    if (!orders) throw new HttpError(400, 'Aucune commande sur cette période.');

    const jour = new Date().toISOString().slice(0, 10);
    const periode = req.body?.from || req.body?.to
      ? ` (${req.body.from || '…'} → ${req.body.to || '…'})`
      : '';
    // Le BOM force les tableurs à lire l'UTF-8 : sans lui, « Néon » arrive
    // en « NÃ©on » et le vendeur croit son export abîmé.
    const envoi = await sendFileToAdmin(
      req.telegramUser.id,
      `commandes-${jour}.csv`,
      `\ufeff${csv}`,
      `📊 ${orders} commande(s), ${lignes} ligne(s)${periode}.`
    );
    res.json({ ...envoi, orders, lignes });
  })
);

adminRouter.post(
  '/backup/send',
  route(async (req, res) => {
    const backup = await buildBackup();
    const jour = new Date().toISOString().slice(0, 10);
    const envoi = await sendFileToAdmin(
      req.telegramUser.id,
      `boutique-${jour}.json`,
      JSON.stringify(backup, null, 2),
      `💾 Sauvegarde du ${jour} : ${backup.counts.products} produits, ` +
        `${backup.counts.orders} commandes, ${backup.counts.promos} codes.\n` +
        'Garde-la ailleurs que sur le serveur.'
    );
    res.json({ ...envoi, counts: backup.counts });
  })
);

adminRouter.post(
  '/backup/inspect',
  route(async (req, res) => res.json(inspectBackup(req.body)))
);

adminRouter.post(
  '/backup/restore',
  route(async (req, res) => res.json(await restoreBackup(req.body)))
);

/* ── Tableau de bord ─────────────────────────────────────── */

adminRouter.get(
  '/stats',
  route(async (req, res) => res.json(await stats()))
);
