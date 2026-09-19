import { Router } from 'express';
import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { provider, buildUnsignedTx } from '../services/chain.js';
import { rooms } from '../services/socket.js';
import type { AuthRequest, ApiResponse } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const abi = JSON.parse(readFileSync(join(__dirname, '../abi/ValidatorPool.json'), 'utf-8')).abi;

// A zero address means "not deployed on this stack" (see DEPLOYMENT_SET_REQUIRED_ENV).
const VALIDATOR_POOL_ADDRESS = /^0x0{40}$/i.test(process.env.VALIDATOR_POOL_ADDRESS ?? '')
  ? ''
  : process.env.VALIDATOR_POOL_ADDRESS || '';

function getContract() {
  if (!VALIDATOR_POOL_ADDRESS) throw new AppError(503, 'NOT_CONFIGURED', 'ValidatorPool not deployed');
  return new ethers.Contract(VALIDATOR_POOL_ADDRESS, abi, provider);
}

export const validatorsRouter = Router();

/** GET /api/v1/validators/:address — get validator info */
validatorsRouter.get('/:address', async (req, res, next) => {
  try {
    const contract = getContract();
    const val = await contract.validators(req.params.address);
    res.json({ success: true, data: {
      stake: val.stake.toString(),
      active: val.active,
      totalVotes: Number(val.totalVotes),
      correctVotes: Number(val.correctVotes),
    }} satisfies ApiResponse);
  } catch (err) { next(err); }
});

/** GET /api/v1/validators/disputes/:disputeId — get dispute info */
validatorsRouter.get('/disputes/:disputeId', async (req, res, next) => {
  try {
    const contract = getContract();
    const d = await contract.getDispute(req.params.disputeId);
    res.json({ success: true, data: {
      taskId: d.taskId.toString(),
      escrow: d.escrow,
      amount: d.amount.toString(),
      openedAt: Number(d.openedAt),
      finalized: d.finalized,
      workerFavored: d.workerFavored,
      workerVotes: Number(d.workerVotes),
      agentVotes: Number(d.agentVotes),
    }} satisfies ApiResponse);
  } catch (err) { next(err); }
});

/** POST /api/v1/validators/register — build unsigned stake tx */
validatorsRouter.post('/register', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { amount } = req.body as { amount?: string };
    if (!amount) throw new AppError(400, 'MISSING_FIELDS', 'amount required');
    const contract = getContract();
    const tx = await buildUnsignedTx(contract, 'register', [BigInt(amount)], req.user!.address);
    res.json({ success: true, data: { unsignedTx: tx } } satisfies ApiResponse);
  } catch (err) { next(err); }
});

/** POST /api/v1/validators/unstake — build unsigned unstake tx */
validatorsRouter.post('/unstake', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const contract = getContract();
    const tx = await buildUnsignedTx(contract, 'unstake', [], req.user!.address);
    res.json({ success: true, data: { unsignedTx: tx } } satisfies ApiResponse);
  } catch (err) { next(err); }
});

/** POST /api/v1/validators/vote — build unsigned vote tx */
validatorsRouter.post('/vote', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { disputeId, vote } = req.body as { disputeId?: string; vote?: number };
    if (!disputeId || vote === undefined) throw new AppError(400, 'MISSING_FIELDS', 'disputeId and vote required');
    if (vote !== 1 && vote !== 2) throw new AppError(400, 'INVALID_VOTE', 'vote must be 1 (worker) or 2 (agent)');
    const contract = getContract();
    const tx = await buildUnsignedTx(contract, 'vote', [BigInt(disputeId), vote], req.user!.address);
    rooms.disputes('dispute:voted', { disputeId, vote, voter: req.user!.address });
    res.json({ success: true, data: { unsignedTx: tx } } satisfies ApiResponse);
  } catch (err) { next(err); }
});

/** POST /api/v1/validators/finalize — build unsigned finalize tx */
validatorsRouter.post('/finalize', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { disputeId } = req.body as { disputeId?: string };
    if (!disputeId) throw new AppError(400, 'MISSING_FIELDS', 'disputeId required');
    const contract = getContract();
    const tx = await buildUnsignedTx(contract, 'finalizeDispute', [BigInt(disputeId)], req.user!.address);
    rooms.disputes('dispute:finalized', { disputeId });
    rooms.platform('stats:update', {});
    res.json({ success: true, data: { unsignedTx: tx } } satisfies ApiResponse);
  } catch (err) { next(err); }
});
