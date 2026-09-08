import { Router } from 'express';
import * as a2aStore from '../services/a2aStore.js';

export const a2aProtocolRouter = Router();

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function rpcSuccess(id: string | number, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * POST /a2a/v1
 * JSON-RPC 2.0 endpoint for A2A protocol.
 */
a2aProtocolRouter.post('/', async (req, res) => {
  const body = req.body as JsonRpcRequest;

  if (!body || body.jsonrpc !== '2.0' || !body.method || !body.id) {
    res.json(rpcError(body?.id ?? 0, -32600, 'Invalid JSON-RPC request'));
    return;
  }

  const { id, method, params } = body;

  switch (method) {
    case 'message/send': {
      // Create or update a task message — for now, acknowledge receipt
      const taskId = params?.taskId as string;
      if (!taskId) {
        res.json(rpcError(id, -32602, 'Missing taskId param'));
        return;
      }
      const state = await a2aStore.getState(taskId);
      res.json(rpcSuccess(id, {
        taskId,
        status: state?.status ?? 'unknown',
        message: 'Message received',
      }));
      break;
    }

    case 'tasks/get': {
      const taskId = params?.taskId as string;
      if (!taskId) {
        res.json(rpcError(id, -32602, 'Missing taskId param'));
        return;
      }
      const meta = await a2aStore.getMeta(taskId);
      const state = await a2aStore.getState(taskId);
      if (!meta) {
        res.json(rpcError(id, -32001, 'Task not found'));
        return;
      }
      // Public projection: this surface is unauthenticated, so key material
      // (wrappedKeys / keyCustodyBlob / rootHash) must never appear here, and
      // operator-internal diagnostics (assignError/verifyError revert strings)
      // are stripped from state. An accepted executor gets its slice from the
      // authenticated REST /accept.
      res.json(rpcSuccess(id, {
        meta: a2aStore.projectPublicMeta(meta),
        state: state ? a2aStore.projectPublicState(state) : null,
      }));
      break;
    }

    case 'tasks/list': {
      const limit = Math.min(Math.max(Number(params?.limit) || 100, 1), 200);
      const offset = Math.max(Number(params?.offset) || 0, 0);
      const matches = await a2aStore.browseAgentTasks();
      const tasks = matches.slice(offset, offset + limit).map(a2aStore.projectPublicEntry);
      res.json(rpcSuccess(id, { tasks, total: matches.length, offset, limit }));
      break;
    }

    case 'tasks/cancel': {
      // Removed: this endpoint has no authentication, so a cancel here was an
      // anonymous kill switch on any live task — there is no way to establish
      // ownership on this surface. Lifecycle mutations live on the
      // authenticated REST API: posters cancel Funded tasks on-chain via
      // cancelTask; executors/posters revert a stuck assignment via
      // POST /api/v1/a2a/tasks/:id/release.
      res.json(rpcError(
        id,
        -32601,
        'tasks/cancel is not available on the public A2A surface — use the authenticated REST API (POST /api/v1/a2a/tasks/:id/release) or cancelTask on-chain',
      ));
      break;
    }

    default:
      res.json(rpcError(id, -32601, `Method not found: ${method}`));
  }
});
