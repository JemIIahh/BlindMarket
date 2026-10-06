import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BaseWallet, Contract, Interface, JsonRpcProvider, formatUnits, keccak256, parseUnits, toUtf8Bytes, type Result, type Signer, type TransactionRequest, type TransactionResponse } from 'ethers';
import type { McpConfig } from './config.js';
import type { WalletCtx } from './wallet.js';
import { aesDecrypt, aesEncrypt, derivePublicKeyHex, eciesDecrypt, eciesEncrypt, generateAesKey, sha256Hex } from './crypto.js';
import {
  createQuote, consumeQuote, getSpend, putSpend, updateSpend,
  type QuoteCheck, type SpendFields, type SpendRecord,
} from './state.js';
import {
  createSettlementResolver, isErc20Settlement, rpcFor, rpcEnvName,
  type Erc20Settlement, type LocalErc20Settlement, type RelaySettlement, type Settlement,
} from './settlement.js';
import { isPinnedSettlement, SETTLEMENT_PINS, trustedEscrows, type PinError } from './pins.js';

/** The category the backend builds every task with (backend/src/routes/tasks.ts): bound like every other createTask argument. */
const TASK_CATEGORY = 'general';

/**
 * Why `s`'s escrow may not be funded, or null: only a pinned deployment or
 * one BLINDMARKET_TRUSTED_ESCROWS names (pins.ts). A settlement that does
 * not say its chain id or escrow cannot be checked, so it is refused too.
 */
function pinRefusal(s: Settlement): PinError | null {
  let trusted;
  try {
    trusted = trustedEscrows();
  } catch (err) {
    return err as PinError;
  }
  const token = isErc20Settlement(s) ? s.token.address : '0x0000000000000000000000000000000000000000';
  if (s.chainId !== undefined && s.escrowAddress && isPinnedSettlement(s.chainId, s.escrowAddress, token, trusted)) return null;
  const known = [...SETTLEMENT_PINS, ...trusted].filter((p) => p.chainId === s.chainId);
  const e: PinError = new Error(
    `The backend names escrow ${s.escrowAddress ?? '(none)'} and token ${token} on ${s.mode} (chain ${s.chainId ?? 'unknown'}), which ${known.length ? `is not the known deployment (escrow ${known.map((p) => p.escrow).join(' or ')})` : 'has no known deployment'}. Nothing was approved or sent. For a custom or local deployment, set BLINDMARKET_TRUSTED_ESCROWS=chainId:escrow:token.`,
  );
  e.code = 'ESCROW_NOT_PINNED';
  return e;
}

/**
 * Sign locally, hand the hash and nonce to `recorded` (which writes them to
 * the spend ledger) before anything leaves this process, then broadcast. A
 * broadcast whose answer is lost is TX_MAYBE_SENT: the ledger already holds
 * the hash, so a retry with the same idempotencyKey resumes onto it and never
 * sends another.
 */
async function signRecordBroadcast(
  wallet: Signer,
  request: TransactionRequest,
  recorded: (hash: string, nonce: number) => void,
): Promise<{ hash: string; nonce: number; sent: TransactionResponse }> {
  if (!(wallet instanceof BaseWallet) || !wallet.provider) {
    // A signer without a key of its own signs and sends in one step.
    const sent = await wallet.sendTransaction(request);
    recorded(sent.hash, sent.nonce);
    return { hash: sent.hash, nonce: sent.nonce, sent };
  }
  const populated = await wallet.populateTransaction(request);
  const raw = await wallet.signTransaction(populated);
  const hash = keccak256(raw);
  const nonce = Number(populated.nonce);
  recorded(hash, nonce);
  try {
    const sent = await wallet.provider!.broadcastTransaction(raw);
    return { hash, nonce, sent };
  } catch (err) {
    const e: PinError = new Error(
      `Transaction ${hash} was signed and handed to the node, but no answer came back (${(err as Error).message}). It may still land. Retry with the SAME idempotencyKey: it resumes onto this transaction and never pays again.`,
    );
    e.code = 'TX_MAYBE_SENT';
    throw e;
  }
}

// Read-only view of BlindEscrow.getTask, for reading a task's state directly
// from the chain that holds it. Field order matches contracts/BlindEscrow.sol;
// a post-#38 deployment appends disputedAt, which ABI decoding ignores.
const ESCROW_READ_ABI = [
  'function getTask(uint256) view returns (tuple(address agent,address worker,address token,uint256 amount,bytes32 taskHash,bytes32 evidenceHash,uint8 status,string category,string locationZone,uint256 createdAt,uint256 deadline,uint8 submissionAttempts))',
];

/**
 * Tier-2 spending tools: the CURRENT encrypted post/rent flow, executed
 * entirely locally. This is a 1:1 port of the "Use from your agent" script
 * (frontend/src/components/UseFromAgentModal.tsx buildScript):
 *
 *   encrypt brief locally → POST /api/v1/storage/upload → ECIES-wrap the AES
 *   key to the provider pubkey(s) → POST /api/v1/tasks (unsigned escrow tx) →
 *   sign + send from the LOCAL wallet → POST /api/v1/a2a/tasks/index → poll
 *   GET /api/v1/a2a/tasks/posted for the result.
 *
 * Privacy: for privacy='private' (default) the platform only ever sees
 * ciphertext and a hash. privacy='public' posts the brief in plaintext — no
 * key handling at all, readable by every agent.
 *
 * Spend safety: two-step quote/confirm + a required idempotencyKey persisted
 * in ~/.blindmarket/mcp-state.json with a created→funded→indexed stage
 * machine, so retries resume instead of double-funding.
 */

const ZERO_TOKEN = '0x0000000000000000000000000000000000000000';

// The only calls the backend builds for this process to sign or relay:
// backend/src/services/escrow.ts (createTask, cancelTask, claimTimeout,
// submitEvidence), and for open-submission tasks createTaskOpen, submitOpen,
// selectWinner and voidOpenTask (docs/OPEN-SUBMISSION-TASKS.md; the same set
// as sdk/src/escrowCalls.ts). verifyTarget checks where a transaction goes,
// but the escrow address comes from the same backend, so a hostile answer could name
// the token as the escrow and hand over an approve; the call, its arguments
// and its value are what bound it (security audit run 1, C41).
const ESCROW_CALLS = new Interface([
  'function createTask(bytes32 taskHash, address token, uint256 amount, string category, string locationZone, uint256 duration)',
  'function submitEvidence(uint256 taskId, bytes32 evidenceHash)',
  'function cancelTask(uint256 taskId)',
  'function claimTimeout(uint256 taskId)',
  'function createTaskOpen(bytes32 taskHash, address token, uint256 amount, string category, string locationZone, uint256 duration, address verifierAgent, uint8 mode, uint256 creatorWindow)',
  'function submitOpen(uint256 taskId, bytes32 evidenceHash)',
  'function selectWinner(uint256 taskId, address winner, bytes32 scorecardHash)',
  'function voidOpenTask(uint256 taskId, bytes32 scorecardHash)',
]);
type EscrowCall = 'createTask' | 'submitEvidence' | 'cancelTask' | 'claimTimeout' | 'createTaskOpen' | 'submitOpen' | 'selectWinner' | 'voidOpenTask';
const GAS_LIMIT = 1000000n; // matches the canonical rent script
// Auto-verify releases the payment, so the bar can't be "one character" — but
// 40 made a correct 30-character URL unpayable. 20 is the platform floor
// (DEFAULT_MIN_CONTENT_CHARS in the backend's autoVerify, where min_length is a
// hard floor). Accepted limit: a one-word correct answer still can't
// auto-verify without an expected_answer. MUST match the web app's
// RENTAL_VERIFICATION_CRITERIA (frontend/src/components/UseServiceModal.tsx and
// UseFromAgentModal.tsx) so a rental is judged the same whichever client paid
// for it. The index route also rejects 'auto' with no real criterion (400
// AUTO_CRITERIA_REQUIRED).
const RENTAL_VERIFICATION_CRITERIA = { min_length: 20 };

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(code: string, message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: { code, message } }) }] };
}

interface ApiError extends Error { code?: string; status?: number }

/**
 * Throw TX_MISMATCH, before anything is signed or relayed, unless the
 * backend's unsigned `tx` is exactly `fn` (canonically encoded) with
 * arguments `argsOk` accepts, and names no value other than `value`. Only
 * `to` and `data` are ever forwarded, so a value the backend names is never
 * sent; a wrong one still means the transaction is not the one asked for.
 */
function assertEscrowCall(
  tx: { data?: unknown; value?: unknown },
  fn: EscrowCall,
  argsOk: (args: Result) => boolean,
  what: string,
  value = 0n,
): void {
  const data = typeof tx.data === 'string' ? tx.data.toLowerCase() : '';
  let ok = false;
  try {
    const args = ESCROW_CALLS.decodeFunctionData(fn, data);
    ok = ESCROW_CALLS.encodeFunctionData(fn, args).toLowerCase() === data && argsOk(args);
  } catch { /* another function, or not ABI data at all */ }
  if (ok && tx.value != null) {
    try { ok = BigInt(tx.value as string | number | bigint) === value; } catch { ok = false; }
  }
  if (!ok) {
    const e: ApiError = new Error(`backend built ${what} that is not the ${fn} call this spend asked for (another function, other arguments, or a value). Nothing was sent.`);
    e.code = 'TX_MISMATCH';
    throw e;
  }
}

const QUOTE_REQUIRED_MESSAGE = 'Get a quote first (call without confirm), then re-call with confirm=true and the returned quoteId (quotes are single-use and expire after 10 minutes)';

/** Why a confirm was refused against its quote. Nothing was uploaded,
 *  approved or sent by then. `why` replaces the generic list of what changed. */
function quoteRefused(check: Exclude<QuoteCheck, { ok: true }>, tool: string, why?: string) {
  if (check.code === 'QUOTE_REQUIRED') return fail('QUOTE_REQUIRED', QUOTE_REQUIRED_MESSAGE);
  return fail(
    'QUOTE_MISMATCH',
    `Nothing was sent: ${why ?? `this confirm would spend something other than quote ${check.quote.quoteId} (changed: ${check.changed.join(', ')})`}. ` +
      `That quote is now used up. Call ${tool} again without confirm to get a new quote, check it, then confirm with the new quoteId.`,
  );
}

/** The chain, escrow, token and wallet a spend moves money on, for its quote binding. */
function settlementFields(s: Settlement, payFrom: string): SpendFields {
  return {
    chain: s.mode,
    chainId: s.chainId ?? null,
    escrow: s.escrowAddress ? s.escrowAddress.toLowerCase() : null,
    token: isErc20Settlement(s) ? s.token.address.toLowerCase() : ZERO_TOKEN,
    payFrom: payFrom.toLowerCase(),
  };
}

/** How the network a spend was recorded on differs from the one `s` settles
 *  on now, or null. A chain key keeps its name when the backend moves it to
 *  another network (Arc Testnet 5042002 and Arc mainnet 5042 are both 'arc'),
 *  so the record's chain id decides. A record written before records kept one
 *  cannot be checked. */
function networkChange(record: SpendRecord, s: Settlement): string | null {
  if (s.chainId === undefined || record.chainId === s.chainId) return null;
  return record.chainId === undefined
    ? `was recorded without a chain id, so it cannot be checked against ${s.mode} on chain ${s.chainId}`
    : `started on ${s.mode} chain ${record.chainId}, but the backend's ${s.mode} is chain ${s.chainId} now`;
}

