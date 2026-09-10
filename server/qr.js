/**
 * Générateur de QR code, sans dépendance.
 *
 * Le besoin est étroit : encoder une URL courte de la boutique pour qu'elle
 * tienne sur un flyer. On s'en tient donc au strict nécessaire — mode octet,
 * correction d'erreur moyenne, versions 1 à 10 (jusqu'à 271 caractères) — et
 * on rend du SVG, qui reste net à n'importe quelle taille d'impression.
 *
 * Ajouter une bibliothèque pour ça aurait été plus court à écrire, mais la
 * boutique tourne sur un VPS modeste et chaque dépendance est une mise à jour
 * de sécurité à suivre. Le format QR, lui, est figé depuis 2006.
 */

import { deflateSync } from 'node:zlib';

/* ── Corps de Galois GF(256) ─────────────────────────────────
   Les codes de Reed-Solomon travaillent dans ce corps : la multiplication y
   passe par des tables de logarithmes, ce qui la ramène à une addition. */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // polynôme générateur du corps
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/**
 * Polynôme générateur pour `degre` octets de correction.
 *
 * Le produit des (x + α⁰)(x + α¹)…, coefficients rangés du plus haut degré au
 * plus bas — c'est dans cet ordre que la division les consomme, et le premier
 * doit donc valoir 1.
 */
function generateur(degre) {
  let poly = [1];
  for (let i = 0; i < degre; i++) {
    const suivant = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      suivant[j] ^= poly[j];                    // multiplication par x
      suivant[j + 1] ^= mul(poly[j], EXP[i]);   // plus α^i fois le polynôme
    }
    poly = suivant;
  }
  return poly;
}

function correction(donnees, degre) {
  const gen = generateur(degre);
  const reste = new Array(degre).fill(0);

  for (const octet of donnees) {
    const facteur = octet ^ reste[0];
    reste.shift();
    reste.push(0);
    if (facteur !== 0) {
      for (let i = 0; i < degre; i++) reste[i] ^= mul(gen[i + 1], facteur);
    }
  }
  return reste;
}

/* ── Tables de capacité (correction M, mode octet) ──────────
   Pour chaque version : nombre d'octets de correction par bloc, et
   découpage en blocs. Tirées de la norme ISO/IEC 18004. */

const VERSIONS = [
  //  v   ec/bloc   groupe1[blocs, octets]   groupe2[blocs, octets]
  [1, 10, [1, 16], [0, 0]],
  [2, 16, [1, 28], [0, 0]],
  [3, 26, [1, 44], [0, 0]],
  [4, 18, [2, 32], [0, 0]],
  [5, 24, [2, 43], [0, 0]],
  [6, 16, [4, 27], [0, 0]],
  [7, 18, [4, 31], [0, 0]],
  [8, 22, [2, 38], [2, 39]],
  [9, 22, [3, 36], [2, 37]],
  [10, 26, [4, 43], [1, 44]],
];

const ALIGNEMENTS = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

/** La plus petite version qui accueille ce texte. */
function choisirVersion(octets) {
  for (const [v, ec, g1, g2] of VERSIONS) {
    const capacite = g1[0] * g1[1] + g2[0] * g2[1];
    // 4 bits de mode + 8 ou 16 bits de longueur, arrondi à l'octet supérieur.
    const entete = v < 10 ? 12 : 20;
    if (octets.length + Math.ceil(entete / 8) <= capacite) return [v, ec, g1, g2];
  }
  throw new Error('Texte trop long pour un QR code de cette taille.');
}

/* ── Construction ────────────────────────────────────────── */

function bitsDeDonnees(octets, version, capacite) {
  const bits = [];
  const pousser = (valeur, taille) => {
    for (let i = taille - 1; i >= 0; i--) bits.push((valeur >> i) & 1);
  };

  pousser(0b0100, 4); // mode octet
  pousser(octets.length, version < 10 ? 8 : 16);
  for (const o of octets) pousser(o, 8);

  // Terminateur, puis alignement sur l'octet.
  const max = capacite * 8;
  for (let i = 0; i < 4 && bits.length < max; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);

  // Remplissage jusqu'à la capacité, avec les deux octets prévus par la norme.
  const bourrage = [0xec, 0x11];
  let i = 0;
  while (bits.length < max) pousser(bourrage[i++ % 2], 8);

  const donnees = [];
  for (let j = 0; j < bits.length; j += 8) {
    donnees.push(parseInt(bits.slice(j, j + 8).join(''), 2));
  }
  return donnees;
}

