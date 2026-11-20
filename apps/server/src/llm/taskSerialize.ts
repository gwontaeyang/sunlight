// The last text block of every request: <task name v> + <instructions trust="app"> + input blocks (PLAN 7.2).
// Owner B. Every inserted value is escaped (& < >; attributes also "), stripped of control characters and
// capped per field. Each input block carries a `trust` attribute: paper (text from the paper), user (the
// user's own words), model (earlier answers in <history>). This keeps the structure intact; it does NOT make
// prompt injection impossible (PLAN 3, 7.2).
import { readFileSync } from 'node:fs';
import type { TaskId } from '@study-paper/shared/contracts/tasks';

/** paper / user / model mark input data; app marks the app's own fixed text (instructions, repair error lines). */
export type Trust = 'paper' | 'user' | 'model' | 'app';

export const FIELD_LIMITS = {
  selection: 8000,
  question: 8000,
  context: 300,
  section: 200,
  page: 8,
  /** ≈ 6k tokens (PLAN 2.4: history ≈ 6k tokens ≈ 24,000 chars). */
  historyChars: 24_000,
  // M2 (PLAN_M2 3.5–3.6, BRIEF_B B7)
  term: 200,
  /** translate: page text before / after the selection. */
  paragraph: 600,
  /** translate: the paper's glossary — at most this many terms and characters in total. */
  glossaryTerms: 30,
  glossaryChars: 2000,
  /** translate: one known term's definition (cut with …), so one long definition cannot crowd out the others. */
  glossaryDefinition: 200,
  /** figure: captions anchored to the area's page. */
  captions: 3,
  captionChars: 600,
  /** equation: the stored LaTeX is ≤ 4,000 chars (EQUATION_LATEX_MAX); the text around it. */
  latex: 4000,
  neighbor: 600,
  equationNumber: 40,
  htmlId: 100,
  /** SP-Blocks repair (PLAN_M2 3.4): the previous output and at most 10 error lines. */
  previousOutput: 20_000,
  repairErrors: 10,
} as const;

/** One earlier turn of a thread (oldest first). */
export interface HistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** Task inputs as they travel in RunTaskInput.inputs (strings only; history as JSON of HistoryTurn[]). */
export const INPUT_KEYS = [
  'selection',
  'page',
  'section',
  'context_before',
  'context_after',
  'question',
  'history',
  'regenerate',
  // M2
  'term',
  'paragraph_before',
  'paragraph_after',
  /** JSON {term, definition}[] */
  'glossary_known',
  /** page number of a capture area */
  'area_page',
  /** JSON string[] */
  'nearby_captions',
  /** JSON {n, htmlId, latex} */
  'equation',
  /** JSON {before, after, prev, next} */
  'neighbors',
] as const;
export type InputKey = (typeof INPUT_KEYS)[number];

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function stripControl(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(CONTROL, '');
}
export function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
export function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;').replace(/\n/g, ' ');
}
/** Control characters removed, then capped (head for most fields). */
function clean(s: string, max: number, keep: 'head' | 'tail' = 'head'): string {
  const c = stripControl(s);
  if (c.length <= max) return c;
  return keep === 'head' ? `${c.slice(0, max)}…` : `…${c.slice(c.length - max)}`;
}

const TEMPLATES: Partial<Record<TaskId, string>> = {};
/** Instructions of a task (llm/prompts/<task>.md). M1: explain_selection, chat. */
export function taskTemplate(task: TaskId): string {
  const cached = TEMPLATES[task];
  if (cached !== undefined) return cached;
  let text: string;
  try {
    text = readFileSync(new URL(`./prompts/${task}.md`, import.meta.url), 'utf8').trim();
  } catch {
    throw new Error(`no prompt template for task ${task}`);
  }
  TEMPLATES[task] = text;
  return text;
}

/** Keeps the most recent turns within the budget (oldest dropped first; an oversized last turn is cut). */
export function fitHistory(turns: readonly HistoryTurn[], budget: number = FIELD_LIMITS.historyChars): HistoryTurn[] {
  const out: HistoryTurn[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    const text = stripControl(t.text);
    if (used + text.length <= budget) {
      out.unshift({ role: t.role, text });
      used += text.length;
    } else {
      if (out.length === 0) out.unshift({ role: t.role, text: `${text.slice(0, budget)}…` });
      break;
    }
  }
  return out;
}

