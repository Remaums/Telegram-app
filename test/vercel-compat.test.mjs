/**
 * Test de compatibilité serverless.
 *
 * Sur Vercel, le runtime lit le corps de la requête avant de passer la main à
 * la fonction : il l'expose sur `req.body` et rejoue le flux, mais celui-ci
 * est déjà terminé (`req.readable === false`). Sans précaution, `express.json()`
 * s'arrête là — « stream is not readable », HTTP 500 — et plus aucune commande
 * ne passe en ligne alors que tout marche en local.
 *
 * Ce test rejoue ce comportement (voir `addHelpers` dans @vercel/node) devant
 * l'application réelle, sans dépendre de Vercel.
 *
 * Usage :  BOT_TOKEN=… node test/vercel-compat.test.mjs
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import 'dotenv/config';
import { getShopPass } from './helpers.mjs';

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer les tests.');
  process.exit(1);
}

const { app } = await import('../server/index.js');

/* ── Le runtime Vercel, en miniature ─────────────────────── */

/** Lit tout le corps, puis le rejoue comme le fait @vercel/node. */
function vercelize(handler) {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['content-type']) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);

      // Le flux est consommé : le runtime en rejoue une copie…
      const replay = new PassThrough();
      const replayOn = replay.on.bind(replay);
      const originalOn = req.on.bind(req);
      req.read = replay.read.bind(replay);
      req.on = req.addListener = (name, cb) =>
        name === 'data' || name === 'end' ? replayOn(name, cb) : originalOn(name, cb);
      replay.write(body);
      replay.end();

      // … et expose le corps analysé derrière une propriété paresseuse.
      Object.defineProperty(req, 'body', {
        configurable: true,
        enumerable: true,
        get: () => {
          const value = body.length ? JSON.parse(body.toString()) : {};
          Object.defineProperty(req, 'body', { configurable: true, writable: true, value });
          return value;
        },
        set: (value) => {
          Object.defineProperty(req, 'body', { configurable: true, writable: true, value });
        },
      });
    }
    handler(req, res);
  };
}

const server = http.createServer(vercelize(app));
await new Promise((resolve) => server.listen(0, resolve));
const BASE = `http://localhost:${server.address().port}`;

/* ── Vérifications ───────────────────────────────────────── */

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

function sign(user) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify(user),
  });
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

const catalog = await (await fetch(`${BASE}/api/catalog`)).json();
check('Catalogue servi', Array.isArray(catalog.products), `${catalog.products?.length} produits`);

const product = catalog.products.find((p) => p.variants?.some((v) => v.stock > 0));
const variant = product.variants.find((v) => v.stock > 0);

const vercelInit = sign({ id: 987654, first_name: 'Vercel' });
const vercelPass = await getShopPass(BASE, vercelInit);

const res = await fetch(`${BASE}/api/orders`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Telegram-Init-Data': vercelInit,
    'X-Shop-Pass': vercelPass,
  },
  body: JSON.stringify({ items: [{ id: product.id, variantId: variant.id, quantity: 1 }] }),
});
const order = await res.json().catch(() => null);
check('Commande acceptée malgré le corps déjà lu', res.status === 201, `HTTP ${res.status}`);
check('Corps de requête bien reçu', Boolean(order?.reference), order?.reference ?? order?.error);

const bad = await fetch(`${BASE}/api/orders`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Telegram-Init-Data': vercelInit,
    'X-Shop-Pass': vercelPass,
  },
  body: '{ ceci nest pas du json',
});
check('JSON invalide refusé proprement', bad.status === 400, `HTTP ${bad.status}`);

server.close();
console.log(`\n${failures ? `${failures} test(s) en échec` : 'Compatibilité serverless : OK'}`);
process.exit(failures ? 1 : 0);
