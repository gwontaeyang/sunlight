// Glossary tab (PLAN_M2 3.4 rule 6, BRIEF_D D7). Owner D.
// - List: term (text), definition (StoredMarkup of the SP-Markup source, paired once with the server's citations),
//   origin exactly as the server decided: llm "AI 제안" / llm_edited "AI 제안 · 수정됨" / manual "직접 추가" (also what the
//   server could not match with a suggestion — the wording is true for that too). Manual add, edit, delete.
// - "정의 요청": glossary.define (SSE) → the suggestion is shown, and only the user's "저장" stores it (glossary.create
//   with llmCallId; the definition may be edited first — the server decides the origin). A cut connection is re-sent
//   ONCE with the same clientRequestId (after run.done the server replays the stored suggestion). A replay that ends
//   in run.error{cancelled} (the run was cancelled when the connection dropped before run.done) or result_deleted is
//   not re-sent automatically: "다시 요청" starts with a NEW id.
// - A reader "glossary" action fills the request with the selected term and starts it — unless an AI suggestion whose
//   definition the user edited is still unsaved: then G and "정의 요청" only fill the term and say to save or discard
//   ("버리기") first, so the edited text is never thrown away by a new request (review D-I10-03).
// - GlossarySuggestions: the "용어 제안" buttons under AI answers (only where the server can see an AI source — the AI
//   tab decides that by thread kind and answer position).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { memo, useEffect, useRef, useState } from 'react';
import type { GlossaryTermDto } from '@study-paper/shared/contracts/api';
import type { BlockNode, GlossaryOrigin, ParsedBlocks, TermSuggestion } from '@study-paper/shared/contracts/domain';
import { ApiError } from '../api/client';
import { qk } from '../api/queryKeys';
import { pairStored, StoredMarkup, useStoredPair } from '../markdown/renderStored';
import { useReaderStore } from '../state/readerStore';
import { usePanelApi } from './panelApi';
import { isActive, useRunStream } from './useRunStream';

export const ORIGIN_TEXT: Record<GlossaryOrigin, string> = { llm: 'AI 제안', llm_edited: 'AI 제안 · 수정됨', manual: '직접 추가' };
const TERM_MAX = 200;
const DEF_MAX = 4000;

const saveError = (e: unknown) => (e instanceof ApiError && e.status === 409 ? '이미 있는 용어입니다' : '저장하지 못했습니다');

