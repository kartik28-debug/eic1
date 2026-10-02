import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main:           resolve(import.meta.dirname, 'index.html'),
        games:          resolve(import.meta.dirname, 'games.html'),
        login:          resolve(import.meta.dirname, 'login.html'),
        changePassword: resolve(import.meta.dirname, 'change-password.html'),
      },
    },
  },
});
