/**
 * Phase B (inbound) CCTP routes — a user funds their Base wallet from USDC
 * they hold on another EVM chain via Circle CCTP V2. Not agent-scoped (the
 * user funds their own wallet, not an agent's), so this mounts at a plain
 * /api/v1/cctp prefix rather than nesting under /api/v1/agents/:id like
 * routes/agentsCctp.ts (Phase A).
 *
 * The backend never signs anything for this direction — it only builds
 * unsigned calldata (reusing buildUnsignedTx from services/chain.ts, already
 * provider-agnostic) for the user's OWN external wallet to sign in the
 * browser, then independently re-derives success from the source chain's own
 * receipt at /confirm rather than trusting a client-supplied tx hash.
 */
import { Router } from 'express';
import { z } from 'zod';
import { ethers } from 'ethers';
import type { AuthRequest } from '../types.js';
import { requireAuth } from '../middleware/auth.js';
import { config } from '../config.js';
import {
  isCctpConfigured,
  isSupportedCctpChain,
  getCctpChain,
  getSettlementCctpChain,
  supportedCctpChains,
} from '../services/cctpChains.js';
import {
  ERC20_ABI,
  buildDepositForBurnCall,
  decodeDepositForBurnCalldata,
  addressToBytes32,
  estimateMaxFeeRaw,
  finalityThresholdFor,
} from '../services/cctp.js';
import {
  createTransfer,
  getByIdempotencyKey,
  getById,
  updateTransfer,
  listForOwner,
  serializeTransfer,
} from '../services/cctpTransferStore.js';
import { relayChainTable } from '../services/relayChains.js';

export const cctpRouter = Router();

// USDC's native view on a USDC-gas chain (Arc) is 18-dec; its ERC-20 view —
// and every *Raw amount in this API — is 6-dec.
const NATIVE_UNITS_PER_USDC_RAW = 10n ** 12n;

// GET /api/v1/cctp/config — public, no auth. Single source of truth for
// contract/chain config so the frontend never hardcodes addresses.
cctpRouter.get('/config', (_req, res) => {
  res.status(200).json({
    success: true,
    data: {
      enabled: config.cctp.enabled && isCctpConfigured(),
      // The settlement chain this backend's CCTP mints into / burns from. The
      // frontend hides CCTP unless this equals its own settlement chain id — a
      // mismatched deployment must fail closed, not offer mainnet chains to a
      // testnet app (or the reverse).
      network: config.cctp.mainnet ? 'mainnet' : 'testnet',
      baseChainId: getSettlementCctpChain()?.chainId ?? null,
      chains: supportedCctpChains().map((c) => ({
        chainKey: c.chainKey,
        chainId: c.chainId,
        domain: c.domain,
        usdcAddress: c.usdcAddress,
        label: c.label,
        isTestnet: c.isTestnet,
        // USDC the user must leave on this chain for gas when bridging FROM it
        // (non-zero only where gas is paid in USDC, e.g. Arc). Published here
        // so the UI knows it before any quote, and enforced by /deposit-intent
        // with this same number.
        usdcGasReserveRaw: (c.usdcGasReserveRaw ?? 0n).toString(),
        // The `chain` name POST /tx/relay-tx takes for this chain, or null
        // when the relay doesn't serve it. The fund modal relays the
        // source-chain approve+burn (USDC gas via the sponsorship ladder)
        // when the signer is the embedded wallet; external wallets always
        // sign directly.
        relayChain: relayChainTable().get(c.chainKey) ?? null,
      })),
    },
  });
});

const QuoteQuerySchema = z.object({
  sourceChain: z.string().min(1),
  destChain: z.string().min(1),
  amountRaw: z.string().regex(/^\d+$/),
});

/**
 * GET /api/v1/cctp/quote — public, no auth, no side effects (no DB row, no
 * caller identity needed). Exposes the same estimateMaxFeeRaw() used inside
 * POST /deposit-intent and POST /agents/:id/cctp/withdraw, but callable
 * up-front so the UI can show "you'll receive ~X" BEFORE the user commits to
 * a chain switch + signature, instead of only finding out the fee after
 * submitting. Safe to call on every keystroke (frontend debounces it).
 */
