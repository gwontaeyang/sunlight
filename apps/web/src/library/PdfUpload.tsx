import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LIMITS } from '@study-paper/shared/contracts/api';
import { ApiError, api } from '../api/client';
import { qk } from '../api/queryKeys';

const maxMiB = LIMITS.uploadBytes / (1024 * 1024);

function uploadError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 413) return `이 파일은 PDF 처리 한도를 넘었습니다. 최대 ${maxMiB} MiB, ${LIMITS.maxPdfPages}쪽까지 올릴 수 있습니다.`;
    if (error.status === 400 || error.status === 415) return '이 PDF를 열 수 없습니다. 파일 형식과 암호 설정을 확인하세요.';
    if (error.status === 409) return '지금은 이 PDF를 처리할 수 없습니다. 잠시 뒤 다시 올려 주세요.';
    if (error.status === 401) return '페이지를 새로고침한 뒤 파일을 다시 선택하세요.';
  }
  return 'PDF를 저장하지 못했습니다. 연결을 확인한 뒤 다시 시도하세요.';
}

export function PdfUpload() {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const [dragOver, setDragOver] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const upload = useMutation({
    mutationFn: (file: File) => api.call('papers.upload', { rawBody: file, filename: file.name }),
    onSuccess: (r) => {
      setMessage({ text: r.existing ? '이미 Library에 있는 PDF입니다.' : 'PDF를 저장했습니다. 아래 목록에서 제목을 눌러 열어 보세요.' });
      void qc.invalidateQueries({ queryKey: qk.papers });
    },
    onError: (e) => setMessage({ text: uploadError(e), error: true }),
    onSettled: () => { busy.current = false; },
  });

  function select(files: FileList | null) {
    if (busy.current || !files?.length) return;
    const file = files[0]!;
    if (files.length !== 1 || !/\.pdf$/i.test(file.name)) {
      setMessage({ text: '확장자가 .pdf인 파일을 한 번에 하나씩 선택하세요.', error: true });
    } else if (file.size === 0) {
      setMessage({ text: '파일이 비어 있습니다. 다른 PDF를 선택하세요.', error: true });
    } else if (file.size > LIMITS.uploadBytes) {
      setMessage({ text: `${maxMiB} MiB 이하의 PDF를 선택하세요.`, error: true });
    } else {
      busy.current = true;
      setMessage(null);
      upload.mutate(file);
    }
  }

  return (
    <div>
      <input ref={input} type="file" accept=".pdf,application/pdf" hidden data-testid="rd-upload-file"
        onChange={(e) => { select(e.currentTarget.files); e.currentTarget.value = ''; }} />
      <div data-testid="rd-upload-drop" aria-busy={upload.isPending}
        className={`flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 rounded-sl-control border border-dashed px-2.5 py-1 ${dragOver ? 'border-sl-accent bg-sl-accent-soft' : 'border-sl-edge bg-sl-surface'}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = busy.current ? 'none' : 'copy';
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setDragOver(false);
        }}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); select(e.dataTransfer.files); }}>
        <button type="button" data-testid="rd-upload-button" className="rounded-sl-chip px-1 py-1 text-sl-ui font-semibold text-sl-accent hover:bg-sl-accent-soft disabled:text-sl-meta"
          disabled={upload.isPending} onClick={() => input.current?.click()}>PDF 올리기</button>
        <span className="text-sl-label text-sl-muted">또는 여기에 놓기 · {maxMiB} MiB 이하</span>
      </div>
      {(upload.isPending || message) && <p data-testid="rd-upload-status" role={message?.error ? 'alert' : 'status'}
        className="mt-1.5 text-sl-label text-sl-body">
        {upload.isPending ? 'PDF를 읽고 목차를 확인하고 있습니다…' : message?.text}
      </p>}
    </div>
  );
}
