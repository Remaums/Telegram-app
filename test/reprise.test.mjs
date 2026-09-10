/**
 * Ce que devient la boutique après un incident.
 *
 * Fichier tronqué par une coupure de courant, JSON devenu illisible, restes
 * d'une écriture interrompue, base injoignable, configuration incomplète. Une
 * boutique qui refuse de démarrer vaut mieux qu'une qui sert des prix faux, et
 * un message qui dit quoi faire vaut mieux qu'une trace d'exception.
 *
 * Cette suite démarre de vrais processus sur le port 3010 : elle ne dérange
 * pas le serveur de test, et remet chaque fichier comme elle l'a trouvé.
 *
 * Usage :  BOT_TOKEN=… node test/reprise.test.mjs
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer les tests.');
  process.exit(1);
}

const RACINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(RACINE, 'server', 'data');

let failures = 0;
const dit = (ok, label, note = '') => {
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${note ? `  (${note})` : ''}`);
  if (!ok) failures++;
};

/** Démarre la boutique et rend ce qu'elle a dit, sans la laisser tourner. */
async function demarrer(env = {}, attente = 2500) {
  const enfant = execFile('node', ['server/index.js'], {
    cwd: RACINE,
    env: { ...process.env, PORT: '3010', ...env },
  });
  let sortie = '';
  enfant.stdout.on('data', (d) => (sortie += d));
  enfant.stderr.on('data', (d) => (sortie += d));

  const fini = new Promise((r) => enfant.once('exit', (code) => r(code)));
  const code = await Promise.race([fini, new Promise((r) => setTimeout(() => r(null), attente))]);

  let sante = null;
  if (code === null) {
    sante = await fetch('http://localhost:3010/api/health')
      .then((r) => r.json())
      .catch((e) => ({ erreur: e.message }));
    enfant.kill('SIGTERM');
    await fini.catch(() => {});
  }
  return { code, sortie, sante };
}

const sauver = (f) => {
  const p = path.join(DATA, f);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
};
const rendre = (f, contenu) => {
  const p = path.join(DATA, f);
  if (contenu === null) fs.rmSync(p, { force: true });
  else fs.writeFileSync(p, contenu);
};

fs.rmSync(path.join(DATA, '.lock'), { force: true });

console.log('\n=== Catalogue illisible ===');
{
  const avant = sauver('catalog.json');
  fs.writeFileSync(path.join(DATA, 'catalog.json'), '{ ceci nest pas du json');
  const { code, sortie, sante } = await demarrer();
  dit(code !== null || sante?.ok === false || /json|SyntaxError|Unexpected/i.test(sortie),
      'un catalogue illisible ne passe pas inaperçu',
      code !== null ? `arrêt code ${code}` : `santé ${JSON.stringify(sante).slice(0, 80)}`);
  rendre('catalog.json', avant);
  fs.rmSync(path.join(DATA, '.lock'), { force: true });
}

console.log('\n=== Catalogue tronqué en pleine écriture ===');
{
  const avant = sauver('catalog.json');
  const entier = avant ? avant.toString() : '{"products":[],"categories":[]}';
  fs.writeFileSync(path.join(DATA, 'catalog.json'), entier.slice(0, Math.floor(entier.length / 2)));
  const { code, sortie, sante } = await demarrer();
  dit(code !== null || sante?.ok === false || /json|Unexpected/i.test(sortie),
      'un fichier coupé en deux ne passe pas inaperçu',
      code !== null ? `arrêt code ${code}` : `santé ${JSON.stringify(sante).slice(0, 80)}`);
  rendre('catalog.json', avant);
  fs.rmSync(path.join(DATA, '.lock'), { force: true });
}

console.log('\n=== Commandes illisibles ===');
{
  const avant = sauver('orders.json');
  fs.writeFileSync(path.join(DATA, 'orders.json'), 'nawak');
  const { code, sortie, sante } = await demarrer();
  dit(code !== null || sante?.ok === false || /json|Unexpected/i.test(sortie),
      'des commandes illisibles ne passent pas inaperçues',
      code !== null ? `arrêt code ${code}` : `santé ${JSON.stringify(sante).slice(0, 80)}`);
  rendre('orders.json', avant);
  fs.rmSync(path.join(DATA, '.lock'), { force: true });
}

console.log('\n=== Réglages illisibles ===');
{
  const avant = sauver('settings.json');
  fs.writeFileSync(path.join(DATA, 'settings.json'), '[[[');
  const { code, sortie, sante } = await demarrer();
  dit(code !== null || sante?.ok === false || /json|Unexpected/i.test(sortie),
      'des réglages illisibles ne passent pas inaperçus',
      code !== null ? `arrêt code ${code}` : `santé ${JSON.stringify(sante).slice(0, 80)}`);
  rendre('settings.json', avant);
  fs.rmSync(path.join(DATA, '.lock'), { force: true });
}

console.log('\n=== Fichier temporaire oublié par un crash ===');
{
  const orphelin = path.join(DATA, 'catalog.json.99999.tmp');
  fs.writeFileSync(orphelin, 'restes dune ecriture interrompue');
  const { code, sante } = await demarrer();
  dit(code === null && sante?.ok === true, 'un fichier temporaire orphelin ne gêne pas',
      code !== null ? `arrêt code ${code}` : `santé ok`);
  fs.rmSync(orphelin, { force: true });
  fs.rmSync(path.join(DATA, '.lock'), { force: true });
}

console.log('\n=== Base Postgres injoignable ===');
{
  const { code, sortie, sante } = await demarrer(
    { DATABASE_URL: 'postgres://personne@localhost:5999/nexistepas' }, 3500);
  const explicite = /ECONNREFUSED|postgres|base|connexion/i.test(sortie) || sante?.storage === 'postgres';
  dit(explicite, 'une base injoignable est signalée clairement',
      code !== null ? `arrêt code ${code}` : JSON.stringify(sante).slice(0, 90));
}

console.log('\n=== Configuration incomplète ===');
{
  const { code, sortie } = await demarrer({ BOT_TOKEN: '' }, 2500);
  dit(code === 1 && /Configuration incomplète/i.test(sortie),
      'sans token, la boutique s arrête en expliquant', sortie.trim().split('\n')[0]?.slice(0, 70));
  fs.rmSync(path.join(DATA, '.lock'), { force: true });
}

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Reprise après incident : OK'}`);
process.exit(failures ? 1 : 0);
