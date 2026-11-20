// Highlights · notes tab (PLAN 8.3, M1; BRIEF_D D8): list, colour filter, quote text (an area highlight shows its
// capture thumbnail), comment edit, delete, jump, and the notes (NotesSection). Creation of highlights is the
// viewer's (C). Owner D.
// Layout: the colour filter row (with '새 노트' at its right end) and the new note editor while a draft is open stay on
// top; the highlight list and the notes (with their own '노트 n개' header) share ONE scroll area below them, so neither
// can push the other (or the panel's grounding notice) out of view, however long the notes are, and a note action opens
// its editor in view however many highlights there are (reviews D-R3-01, D-F1-02).
// An area highlight's thumbnail (papers.capture, up to 4 MiB each) is fetched only once its row has been in view.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { HighlightDto } from '@study-paper/shared/contracts/api';
import { HIGHLIGHT_PALETTE } from '@study-paper/shared/contracts/domain';
import { qk } from '../api/queryKeys';
import { useReaderStore } from '../state/readerStore';
import { SCROLL_AREA_ATTR } from './keepInView';
import { NewNoteButton, NoteComposer, NotesSection, useNoteDraft } from './NotesSection';
import { usePanelApi } from './panelApi';
import { scrollIntoViewSafe } from './structureNotice';
import { CaptureImage } from './ThreadView';
import { useSeen } from './useSeen';

/** Display colours for the 5 highlight colours (the viewer draws its own overlay). */
/** = contracts HIGHLIGHT_PALETTE (the same colors the PDF overlay draws). */
export const HIGHLIGHT_COLORS: Record<number, { name: string; swatch: string }> = HIGHLIGHT_PALETTE;

function order(a: HighlightDto, b: HighlightDto): number {
  return a.page - b.page || (a.rects[0]?.y ?? 0) - (b.rects[0]?.y ?? 0) || a.createdAt - b.createdAt;
}

function HighlightItem({ h, paperId, focusTick = 0 }: { h: HighlightDto; paperId: string; focusTick?: number }) {
  const client = usePanelApi();
  const qc = useQueryClient();
  const jumpToAnchor = useReaderStore((s) => s.jumpToAnchor);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(h.comment ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { ref, seen } = useSeen<HTMLLIElement>();
  const focused = focusTick > 0;
  useEffect(() => {
    if (focusTick > 0) scrollIntoViewSafe(ref.current);
  }, [focusTick]);
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.highlights(paperId) });
  const patch = useMutation({
    mutationFn: (comment: string | null) => client.call('highlights.patch', { params: { id: h.id }, body: { comment } }),
    onSuccess: () => {
      setEditing(false);
      return invalidate();
    },
  });
  const del = useMutation({ mutationFn: () => client.call('highlights.delete', { params: { id: h.id } }), onSuccess: invalidate });
  const color = HIGHLIGHT_COLORS[h.color];

  const jump = () => {
    if (h.kind === 'text' && h.quote) jumpToAnchor({ kind: 'text', quote: h.quote, rects: h.rects });
    else jumpToAnchor({ kind: 'area', rects: h.rects });
  };

  return (
    <li ref={ref} data-testid="highlight-item" data-highlight-id={h.id} data-focused={focused ? '1' : undefined} className={`border-b border-gray-100 px-2 py-1.5 text-xs ${focused ? 'bg-yellow-50 ring-1 ring-yellow-400' : ''}`}>
      <button type="button" data-testid="highlight-jump" className="block w-full text-left hover:bg-gray-50" onClick={jump} title="PDF에서 이 위치로 이동">
        <span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: color?.swatch }} aria-label={color?.name} />
        <span className="text-gray-500">p. {h.page} · {color?.name}</span>
        <span className="mt-0.5 block whitespace-pre-wrap break-words text-gray-900">{h.kind === 'text' ? (h.quote?.exact ?? '') : '[영역 하이라이트]'}</span>
      </button>
      {h.kind === 'area' && h.imageFileId && !(seen || focused) && (
        <div data-testid="pn-highlight-thumb-pending" className="mt-1 h-6 text-sl-label text-gray-400">
          …
        </div>
      )}
      {h.kind === 'area' && h.imageFileId && (seen || focused) && <CaptureImage paperId={paperId} fileId={h.imageFileId} testId="pn-highlight-thumb" className="mt-1 max-h-24" />}
      {!editing && h.comment && (
        <div data-testid="highlight-comment" className="mt-1 whitespace-pre-wrap rounded bg-gray-50 px-1.5 py-1 text-gray-700">
          {h.comment}
        </div>
      )}
      {editing && (
        <div className="mt-1 flex flex-col gap-1">
          <textarea data-testid="highlight-comment-input" className="h-14 w-full resize-none rounded border border-gray-300 p-1" value={draft} maxLength={8000} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex gap-1">
            <button type="button" data-testid="highlight-comment-save" className="rounded bg-blue-600 px-2 text-white disabled:opacity-40" disabled={patch.isPending} onClick={() => patch.mutate(draft.trim() === '' ? null : draft)}>
              저장
            </button>
            <button
              type="button"
              className="rounded border px-2"
              onClick={() => {
                setDraft(h.comment ?? '');
                setEditing(false);
              }}
            >
              취소
            </button>
          </div>
        </div>
      )}
      {patch.isError && <div className="text-red-700">코멘트를 저장하지 못했습니다</div>}
      {del.isError && <div className="text-red-700">삭제하지 못했습니다</div>}
      <div className="mt-1 flex gap-2 text-sl-label">
        {!editing && (
          <button type="button" data-testid="highlight-comment-edit" className="text-blue-700" onClick={() => setEditing(true)}>
            {h.comment ? '코멘트 수정' : '코멘트 추가'}
          </button>
        )}
        {!confirmDelete ? (
          <button type="button" data-testid="pn-highlight-delete" className="text-red-700" onClick={() => setConfirmDelete(true)}>
            삭제
          </button>
        ) : (
          <span className="flex gap-1">
            <span>삭제할까요?</span>
            <button type="button" data-testid="highlight-delete-confirm" className="text-red-700 underline" disabled={del.isPending} onClick={() => del.mutate()}>
              삭제
            </button>
            <button type="button" className="underline" onClick={() => setConfirmDelete(false)}>
              취소
            </button>
          </span>
        )}
      </div>
    </li>
  );
}

