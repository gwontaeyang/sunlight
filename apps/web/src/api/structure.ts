// Paper structure for the viewer (C: outline, equation/section jumps) and the panels (D: equations and references
// tabs) — one hook, one query key, so both read the same data (PLAN_M2 3.8). Owner: supervisor.
import { useQuery } from '@tanstack/react-query';
import type { EquationDto, ReferenceDto, SectionDto, StructureResponse } from '@study-paper/shared/contracts/api';
import { eqNumberKey, normalizeEqNumber } from '@study-paper/shared/contracts/domain';
import { useReaderStore } from '../state/readerStore';
import { api, type ApiClient } from './client';
import { qk } from './queryKeys';

export interface UseStructureOptions {
  client?: ApiClient;
  /** Overrides the default (request only when the open paper is structure_ready). */
  enabled?: boolean;
}

/** papers.structure of a paper. Requests only when the paper is structure_ready (readerStore.paperState). */
export function useStructure(paperId: string | null, opts: UseStructureOptions = {}) {
  const ready = useReaderStore((s) => s.paperId === paperId && s.paperState.structureReady);
  const client = opts.client ?? api;
  return useQuery({
    queryKey: qk.structure(paperId ?? ''),
    queryFn: ({ signal }) => client.call('papers.structure', { params: { id: paperId! }, signal }),
    enabled: paperId !== null && (opts.enabled ?? ready),
    staleTime: Number.POSITIVE_INFINITY, // structure rows never change after they are published (an upgrade invalidates the key)
  });
}

/** The contracts' one equation-number normalization (PLAN_M2 3.3 `want`), re-exported for this module's importers. */
export { eqNumberKey, normalizeEqNumber };

/** Every equation with this number (compared by eqNumberKey: normalised, case-insensitive). */
export function equationsByNumber(structure: StructureResponse | undefined, n: string): EquationDto[] {
  if (!structure) return [];
  const want = eqNumberKey(n);
  return structure.equations.filter((e) => e.number !== null && eqNumberKey(e.number) === want);
}

/** The equation with this number when exactly one has it, else null (ambiguous or absent). */
export function equationByNumber(structure: StructureResponse | undefined, n: string): EquationDto | null {
  const all = equationsByNumber(structure, n);
  return all.length === 1 ? all[0]! : null;
}

export function equationById(structure: StructureResponse | undefined, id: string): EquationDto | null {
  return structure?.equations.find((e) => e.id === id) ?? null;
}

export function sectionById(structure: StructureResponse | undefined, id: string): SectionDto | null {
  return structure?.sections.find((s) => s.id === id) ?? null;
}

/** The reference with this ordinal (the [n] of the reference list), or null. */
export function referenceByOrdinal(structure: StructureResponse | undefined, ordinal: number): ReferenceDto | null {
  return structure?.references.find((r) => r.ordinal === ordinal) ?? null;
}
