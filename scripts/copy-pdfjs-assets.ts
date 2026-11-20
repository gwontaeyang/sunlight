// Copies pdf.js runtime assets (cmaps, standard fonts, wasm, ICC profiles) to apps/web/public/pdfjs/ (git-ignored).
// Usage: npm run copy:pdfjs (also runs before dev and build).
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = fileURLToPath(new URL('../apps/web/', import.meta.url));
const require = createRequire(join(webDir, 'package.json'));
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));
const version = (require('pdfjs-dist/package.json') as { version: string }).version;
const out = join(webDir, 'public', 'pdfjs');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const src = join(pdfjsRoot, dir);
  if (!existsSync(src)) throw new Error(`pdfjs-dist ${version} has no ${dir}/`);
  cpSync(src, join(out, dir), { recursive: true });
}
console.log(`copied pdfjs-dist ${version} assets to ${out}`);
