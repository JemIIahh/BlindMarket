import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/health': 'http://localhost:3001',
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 2200,
    rollupOptions: {
      output: {
        // Pull a few large, slow-changing vendors into their own cacheable
        // chunks. Deliberately conservative: we only name vendors that are
        // ALREADY eagerly imported app-wide (so no lazy boundary is collapsed),
        // and there is intentionally NO catch-all `return 'vendor'`. @privy-io
        // splits its own login-modal views into lazy chunks loaded only when the
        // modal opens; forcing it (or anything dynamically imported) into a
        // named eager chunk would bloat every page's critical path. three.js is
        // isolated so it ships only with the lazy landing globe.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/[\\/]three[\\/]/.test(id)) return 'three-vendor';
          if (/[\\/](framer-motion|motion-dom|motion-utils)[\\/]/.test(id)) return 'motion-vendor';
          if (/[\\/]@tanstack[\\/]/.test(id)) return 'query-vendor';
          if (/[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return 'react-vendor';
          if (/[\\/]@privy-io[\\/]/.test(id)) return 'privy-vendor';
          if (/[\\/]@walletconnect[\\/]/.test(id)) return 'walletconnect-vendor';
          if (/[\\/]@wagmi[\\/]/.test(id)) return 'wagmi-vendor';
          if (/[\\/]wagmi[\\/]/.test(id)) return 'wagmi-vendor';
          if (/[\\/]viem[\\/]/.test(id)) return 'viem-vendor';
          if (/[\\/]abitype[\\/]/.test(id)) return 'viem-vendor';
          // NOTE: ethers is intentionally NOT manually chunked. It shares a
          // circular dependency edge with wagmi/viem/privy; forcing it into a
          // separate chunk produced "Circular chunk: wagmi-vendor ->
          // ethers-vendor -> wagmi-vendor" and a runtime TDZ crash
          // ("can't access lexical declaration 'qx' before initialization").
          // Leaving ethers in Rollup's default chunking lets it be co-located
          // with the vendor that imports it, avoiding the circular chunk edge.
        },
      },
    },
  },
});
