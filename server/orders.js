import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const ordersFile = path.join(dataDir, 'orders.json');

/**
 * Stockage des commandes sur fichier JSON.
 *
 * Suffisant pour démarrer et pour un volume raisonnable. Les écritures passent
 * par une file d'attente pour ne pas entrelacer deux sauvegardes concurrentes,
 * et par un fichier temporaire renommé pour ne jamais laisser un JSON tronqué
 * si le process meurt en pleine écriture.
 *
 * Au-delà de quelques milliers de commandes, remplacer par SQLite ou Postgres :
 * seules les fonctions de ce fichier sont à réécrire.
 */
let cache = null;
let writeChain = Promise.resolve();

async function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(ordersFile, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    cache = [];
  }
  return cache;
}

function persist() {
  writeChain = writeChain.then(async () => {
    await fs.mkdir(dataDir, { recursive: true });
    const tmp = `${ordersFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2));
    await fs.rename(tmp, ordersFile);
  });
  return writeChain;
}

/** Référence courte et lisible, du type KTN-7F3A9C. */
function makeReference() {
  return `KTN-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

export async function createOrder({ user, items, total, contact, note }) {
  const orders = await load();
  const order = {
    reference: makeReference(),
    createdAt: new Date().toISOString(),
    status: 'nouvelle',
    user: {
      id: user.id,
      username: user.username ?? null,
      firstName: user.first_name ?? null,
    },
    items,
    total,
    contact,
    note: note || null,
  };
  orders.push(order);
  await persist();
  return order;
}

export async function listOrders({ userId, limit = 20 } = {}) {
  const orders = await load();
  const filtered = userId ? orders.filter((o) => o.user.id === userId) : orders;
  return filtered.slice(-limit).reverse();
}

export async function setStatus(reference, status) {
  const orders = await load();
  const order = orders.find((o) => o.reference === reference);
  if (!order) return null;
  order.status = status;
  await persist();
  return order;
}
