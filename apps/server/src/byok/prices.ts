// Anthropic List Prices, 2026-10-22, Global Standard, Messages API. Rates in milli-microUSD per token.
// https://assets.claude.com/5633dc848caa431115468f31c7085d695bbfb9cc.pdf
export const PRICE_VERSION = 'anthropic-global-standard-2026-10-22';
export const API_MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' } as const;
export type ApiModel = (typeof API_MODELS)[keyof typeof API_MODELS];
export const MAX_OUTPUT = 4096;
// 1 Mi tokens envelopes the model's 1M context, including the PDF and provider-side formatting.
const INPUT_BOUND = 1_048_576;
export type Counts = { input: number; read: number; write5: number; write60: number; output: number };
export const zeroCounts = (): Counts => ({ input: 0, read: 0, write5: 0, write60: 0, output: 0 });
function rates(model: string, context: number): Counts {
  switch (model) {
    case API_MODELS.haiku:
      return context <= 100_000
        ? { input: 100, read: 10, write5: 125, write60: 200, output: 500 }
        : { input: 500, read: 50, write5: 625, write60: 1000, output: 2500 };
    case API_MODELS.sonnet:
      return { input: 2000, read: 100, write5: 2500, write60: 4000, output: 10000 };
    case API_MODELS.opus:
      return { input: 4000, read: 200, write5: 5000, write60: 8000, output: 20000 };
    default:
      throw new Error('unpriced model');
  }
}
export function charge(model: string, counts: Counts) {
  const keys = Object.keys(counts) as (keyof Counts)[];
  if (keys.some((k) => !Number.isSafeInteger(counts[k]) || counts[k] < 0)) throw new Error('invalid usage');
  const context = counts.input + counts.read + counts.write5 + counts.write60;
  if (context > INPUT_BOUND || counts.output > MAX_OUTPUT) throw new Error('usage exceeds the request bounds');
  const rate = rates(model, context);
  return Math.ceil(keys.reduce((sum, k) => sum + counts[k] * rate[k], 0) / 1000);
}
export function worstCharge(model: string) {
  return charge(model, { ...zeroCounts(), write60: INPUT_BOUND, output: MAX_OUTPUT });
}