/** Entrelace les blocs de données et de correction, comme l'exige la norme. */
function entrelacer(donnees, ec, g1, g2) {
  const blocs = [];
  let curseur = 0;
  for (const [nombre, taille] of [g1, g2]) {
    for (let i = 0; i < nombre; i++) {
      blocs.push(donnees.slice(curseur, curseur + taille));
      curseur += taille;
    }
  }

  const corrections = blocs.map((b) => correction(b, ec));
  const sortie = [];

  const plusLong = Math.max(...blocs.map((b) => b.length));
  for (let i = 0; i < plusLong; i++) {
    for (const bloc of blocs) if (i < bloc.length) sortie.push(bloc[i]);
  }
  for (let i = 0; i < ec; i++) {
    for (const c of corrections) sortie.push(c[i]);
  }
  return sortie;
}

/** Motifs fixes : les trois cibles d'angle, les alignements, les horloges. */
function squelette(taille, version) {
  const m = Array.from({ length: taille }, () => new Array(taille).fill(null));

  const cible = (x, y) => {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const px = x + dx;
        const py = y + dy;
        if (px < 0 || py < 0 || px >= taille || py >= taille) continue;
        const bord = dx >= 0 && dx <= 6 && (dy === 0 || dy === 6);
        const cote = dy >= 0 && dy <= 6 && (dx === 0 || dx === 6);
        const coeur = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
        m[py][px] = bord || cote || coeur ? 1 : 0;
      }
    }
  };
  cible(0, 0);
  cible(taille - 7, 0);
  cible(0, taille - 7);

  for (const cx of ALIGNEMENTS[version]) {
    for (const cy of ALIGNEMENTS[version]) {
      if (m[cy][cx] !== null) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const bord = Math.abs(dx) === 2 || Math.abs(dy) === 2;
          m[cy + dy][cx + dx] = bord || (dx === 0 && dy === 0) ? 1 : 0;
        }
      }
    }
  }

  for (let i = 8; i < taille - 8; i++) {
    m[6][i] = i % 2 === 0 ? 1 : 0;
    m[i][6] = i % 2 === 0 ? 1 : 0;
  }
  m[taille - 8][8] = 1; // module toujours noir

  return m;
}

/** Les huit masques de la norme, appliqués au module (x, y). */
const MASQUES = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/**
 * Où vont les quinze bits de format, en double exemplaire.
 *
 * Cette liste sert à deux choses : réserver ces modules avant de poser les
 * données, et les écrire ensuite. Les décrire deux fois, c'était laisser trois
 * modules réservés pour rien — jamais remplis, donc jamais lisibles.
 *
 * @returns {[number, number][][]} pour chaque bit, ses une ou deux positions
 */
function positionsFormat(taille) {
  const par = [];
  for (let i = 0; i <= 14; i++) {
    const places = [];

    // Copie autour de la cible haut-gauche.
    if (i <= 5) places.push([i, 8]);
    else if (i === 6) places.push([7, 8]);
    else if (i === 7) places.push([8, 8]);
    else if (i === 8) places.push([8, 7]);
    else places.push([8, 14 - i]);

    // Copie répartie sous la cible haut-droite et à droite de la bas-gauche.
    if (i <= 7) places.push([taille - 1 - i, 8]);
    else places.push([8, taille - 15 + i]);

    par.push(places);
  }
  return par;
}

/**
 * À partir de la version 7, deux blocs annoncent le numéro de version.
 *
 * Dix-huit modules près de la cible haut-droite, et les mêmes transposés près
 * de la bas-gauche. Sans eux, un lecteur ne sait pas quelle grille il regarde :
 * les versions 1 à 6 se lisent à la taille, au-delà il faut le dire.
 *
 * @returns {[number, number][]} les positions du bit i, ou une liste vide
 */
function positionsVersion(taille, version) {
  if (version < 7) return [];

  const places = [];
  for (let i = 0; i < 18; i++) {
    const ligne = Math.floor(i / 3);
    const colonne = i % 3;
    places.push([
      [ligne, taille - 11 + colonne],        // bloc sous la cible haut-droite
      [taille - 11 + colonne, ligne],        // bloc à droite de la bas-gauche
    ]);
  }
  return places;
}

