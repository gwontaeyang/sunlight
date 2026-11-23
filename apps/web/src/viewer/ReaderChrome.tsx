// Reader frame pieces (M3a, PLAN_M3 §4, concept_CD C reader). Owner C.
// - Reader preferences: outline docking; the shared theme also controls the PDF tone.
// - ReaderBarSlot: the element in the top bar where the viewer (PdfReader) portals its zoom and page controls, so the
//   controls keep their state and test ids in the viewer while they are drawn in the centred bar.
// - LeftRail: logo, Library and the day / night switch.
// - PaperInfoButton: the paper's version and where its structure index came from, the AI state, and that the usage
//   limit is not known in M3a ("미확인" — no limit data is read yet).
import { createContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'wouter';
import { create } from 'zustand';
import type { PaperDetailDto } from '@study-paper/shared/contracts/api';
import { aiStatus } from '../library/readiness';
import { Icon, SunMark } from '../ui/icons';
import { ThemeSwitch, useThemeStore } from '../ui/theme';

const OUTLINE_KEY = 'sl.reader.outlineOpen';

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the choice lasts for this tab */
  }
}

export interface ReaderUiStore {
  /** The outline column (wide screens) or drawer (narrow screens) is open. null = the default for the width. */
  outlineOpen: boolean | null;
  setOutlineOpen(open: boolean): void;
}

export const useReaderUiStore = create<ReaderUiStore>((set) => ({
  outlineOpen: read(OUTLINE_KEY) === '0' ? false : read(OUTLINE_KEY) === '1' ? true : null,
  setOutlineOpen: (open) => {
    write(OUTLINE_KEY, open ? '1' : '0');
    set({ outlineOpen: open });
  },
}));

/** The outline docks as a column from this width; below it, it opens as a drawer over the PDF. */
export const OUTLINE_DOCK_MIN_PX = 1200;

export function useMediaQuery(query: string): boolean {
  const [mql] = useState(() => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null));
  return useSyncExternalStore(
    (cb) => {
      if (!mql) return () => {};
      mql.addEventListener('change', cb);
      return () => mql.removeEventListener('change', cb);
    },
    () => (mql ? mql.matches : true),
    () => true,
  );
}

/** The top bar element the viewer portals its zoom / page controls into (null until the bar is mounted). */
export const ReaderBarSlot = createContext<HTMLElement | null>(null);

const railButton = 'inline-grid size-8 place-items-center rounded-sl-control text-sl-muted hover:bg-sl-subtle hover:text-sl-ink';

export function LeftRail() {
  return (
    <nav aria-label="앱" data-testid="rd-left-rail" className="col-start-1 row-span-2 row-start-1 flex min-h-0 flex-col items-center border-r border-sl-line bg-sl-surface">
      <div className="grid h-sl-bar w-full shrink-0 place-items-center border-b border-sl-line">
        <Link href="/" aria-label="Sunlight 서재" title="Sunlight 서재" className="inline-grid size-9 place-items-center rounded-sl-control hover:bg-sl-subtle">
          <SunMark size={24} />
        </Link>
      </div>
      <Link href="/" aria-label="Library" title="Library" className={`${railButton} mt-3`}>
        <Icon name="library" size={20} />
      </Link>
      <ThemeSwitch rail />
    </nav>
  );
}

/** "원본 색 보기" ↔ "Dark로 보기": the night filter of the PDF page on / off (night theme only). */
export function PaperToneToggle() {
  const theme = useThemeStore((s) => s.theme);
  const tone = useThemeStore((s) => s.tone);
  const toggleTone = useThemeStore((s) => s.toggleTone);
  if (theme !== 'dark') return null;
  const original = tone === 'original';
  return (
    <button
      type="button"
      data-testid="rd-paper-tone"
      aria-pressed={original}
      title={original ? 'PDF 쪽을 Dark로 보기' : 'PDF 쪽(그림·표 포함)을 원본 색으로 보기'}
      className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] border px-2 text-sl-label ${original ? 'border-sl-accent-line bg-sl-accent-soft text-sl-accent' : 'border-sl-edge text-sl-muted hover:text-sl-ink'}`}
      onClick={toggleTone}
    >
      <Icon name="pageshade" size={15} />
      {original ? 'Dark로 보기' : '원본 색 보기'}
    </button>
  );
}

const STRUCTURE_SOURCE_KO: Record<string, string> = { latexml: 'arXiv HTML(LaTeXML)', 'pdf-outline': 'PDF 목차', 'pdf-inferred': 'PDF 본문에서 추정한 목차', none: '없음' };

/** "ⓘ" in the top bar: version · pages, structure source · index, AI state, usage limit unknown. */
export function PaperInfoButton({ paper }: { paper: PaperDetailDto | undefined }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  const p = paper;
  const version = !p ? '…' : p.arxivId ? `arXiv ${p.arxivId}${p.arxivVersion ? `v${p.arxivVersion}` : ''}` : '직접 올린 PDF';
  const index = !p ? '…' : p.supplementVersion === 2 ? '색인 v2' : p.supplementVersion === 1 ? '메타데이터만' : '준비 전';
  const ai = p ? aiStatus(p) : null;
  const rows: [string, string][] = [
    ['판', `${version}${p?.pageCount ? ` · ${p.pageCount}쪽` : ''}`],
    ['구조 출처', p ? `${STRUCTURE_SOURCE_KO[p.structureSource ?? 'none'] ?? '없음'} · ${index}` : '…'],
    ['AI', ai ? (ai.available ? '사용 가능' : (ai.short ?? '사용 불가')) : '…'],
    ['사용 한도', '미확인'],
  ];
  return (
    <div ref={boxRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        data-testid="rd-paper-info"
        aria-expanded={open}
        aria-label="논문 정보"
        title="논문 정보"
        className={`inline-grid size-8 place-items-center rounded-sl-control ${open ? 'bg-sl-subtle text-sl-ink' : 'text-sl-muted hover:bg-sl-subtle hover:text-sl-ink'}`}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="info" size={18} />
      </button>
      {open && (
        <div role="dialog" aria-label="논문 정보" data-testid="rd-paper-info-pop" className="absolute top-full left-1/2 z-50 mt-2 w-72 -translate-x-1/2 rounded-sl-control border border-sl-line bg-sl-raised p-3 text-sl-label whitespace-normal text-sl-body shadow-sl-card">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-sl-meta">{k}</dt>
                <dd className="m-0 [overflow-wrap:anywhere]" data-testid={`rd-paper-info-${k === '판' ? 'version' : k === '구조 출처' ? 'structure' : k === 'AI' ? 'ai' : 'limit'}`}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
