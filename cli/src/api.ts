import { resolveConfig } from './config.js';
import { CliError } from './errors.js';

async function req<T>(method: string, path: string, body?: unknown, apiKey?: string, apiBase?: string): Promise<T> {
  const cfg = resolveConfig();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = apiKey ?? cfg.apiKey;
  if (key) headers['Authorization'] = `Bearer ${key}`;

  const res = await fetch(`${apiBase ?? cfg.apiBase}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({})) as { success?: boolean; data?: T; error?: { code?: string; message?: string } };
  if (!json.success) throw new CliError(json.error?.code ?? `HTTP_${res.status}`, json.error?.message ?? `HTTP ${res.status}`);
  return json.data as T;
}

export const api = {
  post: <T>(path: string, body?: unknown, apiKey?: string, apiBase?: string) => req<T>('POST', path, body, apiKey, apiBase),
  get:  <T>(path: string, apiKey?: string, apiBase?: string) => req<T>('GET', path, undefined, apiKey, apiBase),
};
