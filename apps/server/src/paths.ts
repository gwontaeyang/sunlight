// App data layout (PLAN 2.1). The data dir and its sub-directories are 0700 on POSIX; on win32 the root is restricted
// with an ACL (best-effort) and its children inherit it.
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isWindows } from './security/platform';
import { restrictDirToCurrentUser } from './security/winAcl';

export interface DataPaths {
  root: string;
  dbDir: string;
  dbFile: string;
  backupsDir: string;
  papersDir: string;
  tmpDir: string;
  claudeCwd: string;
  fixturesDir: string;
  runDir: string;
  /** Informational pid of the running server (written after bind). The exclusive lock is lockFile. */
  pidFile: string;
  /** Exclusive data-directory lock (instanceLock.ts), held by the server or by db:restore. */
  lockFile: string;
  paperDir(paperId: string): string;
  /** supplement file of a version (PLAN_M2 D1): 1 → supplement.txt, n ≥ 2 → supplement.v<n>.txt. */
  supplementFile(paperId: string, version: number): string;
  /** source.html (LaTeXML) of a paper. */
  sourceHtmlFile(paperId: string): string;
  /** papers/<id>/captures — created non-recursively by captures.ts only. */
  capturesDir(paperId: string): string;
  /** papers/<id>/captures/<fileId>.png (fileId = files.id). */
  captureFile(paperId: string, fileId: string): string;
}

const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/;

export function dataPaths(root: string): DataPaths {
  return {
    root,
    dbDir: join(root, 'db'),
    dbFile: join(root, 'db', 'study_paper.sqlite'),
    backupsDir: join(root, 'backups'),
    papersDir: join(root, 'papers'),
    tmpDir: join(root, 'tmp'),
    claudeCwd: join(root, 'claude-cwd'),
    fixturesDir: join(root, 'fixtures'),
    runDir: join(root, 'run'),
    pidFile: join(root, 'run', 'server.pid'),
    lockFile: join(root, 'run', 'instance.lock'),
    paperDir,
    supplementFile: (paperId: string, version: number) => {
      if (!Number.isInteger(version) || version < 1) throw new Error(`invalid supplement version: ${version}`);
      return join(paperDir(paperId), version === 1 ? 'supplement.txt' : `supplement.v${version}.txt`);
    },
    sourceHtmlFile: (paperId: string) => join(paperDir(paperId), 'source.html'),
    capturesDir: (paperId: string) => join(paperDir(paperId), 'captures'),
    captureFile: (paperId: string, fileId: string) => {
      if (!SAFE_ID.test(fileId)) throw new Error(`invalid capture file id for a path: ${fileId}`);
      return join(paperDir(paperId), 'captures', `${fileId}.png`);
    },
  };
  function paperDir(paperId: string): string {
    if (!SAFE_ID.test(paperId)) throw new Error(`invalid paper id for a path: ${paperId}`);
    return join(root, 'papers', paperId);
  }
}

export function ensureDataDirs(p: DataPaths): void {
  // win32: restrict the root first (with (OI)(CI) inheritance) so the sub-directories created next inherit the ACL.
  if (isWindows()) {
    if (!existsSync(p.root)) mkdirSync(p.root, { recursive: true });
    restrictDirToCurrentUser(p.root);
  }
  for (const dir of [p.root, p.dbDir, p.backupsDir, p.papersDir, p.tmpDir, p.claudeCwd, p.runDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  chmodSync(p.root, 0o700); // POSIX: 0700; win32: keeps the root writable, no effect on the ACL set above
}
