// Live E2E plan (BRIEF_INTEGRATION I9, PLAN_M2 7절): the budget, the call plan in its fixed order and the pure
// decisions of `scripts/live-e2e.ts run` — whether to go on after a call (nextAction), which call comes next
// (decideNext, with the conditional F1r) and what each call is. Owner: supervisor. No I/O here.
// apps/server/test/contract/liveE2ePlan.test.ts pins the table, the sums and every decision.
// Targets are given by position, never by the paper's text: a selection is (page, start, end) in the stored
// page_texts of the paper, a capture is (page, area as fractions of the page box); questions are fixed Korean text.
import { NOTATION_KEYS, type NotationKey } from '../../packages/shared/src/contracts/domain';
import { LlmErrorCode, resolveEffort, resolveModel, type Effort, type ModelAlias, type TaskId } from '../../packages/shared/src/contracts/tasks';

/** The live E2E ledger caps: 25 calls (haiku 3 = `npm run test:live`, opus 18, fable 0, sonnet 4). */
export const LIVE_CAPS = { total: 25, perModel: { haiku: 3, opus: 18, fable: 0, sonnet: 4 } } as const;
/** The haiku calls `npm run test:live` makes before `run` (H1–H3, outside LIVE_CALL_PLAN, same ledger). */
export const EXTERNAL_HAIKU_CALLS = 3;
/** Reserve per model (SP-Blocks repairs inside a run, F1r once, otherwise only `run --only <id>` by the coordinator). */
export const RESERVE: Readonly<Partial<Record<ModelAlias, number>>> = { opus: 4, sonnet: 1 };

export type PaperKey = 'kiss' | 'fastlio2';
/** The two arXiv papers of the live run (imported once each, no retryIngest). */
export const LIVE_PAPERS: Readonly<Record<PaperKey, { arxivId: string; version: number; name: string }>> = {
  kiss: { arxivId: '2209.15397', version: 2, name: 'KISS-ICP' },
  fastlio2: { arxivId: '2107.06829', version: 1, name: 'FAST-LIO2' },
};
/** The papers.import input of a live paper: the planned version (`<id>v<N>`), never "the latest" (INT-I10-03). */
export const importInput = (k: PaperKey): string => `${LIVE_PAPERS[k].arxivId}v${LIVE_PAPERS[k].version}`;
/** Precondition: the numbered equations of FAST-LIO2 are exactly 1 … 19. */
export const FASTLIO2_EQUATION_NUMBERS: readonly string[] = Array.from({ length: 19 }, (_, i) => String(i + 1));
/** `import` stops before the second paper when the first one already used more than this many arXiv requests. */
export const IMPORT_FIRST_PAPER_MAX_REQUESTS = 6;
/** Server-enforced arXiv request cap of a live server (SP_NETWORK_MAX_REQUESTS); the runbook passes NET_MAX ≤ this. */
export const LIVE_NETWORK_MAX_REQUESTS = 12;

/**
 * The FAST-LIO2 notation keys the paper states (a record, not a pass criterion: records.fastlio2StatedKeys). Names only
 * here; the page positions the integrator picked them from are dry-run scratch evidence (fastlio2_stated_keys.json),
 * and the coordinator checked each against the paper before the live run (INTEGRATION_NOTES 결정 13).
 * perturbation_side is left out — a not-stated candidate: FAST-LIO2 defers the ⊞ / ⊟ definitions to FAST-LIO [22] and
 * p6 only uses ⊟ (δθ = R̂κ ⊟ R̂) without saying whether the rotation error is a right or left perturbation, so a card
 * that correctly answers "not in this paper" would lose in the record.
 */
export const FASTLIO2_STATED_KEYS: readonly NotationKey[] = ['frame_notation', 'transform_direction', 'rotation_param', 'state_vector', 'gravity_sign', 'error_definition'];

/**
 * A text selection: [start, end) in page_texts.text of `page`. `sha256` = hex SHA-256 (UTF-8) of that text on the
 * fixture PDF the offsets were chosen on (only the hash is in the repository, never the text): `run` checks every
 * selection of the plan against it before the first call, so a live PDF whose text differs is refused (exit 2, no
 * call) instead of sending a different selection.
 */
