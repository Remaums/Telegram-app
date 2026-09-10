/**
 * La copie locale des médias.
 *
 * Une photo ou une vidéo n'est pas recopiée dans le catalogue : la boutique
 * garde la référence Telegram et relaie le fichier. Ce relais coûte un
 * aller-retour jusqu'à Telegram à chaque première vue, et la bande passante du
 * VPS deux fois. La copie locale doit donc faire une chose et une seule : que
 * seul le premier visiteur paie ce trajet.
 *
 * Deux dangers valent tous les gains de vitesse. Servir une copie tronquée —
 * elle le serait alors pour tout le monde, indéfiniment. Et remplir le disque
 * du serveur, ce qui arrête la boutique pour de bon.
 *
 * Cette suite ne dépend pas du serveur de test : elle monte un faux Telegram
 * et une route minimale, et compte les téléchargements.
 *
 * Usage :  node test/cache.test.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';

const RACINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOSSIER = fs.mkdtempSync(path.join(os.tmpdir(), 'medias-'));
const TOKEN = '424242:faux';
const TELEGRAM = 3012;
const BOUTIQUE = 3013;

process.env.BOT_TOKEN = TOKEN;
process.env.TELEGRAM_API_ROOT = `http://localhost:${TELEGRAM}`;
process.env.MEDIA_CACHE_DIR = DOSSIER;
process.env.MEDIA_CACHE_MB = '1';
delete process.env.DATABASE_URL;

const { servirMedia, chercher, ouvrirCopie, menage, etatDuCache } = await import('../server/media-cache.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

/* ── Un faux Telegram ────────────────────────────────────── */

const fichiers = new Map(); // file_id -> { octets, type }
let telechargements = 0;
let resolutions = 0;

const telegram = http.createServer((req, res) => {
  const [, , chemin] = req.url.split('/');

  if (req.url === `/bot${TOKEN}/getFile`) {
    resolutions++;
    let corps = '';
    req.on('data', (d) => (corps += d));
    return req.on('end', () => {
      const { file_id: id } = JSON.parse(corps || '{}');
      if (!fichiers.has(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, description: 'file not found' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { file_path: `docs/${id}` } }));
    });
  }

  const id = decodeURIComponent(req.url.split('/').pop());
  const fichier = fichiers.get(id);
  if (!fichier) {
    res.writeHead(404);
    return res.end();
  }
  telechargements++;

  // Un fichier « menteur » annonce plus d'octets qu'il n'en envoie : c'est ce
  // que donne une coupure côté Telegram, et il ne faut surtout pas en garder
  // une copie.
  if (fichier.ment) {
    res.writeHead(200, { 'Content-Type': fichier.type, 'Content-Length': String(fichier.octets.length + 64) });
    return res.end(fichier.octets);
  }

  // Un fichier « lent » laisse le temps au client de couper en plein milieu.
  if (fichier.lent) {
    res.writeHead(200, { 'Content-Type': fichier.type, 'Content-Length': String(fichier.octets.length) });
    res.write(fichier.octets.subarray(0, 1024));
    return setTimeout(() => res.end(fichier.octets.subarray(1024)), 3000);
  }

  const plage = (req.headers.range ?? '').match(/^bytes=(\d+)-(\d*)$/);
  if (plage) {
    const debut = Number(plage[1]);
    const fin = plage[2] ? Number(plage[2]) : fichier.octets.length - 1;
    const morceau = fichier.octets.subarray(debut, fin + 1);
    res.writeHead(206, {
      'Content-Type': fichier.type,
      'Content-Length': String(morceau.length),
      'Content-Range': `bytes ${debut}-${fin}/${fichier.octets.length}`,
      'Accept-Ranges': 'bytes',
    });
    return res.end(morceau);
  }

  res.writeHead(200, {
    'Content-Type': fichier.type,
    'Content-Length': String(fichier.octets.length),
    'Accept-Ranges': 'bytes',
  });
  res.end(fichier.octets);
});
await new Promise((ok) => telegram.listen(TELEGRAM, ok));

