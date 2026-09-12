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
 * @param {{bloques?: string[], verifications?: object, desabonnes?: string[],
 *          vus?: object[], timezone?: string, maintenant?: Date}} etats
 */
export function ficheClients(
  orders,
  {
    bloques = [],
    verifications = {},
    desabonnes = [],
    vus = [],
    timezone = 'Europe/Paris',
    maintenant = new Date(),
  } = {}
) {
  // « Il y a trois jours » se compte depuis un instant donné, pas depuis
  // l'horloge : c'est ce qui rend « depuis la dernière commande » vérifiable.
  const reference = new Date(maintenant).getTime();
  const bloquesSet = new Set(bloques.map(String));
  const desabonnesSet = new Set(desabonnes.map(String));
  // Le registre du bot sait des choses qu'aucune commande ne dit : quand
  // quelqu'un a poussé la porte pour la première fois, et combien de fois il est
  // revenu sans rien prendre.
  const vusParId = new Map((Array.isArray(vus) ? vus : []).map((v) => [String(v.id), v]));
  const calendrier = dateurs(timezone);
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
      // Ce qui se déduit, et qu'un vendeur lit d'un coup d'œil : combien
      // d'articles en tout, quels codes promo, quand il commande d'habitude.
      articles: 0,
      statuts: new Map(),
      promos: new Map(),
      jours: new Map(),
      heures: new Map(),
      dates: [],
      notes: [],
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

    // Les états se comptent sur toutes les commandes, annulées comprises : un
    // client avec trois commandes « prête » qui dorment n'est pas un client
    // satisfait, et c'est justement ce qu'on veut voir.
    const etat = o.status ?? 'nouvelle';
    fiche.statuts.set(etat, (fiche.statuts.get(etat) ?? 0) + 1);

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
        fiche.articles += item.quantity ?? 0;
      }

      // Le code promo, pas le libellé du palier : un palier automatique n'est
      // pas un code, et les mélanger ferait croire à une remise réclamée.
      if (o.promoCode) fiche.promos.set(o.promoCode, (fiche.promos.get(o.promoCode) ?? 0) + 1);

      if (quand) {
        fiche.dates.push(quand);
        const { jour, heure } = calendrier(quand);
        if (jour) fiche.jours.set(jour, (fiche.jours.get(jour) ?? 0) + 1);
        if (heure !== null) fiche.heures.set(heure, (fiche.heures.get(heure) ?? 0) + 1);
      }
    }

    // Les notes laissées à la commande : « sonnez deux fois », « pas de sachet ».
    // C'est du texte que le client a écrit pour être lu, et qui se perd sinon
    // dans une commande d'il y a trois semaines.
    if (o.note) fiche.notes.push({ reference: o.reference, date: quand, texte: o.note });

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

  const completes = [...fiches.values()].map((f) => {
    const vu = vusParId.get(f.id) ?? null;
    const total = f.commandes + f.annulees;

    return {
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
      // Tous les produits, pas les trois premiers : l'écran en montre trois
      // replié et la liste entière déplié, et c'est elle qui dit ce qu'on doit
      // garder en stock pour ce client-là.
      produits: [...f.produits.entries()]
        .map(([nom, quantite]) => ({ nom, quantite }))
        .sort((a, b) => b.quantite - a.quantite),
      adresses: [...f.adresses.values()].sort((a, b) => String(b.vue).localeCompare(String(a.vue))),
      telephones: [...f.telephones],
      dernieres: f.dernieres.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 10),
      bloque: bloquesSet.has(f.id),
      verification: verifications[f.id]?.status ?? 'none',
      abonne: !desabonnesSet.has(f.id),

      /* Ce qui se déduit de tout ça. */
      articles: f.articles,
      // Le taux d'annulation se lit sur le total, pas sur les commandes
      // honorées : trois annulées sur quatre, c'est 75 %, pas 300 %.
      tauxAnnulation: total ? Math.round((f.annulees / total) * 100) : 0,
      joursDepuis: f.derniere ? joursEntre(f.derniere, reference) : null,
      // Le rythme : combien de jours entre deux commandes, en moyenne. Avec une
      // seule commande il n'y a pas d'intervalle, et dire « 0 » serait faux.
      frequence: rythme(f.dates),
      statuts: [...f.statuts.entries()].map(([status, nombre]) => ({ status, nombre })),
      promos: [...f.promos.entries()]
        .map(([code, fois]) => ({ code, fois }))
        .sort((a, b) => b.fois - a.fois),
      habitudes: {
        jour: sommet(f.jours),
        heure: sommet(f.heures),
      },
      notes: f.notes.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 5),
      // Le registre du bot : depuis quand il connaît la boutique, et combien de
      // fois il l'a ouverte. L'écart avec le nombre de commandes dit s'il
      // regarde beaucoup et prend peu.
      vu: vu
        ? { premiere: vu.premier ?? null, derniere: vu.dernier ?? null, contacts: vu.contacts ?? 0 }
        : null,
    };
  });

  // Le rang se calcule sur l'ensemble, pas fiche par fiche : savoir qu'on tient
  // son troisième meilleur client change la façon de lui répondre.
  const parChiffre = [...completes].sort((a, b) => b.chiffre - a.chiffre);
  parChiffre.forEach((f, rang) => {
    f.rang = rang + 1;
    f.surTotal = completes.length;
  });

  return completes.sort((a, b) => String(b.derniere).localeCompare(String(a.derniere)));
}