export interface Selection {
  page: number;
  start: number;
  end: number;
  sha256: string;
}
/** A capture area as fractions of the page box: [x, y] from → to. */
export interface CaptureArea {
  page: number;
  from: readonly [number, number];
  to: readonly [number, number];
}

export type CallTarget =
  | { kind: 'explain'; selection: Selection }
  | { kind: 'capture'; choice: 'figure' | 'equation'; area: CaptureArea }
  | { kind: 'chat'; question: string; deep: boolean }
  | { kind: 'summary' }
  | { kind: 'glossary'; term: string }
  | { kind: 'equation_tab'; eqNumber: string }
  | { kind: 'followup'; of: CallId; question: string; deep: boolean }
  | { kind: 'card'; card: 'notation' | 'assumptions' }
  | { kind: 'translate'; selection: Selection };

export const CALL_IDS = ['O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7', 'O8', 'O9', 'F1', 'O10', 'F2', 'F3', 'F4', 'F1r', 'S1', 'S2', 'S3'] as const;
export type CallId = (typeof CALL_IDS)[number];

export interface PlannedCall {
  id: CallId;
  model: ModelAlias;
  task: TaskId;
  effort: Effort;
  paper: PaperKey;
  path: 'api' | 'screen';
  target: CallTarget;
  /** F1r only: runs under the condition of decideNext (paid from the reserve). */
  conditional?: true;
}

const call = (id: CallId, task: TaskId, paper: PaperKey, path: 'api' | 'screen', target: CallTarget, o: { deep?: boolean; conditional?: true } = {}): PlannedCall => ({
  id,
  model: resolveModel(task),
  task,
  effort: resolveEffort(task, { deep: o.deep === true }),
  paper,
  path,
  target,
  ...(o.conditional ? { conditional: true as const } : {}),
});

// Fixed questions (Korean app-side text; never paper text).
export const QUESTIONS = {
  O3: '이 논문이 해결하려는 문제와 핵심 아이디어를 짧게 설명해 줘.',
  O4: '이 논문의 방법이 기존 ICP 계열 방법과 비교해 어떤 가정을 줄였는지 근거와 함께 깊게 설명해 줘.',
  O5: '식 (2)는 무엇을 최소화하는지, 식 번호를 인용해서 설명해 줘.',
  O10: '이 식의 각 항이 상태 추정에서 어떤 역할을 하는지 앞뒤 식과 연결해서 깊게 설명해 줘.',
} as const;
export const GLOSSARY_TERM_O7 = 'point-to-point ICP';

/**
 * The plan, in this order; nothing outside it is sent (BRIEF_INTEGRATION I9 table). Selections and areas were chosen
 * on the fixture papers in the dry-run (see the integrator report); F1 is the group-tag equation (10) of FAST-LIO2.
 */
