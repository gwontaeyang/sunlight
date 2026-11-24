import { useState } from 'react';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { StudyPathDto } from '@study-paper/shared/contracts/api';
import { StudyRunProvider, useStudyProgress } from '../../src/study/StudyRunProvider';
import { StudyPathView } from '../../src/viewer/StudyPathView';
import { PAPER, renderWithApi } from '../panel/panelHarness';
import { ev } from '../panel/sseFake';
import { LINKS_PAPER, structureFixture } from '../panel/structureFixture';

afterEach(cleanup);

const runId = 'run-a';
const path = (paperId: string) => `/api/papers/${paperId}/study-path`;
const empty = (): StudyPathDto => ({ result: null, pending: null });
const savedText = ['## 1', '배경', '## 2', '한계', '## 3', '기여', '## 4', '기호', '## 5', '구현', '## 6', '질문', '- [ ] 검사', '## 7', '참고'].join('\n');

function Routes() {
  const [id, show] = useState<string | null>(PAPER);
  const progress = useStudyProgress();
  return <>
    <button onClick={() => show(PAPER)}>첫 논문</button>
    <button onClick={() => show(LINKS_PAPER)}>둘째 논문</button>
    <button onClick={() => show(null)}>서재</button>
    {progress && <output data-testid="active-paper">{progress.paperId}</output>}
    {id && <StudyPathView key={id} paper={{ id, title: id, codeUrl: null }}
      open canGenerate unavailable="" onClose={() => show(null)} />}
  </>;
}

function setup(first = empty()) {
  const { server, qc } = renderWithApi(<StudyRunProvider><Routes /></StudyRunProvider>, ({ method, url }) => {
    if (url.endsWith('/structure')) return { status: 200, json: structureFixture() };
    if (method === 'GET' && url === path(PAPER)) return { status: 200, json: first };
    if (method === 'GET' && url === path(LINKS_PAPER)) return { status: 200, json: empty() };
  });
  const requests = () => server.calls.filter(c => c.url.endsWith('/study-path/generate'));
  return { server, first, requests, qc };
}

const visit = (label: string) => fireEvent.click(screen.getByRole('button', { name: label }));

it('reopening a locally interrupted regeneration attaches to the same request once, including its original regenerate flag', async () => {
  const { server, first, requests } = setup({
    result: { runId: 'previous', codeLanguage: 'cpp17', checked: [false], text: savedText, citations: [] }, pending: null,
  });
  fireEvent.click(await screen.findByTestId('rd-study-path-regenerate'));
  await waitFor(() => expect(server.streamCount()).toBe(1));
  const req = requests()[0]!;
  const clientRequestId = String(req.body?.clientRequestId);
  expect(req.body).toMatchObject({ regenerate: true, clientRequestId: expect.stringMatching(/^[\da-f-]{36}$/i) });
  first.pending = { runId, clientRequestId, regenerate: true, codeLanguage: 'cpp17' };
  await act(async () => server.push(ev.acceptedRun({ task: 'study_path', runId }), ev.started(), ev.delta('## 1\n본문')));
  visit('서재');
  await act(async () => server.fail());
  visit('첫 논문');
  await waitFor(() => expect(server.streamCount()).toBe(2));
  expect(requests()[1]).toEqual(req);
  await act(async () => server.push(ev.acceptedRun({ task: 'study_path', runId }), ev.started(), ev.delta('## 1\n다시 받은 본문')));
  expect((await screen.findByTestId('rd-study-stage-1')).textContent).toContain('다시 받은 본문');
  expect(screen.queryByText('본문', { exact: true })).toBeNull();

  first.pending = null;
  first.result = { runId, codeLanguage: 'cpp17', text: savedText, citations: [], checked: [true] };
  await act(async () => { server.push(ev.done(savedText)); server.end(); });
  await screen.findByTestId('rd-study-saved');
  await waitFor(() => expect((screen.getByTestId('rd-study-check-0') as HTMLInputElement).checked).toBe(true));
  expect(screen.queryByTestId('active-paper')).toBeNull();
  expect(requests()).toHaveLength(2);
});

