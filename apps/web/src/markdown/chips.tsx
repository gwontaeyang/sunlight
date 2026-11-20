// Citation chips, equation-reference chips, label badges and the external-link rule (PLAN 3, 5.4, PLAN_M2 3.3–3.4).
// Owner D. UI words: never "검증됨" — "원문에서 찾음" only says the string exists in the paper; an equation reference is
// never "논문 근거" (D18).
import { createContext, useContext, useState, type ReactNode } from 'react';
import type { StructureResponse } from '@study-paper/shared/contracts/api';
import type { Citation, ParsedBlock, UncheckedReason } from '@study-paper/shared/contracts/domain';
import { equationByNumber } from '../api/structure';
import { useReaderStore, type JumpResult as StructureJump } from '../state/readerStore';
import { blockEvidence, safeExternalUrl, type SpPhase } from './grounding';
import { CopyLatexButton, LatexView } from './latex';

export type JumpResult = 'located' | 'page_only';
export type CitationClickHandler = (c: Citation) => Promise<JumpResult> | JumpResult | void;

export interface SpRenderContext {
  phase: SpPhase;
  citations: ReadonlyMap<number, Citation>;
  /** Parser blocks (ParsedAnswer.blocks); a badge finds its own block by index. */
  blocks: readonly ParsedBlock[];
  onCitationClick?: CitationClickHandler;
  /**
   * The stored citations did not pair with the parser's (pairCitations → null, PLAN_M2 3.4 rule 5): every chip shows
   * "확인 안 됨" (phase is 'failed') and no block badge is drawn at all.
   */
  unpaired?: boolean;
}

export const SpContext = createContext<SpRenderContext>({ phase: 'final', citations: new Map(), blocks: [] });

/**
 * The open paper's structure (api/structure.ts useStructure, provided by the side panel). Used ONLY to offer
 * "색인에서 찾기" on an `unindexed` equation chip — the chip's state, the badges and the stats never change with it.
 */
export const StructureContext = createContext<StructureResponse | undefined>(undefined);

/** In a Study path, links come from the paper index and an equation can open the matching reader tab. */
export const StudyPathLinkContext = createContext<((equationId: string) => void) | null>(null);

const base = 'mx-0.5 inline-flex items-center gap-1 rounded px-1.5 py-0 align-baseline text-sl-label leading-5 whitespace-nowrap';
const neutral = `${base} border border-gray-300 bg-gray-100 text-gray-600`;

function NotLocated() {
  return (
    <span data-testid="sp-not-located" className="ml-0.5 text-sl-label text-amber-700" title="해당 page로만 이동했습니다. 인용 문장의 정확한 위치는 확인하지 못했습니다.">
      위치 미확정
    </span>
  );
}

/** Calls the jump handler and remembers whether the viewer could locate the text ('page_only' → "위치 미확정"). */
function useJump(c: Citation | undefined) {
  const { onCitationClick } = useContext(SpContext);
  const [result, setResult] = useState<JumpResult | null>(null);
  const jump = async () => {
    if (!c || !onCitationClick) return;
    try {
      const r = await onCitationClick(c);
      setResult(r === 'located' ? 'located' : 'page_only');
    } catch {
      setResult('page_only');
    }
  };
  return { jump, notLocated: result === 'page_only' };
}

/** A chip without a confirmed citation (streaming, failed, or no paired citation for its ordinal). */
function Pending({ text, ordinal }: { text: string; ordinal: number }) {
  const { phase } = useContext(SpContext);
  // Final without a matched citation counts as "확인 안 됨" too (never as found).
  const failed = phase !== 'streaming';
  return (
    <span data-testid="sp-chip" data-ordinal={ordinal} data-status={failed ? 'unchecked' : 'pending'} className={neutral} title={failed ? '확인 안 됨' : '확인 전'}>
      {text}
      {failed && <span className="text-sl-label">확인 안 됨</span>}
    </span>
  );
}