cctpRouter.get('/quote', async (req, res) => {
  if (!config.cctp.enabled || !isCctpConfigured()) {
    res.status(400).json({ success: false, error: { code: 'CCTP_DISABLED', message: 'CCTP is not enabled on this deployment' } });
    return;
  }
  const parsed = QuoteQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    return;
  }
  const { sourceChain, destChain, amountRaw } = parsed.data;
  if (!isSupportedCctpChain(sourceChain) || !isSupportedCctpChain(destChain)) {
    res.status(400).json({ success: false, error: { code: 'CCTP_UNSUPPORTED_CHAIN', message: 'sourceChain/destChain must be supported CCTP chains', details: { supported: supportedCctpChains().map((c) => c.chainKey) } } });
    return;
  }
  const source = getCctpChain(sourceChain);
  const dest = getCctpChain(destChain);
  if (!source || !dest) {
    res.status(400).json({ success: false, error: { code: 'CCTP_DISABLED', message: 'CCTP chain configuration is incomplete' } });
    return;
  }
  if (source.chainKey === dest.chainKey) {
    res.status(400).json({ success: false, error: { code: 'CCTP_SAME_CHAIN', message: 'sourceChain and destChain must differ' } });
    return;
  }

  const amount = BigInt(amountRaw);
  if (amount <= 0n) {
    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'amountRaw must be positive' } });
    return;
  }

  try {
    const maxFeeRaw = await estimateMaxFeeRaw(config.cctp.irisApiBase, source.domain, dest.domain, amount, finalityThresholdFor(source));
    const estimatedReceiveRaw = maxFeeRaw >= amount ? 0n : amount - maxFeeRaw;
    res.status(200).json({
      success: true,
      data: { maxFeeRaw: maxFeeRaw.toString(), estimatedReceiveRaw: estimatedReceiveRaw.toString() },
    });
  } catch (e) {
    res.status(502).json({ success: false, error: { code: 'CCTP_FEE_QUOTE_FAILED', message: `Could not get a CCTP fee quote from Circle: ${(e as Error).message}` } });
  }
});

const DepositIntentSchema = z.object({
  sourceChain: z.string().min(1),
  amountRaw: z.string().regex(/^\d+$/),
  mintRecipient: z.string().optional(),
  // The address that will actually sign the burn tx in the browser — may
  // differ from the Privy-authenticated req.user.address (an external
  // MetaMask/OKX wallet, not the embedded Base wallet). Defaults to
  // req.user.address for the common case of one address across chains.
  fromAddress: z.string().optional(),
  idempotencyKey: z.string().min(1).max(200),
});

