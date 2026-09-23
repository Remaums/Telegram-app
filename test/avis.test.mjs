/**
 * Les avis des clients.
 *
 * Un avis ne se donne pas sur un produit qu'on a vu, mais sur un produit qu'on
 * a reçu : c'est toute la valeur de l'étoile affichée sur une carte. Cette
 * suite protège donc surtout ce que la boutique doit refuser — noter la
 * commande d'un autre, noter un article qu'on n'a pas acheté, noter deux fois
 * pour peser double, noter avant d'avoir rien reçu — et ce qu'un avis public ne
 * doit jamais laisser filtrer de celui qui l'a écrit.
 *
 * Prérequis (partie HTTP) : serveur démarré avec ADMIN_IDS contenant 424242.
 * Usage :  BOT_TOKEN=… node test/avis.test.mjs
 */
import 'dotenv/config';
import {
  refusDAvis, noteValide, texteDAvis, resumeParProduit, nomPublic, TEXTE_MAX, DELAI_HEURES,
} from '../server/avis.js';
import { signInitData, getShopPass, franchirLaPorte } from './helpers.mjs';

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

const MAINTENANT = new Date('2026-03-10T12:00:00Z');
const commande = (extra = {}) => ({
  reference: 'CS68-TEST01',
  createdAt: '2026-03-10T11:00:00Z',
  status: 'nouvelle',
  user: { id: 42 },
  items: [{ id: 'kush', name: 'Néon Kush', quantity: 1 }],
  ...extra,
});

console.log('\n── Qui a le droit de noter ─────────────────────────');

check(
  'Une commande annulée ne se note pas',
  /annulée/i.test(refusDAvis(commande({ status: 'annulee' }), { maintenant: MAINTENANT }) ?? ''),
  refusDAvis(commande({ status: 'annulee' }), { maintenant: MAINTENANT })
);
check(
  'Une commande qui vient d être passée non plus',
  refusDAvis(commande(), { maintenant: MAINTENANT }) !== null,
  refusDAvis(commande(), { maintenant: MAINTENANT })
);
check('Et le refus dit quand ce sera possible', /h au plus tard/.test(refusDAvis(commande(), { maintenant: MAINTENANT }) ?? ''));

for (const status of ['prete', 'livree']) {
  check(
    `Une commande « ${status} » se note tout de suite`,
    refusDAvis(commande({ status }), { maintenant: MAINTENANT }) === null
  );
}

// Beaucoup de vendeurs ne font jamais avancer leurs statuts au-delà de
// « confirmée ». Attendre « livrée » interdirait alors tous les avis pour
// toujours, sans que personne ne comprenne pourquoi.
check(
  `Passé ${DELAI_HEURES} h, une commande confirmée se note aussi`,
  refusDAvis(commande({ status: 'confirmee' }), {
    maintenant: new Date('2026-03-11T12:00:00Z'),
  }) === null
);
check(
  'Mais une annulée reste hors de portée, même un mois après',
  refusDAvis(commande({ status: 'annulee' }), { maintenant: new Date('2026-04-11T12:00:00Z') }) !== null
);
check('Et une commande qui n existe pas ne se note pas', refusDAvis(null) !== null);

console.log('\n── Ce qu on accepte d écrire ───────────────────────');

for (const bonne of [1, 2, 3, 4, 5, '4']) {
  check(`${JSON.stringify(bonne)} est une note`, noteValide(bonne) === Number(bonne));
}
for (const mauvaise of [0, 6, -1, 2.5, 'cinq', null, undefined, NaN, Infinity]) {
  check(`${JSON.stringify(mauvaise)} n en est pas une`, noteValide(mauvaise) === null);
}

check('Le texte est détouré et ses espaces resserrés', texteDAvis('  très   frais  ') === 'très frais');
check('Un texte vide est permis : la note suffit', texteDAvis('') === '' && texteDAvis(null) === '');
let leve = false;
try { texteDAvis('a'.repeat(TEXTE_MAX + 1)); } catch { leve = true; }
check(`Au-delà de ${TEXTE_MAX} caractères, c est refusé`, leve);
check('Juste à la limite, ça passe', texteDAvis('a'.repeat(TEXTE_MAX)).length === TEXTE_MAX);

