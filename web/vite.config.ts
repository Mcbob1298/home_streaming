import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * En développement, le front est servi par Vite sur le port 5173 et l'API par
 * Fastify. Le proxy ci-dessous fait croire au navigateur que tout vient de la
 * même adresse : le code du front appelle simplement « /api/... », sans se
 * soucier du port ni du CORS.
 *
 * « /images » doit y figurer aussi : ce sont les affiches téléchargées par
 * `npm run metadata`, servies par Fastify. Sans cette entrée, Vite répondrait
 * index.html à la place de l'image — une page HTML dans une balise <img>, donc
 * une affiche cassée, et sans erreur visible dans les journaux.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VITE_API_TARGET désigne le serveur visé.
 *
 * Le serveur vit désormais sur le NAS, et le front reste sur le poste. Pour
 * pointer vers le NAS, créer web/.env.local :
 *
 *     VITE_API_TARGET=http://192.168.1.15:3001
 *
 * 3001 est le conteneur de développement, 3000 celui de production. Sans cette
 * variable, on garde le comportement local — utile quand le serveur tourne
 * aussi sur le poste.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      /*
       * `changeOrigin` doit être VRAI dès que la cible n'est plus la machine
       * locale : sans lui, l'en-tête Host annonce « localhost:5173 » à un
       * serveur qui n'est pas là, ce que Fastify n'a aucune raison d'accepter.
       */
      '/api': { target: API_TARGET, changeOrigin: true },
      '/images': { target: API_TARGET, changeOrigin: true },
    },
  },
});
