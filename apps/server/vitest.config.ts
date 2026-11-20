import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'server', environment: 'node', include: ['test/**/*.test.ts'], testTimeout: 20_000, pool: 'forks', setupFiles: ['test/helpers/vitestSetup.ts'] },
});
