import { getPool } from './neonDb.js';
import type { CctpChainKey } from './cctpChains.js';

export type CctpDirection = 'outbound' | 'inbound';
export type CctpRelayMethod = 'forwarding_service' | 'self_relay';
export type CctpStage =
  | 'created'
  | 'approved'
  | 'burn_submitted'
  | 'burn_confirmed'
  | 'attestation_pending'
  | 'attestation_ready'
  | 'mint_submitted'
  | 'mint_confirmed'
  | 'failed';

export const TERMINAL_STAGES: readonly CctpStage[] = ['mint_confirmed', 'failed'];

export interface CctpTransfer {
  id: number;
  idempotency_key: string;
  direction: CctpDirection;
  agent_id: string | null;
  owner_address: string;
  source_chain: CctpChainKey;
  source_domain: number;
  dest_chain: CctpChainKey;
  dest_domain: number;
  usdc_amount_raw: string;
  mint_recipient: string;
  max_fee_raw: string;
  min_finality_threshold: number;
  relay_method: CctpRelayMethod;
  stage: CctpStage;
  approve_tx_hash: string | null;
  burn_tx_hash: string | null;
  burn_block_number: string | null;
  cctp_message_hex: string | null;
  cctp_attestation_hex: string | null;
  mint_tx_hash: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTransferOpts {
  idempotencyKey: string;
  direction: CctpDirection;
  agentId?: string | null;
  ownerAddress: string;
  sourceChain: CctpChainKey;
  sourceDomain: number;
  destChain: CctpChainKey;
  destDomain: number;
  usdcAmountRaw: string;
  mintRecipient: string;
  maxFeeRaw: string;
  minFinalityThreshold: number;
  relayMethod: CctpRelayMethod;
}

export async function createTransfer(opts: CreateTransferOpts): Promise<CctpTransfer> {
  const db = await getPool();
  const { rows } = await db.query<CctpTransfer>(
    `INSERT INTO cctp_transfers (
       idempotency_key, direction, agent_id, owner_address,
       source_chain, source_domain, dest_chain, dest_domain,
       usdc_amount_raw, mint_recipient, max_fee_raw, min_finality_threshold, relay_method
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      opts.idempotencyKey,
      opts.direction,
      opts.agentId ?? null,
      opts.ownerAddress.toLowerCase(),
      opts.sourceChain,
      opts.sourceDomain,
      opts.destChain,
      opts.destDomain,
      opts.usdcAmountRaw,
      opts.mintRecipient.toLowerCase(),
      opts.maxFeeRaw,
      opts.minFinalityThreshold,
      opts.relayMethod,
    ],
  );
  return rows[0];
}

export async function getByIdempotencyKey(idempotencyKey: string): Promise<CctpTransfer | null> {
  const db = await getPool();
  const { rows } = await db.query<CctpTransfer>(
    'SELECT * FROM cctp_transfers WHERE idempotency_key = $1',
    [idempotencyKey],
  );
  return rows[0] ?? null;
}

export async function getById(id: number): Promise<CctpTransfer | null> {
  const db = await getPool();
  const { rows } = await db.query<CctpTransfer>('SELECT * FROM cctp_transfers WHERE id = $1', [id]);
  return rows[0] ?? null;
}

type StagePatch = Partial<
  Pick<
    CctpTransfer,
    | 'stage'
    | 'approve_tx_hash'
    | 'burn_tx_hash'
    | 'burn_block_number'
    | 'cctp_message_hex'
    | 'cctp_attestation_hex'
    | 'mint_tx_hash'
    | 'error_message'
  >
>;

/** Advance (or otherwise patch) a transfer row. Always bumps `updated_at`. */
export async function updateTransfer(id: number, patch: StagePatch): Promise<CctpTransfer | null> {
  const allowed: (keyof StagePatch)[] = [
    'stage', 'approve_tx_hash', 'burn_tx_hash', 'burn_block_number',
    'cctp_message_hex', 'cctp_attestation_hex', 'mint_tx_hash', 'error_message',
  ];
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      vals.push(patch[key]);
      sets.push(`${key} = $${vals.length}`);
    }
  }
  if (sets.length === 0) return getById(id);
  sets.push('updated_at = NOW()');
  vals.push(id);
  const db = await getPool();
  const { rows } = await db.query<CctpTransfer>(
    `UPDATE cctp_transfers SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
    vals,
  );
  return rows[0] ?? null;
}

/** Rows the background poller should keep advancing. */
export async function listNonTerminal(): Promise<CctpTransfer[]> {
  const db = await getPool();
  const { rows } = await db.query<CctpTransfer>(
    `SELECT * FROM cctp_transfers WHERE stage NOT IN ('mint_confirmed','failed') ORDER BY created_at ASC`,
  );
  return rows;
}

export async function listForAgent(agentId: string): Promise<CctpTransfer[]> {
  const db = await getPool();
  const { rows } = await db.query<CctpTransfer>(
    'SELECT * FROM cctp_transfers WHERE agent_id = $1 ORDER BY created_at DESC',
    [agentId],
  );
  return rows;
}

export async function listForOwner(ownerAddress: string): Promise<CctpTransfer[]> {
  const db = await getPool();
  const { rows } = await db.query<CctpTransfer>(
    'SELECT * FROM cctp_transfers WHERE owner_address = $1 ORDER BY created_at DESC',
    [ownerAddress.toLowerCase()],
  );
  return rows;
}

/** Shared response shape for both routes/agentsCctp.ts and routes/cctp.ts. */
export function serializeTransfer(t: CctpTransfer | null) {
  if (!t) return null;
  return {
    transferId: t.id,
    direction: t.direction,
    stage: t.stage,
    sourceChain: t.source_chain,
    destChain: t.dest_chain,
    usdcAmountRaw: t.usdc_amount_raw,
    mintRecipient: t.mint_recipient,
    burnTxHash: t.burn_tx_hash,
    mintTxHash: t.mint_tx_hash,
    errorMessage: t.error_message,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}
