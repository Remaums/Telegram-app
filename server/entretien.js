/**
 * L'entretien de la boutique : ce qui doit se faire tout seul, tous les jours.
 *
 * Deux besognes, et le même défaut les réunissait : elles existaient déjà,
 * mais il fallait y penser. L'anonymisation des vieilles commandes était un
 * bouton du panel, la sauvegarde un autre. Un vendeur qui tient une boutique
 * ne clique pas sur un bouton « oublier les adresses » tous les trente jours —
 * et c'est précisément pour ça qu'un an plus tard son fichier contient le
 * domicile de quatre cents personnes.
 *
 * Trois principes tiennent ce module :
 *
 * - on ne réécrit pas ce qui existe. `trierPourPurge` sait déjà anonymiser,
 *   `buildBackup` sait déjà fabriquer une sauvegarde. Ici on décide *quand*,
 *   pas *comment* ;
 * - une besogne faite est notée. Sans cette trace, redémarrer le serveur
 *   quatre fois dans la journée enverrait quatre sauvegardes ;
 * - l'oubli est irréversible, donc il se fait après la sauvegarde du jour,
 *   jamais avant. Si la sauvegarde échoue, on ne détruit rien.
 */

import { createStore } from './store.js';
import { purgerCommandes } from './orders.js';
import { buildBackup } from './backup.js';
import { getSettings } from './settings.js';
import { config } from './config.js';

/** Ce qu'on retient d'une besogne : la date du jour où elle a été faite. */
const store = createStore('entretien.json', {});

/** Le rythme : on regarde toutes les heures, on agit une fois par jour. */
export const BATTEMENT_MS = 60 * 60 * 1000;

/**
 * Le plancher du délai d'oubli, en jours.
 *
 * Il ne protège pas d'une faute de frappe — le panel borne déjà la saisie —
 * mais d'un réglage restauré depuis une vieille sauvegarde, ou écrit à la main
 * dans le fichier. Sept jours laissent le temps qu'une commande soit livrée,
 * contestée et réglée avant que son adresse ne s'efface.
 */
export const JOURS_MIN = 7;

/** La date civile d'il y a `jours` jours, au format que `trierPourPurge` attend. */
export function dateLimite(jours, maintenant = Date.now()) {
  const bornes = Math.max(JOURS_MIN, Math.floor(Number(jours) || 0));
  return new Date(maintenant - bornes * 86400000).toISOString().slice(0, 10);
}

/** Le jour civil d'un instant — c'est l'unité à laquelle on compte ici. */
export const jourDe = (maintenant = Date.now()) =>
  new Date(maintenant).toISOString().slice(0, 10);

/**
 * Cette besogne est-elle encore à faire aujourd'hui ?
 *
 * On compare des jours et non des durées : « toutes les vingt-quatre heures »
 * ferait glisser l'heure de la sauvegarde un peu plus tard chaque jour, et au
 * bout d'un mois elle tomberait en pleine soirée de commandes.
 */
export function aFaire(dernier, maintenant = Date.now()) {
  return String(dernier ?? '') !== jourDe(maintenant);
}

/** Lit la trace sans l'écrire — pour le panel, qui ne fait que regarder. */
export async function journal() {
  const data = await store.read();
  return {
    sauvegarde: data.sauvegarde ?? null,
    oubli: data.oubli ?? null,
    derniereErreur: data.derniereErreur ?? null,
  };
}

async function noter(clef, valeur) {
  return store.update((data) => {
    data[clef] = valeur;
    return true;
  });
}

/**
 * La sauvegarde du jour, déposée dans la conversation du vendeur.
 *
 * Elle part par le bot et non par un lien : un fichier dans une conversation
 * Telegram se retrouve des mois plus tard, se transfère, et survit au
 * téléphone qu'on change. Un lien de téléchargement, lui, meurt avec le
 * serveur qu'on voulait justement pouvoir perdre.
 *
 * @param {(chatId, nom, contenu, legende) => Promise} envoyer  l'envoi, injecté
 *   pour que les tests n'aient pas besoin de Telegram.
 */
