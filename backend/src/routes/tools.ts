/**
 * Tool import routes for BlindMarket.
 *
 * Handles MCP server connections, OpenAPI spec imports, tool validation,
 * and test calls. All routes are authenticated — only the agent owner
 * can add tools to their agent.
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import type { AuthRequest, ApiResponse } from '../types.js';
import type { ToolDefinition } from '../types.js';
import { validateToolDefinition, executeTool, type SecretStore } from '../services/toolExecutor.js';
import { mcpConnect } from '../services/mcpClient.js';
import { parseOpenApiSpec } from '../services/openApiParser.js';
import { reportToolError, getToolErrorLogs, clearToolErrorLogs } from '../services/toolErrorLog.js';
import { getAgent } from '../services/agentRunner.js';

export const toolsRouter = Router();

// ── Schemas ────────────────────────────────────────────────────────────────

const mcpConnectSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
});

const openApiImportSchema = z.object({
  source: z.string().min(1),  // URL or pasted JSON content
});

const validateSchema = z.object({
  tool: z.custom<ToolDefinition>(),
});

const testCallSchema = z.object({
  tool: z.custom<ToolDefinition>(),
  args: z.record(z.unknown()),
  secrets: z.record(z.string()).optional(),
});

// ── POST /api/v1/tools/mcp/connect ─────────────────────────────────────────
// Connect to an MCP server and return normalized tool definitions.

toolsRouter.post('/mcp/connect', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { url, headers } = mcpConnectSchema.parse(req.body);

    const connection = await mcpConnect(url, headers ?? {});

    const tools = connection.tools.map(t => ({
      ...t,
      // Tag as MCP source for the frontend
      _source: 'mcp' as const,
      _serverName: connection.serverName,
    }));

    res.json({
      success: true,
      data: {
        serverName: connection.serverName,
        protocolVersion: connection.protocolVersion,
        toolCount: tools.length,
        tools,
        dsls: connection.dsls,
      },
    } satisfies ApiResponse);
  } catch (e: any) {
    next(e);
  }
});

// ── POST /api/v1/tools/openapi/import ──────────────────────────────────────
// Import tools from an OpenAPI spec URL or pasted JSON.

toolsRouter.post('/openapi/import', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { source } = openApiImportSchema.parse(req.body);

    const result = await parseOpenApiSpec(source);

    const tools = result.tools.map(t => ({
      ...t,
      _source: 'openapi' as const,
      _serverUrl: result.serverUrl,
      _title: result.title,
    }));

    res.json({
      success: true,
      data: {
        title: result.title,
        serverUrl: result.serverUrl,
        toolCount: tools.length,
        tools,
        dsls: result.dsls,
      },
    } satisfies ApiResponse);
  } catch (e: any) {
    next(e);
  }
});

// ── POST /api/v1/tools/validate ────────────────────────────────────────────
// Validate a tool definition before saving.

toolsRouter.post('/validate', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { tool } = validateSchema.parse(req.body);
    const errors = validateToolDefinition(tool);

    res.json({
      success: true,
      data: {
        valid: errors.length === 0,
        errors,
      },
    } satisfies ApiResponse);
  } catch (e: any) {
    next(e);
  }
});

// ── POST /api/v1/tools/test ────────────────────────────────────────────────
// Test a tool call with placeholder values. Fires the real request.

toolsRouter.post('/test', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { tool, args, secrets } = testCallSchema.parse(req.body);

    // Validate first
    const errors = validateToolDefinition(tool);
    if (errors.length > 0) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_FAILED', message: errors.join('; ') },
      });
      return;
    }

    const result = await executeTool(tool, args, secrets ?? {});

    res.json({
      success: true,
      data: result,
    } satisfies ApiResponse);
  } catch (e: any) {
    next(e);
  }
});

// ── POST /api/v1/tools/execute ─────────────────────────────────────────────
// Execute a tool with arguments. Called by worker.js for normalized tools.
// Auth is handled via agent platform token — secrets are resolved server-side.

toolsRouter.post('/execute', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { tool, args, secrets: reqSecrets } = z.object({
      tool: z.custom<ToolDefinition>(),
      args: z.record(z.unknown()),
      taskId: z.string().optional(),
      secrets: z.record(z.string()).optional(),
    }).parse(req.body);

    // Validate
    const errors = validateToolDefinition(tool);
    if (errors.length > 0) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_FAILED', message: errors.join('; ') },
      });
      return;
    }

    // Use secrets from the worker (which got them from the agent's encrypted config)
    const secrets: SecretStore = reqSecrets ?? {};

    const result = await executeTool(tool, args, secrets);

    res.json({
      success: result.success,
      data: result,
    });
  } catch (e: any) {
    next(e);
  }
});

// ── POST /api/v1/tools/error-logs ──────────────────────────────────────────
// Agent reports a failed tool execution (HTTP error, timeout, network error).

toolsRouter.post('/error-logs', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const entry = reportToolError(z.object({
      agentId: z.string(),
      agentName: z.string(),
      toolName: z.string(),
      toolType: z.string(),
      url: z.string(),
      method: z.string(),
      statusCode: z.number().nullable(),
      error: z.string(),
      requestInput: z.string().default(''),
      responseOutput: z.string().default(''),
      durationMs: z.number().default(0),
    }).parse(req.body));
    res.json({ success: true, data: entry } satisfies ApiResponse);
  } catch (e: any) {
    next(e);
  }
});

// ── GET /api/v1/tools/error-logs ───────────────────────────────────────────
// Owner views error logs, optionally filtered by agentId.

toolsRouter.get('/error-logs', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const agentId = req.query.agentId as string | undefined;

    // Authorization: if querying a specific agent, verify the caller owns it.
    if (agentId) {
      const agent = await getAgent(agentId);
      if (!agent) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Agent not found' } });
        return;
      }
      const caller = req.user!.address.toLowerCase();
      const ownerSet = new Set([agent.ownerAddress, ...(agent.authorizedOwners ?? [])].map(a => a.toLowerCase()));
      if (!ownerSet.has(caller)) {
        res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Only the agent owner can view error logs' } });
        return;
      }
    }

    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
    const result = getToolErrorLogs({ agentId, limit, offset });
    res.json({ success: true, data: result } satisfies ApiResponse);
  } catch (e: any) {
    next(e);
  }
});

// ── DELETE /api/v1/tools/error-logs ────────────────────────────────────────
// Clear error logs (optionally for a specific agent).

toolsRouter.delete('/error-logs', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const agentId = (req.body as any)?.agentId as string | undefined;

    // Authorization: if clearing a specific agent's logs, verify the caller owns it.
    if (agentId) {
      const agent = await getAgent(agentId);
      if (!agent) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Agent not found' } });
        return;
      }
      const caller = req.user!.address.toLowerCase();
      const ownerSet = new Set([agent.ownerAddress, ...(agent.authorizedOwners ?? [])].map(a => a.toLowerCase()));
      if (!ownerSet.has(caller)) {
        res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Only the agent owner can clear error logs' } });
        return;
      }
    }

    const cleared = clearToolErrorLogs(agentId);
    res.json({ success: true, data: { cleared } } satisfies ApiResponse);
  } catch (e: any) {
    next(e);
  }
});
