import 'dotenv/config';

const required = ['BOT_TOKEN'];

/** Vrai si l'adresse n'est qu'un texte de remplissage recopié du modèle. */
export function estUneAdresseDExemple(url) {
  return /@(host|adresse|hote)[/:]/i.test(url) || /\/\/(utilisateur|user):(motdepasse|password)@/i.test(url);
}

function exempleOuVide(url) {
  const propre = String(url ?? '').trim();
  if (!propre) return '';
  if (estUneAdresseDExemple(propre)) {
    console.warn(
      "\n  ⚠ DATABASE_URL est restée à sa valeur d'exemple : elle est ignorée.\n" +
        '    La boutique garde ses données dans server/data/, ce qui est le bon\n' +
        "    réglage sur un VPS. Efface la ligne de .env pour faire taire cet avertissement,\n" +
        '    ou renseigne une vraie adresse Postgres pour un déploiement serverless.\n'
    );
    return '';
  }
  return propre;
}

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
  //
  // Les deux variables sont réunies, pas mises en concurrence. `??` ne bascule
  // que sur null ou undefined : un `ADMIN_IDS=` vide — le geste naturel quand
  // on efface l'exemple — vaut la chaîne vide, qui n'est pas nulle. Le repli
  // vers ADMIN_CHAT_ID que promettait .env.example ne se produisait donc
  // jamais, et la boutique se retrouvait sans aucun administrateur. Personne
  // ne renseigne son ADMIN_CHAT_ID sans vouloir aussi ouvrir son espace admin.
  adminIds: [
    ...new Set(
      [process.env.ADMIN_IDS, process.env.ADMIN_CHAT_ID]
        .flatMap((v) => String(v ?? '').split(','))
        .map((v) => v.trim())
        .filter(Boolean)
    ),
  ],
  port: Number(process.env.PORT ?? 3000),
  // Derrière un reverse proxy (Nginx, Caddy), on n'écoute que en local :
  // HOST=127.0.0.1 ferme la porte à un accès direct au port.
  host: process.env.HOST ?? '0.0.0.0',
  // Postgres : présent = mise en ligne serverless, absent = fichiers JSON.
  //
  // Une adresse laissée à sa valeur d'exemple est traitée comme absente. Le
  // cas s'est produit : `.env` copié depuis le modèle, `DATABASE_URL` non
  // effacée, et toute la boutique bascule sur un Postgres dont l'hôte
  // s'appelle littéralement « host ». Plus rien ne s'affiche, et le journal
  // ne parle que de résolution DNS. Basculer de magasin est trop lourd de
  // conséquences pour se déclencher sur un texte que personne n'a écrit.
  databaseUrl: exempleOuVide(process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? ''),
  // Jeton partagé avec Telegram : il signe chaque appel du webhook.
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET ?? '',
  currency: process.env.CURRENCY ?? 'EUR',
  shopName: process.env.SHOP_NAME ?? 'Napoli Coffee',
  // Racine de l'API Telegram. On ne la change que pour tester en local ou
  // pour viser un serveur Bot API auto-hébergé.
  telegramApiRoot: (process.env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org').replace(/\/$/, ''),
  // Copie locale des médias relayés depuis Telegram.
  //
  // Sans elle, chaque première vue d'une photo ou d'une vidéo fait le trajet
  // VPS → Telegram → VPS → client, et une vidéo de quinze mégaoctets se fait
  // attendre. Avec elle, seul le premier visiteur le paie.
  //
  // `MEDIA_CACHE_MB=0` l'éteint. Elle s'éteint aussi d'elle-même là où le
  // disque est en lecture seule (serverless), sans rien casser : la boutique
  // relaie alors comme avant.
  mediaCache: {
    dir: process.env.MEDIA_CACHE_DIR || '',
    maxBytes: Math.max(0, Number(process.env.MEDIA_CACHE_MB ?? 500)) * 1024 * 1024,
  },
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
