// Route contract wrapper (app.ts withContract, review M8). Owner: supervisor.
import { Hono, type Handler } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { ROUTE_BY_ID, type RouteDef, type RouteId } from '@study-paper/shared/contracts/routes';
import { withContract } from '../../src/app';

function appFor(route: RouteId, handler: Handler): Hono {
  const def = ROUTE_BY_ID[route] as RouteDef & { id: RouteId };
  const app = new Hono();
  app.on(def.method, def.path, withContract(def, handler));
  return app;
}
const ID = '00000000-0000-4000-8000-000000000001';

describe('withContract', () => {
  it('rejects invalid params and bodies before the handler runs', async () => {
    const handler = vi.fn<Handler>((c) => c.json({}));
    const res = await appFor('papers.get', handler).request(`/papers/${'x'.repeat(65)}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'validation' } });
    const post = (body: string) => appFor('highlights.create', handler).request(`/papers/${ID}/highlights`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    expect((await post('not json')).status).toBe(400);
    expect((await post(JSON.stringify({ kind: 'text' }))).status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it('turns a response that breaks the contract into 500 internal', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const wrongDto = await appFor('papers.get', (c) => c.json({ id: ID, title: 'only two fields' })).request(`/papers/${ID}`);
      expect(wrongDto.status).toBe(500);
      expect(await wrongDto.json()).toEqual({ error: { code: 'internal', message: 'response of papers.get does not match the contract' } });
      expect((await appFor('papers.pdf', (c) => c.json({ not: 'a pdf' })).request(`/papers/${ID}/pdf`)).status).toBe(500); // wrong framing
      expect((await appFor('papers.delete', (c) => c.json({ ok: true })).request(`/papers/${ID}`, { method: 'DELETE' })).status).toBe(500); // must be 204
      expect((await appFor('papers.get', (c) => c.text('nope', 404)).request(`/papers/${ID}`)).status).toBe(500); // error without the DTO
    } finally {
      err.mockRestore();
    }
  });

  it('passes responses that match: error DTO, 204, SSE framing', async () => {
    const notFound = await appFor('papers.get', (c) => c.json({ error: { code: 'not_found', message: 'paper not found' } }, 404)).request(`/papers/${ID}`);
    expect(notFound.status).toBe(404);
    expect((await appFor('papers.delete', (c) => c.body(null, 204)).request(`/papers/${ID}`, { method: 'DELETE' })).status).toBe(204);
    const sse = await appFor('jobs.events', () => new Response('event: job.done\ndata: {"paperId":"p"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })).request(`/jobs/${ID}/events`);
    expect(sse.status).toBe(200);
  });
});
