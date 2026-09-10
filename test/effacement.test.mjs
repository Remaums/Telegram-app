/**
 * Effacer des commandes, ou leur faire oublier qui les a passées.
 *
 * C'est la seule opération de la boutique qui détruit pour de bon. Ce que
 * cette suite protège tient en trois phrases :
 *
 * - **on n'efface pas par accident** : sans le mot de confirmation, rien ne
 *   bouge — et le serveur le redemande de son côté, parce qu'une interface se
 *   contourne et qu'une commande curl n'a pas d'écran de confirmation ;
 * - **on n'efface pas plus que demandé** : la date est une frontière, et le
 *   jour de la limite est le premier qu'on garde ;
 * - **anonymiser n'est pas effacer** : les montants restent, donc le bilan ne
 *   bouge pas ; ce qui désigne quelqu'un s'en va.
 *
 * La partie qui écrit vraiment se joue sur une sauvegarde prise juste avant et
 * restaurée juste après : la suite rend le magasin tel qu'elle l'a trouvé.
 *
 * Prérequis : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/effacement.test.mjs
 */
import 'dotenv/config';
import { trierPourPurge } from '../server/orders.js';
import { signInitData } from './helpers.mjs';

const TOKEN = process.env.BOT_TOKEN;
const BASE = process.env.TEST_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

if (!TOKEN) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer les tests.');
  process.exit(1);
}

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const commande = (iso, extra = {}) => ({
  reference: `CS68-${iso.slice(5, 10).replace('-', '')}`,
  createdAt: `${iso}T18:00:00.000Z`,
  status: 'livree',
  mode: 'delivery',
  total: 5000,
  items: [{ name: 'Néon Kush', quantity: 1, lineTotal: 5000 }],
  user: { id: 42, username: 'marco', firstName: 'Marc' },
  address: { street: '12 rue des Lilas', complement: 'Bât B', postalCode: '68100', city: 'Mulhouse' },
  phone: '06 12 34 56 78',
  contact: '12 rue des Lilas · 68100 Mulhouse · 06 12 34 56 78',
  note: 'Sonner deux fois',
  zone: { id: 'mulhouse', name: 'Mulhouse', postalCode: '68100' },
  ...extra,
});

const magasin = () => [commande('2025-01-15'), commande('2026-02-20'), commande('2026-03-10')];

/* ── La frontière ────────────────────────────────────────── */

{
  const { gardees, effacees } = trierPourPurge(magasin(), { mode: 'avant', avant: '2026-02-20' });
  check('Ce qui précède la date s en va', effacees === 1, `${effacees} effacée(s)`);
  check('Le jour de la limite est le premier qu on garde',
    gardees.length === 2 && gardees[0].createdAt.startsWith('2026-02-20'), gardees[0]?.createdAt);
}

{
  const { gardees, effacees } = trierPourPurge(magasin(), { mode: 'tout' });
  check('Tout effacer ne garde rien', gardees.length === 0 && effacees === 3);
}

/* ── Anonymiser n'est pas effacer ────────────────────────── */

{
  const { gardees, anonymisees, effacees } = trierPourPurge(magasin(), { mode: 'anonymiser', avant: '2026-03-01' });
  check('Rien n est effacé', effacees === 0 && gardees.length === 3);
  check('Deux commandes ont oublié leur client', anonymisees === 2, `${anonymisees}`);

  const vieille = gardees[0];
  check("Le nom, l'identifiant et le pseudo s en vont",
    vieille.user.id === null && vieille.user.firstName === null && vieille.user.username === null,
    JSON.stringify(vieille.user));
  check("L'adresse, le téléphone et la note aussi",
    vieille.address === null && vieille.phone === null && vieille.contact === null && vieille.note === null);
  check('Mais le montant reste : une comptabilité ne se réécrit pas',
    vieille.total === 5000 && vieille.items.length === 1);
  check('Le secteur reste — il désigne une commune, pas une porte',
    vieille.zone?.postalCode === '68100');
  check('Et la commande se souvient qu elle a été anonymisée', vieille.anonymise === true);

  const recente = gardees[2];
  check("La commande récente n'a rien perdu",
    recente.user.id === 42 && recente.address?.street === '12 rue des Lilas');

  // Rejouer l'opération ne doit rien changer : sinon un vendeur qui clique deux
  // fois verrait un compteur remonter sans que rien ne bouge.
  const encore = trierPourPurge(gardees, { mode: 'anonymiser', avant: '2026-03-01' });
  check('Recommencer ne recompte pas ce qui est déjà oublié', encore.anonymisees === 0);
}

