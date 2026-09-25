import { defineConfig } from 'vitest/config';

// Unit tests for the pure config/lib modules. Vite's own env handling gives
// `import.meta.env` its defaults (no VITE_* set), i.e. the testnet build.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});