/* ── La boutique, réduite à sa route média ───────────────── */

const app = express();
app.get('/m/:fileId', async (req, res) => {
  try {
    await servirMedia(req, res, { fileId: req.params.fileId, kind: 'video' });
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: err.message });
  }
});
const boutique = app.listen(BOUTIQUE);
const BASE = `http://localhost:${BOUTIQUE}`;

/** Range un fichier chez le faux Telegram. */
function deposer(id, taille, options = {}) {
  const octets = Buffer.alloc(taille);
  for (let i = 0; i < taille; i++) octets[i] = (i * 7 + id.length) % 251;
  fichiers.set(id, { octets, type: 'video/mp4', ...options });
  return octets;
}

const copies = async () => (await fsp.readdir(DOSSIER)).filter((n) => n.endsWith('.bin'));

/* ── Le premier visiteur paie, les suivants non ──────────── */

const petit = deposer('video-1', 40_000);

/** Le client est servi avant que la copie ne soit rangée : le renommage suit
 *  la fin de la réponse, à quelques millisecondes près. */
const battement = () => new Promise((ok) => setTimeout(ok, 250));

let avant = telechargements;
let r = await fetch(`${BASE}/m/video-1`);
let corps = Buffer.from(await r.arrayBuffer());
check('La première vue descend le fichier', r.status === 200 && telechargements === avant + 1);
check('Et le rend intact', corps.equals(petit), `${corps.length} octets`);
await battement();

avant = telechargements;
r = await fetch(`${BASE}/m/video-1`);
corps = Buffer.from(await r.arrayBuffer());
check('La deuxième ne dérange plus Telegram', telechargements === avant, `${telechargements - avant} téléchargement(s)`);
check('Et rend exactement le même fichier', corps.equals(petit));
check('Avec son type', r.headers.get('content-type')?.includes('video/mp4'), r.headers.get('content-type'));
check('Et un cache navigateur long', /max-age=86400/.test(r.headers.get('cache-control') ?? ''),
  r.headers.get('cache-control'));

const trouvee = await chercher('video-1');
check('La copie est sur le disque, entière', trouvee?.taille === petit.length, `${trouvee?.taille} octets`);

// Le chemin d'un fichier ne se redemande pas à chaque vue : Telegram le donne
// pour une heure, et une copie locale n'en a plus besoin du tout.
avant = resolutions;
await fetch(`${BASE}/m/video-1`);
check("Une copie locale ne redemande même pas l'adresse du fichier", resolutions === avant);

/* ── Les plages, celles que demandent les lecteurs ───────── */

// Un navigateur qui lit une vidéo demande « bytes=0- » : la réponse est un 206
// qui couvre pourtant tout le fichier. La refuser reviendrait à ne jamais rien
// garder d'une vidéo.
const entier = deposer('video-2', 30_000);
avant = telechargements;
r = await fetch(`${BASE}/m/video-2`, { headers: { Range: 'bytes=0-' } });
corps = Buffer.from(await r.arrayBuffer());
check('Une demande « bytes=0- » rend tout le fichier', r.status === 206 && corps.equals(entier), `HTTP ${r.status}`);
await battement();

avant = telechargements;
r = await fetch(`${BASE}/m/video-2`);
check('Et elle a suffi à faire la copie', telechargements === avant, `${telechargements - avant} téléchargement(s)`);

// Une vraie plage partielle, en revanche, ne fait pas une copie : la garder
// reviendrait à servir un fichier tronqué à tous les visiteurs suivants.
const morceaux = deposer('video-3', 20_000);
r = await fetch(`${BASE}/m/video-3`, { headers: { Range: 'bytes=100-199' } });
corps = Buffer.from(await r.arrayBuffer());
check('Une plage partielle rend le bon morceau',
  r.status === 206 && corps.equals(morceaux.subarray(100, 200)), `${corps.length} octets`);
