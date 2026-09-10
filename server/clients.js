/**
 * Les clients, vus depuis leurs commandes.
 *
 * La boutique ne tient pas de fichier client : il n'y a rien à tenir. Un
 * client, c'est ce que ses commandes disent de lui — combien de fois, combien
 * il dépense, ce qu'il prend, où il se fait livrer — plus les trois états que
 * la boutique connaît déjà de lui : bloqué, vérifié, abonné aux annonces.
 *
 * Rien n'est collecté pour l'occasion. Cette page ne fait que regrouper ce qui
 * est déjà là, et c'est volontaire : ce qu'on ne garde pas ne peut ni fuir, ni
 * être saisi, ni servir contre quelqu'un.
 *
 * Fonction pure : on lui passe les commandes et les états, elle rend des
 * fiches. Elle se vérifie donc sans magasin, sans serveur et sans horloge.
 */

/** Une adresse en une ligne, pour comparer deux livraisons au même endroit. */
const clefAdresse = (a) =>
  [a?.street, a?.postalCode, a?.city].map((v) => String(v ?? '').toLowerCase().trim()).join('|');

/**
 * @param {object[]} orders  toutes les commandes
 * @param {{bloques?: string[], verifications?: object, desabonnes?: string[]}} etats
 */
export function ficheClients(orders, { bloques = [], verifications = {}, desabonnes = [] } = {}) {
  const bloquesSet = new Set(bloques.map(String));
  const desabonnesSet = new Set(desabonnes.map(String));
  const fiches = new Map();

  for (const o of Array.isArray(orders) ? orders : []) {
    const id = String(o?.user?.id ?? '');
    if (!id) continue;

    const fiche = fiches.get(id) ?? {
      id,
      nom: null,
      username: null,
      commandes: 0,
      annulees: 0,
      chiffre: 0,
      panierMoyen: 0,
      premiere: null,
      derniere: null,
      livraisons: 0,
      retraits: 0,
      produits: new Map(),
      adresses: new Map(),
      telephones: new Set(),
      dernieres: [],
    };

    // Le nom le plus récent l'emporte : un client qui change de pseudo doit
    // apparaître sous celui qu'il porte aujourd'hui.
    const quand = o.createdAt ?? '';
    if (!fiche.derniere || quand > fiche.derniere) {
      fiche.nom = o.user.firstName ?? fiche.nom;
      fiche.username = o.user.username ?? fiche.username;
      fiche.derniere = quand;
    }
    if (!fiche.premiere || quand < fiche.premiere) fiche.premiere = quand;

    if (o.status === 'annulee') {
      fiche.annulees++;
    } else {
      fiche.commandes++;
      fiche.chiffre += o.total ?? 0;
      if (o.mode === 'delivery') fiche.livraisons++;
      else fiche.retraits++;

      for (const item of o.items ?? []) {
        const nom = item.name ?? '?';
        fiche.produits.set(nom, (fiche.produits.get(nom) ?? 0) + (item.quantity ?? 0));
      }
    }

    // Les adresses servies, la plus récente en tête : c'est celle qu'on
    // resservira, et les précédentes disent si le client a déménagé.
    if (o.address?.street) {
      const clef = clefAdresse(o.address);
      const connue = fiches.get(id)?.adresses.get(clef);
      if (!connue || quand > connue.vue) {
        fiche.adresses.set(clef, { ...o.address, vue: quand, fois: (connue?.fois ?? 0) + 1 });
      }
    }
    if (o.phone) fiche.telephones.add(o.phone);

    fiche.dernieres.push({
      reference: o.reference,
      date: quand,
      total: o.total ?? 0,
      status: o.status,
      mode: o.mode,
    });

    fiches.set(id, fiche);
  }

  return [...fiches.values()]
    .map((f) => ({
      id: f.id,
      nom: f.nom,
      username: f.username,
      commandes: f.commandes,
      annulees: f.annulees,
      chiffre: f.chiffre,
      panierMoyen: f.commandes ? Math.round(f.chiffre / f.commandes) : 0,
      premiere: f.premiere,
      derniere: f.derniere,
      livraisons: f.livraisons,
      retraits: f.retraits,
      produits: [...f.produits.entries()]
        .map(([nom, quantite]) => ({ nom, quantite }))
        .sort((a, b) => b.quantite - a.quantite)
        .slice(0, 3),
      adresses: [...f.adresses.values()].sort((a, b) => String(b.vue).localeCompare(String(a.vue))),
      telephones: [...f.telephones],
      dernieres: f.dernieres.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 10),
      bloque: bloquesSet.has(f.id),
      verification: verifications[f.id]?.status ?? 'none',
      abonne: !desabonnesSet.has(f.id),
    }))
    .sort((a, b) => String(b.derniere).localeCompare(String(a.derniere)));
}

/**
 * Filtre les fiches sur un texte libre.
 *
 * On cherche dans ce qu'un vendeur a sous la main quand il cherche quelqu'un :
 * un prénom, un pseudo, un numéro, une rue, une ville, une référence de
 * commande. Sans accents ni casse — personne ne tape « Néon » avec l'accent
 * sur un clavier de téléphone.
 */
export function chercherClients(fiches, requete) {
  const propre = normaliser(requete);
  if (!propre) return fiches;

  return fiches.filter((f) => {
    const foin = normaliser(
      [
        f.id,
        f.nom,
        f.username,
        ...f.telephones,
        ...f.adresses.flatMap((a) => [a.street, a.postalCode, a.city]),
        ...f.dernieres.map((c) => c.reference),
      ].join(' ')
    );
    // Un vendeur tape un numéro de téléphone d'un bloc, jamais avec les
    // espaces d'origine : on compare aussi les deux textes resserrés.
    const serre = foin.replace(/ /g, '');
    return propre.split(/\s+/).every((mot) => foin.includes(mot) || serre.includes(mot));
  });
}

function normaliser(valeur) {
  return String(valeur ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
