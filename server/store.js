import { createStore as createJsonStore, claimDataDir as claimJsonDataDir } from './json-store.js';
import { createStore as createPgStore } from './pg-store.js';
import { config } from './config.js';

/**
 * Choisit le magasin selon l'environnement : Postgres dès que `DATABASE_URL`
 * est défini (mise en ligne sur Vercel), fichiers JSON sinon (développement
 * local et tests). Les deux exposent la même interface read/write/update, si
 * bien que `catalog.js` et `orders.js` ignorent lequel tourne.
 */
export const createStore = config.databaseUrl ? createPgStore : createJsonStore;
export const storageKind = config.databaseUrl ? 'postgres' : 'fichiers JSON';

/**
 * Réserve le dossier de données, quand il y en a un.
 *
 * Postgres n'en a pas besoin : il verrouille chaque ligne le temps de la
 * transaction, et plusieurs instances peuvent donc servir en parallèle. Les
 * fichiers JSON, eux, n'appartiennent qu'à un processus.
 */
export const claimDataDir = config.databaseUrl ? null : claimJsonDataDir;