await battement();
check("Et ne laisse aucune copie derrière elle", (await chercher('video-3')) === null);

avant = telechargements;
r = await fetch(`${BASE}/m/video-3`);
corps = Buffer.from(await r.arrayBuffer());
check('Le fichier entier se redescend donc, et il est complet',
  telechargements === avant + 1 && corps.equals(morceaux));
await battement();

// Depuis la copie locale, se déplacer dans la vidéo doit marcher aussi : sans
// plages, le lecteur ne sait que rejouer depuis le début.
r = await fetch(`${BASE}/m/video-3`, { headers: { Range: 'bytes=5-9' } });
corps = Buffer.from(await r.arrayBuffer());
check('La copie locale répond aux plages',
  r.status === 206 && corps.equals(morceaux.subarray(5, 10)), `HTTP ${r.status} — ${corps.length} octets`);
check('Avec la bonne étendue', r.headers.get('content-range') === `bytes 5-9/${morceaux.length}`,
  r.headers.get('content-range'));

/* ── Ce qu'on refuse de garder ───────────────────────────── */

deposer('video-menteur', 10_000, { ment: true });
await fetch(`${BASE}/m/video-menteur`).then((x) => x.arrayBuffer()).catch(() => {});
check('Un téléchargement écourté ne laisse pas de copie', (await chercher('video-menteur')) === null);

const lent = deposer('video-lente', 60_000, { lent: true });
const coupure = new AbortController();
const promesse = fetch(`${BASE}/m/video-lente`, { signal: coupure.signal }).then((x) => x.arrayBuffer());
await new Promise((ok) => setTimeout(ok, 300));
coupure.abort();
await promesse.catch(() => {});
await new Promise((ok) => setTimeout(ok, 400));
check('Un client qui coupe ne laisse pas de demi-vidéo', (await chercher('video-lente')) === null);

// Et le fichier reste récupérable ensuite, entier.
fichiers.get('video-lente').lent = false;
corps = Buffer.from(await (await fetch(`${BASE}/m/video-lente`)).arrayBuffer());
check('Le même fichier se redescend ensuite sans séquelle', corps.equals(lent), `${corps.length} octets`);

// Vu de plus près : une copie plus courte que ce qui était annoncé ne doit
// jamais prendre sa place. Servie telle quelle, elle le serait pour tout le
// monde et indéfiniment — une vidéo qui s'arrête au milieu sans raison.
{
  const copie = ouvrirCopie('video-courte', 'video/mp4');
  copie.flux.end(Buffer.alloc(100));
  const gardee = await copie.garder(4096);
  check('Une copie plus courte que prévu est refusée', gardee === false);
  check('Et rien ne reste sur le disque', (await chercher('video-courte')) === null);

  const juste = ouvrirCopie('video-juste', 'video/mp4');
  juste.flux.end(Buffer.alloc(4096));
  check('Une copie complète, elle, est gardée', (await juste.garder(4096)) === true);
  check('Et se relit', (await chercher('video-juste'))?.taille === 4096);

  const vide = ouvrirCopie('video-vide', 'video/mp4');
  vide.flux.end(Buffer.alloc(0));
  check('Une copie vide est refusée', (await vide.garder(0)) === false);
}

/* ── Le dossier ne grossit pas indéfiniment ──────────────── */

// Plafond à 1 Mo : on dépose largement au-delà et on regarde ce qui reste.
for (let i = 0; i < 6; i++) {
  deposer(`gros-${i}`, 300_000);
  await fetch(`${BASE}/m/gros-${i}`).then((x) => x.arrayBuffer());
  await battement();
  // Les copies partagent la même seconde : sans cet écart, « la plus ancienne »
  // ne veut rien dire.
  await new Promise((ok) => setTimeout(ok, 1100));
}
await menage();

