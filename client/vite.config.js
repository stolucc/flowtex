import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/__tests__/**/*.test.js', 'src/**/*.test.js'],
  },
  build: {
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        manualChunks: {
          codemirror: ['codemirror', '@codemirror/language', '@codemirror/state', '@codemirror/view', '@codemirror/search', '@codemirror/autocomplete', '@codemirror/commands', '@codemirror/lint'],
          react: ['react', 'react-dom'],
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