it('keeps the background lane with its paper until cancellation is acknowledged', async () => {
  const { server, requests } = setup();
  fireEvent.click(await screen.findByTestId('rd-study-path-generate'));
  await waitFor(() => expect(server.streamCount()).toBe(1));
  await act(async () => server.push(ev.acceptedRun({ task: 'study_path', runId }), ev.queued(1)));
  visit('둘째 논문');
  const otherStart = await screen.findByTestId('rd-study-path-generate');
  expect((otherStart as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: '중단' })).toBeNull();
  fireEvent.click(otherStart);
  expect(requests()).toHaveLength(1);
  expect(screen.getByTestId('active-paper').textContent).toBe(PAPER);

  visit('첫 논문');
  fireEvent.click(await screen.findByRole('button', { name: '중단' }));
  await waitFor(() => expect(server.calls.filter(c => c.url.endsWith('/cancel'))).toEqual([
    { method: 'POST', url: `/api/llm/runs/${runId}/cancel`, body: undefined },
  ]));
  expect(screen.getByTestId('active-paper').textContent).toBe(PAPER);
  // A terminal event settles the run even if the original SSE response has not reached EOF.
  await act(async () => server.push(ev.error('cancelled')));
  expect((await screen.findByRole('alert')).textContent).toContain('취소했습니다');
  expect(screen.queryByTestId('active-paper')).toBeNull();
  visit('둘째 논문');
  expect(screen.queryByRole('alert')).toBeNull();
  const next = await screen.findByTestId('rd-study-path-generate');
  await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(next);
  await waitFor(() => expect(server.streamCount()).toBe(2));
  expect(requests()[1]!.url).toBe(path(LINKS_PAPER) + '/generate');
  expect(requests()[1]!.body?.clientRequestId).not.toBe(requests()[0]!.body?.clientRequestId);
});

it('invalidates the originating paper after a terminal error while away, and clears its progress without leaking its error', async () => {
  const { server, qc, requests } = setup();
  fireEvent.click(await screen.findByTestId('rd-study-path-generate'));
  await waitFor(() => expect(server.streamCount()).toBe(1));
  await act(async () => server.push(ev.acceptedRun({ task: 'study_path', runId }), ev.started(), ev.delta('## 1\n읽은 부분')));
  visit('둘째 논문');
  await screen.findByTestId('rd-study-path-generate');
  expect(qc.getQueryState(['study-path', PAPER])?.isInvalidated).toBe(false);
  await act(async () => { server.push(ev.error('cli_error')); server.end(); });
  await waitFor(() => expect(qc.getQueryState(['study-path', PAPER])?.isInvalidated).toBe(true));
  expect(qc.getQueryState(['study-path', LINKS_PAPER])?.isInvalidated).toBe(false);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByTestId('active-paper')).toBeNull();
  visit('첫 논문');
  expect((await screen.findByRole('alert')).textContent).toContain('Claude CLI');
  expect(requests()).toHaveLength(1);
});

it('opens the saved result without issuing another generation if the server finished after the stream was lost', async () => {
  const { server, first, requests } = setup();
  fireEvent.click(await screen.findByTestId('rd-study-path-generate'));
  await waitFor(() => expect(server.streamCount()).toBe(1));
  await act(async () => server.push(ev.acceptedRun({ task: 'study_path', runId }), ev.started()));
  visit('서재');
  await act(async () => server.fail());
  first.result = { runId, text: savedText, citations: [], checked: [true], codeLanguage: 'cpp17' };
  visit('첫 논문');
  expect((await screen.findByTestId('rd-study-check-0') as HTMLInputElement).checked).toBe(true);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', { name: '진행 중인 요청 다시 연결' })).toBeNull();
  expect(screen.queryByTestId('active-paper')).toBeNull();
  expect(requests()).toHaveLength(1);
});
