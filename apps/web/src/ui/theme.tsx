import { useLayoutEffect } from 'react';
import { create } from 'zustand';
import { Icon } from './icons';

type Theme = 'light' | 'dark';
type PaperTone = 'night' | 'original';

// Keep the reader's original keys so an existing preference survives the upgrade.
const THEME_KEY = 'sl.reader.theme';
const TONE_KEY = 'sl.reader.paperTone';
const systemScheme = typeof window === 'undefined' ? undefined : window.matchMedia?.('(prefers-color-scheme: dark)');

function stored(key: string) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function persist(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* Keep the choice in memory. */ }
}

function parseTheme(value: string | null): Theme | null {
  return value === 'dark' || value === 'light' ? value : null;
}

function effectiveTheme(choice: Theme | null): Theme {
  return choice ?? (systemScheme?.matches ? 'dark' : 'light');
}

interface ThemeState {
  choice: Theme | null;
  theme: Theme;
  tone: PaperTone;
  choose(theme: Theme): void;
  toggleTone(): void;
}

const initialChoice = parseTheme(stored(THEME_KEY));
export const useThemeStore = create<ThemeState>((set, get) => ({
  choice: initialChoice,
  theme: effectiveTheme(initialChoice),
  tone: stored(TONE_KEY) === 'original' ? 'original' : 'night',
  choose(theme) {
    persist(THEME_KEY, theme);
    if (theme === 'dark' && get().theme !== 'dark') {
      persist(TONE_KEY, 'night');
      set({ choice: theme, theme, tone: 'night' });
    } else {
      set({ choice: theme, theme });
    }
  },
  toggleTone() {
    const tone = get().tone === 'night' ? 'original' : 'night';
    persist(TONE_KEY, tone);
    set({ tone });
  },
}));

/** Keep the document (including portalled menus) and PDF controls on the same preference. */
export function useDocumentTheme() {
  const theme = useThemeStore((s) => s.theme);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useLayoutEffect(() => {
    const syncSystem = () => {
      const state = useThemeStore.getState();
      const next = effectiveTheme(state.choice);
      if (next === state.theme) return;
      if (next === 'dark') persist(TONE_KEY, 'night');
      useThemeStore.setState(next === 'dark' ? { theme: next, tone: 'night' } : { theme: next });
    };
    const syncStorage = (event: StorageEvent) => {
      try {
        if (event.storageArea !== window.localStorage) return;
      } catch {
        return; // Storage can become unavailable while a tab is open.
      }
      if (event.key === THEME_KEY || event.key === null) {
        const choice = parseTheme(stored(THEME_KEY));
        useThemeStore.setState({ choice, theme: effectiveTheme(choice) });
      }
      if (event.key === TONE_KEY || event.key === THEME_KEY || event.key === null) {
        useThemeStore.setState({ tone: stored(TONE_KEY) === 'original' ? 'original' : 'night' });
      }
    };
    syncSystem();
    systemScheme?.addEventListener('change', syncSystem);
    window.addEventListener('storage', syncStorage);
    return () => {
      systemScheme?.removeEventListener('change', syncSystem);
      window.removeEventListener('storage', syncStorage);
    };
  }, []);
}

export function ThemeSwitch({ rail = false }: { rail?: boolean }) {
  const theme = useThemeStore((s) => s.theme);
  const choose = useThemeStore((s) => s.choose);
  return (
    <div role="group" aria-label="화면 테마" className={`flex gap-[3px] rounded-full border border-sl-edge p-[3px] ${rail ? 'mt-auto mb-3 flex-col' : ''}`}>
      {(['light', 'dark'] as const).map((mode) => {
        const label = mode === 'light' ? '주간' : '야간';
        return (
          <button
            key={mode}
            type="button"
            data-testid={`rd-theme-${mode}`}
            aria-pressed={theme === mode}
            aria-label={`${label} 화면`}
            title={`${label} 화면`}
            className={`inline-flex h-[29px] items-center justify-center gap-1 rounded-full border text-sl-label ${rail ? 'w-[29px]' : 'px-2.5'} ${theme === mode ? 'border-sl-accent bg-sl-accent-soft font-semibold text-sl-accent' : 'border-transparent text-sl-muted hover:bg-sl-subtle'}`}
            onClick={() => choose(mode)}
          >
            <Icon name={mode === 'light' ? 'sun' : 'dusk'} size={16} />
            {!rail && label}
          </button>
        );
      })}
    </div>
  );
}
