// Sunlight's own line icons and logo (M3a, concept_CD). Owner: supervisor (공용 UI). Self-drawn 24×24 strokes in
// currentColor — no icon library. Decorative: every icon is aria-hidden; the control that holds it carries the name.
import type { SVGProps } from 'react';

const PATHS = {
  library: <path d="M5 4.5v15M9 4.5v15M13 5.3l4.4 14M3.5 19.5h17" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="3.75" />
      <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6" />
    </>
  ),
  dusk: <path d="M3.5 16h17M7 16a5 5 0 0 1 10 0M9 19.5h6M12 6.5v1.8M6.4 9.2l1.2 1.2M17.6 9.2l-1.2 1.2" />,
  outline: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9.5 4.5v15M5.8 8.5h1.4M5.8 11.5h1.4M5.8 14.5h1.4" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.2M12 7.8v.01" />
    </>
  ),
  minus: <path d="M5.5 12h13" />,
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  fit: <path d="M4 5v14M20 5v14M7.5 12h9M10 9.5 7.5 12l2.5 2.5M14 9.5l2.5 2.5-2.5 2.5" />,
  pageshade: (
    <>
      <rect x="5.5" y="3.5" width="13" height="17" rx="1.5" />
      <path d="M12 3.5h5a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5h-5z" fill="currentColor" stroke="none" />
    </>
  ),
  back: (
    <>
      <path d="M9 7.5 5 11.5l4 4" />
      <path d="M5 11.5h9.5a4.5 4.5 0 0 1 0 9H12" />
    </>
  ),
  panelClose: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M14.5 4.5v15M8 9.5l2.5 2.5L8 14.5" />
    </>
  ),
  panelOpen: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M14.5 4.5v15M10.5 9.5 8 12l2.5 2.5" />
    </>
  ),
  ai: (
    <>
      <path d="M5.5 4.5h13a2 2 0 0 1 2 2V15a2 2 0 0 1-2 2H11l-4.5 3.5V17h-1a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2z" />
      <path d="M12 7.4l.8 2.3 2.3.8-2.3.8-.8 2.3-.8-2.3-2.3-.8 2.3-.8z" />
    </>
  ),
  highlighter: (
    <>
      <path d="M14.5 4.5l5 5-7.5 7.5H7v-5z" />
      <path d="M7 17l-2.5 2.5h5" />
      <path d="M11.2 7.8l5 5" />
    </>
  ),
  cards: (
    <>
      <rect x="4" y="8" width="12.5" height="11.5" rx="2" />
      <path d="M8 4.5h9.5a2 2 0 0 1 2 2V16" />
    </>
  ),
  sigma: <path d="M17 5H7l5.5 7L7 19h10" />,
  refs: (
    <>
      <path d="M6.5 4h11a1 1 0 0 1 1 1v13.5h-12a1.75 1.75 0 0 0 0 3.5h12" />
      <path d="M4.75 20.25V5.75A1.75 1.75 0 0 1 6.5 4" />
      <path d="M10 4v6l2-1.4 2 1.4V4" />
    </>
  ),
  glossary: (
    <>
      <path d="M6.5 4h11a1 1 0 0 1 1 1v13.5h-12a1.75 1.75 0 0 0 0 3.5h12" />
      <path d="M4.75 20.25V5.75A1.75 1.75 0 0 1 6.5 4" />
      <path d="M9.6 14.6 12 8.4l2.4 6.2M10.4 12.6h3.2" />
    </>
  ),
  send: <path d="M12 18.5V6M6.5 11 12 5.5l5.5 5.5" />,
  min: <path d="M6 16h12" />,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  spark: (
    <>
      <path d="M11 3.5l1.7 5 5 1.7-5 1.7-1.7 5-1.7-5-5-1.7 5-1.7z" />
      <path d="M18 15.2l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" />
    </>
  ),
  translate: (
    <>
      <path d="M4 6.5h8M8 4.5v2M10.5 6.5c-.6 3.2-2.8 5.9-6 7.3M5.8 9.3c1 1.8 2.6 3.3 4.7 4.2" />
      <path d="M12.5 20l3.5-8.5 3.5 8.5M13.8 17h4.4" />
    </>
  ),
  question: <path d="M20 11.5a8 8 0 0 1-11.6 7.1L4 20l1.4-4.2A8 8 0 1 1 20 11.5z" />,
  note: (
    <>
      <path d="M11 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V13" />
      <path d="M17.8 3.9a1.8 1.8 0 0 1 2.5 2.5L13 13.7l-3.2.8.8-3.2z" />
    </>
  ),
  trash: <path d="M4.5 7h15M9.5 7V5h5v2M6.5 7l.9 12.1a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />,
  arrow: <path d="M5 12h13M13 7l5 5-5 5" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  import: <path d="M12 4.5v10M7.5 10.5 12 15l4.5-4.5M5 19.5h14" />,
  dock: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M12.5 13.5h5v3h-5z" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, ...rest }: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="block shrink-0"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}

/** The sun disc and its long shadow (concept_CD logo.svg). Colours follow the sun / ink tokens (day and night). */
export function SunMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" className="block shrink-0" data-testid="sl-logo">
      <circle cx="12.5" cy="11" r="7" fill="var(--color-sl-sun)" />
      <path d="M5.6 21.6 L29.2 25.1 Q30 25.6 29.2 26.1 L5.6 25.6 Q4.2 25.55 4.2 24.2 L4.2 23 Q4.2 21.45 5.6 21.6 Z" fill="var(--color-sl-ink)" />
    </svg>
  );
}

/** Logo + the word "Sunlight" as text (concept_CD wordmark.svg). */
export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2 text-[20px] leading-7 font-semibold tracking-[-0.8px] text-sl-ink" data-testid="sl-wordmark">
      <SunMark size={28} />
      Sunlight
    </span>
  );
}