/** "용어 제안" buttons for an answer's <glossary> suggestions: pressing one stores it (glossary.create). */
export function GlossarySuggestions({ paperId, suggestions, messageId, llmCallId }: { paperId: string; suggestions: readonly TermSuggestion[]; messageId: string; llmCallId: string | null }) {
  const client = usePanelApi();
  const qc = useQueryClient();
  const [state, setState] = useState<Record<string, string>>({});
  if (suggestions.length === 0) return null;
  const save = async (s: TermSuggestion) => {
    setState((x) => ({ ...x, [s.term]: '저장 중…' }));
    try {
      await client.call('glossary.create', { params: { id: paperId }, body: { term: s.term.slice(0, TERM_MAX), definitionKo: s.definition.slice(0, DEF_MAX), sourceMessageId: messageId, ...(llmCallId ? { llmCallId } : {}) } });
      setState((x) => ({ ...x, [s.term]: '용어집에 저장함' }));
      void qc.invalidateQueries({ queryKey: qk.glossary(paperId) });
    } catch (e) {
      setState((x) => ({ ...x, [s.term]: saveError(e) }));
    }
  };
  return (
    <div data-testid="pn-glossary-suggestions" className="mt-1 flex flex-wrap items-center gap-1 border-t border-dashed pt-1 text-sl-label">
      <span className="text-gray-500">용어 제안:</span>
      {suggestions.map((s) => (
        <span key={s.term} className="inline-flex items-center gap-1">
          <button type="button" data-testid="pn-glossary-suggest" data-term={s.term} className="rounded border border-teal-600 px-1.5 text-teal-800 hover:bg-teal-50 disabled:opacity-50" disabled={state[s.term] !== undefined && state[s.term] !== '저장하지 못했습니다'} title={s.definition} onClick={() => void save(s)}>
            {s.term}
          </button>
          {state[s.term] && (
            <span data-testid="pn-glossary-suggest-state" className={state[s.term] === '용어집에 저장함' ? 'text-emerald-700' : state[s.term] === '저장 중…' ? 'text-gray-500' : 'text-red-700'}>
              {state[s.term]}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

const TermItem = memo(function TermItem({ t, paperId }: { t: GlossaryTermDto; paperId: string }) {
  const client = usePanelApi();
  const qc = useQueryClient();
  const pair = useStoredPair(t.definitionKo ?? '', t.citations);
  const jumpToCitation = useReaderStore((s) => s.jumpToCitation);
  const [editing, setEditing] = useState(false);
  const [term, setTerm] = useState(t.term);
  const [def, setDef] = useState(t.definitionKo ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.glossary(paperId) });
  const save = async () => {
    if (busyRef.current) return;
    setError(null);
    const body: { term?: string; definitionKo?: string | null } = {};
    if (term.trim() !== t.term) body.term = term.trim();
    if (def !== (t.definitionKo ?? '')) body.definitionKo = def.trim() === '' ? null : def;
    if (Object.keys(body).length === 0) return setEditing(false);
    busyRef.current = true;
    setBusy(true);
    try {
      await client.call('glossary.patch', { params: { id: t.id }, body });
      setEditing(false);
      await invalidate();
    } catch (e) {
      setError(saveError(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const remove = async () => {
    try {
      await client.call('glossary.delete', { params: { id: t.id } });
      await invalidate();
    } catch {
      setError('삭제하지 못했습니다');
    }
  };
  return (
    <li data-testid="pn-glossary-item" data-term-id={t.id} className="border-b border-gray-100 px-2 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-1">
        <span data-testid="pn-glossary-term" className="font-medium text-gray-900">
          {t.term}
        </span>
        <span data-testid="pn-glossary-origin" data-origin={t.origin} className={`rounded px-1 text-sl-label ${t.origin === 'manual' ? 'bg-gray-100 text-gray-600' : 'bg-teal-50 text-teal-800'}`}>
          {ORIGIN_TEXT[t.origin]}
        </span>
      </div>
      {editing ? (
        <div className="mt-1 flex flex-col gap-1">
          <input data-testid="pn-glossary-edit-term" className="rounded border border-gray-300 px-1" value={term} maxLength={TERM_MAX} onChange={(e) => setTerm(e.target.value)} />
          <textarea data-testid="pn-glossary-edit-def" className="h-16 resize-none rounded border border-gray-300 p-1" value={def} maxLength={DEF_MAX} onChange={(e) => setDef(e.target.value)} />
          <div className="flex gap-1">
            <button type="button" data-testid="pn-glossary-edit-save" className="rounded bg-blue-600 px-2 text-white disabled:opacity-40" disabled={term.trim() === '' || busy} onClick={() => void save()}>
              저장
            </button>
            <button type="button" className="rounded border px-2" onClick={() => setEditing(false)}>
              취소
            </button>
          </div>
        </div>
      ) : (
        t.definitionKo && <StoredMarkup parsed={pair.parsed} paired={pair.paired} onCitationClick={jumpToCitation} />
      )}
      {error && (
        <div data-testid="pn-glossary-error" className="text-red-700">
          {error}
        </div>
      )}
      {!editing && (
        <div className="mt-0.5 flex gap-2 text-sl-label">
          <button
            type="button"
            data-testid="pn-glossary-edit"
            className="text-blue-700"
            onClick={() => {
              setTerm(t.term);
              setDef(t.definitionKo ?? '');
              setEditing(true);
            }}
          >
            수정
          </button>
          {!confirmDelete ? (
            <button type="button" data-testid="pn-glossary-delete" className="text-red-700" onClick={() => setConfirmDelete(true)}>
              삭제
            </button>
          ) : (
            <span className="flex gap-1">
              <span>삭제할까요?</span>
              <button type="button" data-testid="pn-glossary-delete-confirm" className="text-red-700 underline" onClick={() => void remove()}>
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

function ManualAdd({ paperId }: { paperId: string }) {
  const client = usePanelApi();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [def, setDef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const add = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await client.call('glossary.create', { params: { id: paperId }, body: { term: term.trim(), ...(def.trim() ? { definitionKo: def } : {}) } });
      setTerm('');
      setDef('');
      setOpen(false);
      await qc.invalidateQueries({ queryKey: qk.glossary(paperId) });
    } catch (e) {
      setError(saveError(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  if (!open)
    return (
      <button type="button" data-testid="pn-glossary-add" className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-100" onClick={() => setOpen(true)}>
        직접 추가
      </button>
    );
  return (
    <div className="flex flex-col gap-1 rounded border border-gray-200 p-1.5 text-xs">
      <input data-testid="pn-glossary-add-term" className="rounded border border-gray-300 px-1" placeholder="용어" value={term} maxLength={TERM_MAX} onChange={(e) => setTerm(e.target.value)} />
      <textarea data-testid="pn-glossary-add-def" className="h-14 resize-none rounded border border-gray-300 p-1" placeholder="정의 (Markdown·LaTeX)" value={def} maxLength={DEF_MAX} onChange={(e) => setDef(e.target.value)} />
      {error && (
        <div data-testid="pn-glossary-error" className="text-red-700">
          {error}
        </div>
      )}
      <div className="flex gap-1">
        <button type="button" data-testid="pn-glossary-add-save" className="rounded bg-blue-600 px-2 text-white disabled:opacity-40" disabled={term.trim() === '' || busy} onClick={() => void add()}>
          저장
        </button>
        <button type="button" className="rounded border px-2" onClick={() => setOpen(false)}>
          취소
        </button>
      </div>
    </div>
  );
}

/** The suggestion of a glossary_define run.done: its single <term name> item (name + SP-Markup body). */
export function suggestionOf(parsed: unknown): { term: string; body: string } | null {
  const p = parsed as ParsedBlocks | null;
  const item: BlockNode | undefined = p && Array.isArray(p.items) ? p.items[0] : undefined;
  if (!item || item.tag !== 'term' || typeof item.attrs.name !== 'string') return null;
  return { term: item.attrs.name, body: item.body };
}

function DefineRequest({ paperId, preset }: { paperId: string; preset: { term: string; nonce: number } | null }) {
  const client = usePanelApi();
  const qc = useQueryClient();
  const contextReady = useReaderStore((s) => s.paperState.contextReady);
  const run = useRunStream({ client });
  const s = run.state;
  const active = isActive(s);
  const [term, setTerm] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One automatic re-send with the same id per request (a dropped connection); a user cancel is never re-sent.
  const reconnected = useRef<string | null>(null);
  const userCancelled = useRef(false);
  // One glossary.create at a time (a double click must not send it twice).
  const saving = useRef(false);
  const [savingShown, setSavingShown] = useState(false);
  // Review D-I10-03: a request was held because an edited, unsaved suggestion is open ('edited'). Review D-FX2R1-03:
  // or because a save is in flight ('saving') — its completion resets the run, which would abort a request started now.
  const [blocked, setBlocked] = useState<'edited' | 'saving' | null>(null);

  const suggestion = s.phase === 'done' && s.done ? suggestionOf(s.done.parsed) : null;
  const sugPair = suggestion && s.done ? pairStored(suggestion.body, s.done.citations) : null;
  // The user changed the suggested definition and has not saved it: a new request would throw it away.
  const editedDraft = suggestion !== null && draft !== null && draft !== suggestion.body;

  const start = (t: string) => {
    const v = t.trim().slice(0, TERM_MAX);
    if (!v || !contextReady) return;
    if (saving.current) {
      // The term input is filled (by the caller); the request can be made once the save ended.
      setBlocked('saving');
      return;
    }
    if (editedDraft) {
      // Keep the edited text: the term input is filled (by the caller), nothing starts until it is saved or discarded.
      setBlocked('edited');
      return;
    }
    setBlocked(null);
    setDraft(null);
    setSaved(null);
    setError(null);
    reconnected.current = null;
    userCancelled.current = false;
    void run.start({ route: 'glossary.define', params: { id: paperId }, body: { term: v } });
  };

  useEffect(() => {
    if (!preset) return;
    setTerm(preset.term.slice(0, TERM_MAX));
    start(preset.term);
  }, [preset?.nonce]);

  // A dropped connection: re-send once with the SAME clientRequestId (the server replays or reports cancelled).
  useEffect(() => {
    const e = s.error;
    if (!e || (e.source !== 'stream' && e.code !== 'network') || userCancelled.current) return;
    if (s.clientRequestId && reconnected.current !== s.clientRequestId) {
      reconnected.current = s.clientRequestId;
      void run.retry();
    }
  }, [s.error, s.clientRequestId, run]);

  const discard = () => {
    setDraft(null);
    setBlocked(null);
    // A failed save's error was about this suggestion, which is gone now (review D-FX2R3-02).
    setError(null);
    run.reset();
  };
  const save = async () => {
    if (!suggestion || saving.current) return;
    saving.current = true;
    setSavingShown(true);
    setError(null);
    try {
      await client.call('glossary.create', { params: { id: paperId }, body: { term: suggestion.term, definitionKo: (draft ?? suggestion.body).slice(0, DEF_MAX), ...(s.runId ? { llmCallId: s.runId } : {}) } });
      setSaved(suggestion.term);
      setDraft(null);
      setBlocked(null);
      run.reset();
      // The save ends with glossary.create (the finally below): the list refetch is not waited for, so "저장 중" and
      // the held / disabled "정의 요청" do not outlast "저장했습니다" (review D-FX2R3-02).
      void qc.invalidateQueries({ queryKey: qk.glossary(paperId) });
    } catch (e) {
      setError(saveError(e));
      // A request held during a failed save of an edited draft stays held for that draft (save or discard first).
      if (editedDraft) setBlocked((b) => (b === 'saving' ? 'edited' : b));
    } finally {
      saving.current = false;
      setSavingShown(false);
      // A request held only for the save may be made now.
      setBlocked((b) => (b === 'saving' ? null : b));
    }
  };
  const err = s.error;
  // A cancelled run the user did not cancel (the connection dropped before run.done, or the server cancelled it):
  // never re-sent automatically — "다시 요청" starts with a NEW id.
  const lostBeforeDone = err?.code === 'cancelled' && !userCancelled.current;
  const manualReconnect = err && (err.source === 'stream' || err.code === 'network') && reconnected.current === s.clientRequestId;

  return (
    <div data-testid="pn-glossary-define" className="flex flex-col gap-1 rounded border border-gray-200 p-1.5 text-xs">
      <div className="flex gap-1">
        <input data-testid="pn-glossary-define-term" className="min-w-0 flex-1 rounded border border-gray-300 px-1" placeholder="정의를 요청할 용어" value={term} maxLength={TERM_MAX} onChange={(e) => setTerm(e.target.value)} />
        {active ? (
          <button
            type="button"
            data-testid="pn-glossary-define-cancel"
            className="rounded border border-gray-300 px-2"
            onClick={() => {
              userCancelled.current = true;
              void run.cancel();
            }}
          >
            취소
          </button>
        ) : (
          <button type="button" data-testid="pn-glossary-define-start" className="rounded bg-teal-700 px-2 text-white disabled:opacity-40" disabled={!contextReady || term.trim() === '' || savingShown} title={contextReady ? (savingShown ? '저장 중' : undefined) : '색인 준비 중'} onClick={() => start(term)}>
            정의 요청
          </button>
        )}
      </div>
      {active && (
        <div data-testid="pn-glossary-define-progress" className="text-gray-600">
          {s.phase === 'queued' ? `대기 중 · 순번 ${s.queuedPosition ?? '?'}` : s.retrying && s.text === '' ? '형식 오류로 다시 요청 중…' : s.phase === 'running' && s.text === '' ? '생각 중…' : '정의 받는 중…'}
        </div>
      )}
      {suggestion && sugPair && (
        <div data-testid="pn-glossary-suggestion" className="rounded bg-teal-50 p-1">
          <div className="text-sl-label text-teal-800">
            AI 제안 · <span className="font-medium">{suggestion.term}</span> (저장해야 용어집에 들어갑니다)
          </div>
          {draft === null ? (
            <StoredMarkup parsed={sugPair.parsed} paired={sugPair.paired} />
          ) : (
            // The save sends the text as it was when "저장" was pressed and clears the draft on success: no edits while it
            // is in flight (like the note editor, D-S1-01; review D-FX2R2-02).
            <textarea data-testid="pn-glossary-suggestion-edit" className="h-16 w-full resize-none rounded border border-gray-300 p-1" value={draft} maxLength={DEF_MAX} readOnly={savingShown} onChange={(e) => setDraft(e.target.value)} />
          )}
          <div className="mt-1 flex gap-1">
            <button type="button" data-testid="pn-glossary-suggestion-save" className="rounded bg-teal-700 px-2 text-white disabled:opacity-50" disabled={savingShown} onClick={() => void save()}>
              {savingShown ? '저장 중…' : '저장'}
            </button>
            {draft === null && (
              <button type="button" data-testid="pn-glossary-suggestion-modify" className="rounded border px-2 disabled:opacity-50" disabled={savingShown} onClick={() => setDraft(suggestion.body)}>
                고쳐서 저장
              </button>
            )}
            <button type="button" data-testid="pn-glossary-suggestion-discard" className="rounded border px-2 text-gray-600" disabled={savingShown} onClick={discard}>
              버리기
            </button>
          </div>
        </div>
      )}
      {blocked === 'saving' && savingShown ? (
        <div data-testid="pn-glossary-define-blocked" data-reason="saving" className="text-amber-800">
          제안을 저장 중입니다 — 저장이 끝난 뒤 ‘정의 요청’을 누르세요
        </div>
      ) : (
        blocked !== null &&
        editedDraft && (
          <div data-testid="pn-glossary-define-blocked" data-reason="edited" className="text-amber-800">
            저장하지 않은 고친 정의가 있습니다 — 저장하거나 버린 뒤 요청하세요
          </div>
        )
      )}
      {s.phase === 'done' && !suggestion && <div className="text-amber-700">제안을 해석하지 못했습니다</div>}
      {saved && <div data-testid="pn-glossary-saved" className="text-emerald-700">‘{saved}’을(를) 용어집에 저장했습니다</div>}
      {error && (
        <div data-testid="pn-glossary-error" className="text-red-700">
          {error}
        </div>
      )}
      {err && !manualReconnect && err.code !== 'cancelled' && err.code !== 'result_deleted' && err.source !== 'stream' && err.code !== 'network' && (
        <div data-testid="pn-glossary-define-error" data-code={err.code} className="text-red-700">
          {err.message}
        </div>
      )}
      {err && err.code === 'cancelled' && userCancelled.current && <div className="text-gray-600">취소했습니다</div>}
      {(lostBeforeDone || err?.code === 'result_deleted') && (
        <div data-testid="pn-glossary-define-lost" data-code={err!.code} className="flex items-center gap-1 text-amber-800">
          {err!.code === 'result_deleted' ? '이 요청의 결과가 더 이상 없습니다' : reconnected.current !== null ? '연결이 끊겨 취소됨' : '취소됨'}
          <button type="button" data-testid="pn-glossary-define-again" className="rounded border border-amber-600 px-1.5" onClick={() => start(term)}>
            다시 요청
          </button>
        </div>
      )}
      {manualReconnect && (
        <div className="flex items-center gap-1 text-amber-800">
          연결이 끊겼습니다
          <button type="button" data-testid="pn-glossary-define-reconnect" className="rounded border border-amber-600 px-1.5" onClick={() => void run.retry()}>
            다시 연결
          </button>
        </div>
      )}
    </div>
  );
}

export function GlossaryTab({ paperId }: { paperId: string }) {
  const client = usePanelApi();
  const pendingAction = useReaderStore((s) => s.pendingAction);
  const consumeAction = useReaderStore((s) => s.consumeAction);
  const [preset, setPreset] = useState<{ term: string; nonce: number } | null>(null);
  const q = useQuery({ queryKey: qk.glossary(paperId), queryFn: () => client.call('glossary.list', { params: { id: paperId } }) });

  // Reader action "glossary" (G): define the selected term.
  useEffect(() => {
    const a = useReaderStore.getState().pendingAction;
    if (!a || a.kind !== 'glossary') return;
    consumeAction();
    const t = (a.text ?? a.anchor?.quote?.exact ?? '').replace(/\s+/g, ' ').trim();
    if (t) setPreset((p) => ({ term: t, nonce: (p?.nonce ?? 0) + 1 }));
  }, [pendingAction, consumeAction]);

  const terms = [...(q.data?.terms ?? [])].sort((a, b) => a.term.localeCompare(b.term));
  return (
    <div data-testid="pn-glossary-tab" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
      <DefineRequest paperId={paperId} preset={preset} />
      <ManualAdd paperId={paperId} />
      {q.isError && <div className="text-xs text-red-700">용어집을 불러오지 못했습니다</div>}
      {q.isSuccess && terms.length === 0 && <div className="text-xs text-gray-500">용어집이 비어 있습니다</div>}
      <ul data-testid="pn-glossary-list">
        {terms.map((t) => (
          <TermItem key={t.id} t={t} paperId={paperId} />
        ))}
      </ul>
    </div>
  );
}