const bilan = await etatDuCache();
check('Le dossier reste sous son plafond', bilan.mo <= bilan.plafondMo, `${bilan.mo} Mo / ${bilan.plafondMo} Mo`);
check('Il reste quand même des copies', bilan.entrees >= 2, `${bilan.entrees} copie(s)`);
check('La plus récente est gardée', (await chercher('gros-5')) !== null);
check('La plus ancienne est partie', (await chercher('gros-0')) === null);
check('Et rien ne traîne à côté',
  (await fsp.readdir(DOSSIER)).every((n) => n.endsWith('.bin') || n.endsWith('.json')),
  (await fsp.readdir(DOSSIER)).filter((n) => !n.endsWith('.bin') && !n.endsWith('.json')).join(' '));

/* ── Au redémarrage, et sans copie possible ──────────────── */

// Un autre processus, même dossier : la copie doit resservir telle quelle.
const script = path.join(RACINE, 'test', '.copie-ailleurs.mjs');
fs.writeFileSync(
  script,
  `const { servirMedia } = await import(${JSON.stringify(path.join(RACINE, 'server', 'media-cache.js'))});\n` +
    "import express from 'express';\n" +
    "const app = express();\n" +
    "app.get('/m/:f', async (req, res) => {\n" +
    "  try { await servirMedia(req, res, { fileId: req.params.f, kind: 'video' }); }\n" +
    '  catch (e) { if (!res.headersSent) res.status(502).json({ error: e.message }); }\n' +
    '});\n' +
    'const s = app.listen(0, async () => {\n' +
    '  const r = await fetch(`http://localhost:${s.address().port}/m/${process.argv[2]}`);\n' +
    '  const o = Buffer.from(await r.arrayBuffer());\n' +
    '  console.log(JSON.stringify({ status: r.status, taille: o.length }));\n' +
    '  s.close();\n' +
    '});\n'
);

/** Lance ce script dans un processus neuf. */
const ailleurs = (env, id) =>
  new Promise((resoudre) => {
    execFile('node', [script, id], { cwd: RACINE, env: { ...process.env, ...env } }, (err, out) => {
      resoudre(err ? { erreur: err.message.split('\n').slice(0, 3).join(' ') } : JSON.parse(out.trim().split('\n').pop()));
    });
  });

avant = telechargements;
let dehors = await ailleurs({}, 'gros-5');
check('Un redémarrage retrouve les copies déjà faites',
  dehors.status === 200 && telechargements === avant,
  `HTTP ${dehors.status}, ${telechargements - avant} téléchargement(s)${dehors.erreur ? ` — ${dehors.erreur}` : ''}`);

// Copie éteinte par le vendeur : la boutique doit servir exactement comme avant.
avant = telechargements;
dehors = await ailleurs({ MEDIA_CACHE_MB: '0' }, 'gros-5');
check('Copie éteinte, la boutique sert quand même',
  dehors.status === 200 && dehors.taille === 300_000 && telechargements === avant + 1,
  `HTTP ${dehors.status}${dehors.erreur ? ` — ${dehors.erreur}` : ''}`);

// Dossier impossible : un chemin qui désigne un fichier, pas un dossier. La
// boutique n'a pas à s'arrêter pour si peu.
const obstacle = path.join(DOSSIER, 'pas-un-dossier');
fs.writeFileSync(obstacle, 'x');
avant = telechargements;
dehors = await ailleurs({ MEDIA_CACHE_DIR: obstacle }, 'gros-5');
check('Dossier impossible, la boutique sert quand même',
  dehors.status === 200 && dehors.taille === 300_000 && telechargements === avant + 1,
  `HTTP ${dehors.status}${dehors.erreur ? ` — ${dehors.erreur}` : ''}`);

/* ── Fin ─────────────────────────────────────────────────── */

boutique.close();
telegram.close();
fs.rmSync(script, { force: true });
fs.rmSync(DOSSIER, { recursive: true, force: true });

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Copie locale des médias : OK'}`);
process.exit(failures ? 1 : 0);
