# 🌿 COFFEE SHOP 68 — boutique Telegram Mini App

Une boutique au **design néon nuit** qui s'ouvre directement dans Telegram : catalogue en
images, fiches produits, panier, et un bouton **Commander** qui ouvre ta conversation
Telegram avec le récapitulatif de la commande déjà écrit.

![Aperçu](docs/apercu.png)

---

## Comment ça marche

```
Client → /start dans le bot → bouton « Ouvrir la boutique »
       → Mini App (catalogue, panier)
       → « Commander » → ta conversation Telegram, message pré-rempli
                       → (en parallèle) commande enregistrée + notification admin
```

Le client n'a plus qu'à appuyer sur « Envoyer » : tu reçois la commande dans ta
messagerie perso, avec le détail et une référence.

---

## Mise en route

### 1. Créer le bot

1. Sur Telegram, écris à **[@BotFather](https://t.me/BotFather)**.
2. `/newbot` → choisis un nom et un identifiant (`ma_boutique_bot`).
3. BotFather te donne un **token** du type `123456:ABC-DEF...` → garde-le secret.

### 2. Installer le projet

```bash
git clone <ce-dépôt>
cd Telegram-app
npm install
cp .env.example .env
```

Ouvre `.env` et remplis :

| Variable | À quoi ça sert |
|---|---|
| `BOT_TOKEN` | Le token donné par BotFather |
| `WEBAPP_URL` | L'URL **HTTPS** publique de la boutique (obligatoire, Telegram refuse le HTTP) |
| `SELLER_USERNAME` | **Ton pseudo Telegram sans le `@`** — c'est là qu'arrivent les commandes |
| `ADMIN_CHAT_ID` | Ton ID numérique, pour recevoir aussi une notification automatique du bot |
| `BOT_USERNAME` | Le pseudo du bot sans le `@` — sert aux liens directs et aux QR codes (facultatif : demandé à Telegram sinon) |
| `SHOP_NAME` | Le nom affiché en haut de la boutique |
| `CURRENCY` | `EUR`, `CHF`, `CAD`… |

> Pour trouver ton `ADMIN_CHAT_ID` : lance le bot, envoie-lui `/start`, il t'affiche ton ID.

### 3. Lancer

```bash
npm start
```

La boutique est servie sur `http://localhost:3000`, le bot démarre en parallèle.

### 4. Exposer en HTTPS

Telegram n'ouvre une Mini App que derrière une URL **HTTPS**. Pour tester depuis ton
téléphone sans déployer :

```bash
npx cloudflared tunnel --url http://localhost:3000
# ou : ngrok http 3000
```

Copie l'URL `https://…` obtenue dans `WEBAPP_URL`, puis relance `npm start`.

Pour de la mise en production, n'importe quel hébergeur Node avec HTTPS fait l'affaire
(Railway, Render, Fly.io, un VPS derrière Caddy ou Nginx…).

### 5. Brancher le bouton dans Telegram

Chez **@BotFather** :

- `/mybots` → ton bot → **Bot Settings** → **Menu Button** → **Configure menu button**
- colle ton `WEBAPP_URL` et donne un libellé (« 🛒 Boutique »)

Le bouton apparaît alors en permanence à côté du champ de saisie du bot.

---

## ⚙️ Espace admin

**Comment y entrer :** envoie `/admin` à ton bot dans Telegram. Il répond avec
un bouton **⚙️ Espace admin** qui ouvre le panneau. Deux conditions, et le bot
dit laquelle manque : ton identifiant numérique doit figurer dans `ADMIN_IDS`
(envoie `/start` au bot, il te l'affiche), et `WEBAPP_URL` doit être une
adresse en `https://` — Telegram n'ouvre pas une Mini App autrement.

L'adresse `…/admin.html` ouverte directement dans un navigateur ne sert à rien :
l'authentification repose sur la signature que Telegram fournit au lancement,
et elle n'existe qu'à l'intérieur de Telegram.


![Espace admin](docs/admin.png)

Envoie `/admin` au bot (réservé aux identifiants listés dans `ADMIN_IDS`) : la
Mini App d'administration s'ouvre avec quatre onglets.

| Onglet | Ce que tu y fais |
|---|---|
| **Tableau** | Chiffre d'affaires total et du jour, nombre de commandes, commandes à traiter, meilleures ventes, alertes de stock bas |
| **Commandes** | Toutes les commandes, filtrables par statut, avec les boutons pour les faire avancer |
| **Stock** | Réglage direct des quantités, format par format, avec recherche |
| **Produits** | Créer, modifier, masquer ou supprimer un produit |

### Le cycle d'une commande

```
Nouvelle ──▶ Confirmée ──▶ Prête ──▶ Livrée
    │            │           │
    └────────────┴───────────┴──▶ Annulée   (le stock est remis en rayon)
```

Le client reçoit **automatiquement un message du bot** à chaque changement de statut.
Les transitions illégales sont refusées côté serveur : on ne passe pas de
« Nouvelle » directement à « Livrée ».

### Le stock

- Chaque produit a un stock ; s'il a des formats (2 g, 5 g…), le stock est tenu
  **par format**.
- Une commande **décrémente le stock en tout ou rien** : deux clients ne peuvent
  pas emporter le dernier article en même temps.
- Un produit épuisé apparaît **grisé et non commandable** dans la boutique, et
  le format épuisé est barré dans la fiche produit.
- Le tableau de bord signale tout ce qui descend **à 5 unités ou moins**.
- Annuler une commande **remet automatiquement les articles en rayon**.

---

## Personnaliser

### Les produits

Le plus simple est de passer par l'**espace admin** (`/admin` dans le bot) : tout se
modifie depuis le téléphone, sans toucher au code.

Au premier démarrage, le catalogue est créé dans `server/data/catalog.json` à partir
du catalogue d'exemple de **`server/data/products.js`**. Ensuite c'est le fichier JSON
qui fait foi. Pour repartir du catalogue d'exemple, supprime `catalog.json` et
redémarre. Une entrée ressemble à ça :

```js
{
  id: 'neon-kush',               // identifiant unique, sans espaces
  name: 'Néon Kush',
  category: 'fleurs',            // doit exister dans `categories`
  price: 1200,                   // EN CENTIMES : 1200 = 12,00 €
  image: '/assets/products/jar.svg',
  badge: 'TOP VENTE',            // pastille rose, optionnelle
  tags: ['Indica', 'Nuit'],
  short: 'Texte court affiché sur la vignette.',
  description: 'Texte long affiché dans la fiche produit.',
  stock: null,                   // null si le stock est porté par les variantes
  variants: [                    // optionnel : formats au choix
    { id: '2g', label: '2 g', price: 1200, stock: 24 },
    { id: '5g', label: '5 g', price: 2700, stock: 12 },
  ],
}
```

> ⚠️ Les prix sont **en centimes** pour éviter les erreurs d'arrondi, et ils sont
> systématiquement **recalculés côté serveur** : un client ne peut pas se commander
> un produit à 0 €.

### Réimporter les produits d'exemple

Le catalogue de départ ne se pose **qu'une fois**, au tout premier démarrage :
ensuite, `server/data/catalog.json` appartient à la boutique et n'est plus
jamais écrasé. Un produit ajouté au dépôt après coup n'a donc aucun moyen
d'arriver tout seul dans une boutique en service.

```bash
npm run produits                 # liste ce qui manque, ne change rien
npm run produits -- --tout       # importe ce qui manque
npm run produits -- plasma-static-banana-kush   # un seul, par identifiant
npm run produits -- --tout --remplacer          # écrase aussi l'existant
```

Sans argument, l'outil ne fait que regarder : on voit d'abord ce qui va se
passer. Et il **n'écrase jamais** un produit déjà présent sans `--remplacer` —
un prix ou un stock que tu as ajusté ne doit pas disparaître dans un import.
Les catégories manquantes sont créées au passage, en fin de liste ; leur ordre
se règle dans l'espace admin.

Rien à redémarrer après : l'outil écrit dans le même magasin que la boutique.

### Animations et widgets

Deux widgets qui renseignent, trois animations qui accompagnent un geste — le
tout sous un seul interrupteur (Réglages → Fonctionnalités → *Animations et
widgets*).

**Le bandeau d'état**, sous l'en-tête, dit si la boutique est ouverte **et
combien de temps il reste** : « ferme dans 2 h 15 ». Un client qui remplit son
panier veut savoir s'il a le temps de finir. Le décompte est relatif, calculé
en minutes par le serveur — le téléphone du client peut être à l'heure d'un
autre fuseau, un décompte relatif reste juste partout. Il n'apparaît que si les
horaires sont actifs : sans eux, l'état ne change pas et un bandeau qui répète
« ouvert » n'apprend rien.

**La jauge du panier** montre la progression vers le prochain avantage —
livraison offerte ou palier de remise — avec ce qu'il manque. Un client à qui
il manque cinq euros les ajoute presque toujours, encore faut-il qu'il voie de
combien il s'en approche. Elle remplace alors la phrase équivalente, plutôt que
de la répéter.

**Les trois animations** : les cartes entrent en cascade, la vignette d'un
article s'envole vers le panier quand on l'ajoute, et des cartes vides
occupent la grille pendant le chargement — l'écran ne saute plus au moment où
les vraies arrivent.

> **Rien de tout ça n'est nécessaire au fonctionnement.** Coupé par le vendeur,
> ou par un système qui demande moins de mouvement (`prefers-reduced-motion` —
> un réglage souvent posé pour raison médicale), tout reste en place et
> simplement immobile. Une animation ne doit jamais être ce qui rend une chose
> visible, et un balayage navigateur vérifie les deux états.

### Photos et vidéos d'une fiche produit

Chaque produit porte une galerie : jusqu'à **huit médias**, photos et vidéos
mêlées, que le client fait défiler du doigt sur la fiche. Le premier sert aussi
de vignette dans la grille tant qu'aucune n'a été choisie.

Trois façons d'en ajouter :

- **Depuis la galerie du téléphone**, dans l'espace admin : sur la fiche du
  produit, bouton **📱 Depuis ma galerie**. On choisit une ou plusieurs photos
  ou vidéos, une barre montre l'avancement, et la galerie se met à jour toute
  seule. Le fichier ne touche jamais le disque de la boutique : il traverse le
  serveur, repart vers ta conversation Telegram — où tu en gardes une copie —
  et seule la référence est conservée. Plafonds : **10 Mo par photo, 20 Mo par
  vidéo**, alignés sur ce que Telegram sait *rendre* et non sur ce qu'il
  accepte de recevoir. Un fichier plus lourd serait rangé dans la galerie pour
  y rester noir.
- **Envoyer la photo ou la vidéo au bot**, avec le nom du produit en légende.
  Le fichier reste chez Telegram — on n'enregistre que sa référence : rien à
  écrire sur le disque, rien de plus à sauvegarder, et les médias suivent la
  boutique si elle change d'hébergeur. Telegram ne laisse pas un bot
  télécharger au-delà de **20 Mo** : une vidéo plus lourde est refusée en le
  disant, plutôt qu'enregistrée pour ne jamais s'afficher.
- **Coller une adresse** dans l'espace admin, sous le bouton d'envoi. Un
  chemin local (`/assets/products/ma-photo.jpg`) ou une adresse en `https://`,
  pour les visuels hébergés ailleurs.

Sur la fiche, l'ordre se règle avec les flèches et chaque média se retire d'un
bouton. La vignette montre le vrai visuel, pas son nom de fichier : c'est la
seule façon de repérer d'un coup d'œil celui qui ne charge pas.

**Une galerie qui n'a que des vidéos passe en vitrine.** Faute de photo, la
grille montrait le dessin par défaut, et rien n'annonçait au client la vidéo qui
l'attendait sur la fiche. Elle s'affiche donc directement sur la carte : muette,
en boucle, sans contrôles — la carte entière reste le bouton qui ouvre la fiche —
et seulement tant qu'elle est à l'écran, pour ne pas dépenser les données du
client hors de vue. Une pastille ▶ l'annonce même immobile : sur un système qui
demande moins de mouvement, la vitrine s'en tient à la première image. Une photo
garde toujours la vitrine, elle : un dessin est un pis-aller, une photo posée par
le vendeur est une décision.

> 🔒 **Une adresse de média finit dans un attribut `src`.** Seuls un chemin
> commençant par `/` et une adresse en `https://` sont acceptés : `javascript:`,
> `data:` et les remontées de dossier sont refusés, et des tests le vérifient à
> chaque exécution.

**Une vidéo montre son image d'attente tout de suite.** Telegram fabrique une
vignette de quelques kilo-octets pour chaque vidéo qu'on lui confie : la
boutique la garde et l'affiche en `poster`, sur la carte comme sur la fiche.
L'image apparaît donc immédiatement pendant que la vidéo, elle, met le temps
qu'il faut — sans elle le cadre reste noir, et un cadre noir se lit comme une
panne. À défaut de vignette, l'illustration du produit tient la place : rien ne
vaut mieux qu'un rectangle vide.

Les vidéos ajoutées avant que la boutique ne pense à garder cette vignette
n'en ont pas. Sur la fiche, dans l'espace admin, elles portent alors un bouton
**🖼** qui va la chercher : le bot se renvoie la vidéo à lui-même — par sa
référence, donc sans retéléverser un octet —, lit la vignette au passage et
efface le message aussitôt.

**Une copie locale évite de refaire le trajet.** Le catalogue ne stocke que la
référence Telegram : sans rien d'autre, chaque première vue ferait
client → boutique → Telegram → boutique → client, et l'entrepôt de fichiers de
Telegram n'est pas un réseau de diffusion — une vidéo de quinze mégaoctets se
fait attendre, et la bande passante du serveur la paie deux fois. La boutique
garde donc une copie dans `server/data/media-cache/` : **seul le premier
visiteur paie le trajet**, les suivants sont servis en local, avec les plages
d'octets (se déplacer dans une vidéo) et un cache navigateur d'un jour.

Le dossier est borné — `MEDIA_CACHE_MB=500` par défaut, `MEDIA_CACHE_DIR` pour
le ranger ailleurs, `0` pour tout éteindre — et se vide tout seul, du plus
anciennement servi au plus récent. Une copie n'est jamais rangée avant d'être
complète : un client qui coupe ou un téléchargement écourté ne laissent rien,
parce qu'une demi-vidéo serait ensuite servie telle quelle à tout le monde. Là
où le disque est en lecture seule (serverless), la copie s'éteint d'elle-même
en le disant au démarrage, et la boutique relaie comme avant. `/api/health` et
`deploy/diagnostic.sh` disent où elle en est.

Côté client, une vidéo ne démarre **jamais toute seule** et garde ses contrôles.
Refermer la fiche coupe la lecture et détache la source — sinon le son
continuerait par-dessus le catalogue, sans que le client sache d'où il vient.

### Les images

Les illustrations sont des SVG originaux dans `webapp/assets/products/`, générés par
`node tools/generate-art.mjs` (dégradés doux, pensés pour un fond sombre).
**Le plus simple : envoie la photo au bot.** Depuis un compte administrateur,
envoie l'image dans la conversation avec le nom du produit en légende :

```
[photo]  Néon Kush
```

Le bot répond « Photo mise à jour ». Le fichier reste chez Telegram — la
boutique n'enregistre que sa référence et sert l'image à la demande. Rien à
écrire sur le disque : ça marche aussi bien sur un VPS qu'en serverless, et il
n'y a rien de plus à sauvegarder. Une légende ambiguë (« neon » quand deux
produits le contiennent) fait répondre la liste plutôt que d'écraser la
mauvaise photo.

**Ou depuis ta galerie**, sans quitter l'espace admin : dans l'éditeur de
produit, sous l'aperçu de l'image, bouton **📱 Depuis ma galerie**. Tu choisis
**une** photo — une vidéo est refusée en le disant, une vignette de catalogue ne
se joue pas —, une barre montre l'avancement, puis l'aperçu, la grille et la
liste des stocks se mettent à jour d'eux-mêmes. Même trajet que pour la
galerie : le fichier traverse le serveur, repart vers ta conversation Telegram
— où tu en gardes une copie — et seule la référence est conservée. Plafond
**10 Mo**, celui d'une photo chez Telegram. Le bouton n'apparaît que sur un
produit déjà enregistré : avant ça, il n'y a rien à quoi rattacher un fichier.

**Ou par fichier**, deux autres chemins :

- depuis l'espace admin : dans l'éditeur de produit, choisis « 📷 Ma photo » dans la
  liste d'images et colle le chemin (`/assets/products/ma-photo.jpg`) ou une adresse
  complète ;
- ou directement dans `server/data/products.js`, champ `image`.

Dépose les fichiers dans `webapp/assets/products/`. La boutique reconnaît une photo à
son extension et l'affiche alors plein cadre (recadrage centré), au lieu du halo
réservé aux illustrations. Un format carré, sujet centré, rend le mieux dans la
grille ; les deux peuvent cohabiter dans le même catalogue.

### Les couleurs

Toute la palette tient dans le premier bloc de `webapp/css/style.css`, en composantes
RVB brutes (pour pouvoir moduler l'opacité) :

```css
--night-rgb:   4 22 15;    /* fond de page */
--panel-rgb:  12 62 41;    /* cartes et panneaux */
--neon-rgb: 198 255 61;    /* accent principal : boutons, sélection */
--halo-rgb:  15 157 99;    /* fumée du fond */
--gold-rgb: 255 210 63;    /* lettrage d'affiche */
```

Réécris ce bloc et toute la boutique change de couleurs — l'espace admin et la barre
native de Telegram suivent, ils lisent les mêmes variables.

### Les polices

`Luckiest Guy` (lettrage d'affiche) et `Baloo 2` (texte) sont servies depuis
`webapp/assets/fonts/` : pas de dépendance à Google Fonts dans la WebView. Voir
`webapp/assets/fonts/NOTICE.txt` pour les licences (SIL OFL 1.1).

---

## Mise en ligne

Deux chemins, selon ce que tu as sous la main :

- **Un VPS** (Debian/Ubuntu) — le plus simple : le bot tourne en long polling,
  le catalogue vit dans des fichiers JSON, rien d'autre à installer. Pas encore
  de nom de domaine ? L'étape 6 du guide donne deux façons gratuites d'obtenir
  une URL en HTTPS pour tester. `deploy/installer.sh` fait les gestes
  mécaniques, `deploy/diagnostic.sh` dit ce qui cloche.
  👉 **[Guide pas à pas : docs/vps.md](docs/vps.md)**
- **Vercel** (serverless) — voir la section ci-dessous : le bot passe en
  webhook et le stockage en Postgres, car le disque y est en lecture seule.

---

## Mise en ligne sur Vercel

En local, la boutique tourne telle quelle : fichiers JSON dans `server/data/` et
bot en long polling. En ligne sur Vercel, deux choses changent — le disque y est
en lecture seule et aucun process ne vit entre deux requêtes :

| | En local | Sur Vercel |
|---|---|---|
| Stockage | `server/data/*.json` | Postgres (`DATABASE_URL`) |
| Bot | long polling | webhook `/api/telegram` |

Le code choisit tout seul : `server/store.js` bascule sur Postgres dès que
`DATABASE_URL` est défini, et `server/index.js` n'écoute un port que s'il est
lancé directement. Rien à commenter, rien à dupliquer.

### 1. Une base Postgres

Crée une base chez Neon, Supabase ou Vercel Postgres et récupère la chaîne de
connexion **« pooled »** (celle qui passe par le pooler du fournisseur). La table
`shop_documents` est créée automatiquement au premier appel — aucune migration à
lancer.

### 2. Le projet Vercel

Importe le dépôt sur Vercel (aucune commande de build : `vercel.json` sert
`webapp/` en statique et route `/api/*` vers la fonction), puis renseigne les
variables d'environnement du projet :

```
BOT_TOKEN=…                        (BotFather)
WEBAPP_URL=https://ton-projet.vercel.app
SELLER_USERNAME=tonpseudo
BOT_USERNAME=ma_boutique_bot       (facultatif : liens directs et QR codes)
ADMIN_IDS=123456789
ADMIN_CHAT_ID=123456789
DATABASE_URL=postgres://…?sslmode=require
TELEGRAM_WEBHOOK_SECRET=…          (openssl rand -hex 32)
```

### 3. Le webhook

Une fois le déploiement en ligne, déclare le webhook une bonne fois :

```bash
BOT_TOKEN=… WEBAPP_URL=https://ton-projet.vercel.app TELEGRAM_WEBHOOK_SECRET=… \
  node tools/set-webhook.mjs
```

`--info` affiche l'état vu par Telegram, `--delete` le retire pour repasser au
long polling en local. Un webhook déclaré et un `npm start` local se disputent
les mêmes mises à jour : garde-en un seul actif à la fois.

### 4. Vérifier

```bash
npm run doctor                       # ou : node tools/doctor.mjs https://…
```

Le diagnostic contrôle la configuration, appelle `/api/health` sur le
déploiement (stockage joignable, nombre de produits), vérifie que la Mini App
est bien servie et demande à Telegram où pointe le webhook. `/api/health` est
aussi consultable directement dans un navigateur — il ne renvoie que des
booléens et des compteurs, jamais un token.

### 5. Enfin

Chez BotFather, `/setmenubutton` avec la même URL `WEBAPP_URL`, puis `/start`
dans ton bot.

> ⚙️ **Pourquoi le corps des requêtes est repris à la main** : le runtime de
> Vercel lit la requête avant la fonction, si bien que `express.json()` trouve
> un flux déjà terminé et répond « stream is not readable ». Un filtre en tête
> de `server/index.js` récupère le corps déjà analysé ; `test/vercel-compat.test.mjs`
> rejoue ce comportement pour que la protection ne saute pas par mégarde.

> Les commandes et le catalogue sont stockés en JSONB, un document par magasin,
> et chaque écriture verrouille sa ligne le temps de la transaction : deux
> clients ne peuvent pas acheter le même dernier article. Au-delà de quelques
> dizaines de milliers de commandes, passe à une ligne par commande — seul
> `server/pg-store.js` est à revoir.

---

## Commandes du bot

| Commande | Effet |
|---|---|
| `/start` | Message d'accueil + bouton boutique + affiche l'ID du client |
| `/boutique` | Rouvre la Mini App |
| `/commandes` | Les 5 dernières commandes du client |
| `/aide` | Liste des commandes |
| `/stop` | ne plus recevoir d'annonces |
| `/annonces` | les recevoir de nouveau |
| `/admin` | Espace d'administration (réservé aux `ADMIN_IDS`) |
| `/ouvrir` `/fermer` | Ouvre ou ferme la boutique (réservé) |
| `/verification on\|off` | Allume ou coupe la vérification d'identité (réservé) |

Tout autre message reçoit la liste des commandes et le bouton boutique : la
porte d'entrée de la boutique ne doit pas rester muette devant un « bonjour ».

---

## Sécurité

- Le `initData` envoyé par Telegram est **vérifié par HMAC-SHA256** (`server/telegram-auth.js`) :
  impossible de passer une commande en se faisant passer pour quelqu'un d'autre.
- Les signatures ont une **durée de vie de 24 h** pour éviter le rejeu.
- Les **prix et les variantes sont revalidés côté serveur** à partir du catalogue.
- Le `BOT_TOKEN` n'est jamais envoyé au navigateur (`.env` est dans `.gitignore`).
- L'espace admin est verrouillé sur les identifiants de `ADMIN_IDS`, vérifiés à
  **chaque appel** à partir de la signature Telegram : un client ne peut pas se
  déclarer administrateur.

Tests automatisés — 45 tests couvrant l'authentification, la falsification de prix,
les droits d'admin, la gestion du stock, les transitions de statut, la concurrence
(cinq clients sur le dernier article) et la compatibilité serverless — serveur
démarré dans un autre terminal :

```bash
npm test
```

La même suite passe sur les deux stockages : lance le serveur sans `DATABASE_URL`
pour tester les fichiers JSON, avec pour tester Postgres.

Chaque suite **pose son propre décor** au démarrage (`resetShop` dans
`test/helpers.mjs`) et tire ses identifiants de clients à chaque exécution.
Sans ça, une suite qui coupe les remises faisait échouer celle qui les teste,
et un quota horaire déjà consommé rendait la suite injouable deux fois de
suite : l'ordre du `package.json` devenait un piège invisible. On peut donc
enchaîner `npm test` autant de fois qu'on veut, sur un magasin déjà bien
rempli comme sur un magasin vierge.

---

## Stockage des commandes

> **Faut-il une base de données ? Non.** Sur un VPS, la boutique garde tout
> dans `server/data/` : deux fichiers JSON, aucun compte à créer, aucun service
> à installer. `DATABASE_URL` ne sert **qu'au déploiement serverless** (Vercel),
> où le disque est en lecture seule et où chaque requête peut atterrir sur une
> autre instance. Renseignée par erreur, elle fait basculer toute la boutique
> sur Postgres — et si l'adresse n'est pas joignable, plus rien ne s'affiche.
> Dans le doute : laisse la ligne commentée.



Le catalogue et les commandes sont écrits dans `server/data/catalog.json` et
`server/data/orders.json` (créés automatiquement, ignorés par git). Les écritures
sont sérialisées et atomiques : pas de JSON tronqué si le serveur s'arrête en
pleine sauvegarde.

En ligne avec `DATABASE_URL`, c'est `server/pg-store.js` qui prend le relais : un
document JSONB par magasin, et chaque écriture verrouille sa ligne le temps de la
transaction. Les deux magasins exposent la même interface, `server/store.js`
choisit — le reste du serveur ignore lequel tourne.

> ⚠️ **Avec les fichiers JSON, une seule instance.** Chaque processus garde les
> données en mémoire et réécrit le fichier entier : deux instances sur le même
> dossier ne se voient pas, et la seconde efface silencieusement ce que la
> première vient d'écrire — commandes comprises. La boutique **refuse donc de
> démarrer** si une autre instance tient déjà le dossier (`server/data/.lock`).
> Pour servir depuis plusieurs processus — `pm2 -i 2`, plusieurs conteneurs,
> ou le serverless — il faut `DATABASE_URL` : Postgres verrouille la ligne le
> temps de la transaction, et deux instances peuvent travailler ensemble sans
> se marcher dessus. C'est vérifié par un test qui fait tourner deux serveurs
> sur la même base et leur fait disputer le dernier article, le dernier
> créneau et un code à usage unique.

> 💾 **En local, pense à sauvegarder `server/data/`** : c'est là que vivent ton
> catalogue et tes commandes. En ligne, c'est la base Postgres qu'il faut
> sauvegarder (la plupart des fournisseurs le font pour toi).

---

## Exploitation au quotidien

### Le tableau de bord

L'onglet **Tableau** répond à quatre questions : combien ça rapporte, est-ce
que ça monte, qu'est-ce qui se vend, et quand.

Une seule rangée de boutons en haut — **7, 30 ou 90 jours** — commande tout le
panneau : une période par graphique donnerait quatre lectures différentes du
même magasin.

- **Le chiffre de la période, en tête**, avec la comparaison à la période
  précédente de même longueur. « 1 240 € » ne dit pas si la boutique monte ;
  « ▲ 20 % vs les 30 jours d'avant » si.
- **Ventes par jour** — une colonne par jour, le jour du bout souligné et sa
  valeur écrite dessus. Au-delà de six semaines, on regroupe par semaine :
  quatre-vingt-dix colonnes de deux pixels ne se lisent pas. Un jour sans vente
  garde son trait, en gris : sans lui, la rangée a des trous et on ne sait plus
  quel jour on regarde.
- **Meilleures ventes** — chiffre par produit, six au plus, le reste réuni.
- **Quand on commande** — par tranche de deux heures et par jour de la semaine.
  C'est ce qui décide des horaires d'ouverture et du jour de réassort.

Trois précautions valent d'être connues, parce qu'un tableau de bord faux est
pire qu'aucun tableau de bord — on y croit, et on décide dessus :

1. **Le fuseau de la boutique fait foi**, pas celui du serveur. Un VPS réglé sur
   UTC couperait ses journées à deux heures du matin, c'est-à-dire en plein
   coup de feu du samedi soir : la moitié d'une soirée serait comptée le
   lendemain.
2. **Une commande annulée ne rapporte rien** — elle sort du chiffre, du panier
   moyen et des ventes par produit — **mais elle compte dans le taux
   d'annulation**, qui a sa propre tuile.
3. **Un nouveau client est un client dont la toute première commande** tombe
   dans la période. Sans ça, chaque habitué redeviendrait un nouveau client à
   chaque changement de mois.

> **Chaque graphique porte son tableau de valeurs**, replié dessous (« Voir les
> chiffres »). Une bulle de survol n'existe pas au doigt et ne se lit pas au
> lecteur d'écran : aucune valeur n'est enfermée dedans.

Côté dessin : une seule teinte de remplissage pour tout le panneau, et le néon
de la maison réservé à **une marque à la fois** — le jour d'aujourd'hui, l'heure
de pointe. Deux couleurs à distinguer obligeraient à apprendre une légende pour
lire ses ventes du mardi, alors que la longueur des barres dit déjà tout. Les
graphiques sont écrits à la main en SVG : quatre courbes ne valent pas cinquante
kilo-octets de bibliothèque chargés sur le réseau d'un téléphone.

### Effacer des commandes, ou les faire oublier

Trois façons de repartir, dans **Réglages → Effacer des commandes**, et elles ne
se valent pas :

| Ce qu'on fait | Ce qui reste |
|---|---|
| **Oublier qui a commandé** (avant une date) | les montants, les articles, le mode, le secteur — le bilan ne bouge pas |
| **Effacer les commandes** (avant une date) | rien de ces commandes : leur chiffre disparaît du bilan |
| **Tout effacer** | un magasin vide, comme au premier jour |

**Oublier est presque toujours le bon choix** : on garde sa comptabilité sans
garder le domicile de ses clients de l'an dernier. Le nom, l'identifiant
Telegram, l'adresse, le téléphone et la note s'en vont ; le montant reste, parce
qu'une comptabilité ne se réécrit pas. Le secteur de livraison reste aussi — il
désigne une commune, pas une porte.

> ⚠️ **Aucune des trois ne se rattrape.** Une sauvegarde part donc dans ta
> conversation Telegram **avant** que le magasin ne soit touché, et
> **l'effacement est refusé si elle n'a pas pu partir** : un « ça n'a pas
> marché » après un effacement réussi n'est plus une erreur, c'est une perte.
> Il faut aussi écrire `EFFACER` à la main — et le serveur le redemande de son
> côté, parce qu'une interface se contourne et qu'une commande `curl` n'a pas
> d'écran de confirmation.

La date est une frontière : **le jour de la limite est le premier qu'on garde**.
Recommencer une anonymisation ne recompte pas ce qui est déjà oublié.

### Les clients

L'onglet **Clients** reconstitue une fiche par personne **à partir des
commandes** : combien de fois, combien dépensé, panier moyen, annulations,
première et dernière commande, retrait ou livraison, ce qu'elle prend
d'habitude, les adresses servies (la plus récente en tête, avec ses liens
d'itinéraire), son téléphone, ses dernières références — et les trois états que
la boutique connaît déjà : bloqué, vérifié, abonné aux annonces.

La recherche porte sur **tout** le magasin, pas sur les fiches affichées : un
prénom, un pseudo, un numéro tapé d'un bloc, une rue, une ville, une référence
de commande. Sans accents ni casse. Les fiches restent repliées — une liste de
fiches entières ferait défiler trois écrans pour retrouver quelqu'un.

Deux boutons vont chercher plus loin, **à la demande et un client à la fois** :
« Fiche Telegram » demande à Telegram le nom, le pseudo, la biographie et la
photo du compte (Telegram ne répond que pour quelqu'un qui a déjà écrit au
bot), et « Écrire » ouvre la conversation.

> 🔒 **Rien n'est collecté pour cet écran.** Il ne fait que regrouper ce que les
> commandes disent déjà. En particulier, la boutique **n'enregistre aucune
> adresse IP**, ne fait **ni géolocalisation ni whois**, et ne pose aucun
> traceur : ce qu'on ne garde pas ne peut ni fuir, ni être saisi, ni servir
> contre quelqu'un. La géographie utile — la ville et le code postal de
> livraison — vient de ce que le client a écrit lui-même, et c'est la seule qui
> soit exacte : une adresse IP désigne le fournisseur d'accès, pas le domicile.

### Réglages

Tout se règle depuis l'onglet **Réglages** de l'espace admin, sans redéployer.

### Fonctionnalités

Le premier bloc de l'onglet Réglages est un tableau de bord : **une case par
fonctionnalité**, qui s'applique immédiatement — pas de bouton « Enregistrer »,
car une case cochée mais pas encore enregistrée est un piège.

| Fonctionnalité | Ce qui disparaît quand elle est coupée |
|---|---|
| Porte d'âge | l'écran « as-tu 18 ans ? » |
| Épreuve anti-robot | la grille de tuiles avant de commander |
| Épreuve d'entrée du bot | le calcul au premier /start |
| Vérification d'identité | la demande de pièce dans le bot |
| Horaires automatiques | la fermeture programmée (l'interrupteur manuel reste) |
| Zones de livraison | on livre partout aux conditions générales |
| Créneaux | plus de plage horaire à choisir |
| Recherche au catalogue | la barre de recherche et le tri |
| Annonces aux clients | plus moyen d'écrire à ceux qui ont commandé |
| Remises par palier | plus de remise automatique |
| Codes promo | le champ « code promo » du panier |
| Liste d'attente | le bouton « préviens-moi du retour » |
| Alertes de stock | le bot ne te signale plus les seuils franchis |
| Garde-fous anti-abus | plus de plafond horaire ni d'articles |
| Photos par le bot | envoyer une photo au bot ne change plus rien |
| « Mes commandes » | l'écran d'historique du client |
| Suivi envoyé au client | confirmation et messages de statut |

Deux règles tiennent tout ça :

> 🔒 **Ce qui est éteint est refusé par le serveur**, pas seulement masqué dans
> la Mini App. Chaque case est vérifiée dans une route ou un envoi — cacher un
> bouton ne fermerait rien, l'appel resterait possible.

> 💾 **Les réglages d'une fonctionnalité éteinte sont conservés.** Couper les
> créneaux ne vide pas la grille de la semaine, couper les zones ne les efface
> pas : rallumer retrouve tout intact.

Le vendeur, lui, est prévenu de chaque commande quoi qu'il arrive : c'est lui
qui la prépare. Seul le fil du client est optionnel.

### Ouverture

Un interrupteur immédiat (`/ouvrir` et `/fermer` marchent aussi depuis la
conversation) et, si tu veux, des **horaires hebdomadaires** avec ton fuseau :
la boutique se ferme alors toute seule le soir. Une plage qui franchit minuit
(22:00 → 02:00) est comprise des deux côtés.

Fermée, la boutique reste consultable — le client prépare son panier et voit
un bandeau — mais **le serveur refuse les commandes** : un bandeau seul
n'empêcherait pas de valider un panier resté ouvert.

### Retrait et livraison

| Réglage | Effet |
|---|---|
| Retrait / Livraison | les modes proposés ; il en faut au moins un |
| Frais de livraison | ajoutés au total, **recalculés côté serveur** |
| Livraison offerte dès | franco : au-delà, les frais tombent à zéro |
| Commande minimum | en dessous, le bouton Commander reste fermé |

Une commande en livraison exige une **adresse complète**, saisie en quatre
champs plutôt qu'en une ligne libre : rue et numéro, complément (bâtiment,
étage, code d'entrée), code postal, ville. Une ligne libre laissait passer
« chez Marc » — cinq caractères, aucune ville, et un livreur qui rappelle. Ce
qui manque est nommé un champ à la fois, le curseur posé dessus, avant même
d'envoyer la commande. Le téléphone est demandé à part, et reste facultatif.

> Le numéro de rue n'est pas exigé : un lieu-dit ou un hameau n'en a pas, et
> refuser leur commande coûterait plus cher qu'une adresse imprécise. Le code
> postal et la ville, eux, sont obligatoires — il y a une rue de la Gare dans
> presque chaque commune.

**Le message de commande porte trois boutons d'itinéraire** — 🗺 Maps, 🚗 Waze,
🧭 Plans — qui ouvrent l'adresse dans l'application installée, ou sur le site
sinon. Les mêmes liens figurent sur la carte de la commande dans l'espace
admin. Recopier une adresse à la main dans une application de trajet, une par
commande, c'est la faute de frappe assurée — et une faute de frappe, ici, c'est
un livreur devant la mauvaise porte.

Le complément ne part **pas** dans l'itinéraire : « 3e étage, code 1234 »
n'aide aucun géocodeur, et beaucoup renoncent à chercher plutôt que de
l'ignorer. Il reste affiché dans le message, sous l'adresse.

Le mode, le sous-total et les frais sont enregistrés avec la commande, et
repris dans le message envoyé au vendeur.

### Zones de livraison

Tant qu'aucune zone n'est déclarée, tu livres partout aux conditions
ci-dessus. Dès qu'il y en a une, **seuls les codes postaux listés sont
desservis** : le client saisit le sien dans le panier et voit immédiatement
« Colmar centre · 3 € de livraison » ou « on ne livre pas encore le 75000 »,
au lieu de valider une commande que tu devras annuler.

| Champ de la zone | Laissé vide |
|---|---|
| Frais | gratuit pour cette zone |
| Minimum | celui de la boutique |
| Franco | celui de la boutique |

Le secteur et le code postal sont enregistrés avec la commande et repris dans
le message que tu reçois.

### Créneaux

Un interrupteur, puis une grille : par jour de la semaine, des plages avec une
capacité. Le client choisit dans une liste des jours à venir, et la commande
porte son créneau — tu vois d'un coup d'œil l'ordre de préparation.

- **Délai avant un créneau** : on ne réserve pas celui qui commence dans cinq
  minutes. Il ne s'applique qu'à la journée en cours.
- **Jours proposés** : la profondeur de la fenêtre, jusqu'à quatorze jours.
- **Capacité** : une fois atteinte, le créneau s'affiche « complet » et
  **le serveur refuse de le surbooker** (HTTP 409). Il reste visible : le
  faire disparaître donnerait l'impression d'un bug à qui l'avait vu une
  minute plus tôt.

Une commande annulée **libère sa place** : compter les annulations reviendrait
à bloquer un créneau pour un client qui ne viendra pas. Le créneau demandé est
revalidé au moment de commander contre la liste que la boutique proposerait à
cet instant — une page restée ouverte toute la nuit ne peut donc pas réserver
un créneau d'hier.

### Recherche au catalogue

Une barre de recherche et un tri au-dessus de la grille, dès que le catalogue
dépasse la poignée de produits qu'on embrasse d'un coup d'œil.

La recherche ignore les accents et la casse — personne ne tape « Néon » avec
l'accent sur un clavier de téléphone — et accepte les mots dans le désordre :
« gum bubble » trouve « Bubble Gum ». Elle regarde le nom, l'accroche, les
étiquettes et la description, si bien que « banane » ramène la Banana Kush
même si le mot n'est pas dans son nom.

Quatre tris : par défaut (l'ordre du catalogue, les articles épuisés glissant
en fin de liste), nouveautés, prix croissant, prix décroissant, alphabétique.
Chaque produit porte sa date d'entrée au catalogue, posée une fois et
conservée : modifier un prix ne rajeunit pas le produit.

### Liens directs et QR codes

Un lien qui ouvre la boutique **sur un article précis**, et le même lien en QR
code. C'est ce qu'on colle sur un flyer : le client scanne et tombe sur la
variété annoncée, au lieu d'arriver dans un catalogue où il devra la
retrouver — et où il ne la retrouve pas toujours.

Dans l'onglet Réglages, section *Liens et QR codes* : on choisit la
destination (la boutique, ou n'importe quel article), le QR s'affiche, le lien
se copie d'un bouton. Un second bouton l'envoie en PNG dans la conversation du
bot, prêt à être glissé dans un visuel — en document plutôt qu'en photo,
Telegram recompressant les photos et un QR destiné à l'impression méritant de
rester au pixel près. La fiche de chaque produit porte aussi un raccourci
**🔗 Lien & QR** qui mène droit à sa destination.

La forme du lien est celle que Telegram attend :

```
https://t.me/<nom-du-bot>?startapp=p_<identifiant-du-produit>
```

`BOT_USERNAME` dans l'environnement évite d'aller demander le nom à Telegram
au premier lien ; sans lui, il est demandé une fois puis gardé.

Un article masqué a quand même son lien, avec un avertissement : on prépare
souvent le flyer avant la mise en ligne, et découvrir le problème à ce
moment-là vaut mieux que le découvrir imprimé. Un lien qui ne mène plus nulle
part — article retiré, renommé, paramètre inventé — n'affiche pas d'erreur :
la boutique s'ouvre normalement, avec un mot au client quand l'article a
disparu. **Un QR imprimé ne se corrige pas**, c'est toute la raison de ces
précautions.

Le générateur de QR est écrit dans le projet (`server/qr.js`), sans
dépendance : correction d'erreur moyenne, versions 1 à 10, rendu en SVG pour
l'écran et en PNG pour l'impression. Les tests relisent la matrice module par
module, et les balayages de développement font décoder chaque QR par un
décodeur indépendant — un encodeur QR qui se trompe produit une image
parfaitement plausible et parfaitement illisible.

### Remises et codes promo

Deux mécanismes, dans l'onglet Réglages :

- **Paliers automatiques** (cinq au maximum) : « −10 % dès 100 € ». Ils sont
  publics — la boutique les annonce dans le panier et dit ce qu'il manque pour
  atteindre le suivant.
- **Codes promo** : pourcentage ou montant fixe, avec panier minimum, date
  d'expiration, nombre d'usages et option « une seule fois par client ».

> 🧮 **Un client ne cumule jamais les deux : la meilleure des deux remises
> s'applique.** Cumuler ouvre la porte aux additions surprises (un code de 20 %
> sur un panier déjà remisé de 15 %) et rend le prix impossible à expliquer au
> téléphone. Si le code saisi est moins avantageux que le palier, la boutique
> le dit et garde le palier.

Le minimum de commande et le franco de livraison se jugent sur le panier
**avant remise** : un code ne doit pas faire repasser une commande sous le
minimum qu'elle venait d'atteindre. Le code n'est décompté qu'une fois la
commande écrite, et le montant de la remise est recalculé côté serveur — celui
envoyé par le client est ignoré.

### Annonces

Un message à ceux qui ont **déjà commandé** — eux seuls, parce que Telegram
interdit d'écrire à qui n'a jamais parlé au bot, et c'est très bien ainsi.
L'écran chiffre l'audience avant que tu n'écrives : on ne parle pas de la même
façon à trois personnes qu'à trois cents.

Trois garde-fous, parce qu'un bot qui envoie trop finit bloqué par ses propres
clients et parfois par Telegram :

| Garde-fou | Ce qu'il empêche |
|---|---|
| Désabonnement respecté d'abord | écrire à quelqu'un qui a dit stop |
| Cadence de 12 h entre deux annonces | envoyer trois fois le même jour |
| Envoi étalé, par paquets de 20 | dépasser la limite de Telegram et se faire couper |

Chaque annonce se termine par la façon de s'en désabonner. Un client qui écrit
`/stop` ne reçoit plus rien, `/annonces` le remet dans la liste, et le vendeur
dispose des deux boutons pour ceux qui le lui demandent de vive voix. **Les
messages sur ses propres commandes continuent** : ce sont des réponses, pas de
la publicité.

Un client qui a bloqué le bot fait échouer son envoi sans que le reste en
souffre, et il est désabonné au passage — il a dit non à sa manière. Une panne
réseau, elle, ne désabonne personne : seul un refus explicite de Telegram
compte.

### Export et sauvegarde

Deux fichiers, deux usages, tous deux **envoyés dans la conversation du bot** :
un téléchargement lancé depuis la WebView de Telegram n'aboutit pas toujours,
un document déposé dans le chat se retrouve toujours.

- **Export des commandes (CSV)** : une ligne par article, filtrable sur une
  période. Les montants sortent avec une virgule décimale et le fichier porte
  un BOM, sans quoi un tableur français affiche « NÃ©on » et lit les prix de
  travers. Une note contenant un point-virgule est mise entre guillemets, et
  une note commençant par `=` est préfixée d'une apostrophe : sans ça, le
  tableur l'exécuterait comme une formule.
- **Sauvegarde complète** : catalogue, commandes, réglages et codes, en JSON.
  Elle se relit dans l'écran Réglages, qui annonce son contenu et sa date
  **avant** de proposer le remplacement — restaurer efface la boutique.

> 🔐 **Aucun secret n'en sort.** Ni jeton de bot, ni adresse de base, ni liste
> d'administrateurs : ces fichiers finissent dans un dossier de
> téléchargements ou une conversation transférée, ils ne doivent rien contenir
> qui ouvre la boutique. Un test le vérifie à chaque exécution.

Restaurer remet le catalogue d'abord — les commandes s'y réfèrent —, puis les
commandes, puis les réglages. Les compteurs d'usage des codes promo sont
repris tels quels : sinon une restauration rendrait à tout le monde un code
déjà consommé.

### Alertes de stock

Deux sens, réglés par un seul seuil (onglet Réglages) :

- **Vers toi** : dès qu'une commande fait passer un article sous le seuil, le
  bot t'écrit. Tu ne découvres plus la rupture en lisant une commande.
- **Vers le client** : sur un article épuisé, un bouton « préviens-moi du
  retour ». Dès que tu réassortis — ou qu'une annulation remet l'article en
  rayon — le bot écrit à ceux qui attendaient, et la liste se vide.

La liste ne garde qu'un identifiant Telegram par ligne de catalogue, et le
message ne part qu'au franchissement de zéro : passer de 2 à 5 n'intéresse
personne.

---

## Contrôles à l'entrée

Deux portes, indépendantes, activables depuis l'espace admin (onglet Réglages).

### Épreuve anti-robot

Une grille de neuf tuiles à résoudre avant de pouvoir commander, vérifiée côté
serveur. À noter : la vraie barrière contre les robots reste la signature
Telegram contrôlée à chaque appel — sans compte Telegram, aucune commande.
L'épreuve ajoute une friction et un geste conscient à l'entrée. Activée par
défaut, elle se coupe d'une case.

### Épreuve d'entrée du bot

Un petit calcul au premier `/start`, avant que le bot ne réponde quoi que ce
soit :

```
🔒 Petite vérification avant d'entrer.

Combien font 7 + 4 ?
   [ 9 ] [ 11 ] [ 14 ]
   [ 6 ] [ 12 ] [ 17 ]
```

Un robot sait additionner : ce calcul n'est pas une énigme, c'est un **péage**.
Il coûte un aller-retour et une attente à qui voudrait noyer la boutique sous
les faux comptes, et un geste, une fois, à un client. Trois choix font la
différence entre une porte et un tourniquet :

- **la réponse ne quitte jamais le serveur** — les boutons ne portent que la
  valeur proposée, le résultat juste reste rangé avec l'épreuve ;
- **une erreur fait tirer un nouveau calcul** — sinon il suffirait d'essayer
  les six boutons l'un après l'autre ;
- **trois erreurs valent dix minutes d'attente**, ce qui rend l'essai
  systématique plus cher que le renoncement.

La réponse se touche ou s'écrit (« 11 » suffit). Trois personnes ne sont jamais
interrogées : **l'administrateur**, **un client qui a déjà commandé** — le
prendre pour un inconnu serait lui faire repayer une porte déjà franchie — et
**une commande venue de la Mini App**, signée par Telegram, ce qui vaut mieux
qu'un calcul. `/admin` reste ouvert aussi : c'est par lui qu'un vendeur qui
vient d'installer sa boutique découvre son identifiant Telegram, et lui opposer
un calcul le laisserait devant une porte dont il cherche justement la clé.

Activée par défaut, elle se coupe d'une case. Elle ne remplace pas l'épreuve
anti-robot de la Mini App : celle-ci garde l'entrée de la boutique, celle-là
garde l'entrée de la conversation.

### Vérification d'identité

Quand elle est active, un client doit faire valider une pièce d'identité avant
de commander. Le client l'envoie en photo dans la conversation du bot ; le
vendeur la reçoit avec deux boutons, **Valider** ou **Refuser**.

> 🔐 **Le document n'est ni téléchargé ni conservé par la boutique.** Il reste
> dans la conversation Telegram, et le serveur n'enregistre que le verdict :
> statut, date de la demande, date et auteur de la décision. Aucune référence
> au fichier n'est gardée. Supprime le message une fois la décision prise.

Une pièce d'identité est une donnée personnelle sensible : n'active cette
vérification que si la loi de ton pays l'exige pour ce que tu vends, et
n'en conserve pas plus que le verdict.

Le pilotage se fait aussi depuis le bot :

```
/verification        → l'état actuel, avec les boutons
/verification on     → activer
/verification off    → désactiver
```

---

## ⚖️ Cadre légal

Ce dépôt est un **modèle de boutique** : le code ne présume rien de ce que tu vends.

La vente de produits à base de cannabis est **encadrée ou interdite selon les pays et
les régions**. Avant toute mise en ligne, vérifie ce que la loi autorise là où tu te
trouves et où sont tes clients, et procure-toi les autorisations nécessaires.
Un contrôle d'âge 18+ et un bandeau d'information sont intégrés, mais ils ne
remplacent pas une vérification d'identité réelle ni une licence de vente.

Les illustrations sont des créations originales : aucun personnage sous droits
d'auteur n'est utilisé, la boutique est donc publiable telle quelle.