export const LIVE_CALL_PLAN: readonly PlannedCall[] = [
  call('O1', 'explain_selection', 'kiss', 'api', { kind: 'explain', selection: { page: 1, start: 1424, end: 1668, sha256: '183403a6d29b8f570181d0cd9665803888420ae8ed33d26f84d60a3f489a9a91' } }), // abstract: the method in one sentence
  call('O2', 'figure_area', 'kiss', 'screen', { kind: 'capture', choice: 'figure', area: { page: 1, from: [0.08, 0.207], to: [0.92, 0.525] } }), // Fig. 1 (full width; top border ≈ 0.2097, author line ends ≈ 0.201)
  call('O3', 'chat', 'kiss', 'api', { kind: 'chat', question: QUESTIONS.O3, deep: false }),
  call('O4', 'chat', 'kiss', 'api', { kind: 'chat', question: QUESTIONS.O4, deep: true }, { deep: true }),
  call('O5', 'chat', 'kiss', 'api', { kind: 'chat', question: QUESTIONS.O5, deep: false }),
  call('O6', 'summary', 'kiss', 'api', { kind: 'summary' }),
  call('O7', 'glossary_define', 'kiss', 'api', { kind: 'glossary', term: GLOSSARY_TERM_O7 }),
  call('O8', 'explain_selection', 'fastlio2', 'api', { kind: 'explain', selection: { page: 1, start: 773, end: 961, sha256: 'f57afbe37590e43c0d921b2497b0783ba875ce215d0c1f46704155f5c34a9074' } }), // abstract: the second novelty (ikd-Tree)
  call('O9', 'figure_area', 'fastlio2', 'screen', { kind: 'capture', choice: 'figure', area: { page: 7, from: [0.51, 0.062], to: [0.93, 0.264] } }), // TABLE I (right column)
  call('F1', 'equation_deep', 'fastlio2', 'api', { kind: 'equation_tab', eqNumber: '10' }),
  call('O10', 'chat', 'fastlio2', 'api', { kind: 'followup', of: 'F1', question: QUESTIONS.O10, deep: true }, { deep: true }),
  call('F2', 'notation_card', 'fastlio2', 'api', { kind: 'card', card: 'notation' }),
  call('F3', 'equation_deep', 'kiss', 'screen', { kind: 'capture', choice: 'equation', area: { page: 3, from: [0.53, 0.4305], to: [0.93, 0.474] } }), // equation (1)
  call('F4', 'assumptions_card', 'kiss', 'api', { kind: 'card', card: 'assumptions' }),
  call('F1r', 'equation_deep', 'fastlio2', 'api', { kind: 'equation_tab', eqNumber: '10' }, { conditional: true }),
  call('S1', 'translate_selection', 'kiss', 'api', { kind: 'translate', selection: { page: 1, start: 416, end: 452, sha256: 'e2c7ba4180e960dced52ab7e3219f26a0b74483cd8f625fe705759cd5f9c57bb' } }), // short sentence (Fig. 1 caption)
  call('S2', 'translate_selection', 'kiss', 'api', { kind: 'translate', selection: { page: 3, start: 1601, end: 1771, sha256: 'fe88dab842e6e4ae6db73d5387bbaec9b873a20130e0ad8e4315926048d70127' } }), // sentence with inline math (Sec. III)
  call('S3', 'translate_selection', 'fastlio2', 'api', { kind: 'translate', selection: { page: 1, start: 2040, end: 2462, sha256: '85df5b0fbb5d101b3935c7ad9e2c4ec0f01b447d82b7944ab560b4c3c040c5bc' } }), // general paragraph (Introduction)
];

export const CALL_BY_ID: Readonly<Record<CallId, PlannedCall>> = Object.fromEntries(LIVE_CALL_PLAN.map((c) => [c.id, c])) as Record<CallId, PlannedCall>;

/** Planned (non-conditional) calls per model; + EXTERNAL_HAIKU_CALLS for haiku. */
export function plannedPerModel(): Record<ModelAlias, number> {
  const out: Record<ModelAlias, number> = { haiku: EXTERNAL_HAIKU_CALLS, opus: 0, fable: 0, sonnet: 0 };
  for (const c of LIVE_CALL_PLAN) if (!c.conditional) out[c.model]++;
  return out;
}

// ------------------------------------------------------------------------------------------------------------------
// nextAction: what the end of one call means for the rest of the plan (BRIEF_INTEGRATION I9 table)

/** Codes after which the run records the failure and goes on (not re-sent); two in a row stop the run. */
export const SOFT_ERROR_CODES = ['first_content_timeout', 'idle_timeout', 'total_timeout', 'parse_failed'] as const satisfies readonly LlmErrorCode[];
/** Codes that stop the run at once (the same cause would repeat on every call). */
export const STOP_ERROR_CODES = ['ledger_locked', 'rate_limited'] as const satisfies readonly LlmErrorCode[];
export const IMMEDIATE_STOP_CODES = [
  'unsafe_cli_state',
  'cli_error',
  'api_auth',
  'api_error',
  'api_key_missing',
  'api_truncated',
  'api_refused',
  'cli_missing',
  'startup_timeout',
  'queue_timeout',
  'cancelled',
  'too_large',
  'context_not_ready',
  'persist_failed',
  'superseded',
  'result_deleted',
] as const satisfies readonly LlmErrorCode[];
/** budget_exhausted is told apart with the ledger (STOP / total cap / no caps → stop, model cap → skip that model). */
export type ErrorClass = 'soft' | 'budget' | 'stop' | 'immediate';

