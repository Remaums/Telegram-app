/**
 * Créneaux de retrait ou de livraison, et zones de livraison.
 *
 * Fonctions pures, sans accès au magasin : l'heure et les réglages sont passés
 * en argument. On peut donc vérifier ce que la boutique proposera samedi
 * prochain sans attendre samedi prochain.
 */

import { DAYS } from './opening.js';

/* ══ Zones de livraison ══════════════════════════════════════ */

/**
 * Une zone porte ses propres frais, son minimum et son franco.
 *
 * `null` sur le minimum ou le franco veut dire « celui de la boutique » — ce
 * qui n'est pas la même chose que zéro. Sans zone déclarée, la livraison reste
 * ouverte partout aux conditions générales : les zones sont un raffinement,
 * pas un passage obligé.
 */
export function normalizeZones(list) {
  if (!Array.isArray(list)) return [];

  const seen = new Set();
  return list
    .map((zone) => {
      const name = String(zone?.name ?? '').trim().slice(0, 40);
      if (!name) return null;

      const codes = [
        ...new Set(
          (Array.isArray(zone.postalCodes) ? zone.postalCodes : String(zone.postalCodes ?? '').split(/[,\s;]+/))
            .map((code) => String(code).trim())
            .filter((code) => /^\d{2,6}$/.test(code))
        ),
      ].slice(0, 60);
      if (!codes.length) return null;

      return {
        id: uniqueId(slug(name), seen),
        name,
        postalCodes: codes,
        fee: cents(zone.fee, 0),
        minimumOrder: optionalCents(zone.minimumOrder),
        freeFrom: optionalCents(zone.freeFrom),
      };
    })
    .filter(Boolean)
    .slice(0, 20);
}

/** La zone qui couvre ce code postal, ou `null` si personne ne le dessert. */
export function findZone(zones, postalCode) {
  const code = String(postalCode ?? '').trim();
  if (!/^\d{2,6}$/.test(code)) return null;
  return (zones ?? []).find((zone) => zone.postalCodes.includes(code)) ?? null;
}

/* ══ Adresse de livraison ════════════════════════════════════ */

/**
 * Nettoie une adresse reçue du client. Rend toujours un objet.
 *
 * Les espaces multiples sont réduits : une adresse recopiée depuis une note
 * arrive souvent avec des retours à la ligne, et elle finit dans une URL
 * d'itinéraire où ils n'ont rien à faire.
 */
