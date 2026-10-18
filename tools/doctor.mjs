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
  else if (name === 'DATABASE_URL') ok('DATABASE_URL absent', '(fichiers JSON — le bon réglage sur un VPS)');
  else warn(`${name} absent`);
}

/* ── 2. Le déploiement répond ────────────────────────────── */

/**
 * Lit /api/health et rend ce qui est revenu, quel qu'il soit.
 *
 * L'ancienne version appelait `.json()` à l'aveugle. Quand le tunnel est
 * mort ou la boutique arrêtée, ce n'est pas l'API qui répond mais Cloudflare,
 * avec une page d'erreur HTML : le diagnostic affichait alors
 * « Unexpected token '<', "<!doctype "… is not valid JSON », qui ne dit rien
 * de ce qui est cassé. On lit donc le texte, et on regarde ce que c'est.
 */
async function lireSante(base) {
  let res;
  try {
    res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    return { joignable: false, erreur: err.cause?.code ?? err.name ?? err.message };
  }
  const texte = await res.text();
  try {
    return { joignable: true, statut: res.status, sante: JSON.parse(texte) };
  } catch {
    const titre = texte.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() ?? '';
    return { joignable: true, statut: res.status, html: texte, titre };
  }
}

// Sur le VPS, la boutique répond AUSSI en direct, sans le tunnel. Comparer
// les deux dit lequel des deux maillons est cassé — c'est toute la question
// quand une adresse trycloudflare ne répond plus.
const port = Number(process.env.PORT) || 3000;
const local = await lireSante(`http://127.0.0.1:${port}`);
const surUnVps = local.joignable && Boolean(local.sante);

if (!target) {
  ko('Aucune URL à tester', 'passe-la en argument ou renseigne WEBAPP_URL.');
} else {
  console.log(`\nDéploiement · ${target}`);

  if (local.sante?.ok) {
    ok(`La boutique répond en direct (port ${port})`, `${local.sante.products} produits`);
  } else if (local.joignable) {
    ko(`La boutique répond mal en direct (port ${port})`, `HTTP ${local.statut}`);
  } else {
    // Rien sur le port : soit on n'est pas sur le VPS (on teste un déploiement
    // à distance, rien d'anormal), soit la boutique est arrêtée.
    warn(`Rien ne répond sur le port ${port} de cette machine`,
      'normal si tu testes depuis ailleurs ; sur le VPS, la boutique est arrêtée : sudo systemctl status <service>');
  }

  const distant = await lireSante(target);

  if (distant.sante) {
    const health = distant.sante;
    if (distant.statut < 400 && health.ok) ok('API en ligne', `${health.products} produits · stockage ${health.storage}`);
    else ko('API en erreur', health.error ?? `HTTP ${distant.statut}`);

    if (health.storage === 'fichiers JSON' && !surUnVps) {
      warn('Stockage sur fichiers', 'en serverless, les commandes seront perdues : définis DATABASE_URL.');
    }
    for (const [name, value] of Object.entries(health.config ?? {})) {
      // Le secret de webhook ne sert qu'en serverless : sur un VPS en long
      // polling il est ignoré, et son absence n'est pas une alerte.
      if (!value && !(name === 'webhookSecret' && surUnVps)) warn(`Côté serveur, ${name} n'est pas configuré`);
    }

    try {
      const page = await fetch(target, { signal: AbortSignal.timeout(10_000) });
      const html = await page.text();
      if (page.ok && html.includes('id="shopName"')) ok('Mini App servie');
      else ko('Mini App injoignable', `HTTP ${page.status}`);
    } catch (err) {
      ko('Mini App injoignable', err.cause?.code ?? err.message);
    }
  } else if (!distant.joignable) {
    ko("L'adresse ne répond pas du tout", distant.erreur === 'ENOTFOUND'
      ? "le nom n'existe plus — une adresse trycloudflare meurt avec son tunnel"
      : distant.erreur);
  } else {
    // Une page HTML à la place de l'API : c'est Cloudflare qui parle, pas la
    // boutique. Son code et son titre disent lequel des maillons manque.
    const tunnelMort = distant.statut === 530 || /tunnel error|1033/i.test(distant.titre + distant.html.slice(0, 4000));
    const origineMorte = distant.statut === 502 || /bad gateway/i.test(distant.titre);
    if (tunnelMort) {
      ko('Le tunnel ne répond plus',
        "Cloudflare connaît l'adresse, mais aucun tunnel n'y est branché : il s'est arrêté, ou il est reparti avec une AUTRE adresse.");
    } else if (origineMorte) {
      ko('Le tunnel tourne, mais la boutique derrière ne répond pas', `HTTP ${distant.statut}`);
    } else {
      ko("Une page HTML au lieu de l'API", `HTTP ${distant.statut}${distant.titre ? ` · « ${distant.titre} »` : ''}`);
    }
  }

  // Le verdict, quand les deux mesures existent : c'est lui qui dit quoi faire.
  if (target && !distant.sante && local.sante?.ok) {
    console.log("\n  → La boutique tourne : c'est le TUNNEL qui manque. Relance bash deploy/installer.sh —");
    console.log('    il récupère la nouvelle adresse, l\'écrit dans .env et redémarre la boutique.');
  } else if (target && distant.statut === 502 && !local.joignable) {
    console.log("\n  → Le tunnel est là : c'est la BOUTIQUE qui est arrêtée. Sur le VPS :");
    console.log('    sudo systemctl restart <service de la boutique>, puis journalctl -u <service> -n 30 si elle retombe.');
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
      // Sur un VPS la boutique lit en long polling : PAS de webhook est le bon
      // réglage. L'ancien message invitait à lancer tools/set-webhook.mjs —
      // sur un VPS, ça rendait le bot muet jusqu'au prochain redémarrage
      // (Telegram refuse le long polling tant qu'un webhook est déclaré).
      if (surUnVps) ok('Pas de webhook', 'long polling — le bon réglage sur un VPS. Ne lance PAS tools/set-webhook.mjs ici.');
      else warn('Aucun webhook déclaré', 'en serverless (Vercel), lance tools/set-webhook.mjs ; sur un VPS, ne fais rien.');
    } else if (surUnVps) {
      ko('Un webhook est déclaré alors que la boutique lit en long polling',
        'le bot ne reçoit plus rien : node tools/set-webhook.mjs --delete, puis redémarre la boutique.');
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