/** The row of the I9 table a run.error code belongs to. Exhaustive: a new LlmErrorCode does not compile. */
export function classifyErrorCode(code: LlmErrorCode): ErrorClass {
  switch (code) {
    case 'first_content_timeout':
    case 'idle_timeout':
    case 'total_timeout':
    case 'parse_failed':
      return 'soft';
    case 'budget_exhausted':
      return 'budget';
    case 'ledger_locked':
    case 'rate_limited':
      return 'stop';
    case 'unsafe_cli_state':
    case 'cli_error':
    case 'api_auth':
    case 'api_error':
    case 'api_key_missing':
    case 'api_truncated':
    case 'api_refused':
    case 'cli_missing':
    case 'startup_timeout':
    case 'queue_timeout':
    case 'cancelled':
    case 'too_large':
    case 'context_not_ready':
    case 'persist_failed':
    case 'superseded':
    case 'result_deleted':
      return 'immediate';
    default: {
      const never: never = code;
      throw new Error(`unclassified LlmErrorCode ${String(never)}`);
    }
  }
}

/** How one call ended, as seen by the client. */
export type CallOutcome =
  | { kind: 'done' }
  | { kind: 'run_error'; code: LlmErrorCode }
  | { kind: 'http_error'; status: number; code?: string }
  | { kind: 'schema_mismatch'; detail: string }
  | { kind: 'client_timeout' }
  | { kind: 'no_terminal' }
  | { kind: 'client_error'; detail: string };

/** What `run` needs from readLiveLedger (null when the mode has no ledger: dry-mock). */
export interface LedgerView {
  caps: { total: number; perModel: Partial<Record<ModelAlias, number>> } | null;
  used: { total: number; perModel: Record<string, number> };
  stopped: string | null;
  stopRequested: string | null;
}

export type Verdict =
  | { action: 'next'; consecutiveSoft: number; reason: string }
  | { action: 'skip_model'; model: ModelAlias; consecutiveSoft: number; reason: string }
  | { action: 'stop'; reason: string };

/** `STOP: <reason>` / `STOP_REQUESTED: <reason>` of a stopped ledger (STOP first), null when neither (or no ledger: dry-mock). */
export function ledgerStopText(ledger: Pick<LedgerView, 'stopped' | 'stopRequested'> | null): string | null {
  if (!ledger) return null;
  if (ledger.stopped !== null) return `STOP: ${ledger.stopped}`;
  if (ledger.stopRequested !== null) return `STOP_REQUESTED: ${ledger.stopRequested}`;
  return null;
}

/**
 * After call `c` ended with `outcome`; `ledger` is read right after that call. A stopped ledger (STOP or STOP_REQUESTED)
 * stops the run before the outcome is looked at, whatever it was (Codex r4 M-M2-R4-1, 결정 33): a successful result
 * whose rate-limit status was rejected — or an allowed warning that could not be recorded — stops the ledger while the
 * call itself ends run.done, and the check before the next call never runs after the last executed call. The reason
 * names the call. `consecutiveSoft` counts the soft failures (SOFT_ERROR_CODES) right before this call; a budget skip
 * does not change it (no child was spawned).
 */