console.log('\n── Ce qu une liste d avis raconte ──────────────────');

{
  const resume = resumeParProduit([
    { productId: 'kush', note: 5, statut: 'publie' },
    { productId: 'kush', note: 4, statut: 'publie' },
    { productId: 'kush', note: 5, statut: 'publie' },
    { productId: 'haze', note: 1, statut: 'publie' },
  ]);
  check('La moyenne se calcule par produit', resume.kush.moyenne === 4.7, `${resume.kush.moyenne}`);
  check('Le nombre aussi', resume.kush.nombre === 3, `${resume.kush.nombre}`);
  check('La répartition dit ce que la moyenne cache', resume.kush.repartition.join(',') === '0,0,0,1,2',
    resume.kush.repartition.join(','));
  check('Chaque produit a la sienne', resume.haze.moyenne === 1);
}

{
  // Un avis masqué ne doit plus peser : sinon la modération ne sert à rien.
  const resume = resumeParProduit([
    { productId: 'kush', note: 5, statut: 'publie' },
    { productId: 'kush', note: 1, statut: 'masque' },
  ]);
  check('Un avis masqué ne pèse plus sur la note', resume.kush.moyenne === 5 && resume.kush.nombre === 1,
    `${resume.kush.moyenne} sur ${resume.kush.nombre}`);
  check(
    'Un produit dont tous les avis sont masqués disparaît du résumé',
    resumeParProduit([{ productId: 'kush', note: 5, statut: 'masque' }]).kush === undefined
  );
}
check('Une liste vide ne fait pas planter le catalogue',
  Object.keys(resumeParProduit([])).length === 0 && Object.keys(resumeParProduit(null)).length === 0);

console.log('\n── Signé ou anonyme ────────────────────────────────');

check('Un avis signé porte le prénom',
  nomPublic({ anonyme: false, user: { firstName: 'Nadia' } }) === 'Nadia');
check('Un avis anonyme n en porte aucun',
  nomPublic({ anonyme: true, user: { firstName: 'Nadia' } }) === null);
check('Sans choix enregistré, on ne devine pas un nom',
  nomPublic({ user: {} }) === null && nomPublic(null) === null);

console.log('\n── Le parcours complet ─────────────────────────────');

const client = signInitData(TOKEN, { id: 888101, first_name: 'Nadia', username: 'nadia_x' });
const autre = signInitData(TOKEN, { id: 888102, first_name: 'Autre' });
const admin = signInitData(TOKEN, { id: 424242, first_name: 'Patron' });
const h = (qui) => ({ 'Content-Type': 'application/json', 'X-Telegram-Init-Data': qui });

// L'épreuve du chat garde aussi la Mini App : un client inventé ici n'a
// jamais écrit au bot, donc jamais calculé. On le fait entrer par la route
// du vendeur — ce que cette suite teste est ailleurs.
await franchirLaPorte(BASE, admin, client, autre);


const catalogue = await (await fetch(`${BASE}/api/catalog`)).json();
const produit = catalogue.products.find((p) => !p.variants || p.variants.some((v) => v.stock > 0));
const pass = await getShopPass(BASE, client);

let r = await fetch(`${BASE}/api/orders`, {
  method: 'POST',
  headers: { ...h(client), 'X-Shop-Pass': pass },
  body: JSON.stringify({
    items: [{ id: produit.id, variantId: produit.variants?.find((v) => v.stock > 0)?.id ?? null, quantity: 1 }],
    mode: 'pickup', contact: '', note: '',
  }),
});
const cmd = await r.json();
check('Une commande est passée', r.status === 201, cmd.reference ?? cmd.error);

const poster = (qui, corps) =>
  fetch(`${BASE}/api/avis`, { method: 'POST', headers: h(qui), body: JSON.stringify(corps) });

r = await poster(client, { reference: cmd.reference, notes: { [produit.id]: 5 } });
check('Trop tôt : la commande n est pas encore reçue', r.status === 409, `HTTP ${r.status}`);

