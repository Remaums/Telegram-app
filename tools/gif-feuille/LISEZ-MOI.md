# L'emblème animé

`napoli-feuille.gif` est fabriqué ici, pas dessiné dans un logiciel. Trois
fichiers, et aucune dépendance — ni Pillow, ni ImageMagick, ni ffmpeg :

- `dessin.py` — la forme de la feuille, décrite en coordonnées polaires.
  Sept folioles rayonnent d'un même point ; pour chaque pixel on regarde s'il
  tombe dans l'une d'elles. Les dentelures sont une ondulation du bord, pas un
  contour tracé. Changer la silhouette, c'est changer le tableau `FOLIOLES`.
- `gif.py` — un encodeur GIF animé, compression LZW comprise, accompagné de
  son décodeur. Le décodeur n'est pas un luxe : le codeur et le lecteur
  doivent élargir leur code au même instant, faute de quoi le fichier s'ouvre
  décalé et part en bouillie. Chaque image écrite est relue avant d'être
  gardée.
- `feuille.py` — les dix-huit images de la boucle, et l'écriture du fichier.

Pour le refaire, depuis la racine du dépôt :

    python3 tools/gif-feuille/feuille.py

Il réécrit `webapp/assets/ui/napoli-feuille.gif`. Compter une minute : tout
est calculé pixel par pixel en Python.

Les couleurs sortent de la palette de la boutique — l'encre du fond et
l'ivoire de l'accent. Si la palette change dans `webapp/css/style.css`, les
valeurs sont à reporter en tête de `feuille.py`.