function poserVersion(m, version) {
  const places = positionsVersion(m.length, version);
  if (!places.length) return;

  // Code BCH(18,6) : six bits de version, douze de correction. Le générateur
  // est x¹²+x¹¹+x¹⁰+x⁹+x⁸+x⁵+x²+1, soit treize bits — l'écrire plus court
  // donnait un reste faux et un lecteur qui ne reconnaissait plus la version.
  let reste = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((reste >> i) & 1) reste ^= 0b1111100100101 << (i - 12);
  }
  const info = (version << 12) | (reste & 0xfff);

  places.forEach((deux, i) => {
    const bit = (info >> i) & 1;
    for (const [x, y] of deux) m[y][x] = bit;
  });
}

/** Bandes d'information sur le format : niveau de correction et masque. */
function poserFormat(m, masque) {
  // Correction M = 0b00, puis le numéro de masque, sur cinq bits.
  const bits = (0b00 << 3) | masque;

  // Code BCH(15,5) : on divise par le polynôme générateur et on garde le reste.
  let reste = bits << 10;
  for (let i = 14; i >= 10; i--) {
    if ((reste >> i) & 1) reste ^= 0b10100110111 << (i - 10);
  }
  const format = ((bits << 10) | (reste & 0x3ff)) ^ 0b101010000010010;

  positionsFormat(m.length).forEach((places, i) => {
    const bit = (format >> i) & 1;
    for (const [x, y] of places) m[y][x] = bit;
  });
}

/** Pénalité d'un masque : la norme préfère les motifs les moins réguliers. */
function penalite(m) {
  const n = m.length;
  let score = 0;

  // Suites de cinq modules identiques ou plus.
  for (const parLigne of [true, false]) {
    for (let a = 0; a < n; a++) {
      let precedent = -1;
      let suite = 0;
      for (let b = 0; b < n; b++) {
        const v = parLigne ? m[a][b] : m[b][a];
        if (v === precedent) suite++;
        else {
          if (suite >= 5) score += suite - 2;
          precedent = v;
          suite = 1;
        }
      }
      if (suite >= 5) score += suite - 2;
    }
  }

  // Carrés de 2 × 2 de même couleur.
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const v = m[y][x];
      if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) score += 3;
    }
  }

  // Déséquilibre entre modules noirs et blancs.
  const noirs = m.flat().filter((v) => v === 1).length;
  score += Math.floor(Math.abs((noirs * 100) / (n * n) - 50) / 5) * 10;

  return score;
}

/**
 * Encode un texte en matrice de modules.
 * @returns {number[][]} 1 = module noir, 0 = blanc
 */
export function encode(texte) {
  const octets = [...new TextEncoder().encode(String(texte))];
  const [version, ec, g1, g2] = choisirVersion(octets);
  const capacite = g1[0] * g1[1] + g2[0] * g2[1];
  const taille = 17 + version * 4;

  const flux = entrelacer(bitsDeDonnees(octets, version, capacite), ec, g1, g2);

  const base = squelette(taille, version);
  const reserve = base.map((ligne) => ligne.map((v) => v !== null));
  // Exactement les modules que `poserFormat` et `poserVersion` écriront :
  // ni plus, ni moins.
  for (const places of positionsFormat(taille)) {
    for (const [x, y] of places) reserve[y][x] = true;
  }
  for (const places of positionsVersion(taille, version)) {
    for (const [x, y] of places) reserve[y][x] = true;
  }

  // Le flux serpente de bas en haut, deux colonnes à la fois, en sautant la
  // colonne d'horloge.
  const bits = flux.flatMap((o) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (o >> i) & 1));
  const grille = base.map((ligne) => [...ligne]);
  let curseur = 0;
  let montant = true;

  for (let droite = taille - 1; droite > 0; droite -= 2) {
    if (droite === 6) droite--;
    for (let pas = 0; pas < taille; pas++) {
      const y = montant ? taille - 1 - pas : pas;
      for (const x of [droite, droite - 1]) {
        if (reserve[y][x]) continue;
        grille[y][x] = curseur < bits.length ? bits[curseur++] : 0;
      }
    }
    montant = !montant;
  }

  // On essaie les huit masques et on garde le moins pénalisé.
  let meilleur = null;
  for (let masque = 0; masque < 8; masque++) {
    const essai = grille.map((ligne) => [...ligne]);
    for (let y = 0; y < taille; y++) {
      for (let x = 0; x < taille; x++) {
        if (!reserve[y][x] && MASQUES[masque](x, y)) essai[y][x] ^= 1;
      }
    }
    poserFormat(essai, masque);
    poserVersion(essai, version);
    const score = penalite(essai);
    if (!meilleur || score < meilleur.score) meilleur = { score, matrice: essai };
  }

  return meilleur.matrice;
}

