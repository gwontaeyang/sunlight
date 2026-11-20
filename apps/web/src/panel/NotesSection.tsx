// Notes of the highlights·notes tab (BRIEF_D D8): write / edit / delete (Markdown + LaTeX — edited in a textarea, shown
// through StoredMarkup in plain mode: no chips, no badges), linked to a highlight and/or a section, grouped by section
// (by page when there is none). A reader "note" action opens a new note on its highlight / section. Owner D.
// Layout (reviews D-R3-01, D-F1-02): '새 노트' (NewNoteButton, in the colour filter row) and the draft editor
// (NoteComposer) sit above the highlight·note scroll area, so however many highlights there are, a note action (N,
// '새 노트', selection + N) opens the editor in view; it is also scrolled into view and its input focused (caret at the
// end) each time a note action reaches it. The notes list carries its own '노트 n개' header inside the scroll area, and
// a newly saved note is scrolled into view there and marked '방금 저장'.
// Draft (review D-F1-01): the draft body lives in useNoteDraft. A note action on a draft that holds written text
// appends its quote instead of replacing the text; one that arrives while notes.create is pending is applied after it.
// Size (common rule 3): a note may be 100,000 characters. A note is drawn only once its row has been in view, and only
// its first NOTE_PREVIEW_CHARS characters; "더 보기" adds NOTE_MORE_CHARS more per press (each step a bounded render).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { HighlightDto, NoteDto } from '@study-paper/shared/contracts/api';
import { sectionById, useStructure } from '../api/structure';
import { qk } from '../api/queryKeys';
import { StoredMarkup, useStoredPair } from '../markdown/renderStored';
import { type ReaderAction, useReaderStore } from '../state/readerStore';
import { useKeepInView } from './keepInView';
import { usePanelApi } from './panelApi';
import { scrollIntoViewSafe } from './structureNotice';
import { collapseSpaces } from './ThreadView';
import { useSeen } from './useSeen';

const NOTE_MAX = 100_000;
/** Characters of a note drawn before "더 보기", and added per press. */
export const NOTE_PREVIEW_CHARS = 4_000;
export const NOTE_MORE_CHARS = 12_000;

