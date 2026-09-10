/**
 * Le bilan de la boutique : ce que les commandes disent quand on les regroupe.
 *
 * Fonction pure, sans accès au magasin : on lui passe les commandes, la date
 * du jour et le fuseau, elle rend des nombres. On peut donc vérifier ce que
 * dira le tableau de bord un dimanche de novembre sans attendre novembre.
 *
 * Deux partis pris qui décident de tout le reste :
 *
 * - **le fuseau de la boutique fait foi**, pas celui du serveur. Un VPS réglé
 *   sur UTC couperait ses journées à deux heures du matin — c'est-à-dire en
 *   plein milieu du coup de feu du samedi soir, et le vendeur verrait ses
 *   meilleures ventes réparties sur deux jours ;
 * - **une commande annulée ne compte pas dans le chiffre**, mais elle compte
 *   dans les annulations. Sinon un taux d'annulation se lit nulle part, et un
 *   chiffre d'affaires gonflé par des commandes annulées ne veut rien dire.
 */

const JOUR = 24 * 60 * 60 * 1000;
const SEMAINE = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

/** Un formateur par fuseau : en fabriquer un par commande coûte cher. */
const formateurs = new Map();
function formateur(timezone) {
  const cle = timezone || 'Europe/Paris';
  if (!formateurs.has(cle)) {
    formateurs.set(
      cle,
      new Intl.DateTimeFormat('en-CA', {
        timeZone: cle,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
        weekday: 'short',
      })
    );
  }
  return formateurs.get(cle);
}

/** La date civile, l'heure et le jour de semaine tels que la boutique les vit. */
function moment(date, timezone) {
  const parts = formateur(timezone).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  const heure = Number(get('hour')) % 24; // « 24 » à minuit sur certains moteurs
  return {
    jour: `${get('year')}-${get('month')}-${get('day')}`,
    heure,
    semaine: { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 }[
      get('weekday').slice(0, 3).toLowerCase()
    ] ?? 0,
  };
}

/** Recule de n jours en date civile, par midi UTC pour ignorer l'heure d'été. */
function reculer(jourISO, n) {
  const [a, m, j] = jourISO.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, j, 12) - n * JOUR).toISOString().slice(0, 10);
}

/** Étiquette courte d'un jour : « sam. 13 » se lit dans une colonne étroite. */
function etiquette(jourISO) {
  const [a, m, j] = jourISO.split('-').map(Number);
  const date = new Date(Date.UTC(a, m - 1, j, 12));
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', weekday: 'short', day: 'numeric' })
    .format(date)
    .replace('.', '');
}

/**
 * D'où vient une commande, en une ligne.
 *
 * La ville que le client a écrite passe avant tout : c'est la seule exacte. Le
 * secteur de livraison prend le relais pour les commandes d'avant l'adresse
 * découpée, et pour celles qu'on a anonymisées — elles gardent leur commune,
 * pas leur porte.
 */
function nomDuLieu(order) {
  if (order.mode !== 'delivery') return 'Retrait sur place';

  const ville = order.address?.city?.trim();
  const code = order.address?.postalCode?.trim() || order.zone?.postalCode?.trim();
  if (ville) return code ? `${ville} (${code})` : ville;
  if (order.zone?.name) return code ? `${order.zone.name} (${code})` : order.zone.name;
  if (code) return code;
  return 'Livraison, lieu inconnu';
}

/**
 * @param {object[]} orders  toutes les commandes, dans n'importe quel ordre
 * @param {{jours?: number, maintenant?: Date, timezone?: string}} options
 */
