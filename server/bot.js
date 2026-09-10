import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { config } from './config.js';
import { listOrders, STATUSES, setStatus } from './orders.js';
import { restoreStock, getCatalog, setProductPhoto } from './catalog.js';
import { matchProduct } from './photos.js';
import { getSettings, saveSettings } from './settings.js';
import { requestVerification, decideVerification } from './verification.js';
import { desabonner, reabonner, estDesabonne, consignerResultat } from './annonces.js';

/**
 * Le bot, construit même sans jeton.
 *
 * grammY refuse un token vide en levant « Empty token! » — et comme les
 * imports d'un module ES sont évalués avant le corps du fichier, ce plantage
 * arrivait *avant* le contrôle de configuration. Un nouvel utilisateur qui
 * oubliait son BOT_TOKEN recevait donc une trace JavaScript au lieu du
 * message qui lui dit quoi faire. Le jeton de remplacement ne sert jamais :
 * en ligne de commande, le contrôle arrête le process juste après ; ailleurs,
 * `bot.start()` échoue proprement et la boutique reste servie.
 */
export const bot = new Bot(config.botToken || '0:BOT_TOKEN-absent');

/**
 * Telegram n'accepte un bouton Mini App qu'avec une URL HTTPS valide.
 *
 * Sans `WEBAPP_URL`, ou avec une adresse en HTTP, Telegram refuse le message
 * entier : la commande échouait alors sans rien afficher, et on cherchait du
 * côté des droits admin un problème de configuration.
 */
const urlUtilisable = () => /^https:\/\/[^\s]+$/.test(config.webappUrl);

// Rendre `undefined` plutôt qu'un clavier invalide : Telegram refuse le
// message entier quand un bouton Mini App porte une URL qu'il n'accepte pas,
// si bien que /start ne répondait rien du tout. Le garde-fou est ici, à
// l'endroit unique où le clavier se fabrique, plutôt que dispersé sur chaque
// appel — il en manquait justement sur les commandes les plus utilisées.
const shopKeyboard = () =>
  urlUtilisable() ? new InlineKeyboard().webApp('🛒 Ouvrir la boutique', config.webappUrl) : undefined;

const adminKeyboard = () =>
  urlUtilisable()
    ? new InlineKeyboard().webApp('⚙️ Espace admin', `${config.webappUrl}/admin.html`)
    : undefined;

/** Ce qu'il faut dire quand aucun bouton ne peut être proposé. */
const PAS_D_URL =
  "⚠️ WEBAPP_URL n'est pas renseignée (ou n'est pas en HTTPS) : Telegram refuse " +
  "d'ouvrir une Mini App sans adresse HTTPS valide.\n\n" +
  'Renseigne-la dans le fichier .env, puis redémarre la boutique.';

const isAdmin = (id) => config.adminIds.includes(String(id));

bot.command('start', async (ctx) => {
  await ctx.reply(
    `🌿 *${escapeMarkdown(config.shopName)}*\n\n` +
      "Bienvenue dans la boutique\\. Tout se passe dans l'app : catalogue en images, " +
      'panier, et commande envoyée en un bouton\\.\n\n' +
      `Ton ID Telegram : \`${ctx.from.id}\``,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: shopKeyboard(),
    }
  );
});

bot.command('boutique', (ctx) =>
  ctx.reply('Voilà le catalogue 👇', { reply_markup: shopKeyboard() })
);

bot.command('commandes', async (ctx) => {
  // Le même interrupteur que l'écran « Mes commandes » de la Mini App : une
  // porte fermée d'un côté et ouverte de l'autre n'en est pas une.
  if (!(await getSettings()).features.orderHistory) {
    return ctx.reply("L'historique des commandes n'est pas disponible ici.", {
      reply_markup: shopKeyboard(),
    });
  }

  const orders = await listOrders({ userId: ctx.from.id, limit: 5 });
  if (!orders.length) {
    return ctx.reply("Tu n'as pas encore passé de commande.", { reply_markup: shopKeyboard() });
  }
  const lines = orders.map(
    (o) =>
      `${o.reference} — ${formatPrice(o.total)} — ${o.status}\n` +
      `  ${new Date(o.createdAt).toLocaleDateString('fr-FR')}`
  );
  await ctx.reply(`Tes dernières commandes :\n\n${lines.join('\n')}`);
});

