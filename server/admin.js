import express from 'express';

import { config } from './config.js';
import { verifyInitData } from './telegram-auth.js';
import {
  HttpError,
  MEDIA_MAX,
  addProductMedia,
  setProductPhoto,
  removeProductMedia,
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
import {
  notifyCustomer, notifyBackInStock, sendFileToAdmin, diffuser, botUsername,
  deposerMedia, POIDS_MAX,
} from './bot.js';
import { waitlistKey, takeSubscribers } from './waitlist.js';
import { listPromos, savePromo, deletePromo } from './promos.js';
import { FEATURES } from './features.js';
import { buildBackup, restoreBackup, inspectBackup, ordersToCsv } from './backup.js';
import {
  destinataires, reserverEnvoi, annulerEnvoi, historique, reabonner, desabonner, estDesabonne,
} from './annonces.js';
import { productLink, shopLink } from './links.js';
import { toSvg, toPng } from './qr.js';

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
      mediaMax: MEDIA_MAX,
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

/* ── Galerie d'un produit ────────────────────────────────── */

adminRouter.post(
  '/products/:id/media',
  route(async (req, res) => {
    const { kind = 'photo', url } = req.body ?? {};
    if (!url) throw new HttpError(400, "Donne l'adresse de la photo ou de la vidéo.");
    res.json(await addProductMedia(req.params.id, { kind, url }));
  })
);

/**
 * Lit le fichier reçu en corps brut, et refuse ce qui n'a rien à faire là.
 *
 * C'est le type déclaré qui décide, jamais l'extension du nom : un exécutable
 * renommé « .jpg » ne doit pas se faire passer pour une image.
 *
 * @param {'photo'|'media'} attendu  `photo` refuse les vidéos — une vignette
 *   de catalogue ne se joue pas.
 */
function recevoirFichier(req, attendu) {
  const octets = Buffer.isBuffer(req.body) ? req.body : null;
  if (!octets?.length) throw new HttpError(400, 'Aucun fichier reçu.');

  const type = String(req.get('content-type') ?? '').toLowerCase();
  const kind = type.startsWith('video/') ? 'video' : type.startsWith('image/') ? 'photo' : null;

  if (!kind) {
    throw new HttpError(400, `Ce fichier n'est ni une image ni une vidéo (${type || 'type inconnu'}).`);
  }
  if (attendu === 'photo' && kind !== 'photo') {
    throw new HttpError(400, "L'image principale doit être une photo : une vidéo ne s'affiche pas dans la grille.");
  }

  if (octets.length > POIDS_MAX[kind]) {
    // Une décimale sur le poids réel : arrondi à l'entier, un fichier de
    // 10,3 Mo se lisait « pèse 10 Mo, pas plus de 10 » — un refus qui a
    // l'air de se contredire.
    const mo = (n, decimales = 0) => (n / 1024 / 1024).toFixed(decimales);
    throw new HttpError(
      413,
      `Ce fichier pèse ${mo(octets.length, 1)} Mo, et Telegram n'en accepte pas plus de ` +
        `${mo(POIDS_MAX[kind])} pour ${kind === 'video' ? 'une vidéo' : 'une photo'}.\n\n` +
        (kind === 'video'
          ? 'Raccourcis-la, ou baisse sa qualité avant de la renvoyer.'
          : "Réduis-la, ou envoie-la depuis l'appareil photo plutôt qu'en pleine résolution.")
    );
  }

  octets.kind = kind; // le type reconnu voyage avec les octets
  return octets;
}

/** Un nom de fichier propre : il voyage dans l'URL puis part chez Telegram. */
function nomDeFichier(brut, kind) {
  return (
    String(brut ?? '').replace(/[^\w.\- ]/g, '').slice(0, 80) ||
    `media.${kind === 'video' ? 'mp4' : 'jpg'}`
  );
}

/** Dépose le fichier chez Telegram, en traduisant les refus courants. */
async function remettreATelegram(chatId, kind, octets, nom, legende) {
  try {
    return await deposerMedia(chatId, kind, octets, nom, legende);
  } catch (err) {
    const raison = err?.description ?? err?.message ?? '';
    if (/chat not found|bot was blocked/i.test(raison)) {
      throw new HttpError(409, "Le bot ne peut pas t'écrire : ouvre sa conversation, envoie-lui /start, puis réessaie.");
    }
    throw new HttpError(502, `Telegram n'a pas pris le fichier : ${raison || 'raison inconnue'}`);
  }
}

/**
 * Reçoit un média depuis la galerie du téléphone.
 *
 * Le fichier arrive en corps brut plutôt qu'en multipart : le décoder
 * demanderait une dépendance de plus pour un seul champ, alors que le nom et
 * le type tiennent très bien dans l'URL.
 *
 * Il ne touche jamais notre disque. Il traverse le serveur, repart vers la
 * conversation du vendeur, et on ne garde que la référence que Telegram rend.
 * C'est le même principe que pour une photo envoyée au bot — la boutique n'a
 * ainsi aucun fichier à héberger ni à sauvegarder, et le vendeur retrouve son
 * original dans son fil.
 */
adminRouter.post(
  '/products/:id/media/upload',
  route(async (req, res) => {
    const produit = await getProduct(req.params.id);
    if (!produit) throw new HttpError(404, 'Produit introuvable.');

    const octets = recevoirFichier(req, 'media');

    // On refuse avant de déranger Telegram : inutile de faire voyager vingt
    // mégaoctets pour les jeter à l'arrivée.
    if ((produit.media ?? []).length >= MEDIA_MAX) {
      throw new HttpError(400, `La galerie est pleine (${MEDIA_MAX} médias au maximum).`);
    }

    const depot = await remettreATelegram(
      req.telegramUser.id,
      octets.kind,
      octets,
      nomDeFichier(req.query.nom, octets.kind),
      `📎 ${produit.name} — ajouté à la galerie depuis l'espace admin.`
    );

    res.json(await addProductMedia(req.params.id, depot));
  })
);

/**
 * Reçoit la vignette du produit depuis la galerie du téléphone.
 *
 * Même chemin que pour la galerie, une différence près : une vignette est
 * forcément une image. Une vidéo n'a rien à faire dans une grille de
 * catalogue, où rien ne se lit ni ne se joue.
 */
adminRouter.post(
  '/products/:id/image/upload',
  route(async (req, res) => {
    const produit = await getProduct(req.params.id);
    if (!produit) throw new HttpError(404, 'Produit introuvable.');

    const octets = recevoirFichier(req, 'photo');
    const nom = nomDeFichier(req.query.nom, 'photo');

    const depot = await remettreATelegram(req.telegramUser.id, 'photo', octets, nom,
      `🖼 ${produit.name} — nouvelle image principale.`);

    res.json(await setProductPhoto(req.params.id, depot.fileId));
  })
);

adminRouter.delete(
  '/products/:id/media/:index',
  route(async (req, res) => res.json(await removeProductMedia(req.params.id, req.params.index)))
);

/**
 * Réordonne la galerie.
 *
 * Le vendeur envoie l'ordre voulu ; on n'accepte qu'une permutation de ce qui
 * existe déjà. Réordonner ne doit ni ajouter, ni perdre, ni dupliquer un
 * média — sinon un glisser-déposer maladroit effacerait une vidéo.
 */
adminRouter.put(
  '/products/:id/media',
  route(async (req, res) => {
    const produit = await getProduct(req.params.id);
    if (!produit) throw new HttpError(404, 'Produit introuvable.');

    const galerie = produit.media ?? [];
    const ordre = Array.isArray(req.body?.ordre) ? req.body.ordre.map(Number) : null;
    const permutation =
      ordre &&
      ordre.length === galerie.length &&
      new Set(ordre).size === galerie.length &&
      ordre.every((i) => Number.isInteger(i) && i >= 0 && i < galerie.length);

    if (!permutation) throw new HttpError(400, "L'ordre demandé ne correspond pas à la galerie.");
    res.json(await updateProduct(req.params.id, { media: ordre.map((i) => galerie[i]) }));
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

/* ── Annonces ────────────────────────────────────────────── */

/** Qui recevrait l'annonce, avant de l'écrire. */
adminRouter.get(
  '/announcements/audience',
  route(async (req, res) => {
    const clients = await destinataires({
      depuisJours: req.query.depuisJours ? Number(req.query.depuisJours) : undefined,
      minCommandes: req.query.minCommandes ? Number(req.query.minCommandes) : 1,
    });
    res.json({ total: clients.length, apercu: clients.slice(0, 5).map((c) => c.prenom ?? `#${c.id}`) });
  })
);

adminRouter.get(
  '/announcements',
  route(async (req, res) => res.json(await historique(10)))
);

/**
 * Envoie l'annonce.
 *
 * Le créneau est réservé avant le premier message : deux appuis sur
 * « Envoyer » ne doivent pas produire deux annonces. La réponse part sans
 * attendre la fin de la diffusion — mille clients prennent une minute, et
 * l'écran d'admin n'a pas à rester bloqué pendant ce temps.
 */
adminRouter.post(
  '/announcements',
  route(async (req, res) => {
    const settings = await getSettings();
    if (!settings.features.announcements) {
      throw new HttpError(403, 'Les annonces ne sont pas activées.');
    }

    const { texte, depuisJours, minCommandes, force } = req.body ?? {};
    const clients = await destinataires({
      depuisJours: depuisJours ? Number(depuisJours) : undefined,
      minCommandes: minCommandes ? Number(minCommandes) : 1,
    });
    if (!clients.length) throw new HttpError(400, 'Personne à qui écrire avec ces critères.');

    const envoi = await reserverEnvoi({
      texte,
      cibles: clients.length,
      force: force === true,
    });

    diffuser(envoi, clients).catch(async (err) => {
      console.error('Diffusion interrompue :', err.message);
      await annulerEnvoi(envoi.id).catch(() => {});
    });

    res.status(202).json({ id: envoi.id, cibles: clients.length });
  })
);

/**
 * Sortir ou remettre un client de la liste à sa demande.
 *
 * Un client dit « ne m'écris plus » de vive voix aussi souvent que par
 * `/stop` : sans ces deux boutons, le vendeur n'aurait aucun moyen de
 * respecter ce qu'on lui a demandé en face.
 */
adminRouter.post(
  '/announcements/unsubscribe/:id',
  route(async (req, res) => res.json(await desabonner(req.params.id)))
);

adminRouter.post(
  '/announcements/resubscribe/:id',
  route(async (req, res) => res.json(await reabonner(req.params.id)))
);

adminRouter.get(
  '/announcements/subscription/:id',
  route(async (req, res) => res.json({ desabonne: await estDesabonne(req.params.id) }))
);

/**
 * Envoie un fichier dans la conversation du bot, en français quand ça rate.
 *
 * Le cas courant n'est pas une panne : c'est un vendeur qui n'a jamais écrit
 * à son propre bot, ou qui l'a bloqué. Telegram répond alors « chat not
 * found », que personne ne devrait avoir à traduire depuis un toast.
 */
async function envoyerDansLaConversation(chatId, nom, contenu, legende) {
  try {
    return await sendFileToAdmin(chatId, nom, contenu, legende);
  } catch (err) {
    const raison = err?.description ?? err?.message ?? '';
    if (/chat not found|bot was blocked|user is deactivated/i.test(raison)) {
      throw new HttpError(409, "Le bot ne peut pas t'écrire : ouvre sa conversation et envoie-lui /start, puis réessaie.");
    }
    throw new HttpError(502, `Telegram n'a pas pris le fichier : ${raison || 'raison inconnue'}`);
  }
}

/* ── Liens directs et QR codes ───────────────────────────── */

/**
 * Le lien à coller sur un flyer, et son QR code.
 *
 * Sans `?product`, c'est la boutique ; avec, c'est la fiche de l'article.
 * Le second cas est celui qui compte : un flyer annonce une variété précise,
 * et le client qui scanne doit tomber dessus, pas sur un catalogue où il
 * devra la retrouver.
 */
async function lienDemande(id) {
  const nom = await botUsername();
  if (!nom) throw new HttpError(503, "Le nom du bot est introuvable : renseigne BOT_USERNAME.");

  if (!id) return { url: shopLink(nom), cible: 'boutique', name: null, id: null };

  const product = await getProduct(id);
  if (!product) throw new HttpError(404, "Ce produit n'existe pas.");

  const url = productLink(nom, product.id);
  if (!url) throw new HttpError(400, "L'identifiant de ce produit ne tient pas dans un lien Telegram.");
  return { url, cible: 'produit', name: product.name, id: product.id, hidden: product.visible === false };
}

adminRouter.get(
  '/link',
  route(async (req, res) => {
    const lien = await lienDemande(req.query.product);
    // Le SVG part avec la réponse : l'admin l'affiche tel quel, sans second
    // appel ni image à héberger quelque part.
    res.json({ ...lien, svg: toSvg(lien.url, { module: 6, marge: 3 }) });
  })
);

/**
 * Le même QR, mais en image, dans la conversation du bot.
 *
 * C'est le seul chemin qui marche depuis un téléphone : la WebView de Telegram
 * ne laisse pas enregistrer un fichier. Envoyé par le bot, le QR se retrouve
 * dans la galerie, prêt à être glissé dans un flyer.
 */
adminRouter.post(
  '/link/send',
  route(async (req, res) => {
    const lien = await lienDemande(req.body?.product);
    const legende = lien.cible === 'produit'
      ? `🔗 ${lien.name}\n${lien.url}` +
        (lien.hidden ? '\n\n⚠️ Cet article est masqué : le lien ouvrira la boutique sans le montrer.' : '')
      : `🔗 La boutique\n${lien.url}`;

    // En document plutôt qu'en photo : Telegram recompresse les photos, et un
    // QR destiné à l'impression mérite de rester au pixel près. Le fichier
    // arrive nommé, prêt à être glissé dans un flyer.
    const envoi = await envoyerDansLaConversation(
      req.telegramUser.id,
      lien.id ? `qr-${lien.id}.png` : 'qr-boutique.png',
      toPng(lien.url, { module: 10, marge: 4 }),
      legende
    );
    res.json({ ...envoi, url: lien.url });
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
    const envoi = await envoyerDansLaConversation(
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
    const envoi = await envoyerDansLaConversation(
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