export function bilan(orders, { jours = 30, maintenant = new Date(), timezone = 'Europe/Paris' } = {}) {
  const fenetre = Math.min(365, Math.max(1, Math.round(Number(jours) || 30)));
  const liste = Array.isArray(orders) ? orders : [];

  const aujourdhui = moment(maintenant, timezone).jour;
  const debut = reculer(aujourdhui, fenetre - 1);
  const debutAvant = reculer(aujourdhui, fenetre * 2 - 1);

  // Chaque commande n'est datée qu'une fois : le reste n'est que du comptage.
  const datees = liste
    .map((o) => {
      const quand = new Date(o.createdAt);
      if (Number.isNaN(quand.getTime())) return null;
      return { ...moment(quand, timezone), commande: o, horodatage: quand.getTime() };
    })
    .filter(Boolean);

  // Première commande de chaque client, toutes périodes confondues : c'est ce
  // qui distingue un nouveau client d'un habitué.
  const premiere = new Map();
  for (const d of datees) {
    const id = String(d.commande.user?.id ?? '');
    if (!id) continue;
    const connue = premiere.get(id);
    if (!connue || d.horodatage < connue) premiere.set(id, d.horodatage);
  }

  const dedans = datees.filter((d) => d.jour >= debut && d.jour <= aujourdhui);
  const avant = datees.filter((d) => d.jour >= debutAvant && d.jour < debut);

  const parJour = new Map();
  for (let i = 0; i < fenetre; i++) {
    const jourISO = reculer(aujourdhui, fenetre - 1 - i);
    parJour.set(jourISO, { jour: jourISO, etiquette: etiquette(jourISO), chiffre: 0, commandes: 0 });
  }

  const produits = new Map();
  const heures = Array.from({ length: 12 }, (_, i) => ({
    tranche: `${String(i * 2).padStart(2, '0')} h`,
    debut: i * 2,
    commandes: 0,
  }));
  const semaine = SEMAINE.map((nom) => ({ jour: nom, commandes: 0, chiffre: 0 }));
  const lieux = new Map();

  let chiffre = 0;
  let annulees = 0;
  let livraisons = 0;
  const clients = new Set();

  for (const d of dedans) {
    const o = d.commande;
    const id = String(o.user?.id ?? '');
    if (id) clients.add(id);

    if (o.status === 'annulee') {
      annulees++;
      continue; // une commande annulée n'a rapporté rien, et n'a rien vendu
    }

    chiffre += o.total ?? 0;
    if (o.mode === 'delivery') livraisons++;

    const jour = parJour.get(d.jour);
    if (jour) {
      jour.chiffre += o.total ?? 0;
      jour.commandes++;
    }
    heures[Math.floor(d.heure / 2)].commandes++;
    semaine[d.semaine].commandes++;
    semaine[d.semaine].chiffre += o.total ?? 0;

    // D'où viennent les commandes : la ville écrite par le client fait foi, le
    // secteur de livraison la remplace pour les commandes d'avant l'adresse
    // découpée, et le retrait a sa propre ligne — sinon les totaux ne
    // s'additionnent plus.
    const lieu = nomDuLieu(o);
    const compte = lieux.get(lieu) ?? { lieu, commandes: 0, chiffre: 0 };
    compte.commandes++;
    compte.chiffre += o.total ?? 0;
    lieux.set(lieu, compte);

    for (const item of o.items ?? []) {
      const nom = item.name ?? '?';
      const courant = produits.get(nom) ?? { nom, quantite: 0, chiffre: 0 };
      courant.quantite += item.quantity ?? 0;
      courant.chiffre += item.lineTotal ?? 0;
      produits.set(nom, courant);
    }
  }

  const retenues = dedans.filter((d) => d.commande.status !== 'annulee');
  const chiffreAvant = avant
    .filter((d) => d.commande.status !== 'annulee')
    .reduce((somme, d) => somme + (d.commande.total ?? 0), 0);

  const nouveaux = [...clients].filter((id) => {
    const debutClient = premiere.get(id);
    return debutClient !== undefined && moment(new Date(debutClient), timezone).jour >= debut;
  }).length;

  return {
    periode: { jours: fenetre, debut, fin: aujourdhui },
    resume: {
      chiffre,
      commandes: retenues.length,
      panierMoyen: retenues.length ? Math.round(chiffre / retenues.length) : 0,
      annulees,
      // En points de pourcentage sur le total présenté, annulations comprises :
      // un taux calculé sur les seules commandes retenues serait toujours nul.
      tauxAnnulation: dedans.length ? Math.round((annulees / dedans.length) * 100) : 0,
      partLivraison: retenues.length ? Math.round((livraisons / retenues.length) * 100) : 0,
      clients: clients.size,
      nouveaux,
      // Comparaison à la période précédente de même longueur : un chiffre seul
      // ne dit pas si la boutique monte ou descend.
      evolution: chiffreAvant ? Math.round(((chiffre - chiffreAvant) / chiffreAvant) * 100) : null,
      chiffreAvant,
    },
    parJour: [...parJour.values()],
    lieux: [...lieux.values()].sort((a, b) => b.chiffre - a.chiffre),
    produits: [...produits.values()].sort((a, b) => b.chiffre - a.chiffre),
    heures,
    semaine,
  };
}
