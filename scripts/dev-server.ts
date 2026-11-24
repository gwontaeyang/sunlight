// Dev server launcher. The `dev:server` npm script runs `tsx watch scripts/dev-server.ts` with no inline env, because
// a `SP_ENV=dev` prefix is a POSIX shell-ism that does not work when npm runs the script through cmd.exe on native
// Windows. Setting it here (before the server module is imported) is cross-platform and equivalent on every OS.
process.env.SP_ENV ??= 'dev';
const { startServer } = await import('../apps/server/src/index');
await startServer();
