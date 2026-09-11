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
import { createOrder, listOrders, slotCounts, STATUSES } from './orders.js';
import { getSettings, isBlocked } from './settings.js';
import { buildChallenge, solveChallenge, passIsValid } from './captcha.js';
import { getVerification, isApproved } from './verification.js';
import { isOpenNow, nextChange } from './opening.js';
import { servirMedia, etatDuCache } from './media-cache.js';
import { waitlistKey, subscribe, isSubscribed } from './waitlist.js';
import { bestDiscount, releasePromo } from './promos.js';
import {
  findZone, findSlot, availableSlots, slotLabel,
  normalizeAddress, adresseIncomplete, adresseEnClair,
} from './delivery.js';
import { adminRouter } from './admin.js';
import { bot, notifyAdmin, notifyOrderPlaced, notifyLowStock, configurerMenu } from './bot.js';
import { storageKind, claimDataDir } from './store.js';

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

// Une sauvegarde complète pèse bien plus que ce qu'on accepte ailleurs : ces
// deux routes ont leur propre limite, montée avant la limite générale pour
// que celle-ci ne rejette pas le corps avant d'y arriver. Le reste de l'API
// n'a aucune raison de recevoir plus de 64 Ko.
app.use(['/api/admin/backup/restore', '/api/admin/backup/inspect'], express.json({ limit: '32mb' }));

// L'envoi d'un média depuis la galerie du téléphone arrive en corps brut :
// pas de multipart, donc pas de dépendance de plus pour le décoder. Le nom et
// le type voyagent dans l'URL, le fichier est le corps. La limite couvre le
// plus gros des deux plafonds Telegram ; la route affine ensuite selon le type.
app.use(
  ['/api/admin/products/:id/media/upload', '/api/admin/products/:id/image/upload'],
  express.raw({ type: () => true, limit: '21mb' })
);
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

  // On touche chaque magasin, pas seulement le catalogue : un fichier de
  // commandes illisible laissait la boutique se déclarer en bonne santé, et
  // le vendeur ne l'apprenait qu'à la première commande perdue.
  try {
    const [{ products }, settings, commandes] = await Promise.all([
      getCatalog(),
      getSettings(),
      listOrders({ limit: 1 }),
    ]);
    health.products = products.length;
    health.open = isOpenNow(settings.opening).open;
    health.orders = Array.isArray(commandes);
    health.medias = await etatDuCache();
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
    const settings = await getSettings();
    // La Mini App a besoin de savoir quelles portes elle doit présenter.
    res.json({
      shop: publicConfig,
      categories,
      products,
      statuses: STATUSES,
      gates: {
        age: settings.features.ageGate,
        captcha: settings.captcha.enabled,
        verification: settings.verification.enabled,
      },
      // La Mini App masque ce qui est éteint ; le serveur, lui, refuse.
      features: settings.features,
      // `nextChange` alimente le bandeau qui décompte : un client qui remplit
      // son panier a besoin de savoir s'il a le temps de finir.
      opening: {
        ...isOpenNow(settings.opening),
        message: settings.opening.message,
        prochain: nextChange(settings.opening),
      },
      fulfillment: settings.fulfillment,
      // Les paliers sont publics : c'est une promesse d'affichage (« −10 %
      // dès 100 € »), pas un secret. Les codes, eux, ne sortent jamais d'ici.
      discounts: { tiers: settings.features.tiers ? settings.discounts.tiers : [] },
      // Les zones sont une information de service : le client doit savoir si
      // on descend chez lui, et à quelles conditions, avant de remplir son panier.
      zones: settings.features.zones ? settings.zones : [],
      slots: { enabled: settings.slots.enabled },
    });
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

/**
 * Traduit un panier client en lignes de commande sûres.
 *
 * Les prix sont recalculés à partir du catalogue : ceux envoyés par le client
 * sont ignorés, sinon n'importe qui commanderait à 0 €. Sert à la commande
 * comme à l'aperçu de remise, pour que les deux voient exactement le même
 * panier.
 */
async function resolveItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'Panier vide.');
  if (items.length > 50) throw new HttpError(400, 'Trop de lignes dans le panier.');

  const resolved = [];
  let units = 0;
  for (const item of items) {
    const product = await getProduct(item.id, { includeHidden: false });
    if (!product) throw new HttpError(400, `Produit indisponible : ${item.id}`);

    // `Number([2])` vaut 2 : sans ce filtre, un tableau passait pour une
    // quantité valide. On n'accepte qu'un nombre, ou la chaîne d'un nombre.
    const brut = item?.quantity;
    const quantity =
      typeof brut === 'number' || (typeof brut === 'string' && brut.trim() !== '') ? Number(brut) : NaN;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      throw new HttpError(400, `Quantité invalide pour ${product.name}.`);
    }

    const variant = product.variants?.find((v) => v.id === item.variantId) ?? null;
    if (product.variants?.length && !variant) {
      throw new HttpError(400, `Format invalide pour ${product.name}.`);
    }

    units += quantity;
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
  return { resolved, units };
}

