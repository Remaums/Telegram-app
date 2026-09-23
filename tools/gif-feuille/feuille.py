"""L'emblème animé de Napoli Coffee : une feuille d'ivoire sur l'encre.

Le mouvement est volontairement lent et court — la boutique est sobre, et un
emblème qui s'agite attire l'œil au détriment des produits. Deux choses
bougent : la feuille respire, et une lumière la traverse en diagonale. La
boucle dure une seconde et deux dixièmes, et se referme exactement sur
elle-même : rien ne saute au recommencement.
"""
import math, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from dessin import FOLIOLES
from gif import ecrire

L, H = 360, 270
IMAGES = 18
CENTRE_X, CENTRE_Y = L / 2, H * 0.58

# ── La palette ───────────────────────────────────────────────
# Huit fonds, du noir d'encre à une lueur à peine plus claire, puis
# cinquante-six ivoires. Cinquante-six suffisent : au-delà, l'œil ne
# distingue plus rien et le fichier grossit pour rien.
FONDS, IVOIRES = 8, 56
palette = []
for i in range(FONDS):
    t = i / (FONDS - 1)
    palette.append((int(14 + 9 * t), int(14 + 9 * t), int(16 + 10 * t)))
for i in range(IVOIRES):
    t = i / (IVOIRES - 1)
    palette.append((
        int(96 + 159 * t),
        int(92 + 160 * t),
        int(84 + 156 * t),
    ))


def marge(x, y, rayon):
    """À quelle distance du bord de la feuille — 0 dehors, 1 au cœur."""
    r = math.hypot(x, y)
    if r < 1e-6:
        return 1.0
    theta = math.atan2(x, y)
    meilleure = 0.0
    for angle, longueur, largeur in FOLIOLES:
        lg = longueur * rayon
        if r > lg:
            continue
        t = r / lg
        demi = largeur * (t ** 0.34) * ((1 - t) ** 0.88) * 4.6
        demi *= 1 + 0.22 * math.sin(t * 30 + angle * 3)
        if demi <= 0:
            continue
        m = 1 - abs(theta - angle) / demi
        if m > meilleure:
            meilleure = m
    if abs(x) < rayon * 0.013 and -rayon * 0.36 < y < 0:
        m = 1 - abs(x) / (rayon * 0.013)
        if m > meilleure:
            meilleure = m
    return meilleure


images = []
for n in range(IMAGES):
    phase = n / IMAGES
    # La respiration, et un balancement d'un degré et demi : assez pour que
    # l'image ne soit pas figée, trop peu pour qu'on le remarque vraiment.
    rayon = H * 0.545 * (1 + 0.030 * math.sin(2 * math.pi * phase))
    incline = 0.026 * math.sin(2 * math.pi * phase)
    cos_i, sin_i = math.cos(incline), math.sin(incline)
    # La lumière traverse en diagonale et sort du cadre avant de revenir.
    passage = -0.25 + 1.5 * phase

    pixels = bytearray(L * H)
    k = 0
    for j in range(H):
        dy = CENTRE_Y - j
        for i in range(L):
            dx = i - CENTRE_X
            # Le halo du fond : une lueur très faible derrière la feuille.
            d = math.hypot(dx, dy) / (H * 0.62)
            fond = int((FONDS - 1) * max(0.0, 1 - d * d) ** 2)

            x = dx * cos_i - dy * sin_i
            y = dx * sin_i + dy * cos_i
            m = marge(x, y, rayon)
            if m <= 0:
                pixels[k] = fond
                k += 1
                continue

            # Le corps de la feuille reste volontairement en demi-teinte :
            # posé près du blanc, il ne laissait aucune place au passage de
            # lumière, qui saturait et ne se voyait plus.
            clair = 0.30 + 0.18 * min(1.0, m * 9.0) + 0.10 * (y / rayon)
            # Le passage de lumière, en bande gaussienne le long d'une
            # diagonale. Mesurée dans le repère de la feuille et non dans
            # celui de l'image : rapportée au cadre, la bande passait dans le
            # vide autour d'elle pendant les trois quarts de la boucle.
            u = 0.5 + (0.56 * x - 0.44 * y) / (1.25 * rayon)
            clair += 0.75 * math.exp(-((u - passage) ** 2) / 0.022)
            # Le bord reste net : on ne lisse que le dernier dixième.
            clair *= min(1.0, m * 11.0)

            pixels[k] = FONDS + min(IVOIRES - 1, max(0, int(min(1.0, clair) * (IVOIRES - 1))))
            k += 1
    images.append(bytes(pixels))
    print('image', n + 1, '/', IMAGES, flush=True)

poids = ecrire(
    str(pathlib.Path(__file__).parents[2] / 'webapp' / 'assets' / 'ui' / 'napoli-feuille.gif'),
    L, H, palette, images, delai=7,
)
print('GIF écrit :', round(poids / 1024), 'Ko,', IMAGES, 'images')
