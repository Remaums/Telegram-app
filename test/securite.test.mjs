/**
 * Ce qu'un inconnu ne doit pas pouvoir faire.
 *
 * Chaque bloc ci-dessous correspond à une attaque qui a réellement marché
 * contre cette boutique avant d'être corrigée, ou qui marcherait si une garde
 * sautait. On les rejoue, parce qu'une garde de sécurité qu'aucun test ne
 * pousse est une garde qu'on retirera un jour par inadvertance.
 *
 * Ce qui a été mesuré, puis fermé :
 *
 * - l'épreuve d'entrée tombait au 34ᵉ essai sur 84 combinaisons, sans limite ;
 * - un compte bloqué publiait encore des avis sur les fiches produits,
 *   s'inscrivait aux alertes de stock et sondait les codes promo ;
 * - le relais portait cent messages en dix-huit millisecondes au téléphone du
 *   vendeur, y compris depuis un compte qu'il venait de bloquer ;
 * - vingt-et-un mégaoctets étaient mis en mémoire avant toute vérification de
 *   signature.
 *
 * Prérequis (partie HTTP) : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/securite.test.mjs
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { creerCadence, attenteEnClair } from '../server/cadence.js';
import { signInitData, getShopPass } from './helpers.mjs';

const MOI = fileURLToPath(import.meta.url);
const RACINE = path.join(path.dirname(MOI), '..');
const TROLL = { id: 993001, first_name: 'Troll' };

/* ══ Rôle « ouvrier » : le relais, par les vrais gestionnaires ══ */

if (process.env.SECURITE_OUVRIER) {
  const { bot } = await import('../server/bot.js');
  const { ouvrirLaPorte } = await import('../server/bot-captcha.js');
  const { blockClient, unblockClient } = await import('../server/settings.js');

  const partis = [];
  bot.api.config.use(async (prev, methode, charge) => {
    partis.push({ chat: String(charge.chat_id ?? ''), texte: charge.text ?? '' });
    if (methode === 'getMe') {
      return { ok: true, result: { id: 1, is_bot: true, first_name: 'Bot', username: 'testbot' } };
    }
    return { ok: true, result: { message_id: partis.length, date: 0, chat: { id: charge.chat_id ?? 0, type: 'private' } } };
  });
  bot.botInfo = {
    id: 1, is_bot: true, first_name: 'Bot', username: 'testbot',
    can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business_account: false, has_main_web_app: false,
  };
  await bot.init();
  await ouvrirLaPorte(TROLL.id);

  let compteur = 3000;
  const ADMIN = '424242';
  const ecrire = async (texte) => {
    partis.length = 0;
    await bot.handleUpdate({
      update_id: ++compteur,
      message: {
        message_id: compteur, date: Math.floor(Date.now() / 1000),
        chat: { id: TROLL.id, type: 'private' }, from: { is_bot: false, ...TROLL }, text: texte,
      },
    });
    return [...partis];
  };

  const vu = {};

  // Bloqué : rien ne doit arriver au vendeur, quel que soit le nombre d'essais.
  await blockClient(String(TROLL.id));
  let passes = 0;
  for (let i = 0; i < 30; i += 1) {
    if ((await ecrire(`insulte ${i}`)).some((p) => p.chat === ADMIN)) passes += 1;
  }
  vu.bloqueNePasse = passes === 0;
  // Et il reçoit quand même une réponse : un silence total le ferait réécrire.
  vu.bloqueRecoitUneReponse = (await ecrire('encore')).some((p) => p.chat === String(TROLL.id));
  await unblockClient(String(TROLL.id));

  // Débloqué mais bavard : la cadence borne ce qui arrive au vendeur.
  let relayes = 0;
  for (let i = 0; i < 40; i += 1) {
    if ((await ecrire(`bonjour ${i}`)).some((p) => p.chat === ADMIN)) relayes += 1;
  }
  vu.cadenceBorne = relayes;
  // Passé la borne, le client est prévenu plutôt que laissé sans réponse.
  vu.tropVitePrevient = (await ecrire('encore un'))
    .some((p) => p.chat === String(TROLL.id) && /Réessaie dans/.test(p.texte));

  console.log(JSON.stringify(vu));
  process.exit(0);
}

/* ══ Rôle « chef » ════════════════════════════════════════ */

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
const h = (qui) => ({ 'Content-Type': 'application/json', 'X-Telegram-Init-Data': qui });