const suggestion = async (qui) => (await (await fetch(`${BASE}/api/avis`, { headers: h(qui) })).json()).aDonner;
// On juge sur CETTE commande, jamais sur le nombre : une exécution précédente
// interrompue laisse des commandes reçues et non notées derrière elle, et
// « il y en a exactement une » deviendrait faux sans que rien ne soit cassé.
const proposee = async (qui, reference) => (await suggestion(qui)).some((c) => c.reference === reference);
check('Rien à noter tant que rien n est reçu', !(await proposee(client, cmd.reference)));

await fetch(`${BASE}/api/admin/orders/${cmd.reference}/status`, {
  method: 'POST', headers: h(admin), body: JSON.stringify({ status: 'confirmee' }),
});
r = await fetch(`${BASE}/api/admin/orders/${cmd.reference}/status`, {
  method: 'POST', headers: h(admin), body: JSON.stringify({ status: 'prete' }),
});
check('Le vendeur la marque prête', r.status === 200, `HTTP ${r.status}`);

const aDonner = (await suggestion(client)).find((c) => c.reference === cmd.reference);
check('Elle apparaît alors dans la suggestion', Boolean(aDonner));
check('Avec ce qu il a pris', aDonner?.produits?.[0]?.id === produit.id);

// La porte : une référence s'affiche dans la conversation du bot, donc la
// connaître ne doit donner aucun droit.
r = await poster(autre, { reference: cmd.reference, notes: { [produit.id]: 1 } });
check('La commande d un autre ne se note pas', r.status === 404, `HTTP ${r.status}`);
check('Et elle n apparaît pas dans sa suggestion', !(await proposee(autre, cmd.reference)));

r = await poster(client, { reference: cmd.reference, notes: { 'produit-fantome': 5 } });
check('Un article absent de la commande est refusé', r.status === 400, (await r.json()).error);

r = await poster(client, { reference: cmd.reference, notes: { [produit.id]: 9 } });
check('Une note hors bornes aussi', r.status === 400, (await r.json()).error);

r = await poster(client, { reference: cmd.reference, notes: {} });
check('Un avis sans aucune note ne veut rien dire', r.status === 400, `HTTP ${r.status}`);

// Un marqueur propre à cette exécution, pour reconnaître son avis parmi ceux du
// même produit. Surtout pas la référence : le texte est publié tel quel, et on
// vérifie plus bas qu'aucune référence ne sort de l'API.
const marqueur = Math.random().toString(36).slice(2, 8);
const dit = `Excellent, vraiment ${marqueur}`;
r = await poster(client, { reference: cmd.reference, notes: { [produit.id]: 5 }, texte: `  ${dit}  ` });
check('Le dépôt passe', r.status === 201, `HTTP ${r.status}`);

const publics = await (await fetch(`${BASE}/api/avis/${produit.id}`)).json();
const sien = publics.avis.find((a) => a.texte === dit);
check('L avis se lit publiquement', Boolean(sien));
check('Signé par défaut : le prénom s affiche', sien?.prenom === 'Nadia', String(sien?.prenom));

// Le même avis, en anonyme : c'est le seul champ qui doit changer.
r = await poster(client, {
  reference: cmd.reference, notes: { [produit.id]: 5 }, texte: dit, anonyme: true,
});
const masqueNom = await (await fetch(`${BASE}/api/avis/${produit.id}`)).json();
const anonyme = masqueNom.avis.find((a) => a.texte === dit);
check('En anonyme, le prénom disparaît', anonyme?.prenom === null, String(anonyme?.prenom));
check('Mais l avis, lui, reste lu', anonyme?.texte === dit && anonyme?.note === 5);
check('Et il compte toujours dans la note', masqueNom.resume.nombre === publics.resume.nombre);

// Rien ne doit permettre de remonter à la personne, anonyme ou pas.
check('Un avis anonyme ne laisse filtrer aucun identifiant',
  !JSON.stringify(anonyme).includes('888101') && !JSON.stringify(anonyme).includes('nadia_x'));

// Le vendeur, lui, voit toujours qui a écrit : l'anonymat vaut vis-à-vis des
// autres clients, pas de la boutique — la commande le dit de toute façon.
const vuDuPanel = await (await fetch(`${BASE}/api/admin/avis`, { headers: h(admin) })).json();
const cotePanel = vuDuPanel.avis.find((a) => a.reference === cmd.reference);
check('Le vendeur voit qui a écrit, même anonyme', String(cotePanel?.user?.id) === '888101');
check('Et sait que c est publié en anonyme', cotePanel?.anonyme === true, String(cotePanel?.anonyme));

