import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { resolveFileUrl } from './photos.js';

/**
 * Une copie locale des médias hébergés chez Telegram.
 *
 * Les photos et vidéos ne sont pas recopiées dans le catalogue : on garde la
 * référence Telegram et on relaie le fichier à la demande. C'est ce qui permet
 * de changer d'hébergeur sans rien emporter — mais chaque première vue fait le
 * trajet client → boutique → Telegram → boutique → client, et l'entrepôt de
 * fichiers de Telegram n'est pas un réseau de diffusion. Une vidéo de quinze
 * mégaoctets se fait attendre, et la bande passante du VPS la paie deux fois.
 *
 * On garde donc une copie sur le disque de la boutique : seul le premier
 * visiteur paie le trajet, les suivants sont servis en local. Le dossier est
 * borné et se vide tout seul, du plus ancien vu au plus récent.
 *
 * Rien ici n'est indispensable : là où le disque est en lecture seule
 * (serverless), ou si le vendeur l'éteint, la boutique relaie exactement comme
 * avant. Une panne de cache n'est jamais une panne de boutique.
 */

const DOSSIER =
  config.mediaCache.dir || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'media-cache');
const PLAFOND = config.mediaCache.maxBytes;
const HEURE = 60 * 60 * 1000;

/** Ces pannes-là ne se répareront pas toutes seules : on éteint la copie. */
const DEFINITIF = new Set(['ENOSPC', 'EROFS', 'EACCES', 'EPERM']);

let etat = 'inconnu'; // inconnu | actif | eteint

/** Le dossier est-il utilisable ? Vérifié une fois, puis mémorisé. */
function disponible() {
  if (etat !== 'inconnu') return etat === 'actif';
  if (!PLAFOND) {
    etat = 'eteint';
    return false;
  }
  try {
    fs.mkdirSync(DOSSIER, { recursive: true });
    fs.accessSync(DOSSIER, fs.constants.W_OK);
    etat = 'actif';
  } catch (err) {
    eteindre(err);
  }
  return etat === 'actif';
}

/**
 * Éteint la copie locale, en disant pourquoi.
 *
 * Le message doit se lire dans un journal systemd : un « EROFS » nu n'apprend
 * rien, et la cause est presque toujours un chemin protégé par le service.
 */
function eteindre(err) {
  if (etat === 'eteint') return;
  etat = 'eteint';
  const details =
    {
      EROFS: 'le disque est en lecture seule (c’est le fonctionnement normal en serverless)',
      EACCES: `droits insuffisants sur ${DOSSIER}`,
      EPERM: `opération refusée sur ${DOSSIER} — souvent le ReadWritePaths du service systemd`,
      ENOSPC: 'plus de place sur le disque',
    }[err?.code] ?? err?.message;

  console.warn(
    `\n  ⚠ Copie locale des médias désactivée : ${details}.\n` +
      '    La boutique continue de relayer depuis Telegram : rien ne casse, les\n' +
      '    photos et vidéos se font simplement attendre à leur première vue.\n' +
      '    MEDIA_CACHE_DIR choisit un autre dossier, MEDIA_CACHE_MB=0 éteint tout.\n'
  );
}

/**
 * Le nom des deux fichiers d'une copie.
 *
 * Le contenu d'un `file_id` ne change jamais : son empreinte fait une clé
 * stable, et surtout un nom de fichier sûr — une référence Telegram contient
 * des caractères qui n'ont rien à faire dans un chemin.
 */
function chemins(fileId) {
  const cle = crypto.createHash('sha256').update(String(fileId)).digest('hex').slice(0, 32);
  return { bin: path.join(DOSSIER, `${cle}.bin`), meta: path.join(DOSSIER, `${cle}.json`) };
}