function parseHistory(raw: string | undefined): HistoryTurn[] {
  if (!raw) return [];
  const v = JSON.parse(raw) as unknown;
  if (!Array.isArray(v)) throw new Error('history must be a JSON array');
  return v.map((t) => {
    const turn = t as Partial<HistoryTurn>;
    if ((turn.role !== 'user' && turn.role !== 'assistant') || typeof turn.text !== 'string') throw new Error('invalid history turn');
    return { role: turn.role, text: turn.text };
  });
}

const block = (tag: string, trust: Trust, value: string, attrs: Record<string, string | undefined> = {}) => {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => ` ${k}="${escapeAttr(v!)}"`)
    .join('');
  return `<${tag} trust="${trust}"${a}>${escapeText(value)}</${tag}>`;
};

/** The SP-Blocks repair part of a task block (PLAN_M2 3.4): the rejected output and the fixed error lines. */
export interface RepairPart {
  previousOutput: string;
  /** formatBlockError lines only (fixed templates). */
  errors: readonly string[];
}

/** Fixed instruction of a repair request (app text, inside <task>). */
export const REPAIR_INSTRUCTIONS = '<previous_output>는 이 작업에 대한 너의 이전 출력이고 형식 검사를 통과하지 못했다. <validation_errors>의 문제를 모두 고쳐 같은 작업의 출력 전체를 처음부터 다시 쓴다. 출력 형식과 태그 규칙은 위 지시 그대로다.';

const jsonOf = <T>(raw: string | undefined, f: (v: unknown) => T): T | undefined => {
  if (raw === undefined) return undefined;
  return f(JSON.parse(raw) as unknown);
};
const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw new Error(`invalid ${what}`);
  return v;
};

