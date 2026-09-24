import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Lets the dev server forward /api calls to the Express backend so cookies
      // work under one origin during development.
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true
      }
    }
  }
});
