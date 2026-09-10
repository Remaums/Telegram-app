#!/usr/bin/env bash
#
# L'état du VPS en un seul bloc, à coller dans une conversation.
#
#   bash deploy/diagnostic.sh
#
# Le but : remplacer dix allers-retours « essaie ça, et ça donne quoi ? » par
# un seul texte qui dit tout. Ce qu'on y lit est ce qu'on demande toujours en
# premier — version de Node, état du service, ce que le journal raconte, quelles
# clefs de configuration sont remplies, si la boutique répond.
#
# AUCUN SECRET N'EN SORT. Le fichier .env n'est jamais affiché : pour chaque
# clef on dit seulement « renseignée » ou « vide », et les tokens repérés dans
# les journaux sont masqués. Ce texte est fait pour être collé ailleurs, il ne
# doit rien contenir qui ouvre la boutique.

set -uo pipefail

# Les libellés de ce rapport sont accentués, et bash ne compte leurs caractères
# correctement que sous une locale UTF-8 : sans ça « Mémoire » est mesuré à huit
# caractères au lieu de sept, et toute la colonne se décale. C.UTF-8 est présent
# sur Debian 12 et Ubuntu 22.04+ ; à défaut, l'alignement souffre un peu, rien
# de plus.
if locale -a 2>/dev/null | grep -qiE '^C\.utf-?8$'; then
  export LC_ALL=C.UTF-8
fi

SERVICE=${SERVICE:-coffeeshop68}
RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RACINE"

titre() { printf '\n───── %s\n' "$1"; }

# `printf %-26s` compte les octets, pas les caractères : on complète à la main,
# sur une longueur mesurée sous la locale réglée plus haut.
ligne() {
  local etiquette=$1 valeur=${2-}
  local blancs=''
  local vu=${#etiquette}
  while [ "$vu" -lt 26 ]; do blancs+=' '; vu=$((vu + 1)); done
  printf '  %s%s %s\n' "$etiquette" "$blancs" "$valeur"
}

# Un token de bot est reconnaissable : des chiffres, deux points, une longue
# chaîne. On le masque partout où il pourrait traîner.
masquer() {
  sed -E \
    -e 's/[0-9]{8,12}:[A-Za-z0-9_-]{30,}/<TOKEN-MASQUÉ>/g' \
    -e 's#(postgres(ql)?://[^:]+:)[^@]+@#\1<MOT-DE-PASSE-MASQUÉ>@#g'
}

printf '══ Diagnostic de la boutique — %s ══\n' "$(date -u '+%F %T UTC')"

titre "Machine"
source /etc/os-release 2>/dev/null || true
ligne "Système" "${PRETTY_NAME:-inconnu}"
ligne "Noyau" "$(uname -r)"
ligne "Architecture" "$(uname -m)"
ligne "Mémoire" "$(free -h 2>/dev/null | awk '/^Mem:/{print $3" utilisés sur "$2}' || echo '?')"
ligne "Disque (/)" "$(df -h / 2>/dev/null | awk 'NR==2{print $4" libres sur "$2" ("$5" occupé)"}')"
ligne "Uptime" "$(uptime -p 2>/dev/null || echo '?')"

titre "Outils"
ligne "node" "$(node -v 2>/dev/null || echo 'ABSENT')"
ligne "npm" "$(npm -v 2>/dev/null || echo 'ABSENT')"
ligne "git" "$(git --version 2>/dev/null | awk '{print $3}' || echo 'ABSENT')"
for outil in caddy nginx cloudflared ufw; do
  ligne "$outil" "$(command -v $outil >/dev/null && echo présent || echo absent)"
done

titre "Dépôt"
ligne "Chemin" "$RACINE"
ligne "Propriétaire" "$(stat -c '%U:%G' . 2>/dev/null)"
ligne "Branche" "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
ligne "Commit" "$(git log -1 --format='%h %cs %s' 2>/dev/null | cut -c1-60 || echo '?')"
ligne "Modifications locales" "$(git status --porcelain 2>/dev/null | wc -l) fichier(s)"
ligne "node_modules" "$([ -d node_modules ] && echo "$(ls node_modules | wc -l) paquets" || echo 'ABSENT — lance npm install')"

titre "Configuration (valeurs jamais affichées)"
if [ -f .env ]; then
  ligne "Permissions .env" "$(stat -c '%a' .env) $([ "$(stat -c '%a' .env)" = 600 ] || echo '← devrait être 600 : chmod 600 .env')"
  for clef in BOT_TOKEN WEBAPP_URL SELLER_USERNAME BOT_USERNAME ADMIN_IDS ADMIN_CHAT_ID \
              SHOP_NAME CURRENCY PORT HOST DATABASE_URL TELEGRAM_WEBHOOK_SECRET; do
    valeur=$(grep -E "^${clef}=" .env 2>/dev/null | head -1 | cut -d= -f2-)
    case "$clef" in
      # Ces deux-là ne sont pas des secrets et leur valeur exacte est souvent
      # la cause du problème : on les montre.
      WEBAPP_URL|HOST|PORT|CURRENCY|BOT_USERNAME|SELLER_USERNAME)
        ligne "$clef" "${valeur:-(vide)}" ;;
      *)
        ligne "$clef" "$([ -n "$valeur" ] && echo renseignée || echo '(vide)')" ;;
    esac
  done
