// How `claude` is launched per OS (apps/server/src/llm/claudeSpawn.ts). Pure resolver: platform, env and the
// file-existence probe are all injected, so the win32 PATH × PATHEXT search runs deterministically on Linux. Owner:
// win-native.
import { describe, expect, it } from 'vitest';
import { resolveClaudeSpawn } from '../../src/llm/claudeSpawn';

const ARGS = ['-p', '--model', 'haiku', '--system-prompt', 'a multi line\nprompt with spaces'];

/** A case-insensitive file-existence probe, as the Windows filesystem is (PATHEXT entries are upper-case). */
const existsIn = (present: string[]) => (p: string) => present.some((x) => x.toLowerCase() === p.toLowerCase());

describe('resolveClaudeSpawn', () => {
  it('posix: runs claudeBin directly, never a shell (unchanged)', () => {
    expect(resolveClaudeSpawn('claude', ARGS, { platform: 'linux' })).toEqual({ command: 'claude', args: ARGS, shell: false });
    expect(resolveClaudeSpawn('/opt/bin/claude', ARGS, { platform: 'darwin' })).toEqual({ command: '/opt/bin/claude', args: ARGS, shell: false });
  });

  it('win32: an explicit .exe path spawns directly (no shell → argv passes intact)', () => {
    const plan = resolveClaudeSpawn('C:\\Program Files\\claude\\claude.exe', ARGS, { platform: 'win32', fileExists: () => true });
    expect(plan).toEqual({ command: 'C:\\Program Files\\claude\\claude.exe', args: ARGS, shell: false });
  });

  it('win32: an explicit .cmd/.bat path needs the shell (Node cannot exec a batch wrapper directly)', () => {
    expect(resolveClaudeSpawn('C:\\npm\\claude.cmd', ARGS, { platform: 'win32' }).shell).toBe(true);
    expect(resolveClaudeSpawn('C:\\npm\\claude.bat', ARGS, { platform: 'win32' }).shell).toBe(true);
    // the command and args are preserved either way
    expect(resolveClaudeSpawn('C:\\npm\\claude.cmd', ARGS, { platform: 'win32' })).toMatchObject({ command: 'C:\\npm\\claude.cmd', args: ARGS });
  });

  it('win32: a bare name resolves via PATH × PATHEXT, preferring a direct .exe over a .cmd shim', () => {
    const env = { PATH: 'C:\\nodejs;C:\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    // Both a .cmd (in C:\npm) and an .exe (in C:\nodejs) exist: the .exe must win, with shell:false.
    const plan = resolveClaudeSpawn('claude', ARGS, { platform: 'win32', env, fileExists: existsIn(['C:\\npm\\claude.cmd', 'C:\\nodejs\\claude.exe']) });
    expect(plan).toEqual({ command: 'C:\\nodejs\\claude.EXE', args: ARGS, shell: false });
  });

  it('win32: a bare name with only a .cmd shim on PATH falls back to the shell', () => {
    const env = { PATH: 'C:\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    const plan = resolveClaudeSpawn('claude', ARGS, { platform: 'win32', env, fileExists: existsIn(['C:\\npm\\claude.cmd']) });
    expect(plan).toEqual({ command: 'C:\\npm\\claude.CMD', args: ARGS, shell: true });
  });

  it('win32: an unresolved bare name falls back to the shell with the bare name (last resort)', () => {
    const plan = resolveClaudeSpawn('claude', ARGS, { platform: 'win32', env: { PATH: 'C:\\empty' }, fileExists: () => false });
    expect(plan).toEqual({ command: 'claude', args: ARGS, shell: true });
  });

  it('win32: honours the default PATHEXT and the lowercase Path variable', () => {
    // No PATHEXT given → default .COM;.EXE;.BAT;.CMD; only a .EXE exists, reached through the lowercase `Path`.
    const plan = resolveClaudeSpawn('claude', ARGS, { platform: 'win32', env: { Path: 'C:\\tools' }, fileExists: existsIn(['C:\\tools\\claude.exe']) });
    expect(plan).toEqual({ command: 'C:\\tools\\claude.EXE', args: ARGS, shell: false });
  });
});