/** The first `n` UTF-16 units of `s`, not splitting a surrogate pair. */
function headOf(s: string, n: number): string {
  if (s.length <= n) return s;
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

/** Plain display of a note (no chips, no badges), drawn up to `shown` characters with "더 보기". */
function NotePreview({ body }: { body: string }) {
  const [limit, setLimit] = useState(NOTE_PREVIEW_CHARS);
  const head = headOf(body, limit);
  const pair = useStoredPair(head, [], { mode: 'plain' });
  const rest = body.length - head.length;
  return (
    <div data-testid="pn-note-body" data-shown={head.length} data-total={body.length}>
      <StoredMarkup parsed={pair.parsed} paired={pair.paired} />
      {rest > 0 && (
        <button type="button" data-testid="pn-note-more" className="mt-0.5 text-sl-label text-blue-700" onClick={() => setLimit((l) => l + NOTE_MORE_CHARS)}>
          … 더 보기 ({rest.toLocaleString()}자 남음)
        </button>
      )}
    </div>
  );
}

/**
 * value/onChange: a controlled body (the new note draft, kept by useNoteDraft); without them the editor keeps its own
 * (editing a saved note). focusTick > 0: each new value scrolls the editor into view and focuses its input with the
 * caret at the end (note actions on the new note draft). saving: the input is read-only and '저장' / '취소' are disabled,
 * so a failed save leaves the text and its error in this editor.
 */
function NoteEditor({ initial = '', value, onChange, onSave, onCancel, saving, focusTick = 0 }: { initial?: string; value?: string; onChange?: (body: string) => void; onSave: (body: string) => void; onCancel: () => void; saving: boolean; focusTick?: number }) {
  const [own, setOwn] = useState(initial);
  const body = value ?? own;
  const setBody = onChange ?? setOwn;
  const [preview, setPreview] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusTick <= 0) return;
    setPreview(false);
    scrollIntoViewSafe(rootRef.current);
  }, [focusTick]);
  // Runs after the body of this render is in the textarea (an appended quote), so the caret lands at its end.
  useEffect(() => {
    if (focusTick <= 0) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  }, [focusTick, preview]);
  return (
    <div ref={rootRef} data-testid="pn-note-editor" className="flex flex-col gap-1">
      <div className="flex gap-1 text-sl-label">
        <button type="button" aria-pressed={!preview} className={`rounded border px-1.5 ${!preview ? 'bg-gray-100' : ''}`} onClick={() => setPreview(false)}>
          편집
        </button>
        <button type="button" data-testid="pn-note-preview-toggle" aria-pressed={preview} className={`rounded border px-1.5 ${preview ? 'bg-gray-100' : ''}`} onClick={() => setPreview(true)}>
          미리보기
        </button>
      </div>
      {preview ? (
        <div data-testid="pn-note-preview" className="min-h-12 rounded border border-gray-200 p-1">
          <NotePreview body={body} />
        </div>
      ) : (
        <textarea ref={inputRef} data-testid="pn-note-input" className="h-24 w-full resize-y rounded border border-gray-300 p-1 font-mono text-sl-label" placeholder="노트 (Markdown, $수식$)" value={body} maxLength={NOTE_MAX} readOnly={saving} onChange={(e) => setBody(e.target.value)} />
      )}
      <div className="flex gap-1">
        <button type="button" data-testid="pn-note-save" className="rounded bg-blue-600 px-2 text-white disabled:opacity-40" disabled={saving || body.trim() === ''} onClick={() => onSave(body)}>
          저장
        </button>
        {/* disabled while saving like the input and '저장' (review D-S1-01): a cancel during the save would drop the text
            and hide the error of a failed save */}
        <button type="button" className="rounded border px-2 disabled:opacity-40" disabled={saving} onClick={onCancel}>
          취소
        </button>
      </div>
    </div>
  );
}

/** savedTick > 0: this is the note just saved from the new note editor — drawn at once, kept in view (useKeepInView), marked. */
const NoteItem = memo(function NoteItem({ note, paperId, highlight, focusTick, savedTick = 0 }: { note: NoteDto; paperId: string; highlight: HighlightDto | null; focusTick: number; savedTick?: number }) {
  const client = usePanelApi();
  const { ref, seen } = useSeen<HTMLLIElement>();
  const focused = focusTick > 0;
  const justSaved = savedTick > 0;
  useEffect(() => {
    if (focusTick > 0) scrollIntoViewSafe(ref.current);
  }, [focusTick]);
  useKeepInView(ref, savedTick);
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.notes(paperId) });
  const save = async (bodyMd: string) => {
    setBusy(true);
    setError(null);
    try {
      await client.call('notes.patch', { params: { id: note.id }, body: { bodyMd } });
      setEditing(false);
      await invalidate();
    } catch {
      setError('노트를 저장하지 못했습니다');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    try {
      await client.call('notes.delete', { params: { id: note.id } });
      await invalidate();
    } catch {
      setError('삭제하지 못했습니다');
    }
  };
  return (
    <li ref={ref} data-testid="pn-note-item" data-note-id={note.id} data-focused={focused ? '1' : undefined} className={`border-b border-gray-100 px-2 py-1.5 text-xs ${focused ? 'bg-yellow-50 ring-1 ring-yellow-400' : justSaved ? 'bg-green-50' : ''}`}>
      {justSaved && (
        <div data-testid="pn-note-saved" className="mb-0.5 text-sl-label text-green-700">
          방금 저장함
        </div>
      )}
      {highlight && (
        <div data-testid="pn-note-highlight" className="mb-0.5 truncate text-sl-label text-gray-500" title="연결된 하이라이트">
          ↳ {highlight.kind === 'text' ? collapseSpaces(highlight.quote?.exact ?? '') : `[영역 하이라이트 p. ${highlight.page}]`}
        </div>
      )}
      {editing ? (
        <NoteEditor initial={note.bodyMd} saving={busy} onSave={(b) => void save(b)} onCancel={() => setEditing(false)} />
      ) : seen || focused || justSaved ? (
        <NotePreview body={note.bodyMd} />
      ) : (
        <div data-testid="pn-note-pending" className="min-h-6 text-sl-label text-gray-400">
          …
        </div>
      )}
      {error && <div className="text-red-700">{error}</div>}
      {!editing && (
        <div className="mt-0.5 flex gap-2 text-sl-label">
          <button type="button" data-testid="pn-note-edit" className="text-blue-700" onClick={() => setEditing(true)}>
            수정
          </button>
          {!confirmDelete ? (
            <button type="button" data-testid="pn-note-delete" className="text-red-700" onClick={() => setConfirmDelete(true)}>
              삭제
            </button>
          ) : (
            <span className="flex gap-1">
              <span>삭제할까요?</span>
              <button type="button" data-testid="pn-note-delete-confirm" className="text-red-700 underline" onClick={() => void remove()}>
                삭제
              </button>
              <button type="button" className="underline" onClick={() => setConfirmDelete(false)}>
                취소
              </button>
            </span>
          )}
        </div>
      )}
    </li>
  );
});

