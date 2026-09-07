/**
 * Point d'entrée de la fonction serverless (Vercel).
 *
 * Vercel appelle ce fichier pour tout ce qui commence par `/api/` (voir les
 * réécritures de vercel.json) ; les fichiers de `webapp/` sont eux servis
 * directement par le CDN, sans passer par ici.
 *
 * L'application Express est réutilisée telle quelle : `server/index.js`
 * n'écoute un port et ne lance le long polling que s'il est exécuté
 * directement (`npm start`).
 */
export { default } from '../server/index.js';
