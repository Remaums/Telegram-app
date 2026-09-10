import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');

/**
 * Petit magasin de données sur fichier JSON.
 *
 * - lecture unique puis cache mémoire ;
 * - écritures sérialisées (file d'attente) pour ne jamais entrelacer deux
 *   sauvegardes concurrentes ;
 * - écriture dans un fichier temporaire puis renommage atomique, pour ne
 *   jamais laisser un JSON tronqué si le process meurt en pleine écriture.
 *
 * Au-delà de quelques milliers d'enregistrements, remplacer par SQLite :
 * seule l'implémentation de ce fichier est à revoir.
 */
/**
 * Réserve le dossier de données à ce seul processus.
 *
 * Chaque instance garde les données en mémoire et réécrit le fichier entier :
 * deux processus sur le même dossier ne se voient donc pas, et le second
 * efface silencieusement ce que le premier vient d'écrire — commandes
 * comprises. Le cas arrive dès qu'on lance la boutique en grappe (`pm2 -i 2`)
 * ou qu'on oublie une instance en cours.
 *
 * Plutôt que de le documenter et d'espérer, on refuse de démarrer. Pour servir
 * depuis plusieurs processus, c'est `DATABASE_URL` qu'il faut : Postgres
 * verrouille la ligne le temps de la transaction.
 *
 * @returns {() => void} de quoi relâcher la réservation.
 */
export function claimDataDir() {
  const lock = path.join(dataDir, '.lock');

  fsSync.mkdirSync(dataDir, { recursive: true });
  const occupant = lireVerrou(lock);
  if (occupant && vivant(occupant.pid) && occupant.pid !== process.pid) {
    throw new Error(
      `Une autre instance de la boutique tourne déjà (PID ${occupant.pid}, depuis ${occupant.since}).\n` +
        "  Deux processus sur le même dossier de données s'effacent l'un l'autre.\n" +
        '  Arrête-la, ou passe à Postgres (DATABASE_URL) pour servir depuis plusieurs instances.\n' +
        `  Si ce PID n'existe plus, supprime ${lock}.`
    );
  }

  fsSync.writeFileSync(lock, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));

  const relacher = () => {
    try {
      const encore = lireVerrou(lock);
      if (encore?.pid === process.pid) fsSync.unlinkSync(lock);
    } catch {
      /* le dossier a pu disparaître avec le conteneur */
    }
  };
  process.once('exit', relacher);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      relacher();
      process.exit(0);
    });
  }
  return relacher;
}

function lireVerrou(lock) {
  try {
    return JSON.parse(fsSync.readFileSync(lock, 'utf8'));
  } catch {
    return null;
  }
}

/** Le signal 0 ne fait rien : il dit seulement si le processus existe. */
function vivant(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM : le processus existe mais appartient à quelqu'un d'autre.
    return err.code === 'EPERM';
  }
}

export function createStore(filename, seed) {
  const file = path.join(dataDir, filename);
  let cache = null;
  let writeChain = Promise.resolve();

  async function read() {
    if (cache) return cache;
    try {
      cache = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      cache = structuredClone(await resolveSeed(seed));
      await write();
    }
    return cache;
  }

  function write() {
    writeChain = writeChain.then(async () => {
      await fs.mkdir(dataDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(cache, null, 2));
      await fs.rename(tmp, file);
    });
    return writeChain;
  }

  /** Lit, laisse la fonction muter les données, puis sauvegarde. */
  async function update(mutator) {
    const data = await read();
    const result = await mutator(data);
    await write();
    return result;
  }

  return { read, write, update };
}

async function resolveSeed(seed) {
  return typeof seed === 'function' ? await seed() : seed;
}
