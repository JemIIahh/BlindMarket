import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireFounder } from '../middleware/auth.js';
import type { AuthRequest } from '../types.js';
import * as stakingService from '../services/stakingService.js';
import * as accountingService from '../services/accountingService.js';
import { pricingUnit } from '../services/settlementUnits.js';

export const stakingRouter = Router();

const stakeSchema = z.object({
  taskId: z.string().min(1),
  taskReward: z.number().positive(),
});

const taskIdSchema = z.object({
  taskId: z.string().min(1),
});

// POST /api/v1/staking/stake
stakingRouter.post('/stake', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { taskId, taskReward } = stakeSchema.parse(req.body);
    const worker = req.user!.address;
    const stake = await stakingService.lockStake(worker, taskId, taskReward);

    accountingService.recordTransaction({
      address: worker,
      role: 'worker',
      taskId,
      type: 'stake',
      unit: pricingUnit().symbol,
      amount: stake.stake_amount,
    });

    res.status(201).json({ success: true, data: stake });
  } catch (err: any) {
    if (err?.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: err.errors?.[0]?.message || 'Invalid input' },
      });
    }
    next(err);
  }
});

// POST /api/v1/staking/release
// Adjudication action (returns a worker's stake) — founder/admin only. A worker
// must not be able to release or slash stakes at will.
stakingRouter.post('/release', requireAuth, requireFounder, async (req: AuthRequest, res, next) => {
  try {
    const { taskId } = taskIdSchema.parse(req.body);
    const stake = await stakingService.releaseStake(taskId);
    if (!stake) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'No locked stake found for this task' },
      });
    }

    accountingService.recordTransaction({
      address: stake.worker,
      role: 'worker',
      taskId,
      type: 'stake_return',
      unit: pricingUnit().symbol,
      amount: stake.stake_amount,
    });

    res.json({ success: true, data: stake });
  } catch (err: any) {
    if (err?.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: err.errors?.[0]?.message || 'Invalid input' },
      });
    }
    next(err);
  }
});

// POST /api/v1/staking/slash
// Adjudication action (slashes a worker's stake) — founder/admin only.
stakingRouter.post('/slash', requireAuth, requireFounder, async (req: AuthRequest, res, next) => {
  try {
    const { taskId } = taskIdSchema.parse(req.body);
    const stake = await stakingService.slashStake(taskId);
    if (!stake) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'No locked stake found for this task' },
      });
    }

    accountingService.recordTransaction({
      address: stake.worker,
      role: 'worker',
      taskId,
      type: 'slash',
      unit: pricingUnit().symbol,
      amount: stake.stake_amount,
    });

    res.json({ success: true, data: stake });
  } catch (err: any) {
    if (err?.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: err.errors?.[0]?.message || 'Invalid input' },
      });
    }
    next(err);
  }
});

// GET /api/v1/staking/:address
stakingRouter.get('/:address', async (req, res, next) => {
  try {
    const address = req.params.address;
    const stakes = await stakingService.getWorkerStakes(address);
    const summary = await stakingService.getStakeSummary(address);
    res.json({ success: true, data: { stakes, summary } });
  } catch (err) {
    next(err);
  }
});
