import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { qk } from '../api/queryKeys';

export function UploadPaperTitle({ id, title }: { id: string; title: string }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const edit = useMutation({
    mutationFn: (value: string) => api.call('papers.patch', { params: { id }, body: { title: value } }),
    onSuccess: (paper) => {
      qc.setQueryData(qk.paper(id), paper);
      void qc.invalidateQueries({ queryKey: qk.papers });
      setDraft(null);
    },
  });
  function save(e: FormEvent) {
    e.preventDefault();
    if (draft?.trim() && !edit.isPending) edit.mutate(draft.trim());
  }
  if (draft === null) {
    return <button type="button" data-testid="rd-upload-title-edit" className="ml-2 rounded-sl-chip px-1.5 py-0.5 text-sl-label text-sl-muted hover:bg-sl-subtle"
      onClick={() => { edit.reset(); setDraft(title); }}>제목 수정</button>;
  }
  return <form onSubmit={save} className="mt-2 flex flex-wrap items-center gap-2" onKeyDown={(e) => {
    if (e.key === 'Escape' && !edit.isPending) setDraft(null);
  }}>
    <input aria-label="PDF 제목" data-testid="rd-upload-title-input" autoFocus maxLength={1000} disabled={edit.isPending}
      className="min-w-0 flex-1 rounded-sl-control border border-sl-edge bg-sl-surface px-2 py-1 text-sl-ui text-sl-ink"
      value={draft} onChange={(e) => setDraft(e.target.value)} />
    <button type="submit" data-testid="rd-upload-title-save" disabled={!draft.trim() || edit.isPending}
      className="rounded-sl-control bg-sl-accent px-2 py-1 text-sl-ui text-sl-on-accent disabled:bg-sl-subtle disabled:text-sl-meta">저장</button>
    <button type="button" disabled={edit.isPending} className="text-sl-ui text-sl-muted" onClick={() => setDraft(null)}>취소</button>
    {edit.isError && <p role="alert" className="w-full text-sl-label text-sl-body">제목을 저장하지 못했습니다. 다시 시도하세요.</p>}
  </form>;
}
