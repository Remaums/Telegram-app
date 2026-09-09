#!/usr/bin/env bash
#
# Desinstallation complete de Plesk sur un VPS.
# Compatible Debian / Ubuntu (apt) et RHEL / AlmaLinux / Rocky / CentOS (dnf-yum).
#
# A executer EN ROOT, DIRECTEMENT SUR LE VPS.
#
#   bash plesk-uninstall.sh inventory   # (defaut) lecture seule : montre ce qui sera supprime
#   bash plesk-uninstall.sh backup      # sauvegarde avant de toucher a quoi que ce soit
#   bash plesk-uninstall.sh purge       # suppression reelle (demande une confirmation tapee)
#   bash plesk-uninstall.sh verify      # controle final
#
# Options pour "purge" :
#   --yes            saute la confirmation interactive (usage non surveille)
#   --purge-vhosts   supprime AUSSI /var/www/vhosts (= les sites heberges). DESTRUCTIF.
#
# MySQL / MariaDB n'est jamais cible : Plesk s'appuie sur le paquet de la
# distribution, le supprimer casserait d'autres applications du serveur.
#
set -euo pipefail

BACKUP_DIR="/root/plesk-backup-$(date +%Y%m%d-%H%M%S)"
LOG_FILE="/var/log/plesk-uninstall-$(date +%Y%m%d-%H%M%S).log"

ASSUME_YES=0
PURGE_VHOSTS=0

# --- affichage -------------------------------------------------------------

if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'
  C_BLU=$'\033[34m'; C_BLD=$'\033[1m';  C_OFF=$'\033[0m'
else
  C_RED=''; C_GRN=''; C_YEL=''; C_BLU=''; C_BLD=''; C_OFF=''
fi

info() { printf '%s==>%s %s\n' "$C_BLU" "$C_OFF" "$*"; }
ok()   { printf '%s [ok]%s %s\n' "$C_GRN" "$C_OFF" "$*"; }
warn() { printf '%s [!!]%s %s\n' "$C_YEL" "$C_OFF" "$*" >&2; }
err()  { printf '%s [XX]%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; }
head1(){ printf '\n%s%s%s\n%s\n' "$C_BLD" "$*" "$C_OFF" "$(printf '%.0s-' {1..64})"; }

# --- cibles ----------------------------------------------------------------

# Paquets Plesk : motifs ancres, pour ne jamais attraper un paquet systeme
# qui contiendrait "psa" ou "sw-" au milieu de son nom.
PKG_PATTERNS='^(psa([-.]|$)|plesk|sw-cp-server|sw-engine|sw-libzip|sw-nginx|sw-collectd|pp[0-9]|parallels-|plesk-php|drweb|kav4|sitebuilder|pmm-|php[0-9]+-plesk)'

# Paquets qu'on ne supprime JAMAIS, meme s'ils matchent : perdre l'un d'eux
# coupe l'acces au serveur ou le rend non amorcable.
PKG_PROTECTED='^(openssh-server|openssh-client|openssh|ssh|sshd|systemd|systemd-sysv|init|linux-image|linux-firmware|kernel|grub|sudo|bash|dash|coreutils|util-linux|apt|dpkg|dnf|yum|rpm|glibc|libc6|ca-certificates|curl|wget|iproute2|netplan|network-manager|NetworkManager|firewalld|python3|perl)'

# Repertoires purement Plesk : suppression sans risque pour le systeme.
PLESK_PATHS=(
  /opt/psa /usr/local/psa /etc/psa /var/lib/psa /var/spool/psa
  /opt/plesk /usr/lib/plesk-9.0 /usr/share/plesk /var/spool/plesk
  /etc/sw-cp-server /etc/sw-engine /etc/sw /var/lib/sw-cp-server
  /var/cache/parallels_installer /var/cache/swcp /var/log/plesk
  /root/.autoinstaller /root/.plesk /etc/plesk /usr/local/plesk
  /var/log/sw-cp-server /var/log/sw-engine /usr/share/sw-engine
)

# Depots / cles APT-YUM ajoutes par Plesk.
REPO_GLOBS=(
  '/etc/apt/sources.list.d/plesk*'
  '/etc/apt/sources.list.d/*plesk*'
  '/etc/apt/trusted.gpg.d/plesk*'
  '/usr/share/keyrings/plesk*'
  '/etc/yum.repos.d/plesk*'
  '/etc/yum.repos.d/*plesk*'
  '/etc/pki/rpm-gpg/*PLESK*'
)

PLESK_SERVICES=(
  psa sw-cp-server sw-engine plesk-php-fpm plesk-task-manager
  plesk-web-socket plesk-ssh-terminal plesk-ext-monitoring
  plesk-mail-monitoring plesk-repaird drwebd
)

PLESK_USERS=(psaadm psaftp sw-cp-server popuser drweb plesk)
PLESK_GROUPS=(psaadm psacln psaserv sw-cp-server drweb swpsa)

# --- socle -----------------------------------------------------------------

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    err "Ce script doit tourner en root. Relance avec : sudo bash $0 $*"
    exit 1
  fi
}