app.post('/api/orders', authenticate, async (req, res, next) => {
  try {
    const { items, contact, address: adresseRecue, note, mode, promoCode, postalCode, slotId } = req.body ?? {};
    const settings = await getSettings();

    if (isBlocked(settings, req.telegramUser.id)) {
      throw new HttpError(403, 'Ce compte ne peut pas passer commande. Écris-nous si c\'est une erreur.');
    }

    // L'épreuve ne vaut que si elle est exigée ici : côté client seul, elle
    // ne serait qu'un décor qu'on contourne en sautant l'écran.
    if (settings.captcha.enabled && !passIsValid(req.get('X-Shop-Pass'), req.telegramUser.id)) {
      throw new HttpError(403, 'CAPTCHA_REQUIS');
    }

    // Fermée, la boutique refuse les commandes : le bandeau côté client ne
    // suffirait pas, on peut garder l'app ouverte et valider plus tard.
    if (!isOpenNow(settings.opening).open) {
      throw new HttpError(503, settings.opening.message);
    }

    if (settings.verification.enabled) {
      const verification = await getVerification(req.telegramUser.id);
      if (!isApproved(verification)) {
        throw new HttpError(403, 'VERIFICATION_REQUISE');
      }
    }

    if (!Array.isArray(items) || items.length === 0) {
      throw new HttpError(400, 'Panier vide.');
    }

    const { resolved, units } = await resolveItems(items);

    // Retrait ou livraison : le mode décide des frais et de l'adresse exigée.
    const fulfillment = settings.fulfillment;
    const chosen = mode === 'delivery' || mode === 'pickup' ? mode : fulfillment.pickup ? 'pickup' : 'delivery';
    if (!fulfillment[chosen]) {
      throw new HttpError(400, chosen === 'delivery' ? "La livraison n'est pas proposée." : "Le retrait n'est pas proposé.");
    }

    // « contact » ne porte plus que le téléphone : l'adresse arrive découpée,
    // parce qu'un livreur a besoin d'une ville et d'un code postal, pas d'une
    // ligne libre où « chez Marc » suffisait à passer.
    const telephone = typeof contact === 'string' ? contact.trim().slice(0, 200) : '';

    let adresse = null;
    if (chosen === 'delivery') {
      if (adresseRecue && typeof adresseRecue === 'object') {
        adresse = normalizeAddress(adresseRecue);
        const manque = adresseIncomplete(adresse);
        if (manque) throw new HttpError(400, manque);
      } else if (telephone.length < 5) {
        // Une Mini App restée en cache envoie encore l'adresse en une ligne :
        // on la prend telle quelle plutôt que de refuser une vraie commande.
        throw new HttpError(400, 'Indique une adresse de livraison.');
      }
    }

    // Zone de livraison : tant qu'aucune n'est déclarée, on livre partout aux
    // conditions générales. Dès qu'il y en a une, le code postal doit tomber
    // dedans — sinon la commande part vers une adresse qu'on ne dessert pas.
    // Le code postal de l'adresse fait foi : deux champs pour la même chose se
    // contrediraient un jour, et c'est celui-là que le client vient d'écrire.
    const codePostal = adresse?.postalCode || postalCode;

    let zone = null;
    if (chosen === 'delivery' && settings.features.zones && settings.zones.length) {
      zone = findZone(settings.zones, codePostal);
      if (!zone) {
        throw new HttpError(
          400,
          codePostal
            ? `On ne livre pas encore le ${String(codePostal).trim()}. Retrait sur place, ou écris-nous.`
            : 'Indique ton code postal pour la livraison.'
        );
      }
    }

    if (settings.features.limits && units > settings.limits.unitsPerOrder) {
      throw new HttpError(
        400,
        `Commande trop grosse : ${settings.limits.unitsPerOrder} articles au maximum. Contacte-nous pour une commande en gros.`
      );
    }

    // Les montants sont recalculés ici, jamais repris du client : frais de
    // livraison, franco et minimum compris.
    const subtotal = resolved.reduce((sum, i) => sum + i.lineTotal, 0);

    // Une zone lointaine peut exiger un panier plus gros et facturer plus cher
    // que la boutique : ses valeurs priment, celles laissées vides retombent
    // sur les conditions générales.
    const minimum = zone?.minimumOrder ?? fulfillment.minimumOrder;
    if (subtotal < minimum) {
      throw new HttpError(
        400,
        `Commande minimum${zone ? ` pour ${zone.name}` : ''} : ${(minimum / 100).toFixed(2)} €. ` +
          `Il manque ${((minimum - subtotal) / 100).toFixed(2)} €.`
      );
    }

    // Remise : le code saisi ou le palier automatique, le meilleur des deux.
    // Un code refusé fait échouer la commande plutôt que de passer en silence
    // au prix fort — le client l'a tapé, il doit savoir pourquoi il ne prend pas.
    // `reserve` prend la place du code dans la même opération que sa
    // vérification : contrôler puis consommer plus tard laissait huit
    // commandes simultanées emporter le même code à usage unique.
    const remise = await bestDiscount({
      code: settings.features.promos ? promoCode : null,
      subtotal,
      userId: req.telegramUser.id,
      tiers: settings.features.tiers ? settings.discounts.tiers : [],
      reserve: true,
    });

    // Minimum et franco se jugent sur le panier AVANT remise : sinon un code
    // ferait repasser la commande sous le minimum qu'elle venait d'atteindre,
    // et un franco gagné se perdrait en saisissant un code.
    const franco = zone ? zone.freeFrom ?? fulfillment.freeDeliveryFrom : fulfillment.freeDeliveryFrom;
    const francoAtteint = franco !== null && subtotal >= franco;
    const tarif = zone ? zone.fee : fulfillment.deliveryFee;
    const deliveryFee = chosen === 'delivery' && !francoAtteint ? tarif : 0;

    // Créneau : revalidé contre la liste que la boutique proposerait à cet
    // instant. Une page restée ouverte toute la nuit ne peut donc pas réserver
    // un créneau d'hier, et un créneau complet est refusé plutôt que surbooké.
    let slot = null;
    let capaciteCreneau = 0;
    if (settings.slots.enabled) {
      const options = { timezone: settings.opening.hours.timezone };
      const found = findSlot(settings.slots, slotId, options);
      if (!found) {
        throw new HttpError(400, "Choisis un créneau — celui-ci n'est plus proposé.");
      }
      // La capacité est vérifiée au moment d'écrire, pas ici : compter avant
      // laissait passer toute une rafale de commandes simultanées.
      slot = { id: found.id, date: found.date, from: found.from, to: found.to, label: slotLabel(found) };
      capaciteCreneau = found.capacity;
    }

    // Réservation tout-ou-rien : deux clients ne peuvent pas emporter
    // le dernier article en même temps.
    let remaining;
    try {
      remaining = await reserveStock(resolved);
    } catch (err) {
      // Le code était déjà pris : le rendre, sinon il reste grillé par une
      // commande qui n'a jamais existé.
      if (remise.code) await releasePromo(remise.code, req.telegramUser.id).catch(() => {});
      throw err;
    }

    let order;
    try {
      order = await createOrder({
        user: req.telegramUser,
        items: resolved,
        mode: chosen,
        subtotal,
        discount: remise.discount,
        discountLabel: remise.label,
        promoCode: remise.code,
        deliveryFee,
        total: subtotal - remise.discount + deliveryFee,
        slot,
        zone: zone ? { id: zone.id, name: zone.name, postalCode: String(codePostal).trim() } : null,
        address: adresse,
        phone: telephone || null,
        // Une ligne lisible d'un coup d'œil, pour tout ce qui affiche déjà un
        // contact : la carte de commande, l'export, le fil du client.
        contact:
          [adresse ? adresseEnClair(adresse, ' · ') : '', telephone].filter(Boolean).join(' · ') || null,
        note: typeof note === 'string' ? note.slice(0, 500) : null,
        // Ce qui se compte sur les commandes est vérifié au moment d'écrire.
        guards: {
          maxPerHour: settings.features.limits ? settings.limits.ordersPerHour : 0,
          slot: slot ? { id: slot.id, capacity: capaciteCreneau, label: slot.label } : null,
        },
      });
    } catch (err) {
      // La commande n'a pas pu être écrite : on ne garde ni le stock réservé
      // ni le code consommé.
      await restoreStock(resolved).catch(() => {});
      if (remise.code) await releasePromo(remise.code, req.telegramUser.id).catch(() => {});
      throw err;
    }

    // Le vendeur découvrait ses ruptures en lisant une commande : on prévient
    // dès que le seuil est franchi, pas au prochain coup d'œil au tableau.
    const basses = settings.features.stockAlerts
      ? remaining.filter((r) => r.left <= settings.alerts.lowStock)
      : [];
    if (basses.length) notifyLowStock(basses).catch(() => {});

    // Le vendeur est prévenu quoi qu'il arrive : c'est lui qui prépare la
    // commande. Seul le fil du client est optionnel.
    notifyAdmin(order).catch(() => {});
    if (settings.features.clientNotifications) {
      notifyOrderPlaced(order).catch((err) =>
        console.warn('Confirmation client impossible :', err.message)
      );
    }

    res.status(201).json({
      reference: order.reference,
      mode: order.mode,
      subtotal: order.subtotal,
      discount: order.discount,
      discountLabel: order.discountLabel,
      promoCode: order.promoCode,
      deliveryFee: order.deliveryFee,
      total: order.total,
      slot: order.slot,
      zone: order.zone,
      // Ce que la boutique a retenu de l'adresse : le client doit pouvoir
      // relire ce qui a été enregistré, pas seulement ce qu'il a tapé.
      address: order.address,
      phone: order.phone,
      contact: order.contact,
      items: order.items,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/orders', authenticate, async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (!settings.features.orderHistory) return res.json([]);
    res.json(await listOrders({ userId: req.telegramUser.id, limit: 10 }));
  } catch (err) {
    next(err);
  }
});

/* ── Créneaux ────────────────────────────────────────────── */

/**
 * Les créneaux encore réservables, avec les places qui restent.
 *
 * Ouverte sans authentification, comme le catalogue : c'est un horaire
 * d'ouverture, pas une donnée personnelle. Un créneau complet reste dans la
 * liste, marqué comme tel — le faire disparaître donnerait l'impression d'un
 * bug à qui l'avait vu une minute plus tôt.
 */
app.get('/api/slots', async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (!settings.slots.enabled) return res.json({ enabled: false, slots: [] });

    const counts = await slotCounts();
    const slots = availableSlots(settings.slots, {
      timezone: settings.opening.hours.timezone,
    }).map((slot) => {
      const taken = counts.get(slot.id) ?? 0;
      return {
        id: slot.id,
        date: slot.date,
        from: slot.from,
        to: slot.to,
        label: slotLabel(slot),
        left: Math.max(0, slot.capacity - taken),
        full: taken >= slot.capacity,
      };
    });

    res.json({ enabled: true, slots });
  } catch (err) {
    next(err);
  }
});