/** La copie locale de ce fichier, si elle existe et qu'elle est entière. */
export async function chercher(fileId) {
  if (!disponible()) return null;
  const { bin, meta } = chemins(fileId);

  try {
    const infos = await fsp.stat(bin);
    const fiche = JSON.parse(await fsp.readFile(meta, 'utf8'));
    // Une copie dont la taille ne colle plus à sa fiche a été tronquée : mieux
    // vaut la refaire que de servir un fichier illisible à tout le monde.
    if (!infos.size || (fiche.taille && fiche.taille !== infos.size)) return null;

    // On note qu'elle vient de servir — c'est ce qui décide qui part quand le
    // dossier déborde. Une fois par heure suffit : toucher le fichier à chaque
    // vue changerait son ETag et ferait revalider le navigateur pour rien.
    if (Date.now() - infos.mtimeMs > HEURE) {
      const maintenant = new Date();
      fsp.utimes(bin, maintenant, maintenant).catch(() => {});
    }
    return { chemin: bin, type: fiche.type, taille: infos.size };
  } catch {
    return null;
  }
}

/**
 * Ouvre une copie en cours d'écriture.
 *
 * Le fichier s'écrit sous un nom provisoire et n'est renommé qu'une fois
 * complet : un arrêt en plein téléchargement ne laisse jamais une demi-vidéo
 * qui serait ensuite servie telle quelle.
 */
export function ouvrirCopie(fileId, type) {
  if (!disponible()) return null;
  const { bin, meta } = chemins(fileId);
  const brouillon = `${bin}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.part`;

  let flux;
  try {
    flux = fs.createWriteStream(brouillon);
  } catch (err) {
    if (DEFINITIF.has(err?.code)) eteindre(err);
    return null;
  }

  let cassee = false;
  flux.on('error', (err) => {
    cassee = true;
    if (DEFINITIF.has(err?.code)) eteindre(err);
    fsp.unlink(brouillon).catch(() => {});
  });

  return {
    flux,

    /** Le client a coupé, ou Telegram a lâché : on ne garde rien. */
    jeter() {
      flux.destroy();
      fsp.unlink(brouillon).catch(() => {});
    },

    /** Le téléchargement est allé au bout : la copie prend sa place. */
    async garder(attendus) {
      try {
        if (!flux.closed) {
          await new Promise((resoudre, rejeter) => {
            flux.once('close', resoudre);
            flux.once('error', rejeter);
          });
        }
        if (cassee) return false;

        const infos = await fsp.stat(brouillon);
        if (!infos.size || (attendus && infos.size !== attendus)) {
          await fsp.unlink(brouillon).catch(() => {});
          return false;
        }

        // La fiche d'abord : une copie sans fiche est ignorée à la lecture,
        // alors qu'une fiche sans copie ne trompe personne.
        await fsp.writeFile(
          `${meta}.part`,
          JSON.stringify({ fileId, type, taille: infos.size, date: new Date().toISOString() })
        );
        await fsp.rename(`${meta}.part`, meta);
        await fsp.rename(brouillon, bin);

        menage().catch(() => {});
        return true;
      } catch (err) {
        if (DEFINITIF.has(err?.code)) eteindre(err);
        await fsp.unlink(brouillon).catch(() => {});
        return false;
      }
    },
  };
}

let menageEnCours = false;

/**
 * Ramène le dossier sous son plafond, et ramasse ce qui traîne.
 *
 * Le plus anciennement servi part le premier : c'est la copie dont l'absence
 * se remarquera le moins. Un brouillon abandonné par un processus mort et une
 * fiche sans copie disparaissent au passage.
 */
export async function menage() {
  if (!disponible() || menageEnCours) return;
  menageEnCours = true;
  try {
    const noms = await fsp.readdir(DOSSIER);
    const maintenant = Date.now();
    const copies = [];
    let total = 0;

    for (const nom of noms) {
      const complet = path.join(DOSSIER, nom);
      const infos = await fsp.stat(complet).catch(() => null);
      if (!infos?.isFile()) continue;

      if (nom.endsWith('.part')) {
        // Un brouillon d'une heure n'attend plus personne.
        if (maintenant - infos.mtimeMs > HEURE) await fsp.unlink(complet).catch(() => {});
        continue;
      }
      if (nom.endsWith('.json')) {
        // Une fiche sans copie : arrêt entre les deux renommages. On laisse
        // passer une minute pour ne pas doubler une écriture en cours.
        const bin = path.join(DOSSIER, nom.replace(/\.json$/, '.bin'));
        if (maintenant - infos.mtimeMs > 60_000 && !fs.existsSync(bin)) {
          await fsp.unlink(complet).catch(() => {});
        }
        continue;
      }
      if (!nom.endsWith('.bin')) continue;

      copies.push({ nom, taille: infos.size, vu: infos.mtimeMs });
      total += infos.size;
    }

    copies.sort((a, b) => a.vu - b.vu);
    while (total > PLAFOND && copies.length) {
      const partant = copies.shift();
      await fsp.unlink(path.join(DOSSIER, partant.nom)).catch(() => {});
      await fsp.unlink(path.join(DOSSIER, partant.nom.replace(/\.bin$/, '.json'))).catch(() => {});
      total -= partant.taille;
    }
  } finally {
    menageEnCours = false;
  }
}