else
  ligne ".env" "ABSENT — cp .env.example .env && chmod 600 .env"
fi

titre "Service $SERVICE"
if systemctl list-unit-files "$SERVICE.service" >/dev/null 2>&1 \
   && [ -f "/etc/systemd/system/$SERVICE.service" ]; then
  ligne "Actif" "$(systemctl is-active $SERVICE 2>/dev/null)"
  ligne "Au démarrage" "$(systemctl is-enabled $SERVICE 2>/dev/null)"
  ligne "Depuis" "$(systemctl show -p ActiveEnterTimestamp --value $SERVICE 2>/dev/null || echo '?')"
  ligne "Redémarrages" "$(systemctl show -p NRestarts --value $SERVICE 2>/dev/null || echo '?')"
  ligne "Utilisateur" "$(systemctl show -p User --value $SERVICE 2>/dev/null || echo '?')"
  ligne "Dossier" "$(systemctl show -p WorkingDirectory --value $SERVICE 2>/dev/null || echo '?')"
else
  ligne "Service" "NON INSTALLÉ — voir deploy/installer.sh ou l'étape 5 du guide"
fi

for autre in tunnel caddy nginx; do
  [ -f "/etc/systemd/system/$autre.service" ] || [ -f "/lib/systemd/system/$autre.service" ] || continue
  ligne "$autre" "$(systemctl is-active $autre 2>/dev/null)"
done

titre "La boutique répond-elle ?"
PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d ' ')
PORT=${PORT:-3000}
# La sortie d'erreur reste à part : mêlée à la réponse, un « connection
# refused » se lirait comme si la boutique avait répondu quelque chose.
if sante=$(curl -fsS --max-time 8 "http://127.0.0.1:$PORT/api/health" 2>/dev/null); then
  printf '  %s\n' "$(printf '%s' "$sante" | masquer | cut -c1-300)"
else
  ligne "http://127.0.0.1:$PORT" "AUCUNE RÉPONSE — la boutique ne tourne pas"
  occupant=$( (ss -ltnp 2>/dev/null || true) | grep ":$PORT " | head -1 | sed 's/^ *//')
  ligne "Port $PORT occupé par" "${occupant:-personne}"
fi

URL=$(grep -E '^WEBAPP_URL=' .env 2>/dev/null | cut -d= -f2- | tr -d ' ')
if [ -n "$URL" ]; then
  code=$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 12 "$URL/api/health" 2>/dev/null || echo 'injoignable')
  ligne "Depuis l'extérieur" "$URL → $code"
  cert=$(echo | timeout 10 openssl s_client -connect "${URL#https://}:443" -servername "${URL#https://}" 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || true)
  [ -n "$cert" ] && ligne "Certificat jusqu'au" "$cert"
fi

titre "Données"
for f in catalog.json orders.json settings.json; do
  chemin="server/data/$f"
  if [ -f "$chemin" ]; then
    valide=$(node -e "JSON.parse(require('fs').readFileSync('$chemin','utf8')); console.log('lisible')" 2>&1 | tail -1)
    ligne "$f" "$(du -h "$chemin" | cut -f1), $valide"
  else
    ligne "$f" "absent (normal avant le premier démarrage)"
  fi
done
[ -f server/data/.lock ] && ligne ".lock" "présent (PID $(cat server/data/.lock 2>/dev/null | head -c 20)) — deux instances ?"

titre "Journal, 30 dernières lignes"
if command -v journalctl >/dev/null; then
  journalctl -u "$SERVICE" -n 30 --no-pager 2>/dev/null | masquer | sed 's/^/  /' \
    || printf '  (journal illisible sans sudo : relance avec sudo)\n'
else
  printf '  (journalctl absent)\n'
fi

titre "Erreurs repérées dans les dernières 24 h"
if command -v journalctl >/dev/null; then
  resume=$(journalctl -u "$SERVICE" --since '24 hours ago' --no-pager 2>/dev/null \
    | grep -iE 'error|erreur|ECONN|EACCES|EADDRINUSE|409|Conflict|Unauthorized|SyntaxError' \
    | masquer | sort | uniq -c | sort -rn | head -8)
  [ -n "$resume" ] && printf '%s\n' "$resume" | sed 's/^/  /' || printf '  aucune\n'
fi

printf '\n══ Fin du diagnostic — aucun token ni mot de passe ci-dessus ══\n\n'
