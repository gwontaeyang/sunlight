// scripts/lib/rehearsalChecks.ts (BRIEF_INTEGRATION I7): the pure checks that decide the real-data rehearsal.
// Owner: supervisor.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertNotRealDataDir, refuseRealDataDir } from '../../../../scripts/lib/dataSnapshot';
import { REPO_ROOT, runProbe } from '../helpers/proc';
import { diffPaperRow, diffShaListings, equationCitationStatus, jobStreamShape, M1_LOG_ALLOWED, parseServerLog, parseShaListing, restoreAsideChecks, runStreamShape, serverLogPrecondition, statsPremise, unexpectedLogLines } from '../../../../scripts/lib/rehearsalChecks';

const row = { id: 'p1', supplementSha256: 'a', supplementVersion: 1, structureSource: 'none', updatedAt: 1, codeUrl: null as string | null, ingestWarningsJson: '["x"]', ingestStatus: 'done', readableAt: 5, title: 't' };

describe('diffPaperRow (PLAN_M2 D4)', () => {
  it('accepts the upgrade columns, codeUrl from NULL and appended warnings', () => {
    const r = diffPaperRow(row, { ...row, supplementSha256: 'b', supplementVersion: 2, structureSource: 'latexml', updatedAt: 2, codeUrl: 'https://x', ingestWarningsJson: '["x","supplement_truncated"]', newColumn: 1 });
    expect(r).toEqual({ ok: true, changed: ['supplementSha256', 'supplementVersion', 'structureSource', 'updatedAt', 'codeUrl', 'ingestWarningsJson'], violations: [] });
  });
  it('refuses any other column, a codeUrl that was set, a warning list that is not an append, a missing column', () => {
    expect(diffPaperRow(row, { ...row, readableAt: 6 }).violations).toEqual(['readableAt: not an upgrade column (D4)']);
    expect(diffPaperRow(row, { ...row, ingestStatus: 'running' }).ok).toBe(false);
    expect(diffPaperRow({ ...row, codeUrl: 'https://a' }, { ...row, codeUrl: 'https://b' }).violations).toEqual(['codeUrl: changed although it was set before']);
    expect(diffPaperRow(row, { ...row, ingestWarningsJson: '["y","x"]' }).ok).toBe(false);
    expect(diffPaperRow(row, { ...row, ingestWarningsJson: '[]' }).ok).toBe(false);
    expect(diffPaperRow(row, { ...row, ingestWarningsJson: 'nope' }).ok).toBe(false);
    const { title: _t, ...noTitle } = row;
    expect(diffPaperRow(row, noTitle).violations).toEqual(['title: column missing after']);
  });
});

describe('statsPremise (PLAN_M2 3.4 rule 2)', () => {
  it('holds when resolved + noAnchor is 0 everywhere; names the violating and unparseable messages', () => {
    const ok = statsPremise([
      { id: 'm1', statsJson: null },
      { id: 'm2', statsJson: JSON.stringify({ eqRefs: { resolved: 0, noAnchor: 0, unindexed: 3 } }) },
      { id: 'm3', statsJson: JSON.stringify({ quotes: {} }) },
    ]);
    expect(ok).toMatchObject({ messagesWithStats: 2, withEqRefs: 1, resolvedPlusNoAnchor: 0, holds: true, eqRefTotals: { resolved: 0, noAnchor: 0, unindexed: 3 } });
    const bad = statsPremise([
      { id: 'm4', statsJson: JSON.stringify({ eqRefs: { resolved: 1, noAnchor: 0 } }) },
      { id: 'm5', statsJson: JSON.stringify({ eqRefs: { resolved: 0, noAnchor: 2 } }) },
      { id: 'm6', statsJson: '{' },
    ]);
    expect(bad).toMatchObject({ holds: false, resolvedPlusNoAnchor: 3, violatingMessageIds: ['m4', 'm5'], unparseableMessageIds: ['m6'] });
  });
});

describe('equationCitationStatus', () => {
  it('counts by status and lists the messages behind not_found', () => {
    expect(
      equationCitationStatus([
        { status: 'unindexed', ownerType: 'message', ownerId: 'a' },
        { status: 'not_found', ownerType: 'message', ownerId: 'b' },
        { status: 'not_found', ownerType: 'message', ownerId: 'b' },
        { status: 'not_found', ownerType: 'paper_card_item', ownerId: 'c' },
      ]),
    ).toEqual({ byStatus: { unindexed: 1, not_found: 3 }, total: 4, notFound: { count: 3, messageIds: ['b'] } });
  });
});

