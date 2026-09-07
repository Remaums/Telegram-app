import pg from 'pg';
import { config } from './config.js';

/**
 * Même magasin que `json-store.js`, mais adossé à Postgres : c'est ce qui
 * tourne dès que `DATABASE_URL` est défini (Vercel, où le disque est en
 * lecture seule et où chaque requête peut atterrir sur une autre instance).
 *
 * Chaque magasin est un document JSONB dans la table `shop_documents`. On
 * garde ainsi la forme des données du magasin fichier — donc `catalog.js` et
 * `orders.js` sont inchangés — tout en gagnant une vraie sérialisation des
 * écritures : `update()` verrouille la ligne (SELECT … FOR UPDATE) le temps
 * de la transaction, ce qui empêche deux commandes simultanées de se voler
 * le même stock, y compris depuis deux instances différentes.
 *
 * Quand les commandes se compteront en dizaines de milliers, il faudra
 * passer à une ligne par commande : seul ce fichier est à revoir.
 */

const TABLE = 'shop_documents';

let pool;
let ready;

function getPool() {
  if (pool) return pool;

  const url = config.databaseUrl;
  // Les Postgres gérés (Neon, Supabase, Vercel) exigent TLS ; en local sur
  // localhost ou avec sslmode=disable, on s'en passe.
  const local = /(^|@)(localhost|127\.0\.0\.1)/.test(url) || /sslmode=disable/.test(url);

  pool = new pg.Pool({
    connectionString: url,
    // Une invocation serverless ne traite qu'une requête à la fois : une
    // connexion suffit, et le pooler du fournisseur ne sature pas.
    max: Number(process.env.PGPOOL_MAX ?? 1),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    ssl: local ? undefined : { rejectUnauthorized: false },
  });
  pool.on('error', (err) => console.error('Postgres (connexion inactive) :', err.message));
  return pool;
}

/** Crée la table au premier accès du process, une seule fois. */
function ensureSchema() {
  ready ??= getPool().query(
    `create table if not exists ${TABLE} (
       key text primary key,
       data jsonb not null,
       updated_at timestamptz not null default now()
     )`
  );
  return ready;
}

async function resolveSeed(seed) {
  return typeof seed === 'function' ? await seed() : seed;
}

export function createStore(filename, seed) {
  const key = filename.replace(/\.json$/, '');

  async function read() {
    await ensureSchema();
    const { rows } = await getPool().query(`select data from ${TABLE} where key = $1`, [key]);
    if (rows.length) return rows[0].data;

    // Première utilisation : on sème le document initial. `do nothing` couvre
    // le cas où deux instances démarrent en même temps.
    const initial = await resolveSeed(seed);
    await getPool().query(
      `insert into ${TABLE} (key, data) values ($1, $2) on conflict (key) do nothing`,
      [key, JSON.stringify(initial)]
    );
    const { rows: seeded } = await getPool().query(`select data from ${TABLE} where key = $1`, [key]);
    return seeded[0].data;
  }

  async function write(data) {
    await ensureSchema();
    await getPool().query(
      `insert into ${TABLE} (key, data) values ($1, $2)
       on conflict (key) do update set data = excluded.data, updated_at = now()`,
      [key, JSON.stringify(data)]
    );
  }

  /** Lit sous verrou, laisse la fonction muter les données, puis sauvegarde. */
  async function update(mutator) {
    await ensureSchema();
    const client = await getPool().connect();
    try {
      await client.query('begin');

      const { rows } = await client.query(
        `select data from ${TABLE} where key = $1 for update`,
        [key]
      );
      let data;
      if (rows.length) {
        data = rows[0].data;
      } else {
        data = structuredClone(await resolveSeed(seed));
        await client.query(`insert into ${TABLE} (key, data) values ($1, $2)`, [
          key,
          JSON.stringify(data),
        ]);
      }

      // Si le mutateur lève (stock insuffisant, transition interdite…),
      // le rollback annule aussi bien l'écriture que le semis ci-dessus.
      const result = await mutator(data);

      await client.query(
        `update ${TABLE} set data = $2, updated_at = now() where key = $1`,
        [key, JSON.stringify(data)]
      );
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return { read, write, update };
}