export function CitationChip({ ordinal }: { ordinal: number }) {
  const { phase, citations } = useContext(SpContext);
  const c = citations.get(ordinal);
  const { jump, notLocated } = useJump(c);
  const label = `❝${ordinal}`;
  if (phase !== 'final' || !c || c.kind !== 'quote') return <Pending text={label} ordinal={ordinal} />;
  const quote = c.quote ?? '';
  switch (c.status) {
    case 'verbatim':
      return (
        <>
          <button type="button" data-testid="sp-chip" data-ordinal={ordinal} data-status="verbatim" className={`${base} cursor-pointer border border-emerald-600 bg-emerald-50 text-emerald-800 hover:bg-emerald-100`} title={`원문에서 찾음 — ${quote}`} onClick={jump}>
            {label}
          </button>
          {notLocated && <NotLocated />}
        </>
      );
    case 'fuzzy':
      return (
        <>
          <button type="button" data-testid="sp-chip" data-ordinal={ordinal} data-status="fuzzy" className={`${base} cursor-pointer border border-dashed border-sky-600 bg-white text-sky-800 hover:bg-sky-50`} title={`원문과 정확히 같지 않음 — ${quote}`} onClick={jump}>
            {label} 비슷한 문장(일치율 {Math.round(c.score * 100)}%)
          </button>
          {notLocated && <NotLocated />}
        </>
      );
    case 'ambiguous':
      return (
        <span data-testid="sp-chip" data-ordinal={ordinal} data-status="ambiguous" className={`${base} border border-gray-400 bg-gray-50 text-gray-700`} title={`위치를 하나로 정할 수 없음 — ${quote}`}>
          {label} 여러 곳에 있음({c.candidates ?? '?'})
        </span>
      );
    case 'unchecked': {
      const why = UNCHECKED_TEXT[c.uncheckedReason ?? 'work_budget'];
      return (
        <span data-testid="sp-chip" data-ordinal={ordinal} data-status="unchecked" data-reason={c.uncheckedReason} className={neutral} title={`원문과 맞춰 보지 못했습니다(${why.title}) — ${quote}`}>
          {label} 확인 못 함({why.chip})
        </span>
      );
    }
    default:
      return (
        <span data-testid="sp-chip" data-ordinal={ordinal} data-status="not_found" className={`${base} border border-red-500 bg-red-50 text-red-700`} title={`모델이 준 인용: ${quote}`}>
          {label} 원문에서 찾지 못함
        </span>
      );
  }
}

/** Korean reason of an `unchecked` quote (citations.detail, PLAN_M2 3.3 uncheckedReason). */
export const UNCHECKED_TEXT: Record<UncheckedReason, { chip: string; title: string }> = {
  work_budget: { chip: '작업량 초과', title: '대조 시간 한도' },
  quote_too_long: { chip: '인용이 너무 김', title: '인용이 너무 김' },
  text_too_long: { chip: '논문이 너무 김', title: '논문이 너무 김' },
};

/** The structure jump's outcome next to a chip / list item: page_only → "위치 미확정", no_anchor → "PDF 위치 없음". */
export function JumpNote({ result }: { result: StructureJump | null }) {
  if (result === 'page_only') return <NotLocated />;
  if (result === 'no_anchor')
    return (
      <span data-testid="pn-eq-no-anchor" className="ml-0.5 text-sl-label text-amber-700" title="이 식은 PDF에서 위치를 찾지 못해 이동할 수 없습니다">
        PDF 위치 없음
      </span>
    );
  return null;
}

/** readerStore.jumpToEquation with its result kept for JumpNote (a thrown jump counts as page_only). */
export function useEquationJump() {
  const jumpToEquation = useReaderStore((s) => s.jumpToEquation);
  const [result, setResult] = useState<StructureJump | null>(null);
  const jump = async (equationId: string) => {
    try {
      setResult(await jumpToEquation(equationId));
    } catch {
      setResult('page_only');
    }
  };
  return { jump, result };
}

