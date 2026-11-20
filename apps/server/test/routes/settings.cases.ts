import { randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import type { RouteCase } from '../helpers/routeCases';

export const cases: RouteCase[] = [
  {
    route: 'settings.get',
    name: 'public fields only',
    expect: 'ok',
    check: (r) =>
      expect(Object.keys((r.json as { settings: object }).settings).sort()).toEqual([
        'llm.answerLanguage',
        'llm.backend',
        'llm.economy',
        'llm.monthlyLimitMicroUsd',
        'study.codeLanguage',
      ]),
  },
  { route: 'settings.put', name: 'set budget', body: { settings: { 'llm.monthlyLimitMicroUsd': 20_000_000 } }, expect: 'ok' },
  { route: 'settings.put', name: 'private keys rejected', body: { settings: { 'ingest.cooldown.arxiv': 0 } }, expect: 'validation' },
  {
    route: 'settings.secret.put',
    name: 'only the masked status returns',
    body: () => ({ key: 'sk-ant-api03-' + randomBytes(32).toString('hex') }),
    expect: 'ok',
    check: (r) => {
      expect(r.json).toMatchObject({ keyConfigured: true });
      expect(r.text).not.toContain('sk-ant-');
    },
  },
  { route: 'settings.secret.put', name: 'reject unsupported credential', body: { key: 'invalid' }, expect: 'validation' },
  {
    route: 'settings.secret.delete',
    name: 'delete key',
    expect: 'ok',
    check: (r) => expect(r.json).toMatchObject({ keyConfigured: false }),
  },
  { route: 'settings.secret.check', name: 'offline check without model request', body: {}, expect: 'ok' },
  { route: 'settings.secret.check', name: 'strict check body', body: { key: 'invalid' }, expect: 'validation' },
  {
    route: 'usage.summary',
    name: 'UTC month and distinct accounting',
    expect: 'ok',
    check: (r) => expect(r.json).toMatchObject({ heldMicroUsd: 0, spentMicroUsd: 0 }),
  },
  { route: 'usage.summary', name: 'reject negative interval', query: { days: '-1' }, expect: 'validation' },
];
