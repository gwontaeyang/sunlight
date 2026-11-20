import { parse } from '../../apps/server/src/ingest/latexml';
import { prepareStoredEquations } from '../../apps/server/src/ingest/katexCheck';

/** Structure inputs consumed by the offline gold evaluator. */
export async function structureOf(html: string) {
  const parsed = parse(html);
  const { latex, budgetExceeded } = await prepareStoredEquations(parsed.equations);
  return { parsed, latex, katexBudgetExceeded: budgetExceeded };
}
