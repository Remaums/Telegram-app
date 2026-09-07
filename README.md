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
  id: 'kartoon-kush',            // identifiant unique, sans espaces
  name: 'Kartoon Kush',
  category: 'fleurs',            // doit exister dans `categories`
  price: 1200,                   // EN CENTIMES : 1200 = 12,00 €
  image: '/assets/products/jar.svg',
  badge: 'TOP VENTE',            // pastille rouge, optionnelle
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

### Les images

Les illustrations sont des SVG originaux dans `webapp/assets/products/`, générés par
`node tools/generate-art.mjs` (dégradés doux, pensés pour un fond sombre).
Pour utiliser tes vraies photos : dépose-les dans ce dossier et pointe `image`
dessus (`/assets/products/ma-photo.jpg`). Un format carré rend le mieux dans la grille.

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

## Commandes du bot

| Commande | Effet |
|---|---|
| `/start` | Message d'accueil + bouton boutique + affiche l'ID du client |
| `/boutique` | Rouvre la Mini App |
| `/commandes` | Les 5 dernières commandes du client |
| `/aide` | Liste des commandes |
| `/admin` | Espace d'administration (réservé aux `ADMIN_IDS`) |

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

Tests automatisés — 38 tests couvrant l'authentification, la falsification de prix,
les droits d'admin, la gestion du stock et les transitions de statut
(serveur démarré dans un autre terminal) :

```bash
npm test
```

---

## Stockage des commandes

Le catalogue et les commandes sont écrits dans `server/data/catalog.json` et
`server/data/orders.json` (créés automatiquement, ignorés par git). Les écritures
sont sérialisées et atomiques : pas de JSON tronqué si le serveur s'arrête en
pleine sauvegarde.

C'est suffisant pour démarrer. Au-delà de quelques milliers de commandes, passe sur
SQLite ou Postgres : seul `server/json-store.js` est à réécrire.

> 💾 **Pense à sauvegarder `server/data/`** : c'est là que vivent ton catalogue et
> tes commandes.

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
