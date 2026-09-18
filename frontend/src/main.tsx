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
// global error/unhandledrejection handlers, plus render errors, which the
// App.tsx ErrorBoundary reports itself (production React 18 would otherwise
// only console.error them).
//
// Privacy: an exception MESSAGE is free text — it can quote decrypted task
// content (JSON parse errors), an RPC URL with its API key, a bearer token, a
// key. The frontend cannot import backend code, so scrubText carries a copy of
// the body in backend/src/middleware/errorHandler.ts; the backend test
// errorHandler.sentry.test.ts fails when the two drift.
function scrubText(input: unknown): string {
  let s = typeof input === 'string' ? input : String(input ?? '');
  // >>> sentry-scrub shared body — byte-identical in backend/agents/worker.js and frontend/src/main.tsx
  // A JSON parse error quotes the text it choked on — a request body, an LLM
  // reply, a decrypted brief. Nothing in it is worth keeping.
  if (/is not valid JSON|in JSON at position|Unexpected end of JSON|after JSON|JSON\.parse|Unexpected token .* JSON/i.test(s)) {
    return '[json parse error — detail redacted]';
  }
  // ethers v6 appends `(request={…}, info={ requestUrl, responseBody, … },
  // transaction={…}, code=X, version=…)`: RPC URLs, provider response bodies
  // and calldata. Only the short message and the code are kept.
  s = s.replace(/ \((?:[A-Za-z]+=[\s\S]*)?code=([A-Z_]+), version=[^)]*\)\s*$/, ' (code=$1)');
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
  s = s.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[jwt]');
  s = s.replace(/\b(?:sk|pk|rk|gsk|xai)[-_][A-Za-z0-9_-]{16,}/gi, '[key]');
  // URL → origin + first path segment. Userinfo, query, fragment and deeper
  // path go; so does a first segment long enough to be a key (…quiknode.pro/<key>/).
  s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#"'<>]*@)?([^\s/?#"'<>]+)([^\s"'<>]*)/gi, (_m, scheme, _userinfo, host, rest) => {
    const first = (/^\/([^/?#]*)/.exec(rest) || [])[1] || '';
    const keep = first && first.length < 16 ? `/${first}` : '';
    return `${scheme}${host}${keep}${rest.length > keep.length ? '/[…]' : ''}`;
  });
  // 32+ hex: API keys (32), addresses (40), tx hashes and private keys (64),
  // public keys (130), wrapped keys. A tx hash and a private key are
  // indistinguishable, so all of it goes; the length says which it was.
  s = s.replace(/(?:0x)?[0-9a-fA-F]{32,}/g, (m) => `[hex:${m.replace(/^0x/i, '').length}]`);
  // Long base64/base64url runs: wrapped keys, ciphertext, opaque tokens.
  s = s.replace(/[A-Za-z0-9+/_-]{64,}={0,2}/g, '[blob]');
  // Shorter opaque tokens (provider/RPC API keys are typically 32 chars): a
  // 32+ run with 4+ digits among mixed-case letters is not a word or identifier.
  s = s.replace(/[A-Za-z0-9_-]{32,}/g, (m) =>
    ((m.match(/[0-9]/g) || []).length >= 4 && /[a-z]/.test(m) && /[A-Z]/.test(m) ? '[token]' : m));
  return s.length > 300 ? `${s.slice(0, 300)}…[truncated]` : s;
  // <<< sentry-scrub shared body
}

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
      delete event.extra;
      if (typeof event.message === 'string') event.message = scrubText(event.message);
      // linkedErrors appends every `cause` to this same list.
      for (const ex of event.exception?.values ?? []) {
        if (ex.value !== undefined) ex.value = scrubText(ex.value);
      }
      for (const crumb of event.breadcrumbs ?? []) {
        if (crumb.message !== undefined) crumb.message = scrubText(crumb.message);
        delete crumb.data;
      }
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
