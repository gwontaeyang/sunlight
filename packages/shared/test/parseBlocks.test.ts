// SP-Blocks parser (PLAN_M2 3.4, BRIEF_B B4). Owner B.
import { describe, expect, it } from 'vitest';
import { ParsedBlocksSchema } from '../src/contracts/domain';
import { formatBlockError } from '../src/contracts/blocks';
import { validateBlocks, type BlocksTask } from '../src/markup/blockSchemas';
import { parseAnswer } from '../src/markup/parseAnswer';
import { ISSUE_CONTROL, ISSUE_INPUT_TOO_LONG, ISSUE_NESTED, ISSUE_UNCLOSED, parseBlocks, SP_BLOCKS_INPUT_MAX_CHARS, type BlocksWork } from '../src/markup/parseBlocks';
import { readMockFile, readMockManifest, readMockOutput } from '../src/mockOutputs';

const item = (key: string, label = 'N', body = '본문.') => `<item key="${key}" label="${label}">${body}</item>`;

describe('parseBlocks: task outputs', () => {
  for (const task of ['notation_card', 'assumptions_card', 'glossary_define'] as const) {
    it(`${task}: the mock output parses and validates`, () => {
      const p = parseBlocks(readMockOutput(task), task);
      expect(() => ParsedBlocksSchema.parse(p)).not.toThrow();
      expect(p.issues).toEqual([]);
      const v = validateBlocks(task, p, { requestedTerm: 'robust kernel' });
      expect(v.ok).toBe(true);
    });
  }
  it('notation_card: 11 items with key/label attrs and the body between the tags', () => {
    const p = parseBlocks(readMockOutput('notation_card'), 'notation_card');
    expect(p.items).toHaveLength(11);
    expect(p.items[6]).toEqual({ tag: 'item', attrs: { key: 'state_vector', label: 'P' }, body: '<q>The state vector is x = [p, v, q] and gravity is 9.81 m/s^2.</q>', children: [] });
  });
  it('a multi-line body ends at the first closing tag; text after it is outside', () => {
    const p = parseBlocks('<item key="units" label="P">line one\nline two</item> trailing\n', 'notation_card');
    expect(p.items[0]!.body).toBe('line one\nline two');
    expect(p.outsideText).toBe('trailing');
  });
});

describe('parseBlocks: text, not tags', () => {
  it('a tag inside a code fence is text (in the outside text and inside an item body)', () => {
    const p = parseBlocks('```\n<item key="units" label="P">x</item>\n```\n' + item('units', 'P', 'y'), 'notation_card');
    expect(p.items.map((i) => i.body)).toEqual(['y']);
    expect(p.outsideText).toContain('<item key="units"');
    const inBody = parseBlocks('<item key="units" label="P">a\n~~~\n<item key="units" label="N">fenced</item>\n~~~\nb</item>', 'notation_card');
    expect(inBody.items).toHaveLength(1);
    expect(inBody.issues).toEqual([]);
    expect(inBody.items[0]!.body).toContain('fenced');
  });
  it('a tag in the middle of a line is text', () => {
    const p = parseBlocks(`text ${item('units')}\n`, 'notation_card');
    expect(p.items).toEqual([]);
  });
  it('a non-whitelisted or repeated attribute makes the tag text; quotes / brackets in values too', () => {
    for (const line of ['<item key="units" label="P" onclick="x">a</item>', '<item key="units" key="units">a</item>', '<item title="t">a</item>', '<item key="un<its" label="P">a</item>', '<itemx key="units">a</itemx>', '<term name="x">a</term>']) {
      expect(parseBlocks(line, 'notation_card').items, line).toEqual([]);
    }
  });
  it('an element not closed at the end is text + issue', () => {
    const p = parseBlocks('<item key="units" label="P">never closed\nmore', 'notation_card');
    expect(p.items).toEqual([]);
    expect(p.issues).toContain(ISSUE_UNCLOSED);
    expect(p.outsideText).toContain('never closed');
  });
  it('control characters (chip markers) are removed before parsing', () => {
    const p = parseBlocks(`<item key="units" label="P">a \u0003c1\u0004 b</item>`, 'notation_card');
    expect(p.items[0]!.body).toBe('a c1 b');
    expect(p.issues).toContain(ISSUE_CONTROL);
  });
  it('tags of other tasks are text (whitelist per task)', () => {
    expect(parseBlocks('<term name="x">y</term>', 'notation_card').items).toEqual([]);
    expect(parseBlocks(item('units'), 'glossary_define').items).toEqual([]);
    expect(parseBlocks(item('units'), 'unknown_task').items).toEqual([]);
  });
});

describe('parseBlocks: nesting is a validation error (S review R2-01, coordinator note 1(a))', () => {
  const e = readMockManifest().m2.blocksAdversarial.nested_item!;
  it('nested_item: the manifest says invalid; the BlockError code is unclosed_tag; the inner <q> is no citation', () => {
    expect(e.expect.valid).toBe(false);
    const p = parseBlocks(readMockFile(e.file), e.task);
    expect(p.issues).toContain(ISSUE_NESTED);
    const v = validateBlocks(e.task as BlocksTask, p);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.map((x) => x.code)).toContain('unclosed_tag');
    // the inner line is never part of the outer body (its quote cannot become the outer item's verbatim citation)
    const outer = p.items[0]!;
    expect(outer.body).not.toContain('<q>');
    expect(parseAnswer(outer.body, { labels: 'strip' }).citations).toEqual([]);
  });
});

