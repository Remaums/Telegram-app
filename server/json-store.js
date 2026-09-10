import fs from 'node:fs/promises';
import os from 'node:os';
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
 * Traduit une panne de fichier en phrase qui dit quoi faire.
 *
 * Sans ça, un dossier de données appartenant à root alors que le service
 * tourne sous « shop » remonte jusqu'au client en « Erreur interne » : le
 * vendeur voit une boutique cassée sans le moindre indice, alors que la cause
 * tient en une commande. Les droits sont la panne d'installation numéro un,
 * ils méritent d'être nommés.
 */
function expliquer(err, file) {
  // Le nom de l'utilisateur, pas son numéro : c'est lui qu'on tape dans un
  // `chown`. Et surtout pas `$(whoami)` dans le conseil — il s'évaluerait
  // dans le shell de celui qui dépanne, souvent root, ce qui donnerait
  // exactement le mauvais propriétaire.
  let qui = `uid ${process.getuid?.() ?? '?'}`;
  try { qui = os.userInfo().username; } catch { /* pas de nom résoluble */ }
  const details = {
    EACCES: `Droits insuffisants sur ${file} — la boutique tourne sous « ${qui} ».\n` +
      `  Remède : sudo chown -R ${qui} ${dataDir}\n` +
      '  Et vérifie sous quel utilisateur le service tourne :\n' +
      '    systemctl show -p User -p WorkingDirectory coffeeshop68',
    EPERM: `Opération refusée sur ${file} — la boutique tourne sous « ${qui} ».\n` +
      '  Souvent le ReadWritePaths du service systemd qui ne désigne pas ce dossier.',
    EROFS: `${file} est sur un système de fichiers en lecture seule.\n` +
      '  Le ProtectHome/ProtectSystem du service systemd protège ce chemin : vérifie ReadWritePaths.',
    ENOSPC: `Plus de place disque pour écrire ${file}.`,
    EISDIR: `${file} est un dossier, pas un fichier.`,
  }[err.code];

  if (details) {
    const clair = new Error(`${details}\n  (${err.code} sur ${file})`);
    clair.code = err.code;
    clair.fichier = file;
    return clair;
  }
  if (err instanceof SyntaxError) {
    const clair = new Error(
      `${file} n'est pas du JSON valide — il a pu être tronqué par un arrêt brutal.\n` +
        '  Restaure une sauvegarde, ou supprime le fichier pour repartir du catalogue de départ.\n' +
        `  (${err.message})`
    );
    clair.fichier = file;
    return clair;
  }
  return err;
}

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

  // Le verrou est la toute première écriture de la boutique : c'est donc ici
  // qu'un dossier de données mal attribué se manifeste, et un « EACCES » nu
  // n'apprend rien à qui vient d'installer.
  try {
    fsSync.mkdirSync(dataDir, { recursive: true });
    fsSync.accessSync(dataDir, fsSync.constants.W_OK);
  } catch (err) {
    throw expliquer(err, dataDir);
  }
  const occupant = lireVerrou(lock);
  if (occupant && vivant(occupant.pid) && occupant.pid !== process.pid) {
    throw new Error(
      `Une autre instance de la boutique tourne déjà (PID ${occupant.pid}, depuis ${occupant.since}).\n` +
        "  Deux processus sur le même dossier de données s'effacent l'un l'autre.\n" +
        '  Arrête-la, ou passe à Postgres (DATABASE_URL) pour servir depuis plusieurs instances.\n' +
        `  Si ce PID n'existe plus, supprime ${lock}.`
    );
  }

  try {
    fsSync.writeFileSync(lock, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
  } catch (err) {
    throw expliquer(err, lock);
  }

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
      if (err.code !== 'ENOENT') throw expliquer(err, file);
      cache = structuredClone(await resolveSeed(seed));
      try {
        await write();
      } catch (echec) {
        // Le cache est déjà posé : sans cette remise à zéro, la boutique
        // servirait le catalogue de départ depuis la mémoire en donnant
        // l'illusion de marcher, et perdrait tout au redémarrage — commandes
        // comprises. Mieux vaut refuser franchement.
        cache = null;
        throw expliquer(echec, file);
      }
    }
    return cache;
  }

  function write() {
    writeChain = writeChain.then(async () => {
      try {
        await fs.mkdir(dataDir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(cache, null, 2));
        await fs.rename(tmp, file);
      } catch (err) {
        throw expliquer(err, file);
      }
    });
    // La chaîne d'écriture ne doit pas rester en échec : sans ça, un refus
    // ponctuel condamnerait toutes les écritures suivantes.
    const encours = writeChain;
    writeChain = writeChain.catch(() => {});
    return encours;
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
