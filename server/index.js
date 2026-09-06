import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { config, publicConfig, assertConfigured } from './config.js';
import { categories, products, findProduct, resolvePrice } from './data/products.js';
import { verifyInitData } from './telegram-auth.js';
import { createOrder, listOrders } from './orders.js';
import { bot, notifyAdmin } from './bot.js';

assertConfigured();

const webappDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'webapp');
const app = express();

app.use(express.json({ limit: '64kb' }));

// La Mini App tourne dans une WebView Telegram : ces en-têtes évitent qu'elle
// soit embarquée ailleurs et limitent ce que la page peut charger.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use(express.static(webappDir, { extensions: ['html'] }));

app.get('/api/catalog', (req, res) => {
  res.json({ shop: publicConfig, categories, products });
});

/**
 * Middleware d'authentification : chaque appel authentifié doit porter
 * l'en-tête `X-Telegram-Init-Data` signé par Telegram.
 */
function authenticate(req, res, next) {
  const result = verifyInitData(req.get('X-Telegram-Init-Data'), config.botToken);
  if (!result.ok) {
    return res.status(401).json({ error: `Authentification refusée : ${result.reason}` });
  }
  req.telegramUser = result.user;
  next();
}

app.post('/api/orders', authenticate, async (req, res) => {
  const { items, contact, note } = req.body ?? {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Panier vide.' });
  }
  if (items.length > 50) {
    return res.status(400).json({ error: 'Trop de lignes dans le panier.' });
  }

  // Les prix sont recalculés côté serveur à partir du catalogue : ceux envoyés
  // par le client sont ignorés, sinon n'importe qui commanderait à 0 €.
  const resolved = [];
  for (const item of items) {
    const product = findProduct(item.id);
    if (!product) return res.status(400).json({ error: `Produit inconnu : ${item.id}` });

    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      return res.status(400).json({ error: `Quantité invalide pour ${product.name}.` });
    }

    const variant = product.variants?.find((v) => v.id === item.variantId) ?? null;
    if (product.variants && !variant) {
      return res.status(400).json({ error: `Format invalide pour ${product.name}.` });
    }

    const unitPrice = resolvePrice(product, variant?.id);
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

  const total = resolved.reduce((sum, i) => sum + i.lineTotal, 0);

  const order = await createOrder({
    user: req.telegramUser,
    items: resolved,
    total,
    contact: typeof contact === 'string' ? contact.slice(0, 200) : null,
    note: typeof note === 'string' ? note.slice(0, 500) : null,
  });

  notifyAdmin(order).catch(() => {});

  res.status(201).json({ reference: order.reference, total: order.total, items: order.items });
});

app.get('/api/orders', authenticate, async (req, res) => {
  res.json(await listOrders({ userId: req.telegramUser.id, limit: 10 }));
});

app.listen(config.port, () => {
  console.log(`  Boutique servie sur http://localhost:${config.port}`);
  if (config.webappUrl) console.log(`  URL publique déclarée : ${config.webappUrl}`);
});

// Un token invalide ne doit pas empêcher de servir la boutique : on garde le
// site en ligne et on signale le problème plutôt que de tuer le process.
bot
  .start({ onStart: (me) => console.log(`  Bot @${me.username} démarré.`) })
  .catch((err) => {
    console.error(`  Bot non démarré (${err.message}). La boutique reste accessible.`);
  });

// Arrêt propre : sans ça, le long polling garde le process en vie.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => bot.stop());
}
