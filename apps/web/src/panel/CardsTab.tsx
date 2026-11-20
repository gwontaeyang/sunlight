// Cards tab (PLAN_M2 3.4, BRIEF_D D4): 요약 / 표기·규약 / 가정·실패 모드. Owner D.
// - Generate: cards.generate (SSE) with progress only (queue position, "생각 중", characters received — the SP-Blocks
//   text itself is never shown while streaming), run.retrying, cancel. A 409 conflict with details.reason
//   'card_generating' (another window / an earlier request is generating this kind — D22) is not an error: its runId
//   is polled with llm.runs.get every 2 s until the run is terminal. A cut connection is re-sent with the SAME
//   clientRequestId (useRunStream.retry). Coming back to a card list with a generating card polls its runId the same
//   way (cards.list every 5 s when runId is null).
// - The watch always ends with a way out: a run that is terminal while cards.list still says 'generating' (the
//   mismatch PLAN_M2 3.4 lets the next generate request clean up), or llm.runs.get failing RUN_GET_FAIL_LIMIT times in
//   a row (then cards.list every 5 s), shows "생성 상태를 확인하지 못했습니다" with the "다시 생성" button.
// - Items: title (server constant) · item badge · body (StoredMarkup; notation/assumptions labels:'strip', summary
//   'badge') · "확인함" · memo (plain). ONE pairStored per item: its `paired` gives the body chips, the item badge
//   (itemBadge) and — through those badges only — the header counts (cardBadgeCounts).
// - "확인함" / memo → cardItems.patch, optimistic, serialised per item, restored from the server on failure.
// - A cards.list refetch that fails keeps the sections drawn from the last data, with one error line + "다시 시도"
//   (review D-I10-02). After the section's own run.done, "생성이 끝났습니다 · 카드 목록을 불러오는 중" replaces the buttons
//   until a cards.list read after it succeeds (a failed one is re-read every 5 s) — never a second generate on a list
//   that does not have the new card yet (review D-FX2R3-01), not even for one commit: the check ends in the same
//   notifyManager flush as the new list or after it (review D-FX2BR2-01).
import { notifyManager, useQuery, useQueryClient } from '@tanstack/react-query';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CardItemDto, ListCardsResponse, PaperCardDto } from '@study-paper/shared/contracts/api';
import { ASSUMPTION_CATEGORIES, ASSUMPTION_CATEGORY_KO, type PaperCardKind } from '@study-paper/shared/contracts/domain';
import { parseConflictDetails } from '@study-paper/shared/contracts/errors';
import { cardBadgeCounts, itemBadge, type ItemBadge } from '@study-paper/shared/contracts/grounding';
import { qk } from '../api/queryKeys';
import { ItemBadgeView, ItemLetter, pairStored, StoredMarkup, useStoredPair, type StoredPair } from '../markdown/renderStored';
import { useReaderStore } from '../state/readerStore';
import { LoadError } from './loadError';
import { usePanelApi } from './panelApi';
import { isActive, runErrorText, useRunStream, type RunStreamState } from './useRunStream';

export const CARD_KIND_TEXT: Record<PaperCardKind, string> = { summary: '요약', notation: '표기·규약', assumptions: '가정·실패 모드' };
const CARD_KINDS: readonly PaperCardKind[] = ['summary', 'notation', 'assumptions'];
export const REGENERATE_CONFIRM = "항목의 '확인함'이 초기화됩니다(표기 카드의 메모는 유지)";
const POLL_RUN_MS = 2000;
const POLL_LIST_MS = 5000;
/** Consecutive llm.runs.get failures before the watch falls back to cards.list polling and offers "다시 생성". */
export const RUN_GET_FAIL_LIMIT = 5;
const TERMINAL_RUN = new Set(['ok', 'error', 'cancelled', 'timeout', 'interrupted']);

/** Header count labels, in display order (cardBadgeCounts keys). */
const COUNT_TEXT: [Exclude<ItemBadge, 'none'>, string][] = [
  ['grounded_quote', '논문 근거'],
  ['equation_ref', '식 참조만'],
  ['unverified', '근거 미확인'],
  ['not_stated', '명시 없음'],
  ['general', '일반 지식'],
  ['unconfirmed', '확인 안 됨'],
];

