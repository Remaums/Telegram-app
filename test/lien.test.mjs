/**
 * Liens directs et QR codes.
 *
 * Un QR imprimé sur un flyer ne se corrige pas : ce qu'il encode aujourd'hui,
 * il l'encodera encore dans six mois, collé sur une vitrine. On vérifie donc
 * deux choses. Que le lien mène bien là où il prétend — jusqu'à la matrice du
 * QR, module par module, plutôt que de faire confiance à l'encodeur. Et que la
 * boutique encaisse sans broncher un lien devenu caduc : article retiré,
 * masqué, ou paramètre inventé de toutes pièces.
 *
 * Prérequis : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/lien.test.mjs
 */
import 'dotenv/config';
import { signInitData, resetShop } from './helpers.mjs';
import { parseStartParam, productLink, productStartParam, shopLink } from '../server/links.js';
import { encode } from '../server/qr.js';

const TOKEN = process.env.BOT_TOKEN;
const BASE = process.env.TEST_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

if (!TOKEN) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer les tests.');
  process.exit(1);
}

const admin = signInitData(TOKEN, { id: 424242, first_name: 'Patron' });
const souche = 700000 + (Date.now() % 200000);
const client = signInitData(TOKEN, { id: souche, first_name: 'Client' });

await resetShop(BASE, admin, { features: { captcha: false } });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const call = (path, { method = 'GET', body, init = admin } = {}) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': init },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/* ── Fabriquer un lien ───────────────────────────────────── */

check(
  'Le lien produit a la forme attendue',
  productLink('ma_boutique_bot', 'banana-kush') === 'https://t.me/ma_boutique_bot?startapp=p_banana-kush'
);
check(
  'Le @ devant le nom du bot est toléré',
  shopLink('@ma_boutique_bot') === 'https://t.me/ma_boutique_bot?startapp'
);

// Telegram n'accepte que lettres, chiffres, tiret et souligné : mieux vaut
// rendre null que fabriquer un lien qui s'ouvrira sur une erreur.
for (const [label, id] of [
  ['un espace', 'banana kush'],
  ['un accent', 'crème'],
  ['une barre oblique', 'a/b'],
  ['un point', 'a.b'],
  ['un identifiant vide', ''],
  ['une esperluette', 'a&b'],
]) {
  check(`Refusé dans un lien : ${label}`, productStartParam(id) === null, JSON.stringify(id));
}

/* ── Relire un lien ──────────────────────────────────────── */

check('Un paramètre produit se relit', parseStartParam('p_banana-kush')?.id === 'banana-kush');

for (const [label, param] of [
  ['vide', ''],
  ['inconnu', 'nawak'],
  ['préfixe seul', 'p_'],
  ['avec un espace', 'p_a b'],
  ['absent', undefined],
  ['objet', {}],
]) {
  check(`Paramètre ignoré : ${label}`, parseStartParam(param) === null, JSON.stringify(param));
}

/* ── La route admin ──────────────────────────────────────── */

const catalog = await (await fetch(`${BASE}/api/catalog`)).json();
const product = catalog.products[0];

let r = await call('/api/admin/link');
let data = await r.json();
check(
  'La boutique a son lien',
  r.status === 200 && /^https:\/\/t\.me\/[^?]+\?startapp$/.test(data.url),
  data.url
);
check('Et son QR', typeof data.svg === 'string' && data.svg.startsWith('<svg'));

r = await call(`/api/admin/link?product=${product.id}`);
data = await r.json();
check('Un produit a son lien', r.status === 200 && data.url.endsWith(`?startapp=p_${product.id}`), data.url);
check('Le nom du produit accompagne le lien', data.name === product.name, data.name);
check("Un produit visible n'est pas signalé masqué", data.hidden === false);

/**
 * Relit la matrice qu'un SVG dessine.
 *
 * Un module noir y est un carré posé à `M x y` : les coordonnées suffisent
 * donc à reconstruire la grille. On compare ensuite à ce que l'encodeur
 * produit pour la même URL — si les deux divergent, c'est le rendu qui ment,
 * et un QR imprimé ne se rattrape pas.
 */
function matriceDuSvg(svg, module, marge) {
  const cote = Number(svg.match(/width="(\d+)"/)[1]) / module - marge * 2;
  const grille = Array.from({ length: cote }, () => new Array(cote).fill(0));
  for (const [, x, y] of svg.matchAll(/M(\d+) (\d+)h/g)) {
    grille[Number(y) / module - marge][Number(x) / module - marge] = 1;
  }
  return grille;
}

const attendue = encode(data.url);
const rendue = matriceDuSvg(data.svg, 6, 3);
check(
  'Le SVG reproduit exactement la matrice du QR',
  rendue.length === attendue.length &&
    rendue.every((ligne, y) => ligne.every((v, x) => v === attendue[y][x])),
  `${rendue.length}×${rendue.length} contre ${attendue.length}×${attendue.length}`
);

/* ── Un lien qui ne mène nulle part ──────────────────────── */

r = await call('/api/admin/link?product=produit-fantome');
check('Un produit inconnu répond 404', r.status === 404, `HTTP ${r.status}`);

r = await call('/api/admin/link?product=' + encodeURIComponent('a b'));
check(
  'Un identifiant impossible ne fabrique pas de lien bancal',
  r.status === 404 || r.status === 400,
  `HTTP ${r.status}`
);

/* ── Un article masqué ───────────────────────────────────── */

const cree = await (
  await call('/api/admin/products', {
    method: 'POST',
    body: {
      name: 'Article discret',
      category: product.category,
      price: 1200,
      stock: 3,
      short: 'x',
      visible: false,
    },
  })
).json();

r = await call(`/api/admin/link?product=${cree.id}`);
data = await r.json();
check(
  'Un article masqué a un lien, mais prévient',
  r.status === 200 && data.hidden === true,
  `HTTP ${r.status}, masqué ${data.hidden}`
);

// Le catalogue public ne le montre pas : le client qui scanne verra la
// boutique, pas une fiche fantôme. C'est la raison d'être de l'avertissement.
const publique = await (await fetch(`${BASE}/api/catalog`)).json();
check('Et il reste absent du catalogue public', !publique.products.some((p) => p.id === cree.id));

await call(`/api/admin/products/${cree.id}`, { method: 'DELETE' });

/* ── Ce n'est pas ouvert à tout le monde ─────────────────── */

r = await call('/api/admin/link', { init: client });
check("Un client n'obtient pas de lien", r.status === 403, `HTTP ${r.status}`);

r = await call('/api/admin/link/send', { method: 'POST', init: client, body: {} });
check("Un client ne se fait pas envoyer de QR", r.status === 403, `HTTP ${r.status}`);

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Liens directs : OK'}`);
process.exit(failures ? 1 : 0);