// POST /api/v1/cctp/deposit-intent
cctpRouter.post('/deposit-intent', requireAuth, async (req: AuthRequest, res) => {
  try {
    if (!config.cctp.enabled || !isCctpConfigured()) {
      res.status(400).json({ success: false, error: { code: 'CCTP_DISABLED', message: 'CCTP is not enabled on this deployment' } });
      return;
    }
    const authed = req.user?.address;
    if (!authed || authed === 'agent') {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Sign in required' } });
      return;
    }

    const parsed = DepositIntentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
      return;
    }
    const { sourceChain, amountRaw, mintRecipient, fromAddress, idempotencyKey } = parsed.data;

    const existing = await getByIdempotencyKey(idempotencyKey);
    if (existing) {
      // Keys are unique across ALL transfers, so a replay is honoured only for
      // the caller's own row: anyone else's key must neither return their
      // transfer nor stand in for this caller's.
      const mine = new Set([authed, ...(req.user?.addresses ?? [])].map((a) => a.toLowerCase()));
      if (existing.direction !== 'inbound' || !mine.has(existing.owner_address.toLowerCase())) {
        res.status(409).json({ success: false, error: { code: 'IDEMPOTENCY_KEY_CONFLICT', message: 'This idempotencyKey is already in use — send a fresh one' } });
        return;
      }
      res.status(200).json({ success: true, data: { existing: true, transfer: serializeTransfer(existing) } });
      return;
    }

    if (!isSupportedCctpChain(sourceChain)) {
      res.status(400).json({ success: false, error: { code: 'CCTP_UNSUPPORTED_CHAIN', message: `${sourceChain} is not a supported CCTP source`, details: { supported: supportedCctpChains().map((c) => c.chainKey) } } });
      return;
    }
    const source = getCctpChain(sourceChain);
    const dest = getSettlementCctpChain();
    if (!source || !dest) {
      res.status(400).json({ success: false, error: { code: 'CCTP_DISABLED', message: 'CCTP chain configuration is incomplete' } });
      return;
    }
    if (source.chainKey === dest.chainKey) {
      res.status(400).json({ success: false, error: { code: 'CCTP_SAME_CHAIN', message: 'sourceChain must not be the settlement leg' } });
      return;
    }

    const resolvedRecipient = mintRecipient ?? authed;
    const resolvedFrom = fromAddress ?? authed;
    let recipientChecksum: string;
    let fromChecksum: string;
    try {
      recipientChecksum = ethers.getAddress(resolvedRecipient);
      fromChecksum = ethers.getAddress(resolvedFrom);
    } catch {
      res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'mintRecipient/fromAddress must be valid addresses' } });
      return;
    }

    const amount = BigInt(amountRaw);
    if (amount <= 0n) {
      res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'amountRaw must be positive' } });
      return;
    }

    const minFinalityThreshold = finalityThresholdFor(source);

    let maxFeeRaw: bigint;
    try {
      maxFeeRaw = await estimateMaxFeeRaw(config.cctp.irisApiBase, source.domain, dest.domain, amount, minFinalityThreshold);
    } catch (e) {
      res.status(502).json({ success: false, error: { code: 'CCTP_FEE_QUOTE_FAILED', message: `Could not get a CCTP fee quote from Circle: ${(e as Error).message}` } });
      return;
    }
    if (maxFeeRaw >= amount) {
      res.status(409).json({ success: false, error: { code: 'CCTP_INSUFFICIENT_USDC', message: 'Amount is too small to cover the CCTP fee' } });
      return;
    }

    // On a USDC-gas source (Arc) the approve + burn gas comes out of the SAME
    // USDC being bridged. A full-balance burn can pass the wallet's gas
    // estimate (ethers' signer estimates with no fee fields) and then revert
    // on-chain once the upfront gas deduction leaves less than `amount` — so
    // require the reserve up front. Compared in the 18-dec native view, since
    // the 6-dec ERC-20 view truncates.
    const reserveRaw = source.usdcGasReserveRaw ?? 0n;
    if (reserveRaw > 0n) {
      const nativeBalance = await source.rpc.getBalance(fromChecksum);
      if (nativeBalance < (amount + reserveRaw) * NATIVE_UNITS_PER_USDC_RAW) {
        const availableRaw = nativeBalance / NATIVE_UNITS_PER_USDC_RAW;
        const maxAmountRaw = availableRaw > reserveRaw ? availableRaw - reserveRaw : 0n;
        res.status(409).json({
          success: false,
          error: {
            code: 'CCTP_INSUFFICIENT_GAS_HEADROOM',
            message: `Keep ${ethers.formatUnits(reserveRaw, 6)} USDC on ${source.label} for network fees — you can bridge up to ${ethers.formatUnits(maxAmountRaw, 6)} USDC.`,
            details: { reserveRaw: reserveRaw.toString(), maxAmountRaw: maxAmountRaw.toString() },
          },
        });
        return;
      }
    }

    // Source-chain reads happen BEFORE createTransfer, so a refusal or an RPC
    // failure leaves no orphan 'created' row behind.
    const usdc = new ethers.Contract(source.usdcAddress, ERC20_ABI, source.rpc);
    const allowance: bigint = await usdc.allowance(fromChecksum, source.tokenMessengerAddress);

    const row = await createTransfer({
      idempotencyKey,
      direction: 'inbound',
      agentId: null,
      ownerAddress: authed,
      sourceChain: source.chainKey,
      sourceDomain: source.domain,
      destChain: dest.chainKey,
      destDomain: dest.domain,
      usdcAmountRaw: amount.toString(),
      mintRecipient: recipientChecksum,
      maxFeeRaw: maxFeeRaw.toString(),
      minFinalityThreshold,
      relayMethod: 'forwarding_service',
    });

    let approveTx: { to: string; data: string; from: string } | undefined;
    if (allowance < amount) {
      const data = usdc.interface.encodeFunctionData('approve', [source.tokenMessengerAddress, amount]);
      approveTx = { to: source.usdcAddress, data, from: fromChecksum };
    }

    const burn = buildDepositForBurnCall(source, {
      amountRaw: amount,
      destinationDomain: dest.domain,
      mintRecipient: recipientChecksum,
      maxFeeRaw,
      minFinalityThreshold,
    });
    const burnTx = { to: burn.to, data: burn.data, from: fromChecksum };

    res.status(200).json({ success: true, data: { transferId: row.id, approveTx, burnTx } });
  } catch (e) {
    console.error('[cctp] deposit-intent error:', (e as Error).message);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: (e as Error).message } });
  }
});

const ConfirmSchema = z.object({ burnTxHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) });