export function registerRentTools(server: McpServer, cfg: McpConfig, walletCtx: WalletCtx | null): { settlement: () => Promise<Settlement> } {
  /** Every authenticated call funnels through api(), so this is the one place
   *  the missing-key case needs handling. Without it the caller gets the
   *  backend's generic "Authentication required", which never names the
   *  variable to set — an agent reading that cannot tell what to fix. Also the
   *  only consumer of cfg.authenticated, which was otherwise dead weight. */
  async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    if (!cfg.authenticated) {
      const err: ApiError = new Error(
        `${path} needs credentials — set BLINDMARKET_API_KEY. Mint one in the web app under Settings -> API keys.`,
      );
      err.code = 'NO_API_KEY';
      throw err;
    }
    // Explicit, named timeout. Node's fetch otherwise fails after ~5 minutes
    // with a bare "fetch failed" — which is what post_task reported, twice,
    // for posts that had already landed on-chain while /a2a/tasks/index sat
    // behind a dead Redis socket server-side. 120s is above the slowest
    // healthy call (index polls for a receipt for ~1 min) and well below the
    // point where a caller assumes the money is lost.
    let res: Response;
    try {
      res = await fetch(`${cfg.apiBase}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-API-Key': cfg.apiKey },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      // Node's fetch reports every socket-level failure as a bare "fetch
      // failed" and hides the real reason in `cause` (ECONNRESET, socket
      // hang up, ECONNREFUSED…). Surface it: "fetch failed" alone cost a
      // debugging session that ended in "the server restarted mid-request".
      const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
      const detail = cause?.code ?? cause?.message ?? (e as Error)?.message ?? String(e);
      const err: ApiError = new Error(
        (e as Error)?.name === 'TimeoutError'
          ? `${path} did not answer within 120s. The backend may be stalled (check its Redis connection); if this was a spend, retry with the SAME idempotencyKey — it resumes, never double-pays.`
          : `${path} unreachable (${detail}). If the backend restarted mid-request and this was a spend, retry with the SAME idempotencyKey — it resumes from the last persisted stage.`,
      );
      err.code = (e as Error)?.name === 'TimeoutError' ? 'BACKEND_TIMEOUT' : 'BACKEND_UNREACHABLE';
      throw err;
    }
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) {
      const err: ApiError = new Error(`${path} failed: ${json.error?.message || res.status}`);
      err.code = json.error?.code;
      err.status = res.status;
      throw err;
    }
    return json.data as T;
  }

  const settlement = createSettlementResolver({
    apiBase: cfg.apiBase ?? 'https://api.blindmarket.xyz',
    api,
    localWallet: walletCtx?.wallet.address,
  });

  /** How this process pays. On 0G that is the local wallet, which must exist.
   *  On a relay chain (Base) nothing signs locally — the relay signs from the
   *  API key's owner wallet — so a missing BLINDMARKET_PRIVATE_KEY is not an
   *  error there. On an ERC-20 chain without a relay (Arc) discovery only
   *  succeeds with the local wallet, already checked to be the key's owner. */
  async function requireFunding(): Promise<{ s: Settlement; payFrom: string } | { error: ReturnType<typeof fail> }> {
    let s: Settlement;
    try {
      s = await settlement();
    } catch (err) {
      return { error: fail((err as ApiError).code ?? 'SETTLEMENT_UNKNOWN', (err as Error).message) };
    }
    if (isErc20Settlement(s)) return { s, payFrom: s.payFrom };
    if (!walletCtx) {
      return { error: fail('NO_WALLET', 'Spending on 0G needs a local funding wallet — set BLINDMARKET_PRIVATE_KEY (see wallet_status)') };
    }
    // The escrow address is compared before every send, but not the chain:
    // a testnet backend's escrow address, paid on the mainnet RPC, is some
    // other account there. A backend that names its 0G chain id settles it.
    if (s.chainId !== undefined && walletCtx.chainId !== s.chainId) {
      return {
        error: fail(
          'CHAIN_MISMATCH',
          `The backend settles 0G on chain ${s.chainId}, but BLINDMARKET_PRIVATE_KEY signs on chain ${walletCtx.chainId} (BLINDMARKET_RPC_URL / BLINDMARKET_CHAIN_ID). Native value sent there would not reach this backend's escrow. Point both at chain ${s.chainId}.`,
        ),
      };
    }
    return { s, payFrom: walletCtx.wallet.address };
  }

  /** A new escrow is funded where POST /api/v1/tasks builds: the backend's
   *  posting chain. A process forced onto another chain (to finish or refund
   *  tasks already there) cannot post. Unknown on an older backend. */
  async function notPostingChain(s: Settlement): Promise<ApiError | null> {
    let posting = s.postingChain;
    // Forced to 0G, discovery never asked the backend. Ask now, before a quote:
    // a backend that posts elsewhere refuses the native-0G createTask only
    // after the brief is uploaded and its hash claimed.
    if (posting === undefined && s.mode === '0g') {
      try {
        const res = await fetch(`${cfg.apiBase}/health/settlement`, { signal: AbortSignal.timeout(15_000) });
        const json: any = await res.json();
        if (json?.success && typeof json.data?.postingChain === 'string') posting = json.data.postingChain;
      } catch { /* an older backend or a blip: keep the old behaviour, the escrow check still guards the send */ }
    }
    if (posting === undefined || s.mode === posting) return null;
    const e: ApiError = new Error(
      `This process settles on ${s.mode} (BLINDMARKET_SETTLEMENT), but the backend posts new tasks on ${posting}, so a new escrow can only be funded there. Unset BLINDMARKET_SETTLEMENT (or set it to ${posting}) to post; ${s.mode} stays usable for tasks already on it.`,
    );
    e.code = 'NOT_POSTING_CHAIN';
    return e;
  }

  const ERC20 = new Interface([
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address owner) view returns (uint256)',
  ]);
  function settlementToken(s: Erc20Settlement): Contract {
    return new Contract(s.token.address, ERC20, s.provider);
  }

  /** The local wallet on a no-relay ERC-20 chain, over that chain's RPC
   *  (checked at discovery to serve the chain the backend names). */
  function localSigner(s: LocalErc20Settlement) {
    return walletCtx!.wallet.connect(s.provider);
  }

  /** Spendable balance of whoever pays, in the settlement token's units. */
  async function payFromBalance(s: Settlement, payFrom: string): Promise<string | null> {
    try {
      const raw: bigint = isErc20Settlement(s)
        ? await settlementToken(s).balanceOf(payFrom)
        : await walletCtx!.provider.getBalance(payFrom);
      return formatUnits(raw, s.decimals);
    } catch {
      return null;
    }
  }

  /** The backend builds every unsigned tx for whichever chain it thinks holds
   *  the task, and the tx carries no chainId. Discovery is only a hint about
   *  that chain (see settlement.ts). So before broadcasting, check the tx
   *  targets the escrow THIS mode expects — otherwise native value goes to a
   *  relay chain's address on the 0G RPC, or a 0G refund is relayed onto
   *  another chain. A mismatch also drops the cached mode so the next call
   *  re-asks. */
  async function verifyTarget(s: Settlement, to: string, what: string): Promise<void> {
    const target = String(to).toLowerCase();
    const expected = s.escrowAddress;
    if (expected) {
      if (target === expected.toLowerCase()) return;
      settlement.invalidate();
      const e: ApiError = new Error(
        `backend built ${what} for ${to} but this process is in ${s.mode} mode expecting escrow ${expected}. ` +
        (s.escrowChains
          ? `This task is escrowed on another chain — set BLINDMARKET_SETTLEMENT to the chain that holds it (this backend has escrows on ${s.escrowChains.join(', ')}; 0G needs a local key), or use the web app.`
          : s.payment === 'relay-erc20'
            ? 'This task is escrowed on 0G — handle it with BLINDMARKET_SETTLEMENT=0g and a local key, or from the web app.'
            : 'The backend is building Base transactions — re-run and discovery will re-check, or set BLINDMARKET_SETTLEMENT=base.'),
      );
      e.code = 'ESCROW_MISMATCH';
      throw e;
    }
    // 0G with no escrow address to compare against (forced 0g, or a backend
    // that doesn't report one). The cheapest truth we have is whether
    // anything lives at `to` on the 0G RPC — a Base escrow address holds no
    // BlindEscrow there.
    const code = await walletCtx!.provider.getCode(to).catch(() => '0x');
    if (code === '0x') {
      settlement.invalidate();
      const e: ApiError = new Error(`backend built ${what} for ${to}, which holds no contract on the 0G RPC — it is almost certainly a Base transaction. Set BLINDMARKET_SETTLEMENT=base.`);
      e.code = 'ESCROW_MISMATCH';
      throw e;
    }
  }

  /** Hand a transaction to the backend relay: Privy signs it from payFrom with
   *  gas paid in USDC. Same wire shape as frontend/src/lib/txSigner.ts. */
  /** How the relay ended up paying for gas — reported by the backend, never
   *  inferred here. 'user-pays' is the product path (USDC); the other two are
   *  fallbacks the backend negotiated because Privy refused that rung. */
  type GasMode = 'user-pays' | 'app-pays' | 'wallet-pays';

  async function relaySend(s: RelaySettlement, tx: { to: string; data: string; value?: bigint }): Promise<{ hash: string; isUserOp: boolean; gas: GasMode }> {
    // gas:'auto' asks the backend to negotiate: user-pays (USDC) → app-pays →
    // wallet-pays, advancing only on Privy's exact refusal for each rung. The
    // negotiation lives server-side on purpose — that is the one place that
    // sees Privy's raw errors, and it is shared with the web app, so both
    // clients behave identically. An earlier version did the fallback here,
    // and it skipped app-pays entirely: the wallet kept paying its own ETH
    // even after sponsorship was switched on in the Privy dashboard.
    const r = await api<{ hash: string; isUserOp?: boolean; gas?: GasMode }>('POST', '/api/v1/tx/relay-tx', {
      walletAddress: s.payFrom,
      to: tx.to,
      data: tx.data,
      value: tx.value === undefined ? undefined : String(tx.value),
      chain: s.relayChain,
      asset: 'usdc',
      gas: 'auto',
    });

    if (!r?.hash) {
      const e: ApiError = new Error('relay-tx returned no hash');
      e.code = 'RELAY_NO_HASH';
      throw e;
    }
    // A backend older than the `gas` field answers without it. That backend
    // also has no negotiation, so the only way it succeeds is the explicit
    // default it applies to this body: user-pays.
    return { hash: r.hash, isUserOp: r.isUserOp === true, gas: r.gas ?? 'user-pays' };
  }

  /** Send a tx on an ERC-20 settlement: through the relay, or signed by the
   *  local wallet on a chain the relay does not serve. Either way the caller
   *  persists the hash before waiting (waitRelayed polls the chain's own RPC
   *  for a plain hash, which a local send always is). `nonce` pins a local
   *  send right after one this process made: an RPC can answer the next nonce
   *  lookup from before the earlier tx landed. */
  async function sendErc20(
    s: Erc20Settlement,
    tx: { to: string; data: string },
    nonce: number | undefined,
    recorded: (sent: { hash: string; isUserOp: boolean; gas?: GasMode }) => void,
  ): Promise<{ hash: string; isUserOp: boolean; gas?: GasMode; nonce?: number }> {
    if (s.payment === 'relay-erc20') {
      const relayed = await relaySend(s, tx);
      recorded(relayed);
      return relayed;
    }
    // No gasLimit: estimation runs first, so a predictable revert (a stale
    // allowance, a passed deadline) fails here without being mined and paid for.
    // The hash is recorded before the transaction leaves (signRecordBroadcast).
    const { hash, nonce: used } = await signRecordBroadcast(
      localSigner(s),
      { to: tx.to, data: tx.data, ...(nonce !== undefined ? { nonce } : {}) },
      (h) => recorded({ hash: h, isUserOp: false }),
    );
    return { hash, isUserOp: false, nonce: used };
  }

  /** The approve this process built, checked before it is signed: the settlement's
   *  (pinned) token, the escrow as spender, and exactly the amount needed. */
  function assertApprove(s: Erc20Settlement, tx: { to: string; data: string }, need: bigint): void {
    let ok = tx.to.toLowerCase() === s.token.address.toLowerCase();
    try {
      const [spender, amount] = ERC20.decodeFunctionData('approve', tx.data);
      ok = ok && String(spender).toLowerCase() === s.escrowAddress.toLowerCase() && amount === need;
    } catch { ok = false; }
    if (!ok) {
      const e: ApiError = new Error(`The approve built for this spend is not ${formatUnits(need, s.decimals)} ${s.symbol} to the escrow ${s.escrowAddress} on its token ${s.token.address}. Nothing was sent.`);
      e.code = 'TX_MISMATCH';
      throw e;
    }
  }

  /** Wait for a relayed tx to land. A plain hash can be polled for its receipt;
   *  a user-op hash cannot (getTransactionReceipt is always null for it), so
   *  that case returns at once and the caller confirms by on-chain STATE —
   *  see ensureAllowance and waitLanded. */
  async function waitRelayed(s: Erc20Settlement, hash: string, isUserOp: boolean): Promise<void> {
    if (isUserOp) return;
    for (let i = 0; i < 30; i++) {
      const receipt = await s.provider.getTransactionReceipt(hash).catch(() => null);
      if (receipt) {
        if (receipt.status === 0) {
          const e: ApiError = new Error(`tx ${hash} reverted`);
          e.code = 'TX_REVERTED';
          throw e;
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    const e: ApiError = new Error(`tx ${hash} not confirmed after 90s — retry with the same idempotencyKey to resume`);
    e.code = 'TX_PENDING';
    throw e;
  }

  /** ERC-20 chains: createTask pulls the token via transferFrom, so the
   *  escrow needs an allowance first. Confirmed by re-reading allowance()
   *  rather than by receipt, which is what makes the user-op case decidable.
   *  Returns the nonce the createTask should use when this call sent a local
   *  approve, else undefined. */
  async function ensureAllowance(s: Erc20Settlement, record: SpendRecord): Promise<number | undefined> {
    const need = BigInt(record.amountWei!);
    const token = settlementToken(s);
    if ((await token.allowance(s.payFrom, s.escrowAddress)) >= need) return undefined;
    let nextNonce: number | undefined;
    const approve = async () => {
      const tx = { to: s.token.address, data: ERC20.encodeFunctionData('approve', [s.escrowAddress, need]) };
      assertApprove(s, tx, need);
      // Recorded before it leaves (a local send) or as the relay answers: a
      // crash from here resumes into the poll below.
      const { nonce } = await sendErc20(s, tx, undefined, ({ hash }) => {
        updateSpend(record.idempotencyKey, { stage: 'approved', approveTxHash: hash });
        record.stage = 'approved';
        record.approveTxHash = hash;
      });
      if (nonce !== undefined) nextNonce = nonce + 1;
    };
    const settled = async () => {
      for (let i = 0; i < 30; i++) {
        if ((await token.allowance(s.payFrom, s.escrowAddress)) >= need) return true;
        await new Promise((r) => setTimeout(r, 3000));
      }
      return false;
    };

    if (record.stage === 'created') {
      await approve();
      if (await settled()) return nextNonce;
    }
    // Resumed at 'approved' (or the fresh approve never landed): the earlier
    // approve was dropped or reverted. Sending another is safe — ERC-20
    // approve SETS the allowance, it does not add — and it is the only way
    // out of this stage, so do it rather than leave the record stuck.
    if (await settled()) return nextNonce;
    await approve();
    if (await settled()) return nextNonce;
    const e: ApiError = new Error(`${s.symbol} allowance still below ${formatUnits(need, s.decimals)} after two approves (last ${record.approveTxHash}) — check ${s.payFrom}'s ${s.symbol} balance and retry with the same idempotencyKey`);
    e.code = 'APPROVE_PENDING';
    throw e;
  }

  /** Fund escrow + index — the shared tail of rent_service and post_task.
   *  Resumable at every stage via the spend ledger.
   *
   *  Two funding paths, chosen by `payment`:
   *    local-native — native 0G from the local wallet, signed and sent here.
   *    relay-erc20  — the ERC-20 (USDC on Base) via transferFrom: approve
   *           first (ensureAllowance), then the createTask the backend built,
   *           both through the Privy relay with no local signing at all. The
   *           backend picks the escrow; we only check it is the one we approved. */
  async function fundAndIndex(record: SpendRecord, nonces?: { next?: number }): Promise<{ taskHash: string; txHash: string; gas?: GasMode }> {
    let { txHash } = record;

    // Nothing left to sign once the escrow is funded: /a2a/tasks/index finds
    // the receipt on whichever chain holds it. So a funded spend finishes
    // even when settlement cannot be discovered right now, or has moved.
    if (record.stage === 'created' || record.stage === 'approved') {
      const s = await settlement();
      // A record remembers the chain it started on. If the backend flips mode
      // between attempts, re-funding through the other path would double-fund
      // or send native value into a USDC transferFrom — refuse instead.
      if (record.settlement && record.settlement !== s.mode) {
        const e: ApiError = new Error(
          `spend ${record.idempotencyKey} started on ${record.settlement} but this process now settles on ${s.mode}. ` +
          `Nothing was funded yet (stage ${record.stage}): start a new spend with a new idempotencyKey, or set BLINDMARKET_SETTLEMENT=${record.settlement} to finish this one.`,
        );
        e.code = 'SETTLEMENT_CHANGED';
        throw e;
      }
      // Nor on another network under the same key: the spend was quoted and
      // confirmed for the one it started on.
      const moved = networkChange(record, s);
      if (moved) {
        const e: ApiError = new Error(`spend ${record.idempotencyKey} ${moved}. Nothing was funded yet (stage ${record.stage}): start a new spend with a new idempotencyKey.`);
        e.code = 'SETTLEMENT_CHANGED';
        throw e;
      }
      const refused = await notPostingChain(s);
      if (refused) throw refused;
      // Only a pinned (or trusted) escrow is approved or funded.
      const unpinned = pinRefusal(s);
      if (unpinned) throw unpinned;
      // `nonces` carries the next nonce between the rows of one post_tasks
      // call, when this spend sends no approve of its own.
      const nonce = isErc20Settlement(s) ? (await ensureAllowance(s, record)) ?? nonces?.next : undefined;

      const { unsignedTx, chain: builtChain, chainId: builtChainId } = await api('POST', '/api/v1/tasks', {
        taskHash: record.taskHash,
        token: isErc20Settlement(s) ? s.token.address : ZERO_TOKEN,
        amount: record.amountWei,
        locationZone: 'global',
        duration: String(record.durationSecs ?? 3600),
        targetExecutorType: 'agent',
        verificationMode: record.verificationMode,
        verificationCriteria: record.verificationCriteria,
        requiredCapabilities: record.requiredCapabilities ?? [],
        rootHash: record.rootHash,
        wrappedKeys: record.privacy === 'public' ? undefined : record.wrappedKeys,
      });

      // Either branch: the tx must target the escrow this mode expects. On a
      // relay chain that is also the escrow the allowance above was granted to.
      // A chain-aware backend also names the chain it built for (older ones
      // return only the tx, and are checked by address alone, as before).
      if (s.postingChain !== undefined && (
        (builtChain !== undefined && builtChain !== s.mode) ||
        (builtChainId !== undefined && s.chainId !== undefined && Number(builtChainId) !== s.chainId)
      )) {
        settlement.invalidate();
        const e: ApiError = new Error(`backend built createTask for ${builtChain ?? '?'} (chain ${builtChainId ?? '?'}) but this process settles on ${s.mode} (chain ${s.chainId ?? '?'}) — re-run and discovery will re-check`);
        e.code = 'ESCROW_MISMATCH';
        throw e;
      }
      await verifyTarget(s, unsignedTx.to, 'createTask');
      // And it must be this spend's createTask: its task hash, token, amount
      // and duration (the amount is what was approved above, or the value sent below).
      const amount = BigInt(record.amountWei!);
      const token = isErc20Settlement(s) ? s.token.address : ZERO_TOKEN;
      assertEscrowCall(unsignedTx, 'createTask', (a) =>
        String(a[0]).toLowerCase() === String(record.taskHash).toLowerCase()
        && String(a[1]).toLowerCase() === token.toLowerCase()
        && a[2] === amount
        && a[3] === TASK_CATEGORY
        && a[4] === 'global'
        && a[5] === BigInt(record.durationSecs ?? 3600),
      'createTask', isErc20Settlement(s) ? 0n : amount);

      if (isErc20Settlement(s)) {
        const { hash, isUserOp, nonce: used } = await sendErc20(s, { to: unsignedTx.to, data: unsignedTx.data }, nonce, (sent) => {
          // Recorded before the transaction leaves (a local send) or as the
          // relay answers: a retry resumes onto it instead of funding again.
          updateSpend(record.idempotencyKey, { stage: 'funded', txHash: sent.hash, isUserOp: sent.isUserOp, gas: sent.gas });
          record.gas = sent.gas;
          record.isUserOp = sent.isUserOp;
          txHash = sent.hash;
        });
        if (nonces) nonces.next = used !== undefined ? used + 1 : undefined;
        try {
          await waitRelayed(s, hash, isUserOp);
        } catch (err) {
          // A createTask that reverted created no task and moved no escrow:
          // back to 'created', so a retry funds it instead of trying forever
          // to list a transaction that holds no TaskCreated.
          if ((err as ApiError).code === 'TX_REVERTED') {
            updateSpend(record.idempotencyKey, { stage: 'created', txHash: undefined, isUserOp: undefined });
            record.stage = 'created';
          }
          throw err;
        }
      } else {
        const { sent } = await signRecordBroadcast(walletCtx!.wallet, {
          to: unsignedTx.to,
          data: unsignedTx.data,
          value: BigInt(record.amountWei!),
          gasLimit: GAS_LIMIT,
          // ethers refuses to sign when its provider is on another chain.
          ...(s.chainId !== undefined ? { chainId: s.chainId } : {}),
        }, (hash) => {
          // Recorded before the transaction leaves: if we crash mid-confirmation
          // the resume path re-runs /tasks/index with this hash instead of re-funding.
          updateSpend(record.idempotencyKey, { stage: 'funded', txHash: hash });
          txHash = hash;
        });
        try {
          await sent.wait();
        } catch (err) {
          // Reverted: no task, no escrow. Back to 'created' so a retry funds it.
          if ((err as { code?: string }).code === 'CALL_EXCEPTION') {
            updateSpend(record.idempotencyKey, { stage: 'created', txHash: undefined });
            record.stage = 'created';
          }
          throw err;
        }
      }
    }

    // stage 'funded' (fresh or resumed): index against the verified receipt.
    // /a2a/tasks/index polls both chains for the receipt server-side, and with
    // isUserOp it skips the (always-null) receipt lookup and scans logs for the
    // TaskCreated event instead — that is how the user-op case is resolved.
    await api('POST', '/api/v1/a2a/tasks/index', {
      txHash,
      isUserOp: record.isUserOp ?? false,
      taskHash: record.taskHash,
      verificationMode: record.verificationMode,
      verificationCriteria: record.verificationCriteria,
      requiredCapabilities: record.requiredCapabilities ?? [],
      rootHash: record.rootHash,
      wrappedKeys: record.privacy === 'public' ? undefined : record.wrappedKeys,
      targetExecutor: record.targetExecutor,
      serviceId: record.serviceId,
      privacy: record.privacy === 'public' ? 'public' : undefined,
      publicBrief: record.privacy === 'public' ? record.publicBrief : undefined,
      routingSummary: record.routingSummary,
    });
    updateSpend(record.idempotencyKey, { stage: 'indexed' });
    return { taskHash: record.taskHash!, txHash: txHash!, gas: record.gas };
  }

  async function pollPosted(taskHash: string, waitSeconds: number) {
    const deadline = Date.now() + Math.min(60, Math.max(0, waitSeconds)) * 1000;
    const hashLc = taskHash.toLowerCase();
    for (;;) {
      const { tasks } = await api<{ tasks: any[] }>('GET', '/api/v1/a2a/tasks/posted');
      const t = tasks.find((x) => x.meta?.taskId?.toLowerCase() === hashLc);
      const status = t?.state?.status ?? 'unknown';
      if ((status === 'verified' || status === 'completed') && t.state.resultData) {
        return { status, result: t.state.resultData, done: true };
      }
      if (status === 'failed') {
        return { status, failedReason: t.state.failedReason ?? null, done: true, hint: 'The agent could not complete this task. If escrow is still Funded you can cancel for a refund.' };
      }
      if (Date.now() >= deadline) {
        return { status, done: false, hint: 'Still running — call poll_task_result again.' };
      }
      await new Promise((r) => setTimeout(r, 4000));
    }
  }

  // ── rent_service ──────────────────────────────────────────────────────────

  server.registerTool(
    'rent_service',
    {
      title: 'Rent an Agent Service',
      description: 'Hire a listed agent service for one call: encrypts your prompt locally (unless privacy=public), funds escrow, and pins the task to the provider agent. Escrow is paid on the backend\'s posting chain: USDC on Arc signed by the local wallet (BLINDMARKET_PRIVATE_KEY, which must own BLINDMARKET_API_KEY; gas is also USDC), USDC on Base through the backend relay (no private key needed), or native 0G from the local wallet. wallet_status shows which. TWO-STEP: first call returns a price quote + quoteId; re-call with the SAME arguments plus confirm=true and that quoteId to actually spend (a confirm that differs from its quote, or a listing re-priced since the quote, is refused with QUOTE_MISMATCH and nothing is sent). Requires a unique idempotencyKey (safe to retry with the same key — it resumes, never double-pays).',
      inputSchema: {
        serviceId: z.number().int().positive().describe('Service id from browse_services / get_service'),
        prompt: z.string().min(1).max(100_000).describe('What you want the agent to do'),
        idempotencyKey: z.string().min(8).max(128).describe('Unique key for this spend — reuse it on retries'),
        privacy: z.enum(['private', 'public']).optional().describe("Default 'private': prompt encrypted end-to-end. 'public': prompt and result become public record"),
        confirm: z.boolean().optional().describe('Set true (with quoteId) to execute the spend'),
        quoteId: z.string().optional().describe('From the quote step'),
        waitSeconds: z.number().int().min(0).max(60).optional().describe('How long to wait for the result after posting (default 45; poll_task_result to keep waiting)'),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ serviceId, prompt, idempotencyKey, privacy, confirm, quoteId, waitSeconds }) => {
      // Resume path — this key already spent (or partially spent). Checked
      // before settlement: a funded spend finishes without it.
      const existing = getSpend(idempotencyKey);
      if (existing) {
        if (existing.stage === 'indexed') {
          const polled = await pollPosted(existing.taskHash!, waitSeconds ?? 45);
          return ok({ resumed: true, taskHash: existing.taskHash, txHash: existing.txHash, ...polled });
        }
        try {
          const done = await fundAndIndex(existing);
          const polled = await pollPosted(done.taskHash, waitSeconds ?? 45);
          return ok({ resumed: true, ...done, ...polled });
        } catch (err) {
          return fail((err as ApiError).code ?? 'RESUME_FAILED', (err as Error).message);
        }
      }

      const f = await requireFunding();
      if ('error' in f) return f.error;
      const { s, payFrom } = f;
      const offPosting = await notPostingChain(s);
      if (offPosting) return fail(offPosting.code!, offPosting.message);
      // Only a pinned (or trusted) escrow is quoted, approved or funded.
      const unpinned = pinRefusal(s);
      if (unpinned) return fail(unpinned.code!, unpinned.message);

      const service = await api<any>('GET', `/api/v1/marketplace/services/${serviceId}`);
      const isPublic = privacy === 'public';
      if (!isPublic && !service.agent_public_key) {
        return fail('NO_AGENT_PUBKEY', 'This service\'s agent has no encryption public key — only privacy=public calls are possible');
      }

      // price_raw is stored in the settlement token's base units (the backend
      // compares it against the on-chain amount as-is), so it is 6-decimal
      // USDC on Base and 18-decimal 0G otherwise — format it that way.
      const priceRaw = BigInt(service.price_raw);
      // A service priced in 18-decimal units on a 6-decimal chain would quote
      // as a trillion USDC and relay an approve for it before createTask
      // failed. The backend converts such prices since migration 31, but an
      // older backend may still serve one. 1,000,000 tokens per call is far
      // above any real listing — refuse.
      if (s.decimals < 18 && priceRaw > 1_000_000n * 10n ** BigInt(s.decimals)) {
        return fail('PRICE_UNITS_SUSPECT', `service ${serviceId} lists price_raw=${priceRaw} which is ${formatUnits(priceRaw, s.decimals)} ${s.symbol} — this looks like an 18-decimal 0G price on a ${s.symbol} chain. Not sending. Re-list the service in ${s.symbol} base units.`);
      }
      const price = formatUnits(priceRaw, s.decimals);
      // Exactly what this call would spend, derived after every lookup above
      // and before anything is uploaded or sent. The quote stores it and the
      // confirm must match it: a provider can re-price its listing between
      // the two calls, and the confirm call carries no price of its own.
      const spend: SpendFields = {
        ...settlementFields(s, payFrom),
        idempotencyKey,
        serviceId: String(serviceId),
        listingId: String(service.id),
        agent: String(service.agent_address).toLowerCase(),
        priceRaw: priceRaw.toString(),
        privacy: isPublic ? 'public' : 'private',
        prompt: sha256Hex(Buffer.from(prompt, 'utf8')),
      };

      if (!confirm) {
        const quote = createQuote('rent', { serviceId, price, currency: s.symbol }, spend);
        return ok({
          quote: {
            service: { id: service.id, name: service.name, agent: service.agent_address },
            price,
            currency: s.symbol,
            settlement: s.mode,
            payFrom,
            walletBalance: await payFromBalance(s, payFrom),
            privacy: isPublic ? 'public' : 'private',
            quoteId: quote.quoteId,
          },
          next: `Re-call rent_service with confirm=true, quoteId="${quote.quoteId}", and the SAME idempotencyKey to execute this spend.`,
        });
      }
      const check = consumeQuote(quoteId, 'rent', spend);
      if (!check.ok) {
        const repriced = check.code === 'QUOTE_MISMATCH' && check.changed.includes('priceRaw')
          ? `the listing's price changed from ${check.quote.summary.price} ${check.quote.summary.currency} to ${price} ${s.symbol} since the quote`
          : undefined;
        return quoteRefused(check, 'rent_service', repriced);
      }

      try {
        // Prepare the brief blob (the canonical script's steps 1-3).
        const plaintext = Buffer.from(prompt, 'utf8');
        let blobB64: string;
        let taskHash: string;
        let wrappedKeys: Record<string, string> | undefined;
        let aesKeyHex: string | undefined;
        if (isPublic) {
          blobB64 = plaintext.toString('base64');
          taskHash = '0x' + sha256Hex(plaintext);
        } else {
          const aesKey = generateAesKey();
          const ciphertext = aesEncrypt(plaintext, aesKey);
          blobB64 = ciphertext.toString('base64');
          taskHash = '0x' + sha256Hex(ciphertext);
          wrappedKeys = { [service.agent_address.toLowerCase()]: eciesEncrypt(aesKey, service.agent_public_key).toString('hex') };
          aesKeyHex = aesKey.toString('hex');
        }
        const { rootHash } = await api<{ rootHash: string }>('POST', '/api/v1/storage/upload', { data: blobB64 });

        const record: SpendRecord = {
          idempotencyKey,
          kind: 'rent',
          stage: 'created',
          taskHash,
          rootHash,
          serviceId: service.id,
          targetExecutor: service.agent_address.toLowerCase(),
          privacy: isPublic ? 'public' : 'private',
          aesKeyHex,
          wrappedKeys,
          publicBrief: isPublic ? prompt.slice(0, 4000) : undefined,
          verificationMode: 'auto',
          verificationCriteria: RENTAL_VERIFICATION_CRITERIA,
          requiredCapabilities: [],
          // The quoted price, which the binding above just matched.
          amountWei: priceRaw.toString(),
          settlement: s.mode,
          chainId: s.chainId,
          token: isErc20Settlement(s) ? s.token.address : ZERO_TOKEN,
          durationSecs: 3600,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        putSpend(record);

        const done = await fundAndIndex(record);
        const polled = await pollPosted(done.taskHash, waitSeconds ?? 45);
        return ok({ ...done, escrowed: { amount: price, amountRaw: priceRaw.toString(), currency: s.symbol }, ...polled });
      } catch (err) {
        const code = (err as ApiError).code;
        if (code === 'NOT_TASK_AGENT') {
          return fail(code, 'The API key\'s owner wallet does not match the wallet that funded escrow. When this process signs (0G, Arc), mint an sk_ key while signed in with the BLINDMARKET_PRIVATE_KEY wallet; on a relay chain (Base) the relay signs from the key\'s own wallet, so this means the key was rotated mid-spend. The escrow is funded but unindexed — retry with the same idempotencyKey after fixing the key, or use cancel_task for a refund.');
        }
        return fail(code ?? 'RENT_FAILED', (err as Error).message);
      }
    },
  );

  /**
   * A post's brief, sealed and uploaded, and its spend recorded at 'created':
   * post_task's first half, shared with post_tasks. A private brief is
   * encrypted here and its key wrapped to each executor registered for the
   * capabilities (`executors` when the caller already asked, as post_tasks
   * does once per list).
   */
  async function createPostRecord(o: {
    idempotencyKey: string;
    instructions: string;
    isPublic: boolean;
    capabilities: string[];
    amountWei: bigint;
    durationSecs: number;
    s: Settlement;
    executors?: Array<{ address: string; publicKey: string }>;
    routingSummary?: string;
  }): Promise<{ record: SpendRecord; wrappedTo: number }> {
    const plaintext = Buffer.from(o.instructions, 'utf8');
    let blobB64: string;
    let taskHash: string;
    let wrappedKeys: Record<string, string> | undefined;
    let aesKeyHex: string | undefined;
    if (o.isPublic) {
      blobB64 = plaintext.toString('base64');
      taskHash = '0x' + sha256Hex(plaintext);
    } else {
      // Wrap to every currently-registered matching executor — same as the
      // PostTask UI. A late joiner relies on the platform's key custody (if
      // enabled) or the poster re-wrapping; consider privacy=public for
      // guaranteed pickup by anyone.
      const executors = o.executors ?? (await api<{ executors: Array<{ address: string; publicKey: string }> }>(
        'GET', `/api/v1/a2a/executors?capabilities=${encodeURIComponent(o.capabilities.join(','))}`,
      )).executors;
      const aesKey = generateAesKey();
      const ciphertext = aesEncrypt(plaintext, aesKey);
      blobB64 = ciphertext.toString('base64');
      taskHash = '0x' + sha256Hex(ciphertext);
      wrappedKeys = {};
      for (const exec of executors) {
        try {
          wrappedKeys[exec.address.toLowerCase()] = eciesEncrypt(aesKey, exec.publicKey).toString('hex');
        } catch { /* skip malformed pubkey */ }
      }
      aesKeyHex = aesKey.toString('hex');
    }
    const { rootHash } = await api<{ rootHash: string }>('POST', '/api/v1/storage/upload', { data: blobB64 });
    const record: SpendRecord = {
      idempotencyKey: o.idempotencyKey,
      kind: 'post',
      stage: 'created',
      taskHash,
      rootHash,
      privacy: o.isPublic ? 'public' : 'private',
      aesKeyHex,
      wrappedKeys,
      publicBrief: o.isPublic ? o.instructions.slice(0, 4000) : undefined,
      ...(o.routingSummary ? { routingSummary: o.routingSummary } : {}),
      verificationMode: 'auto',
      verificationCriteria: { min_length: 10, pass_threshold: 60 },
      requiredCapabilities: o.capabilities,
      amountWei: o.amountWei.toString(),
      settlement: o.s.mode,
      chainId: o.s.chainId,
      token: isErc20Settlement(o.s) ? o.s.token.address : ZERO_TOKEN,
      durationSecs: o.durationSecs,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    putSpend(record);
    return { record, wrappedTo: wrappedKeys ? Object.keys(wrappedKeys).length : 0 };
  }

  // ── post_task ─────────────────────────────────────────────────────────────

  server.registerTool(
    'post_task',
    {
      title: 'Post a Task to the Open Market',
      description: 'Post a task any matching agent can pick up: encrypts the brief locally and wraps its key to every registered matching executor (or posts it in plaintext with privacy=public), then funds escrow. Escrow is paid on the backend\'s posting chain: USDC on Arc signed by the local wallet (BLINDMARKET_PRIVATE_KEY, which must own BLINDMARKET_API_KEY; gas is also USDC), USDC on Base through the backend relay (no private key needed), or native 0G from the local wallet. wallet_status shows which. TWO-STEP quote/confirm like rent_service: confirm with the same arguments, or it is refused with QUOTE_MISMATCH; requires a unique idempotencyKey.',
      inputSchema: {
        instructions: z.string().min(1).max(100_000).describe('The task brief'),
        amount: z.string().regex(/^\d+(\.\d+)?$/).optional().describe('Escrow amount in the settlement token (e.g. "2.5" — USDC on Base, 0G on 0G) — paid to the worker (90%) on verified completion'),
        amount0G: z.string().regex(/^\d+(\.\d+)?$/).optional().describe('Deprecated alias of `amount` kept for existing callers — same meaning, same units as the settlement token'),
        idempotencyKey: z.string().min(8).max(128).describe('Unique key for this spend — reuse it on retries'),
        capabilities: z.array(z.string()).optional().describe('Optional capability tags to route to matching agents first; empty = every agent'),
        durationSeconds: z.number().int().min(3600).max(90 * 24 * 3600).optional().describe('Deadline seconds from now (default 86400 = 24h)'),
        privacy: z.enum(['private', 'public']).optional().describe("Default 'private': encrypted brief. 'public': plaintext brief + public result — readable/workable by any agent with zero crypto"),
        confirm: z.boolean().optional().describe('Set true (with quoteId) to execute the spend'),
        quoteId: z.string().optional().describe('From the quote step'),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ instructions, amount, amount0G, idempotencyKey, capabilities, durationSeconds, privacy, confirm, quoteId }) => {
      // Checked before settlement: a funded spend finishes without it.
      const existing = getSpend(idempotencyKey);
      if (existing) {
        if (existing.kind === 'post-batch') {
          return fail('IDEMPOTENCY_KEY_IN_USE', `idempotencyKey ${idempotencyKey} belongs to a post_tasks call. Use a new key for this post, or post_tasks with that key to finish its rows.`);
        }
        if (existing.stage === 'indexed') {
          return ok({ resumed: true, taskHash: existing.taskHash, txHash: existing.txHash, hint: 'Already posted — use poll_task_result to check on it.' });
        }
        try {
          return ok({ resumed: true, ...(await fundAndIndex(existing)) });
        } catch (err) {
          return fail((err as ApiError).code ?? 'RESUME_FAILED', (err as Error).message);
        }
      }

      const f = await requireFunding();
      if ('error' in f) return f.error;
      const { s, payFrom } = f;
      const offPosting = await notPostingChain(s);
      if (offPosting) return fail(offPosting.code!, offPosting.message);
      // Only a pinned (or trusted) escrow is quoted, approved or funded.
      const unpinned = pinRefusal(s);
      if (unpinned) return fail(unpinned.code!, unpinned.message);

      const isPublic = privacy === 'public';
      const amountStr = amount ?? amount0G;
      if (!amountStr) {
        return fail('AMOUNT_REQUIRED', `Pass \`amount\` — the escrow in ${s.symbol} (e.g. "2.5").`);
      }
      let amountWei: bigint;
      try {
        amountWei = parseUnits(amountStr, s.decimals);
      } catch {
        return fail('AMOUNT_INVALID', `"${amountStr}" is not a valid ${s.symbol} amount — at most ${s.decimals} decimal places.`);
      }
      const durationSecs = durationSeconds ?? 86400;
      // What this call would spend, bound into the quote (see rent_service).
      const spend: SpendFields = {
        ...settlementFields(s, payFrom),
        idempotencyKey,
        amountRaw: amountWei.toString(),
        durationSecs,
        capabilities: JSON.stringify(capabilities ?? []),
        privacy: isPublic ? 'public' : 'private',
        instructions: sha256Hex(Buffer.from(instructions, 'utf8')),
      };

      if (!confirm) {
        const quote = createQuote('post', { amount: amountStr, currency: s.symbol }, spend);
        return ok({
          quote: {
            escrow: amountStr,
            currency: s.symbol,
            settlement: s.mode,
            payFrom,
            walletBalance: await payFromBalance(s, payFrom),
            privacy: isPublic ? 'public' : 'private',
            capabilities: capabilities ?? [],
            quoteId: quote.quoteId,
          },
          next: `Re-call post_task with confirm=true, quoteId="${quote.quoteId}", and the SAME idempotencyKey to execute this spend.`,
        });
      }
      const check = consumeQuote(quoteId, 'post', spend);
      if (!check.ok) return quoteRefused(check, 'post_task');

      try {
        const { record, wrappedTo } = await createPostRecord({
          idempotencyKey, instructions, isPublic, capabilities: capabilities ?? [], amountWei, durationSecs, s,
        });
        const done = await fundAndIndex(record);
        return ok({
          ...done,
          escrowed: { amount: formatUnits(amountWei, s.decimals), amountRaw: amountWei.toString(), currency: s.symbol },
          wrappedTo,
          privacy: record.privacy,
          hint: 'Use poll_task_result to wait for the deliverable.',
        });
      } catch (err) {
        const code = (err as ApiError).code;
        if (code === 'NOT_TASK_AGENT') {
          return fail(code, 'The API key\'s owner wallet does not match the wallet that funded escrow. When this process signs (0G, Arc), mint an sk_ key while signed in with the BLINDMARKET_PRIVATE_KEY wallet; on a relay chain (Base) the relay signs from the key\'s own wallet, so this means the key was rotated mid-spend. The escrow is funded but unindexed — retry with the same idempotencyKey after fixing the key, or use cancel_task for a refund.');
        }
        return fail(code ?? 'POST_FAILED', (err as Error).message);
      }
    },
  );

  // ── post_tasks ────────────────────────────────────────────────────────────
  //
  // Many posts at once. One quote covers the whole list; the confirm approves
  // the escrow ONCE for every task still to fund (on an ERC-20 settlement),
  // then funds and lists each task through post_task's own path. Each task is
  // its own 'post' spend under `<idempotencyKey>#<fingerprint of the task>`,
  // so a retry with the same key, even with tasks added or removed, never
  // funds a task twice: posted ones are skipped, a funded one is listed
  // without paying again. A problem stops the run, so nothing more is funded
  // behind it.

  const MAX_POST_TASKS = 200;
  const postTasksRow = z.object({
    instructions: z.string().min(1).max(100_000).describe('The task brief'),
    amount: z.string().regex(/^\d+(\.\d+)?$/).describe('Escrow in the settlement token (e.g. "2.5" USDC)'),
    durationSeconds: z.number().int().min(3600).max(90 * 24 * 3600).optional().describe('Deadline seconds from now (default 86400 = 24h)'),
    privacy: z.enum(['private', 'public']).optional().describe("Default 'private' (encrypted brief); 'public' posts it in plaintext"),
    capabilities: z.array(z.string()).optional().describe('Optional capability tags to route to matching agents first'),
    routingSummary: z.string().min(1).max(500).optional().describe('Public one-liner the task board shows (all it shows of a private task): no secrets'),
  });

  /** A stopped run: an error the caller must see, with every task's outcome. */
  function stoppedRun(code: string, message: string, body: Record<string, unknown>) {
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: { code, message }, ...body }, null, 2) }] };
  }

  server.registerTool(
    'post_tasks',
    {
      title: 'Post Many Tasks at Once',
      description: `Post up to ${MAX_POST_TASKS} tasks in one go, paid the way post_task pays (see wallet_status). TWO-STEP quote/confirm like post_task: the quote covers the whole list (how many, the total escrow, the public/private split, the transactions); confirm with the SAME tasks and idempotencyKey, or it is refused with QUOTE_MISMATCH. On an ERC-20 settlement the escrow is approved ONCE for the total, then each task is funded and listed in turn. A problem stops the run so nothing more is funded behind it; re-call with the same idempotencyKey (new quote, then confirm) to resume: posted tasks are skipped, a funded one is listed without paying again. A private task needs a registered executor that can open it (NO_EXECUTORS otherwise, with nothing sent).`,
      inputSchema: {
        tasks: z.array(postTasksRow).min(1).max(MAX_POST_TASKS).describe('The tasks to post, in order'),
        idempotencyKey: z.string().min(8).max(128).describe('Unique key for this list — reuse it to retry or resume'),
        confirm: z.boolean().optional().describe('Set true (with quoteId) to execute the spend'),
        quoteId: z.string().optional().describe('From the quote step'),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ tasks, idempotencyKey, confirm, quoteId }) => {
      const existing = getSpend(idempotencyKey);
      if (existing && existing.kind !== 'post-batch') {
        return fail('IDEMPOTENCY_KEY_IN_USE', `idempotencyKey ${idempotencyKey} belongs to another spend (${existing.kind}). Use a new key for this list.`);
      }
      const f = await requireFunding();
      if ('error' in f) return f.error;
      const { s, payFrom } = f;
      const offPosting = await notPostingChain(s);
      if (offPosting) return fail(offPosting.code!, offPosting.message);
      // Only a pinned (or trusted) escrow is quoted, approved or funded.
      const unpinned = pinRefusal(s);
      if (unpinned) return fail(unpinned.code!, unpinned.message);

      // Every task checked before a quote, its escrow in the settlement token.
      interface Row { index: number; instructions: string; isPublic: boolean; capabilities: string[]; amountWei: bigint; durationSecs: number; routingSummary?: string; key: string }
      const rows: Row[] = [];
      const bad: string[] = [];
      const copies = new Map<string, number>();
      const publicBriefs = new Map<string, number>();
      tasks.forEach((t, index) => {
        let amountWei: bigint;
        try {
          amountWei = parseUnits(t.amount, s.decimals);
        } catch {
          bad.push(`tasks[${index}]: "${t.amount}" is not a ${s.symbol} amount with at most ${s.decimals} decimals`);
          return;
        }
        if (amountWei <= 0n) { bad.push(`tasks[${index}]: the escrow must be above 0`); return; }
        const isPublic = t.privacy === 'public';
        const briefHash = sha256Hex(Buffer.from(t.instructions, 'utf8'));
        if (isPublic) {
          const first = publicBriefs.get(briefHash);
          if (first !== undefined) { bad.push(`tasks[${index}]: the same public brief as tasks[${first}], and the market lists a brief once`); return; }
          publicBriefs.set(briefHash, index);
        }
        const capabilities = t.capabilities ?? [];
        const durationSecs = t.durationSeconds ?? 86400;
        const routingSummary = t.routingSummary?.trim() || undefined;
        // The same task twice is two tasks: the nth copy has its own key.
        const canonical = JSON.stringify([briefHash, amountWei.toString(), durationSecs, isPublic, [...capabilities].sort(), routingSummary ?? '']);
        const copy = copies.get(canonical) ?? 0;
        copies.set(canonical, copy + 1);
        const fingerprint = sha256Hex(Buffer.from(`${canonical}#${copy}`, 'utf8'));
        rows.push({ index, instructions: t.instructions, isPublic, capabilities, amountWei, durationSecs, routingSummary, key: `${idempotencyKey}#${fingerprint}` });
      });
      if (bad.length > 0) {
        return fail('INVALID_ROWS', `${bad.length} of ${tasks.length} tasks cannot be posted as they are, so nothing was sent: ${bad.slice(0, 10).join('; ')}${bad.length > 10 ? '; …' : ''}`);
      }

      // What this key already did with each task.
      const stageOf = (r: Row) => getSpend(r.key)?.stage;
      const posted = rows.filter((r) => stageOf(r) === 'indexed');
      const todo = rows.filter((r) => stageOf(r) !== 'indexed');
      const toFund = todo.filter((r) => stageOf(r) !== 'funded');
      const toFundRaw = toFund.reduce((sum, r) => sum + r.amountWei, 0n);
      const postedResult = (r: Row) => {
        const rec = getSpend(r.key)!;
        return { index: r.index, status: 'posted', taskHash: rec.taskHash, txHash: rec.txHash, resumed: true };
      };
      if (todo.length === 0) {
        return ok({ resumed: true, posted: posted.length, results: posted.map(postedResult), hint: 'Every task in this list is posted — use poll_task_result on each taskHash.' });
      }

      // A private brief no registered executor can open would be escrowed for no one.
      const executorsByCaps = new Map<string, Array<{ address: string; publicKey: string }>>();
      try {
        for (const r of toFund) {
          if (r.isPublic || getSpend(r.key)) continue; // a recorded task's brief is sealed already
          const caps = [...r.capabilities].sort().join(',');
          if (!executorsByCaps.has(caps)) {
            const { executors } = await api<{ executors: Array<{ address: string; publicKey: string }> }>(
              'GET', `/api/v1/a2a/executors?capabilities=${encodeURIComponent(r.capabilities.join(','))}`,
            );
            executorsByCaps.set(caps, executors.filter((e) => typeof e.publicKey === 'string' && e.publicKey.length > 0));
          }
          if (executorsByCaps.get(caps)!.length === 0) {
            return fail('NO_EXECUTORS', `tasks[${r.index}] is private, but no executor${r.capabilities.length ? ` with ${r.capabilities.join(', ')}` : ''} is registered to open it, so nobody could take it. Nothing was sent: post it with privacy "public", or wait for executors to register.`);
          }
        }
      } catch (err) {
        return fail((err as ApiError).code ?? 'EXECUTORS_UNKNOWN', (err as Error).message);
      }

      // What this call would spend, bound into the quote (see rent_service).
      const digest = (list: Row[]) => sha256Hex(Buffer.from(JSON.stringify(list.map((r) => r.key)), 'utf8'));
      const spend: SpendFields = {
        ...settlementFields(s, payFrom),
        idempotencyKey,
        tasks: rows.length,
        toPost: todo.length,
        toFundRaw: toFundRaw.toString(),
        rows: digest(rows),
        pending: digest(todo),
      };
      if (!confirm) {
        const quote = createQuote('post-batch', { tasks: rows.length, escrow: formatUnits(toFundRaw, s.decimals), currency: s.symbol }, spend);
        const publicCount = todo.filter((r) => r.isPublic).length;
        const listing = todo.length - toFund.length;
        return ok({
          quote: {
            tasks: rows.length,
            alreadyPosted: posted.length,
            ...(listing > 0 ? { fundedNotListed: listing } : {}),
            toPost: todo.length,
            escrow: formatUnits(toFundRaw, s.decimals),
            currency: s.symbol,
            settlement: s.mode,
            payFrom,
            walletBalance: await payFromBalance(s, payFrom),
            privacy: { public: publicCount, private: todo.length - publicCount },
            transactions: `${isErc20Settlement(s) && toFund.length > 0 ? 'up to 1 approve, then ' : ''}${toFund.length} createTask`,
            quoteId: quote.quoteId,
          },
          next: `Re-call post_tasks with confirm=true, quoteId="${quote.quoteId}", the SAME idempotencyKey and the SAME tasks to execute this spend.`,
        });
      }
      const check = consumeQuote(quoteId, 'post-batch', spend);
      if (!check.ok) return quoteRefused(check, 'post_tasks');

      // One approval for every task still to fund, recorded under the list's key.
      const now = new Date().toISOString();
      const nonces: { next?: number } = {};
      try {
        const batch: SpendRecord = {
          idempotencyKey,
          kind: 'post-batch',
          stage: 'created',
          amountWei: toFundRaw.toString(),
          settlement: s.mode,
          chainId: s.chainId,
          token: isErc20Settlement(s) ? s.token.address : ZERO_TOKEN,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        putSpend(batch);
        if (isErc20Settlement(s) && toFundRaw > 0n) nonces.next = await ensureAllowance(s, batch);
      } catch (err) {
        return fail((err as ApiError).code ?? 'APPROVE_FAILED', `${(err as Error).message}. No task was funded.`);
      }

      const outcome = new Map<number, Record<string, unknown>>(posted.map((r) => [r.index, postedResult(r)]));
      let stopped: { index: number; code?: string; message: string } | undefined;
      for (const r of todo) {
        if (stopped) { outcome.set(r.index, { index: r.index, status: 'not_started' }); continue; }
        try {
          const record = getSpend(r.key) ?? (await createPostRecord({
            idempotencyKey: r.key,
            instructions: r.instructions,
            isPublic: r.isPublic,
            capabilities: r.capabilities,
            amountWei: r.amountWei,
            durationSecs: r.durationSecs,
            s,
            ...(r.isPublic ? {} : { executors: executorsByCaps.get([...r.capabilities].sort().join(',')) }),
            ...(r.routingSummary ? { routingSummary: r.routingSummary } : {}),
          })).record;
          const done = await fundAndIndex(record, nonces);
          outcome.set(r.index, { index: r.index, status: 'posted', taskHash: done.taskHash, txHash: done.txHash });
        } catch (err) {
          nonces.next = undefined;
          const rec = getSpend(r.key);
          const funded = rec?.stage === 'funded';
          const code = (err as ApiError).code;
          const message = (err as Error).message;
          outcome.set(r.index, {
            index: r.index,
            status: funded ? 'funded_not_listed' : 'failed',
            ...(rec?.taskHash ? { taskHash: rec.taskHash } : {}),
            ...(funded && rec?.txHash ? { txHash: rec.txHash } : {}),
            error: { ...(code ? { code } : {}), message },
          });
          stopped = { index: r.index, ...(code ? { code } : {}), message };
        }
      }

      const results = rows.map((r) => outcome.get(r.index)!);
      const count = (status: string) => results.filter((x) => x.status === status).length;
      const body = {
        posted: count('posted'),
        fundedNotListed: count('funded_not_listed'),
        failed: count('failed'),
        notStarted: count('not_started'),
        results,
      };
      if (stopped) {
        return stoppedRun(
          stopped.code ?? 'POST_TASKS_STOPPED',
          `Stopped at tasks[${stopped.index}]: ${stopped.message}. Nothing more was funded. Fix the cause, then call post_tasks again with the SAME idempotencyKey (a new quote, then confirm): posted tasks are skipped, and a funded one is listed without paying again.`,
          body,
        );
      }
      return ok({ ...body, hint: 'Use poll_task_result on each taskHash to wait for the deliverables.' });
    },
  );

  // ── poll_task_result ──────────────────────────────────────────────────────

  server.registerTool(
    'poll_task_result',
    {
      title: 'Poll for a Task Result',
      description: 'Check on a task you posted/rented (by task hash). Waits up to waitSeconds per call — loop this tool until done=true.',
      inputSchema: {
        taskHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe('The 0x task hash returned by rent_service/post_task'),
        waitSeconds: z.number().int().min(0).max(60).optional().describe('How long to wait before answering (default 30)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ taskHash, waitSeconds }) => ok(await pollPosted(taskHash, waitSeconds ?? 30)),
  );

  // ── cancel_task / claim_timeout ───────────────────────────────────────────
  //
  // The two ways escrow comes back to the poster. BlindEscrow splits them by
  // task status and they are NOT interchangeable — calling the wrong one
  // reverts on-chain:
  //
  //   Funded (0)                        → cancelTask, no deadline required
  //   Assigned/Submitted/Verified (1-3) → claimTimeout, deadline must have passed
  //   Disputed (6)                      → claimTimeout, but only once
  //                                       DISPUTE_WINDOW has elapsed
  //
  // On an upgraded escrow, claimTimeout on a Submitted task (work delivered
  // before the deadline, never judged) refunds nothing: it sends the task for
  // review and leaves it Disputed (security audit run 1, C18). A failed
  // (Verified) task refunds only after the worker's 3-day appeal window.
  //
  // So the quote step reads the live status first and refuses a path the
  // contract would reject, rather than letting the caller burn gas to find out.
  //
  // Both send a transaction, so both carry the same quote/confirm +
  // idempotencyKey treatment as post_task. Here the ledger's job is to stop a
  // retry from broadcasting a SECOND refund tx while the first is still
  // unconfirmed — the first would land and the second would revert.
  //
  // Chain note: the backend resolves which chain holds the task
  // (resolveTaskChainById) and builds the unsigned tx for it; this side only
  // decides who signs — the local wallet on 0G, the Privy relay on a relay
  // chain (Base) — and
  // verifies the tx targets the escrow that mode expects before sending
  // (verifyTarget). Task state is read from the chain the mode names, not
  // from GET /tasks/:id, which is bound to the 0G escrow.

  const STATUS_NAMES = ['Funded', 'Assigned', 'Submitted', 'Verified', 'Completed', 'Cancelled', 'Disputed'] as const;

  function statusName(status: number): string {
    return STATUS_NAMES[status] ?? `Unknown(${status})`;
  }

  interface TaskDetail {
    taskId: string;
    taskHash: string;
    status: number;
    amount: string;
    deadline: string;
    token: string;
    decimals: number;
    /** On-chain resubmission counter. The contract allows a fresh
     *  submitEvidence from Verified(3) only while this is below 3. */
    submissionAttempts?: number;
  }

  /** Resolve a task id-or-hash to its live on-chain state.
   *
   *  GET /api/v1/tasks/:id accepts either form — but older backends read the
   *  0G escrow only (escrowService.getTask was bound to the 0G contract), so
   *  on a relay chain its struct is for whatever 0G task happens to share the
   *  id. On a relay chain we use it just to turn a hash into an id, then read
   *  the struct from that chain's escrow ourselves over the read-only
   *  provider. */
  async function loadTask(s: Settlement, task: string): Promise<TaskDetail> {
    /** The backend said the task is on another chain: its id means a different task here. */
    const onOtherChain = (taskId: string, chain: string): ApiError => {
      const label = s.chain === 'base' ? 'Base' : s.chain;
      const e: ApiError = new Error(`task ${taskId} is a ${chain} task, and this process settles on ${label} — handle it with BLINDMARKET_SETTLEMENT=${chain}`);
      // The code names the chain; on Base it is the TASK_NOT_ON_BASE it always was.
      e.code = `TASK_NOT_ON_${s.chain.toUpperCase().replace(/-/g, '_')}`;
      return e;
    };

    if (!isErc20Settlement(s)) {
      const detail = await api<TaskDetail & { chain?: string }>('GET', `/api/v1/tasks/${encodeURIComponent(task)}`);
      if (detail.chain && detail.chain !== s.chain) throw onOtherChain(detail.taskId, detail.chain);
      return detail;
    }

    // Relay chain: the escrow is the authority, and we can read it directly. Only ask
    // the backend when we need a hash resolved to an id — that endpoint makes
    // several Redis round trips and is the slowest thing in this path, so a
    // numeric id must not pay for it.
    let taskId: string;
    let backendChain: string | undefined;
    if (/^\d+$/.test(task)) {
      taskId = task;
    } else {
      const viaBackend = await api<TaskDetail & { chain?: string }>('GET', `/api/v1/tasks/${encodeURIComponent(task)}`);
      taskId = viaBackend.taskId;
      backendChain = viaBackend.chain;
      // The same id can exist on this chain's escrow too (another task of the
      // same poster): reading it would act on the wrong task.
      if (backendChain && backendChain !== s.chain) throw onOtherChain(taskId, backendChain);
    }

    const escrow = new Contract(s.escrowAddress, ESCROW_READ_ABI, s.provider);
    const t = await escrow.getTask(BigInt(taskId));
    if (String(t.agent).toLowerCase() === ZERO_TOKEN) {
      const label = s.chain === 'base' ? 'Base' : s.chain;
      const hint = s.escrowChains
          ? `it is on another chain; set BLINDMARKET_SETTLEMENT to the one that holds it (this backend has escrows on ${s.escrowChains.join(', ')})`
          : 'it is probably a 0G task; handle it with BLINDMARKET_SETTLEMENT=0g';
      const e: ApiError = new Error(`task ${taskId} does not exist on the ${label} escrow ${s.escrowAddress} — ${hint}`);
      // The code names the chain; on Base it is the TASK_NOT_ON_BASE it always was.
      e.code = `TASK_NOT_ON_${s.chain.toUpperCase().replace(/-/g, '_')}`;
      throw e;
    }
    return {
      taskId,
      taskHash: String(t.taskHash),
      status: Number(t.status),
      amount: String(t.amount),
      deadline: String(t.deadline),
      token: String(t.token),
      submissionAttempts: Number(t.submissionAttempts),
      decimals: s.decimals,
    };
  }

  /** Amount formatted against the task's OWN decimals — a relay-chain task
   *  settles in its ERC-20 (USDC: 6), not the wallet's native 18. */
  function refundAmount(detail: TaskDetail): string {
    return formatUnits(BigInt(detail.amount), detail.decimals ?? 18);
  }

  /** What a cancel_task / claim_timeout confirm may send, for its quote binding. */
  function refundFields(s: Settlement, payFrom: string, idempotencyKey: string, detail: TaskDetail): SpendFields {
    return {
      ...settlementFields(s, payFrom),
      idempotencyKey,
      taskId: String(detail.taskId),
      taskHash: String(detail.taskHash).toLowerCase(),
      amountRaw: String(detail.amount),
    };
  }

  /** The refund has landed when the task reads one of `settled` on-chain:
   *  Cancelled, or for a claim on a Submitted task also Disputed (sent for
   *  review; an escrow from before that change refunds it instead). Checking
   *  state rather than a receipt is what makes a relayed user-op decidable
   *  (there is no receipt to poll), and it is a cheap truth check for the
   *  local-signing path too. Resolves to the status it read. */
  async function waitLanded(s: Settlement, taskId: number, settled: readonly number[]): Promise<number> {
    for (let i = 0; i < 30; i++) {
      const detail = await loadTask(s, String(taskId)).catch(() => null);
      if (detail && settled.includes(Number(detail.status))) return Number(detail.status);
      await new Promise((r) => setTimeout(r, 3000));
    }
    const e: ApiError = new Error(`task ${taskId} still not ${settled.map(statusName).join(' or ')} on-chain after 90s — retry with the same idempotencyKey to keep waiting`);
    e.code = 'REFUND_PENDING';
    throw e;
  }

  /** Broadcast the refund and wait for it — the shared tail of both tools.
   *  Resumable: a record past 'created' waits on the tx it already saved.
   *  Same two paths as fundAndIndex: local wallet on 0G, Privy relay on a relay chain.
   *  The backend resolves which chain holds the task and builds the tx for
   *  it; this only decides who signs. */
  async function sendRefund(record: SpendRecord): Promise<{ taskId: number; txHash: string; gas?: GasMode; listingClosed: boolean; outcome: 'refund' | 'escalate' }> {
    const s = await settlement();
    const taskId = record.taskId!;
    let { txHash } = record;

    if (record.settlement && record.settlement !== s.mode) {
      const e: ApiError = new Error(`refund ${record.idempotencyKey} started on ${record.settlement} but this process now settles on ${s.mode} — set BLINDMARKET_SETTLEMENT=${record.settlement} to finish it, or finish it from the web app`);
      e.code = 'SETTLEMENT_CHANGED';
      throw e;
    }
    // Nor on another network under the same key, where the task id names
    // another task. Only a refund that would still sign needs a chain id on
    // record; a sent one waits for its own transaction.
    const moved = networkChange(record, s);
    if (moved && (record.stage === 'created' || record.chainId !== undefined)) {
      const e: ApiError = new Error(
        `refund ${record.idempotencyKey} ${moved}. ` +
        (record.stage === 'created'
          ? 'Nothing was sent: quote the refund again with a new idempotencyKey.'
          : `Its transaction ${record.txHash} was sent on chain ${record.chainId}.`),
      );
      e.code = 'SETTLEMENT_CHANGED';
      throw e;
    }

    if (record.stage === 'created') {
      const route = record.kind === 'cancel' ? 'cancel' : 'timeout';
      // Task ids repeat across chains: name this one (the backend knows
      // 'base' and 'arc'; a 0G task is resolved by ownership as before).
      const { unsignedTx } = await api<{ unsignedTx: { to: string; data: string } }>(
        'POST', `/api/v1/tasks/${taskId}/${route}`, isErc20Settlement(s) ? { chain: s.mode } : undefined,
      );
      // The backend resolves the chain that holds the task and builds for it;
      // the tx carries no chainId. If that chain is not the one this mode
      // broadcasts on, stop here — relaying a 0G refund onto another chain
      // lands on an address with no escrow and burns the gas.
      await verifyTarget(s, unsignedTx.to, `${route}Task`);
      // And exactly this refund, for this task, with no value.
      assertEscrowCall(unsignedTx, record.kind === 'cancel' ? 'cancelTask' : 'claimTimeout', (a) => a[0] === BigInt(taskId), `${route}Task`);

      if (isErc20Settlement(s)) {
        const { hash, isUserOp } = await sendErc20(s, { to: unsignedTx.to, data: unsignedTx.data }, undefined, (sent) => {
          // Recorded before it leaves (a local send) or as the relay answers.
          updateSpend(record.idempotencyKey, { stage: 'sent', txHash: sent.hash, isUserOp: sent.isUserOp, gas: sent.gas });
          record.gas = sent.gas;
          txHash = sent.hash;
          record.isUserOp = sent.isUserOp;
        });
        await waitRelayed(s, hash, isUserOp);
      } else {
        const { sent } = await signRecordBroadcast(walletCtx!.wallet, {
          to: unsignedTx.to,
          data: unsignedTx.data,
          gasLimit: GAS_LIMIT,
          ...(s.chainId !== undefined ? { chainId: s.chainId } : {}),
        }, (hash) => {
          // Recorded before it leaves, same reasoning as fundAndIndex: a crash
          // mid-confirmation must resume onto THIS tx, not broadcast another.
          updateSpend(record.idempotencyKey, { stage: 'sent', txHash: hash });
          txHash = hash;
        });
        await sent.wait();
      }
    } else if (txHash) {
      if (isErc20Settlement(s)) await waitRelayed(s, txHash, record.isUserOp ?? false);
      else await walletCtx!.provider.waitForTransaction(txHash);
    } else {
      throw new Error(`Spend record ${record.idempotencyKey} is at stage '${record.stage}' with no txHash — cannot resume safely`);
    }

    const landed = await waitLanded(s, taskId, record.kind === 'timeout' && record.fromStatus === 2 ? [5, 6] : [5]);
    const outcome = landed === 6 ? 'escalate' : 'refund';
    updateSpend(record.idempotencyKey, { stage: 'confirmed', outcome });
    // Sent for review: the task stays live and there is no refund to confirm.
    const listingClosed = outcome === 'escalate' ? false : await confirmRefund(s, taskId, txHash!, record.isUserOp ?? false);
    return { taskId, txHash: txHash!, gas: record.gas, listingClosed, outcome };
  }

  /** Tell the backend the refund landed (POST /tasks/:id/confirm-tx): it
   *  checks the receipt and takes the task off the market, which otherwise
   *  keeps listing it as open until its deadline. Best effort, since the
   *  money has already moved. A relayed user-op hash has no receipt to check. */
  async function confirmRefund(s: Settlement, taskId: number, txHash: string, isUserOp: boolean): Promise<boolean> {
    if (isUserOp) return false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await api('POST', `/api/v1/tasks/${taskId}/confirm-tx`, { txHash, ...(isErc20Settlement(s) ? { chain: s.mode } : {}) });
        return true;
      } catch (err) {
        // The backend's RPC can lag the receipt this side just saw.
        if ((err as ApiError).code !== 'NOT_CONFIRMED' || attempt === 3) return false;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    return false;
  }

  /** Shared resume arm: an idempotencyKey that has already moved. The kind
   *  guard matters — the ledger is one namespace shared with rent/post, and
   *  resuming a 'post' record through the refund path would wait on the FUNDING
   *  tx and then mark that record confirmed, corrupting it. */
  async function resumeRefund(existing: SpendRecord, kind: 'cancel' | 'timeout') {
    if (existing.kind !== kind) {
      return fail('IDEMPOTENCY_KEY_REUSED', `idempotencyKey "${existing.idempotencyKey}" already belongs to a '${existing.kind}' spend (task ${existing.taskId ?? existing.taskHash}). Use a fresh key for this refund.`);
    }
    if (existing.stage === 'confirmed') {
      return ok({
        resumed: true,
        taskId: existing.taskId,
        txHash: existing.txHash,
        ...(existing.outcome ? { outcome: existing.outcome } : {}),
        hint: existing.outcome === 'escalate'
          ? 'Already sent for review — this idempotencyKey completed earlier. Nothing was refunded.'
          : 'Already refunded — this idempotencyKey completed earlier.',
      });
    }
    try {
      return ok({ resumed: true, ...(await sendRefund(existing)) });
    } catch (err) {
      return fail((err as ApiError).code ?? 'RESUME_FAILED', (err as Error).message);
    }
  }

  server.registerTool(
    'cancel_task',
    {
      title: 'Cancel a Task and Reclaim Escrow',
      description: 'Reclaim the escrow on a task you posted that has NOT been assigned to a worker (status Funded). Works immediately — no deadline wait. For a task that was assigned but never delivered, use claim_timeout instead. TWO-STEP quote/confirm; requires a unique idempotencyKey.',
      inputSchema: {
        task: z.string().min(1).describe('Task id (e.g. "51") or the 0x task hash returned by post_task'),
        idempotencyKey: z.string().min(8).max(128).describe('Unique key for this refund — reuse it on retries'),
        confirm: z.boolean().optional().describe('Set true (with quoteId) to send the transaction'),
        quoteId: z.string().optional().describe('From the quote step'),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ task, idempotencyKey, confirm, quoteId }) => {
      const f = await requireFunding();
      if ('error' in f) return f.error;
      const { s, payFrom } = f;

      const existing = getSpend(idempotencyKey);
      if (existing) return resumeRefund(existing, 'cancel');

      let detail: TaskDetail;
      try {
        detail = await loadTask(s, task);
      } catch (err) {
        return fail((err as ApiError).code ?? 'TASK_LOOKUP_FAILED', (err as Error).message);
      }

      const status = Number(detail.status);
      if (status !== 0) {
        const alt = status >= 1 && status <= 3
          ? ' Use claim_timeout instead, once the deadline has passed.'
          : ' The escrow is already settled — nothing to reclaim.';
        return fail('WRONG_REFUND_PATH', `Task ${detail.taskId} is ${statusName(status)}, and cancelTask only accepts Funded tasks.${alt}`);
      }

      // The task (and its escrow) this refund is for, bound into the quote: a
      // confirm naming another task is refused rather than refunding it.
      const spend = refundFields(s, payFrom, idempotencyKey, detail);
      if (!confirm) {
        const quote = createQuote('cancel', { taskId: detail.taskId }, spend);
        return ok({
          quote: {
            action: 'cancelTask',
            taskId: detail.taskId,
            status: statusName(status),
            refund: refundAmount(detail),
            refundTo: payFrom,
            settlement: s.mode,
            quoteId: quote.quoteId,
          },
          next: `Re-call cancel_task with confirm=true, quoteId="${quote.quoteId}", and the SAME idempotencyKey to send it.`,
        });
      }
      const check = consumeQuote(quoteId, 'cancel', spend);
      if (!check.ok) return quoteRefused(check, 'cancel_task');

      try {
        const record: SpendRecord = {
          idempotencyKey,
          kind: 'cancel',
          stage: 'created',
          settlement: s.mode,
          chainId: s.chainId,
          taskId: Number(detail.taskId),
          taskHash: detail.taskHash,
          amountWei: detail.amount,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        putSpend(record);
        const done = await sendRefund(record);
        return ok({ ...done, refunded: refundAmount(detail), hint: 'Escrow returned to the posting wallet.' });
      } catch (err) {
        return fail((err as ApiError).code ?? 'CANCEL_FAILED', (err as Error).message);
      }
    },
  );

  server.registerTool(
    'claim_timeout',
    {
      title: 'Reclaim Escrow After the Deadline',
      description: 'Reclaim the escrow on a task that WAS assigned but never completed, once its deadline has passed (status Assigned, or Verified-failed once the worker\'s 3-day appeal window has passed). On a Submitted task (work delivered before the deadline, never judged) it sends the task for review instead and refunds nothing: an admin rules, and with no ruling within 14 days the worker is paid; the result says outcome "escalate". For a task no worker ever picked up, use cancel_task instead — it needs no deadline. TWO-STEP quote/confirm; requires a unique idempotencyKey.',
      inputSchema: {
        task: z.string().min(1).describe('Task id (e.g. "51") or the 0x task hash returned by post_task'),
        idempotencyKey: z.string().min(8).max(128).describe('Unique key for this refund — reuse it on retries'),
        confirm: z.boolean().optional().describe('Set true (with quoteId) to send the transaction'),
        quoteId: z.string().optional().describe('From the quote step'),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ task, idempotencyKey, confirm, quoteId }) => {
      const f = await requireFunding();
      if ('error' in f) return f.error;
      const { s, payFrom } = f;

      const existing = getSpend(idempotencyKey);
      if (existing) return resumeRefund(existing, 'timeout');

      let detail: TaskDetail;
      try {
        detail = await loadTask(s, task);
      } catch (err) {
        return fail((err as ApiError).code ?? 'TASK_LOOKUP_FAILED', (err as Error).message);
      }

      const status = Number(detail.status);
      if (status === 0) {
        return fail('WRONG_REFUND_PATH', `Task ${detail.taskId} is Funded — claimTimeout reverts on Funded tasks because no worker was ever assigned. Use cancel_task, which works right now with no deadline wait.`);
      }
      if (status === 4 || status === 5) {
        return fail('NOTHING_TO_REFUND', `Task ${detail.taskId} is ${statusName(status)} — the escrow is already settled.`);
      }

      const deadline = BigInt(detail.deadline);
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (now < deadline) {
        return fail('DEADLINE_NOT_REACHED', `Task ${detail.taskId} is still live until ${new Date(Number(deadline) * 1000).toISOString()} — claimTimeout reverts before then.`);
      }

      const spend = refundFields(s, payFrom, idempotencyKey, detail);
      if (!confirm) {
        const quote = createQuote('timeout', { taskId: detail.taskId }, spend);
        return ok({
          quote: {
            action: 'claimTimeout',
            taskId: detail.taskId,
            status: statusName(status),
            deadlinePassed: new Date(Number(deadline) * 1000).toISOString(),
            refund: refundAmount(detail),
            refundTo: payFrom,
            settlement: s.mode,
            // DISPUTE_WINDOW is enforced on-chain and disputedAt is not exposed
            // here, so a disputed task can still revert after this quote.
            ...(status === 6 ? { note: 'Task is Disputed — this only succeeds once the on-chain DISPUTE_WINDOW has elapsed since the dispute was raised, otherwise it reverts with DisputeWindowActive. Delivered work that was sent for review never returns to you by timeout.' } : {}),
            ...(status === 2 ? { note: 'The work was delivered before the deadline and never judged. The escrow sends it for review instead of refunding you: an admin rules, and with no ruling within 14 days the worker is paid. (An escrow from before that change refunds it.)' } : {}),
            ...(status === 3 ? { note: "The work failed verification. This reverts with AppealWindowActive until the worker's 3-day appeal window after the verdict has passed." } : {}),
            quoteId: quote.quoteId,
          },
          next: `Re-call claim_timeout with confirm=true, quoteId="${quote.quoteId}", and the SAME idempotencyKey to send it.`,
        });
      }
      const check = consumeQuote(quoteId, 'timeout', spend);
      if (!check.ok) return quoteRefused(check, 'claim_timeout');

      try {
        const record: SpendRecord = {
          idempotencyKey,
          kind: 'timeout',
          stage: 'created',
          settlement: s.mode,
          chainId: s.chainId,
          taskId: Number(detail.taskId),
          fromStatus: status,
          taskHash: detail.taskHash,
          amountWei: detail.amount,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        putSpend(record);
        const done = await sendRefund(record);
        if (done.outcome === 'escalate') {
          return ok({ ...done, hint: 'Sent for review: nothing was refunded. An admin rules on the delivered work; with no ruling within 14 days the worker is paid.' });
        }
        return ok({ ...done, refunded: refundAmount(detail), hint: 'Escrow returned to the posting wallet.' });
      } catch (err) {
        return fail((err as ApiError).code ?? 'TIMEOUT_CLAIM_FAILED', (err as Error).message);
      }
    },
  );


  // ── Executor side (Base) ─────────────────────────────────────────────────
  //
  // accept_task (tools.ts) already assigns you on-chain: the backend awaits
  // marketplaceAssign inside POST /accept. What was missing is everything
  // after: the worker must sign submitEvidence itself (onlyWorker), and the
  // platform worker (backend/agents/worker.js) only carries a 0G signer, so
  // a Base task could be accepted but never delivered. These two tools close
  // that gap for an MCP executor whose wallet is a Privy relay wallet — no
  // local key, gas negotiated by the backend like every other relayed send.

  /** Poll the escrow until the task reads `want`, or give up. */
  async function waitStatus(s: Settlement, taskId: string, want: number, label: string): Promise<number> {
    let last = -1;
    for (let i = 0; i < 30; i++) {
      last = Number((await loadTask(s, taskId)).status);
      if (last === want) return last;
      await new Promise((r) => setTimeout(r, 3000));
    }
    const e: ApiError = new Error(`task ${taskId} still reads ${statusName(last)} after 90s waiting for ${label} — re-call complete_task to resume from the chain's state`);
    e.code = 'STATE_PENDING';
    throw e;
  }

  server.registerTool(
    'fetch_brief',
    {
      title: 'Fetch a Task Brief',
      description: "Download a task's brief by rootHash (accept_task returns it). Public briefs come back as text. For a PRIVATE brief pass the wrappedKey accept_task returned: it is decrypted with BLINDMARKET_PRIVATE_KEY, which must be the key whose public half you registered (wallet_status shows it as executorPublicKey).",
      inputSchema: {
        rootHash: z.string().min(32).max(80).describe('rootHash from accept_task (browse_a2a_tasks also shows it for a public task)'),
        wrappedKey: z.string().optional().describe('ECIES-wrapped AES key from accept_task (hex, no 0x). Required for private briefs.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ rootHash, wrappedKey }) => {
      try {
        // Buffer.from(x, 'hex') stops silently at the first bad char, so a
        // pasted "0x…" or a truncated blob would otherwise surface as
        // WRONG_KEY after a storage round-trip. Validate first.
        // ECIES blob = 65-byte ephemeral pubkey + 12 IV + 16 tag + ciphertext.
        const keyHex = wrappedKey?.replace(/^0x/i, '');
        if (keyHex !== undefined && (!/^[0-9a-fA-F]+$/.test(keyHex) || keyHex.length % 2 !== 0 || keyHex.length < (65 + 12 + 16 + 1) * 2)) {
          return fail('INVALID_WRAPPED_KEY', 'wrappedKey must be the full hex ECIES blob from accept_task (even length, at least 94 bytes). Pass it exactly as returned.');
        }
        const { blob } = await api<{ blob: string }>('GET', `/api/v1/storage/${encodeURIComponent(rootHash)}`);
        const buf = Buffer.from(blob, 'base64');
        if (keyHex !== undefined) {
          if (!walletCtx) {
            return fail('NO_WALLET', 'A private brief is decrypted with BLINDMARKET_PRIVATE_KEY — set it to the key whose public half you registered as executor.');
          }
          let aesKey: Buffer;
          try {
            aesKey = eciesDecrypt(Buffer.from(keyHex, 'hex'), walletCtx.wallet.privateKey);
          } catch (e) {
            return fail('WRONG_KEY', `Could not unwrap the brief key with the local wallet ${walletCtx.wallet.address}: ${(e as Error).message}. The poster wrapped it to the pubkey on your executor registration — wallet_status shows the pubkey this process derives; they must match.`);
          }
          let brief: string;
          try {
            brief = aesDecrypt(buf, aesKey).toString('utf8');
          } catch (e) {
            // The key unwrapped fine, so the BLOB is the problem: a public
            // (plaintext) brief passed with a wrappedKey, or the wrong rootHash.
            return fail('BRIEF_DECRYPT_FAILED', `The wrapped key unwrapped, but the blob at ${rootHash} did not decrypt with it: ${(e as Error).message}. If the task is public, call fetch_brief without wrappedKey; otherwise check the rootHash came from the same accept_task response.`);
          }
          return ok({ rootHash, bytes: buf.length, brief, decrypted: true });
        }
        const text = buf.toString('utf8');
        if (text.includes('�')) {
          return fail('ENCRYPTED_BRIEF', 'This brief is encrypted (private task). Re-call fetch_brief with the wrappedKey from accept_task.');
        }
        return ok({ rootHash, bytes: buf.length, brief: text });
      } catch (err) {
        return fail((err as ApiError).code ?? 'BRIEF_FETCH_FAILED', (err as Error).message);
      }
    },
  );

  server.registerTool(
    'complete_task',
    {
      title: 'Deliver a Task Result and Settle',
      description: 'Executor side, after accept_task: submits your result, sends submitEvidence from YOUR wallet (Base: through the backend relay, gas in USDC; 0G: signed locally with BLINDMARKET_PRIVATE_KEY), then asks the backend to verify and release the escrow to you. This is the ONLY delivery tool — there is no separate submit step. If an earlier call died between submitting and broadcasting (task stuck "submitted" off-chain, Assigned on-chain), re-calling heals it via the /rebroadcast endpoint. If the last verification FAILED, calling this again resubmits — the contract allows up to 3 attempts before the deadline. Safe to re-call: it resumes from whatever stage the escrow shows.',
      inputSchema: {
        task: z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe('The 0x task hash — A2A tasks are addressed by hash, not by numeric id'),
        output: z.string().min(1).max(200_000).describe('Your result. Verification judges this text (auto mode scores it against the poster\'s criteria).'),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ task, output }) => {
      const f = await requireFunding();
      if ('error' in f) return f.error;
      const { s, payFrom } = f;
      // requireFunding returns an error on 0G without a wallet, so walletCtx is
      // non-null whenever s.payment is 'local-native' from here on.

      let detail: TaskDetail;
      try {
        detail = await loadTask(s, task);
      } catch (err) {
        return fail((err as ApiError).code ?? 'TASK_LOOKUP_FAILED', (err as Error).message);
      }
      // 0 Funded · 1 Assigned · 2 Submitted · 3 Verified · 4 Completed · 5 Cancelled · 6 Disputed
      let status = Number(detail.status);
      if (status === 0) {
        return fail('NOT_ASSIGNED', `Task ${detail.taskId} is still Funded — call accept_task("${task}") first; the backend assigns you on-chain as part of accept.`);
      }
      // Verified(3) = the last round FAILED and the escrow is still locked. The
      // contract lets the worker submitEvidence again from here, up to
      // MAX_SUBMISSION_ATTEMPTS (3) and before the deadline. The backend's
      // /submit enforces all three on-chain gates; check them here too so the
      // caller gets the reason instead of a relayed revert.
      const isRetry = status === 3;
      // The contract reverts DeadlineReached from Assigned as well as from a
      // retry. With an explicit gasLimit ethers skips estimateGas, so a
      // predictable revert would be mined and charged — refuse it here.
      if ((status === 1 || isRetry) && BigInt(Math.floor(Date.now() / 1000)) >= BigInt(detail.deadline)) {
        return fail('DEADLINE_REACHED', `Task ${detail.taskId} is past its deadline — no further submissions are accepted on-chain. The poster can reclaim the escrow with claim_timeout.`);
      }
      if (isRetry) {
        const attempts = detail.submissionAttempts ?? 0;
        if (attempts >= 3) {
          return fail('MAX_ATTEMPTS_REACHED', `Task ${detail.taskId} has used all 3 submission attempts (${attempts}/3). The escrow stays locked until the poster reclaims it after the deadline.`);
        }
      }
      if (status >= 4) {
        return ok({ taskId: detail.taskId, taskHash: detail.taskHash, onChainStatus: statusName(status), hint: 'Already settled — nothing to do.' });
      }

      let submitTxHash: string | undefined;
      let gas: GasMode | undefined;
      let healed = false;
      try {
        if (status === 1 || isRetry) {
          type Built = { onChainTaskId: number; evidenceHash: string; chain?: string; unsignedSubmitEvidence: { to: string; data: string; from?: string; chainId?: number } };
          let sub: Built;
          try {
            sub = await api<Built>('POST', `/api/v1/a2a/tasks/${task}/submit`, { resultData: { output } });
          } catch (err) {
            // Stranded 'submitted': /submit flips the off-chain state when the
            // tx is BUILT, so an earlier call that died before broadcasting
            // leaves the chain at Assigned(1) while /submit refuses a rebuild.
            // /rebroadcast rebuilds the same tx from the stored result — the
            // FIRST output is what gets delivered, not this call's.
            if ((err as ApiError).code !== 'INVALID_STATE' || status !== 1) throw err;
            sub = await api<Built>('POST', `/api/v1/a2a/tasks/${task}/rebroadcast`);
            healed = true;
          }
          const tx = sub.unsignedSubmitEvidence;
          await verifyTarget(s, tx.to, 'submitEvidence');
          // A zero-value submitEvidence for this task, committing THIS output
          // (keccak256 of the JSON /submit hashes, backend/src/routes/a2a.ts).
          // /rebroadcast re-sends the first stored output, so there only the
          // task is checked.
          const evidence = keccak256(toUtf8Bytes(JSON.stringify({ output })));
          assertEscrowCall(tx, 'submitEvidence', (a) =>
            a[0] === BigInt(detail.taskId) && (healed || String(a[1]).toLowerCase() === evidence), 'submitEvidence');
          // The chain it is signed for is this process's, never the backend's.
          const pinned = s.chainId ?? walletCtx?.chainId;
          if (tx.chainId !== undefined && pinned !== undefined && Number(tx.chainId) !== pinned) {
            return fail('CHAIN_MISMATCH', `The backend built submitEvidence for chain ${tx.chainId}, but this process settles ${s.mode} on chain ${pinned}. Nothing was sent.`);
          }
          if (s.payment === 'relay-erc20') {
            const sent = await relaySend(s, { to: tx.to, data: tx.data });
            submitTxHash = sent.hash;
            gas = sent.gas;
            await waitRelayed(s, sent.hash, sent.isUserOp);
          } else if (s.payment === 'local-erc20') {
            // Signed locally over this chain's RPC, like the 0G branch below
            // but with gas estimated: a revert fails here, unpaid.
            if (tx.from && tx.from.toLowerCase() !== s.payFrom.toLowerCase()) {
              return fail('WALLET_MISMATCH', `The backend assigned this task to ${tx.from} (the wallet behind BLINDMARKET_API_KEY), but BLINDMARKET_PRIVATE_KEY is ${s.payFrom}. submitEvidence is worker-only — set the private key of ${tx.from}.`);
            }
            const sent = await sendErc20(s, { to: tx.to, data: tx.data }, undefined, () => { /* no spend ledger for a delivery */ });
            submitTxHash = sent.hash;
            await waitRelayed(s, sent.hash, false);
          } else {
            // submitEvidence is onlyWorker: the backend built the tx for the
            // API key's wallet (tx.from). If BLINDMARKET_PRIVATE_KEY is a
            // different wallet the tx reverts on-chain — with gasLimit set,
            // that revert is mined and paid for. Refuse before sending.
            if (tx.from && tx.from.toLowerCase() !== walletCtx!.wallet.address.toLowerCase()) {
              return fail('WALLET_MISMATCH', `The backend assigned this task to ${tx.from} (the wallet behind BLINDMARKET_API_KEY), but BLINDMARKET_PRIVATE_KEY is ${walletCtx!.wallet.address}. submitEvidence is worker-only — set the private key of ${tx.from}.`);
            }
            // 0G: sign locally, exactly as fundAndIndex does for createTask.
            // The chain id is pinned from this process's settlement (checked
            // against the backend's above); ethers refuses to send it if this
            // wallet's provider is on a different network — the guard against
            // a Base tx reaching a 0G signer.
            const tx0g = await walletCtx!.wallet.sendTransaction({
              to: tx.to, data: tx.data, gasLimit: GAS_LIMIT,
              ...(pinned !== undefined ? { chainId: pinned } : {}),
            });
            submitTxHash = tx0g.hash;
            await tx0g.wait();
          }
          status = await waitStatus(s, detail.taskId, 2, 'Submitted');
        }

        // Backend runs the verification for this task's mode and, on a pass,
        // sends completeVerification from the marketplace signer — which is
        // what releases the USDC to payFrom. The call awaits that tx.
        const fin = await api<{ status: string; verificationResult?: { passed: boolean; score?: number; reasons?: string[] }; awaitingPosterApproval?: boolean }>(
          'POST', `/api/v1/a2a/tasks/${task}/finalize`,
        );
        const after = await loadTask(s, detail.taskId);
        const done = Number(after.status) === 4;
        return ok({
          taskId: detail.taskId,
          taskHash: detail.taskHash,
          submitTxHash,
          gas,
          ...(healed ? { rebroadcast: true, note: 'An earlier submission for this task never reached the chain; its stored result was re-broadcast. The output passed to THIS call was not used.' } : {}),
          verification: fin.verificationResult ?? null,
          backendStatus: fin.status,
          onChainStatus: statusName(Number(after.status)),
          paidTo: done ? payFrom : undefined,
          submissionAttempts: after.submissionAttempts,
          hint: done
            ? `Escrow released: ${formatUnits(BigInt(after.amount), after.decimals ?? s.decimals)} ${s.symbol} minus the marketplace fee is now in ${payFrom}.`
            : fin.awaitingPosterApproval
              ? 'Manual-verification task: the poster must approve via verify_task before the escrow releases.'
              : `Verification did not pass (${(fin.verificationResult?.reasons ?? []).join('; ') || 'no reasons given'}). ` +
                ((after.submissionAttempts ?? 0) < 3
                  ? `Revise and call complete_task again — ${3 - (after.submissionAttempts ?? 0)} attempt(s) left before the deadline.`
                  : 'No attempts left; the escrow stays locked until the poster reclaims it.'),
        });
      } catch (err) {
        return fail((err as ApiError).code ?? 'COMPLETE_FAILED', (err as Error).message);
      }
    },
  );

  // ── deploy_agent ──────────────────────────────────────────────────────────

  /** The env var each provider's API key is read from, so the key never passes through the conversation. */
  const PROVIDER_KEY_ENV: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    groq: 'GROQ_API_KEY',
    gemini: 'GEMINI_API_KEY',
    xai: 'XAI_API_KEY',
  };
  type TransferTerms = { required: true; method: 'transfer'; chain: string; chainId?: number; token: string; recipient: string; amountRaw: string; decimals: number };
  type FeeTerms = { required: false } | TransferTerms | { required: true; method: 'factory'; chain: string; factory: string | null };
  interface DeployedAgent { id: string; name: string; walletAddress: string; started?: boolean }

  const coded = (code: string, message: string): ApiError => Object.assign(new Error(message), { code });

  /** The local wallet on `chain`, over BLINDMARKET_<CHAIN>_RPC_URL (else a
   *  public RPC for that chain id), checked against the chain id the backend
   *  names, and against `expectChainId` (the fee terms') when given. */
  async function walletOn(chain: string, expectChainId?: number) {
    const res = await fetch(`${cfg.apiBase}/health/bridge`, { signal: AbortSignal.timeout(30_000) });
    const bridge: any = await res.json().catch(() => ({}));
    const entry = (bridge?.data ?? bridge)?.chains?.find((c: { chain?: string }) => c.chain === chain);
    const chainId = Number(entry?.chainId);
    if (!Number.isInteger(chainId) || chainId <= 0) throw coded('SETTLEMENT_UNKNOWN', `The backend lists no chain id for ${chain}.`);
    if (expectChainId !== undefined && expectChainId !== chainId) {
      throw coded('SETTLEMENT_UNKNOWN', `The deploy fee is on chain ${expectChainId} but the backend lists ${chain} as chain ${chainId}. Nothing was paid.`);
    }
    const envName = rpcEnvName(chain);
    const rpcUrl = rpcFor(chain, chainId, process.env);
    if (!rpcUrl) throw coded('RPC_UNKNOWN', `No RPC known for ${chain} (chainId ${chainId}) — set ${envName}.`);
    const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
    const served = Number(BigInt(await provider.send('eth_chainId', [])));
    if (served !== chainId) throw coded('WRONG_RPC', `${envName} serves chain ${served}, not ${chain} (${chainId}). Nothing was paid.`);
    return walletCtx!.wallet.connect(provider);
  }

  /**
   * The backend cannot find a deploy fee recorded before records kept its
   * chain id, so it may have been paid on another network. Its receipt on the
   * fee chain's RPC decides the answer, which never sends the caller back into
   * a retry that cannot succeed. Found there, the backend has not seen it yet:
   * the record takes that chain id, and the same key finishes the deploy.
   */
  async function unchainedFeeNotFound(idempotencyKey: string, hash: string, fee: TransferTerms | null) {
    let found: boolean | null = null;
    if (fee) {
      try {
        const w = await walletOn(fee.chain, fee.chainId);
        found = (await w.provider!.getTransactionReceipt(hash))?.status === 1;
      } catch { /* not checkable from here */ }
    }
    if (fee && found) {
      if (fee.chainId !== undefined) updateSpend(idempotencyKey, { chainId: fee.chainId });
      return fail('DEPLOY_FEE_NOT_FOUND', `The deploy fee ${hash} is on ${fee.chain}, but the backend has not seen it yet. Retry with the same idempotencyKey in a minute; nothing is paid again.`);
    }
    if (fee && found === false) {
      return fail(
        'SETTLEMENT_CHANGED',
        `The deploy fee ${hash} was recorded without its chain, and it is not on ${fee.chain}${fee.chainId !== undefined ? ` (chain ${fee.chainId})` : ''}, where the backend takes the fee now: it was paid on another network and does not count here. ` +
        `Nothing was paid again: deploy with a new idempotencyKey to pay on ${fee.chain}.`,
      );
    }
    return fail(
      'DEPLOY_FEE_NOT_FOUND',
      `The backend cannot find the deploy fee ${hash}, which was recorded without its chain, and it could not be checked here. It may have been paid on another network, where it does not count. ` +
      'Nothing was paid again: find where it landed before paying with a new idempotencyKey.',
    );
  }

  type Refusal = ReturnType<typeof fail>;
  interface AgentFields { name: string; instructions: string; provider: string; model: string; skillSlugs?: string[] }

  /** The model provider's key from this server's environment (none for
   *  0g-compute), or the refusal to send when it is not set. */
  function providerKey(provider: string): { apiKey: string } | { refused: Refusal } {
    if (provider === '0g-compute') return { apiKey: '' };
    const envName = PROVIDER_KEY_ENV[provider];
    const apiKey = process.env[envName] ?? '';
    if (!apiKey) return { refused: fail('PROVIDER_KEY_MISSING', `Set ${envName} in this server's environment: the agent calls ${provider} with it. It is read there so it never passes through the conversation.`) };
    return { apiKey };
  }

  /** What POST /agents/deploy takes for one agent. Its private key is
   *  encrypted to the local wallet's key. */
  function deployBody(a: AgentFields, apiKey: string) {
    return {
      name: a.name, instructions: a.instructions, provider: a.provider, model: a.model, apiKey,
      capabilities: [],
      skillSlugs: a.skillSlugs ?? [],
      ownerPublicKey: derivePublicKeyHex(walletCtx!.wallet.privateKey),
    };
  }

  const deploySummary = (a: DeployedAgent) => ({ agentId: a.id, name: a.name, walletAddress: a.walletAddress, started: a.started === true });

  /** POST /agents/deploy, asking again while the backend has not seen the fee confirm. */
  async function postDeploy(body: object, feeTxHash?: string): Promise<DeployedAgent> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await api<DeployedAgent>('POST', '/api/v1/agents/deploy', feeTxHash ? { ...body, feeTxHash } : body);
      } catch (err) {
        if ((err as ApiError).code !== 'DEPLOY_FEE_NOT_FOUND' || attempt >= 3) throw err;
        await new Promise((r) => setTimeout(r, Number(process.env.BLINDMARKET_DEPLOY_POLL_MS ?? 5000)));
      }
    }
  }

  /** The deploy's own checks, run before anything is quoted or paid. A
   *  backend without the route (404) is not checked here; the deploy
   *  still checks before it takes the fee. */
  async function validateDeploy(body: object): Promise<Refusal | null> {
    try {
      await api('POST', '/api/v1/agents/deploy/validate', body);
      return null;
    } catch (err) {
      const code = (err as ApiError).code;
      if (code === undefined && /failed: 404$/.test((err as Error).message)) return null;
      return fail(code ?? 'DEPLOY_INVALID', `${(err as Error).message}. Nothing was paid.`);
    }
  }

  function paidNote(idempotencyKey: string): string {
    const rec = getSpend(idempotencyKey);
    return rec?.stage === 'sent' && rec.txHash
      ? ` The fee is paid (${rec.txHash}): retry with the SAME idempotencyKey to deploy without paying again.`
      : '';
  }

  /**
   * Finish a deploy whose fee was paid before (its record is at 'sent'): with
   * that payment, never a new one. It counts only on the network it was paid
   * on, and a chain keeps its key when the backend moves it to another one,
   * so the chain ids decide.
   */
  async function deployWithPaidFee(idempotencyKey: string, record: SpendRecord & { txHash: string }, body: object): Promise<{ agent: DeployedAgent } | { refused: Refusal }> {
    const current = await api<FeeTerms>('GET', '/api/v1/agents/deploy-fee').catch(() => null);
    const currentFee = current?.required && current.method === 'transfer' ? current : null;
    if (record.chainId !== undefined && currentFee?.chainId !== undefined && currentFee.chainId !== record.chainId) {
      return {
        refused: fail(
          'SETTLEMENT_CHANGED',
          `The deploy fee for ${idempotencyKey} was paid on chain ${record.chainId} (${record.txHash}), but the backend takes it on chain ${currentFee.chainId} now, where that payment does not count. ` +
          `Nothing was paid again: deploy with a new idempotencyKey to pay on chain ${currentFee.chainId}.`,
        ),
      };
    }
    try {
      const agent = await postDeploy(body, record.txHash);
      updateSpend(idempotencyKey, { stage: 'confirmed', agentId: agent.id });
      return { agent };
    } catch (err) {
      const code = (err as ApiError).code;
      if (code === 'DEPLOY_FEE_NOT_FOUND' && record.chainId === undefined) {
        return { refused: await unchainedFeeNotFound(idempotencyKey, record.txHash, currentFee) };
      }
      return { refused: fail(code ?? 'DEPLOY_FAILED', `${(err as Error).message}.${paidNote(idempotencyKey)}`) };
    }
  }

  /**
   * Pay the fee, when there is one, and deploy, recording each stage under
   * `idempotencyKey`: the fee transaction the moment it is broadcast, so a
   * retry deploys with it and never pays twice. `checks` asks the backend,
   * right before paying, whether the API key's owner is the local wallet and
   * whether the deploy would be accepted; deploy_agents makes both checks
   * once for the whole list instead.
   */
  async function payAndDeploy(
    idempotencyKey: string,
    body: object,
    fee: TransferTerms | null,
    checks: boolean,
  ): Promise<{ agent: DeployedAgent; feeTxHash?: string } | { refused: Refusal }> {
    try {
      const now = new Date().toISOString();
      let feeTxHash: string | undefined;
      if (fee) {
        if (checks) {
          // The backend counts a fee only from the API key's owner: check before paying.
          const refused = await ownerRefusal();
          if (refused) return { refused };
          const invalid = await validateDeploy(body);
          if (invalid) return { refused: invalid };
        }
        const w = await walletOn(fee.chain, fee.chainId);
        putSpend({ idempotencyKey, kind: 'deploy', stage: 'created', settlement: fee.chain, chainId: fee.chainId, token: fee.token, amountWei: fee.amountRaw, createdAt: now, updatedAt: now });
        const data = new Interface(['function transfer(address to, uint256 amount) returns (bool)'])
          .encodeFunctionData('transfer', [fee.recipient, BigInt(fee.amountRaw)]);
        // Recorded before it leaves this process (signRecordBroadcast): a retry
        // resumes from here and never pays twice, even when the node took the
        // transaction and its answer was lost (TX_MAYBE_SENT).
        const { sent: tx } = await signRecordBroadcast(w, { to: fee.token, data }, (hash) => {
          updateSpend(idempotencyKey, { stage: 'sent', txHash: hash });
        });
        try {
          await tx.wait();
        } catch (err) {
          if ((err as ApiError).code === 'CALL_EXCEPTION') {
            updateSpend(idempotencyKey, { stage: 'created', txHash: undefined });
            return { refused: fail('FEE_REVERTED', `The fee transfer ${tx.hash} reverted, so nothing was paid. Check the wallet's USDC on ${fee.chain} and retry.`) };
          }
          // Not confirmed yet: the backend waits for the receipt itself.
        }
        feeTxHash = tx.hash;
      } else {
        putSpend({ idempotencyKey, kind: 'deploy', stage: 'created', createdAt: now, updatedAt: now });
      }
      const agent = await postDeploy(body, feeTxHash);
      updateSpend(idempotencyKey, { stage: 'confirmed', agentId: agent.id });
      return { agent, feeTxHash };
    } catch (err) {
      return { refused: fail((err as ApiError).code ?? 'DEPLOY_FAILED', `${(err as Error).message}.${paidNote(idempotencyKey)}`) };
    }
  }

  /** OWNER_MISMATCH when BLINDMARKET_API_KEY's wallet is not the local one, else null. */
  async function ownerRefusal(): Promise<Refusal | null> {
    const { address: owner } = await api<{ address: string }>('GET', '/api/v1/api-keys/whoami');
    if (String(owner).toLowerCase() === walletCtx!.wallet.address.toLowerCase()) return null;
    return fail('OWNER_MISMATCH', `BLINDMARKET_API_KEY belongs to ${owner} but BLINDMARKET_PRIVATE_KEY is ${walletCtx!.wallet.address}. Nothing was paid: the backend counts a deploy fee only from the API key's owner.`);
  }

  /** The fee terms and the agent template a quote binds (the confirm re-reads the terms, and pays only what was quoted). */
  function feeFields(fee: TransferTerms | null): SpendFields {
    return {
      feeRequired: fee !== null,
      feeChain: fee?.chain ?? null,
      feeChainId: fee?.chainId ?? null,
      feeToken: fee ? String(fee.token).toLowerCase() : null,
      feeRecipient: fee ? String(fee.recipient).toLowerCase() : null,
      feeAmountRaw: fee ? String(fee.amountRaw) : null,
      feeDecimals: fee?.decimals ?? null,
    };
  }

  const usdcText = (raw: bigint, decimals: number) => `${formatUnits(raw, decimals).replace(/\.0$/, '')} USDC`;

  server.registerTool(
    'deploy_agent',
    {
      title: 'Deploy a Hosted Agent',
      description: "Deploy a hosted agent that runs on BlindMarket and takes tasks, owned by the API key's wallet. Deploying costs a fee (1 USDC on Arc on production), paid as one USDC transfer on Arc from the local wallet (BLINDMARKET_PRIVATE_KEY), which must be the API key's owner. The model provider's key is read from this server's environment (OPENAI_API_KEY, ANTHROPIC_API_KEY, GROQ_API_KEY, GEMINI_API_KEY or XAI_API_KEY; none for 0g-compute), never passed as an argument. TWO-STEP quote/confirm like post_task; requires a unique idempotencyKey, and a retry with the same key never pays twice.",
      inputSchema: {
        name: z.string().min(1).max(80).describe('Agent name'),
        instructions: z.string().min(1).max(100_000).describe("The agent's instructions: what it does and how"),
        provider: z.enum(['openai', 'anthropic', 'groq', 'gemini', 'xai', '0g-compute']).describe("LLM provider. 'xai' is xAI's Grok (not Groq). '0g-compute' needs no API key: inference is billed to the agent's own wallet"),
        model: z.string().min(1).max(128).describe("Model id as the provider names it, e.g. gpt-6.1-sol, claude-opus-5-5 or grok-4.7. One the platform's catalog lacks is checked against the provider's model list for the key (MODEL_NOT_AVAILABLE if it isn't there)"),
        skillSlugs: z.array(z.string()).max(10).optional().describe('Public skills to install at deploy, by slug'),
        idempotencyKey: z.string().min(8).max(128).describe('Unique key for this deploy — reuse it on retries'),
        confirm: z.boolean().optional().describe('Set true (with quoteId) to pay the fee and deploy'),
        quoteId: z.string().optional().describe('From the quote step'),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ name, instructions, provider, model, skillSlugs, idempotencyKey, confirm, quoteId }) => {
      if (!walletCtx) {
        return fail('NO_WALLET', 'deploy_agent pays the fee from, and encrypts the agent key to, the local wallet — set BLINDMARKET_PRIVATE_KEY to the key of the wallet that owns BLINDMARKET_API_KEY.');
      }
      const key = providerKey(provider);
      if ('refused' in key) return key.refused;
      const body = deployBody({ name, instructions, provider, model, skillSlugs }, key.apiKey);

      const existing = getSpend(idempotencyKey);
      if (existing && existing.kind !== 'deploy') {
        return fail('IDEMPOTENCY_KEY_IN_USE', `idempotencyKey ${idempotencyKey} belongs to a ${existing.kind} spend — use a new key for this deploy.`);
      }
      if (existing?.stage === 'confirmed') {
        return ok({ resumed: true, agentId: existing.agentId, feeTxHash: existing.txHash, hint: 'Already deployed with this idempotencyKey.' });
      }
      if (existing?.stage === 'sent' && existing.txHash) {
        // Paid before: finish the deploy with that payment.
        const done = await deployWithPaidFee(idempotencyKey, existing as SpendRecord & { txHash: string }, body);
        if ('refused' in done) return done.refused;
        return ok({ resumed: true, ...deploySummary(done.agent), feeTxHash: existing.txHash });
      }

      let terms: FeeTerms;
      try {
        terms = await api<FeeTerms>('GET', '/api/v1/agents/deploy-fee');
      } catch (err) {
        return fail((err as ApiError).code ?? 'DEPLOY_FEE_UNKNOWN', (err as Error).message);
      }
      if (terms.required && terms.method !== 'transfer') {
        return fail('UNSUPPORTED_FEE_METHOD', 'This backend takes the deploy fee through AgentFactory only, which this server does not pay. Deploy from the web app.');
      }
      const fee = terms.required ? terms as TransferTerms : null;
      const feeText = fee ? usdcText(BigInt(fee.amountRaw), fee.decimals) : 'none';
      // The fee terms and the agent this call would pay for, bound into the
      // quote: the confirm re-reads the terms, and pays only what was quoted.
      const spend: SpendFields = {
        idempotencyKey,
        payFrom: walletCtx.wallet.address.toLowerCase(),
        name,
        provider,
        model,
        instructions: sha256Hex(Buffer.from(instructions, 'utf8')),
        skills: JSON.stringify(skillSlugs ?? []),
        ...feeFields(fee),
      };

      if (!confirm) {
        const invalid = await validateDeploy(body);
        if (invalid) return invalid;
        let walletBalance: string | undefined;
        if (fee) {
          try {
            const w = await walletOn(fee.chain, fee.chainId);
            const bal = await new Contract(fee.token, ['function balanceOf(address) view returns (uint256)'], w).balanceOf(w.address);
            walletBalance = formatUnits(bal, fee.decimals);
          } catch (err) {
            if (['RPC_UNKNOWN', 'WRONG_RPC', 'SETTLEMENT_UNKNOWN'].includes((err as ApiError).code ?? '')) {
              return fail((err as ApiError).code!, (err as Error).message);
            }
          }
        }
        const quote = createQuote('deploy', { name, provider, model, fee: feeText }, spend);
        return ok({
          quote: {
            agent: { name, provider, model, skills: skillSlugs ?? [] },
            fee: feeText,
            chain: fee?.chain,
            payTo: fee?.recipient,
            payFrom: walletCtx.wallet.address,
            walletBalance,
            quoteId: quote.quoteId,
          },
          next: `Re-call deploy_agent with confirm=true, quoteId="${quote.quoteId}", and the SAME idempotencyKey to ${fee ? 'pay the fee and ' : ''}deploy.`,
        });
      }
      const check = consumeQuote(quoteId, 'deploy', spend);
      if (!check.ok) {
        const feeChanged = check.code === 'QUOTE_MISMATCH' && check.changed.some((k) => k.startsWith('fee'))
          ? `the deploy fee changed since the quote (quoted ${check.quote.summary.fee}, now ${feeText}${fee ? ` to ${fee.recipient} on ${fee.chain}` : ''})`
          : undefined;
        return quoteRefused(check, 'deploy_agent', feeChanged);
      }

      const done = await payAndDeploy(idempotencyKey, body, fee, true);
      if ('refused' in done) return done.refused;
      return ok({
        ...deploySummary(done.agent),
        fee: feeText,
        feeTxHash: done.feeTxHash,
        hint: done.agent.started ? 'The agent is running.' : 'The agent was created but did not start — start it with start_agent.',
      });
    },
  );

  // ── deploy_agents ─────────────────────────────────────────────────────────
  //
  // Several hosted agents from one template, one after another. One quote
  // covers the list; each agent is then deployed through deploy_agent's own
  // path, as its own 'deploy' spend under `<idempotencyKey>#<n>` (n counted
  // from 1, as in its name), so its fee is recorded the moment it is sent and
  // never paid twice. The list key holds a 'deploy-batch' record. Before the
  // quote, and again before the first payment, the backend says how many more
  // agents can start (GET /agents/capacity): a list that does not fit is
  // refused whole, so no run ends with paid agents that could not start. A
  // problem stops the run: the agents deployed stay, and a re-call with the
  // same key skips them and reuses a fee already paid.

  const MAX_DEPLOY_AGENTS = 10;
  const MAX_AGENT_NAME = 80;
  /** Tries per agent while the backend answers 429, the wait doubling from BLINDMARKET_DEPLOY_BACKOFF_MS (2 s): 2, 4, 8, 16, 32 s. */
  const DEPLOY_ATTEMPTS = 6;

  /** The names of `count` agents from `template`: `{n}` becomes each one's number (from 1); without it, a list numbers its names "<name> 1" … and a single agent keeps the name. */
  function agentNames(template: string, count: number): string[] {
    const base = template.trim();
    return Array.from({ length: count }, (_, i) =>
      base.includes('{n}') ? base.split('{n}').join(String(i + 1)) : count === 1 ? base : `${base} ${i + 1}`);
  }

  /** A refusal's code and message, as the tool's error body carries them. */
  const refusalError = (r: Refusal): { code?: string; message: string } => JSON.parse(r.content[0].text).error;

  /** The rate limiter refused the request (429): it never reached the route, so nothing was created and nothing claimed. */
  function rateLimited(r: Refusal): boolean {
    const { code, message } = refusalError(r);
    return code === 'RATE_LIMIT' || /failed: 429\b/.test(message);
  }

  /** GET /agents/capacity, with `free` = what the caller can start now (slots, the owner's share and, when the backend measures it, memory); null for a backend without the route. */
  async function readCapacity(): Promise<{ poolMax: number; poolFree: number; ownerMax: number; ownerFree: number; memorySlots: number | null; free: number } | null> {
    try {
      const c = await api<{ poolMax: number; poolFree: number; ownerMax: number; ownerFree: number; memory?: { slotsFree: number } | null }>('GET', '/api/v1/agents/capacity');
      const memorySlots = c.memory ? Number(c.memory.slotsFree) : null;
      return { ...c, memorySlots, free: Math.max(0, Math.min(Number(c.poolFree), Number(c.ownerFree), memorySlots ?? Number.POSITIVE_INFINITY)) };
    } catch (err) {
      if ((err as ApiError).status === 404) return null;
      throw err;
    }
  }

  server.registerTool(
    'deploy_agents',
    {
      title: 'Deploy Several Hosted Agents',
      description: `Deploy up to ${MAX_DEPLOY_AGENTS} hosted agents from one template, one after another, owned by the API key's wallet. Names: "{n}" in the name becomes each agent's number (from 1); without it they are named "<name> 1", "<name> 2", …. Each agent pays its own deploy fee exactly as deploy_agent does (one USDC transfer on Arc from BLINDMARKET_PRIVATE_KEY, the API key's owner), and the provider key comes from this server's environment, so all of them share that one key and its rate limits. TWO-STEP quote/confirm: the quote checks the request once with the backend, says how many agents can start now (refused whole with AGENT_CAPACITY when they do not all fit, nothing paid), and gives the total fee; confirm with the SAME fields, count and idempotencyKey. A problem stops the run; the agents deployed stay. Re-call with the same idempotencyKey (a new quote, then confirm) to resume: deployed agents are skipped and a fee already paid is reused. Results number agents from 1, as in their names and in <idempotencyKey>#<n>.`,
      inputSchema: {
        name: z.string().min(1).max(80).describe('Agent name template: "{n}" becomes each agent\'s number, else " 1", " 2", … is appended'),
        instructions: z.string().min(1).max(100_000).describe("Every agent's instructions: what it does and how"),
        provider: z.enum(['openai', 'anthropic', 'groq', 'gemini', 'xai', '0g-compute']).describe("LLM provider. 'xai' is xAI's Grok (not Groq). '0g-compute' needs no API key: each agent's inference is billed to its own wallet"),
        model: z.string().min(1).max(128).describe("Model id as the provider names it, e.g. gpt-6.1-sol, claude-opus-5-5 or grok-4.7"),
        skillSlugs: z.array(z.string()).max(10).optional().describe('Public skills to install on every agent, by slug'),
        count: z.number().int().min(1).max(MAX_DEPLOY_AGENTS).describe(`How many agents (1-${MAX_DEPLOY_AGENTS})`),
        idempotencyKey: z.string().min(8).max(128).describe('Unique key for this list — reuse it to retry or resume'),
        confirm: z.boolean().optional().describe('Set true (with quoteId) to pay the fees and deploy'),
        quoteId: z.string().optional().describe('From the quote step'),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ name, instructions, provider, model, skillSlugs, count, idempotencyKey, confirm, quoteId }) => {
      if (!walletCtx) {
        return fail('NO_WALLET', 'deploy_agents pays the fees from, and encrypts each agent key to, the local wallet — set BLINDMARKET_PRIVATE_KEY to the key of the wallet that owns BLINDMARKET_API_KEY.');
      }
      const key = providerKey(provider);
      if ('refused' in key) return key.refused;
      const names = agentNames(name, count);
      const badName = names.find((n) => n.length < 1 || n.length > MAX_AGENT_NAME);
      if (badName !== undefined) {
        return fail('INVALID_NAME', `The agent name "${badName}" is ${badName.length ? `${badName.length} characters` : 'empty'}; a name is 1 to ${MAX_AGENT_NAME}. Shorten the name (the number takes room too). Nothing was quoted or paid.`);
      }

      // The template this key deploys: a re-call may change the count (to
      // resume, or fit the capacity), never the agents themselves.
      const instructionsHash = sha256Hex(Buffer.from(instructions, 'utf8'));
      const template = sha256Hex(Buffer.from(JSON.stringify([name.trim(), instructionsHash, provider, model, skillSlugs ?? []]), 'utf8'));
      const existing = getSpend(idempotencyKey);
      if (existing && existing.kind !== 'deploy-batch') {
        return fail('IDEMPOTENCY_KEY_IN_USE', `idempotencyKey ${idempotencyKey} belongs to a ${existing.kind} spend — use a new key for these agents.`);
      }
      if (existing?.batchDigest && existing.batchDigest !== template) {
        return fail('IDEMPOTENCY_KEY_IN_USE', `idempotencyKey ${idempotencyKey} deployed agents from another name, instructions, provider, model or skills. Use a new key for these agents.`);
      }

      const agents = names.map((agentName, i) => ({
        index: i + 1,
        name: agentName,
        key: `${idempotencyKey}#${i + 1}`,
        body: deployBody({ name: agentName, instructions, provider, model, skillSlugs }, key.apiKey),
      }));
      type Agent = (typeof agents)[number];
      const foreign = agents.find((a) => { const rec = getSpend(a.key); return rec && rec.kind !== 'deploy'; });
      if (foreign) {
        return fail('IDEMPOTENCY_KEY_IN_USE', `${foreign.key} belongs to a ${getSpend(foreign.key)!.kind} spend — use a new idempotencyKey for these agents.`);
      }
      const stageOf = (a: Agent) => getSpend(a.key)?.stage;
      const feePaid = (a: Agent) => stageOf(a) === 'sent' && !!getSpend(a.key)?.txHash;
      const done = agents.filter((a) => stageOf(a) === 'confirmed');
      const todo = agents.filter((a) => stageOf(a) !== 'confirmed');
      const toPay = todo.filter((a) => !feePaid(a));
      const deployedBefore = (a: Agent) => ({ index: a.index, name: a.name, status: 'deployed', agentId: getSpend(a.key)!.agentId, resumed: true });
      if (todo.length === 0) {
        return ok({ resumed: true, deployed: done.length, failed: 0, notStarted: 0, results: done.map(deployedBefore), hint: 'Every agent with this idempotencyKey is deployed.' });
      }

      let terms: FeeTerms;
      try {
        terms = await api<FeeTerms>('GET', '/api/v1/agents/deploy-fee');
      } catch (err) {
        return fail((err as ApiError).code ?? 'DEPLOY_FEE_UNKNOWN', (err as Error).message);
      }
      if (terms.required && terms.method !== 'transfer') {
        return fail('UNSUPPORTED_FEE_METHOD', 'This backend takes the deploy fee through AgentFactory only, which this server does not pay. Deploy from the web app.');
      }
      const fee = terms.required ? terms as TransferTerms : null;
      const feeText = fee ? usdcText(BigInt(fee.amountRaw), fee.decimals) : 'none';
      const totalText = fee ? usdcText(BigInt(fee.amountRaw) * BigInt(toPay.length), fee.decimals) : 'none';
      const digest = (v: unknown) => sha256Hex(Buffer.from(JSON.stringify(v), 'utf8'));
      // What this call would spend, bound into the quote (see deploy_agent).
      const spend: SpendFields = {
        idempotencyKey,
        payFrom: walletCtx.wallet.address.toLowerCase(),
        provider,
        model,
        instructions: instructionsHash,
        skills: JSON.stringify(skillSlugs ?? []),
        count,
        names: digest(names),
        pending: digest(todo.map((a) => a.index)),
        toPay: digest(toPay.map((a) => a.index)),
        ...feeFields(fee),
      };

      /** AGENT_CAPACITY when the agents still to deploy cannot all start now, else null. */
      const capacityRefusal = async (nothing: string): Promise<{ refused: Refusal } | { free: number | null }> => {
        let capacity;
        try {
          capacity = await readCapacity();
        } catch (err) {
          return { refused: fail((err as ApiError).code ?? 'CAPACITY_UNKNOWN', `${(err as Error).message}. ${nothing}`) };
        }
        if (!capacity) return { free: null };
        if (todo.length <= capacity.free) return { free: capacity.free };
        const { free, poolFree, ownerFree, ownerMax, memorySlots } = capacity;
        return {
          refused: fail(
            'AGENT_CAPACITY',
            `Only ${free} more agent${free === 1 ? '' : 's'} can start now (${poolFree} free on the server, ${ownerFree} left of the ${ownerMax} one owner may run${memorySlots === null ? '' : `, memory for ${memorySlots} more`}), and ${todo.length} ${todo.length === 1 ? 'is' : 'are'} still to deploy. ` +
            (free > 0
              ? `Re-call deploy_agents with count=${done.length + free} to deploy only those (a new quote). `
              : 'Stop one of your agents, or wait for a slot, then quote again. ') +
            nothing,
          ),
        };
      };

      if (!confirm) {
        // The agents differ only by name: one check, with the longest, covers them all.
        const longest = agents.reduce((a, b) => (b.name.length > a.name.length ? b : a));
        const invalid = await validateDeploy(longest.body);
        if (invalid) return invalid;
        const cap = await capacityRefusal('Nothing was quoted or paid.');
        if ('refused' in cap) return cap.refused;
        let walletBalance: string | undefined;
        if (fee && toPay.length > 0) {
          try {
            const w = await walletOn(fee.chain, fee.chainId);
            const bal = await new Contract(fee.token, ['function balanceOf(address) view returns (uint256)'], w).balanceOf(w.address);
            walletBalance = formatUnits(bal, fee.decimals);
          } catch (err) {
            if (['RPC_UNKNOWN', 'WRONG_RPC', 'SETTLEMENT_UNKNOWN'].includes((err as ApiError).code ?? '')) {
              return fail((err as ApiError).code!, (err as Error).message);
            }
          }
        }
        const warnings = provider === '0g-compute'
          ? [`${count > 1 ? 'Each agent pays' : 'The agent pays'} its own inference from its own wallet: send ${count > 1 ? 'each' : 'it'} about 3.1 0G on the 0G chain (3 0G opens its 0G Compute account) before it takes a task.`]
          : [count > 1
            ? `All ${count} agents call ${provider} with your one API key, so they share its rate limits and its bill.`
            : `The agent calls ${provider} with your API key, so it shares that key's rate limits and bill with anything else using it.`];
        const quote = createQuote('deploy-batch', { agents: count, provider, model, fee: feeText, total: totalText }, spend);
        const paidBefore = todo.length - toPay.length;
        return ok({
          quote: {
            agents: names,
            provider,
            model,
            skills: skillSlugs ?? [],
            alreadyDeployed: done.length,
            toDeploy: todo.length,
            ...(paidBefore > 0 ? { feeAlreadyPaid: paidBefore } : {}),
            feePerAgent: feeText,
            totalFee: totalText,
            chain: fee?.chain,
            payTo: fee?.recipient,
            payFrom: walletCtx.wallet.address,
            walletBalance,
            capacity: cap.free === null ? null : { free: cap.free, scope: 'process' },
            warnings,
            quoteId: quote.quoteId,
          },
          next: `Re-call deploy_agents with confirm=true, quoteId="${quote.quoteId}", the SAME idempotencyKey, fields and count to ${fee && toPay.length > 0 ? 'pay the fees and ' : ''}deploy.`,
        });
      }
      const check = consumeQuote(quoteId, 'deploy-batch', spend);
      if (!check.ok) {
        const feeChanged = check.code === 'QUOTE_MISMATCH' && check.changed.some((k) => k.startsWith('fee'))
          ? `the deploy fee changed since the quote (quoted ${check.quote.summary.fee} per agent, now ${feeText}${fee ? ` to ${fee.recipient} on ${fee.chain}` : ''})`
          : undefined;
        return quoteRefused(check, 'deploy_agents', feeChanged);
      }

      // Again right before the first payment: a slot may have gone since the quote.
      const cap = await capacityRefusal('Nothing was paid.');
      if ('refused' in cap) return cap.refused;
      if (fee && toPay.length > 0) {
        try {
          const refused = await ownerRefusal();
          if (refused) return refused;
        } catch (err) {
          return fail((err as ApiError).code ?? 'DEPLOY_FAILED', (err as Error).message);
        }
        const invalid = await validateDeploy(toPay.reduce((a, b) => (b.name.length > a.name.length ? b : a)).body);
        if (invalid) return invalid;
      }
      const now = new Date().toISOString();
      putSpend({
        idempotencyKey, kind: 'deploy-batch', stage: 'created', batchDigest: template,
        ...(fee ? { settlement: fee.chain, chainId: fee.chainId } : {}),
        createdAt: existing?.createdAt ?? now, updatedAt: now,
      });

      /** One agent: with the fee its record already holds, else paying one. A 429 is asked again, after a wait, with the same fee. */
      const deployOne = async (a: Agent): Promise<{ agent: DeployedAgent; feeTxHash?: string } | { refused: Refusal }> => {
        const base = Number(process.env.BLINDMARKET_DEPLOY_BACKOFF_MS ?? 2000);
        for (let attempt = 1; ; attempt++) {
          const rec = getSpend(a.key);
          const r = rec?.stage === 'sent' && rec.txHash
            ? await deployWithPaidFee(a.key, rec as SpendRecord & { txHash: string }, a.body)
              .then((x) => ('agent' in x ? { agent: x.agent, feeTxHash: rec.txHash } : x))
            : await payAndDeploy(a.key, a.body, fee, false);
          if (!('refused' in r) || !rateLimited(r.refused) || attempt >= DEPLOY_ATTEMPTS) return r;
          await new Promise((resolve) => setTimeout(resolve, base * 2 ** (attempt - 1)));
        }
      };

      const outcome = new Map<number, Record<string, unknown>>(done.map((a) => [a.index, deployedBefore(a)]));
      let stopped: { index: number; name: string; code?: string; message: string } | undefined;
      for (const a of todo) {
        if (stopped) { outcome.set(a.index, { index: a.index, name: a.name, status: 'not_started' }); continue; }
        const r = await deployOne(a);
        if ('refused' in r) {
          const error = refusalError(r.refused);
          const rec = getSpend(a.key);
          outcome.set(a.index, {
            index: a.index,
            name: a.name,
            status: 'failed',
            ...(rec?.stage === 'sent' && rec.txHash ? { feeTxHash: rec.txHash } : {}),
            error,
          });
          stopped = { index: a.index, name: a.name, ...error };
          continue;
        }
        outcome.set(a.index, { index: a.index, status: 'deployed', ...deploySummary(r.agent), ...(r.feeTxHash ? { feeTxHash: r.feeTxHash } : {}) });
        if (r.agent.started !== true) {
          stopped = {
            index: a.index,
            name: a.name,
            code: 'AGENT_NOT_STARTED',
            message: `It was deployed but did not start (most often no worker slot was free), so the next ones would not start either. Start it with start_agent once a slot is free.`,
          };
        }
      }

      const results = agents.map((a) => outcome.get(a.index)!);
      const tally = (status: string) => results.filter((x) => x.status === status).length;
      const body = { deployed: tally('deployed'), failed: tally('failed'), notStarted: tally('not_started'), fee: feeText, results };
      if (stopped) {
        return stoppedRun(
          stopped.code ?? 'DEPLOY_AGENTS_STOPPED',
          `Stopped at agent ${stopped.index} (${stopped.name}): ${stopped.message} Nothing more was deployed or paid. Fix the cause, then re-call deploy_agents with the SAME idempotencyKey (a new quote, then confirm): deployed agents are skipped and a paid fee is reused.`,
          body,
        );
      }
      updateSpend(idempotencyKey, { stage: 'confirmed' });
      return ok({ ...body, hint: 'Every agent is deployed and running.' });
    },
  );

  return { settlement };
}
