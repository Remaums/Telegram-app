import { Bot, InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { listOrders, STATUSES, setStatus } from './orders.js';
import { restoreStock } from './catalog.js';
import { getSettings, saveSettings } from './settings.js';
import { requestVerification, decideVerification } from './verification.js';

export const bot = new Bot(config.botToken);

const shopKeyboard = () =>
  new InlineKeyboard().webApp('🛒 Ouvrir la boutique', config.webappUrl);

const adminKeyboard = () =>
  new InlineKeyboard().webApp('⚙️ Espace admin', `${config.webappUrl}/admin.html`);

const isAdmin = (id) => config.adminIds.includes(String(id));

bot.command('start', async (ctx) => {
  await ctx.reply(
    `🌿 *${escapeMarkdown(config.shopName)}*\n\n` +
      "Bienvenue dans la boutique\\. Tout se passe dans l'app : catalogue en images, " +
      'panier, et commande envoyée en un bouton\\.\n\n' +
      `Ton ID Telegram : \`${ctx.from.id}\``,
    { parse_mode: 'MarkdownV2', reply_markup: shopKeyboard() }
  );
});

bot.command('boutique', (ctx) =>
  ctx.reply('Voilà le catalogue 👇', { reply_markup: shopKeyboard() })
);

bot.command('commandes', async (ctx) => {
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

bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply("Cet espace est réservé à l'administrateur.");
  }
  await ctx.reply('Gestion du stock, des produits et des commandes 👇', {
    reply_markup: adminKeyboard(),
  });
});

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
 * Une pièce d'identité arrive.
 *
 * Le document n'est ni téléchargé ni enregistré : il est transféré tel quel au
 * vendeur, qui le regarde dans Telegram puis le supprime. La boutique ne garde
 * que le verdict.
 */
bot.on(['message:photo', 'message:document'], async (ctx) => {
  const settings = await getSettings();
  if (!settings.verification.enabled) {
    return ctx.reply("Merci, mais aucune vérification n'est demandée en ce moment.");
  }
  if (isAdmin(ctx.from.id)) return; // le vendeur s'envoie ses propres images

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
});

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
      '/aide — ce message' +
      (isAdmin(ctx.from.id)
        ? '\n/admin — espace administrateur\n/verification [on|off] — contrôle des pièces d\'identité'
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

  const text =
    `✅ Commande ${order.reference} enregistrée\n\n` +
    `${items}\n\n` +
    `Total : ${formatPrice(order.total)}\n\n` +
    'On revient vers toi très vite.';

  await bot.api.sendMessage(order.user.id, text, {
    reply_markup: config.webappUrl ? shopKeyboard() : undefined,
  });
}

/** Récapitulatif d'une commande, tel que le vendeur le lit dans Telegram. */
export function orderMessage(order) {
  const status = STATUSES[order.status];
  const who = order.user.username ? `@${order.user.username}` : order.user.firstName ?? 'client';
  const items = order.items
    .map((i) => `• ${i.quantity} × ${i.name}${i.variantLabel ? ` (${i.variantLabel})` : ''}`)
    .join('\n');

  return (
    `🧾 COMMANDE ${order.reference} — ${status?.emoji ?? ''} ${status?.label ?? order.status}\n\n` +
    `Client : ${who} (id ${order.user.id})\n` +
    `${items}\n\n` +
    `Total : ${formatPrice(order.total)}\n` +
    (order.contact ? `Contact : ${order.contact}\n` : '') +
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
    if (changed) {
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
