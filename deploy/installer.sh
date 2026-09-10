#!/usr/bin/env bash
#
# Installation de la boutique sur un VPS Debian/Ubuntu neuf.
#
#   bash deploy/installer.sh
#
# Le script fait ce que le guide docs/vps.md fait faire à la main : Node, les
# dépendances, le service systemd, le pare-feu, et selon le choix un tunnel
# Cloudflare ou Caddy. Il ne remplace pas le guide, il en exécute les étapes
# mécaniques — ce qui reste à comprendre (BotFather, ton identifiant admin)
# reste à faire par toi, le script te le rappelle à la fin.
#
# Deux principes :
#
#  - Il se relance sans dégât. Chaque étape regarde d'abord si elle a déjà été
#    faite. Une coupure réseau au milieu ne laisse donc rien de cassé : on
#    relance, et il reprend où il s'était arrêté.
#  - Il ne touche jamais à un .env existant. Tes réglages et tes secrets sont
#    à toi ; au pire il écrit un .env.nouveau à côté et te le dit.

set -euo pipefail

NOEUD_MINIMUM=20
SERVICE=coffeeshop68
RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── De quoi lire ce qui se passe ────────────────────────────

if [ -t 1 ] && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  GRAS=$(tput bold); VERT=$(tput setaf 2); ROUGE=$(tput setaf 1)
  JAUNE=$(tput setaf 3); FIN=$(tput sgr0)
else
  GRAS=''; VERT=''; ROUGE=''; JAUNE=''; FIN=''
fi

etape() { printf '\n%s▸ %s%s\n' "$GRAS" "$1" "$FIN"; }
fait()  { printf '  %s✓%s %s\n' "$VERT" "$FIN" "$1"; }
note()  { printf '  %s·%s %s\n' "$JAUNE" "$FIN" "$1"; }
stop()  { printf '\n%s✗ %s%s\n\n' "$ROUGE" "$1" "$FIN" >&2; exit 1; }

# Un mot d'explication à chaque refus : un script qui s'arrête sans dire
# pourquoi laisse son utilisateur devant un terminal muet.
trap 'stop "Interrompu à la ligne $LINENO. Rien n'\''est à demi installé : relance le script, il reprend où il en était."' ERR

# ── Vérifications d'entrée ──────────────────────────────────

etape "Vérifications"

[ "$(id -u)" -ne 0 ] || stop "Ne lance pas ce script en root. Crée un utilisateur dédié :
    adduser shop && usermod -aG sudo shop && su - shop
  puis reprends depuis le clone du dépôt."

command -v sudo >/dev/null || stop "sudo est absent. Installe-le en root : apt install -y sudo"

sudo -v >/dev/null 2>&1 || stop "Ton utilisateur n'a pas sudo. En root : usermod -aG sudo $(id -un), puis reconnecte-toi."

[ -f "$RACINE/package.json" ] || stop "Ce script doit être lancé depuis le dépôt : cd ~/Telegram-app && bash deploy/installer.sh"

source /etc/os-release 2>/dev/null || true
case "${ID:-}${ID_LIKE:-}" in
  *debian*|*ubuntu*) fait "${PRETTY_NAME:-système Debian/Ubuntu}" ;;
  *) note "Système non testé (${PRETTY_NAME:-inconnu}) : le script suppose apt. Ctrl+C pour renoncer."
     sleep 4 ;;
esac

fait "utilisateur $(id -un), dépôt $RACINE"

# ── Node ────────────────────────────────────────────────────

etape "Node $NOEUD_MINIMUM ou plus"

version_noeud() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }

actuelle="$(version_noeud || true)"
if [ -n "$actuelle" ] && [ "$actuelle" -ge "$NOEUD_MINIMUM" ]; then
  fait "Node $(node -v) déjà en place"