detect_os() {
  OS_FAMILY=""
  if command -v apt-get >/dev/null 2>&1; then
    OS_FAMILY="deb"
  elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    OS_FAMILY="rpm"
  else
    err "Ni apt ni dnf/yum trouve : distribution non geree."
    exit 1
  fi
  OS_NAME="$( . /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-inconnu}" )"
  info "Systeme : $OS_NAME (famille $OS_FAMILY)"
}

plesk_installed() {
  command -v plesk >/dev/null 2>&1 || [ -d /opt/psa ] || [ -d /usr/local/psa ]
}

list_plesk_packages() {
  if [ "$OS_FAMILY" = "deb" ]; then
    dpkg-query -W -f='${Package}\n' 2>/dev/null || true
  else
    rpm -qa --qf '%{NAME}\n' 2>/dev/null || true
  fi | grep -E "$PKG_PATTERNS" 2>/dev/null | grep -Ev "$PKG_PROTECTED" 2>/dev/null | sort -u || true
}

confirm_or_die() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  printf '\n%sTape exactement  SUPPRIMER PLESK  pour continuer :%s ' "$C_BLD" "$C_OFF"
  local answer=""
  read -r answer || true
  if [ "$answer" != "SUPPRIMER PLESK" ]; then
    err "Confirmation absente. Rien n'a ete modifie."
    exit 1
  fi
}

# --- inventaire ------------------------------------------------------------

