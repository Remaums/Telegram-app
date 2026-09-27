/**
 * L'état de santé des médias de la boutique.
 *
 * Répond à la question qu'on se pose quand une vidéo ne démarre pas : est-ce
 * la boutique, le navigateur, ou Telegram ? La boutique ne stocke pas les
 * fichiers, elle garde une référence et les relaie à la demande. Quand ce
 * relais échoue, le client voit une vidéo morte et le vendeur ne voit rien
 * du tout — c'est ce silence que cet outil casse.
 *
 * La cause la plus fréquente, et de loin : Telegram ne rend pas à un bot un
 * fichier de plus de 20 Mo. L'envoi, lui, réussit — un téléphone envoie sans
 * peine une vidéo de cent mégaoctets. Le fichier est donc bien là, bien
 * référencé, et définitivement illisible. La boutique refuse désormais ces
 * envois, mais un média ajouté avant cette borne est toujours en place.
 *
 * Aucune modification : cet outil lit et rapporte.
 *
 * Usage :
 *   node tools/medias.mjs                (utilise BOT_TOKEN du .env)
 */
import 'dotenv/config';

const token = process.env.BOT_TOKEN ?? '';
const base = (process.env.TEST_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, '');
const apiRoot = process.env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org';

if (!token) {
  console.error('BOT_TOKEN manquant : renseigne .env avant de lancer cet outil.');
  process.exit(1);
}

const mo = (n) => `${(n / 1024 / 1024).toFixed(1)} Mo`;
let soucis = 0;

/* ── Le catalogue, vu du serveur ─────────────────────────── */

let produits;
try {
  const res = await fetch(`${base}/api/catalog`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  ({ products: produits } = await res.json());
} catch (err) {
  console.error(`\nLa boutique ne répond pas sur ${base} : ${err.message}`);
  console.error('Démarre-la, ou passe une autre adresse par TEST_BASE_URL.');
  process.exit(1);
}

/* ── Chaque média, un par un ─────────────────────────────── */

console.log(`\nMédias de ${produits.length} produit(s) — ${base}\n`);

for (const produit of produits) {
  const medias = Array.isArray(produit.media) ? produit.media : [];
  const vignette = produit.photoFileId ? [{ kind: 'photo', fileId: produit.photoFileId, vignette: true }] : [];
  const tout = [...vignette, ...medias];
  if (!tout.length) continue;

  const lignes = [];
  for (const [rang, media] of tout.entries()) {
    const quoi = `${media.vignette ? 'vignette' : `média ${rang - vignette.length}`} (${media.kind})`;

    // Un média hébergé ailleurs ne passe pas par Telegram : rien à demander.
    if (!media.fileId) {
      lignes.push(`    ✅  ${quoi} — servi depuis la boutique`);
      continue;
    }

    let data;
    try {
      const res = await fetch(`${apiRoot}/bot${token}/getFile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: media.fileId }),
      });
      data = await res.json();
    } catch (err) {
      lignes.push(`    ⚠️   ${quoi} — Telegram injoignable : ${err.message}`);
      soucis++;
      continue;
    }

    if (!data.ok) {
      const raison = data.description ?? 'raison inconnue';
      // La formulation exacte de Telegram, et ce qu'elle veut dire ici.
      const explication = /too big/i.test(raison)
        ? 'ce fichier dépasse les 20 Mo qu\'un bot peut retélécharger — il ne pourra jamais être joué'
        : /wrong file_id|not found|invalid/i.test(raison)
          ? 'référence inconnue de ce bot — le fichier vient peut-être d\'un autre bot'
          : null;
      lignes.push(`    ❌  ${quoi} — ${raison}${explication ? `\n        → ${explication}` : ''}`);
      soucis++;
      continue;
    }

    const taille = data.result.file_size;
    lignes.push(`    ✅  ${quoi} — ${taille ? mo(taille) : 'taille inconnue'}`);
  }

  if (lignes.some((l) => !l.includes('✅')) || process.env.TOUT) {
    console.log(`  ${produit.name}`);
    for (const l of lignes) console.log(l);
    console.log();
  }
}

if (soucis) {
  console.log(`${soucis} média(s) à reprendre.\n`);
  console.log('Pour un fichier trop lourd : réencode-le plus léger et renvoie-le au bot');
  console.log('avec le nom du produit en légende. Une vidéo de trente secondes en 720p');
  console.log('tient largement sous les 20 Mo.\n');
} else {
  console.log('Tous les médias répondent.\n');
  console.log('Passe TOUT=1 pour voir aussi ceux qui vont bien.\n');
}
process.exit(soucis ? 1 : 0);