/** Popover of an indexed equation: KaTeX (or the code), "LaTeX 복사" (the server's latex), "깊이 읽기". */
export function EquationPopover({ latex, katexOk, equationId, onClose }: { latex: string; katexOk: boolean; equationId?: string; onClose: () => void }) {
  const requestAction = useReaderStore((s) => s.requestAction);
  return (
    <span role="dialog" aria-label="수식" data-testid="pn-eq-popover" className="my-1 block rounded border border-gray-300 bg-white p-1.5 text-xs whitespace-normal shadow-sm">
      <LatexView latex={latex} katexOk={katexOk} />
      <span className="mt-1 flex flex-wrap gap-1">
        <CopyLatexButton latex={latex} />
        {equationId && (
          <button type="button" data-testid="pn-eq-deep" className="rounded border border-blue-300 px-1.5 text-sl-label text-blue-800 hover:bg-blue-50" onClick={() => requestAction({ kind: 'equation', equationId })}>
            깊이 읽기
          </button>
        )}
        <button type="button" data-testid="pn-eq-popover-close" className="rounded border border-gray-300 px-1.5 text-sl-label" onClick={onClose}>
          닫기
        </button>
      </span>
    </span>
  );
}

/**
 * Equation reference chip — 5 states (PLAN_M2 3.3): resolved = click jumps (jumpToEquation) and opens the popover /
 * no_anchor = popover only / ambiguous = candidate list (section number · page, click jumps) / not_found = red
 * "색인에 없는 식" / unindexed = the number only, plus "색인에서 찾기" when the current structure has exactly one equation
 * with that number (api/structure.ts equationByNumber — the state, badges and stats stay as they are).
 * A `resolved` reference without `latex` (cut beyond 4,000 chars) offers the number and the jump only.
 */