/* ── Aperçu d'une remise ─────────────────────────────────── */

/**
 * Dit au client ce que son panier coûterait avec un code, sans rien
 * consommer.
 *
 * Le calcul est refait ici avec les prix du catalogue : l'aperçu affiché dans
 * le panier ne peut donc pas mentir sur le total que la commande appliquera.
 */
app.post('/api/promo', authenticate, async (req, res, next) => {
  try {
    const { items, code } = req.body ?? {};
    const settings = await getSettings();
    if (code && !settings.features.promos) {
      throw new HttpError(400, 'Les codes promo ne sont pas actifs en ce moment.');
    }
    const { resolved } = await resolveItems(items);
    const subtotal = resolved.reduce((sum, i) => sum + i.lineTotal, 0);

    const remise = await bestDiscount({
      code,
      subtotal,
      userId: req.telegramUser.id,
      tiers: settings.features.tiers ? settings.discounts.tiers : [],
    });

    res.json({
      subtotal,
      discount: remise.discount,
      label: remise.label,
      code: remise.code,
      source: remise.source,
      total: subtotal - remise.discount,
    });
  } catch (err) {
    next(err);
  }
});

/* ── Liste d'attente sur les ruptures ────────────────────── */

app.post('/api/waitlist', authenticate, async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (!settings.features.waitlist) {
      throw new HttpError(403, "La liste d'attente n'est pas activée.");
    }

    const { id, variantId } = req.body ?? {};
    const product = await getProduct(id, { includeHidden: false });
    if (!product) throw new HttpError(400, 'Produit indisponible.');

    const variant = product.variants?.find((v) => v.id === variantId) ?? null;
    if (product.variants?.length && !variant) throw new HttpError(400, 'Format invalide.');

    // S'inscrire sur un article disponible n'aurait pas de sens : on le dit
    // plutôt que d'enregistrer une attente qui ne se déclenchera jamais.
    const available = variant ? Number(variant.stock ?? 0) : Number(product.stock ?? 0);
    if (available > 0) throw new HttpError(400, "Cet article est disponible : pas besoin d'attendre.");

    const key = waitlistKey(product.id, variant?.id ?? null);
    const count = await subscribe(key, req.telegramUser.id);
    res.status(201).json({ ok: true, waiting: count });
  } catch (err) {
    next(err);
  }
});

