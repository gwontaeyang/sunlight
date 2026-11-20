// Is an M1 paper a structure upgrade target? (PLAN_M2 3.1 "M1 논문 upgrade", BRIEF_A A6 decision table). Owner A.
// One pure function for PaperDetailDto.structureUpgrade, PaperSummaryDto.structureUpgradeAvailable and the
// papers.upgradeStructure check. Rows are tried top to bottom; the first that matches decides:
//   source ≠ arxiv, being deleted, or structureReadyAt missing (ingest running / failed)     → false, null
//   supplementVersion ≠ 1 (2 = already structured) or structureSource ≠ 'none'               → false, null
//   a STRUCTURE_FINAL_WARNINGS code in the warnings (the same HTML would give the same result) → false, null
//   html_deferred in the warnings (the import could not get the HTML in time)                → true, 'html_deferred'
//   otherwise (made by M1: no structure warning)                                               → true, 'm1_paper'
import type { JobDto, StructureUpgradeDto } from '@study-paper/shared/contracts/api';
import { STRUCTURE_FINAL_WARNINGS } from '@study-paper/shared/contracts/domain';

export interface UpgradePaperFields {
  source: string;
  deletingAt: number | null;
  structureReadyAt: number | null;
  supplementVersion: number | null;
  structureSource: string | null;
  ingestWarningsJson: string | null;
}

/** Warning codes of an ingestWarningsJson value (`<code>` or `<code>: <description>` items; anything else ignored). */
export function warningCodes(json: string | null): Set<string> {
  const out = new Set<string>();
  try {
    const v = json ? (JSON.parse(json) as unknown) : [];
    if (Array.isArray(v)) for (const w of v) if (typeof w === 'string') out.add(w.split(':', 1)[0]!.trim());
  } catch {
    // unreadable warnings: no codes
  }
  return out;
}

export function structureUpgradeState(p: UpgradePaperFields, latestUpgradeJob: JobDto | null): StructureUpgradeDto {
  const no = { available: false, reason: null, job: latestUpgradeJob } as const;
  if (p.source !== 'arxiv' || p.deletingAt !== null || p.structureReadyAt === null) return no;
  if (p.supplementVersion !== 1 || p.structureSource !== 'none') return no;
  const codes = warningCodes(p.ingestWarningsJson);
  if (STRUCTURE_FINAL_WARNINGS.some((c) => codes.has(c))) return no;
  if (codes.has('html_deferred')) return { available: true, reason: 'html_deferred', job: latestUpgradeJob };
  return { available: true, reason: 'm1_paper', job: latestUpgradeJob };
}
