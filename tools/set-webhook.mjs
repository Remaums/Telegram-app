/**
 * Déclare (ou retire) le webhook Telegram après une mise en ligne.
 *
 * Usage :
 *   BOT_TOKEN=… WEBAPP_URL=https://…  TELEGRAM_WEBHOOK_SECRET=… node tools/set-webhook.mjs
 *   node tools/set-webhook.mjs --delete     (repasse en long polling local)
 *   node tools/set-webhook.mjs --info       (affiche l'état actuel)
 *
 * Le secret est un jeton partagé : Telegram le renvoie dans l'en-tête
 * X-Telegram-Bot-Api-Secret-Token à chaque appel, et le serveur rejette tout
 * appel qui ne le porte pas.
 */
import 'dotenv/config';

const token = process.env.BOT_TOKEN;
const base = (process.env.WEBAPP_URL ?? '').replace(/\/$/, '');
const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';

if (!token) exit('BOT_TOKEN manquant.');

const api = async (method, body) => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!data.ok) exit(`${method} refusé par Telegram : ${data.description}`);
  return data.result;
};

if (process.argv.includes('--info')) {
  console.log(await api('getWebhookInfo'));
} else if (process.argv.includes('--delete')) {
  await api('deleteWebhook', { drop_pending_updates: false });
  console.log('  Webhook retiré : le bot repasse en long polling.');
} else {
  if (!base.startsWith('https://')) exit('WEBAPP_URL doit être une URL https complète.');
  if (secret.length < 16) exit('TELEGRAM_WEBHOOK_SECRET manquant ou trop court (16 caractères minimum).');

  const url = `${base}/api/telegram`;
  await api('setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
  });
  console.log(`  Webhook déclaré : ${url}`);

  // En long polling, le serveur pose ce bouton lui-même au démarrage. En
  // webhook (serverless), il n'y a pas de démarrage : c'est ici, à la mise en
  // ligne, qu'on règle le bouton du menu qui ouvre la boutique en bas à gauche.
  await api('setChatMenuButton', {
    menu_button: { type: 'web_app', text: '🛒 Boutique', web_app: { url: base } },
  });
  console.log('  Bouton de menu : ouvre la boutique.');
}

function exit(message) {
  console.error(`  ${message}`);
  process.exit(1);
}
