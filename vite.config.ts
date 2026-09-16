import { defineConfig } from 'vite';

// base is set for GitHub Pages project site: https://lwcrafts.github.io/seed-papercut/
export default defineConfig({
  base: '/seed-papercut/',
  build: {
    target: 'es2022',
  },
});
