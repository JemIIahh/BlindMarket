/**
 * Phase A (outbound) CCTP routes — an agent owner withdraws Base USDC to
 * another EVM chain via Circle CCTP V2, instead of only sweeping back to the
 * same address on the same chain (that's the existing POST /:id/withdraw in
 * routes/agents.ts). Deliberately a SEPARATE route, not a field bolted onto
 * /withdraw: CCTP is an async, multi-minute pipeline needing a pollable
 * `transferId`, which doesn't fit /withdraw's synchronous sweep-and-return
 * contract. See the CCTP plan for the full design rationale.
 *
 * Mounted at the same /api/v1/agents prefix as agents.ts (same pattern as
 * a2a.ts/sandbox.ts/skills.ts being separate router files on shared prefixes).
 */
import { Router } from 'express';
import { z } from 'zod';
import { ethers } from 'ethers';
import type { AuthRequest } from '../types.js';
import { requireAuth } from '../middleware/auth.js';
import { authorizeOwner } from './agents.js';
import { config } from '../config.js';
import {
  isCctpConfigured,
  isSupportedCctpChain,
  getCctpChain,
  getBaseCctpChain,
  supportedCctpChains,
} from '../services/cctpChains.js';
import {
  ERC20_ABI,
  executeDepositForBurn,
  estimateMaxFeeRaw,
  FAST_TRANSFER_FINALITY_THRESHOLD,
} from '../services/cctp.js';
import {
  createTransfer,
  getByIdempotencyKey,
  listForAgent,
  getById,
  updateTransfer,
  serializeTransfer,
} from '../services/cctpTransferStore.js';

export const agentsCctpRouter = Router();

// Conservative starting estimate for a depositForBurn call's gas on Base —
// same "not yet calibrated against real observed Base gas costs" caveat as
// WITHDRAW_CHAINS.base.nativeGasMin in routes/agents.ts (a burn call does a
// bit more work than a plain ERC20 transfer, hence the higher floor here).
const CCTP_BASE_GAS_MIN = ethers.parseEther('0.0002');

const WithdrawBodySchema = z.object({
  destinationChain: z.string().min(1),
  amountRaw: z.string().regex(/^\d+$/).optional(),
  mintRecipient: z.string().optional(),
  idempotencyKey: z.string().min(1).max(200),
});

