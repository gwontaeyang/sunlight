// Owner and milestone of every route (PLAN appendix A, 9.3). The contract test checks that this covers
// ROUTES exactly. A milestone gate requires that the routes of that milestone no longer answer 501.
import type { RouteId } from './routes';

export type RouteOwner = 'A' | 'B' | 'supervisor';
/** 0 = S0 scaffold (supervisor), 1–4 = delivery milestones. */
export type Milestone = 0 | 1 | 2 | 3 | 4;
/**
 * Milestone whose routes must all be implemented on `main` (PLAN 9.1 step 3). Only the supervisor changes it,
 * at a milestone merge: 0 after S0, 1 after the M1 merge, … Builders preview the next gate on their branch with
 * `SP_GATE_MILESTONE=<N> npm test` (their own routes pass, the other builder's routes are still listed).
 * M2: 2 after the M2 merge (integration/m2) — the constant also turns on G7c in m2.gate.test.ts (the env does not).
 */
export const GATED_MILESTONE: Milestone = 2;

/** A is an implementation checkpoint. Only an accepted product stage advances the checked-in gate. */
export const STAGES = ['m2', 'a', 'c2', 'study', 'upload', 'b', 'c1', 'd'] as const;
export type GateStage = (typeof STAGES)[number];
export const GATED_STAGE: GateStage = 'upload';

export function gateStage(preview: string | undefined, accepted: GateStage = GATED_STAGE): GateStage {
  if (!preview) return accepted;
  const index = STAGES.findIndex((stage) => stage === preview);
  if (index < 0) throw new Error('invalid SP_GATE_STAGE');
  return STAGES[Math.max(index, STAGES.indexOf(accepted))]!;
}

export function routeDue(entry: RouteManifestEntry, milestone: number, stage: GateStage): boolean {
  return entry.milestone <= milestone || (entry.stage !== undefined && STAGES.indexOf(entry.stage) <= STAGES.indexOf(stage));
}

export interface RouteManifestEntry {
  route: RouteId;
  owner: RouteOwner;
  milestone: Milestone;
  stage?: GateStage;
}

export const ROUTE_MANIFEST = [
  { route: 'health', owner: 'supervisor', milestone: 0 },
  { route: 'papers.import', owner: 'A', milestone: 1 },
  { route: 'jobs.events', owner: 'A', milestone: 1 },
  { route: 'papers.list', owner: 'A', milestone: 1 },
  { route: 'papers.get', owner: 'A', milestone: 1 },
  { route: 'papers.patch', owner: 'A', milestone: 1 },
  { route: 'papers.delete', owner: 'A', milestone: 1 },
  { route: 'papers.pdf', owner: 'A', milestone: 1 },
  { route: 'papers.retryIngest', owner: 'A', milestone: 1 },
  { route: 'papers.upgradeStructure', owner: 'A', milestone: 2 },
  { route: 'papers.capture', owner: 'A', milestone: 2 },
  { route: 'highlights.list', owner: 'A', milestone: 1 },
  { route: 'highlights.create', owner: 'A', milestone: 1 },
  { route: 'highlights.patch', owner: 'A', milestone: 1 },
  { route: 'highlights.delete', owner: 'A', milestone: 1 },
  { route: 'papers.structure', owner: 'A', milestone: 2 },
  { route: 'papers.position', owner: 'A', milestone: 2 },
  { route: 'notes.list', owner: 'A', milestone: 2 },
  { route: 'notes.create', owner: 'A', milestone: 2 },
  { route: 'notes.patch', owner: 'A', milestone: 2 },
  { route: 'notes.delete', owner: 'A', milestone: 2 },
  { route: 'progress.list', owner: 'A', milestone: 2 },
  { route: 'progress.put', owner: 'A', milestone: 2 },
  { route: 'collections.list', owner: 'A', milestone: 4 },
  { route: 'collections.create', owner: 'A', milestone: 4 },
  { route: 'collections.patch', owner: 'A', milestone: 4 },
  { route: 'collections.delete', owner: 'A', milestone: 4 },
  { route: 'review.queue', owner: 'A', milestone: 4 },
  { route: 'review.stats', owner: 'A', milestone: 4 },
  { route: 'review.grade', owner: 'A', milestone: 4 },
  { route: 'review.cards.create', owner: 'A', milestone: 4 },
  { route: 'review.cards.patch', owner: 'A', milestone: 4 },
  { route: 'review.cards.delete', owner: 'A', milestone: 4 },
  { route: 'papers.exportMd', owner: 'A', milestone: 4 },
  { route: 'settings.get', owner: 'A', milestone: 3, stage: 'c2' },
  { route: 'settings.put', owner: 'A', milestone: 3, stage: 'c2' },
  { route: 'settings.secret.put', owner: 'A', milestone: 3, stage: 'c2' },
  { route: 'settings.secret.delete', owner: 'A', milestone: 3, stage: 'c2' },
  { route: 'settings.secret.check', owner: 'A', milestone: 3, stage: 'c2' },
  { route: 'threads.list', owner: 'B', milestone: 1 },
  { route: 'threads.get', owner: 'B', milestone: 1 },
  { route: 'threads.delete', owner: 'B', milestone: 1 },
  { route: 'threads.create', owner: 'B', milestone: 1 },
  { route: 'messages.create', owner: 'B', milestone: 1 },
  { route: 'llm.runs.get', owner: 'B', milestone: 1 },
  { route: 'llm.runs.cancel', owner: 'B', milestone: 1 },
  { route: 'llm.health', owner: 'B', milestone: 1 },
  { route: 'cards.list', owner: 'B', milestone: 2 },
  { route: 'cards.generate', owner: 'B', milestone: 2 },
  { route: 'cardItems.patch', owner: 'B', milestone: 2 },
  { route: 'glossary.list', owner: 'B', milestone: 2 },
  { route: 'glossary.create', owner: 'B', milestone: 2 },
  { route: 'glossary.define', owner: 'B', milestone: 2 },
  { route: 'glossary.patch', owner: 'B', milestone: 2 },
  { route: 'glossary.delete', owner: 'B', milestone: 2 },
  { route: 'reviewCards.generate', owner: 'B', milestone: 4 },
  { route: 'reviewCards.accept', owner: 'B', milestone: 4 },
  { route: 'explainBack.create', owner: 'B', milestone: 4 },
  { route: 'explainBack.list', owner: 'B', milestone: 4 },
  { route: 'usage.summary', owner: 'B', milestone: 3, stage: 'c2' },
  { route: 'studyPath.get', owner: 'B', milestone: 3, stage: 'study' },
  { route: 'studyPath.generate', owner: 'B', milestone: 3, stage: 'study' },
  { route: 'studyPath.check', owner: 'B', milestone: 3, stage: 'study' },
  { route: 'papers.upload', owner: 'A', milestone: 3, stage: 'upload' },
] as const satisfies readonly RouteManifestEntry[];