bot.command('stop', async (ctx) => {
  await desabonner(ctx.from.id);
  await ctx.reply(
    '🔕 C\'est noté : tu ne recevras plus d\'annonce.\n\n' +
      'Les messages sur tes propres commandes continuent, eux : ce sont des ' +
      'réponses, pas de la publicité. Écris /annonces pour revenir en arrière.'
  );
});

bot.command('annonces', async (ctx) => {
  const coupe = await estDesabonne(ctx.from.id);
  if (!coupe) {
    return ctx.reply('🔔 Tu reçois déjà les annonces. Écris /stop pour ne plus en recevoir.');
  }
  await reabonner(ctx.from.id);
  await ctx.reply('🔔 C\'est reparti : tu recevras de nouveau les annonces.');
});

bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply("Cet espace est réservé à l'administrateur.");
  }
  // Mieux vaut expliquer que laisser Telegram rejeter le message : sans URL,
  // la commande ne répondait rien du tout.
  if (!urlUtilisable()) return ctx.reply(PAS_D_URL);

  await ctx.reply('Gestion du stock, des produits et des commandes 👇', {
    reply_markup: adminKeyboard(),
  });
});

/** Ouvre ou ferme la boutique sans quitter la conversation. */
for (const [command, open] of [['ouvrir', true], ['fermer', false]]) {
  bot.command(command, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      return ctx.reply("Cette commande est réservée à l'administrateur.");
    }
    await saveSettings({ opening: { open } });
    await ctx.reply(
      open
        ? '🟢 Boutique ouverte : les commandes repassent.'
        : '🔴 Boutique fermée : les commandes sont refusées avec ton message.'
    );
  });
}

/**
 * Active ou coupe la vérification d'identité depuis la conversation.
 *
 *   /verification        → l'état actuel, avec les boutons
 *   /verification on|off → bascule directe
 */
bot.command('verification', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply("Cette commande est réservée à l'administrateur.");
  }

  const argument = (ctx.match ?? '').trim().toLowerCase();
  if (argument === 'on' || argument === 'off') {
    const enabled = argument === 'on';
    await saveSettings({ verification: { enabled } });
    return ctx.reply(
      enabled
        ? '🪪 Vérification activée : un client doit faire valider une pièce d\'identité avant de commander.'
        : '🪪 Vérification désactivée : la boutique est ouverte sans contrôle de pièce.'
    );
  }

  const settings = await getSettings();
  await ctx.reply(
    `🪪 Vérification d'identité : ${settings.verification.enabled ? 'activée' : 'désactivée'}.`,
    {
      reply_markup: new InlineKeyboard()
        .text('✅ Activer', 'vfset:on')
        .text('⛔ Désactiver', 'vfset:off'),
    }
  );
});

bot.callbackQuery(/^vfset:(on|off)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.answerCallbackQuery({ text: "Réservé à l'administrateur.", show_alert: true });
  }
  const enabled = ctx.match[1] === 'on';
  await saveSettings({ verification: { enabled } });
  await ctx.answerCallbackQuery({ text: enabled ? 'Vérification activée' : 'Vérification désactivée' });
  await ctx.editMessageText(
    `🪪 Vérification d'identité : ${enabled ? 'activée' : 'désactivée'}.`
  );
});

/**
 * Une image arrive dans la conversation.
 *
 * Deux usages selon l'expéditeur : le vendeur met à jour la photo d'un
 * produit, un client fait vérifier sa pièce d'identité. Un seul point d'entrée
 * évite que le premier gestionnaire avale l'image du second.
 */
bot.on(['message:photo', 'message:document'], async (ctx) => {
  const settings = await getSettings();

  if (isAdmin(ctx.from.id)) {
    if (!settings.features.photos) {
      return ctx.reply('Les photos par le bot sont désactivées (Réglages → Fonctionnalités).');
    }
    return handleProductPhoto(ctx);
  }

  // Sans vérification active, une pièce d'identité reçue serait une donnée
  // sensible qu'on n'a aucune raison de manipuler : on le dit tout de suite.
  if (!settings.features.verification) {
    return ctx.reply("Merci, mais aucune pièce d'identité n'est demandée pour commander ici.");
  }
  return handleIdentityDocument(ctx);
});

/**
 * Photo de produit : la légende dit quel produit.
 *
 * Le fichier reste chez Telegram — on n'enregistre que sa référence. Rien à
 * écrire sur le disque, donc ça marche aussi bien sur un VPS qu'en serverless.
 */
