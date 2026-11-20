// Regenerates the committed synthetic PDFs (synthetic.pdf, synthetic-m2.pdf, synthetic-links.pdf).
// Usage: npx tsx scripts/make-synthetic-pdf.ts
import { writeFileSync } from 'node:fs';
import { buildSyntheticLinksPdf, buildSyntheticM2Pdf, buildSyntheticPdf } from './lib/syntheticPdf';

for (const [name, build] of [
  ['synthetic.pdf', buildSyntheticPdf],
  ['synthetic-m2.pdf', buildSyntheticM2Pdf],
  ['synthetic-links.pdf', buildSyntheticLinksPdf],
] as const) {
  const out = new URL(`../apps/server/test/fixtures/${name}`, import.meta.url);
  const bytes = await build();
  writeFileSync(out, bytes);
  console.log(`wrote ${out.pathname} (${bytes.length} bytes)`);
}
