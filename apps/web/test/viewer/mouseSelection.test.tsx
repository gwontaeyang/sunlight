// Vendored MouseSelection (M2 fix round 1): mousedown → mousemove → mouseup delivered faster than React commits
// must still select from the press to the release point (upstream read start / end from listeners re-registered in
// an effect, so a fast mouseup used a stale end — the e2e capture rect was once off by 75.5 px).
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MouseSelection } from '../../src/vendor/pdf-highlighter/components/MouseSelection';

afterEach(cleanup);

const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;

function setup() {
  const onSelection = vi.fn();
  const onReset = vi.fn();
  const viewer = { getPageView: () => ({ viewport: { width: 800, height: 1000 } }) };
  const { container } = render(
    <div id="frame">
      <div className="page" data-page-number="1" id="p1">
        <span id="glyph">x</span>
      </div>
      <MouseSelection viewer={viewer as never} onSelection={onSelection} onReset={onReset} enableAreaSelection={(e: MouseEvent) => e.ctrlKey} />
    </div>,
  );
  const frame = container.querySelector('#frame') as HTMLElement;
  frame.getBoundingClientRect = () => box(100, 50, 900, 900);
  (container.querySelector('#p1') as HTMLElement).getBoundingClientRect = () => box(150, 70, 800, 1000);
  const glyph = container.querySelector('#glyph') as HTMLElement;
  const fire = (target: EventTarget, type: string, x: number, y: number, ctrlKey = true) => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, ctrlKey, clientX: x, clientY: y });
    Object.defineProperty(e, 'pageX', { value: x });
    Object.defineProperty(e, 'pageY', { value: y });
    target.dispatchEvent(e);
  };
  return { onSelection, onReset, frame, glyph, fire };
}

describe('MouseSelection (vendored, study_paper refs)', () => {
  it('a burst of events without a React commit in between ends the rect at the mouseup point', () => {
    const { onSelection, glyph, fire } = setup();
    // no act(): React has not re-rendered between the events (the race that the upstream closures lost)
    fire(glyph, 'mousedown', 230, 170);
    fire(glyph, 'mousemove', 300, 220);
    fire(glyph, 'mousemove', 400, 260);
    fire(glyph, 'mouseup', 630, 370);
    expect(onSelection).toHaveBeenCalledTimes(1);
    const [viewport, scaled, image] = onSelection.mock.calls[0]!;
    // container (100, 50) → page (150, 70) offset: page-relative = client − (150, 70)
    expect(viewport.boundingRect).toEqual({ left: 80, top: 100, width: 400, height: 200, pageNumber: 1 });
    expect(scaled.boundingRect).toMatchObject({ x1: 80, y1: 100, x2: 480, y2: 300, width: 800, height: 1000, pageNumber: 1 });
    expect(image).toBeUndefined();
  });

  it('a release without movement (zero area) resets instead of selecting; a plain press does not start', () => {
    const { onSelection, onReset, glyph, fire } = setup();
    fire(glyph, 'mousedown', 230, 170, false);
    fire(glyph, 'mouseup', 630, 370, false);
    expect(onSelection).not.toHaveBeenCalled();
    fire(glyph, 'mousedown', 230, 170);
    fire(glyph, 'mouseup', 230, 170);
    expect(onSelection).not.toHaveBeenCalled();
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('the finished selection is locked until its reset callback runs; then a new drag works', () => {
    const { onSelection, glyph, fire } = setup();
    fire(glyph, 'mousedown', 230, 170);
    fire(glyph, 'mouseup', 330, 270);
    expect(onSelection).toHaveBeenCalledTimes(1);
    fire(glyph, 'mousemove', 600, 600);
    fire(document, 'mouseup', 600, 600);
    expect(onSelection).toHaveBeenCalledTimes(1);
    const reset = onSelection.mock.calls[0]![3] as () => void;
    act(() => reset());
    fire(glyph, 'mousedown', 250, 170);
    fire(glyph, 'mouseup', 350, 290);
    expect(onSelection).toHaveBeenCalledTimes(2);
    expect(onSelection.mock.calls[1]![0].boundingRect).toEqual({ left: 100, top: 100, width: 100, height: 120, pageNumber: 1 });
  });
});
