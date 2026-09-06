import 'dotenv/config';

const required = ['BOT_TOKEN'];

export const config = {
  botToken: process.env.BOT_TOKEN ?? '',
  webappUrl: (process.env.WEBAPP_URL ?? '').replace(/\/$/, ''),
  adminChatId: process.env.ADMIN_CHAT_ID ?? '',
  sellerUsername: (process.env.SELLER_USERNAME ?? '').replace(/^@/, ''),
  port: Number(process.env.PORT ?? 3000),
  currency: process.env.CURRENCY ?? 'EUR',
  shopName: process.env.SHOP_NAME ?? 'KARTOON CLUB',
};

/** Ce que la Mini App a le droit de connaître (jamais le token, jamais l'admin chat). */
export const publicConfig = {
  shopName: config.shopName,
  currency: config.currency,
  sellerUsername: config.sellerUsername,
};

export function assertConfigured() {
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    console.error(
      `\n  Configuration incomplète : ${missing.join(', ')} manquant(s).\n` +
        `  Copie .env.example vers .env et remplis les valeurs.\n`
    );
    process.exit(1);
  }
  if (!config.sellerUsername) {
    console.warn(
      '  SELLER_USERNAME non défini : le bouton "Commander" ne pourra pas ouvrir ta conversation.'
    );
  }
}