export function EqRefChip({ ordinal, text }: { ordinal: number; text: string }) {
  const { phase, citations } = useContext(SpContext);
  const structure = useContext(StructureContext);
  const openEquation = useContext(StudyPathLinkContext);
  const c = citations.get(ordinal);
  const { jump, notLocated } = useJump(c);
  const eqJump = useEquationJump();
  const [open, setOpen] = useState(false);
  if (phase !== 'final' || !c || c.kind !== 'equation') return <Pending text={text} ordinal={ordinal} />;
  const name = `식 (${c.eqNumber ?? '?'})`;
  const popover = open && c.latex !== undefined ? <EquationPopover latex={c.latex} katexOk={c.katexOk ?? false} equationId={c.equationId} onClose={() => setOpen(false)} /> : null;
  switch (c.status) {
    case 'resolved':
      return (
        <>
          <button
            type="button"
            data-testid="sp-chip" data-ordinal={ordinal}
            data-status="resolved"
            className={`${base} cursor-pointer border border-emerald-600 bg-emerald-50 text-emerald-800 hover:bg-emerald-100`}
            title="수식 색인에서 찾음 — 클릭하면 이동 (식 참조는 주장 내용과 대조하지 않음)"
            onClick={() => {
              if (c.equationId === undefined) return void jump(); // M1-shaped citation: the citation jump
              openEquation?.(c.equationId);
              if (c.latex !== undefined) setOpen(true);
              void eqJump.jump(c.equationId);
            }}
          >
            {name}
          </button>
          {notLocated && <NotLocated />}
          <JumpNote result={eqJump.result} />
          {popover}
        </>
      );
    case 'no_anchor':
      return (
        <>
          <span
            data-testid="sp-chip" data-ordinal={ordinal}
            data-status="no_anchor"
            role={c.latex !== undefined ? 'button' : undefined}
            tabIndex={c.latex !== undefined ? 0 : undefined}
            className={`${base} border border-emerald-600 bg-white text-emerald-800${c.latex !== undefined ? ' cursor-pointer' : ''}`}
            title="수식 색인에 있지만 PDF 위치 정보가 없어 이동할 수 없음 — 클릭하면 수식 보기"
            onClick={() => {
              if (c.equationId) openEquation?.(c.equationId);
              if (c.latex !== undefined) setOpen((o) => !o);
            }}
          >
            {name}
          </span>
          {popover}
        </>
      );
    case 'unindexed': {
      const one = c.eqNumber !== undefined ? equationByNumber(structure, c.eqNumber) : null;
      return (
        <>
          <span data-testid="sp-chip" data-ordinal={ordinal} data-status="unindexed" className={`${base} border border-gray-300 bg-white text-gray-700`} title="답을 저장할 때 이 논문에 수식 색인이 없어 번호만 표시합니다 (확인되지 않음)">
            {name}
          </span>
          {one && (
            <button type="button" data-testid="pn-eq-find-index" className="ml-0.5 rounded border border-gray-300 px-1 text-sl-label text-gray-700 hover:bg-gray-100" title="지금의 수식 색인에 이 번호의 식이 하나 있습니다 — 그 위치로 이동 (답의 확인 상태는 바뀌지 않음)" onClick={() => void eqJump.jump(one.id)}>
              색인에서 찾기
            </button>
          )}
          <JumpNote result={eqJump.result} />
        </>
      );
    }
    case 'ambiguous':
      return (
        <>
          <span
            data-testid="sp-chip" data-ordinal={ordinal}
            data-status="ambiguous"
            role={c.eqCandidates?.length ? 'button' : undefined}
            tabIndex={c.eqCandidates?.length ? 0 : undefined}
            className={`${base} border border-gray-400 bg-gray-50 text-gray-700${c.eqCandidates?.length ? ' cursor-pointer' : ''}`}
            title="같은 번호의 식이 여러 개 있음 — 클릭하면 후보 목록"
            onClick={() => c.eqCandidates?.length && setOpen((o) => !o)}
          >
            {name} 여러 개({c.candidates ?? '?'})
          </span>
          {open && c.eqCandidates && (
            <span role="dialog" aria-label="같은 번호의 식" data-testid="pn-eq-candidates" className="my-1 block rounded border border-gray-300 bg-white p-1 text-xs whitespace-normal">
              {c.eqCandidates.map((k) => (
                <button key={k.equationId} type="button" data-testid="pn-eq-candidate" className="mr-1 mb-0.5 rounded border border-gray-300 px-1 hover:bg-gray-100" onClick={() => void eqJump.jump(k.equationId)}>
                  {k.sectionNumber ? `${k.sectionNumber}절` : '절 미상'} · {k.pdfPage !== null ? `p. ${k.pdfPage}` : 'page 미상'}
                </button>
              ))}
              <JumpNote result={eqJump.result} />
            </span>
          )}
        </>
      );
    default:
      return (
        <span data-testid="sp-chip" data-ordinal={ordinal} data-status="not_found" className={`${base} border border-red-500 bg-red-50 text-red-700`} title="이 번호의 식을 색인에서 찾지 못함">
          {name} 색인에 없는 식
        </span>
      );
  }
}

const LABEL_TEXT = { N: '논문에 명시 없음', G: '일반 지식' } as const;

/**
 * Label badge of parser block `block` (index into ParsedAnswer.blocks, put on the chip by the parser).
 * `colocated`: ordinals of the citation chips rendered in the same Markdown block as this badge.
 */
