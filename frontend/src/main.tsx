import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Sentry from '@sentry/react';
import App from './App';
import '@mysten/dapp-kit/dist/index.css';
import './index.css';

// The API warm-up ping lives in index.html, not here — see the comment there.
// A fetch in this module's body would be hoisted behind the entire eager import
// graph above (web3-vendor alone is ~2.5 MB), firing seconds after HTML parse.

// Error monitoring — no-op without VITE_SENTRY_DSN. Errors only: no replay, no
// tracing, no breadcrumbs (fetch/XHR/console crumbs would carry API URLs and
// logged payloads), and no request/user data on the event. Captures via the
// global error/unhandledrejection handlers only: render errors caught by the
// App.tsx ErrorBoundary are NOT reported (production React 18 just
// console.errors them) until that boundary calls Sentry.captureException.
const sentryDsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: (import.meta.env.VITE_NETWORK as string | undefined) || 'testnet',
    tracesSampleRate: 0,
    sendDefaultPii: false,
    maxBreadcrumbs: 0,
    beforeSend(event) {
      delete event.request;
      delete event.user;
      return event;
    },
  });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* Opt into React Router v7 behaviour now (silences its dev "Future
          Flag" warnings). Safe here: every Link/navigate target is absolute,
          so relative-splat resolution changes nothing. */}
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
