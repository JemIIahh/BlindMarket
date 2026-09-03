import { API_BASE_URL, getActiveChain } from '../config/constants';
import type { ApiResponse, ApiErrorResponse } from '../types/api';

class ApiError extends Error {
  constructor(public code: string, message: string, public status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  const body = await res.json() as ApiResponse<T> | ApiErrorResponse;

  if (!res.ok || !body.success) {
    const err = body as ApiErrorResponse;
    throw new ApiError(
      err.error?.code || 'UNKNOWN',
      err.error?.message || `HTTP ${res.status}`,
      res.status,
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
  const res = await fetch(`${API_BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse<T>(res);
}

export async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return handleResponse<T>(res);
}

export async function authedGet<T>(path: string, overrideToken?: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(await getAuthHeaders(overrideToken)) },
  });
  return handleResponse<T>(res);
}

export async function authedPost<T>(path: string, body?: unknown, overrideToken?: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await getAuthHeaders(overrideToken)) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return handleResponse<T>(res);
}

export async function authedPatch<T>(path: string, body?: unknown, overrideToken?: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(await getAuthHeaders(overrideToken)) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return handleResponse<T>(res);
}

export async function authedDelete<T = void>(path: string, overrideToken?: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...(await getAuthHeaders(overrideToken)) },
  });
  return handleResponse<T>(res);
}

export { ApiError };
