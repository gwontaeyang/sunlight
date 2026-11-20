import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudyPathDto } from '@study-paper/shared/contracts/api';
import { StudyPathView } from '../../src/viewer/StudyPathView';
import { PAPER, renderWithApi, resetReader } from '../panel/panelHarness';
import { ev } from '../panel/sseFake';
import { structureFixture } from '../panel/structureFixture';
import { useReaderStore } from '../../src/state/readerStore';

const paper = { id: PAPER, title: '두 점으로 해 보는 정합', codeUrl: 'https://example.org/paper-code' };
const requestId = 'c58f326a-9fa5-43dc-88b5-37d3d1381ab3';
const text = [
  '## 1', '이 문장을 살펴보세요. <q>Points move together.</q> [[P]]',
  '## 2', '[[G]] 점끼리 짝을 지어요.',
  '## 3', '[[G]] [모델이 붙인 링크](https://example.org/not-from-paper)',
  '## 4', '색인에서 <eq n="1"/>을 열어 보세요. [[P]]', '## 5', '[[G]] 예제를 직접 실행해 보세요.',
  '## 6', '[[G]] 어떤 점이 움직였나요?', '- [ ] 입력과 출력 비교',
  '## 7', '[[G]] 다음 문헌도 읽어 보세요.', '- [ref:99]',
].join('\n');

function renderView(dto: StudyPathDto) {
  return renderWithApi(
    <StudyPathView paper={paper} open onClose={vi.fn()} canGenerate unavailable="" />,
    ({ url, method }) => {
      if (url.endsWith('/structure')) return { status: 200, json: structureFixture() };
      if (url.endsWith('/study-path') && method === 'GET') return { status: 200, json: dto };
    },
  );
}

beforeEach(() => resetReader());
afterEach(cleanup);

describe('논문 학습 흐름', () => {
  it('보류된 생성 요청은 여는 것만으로 호출하지 않고 다시 연결할 때 저장된 요청 ID로만 보낸다', async () => {
    const { server } = renderView({ result: null, pending: { clientRequestId: requestId, runId: 'run1', regenerate: true, codeLanguage: 'python' } });
    const attach = await screen.findByRole('button', { name: '진행 중인 요청 다시 연결' });
    expect(server.calls.every((c) => c.method === 'GET')).toBe(true);
    fireEvent.click(attach);
    await waitFor(() => expect(server.streamCount()).toBe(1));
    expect(server.calls.find((c) => c.method === 'POST')?.body).toEqual({ regenerate: true, clientRequestId: requestId });
    await act(async () => { server.push(ev.acceptedRun({ task: 'study_path', runId: 'run1' }), ev.started(), ev.delta('## 1\n[[P]] <q>Points move together.</q>')); });
    expect(await screen.findByTestId('rd-study-stage-1')).toBeDefined();
    expect(screen.queryByTestId('rd-study-stage-2')).toBeNull();
    expect(screen.queryByText('논문 근거')).toBeNull();
  });

  it('확인된 식 번호 chip을 클릭하면 색인의 해당 수식에 패널 포커스를 요청한다', async () => {
    useReaderStore.getState().openPaper(PAPER, { readable: true, contextReady: true, structureReady: true });
    renderView({
      result: {
        runId: 'run1', text, codeLanguage: 'cpp17', checked: [false],
        citations: [
          { ordinal: 1, kind: 'quote', quote: 'Points move together.', status: 'verbatim', score: 1 },
          { ordinal: 2, kind: 'equation', eqNumber: '1', status: 'resolved', score: 1, equationId: 'E1' },
        ],
      },
      pending: null,
    });
    await screen.findByTestId('rd-study-equation-E1');
    const stage = screen.getByTestId('rd-study-stage-4');
    fireEvent.click(within(stage).getByTestId('sp-chip'));
    expect(useReaderStore.getState().panelFocus).toEqual({ tab: 'equations', equationId: 'E1' });
  });

  it('불일치한 인용으로 전체 단계의 배지를 검증할 수 없고 원문 메타데이터에서 온 외부 링크만 제공한다', async () => {
    const { server } = renderView({
      result: {
        runId: 'run1', text, codeLanguage: 'python', checked: [true],
        citations: [{ ordinal: 1, kind: 'quote', quote: 'Wrong quote.', status: 'verbatim', score: 1 }],
      },
      pending: null,
    });
    const first = await screen.findByTestId('rd-study-stage-1');
    expect(within(first).getByTestId('pn-unpaired-note')).toBeDefined();
    expect(within(first).queryByText('논문 근거')).toBeNull();
    expect(within(screen.getByTestId('rd-study-stage-3')).queryByTestId('sp-ext-open')).toBeNull();
    expect(within(screen.getByTestId('rd-study-stage-5')).getByTestId('sp-ext-link').textContent).toContain(paper.codeUrl);
    expect((screen.getByTestId('rd-study-check-0') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('[99] 참고문헌 색인에서 확인되지 않음')).toBeDefined();
    expect(server.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });
});