// POST /api/v1/agents/:id/cctp/withdraw
agentsCctpRouter.post('/:id/cctp/withdraw', requireAuth, async (req: AuthRequest, res) => {
  try {
    if (!config.cctp.enabled || !isCctpConfigured()) {
      res.status(400).json({ success: false, error: { code: 'CCTP_DISABLED', message: 'CCTP is not enabled on this deployment' } });
      return;
    }

    const agent = await authorizeOwner(req, res, req.params.id);
    if (!agent) return;

    const parsed = WithdrawBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
      return;
    }
    const { destinationChain, amountRaw, mintRecipient, idempotencyKey } = parsed.data;

    // Idempotent replay: same key returns the existing row's current state
    // rather than re-attempting (and never re-broadcasting) the burn.
    const existing = await getByIdempotencyKey(idempotencyKey);
    if (existing) {
      res.status(200).json({ success: true, data: serializeTransfer(existing) });
      return;
    }

    if (agent.status === 'running') {
      res.status(409).json({ success: false, error: { code: 'AGENT_RUNNING', message: 'Stop the agent before a CCTP withdrawal — bridging out from a running agent can race with in-flight settlement transactions' } });
      return;
    }
    if (!agent.rawPrivateKey) {
      res.status(409).json({ success: false, error: { code: 'NO_KEY', message: 'Agent has no raw private key on record; cannot sign the CCTP burn' } });
      return;
    }
    if (!isSupportedCctpChain(destinationChain)) {
      res.status(400).json({ success: false, error: { code: 'CCTP_UNSUPPORTED_CHAIN', message: `${destinationChain} is not a supported CCTP destination`, details: { supported: supportedCctpChains().map((c) => c.chainKey) } } });
      return;
    }

    const source = getBaseCctpChain();
    const dest = getCctpChain(destinationChain);
    if (!source || !dest) {
      res.status(400).json({ success: false, error: { code: 'CCTP_DISABLED', message: 'CCTP chain configuration is incomplete' } });
      return;
    }
    if (dest.chainKey === source.chainKey) {
      res.status(400).json({ success: false, error: { code: 'CCTP_SAME_CHAIN', message: 'destinationChain must differ from the Base leg' } });
      return;
    }

    const resolvedRecipient = mintRecipient ?? agent.ownerAddress;
    try {
      ethers.getAddress(resolvedRecipient);
    } catch {
      res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'mintRecipient must be a valid address' } });
      return;
    }

    const pk = agent.rawPrivateKey.startsWith('0x') ? agent.rawPrivateKey : `0x${agent.rawPrivateKey}`;
    const wallet = new ethers.Wallet(pk, source.rpc);

    const nativeBalance = await source.rpc.getBalance(wallet.address);
    if (nativeBalance < CCTP_BASE_GAS_MIN) {
      res.status(400).json({ success: false, error: { code: 'CCTP_INSUFFICIENT_GAS', message: `Agent's Base wallet needs at least ${ethers.formatEther(CCTP_BASE_GAS_MIN)} ETH to pay for the burn transaction (has ${ethers.formatEther(nativeBalance)})` } });
      return;
    }

    const usdc = new ethers.Contract(source.usdcAddress, ERC20_ABI, source.rpc);
    const usdcBalance: bigint = await usdc.balanceOf(wallet.address);
    let amount: bigint;
    if (amountRaw) {
      amount = BigInt(amountRaw);
      if (amount > usdcBalance) {
        res.status(409).json({ success: false, error: { code: 'CCTP_INSUFFICIENT_USDC', message: `Requested ${amountRaw} exceeds the agent's Base USDC balance (${usdcBalance.toString()})` } });
        return;
      }
    } else {
      amount = usdcBalance;
    }
    if (amount <= 0n) {
      res.status(409).json({ success: false, error: { code: 'CCTP_INSUFFICIENT_USDC', message: 'Agent has no Base USDC to withdraw' } });
      return;
    }

    let maxFeeRaw: bigint;
    try {
      maxFeeRaw = await estimateMaxFeeRaw(config.cctp.irisApiBase, source.domain, dest.domain, amount, FAST_TRANSFER_FINALITY_THRESHOLD);
    } catch (e) {
      res.status(502).json({ success: false, error: { code: 'CCTP_FEE_QUOTE_FAILED', message: `Could not get a Fast Transfer fee quote from Circle: ${(e as Error).message}` } });
      return;
    }
    if (maxFeeRaw >= amount) {
      res.status(409).json({ success: false, error: { code: 'CCTP_INSUFFICIENT_USDC', message: 'Amount is too small to cover the CCTP Fast Transfer fee' } });
      return;
    }

    const row = await createTransfer({
      idempotencyKey,
      direction: 'outbound',
      agentId: agent.id,
      ownerAddress: agent.ownerAddress,
      sourceChain: source.chainKey,
      sourceDomain: source.domain,
      destChain: dest.chainKey,
      destDomain: dest.domain,
      usdcAmountRaw: amount.toString(),
      mintRecipient: resolvedRecipient,
      maxFeeRaw: maxFeeRaw.toString(),
      minFinalityThreshold: FAST_TRANSFER_FINALITY_THRESHOLD,
      relayMethod: 'forwarding_service',
    });

    let burnTxHash: string;
    try {
      const result = await executeDepositForBurn(source, wallet, {
        amountRaw: amount,
        destinationDomain: dest.domain,
        mintRecipient: resolvedRecipient,
        maxFeeRaw,
        minFinalityThreshold: FAST_TRANSFER_FINALITY_THRESHOLD,
      });
      burnTxHash = result.txHash;
    } catch (e) {
      await updateTransfer(row.id, { stage: 'failed', error_message: (e as Error).message });
      res.status(502).json({ success: false, error: { code: 'CCTP_BURN_FAILED', message: `Failed to submit the CCTP burn: ${(e as Error).message}` } });
      return;
    }

    // Persist the hash BEFORE anything else — this is the crash-safety
    // checkpoint. If the process dies here, the poller resumes from
    // 'burn_submitted' using this hash rather than re-broadcasting.
    const updated = await updateTransfer(row.id, { stage: 'burn_submitted', burn_tx_hash: burnTxHash });

    res.status(200).json({ success: true, data: serializeTransfer(updated) });
  } catch (e) {
    console.error('[cctp] withdraw error:', (e as Error).message);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: (e as Error).message } });
  }
});

// GET /api/v1/agents/:id/cctp/transfers/:transferId
agentsCctpRouter.get('/:id/cctp/transfers/:transferId', requireAuth, async (req: AuthRequest, res) => {
  const agent = await authorizeOwner(req, res, req.params.id);
  if (!agent) return;

  const transferId = Number(req.params.transferId);
  const row = Number.isFinite(transferId) ? await getById(transferId) : null;
  if (!row || row.agent_id !== agent.id) {
    res.status(404).json({ success: false, error: { code: 'CCTP_TRANSFER_NOT_FOUND', message: 'Transfer not found' } });
    return;
  }
  res.status(200).json({ success: true, data: serializeTransfer(row) });
});

// GET /api/v1/agents/:id/cctp/transfers
agentsCctpRouter.get('/:id/cctp/transfers', requireAuth, async (req: AuthRequest, res) => {
  const agent = await authorizeOwner(req, res, req.params.id);
  if (!agent) return;

  const rows = await listForAgent(agent.id);
  res.status(200).json({ success: true, data: rows.map(serializeTransfer) });
});
