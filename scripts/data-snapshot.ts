// Data-set snapshot / verify / restore / compare (PLAN_M2 7절 6, D24; BRIEF_INTEGRATION I6). Owner: supervisor.
// The coordinator's cutover and rollback use these command names; the body is scripts/lib/dataSnapshot.ts.
//
//   snapshot --data <dataDir> --out <snapDir>                       (--out is the snapshot directory itself)
//   verify   --snapshot <snapDir> [--seal] [--report <dir>]         (result on stdout)
//   restore  --snapshot <snapDir> --data <dataDir> [--report <dir>] (result on stdout)
//   compare  --snapshot <snapDir> --data <dataDir> --out <dir>      (<out>/compare.json)
//
// stdout: one JSON object. Exit: 0 ok · 1 check failed · 2 usage / precondition (nothing changed) · 130 / 143 SIGINT /
// SIGTERM. A path under ~/.local/share/study_paper* is refused without SP_SNAPSHOT_ALLOW_REAL=1.
// verify / restore --report <dir>: <dir>/verify.json / restore.json is the stdout object (exit and `signal` included)
// whenever the command ran — finished, failed a check, stopped by a signal or another error; a usage / precondition
// error (exit 2) writes none (a report file already there is left as it was). <dir> is made and checked writable before
// the command runs: one that cannot be written is a precondition error (exit 2, nothing changed — a directory made for
// it is removed again), so restore's exit 1 still means "live unchanged". Only a report that fails at the very end
// (<dir> changed while the command ran) gives exit 1 with `reportError` — for restore after the replacement (`aside`).
//
// Run it as `node --import tsx scripts/data-snapshot.ts …` or `npm run data:snapshot -- …` (the same, through `exec`
// so that npm's sh is not left in between: a signal sent to npm reaches this process), not through the tsx CLI
// (`npx tsx …`): that wrapper SIGKILLs a child that does not answer a signal within about 60 ms — inside a long
// synchronous step this one cannot — and then no cleanup runs.
// Signals: the long steps are synchronous, so a SIGINT / SIGTERM that comes during one is handled when that stretch ends
// (the next checkpoint between steps): the command stops there, its temp DB copy (sp-snapdb-*), .partial-* or restore
// staging is removed, the lock released, and the exit is 130 / 143 with `signal` in the JSON. restore does not stop
// after rename 1 (live → aside): both renames finish first. A signal after a command's last checkpoint lets it finish;
// the exit is still 130 / 143 (the JSON shows the finished result).
import { accessSync, constants, lstatSync, mkdirSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { assertNotRealDataDir, compare, installSignalCleanup, isInside, receivedSignal, refuseLinkArg, restore, settleSignals, snapshot, SnapshotCheckError, SnapshotInterrupted, SnapshotUsageError, verify } from './lib/dataSnapshot';

// SIGINT / SIGTERM are recorded; the command stops at its next checkpoint (cleanup in its finally blocks), exit 130 / 143
installSignalCleanup();

const COMMANDS: Record<string, { required: string[]; optional: string[]; flags: string[] }> = {
  snapshot: { required: ['--data', '--out'], optional: [], flags: [] },
  verify: { required: ['--snapshot'], optional: ['--report'], flags: ['--seal'] },
  restore: { required: ['--snapshot', '--data'], optional: ['--report'], flags: [] },
  compare: { required: ['--snapshot', '--data', '--out'], optional: [], flags: [] },
};
const USAGE = Object.entries(COMMANDS)
  .map(([c, s]) => `  ${c} ${s.required.map((r) => `${r} <dir>`).join(' ')}${s.flags.map((f) => ` [${f}]`).join('')}${s.optional.map((x) => ` [${x} <dir>]`).join('')}`)
  .join('\n');

/** verify / restore --report: set once the arguments are accepted; emit writes the final object there. */
let report: { dir: string; name: string } | null = null;
/**
 * Prints the result and exits — with 130 / 143 (and `signal`) whenever a SIGINT / SIGTERM was received. The --report
 * file gets the same object (so it never shows an exit the process did not end with, nor is a stale one left behind
 * by a command that ran). Not for exit 2 (usage / precondition, `toReport` false): nothing ran, and a report file
 * already in the --report directory is left as it was.
 */
function emit(obj: Record<string, unknown>, code: number, toReport = true): never {
  const sig = receivedSignal();
  let [o, c] = sig === null ? [obj, code] : [{ ...obj, exitCode: sig === 'SIGINT' ? 130 : 143, signal: sig }, sig === 'SIGINT' ? 130 : 143];
  if (toReport && report !== null) {
    try {
      writeReport(report.dir, report.name, o);
    } catch (e) {
      // only when <dir> changed during the run (checked before it): the result stands on stdout (for restore: the
      // replacement is done, see `aside`); a missing report is a failure of the command (unless a signal decided it)
      process.stderr.write(`data-snapshot: --report not written: ${(e as Error).message}\n`);
      if (sig === null) c = 1;
      o = { ...o, ok: false, exitCode: c, reportError: (e as Error).message };
    }
  }
  process.stdout.write(`${JSON.stringify(o)}\n`);
  process.exit(c);
}
/** Directories the --report check made (deepest first); removed again on exit 2 so that a refusal changes nothing. */
const madeReportDirs: string[] = [];
/** Usage / precondition errors (exit 2) write no report and leave one already there as it was: nothing was run. */
function usage(msg: string, command?: string): never {
  for (const d of madeReportDirs) {
    try {
      rmdirSync(d); // empty: nothing has been written into it
    } catch {
      break;
    }
  }
  process.stderr.write(`data-snapshot: ${msg}\nusage:\n${USAGE}\n`);
  emit({ command: command ?? null, ok: false, exitCode: 2, error: msg }, 2, false);
}

const [command, ...rest] = process.argv.slice(2);
const spec = command ? COMMANDS[command] : undefined;
if (!command || !spec) usage(command ? `unknown command ${command}` : 'a command is required');
const opts: Record<string, string> = {};
const flags = new Set<string>();
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]!;
  if (spec.flags.includes(a)) flags.add(a);
  else if (spec.required.includes(a) || spec.optional.includes(a)) {
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) usage(`${a} needs a value`, command);
    if (a in opts) usage(`${a} given twice`, command);
    opts[a] = v;
    i++;
  } else usage(`unknown argument ${a}`, command);
}
for (const r of spec.required) if (!(r in opts)) usage(`${r} is required`, command);

