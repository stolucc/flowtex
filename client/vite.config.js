import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '..', 'shared'),
    },
  },
  test: {
    include: ['src/**/__tests__/**/*.test.{js,jsx}', 'src/**/*.test.{js,jsx}'],
    environment: 'happy-dom',
  },
  build: {
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) {
            return 'react';
          }
          if (id.includes('node_modules/codemirror') || id.includes('node_modules/@codemirror/')) {
            return 'codemirror';
          }
          // pdfjs is huge (~hundreds of KB). Splitting it into its
          // own chunk means the loader only fetches it when something
          // that imports pdfjs (PdfViewer / BinaryPreview) actually
          // renders — those components are now lazy-loaded too.
          if (id.includes('node_modules/pdfjs-dist')) {
            return 'pdfjs';
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
});
