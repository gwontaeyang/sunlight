// TanStack Query keys shared by the viewer (C) and the panels (D). Owner: supervisor.
// Both sides read and invalidate the same data (e.g. C creates a highlight, D lists it), so keys live here.
export const qk = {
  reviewQueue: ['reviewQueue'] as const,
  papers: ['papers'] as const,
  paper: (paperId: string) => ['paper', paperId] as const,
  highlights: (paperId: string) => ['highlights', paperId] as const,
  threads: (paperId: string) => ['threads', paperId] as const,
  thread: (threadId: string) => ['thread', threadId] as const,
  run: (runId: string) => ['run', runId] as const,
  llmHealth: ['llm', 'health'] as const,
  // M2
  structure: (paperId: string) => ['structure', paperId] as const,
  notes: (paperId: string) => ['notes', paperId] as const,
  progress: (paperId: string) => ['progress', paperId] as const,
  cards: (paperId: string) => ['cards', paperId] as const,
  glossary: (paperId: string) => ['glossary', paperId] as const,
} as const;
