import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { createUserRateLimiter } from '../middleware/rateLimit.js';
import { AppError } from '../middleware/errorHandler.js';
import { avatarConfigSchema, getAvatar, setAvatar } from '../services/avatarStore.js';
import type { AuthRequest, ApiResponse } from '../types.js';

/**
 * A person's public profile. For now that is only their avatar: the face shown
 * on the tasks they post (services/avatarStore.ts).
 *
 * There is deliberately no "avatar by address" lookup, and nothing is saved
 * under the account's other linked wallets: others see a face only on the
 * tasks it was posted with (posterAvatar on the task routes).
 */
export const profileRouter = Router();

const saveAvatarSchema = z.object({ avatar: avatarConfigSchema }).strict();
const saveLimiter = createUserRateLimiter(20);

/** The address the caller's tasks are posted from (what /tasks/index records
 *  as posterAddress), or a 403 for a session without one (the legacy shared
 *  agent key). */
function postingAddress(req: AuthRequest): string {
  const address = req.user?.address;
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new AppError(403, 'NO_WALLET', 'This session has no wallet to attach an avatar to');
  }
  return address.toLowerCase();
}

/**
 * GET /api/v1/profile/avatar
 * The caller's own avatar (null when they never made one), and the address
 * their tasks are posted from, which is what a default face is drawn from.
 */
profileRouter.get('/avatar', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const address = postingAddress(req);
    const avatar = await getAvatar(address);
    const body: ApiResponse = { success: true, data: { avatar, address } };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/v1/profile/avatar  { avatar }
 * Saves the caller's avatar under their posting address, and only that one:
 * nothing in the request names an address. `{ avatar: {} }` removes it.
 */
profileRouter.put('/avatar', requireAuth, saveLimiter, async (req: AuthRequest, res, next) => {
  try {
    const address = postingAddress(req);
    const { avatar } = saveAvatarSchema.parse(req.body);
    await setAvatar(address, avatar);
    const saved = Object.keys(avatar).length > 0 ? avatar : null;
    const body: ApiResponse = { success: true, data: { avatar: saved, address } };
    res.json(body);
  } catch (err) {
    next(err);
  }
});
