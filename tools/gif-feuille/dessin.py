"""La feuille de Napoli Coffee, dessinée en coordonnées polaires.

Aucune bibliothèque d'images n'est installée ici : la forme est donc décrite
par une fonction plutôt que par un fichier. Sept folioles rayonnent d'un même
point ; pour chaque pixel on regarde, en polaire, s'il tombe dans l'une
d'elles. Les dentelures sont une ondulation du bord, pas un contour dessiné.
"""
import math

# Les sept folioles : direction depuis la verticale, et longueur relative.
FOLIOLES = [
    (0.0,   1.00, 0.105),
    (0.58,  0.88, 0.098), (-0.58, 0.88, 0.098),
    (1.13,  0.68, 0.090), (-1.13, 0.68, 0.090),
    (1.66,  0.44, 0.082), (-1.66, 0.44, 0.082),
]

def dans_la_feuille(x, y, rayon):
    """x, y centrés, y vers le haut. Renvoie la marge au bord, ou None."""
    r = math.hypot(x, y)
    if r < 1e-6:
        return 1.0
    theta = math.atan2(x, y)  # 0 = vers le haut
    meilleure = None
    for angle, longueur, largeur in FOLIOLES:
        L = longueur * rayon
        if r > L:
            continue
        d = theta - angle
        # Le profil : pointu à la base, large au milieu, pointu au bout.
        t = r / L
        demi = largeur * (t ** 0.34) * ((1 - t) ** 0.88) * 4.6
        # Les dentelures : le bord ondule, il n'est pas lissé.
        demi *= 1 + 0.22 * math.sin(t * 30 + angle * 3)
        if demi <= 0:
            continue
        marge = 1 - abs(d) / demi
        if marge > 0 and (meilleure is None or marge > meilleure):
            meilleure = marge
    # La tige.
    if abs(x) < rayon * 0.012 and -rayon * 0.34 < y < 0:
        m = 1 - abs(x) / (rayon * 0.012)
        if meilleure is None or m > meilleure:
            meilleure = m
    return meilleure
