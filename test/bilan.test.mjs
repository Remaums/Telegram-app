/**
 * Le bilan : ce que les commandes disent quand on les regroupe.
 *
 * Un tableau de bord faux est pire qu'aucun tableau de bord — le vendeur y
 * croit et décide dessus. Trois pièges valent tous les autres, et cette suite
 * tourne autour d'eux :
 *
 * - **le fuseau**. Un VPS réglé sur UTC couperait ses journées à deux heures du
 *   matin, c'est-à-dire en plein coup de feu du samedi soir : la moitié d'une
 *   soirée se retrouverait comptée le lendemain ;
 * - **les annulations**. Comptées dans le chiffre, elles gonflent un chiffre
 *   d'affaires qui n'existe pas ; comptées nulle part, un taux d'annulation qui
 *   grimpe ne se voit jamais ;
 * - **les nouveaux clients**. C'est la première commande de toute l'histoire
 *   qui décide, pas la première de la période — sinon chaque habitué redevient
 *   un nouveau client à chaque changement de mois.
 *
 * Le calcul est une fonction pure : on lui passe la date du jour, donc on peut
 * vérifier ce que dira le tableau un dimanche de novembre sans attendre
 * novembre. La route HTTP est éprouvée à part, avec ses droits.
 *
 * Prérequis (pour la partie HTTP) : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/bilan.test.mjs
 */
import 'dotenv/config';
import { bilan } from '../server/bilan.js';
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

