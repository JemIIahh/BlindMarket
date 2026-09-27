/**
 * ToolManager — unified tool import & management component for BlindMarket.
 *
 * Supports three import paths (MCP > OpenAPI > manual) and normalizes
 * everything to the ToolDefinition schema. This is the single interface
 * agent builders use to hook their agents up to external APIs.
 */

import { useState, useCallback } from 'react';
import { Button, Tag, FormField, FormInput, FormSelect, FormTextarea } from './index';
import { HeaderManager } from './HeaderManager';
import { authedPost } from '../../lib/api';
import { friendlyErrorText } from '../../lib/friendlyError';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ToolParam {
  key: string;
  value?: string;
  required: boolean;
}

export interface ToolHeader {
  key: string;
  value?: string;
  required: boolean;
}

/** Legacy tool shape — kept for backward compat with existing deploy flow */
export interface LegacyTool {
  type: 'http' | 'mcp' | 'js' | 'sandbox';
  name: string;
  description: string;
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  toolName?: string;
  headers: ToolHeader[];
  queryParams: ToolParam[];
  body: { contentType: 'application/json' | 'application/x-www-form-urlencoded'; payload: string };
  // js/sandbox specific
  code?: string;
  command?: string;
  setup?: string;
  timeout?: number;
}

/** Normalized ToolDefinition — the output of all import paths */
export interface ToolDef {
  type: 'tool';
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string; enum?: string[]; default?: unknown }>;
    required?: string[];
  };
  execution: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    url: string;
    param_mapping: Record<string, string>;
  };
  auth: {
    type: 'query_param' | 'header' | 'bearer' | 'none';
    key_name: string;
    secret_ref: string;
  };
  /** Where this tool came from */
  source?: 'manual' | 'openapi' | 'mcp';
  /** MCP-specific fields */
  mcp_endpoint?: string;
  mcp_tool_name?: string;
  mcp_headers?: Record<string, string>;
  /** DSL metadata from the backend — carries needs_review, intent, etc. */
  _dsl?: ToolDSLMeta;
}

/** DSL metadata returned alongside tools from import endpoints */
export interface ToolDSLMeta {
  name: string;
  intent: string;
  when_to_use: string;
  side_effects: string;
  retry_safe: boolean;
  needs_review: boolean;
  error_semantics?: Array<{ condition: string; meaning: string }>;
  sequencing?: { typically_follows?: string[]; typically_precedes?: string[] };
}

export type AnyTool = LegacyTool | ToolDef;

export interface ToolManagerProps {
  tools: AnyTool[];
  onChange: (tools: AnyTool[]) => void;
  secrets?: Record<string, string>;
  onSecretsChange?: (secrets: Record<string, string>) => void;
}

// ── Component ──────────────────────────────────────────────────────────────

type ImportMode = 'manual' | 'mcp' | 'openapi';

