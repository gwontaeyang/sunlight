// M3a floating card host (PLAN_M3 §4 DOM spike, CP-A): placement under the selection, flip, both-axis clamp, dock,
// the preview switch, and the card's own controls (fixed answer, no request). Owner C.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANCHOR_GAP_PX, CARD_MAX_WIDTH_PX, cardPreviewEnabled, FloatingCardHost, placeFloatingCard, selectionBox } from '../../src/viewer/FloatingCard';

afterEach(cleanup);

describe('placeFloatingCard', () => {
  const host = { hostW: 680, hostH: 852 };
  it('below the last selected line by the anchor gap (8 px), left edge at the selection', () => {
    const p = placeFloatingCard({ ...host, sel: { left: 200, top: 200, right: 620, bottom: 246 }, cardH: 400 });
    expect(ANCHOR_GAP_PX).toBe(8);
    expect(p).toMatchObject({ placement: 'below', top: 246 + 8, left: 200, width: CARD_MAX_WIDTH_PX });
    expect(p.maxHeight).toBe(852 - (246 + 8) - 8);
  });
  it('clamps the left edge so the card stays inside the viewer, and narrows in a narrow viewer', () => {
    expect(placeFloatingCard({ ...host, sel: { left: 600, top: 100, right: 670, bottom: 120 }, cardH: 300 }).left).toBe(680 - CARD_MAX_WIDTH_PX - 8);
    const narrow = placeFloatingCard({ hostW: 300, hostH: 700, sel: { left: 10, top: 100, right: 200, bottom: 120 }, cardH: 300 });
    expect(narrow.width).toBe(300 - 24);
    expect(narrow.left).toBe(10);
    expect(placeFloatingCard({ hostW: 300, hostH: 700, sel: { left: -40, top: 100, right: 200, bottom: 120 }, cardH: 300 }).left).toBe(8);
  });
  it('flips above when there is clearly more room above; never overlaps the selection', () => {
    const sel = { left: 100, top: 700, right: 400, bottom: 760 };
    const p = placeFloatingCard({ ...host, sel, cardH: 400 });
    expect(p.placement).toBe('above');
    expect(p.top + Math.min(400, p.maxHeight)).toBe(700 - 8);
    expect(p.top).toBeGreaterThanOrEqual(8);
  });
  it('stays below with a scrolling body when below is still big enough for the minimum', () => {
    const p = placeFloatingCard({ ...host, sel: { left: 100, top: 560, right: 400, bottom: 600 }, cardH: 500 });
    expect(p.placement).toBe('below');
    expect(p.maxHeight).toBe(852 - 608 - 8);
  });
  it('docks at the lower right when the selection is off screen or on request', () => {
    for (const sel of [null, { left: 100, top: -200, right: 400, bottom: -150 }, { left: 100, top: 900, right: 400, bottom: 950 }]) {
      const p = placeFloatingCard({ ...host, sel, cardH: 300 });
      expect(p.placement).toBe('dock');
      expect(p.left + p.width).toBe(680 - 16);
      expect(p.top + 300).toBe(852 - 16);
    }
    expect(placeFloatingCard({ ...host, sel: { left: 100, top: 100, right: 300, bottom: 120 }, cardH: 300, dock: true }).placement).toBe('dock');
  });
});

describe('cardPreviewEnabled', () => {
  it('only ?sl-card=fixed turns the M3a preview on', () => {
    expect(cardPreviewEnabled('?sl-card=fixed')).toBe(true);
    expect(cardPreviewEnabled('?x=1&sl-card=fixed')).toBe(true);
    for (const q of ['', '?sl-card=1', '?sl-card=FIXED', '?card=fixed']) expect(cardPreviewEnabled(q)).toBe(false);
  });
});

/** A host and a frame with one pdf.js-like page (padding box 600 × 800 at 20,10 with a 9 px border). */
function layout() {
  const frame = document.createElement('div');
  const page = document.createElement('div');
  page.className = 'page';
  page.dataset.pageNumber = '3';
  frame.appendChild(page);
  document.body.appendChild(frame);
  const rect = (l: number, t: number, w: number, h: number) => ({ left: l, top: t, right: l + w, bottom: t + h, width: w, height: h, x: l, y: t, toJSON() {} }) as DOMRect;
  vi.spyOn(page, 'getBoundingClientRect').mockReturnValue(rect(20, 10, 618, 818));
  Object.defineProperties(page, { clientLeft: { value: 9 }, clientTop: { value: 9 }, clientWidth: { value: 600 }, clientHeight: { value: 800 } });
  return { frame, page, rect };
}

describe('selectionBox', () => {
  it('maps the NormRects of the last page into host coordinates through the page padding box', () => {
    const { frame, rect } = layout();
    const host = document.createElement('div');
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 680, 852));
    const box = selectionBox(host, frame, [
      { page: 3, x: 0.5, y: 0.25, w: 0.4, h: 0.02 },
      { page: 3, x: 0.5, y: 0.27, w: 0.3, h: 0.02 },
    ]);
    expect(box!.left).toBeCloseTo(29 + 300, 6);
    expect(box!.top).toBeCloseTo(19 + 200, 6);
    expect(box!.right).toBeCloseTo(29 + 540, 6);
    expect(box!.bottom).toBeCloseTo(19 + 0.29 * 800, 6);
    expect(selectionBox(host, frame, [{ page: 9, x: 0, y: 0, w: 0.1, h: 0.1 }])).toBeNull();
    frame.remove();
  });
});

describe('FloatingCardHost', () => {
  it('fixed answer card: no request, send only after typing, Esc and 닫기 close, minimise / restore, dock toggle', async () => {
    const { frame } = layout();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onClose = vi.fn();
    const req = { id: 1, rects: [{ page: 3, x: 0.1, y: 0.1, w: 0.5, h: 0.02 }], text: 'The constant velocity model' };
    const { rerender } = render(<FloatingCardHost request={null} frame={frame} eventBus={null} onClose={onClose} />);
    expect(screen.queryByTestId('rd-float-card')).toBeNull();
    rerender(<FloatingCardHost request={req} frame={frame} eventBus={null} onClose={onClose} />);
    const card = await screen.findByTestId('rd-float-card');
    expect(card.getAttribute('role')).toBe('dialog');
    expect(screen.getByTestId('rd-float-quote').textContent).toContain('The constant velocity model');
    // nothing here is a grounding badge: the fixed answer was never checked
    expect(card.querySelector('[data-testid="sp-badge"], [data-testid="sp-chip"], [data-testid="pn-item-badge"]')).toBeNull();
    expect(card.textContent).not.toContain('논문 근거');
    const send = screen.getByTestId('rd-float-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('rd-float-input'), { target: { value: '왜 등속 모델인가요?' } });
    expect(send.disabled).toBe(false);
    fireEvent.keyDown(screen.getByTestId('rd-float-input'), { key: 'Enter', ctrlKey: true });
    expect(screen.getByTestId('rd-float-sent-note').textContent).toContain('보내지 않습니다');
    expect((screen.getByTestId('rd-float-input') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByTestId('rd-float-dock'));
    expect(screen.getByTestId('rd-float-card').dataset.placement).toBe('dock');
    fireEvent.click(screen.getByTestId('rd-float-min'));
    expect(screen.queryByTestId('rd-float-card')).toBeNull();
    fireEvent.click(screen.getByTestId('rd-float-restore'));
    expect(screen.getByTestId('rd-float-card')).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId('rd-float-card'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('rd-float-close'));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    await act(async () => {});
    fetchSpy.mockRestore();
    frame.remove();
  });
});
