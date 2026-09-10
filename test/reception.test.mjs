/**
 * Comment la boutique reçoit les messages de Telegram.
 *
 * Il y a deux modes, et ils s'excluent. Sur un VPS, un processus vit en
 * permanence et interroge Telegram en boucle — le long polling. En serverless,
 * aucun processus ne vit assez longtemps : c'est Telegram qui appelle une
 * route, le webhook.
 *
 * grammY fait respecter cette exclusion durement : appeler `webhookCallback()`
 * remplace `bot.start` par une fonction qui lève une erreur, dès l'appel et
 * sans attendre la moindre requête. Un `TELEGRAM_WEBHOOK_SECRET` qui traînait
 * dans l'environnement suffisait donc à tuer le bot sur un VPS — et comme
 * l'erreur est synchrone, elle échappait au `.catch()` : le processus mourait
 * au démarrage, donc redémarrait en boucle sous systemd, boutique comprise.
 *
 * Cette suite vérifie les deux choses qui auraient attrapé ça : le mode de
 * lancement décide seul, et une panne de bot ne coûte jamais la boutique.
 *
 * Elle démarre de vrais processus sur le port 3011, pour ne pas déranger le
 * serveur de test.
 *
 * Usage :  BOT_TOKEN=… node test/reception.test.mjs
 */
import 'dotenv/config';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer les tests.');
  process.exit(1);
}

const RACINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3011;

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

/**
 * Démarre la boutique, l'interroge, puis l'arrête.
 *
 * On rend à la fois ce que le processus a dit et ce qu'il a répondu : un
 * démarrage qui réussit en silence ne prouve rien si la route ne répond pas,
 * et une route qui répond ne prouve rien si le journal annonce un désastre.
 */
async function avecLaBoutique(env, visiter) {
  const enfant = execFile('node', ['server/index.js'], {
    cwd: RACINE,
    env: { ...process.env, PORT: String(PORT), ...env },
  });

  let sortie = '';
  enfant.stdout.on('data', (d) => (sortie += d));
  enfant.stderr.on('data', (d) => (sortie += d));

  const fini = new Promise((r) => enfant.once('exit', (code) => r(code)));

  // On attend que le port réponde, plutôt qu'un délai fixe au hasard : une
  // machine chargée mettrait plus longtemps, et le test deviendrait capricieux.
  let vivante = false;
  for (let essai = 0; essai < 40; essai++) {
    const mort = await Promise.race([fini, Promise.resolve(null)]);
    if (mort !== null) break;
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) { vivante = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }

  let resultat = null;
  if (vivante) resultat = await visiter();

  enfant.kill('SIGTERM');
  const code = await Promise.race([fini, new Promise((r) => setTimeout(() => r('tenace'), 3000))]);
  if (code === 'tenace') enfant.kill('SIGKILL');

  return { vivante, sortie, resultat };
}

const poster = (corps = { update_id: 1 }, entetes = {}) =>
  fetch(`http://127.0.0.1:${PORT}/api/telegram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...entetes },
    body: JSON.stringify(corps),
  });

/* ── Un VPS avec un secret de webhook qui traîne ──────────── */

// C'est exactement la configuration qui tuait le bot : le mode long polling,
// et un TELEGRAM_WEBHOOK_SECRET hérité d'un essai serverless.
{
  const { vivante, sortie, resultat } = await avecLaBoutique(
    { TELEGRAM_WEBHOOK_SECRET: 'secret-herite-d-un-essai-serverless' },
    async () => {
      const r = await poster();
      return { statut: r.status, corps: await r.json().catch(() => ({})) };
    }
  );

  check('La boutique démarre malgré un secret de webhook', vivante,
    vivante ? '' : sortie.split('\n').slice(0, 3).join(' | ').slice(0, 160));

  check(
    "Le bot n'est pas court-circuité par le secret",
    !/already started the bot via webhooks/i.test(sortie),
    /already started/i.test(sortie) ? 'grammY a remplacé bot.start' : ''
  );

  check('Le secret ignoré est signalé', /ignoré/i.test(sortie),
    (sortie.match(/.*ignoré.*/) ?? [''])[0].trim().slice(0, 90));

  check('La route du webhook refuse proprement', resultat?.statut === 503,
    `HTTP ${resultat?.statut}`);

  check(
    'Et le refus dit pourquoi',
    /long polling/i.test(resultat?.corps?.error ?? ''),
    resultat?.corps?.error
  );
}

/* ── Un VPS sans secret : le cas normal ──────────────────── */

{
  const { vivante, sortie, resultat } = await avecLaBoutique(
    { TELEGRAM_WEBHOOK_SECRET: '' },
    async () => {
      const r = await poster();
      return { statut: r.status, corps: await r.json().catch(() => ({})) };
    }
  );

  check('Sans secret, la boutique démarre', vivante,
    vivante ? '' : sortie.split('\n').slice(0, 3).join(' | ').slice(0, 160));
  check('La route du webhook refuse aussi', resultat?.statut === 503, `HTTP ${resultat?.statut}`);
  check("Rien n'annonce un secret ignoré", !/ignoré/i.test(sortie));
}

/* ── Une panne de bot ne coûte pas la boutique ───────────── */

// Un token syntaxiquement valide mais que Telegram refusera : le bot ne
// démarrera pas, et c'est le seul effet admissible.
{
  const { vivante, sortie, resultat } = await avecLaBoutique(
    { BOT_TOKEN: '123456789:CeTokenNExistePasEtTelegramLeRefusera' },
    async () => {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/catalog`);
      return { statut: r.status, produits: (await r.json()).products?.length ?? 0 };
    }
  );

  check('Un token refusé ne tue pas la boutique', vivante,
    vivante ? '' : sortie.split('\n').slice(0, 4).join(' | ').slice(0, 200));
  check('Le catalogue est servi quand même', resultat?.statut === 200 && resultat.produits > 0,
    `HTTP ${resultat?.statut}, ${resultat?.produits} produits`);

  // On ne veut surtout pas d'une trace d'exception non rattrapée : c'est elle
  // qui faisait redémarrer le service en boucle.
  check(
    'Aucune exception ne remonte jusqu au noyau',
    !/at ModuleJob\.run|Node\.js v\d|UnhandledPromiseRejection/i.test(sortie),
    (sortie.match(/^Error:.*/m) ?? [''])[0].slice(0, 90)
  );
}

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Modes de réception : OK'}`);
process.exit(failures ? 1 : 0);
