import { Router } from 'express';
import * as a2aStore from '../services/a2aStore.js';
import type { ApiResponse } from '../types.js';

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
      res.json(rpcSuccess(id, { meta, state }));
      break;
    }

    case 'tasks/list': {
      const tasks = await a2aStore.browseAgentTasks();
      res.json(rpcSuccess(id, { tasks, total: tasks.length }));
      break;
    }

    case 'tasks/cancel': {
      const taskId = params?.taskId as string;
      if (!taskId) {
        res.json(rpcError(id, -32602, 'Missing taskId param'));
        return;
      }
      const state = await a2aStore.getState(taskId);
      if (!state) {
        res.json(rpcError(id, -32001, 'Task not found'));
        return;
      }
      if (state.status === 'completed' || state.status === 'verified') {
        res.json(rpcError(id, -32003, 'Cannot cancel completed task'));
        return;
      }
      await a2aStore.updateState(taskId, { status: 'failed' });
      res.json(rpcSuccess(id, { taskId, status: 'failed' }));
      break;
    }

    default:
      res.json(rpcError(id, -32601, `Method not found: ${method}`));
  }
});