/** Header counts of a notation / assumptions card: cardBadgeCounts over the item badges (zeros omitted) + 확인함 n / 전체. */
export function CardHeaderCounts({ badges, confirmed, total }: { badges: readonly ItemBadge[]; confirmed: number; total: number }) {
  const counts = cardBadgeCounts(badges);
  return (
    <div data-testid="pn-card-counts" className="flex flex-wrap gap-x-2 px-3 pt-2 text-sl-label text-sl-meta">
      {COUNT_TEXT.filter(([k]) => counts[k] > 0).map(([k, label]) => (
        <span key={k} data-count={k}>
          {label} {counts[k]}
        </span>
      ))}
      <span data-count="confirmed">
        확인함 {confirmed} / {total}
      </span>
    </div>
  );
}

export type ItemChange = { confirmed?: boolean; userNote?: string | null };

/** Optimistic, per-item serialised cardItems.patch; a failure restores the server value (refetch). */
function useItemPatcher(paperId: string) {
  const client = usePanelApi();
  const qc = useQueryClient();
  const [overrides, setOverrides] = useState<Record<string, ItemChange>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const chains = useRef(new Map<string, Promise<void>>());
  const pending = useRef(new Map<string, number>());
  const patch = useCallback(
    (itemId: string, change: ItemChange) => {
      setOverrides((o) => ({ ...o, [itemId]: { ...o[itemId], ...change } }));
      setFailed((f) => ({ ...f, [itemId]: false }));
      pending.current.set(itemId, (pending.current.get(itemId) ?? 0) + 1);
      let ok = true;
      const send = async () => {
        try {
          const dto = await client.call('cardItems.patch', { params: { id: itemId }, body: change });
          qc.setQueryData<ListCardsResponse>(qk.cards(paperId), (old) => (old ? { cards: old.cards.map((c) => ({ ...c, items: c.items.map((it) => (it.id === dto.id ? dto : it)) })) } : old));
        } catch {
          ok = false;
          setFailed((f) => ({ ...f, [itemId]: true }));
        } finally {
          const n = (pending.current.get(itemId) ?? 1) - 1;
          pending.current.set(itemId, n);
          if (!ok) await qc.invalidateQueries({ queryKey: qk.cards(paperId) });
          if (n === 0) {
            setOverrides((o) => {
              const { [itemId]: _drop, ...rest } = o;
              return rest;
            });
          }
        }
      };
      const next = (chains.current.get(itemId) ?? Promise.resolve()).then(send);
      chains.current.set(itemId, next);
    },
    [client, qc, paperId],
  );
  return { overrides, failed, patch };
}

interface ItemViewProps {
  item: CardItemDto;
  kind: PaperCardKind;
  pair: StoredPair;
  badge: ItemBadge;
  override?: ItemChange;
  failed: boolean;
  onPatch: (itemId: string, change: ItemChange) => void;
}

const CardItemView = memo(function CardItemView({ item, kind, pair, badge, override, failed, onPatch }: ItemViewProps) {
  const confirmed = override?.confirmed ?? item.confirmed;
  const userNote = override && 'userNote' in override ? (override.userNote ?? null) : item.userNote;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const jumpToCitation = useReaderStore((s) => s.jumpToCitation);
  const stated = item.category === 'limitation' ? item.attrs.stated : undefined;
  return (
    <li data-testid="pn-card-item" data-item-id={item.id} data-key={item.key ?? undefined} className={`mx-3 border-b border-sl-line py-2.5 text-sl-ui last:border-b-0 ${kind !== 'summary' ? 'grid grid-cols-[22px_minmax(0,1fr)] gap-x-2.5' : ''}`}>
      {kind !== 'summary' && <ItemLetter badge={badge} />}
      <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-1">
        {item.title && <span className="text-sl-reading font-semibold text-sl-ink">{item.title}</span>}
        {kind !== 'summary' && <ItemBadgeView badge={badge} quiet />}
        {stated && (
          <span data-testid="pn-card-stated" className="rounded bg-gray-100 px-1 text-sl-label text-gray-600">
            {stated === 'author' ? '저자 명시' : '추론'}
          </span>
        )}
        <label className="ml-auto flex items-center gap-1 text-sl-label text-sl-meta">
          <input type="checkbox" data-testid="pn-card-confirm" className="accent-[var(--color-sl-accent)]" checked={confirmed} onChange={(e) => onPatch(item.id, { confirmed: e.target.checked })} />
          확인함
        </label>
      </div>
      <StoredMarkup parsed={pair.parsed} paired={pair.paired} onCitationClick={jumpToCitation} />
      {!editing && userNote && <NotePreview text={userNote} />}
      {editing ? (
        <div className="mt-1 flex flex-col gap-1">
          <textarea data-testid="pn-card-note-input" className="h-12 w-full resize-none rounded border border-gray-300 p-1" value={draft} maxLength={8000} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex gap-1">
            <button
              type="button"
              data-testid="pn-card-note-save"
              className="rounded bg-blue-600 px-2 text-white"
              onClick={() => {
                onPatch(item.id, { userNote: draft.trim() === '' ? null : draft });
                setEditing(false);
              }}
            >
              저장
            </button>
            <button type="button" className="rounded border px-2" onClick={() => setEditing(false)}>
              취소
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          data-testid="pn-card-note-edit"
          className="mt-0.5 text-sl-label text-blue-700"
          onClick={() => {
            setDraft(userNote ?? '');
            setEditing(true);
          }}
        >
          {userNote ? '메모 수정' : '메모 추가'}
        </button>
      )}
      {failed && (
        <div data-testid="pn-card-patch-error" className="text-red-700">
          저장하지 못해 서버 값으로 되돌렸습니다
        </div>
      )}
      </div>
    </li>
  );
});