app.get('/api/waitlist', authenticate, async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (!settings.features.waitlist) return res.json({ subscribed: false });

    const key = waitlistKey(req.query.id, req.query.variantId || null);
    res.json({ subscribed: await isSubscribed(key, req.telegramUser.id) });
  } catch (err) {
    next(err);
  }
});

/* ── Photos de produits ──────────────────────────────────── */

/**
 * Sert la photo d'un produit depuis Telegram.
 *
 * Le catalogue ne stocke que la référence Telegram : cette route va chercher
 * le fichier, en garde une copie locale (voir `media-cache.js`) et laisse le
 * navigateur la garder à son tour. L'URL porte un paramètre de version, changé
 * à chaque nouvelle photo, ce qui permet un cache long sans jamais servir
 * l'ancienne image.
 */
app.get('/api/photo/:id', async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (!settings.features.photos) return res.status(404).json({ error: 'Photos désactivées.' });

    const product = await getProduct(req.params.id);
    if (!product?.photoFileId) return res.status(404).json({ error: 'Pas de photo pour ce produit.' });

    await servirMedia(req, res, { fileId: product.photoFileId, kind: 'photo' });
  } catch (err) {
    if (err?.code === 'ERR_STREAM_PREMATURE_CLOSE' || res.writableEnded) return;
    console.error('Photo produit indisponible :', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Photo indisponible.' });
    else next(err);
  }
});