console.log('\n── La signature ne se contourne pas ────────────────');

const ADMIN = signInitData(TOKEN, { id: 424242, first_name: 'Patron' });
const CLIENT = signInitData(TOKEN, { id: 993101, first_name: 'Client' });

let r = await fetch(`${BASE}/api/admin/stats`, {
  headers: { 'X-Telegram-Init-Data': new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 424242, first_name: 'FauxPatron' }),
    hash: 'a'.repeat(64),
  }).toString() },
});
check('Un hash inventé n ouvre pas l espace admin', r.status === 401, `HTTP ${r.status}`);

// Le cas qui compte : une signature authentique dont on remplace l'utilisateur.
const detourne = CLIENT.replace(
  /user=[^&]*/,
  `user=${encodeURIComponent(JSON.stringify({ id: 424242, first_name: 'X' }))}`
);
r = await fetch(`${BASE}/api/admin/stats`, { headers: { 'X-Telegram-Init-Data': detourne } });
check('Ni un user remplacé après signature', r.status === 401, `HTTP ${r.status}`);

const perime = signInitData(TOKEN, { id: 993101, first_name: 'Client' }, Math.floor(Date.now() / 1000) - 172800);
r = await fetch(`${BASE}/api/orders`, { method: 'POST', headers: h(perime), body: '{}' });
check('Un initData de 48 h est refusé', r.status === 401, `HTTP ${r.status}`);

console.log('\n── L épreuve ne se balaie pas ──────────────────────');