cmd_inventory() {
  head1 "1. Etat de Plesk"
  if plesk_installed; then
    ok "Plesk est present sur cette machine."
    plesk version 2>/dev/null | sed 's/^/     /' || true
  else
    warn "Aucune trace evidente de Plesk (ni binaire, ni /opt/psa)."
  fi

  head1 "2. Paquets qui seront supprimes"
  local pkgs
  pkgs="$(list_plesk_packages)"
  if [ -n "$pkgs" ]; then
    echo "$pkgs" | sed 's/^/     /'
    printf '     %s----%s %s paquet(s)\n' "$C_BLD" "$C_OFF" "$(echo "$pkgs" | wc -l)"
  else
    echo "     (aucun)"
  fi

  head1 "3. Repertoires qui seront supprimes"
  local p found=0
  for p in "${PLESK_PATHS[@]}"; do
    if [ -e "$p" ]; then
      printf '     %-32s %s\n' "$p" "$(du -sh "$p" 2>/dev/null | cut -f1)"
      found=1
    fi
  done
  [ "$found" -eq 0 ] && echo "     (aucun)"

  head1 "4. Sites heberges (/var/www/vhosts)"
  if [ -d /var/www/vhosts ]; then
    ls -1 /var/www/vhosts 2>/dev/null | grep -v '^chroot$' | sed 's/^/     /' || true
    printf '     Taille totale : %s\n' "$(du -sh /var/www/vhosts 2>/dev/null | cut -f1)"
    if [ "$PURGE_VHOSTS" -eq 1 ]; then
      err "  --purge-vhosts est actif : CES SITES SERONT DETRUITS."
    else
      ok "  Conserves (utilise --purge-vhosts pour les supprimer aussi)."
    fi
  else
    echo "     (repertoire absent)"
  fi

  head1 "5. Bases de donnees"
  if command -v mysql >/dev/null 2>&1 && [ -r /etc/psa/.psa.shadow ]; then
    MYSQL_PWD="$(cat /etc/psa/.psa.shadow)" mysql -uadmin -N -e 'SHOW DATABASES;' 2>/dev/null \
      | sed 's/^/     /' || warn "     Lecture des bases impossible."
  else
    echo "     (mot de passe admin Plesk illisible ou mysql absent)"
  fi

  head1 "6. Services Plesk actifs"
  local s
  for s in "${PLESK_SERVICES[@]}"; do
    if systemctl list-unit-files 2>/dev/null | grep -q "^${s}\.service"; then
      printf '     %-26s %s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null || echo inactive)"
    fi
  done

  head1 "7. Garde-fou acces SSH"
  if systemctl is-active ssh >/dev/null 2>&1 || systemctl is-active sshd >/dev/null 2>&1; then
    ok "sshd actif — ton acces au serveur ne depend pas de Plesk."
  else
    err "sshd ne semble PAS actif. Ne lance pas la purge : tu risques de perdre l'acces."
  fi

  printf '\n'
  warn "Rappel : desinstaller Plesk retire aussi le serveur web, le mail et le DNS"
  warn "qu'il gerait. Les sites ne repondront plus tant que tu n'auras pas"
  warn "reinstalle et reconfigure nginx/apache toi-meme."
}

# --- sauvegarde ------------------------------------------------------------

cmd_backup() {
  head1 "Sauvegarde vers $BACKUP_DIR"
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"

  if command -v plesk >/dev/null 2>&1; then
    info "Export natif Plesk (peut etre long)..."
    plesk bin pleskbackup --server -v --output-file="$BACKUP_DIR/plesk-full.tar" \
      >>"$LOG_FILE" 2>&1 && ok "plesk-full.tar" \
      || warn "pleskbackup a echoue — on continue avec les sauvegardes manuelles."
  fi

  if command -v mysqldump >/dev/null 2>&1 && [ -r /etc/psa/.psa.shadow ]; then
    info "Dump de toutes les bases MySQL..."
    MYSQL_PWD="$(cat /etc/psa/.psa.shadow)" mysqldump -uadmin \
      --all-databases --single-transaction --routines --events \
      > "$BACKUP_DIR/all-databases.sql" 2>>"$LOG_FILE" \
      && ok "all-databases.sql ($(du -sh "$BACKUP_DIR/all-databases.sql" | cut -f1))" \
      || warn "Dump MySQL echoue."
  fi

  if [ -d /var/www/vhosts ]; then
    info "Archive des sites /var/www/vhosts..."
    tar czf "$BACKUP_DIR/vhosts.tar.gz" -C /var/www vhosts 2>>"$LOG_FILE" \
      && ok "vhosts.tar.gz ($(du -sh "$BACKUP_DIR/vhosts.tar.gz" | cut -f1))" \
      || warn "Archive vhosts echouee."
  fi

  info "Archive des configurations..."
  tar czf "$BACKUP_DIR/configs.tar.gz" \
    --ignore-failed-read \
    /etc/psa /etc/nginx /etc/apache2 /etc/httpd /etc/php* /etc/named* /etc/bind \
    2>/dev/null || true
  ok "configs.tar.gz"

  crontab -l > "$BACKUP_DIR/root-crontab.txt" 2>/dev/null || true
  ip addr  > "$BACKUP_DIR/network.txt" 2>/dev/null || true
  list_plesk_packages > "$BACKUP_DIR/plesk-packages.txt" || true

  printf '\n'
  ok "Sauvegarde terminee : $BACKUP_DIR"
  err "RAPATRIE-LA HORS DU VPS avant la purge, par exemple depuis ta machine :"
  printf '     scp -r root@<ip-du-vps>:%s ./\n' "$BACKUP_DIR"
}