/** Une commande, réduite à ce que le bilan regarde. */
const commande = (iso, total, extra = {}) => ({
  reference: `CS68-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
  createdAt: iso,
  status: 'livree',
  mode: 'delivery',
  user: { id: 1 },
  items: [{ name: 'Néon Kush', quantity: 1, lineTotal: total }],
  total,
  ...extra,
});

// Le dimanche matin qui suit un samedi soir de mars, en France (UTC+1) : la
// nuit de samedi est donc déjà de l'autre côté de minuit.
const MAINTENANT = new Date('2026-03-15T10:00:00Z');
const PARIS = 'Europe/Paris';

/* ── Le fuseau de la boutique fait foi ───────────────────── */

// 23 h 30 UTC un samedi, c'est 00 h 30 le dimanche à Mulhouse. Compter cette
// commande le samedi mettrait la moitié du coup de feu la veille.
{
  const b = bilan([commande('2026-03-14T23:30:00Z', 5000)], { jours: 7, maintenant: MAINTENANT, timezone: PARIS });
  const dimanche = b.parJour.at(-1);
  check('Une commande de minuit passé compte le lendemain', dimanche.chiffre === 5000,
    `${dimanche.jour} → ${dimanche.chiffre}`);
  check('Et se range dans la tranche de minuit', b.heures[0].commandes === 1,
    b.heures.filter((h) => h.commandes).map((h) => h.tranche).join(' '));
  check('Le jour de semaine suit le même fuseau', b.semaine[6].commandes === 1,
    b.semaine.filter((j) => j.commandes).map((j) => j.jour).join(' '));
}

// La même commande, lue depuis un serveur qui croit vivre à Tokyo, ne doit pas
// changer de jour : c'est le fuseau passé qui décide, pas celui du processus.
{
  const paris = bilan([commande('2026-03-14T18:00:00Z', 5000)], { jours: 7, maintenant: MAINTENANT, timezone: PARIS });
  const tokyo = bilan([commande('2026-03-14T18:00:00Z', 5000)], { jours: 7, maintenant: MAINTENANT, timezone: 'Asia/Tokyo' });
  check('Un autre fuseau range la commande ailleurs',
    paris.heures.findIndex((h) => h.commandes) !== tokyo.heures.findIndex((h) => h.commandes),
    `Paris ${paris.heures.find((h) => h.commandes)?.tranche} · Tokyo ${tokyo.heures.find((h) => h.commandes)?.tranche}`);
}

/* ── Les annulations ─────────────────────────────────────── */

{
  const b = bilan(
    [
      commande('2026-03-13T18:00:00Z', 5000),
      commande('2026-03-13T19:00:00Z', 3000, { status: 'annulee' }),
      commande('2026-03-12T19:00:00Z', 2000),
    ],
    { jours: 7, maintenant: MAINTENANT, timezone: PARIS }
  );
  check('Une commande annulée ne rapporte rien', b.resume.chiffre === 7000, `${b.resume.chiffre}`);
  check("Et ne compte pas dans le nombre de commandes", b.resume.commandes === 2, `${b.resume.commandes}`);
  check('Mais elle se voit dans le taux', b.resume.tauxAnnulation === 33, `${b.resume.tauxAnnulation} %`);
  check('Le panier moyen se calcule sur ce qui a été vendu', b.resume.panierMoyen === 3500, `${b.resume.panierMoyen}`);
  check("Une vente annulée ne compte pas non plus dans les produits",
    b.produits.reduce((s, p) => s + p.chiffre, 0) === 7000);
}

/* ── Nouveaux clients ────────────────────────────────────── */

{
  const b = bilan(
    [
      commande('2025-11-02T19:00:00Z', 4000, { user: { id: 7 } }), // habitué de longue date
      commande('2026-03-13T19:00:00Z', 4000, { user: { id: 7 } }),
      commande('2026-03-13T20:00:00Z', 2000, { user: { id: 8 } }), // première fois
    ],
    { jours: 7, maintenant: MAINTENANT, timezone: PARIS }
  );
  check('Deux clients servis', b.resume.clients === 2, `${b.resume.clients}`);
  check("Un seul est nouveau — l'autre commandait déjà l'an dernier",
    b.resume.nouveaux === 1, `${b.resume.nouveaux}`);
}

/* ── La comparaison à la période précédente ──────────────── */

{
  const b = bilan(
    [
      commande('2026-03-13T19:00:00Z', 6000),  // dans les 7 derniers jours
      commande('2026-03-03T19:00:00Z', 3000),  // dans les 7 jours d'avant
    ],
    { jours: 7, maintenant: MAINTENANT, timezone: PARIS }
  );
  check('La période précédente est comparée', b.resume.chiffreAvant === 3000, `${b.resume.chiffreAvant}`);
  check('Et le sens de la marche est donné', b.resume.evolution === 100, `${b.resume.evolution} %`);
}

{
  const b = bilan([commande('2026-03-13T19:00:00Z', 6000)], { jours: 7, maintenant: MAINTENANT, timezone: PARIS });
  check("Sans période précédente, on ne raconte pas d'histoire",
    b.resume.evolution === null, String(b.resume.evolution));
}

/* ── La fenêtre ──────────────────────────────────────────── */

{
  const b = bilan(
    [
      commande('2026-03-14T19:00:00Z', 1000),
      commande('2026-03-07T19:00:00Z', 1000),  // le 8e jour : dehors
    ],
    { jours: 7, maintenant: MAINTENANT, timezone: PARIS }
  );
  check('Sept jours veut dire sept colonnes', b.parJour.length === 7, `${b.parJour.length}`);
  check('Aujourd hui compris', b.parJour.at(-1).jour === '2026-03-15', b.parJour.at(-1).jour);
  check('Ce qui déborde la fenêtre reste dehors', b.resume.chiffre === 1000, `${b.resume.chiffre}`);
  check('Les jours sans vente gardent leur place', b.parJour.filter((j) => j.chiffre === 0).length === 6);
}

check('Une demande farfelue est ramenée à la raison',
  bilan([], { jours: 100000, maintenant: MAINTENANT }).periode.jours === 365 &&
  bilan([], { jours: -5, maintenant: MAINTENANT }).periode.jours === 1 &&
  bilan([], { jours: 'nawak', maintenant: MAINTENANT }).periode.jours === 30);

check('Un magasin vide ne fait pas planter le bilan',
  bilan([], { maintenant: MAINTENANT }).resume.chiffre === 0 &&
  bilan(null, { maintenant: MAINTENANT }).parJour.length === 30);

check('Une date illisible est écartée, pas propagée',
  bilan([commande('pas-une-date', 5000)], { maintenant: MAINTENANT }).resume.commandes === 0);

/* ── La route ────────────────────────────────────────────── */

const admin = signInitData(TOKEN, { id: 424242, first_name: 'Patron' });
const client = signInitData(TOKEN, { id: 830000 + (Date.now() % 60000), first_name: 'Client' });

let r = await fetch(`${BASE}/api/admin/bilan?jours=7`, { headers: { 'X-Telegram-Init-Data': admin } });
let data = await r.json();
check('Le bilan se sert à l administrateur', r.status === 200 && data.periode?.jours === 7, `HTTP ${r.status}`);
check('Avec ses quatre séries',
  Array.isArray(data.parJour) && Array.isArray(data.produits) &&
  data.heures?.length === 12 && data.semaine?.length === 7);
check('Et son résumé chiffré', typeof data.resume?.chiffre === 'number' && typeof data.resume?.panierMoyen === 'number');

r = await fetch(`${BASE}/api/admin/bilan`, { headers: { 'X-Telegram-Init-Data': client } });
check("Un client ne lit pas le chiffre d'affaires de la boutique", r.status === 403, `HTTP ${r.status}`);

r = await fetch(`${BASE}/api/admin/bilan`);
check('Sans signature non plus', r.status === 401, `HTTP ${r.status}`);

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Bilan et tableau de bord : OK'}`);
process.exit(failures ? 1 : 0);