/* ── Ce qui est refusé ───────────────────────────────────── */

for (const [quoi, options] of [
  ['une date absente', { mode: 'avant' }],
  ['une date de travers', { mode: 'avant', avant: '20 février' }],
  ['un mode inventé', { mode: 'nawak', avant: '2026-01-01' }],
  ['aucun mode', { avant: '2026-01-01' }],
]) {
  let refuse = false;
  try {
    trierPourPurge(magasin(), options);
  } catch (err) {
    refuse = err.status === 400;
  }
  check(`Refusé : ${quoi}`, refuse);
}

/* ── La porte, et le mot de passe ────────────────────────── */

const admin = signInitData(TOKEN, { id: 424242, first_name: 'Patron' });
const client = signInitData(TOKEN, { id: 870000 + (Date.now() % 40000), first_name: 'Client' });

const purger = (corps, init = admin) =>
  fetch(`${BASE}/api/admin/orders/purge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': init },
    body: JSON.stringify(corps),
  });

const combien = async () =>
  (await (await fetch(`${BASE}/api/admin/clients`, { headers: { 'X-Telegram-Init-Data': admin } })).json()).total;

const avantTout = await combien();

let r = await purger({ mode: 'tout' });
let data = await r.json().catch(() => ({}));
check('Sans le mot de confirmation, rien ne bouge',
  r.status === 400 && /EFFACER/.test(data.error ?? ''), data.error);

r = await purger({ mode: 'tout', confirmation: 'oui' });
check('Un autre mot ne suffit pas', r.status === 400, `HTTP ${r.status}`);

r = await purger({ mode: 'tout', confirmation: 'EFFACER' }, client);
check("Un client n'efface pas la boutique", r.status === 403, `HTTP ${r.status}`);

r = await fetch(`${BASE}/api/admin/orders/purge`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode: 'tout', confirmation: 'EFFACER' }),
});
check('Sans signature non plus', r.status === 401, `HTTP ${r.status}`);

check('Et le magasin est intact après tous ces refus', (await combien()) === avantTout,
  `${avantTout} clients`);

// Telegram n'est pas joignable depuis les tests : la sauvegarde ne peut pas
// partir, et c'est précisément le cas qui doit tout arrêter.
r = await purger({ mode: 'tout', confirmation: 'EFFACER', sauvegarde: true });
data = await r.json().catch(() => ({}));
check('Sauvegarde impossible : rien n est effacé, et on dit pourquoi',
  r.status === 409 && /rien n'a été effacé/i.test(data.error ?? ''), (data.error ?? '').split('\n')[0]);
check('Le magasin est toujours là', (await combien()) === avantTout, `${avantTout} clients`);

/* ── L'effacement pour de bon, puis la remise en état ───── */

// On prend la sauvegarde par la même route que le vendeur, on efface sans
// demander l'envoi Telegram, on vérifie, et on restaure.
const sauvegarde = await (
  await fetch(`${BASE}/api/admin/backup`, { headers: { 'X-Telegram-Init-Data': admin } })
).json();
check('Une sauvegarde se prend avant', sauvegarde.counts?.orders > 0, `${sauvegarde.counts?.orders} commandes`);

r = await purger({ mode: 'tout', confirmation: 'EFFACER', sauvegarde: false });
data = await r.json().catch(() => ({}));
check('Sans sauvegarde demandée, l effacement se fait',
  r.status === 200 && data.restantes === 0, `HTTP ${r.status} — ${JSON.stringify(data)}`);
check('Et il ne reste plus un client', (await combien()) === 0);

const bilan = await (
  await fetch(`${BASE}/api/admin/bilan?jours=30`, { headers: { 'X-Telegram-Init-Data': admin } })
).json();
check('Le tableau de bord repart de zéro', bilan.resume.chiffre === 0 && bilan.resume.commandes === 0,
  `${bilan.resume.chiffre} · ${bilan.resume.commandes}`);

const remise = await fetch(`${BASE}/api/admin/backup/restore`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': admin },
  body: JSON.stringify(sauvegarde),
});
check('La sauvegarde ramène tout', remise.status === 200, `HTTP ${remise.status}`);
check('Et le magasin est exactement comme avant', (await combien()) === avantTout,
  `${await combien()} / ${avantTout}`);

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Effacement et anonymisation : OK'}`);
process.exit(failures ? 1 : 0);