# --- purge -----------------------------------------------------------------

step_official_uninstaller() {
  head1 "Etape 1/7 — Desinstalleur officiel Plesk"
  if ! plesk_installed; then
    warn "Plesk absent, etape sautee."
    return 0
  fi

  info "Arret des services Plesk..."
  plesk stop >>"$LOG_FILE" 2>&1 || service psa stopall >>"$LOG_FILE" 2>&1 || true

  local ai=""
  for candidate in /usr/local/psa/admin/bin/autoinstaller /usr/local/psa/admin/sbin/autoinstaller /opt/psa/admin/bin/autoinstaller; do
    [ -x "$candidate" ] && ai="$candidate" && break
  done

  info "Lancement du desinstalleur (long, sortie dans $LOG_FILE)..."
  if command -v plesk >/dev/null 2>&1; then
    plesk installer --select-product-id plesk --select-release-current --uninstall-all \
      >>"$LOG_FILE" 2>&1 && ok "Desinstalleur officiel termine." && return 0
  fi
  if [ -n "$ai" ]; then
    "$ai" --select-product-id plesk --select-release-current --uninstall-all \
      >>"$LOG_FILE" 2>&1 && ok "Desinstalleur officiel termine (autoinstaller)." && return 0
  fi
  warn "Desinstalleur officiel indisponible ou en echec : on passe en purge manuelle."
}

step_purge_packages() {
  head1 "Etape 2/7 — Purge des paquets residuels"
  local pkgs
  pkgs="$(list_plesk_packages)"
  if [ -z "$pkgs" ]; then
    ok "Aucun paquet Plesk restant."
    return 0
  fi
  echo "$pkgs" | sed 's/^/     /'

  if [ "$OS_FAMILY" = "deb" ]; then
    # shellcheck disable=SC2086
    DEBIAN_FRONTEND=noninteractive apt-get remove --purge -y $(echo "$pkgs" | tr '\n' ' ') \
      >>"$LOG_FILE" 2>&1 || warn "Certains paquets ont resiste (voir le log)."
    dpkg --purge --force-all $(echo "$pkgs" | tr '\n' ' ') >>"$LOG_FILE" 2>&1 || true
    apt-get autoremove -y >>"$LOG_FILE" 2>&1 || true
    apt-get clean >>"$LOG_FILE" 2>&1 || true
  else
    local rm_cmd="yum"; command -v dnf >/dev/null 2>&1 && rm_cmd="dnf"
    # shellcheck disable=SC2086
    $rm_cmd remove -y $(echo "$pkgs" | tr '\n' ' ') >>"$LOG_FILE" 2>&1 \
      || warn "Certains paquets ont resiste (voir le log)."
    rpm -e --nodeps $(echo "$pkgs" | tr '\n' ' ') >>"$LOG_FILE" 2>&1 || true
    $rm_cmd clean all >>"$LOG_FILE" 2>&1 || true
  fi
  ok "Paquets traites."
}

step_purge_services() {
  head1 "Etape 3/7 — Unites systemd"
  local s unit
  for s in "${PLESK_SERVICES[@]}"; do
    systemctl stop "$s" >/dev/null 2>&1 || true
    systemctl disable "$s" >/dev/null 2>&1 || true
  done
  for unit in /etc/systemd/system/plesk* /etc/systemd/system/psa* /etc/systemd/system/sw-* \
              /lib/systemd/system/plesk* /lib/systemd/system/psa* /lib/systemd/system/sw-* \
              /usr/lib/systemd/system/plesk* /usr/lib/systemd/system/psa* /usr/lib/systemd/system/sw-*; do
    [ -e "$unit" ] && rm -f "$unit" && printf '     supprime %s\n' "$unit"
  done
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl reset-failed  >/dev/null 2>&1 || true
  ok "Unites nettoyees."
}