describe('stream shapes', () => {
  it('job: exactly one terminal and last', () => {
    expect(jobStreamShape(['job.step', 'job.done']).ok).toBe(true);
    expect(jobStreamShape(['job.step']).ok).toBe(false);
    expect(jobStreamShape(['job.done', 'job.step']).ok).toBe(false);
    expect(jobStreamShape(['job.error', 'job.done']).ok).toBe(false);
  });
  it('run: run.accepted first, exactly one terminal and last', () => {
    expect(runStreamShape(['run.accepted', 'run.delta', 'run.done']).ok).toBe(true);
    expect(runStreamShape(['run.delta', 'run.done']).ok).toBe(false);
    expect(runStreamShape(['run.accepted', 'run.done', 'run.error']).ok).toBe(false);
    expect(runStreamShape(['run.accepted', 'run.done', 'run.delta']).ok).toBe(false);
  });
});

describe('sha256sum listings', () => {
  const h = (c: string) => c.repeat(64);
  it('parses and diffs by path', () => {
    const a = parseShaListing(`${h('a')}  ./db/x\n${h('b')}  ./papers/p/paper.pdf\n`);
    expect(diffShaListings(a, a).equal).toBe(true);
    const b = parseShaListing(`${h('a')}  ./db/x\n${h('c')}  ./papers/p/paper.pdf\n${h('d')}  ./new\n`);
    expect(diffShaListings(a, b)).toEqual({ equal: false, onlyBefore: [], onlyAfter: ['./new'], changed: ['./papers/p/paper.pdf'] });
    expect(() => parseShaListing('nope')).toThrow();
  });
});

describe('server logs (BRIEF_INTEGRATION I7-1)', () => {
  const D = '/w/.data/m2-rehearsal/fwd/data';
  const m2Log = [
    `[study_paper] migrations applied: 0002_m2 (backup ${D}/backups/study_paper.0002_m2.1.sqlite)`,
    `[study_paper] listening on http://127.0.0.1:4580 (env=dev, llm=mock, network=off, data=${D})`,
    '[study_paper] SIGINT: shutting down',
    '',
  ].join('\n');
  const m1Log = `[study_paper] listening on http://127.0.0.1:4580 (env=dev, llm=mock, data=${D})\n[study_paper] SIGINT: shutting down\n`;
  const m2Want = { env: 'dev', llm: 'mock', network: 'off', data: D, migrations: ['0002_m2'], backup: true } as const;
  const m1Want = { env: 'dev', llm: 'mock', network: null, data: D, migrations: [], backup: false } as const;

  it('parses the listening line and the migrations line', () => {
    expect(parseServerLog(m2Log)).toEqual({ listeningLines: 1, listening: `listening on http://127.0.0.1:4580 (env=dev, llm=mock, network=off, data=${D})`, env: 'dev', llm: 'mock', network: 'off', data: D, migrations: ['0002_m2'], backupLines: 1, ingestLines: 0, errorLikeLines: 0, networkOn: false });
    expect(parseServerLog(m1Log)).toMatchObject({ listeningLines: 1, network: null, data: D, migrations: [] });
    expect(parseServerLog('')).toMatchObject({ listeningLines: 0, listening: null, env: null, data: null });
  });

  it('precondition: empty for the right server, names every difference otherwise', () => {
    expect(serverLogPrecondition(parseServerLog(m2Log), m2Want)).toEqual([]);
    expect(serverLogPrecondition(parseServerLog(m1Log), m1Want)).toEqual([]);
    expect(serverLogPrecondition(parseServerLog(''), m2Want)).toHaveLength(7);
    expect(serverLogPrecondition(parseServerLog(m2Log.replace('network=off', 'network=on')), m2Want)).toEqual(['network=on (want off)', 'network=on in the log']);
    expect(serverLogPrecondition(parseServerLog(m2Log.replace('llm=mock', 'llm=cli').replace('env=dev', 'env=prod')), m2Want)).toEqual(['env=prod (want dev)', 'llm=cli (want mock)']);
    expect(serverLogPrecondition(parseServerLog(m2Log.replace(`data=${D}`, 'data=/home/u/.local/share/study_paper')), m2Want)).toEqual([`data=/home/u/.local/share/study_paper (want ${D})`]);
    expect(serverLogPrecondition(parseServerLog(m2Log.split('\n').slice(1).join('\n')), m2Want)).toEqual(['migrations applied [] (want ["0002_m2"])', 'migration backup lines 0 (want 1)']);
    expect(serverLogPrecondition(parseServerLog(`${m2Log}${m2Log}`), m2Want)[0]).toBe('listening lines 2 (want 1)');
    // an m2 server where m1 was meant: network field present and 0002 applied
    expect(serverLogPrecondition(parseServerLog(m2Log), m1Want)).toEqual(['network=off (want no network field (m1))', 'migrations applied ["0002_m2"] (want [])']);
  });

  it('m1 log allow-list: only the listening line and the shutdown line; error-like lines are counted broadly', () => {
    expect(unexpectedLogLines(m1Log, M1_LOG_ALLOWED)).toEqual({ count: 0, tags: [] });
    const noisy = [
      m1Log.trim(),
      '[study_paper] startup recovery {"jobs":1}',
      'SqliteError: no such column: x',
      'TypeError: cannot read',
      '[study_paper] ERROR migration',
      '[study_paper] backup failed',
      '    at Object.<anonymous> (/x.ts:1:1)',
      '[ingest] job j1: terminal write failed: busy',
      '[study_paper] drain runs: ok (1 → 0 active, 5 ms)',
    ].join('\n');
    const u = unexpectedLogLines(noisy, M1_LOG_ALLOWED);
    expect(u.count).toBe(8);
    expect(u.tags).toEqual(['[study_paper] startup recovery', 'SqliteError', 'TypeError', '[study_paper] ERROR migration', '[study_paper] backup failed', 'at Object', '[ingest] job j', '[study_paper] drain runs']);
    const f = parseServerLog(noisy);
    expect(f.errorLikeLines).toBe(6);
    expect(f.ingestLines).toBe(1);
    // the allow-list itself refuses a listening line of another mode or host
    expect(unexpectedLogLines(m1Log.replace('llm=mock', 'llm=cli'), M1_LOG_ALLOWED).count).toBe(1);
    expect(unexpectedLogLines(m1Log.replace('127.0.0.1', '0.0.0.0'), M1_LOG_ALLOWED).count).toBe(1);
  });
});