async function handleProductPhoto(ctx) {
  const caption = ctx.message.caption ?? '';
  const { products } = await getCatalog({ includeHidden: true });

  if (!caption.trim()) {
    return ctx.reply(
      '📸 Renvoie la photo en écrivant le produit en légende.\n\n' +
        `Par exemple : ${products[0]?.name ?? 'nom du produit'}`
    );
  }

  const { match, candidates } = matchProduct(caption, products);
  if (!match) {
    const liste = (candidates.length ? candidates : products)
      .slice(0, 8)
      .map((p) => `• ${p.name}`)
      .join('\n');
    return ctx.reply(
      candidates.length
        ? `Plusieurs produits correspondent :\n${liste}\n\nPrécise la légende.`
        : `Aucun produit ne correspond à « ${caption} ».\n\nProduits :\n${liste}`
    );
  }

  // La photo la plus grande est la dernière du tableau ; un document image
  // (envoyé « sans compression ») convient aussi.
  const fileId = ctx.message.photo?.at(-1)?.file_id ?? ctx.message.document?.file_id;
  const mime = ctx.message.document?.mime_type;
  if (ctx.message.document && mime && !mime.startsWith('image/')) {
    return ctx.reply("Ce fichier n'est pas une image.");
  }

  try {
    await setProductPhoto(match.id, fileId);
    await ctx.reply(`✅ Photo mise à jour pour « ${match.name} ».`);
  } catch (err) {
    await ctx.reply(`Impossible d'enregistrer la photo : ${err.message}`);
  }
}

/**
 * Pièce d'identité d'un client.
 *
 * Le document n'est ni téléchargé ni enregistré : il est transféré tel quel au
 * vendeur, qui le regarde dans Telegram puis le supprime. La boutique ne garde
 * que le verdict.
 */
async function handleIdentityDocument(ctx) {
  const settings = await getSettings();
  if (!settings.verification.enabled) {
    return ctx.reply("Merci, mais aucune vérification n'est demandée en ce moment.");
  }

  await requestVerification(ctx.from.id);
  await ctx.reply(
    '🪪 Bien reçu. Ta pièce part en vérification, tu recevras la réponse ici.\n\n' +
      'Elle n\'est pas enregistrée par la boutique : tu peux supprimer ton message ' +
      'dès que la vérification est faite.'
  );

  if (!config.adminChatId) {
    return console.warn('ADMIN_CHAT_ID absent : pièce reçue mais personne à prévenir.');
  }

  try {
    await ctx.api.forwardMessage(config.adminChatId, ctx.chat.id, ctx.message.message_id);
    const who = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name ?? 'client';
    await ctx.api.sendMessage(
      config.adminChatId,
      `🪪 Vérification demandée par ${who} (id ${ctx.from.id}).\n` +
        'Regarde le document ci-dessus, tranche, puis supprime-le de la conversation.',
      {
        reply_markup: new InlineKeyboard()
          .text('✅ Valider', `vf:${ctx.from.id}:approved`)
          .text('❌ Refuser', `vf:${ctx.from.id}:refused`),
      }
    );
  } catch (err) {
    console.error('Transfert de la pièce impossible :', err.message);
  }
}

/** Verdict du vendeur, d'un appui, sans quitter la conversation. */
bot.callbackQuery(/^vf:(\d+):(approved|refused)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.answerCallbackQuery({ text: "Réservé à l'administrateur.", show_alert: true });
  }

  const [, userId, status] = ctx.match;
  await decideVerification(userId, status, ctx.from.id);

  const validated = status === 'approved';
  await ctx.answerCallbackQuery({ text: validated ? 'Client validé' : 'Client refusé' });
  await ctx.editMessageText(
    `🪪 Client ${userId} — ${validated ? '✅ validé' : '❌ refusé'}.\n` +
      'Pense à supprimer le document de la conversation.'
  );

  try {
    await ctx.api.sendMessage(
      Number(userId),
      validated
        ? '✅ Vérification acceptée. La boutique t\'est ouverte, bonne visite !'
        : "❌ Vérification refusée. Écris-nous si tu penses que c'est une erreur."
    );
  } catch (err) {
    console.error('Réponse au client impossible :', err.message);
  }
});