step_purge_paths() {
  head1 "Etape 4/7 — Repertoires"
  local p
  for p in "${PLESK_PATHS[@]}"; do
    if [ -e "$p" ]; then
      rm -rf --one-file-system "$p" && printf '     supprime %s\n' "$p"
    fi
  done
  rm -f /var/log/plesk*.log /var/log/sw-*.log 2>/dev/null || true
  rm -rf /var/log/plesk-* 2>/dev/null || true

  if [ "$PURGE_VHOSTS" -eq 1 ] && [ -d /var/www/vhosts ]; then
    err "Suppression de /var/www/vhosts (sites heberges)..."
    rm -rf --one-file-system /var/www/vhosts
    ok "/var/www/vhosts supprime."
  elif [ -d /var/www/vhosts ]; then
    ok "/var/www/vhosts CONSERVE (donnees des sites intactes)."
  fi
  ok "Repertoires nettoyes."
}

step_purge_repos() {
  head1 "Etape 5/7 — Depots et cles"
  local g f
  for g in "${REPO_GLOBS[@]}"; do
    for f in $g; do
      [ -e "$f" ] && rm -f "$f" && printf '     supprime %s\n' "$f"
    done
  done
  if [ -f /etc/apt/sources.list ]; then
    sed -i '/plesk/Id' /etc/apt/sources.list
  fi
  if [ "$OS_FAMILY" = "deb" ]; then
    apt-get update >>"$LOG_FILE" 2>&1 || warn "apt-get update en erreur (voir le log)."
  fi
  ok "Depots nettoyes."
}

step_purge_accounts() {
  head1 "Etape 6/7 — Comptes et taches"
  local u g
  for u in "${PLESK_USERS[@]}"; do
    if id "$u" >/dev/null 2>&1; then
      userdel -r "$u" >/dev/null 2>&1 || userdel "$u" >/dev/null 2>&1 || true
      printf '     utilisateur supprime : %s\n' "$u"
    fi
  done
  for g in "${PLESK_GROUPS[@]}"; do
    if getent group "$g" >/dev/null 2>&1; then
      groupdel "$g" >/dev/null 2>&1 || true
      printf '     groupe supprime : %s\n' "$g"
    fi
  done

  rm -f /etc/cron.d/plesk* /etc/cron.daily/plesk* /etc/cron.daily/50plesk* \
        /etc/logrotate.d/plesk* /etc/logrotate.d/psa* /etc/logrotate.d/sw-* 2>/dev/null || true
  if crontab -l 2>/dev/null | grep -qi plesk; then
    crontab -l 2>/dev/null | grep -vi plesk | crontab - || true
    printf '     crontab root nettoye\n'
  fi

  rm -f /etc/profile.d/plesk* /etc/profile.d/psa* 2>/dev/null || true
  ok "Comptes et taches nettoyes."
}

step_restore_baseline() {
  head1 "Etape 7/7 — Remise en etat minimale"
  if systemctl is-active ssh >/dev/null 2>&1 || systemctl is-active sshd >/dev/null 2>&1; then
    ok "sshd toujours actif — acces au serveur preserve."
  else
    warn "sshd inactif : tentative de redemarrage..."
    systemctl start ssh >/dev/null 2>&1 || systemctl start sshd >/dev/null 2>&1 || true
    systemctl is-active ssh >/dev/null 2>&1 || systemctl is-active sshd >/dev/null 2>&1 \
      && ok "sshd relance." || err "IMPOSSIBLE de relancer sshd — passe par la console KVM de ton hebergeur."
  fi

  if [ "$OS_FAMILY" = "deb" ]; then
    dpkg --configure -a >>"$LOG_FILE" 2>&1 || true
    apt-get -f install -y >>"$LOG_FILE" 2>&1 || true
  fi
  ok "Etat des paquets stabilise."
}

