import { accessSync, constants } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { TASK_SPECS, resolveModel, type ModelAlias, type TaskId } from '@study-paper/shared/contracts/tasks';
import type { Sqlite } from '../db/client';
import type { LlmAdapter } from '../llm/adapter';
import { ClaudeCliAdapter } from '../llm/claudeCli';
import { ApiProvider } from './provider';
import { API_MODELS, PRICE_VERSION } from './prices';
import { readSettings } from './settings';

export interface Selection {
  adapter: LlmAdapter;
  model: ModelAlias;
  rotation?: AbortSignal;
  columns: {
    backend: 'subscription' | 'api';
    executionMode: 'cli' | 'mock' | 'api';
    credentialGeneration: string | null;
    requestedModel: string;
    priceVersion: string | null;
  };
}
export class Backends {
  private rotation = new AbortController();
  constructor(
    readonly sqlite: Sqlite,
    readonly fallback: LlmAdapter,
    readonly provider: ApiProvider,
    readonly cliBin: string,
  ) {
    provider.credentials.onChange(() => {
      this.rotation.abort();
      this.rotation = new AbortController();
    });
  }
  mode(backend?: Selection['columns']['backend']) {
    if (this.fallback.mode === 'mock') return 'mock';
    return (backend ?? readSettings(this.sqlite)['llm.backend']) === 'api' ? 'api' : 'cli';
  }
  available() {
    if (this.mode() === 'mock') return true;
    if (this.mode() === 'api') return this.provider.credentials.status().keyConfigured;
    const paths = this.cliBin.includes('/')
      ? [this.cliBin]
      : (process.env.PATH ?? '').split(delimiter).map((d) => resolve(d, this.cliBin));
    return paths.some((p) => {
      try {
        accessSync(p, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  }
  select(task: TaskId): Selection {
    const settings = readSettings(this.sqlite);
    const backend = settings['llm.backend'];
    const role = TASK_SPECS[task].model;
    const model = task !== 'study_path' && settings['llm.economy'] && (role === 'deepModel' || role === 'paperModel') ? 'sonnet' : resolveModel(task);
    const executionMode = this.mode(backend);
    if (executionMode !== 'api') {
      const adapter: LlmAdapter =
        this.fallback instanceof ClaudeCliAdapter && !this.available()
          ? {
              mode: 'cli',
              health: () => this.fallback.health(),
              async *run() {
                yield { type: 'error', code: 'cli_missing', message: 'Configure AI in Settings', retryable: false, partialText: '' };
              },
            }
          : this.fallback;
      return {
        adapter,
        model,
        columns: { backend, executionMode, requestedModel: model, credentialGeneration: null, priceVersion: null },
      };
    }
    const generation = this.provider.credentials.status().generation;
    const id = model === 'fable' ? null : API_MODELS[model];
    return {
      adapter: this.provider.adapter(generation, id),
      model,
      rotation: this.rotation.signal,
      columns: { backend, executionMode, credentialGeneration: generation, requestedModel: id ?? model, priceVersion: PRICE_VERSION },
    };
  }
}
