import { defineConfig } from 'vitest/config';

// Root config: one project per workspace (Vitest 5 `test.projects`; the old vitest.workspace.ts file is gone).
export default defineConfig({
  test: {
    projects: ['packages/shared', 'apps/server', 'apps/web', { test: { name: 'e2e-helpers', environment: 'node', include: ['e2e/*.test.ts'] } }],
  },
});
