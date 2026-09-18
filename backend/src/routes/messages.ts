import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import type { AuthRequest } from '../types.js';
import * as messageStore from '../services/messageStore.js';
import * as a2aStore from '../services/a2aStore.js';
import { loadAgentByWallet } from '../services/deployedAgentStore.js';
import { emit } from '../services/socket.js';
import type { ApiResponse } from '../types.js';

export const messagesRouter = Router();

const sendSchema = z.object({
  to: z.string().min(1),
  taskId: z.string().optional(),
  subject: z.string().max(200).optional(),
  body: z.string().min(1).max(5000),
});

async function ownsAgent(owner: string, agentWallet: string): Promise<boolean> {
  const agent = await loadAgentByWallet(agentWallet).catch(() => null);
  return agent?.ownerAddress?.toLowerCase() === owner;
}

/**
 * A task-scoped message must stay between the task's two parties. Without
 * this, any authenticated caller could drop text into any agent's inbox under
 * a real taskId — and a working agent reads its task thread as instructions.
 * Allowed: poster ↔ executor, or a party agent ↔ its own deployer (owners
 * follow up on their agent's task threads).
 */
async function isTaskPartyPair(from: string, to: string, poster?: string, executor?: string): Promise<boolean> {
  const parties = [poster?.toLowerCase(), executor?.toLowerCase()].filter((a): a is string => !!a);
  const fromIsParty = parties.includes(from);
  const toIsParty = parties.includes(to);
  if (fromIsParty && toIsParty) return from !== to;
  if (fromIsParty) return ownsAgent(to, from);
  if (toIsParty) return ownsAgent(from, to);
  return false;
}

/**
 * POST /api/v1/messages/send
 * Send a message from the authenticated user to another address.
 */
messagesRouter.post('/send', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const from = req.user!.address;
    const { to, taskId, subject, body } = sendSchema.parse(req.body);

    let resolvedTo = to.toLowerCase();
    const viaOwnerShortcut = resolvedTo === 'creator' || resolvedTo === 'owner';

    // Auto-resolve shortcuts
    if (resolvedTo === 'poster' || resolvedTo === 'agent') {
      if (!taskId) {
        res.status(400).json({ success: false, error: { code: 'TASK_REQUIRED', message: 'taskId is required when using poster/agent shortcuts' } });
        return;
      }
      const state = await a2aStore.getState(taskId);
      if (!state) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Task not found' } });
        return;
      }
      if (resolvedTo === 'poster') {
        const meta = await a2aStore.getMeta(taskId);
        resolvedTo = meta?.posterAddress?.toLowerCase() ?? '';
        if (!resolvedTo) {
          res.status(400).json({ success: false, error: { code: 'NO_POSTER', message: 'Task poster address not found' } });
          return;
        }
      } else {
        resolvedTo = state.executorAddress?.toLowerCase() ?? '';
        if (!resolvedTo) {
          res.status(400).json({ success: false, error: { code: 'NO_AGENT', message: 'No agent assigned to this task yet' } });
          return;
        }
      }
    } else if (viaOwnerShortcut) {
      // Resolve from agent's platform token JWT (ownerAddress claim)
      resolvedTo = req.user?.ownerAddress?.toLowerCase() ?? '';
      if (!resolvedTo) {
        res.status(400).json({ success: false, error: { code: 'NO_OWNER', message: 'No creator/owner address available — not authenticated as a deployed agent' } });
        return;
      }
    }

    if (!resolvedTo || resolvedTo.length < 42) {
      res.status(400).json({ success: false, error: { code: 'BAD_ADDRESS', message: 'Invalid recipient address' } });
      return;
    }

    // The creator/owner shortcut is exempt: its recipient comes from the
    // caller's own token, not from the request.
    if (taskId && !viaOwnerShortcut) {
      const [meta, state] = await Promise.all([a2aStore.getMeta(taskId), a2aStore.getState(taskId)]);
      if (!meta && !state) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Task not found' } });
        return;
      }
      if (!(await isTaskPartyPair(from.toLowerCase(), resolvedTo, meta?.posterAddress, state?.executorAddress))) {
        res.status(403).json({ success: false, error: { code: 'NOT_TASK_PARTY', message: 'Task messages can only be exchanged between the task poster and its assigned executor' } });
        return;
      }
    }

    const msg = await messageStore.sendMessage({ from, to: resolvedTo, taskId, subject, body });

    // Fire webhook for incoming message to an agent (non-blocking)
    try {
      const { fireWebhooks } = await import('../services/webhookStore.js');
      fireWebhooks(resolvedTo, 'message_received', { from, taskId, subject }).catch(() => {});
    } catch { /* webhook module optional */ }

    // Notify via Socket.IO for real-time UI updates
    try {
      emit('platform', 'message:new', { to: resolvedTo, from, taskId });
    } catch { /* socket may not be initialized */ }
    res.json({ success: true, data: msg } as ApiResponse);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/messages/inbox
 */
messagesRouter.get('/inbox', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const address = req.user!.address;
    const taskId = req.query.taskId as string | undefined;
    const unreadOnly = req.query.unreadOnly === 'true';
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);

    const result = await messageStore.getInbox(address, { taskId, unreadOnly, limit, offset });
    const unread = await messageStore.unreadCount(address);
    res.json({ success: true, data: { ...result, unread } } as ApiResponse);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/messages/sent
 */
messagesRouter.get('/sent', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const address = req.user!.address;
    const taskId = req.query.taskId as string | undefined;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);

    const result = await messageStore.getSent(address, { taskId, limit, offset });
    res.json({ success: true, data: result } as ApiResponse);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/messages/thread/:taskId/:counterparty
 */
messagesRouter.get('/thread/:taskId/:counterparty', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const address = req.user!.address;
    const { taskId, counterparty } = req.params;

    const messages = await messageStore.getThread(address, counterparty, taskId);

    // Auto-mark as read
    const unreadIds = messages
      .filter(m => m.to_address === address.toLowerCase() && !m.read_at)
      .map(m => m.id);
    if (unreadIds.length) await messageStore.markRead(address, unreadIds);

    res.json({ success: true, data: { messages, total: messages.length } } as ApiResponse);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/messages/read
 */
messagesRouter.post('/read', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const address = req.user!.address;
    const { messageIds } = req.body as { messageIds?: number[] };
    await messageStore.markRead(address, messageIds);
    const unread = await messageStore.unreadCount(address);
    res.json({ success: true, data: { unread } } as ApiResponse);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/messages/unread-count
 */
messagesRouter.get('/unread-count', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const address = req.user!.address;
    const unread = await messageStore.unreadCount(address);
    res.json({ success: true, data: { unread } } as ApiResponse);
  } catch (err) {
    next(err);
  }
});
