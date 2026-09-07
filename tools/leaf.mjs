/**
 * Géométrie de la feuille de cannabis.
 *
 * Chaque foliole est construite point par point avec de vraies dentelures
 * plutôt qu'approximée par des courbes : c'est ce qui la rend crédible, y
 * compris en grand format sur le fond de la boutique.
 */

/**
 * Demi-largeur de la foliole à la position `t` (0 = base, 1 = pointe).
 * Le maximum tombe vers t = 0,30 : la foliole s'élargit vite puis file en
 * longue pointe. Le facteur 3,025 normalise la courbe pour que `width` soit
 * exactement la demi-largeur maximale.
 */
function envelope(t, width) {
  return width * 3.025 * Math.pow(t, 0.55) * Math.pow(1 - t, 1.25);
}

function leafletPath({ length = 100, width = 12, teeth = 13 } = {}) {
  const left = [];
  const right = [];

  for (let i = 0; i <= teeth; i++) {
    const t = i / teeth;
    const env = envelope(t, width);
    const y = -length * t;

    const notch = env * 0.66; // creux entre deux dents
    left.push([-notch, y]);
    right.push([notch, y]);

    if (i === teeth) break;

    // Pointe de la dent, tirée vers l'apex : c'est cette inclinaison qui
    // donne la dentelure en scie plutôt qu'en créneau.
    const tMid = (i + 0.5) / teeth;
    const envMid = envelope(tMid, width);
    const yTip = -length * tMid - length * 0.055;
    left.push([-envMid, yTip]);
    right.push([envMid, yTip]);
  }

  const fmt = ([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`;
  const up = left.map(fmt).join(' L');
  const down = right.reverse().map(fmt).join(' L');
  return `M0,2 L${up} L0,${(-length * 1.06).toFixed(1)} L${down} Z`;
}

/** Disposition des sept folioles : angle et échelle. */
const GEOMETRY = [
  { rot: 0, scale: 1.0 },
  { rot: 30, scale: 0.93 }, { rot: -30, scale: 0.93 },
  { rot: 58, scale: 0.76 }, { rot: -58, scale: 0.76 },
  { rot: 80, scale: 0.44 }, { rot: -80, scale: 0.44 },
];

/**
 * Feuille complète en SVG.
 *
 * @param {object} opts
 * @param {string} opts.id       préfixe des identifiants de defs (unique par page)
 * @param {string[]} opts.stops  dégradé, du cœur vers la pointe
 * @param {number} opts.width    largeur du SVG rendu
 * @param {boolean} opts.spray   applique le filtre bord-de-bombe
 */
/**
 * Parties réutilisables de la feuille, pour l'embarquer dans un autre SVG.
 * @returns {{defs: string, group: string}}
 */
export function leafParts({ id = 'leaf', stops = ['#8FE06A', '#2F7D32'], vein = null, spray = false } = {}) {
  const path = leafletPath();
  const veinColor = vein ?? stops[1];

  const defs =
    `<linearGradient id="${id}-grad" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="${stops[0]}"/>
      <stop offset="1" stop-color="${stops[1]}"/>
    </linearGradient>` +
    (spray
      ? `<filter id="${id}-spray" x="-25%" y="-25%" width="150%" height="150%">
      <feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves="4" seed="3" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="4.5" xChannelSelector="R" yChannelSelector="G"/>
    </filter>`
      : '');

  const leaflets = GEOMETRY.map(
    ({ rot, scale }) => `<g transform="rotate(${rot}) scale(${scale})">
        <path d="${path}" fill="url(#${id}-grad)"/>
        <path d="M0,0 L0,-82" stroke="${veinColor}" stroke-width="${(1.1 / scale).toFixed(2)}"
          stroke-linecap="round" opacity=".3" fill="none"/>
      </g>`
  ).join('\n      ');

  const group =
    `<g${spray ? ` filter="url(#${id}-spray)"` : ''}>
      ${leaflets}
      <path d="M0,2 L0,28" stroke="${veinColor}" stroke-width="3" stroke-linecap="round" opacity=".85"/>
    </g>`;

  return { defs, group };
}

export function leafSvg({
  id = 'leaf',
  stops = ['#8FE06A', '#2F7D32'],
  vein = null,
  width = 240,
  spray = false,
  opacity = 1,
} = {}) {
  const { defs, group } = leafParts({ id, stops, vein, spray });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-120 -120 240 150" width="${width}" height="${(width * 150) / 240}" role="img" aria-label="Feuille de cannabis">
  <defs>${defs}</defs>
  ${opacity !== 1 ? `<g opacity="${opacity}">${group}</g>` : group}
</svg>`;
}
