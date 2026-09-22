/**
 * The providers, escrows and signers of each settlement chain.
 *
 * Kept apart from settlementChains.ts, which is config only, because this
 * module loads chain.ts and so opens RPC providers. chain.ts must never import
 * this module.
 */
import type { Contract, JsonRpcProvider, Wallet } from 'ethers';
import * as chain from './chain.js';
import type { SettlementChainKey } from './settlementChains.js';

export interface SettlementChainRuntime {
  readonly provider: JsonRpcProvider;
  /** Read-only escrow; null when this deployment does not settle on the chain. */
  readonly escrow: Contract | null;
  /** The escrow bound to the marketplace signer (verifier role). */
  readonly escrowAsMarketplace: Contract | null;
  readonly marketplaceSigner: Wallet | null;
}

// Getters, so each chain.js export is read when it is used. Tests replace
// chain.js with mocks that define only the exports the code under test reads.
const RUNTIME: { readonly [K in SettlementChainKey]: SettlementChainRuntime } = {
  base: {
    get provider() { return chain.baseProvider; },
    get escrow() { return chain.baseEscrow; },
    get escrowAsMarketplace() { return chain.baseEscrowAsMarketplace; },
    get marketplaceSigner() { return chain.baseMarketplaceSigner; },
  },
  arc: {
    get provider() { return chain.arcProvider; },
    get escrow() { return chain.arcEscrow; },
    get escrowAsMarketplace() { return chain.arcEscrowAsMarketplace; },
    get marketplaceSigner() { return chain.arcMarketplaceSigner; },
  },
};

export function chainRuntime(key: SettlementChainKey): SettlementChainRuntime {
  if (!Object.prototype.hasOwnProperty.call(RUNTIME, key)) {
    throw new Error(`unknown settlement chain ${String(key)}`);
  }
  return RUNTIME[key];
}
