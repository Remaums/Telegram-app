/**
 * Diagnostic de mise en ligne.
 *
 * Répond à la seule question qui compte après un déploiement : est-ce que
 * la boutique et le bot sont réellement joignables, et le webhook pointe-t-il
 * au bon endroit ?
 *
 * Usage :
 *   node tools/doctor.mjs                       (utilise WEBAPP_URL du .env)
 *   node tools/doctor.mjs https://mon-projet.vercel.app
 */
import 'dotenv/config';

const target = (process.argv[2] ?? process.env.WEBAPP_URL ?? '').replace(/\/$/, '');
const token = process.env.BOT_TOKEN ?? '';

let problems = 0;
const ok = (label, detail = '') => console.log(`  ✅  ${label}${detail ? `  ${detail}` : ''}`);
const ko = (label, detail = '') => {
  console.log(`  ❌  ${label}${detail ? `  ${detail}` : ''}`);
  problems++;
};
const warn = (label, detail = '') => console.log(`  ⚠️   ${label}${detail ? `  ${detail}` : ''}`);

/* ── 1. Configuration locale ─────────────────────────────── */

console.log('\nConfiguration locale');
for (const [name, value, required] of [
  ['BOT_TOKEN', token, true],
  ['WEBAPP_URL', process.env.WEBAPP_URL, true],
  ['SELLER_USERNAME', process.env.SELLER_USERNAME, true],
  ['ADMIN_IDS', process.env.ADMIN_IDS ?? process.env.ADMIN_CHAT_ID, false],
  ['DATABASE_URL', process.env.DATABASE_URL ?? process.env.POSTGRES_URL, false],
  ['TELEGRAM_WEBHOOK_SECRET', process.env.TELEGRAM_WEBHOOK_SECRET, false],
]) {
  if (value) ok(`${name} défini`);
  else if (required) ko(`${name} manquant`);
  else warn(`${name} absent`, name === 'DATABASE_URL' ? '(stockage fichiers JSON)' : '');
}

/* ── 2. Le déploiement répond ────────────────────────────── */

if (!target) {
  ko('Aucune URL à tester', 'passe-la en argument ou renseigne WEBAPP_URL.');
} else {
  console.log(`\nDéploiement · ${target}`);
  try {
    const res = await fetch(`${target}/api/health`);
    const health = await res.json();

    if (res.ok && health.ok) ok('API en ligne', `${health.products} produits · stockage ${health.storage}`);
    else ko('API en erreur', health.error ?? `HTTP ${res.status}`);

    if (health.storage === 'fichiers JSON') {
      warn('Stockage sur fichiers', 'en serverless, les commandes seront perdues : définis DATABASE_URL.');
    }
    for (const [name, value] of Object.entries(health.config ?? {})) {
      if (!value) warn(`Côté serveur, ${name} n'est pas configuré`);
    }

    const page = await fetch(target);
    const html = await page.text();
    if (page.ok && html.includes('id="shopName"')) ok('Mini App servie');
    else ko('Mini App injoignable', `HTTP ${page.status}`);
  } catch (err) {
    ko('Déploiement injoignable', err.message);
  }
}

/* ── 3. Le webhook Telegram ──────────────────────────────── */

if (token) {
  console.log('\nWebhook Telegram');
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    const { ok: valid, result, description } = await res.json();

    if (!valid) {
      ko('Telegram refuse le token', description);
    } else if (!result.url) {
      warn('Aucun webhook déclaré', 'mode long polling — lance tools/set-webhook.mjs pour la mise en ligne.');
    } else {
      const expected = `${target}/api/telegram`;
      if (result.url === expected) ok('Webhook déclaré', result.url);
      else ko('Webhook sur une autre URL', `${result.url} (attendu ${expected})`);

      if (result.pending_update_count) {
        warn('Mises à jour en attente', `${result.pending_update_count} — le webhook ne répond peut-être pas.`);
      }
      if (result.last_error_message) {
        ko('Dernière erreur signalée par Telegram', result.last_error_message);
      }
    }
  } catch (err) {
    ko('Appel à Telegram impossible', err.message);
  }
}

console.log(
  problems ? `\n${problems} problème(s) à régler.\n` : '\nTout est en ordre.\n'
);
process.exit(problems ? 1 : 0);
