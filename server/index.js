import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { webhookCallback } from 'grammy';

import { config, publicConfig, assertConfigured } from './config.js';
import { verifyInitData } from './telegram-auth.js';
import {
  HttpError,
  getCatalog,
  getProduct,
  priceOf,
  reserveStock,
  restoreStock,
} from './catalog.js';
import { createOrder, listOrders, STATUSES } from './orders.js';
import { adminRouter } from './admin.js';
import { bot, notifyAdmin, notifyOrderPlaced } from './bot.js';
import { storageKind } from './store.js';

/** Vrai quand ce fichier est lancé directement (`npm start`), faux quand il
 *  est simplement importé — par la fonction serverless de `api/index.js`. */
const standalone =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

assertConfigured({ exit: standalone });

const webappDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'webapp');
const app = express();

// Le runtime serverless de Vercel lit le corps de la requête avant nous et
// l'expose sur `req.body` : le flux est alors épuisé (`req.readable === false`)
// et `express.json()` répondrait « stream is not readable » (HTTP 500). On
// reprend donc le corps déjà analysé et on marque la requête comme traitée.
// En local, rien de tout ça : le flux est intact, ce filtre ne fait rien.
app.use((req, res, next) => {
  if (req._body || req.readable !== false) return next();
  try {
    req.body = req.body ?? {};
  } catch {
    return res.status(400).json({ error: 'JSON invalide.' });
  }
  req._body = true;
  next();
});

app.use(express.json({ limit: '64kb' }));

// La Mini App tourne dans une WebView Telegram : ces en-têtes évitent qu'elle
// soit embarquée ailleurs et limitent ce que la page peut charger.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use(express.static(webappDir, { extensions: ['html'] }));

/* ── Santé ───────────────────────────────────────────────── */

/**
 * Vérifie d'un coup d'œil qu'un déploiement est vivant : configuration
 * complète et stockage joignable. Ne renvoie que des booléens et des
 * compteurs — jamais un token, une URL de base ni un identifiant d'admin.
 */
app.get('/api/health', async (req, res) => {
  const health = {
    ok: true,
    shop: config.shopName,
    storage: storageKind,
    config: {
      botToken: Boolean(config.botToken),
      webappUrl: Boolean(config.webappUrl),
      sellerUsername: Boolean(config.sellerUsername),
      adminIds: config.adminIds.length,
      webhookSecret: Boolean(config.webhookSecret),
    },
  };

  try {
    const { products } = await getCatalog();
    health.products = products.length;
  } catch (err) {
    health.ok = false;
    health.error = `Stockage injoignable : ${err.message}`;
    return res.status(503).json(health);
  }

  res.json(health);
});

/* ── Boutique ────────────────────────────────────────────── */

app.get('/api/catalog', async (req, res, next) => {
  try {
    const { products, categories } = await getCatalog();
    // `statuses` sert à l'écran « Mes commandes » de la Mini App : les
    // libellés et emojis de statut vivent côté serveur, une seule fois.
    res.json({ shop: publicConfig, categories, products, statuses: STATUSES });
  } catch (err) {
    next(err);
  }
});

/** Chaque appel authentifié doit porter l'en-tête signé par Telegram. */
function authenticate(req, res, next) {
  const result = verifyInitData(req.get('X-Telegram-Init-Data'), config.botToken);
  if (!result.ok) {
    return res.status(401).json({ error: `Authentification refusée : ${result.reason}` });
  }
  req.telegramUser = result.user;
  next();
}

