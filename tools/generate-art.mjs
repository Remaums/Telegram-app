/**
 * Génère les illustrations de la boutique.
 *
 * Direction artistique « Mur de nuit » : dégradés doux, formes pleines, pas de
 * gros contours — les visuels doivent tenir sur un fond béton sombre.
 *
 * ⚠️  ÉCRASE les visuels de webapp/assets/ (products/ et ui/). La boutique
 * tourne encore sur la direction cartoon : ne lance ce script qu'une fois la
 * direction « Mur de nuit » retenue. Pour l'essayer sans toucher au dépôt,
 * vise un autre dossier :
 *
 *   ART_OUT=/tmp/apercu node tools/generate-art.mjs
 *
 * Usage :  node tools/generate-art.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { leafParts, leafSvg } from './leaf.mjs';

const root = process.env.ART_OUT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const productsDir = path.join(root, 'webapp/assets/products');
const uiDir = path.join(root, 'webapp/assets/ui');

/** Tous les visuels produits partagent ce gabarit : le cadrage reste homogène. */
const W = 240;
const H = 180;

const wrap = (defs, body, label) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${label}">
  <defs>${defs}</defs>
${body}
</svg>`;

const linear = (id, from, to, vertical = true) =>
  `<linearGradient id="${id}" x1="0" y1="${vertical ? 1 : 0}" x2="${vertical ? 0 : 1}" y2="0">
      <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
    </linearGradient>`;

/* ── Feuille ─────────────────────────────────────────────── */

function leafProduct(id, stops, label) {
  const { defs, group } = leafParts({ id, stops });
  // La feuille est dessinée autour de l'origine : on la recentre dans le gabarit.
  return wrap(defs, `  <g transform="translate(120 148) scale(1.08)">${group}</g>`, label);
}

/* ── Bocal ───────────────────────────────────────────────── */

function jar() {
  const { defs: leafDefs, group } = leafParts({ id: 'jarleaf', stops: ['#8FE06A', '#2F7D32'] });
  const defs =
    leafDefs +
    linear('jar-glass', 'rgba(190,230,255,.10)', 'rgba(190,230,255,.30)') +
    linear('jar-lid', '#B9843C', '#E8B45C') +
    `<clipPath id="jar-clip"><rect x="66" y="52" width="108" height="112" rx="16"/></clipPath>`;

  const body = `  <g>
    <rect x="66" y="52" width="108" height="112" rx="16" fill="url(#jar-glass)"/>
    <g clip-path="url(#jar-clip)">
      <g transform="translate(120 150) scale(.7)">${group}</g>
    </g>
    <rect x="66" y="52" width="108" height="112" rx="16" fill="none"
      stroke="rgba(210,240,255,.45)" stroke-width="3"/>
    <rect x="60" y="30" width="120" height="30" rx="12" fill="url(#jar-lid)"/>
    <rect x="60" y="30" width="120" height="30" rx="12" fill="none" stroke="rgba(0,0,0,.25)" stroke-width="2"/>
    <rect x="78" y="66" width="9" height="82" rx="5" fill="#fff" opacity=".22"/>
  </g>`;
  return wrap(defs, body, 'Bocal de fleurs');
}

/* ── Résine : pavés empilés ──────────────────────────────── */

function hash() {
  const defs =
    linear('hash-top', '#D6A96A', '#A97B44', false) +
    linear('hash-l', '#7A5028', '#5C3A1B') +
    linear('hash-r', '#4A2E14', '#2E1B0C');

  const block = (tx, ty, s) => `
    <g transform="translate(${tx} ${ty}) scale(${s})">
      <path d="M-58,0 L0,-29 L58,0 L0,29 Z" fill="url(#hash-top)"/>
      <path d="M-58,0 L-58,31 L0,60 L0,29 Z" fill="url(#hash-l)"/>
      <path d="M58,0 L58,31 L0,60 L0,29 Z" fill="url(#hash-r)"/>
    </g>`;

  const body = `  <g>
    ${block(120, 104, 1)}
    ${block(120, 78, 0.58)}
  </g>`;
  return wrap(defs, body, 'Blocs de résine pressée');
}

/* ── Comestible : brownie ────────────────────────────────── */

function brownie() {
  const defs = linear('bro-top', '#8A5A32', '#5A3418', false) + linear('bro-side', '#3A2110', '#1E1108');
  const body = `  <g>
    <rect x="58" y="76" width="124" height="58" rx="12" fill="url(#bro-side)"/>
    <rect x="58" y="56" width="124" height="58" rx="12" fill="url(#bro-top)"/>
    <g fill="#2A160A" opacity=".55">
      <circle cx="90" cy="80" r="6"/><circle cx="128" cy="72" r="5"/>
      <circle cx="156" cy="94" r="5.5"/><circle cx="106" cy="100" r="5"/>
      <circle cx="146" cy="66" r="3.5"/>
    </g>
    <path d="M72,68 q20,-8 38,2" stroke="#fff" stroke-opacity=".16" stroke-width="5"
      stroke-linecap="round" fill="none"/>
  </g>`;
  return wrap(defs, body, 'Brownie');
}

/* ── Grinder ─────────────────────────────────────────────── */

function grinder() {
  const { defs: leafDefs, group } = leafParts({ id: 'grleaf', stops: ['#8FE06A', '#2F7D32'] });
  const defs =
    leafDefs +
    linear('gr-top', '#D8DEE4', '#9AA3AC', false) +
    linear('gr-mid', '#A9B0B8', '#6E767E', false) +
    linear('gr-bot', '#858D95', '#565D64', false);

  const body = `  <g>
    <rect x="56" y="112" width="128" height="34" rx="12" fill="url(#gr-bot)"/>
    <rect x="56" y="84" width="128" height="34" rx="12" fill="url(#gr-mid)"/>
    <rect x="56" y="46" width="128" height="44" rx="14" fill="url(#gr-top)"/>
    <g stroke="rgba(0,0,0,.18)" stroke-width="3.5" stroke-linecap="round">
      <path d="M72,54 v26"/><path d="M88,54 v26"/><path d="M152,54 v26"/><path d="M168,54 v26"/>
    </g>
    <g transform="translate(120 86) scale(.40)" opacity=".95">${group}</g>
    <rect x="66" y="94" width="20" height="5" rx="3" fill="#fff" opacity=".35"/>
  </g>`;
  return wrap(defs, body, 'Grinder');
}

/* ── Carton ──────────────────────────────────────────────── */

function box() {
  const { defs: leafDefs, group } = leafParts({ id: 'boxleaf', stops: ['#8FE06A', '#2F7D32'] });
  const defs =
    leafDefs +
    linear('box-top', '#D7A86A', '#B8863F', false) +
    linear('box-l', '#A87B39', '#7E5A28') +
    linear('box-r', '#6E4E22', '#4A3416');

  const body = `  <g>
    <path d="M40,74 L120,38 L200,74 L120,110 Z" fill="url(#box-top)"/>
    <path d="M40,74 L40,124 L120,160 L120,110 Z" fill="url(#box-l)"/>
    <path d="M200,74 L200,124 L120,160 L120,110 Z" fill="url(#box-r)"/>
    <path d="M46,60 L84,42 L124,60 L86,78 Z" fill="#C9974F" opacity=".9"/>
    <path d="M194,60 L156,42 L116,60 L154,78 Z" fill="#E0B884" opacity=".9"/>
    <g transform="translate(120 132) scale(.34)" opacity=".95">${group}</g>
  </g>`;
  return wrap(defs, body, "Carton d'expédition");
}

/* ── Écriture ────────────────────────────────────────────── */

const files = {
  [path.join(productsDir, 'bud.svg')]: leafProduct('bud', ['#8FE06A', '#2F7D32'], 'Fleur de cannabis'),
  [path.join(productsDir, 'bud-sativa.svg')]: leafProduct('buds', ['#E3F24A', '#5C9C2F'], 'Fleur sativa'),
  [path.join(productsDir, 'jar.svg')]: jar(),
  [path.join(productsDir, 'hash.svg')]: hash(),
  [path.join(productsDir, 'cookie.svg')]: brownie(),
  [path.join(productsDir, 'grinder.svg')]: grinder(),
  [path.join(productsDir, 'box.svg')]: box(),

  // Décor : la grande feuille sprayée du fond, et la petite pour le favicon.
  [path.join(uiDir, 'leaf-spray.svg')]: leafSvg({
    id: 'sprayleaf', stops: ['#39FF88', '#0F6B39'], width: 520, spray: true,
  }),
  [path.join(uiDir, 'leaf.svg')]: leafSvg({ id: 'ui', stops: ['#39FF88', '#0F6B39'], width: 120 }),
};

await fs.mkdir(productsDir, { recursive: true });
await fs.mkdir(uiDir, { recursive: true });
for (const [file, contents] of Object.entries(files)) {
  await fs.writeFile(file, contents);
  console.log(`  ${path.relative(root, file)}  ${contents.length} octets`);
}
console.log(`\n${Object.keys(files).length} visuels générés.`);
