import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import type { AuthRequest, ApiResponse } from '../types.js';
import * as notifications from '../services/notificationStore.js';

export const notificationsRouter = Router();

/**
 * GET /api/v1/notifications
 * The event diary: this wallet's task-lifecycle notifications, newest first.
 */
notificationsRouter.get('/', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 30));
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
    const data = await notifications.listNotifications(req.user!.address, limit, offset);
    res.json({ success: true, data } as ApiResponse);
  } catch (err) { next(err); }
});

/** GET /api/v1/notifications/unread-count — cheap poll for the header bell. */
notificationsRouter.get('/unread-count', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { unread } = await notifications.listNotifications(req.user!.address, 1, 0);
    res.json({ success: true, data: { unread } } as ApiResponse);
  } catch (err) { next(err); }
});

/** POST /api/v1/notifications/read-all */
notificationsRouter.post('/read-all', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const marked = await notifications.markAllRead(req.user!.address);
    res.json({ success: true, data: { marked } } as ApiResponse);
  } catch (err) { next(err); }
});

/** POST /api/v1/notifications/:id/read */
notificationsRouter.post('/:id/read', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const ok = await notifications.markRead(req.user!.address, req.params.id);
    res.json({ success: true, data: { marked: ok } } as ApiResponse);
  } catch (err) { next(err); }
});
