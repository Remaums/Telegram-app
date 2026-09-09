# Supprimer complètement Plesk d'un VPS

Deux méthodes. Choisis en fonction de ce que contient le serveur.

---

## Méthode A — Réinstallation de l'OS (la plus propre)

Si le VPS ne contient **rien que tu veuilles garder**, c'est la seule méthode
qui garantit une suppression réellement totale : Plesk touche à des centaines
de fichiers système (serveur web, mail, DNS, firewall, PAM, cron), et même une
désinstallation soignée laisse des traces.

1. Sauvegarde ce que tu veux conserver (voir l'étape *backup* ci-dessous).
2. Dans le panneau de ton hébergeur (OVH, Hetzner, Contabo, Ionos…) :
   **Réinstaller / Reinstall OS** → Debian 12 ou Ubuntu 24.04 propre.
3. Recharge ta clé SSH, et tu repars d'un serveur vierge.

Durée : 5 à 10 minutes. Aucun résidu possible.

---

## Méthode B — Désinstallation en place (script fourni)

À utiliser si le serveur héberge autre chose que Plesk et que tu ne peux pas
tout réinstaller.

Le script `tools/plesk-uninstall.sh` fait le travail en quatre temps.

### 1. Envoyer le script sur le VPS

Depuis ta machine :

```bash
scp tools/plesk-uninstall.sh root@<ip-du-vps>:/root/
ssh root@<ip-du-vps>
```

### 2. Inventaire (lecture seule, ne modifie rien)

```bash
bash /root/plesk-uninstall.sh inventory
```

Affiche la version de Plesk, les paquets qui seront supprimés, les répertoires,
les sites hébergés, les bases de données, les services actifs, et vérifie que
ton accès SSH ne dépend pas de Plesk. **Lis cette sortie avant d'aller plus loin.**

### 3. Sauvegarde

```bash
bash /root/plesk-uninstall.sh backup
```

Produit dans `/root/plesk-backup-<date>/` :

| Fichier | Contenu |
|---|---|
| `plesk-full.tar` | export natif `pleskbackup` |
| `all-databases.sql` | dump de toutes les bases MySQL |
| `vhosts.tar.gz` | contenu des sites (`/var/www/vhosts`) |
| `configs.tar.gz` | configs nginx / apache / php / DNS |
| `plesk-packages.txt` | liste des paquets, pour référence |

**Rapatrie l'archive hors du VPS avant la purge :**

```bash
scp -r root@<ip-du-vps>:/root/plesk-backup-<date> ./
```

### 4. Purge

```bash
bash /root/plesk-uninstall.sh purge
```

Le script demande de taper `SUPPRIMER PLESK` en toutes lettres pour confirmer,
puis enchaîne sept étapes :

1. **Désinstalleur officiel** — `plesk installer --uninstall-all`, la voie
   supportée par Plesk.
2. **Purge des paquets résiduels** — tout ce que l'autoinstalleur laisse
   derrière lui (`psa*`, `plesk*`, `sw-cp-server`, `sw-engine`, `drweb*`…).
3. **Unités systemd** — arrêt, désactivation, suppression des `.service`.
4. **Répertoires** — `/opt/psa`, `/usr/local/psa`, `/etc/psa`, `/var/lib/psa`,
   `/etc/sw-cp-server`, caches et journaux.
5. **Dépôts et clés APT/YUM** — pour que Plesk ne revienne pas par une mise à jour.
6. **Comptes, crons, logrotate** — `psaadm`, `psaftp`, `sw-cp-server`, tâches planifiées.
7. **Remise en état** — vérifie que `sshd` tourne toujours, stabilise dpkg/rpm.

Journal complet dans `/var/log/plesk-uninstall-<date>.log`.

### 5. Vérification

```bash
bash /root/plesk-uninstall.sh verify
reboot
```

`verify` contrôle : binaire `plesk` absent, aucun paquet restant, aucun
répertoire restant, ports **8443/8880** fermés, `sshd` actif. Il sort en
erreur s'il subsiste quoi que ce soit.

---

## Options

| Option | Effet |
|---|---|
| `--purge-vhosts` | supprime aussi `/var/www/vhosts`, donc **tous les sites hébergés**. Non activé par défaut. |
| `--yes` | saute la confirmation interactive. À réserver à un usage non surveillé. |

---

## Ce que tu perds en désinstallant Plesk

À lire avant de lancer la purge :

- **Serveur web** — nginx/apache étaient installés et pilotés par Plesk. Après
  la purge, plus rien n'écoute sur les ports 80/443. Les sites seront hors
  ligne tant que tu n'auras pas réinstallé et reconfiguré un serveur web.
- **Mail** — Postfix/Dovecot, boîtes et alias gérés par Plesk disparaissent.
- **DNS** — les zones servies par le BIND de Plesk ne sont plus résolues.
- **Certificats SSL** — les certificats Let's Encrypt émis via Plesk ne seront
  plus renouvelés. À réémettre avec `certbot`.
- **Firewall** — le module firewall de Plesk part avec ; vérifie tes règles
  `iptables`/`nftables` après le reboot.

Ce que tu **ne** perds pas : `sshd` (le script le protège explicitement et
vérifie qu'il tourne à la fin), le noyau, et les données de `/var/www/vhosts`
sauf si tu passes `--purge-vhosts`.

---

## Filet de sécurité

Avant de lancer `purge`, assure-toi d'avoir **un accès console KVM/VNC** chez
ton hébergeur. C'est la porte de secours si l'accès SSH devait sauter — tous
les hébergeurs VPS en proposent une depuis leur panneau.
