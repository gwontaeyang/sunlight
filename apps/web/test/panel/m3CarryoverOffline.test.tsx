import { onlineManager } from '@tanstack/react-query';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { CardsTab } from '../../src/panel/CardsTab';
import { card } from './cardFixtures';
import { PAPER, renderWithApi, resetReader } from './panelHarness';

afterEach(() => { cleanup(); onlineManager.setOnline(true); });

it('retries the local card list while offline without issuing a generation request', async () => {
  resetReader();
  let reads = 0;
  const { server } = renderWithApi(<CardsTab paperId={PAPER} />, (c) => {
    if (c.method !== 'GET' || c.url !== `/api/papers/${PAPER}/cards`) return undefined;
    return ++reads === 1
      ? { status: 500, json: { error: { code: 'internal', message: 'fixture' } } }
      : { status: 200, json: { cards: [card('notation')] } };
  });
  const error = await screen.findByTestId('pn-cards-load-error');
  act(() => void window.dispatchEvent(new Event('offline')));
  expect(onlineManager.isOnline()).toBe(false);
  fireEvent.click(within(error).getByTestId('pn-load-retry'));
  await waitFor(() => expect(screen.getAllByTestId('pn-card-item')).toHaveLength(11));
  expect(reads).toBe(2);
  expect(server.calls.filter((call) => call.method !== 'GET')).toEqual([]);
});