describe('restoreAsideChecks (BRIEF_INTEGRATION I7-3 3)', () => {
  const data = '/r/rb/data';
  const snapshot = '/r/rb/pre-m2';
  const aside = '/r/rb/data-m2-aside-1794860975194';
  const mutate = { addedPaperId: 'add', keptPaperId: 'keep', deletedPaperId: 'del', captureFileId: 'cap', capturePngSha256: 'f'.repeat(64) };
  const dirs = new Set([aside, `${aside}/papers/add`, `${aside}/papers/keep`, `${aside}/papers/keep/captures`]);
  const files = new Map([[`${aside}/db/study_paper.sqlite`, 'a'.repeat(64)], [`${aside}/papers/keep/captures/cap.png`, 'f'.repeat(64)]]);
  const fsFake = (d: Set<string>, f: Map<string, string>) => ({ isDir: (p: string) => d.has(p), isFile: (p: string) => f.has(p), sha256: (p: string) => f.get(p) ?? null });
  const base = { restoreExit: 0, restore: { ok: true, exitCode: 0, data, snapshot, aside, staging: '/r/rb/data.restore-1' }, data, snapshot, mutate, siblings: ['data', 'pre-m2', 'data-m2-aside-1794860975194', 'server.log'], fs: fsFake(dirs, files) };
  const failed = (i: Parameters<typeof restoreAsideChecks>[0]) => restoreAsideChecks(i).filter((c) => !c.pass).map((c) => c.id);

  it('passes when the aside holds the added paper and the capture and not the deleted paper', () => {
    const r = restoreAsideChecks(base);
    expect(r).toHaveLength(9);
    expect(failed(base)).toEqual([]);
  });
  it('fails on a restore that did not succeed, a missing or misplaced aside, and staging left behind', () => {
    expect(failed({ ...base, restoreExit: 1 })).toEqual(['restore: exit 0 · ok · exitCode 0']);
    expect(failed({ ...base, restore: null })).toEqual(expect.arrayContaining(['restore: exit 0 · ok · exitCode 0', 'aside: <data>-m2-aside-<epoch> next to the data directory, exists']));
    expect(failed({ ...base, restore: { ...base.restore, aside: '/elsewhere/data-m2-aside-1' } })).toEqual(['aside: <data>-m2-aside-<epoch> next to the data directory, exists']);
    expect(failed({ ...base, restore: { ...base.restore, aside: '/r/rb/data-m2-aside-x' } })).toEqual(['aside: <data>-m2-aside-<epoch> next to the data directory, exists']);
    expect(failed({ ...base, siblings: [...base.siblings, 'data.restore-9'] })).toEqual(['no <data>.restore-* staging left']);
    expect(failed({ ...base, restore: { ...base.restore, data: '/r/fwd/data' } })).toEqual(['restore: --data and --snapshot are the rb copy and rb/pre-m2']);
  });
  it("fails when the aside lacks step 2's state or still has the deleted paper", () => {
    const d1 = new Set(dirs);
    d1.delete(`${aside}/papers/add`);
    expect(failed({ ...base, fs: fsFake(d1, files) })).toEqual(['aside: papers/<added paper>/ is there']);
    const f1 = new Map(files);
    f1.set(`${aside}/papers/keep/captures/cap.png`, '0'.repeat(64));
    expect(failed({ ...base, fs: fsFake(dirs, f1) })).toEqual(['aside: papers/<kept paper>/captures/<capture>.png is there with the request PNG bytes']);
    expect(failed({ ...base, fs: fsFake(new Set([...dirs, `${aside}/papers/del`]), files) })).toEqual(['aside: papers/<deleted paper>/ is not there (deleted under m2)']);
    const f2 = new Map(files);
    f2.delete(`${aside}/db/study_paper.sqlite`);
    expect(failed({ ...base, fs: fsFake(dirs, f2) })).toEqual(['aside: db/study_paper.sqlite (the M2 DB) is there']);
    expect(failed({ ...base, mutate: { ...mutate, captureFileId: undefined } })).toEqual(expect.arrayContaining(['mutate.json names the added, kept and deleted papers and the capture']));
  });
});