export function LabelBadge({ label, block, colocated }: { label: 'P' | 'N' | 'G'; block: number; colocated: readonly number[] }) {
  const { phase, citations, blocks, unpaired } = useContext(SpContext);
  // Pairing failed (PLAN_M2 3.4 rule 5): no block badge at all.
  if (unpaired) return null;
  if (phase !== 'final') {
    const failed = phase === 'failed';
    return (
      <span data-testid="sp-badge" data-status={failed ? 'unchecked' : 'pending'} className={neutral} title={failed ? '확인 안 됨' : '확인 전'}>
        {label} · {failed ? '확인 안 됨' : '확인 전'}
      </span>
    );
  }
  if (label !== 'P') {
    return (
      <span data-testid="sp-badge" data-status={label} className={`${base} border border-slate-300 bg-slate-50 text-slate-700`}>
        {LABEL_TEXT[label]}
      </span>
    );
  }
  // Fail closed: the badge's own parser block must be P with evidence rendered next to it.
  const evidence = blockEvidence(blocks[block], citations, colocated);
  if (evidence === 'equation_ref') {
    return (
      <span data-testid="sp-badge" data-status="p-equation-ref" className={`${base} border border-dashed border-violet-500 bg-violet-50 text-violet-800`} title="이 문단에는 식 번호 참조만 있습니다. 그 번호의 식이 색인에 있다는 뜻일 뿐, 주장 내용과는 대조하지 않았습니다.">
        식 참조 · 내용 대조 안 함
      </span>
    );
  }
  if (evidence === 'quote') {
    return (
      <span data-testid="sp-badge" data-status="p-grounded" className={`${base} border border-emerald-600 bg-emerald-50 text-emerald-800`} title="이 문단의 인용 중 하나 이상이 원문에서 찾아졌습니다. 주장을 뒷받침하는지는 직접 확인하세요.">
        논문 근거 · 인용 원문에서 찾음
      </span>
    );
  }
  return (
    <span data-testid="sp-badge" data-status="p-unverified" className={`${base} border border-orange-500 bg-orange-50 text-orange-800`} title="모델은 논문 근거라고 했지만 원문에서 찾은 인용이 없습니다.">
      근거 미확인
    </span>
  );
}

function textOf(children: ReactNode): string | null {
  if (typeof children === 'string') return children;
  if (Array.isArray(children) && children.every((c) => typeof c === 'string')) return children.join('');
  return null;
}

/** Model-written link: text + full URL as plain text, and an "열기" button for http(s) behind a host confirmation. */
export function ExternalLink({ href, children }: { href: string; children?: ReactNode }) {
  const [confirming, setConfirming] = useState(false);
  // Streamdown marks a link that is still being typed; show only its text until it is complete.
  if (href.startsWith('streamdown:')) return <span>{children}</span>;
  const url = safeExternalUrl(href);
  const sameAsText = textOf(children) === href;
  return (
    <span data-testid="sp-ext-link" className="break-all">
      {children}
      {!sameAsText && href && <span className="ml-1 font-mono text-sl-label text-gray-600">({href})</span>}
      {url && !confirming && (
        <button type="button" data-testid="sp-ext-open" className="ml-1 rounded border border-gray-300 px-1 text-sl-label text-gray-700 hover:bg-gray-100" onClick={() => setConfirming(true)}>
          열기
        </button>
      )}
      {url && confirming && (
        <span role="dialog" aria-label="외부 링크 열기 확인" data-testid="sp-ext-confirm" className="ml-1 inline-flex flex-wrap items-center gap-1 rounded border border-amber-400 bg-amber-50 px-1.5 text-sl-label">
          <span>
            새 탭에서 <b>{url.host}</b> 사이트를 엽니다.
          </span>
          <button
            type="button"
            data-testid="sp-ext-confirm-open"
            className="rounded bg-sl-accent px-1.5 text-sl-on-accent"
            onClick={() => {
              setConfirming(false);
              window.open(url.href, '_blank', 'noopener,noreferrer');
            }}
          >
            열기
          </button>
          <button type="button" className="rounded border px-1.5" onClick={() => setConfirming(false)}>
            취소
          </button>
        </span>
      )}
    </span>
  );
}

/** Images are never rendered (PLAN 3): alt text and URL as plain text. */
export function BlockedImage({ src, alt }: { src?: string; alt?: string }) {
  return (
    <span data-testid="sp-image-blocked" className="text-gray-500">
      [이미지 표시 안 함{alt ? `: ${alt}` : ''}]{src ? ` (${src})` : ''}
    </span>
  );
}