export async function sauvegarder({ envoyer, maintenant = Date.now() } = {}) {
  const chatId = config.adminChatId;
  if (!chatId) return { fait: false, raison: 'aucun destinataire' };

  const sauvegarde = await buildBackup();
  const jour = jourDe(maintenant);
  const nom = `napoli-${jour}.json`;
  const octets = Buffer.byteLength(JSON.stringify(sauvegarde));

  await envoyer(
    chatId,
    nom,
    JSON.stringify(sauvegarde, null, 2),
    `💾 Sauvegarde du ${jour}\n\n` +
      `${sauvegarde.products?.length ?? 0} produits · ` +
      `${sauvegarde.orders?.length ?? 0} commandes · ` +
      `${Math.max(1, Math.round(octets / 1024))} Ko\n\n` +
      'Garde-la : elle contient tout ce qu\'il faut pour remonter la boutique.'
  );

  await noter('sauvegarde', jour);
  return { fait: true, nom, octets };
}

/**
 * L'oubli : les vieilles commandes perdent ce qui désigne quelqu'un.
 *
 * Elles ne disparaissent pas — les montants restent, le bilan ne bouge pas.
 * Ce qui s'en va, c'est le nom, l'identifiant, l'adresse, le téléphone et la
 * note. On garde sa comptabilité sans garder le domicile de ses clients de
 * l'an dernier.
 */
export async function oublier({ jours, maintenant = Date.now() } = {}) {
  const avant = dateLimite(jours, maintenant);
  const bilan = await purgerCommandes({ mode: 'anonymiser', avant, seulementFinies: true });
  await noter('oubli', jourDe(maintenant));
  return { fait: true, avant, ...bilan };
}

/**
 * Le passage d'entretien : ce qui est dû aujourd'hui, et rien de plus.
 *
 * L'ordre n'est pas négociable. La sauvegarde d'abord, l'oubli ensuite : si
 * la sauvegarde échoue — Telegram injoignable, quota plein — on s'arrête là
 * et on ne détruit rien. Détruire sans filet est la seule faute qu'on ne
 * rattrape pas.
 */
export async function passage({ envoyer, maintenant = Date.now() } = {}) {
  const settings = await getSettings();
  const reglages = settings.entretien ?? {};
  const fait = { sauvegarde: null, oubli: null };
  const trace = await journal();

  if (reglages.sauvegardeAuto !== false && aFaire(trace.sauvegarde, maintenant)) {
    fait.sauvegarde = await sauvegarder({ envoyer, maintenant });
  }

  if (reglages.oubliAuto === true && aFaire(trace.oubli, maintenant)) {
    fait.oubli = await oublier({ jours: reglages.oubliJours, maintenant });
  }

  return fait;
}

/**
 * Lance le battement. Rendu arrêtable, pour les tests et pour un arrêt propre.
 *
 * `unref` est ce qui permet au processus de se terminer quand on le lui
 * demande : sans lui, une minuterie d'une heure garderait Node en vie une
 * heure de plus après un Ctrl+C.
 */
export function demarrerLEntretien({ envoyer, intervalle = BATTEMENT_MS } = {}) {
  const battre = () => {
    passage({ envoyer }).catch(async (err) => {
      console.error("Entretien : passage manqué —", err.message);
      await noter('derniereErreur', `${jourDe()} — ${err.message}`.slice(0, 200)).catch(() => {});
    });
  };
  // Un premier passage peu après le démarrage, pas à la seconde même : au
  // lancement le serveur a mieux à faire que de fabriquer une sauvegarde.
  const amorce = setTimeout(battre, 60_000);
  const minuterie = setInterval(battre, intervalle);
  amorce.unref?.();
  minuterie.unref?.();
  return () => {
    clearTimeout(amorce);
    clearInterval(minuterie);
  };
}
