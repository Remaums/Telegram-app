import fs from 'node:fs/promises';
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