/**
 * Rend le QR en SVG.
 *
 * Un seul chemin plutôt qu'un rectangle par module : le fichier passe de
 * plusieurs centaines de balises à une seule, ce qui compte quand on l'envoie
 * dans une conversation ou qu'on l'imprime.
 */
export function toSvg(texte, { module = 8, marge = 4, fond = '#ffffff', trait = '#000000' } = {}) {
  const matrice = encode(texte);
  const n = matrice.length;
  const cote = (n + marge * 2) * module;

  const chemin = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (matrice[y][x]) {
        chemin.push(`M${(x + marge) * module} ${(y + marge) * module}h${module}v${module}h-${module}z`);
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${cote}" height="${cote}" ` +
    `viewBox="0 0 ${cote} ${cote}" shape-rendering="crispEdges" role="img" ` +
    `aria-label="QR code">` +
    `<rect width="${cote}" height="${cote}" fill="${fond}"/>` +
    `<path d="${chemin.join('')}" fill="${trait}"/>` +
    `</svg>`
  );
}

/* ── Rendu PNG ───────────────────────────────────────────────
   Le SVG est parfait dans un navigateur, mais Telegram ne l'affiche pas : un
   `.svg` arrive en pièce jointe que le vendeur doit ouvrir ailleurs. Un PNG,
   lui, s'affiche dans la conversation et se glisse directement dans un flyer.
   Node sait déjà compresser en zlib, il ne reste que l'enveloppe à écrire. */

const TABLE_CRC = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Un bloc PNG : longueur, type, données, et le CRC des deux derniers. */
function bloc(type, donnees) {
  const entete = Buffer.alloc(8);
  entete.writeUInt32BE(donnees.length, 0);
  entete.write(type, 4, 'latin1');
  const somme = Buffer.alloc(4);
  somme.writeUInt32BE(crc32(Buffer.concat([entete.subarray(4), donnees])), 0);
  return Buffer.concat([entete, donnees, somme]);
}

/**
 * Rend le QR en PNG.
 *
 * Niveaux de gris sur un bit : l'image n'a que deux couleurs, inutile d'en
 * stocker plus. Un QR de la plus grande version tient alors en deux kilo-octets.
 */
export function toPng(texte, { module = 8, marge = 4 } = {}) {
  const matrice = encode(texte);
  const n = matrice.length;
  const cote = (n + marge * 2) * module;
  const parLigne = Math.ceil(cote / 8);

  // Une ligne d'image = un octet de filtre (0, aucun) puis les pixels.
  const brut = Buffer.alloc((parLigne + 1) * cote, 0);
  for (let y = 0; y < cote; y++) {
    const depart = y * (parLigne + 1) + 1;
    const ligne = Math.floor(y / module) - marge;
    for (let x = 0; x < cote; x++) {
      const col = Math.floor(x / module) - marge;
      const noir =
        ligne >= 0 && ligne < n && col >= 0 && col < n && matrice[ligne][col];
      // 1 = blanc, 0 = noir : on part donc de tout noir et on allume le fond.
      if (!noir) brut[depart + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cote, 0);
  ihdr.writeUInt32BE(cote, 4);
  ihdr[8] = 1; // un bit par pixel
  ihdr[9] = 0; // niveaux de gris
  ihdr[10] = 0; // compression zlib
  ihdr[11] = 0; // filtrage standard
  ihdr[12] = 0; // pas d'entrelacement

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloc('IHDR', ihdr),
    bloc('IDAT', deflateSync(brut, { level: 9 })),
    bloc('IEND', Buffer.alloc(0)),
  ]);
}
