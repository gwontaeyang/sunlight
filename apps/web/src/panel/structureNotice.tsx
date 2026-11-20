// "구조 색인 없음" notice of the equations / references tabs (BRIEF_D D1). The upgrade button itself lives in C's Library and
// outline — this only says where. Owner D.
export function NoStructureNotice({ what }: { what: string }) {
  return (
    <div data-testid="pn-no-structure" className="rounded bg-gray-50 px-2 py-1.5 text-xs text-gray-600">
      구조 색인 없음 — 이 논문에는 arXiv HTML에서 만든 구조 색인이 없어 {what}을(를) 보여 줄 수 없습니다. Library의 논문 카드나 목차의 ‘구조
      가져오기’로 색인을 만들 수 있습니다.
    </div>
  );
}

/** Scrolls an element into view when it exists (no-op where the DOM has no scrollIntoView). */
export function scrollIntoViewSafe(el: Element | null) {
  if (el && typeof (el as HTMLElement).scrollIntoView === 'function') (el as HTMLElement).scrollIntoView({ block: 'nearest' });
}