/** A user memo: plain text through the same renderer (no chips, no badges). */
function NotePreview({ text }: { text: string }) {
  const pair = useStoredPair(text, [], { mode: 'plain' });
  return (
    <div data-testid="pn-card-note" className="mt-1 rounded bg-yellow-50 px-1.5 py-0.5">
      <StoredMarkup parsed={pair.parsed} paired={pair.paired} />
    </div>
  );
}

/**
 * ONE pairing per item object. A patch replaces only the patched item in the cards.list cache (unchanged items keep
 * their identity, also through react-query's structural sharing on a refetch), so only that item is parsed and
 * paired again and the memoised item views of the others are not redrawn.
 */
const itemPairs = new WeakMap<CardItemDto, { labels: 'badge' | 'strip'; pair: StoredPair }>();
function pairOfItem(it: CardItemDto, labels: 'badge' | 'strip'): StoredPair {
  const hit = itemPairs.get(it);
  if (hit && hit.labels === labels) return hit.pair;
  const pair = pairStored(it.bodyMd, it.citations, { labels });
  itemPairs.set(it, { labels, pair });
  return pair;
}

/** One card's items + header counts (exported for the provenance fuzz test). */
export function CardBody({ card, overrides, failed, onPatch }: { card: PaperCardDto; overrides: Record<string, ItemChange>; failed: Record<string, boolean>; onPatch: ItemViewProps['onPatch'] }) {
  const kind = card.kind;
  // ONE pairing per item; the item badges come from it and the header counts from the badges.
  const pairs = useMemo(() => card.items.map((it) => pairOfItem(it, kind === 'summary' ? 'badge' : 'strip')), [card.items, kind]);
  const badges = useMemo(() => card.items.map((it, i) => itemBadge(it.label, pairs[i]!.paired)), [card.items, pairs]);
  const confirmed = card.items.filter((it) => overrides[it.id]?.confirmed ?? it.confirmed).length;
  const view = (it: CardItemDto, i: number) => <CardItemView key={it.id} item={it} kind={kind} pair={pairs[i]!} badge={badges[i]!} override={overrides[it.id]} failed={failed[it.id] === true} onPatch={onPatch} />;
  const indexed = card.items.map((it, i) => [it, i] as const);
  return (
    <div data-testid="pn-card" data-card-id={card.id} data-kind={kind}>
      {kind !== 'summary' && <CardHeaderCounts badges={badges} confirmed={confirmed} total={card.items.length} />}
      {kind === 'assumptions' ? (
        ASSUMPTION_CATEGORIES.filter((c) => card.items.some((it) => it.category === c)).map((c) => (
          <div key={c} data-testid="pn-card-category" data-category={c}>
            <div className="mx-3 mt-2 text-sl-label font-medium text-sl-meta">{ASSUMPTION_CATEGORY_KO[c]}</div>
            <ul>{indexed.filter(([it]) => it.category === c).map(([it, i]) => view(it, i))}</ul>
          </div>
        ))
      ) : (
        <ul>{indexed.map(([it, i]) => view(it, i))}</ul>
      )}
    </div>
  );
}

