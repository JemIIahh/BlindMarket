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

// `content` is what @blindmarket/sdk's sendMessage (and so the MCP
// send_message tool) sends: accepted as `body`, so those clients work without
// a republish. Every one of their sends used to fail validation here.
const sendSchema = z
  .object({
    to: z.string().min(1),
    taskId: z.string().optional(),
    subject: z.string().max(200).optional(),
    body: z.string().min(1).max(5000).optional(),
    content: z.string().min(1).max(5000).optional(),
  })
  .refine((m) => m.body !== undefined || m.content !== undefined, { message: 'body is required', path: ['body'] })
  .transform(({ content, body, ...rest }) => ({ ...rest, body: (body ?? content) as string }));

async function ownsAgent(owner: string, agentWallet: string): Promise<boolean> {
  const agent = await loadAgentByWallet(agentWallet).catch(() => null);
  return agent?.ownerAddress?.toLowerCase() === owner;
}

/** A deployed agent and its own deployer, in either direction. */
async function isOwnerAgentPair(a: string, b: string): Promise<boolean> {
  return (await ownsAgent(a, b)) || (await ownsAgent(b, a));
}

/**
 * A task-scoped message must stay between the task's two parties. Without
 * this, any authenticated caller could drop text into any agent's inbox under
 * a real taskId — and a working agent reads its task thread as instructions.
 * Allowed: poster ↔ executor, or an agent ↔ its own deployer. The owner pair
 * does not depend on party status: a released task clears executorAddress, and
 * an owner replying on that thread from the UI (which re-sends the message's
 * taskId) must still reach their own agent. An owner already controls their
 * agent, so this opens nothing.
 */
async function isTaskPartyPair(from: string, to: string, poster?: string, executor?: string): Promise<boolean> {
  const parties = [poster?.toLowerCase(), executor?.toLowerCase()].filter((a): a is string => !!a);
  if (parties.includes(from) && parties.includes(to)) return from !== to;
  return isOwnerAgentPair(from, to);
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

    // No taskId: the same injection path, minus the task. A deployed agent's
    // inbox only takes direct messages from its own deployer — everything else
    // it legitimately receives is task-scoped (checked above). Messages to
    // non-agent addresses (an agent writing to its owner, human ↔ human) are
    // unaffected. Fails closed: an unreadable agent table must not open the gate.
    if (!taskId && !viaOwnerShortcut) {
      let recipientAgent: Awaited<ReturnType<typeof loadAgentByWallet>>;
      try {
        recipientAgent = await loadAgentByWallet(resolvedTo);
      } catch (lookupErr) {
        console.warn('[messages] recipient agent lookup failed:', (lookupErr as Error).message);
        res.status(503).json({ success: false, error: { code: 'RECIPIENT_CHECK_FAILED', message: 'Could not verify the recipient — retry shortly' } });
        return;
      }
      if (recipientAgent && recipientAgent.ownerAddress?.toLowerCase() !== from.toLowerCase()) {
        res.status(403).json({ success: false, error: { code: 'NOT_AGENT_OWNER', message: 'Only an agent’s owner can message it without a taskId — include the taskId of a task you share with it' } });
        return;
      }
    }

    const msg = await messageStore.sendMessage({ from, to: resolvedTo, taskId, subject, body });

    // Fire webhook for incoming message to an agent (non-blocking)
    try {
      const { fireWebhooks } = await import('../services/webhookStore.js');
      fireWebhooks(resolvedTo, 'message_received', { from, taskId, subject }).catch(() => {});
    } catch { /* webhook module optional */ }

    // Notify via Socket.IO for real-time UI updates. 'platform' is a public room
    // any socket can join, so this is a bare change ping: listeners refetch the
    // viewer's own inbox. Sending { to, from, taskId } here told anonymous
    // listeners who messaged whom, when, about which task (security audit run
    // 1, C26).
    try {
      emit('platform', 'message:new', {});
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