/**
 * Sert un média de la galerie d'un produit.
 *
 * Même chemin que la photo. La vidéo se diffuse en flux plutôt qu'en un bloc —
 * charger vingt mégaoctets en mémoire avant d'envoyer le premier octet ferait
 * tousser un petit VPS et attendre le client — et les en-têtes de plage sont
 * répercutées : sans elles, impossible de se déplacer dans la vidéo, le
 * lecteur ne sait que la rejouer depuis le début.
 */
/**
 * Sert la vignette d'une vidéo : la petite image que Telegram fabrique pour
 * elle, affichée en `poster` le temps que la vidéo arrive.
 *
 * Quelques kilo-octets contre quelques mégaoctets : c'est ce qui fait la
 * différence entre une carte vide et une carte qui montre tout de suite ce
 * qu'elle a à montrer.
 */
app.get('/api/media/:id/:index/apercu', async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (!settings.features.photos) return res.status(404).json({ error: 'Médias désactivés.' });

    const product = await getProduct(req.params.id);
    const media = product?.media?.[Number(req.params.index)];
    if (!media?.thumbFileId) return res.status(404).json({ error: 'Pas de vignette pour ce média.' });

    await servirMedia(req, res, { fileId: media.thumbFileId, kind: 'photo' });
  } catch (err) {
    if (err?.code === 'ERR_STREAM_PREMATURE_CLOSE' || res.writableEnded) return;
    console.error('Vignette de média indisponible :', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Vignette indisponible.' });
    else next(err);
  }
});

