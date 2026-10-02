/**
 * Whether sponsored agent gas runs here, and with what (docs/AGENT-GAS-FUNDING.md).
 *
 * It runs only when every one of these holds; otherwise it stays off, with a
 * logged reason, and never stops boot:
 *   - GAS_SPONSOR_ENABLED=true;
 *   - Postgres (DATABASE_URL): every counter and signed transaction lives there;
 *   - a DEPLOYMENT_ID, so the Redis ownership check can stop a second stack
 *     (claims are keyed by chain id, so testnet and mainnet never collide;
 *     Arc testnet staging may run it, so this is not production-only);
 *   - an Arc escrow, and a BlindAgentDelegate recorded for this Arc chain id;
 *   - GAS_SPONSOR_PRIVATE_KEY, a wallet that is none of the keys this backend
 *     signs with, nor the escrow's verifier, treasury or admin (read on-chain
 *     once, by checkSponsorRoles);
 *   - backgroundWritesAllowed(), checked by callers at each use.
 */
import { ethers } from 'ethers';
import { config } from '../config.js';
import { chainRuntime } from './chainRuntime.js';
import { settlementChainConfig, type SettlementChainConfig } from './settlementChains.js';
import { backgroundWritesAllowed } from './deploymentIdentity.js';
import { delegateInterface } from './blindAgentDelegate.js';
import type { SponsorCaps } from './gasSponsorStore.js';

/** A reservation is held this long after the task's assignment, then expires. */
export const RESERVATION_TTL_SECONDS = 3_600;
/** Gas limit = raw estimate × 1.15. */
export const GAS_LIMIT_MARGIN_PERCENT = 115n;
/** A submit needs at least this long before the task's deadline. */
export const MIN_SECONDS_BEFORE_DEADLINE = 60;
/** Setup (7702 authorization) transactions per wallet: the first and one retry. */
export const MAX_SETUP_ATTEMPTS = 2;

export type GasSponsorSettings =
  | { enabled: false; reason: string; misconfigured: boolean }
  | {
      enabled: true;
      chain: SettlementChainConfig;
      chainId: number;
      escrow: string;
      delegate: string;
      sponsor: ethers.Wallet;
      maxGas: bigint;
      maxFeeWei: bigint;
      /** Smallest qualifying task reward, in the settlement token's units. */
      minTaskRaw: bigint;
      caps: SponsorCaps;
      maxFailuresPerHour: number;
      /** How long a stored transaction may go unlanded before sponsorship pauses itself. */
      stuckMs: number;
    };

const off = (reason: string, misconfigured = true): GasSponsorSettings => ({ enabled: false, reason, misconfigured });

function addressOfKey(raw: string): string | null {
  if (!raw) return null;
  try {
    const k = raw.trim();
    return new ethers.Wallet(k.startsWith('0x') ? k : `0x${k}`).address.toLowerCase();
  } catch {
    return null;
  }
}

function positiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function positiveUnits(raw: string, decimals: number): bigint | null {
  try {
    const v = ethers.parseUnits(raw, decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/** The settings from the current config. Raw values are never echoed: a key pasted into the wrong variable would end up in logs. */
export function gasSponsorSettings(): GasSponsorSettings {
  const s = config.gasSponsor;
  if (!s.enabled) return off('GAS_SPONSOR_ENABLED is not true', false);
  if (!config.databaseUrl) return off('sponsored gas needs DATABASE_URL (Postgres); it never runs on SQLite');
  if (!config.deploymentId) return off('sponsored gas needs a DEPLOYMENT_ID, so a second stack on this Redis is stopped');

  const chain = settlementChainConfig('arc');
  if (chain.escrowAddress === null) return off('there is no Arc escrow here');
  if (chain.aa || !chain.gas.nativeIsSettlementToken) return off('Arc is not configured as a native-USDC-gas chain');
  if (!config.arcAgentDelegateAddress || !ethers.isAddress(config.arcAgentDelegateAddress)) {
    return off(`no BlindAgentDelegate is recorded for Arc chain ${chain.chainId}`);
  }

  const maxGas = positiveInt(s.maxGas);
  if (maxGas === null) return off('GAS_SPONSOR_MAX_GAS is not a whole number above 0');
  const maxFeeWei = positiveUnits(s.maxFeeGwei, 9);
  if (maxFeeWei === null) return off('GAS_SPONSOR_MAX_FEE_GWEI is not an amount above 0');
  const minTaskRaw = positiveUnits(s.minTaskUsdc, chain.token.unit.decimals);
  if (minTaskRaw === null) return off('GAS_SPONSOR_MIN_TASK_USDC is not an amount above 0');
  // Arc's gas coin is native USDC with 18 decimals: budgets are in its wei.
  const hourlyBudgetWei = positiveUnits(s.hourlyBudgetUsdc, 18);
  const dailyBudgetWei = positiveUnits(s.dailyBudgetUsdc, 18);
  if (hourlyBudgetWei === null || dailyBudgetWei === null) {
    return off('GAS_SPONSOR_HOURLY_BUDGET_USDC and GAS_SPONSOR_DAILY_BUDGET_USDC must be amounts above 0');
  }
  const perAgentDaily = positiveInt(s.perAgentDaily);
  const perUserDaily = positiveInt(s.perUserDaily);
  const perPosterDaily = positiveInt(s.perPosterDaily);
  const maxStrikes = positiveInt(s.maxStrikes);
  const maxFailuresPerHour = positiveInt(s.maxFailuresPerHour);
  const stuckMinutes = positiveInt(s.stuckMinutes);
  if (!perAgentDaily || !perUserDaily || !perPosterDaily || !maxStrikes || !maxFailuresPerHour || !stuckMinutes) {
    return off('the GAS_SPONSOR_PER_*_DAILY, GAS_SPONSOR_MAX_STRIKES, GAS_SPONSOR_MAX_FAILURES_PER_HOUR and GAS_SPONSOR_STUCK_MINUTES settings must be whole numbers above 0');
  }

  if (!s.privateKey) return off('GAS_SPONSOR_ENABLED is set but GAS_SPONSOR_PRIVATE_KEY is empty');
  let sponsor: ethers.Wallet;
  try {
    const k = s.privateKey.trim();
    sponsor = new ethers.Wallet(k.startsWith('0x') ? k : `0x${k}`);
  } catch {
    return off('GAS_SPONSOR_PRIVATE_KEY is not a private key');
  }
  const address = sponsor.address.toLowerCase();
  const configured: Array<[string, string]> = [
    ['ARC_MARKETPLACE_SIGNER_PRIVATE_KEY', config.arcMarketplaceSignerPrivateKey],
    ['BASE_MARKETPLACE_SIGNER_PRIVATE_KEY', config.baseMarketplaceSignerPrivateKey],
    ['MARKETPLACE_SIGNER_PRIVATE_KEY', config.marketplaceSignerPrivateKey],
    ['OG_STORAGE_PRIVATE_KEY', config.ogStoragePrivateKey],
    ['OG_COMPUTE_PRIVATE_KEY', config.ogComputePrivateKey],
    ['KEY_CUSTODY_PRIVATE_KEY', config.keyCustody.privateKey],
  ];
  const clash = configured.find(([, key]) => addressOfKey(key) === address);
  if (clash) return off(`the sponsor wallet ${sponsor.address} is the ${clash[0]} wallet; give the sponsor a wallet of its own`);

  return {
    enabled: true,
    chain,
    chainId: chain.chainId,
    escrow: chain.escrowAddress,
    delegate: ethers.getAddress(config.arcAgentDelegateAddress),
    sponsor,
    maxGas: BigInt(maxGas),
    maxFeeWei,
    minTaskRaw,
    caps: { perAgentDaily, perUserDaily, perPosterDaily, hourlyBudgetWei, dailyBudgetWei, maxStrikes },
    maxFailuresPerHour,
    stuckMs: stuckMinutes * 60_000,
  };
}

let roles: { key: string; problem: string | null } | null = null;

/**
 * Read the escrow's verifier, treasury and admin and refuse a sponsor that is
 * one of them, and refuse a delegate bound to another escrow (one delegate
 * per escrow: its ESCROW() is fixed at deploy). Run at boot; the result holds
 * for the process (an unreadable value is a problem too, and is retried on
 * the next call).
 */
export async function checkSponsorRoles(settings: Extract<GasSponsorSettings, { enabled: true }>): Promise<string | null> {
  const sponsor = settings.sponsor.address.toLowerCase();
  const key = `${sponsor}:${settings.delegate}:${settings.escrow}`.toLowerCase();
  if (roles?.key === key) return roles.problem;
  const runtime = chainRuntime('arc');
  const escrow = runtime.escrow;
  if (!escrow) return 'there is no Arc escrow contract here';
  try {
    const raw = await runtime.provider.call({ to: settings.delegate, data: delegateInterface.encodeFunctionData('ESCROW') });
    const bound = String(delegateInterface.decodeFunctionResult('ESCROW', raw)[0]);
    if (bound.toLowerCase() !== String(settings.escrow).toLowerCase()) {
      roles = { key, problem: `the BlindAgentDelegate at ${settings.delegate} is bound to escrow ${bound}, not the Arc escrow ${settings.escrow}` };
      return roles.problem;
    }
  } catch (e) {
    return `could not read ESCROW() from the BlindAgentDelegate at ${settings.delegate}: ${(e as Error).message}`;
  }
  for (const role of ['verifier', 'treasury', 'admin'] as const) {
    try {
      if (String(await escrow[role]()).toLowerCase() === sponsor) {
        roles = { key, problem: `the sponsor wallet ${settings.sponsor.address} is the Arc escrow's ${role}; give the sponsor a wallet of its own` };
        return roles.problem;
      }
    } catch (e) {
      return `could not read the Arc escrow's ${role} to check the sponsor wallet: ${(e as Error).message}`;
    }
  }
  roles = { key, problem: null };
  return null;
}

/**
 * The settings when sponsorship may act in this process right now, or the
 * reason it may not. `writer` names the caller for the identity log.
 */
export async function runnableSettings(writer: string): Promise<
  { ok: true; settings: Extract<GasSponsorSettings, { enabled: true }> } | { ok: false; reason: string }
> {
  const settings = gasSponsorSettings();
  if (!settings.enabled) return { ok: false, reason: settings.reason };
  const problem = await checkSponsorRoles(settings);
  if (problem) return { ok: false, reason: problem };
  if (!backgroundWritesAllowed(writer)) return { ok: false, reason: "this backend is on another deployment's Redis" };
  return { ok: true, settings };
}

/** Test hook. */
export function _resetSponsorRoles(): void {
  roles = null;
}

/** One boot line on whether sponsored gas runs, and the sponsor-role check. */
export function logGasSponsorConfig(): void {
  const s = gasSponsorSettings();
  if (!s.enabled) {
    if (s.misconfigured) console.warn(`[gasSponsor] ⚠ ${s.reason} — sponsored gas is OFF`);
    return;
  }
  console.log(
    `[gasSponsor] ON for Arc ${s.chainId}: sponsor ${s.sponsor.address}, delegate ${s.delegate}, ` +
      `budget ${ethers.formatEther(s.caps.hourlyBudgetWei)}/h and ${ethers.formatEther(s.caps.dailyBudgetWei)}/day USDC, ` +
      `${s.caps.perAgentDaily}/agent, ${s.caps.perUserDaily}/user, ${s.caps.perPosterDaily}/poster per day`,
  );
  void checkSponsorRoles(s).then((problem) => {
    if (problem) console.error(`[gasSponsor] ⛔ ${problem} — sponsored gas is OFF`);
  });
}
