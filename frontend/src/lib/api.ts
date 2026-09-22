import { API_BASE_URL, getActiveChain } from '../config/constants';
import type { ApiResponse, ApiErrorResponse } from '../types/api';

class ApiError extends Error {
  /** The server's whole `error` object, for routes that attach more than
   *  code + message (e.g. /agents/:id/withdraw's `skipped` reasons). */
  constructor(public code: string, message: string, public status?: number, public payload?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * No request may hang forever.
 *
 * Every call here is awaited by a component that flips a `loading` flag in a
 * `finally`, so a promise that never settles leaves the UI stuck with no error
 * — the Settings "Create key" button sat on "CREATING…" indefinitely while the
 * backend blocked on a slow startup migration. A request that FAILS resets the
 * UI and shows the user something; one that never answers cannot.
 *
 * 120s, not lower: POST /api/v1/storage/upload legitimately runs 30–60s on
 * 0G testnet (the route sets its own 120s socket timeout for exactly that),
 * and /a2a/tasks/index polls for a receipt for ~35s before answering. A 30s
 * cap here would have cut both off mid-flight and broken task posting from
 * the web app. Long enough for the slowest real call; short enough that a
 * dead backend still surfaces as an error rather than a frozen button.
 */
const REQUEST_TIMEOUT_MS = 120_000;

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new ApiError('TIMEOUT', `The server did not respond within ${REQUEST_TIMEOUT_MS / 1000}s. It may be starting up — try again in a moment.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) {
    throw new ApiError('EMPTY_RESPONSE', `Server returned empty response (${res.status})`, res.status);
  }
  let body: ApiResponse<T> | ApiErrorResponse;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError('PARSE_ERROR', `Invalid JSON from server: ${text.slice(0, 200)}`, res.status);
  }

  if (!res.ok || !body.success) {
    const err = body as ApiErrorResponse;
    throw new ApiError(
      err.error?.code || 'UNKNOWN',
      err.error?.message || `HTTP ${res.status}`,
      res.status,
      err.error as Record<string, unknown> | undefined,
    );
  }

  return (body as ApiResponse<T>).data;
}

// Module-level token getter — set by AuthContext when Privy authenticates
let _getAccessToken: (() => Promise<string | null>) | null = null;

export function setAccessTokenGetter(getter: (() => Promise<string | null>) | null) {
  _getAccessToken = getter;
}

export async function getAuthHeaders(overrideToken?: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (overrideToken) {
    headers.Authorization = `Bearer ${overrideToken}`;
  } else if (_getAccessToken) {
    const token = await _getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  // Send active chain so backend picks the right address from multi-chain Privy JWTs
  headers['X-Active-Chain'] = getActiveChain();
  return headers;
}

export async function get<T>(path: string): Promise<T> {
  const res = await fetchWithTimeout(`${API_BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse<T>(res);
}

export async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetchWithTimeout(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return handleResponse<T>(res);
}

export async function authedGet<T>(path: string, overrideToken?: string): Promise<T> {
  const res = await fetchWithTimeout(`${API_BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(await getAuthHeaders(overrideToken)) },
  });
  return handleResponse<T>(res);
}

export async function authedPost<T>(path: string, body?: unknown, overrideToken?: string): Promise<T> {
  const res = await fetchWithTimeout(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await getAuthHeaders(overrideToken)) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return handleResponse<T>(res);
}

export async function authedPatch<T>(path: string, body?: unknown, overrideToken?: string): Promise<T> {
  const res = await fetchWithTimeout(`${API_BASE_URL}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(await getAuthHeaders(overrideToken)) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return handleResponse<T>(res);
}

export async function authedDelete<T = void>(path: string, overrideToken?: string): Promise<T> {
  const res = await fetchWithTimeout(`${API_BASE_URL}${path}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...(await getAuthHeaders(overrideToken)) },
  });
  return handleResponse<T>(res);
}

export { ApiError };
