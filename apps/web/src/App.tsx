import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { createAppQueryClient } from './api/queryClient';
import { TOKEN_EXPIRED_EVENT } from './api/token';
import { AppRoutes } from './routes';
import { StudyRunProvider } from './study/StudyRunProvider';
import { useDocumentTheme } from './ui/theme';

const queryClient = createAppQueryClient();

export function App() {
  useDocumentTheme();
  const [tokenExpired, setTokenExpired] = useState(false);
  useEffect(() => {
    const on = () => setTokenExpired(true);
    window.addEventListener(TOKEN_EXPIRED_EVENT, on);
    return () => window.removeEventListener(TOKEN_EXPIRED_EVENT, on);
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      {tokenExpired && (
        <div role="alert" className="bg-amber-100 px-3 py-2 text-sm">
          서버가 다시 시작되었습니다. 페이지를 새로고침하세요.
        </div>
      )}
      <StudyRunProvider>
        <AppRoutes />
      </StudyRunProvider>
    </QueryClientProvider>
  );
}
