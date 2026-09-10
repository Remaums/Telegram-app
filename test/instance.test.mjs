/**
 * Le dossier de données n'appartient qu'à un processus.
 *
 * Chaque instance garde les données en mémoire et réécrit le fichier entier :
 * deux processus sur le même dossier ne se voient pas, et le second efface
 * sans un mot ce que le premier vient d'écrire. Plutôt que de le documenter
 * et d'espérer, la boutique refuse de démarrer — ce test vérifie qu'elle
 * refuse pour de bon, et qu'elle ne refuse pas à tort.
 *
 * Ne touche à rien d'autre : le verrou est pris puis rendu dans la foulée.
 *
 * Usage :  BOT_TOKEN=… node test/instance.test.mjs
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { claimDataDir } = await import('../server/json-store.js');

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'data');
const lock = path.join(dataDir, '.lock');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

// Le serveur de test tient peut-être déjà le verrou : on le met de côté et on
// le remettra à l'identique, sans quoi ce test le ferait tomber.
const avant = fs.existsSync(lock) ? fs.readFileSync(lock, 'utf8') : null;
const rendre = () => {
  if (avant === null) fs.rmSync(lock, { force: true });
  else fs.writeFileSync(lock, avant);
};

try {
  /* ── Un dossier libre se réserve ───────────────────────── */

  fs.rmSync(lock, { force: true });
  const relacher = claimDataDir();
  check('Le dossier libre est réservé', fs.existsSync(lock));
  check('Le verrou porte le PID du processus',
    JSON.parse(fs.readFileSync(lock, 'utf8')).pid === process.pid);

  /* ── Le même processus peut le reprendre ───────────────── */

  claimDataDir();
  check('Se réserver deux fois ne se bloque pas soi-même', fs.existsSync(lock));

  /* ── Un processus vivant bloque ────────────────────────── */

  // Le PID 1 existe toujours et n'est pas le nôtre : il fait un occupant idéal.
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, since: new Date().toISOString() }));
  let refus = null;
  try {
    claimDataDir();
  } catch (err) {
    refus = err.message;
  }
  check('Un occupant vivant fait refuser le démarrage', refus !== null);
  check('Le refus dit quoi faire',
    /Postgres|DATABASE_URL/.test(refus ?? '') && /\.lock/.test(refus ?? ''),
    (refus ?? '').split('\n')[0]);

  /* ── Un verrou périmé ne bloque pas ────────────────────── */

  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, since: '2020-01-01T00:00:00.000Z' }));
  claimDataDir();
  check('Un verrou laissé par un processus mort est repris',
    JSON.parse(fs.readFileSync(lock, 'utf8')).pid === process.pid);

  /* ── Un verrou illisible ne bloque pas ─────────────────── */

  fs.writeFileSync(lock, 'ceci n\'est pas du JSON');
  claimDataDir();
  check('Un verrou illisible est repris plutôt que de tout arrêter',
    JSON.parse(fs.readFileSync(lock, 'utf8')).pid === process.pid);

  /* ── Le relâchement ────────────────────────────────────── */

  relacher();
  check('Relâcher supprime le verrou', !fs.existsSync(lock));

  /* ── On ne supprime pas le verrou d'autrui ─────────────── */

  claimDataDir();
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, since: new Date().toISOString() }));
  relacher();
  check('Relâcher ne touche pas au verrou d\'un autre processus', fs.existsSync(lock));
} finally {
  rendre();
}

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Instance unique : OK'}`);
process.exit(failures ? 1 : 0);
