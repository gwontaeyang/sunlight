import { useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { api } from '../api/client';
import type { UserSettings } from '@study-paper/shared/contracts/api';
import { ThemeSwitch } from '../ui/theme';

const button = 'rounded-sl-control border border-sl-edge px-3 py-1.5 font-semibold hover:bg-sl-subtle disabled:opacity-60';
const input = 'min-w-0 rounded-sl-control border border-sl-edge bg-sl-surface px-3 py-2 text-sl-ink';
export function SettingsLink() {
  return (
    <Link
      href="/settings"
      className="shrink-0 rounded-sl-control px-2 py-1.5 text-sl-ui font-semibold text-sl-accent hover:bg-sl-subtle"
    >
      설정
    </Link>
  );
}
export function useAiSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => api.call('settings.get'), retry: false });
}
export function AiSetupHint() {
  return useAiSettings().data?.aiAvailable === false ? (
    <Link href="/settings" className="rounded-sl-control border border-sl-edge px-2 text-sl-ui text-sl-accent">
      설정에서 API key 등록
    </Link>
  ) : null;
}
export function SettingsPage() {
  const query = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.call('settings.get') });
  const usage = useQuery({ queryKey: ['usage'], queryFn: () => api.call('usage.summary') });
  const keyInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Partial<UserSettings>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [limit, setLimit] = useState<string | null>(null);
  const data = settings.data;
  const selected = { ...data?.settings, ...pending };
  async function act(fn: () => Promise<string>) {
    if (busy) return;
    setBusy(true);
    setStatus('');
    try {
      setStatus(await fn());
      await Promise.all([query.invalidateQueries({ queryKey: ['settings'] }), query.invalidateQueries({ queryKey: ['usage'] })]);
    } catch {
      setStatus('저장하거나 확인하지 못했습니다. 설정과 서버 연결을 확인하세요.');
    } finally {
      setPending({});
      setBusy(false);
    }
  }
  const patch = (values: Partial<UserSettings>) => {
    if (busy) return;
    setPending(values);
    return act(async () => {
      await api.call('settings.put', { body: { settings: values } });
      return '설정을 저장했습니다.';
    });
  };
  const saveKey = (event: FormEvent) => {
    event.preventDefault();
    const field = keyInput.current;
    if (!field || !field.value || busy) return;
    const key = field.value;
    field.value = '';
    void act(async () => {
      await api.call('settings.secret.put', { body: { key } });
      return '이 기기에 키를 저장했습니다.';
    });
  };
  const check = () =>
    act(async () => {
      const r = await api.call('settings.secret.check', { body: {} });
      return {
        verified: '등록한 키로 모델 정보를 확인했습니다.',
        unavailable: '공급자에 연결할 수 없습니다.',
        rejected: '공급자가 키를 거부했습니다.',
        missing: '먼저 키를 등록하세요.',
      }[r.status];
    });
  const usd = (v: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 }).format(v / 1e6);
  const cap = data?.settings['llm.monthlyLimitMicroUsd'];
  return (
    <div className="min-h-full bg-sl-surface text-sl-ink">
      <header className="flex min-h-14 items-center justify-between border-b border-sl-line px-6">
        <Link href="/" className="text-sl-accent">
          ← 서재
        </Link>
        <ThemeSwitch />
      </header>
      <main className="mx-auto max-w-2xl space-y-7 px-6 py-10 text-sl-reading">
        <h1 className="text-3xl font-semibold">AI 설정</h1>
        {settings.isError && <p role="alert">설정을 불러오지 못했습니다.</p>}
        {data && (
          <fieldset disabled={busy} className="space-y-5">
            <legend className="mb-3 font-semibold">AI 사용 방식</legend>
            <div className="flex flex-col gap-2">
              {(
                [
                  ['subscription', 'Claude Code 구독 (이 PC의 claude -p)'],
                  ['api', '내 Anthropic API key'],
                ] as const
              ).map(([v, label]) => (
                <label key={v}>
                  <input
                    type="radio"
                    name="backend"
                    checked={selected['llm.backend'] === v}
                    onChange={() => void patch({ 'llm.backend': v })}
                  />{' '}
                  {label}
                </label>
              ))}
            </div>
            <label className="block">
              <input
                type="checkbox"
                checked={selected['llm.economy']}
                onChange={(e) => void patch({ 'llm.economy': e.target.checked })}
              />{' '}
              절약 모드 · 논문 설명과 깊이 읽기에 Sonnet 사용
            </label>
            <p className="text-sl-ui text-sl-muted">
              논문 설명·깊이 읽기 {selected['llm.economy'] ? 'Sonnet' : 'Opus'} · 선택 번역 Sonnet
            </p>
            <div className="space-y-3 border-t border-sl-line pt-5">
              <label className="flex flex-wrap items-center justify-between gap-2">
                <span>AI 답변 언어</span>
                <select data-testid="rd-answer-language" className={input}
                  value={selected['llm.answerLanguage'] ?? 'ko'}
                  onChange={(e) => void patch({ 'llm.answerLanguage': e.target.value === 'en' ? 'en' : 'ko' })}>
                  <option value="ko">한국어</option>
                  <option value="en">English</option>
                </select>
              </label>
              <label className="flex flex-wrap items-center justify-between gap-2">
                <span>단계별 공부의 예시 코드 언어</span>
                <select data-testid="rd-study-code-language" className={input}
                  value={selected['study.codeLanguage'] ?? 'cpp17'}
                  onChange={(e) => void patch({ 'study.codeLanguage': e.target.value === 'python' ? 'python' : 'cpp17' })}>
                  <option value="cpp17">C++17 · Eigen</option>
                  <option value="python">Python</option>
                </select>
              </label>
              <p className="text-sl-ui text-sl-muted">다음에 생성하는 글부터 적용됩니다.</p>
            </div>
            <form onSubmit={saveKey} className="space-y-2 border-t border-sl-line pt-5">
              <label htmlFor="anthropic-key" className="block font-semibold">
                Anthropic API key
              </label>
              <p className="text-sl-ui text-sl-muted">
                {data.credential.keyConfigured ? '등록됨 · ••••••••' : '이 기기에 등록된 키가 없습니다.'}
              </p>
              <div className="flex flex-wrap gap-2">
                <input
                  id="anthropic-key"
                  ref={keyInput}
                  className={input}
                  type="password"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={230}
                  placeholder="sk-ant-api03-…"
                  required
                />
                <button type="submit" className={button}>
                  키 저장
                </button>
              </div>
              <div className="flex gap-2">
                <button type="button" disabled={!data.credential.keyConfigured} className={button} onClick={() => void check()}>
                  키 확인
                </button>
                <button
                  type="button"
                  disabled={!data.credential.keyConfigured}
                  className={button}
                  onClick={() =>
                    void act(async () => {
                      await api.call('settings.secret.delete');
                      return '저장한 키를 삭제했습니다.';
                    })
                  }
                >
                  키 삭제
                </button>
              </div>
            </form>
            <form
              className="space-y-2 border-t border-sl-line pt-5"
              onSubmit={(e) => {
                e.preventDefault();
                const value = Number(limit ?? (cap == null ? 20 : cap / 1e6));
                void patch({ 'llm.monthlyLimitMicroUsd': Math.round(value * 1e6) });
              }}
            >
              <label htmlFor="monthly-limit" className="block font-semibold">
                API 월 상한 (USD)
              </label>
              <p className="text-sl-ui text-sl-muted">
                {cap == null ? '상한을 저장하면 API 호출을 시작할 수 있습니다.' : '현재 상한 ' + usd(cap)}
              </p>
              <input
                id="monthly-limit"
                type="number"
                min="0"
                max="1000"
                step="0.01"
                required
                className={input}
                value={limit ?? (cap == null ? '20' : String(cap / 1e6))}
                onChange={(e) => setLimit(e.target.value)}
              />{' '}
              <button className={button}>상한 저장</button>
            </form>
          </fieldset>
        )}
        <section className="border-t border-sl-line pt-5">
          <h2 className="font-semibold">이번 달 사용량 (UTC)</h2>
          {usage.data && (
            <p className="mt-2 text-sl-body">
              API {usage.data.apiCalls}회 · 정산 {usd(usage.data.spentMicroUsd)} · 예약 {usd(usage.data.heldMicroUsd)}
              <br />
              구독 {usage.data.subscriptionCalls}회 · {usage.data.subscriptionTokens.toLocaleString()} tokens (캐시 읽기{' '}
              {usage.data.subscriptionCacheReadTokens.toLocaleString()} · 쓰기{' '}
              {usage.data.subscriptionCacheWriteTokens.toLocaleString()})
            </p>
          )}
          <p className="text-sl-ui text-sl-muted">앱이 추정한 API 비용입니다. 공급자의 청구 내역에서 실제 금액을 확인하세요.</p>
        </section>
        <p role="status" aria-live="polite" className="text-sl-ui text-sl-muted">
          {status}
        </p>
      </main>
    </div>
  );
}