bot.command('aide', (ctx) =>
  ctx.reply(
    'Commandes disponibles :\n' +
      '/boutique — ouvrir le catalogue\n' +
      '/commandes — voir tes commandes\n' +
      '/stop — ne plus recevoir d\'annonces\n' +
      '/aide — ce message' +
      (isAdmin(ctx.from.id)
        ? '\n/admin — espace administrateur' +
          '\n/ouvrir, /fermer — ouvrir ou fermer la boutique' +
          '\n/verification [on|off] — contrôle des pièces d\'identité' +
          '\n📸 envoie une photo avec le nom du produit en légende pour changer son image'
        : '')
  )
);

// Filet de sécurité : si le client n'a pas pu ouvrir la conversation vendeur,
// la Mini App renvoie la commande par sendData et elle arrive ici.
bot.on('message:web_app_data', async (ctx) => {
  try {
    const payload = JSON.parse(ctx.message.web_app_data.data);
    await ctx.reply(
      `✅ Commande *${escapeMarkdown(payload.reference ?? '')}* bien reçue, ` +
        'on te répond très vite\\.',
      { parse_mode: 'MarkdownV2' }
    );
  } catch {
    await ctx.reply('Commande reçue, on revient vers toi rapidement.');
  }
});

/**
 * Tout le reste.
 *
 * Un client qui écrit « bonjour » au bot n'obtenait rien du tout : la porte
 * d'entrée de la boutique restait muette. Ce gestionnaire est déclaré après
 * les commandes, qui gardent donc la priorité.
 */
bot.on('message:text', async (ctx) => {
  await ctx.reply(
    'Je ne comprends que quelques commandes :\n' +
      '/boutique — ouvrir le catalogue\n' +
      '/commandes — retrouver tes commandes\n' +
      '/aide — tout ce que je sais faire' +
      (config.sellerUsername ? `\n\nPour parler à quelqu'un : @${config.sellerUsername}` : ''),
    { reply_markup: config.webappUrl ? shopKeyboard() : undefined }
  );
});

bot.catch((err) => {
  console.error('Erreur bot :', err.error ?? err);
});

/**
 * Confirme au client que sa commande est bien partie.
 *
 * C'est le seul accusé de réception qu'il reçoit : le bouton « Commander »
 * ouvre bien la conversation vendeur avec le récapitulatif, mais rien ne dit
 * qu'il appuiera sur Envoyer — et si SELLER_USERNAME n'est pas configuré, il
 * ne se passait tout simplement rien de son côté.
 */
export async function notifyOrderPlaced(order) {
  const items = order.items
    .map((i) => `• ${i.quantity} × ${i.name}${i.variantLabel ? ` (${i.variantLabel})` : ''}`)
    .join('\n');

  const remise = order.discount
    ? `Remise${order.discountLabel ? ` ${order.discountLabel}` : ''} : −${formatPrice(order.discount)}\n`
    : '';

  const text =
    `✅ Commande ${order.reference} enregistrée\n\n` +
    `${items}\n\n` +
    (order.slot ? `🕒 ${order.slot.label}\n` : '') +
    remise +
    `Total : ${formatPrice(order.total)}\n\n` +
    'On revient vers toi très vite.';

  await bot.api.sendMessage(order.user.id, text, {
    reply_markup: config.webappUrl ? shopKeyboard() : undefined,
  });
}

/**
 * Envoie un fichier à l'administrateur, dans la conversation du bot.
 *
 * Un téléchargement lancé depuis la Mini App est capricieux : la WebView de
 * Telegram bloque souvent les liens de téléchargement, et le fichier n'arrive
 * nulle part. Passer par le bot le dépose dans la conversation, où il se
 * consulte, se transfère et se retrouve des mois plus tard.
 */
export async function sendFileToAdmin(chatId, filename, contenu, legende) {
  const donnees = Buffer.isBuffer(contenu) ? contenu : Buffer.from(contenu, 'utf8');
  await bot.api.sendDocument(chatId, new InputFile(donnees, filename), {
    caption: legende?.slice(0, 1000),
  });
  return { filename, octets: donnees.length };
}

/**
 * Envoie une annonce, doucement.
 *
 * Telegram coupe au-delà d'une trentaine de messages par seconde et bloque le
 * bot qui insiste. On envoie donc par petits paquets, avec une pause entre
 * chacun : mille clients prennent une minute, ce qui n'a aucune importance
 * pour une annonce, et le bot reste en vie.
 *
 * Un client qui a bloqué le bot fait échouer son envoi sans que le reste en
 * souffre — et il est désabonné au passage, puisqu'il a dit non à sa manière.
 */