else
  if [ -n "$actuelle" ]; then
    note "Node $(node -v) est trop ancien — c'est presque toujours celui des dépôts de la distribution."
    sudo apt-get remove -y nodejs npm >/dev/null 2>&1 || true
    sudo apt-get autoremove -y >/dev/null 2>&1 || true
  fi
  note "Installation de Node 22 par NodeSource…"
  sudo apt-get update -qq
  sudo apt-get install -y -qq curl ca-certificates gnupg >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
  hash -r   # le shell garde en cache l'ancien chemin de node

  actuelle="$(version_noeud || true)"
  [ -n "$actuelle" ] && [ "$actuelle" -ge "$NOEUD_MINIMUM" ] \
    || stop "Node est encore en ${actuelle:-absent} après installation. Ouvre un nouveau shell et relance : le cache des chemins du shell courant peut masquer la nouvelle version."
  fait "Node $(node -v)"
fi

command -v git >/dev/null || { sudo apt-get install -y -qq git >/dev/null; fait "git installé"; }

# ── Dépendances du projet ───────────────────────────────────

etape "Dépendances de la boutique"
cd "$RACINE"
npm install --omit=dev --no-audit --no-fund >/dev/null
fait "$(ls node_modules | wc -l) paquets installés"

# ── Configuration ──────────────────────────────────────────

# Pose une clef dans .env, qu'elle y soit déjà ou pas.
#
# Un simple `sed -i s/^CLEF=.*/` ne remplace que ce qui existe : sur un .env
# écrit à la main où la ligne manque, il ne fait rien — silencieusement, ce qui
# est pire que d'échouer. On ajoute donc la ligne quand elle est absente.
regler_clef() {
  local clef=$1 valeur=$2
  if grep -qE "^${clef}=" .env; then
    sed -i "s|^${clef}=.*|${clef}=${valeur}|" .env
  else
    printf '%s=%s\n' "$clef" "$valeur" >> .env
  fi
}

etape "Fichier de configuration"

if [ -f .env ]; then
  fait ".env déjà présent — je n'y touche pas"
  # Les permissions, en revanche, se resserrent : un .env lisible par tous
  # livre le token du bot à n'importe quel compte de la machine.
  if [ "$(stat -c '%a' .env)" != 600 ]; then
    chmod 600 .env
    fait "permissions resserrées à 600 (le contenu, lui, est intact)"
  fi
  manquantes=()
  for clef in BOT_TOKEN WEBAPP_URL SELLER_USERNAME ADMIN_IDS; do
    grep -qE "^${clef}=.+" .env || manquantes+=("$clef")
  done
  [ ${#manquantes[@]} -eq 0 ] \
    && fait "les clefs essentielles sont renseignées" \
    || note "à remplir avant de démarrer : ${manquantes[*]}"
else
  cp .env.example .env
  chmod 600 .env
  fait ".env créé depuis le modèle, en lecture pour toi seul"
  note "Il faut le remplir maintenant : BOT_TOKEN, WEBAPP_URL, SELLER_USERNAME, ADMIN_IDS."
fi

# HOST=127.0.0.1 : la boutique n'écoute qu'en local, le proxy ou le tunnel
# s'occupe de l'extérieur. Sans ça le port 3000 serait exposé en clair.
grep -q '^HOST=' .env || { printf '\n# La boutique n'\''écoute qu'\''en local : le proxy ou le tunnel fait le reste.\nHOST=127.0.0.1\n' >> .env; fait "HOST=127.0.0.1 ajouté"; }

# ── Service systemd ────────────────────────────────────────

etape "Service systemd"

CIBLE=/etc/systemd/system/$SERVICE.service
NOEUD="$(command -v node)"

# Le modèle est écrit pour l'utilisateur « shop » dans /home/shop : on le
# réécrit pour l'utilisateur et le chemin réels, quels qu'ils soient.
sudo tee "$CIBLE" >/dev/null <<SERVICE
# Engendré par deploy/installer.sh — modifiable, mais un nouveau passage du
# script l'écrasera. Pour des réglages durables, utilise un fichier
# d'extension : /etc/systemd/system/$SERVICE.service.d/local.conf
[Unit]
Description=Boutique Telegram ($SERVICE)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$RACINE
ExecStart=$NOEUD server/index.js
EnvironmentFile=$RACINE/.env
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=$RACINE/server/data

[Install]
WantedBy=multi-user.target
SERVICE

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE" >/dev/null 2>&1
fait "service installé pour $(id -un), depuis $RACINE"

# On ne démarre que si la configuration peut tenir debout : un service qui
# boucle sur un token absent remplit le journal pour rien.
if grep -qE '^BOT_TOKEN=.+' .env; then
  sudo systemctl restart "$SERVICE"
  sleep 3
  if systemctl is-active --quiet "$SERVICE"; then
    fait "boutique démarrée"
  else
    note "La boutique n'a pas démarré. Les vingt dernières lignes du journal :"
    sudo journalctl -u "$SERVICE" -n 20 --no-pager | sed 's/^/      /'
  fi
else
  note "Service installé mais pas démarré : BOT_TOKEN est vide dans .env."
fi

# ── Pare-feu ───────────────────────────────────────────────

etape "Pare-feu"
if command -v ufw >/dev/null; then
  sudo ufw allow OpenSSH >/dev/null 2>&1 || true
  sudo ufw allow 80,443/tcp >/dev/null 2>&1 || true
  sudo ufw --force enable >/dev/null 2>&1 || true
  fait "SSH, 80 et 443 ouverts ; le port 3000 reste fermé"
else
  note "ufw absent, pare-feu non configuré (sudo apt install ufw pour l'ajouter)."
fi

# ── Comment atteindre la boutique depuis l'extérieur ───────

etape "Accès en HTTPS"
cat <<'TEXTE'
  Telegram n'ouvre une Mini App qu'en HTTPS. Trois chemins, au choix :

    1) Tunnel Cloudflare — gratuit, deux minutes, aucun domaine.
       L'adresse change à chaque redémarrage du tunnel.
    2) Sous-domaine DuckDNS + Caddy — gratuit, adresse stable.
    3) Ton propre domaine + Caddy — la mise en production.

