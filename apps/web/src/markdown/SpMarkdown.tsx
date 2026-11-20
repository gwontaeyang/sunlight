// SP-Markup answer renderer (PLAN 5.2–5.4, 8.4). Owner D.
// Input is always parser output (parseAnswer(...).displayMd); chips/badges come only from the parser's marked
// `#sp-…` links (admitted by remarkSpIndex, tied to a citation ordinal or a block index). Rendering: Streamdown 2.7.1 with
// - rehypePlugins = [] → no rehype-raw/sanitize/harden: raw HTML in model output stays literal text;
// - our own `a` / `img` components → chips, badges, "text + URL + 열기" links, images as text;
// - KaTeX through remark-math + rehype-katex with trust:false;
// - mode="streaming" (+ remend closing unfinished `$$`/fences) while streaming, mode="static" afterwards.
import 'katex/dist/katex.min.css';
import './spMarkdown.css';
import { cjk } from '@streamdown/cjk';
import { useContext, useMemo, type ReactNode } from 'react';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { Streamdown, type Components } from 'streamdown';
import type { Citation, MessageStats, ParsedBlock } from '@study-paper/shared/contracts/domain';
import { BlockedImage, CitationChip, EqRefChip, ExternalLink, LabelBadge, SpContext, StudyPathLinkContext, type CitationClickHandler, type SpRenderContext } from './chips';
import { SP_HREF, statsDetail, type SpPhase } from './grounding';
import { CHIP_ATTR, CHIP_ID_ATTR, CHIP_KIND_ATTR, COLOCATED_ATTR, remarkSpIndex } from './remarkSpIndex';

export type { SpPhase } from './grounding';

export interface SpMarkdownProps {
  /** parseAnswer(raw, {final:false}).displayMd while streaming, run.done.parsed.displayMd afterwards. */
  displayMd: string;
  /** Matched citations (run.done.citations / MessageDto.citations). */
  citations?: readonly Citation[];
  /** Parser blocks (run.done.parsed.blocks); needed for the "[[P]] + evidence" badge. */
  blocks?: readonly ParsedBlock[];
  stats?: MessageStats | null;
  phase: SpPhase;
  /** Citation chip click (verbatim / fuzzy quotes, resolved equations). 'page_only' shows "위치 미확정". */
  onCitationClick?: CitationClickHandler;
  /**
   * PLAN_M2 3.4 rule 5: the stored citations did not pair with this parse. Shown like phase 'failed' (every chip
   * "확인 안 됨"), with NO block badge and no stats line, and a note saying why. Use StoredMarkup (renderStored.tsx),
   * which sets this from pairCitations — not by hand.
   */
  unpaired?: boolean;
}

export const UNPAIRED_NOTE = '저장된 인용과 현재 표시 규칙이 달라 확인 표시를 생략함';

const MATH_PLUGIN = {
  name: 'katex' as const,
  type: 'math' as const,
  remarkPlugin: [remarkMath, { singleDollarTextMath: true }] as [typeof remarkMath, object],
  rehypePlugin: [rehypeKatex, { trust: false, strict: 'ignore', throwOnError: false, errorColor: 'var(--color-sl-accent)' }] as [typeof rehypeKatex, object],
};
const PLUGINS = { math: MATH_PLUGIN, cjk };
const NO_REHYPE: never[] = [];
const REMARK = [remarkGfm, remarkSpIndex] as const;

type AProps = { href?: string; children?: ReactNode } & Record<string, unknown>;

function SpLink(props: AProps) {
  const studyPathLink = useContext(StudyPathLinkContext);
  const href = props.href ?? '';
  const children = props.children;
  if (props[CHIP_ATTR] === '1') {
    const kind = props[CHIP_KIND_ATTR];
    const id = Number(props[CHIP_ID_ATTR]);
    if (kind === 'cite') return <CitationChip ordinal={id} />;
    if (kind === 'eq') return <EqRefChip ordinal={id} text={typeof children === 'string' ? children : '식'} />;
    const label = SP_HREF.label.exec(href);
    if (kind === 'label' && label) {
      const colocated = String(props[COLOCATED_ATTR] ?? '')
        .split(',')
        .filter(Boolean)
        .map(Number);
      return <LabelBadge label={label[1]!.toUpperCase() as 'P' | 'N' | 'G'} block={id} colocated={colocated} />;
    }
  }
  if (href.startsWith('#sp-')) {
    // Not a parser chip (model-written / forged / malformed): show the literal Markdown so it cannot pass for one.
    return (
      <span data-testid="sp-forged-link">
        [{children}]({href})
      </span>
    );
  }
  return studyPathLink ? <span>{children}</span> : <ExternalLink href={href}>{children}</ExternalLink>;
}

function SpImage(props: { src?: unknown; alt?: unknown }) {
  return <BlockedImage src={typeof props.src === 'string' ? props.src : undefined} alt={typeof props.alt === 'string' ? props.alt : undefined} />;
}

const COMPONENTS = { a: SpLink, img: SpImage } as unknown as Components;

export function SpMarkdown({ displayMd, citations, blocks, stats, phase: phaseIn, onCitationClick, unpaired = false }: SpMarkdownProps) {
  const phase: SpPhase = unpaired && phaseIn === 'final' ? 'failed' : phaseIn;
  const ctx = useMemo<SpRenderContext>(
    () => ({ phase, citations: unpaired ? new Map() : new Map((citations ?? []).map((c) => [c.ordinal, c])), blocks: blocks ?? [], onCitationClick, unpaired }),
    [phase, citations, blocks, onCitationClick, unpaired],
  );
  const streaming = phase === 'streaming';
  return (
    <div className="sp-md text-sm leading-6" data-testid="sp-markdown" data-phase={phase} data-unpaired={unpaired ? '1' : undefined}>
      {unpaired && (
        <div data-testid="pn-unpaired-note" className="mb-1 text-xs text-amber-700">
          {UNPAIRED_NOTE}
        </div>
      )}
      {phase === 'streaming' && (
        <div data-testid="sp-phase-note" className="mb-1 text-xs text-gray-500">
          생성 중 · 인용 확인 전
        </div>
      )}
      {phase === 'failed' && !unpaired && (
        <div data-testid="sp-phase-note" className="mb-1 text-xs text-amber-700">
          중단된 답변 · 인용 확인 안 됨
        </div>
      )}
      <SpContext.Provider value={ctx}>
        <Streamdown
          key={streaming ? 'streaming' : 'static'}
          mode={streaming ? 'streaming' : 'static'}
          isAnimating={streaming}
          parseIncompleteMarkdown={streaming}
          animated={false}
          controls={false}
          lineNumbers={false}
          linkSafety={{ enabled: false }}
          rehypePlugins={NO_REHYPE}
          remarkPlugins={REMARK as never}
          plugins={PLUGINS as never}
          components={COMPONENTS}
        >
          {displayMd}
        </Streamdown>
      </SpContext.Provider>
      {phase === 'final' && !unpaired && stats && (
        <div data-testid="sp-stats" className="mt-1 whitespace-pre-line text-sl-label text-gray-500">
          {statsDetail(stats)}
        </div>
      )}
    </div>
  );
}