export async function diffuser(envoi, clients, { paquet = 20, pause = 1200 } = {}) {
  let recus = 0;
  let echecs = 0;

  const texte =
    `${envoi.texte}\n\n` +
    '— — —\n' +
    'Tu reçois ce message parce que tu as déjà commandé ici. ' +
    'Écris /stop pour ne plus en recevoir.';

  for (let i = 0; i < clients.length; i += paquet) {
    const tranche = clients.slice(i, i + paquet);
    const resultats = await Promise.allSettled(
      tranche.map((c) =>
        bot.api.sendMessage(c.id, texte, {
          reply_markup: config.webappUrl ? shopKeyboard() : undefined,
        })
      )
    );

    for (const [index, r] of resultats.entries()) {
      if (r.status === 'fulfilled') {
        recus++;
        continue;
      }
      echecs++;
      // 403 : le client a bloqué le bot ou supprimé la conversation. Insister
      // à chaque annonce ne servirait qu'à refaire échouer les prochaines.
      if (r.reason?.error_code === 403) {
        await desabonner(tranche[index].id).catch(() => {});
      }
    }

    if (i + paquet < clients.length) await new Promise((r) => setTimeout(r, pause));
  }

  await consignerResultat(envoi.id, { recus, echecs }).catch(() => {});
  return { recus, echecs };
}

/**
 * Le nom du bot, demandé une fois puis gardé.
 *
 * Il sert à fabriquer les liens `t.me` qui ouvrent la Mini App sur un produit.
 * `BOT_USERNAME` court-circuite l'appel réseau ; sinon on interroge Telegram,
 * et on garde la réponse — le nom d'un bot ne change pas en cours de route.
 */
let nomDuBot = config.botUsername || null;

export async function botUsername() {
  if (nomDuBot) return nomDuBot;
  try {
    nomDuBot = (await bot.api.getMe()).username ?? null;
  } catch (err) {
    // Jeton absent ou Telegram injoignable : on rend la main sans nom plutôt
    // que de faire tomber la requête. L'appelant sait quoi en dire.
    console.error('Nom du bot indisponible :', err.message);
    return null;
  }
  return nomDuBot;
}

/** Récapitulatif d'une commande, tel que le vendeur le lit dans Telegram. */
export function orderMessage(order) {
  const status = STATUSES[order.status];
  const who = order.user.username ? `@${order.user.username}` : order.user.firstName ?? 'client';
  const items = order.items
    .map((i) => `• ${i.quantity} × ${i.name}${i.variantLabel ? ` (${i.variantLabel})` : ''}`)
    .join('\n');

  const livraison = order.mode === 'delivery';
  const frais = order.deliveryFee
    ? `Livraison : ${formatPrice(order.deliveryFee)}\n`
    : livraison
      ? 'Livraison : offerte\n'
      : '';

  // Le vendeur doit pouvoir refaire le calcul de tête : sous-total, remise,
  // frais, total. Sans la ligne de remise, un total plus bas que la somme des
  // articles ressemble à un bug.
  const remise = order.discount
    ? `Sous-total : ${formatPrice(order.subtotal)}\n` +
      `Remise ${order.promoCode ? `${order.promoCode} ` : ''}: −${formatPrice(order.discount)}` +
      `${order.discountLabel ? ` (${order.discountLabel})` : ''}\n`
    : '';

  // Le créneau vaut mieux en tête qu'en bas : c'est ce qui décide de l'ordre
  // dans lequel le vendeur prépare ses commandes.
  const creneau = order.slot ? `🕒 ${order.slot.label}\n` : '';
  const secteur = order.zone ? ` — ${order.zone.name} (${order.zone.postalCode})` : '';

  return (
    `🧾 COMMANDE ${order.reference} — ${status?.emoji ?? ''} ${status?.label ?? order.status}\n\n` +
    `Client : ${who} (id ${order.user.id})\n` +
    `Mode : ${livraison ? '🛵 livraison' : '🏠 retrait'}${secteur}\n` +
    creneau +
    `${items}\n\n` +
    remise +
    frais +
    `Total : ${formatPrice(order.total)}\n` +
    (order.contact ? `${livraison ? 'Adresse' : 'Contact'} : ${order.contact}\n` : '') +
    (order.note ? `Note : ${order.note}` : '')
  );
}

