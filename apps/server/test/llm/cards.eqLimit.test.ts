// A card item's body is one content for MAX_EQ_REFS_PER_MESSAGE (S-2, PLAN_M2 9절 41): the first 40 <eq> of an item
// become its citations, the rest stay text; each item counts on its own. Owner B.
import { describe, expect, it } from 'vitest';
import { MAX_EQ_REFS_PER_MESSAGE } from '@study-paper/shared/markup/grammar';
import { readMockOutput } from '@study-paper/shared/mock-outputs';
import { prepareCard } from '../../src/study/paperCards';

const eqs = (n: number) => Array.from({ length: n }, (_, i) => `<eq n="${i + 1}"/>`).join(' ');
const INDEX = Array.from({ length: 41 }, (_, i) => ({ number: String(i + 1), pdfPage: 1 }));

describe('card items: MAX_EQ_REFS_PER_MESSAGE per item body (S-2)', () => {
  it('an item with 41 <eq> stores 40 equation citations; another item with 40 keeps all 40', () => {
    const valid = readMockOutput('notation_card');
    const text = valid
      .replace('<item key="frame_notation" label="N">논문에 명시 없음.</item>', `<item key="frame_notation" label="N">논문에 명시 없음. ${eqs(41)}</item>`)
      .replace('<item key="rotation_param" label="N">논문에 명시 없음.</item>', `<item key="rotation_param" label="N">논문에 명시 없음. ${eqs(40)}</item>`);
    expect(text).not.toBe(valid);
    const p = prepareCard('notation_card', text, [], INDEX);
    if (!p.ok) throw new Error(`invalid: ${JSON.stringify(p.errors)}`);
    const item = (key: string) => p.items.find((i) => i.key === key)!;
    expect(MAX_EQ_REFS_PER_MESSAGE).toBe(40);
    const frame = item('frame_notation').citations;
    expect(frame).toHaveLength(40);
    expect(frame.every((c) => c.kind === 'equation')).toBe(true);
    expect(frame.map((c) => c.eqNumber)).toEqual(Array.from({ length: 40 }, (_, i) => String(i + 1)));
    expect(item('rotation_param').citations).toHaveLength(40);
    // the stored body is the item's text as written (the display parse of it gives the same 40 chips — D uses parseAnswer)
    expect(item('frame_notation').bodyMd).toContain('<eq n="41"/>');
  });
});