describe('parseBlocks: limits', () => {
  it('61 items → too_many_items; 60 are fine for the parser', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `<item category="computation" label="N">가정 ${i + 1}.</item>`).join('\n');
    expect(parseBlocks(many(61), 'assumptions_card').items).toHaveLength(61);
    const v = validateBlocks('assumptions_card', parseBlocks(many(61), 'assumptions_card'));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.map((x) => x.code)).toContain('too_many_items');
    const e = readMockManifest().m2.blocksAdversarial.sixty_one_items!;
    const vf = validateBlocks('assumptions_card', parseBlocks(readMockFile(e.file), 'assumptions_card'));
    expect(vf.ok).toBe(false);
  });
  it('a body of 8,001 chars → body_too_long with its item number; 8,000 passes the length rule', () => {
    const keys = ['frame_notation', 'transform_direction', 'rotation_param', 'quaternion_convention', 'perturbation_side', 'error_definition', 'state_vector', 'jacobian_convention', 'gravity_sign', 'time_notation', 'units'];
    const card = (len: number) => keys.map((k, i) => item(k, 'N', i === 2 ? 'x'.repeat(len) : '본문.')).join('\n');
    expect(validateBlocks('notation_card', parseBlocks(card(8000), 'notation_card')).ok).toBe(true);
    const v = validateBlocks('notation_card', parseBlocks(card(8001), 'notation_card'));
    expect(v).toEqual({ ok: false, errors: [{ code: 'body_too_long', item: 3 }] });
  });
  it('an input of 200,001 chars is not parsed', () => {
    const raw = item('units') + ' '.repeat(SP_BLOCKS_INPUT_MAX_CHARS + 1 - item('units').length);
    expect(raw.length).toBe(SP_BLOCKS_INPUT_MAX_CHARS + 1);
    const p = parseBlocks(raw, 'notation_card');
    expect(p).toEqual({ items: [], outsideText: '', issues: [ISSUE_INPUT_TOO_LONG] });
    expect(validateBlocks('notation_card', p).ok).toBe(false);
    expect(parseBlocks(raw.slice(0, -1), 'notation_card').items).toHaveLength(1);
  });
  it('an element never closed, with ~199,000 body lines, is text + issue and does not throw (review B-R2-03)', () => {
    const raw = `<item key="units" label="P">\n${'\n'.repeat(SP_BLOCKS_INPUT_MAX_CHARS - 1_000)}`;
    expect(raw.length).toBeLessThanOrEqual(SP_BLOCKS_INPUT_MAX_CHARS);
    let p: ReturnType<typeof parseBlocks> | undefined;
    expect(() => (p = parseBlocks(raw, 'notation_card'))).not.toThrow();
    expect(p!.items).toEqual([]);
    expect(p!.issues).toContain(ISSUE_UNCLOSED);
    expect(p!.outsideText).toBe('<item key="units" label="P">');
    expect(validateBlocks('notation_card', p!).ok).toBe(false);
  });
  it('work is linear: 100× the input → ≤ 100× the steps + a constant', () => {
    const unit = `${item('units', 'P', '<q>a</q> b')}\n<item key="units" label="P" junk\n${'<'.repeat(30)}\n\`\`\`\n<item x\n\`\`\`\n`;
    const count = (raw: string) => {
      const w: BlocksWork = { steps: 0 };
      parseBlocks(raw, 'notation_card', w);
      return w.steps;
    };
    const one = count(unit);
    const hundred = count(unit.repeat(100));
    expect(hundred).toBeLessThanOrEqual(100 * one + 100);
    // a long line of attribute-like text is linear too
    const attrs = (n: number) => `<item${' key="units"'.repeat(n)}`;
    expect(count(attrs(10_000))).toBeLessThanOrEqual(100 * count(attrs(100)) + 100);
  });
});

describe('blocks_adversarial (every file): no forged citation; ≤ 60 items; nothing the model wrote in an error', () => {
  const legit = new Set([...readMockOutput('notation_card').matchAll(/<q>([\s\S]*?)<\/q>/g)].map((m) => m[1]!));
  for (const [name, e] of Object.entries(readMockManifest().m2.blocksAdversarial)) {
    it(name, () => {
      const p = parseBlocks(readMockFile(e.file), e.task);
      const v = validateBlocks(e.task as BlocksTask, p);
      if (e.expect.valid === false) expect(v.ok).toBe(false);
      if (typeof e.expect.items === 'number') {
        expect(v.ok).toBe(true);
        if (v.ok) expect(v.items).toHaveLength(e.expect.items);
      }
      if (v.ok) {
        expect(v.items.length).toBeLessThanOrEqual(e.expect.maxItems ?? 60);
        for (const it of v.items) {
          for (const c of parseAnswer(it.bodyMd, { labels: 'strip' }).citations) if (c.kind === 'quote') expect(legit.has(c.quote!), `${name}: ${c.quote}`).toBe(true);
          expect(parseAnswer(it.bodyMd, { labels: 'strip' }).blocks.every((b) => b.label === undefined)).toBe(true);
        }
      } else {
        for (const err of v.errors) expect(() => formatBlockError(err)).not.toThrow();
      }
    });
  }
});