/**
 * Boutons de traitement rapide sous la commande : seules les transitions
 * autorisées depuis le statut courant sont proposées, si bien qu'un appui
 * ne peut pas produire un enchaînement interdit. Rien quand la commande est
 * terminée — le clavier disparaît alors de lui-même.
 */
export function statusKeyboard(order) {
  const next = STATUSES[order.status]?.next ?? [];
  if (!next.length) return undefined;

  const keyboard = new InlineKeyboard();
  for (const status of next) {
    keyboard.text(
      `${STATUSES[status].emoji} ${STATUSES[status].label}`,
      `st:${order.reference}:${status}`
    );
  }
  return keyboard;
}

/**
 * Traitement d'une commande depuis la conversation : le vendeur n'a pas à
 * ouvrir l'espace admin pour confirmer ou marquer une commande prête.
 */
bot.callbackQuery(/^st:([A-Za-z0-9-]+):([a-z]+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.answerCallbackQuery({
      text: "Réservé à l'administrateur.",
      show_alert: true,
    });
  }

  const [, reference, next] = ctx.match;
  try {
    const { order, changed } = await setStatus(reference, next);

    // Une annulation remet les articles en rayon, comme dans l'espace admin.
    if (changed && next === 'annulee') await restoreStock(order.items);
    if (changed && (await getSettings()).features.clientNotifications) {
      notifyCustomer(order).catch((err) =>
        console.error('Notification client impossible :', err.message)
      );
    }

    await ctx.answerCallbackQuery({
      text: changed ? `${reference} → ${STATUSES[next].label}` : 'Déjà à ce statut.',
    });
    await ctx.editMessageText(orderMessage(order), { reply_markup: statusKeyboard(order) });
  } catch (err) {
    await ctx.answerCallbackQuery({ text: err.message, show_alert: true });
  }
});

/** Prévient le vendeur qu'une commande vient d'être enregistrée. */
export async function notifyAdmin(order) {
  if (!config.adminChatId) return;
  try {
    await bot.api.sendMessage(config.adminChatId, orderMessage(order), {
      reply_markup: statusKeyboard(order),
    });
  } catch (err) {
    console.error('Notification admin impossible :', err.message);
  }
}

/** Prévient le vendeur que des articles passent sous son seuil d'alerte. */
export async function notifyLowStock(entries) {
  if (!config.adminChatId || !entries.length) return;

  const lignes = entries
    .map((e) => `• ${e.name}${e.variantLabel ? ` (${e.variantLabel})` : ''} — ${e.left === 0 ? 'épuisé' : `reste ${e.left}`}`)
    .join('\n');

  try {
    await bot.api.sendMessage(config.adminChatId, `⚠️ Stock bas\n\n${lignes}`);
  } catch (err) {
    console.error('Alerte de stock impossible :', err.message);
  }
}

/** Prévient un client qu'un article qu'il attendait est revenu. */
export async function notifyBackInStock(userId, product, variantLabel) {
  const quoi = `${product.name}${variantLabel ? ` (${variantLabel})` : ''}`;
  try {
    await bot.api.sendMessage(
      Number(userId),
      `🔔 ${quoi} est de retour en stock !`,
      { reply_markup: config.webappUrl ? shopKeyboard() : undefined }
    );
  } catch (err) {
    // Un client qui a bloqué le bot ne doit pas faire échouer le réassort.
    console.warn(`Alerte de retour impossible pour ${userId} :`, err.message);
  }
}

/** Prévient le client que le statut de sa commande a changé. */
export async function notifyCustomer(order) {
  const status = STATUSES[order.status];
  if (!status) return;

  const messages = {
    confirmee: 'On a bien reçu ta commande, elle est confirmée.',
    prete: 'Ta commande est prête !',
    livree: 'Commande livrée. Merci et à bientôt 👋',
    annulee: 'Ta commande a été annulée. Écris-nous si c\'est une erreur.',
  };

  const text =
    `${status.emoji} Commande ${order.reference} — ${status.label}\n\n` +
    `${messages[order.status] ?? ''}\n` +
    `Total : ${formatPrice(order.total)}`;

  await bot.api.sendMessage(order.user.id, text);
}

function formatPrice(cents) {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: config.currency }).format(
    cents / 100
  );
}

/** Échappe les caractères réservés de MarkdownV2. */
function escapeMarkdown(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}