interface Draft {
  /** A new value for every draft opened from nothing (create closes only the draft it saved). */
  id: number;
  highlightId?: string;
  sectionId?: string;
  /** The body the draft was opened with; while the body still equals it, the draft holds no written text. */
  initial: string;
  body: string;
  /** Increases with every note action / '새 노트' that reaches the draft: the editor scrolls into view and focuses. */
  focus: number;
}

/** A reader action of kind 'note'. */
type NoteAction = ReaderAction;

/** '> quote' + blank line, the quote's spaces and line breaks collapsed ('' without a quote). */
function quoteBlock(a: NoteAction): string {
  const quote = a.text ?? a.anchor?.quote?.exact;
  return quote ? `> ${collapseSpaces(quote)}\n\n` : '';
}

/** Body with `block` appended after a blank line. */
function appendBlock(body: string, block: string): string {
  if (block === '') return body;
  const sep = body === '' || body.endsWith('\n\n') ? '' : body.endsWith('\n') ? '\n' : '\n\n';
  return body + sep + block;
}

/**
 * A note action applied to the draft. No draft, or one without written text (body = initial): a new draft on the
 * action's highlight / section with its quote. A draft with written text keeps it and its link (it takes the action's
 * highlight / section only where it had none) and gets the quote appended (nothing without a selection).
 */
function applyNoteAction(d: Draft | null, a: NoteAction, currentSectionId: string | null, next: () => number): Draft {
  const sectionId = a.sectionId ?? currentSectionId ?? undefined;
  if (!d || d.body === d.initial) {
    const body = quoteBlock(a);
    return { id: next(), ...(a.highlightId ? { highlightId: a.highlightId } : {}), ...(sectionId ? { sectionId } : {}), initial: body, body, focus: next() };
  }
  const highlightId = d.highlightId ?? a.highlightId;
  const keepSection = d.sectionId ?? sectionId;
  return { ...d, ...(highlightId ? { highlightId } : {}), ...(keepSection ? { sectionId: keepSection } : {}), body: appendBlock(d.body, quoteBlock(a)), focus: next() };
}