// POST /api/v1/cctp/deposit-intent/:transferId/confirm
cctpRouter.post('/deposit-intent/:transferId/confirm', requireAuth, async (req: AuthRequest, res) => {
  try {
    const authed = req.user?.address;
    if (!authed || authed === 'agent') {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Sign in required' } });
      return;
    }
    const parsed = ConfirmSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
      return;
    }

    const transferId = Number(req.params.transferId);
    const row = Number.isFinite(transferId) ? await getById(transferId) : null;
    if (!row || row.direction !== 'inbound' || row.owner_address !== authed.toLowerCase()) {
      res.status(404).json({ success: false, error: { code: 'CCTP_TRANSFER_NOT_FOUND', message: 'Transfer not found' } });
      return;
    }
    if (row.stage !== 'created') {
      res.status(200).json({ success: true, data: serializeTransfer(row) });
      return;
    }

    const source = getCctpChain(row.source_chain);
    if (!source) {
      res.status(400).json({ success: false, error: { code: 'CCTP_DISABLED', message: 'Source chain no longer configured' } });
      return;
    }

    const { burnTxHash } = parsed.data;
    const tx = await source.rpc.getTransaction(burnTxHash);
    if (!tx) {
      res.status(404).json({ success: false, error: { code: 'CCTP_BURN_NOT_FOUND', message: 'Transaction not found on the source chain yet — it may still be propagating, try again shortly' } });
      return;
    }
    if (!tx.to || tx.to.toLowerCase() !== source.tokenMessengerAddress.toLowerCase()) {
      res.status(400).json({ success: false, error: { code: 'CCTP_BURN_MISMATCH', message: 'Transaction does not call this chain\'s TokenMessengerV2' } });
      return;
    }

    let decoded;
    try {
      decoded = decodeDepositForBurnCalldata(tx.data);
    } catch {
      res.status(400).json({ success: false, error: { code: 'CCTP_BURN_MISMATCH', message: 'Transaction is not a depositForBurn call' } });
      return;
    }

    const expectedRecipient = addressToBytes32(row.mint_recipient).toLowerCase();
    if (
      decoded.amount !== BigInt(row.usdc_amount_raw) ||
      decoded.destinationDomain !== row.dest_domain ||
      decoded.mintRecipient.toLowerCase() !== expectedRecipient ||
      decoded.burnToken.toLowerCase() !== source.usdcAddress.toLowerCase()
    ) {
      res.status(400).json({ success: false, error: { code: 'CCTP_BURN_MISMATCH', message: 'Transaction parameters do not match this deposit intent' } });
      return;
    }

    const receipt = await source.rpc.getTransactionReceipt(burnTxHash);
    if (!receipt) {
      res.status(200).json({ success: true, data: { ...serializeTransfer(row), pending: true, message: 'Transaction found but not yet mined — poll again shortly' } });
      return;
    }
    if (receipt.status === 0) {
      const updated = await updateTransfer(row.id, { stage: 'failed', error_message: 'burn transaction reverted' });
      res.status(200).json({ success: true, data: serializeTransfer(updated) });
      return;
    }

    const updated = await updateTransfer(row.id, {
      stage: 'burn_confirmed',
      burn_tx_hash: burnTxHash,
      burn_block_number: String(receipt.blockNumber),
    });
    res.status(200).json({ success: true, data: serializeTransfer(updated) });
  } catch (e) {
    console.error('[cctp] confirm error:', (e as Error).message);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: (e as Error).message } });
  }
});

// GET /api/v1/cctp/deposit-intent/:transferId
cctpRouter.get('/deposit-intent/:transferId', requireAuth, async (req: AuthRequest, res) => {
  const authed = req.user?.address;
  if (!authed || authed === 'agent') {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Sign in required' } });
    return;
  }
  const transferId = Number(req.params.transferId);
  const row = Number.isFinite(transferId) ? await getById(transferId) : null;
  if (!row || row.owner_address !== authed.toLowerCase()) {
    res.status(404).json({ success: false, error: { code: 'CCTP_TRANSFER_NOT_FOUND', message: 'Transfer not found' } });
    return;
  }
  res.status(200).json({ success: true, data: serializeTransfer(row) });
});

// GET /api/v1/cctp/deposit-intents — history for the caller.
cctpRouter.get('/deposit-intents', requireAuth, async (req: AuthRequest, res) => {
  const authed = req.user?.address;
  if (!authed || authed === 'agent') {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Sign in required' } });
    return;
  }
  const rows = await listForOwner(authed);
  res.status(200).json({ success: true, data: rows.filter((r) => r.direction === 'inbound').map(serializeTransfer) });
});
