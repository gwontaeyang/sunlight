import type { z } from 'zod';
import { UsageQuery, type UsageRowDto } from '@study-paper/shared/contracts/api';
import { utcMonth, monthUsage } from '../byok/billing';
import { HttpError, routeJson, type RouteModule } from '../deps';
export const usageRoutes: RouteModule = (deps) => ({
  'usage.summary': (c) => {
    const query = UsageQuery.safeParse(c.req.query());
    if (!query.success) throw new HttpError(400, 'validation', 'invalid usage interval');
    const month = utcMonth();
    const start = Date.parse(month + '-01T00:00:00Z');
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    const subscription = deps.sqlite
      .prepare(
        `SELECT count(*) AS subscriptionCalls,
      coalesce(sum(coalesce(inputTokens,0)+coalesce(cacheReadTokens,0)+coalesce(cacheCreationTokens,0)+coalesce(outputTokens,0)),0) AS subscriptionTokens,
      coalesce(sum(cacheReadTokens),0) AS subscriptionCacheReadTokens, coalesce(sum(cacheCreationTokens),0) AS subscriptionCacheWriteTokens
      FROM llm_calls WHERE executionMode='cli' AND startedAt>=? AND startedAt<?`,
      )
      .get(start, end.getTime()) as {
      subscriptionCalls: number;
      subscriptionTokens: number;
      subscriptionCacheReadTokens: number;
      subscriptionCacheWriteTokens: number;
    };
    const rows = deps.sqlite
      .prepare(
        `SELECT date(acceptedAt/1000,'unixepoch') AS day,task,count(*) AS calls,sum(inputTokens) AS inputTokens,
      sum(cacheReadTokens) AS cacheReadTokens,sum(cacheCreationTokens) AS cacheCreationTokens,sum(outputTokens) AS outputTokens,
      sum(costUsdApiEquivEst) AS costUsdApiEquivEst,coalesce(sum(cacheMissUnexpected),0) AS cacheMissUnexpected
      FROM llm_calls WHERE acceptedAt>=? AND executionMode IN ('cli','api') GROUP BY day,task ORDER BY day,task`,
      )
      .all(Date.now() - query.data.days * 86_400_000) as z.infer<typeof UsageRowDto>[];
    return routeJson(c, 'usage.summary', {
      month,
      ...monthUsage(deps.sqlite, month),
      ...subscription,
      rows,
      sevenDayUtilization: null,
    });
  },
});