/** focusNonce: increases with every focus request (SidePanel), so asking for the same highlight / note again scrolls again. */
export function HighlightsTab({ paperId, focusHighlightId = null, focusNoteId = null, focusNonce = 1 }: { paperId: string; focusHighlightId?: string | null; focusNoteId?: string | null; focusNonce?: number }) {
  const client = usePanelApi();
  const [filter, setFilter] = useState<number | null>(null);
  const q = useQuery({ queryKey: qk.highlights(paperId), queryFn: () => client.call('highlights.list', { params: { id: paperId } }) });
  const items = useMemo(() => (q.data?.highlights ?? []).filter((h) => filter === null || h.color === filter).sort(order), [q.data, filter]);
  const noteDraft = useNoteDraft(paperId);
  const all = useMemo(() => q.data?.highlights ?? [], [q.data]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="highlights-tab">
      <div className="flex flex-wrap items-center gap-1 text-xs" role="group" aria-label="색 필터">
        <button type="button" data-testid="highlight-filter-all" aria-pressed={filter === null} className={`rounded border px-1.5 ${filter === null ? 'border-gray-700 bg-gray-100' : 'border-gray-300'}`} onClick={() => setFilter(null)}>
          전체
        </button>
        {Object.entries(HIGHLIGHT_COLORS).map(([n, c]) => (
          <button
            key={n}
            type="button"
            data-testid={`highlight-filter-${n}`}
            aria-pressed={filter === Number(n)}
            title={c.name}
            className="sl-swatch size-5"
            style={{ background: c.swatch }}
            onClick={() => setFilter(filter === Number(n) ? null : Number(n))}
          >
            <span aria-hidden="true">{n}</span>
            <span className="sr-only">{c.name}</span>
          </button>
        ))}
        <NewNoteButton d={noteDraft} />
      </div>
      <NoteComposer d={noteDraft} highlights={all} />
      <div data-testid="pn-highlights-scroll" {...{ [SCROLL_AREA_ATTR]: '' }} className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        <ul data-testid="highlight-list" className="rounded border border-gray-200">
          {q.isPending && <li className="px-2 py-1 text-xs text-gray-500">불러오는 중…</li>}
          {q.isError && <li className="px-2 py-1 text-xs text-red-700">하이라이트를 불러오지 못했습니다</li>}
          {q.isSuccess && items.length === 0 && (
            <li className="px-2 py-1 text-xs text-gray-500">{filter === null ? '하이라이트가 없습니다. PDF에서 문장을 선택하고 H 또는 1–5를 누르세요.' : '이 색의 하이라이트가 없습니다.'}</li>
          )}
          {items.map((h) => (
            <HighlightItem key={h.id} h={h} paperId={paperId} focusTick={h.id === focusHighlightId ? focusNonce : 0} />
          ))}
        </ul>
        <NotesSection paperId={paperId} highlights={all} focusNoteId={focusNoteId} focusNonce={focusNonce} composing={noteDraft.draft !== null} saved={noteDraft.saved} />
      </div>
    </div>
  );
}
