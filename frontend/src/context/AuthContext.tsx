import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePrivy, getIdentityToken, getAccessToken } from '@privy-io/react-auth';
import { useAccount } from 'wagmi';
import { setAccessTokenGetter } from '../lib/api';
import { trackEvent } from '../hooks/useAnalytics';

interface AuthState {
  isAuthenticated: boolean;
  authenticating: boolean;
  login: () => void;
  logout: () => Promise<void> | void;
}

const AuthContext = createContext<AuthState | null>(null);

// Module-scope token cache. Privy's getIdentityToken() can trigger a
// /users/me roundtrip if it thinks the cached token is stale, and the SDK's
// internal dedup is unreliable in v3.23.1 — calling it on every backend
// request (api.ts:36 invokes _getAccessToken per authedGet/authedPost) had
// us hitting Privy's 429 in production. Caching the JWT until ~60s before
// its own `exp` claim collapses that to one Privy call per ~hour per user.
let cachedToken: string | null = null;
let cachedExp = 0;
// Promise-level dedup. Without this, dozens of authedGet/authedPost callers
// firing on page-mount each see cachedToken===null and each call Privy in
// parallel → burst → 429. With it, the first caller fetches and all
// concurrent callers await the same promise.
let inFlightTokenPromise: Promise<string | null> | null = null;
// Privy 429 backoff. Once rate-limited we have to stop calling — keeping
// the burst going just lengthens the cooldown. 30s is comfortably past
// Privy's typical retry-after window.
let backoffUntilMs = 0;
const PRIVY_BACKOFF_MS = 30_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const { ready, authenticated, login, logout } = usePrivy();
  const { address } = useAccount();
  const trackedRef = useRef(false);
  // Flips only AFTER the effect below has installed the token getter. A query
  // gated on Privy's raw `authenticated` fires in the same commit — child
  // effects run before this parent effect — so its first request went out
  // with no Authorization header and 401'd (verified with TanStack Query
  // 5.100.5 under StrictMode).
  const [tokenGetterReady, setTokenGetterReady] = useState(false);

  // Wire Privy's identity token into api.ts so authedGet/authedPost
  // automatically attach Authorization: Bearer <privy-id-token>.
  // Identity tokens contain the linked_accounts claim needed for backend wallet extraction.
  useEffect(() => {
    // Reset cache on every auth state flip — handles logout/login of a
    // different wallet without stale-token bleed.
    cachedToken = null;
    cachedExp = 0;
    inFlightTokenPromise = null;
    backoffUntilMs = 0;

    if (authenticated) {
      setAccessTokenGetter(async () => {
        const now = Math.floor(Date.now() / 1000);
        if (cachedToken && cachedExp - now > 60) {
          return cachedToken;
        }

        // In a 429 backoff window — don't call Privy. Return whatever
        // cached token we have (may be null, in which case the caller's
        // request goes out unauthed and may 401; better than extending
        // the rate-limit cooldown by piling on more 429s).
        if (Date.now() < backoffUntilMs) {
          return cachedToken;
        }

        // Dedup parallel callers — first one fetches, the rest await it.
        if (inFlightTokenPromise) {
          return inFlightTokenPromise;
        }

        inFlightTokenPromise = (async () => {
          try {
            const tok = (await getIdentityToken()) || (await getAccessToken());
            if (tok) {
              try {
                const claims = JSON.parse(atob(tok.split('.')[1]));
                cachedExp = typeof claims.exp === 'number' ? claims.exp : 0;
              } catch {
                cachedExp = 0;
              }
              cachedToken = tok;
            }
            return tok;
          } catch (err) {
            console.error('[Auth] Failed to get tokens:', err);
            // Detect Privy's 429 and enter backoff. Privy throws with the
            // string "Too many requests" in v3.x; also guard on a numeric
            // status if the SDK ever surfaces one.
            const msg = (err as Error)?.message ?? '';
            const status = (err as { status?: number })?.status;
            if (status === 429 || /too many requests/i.test(msg)) {
              backoffUntilMs = Date.now() + PRIVY_BACKOFF_MS;
              console.warn(`[Auth] Privy rate-limited — backing off for ${PRIVY_BACKOFF_MS / 1000}s`);
            }
            return null;
          } finally {
            inFlightTokenPromise = null;
          }
        })();

        return inFlightTokenPromise;
      });
    } else {
      setAccessTokenGetter(null);
      trackedRef.current = false;
    }
    setTokenGetterReady(authenticated);
  }, [authenticated]);

  // Fire analytics event the first time the user authenticates this session.
  useEffect(() => {
    if (authenticated && !trackedRef.current) {
      trackedRef.current = true;
      trackEvent('connect_wallet', address ? { address: address.toLowerCase() } : undefined);
    }
  }, [authenticated, address]);

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated: authenticated && tokenGetterReady,
        authenticating: !ready || (authenticated && !tokenGetterReady),
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
