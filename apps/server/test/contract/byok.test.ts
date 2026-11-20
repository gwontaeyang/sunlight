import { readMockFile, readMockManifest, readMockOutput } from '@study-paper/shared/mock-outputs';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialStore, credentialDirectory } from '../../src/byok/credentials';
import { ApiProvider, type TestTransport } from '../../src/byok/provider';
import { API_MODELS, charge, worstCharge, zeroCounts } from '../../src/byok/prices';
import { markSent, monthUsage, recoverReservations, reserve, settle } from '../../src/byok/billing';
import { readSettings, writeSettings } from '../../src/byok/settings';
import { Backends } from '../../src/byok/backend';
import { openSqlite } from '../../src/db/client';
import { DEFAULT_MIGRATIONS_FOLDER, migrateWithBackup } from '../../src/db/migrate';
import { MockLlmAdapter } from '../../src/llm/mockAdapter';
import type { LlmEvent, LlmRunRequest } from '../../src/llm/adapter';
import { snapshot } from '../../../../scripts/lib/dataSnapshot';
import { backupDatabase } from '../../src/db/backup';
import { childEnv, buildArgs } from '../../src/llm/claudeCli';
import { SEED_M2_PAPER_ID, SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { sseEvents } from '../routes/threads.cases';
import { startTestServer } from '../helpers/server';
import { tempDir } from '../helpers/tmp';

const sentinel = () => 'sk-ant-api03-' + randomBytes(32).toString('hex');
const open: ReturnType<typeof openSqlite>[] = [];
afterEach(() => {
  for (const s of open.splice(0)) if (s.open) s.close();
});
function request(id: string): LlmRunRequest {
  return {
    runId: id,
    task: 'explain_selection',
    model: 'opus',
    effort: 'high',
    system: 'system',
    prefix: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' } },
      { type: 'text', text: 'supplement', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ],
    tail: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cG5n' } },
      { type: 'text', text: 'question' },
    ],
    timeouts: { startupMs: 1000, firstContentMs: 1000, idleMs: 1000, totalMs: 4000 },
    signal: new AbortController().signal,
  };
}
async function fixture(transport: TestTransport) {
  const root = tempDir();
  const sqlite = openSqlite(join(root, 'db.sqlite'));
  open.push(sqlite);
  await migrateWithBackup(sqlite, { backupsDir: join(root, 'backups') });
  const secrets = new CredentialStore(join(root, 'secrets'));
  const key = sentinel();
  const { generation } = secrets.change(key);
  const api = new ApiProvider(sqlite, secrets, transport);
  return { root, sqlite, secrets, key, api, adapter: api.adapter(generation, API_MODELS.opus) };
}
async function collect(stream: AsyncIterable<LlmEvent>) {
  const events: LlmEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
function response(reason = 'end_turn', stop = true, model: string = API_MODELS.opus, text = 'Answer') {
  const chunks = [
    {
      type: 'message_start',
      message: {
        id: 'fixture',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        usage: {
          input_tokens: 10,
          output_tokens: 0,
          cache_creation_input_tokens: 9,
          cache_read_input_tokens: 6,
          cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 5 },
        },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 7 } },
    ...(stop ? [{ type: 'message_stop' }] : []),
  ];
  return new Response(chunks.map((c) => 'event: ' + c.type + '\ndata: ' + JSON.stringify(c) + '\n\n').join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}
describe('c2 SDK requests and billing', () => {
  it('uses the official stream parser, frozen model, adaptive thinking, unchanged prefix and accounted cache tiers', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = await fixture(async (url, init) => {
      calls.push({ url, init });
      return response();
    });
    writeSettings(f.sqlite, { 'llm.monthlyLimitMicroUsd': 20_000_000 });
    const r = request('ok');
    const events = await collect(f.adapter.run(r));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    const init = calls[0]!.init;
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('x-api-key')).toBe(f.key);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: API_MODELS.opus,
      stream: true,
      service_tier: 'standard_only',
      inference_geo: 'global',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    });
    expect(body.messages[0].content).toEqual([...r.prefix, ...r.tail]);
    expect(body.thinking).not.toHaveProperty('budget_tokens');
    expect(events.map((e) => e.type)).toEqual(['started', 'response_started', 'text', 'result']);
    expect(monthUsage(f.sqlite)).toMatchObject({ apiCalls: 1, spentMicroUsd: 242, heldMicroUsd: 0 });
    expect(JSON.stringify(events)).not.toContain(f.key);
  });
  it.each([
    [401, 'api_auth'],
    [403, 'api_auth'],
    [429, 'rate_limited'],
    [500, 'api_error'],
  ] as const)('redacts HTTP %i, never retries and retains an uncertain reservation', async (status, code) => {
    let calls = 0;
    let privateText = '';
    const f = await fixture(async () => {
      calls++;
      return Response.json({ type: 'error', error: { type: 'api_error', message: privateText } }, { status });
    });
    privateText = f.key;
    writeSettings(f.sqlite, { 'llm.monthlyLimitMicroUsd': 20_000_000 });
    const events = await collect(f.adapter.run(request('failed')));
    expect(calls).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: 'error', code });
    expect(JSON.stringify(events)).not.toContain(f.key);
    expect(monthUsage(f.sqlite).heldMicroUsd).toBe(worstCharge(API_MODELS.opus));
  });
  it.each([
    ['max_tokens', 'api_truncated'],
    ['refusal', 'api_refused'],
  ])('records known final usage even for %s', async (reason, code) => {
    const f = await fixture(async () => response(reason));
    writeSettings(f.sqlite, { 'llm.monthlyLimitMicroUsd': 20_000_000 });
    expect((await collect(f.adapter.run(request('stop')))).at(-1)).toMatchObject({ type: 'error', code });
    expect(monthUsage(f.sqlite)).toMatchObject({ heldMicroUsd: 0, spentMicroUsd: 242 });
  });
  it('keeps the remainder after a truncated stream; blocks invalid pricing, missing key and unconfirmed budget before dispatch', async () => {
    let calls = 0;
    const f = await fixture(async () => {
      calls++;
      return response('end_turn', false);
    });
    expect((await collect(f.adapter.run(request('no-cap')))).at(-1)).toMatchObject({ code: 'budget_exhausted' });
    writeSettings(f.sqlite, { 'llm.monthlyLimitMicroUsd': 20_000_000 });
    expect((await collect(f.adapter.run(request('cut')))).at(-1)).toMatchObject({ code: 'api_error' });
    const m = monthUsage(f.sqlite);
    expect(m.spentMicroUsd + m.heldMicroUsd).toBe(worstCharge(API_MODELS.opus));
    f.secrets.change(null);
    expect((await collect(f.adapter.run(request('stale')))).at(-1)).toMatchObject({ code: 'api_key_missing' });
    expect((await collect(f.api.adapter(null, null).run(request('unknown')))).at(-1)).toMatchObject({ code: 'api_error' });
    expect(calls).toBe(1);
  });
  it('verifies explicitly with one guarded GET; switching keys invalidates queued selections and repairs', async () => {
    const calls: string[] = [];
    const f = await fixture(async (url, init) => {
      calls.push(String(init.method) + ' ' + url);
      return Response.json({ id: API_MODELS.haiku, type: 'model' });
    });
    const cli = { ...new MockLlmAdapter(), mode: 'cli' as const, run: new MockLlmAdapter().run, health: new MockLlmAdapter().health };
    const router = new Backends(f.sqlite, cli, f.api, 'missing');
    writeSettings(f.sqlite, { 'llm.backend': 'api', 'llm.monthlyLimitMicroUsd': 20_000_000 });
    const accepted = router.select('explain_selection');
    expect(await f.api.check()).toBe('verified');
    expect(monthUsage(f.sqlite)).toMatchObject({ checks: 1, apiCalls: 0, spentMicroUsd: 0 });
    f.secrets.change(sentinel());
    expect(accepted.rotation?.aborted).toBe(true);
    expect((await collect(accepted.adapter.run(request('repair')))).at(-1)).toMatchObject({ code: 'api_key_missing' });
    expect(calls).toEqual(['GET https://api.anthropic.com/v1/models/' + API_MODELS.haiku]);
    const mock = new Backends(f.sqlite, new MockLlmAdapter(), f.api, 'missing');
    expect(mock.select('explain_selection').columns).toMatchObject({ executionMode: 'mock', backend: 'api' });
  });
  it('serializes concurrent reservations across DB connections; holds survive restarts, deletion, key changes and UTC rollover', async () => {
    const f = await fixture(async () => response());
    const db2 = openSqlite(join(f.root, 'db.sqlite'));
    open.push(db2);
    const model = API_MODELS.opus;
    const max = worstCharge(model);
    writeSettings(f.sqlite, { 'llm.monthlyLimitMicroUsd': max });
    const end = Date.UTC(2026, 9, 31, 23, 59, 59);
    reserve(f.sqlite, 'a', model, 'old', 'message', end);
    markSent(f.sqlite, 'a');
    expect(() => reserve(db2, 'b', model, 'new', 'message', end)).toThrow('budget_exhausted');
    reserve(db2, 'b', model, 'new', 'message', end + 1000);
    settle(db2, 'b', model, null, false);
    expect(monthUsage(db2, '2026-11').heldMicroUsd).toBe(0);
    expect(monthUsage(db2, '2026-10').heldMicroUsd).toBe(max);
    settle(f.sqlite, 'a', model, { ...zeroCounts(), input: 1 }, false);
    expect(monthUsage(db2, '2026-10')).toMatchObject({ spentMicroUsd: 4, heldMicroUsd: max - 4 });
    expect(() => worstCharge('unknown')).toThrow();
    expect(charge(API_MODELS.haiku, { ...zeroCounts(), input: 99_999, read: 1 })).toBe(10_000);
    expect(charge(API_MODELS.haiku, { ...zeroCounts(), input: 99_999, read: 2 })).toBe(50_000);
    expect(charge(API_MODELS.sonnet, { input: 10, read: 10, write5: 2, write60: 3, output: 2 })).toBe(58);
  });
});
describe('c2 credential storage', () => {
  it('requires three distinct real siblings and keeps one owner-only credential file', async () => {
    const f = await fixture(async () => response());
    const env = {
      SP_DATA_DIR: join(f.root, 'data'),
      SP_CONFIG_PATH: join(f.root, 'config', 'config.json'),
      SP_SECRETS_DIR: f.secrets.dir,
    };
    expect(credentialDirectory(env, false)).toBe(f.secrets.dir);
    expect(() => credentialDirectory({ ...env, SP_SECRETS_DIR: '' }, false)).toThrow();
    expect(() => credentialDirectory({ ...env, SP_SECRETS_DIR: join(env.SP_DATA_DIR, 'secret') }, false)).toThrow();
    const path = join(f.secrets.dir, 'anthropic.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(f.secrets.dir).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(f.secrets.status())).not.toContain(f.key);
    expect(JSON.stringify(readSettings(f.sqlite))).not.toContain(f.key);
    const alias = join(f.root, 'alias');
    symlinkSync(f.secrets.dir, alias);
    expect(() => credentialDirectory({ ...env, SP_SECRETS_DIR: alias }, false)).toThrow();
    linkSync(path, join(f.root, 'copy'));
    expect(() => f.secrets.change(null)).toThrow();
    unlinkSync(join(f.root, 'copy'));
    chmodSync(path, 0o644);
    expect(() => f.secrets.read()).toThrow();
    chmodSync(path, 0o600);
    unlinkSync(path);
    writeFileSync(join(f.root, 'untouched'), 'keep');
    symlinkSync(join(f.root, 'untouched'), path);
    expect(() => f.secrets.change(null)).toThrow();
    expect(readFileSync(join(f.root, 'untouched'), 'utf8')).toBe('keep');
    unlinkSync(path);
    f.secrets.change(null);
    expect(readdirSync(f.secrets.dir)).toEqual(['anthropic.json']);
    expect(readFileSync(path, 'utf8')).not.toContain(f.key);
    mkdirSync(join(f.root, 'private-data'));
    expect(existsSync(join(f.root, 'private-data', 'anthropic.json'))).toBe(false);
  });
});

function credentialHits(dir: string, value: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return credentialHits(path, value);
    return entry.isFile() && readFileSync(path).includes(value) ? [path] : [];
  });
}