app.get('/api/media/:id/:index', async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (!settings.features.photos) return res.status(404).json({ error: 'Médias désactivés.' });

    const product = await getProduct(req.params.id);
    const media = product?.media?.[Number(req.params.index)];
    if (!media) return res.status(404).json({ error: 'Média introuvable.' });

    // Un média hébergé ailleurs n'a pas à passer par nous.
    if (!media.fileId) return res.redirect(302, media.url);

    await servirMedia(req, res, media);
  } catch (err) {
    // Une coupure du client en pleine vidéo est normale : ce n'est pas un
    // incident à consigner, et la réponse est déjà partie.
    if (err?.code === 'ERR_STREAM_PREMATURE_CLOSE' || res.writableEnded) return;
    console.error('Média produit indisponible :', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Média indisponible.' });
    else next(err);
  }
});

/* ── Ce que le client a le droit de savoir sur lui-même ──── */

app.get('/api/me', authenticate, async (req, res, next) => {
  try {
    const settings = await getSettings();
    const verification = await getVerification(req.telegramUser.id);
    res.json({
      id: req.telegramUser.id,
      blocked: isBlocked(settings, req.telegramUser.id),
      verification: {
        required: settings.verification.enabled,
        status: verification.status,
        requestedAt: verification.requestedAt ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
});

/* ── Épreuve d'entrée ────────────────────────────────────── */

app.get('/api/captcha', authenticate, async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (!settings.captcha.enabled) return res.json({ required: false });
    res.json({ required: true, ...buildChallenge(req.telegramUser.id) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/captcha', authenticate, async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (!settings.captcha.enabled) return res.json({ ok: true, pass: null });

    const result = solveChallenge(req.telegramUser.id, req.body ?? {});
    if (!result.ok) return res.status(400).json({ error: result.reason });
    res.json({ ok: true, pass: result.pass });
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
//
// Les deux modes de réception s'excluent, et grammY le fait respecter
// durement : `webhookCallback()` remplace `bot.start` par une fonction qui
// lève une erreur — dès l'appel, sans attendre la moindre requête. Monter
// cette route sur un VPS suffisait donc à empêcher le long polling de
// démarrer : le bot restait muet et seule une ligne de journal le disait,
// alors que la boutique, elle, continuait de servir. C'est le mode de
// lancement qui décide, donc, et non la présence d'un secret dans l'environnement.
if (!standalone && config.webhookSecret) {
  app.post('/api/telegram', webhookCallback(bot, 'express', { secretToken: config.webhookSecret }));
} else {
  const pourquoi = standalone
    ? 'Cette boutique reçoit les mises à jour en long polling : le webhook n\'est pas servi ici.'
    : 'TELEGRAM_WEBHOOK_SECRET non défini.';
  app.post('/api/telegram', (req, res) => res.status(503).json({ error: pourquoi }));
}

/* ── Gestion d'erreurs ───────────────────────────────────── */

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });

  // Corps illisible ou trop gros : c'est la requête qui est fautive, pas le
  // serveur. Sans ce cas, `express.json()` remontait ici et tout devenait un
  // 500 — le client lisait « erreur interne » pour un JSON mal fermé, et
  // chaque requête malformée écrivait une trace d'incident dans les journaux.
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Requête trop volumineuse.' });
  }
  if (err instanceof SyntaxError || err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON invalide.' });
  }
  // Tout ce qui porte déjà un statut de requête le garde : le perdre
  // transformerait un refus explicite en panne.
  if (Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.expose ? err.message : 'Requête refusée.' });
  }

  // Une panne de stockage n'est pas un bogue : c'est une installation à
  // corriger, et son message dit comment. Le taire derrière « Erreur
  // interne » oblige le vendeur à aller lire les journaux — quand il sait
  // qu'ils existent.
  if (err.fichier || ['EACCES', 'EPERM', 'EROFS', 'ENOSPC'].includes(err.code)) {
    console.error('Stockage inaccessible :', err.message);
    return res.status(503).json({
      error: `Les données de la boutique sont inaccessibles.\n\n${err.message}`,
    });
  }

  console.error('Erreur serveur :', err);
  res.status(500).json({ error: 'Erreur interne.' });
});