export function nextAction(c: Pick<PlannedCall, 'id' | 'model'>, outcome: CallOutcome, consecutiveSoft: number, ledger: LedgerView | null): Verdict {
  const stop = ledgerStopText(ledger);
  if (stop !== null) return { action: 'stop', reason: `the ledger is stopped after call ${c.id} (${stop}); its outcome ${describeOutcome(outcome)} is not judged` };
  if (c.id === 'O1' && outcome.kind !== 'done') return { action: 'stop', reason: `O1 (the first LLM call) did not end with run.done (${describeOutcome(outcome)})` };
  switch (outcome.kind) {
    case 'done':
      return { action: 'next', consecutiveSoft: 0, reason: 'run.done' };
    case 'http_error':
      return { action: 'stop', reason: `HTTP ${outcome.status}${outcome.code ? ` ${outcome.code}` : ''}` };
    case 'schema_mismatch':
      return { action: 'stop', reason: `response does not match the contract: ${outcome.detail}` };
    case 'client_timeout':
      return { action: 'stop', reason: 'client timeout' };
    case 'no_terminal':
      return { action: 'stop', reason: 'the stream ended without a terminal event' };
    case 'client_error':
      return { action: 'stop', reason: `client error: ${outcome.detail}` };
    case 'run_error':
      break;
  }
  const code = outcome.code;
  const cls = classifyErrorCode(code);
  if (cls === 'soft') {
    const n = consecutiveSoft + 1;
    return n >= 2 ? { action: 'stop', reason: `${code}: second soft failure in a row` } : { action: 'next', consecutiveSoft: n, reason: `${code} recorded (not re-sent)` };
  }
  if (cls === 'stop' || cls === 'immediate') return { action: 'stop', reason: code };
  // budget_exhausted: the ledger tells which refusal it was (a stopped ledger was handled first)
  if (!ledger || !ledger.caps) return { action: 'stop', reason: 'budget_exhausted without ledger caps' };
  if (ledger.used.total >= ledger.caps.total) return { action: 'stop', reason: 'budget_exhausted: total cap reached' };
  const cap = ledger.caps.perModel[c.model] ?? 0;
  if ((ledger.used.perModel[c.model] ?? 0) >= cap) return { action: 'skip_model', model: c.model, consecutiveSoft, reason: `budget_exhausted: ${c.model} cap reached — its remaining calls are skipped` };
  return { action: 'stop', reason: 'budget_exhausted that the ledger does not explain' };
}

export function describeOutcome(o: CallOutcome): string {
  switch (o.kind) {
    case 'done':
      return 'run.done';
    case 'run_error':
      return `run.error ${o.code}`;
    case 'http_error':
      return `HTTP ${o.status}`;
    case 'schema_mismatch':
      return 'schema mismatch';
    case 'client_timeout':
      return 'client timeout';
    case 'no_terminal':
      return 'no terminal event';
    case 'client_error':
      return `client error`;
  }
}

// ------------------------------------------------------------------------------------------------------------------
// decideNext: the plan walk (selection by --from / --only, model skips, the conditional F1r)

export interface RunState {
  /** Index of the next plan entry. */
  pos: number;
  consecutiveSoft: number;
  skippedModels: ModelAlias[];
  /** Pass condition 2 of F1 (set by the caller after F1): null = F1 not run in this invocation. */
  f1Passed: boolean | null;
  stopped: string | null;
}
export const initialRunState = (): RunState => ({ pos: 0, consecutiveSoft: 0, skippedModels: [], f1Passed: null, stopped: null });

export type SkipRecord = 'skipped_model_cap' | 'skipped_no_budget' | 'skipped_not_needed' | 'not_selected';
export type Decision = { kind: 'call'; call: PlannedCall } | { kind: 'skip'; call: PlannedCall; record: SkipRecord } | { kind: 'end' };

export interface Selector {
  from?: CallId;
  only?: CallId;
}

/** Whether `c` belongs to this invocation (--only id / --from id onwards / all). */
export function selected(c: CallId, sel: Selector): boolean {
  if (sel.only) return c === sel.only;
  if (sel.from) return CALL_IDS.indexOf(c) >= CALL_IDS.indexOf(sel.from);
  return true;
}

/**
 * The next step at state.pos. `retryModelLeft` is the remaining budget for F1r's model (ledger reservations, or DB rows
 * in dry-mock). F1r runs after F1–F4 when F1 did not pass and that model has ≥ 1 call
 * left; F1 passed → skipped_not_needed; nothing left → skipped_no_budget. f1Passed null (F1 not run, or a
 * resumed run without calls/F1.json) counts as not passed; a record without f1Passed is looked up again before the
 * first call (f1ResumeSource), and a failed lookup stops the run there. `run --only F1r` bypasses the F1 verdict, but still needs budget.
 */