{
  // 84 combinaisons : sans limite, la bonne tombait au 34ᵉ essai.
  //
  // On ne cherche surtout pas la bonne réponse ici : douze essais sur
  // quatre-vingt-quatre combinaisons, c'est une chance sur sept de tomber
  // dessus par hasard, et le test échouerait un lancement sur sept sans que
  // rien ne soit cassé. On envoie donc des réponses dont on sait qu'elles sont
  // fausses — une sélection vide ne peut pas désigner trois tuiles — et on
  // regarde où le serveur coupe.
  const brute = signInitData(TOKEN, { id: 993200 + Math.floor(Math.random() * 100000), first_name: 'Brute' });
  const epreuve = await (await fetch(`${BASE}/api/captcha`, { headers: h(brute) })).json();

  if (!epreuve.required) {
    check("L'épreuve est désactivée : rien à balayer", true, 'captcha éteint');
  } else {
    const repondre = (selection) =>
      fetch(`${BASE}/api/captcha`, {
        method: 'POST', headers: h(brute),
        body: JSON.stringify({ nonce: epreuve.nonce, expiresAt: epreuve.expiresAt, token: epreuve.token, selection }),
      }).then((res) => res.json());

    let coupeA = null;
    for (let essai = 1; essai <= 30 && coupeA === null; essai += 1) {
      const v = await repondre([]);
      if (/Trop d'essais/.test(v.error ?? '')) coupeA = essai;
    }

    check('Le balayage est coupé avant la 30ᵉ tentative', coupeA !== null, `coupé au ${coupeA}ᵉ essai`);
    check('Et bien avant les 84 combinaisons possibles', coupeA !== null && coupeA <= 20, String(coupeA));
    check('Le refus dit combien de temps attendre',
      /Réessaie dans/.test((await repondre([])).error ?? ''));

    // La coupure vise celui qui insiste, pas la boutique : quelqu'un d'autre
    // doit pouvoir répondre dans la seconde qui suit.
    const voisin = signInitData(TOKEN, { id: 993200 + Math.floor(Math.random() * 100000), first_name: 'Voisin' });
    const sienne = await (await fetch(`${BASE}/api/captcha`, { headers: h(voisin) })).json();
    const essai = await fetch(`${BASE}/api/captcha`, {
      method: 'POST', headers: h(voisin),
      body: JSON.stringify({ nonce: sienne.nonce, expiresAt: sienne.expiresAt, token: sienne.token, selection: [] }),
    }).then((res) => res.json());
    check('Un autre client n est pas puni pour autant',
      !/Trop d'essais/.test(essai.error ?? ''), essai.error ?? '');

    // Et la bonne réponse, elle, passe toujours du premier coup.
    check('Un client qui répond juste entre sans friction',
      Boolean(await getShopPass(BASE, signInitData(TOKEN, { id: 993200 + Math.floor(Math.random() * 100000), first_name: 'Honnete' }))));
  }
}

console.log('\n── Un compte bloqué est bloqué partout ─────────────');

{
  const BANNI = { id: 993301, first_name: 'Banni' };
  const banni = signInitData(TOKEN, BANNI);

  // Un vrai décor : une commande reçue, donc réellement notable.
  const pass = await getShopPass(BASE, banni);
  const cat = await (await fetch(`${BASE}/api/catalog`)).json();
  const produit = cat.products.find((p) => !p.variants || p.variants.some((v) => v.stock > 0));
  const cmd = await (await fetch(`${BASE}/api/orders`, {
    method: 'POST', headers: { ...h(banni), 'X-Shop-Pass': pass },
    body: JSON.stringify({
      items: [{ id: produit.id, variantId: produit.variants?.find((v) => v.stock > 0)?.id ?? null, quantity: 1 }],
      mode: 'pickup', contact: '', note: '',
    }),
  })).json();
  for (const etat of ['confirmee', 'prete']) {
    await fetch(`${BASE}/api/admin/orders/${cmd.reference}/status`, {
      method: 'POST', headers: h(ADMIN), body: JSON.stringify({ status: etat }),
    });
  }

  const epuise = cat.products.find((p) =>
    p.variants ? p.variants.every((v) => Number(v.stock ?? 0) === 0) : Number(p.stock ?? 0) === 0);

  await fetch(`${BASE}/api/admin/clients/${BANNI.id}/block`, { method: 'POST', headers: h(ADMIN) });

  const essais = [
    ['commander', '/api/orders', {
      items: [{ id: produit.id, variantId: produit.variants?.[0]?.id ?? null, quantity: 1 }], mode: 'pickup' }],
    ['donner un avis', '/api/avis', { reference: cmd.reference, notes: { [produit.id]: 1 }, texte: 'ESCROCS' }],
    ['sonder un code promo', '/api/promo', { items: [{ id: produit.id, quantity: 1 }], code: 'TEST' }],
  ];
  if (epuise) {
    essais.push(["s'inscrire à la liste d'attente", '/api/waitlist',
      { id: epuise.id, variantId: epuise.variants?.[0]?.id ?? null }]);
  }

  for (const [quoi, chemin, corps] of essais) {
    const reponse = await fetch(`${BASE}${chemin}`, {
      method: 'POST', headers: { ...h(banni), 'X-Shop-Pass': pass }, body: JSON.stringify(corps),
    });
    check(`Un compte bloqué ne peut pas ${quoi}`, reponse.status === 403, `HTTP ${reponse.status}`);
  }
  if (!epuise) console.log("     (liste d'attente non vérifiée : aucun article épuisé au catalogue)");

  // Le point qui compte vraiment : rien de tout ça n'a atteint la vitrine.
  const vitrine = await (await fetch(`${BASE}/api/avis/${produit.id}`)).json();
  check('Et rien de lui n atteint les fiches produits',
    !vitrine.avis.some((a) => /ESCROCS/.test(a.texte ?? '')));

  await fetch(`${BASE}/api/admin/clients/${BANNI.id}/unblock`, { method: 'POST', headers: h(ADMIN) });
  const board = await (await fetch(`${BASE}/api/admin/avis`, { headers: h(ADMIN) })).json();
  for (const a of board.avis.filter((x) => x.reference === cmd.reference)) {
    await fetch(`${BASE}/api/admin/avis/${a.id}`, { method: 'DELETE', headers: h(ADMIN) });
  }
}

console.log('\n── Ce qu une route publique raconte ────────────────');

r = await fetch(`${BASE}/api/health`);
const sante = JSON.stringify(await r.json());
check('Aucun jeton dans /api/health', !sante.includes(TOKEN));
check('Ni chemin absolu du serveur', !/\/home\/|\/var\/|\/etc\//.test(sante), sante.slice(0, 60));
check('Ni nom de service systemd', !/systemctl|systemd/.test(sante));
check('Ni identifiant d administrateur', !sante.includes('424242'));

for (const chemin of ['/../.env', '/%2e%2e/%2e%2e/.env', '/css/../../.env', '/api/media/..%2f..%2f.env/0']) {
  const res = await fetch(`${BASE}${chemin}`).catch(() => null);
  const corps = res ? await res.text() : '';
  check(`Rien ne sort par ${chemin}`, !/BOT_TOKEN|ADMIN_IDS/.test(corps), `HTTP ${res?.status ?? '—'}`);
}

console.log('\n── On ne fait pas tamponner 21 Mo à un inconnu ─────');

{
  // Ce qui se vérifie ici n'est pas le code de retour — il vaut 401 dans les
  // deux cas — mais *où* le refus tombe. Un JSON volontairement illisible le
  // dit sans ambiguïté : si l'analyseur passe avant le portier, il répond
  // « JSON invalide » (400) et la signature n'a jamais été regardée ; si le
  // portier passe devant, on obtient 401 sans qu'un octet de corps ait été
  // interprété. C'était le défaut : vingt-et-un mégaoctets étaient mis en
  // mémoire pour un inconnu avant que sa signature ne soit même lue.
  const r1 = await fetch(`${BASE}/api/admin/backup/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ ceci n est pas du JSON',
  }).catch(() => null);
  check('Un corps illisible est refusé par la signature, pas par l analyseur',
    r1?.status === 401, `HTTP ${r1?.status ?? 'coupé'} — 400 signifierait que l'analyseur passe devant`);

  // Le même portier couvre les deux chemins de téléversement : ils sont montés
  // ensemble, une seule ligne les protège tous.
  const r2 = await fetch(`${BASE}/api/admin/products/x/media/upload?name=a.jpg`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.alloc(200_000, 0x41),
  }).catch(() => null);
  check('Et le téléversement de médias refuse aussi sans signature',
    r2?.status === 401, `HTTP ${r2?.status ?? 'coupé'}`);

  // Un administrateur, lui, passe le portier et atteint bien la route.
  const r3 = await fetch(`${BASE}/api/admin/backup/inspect`, {
    method: 'POST', headers: h(ADMIN), body: JSON.stringify({ rien: true }),
  }).catch(() => null);
  check('Un administrateur atteint toujours ces routes', r3 && r3.status !== 401, `HTTP ${r3?.status}`);
}

console.log('\n── Le compteur de cadence ──────────────────────────');

{
  const cadence = creerCadence({ max: 3, fenetreMs: 1000, nom: 'essai' });
  check('Les premiers passages sont acceptés',
    [1, 2, 3].every(() => cadence.passer('a').ok));
  const refuse = cadence.passer('a');
  check('Le quatrième est refusé', !refuse.ok);
  check('Et il dit combien de temps attendre', refuse.attente >= 1, `${refuse.attente} s`);
  check('Chacun a son propre compteur', cadence.passer('b').ok);

  // Un passage refusé ne se compte pas : sinon quelqu'un qui insiste
  // repousserait indéfiniment sa propre sortie de pénitence.
  const tard = Date.now() + 1100;
  check('La fenêtre finit par s ouvrir', cadence.passer('a', tard).ok);

  // La mémoire est bornée : sans ça, le compteur deviendrait lui-même le
  // moyen de faire tomber la boutique.
  const large = creerCadence({ max: 1, fenetreMs: 60_000 });
  for (let i = 0; i < 6000; i += 1) large.passer(`inconnu-${i}`);
  check('La mémoire du compteur est bornée', large.suivis() <= 5000, `${large.suivis()} suivis`);

  check('Une attente se lit en français', attenteEnClair(30) === '30 secondes' && attenteEnClair(90) === '2 minutes',
    `${attenteEnClair(30)} / ${attenteEnClair(90)}`);
}

console.log('\n── Le relais vers le téléphone du vendeur ──────────');

const run = promisify(execFile);
const { stdout } = await run('node', [MOI], {
  cwd: RACINE,
  env: { ...process.env, SECURITE_OUVRIER: '1', ADMIN_IDS: '424242', ADMIN_CHAT_ID: '424242', BOT_TOKEN: TOKEN },
});
const ligne = stdout.split('\n').reverse().find((l) => l.trim().startsWith('{'));
const vu = ligne ? JSON.parse(ligne) : {};

check('Un compte bloqué n atteint plus le vendeur', vu.bloqueNePasse === true);
check('Mais il reçoit une réponse, pas un silence', vu.bloqueRecoitUneReponse === true);
check('Un compte bavard est borné', vu.cadenceBorne > 0 && vu.cadenceBorne <= 8, `${vu.cadenceBorne} messages relayés`);
check('Et il est prévenu plutôt que laissé sans réponse', vu.tropVitePrevient === true);

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Sécurité : OK'}`);
process.exit(failures ? 1 : 0);
