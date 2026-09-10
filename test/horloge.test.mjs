/**
 * Les horaires aux moments où le calendrier ment.
 *
 * Minuit, les deux changements d'heure, l'heure locale qui n'existe pas le
 * jour du passage à l'été, les fuseaux à décalage non entier. Les fonctions
 * concernées sont pures et prennent l'instant en argument : on peut donc
 * voyager dans le temps au lieu d'attendre octobre.
 *
 * Aucun serveur, aucun réseau.
 *
 * Usage :  node test/horloge.test.mjs
 */
import { isOpenNow, nextChange, normalizeHours, DAYS } from '../server/opening.js';
import { availableSlots, normalizeSlots, slotLabel } from '../server/delivery.js';

let failures = 0;
const dit = (ok, label, note = '') => {
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${note ? `  (${note})` : ''}`);
  if (!ok) failures++;
};

const horaires = (jours, tz = 'Europe/Paris') => ({
  open: true, message: '',
  hours: { enabled: true, timezone: tz, days: normalizeHours(jours) },
});
const tousLesJours = (from, to) =>
  Object.fromEntries(DAYS.map((j) => [j, { closed: false, from, to }]));

console.log('\n=== Une plage qui franchit minuit ===');
{
  // 22:00 → 02:00, tous les jours, à Paris.
  const o = horaires(tousLesJours('22:00', '02:00'));
  const cas = [
    ['23:00 le samedi', '2026-09-12T21:00:00Z', true],
    ['01:00 le dimanche', '2026-09-12T23:00:00Z', true],
    ['03:00 le dimanche', '2026-09-13T01:00:00Z', false],
    ['12:00 le dimanche', '2026-09-13T10:00:00Z', false],
    ['21:59 le dimanche', '2026-09-13T19:59:00Z', false],
    ['22:01 le dimanche', '2026-09-13T20:01:00Z', true],
  ];
  for (const [label, instant, attendu] of cas) {
    const r = isOpenNow(o, new Date(instant));
    dit(r.open === attendu, `${label} : ${attendu ? 'ouvert' : 'fermé'}`, `${r.open} (${r.reason ?? '—'})`);
  }
}

console.log('\n=== Minuit pile et 23:59 ===');
{
  const o = horaires(tousLesJours('00:00', '23:59'));
  dit(isOpenNow(o, new Date('2026-09-12T22:00:00Z')).open, 'minuit pile : ouvert');
  const presqueMinuit = horaires(tousLesJours('09:00', '00:00'));
  const r = isOpenNow(presqueMinuit, new Date('2026-09-12T21:30:00Z'));
  dit(r.open, 'une plage 09:00 → 00:00 couvre 23:30', `${r.open}`);
}

console.log('\n=== Un seul jour ouvert ===');
{
  const jours = Object.fromEntries(DAYS.map((j) => [j, { closed: true, from: '10:00', to: '22:00' }]));
  jours.sam = { closed: false, from: '10:00', to: '18:00' };
  const o = horaires(jours);
  dit(isOpenNow(o, new Date('2026-09-12T12:00:00Z')).open, 'samedi 14 h : ouvert');
  dit(!isOpenNow(o, new Date('2026-09-11T12:00:00Z')).open, 'vendredi 14 h : fermé');
  dit(!isOpenNow(o, new Date('2026-09-12T20:00:00Z')).open, 'samedi 22 h : fermé');
}

console.log('\n=== Changement d heure ===');
{
  // Passage à l'heure d'hiver en France : le 25 octobre 2026 à 03:00 → 02:00.
  const o = horaires(tousLesJours('01:00', '05:00'));
  for (const [label, instant] of [
    ['avant le recul (00:30 UTC = 02:30 locale)', '2026-10-25T00:30:00Z'],
    ['après le recul (01:30 UTC = 02:30 locale)', '2026-10-25T01:30:00Z'],
    ['plus tard (03:30 UTC = 04:30 locale)', '2026-10-25T03:30:00Z'],
  ]) {
    const r = isOpenNow(o, new Date(instant));
    dit(r.open, `${label} : ouvert`, `${r.open}`);
  }

  // Passage à l'heure d'été : le 29 mars 2026 à 02:00 → 03:00. L'heure locale
  // 02:30 n'existe pas ce jour-là.
  const ete = horaires(tousLesJours('02:00', '04:00'));
  const r = isOpenNow(ete, new Date('2026-03-29T01:30:00Z'));
  dit(typeof r.open === 'boolean', 'l heure qui n existe pas ne fait pas planter', `${r.open}`);
}

console.log('\n=== Fuseaux exotiques ===');
{
  for (const tz of ['Asia/Kolkata', 'Pacific/Chatham', 'Australia/Sydney', 'America/St_Johns', 'UTC']) {
    const o = horaires(tousLesJours('10:00', '22:00'), tz);
    const r = isOpenNow(o, new Date('2026-09-12T12:00:00Z'));
    dit(typeof r.open === 'boolean', `${tz} : réponse nette`, `ouvert ${r.open}`);
  }
}

console.log('\n=== Créneaux et changement d heure ===');
{
  const slots = normalizeSlots({
    enabled: true, leadMinutes: 0, daysAhead: 4,
    days: Object.fromEntries(DAYS.map((j) => [j, [{ from: '18:00', to: '20:00', capacity: 5 }]])),
  });

  // Fenêtre à cheval sur le changement d'heure d'hiver.
  const liste = availableSlots(slots, { now: new Date('2026-10-23T12:00:00Z'), timezone: 'Europe/Paris' });
  const dates = liste.map((s) => s.date);
  dit(new Set(dates).size === dates.length, 'aucune date en double autour du changement d heure', dates.join(' '));
  dit(dates.length === 4 || dates.length === 3, 'la fenêtre garde le bon nombre de jours', `${dates.length} jours`);

  const suite = dates.map((d) => new Date(`${d}T12:00:00Z`).getTime());
  const consecutifs = suite.every((t, i) => i === 0 || t - suite[i - 1] === 86400000);
  dit(consecutifs, 'les jours se suivent sans saut ni répétition', dates.join(' → '));

  // Le libellé doit nommer le bon jour de la semaine.
  const samedi = liste.find((s) => s.date === '2026-10-24');
  dit(!samedi || /samedi/.test(slotLabel(samedi)), 'le libellé nomme le bon jour', slotLabel(samedi ?? liste[0]));
}

console.log('\n=== Créneaux à la bascule de minuit ===');
{
  const slots = normalizeSlots({
    enabled: true, leadMinutes: 0, daysAhead: 2,
    days: Object.fromEntries(DAYS.map((j) => [j, [{ from: '10:00', to: '12:00', capacity: 5 }]])),
  });

  // 23:30 heure de Paris le 12 septembre : le créneau du jour est passé, on
  // doit voir celui du 13 puis celui du 14.
  const liste = availableSlots(slots, { now: new Date('2026-09-12T21:30:00Z'), timezone: 'Europe/Paris' });
  dit(liste[0]?.date === '2026-09-13', 'à 23 h 30, le prochain créneau est celui de demain',
      liste.map((s) => s.date).join(' '));

  // 00:30 le 13 : le créneau du 13 est encore devant.
  const apres = availableSlots(slots, { now: new Date('2026-09-12T22:30:00Z'), timezone: 'Europe/Paris' });
  dit(apres[0]?.date === '2026-09-13', 'à 00 h 30, celui du jour même est encore proposé',
      apres.map((s) => s.date).join(' '));
}

console.log('\n=== Délai de préparation ===');
{
  const slots = normalizeSlots({
    enabled: true, leadMinutes: 120, daysAhead: 2,
    days: Object.fromEntries(DAYS.map((j) => [j, [{ from: '10:00', to: '12:00', capacity: 5 }, { from: '18:00', to: '20:00', capacity: 5 }]])),
  });
  // 09:00 locale : le créneau de 10:00 est à une heure, sous le délai de deux.
  const liste = availableSlots(slots, { now: new Date('2026-09-12T07:00:00Z'), timezone: 'Europe/Paris' });
  const aujourdhui = liste.filter((s) => s.date === '2026-09-12').map((s) => s.from);
  dit(!aujourdhui.includes('10:00') && aujourdhui.includes('18:00'),
      'le délai écarte le créneau trop proche, garde celui du soir', aujourdhui.join(' '));

  const demain = liste.filter((s) => s.date === '2026-09-13').map((s) => s.from);
  dit(demain.includes('10:00'), 'le délai ne s applique pas aux jours suivants', demain.join(' '));
}

console.log('\n=== Le décompte jusqu au prochain basculement ===');
{
  // Ce que lit le bandeau de la boutique : « ferme dans 2 h 15 ». Se tromper
  // ici, c'est promettre à un client qu'il a le temps de finir son panier.
  const tous = (from, to) => horaires(tousLesJours(from, to));

  const cas = [
    ['ouvert à 14 h, ferme à 22 h', tous('10:00', '22:00'), '2026-09-12T12:00:00Z', true, 8 * 60],
    ['fermé à 23 h, ouvre à 10 h', tous('10:00', '22:00'), '2026-09-12T21:00:00Z', false, 11 * 60],
    ['une minute avant la fermeture', tous('10:00', '22:00'), '2026-09-12T19:59:00Z', true, 1],
    // Une plage qui franchit minuit : le basculement est le lendemain matin.
    ['ouvert à 23 h sur 22h–02h', tous('22:00', '02:00'), '2026-09-12T21:00:00Z', true, 3 * 60],
    ['fermé à 3 h sur 22h–02h', tous('22:00', '02:00'), '2026-09-13T01:00:00Z', false, 19 * 60],
  ];

  for (const [label, o, instant, ouvert, minutes] of cas) {
    const r = nextChange(o, new Date(instant));
    dit(r?.open === ouvert && r?.minutes === minutes, label,
      r ? `${r.open ? 'ferme' : 'ouvre'} dans ${r.minutes} min, attendu ${minutes}` : 'aucun changement');
  }

  // Trois cas où il n'y a rien à décompter : le bandeau doit alors se taire
  // plutôt que d'afficher un compteur qui ne veut rien dire.
  dit(nextChange({ open: false }, new Date()) === null, 'fermeture manuelle : aucun décompte');
  dit(nextChange({ open: true, hours: { enabled: false } }, new Date()) === null,
    'horaires coupés : aucun décompte');

  const ferme = Object.fromEntries(DAYS.map((j) => [j, { closed: true, from: '10:00', to: '22:00' }]));
  const r = nextChange(horaires(ferme), new Date('2026-09-12T12:00:00Z'));
  dit(r === null, 'tous les jours fermés : aucun décompte', JSON.stringify(r));

  // Un jour unique d'ouverture : le décompte doit traverser toute la semaine.
  const rare = Object.fromEntries(DAYS.map((j) => [j, { closed: true, from: '10:00', to: '22:00' }]));
  rare.mer = { closed: false, from: '14:00', to: '15:00' };
  const loin = nextChange(horaires(rare), new Date('2026-09-12T12:00:00Z'));
  dit(loin?.open === false && loin.minutes > 24 * 60,
    'une ouverture lointaine se décompte quand même',
    loin ? `ouvre dans ${Math.round(loin.minutes / 60)} h` : 'aucun changement');
}

console.log(`\n${failures ? `${failures} test(s) en échec` : 'Horloge et calendrier : OK'}`);
process.exit(failures ? 1 : 0);
