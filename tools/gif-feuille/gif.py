"""Un encodeur GIF animé, écrit ici faute de bibliothèque d'images.

Le seul morceau délicat est la compression LZW : le codeur et le décodeur
doivent agrandir leur code au même instant, sinon le fichier s'ouvre décalé
d'un pixel et le reste part en bouillie. C'est pour ça qu'un décodeur
l'accompagne — on relit ce qu'on vient d'écrire au lieu de l'espérer.
"""

def lzw(donnees, mcs):
    """Compresse en LZW, en comptant comme le décodeur compte.

    C'est tout le piège. Le codeur crée une entrée de dictionnaire en émettant
    un code ; le décodeur, lui, ne peut créer la même entrée qu'en lisant le
    code SUIVANT — il lui faut deux codes pour en déduire une. Les deux
    tables n'ont donc jamais la même taille au même instant, et si on décide
    d'élargir le code sur la taille de la sienne, on l'élargit un code trop
    tôt : le lecteur relit alors tout de travers à partir de là.

    On tient donc ici le compte du décodeur, pas le sien. Y compris à la fin,
    où le codeur émet un dernier code sans rien ajouter à son dictionnaire,
    là où le décodeur, lui, ajoute quand même une entrée.
    """
    effacer, fin = 1 << mcs, (1 << mcs) + 1
    sortie = bytearray()
    acc = nbits = 0
    taille = mcs + 1

    def poser(code):
        nonlocal acc, nbits
        acc |= code << nbits
        nbits += taille
        while nbits >= 8:
            sortie.append(acc & 0xFF)
            acc >>= 8
            nbits -= 8

    # `vues` suit la table telle que le décodeur la construira.
    vues = fin + 1
    premier = True

    def poser_donnee(code):
        nonlocal vues, taille, premier
        poser(code)
        if premier:
            premier = False
            return
        vues += 1
        if vues == (1 << taille) and taille < 12:
            taille += 1

    def repartir():
        nonlocal vues, taille, premier
        poser(effacer)
        vues = fin + 1
        taille = mcs + 1
        premier = True

    poser(effacer)
    dico = {}
    suivant = fin + 1
    prefixe = donnees[0]
    for k in donnees[1:]:
        cle = (prefixe, k)
        trouve = dico.get(cle)
        if trouve is not None:
            prefixe = trouve
            continue
        poser_donnee(prefixe)
        if suivant < 4096:
            dico[cle] = suivant
            suivant += 1
        else:
            # Dictionnaire plein : on repart de zéro des deux côtés.
            repartir()
            dico.clear()
            suivant = fin + 1
        prefixe = k
    poser_donnee(prefixe)
    poser(fin)
    if nbits:
        sortie.append(acc & 0xFF)
    return bytes(sortie)


def delzw(flux, mcs):
    """Relit ce que `lzw` a écrit. Sert à vérifier, pas à produire."""
    effacer, fin = 1 << mcs, (1 << mcs) + 1
    taille = mcs + 1
    table = None
    sortie = []
    precedent = None
    acc = nbits = 0
    i = 0
    while True:
        while nbits < taille and i < len(flux):
            acc |= flux[i] << nbits
            nbits += 8
            i += 1
        if nbits < taille:
            break
        code = acc & ((1 << taille) - 1)
        acc >>= taille
        nbits -= taille

        if code == effacer:
            table = [bytes([n]) for n in range(effacer)] + [b'', b'']
            taille = mcs + 1
            precedent = None
            continue
        if code == fin:
            break
        if precedent is None:
            entree = table[code]
        elif code < len(table):
            entree = table[code]
        else:
            entree = precedent + precedent[:1]
        sortie.append(entree)
        if precedent is not None:
            table.append(precedent + entree[:1])
            if len(table) == (1 << taille) and taille < 12:
                taille += 1
        precedent = entree
    return b''.join(sortie)


def blocs(flux):
    out = bytearray()
    for i in range(0, len(flux), 255):
        part = flux[i:i + 255]
        out.append(len(part))
        out += part
    out.append(0)
    return bytes(out)


def ecrire(chemin, largeur, hauteur, palette, images, delai=5):
    """`palette` : liste de (r, v, b). `images` : liste de bytes d'indices."""
    n = 1
    while n < len(palette):
        n <<= 1
    n = max(n, 2)
    mcs = max(2, (n - 1).bit_length())

    table = bytearray()
    for r, v, b in palette:
        table += bytes([r, v, b])
    table += bytes(3 * (n - len(palette)))

    g = bytearray(b'GIF89a')
    g += largeur.to_bytes(2, 'little') + hauteur.to_bytes(2, 'little')
    g += bytes([0xF0 | (mcs - 1), 0, 0]) + table
    g += b'\x21\xFF\x0BNETSCAPE2.0\x03\x01\x00\x00\x00'   # boucle sans fin

    for pixels in images:
        assert len(pixels) == largeur * hauteur, 'image de la mauvaise taille'
        g += b'\x21\xF9\x04\x04' + delai.to_bytes(2, 'little') + b'\x00\x00'
        g += b'\x2C' + (0).to_bytes(2, 'little') + (0).to_bytes(2, 'little')
        g += largeur.to_bytes(2, 'little') + hauteur.to_bytes(2, 'little') + b'\x00'
        flux = lzw(pixels, mcs)
        assert delzw(flux, mcs) == pixels, 'le flux ne se relit pas identique'
        g += bytes([mcs]) + blocs(flux)

    g += b'\x3B'
    open(chemin, 'wb').write(bytes(g))
    return len(g)
