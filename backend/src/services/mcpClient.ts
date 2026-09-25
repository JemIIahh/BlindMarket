/**
 * MCP (Model Context Protocol) client for BlindMarket.
 *
 * Implements the JSON-RPC 2.0 based MCP protocol over HTTP.
 * Used to connect to MCP servers, list their tools, and call them.
 *
 * MCP tools are normalized to ToolDefinition shape for the execution layer.
 */

import type { ToolDefinition, ToolDSL } from '../types.js';
import { compileFromMcp, type McpToolInput } from './toolDslCompiler.js';
import { renderToolDefinition } from './toolDslRenderer.js';
import { egressFetch, MAX_TOOL_RESPONSE_BYTES, readCappedText } from './egressGuard.js';

// ── MCP JSON-RPC types ─────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

interface McpServerInfo {
  name?: string;
  version?: string;
}

interface McpInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo?: McpServerInfo;
}

// ── MCP Client ─────────────────────────────────────────────────────────────

export interface McpConnection {
  url: string;
  serverName?: string;
  protocolVersion?: string;
  tools: ToolDefinition[];
  dsls: ToolDSL[];
}

/**
 * Initialize an MCP server connection.
 * Sends the `initialize` handshake and returns server info.
 */
export async function mcpInitialize(
  serverUrl: string,
  headers: Record<string, string> = {},
  timeoutMs = 10_000,
): Promise<McpInitializeResult> {
  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'blindmarket', version: '1.0.0' },
    },
  };

  const res = await mcpPost(serverUrl, request, headers, timeoutMs);
  if (res.error) {
    throw new Error(`MCP initialize failed: ${res.error.message}`);
  }
  return res.result as McpInitializeResult;
}

/**
 * List tools from an MCP server.
 * Returns normalized ToolDefinitions and DSL objects.
 */
export async function mcpListTools(
  serverUrl: string,
  headers: Record<string, string> = {},
  timeoutMs = 15_000,
): Promise<{ tools: ToolDefinition[]; dsls: ToolDSL[] }> {
  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
  };

  const res = await mcpPost(serverUrl, request, headers, timeoutMs);
  if (res.error) {
    throw new Error(`MCP tools/list failed: ${res.error.message}`);
  }

  const result = res.result as { tools?: McpTool[] };
  const tools = result.tools ?? [];

  // Normalize each MCP tool through DSL
  const normalized = tools.map(mcpTool => normalizeMcpTool(mcpTool, serverUrl, headers));
  return {
    tools: normalized.map(n => n.tool),
    dsls: normalized.map(n => n.dsl),
  };
}

/**
 * Call a tool on an MCP server.
 * Returns the raw result from the MCP server.
 */
export async function mcpCallTool(
  serverUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
  timeoutMs = 30_000,
): Promise<unknown> {
  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args,
    },
  };

  const res = await mcpPost(serverUrl, request, headers, timeoutMs);
  if (res.error) {
    throw new Error(`MCP tools/call failed: ${res.error.message}`);
  }
  return res.result;
}

/**
 * Connect to an MCP server, initialize, and list tools.
 * Full end-to-end connection flow.
 */
export async function mcpConnect(
  serverUrl: string,
  authHeaders: Record<string, string> = {},
): Promise<McpConnection> {
  // Initialize
  const initResult = await mcpInitialize(serverUrl, authHeaders);

  // List tools
  const { tools, dsls } = await mcpListTools(serverUrl, authHeaders);

  return {
    url: serverUrl,
    serverName: initResult.serverInfo?.name,
    protocolVersion: initResult.protocolVersion,
    tools,
    dsls,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Normalize an MCP tool into a DSL and render to ToolDefinition.
 * MCP tools use JSON-RPC and handle their own transport, so the execution
 * layer routes calls back through mcpCallTool instead of building raw HTTP.
 */
function normalizeMcpTool(mcpTool: McpTool, serverUrl: string, authHeaders: Record<string, string> = {}): { tool: ToolDefinition; dsl: ToolDSL } {
  const dsl = compileFromMcp(mcpTool as McpToolInput, serverUrl);
  // Override execution to use MCP sentinel method
  dsl.execution = {
    method: 'GET',
    url: serverUrl,
    param_mapping: {},
  };
  const tool = renderToolDefinition(dsl);
  // Tag as MCP so the worker routes via JSON-RPC instead of raw HTTP
  tool.source = 'mcp';
  tool.mcp_endpoint = serverUrl;
  tool.mcp_tool_name = mcpTool.name;
  tool.mcp_headers = authHeaders;
  return { tool, dsl };
}

/**
 * POST a JSON-RPC request to an MCP server.
 */
async function mcpPost(
  url: string,
  request: JsonRpcRequest,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<JsonRpcResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // The server URL is chosen by the caller: guarded destination, capped read.
    const res = await egressFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...headers,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await readCappedText(res, MAX_TOOL_RESPONSE_BYTES).catch(() => '');
      throw new Error(`MCP server returned ${res.status}: ${text.slice(0, 200)}`);
    }

    const text = await readCappedText(res, MAX_TOOL_RESPONSE_BYTES);
    clearTimeout(timer);
    return JSON.parse(text) as JsonRpcResponse;
  } catch (e: any) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      throw new Error('MCP connection timed out');
    }
    throw e;
  }
}
