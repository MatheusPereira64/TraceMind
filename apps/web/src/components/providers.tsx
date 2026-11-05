'use client';

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from '@/lib/api-client';

function redirectToLoginOn401(error: unknown) {
  if (
    error instanceof ApiError &&
    error.status === 401 &&
    typeof window !== 'undefined' &&
    !['/login', '/register'].includes(window.location.pathname)
  ) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.assign(`/login?next=${next}`);
  }
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({ onError: redirectToLoginOn401 }),
        mutationCache: new MutationCache({ onError: redirectToLoginOn401 }),
        defaultOptions: {
          queries: { staleTime: 15_000, refetchOnWindowFocus: false },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
