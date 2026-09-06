import { Bot, InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { listOrders } from './orders.js';

export const bot = new Bot(config.botToken);

const shopKeyboard = () =>
  new InlineKeyboard().webApp('🛒 Ouvrir la boutique', config.webappUrl);

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

bot.command('aide', (ctx) =>
  ctx.reply(
    'Commandes disponibles :\n' +
      '/boutique — ouvrir le catalogue\n' +
      '/commandes — voir tes commandes\n' +
      '/aide — ce message'
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

/** Prévient le vendeur qu'une commande vient d'être enregistrée. */
export async function notifyAdmin(order) {
  if (!config.adminChatId) return;
  const who = order.user.username ? `@${order.user.username}` : order.user.firstName ?? 'client';
  const items = order.items
    .map((i) => `• ${i.quantity} × ${i.name}${i.variantLabel ? ` (${i.variantLabel})` : ''}`)
    .join('\n');

  const text =
    `🧾 NOUVELLE COMMANDE ${order.reference}\n\n` +
    `Client : ${who} (id ${order.user.id})\n` +
    `${items}\n\n` +
    `Total : ${formatPrice(order.total)}\n` +
    (order.contact ? `Contact : ${order.contact}\n` : '') +
    (order.note ? `Note : ${order.note}` : '');

  try {
    await bot.api.sendMessage(config.adminChatId, text);
  } catch (err) {
    console.error('Notification admin impossible :', err.message);
  }
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