/** The new note draft of the tab: '새 노트' and the reader "note" action open it (HighlightsTab owns one). */
export function useNoteDraft(paperId: string) {
  const client = usePanelApi();
  const qc = useQueryClient();
  const pendingAction = useReaderStore((s) => s.pendingAction);
  const consumeAction = useReaderStore((s) => s.consumeAction);
  const currentSectionId = useReaderStore((s) => s.currentSectionId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The note saved last (its row is scrolled into view and marked); tick increases per save. */
  const [saved, setSaved] = useState<{ noteId: string; tick: number } | null>(null);
  const seq = useRef(0);
  const next = () => ++seq.current;
  /** notes.create is pending: note actions wait here and are applied when it ends (so it cannot close or eat them). */
  const savingRef = useRef(false);
  const queued = useRef<{ a: NoteAction; sectionId: string | null }[]>([]);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Reader action "note" (N): a new note on the action's highlight / section (the selected text quoted).
  useEffect(() => {
    const a = useReaderStore.getState().pendingAction;
    if (!a || a.kind !== 'note') return;
    consumeAction();
    if (savingRef.current) {
      queued.current.push({ a, sectionId: currentSectionId });
      return;
    }
    // a new draft starts without the previous save error; a written draft that only gets a quote keeps it
    const cur = draftRef.current;
    if (!cur || cur.body === cur.initial) setError(null);
    setDraft((d) => applyNoteAction(d, a, currentSectionId, next));
  }, [pendingAction, consumeAction, currentSectionId]);

  const flushQueued = () => {
    const q = queued.current;
    queued.current = [];
    if (q.length > 0) setDraft((d) => q.reduce<Draft | null>((acc, x) => applyNoteAction(acc, x.a, x.sectionId, next), d));
  };

  const open = () => {
    setError(null);
    setDraft((d) => (d ? { ...d, focus: next() } : { id: next(), ...(currentSectionId ? { sectionId: currentSectionId } : {}), initial: '', body: '', focus: next() }));
  };
  const close = () => {
    setError(null);
    setDraft(null);
  };
  const setBody = (body: string) => setDraft((d) => (d ? { ...d, body } : d));
  const create = async () => {
    const d = draftRef.current;
    if (!d || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    let ok = false;
    try {
      const n = await client.call('notes.create', { params: { id: paperId }, body: { bodyMd: d.body, ...(d.highlightId ? { highlightId: d.highlightId } : {}), ...(d.sectionId ? { sectionId: d.sectionId } : {}) } });
      ok = true;
      // close only the draft that was saved, never one opened by close() + open() meanwhile (the UI disables '취소'
      // while saving, D-S1-01; the hook keeps the rule itself — pinned by the useNoteDraft test, D-S1-02)
      setDraft((cur) => (cur && cur.id === d.id ? null : cur));
      setSaved((p) => ({ noteId: n.id, tick: (p?.tick ?? 0) + 1 }));
    } catch {
      setError('노트를 저장하지 못했습니다');
    } finally {
      savingRef.current = false;
      setSaving(false);
      flushQueued();
    }
    if (ok) await qc.invalidateQueries({ queryKey: qk.notes(paperId) });
  };
  return { draft, saving, error, saved, open, close, setBody, create };
}

export type NoteDraftApi = ReturnType<typeof useNoteDraft>;

/** '새 노트' (at the right end of the colour filter row, above the scroll area): opens a draft; hidden while one is open. */
export function NewNoteButton({ d }: { d: NoteDraftApi }) {
  if (d.draft) return null;
  return (
    <button type="button" data-testid="pn-note-new" className="ml-auto rounded border border-gray-300 px-2 hover:bg-gray-100" onClick={d.open}>
      새 노트
    </button>
  );
}

/** The new note editor while a draft is open (outside the scroll area). */
export function NoteComposer({ d, highlights }: { d: NoteDraftApi; highlights: readonly HighlightDto[] }) {
  if (!d.draft) return null;
  const draft = d.draft;
  const draftHighlight = draft.highlightId ? (highlights.find((h) => h.id === draft.highlightId) ?? null) : null;
  return (
    <div data-testid="pn-note-composer" className="max-h-[50vh] shrink-0 overflow-y-auto rounded border border-blue-200 p-1.5 text-xs">
      <div className="mb-1 text-sl-label font-medium text-gray-600">새 노트</div>
      {draftHighlight && <div className="mb-1 truncate text-sl-label text-gray-500">↳ {draftHighlight.kind === 'text' ? collapseSpaces(draftHighlight.quote?.exact ?? '') : '[영역 하이라이트]'}</div>}
      <NoteEditor key={draft.id} value={draft.body} onChange={d.setBody} saving={d.saving} focusTick={draft.focus} onSave={() => void d.create()} onCancel={d.close} />
      {d.error && <div className="text-red-700">{d.error}</div>}
    </div>
  );
}

/** The notes list (inside the highlight·note scroll area). composing: a new note draft is open (no empty-list hint). */
export function NotesSection({ paperId, highlights, focusNoteId = null, focusNonce = 1, composing = false, saved = null }: { paperId: string; highlights: readonly HighlightDto[]; focusNoteId?: string | null; focusNonce?: number; composing?: boolean; saved?: { noteId: string; tick: number } | null }) {
  const client = usePanelApi();
  const structure = useStructure(paperId, { client });
  const q = useQuery({ queryKey: qk.notes(paperId), queryFn: () => client.call('notes.list', { params: { id: paperId } }) });

  const byId = useMemo(() => new Map(highlights.map((h) => [h.id, h])), [highlights]);
  // Groups: by section (outline order), then notes without a section by page (of their highlight), then the rest.
  const groups = useMemo(() => {
    const out = new Map<string, { label: string; order: number; notes: NoteDto[] }>();
    for (const n of q.data?.notes ?? []) {
      const h = n.highlightId ? (byId.get(n.highlightId) ?? null) : null;
      const sectionId = n.sectionId ?? h?.sectionId ?? null;
      const sec = sectionId ? sectionById(structure.data, sectionId) : null;
      const key = sectionId ? `s:${sectionId}` : h ? `p:${h.page}` : 'x';
      const label = sectionId ? (sec ? `${sec.number ? `${sec.number}. ` : ''}${sec.title}` : '절') : h ? `p. ${h.page}` : '연결 없음';
      const order = sectionId ? (sec?.ordinal ?? 1e6) : h ? 2e6 + h.page : 3e6;
      const g = out.get(key) ?? { label, order, notes: [] };
      g.notes.push(n);
      out.set(key, g);
    }
    return [...out.entries()].sort((a, b) => a[1].order - b[1].order).map(([key, g]) => ({ key, ...g, notes: g.notes.sort((x, y) => x.createdAt - y.createdAt) }));
  }, [q.data, byId, structure.data]);

  return (
    <section data-testid="pn-notes" className="flex flex-col gap-1 border-t border-gray-200 pt-1">
      <div data-testid="pn-notes-header" className="px-2 text-xs font-medium">
        {q.isSuccess ? `노트 ${q.data.notes.length}개` : '노트'}
      </div>
      {q.isError && <div className="text-xs text-red-700">노트를 불러오지 못했습니다</div>}
      {q.isSuccess && groups.length === 0 && !composing && <div className="text-xs text-gray-500">노트가 없습니다. ‘새 노트’ 또는 PDF에서 N을 누르세요.</div>}
      {groups.map((g) => (
        <div key={g.key} data-testid="pn-note-group" data-group={g.key}>
          <div className="px-2 text-sl-label font-medium text-gray-500">{g.label}</div>
          <ul>
            {g.notes.map((n) => (
              <NoteItem key={n.id} note={n} paperId={paperId} highlight={n.highlightId ? (byId.get(n.highlightId) ?? null) : null} focusTick={n.id === focusNoteId ? focusNonce : 0} savedTick={saved && n.id === saved.noteId ? saved.tick : 0} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
