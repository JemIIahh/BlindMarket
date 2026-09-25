/**
 * OpenAPI spec parser for BlindMarket.
 *
 * Parses OpenAPI 3.x specs (JSON or YAML) and converts operations
 * into ToolDefinition shape for the execution layer.
 *
 * Supports: apiKey, http (bearer/basic) security schemes.
 */

import type { ToolDefinition, ToolDSL } from '../types.js';
import { compileFromOpenApi, type OpenApiOperationInput } from './toolDslCompiler.js';
import { renderToolDefinition } from './toolDslRenderer.js';
import { egressFetch, readCappedText } from './egressGuard.js';

/** Large public specs run to several MB; anything past this is refused. */
const MAX_OPENAPI_SPEC_BYTES = 10 * 1024 * 1024;

// ── OpenAPI types (subset we need) ─────────────────────────────────────────

interface OpenApiSpec {
  openapi: string;
  info?: { title?: string; version?: string };
  servers?: Array<{ url: string }>;
  paths: Record<string, Record<string, OpenApiOperation>>;
  security?: Array<Record<string, string[]>>;
  components?: {
    securitySchemes?: Record<string, OpenApiSecurityScheme>;
  };
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    content?: Record<string, { schema?: OpenApiSchema }>;
  };
  security?: Array<Record<string, string[]>>;
  tags?: string[];
}

interface OpenApiParameter {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  description?: string;
  required?: boolean;
  schema?: OpenApiSchema;
}

interface OpenApiSchema {
  type?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: OpenApiSchema;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
}

interface OpenApiSecurityScheme {
  type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect';
  name?: string;         // for apiKey: header/query param name
  in?: 'query' | 'header' | 'cookie';
  scheme?: string;       // for http: "bearer" or "basic"
  bearerFormat?: string;
}

// ── Parser ─────────────────────────────────────────────────────────────────

/**
 * Parse an OpenAPI spec from a URL or raw content string.
 * Returns DSL objects (rich metadata) and rendered ToolDefinitions (for execution).
 */
export async function parseOpenApiSpec(
  source: string,
): Promise<{ tools: ToolDefinition[]; dsls: ToolDSL[]; serverUrl: string; title?: string }> {
  let spec: OpenApiSpec;

  // Determine if source is a URL or raw content
  if (source.startsWith('http://') || source.startsWith('https://')) {
    spec = await fetchAndParseSpec(source);
  } else {
    spec = parseSpecContent(source);
  }

  // Extract server URL
  const serverUrl = spec.servers?.[0]?.url ?? '';
  if (!serverUrl) {
    throw new Error('No server URL found in OpenAPI spec');
  }

  // Resolve security scheme — fall back to global security
  const globalSecurity = spec.components?.securitySchemes;
  const globalSecurityReq = spec.security;

  // Convert each operation to DSL, then render to ToolDefinition
  const dsls: ToolDSL[] = [];
  const tools: ToolDefinition[] = [];

  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (method === 'parameters' || method === 'summary' || method === 'description') continue;
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method.toLowerCase())) continue;

      const opInput: OpenApiOperationInput = {
        operationId: operation.operationId,
        summary: operation.summary,
        description: operation.description,
        method: method.toUpperCase(),
        path,
        parameters: operation.parameters as OpenApiOperationInput['parameters'],
        requestBody: operation.requestBody as OpenApiOperationInput['requestBody'],
        security: operation.security,
        securitySchemes: globalSecurity as OpenApiOperationInput['securitySchemes'],
      };

      const dsl = compileFromOpenApi(opInput);
      applyAuthFromSecurity(dsl, operation.security ?? globalSecurityReq, globalSecurity);
      dsls.push(dsl);
      const tool = renderToolDefinition(dsl);
      tool.source = 'openapi';
      tools.push(tool);
    }
  }

  return {
    tools,
    dsls,
    serverUrl,
    title: spec.info?.title,
  };
}

/** Apply auth config from OpenAPI security schemes to a DSL */
function applyAuthFromSecurity(
  dsl: ToolDSL,
  opSecurity?: Array<Record<string, string[]>>,
  securitySchemes?: Record<string, OpenApiSecurityScheme>,
): void {
  const security = opSecurity?.[0];
  if (!security || !securitySchemes) return;

  const schemeName = Object.keys(security)[0];
  const scheme = securitySchemes[schemeName];
  if (!scheme) return;

  switch (scheme.type) {
    case 'apiKey':
      dsl.auth = {
        type: scheme.in === 'header' ? 'header' : 'query_param',
        key_name: scheme.name ?? schemeName,
        secret_ref: `openapi:${schemeName}`,
      };
      break;
    case 'http':
      if (scheme.scheme?.toLowerCase() === 'bearer') {
        dsl.auth = {
          type: 'bearer',
          key_name: 'Authorization',
          secret_ref: `openapi:${schemeName}`,
        };
      }
      break;
  }
}

async function fetchAndParseSpec(url: string): Promise<OpenApiSpec> {
  // The spec URL is chosen by the caller: guarded destination, capped read.
  const res = await egressFetch(url, {
    headers: { Accept: 'application/json, text/yaml, text/plain' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Failed to fetch OpenAPI spec: ${res.status}`);
  }

  const text = await readCappedText(res, MAX_OPENAPI_SPEC_BYTES);
  return parseSpecContent(text);
}

function parseSpecContent(content: string): OpenApiSpec {
  // Try JSON first
  try {
    return JSON.parse(content) as OpenApiSpec;
  } catch {
    // Not JSON — try YAML
  }

  // Try YAML (basic parser — in production, use a proper YAML library)
  // For now, throw if it's not JSON
  throw new Error(
    'Could not parse OpenAPI spec. Only JSON is currently supported. ' +
    'Please convert your YAML spec to JSON first.'
  );
}