/* ── Démarrage ───────────────────────────────────────────── */

// Importé (Vercel), le module se contente d'exporter l'application : pas de
// port à écouter, pas de long polling à lancer.
export { app };
export default app;

if (standalone) {
  // Le magasin fichier n'appartient qu'à un processus : deux instances sur le
  // même dossier s'effacent l'une l'autre, sans le moindre message.
  try {
    claimDataDir?.();
  } catch (err) {
    console.error(`\n  ${err.message}\n`);
    process.exit(1);
  }

  // Une base injoignable ne se découvre pas requête par requête : on le dit
  // au lancement, là où le vendeur regarde quand il installe.
  if (config.databaseUrl) {
    getCatalog()
      .then((c) => console.log(`  Base de données joignable (${c.products.length} produits).`))
      .catch((err) => {
        console.error(`\n  ⚠ La base de données ne répond pas — la boutique ne pourra rien servir.\n`);
        console.error(`  ${err.message}\n`);
      });
  }

  app.listen(config.port, config.host, () => {
    console.log(`  Boutique servie sur http://${config.host}:${config.port}`);
    if (config.webappUrl) console.log(`  URL publique déclarée : ${config.webappUrl}`);
    console.log(`  Stockage : ${storageKind}`);
    console.log(`  Admins autorisés : ${config.adminIds.join(', ') || 'aucun'}`);
    // Une boutique sans administrateur se gère depuis nulle part : ni produits,
    // ni stocks, ni commandes. Autant le dire au démarrage plutôt que de le
    // laisser découvrir par un /admin qui refuse.
    if (config.adminIds.length === 0) {
      console.warn('  ⚠ Aucun administrateur : /admin refusera tout le monde et rien ne sera gérable.');
      console.warn('    Renseigne ADMIN_IDS dans .env (envoie /start au bot pour connaître ton identifiant).');
    }
  });

  // Un secret de webhook traînant dans l'environnement n'empêche plus rien,
  // mais il trahit presque toujours une configuration copiée d'un déploiement
  // serverless : autant le dire, sinon on cherchera longtemps pourquoi le
  // webhook n'est pas servi.
  if (config.webhookSecret) {
    console.log('  TELEGRAM_WEBHOOK_SECRET est défini mais ignoré : ce mode lit en long polling.');
  }

  // Un token invalide ne doit pas empêcher de servir la boutique : on garde
  // le site en ligne et on signale le problème plutôt que de tuer le process.
  //
  // Le `try` n'est pas décoratif : `bot.start` peut lever de façon synchrone,
  // et un `.catch()` seul ne rattrape pas ça. Le process mourait alors au
  // démarrage — donc, sous systemd et son `Restart=always`, redémarrait en
  // boucle toutes les cinq secondes, boutique comprise. Une panne de bot ne
  // doit jamais coûter la boutique.
  const signaler = (err) => {
    console.error(`  Bot non démarré (${err.message}). La boutique reste accessible.`);
    // Le 409 a une cause précise et un remède d'une ligne : le nommer ici
    // épargne une heure de recherche à qui voit son bot rester muet.
    if (/409|conflict/i.test(err.message)) {
      console.error('  Un webhook est déclaré chez Telegram : il capte les mises à jour à la place du long polling.');
      console.error('  Remède : node tools/set-webhook.mjs --delete, puis redémarre la boutique.');
    }
  };

  try {
    bot
      .start({
        onStart: (me) => {
          console.log(`  Bot @${me.username} démarré.`);
          // Le bouton en bas à gauche du chat ouvre la boutique. On le
          // (re)pose au démarrage pour qu'il suive toujours WEBAPP_URL, et on
          // ne meurt pas si Telegram refuse : c'est un confort, pas la boutique.
          configurerMenu()
            .then((m) =>
              console.log(
                m.type === 'web_app'
                  ? '  Bouton de menu : ouvre la boutique.'
                  : '  Bouton de menu : par défaut (WEBAPP_URL absente ou non HTTPS).'
              )
            )
            .catch((err) => console.warn(`  Bouton de menu non réglé : ${err.message}`));
        },
      })
      .catch(signaler);
  } catch (err) {
    signaler(err);
  }

  // Arrêt propre : sans ça, le long polling garde le process en vie.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => bot.stop());
  }
}