cmd_purge() {
  head1 "PURGE COMPLETE DE PLESK"
  err "Cette operation est IRREVERSIBLE."
  echo "     - tous les paquets Plesk seront supprimes"
  echo "     - le serveur web / mail / DNS geres par Plesk disparaissent avec"
  [ "$PURGE_VHOSTS" -eq 1 ] \
    && err "     - /var/www/vhosts SERA DETRUIT (tous les sites)" \
    || echo "     - /var/www/vhosts sera conserve"
  echo "     - journal detaille : $LOG_FILE"
  confirm_or_die

  step_official_uninstaller
  step_purge_packages
  step_purge_services
  step_purge_paths
  step_purge_repos
  step_purge_accounts
  step_restore_baseline

  printf '\n'
  ok "Purge terminee. Lance maintenant :  bash $0 verify"
  warn "Un redemarrage est recommande :  reboot"
}

# --- verification ----------------------------------------------------------

cmd_verify() {
  head1 "Verification post-suppression"
  local clean=1

  if command -v plesk >/dev/null 2>&1; then
    err "Le binaire 'plesk' existe encore."; clean=0
  else
    ok "Binaire 'plesk' absent."
  fi

  local leftover_pkgs leftover_paths p
  leftover_pkgs="$(list_plesk_packages)"
  if [ -n "$leftover_pkgs" ]; then
    err "Paquets restants :"; echo "$leftover_pkgs" | sed 's/^/       /'; clean=0
  else
    ok "Aucun paquet Plesk restant."
  fi

  leftover_paths=""
  for p in "${PLESK_PATHS[@]}"; do
    [ -e "$p" ] && leftover_paths="$leftover_paths     $p"$'\n'
  done
  if [ -n "$leftover_paths" ]; then
    err "Repertoires restants :"; printf '%s' "$leftover_paths"; clean=0
  else
    ok "Aucun repertoire Plesk restant."
  fi

  if ss -tlnp 2>/dev/null | grep -qE ':(8443|8880)\b'; then
    err "Les ports Plesk 8443/8880 ecoutent encore."; clean=0
  else
    ok "Ports 8443/8880 fermes."
  fi

  if systemctl is-active ssh >/dev/null 2>&1 || systemctl is-active sshd >/dev/null 2>&1; then
    ok "sshd actif."
  else
    err "sshd INACTIF."; clean=0
  fi

  printf '\n'
  if [ "$clean" -eq 1 ]; then
    ok "${C_BLD}Plesk est completement supprime de ce serveur.${C_OFF}"
  else
    warn "Des residus subsistent — voir ci-dessus. Relance 'purge' ou traite-les a la main."
    return 1
  fi
}

# --- entree ----------------------------------------------------------------

main() {
  local action="inventory"
  local args=()
  for a in "$@"; do
    case "$a" in
      inventory|backup|purge|verify) action="$a" ;;
      --yes)          ASSUME_YES=1 ;;
      --purge-vhosts) PURGE_VHOSTS=1 ;;
      -h|--help)
        awk 'NR>1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"
        exit 0 ;;
      *) err "Option inconnue : $a"; exit 1 ;;
    esac
    args+=("$a")
  done
  require_root "${args[@]:-}"
  detect_os
  touch "$LOG_FILE" 2>/dev/null || LOG_FILE="/tmp/plesk-uninstall.log"

  case "$action" in
    inventory) cmd_inventory ;;
    backup)    cmd_backup ;;
    purge)     cmd_purge ;;
    verify)    cmd_verify ;;
  esac
}

main "$@"
