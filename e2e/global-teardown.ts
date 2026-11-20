import { rmSync } from 'node:fs';

export default function globalTeardown() {
  if (process.env.SP_E2E_ROOT && !process.env.SP_E2E_KEEP) rmSync(process.env.SP_E2E_ROOT, { recursive: true, force: true });
}
