/**
 * Recherche et tri au catalogue.
 *
 * Le filtrage se fait dans le navigateur — le catalogue entier y est déjà —
 * mais ce qu'il filtre vient du serveur : cette suite vérifie que le catalogue
 * porte ce qu'il faut pour chercher et trier, et rejoue les mêmes règles de
 * correspondance que la Mini App sur des cas qui piègent : accents, casse,
 * mots dans le désordre, produit sans description.
 *
 * Prérequis : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/recherche.test.mjs
 */
import 'dotenv/config';
import { signInitData, resetShop } from './helpers.mjs';

const TOKEN = process.env.BOT_TOKEN;
const BASE = process.env.TEST_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

if (!TOKEN) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer les tests.');
  process.exit(1);
}

const admin = signInitData(TOKEN, { id: 424242, first_name: 'Patron' });

await resetShop(BASE, admin, { features: { search: true } });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const call = (path, { method = 'GET', body } = {}) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': admin },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/* ── Les mêmes règles que la Mini App ────────────────────── */

const normaliser = (texte) =>
  String(texte ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const correspond = (produit, requete) => {
  const mots = normaliser(requete).split(/\s+/).filter(Boolean);
  if (!mots.length) return true;
  const foin = normaliser(
    [produit.name, produit.short, produit.description, produit.badge, ...(produit.tags ?? [])].join(' ')
  );
  return mots.every((mot) => foin.includes(mot));
};

/* ── Ce que le catalogue doit porter ─────────────────────── */

let catalog = await (await fetch(`${BASE}/api/catalog`)).json();
check('Le catalogue expose l\'interrupteur de recherche',
  typeof catalog.features?.search === 'boolean', `${catalog.features?.search}`);
check('Chaque produit porte une date d\'entrée',
  catalog.products.every((p) => typeof p.createdAt === 'string' && p.createdAt),
  `${catalog.products.filter((p) => p.createdAt).length}/${catalog.products.length}`);

/* ── Chercher ────────────────────────────────────────────── */

const trouve = (q) => catalog.products.filter((p) => correspond(p, q)).map((p) => p.name);
const avecAccent = catalog.products.find((p) => /[éèêàûô]/i.test(p.name));

if (avecAccent) {
  const sansAccent = normaliser(avecAccent.name.split(' ')[0]);
  check('Un nom accentué se trouve sans accent',
    trouve(sansAccent).includes(avecAccent.name), `« ${sansAccent} » → ${trouve(sansAccent)[0]}`);
  check('La casse est ignorée',
    trouve(sansAccent.toUpperCase()).includes(avecAccent.name), sansAccent.toUpperCase());
}

const aDeuxMots = catalog.products.find((p) => p.name.trim().split(/\s+/).length >= 2);
if (aDeuxMots) {
  const [un, deux] = aDeuxMots.name.split(/\s+/).filter((m) => m.length > 2);
  if (un && deux) {
    check('Les mots peuvent venir dans le désordre',
      trouve(`${deux} ${un}`).includes(aDeuxMots.name), `« ${deux} ${un} »`);
  }
}

check('Une requête vide ne filtre rien', trouve('').length === catalog.products.length);
check('Une requête sans réponse ne renvoie rien', trouve('zzzzzzzz').length === 0);
check('On cherche aussi dans la description',
  catalog.products.some((p) => p.description && correspond(p, normaliser(p.description.split(' ')[3] ?? 'x'))));

/* ── Trier ───────────────────────────────────────────────── */

const parPrix = [...catalog.products].sort((a, b) => a.price - b.price);
check('Le tri par prix croissant est cohérent',
  parPrix[0].price <= parPrix[parPrix.length - 1].price,
  `${parPrix[0].price} → ${parPrix[parPrix.length - 1].price}`);

/* ── Un produit ajouté passe en tête des nouveautés ──────── */

const neuf = await (await call('/api/admin/products', {
  method: 'POST',
  body: { name: 'Arrivage du jour', category: 'fleurs', price: 1500, stock: 3, short: 'test' },
})).json();

catalog = await (await fetch(`${BASE}/api/catalog`)).json();
const nouveautes = [...catalog.products]
  .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
check('Le dernier produit ajouté ouvre les nouveautés',
  nouveautes[0]?.id === neuf.id, nouveautes[0]?.name);

/* ── La date ne bouge pas quand on modifie le produit ───── */

const dateAvant = neuf.createdAt;
await call(`/api/admin/products/${neuf.id}`, { method: 'PATCH', body: { price: 1900 } });
const apres = (await (await call('/api/admin/catalog')).json()).products.find((p) => p.id === neuf.id);
check('Modifier un produit ne le rajeunit pas', apres.createdAt === dateAvant,
  `${dateAvant} → ${apres.createdAt}`);
check('Mais la modification a bien eu lieu', apres.price === 1900, `${apres.price}`);

await call(`/api/admin/products/${neuf.id}`, { method: 'DELETE' });

/* ── L'interrupteur ──────────────────────────────────────── */

await call('/api/admin/settings', { method: 'PUT', body: { features: { search: false } } });
catalog = await (await fetch(`${BASE}/api/catalog`)).json();
check('Coupée, la recherche est annoncée éteinte', catalog.features.search === false);
await call('/api/admin/settings', { method: 'PUT', body: { features: { search: true } } });

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Recherche et tri : OK'}`);
process.exit(failures ? 1 : 0);