// On revient à un avis signé pour la suite.
await poster(client, { reference: cmd.reference, notes: { [produit.id]: 5 }, texte: dit });

// Un avis est public. Le pseudo et l'identifiant Telegram, non : personne n'a
// signé pour que sa page Telegram le devienne avec.
const brut = JSON.stringify(publics.avis);
check('Sans le pseudo Telegram', !brut.includes('nadia_x'));
check('Ni l identifiant', !brut.includes('888101'));
check('Ni la référence de commande', !brut.includes(cmd.reference));

const avant = publics.resume.nombre;
r = await poster(client, { reference: cmd.reference, notes: { [produit.id]: 3 }, texte: 'Finalement moyen.' });
check('Il peut se raviser', r.status === 201, `HTTP ${r.status}`);

const apres = await (await fetch(`${BASE}/api/avis/${produit.id}`)).json();
check('Un deuxième envoi remplace, il n ajoute pas', apres.resume.nombre === avant, `${avant} → ${apres.resume.nombre}`);
check('La suggestion a disparu une fois l avis donné', !(await proposee(client, cmd.reference)));

// Une étoile touchée dans la conversation du bot laisse une note sans un mot :
// la boutique doit continuer à proposer d'en ajouter un, sinon ce geste d'une
// seconde ferme la porte au commentaire.
{
  const pass2 = await getShopPass(BASE, client);
  const r2 = await fetch(`${BASE}/api/orders`, {
    method: 'POST', headers: { ...h(client), 'X-Shop-Pass': pass2 },
    body: JSON.stringify({
      items: [{ id: produit.id, variantId: produit.variants?.find((v) => v.stock > 0)?.id ?? null, quantity: 1 }],
      mode: 'pickup', contact: '', note: '',
    }),
  });
  const nue = await r2.json();
  check('Une deuxième commande est passée', r2.status === 201, `HTTP ${r2.status} — ${nue.error ?? nue.reference}`);
  for (const etat of ['confirmee', 'prete']) {
    await fetch(`${BASE}/api/admin/orders/${nue.reference}/status`, {
      method: 'POST', headers: h(admin), body: JSON.stringify({ status: etat }),
    });
  }
  await poster(client, { reference: nue.reference, notes: { [produit.id]: 5 }, texte: '', anonyme: true });

  const encore = (await suggestion(client)).find((c) => c.reference === nue.reference);
  check('Une note sans commentaire reste proposée', Boolean(encore));
  check('Et l écran rouvre sur ce qui avait été mis', encore?.deja?.notes?.[produit.id] === 5,
    JSON.stringify(encore?.deja));
  check('Son choix d anonymat aussi', encore?.deja?.anonyme === true);

  await poster(client, { reference: nue.reference, notes: { [produit.id]: 5 }, texte: 'Le mot qui manquait.' });
  check('Une fois le mot ajouté, elle ne revient plus',
    !(await suggestion(client)).some((c) => c.reference === nue.reference));

  const aEffacer = await (await fetch(`${BASE}/api/admin/avis`, { headers: h(admin) })).json();
  for (const a of aEffacer.avis.filter((x) => x.reference === nue.reference)) {
    await fetch(`${BASE}/api/admin/avis/${a.id}`, { method: 'DELETE', headers: h(admin) });
  }
}

const catalogue2 = await (await fetch(`${BASE}/api/catalog`)).json();
check('La note voyage avec le catalogue', typeof catalogue2.notes?.[produit.id]?.moyenne === 'number',
  JSON.stringify(catalogue2.notes?.[produit.id]));

console.log('\n── La modération ───────────────────────────────────');

const board = await (await fetch(`${BASE}/api/admin/avis`, { headers: h(admin) })).json();
const cible = board.avis.find((a) => a.reference === cmd.reference);
check('Le panel voit l avis, avec le nom du produit', cible?.produit === produit.name, String(cible?.produit));
check('Et sait qui l a écrit', String(cible?.user?.id) === '888101');
check('La boutique a une note moyenne', typeof board.moyenne === 'number', String(board.moyenne));