/** The card being watched: the run generating it (null = poll cards.list only) and its card id. */
interface WatchTarget {
  runId: string | null;
  cardId: string;
  /** The run is already known to be terminal: the first successful cards.list read decides (review D-FX2R3-01). */
  runTerminal?: boolean;
}

interface WatchHandlers {
  /** Polling ended: the run is terminal (or the list no longer shows the card generating); cards.list was re-read. */
  onDone: (cardId: string, stillGenerating: boolean) => void;
  /** llm.runs.get failed RUN_GET_FAIL_LIMIT times in a row: the watch continues with cards.list only. */
  onUnknown: (cardId: string) => void;
}

const cardIn = (data: ListCardsResponse | undefined, cardId: string) => data?.cards.find((c) => c.id === cardId) ?? null;

/**
 * Polls llm.runs.get(runId) every 2 s until the run is terminal, or — without a runId, or after RUN_GET_FAIL_LIMIT
 * consecutive failures — cards.list every 5 s until that card is no longer 'generating'. A terminal run whose
 * cards.list read fails also falls back to that cards.list polling (a failed read decides nothing); there the next
 * successful read decides as the terminal path does, so a card still 'generating' ends as "uncertain". A target with
 * `runTerminal` (no runId) starts in that list-only, terminal mode.
 */
