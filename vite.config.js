import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'public/firecrawl',
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: 'ui/main.jsx',
      output: {
        entryFileNames: 'app.js',
        assetFileNames: 'app.css',
        chunkFileNames: 'chunk-[hash].js',
      },
    },
  },
});