it('keeps health diagnostics available when stored provider settings cannot be decoded', async () => {
  const server = await startTestServer({ env: 'prod' });
  const health = () => server.req('/api/health', { headers: { 'X-SP-Token': server.token } });
  const damaged = 'invalid-setting-' + randomUUID();
  try {
    server.deps.sqlite.prepare('INSERT OR REPLACE INTO settings(key,valueJson) VALUES (?,?)').run('llm.backend', damaged);
    const degraded = await health();
    expect(degraded.status).toBe(200);
    expect(JSON.parse(degraded.text)).toMatchObject({ ok: false, llm: 'mock', db: { ok: false, lastMigration: '0004_study_path' } });
    expect(JSON.parse(degraded.text)).not.toHaveProperty('backend');
    expect(degraded.text).not.toContain(damaged);
    server.deps.sqlite.prepare('DELETE FROM settings WHERE key=?').run('llm.backend');
    expect(JSON.parse((await health()).text)).toMatchObject({ ok: true, backend: 'subscription' });
  } finally {
    await server.close();
  }
});

it('real route → SDK fake stream → verified citation → replay across backend switch and restart; key absent from backups, snapshot and responses', async () => {
  let messages = 0;
  const fallback = {
    mode: 'cli' as const,
    health: new MockLlmAdapter().health,
    run() {
      throw Error('unexpected subscription dispatch');
    },
  };
  let server = await startTestServer({
    env: 'prod',
    seed: true,
    llm: fallback,
    apiTransport: async () => {
      messages++;
      return response('end_turn', true, API_MODELS.opus, 'The authors write <q>We estimate the robot pose</q>. [[P]]');
    },
  });
  const k = sentinel(),
    data = server.dataDir,
    parent = dirname(data);
  const call = (method: string, path: string, body?: unknown) =>
    server.req('/api/' + path, {
      method,
      headers: { 'X-SP-Token': server.token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  let closed = false;
  try {
    const put = await call('PUT', 'settings/secret', { key: k });
    expect(put.status).toBe(200);
    expect(put.text).not.toContain(k);
    expect((await call('PUT', 'settings/secret', { [k]: k })).text).not.toContain(k);
    expect(
      (await call('PUT', 'settings', { settings: { 'llm.backend': 'api', 'llm.monthlyLimitMicroUsd': 20_000_000 } })).status,
    ).toBe(200);
    const path = 'papers/' + SEED_PAPER_ID + '/threads';
    const body = { kind: 'explain', text: 'We estimate the robot pose', clientRequestId: randomUUID() };
    const one = await call('POST', path, body);
    const events = sseEvents(one.text);
    expect(events.at(-1)?.event).toBe('run.done');
    expect(one.text).not.toContain(k);
    const id = events[0];
    if (id?.event !== 'run.accepted') throw Error('missing acceptance');
    const row = server.deps.sqlite
      .prepare('SELECT executionMode,requestedModel,priceVersion,credentialGeneration FROM llm_calls WHERE runId=?')
      .get(id.data.runId);
    expect(row).toMatchObject({
      executionMode: 'api',
      requestedModel: API_MODELS.opus,
      credentialGeneration: JSON.parse(put.text).generation,
    });
    expect(
      server.deps.sqlite
        .prepare(
          "SELECT count(*) AS n FROM citations JOIN messages ON messages.id=citations.ownerId WHERE messages.llmCallId=? AND citations.status='verbatim'",
        )
        .get(id.data.runId),
    ).toEqual({ n: 1 });
    await call('PUT', 'settings', { settings: { 'llm.backend': 'subscription' } });
    expect(sseEvents((await call('POST', path, body)).text).at(-1)?.event).toBe('run.done');
    server = await server.restart();
    expect(sseEvents((await call('POST', path, body)).text).at(-1)?.event).toBe('run.done');
    expect(messages).toBe(1);
    const cli = childEnv({ ANTHROPIC_API_KEY: k, ANTHROPIC_CUSTOM_HEADERS: k, SP_SECRETS_DIR: k });
    expect(JSON.stringify([cli, buildArgs(request('cli'))])).not.toContain(k);
    await backupDatabase(server.deps.sqlite, server.deps.paths.backupsDir, 'byok');
    expect(credentialHits(data, k)).toEqual([]);
    await server.close();
    closed = true;
    const out = join(tempDir(), 'snapshot');
    await snapshot({ data, out });
    expect(credentialHits(out, k)).toEqual([]);
    expect(credentialHits(parent, k)).toEqual([join(parent, 'secrets', 'anthropic.json')]);
    const canary = join(parent, 'injected-test-only');
    try {
      writeFileSync(canary, k);
      expect(credentialHits(parent, k)).toContain(canary);
    } finally {
      unlinkSync(canary);
    }
  } finally {
    if (!closed) await server.close();
  }
});

it('releases only a definitely unsent reservation after a crash', async () => {
  const f = await fixture(async () => response());
  writeSettings(f.sqlite, { 'llm.monthlyLimitMicroUsd': 30_000_000 });
  for (const id of ['before', 'after']) reserve(f.sqlite, id, API_MODELS.opus, 'g', 'message');
  markSent(f.sqlite, 'after');
  recoverReservations(f.sqlite);
  recoverReservations(f.sqlite);
  expect(f.sqlite.prepare('SELECT callId,status,held FROM api_charges ORDER BY callId').all()).toEqual([
    { callId: 'after', status: 'partial', held: worstCharge(API_MODELS.opus) },
    { callId: 'before', status: 'released', held: 0 },
  ]);
});
it('aborts an in-flight SDK call on key deletion and keeps its reservation', async () => {
  let dispatched!: () => void;
  const started = new Promise<void>((r) => {
    dispatched = r;
  });
  const fallback = {
    mode: 'cli' as const,
    health: new MockLlmAdapter().health,
    run() {
      throw Error('unexpected CLI call');
    },
  };
  const server = await startTestServer({
    env: 'prod',
    seed: true,
    llm: fallback,
    apiTransport: async (_url, init) => {
      dispatched();
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    },
  });
  try {
    server.deps.backends.provider.credentials.change(sentinel());
    writeSettings(server.deps.sqlite, { 'llm.backend': 'api', 'llm.monthlyLimitMicroUsd': 20_000_000 });
    const request = server.req('/api/papers/' + SEED_PAPER_ID + '/threads', {
      method: 'POST',
      headers: { 'X-SP-Token': server.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'explain', text: 'We estimate the robot pose', clientRequestId: randomUUID() }),
    });
    await started;
    server.deps.backends.provider.credentials.change(null);
    const result = await request;
    expect(sseEvents(result.text).at(-1)).toMatchObject({ event: 'run.error', data: { code: 'cancelled' } });
    expect(monthUsage(server.deps.sqlite)).toMatchObject({ apiCalls: 1, heldMicroUsd: worstCharge(API_MODELS.opus) });
  } finally {
    await server.close();
  }
});

it('a protected offline installation releases a refused SDK reservation without calling the wire transport', async () => {
  const f = await fixture(async () => response());
  writeSettings(f.sqlite, { 'llm.monthlyLimitMicroUsd': 20_000_000 });
  const downstream = vi.fn(async () => {
    throw Error('unexpected transport');
  });
  vi.stubGlobal('fetch', downstream);
  vi.stubEnv('SP_NETWORK', 'off');
  try {
    const normalProvider = new ApiProvider(f.sqlite, f.secrets);
    const events = await collect(normalProvider.adapter(f.secrets.status().generation, API_MODELS.opus).run(request('refused')));
    expect(events.at(-1)).toMatchObject({ type: 'error' });
    expect(downstream).not.toHaveBeenCalled();
    expect(monthUsage(f.sqlite)).toMatchObject({ heldMicroUsd: 0, spentMicroUsd: 0, apiCalls: 0 });
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

it('upgrades a populated M2 database and verifies the backup retains its original history', async () => {
  const root = tempDir(),
    folder = join(root, 'm2');
  cpSync(DEFAULT_MIGRATIONS_FOLDER, folder, { recursive: true });
  const jp = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(jp, 'utf8'));
  journal.entries = journal.entries.slice(0, 3);
  writeFileSync(jp, JSON.stringify(journal));
  const db = openSqlite(join(root, 'study.sqlite'));
  open.push(db);
  const backupsDir = join(root, 'backups');
  await migrateWithBackup(db, { backupsDir, migrationsFolder: folder });
  db.prepare(
    "INSERT INTO llm_calls(runId,task,model,effort,status,acceptedAt,inputTokens) VALUES('past','chat','fable','low','ok',1,500)",
  ).run();
  const before = db.prepare('SELECT hash FROM __drizzle_migrations ORDER BY created_at').all();
  const migrated = await migrateWithBackup(db, { backupsDir });
  expect(migrated.applied).toEqual(['0003_api', '0004_study_path']);
  expect(db.prepare('SELECT model,inputTokens,backend,executionMode FROM llm_calls WHERE runId=?').get('past')).toEqual({
    model: 'fable',
    inputTokens: 500,
    backend: null,
    executionMode: 'legacy_unknown',
  });
  expect(monthUsage(db)).toEqual({ spentMicroUsd: 0, heldMicroUsd: 0, checks: 0, apiCalls: 0 });
  const saved = openSqlite(migrated.backupPath!, { readonly: true });
  open.push(saved);
  expect(saved.prepare('SELECT hash FROM __drizzle_migrations ORDER BY created_at').all()).toEqual(before);
  expect(saved.prepare('SELECT count(*) AS n FROM llm_calls WHERE model=?').get('fable')).toEqual({ n: 1 });
  expect((await migrateWithBackup(db, { backupsDir })).applied).toEqual([]);
});

it('repairs through a second paid request on the accepted backend, generation, model and price, despite a settings change', async () => {
  const bodies: Record<string, unknown>[] = [];
  const fallback = {
    mode: 'cli' as const,
    health: new MockLlmAdapter().health,
    run() {
      throw Error('unexpected subscription dispatch');
    },
  };
  const server = await startTestServer({
    env: 'prod',
    seed: true,
    llm: fallback,
    apiTransport: async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      if (bodies.length === 1) writeSettings(server.deps.sqlite, { 'llm.backend': 'subscription', 'llm.economy': true });
      const text =
        bodies.length === 1
          ? readMockFile(readMockManifest().m2.blocksInvalid.notation_missing_key!.file)
          : readMockOutput('notation_card');
      return response('end_turn', true, API_MODELS.opus, text);
    },
  });
  try {
    server.deps.backends.provider.credentials.change(sentinel());
    writeSettings(server.deps.sqlite, { 'llm.backend': 'api', 'llm.monthlyLimitMicroUsd': 20_000_000 });
    const result = await server.req('/api/papers/' + SEED_PAPER_ID + '/cards/notation/generate', {
      method: 'POST',
      headers: { 'X-SP-Token': server.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientRequestId: randomUUID() }),
    });
    const events = sseEvents(result.text);
    expect(events.filter((e) => e.event === 'run.retrying')).toHaveLength(1);
    expect(events.at(-1)?.event).toBe('run.done');
    expect(bodies.map((b) => b.model)).toEqual([API_MODELS.opus, API_MODELS.opus]);
    const calls = server.deps.sqlite
      .prepare(
        "SELECT backend,executionMode,credentialGeneration,requestedModel,effort,priceVersion FROM llm_calls WHERE executionMode='api'",
      )
      .all();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(monthUsage(server.deps.sqlite)).toMatchObject({ apiCalls: 2, spentMicroUsd: 484, heldMicroUsd: 0 });
  } finally {
    await server.close();
  }
});

it('manually generates a study path through the SDK transport on Opus, persists it, and charges only once on replay', async () => {
  const lesson = readMockOutput('study_path');
  const bodies: Record<string, unknown>[] = [];
  const fallback = {
    mode: 'cli' as const,
    health: new MockLlmAdapter().health,
    run() { throw new Error('unexpected subscription dispatch'); },
  };
  let server = await startTestServer({
    env: 'prod', papers: ['m2'], llm: fallback,
    apiTransport: async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return response('end_turn', true, API_MODELS.opus, lesson);
    },
  });
  const paper = '/api/papers/' + SEED_M2_PAPER_ID + '/study-path';
  const call = (method: string, suffix: string, body?: unknown) => server.req(paper + suffix, {
    method, headers: { 'X-SP-Token': server.token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    server.deps.backends.provider.credentials.change(sentinel());
    writeSettings(server.deps.sqlite, { 'llm.backend': 'api', 'llm.economy': true, 'llm.monthlyLimitMicroUsd': 20_000_000 });
    expect(JSON.parse((await call('GET', '')).text)).toEqual({ result: null, pending: null });
    expect(bodies).toHaveLength(0);
    const body = { clientRequestId: randomUUID() };
    const events = sseEvents((await call('POST', '/generate', body)).text);
    const accepted = events[0];
    if (accepted?.event !== 'run.accepted') throw new Error('expected accepted');
    expect(events.at(-1)?.event).toBe('run.done');
    const { runId } = accepted.data;
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ model: API_MODELS.opus, stream: true, thinking: { type: 'adaptive' } });
    expect(monthUsage(server.deps.sqlite)).toMatchObject({ heldMicroUsd: 0, spentMicroUsd: 242, apiCalls: 1 });
    expect((await call('PATCH', '/check', { runId, index: 0, checked: true })).status).toBe(200);
    server = await server.restart();
    const stored = JSON.parse((await call('GET', '')).text);
    expect(stored).toMatchObject({ result: { runId, text: lesson, codeLanguage: 'cpp17' }, pending: null });
    expect(stored.result.checked[0]).toBe(true);
    expect(stored.result.citations).toEqual([
      expect.objectContaining({ kind: 'quote', status: 'verbatim' }),
      expect.objectContaining({ kind: 'equation', status: 'resolved' }),
    ]);
    expect(JSON.stringify(bodies[0])).toContain('A synthetic reference');
    const replay = sseEvents((await call('POST', '/generate', body)).text);
    expect(replay.at(-1)).toMatchObject({ event: 'run.done', data: { text: lesson, citations: stored.result.citations } });
    expect((await call('POST', '/generate', { clientRequestId: randomUUID() })).status).toBe(409);
    expect(bodies).toHaveLength(1);
  } finally { await server.close(); }
});
