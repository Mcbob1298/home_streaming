import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * En développement, le front est servi par Vite sur le port 5173 et l'API par
 * Fastify sur le 3000. Le proxy ci-dessous fait croire au navigateur que tout
 * vient de la même adresse : le code du front appelle simplement « /api/... »,
 * sans se soucier du port ni du CORS.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
});