export function decideNext(state: RunState, sel: Selector, retryModelLeft: number): Decision {
  const c = LIVE_CALL_PLAN[state.pos];
  if (state.stopped !== null || c === undefined) return { kind: 'end' };
  if (!selected(c.id, sel)) return { kind: 'skip', call: c, record: 'not_selected' };
  if (state.skippedModels.includes(c.model)) return { kind: 'skip', call: c, record: c.id === 'F1r' ? 'skipped_no_budget' : 'skipped_model_cap' };
  if (c.id === 'F1r') {
    if (sel.only !== 'F1r' && state.f1Passed === true) return { kind: 'skip', call: c, record: 'skipped_not_needed' };
    if (retryModelLeft < 1) return { kind: 'skip', call: c, record: 'skipped_no_budget' };
  }
  return { kind: 'call', call: c };
}

/** State after a call: the verdict of nextAction applied (pos advances in every case). */
export function afterCall(state: RunState, v: Verdict): RunState {
  const next: RunState = { ...state, pos: state.pos + 1, skippedModels: [...state.skippedModels] };
  if (v.action === 'stop') next.stopped = v.reason;
  else {
    next.consecutiveSoft = v.consecutiveSoft;
    if (v.action === 'skip_model' && !next.skippedModels.includes(v.model)) next.skippedModels.push(v.model);
  }
  return next;
}

/**
 * Before each call (BRIEF_INTEGRATION I9: "`run`은 호출마다 앞에서 `readLiveLedger`: `stopped`·`stopRequested`가 있으면
 * exit 3"): the stop reason when the ledger is stopped, else null. dry-mock has no ledger (null → go on). A run that
 * ends here exits 3 like any other stop.
 */
export function ledgerStopBeforeCall(ledger: Pick<LedgerView, 'stopped' | 'stopRequested'> | null): string | null {
  const stop = ledgerStopText(ledger);
  return stop === null ? null : `the ledger is stopped before the call (${stop})`;
}

/** State after a skip (no call, no change to the soft-failure count). */
export const afterSkip = (state: RunState): RunState => ({ ...state, pos: state.pos + 1 });

/** A step of the run loop: decideNext's decision, or a stop before the call because the ledger is stopped. */
export type LoopStep = Decision | { kind: 'stop'; call: PlannedCall; state: RunState; exitCode: 3 };

/**
 * The run loop before each call (live-e2e.ts `run` and the tests use this one function): decideNext, then for a call
 * the ledger read just before it — stopped / stopRequested → `stop` with exit code 3 and the call not sent.
 */
export function stepBeforeCall(state: RunState, sel: Selector, retryModelLeft: number, ledger: Pick<LedgerView, 'stopped' | 'stopRequested'> | null): LoopStep {
  const d = decideNext(state, sel, retryModelLeft);
  if (d.kind !== 'call') return d;
  const stop = ledgerStopBeforeCall(ledger);
  if (stop === null) return d;
  return { kind: 'stop', call: d.call, state: { ...state, stopped: `${stop}; next call ${d.call.id} not sent` }, exitCode: 3 };
}

/** The run loop after a call: the state (afterCall) and the exit code — a `stop` verdict ends the run with 3. */
export function stepAfterCall(state: RunState, v: Verdict): { state: RunState; exitCode: 3 | null } {
  return { state: afterCall(state, v), exitCode: v.action === 'stop' ? 3 : null };
}

/**
 * The run loop when it ends without a stop (the plan's end, or only skips left — e.g. `--only O1` after O1): one more
 * look at the ledger, so a STOP / STOP_REQUESTED that no later call's check could see still ends the run with exit 3
 * (Codex r4 M-M2-R4-1). A run already stopped keeps its reason and exit code (null here: the caller has it).
 */
export function stepAtEnd(state: RunState, ledger: Pick<LedgerView, 'stopped' | 'stopRequested'> | null, skipped?: CallId): { state: RunState; exitCode: 3 | null } {
  if (state.stopped !== null) return { state, exitCode: null };
  const stop = ledgerStopText(ledger);
  if (stop === null) return { state, exitCode: null };
  const stopped = skipped
    ? `the ledger is stopped while skipping ${skipped} (${stop})`
    : `the ledger is stopped at the end of the run (${stop}); no call was left to send`;
  return { state: { ...state, stopped }, exitCode: 3 };
}

/** All NOTATION_KEYS — a notation card must store exactly these (pass condition 1). */
export const ALL_NOTATION_KEYS: readonly NotationKey[] = NOTATION_KEYS;