app.post('/api/orders', authenticate, async (req, res, next) => {
  try {
    const { items, contact, note } = req.body ?? {};

    if (!Array.isArray(items) || items.length === 0) {
      throw new HttpError(400, 'Panier vide.');
    }
    if (items.length > 50) {
      throw new HttpError(400, 'Trop de lignes dans le panier.');
    }

    // Les prix sont recalculés côté serveur à partir du catalogue : ceux
    // envoyés par le client sont ignorés, sinon n'importe qui commanderait à 0 €.
    const resolved = [];
    for (const item of items) {
      const product = await getProduct(item.id, { includeHidden: false });
      if (!product) throw new HttpError(400, `Produit indisponible : ${item.id}`);

      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
        throw new HttpError(400, `Quantité invalide pour ${product.name}.`);
      }

      const variant = product.variants?.find((v) => v.id === item.variantId) ?? null;
      if (product.variants?.length && !variant) {
        throw new HttpError(400, `Format invalide pour ${product.name}.`);
      }

      const unitPrice = priceOf(product, variant?.id);
      resolved.push({
        id: product.id,
        name: product.name,
        variantId: variant?.id ?? null,
        variantLabel: variant?.label ?? null,
        unitPrice,
        quantity,
        lineTotal: unitPrice * quantity,
      });
    }

    // Réservation tout-ou-rien : deux clients ne peuvent pas emporter
    // le dernier article en même temps.
    await reserveStock(resolved);

    let order;
    try {
      order = await createOrder({
        user: req.telegramUser,
        items: resolved,
        total: resolved.reduce((sum, i) => sum + i.lineTotal, 0),
        contact: typeof contact === 'string' ? contact.slice(0, 200) : null,
        note: typeof note === 'string' ? note.slice(0, 500) : null,
      });
    } catch (err) {
      // La commande n'a pas pu être écrite : on ne garde pas le stock réservé.
      await restoreStock(resolved).catch(() => {});
      throw err;
    }

    notifyAdmin(order).catch(() => {});
    notifyOrderPlaced(order).catch((err) =>
      console.warn('Confirmation client impossible :', err.message)
    );

    res.status(201).json({ reference: order.reference, total: order.total, items: order.items });
  } catch (err) {
    next(err);
  }
});

app.get('/api/orders', authenticate, async (req, res, next) => {
  try {
    res.json(await listOrders({ userId: req.telegramUser.id, limit: 10 }));
  } catch (err) {
    next(err);
  }
});

/* ── Administration ──────────────────────────────────────── */

app.use('/api/admin', adminRouter);

/* ── Webhook Telegram ────────────────────────────────────── */

// En serverless, aucun process ne vit assez longtemps pour interroger
// Telegram en boucle : c'est Telegram qui appelle cette route. Le jeton
// secret voyage dans l'en-tête X-Telegram-Bot-Api-Secret-Token, grammY le
// vérifie et rejette tout appel qui ne vient pas de Telegram.
if (config.webhookSecret) {
  app.post('/api/telegram', webhookCallback(bot, 'express', { secretToken: config.webhookSecret }));
} else {
  app.post('/api/telegram', (req, res) =>
    res.status(503).json({ error: 'TELEGRAM_WEBHOOK_SECRET non défini.' })
  );
}

/* ── Gestion d'erreurs ───────────────────────────────────── */

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error('Erreur serveur :', err);
  res.status(500).json({ error: 'Erreur interne.' });
});

/* ── Démarrage ───────────────────────────────────────────── */

// Importé (Vercel), le module se contente d'exporter l'application : pas de
// port à écouter, pas de long polling à lancer.
export { app };
export default app;

if (standalone) {
  app.listen(config.port, () => {
    console.log(`  Boutique servie sur http://localhost:${config.port}`);
    if (config.webappUrl) console.log(`  URL publique déclarée : ${config.webappUrl}`);
    console.log(`  Stockage : ${storageKind}`);
    console.log(`  Admins autorisés : ${config.adminIds.join(', ') || 'aucun'}`);
  });

  // Un token invalide ne doit pas empêcher de servir la boutique : on garde
  // le site en ligne et on signale le problème plutôt que de tuer le process.
  bot
    .start({ onStart: (me) => console.log(`  Bot @${me.username} démarré.`) })
    .catch((err) => {
      console.error(`  Bot non démarré (${err.message}). La boutique reste accessible.`);
    });

  // Arrêt propre : sans ça, le long polling garde le process en vie.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => bot.stop());
  }
}