/* ══ Ce qui se déduit ════════════════════════════════════════ */

/** Jours pleins entre deux instants. */
function joursEntre(iso, reference) {
  const depuis = new Date(iso).getTime();
  if (!Number.isFinite(depuis)) return null;
  return Math.max(0, Math.floor((reference - depuis) / 86400000));
}

/**
 * Le nombre de jours moyen entre deux commandes.
 *
 * `null` en dessous de deux commandes : il n'y a alors aucun intervalle à
 * moyenner, et répondre « 0 jour » ferait passer un client unique pour le plus
 * fidèle de tous.
 */
function rythme(dates) {
  if (dates.length < 2) return null;
  const triees = [...dates].sort();
  const premier = new Date(triees[0]).getTime();
  const dernier = new Date(triees[triees.length - 1]).getTime();
  if (!Number.isFinite(premier) || !Number.isFinite(dernier)) return null;
  return Math.round((dernier - premier) / 86400000 / (triees.length - 1));
}

/** La clé la plus fréquente d'un décompte, ou `null` si le décompte est vide. */
function sommet(compte) {
  let gagnant = null;
  let meilleur = 0;
  for (const [clef, nombre] of compte) {
    if (nombre > meilleur) {
      meilleur = nombre;
      gagnant = clef;
    }
  }
  return gagnant;
}

/**
 * Le jour et l'heure d'un instant, dans le fuseau de la boutique.
 *
 * Une commande de 00 h 30 à Mulhouse est une commande du vendredi soir, pas du
 * samedi matin en UTC. Le formateur est construit une fois par appel : en
 * construire un par commande coûtait plus cher que tout le reste de la fonction.
 */
function dateurs(timezone) {
  let format;
  try {
    format = new Intl.DateTimeFormat('fr-FR', {
      timeZone: timezone,
      weekday: 'long',
      hour: '2-digit',
      hour12: false,
    });
  } catch {
    // Un fuseau inconnu ne doit pas faire tomber la page : on retombe sur UTC.
    format = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', hour: '2-digit', hour12: false });
  }

  return (iso) => {
    const quand = new Date(iso);
    if (!Number.isFinite(quand.getTime())) return { jour: null, heure: null };
    const parties = format.formatToParts(quand);
    const jour = parties.find((p) => p.type === 'weekday')?.value ?? null;
    const heure = Number(parties.find((p) => p.type === 'hour')?.value);
    return { jour, heure: Number.isFinite(heure) ? heure : null };
  };
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
