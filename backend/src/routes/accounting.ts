import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import type { AuthRequest } from '../types.js';
import * as accountingService from '../services/accountingService.js';
import { listAgents } from '../services/agentRunner.js';

async function resolveAddresses(ownerAddress: string): Promise<string[]> {
  const addrs = [ownerAddress.toLowerCase()];
  const agents = await listAgents(ownerAddress);
  for (const a of agents) {
    if (a.walletAddress) addrs.push(a.walletAddress.toLowerCase());
  }
  return addrs;
}

export const accountingRouter = Router();

// GET /api/v1/accounting/entries
accountingRouter.get('/entries', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const address = req.user!.address;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const type = req.query.type as string | undefined;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));

    const addresses = await resolveAddresses(address);
    const result = await accountingService.getTransactions(addresses, from, to, type, page, pageSize);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/accounting/summary
accountingRouter.get('/summary', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const address = req.user!.address;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;

    const addresses = await resolveAddresses(address);
    const summary = await accountingService.getSummary(addresses, from, to);
    res.json({ success: true, data: summary });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/accounting/export
accountingRouter.get('/export', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const address = req.user!.address;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const format = (req.query.format as string) || 'json';

    const addresses = await resolveAddresses(address);

    if (format === 'csv') {
      const csv = await accountingService.exportCsv(addresses, from, to);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=transactions.csv');
      return res.send(csv);
    }

    const result = await accountingService.getTransactions(addresses, from, to);
    res.setHeader('Content-Disposition', 'attachment; filename=transactions.json');
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});
