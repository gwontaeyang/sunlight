// One error line for a failed (re)load of a panel query, always with "다시 시도" (review D-I10-02). The caller keeps
// drawing what it already has (react-query keeps `data` when a refetch fails); this line only says the list could not be
// read again. Owner D.
export function LoadError({ testId, text, retrying, onRetry }: { testId: string; text: string; retrying: boolean; onRetry: () => void }) {
  return (
    <div data-testid={testId} className="flex flex-wrap items-center gap-1 text-xs text-red-700">
      {text}
      <button type="button" data-testid="pn-load-retry" className="rounded border border-gray-300 px-1.5 text-gray-700 hover:bg-gray-100 disabled:opacity-50" disabled={retrying} onClick={onRetry}>
        {retrying ? '다시 시도 중…' : '다시 시도'}
      </button>
    </div>
  );
}
