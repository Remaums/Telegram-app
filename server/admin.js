import express from 'express';

import { config } from './config.js';
import { verifyInitData } from './telegram-auth.js';
import {
  HttpError,
  MEDIA_MAX,
  addProductMedia,
  setProductPhoto,
  setProductMediaThumb,
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
import {
  STATUSES, listOrders, allOrders, getOrder, setStatus, stats, purgerCommandes,
} from './orders.js';
import { bilan } from './bilan.js';
import { ficheClients, chercherClients } from './clients.js';
import { listUsers, countUsers, chercherUtilisateurs } from './users.js';
import { servirMedia } from './media-cache.js';
import { getSettings, saveSettings, blockClient, unblockClient } from './settings.js';
import { listVerifications, decideVerification, resetVerification } from './verification.js';
import {
  notifyCustomer, notifyBackInStock, sendFileToAdmin, diffuser, botUsername,
  deposerMedia, retrouverVignette, ficheTelegram, ecrireAuClient, proposerAnnonce, POIDS_MAX,
} from './bot.js';
import { refusDeTelegram, texteValide } from './messagerie.js';
import { estAdmin, listerAdmins } from './admins.js';
import {
  tousLesAvis, resumeParProduit, changerStatut, repondreALAvis, supprimerAvis, oublierProduit,
} from './avis.js';
import { CANAUX, toutesLesPreferences, compterParCanal } from './preferences.js';
import { visitesDesClients, FENETRE_MS, MEMOIRE_MS } from './presence.js';
import { ficheDuRegistre } from './users.js';
import {
  compterParProduit, oublierProduit as oublierFavoris, amateursDuProduit,
} from './favoris.js';
import { waitlistKey, takeSubscribers } from './waitlist.js';
import { listeDesabonnes } from './annonces.js';
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
 * N'ouvre l'espace admin qu'aux administrateurs déclarés.
 *
 * Deux sources : le `.env` du serveur, et ceux que le propriétaire a ajoutés
 * depuis le bot avec /addadmin. La signature Telegram est revérifiée à chaque
 * appel : le client ne peut pas se déclarer admin, c'est l'identifiant contenu
 * dans le `initData` signé qui décide.
 *
 * La lecture est asynchrone, et l'erreur est attrapée ici : une exception dans
 * un middleware async n'est pas rattrapée par Express, elle laisserait la
 * requête sans réponse — un écran d'admin bloqué sur « chargement » pour une
 * base momentanément injoignable.
 */
export async function requireAdmin(req, res, next) {
  const result = verifyInitData(req.get('X-Telegram-Init-Data'), config.botToken);
  if (!result.ok) {
    return res.status(401).json({ error: `Authentification refusée : ${result.reason}` });
  }
  try {
    if (!(await estAdmin(result.user.id))) {
      return res.status(403).json({ error: "Cet accès est réservé à l'administrateur." });
    }
  } catch (err) {
    return next(err);
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

/**
 * Le bilan de la période : ce que les commandes disent quand on les regroupe.
 *
 * Le fuseau de la boutique est passé au calcul, pas celui du serveur : un VPS
 * réglé sur UTC couperait ses journées à deux heures du matin, en plein milieu
 * du coup de feu du samedi soir.
 */
adminRouter.get(
  '/bilan',
  route(async (req, res) => {
    const settings = await getSettings();
    res.json(
      bilan(await allOrders(), {
        jours: Number(req.query.jours) || 30,
        timezone: settings.opening?.hours?.timezone,
      })
    );
  })
);

/* ── Clients ─────────────────────────────────────────────── */

/**
 * Les fiches clients, reconstituées à partir des commandes.
 *
 * Rien n'est collecté pour cette page : elle regroupe ce qui est déjà là. Ce
 * qu'on ne garde pas ne peut ni fuir, ni être saisi, ni servir contre
 * quelqu'un — et un fichier client est précisément ce qu'on ne veut pas tenir.
 */
async function toutesLesFiches() {
  const [commandes, settings, verifications, desabonnes, vus] = await Promise.all([
    allOrders(),
    getSettings(),
    listVerifications(),
    listeDesabonnes(),
    // Le registre du bot complète les commandes : depuis quand ce client connaît
    // la boutique, et combien de fois il l'a ouverte sans rien prendre.
    listUsers(),
  ]);
  return ficheClients(commandes, {
    bloques: settings.blocked ?? [],
    verifications: Object.fromEntries(verifications.map((v) => [String(v.id), v])),
    desabonnes,
    vus,
    // Le fuseau de la boutique, pas celui du serveur : une commande de minuit
    // trente à Mulhouse est une commande du vendredi soir.
    timezone: settings.opening?.hours?.timezone ?? 'Europe/Paris',
  });
}

adminRouter.get(
  '/clients',
  route(async (req, res) => {
    const fiches = chercherClients(await toutesLesFiches(), req.query.q ?? '');
    // Une boutique qui tourne depuis deux ans a des milliers de fiches : on
    // n'envoie pas tout à un téléphone, la recherche est là pour ça.
    res.json({ total: fiches.length, clients: fiches.slice(0, 200) });
  })
);

adminRouter.get(
  '/clients/:id',
  route(async (req, res) => {
    const fiche = (await toutesLesFiches()).find((f) => f.id === String(req.params.id));
    if (!fiche) throw new HttpError(404, 'Ce client n\'a jamais commandé ici.');
    res.json(fiche);
  })
);

/**
 * La fiche que Telegram veut bien donner d'un client.
 *
 * À la demande, jamais en masse : c'est un appel à Telegram par client, et
 * personne n'a besoin de la biographie de trois cents personnes pour préparer
 * une commande. Telegram ne répond que pour quelqu'un qui a déjà parlé au bot.
 */
adminRouter.get(
  '/clients/:id/telegram',
  route(async (req, res) => {
    try {
      res.json(await ficheTelegram(req.params.id));
    } catch (err) {
      const raison = err?.description ?? err?.message ?? '';
      if (/chat not found/i.test(raison)) {
        throw new HttpError(404, "Telegram ne connaît pas ce compte : il n'a jamais écrit au bot.");
      }
      throw new HttpError(502, `Telegram n'a pas répondu : ${raison || 'raison inconnue'}`);
    }
  })
);

/**
 * La photo de profil d'un client, servie comme un média produit.
 *
 * Elle reste chez Telegram : on ne fait que relayer, avec la même copie locale
 * que le reste. Un visage n'a pas à être recopié dans le dossier de la
 * boutique pour être affiché une fois.
 */
adminRouter.get(
  '/clients/:id/photo',
  route(async (req, res) => {
    const fiche = await ficheTelegram(req.params.id).catch(() => null);
    if (!fiche?.photo) throw new HttpError(404, 'Pas de photo de profil.');
    await servirMedia(req, res, { fileId: fiche.photo, kind: 'photo' });
  })
);

/**
 * Écrire à un client, par le bot.
 *
 * C'est la réponse à « j'ai son identifiant mais pas son @ » : un identifiant
 * numérique ne se contacte pas depuis un compte personnel, alors que le bot a
 * déjà une conversation ouverte avec ce client. La route sert aussi bien l'onglet
 * Clients que l'onglet Utilisateurs — un curieux qui n'a jamais commandé se
 * joint de la même façon.
 *
 * Rien n'est conservé de l'échange : le message part, le bot en garde la trace
 * dans la conversation, la boutique n'en tient pas de registre.
 */
adminRouter.post(
  '/clients/:id/message',
  route(async (req, res) => {
    const { texte, erreur } = texteValide(req.body?.texte);
    if (erreur) throw new HttpError(400, erreur);

    if (!/^\d+$/.test(String(req.params.id))) {
      throw new HttpError(400, 'Identifiant Telegram invalide.');
    }

    try {
      const envoi = await ecrireAuClient(req.params.id, texte);
      res.json({ ok: true, ...envoi });
    } catch (err) {
      // Le refus de Telegram est une information, pas une panne : « ce client a
      // bloqué le bot » se lit et se comprend, là où un 500 n'apprend rien.
      throw new HttpError(409, refusDeTelegram(err));
    }
  })
);

/**
 * Qui a les clés de la boutique.
 *
 * En lecture seule ici : donner ou reprendre des accès se fait depuis la
 * conversation du bot, où l'ajout passe par une confirmation explicite et où
 * l'intéressé est prévenu. Un bouton dans un écran d'admin n'offrirait ni
 * l'un ni l'autre.
 */
adminRouter.get(
  '/admins',
  route(async (req, res) => res.json(await listerAdmins()))
);

/**
 * Qui accepte quoi, et ce qui est mis en favori.
 *
 * Deux chiffres que rien d'autre ne donne : combien de clients on peut encore
 * prévenir sur chaque canal, et quels articles sont attendus sans être achetés.
 * Un produit très mis en favori et peu vendu est un problème de prix ou de
 * stock, pas de goût — et c'est la seule page qui le montre.
 */
adminRouter.get(
  '/audience',
  route(async (req, res) => {
    const [clients, { products }, favoris] = await Promise.all([
      destinataires({ minCommandes: 1 }),
      getCatalog(),
      compterParProduit(),
    ]);

    const nomDu = new Map(products.map((p) => [p.id, p.name]));
    res.json({
      canaux: CANAUX,
      joignables: clients.length,
      parCanal: await compterParCanal(clients),
      preferences: await toutesLesPreferences(),
      favoris: Object.entries(favoris)
        .map(([id, nombre]) => ({ id, nom: nomDu.get(id) ?? id, nombre }))
        .sort((a, b) => b.nombre - a.nombre),
    });
  })
);

/** Qui attend ce produit : de quoi décider d'un réassort. */
adminRouter.get(
  '/products/:id/favoris',
  route(async (req, res) => res.json({ amateurs: await amateursDuProduit(req.params.id) }))
);

/**
 * Qui est dans la boutique en ce moment.
 *
 * Ce n'est pas le « en ligne » de Telegram — un bot n'y a pas accès, et
 * prétendre le contraire ferait chercher une panne le jour où un client
 * « hors ligne » passe commande. C'est ce qui se passe chez nous : un message
 * reçu, une boutique ouverte, un panier rempli dans les dernières minutes.
 *
 * Volontairement léger : cette route est appelée toutes les quinze secondes
 * tant qu'un écran d'administration est ouvert. Elle ne touche donc aucun
 * magasin sauf pour nommer les présents, et il n'y en a jamais beaucoup.
 */
adminRouter.get(
  '/presence',
  route(async (req, res) => {
    // Les administrateurs ne se comptent pas eux-mêmes : « 1 actif » alors
    // qu'on est seul dans sa boutique est une fausse joie, pas une information.
    const patrons = (await listerAdmins()).map((a) => a.id);

    // Une seule lecture, sur la fenêtre large : « là maintenant » n'est qu'un
    // sous-ensemble de « passé récemment », et le distinguer ici évite de
    // parcourir deux fois la même mémoire.
    const passages = visitesDesClients(patrons);

    const nommes = await Promise.all(
      passages.map(async (p) => {
        const fiche = await ficheDuRegistre(p.id).catch(() => null);
        return {
          ...p,
          prenom: fiche?.prenom ?? null,
          username: fiche?.username ?? null,
        };
      })
    );

    res.json({
      // Ceux qui sont encore là : c'est la pastille verte et le pouls.
      actifs: nommes.filter((p) => p.actif),
      total: nommes.filter((p) => p.actif).length,
      // Et la traîne : qui est passé dans la demi-heure, encore là ou non.
      // C'est elle qui permet de lire la boutique plutôt qu'un instantané.
      visites: nommes,
      visitesTotal: nommes.length,
      // Les deux fenêtres voyagent avec la réponse : l'écran ne doit pas
      // recopier des constantes qui vivent côté serveur.
      fenetreSecondes: Math.round(FENETRE_MS / 1000),
      memoireSecondes: Math.round(MEMOIRE_MS / 1000),
    });
  })
);

/* ── Avis ────────────────────────────────────────────────── */

/**
 * Tous les avis, du plus récent au plus ancien, avec le nom du produit.
 *
 * Les masqués sont dans la liste, marqués comme tels : une modération qui cache
 * ce qu'elle a caché n'est plus une modération, c'est un oubli.
 */
adminRouter.get(
  '/avis',
  route(async (req, res) => {
    const [avis, { products }] = await Promise.all([tousLesAvis(), getCatalog()]);
    const nomDu = new Map(products.map((p) => [p.id, p.name]));

    const liste = avis
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((a) => ({ ...a, produit: nomDu.get(a.productId) ?? a.productId }));

    const resume = resumeParProduit(avis);
    const notes = Object.values(resume);
    res.json({
      avis: liste.slice(0, 300),
      total: liste.length,
      masques: liste.filter((a) => a.statut === 'masque').length,
      sansReponse: liste.filter((a) => a.note <= 2 && !a.reponse).length,
      // La moyenne de la boutique se calcule sur les avis, pas sur la moyenne
      // des moyennes : un produit avec un seul avis pèserait autant qu'un
      // produit qui en a cent.
      moyenne: notes.length
        ? Math.round(
            (avis.filter((a) => a.statut !== 'masque').reduce((somme, a) => somme + a.note, 0) /
              Math.max(1, avis.filter((a) => a.statut !== 'masque').length)) * 10
          ) / 10
        : null,
      parProduit: Object.entries(resume)
        .map(([id, r]) => ({ id, nom: nomDu.get(id) ?? id, ...r }))
        .sort((a, b) => b.nombre - a.nombre),
    });
  })
);

adminRouter.post(
  '/avis/:id/statut',
  route(async (req, res) => res.json(await changerStatut(req.params.id, req.body?.statut)))
);

adminRouter.post(
  '/avis/:id/reponse',
  route(async (req, res) => res.json(await repondreALAvis(req.params.id, req.body?.texte)))
);

adminRouter.delete(
  '/avis/:id',
  route(async (req, res) => {
    await supprimerAvis(req.params.id);
    res.status(204).end();
  })
);

/* ── Utilisateurs ────────────────────────────────────────── */

/**
 * Tous ceux qui ont déjà ouvert le bot — pas seulement ceux qui ont commandé.
 *
 * Le registre (users.js) sait qui a touché le bot ; on croise avec ce que la
 * boutique sait déjà de chacun : a-t-il commandé, est-il bloqué, vérifié,
 * abonné aux annonces. C'est ce croisement qui rend la page utile — voir d'un
 * coup combien de curieux repartent sans commander, et pouvoir bloquer
 * quelqu'un qui traîne sans jamais rien prendre.
 */
async function tousLesUtilisateurs() {
  const [fiches, commandes, settings, verifications, desabonnes] = await Promise.all([
    listUsers(),
    allOrders(),
    getSettings(),
    listVerifications(),
    listeDesabonnes(),
  ]);

  const bloques = new Set((settings.blocked ?? []).map(String));
  const desab = new Set(desabonnes.map(String));
  const verifs = new Map(verifications.map((v) => [String(v.id), v.status]));

  // Combien de commandes par personne, en une passe : recompter par fiche
  // relirait tout l'historique autant de fois qu'il y a de visiteurs.
  const commandesPar = new Map();
  for (const o of commandes) {
    const id = String(o.user?.id ?? '');
    if (!id || o.status === 'annulee') continue;
    commandesPar.set(id, (commandesPar.get(id) ?? 0) + 1);
  }

  return fiches.map((u) => ({
    ...u,
    commandes: commandesPar.get(u.id) ?? 0,
    aCommande: commandesPar.has(u.id),
    bloque: bloques.has(u.id),
    verification: verifs.get(u.id) ?? 'none',
    abonne: !desab.has(u.id),
  }));
}

adminRouter.get(
  '/users',
  route(async (req, res) => {
    const [tous, total] = await Promise.all([tousLesUtilisateurs(), countUsers()]);
    const filtres = chercherUtilisateurs(tous, req.query.q ?? '');
    // Deux nombres qui parlent d'eux-mêmes : combien de visiteurs en tout, et
    // combien ont fini par commander. Le reste, c'est la marge de progression.
    res.json({
      total,
      acheteurs: tous.filter((u) => u.aCommande).length,
      montres: filtres.length,
      users: filtres.slice(0, 300),
    });
  })
);

adminRouter.get(
  '/catalog',
  route(async (req, res) => res.json(await getCatalog({ includeHidden: true })))
);

adminRouter.post(
  '/products',
  route(async (req, res) => {
    const produit = await createProduct(req.body ?? {});
    res.status(201).json(produit);

    // La proposition part après la réponse : l'écran d'admin ne doit pas
    // attendre Telegram pour afficher le produit qu'il vient de créer. Et un
    // brouillon masqué ne s'annonce pas — c'est justement un produit qu'on
    // prépare.
    if (!produit.hidden) {
      proposerAnnonce('nouveautes', {
        titre: `🆕 Nouveau produit : ${produit.name}`,
        texte:
          `🆕 ${produit.name}\n\n` +
          (produit.short ? `${produit.short}\n\n` : '') +
          `À partir de ${(prixMini(produit) / 100).toFixed(2)} €\n\n` +
          'Dispo dans la boutique.',
      }).catch(() => {});
    }
  })
);

/** Le prix d'entrée d'un produit : celui qu'on annonce. */
function prixMini(produit) {
  const variantes = produit.variants ?? [];
  return variantes.length ? Math.min(...variantes.map((v) => v.price)) : produit.price ?? 0;
}

adminRouter.patch(
  '/products/:id',
  route(async (req, res) => res.json(await updateProduct(req.params.id, req.body ?? {})))
);

adminRouter.delete(
  '/products/:id',
  route(async (req, res) => {
    await deleteProduct(req.params.id);
    // Les avis d'un produit supprimé ne mènent plus nulle part : ils pèseraient
    // encore sur la moyenne d'un article que plus personne ne peut acheter. Et
    // un favori vers un produit effacé est une carte vide dans le profil de
    // quelqu'un, qu'il ne saurait ni ouvrir ni retirer.
    await Promise.all([
      oublierProduit(req.params.id).catch(() => {}),
      oublierFavoris(req.params.id).catch(() => {}),
    ]);
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

/**
 * Retrouve la vignette d'une vidéo ajoutée avant qu'on ne pense à la garder.
 *
 * Sans elle, la carte reste vide le temps que la vidéo arrive — quelques
 * secondes sur un téléphone en 4G. Telegram ne la donne que dans le message
 * qui porte la vidéo : on la lui renvoie donc, sans notification et sans
 * retéléverser un octet, et le message est effacé aussitôt.
 */
adminRouter.post(
  '/products/:id/media/:index/apercu',
  route(async (req, res) => {
    const produit = await getProduct(req.params.id);
    if (!produit) throw new HttpError(404, 'Produit introuvable.');

    const media = produit.media?.[Number(req.params.index)];
    if (!media) throw new HttpError(400, "Ce média n'existe pas.");
    if (media.kind !== 'video') throw new HttpError(400, "Une photo n'a pas besoin d'aperçu.");
    if (!media.fileId) {
      throw new HttpError(400, "Cette vidéo est hébergée ailleurs : son aperçu ne dépend pas de nous.");
    }

    let vignette;
    try {
      vignette = await retrouverVignette(req.telegramUser.id, media.fileId);
    } catch (err) {
      const raison = err?.description ?? err?.message ?? '';
      if (/chat not found|bot was blocked/i.test(raison)) {
        throw new HttpError(409, "Le bot ne peut pas t'écrire : ouvre sa conversation, envoie-lui /start, puis réessaie.");
      }
      throw new HttpError(502, `Telegram n'a pas rendu l'aperçu : ${raison || 'raison inconnue'}`);
    }
    if (!vignette) {
      throw new HttpError(502, "Telegram n'a pas fabriqué d'aperçu pour cette vidéo. Renvoie-la depuis ta galerie.");
    }

    res.json(await setProductMediaThumb(req.params.id, req.params.index, vignette));
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

/**
 * Rattache un média à un format, ou l'en détache.
 *
 * C'est ce lien qui fait qu'une fiche à trois variétés montre la bonne photo
 * quand le client choisit la sienne. Sans lui, une galerie de cinq photos
 * oblige à deviner laquelle correspond au format sélectionné — et autant vendre
 * sans photo.
 */
adminRouter.put(
  '/products/:id/media/:index/format',
  route(async (req, res) => {
    const produit = await getProduct(req.params.id);
    if (!produit) throw new HttpError(404, 'Produit introuvable.');

    const rang = Number(req.params.index);
    const galerie = produit.media ?? [];
    if (!Number.isInteger(rang) || rang < 0 || rang >= galerie.length) {
      throw new HttpError(404, 'Média introuvable.');
    }

    // Chaîne vide : on détache. C'est le geste inverse, et il doit passer par
    // la même route — deux routes pour poser et retirer un lien finissent
    // toujours par diverger.
    const demande = String(req.body?.variantId ?? '').trim();
    if (demande && !(produit.variants ?? []).some((v) => v.id === demande)) {
      throw new HttpError(400, "Ce format n'existe pas sur ce produit.");
    }

    const media = galerie.map((m, i) => {
      if (i !== rang) return m;
      const copie = { ...m };
      if (demande) copie.variantId = demande;
      else delete copie.variantId;
      return copie;
    });

    res.json(await updateProduct(req.params.id, { media }));
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
    const avant = (await listPromos()).map((p) => p.code);
    await savePromo(req.body ?? {});
    // On renvoie la liste entière : l'écran admin se réaffiche d'un bloc,
    // sans avoir à deviner où insérer la ligne créée ou modifiée.
    const apres = await listPromos();
    res.json(apres);

    // Seulement à la création : modifier la date de fin d'un code existant
    // n'est pas une nouvelle à annoncer, et le ferait annoncer deux fois.
    const code = String(req.body?.code ?? '').trim().toUpperCase();
    const neuf = apres.find((p) => p.code === code);
    if (neuf && neuf.active && !avant.includes(code)) {
      proposerAnnonce('promos', {
        titre: `🎁 Nouveau code promo : ${code}`,
        texte:
          `🎁 Code ${code}\n\n${remiseEnClair(neuf)}\n\n` +
          (neuf.expiresAt ? `Jusqu'au ${new Date(neuf.expiresAt).toLocaleDateString('fr-FR')}.\n\n` : '') +
          'À saisir dans le panier.',
      }).catch(() => {});
    }
  })
);

/** « −10 % » ou « −5 € », selon la forme de la remise. */
function remiseEnClair(promo) {
  const remise = promo.type === 'amount'
    ? `−${(promo.value / 100).toFixed(2)} €`
    : `−${promo.value} %`;
  // Le minimum de panier fait partie de l'offre : l'annoncer sans lui prépare
  // une déception au moment de valider.
  return promo.minSubtotal
    ? `${remise} dès ${(promo.minSubtotal / 100).toFixed(2)} € d'achat`
    : `${remise} sur ta commande`;
}

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

/**
 * Effacer des commandes, ou leur faire oublier qui les a passées.
 *
 * L'opération ne se rattrape pas : c'est pour ça qu'une sauvegarde part dans
 * la conversation du vendeur **avant** de toucher au magasin, et que
 * l'effacement est refusé si elle n'a pas pu partir. Un « ça n'a pas marché »
 * après un effacement réussi n'est plus une erreur, c'est une perte.
 *
 * Le mot de confirmation est demandé côté serveur aussi : une interface peut
 * être contournée, une commande curl part sans écran de confirmation.
 */
adminRouter.post(
  '/orders/purge',
  route(async (req, res) => {
    const { mode, avant, confirmation, sauvegarde = true } = req.body ?? {};

    if (String(confirmation).trim().toUpperCase() !== 'EFFACER') {
      throw new HttpError(400, 'Écris EFFACER pour confirmer : cette opération ne se rattrape pas.');
    }

    let envoi = null;
    if (sauvegarde !== false) {
      const copie = await buildBackup();
      const jour = new Date().toISOString().slice(0, 10);
      try {
        envoi = await envoyerDansLaConversation(
          req.telegramUser.id,
          `avant-effacement-${jour}.json`,
          JSON.stringify(copie, null, 2),
          `💾 Sauvegarde prise avant effacement : ${copie.counts.orders} commandes.\n` +
            "Garde ce fichier : c'est le seul retour en arrière possible."
        );
      } catch (err) {
        throw new HttpError(
          409,
          "La sauvegarde n'a pas pu partir dans ta conversation, donc rien n'a été effacé.\n\n" +
            `Raison : ${err?.description ?? err.message}\n\n` +
            'Ouvre la conversation du bot, envoie-lui /start, puis recommence. ' +
            "Tu peux aussi décocher la sauvegarde — mais alors il n'y aura pas de retour en arrière."
        );
      }
    }

    const fait = await purgerCommandes({ mode, avant });
    res.json({ ...fait, sauvegarde: envoi ? true : false });
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
