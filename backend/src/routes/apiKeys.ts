import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createApiKey, listApiKeys, revokeApiKey } from '../services/apiKeyStore.js';
import type { AuthRequest } from '../types.js';

export const apiKeysRouter = Router();

apiKeysRouter.use(requireAuth);

/**
 * POST /api/v1/api-keys
 * Create a new API key.
 */
apiKeysRouter.post('/', async (req: AuthRequest, res) => {
  const { name, capabilities, agentAddress } = req.body as {
    name?: string;
    capabilities?: string[];
    agentAddress?: string;
  };
  if (!name || typeof name !== 'string') {
    throw new AppError(400, 'MISSING_NAME', 'API key name is required');
  }

  const result = await createApiKey({
    ownerAddress: req.user!.address,
    name,
    capabilities,
    agentAddress,
  });

  res.json({ success: true, data: result });
});

/**
 * GET /api/v1/api-keys
 * List active API keys for the authenticated user.
 */
apiKeysRouter.get('/', async (req: AuthRequest, res) => {
  const keys = await listApiKeys(req.user!.address);
  res.json({ success: true, data: keys });
});

/**
 * GET /api/v1/api-keys/whoami
 * The wallet identity this credential resolves to. Lets MCP servers / SDK
 * clients sanity-check at boot that their API key's owner wallet matches
 * their local signing wallet — mismatches surface later as the confusing
 * NOT_TASK_AGENT rejection at /a2a/tasks/index. Returns only the caller's
 * own identity, nothing else.
 */
apiKeysRouter.get('/whoami', async (req: AuthRequest, res) => {
  res.json({
    success: true,
    data: { address: req.user!.address, addresses: req.user!.addresses ?? [req.user!.address] },
  });
});

/**
 * DELETE /api/v1/api-keys/:id
 * Revoke an API key.
 */
apiKeysRouter.delete('/:id', async (req: AuthRequest, res) => {
  const keyId = parseInt(req.params.id, 10);
  if (isNaN(keyId)) {
    throw new AppError(400, 'INVALID_ID', 'Invalid key ID');
  }

  const revoked = await revokeApiKey(keyId, req.user!.address);
  if (!revoked) {
    throw new AppError(404, 'NOT_FOUND', 'Key not found or already revoked');
  }

  res.json({ success: true, data: { revoked: true } });
});
