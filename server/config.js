import 'dotenv/config';

const required = ['BOT_TOKEN'];

export const config = {
  botToken: process.env.BOT_TOKEN ?? '',
  webappUrl: (process.env.WEBAPP_URL ?? '').replace(/\/$/, ''),
  adminChatId: process.env.ADMIN_CHAT_ID ?? '',
  sellerUsername: (process.env.SELLER_USERNAME ?? '').replace(/^@/, ''),
  // Nom du bot, pour fabriquer les liens t.me qui ouvrent la Mini App. Il se
  // demande à Telegram si on ne le renseigne pas — mais le renseigner évite
  // un aller-retour réseau au premier lien généré.
  botUsername: (process.env.BOT_USERNAME ?? '').replace(/^@/, ''),
  // Identifiants Telegram autorisés à ouvrir l'espace admin.
  adminIds: (process.env.ADMIN_IDS ?? process.env.ADMIN_CHAT_ID ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean),
  port: Number(process.env.PORT ?? 3000),
  // Derrière un reverse proxy (Nginx, Caddy), on n'écoute que en local :
  // HOST=127.0.0.1 ferme la porte à un accès direct au port.
  host: process.env.HOST ?? '0.0.0.0',
  // Postgres : présent = mise en ligne serverless, absent = fichiers JSON.
  databaseUrl: process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? '',
  // Jeton partagé avec Telegram : il signe chaque appel du webhook.
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET ?? '',
  currency: process.env.CURRENCY ?? 'EUR',
  shopName: process.env.SHOP_NAME ?? 'COFFEE SHOP 68',
};

/** Ce que la Mini App a le droit de connaître (jamais le token, jamais l'admin chat). */
export const publicConfig = {
  shopName: config.shopName,
  currency: config.currency,
  sellerUsername: config.sellerUsername,
};

/**
 * Vérifie la configuration.
 *
 * `exit: true` pour un démarrage en ligne de commande (message lisible puis
 * arrêt) ; sinon on lève, car en serverless un `process.exit` ne laisse
 * qu'un code d'erreur nu dans les journaux.
 */
export function assertConfigured({ exit = false } = {}) {
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    const message =
      `Configuration incomplète : ${missing.join(', ')} manquant(s). ` +
      'Copie .env.example vers .env (ou renseigne les variables chez ton hébergeur).';
    if (exit) {
      console.error(`\n  ${message}\n`);
      process.exit(1);
    }
    throw new Error(message);
  }
  if (!config.adminIds.length) {
    console.warn(
      "  ADMIN_IDS non défini : personne ne pourra ouvrir l'espace admin."
    );
  }
  if (!config.sellerUsername) {
    console.warn(
      '  SELLER_USERNAME non défini : le bouton "Commander" ne pourra pas ouvrir ta conversation.'
    );
  }
}