export function normalizeAddress(input) {
  const propre = (valeur, max) => String(valeur ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const source = input && typeof input === 'object' ? input : {};
  return {
    street: propre(source.street, 120),
    complement: propre(source.complement, 120),
    postalCode: propre(source.postalCode, 10),
    city: propre(source.city, 60),
  };
}

/**
 * Ce qui manque pour qu'un livreur trouve la porte.
 *
 * Le numéro de rue n'est pas exigé : un lieu-dit, un hameau, une résidence
 * sans numéro existent, et refuser leur commande coûterait plus cher qu'une
 * adresse imprécise. Le reste, si : sans ville ni code postal, une rue ne
 * désigne rien — il y a une rue de la Gare dans presque chaque commune.
 *
 * @returns {string|null} le reproche à faire au client, ou null si l'adresse
 *   tient debout.
 */
export function adresseIncomplete(address) {
  const rue = address?.street ?? '';
  if (rue.length < 5 || !/\p{L}/u.test(rue)) {
    return 'Indique la rue et le numéro, par exemple « 12 rue des Lilas ».';
  }
  if (!/^\d{2,6}$/.test(address?.postalCode ?? '')) return 'Indique un code postal valide.';
  if ((address?.city ?? '').length < 2) return 'Indique la ville.';
  return null;
}

/**
 * L'adresse telle qu'on la donne à un GPS.
 *
 * Le complément reste dehors : « 3e étage, code 1234 » n'aide aucun
 * géocodeur, et beaucoup renoncent à chercher plutôt que de l'ignorer.
 */
export function adressePourGps(address) {
  if (adresseIncomplete(address)) return '';
  return `${address.street}, ${address.postalCode} ${address.city}`;
}

/** L'adresse en clair pour un humain, complément compris. */
export function adresseEnClair(address, separateur = '\n') {
  if (!address?.street) return '';
  return [address.street, address.complement, `${address.postalCode} ${address.city}`.trim()]
    .filter(Boolean)
    .join(separateur);
}

/**
 * Les liens d'itinéraire vers les applications de trajet courantes.
 *
 * Trois, parce qu'aucune ne va de soi : Waze est le réflexe de beaucoup de
 * livreurs, Plans s'ouvre tout seul sur un iPhone, et Maps reste le repli qui
 * marche partout, y compris dans un navigateur. Chacune ouvre l'application
 * installée si elle l'est, son site sinon.
 */
export function liensItineraire(address) {
  const destination = adressePourGps(address);
  if (!destination) return null;

  const q = encodeURIComponent(destination);
  return {
    maps: `https://www.google.com/maps/dir/?api=1&destination=${q}`,
    waze: `https://waze.com/ul?q=${q}&navigate=yes`,
    plans: `https://maps.apple.com/?daddr=${q}`,
  };
}

/* ══ Créneaux ════════════════════════════════════════════════ */

export function defaultSlots() {
  return {
    enabled: false,
    // Délai minimum avant le début d'un créneau : on ne réserve pas celui qui
    // commence dans cinq minutes, personne n'aurait le temps de préparer.
    leadMinutes: 60,
    daysAhead: 7,
    days: Object.fromEntries(DAYS.map((day) => [day, []])),
  };
}

export function normalizeSlots(input) {
  const base = defaultSlots();
  if (!input || typeof input !== 'object') return base;

  base.enabled = Boolean(input.enabled);
  base.leadMinutes = bounded(input.leadMinutes, 0, 7 * 24 * 60, base.leadMinutes);
  base.daysAhead = bounded(input.daysAhead, 1, 14, base.daysAhead);

  for (const day of DAYS) {
    const rows = Array.isArray(input.days?.[day]) ? input.days[day] : [];
    base.days[day] = rows
      .map((row) => {
        const from = toMinutes(row?.from);
        const to = toMinutes(row?.to);
        // Un créneau qui finit avant de commencer n'a pas de sens, et un
        // créneau à cheval sur minuit compliquerait la date de réservation.
        if (from === null || to === null || to <= from) return null;
        return { from: pad(from), to: pad(to), capacity: bounded(row.capacity, 1, 999, 10) };
      })
      .filter(Boolean)
      .sort((a, b) => a.from.localeCompare(b.from))
      .slice(0, 8);
  }
  return base;
}

/** Identifiant stable d'un créneau : la date et son heure de début. */
export function slotKey(date, from) {
  return `${date}|${from}`;
}

/**
 * Les créneaux proposables à cet instant, sur la fenêtre réglée.
 *
 * Un créneau déjà commencé, ou trop proche pour être préparé, ne figure pas
 * dans la liste — et comme la commande revalide contre cette même liste, il ne
 * peut pas être réservé par une page restée ouverte toute la nuit.
 */
export function availableSlots(slots, { now = new Date(), timezone = 'Europe/Paris' } = {}) {
  if (!slots?.enabled) return [];

  const today = localDate(now, timezone);
  const minutesNow = localMinutes(now, timezone);
  const out = [];

  for (let offset = 0; offset < slots.daysAhead; offset++) {
    const date = addDays(today, offset);
    for (const slot of slots.days[dayKey(date)] ?? []) {
      // Le délai de préparation ne joue que pour aujourd'hui : demain, tous
      // les créneaux sont largement assez loin.
      if (offset === 0 && toMinutes(slot.from) < minutesNow + slots.leadMinutes) continue;
      out.push({ id: slotKey(date, slot.from), date, day: dayKey(date), ...slot });
    }
  }
  return out;
}

/** Le créneau demandé fait-il partie de ceux qu'on propose ? */
export function findSlot(slots, id, options) {
  return availableSlots(slots, options).find((slot) => slot.id === id) ?? null;
}

/** Libellé lisible : « vendredi 12 septembre, 18:00 – 20:00 ». */
export function slotLabel(slot) {
  if (!slot) return '';
  const date = new Date(`${slot.date}T12:00:00Z`);
  const jour = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long',
  }).format(date);
  return `${jour}, ${slot.from} – ${slot.to}`;
}

/* ── Dates dans le fuseau de la boutique ─────────────────── */

/** Date du jour telle que la boutique la vit, pas telle que le serveur la vit. */
function localDate(now, timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Europe/Paris',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now); // en-CA donne AAAA-MM-JJ
}

function localMinutes(now, timezone) {
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: timezone || 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}

/**
 * Ajoute des jours à une date civile.
 *
 * Le calcul passe par midi UTC : à minuit, un changement d'heure d'été ferait
 * sauter ou répéter une journée.
 */
function addDays(date, days) {
  const anchor = new Date(`${date}T12:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return anchor.toISOString().slice(0, 10);
}

function dayKey(date) {
  return DAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
}

/* ── Utilitaires ─────────────────────────────────────────── */

function toMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function pad(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function bounded(value, min, max, fallback) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function cents(value, fallback) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number >= 0 ? Math.min(number, 1000000) : fallback;
}

function optionalCents(value) {
  if (value === null || value === undefined || value === '') return null;
  return cents(value, null);
}

function slug(name) {
  return (
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'zone'
  );
}

/** Deux zones peuvent porter le même nom : leurs identifiants, non. */
function uniqueId(base, seen) {
  let id = base;
  let n = 2;
  while (seen.has(id)) id = `${base}-${n++}`;
  seen.add(id);
  return id;
}