/**
 * --report <dir>: never inside (or containing) the snapshot or the data directory — by real path too — and not a link.
 * Made and checked before the command runs (a directory, writable; <dir>/<name>, if there, a writable regular file):
 * otherwise a precondition error (exit 2).
 */
function reportDir(name: string): string | null {
  const r = opts['--report'];
  if (r === undefined) return null;
  const abs = resolve(r);
  for (const k of ['--snapshot', '--data']) if (opts[k] !== undefined && (isInside(opts[k]!, abs) || isInside(abs, opts[k]!))) usage(`--report must not be inside (or contain) ${k}`, command);
  assertNotRealDataDir('--report', abs);
  try {
    refuseLinkArg('--report', abs);
  } catch (e) {
    usage((e as Error).message, command);
  }
  try {
    const first = mkdirSync(abs, { recursive: true });
    if (first !== undefined) for (let d = abs; ; d = dirname(d)) {
      madeReportDirs.push(d);
      if (d === first || d === dirname(d)) break;
    }
    accessSync(abs, constants.W_OK | constants.X_OK);
    const f = join(abs, name);
    let st;
    try {
      st = lstatSync(f);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (st !== undefined) {
      if (!st.isFile()) throw new Error(`${f} exists and is not a regular file`);
      accessSync(f, constants.W_OK);
    }
  } catch (e) {
    usage(`--report ${abs} cannot be written: ${(e as Error).message}`, command);
  }
  return abs;
}
function writeReport(dir: string, name: string, obj: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${JSON.stringify(obj, null, 2)}\n`);
}

try {
  if (command === 'snapshot') {
    const r = await snapshot({ data: opts['--data']!, out: opts['--out']! });
    await settleSignals();
    emit({ command, ok: true, exitCode: 0, ...r }, 0);
  } else if (command === 'verify') {
    const rep = reportDir('verify.json');
    if (rep !== null) report = { dir: rep, name: 'verify.json' };
    const r = await verify({ snapshot: opts['--snapshot']!, seal: flags.has('--seal') });
    await settleSignals();
    emit({ command, exitCode: 0, ...r }, 0);
  } else if (command === 'restore') {
    const rep = reportDir('restore.json');
    if (rep !== null) report = { dir: rep, name: 'restore.json' };
    const r = await restore({ snapshot: opts['--snapshot']!, data: opts['--data']! });
    await settleSignals(); // a signal after rename 1 (the stretch that just ended) gives 130 / 143
    emit({ command, exitCode: 0, ...r }, 0);
  } else {
    const out = resolve(opts['--out']!);
    for (const k of ['--snapshot', '--data']) if (isInside(opts[k]!, out) || isInside(out, opts[k]!)) usage(`--out must not be inside (or contain) ${k}`, command);
    assertNotRealDataDir('--out', out);
    refuseLinkArg('--out', out);
    const r = await compare({ snapshot: opts['--snapshot']!, data: opts['--data']! });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'compare.json'), `${JSON.stringify({ command, ...r }, null, 2)}\n`);
    const brief = {
      command,
      ok: r.ok,
      exitCode: r.ok ? 0 : 1,
      out: join(out, 'compare.json'),
      tables: Object.fromEntries(r.tables.map((t) => [t.table, { equal: t.equal, count: t.count, onlyInSnapshot: t.onlyInA, onlyInData: t.onlyInB, changed: t.changed }])),
      pdf: { papers: r.pdf.papers, ok: r.pdf.ok },
    };
    await settleSignals();
    emit(brief, r.ok ? 0 : 1);
  }
} catch (e) {
  await settleSignals();
  if (e instanceof SnapshotInterrupted) {
    process.stderr.write(`data-snapshot: ${e.message}; stopped before finishing, temporary files removed\n`);
    emit({ command, ok: false, exitCode: e.exitCode, signal: e.signal, error: e.message }, e.exitCode);
  }
  if (e instanceof SnapshotUsageError) usage(e.message, command); // no report (as for the argument checks)
  if (e instanceof SnapshotCheckError) {
    process.stderr.write(`data-snapshot: ${e.message}\n`);
    emit({ command, ok: false, exitCode: 1, error: e.message, ...e.result }, 1);
  }
  process.stderr.write(`data-snapshot: ${(e as Error).stack ?? String(e)}\n`);
  emit({ command, ok: false, exitCode: 1, error: (e as Error).message }, 1);
}