/** De quoi renseigner le bilan de santé, sans révéler de chemin. */
export async function etatDuCache() {
  if (!disponible()) return { actif: false };
  let entrees = 0;
  let octets = 0;
  try {
    for (const nom of await fsp.readdir(DOSSIER)) {
      if (!nom.endsWith('.bin')) continue;
      const infos = await fsp.stat(path.join(DOSSIER, nom)).catch(() => null);
      if (!infos) continue;
      entrees++;
      octets += infos.size;
    }
  } catch {
    return { actif: false };
  }
  return { actif: true, entrees, mo: Math.round((octets / 1048576) * 10) / 10, plafondMo: PLAFOND / 1048576 };
}

/**
 * Une réponse partielle ne fait pas une copie.
 *
 * Un navigateur qui lit une vidéo demande presque toujours « bytes=0- » : la
 * réponse est un 206 qui couvre pourtant tout le fichier. La refuser
 * reviendrait à ne jamais rien garder d'une vidéo — précisément ce qu'on
 * cherche à accélérer.
 */
function reponseEntiere(upstream) {
  if (upstream.status !== 206) return true;
  const morceau = (upstream.headers.get('content-range') ?? '').match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  return Boolean(morceau) && morceau[1] === '0' && Number(morceau[2]) === Number(morceau[3]) - 1;
}

/** Sert la copie locale. Faux si elle a disparu entre-temps. */
function envoyerLaCopie(req, res, copie) {
  return new Promise((resoudre) => {
    res.sendFile(
      copie.chemin,
      { maxAge: '1d', immutable: true, headers: { 'Content-Type': copie.type } },
      (err) => {
        if (!err) return resoudre(true);
        // Le ménage a pu passer entre la lecture et l'envoi : on repart chez
        // Telegram, sauf si la réponse est déjà commencée.
        resoudre(res.headersSent || res.writableEnded);
      }
    );
  });
}

/**
 * Sert un média : la copie locale si on l'a, Telegram sinon — et dans ce cas
 * on garde une copie au passage, sans retarder le client d'une seconde.
 */
export async function servirMedia(req, res, media) {
  const copie = await chercher(media.fileId);
  if (copie && (await envoyerLaCopie(req, res, copie))) return;

  const upstream = await fetch(await resolveFileUrl(media.fileId), {
    headers: req.headers.range ? { Range: req.headers.range } : undefined,
  });
  if (!upstream.ok && upstream.status !== 206) {
    return res.status(502).json({ error: 'Média indisponible.' });
  }

  const type =
    upstream.headers.get('content-type') || (media.kind === 'video' ? 'video/mp4' : 'image/jpeg');

  res.status(upstream.status === 206 ? 206 : 200);
  res.setHeader('Content-Type', type);
  for (const entete of ['content-length', 'content-range', 'accept-ranges']) {
    const valeur = upstream.headers.get(entete);
    if (valeur) res.setHeader(entete, valeur);
  }
  // Le contenu d'un fileId ne change jamais : on le laisse en cache un jour.
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');

  if (!upstream.body) return res.end();

  const attendus = Number(upstream.headers.get('content-length')) || 0;
  const enCours = reponseEntiere(upstream) ? ouvrirCopie(media.fileId, type) : null;

  const source = Readable.fromWeb(upstream.body);
  if (enCours) source.pipe(enCours.flux);

  try {
    await pipeline(source, res);
  } catch (err) {
    enCours?.jeter();
    throw err;
  }
  await enCours?.garder(attendus);
}