function useGeneratingWatch(paperId: string, target: WatchTarget | null, handlers: WatchHandlers) {
  const client = usePanelApi();
  const qc = useQueryClient();
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const runId = target?.runId ?? null;
  const cardId = target?.cardId ?? null;
  const knownTerminal = target?.runTerminal === true;
  useEffect(() => {
    if (cardId === null) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let listOnly = runId === null;
    // The run was read as terminal but the cards.list read after it failed: the next successful read decides exactly
    // as it would have then, "still generating" included (review D-FX2R2-01). The same from the start when the
    // caller already knows the run is terminal (its own run.done — review D-FX2R3-01).
    let runTerminal = knownTerminal;
    // Re-reads cards.list: true = the card is still 'generating', false = it is not, null = the read failed. After a
    // failed refetch the cache still holds the previous data (the card 'generating'), which says nothing about now
    // (review D-FX2R1-01).
    const reread = async (): Promise<boolean | null> => {
      await qc.invalidateQueries({ queryKey: qk.cards(paperId) });
      if (qc.getQueryState(qk.cards(paperId))?.status === 'error') return null;
      return cardIn(qc.getQueryData<ListCardsResponse>(qk.cards(paperId)), cardId)?.status === 'generating';
    };
    const tick = async () => {
      if (!listOnly && runId) {
        try {
          const r = await client.call('llm.runs.get', { params: { runId } });
          if (!alive) return;
          failures = 0;
          if (TERMINAL_RUN.has(r.status)) {
            const still = await reread();
            if (!alive) return;
            if (still !== null) {
              handlersRef.current.onDone(cardId, still);
              return;
            }
            // The run is terminal but the list could not be read: decide on the next successful cards.list read.
            runTerminal = true;
            listOnly = true;
          }
        } catch {
          if (!alive) return;
          // The run may not be visible yet; after RUN_GET_FAIL_LIMIT failures in a row stop asking for it.
          if (++failures >= RUN_GET_FAIL_LIMIT) {
            listOnly = true;
            handlersRef.current.onUnknown(cardId);
          }
        }
      } else {
        const still = await reread();
        if (!alive) return;
        // A failed read (null) keeps polling. After a terminal run any successful read decides (as onDone above).
        if (still === false || (still === true && runTerminal)) {
          handlersRef.current.onDone(cardId, still);
          return;
        }
      }
      if (alive) timer = setTimeout(() => void tick(), listOnly ? POLL_LIST_MS : POLL_RUN_MS);
    };
    timer = setTimeout(() => void tick(), listOnly ? POLL_LIST_MS : 0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [client, qc, paperId, runId, cardId, knownTerminal]);
}

/** A generating card whose state could not be confirmed: its run ended (or cannot be read) but the list still says generating. */
interface Uncertain {
  cardId: string;
  reason: 'terminal' | 'unknown';
}

/** How the cards.list read after this section's own run.done went, keyed by that request's clientRequestId. */
interface DoneRead {
  requestId: string;
  ok: boolean;
}

function CardSection({ paperId, kind, cards, contextReady }: { paperId: string; kind: PaperCardKind; cards: readonly PaperCardDto[]; contextReady: boolean }) {
  const client = usePanelApi();
  const qc = useQueryClient();
  const [doneRead, setDoneRead] = useState<DoneRead | null>(null);
  const run = useRunStream({
    client,
    onSettled: (st) =>
      void (async () => {
        await qc.invalidateQueries({ queryKey: qk.cards(paperId) });
        if (st.phase === 'done' && st.clientRequestId) {
          const next: DoneRead = { requestId: st.clientRequestId, ok: qc.getQueryState(qk.cards(paperId))?.status !== 'error' };
          // Through the notifyManager (review D-FX2BR2-01): useQuery gets the new list a notify tick after the fetch, so
          // ending "checking" now would commit the OLD list without it first ("생성" on a list without the new card).
          notifyManager.schedule(() => setDoneRead(next));
        }
      })(),
  });
  const s = run.state;
  const active = isActive(s);
  const patcher = useItemPatcher(paperId);
  const [confirming, setConfirming] = useState(false);
  const [conflict, setConflict] = useState<WatchTarget | null>(null);
  const [uncertain, setUncertain] = useState<Uncertain | null>(null);
  // A cut stream (before run.accepted, so no artifactId) whose card the watch then saw finish (review D-R2-03).
  const [settledCut, setSettledCut] = useState<RunStreamState['error'] | null>(null);

  const ofKind = cards.filter((c) => c.kind === kind).sort((a, b) => b.createdAt - a.createdAt);
  const complete = ofKind.find((c) => c.status === 'complete') ?? null;
  const newer = ofKind.find((c) => c.status !== 'complete' && (!complete || c.createdAt >= complete.createdAt)) ?? null;

  // 409 card_generating: watch the run that is already generating (never shown as an error).
  useEffect(() => {
    if (s.error?.code !== 'card_generating') return;
    const d = parseConflictDetails(s.error.details);
    if (d?.reason === 'card_generating') setConflict({ runId: d.runId, cardId: d.cardId });
  }, [s.error]);
  // The card of this section's own run (run.accepted.artifactId), as the last cards.list read has it.
  const runCard = s.artifactId ? (cards.find((c) => c.id === s.artifactId) ?? null) : null;
  // Review D-FX2R3-01: after this section's own run.done the result is "being checked" until a cards.list read made
  // after it succeeds. Until then the list on screen is from before (or the read after run.done failed): it does not
  // have the new card, and "생성" / "다시 생성" on it would start one more LLM run. A failed read polls cards.list
  // (5 s, list only — the run is known to be terminal) until the first successful read, which decides as a terminal run
  // does ("uncertain" when the card still says generating, nothing to watch when it is not in the list).
  const doneId = s.phase === 'done' ? s.clientRequestId : null;
  const read = doneId !== null && doneRead?.requestId === doneId ? doneRead : null;
  const checking = doneId !== null && !(runCard !== null && runCard.status !== 'generating') && read?.ok !== true;
  // Any successful cards.list fetch after the failed one ends the check ("다시 시도" above included); a manual cache
  // write (an item patch) is not a read of the list. The end is scheduled on the notifyManager, after useQuery's own
  // notification of the same fetch (queued first in this dispatch's batch), so it never commits before the new list.
  useEffect(() => {
    if (!checking || read === null) return;
    const cache = qc.getQueryCache();
    return cache.subscribe((e) => {
      if (e.type === 'updated' && e.action.type === 'success' && !e.action.manual && e.query === cache.find({ queryKey: qk.cards(paperId), exact: true })) notifyManager.schedule(() => setDoneRead({ ...read, ok: true }));
    });
  }, [checking, read, qc, paperId]);
  const listGen = !active && !checking && newer?.status === 'generating' ? newer : null;
  // Without an artifactId the check has no card to look for: the first successful read just ends it ('' matches none).
  const checkWatch: WatchTarget | null = checking && read !== null ? { runId: null, cardId: s.artifactId ?? '', runTerminal: true } : null;
  const watch: WatchTarget | null = active ? null : checking ? checkWatch : (conflict ?? (listGen ? { runId: listGen.runId, cardId: listGen.id } : null));
  // "다시 생성" is offered again for the watched card once its state could not be confirmed. A run that is terminal
  // is not polled any more (the server cleans the row up on the next generate request); an unreadable run keeps the
  // cards.list polling so a late completion still shows up.
  const uncertainHere = uncertain !== null && watch !== null && uncertain.cardId === watch.cardId ? uncertain : null;
  useGeneratingWatch(paperId, uncertainHere?.reason === 'terminal' ? null : watch, {
    onDone: (cardId, still) => {
      setConflict(null);
      setUncertain(still ? { cardId, reason: 'terminal' } : null);
      // Without an artifactId the cut request's card is the one this watch followed: only one card of a kind can be
      // generating (another request gets 409 card_generating before any stream), so once it finished the cut is no
      // longer news either.
      if (!still && !s.artifactId && (s.error?.source === 'stream' || s.error?.source === 'aborted')) setSettledCut(s.error);
    },
    onUnknown: (cardId) => setUncertain({ cardId, reason: 'unknown' }),
  });

  const generating = active || checking || (watch !== null && uncertainHere === null);
  const generate = () => {
    setConfirming(false);
    setConflict(null);
    setUncertain(null);
    void run.start({ route: 'cards.generate', params: { id: paperId, kind }, body: {} });
  };
  const failedCard = !generating && newer && newer.status !== 'generating' ? newer : null;
  // A cut connection is no longer news once cards.list shows the run's card finished (complete / failed).
  const cut = s.error?.source === 'stream' || s.error?.source === 'aborted';
  const settledAfterCut = cut && ((runCard !== null && runCard.status !== 'generating') || (settledCut !== null && settledCut === s.error));
  // A run that ended with run.error is described by its failed card once cards.list has it.
  const err = s.error && s.error.code !== 'card_generating' && !settledAfterCut && !(s.error.source === 'run' && failedCard) ? s.error : null;

  return (
    <section data-testid="pn-card-section" data-kind={kind} className="shrink-0 overflow-hidden rounded-[10px] border border-sl-line">
      <div className="flex items-center gap-2 border-b border-sl-line bg-sl-subtle px-3 py-2 text-sl-label">
        <span className="text-sl-reading font-semibold text-sl-ink">{CARD_KIND_TEXT[kind]} 카드</span>
        {!generating && (
          <button
            type="button"
            data-testid={complete || newer ? 'pn-card-regenerate' : 'pn-card-generate'}
            className="ml-auto rounded-sl-chip border border-sl-accent-line px-2 text-sl-accent hover:bg-sl-accent-soft disabled:opacity-40"
            disabled={!contextReady}
            title={contextReady ? undefined : '색인 준비 중 — 준비가 끝나면 만들 수 있습니다'}
            onClick={() => (complete ? setConfirming(true) : generate())}
          >
            {complete || newer ? '다시 생성' : '생성'}
          </button>
        )}
        {active && (
          <button type="button" data-testid="pn-card-cancel" className="ml-auto rounded border border-gray-300 px-2 hover:bg-gray-100 disabled:opacity-50" disabled={s.cancelling} onClick={() => void run.cancel()}>
            {s.cancelling ? '취소 중…' : '취소'}
          </button>
        )}
      </div>
      {confirming && (
        <div role="dialog" aria-label="다시 생성 확인" data-testid="pn-card-regen-dialog" className="flex flex-wrap items-center gap-1 bg-amber-50 px-2 py-1 text-xs">
          <span>{REGENERATE_CONFIRM}</span>
          <button type="button" data-testid="pn-card-regen-confirm" className="rounded bg-sl-accent px-2 text-sl-on-accent" onClick={generate}>
            다시 생성
          </button>
          <button type="button" className="rounded border px-2" onClick={() => setConfirming(false)}>
            취소
          </button>
        </div>
      )}
      {checking ? (
        <div data-testid="pn-card-checking" className="px-2 py-1 text-xs text-gray-600">
          생성이 끝났습니다 · 카드 목록을 불러오는 중
        </div>
      ) : (
        generating && <CardProgress run={run} watching={!active} />
      )}
      {uncertainHere && !active && (
        <div data-testid="pn-card-uncertain" data-reason={uncertainHere.reason} className="px-2 py-1 text-xs text-amber-800">
          생성 상태를 확인하지 못했습니다 — ‘다시 생성’을 누르면 서버가 이전 요청을 정리하고 새로 만듭니다
        </div>
      )}
      {err && (
        <div data-testid="pn-card-error" data-code={err.code} className="px-2 py-1 text-xs text-red-700">
          {err.message}
          {(err.source === 'stream' || err.code === 'network') && (
            <button type="button" data-testid="pn-card-reconnect" className="ml-1 rounded border border-gray-300 px-1 text-gray-700" onClick={() => void run.retry()}>
              다시 연결
            </button>
          )}
        </div>
      )}
      {failedCard && <FailedCard card={failedCard} />}
      {complete ? <CardBody card={complete} overrides={patcher.overrides} failed={patcher.failed} onPatch={patcher.patch} /> : !generating && !failedCard && !uncertainHere && <div className="px-2 py-1 text-xs text-gray-500">아직 만들지 않았습니다</div>}
    </section>
  );
}

function CardProgress({ run, watching }: { run: ReturnType<typeof useRunStream>; watching: boolean }) {
  const s = run.state;
  let text: string;
  if (watching) text = '생성 중 · 다른 요청이 만들고 있습니다 (끝나면 자동으로 표시)';
  else if (s.phase === 'queued') text = `대기 중 · 순번 ${s.queuedPosition ?? '?'}`;
  else if (s.retrying && s.text === '') text = '형식 오류로 다시 요청 중…';
  else if (s.phase === 'running' && s.text === '') text = '생각 중…';
  else if (s.phase === 'running') text = `생성 중 · 받은 글자 ${s.text.length.toLocaleString()}자`;
  else text = '요청을 보내는 중…';
  return (
    <div data-testid="pn-card-progress" className="flex items-center gap-1 px-2 py-1 text-xs text-gray-600">
      <span aria-hidden className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />
      {text}
    </div>
  );
}

function FailedCard({ card }: { card: PaperCardDto }) {
  if (card.status === 'parse_failed') {
    return (
      <div data-testid="pn-card-failed" data-status="parse_failed" className="px-2 py-1 text-xs">
        <div className="text-amber-800">답의 형식을 해석하지 못했습니다(다시 요청 1회 포함). 받은 원문을 그대로 보여 줍니다.</div>
        {/* Text only: the model output never becomes elements here. */}
        <pre data-testid="pn-card-raw" className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-gray-200 bg-gray-50 p-1 text-sl-label">
          {card.rawOutput ?? ''}
        </pre>
      </div>
    );
  }
  return (
    <div data-testid="pn-card-failed" data-status={card.status} className="px-2 py-1 text-xs text-red-700">
      {card.status === 'interrupted' ? '서버가 다시 시작되어 중단되었습니다' : '생성하지 못했습니다'}
      {card.errorCode && <span> · {runErrorText(card.errorCode)}</span>}
    </div>
  );
}

export function CardsTab({ paperId }: { paperId: string }) {
  const client = usePanelApi();
  const contextReady = useReaderStore((s) => s.paperState.contextReady);
  const q = useQuery({ queryKey: qk.cards(paperId), queryFn: () => client.call('cards.list', { params: { id: paperId } }) });
  const cards = q.data?.cards ?? [];
  // Review D-I10-02: a failed refetch keeps the data (react-query v5), so the sections stay mounted whenever there is
  // data — the cards on screen, an open generate stream and a generating watch survive; the error is one line above.
  const hasData = q.data !== undefined;
  return (
    <div data-testid="pn-cards-tab" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      {q.isError && (
        <LoadError
          testId="pn-cards-load-error"
          text={hasData ? '카드 목록을 새로 불러오지 못했습니다 — 아래는 마지막으로 받은 내용입니다' : '카드를 불러오지 못했습니다'}
          retrying={q.isFetching}
          onRetry={() => void q.refetch()}
        />
      )}
      {q.isPending && <div className="text-xs text-gray-500">불러오는 중…</div>}
      {hasData && CARD_KINDS.map((k) => <CardSection key={k} paperId={paperId} kind={k} cards={cards} contextReady={contextReady} />)}
      {/* The key of the item letters. It never says "논문 근거": that phrase belongs to a grounded item's own badge. */}
      {hasData && (
        <p className="mt-auto flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-sl-label text-sl-muted" data-testid="pn-letter-legend" aria-hidden="true">
          <span className="inline-flex items-center gap-1">
            <ItemLetter badge="grounded_quote" /> 인용 원문에서 찾음
          </span>
          <span className="inline-flex items-center gap-1">
            <ItemLetter badge="not_stated" /> 명시 없음
          </span>
          <span className="inline-flex items-center gap-1">
            <ItemLetter badge="general" /> 일반 지식
          </span>
        </p>
      )}
    </div>
  );
}
