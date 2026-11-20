// A StructureResponse shaped like the SEED_M2 paper (sections I, II, II-A, II-B; numbered and unnumbered equations,
// one KaTeX failure, references [1] without id · [2] in the Library · [3] arXiv only). Owner D.
import type { EquationDto, ReferenceDto, SectionDto, StructureResponse } from '@study-paper/shared/contracts/api';

const sec = (id: string, number: string | null, title: string, ordinal: number): SectionDto => ({ id, parentId: null, htmlId: id, number, title, level: 1, ordinal, pdfPage: 1, pdfOffset: 0, pdfRect: null });
export const eqRow = (id: string, number: string | null, ordinal: number, o: Partial<EquationDto> = {}): EquationDto => ({
  id, sectionId: 'S2', htmlId: id, number, ordinal, latexRaw: 'x', latex: `e_{${ordinal}} = p - q`, katexOk: true, pdfPage: 2, pdfOffset: 100 + ordinal, pdfRect: null, ...o,
});
const ref = (ordinal: number, rawText: string, o: Partial<ReferenceDto> = {}): ReferenceDto => ({ id: `R${ordinal}`, ordinal, label: String(ordinal), rawText, title: null, authors: [], year: null, venue: null, doi: null, arxivId: null, citationCount: null, inLibraryPaperId: null, htmlId: `bib.bib${ordinal}`, ...o });

export const LINKS_PAPER = '00000000-0000-4000-8000-000000000003';

export function structureFixture(): StructureResponse {
  return {
    structureSource: 'latexml',
    sections: [sec('S1', 'I', 'Introduction', 1), sec('S2', 'II', 'Method', 2), sec('S2.SS1', 'II-A', 'Robust Kernel', 3)],
    equations: [
      eqRow('E1', '1', 1, { sectionId: 'S1' }),
      eqRow('E2', '2', 2, { latex: '\\Tr(\\mathbf{R}) = 1 + 2\\cos\\theta' }),
      eqRow('E3', null, 3),
      eqRow('E4', '4', 4, { latex: '\\undefinedmacro{x} + \\undefinedmacrotwo', katexOk: false, pdfPage: null, pdfOffset: null }),
      eqRow('E5', null, 5, { sectionId: 'S2.SS1' }),
    ],
    figures: [],
    references: [
      ref(1, 'A. Author. A paper without an identifier. 2020.'),
      ref(2, 'B. Author. The link target. arXiv:2301.00003, 2023.', { arxivId: '2301.00003', inLibraryPaperId: LINKS_PAPER }),
      ref(3, 'C. Author. Not in the library. arXiv:2301.00099. doi:10.1109/LRA.2023.1234567', { arxivId: '2301.00099', doi: '10.1109/LRA.2023.1234567' }),
    ],
  };
}