describe('scripts/rehearsal.ts refuses the real data directory unconditionally (M-M2-R2-3)', () => {
  it('an inherited SP_SNAPSHOT_ALLOW_REAL=1 does not lift it: exit 2 naming the real data directory, nothing read, no request, no output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sp-rehearsal-real-'));
    try {
      const home = join(root, 'home');
      const prot = join(home, '.local', 'share', 'study_paper-pre-m2'); // a protected sibling of the fake HOME
      mkdirSync(join(prot, 'rb', 'data', 'db'), { recursive: true });
      writeFileSync(join(prot, 'rb', 'data', 'db', 'study_paper.sqlite'), '');
      const log = join(prot, 'rb', 'm2.log');
      writeFileSync(log, 'not a server log\n', { mode: 0o000 }); // a read would fail differently (EACCES / log precondition)
      const out = join(prot, 'rb', 'out');
      // --base-url: the e2e attacker port, where nothing of this test listens; the guard must refuse before any request
      const r = await runProbe(join(REPO_ROOT, 'scripts', 'rehearsal.ts'), { HOME: home, XDG_DATA_HOME: undefined, SP_SNAPSHOT_ALLOW_REAL: '1' }, ['mutate', '--base-url', 'http://127.0.0.1:4569', '--data', join(prot, 'rb', 'data'), '--server-log', log, '--out', out]);
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toMatch(/--data .* is under the real data directory/);
      expect(r.stderr).not.toMatch(/server log|listening|EACCES|ECONNREFUSED/);
      expect(existsSync(out)).toBe(false);
      expect(readdirSync(join(prot, 'rb')).sort()).toEqual(['data', 'm2.log']);
      // the same refusal for an output path alone (inputs outside)
      const outside = join(root, 'scratch');
      mkdirSync(join(outside, 'snap', 'db'), { recursive: true });
      writeFileSync(join(outside, 'snap', 'db', 'study_paper.sqlite'), '');
      const p = await runProbe(join(REPO_ROOT, 'scripts', 'rehearsal.ts'), { HOME: home, XDG_DATA_HOME: undefined, SP_SNAPSHOT_ALLOW_REAL: '1' }, ['precheck', '--snapshot', join(outside, 'snap'), '--out', join(prot, 'precheck')]);
      expect(p.status, p.stderr).toBe(2);
      expect(p.stderr).toMatch(/--out .* is under the real data directory/);
      expect(existsSync(join(prot, 'precheck'))).toBe(false);
    } finally {
      chmodSync(join(root, 'home', '.local', 'share', 'study_paper-pre-m2', 'rb', 'm2.log'), 0o600);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('data:snapshot keeps its own switch: the shared judgement without it refuses, the policy with it passes', () => {
    const env = { HOME: '/home/u', SP_SNAPSHOT_ALLOW_REAL: '1' };
    expect(() => refuseRealDataDir('--data', '/home/u/.local/share/study_paper', env)).toThrow(/real data directory/);
    expect(() => assertNotRealDataDir('--data', '/home/u/.local/share/study_paper', env)).not.toThrow();
    expect(() => assertNotRealDataDir('--data', '/home/u/.local/share/study_paper', { HOME: '/home/u' })).toThrow(/without SP_SNAPSHOT_ALLOW_REAL=1/);
  });
});
