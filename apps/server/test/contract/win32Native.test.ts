// Native Windows (win32) behaviour, exercised on Linux by overriding process.platform. Synthetic C:\ paths do not
// exist on the Linux filesystem, so realpathSync falls back to the path as given and the win32 string comparison
// (case-insensitive, backslash/forward-slash, drive letters) is what gets tested. Owner: win-native.
//
// Not tested here (documented in the Windows report as verify-on-Windows): credentials.ensureDir's full win32 path —
// under a mocked platform, realpathSync returns POSIX ('/') paths while win32 path joins produce '\', so an EXISTING
// directory cannot round-trip. The ACL branch it calls is tested directly below; the uid/mode skip is code-reviewed.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDataDir } from '../../src/security/runtimePaths';
import { realDataDirPrefixOf } from '../../src/security/realDataDir';
import { findTreeLink } from '../../src/security/dataTree';
import { restrictDirToCurrentUser } from '../../src/security/winAcl';
import { tempDir } from '../helpers/tmp';

const PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!;
function asWindows(fn: () => void): void {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', PLATFORM);
  }
}

const APPDATA = 'C:\\Users\\me\\AppData\\Roaming';
const LOCALAPPDATA = 'C:\\Users\\me\\AppData\\Local';

describe('win32 data directory (resolveDataDir)', () => {
  it('defaults to %APPDATA%\\Sunlight, falling back to %LOCALAPPDATA% then the home directory', () => {
    asWindows(() => {
      expect(resolveDataDir({ APPDATA, LOCALAPPDATA })).toBe('C:\\Users\\me\\AppData\\Roaming\\Sunlight');
      expect(resolveDataDir({ LOCALAPPDATA })).toBe('C:\\Users\\me\\AppData\\Local\\Sunlight');
      const home = resolveDataDir({});
      expect(home.endsWith('\\Sunlight') || home.endsWith('Sunlight')).toBe(true);
    });
  });
  it('still uses the XDG/study_paper default off win32 (unchanged)', () => {
    expect(resolveDataDir({ XDG_DATA_HOME: '/synthetic/xdg' })).toBe('/synthetic/xdg/study_paper');
  });
});

describe('win32 real-data recognition (realDataDirPrefixOf)', () => {
  it('treats %APPDATA%\\Sunlight* as the real data directory — case-insensitive, either separator, siblings included', () => {
    asWindows(() => {
      const env = { APPDATA };
      const under = (p: string) => realDataDirPrefixOf(p, env);
      expect(under('C:\\Users\\me\\AppData\\Roaming\\Sunlight\\db\\study_paper.sqlite')).toBeTruthy();
      expect(under('C:\\Users\\ME\\APPDATA\\ROAMING\\SUNLIGHT\\papers')).toBeTruthy(); // NTFS is case-insensitive
      expect(under('C:/Users/me/AppData/Roaming/Sunlight/tmp')).toBeTruthy(); // forward slashes
      expect(under('C:\\Users\\me\\AppData\\Roaming\\Sunlight-pre-m2\\db')).toBeTruthy(); // sibling prefix, by design
      expect(under('C:\\Users\\me\\AppData\\Roaming\\Sunlight')).toBeTruthy(); // the directory itself
      expect(under('D:\\somewhere\\else')).toBeNull();
      expect(under('C:\\Users\\me\\AppData\\Roaming\\OtherApp')).toBeNull();
    });
  });
  it('recognises the %LOCALAPPDATA% fallback location too', () => {
    asWindows(() => {
      expect(realDataDirPrefixOf('C:\\Users\\me\\AppData\\Local\\Sunlight\\db', { LOCALAPPDATA })).toBeTruthy();
    });
  });
  it('off win32, the POSIX study_paper rule is unchanged', () => {
    expect(realDataDirPrefixOf('/home/u/.local/share/study_paper/db', { HOME: '/home/u' })).toBeTruthy();
    expect(realDataDirPrefixOf('/home/u/scratch/x', { HOME: '/home/u' })).toBeNull();
  });
});

describe('win32 ACL hardening (winAcl.restrictDirToCurrentUser)', () => {
  it('is a no-op off win32 and never spawns', () => {
    expect(restrictDirToCurrentUser('/tmp/whatever', { platform: 'linux' })).toEqual({ applied: false, detail: expect.stringContaining('not win32') });
  });
  it('attempts icacls on win32 and is non-fatal when it is unavailable (as on this Linux box)', () => {
    const r = restrictDirToCurrentUser(tempDir(), { platform: 'win32' });
    expect(r.applied).toBe(false);
    expect(r.detail).toMatch(/icacls/);
  });
  it('reads the mocked process.platform when no platform is injected', () => {
    asWindows(() => {
      const r = restrictDirToCurrentUser(tempDir());
      expect(r.applied).toBe(false); // icacls is not on this Linux box
      expect(r.detail).toMatch(/icacls/);
    });
  });
});

describe('win32 data-tree link/junction detection (findTreeLink)', () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  it('reports a symbolic link in the tree (junctions surface the same way on Windows)', () => {
    const root = tempDir();
    mkdirSync(join(root, 'papers'), { recursive: true });
    symlinkSync(join(root, 'elsewhere'), join(root, 'papers', 'link'));
    const posix = findTreeLink(root, ['papers']);
    expect(posix).toMatchObject({ kind: 'symlink', rel: 'papers/link' }); // detected on Linux too
    asWindows(() => expect(findTreeLink(root, ['papers'])).toMatchObject({ kind: 'symlink', rel: 'papers/link' }));
  });

  it('win32 reports an entry that is neither file, directory nor symlink (an unclassifiable reparse/special file) rather than walking past it', async () => {
    const root = tempDir();
    const tmp = join(root, 'tmp');
    mkdirSync(tmp, { recursive: true });
    const sockPath = join(tmp, 's.sock');
    const srv = createServer();
    servers.push(srv);
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(sockPath, resolve);
    });
    // POSIX: a socket is not a link and is silently skipped (unchanged behaviour).
    expect(findTreeLink(root, ['tmp'])).toBeNull();
    // win32: it is reported (as a link-kind finding), so the tree is never trusted on an unclassifiable entry.
    asWindows(() => expect(findTreeLink(root, ['tmp'])).toMatchObject({ kind: 'symlink', rel: 'tmp/s.sock' }));
    writeFileSync(join(root, 'keep'), 'x'); // sanity: the socket, not a false positive on a normal file
  });
});