export function ToolManager({ tools, onChange, secrets = {}, onSecretsChange }: ToolManagerProps) {
  const [mode, setMode] = useState<ImportMode | null>(null);

  // MCP state
  const [mcpUrl, setMcpUrl] = useState('');
  const [mcpHeaders, setMcpHeaders] = useState<ToolHeader[]>([]);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState('');
  const [mcpTools, setMcpTools] = useState<ToolDef[]>([]);
  const [mcpSelected, setMcpSelected] = useState<Set<number>>(new Set());

  // OpenAPI state
  const [openApiSource, setOpenApiSource] = useState('');
  const [openApiLoading, setOpenApiLoading] = useState(false);
  const [openApiError, setOpenApiError] = useState('');
  const [openApiTools, setOpenApiTools] = useState<ToolDef[]>([]);
  const [openApiSelected, setOpenApiSelected] = useState<Set<number>>(new Set());
  const [openApiTitle, setOpenApiTitle] = useState('');
  // Auth override — when spec doesn't declare security schemes
  const [openApiAuthType, setOpenApiAuthType] = useState<'none' | 'bearer' | 'api_key_header' | 'api_key_query'>('none');
  const [openApiAuthKeyName, setOpenApiAuthKeyName] = useState('Authorization');
  const [openApiAuthSecretRef, setOpenApiAuthSecretRef] = useState('');

  // Manual state
  const [toolMode, setToolMode] = useState<'form' | 'json'>('form');
  const [manualTool, setManualTool] = useState<LegacyTool>(emptyLegacyTool);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [manualError, setManualError] = useState('');
  // Manual auth
  const [manualAuthType, setManualAuthType] = useState<'none' | 'bearer' | 'header' | 'query_param'>('none');
  const [manualAuthKeyName, setManualAuthKeyName] = useState('Authorization');
  const [manualAuthSecretRef, setManualAuthSecretRef] = useState('');
  // Manual input_schema params
  const [manualParams, setManualParams] = useState<Array<{ name: string; type: string; description: string; required: boolean }>>([]);
  // Manual execution
  const [manualMethod, setManualMethod] = useState<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'>('POST');
  const [manualParamMapping, setManualParamMapping] = useState<Record<string, string>>({});
  // Edit mode
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  // ── Auth requirements ──────────────────────────────────────────────────

  /** Collect unique auth requirements from already-imported tools AND pending OpenAPI tools */
  const authRequirements = [...tools, ...openApiTools].reduce<Record<string, { type: string; key_name: string; secret_ref: string }>>((acc, t) => {
    if ('auth' in t && t.auth.type !== 'none' && t.auth.secret_ref) {
      acc[t.auth.secret_ref] = t.auth;
    }
    return acc;
  }, {});

  // If user set a manual auth override, inject it as a requirement
  if (openApiAuthType !== 'none' && openApiAuthSecretRef) {
    authRequirements[openApiAuthSecretRef] = {
      type: openApiAuthType === 'bearer' ? 'bearer' : openApiAuthType === 'api_key_header' ? 'header' : 'query_param',
      key_name: openApiAuthKeyName,
      secret_ref: openApiAuthSecretRef,
    };
  }

  // ── MCP connect ────────────────────────────────────────────────────────

  const connectMcp = useCallback(async () => {
    setMcpLoading(true);
    setMcpError('');
    setMcpTools([]);
    try {
      const headers: Record<string, string> = {};
      for (const h of mcpHeaders) {
        if (h.key) headers[h.key] = h.value ?? '';
      }

      const res = await authedPost<{
        serverName: string;
        protocolVersion: string;
        toolCount: number;
        tools: ToolDef[];
        dsls?: ToolDSLMeta[];
      }>('/api/v1/tools/mcp/connect', { url: mcpUrl, headers });

      // Attach DSL metadata to each tool
      const toolsWithDsl = res.tools.map((t, i) => ({
        ...t,
        _dsl: res.dsls?.[i],
      }));

      setMcpTools(toolsWithDsl);
      setMcpSelected(new Set(toolsWithDsl.map((_, i) => i)));
    } catch (e: any) {
      setMcpError(friendlyErrorText(e ?? 'Failed to connect to MCP server'));
    } finally {
      setMcpLoading(false);
    }
  }, [mcpUrl, mcpHeaders]);

  const importSelectedMcp = useCallback(() => {
    const selected = mcpTools.filter((_, i) => mcpSelected.has(i));
    onChange([...tools, ...selected]);
    setMode(null);
    setMcpTools([]);
    setMcpUrl('');
  }, [mcpTools, mcpSelected, tools, onChange]);

  // ── OpenAPI import ─────────────────────────────────────────────────────

  const importOpenApi = useCallback(async () => {
    setOpenApiLoading(true);
    setOpenApiError('');
    setOpenApiTools([]);
    try {
      const res = await authedPost<{
        title: string;
        serverUrl: string;
        toolCount: number;
        tools: ToolDef[];
        dsls?: ToolDSLMeta[];
      }>('/api/v1/tools/openapi/import', { source: openApiSource });

      // Attach DSL metadata to each tool
      const toolsWithDsl = res.tools.map((t, i) => ({
        ...t,
        _dsl: res.dsls?.[i],
      }));

      setOpenApiTools(toolsWithDsl);
      setOpenApiTitle(res.title ?? '');
      setOpenApiSelected(new Set(toolsWithDsl.map((_, i) => i)));
    } catch (e: any) {
      setOpenApiError(friendlyErrorText(e ?? 'Failed to import OpenAPI spec'));
    } finally {
      setOpenApiLoading(false);
    }
  }, [openApiSource]);

  const importSelectedOpenApi = useCallback(() => {
    let selected = openApiTools.filter((_, i) => openApiSelected.has(i));

    // Apply manual auth override to all selected tools if set
    if (openApiAuthType !== 'none' && openApiAuthSecretRef) {
      selected = selected.map(t => ({
        ...t,
        auth: {
          type: openApiAuthType === 'bearer' ? 'bearer' as const
            : openApiAuthType === 'api_key_header' ? 'header' as const
            : 'query_param' as const,
          key_name: openApiAuthKeyName,
          secret_ref: openApiAuthSecretRef,
        },
      }));
    }

    onChange([...tools, ...selected]);
    setMode(null);
    setOpenApiTools([]);
    setOpenApiSource('');
    setOpenApiAuthType('none');
    setOpenApiAuthKeyName('Authorization');
    setOpenApiAuthSecretRef('');
  }, [openApiTools, openApiSelected, tools, onChange, openApiAuthType, openApiAuthKeyName, openApiAuthSecretRef]);

  // ── Manual add ─────────────────────────────────────────────────────────

  const addManualTool = useCallback(() => {
    if (!manualTool.name.trim()) {
      setManualError('Name is required');
      return;
    }
    if (manualTool.type === 'http' && !manualTool.url.trim()) {
      setManualError('URL is required for HTTP tools');
      return;
    }
    if (editingIndex === null && tools.some(t => t.name === manualTool.name)) {
      setManualError('Tool name must be unique');
      return;
    }

    // For HTTP tools, always convert to ToolDef so input_schema and auth are preserved
    if (manualTool.type === 'http') {
      const properties: Record<string, { type: string; description: string }> = {};
      for (const p of manualParams) {
        if (p.name.trim()) {
          properties[p.name.trim()] = { type: p.type, description: p.description };
        }
      }
      const required = manualParams.filter(p => p.required && p.name.trim()).map(p => p.name.trim());
      const toolDef: ToolDef = {
        type: 'tool',
        name: manualTool.name,
        description: manualTool.description,
        input_schema: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) },
        execution: { method: manualMethod, url: manualTool.url, param_mapping: manualParamMapping },
        auth: {
          type: manualAuthType as ToolDef['auth']['type'],
          key_name: manualAuthKeyName,
          secret_ref: manualAuthSecretRef,
        },
      };
      if (editingIndex !== null) {
        const updated = [...tools];
        updated[editingIndex] = toolDef;
        onChange(updated);
      } else {
        onChange([...tools, toolDef]);
      }
    } else {
      if (editingIndex !== null) {
        const updated = [...tools];
        updated[editingIndex] = manualTool;
        onChange(updated);
      } else {
        onChange([...tools, manualTool]);
      }
    }

    setManualTool({ ...emptyLegacyTool });
    setManualAuthType('none');
    setManualAuthKeyName('Authorization');
    setManualAuthSecretRef('');
    setManualParams([]);
    setManualMethod('POST');
    setManualParamMapping({});
    setManualError('');
    setEditingIndex(null);
    setMode(null);
  }, [manualTool, tools, onChange, manualAuthType, manualAuthKeyName, manualAuthSecretRef, manualParams, manualMethod, manualParamMapping, editingIndex]);

  const addJsonTool = useCallback(() => {
    try {
      let obj = JSON.parse(jsonText);
      // Handle array of tools
      const items = Array.isArray(obj) ? obj : [obj];
      const newTools: AnyTool[] = [];
      for (const item of items) {
        const looksLikeToolDef = item.input_schema && item.execution && item.auth;
        if (item.type === 'tool' || looksLikeToolDef) {
          newTools.push({
            type: 'tool',
            name: item.name ?? '',
            description: item.description ?? '',
            input_schema: item.input_schema ?? { type: 'object', properties: {} },
            execution: item.execution ?? { method: 'POST', url: '', param_mapping: {} },
            auth: item.auth ?? { type: 'none', key_name: '', secret_ref: '' },
          } as ToolDef);
        } else {
          newTools.push(item as LegacyTool);
        }
      }
      onChange([...tools, ...newTools]);
      // Reset everything
      setJsonText('');
      setJsonError('');
      setMode(null);
      setManualTool({ ...emptyLegacyTool });
      setManualParams([]);
      setManualMethod('POST');
      setManualParamMapping({});
      setManualAuthType('none');
      setManualAuthKeyName('Authorization');
      setManualAuthSecretRef('');
    } catch {
      setJsonError('Invalid JSON');
    }
  }, [jsonText, tools, onChange]);

  // ── Remove tool ────────────────────────────────────────────────────────

  const removeTool = useCallback((index: number) => {
    onChange(tools.filter((_, i) => i !== index));
    if (editingIndex === index) setEditingIndex(null);
    else if (editingIndex !== null && editingIndex > index) setEditingIndex(editingIndex - 1);
  }, [tools, onChange, editingIndex]);

  // ── Edit tool ─────────────────────────────────────────────────────────

  const editTool = useCallback((index: number) => {
    const t = tools[index];
    setEditingIndex(index);
    setMode('manual');
    setToolMode('form');
    setJsonText('');

    if ('type' in t && t.type === 'tool') {
      // ToolDef — populate form from tool definition
      setManualTool(ot => ({
        ...ot,
        type: 'http',
        name: t.name,
        description: t.description,
        url: t.execution?.url ?? '',
      }));
      // Populate params from input_schema
      const props = t.input_schema?.properties ?? {};
      const required = t.input_schema?.required ?? [];
      setManualParams(Object.entries(props).map(([name, prop]) => ({
        name,
        type: prop.type ?? 'string',
        description: prop.description ?? '',
        required: required.includes(name),
      })));
      setManualMethod(t.execution?.method ?? 'POST');
      setManualParamMapping(t.execution?.param_mapping ?? {});
      setManualAuthType(t.auth?.type ?? 'none');
      setManualAuthKeyName(t.auth?.key_name ?? '');
      setManualAuthSecretRef(t.auth?.secret_ref ?? '');
    } else {
      // LegacyTool
      setManualTool({ ...t } as LegacyTool);
      setManualParams([]);
      setManualMethod((t as LegacyTool).method ?? 'POST');
      setManualParamMapping({});
      setManualAuthType('none');
      setManualAuthKeyName('Authorization');
      setManualAuthSecretRef('');
    }
  }, [tools]);

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3">
      {/* Existing tools list — scrollable if many tools */}
      <div className={`space-y-2 ${tools.length > 5 ? 'max-h-64 overflow-y-auto' : ''}`}>
        {tools.map((t, i) => {
          const dsl = 'type' in t && t.type === 'tool' ? t._dsl : undefined;
          const needsReview = dsl?.needs_review;
          const typeLabel = t.type === 'tool' ? 'API' : t.type === 'mcp' ? 'MCP' : t.type === 'sandbox' ? 'Sandbox' : t.type === 'js' ? 'JS' : 'HTTP';
          return (
          <div key={i} className="flex items-center justify-between gap-3 rounded-xl border border-line px-4 py-3 text-sm cursor-pointer hover:bg-surface-2 transition-colors" onClick={() => editTool(i)}>
            <div className="flex flex-wrap sm:flex-nowrap items-center gap-x-2 gap-y-1 min-w-0">
              <span className="text-ink font-medium truncate">{t.name}</span>
              <Tag tone="neutral" className="sm:hidden shrink-0">{typeLabel}</Tag>
              {needsReview && (
                <Tag tone="warn" className="shrink-0">needs review</Tag>
              )}
            </div>
            <span className="hidden sm:block text-ink-3 font-mono text-xs truncate flex-1 text-right overflow-x-auto whitespace-nowrap">
              <Tag tone="neutral" className="mr-2 shrink-0">
              {typeLabel}
            </Tag>
            {t.type === 'tool' ? t.execution.url : t.url}
          </span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); removeTool(i); }}
            className="p-2 -m-2 text-ink-3 hover:text-err transition-colors shrink-0"
          >
            Remove
          </button>
        </div>
        );
        })}
      </div>

      {/* Add buttons */}
      {!mode && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" label="+ Import from MCP" onClick={() => setMode('mcp')} />
          <Button type="button" variant="outline" label="+ Import from OpenAPI" onClick={() => setMode('openapi')} />
          <Button type="button" variant="outline" label="+ Add manually" onClick={() => setMode('manual')} />
        </div>
      )}

      {/* ── MCP Connect ──────────────────────────────────────────────── */}
      {mode === 'mcp' && (
        <div className="rounded-2xl border border-line p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-ink">Connect MCP Server</h4>
            <Button type="button" variant="ghost" label="Cancel" onClick={() => { setMode(null); setMcpTools([]); }} />
          </div>

          <FormField label="Server URL">
            <FormInput
              className="font-mono"
              value={mcpUrl}
              onChange={e => setMcpUrl(e.target.value)}
              placeholder="https://mcp-server.example.com/sse"
            />
          </FormField>

          <FormField label="Auth headers (optional)">
            <HeaderManager headers={mcpHeaders} onChange={setMcpHeaders} />
          </FormField>

          {mcpError && <p className="text-xs text-err">{mcpError}</p>}

          <Button
            type="button"
            variant="primary"
            label={mcpLoading ? 'Connecting…' : 'Connect & list tools'}
            onClick={connectMcp}
            disabled={mcpLoading || !mcpUrl.trim()}
          />

          {mcpTools.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-ink-3">{mcpTools.length} tools found. Select which to import:</p>
              <div className={`space-y-1 ${mcpTools.length > 8 ? 'max-h-56 overflow-y-auto' : ''}`}>
                {mcpTools.map((t, i) => (
                  <label key={i} className="flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-1 rounded-lg border border-line px-3 py-2 text-sm cursor-pointer hover:bg-surface-2">
                    <input
                      type="checkbox"
                      checked={mcpSelected.has(i)}
                      onChange={e => {
                        const next = new Set(mcpSelected);
                        e.target.checked ? next.add(i) : next.delete(i);
                        setMcpSelected(next);
                      }}
                      className="accent-accent"
                    />
                    <span className="font-medium text-ink flex-1 min-w-24 truncate sm:flex-initial sm:min-w-0">{t.name}</span>
                    {t._dsl?.needs_review && (
                      <Tag tone="warn" className="shrink-0">needs review</Tag>
                    )}
                    <span className="hidden sm:block text-ink-3 text-xs truncate flex-1">{t.description}</span>
                  </label>
                ))}
              </div>
              <Button
                type="button"
                variant="primary"
                label={`Import ${mcpSelected.size} tool${mcpSelected.size !== 1 ? 's' : ''}`}
                onClick={importSelectedMcp}
                disabled={mcpSelected.size === 0}
              />
            </div>
          )}
        </div>
      )}

      {/* ── OpenAPI Import ───────────────────────────────────────────── */}
      {mode === 'openapi' && (
        <div className="rounded-2xl border border-line p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-ink">Import from OpenAPI Spec</h4>
            <Button type="button" variant="ghost" label="Cancel" onClick={() => { setMode(null); setOpenApiTools([]); }} />
          </div>

          <FormField label="Spec URL or paste JSON/YAML">
            <FormTextarea
              rows={6}
              className="font-mono text-xs"
              value={openApiSource}
              onChange={e => setOpenApiSource(e.target.value)}
              placeholder={"https://api.example.com/openapi.json\n\n— or paste the spec directly —\n{\n  \"openapi\": \"3.0.0\",\n  \"info\": { \"title\": \"My API\" },\n  \"paths\": {}\n}"}
            />
          </FormField>

          {openApiError && <p className="text-xs text-err">{openApiError}</p>}

          <Button
            type="button"
            variant="primary"
            label={openApiLoading ? 'Importing…' : 'Parse & list tools'}
            onClick={importOpenApi}
            disabled={openApiLoading || !openApiSource.trim()}
          />

          {openApiTools.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs text-ink-3">
                {openApiTitle && <span className="font-medium">{openApiTitle} — </span>}
                {openApiTools.length} operations found. Select which to import:
              </p>

              {/* Auth override — when spec doesn't declare security schemes */}
              <div className="rounded-xl border border-line p-3.5 space-y-2 bg-surface-2">
                <p className="text-xs text-ink-3 font-medium">Authentication</p>
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                  <label className="text-xs text-ink shrink-0">Auth type:</label>
                  <select
                    value={openApiAuthType}
                    onChange={e => setOpenApiAuthType(e.target.value as typeof openApiAuthType)}
                    className="w-full min-w-0 sm:w-auto px-2 py-1 bg-surface text-ink text-xs border-0 outline-none"
                  >
                    <option value="none">None (spec-declared or no auth)</option>
                    <option value="bearer">Bearer Token</option>
                    <option value="api_key_header">API Key (Header)</option>
                    <option value="api_key_query">API Key (Query Param)</option>
                  </select>
                </div>
                {openApiAuthType !== 'none' && (
                  <>
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                      <label className="text-xs text-ink shrink-0 sm:w-28">Header/Param name:</label>
                      <input
                        type="text"
                        value={openApiAuthKeyName}
                        onChange={e => setOpenApiAuthKeyName(e.target.value)}
                        placeholder={openApiAuthType === 'bearer' ? 'Authorization' : 'X-API-Key'}
                        className="flex-1 w-full min-w-0 sm:w-auto px-2 py-1 bg-surface text-ink text-xs font-mono border-0 outline-none rounded-md focus:ring-1 focus:ring-line-2"
                      />
                    </div>
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                      <label className="text-xs text-ink shrink-0 sm:w-28">Secret ref:</label>
                      <input
                        type="text"
                        value={openApiAuthSecretRef}
                        onChange={e => setOpenApiAuthSecretRef(e.target.value)}
                        placeholder="e.g. github_token"
                        className="flex-1 w-full min-w-0 sm:w-auto px-2 py-1 bg-surface text-ink text-xs font-mono border-0 outline-none rounded-md focus:ring-1 focus:ring-line-2"
                      />
                    </div>
                  </>
                )}
              </div>

              {/* Auth requirements from spec-declared schemes OR manual override */}
              {Object.keys(authRequirements).length > 0 && onSecretsChange && (
                <div className="rounded-xl border border-line p-3.5 space-y-2 bg-surface-2">
                  <p className="text-xs text-ink-3">
                    This API requires authentication. Enter your credentials:
                  </p>
                  {Object.entries(authRequirements).map(([ref, auth]) => (
                    <div key={ref} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                      <label className="text-xs text-ink font-medium shrink-0 sm:w-40 truncate" title={ref}>
                        {auth.key_name || ref}
                        <span className="text-ink-3 ml-1">({auth.type})</span>
                      </label>
                      <input
                        type="password"
                        value={secrets[ref] ?? ''}
                        onChange={e => onSecretsChange({ ...secrets, [ref]: e.target.value })}
                        placeholder={`Enter ${auth.key_name || 'secret'}`}
                        className="flex-1 w-full min-w-0 sm:w-auto px-3 py-1.5 bg-surface text-ink text-xs font-mono border-0 outline-none rounded-md focus:ring-1 focus:ring-line-2"
                      />
                    </div>
                  ))}
                </div>
              )}

              <div className={`space-y-1 ${openApiTools.length > 8 ? 'max-h-56 overflow-y-auto' : ''}`}>
                {openApiTools.map((t, i) => (
                  <label key={i} className="flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-1 rounded-lg border border-line px-3 py-2 text-sm cursor-pointer hover:bg-surface-2">
                    <input
                      type="checkbox"
                      checked={openApiSelected.has(i)}
                      onChange={e => {
                        const next = new Set(openApiSelected);
                        e.target.checked ? next.add(i) : next.delete(i);
                        setOpenApiSelected(next);
                      }}
                      className="accent-accent"
                    />
                    <Tag tone="neutral" className="shrink-0">{t.execution.method}</Tag>
                    <span className="font-medium text-ink flex-1 min-w-24 truncate sm:flex-initial sm:min-w-0">{t.name}</span>
                    {t._dsl?.needs_review && (
                      <Tag tone="warn" className="shrink-0">needs review</Tag>
                    )}
                    <span className="hidden sm:block text-ink-3 text-xs truncate flex-1">{t.description}</span>
                  </label>
                ))}
              </div>
              <Button
                type="button"
                variant="primary"
                label={`Import ${openApiSelected.size} tool${openApiSelected.size !== 1 ? 's' : ''}`}
                onClick={importSelectedOpenApi}
                disabled={openApiSelected.size === 0}
              />
            </div>
          )}
        </div>
      )}

      {/* ── Manual Entry ─────────────────────────────────────────────── */}
      {mode === 'manual' && (
        <div className="rounded-2xl border border-line p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-ink">{editingIndex !== null ? 'Edit Tool' : 'Add Tool Manually'}</h4>
            <div className="inline-flex items-center gap-1 rounded-full border border-line bg-surface p-1 w-fit">
              <button type="button" onClick={() => {
                // JSON → Form: parse JSON into form ONLY if jsonText has content
                if (jsonText.trim()) {
                  try {
                    let obj = JSON.parse(jsonText);
                    // Handle array: take the first tool definition
                    if (Array.isArray(obj)) obj = obj[0] ?? {};
                    if (obj && typeof obj === 'object') {
                      setManualTool(t => ({
                        ...t,
                        name: obj.name ?? t.name,
                        description: obj.description ?? t.description,
                        url: obj.execution?.url ?? obj.url ?? t.url,
                        method: (obj.execution?.method ?? obj.method ?? 'POST') as LegacyTool['method'],
                        toolName: obj.toolName ?? t.toolName,
                        code: obj.code ?? t.code,
                        command: obj.command ?? t.command,
                        setup: obj.setup ?? t.setup,
                        timeout: obj.timeout ?? t.timeout,
                      }));
                      if (obj.input_schema?.properties) {
                        const entries = Object.entries(obj.input_schema.properties) as Array<[string, { type?: string; description?: string }]>;
                        setManualParams(entries.map(([name, prop]) => ({
                          name,
                          type: prop.type ?? 'string',
                          description: prop.description ?? '',
                          required: (obj.input_schema.required ?? []).includes(name),
                        })));
                      } else {
                        setManualParams([]);
                      }
                      if (obj.execution) {
                        setManualMethod(obj.execution.method ?? 'POST');
                        setManualParamMapping(obj.execution.param_mapping ?? {});
                      } else {
                        setManualMethod('POST');
                        setManualParamMapping({});
                      }
                      if (obj.auth) {
                        setManualAuthType(obj.auth.type ?? 'none');
                        setManualAuthKeyName(obj.auth.key_name ?? '');
                        setManualAuthSecretRef(obj.auth.secret_ref ?? '');
                      }
                    }
                  } catch { /* ignore parse errors */ }
                }
                setToolMode('form');
              }}
                aria-pressed={toolMode === 'form'}
                className={`rounded-full px-3.5 py-1 text-xs font-medium transition-colors ${toolMode === 'form' ? 'bg-invert text-invert-fg' : 'text-ink-3 hover:text-ink-2'}`}>
                Form
              </button>
              <div className="w-px h-4 bg-line" />
              <button type="button" onClick={() => {
                // Form → JSON: only serialize if jsonText is empty (user hasn't pasted anything yet)
                if (!jsonText.trim()) {
                  const obj: Record<string, unknown> = {
                    name: manualTool.name,
                    description: manualTool.description,
                  };
                  if (manualTool.type === 'http') {
                    const properties: Record<string, { type: string; description: string }> = {};
                    for (const p of manualParams) {
                      if (p.name.trim()) properties[p.name.trim()] = { type: p.type, description: p.description };
                    }
                    const required = manualParams.filter(p => p.required && p.name.trim()).map(p => p.name.trim());
                    obj.input_schema = { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
                    obj.execution = { method: manualMethod, url: manualTool.url, param_mapping: manualParamMapping };
                    obj.auth = {
                      type: manualAuthType,
                      key_name: manualAuthKeyName,
                      secret_ref: manualAuthSecretRef,
                    };
                  } else if (manualTool.type === 'mcp') {
                    obj.type = 'mcp';
                    obj.endpointUrl = manualTool.url;
                    obj.toolName = manualTool.toolName;
                  } else if (manualTool.type === 'js') {
                    obj.type = 'js';
                    obj.code = manualTool.code;
                  } else if (manualTool.type === 'sandbox') {
                    obj.type = 'sandbox';
                    obj.command = manualTool.command;
                    obj.setup = manualTool.setup;
                    obj.timeout = manualTool.timeout;
                  }
                  setJsonText(JSON.stringify(obj, null, 2));
                }
                setToolMode('json');
              }}
                aria-pressed={toolMode === 'json'}
                className={`rounded-full px-3.5 py-1 text-xs font-medium transition-colors ${toolMode === 'json' ? 'bg-invert text-invert-fg' : 'text-ink-3 hover:text-ink-2'}`}>
                Paste JSON
              </button>
            </div>
          </div>

          {toolMode === 'form' ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField label="Type">
                  <FormSelect value={manualTool.type} onChange={e => setManualTool(t => ({ ...t, type: e.target.value as LegacyTool['type'] }))}>
                    <option value="http">HTTP</option>
                    <option value="mcp">MCP</option>
                    <option value="js">JS Eval</option>
                    <option value="sandbox">Sandbox</option>
                  </FormSelect>
                </FormField>
                <FormField label="Name">
                  <FormInput value={manualTool.name} onChange={e => setManualTool(t => ({ ...t, name: e.target.value }))} placeholder="web-search" />
                </FormField>
              </div>

              <FormField label="Description">
                <FormTextarea rows={2} value={manualTool.description} onChange={e => setManualTool(t => ({ ...t, description: e.target.value }))} placeholder="What this tool does — the agent uses this to determine what to send" />
              </FormField>

              {manualTool.type === 'http' && (
                <>
                  <FormField label="URL">
                    <FormInput className="font-mono" value={manualTool.url} onChange={e => setManualTool(t => ({ ...t, url: e.target.value }))} placeholder="https://api.example.com/endpoint" />
                  </FormField>
                  <FormField label="Method">
                    <FormSelect value={manualMethod} onChange={e => setManualMethod(e.target.value as typeof manualMethod)}>
                      <option value="POST">POST</option>
                      <option value="GET">GET</option>
                      <option value="PUT">PUT</option>
                      <option value="PATCH">PATCH</option>
                      <option value="DELETE">DELETE</option>
                    </FormSelect>
                  </FormField>

                  {/* Parameters */}
                  <div className="rounded-xl border border-line p-3.5 space-y-2 bg-surface-2">
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-ink-3 font-medium">Parameters</p>
                      <button type="button" onClick={() => setManualParams(p => [...p, { name: '', type: 'string', description: '', required: false }])} className="p-2 -m-2 text-xs text-accent hover:underline">+ Add</button>
                    </div>
                    {manualParams.length === 0 && <p className="text-xs text-ink-3">No parameters — agent will send an empty body or construct one from the description.</p>}
                    {manualParams.map((p, i) => (
                      <div key={i} className="grid grid-cols-2 sm:grid-cols-[1fr_80px_1fr_auto_auto] gap-2 items-center">
                        <input type="text" value={p.name} onChange={e => setManualParams(ps => ps.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} placeholder="param_name" className="w-full min-w-0 px-2 py-1 bg-surface text-ink text-xs font-mono border-0 outline-none rounded-md focus:ring-1 focus:ring-line-2" />
                        <select value={p.type} onChange={e => setManualParams(ps => ps.map((x, j) => j === i ? { ...x, type: e.target.value } : x))} className="w-full min-w-0 rounded-md px-2 py-1 bg-surface text-ink text-xs border-0 outline-none">
                          <option value="string">string</option>
                          <option value="integer">integer</option>
                          <option value="number">number</option>
                          <option value="boolean">boolean</option>
                          <option value="object">object</option>
                          <option value="array">array</option>
                        </select>
                        <input type="text" value={p.description} onChange={e => setManualParams(ps => ps.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} placeholder="description" className="col-span-2 sm:col-span-1 w-full min-w-0 px-2 py-1 bg-surface text-ink text-xs border-0 outline-none rounded-md focus:ring-1 focus:ring-line-2" />
                        <label className="flex items-center gap-1 text-xs text-ink-3 whitespace-nowrap">
                          <input type="checkbox" checked={p.required} onChange={e => setManualParams(ps => ps.map((x, j) => j === i ? { ...x, required: e.target.checked } : x))} className="accent-accent" />
                          req
                        </label>
                        <button type="button" onClick={() => setManualParams(ps => ps.filter((_, j) => j !== i))} className="justify-self-end sm:justify-self-auto p-2 -m-2 text-xs text-err hover:underline">✕</button>
                      </div>
                    ))}
                    {manualParams.length > 0 && (
                      <div className="border-t border-line pt-2 mt-2">
                        <p className="text-xs text-ink-3 font-medium mb-1">Param mapping (where each param goes)</p>
                        {manualParams.filter(p => p.name).map(p => (
                          <div key={p.name} className="flex items-center gap-2 mb-1">
                            <span className="text-xs text-ink font-mono w-24 truncate">{p.name}</span>
                            <select value={manualParamMapping[p.name] ?? 'body'} onChange={e => setManualParamMapping(m => ({ ...m, [p.name]: e.target.value }))} className="px-2 py-1 bg-surface text-ink text-xs border-0 outline-none">
                              <option value="body">body</option>
                              <option value="query">query</option>
                              <option value="header">header</option>
                            </select>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="rounded-xl border border-line p-3.5 space-y-2 bg-surface-2">
                    <p className="text-xs text-ink-3 font-medium">Auth (optional)</p>
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                      <label className="text-xs text-ink shrink-0">Type:</label>
                      <select
                        value={manualAuthType}
                        onChange={e => setManualAuthType(e.target.value as typeof manualAuthType)}
                        className="w-full min-w-0 sm:w-auto px-2 py-1 bg-surface text-ink text-xs border-0 outline-none"
                      >
                        <option value="none">None</option>
                        <option value="bearer">Bearer Token</option>
                        <option value="header">API Key (Header)</option>
                        <option value="query_param">API Key (Query)</option>
                      </select>
                    </div>
                    {manualAuthType !== 'none' && (
                      <>
                        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                          <label className="text-xs text-ink shrink-0 sm:w-28">Header/Param:</label>
                          <input
                            type="text"
                            value={manualAuthKeyName}
                            onChange={e => setManualAuthKeyName(e.target.value)}
                            placeholder={manualAuthType === 'bearer' ? 'Authorization' : 'X-API-Key'}
                            className="flex-1 w-full min-w-0 sm:w-auto px-2 py-1 bg-surface text-ink text-xs font-mono border-0 outline-none rounded-md focus:ring-1 focus:ring-line-2"
                          />
                        </div>
                        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                          <label className="text-xs text-ink shrink-0 sm:w-28">Secret ref:</label>
                          <input
                            type="text"
                            value={manualAuthSecretRef}
                            onChange={e => setManualAuthSecretRef(e.target.value)}
                            placeholder="e.g. my_api_key"
                            className="flex-1 w-full min-w-0 sm:w-auto px-2 py-1 bg-surface text-ink text-xs font-mono border-0 outline-none rounded-md focus:ring-1 focus:ring-line-2"
                          />
                        </div>
                      </>
                    )}
                  </div>
                </>
              )}
              {manualTool.type === 'mcp' && <McpForm tool={manualTool} onChange={setManualTool} />}
              {manualTool.type === 'js' && <JsForm tool={manualTool} onChange={setManualTool} />}
              {manualTool.type === 'sandbox' && <SandboxForm tool={manualTool} onChange={setManualTool} />}
            </>
          ) : (
            <FormField label="Tool JSON">
              <FormTextarea
                rows={14}
                className="font-mono text-xs"
                value={jsonText}
                onChange={e => { setJsonText(e.target.value); setJsonError(''); }}
                placeholder={`{
  "name": "upload_svg",
  "description": "Upload an SVG file and get a shareable URL...",
  "input_schema": {
    "type": "object",
    "properties": {
      "file": { "type": "string", "description": "SVG markup" }
    },
    "required": ["file"]
  },
  "execution": {
    "method": "POST",
    "url": "https://api.example.com/upload",
    "param_mapping": { "file": "body" }
  },
  "auth": { "type": "none" }
}`}
              />
              {jsonError && <p className="text-xs text-err mt-1">{jsonError}</p>}
            </FormField>
          )}

          {manualError && <p className="text-xs text-err">{manualError}</p>}

          <div className="flex gap-2">
            <Button type="button" variant="primary" label={editingIndex !== null ? 'Save changes' : 'Add tool'} onClick={toolMode === 'form' ? addManualTool : addJsonTool} />
            <Button type="button" variant="ghost" label="Cancel" onClick={() => { setMode(null); setManualError(''); }} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-forms for each tool type ───────────────────────────────────────────

function McpForm({ tool, onChange }: { tool: LegacyTool; onChange: (t: LegacyTool) => void }) {
  return (
    <div className="space-y-3">
      <FormField label="MCP Server URL">
        <FormInput className="font-mono" value={tool.url} onChange={e => onChange({ ...tool, url: e.target.value })} placeholder="https://mcp-server.example.com/sse" />
      </FormField>
      <FormField label="Tool name on server">
        <FormInput value={tool.toolName ?? ''} onChange={e => onChange({ ...tool, toolName: e.target.value })} placeholder="tool_name" />
      </FormField>
    </div>
  );
}

function JsForm({ tool, onChange }: { tool: LegacyTool; onChange: (t: LegacyTool) => void }) {
  return (
    <FormField label="JS code (receives `input`, returns string)">
      <FormTextarea rows={6} className="font-mono text-xs" value={tool.code ?? ''} onChange={e => onChange({ ...tool, code: e.target.value })} placeholder="return input.toUpperCase();" />
    </FormField>
  );
}

function SandboxForm({ tool, onChange }: { tool: LegacyTool; onChange: (t: LegacyTool) => void }) {
  return (
    <div className="space-y-3">
      <FormField label="Command ({input} is replaced with agent input)">
        <FormInput className="font-mono" value={tool.command ?? ''} onChange={e => onChange({ ...tool, command: e.target.value })} placeholder="python3 -c '{input}'" />
      </FormField>
      <FormField label="Setup commands (optional, runs first)">
        <FormInput className="font-mono" value={tool.setup ?? ''} onChange={e => onChange({ ...tool, setup: e.target.value })} placeholder="pip install pandas" />
      </FormField>
      <FormField label="Timeout (seconds)">
        <FormInput type="number" value={tool.timeout ?? 300} onChange={e => onChange({ ...tool, timeout: parseInt(e.target.value) || 300 })} />
      </FormField>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

const emptyLegacyTool: LegacyTool = {
  type: 'http', name: '', description: '', url: '', method: 'POST',
  headers: [], queryParams: [], body: { contentType: 'application/json', payload: '' },
};
