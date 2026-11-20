// Equations tab (BRIEF_D D5): the numbered equations of useStructure (with their section number), unnumbered ones
// folded ("번호 없는 식 n개"), KaTeX through renderLatexSafe (the code when katexOk is false), jump
// (readerStore.jumpToEquation — no_anchor → "PDF 위치 없음"), "LaTeX 복사" (the stored latex), "깊이 읽기"
// (requestAction equation → the AI tab re-opens a complete thread of that equation or starts one). Long lists render
// KaTeX only for rows in view (IntersectionObserver). A failed structure load offers "다시 시도" (review D-I10-02). Owner D.
// "깊이 읽기" only on numbered equations: the server reads in depth only a numbered equation of the paper and answers
// 400 for any other equationId (review D-R3-03) — an unnumbered one is read through an area capture instead.
import { memo, useEffect, useMemo } from 'react';
import type { EquationDto, StructureResponse } from '@study-paper/shared/contracts/api';
import { sectionById, useStructure } from '../api/structure';
import { JumpNote, useEquationJump } from '../markdown/chips';
import { CopyLatexButton, LatexView } from '../markdown/latex';
import { LoadError } from './loadError';
import { useReaderStore } from '../state/readerStore';
import { usePanelApi } from './panelApi';
import { NoStructureNotice, scrollIntoViewSafe } from './structureNotice';
import { useSeen } from './useSeen';

const EquationRow = memo(function EquationRow({ eq, structure, focusTick }: { eq: EquationDto; structure: StructureResponse; focusTick: number }) {
  const { ref, seen } = useSeen<HTMLLIElement>();
  const jump = useEquationJump();
  const requestAction = useReaderStore((s) => s.requestAction);
  const section = eq.sectionId ? sectionById(structure, eq.sectionId) : null;
  const focused = focusTick > 0;
  useEffect(() => {
    if (focusTick > 0) scrollIntoViewSafe(ref.current);
  }, [focusTick, ref]);
  return (
    <li ref={ref} data-testid="pn-eq-item" data-equation-id={eq.id} data-focused={focused ? '1' : undefined} className={`border-b border-gray-100 px-2 py-1.5 text-xs ${focused ? 'bg-yellow-50 ring-1 ring-yellow-400' : ''}`}>
      <button type="button" data-testid="pn-eq-jump" className="block w-full text-left hover:bg-gray-50" title="PDF에서 이 식으로 이동" onClick={() => void jump.jump(eq.id)}>
        <span className="font-medium">{eq.number ? `(${eq.number})` : '번호 없음'}</span>
        {section && <span className="ml-1 text-gray-500">{section.number ? `${section.number}절` : section.title}</span>}
        {eq.pdfPage !== null && <span className="ml-1 text-gray-400">p. {eq.pdfPage}</span>}
      </button>
      <JumpNote result={jump.result} />
      <div className="mt-0.5 min-h-6">{seen ? <LatexView latex={eq.latex} katexOk={eq.katexOk} /> : <span className="font-mono text-sl-label text-gray-400">…</span>}</div>
      <div className="mt-0.5 flex gap-1">
        <CopyLatexButton latex={eq.latex} />
        {eq.number !== null && (
          <button type="button" data-testid="pn-eq-deep" className="rounded border border-blue-300 px-1.5 text-sl-label text-blue-800 hover:bg-blue-50" onClick={() => requestAction({ kind: 'equation', equationId: eq.id })}>
            깊이 읽기
          </button>
        )}
      </div>
    </li>
  );
});

/** focusNonce: increases with every focus request (SidePanel), so asking for the same equation again scrolls again. */
export function EquationsTab({ paperId, focusEquationId = null, focusNonce = 1 }: { paperId: string; focusEquationId?: string | null; focusNonce?: number }) {
  const client = usePanelApi();
  const structureReady = useReaderStore((s) => s.paperId === paperId && s.paperState.structureReady);
  const q = useStructure(paperId, { client });
  const { numbered, unnumbered } = useMemo(() => {
    const all = [...(q.data?.equations ?? [])].sort((a, b) => a.ordinal - b.ordinal);
    return { numbered: all.filter((e) => e.number !== null), unnumbered: all.filter((e) => e.number === null) };
  }, [q.data]);
  if (!structureReady) return <NoStructureNotice what="수식 목록" />;
  // Review D-I10-02: a failed load offers "다시 시도"; a failed refetch keeps the list drawn from the last data.
  const loadError = q.isError && (
    <LoadError testId="pn-eq-load-error" text={q.data ? '수식 색인을 새로 불러오지 못했습니다 — 아래는 마지막으로 받은 목록입니다' : '수식 색인을 불러오지 못했습니다'} retrying={q.isFetching} onRetry={() => void q.refetch()} />
  );
  if (q.data === undefined) return loadError || <div className="text-xs text-gray-500">불러오는 중…</div>;
  const s = q.data;
  return (
    <div data-testid="pn-equations-tab" className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
      {loadError}
      {numbered.length === 0 && unnumbered.length === 0 && <div className="text-xs text-gray-500">색인된 수식이 없습니다</div>}
      <ul data-testid="pn-eq-list">
        {numbered.map((e) => (
          <EquationRow key={e.id} eq={e} structure={s} focusTick={e.id === focusEquationId ? focusNonce : 0} />
        ))}
      </ul>
      {unnumbered.length > 0 && (
        <details data-testid="pn-eq-unnumbered" open={unnumbered.some((e) => e.id === focusEquationId)}>
          <summary className="cursor-pointer px-2 py-1 text-xs text-gray-600">번호 없는 식 {unnumbered.length}개</summary>
          <div data-testid="pn-eq-unnumbered-note" className="px-2 pb-1 text-sl-label text-gray-500">
            번호 없는 식은 ‘깊이 읽기’를 할 수 없습니다. PDF에서 식 영역을 캡처해 물어보세요.
          </div>
          <ul>
            {unnumbered.map((e) => (
              <EquationRow key={e.id} eq={e} structure={s} focusTick={e.id === focusEquationId ? focusNonce : 0} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