TEXTE
printf '  Lequel installer ? [1/2/3, ou Entrée pour ne rien faire] '
read -r choix || choix=''

case "${choix:-}" in
  1)
    if ! command -v cloudflared >/dev/null; then
      note "Installation de cloudflared…"
      arch=$(dpkg --print-architecture)
      curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.deb" -o /tmp/cloudflared.deb
      sudo dpkg -i /tmp/cloudflared.deb >/dev/null
      rm -f /tmp/cloudflared.deb
    fi

    # Pose le service du tunnel, éventuellement en forçant un protocole.
    #
    # Par défaut cloudflared sort en QUIC, sur le port UDP 7844. Beaucoup
    # d'hébergeurs filtrent l'UDP sortant : le tunnel retente alors
    # indéfiniment sans jamais obtenir d'adresse, ce qui ressemble à un
    # blocage. `--protocol http2` passe par le 443 en TCP, qui lui est
    # toujours ouvert — un peu moins rapide, mais il marche partout.
    poser_tunnel() {
      local protocole=${1-}
      local options='tunnel --url http://localhost:3000'
      [ -n "$protocole" ] && options="tunnel --protocol $protocole --url http://localhost:3000"
      sudo tee /etc/systemd/system/tunnel.service >/dev/null <<TUNNEL
[Unit]
Description=Tunnel Cloudflare vers la boutique
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$(command -v cloudflared) $options
Restart=always
RestartSec=5
User=$(id -un)

[Install]
WantedBy=multi-user.target
TUNNEL
      sudo systemctl daemon-reload
      sudo systemctl restart tunnel
      sudo systemctl enable tunnel >/dev/null 2>&1
    }

    # Guette l'adresse dans le journal, le temps qu'il faut.
    #
    # Un `sleep` unique ne suffit pas : sur un petit VPS, l'établissement du
    # tunnel prend parfois une demi-minute. On regarde donc régulièrement, et
    # on s'arrête dès qu'on a trouvé.
    guetter_adresse() {
      local reste=${1:-75} trouve=''
      while [ "$reste" -gt 0 ]; do
        trouve=$(sudo journalctl -u tunnel -n 200 --no-pager 2>/dev/null \
          | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)
        [ -n "$trouve" ] && { printf '%s' "$trouve"; return 0; }
        sleep 3
        reste=$((reste - 3))
        # Les points d'attente vont sur la sortie d'erreur : sur la sortie
        # standard ils seraient capturés avec l'adresse, et `WEBAPP_URL`
        # vaudrait « ......... » — un échec déguisé en succès.
        printf '.' >&2
      done
      return 1
    }

    poser_tunnel
    fait "tunnel lancé"
    printf '  %s·%s Je guette l'"'"'adresse (jusqu'"'"'à 75 s)' "$JAUNE" "$FIN" >&2
    adresse=$(guetter_adresse 75 || true)
    printf '\n' >&2

    # Rien après 75 s : l'UDP sortant est le suspect numéro un. On bascule en
    # HTTP/2 et on laisse une seconde chance, au lieu de rendre la main.
    if [ -z "$adresse" ] && sudo journalctl -u tunnel -n 200 --no-pager 2>/dev/null \
         | grep -qiE 'quic|udp|7844|timeout|failed to (dial|connect)'; then
      note "Pas d'adresse, et le journal parle de QUIC/UDP : ton hébergeur filtre probablement l'UDP sortant."
      note "Je rebascule le tunnel en HTTP/2 (port 443 en TCP) et je réessaie…"
      poser_tunnel http2
      printf '  %s·%s Seconde tentative' "$JAUNE" "$FIN" >&2
      adresse=$(guetter_adresse 75 || true)
      printf '\n' >&2
      [ -n "$adresse" ] && fait "c'était bien ça : le tunnel passe en HTTP/2"
    fi

    # Une dernière vérification de forme avant d'écrire quoi que ce soit : une
    # adresse mal formée dans .env casserait la boutique en silence.
    case "$adresse" in
      https://*.trycloudflare.com) ;;
      *) [ -n "$adresse" ] && note "Adresse inattendue ($adresse), ignorée." ; adresse='' ;;
    esac

    if [ -n "$adresse" ]; then
      printf '\n  %sTon adresse : %s%s\n' "$GRAS" "$adresse" "$FIN"
      regler_clef WEBAPP_URL "$adresse"
      sudo systemctl restart "$SERVICE"
      fait "WEBAPP_URL posé dans .env, boutique redémarrée"
      note "Reste à la coller chez BotFather (Menu Button)."
      note "Elle changera au prochain redémarrage du tunnel : il faudra alors relancer ce script."
    else
      # On montre le journal plutôt que d'inviter à aller le lire : c'est
      # précisément l'information qui manque à qui reste devant un écran muet.
      note "Toujours pas d'adresse. Voici ce que le tunnel raconte :"
      sudo journalctl -u tunnel -n 25 --no-pager 2>/dev/null | sed 's/^/      /' \
        || note "      (journal illisible — relance : sudo journalctl -u tunnel -n 25)"
      printf '\n'
      note "Les causes habituelles :"
      note "  · sortie réseau très filtrée — essaie l'option 2 (DuckDNS), qui n'a besoin que du 80 et du 443 ;"
      note "  · Cloudflare refuse les tunnels anonymes depuis cette IP — même remède ;"
      note "  · pas de résolution DNS sur le VPS — vérifie : getent hosts cloudflare.com"
      note "Le reste de l'installation, lui, est en place : la boutique tourne sur le port 3000."
    fi
        ;;
  2|3)
    if [ "$choix" = 2 ]; then
      printf '  Ton sous-domaine DuckDNS (ex. ma-boutique.duckdns.org) : '
    else
      printf '  Ton domaine (ex. boutique.mondomaine.fr) : '
    fi
    read -r domaine || domaine=''
    [ -n "$domaine" ] || stop "Pas de domaine saisi, rien installé. Relance quand tu l'auras."

    # `|| true` : sous `set -o pipefail`, un grep qui ne trouve rien fait
    # échouer le pipeline, donc avorter le script — alors qu'une clef absente
    # est le cas normal sur un .env neuf.
    actuel=$(grep -E '^WEBAPP_URL=' .env | head -1 | cut -d= -f2- || true)
    if [ -n "$actuel" ] && [ "$actuel" != "https://$domaine" ]; then
      note "La boutique annonce déjà $actuel."
      note "Reconfigurer le proxy pour $domaine sans changer cette adresse laisserait"
      note "les deux en désaccord, et plus rien ne s'ouvrirait. Donc on décide maintenant."
      printf '  Basculer la boutique sur https://%s ? [o/N] ' "$domaine"
      read -r bascule || bascule=''
      [ "${bascule:-}" = o ] || stop "Rien changé. L'adresse actuelle ($actuel) reste en place."
    fi

    # Un domaine qui ne pointe pas encore ici ferait échouer le certificat, et
    # Let's Encrypt compte les échecs : mieux vaut le dire avant.
    resolu=$(getent hosts "$domaine" | awk '{print $1}' | head -1 || true)
    moi=$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)
    if [ -n "$resolu" ] && [ -n "$moi" ] && [ "$resolu" != "$moi" ]; then
      note "$domaine pointe vers $resolu, or ce VPS est en $moi."
      note "Le certificat échouera tant que le DNS n'aura pas suivi. Continue seulement si tu viens de le changer."
      printf '  Continuer quand même ? [o/N] '
      read -r suite || suite=''
      [ "${suite:-}" = o ] || stop "Arrêt demandé. Corrige l'enregistrement A, attends la propagation, et relance."
    elif [ -z "$resolu" ]; then
      # L'apostrophe ne peut pas vivre dans un ${var:-défaut} : bash l'y lit
      # comme une vraie quote, même au milieu d'une chaîne entre guillemets.
      cible_a="${moi}"
      [ -n "$cible_a" ] || cible_a="l'IP de ce VPS"
      note "$domaine ne résout pas encore. Crée l'enregistrement A vers $cible_a avant d'aller plus loin."
      printf '  Continuer quand même ? [o/N] '
      read -r suite || suite=''
      [ "${suite:-}" = o ] || stop "Arrêt demandé."
    else
      fait "$domaine pointe bien ici"
    fi

    if ! command -v caddy >/dev/null; then
      note "Installation de Caddy…"
      sudo apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
      sudo apt-get update -qq
      sudo apt-get install -y -qq caddy >/dev/null
    fi

    [ -f /etc/caddy/Caddyfile ] && sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.avant-installeur
    sudo sed "s/boutique\.mondomaine\.fr/$domaine/" "$RACINE/deploy/Caddyfile" \
      | sudo tee /etc/caddy/Caddyfile >/dev/null
    sudo systemctl reload caddy || sudo systemctl restart caddy
    fait "Caddy servira https://$domaine"

    regler_clef WEBAPP_URL "https://$domaine"
    sudo systemctl restart "$SERVICE"
    fait "WEBAPP_URL=https://$domaine, boutique redémarrée"
    note "Le certificat prend une minute à la première requête. Ouvre https://$domaine pour le déclencher."
    ;;
  *)
    note "Rien installé de ce côté. L'étape 6 du guide docs/vps.md détaille les trois chemins."
    ;;
esac

# ── Ce qu'il reste à faire à la main ───────────────────────

etape "Il reste ceci, que personne ne peut faire pour toi"
cat <<TEXTE
  1. Remplir .env  (nano .env  puis  sudo systemctl restart $SERVICE)
       BOT_TOKEN        le token de BotFather
       WEBAPP_URL       l'adresse HTTPS obtenue plus haut
       SELLER_USERNAME  ton pseudo Telegram, sans @
       BOT_USERNAME     le pseudo du bot, sans @ (liens directs et QR codes)
       ADMIN_IDS        ton identifiant numérique — /start au bot te le donne

  2. Chez BotFather : /mybots → ton bot → Bot Settings → Menu Button,
     et y coller WEBAPP_URL.

  3. Vérifier l'ensemble :
       npm run doctor \$WEBAPP_URL
       bash deploy/diagnostic.sh     # l'état du VPS, à coller dans une conversation

  Les journaux, quand quelque chose cloche :
       sudo journalctl -u $SERVICE -f
TEXTE

printf '\n%s✓ Installation terminée.%s\n\n' "$VERT$GRAS" "$FIN"