r = await fetch(`${BASE}/api/admin/avis/${cible.id}/reponse`, {
  method: 'POST', headers: h(admin), body: JSON.stringify({ texte: 'Merci, on note pour la prochaine.' }),
});
check('Le vendeur répond', r.status === 200, `HTTP ${r.status}`);
const repondu = await (await fetch(`${BASE}/api/avis/${produit.id}`)).json();
check('Sa réponse se lit sous l avis',
  repondu.avis.some((a) => /on note pour la prochaine/.test(a.reponse?.texte ?? '')));

r = await fetch(`${BASE}/api/admin/avis/${cible.id}/statut`, {
  method: 'POST', headers: h(admin), body: JSON.stringify({ statut: 'masque' }),
});
check('Le vendeur masque', r.status === 200, `HTTP ${r.status}`);
const masque = await (await fetch(`${BASE}/api/avis/${produit.id}`)).json();
check('L avis masqué ne s affiche plus', !masque.avis.some((a) => a.id === cible.id));

// Masquer doit résister à une correction du client : sans ça, il suffirait de
// réécrire son avis pour défaire la modération.
// Le texte public ne porte pas la référence, et c'est voulu : pour reconnaître
// son avis parmi ceux du même produit, on le signe de sa propre référence.
const marque = `Je réécris ${marqueur}`;
r = await poster(client, { reference: cmd.reference, notes: { [produit.id]: 5 }, texte: marque });
const apresCorrection = await (await fetch(`${BASE}/api/avis/${produit.id}`)).json();
check('Un avis masqué ne se republie pas d une correction du client',
  !apresCorrection.avis.some((a) => a.texte === marque), `HTTP ${r.status}`);

r = await fetch(`${BASE}/api/admin/avis/${cible.id}/statut`, {
  method: 'POST', headers: h(admin), body: JSON.stringify({ statut: 'publie' }),
});
check('Masquer se défait', r.status === 200, `HTTP ${r.status}`);
r = await fetch(`${BASE}/api/admin/avis/${cible.id}/statut`, {
  method: 'POST', headers: h(admin), body: JSON.stringify({ statut: 'nimporte-quoi' }),
});
check('Un statut inconnu est refusé', r.status === 400, `HTTP ${r.status}`);

console.log('\n── La porte ────────────────────────────────────────');

for (const [quoi, appel] of [
  ['lire le panel des avis', () => fetch(`${BASE}/api/admin/avis`, { headers: h(client) })],
  ['masquer un avis', () => fetch(`${BASE}/api/admin/avis/${cible.id}/statut`, {
    method: 'POST', headers: h(client), body: JSON.stringify({ statut: 'masque' }) })],
  ['répondre à un avis', () => fetch(`${BASE}/api/admin/avis/${cible.id}/reponse`, {
    method: 'POST', headers: h(client), body: JSON.stringify({ texte: 'coucou' }) })],
  ['supprimer un avis', () => fetch(`${BASE}/api/admin/avis/${cible.id}`, { method: 'DELETE', headers: h(client) })],
]) {
  const reponse = await appel();
  check(`Un client ne peut pas ${quoi}`, reponse.status === 403, `HTTP ${reponse.status}`);
}

r = await fetch(`${BASE}/api/avis`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ reference: cmd.reference, notes: { [produit.id]: 5 } }) });
check('Sans signature, on ne dépose rien', r.status === 401, `HTTP ${r.status}`);

r = await fetch(`${BASE}/api/avis`, { headers: { 'Content-Type': 'application/json' } });
check('Ni ne lit les commandes à noter', r.status === 401, `HTTP ${r.status}`);

// Le nettoyage : la suite doit pouvoir tourner deux fois d'affilée. On efface
// TOUS les avis de la commande, pas seulement celui qu'on avait en main — un
// bug qui en laisserait deux polluerait la suite suivante en silence.
const restants = await (await fetch(`${BASE}/api/admin/avis`, { headers: h(admin) })).json();
for (const a of restants.avis.filter((x) => x.reference === cmd.reference)) {
  await fetch(`${BASE}/api/admin/avis/${a.id}`, { method: 'DELETE', headers: h(admin) });
}

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Avis : OK'}`);
process.exit(failures ? 1 : 0);
