import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { OverviewDto } from '@study-paper/shared/contracts/api';
import { OverviewPanel } from '../../src/panel/OverviewPanel';
import { PAPER, renderWithApi } from './panelHarness';

afterEach(cleanup);
const requestId = '7688eabc-d820-4033-9899-0e4b052a294c';
function show(dto: OverviewDto, uploaded = false) {
  return renderWithApi(<OverviewPanel paperId={PAPER} uploaded={uploaded} />, ({ method, url }) => {
    if (method === 'GET' && url.endsWith('/overview')) return { status: 200, json: dto };
  });
}

it('opening an empty overview only reads the paper; generation is an explicit request', async () => {
  const { server } = show({ result: null, pending: null }, true);
  const create = await screen.findByRole('button', { name: '요약 만들기' });
  expect(screen.getByTestId('pn-overview-upload').textContent).toContain('검증하지 않습니다');
  expect(server.calls.map(c => c.method)).toEqual(['GET']);
  fireEvent.click(create);
  await waitFor(() => expect(server.streamCount()).toBe(1));
  expect(server.calls.find(c => c.method === 'POST')?.body).toEqual({ regenerate: false, clientRequestId: expect.any(String) });
});

it('reopening a pending replacement attaches with the original identity exactly once', async () => {
  const { server } = show({ result: null, pending: { clientRequestId: requestId, runId: 'run2', regenerate: true } });
  await waitFor(() => expect(server.streamCount()).toBe(1));
  expect(server.calls.filter(c => c.method === 'POST').map(c => c.body)).toEqual([{ regenerate: true, clientRequestId: requestId }]);
  expect(screen.getByRole('status').textContent).toContain('요약');
});
