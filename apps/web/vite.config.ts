import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // All /api traffic goes to the Fastify server — same-origin in the
    // browser, so no CORS setup needed anywhere.
    proxy: {
      '/api': 'http://127.0.0.1:3001',
    },
  },
});
