// Temp dir cleanup of the test helpers (RC5-R1-02): a tree a test left sealed (read-only directories, as `verify --seal`
// makes them) is still removed after the test, one dir that cannot be removed does not keep the others, and a symlink in
// the tree is not followed. Owner: supervisor.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { removeTempDirs, removeTempTree, tempDir } from '../helpers/tmp';

/** dir/snap/{db/x.sqlite, papers/p/paper.pdf} with 0444 files and 0555 directories (what verify --seal leaves). */
function sealedTree(dir: string): string {
  const snap = join(dir, 'snap');
  mkdirSync(join(snap, 'db'), { recursive: true });
  mkdirSync(join(snap, 'papers', 'p'), { recursive: true });
  writeFileSync(join(snap, 'db', 'x.sqlite'), 'x');
  writeFileSync(join(snap, 'papers', 'p', 'paper.pdf'), 'p');
  for (const f of ['db/x.sqlite', 'papers/p/paper.pdf']) chmodSync(join(snap, f), 0o444);
  for (const d of ['db', 'papers/p', 'papers', '']) chmodSync(join(snap, d), 0o555);
  return snap;
}

// made outside the helper (so the helper never removes it); a symlink in a sealed tree points here
const OUTSIDE = mkdtempSync(join(tmpdir(), 'sp-tmpclean-outside-'));
afterAll(() => {
  chmodSync(OUTSIDE, 0o700);
  rmSync(OUTSIDE, { recursive: true, force: true });
});

describe('removeTempTree', () => {
  it('removes a sealed tree (plain rmSync gives EACCES on it) without following a symlink in it', () => {
    const d = mkdtempSync(join(tmpdir(), 'sp-tmpclean-'));
    const snap = sealedTree(d);
    chmodSync(snap, 0o755);
    symlinkSync(OUTSIDE, join(snap, 'link'));
    chmodSync(snap, 0o555);
    chmodSync(OUTSIDE, 0o500);
    expect(() => rmSync(d, { recursive: true, force: true })).toThrow(/EACCES/);
    removeTempTree(d);
    expect(existsSync(d)).toBe(false);
    expect(existsSync(OUTSIDE)).toBe(true);
    expect(statSync(OUTSIDE).mode & 0o777).toBe(0o500);
  });

  it('a missing dir is no error', () => {
    expect(() => removeTempTree(join(tmpdir(), 'sp-tmpclean-never-made'))).not.toThrow();
  });
});

describe('removeTempDirs', () => {
  it('goes on past a dir that fails and then throws its error', () => {
    const a = mkdtempSync(join(tmpdir(), 'sp-tmpclean-a-'));
    const b = mkdtempSync(join(tmpdir(), 'sp-tmpclean-b-'));
    const boom = new Error('cannot remove a');
    const remove = (dir: string) => {
      if (dir === a) throw boom;
      removeTempTree(dir);
    };
    expect(() => removeTempDirs([a, b], remove)).toThrow(boom);
    expect(existsSync(b)).toBe(false);
    expect(existsSync(a)).toBe(true);
    removeTempTree(a);
  });

  it('two failures → one AggregateError with both', () => {
    let thrown: unknown;
    try {
      removeTempDirs(['x', 'y'], (d) => {
        throw new Error(`no ${d}`);
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors.map((e: Error) => e.message)).toEqual(['no x', 'no y']);
  });
});

describe('the per-test hook', () => {
  // the two tests run in order: the first leaves a sealed tree and a second dir, the second checks both are gone
  const left: string[] = [];
  it('a test leaves a sealed tree in tempDir() and one more tempDir()', () => {
    const first = tempDir('sp-tmpclean-hook-');
    sealedTree(first);
    left.push(first, tempDir('sp-tmpclean-hook-'));
  });
  it('after that test both dirs are gone', () => {
    expect(left).toHaveLength(2);
    expect(left.filter((d) => existsSync(d))).toEqual([]);
  });
});
