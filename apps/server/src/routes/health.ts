// Owner supervisor. GET /api/health.
import type { HealthResponse } from '@study-paper/shared/contracts/api';
import { readSettings } from '../byok/settings';
import { lastAppliedMigration } from '../db/migrate';
import { APP_VERSION } from '../config';
import { PDFJS_VERSION } from '../ingest/pdfText';
import { routeJson, type RouteModule } from '../deps';

export const healthRoutes: RouteModule = (deps) => ({
  health: (c) => {
    let ok = true;
    let lastMigration: string | null = null;
    let llm: HealthResponse['llm'] = deps.config.llmMode;
    let backend: HealthResponse['backend'];
    try {
      deps.sqlite.prepare('SELECT 1').get();
      lastMigration = lastAppliedMigration(deps.sqlite);
      backend = readSettings(deps.sqlite)['llm.backend'];
      llm = deps.backends.mode(backend);
    } catch {
      ok = false;
    }
    return routeJson(c, 'health', {
      ok,
      app: 'study_paper',
      version: APP_VERSION,
      env: deps.config.env,
      llm,
      backend,
      pdfjsVersion: PDFJS_VERSION,
      db: { ok, lastMigration },
    });
  },
});
