# Mettre la boutique en ligne sur un VPS

Guide complet, du VPS vide au bouton « Ouvrir la boutique » dans Telegram.
Compter une trentaine de minutes la première fois.

Sur un VPS, un vrai processus tourne en permanence : le bot fonctionne en
**long polling** (aucun webhook à déclarer) et le catalogue vit dans des
**fichiers JSON** sur le disque. Ni Postgres ni Vercel ne sont nécessaires —
c'est le mode le plus simple du projet.

---

## Ce qu'il te faut

| | |
|---|---|
| Un VPS | Debian 12 ou Ubuntu 22.04+, 1 vCPU et 1 Go de RAM suffisent |
| Une URL en HTTPS | Telegram n'ouvre une Mini App qu'en HTTPS, jamais sur une IP nue. Un nom de domaine est l'option propre, mais l'étape 6 en donne deux gratuites pour commencer |
| Un token de bot | donné par [@BotFather](https://t.me/BotFather) |

---

## Le chemin rapide : laisser le script faire

Les étapes 2 à 8 ci-dessous sont mécaniques. Un script les exécute :

```bash
# Une fois le dépôt cloné (étape 3) :
cd ~/Telegram-app
bash deploy/installer.sh
```

Il installe Node si besoin, les dépendances, le service systemd réglé sur ton
utilisateur et ton chemin réels, le pare-feu, et te demande lequel des trois
accès HTTPS tu veux (tunnel Cloudflare, DuckDNS, ton domaine). Il se relance
sans dégât : chaque étape regarde d'abord si elle a déjà été faite, et il ne
remplace jamais un réglage existant sans te le demander.

Ce qu'il ne peut pas faire à ta place, et qu'il te rappelle à la fin : créer le
bot chez BotFather, y coller l'adresse de la Mini App, et relever ton
identifiant Telegram.

**Lis quand même les étapes qui suivent.** Le script fait les gestes ; elles
expliquent pourquoi, ce qui compte le jour où quelque chose cloche.

### Quand quelque chose cloche

```bash
bash deploy/diagnostic.sh
```

Sort en un seul bloc l'état de la machine : version de Node, état du service,
quelles clefs de configuration sont remplies, si la boutique répond, l'état du
certificat, et les dernières lignes du journal. C'est ce qu'on demande toujours
en premier — autant l'avoir d'un coup.

> 🔐 **Ce rapport ne contient aucun secret.** Le contenu de `.env` n'est jamais
> affiché : pour chaque clef, il dit seulement « renseignée » ou « vide ». Les
> tokens et mots de passe qui traîneraient dans les journaux sont masqués. Il
> est fait pour être collé dans une conversation sans rien y laisser fuir.

---

## 1. Créer le bot chez BotFather

Dans Telegram, écris à **@BotFather** :

```
/newbot
```

Il demande un nom affiché (« COFFEE SHOP 68 ») puis un identifiant se terminant
par `bot` (`coffeeshop68_bot`). Il répond avec un token du type
`8123456789:AAH...`. **Garde-le secret** : quiconque l'a peut piloter ton bot.

Tu reviendras chez BotFather à l'étape 9, une fois le site en ligne.

---

## 2. Préparer le VPS

Connecte-toi en SSH, puis crée un utilisateur dédié — faire tourner la boutique
en `root` n'apporte rien et coûte cher le jour où quelque chose dérape :

```bash
adduser shop           # demande un mot de passe : retiens-le
usermod -aG sudo shop
su - shop              # le tiret compte, voir plus bas
```

Le `whoami` doit maintenant répondre `shop`. L'invite du terminal change aussi :
`root@vps:~#` devient `shop@vps:~$` — le `$` au lieu du `#` est le signe qu'on
n'est plus root.

### Y revenir aux connexions suivantes

**Une reconnexion SSH te ramène à l'utilisateur avec lequel tu te connectes.**
Si c'est `root`, il faut refaire `su - shop` à chaque fois. Trois façons de
s'en sortir, de la plus simple à la plus propre :

```bash
# a) Depuis root, à chaque connexion
su - shop

# b) Se connecter directement en shop (mot de passe demandé)
ssh shop@IP-DE-TON-VPS

# c) Sans mot de passe : on recopie les clefs SSH de root vers shop.
#    À faire une fois, depuis root.
mkdir -p /home/shop/.ssh
cp /root/.ssh/authorized_keys /home/shop/.ssh/
chown -R shop:shop /home/shop/.ssh
chmod 700 /home/shop/.ssh && chmod 600 /home/shop/.ssh/authorized_keys
# désormais : ssh shop@IP-DE-TON-VPS entre directement
```

> **Le tiret de `su - shop` n'est pas décoratif.** Sans lui (`su shop`), tu
> gardes le dossier courant et les variables d'environnement de root : `~` ne
> désigne plus le bon dossier, et on se retrouve à chercher des fichiers là où
> ils ne sont pas. Avec le tiret, c'est une vraie session, comme après une
> connexion.

### Si tu as déjà tout cloné en root

Le dossier `/root` n'est pas lisible par `shop` : la boutique ne pourrait pas
y écrire ses commandes. Déplace-le une bonne fois :

```bash
# Depuis root
systemctl stop coffeeshop68 2>/dev/null
mv /root/Telegram-app /home/shop/
chown -R shop:shop /home/shop/Telegram-app
su - shop
cd ~/Telegram-app && bash deploy/installer.sh   # réécrit le service au bon chemin
```

Mets à jour et installe Node 20+ et git :

```bash
sudo apt update && sudo apt upgrade -y

# Si un Node est déjà là, c'est souvent celui des dépôts de la distribution :
# Ubuntu 22.04 livre encore Node 12, bien trop ancien pour la boutique.
sudo apt remove -y nodejs npm 2>/dev/null; sudo apt autoremove -y

curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git
hash -r      # le shell garde en cache l'ancien chemin de node
node -v      # doit afficher v22.x (v20 minimum)
```

> ⚠️ **Ne passe à la suite que si `node -v` affiche 20 ou plus.** Avec un Node
> plus ancien, l'installation s'arrête d'elle-même et le démarrage affiche un
> message qui rappelle ces commandes.

---

## 3. Récupérer le code

```bash
cd ~
git clone https://github.com/Remaums/Telegram-app.git
cd Telegram-app
git checkout claude/webapp-theme-a4nm82
npm install --omit=dev
```

> `--omit=dev` : le projet n'a pas de dépendances de développement, mais
> l'habitude évite d'installer l'inutile en production.

---

## 4. Le fichier de configuration

```bash
cp .env.example .env
nano .env
```

À remplir :

```ini
BOT_TOKEN=8123456789:AAH...        # celui de BotFather
WEBAPP_URL=https://boutique.mondomaine.fr
SELLER_USERNAME=tonpseudo          # sans @ : la conversation qui reçoit les commandes
BOT_USERNAME=coffeeshop68_bot       # sans @ : sert aux liens directs et aux QR codes
ADMIN_CHAT_ID=123456789            # ton ID Telegram (étape 10)
ADMIN_IDS=123456789                # qui peut ouvrir l'espace admin
SHOP_NAME=COFFEE SHOP 68
CURRENCY=EUR
PORT=3000
HOST=127.0.0.1                     # on n'écoute qu'en local, le proxy s'occupe du reste
```

Laisse `DATABASE_URL` et `TELEGRAM_WEBHOOK_SECRET` **vides** : ils ne servent
qu'à la mise en ligne serverless. Sur un VPS, le bot reçoit les messages en
long polling et n'a besoin d'aucun webhook. Un secret qui traîne là n'empêche
plus rien, mais la boutique le signale au démarrage — c'est le signe d'une
configuration recopiée d'un déploiement Vercel.

Protège le fichier, il contient ton token :

```bash
chmod 600 .env
```

Premier essai, en avant-plan :

```bash
npm start
```

Tu dois lire `Boutique servie sur http://127.0.0.1:3000`, `Stockage : fichiers
JSON` et `Bot @tonbot démarré.` Arrête avec `Ctrl+C`.

---

## 5. Faire tourner la boutique en service

systemd la relance après un plantage et au redémarrage du serveur.

```bash
sudo cp deploy/coffeeshop68.service /etc/systemd/system/
sudo nano /etc/systemd/system/coffeeshop68.service   # vérifie User et les chemins
sudo systemctl daemon-reload
sudo systemctl enable --now coffeeshop68
systemctl status coffeeshop68
```

Les journaux en direct :

```bash
journalctl -u coffeeshop68 -f
```

---

## 6. HTTPS sans nom de domaine (pour tester)

Telegram n'ouvre une Mini App qu'en HTTPS — c'est non négociable, et une IP
nue ne marchera jamais. Mais rien n'oblige à acheter un domaine tout de suite :
deux chemins gratuits mènent à une URL en `https://`.

### Option A — un tunnel Cloudflare (deux minutes, rien à configurer)

Le plus direct pour essayer. Aucun compte, aucun DNS, aucun port à ouvrir :
Cloudflare ouvre un tunnel sortant depuis ton VPS et te donne une adresse
HTTPS publique.

```bash
# Sur le VPS, la boutique tournant déjà sur le port 3000
sudo apt install -y curl
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb

cloudflared tunnel --url http://localhost:3000
```

Il affiche au bout de quelques secondes une ligne du type :

```
https://random-words-here.trycloudflare.com
```

C'est ton `WEBAPP_URL`. Reporte-la dans `.env`, redémarre la boutique, et
colle-la chez BotFather (étape 8).

> ⚠️ **L'adresse change à chaque redémarrage du tunnel.** À chaque fois il faut
> la remettre dans `.env` **et** chez BotFather. C'est acceptable pour tester
> une soirée, intenable pour une vraie boutique — d'où l'option B.

Si aucune adresse n'apparaît au bout d'une minute, la cause est presque
toujours la même : `cloudflared` sort en QUIC sur le port **UDP 7844**, et
beaucoup d'hébergeurs filtrent l'UDP sortant. Le tunnel retente alors sans fin,
silencieusement. Le remède est de forcer le TCP :

```bash
cloudflared tunnel --protocol http2 --url http://localhost:3000
```

`deploy/installer.sh` détecte ce cas dans le journal et bascule tout seul. Si
même le HTTP/2 ne passe pas, ta sortie réseau est trop filtrée pour un tunnel :
prends l'option B, qui ne demande que le 80 et le 443.

Pour que le tunnel survive à la fermeture de ta session SSH :

```bash
sudo tee /etc/systemd/system/tunnel.service >/dev/null <<'EOF'
[Unit]
Description=Tunnel Cloudflare vers la boutique
After=network-online.target

[Service]
ExecStart=/usr/bin/cloudflared tunnel --url http://localhost:3000
Restart=always
User=shop

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now tunnel
journalctl -u tunnel -n 20      # pour relire l'adresse attribuée
```

### Option B — un sous-domaine gratuit qui, lui, ne bouge pas

[DuckDNS](https://www.duckdns.org) donne gratuitement un sous-domaine du type
`ma-boutique.duckdns.org` pointant vers l'IP de ton choix. C'est un vrai nom de
domaine du point de vue de Let's Encrypt : Caddy obtient un certificat dessus
sans rien de particulier, et l'adresse reste la même.

1. Va sur [duckdns.org](https://www.duckdns.org), connecte-toi (Google, GitHub…),
   choisis un nom et mets l'**IP de ton VPS** dans le champ `current ip`.
2. Vérifie que ça résout : `dig +short ma-boutique.duckdns.org`
3. Reprends l'étape 7 (Caddy) **telle quelle**, en mettant
   `ma-boutique.duckdns.org` dans le `Caddyfile`.

Le jour où tu achètes un vrai domaine, tu changes deux choses — la ligne du
`Caddyfile` et `WEBAPP_URL` — et tu recolles l'URL chez BotFather. Rien d'autre
ne bouge, les données restent où elles sont.

> **Freenom** (`.tk`, `.ml`, `.ga`…) revient souvent dans les recherches :
> l'inscription y est fermée depuis 2023, ce n'est plus une piste.

---

## 7. Domaine et HTTPS (une fois le domaine acheté)

**a.** Chez ton registrar, crée un enregistrement **A** qui pointe
`boutique.mondomaine.fr` vers l'IP de ton VPS. Vérifie la propagation :

```bash
dig +short boutique.mondomaine.fr
```

**b.** Installe Caddy — il obtient et renouvelle le certificat tout seul :

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile      # remplace le domaine
sudo systemctl reload caddy
```

Ouvre `https://boutique.mondomaine.fr` dans un navigateur : la boutique doit
s'afficher, cadenas compris.

> Tu préfères Nginx ? `deploy/nginx.conf` est fourni ; le certificat s'obtient
> ensuite avec `sudo certbot --nginx -d boutique.mondomaine.fr`.

---

## 8. Pare-feu

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp     # inutile avec un tunnel Cloudflare : il sort, il n'entre pas
sudo ufw enable
sudo ufw status
```

Le port 3000 n'est **pas** ouvert : avec `HOST=127.0.0.1`, la boutique n'est
joignable que par le proxy — ou par le tunnel, qui tourne sur la machine.

---

## 9. Déclarer la Mini App chez BotFather

Retour dans la conversation avec **@BotFather** :

```
/mybots → ton bot → Bot Settings → Menu Button → Edit menu button URL
```

Colle `https://boutique.mondomaine.fr`, puis donne un libellé au bouton
(« Boutique »). Tant que tu y es : `/setdescription`, `/setabouttext` et
`/setuserpic` soignent la fiche du bot.

---

## 10. Devenir administrateur

Écris `/start` à ton bot : il affiche ton identifiant Telegram. Reporte-le dans
`.env` (`ADMIN_IDS` et `ADMIN_CHAT_ID`), puis redémarre :

```bash
nano .env
sudo systemctl restart coffeeshop68
```

`/admin` t'ouvre alors l'espace de gestion. Pour plusieurs administrateurs :
`ADMIN_IDS=123456789,987654321`.

---

## 11. Vérifier que tout tient debout

```bash
npm run doctor https://boutique.mondomaine.fr
```

Le diagnostic contrôle la configuration, appelle `/api/health` (stockage
joignable, nombre de produits), vérifie que la Mini App est servie et demande à
Telegram l'état du webhook. Tout doit être au vert, sauf l'avertissement
« aucun webhook déclaré » : c'est normal et voulu en long polling.

Puis, dans Telegram : `/start` → **Ouvrir la boutique**. Passe une commande de
test, elle doit arriver dans ta conversation avec les boutons de traitement.

---

## 12. Mettre à jour la boutique

```bash
cd ~/Telegram-app
git pull
npm install --omit=dev
sudo systemctl restart coffeeshop68
```

---

## 13. Sauvegarder

Tout ce qui est précieux tient dans deux fichiers : `server/data/catalog.json`
(ton catalogue et tes stocks) et `server/data/orders.json` (tes commandes).

```bash
mkdir -p ~/sauvegardes
crontab -e
```

Une ligne pour une sauvegarde quotidienne, gardée 30 jours :

```cron
0 4 * * * tar czf ~/sauvegardes/boutique-$(date +\%F).tgz -C ~/Telegram-app/server data && find ~/sauvegardes -name 'boutique-*.tgz' -mtime +30 -delete
```

---

## 14. Quand ça coince

| Symptôme | Cause la plus fréquente | Ce qu'il faut faire |
|---|---|---|
| Le tunnel ne rend jamais d'adresse | l'hébergeur filtre l'UDP sortant (port 7844), que cloudflared utilise par défaut | `sudo systemctl edit tunnel` et forcer `--protocol http2` (le 443 en TCP), ou `bash deploy/installer.sh` qui bascule tout seul |
| `failed to request quick Tunnel` | Cloudflare refuse les tunnels anonymes depuis cette IP | passe à l'option 2 du guide (DuckDNS), qui n'a besoin que du 80 et du 443 |
| Le service redémarre en boucle (`NRestarts` qui grimpe) | une exception au démarrage, que `Restart=always` relance indéfiniment | `sudo journalctl -u coffeeshop68 -n 50` : la trace est en haut de chaque cycle |
| La boutique s'ouvre mais paraît vide | le catalogue n'a pas pu être chargé — l'écran le dit maintenant en clair (« Boutique momentanément injoignable ») au lieu de ressembler à une boutique sans produits | `curl -s localhost:3000/api/catalog \| head -c 200` sur le VPS ; s'il répond une erreur, `sudo journalctl -u coffeeshop68 -n 30` la nomme |
| `/admin` ne répond rien | `WEBAPP_URL` vide ou en HTTP : Telegram refuse le message entier quand un bouton Mini App porte une URL invalide | le bot le dit maintenant explicitement ; renseigne `WEBAPP_URL` en `https://…`, puis redémarre |
| `/admin` répond « réservé à l'administrateur » | ton identifiant n'est pas déclaré, ou la boutique n'a pas été redémarrée depuis | le refus t'affiche ton identifiant : mets-le dans `ADMIN_IDS`, puis `sudo systemctl restart coffeeshop68`. `ADMIN_CHAT_ID` compte aussi. |
| **Le bot ne répond pas à `/start`** | dans l'ordre de probabilité : un webhook resté déclaré (le long polling ne reçoit alors plus rien), un token mal recopié, ou le service arrêté | `bash deploy/diagnostic.sh` tranche les trois en une commande |
| `409 Conflict` dans les journaux | un webhook est resté déclaré (essai Vercel), il se dispute les mises à jour avec le long polling | `node tools/set-webhook.mjs --delete` |
| Le bouton du menu ne s'ouvre pas | l'URL n'est pas en HTTPS valide | vérifie le certificat : `curl -I https://ton-domaine` |
| `502 Bad Gateway` | la boutique ne tourne pas | `systemctl status coffeeshop68`, puis `journalctl -u coffeeshop68 -n 50` |
| `EADDRINUSE` | le port 3000 est déjà pris | `sudo lsof -i :3000`, ou change `PORT` dans `.env` |
| `sudo : commande introuvable` ou `shop n'est pas dans le fichier sudoers` | l'utilisateur a été créé sans les droits | depuis root : `usermod -aG sudo shop`, puis reconnecte-toi |
| `bash: cd: /home/shop/Telegram-app : Aucun fichier` | le dépôt a été cloné ailleurs, souvent dans `/root` | voir « Si tu as déjà tout cloné en root », étape 2 |
| `EACCES` sur `server/data` | le service n'écrit pas dans son dossier | `sudo chown -R shop:shop ~/Telegram-app` |
| Commande passée, rien reçu | `ADMIN_CHAT_ID` absent ou faux | corrige `.env` et redémarre |
| L'espace admin refuse l'accès | ton ID n'est pas dans `ADMIN_IDS` | `/start` pour le relire, corrige, redémarre |
| Le bot ne démarre pas | token invalide | recopie le token de BotFather, sans espace |
| `SyntaxError: Unexpected token '?'` | Node trop ancien (celui des dépôts Ubuntu) | `sudo apt remove -y nodejs npm`, puis réinstalle par NodeSource (étape 2), `hash -r`, `node -v` |
| `npm install` refuse : `Unsupported engine` | même cause, détectée plus tôt | idem : passe à Node 20+ |

---

## Et la sécurité ?

- `.env` en `chmod 600`, jamais commité (il est déjà dans `.gitignore`).
- La boutique tourne sous un utilisateur sans privilèges, pas en `root`.
- Le port applicatif n'est pas exposé : `HOST=127.0.0.1` plus `ufw`.
- Chaque appel à l'API est vérifié par la signature Telegram, et l'espace admin
  filtre en plus sur `ADMIN_IDS`.
- Les prix sont recalculés côté serveur : un panier trafiqué n'obtient pas de
  remise.