/** Serialises the task text block. Unknown input keys are a programming error (throw). */
export function serializeTask(task: TaskId, inputs: Record<string, string | undefined>, template: string = taskTemplate(task), repair?: RepairPart): string {
  for (const k of Object.keys(inputs)) if (!(INPUT_KEYS as readonly string[]).includes(k)) throw new Error(`unknown task input ${k}`);
  const v = (k: InputKey) => {
    const x = inputs[k];
    return x === undefined || x.trim() === '' ? undefined : x;
  };
  const parts: string[] = [`<task name="${task}" v="1">`, `<instructions trust="app">\n${template}\n</instructions>`];

  const history = fitHistory(parseHistory(v('history')));
  if (history.length) {
    parts.push('<history>');
    for (const t of history) parts.push(`<turn role="${t.role}" trust="${t.role === 'user' ? 'user' : 'model'}">${escapeText(t.text)}</turn>`);
    parts.push('</history>');
  }
  const selection = v('selection');
  if (selection !== undefined) {
    const page = v('page');
    parts.push(block('selection', 'paper', clean(selection, FIELD_LIMITS.selection), { page: page && /^\d{1,8}$/.test(page) ? page : undefined, section: v('section') && clean(v('section')!, FIELD_LIMITS.section) }));
  }
  const before = v('context_before');
  if (before !== undefined) parts.push(block('context_before', 'paper', clean(before, FIELD_LIMITS.context, 'tail')));
  const after = v('context_after');
  if (after !== undefined) parts.push(block('context_after', 'paper', clean(after, FIELD_LIMITS.context)));
  const pb = v('paragraph_before');
  if (pb !== undefined) parts.push(block('paragraph_before', 'paper', clean(pb, FIELD_LIMITS.paragraph, 'tail')));
  const pa = v('paragraph_after');
  if (pa !== undefined) parts.push(block('paragraph_after', 'paper', clean(pa, FIELD_LIMITS.paragraph)));
  const known = jsonOf(v('glossary_known'), (x) => {
    if (!Array.isArray(x)) throw new Error('invalid glossary_known');
    return x.map((t) => ({ term: str((t as { term?: unknown }).term, 'glossary term'), definition: (t as { definition?: unknown }).definition === undefined || (t as { definition?: unknown }).definition === null ? '' : str((t as { definition?: unknown }).definition, 'glossary definition') }));
  });
  if (known && known.length) {
    const lines: string[] = [];
    let used = 0;
    for (const t of known.slice(0, FIELD_LIMITS.glossaryTerms)) {
      const definition = t.definition ? clean(stripControl(t.definition).replace(/\s+/g, ' ').trim(), FIELD_LIMITS.glossaryDefinition) : '';
      const line = `${clean(t.term, FIELD_LIMITS.term).replace(/\n/g, ' ')}${definition ? `: ${definition}` : ''}`;
      // a line that does not fit is skipped, not the end of the list (review B-R1-08)
      if (used + line.length > FIELD_LIMITS.glossaryChars) continue;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length) parts.push(block('glossary_known', 'user', lines.join('\n')));
  }
  const areaPage = v('area_page');
  if (areaPage !== undefined) {
    if (!/^\d{1,8}$/.test(areaPage)) throw new Error('invalid area_page');
    parts.push(`<area trust="user" page="${areaPage}"/>`);
  }
  const captions = jsonOf(v('nearby_captions'), (x) => {
    if (!Array.isArray(x)) throw new Error('invalid nearby_captions');
    return x.map((c) => str(c, 'caption'));
  });
  if (captions && captions.length) parts.push(block('nearby_captions', 'paper', captions.slice(0, FIELD_LIMITS.captions).map((c) => `- ${clean(c, FIELD_LIMITS.captionChars).replace(/\n/g, ' ')}`).join('\n')));
  const equation = jsonOf(v('equation'), (x) => {
    const e = x as { n?: unknown; htmlId?: unknown; latex?: unknown };
    return { n: str(e.n, 'equation number'), htmlId: e.htmlId === null || e.htmlId === undefined ? undefined : str(e.htmlId, 'equation html id'), latex: str(e.latex, 'equation latex') };
  });
  if (equation) parts.push(block('equation', 'paper', clean(equation.latex, FIELD_LIMITS.latex), { n: clean(equation.n, FIELD_LIMITS.equationNumber), html_id: equation.htmlId && clean(equation.htmlId, FIELD_LIMITS.htmlId) }));
  const neighbors = jsonOf(v('neighbors'), (x) => {
    const n = x as { before?: unknown; after?: unknown; prev?: unknown; next?: unknown };
    const opt = (y: unknown, w: string) => (y === null || y === undefined ? undefined : str(y, w));
    return { before: opt(n.before, 'neighbor'), after: opt(n.after, 'neighbor'), prev: opt(n.prev, 'neighbor number'), next: opt(n.next, 'neighbor number') };
  });
  if (neighbors && (neighbors.before || neighbors.after || neighbors.prev || neighbors.next)) {
    const text = [neighbors.before ? `before: ${clean(neighbors.before, FIELD_LIMITS.neighbor, 'tail')}` : '', neighbors.after ? `after: ${clean(neighbors.after, FIELD_LIMITS.neighbor)}` : ''].filter(Boolean).join('\n');
    parts.push(block('neighbors', 'paper', text, { prev: neighbors.prev && clean(neighbors.prev, FIELD_LIMITS.equationNumber), next: neighbors.next && clean(neighbors.next, FIELD_LIMITS.equationNumber) }));
  }
  const term = v('term');
  if (term !== undefined) parts.push(block('requested_term', 'user', clean(term, FIELD_LIMITS.term)));
  const question = v('question');
  if (question !== undefined) parts.push(block('question', 'user', clean(question, FIELD_LIMITS.question)));
  if (repair) {
    // Inside the original <task> (system.md reads trust="app" only there). The previous output is model text
    // (escaped, capped); the error lines are formatBlockError's fixed templates — never model text (D20).
    parts.push(block('previous_output', 'model', clean(repair.previousOutput, FIELD_LIMITS.previousOutput)));
    parts.push(block('validation_errors', 'app', repair.errors.slice(0, FIELD_LIMITS.repairErrors).map((e) => `- ${stripControl(e).replace(/\n/g, ' ')}`).join('\n')));
    parts.push(`<repair_instructions trust="app">\n${REPAIR_INSTRUCTIONS}\n</repair_instructions>`);
  }
  parts.push('</task>');
  return parts.join('\n');
}
